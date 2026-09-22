import { describe, expect, it } from 'vitest';
import { DirectOsNotificationLimiter } from './os-notification-rate-limit';

describe('direct Q-App OS notification rate limit', () => {
  it('allows three per minute per app, then resets', () => {
    const limiter = new DirectOsNotificationLimiter();
    for (let index = 0; index < 3; index++) {
      expect(limiter.canShow('Q-Tube', index)).toBe(true);
      limiter.record('Q-Tube', index);
    }
    expect(limiter.canShow('q-tube', 3)).toBe(false);
    expect(limiter.canShow('Q-Mail', 3)).toBe(true);
    expect(limiter.canShow('Q-Tube', 60_002)).toBe(true);
  });
});
