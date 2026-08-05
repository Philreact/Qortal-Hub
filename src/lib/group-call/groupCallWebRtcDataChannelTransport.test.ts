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

  constructor() {
    FakePeerConnection.latest = this;
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(
    description: RTCLocalSessionDescriptionInit
  ): Promise<void> {
    if (description.type === 'rollback') {
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
});
