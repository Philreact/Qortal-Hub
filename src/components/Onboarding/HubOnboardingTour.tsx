import { InfoOutlined } from '@mui/icons-material';
import {
  Box,
  Button,
  ButtonBase,
  Dialog,
  Typography,
  alpha,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  ACTIONS,
  EVENTS,
  Joyride,
  STATUS,
  type EventData,
  type Step,
} from 'react-joyride';
import {
  getAdjacentHubOnboardingStep,
  getHubOnboardingDashboardStepLayout,
  getHubOnboardingSurface,
  HUB_ONBOARDING_COMPACT_VIEWPORT_QUERY,
  HUB_ONBOARDING_QCHAT_PREVIEW_LOCK_ATTRIBUTE,
  HUB_ONBOARDING_QCHAT_PREVIEW_LOCK_EVENT,
  HUB_ONBOARDING_RESTART_EVENT,
  readHubOnboardingStatus,
  writeHubOnboardingStatus,
} from './hubOnboarding';
import { executeEvent } from '../../utils/events';
import qortalLandLoungePreview from '../../assets/onboarding/qortalland-lounge-preview.webp';
import { HOME_WIDE_DASHBOARD_MIN_WIDTH_PX } from '../Group/HomeDesktop/homeDesktopConstants';

type HubOnboardingTourProps = {
  closeGroupDiscovery: () => void;
  closeQChatPreview: () => void;
  navigateHome: () => void;
  navigateQChat: () => void;
  openQortalProject: () => Promise<'member' | 'preview'>;
  qortalProjectMember: boolean | null;
  showDirectMessages: () => void;
  showGroupDiscovery: () => void;
};

const selectors = {
  channel: '[data-tour="hub-onboarding-channel"]',
  directMessages: '[data-tour="hub-direct-messages"]',
  dmExpiry: '[data-tour="hub-dm-expiry"]',
  exploreApps: '[data-tour="hub-explore-qapps"]',
  featuredApps: '[data-tour="hub-featured-qapps"]',
  groupDiscovery: '[data-tour="hub-group-discovery"]',
  groupSearch: '[data-tour="hub-group-search"]',
  homePage: '[data-tour="hub-home-page"]',
  qortalProjectAction: '[data-tour="hub-qortal-project-action"]',
  qortalLandGroup: '[data-tour="hub-group-qortal-land"]',
  qChatOpenButton: '[data-tour="hub-featured-qchat-open"]',
  qortalLandDashboard: '[data-tour="hub-dashboard-qortal-land"]',
  topHome: '[data-tour="hub-top-home"]',
} as const;

const waitForLayout = () =>
  new Promise<void>((resolve) => window.setTimeout(resolve, 180));

const findVisibleTarget = (selector: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter((target) => {
      const rect = target.getBoundingClientRect();
      return (
        rect.width > 8 &&
        rect.height > 8 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    })
    .sort(
      (left, right) =>
        left.getBoundingClientRect().top - right.getBoundingClientRect().top
    )[0] ?? null;

const waitForTarget = (
  resolveTarget: () => HTMLElement | null,
  timeoutMs = 3500
) =>
  new Promise<void>((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (resolveTarget() || Date.now() - startedAt >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(check, 80);
    };
    check();
  });

const visibleTargetOrBody = (target: string) =>
  findVisibleTarget(target) ?? document.body;

const resetHubOnboardingViewport = () => {
  const scrollingElement = document.scrollingElement as HTMLElement | null;
  const scrollTargets = [
    scrollingElement,
    document.documentElement,
    document.body,
    document.querySelector<HTMLElement>(selectors.homePage),
  ].filter((target): target is HTMLElement => Boolean(target));

  window.scrollTo({ behavior: 'auto', left: 0, top: 0 });
  scrollTargets.forEach((target) => {
    target.scrollLeft = 0;
    target.scrollTop = 0;
  });
};

type TourCopyProps = {
  infoKey?: string;
  mergeSecondaryAndTertiary?: boolean;
  primaryKey: string;
  secondaryKey?: string;
  tertiaryKey?: string;
};

function TourCopy({
  infoKey,
  mergeSecondaryAndTertiary = false,
  primaryKey,
  secondaryKey,
  tertiaryKey,
}: TourCopyProps) {
  const translatedCopy = (key: string) => (
    <Trans
      i18nKey={key}
      components={{
        emphasis: (
          <Box
            component="span"
            sx={{ color: 'text.primary', fontWeight: 600 }}
          />
        ),
      }}
    />
  );

  return (
    <Box sx={{ color: 'text.secondary' }}>
      <Typography
        component="div"
        sx={{ fontSize: 'inherit', lineHeight: 1.5, whiteSpace: 'pre-line' }}
      >
        {translatedCopy(primaryKey)}
      </Typography>
      {secondaryKey && (
        <Typography
          component="div"
          sx={{
            fontSize: 'inherit',
            lineHeight: 1.5,
            mt: 1.5,
            whiteSpace: 'pre-line',
          }}
        >
          {translatedCopy(secondaryKey)}
          {mergeSecondaryAndTertiary && tertiaryKey ? (
            <> {translatedCopy(tertiaryKey)}</>
          ) : null}
        </Typography>
      )}
      {tertiaryKey && !mergeSecondaryAndTertiary && (
        <Typography
          component="div"
          sx={{
            fontSize: 'inherit',
            lineHeight: 1.5,
            mt: 1.5,
            whiteSpace: 'pre-line',
          }}
        >
          {translatedCopy(tertiaryKey)}
        </Typography>
      )}
      {infoKey && (
        <Box
          sx={{
            alignItems: 'flex-start',
            display: 'flex',
            gap: 0.75,
            mt: 1.5,
          }}
        >
          <InfoOutlined
            aria-hidden
            sx={{ color: 'text.secondary', fontSize: 14, mt: '3px' }}
          />
          <Typography
            component="div"
            sx={{ fontSize: '0.86em', fontStyle: 'italic', lineHeight: 1.5 }}
          >
            {translatedCopy(infoKey)}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

const openAppsLibrary = () => {
  executeEvent('openAppsLibrarySearch', { data: { query: '' } });
  executeEvent('open-apps-mode', {});
};

export function HubOnboardingTour({
  closeGroupDiscovery,
  closeQChatPreview,
  navigateHome,
  navigateQChat,
  openQortalProject,
  qortalProjectMember,
  showDirectMessages,
  showGroupDiscovery,
}: HubOnboardingTourProps) {
  const { t } = useTranslation(['group']);
  const theme = useTheme();
  const compactDashboardTour = useMediaQuery(
    HUB_ONBOARDING_COMPACT_VIEWPORT_QUERY
  );
  const onboardingDesktopAvailable = useMediaQuery(
    theme.breakpoints.up(HOME_WIDE_DASHBOARD_MIN_WIDTH_PX)
  );
  const continueWithProgressLabel = t(
    'group:onboarding.action.continue_with_progress',
    { current: '{current}', total: '{total}' }
  );
  const [run, setRun] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [pending, setPending] = useState(() => {
    const status = readHubOnboardingStatus();
    return status === 'pending' || status === null;
  });
  const [skipReminderOpen, setSkipReminderOpen] = useState(false);
  const [qortalLandPreviewOpen, setQortalLandPreviewOpen] = useState(false);
  const stepIndexRef = useRef(stepIndex);

  useEffect(() => {
    stepIndexRef.current = stepIndex;
  }, [stepIndex]);

  useEffect(() => {
    if (!run) return;

    resetHubOnboardingViewport();
    const frame = window.requestAnimationFrame(resetHubOnboardingViewport);
    const settleTimer = window.setTimeout(resetHubOnboardingViewport, 250);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
    };
  }, [run, stepIndex]);

  const startWhenHomeIsReady = useCallback(() => {
    if (!onboardingDesktopAvailable) return false;
    if (!document.querySelector(selectors.homePage)) return false;
    setStepIndex(0);
    stepIndexRef.current = 0;
    setRun(true);
    setPending(false);
    writeHubOnboardingStatus('pending');
    return true;
  }, [onboardingDesktopAvailable]);

  useEffect(() => {
    if (!pending) return;
    if (startWhenHomeIsReady()) return;

    const observer = new MutationObserver(() => {
      if (startWhenHomeIsReady()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pending, startWhenHomeIsReady]);

  useEffect(() => {
    if (onboardingDesktopAvailable || !run) return;

    setQortalLandPreviewOpen(false);
    setRun(false);
    setStepIndex(0);
    stepIndexRef.current = 0;
    setPending(true);
    closeGroupDiscovery();
    closeQChatPreview();
  }, [closeGroupDiscovery, closeQChatPreview, onboardingDesktopAvailable, run]);

  useEffect(() => {
    const restart = () => {
      setQortalLandPreviewOpen(false);
      setRun(false);
      setStepIndex(0);
      stepIndexRef.current = 0;
      setPending(true);
    };
    window.addEventListener(HUB_ONBOARDING_RESTART_EVENT, restart);
    return () =>
      window.removeEventListener(HUB_ONBOARDING_RESTART_EVENT, restart);
  }, []);

  const prepareStepSurface = useCallback(
    (nextIndex: number) => {
      resetHubOnboardingViewport();
      const surface = getHubOnboardingSurface(nextIndex);

      if (surface === 'home') {
        closeGroupDiscovery();
        navigateHome();
        return;
      }

      if (surface === 'qchat' || surface === 'qchat-directs') {
        navigateQChat();
        if (surface === 'qchat-directs') showDirectMessages();
      }
    },
    [closeGroupDiscovery, navigateHome, navigateQChat, showDirectMessages]
  );

  const moveToStep = useCallback(
    (nextIndex: number) => {
      prepareStepSurface(nextIndex);
      stepIndexRef.current = nextIndex;
      setStepIndex(nextIndex);
    },
    [prepareStepSurface]
  );

  useEffect(() => {
    const lockPreview = run && stepIndex === 1;
    document.body.toggleAttribute(
      HUB_ONBOARDING_QCHAT_PREVIEW_LOCK_ATTRIBUTE,
      lockPreview
    );
    window.dispatchEvent(
      new CustomEvent(HUB_ONBOARDING_QCHAT_PREVIEW_LOCK_EVENT)
    );

    return () => {
      if (lockPreview) {
        document.body.removeAttribute(
          HUB_ONBOARDING_QCHAT_PREVIEW_LOCK_ATTRIBUTE
        );
        window.dispatchEvent(
          new CustomEvent(HUB_ONBOARDING_QCHAT_PREVIEW_LOCK_EVENT)
        );
      }
    };
  }, [run, stepIndex]);

  const steps = useMemo<Step[]>(
    () => [
      {
        buttons: ['skip', 'primary'],
        content: <TourCopy primaryKey="group:onboarding.welcome.copy" />,
        id: 'welcome',
        locale: {
          next: t('group:onboarding.action.start_tour'),
          nextWithProgress: t('group:onboarding.action.start_tour'),
          skip: t('group:onboarding.action.skip_for_now'),
        },
        placement: 'center',
        target: 'body',
        title: t('group:onboarding.welcome.title'),
      },
      {
        ...getHubOnboardingDashboardStepLayout(
          'open-qchat',
          compactDashboardTour
        ),
        before: async () => {
          closeGroupDiscovery();
          navigateHome();
          await waitForTarget(
            () => document.querySelector<HTMLElement>(selectors.homePage),
            4000
          );
          resetHubOnboardingViewport();
          await waitForTarget(
            () =>
              document.querySelector<HTMLElement>(selectors.qChatOpenButton),
            4000
          );
        },
        blockTargetInteraction: true,
        content: t('group:onboarding.open_qchat.copy'),
        id: 'open-qchat',
        target: () => visibleTargetOrBody(selectors.qChatOpenButton),
        title: t('group:onboarding.open_qchat.title'),
      },
      {
        before: async () => {
          navigateQChat();
          closeQChatPreview();
          closeGroupDiscovery();
          await waitForTarget(
            () => findVisibleTarget(selectors.groupDiscovery),
            4000
          );
        },
        beforeTimeout: 6000,
        blockTargetInteraction: true,
        content: t('group:onboarding.find_groups_location.copy'),
        id: 'find-groups-location',
        locale: {
          next: t('group:onboarding.action.continue'),
          nextWithProgress: continueWithProgressLabel,
        },
        placement: 'right',
        skipScroll: true,
        target: () => visibleTargetOrBody(selectors.groupDiscovery),
        title: t('group:onboarding.find_groups_location.title'),
      },
      {
        before: async () => {
          showGroupDiscovery();
          await waitForTarget(
            () => findVisibleTarget(selectors.groupSearch),
            4000
          );
        },
        beforeTimeout: 6000,
        blockTargetInteraction: true,
        content: <TourCopy primaryKey="group:onboarding.find_group.copy" />,
        id: 'search-groups',
        placement: 'right',
        skipScroll: true,
        target: () => visibleTargetOrBody(selectors.groupSearch),
        title: t('group:onboarding.find_group.title'),
      },
      {
        before: async () => {
          closeQChatPreview();
          if (!document.querySelector(selectors.groupSearch)) {
            showGroupDiscovery();
          }
          await waitForTarget(
            () => findVisibleTarget(selectors.qortalProjectAction),
            4000
          );
        },
        beforeTimeout: 6000,
        blockTargetInteraction: true,
        content: (
          <TourCopy
            primaryKey={
              qortalProjectMember
                ? 'group:onboarding.join_group.copy_member'
                : 'group:onboarding.join_group.copy_preview'
            }
          />
        ),
        id: 'join-group',
        locale: {
          next: t('group:onboarding.action.continue'),
          nextWithProgress: continueWithProgressLabel,
        },
        skipScroll: true,
        target: () =>
          findVisibleTarget(selectors.qortalProjectAction) ??
          findVisibleTarget(selectors.groupSearch) ??
          document.body,
        title: t('group:onboarding.join_group.title_qortal_project'),
      },
      {
        before: async () => {
          closeGroupDiscovery();
          await openQortalProject();
          await waitForTarget(() => findVisibleTarget(selectors.channel), 5000);
        },
        beforeTimeout: 18_000,
        blockTargetInteraction: true,
        content: t('group:onboarding.choose_channel.copy'),
        id: 'choose-channel',
        placement: 'right',
        target: () => visibleTargetOrBody(selectors.channel),
        title: t('group:onboarding.choose_channel.title'),
      },
      {
        before: async () => {
          closeGroupDiscovery();
          await openQortalProject();
          await waitForTarget(
            () => findVisibleTarget(selectors.qortalLandGroup),
            5000
          );
        },
        beforeTimeout: 18_000,
        blockTargetInteraction: true,
        content: (
          <Box>
            <TourCopy
              primaryKey="group:onboarding.enter_qortal_land.copy_group"
              secondaryKey="group:onboarding.enter_qortal_land.copy_group_details"
            />
            <ButtonBase
              aria-label={t('group:onboarding.enter_qortal_land.preview_open')}
              onClick={() => setQortalLandPreviewOpen(true)}
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1.5,
                display: 'block',
                mt: 1.5,
                overflow: 'hidden',
                width: '100%',
                '&:focus-visible': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2,
                },
              }}
            >
              <Box
                alt={t('group:onboarding.enter_qortal_land.preview_alt')}
                component="img"
                src={qortalLandLoungePreview}
                sx={{
                  display: 'block',
                  height: 100,
                  objectFit: 'cover',
                  width: '100%',
                }}
              />
            </ButtonBase>
          </Box>
        ),
        id: 'enter-qortal-land',
        placement: 'bottom-end',
        target: () => visibleTargetOrBody(selectors.qortalLandGroup),
        title: t('group:onboarding.enter_qortal_land.title'),
      },
      {
        before: async () => {
          navigateQChat();
          closeGroupDiscovery();
          showDirectMessages();
          await waitForTarget(
            () => findVisibleTarget(selectors.directMessages),
            4000
          );
        },
        beforeTimeout: 6000,
        blockTargetInteraction: true,
        content: (
          <TourCopy
            infoKey="group:onboarding.direct_messages.info"
            primaryKey="group:onboarding.direct_messages.copy"
          />
        ),
        id: 'direct-messages',
        placement: 'right',
        target: () => visibleTargetOrBody(selectors.directMessages),
        title: t('group:onboarding.direct_messages.title'),
      },
      {
        before: async () => {
          navigateQChat();
          showDirectMessages();
          await waitForTarget(
            () => findVisibleTarget(selectors.dmExpiry),
            4000
          );
        },
        beforeTimeout: 6000,
        blockTargetInteraction: true,
        content: (
          <TourCopy
            infoKey="group:onboarding.message_expiry.info"
            primaryKey="group:onboarding.message_expiry.copy"
          />
        ),
        id: 'message-expiry',
        target: () => visibleTargetOrBody(selectors.dmExpiry),
        title: t('group:onboarding.message_expiry.title'),
      },
      {
        before: async () => {
          navigateQChat();
          showDirectMessages();
          await waitForTarget(() => findVisibleTarget(selectors.topHome), 4000);
        },
        beforeTimeout: 6000,
        blockTargetInteraction: true,
        content: t('group:onboarding.back_to_hub.copy'),
        id: 'back-to-hub',
        placement: 'right',
        target: () => visibleTargetOrBody(selectors.topHome),
        title: t('group:onboarding.back_to_hub.title'),
      },
      {
        ...getHubOnboardingDashboardStepLayout(
          'featured-qapps',
          compactDashboardTour
        ),
        before: async () => {
          navigateHome();
          await waitForTarget(
            () => document.querySelector<HTMLElement>(selectors.featuredApps),
            4000
          );
          resetHubOnboardingViewport();
          await waitForTarget(
            () => findVisibleTarget(selectors.featuredApps),
            1000
          );
          await waitForLayout();
        },
        content: (
          <TourCopy
            mergeSecondaryAndTertiary
            primaryKey="group:onboarding.featured_qapps.copy"
            secondaryKey="group:onboarding.featured_qapps.details"
            tertiaryKey="group:onboarding.featured_qapps.decentralization"
          />
        ),
        blockTargetInteraction: true,
        id: 'featured-qapps',
        target: () => visibleTargetOrBody(selectors.featuredApps),
        title: t('group:onboarding.featured_qapps.title'),
      },
      {
        ...getHubOnboardingDashboardStepLayout(
          'explore-qapps',
          compactDashboardTour
        ),
        before: async () => {
          navigateHome();
          await waitForTarget(
            () => document.querySelector<HTMLElement>(selectors.exploreApps),
            4000
          );
          resetHubOnboardingViewport();
          await waitForTarget(
            () => findVisibleTarget(selectors.exploreApps),
            1000
          );
          await waitForLayout();
        },
        content: t('group:onboarding.explore_qapps.copy'),
        blockTargetInteraction: true,
        id: 'explore-qapps',
        locale: {
          next: t('group:onboarding.action.continue'),
          nextWithProgress: continueWithProgressLabel,
        },
        target: () => visibleTargetOrBody(selectors.exploreApps),
        title: t('group:onboarding.explore_qapps.title'),
      },
      {
        before: async () => {
          openAppsLibrary();
          await waitForLayout();
        },
        buttons: ['back', 'primary'],
        content: t('group:onboarding.ready.copy'),
        id: 'ready',
        locale: { last: t('group:onboarding.action.start_exploring') },
        placement: 'center',
        target: 'body',
        title: t('group:onboarding.ready.title'),
      },
    ],
    [
      closeGroupDiscovery,
      closeQChatPreview,
      compactDashboardTour,
      continueWithProgressLabel,
      navigateHome,
      navigateQChat,
      openQortalProject,
      qortalProjectMember,
      showDirectMessages,
      showGroupDiscovery,
      t,
    ]
  );

  const handleEvent = useCallback(
    (data: EventData) => {
      if (data.type === EVENTS.ERROR) return;

      if (data.type === EVENTS.TARGET_NOT_FOUND) {
        moveToStep(
          getAdjacentHubOnboardingStep(
            data.index,
            data.action === ACTIONS.PREV ? 'backward' : 'forward',
            steps.length
          )
        );
        return;
      }

      if (data.type === EVENTS.STEP_AFTER) {
        if (data.action === ACTIONS.PREV) {
          moveToStep(Math.max(0, data.index - 1));
        } else if (
          data.action === ACTIONS.NEXT ||
          data.action === ACTIONS.CLOSE
        ) {
          moveToStep(Math.min(data.index + 1, steps.length));
        }
        return;
      }

      if (data.type !== EVENTS.TOUR_END) return;
      setQortalLandPreviewOpen(false);
      setRun(false);
      setPending(false);
      closeGroupDiscovery();
      closeQChatPreview();
      if (data.status === STATUS.SKIPPED) {
        writeHubOnboardingStatus('skipped');
        setSkipReminderOpen(true);
      } else if (data.status === STATUS.FINISHED) {
        writeHubOnboardingStatus('completed');
      }
    },
    [closeGroupDiscovery, closeQChatPreview, moveToStep, steps.length]
  );

  const tooltipBackground = theme.palette.background.paper;

  return (
    <>
      <Joyride
        continuous
        onEvent={handleEvent}
        options={{
          arrowColor: tooltipBackground,
          backgroundColor: tooltipBackground,
          blockTargetInteraction: false,
          buttons: ['back', 'skip', 'primary'],
          closeButtonAction: 'skip',
          dismissKeyAction: false,
          offset: 12,
          overlayClickAction: false,
          overlayColor: alpha(theme.palette.common.black, 0.68),
          primaryColor: theme.palette.primary.main,
          showProgress: true,
          skipBeacon: true,
          skipScroll: true,
          spotlightPadding: 8,
          spotlightRadius: 12,
          targetWaitTimeout: 2500,
          textColor: theme.palette.text.primary,
          width: 'min(420px, calc(100vw - 32px))',
          zIndex: 15000,
        }}
        locale={{
          back: t('group:onboarding.action.back'),
          last: t('group:onboarding.action.start_exploring'),
          next: t('group:onboarding.action.next'),
          nextWithProgress: t('group:onboarding.action.next_with_progress'),
          skip: t('group:onboarding.action.skip'),
        }}
        run={run}
        stepIndex={stepIndex}
        steps={steps}
        styles={{
          buttonBack: {
            background: 'transparent',
            border: 0,
            color: theme.palette.text.secondary,
            cursor: 'pointer',
            fontFamily: 'Inter, sans-serif',
            fontSize: 13,
            fontWeight: 650,
            padding: '9px 12px',
          },
          buttonPrimary: {
            background: `linear-gradient(180deg, ${theme.palette.primary.light} 0%, ${theme.palette.primary.main} 100%)`,
            border: `1px solid ${alpha(theme.palette.primary.light, 0.8)}`,
            borderRadius: 9,
            boxShadow: `0 4px 12px ${alpha(theme.palette.primary.main, 0.26)}`,
            color: theme.palette.primary.contrastText,
            cursor: 'pointer',
            fontFamily: 'Inter, sans-serif',
            fontSize: 13,
            fontWeight: 700,
            minHeight: 38,
            padding: '8px 15px',
          },
          buttonSkip: {
            background: 'transparent',
            border: 0,
            color: theme.palette.text.secondary,
            cursor: 'pointer',
            fontFamily: 'Inter, sans-serif',
            fontSize: 13,
            fontWeight: 650,
            padding: '9px 4px',
          },
          tooltip: {
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 14,
            boxShadow: theme.shadows[16],
            fontFamily: 'Inter, sans-serif',
            padding: '22px 22px 18px',
          },
          tooltipContent: {
            color: theme.palette.text.secondary,
            fontSize: 14,
            lineHeight: 1.55,
            padding: '8px 0 4px',
            textAlign: 'left',
          },
          tooltipFooter: {
            alignItems: 'center',
            borderTop: `1px solid ${theme.palette.divider}`,
            display: 'flex',
            gap: 4,
            marginTop: 16,
            paddingTop: 14,
          },
          tooltipTitle: {
            color: theme.palette.text.primary,
            fontSize: 20,
            fontWeight: 750,
            letterSpacing: '-0.025em',
            lineHeight: 1.2,
            margin: 0,
            textAlign: 'left',
          },
        }}
      />

      <Dialog
        maxWidth={false}
        onClose={() => setQortalLandPreviewOpen(false)}
        open={qortalLandPreviewOpen}
        sx={{ zIndex: 16000 }}
        slotProps={{
          paper: {
            sx: {
              backgroundColor: 'transparent',
              backgroundImage: 'none',
              boxShadow: 'none',
              m: 2,
              maxWidth: 'min(1500px, calc(100vw - 32px))',
              overflow: 'visible',
            },
          },
        }}
      >
        <Box
          alt={t('group:onboarding.enter_qortal_land.preview_alt')}
          component="img"
          src={qortalLandLoungePreview}
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 2,
            boxShadow: 24,
            display: 'block',
            maxHeight: 'calc(100vh - 48px)',
            maxWidth: '100%',
            objectFit: 'contain',
          }}
        />
      </Dialog>

      <Dialog
        fullWidth
        maxWidth="xs"
        onClose={() => setSkipReminderOpen(false)}
        open={skipReminderOpen}
        slotProps={{
          paper: {
            sx: {
              backgroundImage: 'none',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: '14px',
              boxShadow: 18,
            },
          },
        }}
      >
        <Box sx={{ px: 2.6, pb: 2.3, pt: 2.5 }}>
          <Typography sx={{ fontSize: '1.05rem', fontWeight: 750 }}>
            {t('group:onboarding.skip_reminder.title')}
          </Typography>
          <Typography
            sx={{
              color: 'text.secondary',
              fontSize: '0.84rem',
              lineHeight: 1.55,
              mt: 0.8,
            }}
          >
            {t('group:onboarding.skip_reminder.copy')}
          </Typography>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2.2 }}>
            <Button
              onClick={() => setSkipReminderOpen(false)}
              variant="contained"
            >
              {t('group:onboarding.action.got_it')}
            </Button>
          </Box>
        </Box>
      </Dialog>
    </>
  );
}
