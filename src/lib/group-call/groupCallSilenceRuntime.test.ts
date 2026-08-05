import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupCallAudioEngineRuntime } from './groupCallAudioEngineRuntime';

describe('group-call remote intentional silence', () => {
  function runtime(): any {
    const instance = Object.create(
      GroupCallAudioEngineRuntime.prototype
    ) as any;
    instance.remoteAudioIdleState = new Map();
    instance.remoteAudioIdleTimers = new Map();
    instance.remoteAudioIdleFadeTimers = new Map();
    instance.remoteAudioSilencedSources = new Set();
    instance.remoteSpeechLastSeenAt = new Map();
    instance.idleSourceReleases = 0;
    instance.snapshot = {
      roomId: 'room-1',
      participants: [{ address: 'Q-peer' }],
    };
    instance.receiveEngine = {
      hasSource: vi.fn(() => true),
      removeSource: vi.fn().mockResolvedValue(undefined),
      setSourceIntentionalSilence: vi.fn(),
    };
    instance.recordDiagEvent = vi.fn();
    return instance;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  it('smoothly silences concealment after confirmed idle packets stop', async () => {
    const instance = runtime();
    instance.noteRemoteAudioActivity('Q-peer', false, 1_000);
    instance.noteRemoteAudioActivity('Q-peer', false, 1_020);
    instance.noteRemoteAudioActivity('Q-peer', false, 1_040);

    vi.setSystemTime(1_119);
    await vi.advanceTimersByTimeAsync(119);
    expect(
      instance.receiveEngine.setSourceIntentionalSilence
    ).not.toHaveBeenCalled();

    vi.setSystemTime(1_120);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      instance.receiveEngine.setSourceIntentionalSilence
    ).toHaveBeenCalledWith('Q-peer', true);
    expect(instance.receiveEngine.removeSource).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases only decoder/playout after authenticated silence stops', async () => {
    const instance = runtime();
    instance.noteRemoteAudioActivity('Q-peer', false, 1_000);
    instance.noteRemoteAudioActivity('Q-peer', false, 1_020);
    instance.noteRemoteAudioActivity('Q-peer', false, 1_040);
    vi.setSystemTime(2_040);
    await vi.runOnlyPendingTimersAsync();

    expect(instance.receiveEngine.removeSource).toHaveBeenCalledWith('Q-peer');
    expect(instance.snapshot.participants).toEqual([{ address: 'Q-peer' }]);
    expect(instance.idleSourceReleases).toBe(1);
  });

  it('does not release a source when speech resumes before the idle delay', async () => {
    const instance = runtime();
    instance.noteRemoteAudioActivity('Q-peer', false, 1_000);
    instance.noteRemoteAudioActivity('Q-peer', false, 1_020);
    instance.noteRemoteAudioActivity('Q-peer', false, 1_040);
    instance.noteRemoteAudioActivity('Q-peer', true, 1_200);
    vi.setSystemTime(5_000);
    await vi.runOnlyPendingTimersAsync();

    expect(instance.receiveEngine.removeSource).not.toHaveBeenCalled();
    expect(
      instance.receiveEngine.setSourceIntentionalSilence
    ).not.toHaveBeenCalledWith('Q-peer', true);
    expect(instance.hasRecentRemoteSpeech(5_000)).toBe(true);
    expect(instance.hasRecentRemoteSpeech(5_201)).toBe(false);
  });

  it('re-fades after a late silence packet wakes an idle source', async () => {
    const instance = runtime();
    instance.noteRemoteAudioActivity('Q-peer', false, 1_000);
    instance.noteRemoteAudioActivity('Q-peer', false, 1_020);
    instance.noteRemoteAudioActivity('Q-peer', false, 1_040);
    vi.setSystemTime(1_120);
    await vi.advanceTimersByTimeAsync(120);

    instance.noteRemoteAudioActivity('Q-peer', false, 1_120);
    expect(
      instance.receiveEngine.setSourceIntentionalSilence
    ).toHaveBeenLastCalledWith('Q-peer', false);

    vi.setSystemTime(1_200);
    await vi.advanceTimersByTimeAsync(80);
    expect(
      instance.receiveEngine.setSourceIntentionalSilence
    ).toHaveBeenLastCalledWith('Q-peer', true);
  });

  it('maps recent speakers only to the transport route that carries them', () => {
    const instance = runtime();
    instance.userInfo = { address: 'Q-root' };
    instance.topology = {
      rootForwarder: 'Q-root',
      standbyForwarder: 'Q-forwarder',
      topologyEpoch: 1,
      clusters: [
        {
          forwarder: 'Q-root',
          standby: 'Q-local-standby',
          members: ['Q-root', 'Q-local-speaker'],
        },
        {
          forwarder: 'Q-forwarder',
          standby: 'Q-remote-standby',
          members: ['Q-forwarder', 'Q-remote-speaker'],
        },
      ],
    };
    instance.remoteSpeechLastSeenAt.set('Q-remote-speaker', 1_000);

    expect(
      instance.hasRecentSpeechForMediaRecoveryTarget('Q-forwarder', 2_000)
    ).toBe(true);
    expect(
      instance.hasRecentSpeechForMediaRecoveryTarget('Q-local-speaker', 2_000)
    ).toBe(false);
  });

  it('keeps zero-inbound startup recovery available before remote speech is observed', () => {
    const instance = runtime();
    const requestPeerMediaRecovery = vi.fn().mockResolvedValue(undefined);
    const requestRecovery = vi.fn().mockResolvedValue(undefined);
    instance.snapshot = { roomId: 'room-1', roomState: 'connected' };
    instance.roomKey = new Uint8Array([1]);
    instance.topology = { rootForwarder: 'Q-root', clusters: [] };
    instance.userInfo = { address: 'Q-me' };
    instance.outboundSendSuccesses = 10_000;
    instance.getMediaRecoveryTargets = vi.fn(() => ['Q-peer']);
    instance.getMediaTargetSettleAgeMs = vi.fn(() => Number.POSITIVE_INFINITY);
    instance.zeroInboundMediaRecoveryLastAtByAddress = new Map();
    instance.recordMediaRecoveryApiUnavailable = vi.fn();
    instance.recordThrottledDiagEvent = vi.fn();
    instance.groupRtcTransports = new Map([['Q-peer', { requestRecovery }]]);
    const previousGroupCall = window.groupCall;
    window.groupCall = {
      ...previousGroupCall,
      requestPeerMediaRecovery,
    } as typeof window.groupCall;

    try {
      instance.maybeRequestZeroInboundMediaRecovery({ packetsReceived: 0 });
      expect(requestPeerMediaRecovery).toHaveBeenCalledWith(
        'room-1',
        'Q-peer',
        'path-degraded-warm'
      );
      expect(requestRecovery).toHaveBeenCalledTimes(1);
    } finally {
      window.groupCall = previousGroupCall;
    }
  });
});
