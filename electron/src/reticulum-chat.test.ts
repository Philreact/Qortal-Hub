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
  buildReticulumChatGroupKeyDigestSignedFields,
  buildReticulumChatGroupKeyRequestSignedFields,
  buildReticulumChatGroupKeyResponseSignedFields,
  buildReticulumChatResourceFindSignedFields,
  buildReticulumChatResourceRequestSignedFields,
  hashReticulumChatPayload,
  ReticulumChatManager,
  serializeReticulumChatEvent,
  type ReticulumChatEvent,
  type ReticulumChatWire,
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
  RETICULUM_CHAT_RELAY_CACHE_MAX_AGE_MS,
} from './reticulum-chat-db';
import {
  RT_RETICULUM_MAX_WIRE_JSON_BYTES,
  byteLengthUtf8JsonWithBridgeSender,
  wireFitsReticulum,
} from './reticulum-wire-size';
import {
  ReticulumResourceStore,
  RETICULUM_RESOURCE_RANGE_SIZE,
} from './reticulum-resource-store';
import {
  RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE,
  RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS,
  RETICULUM_RESOURCE_TRANSFER_MAX_RANGE_ATTEMPTS,
  RETICULUM_RESOURCE_TRANSFER_OVERLAY_THROTTLE_RETRY_MS,
  RETICULUM_RESOURCE_TRANSFER_PULL_THROTTLE_MS,
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
    ...(overrides.mentionTargets ? { mentionTargets: overrides.mentionTargets } : {}),
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
      ...(overrides.mentionTargets ? { mentionTargets: overrides.mentionTargets } : {}),
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
        byteRanges: Array.isArray(fullFields.byteRanges)
          ? (fullFields.byteRanges.filter(
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
    } else if (
      fullFields.type === 'RCHAT_GROUP_KEY_DIGEST' &&
      typeof fullFields.groupId === 'number' &&
      typeof fullFields.epoch === 'number' &&
      typeof fullFields.keyId === 'string' &&
      typeof fullFields.timestamp === 'number'
    ) {
      signedFields = buildReticulumChatGroupKeyDigestSignedFields({
        groupId: fullFields.groupId,
        epoch: fullFields.epoch,
        keyId: fullFields.keyId,
        authorAddress,
        authorPublicKey,
        timestamp: fullFields.timestamp,
      });
    } else if (
      fullFields.type === 'RCHAT_GROUP_KEY_REQ' &&
      typeof fullFields.groupId === 'number' &&
      typeof fullFields.epoch === 'number' &&
      typeof fullFields.keyId === 'string' &&
      typeof fullFields.requestId === 'string' &&
      typeof fullFields.timestamp === 'number'
    ) {
      signedFields = buildReticulumChatGroupKeyRequestSignedFields({
        groupId: fullFields.groupId,
        epoch: fullFields.epoch,
        keyId: fullFields.keyId,
        requestId: fullFields.requestId,
        authorAddress,
        authorPublicKey,
        timestamp: fullFields.timestamp,
      });
    } else if (
      fullFields.type === 'RCHAT_GROUP_KEY_RES' &&
      typeof fullFields.groupId === 'number' &&
      typeof fullFields.epoch === 'number' &&
      typeof fullFields.keyId === 'string' &&
      typeof fullFields.keyBytesBase64 === 'string' &&
      typeof fullFields.requestId === 'string' &&
      typeof fullFields.timestamp === 'number'
    ) {
      signedFields = buildReticulumChatGroupKeyResponseSignedFields({
        groupId: fullFields.groupId,
        epoch: fullFields.epoch,
        keyId: fullFields.keyId,
        keyBytesBase64: fullFields.keyBytesBase64,
        requestId: fullFields.requestId,
        authorAddress,
        authorPublicKey,
        timestamp: fullFields.timestamp,
      });
    } else if (
      fullFields.type === 'RCHAT_RESOURCE_FIND' &&
      typeof fullFields.groupId === 'number' &&
      typeof fullFields.requestId === 'string' &&
      typeof fullFields.fileHash === 'string' &&
      typeof fullFields.sizeBytes === 'number' &&
      typeof fullFields.maxHops === 'number' &&
      typeof fullFields.expiresAt === 'number' &&
      typeof fullFields.timestamp === 'number'
    ) {
      signedFields = buildReticulumChatResourceFindSignedFields({
        groupId: fullFields.groupId,
        requestId: fullFields.requestId,
        fileHash: fullFields.fileHash,
        sizeBytes: fullFields.sizeBytes,
        maxHops: fullFields.maxHops,
        expiresAt: fullFields.expiresAt,
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
  byteRanges: Array<[number, number]>;
  timestamp: number;
}): {
  fh: string;
  b: Array<[number, number]>;
  pk: string;
  ts: number;
  sig: string;
} {
  const kp = nacl.sign.keyPair();
  const authorPublicKey = base58Encode(kp.publicKey);
  const authorAddress = deriveAddressFromPublicKey(authorPublicKey);
  const ranges = [...params.byteRanges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const fields = buildReticulumChatResourceRequestSignedFields({
    groupId: params.groupId,
    fileHash: params.fileHash,
    byteRanges: ranges,
    authorAddress,
    authorPublicKey,
    timestamp: params.timestamp,
  });
  return {
    fh: params.fileHash,
    b: ranges,
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

function signedResourceFindWire(params: {
  groupId: number;
  requestId: string;
  fileHash: string;
  sizeBytes: number;
  hop: number;
  maxHops: number;
  expiresAt: number;
  timestamp: number;
}): Extract<ReticulumChatWire, { k: 'rf' }> {
  const kp = nacl.sign.keyPair();
  const authorPublicKey = base58Encode(kp.publicKey);
  const authorAddress = deriveAddressFromPublicKey(authorPublicKey);
  const fields = buildReticulumChatResourceFindSignedFields({
    groupId: params.groupId,
    requestId: params.requestId,
    fileHash: params.fileHash,
    sizeBytes: params.sizeBytes,
    maxHops: params.maxHops,
    expiresAt: params.expiresAt,
    authorAddress,
    authorPublicKey,
    timestamp: params.timestamp,
  });
  return {
    t: 'RCHAT',
    k: 'rf',
    g: params.groupId,
    r: params.requestId,
    f: params.fileHash,
    s: params.sizeBytes,
    h: params.hop,
    m: params.maxHops,
    x: params.expiresAt,
    p: authorPublicKey,
    ts: params.timestamp,
    sg: base58Encode(
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

  it('projects many edits into one visible message history row', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const events = signedAuthorEvents([
      {
        eventId: 'root-message',
        groupId: 45,
        channelId: 'general',
        authorSeq: 1,
        timestamp: 1000,
        eventType: 'message',
        encryptedPayload: JSON.stringify({ messageText: 'original' }),
      },
      ...Array.from({ length: 199 }, (_, index) => ({
        eventId: `edit-${index + 1}`,
        groupId: 45,
        channelId: 'general',
        authorSeq: index + 2,
        timestamp: 1001 + index,
        eventType: 'edit' as const,
        targetEventId: 'root-message',
        encryptedPayload: JSON.stringify({ messageText: `edit-${index + 1}` }),
      })),
    ]);
    for (const event of events) {
      db.insertEvent(event, true);
    }

    expect(db.getRecentEvents(45, 200, 'general')).toHaveLength(200);
    const visible = db.getRecentMessageEvents(45, 200, 'general');
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      eventId: 'root-message',
      eventType: 'message',
      encryptedPayload: JSON.stringify({ messageText: 'edit-199' }),
    });
  });

  it('hides deleted messages from visible message history', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const events = signedAuthorEvents([
      {
        eventId: 'delete-root-message',
        groupId: 46,
        channelId: 'general',
        authorSeq: 1,
        timestamp: 1000,
        eventType: 'message',
      },
      {
        eventId: 'delete-event',
        groupId: 46,
        channelId: 'general',
        authorSeq: 2,
        timestamp: 1001,
        eventType: 'delete',
        targetEventId: 'delete-root-message',
      },
    ]);
    for (const event of events) {
      db.insertEvent(event, true);
    }

    expect(db.getRecentMessageEvents(46, 200, 'general')).toEqual([]);
  });

  it('removes projected messages when raw message events are evicted', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const event = signedEvent({
      eventId: 'evicted-root-message',
      groupId: 47,
      channelId: 'general',
      eventType: 'message',
    });
    db.insertEvent(event, false);
    expect(db.getRecentMessageEvents(47, 200, 'general')).toHaveLength(1);

    (db as any).deleteCachedEvent(event.eventId);

    expect(db.getEvent(event.eventId)).toBeNull();
    expect(db.getRecentMessageEvents(47, 200, 'general')).toEqual([]);
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

  it('tracks semantic @everyone and @group mention targets', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const mentionedAddress = deriveAddressFromPublicKey(
      base58Encode(nacl.sign.keyPair().publicKey)
    );
    const event = signedEvent({
      eventId: 'event-semantic-everyone-target',
      groupId: 166,
      mentionTargets: [{ type: 'everyone', groupId: 166 }],
    });
    expect(validateReticulumChatEventShape(event)).toBe(true);
    expect(verifyReticulumChatEvent(event)).toBe(true);
    db.insertEvent(event, true);

    expect(db.getChatSummaries(mentionedAddress)[0]).toMatchObject({
      groupId: 166,
      mentionCount: 1,
      hasUnreadMention: true,
    });
  });

  it('only applies @here targets for messages created during this app session', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const mentionedAddress = deriveAddressFromPublicKey(
      base58Encode(nacl.sign.keyPair().publicKey)
    );
    const onlineSince = Date.now();
    const beforeOnline = signedEvent({
      eventId: 'event-here-before-online',
      groupId: 167,
      authorSeq: 1,
      timestamp: onlineSince - 5_000,
      mentionTargets: [
        {
          type: 'here',
          groupId: 167,
          channelId: 'general',
          createdAt: onlineSince - 5_000,
        },
      ],
    });
    const afterOnline = signedEvent({
      eventId: 'event-here-after-online',
      groupId: 167,
      authorSeq: 2,
      timestamp: onlineSince + 5_000,
      mentionTargets: [
        {
          type: 'here',
          groupId: 167,
          channelId: 'general',
          createdAt: onlineSince + 5_000,
        },
      ],
    });
    db.insertEvent(beforeOnline, true);
    db.insertEvent(afterOnline, true);

    expect(db.getChatSummaries(mentionedAddress, onlineSince)[0]).toMatchObject({
      groupId: 167,
      mentionCount: 1,
      hasUnreadMention: true,
    });
  });

  it('applies edit and delete state to semantic mention target summaries', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const mentionedAddress = deriveAddressFromPublicKey(
      base58Encode(nacl.sign.keyPair().publicKey)
    );
    const original = signedEvent({
      eventId: 'event-semantic-edit-original',
      groupId: 168,
      authorSeq: 1,
      timestamp: Date.now(),
      mentionTargets: [],
    });
    const editAddsEveryone = signedEvent({
      eventId: 'event-semantic-edit-adds',
      groupId: 168,
      authorSeq: 2,
      timestamp: original.timestamp + 1,
      eventType: 'edit',
      targetEventId: original.eventId,
      mentionTargets: [{ type: 'group', groupId: 168, groupName: 'test-group' }],
    });
    const editRemovesEveryone = signedEvent({
      eventId: 'event-semantic-edit-removes',
      groupId: 168,
      authorSeq: 3,
      timestamp: original.timestamp + 2,
      eventType: 'edit',
      targetEventId: original.eventId,
      mentionTargets: [],
    });
    db.insertEvent(original, true);
    db.insertEvent(editAddsEveryone, true);
    expect(
      db.getChatSummaries(mentionedAddress).find((summary) => summary.groupId === 168)
    ).toMatchObject({
      mentionCount: 1,
      hasUnreadMention: true,
    });
    db.insertEvent(editRemovesEveryone, true);
    expect(
      db.getChatSummaries(mentionedAddress).find((summary) => summary.groupId === 168)
    ).toMatchObject({
      mentionCount: 0,
      hasUnreadMention: false,
    });
  });

  it('tracks semantic channel mention targets while all channels are visible', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const mentionedAddress = deriveAddressFromPublicKey(
      base58Encode(nacl.sign.keyPair().publicKey)
    );
    const event = signedEvent({
      eventId: 'event-semantic-channel-target',
      groupId: 169,
      channelId: 'general',
      mentionTargets: [
        {
          type: 'channel',
          groupId: 169,
          channelId: 'general-devs',
          channelName: 'general-devs',
        },
      ],
    });
    db.insertEvent(event, true);

    expect(db.getChatSummaries(mentionedAddress)[0]).toMatchObject({
      groupId: 169,
      mentionCount: 1,
      hasUnreadMention: true,
    });
  });

  it('tracks semantic mention targets beyond the recent summary window', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const mentionedAddress = deriveAddressFromPublicKey(
      base58Encode(nacl.sign.keyPair().publicKey)
    );
    const baseTimestamp = Date.now() - 60_000;
    const semanticMention = signedEvent({
      eventId: 'event-semantic-old-unread-target',
      groupId: 170,
      authorSeq: 1,
      timestamp: baseTimestamp,
      mentionTargets: [{ type: 'everyone', groupId: 170 }],
    });
    db.insertEvent(semanticMention, true);

    const fillerTemplate = signedEvent({
      eventId: 'event-semantic-window-filler-template',
      groupId: 170,
      authorSeq: 2,
      timestamp: baseTimestamp + 1,
      mentionTargets: [],
    });
    for (let index = 0; index < 501; index += 1) {
      db.insertEvent(
        {
          ...fillerTemplate,
          eventId: `event-semantic-window-filler-${index}`,
          authorSeq: index + 2,
          timestamp: baseTimestamp + index + 1,
          mentionTargets: [],
        },
        true
      );
    }

    expect(db.getChatSummaries(mentionedAddress)[0]).toMatchObject({
      groupId: 170,
      mentionCount: 1,
      hasUnreadMention: true,
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

  it('returns newest inclusive feed pages for cold sync repair', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const events = [1, 2, 3].map((seq) =>
      signedEvent({
        eventId: `event-inclusive-page-${seq}`,
        groupId: 47,
        channelId: seq === 2 ? 'ch-inclusive-page' : 'general',
        authorSeq: seq,
        timestamp: 2_000 + seq,
      })
    );
    for (const event of events) db.insertEvent(event, true);

    expect(
      db
        .getFeedPageAtOrBefore(
          47,
          'general',
          { eventId: 'event-inclusive-page-3', feedTimestamp: 2_003 },
          2
        )
        .map((item) => item.eventId)
    ).toEqual(['event-inclusive-page-1', 'event-inclusive-page-3']);
    expect(
      db
        .getGroupFeedPageAtOrBefore(
          47,
          { eventId: 'event-inclusive-page-3', feedTimestamp: 2_003 },
          2
        )
        .map((item) => item.eventId)
    ).toEqual(['event-inclusive-page-2', 'event-inclusive-page-3']);
  });

  it('exposes event-bearing channels even before channel metadata arrives', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const event = signedEvent({
      eventId: 'event-metadata-missing-channel',
      groupId: 48,
      channelId: 'ch-missing-metadata',
      authorSeq: 1,
      timestamp: 3_000,
    });
    db.insertEvent(event, true);

    expect(db.getChannels(48).map((channel) => channel.channelId)).toContain(
      'ch-missing-metadata'
    );
    expect(
      db.getRecentMessageEvents(48, 10, 'ch-missing-metadata').map((item) => item.eventId)
    ).toEqual([event.eventId]);
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

  it('persists offline relay cache blobs separately from normal chat events', () => {
    const dbPath = tempDbPath();
    const event = signedEvent({ eventId: 'relay-db-persist-event', groupId: 64 });
    const payloadJson = serializeReticulumChatEvent(event);
    const first = new ReticulumChatDatabase(dbPath);
    const stored = first.storeRelayEventBlob(event, payloadJson, 'relay-source');
    expect(stored).toMatchObject({ ok: true });
    expect(first.hasEvent(event.eventId)).toBe(false);
    first.close();

    const second = new ReticulumChatDatabase(dbPath);
    const cached = second.getRelayEventBlob(event.groupId, event.eventId);
    expect(cached).toMatchObject({
      eventId: event.eventId,
      groupId: event.groupId,
      encoding: 'plain-json-v1',
      encryption: 'none',
      payloadJson,
    });
    expect(second.hasEvent(event.eventId)).toBe(false);
    second.close();
  });

  it('expires offline relay cache blobs after the relay retention window', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const event = signedEvent({ eventId: 'relay-db-expiring-event', groupId: 65 });
    const payloadJson = serializeReticulumChatEvent(event);
    expect(db.storeRelayEventBlob(event, payloadJson, 'relay-source', 10_000)).toMatchObject({
      ok: true,
    });
    expect(db.getRelayEventBlob(65, event.eventId, 10_000)).toMatchObject({
      eventId: event.eventId,
    });
    expect(
      db.getRelayEventBlob(
        65,
        event.eventId,
        10_000 + RETICULUM_CHAT_RELAY_CACHE_MAX_AGE_MS + 1
      )
    ).toBeNull();
  });

  it('does not store attachment manifests in the offline relay cache', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const event = signedEvent({
      eventId: 'relay-db-attachment-event',
      groupId: 66,
      eventType: 'attachment_manifest',
    });
    const payloadJson = serializeReticulumChatEvent(event);
    expect(db.storeRelayEventBlob(event, payloadJson, 'relay-source')).toMatchObject({
      ok: false,
      reason: 'attachment-events-not-relayed',
    });
    expect(db.getRelayEventBlob(66, event.eventId)).toBeNull();
  });

  it('stores and retrieves active group keys', () => {
    const db = new ReticulumChatDatabase(tempDbPath());
    dbs.push(db);
    const key = {
      groupId: 91,
      epoch: 1,
      keyId: 'a'.repeat(64),
      keyBytesBase64: Buffer.alloc(32, 7).toString('base64'),
      createdBy: 'Qadmin',
      createdAt: 10_000,
      status: 'active' as const,
      adminPublicKey: 'admin-public-key',
      adminSignature: 'admin-signature',
    };
    db.upsertGroupKey(key);
    expect(db.getActiveGroupKey(91)).toMatchObject(key);
    expect(db.getGroupKey(91, 1, key.keyId)).toMatchObject(key);
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

  it('keeps reticulum group key exchange disabled behind the kill switch', async () => {
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
    const admin = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
      validateGroupAdmin: async () => true,
    });
    const hello = (admin as any).buildHelloWire();
    admin.setLocalGroupMemberships([{ groupId: 88, isPrivate: true }]);
    const privateKey = await (admin as any).createGroupKeyIfAdmin(88);
    const publicKey = await (admin as any).createGroupKeyIfAdmin(90);
    expect(hello.f).not.toContain('group_keys');
    expect(privateKey).toBeNull();
    expect(publicKey).toBeNull();
    expect((admin as any).db.getActiveGroupKey(88)).toBeNull();
    expect((admin as any).db.getActiveGroupKey(90)).toBeNull();
    expect(sent.some((wire) => wire.k === 'gkd')).toBe(false);
    admin.close();
  });

  it('publishes oversized live events as event resource offers and digest discovery', async () => {
    const fanout: Record<string, unknown>[] = [];
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const accepts: Array<Record<string, unknown>> = [];
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
      acceptReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        accepts.push(payload);
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

  it('stores relay event resources without importing them into normal chat history', async () => {
    const acceptedTransfers: unknown[] = [];
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const resources: unknown[] = [];
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
      sendReticulumChatResourceDetailed: async (payload: unknown) => {
        resources.push(payload);
        return { ok: true as const };
      },
    };
    const now = Date.now();
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => now,
    });
    const event = signedEvent({
      eventId: 'relay-cache-event',
      groupId: 701,
      timestamp: now,
    });
    const blob = serializeReticulumChatEvent(event);
    const wireHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
    const resourcePath = path.join(path.dirname(tempDbPath()), 'relay-cache-event.json');
    fs.writeFileSync(resourcePath, blob, 'utf8');

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_offer',
        g: 701,
        o: {
          x: 'relay-store-transfer',
          id: event.eventId,
          ph: event.payloadHash,
          wh: wireHash,
          s: Buffer.byteLength(blob, 'utf8'),
          rs: 1,
        },
      },
      'source-peer'
    );
    expect(acceptedTransfers).toHaveLength(1);

    manager.handleResourceEvent({
      status: 'received',
      transferId: 'relay-store-transfer',
      peerPresenceHash: 'source-peer',
      path: resourcePath,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(manager.getHistory(701, 10)).toHaveLength(0);
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'relay_query',
        g: 701,
        q: { ids: [event.eventId] },
      },
      'requester-peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(resources).toHaveLength(1);
    expect(direct).toContainEqual(
      expect.objectContaining({
        wire: expect.objectContaining({
          k: 'event_offer',
          o: expect.objectContaining({
            id: event.eventId,
            rc: 1,
            wh: wireHash,
          }),
        }),
      })
    );
    manager.close();
  });

  it('queues relay-store uploads for eligible published events', async () => {
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const resources: unknown[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
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
    manager.setLocalGroupMemberships([702]);
    manager.handleWire(
      { t: 'RCHAT', k: 'group_sub', groups: [999], mode: 'summary' },
      'relay-peer'
    );
    const event = signedEvent({
      eventId: 'relay-publish-event',
      groupId: 702,
      timestamp: 100_000,
    });

    await expect(manager.publishEvent(event)).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(resources).toHaveLength(1);
    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'relay-peer',
        wire: expect.objectContaining({
          k: 'event_offer',
          o: expect.objectContaining({
            id: event.eventId,
            rs: 1,
          }),
        }),
      })
    );
    manager.close();
  });

  it('serves relay digests for cached events after group_sub', async () => {
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
    const now = 100_000;
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => now,
    });
    const event = signedEvent({
      eventId: 'relay-digest-event',
      groupId: 703,
      timestamp: now,
    });
    (manager as any).db.storeRelayEventBlob(
      event,
      serializeReticulumChatEvent(event),
      'source-peer',
      now
    );

    manager.handleWire(
      { t: 'RCHAT', k: 'group_sub', groups: [703], mode: 'summary' },
      'requester-peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const digest = direct.find((item) => item.wire.k === 'relay_digest');
    expect(digest).toMatchObject({
      peer: 'requester-peer',
      wire: expect.objectContaining({
        t: 'RCHAT',
        k: 'relay_digest',
        g: 703,
      }),
    });
    expect((digest?.wire as any).events).toContainEqual(
      expect.objectContaining({
        id: event.eventId,
        ts: event.timestamp,
        c: event.channelId,
      })
    );
    manager.close();
  });

  it('does not serve empty or duplicate relay digests for repeated group_sub', async () => {
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
    };
    let now = 100_000;
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => now,
    });

    manager.handleWire(
      { t: 'RCHAT', k: 'group_sub', groups: [704], mode: 'summary' },
      'requester-peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(direct.some((item) => item.wire.k === 'relay_digest')).toBe(false);

    const event = signedEvent({
      eventId: 'relay-digest-duplicate-event',
      groupId: 704,
      timestamp: now,
    });
    (manager as any).db.storeRelayEventBlob(
      event,
      serializeReticulumChatEvent(event),
      'source-peer',
      now
    );
    now += 31_000;
    manager.handleWire(
      { t: 'RCHAT', k: 'group_sub', groups: [704], mode: 'summary' },
      'requester-peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(direct.filter((item) => item.wire.k === 'relay_digest')).toHaveLength(1);

    manager.handleWire(
      { t: 'RCHAT', k: 'group_sub', groups: [704], mode: 'summary' },
      'requester-peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(direct.filter((item) => item.wire.k === 'relay_digest')).toHaveLength(1);
    manager.close();
  });

  it('keeps relay digest pages inside the Reticulum wire limit', async () => {
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
    };
    const now = 100_000;
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => now,
    });
    for (let index = 0; index < 12; index += 1) {
      const event = signedEvent({
        eventId: `relay-digest-page-${index}`,
        groupId: 705,
        authorSeq: index + 1,
        timestamp: now + index,
      });
      (manager as any).db.storeRelayEventBlob(
        event,
        serializeReticulumChatEvent(event),
        'source-peer',
        now + index
      );
    }

    manager.handleWire(
      { t: 'RCHAT', k: 'group_sub', groups: [705], mode: 'summary' },
      'requester-peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const digests = direct.filter((item) => item.wire.k === 'relay_digest');
    expect(digests.length).toBeGreaterThan(0);
    expect(
      digests.reduce((total, item) => total + (((item.wire as any).events ?? []).length), 0)
    ).toBeGreaterThan(0);
    expect(digests.every((item) => wireFitsReticulum(item.wire))).toBe(true);
    manager.close();
  });

  it('uses relay digest discovery to fetch an offline cached event', async () => {
    const relayDirect: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const relayResources: Array<Record<string, any>> = [];
    const receiverDirect: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const relayBridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        relayDirect.push({ peer, wire });
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async (payload: Record<string, any>) => {
        relayResources.push(payload);
        return { ok: true as const };
      },
    };
    const receiverBridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        receiverDirect.push({ peer, wire });
        return { ok: true as const };
      },
      acceptReticulumChatResourceDetailed: async () => ({ ok: true as const }),
    };
    const now = 100_000;
    const relay = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: relayBridge as any,
      now: () => now,
    });
    const receiver = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: receiverBridge as any,
      now: () => now,
    });
    receiver.setLocalGroupMemberships([706]);
    receiver.subscribeGroup(706);
    receiverDirect.length = 0;
    const event = signedEvent({
      eventId: 'relay-offline-catchup-event',
      groupId: 706,
      timestamp: now,
    });
    (relay as any).db.storeRelayEventBlob(
      event,
      serializeReticulumChatEvent(event),
      'source-peer',
      now
    );

    relay.handleWire(
      { t: 'RCHAT', k: 'group_sub', groups: [706], mode: 'summary' },
      'receiver-peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const relayDigest = relayDirect.find((item) => item.wire.k === 'relay_digest');
    expect(relayDigest).toBeDefined();

    receiver.handleWire(relayDigest!.wire, 'relay-peer');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const relayQuery = receiverDirect.find((item) => item.wire.k === 'relay_query');
    expect(relayQuery).toMatchObject({
      peer: 'relay-peer',
      wire: expect.objectContaining({
        k: 'relay_query',
        q: expect.objectContaining({ ids: [event.eventId] }),
      }),
    });

    relay.handleWire(relayQuery!.wire, 'receiver-peer');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const eventOffer = relayDirect.find((item) => item.wire.k === 'event_offer');
    expect(eventOffer).toBeDefined();
    expect(relayResources).toHaveLength(1);

    receiver.handleWire(eventOffer!.wire, 'relay-peer');
    receiver.handleResourceEvent({
      status: 'received',
      transferId: relayResources[0].transferId,
      peerPresenceHash: 'relay-peer',
      path: relayResources[0].filePath,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(receiver.getHistory(706, 10).map((item) => item.eventId)).toContain(event.eventId);
    relay.close();
    receiver.close();
  });

  it('routes relay digest fetches through an intermediate overlay peer', async () => {
    const receiverPeer = 'aaaaaaaaaaaaaaaa';
    const intermediatePeer = 'bbbbbbbbbbbbbbbb';
    const relayPeer = 'cccccccccccccccc';
    const receiverDirect: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const intermediateDirect: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const intermediateFanout: Array<{ messages: Record<string, unknown>[]; excludes: string[] }> = [];
    const relayDirect: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const relayResources: Array<Record<string, any>> = [];
    const receiver = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        getLocalDestinationHash: () => receiverPeer,
        fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
        sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
          receiverDirect.push({ peer, wire });
          return { ok: true as const };
        },
        acceptReticulumChatResourceDetailed: async () => ({ ok: true as const }),
      } as any,
      now: () => 100_000,
    });
    const intermediate = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        getLocalDestinationHash: () => intermediatePeer,
        fanoutReticulumChatDetailed: async (
          messages: Record<string, unknown>[],
          excludes: string[] = []
        ) => {
          intermediateFanout.push({ messages, excludes });
          return { ok: true as const };
        },
        sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
          intermediateDirect.push({ peer, wire });
          return { ok: true as const };
        },
      } as any,
      now: () => 100_000,
    });
    const relay = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: {
        on: () => undefined,
        off: () => undefined,
        getLocalDestinationHash: () => relayPeer,
        fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
        sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
          relayDirect.push({ peer, wire });
          return { ok: true as const };
        },
        sendReticulumChatResourceDetailed: async (payload: Record<string, any>) => {
          relayResources.push(payload);
          return { ok: true as const };
        },
      } as any,
      now: () => 100_000,
    });
    receiver.setLocalGroupMemberships([707]);
    receiver.subscribeGroup(707);
    receiverDirect.length = 0;
    const event = signedEvent({
      eventId: 'relay-multihop-catchup-event',
      groupId: 707,
      timestamp: 100_000,
    });
    (relay as any).db.storeRelayEventBlob(
      event,
      serializeReticulumChatEvent(event),
      'dddddddddddddddd',
      100_000
    );

    intermediate.handleWire(
      { t: 'RCHAT', k: 'group_sub', groups: [707], mode: 'summary' },
      receiverPeer
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const forwardedSub = intermediateFanout
      .flatMap((item) => item.messages)
      .find((wire) => wire.k === 'group_sub');
    expect(forwardedSub).toMatchObject({
      k: 'group_sub',
    });
    expect(typeof forwardedSub?.o).toBe('string');

    relay.handleWire(forwardedSub!, intermediatePeer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const relayDigest = relayDirect.find((item) => item.wire.k === 'relay_digest');
    expect(relayDigest).toMatchObject({
      peer: intermediatePeer,
      wire: expect.objectContaining({ k: 'relay_digest', g: 707 }),
    });

    intermediate.handleWire(relayDigest!.wire, relayPeer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const forwardedDigest = intermediateDirect.find((item) => item.wire.k === 'relay_digest');
    expect(forwardedDigest).toMatchObject({
      peer: receiverPeer,
      wire: expect.objectContaining({ k: 'relay_digest', g: 707 }),
    });

    receiver.handleWire(forwardedDigest!.wire, intermediatePeer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const relayQuery = receiverDirect.find((item) => item.wire.k === 'relay_query');
    expect(relayQuery).toMatchObject({
      peer: intermediatePeer,
      wire: expect.objectContaining({ k: 'relay_query', g: 707 }),
    });

    intermediateFanout.length = 0;
    intermediate.handleWire(relayQuery!.wire, receiverPeer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const forwardedQuery = intermediateFanout
      .flatMap((item) => item.messages)
      .find((wire) => wire.k === 'relay_query');
    expect(forwardedQuery).toMatchObject({
      k: 'relay_query',
      g: 707,
    });
    expect(typeof forwardedQuery?.o).toBe('string');

    relay.handleWire(forwardedQuery!, intermediatePeer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const relayOffer = relayDirect.find((item) => item.wire.k === 'event_offer');
    expect(relayOffer).toMatchObject({
      peer: intermediatePeer,
      wire: expect.objectContaining({ k: 'event_offer', g: 707 }),
    });
    expect(relayResources[0]).toMatchObject({
      allowedRecipientAddress: receiverPeer,
    });

    intermediate.handleWire(relayOffer!.wire, relayPeer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const forwardedOffer = intermediateDirect.find((item) => item.wire.k === 'event_offer');
    expect(forwardedOffer).toMatchObject({
      peer: receiverPeer,
      wire: expect.objectContaining({ k: 'event_offer', g: 707 }),
    });

    receiver.handleWire(forwardedOffer!.wire, intermediatePeer);
    receiver.handleResourceEvent({
      status: 'received',
      transferId: relayResources[0].transferId,
      peerPresenceHash: relayPeer,
      path: relayResources[0].filePath,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(receiver.getHistory(707, 10).map((item) => item.eventId)).toContain(event.eventId);
    receiver.close();
    intermediate.close();
    relay.close();
  });

  it('prefers established overlay peers for relay-store uploads and randomizes selection', async () => {
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const resources: unknown[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getOverlayLinkSnapshots: () => [
        {
          linkId: 'link-alpha',
          peerPresenceHash: 'alpha-peer',
          incoming: false,
          connectedAt: 1,
          lastRxAt: 100_000,
          lastActivityAt: 100_000,
        },
        {
          linkId: 'link-gamma',
          peerPresenceHash: 'gamma-peer',
          incoming: false,
          connectedAt: 2,
          lastRxAt: 100_000,
          lastActivityAt: 100_000,
        },
      ],
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
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
    (manager as any).shuffleRelayPeers = (peers: string[]) => [...peers].reverse();
    manager.setLocalGroupMemberships([702]);
    for (const peer of ['alpha-peer', 'beta-peer', 'gamma-peer', 'delta-peer']) {
      manager.handleWire(
        { t: 'RCHAT', k: 'group_sub', groups: [999], mode: 'summary' },
        peer
      );
    }
    const event = signedEvent({
      eventId: 'relay-established-randomized-event',
      groupId: 702,
      timestamp: 100_000,
    });

    await expect(manager.publishEvent(event)).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(resources).toHaveLength(3);
    expect(direct.map((item) => item.peer)).toEqual([
      'gamma-peer',
      'alpha-peer',
      'delta-peer',
    ]);
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

  it('requests a newest inclusive feed page before peer latest when local history is empty', async () => {
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
      signLocalFields: createReticulumChatTestSigner(),
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
      before: {
        id: event.eventId,
        ts: event.timestamp,
      },
      inc: 1,
      limit: 100,
    });
    expect(byteLengthUtf8JsonWithBridgeSender(direct.find((wire) => wire.k === 'feed_req')!)).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    expect(direct).toContainEqual(expect.objectContaining({
      t: 'RCHAT',
      k: 'event_req',
      g: 9,
      q: expect.objectContaining({ id: event.eventId }),
    }));
    manager.close();
  });

  it('requests a group-wide newest page when a newer group digest has no channel rows', async () => {
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
      c: '*',
      before: {
        id: event.eventId,
        ts: event.timestamp,
      },
      inc: 1,
      limit: 100,
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
      limit: 100,
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

  it('serves feed results as one event page resource offer', async () => {
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
          k: 'event_page_offer',
          p: expect.objectContaining({ n: 1 }),
        }),
      })
    );
    manager.close();
  });

  it('serves event page resources without filtering out third-party cached authors', async () => {
    const direct: Array<{ peer: string; wire: Record<string, any> }> = [];
    const resources: Array<Record<string, any>> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, any>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatResourceDetailed: async (payload: Record<string, any>) => {
        resources.push(payload);
        return { ok: true as const };
      },
    };
    const first = signedEvent({
      eventId: 'event-page-provider-author',
      groupId: 72,
      channelId: 'general',
      authorSeq: 1,
      timestamp: 100_000,
    });
    const second = signedEvent({
      eventId: 'event-page-third-party-author',
      groupId: 72,
      channelId: 'general',
      authorSeq: 1,
      timestamp: 101_000,
    });
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 120_000,
      validateGroupMember: async (_groupId, address) => address === first.authorAddress,
    });
    manager.setLocalGroupMemberships([72]);
    expect((manager as any).db.insertEvent(first, true)).toBe(true);
    expect((manager as any).db.insertEvent(second, false)).toBe(true);

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'feed_req',
        g: 72,
        c: 'general',
        limit: 10,
      },
      'peer-a'
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(resources).toHaveLength(1);
    const page = JSON.parse(fs.readFileSync(resources[0].filePath, 'utf8')) as {
      events: Array<{ eventId: string }>;
    };
    expect(page.events.map((event) => event.eventId)).toEqual([
      first.eventId,
      second.eventId,
    ]);
    expect(direct).toContainEqual(
      expect.objectContaining({
        peer: 'peer-a',
        wire: expect.objectContaining({
          k: 'event_page_offer',
          p: expect.objectContaining({ n: 2 }),
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

  it('requests the newest page first for large author range gaps', async () => {
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
    const [first, latest] = signedAuthorEvents([
      { eventId: 'event-large-gap-first', groupId: 72, authorSeq: 1, timestamp: 50_000 },
      { eventId: 'event-large-gap-latest', groupId: 72, authorSeq: 80, timestamp: 100_000 },
    ]);
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);
    await manager.publishEvent(first);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_batch',
        g: 72,
        c: 'general',
        batch: {
          dir: 'after',
          start: { ts: latest.timestamp, id: latest.eventId },
          end: { ts: latest.timestamp, id: latest.eventId },
          wh: nodeCrypto
            .createHash('sha256')
            .update(JSON.stringify([latest.eventId]), 'utf8')
            .digest('hex'),
          events: [latest],
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
          ranges: [expect.objectContaining({ a: latest.authorAddress, from: 2, to: 79 })],
        }),
      })
    );
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
          limit: 100,
        }),
      })
    );
    expect(manager.getHistory(72, 10).map((item) => item.eventId)).toContain(event.eventId);
    manager.close();
  });

  it('imports signed events from one event page resource', async () => {
    const acceptedTransfers: unknown[] = [];
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
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);
    const events = signedAuthorEvents([
      { eventId: 'event-page-resource-1', groupId: 72, authorSeq: 1, timestamp: 90_001 },
      { eventId: 'event-page-resource-2', groupId: 72, authorSeq: 2, timestamp: 90_002 },
    ]);
    const page = {
      v: 1,
      g: 72,
      c: 'general',
      d: 'after',
      start: { ts: events[0].timestamp, id: events[0].eventId },
      end: { ts: events[1].timestamp, id: events[1].eventId },
      wh: nodeCrypto
        .createHash('sha256')
        .update(JSON.stringify(events.map((event) => event.eventId)), 'utf8')
        .digest('hex'),
      events,
    };
    const blob = JSON.stringify(page);
    const pageHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
    const resourcePath = path.join(path.dirname(tempDbPath()), 'event-page-resource.json');
    fs.writeFileSync(resourcePath, blob, 'utf8');

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_page_offer',
        g: 72,
        p: {
          x: 'transfer-event-page-resource',
          c: 'general',
          d: 'a',
          ph: pageHash,
          s: Buffer.byteLength(blob, 'utf8'),
          n: events.length,
          sid: events[0].eventId,
          sts: events[0].timestamp,
          eid: events[1].eventId,
          ets: events[1].timestamp,
        },
      },
      'peer-a'
    );
    expect(acceptedTransfers).toHaveLength(1);

    manager.handleResourceEvent({
      status: 'received',
      transferId: 'transfer-event-page-resource',
      peerPresenceHash: 'peer-a',
      path: resourcePath,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(manager.getHistory(72, 10).map((item) => item.eventId)).toEqual([
      'event-page-resource-1',
      'event-page-resource-2',
    ]);
    manager.close();
  });

  it('requests the next feed page after importing a continuation event page resource', async () => {
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
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([72]);
    manager.subscribeGroup(72);
    const events = signedAuthorEvents([
      { eventId: 'event-page-continuation-1', groupId: 72, authorSeq: 1, timestamp: 90_001 },
      { eventId: 'event-page-continuation-2', groupId: 72, authorSeq: 2, timestamp: 90_002 },
    ]);
    const page = {
      v: 1,
      g: 72,
      c: 'general',
      d: 'after',
      more: true,
      start: { ts: events[0].timestamp, id: events[0].eventId },
      end: { ts: events[1].timestamp, id: events[1].eventId },
      wh: nodeCrypto
        .createHash('sha256')
        .update(JSON.stringify(events.map((event) => event.eventId)), 'utf8')
        .digest('hex'),
      events,
    };
    const blob = JSON.stringify(page);
    const pageHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
    const resourcePath = path.join(path.dirname(tempDbPath()), 'event-page-continuation.json');
    fs.writeFileSync(resourcePath, blob, 'utf8');

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'event_page_offer',
        g: 72,
        p: {
          x: 'transfer-event-page-continuation',
          c: 'general',
          d: 'a',
          ph: pageHash,
          s: Buffer.byteLength(blob, 'utf8'),
          n: events.length,
          eid: events[1].eventId,
          ets: events[1].timestamp,
          more: 1,
        },
      },
      'peer-a'
    );
    expect(acceptedTransfers).toHaveLength(1);

    manager.handleResourceEvent({
      status: 'received',
      transferId: 'transfer-event-page-continuation',
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
          after: { ts: events[1].timestamp, id: events[1].eventId },
          limit: 100,
        }),
      })
    );
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

  it('serves linked byte-range auth requests on the established resource link', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-linked-auth-'));
    const sourcePath = path.join(tempRoot, 'source.bin');
    const sourceBytes = Buffer.concat([
      Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 21),
      Buffer.from('linked tail'),
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
      encrypted: false,
      metadata: { groupId: 81 },
    });

    const offeredResources: Array<Record<string, unknown>> = [];
    const authorizations: Array<Record<string, unknown>> = [];
    const rejections: Array<Record<string, unknown>> = [];
    const requesterPeerHash = 'd'.repeat(32);
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        offeredResources.push(payload);
        return { ok: true as const };
      },
      authorizeReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        authorizations.push(payload);
        return { ok: true as const };
      },
      rejectReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        rejections.push(payload);
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
    manager.setLocalGroupMemberships([81]);

    const range: [number, number] = [0, RETICULUM_RESOURCE_RANGE_SIZE];
    const request = signedResourceRequestWire({
      groupId: 81,
      fileHash: manifest.fileHash,
      byteRanges: [range],
      timestamp: 100_000,
    });
    const authRequest = {
      ...request,
      type: 'RETICULUM_GROUP_RESOURCE_AUTH',
      transferId: 'linked-transfer-1',
      groupId: 81,
      contextId: 81,
      fileHash: manifest.fileHash,
      totalSizeBytes: manifest.sizeBytes,
      byteRanges: [range],
      requesterPeerHash,
    };
    manager.handleGenericResourceEvent({
      status: 'auth',
      linkId: 'resource-link-1',
      transferId: 'linked-transfer-1',
      peerPresenceHash: requesterPeerHash,
      auth: authRequest,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.handleGenericResourceEvent({
      status: 'auth',
      linkId: 'resource-link-1-resource',
      transferId: 'linked-transfer-1',
      peerPresenceHash: requesterPeerHash,
      auth: authRequest,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const expectedPayloadHash = nodeCrypto
      .createHash('sha256')
      .update(sourceBytes.subarray(range[0], range[1]))
      .digest('hex');
    expect(rejections).toHaveLength(0);
    expect(offeredResources).toHaveLength(1);
    expect(offeredResources[0]).toEqual(
      expect.objectContaining({
        allowedRecipientAddress: requesterPeerHash,
        transferId: 'linked-transfer-1',
        resourceType: 'reticulum_group_resource_range',
        size: RETICULUM_RESOURCE_RANGE_SIZE,
        sha256: expectedPayloadHash,
      })
    );
    expect(authorizations).toEqual([
      {
        linkId: 'resource-link-1',
        transferId: 'linked-transfer-1',
      },
      {
        linkId: 'resource-link-1-resource',
        transferId: 'linked-transfer-1',
      },
    ]);
    manager.close();
    resourceStore.close();
  });

  it('does not serve byte ranges for resources outside the requested group', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-wrong-group-'));
    const sourcePath = path.join(tempRoot, 'source.bin');
    const sourceBytes = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 17);
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
      encrypted: false,
      metadata: { groupId: 81 },
    });

    const offeredResources: Array<Record<string, unknown>> = [];
    const rejections: Array<Record<string, unknown>> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        offeredResources.push(payload);
        return { ok: true as const };
      },
      rejectReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        rejections.push(payload);
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
    manager.setLocalGroupMemberships([82]);

    const range: [number, number] = [0, RETICULUM_RESOURCE_RANGE_SIZE];
    const request = signedResourceRequestWire({
      groupId: 82,
      fileHash: manifest.fileHash,
      byteRanges: [range],
      timestamp: 100_000,
    });
    manager.handleGenericResourceEvent({
      status: 'auth',
      linkId: 'resource-link-wrong-group',
      transferId: 'wrong-group-transfer',
      peerPresenceHash: 'a'.repeat(32),
      auth: {
        ...request,
        type: 'RETICULUM_GROUP_RESOURCE_AUTH',
        transferId: 'wrong-group-transfer',
        groupId: 82,
        contextId: 82,
        fileHash: manifest.fileHash,
        totalSizeBytes: manifest.sizeBytes,
        byteRanges: [range],
        requesterPeerHash: 'a'.repeat(32),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(offeredResources).toHaveLength(0);
    expect(rejections).toEqual([
      {
        linkId: 'resource-link-wrong-group',
        transferId: 'wrong-group-transfer',
        reason: 'request_not_allowed',
      },
    ]);
    manager.close();
    resourceStore.close();
  });

  it('serves a reused file hash through any group reference for that resource', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-multi-group-'));
    const sourcePath = path.join(tempRoot, 'shared.bin');
    const sourceBytes = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 19);
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
      fileName: 'shared.bin',
      mimeType: 'application/octet-stream',
      encrypted: false,
      metadata: { groupId: 81, eventId: 'event-file-group-81' },
    });
    resourceStore.importLocalFile({
      sourcePath,
      namespace: 'reticulum-chat-file',
      ownerId: '82:sender',
      fileName: 'shared.bin',
      mimeType: 'application/octet-stream',
      encrypted: false,
      metadata: { groupId: 82, eventId: 'event-file-group-82' },
    });

    const offeredResources: Array<Record<string, unknown>> = [];
    const authorizations: Array<Record<string, unknown>> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      sendReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        offeredResources.push(payload);
        return { ok: true as const };
      },
      authorizeReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        authorizations.push(payload);
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
    manager.setLocalGroupMemberships([81]);

    const range: [number, number] = [0, RETICULUM_RESOURCE_RANGE_SIZE];
    const request = signedResourceRequestWire({
      groupId: 81,
      fileHash: manifest.fileHash,
      byteRanges: [range],
      timestamp: 100_000,
    });
    manager.handleGenericResourceEvent({
      status: 'auth',
      linkId: 'resource-link-multi-group',
      transferId: 'multi-group-transfer',
      peerPresenceHash: 'a'.repeat(32),
      auth: {
        ...request,
        type: 'RETICULUM_GROUP_RESOURCE_AUTH',
        transferId: 'multi-group-transfer',
        groupId: 81,
        contextId: 81,
        fileHash: manifest.fileHash,
        totalSizeBytes: manifest.sizeBytes,
        byteRanges: [range],
        requesterPeerHash: 'a'.repeat(32),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(resourceStore.getManifest(manifest.fileHash)?.metadata?.groupId).toBe(82);
    expect(resourceStore.hasGroupReference(manifest.fileHash, 81)).toBe(true);
    expect(offeredResources).toHaveLength(1);
    expect(offeredResources[0].metadata).toEqual(
      expect.objectContaining({
        fileHash: manifest.fileHash,
        byteRanges: [range],
      })
    );
    expect(authorizations).toEqual([
      {
        linkId: 'resource-link-multi-group',
        transferId: 'multi-group-transfer',
      },
    ]);
    manager.close();
    resourceStore.close();
  });

  it('starts resource discovery after Core validates the local signer even when local membership cache is stale', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-stale-local-membership-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const contents = Buffer.concat([
      Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 4),
      Buffer.from('remaining bytes'),
    ]);
    const fileHash = nodeCrypto.createHash('sha256').update(contents).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '78:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: contents.length,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 78 },
    };
    const sent: Record<string, unknown>[] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => 'f'.repeat(32),
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

    await expect(
      manager.requestResource(78, manifest, 'b5941e04-b24f-4443-bcc7-05271585737b')
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const findWire = sent.find((wire) => wire.k === 'rf') as any;
    expect(findWire).toEqual(expect.objectContaining({ t: 'RCHAT', k: 'rf', g: 78 }));
    expect(findWire.f).toBe(fileHash);
    expect(findWire.s).toBe(manifest.sizeBytes);
    expect(byteLengthUtf8JsonWithBridgeSender(findWire)).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
    manager.close();
    resourceStore.close();
  });

  it('requests resource ranges from the manifest owner before event relay peers', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-owner-peer-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const contents = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 9);
    const ownerAddress = 'QownerAddress';
    const ownerPeer = 'a'.repeat(32);
    const relayPeer = 'b'.repeat(32);
    const localPeer = 'f'.repeat(32);
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: `78:${ownerAddress}`,
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: contents.length,
      fileHash: nodeCrypto.createHash('sha256').update(contents).digest('hex'),
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 78 },
    };
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const accepts: Array<Record<string, unknown>> = [];
    const fanouts: Array<{ messages: Record<string, unknown>[]; exclude?: string[] }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => localPeer,
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
      acceptReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        accepts.push(payload);
        return { ok: true as const };
      },
      fanoutReticulumChatDetailed: async (
        messages: Record<string, unknown>[],
        exclude?: string[]
      ) => {
        fanouts.push({ messages, exclude });
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
      getVerifiedReticulumPeers: () => [
        { address: ownerAddress, destinationHash: ownerPeer, lastSeen: 99_000 },
      ],
    });
    (manager as any).noteEventSourcePeer('event-with-image', relayPeer);

    await expect(
      manager.requestResource(78, manifest, 'event-with-image')
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({
      peerPresenceHash: ownerPeer,
      resourceType: 'reticulum_group_resource_range',
    });
    expect((accepts[0].authMessage as Record<string, unknown>)?.type).toBe(
      'RETICULUM_GROUP_RESOURCE_AUTH'
    );
    const findFanout = fanouts.find((call) =>
      call.messages.some((wire) => wire.k === 'rf')
    );
    expect(findFanout?.exclude).toEqual([ownerPeer, relayPeer, localPeer]);
    const findWire = findFanout?.messages.find((wire) => wire.k === 'rf') as
      | Record<string, unknown>
      | undefined;
    expect(findWire).toMatchObject({
      k: 'rf',
      g: 78,
      f: manifest.fileHash,
      s: manifest.sizeBytes,
      h: 0,
      m: 5,
    });
    manager.close();
    resourceStore.close();
  });

  it('adds resource_have responders as candidates without counting them as proven sources', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-have-peer-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const contents = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 10);
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '78:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: contents.length,
      fileHash: nodeCrypto.createHash('sha256').update(contents).digest('hex'),
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 78 },
    };
    const direct: Array<{ peer: string; wire: Record<string, unknown> }> = [];
    const accepts: Array<Record<string, unknown>> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (peer: string, wire: Record<string, unknown>) => {
        direct.push({ peer, wire });
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
    manager.setLocalGroupMemberships([78]);
    manager.subscribeGroup(78);

    await expect(
      manager.requestResource(78, manifest, 'event-with-image')
    ).resolves.toMatchObject({ ok: true });
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_have',
        g: 78,
        fh: manifest.fileHash,
        s: manifest.sizeBytes,
      },
      'c'.repeat(32)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = manager.getResourceDownloadStatus(manifest.fileHash);
    expect(status.candidatePeerCount).toBe(1);
    expect(status.peerCount).toBe(0);
    expect(accepts.some((item) => item.peerPresenceHash === 'c'.repeat(32))).toBe(true);
    manager.close();
    resourceStore.close();
  });

  it('clears exhausted range attempts when a user retries a resource download', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-user-retry-'));
    let nowMs = 100_000;
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => nowMs,
    });
    const contents = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 12);
    const manifest = {
      namespace: 'reticulum-chat-file',
      ownerId: '78:sender',
      fileName: 'retry.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash: nodeCrypto.createHash('sha256').update(contents).digest('hex'),
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 78 },
    };
    const accepts: Array<Record<string, unknown>> = [];
    const bridge = new EventEmitter() as EventEmitter & Record<string, unknown>;
    bridge.on = bridge.on.bind(bridge);
    bridge.off = bridge.off.bind(bridge);
    bridge.fanoutReticulumChatDetailed = async () => ({ ok: true as const });
    bridge.acceptReticulumResourceDetailed = async (payload: Record<string, unknown>) => {
      accepts.push(payload);
      return { ok: true as const };
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => nowMs,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
    });
    manager.setLocalGroupMemberships([78]);
    manager.subscribeGroup(78);

    await expect(
      manager.requestResource(78, manifest, 'event-with-file')
    ).resolves.toMatchObject({ ok: true });
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_have',
        g: 78,
        fh: manifest.fileHash,
        s: manifest.sizeBytes,
      },
      'd'.repeat(32)
    );

    for (let attempt = 0; attempt < RETICULUM_RESOURCE_TRANSFER_MAX_RANGE_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(accepts).toHaveLength(attempt + 1);
      bridge.emit('reticulum-resource', {
        status: 'failed',
        transferId: accepts[attempt].transferId,
      });
      nowMs += RETICULUM_RESOURCE_TRANSFER_PULL_THROTTLE_MS + 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(accepts).toHaveLength(RETICULUM_RESOURCE_TRANSFER_MAX_RANGE_ATTEMPTS);

    await expect(
      manager.requestResource(78, manifest, 'event-with-file')
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(accepts).toHaveLength(RETICULUM_RESOURCE_TRANSFER_MAX_RANGE_ATTEMPTS + 1);
    manager.close();
    resourceStore.close();
  });

  it('does not rate-limit resource discovery when the discovery fanout fails', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-discovery-retry-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const contents = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 11);
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '78:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: contents.length,
      fileHash: nodeCrypto.createHash('sha256').update(contents).digest('hex'),
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 78 },
    };
    const discoveryResults = [
      { ok: false as const, reason: 'no-overlay-route' as const, error: 'No overlay route' },
      { ok: true as const },
    ];
    const discoveryCalls: Record<string, unknown>[][] = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => 'f'.repeat(32),
      fanoutReticulumChatDetailed: async (messages: Record<string, unknown>[]) => {
        if (messages.some((wire) => wire.k === 'rf')) {
          discoveryCalls.push(messages);
          return discoveryResults.shift() ?? { ok: true as const };
        }
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => 100_000,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
    });

    await expect(
      manager.requestResource(78, manifest, 'event-with-image')
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(
      manager.requestResource(78, manifest, 'event-with-image')
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(discoveryCalls).toHaveLength(2);
    manager.close();
    resourceStore.close();
  });

  it('forwards signed resource discovery and routes provider replies back to the origin', async () => {
    const localPeer = '4'.repeat(32);
    const reversePeer = '2'.repeat(32);
    const providerHop = '3'.repeat(32);
    const providerPeer = '9'.repeat(32);
    const fileHash = 'a'.repeat(64);
    const direct: Array<{ peer: string; wire: ReticulumChatWire }> = [];
    const accepts: Array<Record<string, unknown>> = [];
    const fanouts: Array<{ messages: ReticulumChatWire[]; exclude?: string[] }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => localPeer,
      sendReticulumChatDetailed: async (peer: string, wire: ReticulumChatWire) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
      acceptReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        accepts.push(payload);
        return { ok: true as const };
      },
      fanoutReticulumChatDetailed: async (
        messages: ReticulumChatWire[],
        exclude?: string[]
      ) => {
        fanouts.push({ messages, exclude });
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
      validateGroupMember: async (groupId, address) => groupId === 78 && Boolean(address),
    });
    const findWire = signedResourceFindWire({
      groupId: 78,
      requestId: 'b'.repeat(16),
      eventId: 'event-with-image',
      fileHash,
      sizeBytes: 1_048_576,
      hop: 0,
      maxHops: 5,
      expiresAt: 130_000,
      timestamp: 100_000,
    });

    manager.handleWire(findWire, reversePeer);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const forwarded = fanouts.find((call) =>
      call.messages.some((wire) => wire.k === 'rf')
    );
    expect(forwarded?.exclude).toEqual([reversePeer, localPeer]);
    expect(forwarded?.messages[0]).toMatchObject({
      k: 'rf',
      r: findWire.r,
      h: 1,
      m: 5,
    });

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_have',
        g: 78,
        fh: fileHash,
        s: 1_048_576,
        rid: findWire.r,
        sp: providerPeer,
      },
      providerHop
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(direct.some((item) =>
      item.peer === reversePeer &&
      item.wire.k === 'resource_have' &&
      item.wire.rid === findWire.r &&
      typeof item.wire.sp === 'string'
    )).toBe(true);
    manager.close();
  });

  it('forwards signed resource discovery without validating membership on relay-only hops', async () => {
    const localPeer = '4'.repeat(32);
    const reversePeer = '2'.repeat(32);
    const fileHash = 'a'.repeat(64);
    const fanouts: Array<{ messages: ReticulumChatWire[]; exclude?: string[] }> = [];
    const validateGroupMember = vi.fn(async () => false);
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => localPeer,
      fanoutReticulumChatDetailed: async (
        messages: ReticulumChatWire[],
        exclude?: string[]
      ) => {
        fanouts.push({ messages, exclude });
        return { ok: true as const };
      },
      sendReticulumChatDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
      validateGroupMember,
    });
    const findWire = signedResourceFindWire({
      groupId: 78,
      requestId: 'd'.repeat(16),
      fileHash,
      sizeBytes: 1_048_576,
      hop: 0,
      maxHops: 5,
      expiresAt: 130_000,
      timestamp: 100_000,
    });

    manager.handleWire(findWire, reversePeer);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(validateGroupMember).not.toHaveBeenCalled();
    expect(fanouts.some((call) => call.messages.some((wire) => wire.k === 'rf'))).toBe(true);
    manager.close();
  });

  it('validates membership before answering resource discovery as a provider', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-find-provider-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const contents = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 18);
    const fileHash = nodeCrypto.createHash('sha256').update(contents).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '78:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: contents.length,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 78 },
    };
    resourceStore.storeManifest(manifest);
    resourceStore.storeByteRange(fileHash, 0, contents.length, contents);
    const direct: Array<{ peer: string; wire: ReticulumChatWire }> = [];
    const fanouts: Array<{ messages: ReticulumChatWire[]; exclude?: string[] }> = [];
    const validateGroupMember = vi.fn(async () => false);
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => '4'.repeat(32),
      sendReticulumChatDetailed: async (peer: string, wire: ReticulumChatWire) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
      fanoutReticulumChatDetailed: async (
        messages: ReticulumChatWire[],
        exclude?: string[]
      ) => {
        fanouts.push({ messages, exclude });
        return { ok: true as const };
      },
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => 100_000,
      validateGroupMember,
    });
    manager.setLocalGroupMemberships([78]);
    const findWire = signedResourceFindWire({
      groupId: 78,
      requestId: 'e'.repeat(16),
      fileHash,
      sizeBytes: contents.length,
      hop: 0,
      maxHops: 5,
      expiresAt: 130_000,
      timestamp: 100_000,
    });

    manager.handleWire(findWire, '2'.repeat(32));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(validateGroupMember).toHaveBeenCalledTimes(1);
    expect(direct.some((item) => item.wire.k === 'resource_have')).toBe(false);
    expect(fanouts.some((call) => call.messages.some((wire) => wire.k === 'rf'))).toBe(false);
    manager.close();
    resourceStore.close();
  });

  it('routes byte-range requests through the discovered provider path', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-provider-route-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const contents = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 17);
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '78:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: contents.length,
      fileHash: nodeCrypto.createHash('sha256').update(contents).digest('hex'),
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 78 },
    };
    const localPeer = 'f'.repeat(32);
    const nextHop = '5'.repeat(32);
    const providerPeer = '6'.repeat(32);
    const direct: Array<{ peer: string; wire: ReticulumChatWire }> = [];
    const accepts: Array<Record<string, unknown>> = [];
    const fanouts: Array<{ messages: ReticulumChatWire[]; exclude?: string[] }> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getLocalDestinationHash: () => localPeer,
      sendReticulumChatDetailed: async (peer: string, wire: ReticulumChatWire) => {
        direct.push({ peer, wire });
        return { ok: true as const };
      },
      acceptReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        accepts.push(payload);
        return { ok: true as const };
      },
      fanoutReticulumChatDetailed: async (
        messages: ReticulumChatWire[],
        exclude?: string[]
      ) => {
        fanouts.push({ messages, exclude });
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
    manager.setLocalGroupMemberships([78]);
    manager.subscribeGroup(78);

    await expect(
      manager.requestResource(78, manifest, 'event-with-image')
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const findWire = fanouts
      .flatMap((call) => call.messages)
      .find((wire): wire is Extract<ReticulumChatWire, { k: 'rf' }> =>
        wire.k === 'rf'
      );
    expect(findWire).toBeTruthy();

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_have',
        g: 78,
        fh: manifest.fileHash,
        s: manifest.sizeBytes,
        rid: findWire!.r,
        sp: providerPeer,
      },
      nextHop
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({
      peerPresenceHash: providerPeer,
      resourceType: 'reticulum_group_resource_range',
    });
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
    const contents = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE * 2, 7);
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '78:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: contents.length,
      fileHash: nodeCrypto.createHash('sha256').update(contents).digest('hex'),
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 78 },
    };
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      getOverlayLinkSnapshots: () => [
        {
          peerPresenceHash: 'peer-a',
          lastRxAt: nowMs - 31_000,
        },
      ],
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      resourceStore,
      now: () => nowMs,
      signLocalFields: createReticulumChatTestSigner(),
      validateGroupMember: async () => true,
    });

    manager.handleWire({ t: 'RCHAT', k: 'group_sub', groups: [78], mode: 'summary' }, 'peer-a');
    (manager as any).noteEventSourcePeer('b5941e04-b24f-4443-bcc7-05271585737b', 'peer-a');
    await expect(
      manager.requestResource(78, manifest, 'b5941e04-b24f-4443-bcc7-05271585737b')
    ).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const firstRetryAt = manager.getResourceDownloadStatus(manifest.fileHash).nextRequestAt;
    expect(firstRetryAt).toBe(nowMs + RETICULUM_RESOURCE_TRANSFER_OVERLAY_THROTTLE_RETRY_MS);

    nowMs += 100;
    await expect(
      manager.requestResource(78, manifest, 'b5941e04-b24f-4443-bcc7-05271585737b')
    ).resolves.toMatchObject({ ok: true });

    expect(manager.getResourceDownloadStatus(manifest.fileHash).nextRequestAt).toBe(firstRetryAt);
    manager.close();
    resourceStore.close();
  });

  it('opens a direct byte-range link to a resource_have provider', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-relayed-source-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const contents = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 9);
    const fileHash = nodeCrypto.createHash('sha256').update(contents).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-file',
      ownerId: '92:sender',
      fileName: 'source.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 92 },
    };
    const accepted: Array<Record<string, unknown>> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      acceptReticulumResourceDetailed: async (payload: Record<string, unknown>) => {
        accepted.push(payload);
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
    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'resource_have',
        g: 92,
        fh: fileHash,
        s: contents.length,
      },
      '8'.repeat(32)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toEqual(
      expect.objectContaining({
        peerPresenceHash: '8'.repeat(32),
        resourceType: 'reticulum_group_resource_range',
      })
    );
    expect(accepted[0].metadata).toEqual(
      expect.objectContaining({
        fileHash,
        totalSizeBytes: contents.length,
        byteRanges: [[0, contents.length]],
      })
    );
    expect((accepted[0].authMessage as Record<string, unknown>)?.type).toBe(
      'RETICULUM_GROUP_RESOURCE_AUTH'
    );
    manager.close();
    resourceStore.close();
  });

  it('opens each missing byte range once for repeated resource_have from the same provider', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-duplicate-range-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const contents = Buffer.concat([
      Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 5),
      Buffer.from('tail'),
    ]);
    const fileHash = nodeCrypto.createHash('sha256').update(contents).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '80:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: contents.length,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 80 },
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
    manager.setLocalGroupMemberships([80]);
    manager.subscribeGroup(80);

    await expect(manager.requestResource(80, manifest)).resolves.toMatchObject({ ok: true });
    for (let index = 0; index < 2; index += 1) {
      manager.handleWire(
        {
          t: 'RCHAT',
          k: 'resource_have',
          g: 80,
          fh: fileHash,
          s: contents.length,
        },
        'd'.repeat(32)
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepts).toBe(2);
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      activeTransfers: 2,
      inFlightRangeCount: 2,
    });
    manager.close();
    resourceStore.close();
  });

  it('emits live progress while a byte-range transfer is receiving', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-live-progress-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const contents = Buffer.concat([
      Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 1),
      Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 2),
    ]);
    const fileHash = nodeCrypto.createHash('sha256').update(contents).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-file',
      ownerId: '83:receiver',
      fileName: 'bundle.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 83 },
    };
    const bridge = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const accepted: Array<Record<string, unknown>> = [];
    bridge.fanoutReticulumChatDetailed = async () => ({ ok: true as const });
    bridge.acceptReticulumResourceDetailed = async (payload: Record<string, unknown>) => {
      accepted.push(payload);
      return { ok: true as const };
    };
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
        k: 'resource_have',
        g: 83,
        fh: fileHash,
        s: contents.length,
      },
      'e'.repeat(32)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(accepted).toHaveLength(2);

    bridge.emit('reticulum-resource', {
      status: 'receiving',
      transferId: accepted[0].transferId,
      progress: 0.5,
      bytesTransferred: RETICULUM_RESOURCE_RANGE_SIZE / 2,
      bytesPerSecond: 12_345,
    });

    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        fileHash,
        bytesTransferred: RETICULUM_RESOURCE_RANGE_SIZE / 2,
        totalBytes: contents.length,
        progress: 0.25,
      })
    );
    manager.close();
    resourceStore.close();
  });

  it('cancels an active resource download and deletes partial byte ranges', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-cancel-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const first = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 21);
    const second = Buffer.from('tail bytes');
    const contents = Buffer.concat([first, second]);
    const fileHash = nodeCrypto.createHash('sha256').update(contents).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-file',
      ownerId: '86:receiver',
      fileName: 'cancel.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash,
      encrypted: false,
      createdAt: 100_000,
      metadata: { groupId: 86 },
    };
    resourceStore.storeManifest(manifest);
    resourceStore.storeByteRange(fileHash, 0, first.length, first);
    const partialPath = resourceStore.getPartialPath(fileHash);
    expect(partialPath && fs.existsSync(partialPath)).toBe(true);
    const bridge = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const accepted: Array<Record<string, unknown>> = [];
    bridge.fanoutReticulumChatDetailed = vi.fn(async () => ({ ok: true as const }));
    bridge.acceptReticulumResourceDetailed = vi.fn(async (payload: Record<string, unknown>) => {
      accepted.push(payload);
      return { ok: true as const };
    });
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
        k: 'resource_have',
        g: 86,
        fh: fileHash,
        s: contents.length,
      },
      'f'.repeat(32)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(accepted).toHaveLength(1);

    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      active: true,
      activeTransfers: 1,
      inFlightRangeCount: 1,
    });
    expect(manager.cancelResource(fileHash)).toBe(true);
    expect(bridge.cancelReticulumResourceDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: accepted[0].transferId,
        peerPresenceHash: 'f'.repeat(32),
        reason: 'user_cancelled',
      })
    );
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      active: false,
      activeTransfers: 0,
      pendingTransfers: 0,
      inFlightRangeCount: 0,
    });
    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        fileHash,
        canceled: true,
        failed: false,
      })
    );
    expect(resourceStore.getCompletedRanges(fileHash)).toEqual([]);
    expect(partialPath && fs.existsSync(partialPath)).toBe(false);
    manager.close();
    resourceStore.close();
  });

  it('keeps active direct ranges per provider within the configured resource cap', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-one-peer-link-'));
    const resourceStore = new ReticulumResourceStore({
      dbPath: path.join(tempRoot, 'resources.db'),
      rootDir: path.join(tempRoot, 'resources'),
      now: () => 100_000,
    });
    const parts = Array.from({ length: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE + 2 }, (_, index) =>
      Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, index + 7)
    );
    const contents = Buffer.concat(parts);
    const fileHash = nodeCrypto.createHash('sha256').update(contents).digest('hex');
    const manifest = {
      namespace: 'reticulum-chat-image',
      ownerId: '80:sender',
      fileName: 'image.webp',
      mimeType: 'image/webp',
      sizeBytes: contents.length,
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
    for (let index = 0; index < 3; index += 1) {
      manager.handleWire(
        {
          t: 'RCHAT',
          k: 'resource_have',
          g: 80,
          fh: fileHash,
          s: contents.length,
        },
        'a'.repeat(32)
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepts).toBe(RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE);
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      activeTransfers: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE,
      pendingTransfers: 0,
      inFlightRangeCount: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE,
    });

    now += RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS + 1;
    manager.getResourceDownloadStatus(fileHash);
    await expect(manager.requestResource(80, manifest)).resolves.toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepts).toBe(RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE * 2);
    expect(manager.getResourceDownloadStatus(fileHash)).toMatchObject({
      activeTransfers: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE,
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
    const largeParts = Array.from({ length: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE }, (_, index) =>
      Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, index + 14)
    );
    const imageBytes = Buffer.alloc(RETICULUM_RESOURCE_RANGE_SIZE, 18);
    const largeBytes = Buffer.concat(largeParts);
    const largeHash = nodeCrypto.createHash('sha256').update(largeBytes).digest('hex');
    const imageHash = nodeCrypto.createHash('sha256').update(imageBytes).digest('hex');
    const largeManifest = {
      namespace: 'reticulum-chat-file',
      ownerId: '82:sender',
      fileName: 'large.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: largeBytes.length,
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
      sizeBytes: imageBytes.length,
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
    manager.handleWire(
      { t: 'RCHAT', k: 'resource_have', g: 82, fh: largeHash, s: largeBytes.length },
      'a'.repeat(32)
    );
    manager.handleWire(
      { t: 'RCHAT', k: 'resource_have', g: 82, fh: imageHash, s: imageBytes.length },
      'a'.repeat(32)
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(accepts).toBe(RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE + 1);
    expect(manager.getResourceDownloadStatus(largeHash)).toMatchObject({
      activeTransfers: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE,
      pendingTransfers: 0,
      inFlightRangeCount: RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_RESOURCE,
    });
    expect(manager.getResourceDownloadStatus(imageHash)).toMatchObject({
      activeTransfers: 1,
      pendingTransfers: 0,
      inFlightRangeCount: 1,
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

    expect(direct.some((wire) => wire.k === 'event_page_offer')).toBe(true);
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
    expect(direct.some((wire) => wire.k === 'event_page_offer')).toBe(true);
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

    expect(direct.some((wire) => wire.k === 'event_page_offer')).toBe(true);
    expect(direct.some((wire) => wire.k === 'group_digest')).toBe(true);
    expect(direct.every((wire) => wire.k !== 'event_batch')).toBe(true);
    manager.close();
  });

  it('serves author range repairs from newest missing sequence first', async () => {
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatResourceDetailed: async () => ({ ok: true as const }),
    };
    const manager = new ReticulumChatManager({
      dbPath: tempDbPath(),
      bridge: bridge as any,
      now: () => 100_000,
    });
    manager.setLocalGroupMemberships([60]);
    const events = signedAuthorEvents([
      { eventId: 'event-gap-response-1', groupId: 60, authorSeq: 1, timestamp: 40_000 },
      { eventId: 'event-gap-response-2', groupId: 60, authorSeq: 2, timestamp: 41_000 },
      { eventId: 'event-gap-response-3', groupId: 60, authorSeq: 3, timestamp: 42_000 },
    ]);
    for (const event of events) {
      await manager.publishEvent(event);
    }

    expect(
      (manager as any).db
        .getAuthorEventsRange(60, events[0].authorAddress, 1, 3, 2)
        .map((event: ReticulumChatEvent) => event.authorSeq)
    ).toEqual([3, 2]);
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

    const eventPageOffer = direct.find((wire) => wire.k === 'event_page_offer') as Record<string, any> | undefined;
    expect(eventPageOffer).toBeDefined();
    expect(eventPageOffer?.p).toMatchObject({
      c: 'general',
      d: 'a',
      eid: 'event-page-2',
      ets: 20_002,
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

    expect(direct.some((wire) => wire.k === 'event_page_offer' || wire.k === 'group_digest')).toBe(true);
    manager.close();
  });

  it('serves group-wide newest inclusive feed pages across channels', async () => {
    const direct: Record<string, unknown>[] = [];
    const resources: Array<Record<string, any>> = [];
    const bridge = {
      on: () => undefined,
      off: () => undefined,
      fanoutReticulumChatDetailed: async () => ({ ok: true as const }),
      sendReticulumChatDetailed: async (_peer: string, message: Record<string, unknown>) => {
        direct.push(message);
        return { ok: true as const };
      },
      sendReticulumChatResourceDetailed: async (payload: Record<string, any>) => {
        resources.push(payload);
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
    const older = signedEvent({
      eventId: 'event-group-wide-inclusive-old',
      groupId: 53,
      channelId: 'general',
      authorSeq: 1,
      timestamp: 30_001,
    });
    const latest = signedEvent({
      eventId: 'event-group-wide-inclusive-latest',
      groupId: 53,
      channelId: 'ch-other-channel',
      authorSeq: 2,
      timestamp: 30_002,
    });
    expect((manager as any).db.insertEvent(older, true)).toBe(true);
    expect((manager as any).db.insertEvent(latest, true)).toBe(true);
    direct.length = 0;

    manager.handleWire(
      {
        t: 'RCHAT',
        k: 'feed_req',
        g: 53,
        c: '*',
        before: { ts: latest.timestamp, id: latest.eventId },
        inc: 1,
        limit: 2,
      },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resources).toHaveLength(1);
    const page = JSON.parse(fs.readFileSync(resources[0].filePath, 'utf8')) as {
      c: string;
      events: Array<{ eventId: string; channelId: string }>;
    };
    expect(page.c).toBe('*');
    expect(page.events.map((event) => event.eventId)).toEqual([
      older.eventId,
      latest.eventId,
    ]);
    expect(page.events.map((event) => event.channelId)).toContain('ch-other-channel');
    expect(direct.some((wire) => wire.k === 'event_page_offer')).toBe(true);
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
      wire.k === 'event_page_offer' || wire.k === 'group_digest'
    ) as any;
    expect(repairResponse?.k).toBeTruthy();
    expect(direct.every((wire) => wire.k !== 'event_batch')).toBe(true);
    if (repairResponse.k === 'event_page_offer') {
      expect(repairResponse.p?.eid).toBe(olderLocal.eventId);
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
      wire.k === 'event_page_offer' || wire.k === 'group_digest'
    ) as any;
    expect(repairResponse?.k).toBeTruthy();
    expect(direct.every((wire) => wire.k !== 'event_batch')).toBe(true);
    if (repairResponse.k === 'event_page_offer') {
      expect(repairResponse.p?.eid).toBe(olderLocal.eventId);
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
      k: 'event_page_offer',
      g: 58,
      p: expect.objectContaining({ eid: latestLocal.eventId }),
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
      { t: 'RCHAT', k: 'feed_req', g: 54, c: 'general', limit: 10 },
      'peer'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(direct.some((wire) => wire.k === 'event_page_offer' || wire.k === 'group_digest')).toBe(true);
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

  it('serves cached event resources without provider-side author membership filtering', async () => {
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

    expect(sentResources).toHaveLength(1);
    expect(sentResources[0]).toMatchObject({
      transferId: expect.any(String),
      metadata: expect.objectContaining({
        eventId: event.eventId,
        groupId: 76,
        resourceType: 'reticulum_chat_event',
      }),
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
