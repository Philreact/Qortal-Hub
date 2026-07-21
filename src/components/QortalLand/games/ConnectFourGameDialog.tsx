import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded';
import SportsEsportsRoundedIcon from '@mui/icons-material/SportsEsportsRounded';
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
  alpha,
  useMediaQuery,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONNECT_FOUR_COLUMNS,
  CONNECT_FOUR_ROWS,
  connectFourDropRow,
  getConnectFourWinningCells,
  type ConnectFourMove,
  type ConnectFourOutcome,
  type ConnectFourSeat,
  type ConnectFourState,
} from './connectFour';
import { GameSessionChat, type GameChatMessage } from './GameSessionChat';

export type ConnectFourGamePhase =
  | 'idle'
  | 'opening'
  | 'waiting'
  | 'incoming'
  | 'starting'
  | 'active'
  | 'finishing'
  | 'reconnecting'
  | 'finished'
  | 'session-idle'
  | 'round-waiting'
  | 'round-incoming';

export type ConnectFourGameView = {
  matchId: string;
  roundId: string;
  requesterAddress: string;
  recipientAddress: string;
  requesterNonce: string;
  recipientNonce?: string;
  requesterName?: string;
  recipientName?: string;
  phase: ConnectFourGamePhase;
  localSeat?: ConnectFourSeat;
  startingSeat?: ConnectFourSeat;
  state?: ConnectFourState;
  stateHash?: string;
  moves: ConnectFourMove[];
  pendingMoveId?: string;
  pendingSince?: number;
  lastRoundTripMs?: number;
  expiresAt?: number;
  reconnectDeadline?: number;
  outcome?: ConnectFourOutcome;
  error?: string;
  chatMessages: GameChatMessage[];
  remoteTypingUntil?: number;
  sessionClosed?: boolean;
};

type Props = {
  address: string;
  match: ConnectFourGameView | null;
  now: number;
  transportReady: boolean;
  onClose: () => void;
  onPlayColumn: (column: number) => Promise<boolean>;
  onRematch: () => void;
  onResign: () => void;
  onRespond: (accepted: boolean) => void;
  onSendChat: (text: string) => boolean;
  onTyping: (active: boolean) => void;
  resolvePlayerName?: (address: string) => string;
};

const SOUND_KEY = 'qortalland.connectFour.soundMuted';
const PLAYER_COLORS: Record<ConnectFourSeat, string> = { 1: '#ffd24f', 2: '#ff5876' };

const shortAddress = (value: string): string =>
  value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;

const playerInitial = (name: string): string =>
  (name.trim().replace(/^Q(?=[A-Z0-9])/, '').charAt(0) || '?').toUpperCase();

const outcomeText = (
  outcome: ConnectFourOutcome | undefined,
  localSeat?: ConnectFourSeat
): string => {
  if (!outcome) return 'Game ended';
  if (outcome.type === 'draw') return 'Draw game';
  if (outcome.type === 'abandoned') return 'Game abandoned';
  if (outcome.type === 'protocol-error') return 'Game ended safely';
  return outcome.winner === localSeat ? 'You won!' : 'You lost';
};

const outcomeDetail = (outcome: ConnectFourOutcome | undefined): string => {
  if (!outcome) return '';
  if (outcome.type === 'abandoned') return 'The private connection could not be recovered. No winner was recorded.';
  if (outcome.type === 'protocol-error') return 'The peers disagreed about the game state. No winner was recorded.';
  if (outcome.type === 'resigned') return 'The game ended by resignation.';
  if (outcome.type === 'draw') return 'The board is full with no four-in-a-row.';
  return 'Four connected pieces ended the game.';
};

const availableSpaces = (state: ConnectFourState, column: number): number => {
  let count = 0;
  for (let row = 0; row < CONNECT_FOUR_ROWS; row += 1) {
    if (state.board[row * CONNECT_FOUR_COLUMNS + column] === 0) count += 1;
  }
  return count;
};

const lastMoveRow = (state: ConnectFourState, move?: ConnectFourMove): number | null => {
  if (!move) return null;
  let occupied = 0;
  for (let row = 0; row < CONNECT_FOUR_ROWS; row += 1) {
    if (state.board[row * CONNECT_FOUR_COLUMNS + move.column] !== 0) occupied += 1;
  }
  return occupied > 0 ? occupied - 1 : null;
};

const readMuted = (): boolean => {
  try {
    return window.localStorage.getItem(SOUND_KEY) === 'true';
  } catch {
    return false;
  }
};

export function ConnectFourGameDialog({
  address,
  match,
  now,
  transportReady,
  onClose,
  onPlayColumn,
  onRematch,
  onResign,
  onRespond,
  onSendChat,
  onTyping,
  resolvePlayerName,
}: Props) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [focusedColumn, setFocusedColumn] = useState<number | null>(null);
  const [shakeNonce, setShakeNonce] = useState(0);
  const [muted, setMuted] = useState(readMuted);
  const [boardWidth, setBoardWidth] = useState<number | null>(null);
  const boardAreaRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusedColumnRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const previousPlyRef = useRef(0);
  const previousTurnRef = useRef(false);
  const previousInviteRef = useRef('');
  const originalTitleRef = useRef<string | null>(null);

  const localSeat = match?.localSeat;
  const opponentAddress = match
    ? match.requesterAddress === address
      ? match.recipientAddress
      : match.requesterAddress
    : '';
  const opponentName = match
    ? match.requesterAddress === address
      ? resolvePlayerName?.(match.recipientAddress) || match.recipientName || shortAddress(match.recipientAddress)
      : resolvePlayerName?.(match.requesterAddress) || match.requesterName || shortAddress(match.requesterAddress)
    : '';
  const requesterLabel = match
    ? resolvePlayerName?.(match.requesterAddress) || match.requesterName || shortAddress(match.requesterAddress)
    : '';
  const state = match?.state;
  const localTurn = Boolean(
    match?.phase === 'active' &&
    state &&
    localSeat &&
    state.nextSeat === localSeat &&
    !match.pendingMoveId
  );
  const winningCells = useMemo(
    () => new Set(state ? getConnectFourWinningCells(state) : []),
    [state]
  );
  const lastMove = match?.moves.at(-1);
  const lastRow = state ? lastMoveRow(state, lastMove) : null;
  const previewRow = state && focusedColumn !== null && localTurn
    ? connectFourDropRow(state, focusedColumn)
    : null;
  const canShowBoard = Boolean(
    match &&
    state &&
    ['active', 'finishing', 'reconnecting', 'finished'].includes(match.phase)
  );
  const canShowChat = Boolean(
    match && (state || ['round-waiting', 'round-incoming'].includes(match.phase) || (match.phase === 'finished' && match.roundId !== match.matchId))
  );

  const playSound = useCallback((kind: 'drop' | 'turn' | 'invalid' | 'win' | 'loss') => {
    if (muted) return;
    try {
      const AudioContextClass = window.AudioContext;
      const context = audioContextRef.current || new AudioContextClass();
      audioContextRef.current = context;
      const notes = kind === 'win'
        ? [523, 659, 784]
        : kind === 'loss'
          ? [330, 277]
          : [kind === 'drop' ? 210 : kind === 'turn' ? 660 : 120];
      notes.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const startsAt = context.currentTime + index * 0.1;
        oscillator.type = kind === 'invalid' ? 'square' : 'sine';
        oscillator.frequency.setValueAtTime(frequency, startsAt);
        gain.gain.setValueAtTime(0.0001, startsAt);
        gain.gain.exponentialRampToValueAtTime(kind === 'invalid' ? 0.035 : 0.055, startsAt + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.13);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startsAt);
        oscillator.stop(startsAt + 0.14);
      });
    } catch {
      // Audio feedback is optional and must never affect gameplay.
    }
  }, [muted]);

  useEffect(() => {
    const ply = state?.ply || 0;
    if (ply > previousPlyRef.current) playSound('drop');
    previousPlyRef.current = ply;
  }, [playSound, state?.ply]);

  useEffect(() => {
    if (match?.phase === 'finished' && match.outcome) {
      const won = 'winner' in match.outcome && match.outcome.winner === localSeat;
      playSound(won ? 'win' : match.outcome.type === 'draw' ? 'turn' : 'loss');
    }
  }, [localSeat, match?.outcome, match?.phase, playSound]);

  useEffect(() => {
    if (localTurn && !previousTurnRef.current && (state?.ply || 0) > 0) {
      playSound('turn');
      if (document.hidden) {
        if (originalTitleRef.current === null) originalTitleRef.current = document.title;
        document.title = '● Your turn — Connect Four';
        try {
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Your turn in Connect Four', {
              body: `${opponentName} has moved.`,
              silent: true,
            });
          }
        } catch {
          // Window-title feedback remains available when notifications are blocked.
        }
      }
    }
    previousTurnRef.current = localTurn;
    if (!localTurn && originalTitleRef.current !== null) {
      document.title = originalTitleRef.current;
      originalTitleRef.current = null;
    }
  }, [localTurn, opponentName, playSound, state?.ply]);

  useEffect(() => {
    const incomingId = match?.phase === 'incoming' ? match.matchId : '';
    if (incomingId && previousInviteRef.current !== incomingId) {
      playSound('turn');
      if (document.hidden) {
        if (originalTitleRef.current === null) originalTitleRef.current = document.title;
        document.title = '● Connect Four invitation';
        try {
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Connect Four invitation', {
              body: `${requesterLabel} invited you to play.`,
              silent: true,
            });
          }
        } catch {
          // The modal and window title remain available when notifications are blocked.
        }
      }
    }
    previousInviteRef.current = incomingId;
    if (!incomingId && !localTurn && originalTitleRef.current !== null) {
      document.title = originalTitleRef.current;
      originalTitleRef.current = null;
    }
  }, [localTurn, match?.matchId, match?.phase, playSound, requesterLabel]);

  useEffect(() => () => {
    if (originalTitleRef.current !== null) document.title = originalTitleRef.current;
    void audioContextRef.current?.close().catch(() => {});
  }, []);

  useEffect(() => {
    setFocusedColumn(null);
    focusedColumnRef.current = null;
    previousPlyRef.current = match?.state?.ply || 0;
    previousTurnRef.current = false;
  }, [match?.matchId]);

  useEffect(() => {
    focusedColumnRef.current = focusedColumn;
  }, [focusedColumn]);

  useEffect(() => {
    const boardArea = boardAreaRef.current;
    if (!boardArea || !canShowBoard) {
      setBoardWidth(null);
      return;
    }
    const fitBoard = (width: number, height: number) => {
      const next = Math.floor(Math.min(width, height * (CONNECT_FOUR_COLUMNS / CONNECT_FOUR_ROWS)));
      setBoardWidth(next > 0 ? next : null);
    };
    const measure = () => {
      const bounds = boardArea.getBoundingClientRect();
      fitBoard(bounds.width, bounds.height);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) fitBoard(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(boardArea);
    return () => observer.disconnect();
  }, [canShowBoard]);

  const toggleMuted = useCallback(() => {
    setMuted((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(SOUND_KEY, String(next));
      } catch {
        // Keep the in-memory preference when storage is unavailable.
      }
      return next;
    });
  }, []);

  const attemptColumn = useCallback(async (column: number) => {
    if (!state || !localTurn) return;
    if (connectFourDropRow(state, column) === null) {
      setShakeNonce((value) => value + 1);
      playSound('invalid');
      return;
    }
    const played = await onPlayColumn(column);
    if (!played) {
      setShakeNonce((value) => value + 1);
      playSound('invalid');
    }
  }, [localTurn, onPlayColumn, playSound, state]);

  useEffect(() => {
    if (!localTurn) return;
    const initialColumn = focusedColumnRef.current ?? 3;
    const focusColumn = (column: number) => {
      const bounded = Math.max(0, Math.min(CONNECT_FOUR_COLUMNS - 1, column));
      focusedColumnRef.current = bounded;
      setFocusedColumn(bounded);
      columnRefs.current[bounded]?.focus();
    };
    const focusFrame = window.requestAnimationFrame(() => focusColumn(initialColumn));
    const handleGameKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.matches('input,textarea,[contenteditable="true"]')) return;
      const current = focusedColumnRef.current ?? 3;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        focusColumn(current - 1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        focusColumn(current + 1);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        focusColumn(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        focusColumn(CONNECT_FOUR_COLUMNS - 1);
        return;
      }
      if (/^[1-7]$/.test(event.key)) {
        event.preventDefault();
        const column = Number(event.key) - 1;
        focusColumn(column);
        void attemptColumn(column);
        return;
      }
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        !target?.getAttribute('aria-label')?.startsWith('Play column')
      ) {
        event.preventDefault();
        void attemptColumn(current);
      }
    };
    window.addEventListener('keydown', handleGameKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleGameKey);
    };
  }, [attemptColumn, localTurn]);

  const connection = (() => {
    if (match?.phase === 'reconnecting') return { color: '#ffb74d', label: 'Reconnecting' };
    if (match?.phase === 'finished') return { color: '#9d8cff', label: 'Match complete' };
    if (!transportReady) return { color: '#ff5876', label: 'Transport unavailable' };
    if (match?.pendingSince) {
      const pendingMs = now - match.pendingSince;
      if (pendingMs > 2_000) return { color: '#ffcf5a', label: `Waiting for peer · ${(pendingMs / 1_000).toFixed(1)}s` };
    }
    if (match?.phase === 'finishing') return { color: '#9d8cff', label: 'Verifying result' };
    if (match?.lastRoundTripMs) {
      return match.lastRoundTripMs > 1_500
        ? { color: '#ffcf5a', label: `Slow link · ${match.lastRoundTripMs}ms` }
        : { color: '#55e6a5', label: `Connected · ${match.lastRoundTripMs}ms` };
    }
    return { color: '#55e6a5', label: 'Private link connected' };
  })();

  const liveMessage = match
    ? match.phase === 'reconnecting'
      ? `Connection interrupted. Reconnecting for ${Math.max(0, Math.ceil(((match.reconnectDeadline || now) - now) / 1000))} seconds.`
      : match.phase === 'finished'
        ? outcomeText(match.outcome, localSeat)
        : localTurn
          ? 'Your turn.'
          : match.phase === 'active'
            ? `${opponentName}'s turn.`
            : ''
    : '';

  return (
    <Dialog
      open={Boolean(match && match.phase !== 'session-idle')}
      disableEscapeKeyDown={Boolean(match && match.phase !== 'finished')}
      onClose={(_event, reason) => {
        if (!match || reason === 'backdropClick' || match.phase !== 'finished') return;
        onClose();
      }}
      maxWidth={canShowChat ? 'lg' : 'sm'}
      fullWidth
      PaperProps={{
        sx: {
          background: 'radial-gradient(circle at 50% -20%,#172a4d 0,#10182a 34%,#070914 100%)',
          border: `1px solid ${alpha('#2cf8ff', 0.32)}`,
          boxShadow: `0 28px 90px ${alpha('#000', 0.68)},0 0 44px ${alpha('#2cf8ff', 0.08)}`,
          color: '#f8fbff',
          height: canShowBoard ? 'calc(100% - 64px)' : 'auto',
          overflow: 'hidden',
        },
      }}
    >
      {match && (
        <>
          <DialogTitle sx={{ alignItems: 'center', display: 'flex', gap: 1 }}>
            <SportsEsportsRoundedIcon sx={{ color: '#2cf8ff' }} />
            <Box sx={{ flex: 1 }}>
              <Typography component="div" sx={{ fontSize: 18, fontWeight: 850 }}>Connect Four</Typography>
              {canShowBoard && (
                <Typography component="div" sx={{ color: alpha('#fff', 0.58), fontSize: 11 }}>
                  Casual private match · {state?.ply || 0} moves
                </Typography>
              )}
            </Box>
            <Tooltip title={muted ? 'Turn game sounds on' : 'Mute game sounds'}>
              <IconButton aria-label={muted ? 'Turn game sounds on' : 'Mute game sounds'} onClick={toggleMuted} sx={{ color: alpha('#fff', 0.72) }}>
                {muted ? <VolumeOffRoundedIcon /> : <VolumeUpRoundedIcon />}
              </IconButton>
            </Tooltip>
          </DialogTitle>

          <DialogContent sx={{ display: 'grid', flex: '1 1 auto', gap: 2, gridTemplateColumns: canShowChat ? { xs: '1fr', md: 'minmax(420px, 1fr) 310px' } : '1fr', gridTemplateRows: { xs: 'auto', md: 'minmax(0, 1fr)' }, minHeight: 0, overflowX: 'hidden', overflowY: { xs: 'auto', md: 'hidden' } }}>
            <Box aria-live="polite" sx={{ height: 0, overflow: 'hidden', position: 'absolute', width: 0 }}>{liveMessage}</Box>
            <Box sx={{ height: '100%', minHeight: 0, minWidth: 0 }}>

            {match.phase === 'opening' && (
              <Stack spacing={2} sx={{ py: 1 }}>
                <Typography sx={{ fontSize: 17, fontWeight: 750 }}>Establishing private link…</Typography>
                <Typography sx={{ color: alpha('#fff', 0.62), fontSize: 13 }}>
                  Finding a secure Reticulum route to {opponentName}.
                </Typography>
                <LinearProgress />
              </Stack>
            )}

            {match.phase === 'waiting' && (
              <Stack spacing={2} sx={{ py: 1 }}>
                <Typography sx={{ fontSize: 17, fontWeight: 750 }}>Invitation sent</Typography>
                <Typography sx={{ color: alpha('#fff', 0.7) }}>Waiting for {opponentName} to respond…</Typography>
                <Typography variant="caption">The invitation expires automatically after 60 seconds.</Typography>
                <LinearProgress />
              </Stack>
            )}

            {match.phase === 'round-waiting' && (
              <Stack spacing={2} sx={{ py: 1 }}>
                <Typography sx={{ fontSize: 17, fontWeight: 750 }}>Rematch requested</Typography>
                <Typography sx={{ color: alpha('#fff', 0.7) }}>Waiting for {opponentName} to accept another game…</Typography>
                <Typography variant="caption">Reusing your authenticated private connection.</Typography>
                <LinearProgress />
              </Stack>
            )}

            {(match.phase === 'incoming' || match.phase === 'round-incoming') && (
              <Stack spacing={2} sx={{ py: 1 }}>
                <Box sx={{ alignItems: 'center', display: 'flex', gap: 1.5 }}>
                  <Box sx={{ alignItems: 'center', background: `linear-gradient(135deg,${alpha('#2cf8ff', 0.42)},${alpha('#9d6cff', 0.5)})`, border: `1px solid ${alpha('#fff', 0.28)}`, borderRadius: '50%', display: 'flex', fontSize: 20, fontWeight: 900, height: 52, justifyContent: 'center', width: 52 }}>
                    {playerInitial(requesterLabel)}
                  </Box>
                  <Box>
                    <Typography sx={{ fontSize: 17, fontWeight: 800 }}>{requesterLabel}</Typography>
                    <Typography sx={{ color: alpha('#fff', 0.62), fontSize: 12 }}>{shortAddress(match.requesterAddress)}</Typography>
                  </Box>
                </Box>
                <Typography>{match.phase === 'round-incoming' ? 'Would like to play another Connect Four game.' : 'Invited you to a private Connect Four game.'}</Typography>
                <Box sx={{ backgroundColor: alpha('#2cf8ff', 0.07), border: `1px solid ${alpha('#2cf8ff', 0.18)}`, borderRadius: 2, p: 1.5 }}>
                  <Typography sx={{ color: '#9ffcff', fontSize: 13, fontWeight: 750 }}>
                    {match.phase === 'round-incoming'
                      ? 'Private game session already authenticated'
                      : `Expires in ${Math.max(0, Math.ceil(((match.expiresAt || now) - now) / 1000))} seconds`}
                  </Typography>
                  <Typography sx={{ color: alpha('#fff', 0.56), fontSize: 11, mt: 0.5 }}>
                    Moves are encrypted through a dedicated Reticulum Link.
                  </Typography>
                </Box>
              </Stack>
            )}

            {match.phase === 'starting' && (
              <Stack spacing={2} sx={{ py: 1 }}>
                <Typography sx={{ fontSize: 17, fontWeight: 750 }}>Challenge accepted</Typography>
                <Typography sx={{ color: alpha('#fff', 0.65), fontSize: 13 }}>Authenticating both players and preparing the board…</Typography>
                <LinearProgress />
              </Stack>
            )}

            {canShowBoard && state && localSeat && (
              <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0 }}>
                <Box sx={{ alignItems: 'center', display: 'grid', gap: 1, gridTemplateColumns: '1fr auto 1fr' }}>
                  {([localSeat, localSeat === 1 ? 2 : 1] as ConnectFourSeat[]).map((seat, index) => {
                    const isLocal = index === 0;
                    const label = isLocal ? 'You' : opponentName;
                    const hasTurn = match.phase === 'active' && state.nextSeat === seat;
                    return (
                      <Box key={seat} sx={{ alignItems: 'center', display: 'flex', flexDirection: index === 0 ? 'row' : 'row-reverse', gap: 1, minWidth: 0 }}>
                        <Box sx={{ alignItems: 'center', backgroundColor: alpha(PLAYER_COLORS[seat], 0.2), border: `2px solid ${PLAYER_COLORS[seat]}`, borderRadius: '50%', display: 'flex', flexShrink: 0, fontSize: 14, fontWeight: 900, height: 38, justifyContent: 'center', width: 38 }}>
                          {playerInitial(label)}
                        </Box>
                        <Box sx={{ minWidth: 0, textAlign: index === 0 ? 'left' : 'right' }}>
                          <Typography noWrap sx={{ fontSize: 13, fontWeight: 800 }}>{label}</Typography>
                          <Typography sx={{ color: hasTurn ? PLAYER_COLORS[seat] : alpha('#fff', 0.48), fontSize: 10, fontWeight: 700 }}>
                            {hasTurn ? 'PLAYING' : seat === 1 ? 'GOLD' : 'CORAL'}
                          </Typography>
                        </Box>
                      </Box>
                    );
                  }).reduce<React.ReactNode[]>((items, player, index) => {
                    if (index === 1) items.push(<Typography key="versus" sx={{ color: alpha('#fff', 0.32), fontSize: 11, fontWeight: 900 }}>VS</Typography>);
                    items.push(player);
                    return items;
                  }, [])}
                </Box>

                <Box sx={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', minHeight: 30 }}>
                  <Typography sx={{ color: match.phase === 'finished' ? '#fff' : localTurn ? '#9ffcff' : alpha('#fff', 0.72), fontSize: 16, fontWeight: 850 }}>
                    {match.phase === 'finished'
                      ? outcomeText(match.outcome, localSeat)
                      : match.phase === 'reconnecting'
                        ? 'Game paused'
                        : match.phase === 'finishing'
                          ? 'Confirming final result…'
                          : localTurn
                            ? 'Your turn'
                            : `${opponentName}'s turn`}
                  </Typography>
                  <Box sx={{ alignItems: 'center', display: 'flex', gap: 0.7 }}>
                    <Box sx={{ backgroundColor: connection.color, borderRadius: '50%', boxShadow: `0 0 10px ${alpha(connection.color, 0.7)}`, height: 8, width: 8 }} />
                    <Typography sx={{ color: alpha('#fff', 0.58), fontSize: 10 }}>{connection.label}</Typography>
                  </Box>
                </Box>

                {match.phase === 'reconnecting' && (
                  <Alert severity="warning" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
                    <Typography sx={{ fontSize: 13, fontWeight: 800 }}>
                      Connection interrupted — reconnecting ({Math.max(0, Math.ceil(((match.reconnectDeadline || now) - now) / 1000))}s)
                    </Typography>
                    <Typography sx={{ fontSize: 11 }}>The board is paused and will resume only if both states match.</Typography>
                  </Alert>
                )}

                <Box ref={boardAreaRef} sx={{ alignItems: 'center', display: 'flex', flex: '1 1 0', justifyContent: 'center', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
                  <Box
                    key={shakeNonce}
                    sx={{
                      '@keyframes qlBoardShake': { '0%,100%': { transform: 'translateX(0)' }, '25%': { transform: 'translateX(-5px)' }, '75%': { transform: 'translateX(5px)' } },
                      '@keyframes qlPieceDrop': { from: { opacity: 0.2, transform: 'translateY(-280%) scale(.88)' }, to: { opacity: 1, transform: 'translateY(0) scale(1)' } },
                      '@keyframes qlWinPulse': { '0%,100%': { boxShadow: '0 0 0 2px rgba(255,255,255,.6),0 0 12px rgba(255,255,255,.25)' }, '50%': { boxShadow: '0 0 0 4px #fff,0 0 26px rgba(255,255,255,.85)' } },
                      animation: shakeNonce && !reducedMotion ? 'qlBoardShake 220ms ease-out' : 'none',
                      aspectRatio: `${CONNECT_FOUR_COLUMNS} / ${CONNECT_FOUR_ROWS}`,
                      background: 'linear-gradient(150deg,#1670ca,#0d3f89)',
                      border: `1px solid ${alpha('#75c9ff', 0.46)}`,
                      borderRadius: 2.5,
                      boxShadow: `inset 0 3px 14px ${alpha('#fff', 0.09)},0 12px 30px ${alpha('#000', 0.35)}`,
                      boxSizing: 'border-box',
                      maxWidth: '100%',
                      p: 1,
                      position: 'relative',
                      width: boardWidth ? `${boardWidth}px` : '100%',
                    }}
                  >
                  <Box role="grid" aria-label="Connect Four board" sx={{ display: 'grid', gap: { xs: 0.45, sm: 0.7 }, gridTemplateColumns: 'repeat(7,1fr)' }}>
                    {Array.from({ length: CONNECT_FOUR_COLUMNS * CONNECT_FOUR_ROWS }, (_, displayIndex) => {
                      const displayRow = Math.floor(displayIndex / CONNECT_FOUR_COLUMNS);
                      const column = displayIndex % CONNECT_FOUR_COLUMNS;
                      const internalRow = CONNECT_FOUR_ROWS - 1 - displayRow;
                      const internalIndex = internalRow * CONNECT_FOUR_COLUMNS + column;
                      const cell = state.board[internalIndex] || 0;
                      const isLast = lastMove?.column === column && lastRow === internalRow;
                      const isPending = isLast && lastMove?.messageId === match.pendingMoveId;
                      const isWinner = winningCells.has(internalIndex);
                      const isPreview = !cell && focusedColumn === column && previewRow === internalRow;
                      const renderedSeat = (cell || (isPreview ? localSeat : 0)) as 0 | ConnectFourSeat;
                      const spaces = availableSpaces(state, column);
                      return (
                        <Box
                          aria-label={`Column ${column + 1}, row ${displayRow + 1}, ${cell ? `${cell === localSeat ? 'your' : 'opponent'} piece` : 'empty'}`}
                          key={displayIndex}
                          role="gridcell"
                          sx={{ aspectRatio: '1', backgroundColor: '#071426', border: `2px solid ${alpha('#fff', 0.14)}`, borderRadius: '50%', boxShadow: `inset 0 4px 10px ${alpha('#000', 0.75)}`, overflow: 'visible', position: 'relative' }}
                        >
                          {renderedSeat !== 0 && (
                            <Box
                              sx={{
                                animation: reducedMotion
                                  ? 'none'
                                  : isWinner
                                    ? 'qlWinPulse 900ms ease-in-out infinite'
                                    : isLast && !isPreview
                                      ? 'qlPieceDrop 430ms cubic-bezier(.22,.78,.24,1.1)'
                                      : 'none',
                                backgroundColor: PLAYER_COLORS[renderedSeat],
                                backgroundImage: renderedSeat === 1
                                  ? 'repeating-linear-gradient(45deg,rgba(255,255,255,.2) 0 3px,transparent 3px 8px)'
                                  : 'radial-gradient(circle at 35% 35%,rgba(255,255,255,.32) 0 2px,transparent 3px)',
                                border: `2px solid ${alpha('#fff', isPreview ? 0.36 : 0.64)}`,
                                borderRadius: '50%',
                                boxShadow: isLast ? `0 0 0 3px ${alpha('#2cf8ff', 0.8)},0 0 15px ${alpha('#2cf8ff', 0.45)}` : `inset 0 -5px 9px ${alpha('#000', 0.24)}`,
                                inset: 3,
                                opacity: isPreview ? 0.36 : isPending ? 0.76 : 1,
                                position: 'absolute',
                              }}
                            />
                          )}
                          {isPending && (
                            <Box aria-hidden sx={{ border: '2px dashed #fff', borderRadius: '50%', inset: 0, position: 'absolute', animation: 'spin 900ms linear infinite', '@keyframes spin': { to: { transform: 'rotate(360deg)' } } }} />
                          )}
                          {displayRow === 0 && (
                            <Box
                              aria-disabled={!localTurn}
                              aria-label={`Play column ${column + 1}, ${spaces} ${spaces === 1 ? 'space' : 'spaces'} available`}
                              component="button"
                              disabled={!localTurn}
                              onBlur={() => setFocusedColumn((value) => value === column ? null : value)}
                              onClick={() => void attemptColumn(column)}
                              onFocus={() => setFocusedColumn(column)}
                              onMouseEnter={() => setFocusedColumn(column)}
                              onMouseLeave={() => setFocusedColumn((value) => (
                                value === column && document.activeElement !== columnRefs.current[column]
                                  ? null
                                  : value
                              ))}
                              ref={(element: HTMLButtonElement | null) => { columnRefs.current[column] = element; }}
                              sx={{
                                background: 'transparent',
                                border: 0,
                                borderRadius: 2,
                                bottom: {
                                  xs: `calc(-${(CONNECT_FOUR_ROWS - 1) * 100}% - ${(CONNECT_FOUR_ROWS - 1) * 3.6}px)`,
                                  sm: `calc(-${(CONNECT_FOUR_ROWS - 1) * 100}% - ${(CONNECT_FOUR_ROWS - 1) * 5.6}px)`,
                                },
                                cursor: localTurn ? 'pointer' : 'default',
                                left: -3,
                                outline: 'none',
                                position: 'absolute',
                                right: -3,
                                top: -3,
                                zIndex: 3,
                                '&:focus-visible': { boxShadow: '0 0 0 3px #fff,0 0 0 6px #2cf8ff' },
                              }}
                            />
                          )}
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
                </Box>

                <Typography sx={{ color: alpha('#fff', 0.48), fontSize: 10, textAlign: 'center' }}>
                  Use ← → to select and Enter to drop · Number keys 1–7 play a column
                </Typography>
                <Typography
                  aria-live="polite"
                  data-testid="connect-four-board-status"
                  noWrap
                  sx={{
                    color: match.pendingMoveId ? '#9ffcff' : alpha('#9ffcff', 0.68),
                    fontSize: 10,
                    lineHeight: '15px',
                    minHeight: 15,
                    overflow: 'hidden',
                    textAlign: 'center',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {match.pendingMoveId
                    ? 'Move placed — waiting for encrypted acknowledgement…'
                    : state.ply === 0
                      ? 'The starting player was selected fairly from both players’ private nonces.'
                      : '\u00a0'}
                </Typography>
                {match.phase === 'finished' && (
                  <Box sx={{ backgroundColor: alpha('#fff', 0.045), border: `1px solid ${alpha('#fff', 0.09)}`, borderRadius: 2, p: 1.5, position: 'relative', textAlign: 'center' }}>
                    <Typography sx={{ fontSize: 20, fontWeight: 900 }}>{outcomeText(match.outcome, localSeat)}</Typography>
                    <Typography sx={{ color: alpha('#fff', 0.62), fontSize: 12, mt: 0.4 }}>{outcomeDetail(match.outcome)}</Typography>
                    <Typography sx={{ color: alpha('#fff', 0.42), fontSize: 10, mt: 0.8 }}>{state.ply} moves against {opponentName}</Typography>
                    {!reducedMotion && match.outcome?.type === 'win' && match.outcome.winner === localSeat && Array.from({ length: 18 }, (_, index) => (
                      <Box key={index} aria-hidden sx={{ '@keyframes qlConfetti': { from: { opacity: 1, transform: `translate(0,0) rotate(0deg)` }, to: { opacity: 0, transform: `translate(${(index % 2 ? 1 : -1) * (35 + index * 3)}px,${55 + (index % 5) * 12}px) rotate(${180 + index * 31}deg)` } }, animation: `qlConfetti ${700 + (index % 4) * 130}ms ease-out ${index * 28}ms both`, backgroundColor: index % 3 === 0 ? '#2cf8ff' : index % 3 === 1 ? '#ffd24f' : '#ff5876', height: 7, left: `${12 + (index * 17) % 78}%`, position: 'absolute', top: 2, width: 4 }} />
                    ))}
                  </Box>
                )}
                {match.error && <Alert severity="error">{match.error}</Alert>}
              </Stack>
            )}

            {match.phase === 'finished' && !state && (
              <Alert severity={match.error === 'declined' ? 'info' : 'warning'}>
                {match.error === 'Invitation busy'
                  ? `${opponentName} is already in a game.`
                  : match.error || 'Game ended'}
              </Alert>
            )}
            </Box>
            {canShowChat && (
              <GameSessionChat
                address={address}
                disabled={!transportReady || match.phase === 'reconnecting' || match.sessionClosed === true}
                messages={match.chatMessages}
                onSend={onSendChat}
                onTyping={onTyping}
                opponentName={opponentName}
                remoteTyping={Boolean(match.remoteTypingUntil && match.remoteTypingUntil > now)}
              />
            )}
          </DialogContent>

          <DialogActions sx={{ px: 3, pb: 2.5 }}>
            {(match.phase === 'incoming' || match.phase === 'round-incoming') && (
              <>
                <Button onClick={() => onRespond(false)}>Decline</Button>
                <Button variant="contained" onClick={() => onRespond(true)}>Accept</Button>
              </>
            )}
            {(match.phase === 'opening' || match.phase === 'waiting' || match.phase === 'round-waiting') && <Button onClick={onClose}>Cancel</Button>}
            {match.phase === 'active' && <Button color="error" onClick={onResign}>Resign</Button>}
            {match.phase === 'finished' && (
              <>
                {state && opponentAddress && (
                  <Button disabled={!transportReady || match.sessionClosed === true} startIcon={<ReplayRoundedIcon />} onClick={onRematch} variant="contained">
                    Play again
                  </Button>
                )}
                <Button onClick={onClose}>Close</Button>
              </>
            )}
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}
