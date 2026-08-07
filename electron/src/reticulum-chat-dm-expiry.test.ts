import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ReticulumChatDatabase,
  RETICULUM_DM_DEFAULT_EXPIRY_MS,
  directMessageExpiryFromPayload,
  reticulumDmConversationId,
} from './reticulum-chat-db';
import type { ReticulumDmEvent } from './reticulum-chat';

const roots: string[] = [];

const openDb = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rchat-dm-expiry-'));
  roots.push(root);
  return {
    db: new ReticulumChatDatabase(path.join(root, 'reticulum-chat.db')),
    root,
  };
};

const event = (
  overrides: Partial<ReticulumDmEvent> & Pick<ReticulumDmEvent, 'eventId'>
): ReticulumDmEvent => {
  const senderAddress = overrides.senderAddress || 'Qsender';
  const recipientAddress = overrides.recipientAddress || 'Qrecipient';
  const payload = overrides.payload ?? 'legacy message';
  return {
    eventId: overrides.eventId,
    conversationId: reticulumDmConversationId(senderAddress, recipientAddress),
    senderAddress,
    recipientAddress,
    senderPublicKey: 'public-key',
    senderStreamId: 'a'.repeat(32),
    senderSeq: 1,
    timestamp: Date.now(),
    eventType: 'message',
    payload,
    payloadHash: 'hash',
    signature: 'signature',
    ...overrides,
  };
};

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('Reticulum DM expiry persistence', () => {
  it('deduplicates call history, lets answered override missed, and marks missed calls read', () => {
    const { db } = openDb();
    const ownerAddress = 'Qowner';
    const peerAddress = 'Qpeer';
    const conversationId = reticulumDmConversationId(ownerAddress, peerAddress);
    const base = {
      ownerAddress,
      peerAddress,
      conversationId,
      callId: 'call_history_1',
      direction: 'incoming' as const,
      outcome: 'missed' as const,
      startedAt: 1_000,
      endedAt: 2_000,
      updatedAt: 2_000,
      authorPublicKey: 'public-key',
      signature: 'signature',
      readAt: 0,
    };
    const firstCallInsert = db.upsertDirectCallHistory(base);
    expect(firstCallInsert?.changed).toBe(true);
    expect(db.getDirectCallHistory(ownerAddress, peerAddress)).toHaveLength(1);
    expect(db.upsertDirectCallHistory(base)?.changed).toBe(false);
    expect(db.getDirectCallSummaries(ownerAddress)[0]).toMatchObject({
      unreadMissedCallCount: 1,
      lastCall: { outcome: 'missed' },
    });

    expect(
      db.upsertDirectCallHistory({
        ...base,
        outcome: 'answered',
        updatedAt: 3_000,
      })?.changed
    ).toBe(true);
    expect(db.getDirectCallSummaries(ownerAddress)[0]).toMatchObject({
      unreadMissedCallCount: 0,
      lastCall: { outcome: 'answered' },
    });

    db.upsertDirectCallHistory({
      ...base,
      callId: 'call_history_2',
      endedAt: 4_000,
      updatedAt: 4_000,
    });
    db.markDirectRead(conversationId, ownerAddress, 4_000);
    expect(
      db.getDirectCallHistory(ownerAddress, peerAddress, 10, true)
    ).toEqual([]);
    db.upsertDirectCallHistory({
      ...base,
      callId: 'call_history_2',
      endedAt: 4_000,
      updatedAt: 5_000,
    });
    expect(
      db.getDirectCallHistory(ownerAddress, peerAddress, 10, true)
    ).toEqual([]);
    db.close();
  });

  it('persists independent account-recipient preferences with a one-month default', () => {
    const { db, root } = openDb();
    expect(db.getDirectExpiryPreference('Qowner', 'Qpeer').durationMs).toBe(
      RETICULUM_DM_DEFAULT_EXPIRY_MS
    );
    expect(db.setDirectExpiryPreference('Qowner', 'Qpeer', null)).toMatchObject(
      { ownerAddress: 'Qowner', peerAddress: 'Qpeer', durationMs: null }
    );
    expect(
      db.setDirectExpiryPreference('Qowner', 'Qother', 24 * 60 * 60 * 1000)
    ).toMatchObject({ durationMs: 24 * 60 * 60 * 1000 });
    expect(
      db.setDirectExpiryPreference('Qowner', 'Qowner', 7 * 24 * 60 * 60 * 1000)
    ).toMatchObject({
      ownerAddress: 'Qowner',
      peerAddress: 'Qowner',
      durationMs: 7 * 24 * 60 * 60 * 1000,
    });
    db.close();

    const reopened = new ReticulumChatDatabase(
      path.join(root, 'reticulum-chat.db')
    );
    expect(
      reopened.getDirectExpiryPreference('Qowner', 'Qpeer').durationMs
    ).toBeNull();
    expect(
      reopened.getDirectExpiryPreference('Qanother', 'Qpeer').durationMs
    ).toBe(RETICULUM_DM_DEFAULT_EXPIRY_MS);
    expect(
      reopened.getDirectExpiryPreference('Qowner', 'Qowner').durationMs
    ).toBe(7 * 24 * 60 * 60 * 1000);
    reopened.close();
  });

  it('derives expiry once, inherits it for mutations, and keeps cursor markers', () => {
    const { db } = openDb();
    const createdAt = Date.now();
    const durationMs = 24 * 60 * 60 * 1000;
    const root = event({
      eventId: 'dm-expiry-root',
      timestamp: createdAt,
      payload: JSON.stringify({
        messageText: 'expires',
        expiryDurationMs: durationMs,
      }),
    });
    const edit = event({
      eventId: 'dm-expiry-edit',
      senderSeq: 2,
      timestamp: createdAt + 1,
      eventType: 'edit',
      targetEventId: root.eventId,
      payload: JSON.stringify({ messageText: 'edited' }),
    });
    const reaction = event({
      eventId: 'dm-expiry-reaction',
      senderAddress: root.recipientAddress,
      recipientAddress: root.senderAddress,
      senderStreamId: 'b'.repeat(32),
      senderSeq: 1,
      timestamp: createdAt + 2,
      eventType: 'reaction_add',
      targetEventId: root.eventId,
      payload: JSON.stringify({ otherData: { content: '👍' } }),
    });

    expect(db.insertDirectEvent(root, true)).toBe(true);
    expect(db.insertDirectEvent(edit, true)).toBe(true);
    expect(db.insertDirectEvent(reaction, false)).toBe(true);
    expect(db.getDirectEvent(root.eventId)?.expiresAt).toBe(
      createdAt + durationMs
    );
    expect(db.getDirectEvent(edit.eventId)?.expiresAt).toBe(
      createdAt + durationMs
    );
    expect(db.getDirectEvent(reaction.eventId)?.expiresAt).toBe(
      createdAt + durationMs
    );

    const pruned = db.pruneExpiredDirectMessages(createdAt + durationMs);
    expect(pruned.eventIds).toEqual(
      expect.arrayContaining([root.eventId, edit.eventId, reaction.eventId])
    );
    expect(db.getDirectHistory(root.conversationId)).toEqual([]);
    expect(db.hasDirectExpiredEventMarker(root.eventId)).toBe(true);
    const lateDelete = event({
      eventId: 'dm-expiry-late-delete',
      senderSeq: 3,
      timestamp: createdAt + durationMs + 1,
      eventType: 'delete',
      targetEventId: root.eventId,
      payload: JSON.stringify({ messageText: '' }),
    });
    expect(db.insertDirectEvent(lateDelete, true)).toBe(false);
    expect(db.hasDirectExpiredEventMarker(lateDelete.eventId)).toBe(true);
    expect(
      db.getDirectSyncCursorFromSender(root.conversationId, root.senderAddress)
    ).toMatchObject({
      eventId: lateDelete.eventId,
      timestamp: lateDelete.timestamp,
    });
    db.close();
  });

  it('keeps legacy and explicit no-expiry messages, and rejects invalid choices', () => {
    const { db } = openDb();
    const legacy = event({ eventId: 'dm-expiry-legacy' });
    const noExpiry = event({
      eventId: 'dm-expiry-none',
      senderSeq: 2,
      payload: JSON.stringify({ messageText: 'keep', expiryDurationMs: 0 }),
    });
    expect(db.insertDirectEvent(legacy, true)).toBe(true);
    expect(db.insertDirectEvent(noExpiry, true)).toBe(true);
    expect(db.getDirectEvent(legacy.eventId)?.expiresAt).toBeNull();
    expect(db.getDirectEvent(noExpiry.eventId)?.expiresAt).toBeNull();
    expect(
      directMessageExpiryFromPayload(
        JSON.stringify({ expiryDurationMs: 12345 })
      ).valid
    ).toBe(false);
    expect(
      directMessageExpiryFromPayload(JSON.stringify({ expiryDurationMs: '0' }))
        .valid
    ).toBe(false);
    db.close();
  });

  it('filters expired summaries and can query only one affected peer', () => {
    const { db } = openDb();
    const createdAt = Date.now();
    const expiring = event({
      eventId: 'dm-expiry-summary',
      timestamp: createdAt,
      payload: JSON.stringify({
        messageText: 'temporary',
        expiryDurationMs: 24 * 60 * 60 * 1000,
      }),
    });
    const persistent = event({
      eventId: 'dm-expiry-other-summary',
      senderAddress: 'Qsender',
      recipientAddress: 'Qother',
      senderSeq: 2,
      timestamp: createdAt + 1,
      payload: JSON.stringify({
        messageText: 'persistent',
        expiryDurationMs: 0,
      }),
    });
    expect(db.insertDirectEvent(expiring, true)).toBe(true);
    expect(db.insertDirectEvent(persistent, true)).toBe(true);
    expect(db.getDirectSummaries('Qsender', 'Qrecipient')).toHaveLength(1);
    expect(db.getDirectSummaries('Qsender', 'Qother')).toHaveLength(1);

    db.pruneExpiredDirectMessages(createdAt + 24 * 60 * 60 * 1000);
    expect(db.getDirectSummaries('Qsender', 'Qrecipient')).toHaveLength(0);
    expect(db.getDirectSummaries('Qsender', 'Qother')).toHaveLength(1);
    db.close();
  });
});
