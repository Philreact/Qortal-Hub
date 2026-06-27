import * as nodeCrypto from 'crypto';
import { EventEmitter } from 'events';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import nacl from 'tweetnacl';
import {
  base58Decode,
  canonicalizeForSigning,
  deriveAddressFromPublicKey,
} from './presence';
import {
  ReticulumChatDatabase,
  type ReticulumChatChannelDigest,
  type ReticulumChatFeedCursor,
  type ReticulumChatRelayCacheEntry,
  type ReticulumChatRelayDigestEntry,
  RETICULUM_CHAT_RELAY_EVENT_MAX_BYTES,
  RETICULUM_CHAT_DEFAULT_CHANNEL_ID,
  normalizeReticulumChatChannelId,
  normalizeReticulumChatCategoryId,
  reticulumChatRelayBlobId,
  type ReticulumGroupChannel,
  type ReticulumGroupCategory,
  type ReticulumGroupChatSummary,
  type ReticulumChatSearchResult,
} from './reticulum-chat-db';
import type {
  ReticulumBridge,
  ReticulumSendFailureReason,
  ReticulumSendResult,
} from './reticulum-bridge';
import { log as loggerLog, warn as loggerWarn } from './logger';
import {
  byteLengthUtf8JsonWithBridgeSender,
  RT_RETICULUM_MAX_WIRE_JSON_BYTES,
  wireFitsReticulum,
} from './reticulum-wire-size';
import {
  ReticulumResourceStore,
  type ReticulumResourceManifest,
} from './reticulum-resource-store';
import {
  RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT,
  ReticulumResourceTransferManager,
  type ReticulumResourceTransferOffer,
  type ReticulumResourceTransferProgress,
} from './reticulum-resource-transfer';

export type ReticulumChatEventType =
  | 'message'
  | 'edit'
  | 'delete'
  | 'reaction_add'
  | 'reaction_remove'
  | 'attachment_manifest'
  | 'channel_create'
  | 'channel_update'
  | 'channel_archive'
  | 'channel_restore'
  | 'channel_reorder'
  | 'category_create'
  | 'category_update'
  | 'category_delete';

export type ReticulumChatMentionTarget =
  | { type: 'here'; groupId: number; channelId: string; createdAt: number }
  | { type: 'everyone'; groupId: number }
  | { type: 'group'; groupId: number; groupName?: string }
  | { type: 'channel'; groupId: number; channelId: string; channelName?: string }
  | { type: 'user'; addressHash: string };

export interface ReticulumChatEvent {
  eventId: string;
  groupId: number;
  channelId: string;
  authorAddress: string;
  authorPublicKey: string;
  authorSeq: number;
  timestamp: number;
  eventType: ReticulumChatEventType;
  targetEventId?: string;
  replyToEventId?: string;
  encryptedPayload: string;
  payloadHash: string;
  mentionAddressHashes: string[];
  mentionTargets?: ReticulumChatMentionTarget[];
  signature: string;
}

export interface ReticulumChatEventHint {
  eventId: string;
  groupId: number;
  channelId: string;
  authorAddress: string;
  authorSeq: number;
  timestamp: number;
  eventType: ReticulumChatEventType;
  payloadHash: string;
  mentionAddressHashes: string[];
}

export interface ReticulumChatEventOffer {
  transferId: string;
  eventId: string;
  groupId: number;
  payloadHash: string;
  wireHash: string;
  sizeBytes: number;
  continuation?: {
    channelId: string;
    direction: 'after' | 'before';
    cursor: ReticulumChatFeedCursor;
  };
  sourcePeerHash?: string;
  senderReticulumDestinationHash?: string;
  senderReticulumIdentityPublicKeyBase64?: string;
  relayRequestId?: string;
  relayStore?: boolean;
  relayCached?: boolean;
  relayBlobId?: string;
}

type ReticulumChatEventOfferOptions = {
  continuation?: ReticulumChatEventOffer['continuation'];
  recipientPeerHash?: string;
  relayRequestId?: string;
  sourcePeerHash?: string;
  relayStore?: boolean;
  relayCached?: boolean;
  relayBlobId?: string;
};

export interface ReticulumChatEventOfferWire {
  x: string;
  id: string;
  ph: string;
  wh: string;
  s: number;
  fc?: string;
  fd?: 'a' | 'b';
  fid?: string;
  fts?: number;
  rr?: string;
  sp?: string;
  rs?: 1;
  rc?: 1;
  bid?: string;
}

export interface ReticulumChatEventRequestWire {
  id: string;
  a: string;
  pk: string;
  ts: number;
  sig: string;
}

export interface ReticulumChatResourceRequestWire {
  eid?: string;
  fh: string;
  r?: Array<[number, number]>;
  cf?: boolean;
  rid?: string;
  o?: string;
  pk: string;
  ts: number;
  sig: string;
}

export type ReticulumChatRelayQueryWire = {
  ids: string[];
  o?: string;
  rid?: string;
  h?: number;
};

export type ReticulumChatRelayAckWire = {
  id: string;
  ok: boolean;
  reason?: string;
  bid?: string;
};

export type ReticulumChatRelayDigestEntryWire = {
  id: string;
  ts: number;
  c: string;
  a?: string;
  seq?: number;
  ph?: string;
  bid?: string;
};

export interface ReticulumChatResourceOffer {
  transferId: string;
  groupId: number;
  eventId?: string;
  fileHash: string;
  sizeBytes: number;
  fileName: string;
  mimeType: string;
  chunkIndex?: number;
  chunkHash?: string;
  chunkSize?: number;
  bundleHash?: string;
  streamMode?: boolean;
  chunkIndexes?: number[];
  chunks?: Array<{
    index: number;
    hash: string;
    sizeBytes: number;
    offset: number;
  }>;
  sourcePeerHash?: string;
  relayRequestId?: string;
}

export interface ReticulumChatResourceOfferWire {
  x: string;
  eid?: string;
  fh: string;
  s: number;
  ci?: number;
  ch?: string;
  cs?: number;
  bh?: string;
  sm?: 1;
  br?: Array<[number, number]>;
  rr?: string;
  sp?: string;
}

type ReticulumChatPullQueueItem = {
  hint: ReticulumChatEventHint;
  peerHashes: Set<string>;
  attempts: number;
  nextAttemptAt: number;
  inFlight: boolean;
};

type ReticulumChatLocalSignature = {
  authorAddress: string;
  authorPublicKey: string;
  signature: string;
};

type ReticulumChatControlRetryItem = {
  key: string;
  wire: ReticulumChatWire;
  peerHash?: string;
  excludePeerPresenceHashes?: string[];
  attempts: number;
  nextAttemptAt: number;
};

export type ReticulumChatProtocolFeature =
  | 'digest'
  | 'digest_req'
  | 'feed_req'
  | 'range_req'
  | 'resource_v2'
  | 'relay_cache';

export type ReticulumChatDigestWire = {
  c: string;
  latest?: ReticulumChatFeedCursorWire;
  oldest?: ReticulumChatFeedCursorWire;
  wh?: string;
};

export type ReticulumChatFeedCursorWire = {
  id: string;
  ts: number;
};

export type ReticulumChatEventBatchWire = {
  start?: ReticulumChatFeedCursorWire;
  end?: ReticulumChatFeedCursorWire;
  dir: 'after' | 'before' | 'range';
  more?: boolean;
  wh: string;
  events: ReticulumChatEvent[];
};

export type ReticulumChatWire =
  | { t: 'RCHAT'; k: 'hello'; v: 1; f: ReticulumChatProtocolFeature[] }
  | { t: 'RCHAT'; k: 'group_sub'; groups: number[]; mode: 'summary' | 'active'; o?: string; h?: number }
  | { t: 'RCHAT'; k: 'unsub'; g: number }
  | { t: 'RCHAT'; k: 'event_req'; g: number; q: ReticulumChatEventRequestWire; o?: string; rid?: string; h?: number }
  | { t: 'RCHAT'; k: 'event_offer'; g: number; o: ReticulumChatEventOfferWire }
  | { t: 'RCHAT'; k: 'resource_route'; g: number; id: string; o: string; fh: string }
  | { t: 'RCHAT'; k: 'resource_req'; g: number; q: ReticulumChatResourceRequestWire }
  | { t: 'RCHAT'; k: 'resource_offer'; g: number; o: ReticulumChatResourceOfferWire }
  | {
      t: 'RCHAT';
      k: 'group_digest';
      g: number;
      latest?: ReticulumChatFeedCursorWire;
      channels: ReticulumChatDigestWire[];
      more?: boolean;
      nextOffset?: number;
      digestHash?: string;
    }
  | {
      t: 'RCHAT';
      k: 'digest_req';
      g: number;
      offset?: number;
      limit?: number;
      o?: string;
      rid?: string;
      h?: number;
    }
  | {
      t: 'RCHAT';
      k: 'feed_req';
      g: number;
      c: string;
      after?: ReticulumChatFeedCursorWire;
      before?: ReticulumChatFeedCursorWire;
      limit?: number;
      o?: string;
      rid?: string;
      h?: number;
    }
  | {
      t: 'RCHAT';
      k: 'range_req';
      g: number;
      ranges: Array<{ a: string; from: number; to: number }>;
      limit?: number;
      o?: string;
      rid?: string;
      h?: number;
    }
  | { t: 'RCHAT'; k: 'relay_query'; g: number; q: ReticulumChatRelayQueryWire }
  | { t: 'RCHAT'; k: 'relay_ack'; g: number; a: ReticulumChatRelayAckWire }
  | {
      t: 'RCHAT';
      k: 'relay_digest';
      g: number;
      events: ReticulumChatRelayDigestEntryWire[];
      more?: boolean;
      nextOffset?: number;
    }
  | {
      t: 'RCHAT';
      k: 'event_batch';
      g: number;
      c: string;
      batch: ReticulumChatEventBatchWire;
    }
  | { t: 'RCHAT'; k: 'typing'; g: number; c: string; a: string; ts: number; active: boolean };

export interface ReticulumChatManagerOptions {
  dbPath?: string;
  bridge?: ReticulumBridge | null;
  now?: () => number;
  localNotifyDebounceMs?: number;
  signLocalFields?: (
    fields: Record<string, unknown>
  ) => Promise<ReticulumChatLocalSignature | null>;
  validateGroupMember?: (groupId: number, address: string) => Promise<boolean>;
  validateGroupAdmin?: (groupId: number, address: string) => Promise<boolean>;
  resourceStore?: ReticulumResourceStore | null;
}

const RETICULUM_CHAT_MAX_FUTURE_SKEW_MS = 5 * 60_000;
const RETICULUM_CHAT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const RETICULUM_CHAT_CONTROL_MAX_AGE_MS = 2 * 60_000;
const RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS = 30_000;
const RETICULUM_CHAT_TYPING_TTL_MS = 8_000;
const RETICULUM_CHAT_TYPING_REFRESH_MS = 3_000;
const RETICULUM_CHAT_PROTOCOL_VERSION = 1;
const RETICULUM_CHAT_PROTOCOL_FEATURES: ReticulumChatProtocolFeature[] = [
  'digest',
  'digest_req',
  'feed_req',
  'range_req',
  'resource_v2',
  'relay_cache',
];
const RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS = 25;
const RETICULUM_CHAT_MAX_DIGEST_GROUPS_PER_PAGE = 20;
const RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE = 50;
const RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP = 16;
const RETICULUM_CHAT_MAX_RECENT_AUTHOR_SAMPLE = 20;
const RETICULUM_CHAT_MAX_IN_FLIGHT_PER_PEER = 4;
const RETICULUM_CHAT_MAX_IN_FLIGHT_ACTIVE = 8;
const RETICULUM_CHAT_MAX_IN_FLIGHT_BACKGROUND = 8;
const RETICULUM_CHAT_MAX_BACKGROUND_WORK_PER_TICK = 10;
const RETICULUM_CHAT_SYNC_TICK_MS = 250;
const RETICULUM_CHAT_DIGEST_DEDUPE_TTL_MS = 30_000;
const RETICULUM_CHAT_BACKGROUND_DIGEST_REFRESH_MS = 60_000;
const RETICULUM_CHAT_ACTIVE_DIGEST_REFRESH_MS = 10_000;
const RETICULUM_CHAT_PEER_VIOLATION_COOLDOWN_MS = 5 * 60_000;
const RETICULUM_CHAT_MAX_PEER_VIOLATIONS_BEFORE_COOLDOWN = 3;
const RETICULUM_CHAT_PULL_THROTTLE_MS = 15_000;
const RETICULUM_CHAT_PULL_RETRY_MS = 5_000;
const RETICULUM_CHAT_PULL_MAX_ATTEMPTS = 8;
const RETICULUM_CHAT_PULL_QUEUE_CONCURRENCY = 3;
const RETICULUM_CHAT_PULL_QUEUE_TICK_MS = 250;
const RETICULUM_CHAT_EVENT_OFFER_CONCURRENCY = 4;
const RETICULUM_CHAT_RESOURCE_TTL_MS = 10 * 60 * 1000;
const RETICULUM_CHAT_LOCAL_NOTIFY_DEBOUNCE_MS = 50;
const RETICULUM_CHAT_ALL_CHANNELS_ID = '*';
const RETICULUM_CHAT_SUBSCRIPTION_REFRESH_MS = RETICULUM_CHAT_BACKGROUND_DIGEST_REFRESH_MS;
const RETICULUM_CHAT_SUBSCRIPTION_REFRESH_JITTER_MS = 10_000;
const RETICULUM_CHAT_PEER_SUBSCRIPTION_TTL_MS = 2 * 60_000;
const RETICULUM_CHAT_SUBSCRIPTION_FANOUT_BATCH_SIZE = 8;
const RETICULUM_CHAT_SUBSCRIPTION_FANOUT_BATCH_INTERVAL_MS = 200;
const RETICULUM_CHAT_SUBSCRIPTION_FANOUT_DEDUPE_MS = 30_000;
const RETICULUM_CHAT_ACTIVE_GROUP_DIGEST_TTL_MS = 10 * 60 * 1_000;
const RETICULUM_CHAT_GROUP_REPAIR_DEBOUNCE_MS = 5_000;
const RETICULUM_CHAT_AUTHOR_GAP_REPAIR_DEBOUNCE_MS = 5_000;
const RETICULUM_CHAT_MEMBER_CACHE_TTL_MS = 15 * 60_000;
const RETICULUM_CHAT_RESOURCE_CHUNK_REQUEST_LIMIT = RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT;
const RETICULUM_CHAT_EVENT_SOURCE_PEER_TTL_MS = 2 * 60 * 60_000;
const RETICULUM_CHAT_EVENT_SOURCE_PEER_MAX_EVENTS = 10_000;
const RETICULUM_CHAT_CONTROL_DEDUP_TTL_MS = 30_000;
const RETICULUM_CHAT_CONTROL_DEDUP_MAX = 4096;
const RETICULUM_CHAT_CONTROL_RETRY_MS = 3_000;
const RETICULUM_CHAT_CONTROL_RETRY_TICK_MS = 250;
const RETICULUM_CHAT_CONTROL_RETRY_MAX_ATTEMPTS = 10;
const RETICULUM_CHAT_CONTROL_RETRY_MAX = 512;
const RETICULUM_CHAT_RELAY_REPLICATION_TARGET = 3;
const RETICULUM_CHAT_RELAY_QUERY_MAX_IDS = 16;
const RETICULUM_CHAT_RELAY_QUERY_DEBOUNCE_MS = 30_000;
const RETICULUM_CHAT_RELAY_DIGEST_PAGE_SIZE = 8;
const RETICULUM_CHAT_RELAY_DIGEST_MAX_EVENTS_PER_SUB = 64;
const RETICULUM_CHAT_RELAY_DIGEST_DEBOUNCE_MS = 30_000;
const RETICULUM_CHAT_RESOURCE_RELAY_ROUTE_TTL_MS = 2 * 60_000;
const RETICULUM_CHAT_RESOURCE_RELAY_MAX_ROUTES = 2048;
const RETICULUM_CHAT_GROUP_ROUTE_TTL_MS = 5 * 60_000;
const RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS = 8;
const RETICULUM_CHAT_GROUP_ROUTE_MAX_ROUTES = 4096;
const RETICULUM_CHAT_GROUP_ROUTE_FORWARD_DEDUPE_MS = 60_000;
const RETICULUM_CHAT_GROUP_CONTROL_RELAY_TTL_MS = 2 * 60_000;
const RETICULUM_CHAT_GROUP_CONTROL_RELAY_MAX_ROUTES = 4096;
const VALID_EVENT_TYPES = new Set<ReticulumChatEventType>([
  'message',
  'edit',
  'delete',
  'reaction_add',
  'reaction_remove',
  'attachment_manifest',
  'channel_create',
  'channel_update',
  'channel_archive',
  'channel_restore',
  'channel_reorder',
  'category_create',
  'category_update',
  'category_delete',
]);

const CHANNEL_METADATA_EVENT_TYPES = new Set<ReticulumChatEventType>([
  'channel_create',
  'channel_update',
  'channel_archive',
  'channel_restore',
  'channel_reorder',
  'category_create',
  'category_update',
  'category_delete',
]);

type ReticulumChatResourcePayload = {
  status?: string;
  transferId?: string;
  peerPresenceHash?: string;
  path?: string;
  sha256?: string;
  eventId?: string;
  groupId?: number;
  payloadHash?: string;
  wireHash?: string;
  sizeBytes?: number;
  size?: number;
  fileName?: string;
  mimeType?: string;
  fileHash?: string;
  metadata?: Record<string, unknown>;
  linkId?: string;
  auth?: Record<string, unknown>;
  reason?: string;
  canceled?: boolean;
};

type ReticulumChatEventSourcePeerRecord = {
  peers: Set<string>;
  updatedAt: number;
};

type ReticulumChatPeerViolationRecord = {
  count: number;
  lastAt: number;
  cooldownUntil: number;
};

type ReticulumChatResourceRelayRoute = {
  reversePeerHash: string;
  originPeerHash: string;
  groupId: number;
  fileHash: string;
  expiresAt: number;
};

type ReticulumChatGroupInterestRoute = {
  reversePeerHash: string;
  originPeerHash: string;
  groupId: number;
  hops: number;
  expiresAt: number;
};

type ReticulumChatEventRelayRoute = {
  reversePeerHash: string;
  originPeerHash: string;
  groupId: number;
  eventId: string;
  expiresAt: number;
};

export function buildReticulumChatSignedFields(
  event: ReticulumChatEvent
): Record<string, unknown> {
  const mentionTargets = normalizeReticulumChatMentionTargets(
    event.mentionTargets,
    event
  );
  return {
    authorAddress: event.authorAddress,
    authorPublicKey: event.authorPublicKey,
    authorSeq: event.authorSeq,
    channelId: normalizeReticulumChatChannelId(event.channelId),
    encryptedPayload: event.encryptedPayload,
    eventId: event.eventId,
    eventType: event.eventType,
    groupId: event.groupId,
    mentionAddressHashes: event.mentionAddressHashes,
    ...(mentionTargets.length > 0 ? { mentionTargets } : {}),
    payloadHash: event.payloadHash,
    replyToEventId: event.replyToEventId ?? null,
    targetEventId: event.targetEventId ?? null,
    timestamp: event.timestamp,
  };
}

export function normalizeReticulumChatMentionTargets(
  value: unknown,
  event?: Partial<Pick<ReticulumChatEvent, 'groupId' | 'channelId' | 'timestamp'>>
): ReticulumChatMentionTarget[] {
  if (!Array.isArray(value)) return [];
  const groupId = Number(event?.groupId);
  const eventChannelId = normalizeReticulumChatChannelId(event?.channelId);
  const createdAt = Number(event?.timestamp);
  const targets: ReticulumChatMentionTarget[] = [];
  const seen = new Set<string>();

  const add = (target: ReticulumChatMentionTarget) => {
    const key = JSON.stringify(target);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const target = raw as Record<string, unknown>;
    const type = typeof target.type === 'string' ? target.type : '';
    if (type === 'user') {
      const addressHash =
        typeof target.addressHash === 'string' ? target.addressHash.trim().toLowerCase() : '';
      if (/^[0-9a-f]{64}$/i.test(addressHash)) add({ type: 'user', addressHash });
      continue;
    }

    const targetGroupId = Number(target.groupId);
    if (
      !Number.isInteger(targetGroupId) ||
      targetGroupId <= 0 ||
      (Number.isInteger(groupId) && targetGroupId !== groupId)
    ) {
      continue;
    }

    if (type === 'everyone') {
      add({ type: 'everyone', groupId: targetGroupId });
      continue;
    }
    if (type === 'group') {
      const groupName =
        typeof target.groupName === 'string' ? target.groupName.trim().slice(0, 120) : '';
      add({
        type: 'group',
        groupId: targetGroupId,
        ...(groupName ? { groupName } : {}),
      });
      continue;
    }
    if (type === 'channel') {
      const channelId = normalizeReticulumChatChannelId(target.channelId);
      const channelName =
        typeof target.channelName === 'string' ? target.channelName.trim().slice(0, 120) : '';
      add({
        type: 'channel',
        groupId: targetGroupId,
        channelId,
        ...(channelName ? { channelName } : {}),
      });
      continue;
    }
    if (type === 'here') {
      const channelId = normalizeReticulumChatChannelId(target.channelId || eventChannelId);
      const targetCreatedAt = Number(target.createdAt);
      add({
        type: 'here',
        groupId: targetGroupId,
        channelId,
        createdAt: Number.isFinite(targetCreatedAt)
          ? targetCreatedAt
          : Number.isFinite(createdAt)
            ? createdAt
            : Date.now(),
      });
    }
  }

  return targets.slice(0, 32);
}

export function hashReticulumChatPayload(encryptedPayload: string): string {
  return nodeCrypto
    .createHash('sha256')
    .update(encryptedPayload, 'utf8')
    .digest('hex');
}

export function serializeReticulumChatEvent(event: ReticulumChatEvent): string {
  return JSON.stringify(event);
}

export function hashReticulumChatEventWire(event: ReticulumChatEvent): string {
  return nodeCrypto
    .createHash('sha256')
    .update(serializeReticulumChatEvent(event), 'utf8')
    .digest('hex');
}

function normalizePeerHashFromWire(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (/^[0-9a-f]{16,64}$/.test(normalized)) return normalized;
  try {
    const padded = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Buffer.from(
      `${padded}${'='.repeat((4 - (padded.length % 4)) % 4)}`,
      'base64'
    );
    if (bytes.length < 8 || bytes.length > 32) return undefined;
    return bytes.toString('hex');
  } catch {
    return undefined;
  }
}

function compactPeerHashForWire(peerHash: string): string {
  const normalized = normalizePeerHashFromWire(peerHash);
  if (!normalized) return peerHash;
  return Buffer.from(normalized, 'hex')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function buildReticulumChatEventHint(
  event: ReticulumChatEvent
): ReticulumChatEventHint {
  return {
    eventId: event.eventId,
    groupId: event.groupId,
    channelId: normalizeReticulumChatChannelId(event.channelId),
    authorAddress: event.authorAddress,
    authorSeq: event.authorSeq,
    timestamp: event.timestamp,
    eventType: event.eventType,
    payloadHash: event.payloadHash,
    mentionAddressHashes: event.mentionAddressHashes,
  };
}

function eventOfferToWire(offer: ReticulumChatEventOffer): ReticulumChatEventOfferWire {
  return {
    x: offer.transferId,
    id: offer.eventId,
    ph: offer.payloadHash,
    wh: offer.wireHash,
    s: offer.sizeBytes,
    ...(offer.continuation
      ? {
          fc: offer.continuation.channelId,
          fd: offer.continuation.direction === 'before' ? 'b' : 'a',
          fid: offer.continuation.cursor.eventId,
          fts: offer.continuation.cursor.feedTimestamp,
        }
      : {}),
    ...(offer.relayRequestId ? { rr: offer.relayRequestId } : {}),
    ...(offer.sourcePeerHash ? { sp: compactPeerHashForWire(offer.sourcePeerHash) } : {}),
    ...(offer.relayStore ? { rs: 1 as const } : {}),
    ...(offer.relayCached ? { rc: 1 as const } : {}),
  };
}

function eventOfferFromWire(groupId: number, wire: unknown): ReticulumChatEventOffer | null {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const o = wire as Partial<ReticulumChatEventOfferWire>;
  const continuation =
    typeof o.fc === 'string' &&
    (o.fd === 'a' || o.fd === 'b') &&
    typeof o.fid === 'string' &&
    Number.isFinite(Number(o.fts))
      ? {
          channelId:
            o.fc === RETICULUM_CHAT_ALL_CHANNELS_ID
              ? RETICULUM_CHAT_ALL_CHANNELS_ID
              : normalizeReticulumChatChannelId(o.fc),
          direction: o.fd === 'b' ? 'before' as const : 'after' as const,
          cursor: {
            eventId: o.fid,
            feedTimestamp: Number(o.fts),
          },
        }
      : undefined;
  return {
    transferId: String(o.x || ''),
    eventId: String(o.id || ''),
    groupId,
    payloadHash: String(o.ph || ''),
    wireHash: String(o.wh || ''),
    sizeBytes: Number(o.s || 0),
    ...(continuation ? { continuation } : {}),
    ...(typeof o.rr === 'string' && o.rr ? { relayRequestId: o.rr } : {}),
    ...(typeof o.sp === 'string' && o.sp ? { sourcePeerHash: normalizePeerHashFromWire(o.sp) ?? o.sp } : {}),
    ...(o.rs === 1 ? { relayStore: true } : {}),
    ...(o.rc === 1 ? { relayCached: true } : {}),
    ...(typeof o.bid === 'string' && /^[0-9a-f]{64}$/i.test(o.bid) ? { relayBlobId: o.bid.toLowerCase() } : {}),
  };
}

function resourceOfferToWire(offer: ReticulumChatResourceOffer): ReticulumChatResourceOfferWire {
  return {
    x: offer.transferId,
    ...(offer.eventId ? { eid: offer.eventId } : {}),
    fh: offer.fileHash,
    s: offer.sizeBytes,
    ...(Number.isInteger(offer.chunkIndex) ? { ci: offer.chunkIndex } : {}),
    ...(offer.chunkHash ? { ch: offer.chunkHash } : {}),
    ...(Number.isInteger(offer.chunkSize) ? { cs: offer.chunkSize } : {}),
    ...(offer.bundleHash ? { bh: offer.bundleHash } : {}),
    ...(offer.streamMode === true ? { sm: 1 as const } : {}),
    ...(Array.isArray(offer.chunks) && offer.chunks.length > 0
      ? {
          br: chunkIndexesToRanges(offer.chunks.map((chunk) => chunk.index)),
        }
      : {}),
    ...(offer.relayRequestId ? { rr: offer.relayRequestId } : {}),
    ...(offer.sourcePeerHash ? { sp: offer.sourcePeerHash } : {}),
  };
}

function resourceOfferFromWire(groupId: number, wire: unknown): ReticulumChatResourceOffer | null {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const o = wire as Partial<ReticulumChatResourceOfferWire>;
  return {
    transferId: String(o.x || ''),
    groupId,
    ...(typeof o.eid === 'string' && o.eid ? { eventId: o.eid } : {}),
    fileHash: String(o.fh || ''),
    sizeBytes: Number(o.s || 0),
    fileName: '',
    mimeType: '',
    ...(Number.isInteger(o.ci) ? { chunkIndex: Number(o.ci) } : {}),
    ...(typeof o.ch === 'string' && o.ch ? { chunkHash: o.ch } : {}),
    ...(Number.isInteger(o.cs) ? { chunkSize: Number(o.cs) } : {}),
    ...(typeof o.bh === 'string' && o.bh ? { bundleHash: o.bh } : {}),
    ...(o.sm === 1 ? { streamMode: true } : {}),
    ...(Array.isArray(o.br)
      ? {
          chunkIndexes: chunkRangesToIndexes(o.br) ?? [],
        }
      : {}),
    ...(typeof o.rr === 'string' && o.rr ? { relayRequestId: o.rr } : {}),
    ...(typeof o.sp === 'string' && o.sp ? { sourcePeerHash: o.sp.toLowerCase() } : {}),
  };
}

export function validateReticulumChatEventShape(
  event: unknown,
  now = Date.now()
): event is ReticulumChatEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const e = event as Partial<ReticulumChatEvent>;
  if (typeof e.eventId !== 'string' || e.eventId.length < 8) return false;
  if (!Number.isInteger(e.groupId) || (e.groupId as number) <= 0) return false;
  if (
    typeof e.channelId !== 'string' ||
    normalizeReticulumChatChannelId(e.channelId) !== e.channelId
  ) {
    return false;
  }
  if (typeof e.authorAddress !== 'string' || !e.authorAddress) return false;
  if (typeof e.authorPublicKey !== 'string' || !e.authorPublicKey) return false;
  if (!Number.isInteger(e.authorSeq) || (e.authorSeq as number) <= 0) return false;
  if (!Number.isFinite(e.timestamp)) return false;
  if ((e.timestamp as number) > now + RETICULUM_CHAT_MAX_FUTURE_SKEW_MS) return false;
  if ((e.timestamp as number) < now - RETICULUM_CHAT_MAX_AGE_MS) return false;
  if (typeof e.eventType !== 'string' || !VALID_EVENT_TYPES.has(e.eventType as ReticulumChatEventType)) return false;
  if (e.targetEventId != null && typeof e.targetEventId !== 'string') return false;
  if (e.replyToEventId != null && typeof e.replyToEventId !== 'string') return false;
  if (typeof e.encryptedPayload !== 'string' || !e.encryptedPayload) return false;
  if (typeof e.payloadHash !== 'string' || !/^[0-9a-f]{64}$/i.test(e.payloadHash)) return false;
  if (hashReticulumChatPayload(e.encryptedPayload) !== e.payloadHash.toLowerCase()) return false;
  if (
    !Array.isArray(e.mentionAddressHashes) ||
    e.mentionAddressHashes.some(
      (hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)
    )
  ) {
    return false;
  }
  if (
    e.mentionTargets != null &&
    normalizeReticulumChatMentionTargets(e.mentionTargets, e).length !==
      e.mentionTargets.length
  ) {
    return false;
  }
  if (typeof e.signature !== 'string' || !e.signature) return false;
  try {
    return deriveAddressFromPublicKey(e.authorPublicKey) === e.authorAddress;
  } catch {
    return false;
  }
}

export function buildReticulumChatEventRequestSignedFields(input: {
  groupId: number;
  eventId: string;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    eventId: input.eventId,
    groupId: input.groupId,
    timestamp: input.timestamp,
    type: 'RCHAT_EVENT_REQ',
  };
}

export function buildReticulumChatResourceRequestSignedFields(input: {
  groupId: number;
  eventId?: string;
  fileHash: string;
  chunkIndexes?: number[];
  chunkRanges?: Array<[number, number]>;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  const chunkRanges = normalizeChunkRanges(
    Array.isArray(input.chunkRanges)
      ? input.chunkRanges
      : chunkIndexesToRanges(input.chunkIndexes ?? [])
  );
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    eventId: input.eventId ?? null,
    fileHash: input.fileHash,
    groupId: input.groupId,
    chunkRanges,
    timestamp: input.timestamp,
    type: 'RCHAT_RESOURCE_REQ',
  };
}

function chunkIndexesToRanges(chunkIndexes: number[]): Array<[number, number]> {
  const sorted = [...new Set(chunkIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const index of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous[0] + previous[1] === index) {
      previous[1] += 1;
    } else {
      ranges.push([index, 1]);
    }
  }
  return ranges;
}

function normalizeChunkRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const indexes = chunkRangesToIndexes(ranges);
  if (!indexes) return [];
  return chunkIndexesToRanges(indexes);
}

function chunkRangesToIndexes(ranges: unknown): number[] | null {
  if (!Array.isArray(ranges)) return null;
  const indexes: number[] = [];
  for (const range of ranges) {
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !Number.isInteger(range[0]) ||
      !Number.isInteger(range[1]) ||
      range[0] < 0 ||
      range[1] <= 0
    ) {
      return null;
    }
    if (indexes.length + range[1] > RETICULUM_CHAT_RESOURCE_CHUNK_REQUEST_LIMIT) {
      return null;
    }
    for (let offset = 0; offset < range[1]; offset += 1) {
      indexes.push(range[0] + offset);
    }
  }
  if (new Set(indexes).size !== indexes.length) return null;
  return indexes;
}

export function verifyReticulumChatEvent(event: ReticulumChatEvent): boolean {
  try {
    const derived = deriveAddressFromPublicKey(event.authorPublicKey);
    if (derived !== event.authorAddress) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(buildReticulumChatSignedFields(event))
      ),
      new Uint8Array(base58Decode(event.signature)),
      new Uint8Array(base58Decode(event.authorPublicKey))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumChatEventRequest(
  groupId: number,
  request: ReticulumChatEventRequestWire,
  now = Date.now()
): boolean {
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    if (typeof request.id !== 'string' || request.id.length < 8) return false;
    if (typeof request.a !== 'string' || !request.a) return false;
    if (typeof request.pk !== 'string' || !request.pk) return false;
    if (typeof request.sig !== 'string' || !request.sig) return false;
    if (!Number.isFinite(request.ts)) return false;
    if (request.ts - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
    if (now - request.ts > RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return false;
    const derived = deriveAddressFromPublicKey(request.pk);
    if (derived !== request.a) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumChatEventRequestSignedFields({
            groupId,
            eventId: request.id,
            authorAddress: request.a,
            authorPublicKey: request.pk,
            timestamp: request.ts,
          })
        )
      ),
      new Uint8Array(base58Decode(request.sig)),
      new Uint8Array(base58Decode(request.pk))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumChatResourceRequest(
  groupId: number,
  request: ReticulumChatResourceRequestWire,
  now = Date.now()
): boolean {
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    if (request.eid != null && (typeof request.eid !== 'string' || request.eid.length < 8)) return false;
    if (typeof request.fh !== 'string' || !/^[0-9a-f]{64}$/i.test(request.fh)) return false;
    const chunkIndexes = chunkRangesToIndexes(request.r ?? []);
    if (!chunkIndexes) return false;
    if (typeof request.pk !== 'string' || !request.pk) return false;
    if (typeof request.sig !== 'string' || !request.sig) return false;
    if (!Number.isFinite(request.ts)) return false;
    if (request.ts - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
    if (now - request.ts > RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return false;
    const derived = deriveAddressFromPublicKey(request.pk);
    if (!derived) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumChatResourceRequestSignedFields({
            groupId,
            eventId: request.eid,
            fileHash: request.fh,
            chunkIndexes,
            authorAddress: derived,
            authorPublicKey: request.pk,
            timestamp: request.ts,
          })
        )
      ),
      new Uint8Array(base58Decode(request.sig)),
      new Uint8Array(base58Decode(request.pk))
    );
  } catch {
    return false;
  }
}

function defaultReticulumChatDbPath(): string {
  return path.join(app.getPath('appData'), 'qortal-shared', 'reticulum-chat.db');
}

export class ReticulumChatManager extends EventEmitter {
  private readonly db: ReticulumChatDatabase;
  private readonly now: () => number;
  private readonly dbPath: string;
  private readonly localNotifyDir: string;
  private readonly localNotifyDebounceMs: number;
  private signLocalFields?: (
    fields: Record<string, unknown>
  ) => Promise<ReticulumChatLocalSignature | null>;
  private validateGroupMember?: (groupId: number, address: string) => Promise<boolean>;
  private validateGroupAdmin?: (groupId: number, address: string) => Promise<boolean>;
  private resourceStore: ReticulumResourceStore | null;
  private bridge: ReticulumBridge | null;
  private resourceTransfer: ReticulumResourceTransferManager<ReticulumChatResourceRequestWire> | null = null;
  private localGroupIds = new Set<number>();
  private subscribedGroups = new Set<number>();
  private peerSubscriptions = new Map<string, Map<number, number>>();
  private groupMemberValidationCache = new Map<string, { isMember: boolean; expiresAt: number }>();
  private groupAdminValidationCache = new Map<string, { isAdmin: boolean; expiresAt: number }>();
  private requestedEventPulls = new Map<string, number>();
  private pendingEventPulls = new Map<string, ReticulumChatPullQueueItem>();
  private outboundRelayCachedEventResources = new Map<
    string,
    { groupId: number; eventId: string; expiresAt: number }
  >();
  private eventPullQueueTimer: ReturnType<typeof setTimeout> | null = null;
  private controlRetryQueue = new Map<string, ReticulumChatControlRetryItem>();
  private controlRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private controlRetryActive = false;
  private subscriptionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionFanoutQueue: ReticulumChatWire[] = [];
  private subscriptionFanoutQueuedKeys = new Set<string>();
  private subscriptionFanoutLastSentAt = new Map<string, number>();
  private subscriptionFanoutTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionFanoutSentInBatch = 0;
  private subscriptionDigestRefreshOffset = 0;
  private eventPullQueueActive = false;
  private recentGroupRepairRequests = new Map<string, number>();
  private recentAuthorGapRepairRequests = new Map<string, number>();
  private resourceOffers = new Map<string, ReticulumChatEventOffer>();
  private eventSourcePeers = new Map<string, ReticulumChatEventSourcePeerRecord>();
  private lastTypingSentAt = new Map<string, number>();
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private observedDbEventIds = new Set<string>();
  private activeDigestGroups = new Map<number, number>();
  private activeChannelSubscriptions = new Map<number, Set<string>>();
  private recentInboundControlWires = new Map<string, number>();
  private recentServedSyncRequests = new Map<string, number>();
  private recentRelayQueries = new Map<string, number>();
  private recentRelayDigestsServed = new Map<string, number>();
  private lastRelayNoPeersLogAt = 0;
  private peerProtocolViolations = new Map<string, ReticulumChatPeerViolationRecord>();
  private resourceRelayRoutes = new Map<string, ReticulumChatResourceRelayRoute>();
  private localResourceRequestIds = new Map<string, number>();
  private forwardedResourceRequestIds = new Map<string, number>();
  private groupInterestRoutes = new Map<string, ReticulumChatGroupInterestRoute>();
  private forwardedGroupSubKeys = new Map<string, number>();
  private forwardedGroupControlKeys = new Map<string, number>();
  private eventRelayRoutes = new Map<string, ReticulumChatEventRelayRoute>();
  private localNotifyWatcher: fs.FSWatcher | null = null;
  private localNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  private localNotifyScanInterval: ReturnType<typeof setInterval> | null = null;
  private seenLocalNotifyFiles = new Set<string>();

  constructor(options: ReticulumChatManagerOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.dbPath = options.dbPath ?? defaultReticulumChatDbPath();
    this.localNotifyDir = path.join(path.dirname(this.dbPath), 'reticulum-chat-notify');
    this.localNotifyDebounceMs = Math.max(
      10,
      options.localNotifyDebounceMs ?? RETICULUM_CHAT_LOCAL_NOTIFY_DEBOUNCE_MS
    );
    this.signLocalFields = options.signLocalFields;
    this.validateGroupMember = options.validateGroupMember;
    this.validateGroupAdmin = options.validateGroupAdmin;
    this.resourceStore = options.resourceStore ?? null;
    this.bridge = options.bridge ?? null;
    this.db = new ReticulumChatDatabase(this.dbPath);
    this.resourceTransfer = this.createResourceTransfer();
    fs.mkdirSync(this.localNotifyDir, { recursive: true });
    this.attachBridge(this.bridge);
    this.restorePersistedGroupSubscriptions();
  }

  setBridge(bridge: ReticulumBridge | null): void {
    if (this.bridge === bridge) return;
    this.detachBridge();
    this.bridge = bridge;
    this.resourceTransfer?.setBridge(bridge);
    this.attachBridge(bridge);
  }

  private createResourceTransfer(): ReticulumResourceTransferManager<ReticulumChatResourceRequestWire> | null {
    if (!this.resourceStore) return null;
    return new ReticulumResourceTransferManager<ReticulumChatResourceRequestWire>({
      bridge: this.bridge,
      resourceStore: this.resourceStore,
      now: this.now,
      loggerPrefix: 'ReticulumChatResourceTransfer',
      resourceType: 'reticulum_group_resource',
      chunkResourceType: 'reticulum_group_resource_chunk',
      authMessageType: 'RETICULUM_GROUP_RESOURCE_AUTH',
      contextMetadataKey: 'groupId',
      buildRequestPayloads: async (state, chunkIndexes) =>
        this.buildSignedResourceRequestBatches(
          state.contextId,
          state.manifest,
          state.eventId,
          chunkIndexes
        ),
      sendRequestToPeer: (peerHash, groupId, request) =>
        this.sendResourceRequestToPeer(peerHash, groupId, request),
      fanoutRequest: (groupId, request) =>
        this.fanoutResourceRequest(groupId, request),
      sendOfferToPeer: (peerHash, groupId, offer) =>
        this.sendToPeer(peerHash, {
          t: 'RCHAT',
          k: 'resource_offer',
          g: groupId,
          o: resourceOfferToWire({
            ...this.resourceTransferOfferToChatOffer(offer),
            sourcePeerHash:
              this.normalizeResourcePeerHash(offer.sourcePeerHash) ??
              this.getLocalResourcePeerHash(),
          }),
        }),
      canServeRequest: async (groupId, request, manifest) => {
        if (!this.localGroupIds.has(groupId)) return false;
        if (manifest.fileHash.toLowerCase() !== request.fileHash.toLowerCase()) return false;
        if (request.eventId) {
          const event = this.db.getEvent(request.eventId);
          if (!event || event.groupId !== groupId) return false;
        }
        if (request.requesterAddress) {
          const requesterIsMember = await this.isValidatedGroupMember(
            groupId,
            request.requesterAddress
          );
          if (!requesterIsMember) {
            loggerWarn(
              `[ReticulumChat] Refusing resource ${request.fileHash}: requester is not a group member`
            );
            return false;
          }
        }
        return true;
      },
      canAcceptOffer: (groupId, offer, manifest) =>
        this.subscribedGroups.has(groupId) &&
        this.localGroupIds.has(groupId) &&
        this.resourceManifestBelongsToGroup(manifest, groupId),
      onProgress: (progress) => this.emitResourceTransferProgress(progress),
    });
  }

  private resourceTransferOfferToChatOffer(
    offer: ReticulumResourceTransferOffer
  ): ReticulumChatResourceOffer {
    return {
      transferId: offer.transferId,
      groupId: offer.contextId,
      ...(offer.eventId ? { eventId: offer.eventId } : {}),
      fileHash: offer.fileHash,
      sizeBytes: offer.sizeBytes,
      fileName: offer.fileName,
      mimeType: offer.mimeType,
      ...(offer.chunkIndex != null ? { chunkIndex: offer.chunkIndex } : {}),
      ...(offer.chunkHash ? { chunkHash: offer.chunkHash } : {}),
      ...(offer.chunkSize != null ? { chunkSize: offer.chunkSize } : {}),
      ...(offer.bundleHash ? { bundleHash: offer.bundleHash } : {}),
      ...(offer.streamMode === true ? { streamMode: true } : {}),
      ...(offer.chunkIndexes ? { chunkIndexes: offer.chunkIndexes } : {}),
      ...(offer.chunks ? { chunks: offer.chunks } : {}),
      ...(offer.sourcePeerHash ? { sourcePeerHash: offer.sourcePeerHash } : {}),
      ...(offer.relayRequestId ? { relayRequestId: offer.relayRequestId } : {}),
    };
  }

  private chatOfferToResourceTransferOffer(
    offer: ReticulumChatResourceOffer
  ): ReticulumResourceTransferOffer {
    return {
      transferId: offer.transferId,
      contextId: offer.groupId,
      ...(offer.eventId ? { eventId: offer.eventId } : {}),
      fileHash: offer.fileHash,
      sizeBytes: offer.sizeBytes,
      fileName: offer.fileName,
      mimeType: offer.mimeType,
      ...(offer.chunkIndex != null ? { chunkIndex: offer.chunkIndex } : {}),
      ...(offer.chunkHash ? { chunkHash: offer.chunkHash } : {}),
      ...(offer.chunkSize != null ? { chunkSize: offer.chunkSize } : {}),
      ...(offer.bundleHash ? { bundleHash: offer.bundleHash } : {}),
      ...(offer.streamMode === true ? { streamMode: true } : {}),
      ...(offer.chunkIndexes ? { chunkIndexes: offer.chunkIndexes } : {}),
      ...(offer.chunks ? { chunks: offer.chunks } : {}),
      ...(offer.sourcePeerHash ? { sourcePeerHash: offer.sourcePeerHash } : {}),
      ...(offer.relayRequestId ? { relayRequestId: offer.relayRequestId } : {}),
    };
  }

  private emitResourceTransferProgress(progress: ReticulumResourceTransferProgress): void {
    this.emit('resource', {
      groupId: progress.contextId,
      eventId: progress.eventId,
      fileHash: progress.fileHash,
      chunkIndex: progress.chunkIndex,
      completedChunks: progress.completedChunks,
      totalChunks: progress.totalChunks,
      fullFileTransfer: progress.fullFileTransfer,
      bytesTransferred: progress.bytesTransferred,
      totalBytes: progress.totalBytes,
      progress: progress.progress,
      complete: progress.complete,
      failed: progress.failed,
      canceled: progress.canceled,
    });
  }

  setRuntimeCallbacks(
    options: Pick<ReticulumChatManagerOptions, 'signLocalFields' | 'validateGroupMember' | 'validateGroupAdmin' | 'resourceStore'>
  ): void {
    this.signLocalFields = options.signLocalFields;
    this.validateGroupMember = options.validateGroupMember;
    this.validateGroupAdmin = options.validateGroupAdmin;
    if ('resourceStore' in options) {
      this.resourceStore = options.resourceStore ?? null;
      this.resourceTransfer?.close();
      this.resourceTransfer = this.createResourceTransfer();
    }
    this.groupMemberValidationCache.clear();
    this.groupAdminValidationCache.clear();
  }

  close(): void {
    this.detachBridge();
    this.stopLocalNotificationWatcher();
    this.stopSubscriptionRefreshTimer();
    this.clearSubscriptionFanoutQueue();
    if (this.eventPullQueueTimer) {
      clearTimeout(this.eventPullQueueTimer);
      this.eventPullQueueTimer = null;
    }
    if (this.controlRetryTimer) {
      clearTimeout(this.controlRetryTimer);
      this.controlRetryTimer = null;
    }
    this.controlRetryQueue.clear();
    this.resourceRelayRoutes.clear();
    this.localResourceRequestIds.clear();
    this.forwardedResourceRequestIds.clear();
    this.groupInterestRoutes.clear();
    this.forwardedGroupSubKeys.clear();
    this.forwardedGroupControlKeys.clear();
    this.eventRelayRoutes.clear();
    this.resourceTransfer?.close();
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
    this.db.close();
  }

  setLocalGroupMemberships(groupIds: number[]): void {
    const nextGroupIds = groupIds.filter((id) => Number.isInteger(id) && id > 0);
    this.localGroupIds = new Set(nextGroupIds);
    for (const groupId of this.getSubscriptions()) {
      if (this.localGroupIds.has(groupId)) continue;
      this.subscribedGroups.delete(groupId);
      this.activeChannelSubscriptions.delete(groupId);
      this.removeQueuedSubscriptionFanouts(groupId);
      void this.fanout({ t: 'RCHAT', k: 'unsub', g: groupId });
    }
    if (this.subscribedGroups.size === 0) {
      this.stopSubscriptionRefreshTimer();
      this.clearSubscriptionFanoutQueue();
    }
    for (const groupId of nextGroupIds) {
      const [latestEvent] = this.db.getRecentEvents(groupId, 1, null);
      if (latestEvent) {
        this.emitSummaryChanged(groupId, latestEvent);
      }
    }
  }

  getSubscriptions(): number[] {
    return [...this.subscribedGroups].sort((a, b) => a - b);
  }

  private restorePersistedGroupSubscriptions(): void {
    const groupIds = this.db.getKnownGroupIds();
    if (groupIds.length === 0) return;
    for (const groupId of groupIds) {
      this.localGroupIds.add(groupId);
      this.subscribedGroups.add(groupId);
    }
    this.startLocalNotificationWatcher();
    this.startSubscriptionRefreshTimer();
    this.enqueueSubscriptionFanouts([this.buildHelloWire()]);
    this.refreshSubscriptions();
  }

  subscribeGroup(groupId: number): void {
    this.assertGroupId(groupId);
    const alreadySubscribed = this.ensureGroupSubscribed(groupId);
    if (!alreadySubscribed) this.announceGroupSubscription(groupId);
  }

  private ensureGroupSubscribed(groupId: number): boolean {
    this.assertGroupId(groupId);
    const alreadySubscribed = this.subscribedGroups.has(groupId);
    if (!this.localGroupIds.has(groupId)) {
      loggerWarn(
        `[ReticulumChat] Subscribing group=${groupId} before membership sync completed; adding local group hint`
      );
      this.localGroupIds.add(groupId);
    }
    this.markGroupHistoryObserved(groupId);
    this.subscribedGroups.add(groupId);
    this.startLocalNotificationWatcher();
    this.startSubscriptionRefreshTimer();
    return alreadySubscribed;
  }

  reannounceSubscriptions(): void {
    if (this.subscribedGroups.size === 0) return;
    this.enqueueSubscriptionFanouts([this.buildHelloWire()]);
    this.refreshSubscriptions();
  }

  private announceGroupSubscription(groupId: number): void {
    this.enqueueSubscriptionFanouts([
      this.buildHelloWire(),
      { t: 'RCHAT', k: 'group_sub', groups: [groupId], mode: 'summary' },
      this.buildGroupDigestWire(groupId),
    ]);
  }

  private announceActiveGroupSubscription(groupId: number): void {
    if (!this.subscribedGroups.has(groupId) || !this.localGroupIds.has(groupId)) return;
    this.enqueueSubscriptionFanouts([
      { t: 'RCHAT', k: 'group_sub', groups: [groupId], mode: 'active' },
      this.buildGroupDigestWire(groupId, 0, RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP),
    ]);
  }

  unsubscribeGroup(groupId: number): void {
    this.assertGroupId(groupId);
    this.subscribedGroups.delete(groupId);
    this.activeChannelSubscriptions.delete(groupId);
    this.removeQueuedSubscriptionFanouts(groupId);
    if (this.subscribedGroups.size === 0) {
      this.stopLocalNotificationWatcher();
      this.stopSubscriptionRefreshTimer();
      this.clearSubscriptionFanoutQueue();
    }
    void this.fanout({ t: 'RCHAT', k: 'unsub', g: groupId });
  }

  subscribeChannel(groupId: number, channelId: string): void {
    this.assertGroupId(groupId);
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const channel = this.db.getChannel(groupId, normalizedChannelId);
    if (!channel || channel.archived) return;
    this.ensureGroupSubscribed(groupId);
    const activeChannels = this.activeChannelSubscriptions.get(groupId) ?? new Set<string>();
    const alreadyActive = activeChannels.has(normalizedChannelId);
    activeChannels.add(normalizedChannelId);
    this.activeChannelSubscriptions.set(groupId, activeChannels);
    if (!alreadyActive) this.announceActiveGroupSubscription(groupId);
  }

  unsubscribeChannel(groupId: number, channelId: string): void {
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const activeChannels = this.activeChannelSubscriptions.get(groupId);
    if (!activeChannels) return;
    activeChannels.delete(normalizedChannelId);
    if (activeChannels.size === 0) this.activeChannelSubscriptions.delete(groupId);
  }

  async publishEvent(event: ReticulumChatEvent): Promise<ReticulumSendResult> {
    if (!Number.isInteger(event?.groupId) || event.groupId <= 0) {
      return {
        ok: false,
        reason: 'send-command-failed',
        error: 'Cannot publish Reticulum chat event: invalid group id',
      };
    }
    const channelId = normalizeReticulumChatChannelId(event.channelId);
    if (!CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) {
      const channel = this.db.getChannel(event.groupId, channelId);
      if (!channel || channel.archived) {
        return {
          ok: false,
          reason: 'send-command-failed',
          error: 'Cannot publish Reticulum chat event to an archived or unknown channel',
        };
      }
    }
    const authorIsMember = await this.isValidatedGroupMember(
      event.groupId,
      typeof event?.authorAddress === 'string' ? event.authorAddress : ''
    );
    if (!authorIsMember) {
      return {
        ok: false,
        reason: 'send-command-failed',
        error: 'Cannot publish Reticulum chat event: author is not a current group member',
      };
    }
    this.localGroupIds.add(event.groupId);
    const accepted = this.acceptEvent(event, true);
    if (!accepted) {
      return { ok: false, reason: 'send-command-failed', error: 'Invalid event' };
    }
    const fanoutResult = await this.fanoutPublishedEvent(event, channelId);
    if (!fanoutResult.ok) {
      const failed = fanoutResult as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[ReticulumChat] Stored event ${event.eventId} locally, but live event delivery failed:`,
        failed.error ?? failed.reason
      );
    }
    void this.replicateEventToRelayCache(event);
    return { ok: true };
  }

  sendTyping(
    groupId: number,
    channelId: string,
    authorAddress: string,
    active: boolean
  ): void {
    this.assertLocalGroupMember(groupId);
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const key = `${groupId}:${normalizedChannelId}:${authorAddress}`;
    const now = this.now();
    if (active && now - (this.lastTypingSentAt.get(key) ?? 0) < RETICULUM_CHAT_TYPING_REFRESH_MS) {
      return;
    }
    this.lastTypingSentAt.set(key, now);
    void this.fanout({
      t: 'RCHAT',
      k: 'typing',
      g: groupId,
      c: normalizedChannelId,
      a: authorAddress,
      ts: now,
      active,
    });
  }

  async requestResource(
    groupId: number,
    manifest: ReticulumResourceManifest,
    eventId?: string
  ): Promise<ReticulumSendResult> {
    this.assertGroupId(groupId);
    if (!this.resourceStore) {
      return { ok: false, reason: 'send-command-failed', error: 'Resource store unavailable' };
    }
    if (!this.resourceTransfer) {
      return { ok: false, reason: 'send-command-failed', error: 'Resource transfer unavailable' };
    }
    if (!this.isValidReticulumResourceManifest(manifest)) {
      return { ok: false, reason: 'send-command-failed', error: 'Invalid resource manifest' };
    }
    if (!this.resourceManifestBelongsToGroup(manifest, groupId)) {
      return { ok: false, reason: 'send-command-failed', error: 'Resource is not for this group' };
    }
    const candidatePeers = this.getResourceRequestPeers(groupId, eventId);
    this.resourceTransfer.requestResource({
      contextId: groupId,
      manifest,
      eventId,
      candidatePeers,
    });
    return { ok: true };
  }

  cancelResource(fileHash: string): boolean {
    return this.resourceTransfer?.cancelResource(fileHash) ?? false;
  }

  getResourceDownloadStatus(fileHash: string) {
    return this.resourceTransfer?.getDownloadStatus(fileHash) ?? null;
  }

  getHistory(
    groupId: number,
    channelIdOrLimit: string | number = RETICULUM_CHAT_DEFAULT_CHANNEL_ID,
    limitMaybe = 100
  ): ReticulumChatEvent[] {
    this.assertGroupId(groupId);
    const channelId =
      typeof channelIdOrLimit === 'string'
        ? channelIdOrLimit
        : null;
    const limit = typeof channelIdOrLimit === 'number' ? channelIdOrLimit : limitMaybe;
    return this.db.getRecentEvents(
      groupId,
      Math.max(1, Math.min(500, limit)),
      channelId
    );
  }

  getChannelMetadataHistory(groupId: number, limit = 200): ReticulumChatEvent[] {
    this.assertGroupId(groupId);
    return this.db.getChannelMetadataEvents(groupId, Math.max(1, Math.min(500, limit)));
  }

  getSyncState(groupId: number): Record<string, number> {
    this.assertGroupId(groupId);
    return this.db.getSyncState(groupId);
  }

  getChatSummaries(myAddress = '', onlineSince = 0): ReticulumGroupChatSummary[] {
    return this.db.getChatSummaries(myAddress, onlineSince);
  }

  searchEvents(
    query: string,
    options: { groupIds?: number[]; channelIds?: string[]; limit?: number } = {}
  ): ReticulumChatSearchResult[] {
    return this.db.searchEvents(query, options);
  }

  indexSearchText(eventId: string, text: string): boolean {
    return this.db.indexSearchText(eventId, text);
  }

  deleteSearchText(eventId: string): boolean {
    return this.db.deleteSearchText(eventId);
  }

  replaceMentionsForEvent(
    eventId: string,
    mentionedAddresses: string[]
  ): boolean {
    const event = this.db.getEvent(eventId);
    const replaced = this.db.replaceMentionsForEvent(eventId, mentionedAddresses);
    if (replaced && event) this.emitSummaryChanged(event.groupId, event);
    return replaced;
  }

  deleteMentionsForEvent(eventId: string): boolean {
    const event = this.db.getEvent(eventId);
    const deleted = this.db.deleteMentionsForEvent(eventId);
    if (deleted && event) this.emitSummaryChanged(event.groupId, event);
    return deleted;
  }

  markRead(
    groupId: number,
    channelId: string,
    upToTimestamp: number,
    myAddress = ''
  ): void {
    this.assertGroupId(groupId);
    this.db.markRead(groupId, channelId, upToTimestamp, myAddress);
    this.emitSummaryChanged(groupId);
  }

  private peerKey(peerPresenceHash: string, senderDestinationHash = ''): string {
    return (peerPresenceHash || senderDestinationHash).trim().toLowerCase();
  }

  private localPeerHash(): string | undefined {
    return normalizePeerHashFromWire(this.bridge?.getLocalDestinationHash?.());
  }

  private routePeerHash(value: unknown): string | undefined {
    const normalized = normalizePeerHashFromWire(value);
    if (normalized) return normalized;
    if (typeof value !== 'string') return undefined;
    const fallback = value.trim().toLowerCase();
    return /^[a-z0-9._:-]{1,128}$/.test(fallback) ? fallback : undefined;
  }

  private compactRoutePeerHash(peerHash: string): string {
    return compactPeerHashForWire(peerHash);
  }

  private groupInterestRouteKey(groupId: number, originPeerHash: string): string {
    return `${groupId}:${originPeerHash.trim().toLowerCase()}`;
  }

  private groupControlRouteKey(
    kind: string,
    groupId: number,
    originPeerHash: string,
    payloadKey: string
  ): string {
    return `${kind}:${groupId}:${originPeerHash.trim().toLowerCase()}:${payloadKey}`;
  }

  private normalizeGroupControlRequestId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    return /^[0-9a-f]{8,64}$/.test(normalized) ? normalized : undefined;
  }

  private groupControlRequestId(
    kind: string,
    groupId: number,
    originPeerHash: string,
    payloadKey: string
  ): string {
    return nodeCrypto
      .createHash('sha256')
      .update(`${kind}:${groupId}:${originPeerHash.trim().toLowerCase()}:${payloadKey}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
  }

  private eventRelayRequestId(
    groupId: number,
    eventId: string,
    originPeerHash: string
  ): string {
    return nodeCrypto
      .createHash('sha256')
      .update(`${groupId}:${eventId}:${originPeerHash.trim().toLowerCase()}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
  }

  private pruneGroupInterestRoutes(now = this.now()): void {
    for (const [key, route] of this.groupInterestRoutes) {
      if (route.expiresAt <= now) this.groupInterestRoutes.delete(key);
    }
    for (const [key, expiresAt] of this.forwardedGroupSubKeys) {
      if (expiresAt <= now) this.forwardedGroupSubKeys.delete(key);
    }
    if (this.groupInterestRoutes.size > RETICULUM_CHAT_GROUP_ROUTE_MAX_ROUTES) {
      const excess = this.groupInterestRoutes.size - RETICULUM_CHAT_GROUP_ROUTE_MAX_ROUTES;
      const oldest = [...this.groupInterestRoutes.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, excess);
      for (const [key] of oldest) this.groupInterestRoutes.delete(key);
    }
  }

  private pruneGroupControlRoutes(now = this.now()): void {
    for (const [key, expiresAt] of this.forwardedGroupControlKeys) {
      if (expiresAt <= now) this.forwardedGroupControlKeys.delete(key);
    }
    for (const [key, route] of this.eventRelayRoutes) {
      if (route.expiresAt <= now) this.eventRelayRoutes.delete(key);
    }
    if (this.eventRelayRoutes.size > RETICULUM_CHAT_GROUP_CONTROL_RELAY_MAX_ROUTES) {
      const excess = this.eventRelayRoutes.size - RETICULUM_CHAT_GROUP_CONTROL_RELAY_MAX_ROUTES;
      const oldest = [...this.eventRelayRoutes.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, excess);
      for (const [key] of oldest) this.eventRelayRoutes.delete(key);
    }
  }

  private compactRecentMap(map: Map<string, number>, ttlMs: number, maxEntries: number): void {
    const now = this.now();
    for (const [key, timestamp] of map) {
      if (now - timestamp > ttlMs) map.delete(key);
    }
    while (map.size > maxEntries) {
      const oldestKey = map.keys().next().value as string | undefined;
      if (!oldestKey) break;
      map.delete(oldestKey);
    }
  }

  private markRecentOrDuplicate(
    map: Map<string, number>,
    key: string,
    ttlMs: number,
    maxEntries: number
  ): boolean {
    const now = this.now();
    const lastSeenAt = map.get(key);
    if (lastSeenAt != null && now - lastSeenAt <= ttlMs) {
      return true;
    }
    map.set(key, now);
    if (map.size > maxEntries) this.compactRecentMap(map, ttlMs, maxEntries);
    return false;
  }

  private hashControlPayload(value: unknown): string {
    return nodeCrypto
      .createHash('sha256')
      .update(JSON.stringify(value) ?? '', 'utf8')
      .digest('hex')
      .slice(0, 24);
  }

  private shouldDropDuplicateInboundControlWire(
    wire: Record<string, unknown>,
    groupId: number,
    peerHash: string
  ): boolean {
    if (!peerHash) return false;
    const kind = typeof wire.k === 'string' ? wire.k : '';
    if (
      kind !== 'group_digest' &&
      kind !== 'digest_req' &&
      kind !== 'group_sub' &&
      kind !== 'relay_digest' &&
      kind !== 'feed_req' &&
      kind !== 'range_req' &&
      kind !== 'event_batch'
    ) {
      return false;
    }
    const key = `${peerHash}:${groupId}:${kind}:${this.hashControlPayload(wire)}`;
    return this.markRecentOrDuplicate(
      this.recentInboundControlWires,
      key,
      RETICULUM_CHAT_CONTROL_DEDUP_TTL_MS,
      RETICULUM_CHAT_CONTROL_DEDUP_MAX
    );
  }

  private shouldServeControlRequest(
    wire: Record<string, unknown>,
    groupId: number,
    peerHash: string
  ): boolean {
    if (!peerHash) return true;
    const key = `${peerHash}:${groupId}:${String(wire.k || '')}:${this.hashControlPayload(wire)}`;
    return !this.markRecentOrDuplicate(
      this.recentServedSyncRequests,
      key,
      RETICULUM_CHAT_DIGEST_DEDUPE_TTL_MS,
      RETICULUM_CHAT_CONTROL_DEDUP_MAX
    );
  }

  handleWire(
    wire: Record<string, unknown>,
    peerPresenceHash = '',
    senderDestinationHash = ''
  ): void {
    if (wire.t !== 'RCHAT' || typeof wire.k !== 'string') return;
    const peerHash = this.peerKey(peerPresenceHash, senderDestinationHash);
    if (this.isPeerProtocolCooledDown(peerHash)) return;

    switch (wire.k) {
      case 'hello':
        if (!this.isCompatibleHello(wire)) {
          this.notePeerViolation(peerHash, 'bad_hello');
        }
        return;
      case 'group_sub':
        this.handleGroupSub(wire, peerHash);
        return;
      case 'unsub':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.notePeerSubscription(peerHash, groupId, false);
        return;
      }
      case 'event_req':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleEventResourceRequest(
          groupId,
          wire,
          peerHash
        );
        return;
      }
      case 'event_offer':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleEventOffer(eventOfferFromWire(groupId, wire.o), peerHash);
        return;
      }
      case 'relay_query':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleRelayQuery(groupId, wire, peerHash);
        return;
      }
      case 'relay_ack':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleRelayAck(groupId, wire.a, peerHash);
        return;
      }
      case 'relay_digest':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleRelayDigest(groupId, wire, peerHash);
        return;
      }
      case 'resource_route':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleResourceRoute(groupId, wire, peerHash);
        return;
      }
      case 'resource_req':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleGenericResourceRequest(
          groupId,
          wire.q,
          peerHash
        );
        return;
      }
      case 'resource_offer':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleGenericResourceOffer(
          resourceOfferFromWire(groupId, wire.o),
          peerHash
        );
        return;
      }
      case 'group_digest': {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleGroupDigest(groupId, wire, peerHash);
        return;
      }
      case 'digest_req': {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleDigestReq(groupId, wire, peerHash);
        return;
      }
      case 'feed_req': {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleFeedReq(groupId, wire, peerHash);
        return;
      }
      case 'range_req': {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleRangeReq(groupId, wire, peerHash);
        return;
      }
      case 'event_batch': {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleEventBatch(groupId, wire, peerHash);
        return;
      }
      case 'typing':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        if (typeof wire.a !== 'string') return;
        this.applyTyping(
          groupId,
          normalizeReticulumChatChannelId(wire.c),
          wire.a,
          wire.active === true
        );
        return;
      }
      default:
        return;
    }
  }

  private isCompatibleHello(wire: Record<string, unknown>): boolean {
    if (wire.v !== RETICULUM_CHAT_PROTOCOL_VERSION) return false;
    if (!Array.isArray(wire.f)) return false;
    const features = new Set(wire.f.map((item) => String(item)));
    return RETICULUM_CHAT_PROTOCOL_FEATURES.every((feature) => features.has(feature));
  }

  private noteGroupInterestRoute(
    groupId: number,
    originPeerHash: string,
    reversePeerHash: string,
    hops: number
  ): void {
    const origin = this.routePeerHash(originPeerHash);
    const reverse = this.routePeerHash(reversePeerHash);
    const local = this.localPeerHash();
    if (!origin || !reverse || (local && origin === local)) return;
    this.pruneGroupInterestRoutes();
    const key = this.groupInterestRouteKey(groupId, origin);
    const existing = this.groupInterestRoutes.get(key);
    if (existing && existing.hops < hops) {
      existing.expiresAt = Math.max(
        existing.expiresAt,
        this.now() + RETICULUM_CHAT_GROUP_ROUTE_TTL_MS
      );
      return;
    }
    this.groupInterestRoutes.set(key, {
      reversePeerHash: reverse,
      originPeerHash: origin,
      groupId,
      hops,
      expiresAt: this.now() + RETICULUM_CHAT_GROUP_ROUTE_TTL_MS,
    });
  }

  private shouldForwardGroupSub(
    groupId: number,
    originPeerHash: string,
    inboundPeerHash: string
  ): boolean {
    const origin = this.routePeerHash(originPeerHash);
    const inbound = this.routePeerHash(inboundPeerHash);
    if (!origin || !inbound) return false;
    const key = `${groupId}:${origin}:${inbound}`;
    const now = this.now();
    const expiresAt = this.forwardedGroupSubKeys.get(key) ?? 0;
    if (expiresAt > now) return false;
    this.forwardedGroupSubKeys.set(
      key,
      now + RETICULUM_CHAT_GROUP_ROUTE_FORWARD_DEDUPE_MS
    );
    return true;
  }

  private async forwardGroupSub(
    groups: number[],
    mode: 'summary' | 'active',
    originPeerHash: string,
    inboundPeerHash: string,
    hops: number
  ): Promise<void> {
    const origin = this.routePeerHash(originPeerHash);
    const inbound = this.routePeerHash(inboundPeerHash);
    const local = this.localPeerHash();
    if (!origin || !inbound || (local && origin === local)) return;
    if (hops >= RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS) return;
    const forwardGroups = groups.filter((groupId) =>
      this.shouldForwardGroupSub(groupId, origin, inbound)
    );
    if (!forwardGroups.length) return;
    for (let offset = 0; offset < forwardGroups.length; offset += RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE) {
      const page = forwardGroups.slice(offset, offset + RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE);
      const wire: ReticulumChatWire = {
        t: 'RCHAT',
        k: 'group_sub',
        groups: page,
        mode,
        o: this.compactRoutePeerHash(origin),
        h: hops + 1,
      };
      void this.fanout(wire, [inbound, origin, ...(local ? [local] : [])]);
    }
  }

  private async forwardGroupDigestToInterestRoutes(
    groupId: number,
    wire: Record<string, unknown>,
    inboundPeerHash: string
  ): Promise<void> {
    const inbound = this.routePeerHash(inboundPeerHash);
    if (!inbound) return;
    this.pruneGroupInterestRoutes();
    this.pruneGroupControlRoutes();
    const local = this.localPeerHash();
    const payloadKey = this.hashControlPayload(wire);
    for (const route of this.groupInterestRoutes.values()) {
      if (route.groupId !== groupId) continue;
      if (route.reversePeerHash === inbound) continue;
      if (local && route.originPeerHash === local) continue;
      const key = this.groupControlRouteKey(
        'group_digest',
        groupId,
        route.originPeerHash,
        `${inbound}:${payloadKey}`
      );
      if ((this.forwardedGroupControlKeys.get(key) ?? 0) > this.now()) continue;
      this.forwardedGroupControlKeys.set(
        key,
        this.now() + RETICULUM_CHAT_GROUP_CONTROL_RELAY_TTL_MS
      );
      void this.sendToPeer(route.reversePeerHash, wire as ReticulumChatWire);
    }
  }

  private relayGroupControlRequest(
    kind: 'digest_req' | 'feed_req' | 'range_req' | 'event_req' | 'relay_query',
    groupId: number,
    wire: Record<string, unknown>,
    inboundPeerHash: string,
    payloadKey: string
  ): boolean {
    const inbound = this.routePeerHash(inboundPeerHash);
    const origin = this.routePeerHash(wire.o) ?? inbound;
    const local = this.localPeerHash();
    if (!inbound || !origin || (local && origin === local)) return false;
    if (!this.groupInterestRoutes.has(this.groupInterestRouteKey(groupId, origin))) {
      return false;
    }
    const hops = Math.max(
      0,
      Math.min(
        RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS,
        Number.isInteger(Number(wire.h)) ? Number(wire.h) : 0
      )
    );
    if (hops >= RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS) return false;
    const dedupeKey = this.groupControlRouteKey(kind, groupId, origin, payloadKey);
    const now = this.now();
    if ((this.forwardedGroupControlKeys.get(dedupeKey) ?? 0) > now) return true;
    this.forwardedGroupControlKeys.set(
      dedupeKey,
      now + RETICULUM_CHAT_GROUP_CONTROL_RELAY_TTL_MS
    );
    this.noteGroupInterestRoute(groupId, origin, inbound, hops);
    const requestId =
      this.normalizeGroupControlRequestId(wire.rid) ??
      (
        kind === 'event_req' && wire.q && typeof wire.q === 'object'
          ? this.eventRelayRequestId(
              groupId,
              String((wire.q as Partial<ReticulumChatEventRequestWire>).id || ''),
              origin
            )
          : this.groupControlRequestId(kind, groupId, origin, payloadKey)
      );
    if (kind === 'event_req' || kind === 'relay_query') {
      const eventIds =
        kind === 'event_req'
          ? [String((wire.q as Partial<ReticulumChatEventRequestWire> | undefined)?.id || '')]
          : (
              Array.isArray((wire.q as Partial<ReticulumChatRelayQueryWire> | undefined)?.ids)
                ? ((wire.q as Partial<ReticulumChatRelayQueryWire>).ids ?? [])
                    .filter((id): id is string => typeof id === 'string' && id.length >= 8)
                    .slice(0, RETICULUM_CHAT_RELAY_QUERY_MAX_IDS)
                : []
            );
      for (const eventId of eventIds) {
        const routeKey =
          kind === 'event_req'
            ? requestId
            : this.eventRelayRequestId(groupId, eventId, origin);
        this.eventRelayRoutes.set(routeKey, {
          reversePeerHash: inbound,
          originPeerHash: origin,
          groupId,
          eventId,
          expiresAt: now + RETICULUM_CHAT_GROUP_CONTROL_RELAY_TTL_MS,
        });
      }
    }
    const forwarded = {
      ...wire,
      o: this.compactRoutePeerHash(origin),
      ...(kind === 'relay_query' ? {} : { rid: requestId }),
      h: hops + 1,
    } as ReticulumChatWire;
    if (kind === 'event_req' && !wireFitsReticulum(forwarded)) {
      delete (forwarded as Partial<Extract<ReticulumChatWire, { k: 'event_req' }>>).rid;
    }
    void this.fanout(forwarded, [inbound, origin, ...(local ? [local] : [])]);
    return true;
  }

  private handleGroupSub(wire: Record<string, unknown>, peerHash: string): void {
    if (!Array.isArray(wire.groups)) return;
    const groups = wire.groups
      .map((groupId) => Number(groupId))
      .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
      .slice(0, RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE);
    const inboundPeerHash = this.routePeerHash(peerHash);
    const originPeerHash = this.routePeerHash(wire.o) ?? inboundPeerHash;
    const hops = Math.max(0, Math.min(
      RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS,
      Number.isInteger(Number(wire.h)) ? Number(wire.h) : 0
    ));
    if (!inboundPeerHash || !originPeerHash) return;
    for (const groupId of groups) {
      this.notePeerSubscription(originPeerHash, groupId, true);
      this.noteGroupInterestRoute(groupId, originPeerHash, inboundPeerHash, hops);
      this.requestKnownAuthorGaps(groupId, peerHash, 'group_sub');
      if (this.shouldDropDuplicateInboundControlWire(wire, groupId, peerHash)) {
        continue;
      }
      if (this.subscribedGroups.has(groupId) && this.localGroupIds.has(groupId)) {
        void this.sendToPeer(peerHash, this.buildGroupDigestWire(groupId));
      }
      void this.serveRelayDigestForGroup(peerHash, groupId);
    }
    void this.forwardGroupSub(
      groups,
      wire.mode === 'active' ? 'active' : 'summary',
      originPeerHash,
      inboundPeerHash,
      hops
    );
  }

  private handleGroupDigest(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): void {
    void this.forwardGroupDigestToInterestRoutes(groupId, wire, peerHash);
    if (!this.localGroupIds.has(groupId) || !this.subscribedGroups.has(groupId)) return;
    if (this.shouldDropDuplicateInboundControlWire(wire, groupId, peerHash)) return;
    if (!Array.isArray(wire.channels)) return;
    const remoteGroupLatest = this.cursorFromWire(wire.latest);
    const remoteDigestHash = typeof wire.digestHash === 'string' ? wire.digestHash : '';
    this.db.upsertPeerGroupState(
      peerHash,
      groupId,
      remoteGroupLatest,
      remoteDigestHash,
      this.now()
    );
    this.requestKnownAuthorGaps(groupId, peerHash, 'group_digest');
    const channels = wire.channels.slice(0, RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP);
    let requestedFromChannelDigest = false;
    let pushedFromChannelDigest = false;
    let requestedWindowRepair = false;
    for (const rawChannel of channels) {
      if (!rawChannel || typeof rawChannel !== 'object' || Array.isArray(rawChannel)) continue;
      const channel = rawChannel as Partial<ReticulumChatDigestWire>;
      const channelId = normalizeReticulumChatChannelId(channel.c);
      const remoteLatest = this.cursorFromWire(channel.latest);
      const remoteOldest = this.cursorFromWire(channel.oldest);
      this.db.upsertPeerChannelState(
        peerHash,
        {
          groupId,
          channelId,
          latestCursor: remoteLatest,
          oldestCursor: remoteOldest,
          visibleWindowHash: typeof channel.wh === 'string' ? channel.wh : '',
        },
        this.now()
      );
      const localLatest = this.db.getLatestFeedCursor(groupId, channelId);
      const localWindowHash = this.db.computeWindowHash(
        this.db.getRecentEvents(groupId, 25, channelId)
      );
      const remoteWindowHash = typeof channel.wh === 'string' ? channel.wh : '';
      const channelWindowMismatch = !!remoteWindowHash && remoteWindowHash !== localWindowHash;
      if (channelWindowMismatch && remoteLatest) {
        requestedWindowRepair = this.requestVisibleWindowRepair(
          peerHash,
          groupId,
          channelId,
          remoteLatest,
          localLatest,
          'channel-window-mismatch'
        ) || requestedWindowRepair;
        if (requestedWindowRepair) {
          requestedFromChannelDigest = true;
          pushedFromChannelDigest = true;
        }
        continue;
      }
      if (!remoteLatest) continue;
      if (!localLatest || this.compareCursors(remoteLatest, localLatest) > 0) {
        void this.sendToPeer(peerHash, {
          t: 'RCHAT',
          k: 'feed_req',
          g: groupId,
          c: channelId,
          ...(localLatest ? { after: this.cursorToWire(localLatest) } : {}),
          limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
        });
        requestedFromChannelDigest = true;
      } else if (this.compareCursors(localLatest, remoteLatest) > 0) {
        void this.sendFeedPageToPeer(peerHash, groupId, channelId, remoteLatest, 'after');
        pushedFromChannelDigest = true;
      }
    }
    const localGroupLatest = this.getGroupLatestCursor(groupId);
    const localDigestWire = this.buildGroupDigestWire(groupId);
    const localDigestHash =
      localDigestWire.k === 'group_digest' && typeof localDigestWire.digestHash === 'string'
        ? localDigestWire.digestHash
        : '';
    const remoteDigestNeedsRepair =
      !!remoteDigestHash && remoteDigestHash !== localDigestHash;
    const remoteHasCursorDetail =
      !!remoteGroupLatest ||
      channels.some((rawChannel) => {
        if (!rawChannel || typeof rawChannel !== 'object' || Array.isArray(rawChannel)) return false;
        return !!this.cursorFromWire((rawChannel as Partial<ReticulumChatDigestWire>).latest);
      });
    const remoteIsBehindGroup =
      !!localGroupLatest &&
      (
        !remoteGroupLatest ||
        this.compareCursors(localGroupLatest, remoteGroupLatest) > 0
      );
    if (
      !requestedWindowRepair &&
      remoteDigestNeedsRepair &&
      !!remoteGroupLatest &&
      !!localGroupLatest
    ) {
      const repaired = this.requestVisibleWindowRepair(
        peerHash,
        groupId,
        RETICULUM_CHAT_ALL_CHANNELS_ID,
        remoteGroupLatest,
        localGroupLatest,
        'group-window-mismatch'
      );
      if (repaired) {
        requestedFromChannelDigest = true;
        pushedFromChannelDigest = true;
        requestedWindowRepair = true;
      }
    }
    if (
      !requestedFromChannelDigest &&
      !pushedFromChannelDigest &&
      remoteIsBehindGroup &&
      (
        remoteDigestNeedsRepair ||
        !remoteHasCursorDetail ||
        (remoteGroupLatest && this.compareCursors(localGroupLatest, remoteGroupLatest) > 0)
      )
    ) {
      const afterCursor = remoteGroupLatest ?? null;
      void this.sendFeedPageToPeer(
        peerHash,
        groupId,
        RETICULUM_CHAT_ALL_CHANNELS_ID,
        afterCursor,
        'after'
      );
      loggerLog(
        `[ReticulumChat] Sync push group=${groupId} peer=${peerHash.slice(0, 16)} after=${afterCursor ? afterCursor.eventId : 'start'} reason=peer-behind`
      );
      pushedFromChannelDigest = true;
    }
    if (
      !requestedFromChannelDigest &&
      !pushedFromChannelDigest &&
      (
        (remoteGroupLatest &&
          (!localGroupLatest || this.compareCursors(remoteGroupLatest, localGroupLatest) > 0)) ||
        (!remoteGroupLatest && remoteDigestNeedsRepair)
      )
    ) {
      if (this.shouldRequestGroupRepair(peerHash, groupId)) {
        const channelsToRepair = this.db
          .getChannels(groupId, true)
          .slice(0, RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP);
        const repairChannelIds = remoteGroupLatest
          ? (
              channelsToRepair.length
                ? channelsToRepair.map((channel) => normalizeReticulumChatChannelId(channel.channelId))
                : [RETICULUM_CHAT_DEFAULT_CHANNEL_ID]
            )
          : [RETICULUM_CHAT_ALL_CHANNELS_ID];
        for (const channelId of repairChannelIds) {
          const localLatest =
            channelId === RETICULUM_CHAT_ALL_CHANNELS_ID
              ? null
              : this.db.getLatestFeedCursor(groupId, channelId);
          const afterCursor = remoteGroupLatest ? localLatest : null;
          void this.sendToPeer(peerHash, {
            t: 'RCHAT',
            k: 'feed_req',
            g: groupId,
            c: channelId,
            ...(afterCursor ? { after: this.cursorToWire(afterCursor) } : {}),
            limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
          });
        }
      }
    }
    if (
      wire.more === true &&
      Number.isInteger(wire.nextOffset) &&
      Number(wire.nextOffset) >= 0
    ) {
      void this.sendToPeer(
        peerHash,
        {
          t: 'RCHAT',
          k: 'digest_req',
          g: groupId,
          offset: Number(wire.nextOffset),
          limit: RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP,
        }
      );
    }
  }

  private async handleDigestReq(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    if (!this.canServeGroupHistory(groupId)) {
      this.relayGroupControlRequest(
        'digest_req',
        groupId,
        wire,
        peerHash,
        this.hashControlPayload({
          offset: wire.offset,
          limit: wire.limit,
        })
      );
      return;
    }
    if (!this.shouldServeControlRequest(wire, groupId, peerHash)) return;
    const rawOffset = Number(wire.offset);
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const limit = this.normalizeDigestLimit(wire.limit);
    await this.sendToPeer(peerHash, this.buildGroupDigestWire(groupId, offset, limit));
  }

  private relayResponseOptionsFromWire(
    wire: Record<string, unknown>
  ): Omit<ReticulumChatEventOfferOptions, 'continuation'> | undefined {
    const recipientPeerHash = this.routePeerHash(wire.o);
    const relayRequestId = this.normalizeGroupControlRequestId(wire.rid);
    const sourcePeerHash = this.localPeerHash();
    if (!recipientPeerHash && !relayRequestId && !sourcePeerHash) return undefined;
    return {
      ...(recipientPeerHash ? { recipientPeerHash } : {}),
      ...(relayRequestId ? { relayRequestId } : {}),
      ...(sourcePeerHash ? { sourcePeerHash } : {}),
    };
  }

  private async handleFeedReq(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    if (!this.canServeGroupHistory(groupId)) {
      this.relayGroupControlRequest(
        'feed_req',
        groupId,
        wire,
        peerHash,
        this.hashControlPayload({
          c: wire.c,
          after: wire.after,
          before: wire.before,
          limit: wire.limit,
        })
      );
      return;
    }
    if (!this.shouldServeControlRequest(wire, groupId, peerHash)) return;
    const channelId =
      wire.c === RETICULUM_CHAT_ALL_CHANNELS_ID
        ? RETICULUM_CHAT_ALL_CHANNELS_ID
        : normalizeReticulumChatChannelId(wire.c);
    const limit = this.normalizeFeedLimit(wire.limit);
    const before = this.cursorFromWire(wire.before);
    const after = before ? null : this.cursorFromWire(wire.after);
    const events =
      channelId === RETICULUM_CHAT_ALL_CHANNELS_ID
        ? (
            before
              ? this.db.getGroupFeedPageBefore(groupId, before, limit + 1)
              : this.db.getGroupFeedPageAfter(groupId, after, limit + 1)
          )
        : (
            before
              ? this.db.getFeedPageBefore(groupId, channelId, before, limit + 1)
              : this.db.getFeedPageAfter(groupId, channelId, after, limit + 1)
          );
    const hasMore = events.length > limit;
    const visibleEvents = before && hasMore
      ? events.slice(events.length - limit)
      : events.slice(0, limit);
    if (visibleEvents.length) this.db.markServed(visibleEvents.map((event) => event.eventId));
    await this.sendEventBatchOrResourceDigest(
      peerHash,
      groupId,
      channelId,
      visibleEvents,
      hasMore,
      before ? 'before' : 'after',
      this.relayResponseOptionsFromWire(wire)
    );
  }

  private async handleRangeReq(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    if (!this.canServeGroupHistory(groupId)) {
      this.relayGroupControlRequest(
        'range_req',
        groupId,
        wire,
        peerHash,
        this.hashControlPayload({
          ranges: wire.ranges,
          limit: wire.limit,
        })
      );
      return;
    }
    if (!this.shouldServeControlRequest(wire, groupId, peerHash)) return;
    if (!Array.isArray(wire.ranges)) return;
    const limit = this.normalizeFeedLimit(wire.limit);
    let budget = limit;
    const byChannel = new Map<string, ReticulumChatEvent[]>();
    for (const rawRange of wire.ranges.slice(0, RETICULUM_CHAT_MAX_RECENT_AUTHOR_SAMPLE)) {
      if (!rawRange || typeof rawRange !== 'object' || Array.isArray(rawRange)) continue;
      const range = rawRange as { a?: unknown; from?: unknown; to?: unknown };
      const author = typeof range.a === 'string' ? range.a : '';
      const from = Number(range.from);
      const to = Number(range.to);
      if (!author || !Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to < from) continue;
      const events = this.db.getAuthorEventsRange(groupId, author, from, to, budget);
      for (const event of events) {
        const channelId = normalizeReticulumChatChannelId(event.channelId);
        const existing = byChannel.get(channelId) ?? [];
        existing.push(event);
        byChannel.set(channelId, existing);
        budget -= 1;
        if (budget <= 0) break;
      }
      if (budget <= 0) break;
    }
    for (const [channelId, events] of byChannel) {
      if (events.length) this.db.markServed(events.map((event) => event.eventId));
      await this.sendEventBatchOrResourceDigest(
        peerHash,
        groupId,
        channelId,
        events,
        false,
        'range',
        this.relayResponseOptionsFromWire(wire)
      );
    }
  }

  private handleEventBatch(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): void {
    if (!this.localGroupIds.has(groupId) || !this.subscribedGroups.has(groupId)) return;
    if (this.shouldDropDuplicateInboundControlWire(wire, groupId, peerHash)) return;
    const allChannels = wire.c === RETICULUM_CHAT_ALL_CHANNELS_ID;
    const channelId = allChannels
      ? RETICULUM_CHAT_ALL_CHANNELS_ID
      : normalizeReticulumChatChannelId(wire.c);
    const batch = wire.batch && typeof wire.batch === 'object' && !Array.isArray(wire.batch)
      ? wire.batch as Partial<ReticulumChatEventBatchWire>
      : null;
    if (!batch || !Array.isArray(batch.events)) return;
    const incomingEvents = batch.events.slice(0, RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS);
    const validWindowEvents: ReticulumChatEvent[] = [];
    for (const candidate of incomingEvents) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const event = candidate as ReticulumChatEvent;
      if (
        event.groupId !== groupId ||
        (!allChannels && normalizeReticulumChatChannelId(event.channelId) !== channelId)
      ) {
        this.notePeerViolation(peerHash, 'event_batch_out_of_bounds');
        continue;
      }
      if (!validateReticulumChatEventShape(event, this.now()) || !verifyReticulumChatEvent(event)) {
        this.notePeerViolation(peerHash, 'event_batch_invalid_event');
        continue;
      }
      validWindowEvents.push(event);
      this.noteEventSourcePeer(event.eventId, peerHash);
      this.requestMissingAuthorRangeBeforeAccept(event, peerHash);
      const inserted = this.acceptEvent(event, false);
      if (inserted) {
        this.pendingEventPulls.delete(this.eventPullKey(event.groupId, event.eventId));
        this.emit('event', { event });
      }
    }
    const start = this.cursorFromWire(batch.start);
    const end = this.cursorFromWire(batch.end);
    if (
      !allChannels &&
      start &&
      end &&
      typeof batch.wh === 'string' &&
      batch.wh === this.db.computeWindowHash(validWindowEvents)
    ) {
      this.db.upsertVerifiedWindow(groupId, channelId, start, end, batch.wh, this.now());
    } else if (!allChannels && validWindowEvents.length > 0) {
      this.notePeerViolation(peerHash, 'event_batch_window_hash_mismatch');
    }
    if (batch.more === true) {
      const direction = batch.dir === 'before' ? 'before' : 'after';
      const cursor = this.cursorFromWire(direction === 'before' ? batch.start : batch.end);
      if (cursor) {
        void this.sendToPeer(peerHash, {
          t: 'RCHAT',
          k: 'feed_req',
          g: groupId,
          c: channelId,
          [direction]: this.cursorToWire(cursor),
          limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
        });
      }
    }
  }

  private requestMissingAuthorRangeBeforeAccept(
    event: ReticulumChatEvent,
    peerHash: string
  ): void {
    const localMaxSeq = this.db.getAuthorMaxSeq(event.groupId, event.authorAddress);
    if (event.authorSeq <= localMaxSeq + 1) return;
    const fromSeq = localMaxSeq + 1;
    const toSeq = event.authorSeq - 1;
    this.db.upsertMissingRange(
      event.groupId,
      event.authorAddress,
      fromSeq,
      toSeq,
      peerHash,
      this.now()
    );
    this.sendAuthorRangeRepairRequests(
      event.groupId,
      peerHash,
      [{ a: event.authorAddress, from: fromSeq, to: toSeq }],
      'incoming_event_gap'
    );
  }

  private shouldRequestAuthorGapRepair(peerHash: string, groupId: number): boolean {
    const key = `${peerHash.trim().toLowerCase()}:${groupId}`;
    const now = this.now();
    const lastRequestedAt = this.recentAuthorGapRepairRequests.get(key) ?? 0;
    if (now - lastRequestedAt < RETICULUM_CHAT_AUTHOR_GAP_REPAIR_DEBOUNCE_MS) return false;
    this.recentAuthorGapRepairRequests.set(key, now);
    return true;
  }

  private requestKnownAuthorGaps(
    groupId: number,
    peerHash: string,
    reason: string
  ): boolean {
    const peer = peerHash.trim().toLowerCase();
    if (!peer || !this.localGroupIds.has(groupId) || !this.subscribedGroups.has(groupId)) {
      return false;
    }
    const gaps = this.db.getAuthorSequenceGaps(
      groupId,
      RETICULUM_CHAT_MAX_RECENT_AUTHOR_SAMPLE
    );
    if (gaps.length === 0) return false;
    if (!this.shouldRequestAuthorGapRepair(peer, groupId)) return false;
    const now = this.now();
    const ranges = gaps.map((gap) => {
      this.db.upsertMissingRange(
        groupId,
        gap.authorAddress,
        gap.fromSeq,
        gap.toSeq,
        peer,
        now
      );
      return { a: gap.authorAddress, from: gap.fromSeq, to: gap.toSeq };
    });
    loggerLog(
      `[ReticulumChat] Requesting author gap repair group=${groupId} peer=${peer.slice(0, 16)} gaps=${ranges.length} reason=${reason}`
    );
    this.sendAuthorRangeRepairRequests(groupId, peer, ranges, reason);
    return true;
  }

  private sendAuthorRangeRepairRequests(
    groupId: number,
    peerHash: string,
    ranges: Array<{ a: string; from: number; to: number }>,
    reason: string
  ): void {
    const peer = peerHash.trim().toLowerCase();
    for (const range of ranges) {
      const wire: ReticulumChatWire = {
        t: 'RCHAT',
        k: 'range_req',
        g: groupId,
        ranges: [range],
        limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
      };
      if (!wireFitsReticulum(wire)) {
        loggerWarn(
          `[ReticulumChat] Skipping oversized author gap repair group=${groupId} author=${range.a} from=${range.from} to=${range.to} reason=${reason}`
        );
        continue;
      }
      if (!peer) {
        void this.fanout(wire);
        continue;
      }
      void this.sendToPeer(peer, wire).then((result) => {
        if (result.ok !== false) return;
        loggerWarn(
          `[ReticulumChat] Targeted author gap repair failed group=${groupId} peer=${peer.slice(0, 16)} reason=${result.reason}; falling back to fanout`
        );
        void this.fanout(wire);
      });
    }
  }

  private async sendEventBatchOrResourceDigest(
    peerHash: string,
    groupId: number,
    channelId: string,
    events: ReticulumChatEvent[],
    hasMore: boolean,
    direction: 'after' | 'before' | 'range' = 'after',
    options: Omit<ReticulumChatEventOfferOptions, 'continuation'> = {}
  ): Promise<void> {
    const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
    const cursorEvent = hasMore && direction !== 'range' && ordered.length > 0
      ? direction === 'before'
        ? ordered[0]
        : ordered[ordered.length - 1]
      : null;
    const continuation: ReticulumChatEventOffer['continuation'] | undefined =
      cursorEvent && direction !== 'range'
        ? {
            channelId,
            direction,
            cursor: this.eventCursor(cursorEvent),
          }
        : undefined;
    for (let i = 0; i < events.length; i += RETICULUM_CHAT_EVENT_OFFER_CONCURRENCY) {
      const batch = events.slice(i, i + RETICULUM_CHAT_EVENT_OFFER_CONCURRENCY);
      await Promise.all(
        batch.map((event) =>
          this.offerEventResource(
            peerHash,
            groupId,
            event.eventId,
            {
              ...options,
              ...(continuation && event.eventId === cursorEvent?.eventId
                ? { continuation }
                : {}),
            }
          )
        )
      );
    }
    await this.sendToPeer(peerHash, this.buildGroupDigestWire(groupId));
  }

  private async fanoutPublishedEvent(
    event: ReticulumChatEvent,
    _channelId: string
  ): Promise<ReticulumSendResult> {
    const interestedPeers = this.getInterestedPeers(event.groupId);
    let offeredCount = 0;
    let lastOfferFailure: Exclude<ReticulumSendResult, { ok: true }> | null = null;
    for (const peerHash of interestedPeers) {
      const result = await this.offerEventResource(peerHash, event.groupId, event.eventId);
      if (result.ok) {
        offeredCount += 1;
      } else {
        lastOfferFailure = result as Exclude<ReticulumSendResult, { ok: true }>;
      }
    }

    const digestResult = await this.fanout(this.buildGroupDigestWire(event.groupId));
    if (digestResult.ok || offeredCount > 0) return { ok: true };
    if (interestedPeers.length > 0 && lastOfferFailure) return lastOfferFailure;
    return digestResult;
  }

  private async sendFeedPageToPeer(
    peerHash: string,
    groupId: number,
    channelId: string,
    after: ReticulumChatFeedCursor | null,
    direction: 'after' | 'before' | 'range' = 'after',
    options: Omit<ReticulumChatEventOfferOptions, 'continuation'> = {}
  ): Promise<void> {
    const events = direction === 'before' && after
      ? (
          channelId === RETICULUM_CHAT_ALL_CHANNELS_ID
            ? this.db.getGroupFeedPageBefore(
                groupId,
                after,
                RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS + 1
              )
            : this.db.getFeedPageBefore(
                groupId,
                channelId,
                after,
                RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS + 1
              )
        )
      : (
          channelId === RETICULUM_CHAT_ALL_CHANNELS_ID
            ? this.db.getGroupFeedPageAfter(
                groupId,
                after,
                RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS + 1
              )
            : this.db.getFeedPageAfter(
                groupId,
                channelId,
                after,
                RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS + 1
              )
        );
    const hasMore = events.length > RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS;
    const visibleEvents = direction === 'before' && hasMore
      ? events.slice(events.length - RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS)
      : events.slice(0, RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS);
    if (visibleEvents.length) this.db.markServed(visibleEvents.map((event) => event.eventId));
    await this.sendEventBatchOrResourceDigest(
      peerHash,
      groupId,
      channelId,
      visibleEvents,
      hasMore,
      direction,
      options
    );
  }

  private requestVisibleWindowRepair(
    peerHash: string,
    groupId: number,
    channelId: string,
    remoteLatest: ReticulumChatFeedCursor,
    localLatest: ReticulumChatFeedCursor | null,
    reason: string
  ): boolean {
    if (!this.shouldRequestGroupRepair(peerHash, groupId, channelId)) return false;
    void this.requestPeerEventById(peerHash, groupId, remoteLatest.eventId, reason);
    void this.sendToPeer(
      peerHash,
      {
        t: 'RCHAT',
        k: 'feed_req',
        g: groupId,
        c: channelId,
        before: this.cursorToWire(remoteLatest),
        limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
      }
    );
    if (localLatest) {
      void this.sendFeedPageToPeer(peerHash, groupId, channelId, localLatest, 'before').catch((err) => {
        loggerWarn(
          `[ReticulumChat] Sync repair push failed group=${groupId} channel=${channelId} peer=${peerHash.slice(0, 16)} direction=before reason=${reason}:`,
          err
        );
      });
      if (this.compareCursors(localLatest, remoteLatest) > 0) {
        void this.sendFeedPageToPeer(peerHash, groupId, channelId, remoteLatest, 'after').catch((err) => {
          loggerWarn(
            `[ReticulumChat] Sync repair push failed group=${groupId} channel=${channelId} peer=${peerHash.slice(0, 16)} direction=after reason=${reason}:`,
            err
          );
        });
      } else if (this.compareCursors(remoteLatest, localLatest) > 0) {
        void this.sendToPeer(peerHash, {
          t: 'RCHAT',
          k: 'feed_req',
          g: groupId,
          c: channelId,
          after: this.cursorToWire(localLatest),
          limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
        });
      }
    } else {
      void this.sendToPeer(peerHash, {
        t: 'RCHAT',
        k: 'feed_req',
        g: groupId,
        c: channelId,
        limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
      });
    }
    loggerLog(
      `[ReticulumChat] Sync repair group=${groupId} channel=${channelId} peer=${peerHash.slice(0, 16)} remoteLatest=${remoteLatest.eventId} localLatest=${localLatest?.eventId ?? 'none'} reason=${reason}`
    );
    return true;
  }

  private async requestPeerEventById(
    peerHash: string,
    groupId: number,
    eventId: string,
    reason: string
  ): Promise<void> {
    if (!eventId || this.db.hasEvent(eventId)) return;
    const request = await this.buildSignedEventRequestWire(groupId, eventId);
    if (!request) {
      loggerWarn(
        `[ReticulumChat] Cannot request repair event ${eventId}: local signing unavailable reason=${reason}`
      );
      return;
    }
    const result = await this.sendToPeer(peerHash, {
      t: 'RCHAT',
      k: 'event_req',
      g: groupId,
      q: request,
    });
    if (result.ok === false) {
      loggerWarn(
        `[ReticulumChat] Repair event request failed group=${groupId} event=${eventId} peer=${peerHash.slice(0, 16)} reason=${reason}:`,
        result.error ?? result.reason
      );
    }
  }

  private compareCursors(a: ReticulumChatFeedCursor, b: ReticulumChatFeedCursor): number {
    return a.feedTimestamp - b.feedTimestamp || a.eventId.localeCompare(b.eventId);
  }

  private normalizeFeedLimit(value: unknown): number {
    const limit = Number(value);
    if (!Number.isFinite(limit)) return RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS;
    return Math.max(1, Math.min(RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS, Math.floor(limit)));
  }

  private normalizeDigestLimit(value: unknown): number {
    const limit = Number(value);
    if (!Number.isFinite(limit)) return RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP;
    return Math.max(1, Math.min(RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP, Math.floor(limit)));
  }

  private notePeerViolation(peerHash: string, reason: string): void {
    const key = peerHash.trim().toLowerCase();
    if (!key) return;
    const now = this.now();
    const existing = this.peerProtocolViolations.get(key);
    const count = existing && now - existing.lastAt < RETICULUM_CHAT_PEER_VIOLATION_COOLDOWN_MS
      ? existing.count + 1
      : 1;
    const cooldownUntil = count >= RETICULUM_CHAT_MAX_PEER_VIOLATIONS_BEFORE_COOLDOWN
      ? now + RETICULUM_CHAT_PEER_VIOLATION_COOLDOWN_MS
      : 0;
    this.peerProtocolViolations.set(key, { count, lastAt: now, cooldownUntil });
    loggerWarn(
      `[ReticulumChat] Peer protocol violation peer=${key} reason=${reason} count=${count}` +
        (cooldownUntil ? ` cooldownMs=${cooldownUntil - now}` : '')
    );
  }

  private isPeerProtocolCooledDown(peerHash: string): boolean {
    const key = peerHash.trim().toLowerCase();
    if (!key) return false;
    const record = this.peerProtocolViolations.get(key);
    if (!record || record.cooldownUntil <= 0) return false;
    const now = this.now();
    if (record.cooldownUntil > now) return true;
    this.peerProtocolViolations.delete(key);
    return false;
  }

  private acceptEvent(candidate: unknown, ownEvent: boolean): boolean {
    const now = this.now();
    if (!validateReticulumChatEventShape(candidate, now)) return false;
    const event = candidate;
    if (!this.localGroupIds.has(event.groupId)) return false;
    if (!verifyReticulumChatEvent(event)) return false;
    if (this.db.hasEvent(event.eventId)) return false;
    const inserted = this.db.insertEvent(event, ownEvent);
    if (inserted) {
      void this.tryApplyPublicChannelMetadata(event);
      this.observedDbEventIds.add(event.eventId);
      this.writeLocalEventNotification(event);
      this.emitSummaryChanged(event.groupId, event);
    }
    return inserted;
  }

  async applyChannelMetadataEvent(eventId: string, payload: unknown): Promise<boolean> {
    const event = this.db.getEvent(eventId);
    if (!event || !CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) {
      loggerWarn(
        `[ReticulumChat] Ignoring channel metadata event ${eventId}: event missing or wrong type`
      );
      return false;
    }
    const authorIsAdmin = await this.isValidatedGroupAdmin(event.groupId, event.authorAddress);
    if (!authorIsAdmin) {
      loggerWarn(
        `[ReticulumChat] Ignoring channel metadata event ${event.eventId}: author is not a group admin`
      );
      return false;
    }
    if (event.eventType.startsWith('category_')) {
      const category = this.categoryFromMetadataPayload(event, payload);
      if (!category) {
        loggerWarn(
          `[ReticulumChat] Ignoring category metadata event ${event.eventId}: invalid metadata payload`
        );
        return false;
      }
      const changed =
        event.eventType === 'category_delete'
          ? this.db.deleteCategory(category.groupId, category.categoryId)
          : this.db.upsertCategory(category);
      if (
        !changed &&
        event.eventType !== 'category_delete' &&
        !this.db.getCategory(category.groupId, category.categoryId)
      ) {
        loggerWarn(
          `[ReticulumChat] Failed to persist category metadata event ${event.eventId}:`,
          category
        );
        return false;
      }
      this.emitSummaryChanged(event.groupId, event);
      return true;
    }

    const channel = this.channelFromMetadataPayload(event, payload);
    if (!channel) {
      loggerWarn(
        `[ReticulumChat] Ignoring channel metadata event ${event.eventId}: invalid metadata payload`
      );
      return false;
    }
    const changed = this.db.upsertChannel(channel);
    if (!changed && !this.db.getChannel(channel.groupId, channel.channelId)) {
      loggerWarn(
        `[ReticulumChat] Failed to persist channel metadata event ${event.eventId}:`,
        channel
      );
      return false;
    }
    this.emitSummaryChanged(event.groupId, event);
    return true;
  }

  getChannels(groupId: number, includeArchived = false): ReticulumGroupChannel[] {
    this.assertGroupId(groupId);
    return this.db.getChannels(groupId, includeArchived);
  }

  getCategories(groupId: number): ReticulumGroupCategory[] {
    this.assertGroupId(groupId);
    return this.db.getCategories(groupId);
  }

  private async tryApplyPublicChannelMetadata(event: ReticulumChatEvent): Promise<void> {
    if (!CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) return;
    try {
      await this.applyChannelMetadataEvent(event.eventId, JSON.parse(event.encryptedPayload));
    } catch {
      // Private groups are applied after renderer-side decryption.
    }
  }

  private channelFromMetadataPayload(
    event: ReticulumChatEvent,
    payload: unknown
  ): ReticulumGroupChannel | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const data = payload as Record<string, unknown>;
    const channelId = normalizeReticulumChatChannelId(
      typeof data.channelId === 'string' ? data.channelId : event.channelId
    );
    const existing = this.db.getChannel(event.groupId, channelId);
    const now = event.timestamp;
    const name = normalizeReticulumChatChannelId(data.name ?? channelId);
    const categoryId = normalizeReticulumChatCategoryId(data.categoryId);
    const description =
      typeof data.description === 'string' && data.description.trim()
        ? data.description.trim().slice(0, 240)
        : undefined;
    const position = Number.isFinite(Number(data.position))
      ? Math.max(0, Math.floor(Number(data.position)))
      : existing?.position ?? (channelId === RETICULUM_CHAT_DEFAULT_CHANNEL_ID ? 0 : 1000);
    if (event.eventType === 'channel_archive') {
      if (!existing || channelId === RETICULUM_CHAT_DEFAULT_CHANNEL_ID) return null;
      return { ...existing, archived: true, updatedAt: now };
    }
    if (event.eventType === 'channel_restore') {
      if (!existing) return null;
      return { ...existing, archived: false, updatedAt: now };
    }
    if (event.eventType === 'channel_reorder') {
      if (!existing) return null;
      return {
        ...existing,
        ...(Object.prototype.hasOwnProperty.call(data, 'categoryId')
          ? { categoryId: categoryId || undefined }
          : {}),
        position,
        updatedAt: now,
      };
    }
    return {
      groupId: event.groupId,
      channelId,
      ...(Object.prototype.hasOwnProperty.call(data, 'categoryId')
        ? { categoryId: categoryId || undefined }
        : { categoryId: existing?.categoryId }),
      name,
      ...(description ? { description } : {}),
      position,
      archived: existing?.archived ?? false,
      createdBy: existing?.createdBy || event.authorAddress,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
  }

  private categoryFromMetadataPayload(
    event: ReticulumChatEvent,
    payload: unknown
  ): ReticulumGroupCategory | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const data = payload as Record<string, unknown>;
    const categoryId = normalizeReticulumChatCategoryId(data.categoryId);
    if (!categoryId) return null;
    const existing = this.db.getCategory(event.groupId, categoryId);
    const now = event.timestamp;
    const name = normalizeReticulumChatChannelId(data.name ?? categoryId.replace(/^cat-/, ''));
    const position = Number.isFinite(Number(data.position))
      ? Math.max(0, Math.floor(Number(data.position)))
      : existing?.position ?? 1000;
    if (event.eventType === 'category_delete') {
      if (!existing) {
        return {
          groupId: event.groupId,
          categoryId,
          name,
          position,
          createdBy: event.authorAddress,
          createdAt: now,
          updatedAt: now,
        };
      }
      return { ...existing, updatedAt: now };
    }
    return {
      groupId: event.groupId,
      categoryId,
      name,
      position,
      createdBy: existing?.createdBy || event.authorAddress,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
  }

  private emitSummaryChanged(groupId: number, event?: ReticulumChatEvent): void {
    this.emit('summaryChanged', {
      groupId,
      eventId: event?.eventId,
      timestamp: event?.timestamp ?? this.now(),
    });
  }

  private markGroupHistoryObserved(groupId: number): void {
    this.activeDigestGroups.set(groupId, this.now());
    for (const event of this.db.getRecentEvents(groupId, 500, null)) {
      this.observedDbEventIds.add(event.eventId);
    }
  }

  private canServeGroupHistory(groupId: number): boolean {
    return this.localGroupIds.has(groupId);
  }

  private async isValidatedGroupMember(groupId: number, address: string): Promise<boolean> {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    const normalizedAddress = address.trim();
    if (!normalizedAddress) return false;
    if (!this.validateGroupMember) return this.localGroupIds.has(groupId);
    const cacheKey = `${groupId}:${normalizedAddress}`;
    const cached = this.groupMemberValidationCache.get(cacheKey);
    const now = this.now();
    if (cached && cached.expiresAt > now) return cached.isMember;
    let isMember = false;
    try {
      isMember = await this.validateGroupMember(groupId, normalizedAddress);
    } catch (err) {
      loggerWarn(
        `[ReticulumChat] Group membership validation failed for group=${groupId} address=${normalizedAddress}:`,
        err
      );
      isMember = false;
    }
    this.groupMemberValidationCache.set(cacheKey, {
      isMember,
      expiresAt: now + RETICULUM_CHAT_MEMBER_CACHE_TTL_MS,
    });
    return isMember;
  }

  private async isValidatedGroupAdmin(groupId: number, address: string): Promise<boolean> {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    const normalizedAddress = address.trim();
    if (!normalizedAddress) return false;
    if (!this.validateGroupAdmin) return this.localGroupIds.has(groupId);
    const cacheKey = `${groupId}:${normalizedAddress}`;
    const cached = this.groupAdminValidationCache.get(cacheKey);
    const now = this.now();
    if (cached && cached.expiresAt > now) return cached.isAdmin;
    let isAdmin = false;
    try {
      isAdmin = await this.validateGroupAdmin(groupId, normalizedAddress);
    } catch (err) {
      loggerWarn(
        `[ReticulumChat] Group admin validation failed for group=${groupId} address=${normalizedAddress}:`,
        err
      );
      isAdmin = false;
    }
    this.groupAdminValidationCache.set(cacheKey, {
      isAdmin,
      expiresAt: now + RETICULUM_CHAT_MEMBER_CACHE_TTL_MS,
    });
    return isAdmin;
  }

  private startLocalNotificationWatcher(): void {
    if (this.localNotifyWatcher) return;
    fs.mkdirSync(this.localNotifyDir, { recursive: true });
    this.cleanupOldLocalNotifications();
    this.scanLocalNotifications();
    if (!this.localNotifyScanInterval) {
      this.localNotifyScanInterval = setInterval(() => {
        this.scanLocalNotifications();
      }, 2_000);
      this.localNotifyScanInterval.unref?.();
    }
    try {
      this.localNotifyWatcher = fs.watch(this.localNotifyDir, () => {
        this.scheduleLocalNotificationScan();
      });
      this.scheduleLocalNotificationScan();
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to watch local event notifications:', err);
      this.localNotifyWatcher = null;
    }
  }

  private stopLocalNotificationWatcher(): void {
    if (this.localNotifyTimer) {
      clearTimeout(this.localNotifyTimer);
      this.localNotifyTimer = null;
    }
    if (this.localNotifyScanInterval) {
      clearInterval(this.localNotifyScanInterval);
      this.localNotifyScanInterval = null;
    }
    if (!this.localNotifyWatcher) return;
    this.localNotifyWatcher.close();
    this.localNotifyWatcher = null;
  }

  private scheduleLocalNotificationScan(): void {
    if (this.localNotifyTimer) clearTimeout(this.localNotifyTimer);
    this.localNotifyTimer = setTimeout(() => {
      this.localNotifyTimer = null;
      this.scanLocalNotifications();
    }, this.localNotifyDebounceMs);
    this.localNotifyTimer.unref?.();
  }

  private scanLocalNotifications(): void {
    try {
      const files = fs.readdirSync(this.localNotifyDir);
      for (const file of files) {
        if (this.seenLocalNotifyFiles.has(file)) continue;
        if (!file.endsWith('.json')) {
          this.seenLocalNotifyFiles.add(file);
          continue;
        }
        if (this.handleLocalNotificationFile(path.join(this.localNotifyDir, file))) {
          this.seenLocalNotifyFiles.add(file);
        }
      }
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to scan local event notifications:', err);
    }
  }

  private handleLocalNotificationFile(filePath: string): boolean {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const note = JSON.parse(raw) as { eventId?: unknown; groupId?: unknown };
      const eventId = typeof note.eventId === 'string' ? note.eventId : '';
      const groupId = Number(note.groupId);
      if (!eventId || !Number.isInteger(groupId) || groupId <= 0) return true;
      if (!this.subscribedGroups.has(groupId) || !this.localGroupIds.has(groupId)) {
        return false;
      }
      const event = this.db.getEvent(eventId);
      if (!event || event.groupId !== groupId) return false;
      this.observedDbEventIds.add(event.eventId);
      this.emitSummaryChanged(event.groupId, event);
      this.emit('event', { event });
      return true;
    } catch {
      return false;
    }
  }

  private writeLocalEventNotification(event: ReticulumChatEvent): void {
    try {
      fs.mkdirSync(this.localNotifyDir, { recursive: true });
      const fileName = `${event.groupId}-${event.timestamp}-${nodeCrypto.randomBytes(6).toString('hex')}.json`;
      const filePath = path.join(this.localNotifyDir, fileName);
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          eventId: event.eventId,
          groupId: event.groupId,
          timestamp: event.timestamp,
        }),
        'utf8'
      );
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to write local event notification:', err);
    }
  }

  private cleanupOldLocalNotifications(): void {
    try {
      const cutoff = this.now() - 10 * 60 * 1000;
      for (const file of fs.readdirSync(this.localNotifyDir)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.localNotifyDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) fs.rmSync(filePath, { force: true });
      }
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to clean local event notifications:', err);
    }
  }

  private buildHelloWire(): ReticulumChatWire {
    return {
      t: 'RCHAT',
      k: 'hello',
      v: RETICULUM_CHAT_PROTOCOL_VERSION,
      f: RETICULUM_CHAT_PROTOCOL_FEATURES,
    };
  }

  private cursorToWire(cursor: ReticulumChatFeedCursor | null): ReticulumChatFeedCursorWire | undefined {
    if (!cursor) return undefined;
    return { id: cursor.eventId, ts: cursor.feedTimestamp };
  }

  private cursorFromWire(wire: unknown): ReticulumChatFeedCursor | null {
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
    const cursor = wire as Partial<ReticulumChatFeedCursorWire>;
    const eventId = typeof cursor.id === 'string' ? cursor.id : '';
    const feedTimestamp = Number(cursor.ts);
    if (!eventId || !Number.isFinite(feedTimestamp) || feedTimestamp < 0) return null;
    return { eventId, feedTimestamp };
  }

  private eventCursor(event: ReticulumChatEvent): ReticulumChatFeedCursor {
    return { eventId: event.eventId, feedTimestamp: event.timestamp };
  }

  private buildDigestChannelWire(channel: ReticulumChatChannelDigest): ReticulumChatDigestWire {
    const latest = this.cursorToWire(channel.latestCursor);
    const oldest = this.cursorToWire(channel.oldestCursor);
    return {
      c: channel.channelId,
      ...(latest ? { latest } : {}),
      ...(oldest ? { oldest } : {}),
      ...(channel.visibleWindowHash ? { wh: channel.visibleWindowHash } : {}),
    };
  }

  private buildDigestChannelWireVariants(channel: ReticulumChatChannelDigest): ReticulumChatDigestWire[] {
    const full = this.buildDigestChannelWire(channel);
    const variants: ReticulumChatDigestWire[] = [full];
    if (full.wh) {
      const { wh: _wh, ...withoutWindowHash } = full;
      variants.push(withoutWindowHash);
    }
    if (full.oldest || full.wh) {
      variants.push({
        c: full.c,
        ...(full.latest ? { latest: full.latest } : {}),
      });
    }
    return variants.filter((variant, index, all) =>
      all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(variant)) === index
    );
  }

  private buildGroupDigestWire(
    groupId: number,
    offset = 0,
    limit = RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP
  ): ReticulumChatWire {
    const page = this.db.getChannelDigestPage(groupId, limit, offset);
    const channelWires: ReticulumChatDigestWire[] = [];
    for (const channel of page.channels) {
      let accepted: ReticulumChatDigestWire | null = null;
      for (const channelWire of this.buildDigestChannelWireVariants(channel)) {
        const next = [...channelWires, channelWire];
        const candidate: ReticulumChatWire = {
          t: 'RCHAT',
          k: 'group_digest',
          g: groupId,
          latest: this.cursorToWire(this.getGroupLatestCursor(groupId)),
          channels: next,
          ...(page.hasMore ? { more: true, nextOffset: page.nextOffset } : {}),
        };
        if (wireFitsReticulum(candidate)) {
          accepted = channelWire;
          break;
        }
      }
      if (!accepted) break;
      channelWires.push(accepted);
    }
    const digestHash = nodeCrypto
      .createHash('sha256')
      .update(JSON.stringify(channelWires), 'utf8')
      .digest('hex');
    const wireWithoutHash: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'group_digest',
      g: groupId,
      latest: this.cursorToWire(this.getGroupLatestCursor(groupId)),
      channels: channelWires,
      ...(page.hasMore ? { more: true, nextOffset: page.nextOffset } : {}),
    };
    const wireWithHash: ReticulumChatWire = { ...wireWithoutHash, digestHash };
    return wireFitsReticulum(wireWithHash) ? wireWithHash : wireWithoutHash;
  }

  private getGroupLatestCursor(groupId: number): ReticulumChatFeedCursor | null {
    let latest: ReticulumChatFeedCursor | null = null;
    for (const channelId of this.db.getChannels(groupId, true).map((channel) => channel.channelId)) {
      const cursor = this.db.getLatestFeedCursor(groupId, channelId);
      if (!cursor) continue;
      if (!latest || cursor.feedTimestamp > latest.feedTimestamp ||
        (cursor.feedTimestamp === latest.feedTimestamp && cursor.eventId > latest.eventId)) {
        latest = cursor;
      }
    }
    for (const event of this.db.getRecentEvents(groupId, 1_000, null)) {
      const cursor = this.eventCursor(event);
      if (!latest || cursor.feedTimestamp > latest.feedTimestamp ||
        (cursor.feedTimestamp === latest.feedTimestamp && cursor.eventId > latest.eventId)) {
        latest = cursor;
      }
    }
    return latest;
  }

  private buildEventHintWire(event: ReticulumChatEvent): ReticulumChatWire {
    return {
      t: 'RCHAT',
      k: 'group_digest',
      g: event.groupId,
      latest: this.cursorToWire(this.eventCursor(event)),
      channels: [],
    };
  }

  private eventPullKey(groupId: number, eventId: string): string {
    return `${groupId}:${eventId}`;
  }

  private enqueueEventPull(peerHash: string, hint: ReticulumChatEventHint): void {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return;
    const queueKey = this.eventPullKey(hint.groupId, hint.eventId);
    const existing = this.pendingEventPulls.get(queueKey);
    if (existing) {
      existing.peerHashes.add(peerKey);
      this.scheduleEventPullQueue();
      return;
    }
    this.pendingEventPulls.set(queueKey, {
      hint,
      peerHashes: new Set([peerKey]),
      attempts: 0,
      nextAttemptAt: 0,
      inFlight: false,
    });
    this.scheduleEventPullQueue();
  }

  private enqueueRelayQuery(
    groupId: number,
    eventIds: string[],
    reason: string,
    peerHash = ''
  ): void {
    const ids = [...new Set(eventIds)]
      .filter((id) => typeof id === 'string' && id.length >= 8 && !this.db.hasEvent(id))
      .slice(0, RETICULUM_CHAT_RELAY_QUERY_MAX_IDS);
    if (ids.length === 0) return;
    const peer = peerHash.trim().toLowerCase();
    const key = `${groupId}:${peer || 'fanout'}:${ids.sort().join(',')}`;
    const now = this.now();
    if (now - (this.recentRelayQueries.get(key) ?? 0) < RETICULUM_CHAT_RELAY_QUERY_DEBOUNCE_MS) {
      return;
    }
    this.recentRelayQueries.set(key, now);
    const wire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'relay_query',
      g: groupId,
      q: { ids },
    };
    loggerLog(
      `[ReticulumChat] relay_query queued group=${groupId} ids=${ids.length} reason=${reason}${peer ? ` peer=${peer}` : ''}`
    );
    if (peer) void this.sendToPeer(peer, wire);
    else void this.fanout(wire);
  }

  private scheduleEventPullQueue(delayMs = 0): void {
    if (this.eventPullQueueTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.eventPullQueueTimer);
      this.eventPullQueueTimer = null;
    }
    this.eventPullQueueTimer = setTimeout(() => {
      this.eventPullQueueTimer = null;
      void this.processEventPullQueue();
    }, Math.max(0, delayMs));
    this.eventPullQueueTimer.unref?.();
  }

  private async processEventPullQueue(): Promise<void> {
    if (this.eventPullQueueActive) return;
    this.eventPullQueueActive = true;
    try {
      const now = this.now();
      let dispatched = 0;
      for (const [queueKey, item] of this.pendingEventPulls) {
        if (dispatched >= RETICULUM_CHAT_PULL_QUEUE_CONCURRENCY) break;
        if (item.inFlight || item.nextAttemptAt > now) continue;
        if (this.db.hasEvent(item.hint.eventId)) {
          this.pendingEventPulls.delete(queueKey);
          continue;
        }
        if (item.attempts >= RETICULUM_CHAT_PULL_MAX_ATTEMPTS) {
          loggerWarn(
            `[ReticulumChat] Giving up event pull ${item.hint.eventId} after ${item.attempts} attempts`
          );
          this.enqueueRelayQuery(item.hint.groupId, [item.hint.eventId], 'pull-max-attempts');
          this.pendingEventPulls.delete(queueKey);
          continue;
        }
        const peerKey = item.peerHashes.values().next().value;
        if (typeof peerKey !== 'string' || !peerKey) {
          this.enqueueRelayQuery(item.hint.groupId, [item.hint.eventId], 'pull-no-source');
          this.pendingEventPulls.delete(queueKey);
          continue;
        }
        item.inFlight = true;
        dispatched += 1;
        await this.requestEventPull(peerKey, item);
      }
    } finally {
      this.eventPullQueueActive = false;
      if (this.pendingEventPulls.size > 0) {
        this.scheduleEventPullQueue(RETICULUM_CHAT_PULL_QUEUE_TICK_MS);
      }
    }
  }

  private async requestEventPull(peerKey: string, item: ReticulumChatPullQueueItem): Promise<void> {
    const hint = item.hint;
    const requestKey = `${hint.groupId}:${peerKey}:${hint.eventId}`;
    const now = this.now();
    if (now - (this.requestedEventPulls.get(requestKey) ?? 0) < RETICULUM_CHAT_PULL_THROTTLE_MS) {
      item.inFlight = false;
      item.nextAttemptAt = now + RETICULUM_CHAT_PULL_RETRY_MS;
      return;
    }
    this.requestedEventPulls.set(requestKey, now);
    item.attempts += 1;
    const signedRequest = await this.buildSignedEventRequestWire(
      hint.groupId,
      hint.eventId
    );
    if (!signedRequest) {
      item.inFlight = false;
      item.nextAttemptAt = now + RETICULUM_CHAT_PULL_RETRY_MS;
      loggerWarn(
        `[ReticulumChat] Cannot request event ${hint.eventId}: local signing unavailable`
      );
      return;
    }
    const result = await this.sendToPeer(peerKey, {
      t: 'RCHAT',
      k: 'event_req',
      g: hint.groupId,
      q: signedRequest,
    });
    item.inFlight = false;
    if (this.db.hasEvent(hint.eventId)) {
      this.pendingEventPulls.delete(this.eventPullKey(hint.groupId, hint.eventId));
      return;
    }
    if (!result.ok) {
      const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[ReticulumChat] Event pull request failed for ${hint.eventId}:`,
        failed.error ?? failed.reason
      );
      this.enqueueRelayQuery(hint.groupId, [hint.eventId], `pull-send-failed:${failed.reason}`);
      item.nextAttemptAt = now + RETICULUM_CHAT_PULL_RETRY_MS;
      return;
    }
    item.nextAttemptAt = now + RETICULUM_CHAT_PULL_THROTTLE_MS;
  }

  private async sendEventHintToInterestedPeers(
    event: ReticulumChatEvent,
    excludePeerPresenceHashes: string[] = []
  ): Promise<string[]> {
    const peerHashes = this.getInterestedPeers(event.groupId, excludePeerPresenceHashes);
    if (!peerHashes.length) return [];
    const wire = this.buildEventHintWire(event);
    const deliveredPeerHashes: string[] = [];
    for (const peerHash of peerHashes) {
      const result = await this.sendToPeer(peerHash, wire);
      if (result.ok) {
        deliveredPeerHashes.push(peerHash);
      } else {
        const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
        `[ReticulumChat] Targeted event batch failed for ${event.eventId}:`,
          failed.error ?? failed.reason
        );
      }
    }
    return deliveredPeerHashes;
  }

  private async buildSignedEventRequestWire(
    groupId: number,
    eventId: string
  ): Promise<ReticulumChatEventRequestWire | null> {
    if (!this.signLocalFields) return null;
    const timestamp = this.now();
    const signed = await this.signLocalFields({
      eventId,
      groupId,
      timestamp,
      type: 'RCHAT_EVENT_REQ',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign event request:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return null;
    }
    const wire: ReticulumChatEventRequestWire = {
      id: eventId,
      a: signed.authorAddress,
      pk: signed.authorPublicKey,
      ts: timestamp,
      sig: signed.signature,
    };
    if (!verifyReticulumChatEventRequest(groupId, wire, timestamp)) return null;
    return wire;
  }

  private async buildSignedResourceRequestWire(
    groupId: number,
    manifest: ReticulumResourceManifest,
    eventId?: string,
    chunkIndexes: number[] = []
  ): Promise<ReticulumChatResourceRequestWire | null> {
    if (!this.signLocalFields) return null;
    const timestamp = this.now();
    const signed = await this.signLocalFields({
      eventId: null,
      fileHash: manifest.fileHash,
      chunkRanges: chunkIndexesToRanges(chunkIndexes),
      groupId,
      timestamp,
      type: 'RCHAT_RESOURCE_REQ',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign resource request:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return null;
    }
    const requesterIsMember = await this.isValidatedGroupMember(
      groupId,
      signed.authorAddress
    );
    if (!requesterIsMember) {
      loggerWarn(
        `[ReticulumChat] Refusing resource request for group=${groupId}: local signer is not a group member`
      );
      return null;
    }
    this.localGroupIds.add(groupId);
    const baseWire: ReticulumChatResourceRequestWire = {
      fh: manifest.fileHash,
      r: chunkIndexesToRanges(chunkIndexes),
      ...(chunkIndexes.length === 0 ? { cf: true } : {}),
      pk: signed.authorPublicKey,
      ts: timestamp,
      sig: signed.signature,
    };
    if (!verifyReticulumChatResourceRequest(groupId, baseWire, timestamp)) return null;
    if (!wireFitsReticulum({ t: 'RCHAT', k: 'resource_req', g: groupId, q: baseWire })) {
      return null;
    }
    this.trackLocalResourceRequestId(this.resourceRelayRequestId(groupId, baseWire));
    return baseWire;
  }

  private getResourceRequestPeers(groupId: number, eventId?: string): string[] {
    this.pruneEventSourcePeers();
    const peers = new Set<string>();
    if (eventId) {
      for (const peer of this.eventSourcePeers.get(eventId)?.peers ?? []) {
        if (peer) peers.add(peer);
      }
    }
    for (const peer of this.getInterestedPeers(groupId)) {
      if (peer) peers.add(peer);
    }
    return [...peers];
  }

  private noteEventSourcePeer(eventId: string, peerHash: string): void {
    const eventKey = typeof eventId === 'string' ? eventId.trim() : '';
    const peerKey = typeof peerHash === 'string' ? peerHash.trim().toLowerCase() : '';
    if (!eventKey || !peerKey) return;
    const now = this.now();
    let record = this.eventSourcePeers.get(eventKey);
    if (!record) {
      record = { peers: new Set<string>(), updatedAt: now };
      this.eventSourcePeers.set(eventKey, record);
    }
    record.peers.add(peerKey);
    record.updatedAt = now;
    this.pruneEventSourcePeers(now);
  }

  private pruneEventSourcePeers(now = this.now()): void {
    const cutoff = now - RETICULUM_CHAT_EVENT_SOURCE_PEER_TTL_MS;
    for (const [eventId, record] of this.eventSourcePeers.entries()) {
      if (record.updatedAt < cutoff || record.peers.size === 0) {
        this.eventSourcePeers.delete(eventId);
      }
    }
    if (this.eventSourcePeers.size <= RETICULUM_CHAT_EVENT_SOURCE_PEER_MAX_EVENTS) {
      return;
    }
    const excess =
      this.eventSourcePeers.size - RETICULUM_CHAT_EVENT_SOURCE_PEER_MAX_EVENTS;
    const oldest = [...this.eventSourcePeers.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, excess);
    for (const [eventId] of oldest) {
      this.eventSourcePeers.delete(eventId);
    }
  }

  private async buildSignedResourceRequestBatches(
    groupId: number,
    manifest: ReticulumResourceManifest,
    eventId: string | undefined,
    chunkIndexes: number[]
  ): Promise<ReticulumChatResourceRequestWire[]> {
    const batches: ReticulumChatResourceRequestWire[] = [];
    if (chunkIndexes.length === 0) {
      const request = await this.buildSignedResourceRequestWire(
        groupId,
        manifest,
        eventId,
        []
      );
      return request &&
        wireFitsReticulum({ t: 'RCHAT', k: 'resource_req', g: groupId, q: request })
        ? [request]
        : [];
    }
    let remaining = [...chunkIndexes];
    while (remaining.length > 0) {
      let count = Math.min(RETICULUM_CHAT_RESOURCE_CHUNK_REQUEST_LIMIT, remaining.length);
      let request: ReticulumChatResourceRequestWire | null = null;
      while (count > 0) {
        const indexes = remaining.slice(0, count);
        request = await this.buildSignedResourceRequestWire(
          groupId,
          manifest,
          eventId,
          indexes
        );
        if (
          request &&
          wireFitsReticulum({ t: 'RCHAT', k: 'resource_req', g: groupId, q: request })
        ) {
          break;
        }
        count -= 1;
        request = null;
      }
      if (!request || count <= 0) break;
      batches.push(request);
      remaining = remaining.slice(count);
    }
    return batches;
  }

  private getLocalResourcePeerHash(): string | undefined {
    return this.normalizeResourcePeerHash(this.bridge?.getLocalDestinationHash?.());
  }

  private normalizeResourcePeerHash(value: unknown): string | undefined {
    return normalizePeerHashFromWire(value);
  }

  private compactResourcePeerHash(peerHash: string): string {
    return compactPeerHashForWire(peerHash);
  }

  private normalizeResourceRelayRequestId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    return /^[0-9a-f]{8,64}$/.test(normalized) ? normalized : undefined;
  }

  private resourceRelayRequestId(
    groupId: number,
    request: ReticulumChatResourceRequestWire
  ): string | undefined {
    const explicit = this.normalizeResourceRelayRequestId(request.rid);
    if (explicit) return explicit;
    try {
      return nodeCrypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            g: groupId,
            eid: request.eid ?? '',
            fh: request.fh.toLowerCase(),
            r: request.r ?? [],
            cf: request.cf === true,
            pk: request.pk,
            ts: request.ts,
            sig: request.sig,
          }),
          'utf8'
        )
        .digest('hex')
        .slice(0, 16);
    } catch {
      return undefined;
    }
  }

  private pruneResourceRelayRoutes(now = this.now()): void {
    for (const [requestId, route] of this.resourceRelayRoutes) {
      if (route.expiresAt <= now) this.resourceRelayRoutes.delete(requestId);
    }
    for (const [requestId, expiresAt] of this.localResourceRequestIds) {
      if (expiresAt <= now) this.localResourceRequestIds.delete(requestId);
    }
    for (const [requestId, expiresAt] of this.forwardedResourceRequestIds) {
      if (expiresAt <= now) this.forwardedResourceRequestIds.delete(requestId);
    }
    if (this.resourceRelayRoutes.size > RETICULUM_CHAT_RESOURCE_RELAY_MAX_ROUTES) {
      const excess = this.resourceRelayRoutes.size - RETICULUM_CHAT_RESOURCE_RELAY_MAX_ROUTES;
      const oldest = [...this.resourceRelayRoutes.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, excess);
      for (const [requestId] of oldest) this.resourceRelayRoutes.delete(requestId);
    }
    if (this.localResourceRequestIds.size > RETICULUM_CHAT_RESOURCE_RELAY_MAX_ROUTES) {
      const excess = this.localResourceRequestIds.size - RETICULUM_CHAT_RESOURCE_RELAY_MAX_ROUTES;
      const oldest = [...this.localResourceRequestIds.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, excess);
      for (const [requestId] of oldest) this.localResourceRequestIds.delete(requestId);
    }
    if (this.forwardedResourceRequestIds.size > RETICULUM_CHAT_RESOURCE_RELAY_MAX_ROUTES) {
      const excess =
        this.forwardedResourceRequestIds.size - RETICULUM_CHAT_RESOURCE_RELAY_MAX_ROUTES;
      const oldest = [...this.forwardedResourceRequestIds.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, excess);
      for (const [requestId] of oldest) this.forwardedResourceRequestIds.delete(requestId);
    }
  }

  private trackLocalResourceRequestId(requestId?: string): void {
    const normalized = this.normalizeResourceRelayRequestId(requestId);
    if (!normalized) return;
    this.pruneResourceRelayRoutes();
    this.localResourceRequestIds.set(
      normalized,
      this.now() + RETICULUM_CHAT_RESOURCE_RELAY_ROUTE_TTL_MS
    );
  }

  private buildResourceRouteWire(
    groupId: number,
    request: ReticulumChatResourceRequestWire,
    originPeerHash?: string
  ): ReticulumChatWire | null {
    const requestId = this.resourceRelayRequestId(groupId, request);
    const origin =
      this.normalizeResourcePeerHash(originPeerHash) ??
      this.getLocalResourcePeerHash();
    if (!requestId || !origin) return null;
    const wire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'resource_route',
      g: groupId,
      id: requestId,
      o: this.compactResourcePeerHash(origin),
      fh: request.fh.toLowerCase(),
    };
    return wireFitsReticulum(wire) ? wire : null;
  }

  private async sendResourceRequestToPeer(
    peerHash: string,
    groupId: number,
    request: ReticulumChatResourceRequestWire
  ): Promise<ReticulumSendResult> {
    const routeWire = this.buildResourceRouteWire(groupId, request);
    if (routeWire) {
      await this.sendToPeerOnce(peerHash, routeWire);
    }
    return this.sendToPeer(peerHash, {
      t: 'RCHAT',
      k: 'resource_req',
      g: groupId,
      q: request,
    });
  }

  private async fanoutResourceRequest(
    groupId: number,
    request: ReticulumChatResourceRequestWire,
    excludePeerPresenceHashes: string[] = [],
    originPeerHash?: string
  ): Promise<ReticulumSendResult> {
    const requestWire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'resource_req',
      g: groupId,
      q: request,
    };
    const routeWire = this.buildResourceRouteWire(groupId, request, originPeerHash);
    return this.fanoutManyOnce(
      routeWire ? [routeWire, requestWire] : [requestWire],
      excludePeerPresenceHashes
    );
  }

  private handleResourceRoute(
    groupId: number,
    wire: Record<string, unknown>,
    fromPeerHash: string
  ): void {
    const requestId = this.normalizeResourceRelayRequestId(wire.id);
    const reversePeerHash = this.normalizeResourcePeerHash(fromPeerHash);
    const originPeerHash = this.normalizeResourcePeerHash(wire.o);
    if (
      !requestId ||
      !reversePeerHash ||
      !originPeerHash ||
      typeof wire.fh !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(wire.fh)
    ) {
      return;
    }
    const localPeerHash = this.getLocalResourcePeerHash();
    if (localPeerHash && originPeerHash === localPeerHash) return;
    this.pruneResourceRelayRoutes();
    if (this.resourceRelayRoutes.has(requestId)) return;
    this.resourceRelayRoutes.set(requestId, {
      reversePeerHash,
      originPeerHash,
      groupId,
      fileHash: wire.fh.toLowerCase(),
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_RELAY_ROUTE_TTL_MS,
    });
  }

  private async canForwardResourceRequest(
    groupId: number,
    request: ReticulumChatResourceRequestWire
  ): Promise<boolean> {
    if (!this.localGroupIds.has(groupId)) return false;
    const requesterAddress = deriveAddressFromPublicKey(request.pk);
    if (!requesterAddress) return false;
    return this.isValidatedGroupMember(groupId, requesterAddress);
  }

  private async canServeResourceRequestLocally(
    groupId: number,
    request: ReticulumChatResourceRequestWire
  ): Promise<boolean> {
    if (!(await this.canForwardResourceRequest(groupId, request))) return false;
    const manifest = this.resourceStore?.getManifest(request.fh);
    if (!manifest || manifest.fileHash.toLowerCase() !== request.fh.toLowerCase()) return false;
    if (!this.resourceManifestBelongsToGroup(manifest, groupId)) return false;
    if (request.eid) {
      const event = this.db.getEvent(request.eid);
      if (!event || event.groupId !== groupId) return false;
    }
    if (request.cf === true) {
      try {
        this.resourceStore?.assembleResource(manifest.fileHash);
        return true;
      } catch {
        return false;
      }
    }
    const requestedIndexes = chunkRangesToIndexes(request.r ?? []) ?? [];
    if (requestedIndexes.length === 0) return false;
    return requestedIndexes.every((index) => {
      const chunk = this.resourceStore?.getChunk(manifest.fileHash, index);
      return chunk?.status === 'complete' && !!chunk.localPath;
    });
  }

  private async maybeForwardResourceRequest(
    groupId: number,
    request: ReticulumChatResourceRequestWire,
    fromPeerHash: string
  ): Promise<void> {
    const requestId = this.resourceRelayRequestId(groupId, request);
    const reversePeerHash = this.normalizeResourcePeerHash(fromPeerHash);
    if (!requestId || !reversePeerHash) return;
    if (!(await this.canForwardResourceRequest(groupId, request))) return;

    const now = this.now();
    this.pruneResourceRelayRoutes(now);
    if (this.localResourceRequestIds.has(requestId)) return;
    if (this.forwardedResourceRequestIds.has(requestId)) return;
    const existingRoute = this.resourceRelayRoutes.get(requestId);

    const originPeerHash =
      existingRoute?.originPeerHash ??
      this.normalizeResourcePeerHash(request.o) ??
      reversePeerHash;
    const localPeerHash = this.getLocalResourcePeerHash();
    if (localPeerHash && originPeerHash === localPeerHash) return;

    this.resourceRelayRoutes.set(
      requestId,
      existingRoute ?? {
        reversePeerHash,
        originPeerHash,
        groupId,
        fileHash: request.fh.toLowerCase(),
        expiresAt: now + RETICULUM_CHAT_RESOURCE_RELAY_ROUTE_TTL_MS,
      }
    );

    const exclude = [
      reversePeerHash,
      originPeerHash,
      ...(localPeerHash ? [localPeerHash] : []),
    ];
    const result = await this.fanoutResourceRequest(groupId, request, exclude, originPeerHash);
    if (result.ok) {
      this.forwardedResourceRequestIds.set(
        requestId,
        now + RETICULUM_CHAT_RESOURCE_RELAY_ROUTE_TTL_MS
      );
      loggerLog(
        `[ReticulumChat] resource_req_relayed group=${groupId} file=${request.fh.slice(0, 12)} rid=${requestId.slice(0, 12)}`
      );
    }
  }

  private async maybeRelayResourceOffer(
    groupId: number,
    offer: ReticulumChatResourceOffer,
    fromPeerHash: string
  ): Promise<boolean> {
    const requestId = this.normalizeResourceRelayRequestId(offer.relayRequestId);
    if (!requestId) return false;
    this.pruneResourceRelayRoutes();
    if (this.localResourceRequestIds.has(requestId)) return false;
    const route = this.resourceRelayRoutes.get(requestId);
    if (!route || route.groupId !== groupId || route.fileHash !== offer.fileHash.toLowerCase()) {
      return false;
    }
    const reversePeerHash = this.normalizeResourcePeerHash(route.reversePeerHash);
    if (!reversePeerHash) return false;
    const sourcePeerHash =
      this.normalizeResourcePeerHash(offer.sourcePeerHash) ??
      this.normalizeResourcePeerHash(fromPeerHash);
    const wire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'resource_offer',
      g: groupId,
      o: resourceOfferToWire({
        ...offer,
        ...(sourcePeerHash ? { sourcePeerHash } : {}),
        relayRequestId: requestId,
      }),
    };
    if (!wireFitsReticulum(wire)) return false;
    const result = await this.sendToPeerOnce(reversePeerHash, wire);
    if (result.ok) {
      loggerLog(
        `[ReticulumChat] resource_offer_relayed group=${groupId} file=${offer.fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} to=${reversePeerHash.slice(0, 16)}`
      );
    }
    return result.ok;
  }

  private async handleGenericResourceRequest(
    groupId: number,
    candidate: unknown,
    peerHash: string
  ): Promise<void> {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const request = candidate as ReticulumChatResourceRequestWire;
    if (!verifyReticulumChatResourceRequest(groupId, request, this.now())) return;
    const relayRequestId = this.resourceRelayRequestId(groupId, request);
    const route = relayRequestId ? this.resourceRelayRoutes.get(relayRequestId) : undefined;
    const requesterPeerHash =
      route?.originPeerHash ??
      this.normalizeResourcePeerHash(request.o) ??
      this.normalizeResourcePeerHash(peerHash);
    const canServeFully = await this.canServeResourceRequestLocally(groupId, request);
    await this.resourceTransfer?.handleRequest(
      groupId,
      {
        eventId: request.eid,
        fileHash: request.fh,
        chunkIndexes: chunkRangesToIndexes(request.r ?? []) ?? [],
        requireCompleteFile: request.cf === true,
        requesterAddress: deriveAddressFromPublicKey(request.pk),
        ...(requesterPeerHash ? { requesterPeerHash } : {}),
        ...(relayRequestId ? { relayRequestId } : {}),
      },
      peerHash
    );
    if (!canServeFully) {
      void this.maybeForwardResourceRequest(groupId, request, peerHash);
    }
  }

  private handleGenericResourceOffer(candidate: unknown, peerHash: string): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const offer = candidate as Partial<ReticulumChatResourceOffer>;
    if (typeof offer.transferId !== 'string' || !offer.transferId) return;
    if (!Number.isInteger(offer.groupId) || offer.groupId <= 0) return;
    if (offer.eventId != null && (typeof offer.eventId !== 'string' || offer.eventId.length < 8)) return;
    if (typeof offer.fileHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.fileHash)) return;
    if (!Number.isInteger(offer.sizeBytes) || offer.sizeBytes <= 0) return;
    if (offer.chunkIndex != null && (!Number.isInteger(offer.chunkIndex) || offer.chunkIndex < 0)) return;
    if (
      offer.chunkIndex != null &&
      (typeof offer.chunkHash !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(offer.chunkHash) ||
        !Number.isInteger(offer.chunkSize) ||
        offer.chunkSize <= 0)
    ) {
      return;
    }
    if (offer.chunkHash != null && (typeof offer.chunkHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.chunkHash))) {
      return;
    }
    if (offer.chunkSize != null && (!Number.isInteger(offer.chunkSize) || offer.chunkSize <= 0)) return;
    if (offer.bundleHash != null && (typeof offer.bundleHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.bundleHash))) {
      return;
    }
    if (offer.chunkIndexes != null) {
      if (
        !Array.isArray(offer.chunkIndexes) ||
        offer.chunkIndexes.length === 0 ||
        offer.chunkIndexes.some((index) => !Number.isInteger(index) || index < 0)
      ) {
        return;
      }
    }
    if (offer.chunks != null) {
      if (!Array.isArray(offer.chunks) || offer.chunks.length === 0) return;
      for (const chunk of offer.chunks) {
        if (
          !chunk ||
          !Number.isInteger(chunk.index) ||
          chunk.index < 0 ||
          typeof chunk.hash !== 'string' ||
          !/^[0-9a-f]{64}$/i.test(chunk.hash) ||
          !Number.isInteger(chunk.sizeBytes) ||
          chunk.sizeBytes <= 0 ||
          !Number.isInteger(chunk.offset) ||
          chunk.offset < 0
        ) {
          return;
        }
      }
    }
    if (offer.sourcePeerHash != null && !this.normalizeResourcePeerHash(offer.sourcePeerHash)) {
      return;
    }
    if (offer.relayRequestId != null && !this.normalizeResourceRelayRequestId(offer.relayRequestId)) {
      return;
    }
    void this.maybeRelayResourceOffer(
      offer.groupId,
      offer as ReticulumChatResourceOffer,
      peerHash
    ).then((relayed) => {
      if (relayed) return;
      void this.resourceTransfer?.handleOffer(
        this.chatOfferToResourceTransferOffer(offer as ReticulumChatResourceOffer),
        peerHash
      );
    });
  }

  private async handleEventResourceRequest(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    const candidate = wire.q;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const request = candidate as ReticulumChatEventRequestWire;
    if (!verifyReticulumChatEventRequest(groupId, request, this.now())) return;
    const event = this.db.getEvent(request.id);
    if (!event || !this.canServeGroupHistory(groupId)) {
      this.relayGroupControlRequest(
        'event_req',
        groupId,
        wire,
        peerHash,
        this.hashControlPayload({
          id: request.id,
          a: request.a,
          pk: request.pk,
          ts: request.ts,
          sig: request.sig,
        })
      );
      return;
    }
    const requesterIsMember = await this.isValidatedGroupMember(groupId, request.a);
    if (!requesterIsMember) {
      loggerWarn(
        `[ReticulumChat] Refusing event resource ${request.id}: requester is not a group member`
      );
      return;
    }
    await this.offerEventResource(peerHash, groupId, request.id, this.relayResponseOptionsFromWire(wire));
  }

  private isRelayEligibleEvent(event: ReticulumChatEvent): boolean {
    if (event.eventType === 'attachment_manifest') return false;
    const sizeBytes = Buffer.byteLength(serializeReticulumChatEvent(event), 'utf8');
    return sizeBytes > 0 && sizeBytes <= RETICULUM_CHAT_RELAY_EVENT_MAX_BYTES;
  }

  private getRelayCandidatePeers(event: ReticulumChatEvent): string[] {
    this.prunePeerSubscriptions();
    const local = this.localPeerHash();
    const excluded = new Set([local].filter((hash): hash is string => !!hash));
    const interested = new Set(this.getInterestedPeers(event.groupId));
    const peers = [...this.peerSubscriptions.keys()]
      .map((peer) => peer.trim().toLowerCase())
      .filter((peer) => peer && !excluded.has(peer) && !interested.has(peer));
    const establishedPeers = this.getEstablishedOverlayPeerHashes();
    const establishedCandidates = peers.filter((peer) => establishedPeers.has(peer));
    const fallbackCandidates = peers.filter((peer) => !establishedPeers.has(peer));
    return [
      ...this.shuffleRelayPeers(establishedCandidates),
      ...this.shuffleRelayPeers(fallbackCandidates),
    ].slice(0, RETICULUM_CHAT_RELAY_REPLICATION_TARGET);
  }

  private getEstablishedOverlayPeerHashes(): Set<string> {
    if (!this.bridge || typeof this.bridge.getOverlayLinkSnapshots !== 'function') {
      return new Set();
    }
    return new Set(
      this.bridge
        .getOverlayLinkSnapshots()
        .map((snap) => snap.peerPresenceHash.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  private shuffleRelayPeers(peers: string[]): string[] {
    const shuffled = [...peers];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = nodeCrypto.randomInt(index + 1);
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  private async replicateEventToRelayCache(event: ReticulumChatEvent): Promise<void> {
    if (!this.isRelayEligibleEvent(event)) return;
    const peers = this.getRelayCandidatePeers(event);
    if (peers.length === 0) {
      const now = this.now();
      if (now - this.lastRelayNoPeersLogAt >= 60_000) {
        this.lastRelayNoPeersLogAt = now;
        loggerLog(`[ReticulumChat] relay_store skipped reason=no-relay-peers`);
      }
      return;
    }
    let accepted = 0;
    for (const peerHash of peers) {
      const result = await this.offerEventResource(peerHash, event.groupId, event.eventId, {
        relayStore: true,
      });
      if (result.ok) accepted += 1;
      else {
        const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[ReticulumChat] relay_store send failed event=${event.eventId} peer=${peerHash}:`,
          failed.error ?? failed.reason
        );
      }
    }
    loggerLog(
      `[ReticulumChat] relay_store queued event=${event.eventId} peers=${peers.length} accepted=${accepted}`
    );
  }

  private async handleRelayQuery(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    if (!peerHash) return;
    const query = wire.q;
    if (!query || typeof query !== 'object' || Array.isArray(query)) return;
    const q = query as Partial<ReticulumChatRelayQueryWire>;
    const ids = Array.isArray(q.ids)
      ? q.ids
          .filter((id): id is string => typeof id === 'string' && id.length >= 8)
          .slice(0, RETICULUM_CHAT_RELAY_QUERY_MAX_IDS)
      : [];
    if (ids.length === 0) return;
    if (!this.shouldServeControlRequest({ k: 'relay_query', ids }, groupId, peerHash)) return;

    let offered = 0;
    const relayOptions = this.relayResponseOptionsFromWire(wire);
    for (const eventId of ids) {
      const localEvent = this.db.getEvent(eventId);
      if (localEvent && localEvent.groupId === groupId && this.isRelayEligibleEvent(localEvent)) {
        const result = await this.offerEventResource(peerHash, groupId, eventId, {
          relayCached: true,
          ...relayOptions,
        });
        if (result.ok) offered += 1;
        continue;
      }
      const cached = this.db.getRelayEventBlob(groupId, eventId, this.now());
      if (!cached) continue;
      const result = await this.offerRelayCachedEventResource(
        peerHash,
        cached,
        relayOptions
      );
      if (result.ok) offered += 1;
      else {
        const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[ReticulumChat] relay_query offer failed group=${groupId} event=${eventId} peer=${peerHash}:`,
          failed.error ?? failed.reason
        );
      }
    }
    if (offered === 0) {
      const relayed = this.relayGroupControlRequest(
        'relay_query',
        groupId,
        wire,
        peerHash,
        this.hashControlPayload({ ids })
      );
      if (relayed) {
        loggerLog(
          `[ReticulumChat] relay_query forwarded group=${groupId} peer=${peerHash} requested=${ids.length}`
        );
        return;
      }
    }
    loggerLog(
      `[ReticulumChat] relay_query served group=${groupId} peer=${peerHash} requested=${ids.length} offered=${offered}`
    );
  }

  private relayDigestEntryToWire(
    entry: ReticulumChatRelayDigestEntry
  ): ReticulumChatRelayDigestEntryWire {
    return {
      id: entry.eventId,
      ts: entry.timestamp,
      c: normalizeReticulumChatChannelId(entry.channelId),
      a: entry.authorAddress,
      seq: entry.authorSeq,
      ph: entry.payloadHash,
      bid: entry.blobId,
    };
  }

  private buildRelayDigestWire(
    groupId: number,
    entries: ReticulumChatRelayDigestEntry[],
    more: boolean,
    offset: number
  ): Extract<ReticulumChatWire, { k: 'relay_digest' }> | null {
    const fullEvents = entries.map((entry) => this.relayDigestEntryToWire(entry));
    for (let eventCount = fullEvents.length; eventCount > 0; eventCount -= 1) {
      const page = fullEvents.slice(0, eventCount);
      for (let compactLevel = 0; compactLevel <= 4; compactLevel += 1) {
        const events = page.map((event) => {
          const compacted: ReticulumChatRelayDigestEntryWire = {
            id: event.id,
            ts: event.ts,
            c: event.c,
          };
          if (compactLevel <= 3 && event.seq != null) compacted.seq = event.seq;
          if (compactLevel <= 2 && event.a) compacted.a = event.a;
          if (compactLevel <= 1 && event.ph) compacted.ph = event.ph;
          if (compactLevel === 0 && event.bid) compacted.bid = event.bid;
          return compacted;
        });
        const wire: Extract<ReticulumChatWire, { k: 'relay_digest' }> = {
          t: 'RCHAT',
          k: 'relay_digest',
          g: groupId,
          events,
          ...(more ? { more: true, nextOffset: offset + events.length } : {}),
        };
        if (wireFitsReticulum(wire)) return wire;
      }
    }
    return null;
  }

  private async serveRelayDigestForGroup(peerHash: string, groupId: number): Promise<void> {
    const peer = peerHash.trim().toLowerCase();
    if (!peer) return;
    const key = `${peer}:${groupId}`;
    const now = this.now();
    const lastServedAt = this.recentRelayDigestsServed.get(key);
    if (lastServedAt != null && now - lastServedAt < RETICULUM_CHAT_RELAY_DIGEST_DEBOUNCE_MS) {
      return;
    }
    const firstEntry = this.db.listRelayDigestEntries(groupId, 0, 1, now);
    if (firstEntry.length === 0) {
      this.recentRelayDigestsServed.set(key, now);
      loggerLog(
        `[ReticulumChat] relay_digest_skipped group=${groupId} peer=${peer} reason=empty`
      );
      return;
    }
    this.recentRelayDigestsServed.set(key, now);
    let offset = 0;
    let served = 0;
    let more = false;
    while (served < RETICULUM_CHAT_RELAY_DIGEST_MAX_EVENTS_PER_SUB) {
      const limit = Math.min(
        RETICULUM_CHAT_RELAY_DIGEST_PAGE_SIZE,
        RETICULUM_CHAT_RELAY_DIGEST_MAX_EVENTS_PER_SUB - served
      );
      const entries = this.db.listRelayDigestEntries(groupId, offset, limit, now);
      if (entries.length === 0) {
        more = false;
        break;
      }
      const potentiallyMore =
        entries.length > 1 ||
        this.db.listRelayDigestEntries(groupId, offset + entries.length, 1, now).length > 0;
      const wire = this.buildRelayDigestWire(
        groupId,
        entries,
        potentiallyMore,
        offset
      );
      if (!wire) {
        loggerWarn(
          `[ReticulumChat] relay_digest_skipped group=${groupId} peer=${peer} reason=wire_too_large`
        );
        break;
      }
      const sentCount = wire.events.length;
      if (sentCount === 0) break;
      const result = await this.sendToPeer(peer, wire);
      if (!result.ok) {
        const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[ReticulumChat] relay_digest send failed group=${groupId} peer=${peer}:`,
          failed.error ?? failed.reason
        );
        break;
      }
      served += sentCount;
      offset += sentCount;
      more = this.db.listRelayDigestEntries(groupId, offset, 1, now).length > 0;
      if (!more) break;
    }
    loggerLog(
      `[ReticulumChat] relay_digest_served group=${groupId} peer=${peer} count=${served} more=${more}`
    );
  }

  private handleRelayDigest(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): void {
    void this.forwardGroupDigestToInterestRoutes(groupId, wire, peerHash);
    if (!this.localGroupIds.has(groupId) || !this.subscribedGroups.has(groupId)) return;
    if (this.shouldDropDuplicateInboundControlWire(wire, groupId, peerHash)) return;
    if (!Array.isArray(wire.events)) return;
    const missing: string[] = [];
    const entries = wire.events.slice(0, RETICULUM_CHAT_RELAY_DIGEST_MAX_EVENTS_PER_SUB);
    for (const rawEntry of entries) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as Partial<ReticulumChatRelayDigestEntryWire>;
      if (
        typeof entry.id !== 'string' ||
        entry.id.length < 8 ||
        typeof entry.ts !== 'number' ||
        typeof entry.c !== 'string' ||
        (entry.a != null && typeof entry.a !== 'string') ||
        (entry.seq != null && !Number.isInteger(entry.seq)) ||
        (entry.ph != null && typeof entry.ph !== 'string') ||
        (entry.bid != null && typeof entry.bid !== 'string')
      ) {
        continue;
      }
      if (!this.db.hasEvent(entry.id)) missing.push(entry.id);
    }
    loggerLog(
      `[ReticulumChat] relay_digest_received group=${groupId} peer=${peerHash} entries=${entries.length} missing=${missing.length}`
    );
    if (missing.length > 0) {
      this.enqueueRelayQuery(groupId, missing, 'relay-digest', peerHash);
    }
  }

  private handleRelayAck(groupId: number, ack: unknown, peerHash: string): void {
    if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return;
    const a = ack as Partial<ReticulumChatRelayAckWire>;
    if (typeof a.id !== 'string' || a.id.length < 8 || typeof a.ok !== 'boolean') return;
    loggerLog(
      `[ReticulumChat] relay_ack group=${groupId} event=${a.id} peer=${peerHash} ok=${a.ok}${
        a.reason ? ` reason=${a.reason}` : ''
      }${a.bid ? ` blob=${a.bid}` : ''}`
    );
  }

  private sendRelayAck(
    peerHash: string,
    groupId: number,
    eventId: string,
    ok: boolean,
    reason?: string,
    blobId?: string
  ): void {
    const peer = peerHash.trim().toLowerCase();
    if (!peer) return;
    const wire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'relay_ack',
      g: groupId,
      a: {
        id: eventId,
        ok,
        ...(reason ? { reason } : {}),
        ...(blobId ? { bid: blobId } : {}),
      },
    };
    if (wireFitsReticulum(wire)) void this.sendToPeer(peer, wire);
  }

  private async offerRelayCachedEventResource(
    peerHash: string,
    entry: ReticulumChatRelayCacheEntry,
    options: Omit<ReticulumChatEventOfferOptions, 'continuation'> = {}
  ): Promise<ReticulumSendResult> {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return { ok: false, reason: 'unknown-peer-presence-hash' };
    if (!this.bridge) return { ok: false, reason: 'bridge-unavailable' };
    if (typeof this.bridge.sendReticulumChatResourceDetailed !== 'function') {
      return { ok: false, reason: 'send-command-failed', error: 'Bridge chat resource send unavailable' };
    }
    let event: ReticulumChatEvent;
    try {
      const parsed = JSON.parse(entry.payloadJson) as unknown;
      if (!this.canStoreRelayEventResource(parsed)) {
        return { ok: false, reason: 'send-command-failed', error: 'Invalid relay cache event blob' };
      }
      event = parsed;
    } catch {
      return { ok: false, reason: 'send-command-failed', error: 'Invalid relay cache JSON' };
    }
    const wireHash = reticulumChatRelayBlobId(entry.payloadJson);
    if (wireHash !== entry.blobId) {
      return { ok: false, reason: 'send-command-failed', error: 'Relay cache blob hash mismatch' };
    }
    const transferId = nodeCrypto.randomBytes(8).toString('hex');
    const filePath = this.writeTempEventBlob(transferId, entry.payloadJson);
    const recipientPeerKey = (options.recipientPeerHash ?? peerKey).trim().toLowerCase();
    const registered = await this.bridge.sendReticulumChatResourceDetailed({
      allowedRecipientAddress: recipientPeerKey,
      transferId,
      filePath,
      fileName: `${event.eventId}.json`,
      size: entry.sizeBytes,
      sha256: entry.blobId,
      metadata: {
        resourceType: 'reticulum_chat_event',
        eventId: event.eventId,
        groupId: event.groupId,
        payloadHash: event.payloadHash,
        wireHash: entry.blobId,
        sizeBytes: entry.sizeBytes,
        relayCached: true,
        relayBlobId: entry.blobId,
      },
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    if (!registered.ok) return registered;
    this.outboundRelayCachedEventResources.set(transferId, {
      groupId: event.groupId,
      eventId: event.eventId,
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    const offer: ReticulumChatEventOffer = {
      transferId,
      eventId: event.eventId,
      groupId: event.groupId,
      payloadHash: event.payloadHash,
      wireHash: entry.blobId,
      sizeBytes: entry.sizeBytes,
      sourcePeerHash: options.sourcePeerHash ?? entry.sourcePeerHash,
      ...(options.relayRequestId ? { relayRequestId: options.relayRequestId } : {}),
      relayCached: true,
      relayBlobId: entry.blobId,
    };
    return this.sendToPeer(peerKey, {
      t: 'RCHAT',
      k: 'event_offer',
      g: event.groupId,
      o: eventOfferToWire(offer),
    });
  }

  private async offerEventResource(
    peerHash: string,
    groupId: number,
    eventId: string,
    options: ReticulumChatEventOfferOptions = {}
  ): Promise<ReticulumSendResult> {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return { ok: false, reason: 'unknown-peer-presence-hash' };
    if (!this.bridge) return { ok: false, reason: 'bridge-unavailable' };
    if (!this.localGroupIds.has(groupId)) {
      return { ok: false, reason: 'send-command-failed', error: 'Not a local group member' };
    }
    const event = this.db.getEvent(eventId);
    if (!event || event.groupId !== groupId) {
      return { ok: false, reason: 'send-command-failed', error: 'Event not found for group' };
    }
    const authorIsMember = await this.isValidatedGroupMember(
      event.groupId,
      event.authorAddress
    );
    if (!authorIsMember) {
      return { ok: false, reason: 'send-command-failed', error: 'Event author is not a group member' };
    }
    if (typeof this.bridge.sendReticulumChatResourceDetailed !== 'function') {
      return { ok: false, reason: 'send-command-failed', error: 'Bridge chat resource send unavailable' };
    }
    const blob = serializeReticulumChatEvent(event);
    const wireHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
    const transferId = nodeCrypto.randomBytes(8).toString('hex');
    const filePath = this.writeTempEventBlob(transferId, blob);
    const offer: ReticulumChatEventOffer = {
      transferId,
      eventId: event.eventId,
      groupId,
      payloadHash: event.payloadHash,
      wireHash,
      sizeBytes: Buffer.byteLength(blob, 'utf8'),
      ...(options.continuation ? { continuation: options.continuation } : {}),
      ...(options.relayRequestId ? { relayRequestId: options.relayRequestId } : {}),
      ...(options.sourcePeerHash ? { sourcePeerHash: options.sourcePeerHash } : {}),
      ...(options.relayStore ? { relayStore: true } : {}),
      ...(options.relayCached ? { relayCached: true } : {}),
      ...(options.relayBlobId ? { relayBlobId: options.relayBlobId } : {}),
    };
    const recipientPeerKey = (options.recipientPeerHash ?? peerKey).trim().toLowerCase();
    const registered = await this.bridge.sendReticulumChatResourceDetailed({
      allowedRecipientAddress: recipientPeerKey,
      transferId,
      filePath,
      fileName: `${event.eventId}.json`,
      size: offer.sizeBytes,
      sha256: wireHash,
      metadata: {
        resourceType: 'reticulum_chat_event',
        eventId: event.eventId,
        groupId,
        payloadHash: event.payloadHash,
        wireHash,
        sizeBytes: offer.sizeBytes,
        relayStore: options.relayStore === true,
        relayCached: options.relayCached === true,
        relayBlobId: options.relayBlobId ?? '',
      },
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    if (!registered.ok) return registered;
    let offerWire = eventOfferToWire(offer);
    let wire: ReticulumChatWire = { t: 'RCHAT', k: 'event_offer', g: groupId, o: offerWire };
    if (options.continuation && !wireFitsReticulum(wire)) {
      const compactOffer = { ...offer };
      delete compactOffer.continuation;
      offerWire = eventOfferToWire(compactOffer);
      wire = { t: 'RCHAT', k: 'event_offer', g: groupId, o: offerWire };
      loggerWarn(
        `[ReticulumChat] Dropping oversized event offer continuation group=${groupId} channel=${options.continuation.channelId} event=${event.eventId}`
      );
    }
    return this.sendToPeer(peerKey, wire);
  }

  private handleEventOffer(candidate: unknown, peerHash: string): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      loggerWarn('[ReticulumChat] Dropping inbound event offer: invalid offer payload');
      return;
    }
    const offer = candidate as Partial<ReticulumChatEventOffer>;
    if (!this.isValidEventOffer(offer)) {
      loggerWarn('[ReticulumChat] Dropping inbound event offer: invalid offer shape');
      return;
    }
    if (offer.relayStore === true) {
      this.acceptRelayStoreEventOffer(offer as ReticulumChatEventOffer, peerHash);
      return;
    }
    const relayRequestId = this.normalizeGroupControlRequestId(offer.relayRequestId);
    const hasImplicitRelayRoute =
      !relayRequestId &&
      !!this.routePeerHash(offer.sourcePeerHash) &&
      [...this.eventRelayRoutes.values()].some(
        (route) => route.groupId === offer.groupId && route.eventId === offer.eventId
      );
    if (!relayRequestId && !hasImplicitRelayRoute) {
      this.acceptLocalEventOffer(offer as ReticulumChatEventOffer, peerHash);
      return;
    }
    void this.maybeRelayEventOffer(
      offer.groupId,
      offer as ReticulumChatEventOffer,
      peerHash
    ).then((relayed) => {
      if (relayed) return;
      this.acceptLocalEventOffer(offer as ReticulumChatEventOffer, peerHash);
    });
  }

  private acceptLocalEventOffer(offer: ReticulumChatEventOffer, peerHash: string): void {
    if (!this.subscribedGroups.has(offer.groupId) || !this.localGroupIds.has(offer.groupId)) {
      loggerWarn(
        `[ReticulumChat] Dropping inbound event offer ${offer.eventId}: group=${offer.groupId} subscribed=${this.subscribedGroups.has(offer.groupId)} localMember=${this.localGroupIds.has(offer.groupId)}`
      );
      return;
    }
    if (this.db.hasEvent(offer.eventId)) return;
    const sourcePeerHash =
      this.routePeerHash(offer.sourcePeerHash) ??
      peerHash.trim().toLowerCase();
    const trackedOffer = {
      ...offer,
      sourcePeerHash,
    };
    this.noteEventSourcePeer(offer.eventId, sourcePeerHash);
    this.resourceOffers.set(offer.transferId, trackedOffer);
    void this.acceptEventResource(sourcePeerHash, trackedOffer);
  }

  private acceptRelayStoreEventOffer(offer: ReticulumChatEventOffer, peerHash: string): void {
    const sourcePeerHash = this.routePeerHash(peerHash) ?? peerHash.trim().toLowerCase();
    if (!sourcePeerHash) return;
    if (offer.sizeBytes > RETICULUM_CHAT_RELAY_EVENT_MAX_BYTES) {
      loggerWarn(
        `[ReticulumChat] relay_store rejected event=${offer.eventId} reason=payload-too-large size=${offer.sizeBytes}`
      );
      this.sendRelayAck(sourcePeerHash, offer.groupId, offer.eventId, false, 'payload-too-large');
      return;
    }
    const trackedOffer = {
      ...offer,
      sourcePeerHash,
    };
    this.resourceOffers.set(offer.transferId, trackedOffer);
    void this.acceptEventResource(sourcePeerHash, trackedOffer);
  }

  private isValidEventOffer(offer: Partial<ReticulumChatEventOffer>): offer is ReticulumChatEventOffer {
    if (typeof offer.transferId !== 'string' || !offer.transferId) return false;
    if (typeof offer.eventId !== 'string' || offer.eventId.length < 8) return false;
    if (!Number.isInteger(offer.groupId) || offer.groupId <= 0) return false;
    if (typeof offer.payloadHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.payloadHash)) return false;
    if (typeof offer.wireHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.wireHash)) return false;
    if (!Number.isInteger(offer.sizeBytes) || offer.sizeBytes <= 0) return false;
    if (offer.relayRequestId != null && !this.normalizeGroupControlRequestId(offer.relayRequestId)) return false;
    if (offer.sourcePeerHash != null && !this.routePeerHash(offer.sourcePeerHash)) return false;
    if (offer.relayStore != null && typeof offer.relayStore !== 'boolean') return false;
    if (offer.relayCached != null && typeof offer.relayCached !== 'boolean') return false;
    if (offer.relayBlobId != null && !/^[0-9a-f]{64}$/i.test(offer.relayBlobId)) return false;
    if (offer.continuation) {
      if (offer.continuation.direction !== 'after' && offer.continuation.direction !== 'before') return false;
      if (typeof offer.continuation.channelId !== 'string' || !offer.continuation.channelId) return false;
      if (
        typeof offer.continuation.cursor?.eventId !== 'string' ||
        offer.continuation.cursor.eventId.length < 8 ||
        !Number.isFinite(offer.continuation.cursor.feedTimestamp)
      ) {
        return false;
      }
    }
    return true;
  }

  private async maybeRelayEventOffer(
    groupId: number,
    offer: ReticulumChatEventOffer,
    inboundPeerHash: string
  ): Promise<boolean> {
    const requestId = this.normalizeGroupControlRequestId(offer.relayRequestId);
    this.pruneGroupControlRoutes();
    const routes = requestId
      ? [this.eventRelayRoutes.get(requestId)].filter((route): route is ReticulumChatEventRelayRoute => !!route)
      : [...this.eventRelayRoutes.values()].filter(
          (route) => route.groupId === groupId && route.eventId === offer.eventId
        );
    if (routes.length === 0) return false;
    const local = this.localPeerHash();
    const sourcePeerHash =
      this.routePeerHash(offer.sourcePeerHash) ??
      this.routePeerHash(inboundPeerHash);
    if (!sourcePeerHash) return false;
    let relayed = false;
    for (const route of routes) {
      if (route.groupId !== groupId || route.eventId !== offer.eventId) continue;
      if (local && route.originPeerHash === local) continue;
      const relayOffer: ReticulumChatEventOffer = {
        ...offer,
        sourcePeerHash,
        ...(requestId ? { relayRequestId: requestId } : {}),
      };
      const wire: ReticulumChatWire = {
        t: 'RCHAT',
        k: 'event_offer',
        g: groupId,
        o: eventOfferToWire(relayOffer),
      };
      const result = await this.sendToPeer(route.reversePeerHash, wire);
      relayed = result.ok || relayed;
    }
    return relayed;
  }

  private isValidReticulumResourceManifest(candidate: unknown): candidate is ReticulumResourceManifest {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const manifest = candidate as Partial<ReticulumResourceManifest>;
    if (typeof manifest.namespace !== 'string' || !manifest.namespace) return false;
    if (typeof manifest.fileName !== 'string' || !manifest.fileName) return false;
    if (typeof manifest.mimeType !== 'string' || !manifest.mimeType) return false;
    if (!Number.isInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0) return false;
    if (!Number.isInteger(manifest.chunkSize) || manifest.chunkSize <= 0) return false;
    if (typeof manifest.fileHash !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.fileHash)) return false;
    if (!Array.isArray(manifest.chunkHashes) || manifest.chunkHashes.length === 0) return false;
    if (manifest.chunkHashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash))) {
      return false;
    }
    return true;
  }

  private resourceManifestBelongsToGroup(
    manifest: ReticulumResourceManifest,
    groupId: number
  ): boolean {
    const metadata = manifest.metadata && typeof manifest.metadata === 'object' ? manifest.metadata : {};
    const metadataGroupId = Number(metadata.groupId);
    if (Number.isInteger(metadataGroupId) && metadataGroupId === groupId) return true;
    const ownerId = typeof manifest.ownerId === 'string' ? manifest.ownerId : '';
    if (ownerId.startsWith(`${groupId}:`) || ownerId.startsWith(`group:${groupId}:`)) return true;
    return false;
  }

  private async acceptEventResource(peerHash: string, offer: ReticulumChatEventOffer): Promise<void> {
    if (!this.bridge || typeof this.bridge.acceptReticulumChatResourceDetailed !== 'function') {
      this.handleEventResourceFailure(offer.transferId, 'accept_unavailable');
      return;
    }
    const senderHash = (offer.senderReticulumDestinationHash || peerHash).trim().toLowerCase();
    if (!senderHash) {
      loggerWarn(`[ReticulumChat] Cannot accept event resource ${offer.eventId}: missing sender Reticulum identity`);
      this.handleEventResourceFailure(offer.transferId, 'missing_sender_identity');
      return;
    }
    const result = await this.bridge.acceptReticulumChatResourceDetailed({
      peerPresenceHash: senderHash,
      reticulumIdentityPublicKeyBase64: offer.senderReticulumIdentityPublicKeyBase64?.trim() ?? '',
      transferId: offer.transferId,
      savePath: this.tempEventBlobPath(`${offer.transferId}.recv`),
      fileName: `${offer.eventId}.json`,
      size: offer.sizeBytes,
      sha256: offer.wireHash,
      authMessage: {
        type: 'RETICULUM_CHAT_RESOURCE_AUTH',
        transferId: offer.transferId,
        eventId: offer.eventId,
        groupId: offer.groupId,
      },
    });
    if (!result.ok) {
      const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
      this.handleEventResourceFailure(
        offer.transferId,
        failed.error ?? failed.reason ?? 'accept_failed'
      );
    }
  }

  handleResourceEvent(payload: ReticulumChatResourcePayload): void {
    if (payload?.status === 'auth' && payload.linkId && payload.transferId) {
      void this.authorizeResource(payload);
      return;
    }
    if (payload?.status === 'failed' && payload.transferId) {
      this.handleEventResourceFailure(
        payload.transferId,
        typeof payload.reason === 'string' ? payload.reason : 'resource_failed'
      );
      return;
    }
    if (payload?.status !== 'received' || !payload.path || !payload.transferId) return;
    void this.importReceivedEventResource(payload);
  }

  handleGenericResourceEvent(payload: ReticulumChatResourcePayload): void {
    this.resourceTransfer?.handleResourceEvent(payload);
  }

  private async importReceivedEventResource(payload: ReticulumChatResourcePayload): Promise<void> {
    if (!payload.path || !payload.transferId) return;
    const offer = this.resourceOffers.get(payload.transferId);
    if (!offer) return;
    try {
      const blob = fs.readFileSync(payload.path, 'utf8');
      const wireHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
      if (wireHash !== offer.wireHash.toLowerCase()) {
        this.retryEventPullAfterResourceFailure(offer, 'wire_hash_mismatch');
        return;
      }
      const parsed = JSON.parse(blob) as unknown;
      if (offer.relayStore === true) {
        if (!this.canStoreRelayEventResource(parsed)) {
          loggerWarn(
            `[ReticulumChat] relay_store rejected event=${offer.eventId} reason=invalid_event_resource`
          );
          this.sendRelayAck(offer.sourcePeerHash || payload.peerPresenceHash || '', offer.groupId, offer.eventId, false, 'invalid_event_resource');
          return;
        }
        const event = parsed as ReticulumChatEvent;
        if (event.groupId !== offer.groupId || event.eventId !== offer.eventId) {
          loggerWarn(
            `[ReticulumChat] relay_store rejected event=${offer.eventId} reason=offer_mismatch`
          );
          this.sendRelayAck(offer.sourcePeerHash || payload.peerPresenceHash || '', offer.groupId, offer.eventId, false, 'offer_mismatch');
          return;
        }
        const stored = this.db.storeRelayEventBlob(
          event,
          blob,
          offer.sourcePeerHash || payload.peerPresenceHash || '',
          this.now()
        );
        if ('reason' in stored) {
          loggerWarn(
            `[ReticulumChat] relay_store rejected event=${event.eventId} reason=${stored.reason}`
          );
          this.sendRelayAck(offer.sourcePeerHash || payload.peerPresenceHash || '', offer.groupId, offer.eventId, false, stored.reason);
          return;
        }
        loggerLog(
          `[ReticulumChat] relay_store accepted event=${event.eventId} group=${event.groupId} blob=${stored.blobId} stored=${stored.stored}`
        );
        this.sendRelayAck(offer.sourcePeerHash || payload.peerPresenceHash || '', offer.groupId, offer.eventId, true, undefined, stored.blobId);
        return;
      }
      if (!this.canAcceptInboundEventResource(parsed)) {
        this.retryEventPullAfterResourceFailure(offer, 'invalid_event_resource');
        return;
      }
      const candidate = parsed as ReticulumChatEvent;
      const authorIsMember = await this.isValidatedGroupMember(
        candidate.groupId,
        candidate.authorAddress
      );
      if (!authorIsMember) {
        this.retryEventPullAfterResourceFailure(offer, 'non_member_event_author');
        return;
      }
      const event = parsed as ReticulumChatEvent;
      const sourcePeerHash = offer.sourcePeerHash || payload.peerPresenceHash || '';
      this.requestMissingAuthorRangeBeforeAccept(event, sourcePeerHash);
      if (this.acceptEvent(parsed, false)) {
        this.noteEventSourcePeer(event.eventId, sourcePeerHash);
        this.pendingEventPulls.delete(this.eventPullKey(event.groupId, event.eventId));
        this.emit('event', { event });
        this.requestFeedContinuationFromOffer(offer, event, sourcePeerHash);
        const exclude = payload.peerPresenceHash ? [payload.peerPresenceHash] : [];
        void this.sendEventHintToInterestedPeers(event, exclude).then((targetedPeers) => {
          void this.fanout(this.buildEventHintWire(event), [...exclude, ...targetedPeers]);
        });
      } else {
        this.retryEventPullAfterResourceFailure(offer, 'invalid_event_resource');
      }
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to import event resource:', err);
      this.retryEventPullAfterResourceFailure(offer, 'resource_import_failed');
    } finally {
      this.resourceOffers.delete(payload.transferId);
    }
  }

  private requestFeedContinuationFromOffer(
    offer: ReticulumChatEventOffer,
    event: ReticulumChatEvent,
    peerHash: string
  ): void {
    const continuation = offer.continuation;
    const peer = peerHash.trim().toLowerCase();
    if (!continuation || !peer) return;
    if (event.eventId !== continuation.cursor.eventId) return;
    if (event.groupId !== offer.groupId) return;
    if (!this.localGroupIds.has(event.groupId) || !this.subscribedGroups.has(event.groupId)) return;
    if (
      continuation.channelId !== RETICULUM_CHAT_ALL_CHANNELS_ID &&
      normalizeReticulumChatChannelId(event.channelId) !== continuation.channelId
    ) {
      return;
    }
    const wire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'feed_req',
      g: event.groupId,
      c: continuation.channelId,
      [continuation.direction]: this.cursorToWire(continuation.cursor),
      limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
    };
    loggerLog(
      `[ReticulumChat] Requesting feed continuation group=${event.groupId} channel=${continuation.channelId} peer=${peer.slice(0, 16)} direction=${continuation.direction} cursor=${continuation.cursor.eventId}`
    );
    void this.sendToPeer(peer, wire);
  }

  private canAcceptInboundEventResource(candidate: unknown): candidate is ReticulumChatEvent {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    if (!validateReticulumChatEventShape(candidate, this.now())) return false;
    const event = candidate as ReticulumChatEvent;
    if (!this.localGroupIds.has(event.groupId)) return false;
    return verifyReticulumChatEvent(event);
  }

  private canStoreRelayEventResource(candidate: unknown): candidate is ReticulumChatEvent {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    if (!validateReticulumChatEventShape(candidate, this.now())) return false;
    const event = candidate as ReticulumChatEvent;
    if (!this.isRelayEligibleEvent(event)) return false;
    return verifyReticulumChatEvent(event);
  }

  private handleEventResourceFailure(transferId: string, reason: string): void {
    const offer = this.resourceOffers.get(transferId);
    if (!offer) return;
    this.resourceOffers.delete(transferId);
    this.retryEventPullAfterResourceFailure(offer, reason);
  }

  private retryEventPullAfterResourceFailure(
    offer: ReticulumChatEventOffer,
    reason: string
  ): void {
    const queueKey = this.eventPullKey(offer.groupId, offer.eventId);
    const item = this.pendingEventPulls.get(queueKey);
    if (!item || this.db.hasEvent(offer.eventId)) return;
    const failedPeer = (
      offer.sourcePeerHash ||
      offer.senderReticulumDestinationHash ||
      ''
    ).trim().toLowerCase();
    if (failedPeer) item.peerHashes.delete(failedPeer);
    item.inFlight = false;
    item.nextAttemptAt = 0;
    if (item.peerHashes.size === 0) {
      this.enqueueRelayQuery(offer.groupId, [offer.eventId], `resource-failed:${reason}`);
      this.pendingEventPulls.delete(queueKey);
      return;
    }
    loggerWarn(
      `[ReticulumChat] Event resource failed for ${offer.eventId}, trying another peer:`,
      reason
    );
    this.scheduleEventPullQueue();
  }

  private async authorizeResource(payload: ReticulumChatResourcePayload): Promise<void> {
    if (!this.bridge || !payload.linkId || !payload.transferId) return;
    const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
    const eventId = String(auth.eventId || payload.eventId || '');
    const groupId = Number(auth.groupId || payload.groupId || 0);
    if (!eventId || !Number.isInteger(groupId) || groupId <= 0) {
      await this.bridge.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
        reason: 'bad_resource_auth',
      });
      return;
    }
    const event = this.db.getEvent(eventId);
    if (!event || event.groupId !== groupId) {
      const now = this.now();
      for (const [transferId, relay] of this.outboundRelayCachedEventResources) {
        if (relay.expiresAt <= now) this.outboundRelayCachedEventResources.delete(transferId);
      }
      const relay = this.outboundRelayCachedEventResources.get(payload.transferId);
      if (relay && relay.groupId === groupId && relay.eventId === eventId && relay.expiresAt > now) {
        await this.bridge.authorizeReticulumChatResourceDetailed?.({
          linkId: payload.linkId,
          transferId: payload.transferId,
        });
        return;
      }
      await this.bridge.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
        reason: 'unknown_event',
      });
      return;
    }
    await this.bridge.authorizeReticulumChatResourceDetailed?.({
      linkId: payload.linkId,
      transferId: payload.transferId,
    });
  }

  private tempEventBlobPath(name: string): string {
    const dir = path.join(app.getPath('temp'), 'qortal-reticulum-chat-events');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, path.basename(name));
  }

  private writeTempEventBlob(transferId: string, contents: string): string {
    const filePath = this.tempEventBlobPath(`${transferId}.json`);
    fs.writeFileSync(filePath, contents, 'utf8');
    return filePath;
  }

  private applyTyping(
    groupId: number,
    channelId: string,
    authorAddress: string,
    active: boolean
  ): void {
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const key = `${groupId}:${normalizedChannelId}:${authorAddress}`;
    const existing = this.typingTimers.get(key);
    if (existing) clearTimeout(existing);
    if (!active) {
      this.typingTimers.delete(key);
      this.emit('typing', {
        groupId,
        channelId: normalizedChannelId,
        authorAddress,
        active: false,
      });
      return;
    }
    this.emit('typing', {
      groupId,
      channelId: normalizedChannelId,
      authorAddress,
      active: true,
    });
    const timer = setTimeout(() => {
      this.typingTimers.delete(key);
      this.emit('typing', {
        groupId,
        channelId: normalizedChannelId,
        authorAddress,
        active: false,
      });
    }, RETICULUM_CHAT_TYPING_TTL_MS);
    timer.unref?.();
    this.typingTimers.set(key, timer);
  }

  private startSubscriptionRefreshTimer(): void {
    if (this.subscriptionRefreshTimer || this.subscribedGroups.size === 0) return;
    this.scheduleSubscriptionRefresh();
  }

  private stopSubscriptionRefreshTimer(): void {
    if (!this.subscriptionRefreshTimer) return;
    clearTimeout(this.subscriptionRefreshTimer);
    this.subscriptionRefreshTimer = null;
  }

  private stopSubscriptionFanoutTimer(): void {
    if (!this.subscriptionFanoutTimer) return;
    clearTimeout(this.subscriptionFanoutTimer);
    this.subscriptionFanoutTimer = null;
  }

  private clearSubscriptionFanoutQueue(): void {
    this.subscriptionFanoutQueue = [];
    this.subscriptionFanoutQueuedKeys.clear();
    this.subscriptionFanoutSentInBatch = 0;
    this.stopSubscriptionFanoutTimer();
  }

  private enqueueSubscriptionFanouts(wires: ReticulumChatWire[]): void {
    const now = this.now();
    for (const wire of wires) {
      const key = this.subscriptionFanoutKey(wire);
      if (!key) continue;
      if (wire.k === 'group_digest') {
        if (this.subscriptionFanoutQueuedKeys.has(key)) {
          this.replaceQueuedSubscriptionFanout(key, wire);
          continue;
        }
      } else if (this.subscriptionFanoutQueuedKeys.has(key)) {
        continue;
      }
      if (wire.k !== 'group_digest') {
        const lastSentAt = this.subscriptionFanoutLastSentAt.get(key) ?? 0;
        if (now - lastSentAt < RETICULUM_CHAT_SUBSCRIPTION_FANOUT_DEDUPE_MS) continue;
      }
      this.subscriptionFanoutQueuedKeys.add(key);
      this.subscriptionFanoutQueue.push(wire);
    }
    this.drainSubscriptionFanoutQueue();
  }

  private replaceQueuedSubscriptionFanout(key: string, wire: ReticulumChatWire): void {
    const index = this.subscriptionFanoutQueue.findIndex((queued) => this.subscriptionFanoutKey(queued) === key);
    if (index >= 0) this.subscriptionFanoutQueue[index] = wire;
  }

  private removeQueuedSubscriptionFanouts(groupId: number): void {
    this.subscriptionFanoutQueue = this.subscriptionFanoutQueue.filter((wire) => {
      const remove = this.getWireGroupIds(wire).includes(groupId);
      if (remove) {
        const key = this.subscriptionFanoutKey(wire);
        if (key) this.subscriptionFanoutQueuedKeys.delete(key);
      }
      return !remove;
    });
  }

  private scheduleSubscriptionFanoutDrain(): void {
    if (this.subscriptionFanoutTimer) return;
    this.subscriptionFanoutTimer = setTimeout(() => {
      this.subscriptionFanoutTimer = null;
      this.subscriptionFanoutSentInBatch = 0;
      this.drainSubscriptionFanoutQueue();
    }, RETICULUM_CHAT_SUBSCRIPTION_FANOUT_BATCH_INTERVAL_MS);
    this.subscriptionFanoutTimer.unref?.();
  }

  private drainSubscriptionFanoutQueue(): void {
    while (
      this.subscriptionFanoutQueue.length > 0 &&
      this.subscriptionFanoutSentInBatch < RETICULUM_CHAT_SUBSCRIPTION_FANOUT_BATCH_SIZE
    ) {
      const wire = this.subscriptionFanoutQueue.shift();
      if (!wire) break;
      const key = this.subscriptionFanoutKey(wire);
      if (key) this.subscriptionFanoutQueuedKeys.delete(key);
      const groups = this.getWireGroupIds(wire);
      if (
        groups.length > 0 &&
        !groups.some((groupId) => this.subscribedGroups.has(groupId) && this.localGroupIds.has(groupId))
      ) {
        continue;
      }
      this.subscriptionFanoutSentInBatch += 1;
      if (key) this.subscriptionFanoutLastSentAt.set(key, this.now());
      void this.fanout(wire);
    }
    if (this.subscriptionFanoutQueue.length > 0 || this.subscriptionFanoutSentInBatch > 0) {
      this.scheduleSubscriptionFanoutDrain();
    }
  }

  private scheduleSubscriptionRefresh(): void {
    if (this.subscriptionRefreshTimer || this.subscribedGroups.size === 0) return;
    const jitter = Math.floor(Math.random() * RETICULUM_CHAT_SUBSCRIPTION_REFRESH_JITTER_MS);
    this.subscriptionRefreshTimer = setTimeout(() => {
      this.subscriptionRefreshTimer = null;
      this.refreshSubscriptions();
      this.scheduleSubscriptionRefresh();
    }, RETICULUM_CHAT_SUBSCRIPTION_REFRESH_MS + jitter);
    this.subscriptionRefreshTimer.unref?.();
  }

  private refreshSubscriptions(): void {
    this.prunePeerSubscriptions();
    const groups = this.getSubscriptions();
    const wires: ReticulumChatWire[] = [];
    for (let offset = 0; offset < groups.length; offset += RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE) {
      const page = groups.slice(offset, offset + RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE);
      if (page.length) wires.push({ t: 'RCHAT', k: 'group_sub', groups: page, mode: 'summary' });
    }
    for (const groupId of this.getDigestRefreshGroups(groups)) {
      wires.push(this.buildGroupDigestWire(groupId));
    }
    this.enqueueSubscriptionFanouts(wires);
  }

  private getDigestRefreshGroups(groups: number[]): number[] {
    const now = this.now();
    for (const [groupId, observedAt] of this.activeDigestGroups) {
      if (
        now - observedAt > RETICULUM_CHAT_ACTIVE_GROUP_DIGEST_TTL_MS ||
        !this.subscribedGroups.has(groupId) ||
        !this.localGroupIds.has(groupId)
      ) {
        this.activeDigestGroups.delete(groupId);
      }
    }

    const groupSet = new Set(groups);
    const activeGroups = [...this.activeDigestGroups.entries()]
      .filter(([groupId]) => groupSet.has(groupId))
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([groupId]) => groupId)
      .slice(0, RETICULUM_CHAT_MAX_DIGEST_GROUPS_PER_PAGE);

    const slots = RETICULUM_CHAT_MAX_DIGEST_GROUPS_PER_PAGE - activeGroups.length;
    if (slots <= 0) return activeGroups;

    const activeSet = new Set(activeGroups);
    const backgroundGroups = groups.filter((groupId) => !activeSet.has(groupId));
    if (backgroundGroups.length === 0) {
      this.subscriptionDigestRefreshOffset = 0;
      return activeGroups;
    }

    const start = this.subscriptionDigestRefreshOffset % backgroundGroups.length;
    const count = Math.min(slots, backgroundGroups.length);
    const rotated: number[] = [];
    for (let index = 0; index < count; index += 1) {
      rotated.push(backgroundGroups[(start + index) % backgroundGroups.length]);
    }
    this.subscriptionDigestRefreshOffset = (start + Math.max(1, count)) % backgroundGroups.length;
    return [...activeGroups, ...rotated];
  }

  private getWireGroupIds(wire: ReticulumChatWire): number[] {
    if ('g' in wire && Number.isInteger(wire.g) && wire.g > 0) return [wire.g];
    if (wire.k === 'group_sub') return wire.groups.filter((groupId) => Number.isInteger(groupId) && groupId > 0);
    return [];
  }

  private subscriptionFanoutKey(wire: ReticulumChatWire): string {
    if (wire.k === 'hello') return 'hello';
    if (wire.k === 'group_sub') {
      const groups = wire.groups
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
        .sort((a, b) => a - b);
      return `group_sub:${wire.mode}:${groups.join(',')}`;
    }
    if (wire.k === 'group_digest') return `group_digest:${wire.g}`;
    return this.hashControlPayload(wire);
  }

  private shouldRequestGroupRepair(
    peerHash: string,
    groupId: number,
    scope = 'group'
  ): boolean {
    const key = `${peerHash.trim().toLowerCase()}:${groupId}:${scope}`;
    const now = this.now();
    const lastRequestedAt = this.recentGroupRepairRequests.get(key) ?? 0;
    if (now - lastRequestedAt < RETICULUM_CHAT_GROUP_REPAIR_DEBOUNCE_MS) return false;
    this.recentGroupRepairRequests.set(key, now);
    return true;
  }

  private notePeerSubscription(peerHash: string, groupId: number, active: boolean): void {
    const key = peerHash.trim().toLowerCase();
    if (!key) return;
    this.prunePeerSubscriptions();
    const groups = this.peerSubscriptions.get(key) ?? new Map<number, number>();
    if (active) groups.set(groupId, this.now() + RETICULUM_CHAT_PEER_SUBSCRIPTION_TTL_MS);
    else groups.delete(groupId);
    if (groups.size) this.peerSubscriptions.set(key, groups);
    else this.peerSubscriptions.delete(key);
  }

  private prunePeerSubscriptions(now = this.now()): void {
    for (const [peerHash, groups] of this.peerSubscriptions) {
      for (const [groupId, expiresAt] of groups) {
        if (expiresAt <= now) groups.delete(groupId);
      }
      if (groups.size === 0) this.peerSubscriptions.delete(peerHash);
    }
  }

  private getInterestedPeers(
    groupId: number,
    excludePeerPresenceHashes: string[] = []
  ): string[] {
    this.prunePeerSubscriptions();
    const excluded = new Set(
      excludePeerPresenceHashes.map((hash) => hash.trim().toLowerCase()).filter(Boolean)
    );
    const peers: string[] = [];
    for (const [peerHash, groups] of this.peerSubscriptions) {
      if (groups.has(groupId) && !excluded.has(peerHash)) peers.push(peerHash);
    }
    return peers;
  }

  private async fanout(
    wire: ReticulumChatWire,
    excludePeerPresenceHashes: string[] = []
  ): Promise<ReticulumSendResult> {
    const result = await this.fanoutOnce(wire, excludePeerPresenceHashes);
    if (result.ok === false && this.shouldRetryControlSend(wire, result.reason)) {
      this.enqueueControlRetry({ wire, excludePeerPresenceHashes });
    }
    return result;
  }

  private async fanoutOnce(
    wire: ReticulumChatWire,
    excludePeerPresenceHashes: string[] = []
  ): Promise<ReticulumSendResult> {
    return this.fanoutManyOnce([wire], excludePeerPresenceHashes);
  }

  private async fanoutManyOnce(
    wires: ReticulumChatWire[],
    excludePeerPresenceHashes: string[] = []
  ): Promise<ReticulumSendResult> {
    if (!this.bridge) return { ok: false, reason: 'bridge-unavailable' };
    for (const wire of wires) {
      if (!wireFitsReticulum(wire)) {
        return {
          ok: false,
          reason: 'wire-too-large',
          error: `Reticulum chat wire ${byteLengthUtf8JsonWithBridgeSender(wire)} bytes exceeds ${RT_RETICULUM_MAX_WIRE_JSON_BYTES}`,
        };
      }
    }
    if (typeof this.bridge.fanoutReticulumChatDetailed !== 'function') {
      return { ok: false, reason: 'send-command-failed', error: 'Bridge chat fanout unavailable' };
    }
    return this.bridge.fanoutReticulumChatDetailed(wires, excludePeerPresenceHashes);
  }

  private async sendToPeer(peerHash: string, wire: ReticulumChatWire): Promise<ReticulumSendResult> {
    const result = await this.sendToPeerOnce(peerHash, wire);
    if (result.ok === false && this.shouldRetryControlSend(wire, result.reason)) {
      this.enqueueControlRetry({ peerHash: peerHash.trim().toLowerCase(), wire });
    }
    return result;
  }

  private async sendToPeerOnce(peerHash: string, wire: ReticulumChatWire): Promise<ReticulumSendResult> {
    const key = peerHash.trim().toLowerCase();
    if (!key || !this.bridge) return { ok: false, reason: 'unknown-peer-presence-hash' };
    if (!wireFitsReticulum(wire)) {
      return {
        ok: false,
        reason: 'wire-too-large',
        error: `Reticulum chat wire ${byteLengthUtf8JsonWithBridgeSender(wire)} bytes exceeds ${RT_RETICULUM_MAX_WIRE_JSON_BYTES}`,
      };
    }
    if (typeof this.bridge.sendReticulumChatDetailed !== 'function') {
      return { ok: false, reason: 'send-command-failed', error: 'Bridge chat send unavailable' };
    }
    return this.bridge.sendReticulumChatDetailed(key, wire);
  }

  private shouldRetryControlSend(
    wire: ReticulumChatWire,
    reason: ReticulumSendFailureReason
  ): boolean {
    if (!this.isRetryableControlWire(wire)) return false;
    return (
      reason === 'no-route' ||
      reason === 'packet-send-false' ||
      reason === 'bridge-not-ready' ||
      reason === 'bridge-timeout' ||
      reason === 'bridge-exception' ||
      reason === 'bridge-overloaded' ||
      reason === 'bridge-not-started'
    );
  }

  private isRetryableControlWire(wire: ReticulumChatWire): boolean {
    switch (wire.k) {
      case 'feed_req':
      case 'digest_req':
      case 'range_req':
      case 'event_req':
      case 'relay_query':
      case 'relay_digest':
      case 'event_offer':
      case 'event_batch':
        return true;
      default:
        return false;
    }
  }

  private controlRetryKey(item: {
    wire: ReticulumChatWire;
    peerHash?: string;
    excludePeerPresenceHashes?: string[];
  }): string {
    const target = item.peerHash
      ? `peer:${item.peerHash.trim().toLowerCase()}`
      : `fanout:${[...(item.excludePeerPresenceHashes ?? [])].map((hash) => hash.trim().toLowerCase()).sort().join(',')}`;
    return `${target}:${this.hashControlPayload(item.wire)}`;
  }

  private enqueueControlRetry(item: {
    wire: ReticulumChatWire;
    peerHash?: string;
    excludePeerPresenceHashes?: string[];
  }): void {
    const key = this.controlRetryKey(item);
    const now = this.now();
    const existing = this.controlRetryQueue.get(key);
    if (existing) {
      existing.wire = item.wire;
      existing.peerHash = item.peerHash?.trim().toLowerCase();
      existing.excludePeerPresenceHashes = item.excludePeerPresenceHashes;
      existing.nextAttemptAt = Math.min(existing.nextAttemptAt, now + RETICULUM_CHAT_CONTROL_RETRY_MS);
      this.scheduleControlRetryQueue(RETICULUM_CHAT_CONTROL_RETRY_TICK_MS);
      return;
    }
    if (this.controlRetryQueue.size >= RETICULUM_CHAT_CONTROL_RETRY_MAX) {
      const oldestKey = this.controlRetryQueue.keys().next().value as string | undefined;
      if (oldestKey) this.controlRetryQueue.delete(oldestKey);
    }
    this.controlRetryQueue.set(key, {
      key,
      wire: item.wire,
      peerHash: item.peerHash?.trim().toLowerCase(),
      excludePeerPresenceHashes: item.excludePeerPresenceHashes,
      attempts: 0,
      nextAttemptAt: now + RETICULUM_CHAT_CONTROL_RETRY_MS,
    });
    this.scheduleControlRetryQueue(RETICULUM_CHAT_CONTROL_RETRY_TICK_MS);
  }

  private scheduleControlRetryQueue(delayMs: number): void {
    if (this.controlRetryTimer) return;
    this.controlRetryTimer = setTimeout(() => {
      this.controlRetryTimer = null;
      void this.drainControlRetryQueue();
    }, Math.max(0, delayMs));
    this.controlRetryTimer.unref?.();
  }

  private async drainControlRetryQueue(): Promise<void> {
    if (this.controlRetryActive) return;
    this.controlRetryActive = true;
    try {
      const now = this.now();
      for (const item of [...this.controlRetryQueue.values()]) {
        if (item.nextAttemptAt > now) continue;
        item.attempts += 1;
        const result = item.peerHash
          ? await this.sendToPeerOnce(item.peerHash, item.wire)
          : await this.fanoutOnce(item.wire, item.excludePeerPresenceHashes ?? []);
        if (result.ok) {
          this.controlRetryQueue.delete(item.key);
          continue;
        }
        if (result.ok === false && (
          item.attempts >= RETICULUM_CHAT_CONTROL_RETRY_MAX_ATTEMPTS ||
          !this.shouldRetryControlSend(item.wire, result.reason)
        )) {
          this.controlRetryQueue.delete(item.key);
          loggerWarn(
            `[ReticulumChat] Control retry dropped kind=${item.wire.k} attempts=${item.attempts}:`,
            result.error ?? result.reason
          );
          continue;
        }
        item.nextAttemptAt = this.now() + RETICULUM_CHAT_CONTROL_RETRY_MS;
      }
    } finally {
      this.controlRetryActive = false;
      if (this.controlRetryQueue.size > 0) {
        this.scheduleControlRetryQueue(RETICULUM_CHAT_CONTROL_RETRY_TICK_MS);
      }
    }
  }

  private attachBridge(bridge: ReticulumBridge | null): void {
    if (!bridge) return;
    bridge.on('reticulum-chat-message', this.onBridgeChatMessage);
    bridge.on('reticulum-chat-resource', this.onBridgeChatResource);
    bridge.on('reticulum-resource', this.onBridgeGenericResource);
  }

  private detachBridge(): void {
    if (!this.bridge) return;
    this.bridge.off('reticulum-chat-message', this.onBridgeChatMessage);
    this.bridge.off('reticulum-chat-resource', this.onBridgeChatResource);
    this.bridge.off('reticulum-resource', this.onBridgeGenericResource);
  }

  private onBridgeChatMessage = (
    wire: Record<string, unknown>,
    senderDestinationHash: string,
    peerPresenceHash: string
  ): void => {
    try {
      this.handleWire(wire, peerPresenceHash, senderDestinationHash);
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to handle inbound wire:', err);
    }
  };

  private onBridgeChatResource = (payload: ReticulumChatResourcePayload): void => {
    try {
      this.handleResourceEvent(payload);
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to handle resource event:', err);
    }
  };

  private onBridgeGenericResource = (payload: ReticulumChatResourcePayload): void => {
    try {
      this.handleGenericResourceEvent(payload);
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to handle generic resource event:', err);
    }
  };

  private assertGroupId(groupId: number): void {
    if (!Number.isInteger(groupId) || groupId <= 0) {
      throw new Error('Invalid groupId');
    }
  }

  private assertLocalGroupMember(groupId: number): void {
    this.assertGroupId(groupId);
    if (!this.localGroupIds.has(groupId)) {
      throw new Error('Local user is not a member of this group');
    }
  }
}

let singleton: ReticulumChatManager | null = null;

export function readReticulumChatHistoryFromDb(
  groupId: number,
  channelId = RETICULUM_CHAT_DEFAULT_CHANNEL_ID,
  limit = 100
): ReticulumChatEvent[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    return db.getRecentEvents(groupId, Math.max(1, Math.min(500, limit)), channelId);
  } finally {
    db.close();
  }
}

export function readReticulumChatChannelMetadataHistoryFromDb(
  groupId: number,
  limit = 200
): ReticulumChatEvent[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    return db.getChannelMetadataEvents(groupId, Math.max(1, Math.min(500, limit)));
  } finally {
    db.close();
  }
}

export function readReticulumChatSummariesFromDb(
  myAddress = '',
  onlineSince = 0
): ReticulumGroupChatSummary[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.getChatSummaries(myAddress, onlineSince);
  } finally {
    db.close();
  }
}

export function readReticulumChatSyncStateFromDb(
  groupId: number
): Record<string, number> {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return {};
    return db.getSyncState(groupId);
  } finally {
    db.close();
  }
}

export function markReticulumChatReadInDb(
  groupId: number,
  channelId: string,
  upToTimestamp: number,
  myAddress = ''
): void {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return;
    db.markRead(groupId, channelId, upToTimestamp, myAddress);
  } finally {
    db.close();
  }
}

export function searchReticulumChatFromDb(
  query: string,
  options: { groupIds?: number[]; channelIds?: string[]; limit?: number } = {}
): ReticulumChatSearchResult[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.searchEvents(query, options);
  } finally {
    db.close();
  }
}

export function readReticulumChatChannelsFromDb(
  groupId: number,
  includeArchived = false
): ReticulumGroupChannel[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    return db.getChannels(groupId, includeArchived);
  } finally {
    db.close();
  }
}

export function readReticulumChatCategoriesFromDb(
  groupId: number
): ReticulumGroupCategory[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    return db.getCategories(groupId);
  } finally {
    db.close();
  }
}

export function applyReticulumChatChannelMetadataInDb(
  eventId: string,
  payload: unknown
): Promise<boolean> {
  const manager = new ReticulumChatManager({
    dbPath: defaultReticulumChatDbPath(),
  });
  return manager.applyChannelMetadataEvent(eventId, payload).finally(() => {
    manager.close();
  });
}

export function startReticulumChatManager(
  bridge?: ReticulumBridge | null,
  dbPath?: string,
  options: Pick<
    ReticulumChatManagerOptions,
    'signLocalFields' | 'validateGroupMember' | 'validateGroupAdmin' | 'resourceStore'
  > = {}
): ReticulumChatManager {
  if (singleton) {
    singleton.setBridge(bridge ?? null);
    singleton.setRuntimeCallbacks(options);
    return singleton;
  }
  singleton = new ReticulumChatManager({
    bridge: bridge ?? null,
    dbPath,
    signLocalFields: options.signLocalFields,
    validateGroupMember: options.validateGroupMember,
    validateGroupAdmin: options.validateGroupAdmin,
    resourceStore: options.resourceStore,
  });
  loggerLog('[ReticulumChat] Manager started');
  return singleton;
}
export function indexReticulumChatSearchTextInDb(
  eventId: string,
  text: string
): boolean {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.indexSearchText(eventId, text);
  } finally {
    db.close();
  }
}

export function deleteReticulumChatSearchTextInDb(eventId: string): boolean {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.deleteSearchText(eventId);
  } finally {
    db.close();
  }
}

export function replaceReticulumChatMentionsInDb(
  eventId: string,
  mentionedAddresses: string[]
): boolean {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.replaceMentionsForEvent(eventId, mentionedAddresses);
  } finally {
    db.close();
  }
}

export function deleteReticulumChatMentionsInDb(eventId: string): boolean {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.deleteMentionsForEvent(eventId);
  } finally {
    db.close();
  }
}

export function getReticulumChatManager(): ReticulumChatManager | null {
  return singleton;
}

export function stopReticulumChatManager(): void {
  singleton?.close();
  singleton = null;
}
