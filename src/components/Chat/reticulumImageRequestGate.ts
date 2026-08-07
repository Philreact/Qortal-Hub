export type ReticulumImageRequestGate = {
  claim: (key: string, nowMs: number) => boolean;
  clear: (key: string) => void;
  getRemainingMs: (key: string, nowMs: number) => number;
};

export function createReticulumImageRequestGate(
  backoffMs: number,
  maxEntries: number
): ReticulumImageRequestGate {
  const requestTimes = new Map<string, number>();

  const getRemainingMs = (key: string, nowMs: number) => {
    const previousRequestAt = requestTimes.get(key);
    if (typeof previousRequestAt !== 'number') return 0;
    return Math.max(0, backoffMs - (nowMs - previousRequestAt));
  };

  return {
    claim(key, nowMs) {
      if (!key || getRemainingMs(key, nowMs) > 0) return false;

      // Claim only when the caller is ready to invoke the request API. A
      // preflight check or a React effect that is cleaned up must not consume
      // the request allowance without starting a transfer.
      requestTimes.set(key, nowMs);
      if (requestTimes.size > maxEntries) {
        const oldestKey = requestTimes.keys().next().value;
        if (oldestKey) requestTimes.delete(oldestKey);
      }
      return true;
    },
    clear(key) {
      requestTimes.delete(key);
    },
    getRemainingMs,
  };
}
