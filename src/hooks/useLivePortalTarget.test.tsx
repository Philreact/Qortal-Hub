import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useLivePortalTarget } from './useLivePortalTarget';

describe('useLivePortalTarget', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('finds a host that mounts after the hook', async () => {
    const { result } = renderHook(() => useLivePortalTarget('call-slot'));
    expect(result.current).toBeNull();

    const host = document.createElement('div');
    host.id = 'call-slot';
    await act(async () => {
      document.body.append(host);
      await Promise.resolve();
    });

    expect(result.current).toBe(host);
  });

  it('moves to a replacement host after the navbar remounts', async () => {
    const firstHost = document.createElement('div');
    firstHost.id = 'call-slot';
    document.body.append(firstHost);

    const { result } = renderHook(() => useLivePortalTarget('call-slot'));
    expect(result.current).toBe(firstHost);

    const replacementHost = document.createElement('div');
    replacementHost.id = 'call-slot';
    await act(async () => {
      firstHost.replaceWith(replacementHost);
      await Promise.resolve();
    });

    expect(result.current).toBe(replacementHost);
  });
});
