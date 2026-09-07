import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { EventEmitter } from 'events';
import path from 'path';

export const PRIVATE_TRANSPORT_PROTOCOL_VERSION = 2;
export const PRIVATE_TRANSPORT_SIDECAR_VERSION = '0.2.0';
const MAX_RESPONSE_LINE_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 7_000;

export class PrivateTransportSidecarError extends Error {
  constructor(
    public readonly code: string,
    message = code
  ) {
    super(message);
  }
}

export type MasqueTestConfig = Readonly<{
  relayAddress: string;
  relayServerName: string;
  relayCertSha256: string;
  targetAddress: string;
  timeoutMs?: number;
}>;

export type PrivateSessionConfig = Readonly<{
  relayAddress: string;
  relayServerName: string;
  relayCertSha256: string;
  backendAddress: string;
  backendServerName: string;
  backendCertSha256: string;
  logicalSessionId: string;
  attachToken: string;
  nonce: string;
  purpose: string;
  ownerBindingHash: string;
  timeoutMs?: number;
}>;

export type PrivateTransportSidecarEvent = {
  event: 'reliableMessage' | 'datagram' | 'error';
  sessionId: string;
  messageId?: string;
  code?: string;
  data: Buffer;
};

type SidecarOperation =
  | 'health'
  | 'openMasqueTunnel'
  | 'sendDatagram'
  | 'receiveDatagram'
  | 'closeTunnel'
  | 'openPrivateSession'
  | 'sendPrivateReliable'
  | 'sendPrivateDatagram'
  | 'sessionMetrics'
  | 'closePrivateSession'
  | 'shutdown';

type SidecarResponse = {
  version: number;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
  type?: unknown;
  event?: unknown;
  sessionId?: unknown;
  messageId?: unknown;
  code?: unknown;
  binaryLength?: unknown;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type PrivateTransportSidecarTestOptions = {
  /** Test-only trusted launch override. Never populated from renderer input. */
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
};

function platformDirectory(): string {
  const platform =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${platform}-${arch}`;
}

export function getPrivateTransportSidecarPath(): string {
  const executable =
    process.platform === 'win32'
      ? 'qortal-private-transport.exe'
      : 'qortal-private-transport';
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'private-transport',
      platformDirectory(),
      executable
    );
  }
  return path.join(
    app.getAppPath(),
    'resources',
    'private-transport',
    platformDirectory(),
    executable
  );
}

export class PrivateTransportSidecar extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private pendingBinaryEvent:
    | (Omit<PrivateTransportSidecarEvent, 'data'> & {
        binaryLength: number;
      })
    | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private stopping = false;

  constructor(
    private readonly testOptions: PrivateTransportSidecarTestOptions = {}
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.child) return;
    this.startPromise = this.spawnAndHandshake().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async health(): Promise<{
    service: string;
    sidecarVersion: string;
    protocolVersion: number;
    innerAlpn?: string;
  }> {
    const result = await this.request('health', {});
    return result as {
      service: string;
      sidecarVersion: string;
      protocolVersion: number;
      innerAlpn?: string;
    };
  }

  async openMasqueTunnel(config: MasqueTestConfig): Promise<string> {
    await this.start();
    const result = (await this.request('openMasqueTunnel', config)) as {
      tunnelId?: unknown;
    };
    if (typeof result?.tunnelId !== 'string' || !result.tunnelId) {
      throw new PrivateTransportSidecarError('MALFORMED_RESPONSE');
    }
    return result.tunnelId;
  }

  async sendDatagram(tunnelId: string, data: Buffer): Promise<void> {
    await this.request('sendDatagram', {
      tunnelId,
      dataBase64: data.toString('base64'),
    });
  }

  async receiveDatagram(tunnelId: string, timeoutMs = 5_000): Promise<Buffer> {
    const result = (await this.request(
      'receiveDatagram',
      { tunnelId, timeoutMs },
      timeoutMs + 1_000
    )) as { dataBase64?: unknown };
    if (typeof result?.dataBase64 !== 'string') {
      throw new PrivateTransportSidecarError('MALFORMED_RESPONSE');
    }
    return Buffer.from(result.dataBase64, 'base64');
  }

  async closeTunnel(tunnelId: string): Promise<void> {
    if (!this.child) return;
    await this.request('closeTunnel', { tunnelId });
  }

  async openPrivateSession(config: PrivateSessionConfig): Promise<{
    sessionId: string;
    innerQuicConnectionId: string;
    logicalSessionId: string;
    transportGeneration: number;
  }> {
    await this.start();
    const result = (await this.request('openPrivateSession', config)) as Record<
      string,
      unknown
    >;
    if (
      typeof result?.sessionId !== 'string' ||
      typeof result?.innerQuicConnectionId !== 'string' ||
      typeof result?.logicalSessionId !== 'string' ||
      result?.transportGeneration !== 1
    )
      throw new PrivateTransportSidecarError('MALFORMED_RESPONSE');
    return result as {
      sessionId: string;
      innerQuicConnectionId: string;
      logicalSessionId: string;
      transportGeneration: number;
    };
  }

  async sendPrivateReliable(
    sessionId: string,
    messageId: string,
    data: Buffer
  ): Promise<void> {
    await this.request(
      'sendPrivateReliable',
      { sessionId, messageId },
      undefined,
      data
    );
  }

  async sendPrivateDatagram(
    sessionId: string,
    messageId: string,
    data: Buffer
  ): Promise<void> {
    await this.request(
      'sendPrivateDatagram',
      { sessionId, messageId },
      undefined,
      data
    );
  }

  async sessionMetrics(sessionId: string): Promise<Record<string, number>> {
    return (await this.request('sessionMetrics', { sessionId })) as Record<
      string,
      number
    >;
  }

  async closePrivateSession(sessionId: string): Promise<void> {
    if (this.child) await this.request('closePrivateSession', { sessionId });
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try {
      await this.request('shutdown', {}, 1_000);
    } catch {
      // Exit/kill below remains authoritative.
    }
    if (this.child === child && child.exitCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    if (this.child === child && child.exitCode === null) child.kill();
    this.child = null;
    this.rejectPending('SIDECAR_STOPPED');
    this.stopping = false;
  }

  /** Exposed for lifecycle tests; production callers use the typed methods. */
  isRunning(): boolean {
    return this.child !== null;
  }

  /** Test-only fault injection; not reachable from preload or renderer IPC. */
  terminateForTest(): void {
    this.child?.kill();
  }

  private async spawnAndHandshake(): Promise<void> {
    const command =
      this.testOptions.command ?? getPrivateTransportSidecarPath();
    const args = this.testOptions.args ?? [];
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    this.stopping = false;
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => this.handleStdout(child, chunk));
    child.on('error', () => this.handleDeath(child, 'SIDECAR_SPAWN_FAILED'));
    child.on('exit', () => this.handleDeath(child, 'SIDECAR_EXITED'));

    try {
      const health = await this.health();
      if (
        health.service !== 'qortal-private-transport' ||
        health.sidecarVersion !== PRIVATE_TRANSPORT_SIDECAR_VERSION ||
        health.protocolVersion !== PRIVATE_TRANSPORT_PROTOCOL_VERSION
      ) {
        throw new PrivateTransportSidecarError('SIDECAR_VERSION_MISMATCH');
      }
    } catch (error) {
      if (this.child === child) child.kill();
      this.child = null;
      throw error;
    }
  }

  private request(
    operation: SidecarOperation,
    params: unknown,
    timeoutMs = this.testOptions.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    binary: Uint8Array = Buffer.alloc(0)
  ): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(
        new PrivateTransportSidecarError('SIDECAR_NOT_RUNNING')
      );
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new PrivateTransportSidecarError('SIDECAR_REQUEST_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      const frame = JSON.stringify({
        version: PRIVATE_TRANSPORT_PROTOCOL_VERSION,
        requestId,
        operation,
        params,
        binaryLength: binary.length || undefined,
      });
      child.stdin.write(
        Buffer.concat([Buffer.from(`${frame}\n`), binary]),
        (error) => {
          if (!error) return;
          const pending = this.pending.get(requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(requestId);
          pending.reject(
            new PrivateTransportSidecarError('SIDECAR_WRITE_FAILED')
          );
        }
      );
    });
  }

  private handleStdout(
    child: ChildProcessWithoutNullStreams,
    chunk: Buffer
  ): void {
    if (this.child !== child) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    for (;;) {
      if (this.pendingBinaryEvent) {
        if (this.stdoutBuffer.length < this.pendingBinaryEvent.binaryLength)
          return;
        const pending = this.pendingBinaryEvent;
        const data = this.stdoutBuffer.subarray(0, pending.binaryLength);
        this.stdoutBuffer = this.stdoutBuffer.subarray(pending.binaryLength);
        this.pendingBinaryEvent = null;
        this.emit('event', { ...pending, binaryLength: undefined, data });
        continue;
      }
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline === -1) {
        if (this.stdoutBuffer.length > MAX_RESPONSE_LINE_BYTES) {
          this.failMalformed(child);
        }
        return;
      }
      const line = this.stdoutBuffer
        .subarray(0, newline)
        .toString('utf8')
        .trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_RESPONSE_LINE_BYTES) {
        this.failMalformed(child);
        return;
      }
      let response: SidecarResponse;
      try {
        response = JSON.parse(line) as SidecarResponse;
      } catch {
        this.failMalformed(child);
        return;
      }
      if (response.type === 'event') {
        if (
          response.version !== PRIVATE_TRANSPORT_PROTOCOL_VERSION ||
          typeof response.event !== 'string' ||
          !['reliableMessage', 'datagram', 'error'].includes(response.event) ||
          typeof response.sessionId !== 'string' ||
          (response.binaryLength !== undefined &&
            (!Number.isInteger(response.binaryLength) ||
              (response.binaryLength as number) < 0 ||
              (response.binaryLength as number) > 64 * 1024))
        ) {
          this.failMalformed(child);
          return;
        }
        const event = {
          event: response.event as PrivateTransportSidecarEvent['event'],
          sessionId: response.sessionId,
          messageId:
            typeof response.messageId === 'string'
              ? response.messageId
              : undefined,
          code: typeof response.code === 'string' ? response.code : undefined,
          binaryLength: Number(response.binaryLength ?? 0),
        };
        if (event.binaryLength === 0)
          this.emit('event', { ...event, data: Buffer.alloc(0) });
        else this.pendingBinaryEvent = event;
        continue;
      }
      if (
        response.version !== PRIVATE_TRANSPORT_PROTOCOL_VERSION ||
        typeof response.requestId !== 'string' ||
        typeof response.ok !== 'boolean'
      ) {
        this.failMalformed(child);
        return;
      }
      const pending = this.pending.get(response.requestId);
      if (!pending) {
        this.failMalformed(child);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else {
        const code =
          typeof response.error?.code === 'string'
            ? response.error.code
            : 'SIDECAR_OPERATION_FAILED';
        pending.reject(new PrivateTransportSidecarError(code));
      }
    }
  }

  private failMalformed(child: ChildProcessWithoutNullStreams): void {
    this.handleDeath(child, 'MALFORMED_RESPONSE');
    child.kill();
  }

  private handleDeath(
    child: ChildProcessWithoutNullStreams,
    code: string
  ): void {
    if (this.child !== child) return;
    this.child = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.pendingBinaryEvent = null;
    this.emit('death', code);
    this.rejectPending(this.stopping ? 'SIDECAR_STOPPED' : code);
  }

  private rejectPending(code: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new PrivateTransportSidecarError(code));
    }
    this.pending.clear();
  }
}
