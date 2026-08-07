import { Box, useTheme } from '@mui/material';
import { alpha } from '@mui/material/styles';

type ReticulumRoleBadgeProps = {
  color?: string;
  role: 'admin' | 'owner';
  size?: 'card' | 'message';
};

export const ReticulumRoleBadge = ({
  color,
  role,
  size = 'message',
}: ReticulumRoleBadgeProps) => {
  const theme = useTheme();
  const roleColor =
    color ||
    (role === 'owner'
      ? theme.palette.mode === 'dark'
        ? '#ffb454'
        : '#a84a00'
      : theme.palette.mode === 'dark'
        ? '#58a6ff'
        : '#1d4ed8');
  const isCard = size === 'card';

  return (
    <Box
      component="span"
      sx={{
        alignItems: 'center',
        backgroundColor: alpha(
          roleColor,
          theme.palette.mode === 'dark' ? 0.07 : 0.045
        ),
        border: `1px solid ${alpha(roleColor, 0.72)}`,
        borderRadius: '5px',
        boxShadow: `0 0 0 1px ${alpha(roleColor, 0.05)}`,
        color: roleColor,
        display: 'inline-flex',
        flexShrink: 0,
        fontFamily: 'Inter',
        fontSize: isCard ? '11px' : '10.5px',
        fontWeight: 650,
        height: isCard ? 23 : 20,
        justifyContent: 'center',
        letterSpacing: '0.01em',
        lineHeight: 1,
        px: isCard ? 0.9 : 0.75,
      }}
    >
      {role === 'owner' ? 'Owner' : 'Admin'}
    </Box>
  );
};
