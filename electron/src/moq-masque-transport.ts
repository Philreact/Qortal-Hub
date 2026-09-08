import type { PrivateChannelBootstrapProvider } from './private-channel-bootstrap';
import type { PrivateTransportContext } from './private-channel-manager';
import {
  MAX_MOQ_OBJECT_BYTES,
  PrivateTransportSidecar,
  PrivateTransportSidecarError,
  type PrivateTransportSidecarEvent,
} from './private-transport-sidecar';
import type {
  TrustedRelayConfig,
  TrustedRelayProvider,
} from './quic-masque-transport';
import type { QAppReticulumOwner } from './qapp-reticulum-manager';

const MOQ_NAME = /^[A-Za-z0-9._-]{1,128}$/;

function validNamespace(namespace: readonly string[]): boolean {
  return (
    namespace.length >= 1 &&
    namespace.length <= 8 &&
    namespace.every((component) => MOQ_NAME.test(component)) &&
    namespace.reduce((total, component) => total + component.length, 0) <= 512
  );
}

export type MoqOpenContext = Readonly<{
  owner: QAppReticulumOwner;
  rnsConnectionId: string;
  publicationNamespace: readonly string[];
  publicationTrack: string;
}>;

export type MoqTransportEvent =
  | Readonly<{
      kind: 'object';
      subscriptionId: string;
      namespace: readonly string[];
      trackName: string;
      groupId: number;
      objectId: number;
      payload: Uint8Array;
    }>
  | Readonly<{ kind: 'error'; code: string; subscriptionId?: string }>;

/**
 * Main-process-only generic MOQT transport. Payload meaning and protection are
 * deliberately outside this layer; endpoints and sockets remain private.
 */
export class MoqMasqueTransport {
  private moqSessionId: string | null = null;
  private closed = false;
  private readonly onSidecarEvent = (event: PrivateTransportSidecarEvent) =>
    this.handleSidecarEvent(event);
  private readonly onSidecarDeath = () => {
    if (!this.closed && this.moqSessionId) {
      this.emit({ kind: 'error', code: 'MOQ_TRANSPORT_CLOSED' });
    }
  };

  constructor(
    private readonly emit: (event: MoqTransportEvent) => void,
    private readonly sidecar: PrivateTransportSidecar,
    private readonly relay: TrustedRelayConfig | TrustedRelayProvider,
    private readonly bootstrapProvider: PrivateChannelBootstrapProvider
  ) {
    sidecar.on('event', this.onSidecarEvent);
    sidecar.on('death', this.onSidecarDeath);
  }

  async open(context: MoqOpenContext): Promise<void> {
    if (this.closed || this.moqSessionId) {
      throw new PrivateTransportSidecarError('MOQ_SESSION_CLOSED');
    }
    if (
      !validNamespace(context.publicationNamespace) ||
      !MOQ_NAME.test(context.publicationTrack)
    ) {
      throw new PrivateTransportSidecarError('INVALID_MOQ_CONFIG');
    }
    const relay = await this.resolveRelay();
    const bootstrapContext: PrivateTransportContext = {
      channelId: 'trusted-moq-transport',
      rnsConnectionId: context.rnsConnectionId,
      purpose: 'realtime',
      generation: 1,
      owner: context.owner,
    };
    const bootstrap =
      await this.bootstrapProvider.getBootstrap(bootstrapContext);
    if (
      bootstrap.applicationProtocol !== 'moqt-18' ||
      bootstrap.supportedFeatures.moqt !== true
    ) {
      throw new PrivateTransportSidecarError('UNSUPPORTED_MOQ_TRANSPORT');
    }
    const openAt = (relayAddress: string) =>
      this.sidecar.openMoqSession({
        relayAddress,
        relayServerName: relay.relayServerName,
        relayCertSha256: relay.relayCertSha256,
        backendAddress: bootstrap.backendTransportEndpoint,
        backendServerName: bootstrap.backendTransportServerName,
        backendCertSha256: bootstrap.backendTransportCertSha256,
        logicalSessionId: bootstrap.logicalSessionId,
        attachToken: bootstrap.attachToken,
        publicationNamespace: context.publicationNamespace,
        publicationTrack: context.publicationTrack,
      });
    let opened;
    try {
      opened = await openAt(relay.relayAddress);
    } catch (error) {
      if (
        !(error instanceof PrivateTransportSidecarError) ||
        error.code !== 'MASQUE_TUNNEL_FAILED' ||
        !relay.localFallbackAddress ||
        relay.localFallbackAddress === relay.relayAddress
      ) {
        throw error;
      }
      opened = await openAt(relay.localFallbackAddress);
    }
    this.moqSessionId = opened.moqSessionId;
  }

  async subscribe(
    subscriptionId: string,
    namespace: readonly string[],
    trackName: string
  ): Promise<void> {
    if (
      !MOQ_NAME.test(subscriptionId) ||
      !validNamespace(namespace) ||
      !MOQ_NAME.test(trackName)
    ) {
      throw new PrivateTransportSidecarError('INVALID_MOQ_SUBSCRIPTION');
    }
    await this.sidecar.subscribeMoqTrack(
      this.requireSession(),
      subscriptionId,
      namespace,
      trackName
    );
  }

  async publish(payload: Uint8Array): Promise<void> {
    if (payload.byteLength < 1 || payload.byteLength > MAX_MOQ_OBJECT_BYTES) {
      throw new PrivateTransportSidecarError('MOQ_OBJECT_TOO_LARGE');
    }
    await this.sidecar.publishMoqObject(this.requireSession(), payload);
  }

  async metrics(): Promise<Record<string, number>> {
    return this.sidecar.moqSessionMetrics(this.requireSession());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const moqSessionId = this.moqSessionId;
    this.moqSessionId = null;
    this.sidecar.off('event', this.onSidecarEvent);
    this.sidecar.off('death', this.onSidecarDeath);
    if (moqSessionId) {
      await this.sidecar.closeMoqSession(moqSessionId).catch(() => undefined);
    }
  }

  private async resolveRelay(): Promise<TrustedRelayConfig> {
    return typeof this.relay === 'function' ? this.relay() : this.relay;
  }

  private requireSession(): string {
    if (this.closed || !this.moqSessionId) {
      throw new PrivateTransportSidecarError('MOQ_SESSION_CLOSED');
    }
    return this.moqSessionId;
  }

  private handleSidecarEvent(event: PrivateTransportSidecarEvent): void {
    if (event.sessionId !== this.moqSessionId || this.closed) return;
    if (event.event === 'error') {
      this.emit({
        kind: 'error',
        code: event.code ?? 'MOQ_TRANSPORT_ERROR',
        subscriptionId: event.subscriptionId,
      });
      return;
    }
    if (
      event.event !== 'object' ||
      !event.subscriptionId ||
      !event.namespace ||
      !validNamespace(event.namespace) ||
      !event.trackName ||
      !MOQ_NAME.test(event.trackName) ||
      typeof event.groupId !== 'number' ||
      typeof event.objectId !== 'number' ||
      !Number.isSafeInteger(event.groupId) ||
      !Number.isSafeInteger(event.objectId) ||
      event.data.length < 1 ||
      event.data.length > MAX_MOQ_OBJECT_BYTES
    ) {
      this.emit({ kind: 'error', code: 'MOQ_PROTOCOL_MISMATCH' });
      return;
    }
    this.emit({
      kind: 'object',
      subscriptionId: event.subscriptionId,
      namespace: [...event.namespace],
      trackName: event.trackName,
      groupId: event.groupId,
      objectId: event.objectId,
      payload: new Uint8Array(event.data),
    });
  }
}
