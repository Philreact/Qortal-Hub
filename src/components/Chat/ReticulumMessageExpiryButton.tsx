import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  Box,
  IconButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  SvgIcon,
  Tooltip,
  useTheme,
} from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import { CustomStyledMenu } from '../ContextMenu';
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

const expiryMenuItemSx = {
  borderRadius: '6px',
  fontSize: 13,
  fontWeight: 600,
  minHeight: 36,
  px: 1,
  py: 0.65,
  transition: 'background-color 120ms ease',
  '&:hover': { backgroundColor: 'action.hover' },
  '& .MuiListItemIcon-root': {
    color: 'text.secondary',
    minWidth: 30,
  },
  '& .MuiListItemText-primary': {
    fontSize: 13,
    fontWeight: 600,
    lineHeight: '18px',
  },
  '& .MuiListItemText-secondary': {
    fontSize: 11,
    lineHeight: '15px',
  },
  '& .MuiSvgIcon-root': { fontSize: 18 },
};

function BombIcon() {
  return (
    <SvgIcon viewBox="0 0 24 24">
      <path d="M11.25 7a7.25 7.25 0 1 0 7.25 7.25A7.25 7.25 0 0 0 11.25 7Zm3.5 2.15a5.3 5.3 0 0 0-1.7-.75l2.18-2.18 2.55 2.55-2.18 2.18a5.3 5.3 0 0 0-.85-1.8ZM18.2 3h1.55v2.2H18.2V3Zm2.6 3.05H23V7.6h-2.2V6.05Zm-4.65-4.1h1.55v2.2h-1.55v-2.2Z" />
    </SvgIcon>
  );
}

const expiryIndicatorLabel = (durationMs?: number): string | null => {
  if (!durationMs) return null;
  const option = RETICULUM_MESSAGE_EXPIRY_OPTIONS.find(
    (candidate) => candidate.durationMs === durationMs
  );
  if (!option) return null;
  if (option.label === '24 hours') return '24';
  if (option.label === '48 hours') return '48';
  if (option.label === '72 hours') return '72';
  if (option.label === '1 week') return '1W';
  return null;
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
  const effectiveExpiryDurationMs = value ?? channelExpiryDurationMs;
  const indicatorLabel = expiryIndicatorLabel(effectiveExpiryDurationMs);
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
            {indicatorLabel ? (
              <Box
                component="span"
                sx={{
                  fontFamily: 'Inter, system-ui, sans-serif',
                  fontSize: '11px',
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 800,
                  letterSpacing: '-0.02em',
                  lineHeight: 1,
                }}
              >
                {indicatorLabel}
              </Box>
            ) : (
              <BombIcon />
            )}
          </IconButton>
        </span>
      </Tooltip>
      <CustomStyledMenu
        reticulumMenu
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        open={Boolean(anchorEl)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              backgroundColor: `${theme.palette.background.paper} !important`,
              overflow: 'hidden',
            },
          },
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          <MenuItem
            selected={value === undefined}
            onClick={() => select(undefined)}
            sx={expiryMenuItemSx}
          >
            <ListItemIcon>
              {value === undefined ? <CheckRoundedIcon /> : null}
            </ListItemIcon>
            <ListItemText
              primary="Channel default"
              secondary={channelDefaultSummary}
            />
          </MenuItem>
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
                sx={expiryMenuItemSx}
              >
                <ListItemIcon>
                  {value === option.durationMs ? <CheckRoundedIcon /> : null}
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
        </Box>
      </CustomStyledMenu>
    </>
  );
}
