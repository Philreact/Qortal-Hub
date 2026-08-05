import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroupCallWebRtcDataChannelTransport } from './groupCallWebRtcDataChannelTransport';

class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: unknown[] = [];

  send(value: unknown): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;
  static instances: FakePeerConnection[] = [];
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly channel = new FakeDataChannel();
  createOfferCalls = 0;
  rollbackCalls = 0;
  rejectNextOfferAsIncompatible = false;

  constructor() {
    FakePeerConnection.latest = this;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.createOfferCalls += 1;
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(
    description: RTCLocalSessionDescriptionInit
  ): Promise<void> {
    if (description.type === 'rollback') {
      this.rollbackCalls += 1;
      this.localDescription = null;
      this.signalingState = 'stable';
      return;
    }
    this.localDescription = description as RTCSessionDescription;
    this.signalingState =
      description.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    if (description.type === 'offer' && this.rejectNextOfferAsIncompatible) {
      this.rejectNextOfferAsIncompatible = false;
      throw new Error(
        "Failed to set remote offer sdp: The order of m-lines in subsequent offer doesn't match order from previous offer/answer."
      );
    }
    this.remoteDescription = description as RTCSessionDescription;
    this.signalingState =
      description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.connectionState = 'closed';
  }
}

const originalPeerConnection = globalThis.RTCPeerConnection;

afterEach(() => {
  globalThis.RTCPeerConnection = originalPeerConnection;
  FakePeerConnection.latest = null;
  FakePeerConnection.instances = [];
  vi.restoreAllMocks();
});

describe('GroupCallWebRtcDataChannelTransport', () => {
  it('waits for peer capability before the offer and sends only on an open channel', async () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const signals: string[] = [];
    const transport = new GroupCallWebRtcDataChannelTransport({
      peerAddress: 'peer',
      offerer: true,
      iceServers: [],
      onSignal: (signal) => signals.push(signal.type),
      onPacket: vi.fn(),
      onState: vi.fn(),
    });

    await transport.start(false);
    expect(signals).toEqual([]);
    expect(transport.send(new Uint8Array([1]))).toBe(false);

    await transport.enableNegotiation();
    expect(signals).toEqual(['offer']);

    const channel = FakePeerConnection.latest!.channel;
    channel.readyState = 'open';
    channel.onopen?.();
    expect(transport.send(new Uint8Array([2]))).toBe(true);
    expect(channel.sent).toHaveLength(1);
  });

  it('asks the offerer to reconnect when the answering edge needs recovery', async () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const signals: string[] = [];
    const transport = new GroupCallWebRtcDataChannelTransport({
      peerAddress: 'peer',
      offerer: false,
      iceServers: [],
      onSignal: (signal) => signals.push(signal.type),
      onPacket: vi.fn(),
      onState: vi.fn(),
    });

    await transport.start(false);
    await transport.requestRecovery();
    expect(signals).toEqual(['reconnect']);
  });

  it('serializes overlapping negotiation requests into one offer', async () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const signals: string[] = [];
    const transport = new GroupCallWebRtcDataChannelTransport({
      peerAddress: 'peer',
      offerer: true,
      iceServers: [],
      onSignal: (signal) => signals.push(signal.type),
      onPacket: vi.fn(),
      onState: vi.fn(),
    });

    await transport.start(false);
    await Promise.all([
      transport.enableNegotiation(),
      transport.enableNegotiation(),
    ]);

    expect(signals).toEqual(['offer']);
  });

  it('resends the pending offer without rolling it back or changing its SDP', async () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const offers: RTCSessionDescriptionInit[] = [];
    const transport = new GroupCallWebRtcDataChannelTransport({
      peerAddress: 'peer',
      offerer: true,
      iceServers: [],
      onSignal: (signal) => {
        if (signal.type === 'offer') offers.push(signal.description);
      },
      onPacket: vi.fn(),
      onState: vi.fn(),
    });

    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await transport.start(false);
    await transport.enableNegotiation();
    vi.spyOn(Date, 'now').mockReturnValue(8_000);
    await transport.enableNegotiation();

    const pc = FakePeerConnection.latest!;
    expect(offers).toHaveLength(2);
    expect(offers[1]).toEqual(offers[0]);
    expect(pc.createOfferCalls).toBe(1);
    expect(pc.rollbackCalls).toBe(0);
  });

  it('replaces only the peer connection when a restarted peer has incompatible SDP', async () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const states: string[] = [];
    const signals: string[] = [];
    const transport = new GroupCallWebRtcDataChannelTransport({
      peerAddress: 'peer',
      offerer: false,
      iceServers: [],
      onSignal: (signal) => signals.push(signal.type),
      onPacket: vi.fn(),
      onState: (state) => states.push(state),
    });

    await transport.start(false);
    await transport.handleSignal({
      type: 'offer',
      description: { type: 'offer', sdp: 'first-offer' },
    });
    const first = FakePeerConnection.latest!;
    first.rejectNextOfferAsIncompatible = true;
    await transport.handleSignal({
      type: 'offer',
      description: { type: 'offer', sdp: 'replacement-offer' },
    });

    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(first.connectionState).toBe('closed');
    expect(states).toContain('connecting');
    expect(signals).toEqual(['answer', 'answer']);
  });
});
