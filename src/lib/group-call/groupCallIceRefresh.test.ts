import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroupCallAudioEngineRuntime } from './groupCallAudioEngineRuntime';

type TestRuntime = {
  snapshot: { roomId: string };
  callSessionId: string;
  groupRtcIceServers: RTCIceServer[];
  groupRtcIceServersLoaded: boolean;
  groupRtcIceServersLastLookupAt: number;
  groupRtcTransports: Map<
    string,
    {
      isOpen: () => boolean;
      updateIceServers: (servers: RTCIceServer[]) => Promise<void>;
    }
  >;
  closeGroupRtcTransport: (peerAddress: string, reason: string) => void;
  refreshGroupRtcIceServers: () => Promise<void>;
  resetGroupRtcIceServers: () => void;
  dispose: () => void;
};

const originalHub = window.hub;

function makeRuntime(): TestRuntime {
  const runtime = new GroupCallAudioEngineRuntime() as unknown as TestRuntime;
  runtime.snapshot = { ...runtime.snapshot, roomId: 'gcall-qortal-1143' };
  runtime.callSessionId = 'call-session';
  return runtime;
}

afterEach(() => {
  window.hub = originalHub;
  vi.restoreAllMocks();
});

describe('group-call community ICE refresh', () => {
  it('keeps an empty result retryable and upgrades unopened edges after discovery', async () => {
    const getIceServers = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ urls: 'stun:8.8.8.8:47321' }]);
    window.hub = { ...originalHub, getIceServers };
    const runtime = makeRuntime();
    const unopened = {
      isOpen: () => false,
      updateIceServers: vi.fn(async () => {}),
    };
    runtime.groupRtcTransports.set('Q-peer', unopened);
    runtime.closeGroupRtcTransport = vi.fn();

    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    await runtime.refreshGroupRtcIceServers();
    expect(runtime.groupRtcIceServersLoaded).toBe(false);
    expect(runtime.closeGroupRtcTransport).not.toHaveBeenCalled();

    vi.spyOn(Date, 'now').mockReturnValue(13_000);
    await runtime.refreshGroupRtcIceServers();
    expect(runtime.groupRtcIceServersLoaded).toBe(true);
    expect(runtime.groupRtcIceServers).toEqual([
      { urls: 'stun:8.8.8.8:47321' },
    ]);
    expect(unopened.updateIceServers).toHaveBeenCalledWith([
      { urls: 'stun:8.8.8.8:47321' },
    ]);

    runtime.dispose();
  });

  it('does not interrupt an edge that connected with host candidates', async () => {
    const getIceServers = vi
      .fn()
      .mockResolvedValueOnce([{ urls: 'stun:8.8.8.8:47321' }])
      .mockResolvedValueOnce([{ urls: 'stun:1.1.1.1:47321' }]);
    window.hub = {
      ...originalHub,
      getIceServers,
    };
    const runtime = makeRuntime();
    const opened = {
      isOpen: () => true,
      updateIceServers: vi.fn(async () => {}),
    };
    runtime.groupRtcTransports.set('Q-peer', opened);
    runtime.closeGroupRtcTransport = vi.fn();

    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    await runtime.refreshGroupRtcIceServers();

    expect(runtime.groupRtcIceServersLoaded).toBe(true);
    expect(runtime.closeGroupRtcTransport).not.toHaveBeenCalled();
    expect(opened.updateIceServers).not.toHaveBeenCalled();

    vi.spyOn(Date, 'now').mockReturnValue(10_000 + 4 * 60_000);
    await runtime.refreshGroupRtcIceServers();
    expect(getIceServers).toHaveBeenCalledTimes(2);
    expect(runtime.groupRtcIceServers).toEqual([
      { urls: 'stun:1.1.1.1:47321' },
    ]);
    expect(runtime.closeGroupRtcTransport).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('discards a discovery result from a call that has already ended', async () => {
    let resolveLookup!: (servers: { urls: string }[]) => void;
    window.hub = {
      ...originalHub,
      getIceServers: vi.fn(
        () =>
          new Promise<{ urls: string }[]>((resolve) => {
            resolveLookup = resolve;
          })
      ),
    };
    const runtime = makeRuntime();
    vi.spyOn(Date, 'now').mockReturnValue(10_000);

    const lookup = runtime.refreshGroupRtcIceServers();
    runtime.resetGroupRtcIceServers();
    resolveLookup([{ urls: 'stun:8.8.8.8:47321' }]);
    await lookup;

    expect(runtime.groupRtcIceServersLoaded).toBe(false);
    expect(runtime.groupRtcIceServers).toEqual([]);
    runtime.dispose();
  });

  it('does not let a stale lookup block discovery for a replacement call', async () => {
    let resolveOldLookup!: (servers: { urls: string }[]) => void;
    let resolveNewLookup!: (servers: { urls: string }[]) => void;
    const getIceServers = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ urls: string }[]>((resolve) => {
            resolveOldLookup = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ urls: string }[]>((resolve) => {
            resolveNewLookup = resolve;
          })
      );
    window.hub = { ...originalHub, getIceServers };
    const runtime = makeRuntime();
    vi.spyOn(Date, 'now').mockReturnValue(10_000);

    const oldLookup = runtime.refreshGroupRtcIceServers();
    runtime.resetGroupRtcIceServers();
    runtime.snapshot = {
      ...runtime.snapshot,
      roomId: 'gcall-qortal-1144',
    };
    runtime.callSessionId = 'replacement-call-session';
    const newLookup = runtime.refreshGroupRtcIceServers();

    expect(getIceServers).toHaveBeenCalledTimes(2);
    resolveNewLookup([{ urls: 'stun:1.1.1.1:47321' }]);
    await newLookup;
    resolveOldLookup([{ urls: 'stun:8.8.8.8:47321' }]);
    await oldLookup;

    expect(runtime.groupRtcIceServersLoaded).toBe(true);
    expect(runtime.groupRtcIceServers).toEqual([
      { urls: 'stun:1.1.1.1:47321' },
    ]);
    runtime.dispose();
  });
});
