import { alpha, Box, Typography, useTheme } from '@mui/material';
import GroupRoundedIcon from '@mui/icons-material/GroupRounded';

const compactIdentity = (value: unknown) => {
  const text = String(value || '').trim();
  if (text.length <= 18) return text || 'This user';
  return `${text.slice(0, 7)}...${text.slice(-5)}`;
};

export const DirectFriendEventRow = ({
  message,
  myAddress,
}: {
  message: any;
  myAddress: string;
}) => {
  const theme = useTheme();
  const event = message?.dmFriendEvent || {};
  const actorIsMe =
    String(event?.actorAddress || '') === String(myAddress || '');
  const actor = compactIdentity(event?.actorName || event?.actorAddress);
  const target = compactIdentity(event?.targetName || event?.targetAddress);
  const text = event?.callsAvailable
    ? 'Calling is now available.'
    : actorIsMe
      ? `You added ${target} as a friend. Calls unlock when they add you back.`
      : `${actor} added you as a friend. Add them back to enable calls.`;

  return (
    <Box
      sx={{
        alignItems: 'center',
        alignSelf: 'center',
        backgroundColor: alpha(theme.palette.info.main, 0.08),
        border: `1px solid ${alpha(theme.palette.info.main, 0.22)}`,
        borderRadius: '10px',
        display: 'flex',
        gap: 1,
        minHeight: 38,
        px: 1.5,
        py: 0.75,
      }}
    >
      <GroupRoundedIcon sx={{ color: 'info.main', fontSize: 18 }} />
      <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>
        {text}
      </Typography>
    </Box>
  );
};
