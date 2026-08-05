export type GroupCallRtcSignal =
  | { type: 'capability'; version: 1 }
  | { type: 'reconnect' }
  | { type: 'offer' | 'answer'; description: RTCSessionDescriptionInit }
  | { type: 'candidate'; candidate: RTCIceCandidateInit | null };

export interface GroupCallWebRtcDataChannelTransportOptions {
  peerAddress: string;
  offerer: boolean;
  iceServers: RTCIceServer[];
  onSignal: (signal: GroupCallRtcSignal) => void | Promise<void>;
  onPacket: (packet: ArrayBuffer) => void;
  onState: (state: RTCPeerConnectionState | 'open' | 'closed') => void;
}

const DISCONNECT_GRACE_MS = 8_000;
const NEGOTIATION_RETRY_MS = 6_000;
const MAX_PENDING_ICE_CANDIDATES = 128;

/** One encrypted-packet DataChannel connection for one topology edge. */
export class GroupCallWebRtcDataChannelTransport {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private closed = false;
  private lastOfferAt = 0;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: GroupCallWebRtcDataChannelTransportOptions
  ) {}

  async start(negotiate = false): Promise<void> {
    return this.enqueueOperation(() => this.startInternal(negotiate));
  }

  async enableNegotiation(): Promise<void> {
    return this.enqueueOperation(() => this.enableNegotiationInternal());
  }

  async handleSignal(signal: GroupCallRtcSignal): Promise<void> {
    return this.enqueueOperation(() => this.handleSignalInternal(signal));
  }

  async restartIce(): Promise<void> {
    return this.enqueueOperation(() => this.restartIceInternal());
  }

  async requestRecovery(): Promise<void> {
    return this.enqueueOperation(async () => {
      if (this.options.offerer) await this.restartIceInternal();
      else await this.options.onSignal({ type: 'reconnect' });
    });
  }

  private async startInternal(negotiate = false): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.createPeerConnection();
    if (negotiate && this.options.offerer) await this.createAndSendOffer(false);
  }

  private async enableNegotiationInternal(): Promise<void> {
    if (!this.started) await this.startInternal(false);
    if (this.options.offerer && this.pc) {
      if (
        this.pc.signalingState === 'have-local-offer' &&
        Date.now() - this.lastOfferAt >= NEGOTIATION_RETRY_MS
      ) {
        await this.resendPendingOffer();
        return;
      }
      if (this.pc.signalingState !== 'stable') return;
      if (!this.pc.localDescription) {
        await this.createAndSendOffer(false);
      }
    }
  }

  isOpen(): boolean {
    return this.channel?.readyState === 'open';
  }

  send(packet: Uint8Array): boolean {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') return false;
    if (channel.bufferedAmount > 256 * 1024) return false;
    try {
      channel.send(packet);
      return true;
    } catch {
      return false;
    }
  }

  private async handleSignalInternal(signal: GroupCallRtcSignal): Promise<void> {
    if (!this.started) await this.startInternal(false);
    if (signal.type === 'capability') return;
    if (signal.type === 'reconnect') {
      await this.restartIceInternal();
      return;
    }
    const pc = this.pc ?? this.createPeerConnection();
    if (signal.type === 'offer') {
      let answerPc = pc;
      try {
        await answerPc.setRemoteDescription(signal.description);
      } catch (error) {
        if (!this.isIncompatibleReplacementOffer(error, answerPc)) throw error;
        answerPc = this.replacePeerConnectionForRemoteRestart();
        await answerPc.setRemoteDescription(signal.description);
      }
      await this.flushCandidates();
      const answer = await answerPc.createAnswer();
      await answerPc.setLocalDescription(answer);
      await this.options.onSignal({
        type: 'answer',
        description: answerPc.localDescription ?? answer,
      });
      return;
    }
    if (signal.type === 'answer') {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(signal.description);
        await this.flushCandidates();
      }
      return;
    }
    if (signal.candidate === null) return;
    if (!pc.remoteDescription) {
      if (this.pendingCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
        this.pendingCandidates.shift();
      }
      this.pendingCandidates.push(signal.candidate);
      return;
    }
    await pc.addIceCandidate(signal.candidate);
  }

  private async restartIceInternal(): Promise<void> {
    if (
      !this.options.offerer ||
      !this.pc ||
      this.pc.signalingState !== 'stable'
    )
      return;
    await this.createAndSendOffer(true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.clearDisconnectTimer();
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // Already closed by Chromium.
      }
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ondatachannel = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // Already closed by Chromium.
      }
    }
    this.pendingCandidates = [];
    this.options.onState('closed');
  }

  private createPeerConnection(): RTCPeerConnection {
    if (this.closed) throw new Error('WebRTC group transport is closed');
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers });
    this.pc = pc;
    pc.onicecandidate = (event) => {
      void this.options.onSignal({
        type: 'candidate',
        candidate: event.candidate?.toJSON() ?? null,
      });
    };
    pc.ondatachannel = (event) => this.attachChannel(event.channel);
    pc.onconnectionstatechange = () => {
      this.options.onState(pc.connectionState);
      if (pc.connectionState === 'connected') {
        this.clearDisconnectTimer();
      } else if (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected'
      ) {
        this.clearDisconnectTimer();
        this.disconnectTimer = setTimeout(
          () => {
            this.disconnectTimer = null;
            void this.requestRecovery();
          },
          pc.connectionState === 'failed' ? 0 : DISCONNECT_GRACE_MS
        );
      }
    };
    if (this.options.offerer) {
      this.attachChannel(
        pc.createDataChannel('qortal-group-audio', {
          ordered: false,
          maxRetransmits: 1,
        })
      );
    }
    return pc;
  }

  private attachChannel(channel: RTCDataChannel): void {
    if (this.channel && this.channel !== channel) {
      try {
        this.channel.close();
      } catch {
        // Already closed by Chromium.
      }
    }
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 64 * 1024;
    channel.onopen = () => this.options.onState('open');
    channel.onclose = () => this.options.onState('closed');
    channel.onerror = () => {
      // A DataChannel error is commonly followed by a useful connection-state
      // transition. Do not tear down an otherwise connected peer here; send()
      // will fall back until Chromium either recovers or closes the channel.
      this.options.onState(this.pc?.connectionState ?? 'disconnected');
    };
    channel.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.options.onPacket(event.data);
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then(this.options.onPacket).catch(() => {
          // A closing channel can invalidate an in-flight Blob conversion.
        });
      }
    };
  }

  private async createAndSendOffer(iceRestart: boolean): Promise<void> {
    const pc = this.pc ?? this.createPeerConnection();
    const offer = await pc.createOffer({ iceRestart });
    if (this.closed || this.pc !== pc) return;
    await pc.setLocalDescription(offer);
    if (this.closed || this.pc !== pc) return;
    this.lastOfferAt = Date.now();
    await this.options.onSignal({
      type: 'offer',
      description: pc.localDescription ?? offer,
    });
  }

  private async resendPendingOffer(): Promise<void> {
    const pc = this.pc;
    const description = pc?.localDescription;
    if (
      !pc ||
      pc.signalingState !== 'have-local-offer' ||
      description?.type !== 'offer'
    ) {
      return;
    }
    this.lastOfferAt = Date.now();
    await this.options.onSignal({ type: 'offer', description });
  }

  private isIncompatibleReplacementOffer(
    error: unknown,
    pc: RTCPeerConnection
  ): boolean {
    if (!pc.remoteDescription) return false;
    const detail = error instanceof Error ? error.message : String(error);
    return detail.includes('order of m-lines in subsequent offer');
  }

  /**
   * A peer can recreate its RTCPeerConnection after an ICE failure while its
   * account, call session, and topology edge remain unchanged. Chromium will
   * reject that new connection's SDP when its media layout differs from the
   * previous connection. Replace only the local WebRTC edge and keep the
   * Reticulum call/session alive so negotiation can recover in place.
   */
  private replacePeerConnectionForRemoteRestart(): RTCPeerConnection {
    this.clearDisconnectTimer();
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // Already closed by Chromium.
      }
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ondatachannel = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // Already closed by Chromium.
      }
    }
    this.pendingCandidates = [];
    this.options.onState('connecting');
    return this.createPeerConnection();
  }

  private async flushCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc?.remoteDescription) return;
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) await pc.addIceCandidate(candidate);
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  /**
   * SDP and ICE state transitions must be serialized. Reticulum verifies each
   * signal asynchronously, so candidates, retries, and topology maintenance
   * can otherwise enter RTCPeerConnection concurrently.
   */
  private enqueueOperation(operation: () => Promise<void>): Promise<void> {
    const next = this.operationChain.then(async () => {
      if (this.closed) return;
      await operation();
    });
    this.operationChain = next.catch(() => {});
    return next;
  }
}
