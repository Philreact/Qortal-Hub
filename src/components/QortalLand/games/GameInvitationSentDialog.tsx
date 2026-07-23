import SportsEsportsRoundedIcon from '@mui/icons-material/SportsEsportsRounded';
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip,
  Typography,
  alpha,
  useMediaQuery,
} from '@mui/material';

type Props = {
  expiresAt?: number;
  gameTitle: string;
  now: number;
  onCancel: () => void;
  onToggleSound?: () => void;
  opponentName: string;
  soundMuted?: boolean;
};

const INVITATION_DURATION_MS = 60_000;
const RING_RADIUS = 58;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const toIdSegment = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function GameInvitationSentDialog({
  expiresAt,
  gameTitle,
  now,
  onCancel,
  onToggleSound,
  opponentName,
  soundMuted,
}: Props) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const remainingMs = expiresAt === undefined
    ? INVITATION_DURATION_MS
    : Math.max(0, expiresAt - now);
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const progress = Math.min(1, remainingMs / INVITATION_DURATION_MS);
  const dashOffset = RING_CIRCUMFERENCE * (1 - progress);
  const idSegment = toIdSegment(gameTitle);
  const titleId = `${idSegment}-invitation-sent-title`;
  const descriptionId = `${idSegment}-invitation-sent-description`;

  return (
    <Dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      maxWidth={false}
      onClose={(_event, reason) => {
        if (reason === 'escapeKeyDown') onCancel();
      }}
      open
      sx={{
        '& .MuiDialog-container': {
          alignItems: 'center',
          boxSizing: 'border-box',
          pb: '12px',
          pt: { xs: '72px', md: '92px' },
        },
      }}
      PaperProps={{
        sx: {
          background: `radial-gradient(circle at 50% 45%, ${alpha('#083156', 0.42)} 0%, ${alpha('#071421', 0.98)} 48%, #06111d 100%)`,
          border: `1px solid ${alpha('#22d8e4', 0.72)}`,
          borderRadius: { xs: '14px', sm: '18px' },
          boxShadow: `0 24px 70px ${alpha('#000', 0.52)}, inset 0 1px 0 ${alpha('#8efbff', 0.06)}`,
          color: '#f4f6f8',
          display: 'flex',
          maxHeight: { xs: 'calc(100dvh - 84px)', md: 'calc(100dvh - 104px)' },
          minHeight: { xs: 'min(320px, calc(100dvh - 84px))', sm: 'min(350px, calc(100dvh - 104px))' },
          m: 0,
          overflow: 'hidden',
          width: 'min(90vw, 640px)',
        },
      }}
    >
      <DialogTitle sx={{ px: { xs: 2.5, sm: 3.5 }, pb: 0, pt: { xs: 2.25, sm: 3 } }}>
        <Box sx={{ alignItems: 'center', display: 'flex', minHeight: 36 }}>
          <SportsEsportsRoundedIcon sx={{ color: '#2de7ef', height: { xs: 22, sm: 25 }, mr: 1.25, width: { xs: 22, sm: 25 } }} />
          <Typography component="span" sx={{ fontSize: { xs: 20, sm: 24 }, fontWeight: 750, letterSpacing: '-0.025em', lineHeight: 1.1 }}>
            {gameTitle}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {onToggleSound && (
            <Tooltip title={soundMuted ? 'Turn game sounds on' : 'Mute game sounds'}>
              <IconButton
                aria-label={soundMuted ? 'Turn game sounds on' : 'Mute game sounds'}
                onClick={onToggleSound}
                sx={{ color: '#92a2b4', height: 36, width: 36, '&:hover': { backgroundColor: alpha('#22d8e4', 0.08), color: '#d9e8f4' } }}
              >
                {soundMuted ? <VolumeOffRoundedIcon /> : <VolumeUpRoundedIcon />}
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </DialogTitle>

      <DialogContent
        sx={{
          alignItems: 'center',
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          justifyContent: 'center',
          overflowY: 'auto',
          px: { xs: 2.5, sm: 3.5 },
          py: { xs: 1.5, sm: 2 },
          textAlign: 'center',
        }}
      >
        <Box
          aria-label={`${remainingSeconds} seconds remaining`}
          aria-valuemax={60}
          aria-valuemin={0}
          aria-valuenow={remainingSeconds}
          role="progressbar"
          sx={{
            '@keyframes qortalLandInvitationBreathe': {
              '0%, 100%': { filter: 'drop-shadow(0 0 6px rgba(34,216,228,.18))', transform: 'scale(1)' },
              '50%': { filter: 'drop-shadow(0 0 17px rgba(34,216,228,.34))', transform: 'scale(1.025)' },
            },
            animation: reducedMotion ? 'none' : 'qortalLandInvitationBreathe 2.4s ease-in-out infinite',
            height: { xs: 84, sm: 96 },
            mb: { xs: 1.5, sm: 1.75 },
            position: 'relative',
            width: { xs: 84, sm: 96 },
          }}
        >
          <Box component="svg" viewBox="0 0 150 150" sx={{ display: 'block', height: '100%', transform: 'rotate(-90deg)', width: '100%' }}>
            <circle cx="75" cy="75" fill="none" r="70" stroke={alpha('#22d8e4', 0.09)} strokeWidth="1" />
            <circle cx="75" cy="75" fill={alpha('#041421', 0.56)} r="52" stroke={alpha('#22d8e4', 0.2)} strokeWidth="1" />
            <circle cx="75" cy="75" fill="none" r={RING_RADIUS} stroke={alpha('#22d8e4', 0.14)} strokeWidth="4" />
            <circle
              cx="75"
              cy="75"
              fill="none"
              r={RING_RADIUS}
              stroke="#26e4ed"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              strokeWidth="4"
              style={{ transition: reducedMotion ? 'none' : 'stroke-dashoffset 700ms linear' }}
            />
          </Box>
          <SportsEsportsRoundedIcon sx={{ color: '#2de7ef', height: { xs: 25, sm: 29 }, left: '50%', position: 'absolute', top: '50%', transform: 'translate(-50%, -50%)', width: { xs: 25, sm: 29 } }} />
        </Box>

        <Typography id={titleId} sx={{ fontSize: { xs: 25, sm: 29 }, fontWeight: 750, letterSpacing: '-0.035em', lineHeight: 1.08 }}>
          Invitation sent
        </Typography>
        <Typography id={descriptionId} sx={{ color: '#a9b5c4', fontSize: { xs: 14, sm: 16 }, lineHeight: 1.35, mt: 1 }}>
          Waiting for {opponentName || 'the other player'} to respond...
        </Typography>
        <Box aria-hidden sx={{ alignItems: 'center', display: 'flex', my: { xs: 1.5, sm: 1.75 }, width: 'min(100%, 300px)' }}>
          <Box sx={{ background: `linear-gradient(90deg, transparent, ${alpha('#22d8e4', 0.8)})`, height: '1px', flex: 1 }} />
          <Box sx={{ backgroundColor: '#22d8e4', borderRadius: '50%', boxShadow: `0 0 10px ${alpha('#22d8e4', 0.85)}`, height: 5, mx: 0.5, width: 5 }} />
          <Box sx={{ background: `linear-gradient(90deg, ${alpha('#22d8e4', 0.8)}, transparent)`, height: '1px', flex: 1 }} />
        </Box>
        <Typography sx={{ color: '#9aa8b8', fontSize: { xs: 12, sm: 14 }, lineHeight: 1.4 }}>
          Invitation expires automatically after 60 seconds.
        </Typography>
      </DialogContent>

      <DialogActions sx={{ justifyContent: 'flex-end', px: { xs: 2.5, sm: 3.5 }, pb: { xs: 2.25, sm: 3 }, pt: 0 }}>
        <Button
          autoFocus
          onClick={onCancel}
          variant="outlined"
          sx={{
            borderColor: alpha('#43bde9', 0.48),
            borderRadius: '999px',
            color: '#80cfff',
            fontSize: { xs: 13, sm: 14 },
            fontWeight: 650,
            height: { xs: 40, sm: 44 },
            minWidth: { xs: 120, sm: 138 },
            px: 3,
            '&:hover': { backgroundColor: alpha('#2da7dd', 0.08), borderColor: alpha('#58c9f5', 0.78) },
          }}
        >
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
