import { describe, expect, it } from 'vitest';
import { createReticulumImageRequestGate } from './reticulumImageRequestGate';

describe('reticulum image request gate', () => {
  it('does not consume the allowance while checking whether a request is needed', () => {
    const gate = createReticulumImageRequestGate(30_000, 500);

    // Reading the remaining delay models the async status preflight. If its
    // component is unmounted here, the replacement can still start a request.
    expect(gate.getRemainingMs('dm:image', 1_000)).toBe(0);
    expect(gate.claim('dm:image', 1_001)).toBe(true);
  });

  it('deduplicates requests only after one has actually claimed the key', () => {
    const gate = createReticulumImageRequestGate(30_000, 500);

    expect(gate.claim('dm:image', 1_000)).toBe(true);
    expect(gate.claim('dm:image', 1_001)).toBe(false);
    expect(gate.getRemainingMs('dm:image', 11_000)).toBe(20_000);
    expect(gate.claim('dm:image', 31_000)).toBe(true);
  });

  it('allows an immediate retry after a completed or manually reset request', () => {
    const gate = createReticulumImageRequestGate(30_000, 500);

    expect(gate.claim('dm:image', 1_000)).toBe(true);
    gate.clear('dm:image');
    expect(gate.claim('dm:image', 1_001)).toBe(true);
  });
});
