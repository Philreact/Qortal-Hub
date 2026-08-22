export const HUB_ONBOARDING_STORAGE_KEY = 'hub-onboarding-v1-status';
export const HUB_ONBOARDING_RESTART_EVENT = 'hub-onboarding-restart';
export const HUB_ONBOARDING_QCHAT_PREVIEW_LOCK_ATTRIBUTE =
  'data-hub-onboarding-qchat-preview-locked';
export const HUB_ONBOARDING_QCHAT_PREVIEW_LOCK_EVENT =
  'hub-onboarding-qchat-preview-lock';
export const HUB_ONBOARDING_COMPACT_VIEWPORT_QUERY = '(max-height: 820px)';

export type HubOnboardingStatus = 'completed' | 'pending' | 'skipped';
export type HubOnboardingDirection = 'backward' | 'forward';
export type HubOnboardingSurface = 'apps' | 'home' | 'qchat' | 'qchat-directs';
export type HubOnboardingDashboardStep =
  | 'explore-qapps'
  | 'featured-qapps'
  | 'open-qchat';

export const getHubOnboardingDashboardStepLayout = (
  step: HubOnboardingDashboardStep,
  compact: boolean
) => {
  if (!compact) return {};

  return {
    placement:
      step === 'featured-qapps' ? ('right' as const) : ('top' as const),
    skipScroll: true,
  };
};

export const getHubOnboardingSurface = (
  stepIndex: number
): HubOnboardingSurface => {
  if (stepIndex <= 1) return 'home';
  if (stepIndex <= 6) return 'qchat';
  if (stepIndex <= 9) return 'qchat-directs';
  if (stepIndex <= 11) return 'home';
  return 'apps';
};

export const getAdjacentHubOnboardingStep = (
  index: number,
  direction: HubOnboardingDirection,
  size: number
) =>
  Math.max(0, Math.min(index + (direction === 'backward' ? -1 : 1), size - 1));

export const readHubOnboardingStatus = (): HubOnboardingStatus | null => {
  if (typeof window === 'undefined') return null;

  try {
    const value = window.localStorage.getItem(HUB_ONBOARDING_STORAGE_KEY);
    return value === 'completed' || value === 'pending' || value === 'skipped'
      ? value
      : null;
  } catch {
    return null;
  }
};

export const writeHubOnboardingStatus = (status: HubOnboardingStatus) => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(HUB_ONBOARDING_STORAGE_KEY, status);
  } catch {
    // The tour still works for the current session when storage is unavailable.
  }
};

export const requestHubOnboardingRestart = () => {
  writeHubOnboardingStatus('pending');
  window.dispatchEvent(new CustomEvent(HUB_ONBOARDING_RESTART_EVENT));
};
