import { useEffect, useId, useRef, useState } from 'react';
import { Box, ClickAwayListener, Popper, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import CalendarMonthRoundedIcon from '@mui/icons-material/CalendarMonthRounded';
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded';
import StarRoundedIcon from '@mui/icons-material/StarRounded';

export type GroupLevelTier =
  | 'silver'
  | 'green'
  | 'blue'
  | 'purple'
  | 'gold'
  | 'red';

const GROUP_LEVEL_TIERS: Array<{ color: string; name: GroupLevelTier }> = [
  { name: 'silver', color: '#D7DCE5' },
  { name: 'green', color: '#4CCB78' },
  { name: 'blue', color: '#4C8DFF' },
  { name: 'purple', color: '#A970FF' },
  { name: 'gold', color: '#F2B84B' },
  { name: 'red', color: '#FF5364' },
];

export const getGroupLevel = (
  legacyLevel?: number | null,
  communityLevel?: number | null
) =>
  Number.isFinite(legacyLevel) && Number.isFinite(communityLevel)
    ? Number(legacyLevel) + Number(communityLevel)
    : null;

export const getGroupLevelTier = (level?: number | null): GroupLevelTier => {
  if (!level || level <= 2) return 'silver';
  if (level <= 4) return 'green';
  if (level <= 6) return 'blue';
  if (level <= 8) return 'purple';
  if (level <= 10) return 'gold';
  return 'red';
};

export const getGroupLevelColor = (level?: number | null) =>
  GROUP_LEVEL_TIERS.find((tier) => tier.name === getGroupLevelTier(level))
    ?.color ?? '#8F96A5';

const createdCopy = (timestamp?: number | string) => {
  const created = Number(timestamp);
  if (!Number.isFinite(created) || created <= 0) return 'Creation date unavailable';
  const start = new Date(created);
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  if (
    now.getMonth() < start.getMonth() ||
    (now.getMonth() === start.getMonth() && now.getDate() < start.getDate())
  ) {
    years -= 1;
  }
  return years <= 0 ? 'Created this year' : `Created ${years} year${years === 1 ? '' : 's'} ago`;
};

type GroupLevelBadgeProps = {
  created?: number | string;
  communityLevel?: number | null;
  legacyLevel?: number | null;
  memberCount?: number;
  size?: 'compact' | 'full';
};

export const GroupLevelBadge = ({
  created,
  communityLevel,
  legacyLevel,
  memberCount = 0,
  size = 'full',
}: GroupLevelBadgeProps) => {
  const badgeRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [popoverPositioned, setPopoverPositioned] = useState(false);
  const popoverId = useId();
  const level = getGroupLevel(legacyLevel, communityLevel);
  const available = level !== null;
  const color = getGroupLevelColor(level);
  const tier = getGroupLevelTier(level);
  const activeTierIndex = GROUP_LEVEL_TIERS.findIndex(
    (entry) => entry.name === tier
  );
  const compact = size === 'compact';

  const clearCloseTimer = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const showPopover = () => {
    clearCloseTimer();
    if (available) {
      setPopoverPositioned(false);
      setOpen(true);
    }
  };
  const closePopover = () => {
    clearCloseTimer();
    setPopoverPositioned(false);
    setOpen(false);
  };
  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(closePopover, 170);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePopover();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearCloseTimer();
    };
  }, []);

  const badgeHeight = compact ? 26 : 30;
  const label = available ? `Group Level ${level}` : 'Group Level unavailable';

  return (
    <>
      <Box
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        component="button"
        disabled={!available}
        onBlur={scheduleClose}
        onClick={() => (open ? closePopover() : showPopover())}
        onFocus={showPopover}
        onMouseEnter={showPopover}
        onMouseLeave={scheduleClose}
        ref={badgeRef}
        sx={{
          alignItems: 'center',
          backgroundColor: available ? alpha(color, 0.045) : 'rgba(143,150,165,0.06)',
          border: `0.75px solid ${available ? alpha(color, 0.78) : 'rgba(143,150,165,0.42)'}`,
          borderRadius: compact ? '6px' : '999px',
          color: available ? color : 'text.secondary',
          cursor: available ? 'pointer' : 'default',
          display: 'inline-flex',
          height: badgeHeight,
          minWidth: compact ? 112 : 152,
          overflow: 'hidden',
          p: 0,
          textAlign: 'left',
          transition: 'background-color 140ms ease, box-shadow 140ms ease',
          '&:focus-visible, &:hover': available
            ? { backgroundColor: alpha(color, 0.08), boxShadow: `0 0 0 2px ${alpha(color, 0.1)}`, outline: 'none' }
            : undefined,
        }}
      >
        <Box sx={{ alignItems: 'center', display: 'flex', height: '100%', justifyContent: 'center', pl: compact ? 0.8 : 1, pr: compact ? 0.65 : 0.85 }}>
          <StarRoundedIcon sx={{ display: 'block', fontSize: compact ? 14 : 16 }} />
        </Box>
        <Typography noWrap sx={{ alignItems: 'center', color: 'text.primary', display: 'flex', flex: 1, fontSize: compact ? 11.5 : 13, fontWeight: 500, height: '100%', lineHeight: 1, pl: compact ? 0.15 : 0.2, pr: compact ? 0.85 : 1.1 }}>
          {compact ? (available ? `Group Level` : 'Unavailable') : 'Group Level'}
        </Typography>
        <Box sx={{ alignItems: 'center', backgroundColor: available ? alpha(color, 0.76) : 'rgba(143,150,165,0.38)', borderLeft: `0.75px solid ${available ? alpha(color, 0.7) : 'rgba(143,150,165,0.35)'}`, borderRadius: compact ? '0 5px 5px 0' : '0 999px 999px 0', color: '#0b0d10', display: 'flex', fontSize: compact ? 15 : 18, fontWeight: 650, height: '100%', justifyContent: 'center', lineHeight: 1, minWidth: compact ? 29 : 35, px: compact ? 0.65 : 0.85 }}>
          {available ? level : '—'}
        </Box>
      </Box>

      <Popper
        anchorEl={badgeRef.current}
        modifiers={[
          { name: 'flip', options: { padding: 10 } },
          { name: 'offset', options: { offset: [0, 10] } },
          { name: 'preventOverflow', options: { padding: 10 } },
        ]}
        open={open && available}
        popperOptions={{
          onFirstUpdate: () => setPopoverPositioned(true),
        }}
        placement="bottom-start"
        sx={{
          visibility: popoverPositioned ? 'visible' : 'hidden',
          zIndex: 1800,
          '&[data-popper-placement*="top"] .reticulum-group-level-popover::before': {
            borderBottom: 0,
            borderTop: `7px solid ${alpha(color, 0.82)}`,
            bottom: -7,
            top: 'auto',
          },
        }}
      >
        <ClickAwayListener onClickAway={closePopover}>
          <Box
            aria-label={`${label} breakdown`}
            className="reticulum-group-level-popover"
            id={popoverId}
            onFocus={showPopover}
            onMouseEnter={showPopover}
            onMouseLeave={scheduleClose}
            role="dialog"
            sx={{
              background: 'linear-gradient(180deg, #12161b 0%, #0c0f13 100%)',
              border: `0.75px solid ${alpha(color, 0.82)}`,
              borderRadius: '10px',
              boxShadow: '0 14px 30px rgba(0,0,0,0.42)',
              color: 'text.primary',
              p: 1.7,
              position: 'relative',
              width: 226,
              '&::before': {
                borderBottom: `7px solid ${alpha(color, 0.82)}`,
                borderLeft: '7px solid transparent',
                borderRight: '7px solid transparent',
                content: '""',
                left: 22,
                position: 'absolute',
                top: -7,
              },
            }}
            tabIndex={-1}
          >
            <Typography sx={{ color, fontSize: 9.5, fontWeight: 650, letterSpacing: '0.13em', textAlign: 'center' }}>
              GROUP LEVEL {level}
            </Typography>
            <Box sx={{ alignItems: 'center', display: 'flex', gap: 1.1, mt: 1.45 }}>
              <CalendarMonthRoundedIcon sx={{ color: 'text.secondary', fontSize: 22 }} />
              <Box>
                <Typography sx={{ fontSize: 13, fontWeight: 500 }}>Legacy Level {legacyLevel}</Typography>
                <Typography sx={{ color: 'text.secondary', fontSize: 11.5, mt: 0.25 }}>{createdCopy(created)}</Typography>
              </Box>
            </Box>
            <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.1)', my: 1.35 }} />
            <Box sx={{ alignItems: 'center', display: 'flex', gap: 1.1 }}>
              <GroupsRoundedIcon sx={{ color: 'text.secondary', fontSize: 22 }} />
              <Box>
                <Typography sx={{ fontSize: 13, fontWeight: 500 }}>Community Level {communityLevel}</Typography>
                <Typography sx={{ color: 'text.secondary', fontSize: 11.5, mt: 0.25 }}>{memberCount} {memberCount === 1 ? 'member' : 'members'}</Typography>
              </Box>
            </Box>
            <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.1)', my: 1.35 }} />
            <Typography sx={{ fontSize: 12.5, fontWeight: 500, textAlign: 'center' }}>
              {legacyLevel} + {communityLevel} = Level {level}
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.65, mt: 1.35, px: 0.25 }}>
              {GROUP_LEVEL_TIERS.map((entry, index) => (
                <Box key={entry.name} sx={{ backgroundColor: entry.color, borderRadius: 1, boxShadow: index === activeTierIndex ? `0 0 0 2px ${alpha(entry.color, 0.45)}` : 'none', flex: 1, height: 8, position: 'relative', '&::before': index === activeTierIndex ? { borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: `7px solid ${entry.color}`, content: '""', left: '50%', position: 'absolute', top: -12, transform: 'translateX(-50%)' } : undefined }} />
              ))}
            </Box>
          </Box>
        </ClickAwayListener>
      </Popper>
    </>
  );
};
