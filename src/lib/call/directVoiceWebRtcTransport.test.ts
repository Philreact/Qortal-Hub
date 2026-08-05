import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DirectVoiceWebRtcTransport,
  type DirectVoiceRtcSignal,
} from './directVoiceWebRtcTransport';

class MockPeerConnection {
  static instances: MockPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  remoteDescription: RTCSessionDescription | null = null;
  localDescription: RTCSessionDescription | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack = vi.fn();
  replaceTrack = vi.fn(async () => {});
  getSenders = vi.fn(() => [
    {
      track: { kind: 'audio' },
      replaceTrack: this.replaceTrack,
    } as unknown as RTCRtpSender,
  ]);
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
  close = vi.fn();

  constructor(_configuration?: RTCConfiguration) {
    MockPeerConnection.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  MockPeerConnection.instances = [];
});

describe('DirectVoiceWebRtcTransport', () => {
  const audioTrack = {
    id: 'mic-track',
    kind: 'audio',
    enabled: true,
    readyState: 'live',
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const localStream = {
    getAudioTracks: () => [audioTrack],
    getTracks: () => [audioTrack],
  } as unknown as MediaStream;

  it('keeps a candidate that arrives before its offer', async () => {
    vi.stubGlobal(
      'RTCPeerConnection',
      MockPeerConnection as unknown as typeof RTCPeerConnection
    );
    const emitted: DirectVoiceRtcSignal[] = [];
    const transport = new DirectVoiceWebRtcTransport({
      offerer: false,
      getIceServers: async () => [{ urls: 'stun:example.test:3478' }],
      localStream,
      onSignal: (signal) => emitted.push(signal),
      onRemoteStream: vi.fn(),
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
    expect(pc.addTrack).toHaveBeenCalledWith(audioTrack, localStream);
    expect(pc.addIceCandidate).toHaveBeenCalledWith(candidate);
    expect(emitted).toContainEqual({
      kind: 'description',
      generation: 'generation_1234',
      description: { type: 'answer', sdp: 'answer' },
    });
    transport.close();
  });

  it('opens native media when the peer connection connects', async () => {
    vi.stubGlobal(
      'RTCPeerConnection',
      MockPeerConnection as unknown as typeof RTCPeerConnection
    );
    const onState = vi.fn();
    const transport = new DirectVoiceWebRtcTransport({
      offerer: true,
      getIceServers: async () => [],
      localStream,
      onSignal: vi.fn(),
      onRemoteStream: vi.fn(),
      onState,
    });

    await transport.start();
    const pc = MockPeerConnection.instances[0]!;
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();

    expect(transport.isOpen()).toBe(false);

    pc.ontrack?.({
      track: { kind: 'audio' } as MediaStreamTrack,
      streams: [{} as MediaStream],
    } as RTCTrackEvent);

    expect(transport.isOpen()).toBe(true);
    expect(onState).toHaveBeenLastCalledWith('open');
    transport.close();
  });

  it('delivers the remote stream and replaces the microphone track', async () => {
    vi.stubGlobal(
      'RTCPeerConnection',
      MockPeerConnection as unknown as typeof RTCPeerConnection
    );
    const previousTrack = {
      id: 'previous-mic',
      kind: 'audio',
      enabled: true,
      readyState: 'live',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const previousStream = {
      getAudioTracks: () => [previousTrack],
      getTracks: () => [previousTrack],
    } as unknown as MediaStream;
    const nextTrack = {
      id: 'next-mic',
      kind: 'audio',
      enabled: true,
      readyState: 'live',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const nextStream = {
      getAudioTracks: () => [nextTrack],
      getTracks: () => [nextTrack],
    } as unknown as MediaStream;
    const remoteTrack = { kind: 'audio' } as MediaStreamTrack;
    const remoteStream = {} as MediaStream;
    const onRemoteStream = vi.fn();
    const transport = new DirectVoiceWebRtcTransport({
      offerer: false,
      getIceServers: async () => [],
      localStream: previousStream,
      onSignal: vi.fn(),
      onRemoteStream,
    });

    await transport.start();
    const pc = MockPeerConnection.instances[0]!;
    pc.ontrack?.({
      track: remoteTrack,
      streams: [remoteStream],
    } as RTCTrackEvent);
    await transport.replaceLocalStream(nextStream);

    expect(onRemoteStream).toHaveBeenCalledWith(remoteStream);
    expect(pc.replaceTrack).toHaveBeenCalledWith(nextTrack);
    expect(previousTrack.stop).toHaveBeenCalledOnce();
    transport.close();
  });

  it('retries recovery when a restart offer receives no answer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'RTCPeerConnection',
      MockPeerConnection as unknown as typeof RTCPeerConnection
    );
    const emitted: DirectVoiceRtcSignal[] = [];
    const transport = new DirectVoiceWebRtcTransport({
      offerer: true,
      getIceServers: async () => [],
      localStream,
      onSignal: (signal) => emitted.push(signal),
      onRemoteStream: vi.fn(),
    });

    await transport.start();
    const pc = MockPeerConnection.instances[0]!;
    pc.connectionState = 'connected';
    pc.ontrack?.({
      track: { kind: 'audio' } as MediaStreamTrack,
      streams: [{} as MediaStream],
    } as RTCTrackEvent);
    pc.onconnectionstatechange?.();
    expect(transport.isOpen()).toBe(true);

    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(pc.createOffer).toHaveBeenCalledTimes(2);
    expect(pc.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });

    // No answer and no further connection-state event: the watchdog must
    // still produce another restart attempt rather than remaining on the
    // Reticulum fallback forever.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pc.createOffer).toHaveBeenCalledTimes(3);
    expect(
      emitted.filter(
        (signal) =>
          signal.kind === 'description' && signal.description.type === 'offer'
      )
    ).toHaveLength(3);

    transport.close();
  });

  it('cancels the recovery watchdog after WebRTC reconnects', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'RTCPeerConnection',
      MockPeerConnection as unknown as typeof RTCPeerConnection
    );
    const transport = new DirectVoiceWebRtcTransport({
      offerer: true,
      getIceServers: async () => [],
      localStream,
      onSignal: vi.fn(),
      onRemoteStream: vi.fn(),
    });

    await transport.start();
    const pc = MockPeerConnection.instances[0]!;
    pc.connectionState = 'connected';
    pc.ontrack?.({
      track: { kind: 'audio' } as MediaStreamTrack,
      streams: [{} as MediaStream],
    } as RTCTrackEvent);
    pc.onconnectionstatechange?.();

    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pc.createOffer).toHaveBeenCalledTimes(2);

    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(transport.isOpen()).toBe(true);
    expect(pc.createOffer).toHaveBeenCalledTimes(2);
    transport.close();
  });
});
