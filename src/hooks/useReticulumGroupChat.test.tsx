import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrimaryNamesForAddresses } from '../components/Group/groupApi';
import { useReticulumGroupChat } from './useReticulumGroupChat';

vi.mock('../components/Group/groupApi', () => ({
  getPrimaryNamesForAddresses: vi.fn(async () => ({})),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type SilencePayload = {
  ownerAddress: string;
  targetAddress: string;
  scopeType: 'group' | 'dm';
  scopeId: string;
  expiresAt: number | null;
  active: boolean;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function event(eventId: string, channelId: string, timestamp: number) {
  return {
    eventId,
    groupId: 42,
    channelId,
    timestamp,
    authorAddress: 'Qauthor',
    eventType: 'message',
  };
}

describe('useReticulumGroupChat', () => {
  let listeners: Array<(payload: { event: unknown }) => void>;
  let silenceListeners: Array<(payload: SilencePayload) => void>;
  let getMessageHistory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listeners = [];
    silenceListeners = [];
    getMessageHistory = vi.fn();
    vi.mocked(getPrimaryNamesForAddresses).mockResolvedValue({});
    Object.defineProperty(window, 'reticulumChat', {
      configurable: true,
      value: {
        isEnabled: vi.fn(async () => true),
        subscribeGroup: vi.fn(async () => ({ success: true })),
        subscribeChannel: vi.fn(async () => ({ success: true })),
        unsubscribeChannel: vi.fn(async () => ({ success: true })),
        getMessageHistory,
        onEvent: vi.fn((listener: (payload: { event: unknown }) => void) => {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter((candidate) => candidate !== listener);
          };
        }),
        onTyping: vi.fn(() => () => undefined),
        onSilenceChanged: vi.fn(
          (listener: (payload: SilencePayload) => void) => {
            silenceListeners.push(listener);
            return () => {
              silenceListeners = silenceListeners.filter(
                (candidate) => candidate !== listener
              );
            };
          }
        ),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scopes initial-history readiness to the active channel', async () => {
    const alphaHistory = deferred<unknown[]>();
    const betaHistory = deferred<unknown[]>();
    getMessageHistory.mockImplementation(
      (_groupId: number, channelId: string) =>
        channelId === 'alpha' ? alphaHistory.promise : betaHistory.promise
    );
    const { result, rerender } = renderHook(
      ({ channelId }) => useReticulumGroupChat(42, channelId),
      { initialProps: { channelId: 'alpha' } }
    );

    await waitFor(() => expect(getMessageHistory).toHaveBeenCalledTimes(1));
    expect(result.current.initialHistoryReady).toBe(false);

    await act(async () => {
      alphaHistory.resolve([event('alpha-current', 'alpha', 200)]);
      await alphaHistory.promise;
    });
    await waitFor(() => expect(result.current.initialHistoryReady).toBe(true));

    rerender({ channelId: 'beta' });
    expect(result.current.initialHistoryReady).toBe(false);

    await act(async () => {
      betaHistory.resolve([event('beta-current', 'beta', 300)]);
      await betaHistory.promise;
    });
    await waitFor(() => expect(result.current.initialHistoryReady).toBe(true));
  });

  it('does not overwrite a live message that arrives during initial history', async () => {
    const initialHistory = deferred<unknown[]>();
    getMessageHistory.mockReturnValue(initialHistory.promise);
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => expect(getMessageHistory).toHaveBeenCalledTimes(1));

    act(() => {
      listeners[0]({ event: event('live-during-history', 'general', 300) });
    });
    await waitFor(
      () =>
        expect(
          result.current.events.map((item: any) => item.eventId)
        ).toContain('live-during-history'),
      { timeout: 1200 }
    );

    await act(async () => {
      initialHistory.resolve([event('initial-history', 'general', 200)]);
      await initialHistory.promise;
    });
    expect(result.current.events.map((item: any) => item.eventId)).toEqual([
      'initial-history',
      'live-during-history',
    ]);
  });

  it('does not merge an older page after switching channels', async () => {
    const olderPage = deferred<unknown[]>();
    getMessageHistory.mockImplementation(
      (
        _groupId: number,
        channelId: string,
        _limit: number,
        options?: object
      ) => {
        if (options) return olderPage.promise;
        return Promise.resolve([
          channelId === 'alpha'
            ? event('alpha-current', 'alpha', 200)
            : event('beta-current', 'beta', 300),
        ]);
      }
    );
    const { result, rerender } = renderHook(
      ({ channelId }) => useReticulumGroupChat(42, channelId),
      { initialProps: { channelId: 'alpha' } }
    );
    await waitFor(() => {
      expect(result.current.events).toEqual([
        expect.objectContaining({ eventId: 'alpha-current' }),
      ]);
    });

    let loadPromise!: Promise<{ added: number }>;
    act(() => {
      loadPromise = result.current.loadOlder();
    });
    rerender({ channelId: 'beta' });
    await waitFor(() => {
      expect(result.current.events).toEqual([
        expect.objectContaining({ eventId: 'beta-current' }),
      ]);
    });

    await act(async () => {
      olderPage.resolve([event('alpha-older', 'alpha', 100)]);
      await loadPromise;
    });
    expect(result.current.events).toEqual([
      expect.objectContaining({ eventId: 'beta-current' }),
    ]);
  });

  it('keeps older pagination available after a page adds messages', async () => {
    getMessageHistory
      .mockResolvedValueOnce([event('current', 'general', 200)])
      .mockResolvedValueOnce([event('older', 'general', 100)]);
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.events.map((item: any) => item.eventId)).toEqual([
      'older',
      'current',
    ]);
    expect(result.current.hasOlder).toBe(true);
  });

  it('uses the oldest message rather than a reaction as the history cursor', async () => {
    getMessageHistory
      .mockResolvedValueOnce([
        {
          ...event('reaction-with-skewed-time', 'general', 50),
          eventType: 'reaction_add',
          targetEventId: 'current',
        },
        event('current', 'general', 200),
      ])
      .mockResolvedValueOnce([event('older', 'general', 100)]);
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(getMessageHistory).toHaveBeenLastCalledWith(
      42,
      'general',
      100,
      expect.objectContaining({
        beforeEventId: 'current',
        beforeTimestamp: 200,
      })
    );
  });

  it('treats a transient membership history rejection as empty state', async () => {
    getMessageHistory.mockRejectedValueOnce(
      new Error('Local user is not a member of this group')
    );
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));

    await waitFor(() => {
      expect(getMessageHistory).toHaveBeenCalledTimes(1);
      expect(result.current.events).toEqual([]);
      expect(result.current.hasOlder).toBe(false);
    });
  });

  it('does not expose the retained previous-channel snapshot after a new-channel history failure', async () => {
    getMessageHistory.mockImplementation(
      (_groupId: number, channelId: string) =>
        channelId === 'alpha'
          ? Promise.resolve([event('alpha-current', 'alpha', 200)])
          : Promise.reject(new Error('history unavailable'))
    );
    const { result, rerender } = renderHook(
      ({ channelId }) => useReticulumGroupChat(42, channelId),
      { initialProps: { channelId: 'alpha' } }
    );
    await waitFor(() =>
      expect(result.current.events).toEqual([
        expect.objectContaining({ eventId: 'alpha-current' }),
      ])
    );

    rerender({ channelId: 'beta' });
    expect(result.current.initialHistoryReady).toBe(false);

    await waitFor(() => {
      expect(result.current.initialHistoryReady).toBe(true);
      expect(result.current.events).toEqual([]);
    });
  });

  it('shows a live event without waiting for primary-name lookup', async () => {
    getMessageHistory.mockResolvedValue([]);
    const names = deferred<Record<string, string>>();
    vi.mocked(getPrimaryNamesForAddresses).mockReturnValueOnce(names.promise);
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => expect(listeners).toHaveLength(1));

    act(() => {
      listeners[0]({ event: event('live-reply', 'general', 400) });
    });

    await waitFor(
      () => {
        expect(result.current.events).toEqual([
          expect.objectContaining({ eventId: 'live-reply' }),
        ]);
      },
      { timeout: 1200 }
    );

    await act(async () => {
      names.resolve({ Qauthor: 'Author' });
      await names.promise;
    });
    await waitFor(() => {
      expect(result.current.events).toEqual([
        expect.objectContaining({
          eventId: 'live-reply',
          senderName: 'Author',
        }),
      ]);
    });
  });

  it('replaces a pending event when local privileged validation succeeds', async () => {
    getMessageHistory.mockResolvedValue([
      {
        ...event('pending-mention', 'general', 450),
        privilegedMentionAuthorized: undefined,
      },
    ]);
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    act(() => {
      listeners[0]({
        event: {
          ...event('pending-mention', 'general', 450),
          privilegedMentionAuthorized: true,
        },
      });
    });

    await waitFor(
      () => {
        expect(result.current.events).toEqual([
          expect.objectContaining({
            eventId: 'pending-mention',
            privilegedMentionAuthorized: true,
          }),
        ]);
      },
      { timeout: 1200 }
    );
  });

  it('does not restore stale history after a silence change', async () => {
    const staleHistory = deferred<unknown[]>();
    getMessageHistory
      .mockReturnValueOnce(staleHistory.promise)
      .mockResolvedValueOnce([]);
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => expect(silenceListeners).toHaveLength(1));

    act(() => {
      silenceListeners[0]({
        ownerAddress: 'Qowner',
        targetAddress: 'Qauthor',
        scopeType: 'group',
        scopeId: '42',
        expiresAt: null,
        active: true,
      });
    });
    await waitFor(() => expect(getMessageHistory).toHaveBeenCalledTimes(2));

    await act(async () => {
      staleHistory.resolve([event('stale-hidden', 'general', 100)]);
      await staleHistory.promise;
    });

    expect(result.current.events).toEqual([]);
  });

  it('removes an already visible hidden-author message immediately', async () => {
    const refreshedHistory = deferred<unknown[]>();
    getMessageHistory
      .mockResolvedValueOnce([event('visible-before-hide', 'general', 100)])
      .mockReturnValueOnce(refreshedHistory.promise);
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => {
      expect(result.current.events).toEqual([
        expect.objectContaining({ eventId: 'visible-before-hide' }),
      ]);
    });

    act(() => {
      silenceListeners[0]({
        ownerAddress: 'Qowner',
        targetAddress: 'Qauthor',
        scopeType: 'group',
        scopeId: '42',
        expiresAt: null,
        active: true,
      });
    });

    expect(result.current.events).toEqual([]);
    expect(result.current.visibilityChange).toEqual({
      groupId: 42,
      targetAddress: 'Qauthor',
      active: true,
      revision: 1,
    });
    await act(async () => {
      refreshedHistory.resolve([]);
      await refreshedHistory.promise;
    });
  });

  it('opens an anchored window and paginates forward with that window cursor', async () => {
    const getMessageHistoryPage = vi.fn(
      async (
        _groupId: number,
        _channelId: string,
        _limit: number,
        options?: { afterTimestamp?: number; afterEventId?: string }
      ) =>
        options?.afterTimestamp
          ? {
              events: [event('after-page', 'general', 300)],
              oldestCursor: { eventId: 'after-page', timestamp: 300 },
              newestCursor: { eventId: 'after-page', timestamp: 300 },
              hasMore: false,
            }
          : {
              events: [event('latest', 'general', 500)],
              oldestCursor: { eventId: 'latest', timestamp: 500 },
              newestCursor: { eventId: 'latest', timestamp: 500 },
              hasMore: true,
            }
    );
    const getMessageWindowPageAroundEvent = vi.fn(async () => ({
      events: [
        event('around-before', 'general', 100),
        event('around-target', 'general', 110),
        event('around-after', 'general', 120),
      ],
      oldestCursor: { eventId: 'around-before', timestamp: 100 },
      newestCursor: { eventId: 'around-after', timestamp: 120 },
      hasOlder: true,
      hasNewer: true,
    }));
    Object.assign(window.reticulumChat as any, {
      getMessageHistoryPage,
      getMessageWindowPageAroundEvent,
    });

    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => expect(result.current.initialHistoryReady).toBe(true));

    await act(async () => {
      await result.current.openAroundEvent('around-target');
    });
    expect(result.current.historyMode).toBe('anchored');
    expect(result.current.hasOlder).toBe(true);
    expect(result.current.hasNewer).toBe(true);
    expect(result.current.events.map((item: any) => item.eventId)).toEqual([
      'around-before',
      'around-target',
      'around-after',
    ]);

    await act(async () => {
      await result.current.loadNewer();
    });
    expect(getMessageHistoryPage).toHaveBeenLastCalledWith(
      42,
      'general',
      100,
      expect.objectContaining({
        afterEventId: 'around-after',
        afterTimestamp: 120,
      })
    );
    expect(result.current.hasNewer).toBe(false);
    expect(result.current.historyMode).toBe('latest');
    expect(result.current.events.map((item: any) => item.eventId)).toEqual([
      'around-before',
      'around-target',
      'around-after',
      'after-page',
    ]);
  });

  it('keeps live root messages behind the newer boundary while applying visible reactions', async () => {
    Object.assign(window.reticulumChat as any, {
      getMessageWindowPageAroundEvent: vi.fn(async () => ({
        events: [event('around-target', 'general', 110)],
        oldestCursor: { eventId: 'around-target', timestamp: 110 },
        newestCursor: { eventId: 'around-target', timestamp: 110 },
        hasOlder: false,
        hasNewer: true,
      })),
    });
    getMessageHistory.mockResolvedValue([event('latest', 'general', 500)]);
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => expect(result.current.initialHistoryReady).toBe(true));
    await act(async () => {
      await result.current.openAroundEvent('around-target');
    });

    act(() => {
      listeners[0]({ event: event('older-root', 'general', 100) });
      listeners[0]({ event: event('live-root', 'general', 600) });
      listeners[0]({
        event: {
          ...event('visible-reaction', 'general', 601),
          eventType: 'reaction_add',
          targetEventId: 'around-target',
        },
      });
    });

    await waitFor(
      () => {
        expect(result.current.events.map((item: any) => item.eventId)).toEqual([
          'older-root',
          'around-target',
          'visible-reaction',
        ]);
      },
      { timeout: 1200 }
    );
    expect(result.current.hasOlder).toBe(true);
    expect(result.current.hasNewer).toBe(true);
  });

  it('ignores a stale search window when a newer search finishes first', async () => {
    getMessageHistory.mockResolvedValue([event('latest', 'general', 500)]);
    const firstWindow = deferred<any>();
    const secondWindow = deferred<any>();
    const getMessageWindowPageAroundEvent = vi
      .fn()
      .mockReturnValueOnce(firstWindow.promise)
      .mockReturnValueOnce(secondWindow.promise);
    Object.assign(window.reticulumChat as any, {
      getMessageWindowPageAroundEvent,
    });
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => expect(result.current.initialHistoryReady).toBe(true));

    let firstResult!: Promise<{ success: boolean }>;
    let secondResult!: Promise<{ success: boolean }>;
    act(() => {
      firstResult = result.current.openAroundEvent('first-target');
      secondResult = result.current.openAroundEvent('second-target');
    });
    await act(async () => {
      secondWindow.resolve({
        events: [event('second-target', 'general', 300)],
        oldestCursor: { eventId: 'second-target', timestamp: 300 },
        newestCursor: { eventId: 'second-target', timestamp: 300 },
        hasOlder: true,
        hasNewer: true,
      });
      await secondResult;
      firstWindow.resolve({
        events: [event('first-target', 'general', 200)],
        oldestCursor: { eventId: 'first-target', timestamp: 200 },
        newestCursor: { eventId: 'first-target', timestamp: 200 },
        hasOlder: true,
        hasNewer: true,
      });
      await firstResult;
    });

    await expect(firstResult).resolves.toEqual({ success: false });
    await expect(secondResult).resolves.toEqual({ success: true });
    expect(result.current.events.map((item: any) => item.eventId)).toEqual([
      'second-target',
    ]);
  });

  it('jumps directly from anchored history to the latest page', async () => {
    const getMessageHistoryPage = vi.fn(async () => ({
      events: [
        event('latest-1', 'general', 500),
        event('latest-2', 'general', 600),
      ],
      oldestCursor: { eventId: 'latest-1', timestamp: 500 },
      newestCursor: { eventId: 'latest-2', timestamp: 600 },
      hasMore: true,
    }));
    Object.assign(window.reticulumChat as any, {
      getMessageHistoryPage,
      getMessageWindowPageAroundEvent: vi.fn(async () => ({
        events: [event('around-target', 'general', 110)],
        oldestCursor: { eventId: 'around-target', timestamp: 110 },
        newestCursor: { eventId: 'around-target', timestamp: 110 },
        hasOlder: true,
        hasNewer: true,
      })),
    });
    const { result } = renderHook(() => useReticulumGroupChat(42, 'general'));
    await waitFor(() => expect(result.current.initialHistoryReady).toBe(true));
    await act(async () => {
      await result.current.openAroundEvent('around-target');
      await result.current.jumpToLatest();
    });

    expect(result.current.historyMode).toBe('latest');
    expect(result.current.hasNewer).toBe(false);
    expect(result.current.events.map((item: any) => item.eventId)).toEqual([
      'latest-1',
      'latest-2',
    ]);
  });
});
