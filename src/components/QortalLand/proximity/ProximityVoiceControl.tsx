import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import GraphicEqRoundedIcon from '@mui/icons-material/GraphicEqRounded';
import MicNoneRoundedIcon from '@mui/icons-material/MicNoneRounded';
import MicOffRoundedIcon from '@mui/icons-material/MicOffRounded';
import PeopleAltRoundedIcon from '@mui/icons-material/PeopleAltRounded';
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import {
  Avatar,
  Box,
  Button,
  IconButton,
  MenuItem,
  Popover,
  Select,
  Slider,
  Typography,
  alpha,
} from '@mui/material';
import { useEffect, useState } from 'react';
import type { ProximityPeer, ProximityVoiceMode, ProximityVoiceState } from './useQortalLandProximityVoice';

type Props = {
  state: ProximityVoiceState;
  mode: ProximityVoiceMode;
  pttKey: string;
  transmitting: boolean;
  peers: ProximityPeer[];
  error: string;
  devices: MediaDeviceInfo[];
  inputDeviceId: string;
  outputDeviceId: string;
  masterVolume: number;
  resolveName: (address: string) => string;
  onEnable: () => Promise<void>;
  onDisable: () => Promise<void>;
  onMode: (mode: ProximityVoiceMode) => void;
  onPttKey: (key: string) => void;
  onInputDevice: (deviceId: string) => void;
  onOutputDevice: (deviceId: string) => void;
  onMasterVolume: (volume: number) => void;
  onPeerPolicy: (address: string, muted: boolean, volume: number) => void;
};

type VoicePopoverPosition = {
  left: number;
  top: number;
};

const PROXIMITY_VOICE_PANEL_WIDTH = 340;

const inactiveStates = new Set<ProximityVoiceState>([
  'off',
  'unavailable',
  'permission-denied',
]);

const panelSx = {
  background:
    'linear-gradient(145deg, rgba(8, 18, 31, 0.99), rgba(4, 12, 23, 0.985))',
  border: '1px solid rgba(44, 248, 255, 0.48)',
  borderRadius: '14px',
  boxShadow:
    '0 22px 52px rgba(0, 0, 0, 0.58), inset 0 0 28px rgba(44, 248, 255, 0.025)',
  color: '#f8fbff',
};

const initialsForName = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
};

export function ProximityVoiceControl(props: Props) {
  const {
    state,
    mode,
    transmitting,
    peers,
    error,
    devices,
    inputDeviceId,
    outputDeviceId,
    masterVolume,
    resolveName,
    onEnable,
    onDisable,
    onMode,
    onInputDevice,
    onOutputDevice,
    onMasterVolume,
  } = props;
  const [popoverPosition, setPopoverPosition] = useState<VoicePopoverPosition | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pausedByUser, setPausedByUser] = useState(false);
  const active = !inactiveStates.has(state);
  const microphoneMuted = pausedByUser;
  const voiceActive = active && !pausedByUser && mode === 'open-mic';
  const hasVoiceSession = active || pausedByUser;
  const busy = state === 'authorizing' || state === 'reconnecting';
  const deviceSelectSx = {
    backgroundColor: 'rgba(255, 255, 255, 0.055)',
    color: '#edf4ff',
    marginTop: 0.8,
    '& .MuiSelect-icon': {
      color: 'rgba(226, 235, 248, 0.78)',
    },
    '& .MuiSelect-select': {
      alignItems: 'center',
      color: '#edf4ff',
      display: 'flex',
      fontSize: 12,
    },
    '& .MuiOutlinedInput-notchedOutline': {
      borderColor: 'rgba(184, 201, 224, 0.28)',
    },
    '&:hover .MuiOutlinedInput-notchedOutline': {
      borderColor: 'rgba(44, 248, 255, 0.5)',
    },
    '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
      borderColor: '#2cf8ff',
    },
  } as const;

  const close = () => {
    setPopoverPosition(null);
    setSettingsOpen(false);
  };

  useEffect(() => {
    if (!popoverPosition) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPopoverPosition(null);
      setSettingsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [popoverPosition]);

  const enableVoice = async () => {
    onMode('open-mic');
    await onEnable();
    setPausedByUser(false);
  };

  const toggleMute = async () => {
    if (pausedByUser) {
      onMode('open-mic');
      await onEnable();
      setPausedByUser(false);
      return;
    }

    setPausedByUser(true);
    try {
      await onDisable();
    } catch (cause) {
      setPausedByUser(false);
      throw cause;
    }
  };

  return (
    <>
      <IconButton
        aria-label="Proximity voice"
        aria-haspopup="dialog"
        aria-expanded={Boolean(popoverPosition)}
        onClick={(event) => {
          const chatPanel = event.currentTarget.closest<HTMLElement>('[data-qortalland-chat-panel="true"]');
          const bounds = (chatPanel ?? event.currentTarget).getBoundingClientRect();
          setPopoverPosition({
            left: Math.max(12, bounds.right - PROXIMITY_VOICE_PANEL_WIDTH),
            top: Math.max(12, bounds.top - 10),
          });
        }}
        size="small"
        sx={{
          backgroundColor: voiceActive ? 'rgba(44, 248, 255, 0.1)' : 'transparent',
          border: `1px solid ${alpha('#2cf8ff', popoverPosition || voiceActive ? 0.48 : 0.18)}`,
          borderRadius: '50%',
          boxShadow: voiceActive ? '0 0 11px rgba(44, 248, 255, 0.22)' : 'none',
          color: transmitting ? '#4dffb8' : voiceActive ? '#2cf8ff' : 'rgba(220, 232, 242, 0.58)',
          height: 31,
          padding: 0,
          transition: 'background-color 160ms ease, border-color 160ms ease, color 160ms ease, filter 160ms ease',
          width: 31,
          '&:hover': {
            backgroundColor: 'rgba(44, 248, 255, 0.1)',
            borderColor: 'rgba(44, 248, 255, 0.58)',
            color: '#72fbff',
            filter: 'drop-shadow(0 0 6px rgba(44, 248, 255, 0.36))',
          },
        }}
      >
        {transmitting ? (
          <GraphicEqRoundedIcon sx={{ fontSize: 19 }} />
        ) : (
          <MicNoneRoundedIcon sx={{ fontSize: 19 }} />
        )}
      </IconButton>

      <Popover
        anchorPosition={popoverPosition ?? { left: 12, top: 12 }}
        anchorReference="anchorPosition"
        open={Boolean(popoverPosition)}
        onClose={close}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              background: 'transparent',
              boxShadow: 'none',
              maxWidth: 'calc(100vw - 24px)',
              overflow: 'visible',
              padding: 0,
            },
          },
        }}
      >
        <Box
          role="dialog"
          aria-label="Proximity voice"
          sx={{
            display: 'block',
            maxWidth: '100%',
            position: 'relative',
            width: PROXIMITY_VOICE_PANEL_WIDTH,
          }}
        >
          <Box
            sx={{
              ...panelSx,
              flex: `0 0 ${PROXIMITY_VOICE_PANEL_WIDTH}px`,
              overflow: 'hidden',
              width: PROXIMITY_VOICE_PANEL_WIDTH,
            }}
          >
            <Box
              sx={{
                alignItems: 'center',
                borderBottom: '1px solid rgba(255, 255, 255, 0.09)',
                display: 'grid',
                gap: 1.15,
                gridTemplateColumns: '44px minmax(0, 1fr) 32px',
                padding: '16px 18px 15px',
              }}
            >
              <Box
                sx={{
                  alignItems: 'center',
                  backgroundColor: 'rgba(44, 248, 255, 0.08)',
                  borderRadius: '50%',
                  color: '#2cf8ff',
                  display: 'flex',
                  height: 42,
                  justifyContent: 'center',
                  width: 42,
                }}
              >
                <MicNoneRoundedIcon sx={{ fontSize: 25 }} />
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 16, fontWeight: 800, lineHeight: 1.2 }}>
                  Proximity voice
                </Typography>
                {hasVoiceSession ? (
                  <Box sx={{ alignItems: 'center', display: 'flex', gap: 0.75, marginTop: 0.55 }}>
                    <Box
                      sx={{
                        backgroundColor: busy ? '#ffc857' : microphoneMuted ? '#8995a8' : '#32d99c',
                        borderRadius: '50%',
                        height: 9,
                        width: 9,
                      }}
                    />
                    <Typography sx={{ color: busy ? '#ffc857' : microphoneMuted ? 'text.secondary' : '#2cf8ff', fontSize: 11.5 }}>
                      {busy ? 'Connecting voice' : microphoneMuted ? 'Voice paused' : 'Voice active'}
                    </Typography>
                  </Box>
                ) : (
                  <Typography sx={{ color: 'rgba(205, 214, 229, 0.68)', fontSize: 11.5, marginTop: 0.4 }}>
                    Talk with players near you.
                  </Typography>
                )}
              </Box>
              <IconButton
                aria-label="Open voice settings"
                onClick={() => setSettingsOpen((open) => !open)}
                sx={{
                  color: settingsOpen ? '#2cf8ff' : 'rgba(216, 225, 239, 0.72)',
                  '&:hover': { backgroundColor: 'rgba(44, 248, 255, 0.09)', color: '#2cf8ff' },
                }}
              >
                <SettingsRoundedIcon sx={{ fontSize: 22 }} />
              </IconButton>
            </Box>

            <Box sx={{ padding: '15px 18px 17px' }}>
              {!active && !pausedByUser ? (
                <Button
                  aria-label="Enable proximity voice"
                  disabled={busy}
                  fullWidth
                  onClick={() => void enableVoice().catch(() => {})}
                  startIcon={<MicNoneRoundedIcon />}
                  sx={{
                    background: 'linear-gradient(100deg, #13cde1, #25eef0)',
                    borderRadius: '9px',
                    color: '#041019',
                    fontSize: 13,
                    fontWeight: 800,
                    height: 44,
                    textTransform: 'none',
                    '&:hover': {
                      background: 'linear-gradient(100deg, #24dff0, #53f7f2)',
                      boxShadow: '0 0 20px rgba(44, 248, 255, 0.24)',
                    },
                  }}
                >
                  Enable voice
                </Button>
              ) : (
                <Button
                  aria-label={microphoneMuted ? 'Unmute microphone' : 'Mute microphone'}
                  disabled={busy}
                  fullWidth
                  onClick={() => void toggleMute().catch(() => {})}
                  startIcon={microphoneMuted ? <MicNoneRoundedIcon /> : <MicOffRoundedIcon />}
                  variant="outlined"
                  sx={{
                    borderColor: 'rgba(213, 225, 241, 0.28)',
                    borderRadius: '9px',
                    color: '#2cf8ff',
                    fontSize: 13,
                    fontWeight: 700,
                    height: 44,
                    textTransform: 'none',
                    '&:hover': {
                      backgroundColor: 'rgba(44, 248, 255, 0.07)',
                      borderColor: 'rgba(44, 248, 255, 0.48)',
                    },
                  }}
                >
                  {microphoneMuted ? 'Unmute microphone' : 'Mute microphone'}
                </Button>
              )}

              {error && (
                <Typography role="alert" sx={{ color: 'error.light', fontSize: 11, marginTop: 1.25 }}>
                  {error}
                </Typography>
              )}

              <Typography
                sx={{
                  color: 'rgba(191, 203, 222, 0.62)',
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: '.11em',
                  marginTop: 2.2,
                  textTransform: 'uppercase',
                }}
              >
                Nearby
              </Typography>
              <Box
                sx={{
                  marginTop: 1.15,
                  maxHeight: 144,
                  overflowY: peers.length > 3 ? 'auto' : 'hidden',
                  paddingRight: peers.length > 3 ? 0.75 : 0,
                  scrollbarColor: 'rgba(44, 248, 255, 0.5) transparent',
                  scrollbarWidth: 'thin',
                }}
              >
                {peers.length === 0 ? (
                  <Box sx={{ alignItems: 'center', color: 'rgba(191, 203, 222, 0.58)', display: 'flex', gap: 1.1, minHeight: 38 }}>
                    <PeopleAltRoundedIcon sx={{ fontSize: 20 }} />
                    <Typography sx={{ fontSize: 11.5 }}>Nobody nearby</Typography>
                  </Box>
                ) : (
                  peers.map((peer) => {
                    const name = resolveName(peer.address);
                    return (
                      <Box
                        key={peer.address}
                        sx={{
                          alignItems: 'center',
                          display: 'grid',
                          gap: 1.15,
                          gridTemplateColumns: '42px minmax(0, 1fr)',
                          minHeight: 48,
                        }}
                      >
                        <Box sx={{ position: 'relative' }}>
                          <Avatar
                            sx={{
                              background: 'linear-gradient(145deg, rgba(44,248,255,.26), rgba(255,43,214,.3))',
                              border: '1px solid rgba(44, 248, 255, 0.42)',
                              fontSize: 13,
                              fontWeight: 800,
                              height: 34,
                              width: 34,
                            }}
                          >
                            {initialsForName(name)}
                          </Avatar>
                          <Box
                            sx={{
                              backgroundColor: peer.audible ? '#32d99c' : '#738096',
                              border: '2px solid #071321',
                              borderRadius: '50%',
                              bottom: -1,
                              height: 11,
                              position: 'absolute',
                              right: 1,
                              width: 11,
                            }}
                          />
                        </Box>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography noWrap sx={{ color: peer.speaking ? '#4dffb8' : '#f8fbff', fontSize: 12.5, fontWeight: 700 }}>
                            {name}
                          </Typography>
                          <Typography sx={{ color: 'rgba(191, 203, 222, 0.58)', fontSize: 10 }}>
                            Near you
                          </Typography>
                        </Box>
                      </Box>
                    );
                  })
                )}
              </Box>
            </Box>
          </Box>

          {settingsOpen && (
            <Box
              aria-label="Voice settings"
              sx={{
                ...panelSx,
                left: `calc(100% + 12px)`,
                padding: '20px',
                position: 'absolute',
                top: 0,
                width: 300,
              }}
            >
              <Box sx={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', marginBottom: 2.2 }}>
                <Typography sx={{ fontSize: 16, fontWeight: 800 }}>Voice settings</Typography>
                <IconButton
                  aria-label="Close voice settings"
                  onClick={() => setSettingsOpen(false)}
                  size="small"
                  sx={{ color: 'rgba(216, 225, 239, 0.7)' }}
                >
                  <CloseRoundedIcon sx={{ fontSize: 20 }} />
                </IconButton>
              </Box>

              <Typography sx={{ color: 'rgba(191, 203, 222, 0.58)', fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase' }}>
                Microphone
              </Typography>
              <Select
                aria-label="Proximity microphone"
                displayEmpty
                fullWidth
                inputProps={{ 'aria-label': 'Proximity microphone' }}
                size="small"
                value={inputDeviceId}
                onChange={(event) => onInputDevice(event.target.value)}
                sx={{ ...deviceSelectSx, marginBottom: 2 }}
              >
                <MenuItem value="">System default</MenuItem>
                {devices.filter((device) => device.kind === 'audioinput').map((device, index) => (
                  <MenuItem key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</MenuItem>
                ))}
              </Select>

              <Typography sx={{ color: 'rgba(191, 203, 222, 0.58)', fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase' }}>
                Speaker
              </Typography>
              <Select
                aria-label="Proximity speaker"
                displayEmpty
                fullWidth
                inputProps={{ 'aria-label': 'Proximity speaker' }}
                size="small"
                value={outputDeviceId}
                onChange={(event) => onOutputDevice(event.target.value)}
                sx={{ ...deviceSelectSx, marginBottom: 2.25 }}
              >
                <MenuItem value="">System default</MenuItem>
                {devices.filter((device) => device.kind === 'audiooutput').map((device, index) => (
                  <MenuItem key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index + 1}`}</MenuItem>
                ))}
              </Select>

              <Typography sx={{ color: 'rgba(191, 203, 222, 0.58)', fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase' }}>
                Voice volume
              </Typography>
              <Box sx={{ alignItems: 'center', display: 'grid', gap: 1, gridTemplateColumns: '24px 1fr 38px', marginTop: 1.3 }}>
                <VolumeUpRoundedIcon sx={{ color: 'rgba(216, 225, 239, 0.72)', fontSize: 20 }} />
                <Slider
                  aria-label="Proximity master volume"
                  min={0}
                  max={1}
                  step={0.05}
                  value={Math.min(1, masterVolume)}
                  onChange={(_, value) => onMasterVolume(Number(value))}
                  size="small"
                  sx={{ color: '#2cf8ff' }}
                />
                <Typography sx={{ color: 'rgba(216, 225, 239, 0.72)', fontSize: 12, textAlign: 'right' }}>
                  {Math.round(masterVolume * 100)}%
                </Typography>
              </Box>
              <Typography sx={{ color: 'rgba(191, 203, 222, 0.5)', fontSize: 11, lineHeight: 1.5, marginTop: 1.1 }}>
                Adjust how loud nearby players sound.
              </Typography>
            </Box>
          )}
        </Box>
      </Popover>
    </>
  );
}
