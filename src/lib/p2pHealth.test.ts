import { describe, expect, it } from 'vitest';
import { computeP2pHealth } from './p2pHealth';

describe('computeP2pHealth', () => {
  it('bad when no receiving peers', () => {
    expect(
      computeP2pHealth({
        onlineRemoteHubInterfaces: 2,
        p2pReceivingOverlayPeers: 0,
        p2pReceivingOverlayPeersStableMs: 0,
      })
    ).toBe('bad');
  });

  it('low when stable time is below good threshold', () => {
    expect(
      computeP2pHealth({
        onlineRemoteHubInterfaces: 0,
        p2pReceivingOverlayPeers: 1,
        p2pReceivingOverlayPeersStableMs: 29_999,
      })
    ).toBe('low');
  });

  it('good when receiving from at least 1 peer for at least 30 seconds', () => {
    expect(
      computeP2pHealth({
        onlineRemoteHubInterfaces: 0,
        p2pReceivingOverlayPeers: 1,
        p2pReceivingOverlayPeersStableMs: 60_000,
      })
    ).toBe('good');
    expect(
      computeP2pHealth({
        onlineRemoteHubInterfaces: 2,
        p2pReceivingOverlayPeers: 3,
        p2pReceivingOverlayPeersStableMs: 30_000,
      })
    ).toBe('good');
    expect(
      computeP2pHealth({
        onlineRemoteHubInterfaces: 2,
        p2pReceivingOverlayPeers: 4,
        p2pReceivingOverlayPeersStableMs: 45_000,
      })
    ).toBe('good');
  });

  it('does not use old active overlay peers when receiving counts are absent', () => {
    expect(
      computeP2pHealth({
        onlineRemoteHubInterfaces: 2,
        p2pActiveOverlayPeers: 2,
      })
    ).toBe('bad');
  });
});
