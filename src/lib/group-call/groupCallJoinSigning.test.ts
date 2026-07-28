import { describe, expect, it } from 'vitest';
import {
  decodeGroupCallLogicalGeneration,
  encodeGroupCallTakeoverGeneration,
} from './groupCallJoinSigning';

describe('group-call takeover generation encoding', () => {
  it.each([0, 1, 7, 0x7fffffff, 0xffffffff])(
    'round-trips logical generation %s through the signed compact form',
    (generation) => {
      const signed = encodeGroupCallTakeoverGeneration(generation);
      expect(signed).toBeLessThan(0);
      expect(decodeGroupCallLogicalGeneration(signed)).toBe(generation >>> 0);
    }
  );

  it('keeps ordinary reannouncement generations unchanged', () => {
    expect(decodeGroupCallLogicalGeneration(42)).toBe(42);
  });
});
