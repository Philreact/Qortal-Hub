import { beforeEach, describe, expect, it } from 'vitest';
import {
  TIME_DAYS_1_IN_MILLISECONDS,
  TIME_MONTHS_1_IN_MILLISECONDS,
  TIME_WEEKS_1_IN_MILLISECONDS,
} from '../../constants/constants';
import {
  buildReticulumMessageExpiryPayload,
  formatReticulumExpiryDuration,
  isReticulumMessageExpiryOptionAllowed,
  loadReticulumMessageExpiryPreference,
  RETICULUM_MESSAGE_EXPIRY_OPTIONS,
  resolveReticulumPreferredMessageExpiryDurationMs,
  saveReticulumMessageExpiryPreference,
} from './reticulumMessageExpiry';

describe('Reticulum message expiry', () => {
  beforeEach(() => window.localStorage.clear());

  it('provides the intended fixed expiry choices', () => {
    expect(RETICULUM_MESSAGE_EXPIRY_OPTIONS).toEqual([
      expect.objectContaining({ durationMs: TIME_DAYS_1_IN_MILLISECONDS }),
      expect.objectContaining({ durationMs: 2 * TIME_DAYS_1_IN_MILLISECONDS }),
      expect.objectContaining({ durationMs: 3 * TIME_DAYS_1_IN_MILLISECONDS }),
      expect.objectContaining({ durationMs: TIME_WEEKS_1_IN_MILLISECONDS }),
      expect.objectContaining({ durationMs: TIME_MONTHS_1_IN_MILLISECONDS }),
    ]);
  });

  it('omits the payload override when channel default is selected', () => {
    expect(buildReticulumMessageExpiryPayload(undefined, undefined)).toEqual(
      {}
    );
    expect(
      buildReticulumMessageExpiryPayload(
        undefined,
        2 * TIME_DAYS_1_IN_MILLISECONDS
      )
    ).toEqual({});
  });

  it('includes an allowed message expiry in the signed payload', () => {
    expect(
      buildReticulumMessageExpiryPayload(
        TIME_DAYS_1_IN_MILLISECONDS,
        2 * TIME_DAYS_1_IN_MILLISECONDS
      )
    ).toEqual({ expiryDurationMs: TIME_DAYS_1_IN_MILLISECONDS });
  });

  it('rejects a message expiry longer than the channel maximum', () => {
    expect(
      isReticulumMessageExpiryOptionAllowed(
        3 * TIME_DAYS_1_IN_MILLISECONDS,
        2 * TIME_DAYS_1_IN_MILLISECONDS
      )
    ).toBe(false);
    expect(
      buildReticulumMessageExpiryPayload(
        3 * TIME_DAYS_1_IN_MILLISECONDS,
        2 * TIME_DAYS_1_IN_MILLISECONDS
      )
    ).toEqual({});
  });

  it('uses a locked preference unless the channel has a shorter expiry', () => {
    expect(
      resolveReticulumPreferredMessageExpiryDurationMs(
        TIME_WEEKS_1_IN_MILLISECONDS,
        TIME_MONTHS_1_IN_MILLISECONDS
      )
    ).toBe(TIME_WEEKS_1_IN_MILLISECONDS);
    expect(
      resolveReticulumPreferredMessageExpiryDurationMs(
        TIME_WEEKS_1_IN_MILLISECONDS,
        TIME_DAYS_1_IN_MILLISECONDS
      )
    ).toBeUndefined();
  });

  it('stores the locked preference per account and group', () => {
    expect(
      saveReticulumMessageExpiryPreference(
        'QAccountAddress',
        42,
        TIME_WEEKS_1_IN_MILLISECONDS
      )
    ).toBe(true);
    expect(loadReticulumMessageExpiryPreference('qaccountaddress', 42)).toBe(
      TIME_WEEKS_1_IN_MILLISECONDS
    );
    expect(
      loadReticulumMessageExpiryPreference('QAccountAddress', 43)
    ).toBeUndefined();
    expect(
      loadReticulumMessageExpiryPreference('QOtherAccount', 42)
    ).toBeUndefined();

    saveReticulumMessageExpiryPreference('QAccountAddress', 42, undefined);
    expect(
      loadReticulumMessageExpiryPreference('QAccountAddress', 42)
    ).toBeUndefined();
  });

  it('formats standard and custom channel limits clearly', () => {
    expect(formatReticulumExpiryDuration(undefined)).toBe('No expiry');
    expect(formatReticulumExpiryDuration(TIME_WEEKS_1_IN_MILLISECONDS)).toBe(
      '1 week'
    );
    expect(formatReticulumExpiryDuration(TIME_MONTHS_1_IN_MILLISECONDS)).toBe(
      '1 month'
    );
    expect(formatReticulumExpiryDuration(12 * 60 * 60 * 1_000)).toBe(
      '12 hours'
    );
  });
});
