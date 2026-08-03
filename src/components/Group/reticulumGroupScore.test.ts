import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateReticulumGroupScore,
  getCommunityLevel,
  getLegacyLevel,
} from './reticulumGroupScore';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe('Reticulum Group Score', () => {
  afterEach(() => vi.useRealTimers());

  it('awards Legacy only for completed years and caps it at ten', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));

    expect(getLegacyLevel(new Date('2026-01-01T00:00:00Z').getTime())).toBe(0);
    expect(getLegacyLevel(new Date('2025-08-03T12:00:00Z').getTime())).toBe(1);
    expect(getLegacyLevel(new Date('2010-01-01T00:00:00Z').getTime())).toBe(10);
  });

  it('awards nine Community points at 2,500 members and ten at 5,000', () => {
    expect(getCommunityLevel(2_499)).toBe(8);
    expect(getCommunityLevel(2_500)).toBe(9);
    expect(getCommunityLevel(4_999)).toBe(9);
    expect(getCommunityLevel(5_000)).toBe(10);
  });

  it('allows a new group to reach 90 without Legacy points', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
    const created = Date.now() - Math.floor(YEAR_MS / 2);
    const result = calculateReticulumGroupScore({
      activity: {
        activeAuthors7d: 50,
        confidence: 1,
        messages24h: 100,
        messages7d: 500,
        observedAt: Date.now(),
      },
      activityObserved: true,
      balance: 1_000_000,
      capturedAt: Date.now(),
      created,
      groupId: 1,
      memberCount: 5_000,
    });

    expect(result?.legacyScore).toBe(0);
    expect(result?.score).toBe(90);
  });
});
