import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createConnectFourState, type ConnectFourState } from './connectFour';
import {
  ConnectFourGameDialog,
  type ConnectFourGameView,
} from './ConnectFourGameDialog';

const address = 'Qlocal1111111111111111111111111111111';
const opponent = 'Qremote111111111111111111111111111111';

const match = (state: ConnectFourState = createConnectFourState(1)): ConnectFourGameView => ({
  matchId: '00112233-4455-6677-8899-aabbccddeeff',
  requesterAddress: address,
  recipientAddress: opponent,
  requesterNonce: '11'.repeat(16),
  recipientNonce: '22'.repeat(16),
  requesterName: 'You',
  recipientName: 'Rival',
  phase: 'active',
  localSeat: 1,
  startingSeat: 1,
  state,
  stateHash: 'aa'.repeat(32),
  moves: [],
});

const renderGame = (
  current: ConnectFourGameView,
  overrides: Partial<React.ComponentProps<typeof ConnectFourGameDialog>> = {}
) => {
  const onPlayColumn = vi.fn(async () => true);
  const props: React.ComponentProps<typeof ConnectFourGameDialog> = {
    address,
    match: current,
    now: Date.now(),
    transportReady: true,
    onClose: vi.fn(),
    onPlayColumn,
    onRematch: vi.fn(),
    onResign: vi.fn(),
    onRespond: vi.fn(),
    ...overrides,
  };
  render(<ConnectFourGameDialog {...props} />);
  return { ...props, onPlayColumn };
};

describe('Connect Four game dialog', () => {
  it('offers keyboard-accessible columns and submits the selected column', async () => {
    const { onPlayColumn } = renderGame(match());
    const column = screen.getByRole('button', { name: 'Play column 4, 6 spaces available' });

    fireEvent.focus(column);
    fireEvent.click(column);

    await waitFor(() => expect(onPlayColumn).toHaveBeenCalledWith(3));
    expect(screen.getByText('Your turn')).toBeTruthy();
    expect(screen.getByRole('grid', { name: 'Connect Four board' })).toBeTruthy();
  });

  it('does not submit a full column', () => {
    const state = createConnectFourState(1);
    for (let row = 0; row < 6; row += 1) state.board[row * 7] = row % 2 === 0 ? 1 : 2;
    const { onPlayColumn } = renderGame(match(state));

    fireEvent.click(screen.getByRole('button', { name: 'Play column 1, 0 spaces available' }));

    expect(onPlayColumn).not.toHaveBeenCalled();
  });

  it('keeps the board visible and paused while reconnecting', () => {
    renderGame({
      ...match(),
      phase: 'reconnecting',
      reconnectDeadline: Date.now() + 18_000,
    });

    expect(screen.getByText('Game paused')).toBeTruthy();
    expect(screen.getByText(/Connection interrupted — reconnecting/)).toBeTruthy();
    expect(screen.getByRole('grid', { name: 'Connect Four board' })).toBeTruthy();
  });

  it('shows the final summary and requires a fresh accepted rematch', () => {
    const onRematch = vi.fn();
    const finished = match({
      ...createConnectFourState(2),
      ply: 7,
      outcome: { type: 'win', winner: 1 },
    });
    renderGame({ ...finished, phase: 'finished', outcome: finished.state?.outcome || undefined }, { onRematch });

    expect(screen.getAllByText('You won!').length).toBeGreaterThan(0);
    expect(screen.getByText(/7 moves against Rival/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Play again/i }));
    expect(onRematch).toHaveBeenCalledOnce();
  });
});
