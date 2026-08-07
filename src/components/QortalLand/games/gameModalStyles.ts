import { alpha } from '@mui/material';

export const gameModalPaperSx = {
  background: '#0b1724',
  border: `1px solid ${alpha('#7f9bb2', 0.34)}`,
  borderRadius: '10px',
  boxShadow: `0 18px 48px ${alpha('#000', 0.42)}`,
  color: '#f4f6f8',
  m: 0,
  overflow: 'hidden',
  width: 'min(480px, calc(100vw - 32px))',
} as const;

export const gameModalTitleSx = {
  px: { xs: 2.5, sm: '26px' },
  pb: '14px',
  pt: { xs: 2.25, sm: '24px' },
} as const;

export const gameModalContentSx = {
  px: { xs: 2.5, sm: '26px' },
  pb: '20px !important',
  pt: '4px !important',
} as const;

export const gameModalActionsSx = {
  gap: '12px',
  justifyContent: 'center',
  px: { xs: 2.5, sm: '26px' },
  pb: { xs: 2.25, sm: '24px' },
  pt: 0,
  '& > :not(style) ~ :not(style)': {
    ml: '0 !important',
  },
} as const;

export const gameModalButtonSx = {
  borderRadius: '8px',
  fontSize: 14,
  fontWeight: 650,
  height: 38,
  letterSpacing: 0,
  minWidth: 112,
  px: 2,
  textTransform: 'none',
} as const;

export const gameModalSecondaryButtonSx = {
  ...gameModalButtonSx,
  color: '#8db8ef',
  '&:hover': {
    backgroundColor: alpha('#82afea', 0.08),
  },
} as const;

export const gameModalPrimaryButtonSx = {
  ...gameModalButtonSx,
  backgroundColor: '#82afea',
  color: '#071421',
  '&:hover': {
    backgroundColor: '#94bdf1',
  },
} as const;

export const gameModalDangerButtonSx = {
  ...gameModalButtonSx,
  backgroundColor: '#ef4444',
  color: '#fff',
  '&:hover': {
    backgroundColor: '#f05252',
  },
} as const;

export const gameModalDividerSx = {
  backgroundColor: alpha('#91a6b8', 0.24),
  height: '1px',
  mt: '14px',
  width: '100%',
} as const;
