import { Avatar, Box, Chip, Typography, alpha, useTheme } from '@mui/material';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import { useTranslation } from 'react-i18next';
import qortalWhiteLogo from '../../assets/sidebar/qortal-logo-white.png';
import qortinoHead from '../../assets/svgs/QortinoHead.svg';
import { ReticulumModePill } from '../Group/ReticulumModePill';

type PreviewChannel = {
  emoji: string;
  labelKey: string;
  locked?: boolean;
  unread?: boolean;
  target?: boolean;
};

const channelSections: Array<{
  labelKey?: string;
  channels: PreviewChannel[];
}> = [
  {
    channels: [
      {
        emoji: '📣',
        labelKey: 'announcements',
        locked: true,
      },
      { emoji: '📖', labelKey: 'rules', locked: true, target: true },
    ],
  },
  {
    labelKey: 'community',
    channels: [
      { emoji: '💬', labelKey: 'general_chat' },
      { emoji: '💙', labelKey: 'qortal_land' },
      { emoji: '⚡', labelKey: 'qortal_marketing', unread: true },
      { emoji: '📈', labelKey: 'qort_trading' },
    ],
  },
  {
    labelKey: 'support',
    channels: [
      { emoji: '💡', labelKey: 'tasks_and_ideas' },
      { emoji: '🤖', labelKey: 'bug_reports', unread: true },
    ],
  },
  {
    labelKey: 'official',
    channels: [{ emoji: '🔗', labelKey: 'official_links', locked: true }],
  },
];

export function OnboardingQChatPreview() {
  const { t } = useTranslation(['group']);
  const theme = useTheme();

  return (
    <Box
      data-testid="onboarding-qchat-preview"
      sx={{
        backgroundColor: 'background.default',
        display: 'flex',
        inset: 0,
        minHeight: 0,
        pointerEvents: 'none',
        position: 'absolute',
        zIndex: 40,
      }}
    >
      <Box
        aria-hidden
        sx={{
          alignItems: 'center',
          backgroundColor: 'background.paper',
          borderRight: `1px solid ${theme.palette.divider}`,
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          gap: 1.5,
          py: 1.5,
          width: 72,
        }}
      >
        <Avatar
          src={qortalWhiteLogo}
          sx={{
            backgroundColor: 'background.default',
            border: `1px solid ${theme.palette.divider}`,
            height: 38,
            p: 0.8,
            width: 38,
          }}
        />
        <Avatar
          src={qortalWhiteLogo}
          sx={{
            backgroundColor: alpha(theme.palette.primary.main, 0.18),
            border: `2px solid ${theme.palette.primary.main}`,
            height: 42,
            p: 0.8,
            width: 42,
          }}
        />
      </Box>

      <Box
        sx={{
          backgroundColor: 'background.surface',
          borderRight: `1px solid ${theme.palette.divider}`,
          flexShrink: 0,
          overflow: 'hidden',
          width: { xs: 224, md: 240 },
        }}
      >
        <Box
          sx={{
            alignItems: 'center',
            borderBottom: `1px solid ${alpha(theme.palette.divider, 0.72)}`,
            display: 'flex',
            gap: 0.75,
            minHeight: 50,
            px: 1.5,
          }}
        >
          <PublicRoundedIcon sx={{ color: 'text.secondary', fontSize: 15 }} />
          <Typography noWrap sx={{ flex: 1, fontSize: 15, fontWeight: 650 }}>
            Qortal Project
          </Typography>
          <ExpandMoreRoundedIcon
            sx={{ color: 'text.secondary', fontSize: 17 }}
          />
        </Box>

        <Box sx={{ overflow: 'hidden', px: 1, py: 1 }}>
          {channelSections.map((section, sectionIndex) => (
            <Box key={section.labelKey || `default-${sectionIndex}`}>
              {section.labelKey && (
                <Box
                  sx={{
                    alignItems: 'center',
                    backgroundColor: 'action.hover',
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: '7px',
                    color: 'text.secondary',
                    display: 'flex',
                    fontSize: 10,
                    fontWeight: 600,
                    justifyContent: 'space-between',
                    letterSpacing: '0.08em',
                    minHeight: 32,
                    mt: sectionIndex === 1 ? 0.5 : 1,
                    px: 1.5,
                    textTransform: 'uppercase',
                  }}
                >
                  {t(`group:onboarding.preview.category.${section.labelKey}`)}
                  <ExpandMoreRoundedIcon sx={{ fontSize: 14 }} />
                </Box>
              )}
              <Box sx={{ px: 1, pt: section.labelKey ? 0.75 : 0 }}>
                {section.channels.map((channel) => (
                  <Box
                    data-tour={
                      channel.target ? 'hub-onboarding-channel' : undefined
                    }
                    key={channel.labelKey}
                    sx={{
                      alignItems: 'center',
                      borderRadius: '6px',
                      color: channel.target ? 'text.primary' : 'text.secondary',
                      display: 'flex',
                      fontSize: 14,
                      fontWeight: 500,
                      gap: 0.75,
                      mb: 0.5,
                      minHeight: 30,
                      overflow: 'hidden',
                      px: 0.75,
                    }}
                  >
                    {channel.locked ? (
                      <LockRoundedIcon
                        sx={{ color: 'text.disabled', fontSize: 16 }}
                      />
                    ) : (
                      <PublicRoundedIcon
                        sx={{ color: 'text.disabled', fontSize: 16 }}
                      />
                    )}
                    <Box component="span" aria-hidden>
                      {channel.emoji}
                    </Box>
                    <Box
                      component="span"
                      sx={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t(
                        `group:onboarding.preview.channel.${channel.labelKey}`
                      )}
                    </Box>
                    {channel.unread ? (
                      <Box
                        aria-hidden
                        sx={{
                          backgroundColor: 'error.main',
                          borderRadius: '50%',
                          height: 8,
                          width: 8,
                        }}
                      />
                    ) : (
                      <ScheduleRoundedIcon
                        sx={{ color: 'text.disabled', fontSize: 13 }}
                      />
                    )}
                  </Box>
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>

      <Box
        sx={{
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <Box
          sx={{
            alignItems: 'center',
            borderBottom: `1px solid ${theme.palette.divider}`,
            display: 'flex',
            flexShrink: 0,
            gap: 1,
            minHeight: 50,
            px: 1.5,
          }}
        >
          <Typography sx={{ flex: 1, fontSize: 17, fontWeight: 700 }}>
            📖 {t('group:onboarding.preview.channel.rules')}
          </Typography>
          <Box data-tour="hub-group-qortal-land">
            <ReticulumModePill target="qortal_land" onClick={() => undefined} />
          </Box>
        </Box>

        <Box
          sx={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
            p: { xs: 2, md: 3 },
          }}
        >
          <Box
            sx={{
              alignItems: 'center',
              backgroundColor: alpha(theme.palette.info.main, 0.1),
              border: `1px solid ${alpha(theme.palette.info.main, 0.35)}`,
              borderRadius: 2,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1,
              mb: 3,
              px: 2,
              py: 1.25,
            }}
          >
            <Chip
              color="info"
              label={t('group:onboarding.preview.badge')}
              size="small"
              sx={{ fontSize: 11, fontWeight: 800 }}
            />
            <Typography color="text.secondary" sx={{ fontSize: 13.5 }}>
              {t('group:onboarding.preview.notice')}
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', gap: 1.25, maxWidth: 760 }}>
            <Avatar
              alt="Qortino"
              src={qortinoHead}
              sx={{
                backgroundColor: 'background.paper',
                border: `1px solid ${theme.palette.warning.main}`,
                height: 44,
                width: 44,
              }}
            />
            <Box sx={{ minWidth: 0 }}>
              <Box
                sx={{
                  alignItems: 'center',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 0.75,
                  mb: 0.75,
                }}
              >
                <Typography
                  sx={{ color: 'warning.main', fontSize: 15, fontWeight: 750 }}
                >
                  Qortino
                </Typography>
                <Chip
                  label={t('group:onboarding.preview.owner')}
                  size="small"
                  variant="outlined"
                  sx={{
                    borderColor: 'warning.main',
                    color: 'warning.main',
                    fontSize: 10,
                    fontWeight: 700,
                    height: 20,
                  }}
                />
              </Box>
              <Typography
                sx={{ color: 'text.secondary', fontSize: 14, lineHeight: 1.6 }}
              >
                {t('group:onboarding.preview.qortino_message')}
              </Typography>
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
