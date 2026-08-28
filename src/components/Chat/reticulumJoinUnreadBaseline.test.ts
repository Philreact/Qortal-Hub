import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupReticulumJoinUnreadBaselines,
  MAX_RETICULUM_JOIN_UNREAD_BASELINES,
  RETICULUM_JOIN_UNREAD_BASELINE_PREFIX,
} from './reticulumJoinUnreadBaseline';

const baselineKey = (groupId: number, address: string, joinedAt: number) =>
  `${RETICULUM_JOIN_UNREAD_BASELINE_PREFIX}:${groupId}:${address}:${joinedAt}`;

const storedBaselineKeys = () =>
  Object.keys(window.localStorage).filter((key) =>
    key.startsWith(`${RETICULUM_JOIN_UNREAD_BASELINE_PREFIX}:`)
  );

describe('Reticulum join unread baseline cleanup', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('removes obsolete membership periods without touching other memberships', () => {
    const currentKey = baselineKey(1144, 'Q-address', 300);
    const obsoleteKey = baselineKey(1144, 'Q-address', 200);
    const otherGroupKey = baselineKey(1143, 'Q-address', 100);
    const otherAccountKey = baselineKey(1144, 'Q-other', 100);
    for (const key of [
      currentKey,
      obsoleteKey,
      otherGroupKey,
      otherAccountKey,
    ]) {
      window.localStorage.setItem(key, '["general"]');
    }

    cleanupReticulumJoinUnreadBaselines({
      address: 'Q-address',
      groupId: 1144,
      joinedAt: 300,
    });

    expect(window.localStorage.getItem(currentKey)).toBe('["general"]');
    expect(window.localStorage.getItem(obsoleteKey)).toBeNull();
    expect(window.localStorage.getItem(otherGroupKey)).toBe('["general"]');
    expect(window.localStorage.getItem(otherAccountKey)).toBe('["general"]');
  });

  it('bounds retained baseline records while preserving the current membership', () => {
    const currentKey = baselineKey(1144, 'Q-current', 1);
    window.localStorage.setItem(currentKey, '["general"]');
    for (
      let index = 0;
      index < MAX_RETICULUM_JOIN_UNREAD_BASELINES + 20;
      index += 1
    ) {
      window.localStorage.setItem(
        baselineKey(index + 1, `Q-${index}`, index + 10),
        '["general"]'
      );
    }

    cleanupReticulumJoinUnreadBaselines({
      address: 'Q-current',
      groupId: 1144,
      joinedAt: 1,
    });

    expect(storedBaselineKeys()).toHaveLength(
      MAX_RETICULUM_JOIN_UNREAD_BASELINES
    );
    expect(window.localStorage.getItem(currentKey)).toBe('["general"]');
    expect(
      window.localStorage.getItem(
        baselineKey(
          MAX_RETICULUM_JOIN_UNREAD_BASELINES + 20,
          `Q-${MAX_RETICULUM_JOIN_UNREAD_BASELINES + 19}`,
          MAX_RETICULUM_JOIN_UNREAD_BASELINES + 29
        )
      )
    ).toBe('["general"]');
  });

  it('removes malformed records owned by this storage namespace', () => {
    const malformedKey = `${RETICULUM_JOIN_UNREAD_BASELINE_PREFIX}:broken`;
    window.localStorage.setItem(malformedKey, '["general"]');

    cleanupReticulumJoinUnreadBaselines({
      address: 'Q-address',
      groupId: 1144,
      joinedAt: 300,
    });

    expect(window.localStorage.getItem(malformedKey)).toBeNull();
  });
});
