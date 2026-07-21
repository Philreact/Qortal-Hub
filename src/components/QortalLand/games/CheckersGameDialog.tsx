import SportsEsportsRoundedIcon from '@mui/icons-material/SportsEsportsRounded';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography,
  alpha,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import {
  checkersPieceSeat,
  getCheckersLegalMoves,
  isCheckersKing,
  type CheckersMove,
  type CheckersOutcome,
  type CheckersPiece,
  type CheckersState,
} from './checkers';
import { GameSessionChat } from './GameSessionChat';
import type { QortalLandGameMatchView } from './useQortalLandGame';

type Props = {
  address: string;
  match: QortalLandGameMatchView | null;
  now: number;
  transportReady: boolean;
  onClose: () => void;
  onPlayMove: (from: number, path: number[]) => Promise<boolean>;
  onRematch: () => void;
  onResign: () => void;
  onRespond: (accepted: boolean) => void;
  onSendChat: (text: string) => boolean;
  onTyping: (active: boolean) => void;
  resolvePlayerName?: (address: string) => string;
};

const shortAddress = (value: string) => value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;

const outcomeText = (outcome: CheckersOutcome | undefined, localSeat?: 1 | 2) => {
  if (!outcome) return 'Game ended';
  if (outcome.type === 'draw') return 'Draw game';
  if (outcome.type === 'abandoned') return 'Game abandoned';
  if (outcome.type === 'protocol-error') return 'Game ended safely';
  return outcome.winner === localSeat ? 'You won!' : 'You lost';
};

export function CheckersGameDialog({
  address, match, now, transportReady, onClose, onPlayMove, onRematch,
  onResign, onRespond, onSendChat, onTyping, resolvePlayerName,
}: Props) {
  const [selectedFrom, setSelectedFrom] = useState<number | null>(null);
  const [selectedPath, setSelectedPath] = useState<number[]>([]);
  const [selectionHint, setSelectionHint] = useState('');
  const state = match?.state as CheckersState | undefined;
  const localSeat = match?.localSeat;
  const opponentAddress = match
    ? match.requesterAddress === address ? match.recipientAddress : match.requesterAddress
    : '';
  const opponentName = opponentAddress
    ? resolvePlayerName?.(opponentAddress) || (match?.requesterAddress === opponentAddress ? match.requesterName : match?.recipientName) || shortAddress(opponentAddress)
    : '';
  const localTurn = Boolean(match?.phase === 'active' && state && localSeat && state.nextSeat === localSeat && !match.pendingMoveId);
  const legalMoves = useMemo(
    () => state && localSeat && localTurn ? getCheckersLegalMoves(state, localSeat) : [],
    [localSeat, localTurn, state]
  );
  const movablePieces = useMemo(() => new Set(legalMoves.map((move) => move.from)), [legalMoves]);
  const candidates = selectedFrom === null ? [] : legalMoves.filter((move) => (
    move.from === selectedFrom && selectedPath.every((square, index) => move.path[index] === square)
  ));
  const nextSquares = new Set(candidates.map((move) => move.path[selectedPath.length]).filter((value) => value !== undefined));
  const capturedSquares = useMemo(() => {
    if (selectedFrom === null || !selectedPath.length) return new Set<number>();
    const result = new Set<number>();
    let from = selectedFrom;
    selectedPath.forEach((to) => {
      if (Math.abs(Math.floor(to / 8) - Math.floor(from / 8)) === 2) result.add((from + to) / 2);
      from = to;
    });
    return result;
  }, [selectedFrom, selectedPath]);
  const previewPosition = selectedPath.at(-1);
  const previewPiece = useMemo<CheckersPiece>(() => {
    if (selectedFrom === null || previewPosition === undefined || !state) return 0;
    const piece = state.board[selectedFrom];
    if (piece === 1 && Math.floor(previewPosition / 8) === 0) return 3;
    if (piece === 2 && Math.floor(previewPosition / 8) === 7) return 4;
    return piece;
  }, [previewPosition, selectedFrom, state]);

  useEffect(() => {
    setSelectedFrom(null);
    setSelectedPath([]);
    setSelectionHint('');
  }, [state?.ply, localTurn]);

  if (!match) return null;
  const expiresIn = Math.max(0, Math.ceil(((match.expiresAt || now) - now) / 1000));
  const reconnectIn = Math.max(0, Math.ceil(((match.reconnectDeadline || now) - now) / 1000));
  const canShowBoard = Boolean(state && ['active', 'finishing', 'reconnecting', 'finished'].includes(match.phase));
  const canShowChat = Boolean(state || ['round-waiting', 'round-incoming'].includes(match.phase) || (match.phase === 'finished' && match.roundId !== match.matchId));
  const hasCapture = legalMoves.some((move) => move.captured.length > 0);
  const displayIndexes = localSeat === 2
    ? Array.from({ length: 64 }, (_, index) => 63 - index)
    : Array.from({ length: 64 }, (_, index) => index);

  const selectSquare = async (index: number) => {
    if (!localTurn || !state || !localSeat) return;
    const ownPiece = checkersPieceSeat(state.board[index]) === localSeat;
    if (selectedPath.length === 0 && ownPiece) {
      if (index === selectedFrom) {
        setSelectedFrom(null);
        setSelectionHint('');
      } else if (movablePieces.has(index)) {
        setSelectedFrom(index);
        setSelectionHint('');
      } else {
        setSelectionHint(hasCapture ? 'A highlighted piece must make the available capture.' : 'That piece has no legal move right now.');
      }
      return;
    }
    if (!nextSquares.has(index)) {
      setSelectedFrom(movablePieces.has(index) ? index : null);
      setSelectedPath([]);
      setSelectionHint('');
      return;
    }
    const path = [...selectedPath, index];
    const matching = candidates.filter((move) => move.path[path.length - 1] === index);
    const complete = matching.find((move) => move.path.length === path.length);
    const continues = matching.some((move) => move.path.length > path.length);
    if (complete && !continues) {
      setSelectedFrom(null);
      setSelectedPath([]);
      setSelectionHint('');
      await onPlayMove(selectedFrom, path);
    } else {
      setSelectedPath(path);
    }
  };

  return (
    <Dialog
      open={match.phase !== 'session-idle'}
      disableEscapeKeyDown={match.phase !== 'finished'}
      onClose={(_, reason) => { if (reason !== 'backdropClick' && match.phase === 'finished') onClose(); }}
      maxWidth={false}
      PaperProps={{ sx: {
        background: 'linear-gradient(145deg, #0d1b30 0%, #070d1b 100%)',
        border: `1px solid ${alpha('#2cf8ff', 0.32)}`,
        color: '#f8fbff',
        display: 'flex',
        height: canShowBoard ? 'min(900px, calc(100dvh - 28px))' : 'auto',
        maxHeight: 'calc(100dvh - 28px)',
        width: canShowBoard ? 'min(1180px, calc(100vw - 28px))' : 'min(600px, calc(100vw - 28px))',
      } }}
    >
      <DialogTitle sx={{ alignItems: 'center', display: 'flex', gap: 1, pb: 1 }}>
        <SportsEsportsRoundedIcon sx={{ color: '#2cf8ff' }} />
        <Box>
          <Typography sx={{ fontSize: 18, fontWeight: 850 }}>Checkers</Typography>
          {state && <Typography sx={{ color: alpha('#fff', 0.5), fontSize: 10 }}>Casual private match · {state.ply} moves</Typography>}
        </Box>
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', flex: 1, gap: 2, gridTemplateColumns: canShowChat ? { xs: '1fr', md: 'minmax(430px, 1fr) 300px' } : '1fr', minHeight: 0, overflow: { xs: 'auto', md: 'hidden' } }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {match.error && <Alert severity="warning" sx={{ mb: 1 }}>{match.error}</Alert>}
          {match.phase === 'opening' && <><Typography>Establishing private link…</Typography><LinearProgress sx={{ mt: 2 }} /></>}
          {match.phase === 'waiting' && <><Typography>Waiting for {opponentName || 'the other player'} to respond…</Typography><LinearProgress sx={{ mt: 2 }} /></>}
          {match.phase === 'round-waiting' && <><Typography>Waiting for {opponentName} to accept Checkers…</Typography><LinearProgress sx={{ mt: 2 }} /></>}
          {(match.phase === 'incoming' || match.phase === 'round-incoming') && (
            <Stack spacing={1.5}>
              <Typography sx={{ fontWeight: 800 }}>{match.phase === 'round-incoming' ? `${opponentName} would like to play Checkers.` : `${resolvePlayerName?.(match.requesterAddress) || match.requesterName || shortAddress(match.requesterAddress)} invited you to Checkers.`}</Typography>
              {match.phase === 'incoming' && <Typography sx={{ color: alpha('#fff', 0.6), fontSize: 13 }}>Invitation expires in {expiresIn}s</Typography>}
            </Stack>
          )}
          {match.phase === 'starting' && <><Typography>Starting Checkers…</Typography><LinearProgress sx={{ mt: 2 }} /></>}
          {canShowBoard && state && (
            <Box sx={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
              <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.75, minHeight: 24 }}>
                <Typography sx={{ fontWeight: 850 }}>
                  {match.phase === 'finished' ? outcomeText(match.outcome as CheckersOutcome, localSeat) : match.phase === 'reconnecting' ? `Reconnecting (${reconnectIn}s)` : localTurn ? 'Your turn' : `${opponentName}'s turn`}
                </Typography>
                <Typography aria-live="polite" sx={{ color: selectionHint || hasCapture ? '#ffd24f' : alpha('#fff', 0.55), fontSize: 12 }}>
                  {selectionHint || (hasCapture ? 'Capture required' : match.pendingMoveId ? 'Confirming move…' : selectedFrom !== null ? 'Choose a highlighted square or another piece' : 'Select a piece')}
                </Typography>
              </Stack>
              <Box sx={{ mb: 0.75, minHeight: 42 }}>
                {match.phase === 'reconnecting' ? (
                  <Alert severity="warning" sx={{ py: 0 }}>Connection interrupted. The board is paused while the private link recovers.</Alert>
                ) : (
                  <Stack direction="row" justifyContent="space-between" sx={{ color: alpha('#fff', 0.55), fontSize: 11, pt: 0.5 }}>
                    <span>You · {localSeat === 1 ? 'Gold' : 'Coral'}</span>
                    <span>{opponentName} · {localSeat === 1 ? 'Coral' : 'Gold'}</span>
                  </Stack>
                )}
              </Box>
              <Box
                aria-label="Checkers board"
                role="grid"
                sx={{
                  alignSelf: 'center', aspectRatio: '1', display: 'grid', flex: '0 1 auto',
                  gridTemplateColumns: 'repeat(8, 1fr)', maxWidth: 720,
                  width: { xs: 'min(100%, calc(100dvh - 230px))', md: 'min(100%, calc(100dvh - 190px))' },
                }}
              >
                {displayIndexes.map((index, displayIndex) => {
                  const piece = index === previewPosition
                    ? previewPiece
                    : index === selectedFrom && selectedPath.length > 0
                      ? 0
                      : state.board[index];
                  const dark = (Math.floor(index / 8) + index % 8) % 2 === 1;
                  const selected = index === selectedFrom || selectedPath.includes(index);
                  const destination = nextSquares.has(index);
                  const movable = movablePieces.has(index);
                  const seat = checkersPieceSeat(piece);
                  const ownPiece = seat === localSeat;
                  return (
                    <Box
                      component="button"
                      type="button"
                      role="gridcell"
                      aria-selected={selected}
                      aria-label={`Row ${Math.floor(displayIndex / 8) + 1}, column ${displayIndex % 8 + 1}${piece ? `, ${seat === localSeat ? 'your' : 'opponent'} ${isCheckersKing(piece) ? 'king' : 'piece'}` : ', empty'}`}
                      disabled={!dark || !localTurn || (!ownPiece && !destination)}
                      key={index}
                      onClick={() => void selectSquare(index)}
                      sx={{
                        alignItems: 'center', background: dark ? '#6e4429' : '#e6c495', border: 0, cursor: movable || destination ? 'pointer' : 'default',
                        display: 'flex', justifyContent: 'center', minHeight: 0, padding: '7%', position: 'relative',
                        ...(selected ? { boxShadow: 'inset 0 0 0 4px #2cf8ff' } : {}),
                        ...(destination ? { '&::after': { background: alpha('#2cf8ff', 0.7), borderRadius: '50%', content: '""', height: '24%', position: 'absolute', width: '24%' } } : {}),
                      }}
                    >
                      {piece !== 0 && !capturedSquares.has(index) && (
                        <Box sx={{
                          alignItems: 'center', background: seat === 1 ? 'radial-gradient(circle at 35% 30%, #ffe989, #eab72f)' : 'radial-gradient(circle at 35% 30%, #ff8198, #d93659)',
                          border: `3px solid ${seat === 1 ? '#fff1a8' : '#ff9caf'}`, borderRadius: '50%', boxShadow: `0 4px 8px ${alpha('#000', 0.45)}`,
                          color: '#4b2b12', display: 'flex', fontSize: 'clamp(12px, 2vw, 26px)', fontWeight: 900, height: '84%', justifyContent: 'center', width: '84%',
                          ...(movable ? { outline: `2px solid ${alpha('#2cf8ff', 0.8)}`, outlineOffset: 2 } : {}),
                        }}>{isCheckersKing(piece) ? '♛' : ''}</Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
              <Typography sx={{ color: alpha('#fff', 0.45), fontSize: 10, mt: 1, minHeight: 16, textAlign: 'center' }}>Captures are mandatory. Complete every available jump in the chain.</Typography>
            </Box>
          )}
          {match.phase === 'finished' && !state && <Typography>{match.error || 'The Checkers invitation ended.'}</Typography>}
        </Box>
        {canShowChat && (
          <GameSessionChat address={address} disabled={!transportReady || match.phase === 'reconnecting' || match.sessionClosed === true} messages={match.chatMessages} opponentName={opponentName} remoteTyping={Boolean(match.remoteTypingUntil && match.remoteTypingUntil > now)} onSend={onSendChat} onTyping={onTyping} />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {(match.phase === 'incoming' || match.phase === 'round-incoming') && <><Button onClick={() => onRespond(false)}>Decline</Button><Button variant="contained" onClick={() => onRespond(true)}>Accept</Button></>}
        {['opening', 'waiting', 'round-waiting'].includes(match.phase) && <Button onClick={onClose}>Cancel</Button>}
        {match.phase === 'active' && <Button color="error" onClick={onResign}>Resign</Button>}
        {match.phase === 'finished' && <><Button onClick={onClose}>Close</Button>{state && !match.sessionClosed && <Button variant="contained" onClick={onRematch}>Play again</Button>}</>}
      </DialogActions>
    </Dialog>
  );
}
