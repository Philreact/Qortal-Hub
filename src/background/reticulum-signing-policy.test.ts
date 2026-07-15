import { describe, expect, it } from 'vitest';
import {
  assertAllowedPresenceSigningPayload,
  assertAllowedReticulumSigningPayload,
} from './reticulum-signing-policy';

function expectAllowed(
  validator: (payload: unknown) => void,
  payload: Record<string, unknown>
): void {
  expect(() => validator(payload)).not.toThrow();
}

describe('Reticulum wallet signing policy', () => {
  it('allows every current presence, call, and file-auth control type', () => {
    const payloads: Record<string, unknown>[] = [
      {
        type: 'PRESENCE_ANNOUNCE',
        address: 'a',
        clientVersion: '1',
        publicKey: 'p',
        sessionId: 's',
        status: 'online',
        timestamp: 1,
      },
      {
        type: 'PRESENCE_HEARTBEAT',
        address: 'a',
        publicKey: 'p',
        sessionId: 's',
        status: 'online',
        timestamp: 1,
      },
      {
        type: 'PRESENCE_OFFLINE',
        address: 'a',
        publicKey: 'p',
        sessionId: 's',
        timestamp: 1,
      },
      {
        type: 'CALL_REQUEST',
        callId: 'c',
        chatId: 'd',
        fromAddress: 'a',
        fromPublicKey: 'p',
        timestamp: 1,
      },
      { type: 'CALL_ACCEPT', callId: 'c', timestamp: 1 },
      { type: 'CALL_REJECT', callId: 'c', timestamp: 1 },
      { type: 'CALL_HANGUP', callId: 'c', timestamp: 1 },
      {
        type: 'QCHAT_FILE_LINK_AUTH',
        transferId: 'x',
        senderAddress: 'a',
        downloaderAddress: 'b',
        downloaderPublicKey: 'p',
        downloaderReticulumDestinationHash: 'd',
        downloaderReticulumIdentityPublicKeyBase64: 'r',
        timestamp: 1,
      },
      {
        type: 'GC_JOIN',
        roomId: 'r',
        chatId: 'c',
        fromAddress: 'a',
        fromPublicKey: 'p',
        timestamp: 1,
        reticulumDestinationHash: 'd',
        joinGeneration: 1,
      },
      {
        type: 'GC_JOIN',
        roomId: 'r',
        chatId: 'c',
        fromAddress: 'a',
        fromPublicKey: 'p',
        timestamp: 1,
        reticulumDestinationHash: 'd',
      },
      {
        type: 'GC_JOIN_RK',
        roomId: 'r',
        chatId: 'c',
        fromAddress: 'a',
        fromPublicKey: 'p',
        timestamp: 1,
        reticulumDestinationHash: 'd',
        reticulumIdentityPublicKeyBase64: 'k',
        joinGeneration: 1,
      },
      {
        type: 'GC_JOIN_RK',
        roomId: 'r',
        chatId: 'c',
        fromAddress: 'a',
        fromPublicKey: 'p',
        timestamp: 1,
        reticulumDestinationHash: 'd',
        reticulumIdentityPublicKeyBase64: 'k',
      },
      {
        type: 'GC_LEAVE',
        roomId: 'r',
        fromAddress: 'a',
        fromPublicKey: 'p',
        timestamp: 1,
      },
      {
        type: 'GC_TOPOLOGY',
        roomId: 'r',
        topologyEpoch: 1,
        rootForwarder: 'a',
        standbyForwarder: 'b',
        fromAddress: 'a',
        fromPublicKey: 'p',
        timestamp: 1,
      },
      {
        type: 'GC_CLUSTER_HEARTBEAT',
        roomId: 'r',
        topologyEpoch: 1,
        clusterForwarder: 'a',
        clusterIndex: 0,
        seq: 1,
        fromAddress: 'a',
        fromPublicKey: 'p',
        timestamp: 1,
      },
      {
        type: 'GC_KEY',
        roomId: 'r',
        toAddress: 'b',
        fromAddress: 'a',
        fromPublicKey: 'p',
        keyMessageVersion: 1,
        callSessionId: 'c',
        mediaSessionGeneration: 1,
        keyCommitment: 'k',
        encryptedKeyDigest: 'e',
        timestamp: 1,
      },
      {
        type: 'GC_KEY_REQUEST',
        roomId: 'r',
        toAddress: 'b',
        fromAddress: 'a',
        fromPublicKey: 'p',
        callSessionId: 'c',
        mediaSessionGeneration: 1,
        keyMessageVersion: 1,
        timestamp: 1,
      },
    ];
    for (const payload of payloads) {
      expectAllowed(assertAllowedPresenceSigningPayload, payload);
    }
  });

  it('allows the current untyped P2P chat event schema', () => {
    expectAllowed(assertAllowedPresenceSigningPayload, {
      authorAddress: 'a',
      authorPublicKey: 'p',
      chatId: 'c',
      content: 'hello',
      eventType: 'message',
      id: 'i',
      seq: 1,
      timestamp: 1,
    });
    expectAllowed(assertAllowedPresenceSigningPayload, {
      authorAddress: 'a',
      authorPublicKey: 'p',
      chatId: 'c',
      content: 'hello',
      eventType: 'message',
      id: 'i',
      seq: 1,
      timestamp: 1,
      replyTo: 'parent',
      attachmentMeta: { name: 'image.png', size: 10 },
      attachmentDataHash: 'hash',
    });
  });

  it('allows every current typed RCHAT control schema', () => {
    const payloads: Record<string, unknown>[] = [
      {
        type: 'QORTAL_LAND_AUTH',
        ephemeralPublicKey: 'p',
        groupId: 1,
        sessionId: 's',
        timestamp: 1,
      },
      {
        type: 'RCHAT_EVENT_NOTICE_V3',
        eventId: 'e',
        groupId: 1,
        sourcePeerHash: 'h',
        authorAddress: 'a',
        authorPublicKey: 'p',
      },
      {
        type: 'RCHAT_DM_REQ',
        peerAddress: 'b',
        after: 0,
        limit: 10,
        requestId: 'r',
        requesterPeerHash: 'h',
        timestamp: 1,
      },
      {
        type: 'RCHAT_HISTORY_PAGE_REQ',
        groupId: 1,
        channelId: 'c',
        direction: 'before',
        priority: 'm',
        after: null,
        before: { id: 'e', ts: 1 },
        includeCursor: false,
        limit: 25,
        timestamp: 1,
      },
      {
        type: 'RCHAT_HISTORY_PAGE_REQ',
        groupId: 1,
        channelId: 'c',
        direction: 'before',
        priority: undefined,
        after: null,
        before: { id: 'e', ts: 1 },
        includeCursor: false,
        limit: 25,
        timestamp: 1,
      },
      {
        type: 'RCHAT_DM_NOTIFY',
        peerAddress: 'b',
        sourcePeerHash: 'h',
        requestId: 'r',
        latestCursor: { id: 'e', ts: 1 },
        probeRequestId: null,
        maxHops: 3,
        timestamp: 1,
      },
      { type: 'RCHAT_DM_PROBE', requestId: 'r', maxHops: 3, timestamp: 1 },
      {
        type: 'RCHAT_METADATA_SNAPSHOT',
        createdAt: 1,
        groupId: 1,
        latestEventId: 'e',
        latestFeedTimestamp: 1,
        snapshotHash: 'h',
        snapshotId: 's',
        scope: 'public',
        parentSnapshotHash: '',
        version: 1,
      },
      {
        type: 'RCHAT_METADATA_SNAPSHOT_REQ',
        groupId: 1,
        snapshotHash: 'h',
        timestamp: 1,
      },
      { type: 'RCHAT_EVENT_REQ', eventId: 'e', groupId: 1, timestamp: 1 },
      {
        type: 'RCHAT_RESOURCE_AUTH',
        groupId: 1,
        timestamp: 1,
        transferId: 'x',
      },
      {
        type: 'RCHAT_GROUP_KEY_DIGEST',
        epoch: 1,
        groupId: 1,
        keyId: 'k',
        timestamp: 1,
      },
      {
        type: 'RCHAT_GROUP_KEY_REQ',
        epoch: 1,
        groupId: 1,
        keyId: 'k',
        requestId: 'r',
        timestamp: 1,
      },
      {
        type: 'RCHAT_GROUP_KEY_RES',
        epoch: 1,
        groupId: 1,
        keyBytesBase64: 'k',
        keyId: 'i',
        requestId: 'r',
        timestamp: 1,
      },
      {
        type: 'RCHAT_RESOURCE_REQ',
        eventId: null,
        fileHash: 'f',
        byteRanges: [[0, 10]],
        groupId: 1,
        timestamp: 1,
      },
      {
        type: 'RCHAT_RESOURCE_FIND',
        expiresAt: 2,
        fileHash: 'f',
        groupId: 1,
        maxHops: 3,
        requestId: 'r',
        sizeBytes: 10,
        timestamp: 1,
      },
      {
        type: 'RCHAT_DM_RESOURCE_FIND',
        conversationId: 'c',
        peerAddress: 'b',
        requestId: 'r',
        fileHash: 'f',
        sizeBytes: 10,
        maxHops: 3,
        expiresAt: 2,
        timestamp: 1,
      },
      {
        type: 'RCHAT_DM_RESOURCE_REQ',
        conversationId: 'c',
        peerAddress: 'b',
        fileHash: 'f',
        byteRanges: [[0, 10]],
        requestId: 'r',
        requesterPeerHash: 'h',
        timestamp: 1,
      },
    ];
    for (const payload of payloads) {
      expectAllowed(assertAllowedReticulumSigningPayload, payload);
    }
  });

  it('allows current group and DM event schemas', () => {
    expectAllowed(assertAllowedReticulumSigningPayload, {
      eventId: 'e',
      groupId: 1,
      channelId: 'c',
      authorStreamId: 's',
      authorSeq: 1,
      timestamp: 1,
      eventType: 'message',
      targetEventId: null,
      replyToEventId: null,
      encryptedPayload: '{}',
      payloadHash: 'h',
      mentionAddressHashes: [],
    });
    expectAllowed(assertAllowedReticulumSigningPayload, {
      eventId: 'e',
      groupId: 1,
      channelId: 'c',
      authorStreamId: 's',
      authorSeq: 1,
      timestamp: 1,
      eventType: 'message',
      targetEventId: null,
      replyToEventId: null,
      encryptedPayload: '{}',
      payloadHash: 'h',
      mentionAddressHashes: [],
      mentionTargets: [],
    });
    expectAllowed(assertAllowedReticulumSigningPayload, {
      conversationId: 'c',
      eventId: 'e',
      eventType: 'message',
      payload: '{}',
      payloadHash: 'h',
      recipientAddress: 'b',
      replyToEventId: null,
      senderSeq: 1,
      targetEventId: null,
      timestamp: 1,
    });
  });

  it('rejects unknown types, missing fields, extra fields, and unsafe values', () => {
    expect(() =>
      assertAllowedPresenceSigningPayload({ type: 'SIGN_ANYTHING', value: 'x' })
    ).toThrow();
    expect(() =>
      assertAllowedPresenceSigningPayload({ type: 'CALL_ACCEPT', callId: 'c' })
    ).toThrow();
    expect(() =>
      assertAllowedPresenceSigningPayload({
        type: 'CALL_ACCEPT',
        callId: 'c',
        timestamp: 1,
        privateKey: 'x',
      })
    ).toThrow();
    expect(() =>
      assertAllowedReticulumSigningPayload({
        type: 'RCHAT_EVENT_REQ',
        eventId: 'e',
        groupId: 1,
        timestamp: Number.NaN,
      })
    ).toThrow();
    expect(() =>
      assertAllowedReticulumSigningPayload({ arbitrary: true })
    ).toThrow();
    expect(() =>
      assertAllowedPresenceSigningPayload({
        authorAddress: 'a',
        authorPublicKey: 'p',
        chatId: 'c',
        content: 'hello',
        eventType: 'message',
        id: 'i',
        seq: 1,
        timestamp: 1,
        attachmentMeta: new Date(),
      })
    ).toThrow('unsupported value');
  });
});
