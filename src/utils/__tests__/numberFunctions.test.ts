import { describe, expect, it } from 'vitest';
import { formatQortAmount } from '../numberFunctions';

describe('formatQortAmount', () => {
  it('always renders two decimals', () => {
    expect(formatQortAmount(1000, 'en')).toBe('1,000.00');
    expect(formatQortAmount(999.97, 'en')).toBe('999.97');
    expect(formatQortAmount(999.999, 'en')).toBe('1,000.00');
    expect(formatQortAmount(0, 'en')).toBe('0.00');
  });

  it('uses the separators of the given language', () => {
    expect(formatQortAmount(1234.5, 'de')).toBe('1.234,50');
    expect(formatQortAmount(1234.5, 'fr')).toBe('1 234,50');
  });

  it('accepts the string balances returned by the core API', () => {
    expect(formatQortAmount('1000.12345678', 'en')).toBe('1,000.12');
    expect(formatQortAmount('1,000.5', 'en')).toBe('1,000.50');
  });

  it('returns null for missing or non-numeric values', () => {
    expect(formatQortAmount(null, 'en')).toBeNull();
    expect(formatQortAmount(undefined, 'en')).toBeNull();
    expect(formatQortAmount('', 'en')).toBeNull();
    expect(formatQortAmount('abc', 'en')).toBeNull();
    expect(formatQortAmount(Number.NaN, 'en')).toBeNull();
  });

  it('honours a custom decimal count', () => {
    expect(formatQortAmount(1.23456, 'en', { fractionDigits: 4 })).toBe(
      '1.2346'
    );
    expect(formatQortAmount(1.5, 'en', { fractionDigits: 0 })).toBe('2');
  });

  it('rounds tiny amounts away by default', () => {
    expect(formatQortAmount(0.001, 'en')).toBe('0.00');
  });

  it('keeps tiny amounts readable when expandSmallAmounts is set', () => {
    expect(formatQortAmount(0.001, 'en', { expandSmallAmounts: true })).toBe(
      '0.001'
    );
    expect(
      formatQortAmount(0.00000001, 'en', { expandSmallAmounts: true })
    ).toBe('0.00000001');
    expect(formatQortAmount(-0.001, 'en', { expandSmallAmounts: true })).toBe(
      '-0.001'
    );
    // amounts that already survive two decimals are untouched
    expect(
      formatQortAmount(1234.5678, 'en', { expandSmallAmounts: true })
    ).toBe('1,234.57');
    expect(formatQortAmount(0, 'en', { expandSmallAmounts: true })).toBe(
      '0.00'
    );
  });

  it('falls back to the default locale for an invalid language tag', () => {
    expect(formatQortAmount(1234.5, 'not a locale')).toBe(
      (1234.5).toLocaleString(undefined, {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })
    );
  });
});
