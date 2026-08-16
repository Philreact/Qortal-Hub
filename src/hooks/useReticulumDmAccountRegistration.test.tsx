import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveReticulumDmAccountAddresses,
  useReticulumDmAccountRegistration,
} from './useReticulumDmAccountRegistration';

describe('useReticulumDmAccountRegistration', () => {
  it('only registers a loaded wallet address while Reticulum Chat is enabled', () => {
    expect(
      resolveReticulumDmAccountAddresses({
        enabled: true,
        address: ' Qowner ',
      })
    ).toEqual(['Qowner']);
    expect(
      resolveReticulumDmAccountAddresses({
        enabled: true,
        address: '',
      })
    ).toEqual([]);
    expect(
      resolveReticulumDmAccountAddresses({
        enabled: false,
        address: 'Qowner',
      })
    ).toEqual([]);
  });

  it('keeps registration independent of chat-screen mounting', async () => {
    const register = vi.fn(async () => ({ success: true }));
    const { unmount } = renderHook(() =>
      useReticulumDmAccountRegistration({
        enabled: true,
        address: 'Qowner',
        register,
      })
    );

    await waitFor(() => expect(register).toHaveBeenCalledWith(['Qowner']));
    unmount();
    expect(register).not.toHaveBeenCalledWith([]);
  });

  it('does not let a secondary window replace main-window registration', async () => {
    const register = vi.fn(async () => ({ success: true }));
    renderHook(() =>
      useReticulumDmAccountRegistration({
        managed: false,
        enabled: true,
        address: '',
        register,
      })
    );

    await act(async () => Promise.resolve());
    expect(register).not.toHaveBeenCalled();
  });

  it('serializes account changes so stale registration cannot win', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const register = vi
      .fn<ReticulumDmAddressRegistrar>()
      .mockImplementationOnce(async () => {
        await firstPending;
        return { success: true };
      })
      .mockResolvedValue({ success: true });

    const { rerender } = renderHook(
      ({ address }) =>
        useReticulumDmAccountRegistration({
          enabled: true,
          address,
          register,
        }),
      { initialProps: { address: 'Qfirst' } }
    );

    await waitFor(() => expect(register).toHaveBeenCalledWith(['Qfirst']));
    rerender({ address: 'Qsecond' });
    await act(async () => releaseFirst?.());
    await waitFor(() => expect(register).toHaveBeenCalledWith(['Qsecond']));
    expect(register.mock.calls).toEqual([[['Qfirst']], [['Qsecond']]]);
  });

  it('clears registration when Reticulum is disabled', async () => {
    const register = vi.fn(async () => ({ success: true }));
    const { rerender } = renderHook(
      ({ enabled }) =>
        useReticulumDmAccountRegistration({
          enabled,
          address: 'Qowner',
          register,
        }),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(register).toHaveBeenCalledWith(['Qowner']));
    rerender({ enabled: false });
    await waitFor(() => expect(register).toHaveBeenCalledWith([]));
  });

  it('reapplies the current account when the manager becomes ready', async () => {
    const register = vi
      .fn<ReticulumDmAddressRegistrar>()
      .mockResolvedValueOnce({
        success: false,
        error: 'Reticulum chat manager is not running',
      })
      .mockResolvedValue({ success: true });
    let readinessListener:
      | ((status: {
          state: 'idle' | 'starting' | 'ready' | 'failed';
          revision: number;
        }) => void)
      | undefined;
    const onReadinessChanged = vi.fn((listener) => {
      readinessListener = listener;
      return vi.fn();
    });

    renderHook(() =>
      useReticulumDmAccountRegistration({
        enabled: true,
        address: 'Qowner',
        register,
        onReadinessChanged,
      })
    );

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    act(() => readinessListener?.({ state: 'ready', revision: 2 }));
    await waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    expect(register).toHaveBeenLastCalledWith(['Qowner']);
  });
});

type ReticulumDmAddressRegistrar = (
  addresses: string[]
) => Promise<{ success: boolean; error?: string }>;
