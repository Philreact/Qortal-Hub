import { Box, alpha } from '@mui/material';
import type { QortalLandAvailability } from './qortalLandPresence';

export function QortalLandAvailabilityTags({
  availability,
}: {
  availability?: QortalLandAvailability | null;
}) {
  if (!availability?.afk && !availability?.dnd) return null;

  return (
    <Box
      component="span"
      sx={{
        alignItems: 'center',
        display: 'inline-flex',
        flex: '0 0 auto',
        gap: 0.45,
      }}
    >
      {availability.afk && (
        <Box
          component="span"
          sx={{
            backgroundColor: alpha('#f0b232', 0.16),
            border: `1px solid ${alpha('#f0b232', 0.42)}`,
            borderRadius: '4px',
            color: '#f0b232',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.04em',
            lineHeight: '14px',
            px: 0.55,
          }}
        >
          AFK
        </Box>
      )}
      {availability.dnd && (
        <Box
          component="span"
          sx={{
            backgroundColor: alpha('#ff4f6d', 0.14),
            border: `1px solid ${alpha('#ff4f6d', 0.4)}`,
            borderRadius: '4px',
            color: '#ff647e',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.04em',
            lineHeight: '14px',
            px: 0.55,
          }}
        >
          DND
        </Box>
      )}
    </Box>
  );
}
