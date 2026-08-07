import { describe, expect, it } from 'vitest';
import { resolveDirectTarget } from './resolveDirectTarget';

const address = 'QfETL5P9AdWNJFazqqigXVsu6Hx4iV8EUg';

describe('resolveDirectTarget', () => {
  it('returns a valid address directly', () => {
    expect(resolveDirectTarget(` ${address} `, [])).toEqual({
      address,
      name: address,
    });
  });

  it('resolves an exact name to its address', () => {
    expect(
      resolveDirectTarget('Qortal Justin', [{ name: 'Qortal Justin', address }])
    ).toEqual({ name: 'Qortal Justin', address });
  });

  it('never treats an unresolved or ambiguous name as an address', () => {
    expect(resolveDirectTarget('Qortal Justin', [])).toBeNull();
    expect(
      resolveDirectTarget('duplicate', [
        { name: 'duplicate', address },
        {
          name: 'duplicate',
          address: 'QeLB8NZBjQkWYkRdw3renvRgB63DWR9E5E',
        },
      ])
    ).toBeNull();
  });
});
