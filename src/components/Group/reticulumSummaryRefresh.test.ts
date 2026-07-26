import { describe, expect, it } from 'vitest';
import {
  beginReticulumSummaryRefresh,
  getReticulumMentionBadgeCount,
} from './reticulumSummaryRefresh';

describe('Reticulum summary refresh', () => {
  it('allows an authoritative mention count to decrease after reads', () => {
    expect(
      getReticulumMentionBadgeCount({
        '519': { mentionCount: 3 },
        '716': { mentionCount: 2 },
      })
    ).toBe(5);
    expect(
      getReticulumMentionBadgeCount({
        '519': { mentionCount: 0 },
        '716': { mentionCount: 0 },
      })
    ).toBe(0);
  });

  it('rejects an older refresh after a newer refresh starts', () => {
    const sequence = { current: 0 };
    const firstWasSuperseded = beginReticulumSummaryRefresh(sequence);
    expect(firstWasSuperseded()).toBe(false);

    const secondWasSuperseded = beginReticulumSummaryRefresh(sequence);
    expect(firstWasSuperseded()).toBe(true);
    expect(secondWasSuperseded()).toBe(false);
  });
});
