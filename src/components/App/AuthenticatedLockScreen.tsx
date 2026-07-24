import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  InputAdornment,
  Modal,
  TextField,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import KeyRoundedIcon from '@mui/icons-material/KeyRounded';
import QortalLogo from '../../assets/svgs/Logo1Dark.svg';

type AuthenticatedLockScreenProps = {
  accountLabel?: string | null;
  onUnlock: (password: string) => Promise<void>;
};

const RETRY_DELAY_MS = 5_000;
const FAILURES_BEFORE_DELAY = 3;

export function AuthenticatedLockScreen({
  accountLabel,
  onUnlock,
}: AuthenticatedLockScreenProps) {
  const theme = useTheme();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const checkingRef = useRef(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [blockedUntil, setBlockedUntil] = useState(0);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  useEffect(() => {
    if (!blockedUntil) return;
    const update = () => {
      const remaining = Math.max(
        0,
        Math.ceil((blockedUntil - Date.now()) / 1000)
      );
      setSecondsRemaining(remaining);
      if (remaining === 0) setBlockedUntil(0);
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [blockedUntil]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || checkingRef.current || blockedUntil > Date.now()) return;

    checkingRef.current = true;
    setIsChecking(true);
    setError('');
    try {
      await onUnlock(password);
      setPassword('');
    } catch {
      const nextFailures = failedAttempts + 1;
      setFailedAttempts(nextFailures);
      setPassword('');
      if (nextFailures % FAILURES_BEFORE_DELAY === 0) {
        setBlockedUntil(Date.now() + RETRY_DELAY_MS);
      }
      setError('That password is not correct. Please try again.');
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      checkingRef.current = false;
      setIsChecking(false);
    }
  };

  const isBlocked = blockedUntil > Date.now();

  return (
    <Modal
      open
      disableEscapeKeyDown
      aria-labelledby="app-lock-title"
      sx={{
        zIndex: (muiTheme) => muiTheme.zIndex.modal + 1000,
      }}
    >
      <Box
        role="dialog"
        aria-modal="true"
        onKeyDownCapture={(event) => event.stopPropagation()}
        sx={{
          position: 'fixed',
          inset: 0,
          outline: 0,
          overflowY: 'auto',
          display: 'grid',
          placeItems: 'center',
          px: 2,
          py: 3,
          background:
            theme.palette.mode === 'dark'
              ? 'radial-gradient(circle at 50% 15%, #18283b 0%, #0d131c 42%, #090d13 100%)'
              : 'radial-gradient(circle at 50% 15%, #e7f1ff 0%, #f5f8fc 48%, #e8edf4 100%)',
        }}
      >
        <Box
          component="form"
          onSubmit={handleSubmit}
          sx={{
            width: 'min(420px, 100%)',
            p: { xs: 3, sm: 4 },
            borderRadius: '24px',
            border: `1px solid ${alpha(theme.palette.common.white, theme.palette.mode === 'dark' ? 0.11 : 0.5)}`,
            bgcolor: alpha(theme.palette.background.paper, 0.94),
            boxShadow: '0 28px 80px rgba(0, 0, 0, 0.38)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2.5 }}>
            <Box
              sx={{
                width: 70,
                height: 70,
                borderRadius: '22px',
                display: 'grid',
                placeItems: 'center',
                bgcolor: alpha(theme.palette.primary.main, 0.13),
                border: `1px solid ${alpha(theme.palette.primary.main, 0.28)}`,
              }}
            >
              <Box
                component="img"
                src={QortalLogo}
                alt="Qortal"
                sx={{ width: 42, height: 42 }}
              />
            </Box>
          </Box>

          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <Typography id="app-lock-title" variant="h5" fontWeight={700}>
              Qortal Hub is locked
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 0.75 }}>
              {accountLabel
                ? `${accountLabel} is still signed in.`
                : 'You are still signed in.'}
            </Typography>
          </Box>

          <TextField
            fullWidth
            autoFocus
            inputRef={inputRef}
            type="password"
            label="Qortal account password"
            value={password}
            disabled={isChecking || isBlocked}
            autoComplete="current-password"
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) setError('');
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <KeyRoundedIcon color="action" />
                  </InputAdornment>
                ),
              },
            }}
          />

          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {isBlocked
                ? `Please wait ${secondsRemaining} second${secondsRemaining === 1 ? '' : 's'} and try again.`
                : error}
            </Alert>
          )}

          <Button
            fullWidth
            size="large"
            variant="contained"
            type="submit"
            disabled={!password || isChecking || isBlocked}
            startIcon={
              isChecking ? (
                <CircularProgress size={18} color="inherit" />
              ) : (
                <LockRoundedIcon />
              )
            }
            sx={{
              mt: 2.5,
              minHeight: 48,
              borderRadius: '12px',
              fontWeight: 700,
            }}
          >
            {isChecking ? 'Unlocking…' : 'Unlock'}
          </Button>

          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 2.25, textAlign: 'center' }}
          >
            Chats and active calls remain connected while locked.
          </Typography>
        </Box>
      </Box>
    </Modal>
  );
}
