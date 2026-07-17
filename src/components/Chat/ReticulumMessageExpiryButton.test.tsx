import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TIME_DAYS_1_IN_MILLISECONDS } from '../../constants/constants';
import { ReticulumMessageExpiryButton } from './ReticulumMessageExpiryButton';

describe('ReticulumMessageExpiryButton', () => {
  it('selects an explicit expiry when the channel permits it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ReticulumMessageExpiryButton
        channelExpiryDurationMs={2 * TIME_DAYS_1_IN_MILLISECONDS}
        onChange={onChange}
      />
    );

    await user.click(
      screen.getByRole('button', { name: 'Set message expiry' })
    );
    await user.click(screen.getByRole('menuitem', { name: /^24 hours$/ }));

    expect(onChange).toHaveBeenCalledWith(TIME_DAYS_1_IN_MILLISECONDS);
  });

  it('disables choices longer than the channel maximum', async () => {
    const user = userEvent.setup();
    render(
      <ReticulumMessageExpiryButton
        channelExpiryDurationMs={2 * TIME_DAYS_1_IN_MILLISECONDS}
        onChange={() => undefined}
      />
    );

    await user.click(
      screen.getByRole('button', { name: 'Set message expiry' })
    );

    expect(screen.getByRole('menuitem', { name: /^24 hours$/ })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /^48 hours$/ })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /72 hours/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByRole('menuitem', { name: /1 week/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });

  it('does not open while expiry changes are disabled', () => {
    render(
      <ReticulumMessageExpiryButton
        disabled
        disabledReason="Expiry cannot be changed while editing"
        onChange={() => undefined}
      />
    );

    const button = screen.getByRole('button', { name: 'Set message expiry' });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
