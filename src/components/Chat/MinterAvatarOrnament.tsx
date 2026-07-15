import { Box, Tooltip, useTheme } from '@mui/material';
import type { ReactNode } from 'react';

type MinterAvatarOrnamentProps = {
  accentColor?: string;
  children: ReactNode;
  level: number;
  size?: 'card' | 'message';
};

export const MinterAvatarOrnament = ({
  accentColor,
  children,
  level,
  size = 'message',
}: MinterAvatarOrnamentProps) => {
  const theme = useTheme();
  const isCard = size === 'card';
  const isDarkMode = theme.palette.mode === 'dark';
  const accent = accentColor || (isDarkMode ? '#2f81f7' : '#1d4ed8');
  const neutral = isDarkMode ? '#56606d' : '#6b7280';
  const plateFill = isDarkMode ? '#10141b' : '#f4f7fb';
  const plateText = isDarkMode ? '#f5f7fa' : '#171b22';
  const frameSize = isCard ? 90 : 42;
  const ornamentWidth = isCard ? 98 : 44;
  const plateWidth = isCard ? 40 : 24;
  const plateHeight = isCard ? 34 : 20;
  const plateTop = isCard ? 82 : 40;

  return (
    <Tooltip arrow title={`Minter Level ${level}`}>
      <Box
        aria-label={`Minter Level ${level}`}
        role="img"
        tabIndex={0}
        sx={{
          display: 'flex',
          flexShrink: 0,
          height: isCard ? 104 : 60,
          justifyContent: 'center',
          outline: 'none',
          position: 'relative',
          width: ornamentWidth,
          '&:hover .minter-avatar-ornament-frame, &:focus-visible .minter-avatar-ornament-frame': {
            borderColor: neutral,
            boxShadow: `0 0 0 1px ${accent}`,
          },
          '&:hover .minter-avatar-ornament-plate, &:focus-visible .minter-avatar-ornament-plate': {
            filter: 'brightness(1.12)',
          },
        }}
      >
        <Box
          aria-hidden
          className="minter-avatar-ornament-frame"
          sx={{
            border: `1px solid ${neutral}`,
            borderRadius: '50%',
            boxShadow: `0 0 0 1px ${accent}`,
            boxSizing: 'border-box',
            height: frameSize,
            left: '50%',
            pointerEvents: 'none',
            position: 'absolute',
            top: 0,
            transform: 'translateX(-50%)',
            transition: 'border-color 120ms ease, box-shadow 120ms ease',
            width: frameSize,
            zIndex: 1,
            '&::after': {
              border: `1px solid ${accent}`,
              borderRadius: '50%',
              content: '""',
              inset: isCard ? 2 : 0,
              opacity: 0.9,
              position: 'absolute',
            },
          }}
        />
        <Box
          aria-hidden
          sx={{
            backgroundColor: plateFill,
            borderLeft: `1px solid ${accent}`,
            borderRight: `1px solid ${accent}`,
            boxSizing: 'border-box',
            height: isCard ? 8 : 6,
            left: '50%',
            pointerEvents: 'none',
            position: 'absolute',
            top: isCard ? 83 : 38,
            transform: 'translateX(-50%)',
            width: isCard ? 8 : 6,
            zIndex: 1,
          }}
        />
        <Box
          className="minter-avatar-ornament-plate"
          component="svg"
          aria-hidden
          focusable="false"
          viewBox="0 0 24 20"
          sx={{
            height: plateHeight,
            left: '50%',
            overflow: 'visible',
            pointerEvents: 'none',
            position: 'absolute',
            top: plateTop,
            transform: 'translateX(-50%)',
            transition: 'filter 120ms ease',
            width: plateWidth,
            zIndex: 2,
          }}
        >
          <polygon
            fill={plateFill}
            points="12,1 22,6 22,14 12,19 2,14 2,6"
            stroke={accent}
            strokeWidth="1.25"
          />
          <text
            fill={plateText}
            fontFamily="Inter, Arial, sans-serif"
            fontSize="11"
            fontWeight="700"
            textAnchor="middle"
            x="12"
            y="14.2"
          >
            {level}
          </text>
        </Box>
        <Box
          sx={{
            pt: isCard ? '4px' : '2px',
            position: 'relative',
            zIndex: 3,
          }}
        >
          {children}
        </Box>
      </Box>
    </Tooltip>
  );
};
