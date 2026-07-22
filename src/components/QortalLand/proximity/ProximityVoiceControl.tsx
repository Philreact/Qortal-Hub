import GraphicEqRoundedIcon from '@mui/icons-material/GraphicEqRounded';
import HearingDisabledRoundedIcon from '@mui/icons-material/HearingDisabledRounded';
import MicNoneRoundedIcon from '@mui/icons-material/MicNoneRounded';
import MicOffRoundedIcon from '@mui/icons-material/MicOffRounded';
import SettingsVoiceRoundedIcon from '@mui/icons-material/SettingsVoiceRounded';
import {
  Box,
  Button,
  FormControlLabel,
  IconButton,
  MenuItem,
  Popover,
  Select,
  Slider,
  Switch,
  Tooltip,
  Typography,
  alpha,
} from '@mui/material';
import { useState } from 'react';
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

const labelForState = (state: ProximityVoiceState, transmitting: boolean) => {
  if (transmitting) return 'Speaking';
  if (state === 'ready') return 'Proximity voice';
  if (state === 'suspended') return 'Voice suspended';
  if (state === 'reconnecting') return 'Voice reconnecting';
  if (state === 'authorizing') return 'Securing voice';
  return 'Enable proximity voice';
};

export function ProximityVoiceControl(props: Props) {
  const {
    state, mode, pttKey, transmitting, peers, error, devices, inputDeviceId, outputDeviceId, masterVolume, resolveName,
    onEnable, onDisable, onMode, onPttKey, onInputDevice, onOutputDevice, onMasterVolume, onPeerPolicy,
  } = props;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [binding, setBinding] = useState(false);
  const active = !['off', 'unavailable', 'permission-denied'].includes(state);
  const connected = peers.filter((peer) => peer.audible).length;

  return (
    <>
      <Tooltip title={labelForState(state, transmitting)}>
        <Button
          aria-label={labelForState(state, transmitting)}
          onClick={(event) => {
            setAnchor(event.currentTarget);
            if (!active) void onEnable().catch(() => {});
          }}
          size="small"
          startIcon={active ? transmitting ? <GraphicEqRoundedIcon /> : <SettingsVoiceRoundedIcon /> : <MicOffRoundedIcon />}
          sx={{
            border: `1px solid ${alpha(transmitting ? '#4dffb8' : '#2cf8ff', active ? 0.48 : 0.18)}`,
            borderRadius: '8px',
            color: transmitting ? '#4dffb8' : active ? '#7ffbff' : 'rgba(255,255,255,.58)',
            fontSize: 11,
            fontWeight: 800,
            minHeight: 28,
            textTransform: 'none',
          }}
        >
          {active ? `${connected}/7` : 'Voice'}
        </Button>
      </Tooltip>

      <Popover
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => { setAnchor(null); setBinding(false); }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { bgcolor: 'rgba(7,13,24,.98)', border: '1px solid rgba(44,248,255,.32)', mt: 1, p: 1.5, width: 330 } } }}
      >
        <Box sx={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', mb: 1.25 }}>
          <Box>
            <Typography sx={{ fontSize: 14, fontWeight: 800 }}>Proximity voice</Typography>
            <Typography sx={{ color: 'text.secondary', fontSize: 10 }}>
              {state === 'ready' ? `${connected} audible · ${peers.length} connected` : labelForState(state, transmitting)}
            </Typography>
          </Box>
          {transmitting ? <GraphicEqRoundedIcon sx={{ color: '#4dffb8' }} /> : <MicNoneRoundedIcon sx={{ color: '#2cf8ff' }} />}
        </Box>

        <Select
          fullWidth
          size="small"
          value={mode}
          onChange={(event) => onMode(event.target.value as ProximityVoiceMode)}
          sx={{ fontSize: 12, mb: 1 }}
        >
          <MenuItem value="push-to-talk">Push to talk</MenuItem>
          <MenuItem value="open-mic">Open microphone</MenuItem>
        </Select>
        <Box sx={{ alignItems: 'center', display: 'grid', gap: 1, gridTemplateColumns: '72px 1fr', mb: 1 }}>
          <Typography sx={{ color: 'text.secondary', fontSize: 10 }}>Volume</Typography>
          <Slider aria-label="Proximity master volume" min={0} max={2} step={0.05} value={masterVolume} onChange={(_, value) => onMasterVolume(Number(value))} size="small" />
        </Box>

        {mode === 'push-to-talk' && (
          <Button
            fullWidth
            variant="outlined"
            onClick={() => setBinding(true)}
            onKeyDown={(event) => {
              if (!binding) return;
              event.preventDefault();
              event.stopPropagation();
              onPttKey(event.key);
              setBinding(false);
            }}
            sx={{ fontSize: 11, mb: 1, textTransform: 'none' }}
          >
            {binding ? 'Press a key…' : `Hold ${pttKey.toUpperCase()} to talk`}
          </Button>
        )}

        <Select
          aria-label="Proximity microphone"
          fullWidth
          size="small"
          value={inputDeviceId}
          onChange={(event) => onInputDevice(event.target.value)}
          sx={{ fontSize: 11, mb: 1 }}
        >
          <MenuItem value="">Default microphone</MenuItem>
          {devices.filter((device) => device.kind === 'audioinput').map((device, index) => (
            <MenuItem key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</MenuItem>
          ))}
        </Select>
        <Select
          aria-label="Proximity speaker"
          fullWidth
          size="small"
          value={outputDeviceId}
          onChange={(event) => onOutputDevice(event.target.value)}
          sx={{ fontSize: 11, mb: 1 }}
        >
          <MenuItem value="">Default speaker</MenuItem>
          {devices.filter((device) => device.kind === 'audiooutput').map((device, index) => (
            <MenuItem key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index + 1}`}</MenuItem>
          ))}
        </Select>

        {error && <Typography role="alert" sx={{ color: 'error.light', fontSize: 11, mb: 1 }}>{error}</Typography>}

        <Typography sx={{ color: 'text.secondary', fontSize: 10, fontWeight: 800, letterSpacing: '.08em', mb: .5, textTransform: 'uppercase' }}>
          Nearby people
        </Typography>
        <Box sx={{ maxHeight: 240, overflowY: 'auto' }}>
          {peers.length === 0 && (
            <Typography sx={{ color: 'text.secondary', fontSize: 11, py: 1.5, textAlign: 'center' }}>
              Move closer to another enabled player.
            </Typography>
          )}
          {peers.map((peer) => (
            <Box key={peer.address} sx={{ alignItems: 'center', display: 'grid', gap: 1, gridTemplateColumns: '1fr 88px 30px', py: .55 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography noWrap sx={{ color: peer.speaking ? '#4dffb8' : 'text.primary', fontSize: 12, fontWeight: 700 }}>
                  {resolveName(peer.address)}
                </Typography>
                <Typography sx={{ color: 'text.secondary', fontSize: 9 }}>
                  {peer.audible ? `${Math.round(peer.distance ?? 0)} px away` : peer.state}
                </Typography>
              </Box>
              <Slider
                aria-label={`Volume for ${resolveName(peer.address)}`}
                min={0}
                max={2}
                step={0.05}
                value={peer.volume}
                onChange={(_, value) => onPeerPolicy(peer.address, peer.muted, Number(value))}
                size="small"
              />
              <IconButton
                aria-label={`${peer.muted ? 'Unmute' : 'Mute'} ${resolveName(peer.address)}`}
                onClick={() => onPeerPolicy(peer.address, !peer.muted, peer.volume)}
                size="small"
              >
                {peer.muted ? <HearingDisabledRoundedIcon fontSize="small" /> : <GraphicEqRoundedIcon fontSize="small" />}
              </IconButton>
            </Box>
          ))}
        </Box>

        <FormControlLabel
          control={<Switch checked={active} onChange={(_, checked) => checked ? void onEnable() : void onDisable()} />}
          label={<Typography sx={{ fontSize: 11 }}>Voice enabled for this Land session</Typography>}
          sx={{ mt: 1 }}
        />
      </Popover>
    </>
  );
}
