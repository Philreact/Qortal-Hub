import SportsEsportsRoundedIcon from '@mui/icons-material/SportsEsportsRounded';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack, Typography, alpha } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import {
  chessPieceKind,
  chessPieceSeat,
  getChessLegalMoves,
  isChessInCheck,
  type ChessOutcome,
  type ChessPiece,
  type ChessPromotion,
  type ChessState,
} from './chess';
import { GameSessionChat } from './GameSessionChat';
import type { QortalLandGameMatchView } from './useQortalLandGame';

type Props = {
  address: string;
  match: QortalLandGameMatchView | null;
  now: number;
  transportReady: boolean;
  onClose: () => void;
  onPlayMove: (from: number, to: number, promotion?: ChessPromotion) => Promise<boolean>;
  onRematch: () => void;
  onResign: () => void;
  onRespond: (accepted: boolean) => void;
  onSendChat: (text: string) => boolean;
  onTyping: (active: boolean) => void;
  resolvePlayerName?: (address: string) => string;
};

const PIECES: Record<string, string> = {
  white1: '♙', white2: '♘', white3: '♗', white4: '♖', white5: '♕', white6: '♔',
  black1: '♟', black2: '♞', black3: '♝', black4: '♜', black5: '♛', black6: '♚',
};
const shortAddress = (value: string) => value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
const outcomeText = (outcome: ChessOutcome | undefined, localSeat?: 1 | 2) => {
  if (!outcome) return 'Game ended';
  if (outcome.type === 'draw') return 'Draw game';
  if (outcome.type === 'abandoned') return 'Game abandoned';
  if (outcome.type === 'protocol-error') return 'Game ended safely';
  return outcome.winner === localSeat ? 'You won!' : 'You lost';
};
const pieceSymbol = (state: ChessState, piece: ChessPiece) => {
  const seat = chessPieceSeat(piece);
  if (!seat) return '';
  return PIECES[`${seat === state.whiteSeat ? 'white' : 'black'}${chessPieceKind(piece)}`];
};

export function ChessGameDialog({
  address, match, now, transportReady, onClose, onPlayMove, onRematch,
  onResign, onRespond, onSendChat, onTyping, resolvePlayerName,
}: Props) {
  const [selectedFrom, setSelectedFrom] = useState<number | null>(null);
  const [selectionHint, setSelectionHint] = useState('');
  const [promotion, setPromotion] = useState<{ from: number; to: number; options: ChessPromotion[] } | null>(null);
  const state = match?.state as ChessState | undefined;
  const localSeat = match?.localSeat;
  const opponentAddress = match ? match.requesterAddress === address ? match.recipientAddress : match.requesterAddress : '';
  const opponentName = opponentAddress
    ? resolvePlayerName?.(opponentAddress) || (match?.requesterAddress === opponentAddress ? match.requesterName : match?.recipientName) || shortAddress(opponentAddress)
    : '';
  const localTurn = Boolean(match?.phase === 'active' && state && localSeat && state.nextSeat === localSeat && !match.pendingMoveId);
  const legalMoves = useMemo(() => state && localSeat && localTurn ? getChessLegalMoves(state, localSeat) : [], [localSeat, localTurn, state]);
  const movablePieces = useMemo(() => new Set(legalMoves.map((move) => move.from)), [legalMoves]);
  const selectedMoves = selectedFrom === null ? [] : legalMoves.filter((move) => move.from === selectedFrom);
  const destinations = new Set(selectedMoves.map((move) => move.to));

  useEffect(() => {
    setSelectedFrom(null);
    setSelectionHint('');
    setPromotion(null);
  }, [state?.ply, localTurn]);

  if (!match) return null;
  const expiresIn = Math.max(0, Math.ceil(((match.expiresAt || now) - now) / 1000));
  const reconnectIn = Math.max(0, Math.ceil(((match.reconnectDeadline || now) - now) / 1000));
  const canShowBoard = Boolean(state && ['active', 'finishing', 'reconnecting', 'finished'].includes(match.phase));
  const canShowChat = Boolean(state || ['round-waiting', 'round-incoming'].includes(match.phase) || (match.phase === 'finished' && match.roundId !== match.matchId));
  const localIsWhite = Boolean(state && localSeat === state.whiteSeat);
  const displayIndexes = localIsWhite ? Array.from({ length: 64 }, (_, index) => index) : Array.from({ length: 64 }, (_, index) => 63 - index);
  const checkedSeat = state && isChessInCheck(state, state.nextSeat) ? state.nextSeat : null;

  const selectSquare = async (index: number) => {
    if (!localTurn || !state || !localSeat || promotion) return;
    const ownPiece = chessPieceSeat(state.board[index]) === localSeat;
    if (ownPiece) {
      if (index === selectedFrom) {
        setSelectedFrom(null);
        setSelectionHint('');
      } else if (movablePieces.has(index)) {
        setSelectedFrom(index);
        setSelectionHint('');
      } else {
        setSelectionHint('That piece has no legal move. It may be blocked or protecting your king.');
      }
      return;
    }
    if (selectedFrom === null || !destinations.has(index)) {
      setSelectedFrom(null);
      setSelectionHint('');
      return;
    }
    const candidates = selectedMoves.filter((move) => move.to === index);
    const promotions = candidates.flatMap((move) => move.promotion ? [move.promotion] : []);
    if (promotions.length) {
      setPromotion({ from: selectedFrom, to: index, options: promotions });
      return;
    }
    setSelectedFrom(null);
    await onPlayMove(selectedFrom, index);
  };

  return (
    <Dialog
      open={match.phase !== 'session-idle'}
      disableEscapeKeyDown={match.phase !== 'finished'}
      onClose={(_, reason) => { if (reason !== 'backdropClick' && match.phase === 'finished') onClose(); }}
      maxWidth={false}
      PaperProps={{ sx: {
        background: 'linear-gradient(145deg, #0d1b30 0%, #070d1b 100%)', border: `1px solid ${alpha('#2cf8ff', 0.32)}`,
        color: '#f8fbff', display: 'flex', height: canShowBoard ? 'min(900px, calc(100dvh - 28px))' : 'auto',
        maxHeight: 'calc(100dvh - 28px)', width: canShowBoard ? 'min(1180px, calc(100vw - 28px))' : 'min(600px, calc(100vw - 28px))',
      } }}
    >
      <DialogTitle sx={{ alignItems: 'center', display: 'flex', gap: 1, pb: 1 }}>
        <SportsEsportsRoundedIcon sx={{ color: '#2cf8ff' }} />
        <Box><Typography sx={{ fontSize: 18, fontWeight: 850 }}>Chess</Typography>{state && <Typography sx={{ color: alpha('#fff', 0.5), fontSize: 10 }}>Casual private match · {state.ply} moves</Typography>}</Box>
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', flex: 1, gap: 2, gridTemplateColumns: canShowChat ? { xs: '1fr', md: 'minmax(430px, 1fr) 300px' } : '1fr', minHeight: 0, overflow: { xs: 'auto', md: 'hidden' } }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {match.error && <Alert severity="warning" sx={{ mb: 1 }}>{match.error}</Alert>}
          {match.phase === 'opening' && <><Typography>Establishing private link…</Typography><LinearProgress sx={{ mt: 2 }} /></>}
          {match.phase === 'waiting' && <><Typography>Waiting for {opponentName || 'the other player'} to respond…</Typography><LinearProgress sx={{ mt: 2 }} /></>}
          {match.phase === 'round-waiting' && <><Typography>Waiting for {opponentName} to accept Chess…</Typography><LinearProgress sx={{ mt: 2 }} /></>}
          {(match.phase === 'incoming' || match.phase === 'round-incoming') && (
            <Stack spacing={1.5}>
              <Typography sx={{ fontWeight: 800 }}>{match.phase === 'round-incoming' ? `${opponentName} would like to play Chess.` : `${resolvePlayerName?.(match.requesterAddress) || match.requesterName || shortAddress(match.requesterAddress)} invited you to Chess.`}</Typography>
              {match.phase === 'incoming' && <Typography sx={{ color: alpha('#fff', 0.6), fontSize: 13 }}>Invitation expires in {expiresIn}s</Typography>}
            </Stack>
          )}
          {match.phase === 'starting' && <><Typography>Starting Chess…</Typography><LinearProgress sx={{ mt: 2 }} /></>}
          {canShowBoard && state && (
            <Box sx={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
              <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.75, minHeight: 24 }}>
                <Typography sx={{ fontWeight: 850 }}>
                  {match.phase === 'finished' ? outcomeText(match.outcome as ChessOutcome, localSeat) : match.phase === 'reconnecting' ? `Reconnecting (${reconnectIn}s)` : localTurn ? 'Your turn' : `${opponentName}'s turn`}
                </Typography>
                <Typography aria-live="polite" sx={{ color: checkedSeat ? '#ffcf5a' : alpha('#fff', 0.55), fontSize: 12 }}>
                  {promotion ? 'Choose a promotion piece' : selectionHint || (checkedSeat ? localTurn ? 'Your king is in check' : 'Check' : match.pendingMoveId ? 'Confirming move…' : selectedFrom !== null ? 'Choose a highlighted square or another piece' : 'Select a piece')}
                </Typography>
              </Stack>
              <Box sx={{ mb: 0.75, minHeight: 42 }}>
                {promotion ? (
                  <Stack direction="row" justifyContent="center" spacing={1}>
                    {promotion.options.map((kind) => (
                      <Button key={kind} aria-label={`Promote to ${kind === 5 ? 'queen' : kind === 4 ? 'rook' : kind === 3 ? 'bishop' : 'knight'}`} onClick={() => {
                        const pending = promotion;
                        setPromotion(null);
                        setSelectedFrom(null);
                        void onPlayMove(pending.from, pending.to, kind);
                      }} variant={kind === 5 ? 'contained' : 'outlined'} sx={{ fontSize: 22, minWidth: 42, py: 0 }}>
                        {PIECES[`${localIsWhite ? 'white' : 'black'}${kind}`]}
                      </Button>
                    ))}
                    <Button onClick={() => setPromotion(null)} size="small">Cancel</Button>
                  </Stack>
                ) : match.phase === 'reconnecting' ? <Alert severity="warning" sx={{ py: 0 }}>Connection interrupted. The board is paused while the private link recovers.</Alert> : (
                  <Stack direction="row" justifyContent="space-between" sx={{ color: alpha('#fff', 0.55), fontSize: 11, pt: 0.5 }}>
                    <span>You · {localIsWhite ? 'White' : 'Black'}</span><span>{opponentName} · {localIsWhite ? 'Black' : 'White'}</span>
                  </Stack>
                )}
              </Box>
              <Box aria-label="Chess board" role="grid" sx={{ alignSelf: 'center', aspectRatio: '1', display: 'grid', flex: '0 1 auto', gridTemplateColumns: 'repeat(8, 1fr)', maxWidth: 720, width: { xs: 'min(100%, calc(100dvh - 230px))', md: 'min(100%, calc(100dvh - 190px))' } }}>
                {displayIndexes.map((index, displayIndex) => {
                  const piece = state.board[index];
                  const seat = chessPieceSeat(piece);
                  const selected = index === selectedFrom;
                  const destination = destinations.has(index);
                  const ownPiece = seat === localSeat;
                  const checkedKing = checkedSeat === seat && chessPieceKind(piece) === 6;
                  return (
                    <Box component="button" type="button" role="gridcell" aria-selected={selected} aria-label={`Row ${Math.floor(displayIndex / 8) + 1}, column ${displayIndex % 8 + 1}${piece ? `, ${ownPiece ? 'your' : 'opponent'} ${['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'][chessPieceKind(piece)]}` : ', empty'}`} disabled={!localTurn || (!ownPiece && !destination) || Boolean(promotion)} key={index} onClick={() => void selectSquare(index)} sx={{
                      alignItems: 'center', background: (Math.floor(index / 8) + index % 8) % 2 ? '#779556' : '#ebecd0', border: 0,
                      boxShadow: checkedKing ? 'inset 0 0 0 5px #ff3f64' : selected ? 'inset 0 0 0 4px #2cf8ff' : 'none', color: '#111827', cursor: ownPiece || destination ? 'pointer' : 'default',
                      display: 'flex', fontFamily: 'serif', fontSize: 'clamp(25px, 5vw, 58px)', justifyContent: 'center', minHeight: 0, padding: 0, position: 'relative', textShadow: piece && seat === state.whiteSeat ? '0 1px 2px #000' : '0 1px 1px #fff',
                      ...(destination ? { '&::after': { background: piece ? alpha('#2cf8ff', 0.42) : alpha('#168b72', 0.7), border: piece ? '4px solid #2cf8ff' : 0, borderRadius: '50%', content: '""', height: piece ? '84%' : '24%', position: 'absolute', width: piece ? '84%' : '24%' } } : {}),
                    }}><Box component="span" sx={{ position: 'relative', zIndex: 1 }}>{pieceSymbol(state, piece)}</Box></Box>
                  );
                })}
              </Box>
            </Box>
          )}
          {match.phase === 'finished' && !state && <Typography>{match.error || 'The Chess invitation ended.'}</Typography>}
        </Box>
        {canShowChat && <GameSessionChat address={address} disabled={!transportReady || match.phase === 'reconnecting' || match.sessionClosed === true} messages={match.chatMessages} opponentName={opponentName} remoteTyping={Boolean(match.remoteTypingUntil && match.remoteTypingUntil > now)} onSend={onSendChat} onTyping={onTyping} />}
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
