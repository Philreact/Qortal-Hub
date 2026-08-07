import { describe, expect, it } from 'vitest';
import {
  isAutoLockDue,
  normalizeAutoLockTimeoutMinutes,
  resolveAutoLockTimeoutMinutes,
} from './autoLock';

describe('auto-lock settings', () => {
  it('defaults invalid or missing values to 30 minutes', () => {
    expect(normalizeAutoLockTimeoutMinutes(undefined)).toBe(30);
    expect(normalizeAutoLockTimeoutMinutes(15)).toBe(30);
  });

  it('accepts every supported timeout', () => {
    expect([0, 10, 30, 60, 180].map(normalizeAutoLockTimeoutMinutes)).toEqual([
      0, 10, 30, 60, 180,
    ]);
  });

  it('migrates the previous disabled preference', () => {
    expect(resolveAutoLockTimeoutMinutes(undefined, true)).toBe(0);
    expect(resolveAutoLockTimeoutMinutes(undefined, false)).toBe(30);
    expect(resolveAutoLockTimeoutMinutes(60, true)).toBe(60);
  });

  it('never locks automatically when disabled', () => {
    expect(isAutoLockDue(0, 24 * 60 * 60 * 1_000, 0)).toBe(false);
  });

  it('locks once the selected inactivity period has elapsed', () => {
    expect(isAutoLockDue(1_000, 10 * 60 * 1_000, 10)).toBe(false);
    expect(isAutoLockDue(1_000, 10 * 60 * 1_000 + 1_000, 10)).toBe(true);
  });
});
