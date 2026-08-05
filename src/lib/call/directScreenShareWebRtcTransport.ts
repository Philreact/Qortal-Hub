export type DirectScreenShareRtcSignal =
  | {
      kind: 'screen-description';
      generation: string;
      description: RTCSessionDescriptionInit;
    }
  | {
      kind: 'screen-ice';
      generation: string;
      candidate: RTCIceCandidateInit;
    }
  | {
      kind: 'screen-stop';
      generation: string;
    };

export type DirectScreenShareRtcState =
  | 'connecting'
  | 'open'
  | 'failed'
  | 'closed';

type DirectScreenShareWebRtcTransportOptions = {
  generation: string;
  sender: boolean;
  localStream?: MediaStream;
  getIceServers: () => Promise<RTCIceServer[]>;
  onSignal: (
    signal: DirectScreenShareRtcSignal
  ) => boolean | void | Promise<boolean | void>;
  onRemoteStream: (stream: MediaStream) => void;
  onState: (state: DirectScreenShareRtcState) => void;
};

const SCREEN_DISCONNECT_GRACE_MS = 3_000;
const SCREEN_NEGOTIATION_TIMEOUT_MS = 20_000;
const SCREEN_ICE_SERVER_LOOKUP_TIMEOUT_MS = 3_000;
const MAX_PENDING_CANDIDATES = 128;

/**
 * An isolated video-only WebRTC edge for one active DM screen share.
 *
 * Voice remains on its existing native-audio/Reticulum transport. Keeping a
 * separate peer connection means screen capture, SDP negotiation, or video
 * failure can never renegotiate or tear down an otherwise healthy call.
 */
export class DirectScreenShareWebRtcTransport {
  private pc: RTCPeerConnection | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteVideoTrackSeen = false;
  private closed = false;

  constructor(
    private readonly options: DirectScreenShareWebRtcTransportOptions
  ) {}

  getGeneration(): string {
    return this.options.generation;
  }

  isSender(): boolean {
    return this.options.sender;
  }

  async startSender(): Promise<void> {
    if (!this.options.sender || this.closed || this.pc) return;
    const stream = this.options.localStream;
    const videoTrack = stream?.getVideoTracks()[0];
    if (!stream || !videoTrack) {
      throw new Error('screen-share-video-track-missing');
    }
    const pc = await this.createPeerConnection();
    pc.addTrack(videoTrack, stream);
    const offer = await pc.createOffer();
    if (this.closed || this.pc !== pc) return;
    await pc.setLocalDescription(offer);
    if (!pc.localDescription || this.closed || this.pc !== pc) return;
    const sent = await this.options.onSignal({
      kind: 'screen-description',
      generation: this.options.generation,
      description: pc.localDescription.toJSON(),
    });
    if (sent === false) throw new Error('screen-share-offer-send-failed');
  }

  async handleSignal(signal: DirectScreenShareRtcSignal): Promise<void> {
    if (this.closed || signal.generation !== this.options.generation) return;
    if (signal.kind === 'screen-stop') {
      this.close();
      return;
    }
    const pc = this.pc ?? (await this.createPeerConnection());
    if (signal.kind === 'screen-description') {
      if (signal.description.type === 'offer') {
        if (this.options.sender) return;
        await pc.setRemoteDescription(signal.description);
        await this.flushCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (!pc.localDescription || this.closed || this.pc !== pc) return;
        const sent = await this.options.onSignal({
          kind: 'screen-description',
          generation: this.options.generation,
          description: pc.localDescription.toJSON(),
        });
        if (sent === false && !this.closed) {
          throw new Error('screen-share-answer-send-failed');
        }
        return;
      }
      if (
        signal.description.type === 'answer' &&
        this.options.sender &&
        pc.signalingState === 'have-local-offer'
      ) {
        await pc.setRemoteDescription(signal.description);
        await this.flushCandidates();
      }
      return;
    }
    if (!pc.remoteDescription) {
      if (this.pendingCandidates.length >= MAX_PENDING_CANDIDATES) {
        this.pendingCandidates.shift();
      }
      this.pendingCandidates.push(signal.candidate);
      return;
    }
    await pc.addIceCandidate(signal.candidate);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearDisconnectTimer();
    this.clearNegotiationTimer();
    this.pendingCandidates = [];
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // Best effort during call teardown.
      }
    }
    this.options.onState('closed');
  }

  private async createPeerConnection(): Promise<RTCPeerConnection> {
    if (this.pc) return this.pc;
    if (this.closed) throw new Error('screen-share-transport-closed');
    let iceServers: RTCIceServer[] = [];
    let iceLookupTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      iceServers = await Promise.race([
        this.options.getIceServers(),
        new Promise<RTCIceServer[]>((resolve) => {
          iceLookupTimer = setTimeout(
            () => resolve([]),
            SCREEN_ICE_SERVER_LOOKUP_TIMEOUT_MS
          );
        }),
      ]);
    } catch {
      // Host candidates still support LAN sharing. Voice remains unaffected.
    } finally {
      if (iceLookupTimer) clearTimeout(iceLookupTimer);
    }
    if (this.closed) throw new Error('screen-share-transport-closed');
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    this.options.onState('connecting');
    this.negotiationTimer = setTimeout(() => {
      this.negotiationTimer = null;
      if (this.closed || this.pc?.connectionState === 'connected') return;
      this.options.onState('failed');
    }, SCREEN_NEGOTIATION_TIMEOUT_MS);
    pc.onicecandidate = (event) => {
      if (!event.candidate || this.closed) return;
      void Promise.resolve(
        this.options.onSignal({
          kind: 'screen-ice',
          generation: this.options.generation,
          candidate: event.candidate.toJSON(),
        })
      ).catch(() => {
        // A later candidate or the negotiated route may still succeed.
      });
    };
    pc.ontrack = (event) => {
      if (this.closed || event.track.kind !== 'video') return;
      this.remoteVideoTrackSeen = true;
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.options.onRemoteStream(stream);
      this.handleConnectionState();
    };
    pc.onconnectionstatechange = () => this.handleConnectionState();
    return pc;
  }

  private handleConnectionState(): void {
    const state = this.pc?.connectionState;
    if (state === 'connected') {
      this.clearDisconnectTimer();
      this.clearNegotiationTimer();
      if (this.options.sender || this.remoteVideoTrackSeen) {
        this.options.onState('open');
      }
      return;
    }
    if (state !== 'failed' && state !== 'disconnected') return;
    if (this.disconnectTimer) return;
    this.disconnectTimer = setTimeout(
      () => {
        this.disconnectTimer = null;
        if (this.closed || this.pc?.connectionState === 'connected') return;
        this.options.onState('failed');
      },
      state === 'failed' ? 0 : SCREEN_DISCONNECT_GRACE_MS
    );
  }

  private async flushCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc?.remoteDescription) return;
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      await pc.addIceCandidate(candidate);
    }
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private clearNegotiationTimer(): void {
    if (this.negotiationTimer) clearTimeout(this.negotiationTimer);
    this.negotiationTimer = null;
  }
}
