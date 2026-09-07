import {
  PrivateChannelError,
  type PrivateTransport,
  type PrivateTransportContext,
  type PrivateTransportEvent,
  type PrivateTransportMessage,
} from './private-channel-manager';
import type { PrivateChannelBootstrapProvider } from './private-channel-bootstrap';
import {
  PrivateTransportSidecar,
  PrivateTransportSidecarError,
  type PrivateTransportSidecarEvent,
} from './private-transport-sidecar';

export type TrustedRelayConfig = Readonly<{
  relayAddress: string;
  relayServerName: string;
  relayCertSha256: string;
}>;
export type TrustedRelayProvider = () => Promise<TrustedRelayConfig>;

const MAX_RELIABLE_BINARY_BYTES = 64 * 1024;
const MAX_DATAGRAM_BINARY_BYTES = 1024;

export class QuicMasqueTransport implements PrivateTransport {
  private sessionId: string | null = null;
  private closed = false;
  private readonly onSidecarEvent = (event: PrivateTransportSidecarEvent) =>
    this.handleSidecarEvent(event);
  private readonly onSidecarDeath = () => {
    if (!this.closed && this.sessionId) {
      this.emit({ kind: 'error', code: 'TRANSPORT_CLOSED' });
    }
  };

  constructor(
    private readonly emit: (event: PrivateTransportEvent) => void,
    private readonly sidecar: PrivateTransportSidecar,
    private readonly relay: TrustedRelayConfig | TrustedRelayProvider,
    private readonly bootstrapProvider: PrivateChannelBootstrapProvider
  ) {
    sidecar.on('event', this.onSidecarEvent);
    sidecar.on('death', this.onSidecarDeath);
  }

  async open(context: PrivateTransportContext): Promise<void> {
    if (this.closed) throw new PrivateChannelError('TRANSPORT_CLOSED');
    const bootstrap = await this.bootstrapProvider.getBootstrap(context);
    try {
      const relay =
        typeof this.relay === 'function' ? await this.relay() : this.relay;
      const opened = await this.sidecar.openPrivateSession({
        relayAddress: relay.relayAddress,
        relayServerName: relay.relayServerName,
        relayCertSha256: relay.relayCertSha256,
        backendAddress: bootstrap.backendTransportEndpoint,
        backendServerName: bootstrap.backendTransportServerName,
        backendCertSha256: bootstrap.backendTransportCertSha256,
        logicalSessionId: bootstrap.logicalSessionId,
        attachToken: bootstrap.attachToken,
        nonce: bootstrap.nonce,
        purpose: context.purpose,
        ownerBindingHash: bootstrap.ownerBindingHash,
      });
      this.sessionId = opened.sessionId;
    } catch (error) {
      throw translateSidecarError(error);
    }
  }

  async sendReliable(message: PrivateTransportMessage): Promise<void> {
    const sessionId = this.requireSession();
    const encoded = encodeApplicationData(message.data);
    if (encoded.length > MAX_RELIABLE_BINARY_BYTES) {
      throw new PrivateChannelError('MESSAGE_TOO_LARGE_FOR_TRANSPORT');
    }
    try {
      await this.sidecar.sendPrivateReliable(
        sessionId,
        message.messageId,
        encoded
      );
    } catch (error) {
      throw translateSidecarError(error);
    }
  }

  async sendDatagram(message: PrivateTransportMessage): Promise<void> {
    const sessionId = this.requireSession();
    const encoded = encodeApplicationData(message.data);
    if (encoded.length > MAX_DATAGRAM_BINARY_BYTES) {
      throw new PrivateChannelError('MESSAGE_TOO_LARGE_FOR_TRANSPORT');
    }
    try {
      await this.sidecar.sendPrivateDatagram(
        sessionId,
        message.messageId,
        encoded
      );
    } catch (error) {
      throw translateSidecarError(error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.sidecar.off('event', this.onSidecarEvent);
    this.sidecar.off('death', this.onSidecarDeath);
    if (sessionId)
      await this.sidecar.closePrivateSession(sessionId).catch(() => undefined);
  }

  private requireSession(): string {
    if (this.closed || !this.sessionId)
      throw new PrivateChannelError('TRANSPORT_CLOSED');
    return this.sessionId;
  }

  private handleSidecarEvent(event: PrivateTransportSidecarEvent): void {
    if (event.sessionId !== this.sessionId || this.closed) return;
    if (event.event === 'error') {
      this.emit({ kind: 'error', code: event.code ?? 'TRANSPORT_ERROR' });
      return;
    }
    if (!event.messageId) {
      this.emit({ kind: 'error', code: 'PROTOCOL_MISMATCH' });
      return;
    }
    try {
      this.emit({
        kind: 'message',
        lane: event.event === 'datagram' ? 'datagram' : 'reliable',
        messageId: event.messageId,
        data: decodeApplicationData(event.data),
      });
    } catch {
      this.emit({ kind: 'error', code: 'PROTOCOL_MISMATCH' });
    }
  }
}

function encodeApplicationData(value: unknown): Buffer {
  if (value instanceof ArrayBuffer)
    return Buffer.concat([Buffer.from([1]), Buffer.from(value)]);
  if (ArrayBuffer.isView(value)) {
    return Buffer.concat([
      Buffer.from([1]),
      Buffer.from(value.buffer, value.byteOffset, value.byteLength),
    ]);
  }
  try {
    return Buffer.concat([
      Buffer.from([0]),
      Buffer.from(JSON.stringify(value ?? null), 'utf8'),
    ]);
  } catch {
    throw new PrivateChannelError('INVALID_MESSAGE');
  }
}

function decodeApplicationData(value: Buffer): unknown {
  if (value.length < 1) throw new Error('missing application encoding');
  if (value[0] === 1) return new Uint8Array(value.subarray(1));
  if (value[0] === 0) return JSON.parse(value.subarray(1).toString('utf8'));
  throw new Error('unsupported application encoding');
}

function translateSidecarError(error: unknown): PrivateChannelError {
  const code =
    error instanceof PrivateTransportSidecarError
      ? error.code
      : error instanceof Error && error.message === 'MASQUE_RELAY_UNAVAILABLE'
        ? error.message
        : 'TRANSPORT_ERROR';
  const allowed = new Set([
    'BACKEND_IDENTITY_MISMATCH',
    'MASQUE_TUNNEL_FAILED',
    'MASQUE_RELAY_UNAVAILABLE',
    'INNER_QUIC_FAILED',
    'SESSION_ATTACH_FAILED',
    'ATTACH_TOKEN_REJECTED',
    'DATAGRAM_UNSUPPORTED',
    'TRANSPORT_CLOSED',
    'PROTOCOL_MISMATCH',
    'FRAME_TOO_LARGE',
  ]);
  return new PrivateChannelError(allowed.has(code) ? code : 'TRANSPORT_ERROR');
}
