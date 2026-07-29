import { describe, expect, it } from 'vitest';
import {
  createCompactWireId,
  createRouteBoundId,
  routeBoundIdMatchesDestination,
} from './routeBoundId';

describe('route-bound ids', () => {
  it('creates compact 96-bit wire deduplication ids', () => {
    const first = createCompactWireId();
    const second = createCompactWireId();
    expect(first).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(second).not.toBe(first);
  });

  it('keeps presence and call ids UUID-sized while binding the route', () => {
    const destinationHash = 'ab'.repeat(16);
    for (const kind of ['presence', 'call'] as const) {
      const id = createRouteBoundId(kind, destinationHash);
      expect(id).toHaveLength(36);
      expect(routeBoundIdMatchesDestination(kind, id!, destinationHash)).toBe(
        true
      );
      expect(routeBoundIdMatchesDestination(kind, id!, 'cd'.repeat(16))).toBe(
        false
      );
    }
  });

  it('rejects malformed destination hashes', () => {
    expect(createRouteBoundId('presence', 'short')).toBeNull();
  });
});
