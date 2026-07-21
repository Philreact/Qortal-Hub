import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createChessState, type ChessState } from './chess';
import { ChessGameDialog } from './ChessGameDialog';
import type { QortalLandGameMatchView } from './useQortalLandGame';

const matchWith = (state: ChessState): QortalLandGameMatchView => ({
  game: 'chess', matchId: crypto.randomUUID(), roundId: crypto.randomUUID(),
  requesterAddress: 'Q-local', recipientAddress: 'Q-remote', requesterNonce: '11'.repeat(16),
  phase: 'active', localSeat: 1, startingSeat: state.whiteSeat, state, stateHash: '00'.repeat(32),
  moves: [], chatMessages: [],
});

const renderGame = (state = createChessState(1), onPlayMove = vi.fn().mockResolvedValue(true)) => {
  render(<ChessGameDialog address="Q-local" match={matchWith(state)} now={Date.now()} transportReady onClose={vi.fn()} onPlayMove={onPlayMove} onRematch={vi.fn()} onResign={vi.fn()} onRespond={vi.fn()} onSendChat={() => true} onTyping={vi.fn()} resolvePlayerName={() => 'Opponent'} />);
  return onPlayMove;
};

describe('Chess game dialog', () => {
  it('renders an accessible board and submits a legal move', async () => {
    const play = renderGame();
    expect(screen.getAllByRole('gridcell')).toHaveLength(64);
    fireEvent.click(screen.getByRole('gridcell', { name: /Row 7, column 5, your pawn/i }));
    fireEvent.click(screen.getByRole('gridcell', { name: /Row 5, column 5, empty/i }));
    await waitFor(() => expect(play).toHaveBeenCalledWith(52, 36));
  });

  it('allows switching to another movable piece', async () => {
    const play = renderGame();
    fireEvent.click(screen.getByRole('gridcell', { name: /Row 7, column 5, your pawn/i }));
    fireEvent.click(screen.getByRole('gridcell', { name: /Row 7, column 4, your pawn/i }));
    fireEvent.click(screen.getByRole('gridcell', { name: /Row 6, column 4, empty/i }));
    await waitFor(() => expect(play).toHaveBeenCalledWith(51, 43));
  });

  it('asks which piece to use for promotion', async () => {
    const state: ChessState = { board: Array(64).fill(0), nextSeat: 1, whiteSeat: 1, ply: 0, halfmoveClock: 0, castlingRights: [false, false, false, false], enPassant: null, outcome: null };
    state.board[60] = 6;
    state.board[7] = -6;
    state.board[8] = 1;
    const play = renderGame(state);
    fireEvent.click(screen.getByRole('gridcell', { name: /Row 2, column 1, your pawn/i }));
    fireEvent.click(screen.getByRole('gridcell', { name: /Row 1, column 1, empty/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Promote to queen' }));
    await waitFor(() => expect(play).toHaveBeenCalledWith(8, 0, 5));
  });
});
