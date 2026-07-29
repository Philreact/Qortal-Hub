import { describe, expect, it, vi } from 'vitest';
import {
  GroupCallManager,
  buildParticipantFromVerifiedJoin,
  decodeGroupCallLogicalJoinGeneration,
  reticulumAudioResetReasonForVerifiedJoin,
  resolveVerifiedJoinTakeoverAt,
  resolveDmVoiceAudioLinkOpenDecision,
  resolveGroupCallSignedJoinGeneration,
  shouldApplyGroupCallLeaveToSession,
  shouldRefreshParticipantFromVerifiedJoin,
} from './group-call';

describe('DM voice audio-link ownership recovery', () => {
  it('opens immediately for the preferred opener', () => {
    expect(
      resolveDmVoiceAudioLinkOpenDecision({
        role: 'opener',
        createdAtMs: 1_000,
        nowMs: 1_000,
      })
    ).toBe('open');
  });

  it('lets the waiter recover only after the opener grace window', () => {
    expect(
      resolveDmVoiceAudioLinkOpenDecision({
        role: 'waiter',
        createdAtMs: 1_000,
        nowMs: 4_999,
      })
    ).toBe('defer');
    expect(
      resolveDmVoiceAudioLinkOpenDecision({
        role: 'waiter',
        createdAtMs: 1_000,
        nowMs: 5_000,
      })
    ).toBe('open');
  });
});

describe('group-call signed join generation transport', () => {
  it('preserves an already encoded takeover generation across IPC', () => {
    expect(resolveGroupCallSignedJoinGeneration(-4_000_000_001, false)).toBe(
      -4_000_000_001
    );
    expect(resolveGroupCallSignedJoinGeneration(-123, true)).toBe(-123);
  });

  it('still encodes takeover for older callers that send a logical generation', () => {
    expect(resolveGroupCallSignedJoinGeneration(122, true)).toBe(-123);
    expect(resolveGroupCallSignedJoinGeneration(122, false)).toBe(122);
  });
});

describe('group-call multi-device participant ownership', () => {
  function routeManager(): any {
    const manager = Object.create(GroupCallManager.prototype) as any;
    manager.reticulumPeerPresenceHashByAddress = new Map();
    manager.reticulumAddressByPeerPresenceHash = new Map();
    manager.promoteAwaitingRouteReticulumAudio = vi.fn();
    manager.presence = {
      getRouteForAddress: vi.fn(() => ({
        kind: 'reticulum',
        destinationHash: 'c'.repeat(32),
      })),
    };
    manager.rooms = new Map([
      [
        'room-a',
        {
          participants: new Map([
            ['Q-peer', { reticulumDestinationHash: 'a'.repeat(32) }],
          ]),
        },
      ],
      [
        'room-b',
        {
          participants: new Map([
            ['Q-peer', { reticulumDestinationHash: 'b'.repeat(32) }],
          ]),
        },
      ],
      ['room-without-peer', { participants: new Map() }],
    ]);
    return manager;
  }

  it('uses the participant endpoint from the requested room', () => {
    const manager = routeManager();
    expect(manager.resolveReticulumPeerPresenceHash('Q-peer', 'room-b')).toBe(
      'b'.repeat(32)
    );
  });

  it('does not borrow a device endpoint from an unrelated room', () => {
    const manager = routeManager();
    expect(
      manager.resolveReticulumPeerPresenceHash('Q-peer', 'room-without-peer')
    ).toBe('c'.repeat(32));
  });

  it('decodes the signed compact takeover generation', () => {
    expect(decodeGroupCallLogicalJoinGeneration(-8)).toBe(7);
    expect(decodeGroupCallLogicalJoinGeneration(7)).toBe(7);
  });

  it('allows same-session reannouncements without changing ownership', () => {
    expect(
      shouldRefreshParticipantFromVerifiedJoin({
        currentJoinedAt: 2_000,
        currentJoinGeneration: 10,
        currentTakeoverAt: 1_000,
        incomingJoinTimestamp: 3_000,
        incomingJoinGeneration: 10,
      })
    ).toBe(true);
  });

  it('initializes first-seen legacy joins instead of treating two absent generations as an existing session', () => {
    expect(
      resolveVerifiedJoinTakeoverAt({
        incomingJoinTimestamp: 3_000,
      })
    ).toBe(3_000);
    expect(
      buildParticipantFromVerifiedJoin(undefined, {
        type: 'GC_JOIN',
        roomId: 'dmv:test',
        chatId: 'direct:Q-local:Q-peer',
        fromAddress: 'Q-peer',
        fromPublicKey: 'peer-public-key',
        signature: 'signature',
        timestamp: 3_000,
        reticulumDestinationHash: 'A'.repeat(32),
      })
    ).toMatchObject({
      joinedAt: 3_000,
      takeoverAt: 3_000,
      reticulumDestinationHash: 'a'.repeat(32),
    });
  });

  it('preserves takeover time for real same-session reannouncements only', () => {
    expect(
      resolveVerifiedJoinTakeoverAt({
        currentJoinedAt: 2_000,
        currentTakeoverAt: 1_000,
        incomingJoinTimestamp: 3_000,
      })
    ).toBe(1_000);
    expect(
      resolveVerifiedJoinTakeoverAt({
        currentJoinedAt: 2_000,
        currentJoinGeneration: 10,
        currentTakeoverAt: 1_000,
        incomingJoinGeneration: 20,
        incomingJoinTimestamp: 3_000,
      })
    ).toBe(3_000);
  });

  it('rejects a different device generation unless it is an explicit takeover', () => {
    expect(
      shouldRefreshParticipantFromVerifiedJoin({
        currentJoinedAt: 2_000,
        currentJoinGeneration: 10,
        currentTakeoverAt: 1_000,
        incomingJoinTimestamp: 3_000,
        incomingJoinGeneration: 20,
      })
    ).toBe(false);
  });

  it('does not let a legacy join overwrite a selected session-aware device', () => {
    expect(
      shouldRefreshParticipantFromVerifiedJoin({
        currentJoinedAt: 2_000,
        currentJoinGeneration: 10,
        currentTakeoverAt: 1_000,
        incomingJoinTimestamp: 3_000,
      })
    ).toBe(false);
  });

  it('requires an explicit takeover when upgrading a legacy participant slot', () => {
    expect(
      shouldRefreshParticipantFromVerifiedJoin({
        currentJoinedAt: 2_000,
        currentTakeoverAt: 1_000,
        incomingJoinTimestamp: 3_000,
        incomingJoinGeneration: 10,
      })
    ).toBe(false);
    expect(
      shouldRefreshParticipantFromVerifiedJoin({
        currentJoinedAt: 2_000,
        currentTakeoverAt: 1_000,
        incomingJoinTimestamp: 3_000,
        incomingJoinGeneration: 10,
        incomingTakeover: true,
      })
    ).toBe(true);
  });

  it('accepts a newer explicit takeover and rejects a delayed older takeover', () => {
    expect(
      shouldRefreshParticipantFromVerifiedJoin({
        currentJoinedAt: 4_000,
        currentJoinGeneration: 10,
        currentTakeoverAt: 1_000,
        incomingJoinTimestamp: 3_000,
        incomingJoinGeneration: 20,
        incomingTakeover: true,
      })
    ).toBe(true);
    expect(
      shouldRefreshParticipantFromVerifiedJoin({
        currentJoinedAt: 4_000,
        currentJoinGeneration: 20,
        currentTakeoverAt: 3_000,
        incomingJoinTimestamp: 1_000,
        incomingJoinGeneration: 10,
        incomingTakeover: true,
      })
    ).toBe(false);
  });

  it('only applies a session-aware leave to the selected generation', () => {
    expect(
      shouldApplyGroupCallLeaveToSession({
        activeJoinGeneration: 20,
        leavingJoinGeneration: 10,
      })
    ).toBe(false);
    expect(
      shouldApplyGroupCallLeaveToSession({
        activeJoinGeneration: 20,
        leavingJoinGeneration: 20,
      })
    ).toBe(true);
  });

  it('binds legacy leaves to the selected transport endpoint', () => {
    expect(
      shouldApplyGroupCallLeaveToSession({
        activeJoinGeneration: 20,
        activeReticulumDestinationHash: 'aaaa',
        transportPeerPresenceHash: 'bbbb',
      })
    ).toBe(false);
    expect(
      shouldApplyGroupCallLeaveToSession({
        activeJoinGeneration: 20,
        activeReticulumDestinationHash: 'AAAA',
        transportPeerPresenceHash: 'aaaa',
      })
    ).toBe(true);
  });
});

describe('group-call verified join audio reset decision', () => {
  it('keeps matching audio state when a fresh join arrives before roster catches up', () => {
    expect(
      reticulumAudioResetReasonForVerifiedJoin({
        existingReticulumDestinationHash: '',
        incomingReticulumDestinationHash: '4fe300e8dd1288580600a2c5f1952092',
        currentAudioPeerPresenceHash: '4fe300e8dd1288580600a2c5f1952092',
        refreshedExistingJoin: false,
        rejoinsAfterLeave: false,
      })
    ).toBe('');
  });

  it('resets absent-participant audio state when it points at a different destination', () => {
    expect(
      reticulumAudioResetReasonForVerifiedJoin({
        existingReticulumDestinationHash: '',
        incomingReticulumDestinationHash: '4fe300e8dd1288580600a2c5f1952092',
        currentAudioPeerPresenceHash: 'b0f911489514f8f4255e9207755e9157',
        refreshedExistingJoin: false,
        rejoinsAfterLeave: false,
      })
    ).toBe('join-identity-changed');
  });

  it('resets existing participant audio state on real identity changes', () => {
    expect(
      reticulumAudioResetReasonForVerifiedJoin({
        existingReticulumDestinationHash: 'b0f911489514f8f4255e9207755e9157',
        incomingReticulumDestinationHash: '4fe300e8dd1288580600a2c5f1952092',
        currentAudioPeerPresenceHash: 'b0f911489514f8f4255e9207755e9157',
        refreshedExistingJoin: true,
        rejoinsAfterLeave: false,
      })
    ).toBe('join-identity-changed');
  });

  it('resets when a verified rejoin follows a real leave tombstone', () => {
    expect(
      reticulumAudioResetReasonForVerifiedJoin({
        existingReticulumDestinationHash: '4fe300e8dd1288580600a2c5f1952092',
        incomingReticulumDestinationHash: '4fe300e8dd1288580600a2c5f1952092',
        currentAudioPeerPresenceHash: '4fe300e8dd1288580600a2c5f1952092',
        refreshedExistingJoin: true,
        rejoinsAfterLeave: true,
      })
    ).toBe('fresh-verified-rejoin-after-leave');
  });
});

describe('group-call Reticulum forwarding recipients', () => {
  const room = {
    participants: new Map(
      ['Q-root', 'Q-a', 'Q-forwarder', 'Q-b', 'Q-c'].map((address) => [
        address,
        {},
      ])
    ),
    lastTopology: {
      topologyEpoch: 3,
      rootForwarder: 'Q-root',
      standbyForwarder: 'Q-forwarder',
      clusters: [
        { forwarder: 'Q-root', members: ['Q-root', 'Q-a'] },
        {
          forwarder: 'Q-forwarder',
          members: ['Q-forwarder', 'Q-b', 'Q-c'],
        },
      ],
      lastSeen: {},
    },
  };

  function managerFor(localAddress: string): any {
    const manager = Object.create(GroupCallManager.prototype) as any;
    manager.localAddresses = new Set([localAddress]);
    return manager;
  }

  it('keeps root forwarding identical for member and cluster ingress', () => {
    const manager = managerFor('Q-root');
    expect(
      [...manager.computeReticulumAudioForwardRecipients(room, 'Q-a')].sort()
    ).toEqual(['Q-forwarder']);
    expect(
      [
        ...manager.computeReticulumAudioForwardRecipients(room, 'Q-forwarder'),
      ].sort()
    ).toEqual(['Q-a']);
  });

  it('keeps cluster forwarding identical for root and member ingress', () => {
    const manager = managerFor('Q-forwarder');
    expect(
      [...manager.computeReticulumAudioForwardRecipients(room, 'Q-root')].sort()
    ).toEqual(['Q-b', 'Q-c']);
    expect(
      [...manager.computeReticulumAudioForwardRecipients(room, 'Q-b')].sort()
    ).toEqual(['Q-c', 'Q-root']);
  });

  it('invalidates forwarding plans when a peer transport route changes', () => {
    const manager = managerFor('Q-root');
    manager.reticulumAudioAddressByLinkId = new Map([
      ['packet:peer-hash', 'Q-peer'],
    ]);
    manager.scheduleReticulumAudioForwardingPlanSync = vi.fn();
    const state = {
      transport: 'packet',
      routeKey: 'packet:peer-hash',
      peerPresenceHash: 'peer-hash',
      linkId: 'link-1',
    };

    manager.setReticulumAudioTransport('Q-peer', state, 'link', 'fallback');

    expect(state.transport).toBe('link');
    expect(state.routeKey).toBe('link-1');
    expect(
      manager.scheduleReticulumAudioForwardingPlanSync
    ).toHaveBeenCalledOnce();
  });

  it('removes forwarding during recovery and refreshes it after the hold', () => {
    vi.useFakeTimers();
    try {
      const manager = managerFor('Q-root');
      manager.reticulumAudioForwardingPlanRecoveryTimersByAddress = new Map();
      manager.reticulumAudioPeersByAddress = new Map();
      manager.scheduleReticulumAudioForwardingPlanSync = vi.fn();
      manager.logReticulumFailureThrottled = vi.fn();
      manager.scheduleReticulumAudioFlush = vi.fn();
      const state = {
        recoveryHoldUntilMs: 0,
        recoveryReason: '',
        pending: [{}],
      };
      manager.reticulumAudioPeersByAddress.set('Q-peer', state);

      manager.holdReticulumAudioRouteRecovery(
        'Q-peer',
        state,
        'packet-failed',
        100
      );

      expect(state.pending).toEqual([]);
      expect(
        manager.scheduleReticulumAudioForwardingPlanSync
      ).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(101);
      expect(
        manager.scheduleReticulumAudioForwardingPlanSync
      ).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an urgent forwarding update preempt a delayed retry', () => {
    vi.useFakeTimers();
    try {
      const manager = managerFor('Q-root');
      manager.started = true;
      manager.reticulumBridge = {};
      manager.reticulumAudioForwardingPlanRevision = 0;
      manager.reticulumAudioForwardingPlanTimer = null;
      manager.reticulumAudioForwardingPlanTimerDueAtMs = 0;
      manager.applyReticulumAudioForwardingPlans = vi.fn();

      manager.scheduleReticulumAudioForwardingPlanSync(1_000);
      vi.advanceTimersByTime(100);
      manager.scheduleReticulumAudioForwardingPlanSync(25);
      vi.advanceTimersByTime(24);
      expect(manager.applyReticulumAudioForwardingPlans).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(manager.applyReticulumAudioForwardingPlans).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a forwarding plan that finishes after the manager stops', async () => {
    let resolveConfigure: ((value: { ok: true }) => void) | undefined;
    const configureResult = new Promise<{ ok: true }>((resolve) => {
      resolveConfigure = resolve;
    });
    const bridge = {
      getState: vi.fn(() => 'ready'),
      configureGroupAudioForwarding: vi
        .fn()
        .mockReturnValueOnce(configureResult)
        .mockResolvedValue({ ok: true }),
    };
    const manager = managerFor('Q-root');
    manager.started = true;
    manager.reticulumBridge = bridge;
    manager.reticulumAudioForwardingPlanSyncInFlight = false;
    manager.reticulumAudioForwardingPlanRevision = 1;
    manager.reticulumAudioForwardingPlanGeneration = 0;
    manager.reticulumAudioForwardingPlanAppliedKey = '';
    manager.buildReticulumAudioForwardingPlans = vi.fn(() => []);

    const applying = manager.applyReticulumAudioForwardingPlans();
    manager.started = false;
    manager.reticulumAudioForwardingPlanGeneration++;
    resolveConfigure?.({ ok: true });
    await applying;
    await Promise.resolve();

    expect(bridge.configureGroupAudioForwarding).toHaveBeenNthCalledWith(1, []);
    expect(bridge.configureGroupAudioForwarding).toHaveBeenNthCalledWith(
      2,
      [],
      { startIfNeeded: false }
    );
    expect(manager.reticulumAudioForwardingPlanAppliedKey).toBe('');
  });

  it('releases and retries forwarding sync after plan preparation throws', async () => {
    const manager = managerFor('Q-root');
    manager.started = true;
    manager.reticulumBridge = {};
    manager.reticulumAudioForwardingPlanSyncInFlight = false;
    manager.reticulumAudioForwardingPlanRevision = 1;
    manager.reticulumAudioForwardingPlanGeneration = 0;
    manager.buildReticulumAudioForwardingPlans = vi.fn(() => {
      throw new Error('bad-plan');
    });
    manager.logReticulumFailureThrottled = vi.fn();
    manager.scheduleReticulumAudioForwardingPlanSync = vi.fn();

    await manager.applyReticulumAudioForwardingPlans();

    expect(manager.reticulumAudioForwardingPlanSyncInFlight).toBe(false);
    expect(manager.logReticulumFailureThrottled).toHaveBeenCalledWith(
      'audio-forward-plan:prepare-exception',
      expect.stringContaining('bad-plan')
    );
    expect(
      manager.scheduleReticulumAudioForwardingPlanSync
    ).toHaveBeenCalledWith(1_000);
  });

  it('ignores stale fast-path activity and preserves newer recovery state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:30.000Z'));
    try {
      const manager = managerFor('Q-root');
      const roomId = 'gcall-qortal-716';
      const address = 'Q-source';
      const state = {
        transport: 'packet',
        lastInboundAtMs: 0,
        lastInboundPacketAtMs: 0,
        lastRecoveryActionAtMs: Date.now() - 1_000,
        recoveryHoldUntilMs: Date.now() + 5_000,
        recoveryReason: 'packet-failed',
      };
      manager.rooms = new Map([
        [roomId, { participants: new Map([[address, {}]]) }],
      ]);
      manager.reticulumAudioPeersByAddress = new Map([[address, state]]);
      manager.shouldRejectQortalGroupCallAddress = vi.fn(() => false);
      manager.isReticulumAudioLinkVerifiedForAddress = vi.fn(() => true);
      manager.noteRecentCallActivity = vi.fn();
      manager.noteBootstrapParticipantActivity = vi.fn();
      manager.clearReticulumAudioRecoveryHold = vi.fn();

      manager.handleReticulumGroupAudioFastPathActivity({
        roomId,
        sourceAddress: address,
        linkId: '',
        peerPresenceHash: 'peer-hash',
        peerDestinationHash: 'destination-hash',
        forwardedTargets: 1,
        receivedAtWallMs: Date.now() - 12_000,
      });
      expect(manager.noteRecentCallActivity).not.toHaveBeenCalled();

      const beforeRecoveryAtMs = Date.now() - 2_000;
      manager.handleReticulumGroupAudioFastPathActivity({
        roomId,
        sourceAddress: address,
        linkId: '',
        peerPresenceHash: 'peer-hash',
        peerDestinationHash: 'destination-hash',
        forwardedTargets: 1,
        receivedAtWallMs: beforeRecoveryAtMs,
      });
      expect(state.lastInboundAtMs).toBe(beforeRecoveryAtMs);
      expect(manager.clearReticulumAudioRecoveryHold).not.toHaveBeenCalled();

      const afterRecoveryAtMs = Date.now() - 500;
      manager.handleReticulumGroupAudioFastPathActivity({
        roomId,
        sourceAddress: address,
        linkId: '',
        peerPresenceHash: 'peer-hash',
        peerDestinationHash: 'destination-hash',
        forwardedTargets: 1,
        receivedAtWallMs: afterRecoveryAtMs,
      });
      expect(state.lastInboundAtMs).toBe(afterRecoveryAtMs);
      expect(state.lastInboundPacketAtMs).toBe(afterRecoveryAtMs);
      expect(manager.clearReticulumAudioRecoveryHold).toHaveBeenCalledWith(
        address,
        state
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
