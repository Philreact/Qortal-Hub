import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import nacl from 'tweetnacl';
import {
  buildReticulumChatSignedFields,
  buildReticulumChatEventHint,
  hashReticulumChatPayload,
  ReticulumChatManager,
  type ReticulumChatEvent,
  validateReticulumChatEventShape,
  verifyReticulumChatEvent,
} from './reticulum-chat';
import {
  base58Encode,
  canonicalizeForSigning,
  deriveAddressFromPublicKey,
} from './presence';
import { ReticulumChatDatabase } from './reticulum-chat-db';
import {
  RT_RETICULUM_MAX_WIRE_JSON_BYTES,
  byteLengthUtf8JsonWithBridgeSender,
} from './reticulum-wire-size';

function signedEvent(overrides: Partial<ReticulumChatEvent> = {}): ReticulumChatEvent {
  const kp = nacl.sign.keyPair();
  const publicKey = base58Encode(kp.publicKey);
  const encryptedPayload = overrides.encryptedPayload ?? 'ciphertext';
  const event: ReticulumChatEvent = {
    eventId: overrides.eventId ?? `event-${Math.random().toString(16).slice(2)}`,
    groupId: overrides.groupId ?? 7,
    authorAddress: overrides.authorAddress ?? deriveAddressFromPublicKey(publicKey),
    authorPublicKey: overrides.authorPublicKey ?? publicKey,
    authorSeq: overrides.authorSeq ?? 1,
    timestamp: overrides.timestamp ?? Date.now(),
    eventType: overrides.eventType ?? 'message',
    ...(overrides.targetEventId ? { targetEventId: overrides.targetEventId } : {}),
    ...(overrides.replyToEventId ? { replyToEventId: overrides.replyToEventId } : {}),
    encryptedPayload,
    payloadHash:
      overrides.payloadHash ?? hashReticulumChatPayload(encryptedPayload),
    signature: '',
  };
  const signedBytes = canonicalizeForSigning(
    buildReticulumChatSignedFields(event)
  );
  const sig = nacl.sign.detached(
    new Uint8Array(signedBytes),
    kp.secretKey
  );
  event.signature = overrides.signature ?? base58Encode(sig);
  return event;
}

function tempDbPath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-chat-test-')),
    'reticulum-chat.db'
  );
}

describe('reticulum chat protocol', () => {
  it('validates event shape and signature', () => {
    const event = signedEvent();
    expect(validateReticulumChatEventShape(event)).toBe(true);
    expect(verifyReticulumChatEvent(event)).toBe(true);
  });

  it('rejects payload hash mismatches before signature verification', () => {
    const event = signedEvent({ payloadHash: '0'.repeat(64) });
    expect(validateReticulumChatEventShape(event)).toBe(false);
  });

  it('rejects signatures when signed fields are mutated', () => {
    const event = signedEvent();
    event.authorSeq += 1;
    expect(validateReticulumChatEventShape(event)).toBe(true);
    expect(verifyReticulumChatEvent(event)).toBe(false);
  });
});

describe('reticulum chat database', () => {
  const dbs: ReticulumChatDatabase[] = [];
  afterEach(() => {
    while (dbs.length) dbs.pop()?.close();
  });

  it('dedupes events by eventId and builds sync state', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const event = signedEvent({ groupId: 11, authorSeq: 3 });
    expect(db.insertEvent(event, false)).toBe(true);
    expect(db.insertEvent(event, false)).toBe(false);
    expect(db.hasEvent(event.eventId)).toBe(true);
    expect(db.getSyncState(11)).toEqual({ [event.authorAddress]: 3 });
  });

  it('does not count own events against the relay cache budget', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    db.insertEvent(signedEvent({ eventId: 'own-event' }), true);
    expect(db.getRelayCacheBytes()).toBe(0);
    db.insertEvent(signedEvent({ eventId: 'relay-event' }), false);
    expect(db.getRelayCacheBytes()).toBeGreaterThan(0);
  });

  it('shares inserted events across open database connections', () => {
    const dbPath = tempDbPath();
    const writer = new ReticulumChatDatabase(dbPath);
    const reader = new ReticulumChatDatabase(dbPath);
    dbs.push(writer, reader);
    const event = signedEvent({ groupId: 44, authorSeq: 1 });
    expect(writer.insertEvent(event, true)).toBe(true);
    expect(reader.getEvent(event.eventId)?.eventId).toBe(event.eventId);
    expect(reader.getRecentEvents(44, 10).map((item) => item.eventId)).toContain(
      event.eventId
    );
  });

  it('returns recent group events when requester has empty sync state', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const event = signedEvent({ groupId: 45, authorSeq: 1 });
    db.insertEvent(event, true);
    expect(db.getMissingEvents(45, {}, 10).map((item) => item.eventId)).toEqual([
      event.eventId,
    ]);
  });

  it('includes authors missing from requester sync state', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const first = signedEvent({ groupId: 46, authorSeq: 2 });
    const second = signedEvent({ groupId: 46, authorSeq: 1 });
    db.insertEvent(first, true);
    db.insertEvent(second, true);
    const missing = db.getMissingEvents(
      46,
      { [first.authorAddress]: 2 },
      10
    );
    expect(missing.map((item) => item.eventId)).toEqual([second.eventId]);
  });

  it('returns bounded timestamp windows for scalable sync', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const events = [1, 2, 3, 4].map((seq) =>
      signedEvent({
        eventId: `event-window-${seq}`,
        groupId: 47,
        authorSeq: seq,
        timestamp: 1_000 + seq * 100,
      })
    );
    for (const event of events) db.insertEvent(event, true);

    expect(db.getRecentEvents(47, 2).map((item) => item.eventId)).toEqual([
      'event-window-3',
      'event-window-4',
    ]);
    expect(db.getEventsAfter(47, 1_250, 10).map((item) => item.eventId)).toEqual([
      'event-window-3',
      'event-window-4',
    ]);
    expect(db.getEventsAfter(47, 1_300, 10, 'event-window-3').map((item) => item.eventId)).toEqual([
      'event-window-4',
    ]);
    expect(db.getEventsBefore(47, 1_350, 10).map((item) => item.eventId)).toEqual([
      'event-window-1',
      'event-window-2',
      'event-window-3',
    ]);
    expect(db.getEventsBefore(47, 1_300, 10, 'event-window-3').map((item) => item.eventId)).toEqual([
      'event-window-1',
      'event-window-2',
    ]);
  });
});

describe('reticulum chat manager', () => {
  function waitForEvent(manager: ReticulumChatManager, timeoutMs = 500) {
    return new Promise<ReticulumChatEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        manager.off('event', onEvent);
        reject(new Error('Timed out waiting for Reticulum chat event'));
      }, timeoutMs);
      const onEvent = (payload: { event?: ReticulumChatEvent }) => {
        if (!payload.event) return;
        clearTimeout(timeout);
        manager.off('event', onEvent);
        resolve(payload.event);
      };
      manager.on('event', onEvent);
    });
  }

  it('publishes durable events as compact hints instead of inline event bodies', async () => {
    const sent: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        sent.push(...messages);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
    });
    const event = signedEvent({ groupId: 9 });
    manager.setLocalGroupMemberships([9]);
    const result = await manager.publishEvent(event);
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      t: 'RCHAT',
      k: 'event_hint',
      g: 9,
      h: {
        id: event.eventId,
        ph: event.payloadHash,
      },
    });
    expect(JSON.stringify(sent[0])).not.toContain('encryptedPayload');
    expect(byteLengthUtf8JsonWithBridgeSender(sent[0])).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    manager.close();
  });

  it('treats local persistence as send success when live fanout has no route', async () => {
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        fanoutReticulumChatDetailed: async () => ({
          ok: false as const,
          reason: 'no-route' as const,
          error: 'No overlay route',
        }),
      } as any,
    });
    const event = signedEvent({ groupId: 52 });
    manager.setLocalGroupMemberships([52]);

    const result = await manager.publishEvent(event);

    expect(result).toEqual({ ok: true });
    expect(manager.getHistory(52, 10).map((item) => item.eventId)).toContain(
      event.eventId
    );
    manager.close();
  });

  it('requests a missing hinted event once per throttle window', () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    const event = signedEvent({ groupId: 9 });
    manager.setLocalGroupMemberships([9]);
    manager.subscribeGroup(9);
    const hint = buildReticulumChatEventHint(event);
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_hint',
        g: 9,
        h: {
          id: hint.eventId,
          a: hint.authorAddress,
          n: hint.authorSeq,
          ts: hint.timestamp,
          et: hint.eventType,
          ph: hint.payloadHash,
        },
      },
      'peer'
    );
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_hint',
        g: 9,
        h: {
          id: hint.eventId,
          a: hint.authorAddress,
          n: hint.authorSeq,
          ts: hint.timestamp,
          et: hint.eventType,
          ph: hint.payloadHash,
        },
      },
      'peer'
    );
    expect(direct.filter((wire) => wire.k === 'event_req')).toHaveLength(1);
    manager.close();
  });

  it('subscribes with a latest sync window when no local history exists', () => {
    const sent: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        sent.push(...messages);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
    });
    manager.subscribeGroup(48);
    expect(sent).toContainEqual({ t: 'RCHAT', k: 'sub', g: 48 });
    expect(sent.find((wire) => wire.k === 'sync_req')).toMatchObject({
      t: 'RCHAT',
      k: 'sync_req',
      g: 48,
      mode: 'latest',
      limit: 100,
    });
    manager.close();
  });

  it('subscribes with an after cursor when local history exists', async () => {
    const sent: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        sent.push(...messages);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 60_000,
    });
    manager.setLocalGroupMemberships([49]);
    const event = signedEvent({ groupId: 49, timestamp: 50_000 });
    await manager.publishEvent(event);
    sent.length = 0;

    manager.subscribeGroup(49);
    expect(sent.find((wire) => wire.k === 'sync_req')).toMatchObject({
      t: 'RCHAT',
      k: 'sync_req',
      g: 49,
      mode: 'after',
      ts: 45_000,
      limit: 100,
    });
    manager.close();
  });

  it('responds to sync requests with compact hint batches', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 60_000,
    });
    manager.setLocalGroupMemberships([50]);
    const event = signedEvent({ groupId: 50, timestamp: 10_000 });
    await manager.publishEvent(event);

    manager.handleWire(
      { t: 'RCHAT', k: 'sync_req', g: 50, mode: 'latest', limit: 10 },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({
      t: 'RCHAT',
      k: 'sync_hints',
      g: 50,
      hints: [{ id: event.eventId, ph: event.payloadHash }],
    });
    expect(JSON.stringify(direct[0])).not.toContain('encryptedPayload');
    expect(byteLengthUtf8JsonWithBridgeSender(direct[0])).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    manager.close();
  });

  it('continues bounded sync windows forward until catch-up is complete', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 60_000,
    });
    manager.setLocalGroupMemberships([51]);
    manager.subscribeGroup(51);
    const events = [1, 2, 3].map((seq) =>
      signedEvent({
        eventId: `event-page-${seq}`,
        groupId: 51,
        authorSeq: seq,
        timestamp: 20_000 + seq,
      })
    );
    for (const event of events) await manager.publishEvent(event);
    direct.length = 0;

    manager.handleWire(
      { t: 'RCHAT', k: 'sync_req', g: 51, mode: 'after', ts: 20_001, id: 'event-page-1', limit: 1 },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const continuationFrame = direct.find((wire) => wire.k === 'sync_hints' && wire.more === true);
    expect(continuationFrame).toMatchObject({
      t: 'RCHAT',
      k: 'sync_hints',
      g: 51,
      more: true,
      nextTs: 20_002,
      nextId: 'event-page-2',
      hints: [expect.objectContaining({ id: 'event-page-2' })],
    });

    manager.handleWire(continuationFrame as Record<string, unknown>, 'peer');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct.find((wire) => wire.k === 'sync_req')).toMatchObject({
      t: 'RCHAT',
      k: 'sync_req',
      g: 51,
      mode: 'after',
      ts: 20_002,
      id: 'event-page-2',
      limit: 100,
    });
    manager.close();
  });

  it('continues latest sync backward to recover older history', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 60_000,
    });
    manager.setLocalGroupMemberships([53]);
    manager.subscribeGroup(53);
    const events = [1, 2, 3].map((seq) =>
      signedEvent({
        eventId: `event-history-${seq}`,
        groupId: 53,
        authorSeq: seq,
        timestamp: 30_000 + seq,
      })
    );
    for (const event of events) await manager.publishEvent(event);
    direct.length = 0;

    manager.handleWire(
      { t: 'RCHAT', k: 'sync_req', g: 53, mode: 'latest', limit: 2 },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const continuationFrame = direct.find((wire) => wire.k === 'sync_hints' && wire.moreBefore === true);
    expect(continuationFrame).toMatchObject({
      t: 'RCHAT',
      k: 'sync_hints',
      g: 53,
      moreBefore: true,
      prevTs: 30_002,
      prevId: 'event-history-2',
      hints: expect.arrayContaining([expect.objectContaining({ id: 'event-history-2' })]),
    });

    manager.handleWire(continuationFrame as Record<string, unknown>, 'peer');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct.find((wire) => wire.k === 'sync_req')).toMatchObject({
      t: 'RCHAT',
      k: 'sync_req',
      g: 53,
      mode: 'before',
      ts: 30_002,
      id: 'event-history-2',
      limit: 100,
    });
    manager.close();
  });

  it('serves cached group history even when the group is not currently open', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 60_000,
    });
    manager.setLocalGroupMemberships([54]);
    const event = signedEvent({
      eventId: 'event-archived-openless',
      groupId: 54,
      timestamp: 50_000,
    });
    await manager.publishEvent(event);
    manager.setLocalGroupMemberships([]);
    direct.length = 0;

    manager.handleWire(
      { t: 'RCHAT', k: 'sync_req', g: 54, mode: 'latest', limit: 10 },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct.find((wire) => wire.k === 'sync_hints')).toMatchObject({
      t: 'RCHAT',
      k: 'sync_hints',
      g: 54,
      hints: [expect.objectContaining({ id: event.eventId })],
    });
    manager.close();
  });

  it('emits new shared DB events written by another instance for subscribed groups', async () => {
    const dbPath = tempDbPath();
    const noopBridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
    };
    const writer = new ReticulumChatManager({
      dbPath,
      bridge: noopBridge as any,
      localNotifyDebounceMs: 10,
    });
    const reader = new ReticulumChatManager({
      dbPath,
      bridge: noopBridge as any,
      localNotifyDebounceMs: 10,
    });
    writer.setLocalGroupMemberships([33]);
    reader.setLocalGroupMemberships([33]);
    reader.subscribeGroup(33);

    const eventPromise = waitForEvent(reader);
    const event = signedEvent({ groupId: 33, authorSeq: 1 });
    const result = await writer.publishEvent(event);
    expect(result.ok).toBe(true);
    expect(reader.getHistory(33, 10).map((item) => item.eventId)).toContain(
      event.eventId
    );
    await expect(eventPromise).resolves.toMatchObject({
      eventId: event.eventId,
      groupId: 33,
    });

    writer.close();
    reader.close();
  });
});
