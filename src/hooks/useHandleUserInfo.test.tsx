import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHandleUserInfo } from './useHandleUserInfo';

vi.mock('../App', () => ({
  getBaseApiReact: () => 'http://localhost:12391',
}));

describe('useHandleUserInfo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares an in-flight account lookup and then serves the cached level', async () => {
    let resolveResponse: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useHandleUserInfo());

    let first: Promise<unknown>;
    let second: Promise<unknown>;
    act(() => {
      first = result.current('Qauthor');
      second = result.current('Qauthor');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse?.({
      ok: true,
      json: async () => ({ level: 7 }),
    } as Response);

    await expect(first!).resolves.toBe(7);
    await expect(second!).resolves.toBe(7);
    await expect(result.current('Qauthor')).resolves.toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
