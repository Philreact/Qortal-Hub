import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import {
  deriveAddressFromPublicKey,
  encodeBytesBase58,
  PresenceManager,
  RETICULUM_OVERLAY_MAX_NEIGHBORS,
  RETICULUM_VERIFIED_PEER_LINK_CLOSE_GRACE_MS,
  PRESENCE_SESSION_TIMEOUT_MS,
} from './presence';

function promoteVerifiedPeers(
  manager: PresenceManager,
  count: number,
  startAt: number = 0
): string[] {
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const suffix = String(i + startAt).padStart(2, '0');
    const hash = `peer-${suffix}`;
    hashes.push(hash);
    (manager as any).promoteVerifiedReticulumPeer(hash, 1_000 + i + startAt);
  }
  return hashes;
}

describe('PresenceManager Reticulum overlay mesh slots', () => {
  it('distinguishes routine candidate refreshes from usable topology changes', () => {
    const manager = new PresenceManager();
    const changes: Array<{ topologyChanged?: boolean }> = [];
    manager.on('reticulum-overlay-changed', (event) => changes.push(event));

    manager.noteReticulumCandidateDiscovered('peer-refresh', 'announce', 1_000);
    manager.noteReticulumCandidateDiscovered('peer-refresh', 'announce', 2_000);

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      publishFanout: 1,
      topologyChanged: true,
    });
    expect(changes[1]).toMatchObject({
      publishFanout: 1,
      topologyChanged: false,
    });
  });

  it('matches the Python Qortal game-handshake address derivation fixture', () => {
    expect(
      deriveAddressFromPublicKey('1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE')
    ).toBe('QhxqB8rvXYDguai48oNNjfRCUigaXHmf8Q');
  });
  it('skips exact duplicate envelopes before signature verification', async () => {
    const manager = new PresenceManager();
    const verify = vi.fn(async () => true);
    (manager as any).verifyPool = { verify };

    const keyPair = nacl.sign.keyPair();
    const publicKey = encodeBytesBase58(keyPair.publicKey);
    const address = deriveAddressFromPublicKey(publicKey);
    const envelope = {
      id: 'duplicate-heartbeat',
      type: 'PRESENCE_HEARTBEAT',
      senderAddress: address,
      timestamp: Date.now(),
      payload: {
        address,
        publicKey,
        sessionId: 'duplicate-session',
        status: 'online',
      },
      signature: 'sig',
    };

    await expect(
      manager.handleEnvelope(envelope, {
        kind: 'reticulum',
        destinationHash: 'origin-hash',
      })
    ).resolves.toBe(true);
    await expect(
      manager.handleEnvelope(envelope, {
        kind: 'reticulum',
        destinationHash: 'forwarder-hash',
        viaDestinationHash: 'origin-hash',
      })
    ).resolves.toBe(false);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(manager.isAddressOnline(address)).toBe(true);
  });

  it('clears only local cached presence at logout', async () => {
    const manager = new PresenceManager();
    (manager as any).verifyPool = { verify: vi.fn(async () => true) };
    const localKeys = nacl.sign.keyPair();
    const remoteKeys = nacl.sign.keyPair();
    const localPublicKey = encodeBytesBase58(localKeys.publicKey);
    const remotePublicKey = encodeBytesBase58(remoteKeys.publicKey);
    const localAddress = deriveAddressFromPublicKey(localPublicKey);
    const remoteAddress = deriveAddressFromPublicKey(remotePublicKey);
    const now = Date.now();

    await manager.handleEnvelope(
      {
        id: 'local-presence-before-logout',
        type: 'PRESENCE_HEARTBEAT',
        senderAddress: localAddress,
        timestamp: now,
        payload: {
          address: localAddress,
          publicKey: localPublicKey,
          sessionId: 'local-session',
          status: 'online',
        },
        signature: 'sig',
      },
      { kind: 'local' }
    );
    await manager.handleEnvelope(
      {
        id: 'remote-presence-before-logout',
        type: 'PRESENCE_HEARTBEAT',
        senderAddress: remoteAddress,
        timestamp: now,
        payload: {
          address: remoteAddress,
          publicKey: remotePublicKey,
          sessionId: 'remote-session',
          status: 'online',
        },
        signature: 'sig',
      },
      { kind: 'reticulum', destinationHash: 'a'.repeat(32) }
    );

    expect(manager.getLastLocalEnvelope()).not.toBeNull();
    manager.clearLocalAccountState();

    expect(manager.getLastLocalEnvelope()).toBeNull();
    expect(manager.isAddressOnline(localAddress)).toBe(false);
    expect(manager.isAddressOnline(remoteAddress)).toBe(true);
  });

  it('accepts a signed route-bound relayed presence and rejects a changed origin', async () => {
    const destinationHash = 'a'.repeat(32);
    const sessionId = `PqqqqqqqqqqqqqqqqqqqqqgABCDEFGHIJKLM`;
    expect(sessionId).toHaveLength(36);
    const keyPair = nacl.sign.keyPair();
    const publicKey = encodeBytesBase58(keyPair.publicKey);
    const address = deriveAddressFromPublicKey(publicKey);
    const envelope = {
      id: 'route-bound-presence',
      type: 'PRESENCE_HEARTBEAT' as const,
      senderAddress: address,
      timestamp: Date.now(),
      payload: {
        address,
        publicKey,
        sessionId,
        status: 'online' as const,
      },
      signature: 'sig',
    };

    const accepted = new PresenceManager();
    (accepted as any).verifyPool = { verify: vi.fn(async () => true) };
    await expect(
      accepted.handleEnvelope(envelope, {
        kind: 'reticulum',
        destinationHash,
        viaDestinationHash: 'b'.repeat(32),
      })
    ).resolves.toBe(true);
    expect(accepted.getRoutesForAddress(address)).toEqual([
      {
        kind: 'reticulum',
        destinationHash,
        viaDestinationHash: 'b'.repeat(32),
      },
    ]);
    expect(accepted.getReticulumAccountEndpointLeases()).toEqual([
      expect.objectContaining({
        address,
        destinationHash,
        sessionId,
        verification: 'relayed-bound',
      }),
    ]);
    expect(accepted.getReticulumVerifiedTransportPeers()).toEqual([]);

    const changed = new PresenceManager();
    (changed as any).verifyPool = { verify: vi.fn(async () => true) };
    await expect(
      changed.handleEnvelope(
        { ...envelope, id: 'route-bound-presence-changed' },
        {
          kind: 'reticulum',
          destinationHash: 'c'.repeat(32),
          viaDestinationHash: 'b'.repeat(32),
        }
      )
    ).resolves.toBe(false);
    expect(changed.getRoutesForAddress(address)).toEqual([]);
  });

  it('does not let an older offline envelope remove a newer live session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_001);
    const manager = new PresenceManager();
    const address = 'Q-session-order';
    const sessionId = 'session-order';
    const publicKey = 'pk-session-order';

    const newerHeartbeat = {
      id: 'heartbeat-newer',
      type: 'PRESENCE_HEARTBEAT',
      senderAddress: address,
      timestamp: 2_000,
      payload: {
        address,
        publicKey,
        sessionId,
        status: 'online',
      },
      signature: 'sig',
    };
    const olderOffline = {
      id: 'offline-older',
      type: 'PRESENCE_OFFLINE',
      senderAddress: address,
      timestamp: 1_999,
      payload: {
        address,
        publicKey,
        sessionId,
        status: 'offline',
      },
      signature: 'sig',
    };

    expect(
      (manager as any).applyVerifiedPresenceEnvelope(
        newerHeartbeat,
        { kind: 'local' },
        2_000
      )
    ).toBe(true);
    expect(manager.isAddressOnline(address)).toBe(true);

    expect(
      (manager as any).applyVerifiedPresenceEnvelope(
        olderOffline,
        { kind: 'local' },
        2_001
      )
    ).toBe(false);
    expect(manager.isAddressOnline(address)).toBe(true);
    vi.useRealTimers();
  });

  it('does not let an older heartbeat revive a session after a newer offline envelope', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_001);
    const manager = new PresenceManager();
    const address = 'Q-session-offline-order';
    const sessionId = 'session-offline-order';
    const publicKey = 'pk-session-offline-order';

    const newerOffline = {
      id: 'offline-newer',
      type: 'PRESENCE_OFFLINE',
      senderAddress: address,
      timestamp: 2_000,
      payload: {
        address,
        publicKey,
        sessionId,
        status: 'offline',
      },
      signature: 'sig',
    };
    const olderHeartbeat = {
      id: 'heartbeat-older',
      type: 'PRESENCE_HEARTBEAT',
      senderAddress: address,
      timestamp: 1_999,
      payload: {
        address,
        publicKey,
        sessionId,
        status: 'online',
      },
      signature: 'sig',
    };

    expect(
      (manager as any).applyVerifiedPresenceEnvelope(
        newerOffline,
        { kind: 'local' },
        2_000
      )
    ).toBe(true);
    expect(
      (manager as any).applyVerifiedPresenceEnvelope(
        olderHeartbeat,
        { kind: 'local' },
        2_001
      )
    ).toBe(false);
    expect(manager.isAddressOnline(address)).toBe(false);
    vi.useRealTimers();
  });

  it('aggregates multi-device status deterministically instead of using the latest heartbeat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const manager = new PresenceManager();
    const address = 'Q-multi-device-status';

    const applyStatus = (
      sessionId: string,
      status: 'online' | 'busy' | 'idle',
      timestamp: number
    ) =>
      (manager as any).applyVerifiedPresenceEnvelope(
        {
          id: `${sessionId}-${status}-${timestamp}`,
          type: 'PRESENCE_HEARTBEAT',
          senderAddress: address,
          timestamp,
          payload: {
            address,
            publicKey: 'pk-multi-device-status',
            sessionId,
            status,
          },
          signature: 'sig',
        },
        {
          kind: 'reticulum',
          destinationHash: `hash-${sessionId}`,
        },
        timestamp
      );

    expect(applyStatus('laptop-online', 'online', 9_998)).toBe(true);
    expect(applyStatus('laptop-idle', 'idle', 9_999)).toBe(true);
    expect(manager.getAddressStatus(address)).toBe('online');

    expect(applyStatus('laptop-busy', 'busy', 10_000)).toBe(true);
    expect(manager.getAddressStatus(address)).toBe('busy');

    expect(applyStatus('laptop-busy', 'idle', 10_001)).toBe(true);
    expect(manager.getAddressStatus(address)).toBe('online');

    expect(applyStatus('laptop-online', 'idle', 10_002)).toBe(true);
    expect(manager.getAddressStatus(address)).toBe('idle');
    vi.useRealTimers();
  });

  it('returns every distinct fresh route for live sessions in stable preference order', () => {
    vi.useFakeTimers();
    const now = 20_000;
    vi.setSystemTime(now);
    const manager = new PresenceManager();
    const address = 'Q-multi-device-routes';

    const applyRoute = (
      sessionId: string,
      timestamp: number,
      route: Parameters<PresenceManager['handleEnvelope']>[1]
    ) =>
      (manager as any).applyVerifiedPresenceEnvelope(
        {
          id: `${sessionId}-${timestamp}`,
          type: 'PRESENCE_HEARTBEAT',
          senderAddress: address,
          timestamp,
          payload: {
            address,
            publicKey: 'pk-multi-device-routes',
            sessionId,
            status: 'online',
          },
          signature: 'sig',
        },
        route,
        timestamp
      );

    applyRoute('mesh', now - 3, { kind: 'mesh-node', id: 'mesh-peer' });
    applyRoute('reticulum-old', now - 2, {
      kind: 'reticulum',
      destinationHash: 'reticulum-a',
    });
    applyRoute('reticulum-new', now - 1, {
      kind: 'reticulum',
      destinationHash: 'reticulum-b',
    });
    applyRoute('reticulum-duplicate', now, {
      kind: 'reticulum',
      destinationHash: 'reticulum-a',
      viaDestinationHash: 'relay-peer',
    });

    expect(manager.getRoutesForAddress(address)).toEqual([
      { kind: 'reticulum', destinationHash: 'reticulum-b' },
      { kind: 'reticulum', destinationHash: 'reticulum-a' },
      { kind: 'mesh-node', id: 'mesh-peer' },
    ]);
    expect(manager.getRouteForAddress(address)).toEqual({
      kind: 'reticulum',
      destinationHash: 'reticulum-b',
    });
    vi.useRealTimers();
  });

  it('excludes expired sessions and stale routes from multi-device routing', () => {
    vi.useFakeTimers();
    const now = 30_000;
    vi.setSystemTime(now);
    const manager = new PresenceManager();
    const address = 'Q-expiring-routes';

    (manager as any).applyVerifiedPresenceEnvelope(
      {
        id: 'expiring-route',
        type: 'PRESENCE_HEARTBEAT',
        senderAddress: address,
        timestamp: now,
        payload: {
          address,
          publicKey: 'pk-expiring-routes',
          sessionId: 'expiring-session',
          status: 'online',
        },
        signature: 'sig',
      },
      { kind: 'reticulum', destinationHash: 'expiring-hash' },
      now
    );

    expect(manager.getRoutesForAddress(address)).toHaveLength(1);
    vi.setSystemTime(now + 45_001);
    expect(manager.isAddressOnline(address)).toBe(true);
    expect(manager.getRoutesForAddress(address)).toEqual([]);
    vi.setSystemTime(now + PRESENCE_SESSION_TIMEOUT_MS + 1);
    expect(manager.isAddressOnline(address)).toBe(false);
    vi.useRealTimers();
  });

  it('keeps transport verification independent from account endpoint leases', () => {
    const manager = new PresenceManager();
    (manager as any).promoteVerifiedReticulumPeer('peer-hash', 1000);
    expect(manager.getReticulumVerifiedTransportPeers()).toEqual([
      { destinationHash: 'peer-hash', lastSeen: 1000 },
    ]);
    expect(manager.getReticulumAccountEndpointLeases()).toEqual([]);
    const neighbors1 = manager.getReticulumVerifiedNeighborHashes();
    (manager as any).promoteVerifiedReticulumPeer('peer-hash', 2000);
    expect(manager.getReticulumVerifiedTransportPeers()).toEqual([
      { destinationHash: 'peer-hash', lastSeen: 2000 },
    ]);
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual(neighbors1);
  });

  it('keeps relayed presence routes out of persistent overlay candidates', () => {
    const manager = new PresenceManager();
    const now = Date.now();
    const envelope = {
      id: 'forwarded-heartbeat',
      type: 'PRESENCE_HEARTBEAT',
      senderAddress: 'Q-forwarded',
      timestamp: now,
      payload: {
        address: 'Q-forwarded',
        publicKey: 'pk-forwarded',
        sessionId: 'sid-forwarded',
        status: 'online',
      },
      signature: 'sig-forwarded',
    };

    expect(
      (manager as any).applyVerifiedPresenceEnvelope(
        envelope,
        {
          kind: 'reticulum',
          destinationHash: 'origin-hash',
          viaDestinationHash: 'forwarder-hash',
          overlayHopsRemaining: 2,
        },
        now
      )
    ).toBe(true);

    expect(manager.isAddressOnline('Q-forwarded')).toBe(true);
    expect(manager.getReticulumVerifiedTransportPeers()).toEqual([]);
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual([]);
    expect(manager.getReticulumActiveNeighborHashes()).toEqual([]);
  });

  it('does not turn ordinary feature traffic into an overlay candidate', () => {
    const manager = new PresenceManager();

    manager.markReticulumOverlayPeerVerified(
      'feature-peer-hash',
      'reticulum_chat',
      Date.now()
    );

    expect(manager.getReticulumVerifiedTransportPeers()).toEqual([]);
    expect(manager.getReticulumActiveNeighborHashes()).toEqual([]);
  });

  it('requires authenticated admission before non-presence traffic becomes an overlay neighbor', () => {
    const manager = new PresenceManager();
    const now = Date.now();
    const verifiedEvents: unknown[] = [];
    manager.on('reticulum-peer-verified', (event) =>
      verifiedEvents.push(event)
    );

    manager.noteReticulumCandidateDiscovered('origin-hash', 'announce', now);
    manager.markReticulumOverlayPeerVerified(
      'origin-hash',
      'group_signal',
      now + 1
    );

    expect(manager.getReticulumVerifiedTransportPeers()).toEqual([]);
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual([]);
    expect(manager.getReticulumActiveNeighborHashes()).toEqual(['origin-hash']);
    expect(verifiedEvents).toHaveLength(0);

    manager.noteReticulumOverlayPeerAdmitted(
      'origin-hash',
      'overlay_hello',
      now + 2
    );

    expect(manager.getReticulumVerifiedTransportPeers()).toEqual([
      {
        destinationHash: 'origin-hash',
        lastSeen: now + 2,
      },
    ]);
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual([
      'origin-hash',
    ]);
    expect(verifiedEvents).toHaveLength(1);

    manager.markReticulumOverlayPeerVerified(
      'origin-hash',
      'call_signal',
      now + 3
    );

    expect(manager.getReticulumVerifiedTransportPeers()).toEqual([
      {
        destinationHash: 'origin-hash',
        lastSeen: now + 3,
      },
    ]);
    expect(verifiedEvents).toHaveLength(1);
  });

  it('emits an endpoint sync when a signed presence session creates a lease', () => {
    const manager = new PresenceManager();
    const overlayChanges: unknown[] = [];
    const endpointChanges: unknown[] = [];
    manager.on('reticulum-overlay-changed', (event) =>
      overlayChanges.push(event)
    );
    manager.on('reticulum-account-endpoints-changed', (event) =>
      endpointChanges.push(event)
    );
    const now = Date.now();

    manager.noteReticulumOverlayPeerAdmitted(
      'origin-hash',
      'overlay_hello',
      now
    );
    expect(overlayChanges).toHaveLength(1);

    expect(
      (manager as any).applyVerifiedPresenceEnvelope(
        {
          id: 'identity-binding-heartbeat',
          type: 'PRESENCE_HEARTBEAT',
          senderAddress: 'Q-bound',
          timestamp: now + 1,
          payload: {
            address: 'Q-bound',
            publicKey: 'pk-bound',
            sessionId: 'sid-bound',
            status: 'online',
          },
          signature: 'sig-bound',
        },
        {
          kind: 'reticulum',
          destinationHash: 'origin-hash',
        },
        now + 1
      )
    ).toBe(true);

    expect(manager.getReticulumVerifiedTransportPeers()).toEqual([
      {
        destinationHash: 'origin-hash',
        lastSeen: now + 1,
      },
    ]);
    expect(manager.getReticulumAccountEndpointLeases()).toEqual([
      expect.objectContaining({
        destinationHash: 'origin-hash',
        address: 'Q-bound',
        sessionId: 'sid-bound',
        verification: 'direct-legacy',
      }),
    ]);
    expect(overlayChanges).toHaveLength(1);
    expect(endpointChanges).toHaveLength(1);
  });

  it('supports account switching on one destination without stale ownership', () => {
    const manager = new PresenceManager();
    const now = Date.now();
    const destinationHash = 'aa'.repeat(16);
    const sessionA = 'PqqqqqqqqqqqqqqqqqqqqqgAAAAAAAAAAAAA';
    const sessionB = 'PqqqqqqqqqqqqqqqqqqqqqgBBBBBBBBBBBBB';
    const apply = (
      address: string,
      sessionId: string,
      type: 'PRESENCE_HEARTBEAT' | 'PRESENCE_OFFLINE',
      timestamp: number
    ) =>
      (manager as any).applyVerifiedPresenceEnvelope(
        {
          id: `${address}-${type}-${timestamp}`,
          type,
          senderAddress: address,
          timestamp,
          payload: {
            address,
            publicKey: `pk-${address}`,
            sessionId,
            status: type === 'PRESENCE_OFFLINE' ? 'offline' : 'online',
          },
          signature: `sig-${address}`,
        },
        { kind: 'reticulum', destinationHash },
        timestamp
      );

    manager.noteReticulumOverlayPeerAdmitted(
      destinationHash,
      'overlay_hello',
      now - 1
    );
    expect(apply('Q-account-a', sessionA, 'PRESENCE_HEARTBEAT', now)).toBe(
      true
    );
    expect(apply('Q-account-b', sessionB, 'PRESENCE_HEARTBEAT', now + 1)).toBe(
      true
    );
    expect(manager.getReticulumVerifiedTransportPeers()).toHaveLength(1);
    expect(
      manager.getReticulumAccountEndpointLeases().map((lease) => lease.address)
    ).toEqual(['Q-account-a', 'Q-account-b']);

    expect(apply('Q-account-a', sessionA, 'PRESENCE_OFFLINE', now + 2)).toBe(
      true
    );
    expect(manager.getReticulumVerifiedTransportPeers()).toHaveLength(1);
    expect(manager.getReticulumAccountEndpointLeases()).toEqual([
      expect.objectContaining({
        address: 'Q-account-b',
        destinationHash,
        sessionId: sessionB,
        verification: 'direct-bound',
      }),
    ]);
  });

  it('keeps a fanned-out presence proof as an announce-backed candidate', () => {
    const manager = new PresenceManager();
    const now = Date.now();
    manager.noteReticulumCandidateDiscovered('origin-hash', 'announce', now);
    const envelope = {
      id: 'announce-backed-heartbeat',
      type: 'PRESENCE_HEARTBEAT',
      senderAddress: 'Q-announced',
      timestamp: now + 1,
      payload: {
        address: 'Q-announced',
        publicKey: 'pk-announced',
        sessionId: 'sid-announced',
        status: 'online',
      },
      signature: 'sig-announced',
    };

    expect(
      (manager as any).applyVerifiedPresenceEnvelope(
        envelope,
        {
          kind: 'reticulum',
          destinationHash: 'origin-hash',
          viaDestinationHash: 'forwarder-hash',
          overlayHopsRemaining: 2,
        },
        now + 1
      )
    ).toBe(true);

    expect(manager.getReticulumVerifiedTransportPeers()).toEqual([]);
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual([]);
    expect(manager.getReticulumActiveNeighborHashes()).toEqual(['origin-hash']);
  });

  it('keeps delayed but valid Reticulum heartbeats alive from local receive time', () => {
    vi.useFakeTimers();
    const receiveAt = 100_000;
    vi.setSystemTime(receiveAt);
    const manager = new PresenceManager();
    const address = 'Q-delayed-presence';
    const envelope = {
      id: 'delayed-heartbeat',
      type: 'PRESENCE_HEARTBEAT',
      senderAddress: address,
      timestamp: receiveAt - 50_000,
      payload: {
        address,
        publicKey: 'pk-delayed-presence',
        sessionId: 'sid-delayed-presence',
        status: 'online',
      },
      signature: 'sig-delayed-presence',
    };

    expect(
      (manager as any).applyVerifiedPresenceEnvelope(
        envelope,
        {
          kind: 'reticulum',
          destinationHash: 'delayed-origin-hash',
          viaDestinationHash: 'delayed-forwarder-hash',
        },
        receiveAt
      )
    ).toBe(true);

    vi.setSystemTime(receiveAt + 30_000);
    manager.cleanupExpired();

    expect(manager.isAddressOnline(address)).toBe(true);
    // A legacy relayed envelope still contributes presence/status, but its
    // unsigned origin must not become an endpoint or overlay target.
    expect(manager.getReticulumFanoutDestinationHashes()).toEqual([]);

    vi.setSystemTime(receiveAt + PRESENCE_SESSION_TIMEOUT_MS + 1);
    manager.cleanupExpired();

    expect(manager.isAddressOnline(address)).toBe(false);
    expect(manager.getReticulumFanoutDestinationHashes()).toEqual([]);
    vi.useRealTimers();
  });

  it('keeps admitted verified peers stable after presence cleanup', () => {
    const manager = new PresenceManager();
    const hashes = promoteVerifiedPeers(
      manager,
      RETICULUM_OVERLAY_MAX_NEIGHBORS + 2
    );

    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual(
      hashes.slice(0, RETICULUM_OVERLAY_MAX_NEIGHBORS)
    );

    manager.cleanupExpired();

    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual(
      hashes.slice(0, RETICULUM_OVERLAY_MAX_NEIGHBORS)
    );
    expect(
      manager
        .getReticulumVerifiedTransportPeers()
        .map((peer) => peer.destinationHash)
    ).toEqual(hashes);
  });

  it('keeps verified fanout stable and uses latest announce candidates as backfill', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_100);
    const manager = new PresenceManager();
    const verified = promoteVerifiedPeers(
      manager,
      RETICULUM_OVERLAY_MAX_NEIGHBORS
    );

    manager.noteReticulumCandidateDiscovered(
      'candidate-older',
      'announce',
      10_000
    );
    manager.noteReticulumCandidateDiscovered(
      'candidate-newer',
      'announce',
      10_100
    );

    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual(verified);
    expect(manager.getReticulumActiveNeighborHashes()).toEqual(verified);

    manager.noteReticulumOverlayLinkClosed(verified[0], 'closed');

    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual(
      verified.slice(1)
    );
    expect(manager.getReticulumActiveNeighborHashes()).toEqual([
      ...verified.slice(1),
      'candidate-newer',
    ]);

    manager.noteReticulumOverlayLinkClosed(
      'candidate-newer',
      'destination_closed'
    );

    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual(
      verified.slice(1)
    );
    expect(manager.getReticulumActiveNeighborHashes()).toEqual([
      ...verified.slice(1),
      'candidate-older',
    ]);
    vi.useRealTimers();
  });

  it('alternates verified retries and latest announce candidates for open slots', () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_100);
    const manager = new PresenceManager();
    const verified = promoteVerifiedPeers(
      manager,
      RETICULUM_OVERLAY_MAX_NEIGHBORS + 2
    );

    manager.noteReticulumCandidateDiscovered(
      'candidate-older',
      'announce',
      20_000
    );
    manager.noteReticulumCandidateDiscovered(
      'candidate-newer',
      'announce',
      20_100
    );

    manager.noteReticulumOverlayLinkClosed(verified[0], 'closed');
    expect(manager.getReticulumActiveNeighborHashes()).toEqual([
      ...verified.slice(1, RETICULUM_OVERLAY_MAX_NEIGHBORS),
      verified[RETICULUM_OVERLAY_MAX_NEIGHBORS + 1],
    ]);

    manager.noteReticulumOverlayLinkClosed(verified[1], 'closed');
    expect(manager.getReticulumActiveNeighborHashes()).toEqual([
      ...verified.slice(2, RETICULUM_OVERLAY_MAX_NEIGHBORS),
      verified[RETICULUM_OVERLAY_MAX_NEIGHBORS + 1],
      'candidate-newer',
    ]);

    manager.noteReticulumOverlayLinkClosed(verified[2], 'closed');
    expect(manager.getReticulumActiveNeighborHashes()).toEqual([
      ...verified.slice(3, RETICULUM_OVERLAY_MAX_NEIGHBORS),
      verified[RETICULUM_OVERLAY_MAX_NEIGHBORS + 1],
      verified[RETICULUM_OVERLAY_MAX_NEIGHBORS],
      'candidate-newer',
    ]);

    manager.noteReticulumOverlayLinkClosed(verified[3], 'closed');
    expect(manager.getReticulumActiveNeighborHashes()).toEqual([
      ...verified.slice(4, RETICULUM_OVERLAY_MAX_NEIGHBORS),
      verified[RETICULUM_OVERLAY_MAX_NEIGHBORS + 1],
      verified[RETICULUM_OVERLAY_MAX_NEIGHBORS],
      'candidate-newer',
      'candidate-older',
    ]);
    vi.useRealTimers();
  });

  it('keeps a recently closed verified peer retained but out of active fanout', () => {
    const manager = new PresenceManager();
    const hashes = promoteVerifiedPeers(
      manager,
      RETICULUM_OVERLAY_MAX_NEIGHBORS + 1
    );

    vi.useFakeTimers();
    vi.setSystemTime(9_999);
    manager.noteReticulumOverlayLinkClosed(hashes[0], 'closed');

    expect(
      manager
        .getReticulumVerifiedTransportPeers()
        .map((peer) => peer.destinationHash)
    ).toEqual(hashes);
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual([
      ...hashes.slice(1, RETICULUM_OVERLAY_MAX_NEIGHBORS),
      hashes[RETICULUM_OVERLAY_MAX_NEIGHBORS],
    ]);

    vi.useRealTimers();
  });

  it('removes a verified fanout peer from active fanout after a timeout with recent activity', () => {
    const manager = new PresenceManager();
    const hashes = promoteVerifiedPeers(
      manager,
      RETICULUM_OVERLAY_MAX_NEIGHBORS + 1
    );

    vi.useFakeTimers();
    vi.setSystemTime(9_999);
    manager.noteReticulumOverlayLinkClosed(hashes[0], 'timeout', Date.now(), {
      lastActivityAgeMs: 1_041,
    });

    expect(
      manager
        .getReticulumVerifiedTransportPeers()
        .map((peer) => peer.destinationHash)
    ).toEqual(hashes);
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual(
      hashes.slice(1)
    );

    vi.useRealTimers();
  });

  it('removes a verified fanout peer from active fanout after destination_closed with recent activity', () => {
    const manager = new PresenceManager();
    const hashes = promoteVerifiedPeers(
      manager,
      RETICULUM_OVERLAY_MAX_NEIGHBORS + 1
    );

    vi.useFakeTimers();
    vi.setSystemTime(9_999);
    manager.noteReticulumOverlayLinkClosed(
      hashes[0],
      'destination_closed',
      Date.now(),
      {
        lastActivityAgeMs: 222,
      }
    );

    expect(
      manager
        .getReticulumVerifiedTransportPeers()
        .map((peer) => peer.destinationHash)
    ).toEqual(hashes);
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual(
      hashes.slice(1)
    );

    vi.useRealTimers();
  });

  it('does not clear link cooldown from relayed presence before cooldown expires', () => {
    const manager = new PresenceManager();
    const hashes = promoteVerifiedPeers(
      manager,
      RETICULUM_OVERLAY_MAX_NEIGHBORS + 1
    );

    vi.useFakeTimers();
    vi.setSystemTime(9_999);
    manager.noteReticulumOverlayLinkClosed(hashes[0], 'destination_closed');
    vi.setSystemTime(10_100);
    (manager as any).promoteVerifiedReticulumPeer(
      hashes[0],
      10_100,
      'presence-relayed'
    );

    expect(
      manager
        .getReticulumVerifiedTransportPeers()
        .map((peer) => peer.destinationHash)
    ).toEqual(hashes);
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual(
      hashes.slice(1)
    );

    vi.useRealTimers();
  });

  it('releases a closed verified slot after the grace window expires', () => {
    const manager = new PresenceManager();
    const hashes = promoteVerifiedPeers(
      manager,
      RETICULUM_OVERLAY_MAX_NEIGHBORS + 1
    );

    vi.useFakeTimers();
    vi.setSystemTime(9_999);
    manager.noteReticulumOverlayLinkClosed(hashes[0], 'closed');
    vi.setSystemTime(9_999 + RETICULUM_VERIFIED_PEER_LINK_CLOSE_GRACE_MS + 1);

    expect(
      manager
        .getReticulumVerifiedTransportPeers()
        .map((peer) => peer.destinationHash)
    ).toEqual(hashes.slice(1));
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual([
      ...hashes.slice(1, RETICULUM_OVERLAY_MAX_NEIGHBORS),
      hashes[RETICULUM_OVERLAY_MAX_NEIGHBORS],
    ]);

    vi.useRealTimers();
  });

  it('clears close cooldown only after authenticated overlay re-admission', () => {
    const manager = new PresenceManager();
    const hashes = promoteVerifiedPeers(
      manager,
      RETICULUM_OVERLAY_MAX_NEIGHBORS + 1
    );

    vi.useFakeTimers();
    vi.setSystemTime(9_999);
    manager.noteReticulumOverlayLinkClosed(hashes[0], 'closed');
    vi.setSystemTime(10_100);
    manager.markReticulumOverlayPeerVerified(hashes[0], 'group_signal', 10_050);
    expect(manager.getReticulumVerifiedNeighborHashes()).not.toContain(
      hashes[0]
    );
    manager.noteReticulumOverlayPeerAdmitted(hashes[0], 'overlay_pong', 10_100);
    vi.setSystemTime(10_100 + RETICULUM_VERIFIED_PEER_LINK_CLOSE_GRACE_MS + 1);

    expect(
      manager
        .getReticulumVerifiedTransportPeers()
        .map((peer) => peer.destinationHash)
    ).toEqual(hashes);
    expect(manager.getReticulumVerifiedNeighborHashes()).toEqual([
      ...hashes.slice(1, RETICULUM_OVERLAY_MAX_NEIGHBORS),
      hashes[RETICULUM_OVERLAY_MAX_NEIGHBORS],
    ]);

    vi.useRealTimers();
  });
});
