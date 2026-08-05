import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupCallAudioEngineRuntime } from './groupCallAudioEngineRuntime';

describe('group-call remote intentional silence', () => {
  function runtime(): any {
    const instance = Object.create(
      GroupCallAudioEngineRuntime.prototype
    ) as any;
    instance.remoteAudioIdleState = new Map();
    instance.remoteAudioIdleTimers = new Map();
    instance.remoteSpeechLastSeenAt = new Map();
    instance.idleSourceReleases = 0;
    instance.snapshot = {
      roomId: 'room-1',
      participants: [{ address: 'Q-peer' }],
    };
    instance.receiveEngine = {
      hasSource: vi.fn(() => true),
      removeSource: vi.fn().mockResolvedValue(undefined),
    };
    instance.recordDiagEvent = vi.fn();
    return instance;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
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
    expect(instance.hasRecentRemoteSpeech(5_000)).toBe(true);
    expect(instance.hasRecentRemoteSpeech(5_201)).toBe(false);
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

});
