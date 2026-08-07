import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AuthenticatedLockScreen } from './AuthenticatedLockScreen';

describe('AuthenticatedLockScreen', () => {
  it('keeps keyboard focus inside the lock screen', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>Underlying action</button>
        <AuthenticatedLockScreen onUnlock={vi.fn()} />
      </>
    );

    const passwordInput = screen.getByLabelText('Qortal account password');
    const unlockButton = screen.getByRole('button', { name: 'Unlock' });
    await waitFor(() => expect(passwordInput).toHaveFocus());

    await user.type(passwordInput, 'password');
    await user.tab();
    expect(unlockButton).toHaveFocus();
    await user.tab();
    expect(passwordInput).toHaveFocus();
    expect(screen.getByText('Underlying action')).not.toHaveFocus();
  });

  it('clears a rejected password and reports the failure', async () => {
    const onUnlock = vi.fn().mockRejectedValue(new Error('incorrect'));
    render(<AuthenticatedLockScreen onUnlock={onUnlock} />);

    const passwordInput = screen.getByLabelText('Qortal account password');
    await userEvent.type(passwordInput, 'wrong password');
    fireEvent.submit(passwordInput.closest('form')!);

    await waitFor(() =>
      expect(onUnlock).toHaveBeenCalledWith('wrong password')
    );
    await waitFor(() => expect(passwordInput).toHaveValue(''));
    expect(
      screen.getByText('That password is not correct. Please try again.')
    ).toBeVisible();
  });

  it('does not start duplicate password checks', async () => {
    let finishUnlock: (() => void) | undefined;
    const onUnlock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishUnlock = resolve;
        })
    );
    render(<AuthenticatedLockScreen onUnlock={onUnlock} />);

    const passwordInput = screen.getByLabelText('Qortal account password');
    fireEvent.change(passwordInput, { target: { value: 'password' } });
    const form = passwordInput.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onUnlock).toHaveBeenCalledTimes(1);
    await act(async () => finishUnlock?.());
  });
});
