import { Box, LinearProgress, Typography } from '@mui/material';

export const ReticulumGifCompressionStatus = () => (
  <Box
    aria-live="polite"
    role="status"
    sx={{
      border: '1px solid',
      borderColor: 'divider',
      borderRadius: '8px',
      maxWidth: 260,
      overflow: 'hidden',
      width: '100%',
    }}
  >
    <Typography sx={{ fontSize: 13, fontWeight: 600, px: 1.25, py: 1 }}>
      Compressing GIF…
    </Typography>
    <LinearProgress sx={{ height: 3 }} />
  </Box>
);
