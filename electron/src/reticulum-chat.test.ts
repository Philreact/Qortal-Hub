import { describe, expect, it, afterEach, vi } from 'vitest';
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
  ReticulumResourceTransferManager,
  RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER,
  RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT,
  RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS,
  RETICULUM_RESOURCE_TRANSFER_OVERLAY_THROTTLE_RETRY_MS,
} from './reticulum-resource-transfer';

function signedEvent(overrides: Partial<ReticulumChatEvent> = {}): ReticulumChatEvent {
  const kp = nacl.sign.keyPair();
  const publicKey = base58Encode(kp.publicKey);
  const encryptedPayload = overrides.encryptedPayload ?? 'ciphertext';
  const event: ReticulumChatEvent = {
    eventId: overrides.eventId ?? `event-${Math.random().toString(16).slice(2)}`,
    groupId: overrides.groupId ?? 7,
    channelId: overrides.channelId ?? 'general',
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
      channelId: overrides.channelId ?? 'general',
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

  it('returns known group ids from persisted and memory events', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    db.insertEvent(signedEvent({ eventId: 'known-group-persisted', groupId: 62 }), true);
    (db as any).memoryEvents.set(
      'known-group-memory',
      signedEvent({ eventId: 'known-group-memory', groupId: 63 })
    );

    expect(db.getKnownGroupIds()).toEqual([62, 63]);
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

  it('publishes durable events as bounded digest when no peers are subscribed', async () => {
    const sent: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => 'a'.repeat(32),
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
      k: 'group_digest',
      g: 9,
      latest: {
        id: event.eventId,
      },
    });
    expect(JSON.stringify(sent[0])).not.toContain('encryptedPayload');
    expect(byteLengthUtf8JsonWithBridgeSender(sent[0])).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    manager.close();
  });

  it('publishes oversized live events as event resource offers and digest discovery', async () => {
    const fanout: Record<string, unknown>[] = [];
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const resources: unknown[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        fanout.push(...messages);
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async (payload: unknown) => {
        resources.push(payload);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([9]);
    manager.handleWire(
      { t: 'RCHAT', k: 'group_sub', groups: [9], mode: 'active' },
      'peer-a'
    );

    const event = signedEvent({ groupId: 9, timestamp: 100_000 });
    const result = await manager.publishEvent(event);

    expect(result.ok).toBe(true);
    expect(resources).toHaveLength(1);
    expect(fanout.find((wire) => wire.k === 'event_batch')).toBeUndefined();
    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          t: 'RCHAT',
          k: 'event_offer',
          g: 9,
          o: expect.objectContaining({ id: event.eventId }),
        }),
      })
    );
    expect(fanout.find((wire) => wire.k === 'group_digest')).toMatchObject({
      t: 'RCHAT',
      k: 'group_digest',
      g: 9,
      latest: {
        id: event.eventId,
      },
    });
    expect(direct.some(({ wire }) => JSON.stringify(wire).includes('encryptedPayload'))).toBe(false);
    manager.close();
  });

  it('keeps mentioned message digest fanout under the Reticulum wire limit', async () => {
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
    const mentionHash = hashReticulumChatMentionAddress('QmentionedAddress');
    const channelId = 'ch-00000000-0000-4000-8000-000000000000';
    const event = signedEvent({
      groupId: 91,
      channelId,
      mentionAddressHashes: [mentionHash],
    });
    manager.setLocalGroupMemberships([91]);
    (manager as any).db.upsertChannel({
      groupId: 91,
      channelId,
      name: 'mentions',
      position: 1,
      archived: false,
      createdBy: event.authorAddress,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    });
    expect((manager as any).db.getChannel(91, channelId)?.channelId).toBe(channelId);

    await expect(manager.publishEvent(event)).resolves.toMatchObject({ ok: true });

    expect(manager.getHistory(91, event.channelId, 10)[0]).toMatchObject({
      eventId: event.eventId,
      mentionAddressHashes: [mentionHash],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      t: 'RCHAT',
      k: 'group_digest',
      g: 91,
      latest: expect.objectContaining({
        id: event.eventId,
      }),
    });
    expect(JSON.stringify(sent[0])).not.toContain(mentionHash);
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

  it('records peer group subscriptions from group_sub and serves a digest', async () => {
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
    manager.subscribeGroup(69);
    direct.length = 0;
    manager.handleWire({ t: 'RCHAT', k: 'group_sub', groups: [69], mode: 'summary' }, 'peer-a');

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          t: 'RCHAT',
          k: 'group_digest',
          g: 69,
        }),
      })
    );

    direct.length = 0;
    now += 2 * 60_000 + 1;
    manager.handleWire({ t: 'RCHAT', k: 'group_sub', groups: [69], mode: 'summary' }, 'peer-a');
    expect(direct.find((item) => item.peer === 'peer-a' && item.wire.k === 'group_digest')).toBeDefined();
    manager.close();
  });

  it('relays group subscriptions through non-member overlay peers', async () => {
    const fanout: Array<{ messages: Record<string, unknown>[]; excludes: string[] }> = [];
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        fanoutReticulumChatDetailed: async (
          messages: Record<string, unknown>[],
          excludes: string[] = []
        ) => {
          fanout.push({ messages, excludes });
          return { ok: true as const };
        },
      } as any,
      now: () => 100_000,
    });

    manager.handleWire({ t: 'RCHAT', k: 'group_sub', groups: [72], mode: 'summary' }, 'peer-a');
    await Promise.resolve();

    expect(fanout).toContainEqual(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            t: 'RCHAT',
            k: 'group_sub',
            groups: [72],
            mode: 'summary',
            o: 'peer-a',
            h: 1,
          }),
        ],
        excludes: expect.arrayContaining(['peer-a']),
      })
    );
    manager.close();
  });

  it('relays group digests back along subscribed interest routes', async () => {
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
        sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
          direct.push({ peer, wire });
          return { ok: true as const };
        },
      } as any,
      now: () => 100_000,
    });

    manager.handleWire({ t: 'RCHAT', k: 'group_sub', groups: [73], mode: 'summary' }, 'peer-a');
    direct.length = 0;
    manager.handleWire(
      { t: 'RCHAT', k: 'group_digest', g: 73, latest: { id: 'event-latest-73', ts: 1000 }, channels: [] },
      'peer-c'
    );
    await Promise.resolve();

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          t: 'RCHAT',
          k: 'group_digest',
          g: 73,
        }),
      })
    );
    manager.close();
  });

  it('relays event requests and routes event offers back to the origin', async () => {
    const fanout: Array<Record<string, unknown>> = [];
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
          fanout.push(...messages);
          return { ok: true as const };
        },
        sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
          direct.push({ peer, wire });
          return { ok: true as const };
        },
      } as any,
      now: () => 100_000,
    });
    const request = signedEventRequestWire({
      groupId: 74,
      eventId: 'event-relay-74',
      timestamp: 100_000,
    });

    manager.handleWire({ t: 'RCHAT', k: 'group_sub', groups: [74], mode: 'summary' }, 'peer-a');
    fanout.length = 0;
    manager.handleWire({ t: 'RCHAT', k: 'event_req', g: 74, q: request }, 'peer-a');
    await Promise.resolve();

    const relayedRequest = fanout.find((wire) => wire.k === 'event_req') as any;
    expect(relayedRequest).toMatchObject({
      t: 'RCHAT',
      k: 'event_req',
      g: 74,
      o: 'peer-a',
      h: 1,
    });

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_offer',
        g: 74,
        o: {
          x: 'transfer-relay-74',
          id: 'event-relay-74',
          ph: 'a'.repeat(64),
          wh: 'b'.repeat(64),
          s: 128,
          sp: 'peer-c',
          ...(typeof relayedRequest.rid === 'string' ? { rr: relayedRequest.rid } : {}),
        },
      },
      'peer-c'
    );
    await Promise.resolve();

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          t: 'RCHAT',
          k: 'event_offer',
          g: 74,
          o: expect.objectContaining({
            id: 'event-relay-74',
            sp: 'peer-c',
            ...(typeof relayedRequest.rid === 'string' ? { rr: relayedRequest.rid } : {}),
          }),
        }),
      })
    );
    manager.close();
  });

  it('does not relay plain direct event offers through implicit event routes', async () => {
    const fanout: Array<Record<string, unknown>> = [];
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
          fanout.push(...messages);
          return { ok: true as const };
        },
        sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
          direct.push({ peer, wire });
          return { ok: true as const };
        },
      } as any,
      now: () => 100_000,
    });
    const request = signedEventRequestWire({
      groupId: 75,
      eventId: 'event-direct-offer-not-relayed',
      timestamp: 100_000,
    });

    manager.handleWire({ t: 'RCHAT', k: 'group_sub', groups: [75], mode: 'summary' }, 'peer-a');
    manager.handleWire({ t: 'RCHAT', k: 'event_req', g: 75, q: request }, 'peer-a');
    await Promise.resolve();
    expect(fanout.some((wire) => wire.k === 'event_req')).toBe(true);

    direct.length = 0;
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_offer',
        g: 75,
        o: {
          x: 'transfer-direct-offer-not-relayed',
          id: 'event-direct-offer-not-relayed',
          ph: 'a'.repeat(64),
          wh: 'b'.repeat(64),
          s: 128,
        },
      },
      'peer-c'
    );
    await Promise.resolve();

    expect(direct).toEqual([]);
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
    manager.handleWire({ t: 'RCHAT', k: 'group_sub', groups: [70], mode: 'summary' }, 'peer-a');

    await manager.publishEvent(signedEvent({
      eventId: 'event-targeted-fallback-after-failure',
      groupId: 70,
      authorSeq: 1,
      timestamp: 100_000,
    }));

    expect(fallbackExcludes).toEqual([]);
    manager.close();
  });

  it('falls back to digest fanout when only some targeted event offers succeed', async () => {
    const fanout: Record<string, unknown>[] = [];
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        fanout.push(...messages);
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async (peer: string, message: Record<string, unknown>) => {
        direct.push({ peer, wire: message });
        if (peer === 'peer-a') return { ok: true as const };
        return { ok: false as const, reason: 'no-route' as const, error: 'No overlay route' };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
      signLocalFields: createReticulumChatTestSigner(),
    });
    manager.setLocalGroupMemberships([71]);
    manager.handleWire({ t: 'RCHAT', k: 'group_sub', groups: [71], mode: 'active' }, 'peer-a');
    manager.handleWire({ t: 'RCHAT', k: 'group_sub', groups: [71], mode: 'active' }, 'peer-b');

    const result = await manager.publishEvent(signedEvent({
      eventId: 'event-partial-targeted-fallback',
      groupId: 71,
      authorSeq: 1,
      timestamp: 100_000,
    }));

    expect(result.ok).toBe(true);
    expect(direct.filter(({ wire }) => wire.k === 'event_offer')).toHaveLength(2);
    expect(fanout).toContainEqual(expect.objectContaining({
      t: 'RCHAT',
      k: 'group_digest',
      g: 71,
    }));
    manager.close();
  });

  it('requests a feed page after receiving a newer peer digest', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    const event = signedEvent({ groupId: 9 });
    manager.setLocalGroupMemberships([9]);
    manager.subscribeGroup(9);
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_digest',
        g: 9,
        channels: [{
          c: 'general',
          latest: {
            id: event.eventId,
            ts: event.timestamp,
          },
        }],
      },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(direct.filter((wire) => wire.k === 'feed_req')).toHaveLength(1);
    expect(direct.find((wire) => wire.k === 'feed_req')).toMatchObject({
      t: 'RCHAT',
      k: 'feed_req',
      g: 9,
      c: 'general',
      limit: 25,
    });
    expect(byteLengthUtf8JsonWithBridgeSender(direct.find((wire) => wire.k === 'feed_req')!)).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    manager.close();
  });

  it('requests known feeds when a newer group digest has no channel rows', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    const event = signedEvent({ groupId: 9, timestamp: 90_000 });
    manager.setLocalGroupMemberships([9]);
    manager.subscribeGroup(9);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_digest',
        g: 9,
        latest: {
          id: event.eventId,
          ts: event.timestamp,
        },
        channels: [],
      },
      'peer'
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(direct.filter((wire) => wire.k === 'feed_req')).toHaveLength(1);
    expect(direct.find((wire) => wire.k === 'feed_req')).toMatchObject({
      t: 'RCHAT',
      k: 'feed_req',
      g: 9,
      c: 'general',
      limit: 25,
    });
    manager.close();
  });

  it('requests default feed when a digest hash differs but no cursor details are present', async () => {
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
    manager.setLocalGroupMemberships([9]);
    manager.subscribeGroup(9);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_digest',
        g: 9,
        channels: [],
        digestHash: 'f'.repeat(64),
      },
      'peer'
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(direct.filter((wire) => wire.k === 'feed_req')).toHaveLength(1);
    expect(direct.find((wire) => wire.k === 'feed_req')).toMatchObject({
      t: 'RCHAT',
      k: 'feed_req',
      g: 9,
      c: '*',
      limit: 25,
    });
    manager.close();
  });

  it('pushes local history when a cursorless peer digest is behind local history', async () => {
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
    manager.setLocalGroupMemberships([9]);
    const event = signedEvent({ groupId: 9, timestamp: 90_000 });
    await manager.publishEvent(event);
    manager.subscribeGroup(9);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_digest',
        g: 9,
        channels: [],
        digestHash: 'e'.repeat(64),
      },
      'peer'
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(direct.filter((wire) => wire.k === 'feed_req')).toHaveLength(0);
    expect(direct.some((wire) => ['event_offer', 'group_digest'].includes(String(wire.k)))).toBe(true);
    const digest = direct.find((wire) => wire.k === 'group_digest') as any;
    if (digest) {
      expect(digest.latest).toEqual({ id: event.eventId, ts: event.timestamp });
    }
    manager.close();
  });

  it('does not request repair for a matching empty digest hash with no cursor details', async () => {
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
    manager.setLocalGroupMemberships([9]);
    manager.subscribeGroup(9);
    direct.length = 0;
    const localDigest = (manager as any).buildGroupDigestWire(9);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_digest',
        g: 9,
        channels: [],
        digestHash: localDigest.digestHash,
      },
      'peer'
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(direct.filter((wire) => wire.k === 'feed_req')).toHaveLength(0);
    manager.close();
  });

  it('builds reduced channel digest variants for tight wire packets', () => {
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
      } as any,
    });
    const latest = { eventId: 'latest-event', feedTimestamp: 10_000 };
    const variants = (manager as any).buildDigestChannelWireVariants({
      groupId: 9,
      channelId: 'ch-digest-packing-test',
      latestCursor: latest,
      oldestCursor: { eventId: 'oldest-event', feedTimestamp: 1_000 },
      visibleWindowHash: 'a'.repeat(64),
    });

    expect(variants[0]).toMatchObject({
      c: 'ch-digest-packing-test',
      latest: { id: latest.eventId, ts: latest.feedTimestamp },
      oldest: { id: 'oldest-event', ts: 1_000 },
      wh: 'a'.repeat(64),
    });
    expect(variants).toContainEqual({
      c: 'ch-digest-packing-test',
      latest: { id: latest.eventId, ts: latest.feedTimestamp },
    });
    manager.close();
  });

  it('does not retry summary fanout when the overlay route is not ready', async () => {
    let now = 100_000;
    const sent: Record<string, unknown>[][] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        sent.push(messages);
        if (sent.length === 1) {
          return {
            ok: false as const,
            reason: 'no-route' as const,
            error: 'No overlay route',
          };
        }
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => now,
    });

    const result = await (manager as any).fanout({
      t: 'RCHAT',
      k: 'group_digest',
      g: 9,
      latest: { id: 'event-latest', ts: 90_000 },
      channels: [],
    });
    expect(result).toMatchObject({ ok: false, reason: 'no-route' });
    expect(sent).toHaveLength(1);

    now += 3_001;
    await (manager as any).drainControlRetryQueue();

    expect(sent).toHaveLength(1);
    manager.close();
  });

  it('retries repair fanout when the overlay route is not ready', async () => {
    let now = 90_000;
    const sent: Record<string, unknown>[][] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        sent.push(messages);
        if (sent.length === 1) {
          return {
            ok: false as const,
            reason: 'no-route' as const,
            error: 'No overlay route',
          };
        }
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => now,
    });

    const result = await (manager as any).fanout({
      t: 'RCHAT',
      k: 'feed_req',
      g: 9,
      c: 'general',
      limit: 25,
    });
    expect(result).toMatchObject({ ok: false, reason: 'no-route' });
    expect(sent).toHaveLength(1);

    now += 3_001;
    await (manager as any).drainControlRetryQueue();

    expect(sent).toHaveLength(2);
    expect(sent[1][0]).toMatchObject({
      t: 'RCHAT',
      k: 'feed_req',
      g: 9,
      c: 'general',
    });
    manager.close();
  });

  it('serves oversized feed results as event resource offers', async () => {
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const resources: unknown[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatResourceDetailed: async (payload: unknown) => {
        resources.push(payload);
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    const event = signedEvent({
      eventId: 'event-resource-rotate',
      groupId: 71,
      authorSeq: 1,
      timestamp: 100_000,
    });
    manager.setLocalGroupMemberships([71]);
    await manager.publishEvent(event);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'feed_req',
        g: 71,
        c: 'general',
        after: {
          id: event.eventId,
          ts: event.timestamp - 1,
        },
        limit: 25,
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(resources).toHaveLength(1);
    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          k: 'event_offer',
          o: expect.objectContaining({ id: event.eventId }),
        }),
      })
    );
    manager.close();
  });

  it('accepts event batches and requests exact author range repair for gaps', async () => {
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    const event = signedEvent({
      eventId: 'event-batch-gap-repair',
      groupId: 72,
      authorSeq: 3,
      timestamp: 100_000,
    });
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_batch',
        g: 72,
        c: 'general',
        batch: {
          dir: 'after',
          start: { ts: event.timestamp, id: event.eventId },
          end: { ts: event.timestamp, id: event.eventId },
          wh: nodeCrypto
            .createHash('sha256')
            .update(JSON.stringify([event.eventId]), 'utf8')
            .digest('hex'),
          events: [event],
        },
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          k: 'range_req',
          ranges: [expect.objectContaining({ a: event.authorAddress, from: 1, to: 2 })],
        }),
      })
    );
    expect(manager.getHistory(72, 10).map((item) => item.eventId)).toContain(event.eventId);
    manager.close();
  });

  it('requests exact author range repair when downloaded event resources reveal gaps', async () => {
    const acceptedTransfers: unknown[] = [];
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      acceptReticulumChatResourceDetailed: async (payload: unknown) => {
        acceptedTransfers.push(payload);
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);
    const event = signedEvent({
      eventId: 'event-resource-gap-repair',
      groupId: 72,
      authorSeq: 3,
      timestamp: 100_000,
    });
    const blob = serializeReticulumChatEvent(event);
    const wireHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
    const resourcePath = path.join(path.dirname(tempDbPath()), 'event-resource-gap.json');
    fs.writeFileSync(resourcePath, blob, 'utf8');

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_offer',
        g: 72,
        o: {
          x: 'transfer-resource-gap-repair',
          id: event.eventId,
          ph: event.payloadHash,
          wh: wireHash,
          s: Buffer.byteLength(blob, 'utf8'),
        },
      },
      'peer-a'
    );
    expect(acceptedTransfers).toHaveLength(1);

    manager.handleResourceEvent({
      status: 'received',
      transferId: 'transfer-resource-gap-repair',
      peerPresenceHash: 'peer-a',
      path: resourcePath,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          k: 'range_req',
          ranges: [expect.objectContaining({ a: event.authorAddress, from: 1, to: 2 })],
        }),
      })
    );
    expect(manager.getHistory(72, 10).map((item) => item.eventId)).toContain(event.eventId);
    manager.close();
  });

  it('requests the next feed page after importing a continuation event resource', async () => {
    const acceptedTransfers: unknown[] = [];
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      acceptReticulumChatResourceDetailed: async (payload: unknown) => {
        acceptedTransfers.push(payload);
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);
    const event = signedEvent({
      eventId: 'event-resource-continuation',
      groupId: 72,
      authorSeq: 1,
      timestamp: 100_000,
    });
    const blob = serializeReticulumChatEvent(event);
    const wireHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
    const resourcePath = path.join(path.dirname(tempDbPath()), 'event-resource-continuation.json');
    fs.writeFileSync(resourcePath, blob, 'utf8');

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_offer',
        g: 72,
        o: {
          x: 'transfer-resource-continuation',
          id: event.eventId,
          ph: event.payloadHash,
          wh: wireHash,
          s: Buffer.byteLength(blob, 'utf8'),
          fc: 'general',
          fd: 'a',
          fid: event.eventId,
          fts: event.timestamp,
        },
      },
      'peer-a'
    );
    expect(acceptedTransfers).toHaveLength(1);

    manager.handleResourceEvent({
      status: 'received',
      transferId: 'transfer-resource-continuation',
      peerPresenceHash: 'peer-a',
      path: resourcePath,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          k: 'feed_req',
          g: 72,
          c: 'general',
          after: { ts: event.timestamp, id: event.eventId },
          limit: 25,
        }),
      })
    );
    expect(manager.getHistory(72, 10).map((item) => item.eventId)).toContain(event.eventId);
    manager.close();
  });

  it('requests exact author range repair for already-stored sequence holes on peer digest', async () => {
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
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);
    const [first, third] = signedAuthorEvents([
      { eventId: 'event-known-gap-1', groupId: 72, authorSeq: 1, timestamp: 90_000 },
      { eventId: 'event-known-gap-3', groupId: 72, authorSeq: 3, timestamp: 91_000 },
    ]);
    expect((manager as any).db.insertEvent(first, false)).toBe(true);
    expect((manager as any).db.insertEvent(third, false)).toBe(true);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_digest',
        g: 72,
        latest: { id: third.eventId, ts: third.timestamp },
        channels: [
          {
            c: 'general',
            latest: { id: third.eventId, ts: third.timestamp },
            oldest: { id: first.eventId, ts: first.timestamp },
            wh: nodeCrypto
              .createHash('sha256')
              .update(JSON.stringify([first.eventId, third.eventId]), 'utf8')
              .digest('hex'),
          },
        ],
        digestHash: 'peer-digest',
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          k: 'range_req',
          ranges: [expect.objectContaining({ a: first.authorAddress, from: 2, to: 2 })],
        }),
      })
    );
    manager.close();
  });

  it('requests exact author range repair for already-stored sequence holes on peer subscription', async () => {
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
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);
    const [first, third] = signedAuthorEvents([
      { eventId: 'event-known-sub-gap-1', groupId: 72, authorSeq: 1, timestamp: 90_000 },
      { eventId: 'event-known-sub-gap-3', groupId: 72, authorSeq: 3, timestamp: 91_000 },
    ]);
    expect((manager as any).db.insertEvent(first, false)).toBe(true);
    expect((manager as any).db.insertEvent(third, false)).toBe(true);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_sub',
        groups: [72],
        mode: 'active',
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          k: 'range_req',
          ranges: [expect.objectContaining({ a: first.authorAddress, from: 2, to: 2 })],
        }),
      })
    );
    manager.close();
  });

  it('falls back to fanout when targeted author range repair cannot use the peer route', async () => {
    const fanoutWires: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (wires: Record<string, unknown>[]) => {
        fanoutWires.push(...wires);
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async () => ({
        ok: false as const,
        reason: 'no-overlay-route' as const,
      }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);
    const [first, third] = signedAuthorEvents([
      { eventId: 'event-known-fallback-gap-1', groupId: 72, authorSeq: 1, timestamp: 90_000 },
      { eventId: 'event-known-fallback-gap-3', groupId: 72, authorSeq: 3, timestamp: 91_000 },
    ]);
    expect((manager as any).db.insertEvent(first, false)).toBe(true);
    expect((manager as any).db.insertEvent(third, false)).toBe(true);
    fanoutWires.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_sub',
        groups: [72],
        mode: 'active',
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fanoutWires).toContainEqual(
      expect.objectContaining({
        k: 'range_req',
        ranges: [expect.objectContaining({ a: first.authorAddress, from: 2, to: 2 })],
      })
    );
    manager.close();
  });

  it('accepts group-wide event batches without filtering events to general', async () => {
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
        sendReticulumChatDetailed: async () => ({ ok: true as const }),
      } as any,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);
    const event = signedEvent({
      eventId: 'event-group-wide-import-channel',
      groupId: 72,
      channelId: 'ch-00000000-0000-4000-8000-000000000000',
      timestamp: 50_000,
    });

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_batch',
        g: 72,
        c: '*',
        batch: {
          start: { id: event.eventId, ts: event.timestamp },
          end: { id: event.eventId, ts: event.timestamp },
          dir: 'after',
          more: false,
          wh: (manager as any).db.computeWindowHash([event]),
          events: [event],
        },
      },
      'peer'
    );

    expect(manager.getHistory(72, event.channelId, 10).map((item) => item.eventId)).toEqual([
      event.eventId,
    ]);
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
        chunkBundle: true,
        chunkCount: 1,
        chunkRanges: [[0, 1]],
        bundleHash: chunkHashes[0],
      }),
    ]);
    expect(offeredResources.map((payload) => payload.streamMode)).toEqual([undefined]);
    expect(offerWires.map((wire) => (wire.o as any).br)).toEqual([[[0, 1]]]);
    expect(offerWires.map((wire) => (wire.o as any).bh)).toEqual([chunkHashes[0]]);
    expect(offerWires.every((wire) => wire.k === 'resource_offer')).toBe(true);
    manager.close();
    resourceStore.close();
  });

  it('serves a requested complete resource chunk as a resource bundle offer', async () => {
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
    expect(offeredResources.map((payload) => (payload.metadata as any).chunkBundle)).toEqual([
      true,
    ]);
    expect(offeredResources.map((payload) => (payload.metadata as any).chunkRanges)).toEqual([
      [[0, 1]],
    ]);
    expect(offeredResources.map((payload) => (payload.metadata as any).bundleHash)).toEqual(
      [manifest.chunkHashes[0]]
    );
    expect(offeredResources.map((payload) => payload.streamMode)).toEqual([undefined]);
    expect(offeredResources.map((payload) => payload.size)).toEqual([
      RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
    ]);
    expect(offerWires).toHaveLength(1);
    expect(offerWires.map((wire) => (wire.o as any).br)).toEqual([[[0, 1]]]);
    expect(offerWires.map((wire) => (wire.o as any).bh)).toEqual([manifest.chunkHashes[0]]);
    expect(offerWires.map((wire) => (wire.o as any).s)).toEqual([
      RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
    ]);
    manager.close();
    resourceStore.close();
  });

  it('serves requested resource chunks as one bounded resource range bundle', async () => {
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
    expect(offeredResources.map((payload) => payload.resourceType)).toEqual([
      'reticulum_group_resource_chunk',
    ]);
    expect(offeredResources.map((payload) => payload.streamMode)).toEqual([undefined]);
    expect(offeredResources.map((payload) => (payload.metadata as any).chunkBundle)).toEqual([
      true,
    ]);
    expect(offeredResources.map((payload) => (payload.metadata as any).chunkRanges)).toEqual([
      [[0, RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT]],
    ]);
    expect(offeredResources.map((payload) => payload.size)).toEqual([
      chunks.length * RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
    ]);
    expect(offerWires).toHaveLength(1);
    expect(offerWires.map((wire) => (wire.o as any).br)).toEqual([
      [[0, RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT]],
    ]);
    expect(typeof (offerWires[0].o as any).bh).toBe('string');
    for (const offerWire of offerWires) {
      expect(byteLengthUtf8JsonWithBridgeSender(offerWire)).toBeLessThanOrEqual(
        RT_RETICULUM_MAX_WIRE_JSON_BYTES
      );
    }
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
    expect(requestWire.q.o).toBeUndefined();
    expect(requestWire.q.fh).toBe(manifest.fileHash);
    expect(byteLengthUtf8JsonWithBridgeSender(requestWire)).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    manager.close();
    resourceStore.close();
  });

  it('does not reset a throttled resource download retry when the same resource is requested again', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-throttle-repeat-'));
    let nowMs = 100_000;
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => nowMs,
    });
    const chunkHashes = ['a'.repeat(64), 'b'.repeat(64)];
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '78:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: RETICULUM_RESOURCE_MIN_CHUNK_SIZE * 2,
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes,
      fileHash: 'c'.repeat(64),
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 78 },
    };
    const bridge = {
      getOverlayLinkSnapshots: () => [
        {
          peerPresenceHash: 'peer-a',
          lastRxAt: nowMs - 31_000,
        },
      ],
    };
    const transfer = new ReticulumResourceTransferManager<Record<string, unknown>>({
      bridge: bridge as any,
      resourceStore,
      now: () => nowMs,
      buildRequestPayloads: async () => [{ request: true }],
      sendRequestToPeer: async () => ({ ok: true as const }),
      fanoutRequest: async () => ({ ok: true as const }),
      sendOfferToPeer: async () => ({ ok: true as const }),
    });

    transfer.requestResource({
      contextId: 78,
      manifest,
      candidatePeers: ['peer-a'],
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const firstRetryAt = transfer.getDownloadStatus(manifest.fileHash).nextRequestAt;
    expect(firstRetryAt).toBe(nowMs + RETICULUM_RESOURCE_TRANSFER_OVERLAY_THROTTLE_RETRY_MS);

    nowMs += 100;
    transfer.requestResource({
      contextId: 78,
      manifest,
      candidatePeers: ['peer-a'],
    });

    expect(transfer.getDownloadStatus(manifest.fileHash).nextRequestAt).toBe(firstRetryAt);
    transfer.close();
    resourceStore.close();
  });

  it('relays signed resource requests when the local node cannot serve the file', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-relay-req-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const fileHash = 'c'.repeat(64);
    const relayCalls: Array<{ messages: Record<string, unknown>[]; exclude?: string[] }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => '4'.repeat(32),
      fanoutReticulumChatDetailed: async (
        messages: Record<string, unknown>[],
        exclude?: string[]
      ) => {
        relayCalls.push({ messages, exclude });
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => 100_000,
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([90]);
    const request = signedResourceRequestWire({
      groupId: 90,
      fileHash,
      chunkIndexes: [0],
      timestamp: 100_000,
    });
    const requestId = (manager as any).resourceRelayRequestId(90, request);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_route',
        g: 90,
        id: requestId,
        o: (manager as any).compactResourcePeerHash('2'.repeat(32)),
        fh: fileHash,
      },
      '3'.repeat(32)
    );
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_req',
        g: 90,
        q: request,
      },
      '3'.repeat(32)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0].exclude).toEqual([
      '3'.repeat(32),
      '2'.repeat(32),
      '4'.repeat(32),
    ]);
    expect(relayCalls[0].messages).toHaveLength(2);
    const forwardedRoute = relayCalls[0].messages.find(
      (wire) => wire.k === 'resource_route'
    ) as any;
    const forwarded = relayCalls[0].messages.find((wire) => wire.k === 'resource_req') as any;
    expect(forwardedRoute).toEqual(
      expect.objectContaining({
        k: 'resource_route',
        g: 90,
        id: requestId,
        fh: fileHash,
      })
    );
    expect((manager as any).normalizeResourcePeerHash(forwardedRoute.o)).toBe('2'.repeat(32));
    expect(forwarded).toEqual(
      expect.objectContaining({
        k: 'resource_req',
        g: 90,
      })
    );
    expect(forwarded.q.o).toBeUndefined();
    expect(forwarded.q.fh).toBe(fileHash);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_req',
        g: 90,
        q: request,
      },
      '3'.repeat(32)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(relayCalls).toHaveLength(1);
    manager.close();
    resourceStore.close();
  });

  it('relays resource offers back along the remembered request route', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-relay-offer-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const fileHash = 'd'.repeat(64);
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => '4'.repeat(32),
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => 100_000,
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([91]);
    const request = {
      ...signedResourceRequestWire({
        groupId: 91,
        fileHash,
        chunkIndexes: [0],
        timestamp: 100_000,
      }),
      rid: '5'.repeat(16),
    };
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_route',
        g: 91,
        id: '5'.repeat(16),
        o: (manager as any).compactResourcePeerHash('6'.repeat(32)),
        fh: fileHash,
      },
      '7'.repeat(32)
    );
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_req',
        g: 91,
        q: request,
      },
      '7'.repeat(32)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_offer',
        g: 91,
        o: {
          x: 'transfer-relayed',
          fh: fileHash,
          s: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
          ci: 0,
          ch: fileHash,
          cs: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
          rr: '5'.repeat(16),
          sp: '8'.repeat(32),
        },
      },
      '8'.repeat(32)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(direct).toEqual([
      {
        peer: '7'.repeat(32),
        wire: expect.objectContaining({
          k: 'resource_offer',
          g: 91,
          o: expect.objectContaining({
            rr: '5'.repeat(16),
            sp: '8'.repeat(32),
            fh: fileHash,
          }),
        }),
      },
    ]);
    manager.close();
    resourceStore.close();
  });

  it('accepts a relayed resource offer from the real source peer', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-relay-accept-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const chunk = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 9);
    const chunkHash = nodeCrypto.createHash('sha256').update(chunk).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '92:sender',
      fileName: 'relay.webp',
      mimeType: 'image/webp',
      sizeBytes: chunk.length,
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes: [chunkHash],
      fileHash: chunkHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 92 },
    };
    const fanout: Record<string, unknown>[] = [];
    const accepts: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => '9'.repeat(32),
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        fanout.push(...messages);
        return { ok: true as const };
      },
      acceptReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        accepts.push(payload);
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
    manager.setLocalGroupMemberships([92]);
    manager.subscribeGroup(92);

    await expect(manager.requestResource(92, manifest)).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const requestWire = fanout.find((wire) => wire.k === 'resource_req') as any;
    const relayRequestId = (manager as any).resourceRelayRequestId(92, requestWire.q);
    expect(relayRequestId).toMatch(/^[0-9a-f]{16}$/);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_offer',
        g: 92,
        o: {
          x: 'transfer-from-real-host',
          fh: chunkHash,
          s: chunk.length,
          ci: 0,
          ch: chunkHash,
          cs: chunk.length,
          rr: relayRequestId,
          sp: 'a'.repeat(32),
        },
      },
      'b'.repeat(32)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toEqual(
      expect.objectContaining({
        peerPresenceHash: 'a'.repeat(32),
        transferId: 'transfer-from-real-host',
        sha256: chunkHash,
      })
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

  it('does not accept duplicate complete-file offers while a full transfer is active', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-full-duplicate-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const bytes = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 11);
    const fileHash = nodeCrypto.createHash('sha256').update(bytes).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '84:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: bytes.length,
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes: [fileHash],
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 84 },
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
    manager.setLocalGroupMemberships([84]);
    manager.subscribeGroup(84);

    await expect(manager.requestResource(84, manifest)).resolves.toMatchObject({ ok: true });
    for (const transferId of ['full-transfer-a', 'full-transfer-b', 'full-transfer-c']) {
      manager.handleWire(
        {
          t: 'RCHAT',
          k: 'resource_offer',
          g: 84,
          o: {
            x: transferId,
            fh: fileHash,
            s: bytes.length,
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
      inFlightChunkCount: 0,
    });
    manager.close();
    resourceStore.close();
  });

  it('retries a complete-file download when the active full transfer goes stale', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-full-stale-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const bytes = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 12);
    const fileHash = nodeCrypto.createHash('sha256').update(bytes).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '85:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: bytes.length,
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes: [fileHash],
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 85 },
    };
    let now = 100_000;
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      acceptReticulumResourceDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => now,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
    });
    const progressEvents: Array<Record<string, unknown>> = [];
    manager.on('resource', (payload) => progressEvents.push(payload as Record<string, unknown>));
    manager.setLocalGroupMemberships([85]);
    manager.subscribeGroup(85);

    await expect(manager.requestResource(85, manifest)).resolves.toMatchObject({ ok: true });
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_offer',
        g: 85,
        o: {
          x: 'full-transfer-stale',
          fh: fileHash,
          s: bytes.length,
        },
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      activeTransfers: 1,
    });

    now += RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS + 1;
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      active: true,
      activeTransfers: 0,
      pendingTransfers: 0,
    });
    expect(progressEvents).not.toContainEqual(
      expect.objectContaining({
        fileHash,
        failed: true,
      })
    );
    manager.close();
    resourceStore.close();
  });

  it('emits live progress while a chunk transfer is still receiving', async () => {
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
          x: 'transfer-chunk-progress',
          fh: fileHash,
          s: chunks[0].length,
          ci: 0,
          ch: chunkHashes[0],
          cs: chunks[0].length,
        },
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    bridge.emit('reticulum-resource', {
      status: 'receiving',
      transferId: 'transfer-chunk-progress',
      progress: 0.5,
    });

    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        fileHash,
        progress: 0.125,
        completedChunks: 0,
        totalChunks: chunks.length,
      })
    );
    manager.close();
    resourceStore.close();
  });

  it('cancels an active resource download and closes the bridge transfer', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-cancel-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const chunks = [21, 22].map((value) =>
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
      ownerId: '86:receiver',
      fileName: 'cancel.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 86 },
    };
    resourceStore.storeManifest(manifest);
    resourceStore.storeChunk(fileHash, 0, chunks[0]);
    const storedChunkPath = resourceStore.getChunk(fileHash, 0)?.localPath;
    expect(storedChunkPath && fs.existsSync(storedChunkPath)).toBe(true);
    const bridge = new EventEmitter() as EventEmitter & Record<string, unknown>;
    bridge.fanoutReticulumChatDetailed = vi.fn(async () => ({ ok: true as const }));
    bridge.acceptReticulumResourceDetailed = vi.fn(async () => ({ ok: true as const }));
    bridge.cancelReticulumResourceDetailed = vi.fn(async () => ({ ok: true as const }));
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
    manager.setLocalGroupMemberships([86]);
    manager.subscribeGroup(86);

    await expect(manager.requestResource(86, manifest)).resolves.toMatchObject({ ok: true });
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_offer',
        g: 86,
        o: {
          x: 'transfer-cancel-active',
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

    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      active: true,
      activeTransfers: 1,
      inFlightChunkCount: 1,
    });
    expect(manager.cancelResource(fileHash)).toBe(true);
    expect(bridge.cancelReticulumResourceDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: 'transfer-cancel-active',
        peerPresenceHash: 'peer-a',
        reason: 'user_cancelled',
      })
    );
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      active: false,
      activeTransfers: 0,
      pendingTransfers: 0,
      inFlightChunkCount: 0,
    });
    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        fileHash,
        canceled: true,
        failed: false,
      })
    );
    expect(resourceStore.getChunk(fileHash, 0)).toMatchObject({
      status: 'missing',
      localPath: null,
    });
    expect(storedChunkPath && fs.existsSync(storedChunkPath)).toBe(false);
    manager.close();
    resourceStore.close();
  });

  it('keeps bounded parallel resource transfers per peer and releases stale active transfers', async () => {
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

    expect(accepts).toBe(RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER);
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      activeTransfers: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER,
      pendingTransfers: 0,
      inFlightChunkCount: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER,
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

    expect(accepts).toBe(RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER + 1);
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      activeTransfers: 1,
      pendingTransfers: 0,
    });
    manager.close();
    resourceStore.close();
  });

  it('keeps active transfer limits scoped per resource so an image is not blocked by a large file', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-peer-resource-link-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const largeChunks = [14, 15, 16, 17].map((value) =>
      Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, value)
    );
    const imageChunk = Buffer.alloc(RETICULUM_RESOURCE_MIN_CHUNK_SIZE, 15);
    const largeChunkHashes = largeChunks.map((chunk) =>
      nodeCrypto.createHash('sha256').update(chunk).digest('hex')
    );
    const largeHash = nodeCrypto
      .createHash('sha256')
      .update(Buffer.concat(largeChunks))
      .digest('hex');
    const imageHash = nodeCrypto.createHash('sha256').update(imageChunk).digest('hex');
    const largeManifest = {
      namespace: 'reticulum-chat-file',
      ownerId: '82:sender',
      fileName: 'large.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: largeChunks.reduce((total, chunk) => total + chunk.length, 0),
      chunkSize: RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
      chunkHashes: largeChunkHashes,
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
    const offers = [
      ...largeChunks.map((chunk, index) => ({
        x: `large-transfer-${index}`,
        fh: largeHash,
        s: chunk.length,
        ci: index,
        ch: largeChunkHashes[index],
        cs: chunk.length,
      })),
      { x: 'image-transfer', fh: imageHash, s: imageChunk.length, ci: 0, ch: imageHash, cs: imageChunk.length },
    ];
    for (const offer of offers) {
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

    expect(accepts).toBe(RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER + 1);
    expect(manager.getResourceDownloadStatus(largeHash)).toMatchObject({
      activeTransfers: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER,
      pendingTransfers: 0,
      inFlightChunkCount: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER,
    });
    expect(manager.getResourceDownloadStatus(imageHash)).toMatchObject({
      activeTransfers: 1,
      pendingTransfers: 0,
      inFlightChunkCount: 1,
    });
    manager.close();
    resourceStore.close();
  });

  it('subscribes with hello, group_sub, and bounded digest only', () => {
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
    expect(sent).toContainEqual(expect.objectContaining({ t: 'RCHAT', k: 'hello', v: 1 }));
    expect(sent).toContainEqual({ t: 'RCHAT', k: 'group_sub', groups: [48], mode: 'summary' });
    expect(sent).toContainEqual(expect.objectContaining({ t: 'RCHAT', k: 'group_digest', g: 48 }));
    expect(sent.find((wire) => wire.k === 'sync_req')).toBeUndefined();
    expect(sent.find((wire) => wire.k === 'author_heads_req')).toBeUndefined();
    manager.close();
  });

  it('subscription digest exposes latest cursor without requesting history', async () => {
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
    expect(sent.find((wire) => wire.k === 'sync_req')).toBeUndefined();
    expect(sent.find((wire) => wire.k === 'group_digest')).toMatchObject({
      t: 'RCHAT',
      k: 'group_digest',
      g: 49,
      latest: { id: event.eventId, ts: event.timestamp },
    });
    manager.close();
  });

  it('restores persisted groups as background subscriptions on startup', async () => {
    const knownGroups = vi
      .spyOn(ReticulumChatDatabase.prototype, 'getKnownGroupIds')
      .mockReturnValue([58]);
    const direct: Record<string, unknown>[] = [];
    const fanout: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        fanout.push(...messages);
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

    try {
      expect(manager.getSubscriptions()).toEqual([58]);
      expect(fanout).toContainEqual({ t: 'RCHAT', k: 'group_sub', groups: [58], mode: 'summary' });
      manager.handleWire(
        { t: 'RCHAT', k: 'group_sub', groups: [58], mode: 'summary' },
        'peer'
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(direct).toContainEqual(expect.objectContaining({
        t: 'RCHAT',
        k: 'group_digest',
        g: 58,
      }));
    } finally {
      manager.close();
      knownGroups.mockRestore();
    }
  });

  it('active channel subscription still emits digest, not before/after sync requests', async () => {
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

    manager.subscribeChannel(56, 'general');

    expect(sent.filter((wire) => wire.k === 'sync_req')).toEqual([]);
    expect(sent).toContainEqual(expect.objectContaining({ t: 'RCHAT', k: 'group_sub', groups: [56], mode: 'active' }));
    expect(sent).toContainEqual(expect.objectContaining({ t: 'RCHAT', k: 'group_digest', g: 56 }));
    manager.close();
  });

  it('collapses repeated active channel subscription fanouts inside the debounce window', async () => {
    let now = 80_000;
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
      now: () => now,
    });
    manager.setLocalGroupMemberships([56]);

    manager.subscribeChannel(56, 'general');
    const groupSubCountAfterFirst = sent.filter((wire) => wire.k === 'group_sub').length;
    const digestCountAfterFirst = sent.filter((wire) => wire.k === 'group_digest').length;
    manager.subscribeChannel(56, 'general');
    manager.subscribeChannel(56, 'general');

    expect(sent.filter((wire) => wire.k === 'group_sub')).toHaveLength(groupSubCountAfterFirst);
    expect(sent.filter((wire) => wire.k === 'group_digest')).toHaveLength(digestCountAfterFirst);

    now += 31_000;
    manager.subscribeChannel(56, 'general');

    expect(sent.filter((wire) => wire.k === 'group_sub')).toHaveLength(groupSubCountAfterFirst);
    expect(sent.filter((wire) => wire.k === 'group_digest')).toHaveLength(digestCountAfterFirst);
    manager.close();
  });

  it('reannounces subscriptions with one batched group_sub instead of one per group', async () => {
    let now = 80_000;
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
      now: () => now,
    });
    manager.setLocalGroupMemberships([56, 57, 58]);
    manager.subscribeGroup(56);
    manager.subscribeGroup(57);
    manager.subscribeGroup(58);
    sent.length = 0;

    now += 31_000;
    manager.reannounceSubscriptions();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const groupSubs = sent.filter((wire) => wire.k === 'group_sub');
    expect(sent.filter((wire) => wire.k === 'hello')).toHaveLength(1);
    expect(groupSubs).toHaveLength(1);
    expect(groupSubs[0]).toMatchObject({
      t: 'RCHAT',
      k: 'group_sub',
      groups: [56, 57, 58],
      mode: 'summary',
    });
    expect(sent.filter((wire) => wire.k === 'group_digest')).toHaveLength(3);
    manager.close();
  });

  it('reopening an already-restored channel still sends one active digest', async () => {
    const knownGroups = vi
      .spyOn(ReticulumChatDatabase.prototype, 'getKnownGroupIds')
      .mockReturnValue([716]);
    let now = 80_000;
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
      now: () => now,
    });

    try {
      expect(manager.getSubscriptions()).toEqual([716]);
      sent.length = 0;
      now += 31_000;

      manager.subscribeChannel(716, 'general');

      expect(sent).toContainEqual({
        t: 'RCHAT',
        k: 'group_sub',
        groups: [716],
        mode: 'active',
      });
      expect(sent).toContainEqual(expect.objectContaining({
        t: 'RCHAT',
        k: 'group_digest',
        g: 716,
      }));
    } finally {
      manager.close();
      knownGroups.mockRestore();
    }
  });

  it('rotates background digest refreshes beyond the first digest page', async () => {
    const groupIds = Array.from({ length: 25 }, (_value, index) => index + 1);
    const knownGroups = vi
      .spyOn(ReticulumChatDatabase.prototype, 'getKnownGroupIds')
      .mockReturnValue(groupIds);
    let now = 80_000;
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
      now: () => now,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 700));
      sent.length = 0;
      now += 31_000;

      manager.reannounceSubscriptions();
      await new Promise((resolve) => setTimeout(resolve, 700));

      const digestGroupIds = sent
        .filter((wire) => wire.k === 'group_digest')
        .map((wire) => Number(wire.g));
      expect(digestGroupIds).toContain(21);
      expect(digestGroupIds).toContain(25);
    } finally {
      manager.close();
      knownGroups.mockRestore();
    }
  });

  it('does not repeatedly serve digests for duplicate inbound group_sub controls', async () => {
    let now = 80_000;
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
      now: () => now,
    });
    manager.setLocalGroupMemberships([56]);
    manager.subscribeGroup(56);
    const groupSub = { t: 'RCHAT', k: 'group_sub', groups: [56], mode: 'summary' };

    manager.handleWire(groupSub, 'peer-hash');
    await new Promise((resolve) => setTimeout(resolve, 10));
    manager.handleWire(groupSub, 'peer-hash');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct.filter((wire) => wire.k === 'group_digest')).toHaveLength(1);

    now += 31_000;
    manager.handleWire(groupSub, 'peer-hash');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct.filter((wire) => wire.k === 'group_digest')).toHaveLength(2);
    manager.close();
  });

  it('requests the peer continuation page when an inbound digest has more channels', async () => {
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
      now: () => 80_000,
    });
    manager.setLocalGroupMemberships([56]);
    manager.subscribeGroup(56);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_digest',
        g: 56,
        channels: [],
        more: true,
        nextOffset: 16,
        digestHash: 'remote-page-0',
      },
      'peer-hash'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct).toContainEqual({
      t: 'RCHAT',
      k: 'digest_req',
      g: 56,
      offset: 16,
      limit: 16,
    });
    expect(direct.some((wire) => wire.k === 'group_digest')).toBe(false);
    manager.close();
  });

  it('serves the requested group digest continuation page', async () => {
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
      now: () => 80_000,
    });
    manager.setLocalGroupMemberships([57]);
    for (let index = 0; index < 20; index += 1) {
      const channelId = `channel-${String(index).padStart(2, '0')}`;
      (manager as any).db.upsertChannel({
        groupId: 57,
        channelId,
        name: channelId,
        position: index,
        archived: false,
        createdBy: 'Qcreator',
        createdAt: 10_000,
        updatedAt: 10_000,
      });
      await manager.publishEvent(signedEvent({
        groupId: 57,
        channelId,
        timestamp: 10_000 + index,
      }));
    }
    direct.length = 0;

    manager.handleWire(
      { t: 'RCHAT', k: 'digest_req', g: 57, offset: 16, limit: 16 },
      'peer-hash'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const digest = direct.find((wire) => wire.k === 'group_digest') as any;
    expect(digest).toBeDefined();
    const firstPage = (manager as any).buildGroupDigestWire(57, 0, 16) as any;
    const firstPageChannels = new Set(firstPage.channels.map((channel: any) => channel.c));
    const continuationChannels = digest.channels.map((channel: any) => channel.c);
    expect(digest.g).toBe(57);
    expect(digest.channels.length).toBeGreaterThan(0);
    expect(digest.channels.length).toBeLessThanOrEqual(4);
    expect(continuationChannels.every((channelId: string) => !firstPageChannels.has(channelId))).toBe(true);
    expect(byteLengthUtf8JsonWithBridgeSender(digest)).toBeLessThanOrEqual(RT_RETICULUM_MAX_WIRE_JSON_BYTES);
    manager.close();
  });

  it('responds to feed requests with resource offers and a digest', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
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
      { t: 'RCHAT', k: 'feed_req', g: 50, c: 'general', limit: 10 },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct.some((wire) => wire.k === 'event_offer')).toBe(true);
    expect(direct.some((wire) => wire.k === 'group_digest')).toBe(true);
    expect(direct.every((wire) => wire.k !== 'event_batch')).toBe(true);
    expect(Math.max(...direct.map((wire) => byteLengthUtf8JsonWithBridgeSender(wire)))).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    manager.close();
  });

  it('responds to group-wide feed requests without filtering to general', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([50]);
    (manager as any).db.upsertChannel({
      groupId: 50,
      channelId: 'ch-00000000-0000-4000-8000-000000000000',
      name: 'channel',
      position: 0,
      archived: false,
      createdBy: 'Qcreator',
      createdAt: 10_000,
      updatedAt: 10_000,
    });
    await manager.publishEvent(signedEvent({
      eventId: 'event-group-feed-channel',
      groupId: 50,
      channelId: 'ch-00000000-0000-4000-8000-000000000000',
      timestamp: 11_000,
    }));
    direct.length = 0;

    manager.handleWire(
      { t: 'RCHAT', k: 'feed_req', g: 50, c: '*', limit: 10 },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((manager as any).db.getGroupFeedPageAfter(50, null, 10).map((event: ReticulumChatEvent) => event.eventId)).toEqual([
      'event-group-feed-channel',
    ]);
    expect(direct.some((wire) => wire.k === 'event_offer')).toBe(true);
    expect(direct.some((wire) => wire.k === 'group_digest')).toBe(true);
    expect(direct.every((wire) => wire.k !== 'event_batch')).toBe(true);
    expect(direct).toEqual(expect.arrayContaining([expect.objectContaining({ t: 'RCHAT', g: 50 })]));
    manager.close();
  });

  it('responds to author range requests with events for that author only', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
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
        k: 'range_req',
        g: 60,
        ranges: [{ a: first.authorAddress, from: 1, to: 2 }],
        limit: 10,
      },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct.some((wire) => wire.k === 'event_offer')).toBe(true);
    expect(direct.some((wire) => wire.k === 'group_digest')).toBe(true);
    expect(direct.every((wire) => wire.k !== 'event_batch')).toBe(true);
    manager.close();
  });

  it('continues bounded feed windows forward until catch-up is complete', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
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
      { t: 'RCHAT', k: 'feed_req', g: 51, c: 'general', after: { ts: 20_001, id: 'event-page-1' }, limit: 1 },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const eventOffer = direct.find((wire) => wire.k === 'event_offer') as Record<string, any> | undefined;
    expect(eventOffer).toBeDefined();
    expect(eventOffer?.o).toMatchObject({
      id: 'event-page-2',
      fc: 'general',
      fd: 'a',
      fid: 'event-page-2',
      fts: 20_002,
    });
    expect(direct.filter((wire) => wire.k === 'feed_req')).toHaveLength(0);
    expect(direct.some((wire) => wire.k === 'group_digest')).toBe(true);
    expect(direct.every((wire) => wire.k !== 'event_batch')).toBe(true);
    manager.close();
  });

  it('serves older history with feed_req before', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
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
      { t: 'RCHAT', k: 'feed_req', g: 53, c: 'general', before: { ts: 30_003, id: 'event-history-3' }, limit: 2 },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct.some((wire) => wire.k === 'event_offer' || wire.k === 'group_digest')).toBe(true);
    manager.close();
  });

  it('pushes and requests visible window repair when digest latest matches but window hash differs', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 90_000,
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([54]);
    manager.subscribeGroup(54);
    const olderLocal = signedEvent({
      eventId: 'event-visible-window-local',
      groupId: 54,
      timestamp: 30_000,
    });
    const latestShared = signedEvent({
      eventId: 'event-visible-window-latest',
      groupId: 54,
      timestamp: 40_000,
    });
    expect((manager as any).db.insertEvent(olderLocal, true)).toBe(true);
    expect((manager as any).db.insertEvent(latestShared, true)).toBe(true);
    const latestCursor = {
      eventId: latestShared.eventId,
      feedTimestamp: latestShared.timestamp,
    };
    const getLatestSpy = vi
      .spyOn((manager as any).db, 'getLatestFeedCursor')
      .mockReturnValue(latestCursor);
    expect(
      (manager as any).db.getFeedPageBefore(54, 'general', latestCursor, 10)
        .map((event: ReticulumChatEvent) => event.eventId)
    ).toContain(olderLocal.eventId);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_digest',
        g: 54,
        latest: { id: latestCursor.eventId, ts: latestCursor.feedTimestamp },
        channels: [
          {
            c: 'general',
            latest: { id: latestCursor.eventId, ts: latestCursor.feedTimestamp },
            oldest: { id: 'event-visible-window-remote', ts: 31_000 },
            wh: 'different-remote-window-hash',
          },
        ],
        digestHash: 'different-remote-digest-hash',
      },
      'peer-window-mismatch'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(direct).toContainEqual(expect.objectContaining({
      t: 'RCHAT',
      k: 'feed_req',
      g: 54,
      c: 'general',
      before: { id: latestCursor.eventId, ts: latestCursor.feedTimestamp },
    }));
    const repairResponse = direct.find((wire) =>
      wire.k === 'event_offer' || wire.k === 'group_digest'
    ) as any;
    expect(repairResponse?.k).toBeTruthy();
    expect(direct.every((wire) => wire.k !== 'event_batch')).toBe(true);
    if (repairResponse.k === 'event_offer') {
      expect(repairResponse.o?.id).toBe(olderLocal.eventId);
    }
    getLatestSpy.mockRestore();
    manager.close();
  });

  it('uses group-wide backward repair when digest hashes differ and channel window hashes are omitted', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 90_000,
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([55]);
    manager.subscribeGroup(55);
    const olderLocal = signedEvent({
      eventId: 'event-group-window-local',
      groupId: 55,
      timestamp: 30_000,
    });
    const latestShared = signedEvent({
      eventId: 'event-group-window-latest',
      groupId: 55,
      timestamp: 40_000,
    });
    expect((manager as any).db.insertEvent(olderLocal, true)).toBe(true);
    expect((manager as any).db.insertEvent(latestShared, true)).toBe(true);
    const latestCursor = {
      eventId: latestShared.eventId,
      feedTimestamp: latestShared.timestamp,
    };
    const getLatestSpy = vi
      .spyOn((manager as any).db, 'getLatestFeedCursor')
      .mockReturnValue(latestCursor);
    expect(
      (manager as any).db.getGroupFeedPageBefore(55, latestCursor, 10)
        .map((event: ReticulumChatEvent) => event.eventId)
    ).toContain(olderLocal.eventId);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_digest',
        g: 55,
        latest: { id: latestCursor.eventId, ts: latestCursor.feedTimestamp },
        channels: [
          {
            c: 'general',
            latest: { id: latestCursor.eventId, ts: latestCursor.feedTimestamp },
          },
        ],
        digestHash: 'different-remote-digest-hash',
      },
      'peer-group-window-mismatch'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(direct).toContainEqual(expect.objectContaining({
      t: 'RCHAT',
      k: 'feed_req',
      g: 55,
      c: '*',
      before: { id: latestCursor.eventId, ts: latestCursor.feedTimestamp },
    }));
    const repairResponse = direct.find((wire) =>
      wire.k === 'event_offer' || wire.k === 'group_digest'
    ) as any;
    expect(repairResponse?.k).toBeTruthy();
    expect(direct.every((wire) => wire.k !== 'event_batch')).toBe(true);
    if (repairResponse.k === 'event_offer') {
      expect(repairResponse.o?.id).toBe(olderLocal.eventId);
    }
    getLatestSpy.mockRestore();
    manager.close();
  });

  it('repairs bidirectionally when digest hashes differ and local latest is newer', async () => {
    const direct: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([58]);
    manager.subscribeGroup(58);
    (manager as any).db.upsertChannel({
      groupId: 58,
      channelId: 'general',
      name: 'general',
      position: 0,
      archived: false,
      createdBy: 'test',
      createdAt: 30_000,
      updatedAt: 30_000,
    });
    const [olderLocal, latestLocal] = signedAuthorEvents([
      {
        eventId: 'event-bidirectional-local-old',
        groupId: 58,
        authorSeq: 1,
        timestamp: 30_000,
      },
      {
        eventId: 'event-bidirectional-local-latest',
        groupId: 58,
        authorSeq: 2,
        timestamp: 50_000,
      },
    ]);
    expect((manager as any).db.insertEvent(olderLocal, true)).toBe(true);
    expect((manager as any).db.insertEvent(latestLocal, true)).toBe(true);
    expect(manager.getHistory(58, 'general', 10).map((event) => event.eventId)).toContain(
      latestLocal.eventId
    );
    const remoteLatest = { id: 'event-bidirectional-remote-missing', ts: 40_000 };
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'group_digest',
        g: 58,
        latest: remoteLatest,
        channels: [
          {
            c: 'general',
            latest: remoteLatest,
          },
        ],
        digestHash: 'different-remote-digest-hash',
      },
      'peer-bidirectional-mismatch'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(direct).toContainEqual(expect.objectContaining({
      t: 'RCHAT',
      k: 'event_req',
      g: 58,
      q: expect.objectContaining({ id: remoteLatest.id }),
    }));
    expect(direct).toContainEqual(expect.objectContaining({
      t: 'RCHAT',
      k: 'feed_req',
      g: 58,
      c: '*',
      before: remoteLatest,
    }));
    expect(direct).toContainEqual(expect.objectContaining({
      t: 'RCHAT',
      k: 'event_offer',
      g: 58,
      o: expect.objectContaining({ id: latestLocal.eventId }),
    }));
    expect(direct.every((wire) => wire.k !== 'event_batch')).toBe(true);
    manager.close();
  });

  it('continues backward feed pages with a before cursor', async () => {
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
    });
    manager.setLocalGroupMemberships([53]);
    manager.subscribeGroup(53);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_batch',
        g: 53,
        c: 'general',
        batch: {
          dir: 'before',
          start: { ts: 30_001, id: 'event-history-1' },
          end: { ts: 30_002, id: 'event-history-2' },
          more: true,
          wh: 'hash',
          events: [],
        },
      },
      'peer'
    );

    expect(direct).toContainEqual({
      t: 'RCHAT',
      k: 'feed_req',
      g: 53,
      c: 'general',
      before: { ts: 30_001, id: 'event-history-1' },
      limit: 25,
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
      { t: 'RCHAT', k: 'feed_req', g: 54, c: 'general', limit: 10 },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct.some((wire) => wire.k === 'event_offer' || wire.k === 'group_digest')).toBe(true);
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
      { t: 'RCHAT', k: 'feed_req', g: 57, c: 'general', limit: 10 },
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
        k: 'group_digest',
        g: 77,
      })
    );
    manager.close();
  });

  it('applies channel metadata only when the author is a group admin', async () => {
    const payload = {
      channelId: 'support',
      name: 'support',
      position: 1,
    };
    const nonAdminEvent = signedEvent({
      eventId: 'event-channel-non-admin',
      groupId: 78,
      channelId: 'support',
      eventType: 'channel_create',
      encryptedPayload: JSON.stringify(payload),
    });
    const nonAdminManager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      } as any,
      validateGroupMember: async () => true,
      validateGroupAdmin: async () => false,
    });
    nonAdminManager.setLocalGroupMemberships([78]);
    expect((nonAdminManager as any).db.insertEvent(nonAdminEvent, true)).toBe(true);
    await expect(
      nonAdminManager.applyChannelMetadataEvent(nonAdminEvent.eventId, payload)
    ).resolves.toBe(false);
    expect(nonAdminManager.getChannels(78, true).map((channel) => channel.channelId)).toEqual([
      'general',
    ]);
    nonAdminManager.close();

    const adminEvent = signedEvent({
      eventId: 'event-channel-admin',
      groupId: 79,
      channelId: 'support',
      eventType: 'channel_create',
      encryptedPayload: JSON.stringify(payload),
    });
    const adminManager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      } as any,
      validateGroupMember: async () => true,
      validateGroupAdmin: async () => true,
    });
    adminManager.setLocalGroupMemberships([79]);
    expect((adminManager as any).db.insertEvent(adminEvent, true)).toBe(true);
    await expect(
      adminManager.applyChannelMetadataEvent(adminEvent.eventId, payload)
    ).resolves.toBe(true);
    expect(adminManager.getChannels(79, true).map((channel) => channel.channelId)).toContain(
      'support'
    );
    adminManager.close();
  });

  it('applies categories and clears channel category assignments', async () => {
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      } as any,
      validateGroupMember: async () => true,
      validateGroupAdmin: async () => true,
    });
    manager.setLocalGroupMemberships([81]);

    const applyMetadata = async (
      eventId: string,
      eventType: ReticulumChatEvent['eventType'],
      payload: Record<string, unknown>,
      channelId = 'general'
    ) => {
      const event = signedEvent({
        eventId,
        groupId: 81,
        channelId,
        eventType,
        encryptedPayload: JSON.stringify(payload),
      });
      expect((manager as any).db.insertEvent(event, true)).toBe(true);
      await expect(
        manager.applyChannelMetadataEvent(event.eventId, payload)
      ).resolves.toBe(true);
    };

    await applyMetadata('event-category-create', 'category_create', {
      categoryId: 'cat-team',
      name: 'team',
      position: 0,
    });
    expect(manager.getCategories(81)).toContainEqual(
      expect.objectContaining({ categoryId: 'cat-team', name: 'team' })
    );

    await applyMetadata(
      'event-channel-create-with-category',
      'channel_create',
      {
        channelId: 'support',
        categoryId: 'cat-team',
        name: 'support',
        position: 0,
      },
      'support'
    );
    expect(manager.getChannels(81, true)).toContainEqual(
      expect.objectContaining({ channelId: 'support', categoryId: 'cat-team' })
    );

    await applyMetadata(
      'event-channel-clear-category',
      'channel_update',
      {
        channelId: 'support',
        categoryId: '',
        name: 'support',
        position: 0,
      },
      'support'
    );
    expect(
      manager.getChannels(81, true).find((channel) => channel.channelId === 'support')
    ).toMatchObject({ channelId: 'support', categoryId: undefined });

    await applyMetadata(
      'event-channel-move-back-to-category',
      'channel_update',
      {
        channelId: 'support',
        categoryId: 'cat-team',
        name: 'support',
        position: 0,
      },
      'support'
    );
    await applyMetadata('event-category-delete', 'category_delete', {
      categoryId: 'cat-team',
    });

    expect(manager.getCategories(81)).toEqual([]);
    expect(
      manager.getChannels(81, true).find((channel) => channel.channelId === 'support')
    ).toMatchObject({ channelId: 'support', categoryId: undefined });
    manager.close();
  });

  it('returns channel metadata history across all group channels', () => {
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      } as any,
    });
    const metadataEvent = signedEvent({
      eventId: 'event-channel-metadata-cross-channel',
      groupId: 80,
      channelId: 'support',
      eventType: 'channel_create',
      timestamp: 10_000,
      encryptedPayload: JSON.stringify({
        channelId: 'support',
        name: 'support',
        position: 1,
      }),
    });
    const messageEvent = signedEvent({
      eventId: 'event-general-message',
      groupId: 80,
      channelId: 'general',
      eventType: 'message',
      timestamp: 11_000,
    });
    expect((manager as any).db.insertEvent(metadataEvent, true)).toBe(true);
    expect((manager as any).db.insertEvent(messageEvent, true)).toBe(true);

    expect(manager.getHistory(80, 'general', 10).map((item) => item.eventId)).toEqual([
      messageEvent.eventId,
    ]);
    expect(manager.getChannelMetadataHistory(80, 10).map((item) => item.eventId)).toEqual([
      metadataEvent.eventId,
    ]);
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
