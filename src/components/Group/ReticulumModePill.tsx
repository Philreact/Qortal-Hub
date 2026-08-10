import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ButtonBase, Tooltip, useTheme } from '@mui/material';
import ChatRoundedIcon from '@mui/icons-material/ChatRounded';
import SportsEsportsRoundedIcon from '@mui/icons-material/SportsEsportsRounded';

/** The surface the pill switches *to*, not the one currently shown. */
type ReticulumModePillTarget = 'chat' | 'qortal_land';

type ReticulumModePillProps = {
  target: ReticulumModePillTarget;
  onClick: () => void;
};

const RETICULUM_ACTIVE_BLUE = '#2563eb';
let hasPlayedQortalLandSweep = false;

export function ReticulumModePill({ target, onClick }: ReticulumModePillProps) {
  const { t } = useTranslation(['group', 'reticulum']);
  const theme = useTheme();
  const isQortalLandTarget = target === 'qortal_land';
  const [playSweep, setPlaySweep] = useState(false);
  const hoveredRef = useRef(false);
  const actionLabel = isQortalLandTarget
    ? t('reticulum:mode_pill.enter_qortal_land')
    : t('reticulum:mode_pill.return_to_chat');
  const compactLabel = isQortalLandTarget
    ? t('group:chat_group.qortal_land')
    : t('reticulum:mode_pill.chat');

  useEffect(() => {
    if (!isQortalLandTarget || hasPlayedQortalLandSweep) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const settleTimer = window.setTimeout(() => {
      const hasOpenModal = Boolean(document.querySelector('[role="dialog"]'));
      if (
        reducedMotion.matches ||
        !document.hasFocus() ||
        hasOpenModal ||
        hoveredRef.current
      ) {
        return;
      }

      hasPlayedQortalLandSweep = true;
      setPlaySweep(true);
    }, 700);
    const finishTimer = window.setTimeout(() => setPlaySweep(false), 1600);

    return () => {
      window.clearTimeout(settleTimer);
      window.clearTimeout(finishTimer);
    };
  }, [isQortalLandTarget]);

  return (
    <Tooltip title={actionLabel}>
      <ButtonBase
        aria-label={actionLabel}
        onClick={onClick}
        onMouseEnter={() => {
          hoveredRef.current = true;
          setPlaySweep(false);
        }}
        onMouseLeave={() => {
          hoveredRef.current = false;
        }}
        sx={{
          '@keyframes reticulum-mode-pill-content-in': {
            from: {
              opacity: 0,
              transform: 'translateY(2px)',
            },
            to: {
              opacity: 1,
              transform: 'translateY(0)',
            },
          },
          '@keyframes reticulum-mode-pill-sweep': {
            from: { transform: 'translateX(-150%) skewX(-18deg)' },
            to: { transform: 'translateX(350%) skewX(-18deg)' },
          },
          alignItems: 'center',
          backdropFilter: 'blur(10px)',
          backgroundColor:
            theme.palette.mode === 'light'
              ? 'rgba(37, 99, 235, 0.12)'
              : 'rgba(44, 116, 255, 0.10)',
          border: `1px solid ${
            theme.palette.mode === 'light'
              ? 'rgba(37, 99, 235, 0.72)'
              : 'rgba(62, 139, 255, 0.75)'
          }`,
          borderRadius: '999px',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.06), 0 0 12px rgba(42,125,255,0.10)',
          color: theme.palette.mode === 'light' ? '#205eb8' : '#9bc5ff',
          display: 'inline-flex',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 12,
          fontWeight: 650,
          gap: '7px',
          height: 36,
          minWidth: { xs: 36, md: 106, lg: 142 },
          mr: 0.75,
          overflow: 'hidden',
          px: { xs: 1, md: 1.75 },
          position: 'relative',
          transition:
            'background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease, color 180ms ease, transform 180ms ease',
          whiteSpace: 'nowrap',
          '&::after': {
            animation: playSweep
              ? 'reticulum-mode-pill-sweep 820ms ease-out both'
              : 'none',
            background:
              'linear-gradient(90deg, transparent, rgba(185,220,255,0.24), transparent)',
            content: '\"\"',
            inset: 0,
            pointerEvents: 'none',
            position: 'absolute',
            transform: 'translateX(-150%) skewX(-18deg)',
            width: '34%',
          },
          '&:hover': {
            backgroundColor: RETICULUM_ACTIVE_BLUE,
            borderColor: '#4c8cff',
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.12), 0 0 18px rgba(47,111,237,0.28)',
            color: theme.palette.common.white,
            transform: 'translateY(-1px)',
          },
          '&:focus-visible': {
            backgroundColor: RETICULUM_ACTIVE_BLUE,
            borderColor: '#4c8cff',
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.12), 0 0 0 2px rgba(76,140,255,0.34), 0 0 16px rgba(47,111,237,0.22)',
            color: theme.palette.common.white,
            outline: 'none',
          },
          '@media (prefers-reduced-motion: reduce)': {
            transition: 'none',
            '&::after': { animation: 'none' },
            '& .reticulum-mode-pill-content': { animation: 'none' },
          },
          '& .reticulum-mode-label-compact': {
            display: 'none',
          },
          '@media (max-width: 1199.95px)': {
            '& .reticulum-mode-label-full': { display: 'none' },
            '& .reticulum-mode-label-compact': { display: 'inline' },
          },
          '@media (max-width: 899.95px)': {
            '& .reticulum-mode-label-compact': { display: 'none' },
          },
        }}
      >
        <span
          key={target}
          className="reticulum-mode-pill-content"
          style={{
            alignItems: 'center',
            animation: 'reticulum-mode-pill-content-in 200ms ease both',
            display: 'inline-flex',
            gap: '7px',
            position: 'relative',
            zIndex: 1,
          }}
        >
          {isQortalLandTarget ? (
            <SportsEsportsRoundedIcon sx={{ fontSize: 17 }} />
          ) : (
            <ChatRoundedIcon sx={{ fontSize: 17 }} />
          )}
          <span className="reticulum-mode-label-full">{actionLabel}</span>
          <span className="reticulum-mode-label-compact">{compactLabel}</span>
        </span>
      </ButtonBase>
    </Tooltip>
  );
}
