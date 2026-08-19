import { describe, expect, it, vi } from 'vitest';
import { refreshUdpPortMapping } from './upnp-nat';

describe('managed UPnP mapping refresh', () => {
  it('refreshes through the low-level mapper without registering a duplicate', async () => {
    const client = {
      _map: vi.fn(async () => [true, null]),
      map: vi.fn(async () => true),
    };

    await expect(
      refreshUdpPortMapping(client, {
        publicPort: 47_321,
        privatePort: 47_321,
        description: 'Qortal Hub Community STUN',
      })
    ).resolves.toBe(true);

    expect(client._map).toHaveBeenCalledWith({
      publicPort: 47_321,
      privatePort: 47_321,
      protocol: 'UDP',
      ttl: 7_200,
      description: 'Qortal Hub Community STUN',
    });
    expect(client.map).not.toHaveBeenCalled();
  });

  it('reports unsuccessful and rejected refreshes without throwing', async () => {
    await expect(
      refreshUdpPortMapping(
        { _map: vi.fn(async () => [false, new Error('rejected')]) },
        {
          publicPort: 47_321,
          privatePort: 47_321,
          description: 'Qortal Hub Community STUN',
        }
      )
    ).resolves.toBe(false);

    await expect(
      refreshUdpPortMapping(
        {
          _map: vi.fn(async () => {
            throw new Error('router unavailable');
          }),
        },
        {
          publicPort: 47_321,
          privatePort: 47_321,
          description: 'Qortal Hub Community STUN',
        }
      )
    ).resolves.toBe(false);
  });
});
