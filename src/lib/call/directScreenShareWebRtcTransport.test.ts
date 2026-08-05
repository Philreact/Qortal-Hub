import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DirectScreenShareWebRtcTransport,
  type DirectScreenShareRtcSignal,
} from './directScreenShareWebRtcTransport';

class FakePeerConnection {
  static latest: FakePeerConnection | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addedTracks: MediaStreamTrack[] = [];

  constructor() {
    FakePeerConnection.latest = this;
  }

  addTrack(track: MediaStreamTrack): RTCRtpSender {
    this.addedTracks.push(track);
    return {} as RTCRtpSender;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'screen-offer' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'screen-answer' };
  }

  async setLocalDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = {
      ...value,
      toJSON: () => value,
    } as RTCSessionDescription;
    this.signalingState =
      value.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = value as RTCSessionDescription;
    this.signalingState =
      value.type === 'offer' ? 'have-remote-offer' : 'stable';
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

describe('DirectScreenShareWebRtcTransport', () => {
  it('creates an isolated video-only offer for the sharing peer', async () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const track = { kind: 'video' } as MediaStreamTrack;
    const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
    const signals: DirectScreenShareRtcSignal[] = [];
    const transport = new DirectScreenShareWebRtcTransport({
      generation: 'screen_generation',
      sender: true,
      localStream: stream,
      getIceServers: async () => [],
      onSignal: (signal) => {
        signals.push(signal);
      },
      onRemoteStream: vi.fn(),
      onState: vi.fn(),
    });

    await transport.startSender();

    expect(FakePeerConnection.latest?.addedTracks).toEqual([track]);
    expect(signals[0]).toMatchObject({
      kind: 'screen-description',
      generation: 'screen_generation',
      description: { type: 'offer' },
    });
    transport.close();
  });

  it('answers an incoming screen offer and buffers early ICE safely', async () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const signals: DirectScreenShareRtcSignal[] = [];
    const transport = new DirectScreenShareWebRtcTransport({
      generation: 'screen_generation',
      sender: false,
      getIceServers: async () => [],
      onSignal: (signal) => {
        signals.push(signal);
      },
      onRemoteStream: vi.fn(),
      onState: vi.fn(),
    });

    await transport.handleSignal({
      kind: 'screen-ice',
      generation: 'screen_generation',
      candidate: { candidate: 'candidate' },
    });
    await transport.handleSignal({
      kind: 'screen-description',
      generation: 'screen_generation',
      description: { type: 'offer', sdp: 'screen-offer' },
    });

    expect(signals[0]).toMatchObject({
      kind: 'screen-description',
      generation: 'screen_generation',
      description: { type: 'answer' },
    });
    transport.close();
  });

  it('ignores signals belonging to another screen generation', async () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    const transport = new DirectScreenShareWebRtcTransport({
      generation: 'expected_generation',
      sender: false,
      getIceServers: async () => [],
      onSignal: vi.fn(),
      onRemoteStream: vi.fn(),
      onState: vi.fn(),
    });

    await transport.handleSignal({
      kind: 'screen-description',
      generation: 'stale_generation',
      description: { type: 'offer', sdp: 'stale' },
    });

    expect(FakePeerConnection.latest).toBeNull();
  });
});
