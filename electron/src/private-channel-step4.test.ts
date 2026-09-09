import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrivateChannelManager } from './private-channel-manager';
import {
  ReticulumPrivateChannelBootstrapProvider,
  type PrivateBootstrapDescriptor,
} from './private-channel-bootstrap';
import { PrivateTransportSidecar } from './private-transport-sidecar';
import { QuicMasqueTransport } from './quic-masque-transport';
import {
  QAppReticulumManager,
  type QAppReticulumNativeEvent,
  type QAppReticulumTransport,
} from './qapp-reticulum-manager';

const desktopRoot = process.cwd();
const backendRoot =
  process.env.QORTAL_QAPP_BACKEND_REPO ??
  '/home/qortal/Documents/qapp-backend-call';
const goBinary = process.env.QORTAL_GO_BINARY || 'go';
const uvBinary = process.env.QORTAL_UV_BINARY || 'uv';
const available =
  spawnSync(goBinary, ['version']).status === 0 &&
  spawnSync(uvBinary, ['--version']).status === 0 &&
  fs.existsSync(path.join(backendRoot, 'scripts/private_transport_fixture.py'));
const integration = available ? describe.sequential : describe.skip;

type BackendStartup = {
  backendAddress: string;
  backendDestination: string;
  backendCertSha256: string;
};
type RelayStartup = {
  relayAddress: string;
  relayServerName: string;
  relayCertSha256: string;
};

class JsonProcess {
  private buffer = '';
  private readonly lines: string[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) return;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const value = JSON.parse(line);
        const waiter = this.waiters.shift();
        if (waiter) waiter(value);
        else this.lines.push(line);
      }
    });
  }

  next<T>(): Promise<T> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(JSON.parse(line) as T);
    return new Promise((resolve) =>
      this.waiters.push((value) => resolve(value as T))
    );
  }

  command<T>(
    operation: string,
    values: Record<string, unknown> = {}
  ): Promise<T> {
    this.child.stdin.write(`${JSON.stringify({ operation, ...values })}\n`);
    return this.next<T>();
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    await this.command('shutdown').catch(() => undefined);
    this.child.kill();
  }
}

class RealBackendRnsHarness implements QAppReticulumTransport {
  readonly listeners = new Set<(event: QAppReticulumNativeEvent) => void>();
  authenticatedLogicalSessionId = '';
  constructor(readonly backend: JsonProcess) {}

  onEvent(listener: (event: QAppReticulumNativeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async invoke(action: string, payload: Record<string, unknown>) {
    if (action === 'qapp_rns_connect') {
      const authenticated = await this.backend.command<{
        authentication: string;
        logicalSessionId: string;
        ok: boolean;
      }>('bindAuthenticatedSession', {
        logicalConnectionId: payload.connectionId,
      });
      expect(authenticated).toMatchObject({
        authentication: 'signed-qapp-auth',
        ok: true,
      });
      this.authenticatedLogicalSessionId = authenticated.logicalSessionId;
      return { ok: true, payload: { state: 'CONNECTED' } };
    }
    if (action === 'qapp_rns_request') {
      expect(payload.path).toBe('/qortal/private-transport/bootstrap/v1');
      expect(payload.logicalConnectionId).toEqual(expect.any(String));
      const request = JSON.parse(
        Buffer.from(String(payload.payloadBase64), 'base64').toString('utf8')
      );
      const response = await this.backend.command('bootstrap', {
        payload: request,
      });
      return {
        ok: true,
        payload: {
          payloadBase64: Buffer.from(JSON.stringify(response)).toString(
            'base64'
          ),
          encoding: 'json',
        },
      };
    }
    if (action === 'qapp_rns_close') {
      await this.backend.command('disconnectReticulum');
      return { ok: true, payload: { state: 'CLOSED' } };
    }
    if (action === 'qapp_rns_send') {
      return { ok: true, payload: { messageId: 'reticulum-still-usable' } };
    }
    return { ok: false, code: 'RNS_PROTOCOL_ERROR' };
  }
}

integration('Step 4 real backend bootstrap and attachment', () => {
  let temporaryDirectory = '';
  let sidecarBinary = '';
  let relayBinary = '';

  beforeAll(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hub-step4-test-')
    );
    sidecarBinary = path.join(temporaryDirectory, 'private-transport-sidecar');
    relayBinary = path.join(temporaryDirectory, 'private-transport-relay');
    const nativeRoot = path.join(
      desktopRoot,
      'electron',
      'native',
      'private-transport'
    );
    for (const [output, source] of [
      [sidecarBinary, './cmd/qortal-private-transport'],
      [relayBinary, './cmd/qortal-private-transport-step4-relay'],
    ]) {
      const result = spawnSync(
        goBinary,
        ['build', '-trimpath', '-o', output, source],
        { cwd: nativeRoot, encoding: 'utf8' }
      );
      if (result.status !== 0)
        throw new Error(result.stderr || result.error?.message);
    }
  }, 60_000);

  afterAll(() => {
    if (temporaryDirectory)
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('uses the real RNS handler to attach MASQUE QUIC to the same session', async () => {
    const backend = new JsonProcess(
      spawn(
        uvBinary,
        ['run', 'python', 'scripts/private_transport_fixture.py'],
        { cwd: backendRoot, stdio: ['pipe', 'pipe', 'pipe'] }
      )
    );
    const backendStartup = await backend.next<BackendStartup>();
    const relay = new JsonProcess(
      spawn(relayBinary, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          QORTAL_STEP4_BACKEND_ADDRESS: backendStartup.backendAddress,
        },
      })
    );
    const relayStartup = await relay.next<RelayStartup>();
    const sidecar = new PrivateTransportSidecar({ command: sidecarBinary });
    const owner = { tabId: 'step4-tab', name: 'qapp-ui-call', service: 'APP' };
    const nativeTransport = new RealBackendRnsHarness(backend);
    const rnsManager = new QAppReticulumManager(nativeTransport);
    const rns = await rnsManager.connect(
      owner,
      backendStartup.backendDestination
    );
    const bootstrapProvider = new ReticulumPrivateChannelBootstrapProvider(
      rnsManager
    );
    const channels = new PrivateChannelManager(
      (candidateOwner, connectionId) =>
        rnsManager.connectionOwnership(candidateOwner, connectionId),
      (emit) =>
        new QuicMasqueTransport(emit, sidecar, relayStartup, bootstrapProvider)
    );
    try {
      const directDescriptor = await bootstrapProvider.getBootstrap({
        channelId: 'identity-and-token-probe',
        rnsConnectionId: rns.connectionId,
        purpose: 'game',
        generation: 1,
        owner,
      });
      await expect(
        sidecar.openPrivateSession({
          ...privateSessionConfig(directDescriptor, relayStartup),
          backendCertSha256: '00'.repeat(32),
        })
      ).rejects.toMatchObject({ code: 'BACKEND_IDENTITY_MISMATCH' });
      await expect(
        sidecar.openPrivateSession({
          ...privateSessionConfig(directDescriptor, relayStartup),
          attachToken: 'missing-attach-token',
        })
      ).rejects.toMatchObject({ code: 'ATTACH_TOKEN_REJECTED' });
      const directSession = await sidecar.openPrivateSession(
        privateSessionConfig(directDescriptor, relayStartup)
      );
      await sidecar.closePrivateSession(directSession.sessionId);
      await expect(
        sidecar.openPrivateSession(
          privateSessionConfig(directDescriptor, relayStartup)
        )
      ).rejects.toMatchObject({ code: 'ATTACH_TOKEN_REJECTED' });
      for (let index = 0; index < 100; index += 1) {
        const detached = await backend.command<{ privateAttached: boolean }>(
          'stats'
        );
        if (!detached.privateAttached) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await backend.command('stats')).toMatchObject({
        privateAttached: false,
        outstandingTokens: 0,
      });

      const opened = await channels.open(owner, rns.connectionId, 'game');
      expect(opened.state).toBe('OPEN');
      const stats = await backend.command<{
        logicalSessionId: string;
        privateAttached: boolean;
        backendPeer: string;
        outstandingTokens: number;
      }>('stats');
      expect(stats.logicalSessionId).toBe(
        nativeTransport.authenticatedLogicalSessionId
      );
      expect(stats.privateAttached).toBe(true);
      expect(stats.outstandingTokens).toBe(0);
      const relayStats = await relay.command<{ relayEgress: string }>('stats');
      expect(stats.backendPeer).toBe(relayStats.relayEgress);

      const messages: Array<Record<string, unknown>> = [];
      channels.on('event', (event) => {
        if (event.action === 'PRIVATE_CHANNEL_MESSAGE') messages.push(event);
      });
      await Promise.all([
        channels.send(owner, opened.channelId, 'reliable', 'real-r', {
          type: 'private_transport_echo',
          value: 'reliable-real-session',
        }),
        channels.send(owner, opened.channelId, 'datagram', 'real-d', {
          type: 'private_transport_echo',
          value: 'datagram-real-session',
        }),
      ]);
      for (let index = 0; index < 100 && messages.length < 2; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channelId: opened.channelId,
            lane: 'reliable',
            messageId: 'real-r',
          }),
          expect.objectContaining({
            channelId: opened.channelId,
            lane: 'datagram',
            messageId: 'real-d',
          }),
        ])
      );
      expect(await backend.command('reticulumStatus')).toMatchObject({
        usable: true,
        logicalSessionId: stats.logicalSessionId,
      });

      await channels.close(owner, opened.channelId);
      for (let index = 0; index < 100; index += 1) {
        const detached = await backend.command<{ privateAttached: boolean }>(
          'stats'
        );
        if (!detached.privateAttached) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await backend.command('stats')).toMatchObject({
        logicalSessionId: stats.logicalSessionId,
        privateAttached: false,
      });
      expect(await backend.command('reticulumStatus')).toMatchObject({
        usable: true,
        logicalSessionId: stats.logicalSessionId,
      });

      await bootstrapProvider.getBootstrap({
        channelId: 'unused-token',
        rnsConnectionId: rns.connectionId,
        purpose: 'game',
        generation: 1,
        owner,
      });
      expect(await backend.command('stats')).toMatchObject({
        outstandingTokens: 1,
      });
      await rnsManager.close(owner, rns.connectionId);
      expect(await backend.command('stats')).toMatchObject({
        outstandingTokens: 0,
      });
      expect(backendStartup.backendCertSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      channels.destroy();
      rnsManager.destroy();
      await sidecar.shutdown();
      await relay.close();
      await backend.close();
    }
  }, 30_000);
});

function privateSessionConfig(
  descriptor: PrivateBootstrapDescriptor,
  relay: RelayStartup
) {
  return {
    relayAddress: relay.relayAddress,
    relayServerName: relay.relayServerName,
    relayCertSha256: relay.relayCertSha256,
    backendAddress: descriptor.backendTransportEndpoint,
    backendServerName: descriptor.backendTransportServerName,
    backendCertSha256: descriptor.backendTransportCertSha256,
    logicalSessionId: descriptor.logicalSessionId,
    attachToken: descriptor.attachToken,
    nonce: descriptor.nonce,
    purpose: 'game',
    ownerBindingHash: descriptor.ownerBindingHash,
  };
}
