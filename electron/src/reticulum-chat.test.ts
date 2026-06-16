import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as nodeCrypto from 'crypto';
import nacl from 'tweetnacl';
import {
  buildReticulumChatSignedFields,
  buildReticulumChatEventRequestSignedFields,
  buildReticulumChatEventHint,
  hashReticulumChatPayload,
  ReticulumChatManager,
  serializeReticulumChatEvent,
  type ReticulumChatEvent,
  validateReticulumChatEventShape,
  verifyReticulumChatEvent,
  type ReticulumChatManagerOptions,
} from './reticulum-chat';
import {
  base58Encode,
  canonicalizeForSigning,
  deriveAddressFromPublicKey,
} from './presence';
import {
  hashReticulumChatMentionAddress,
  ReticulumChatDatabase,
} from './reticulum-chat-db';
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
    mentionAddressHashes: overrides.mentionAddressHashes ?? [],
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

function signedAuthorEvents(
  events: Array<Partial<ReticulumChatEvent>>
): ReticulumChatEvent[] {
  const kp = nacl.sign.keyPair();
  const publicKey = base58Encode(kp.publicKey);
  const authorAddress = deriveAddressFromPublicKey(publicKey);
  return events.map((overrides) => {
    const encryptedPayload = overrides.encryptedPayload ?? 'ciphertext';
    const event: ReticulumChatEvent = {
      eventId: overrides.eventId ?? `event-${Math.random().toString(16).slice(2)}`,
      groupId: overrides.groupId ?? 7,
      authorAddress,
      authorPublicKey: publicKey,
      authorSeq: overrides.authorSeq ?? 1,
      timestamp: overrides.timestamp ?? Date.now(),
      eventType: overrides.eventType ?? 'message',
      ...(overrides.targetEventId ? { targetEventId: overrides.targetEventId } : {}),
      ...(overrides.replyToEventId ? { replyToEventId: overrides.replyToEventId } : {}),
      encryptedPayload,
      payloadHash: overrides.payloadHash ?? hashReticulumChatPayload(encryptedPayload),
      mentionAddressHashes: overrides.mentionAddressHashes ?? [],
      signature: '',
    };
    const sig = nacl.sign.detached(
      new Uint8Array(canonicalizeForSigning(buildReticulumChatSignedFields(event))),
      kp.secretKey
    );
    event.signature = overrides.signature ?? base58Encode(sig);
    return event;
  });
}

function createReticulumChatTestSigner(): NonNullable<ReticulumChatManagerOptions['signLocalFields']> {
  const kp = nacl.sign.keyPair();
  const authorPublicKey = base58Encode(kp.publicKey);
  const authorAddress = deriveAddressFromPublicKey(authorPublicKey);
  return async (fields) => {
    const fullFields = {
      ...fields,
      authorAddress,
      authorPublicKey,
    };
    const signedFields =
      fullFields.type === 'RCHAT_EVENT_REQ' &&
      typeof fullFields.groupId === 'number' &&
      typeof fullFields.eventId === 'string' &&
      typeof fullFields.timestamp === 'number'
        ? buildReticulumChatEventRequestSignedFields({
            groupId: fullFields.groupId,
            eventId: fullFields.eventId,
            authorAddress,
            authorPublicKey,
            timestamp: fullFields.timestamp,
          })
        : fullFields;
    const signature = nacl.sign.detached(
      new Uint8Array(canonicalizeForSigning(signedFields)),
      kp.secretKey
    );
    return {
      authorAddress,
      authorPublicKey,
      signature: base58Encode(signature),
    };
  };
}

function signedEventRequestWire(params: {
  groupId: number;
  eventId: string;
  timestamp: number;
}): {
  id: string;
  a: string;
  pk: string;
  ts: number;
  sig: string;
} {
  const kp = nacl.sign.keyPair();
  const authorPublicKey = base58Encode(kp.publicKey);
  const authorAddress = deriveAddressFromPublicKey(authorPublicKey);
  const fields = buildReticulumChatEventRequestSignedFields({
    groupId: params.groupId,
    eventId: params.eventId,
    authorAddress,
    authorPublicKey,
    timestamp: params.timestamp,
  });
  return {
    id: params.eventId,
    a: authorAddress,
    pk: authorPublicKey,
    ts: params.timestamp,
    sig: base58Encode(
      nacl.sign.detached(
        new Uint8Array(canonicalizeForSigning(fields)),
        kp.secretKey
      )
    ),
  };
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

  it('searches indexed public event payloads by group', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const matching = signedEvent({
      eventId: 'event-search-match',
      groupId: 42,
      encryptedPayload: JSON.stringify({
        messageText: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'alpha searchable phrase' }],
            },
          ],
        },
      }),
    });
    const otherGroup = signedEvent({
      eventId: 'event-search-other-group',
      groupId: 43,
      encryptedPayload: JSON.stringify({ messageText: 'alpha searchable phrase' }),
    });
    db.insertEvent(matching, true);
    db.insertEvent(otherGroup, true);

    expect(db.searchEvents('searchable', { groupIds: [42] }).map((item) => item.event.eventId)).toEqual([
      matching.eventId,
    ]);
    expect(db.searchEvents('alpha phrase', { groupIds: [99] })).toEqual([]);
  });

  it('indexes decrypted search text for encrypted/private events', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const event = signedEvent({
      eventId: 'event-private-search',
      groupId: 51,
      encryptedPayload: 'opaque-ciphertext',
    });
    db.insertEvent(event, true);
    expect(db.searchEvents('private needle')).toEqual([]);

    expect(db.indexSearchText(event.eventId, 'private needle after decrypt')).toBe(
      true
    );
    expect(db.searchEvents('needle', { groupIds: [51] })[0]?.event.eventId).toBe(
      event.eventId
    );
  });

  it('replaces and deletes search text for edit and delete events', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const event = signedEvent({
      eventId: 'event-search-delete-target',
      groupId: 62,
      encryptedPayload: JSON.stringify({ messageText: 'original searchable text' }),
    });
    db.insertEvent(event, true);

    expect(db.indexSearchText(event.eventId, 'edited replacement text')).toBe(
      true
    );
    expect(db.searchEvents('original', { groupIds: [62] })).toEqual([]);
    expect(db.searchEvents('replacement', { groupIds: [62] })[0]?.event.eventId).toBe(
      event.eventId
    );

    expect(db.deleteSearchText(event.eventId)).toBe(true);
    expect(db.searchEvents('replacement', { groupIds: [62] })).toEqual([]);
  });

  it('tracks unread mentions by mentioned address', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const event = signedEvent({
      eventId: 'event-mention-target',
      groupId: 63,
      authorAddress: 'Qauthor',
    });
    db.insertEvent(event, true);

    expect(db.replaceMentionsForEvent(event.eventId, ['Qmentioned'])).toBe(true);
    expect(db.getChatSummaries('Qmentioned')[0]).toMatchObject({
      groupId: 63,
      mentionCount: 1,
      hasUnreadMention: true,
    });

    db.markRead(63, event.timestamp, 'Qmentioned');
    expect(db.getChatSummaries('Qmentioned')[0]).toMatchObject({
      mentionCount: 0,
      hasUnreadMention: false,
    });
  });

  it('keeps read watermarks separate for local accounts sharing one db', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const accountA = deriveAddressFromPublicKey(base58Encode(nacl.sign.keyPair().publicKey));
    const accountB = deriveAddressFromPublicKey(base58Encode(nacl.sign.keyPair().publicKey));
    const event = signedEvent({
      eventId: 'event-shared-db-unread',
      groupId: 65,
      timestamp: Date.now(),
    });
    expect(db.insertEvent(event, true)).toBe(true);

    expect(db.getChatSummaries(accountA)[0]?.unreadCount).toBe(1);
    expect(db.getChatSummaries(accountB)[0]?.unreadCount).toBe(1);

    db.markRead(65, event.timestamp, accountB);

    expect(db.getChatSummaries(accountB)[0]?.unreadCount).toBe(0);
    expect(db.getChatSummaries(accountA)[0]?.unreadCount).toBe(1);
  });

  it('tracks unread mention hints from event address hashes', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const mentionedAddress = deriveAddressFromPublicKey(
      base58Encode(nacl.sign.keyPair().publicKey)
    );
    const event = signedEvent({
      eventId: 'event-mention-hash-target',
      groupId: 66,
      authorAddress: 'Qauthor',
      mentionAddressHashes: [hashReticulumChatMentionAddress(mentionedAddress)],
    });
    db.insertEvent(event, true);

    expect(db.getChatSummaries(mentionedAddress)[0]).toMatchObject({
      groupId: 66,
      mentionCount: 1,
      hasUnreadMention: true,
    });

    db.markRead(66, event.timestamp, mentionedAddress);
    expect(db.getChatSummaries(mentionedAddress)[0]).toMatchObject({
      mentionCount: 0,
      hasUnreadMention: false,
    });
  });

  it('applies edit and delete state to event mention hash summaries', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const mentionedAddress = deriveAddressFromPublicKey(
      base58Encode(nacl.sign.keyPair().publicKey)
    );
    const mentionHash = hashReticulumChatMentionAddress(mentionedAddress);

    const original = signedEvent({
      eventId: 'event-mention-edit-original',
      groupId: 67,
      authorAddress: 'Qauthor',
      authorSeq: 1,
      timestamp: Date.now(),
      mentionAddressHashes: [],
    });
    const editAddsMention = signedEvent({
      eventId: 'event-mention-edit-adds',
      groupId: 67,
      authorAddress: 'Qauthor',
      authorSeq: 2,
      timestamp: original.timestamp + 1,
      eventType: 'edit',
      targetEventId: original.eventId,
      mentionAddressHashes: [mentionHash],
    });
    const editRemovesMention = signedEvent({
      eventId: 'event-mention-edit-removes',
      groupId: 67,
      authorAddress: 'Qauthor',
      authorSeq: 3,
      timestamp: original.timestamp + 2,
      eventType: 'edit',
      targetEventId: original.eventId,
      mentionAddressHashes: [],
    });
    db.insertEvent(original, true);
    db.insertEvent(editAddsMention, true);
    expect(
      db.getChatSummaries(mentionedAddress).find((summary) => summary.groupId === 67)
    ).toMatchObject({
      mentionCount: 1,
      hasUnreadMention: true,
    });
    db.insertEvent(editRemovesMention, true);
    expect(
      db.getChatSummaries(mentionedAddress).find((summary) => summary.groupId === 67)
    ).toMatchObject({
      mentionCount: 0,
      hasUnreadMention: false,
    });

    const deletedOriginal = signedEvent({
      eventId: 'event-mention-delete-original',
      groupId: 68,
      authorAddress: 'Qauthor',
      authorSeq: 1,
      timestamp: Date.now(),
      mentionAddressHashes: [mentionHash],
    });
    const deleteEvent = signedEvent({
      eventId: 'event-mention-delete',
      groupId: 68,
      authorAddress: 'Qauthor',
      authorSeq: 2,
      timestamp: deletedOriginal.timestamp + 1,
      eventType: 'delete',
      targetEventId: deletedOriginal.eventId,
      mentionAddressHashes: [],
    });
    db.insertEvent(deletedOriginal, true);
    expect(
      db.getChatSummaries(mentionedAddress).find((summary) => summary.groupId === 68)
    ).toMatchObject({
      groupId: 68,
      mentionCount: 1,
      hasUnreadMention: true,
    });
    db.insertEvent(deleteEvent, true);
    expect(
      db.getChatSummaries(mentionedAddress).find((summary) => summary.groupId === 68)
    ).toMatchObject({
      groupId: 68,
      mentionCount: 0,
      hasUnreadMention: false,
    });
  });

  it('replaces and deletes mentions for edited or deleted messages', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const event = signedEvent({
      eventId: 'event-mention-replace',
      groupId: 64,
      authorAddress: 'Qauthor',
    });
    db.insertEvent(event, true);

    db.replaceMentionsForEvent(event.eventId, ['Qfirst']);
    expect(db.getChatSummaries('Qfirst')[0]?.mentionCount).toBe(1);
    db.replaceMentionsForEvent(event.eventId, ['Qsecond']);
    expect(db.getChatSummaries('Qfirst')[0]?.mentionCount ?? 0).toBe(0);
    expect(db.getChatSummaries('Qsecond')[0]?.mentionCount).toBe(1);
    db.deleteMentionsForEvent(event.eventId);
    expect(db.getChatSummaries('Qsecond')[0]?.mentionCount ?? 0).toBe(0);
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

  it('returns author heads and author ranges for gap repair', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const [first, second] = signedAuthorEvents([
      { eventId: 'event-author-1', groupId: 57, authorSeq: 1, timestamp: 1_000 },
      { eventId: 'event-author-2', groupId: 57, authorSeq: 2, timestamp: 2_000 },
    ]);
    db.insertEvent(first, true);
    db.insertEvent(second, true);

    expect(db.getAuthorMaxSeq(57, first.authorAddress)).toBe(2);
    expect(db.getAuthorEventsAfter(57, first.authorAddress, 0, 10).map((event) => event.eventId)).toEqual([
      'event-author-1',
      'event-author-2',
    ]);
    expect(db.getAuthorHeads(57, 10)).toEqual([
      {
        authorAddress: first.authorAddress,
        maxSeq: 2,
        eventId: 'event-author-2',
        timestamp: 2_000,
      },
    ]);
  });

  it('paginates author heads', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const [firstAuthor] = signedAuthorEvents([
      { eventId: 'event-head-page-1', groupId: 61, authorSeq: 1, timestamp: 1_000 },
    ]);
    const [secondAuthor] = signedAuthorEvents([
      { eventId: 'event-head-page-2', groupId: 61, authorSeq: 1, timestamp: 2_000 },
    ]);
    db.insertEvent(firstAuthor, true);
    db.insertEvent(secondAuthor, true);

    expect(db.getAuthorHeads(61, 1, 0).map((head) => head.eventId)).toEqual([
      'event-head-page-2',
    ]);
    expect(db.getAuthorHeads(61, 1, 1).map((head) => head.eventId)).toEqual([
      'event-head-page-1',
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

  it('sends targeted hints only while peer subscriptions are fresh', async () => {
    let now = 100_000;
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => now,
    });
    manager.setLocalGroupMemberships([69]);
    manager.handleWire({ t: 'RCHAT', k: 'sub', g: 69 }, 'peer-a');

    await manager.publishEvent(signedEvent({
      eventId: 'event-targeted-subscription-fresh',
      groupId: 69,
      authorSeq: 1,
      timestamp: now,
    }));
    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          t: 'RCHAT',
          k: 'event_hint',
          g: 69,
        }),
      })
    );

    direct.length = 0;
    now += 2 * 60_000 + 1;
    await manager.publishEvent(signedEvent({
      eventId: 'event-targeted-subscription-expired',
      groupId: 69,
      authorSeq: 2,
      timestamp: now,
    }));
    expect(direct.find((item) => item.peer === 'peer-a' && item.wire.k === 'event_hint')).toBeUndefined();
    manager.close();
  });

  it('does not exclude peers from fallback fanout when targeted hints fail', async () => {
    let fallbackExcludes: string[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (
        _messages: Record<string, unknown>[],
        excludePeerPresenceHashes: string[] = []
      ) => {
        fallbackExcludes = excludePeerPresenceHashes;
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async () => ({
        ok: false as const,
        reason: 'no-route' as const,
        error: 'No overlay route',
      }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
      signLocalFields: createReticulumChatTestSigner(),
    });
    manager.setLocalGroupMemberships([70]);
    manager.handleWire({ t: 'RCHAT', k: 'sub', g: 70 }, 'peer-a');

    await manager.publishEvent(signedEvent({
      eventId: 'event-targeted-fallback-after-failure',
      groupId: 70,
      authorSeq: 1,
      timestamp: 100_000,
    }));

    expect(fallbackExcludes).toEqual([]);
    manager.close();
  });

  it('requests a missing hinted event once per throttle window', async () => {
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
      signLocalFields: createReticulumChatTestSigner(),
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(direct.filter((wire) => wire.k === 'event_req')).toHaveLength(1);
    expect(direct.find((wire) => wire.k === 'event_req')).toMatchObject({
      t: 'RCHAT',
      k: 'event_req',
      g: 9,
      r: expect.objectContaining({
        id: event.eventId,
        a: expect.any(String),
        pk: expect.any(String),
        sig: expect.any(String),
      }),
    });
    expect(byteLengthUtf8JsonWithBridgeSender(direct.find((wire) => wire.k === 'event_req')!)).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    manager.close();
  });

  it('rotates to another peer when an event resource transfer fails', async () => {
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
      acceptReticulumChatResourceDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
      signLocalFields: createReticulumChatTestSigner(),
    });
    const event = signedEvent({
      eventId: 'event-resource-rotate',
      groupId: 71,
      authorSeq: 1,
      timestamp: 100_000,
    });
    const hint = buildReticulumChatEventHint(event);
    const hintWire = {
      id: hint.eventId,
      a: hint.authorAddress,
      n: hint.authorSeq,
      ts: hint.timestamp,
      et: hint.eventType,
      ph: hint.payloadHash,
      mh: hint.mentionAddressHashes,
    };
    manager.setLocalGroupMemberships([71]);
    manager.subscribeGroup(71);
    manager.handleWire({ t: 'RCHAT', k: 'event_hint', g: 71, h: hintWire }, 'peer-a');
    manager.handleWire({ t: 'RCHAT', k: 'event_hint', g: 71, h: hintWire }, 'peer-b');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          k: 'event_req',
          r: expect.objectContaining({ id: event.eventId }),
        }),
      })
    );

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_offer',
        g: 71,
        o: {
          x: 'transfer-resource-rotate',
          id: event.eventId,
          ph: event.payloadHash,
          wh: 'a'.repeat(64),
          s: 10,
        },
      },
      'peer-a'
    );
    manager.handleResourceEvent({
      status: 'failed',
      transferId: 'transfer-resource-rotate',
      peerPresenceHash: 'peer-a',
      reason: 'link_failed',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-b',
        wire: expect.objectContaining({
          k: 'event_req',
          r: expect.objectContaining({ id: event.eventId }),
        }),
      })
    );
    manager.close();
  });

  it('rotates to another peer when accepting an event resource fails', async () => {
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
      acceptReticulumChatResourceDetailed: async () => ({
        ok: false as const,
        reason: 'no-route' as const,
        error: 'No resource link',
      }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
      signLocalFields: createReticulumChatTestSigner(),
    });
    const event = signedEvent({
      eventId: 'event-resource-accept-rotate',
      groupId: 72,
      authorSeq: 1,
      timestamp: 100_000,
    });
    const hint = buildReticulumChatEventHint(event);
    const hintWire = {
      id: hint.eventId,
      a: hint.authorAddress,
      n: hint.authorSeq,
      ts: hint.timestamp,
      et: hint.eventType,
      ph: hint.payloadHash,
      mh: hint.mentionAddressHashes,
    };
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);
    manager.handleWire({ t: 'RCHAT', k: 'event_hint', g: 72, h: hintWire }, 'peer-a');
    manager.handleWire({ t: 'RCHAT', k: 'event_hint', g: 72, h: hintWire }, 'peer-b');
    await new Promise((resolve) => setTimeout(resolve, 0));

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_offer',
        g: 72,
        o: {
          x: 'transfer-resource-accept-rotate',
          id: event.eventId,
          ph: event.payloadHash,
          wh: 'b'.repeat(64),
          s: 10,
        },
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-b',
        wire: expect.objectContaining({
          k: 'event_req',
          r: expect.objectContaining({ id: event.eventId }),
        }),
      })
    );
    manager.close();
  });

  it('requests an author gap when a live hint skips an author sequence', async () => {
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
      signLocalFields: createReticulumChatTestSigner(),
    });
    manager.setLocalGroupMemberships([58]);
    manager.subscribeGroup(58);
    const [_missed, received] = signedAuthorEvents([
      { eventId: 'event-live-gap-1', groupId: 58, authorSeq: 1 },
      { eventId: 'event-live-gap-2', groupId: 58, authorSeq: 2 },
    ]);
    const hint = buildReticulumChatEventHint(received);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_hint',
        g: 58,
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct).toContainEqual(
      expect.objectContaining({
        t: 'RCHAT',
        k: 'author_gap_req',
        g: 58,
        a: received.authorAddress,
        after: 0,
      })
    );
    manager.close();
  });

  it('uses author heads to request missing author ranges', async () => {
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
      signLocalFields: createReticulumChatTestSigner(),
    });
    manager.setLocalGroupMemberships([59]);
    manager.subscribeGroup(59);
    const [remoteHead] = signedAuthorEvents([
      { eventId: 'event-head-remote-3', groupId: 59, authorSeq: 3, timestamp: 50_000 },
    ]);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'author_heads',
        g: 59,
        heads: [
          {
            a: remoteHead.authorAddress,
            n: 3,
            id: remoteHead.eventId,
            ts: remoteHead.timestamp,
          },
        ],
      },
      'peer'
    );

    expect(direct).toContainEqual(
      expect.objectContaining({
        t: 'RCHAT',
        k: 'author_gap_req',
        g: 59,
        a: remoteHead.authorAddress,
        after: 0,
      })
    );
    manager.close();
  });

  it('continues paged author head exchange', async () => {
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
      signLocalFields: createReticulumChatTestSigner(),
    });
    manager.setLocalGroupMemberships([62]);
    manager.subscribeGroup(62);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'author_heads',
        g: 62,
        heads: [],
        more: true,
        nextOffset: 100,
      },
      'peer'
    );

    expect(direct).toContainEqual(
      expect.objectContaining({
        t: 'RCHAT',
        k: 'author_heads_req',
        g: 62,
        offset: 100,
      })
    );
    manager.close();
  });

  it('paces event pull requests instead of bursting all history hints at once', async () => {
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
      signLocalFields: createReticulumChatTestSigner(),
    });
    manager.setLocalGroupMemberships([55]);
    manager.subscribeGroup(55);

    for (const seq of [1, 2, 3, 4, 5]) {
      const event = signedEvent({
        eventId: `event-pull-queue-${seq}`,
        groupId: 55,
        authorSeq: seq,
      });
      const hint = buildReticulumChatEventHint(event);
      manager.handleWire(
        {
          t: 'RCHAT',
          k: 'event_hint',
          g: 55,
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
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(direct.filter((wire) => wire.k === 'event_req')).toHaveLength(3);
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
    manager.setLocalGroupMemberships([48]);
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

  it('subscribes with a before cursor when local history may be partial', async () => {
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
      now: () => 80_000,
    });
    manager.setLocalGroupMemberships([56]);
    const firstLocal = signedEvent({
      eventId: 'event-partial-local-1',
      groupId: 56,
      authorSeq: 1,
      timestamp: 50_000,
    });
    const secondLocal = signedEvent({
      eventId: 'event-partial-local-2',
      groupId: 56,
      authorSeq: 2,
      timestamp: 60_000,
    });
    await manager.publishEvent(firstLocal);
    await manager.publishEvent(secondLocal);
    sent.length = 0;

    manager.subscribeGroup(56);

    expect(sent.filter((wire) => wire.k === 'sync_req')).toEqual([
      expect.objectContaining({
        t: 'RCHAT',
        k: 'sync_req',
        g: 56,
        mode: 'after',
        ts: 55_000,
      }),
      expect.objectContaining({
        t: 'RCHAT',
        k: 'sync_req',
        g: 56,
        mode: 'before',
        ts: 50_000,
        id: firstLocal.eventId,
      }),
    ]);
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

  it('responds to author gap requests with compact hints for that author', async () => {
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
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([60]);
    const [first, second] = signedAuthorEvents([
      { eventId: 'event-gap-response-1', groupId: 60, authorSeq: 1, timestamp: 40_000 },
      { eventId: 'event-gap-response-2', groupId: 60, authorSeq: 2, timestamp: 41_000 },
    ]);
    await manager.publishEvent(first);
    await manager.publishEvent(second);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'author_gap_req',
        g: 60,
        a: first.authorAddress,
        after: 0,
        limit: 10,
      },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const returnedHints = direct
      .filter((wire) => wire.k === 'sync_hints' && Array.isArray(wire.hints))
      .flatMap((wire) => wire.hints as Array<Record<string, unknown>>);
    expect(returnedHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.eventId, n: 1 }),
        expect.objectContaining({ id: second.eventId, n: 2 }),
      ])
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

  it('serves cached group history for groups the local user belongs to even when not currently open', async () => {
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

  it('does not publish, subscribe, type, or serve cached history for groups the local user is not a member of', async () => {
    const sent: Record<string, unknown>[] = [];
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        sent.push(...messages);
        return { ok: true as const };
      },
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
    manager.setLocalGroupMemberships([57]);
    const event = signedEvent({
      eventId: 'event-non-member-cached',
      groupId: 57,
      timestamp: 50_000,
    });
    await expect(manager.publishEvent(event)).resolves.toMatchObject({ ok: true });

    manager.setLocalGroupMemberships([]);
    sent.length = 0;
    direct.length = 0;

    await expect(
      manager.publishEvent(signedEvent({ eventId: 'event-non-member-publish', groupId: 57 }))
    ).resolves.toMatchObject({ ok: false });
    expect(() => manager.subscribeGroup(57)).toThrow(/not a member/i);
    expect(() => manager.sendTyping(57, 'Qsender', true)).toThrow(/not a member/i);

    manager.handleWire(
      { t: 'RCHAT', k: 'sync_req', g: 57, mode: 'latest', limit: 10 },
      'peer'
    );
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_req',
        g: 57,
        r: signedEventRequestWire({
          groupId: 57,
          eventId: event.eventId,
          timestamp: 60_000,
        }),
      },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toEqual([]);
    expect(direct).toEqual([]);
    manager.close();
  });

  it('refuses to publish when Core membership validation rejects the author', async () => {
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
      validateGroupMember: async () => false,
    });
    manager.setLocalGroupMemberships([73]);
    const event = signedEvent({ eventId: 'event-core-non-member-author', groupId: 73 });

    await expect(manager.publishEvent(event)).resolves.toMatchObject({
      ok: false,
    });
    expect(manager.getHistory(73, 10)).toEqual([]);
    expect(sent).toEqual([]);
    manager.close();
  });

  it('refuses signed event resource requests when Core membership validation rejects the requester', async () => {
    const sentResources: unknown[] = [];
    const signer = createReticulumChatTestSigner();
    const blockedKp = nacl.sign.keyPair();
    const blockedPublicKey = base58Encode(blockedKp.publicKey);
    const blockedAddress = deriveAddressFromPublicKey(blockedPublicKey);
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatResourceDetailed: async (payload: unknown) => {
        sentResources.push(payload);
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
      signLocalFields: signer,
      validateGroupMember: async (_groupId, address) => address !== blockedAddress,
    });
    manager.setLocalGroupMemberships([74]);
    const event = signedEvent({
      eventId: 'event-resource-core-gated',
      groupId: 74,
      timestamp: 100_000,
    });
    await expect(manager.publishEvent(event)).resolves.toMatchObject({ ok: true });

    const timestamp = 100_000;
    const fields = buildReticulumChatEventRequestSignedFields({
      groupId: 74,
      eventId: event.eventId,
      authorAddress: blockedAddress,
      authorPublicKey: blockedPublicKey,
      timestamp,
    });
    const signature = base58Encode(
      nacl.sign.detached(
        new Uint8Array(canonicalizeForSigning(fields)),
        blockedKp.secretKey
      )
    );

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_req',
        g: 74,
        r: {
          id: event.eventId,
          a: blockedAddress,
          pk: blockedPublicKey,
          ts: timestamp,
          sig: signature,
        },
      },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentResources).toEqual([]);
    manager.close();
  });

  it('refuses downloaded event resources when Core membership validation rejects the event author', async () => {
    const acceptedTransfers: unknown[] = [];
    const blockedKp = nacl.sign.keyPair();
    const blockedPublicKey = base58Encode(blockedKp.publicKey);
    const blockedAddress = deriveAddressFromPublicKey(blockedPublicKey);
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      acceptReticulumChatResourceDetailed: async (payload: unknown) => {
        acceptedTransfers.push(payload);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
      validateGroupMember: async (_groupId, address) => address !== blockedAddress,
    });
    manager.setLocalGroupMemberships([75]);
    manager.subscribeGroup(75);

    const event = signedEvent({
      eventId: 'event-inbound-non-member-author',
      groupId: 75,
      authorAddress: blockedAddress,
      authorPublicKey: blockedPublicKey,
      timestamp: 100_000,
    });
    const eventForSignature = { ...event, signature: '' };
    event.signature = base58Encode(
      nacl.sign.detached(
        new Uint8Array(canonicalizeForSigning(buildReticulumChatSignedFields(eventForSignature))),
        blockedKp.secretKey
      )
    );
    const blob = serializeReticulumChatEvent(event);
    const wireHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
    const resourcePath = path.join(path.dirname(tempDbPath()), 'event-resource.json');
    fs.writeFileSync(resourcePath, blob, 'utf8');

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_offer',
        g: 75,
        o: {
          x: 'transfer-inbound-non-member-author',
          id: event.eventId,
          ph: event.payloadHash,
          wh: wireHash,
          s: Buffer.byteLength(blob, 'utf8'),
        },
      },
      'peer'
    );
    expect(acceptedTransfers).toHaveLength(1);

    manager.handleResourceEvent({
      status: 'received',
      transferId: 'transfer-inbound-non-member-author',
      peerPresenceHash: 'peer',
      path: resourcePath,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.getHistory(75, 10)).toEqual([]);
    manager.close();
  });

  it('refuses to serve cached event resources when Core membership validation rejects the event author', async () => {
    const sentResources: unknown[] = [];
    const blockedKp = nacl.sign.keyPair();
    const blockedPublicKey = base58Encode(blockedKp.publicKey);
    const blockedAddress = deriveAddressFromPublicKey(blockedPublicKey);
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatResourceDetailed: async (payload: unknown) => {
        sentResources.push(payload);
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([76]);

    const event = signedEvent({
      eventId: 'event-cached-non-member-author',
      groupId: 76,
      authorAddress: blockedAddress,
      authorPublicKey: blockedPublicKey,
      timestamp: 100_000,
    });
    const eventForSignature = { ...event, signature: '' };
    event.signature = base58Encode(
      nacl.sign.detached(
        new Uint8Array(canonicalizeForSigning(buildReticulumChatSignedFields(eventForSignature))),
        blockedKp.secretKey
      )
    );
    await expect(manager.publishEvent(event)).resolves.toMatchObject({ ok: true });
    sentResources.length = 0;
    manager.setRuntimeCallbacks({
      validateGroupMember: async (_groupId, address) => address !== blockedAddress,
    });

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_req',
        g: 76,
        r: signedEventRequestWire({
          groupId: 76,
          eventId: event.eventId,
          timestamp: 100_000,
        }),
      },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentResources).toEqual([]);
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
