import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAdjacentHubOnboardingStep,
  getHubOnboardingDashboardStepLayout,
  getHubOnboardingSurface,
  HUB_ONBOARDING_FEATURED_QAPPS_COMPACT_WIDTH,
  HUB_ONBOARDING_RESTART_EVENT,
  HUB_ONBOARDING_STORAGE_KEY,
  readHubOnboardingStatus,
  requestHubOnboardingRestart,
  writeHubOnboardingStatus,
} from './hubOnboarding';

describe('getHubOnboardingDashboardStepLayout', () => {
  it('preserves the default layout on taller screens', () => {
    expect(getHubOnboardingDashboardStepLayout('open-qchat', false)).toEqual(
      {}
    );
  });

  it('keeps compact dashboard steps fixed without scrolling', () => {
    expect(getHubOnboardingDashboardStepLayout('open-qchat', true)).toEqual({
      placement: 'top',
      skipScroll: true,
    });
    expect(getHubOnboardingDashboardStepLayout('featured-qapps', true)).toEqual(
      {
        placement: 'bottom',
        skipScroll: true,
        width: HUB_ONBOARDING_FEATURED_QAPPS_COMPACT_WIDTH,
      }
    );
    expect(getHubOnboardingDashboardStepLayout('explore-qapps', true)).toEqual({
      placement: 'top',
      skipScroll: true,
    });
  });
});

describe('getHubOnboardingSurface', () => {
  it('restores the correct application surface in both tour directions', () => {
    expect(getHubOnboardingSurface(1)).toBe('home');
    expect(getHubOnboardingSurface(2)).toBe('qchat');
    expect(getHubOnboardingSurface(7)).toBe('qchat-directs');
    expect(getHubOnboardingSurface(9)).toBe('qchat-directs');
    expect(getHubOnboardingSurface(10)).toBe('home');
    expect(getHubOnboardingSurface(12)).toBe('apps');
  });
});

describe('getAdjacentHubOnboardingStep', () => {
  it('moves backward instead of bouncing forward when a prior target is unavailable', () => {
    expect(getAdjacentHubOnboardingStep(5, 'backward', 12)).toBe(4);
  });

  it('keeps recovery inside the tour bounds', () => {
    expect(getAdjacentHubOnboardingStep(0, 'backward', 12)).toBe(0);
    expect(getAdjacentHubOnboardingStep(11, 'forward', 12)).toBe(11);
  });
});

describe('Hub onboarding persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('treats a new installation as not yet onboarded', () => {
    expect(readHubOnboardingStatus()).toBeNull();
  });

  it('persists completed and skipped states', () => {
    writeHubOnboardingStatus('completed');
    expect(readHubOnboardingStatus()).toBe('completed');

    writeHubOnboardingStatus('skipped');
    expect(readHubOnboardingStatus()).toBe('skipped');
  });

  it('arms a replay and announces it to the mounted tour host', () => {
    const listener = vi.fn();
    window.addEventListener(HUB_ONBOARDING_RESTART_EVENT, listener);

    requestHubOnboardingRestart();

    expect(window.localStorage.getItem(HUB_ONBOARDING_STORAGE_KEY)).toBe(
      'pending'
    );
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(HUB_ONBOARDING_RESTART_EVENT, listener);
  });
});
