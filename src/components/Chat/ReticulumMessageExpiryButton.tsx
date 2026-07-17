import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  useTheme,
} from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import {
  formatReticulumExpiryDuration,
  isReticulumMessageExpiryOptionAllowed,
  RETICULUM_MESSAGE_EXPIRY_OPTIONS,
} from './reticulumMessageExpiry';

type ReticulumMessageExpiryButtonProps = {
  channelExpiryDurationMs?: number;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (durationMs: number | undefined) => void;
  value?: number;
};

export function ReticulumMessageExpiryButton({
  channelExpiryDurationMs,
  disabled = false,
  disabledReason,
  onChange,
  value,
}: ReticulumMessageExpiryButtonProps) {
  const theme = useTheme();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const channelDefaultSummary = channelExpiryDurationMs
    ? `Maximum ${formatReticulumExpiryDuration(channelExpiryDurationMs)}`
    : 'No expiry';
  const channelDefaultLabel = useMemo(
    () =>
      channelExpiryDurationMs
        ? `Channel default (${formatReticulumExpiryDuration(channelExpiryDurationMs)})`
        : 'Channel default (no expiry)',
    [channelExpiryDurationMs]
  );
  const tooltip = disabled
    ? disabledReason || 'Message expiry is unavailable'
    : value
      ? `Message expiry: ${formatReticulumExpiryDuration(value)}`
      : `Message expiry: ${channelDefaultLabel}`;

  useEffect(() => {
    if (disabled) setAnchorEl(null);
  }, [disabled]);

  const select = (durationMs: number | undefined) => {
    onChange(durationMs);
    setAnchorEl(null);
  };

  return (
    <>
      <Tooltip title={tooltip}>
        <span>
          <IconButton
            aria-label="Set message expiry"
            aria-haspopup="menu"
            aria-expanded={anchorEl ? 'true' : undefined}
            disabled={disabled}
            onClick={(event: MouseEvent<HTMLElement>) =>
              setAnchorEl(event.currentTarget)
            }
            size="small"
            sx={{
              backgroundColor: value
                ? theme.palette.action.selected
                : 'transparent',
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: '8px',
              color: value
                ? theme.palette.text.primary
                : theme.palette.text.secondary,
              flexShrink: 0,
              height: 34,
              width: 34,
            }}
          >
            <ScheduleRoundedIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </span>
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        open={Boolean(anchorEl)}
        slotProps={{
          paper: {
            sx: {
              border: `1px solid ${theme.palette.divider}`,
              minWidth: 250,
            },
          },
        }}
      >
        <MenuItem
          selected={value === undefined}
          onClick={() => select(undefined)}
        >
          <ListItemIcon>
            {value === undefined ? <CheckRoundedIcon fontSize="small" /> : null}
          </ListItemIcon>
          <ListItemText
            primary="Channel default"
            secondary={channelDefaultSummary}
          />
        </MenuItem>
        <Divider />
        {RETICULUM_MESSAGE_EXPIRY_OPTIONS.map((option) => {
          const allowed = isReticulumMessageExpiryOptionAllowed(
            option.durationMs,
            channelExpiryDurationMs
          );
          return (
            <MenuItem
              disabled={!allowed}
              key={option.durationMs}
              selected={value === option.durationMs}
              onClick={() => select(option.durationMs)}
            >
              <ListItemIcon>
                {value === option.durationMs ? (
                  <CheckRoundedIcon fontSize="small" />
                ) : null}
              </ListItemIcon>
              <ListItemText
                primary={option.label}
                secondary={
                  allowed || !channelExpiryDurationMs
                    ? undefined
                    : `Channel maximum is ${formatReticulumExpiryDuration(
                        channelExpiryDurationMs
                      )}`
                }
              />
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}
