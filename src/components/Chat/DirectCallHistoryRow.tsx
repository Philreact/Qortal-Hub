import { Box, Typography, alpha, useTheme } from '@mui/material';
import CallRoundedIcon from '@mui/icons-material/CallRounded';
import CallReceivedRoundedIcon from '@mui/icons-material/CallReceivedRounded';
import CallMadeRoundedIcon from '@mui/icons-material/CallMadeRounded';

const LABELS: Record<string, string> = {
  answered: 'Voice call',
  declined: 'Declined voice call',
  missed: 'Missed voice call',
  cancelled: 'Cancelled voice call',
  no_answer: 'No answer',
};

export const DirectCallHistoryRow = ({ record }: { record: any }) => {
  const theme = useTheme();
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
        {LABELS[record?.outcome] || 'Voice call'}
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
