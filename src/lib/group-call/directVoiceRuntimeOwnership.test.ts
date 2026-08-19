import { describe, expect, it, vi } from 'vitest';
import { GroupCallAudioEngineRuntime } from './groupCallAudioEngineRuntime';

type RuntimeInternals = {
  directVoiceOwnerId: string;
  directVoiceRoomId: string;
  directVoicePeerAddress: string;
  directVoiceMuted: boolean;
  closeDirectVoiceRtc: (reason: string) => void;
  stopDirectVoiceMedia: () => Promise<void>;
  stopDirectVoiceReceive: () => Promise<void>;
};

describe('direct voice audio-surface ownership', () => {
  it('ignores teardown from a stale call lifecycle', async () => {
    const runtime = new GroupCallAudioEngineRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    internals.directVoiceOwnerId = 'current-call';
    internals.directVoiceRoomId = 'dmv:room';
    internals.directVoicePeerAddress = 'Qpeer';
    const closeSpy = vi
      .spyOn(internals, 'closeDirectVoiceRtc')
      .mockImplementation(() => {});

    const response = await runtime.handleCommand({
      type: 'stop-direct-voice-rtc',
      ownerId: 'stale-call',
    });

    expect(response).toEqual({
      ok: true,
      payload: { ignored: 'stale-owner' },
    });
    expect(closeSpy).not.toHaveBeenCalled();
    expect(internals.directVoiceRoomId).toBe('dmv:room');

    await runtime.handleCommand({
      type: 'stop-direct-voice-rtc',
      ownerId: 'current-call',
    });

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(closeSpy).toHaveBeenCalledWith('host-stop');
    expect(internals.directVoiceRoomId).toBe('');
    runtime.dispose();
  });

  it('applies updates only for the active call lifecycle', async () => {
    const runtime = new GroupCallAudioEngineRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    internals.directVoiceOwnerId = 'current-call';
    internals.directVoiceRoomId = 'dmv:room';
    internals.directVoicePeerAddress = 'Qpeer';
    internals.directVoiceMuted = false;

    await runtime.handleCommand({
      type: 'update-direct-voice-media',
      ownerId: 'stale-call',
      muted: true,
    });

    expect(internals.directVoiceMuted).toBe(false);
    runtime.dispose();
  });

  it('ignores every stale teardown path while the current call is active', async () => {
    const runtime = new GroupCallAudioEngineRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    internals.directVoiceOwnerId = 'current-call';
    internals.directVoiceRoomId = 'dmv:room';
    internals.directVoicePeerAddress = 'Qpeer';
    const stopMedia = vi
      .spyOn(internals, 'stopDirectVoiceMedia')
      .mockResolvedValue();
    const stopReceive = vi
      .spyOn(internals, 'stopDirectVoiceReceive')
      .mockResolvedValue();

    await runtime.handleCommand({
      type: 'stop-direct-voice-media',
      ownerId: 'stale-call',
    });
    await runtime.handleCommand({
      type: 'stop-direct-voice-receive',
      ownerId: 'stale-call',
    });

    expect(stopMedia).not.toHaveBeenCalled();
    expect(stopReceive).not.toHaveBeenCalled();
    expect(internals.directVoiceRoomId).toBe('dmv:room');
    runtime.dispose();
  });
});
