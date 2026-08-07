import { Box, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';

type MessageSizeLimitLipProps = {
  floating?: boolean;
  maximum: number;
  shakeKey: number;
  size: number;
};

export const MessageSizeLimitLip = ({
  floating = false,
  maximum,
  shakeKey,
  size,
}: MessageSizeLimitLipProps) => {
  const theme = useTheme();

  if (size <= maximum) return null;

  return (
    <Box
      aria-live="assertive"
      role="alert"
      sx={{
        alignItems: 'center',
        backgroundColor: alpha(theme.palette.error.main, 0.12),
        border: '1px solid',
        borderColor: alpha(theme.palette.error.main, 0.52),
        borderBottomColor: floating
          ? alpha(theme.palette.error.main, 0.4)
          : alpha(theme.palette.error.main, 0.52),
        borderRadius: floating ? '8px 8px 0 0' : '8px',
        boxSizing: 'border-box',
        boxShadow: `0 -4px 14px ${alpha(theme.palette.error.main, 0.08)}`,
        color: 'error.main',
        display: 'flex',
        gap: '7px',
        justifyContent: 'center',
        left: floating ? 0 : undefined,
        minHeight: 30,
        px: 1.5,
        py: 0.5,
        position: floating ? 'absolute' : 'relative',
        right: floating ? 0 : undefined,
        top: floating ? 0 : undefined,
        transform: floating ? 'translateY(-100%)' : undefined,
        width: '100%',
        zIndex: floating ? 4 : undefined,
      }}
    >
      <ErrorOutlineRoundedIcon
        aria-hidden="true"
        sx={{ flexShrink: 0, fontSize: 17 }}
      />
      <Typography
        key={shakeKey}
        sx={{
          '@keyframes qchatMessageLimitShake': {
            '0%, 100%': { transform: 'translateX(0)' },
            '20%': { transform: 'translateX(-4px)' },
            '40%': { transform: 'translateX(4px)' },
            '60%': { transform: 'translateX(-3px)' },
            '80%': { transform: 'translateX(3px)' },
          },
          '@media (prefers-reduced-motion: reduce)': {
            animation: 'none',
          },
          animation:
            shakeKey > 0
              ? 'qchatMessageLimitShake 280ms ease-in-out'
              : 'none',
          fontSize: 12,
          fontWeight: 650,
          lineHeight: 1.35,
          textAlign: 'center',
        }}
      >
        Your message size is {size} bytes out of a maximum of {maximum}.
      </Typography>
    </Box>
  );
};
