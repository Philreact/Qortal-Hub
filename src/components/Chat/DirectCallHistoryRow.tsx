import { Box, Typography, alpha, useTheme } from '@mui/material';
import CallRoundedIcon from '@mui/icons-material/CallRounded';
import CallReceivedRoundedIcon from '@mui/icons-material/CallReceivedRounded';
import CallMadeRoundedIcon from '@mui/icons-material/CallMadeRounded';
import { useTranslation } from 'react-i18next';

const LABEL_KEYS: Record<string, string> = {
  answered: 'group:reticulum.call_history.answered',
  declined: 'group:reticulum.call_history.declined',
  missed: 'group:reticulum.call_history.missed',
  cancelled: 'group:reticulum.call_history.cancelled',
  no_answer: 'group:reticulum.call_history.no_answer',
};

export const DirectCallHistoryRow = ({ record }: { record: any }) => {
  const theme = useTheme();
  const { t } = useTranslation(['group']);
  const missed = record?.outcome === 'missed';
  const answered = record?.outcome === 'answered';
  const color = missed
    ? theme.palette.error.main
    : answered
      ? theme.palette.success.main
      : theme.palette.text.secondary;
  const Icon =
    record?.direction === 'incoming'
      ? CallReceivedRoundedIcon
      : record?.direction === 'outgoing'
        ? CallMadeRoundedIcon
        : CallRoundedIcon;
  const timestamp = Number(record?.endedAt || 0);

  return (
    <Box
      sx={{
        alignItems: 'center',
        alignSelf: 'center',
        backgroundColor: alpha(color, 0.08),
        border: `1px solid ${alpha(color, 0.22)}`,
        borderRadius: '10px',
        display: 'flex',
        gap: 1,
        minHeight: 38,
        px: 1.5,
        py: 0.75,
      }}
    >
      <Icon sx={{ color, fontSize: 18 }} />
      <Typography sx={{ color, fontSize: 13, fontWeight: missed ? 600 : 500 }}>
        {t(
          LABEL_KEYS[record?.outcome] ||
            'group:reticulum.call_history.answered',
          { postProcess: 'capitalizeFirstChar' }
        )}
      </Typography>
      {timestamp > 0 && (
        <Typography sx={{ color: 'text.secondary', fontSize: 11 }}>
          {new Date(timestamp).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </Typography>
      )}
    </Box>
  );
};
