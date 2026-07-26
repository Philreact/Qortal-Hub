import {
  TIME_DAYS_1_IN_MILLISECONDS,
  TIME_MONTHS_1_IN_MILLISECONDS,
  TIME_WEEKS_1_IN_MILLISECONDS,
} from '../../constants/constants';

export type ReticulumMessageExpiryOption = {
  durationMs: number;
  label: string;
};

export const RETICULUM_MESSAGE_EXPIRY_OPTIONS: readonly ReticulumMessageExpiryOption[] =
  [
    {
      durationMs: TIME_DAYS_1_IN_MILLISECONDS,
      label: '24 hours',
    },
    {
      durationMs: 2 * TIME_DAYS_1_IN_MILLISECONDS,
      label: '48 hours',
    },
    {
      durationMs: 3 * TIME_DAYS_1_IN_MILLISECONDS,
      label: '72 hours',
    },
    {
      durationMs: TIME_WEEKS_1_IN_MILLISECONDS,
      label: '1 week',
    },
    {
      durationMs: TIME_MONTHS_1_IN_MILLISECONDS,
      label: '1 month',
    },
  ];

function normalizeExpiryDurationMs(value: unknown): number | undefined {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  return Math.floor(duration);
}

export function formatReticulumExpiryDuration(value: unknown): string {
  const duration = normalizeExpiryDurationMs(value);
  if (duration === undefined) return 'No expiry';
  const option = RETICULUM_MESSAGE_EXPIRY_OPTIONS.find(
    (candidate) => candidate.durationMs === duration
  );
  if (option) return option.label;
  const hours = duration / (60 * 60 * 1_000);
  if (Number.isInteger(hours) && hours < 24) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const days = duration / TIME_DAYS_1_IN_MILLISECONDS;
  if (Number.isInteger(days)) {
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  return `${Math.max(1, Math.round(hours))} hours`;
}

export function isReticulumMessageExpiryOptionAllowed(
  durationMs: number,
  channelExpiryDurationMs?: number
): boolean {
  const duration = normalizeExpiryDurationMs(durationMs);
  if (
    duration === undefined ||
    !RETICULUM_MESSAGE_EXPIRY_OPTIONS.some(
      (option) => option.durationMs === duration
    )
  ) {
    return false;
  }
  const channelExpiry = normalizeExpiryDurationMs(channelExpiryDurationMs);
  return channelExpiry === undefined || duration <= channelExpiry;
}

export function resolveReticulumMessageExpiryDurationMs(
  selectedDurationMs: number | undefined,
  channelExpiryDurationMs?: number
): number | undefined {
  if (selectedDurationMs === undefined) return undefined;
  return isReticulumMessageExpiryOptionAllowed(
    selectedDurationMs,
    channelExpiryDurationMs
  )
    ? selectedDurationMs
    : undefined;
}

export function buildReticulumMessageExpiryPayload(
  selectedDurationMs: number | undefined,
  channelExpiryDurationMs?: number
): { expiryDurationMs?: number } {
  const expiryDurationMs = resolveReticulumMessageExpiryDurationMs(
    selectedDurationMs,
    channelExpiryDurationMs
  );
  return expiryDurationMs === undefined ? {} : { expiryDurationMs };
}
