import AutoDeleteRoundedIcon from '@mui/icons-material/AutoDeleteRounded';
import BoltRoundedIcon from '@mui/icons-material/BoltRounded';
import CallRoundedIcon from '@mui/icons-material/CallRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded';
import ForumRoundedIcon from '@mui/icons-material/ForumRounded';
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import LeaderboardRoundedIcon from '@mui/icons-material/LeaderboardRounded';
import SportsEsportsRoundedIcon from '@mui/icons-material/SportsEsportsRounded';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Typography,
  useTheme,
} from '@mui/material';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import reticulumQChat2026 from '../../assets/qchat/reticulum-qchat-2026.png';

type QChatWhatsNewDialogProps = {
  onClose: () => void;
  open: boolean;
};

type ReleaseHighlight = {
  icon: ReactNode;
  /** Key suffix under group:whats_new.highlights */
  id: string;
};

const QCHAT_RELEASE_VERSION = '3.0.2';

const RELEASE_HIGHLIGHTS: ReleaseHighlight[] = [
  { icon: <HubRoundedIcon />, id: 'network' },
  { icon: <ForumRoundedIcon />, id: 'channels' },
  { icon: <AutoDeleteRoundedIcon />, id: 'expiry' },
  { icon: <CallRoundedIcon />, id: 'calls' },
  { icon: <SportsEsportsRoundedIcon />, id: 'qortalland' },
  { icon: <LeaderboardRoundedIcon />, id: 'discovery' },
];

/** Key suffixes under group:whats_new.comparison */
const COMPARISON_ROW_IDS = [
  'transport',
  'organization',
  'live',
  'discovery',
] as const;

export function QChatWhatsNewDialog({
  onClose,
  open,
}: QChatWhatsNewDialogProps) {
  const { t } = useTranslation(['group']);
  const theme = useTheme();

  return (
    <Dialog
      fullWidth
      maxWidth="md"
      onClose={onClose}
      open={open}
      PaperProps={{
        sx: {
          backgroundColor: theme.palette.background.paper,
          backgroundImage: 'none',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: '12px',
          boxShadow: '0 24px 70px rgba(0, 0, 0, 0.45)',
          maxHeight: 'min(780px, calc(100vh - 64px))',
          overflow: 'hidden',
        },
      }}
    >
      <DialogTitle
        sx={{
          alignItems: 'center',
          display: 'flex',
          justifyContent: 'space-between',
          px: { xs: 2.5, sm: 3.5 },
          py: 2.5,
        }}
      >
        <Box>
          <Typography
            component="h2"
            sx={{ fontSize: 26, fontWeight: 750, lineHeight: 1.2 }}
          >
            {t('group:whats_new.title')}
          </Typography>
          <Typography
            sx={{
              color: 'text.secondary',
              fontSize: 13,
              fontWeight: 600,
              mt: 0.5,
            }}
          >
            {t('group:whats_new.version', {
              version: QCHAT_RELEASE_VERSION,
            })}
          </Typography>
        </Box>
        <IconButton
          aria-label={t('group:whats_new.close')}
          onClick={onClose}
          size="small"
          sx={{ color: 'text.secondary' }}
        >
          <CloseRoundedIcon />
        </IconButton>
      </DialogTitle>

      <Divider />

      <DialogContent
        sx={{
          px: { xs: 2.5, sm: 3.5 },
          py: 3,
          scrollbarColor: `${theme.palette.action.selected} transparent`,
        }}
      >
        <Box
          sx={{
            background:
              'linear-gradient(135deg, rgba(22, 139, 255, 0.14), rgba(15, 23, 42, 0.08))',
            border: '1px solid rgba(80, 165, 255, 0.24)',
            borderRadius: '10px',
            mb: 3,
            px: { xs: 2, sm: 2.5 },
            py: 2.25,
          }}
        >
          <Box sx={{ alignItems: 'center', display: 'flex', gap: 1 }}>
            <BoltRoundedIcon sx={{ color: '#52a8ff', fontSize: 22 }} />
            <Typography sx={{ fontSize: 18, fontWeight: 700 }}>
              {t('group:whats_new.intro_title')}
            </Typography>
          </Box>
          <Typography
            sx={{
              color: 'text.secondary',
              fontSize: 14,
              lineHeight: 1.65,
              mt: 1,
              maxWidth: 680,
            }}
          >
            {t('group:whats_new.intro_body')}
          </Typography>
        </Box>

        <Typography sx={{ fontSize: 17, fontWeight: 700, mb: 1.5 }}>
          {t('group:whats_new.highlights_title')}
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gap: 1.25,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          }}
        >
          {RELEASE_HIGHLIGHTS.map((item) => (
            <Box
              key={item.id}
              sx={{
                backgroundColor: 'action.hover',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '9px',
                display: 'flex',
                gap: 1.5,
                p: 1.75,
              }}
            >
              <Box
                sx={{
                  alignItems: 'center',
                  backgroundColor: 'rgba(22, 139, 255, 0.12)',
                  borderRadius: '8px',
                  color: '#52a8ff',
                  display: 'flex',
                  flex: '0 0 auto',
                  height: 36,
                  justifyContent: 'center',
                  width: 36,
                  '& svg': { fontSize: 20 },
                }}
              >
                {item.icon}
              </Box>
              <Box>
                <Typography sx={{ fontSize: 14.5, fontWeight: 700 }}>
                  {t(`group:whats_new.highlights.${item.id}.title`)}
                </Typography>
                <Typography
                  sx={{
                    color: 'text.secondary',
                    fontSize: 13,
                    lineHeight: 1.55,
                    mt: 0.5,
                  }}
                >
                  {t(`group:whats_new.highlights.${item.id}.description`)}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>

        <Box sx={{ mt: 3.25 }}>
          <Box sx={{ alignItems: 'center', display: 'flex', gap: 1 }}>
            <GroupsRoundedIcon sx={{ color: '#52a8ff', fontSize: 21 }} />
            <Typography sx={{ fontSize: 17, fontWeight: 700 }}>
              {t('group:whats_new.comparison.title')}
            </Typography>
          </Box>
          <Typography
            sx={{
              color: 'text.secondary',
              fontSize: 13.5,
              lineHeight: 1.6,
              mt: 0.75,
            }}
          >
            {t('group:whats_new.comparison.body')}
          </Typography>

          <Box
            role="table"
            aria-label={t('group:whats_new.comparison.aria_label')}
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: '9px',
              mt: 1.5,
              overflow: 'hidden',
            }}
          >
            <Box
              role="row"
              sx={{
                backgroundColor: 'action.hover',
                display: 'grid',
                gap: 1,
                gridTemplateColumns: '0.75fr 1.2fr 1.2fr',
                px: 1.75,
                py: 1.1,
              }}
            >
              {['column_area', 'column_legacy', 'column_reticulum'].map(
                (columnKey) => (
                  <Typography
                    key={columnKey}
                    role="columnheader"
                    sx={{ fontSize: 12, fontWeight: 700 }}
                  >
                    {t(`group:whats_new.comparison.${columnKey}`)}
                  </Typography>
                )
              )}
            </Box>
            {COMPARISON_ROW_IDS.map((rowId, index) => (
              <Box
                key={rowId}
                role="row"
                sx={{
                  borderTop: index === 0 ? '1px solid' : '1px solid',
                  borderColor: 'divider',
                  display: 'grid',
                  gap: 1,
                  gridTemplateColumns: '0.75fr 1.2fr 1.2fr',
                  px: 1.75,
                  py: 1.25,
                }}
              >
                <Typography
                  role="cell"
                  sx={{ fontSize: 12.5, fontWeight: 650 }}
                >
                  {t(`group:whats_new.comparison.${rowId}.area`)}
                </Typography>
                <Typography
                  role="cell"
                  sx={{ color: 'text.secondary', fontSize: 12.5 }}
                >
                  {t(`group:whats_new.comparison.${rowId}.legacy`)}
                </Typography>
                <Typography
                  role="cell"
                  sx={{ color: 'text.secondary', fontSize: 12.5 }}
                >
                  {t(`group:whats_new.comparison.${rowId}.reticulum`)}
                </Typography>
              </Box>
            ))}
          </Box>

          <Box
            sx={{
              display: 'grid',
              gap: 1.5,
              gridTemplateColumns: {
                xs: 'minmax(0, 1fr)',
                sm: 'repeat(2, minmax(0, 1fr))',
              },
              mt: 2,
            }}
          >
            <Box>
              <Typography sx={{ fontSize: 13, fontWeight: 700, mb: 0.75 }}>
                {t('group:whats_new.gallery.legacy_caption')}
              </Typography>
              <Box
                aria-label={t(
                  'group:whats_new.gallery.legacy_placeholder_aria'
                )}
                sx={{
                  alignItems: 'center',
                  aspectRatio: '16 / 9',
                  backgroundColor: 'action.hover',
                  border: '1px dashed',
                  borderColor: 'divider',
                  borderRadius: '9px',
                  color: 'text.secondary',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 0.75,
                  justifyContent: 'center',
                  minHeight: 150,
                  position: 'relative',
                  px: 2,
                  textAlign: 'center',
                }}
              >
                <FavoriteRoundedIcon
                  aria-label={t('group:whats_new.gallery.legacy_heart_aria')}
                  sx={{
                    color: '#ef476f',
                    fontSize: 23,
                    left: 12,
                    position: 'absolute',
                    top: 10,
                  }}
                />
                <ForumRoundedIcon sx={{ fontSize: 28, opacity: 0.65 }} />
                <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>
                  {t('group:whats_new.gallery.legacy_placeholder_text')}
                </Typography>
              </Box>
            </Box>
            <Box>
              <Typography sx={{ fontSize: 13, fontWeight: 700, mb: 0.75 }}>
                {t('group:whats_new.gallery.reticulum_caption')}
              </Typography>
              <Box
                sx={{
                  aspectRatio: '16 / 9',
                  backgroundColor: 'action.hover',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '9px',
                  overflow: 'hidden',
                  position: 'relative',
                  width: '100%',
                }}
              >
                <Box
                  alt={t('group:whats_new.gallery.reticulum_alt')}
                  component="img"
                  src={reticulumQChat2026}
                  sx={{
                    display: 'block',
                    height: '100%',
                    objectFit: 'contain',
                    width: '100%',
                  }}
                />
                <StarRoundedIcon
                  aria-label={t('group:whats_new.gallery.reticulum_star_aria')}
                  sx={{
                    color: '#f6c344',
                    filter: 'drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55))',
                    fontSize: 25,
                    left: 12,
                    position: 'absolute',
                    top: 10,
                  }}
                />
              </Box>
            </Box>
          </Box>
        </Box>

        <Typography
          sx={{
            color: 'text.secondary',
            fontSize: 13.5,
            lineHeight: 1.65,
            mt: 3,
            pb: 0.5,
          }}
        >
          {t('group:whats_new.closing_note')}
        </Typography>
      </DialogContent>
    </Dialog>
  );
}
