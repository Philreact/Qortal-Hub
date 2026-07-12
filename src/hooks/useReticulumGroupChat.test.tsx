import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReticulumGroupChat } from './useReticulumGroupChat';

vi.mock('../components/Group/groupApi', () => ({
  getPrimaryNamesForAddresses: vi.fn(async () => ({})),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
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
  let getMessageHistory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listeners = [];
    getMessageHistory = vi.fn();
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
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not merge an older page after switching channels', async () => {
    const olderPage = deferred<unknown[]>();
    getMessageHistory.mockImplementation(
      (_groupId: number, channelId: string, _limit: number, options?: object) => {
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
});
