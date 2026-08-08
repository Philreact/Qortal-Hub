import { alpha, Box, Typography, useTheme } from '@mui/material';
import GroupRoundedIcon from '@mui/icons-material/GroupRounded';
import { useTranslation } from 'react-i18next';

const compactIdentity = (value: unknown) => {
  const text = String(value || '').trim();
  if (text.length <= 18) return text || t('core:this_user');
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
  const { t } = useTranslation('core');
  const event = message?.dmFriendEvent || {};
  const actorIsMe =
    String(event?.actorAddress || '') === String(myAddress || '');
  const actor = compactIdentity(event?.actorName || event?.actorAddress);
  const target = compactIdentity(event?.targetName || event?.targetAddress);
  const text = t(
    actorIsMe
      ? event?.callsAvailable
        ? 'dm_friend_events.you_added_available'
        : 'dm_friend_events.you_added_pending'
      : event?.callsAvailable
        ? 'dm_friend_events.they_added_available'
        : 'dm_friend_events.they_added_pending',
    { name: actorIsMe ? target : actor }
  );

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
