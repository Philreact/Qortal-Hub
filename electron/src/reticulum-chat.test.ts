import { describe, expect, it, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as nodeCrypto from 'crypto';
import nacl from 'tweetnacl';
import {
  buildReticulumChatSignedFields,
  buildReticulumChatEventRequestSignedFields,
  buildReticulumChatResourceRequestSignedFields,
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
import { ReticulumResourceStore, RETICULUM_RESOURCE_MIN_CHUNK_SIZE } from './reticulum-resource-store';
import {
  RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT,
  RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS,
} from './reticulum-resource-transfer';

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
    let signedFields = fullFields;
    if (
      fullFields.type === 'RCHAT_EVENT_REQ' &&
      typeof fullFields.groupId === 'number' &&
      typeof fullFields.eventId === 'string' &&
      typeof fullFields.timestamp === 'number'
    ) {
      signedFields = buildReticulumChatEventRequestSignedFields({
        groupId: fullFields.groupId,
        eventId: fullFields.eventId,
        authorAddress,
        authorPublicKey,
        timestamp: fullFields.timestamp,
      });
    } else if (
      fullFields.type === 'RCHAT_RESOURCE_REQ' &&
      typeof fullFields.groupId === 'number' &&
      typeof fullFields.fileHash === 'string' &&
      typeof fullFields.timestamp === 'number'
    ) {
      signedFields = buildReticulumChatResourceRequestSignedFields({
        groupId: fullFields.groupId,
        eventId: typeof fullFields.eventId === 'string' ? fullFields.eventId : undefined,
        fileHash: fullFields.fileHash,
        chunkRanges: Array.isArray(fullFields.chunkRanges)
          ? (fullFields.chunkRanges.filter(
              (range): range is [number, number] =>
                Array.isArray(range) &&
                range.length === 2 &&
                Number.isInteger(range[0]) &&
                Number.isInteger(range[1])
            ) as Array<[number, number]>)
          : undefined,
        authorAddress,
        authorPublicKey,
        timestamp: fullFields.timestamp,
      });
    }
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

function signedResourceRequestWire(params: {
  groupId: number;
  fileHash: string;
  chunkIndexes: number[];
  timestamp: number;
}): {
  fh: string;
  r: Array<[number, number]>;
  pk: string;
  ts: number;
  sig: string;
} {
  const kp = nacl.sign.keyPair();
  const authorPublicKey = base58Encode(kp.publicKey);
  const authorAddress = deriveAddressFromPublicKey(authorPublicKey);
  const ranges: Array<[number, number]> = [];
  for (const index of [...params.chunkIndexes].sort((a, b) => a - b)) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous[0] + previous[1] === index) previous[1] += 1;
    else ranges.push([index, 1]);
  }
  const fields = buildReticulumChatResourceRequestSignedFields({
    groupId: params.groupId,
    fileHash: params.fileHash,
    chunkRanges: ranges,
    authorAddress,
    authorPublicKey,
    timestamp: params.timestamp,
  });
  return {
    fh: params.fileHash,
    r: ranges,
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
      q: expect.objectContaining({
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
          q: expect.objectContaining({ id: event.eventId }),
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
          q: expect.objectContaining({ id: event.eventId }),
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
          q: expect.objectContaining({ id: event.eventId }),
        }),
      })
    );
    manager.close();
  });

  it('serves only one requested resource chunk at a time', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-partial-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const chunk0 = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 1);
    const chunk1 = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 2);
    const chunk2 = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 3);
    const chunkHashes = [chunk0, chunk1, chunk2].map((chunk) =>
      nodeCrypto.createHash('sha256').update(chunk).digest('hex')
    );
    const fileHash = nodeCrypto
      .createHash('sha256')
      .update(Buffer.concat([chunk0, chunk1, chunk2]))
      .digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '77:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: chunk0.length + chunk1.length + chunk2.length,
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 77 },
    };
    resourceStore.storeManifest(manifest);
    resourceStore.storeChunk(manifest.fileHash, 0, chunk0);
    resourceStore.storeChunk(manifest.fileHash, 2, chunk2);

    const offeredResources: Array<Record<string, unknown>> = [];
    const offerWires: Array<Record<string, unknown>> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        offeredResources.push(payload);
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async (_peer: string, wire: Record<string, unknown>) => {
        offerWires.push(wire);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([77]);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_req',
        g: 77,
        q: signedResourceRequestWire({
          groupId: 77,
          fileHash,
          chunkIndexes: [0],
          timestamp: 100_000,
        }),
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(offeredResources.map((payload) => payload.metadata)).toEqual([
      expect.objectContaining({
        chunkIndex: 0,
        chunkHash: chunkHashes[0],
        chunkSize: chunk0.length,
      }),
    ]);
    expect(offerWires.map((wire) => (wire.o as any).ci)).toEqual([0]);
    expect(offerWires.map((wire) => (wire.o as any).ch)).toEqual([chunkHashes[0]]);
    expect(offerWires.every((wire) => wire.k === 'resource_offer')).toBe(true);
    manager.close();
    resourceStore.close();
  });

  it('serves a complete resource as requested chunk offers, not one full resource transfer', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-full-offer-'));
    const sourcePath = path.join(tempRoot, 'source.bin');
    const sourceBytes = Buffer.concat([
      Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 11),
      Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 12),
      Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 13),
    ]);
    fs.writeFileSync(sourcePath, sourceBytes);
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const manifest = resourceStore.importLocalFile({
      sourcePath,
      namespace: 'reticulum-chat-file',
      ownerId: '81:sender',
      fileName: 'source.bin',
      mimeType: 'application/octet-stream',
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      encrypted: false,
      metadata: { groupId: 81 },
    });

    const offeredResources: Array<Record<string, unknown>> = [];
    const offerWires: Array<Record<string, unknown>> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        offeredResources.push(payload);
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async (_peer: string, wire: Record<string, unknown>) => {
        offerWires.push(wire);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([81]);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_req',
        g: 81,
        q: signedResourceRequestWire({
          groupId: 81,
          fileHash: manifest.fileHash,
          chunkIndexes: [0],
          timestamp: 100_000,
        }),
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(offeredResources).toHaveLength(1);
    expect(offeredResources.map((payload) => payload.resourceType)).toEqual([
      'reticulum_group_resource_chunk',
    ]);
    expect(offeredResources.map((payload) => (payload.metadata as any).chunkIndex)).toEqual([
      0,
    ]);
    expect(offeredResources.map((payload) => (payload.metadata as any).chunkHash)).toEqual(
      [manifest.chunkHashes[0]]
    );
    expect(offeredResources.map((payload) => payload.size)).toEqual([
      RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
    ]);
    expect(offerWires).toHaveLength(1);
    expect(offerWires.map((wire) => (wire.o as any).ci)).toEqual([0]);
    expect(offerWires.map((wire) => (wire.o as any).ch)).toEqual([manifest.chunkHashes[0]]);
    expect(offerWires.map((wire) => (wire.o as any).s)).toEqual([
      RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
    ]);
    manager.close();
    resourceStore.close();
  });

  it('serves multiple requested resource chunks as one verified bundle offer', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-bundle-offer-'));
    const sourcePath = path.join(tempRoot, 'source.bin');
    const chunks = Array.from(
      { length: RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT },
      (_, index) => Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 21 + index)
    );
    fs.writeFileSync(sourcePath, Buffer.concat(chunks));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const manifest = resourceStore.importLocalFile({
      sourcePath,
      namespace: 'reticulum-chat-file',
      ownerId: '82:sender',
      fileName: 'source.bin',
      mimeType: 'application/octet-stream',
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      encrypted: false,
      metadata: { groupId: 82 },
    });

    const offeredResources: Array<Record<string, unknown>> = [];
    const offerWires: Array<Record<string, unknown>> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        offeredResources.push(payload);
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async (_peer: string, wire: Record<string, unknown>) => {
        offerWires.push(wire);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([82]);

    const requestWire = signedResourceRequestWire({
      groupId: 82,
      fileHash: manifest.fileHash,
      chunkIndexes: chunks.map((_, index) => index),
      timestamp: 100_000,
    });
    expect(requestWire.r).toEqual([[0, RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT]]);
    expect(
      byteLengthUtf8JsonWithBridgeSender({
        t: 'RCHAT',
        k: 'resource_req',
        g: 82,
        q: requestWire,
      })
    ).toBeLessThanOrEqual(RT_RETICULUM_MAX_WIRE_JSON_BYTES);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_req',
        g: 82,
        q: requestWire,
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(offeredResources).toHaveLength(1);
    expect(offeredResources[0]?.resourceType).toBe('reticulum_group_resource_chunk');
    expect((offeredResources[0]?.metadata as any).chunkBundle).toBe(true);
    expect((offeredResources[0]?.metadata as any).chunks).toBeUndefined();
    expect((offeredResources[0]?.metadata as any).chunkRanges).toEqual([
      [0, RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT],
    ]);
    expect(offeredResources[0]?.size).toBe(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    expect(offerWires).toHaveLength(1);
    expect((offerWires[0]?.o as any).ci).toBeUndefined();
    expect((offerWires[0]?.o as any).br).toEqual([[0, RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT]]);
    expect(byteLengthUtf8JsonWithBridgeSender(offerWires[0])).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    manager.close();
    resourceStore.close();
  });

  it('requests resources after Core validates the local signer even when local membership cache is stale', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-stale-local-membership-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const chunk = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 4);
    const chunkHash = nodeCrypto.createHash('sha256').update(chunk).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '78:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: chunk.length,
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes: [chunkHash],
      fileHash: chunkHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 78 },
    };
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
      resourceStore,
      now: () => 100_000,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
    });

    await expect(manager.requestResource(78, manifest)).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sent).toContainEqual(
      expect.objectContaining({
        t: 'RCHAT',
        k: 'resource_req',
        g: 78,
      })
    );
    const requestWire = sent.find((wire) => wire.k === 'resource_req') as any;
    expect(requestWire.q.rid).toBeUndefined();
    expect(requestWire.q.fh).toBe(manifest.fileHash);
    expect(byteLengthUtf8JsonWithBridgeSender(requestWire)).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    manager.close();
    resourceStore.close();
  });

  it('does not accept duplicate chunk offers while chunks are in flight', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-in-flight-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const chunk0 = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 5);
    const chunk1 = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 6);
    const chunkHashes = [chunk0, chunk1].map((chunk) =>
      nodeCrypto.createHash('sha256').update(chunk).digest('hex')
    );
    const fileHash = nodeCrypto
      .createHash('sha256')
      .update(Buffer.concat([chunk0, chunk1]))
      .digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '79:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: chunk0.length + chunk1.length,
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 79 },
    };
    let accepts = 0;
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      acceptReticulumResourceDetailed: async () => {
        accepts += 1;
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => 100_000,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([79]);
    manager.subscribeGroup(79);

    await expect(manager.requestResource(79, manifest)).resolves.toMatchObject({ ok: true });
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_offer',
        g: 79,
        o: {
          x: 'transfer-chunk-a',
          fh: fileHash,
          s: chunk0.length,
          ci: 0,
          ch: chunkHashes[0],
          cs: chunk0.length,
        },
      },
      'peer-a'
    );
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_offer',
        g: 79,
        o: {
          x: 'transfer-chunk-b',
          fh: fileHash,
          s: chunk0.length,
          ci: 0,
          ch: chunkHashes[0],
          cs: chunk0.length,
        },
      },
      'peer-b'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepts).toBe(1);
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      inFlightChunkCount: 1,
    });
    manager.close();
    resourceStore.close();
  });

  it('emits live progress while a chunk bundle transfer is still receiving', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-live-progress-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const chunks = [1, 2, 3, 4].map((value) =>
      Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, value)
    );
    const chunkHashes = chunks.map((chunk) =>
      nodeCrypto.createHash('sha256').update(chunk).digest('hex')
    );
    const fileHash = nodeCrypto
      .createHash('sha256')
      .update(Buffer.concat(chunks))
      .digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-file',
      ownerId: '83:receiver',
      fileName: 'bundle.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 83 },
    };
    const bridge = new EventEmitter() as EventEmitter & Record<string, unknown>;
    bridge.fanoutReticulumChatDetailed = async () => ({ ok: true as const });
    bridge.acceptReticulumResourceDetailed = async () => ({ ok: true as const });
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => 100_000,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
    });
    const progressEvents: Array<Record<string, unknown>> = [];
    manager.on('resource', (payload) => progressEvents.push(payload as Record<string, unknown>));
    manager.setLocalGroupMemberships([83]);
    manager.subscribeGroup(83);

    await expect(manager.requestResource(83, manifest)).resolves.toMatchObject({ ok: true });
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_offer',
        g: 83,
        o: {
          x: 'transfer-bundle-progress',
          fh: fileHash,
          s: manifest.sizeBytes,
          bh: nodeCrypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
          br: [[0, chunks.length]],
        },
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    bridge.emit('reticulum-resource', {
      status: 'receiving',
      transferId: 'transfer-bundle-progress',
      progress: 0.5,
    });

    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        fileHash,
        progress: 0.5,
        completedChunks: 2,
        totalChunks: chunks.length,
      })
    );
    manager.close();
    resourceStore.close();
  });

  it('keeps only one active or queued resource transfer per peer and releases stale active transfers', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-one-peer-link-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const chunks = [7, 8, 9, 10].map((value) =>
      Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, value)
    );
    const chunkHashes = chunks.map((chunk) =>
      nodeCrypto.createHash('sha256').update(chunk).digest('hex')
    );
    const fileHash = nodeCrypto
      .createHash('sha256')
      .update(Buffer.concat(chunks))
      .digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '80:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 80 },
    };
    let now = 100_000;
    let accepts = 0;
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      acceptReticulumResourceDetailed: async () => {
        accepts += 1;
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => now,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([80]);
    manager.subscribeGroup(80);

    await expect(manager.requestResource(80, manifest)).resolves.toMatchObject({ ok: true });
    for (const [index, chunk] of chunks.entries()) {
      manager.handleWire(
        {
          t: 'RCHAT',
          k: 'resource_offer',
          g: 80,
          o: {
            x: `transfer-peer-a-${index}`,
            fh: fileHash,
            s: chunk.length,
            ci: index,
            ch: chunkHashes[index],
            cs: chunk.length,
          },
        },
        'peer-a'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepts).toBe(1);
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      activeTransfers: 1,
      pendingTransfers: 0,
      inFlightChunkCount: 1,
    });

    now += RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS + 1;
    manager.getResourceDownloadStatus(fileHash);
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_offer',
        g: 80,
        o: {
          x: 'transfer-peer-a-after-stale',
          fh: fileHash,
          s: chunks[1].length,
          ci: 1,
          ch: chunkHashes[1],
          cs: chunks[1].length,
        },
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepts).toBe(2);
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      activeTransfers: 1,
      pendingTransfers: 0,
    });
    manager.close();
    resourceStore.close();
  });

  it('allows one active transfer per peer per resource so an image is not blocked by a large file', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-peer-resource-link-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const largeChunk = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 14);
    const imageChunk = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 15);
    const largeHash = nodeCrypto.createHash('sha256').update(largeChunk).digest('hex');
    const imageHash = nodeCrypto.createHash('sha256').update(imageChunk).digest('hex');
    const largeManifest = {
      namespace: 'reticulum-chat-file',
      ownerId: '82:sender',
      fileName: 'large.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: largeChunk.length,
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes: [largeHash],
      fileHash: largeHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 82 },
    };
    const imageManifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '82:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: imageChunk.length,
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes: [imageHash],
      fileHash: imageHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 82 },
    };
    let accepts = 0;
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      acceptReticulumResourceDetailed: async () => {
        accepts += 1;
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => 100_000,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([82]);
    manager.subscribeGroup(82);

    await expect(manager.requestResource(82, largeManifest)).resolves.toMatchObject({ ok: true });
    await expect(manager.requestResource(82, imageManifest)).resolves.toMatchObject({ ok: true });
    for (const offer of [
      { x: 'large-transfer', fh: largeHash, s: largeChunk.length, ci: 0, ch: largeHash, cs: largeChunk.length },
      { x: 'image-transfer', fh: imageHash, s: imageChunk.length, ci: 0, ch: imageHash, cs: imageChunk.length },
    ]) {
      manager.handleWire(
        {
          t: 'RCHAT',
          k: 'resource_offer',
          g: 82,
          o: offer,
        },
        'peer-a'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepts).toBe(2);
    expect(manager.getResourceDownloadStatus(largeHash)).toMatchObject({
      activeTransfers: 1,
      pendingTransfers: 0,
      inFlightChunkCount: 1,
    });
    expect(manager.getResourceDownloadStatus(imageHash)).toMatchObject({
      activeTransfers: 1,
      pendingTransfers: 0,
      inFlightChunkCount: 1,
    });
    manager.close();
    resourceStore.close();
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

  it('does not publish, type, or serve cached history before local membership is known', async () => {
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
        q: signedEventRequestWire({
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
    expect(() => manager.subscribeGroup(57)).not.toThrow();
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

  it('publishes when Core validates the author even if the local membership cache is not populated yet', async () => {
    const sent: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        sent.push(...messages);
        return { ok: true as const };
      },
    };
    const event = signedEvent({
      eventId: 'event-core-member-author-with-empty-local-cache',
      groupId: 77,
    });
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      validateGroupMember: async (_groupId, address) => address === event.authorAddress,
    });

    await expect(manager.publishEvent(event)).resolves.toMatchObject({
      ok: true,
    });
    expect(manager.getHistory(77, 10)).toContainEqual(
      expect.objectContaining({ eventId: event.eventId })
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        t: 'RCHAT',
        k: 'event_hint',
        g: 77,
      })
    );
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
        q: {
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
        q: signedEventRequestWire({
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
