import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReticulumBridge } from './reticulum-bridge';
import { StunUdpServer } from './stun-udp-server';
import { isPublicCommunityStunHost, StunCoordinator } from './stun-coordinator';

const tempDirs: string[] = [];

class FakeBridge extends EventEmitter {
  readonly getCommunityStunEndpoints = vi.fn(async () => []);
  readonly configureCommunityStun = vi.fn(async () => true);
}

function makeCoordinator(): StunCoordinator {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-stun-test-'));
  tempDirs.push(dir);
  return new StunCoordinator(path.join(dir, 'stun-cache.db'));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('community STUN endpoint validation', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.1.2',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    'localhost',
    'example.com',
    '::1',
  ])('rejects non-public probe target %s', (host) => {
    expect(isPublicCommunityStunHost(host)).toBe(false);
  });

  it('accepts a globally routable IPv4 literal', () => {
    expect(isPublicCommunityStunHost('8.8.8.8')).toBe(true);
  });

  it('moves discovery listeners and refreshes endpoints when the bridge is replaced', async () => {
    const first = new FakeBridge();
    const second = new FakeBridge();
    const coordinator = makeCoordinator();
    await coordinator.start(first as unknown as ReticulumBridge, {
      stunCacheDbPath: '',
      contributionEnabled: false,
    });

    coordinator.setBridge(second as unknown as ReticulumBridge);
    await Promise.resolve();

    expect(first.listenerCount('community-stun-endpoint')).toBe(0);
    expect(first.listenerCount('ready')).toBe(0);
    expect(second.listenerCount('community-stun-endpoint')).toBe(1);
    expect(second.listenerCount('ready')).toBe(1);
    expect(second.getCommunityStunEndpoints).toHaveBeenCalledTimes(1);

    coordinator.stop();
    await coordinator.waitForStop();
  });

  it('retries contribution after another local instance owns the UDP port', async () => {
    vi.useFakeTimers();
    const tryBind = vi
      .spyOn(StunUdpServer.prototype, 'tryBind')
      .mockResolvedValue(false);
    const coordinator = makeCoordinator();
    await coordinator.start(new FakeBridge() as unknown as ReticulumBridge, {
      stunCacheDbPath: '',
      contributionEnabled: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(tryBind).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(35_000);
    expect(tryBind).toHaveBeenCalledTimes(2);

    coordinator.stop();
    await coordinator.waitForStop();
  });
});
