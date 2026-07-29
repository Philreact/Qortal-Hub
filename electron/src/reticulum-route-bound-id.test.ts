import { describe, expect, it } from 'vitest';
import { getRouteBoundDestinationHash } from './reticulum-route-bound-id';

describe('Reticulum route-bound id decoding', () => {
  it('decodes the destination without changing UUID-sized ids', () => {
    const presenceId = `PqqqqqqqqqqqqqqqqqqqqqgABCDEFGHIJKLM`;
    const callId = `Cu7u7u7u7u7u7u7u7u7u7uwABCDEFGHIJKLM`;
    expect(presenceId).toHaveLength(36);
    expect(callId).toHaveLength(36);
    expect(getRouteBoundDestinationHash('presence', presenceId)).toBe(
      'a'.repeat(32)
    );
    expect(getRouteBoundDestinationHash('call', callId)).toBe('b'.repeat(32));
  });

  it('does not reinterpret legacy or malformed ids', () => {
    expect(
      getRouteBoundDestinationHash(
        'call',
        '123e4567-e89b-12d3-a456-426614174000'
      )
    ).toBeNull();
    expect(
      getRouteBoundDestinationHash(
        'presence',
        `P!!!!!!!!!!!!!!!!!!!!!!ABCDEFGHIJKLM`
      )
    ).toBeNull();
  });
});
