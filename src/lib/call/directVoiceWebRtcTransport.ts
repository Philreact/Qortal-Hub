export type DirectVoiceRtcSignal =
  | {
      kind: 'description';
      generation: string;
      description: RTCSessionDescriptionInit;
    }
  | {
      kind: 'ice';
      generation: string;
      candidate: RTCIceCandidateInit | null;
    };

export type DirectVoiceRtcState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'recovering'
  | 'closed';

type DirectVoiceWebRtcTransportOptions = {
  offerer: boolean;
  getIceServers: () => Promise<RTCIceServer[]>;
  onSignal: (signal: DirectVoiceRtcSignal) => void;
  onPacket: (packet: ArrayBuffer) => void;
  onState?: (state: DirectVoiceRtcState) => void;
};

const DC_BUFFERED_AMOUNT_HIGH_WATER = 128 * 1024;
const DC_MAX_AUDIO_PACKET_BYTES = 16 * 1024;
const ICE_DISCONNECT_GRACE_MS = 3_000;
const ICE_RESTART_MIN_INTERVAL_MS = 6_000;
const ICE_RESTART_MAX_ATTEMPTS = 2;
const ICE_RESTART_COOLDOWN_MS = 30_000;

function nextGeneration(): string {
  return crypto.randomUUID();
}

/**
 * A deliberately small WebRTC data plane. Signaling is supplied by the caller
 * and is transported separately over the authenticated direct Reticulum link.
 * This class never logs SDP, candidates, or packet contents.
 */
export class DirectVoiceWebRtcTransport {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private generation = '';
  private state: DirectVoiceRtcState = 'idle';
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private earlyCandidatesByGeneration = new Map<
    string,
    RTCIceCandidateInit[]
  >();
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempts = 0;
  private lastRestartAt = 0;
  private closed = false;

  constructor(private readonly options: DirectVoiceWebRtcTransportOptions) {}

  getState(): DirectVoiceRtcState {
    return this.state;
  }

  isOpen(): boolean {
    return this.state === 'open' && this.dc?.readyState === 'open';
  }

  async start(): Promise<void> {
    if (this.closed || this.pc) return;
    this.generation = this.options.offerer ? nextGeneration() : '';
    await this.createPeerConnection();
    if (!this.options.offerer || !this.pc) return;
    this.attachDataChannel(
      this.pc.createDataChannel('qortal-dm-audio-v1', {
        ordered: false,
        maxRetransmits: 0,
      })
    );
    await this.sendOffer(false);
  }

  send(packet: Uint8Array): boolean {
    const dc = this.dc;
    if (!dc || !this.isOpen()) return false;
    if (dc.bufferedAmount > DC_BUFFERED_AMOUNT_HIGH_WATER) return false;
    try {
      const copy = packet.slice();
      dc.send(copy.buffer);
      return true;
    } catch {
      return false;
    }
  }

  async handleSignal(signal: DirectVoiceRtcSignal): Promise<void> {
    if (this.closed) return;
    if (!this.pc) await this.createPeerConnection();
    let pc = this.pc;
    if (!pc) return;

    if (signal.kind === 'description') {
      const description = signal.description;
      if (description.type !== 'offer' && description.type !== 'answer') return;
      if (description.type === 'offer') {
        if (this.options.offerer) return;
        if (!signal.generation) return;
        if (pc.signalingState === 'closed' || pc.connectionState === 'failed') {
          this.releasePeerConnection();
          await this.createPeerConnection();
          pc = this.pc;
          if (!pc) return;
        }
        if (this.generation && this.generation !== signal.generation) {
          this.pendingCandidates = [];
        }
        this.generation = signal.generation;
        this.pendingCandidates.push(
          ...(this.earlyCandidatesByGeneration.get(signal.generation) ?? [])
        );
        this.earlyCandidatesByGeneration.clear();
        await pc.setRemoteDescription(description);
        await this.flushPendingCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (pc.localDescription) {
          this.options.onSignal({
            kind: 'description',
            generation: this.generation,
            description: pc.localDescription.toJSON(),
          });
        }
        return;
      }
      if (!this.options.offerer || signal.generation !== this.generation)
        return;
      await pc.setRemoteDescription(description);
      await this.flushPendingCandidates();
      return;
    }

    if (!signal.generation) return;
    if (!signal.candidate) return;
    if (signal.generation !== this.generation) {
      // Direct Reticulum frames are independently delivered, so a candidate
      // may legitimately beat its offer. Buffer a bounded number by ICE
      // generation on the answerer instead of silently losing it.
      if (!this.options.offerer) {
        const queued =
          this.earlyCandidatesByGeneration.get(signal.generation) ?? [];
        const total = [...this.earlyCandidatesByGeneration.values()].reduce(
          (sum, candidates) => sum + candidates.length,
          0
        );
        if (queued.length < 64 && total < 128) {
          queued.push(signal.candidate);
          this.earlyCandidatesByGeneration.set(signal.generation, queued);
          while (this.earlyCandidatesByGeneration.size > 4) {
            const oldest = this.earlyCandidatesByGeneration.keys().next().value;
            if (typeof oldest !== 'string') break;
            this.earlyCandidatesByGeneration.delete(oldest);
          }
        }
      }
      return;
    }
    if (!pc.remoteDescription) {
      if (this.pendingCandidates.length < 128) {
        this.pendingCandidates.push(signal.candidate);
      }
      return;
    }
    await pc.addIceCandidate(signal.candidate);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearDisconnectTimer();
    this.pendingCandidates = [];
    this.earlyCandidatesByGeneration.clear();
    this.releasePeerConnection();
    this.setState('closed');
  }

  private async createPeerConnection(): Promise<void> {
    if (this.pc || this.closed) return;
    let iceServers: RTCIceServer[] = [];
    try {
      iceServers = await this.options.getIceServers();
    } catch {
      iceServers = [];
    }
    if (this.closed) return;
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    this.setState('connecting');
    pc.ondatachannel = (event) => {
      if (
        this.options.offerer ||
        event.channel.label !== 'qortal-dm-audio-v1'
      ) {
        event.channel.close();
        return;
      }
      this.attachDataChannel(event.channel);
    };
    pc.onicecandidate = (event) => {
      // End-of-candidates carries no address and costs another signed,
      // fragmented Reticulum signal, so it is intentionally omitted.
      if (!this.generation || this.closed || !event.candidate) return;
      this.options.onSignal({
        kind: 'ice',
        generation: this.generation,
        candidate: event.candidate.toJSON(),
      });
    };
    pc.onconnectionstatechange = () => this.handleConnectionState();
  }

  private attachDataChannel(dc: RTCDataChannel): void {
    if (this.closed) {
      dc.close();
      return;
    }
    if (this.dc && this.dc !== dc) {
      this.dc.onclose = null;
      this.dc.onerror = null;
      this.dc.onmessage = null;
      this.dc.close();
    }
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = DC_BUFFERED_AMOUNT_HIGH_WATER / 2;
    dc.onopen = () => {
      this.restartAttempts = 0;
      this.clearDisconnectTimer();
      this.setState('open');
    };
    dc.onclose = () => {
      if (!this.closed) this.scheduleRecovery();
    };
    dc.onerror = () => {
      if (!this.closed) this.scheduleRecovery();
    };
    dc.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (event.data.byteLength > DC_MAX_AUDIO_PACKET_BYTES) return;
        this.options.onPacket(event.data);
        return;
      }
      if (event.data instanceof Blob) {
        if (event.data.size > DC_MAX_AUDIO_PACKET_BYTES) return;
        void event.data.arrayBuffer().then((packet) => {
          if (!this.closed) this.options.onPacket(packet);
        });
      }
    };
  }

  private async sendOffer(iceRestart: boolean): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed || !this.options.offerer) return;
    if (iceRestart) {
      this.generation = nextGeneration();
      this.pendingCandidates = [];
      if (!this.dc || this.dc.readyState === 'closed') {
        this.attachDataChannel(
          pc.createDataChannel('qortal-dm-audio-v1', {
            ordered: false,
            maxRetransmits: 0,
          })
        );
      }
    }
    const offer = await pc.createOffer({ iceRestart });
    await pc.setLocalDescription(offer);
    if (!pc.localDescription || this.closed) return;
    this.options.onSignal({
      kind: 'description',
      generation: this.generation,
      description: pc.localDescription.toJSON(),
    });
  }

  private handleConnectionState(): void {
    const state = this.pc?.connectionState;
    if (state === 'connected') {
      this.clearDisconnectTimer();
      if (this.dc?.readyState === 'open') this.setState('open');
      return;
    }
    if (state === 'failed' || state === 'disconnected') {
      this.scheduleRecovery();
    }
  }

  private scheduleRecovery(): void {
    if (this.closed || this.disconnectTimer) return;
    this.setState('recovering');
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      void this.tryRestart();
    }, ICE_DISCONNECT_GRACE_MS);
  }

  private async tryRestart(): Promise<void> {
    if (this.closed || this.isOpen()) return;
    if (!this.options.offerer) {
      this.setState('connecting');
      return;
    }
    const now = Date.now();
    if (this.restartAttempts >= ICE_RESTART_MAX_ATTEMPTS) {
      const cooldownRemaining =
        ICE_RESTART_COOLDOWN_MS - (now - this.lastRestartAt);
      if (cooldownRemaining > 0) {
        this.setState('connecting');
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          this.restartAttempts = 0;
          void this.tryRestart();
        }, cooldownRemaining);
        return;
      }
      this.restartAttempts = 0;
    }
    const retryAfter = ICE_RESTART_MIN_INTERVAL_MS - (now - this.lastRestartAt);
    if (retryAfter > 0) {
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        void this.tryRestart();
      }, retryAfter);
      return;
    }
    this.restartAttempts += 1;
    this.lastRestartAt = now;
    try {
      if (
        !this.pc ||
        this.pc.connectionState === 'failed' ||
        this.dc?.readyState === 'closed'
      ) {
        this.releasePeerConnection();
        this.generation = nextGeneration();
        await this.createPeerConnection();
        if (!this.pc) return;
        this.attachDataChannel(
          this.pc.createDataChannel('qortal-dm-audio-v1', {
            ordered: false,
            maxRetransmits: 0,
          })
        );
        await this.sendOffer(false);
      } else {
        await this.sendOffer(true);
      }
    } catch {
      // A transient createOffer/setLocalDescription failure must not leave the
      // transport permanently stuck in "connecting". Keep Reticulum active and
      // schedule another bounded WebRTC recovery attempt.
      this.scheduleRecovery();
    }
  }

  private releasePeerConnection(): void {
    const dc = this.dc;
    const pc = this.pc;
    this.dc = null;
    this.pc = null;
    if (dc) {
      dc.onopen = null;
      dc.onclose = null;
      dc.onerror = null;
      dc.onmessage = null;
      try {
        dc.close();
      } catch {
        // Best effort during transport replacement/teardown.
      }
    }
    if (pc) {
      pc.ondatachannel = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // Best effort during transport replacement/teardown.
      }
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc || !pc.remoteDescription) return;
    const pending = this.pendingCandidates.splice(0);
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // A stale candidate must not abort the rest of negotiation.
      }
    }
  }

  private clearDisconnectTimer(): void {
    if (!this.disconnectTimer) return;
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private setState(state: DirectVoiceRtcState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState?.(state);
  }
}
