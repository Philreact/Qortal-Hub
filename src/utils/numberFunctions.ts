export const truncateNumber = (value: string | number, sigDigits: number) => {
  return Number(value).toFixed(sigDigits);
};

export const removeTrailingZeros = (s: string) => {
  return Number(s).toString();
};

/** Decimals every QORT balance is displayed with, everywhere in the UI. */
export const QORT_BALANCE_DECIMALS = 2;

/** QORT is stored on-chain with 8 decimals. */
export const QORT_MAX_DECIMALS = 8;

export type QortAmountFormatOptions = {
  /** Decimals to render. Defaults to {@link QORT_BALANCE_DECIMALS}. */
  fractionDigits?: number;
  /**
   * When a non-zero amount would round away to zero at `fractionDigits`, render
   * up to {@link QORT_MAX_DECIMALS} instead, so tiny amounts stay readable
   * rather than showing as `0.00`.
   */
  expandSmallAmounts?: boolean;
};

const toLocalizedNumber = (
  value: number,
  locale: string | undefined,
  options: Intl.NumberFormatOptions
): string => {
  try {
    return value.toLocaleString(locale || undefined, options);
  } catch {
    return value.toLocaleString(undefined, options); // invalid locale tag
  }
};

/**
 * Format a QORT amount for display: {@link QORT_BALANCE_DECIMALS} decimals by
 * default, with the thousand/decimal separators of the given locale (pass the
 * active i18next language). Returns `null` when the value is missing or not a
 * number, so callers can pick their own placeholder.
 */
export const formatQortAmount = (
  value: number | string | null | undefined,
  locale?: string,
  { expandSmallAmounts, fractionDigits }: QortAmountFormatOptions = {}
): string | null => {
  if (value === null || value === undefined || value === '') return null;

  const numericValue =
    typeof value === 'number'
      ? value
      : Number(String(value).replace(/,/g, '').trim());

  if (!Number.isFinite(numericValue)) return null;

  const decimals = fractionDigits ?? QORT_BALANCE_DECIMALS;
  const roundsAwayToZero =
    numericValue !== 0 && Math.abs(numericValue) < 0.5 / Math.pow(10, decimals);

  return toLocalizedNumber(numericValue, locale, {
    maximumFractionDigits:
      expandSmallAmounts && roundsAwayToZero ? QORT_MAX_DECIMALS : decimals,
    minimumFractionDigits: decimals,
  });
};

export const setNumberWithinBounds = (
  num: number,
  minValue: number,
  maxValue: number
) => {
  if (num > maxValue) return maxValue;
  if (num < minValue) return minValue;
  return num;
};

export const numberToInt = (num: number) => {
  return Math.floor(num);
};

type ByteFormat = 'Decimal' | 'Binary';

export function formatBytes(
  bytes: number,
  decimals = 2,
  format: ByteFormat = 'Binary'
) {
  if (bytes === 0) return '0 Bytes';

  const k = format === 'Binary' ? 1024 : 1000;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function formatTime(seconds: number): string {
  seconds = Math.floor(seconds);
  const minutes: number | string = Math.floor(seconds / 60);
  let hours: number | string = Math.floor(minutes / 60);

  let remainingSeconds: number | string = seconds % 60;
  let remainingMinutes: number | string = minutes % 60;

  if (remainingSeconds < 10) {
    remainingSeconds = '0' + remainingSeconds;
  }

  if (remainingMinutes < 10) {
    remainingMinutes = '0' + remainingMinutes;
  }

  if (hours === 0) {
    hours = '';
  } else {
    hours = hours + ':';
  }

  return hours + remainingMinutes + ':' + remainingSeconds;
}

export function roundUpToDecimals(number, decimals = 8) {
  const factor = Math.pow(10, decimals); // Create a factor based on the number of decimals
  return Math.ceil(+number * factor) / factor;
}
