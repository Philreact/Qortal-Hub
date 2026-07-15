type SigningSchema = {
  required: readonly string[];
  optional?: readonly string[];
};

const PRESENCE_SIGNING_MAX_BYTES = 256 * 1024;
const RCHAT_SIGNING_MAX_BYTES = 4 * 1024 * 1024;

const schema = (
  required: readonly string[],
  optional: readonly string[] = []
): SigningSchema => ({ required, optional });

const presenceSchemas: Readonly<Record<string, SigningSchema>> = {
  PRESENCE_ANNOUNCE: schema([
    'type',
    'address',
    'clientVersion',
    'publicKey',
    'sessionId',
    'status',
    'timestamp',
  ]),
  PRESENCE_HEARTBEAT: schema([
    'type',
    'address',
    'publicKey',
    'sessionId',
    'status',
    'timestamp',
  ]),
  PRESENCE_OFFLINE: schema([
    'type',
    'address',
    'publicKey',
    'sessionId',
    'timestamp',
  ]),
  CALL_REQUEST: schema([
    'type',
    'callId',
    'chatId',
    'fromAddress',
    'fromPublicKey',
    'timestamp',
  ]),
  CALL_ACCEPT: schema(['type', 'callId', 'timestamp']),
  CALL_REJECT: schema(['type', 'callId', 'timestamp']),
  CALL_HANGUP: schema(['type', 'callId', 'timestamp']),
  QCHAT_FILE_LINK_AUTH: schema([
    'type',
    'transferId',
    'senderAddress',
    'downloaderAddress',
    'downloaderPublicKey',
    'downloaderReticulumDestinationHash',
    'downloaderReticulumIdentityPublicKeyBase64',
    'timestamp',
  ]),
  GC_JOIN: schema(
    [
      'type',
      'roomId',
      'chatId',
      'fromAddress',
      'fromPublicKey',
      'timestamp',
      'reticulumDestinationHash',
    ],
    ['joinGeneration']
  ),
  GC_JOIN_RK: schema(
    [
      'type',
      'roomId',
      'chatId',
      'fromAddress',
      'fromPublicKey',
      'timestamp',
      'reticulumDestinationHash',
      'reticulumIdentityPublicKeyBase64',
    ],
    ['joinGeneration']
  ),
  GC_LEAVE: schema([
    'type',
    'roomId',
    'fromAddress',
    'fromPublicKey',
    'timestamp',
  ]),
  GC_TOPOLOGY: schema([
    'type',
    'roomId',
    'topologyEpoch',
    'rootForwarder',
    'standbyForwarder',
    'fromAddress',
    'fromPublicKey',
    'timestamp',
  ]),
  GC_CLUSTER_HEARTBEAT: schema([
    'type',
    'roomId',
    'topologyEpoch',
    'clusterForwarder',
    'clusterIndex',
    'seq',
    'fromAddress',
    'fromPublicKey',
    'timestamp',
  ]),
  GC_KEY: schema([
    'type',
    'roomId',
    'toAddress',
    'fromAddress',
    'fromPublicKey',
    'keyMessageVersion',
    'callSessionId',
    'mediaSessionGeneration',
    'keyCommitment',
    'encryptedKeyDigest',
    'timestamp',
  ]),
  GC_KEY_REQUEST: schema([
    'type',
    'roomId',
    'toAddress',
    'fromAddress',
    'fromPublicKey',
    'callSessionId',
    'mediaSessionGeneration',
    'keyMessageVersion',
    'timestamp',
  ]),
};

const rchatSchemas: Readonly<Record<string, SigningSchema>> = {
  QORTAL_LAND_AUTH: schema([
    'type',
    'ephemeralPublicKey',
    'groupId',
    'sessionId',
    'timestamp',
  ]),
  RCHAT_EVENT_NOTICE_V3: schema([
    'type',
    'eventId',
    'groupId',
    'sourcePeerHash',
    'authorAddress',
    'authorPublicKey',
  ]),
  RCHAT_DM_REQ: schema([
    'type',
    'peerAddress',
    'after',
    'limit',
    'requestId',
    'requesterPeerHash',
    'timestamp',
  ]),
  RCHAT_HISTORY_PAGE_REQ: schema(
    [
      'type',
      'groupId',
      'channelId',
      'direction',
      'after',
      'before',
      'includeCursor',
      'limit',
      'timestamp',
    ],
    ['priority']
  ),
  RCHAT_DM_NOTIFY: schema([
    'type',
    'peerAddress',
    'sourcePeerHash',
    'requestId',
    'latestCursor',
    'probeRequestId',
    'maxHops',
    'timestamp',
  ]),
  RCHAT_DM_PROBE: schema(['type', 'requestId', 'maxHops', 'timestamp']),
  RCHAT_METADATA_SNAPSHOT: schema([
    'type',
    'createdAt',
    'groupId',
    'latestEventId',
    'latestFeedTimestamp',
    'snapshotHash',
    'snapshotId',
    'scope',
    'parentSnapshotHash',
    'version',
  ]),
  RCHAT_METADATA_SNAPSHOT_REQ: schema([
    'type',
    'groupId',
    'snapshotHash',
    'timestamp',
  ]),
  RCHAT_EVENT_REQ: schema(['type', 'eventId', 'groupId', 'timestamp']),
  RCHAT_RESOURCE_AUTH: schema(['type', 'groupId', 'timestamp', 'transferId']),
  RCHAT_GROUP_KEY_DIGEST: schema([
    'type',
    'epoch',
    'groupId',
    'keyId',
    'timestamp',
  ]),
  RCHAT_GROUP_KEY_REQ: schema([
    'type',
    'epoch',
    'groupId',
    'keyId',
    'requestId',
    'timestamp',
  ]),
  RCHAT_GROUP_KEY_RES: schema([
    'type',
    'epoch',
    'groupId',
    'keyBytesBase64',
    'keyId',
    'requestId',
    'timestamp',
  ]),
  RCHAT_RESOURCE_REQ: schema([
    'type',
    'eventId',
    'fileHash',
    'byteRanges',
    'groupId',
    'timestamp',
  ]),
  RCHAT_RESOURCE_FIND: schema([
    'type',
    'expiresAt',
    'fileHash',
    'groupId',
    'maxHops',
    'requestId',
    'sizeBytes',
    'timestamp',
  ]),
  RCHAT_DM_RESOURCE_FIND: schema([
    'type',
    'conversationId',
    'peerAddress',
    'requestId',
    'fileHash',
    'sizeBytes',
    'maxHops',
    'expiresAt',
    'timestamp',
  ]),
  RCHAT_DM_RESOURCE_REQ: schema([
    'type',
    'conversationId',
    'peerAddress',
    'fileHash',
    'byteRanges',
    'requestId',
    'requesterPeerHash',
    'timestamp',
  ]),
};

const p2pChatSchema = schema(
  [
    'authorAddress',
    'authorPublicKey',
    'chatId',
    'content',
    'eventType',
    'id',
    'seq',
    'timestamp',
  ],
  ['targetId', 'replyTo', 'attachmentMeta', 'attachmentDataHash']
);

const groupEventSchema = schema(
  [
    'eventId',
    'groupId',
    'channelId',
    'authorStreamId',
    'authorSeq',
    'timestamp',
    'eventType',
    'targetEventId',
    'replyToEventId',
    'encryptedPayload',
    'payloadHash',
    'mentionAddressHashes',
  ],
  ['mentionTargets']
);

const directEventSchema = schema([
  'conversationId',
  'eventId',
  'eventType',
  'payload',
  'payloadHash',
  'recipientAddress',
  'replyToEventId',
  'senderSeq',
  'targetEventId',
  'timestamp',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function matchesSchema(
  payload: Record<string, unknown>,
  candidate: SigningSchema
): boolean {
  const allowed = new Set([
    ...candidate.required,
    ...(candidate.optional ?? []),
  ]);
  const keys = Object.keys(payload);
  return (
    candidate.required.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(payload, key) &&
        payload[key] !== undefined
    ) && keys.every((key) => allowed.has(key))
  );
}

function serializedSize(payload: Record<string, unknown>): number {
  const serialized = JSON.stringify(payload);
  if (typeof serialized !== 'string')
    throw new Error('Signing payload is not serializable');
  return new TextEncoder().encode(serialized).byteLength;
}

function assertSafeObjectGraph(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error('Signing payload nesting is too deep');
  if (value == null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Signing payload contains a non-finite number');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 4_096)
      throw new Error('Signing payload array is too large');
    for (const item of value) assertSafeObjectGraph(item, depth + 1);
    return;
  }
  if (!isRecord(value))
    throw new Error('Signing payload contains an unsupported value');
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error('Signing payload contains a forbidden key');
    }
    assertSafeObjectGraph(child, depth + 1);
  }
}

function assertPayload(
  payload: unknown,
  schemas: Readonly<Record<string, SigningSchema>>,
  untypedSchemas: readonly SigningSchema[],
  maxBytes: number
): asserts payload is Record<string, unknown> {
  if (!isRecord(payload)) throw new Error('Signing payload must be an object');
  assertSafeObjectGraph(payload);
  if (serializedSize(payload) > maxBytes)
    throw new Error('Signing payload is too large');

  const type = typeof payload.type === 'string' ? payload.type : '';
  if (type) {
    const candidate = schemas[type];
    if (!candidate || !matchesSchema(payload, candidate)) {
      throw new Error(`Signing payload type is not allowed: ${type}`);
    }
    return;
  }
  if (!untypedSchemas.some((candidate) => matchesSchema(payload, candidate))) {
    throw new Error('Untyped signing payload schema is not allowed');
  }
}

export function assertAllowedPresenceSigningPayload(
  payload: unknown
): asserts payload is Record<string, unknown> {
  assertPayload(
    payload,
    presenceSchemas,
    [p2pChatSchema],
    PRESENCE_SIGNING_MAX_BYTES
  );
}

export function assertAllowedReticulumSigningPayload(
  payload: unknown
): asserts payload is Record<string, unknown> {
  assertPayload(
    payload,
    rchatSchemas,
    [groupEventSchema, directEventSchema],
    RCHAT_SIGNING_MAX_BYTES
  );
}
