import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DirectVoiceWebRtcTransport,
  type DirectVoiceRtcSignal,
} from './directVoiceWebRtcTransport';

class MockDataChannel {
  label = 'qortal-dm-audio-v1';
  readyState: RTCDataChannelState = 'connecting';
  binaryType: BinaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

class MockPeerConnection {
  static instances: MockPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  remoteDescription: RTCSessionDescription | null = null;
  localDescription: RTCSessionDescription | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addIceCandidate = vi.fn(async () => {});
  createAnswer = vi.fn(
    async () => ({ type: 'answer', sdp: 'answer' }) as RTCSessionDescriptionInit
  );
  createOffer = vi.fn(
    async () => ({ type: 'offer', sdp: 'offer' }) as RTCSessionDescriptionInit
  );
  setRemoteDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.remoteDescription = {
        type: description.type,
        sdp: description.sdp ?? '',
        toJSON: () => description,
      } as RTCSessionDescription;
    }
  );
  setLocalDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.localDescription = {
        type: description.type,
        sdp: description.sdp ?? '',
        toJSON: () => description,
      } as RTCSessionDescription;
    }
  );
  createDataChannel = vi.fn(
    () => new MockDataChannel() as unknown as RTCDataChannel
  );
  close = vi.fn();

  constructor(_configuration?: RTCConfiguration) {
    MockPeerConnection.instances.push(this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  MockPeerConnection.instances = [];
});

describe('DirectVoiceWebRtcTransport', () => {
  it('keeps a candidate that arrives before its offer', async () => {
    vi.stubGlobal(
      'RTCPeerConnection',
      MockPeerConnection as unknown as typeof RTCPeerConnection
    );
    const emitted: DirectVoiceRtcSignal[] = [];
    const transport = new DirectVoiceWebRtcTransport({
      offerer: false,
      getIceServers: async () => [{ urls: 'stun:example.test:3478' }],
      onSignal: (signal) => emitted.push(signal),
      onPacket: vi.fn(),
    });
    await transport.start();

    const candidate = {
      candidate: 'candidate:1 1 UDP 1 127.0.0.1 9 typ host',
    };
    await transport.handleSignal({
      kind: 'ice',
      generation: 'generation_1234',
      candidate,
    });
    await transport.handleSignal({
      kind: 'description',
      generation: 'generation_1234',
      description: { type: 'offer', sdp: 'offer' },
    });

    const pc = MockPeerConnection.instances[0]!;
    expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
    expect(pc.addIceCandidate).toHaveBeenCalledWith(candidate);
    expect(emitted).toContainEqual({
      kind: 'description',
      generation: 'generation_1234',
      description: { type: 'answer', sdp: 'answer' },
    });
    transport.close();
  });
});
