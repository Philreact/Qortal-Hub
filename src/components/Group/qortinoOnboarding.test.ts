import { describe, expect, it } from 'vitest';
import {
  QORTINO_ONBOARDING_QORT_REQUIREMENT,
  hasRequiredQortinoOnboardingBalance,
} from './qortinoOnboarding';

describe('Qortino onboarding QORT requirement', () => {
  it('requires exactly 2 QORT', () => {
    expect(QORTINO_ONBOARDING_QORT_REQUIREMENT).toBe(2);
    expect(hasRequiredQortinoOnboardingBalance('1.99999999')).toBe(false);
    expect(hasRequiredQortinoOnboardingBalance('2')).toBe(true);
  });

  it('accepts confirmed received payments as the fallback total', () => {
    expect(hasRequiredQortinoOnboardingBalance(null, 1.99)).toBe(false);
    expect(hasRequiredQortinoOnboardingBalance(null, 2)).toBe(true);
  });
});
