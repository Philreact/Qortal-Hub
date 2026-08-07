import { describe, expect, it } from 'vitest';
import { shouldSuspendQortalLandPresence } from './qortalLandPresence';

describe('Qortal Land presence suspension', () => {
  it('keeps advertising an active player even when they are AFK', () => {
    expect(shouldSuspendQortalLandPresence(true, true)).toBe(false);
  });

  it('keeps advertising a hidden player until they become AFK', () => {
    expect(shouldSuspendQortalLandPresence(false, false)).toBe(false);
  });

  it('suspends a hidden player once they are AFK', () => {
    expect(shouldSuspendQortalLandPresence(false, true)).toBe(true);
  });
});
