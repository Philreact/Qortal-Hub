import Database, { type Database as DB, type Statement } from 'better-sqlite3';
import * as nodeCrypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ReticulumChatEvent,
  ReticulumChatMentionTarget,
  ReticulumDmEvent,
  ReticulumDmSummary,
} from './reticulum-chat';

export const RETICULUM_CHAT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const RETICULUM_CHAT_RELAY_CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const RETICULUM_CHAT_RELAY_CACHE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const RETICULUM_CHAT_RELAY_EVENT_MAX_BYTES = 32 * 1024;
export const RETICULUM_CHAT_DEFAULT_CHANNEL_ID = 'general';
export const RETICULUM_CHAT_QORTAL_LAND_CHANNEL_ID = 'qortal-land';
export const RETICULUM_CHAT_QORTAL_LAND_CHANNEL_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const RETICULUM_CHAT_CHANNEL_WRITE_MODE_MEMBERS = 'members';
export const RETICULUM_CHAT_CHANNEL_WRITE_MODE_ADMINS = 'admins';
export const RETICULUM_CHAT_CHANNEL_READ_MODE_MEMBERS = 'members';
export const RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS = 'admins';

const RETICULUM_CHAT_EXPIRY_PRUNE_INTERVAL_MS = 60 * 1000;
const RETICULUM_CHAT_VISIBLE_EVENT_SQL =
  "(expires_at IS NULL OR expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000)";

export type ReticulumGroupChannelWriteMode =
  | typeof RETICULUM_CHAT_CHANNEL_WRITE_MODE_MEMBERS
  | typeof RETICULUM_CHAT_CHANNEL_WRITE_MODE_ADMINS;

export type ReticulumGroupChannelReadMode =
  | typeof RETICULUM_CHAT_CHANNEL_READ_MODE_MEMBERS
  | typeof RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS;

export type ReticulumGroupChannel = {
  channelId: string;
  groupId: number;
  categoryId?: string;
  name: string;
  description?: string;
  position: number;
  archived: boolean;
  writeMode: ReticulumGroupChannelWriteMode;
  readMode: ReticulumGroupChannelReadMode;
  writeModeUpdatedAt: number;
  expiryDurationMs?: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

type ReticulumGroupChannelInput = Omit<
  ReticulumGroupChannel,
  'readMode' | 'writeModeUpdatedAt'
> & {
  readMode?: ReticulumGroupChannelReadMode;
  writeModeUpdatedAt?: number;
};

export type ReticulumGroupCategory = {
  categoryId: string;
  groupId: number;
  name: string;
  position: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type ReticulumChatAuthorHead = {
  authorAddress: string;
  maxSeq: number;
  eventId: string;
  timestamp: number;
};

export type ReticulumChatAuthorSequenceGap = {
  authorAddress: string;
  fromSeq: number;
  toSeq: number;
};

export type ReticulumChatFeedCursor = {
  eventId: string;
  feedTimestamp: number;
};

export type ReticulumChatChannelDigest = {
  groupId: number;
  channelId: string;
  latestCursor: ReticulumChatFeedCursor | null;
  oldestCursor: ReticulumChatFeedCursor | null;
  visibleWindowHash: string;
};

export type ReticulumChatSummary = {
  groupId: number;
  channelId: string;
  lastEvent: ReticulumChatEvent | null;
  unreadCount: number;
  mentionCount: number;
  hasUnreadMention: boolean;
  updatedAt: number;
};

export type ReticulumGroupChatSummary = {
  groupId: number;
  lastEvent: ReticulumChatEvent | null;
  unreadCount: number;
  mentionCount: number;
  hasUnreadMention: boolean;
  updatedAt: number;
  channels: ReticulumChatSummary[];
};

export type ReticulumChatSearchResult = {
  event: ReticulumChatEvent;
  snippet: string;
  cursor?: ReticulumChatSearchCursor;
};

export type ReticulumChatSearchCursor = {
  createdAt: number;
  eventId: string;
};

export type ReticulumChatSearchOptions = {
  groupIds?: number[];
  channelIds?: string[];
  authorAddresses?: string[];
  eventTypes?: Array<'message' | 'attachment_manifest'>;
  beforeTimestamp?: number;
  afterTimestamp?: number;
  hasAttachment?: boolean;
  hasLink?: boolean;
  sort?: 'relevance' | 'newest' | 'oldest';
  limit?: number;
  offset?: number;
  cursor?: ReticulumChatSearchCursor;
  includeAdminPrivate?: boolean;
};

export type ReticulumChatMessageWindowOptions = {
  beforeLimit?: number;
  afterLimit?: number;
  includeAdminPrivate?: boolean;
};

export type ReticulumChatRelayCacheEntry = {
  blobId: string;
  eventId: string;
  groupId: number;
  groupHash: string;
  createdAt: number;
  expiresAt: number;
  sizeBytes: number;
  encoding: 'plain-json-v1';
  encryption: 'none';
  keyEpoch: number | null;
  encryptedKeyId: string | null;
  payloadJson: string;
  sourcePeerHash: string;
  servedCount: number;
  lastServedAt: number | null;
};

export type ReticulumChatRelayDigestEntry = {
  blobId: string;
  eventId: string;
  groupId: number;
  channelId: string;
  authorAddress: string;
  authorSeq: number;
  timestamp: number;
  payloadHash: string;
  createdAt: number;
};

export type ReticulumChatGroupKey = {
  groupId: number;
  epoch: number;
  keyId: string;
  keyBytesBase64: string;
  createdBy: string;
  createdAt: number;
  status: 'active' | 'superseded';
  adminPublicKey: string;
  adminSignature: string;
};

export type ReticulumChatGroupKeyDigest = {
  groupId: number;
  epoch: number;
  keyId: string;
  createdBy: string;
  createdAt: number;
  adminPublicKey: string;
  adminSignature: string;
  sourcePeerHash: string;
  seenAt: number;
};

export type ReticulumChatGroupKeyRequest = {
  groupId: number;
  epoch: number;
  keyId: string;
  requestId: string;
  requestedAt: number;
  attempts: number;
  status: 'pending' | 'fulfilled' | 'failed';
};

type ReticulumChatMissingRangeRow = {
  group_id: number;
  author_address: string;
  from_seq: number;
  to_seq: number;
  preferred_peer?: string | null;
  attempts?: number;
  next_attempt_at?: number;
};

export type ReticulumChatMissingRangeState = {
  groupId: number;
  authorAddress: string;
  fromSeq: number;
  toSeq: number;
  preferredPeer: string;
  attempts: number;
  nextAttemptAt: number;
};

export type ReticulumChatMetadataSnapshotRecord = {
  groupId: number;
  snapshotId: string;
  version: number;
  createdAt: number;
  latestEventId: string;
  latestFeedTimestamp: number;
  snapshotHash: string;
  adminAddress: string;
  adminPublicKey: string;
  signature: string;
  channels: ReticulumGroupChannel[];
  categories: ReticulumGroupCategory[];
};

type EventRow = {
  event_id: string;
  group_id: number;
  channel_id: string;
  author_address: string;
  author_public_key: string;
  author_seq: number;
  timestamp: number;
  feed_timestamp: number;
  event_type: string;
  target_event_id: string | null;
  reply_to_event_id: string | null;
  encrypted_payload: string;
  payload_hash: string;
  mention_address_hashes: string;
  mention_targets?: string;
  signature: string;
  own_event: number;
  last_served_at: number;
  stored_at: number;
  accepted_at: number;
  wire_bytes: number;
  scrubbed_at?: number | null;
  expires_at?: number | null;
};

type DirectEventRow = {
  event_id: string;
  conversation_id: string;
  sender_address: string;
  recipient_address: string;
  sender_public_key: string;
  sender_seq: number;
  timestamp: number;
  event_type: string;
  target_event_id: string | null;
  reply_to_event_id: string | null;
  payload: string;
  payload_hash: string;
  signature: string;
  own_event: number;
  read_at: number;
  stored_at: number;
  wire_bytes: number;
  delivery_status?: string;
  delivery_updated_at?: number;
};

type MessageProjectionRow = {
  root_event_id: string;
  group_id: number;
  channel_id: string;
  author_address: string;
  author_public_key: string;
  author_seq: number;
  created_at: number;
  root_event_type: string;
  current_event_id: string;
  updated_at: number;
  reply_to_event_id: string | null;
  encrypted_payload: string;
  payload_hash: string;
  mention_address_hashes: string;
  mention_targets: string;
  signature: string;
  deleted_at: number | null;
  deleted_event_id: string | null;
  expires_at?: number | null;
  has_attachment?: number | null;
};

type RelayCacheRow = {
  blob_id: string;
  event_id: string;
  group_id: number;
  group_hash: string;
  created_at: number;
  expires_at: number;
  size_bytes: number;
  encoding: string;
  encryption: string;
  key_epoch: number | null;
  encrypted_key_id: string | null;
  payload_json: string;
  source_peer_hash: string;
  served_count: number;
  last_served_at: number | null;
};

type GroupKeyRow = {
  group_id: number;
  epoch: number;
  key_id: string;
  key_bytes_base64: string;
  created_by: string;
  created_at: number;
  status: string;
  admin_public_key: string;
  admin_signature: string;
};

type GroupKeyDigestRow = {
  group_id: number;
  epoch: number;
  key_id: string;
  created_by: string;
  created_at: number;
  admin_public_key: string;
  admin_signature: string;
  source_peer_hash: string;
  seen_at: number;
};

type GroupKeyRequestRow = {
  group_id: number;
  epoch: number;
  key_id: string;
  request_id: string;
  requested_at: number;
  attempts: number;
  status: string;
};

type MetadataSnapshotRow = {
  group_id: number;
  snapshot_id: string;
  version: number;
  created_at: number;
  latest_event_id: string;
  latest_feed_timestamp: number;
  snapshot_hash: string;
  admin_address: string;
  admin_public_key: string;
  signature: string;
  channels_json: string;
  categories_json: string;
};

function relayRowToEntry(row: RelayCacheRow): ReticulumChatRelayCacheEntry {
  return {
    blobId: row.blob_id,
    eventId: row.event_id,
    groupId: row.group_id,
    groupHash: row.group_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sizeBytes: row.size_bytes,
    encoding: 'plain-json-v1',
    encryption: 'none',
    keyEpoch: row.key_epoch,
    encryptedKeyId: row.encrypted_key_id,
    payloadJson: row.payload_json,
    sourcePeerHash: row.source_peer_hash,
    servedCount: row.served_count,
    lastServedAt: row.last_served_at,
  };
}

function metadataSnapshotRowToRecord(
  row: MetadataSnapshotRow
): ReticulumChatMetadataSnapshotRecord {
  let channels: ReticulumGroupChannel[] = [];
  let categories: ReticulumGroupCategory[] = [];
  try {
    const parsedChannels = JSON.parse(row.channels_json);
    if (Array.isArray(parsedChannels)) channels = parsedChannels as ReticulumGroupChannel[];
  } catch {
    channels = [];
  }
  try {
    const parsedCategories = JSON.parse(row.categories_json);
    if (Array.isArray(parsedCategories)) categories = parsedCategories as ReticulumGroupCategory[];
  } catch {
    categories = [];
  }
  return {
    groupId: row.group_id,
    snapshotId: row.snapshot_id,
    version: row.version,
    createdAt: row.created_at,
    latestEventId: row.latest_event_id,
    latestFeedTimestamp: row.latest_feed_timestamp,
    snapshotHash: row.snapshot_hash,
    adminAddress: row.admin_address,
    adminPublicKey: row.admin_public_key,
    signature: row.signature,
    channels,
    categories,
  };
}

function groupKeyRowToEntry(row: GroupKeyRow): ReticulumChatGroupKey {
  return {
    groupId: row.group_id,
    epoch: row.epoch,
    keyId: row.key_id,
    keyBytesBase64: row.key_bytes_base64,
    createdBy: row.created_by,
    createdAt: row.created_at,
    status: row.status === 'superseded' ? 'superseded' : 'active',
    adminPublicKey: row.admin_public_key,
    adminSignature: row.admin_signature,
  };
}

function groupKeyDigestRowToEntry(row: GroupKeyDigestRow): ReticulumChatGroupKeyDigest {
  return {
    groupId: row.group_id,
    epoch: row.epoch,
    keyId: row.key_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    adminPublicKey: row.admin_public_key,
    adminSignature: row.admin_signature,
    sourcePeerHash: row.source_peer_hash,
    seenAt: row.seen_at,
  };
}

export function reticulumChatRelayBlobId(payloadJson: string): string {
  return nodeCrypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');
}

export function reticulumChatRelayGroupHash(groupId: number): string {
  return nodeCrypto
    .createHash('sha256')
    .update(`rchat-relay-group:${groupId}`, 'utf8')
    .digest('hex');
}

function rowToEvent(row: EventRow): ReticulumChatEvent {
  const mentionTargets = parseMentionTargets(row.mention_targets);
  return {
    eventId: row.event_id,
    groupId: row.group_id,
    channelId: normalizeReticulumChatChannelId(row.channel_id),
    authorAddress: row.author_address,
    authorPublicKey: row.author_public_key,
    authorSeq: row.author_seq,
    timestamp: row.timestamp,
    eventType: row.event_type as ReticulumChatEvent['eventType'],
    ...(row.target_event_id ? { targetEventId: row.target_event_id } : {}),
    ...(row.reply_to_event_id ? { replyToEventId: row.reply_to_event_id } : {}),
    encryptedPayload: row.encrypted_payload,
    payloadHash: row.payload_hash,
    mentionAddressHashes: parseMentionAddressHashes(row.mention_address_hashes),
    ...(mentionTargets.length > 0 ? { mentionTargets } : {}),
    signature: row.signature,
  };
}

function rowToDirectEvent(row: DirectEventRow): ReticulumDmEvent {
  return {
    eventId: row.event_id,
    conversationId: row.conversation_id,
    senderAddress: row.sender_address,
    recipientAddress: row.recipient_address,
    senderPublicKey: row.sender_public_key,
    senderSeq: row.sender_seq,
    timestamp: row.timestamp,
    eventType: row.event_type as ReticulumDmEvent['eventType'],
    ...(row.target_event_id ? { targetEventId: row.target_event_id } : {}),
    ...(row.reply_to_event_id ? { replyToEventId: row.reply_to_event_id } : {}),
    payload: row.payload,
    payloadHash: row.payload_hash,
    signature: row.signature,
    localDeliveryStatus:
      row.delivery_status === 'pending' ||
      row.delivery_status === 'sent' ||
      row.delivery_status === 'received'
        ? row.delivery_status
        : undefined,
    ...(Number.isFinite(Number(row.delivery_updated_at))
      ? { localDeliveryUpdatedAt: Number(row.delivery_updated_at) }
      : {}),
  };
}

function messageProjectionRowToEvent(row: MessageProjectionRow): ReticulumChatEvent {
  const mentionTargets = parseMentionTargets(row.mention_targets);
  return {
    eventId: row.root_event_id,
    groupId: row.group_id,
    channelId: normalizeReticulumChatChannelId(row.channel_id),
    authorAddress: row.author_address,
    authorPublicKey: row.author_public_key,
    authorSeq: row.author_seq,
    timestamp: row.created_at,
    eventType: row.root_event_type as ReticulumChatEvent['eventType'],
    ...(row.reply_to_event_id ? { replyToEventId: row.reply_to_event_id } : {}),
    encryptedPayload: row.encrypted_payload,
    payloadHash: row.payload_hash,
    mentionAddressHashes: parseMentionAddressHashes(row.mention_address_hashes),
    ...(mentionTargets.length > 0 ? { mentionTargets } : {}),
    signature: row.signature,
  };
}

export function normalizeReticulumDmConversationId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : '';
}

export function reticulumDmConversationId(addressA: string, addressB: string): string {
  const first = String(addressA || '').trim();
  const second = String(addressB || '').trim();
  if (!first || !second) return '';
  const [a, b] = [first, second].sort();
  return nodeCrypto
    .createHash('sha256')
    .update(`rchat-dm-v1:${a}:${b}`, 'utf8')
    .digest('hex');
}

export function normalizeReticulumChatChannelId(value: unknown): string {
  if (typeof value !== 'string') return RETICULUM_CHAT_DEFAULT_CHANNEL_ID;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(normalized) ||
    normalized === RETICULUM_CHAT_DEFAULT_CHANNEL_ID
    ? normalized
    : RETICULUM_CHAT_DEFAULT_CHANNEL_ID;
}

export function normalizeReticulumChatExpiryDurationMs(value: unknown): number | undefined {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(duration));
}

export function normalizeReticulumChatCategoryId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  return /^cat-[a-z0-9][a-z0-9-]{0,54}[a-z0-9]$/.test(normalized)
    ? normalized
    : '';
}

function parseMentionAddressHashes(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => /^[0-9a-f]{64}$/i.test(item));
  } catch {
    return [];
  }
}

function serializeMentionAddressHashes(value: unknown): string {
  if (!Array.isArray(value)) return '[]';
  return JSON.stringify(
    [
      ...new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
          .filter((item) => /^[0-9a-f]{64}$/i.test(item))
      ),
    ].slice(0, 100)
  );
}

function parseMentionTargets(value: unknown): ReticulumChatMentionTarget[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    return sanitizeMentionTargets(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

function serializeMentionTargets(value: unknown): string {
  return JSON.stringify(sanitizeMentionTargets(value));
}

function sanitizeMentionTargets(value: unknown): ReticulumChatMentionTarget[] {
  if (!Array.isArray(value)) return [];
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
    const item = raw as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type : '';
    if (type === 'user') {
      const addressHash =
        typeof item.addressHash === 'string' ? item.addressHash.trim().toLowerCase() : '';
      if (/^[0-9a-f]{64}$/i.test(addressHash)) add({ type: 'user', addressHash });
      continue;
    }
    const groupId = Number(item.groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) continue;
    if (type === 'everyone') {
      add({ type: 'everyone', groupId });
      continue;
    }
    if (type === 'group') {
      const groupName =
        typeof item.groupName === 'string' ? item.groupName.trim().slice(0, 120) : '';
      add({ type: 'group', groupId, ...(groupName ? { groupName } : {}) });
      continue;
    }
    if (type === 'channel') {
      const channelId = normalizeReticulumChatChannelId(item.channelId);
      const channelName =
        typeof item.channelName === 'string' ? item.channelName.trim().slice(0, 120) : '';
      add({
        type: 'channel',
        groupId,
        channelId,
        ...(channelName ? { channelName } : {}),
      });
      continue;
    }
    if (type === 'here') {
      const channelId = normalizeReticulumChatChannelId(item.channelId);
      const createdAt = Number(item.createdAt);
      add({
        type: 'here',
        groupId,
        channelId,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      });
    }
  }

  return targets.slice(0, 32);
}

function mentionTargetAppliesTo(
  event: ReticulumChatEvent,
  myAddress: string,
  channelId: string,
  onlineSince: number,
  myMentionHash: string
): boolean {
  if (!myAddress || event.authorAddress === myAddress) return false;
  const targets = sanitizeMentionTargets(event.mentionTargets);
  if (targets.length === 0) return false;
  const eventChannelId = normalizeReticulumChatChannelId(event.channelId);
  const summaryChannelId = normalizeReticulumChatChannelId(channelId);

  for (const target of targets) {
    if (target.type === 'user') {
      if (myMentionHash && target.addressHash === myMentionHash) return true;
      continue;
    }
    if (target.groupId !== event.groupId) continue;
    if (target.type === 'everyone' || target.type === 'group') return true;
    if (target.type === 'channel') {
      // Today all group members can see all channels. When private/admin-only
      // channel visibility exists, this is the place to gate by visibility.
      return true;
    }
    if (target.type === 'here') {
      if (normalizeReticulumChatChannelId(target.channelId) !== eventChannelId) continue;
      if (eventChannelId !== summaryChannelId) continue;
      if (onlineSince > 0 && event.timestamp < onlineSince) continue;
      return true;
    }
  }

  return false;
}

export function hashReticulumChatMentionAddress(address: string): string {
  return nodeCrypto
    .createHash('sha256')
    .update(`reticulum-chat-mention:${address.trim()}`, 'utf8')
    .digest('hex');
}

function eventWireBytes(event: ReticulumChatEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

function deletedPayloadScrubMarker(eventId: string, deletedEventId: string | null): string {
  return JSON.stringify({
    deleted: true,
    eventId,
    ...(deletedEventId ? { deletedEventId } : {}),
  });
}

function isDeletedPayloadScrubMarker(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = JSON.parse(value) as { deleted?: unknown; eventId?: unknown };
    return parsed.deleted === true && typeof parsed.eventId === 'string' && !!parsed.eventId;
  } catch {
    return false;
  }
}

function hashReticulumChatDbPayload(encryptedPayload: string): string {
  return nodeCrypto
    .createHash('sha256')
    .update(encryptedPayload, 'utf8')
    .digest('hex');
}

function collectSearchStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSearchStrings(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [key, next] of Object.entries(record)) {
    if (key === 'type' || key === 'isEdited' || key === 'mentionedAddresses') {
      continue;
    }
    collectSearchStrings(next, out);
  }
}

function searchTextFromPayload(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as unknown;
    const strings: string[] = [];
    collectSearchStrings(parsed, strings);
    return strings.join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function payloadHasReticulumFileAttachment(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    const hasAttachmentEntry = (value: unknown): boolean =>
      Array.isArray(value) &&
      value.some((item) => item && typeof item === 'object');
    return hasAttachmentEntry(record.attachments);
  } catch {
    return false;
  }
}

function messageExpiryDurationFromPayload(payload: string): number | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    return normalizeReticulumChatExpiryDurationMs(
      record.expiryDurationMs ?? record.expiresInMs ?? record.messageExpiryDurationMs
    );
  } catch {
    return undefined;
  }
}

function stripSearchHtml(text: string): string {
  return text
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeSearchText(text: string): string {
  return stripSearchHtml(text).replace(/\s+/g, ' ').trim().slice(0, 20_000);
}

function normalizeReticulumChannelWriteMode(
  value: unknown
): ReticulumGroupChannelWriteMode {
  return value === RETICULUM_CHAT_CHANNEL_WRITE_MODE_ADMINS
    ? RETICULUM_CHAT_CHANNEL_WRITE_MODE_ADMINS
    : RETICULUM_CHAT_CHANNEL_WRITE_MODE_MEMBERS;
}

function normalizeReticulumChannelReadMode(
  value: unknown
): ReticulumGroupChannelReadMode {
  return value === RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS
    ? RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS
    : RETICULUM_CHAT_CHANNEL_READ_MODE_MEMBERS;
}

function buildSearchTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .map((term) => term.trim().replace(/[^a-z0-9_-]+/g, ''))
    .filter((term) => term.length >= 2)
    .slice(0, 12);
}

function buildFtsQuery(query: string): string {
  return buildSearchTerms(query)
    .map((term) => `"${term}"*`)
    .join(' AND ');
}

function normalizeSearchCursor(
  cursor: ReticulumChatSearchCursor | undefined
): ReticulumChatSearchCursor | null {
  if (!cursor || typeof cursor !== 'object') return null;
  const createdAt = Number(cursor.createdAt);
  const eventId = typeof cursor.eventId === 'string' ? cursor.eventId.trim() : '';
  if (!Number.isFinite(createdAt) || !eventId) return null;
  return { createdAt, eventId };
}

function isProjectionAfterSearchCursor(
  projection: MessageProjectionRow,
  cursor: ReticulumChatSearchCursor | null,
  sort: 'newest' | 'oldest'
): boolean {
  if (!cursor) return true;
  if (sort === 'oldest') {
    return (
      projection.created_at > cursor.createdAt ||
      (projection.created_at === cursor.createdAt &&
        projection.root_event_id > cursor.eventId)
    );
  }
  return (
    projection.created_at < cursor.createdAt ||
    (projection.created_at === cursor.createdAt &&
      projection.root_event_id < cursor.eventId)
  );
}

function searchCursorFromProjection(
  projection: MessageProjectionRow
): ReticulumChatSearchCursor {
  return {
    createdAt: projection.created_at,
    eventId: projection.root_event_id,
  };
}

function buildPlainSnippet(text: string, terms: string[]): string {
  const normalized = normalizeSearchText(text);
  if (!normalized) return '';
  const lower = normalized.toLowerCase();
  const firstMatch = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatch - 48);
  const end = Math.min(normalized.length, firstMatch + 160);
  return `${start > 0 ? '...' : ''}${normalized.slice(start, end)}${
    end < normalized.length ? '...' : ''
  }`;
}

export class ReticulumChatDatabase {
  private static sharedRelayCaches = new Map<string, Map<string, ReticulumChatRelayCacheEntry>>();
  private db: DB;
  private readonly relayCacheKey: string;
  private memoryEvents = new Map<string, ReticulumChatEvent>();
  private memoryGroupKeys = new Map<string, ReticulumChatGroupKey>();
  private memoryGroupKeyDigests = new Map<string, ReticulumChatGroupKeyDigest>();
  private memoryGroupKeyRequests = new Map<string, ReticulumChatGroupKeyRequest>();
  private memorySearchText = new Map<string, string>();
  private memoryScrubbedEvents = new Set<string>();
  private memoryScrubbedEventOverrides = new Map<string, ReticulumChatEvent>();
  private memoryMissingRanges = new Map<string, ReticulumChatMissingRangeState>();
  private memoryChannels = new Map<string, ReticulumGroupChannel>();
  private memoryCategories = new Map<string, ReticulumGroupCategory>();
  private memoryMentions = new Map<
    string,
    Array<{
      groupId: number;
      mentionedAddress: string;
      channelId: string;
      authorAddress: string;
      timestamp: number;
      readAt: number;
    }>
  >();
  private memoryReadWatermarks = new Map<string, number>();
  private memoryRelayCache: Map<string, ReticulumChatRelayCacheEntry>;
  private lastExpiryPruneAt = 0;
  private memoryMeta = new Map<
    string,
    { ownEvent: boolean; lastServedAt: number; storedAt: number; wireBytes: number }
  >();
  private stmtInsertEvent: Statement;
  private stmtInsertEventHeaderV2: Statement;
  private stmtInsertEventPayloadV2: Statement;
  private stmtGetEvent: Statement;
  private stmtHasEvent: Statement;
  private stmtIsEventScrubbed: Statement;
  private stmtGetRecentEvents: Statement;
  private stmtGetRecentMessageEvents: Statement;
  private stmtGetRecentMessageEventsAllChannels: Statement;
  private stmtUpsertMessageProjection: Statement;
  private stmtGetMessageProjectionEvents: Statement;
  private stmtDeleteMessageProjection: Statement;
  private stmtGetChannelMetadataEvents: Statement;
  private stmtGetChannelMetadataPageAfter: Statement;
  private stmtGetChannelMetadataPageBefore: Statement;
  private stmtGetChannelMetadataPageAtOrBefore: Statement;
  private stmtGetEventsAfter: Statement;
  private stmtGetEventsAfterCursor: Statement;
  private stmtGetEventsBefore: Statement;
  private stmtGetEventsBeforeCursor: Statement;
  private stmtGetGroupEventsAfter: Statement;
  private stmtGetGroupEventsAfterCursor: Statement;
  private stmtGetGroupEventsBeforeCursor: Statement;
  private stmtGetGroupEventsAtOrBeforeCursor: Statement;
  private stmtGetAuthorMaxSeq: Statement;
  private stmtGetAuthorEventsAfter: Statement;
  private stmtGetAuthorHeads: Statement;
  private stmtGetAuthorSequenceGaps: Statement;
  private stmtGetMissingByAuthor: Statement;
  private stmtGetGroupSeqs: Statement;
  private stmtGetKnownGroups: Statement;
  private stmtGetKnownChannels: Statement;
  private stmtGetKnownMessageChannels: Statement;
  private stmtGetLastDisplayEvent: Statement;
  private stmtCountUnreadDisplayEvents: Statement;
  private stmtGetLastProjectedMessage: Statement;
  private stmtGetUnreadMentionTargetEvents: Statement;
  private stmtGetWatermark: Statement;
  private stmtUpsertWatermark: Statement;
  private stmtUpsertMention: Statement;
  private stmtDeleteMentionsForEvent: Statement;
  private stmtCountUnreadMentions: Statement;
  private stmtMarkMentionsRead: Statement;
  private stmtMarkServed: Statement;
  private stmtTotalCacheBytes: Statement;
  private stmtEvictCandidate: Statement;
  private stmtDeleteEvent: Statement;
  private stmtGetRelayEventsForGroup: Statement;
  private stmtGetDeleteEvents: Statement;
  private stmtUpdateScrubbedEvent: Statement;
  private stmtInsertScrubbedEvent: Statement;
  private stmtUpsertSearchMirror: Statement;
  private stmtDeleteSearchMirror: Statement;
  private stmtSearchMirror: Statement;
  private stmtUpsertSearchText: Statement;
  private stmtDeleteSearchText: Statement;
  private stmtUpsertChannel: Statement;
  private stmtGetChannels: Statement;
  private stmtGetChannel: Statement;
  private stmtUpsertCategory: Statement;
  private stmtGetCategories: Statement;
  private stmtGetCategory: Statement;
  private stmtDeleteCategory: Statement;
  private stmtDeleteChannel: Statement;
  private stmtClearChannelCategory: Statement;
  private stmtGetLatestCursor: Statement;
  private stmtGetOldestCursor: Statement;
  private stmtGetChannelDigests: Statement;
  private stmtGetFeedPageAfter: Statement;
  private stmtGetFeedPageBefore: Statement;
  private stmtGetFeedPageAtOrBefore: Statement;
  private stmtGetAuthorEventsRange: Statement;
  private stmtUpsertPeerGroupState: Statement;
  private stmtUpsertPeerChannelState: Statement;
  private stmtUpsertVerifiedWindow: Statement;
  private stmtUpsertMissingRange: Statement;
  private stmtEnsureMissingRange: Statement;
  private stmtGetMissingRangeExact: Statement;
  private stmtUpdateMissingRangeAttempt: Statement;
  private stmtUpdateMissingRangeBackoff: Statement;
  private stmtGetMissingRangesForSeq: Statement;
  private stmtGetAllMissingRanges: Statement;
  private stmtGetPresentSeqsInRange: Statement;
  private stmtDeleteMissingRange: Statement;
  private stmtInsertMissingRangeRaw: Statement;
  private stmtInsertRelayBlob: Statement;
  private stmtGetRelayBlobByEvent: Statement;
  private stmtListRelayDigestEntries: Statement;
  private stmtMarkRelayBlobServed: Statement;
  private stmtDeleteRelayExpired: Statement;
  private stmtTotalRelayBytes: Statement;
  private stmtRelayEvictCandidate: Statement;
  private stmtDeleteRelayBlob: Statement;
  private stmtDeleteRelayByEvent: Statement;
  private stmtUpsertGroupKey: Statement;
  private stmtGetActiveGroupKey: Statement;
  private stmtGetGroupKey: Statement;
  private stmtUpsertGroupKeyDigest: Statement;
  private stmtGetLatestGroupKeyDigest: Statement;
  private stmtListGroupKeyDigests: Statement;
  private stmtUpsertGroupKeyRequest: Statement;
  private stmtGetPendingGroupKeyRequests: Statement;
  private stmtMarkGroupKeyRequestStatus: Statement;
  private stmtUpsertMetadataSnapshot: Statement;
  private stmtGetLatestMetadataSnapshot: Statement;
  private stmtGetMetadataSnapshotByHash: Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.relayCacheKey = path.resolve(dbPath);
    const sharedRelayCache = ReticulumChatDatabase.sharedRelayCaches.get(this.relayCacheKey);
    this.memoryRelayCache = sharedRelayCache ?? new Map<string, ReticulumChatRelayCacheEntry>();
    if (!sharedRelayCache) {
      ReticulumChatDatabase.sharedRelayCaches.set(this.relayCacheKey, this.memoryRelayCache);
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
    this.runSchemaMigrations();
    this.verifyRequiredSchema();

    this.stmtInsertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO reticulum_chat_events
        (event_id, group_id, author_address, author_public_key, author_seq,
         timestamp, feed_timestamp, event_type, target_event_id, reply_to_event_id,
         encrypted_payload, payload_hash, mention_address_hashes, mention_targets, signature, own_event,
         last_served_at, stored_at, accepted_at, wire_bytes, channel_id, expires_at)
      VALUES
        (@event_id, @group_id, @author_address, @author_public_key, @author_seq,
         @timestamp, @feed_timestamp, @event_type, @target_event_id, @reply_to_event_id,
         @encrypted_payload, @payload_hash, @mention_address_hashes, @mention_targets, @signature, @own_event,
         @last_served_at, @stored_at, @accepted_at, @wire_bytes, @channel_id, @expires_at)
    `);
    this.stmtInsertEventHeaderV2 = this.db.prepare(`
      INSERT OR IGNORE INTO rchat_event_headers
        (event_id, group_id, channel_id, author_address, author_public_key,
         author_seq, timestamp, feed_timestamp, event_type, target_event_id,
         reply_to_event_id, payload_hash, mention_address_hashes, mention_targets,
         signature, own_event, last_served_at, stored_at, accepted_at, wire_bytes,
         retention_state, scrubbed_at, expires_at)
      VALUES
        (@event_id, @group_id, @channel_id, @author_address, @author_public_key,
         @author_seq, @timestamp, @feed_timestamp, @event_type, @target_event_id,
         @reply_to_event_id, @payload_hash, @mention_address_hashes, @mention_targets,
         @signature, @own_event, @last_served_at, @stored_at, @accepted_at, @wire_bytes,
         @retention_state, @scrubbed_at, @expires_at)
    `);
    this.stmtInsertEventPayloadV2 = this.db.prepare(`
      INSERT OR IGNORE INTO rchat_event_payloads
        (event_id, encrypted_payload, payload_hash, retained_until, stored_at)
      VALUES
        (@event_id, @encrypted_payload, @payload_hash, @retained_until, @stored_at)
    `);
    this.stmtGetEvent = this.db.prepare(
      `SELECT * FROM reticulum_chat_events WHERE event_id = ? AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL} LIMIT 1`
    );
    this.stmtHasEvent = this.db.prepare(
      'SELECT 1 FROM reticulum_chat_events WHERE event_id = ? LIMIT 1'
    );
    this.stmtIsEventScrubbed = this.db.prepare(
      'SELECT event_type, target_event_id, scrubbed_at, encrypted_payload FROM reticulum_chat_events WHERE event_id = ? LIMIT 1'
    );
    this.stmtGetRecentEvents = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ? AND channel_id = ?
          AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
        ORDER BY timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY timestamp ASC, event_id ASC
    `);
    this.stmtGetRecentMessageEvents = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM rchat_message_projection
        WHERE group_id = ? AND channel_id = ? AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC, root_event_id DESC
        LIMIT ?
      )
      ORDER BY created_at ASC, root_event_id ASC
    `);
    this.stmtGetRecentMessageEventsAllChannels = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM rchat_message_projection
        WHERE group_id = ? AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC, root_event_id DESC
        LIMIT ?
      )
      ORDER BY created_at ASC, root_event_id ASC
    `);
    this.stmtUpsertMessageProjection = this.db.prepare(`
      INSERT INTO rchat_message_projection
        (root_event_id, group_id, channel_id, author_address, author_public_key,
         author_seq, created_at, root_event_type, current_event_id, updated_at,
         reply_to_event_id, encrypted_payload, payload_hash,
         mention_address_hashes, mention_targets, signature, deleted_at,
         deleted_event_id, expires_at, has_attachment)
      VALUES
        (@root_event_id, @group_id, @channel_id, @author_address, @author_public_key,
         @author_seq, @created_at, @root_event_type, @current_event_id, @updated_at,
         @reply_to_event_id, @encrypted_payload, @payload_hash,
         @mention_address_hashes, @mention_targets, @signature, @deleted_at,
         @deleted_event_id, @expires_at, @has_attachment)
      ON CONFLICT(root_event_id) DO UPDATE SET
        group_id = excluded.group_id,
        channel_id = excluded.channel_id,
        author_address = excluded.author_address,
        author_public_key = excluded.author_public_key,
        author_seq = excluded.author_seq,
        created_at = excluded.created_at,
        root_event_type = excluded.root_event_type,
        current_event_id = excluded.current_event_id,
        updated_at = excluded.updated_at,
        reply_to_event_id = excluded.reply_to_event_id,
        encrypted_payload = excluded.encrypted_payload,
        payload_hash = excluded.payload_hash,
        mention_address_hashes = excluded.mention_address_hashes,
        mention_targets = excluded.mention_targets,
        signature = excluded.signature,
        deleted_at = excluded.deleted_at,
        deleted_event_id = excluded.deleted_event_id,
        expires_at = excluded.expires_at,
        has_attachment = excluded.has_attachment
    `);
    this.stmtGetMessageProjectionEvents = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE event_id = ? OR target_event_id = ?
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtDeleteMessageProjection = this.db.prepare(
      'DELETE FROM rchat_message_projection WHERE root_event_id = ?'
    );
    this.stmtGetChannelMetadataEvents = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ?
          AND event_type IN (
            'channel_create',
            'channel_update',
            'channel_archive',
            'channel_restore',
            'channel_reorder',
            'category_create',
            'category_update',
            'category_delete'
          )
        ORDER BY timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY timestamp ASC, event_id ASC
    `);
    this.stmtGetChannelMetadataPageAfter = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ?
        AND event_type IN (
          'channel_create',
          'channel_update',
          'channel_archive',
          'channel_restore',
          'channel_reorder',
          'category_create',
          'category_update',
          'category_delete'
        )
        AND (feed_timestamp > ? OR (feed_timestamp = ? AND event_id > ?))
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetChannelMetadataPageBefore = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ?
          AND event_type IN (
            'channel_create',
            'channel_update',
            'channel_archive',
            'channel_restore',
            'channel_reorder',
            'category_create',
            'category_update',
            'category_delete'
          )
          AND (feed_timestamp < ? OR (feed_timestamp = ? AND event_id < ?))
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetChannelMetadataPageAtOrBefore = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ?
          AND event_type IN (
            'channel_create',
            'channel_update',
            'channel_archive',
            'channel_restore',
            'channel_reorder',
            'category_create',
            'category_update',
            'category_delete'
          )
          AND (feed_timestamp < ? OR (feed_timestamp = ? AND event_id <= ?))
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetEventsAfter = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND feed_timestamp > ?
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetEventsAfterCursor = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND (feed_timestamp > ? OR (feed_timestamp = ? AND event_id > ?))
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetEventsBefore = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND feed_timestamp < ?
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetEventsBeforeCursor = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND (feed_timestamp < ? OR (feed_timestamp = ? AND event_id < ?))
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetGroupEventsAfter = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND feed_timestamp > ?
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetGroupEventsAfterCursor = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND (feed_timestamp > ? OR (feed_timestamp = ? AND event_id > ?))
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetGroupEventsBeforeCursor = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ? AND (feed_timestamp < ? OR (feed_timestamp = ? AND event_id < ?))
          AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetGroupEventsAtOrBeforeCursor = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ? AND (feed_timestamp < ? OR (feed_timestamp = ? AND event_id <= ?))
          AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetAuthorMaxSeq = this.db.prepare(`
      SELECT MAX(author_seq) AS seq
      FROM (
        SELECT author_seq
        FROM reticulum_chat_events
        WHERE group_id = ? AND author_address = ?
        UNION ALL
        SELECT author_seq
        FROM rchat_expired_event_markers
        WHERE group_id = ? AND author_address = ?
      )
    `);
    this.stmtGetAuthorEventsAfter = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND author_address = ? AND author_seq > ?
      ORDER BY author_seq ASC, timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetAuthorHeads = this.db.prepare(`
      WITH known_events AS (
        SELECT event_id, author_address, author_seq, timestamp
        FROM reticulum_chat_events
        WHERE group_id = ?
        UNION ALL
        SELECT event_id, author_address, author_seq, timestamp
        FROM rchat_expired_event_markers
        WHERE group_id = ?
      )
      SELECT e.author_address, e.author_seq AS max_seq, e.event_id, e.timestamp
      FROM known_events e
      JOIN (
        SELECT author_address, MAX(author_seq) AS max_seq
        FROM known_events
        GROUP BY author_address
      ) h ON h.author_address = e.author_address AND h.max_seq = e.author_seq
      ORDER BY e.timestamp DESC, e.event_id DESC
      LIMIT ?
      OFFSET ?
    `);
    this.stmtGetAuthorSequenceGaps = this.db.prepare(`
      WITH ordered AS (
        SELECT author_address,
               author_seq,
               LAG(author_seq) OVER (
                 PARTITION BY author_address
                 ORDER BY author_seq ASC
               ) AS previous_seq
        FROM (
          SELECT author_address, author_seq
          FROM reticulum_chat_events
          WHERE group_id = ?
          UNION ALL
          SELECT author_address, author_seq
          FROM rchat_expired_event_markers
          WHERE group_id = ?
        )
      )
      SELECT author_address,
             previous_seq + 1 AS from_seq,
             author_seq - 1 AS to_seq
      FROM ordered
      WHERE previous_seq IS NOT NULL
        AND author_seq > previous_seq + 1
      ORDER BY to_seq DESC, author_address ASC, from_seq DESC
      LIMIT ?
    `);
    this.stmtGetMissingByAuthor = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND author_address = ? AND author_seq > ?
      ORDER BY author_seq ASC
      LIMIT ?
    `);
    this.stmtGetGroupSeqs = this.db.prepare(`
      SELECT author_address, MAX(author_seq) AS seq
      FROM (
        SELECT author_address, author_seq
        FROM reticulum_chat_events
        WHERE group_id = ?
        UNION ALL
        SELECT author_address, author_seq
        FROM rchat_expired_event_markers
        WHERE group_id = ?
      )
      GROUP BY author_address
    `);
    this.stmtGetKnownGroups = this.db.prepare(`
      SELECT DISTINCT group_id FROM reticulum_chat_events
      ORDER BY group_id ASC
    `);
    this.stmtGetKnownChannels = this.db.prepare(`
      SELECT DISTINCT channel_id FROM reticulum_chat_events
      WHERE group_id = ?
      ORDER BY channel_id ASC
    `);
    this.stmtGetKnownMessageChannels = this.db.prepare(`
      SELECT DISTINCT channel_id FROM rchat_message_projection
      WHERE group_id = ? AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY channel_id ASC
    `);
    this.stmtGetLastDisplayEvent = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND event_type IN ('message', 'attachment_manifest')
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
      ORDER BY timestamp DESC, event_id DESC
      LIMIT 1
    `);
    this.stmtCountUnreadDisplayEvents = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM reticulum_chat_events
      WHERE group_id = ?
        AND channel_id = ?
        AND event_type IN ('message', 'attachment_manifest')
        AND timestamp > ?
        AND author_address != ?
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
    `);
    this.stmtGetLastProjectedMessage = this.db.prepare(`
      SELECT * FROM rchat_message_projection
      WHERE group_id = ? AND channel_id = ? AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC, root_event_id DESC
      LIMIT 1
    `);
    this.stmtGetUnreadMentionTargetEvents = this.db.prepare(`
      SELECT *
      FROM reticulum_chat_events
      WHERE group_id = ?
        AND channel_id = ?
        AND timestamp > ?
        AND author_address != ?
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
        AND (
          mention_targets != '[]'
          OR event_type IN ('edit', 'delete')
        )
      ORDER BY timestamp ASC, event_id ASC
    `);
    this.stmtGetWatermark = this.db.prepare(
      'SELECT timestamp FROM reticulum_chat_read_watermarks WHERE group_id = ? AND channel_id = ? AND address = ?'
    );
    this.stmtUpsertWatermark = this.db.prepare(`
      INSERT INTO reticulum_chat_read_watermarks (group_id, channel_id, address, timestamp)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, channel_id, address) DO UPDATE SET timestamp = excluded.timestamp
    `);
    this.stmtUpsertMention = this.db.prepare(`
      INSERT INTO reticulum_chat_mentions
        (event_id, group_id, channel_id, mentioned_address, author_address, timestamp, read_at)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(event_id, mentioned_address) DO UPDATE SET
        group_id = excluded.group_id,
        author_address = excluded.author_address,
        timestamp = excluded.timestamp
    `);
    this.stmtDeleteMentionsForEvent = this.db.prepare(
      'DELETE FROM reticulum_chat_mentions WHERE event_id = ?'
    );
    this.stmtCountUnreadMentions = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM reticulum_chat_mentions
      WHERE group_id = ?
        AND channel_id = ?
        AND mentioned_address = ?
        AND author_address != ?
        AND timestamp > ?
        AND read_at = 0
    `);
    this.stmtMarkMentionsRead = this.db.prepare(`
      UPDATE reticulum_chat_mentions
      SET read_at = ?
      WHERE group_id = ?
        AND channel_id = ?
        AND mentioned_address = ?
        AND timestamp <= ?
        AND read_at = 0
    `);
    this.stmtMarkServed = this.db.prepare(
      'UPDATE reticulum_chat_events SET last_served_at = ? WHERE event_id = ?'
    );
    this.stmtTotalCacheBytes = this.db.prepare(`
      SELECT COALESCE(SUM(wire_bytes), 0) AS total
      FROM reticulum_chat_events
      WHERE own_event = 0
    `);
    this.stmtEvictCandidate = this.db.prepare(`
      SELECT event_id FROM reticulum_chat_events
      WHERE own_event = 0
      ORDER BY last_served_at ASC, timestamp ASC, stored_at ASC
      LIMIT 1
    `);
    this.stmtDeleteEvent = this.db.prepare(
      'DELETE FROM reticulum_chat_events WHERE event_id = ?'
    );
    this.stmtUpsertSearchMirror = this.db.prepare(`
      INSERT INTO reticulum_chat_search_index
        (event_id, group_id, channel_id, author_address, timestamp, event_type, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        group_id = excluded.group_id,
        channel_id = excluded.channel_id,
        author_address = excluded.author_address,
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        search_text = excluded.search_text
    `);
    this.stmtSearchMirror = this.db.prepare(`
      SELECT event_id, search_text
      FROM reticulum_chat_search_index
      WHERE lower(search_text) LIKE ?
      ORDER BY timestamp DESC, event_id DESC
      LIMIT ?
    `);
    this.stmtDeleteSearchMirror = this.db.prepare(
      'DELETE FROM reticulum_chat_search_index WHERE event_id = ?'
    );
    this.stmtUpsertSearchText = this.db.prepare(`
      INSERT INTO reticulum_chat_search_fts
        (event_id, group_id, channel_id, author_address, timestamp, event_type, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtDeleteSearchText = this.db.prepare(
      'DELETE FROM reticulum_chat_search_fts WHERE event_id = ?'
    );
    this.stmtUpsertChannel = this.db.prepare(`
      INSERT OR REPLACE INTO reticulum_chat_channels
        (group_id, channel_id, category_id, name, description, position, archived, write_mode, read_mode, write_mode_updated_at, expiry_duration_ms, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGetChannels = this.db.prepare(`
      SELECT * FROM reticulum_chat_channels
      WHERE group_id = ?
      ORDER BY position ASC, name ASC, channel_id ASC
    `);
    this.stmtGetChannel = this.db.prepare(`
      SELECT * FROM reticulum_chat_channels
      WHERE group_id = ? AND channel_id = ?
      LIMIT 1
    `);
    this.stmtUpsertCategory = this.db.prepare(`
      INSERT OR REPLACE INTO reticulum_chat_categories
        (group_id, category_id, name, position, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGetCategories = this.db.prepare(`
      SELECT * FROM reticulum_chat_categories
      WHERE group_id = ?
      ORDER BY position ASC, name ASC, category_id ASC
    `);
    this.stmtGetCategory = this.db.prepare(`
      SELECT * FROM reticulum_chat_categories
      WHERE group_id = ? AND category_id = ?
      LIMIT 1
    `);
    this.stmtUpsertMetadataSnapshot = this.db.prepare(`
      INSERT OR REPLACE INTO rchat_metadata_snapshots
        (group_id, snapshot_id, version, created_at, latest_event_id,
         latest_feed_timestamp, snapshot_hash, admin_address, admin_public_key,
         signature, channels_json, categories_json)
      VALUES
        (@group_id, @snapshot_id, @version, @created_at, @latest_event_id,
         @latest_feed_timestamp, @snapshot_hash, @admin_address, @admin_public_key,
         @signature, @channels_json, @categories_json)
    `);
    this.stmtGetLatestMetadataSnapshot = this.db.prepare(`
      SELECT * FROM rchat_metadata_snapshots
      WHERE group_id = ?
      ORDER BY version DESC, created_at DESC, snapshot_id DESC
      LIMIT 1
    `);
    this.stmtGetMetadataSnapshotByHash = this.db.prepare(`
      SELECT * FROM rchat_metadata_snapshots
      WHERE group_id = ? AND snapshot_hash = ?
      LIMIT 1
    `);
    this.stmtDeleteCategory = this.db.prepare(
      'DELETE FROM reticulum_chat_categories WHERE group_id = ? AND category_id = ?'
    );
    this.stmtDeleteChannel = this.db.prepare(
      'DELETE FROM reticulum_chat_channels WHERE group_id = ? AND channel_id = ?'
    );
    this.stmtClearChannelCategory = this.db.prepare(
      'UPDATE reticulum_chat_channels SET category_id = NULL WHERE group_id = ? AND category_id = ?'
    );
    this.stmtGetLatestCursor = this.db.prepare(`
      SELECT event_id, feed_timestamp
      FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ?
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
      ORDER BY feed_timestamp DESC, event_id DESC
      LIMIT 1
    `);
    this.stmtGetOldestCursor = this.db.prepare(`
      SELECT event_id, feed_timestamp
      FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ?
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT 1
    `);
    this.stmtGetChannelDigests = this.db.prepare(`
      SELECT channel_id,
             MIN(feed_timestamp) AS oldest_feed_timestamp,
             MAX(feed_timestamp) AS latest_feed_timestamp,
             COUNT(*) AS event_count
      FROM reticulum_chat_events
      WHERE group_id = ?
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
      GROUP BY channel_id
      ORDER BY latest_feed_timestamp DESC, channel_id ASC
      LIMIT ?
      OFFSET ?
    `);
    this.stmtGetFeedPageAfter = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ?
        AND channel_id = ?
        AND (feed_timestamp > ? OR (feed_timestamp = ? AND event_id > ?))
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetFeedPageBefore = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ?
          AND channel_id = ?
          AND (feed_timestamp < ? OR (feed_timestamp = ? AND event_id < ?))
          AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetFeedPageAtOrBefore = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ?
          AND channel_id = ?
          AND (feed_timestamp < ? OR (feed_timestamp = ? AND event_id <= ?))
          AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetAuthorEventsRange = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ?
        AND author_address = ?
        AND author_seq >= ?
        AND author_seq <= ?
        AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
      ORDER BY author_seq DESC, feed_timestamp DESC, event_id DESC
      LIMIT ?
    `);
    this.stmtUpsertPeerGroupState = this.db.prepare(`
      INSERT INTO rchat_peer_group_state
        (peer_hash, group_id, latest_event_id, latest_feed_timestamp, digest_hash, updated_at)
      VALUES
        (@peer_hash, @group_id, @latest_event_id, @latest_feed_timestamp, @digest_hash, @updated_at)
      ON CONFLICT(peer_hash, group_id) DO UPDATE SET
        latest_event_id = excluded.latest_event_id,
        latest_feed_timestamp = excluded.latest_feed_timestamp,
        digest_hash = excluded.digest_hash,
        updated_at = excluded.updated_at
    `);
    this.stmtUpsertPeerChannelState = this.db.prepare(`
      INSERT INTO rchat_peer_channel_state
        (peer_hash, group_id, channel_id, latest_event_id, latest_feed_timestamp,
         oldest_event_id, oldest_feed_timestamp, visible_window_hash, updated_at)
      VALUES
        (@peer_hash, @group_id, @channel_id, @latest_event_id, @latest_feed_timestamp,
         @oldest_event_id, @oldest_feed_timestamp, @visible_window_hash, @updated_at)
      ON CONFLICT(peer_hash, group_id, channel_id) DO UPDATE SET
        latest_event_id = excluded.latest_event_id,
        latest_feed_timestamp = excluded.latest_feed_timestamp,
        oldest_event_id = excluded.oldest_event_id,
        oldest_feed_timestamp = excluded.oldest_feed_timestamp,
        visible_window_hash = excluded.visible_window_hash,
        updated_at = excluded.updated_at
    `);
    this.stmtUpsertVerifiedWindow = this.db.prepare(`
      INSERT INTO rchat_verified_windows
        (group_id, channel_id, start_event_id, start_feed_timestamp,
         end_event_id, end_feed_timestamp, window_hash, verified_at)
      VALUES
        (@group_id, @channel_id, @start_event_id, @start_feed_timestamp,
         @end_event_id, @end_feed_timestamp, @window_hash, @verified_at)
      ON CONFLICT(group_id, channel_id, start_event_id, end_event_id) DO UPDATE SET
        start_feed_timestamp = excluded.start_feed_timestamp,
        end_feed_timestamp = excluded.end_feed_timestamp,
        window_hash = excluded.window_hash,
        verified_at = excluded.verified_at
    `);
    this.stmtUpsertMissingRange = this.db.prepare(`
      INSERT INTO rchat_missing_ranges
        (group_id, author_address, from_seq, to_seq, preferred_peer, attempts, next_attempt_at)
      VALUES
        (@group_id, @author_address, @from_seq, @to_seq, @preferred_peer, 0, @next_attempt_at)
      ON CONFLICT(group_id, author_address, from_seq, to_seq) DO UPDATE SET
        preferred_peer = excluded.preferred_peer,
        next_attempt_at = MIN(rchat_missing_ranges.next_attempt_at, excluded.next_attempt_at)
    `);
    this.stmtEnsureMissingRange = this.db.prepare(`
      INSERT OR IGNORE INTO rchat_missing_ranges
        (group_id, author_address, from_seq, to_seq, preferred_peer, attempts, next_attempt_at)
      VALUES
        (@group_id, @author_address, @from_seq, @to_seq, @preferred_peer, 0, @next_attempt_at)
    `);
    this.stmtGetMissingRangeExact = this.db.prepare(`
      SELECT group_id, author_address, from_seq, to_seq, preferred_peer, attempts, next_attempt_at
      FROM rchat_missing_ranges
      WHERE group_id = ?
        AND author_address = ?
        AND from_seq = ?
        AND to_seq = ?
    `);
    this.stmtUpdateMissingRangeAttempt = this.db.prepare(`
      UPDATE rchat_missing_ranges
      SET preferred_peer = COALESCE(@preferred_peer, preferred_peer),
          attempts = @attempts,
          next_attempt_at = @next_attempt_at
      WHERE group_id = @group_id
        AND author_address = @author_address
        AND from_seq = @from_seq
        AND to_seq = @to_seq
    `);
    this.stmtUpdateMissingRangeBackoff = this.db.prepare(`
      UPDATE rchat_missing_ranges
      SET preferred_peer = COALESCE(@preferred_peer, preferred_peer),
          attempts = MAX(attempts, @attempts),
          next_attempt_at = MAX(next_attempt_at, @next_attempt_at)
      WHERE group_id = @group_id
        AND author_address = @author_address
        AND from_seq = @from_seq
        AND to_seq = @to_seq
    `);
    this.stmtGetMissingRangesForSeq = this.db.prepare(`
      SELECT group_id, author_address, from_seq, to_seq, preferred_peer, attempts, next_attempt_at
      FROM rchat_missing_ranges
      WHERE group_id = ?
        AND author_address = ?
        AND from_seq <= ?
        AND to_seq >= ?
      ORDER BY from_seq ASC, to_seq ASC
    `);
    this.stmtGetAllMissingRanges = this.db.prepare(`
      SELECT group_id, author_address, from_seq, to_seq, preferred_peer, attempts, next_attempt_at
      FROM rchat_missing_ranges
      ORDER BY group_id ASC, author_address ASC, from_seq ASC
    `);
    this.stmtGetPresentSeqsInRange = this.db.prepare(`
      SELECT author_seq
      FROM reticulum_chat_events
      WHERE group_id = ?
        AND author_address = ?
        AND author_seq >= ?
        AND author_seq <= ?
      ORDER BY author_seq ASC
    `);
    this.stmtDeleteMissingRange = this.db.prepare(`
      DELETE FROM rchat_missing_ranges
      WHERE group_id = ?
        AND author_address = ?
        AND from_seq = ?
        AND to_seq = ?
    `);
    this.stmtInsertMissingRangeRaw = this.db.prepare(`
      INSERT OR IGNORE INTO rchat_missing_ranges
        (group_id, author_address, from_seq, to_seq, preferred_peer, attempts, next_attempt_at)
      VALUES
        (@group_id, @author_address, @from_seq, @to_seq, @preferred_peer, @attempts, @next_attempt_at)
    `);
    this.stmtInsertRelayBlob = this.db.prepare(`
      INSERT INTO rchat_relay_cache
        (blob_id, event_id, group_id, group_hash, created_at, expires_at, size_bytes,
         encoding, encryption, key_epoch, encrypted_key_id, payload_json, source_peer_hash,
         served_count, last_served_at)
      VALUES
        (@blob_id, @event_id, @group_id, @group_hash, @created_at, @expires_at, @size_bytes,
         @encoding, @encryption, @key_epoch, @encrypted_key_id, @payload_json, @source_peer_hash,
         0, NULL)
    `);
    this.stmtGetRelayBlobByEvent = this.db.prepare(`
      SELECT * FROM rchat_relay_cache
      WHERE group_id = ? AND event_id = ? AND expires_at > ?
      LIMIT 1
    `);
    this.stmtListRelayDigestEntries = this.db.prepare(`
      SELECT * FROM rchat_relay_cache
      WHERE group_id = ? AND expires_at > ?
      ORDER BY created_at ASC, event_id ASC
      LIMIT ? OFFSET ?
    `);
    this.stmtMarkRelayBlobServed = this.db.prepare(`
      UPDATE rchat_relay_cache
      SET served_count = served_count + 1,
          last_served_at = ?
      WHERE blob_id = ?
    `);
    this.stmtDeleteRelayExpired = this.db.prepare(
      'DELETE FROM rchat_relay_cache WHERE expires_at <= ?'
    );
    this.stmtTotalRelayBytes = this.db.prepare(`
      SELECT COALESCE(SUM(size_bytes), 0) AS total
      FROM rchat_relay_cache
    `);
    this.stmtRelayEvictCandidate = this.db.prepare(`
      SELECT blob_id FROM rchat_relay_cache
      ORDER BY expires_at ASC, created_at ASC
      LIMIT 1
    `);
    this.stmtDeleteRelayBlob = this.db.prepare(
      'DELETE FROM rchat_relay_cache WHERE blob_id = ?'
    );
    this.stmtDeleteRelayByEvent = this.db.prepare(
      'DELETE FROM rchat_relay_cache WHERE event_id = ?'
    );
    this.stmtGetRelayEventsForGroup = this.db.prepare(
      'SELECT event_id, payload_json FROM rchat_relay_cache WHERE group_id = ?'
    );
    this.stmtGetDeleteEvents = this.db.prepare(`
      SELECT event_id, target_event_id, timestamp
      FROM reticulum_chat_events
      WHERE event_type = 'delete'
        AND target_event_id IS NOT NULL
      ORDER BY timestamp ASC, event_id ASC
    `);
    this.stmtUpdateScrubbedEvent = this.db.prepare(`
      UPDATE reticulum_chat_events
      SET encrypted_payload = ?,
          payload_hash = ?,
          mention_address_hashes = '[]',
          mention_targets = '[]',
          wire_bytes = ?,
          scrubbed_at = ?
      WHERE event_id = ?
    `);
    this.stmtInsertScrubbedEvent = this.db.prepare(`
      INSERT OR REPLACE INTO reticulum_chat_events
        (event_id, group_id, author_address, author_public_key, author_seq,
         timestamp, feed_timestamp, event_type, target_event_id, reply_to_event_id,
         encrypted_payload, payload_hash, mention_address_hashes, mention_targets, signature, own_event,
         last_served_at, stored_at, accepted_at, wire_bytes, channel_id, scrubbed_at, expires_at)
      VALUES
        (@event_id, @group_id, @author_address, @author_public_key, @author_seq,
         @timestamp, @feed_timestamp, @event_type, @target_event_id, @reply_to_event_id,
         @encrypted_payload, @payload_hash, '[]', '[]', @signature, @own_event,
         @last_served_at, @stored_at, @accepted_at, @wire_bytes, @channel_id, @scrubbed_at, @expires_at)
    `);
    this.stmtUpsertGroupKey = this.db.prepare(`
      INSERT OR REPLACE INTO rchat_group_keys
        (group_id, epoch, key_id, key_bytes_base64, created_by, created_at,
         status, admin_public_key, admin_signature)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGetActiveGroupKey = this.db.prepare(`
      SELECT * FROM rchat_group_keys
      WHERE group_id = ? AND status = 'active'
      ORDER BY epoch DESC, key_id ASC, created_at ASC
      LIMIT 1
    `);
    this.stmtGetGroupKey = this.db.prepare(`
      SELECT * FROM rchat_group_keys
      WHERE group_id = ? AND epoch = ? AND key_id = ?
      LIMIT 1
    `);
    this.stmtUpsertGroupKeyDigest = this.db.prepare(`
      INSERT OR REPLACE INTO rchat_group_key_digests
        (group_id, epoch, key_id, created_by, created_at, admin_public_key,
         admin_signature, source_peer_hash, seen_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGetLatestGroupKeyDigest = this.db.prepare(`
      SELECT * FROM rchat_group_key_digests
      WHERE group_id = ?
      ORDER BY epoch DESC, created_at DESC, key_id ASC
      LIMIT 1
    `);
    this.stmtListGroupKeyDigests = this.db.prepare(`
      SELECT * FROM rchat_group_key_digests
      WHERE group_id = ?
      ORDER BY epoch DESC, created_at DESC, key_id ASC
      LIMIT ?
    `);
    this.stmtUpsertGroupKeyRequest = this.db.prepare(`
      INSERT OR REPLACE INTO rchat_group_key_requests
        (group_id, epoch, key_id, request_id, requested_at, attempts, status)
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGetPendingGroupKeyRequests = this.db.prepare(`
      SELECT * FROM rchat_group_key_requests
      WHERE status = 'pending'
      ORDER BY requested_at ASC
      LIMIT ?
    `);
    this.stmtMarkGroupKeyRequestStatus = this.db.prepare(`
      UPDATE rchat_group_key_requests
      SET status = ?
      WHERE group_id = ? AND epoch = ? AND key_id = ?
    `);
    this.pruneSatisfiedMissingRanges();
    this.backfillMessageProjection();
    this.backfillSearchIndex();
    this.scrubExistingDeletedMessagePayloads();
    this.pruneExpiredMessages();
  }

  close(): void {
    this.db.close();
  }

  insertDirectEvent(
    event: ReticulumDmEvent,
    ownEvent: boolean,
    deliveryStatus?: 'pending' | 'sent' | 'received'
  ): boolean {
    const conversationId = normalizeReticulumDmConversationId(event.conversationId);
    if (!conversationId) return false;
    const now = Date.now();
    const status = deliveryStatus || (ownEvent ? 'pending' : 'received');
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO rchat_dm_events
        (event_id, conversation_id, sender_address, recipient_address, sender_public_key,
         sender_seq, timestamp, event_type, target_event_id, reply_to_event_id, payload,
         payload_hash, signature, own_event, read_at, stored_at, wire_bytes,
         delivery_status, delivery_updated_at)
      VALUES
        (@event_id, @conversation_id, @sender_address, @recipient_address, @sender_public_key,
         @sender_seq, @timestamp, @event_type, @target_event_id, @reply_to_event_id, @payload,
         @payload_hash, @signature, @own_event, @read_at, @stored_at, @wire_bytes,
         @delivery_status, @delivery_updated_at)
    `).run({
      event_id: event.eventId,
      conversation_id: conversationId,
      sender_address: event.senderAddress,
      recipient_address: event.recipientAddress,
      sender_public_key: event.senderPublicKey,
      sender_seq: event.senderSeq,
      timestamp: event.timestamp,
      event_type: event.eventType,
      target_event_id: event.targetEventId ?? null,
      reply_to_event_id: event.replyToEventId ?? null,
      payload: event.payload,
      payload_hash: event.payloadHash,
      signature: event.signature,
      own_event: ownEvent ? 1 : 0,
      read_at: ownEvent ? now : 0,
      stored_at: now,
      wire_bytes: Buffer.byteLength(JSON.stringify(event), 'utf8'),
      delivery_status: status,
      delivery_updated_at: now,
    });
    return result.changes > 0;
  }

  markDirectDeliveryStatus(
    eventId: string,
    status: 'pending' | 'sent' | 'received'
  ): void {
    if (!eventId) return;
    this.db
      .prepare(`
        UPDATE rchat_dm_events
        SET delivery_status = ?,
            delivery_updated_at = ?
        WHERE event_id = ?
      `)
      .run(status, Date.now(), eventId);
  }

  hasDirectEvent(eventId: string): boolean {
    if (!eventId) return false;
    const row = this.db
      .prepare('SELECT 1 FROM rchat_dm_events WHERE event_id = ? LIMIT 1')
      .get(eventId);
    return !!row;
  }

  getDirectEvent(eventId: string): ReticulumDmEvent | null {
    if (!eventId) return null;
    const row = this.db
      .prepare('SELECT * FROM rchat_dm_events WHERE event_id = ? LIMIT 1')
      .get(eventId) as DirectEventRow | undefined;
    return row ? rowToDirectEvent(row) : null;
  }

  getDirectHistory(conversationId: string, limit = 100): ReticulumDmEvent[] {
    const normalized = normalizeReticulumDmConversationId(conversationId);
    if (!normalized) return [];
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db
      .prepare(`
        SELECT * FROM (
          SELECT * FROM rchat_dm_events
          WHERE conversation_id = ?
          ORDER BY timestamp DESC, event_id DESC
          LIMIT ?
        )
        ORDER BY timestamp ASC, event_id ASC
      `)
      .all(normalized, safeLimit) as DirectEventRow[];
    return rows.map(rowToDirectEvent);
  }

  getDirectEventsAfter(
    conversationId: string,
    afterTimestamp: number,
    limit = 50
  ): ReticulumDmEvent[] {
    const normalized = normalizeReticulumDmConversationId(conversationId);
    if (!normalized) return [];
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare(`
        SELECT * FROM rchat_dm_events
        WHERE conversation_id = ? AND timestamp > ?
        ORDER BY timestamp ASC, event_id ASC
        LIMIT ?
      `)
      .all(normalized, Math.max(0, Math.floor(afterTimestamp || 0)), safeLimit) as DirectEventRow[];
    return rows.map(rowToDirectEvent);
  }

  getDirectLatestEvent(conversationId: string): ReticulumDmEvent | null {
    const normalized = normalizeReticulumDmConversationId(conversationId);
    if (!normalized) return null;
    const row = this.db
      .prepare(`
        SELECT * FROM rchat_dm_events
        WHERE conversation_id = ?
        ORDER BY timestamp DESC, event_id DESC
        LIMIT 1
      `)
      .get(normalized) as DirectEventRow | undefined;
    return row ? rowToDirectEvent(row) : null;
  }

  getDirectLatestEventFromSender(
    conversationId: string,
    senderAddress: string
  ): ReticulumDmEvent | null {
    const normalized = normalizeReticulumDmConversationId(conversationId);
    const sender = String(senderAddress || '').trim();
    if (!normalized || !sender) return null;
    const row = this.db
      .prepare(`
        SELECT * FROM rchat_dm_events
        WHERE conversation_id = ? AND sender_address = ?
        ORDER BY timestamp DESC, event_id DESC
        LIMIT 1
      `)
      .get(normalized, sender) as DirectEventRow | undefined;
    return row ? rowToDirectEvent(row) : null;
  }

  getDirectAuthorMaxSeq(conversationId: string, senderAddress: string): number {
    const normalized = normalizeReticulumDmConversationId(conversationId);
    if (!normalized || !senderAddress) return 0;
    const row = this.db
      .prepare(`
        SELECT MAX(sender_seq) AS max_seq
        FROM rchat_dm_events
        WHERE conversation_id = ? AND sender_address = ?
      `)
      .get(normalized, senderAddress) as { max_seq?: number | null } | undefined;
    return Number(row?.max_seq || 0);
  }

  getDirectSummaries(myAddress: string): ReticulumDmSummary[] {
    const address = String(myAddress || '').trim();
    if (!address) return [];
    const rows = this.db
      .prepare(`
        SELECT e.*
        FROM rchat_dm_events e
        WHERE (e.sender_address = ? OR e.recipient_address = ?)
          AND e.event_id = (
            SELECT latest.event_id
            FROM rchat_dm_events latest
            WHERE latest.conversation_id = e.conversation_id
            ORDER BY latest.timestamp DESC, latest.event_id DESC
            LIMIT 1
          )
        ORDER BY e.timestamp DESC, e.event_id DESC
      `)
      .all(address, address) as DirectEventRow[];
    return rows.map((row) => {
      const event = rowToDirectEvent(row);
      const peerAddress =
        event.senderAddress === address ? event.recipientAddress : event.senderAddress;
      const unread = this.db
        .prepare(`
          SELECT COUNT(*) AS count
          FROM rchat_dm_events
          WHERE conversation_id = ?
            AND recipient_address = ?
            AND sender_address <> ?
            AND read_at = 0
        `)
        .get(event.conversationId, address, address) as { count?: number } | undefined;
      return {
        peerAddress,
        conversationId: event.conversationId,
        lastEvent: event,
        unreadCount: Number(unread?.count || 0),
        updatedAt: event.timestamp,
      };
    });
  }

  markDirectRead(conversationId: string, myAddress: string, upToTimestamp: number): void {
    const normalized = normalizeReticulumDmConversationId(conversationId);
    const address = String(myAddress || '').trim();
    if (!normalized || !address || !Number.isFinite(upToTimestamp)) return;
    this.db
      .prepare(`
        UPDATE rchat_dm_events
        SET read_at = MAX(read_at, ?)
        WHERE conversation_id = ?
          AND recipient_address = ?
          AND timestamp <= ?
          AND read_at = 0
      `)
      .run(Date.now(), normalized, address, Math.floor(upToTimestamp));
  }

  pruneExpiredMessages(now = Date.now()): number {
    const roots = this.db
      .prepare(
        `
          SELECT root_event_id
          FROM rchat_message_projection
          WHERE expires_at IS NOT NULL AND expires_at <= ?
          ORDER BY expires_at ASC, root_event_id ASC
          LIMIT 5000
        `
      )
      .all(now) as Array<{ root_event_id?: string }>;
    if (roots.length === 0) {
      this.lastExpiryPruneAt = now;
      return 0;
    }
    const rootIds = roots
      .map((row) => (typeof row.root_event_id === 'string' ? row.root_event_id : ''))
      .filter(Boolean);
    const getThreadEvents = this.db.prepare(`
      SELECT event_id, group_id, channel_id, author_address, author_seq, timestamp
      FROM reticulum_chat_events
      WHERE event_id = ? OR target_event_id = ?
    `);
    const insertExpiredMarker = this.db.prepare(`
      INSERT OR IGNORE INTO rchat_expired_event_markers
        (event_id, group_id, channel_id, author_address, author_seq, timestamp, expired_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((ids: string[]) => {
      for (const rootEventId of ids) {
        const rows = getThreadEvents.all(rootEventId, rootEventId) as Array<{
          event_id?: string;
          group_id?: number;
          channel_id?: string;
          author_address?: string;
          author_seq?: number;
          timestamp?: number;
        }>;
        const eventIds = rows
          .map((row) => (typeof row.event_id === 'string' ? row.event_id : ''))
          .filter(Boolean);
        for (const row of rows) {
          if (
            typeof row.event_id !== 'string' ||
            typeof row.author_address !== 'string' ||
            !Number.isInteger(row.group_id) ||
            !Number.isInteger(row.author_seq) ||
            !Number.isFinite(row.timestamp)
          ) {
            continue;
          }
          insertExpiredMarker.run(
            row.event_id,
            row.group_id,
            normalizeReticulumChatChannelId(row.channel_id),
            row.author_address,
            row.author_seq,
            Math.floor(Number(row.timestamp)),
            now
          );
        }
        for (const eventId of eventIds) {
          this.memoryMeta.delete(eventId);
          this.memoryEvents.delete(eventId);
          this.memoryScrubbedEvents.delete(eventId);
          this.memoryScrubbedEventOverrides.delete(eventId);
          this.memorySearchText.delete(eventId);
          this.memoryMentions.delete(eventId);
          this.memoryRelayCache.delete(eventId);
          this.stmtDeleteSearchText.run(eventId);
          this.stmtDeleteSearchMirror.run(eventId);
          this.stmtDeleteMentionsForEvent.run(eventId);
          this.stmtDeleteRelayByEvent.run(eventId);
          this.stmtDeleteEvent.run(eventId);
        }
        this.stmtDeleteMessageProjection.run(rootEventId);
        this.memorySearchText.delete(rootEventId);
        this.stmtDeleteSearchText.run(rootEventId);
        this.stmtDeleteSearchMirror.run(rootEventId);
        this.stmtDeleteMentionsForEvent.run(rootEventId);
        this.stmtDeleteRelayByEvent.run(rootEventId);
      }
    });
    tx(rootIds);
    this.lastExpiryPruneAt = now;
    return rootIds.length;
  }

  private pruneExpiredMessagesThrottled(now = Date.now()): void {
    if (now - this.lastExpiryPruneAt < RETICULUM_CHAT_EXPIRY_PRUNE_INTERVAL_MS) return;
    this.pruneExpiredMessages(now);
  }

  private channelExpiryDurationMs(groupId: number, channelId: string): number | undefined {
    const channel = this.getChannel(groupId, channelId);
    return normalizeReticulumChatExpiryDurationMs(channel?.expiryDurationMs);
  }

  private rootMessageExpiresAt(root: ReticulumChatEvent): number | null {
    if (root.eventType !== 'message' && root.eventType !== 'attachment_manifest') return null;
    const channelExpiry = this.channelExpiryDurationMs(root.groupId, root.channelId);
    const messageExpiry = messageExpiryDurationFromPayload(root.encryptedPayload);
    const duration = channelExpiry ?? messageExpiry;
    if (!duration) return null;
    const createdAt = Number(root.timestamp);
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
    return createdAt + duration;
  }

  private eventExpiresAt(event: ReticulumChatEvent): number | null {
    if (event.eventType === 'message' || event.eventType === 'attachment_manifest') {
      return this.rootMessageExpiresAt(event);
    }
    if (
      (event.eventType === 'edit' || event.eventType === 'delete') &&
      event.targetEventId
    ) {
      const targetRow = this.stmtGetEvent.get(event.targetEventId) as EventRow | undefined;
      if (targetRow?.expires_at) return Number(targetRow.expires_at);
      if (targetRow) return this.rootMessageExpiresAt(rowToEvent(targetRow));
    }
    return null;
  }

  private eventIsVisible(event: ReticulumChatEvent, now = Date.now()): boolean {
    const expiresAt = this.eventExpiresAt(event);
    return expiresAt === null || expiresAt > now;
  }

  private recordExpiredEventMarker(event: ReticulumChatEvent, expiredAt = Date.now()): void {
    this.db
      .prepare(
        `
          INSERT OR IGNORE INTO rchat_expired_event_markers
            (event_id, group_id, channel_id, author_address, author_seq, timestamp, expired_at)
          VALUES
            (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        event.eventId,
        event.groupId,
        normalizeReticulumChatChannelId(event.channelId),
        event.authorAddress,
        event.authorSeq,
        event.timestamp,
        expiredAt
      );
  }

  insertEvent(event: ReticulumChatEvent, ownEvent: boolean): boolean {
    const now = Date.now();
    this.pruneExpiredMessagesThrottled(now);
    const feedTimestamp = this.normalizeFeedTimestamp(event.timestamp, now);
    const expiresAt = this.eventExpiresAt(event);
    if (expiresAt !== null && expiresAt <= now) {
      this.recordExpiredEventMarker(event, now);
      return false;
    }
    const result = this.stmtInsertEvent.run({
      event_id: event.eventId,
      group_id: event.groupId,
      channel_id: normalizeReticulumChatChannelId(event.channelId),
      author_address: event.authorAddress,
      author_public_key: event.authorPublicKey,
      author_seq: event.authorSeq,
      timestamp: event.timestamp,
      feed_timestamp: feedTimestamp,
      event_type: event.eventType,
      target_event_id: event.targetEventId ?? null,
      reply_to_event_id: event.replyToEventId ?? null,
      encrypted_payload: event.encryptedPayload,
      payload_hash: event.payloadHash,
      mention_address_hashes: serializeMentionAddressHashes(
        event.mentionAddressHashes
      ),
      mention_targets: serializeMentionTargets(event.mentionTargets),
      signature: event.signature,
      own_event: ownEvent ? 1 : 0,
      last_served_at: now,
      stored_at: now,
      accepted_at: now,
      wire_bytes: eventWireBytes(event),
      expires_at: expiresAt,
    });
    const inserted = result.changes > 0;
    if (inserted) {
      this.insertEventV2Mirror(event, ownEvent, feedTimestamp, now, expiresAt);
      this.clearMissingRangesForEvent(event);
      this.memoryEvents.set(event.eventId, event);
      this.memoryMeta.set(event.eventId, {
        ownEvent,
        lastServedAt: now,
        storedAt: now,
        wireBytes: eventWireBytes(event),
      });
      this.applyMessageProjectionEvent(event);
      if (
        event.eventType === 'message' ||
        event.eventType === 'attachment_manifest'
      ) {
        this.upsertSearchText(
          event,
          searchTextFromPayload(event.encryptedPayload),
          false
        );
      }
      this.applyDeleteScrubForEvent(event);
    }
    if (!ownEvent) this.enforceRelayCacheLimit();
    return inserted;
  }

  private insertEventV2Mirror(
    event: ReticulumChatEvent,
    ownEvent: boolean,
    feedTimestamp: number,
    now: number,
    expiresAt: number | null
  ): void {
    const payloadRetainedUntil = expiresAt ?? null;
    const wireBytes = eventWireBytes(event);
    this.stmtInsertEventHeaderV2.run({
      event_id: event.eventId,
      group_id: event.groupId,
      channel_id: normalizeReticulumChatChannelId(event.channelId),
      author_address: event.authorAddress,
      author_public_key: event.authorPublicKey,
      author_seq: event.authorSeq,
      timestamp: event.timestamp,
      feed_timestamp: feedTimestamp,
      event_type: event.eventType,
      target_event_id: event.targetEventId ?? null,
      reply_to_event_id: event.replyToEventId ?? null,
      payload_hash: event.payloadHash,
      mention_address_hashes: serializeMentionAddressHashes(event.mentionAddressHashes),
      mention_targets: serializeMentionTargets(event.mentionTargets),
      signature: event.signature,
      own_event: ownEvent ? 1 : 0,
      last_served_at: now,
      stored_at: now,
      accepted_at: now,
      wire_bytes: wireBytes,
      retention_state: 'full',
      scrubbed_at: null,
      expires_at: expiresAt,
    });
    this.stmtInsertEventPayloadV2.run({
      event_id: event.eventId,
      encrypted_payload: event.encryptedPayload,
      payload_hash: event.payloadHash,
      retained_until: payloadRetainedUntil,
      stored_at: now,
    });
  }

  private applyDeleteScrubForEvent(event: ReticulumChatEvent): void {
    if (event.eventType === 'delete' && event.targetEventId) {
      this.scrubDeletedMessageThread(event.targetEventId, event.eventId, event.timestamp);
      return;
    }
    if (
      (event.eventType === 'message' || event.eventType === 'attachment_manifest') &&
      event.eventId
    ) {
      const deleteRow = this.findDeleteTombstone(event.eventId);
      if (deleteRow) {
        this.scrubDeletedMessageThread(
          event.eventId,
          deleteRow.eventId,
          deleteRow.timestamp || Date.now()
        );
      }
      return;
    }
    if (event.eventType === 'edit' && event.targetEventId) {
      const deleteRow = this.findDeleteTombstone(event.targetEventId);
      if (deleteRow) {
        this.scrubDeletedMessageThread(
          event.targetEventId,
          deleteRow.eventId,
          deleteRow.timestamp || Date.now()
        );
      }
    }
  }

  private scrubExistingDeletedMessagePayloads(): void {
    const rows = this.stmtGetDeleteEvents.all() as Array<{
      event_id?: string;
      target_event_id?: string;
      timestamp?: number;
    }>;
    for (const row of rows) {
      if (typeof row.target_event_id !== 'string' || !row.target_event_id) continue;
      this.scrubDeletedMessageThread(
        row.target_event_id,
        typeof row.event_id === 'string' ? row.event_id : null,
        Number(row.timestamp) || Date.now()
      );
    }
  }

  private findDeleteTombstone(rootEventId: string): { eventId: string; timestamp: number } | null {
    if (typeof rootEventId !== 'string' || !rootEventId) return null;
    for (const event of this.memoryEvents.values()) {
      if (event.eventType === 'delete' && event.targetEventId === rootEventId) {
        return { eventId: event.eventId, timestamp: event.timestamp };
      }
    }
    const rows = this.stmtGetMessageProjectionEvents.all(rootEventId, rootEventId) as EventRow[];
    const deleteEvent = rows
      .map(rowToEvent)
      .filter((event) => event.eventType === 'delete' && event.targetEventId === rootEventId)
      .sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId))[0];
    if (!deleteEvent) return null;
    return { eventId: deleteEvent.eventId, timestamp: deleteEvent.timestamp };
  }

  private scrubDeletedMessageThread(
    rootEventId: string,
    deletedEventId: string | null,
    scrubbedAt: number
  ): void {
    if (typeof rootEventId !== 'string' || !rootEventId) return;
    const rootEvent = this.getEvent(rootEventId);
    if (!rootEvent) return;
    const candidates = new Map<string, ReticulumChatEvent>();
    candidates.set(rootEvent.eventId, rootEvent);
    try {
      const rows = this.db
        .prepare(`
          SELECT *
          FROM reticulum_chat_events
          WHERE group_id = ?
            AND (event_id = ? OR target_event_id = ?)
        `)
        .all(rootEvent.groupId, rootEventId, rootEventId) as EventRow[];
      for (const row of rows) {
        const event = rowToEvent(row);
        candidates.set(event.eventId, event);
      }
    } catch {
      // The in-memory write-through cache below still covers current-runtime deletes.
    }
    for (const event of this.memoryEvents.values()) {
      if (event.groupId !== rootEvent.groupId) continue;
      if (event.eventId === rootEventId || event.targetEventId === rootEventId) {
        candidates.set(event.eventId, event);
      }
    }
    const deletedThreadEvents = [...candidates.values()].filter((event) => {
      if (event.eventId === rootEventId) return true;
      return event.eventType === 'edit' && event.targetEventId === rootEventId;
    });
    if (deletedThreadEvents.length === 0) return;

    const groupIds = new Set<number>();
    for (const event of deletedThreadEvents) {
      const eventId = event.eventId;
      if (!eventId) continue;
      if (Number.isInteger(event.groupId) && event.groupId > 0) {
        groupIds.add(event.groupId);
      }
      const scrubbedPayload = deletedPayloadScrubMarker(eventId, deletedEventId);
      const scrubbedHash = hashReticulumChatDbPayload(scrubbedPayload);
      const scrubbedEvent: ReticulumChatEvent = {
        ...event,
        encryptedPayload: scrubbedPayload,
        payloadHash: scrubbedHash,
        mentionAddressHashes: [],
        mentionTargets: [],
      };
      const meta = this.memoryMeta.get(eventId);
      const existingRow = this.stmtGetEvent.get(eventId) as EventRow | undefined;
      this.memoryEvents.delete(eventId);
      this.memoryScrubbedEvents.add(eventId);
      this.memoryScrubbedEventOverrides.set(eventId, scrubbedEvent);
      this.memorySearchText.delete(eventId);
      this.memoryMentions.delete(eventId);
      const scrubbedWireBytes = Buffer.byteLength(scrubbedPayload, 'utf8');
      const updateResult = this.stmtUpdateScrubbedEvent.run(
        scrubbedPayload,
        scrubbedHash,
        scrubbedWireBytes,
        scrubbedAt,
        eventId
      );
      if (updateResult.changes === 0) {
        this.stmtInsertScrubbedEvent.run({
          event_id: event.eventId,
          group_id: event.groupId,
          author_address: event.authorAddress,
          author_public_key: event.authorPublicKey,
          author_seq: event.authorSeq,
          timestamp: event.timestamp,
          feed_timestamp:
            existingRow?.feed_timestamp ?? this.normalizeFeedTimestamp(event.timestamp),
          event_type: event.eventType,
          target_event_id: event.targetEventId ?? null,
          reply_to_event_id: event.replyToEventId ?? null,
          encrypted_payload: scrubbedPayload,
          payload_hash: scrubbedHash,
          signature: event.signature,
          own_event: existingRow?.own_event ?? (meta?.ownEvent ? 1 : 0),
          last_served_at: existingRow?.last_served_at ?? meta?.lastServedAt ?? scrubbedAt,
          stored_at: existingRow?.stored_at ?? meta?.storedAt ?? scrubbedAt,
          accepted_at: existingRow?.accepted_at ?? scrubbedAt,
          wire_bytes: scrubbedWireBytes,
          channel_id: normalizeReticulumChatChannelId(event.channelId),
          scrubbed_at: scrubbedAt,
          expires_at: existingRow?.expires_at ?? this.eventExpiresAt(event),
        });
      }
      this.stmtDeleteSearchText.run(eventId);
      this.stmtDeleteSearchMirror.run(eventId);
      this.stmtDeleteMentionsForEvent.run(eventId);
      this.stmtDeleteRelayByEvent.run(eventId);
      this.memoryRelayCache.delete(eventId);
    }

    for (const groupId of groupIds) {
      this.deleteRelayPayloadsForDeletedRoot(groupId, rootEventId);
    }
    this.rebuildMessageProjection(rootEventId);
  }

  private deleteRelayPayloadsForDeletedRoot(groupId: number, rootEventId: string): void {
    for (const [eventId, entry] of [...this.memoryRelayCache.entries()]) {
      if (entry.groupId !== groupId) continue;
      if (eventId === rootEventId) {
        this.memoryRelayCache.delete(eventId);
        this.stmtDeleteRelayByEvent.run(eventId);
        continue;
      }
      try {
        const candidate = JSON.parse(entry.payloadJson) as Partial<ReticulumChatEvent>;
        if (candidate.eventType === 'edit' && candidate.targetEventId === rootEventId) {
          this.memoryRelayCache.delete(eventId);
          this.stmtDeleteRelayByEvent.run(eventId);
        }
      } catch {
        // Malformed relay payloads are ignored here; normal relay validation handles them.
      }
    }
    const rows = this.stmtGetRelayEventsForGroup.all(groupId) as Array<{
      event_id?: string;
      payload_json?: string;
    }>;
    for (const row of rows) {
      const eventId = typeof row.event_id === 'string' ? row.event_id : '';
      if (!eventId) continue;
      if (eventId === rootEventId) {
        this.stmtDeleteRelayByEvent.run(eventId);
        this.memoryRelayCache.delete(eventId);
        continue;
      }
      try {
        const candidate = JSON.parse(String(row.payload_json || '')) as Partial<ReticulumChatEvent>;
        if (candidate.eventType === 'edit' && candidate.targetEventId === rootEventId) {
          this.stmtDeleteRelayByEvent.run(eventId);
          this.memoryRelayCache.delete(eventId);
        }
      } catch {
        // Malformed relay payloads are ignored here; normal relay validation handles them.
      }
    }
  }

  hasEvent(eventId: string): boolean {
    return (
      this.memoryEvents.has(eventId) ||
      this.memoryScrubbedEventOverrides.has(eventId) ||
      !!this.stmtHasEvent.get(eventId)
    );
  }

  isEventPayloadScrubbed(eventId: string): boolean {
    if (typeof eventId !== 'string' || !eventId) return false;
    if (this.memoryScrubbedEvents.has(eventId)) return true;
    const row = this.stmtIsEventScrubbed.get(eventId) as
      | {
          event_type?: string | null;
          target_event_id?: string | null;
          scrubbed_at?: number | null;
          encrypted_payload?: string | null;
        }
      | undefined;
    const rootEventId =
      row?.event_type === 'edit' && typeof row.target_event_id === 'string'
        ? row.target_event_id
        : eventId;
    return Number.isFinite(row?.scrubbed_at ?? NaN) ||
      isDeletedPayloadScrubMarker(row?.encrypted_payload) ||
      (row?.event_type !== 'delete' && this.findDeleteTombstone(rootEventId) !== null);
  }

  getEvent(eventId: string): ReticulumChatEvent | null {
    const scrubbed = this.memoryScrubbedEventOverrides.get(eventId);
    if (scrubbed) return scrubbed;
    const inMemory = this.memoryEvents.get(eventId);
    if (inMemory) {
      if (!this.eventIsVisible(inMemory)) return null;
      if (inMemory.eventType === 'delete') return inMemory;
      const deleteRow = this.findDeleteTombstone(
        inMemory.eventType === 'edit' ? inMemory.targetEventId || '' : inMemory.eventId
      );
      if (!deleteRow) return inMemory;
      const scrubbedPayload = deletedPayloadScrubMarker(inMemory.eventId, deleteRow.eventId);
      return {
        ...inMemory,
        encryptedPayload: scrubbedPayload,
        payloadHash: hashReticulumChatDbPayload(scrubbedPayload),
        mentionAddressHashes: [],
        mentionTargets: [],
      };
    }
    const row = this.stmtGetEvent.get(eventId) as EventRow | undefined;
    if (!row) return null;
    const event = rowToEvent(row);
    if (!this.eventIsVisible(event)) return null;
    if (event.eventType === 'delete') return event;
    const deleteRow = this.findDeleteTombstone(
      event.eventType === 'edit' ? event.targetEventId || '' : event.eventId
    );
    if (!deleteRow) return event;
    const scrubbedPayload = deletedPayloadScrubMarker(event.eventId, deleteRow.eventId);
    return {
      ...event,
      encryptedPayload: scrubbedPayload,
      payloadHash: hashReticulumChatDbPayload(scrubbedPayload),
      mentionAddressHashes: [],
      mentionTargets: [],
    };
  }

  private applyMessageProjectionEvent(event: ReticulumChatEvent): void {
    if (
      event.eventType === 'message' ||
      event.eventType === 'attachment_manifest'
    ) {
      this.rebuildMessageProjection(event.eventId);
      return;
    }
    if (
      (event.eventType === 'edit' || event.eventType === 'delete') &&
      event.targetEventId
    ) {
      this.rebuildMessageProjection(event.targetEventId);
    }
  }

  private rebuildMessageProjection(rootEventId: string): void {
    if (typeof rootEventId !== 'string' || !rootEventId) return;
    const rows = this.stmtGetMessageProjectionEvents.all(
      rootEventId,
      rootEventId
    ) as EventRow[];
    const eventsById = new Map<string, ReticulumChatEvent>();
    for (const row of rows) {
      const event = rowToEvent(row);
      eventsById.set(event.eventId, event);
    }
    const events = [...eventsById.values()].sort(
      (a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId)
    );
    const root = events.find(
      (candidate) =>
        candidate.eventId === rootEventId &&
        (candidate.eventType === 'message' ||
          candidate.eventType === 'attachment_manifest')
    );
    if (!root) return;
    const expiresAt = this.rootMessageExpiresAt(root);
    if (expiresAt !== null && expiresAt <= Date.now()) {
      this.pruneExpiredMessages(Date.now());
      return;
    }

    let current = root;
    let deletedAt: number | null = null;
    let deletedEventId: string | null = null;
    for (const event of events) {
      if (event.eventId === root.eventId) continue;
      if (event.targetEventId !== root.eventId) continue;
      if (event.eventType === 'edit') {
        if (deletedAt !== null) continue;
        current = event;
        continue;
      }
      if (event.eventType === 'delete') {
        deletedAt = event.timestamp;
        deletedEventId = event.eventId;
      }
    }

    this.stmtUpsertMessageProjection.run({
      root_event_id: root.eventId,
      group_id: root.groupId,
      channel_id: normalizeReticulumChatChannelId(root.channelId),
      author_address: root.authorAddress,
      author_public_key: root.authorPublicKey,
      author_seq: root.authorSeq,
      created_at: root.timestamp,
      root_event_type: root.eventType,
      current_event_id: current.eventId,
      updated_at: current.timestamp,
      reply_to_event_id: root.replyToEventId ?? null,
      encrypted_payload: current.encryptedPayload,
      payload_hash: current.payloadHash,
      mention_address_hashes: serializeMentionAddressHashes(
        current.mentionAddressHashes
      ),
      mention_targets: serializeMentionTargets(current.mentionTargets),
      signature: root.signature,
      deleted_at: deletedAt,
      deleted_event_id: deletedEventId,
      expires_at: expiresAt,
      has_attachment:
        root.eventType === 'attachment_manifest' ||
        payloadHasReticulumFileAttachment(current.encryptedPayload)
          ? 1
          : 0,
    });
  }

  private deleteCachedEvent(eventId: string): void {
    const event = this.getEvent(eventId);
    this.memoryMeta.delete(eventId);
    this.memoryEvents.delete(eventId);
    this.memoryScrubbedEvents.delete(eventId);
    this.memoryScrubbedEventOverrides.delete(eventId);
    this.memorySearchText.delete(eventId);
    this.memoryMentions.delete(eventId);
    this.stmtDeleteSearchText.run(eventId);
    this.stmtDeleteSearchMirror.run(eventId);
    this.stmtDeleteMentionsForEvent.run(eventId);
    this.stmtDeleteEvent.run(eventId);
    if (!event) return;
    if (
      event.eventType === 'message' ||
      event.eventType === 'attachment_manifest'
    ) {
      this.stmtDeleteMessageProjection.run(event.eventId);
      return;
    }
    if (
      (event.eventType === 'edit' || event.eventType === 'delete') &&
      event.targetEventId
    ) {
      this.rebuildMessageProjection(event.targetEventId);
    }
  }

  private relayEntryToDigestEntry(
    entry: ReticulumChatRelayCacheEntry,
    now = Date.now()
  ): ReticulumChatRelayDigestEntry | null {
    if (entry.expiresAt <= now) return null;
    try {
      const event = JSON.parse(entry.payloadJson) as Partial<ReticulumChatEvent>;
      if (
        event.groupId !== entry.groupId ||
        event.eventId !== entry.eventId ||
        typeof event.channelId !== 'string' ||
        typeof event.authorAddress !== 'string' ||
        !Number.isInteger(event.authorSeq) ||
        typeof event.timestamp !== 'number' ||
        typeof event.payloadHash !== 'string'
      ) {
        return null;
      }
      return {
        blobId: entry.blobId,
        eventId: entry.eventId,
        groupId: entry.groupId,
        channelId: event.channelId,
        authorAddress: event.authorAddress,
        authorSeq: event.authorSeq,
        timestamp: event.timestamp,
        payloadHash: event.payloadHash,
        createdAt: entry.createdAt,
      };
    } catch {
      return null;
    }
  }

  storeRelayEventBlob(
    event: ReticulumChatEvent,
    payloadJson: string,
    sourcePeerHash: string,
    now = Date.now()
  ): { ok: true; blobId: string; stored: boolean } | { ok: false; reason: string } {
    if (!Number.isInteger(event.groupId) || event.groupId <= 0) {
      return { ok: false, reason: 'invalid-group' };
    }
    if (event.eventType === 'attachment_manifest') {
      return { ok: false, reason: 'attachment-events-not-relayed' };
    }
    if (event.eventType === 'delete' && event.targetEventId) {
      this.deleteRelayPayloadsForDeletedRoot(event.groupId, event.targetEventId);
    }
    if (
      (event.eventType === 'message' || event.eventType === 'edit') &&
      this.eventHasDeleteTombstone(
        event.eventType === 'edit' ? event.targetEventId : event.eventId
      )
    ) {
      return { ok: false, reason: 'event-deleted' };
    }
    if (typeof payloadJson !== 'string' || !payloadJson.trim()) {
      return { ok: false, reason: 'empty-payload' };
    }
    const sizeBytes = Buffer.byteLength(payloadJson, 'utf8');
    if (sizeBytes <= 0 || sizeBytes > RETICULUM_CHAT_RELAY_EVENT_MAX_BYTES) {
      return { ok: false, reason: 'payload-too-large' };
    }
    const blobId = reticulumChatRelayBlobId(payloadJson);
    this.stmtDeleteRelayByEvent.run(event.eventId);
    this.stmtDeleteRelayBlob.run(blobId);
    const inserted = this.stmtInsertRelayBlob.run({
      blob_id: blobId,
      event_id: event.eventId,
      group_id: event.groupId,
      group_hash: reticulumChatRelayGroupHash(event.groupId),
      created_at: now,
      expires_at: now + RETICULUM_CHAT_RELAY_CACHE_MAX_AGE_MS,
      size_bytes: sizeBytes,
      encoding: 'plain-json-v1',
      encryption: 'none',
      key_epoch: null,
      encrypted_key_id: null,
      payload_json: payloadJson,
      source_peer_hash: sourcePeerHash.trim().toLowerCase(),
    });
    this.memoryRelayCache.set(event.eventId, {
      blobId,
      eventId: event.eventId,
      groupId: event.groupId,
      groupHash: reticulumChatRelayGroupHash(event.groupId),
      createdAt: now,
      expiresAt: now + RETICULUM_CHAT_RELAY_CACHE_MAX_AGE_MS,
      sizeBytes,
      encoding: 'plain-json-v1',
      encryption: 'none',
      keyEpoch: null,
      encryptedKeyId: null,
      payloadJson,
      sourcePeerHash: sourcePeerHash.trim().toLowerCase(),
      servedCount: 0,
      lastServedAt: null,
    });
    this.enforceOfflineRelayCacheLimit(now);
    return { ok: true, blobId, stored: inserted.changes > 0 || this.memoryRelayCache.has(event.eventId) };
  }

  private eventHasDeleteTombstone(rootEventId: string | undefined): boolean {
    if (typeof rootEventId !== 'string' || !rootEventId) return false;
    return this.findDeleteTombstone(rootEventId) !== null;
  }

  getRelayEventBlob(
    groupId: number,
    eventId: string,
    now = Date.now()
  ): ReticulumChatRelayCacheEntry | null {
    const memoryEntry = this.memoryRelayCache.get(eventId);
    if (memoryEntry && memoryEntry.groupId === groupId && memoryEntry.expiresAt > now) {
      const served = {
        ...memoryEntry,
        servedCount: memoryEntry.servedCount + 1,
        lastServedAt: now,
      };
      this.memoryRelayCache.set(eventId, served);
      return served;
    }
    if (memoryEntry && memoryEntry.expiresAt <= now) this.memoryRelayCache.delete(eventId);
    this.stmtDeleteRelayExpired.run(now);
    const row = this.stmtGetRelayBlobByEvent.get(groupId, eventId, now) as RelayCacheRow | undefined;
    if (!row) return null;
    this.stmtMarkRelayBlobServed.run(now, row.blob_id);
    return relayRowToEntry(row);
  }

  listRelayDigestEntries(
    groupId: number,
    offset = 0,
    limit = 32,
    now = Date.now()
  ): ReticulumChatRelayDigestEntry[] {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    const boundedOffset = Math.max(0, Math.floor(offset));
    const boundedLimit = Math.max(1, Math.min(256, Math.floor(limit)));
    this.stmtDeleteRelayExpired.run(now);
    const byEventId = new Map<string, ReticulumChatRelayDigestEntry>();
    for (const [eventId, entry] of this.memoryRelayCache) {
      if (entry.expiresAt <= now) {
        this.memoryRelayCache.delete(eventId);
        continue;
      }
      if (entry.groupId !== groupId) continue;
      const digestEntry = this.relayEntryToDigestEntry(entry, now);
      if (digestEntry) byEventId.set(digestEntry.eventId, digestEntry);
    }
    const rows = this.stmtListRelayDigestEntries.all(
      groupId,
      now,
      boundedLimit + boundedOffset,
      0
    ) as RelayCacheRow[];
    for (const row of rows) {
      const digestEntry = this.relayEntryToDigestEntry(relayRowToEntry(row), now);
      if (digestEntry && !byEventId.has(digestEntry.eventId)) {
        byEventId.set(digestEntry.eventId, digestEntry);
      }
    }
    return [...byEventId.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId))
      .slice(boundedOffset, boundedOffset + boundedLimit);
  }

  upsertGroupKey(key: ReticulumChatGroupKey): void {
    const groupId = Number(key.groupId);
    const epoch = Number(key.epoch);
    const keyId = typeof key.keyId === 'string' ? key.keyId.trim().toLowerCase() : '';
    const normalized: ReticulumChatGroupKey = {
      ...key,
      groupId,
      epoch,
      keyId,
    };
    this.memoryGroupKeys.set(`${groupId}:${epoch}:${keyId}`, normalized);
    this.stmtUpsertGroupKey.run(
      groupId,
      epoch,
      keyId,
      key.keyBytesBase64,
      key.createdBy,
      key.createdAt,
      key.status,
      key.adminPublicKey,
      key.adminSignature
    );
  }

  getActiveGroupKey(groupId: number): ReticulumChatGroupKey | null {
    if (!Number.isInteger(groupId) || groupId <= 0) return null;
    const memory = [...this.memoryGroupKeys.values()]
      .filter((key) => key.groupId === groupId && key.status === 'active')
      .sort((a, b) => b.epoch - a.epoch || a.keyId.localeCompare(b.keyId) || a.createdAt - b.createdAt)[0];
    if (memory) return memory;
    const row = this.stmtGetActiveGroupKey.get(groupId) as GroupKeyRow | undefined;
    return row ? groupKeyRowToEntry(row) : null;
  }

  getGroupKey(groupId: number, epoch: number, keyId: string): ReticulumChatGroupKey | null {
    if (!Number.isInteger(groupId) || groupId <= 0) return null;
    if (!Number.isInteger(epoch) || epoch <= 0) return null;
    const normalizedKeyId = typeof keyId === 'string' ? keyId.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(normalizedKeyId)) return null;
    const memory = this.memoryGroupKeys.get(`${groupId}:${epoch}:${normalizedKeyId}`);
    if (memory) return memory;
    const row = this.stmtGetGroupKey.get(groupId, epoch, normalizedKeyId) as GroupKeyRow | undefined;
    return row ? groupKeyRowToEntry(row) : null;
  }

  upsertGroupKeyDigest(digest: ReticulumChatGroupKeyDigest): void {
    if (!Number.isInteger(digest.groupId) || digest.groupId <= 0) return;
    if (!Number.isInteger(digest.epoch) || digest.epoch <= 0) return;
    if (!/^[0-9a-f]{64}$/i.test(digest.keyId)) return;
    const key = `${digest.groupId}:${digest.epoch}:${digest.keyId.toLowerCase()}`;
    this.memoryGroupKeyDigests.set(key, {
      ...digest,
      keyId: digest.keyId.toLowerCase(),
      sourcePeerHash: digest.sourcePeerHash.trim().toLowerCase(),
    });
    this.stmtUpsertGroupKeyDigest.run(
      digest.groupId,
      digest.epoch,
      digest.keyId.toLowerCase(),
      digest.createdBy,
      digest.createdAt,
      digest.adminPublicKey,
      digest.adminSignature,
      digest.sourcePeerHash.trim().toLowerCase(),
      digest.seenAt
    );
  }

  getLatestGroupKeyDigest(groupId: number): ReticulumChatGroupKeyDigest | null {
    if (!Number.isInteger(groupId) || groupId <= 0) return null;
    const memory = [...this.memoryGroupKeyDigests.values()]
      .filter((digest) => digest.groupId === groupId)
      .sort((a, b) => b.epoch - a.epoch || b.createdAt - a.createdAt || a.keyId.localeCompare(b.keyId))[0];
    if (memory) return memory;
    const row = this.stmtGetLatestGroupKeyDigest.get(groupId) as GroupKeyDigestRow | undefined;
    return row ? groupKeyDigestRowToEntry(row) : null;
  }

  listGroupKeyDigests(groupId: number, limit = 4): ReticulumChatGroupKeyDigest[] {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    const boundedLimit = Math.max(1, Math.min(16, Math.floor(limit)));
    const rows = this.stmtListGroupKeyDigests.all(
      groupId,
      boundedLimit
    ) as GroupKeyDigestRow[];
    const byKey = new Map<string, ReticulumChatGroupKeyDigest>();
    for (const row of rows) {
      const entry = groupKeyDigestRowToEntry(row);
      byKey.set(`${entry.groupId}:${entry.epoch}:${entry.keyId}`, entry);
    }
    for (const entry of this.memoryGroupKeyDigests.values()) {
      if (entry.groupId === groupId) byKey.set(`${entry.groupId}:${entry.epoch}:${entry.keyId}`, entry);
    }
    return [...byKey.values()]
      .sort((a, b) => b.epoch - a.epoch || b.createdAt - a.createdAt || a.keyId.localeCompare(b.keyId))
      .slice(0, boundedLimit);
  }

  upsertGroupKeyRequest(request: ReticulumChatGroupKeyRequest): void {
    if (!Number.isInteger(request.groupId) || request.groupId <= 0) return;
    if (!Number.isInteger(request.epoch) || request.epoch <= 0) return;
    if (!/^[0-9a-f]{64}$/i.test(request.keyId)) return;
    if (!/^[0-9a-f]{8,64}$/i.test(request.requestId)) return;
    const normalized: ReticulumChatGroupKeyRequest = {
      ...request,
      keyId: request.keyId.toLowerCase(),
      requestId: request.requestId.toLowerCase(),
      attempts: Math.max(0, Math.floor(request.attempts)),
    };
    this.memoryGroupKeyRequests.set(
      `${request.groupId}:${request.epoch}:${request.keyId.toLowerCase()}`,
      normalized
    );
    this.stmtUpsertGroupKeyRequest.run(
      request.groupId,
      request.epoch,
      request.keyId.toLowerCase(),
      request.requestId.toLowerCase(),
      request.requestedAt,
      Math.max(0, Math.floor(request.attempts)),
      request.status
    );
  }

  listPendingGroupKeyRequests(limit = 64): ReticulumChatGroupKeyRequest[] {
    const boundedLimit = Math.max(1, Math.min(256, Math.floor(limit)));
    const rows = this.stmtGetPendingGroupKeyRequests.all(boundedLimit) as GroupKeyRequestRow[];
    const byKey = new Map<string, ReticulumChatGroupKeyRequest>();
    for (const row of rows) {
      const entry: ReticulumChatGroupKeyRequest = {
        groupId: row.group_id,
        epoch: row.epoch,
        keyId: row.key_id,
        requestId: row.request_id,
        requestedAt: row.requested_at,
        attempts: row.attempts,
        status: row.status === 'fulfilled' || row.status === 'failed' ? row.status : 'pending',
      };
      byKey.set(`${entry.groupId}:${entry.epoch}:${entry.keyId}`, entry);
    }
    for (const entry of this.memoryGroupKeyRequests.values()) {
      if (entry.status === 'pending') byKey.set(`${entry.groupId}:${entry.epoch}:${entry.keyId}`, entry);
    }
    return [...byKey.values()]
      .filter((entry) => entry.status === 'pending')
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .slice(0, boundedLimit);
  }

  markGroupKeyRequestStatus(
    groupId: number,
    epoch: number,
    keyId: string,
    status: 'pending' | 'fulfilled' | 'failed'
  ): void {
    if (!Number.isInteger(groupId) || groupId <= 0) return;
    if (!Number.isInteger(epoch) || epoch <= 0) return;
    if (!/^[0-9a-f]{64}$/i.test(keyId)) return;
    const normalizedKeyId = keyId.toLowerCase();
    const memory = this.memoryGroupKeyRequests.get(`${groupId}:${epoch}:${normalizedKeyId}`);
    if (memory) {
      this.memoryGroupKeyRequests.set(`${groupId}:${epoch}:${normalizedKeyId}`, {
        ...memory,
        status,
      });
    }
    this.stmtMarkGroupKeyRequestStatus.run(status, groupId, epoch, keyId.toLowerCase());
  }

  getOfflineRelayCacheBytes(now = Date.now()): number {
    this.stmtDeleteRelayExpired.run(now);
    let memoryTotal = 0;
    for (const [eventId, entry] of this.memoryRelayCache) {
      if (entry.expiresAt <= now) {
        this.memoryRelayCache.delete(eventId);
        continue;
      }
      memoryTotal += entry.sizeBytes;
    }
    const row = this.stmtTotalRelayBytes.get() as { total?: number } | undefined;
    const sqliteTotal = typeof row?.total === 'number' ? row.total : 0;
    return Math.max(sqliteTotal, memoryTotal);
  }

  upsertSearchText(
    event: ReticulumChatEvent,
    text: string,
    replaceExisting = true
  ): void {
    const normalized = normalizeSearchText(text);
    if (!normalized) return;
    this.memorySearchText.set(event.eventId, normalized);
    if (replaceExisting) this.stmtDeleteSearchText.run(event.eventId);
    this.stmtUpsertSearchMirror.run(
      event.eventId,
      event.groupId,
      normalizeReticulumChatChannelId(event.channelId),
      event.authorAddress,
      event.timestamp,
      event.eventType,
      normalized
    );
    this.stmtUpsertSearchText.run(
      event.eventId,
      event.groupId,
      normalizeReticulumChatChannelId(event.channelId),
      event.authorAddress,
      event.timestamp,
      event.eventType,
      normalized
    );
  }

  private rootEventIdForIndexEvent(event: ReticulumChatEvent): string {
    return event.eventType === 'edit' && event.targetEventId
      ? event.targetEventId
      : event.eventId;
  }

  private computeMessageProjectionForRoot(
    rootEventId: string
  ): MessageProjectionRow | null {
    if (typeof rootEventId !== 'string' || !rootEventId) return null;
    const rows = this.stmtGetMessageProjectionEvents.all(
      rootEventId,
      rootEventId
    ) as EventRow[];
    const eventsById = new Map<string, ReticulumChatEvent>();
    for (const row of rows) {
      const event = rowToEvent(row);
      eventsById.set(event.eventId, event);
    }
    for (const event of this.memoryEvents.values()) {
      if (event.eventId === rootEventId || event.targetEventId === rootEventId) {
        eventsById.set(event.eventId, event);
      }
    }
    const events = [...eventsById.values()].sort(
      (a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId)
    );
    const root = events.find(
      (candidate) =>
        candidate.eventId === rootEventId &&
        (candidate.eventType === 'message' ||
          candidate.eventType === 'attachment_manifest')
    );
    if (!root) return null;
    const expiresAt = this.rootMessageExpiresAt(root);
    if (expiresAt !== null && expiresAt <= Date.now()) return null;

    let current = root;
    let deletedAt: number | null = null;
    let deletedEventId: string | null = null;
    for (const event of events) {
      if (event.eventId === root.eventId) continue;
      if (event.targetEventId !== root.eventId) continue;
      if (event.eventType === 'edit') {
        if (deletedAt !== null) continue;
        current = event;
        continue;
      }
      if (event.eventType === 'delete') {
        deletedAt = event.timestamp;
        deletedEventId = event.eventId;
      }
    }

    return {
      root_event_id: root.eventId,
      group_id: root.groupId,
      channel_id: normalizeReticulumChatChannelId(root.channelId),
      author_address: root.authorAddress,
      author_public_key: root.authorPublicKey,
      author_seq: root.authorSeq,
      created_at: root.timestamp,
      root_event_type: root.eventType,
      current_event_id: current.eventId,
      updated_at: current.timestamp,
      reply_to_event_id: root.replyToEventId ?? null,
      encrypted_payload: current.encryptedPayload,
      payload_hash: current.payloadHash,
      mention_address_hashes: serializeMentionAddressHashes(
        current.mentionAddressHashes
      ),
      mention_targets: serializeMentionTargets(current.mentionTargets),
      signature: root.signature,
      deleted_at: deletedAt,
      deleted_event_id: deletedEventId,
      expires_at: expiresAt,
      has_attachment:
        root.eventType === 'attachment_manifest' ||
        payloadHasReticulumFileAttachment(current.encryptedPayload)
          ? 1
          : 0,
    };
  }

  private currentMessageProjectionForIndexEvent(
    event: ReticulumChatEvent
  ): MessageProjectionRow | null {
    const rootEventId = this.rootEventIdForIndexEvent(event);
    if (!rootEventId) return null;
    const row = this.computeMessageProjectionForRoot(rootEventId);
    if (!row || row.deleted_at !== null) return null;
    if (row.current_event_id !== event.eventId) return null;
    return row;
  }

  private upsertProjectedSearchText(
    projection: MessageProjectionRow,
    text: string
  ): void {
    const normalized = normalizeSearchText(text);
    if (!normalized) return;
    const rootEventId = projection.root_event_id;
    this.memorySearchText.set(rootEventId, normalized);
    this.stmtDeleteSearchText.run(rootEventId);
    this.stmtUpsertSearchMirror.run(
      rootEventId,
      projection.group_id,
      normalizeReticulumChatChannelId(projection.channel_id),
      projection.author_address,
      projection.created_at,
      projection.root_event_type,
      normalized
    );
    this.stmtUpsertSearchText.run(
      rootEventId,
      projection.group_id,
      normalizeReticulumChatChannelId(projection.channel_id),
      projection.author_address,
      projection.created_at,
      projection.root_event_type,
      normalized
    );
  }

  indexSearchText(eventId: string, text: string): boolean {
    const event = this.getEvent(eventId);
    if (!event) return false;
    const projection = this.currentMessageProjectionForIndexEvent(event);
    if (!projection) return false;
    this.upsertProjectedSearchText(projection, text);
    return true;
  }

  deleteSearchText(eventId: string): boolean {
    if (typeof eventId !== 'string' || !eventId) return false;
    this.memorySearchText.delete(eventId);
    this.stmtDeleteSearchText.run(eventId);
    this.stmtDeleteSearchMirror.run(eventId);
    return true;
  }

  replaceMentionsForEvent(
    eventId: string,
    mentionedAddresses: string[]
  ): boolean {
    const event = this.getEvent(eventId);
    if (!event) return false;
    const projection = this.currentMessageProjectionForIndexEvent(event);
    if (!projection) return false;
    const rootEventId = projection.root_event_id;
    const uniqueMentionedAddresses = [
      ...new Set(
        mentionedAddresses
          .map((address) =>
            typeof address === 'string' ? address.trim() : ''
          )
          .filter(Boolean)
      ),
    ];
    this.memoryMentions.set(
      rootEventId,
      uniqueMentionedAddresses.map((mentionedAddress) => ({
        groupId: projection.group_id,
        channelId: normalizeReticulumChatChannelId(projection.channel_id),
        mentionedAddress,
        authorAddress: projection.author_address,
        timestamp: projection.updated_at,
        readAt: 0,
      }))
    );
    const tx = this.db.transaction(() => {
      this.stmtDeleteMentionsForEvent.run(rootEventId);
      for (const mentionedAddress of uniqueMentionedAddresses) {
        this.stmtUpsertMention.run(
          rootEventId,
          projection.group_id,
          normalizeReticulumChatChannelId(projection.channel_id),
          mentionedAddress,
          projection.author_address,
          projection.updated_at
        );
      }
    });
    tx();
    return true;
  }

  deleteMentionsForEvent(eventId: string): boolean {
    if (typeof eventId !== 'string' || !eventId) return false;
    this.memoryMentions.delete(eventId);
    this.stmtDeleteMentionsForEvent.run(eventId);
    return true;
  }

  searchEvents(
    query: string,
    options: ReticulumChatSearchOptions = {}
  ): ReticulumChatSearchResult[] {
    const now = Date.now();
    this.pruneExpiredMessagesThrottled(now);
    const ftsQuery = buildFtsQuery(query);
    const terms = buildSearchTerms(query);
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.min(10_000, Math.floor(options.offset ?? 0)));
    const groupIds = (options.groupIds ?? [])
      .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
      .slice(0, 500);
    const allowedGroups = groupIds.length > 0 ? new Set(groupIds) : null;
    const channelIds = (options.channelIds ?? [])
      .map(normalizeReticulumChatChannelId)
      .filter(Boolean);
    const allowedChannels = channelIds.length > 0 ? new Set(channelIds) : null;
    const authorAddresses = (options.authorAddresses ?? [])
      .map((address) => (typeof address === 'string' ? address.trim() : ''))
      .filter(Boolean)
      .slice(0, 500);
    const allowedAuthors =
      authorAddresses.length > 0 ? new Set(authorAddresses) : null;
    const eventTypes = (options.eventTypes ?? [])
      .filter(
        (eventType) =>
          eventType === 'message' || eventType === 'attachment_manifest'
      )
      .slice(0, 2);
    const hasAttachment = options.hasAttachment === true;
    const normalizedEventTypes = eventTypes;
    const allowedEventTypes =
      normalizedEventTypes.length > 0 ? new Set(normalizedEventTypes) : null;
    const beforeTimestamp = Number.isFinite(Number(options.beforeTimestamp))
      ? Number(options.beforeTimestamp)
      : null;
    const afterTimestamp = Number.isFinite(Number(options.afterTimestamp))
      ? Number(options.afterTimestamp)
      : null;
    const hasLink = options.hasLink === true;
    const sort =
      options.sort === 'newest' || options.sort === 'oldest'
        ? options.sort
        : 'relevance';
    const effectiveCursorSort: 'newest' | 'oldest' | null =
      sort === 'oldest' ? 'oldest' : sort === 'newest' || !ftsQuery ? 'newest' : null;
    const cursor = effectiveCursorSort
      ? normalizeSearchCursor(options.cursor)
      : null;
    const includeAdminPrivate = options.includeAdminPrivate === true;
    const hasAnyFilter =
      groupIds.length > 0 ||
      channelIds.length > 0 ||
      authorAddresses.length > 0 ||
      normalizedEventTypes.length > 0 ||
      beforeTimestamp !== null ||
      afterTimestamp !== null ||
      hasAttachment ||
      hasLink;
    if (!ftsQuery && !hasAnyFilter) return [];

    const usesFts = Boolean(ftsQuery);
    const searchTextExpression = usesFts
      ? 'reticulum_chat_search_fts.search_text'
      : 'reticulum_chat_search_index.search_text';
    const clauses = [
      'p.deleted_at IS NULL',
      '(p.expires_at IS NULL OR p.expires_at > ?)',
    ];
    const params: Array<string | number> = [now];
    if (usesFts) {
      clauses.unshift('reticulum_chat_search_fts MATCH ?');
      params.unshift(ftsQuery);
    }
    if (groupIds.length > 0) {
      clauses.push(`p.group_id IN (${groupIds.map(() => '?').join(', ')})`);
      params.push(...groupIds);
    }
    if (channelIds.length > 0) {
      clauses.push(`p.channel_id IN (${channelIds.map(() => '?').join(', ')})`);
      params.push(...channelIds);
    }
    if (authorAddresses.length > 0) {
      clauses.push(
        `p.author_address IN (${authorAddresses.map(() => '?').join(', ')})`
      );
      params.push(...authorAddresses);
    }
    if (normalizedEventTypes.length > 0) {
      clauses.push(
        `p.root_event_type IN (${normalizedEventTypes
          .map(() => '?')
          .join(', ')})`
      );
      params.push(...normalizedEventTypes);
    }
    if (afterTimestamp !== null) {
      clauses.push('p.created_at >= ?');
      params.push(afterTimestamp);
    }
    if (beforeTimestamp !== null) {
      clauses.push('p.created_at < ?');
      params.push(beforeTimestamp);
    }
    if (hasAttachment) {
      clauses.push('p.has_attachment = 1');
    }
    if (hasLink) {
      clauses.push(
        `(lower(COALESCE(${searchTextExpression}, '')) LIKE ? OR lower(COALESCE(${searchTextExpression}, '')) LIKE ?)`
      );
      params.push('%http%', '%www.%');
    }
    if (!includeAdminPrivate) {
      clauses.push("(c.read_mode IS NULL OR c.read_mode != 'admins')");
    }
    if (cursor && effectiveCursorSort === 'oldest') {
      clauses.push(
        '(p.created_at > ? OR (p.created_at = ? AND p.root_event_id > ?))'
      );
      params.push(cursor.createdAt, cursor.createdAt, cursor.eventId);
    } else if (cursor && effectiveCursorSort === 'newest') {
      clauses.push(
        '(p.created_at < ? OR (p.created_at = ? AND p.root_event_id < ?))'
      );
      params.push(cursor.createdAt, cursor.createdAt, cursor.eventId);
    }
    const orderBy =
      sort === 'oldest'
        ? 'p.created_at ASC, p.root_event_id ASC'
        : sort === 'newest' || !usesFts
          ? 'p.created_at DESC, p.root_event_id DESC'
          : 'bm25(reticulum_chat_search_fts) ASC, p.created_at DESC, p.root_event_id DESC';
    params.push(limit, cursor ? 0 : offset);
    const sql = usesFts
      ? `
          SELECT
            p.*,
            reticulum_chat_search_fts.search_text AS search_text,
            snippet(reticulum_chat_search_fts, 6, '<mark>', '</mark>', '...', 18) AS snippet
          FROM reticulum_chat_search_fts
          JOIN rchat_message_projection p
            ON p.root_event_id = reticulum_chat_search_fts.event_id
          LEFT JOIN reticulum_chat_channels c
            ON c.group_id = p.group_id AND c.channel_id = p.channel_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY ${orderBy}
          LIMIT ? OFFSET ?
        `
      : `
          SELECT
            p.*,
            reticulum_chat_search_index.search_text AS search_text,
            NULL AS snippet
          FROM rchat_message_projection p
          LEFT JOIN reticulum_chat_search_index
            ON reticulum_chat_search_index.event_id = p.root_event_id
          LEFT JOIN reticulum_chat_channels c
            ON c.group_id = p.group_id AND c.channel_id = p.channel_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY ${orderBy}
          LIMIT ? OFFSET ?
        `;
    const rows = this.db
      .prepare(sql)
      .all(...params) as Array<
        MessageProjectionRow & { search_text?: string; snippet?: string }
      >;
    const results: ReticulumChatSearchResult[] = [];
    for (const row of rows) {
      if (this.isEventPayloadScrubbed(row.root_event_id)) continue;
      results.push({
        event: messageProjectionRowToEvent(row),
        snippet: row.snippet || buildPlainSnippet(row.search_text ?? '', terms),
        cursor: searchCursorFromProjection(row),
      });
      if (results.length >= limit) break;
    }
    if (results.length > 0) return results;
    const mirrorResults = this.searchEventsMirror(
      terms,
      allowedGroups,
      allowedChannels,
      allowedAuthors,
      allowedEventTypes,
      includeAdminPrivate,
      beforeTimestamp,
      afterTimestamp,
      hasAttachment,
      hasLink,
      sort,
      now,
      limit,
      cursor ? 0 : offset,
      cursor,
      effectiveCursorSort
    );
    return mirrorResults.length > 0
      ? mirrorResults
      : this.searchEventsMemory(
          terms,
          allowedGroups,
          allowedChannels,
          allowedAuthors,
          allowedEventTypes,
          includeAdminPrivate,
          beforeTimestamp,
          afterTimestamp,
          hasAttachment,
          hasLink,
          sort,
          now,
          limit,
          cursor ? 0 : offset,
          cursor,
          effectiveCursorSort
        );
  }

  getMessageWindowAroundEvent(
    groupId: number,
    channelId: string,
    eventId: string,
    options: ReticulumChatMessageWindowOptions = {}
  ): ReticulumChatEvent[] {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const rootEventId = typeof eventId === 'string' ? eventId.trim() : '';
    if (!normalizedChannelId || !rootEventId) return [];
    const now = Date.now();
    this.pruneExpiredMessagesThrottled(now);
    const includeAdminPrivate = options.includeAdminPrivate === true;
    const readClause = includeAdminPrivate
      ? ''
      : "AND (c.read_mode IS NULL OR c.read_mode != 'admins')";
    const target = this.db
      .prepare(
        `
          SELECT p.*
          FROM rchat_message_projection p
          LEFT JOIN reticulum_chat_channels c
            ON c.group_id = p.group_id AND c.channel_id = p.channel_id
          WHERE p.group_id = ?
            AND p.channel_id = ?
            AND p.root_event_id = ?
            AND p.deleted_at IS NULL
            AND (p.expires_at IS NULL OR p.expires_at > ?)
            ${readClause}
          LIMIT 1
        `
      )
      .get(groupId, normalizedChannelId, rootEventId, now) as
      | MessageProjectionRow
      | undefined;
    if (!target) return [];
    const beforeLimit = Math.max(
      0,
      Math.min(250, Math.floor(options.beforeLimit ?? 80))
    );
    const afterLimit = Math.max(
      0,
      Math.min(250, Math.floor(options.afterLimit ?? 40))
    );
    const beforeRows = beforeLimit > 0
      ? (this.db
          .prepare(
            `
              SELECT p.*
              FROM rchat_message_projection p
              LEFT JOIN reticulum_chat_channels c
                ON c.group_id = p.group_id AND c.channel_id = p.channel_id
              WHERE p.group_id = ?
                AND p.channel_id = ?
                AND p.deleted_at IS NULL
                AND (p.expires_at IS NULL OR p.expires_at > ?)
                AND (
                  p.created_at < ?
                  OR (p.created_at = ? AND p.root_event_id < ?)
                )
                ${readClause}
              ORDER BY p.created_at DESC, p.root_event_id DESC
              LIMIT ?
            `
          )
          .all(
            groupId,
            normalizedChannelId,
            now,
            target.created_at,
            target.created_at,
            target.root_event_id,
            beforeLimit
          ) as MessageProjectionRow[])
      : [];
    const afterRows = afterLimit > 0
      ? (this.db
          .prepare(
            `
              SELECT p.*
              FROM rchat_message_projection p
              LEFT JOIN reticulum_chat_channels c
                ON c.group_id = p.group_id AND c.channel_id = p.channel_id
              WHERE p.group_id = ?
                AND p.channel_id = ?
                AND p.deleted_at IS NULL
                AND (p.expires_at IS NULL OR p.expires_at > ?)
                AND (
                  p.created_at > ?
                  OR (p.created_at = ? AND p.root_event_id > ?)
                )
                ${readClause}
              ORDER BY p.created_at ASC, p.root_event_id ASC
              LIMIT ?
            `
          )
          .all(
            groupId,
            normalizedChannelId,
            now,
            target.created_at,
            target.created_at,
            target.root_event_id,
            afterLimit
          ) as MessageProjectionRow[])
      : [];
    return [...beforeRows.reverse(), target, ...afterRows].map(
      messageProjectionRowToEvent
    );
  }

  getRecentEvents(groupId: number, limit: number, channelId: string | null = null): ReticulumChatEvent[] {
    this.pruneExpiredMessagesThrottled();
    const normalizedChannelId = channelId == null ? null : normalizeReticulumChatChannelId(channelId);
    if (normalizedChannelId == null) {
      const rows = this.db
        .prepare(`
          SELECT * FROM (
            SELECT * FROM reticulum_chat_events
            WHERE group_id = ? AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
            ORDER BY timestamp DESC, event_id DESC
            LIMIT ?
          )
          ORDER BY timestamp ASC, event_id ASC
        `)
        .all(groupId, limit) as EventRow[];
      return this.mergeWindowEvents(
        rows.map(rowToEvent),
        [...this.memoryEvents.values()]
          .filter((event) => event.groupId === groupId && this.eventIsVisible(event))
          .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
          .slice(0, limit),
        limit
      );
    }
    return this.mergeWindowEvents(
      (this.stmtGetRecentEvents.all(groupId, normalizedChannelId, limit) as EventRow[]).map(rowToEvent),
      [...this.memoryEvents.values()]
        .filter((event) =>
          event.groupId === groupId &&
          normalizeReticulumChatChannelId(event.channelId) === normalizedChannelId &&
          this.eventIsVisible(event)
        )
        .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
        .slice(0, limit),
      limit
    );
  }

  getRecentMessageEvents(
    groupId: number,
    limit: number,
    channelId: string | null = null
  ): ReticulumChatEvent[] {
    const now = Date.now();
    this.pruneExpiredMessagesThrottled(now);
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const normalizedChannelId = channelId == null ? null : normalizeReticulumChatChannelId(channelId);
    const rows =
      normalizedChannelId == null
        ? (this.stmtGetRecentMessageEventsAllChannels.all(
            groupId,
            now,
            safeLimit
          ) as MessageProjectionRow[])
        : (this.stmtGetRecentMessageEvents.all(
            groupId,
            normalizedChannelId,
            now,
            safeLimit
          ) as MessageProjectionRow[]);
    return rows.map(messageProjectionRowToEvent);
  }

  private isChannelMetadataEventType(eventType: string): boolean {
    return (
      eventType === 'channel_create' ||
      eventType === 'channel_update' ||
      eventType === 'channel_archive' ||
      eventType === 'channel_restore' ||
      eventType === 'channel_reorder' ||
      eventType === 'category_create' ||
      eventType === 'category_update' ||
      eventType === 'category_delete'
    );
  }

  getChannelMetadataEvents(groupId: number, limit: number): ReticulumChatEvent[] {
    const maxLimit = Math.max(1, Math.min(500, limit));
    const seen = new Set<string>();
    return [
      ...(this.stmtGetChannelMetadataEvents.all(groupId, maxLimit) as EventRow[]).map(rowToEvent),
      [...this.memoryEvents.values()]
        .filter((event) => event.groupId === groupId && this.isChannelMetadataEventType(event.eventType))
        .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
        .slice(0, maxLimit),
    ].flat()
      .filter((event) => {
        if (!this.isChannelMetadataEventType(event.eventType)) return false;
        if (seen.has(event.eventId)) return false;
        seen.add(event.eventId);
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
      .slice(0, maxLimit)
      .sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
  }

  getChannelMetadataPageAfter(
    groupId: number,
    cursor: ReticulumChatFeedCursor | null,
    limit: number
  ): ReticulumChatEvent[] {
    const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
    const effectiveCursor = cursor ?? { feedTimestamp: -1, eventId: '' };
    const matches = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.isChannelMetadataEventType(event.eventType)) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        effectiveCursor
      ) > 0;
    };
    return this.mergeWindowEvents(
      (this.stmtGetChannelMetadataPageAfter.all(
        groupId,
        effectiveCursor.feedTimestamp,
        effectiveCursor.feedTimestamp,
        effectiveCursor.eventId,
        safeLimit
      ) as EventRow[]).map(rowToEvent).filter(matches),
      [...this.memoryEvents.values()].filter(matches),
      safeLimit
    );
  }

  getChannelMetadataPageBefore(
    groupId: number,
    cursor: ReticulumChatFeedCursor,
    limit: number
  ): ReticulumChatEvent[] {
    const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
    const matches = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.isChannelMetadataEventType(event.eventType)) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        cursor
      ) < 0;
    };
    return this.mergeNewestWindowEvents(
      (this.stmtGetChannelMetadataPageBefore.all(
        groupId,
        cursor.feedTimestamp,
        cursor.feedTimestamp,
        cursor.eventId,
        safeLimit
      ) as EventRow[]).map(rowToEvent).filter(matches),
      [...this.memoryEvents.values()].filter(matches),
      safeLimit
    );
  }

  getChannelMetadataPageAtOrBefore(
    groupId: number,
    cursor: ReticulumChatFeedCursor,
    limit: number
  ): ReticulumChatEvent[] {
    const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
    const matches = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.isChannelMetadataEventType(event.eventType)) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        cursor
      ) <= 0;
    };
    return this.mergeNewestWindowEvents(
      (this.stmtGetChannelMetadataPageAtOrBefore.all(
        groupId,
        cursor.feedTimestamp,
        cursor.feedTimestamp,
        cursor.eventId,
        safeLimit
      ) as EventRow[]).map(rowToEvent).filter(matches),
      [...this.memoryEvents.values()].filter(matches),
      safeLimit
    );
  }

  getEventsAfter(
    groupId: number,
    afterTimestamp: number,
    limit: number,
    afterEventId?: string,
    channelId: string | null = null
  ): ReticulumChatEvent[] {
    const normalizedChannelId = channelId == null ? null : normalizeReticulumChatChannelId(channelId);
    const sqliteRows = afterEventId
      ? (normalizedChannelId == null
          ? (this.db.prepare(`
              SELECT * FROM reticulum_chat_events
              WHERE group_id = ? AND (timestamp > ? OR (timestamp = ? AND event_id > ?))
                AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
              ORDER BY timestamp ASC, event_id ASC
              LIMIT ?
            `).all(groupId, afterTimestamp, afterTimestamp, afterEventId, limit) as EventRow[])
          : (this.stmtGetEventsAfterCursor.all(
              groupId,
              normalizedChannelId,
              afterTimestamp,
              afterTimestamp,
              afterEventId,
              limit
            ) as EventRow[]))
      : (normalizedChannelId == null
          ? (this.db.prepare(`
              SELECT * FROM reticulum_chat_events
              WHERE group_id = ? AND timestamp > ?
                AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
              ORDER BY timestamp ASC, event_id ASC
              LIMIT ?
            `).all(groupId, afterTimestamp, limit) as EventRow[])
          : (this.stmtGetEventsAfter.all(groupId, normalizedChannelId, afterTimestamp, limit) as EventRow[]));
    const matchesAfter = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.eventIsVisible(event)) return false;
      if (normalizedChannelId != null && normalizeReticulumChatChannelId(event.channelId) !== normalizedChannelId) return false;
      if (!afterEventId) return event.timestamp > afterTimestamp;
      return event.timestamp > afterTimestamp ||
        (event.timestamp === afterTimestamp && event.eventId > afterEventId);
    };
    return this.mergeWindowEvents(
      sqliteRows.map(rowToEvent).filter(matchesAfter),
      [...this.memoryEvents.values()]
        .filter(matchesAfter)
        .sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId))
        .slice(0, limit),
      limit
    );
  }

  getEventsBefore(
    groupId: number,
    beforeTimestamp: number,
    limit: number,
    beforeEventId?: string,
    channelId: string | null = null
  ): ReticulumChatEvent[] {
    const normalizedChannelId = channelId == null ? null : normalizeReticulumChatChannelId(channelId);
    const sqliteRows = beforeEventId
      ? (normalizedChannelId == null
          ? (this.db.prepare(`
              SELECT * FROM (
                SELECT * FROM reticulum_chat_events
                WHERE group_id = ? AND (timestamp < ? OR (timestamp = ? AND event_id < ?))
                  AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
                ORDER BY timestamp DESC, event_id DESC
                LIMIT ?
              )
              ORDER BY timestamp ASC, event_id ASC
            `).all(groupId, beforeTimestamp, beforeTimestamp, beforeEventId, limit) as EventRow[])
          : (this.stmtGetEventsBeforeCursor.all(
              groupId,
              normalizedChannelId,
              beforeTimestamp,
              beforeTimestamp,
              beforeEventId,
              limit
            ) as EventRow[]))
      : (normalizedChannelId == null
          ? (this.db.prepare(`
              SELECT * FROM (
                SELECT * FROM reticulum_chat_events
                WHERE group_id = ? AND timestamp < ?
                  AND ${RETICULUM_CHAT_VISIBLE_EVENT_SQL}
                ORDER BY timestamp DESC, event_id DESC
                LIMIT ?
              )
              ORDER BY timestamp ASC, event_id ASC
            `).all(groupId, beforeTimestamp, limit) as EventRow[])
          : (this.stmtGetEventsBefore.all(groupId, normalizedChannelId, beforeTimestamp, limit) as EventRow[]));
    const matchesBefore = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.eventIsVisible(event)) return false;
      if (normalizedChannelId != null && normalizeReticulumChatChannelId(event.channelId) !== normalizedChannelId) return false;
      if (!beforeEventId) return event.timestamp < beforeTimestamp;
      return event.timestamp < beforeTimestamp ||
        (event.timestamp === beforeTimestamp && event.eventId < beforeEventId);
    };
    return this.mergeWindowEvents(
      sqliteRows.map(rowToEvent).filter(matchesBefore),
      [...this.memoryEvents.values()]
        .filter(matchesBefore)
        .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
        .slice(0, limit),
      limit
    );
  }

  getLatestFeedCursor(
    groupId: number,
    channelId: string
  ): ReticulumChatFeedCursor | null {
    const row = this.stmtGetLatestCursor.get(
      groupId,
      normalizeReticulumChatChannelId(channelId)
    ) as { event_id?: string; feed_timestamp?: number } | undefined;
    if (!row?.event_id || !Number.isFinite(row.feed_timestamp)) return null;
    let cursor: ReticulumChatFeedCursor = {
      eventId: row.event_id,
      feedTimestamp: Number(row.feed_timestamp),
    };
    for (const event of this.memoryEvents.values()) {
      if (event.groupId !== groupId) continue;
      if (!this.eventIsVisible(event)) continue;
      if (normalizeReticulumChatChannelId(event.channelId) !== normalizeReticulumChatChannelId(channelId)) continue;
      const next = { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) };
      if (this.compareFeedCursors(next, cursor) > 0) cursor = next;
    }
    return cursor;
  }

  getOldestFeedCursor(
    groupId: number,
    channelId: string
  ): ReticulumChatFeedCursor | null {
    const row = this.stmtGetOldestCursor.get(
      groupId,
      normalizeReticulumChatChannelId(channelId)
    ) as { event_id?: string; feed_timestamp?: number } | undefined;
    if (!row?.event_id || !Number.isFinite(row.feed_timestamp)) return null;
    let cursor: ReticulumChatFeedCursor = {
      eventId: row.event_id,
      feedTimestamp: Number(row.feed_timestamp),
    };
    for (const event of this.memoryEvents.values()) {
      if (event.groupId !== groupId) continue;
      if (!this.eventIsVisible(event)) continue;
      if (normalizeReticulumChatChannelId(event.channelId) !== normalizeReticulumChatChannelId(channelId)) continue;
      const next = { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) };
      if (this.compareFeedCursors(next, cursor) < 0) cursor = next;
    }
    return cursor;
  }

  getChannelDigestPage(
    groupId: number,
    limit: number,
    offset = 0
  ): { channels: ReticulumChatChannelDigest[]; hasMore: boolean; nextOffset?: number } {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    const rows = this.stmtGetChannelDigests.all(groupId, safeOffset + safeLimit + 1, 0) as Array<{
      channel_id?: string;
    }>;
    const sqliteChannelIds = rows.map((row) => normalizeReticulumChatChannelId(row.channel_id));
    const memoryChannelIds = [...this.memoryEvents.values()]
      .filter((event) => event.groupId === groupId && this.eventIsVisible(event))
      .map((event) => normalizeReticulumChatChannelId(event.channelId));
    const allChannelIds = [...new Set([...sqliteChannelIds, ...memoryChannelIds])];
    const channels = allChannelIds
      .sort((a, b) => {
        const cursorA = this.getLatestFeedCursor(groupId, a);
        const cursorB = this.getLatestFeedCursor(groupId, b);
        if (!cursorA && !cursorB) return a.localeCompare(b);
        if (!cursorA) return 1;
        if (!cursorB) return -1;
        return this.compareFeedCursors(cursorB, cursorA) || a.localeCompare(b);
      })
      .slice(safeOffset, safeOffset + safeLimit)
      .map((channelId) => {
        const events = this.getRecentEvents(groupId, 25, channelId);
        return {
          groupId,
          channelId,
          latestCursor: this.getLatestFeedCursor(groupId, channelId),
          oldestCursor: this.getOldestFeedCursor(groupId, channelId),
          visibleWindowHash: this.computeWindowHash(events),
        };
      });
    const hasMore = allChannelIds.length > safeOffset + channels.length;
    return {
      channels,
      hasMore,
      ...(hasMore ? { nextOffset: safeOffset + channels.length } : {}),
    };
  }

  getFeedPageAfter(
    groupId: number,
    channelId: string,
    cursor: ReticulumChatFeedCursor | null,
    limit: number
  ): ReticulumChatEvent[] {
    const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const effectiveCursor = cursor ?? { feedTimestamp: -1, eventId: '' };
    const rows = this.stmtGetFeedPageAfter.all(
      groupId,
      normalizedChannelId,
      effectiveCursor.feedTimestamp,
      effectiveCursor.feedTimestamp,
      effectiveCursor.eventId,
      safeLimit
    ) as EventRow[];
    const matches = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.eventIsVisible(event)) return false;
      if (normalizeReticulumChatChannelId(event.channelId) !== normalizedChannelId) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        effectiveCursor
      ) > 0;
    };
    return this.mergeWindowEvents(
      rows.map(rowToEvent).filter(matches),
      [...this.memoryEvents.values()].filter(matches),
      safeLimit
    );
  }

  getFeedPageBefore(
    groupId: number,
    channelId: string,
    cursor: ReticulumChatFeedCursor,
    limit: number
  ): ReticulumChatEvent[] {
    const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const rows = this.stmtGetFeedPageBefore.all(
      groupId,
      normalizedChannelId,
      cursor.feedTimestamp,
      cursor.feedTimestamp,
      cursor.eventId,
      safeLimit
    ) as EventRow[];
    const matches = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.eventIsVisible(event)) return false;
      if (normalizeReticulumChatChannelId(event.channelId) !== normalizedChannelId) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        cursor
      ) < 0;
    };
    return this.mergeNewestWindowEvents(
      rows.map(rowToEvent).filter(matches),
      [...this.memoryEvents.values()].filter(matches),
      safeLimit
    );
  }

  private mergeNewestWindowEvents(
    primary: ReticulumChatEvent[],
    secondary: ReticulumChatEvent[],
    limit: number
  ): ReticulumChatEvent[] {
    const seen = new Set<string>();
    return [...primary, ...secondary]
      .filter((event) => {
        if (seen.has(event.eventId)) return false;
        seen.add(event.eventId);
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
      .slice(0, limit)
      .sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
  }

  getFeedPageAtOrBefore(
    groupId: number,
    channelId: string,
    cursor: ReticulumChatFeedCursor,
    limit: number
  ): ReticulumChatEvent[] {
    const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const rows = this.stmtGetFeedPageAtOrBefore.all(
      groupId,
      normalizedChannelId,
      cursor.feedTimestamp,
      cursor.feedTimestamp,
      cursor.eventId,
      safeLimit
    ) as EventRow[];
    const matches = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.eventIsVisible(event)) return false;
      if (normalizeReticulumChatChannelId(event.channelId) !== normalizedChannelId) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        cursor
      ) <= 0;
    };
    return this.mergeNewestWindowEvents(
      rows.map(rowToEvent).filter(matches),
      [...this.memoryEvents.values()].filter(matches),
      safeLimit
    );
  }

  getGroupFeedPageAfter(
    groupId: number,
    cursor: ReticulumChatFeedCursor | null,
    limit: number
  ): ReticulumChatEvent[] {
    const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
    const effectiveCursor = cursor ?? { feedTimestamp: -1, eventId: '' };
    const rows = cursor
      ? this.stmtGetGroupEventsAfterCursor.all(
          groupId,
          effectiveCursor.feedTimestamp,
          effectiveCursor.feedTimestamp,
          effectiveCursor.eventId,
          safeLimit
        )
      : this.stmtGetGroupEventsAfter.all(
          groupId,
          effectiveCursor.feedTimestamp,
          safeLimit
        );
    const matches = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.eventIsVisible(event)) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        effectiveCursor
      ) > 0;
    };
    return this.mergeWindowEvents(
      (rows as EventRow[]).map(rowToEvent).filter(matches),
      [...this.memoryEvents.values()].filter(matches),
      safeLimit
    );
  }

  getGroupFeedPageBefore(
    groupId: number,
    cursor: ReticulumChatFeedCursor,
    limit: number
  ): ReticulumChatEvent[] {
    const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
    const rows = this.stmtGetGroupEventsBeforeCursor.all(
      groupId,
      cursor.feedTimestamp,
      cursor.feedTimestamp,
      cursor.eventId,
      safeLimit
    ) as EventRow[];
    const matches = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.eventIsVisible(event)) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        cursor
      ) < 0;
    };
    return this.mergeNewestWindowEvents(
      rows.map(rowToEvent).filter(matches),
      [...this.memoryEvents.values()].filter(matches),
      safeLimit
    );
  }

  getGroupFeedPageAtOrBefore(
    groupId: number,
    cursor: ReticulumChatFeedCursor,
    limit: number
  ): ReticulumChatEvent[] {
    const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
    const rows = this.stmtGetGroupEventsAtOrBeforeCursor.all(
      groupId,
      cursor.feedTimestamp,
      cursor.feedTimestamp,
      cursor.eventId,
      safeLimit
    ) as EventRow[];
    const matches = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      if (!this.eventIsVisible(event)) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        cursor
      ) <= 0;
    };
    return this.mergeNewestWindowEvents(
      rows.map(rowToEvent).filter(matches),
      [...this.memoryEvents.values()].filter(matches),
      safeLimit
    );
  }

  getAuthorEventsRange(
    groupId: number,
    authorAddress: string,
    fromSeq: number,
    toSeq: number,
    limit: number
  ): ReticulumChatEvent[] {
    const safeFrom = Math.max(1, Math.floor(fromSeq));
    const safeTo = Math.max(safeFrom, Math.floor(toSeq));
    const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
    const rows = this.stmtGetAuthorEventsRange.all(
      groupId,
      authorAddress,
      safeFrom,
      safeTo,
      safeLimit
    ) as EventRow[];
    const byId = new Map<string, ReticulumChatEvent>();
    for (const event of rows.map(rowToEvent)) {
      byId.set(event.eventId, event);
    }
    const memoryMatches = [...this.memoryEvents.values()].filter(
      (event) =>
        event.groupId === groupId &&
        event.authorAddress === authorAddress &&
        event.authorSeq >= safeFrom &&
        event.authorSeq <= safeTo
    );
    for (const event of memoryMatches) {
      byId.set(event.eventId, event);
    }
    return [...byId.values()]
      .sort(
        (a, b) =>
          b.authorSeq - a.authorSeq ||
          b.timestamp - a.timestamp ||
          b.eventId.localeCompare(a.eventId)
      )
      .slice(0, safeLimit);
  }

  computeWindowHash(events: ReticulumChatEvent[]): string {
    const eventsById = new Map<string, ReticulumChatEvent>();
    for (const event of events) {
      if (!eventsById.has(event.eventId)) {
        eventsById.set(event.eventId, event);
      }
    }
    const ids = [...eventsById.keys()]
      .sort((a, b) => {
        const eventA = eventsById.get(a);
        const eventB = eventsById.get(b);
        if (!eventA || !eventB) return a.localeCompare(b);
        return (
          this.normalizeFeedTimestamp(eventA.timestamp) - this.normalizeFeedTimestamp(eventB.timestamp) ||
          eventA.eventId.localeCompare(eventB.eventId)
        );
      });
    return nodeCrypto
      .createHash('sha256')
      .update(JSON.stringify(ids), 'utf8')
      .digest('hex');
  }

  upsertPeerGroupState(
    peerHash: string,
    groupId: number,
    latestCursor: ReticulumChatFeedCursor | null,
    digestHash = '',
    updatedAt = Date.now()
  ): void {
    const key = peerHash.trim().toLowerCase();
    if (!key || !Number.isInteger(groupId) || groupId <= 0) return;
    this.stmtUpsertPeerGroupState.run({
      peer_hash: key,
      group_id: groupId,
      latest_event_id: latestCursor?.eventId ?? null,
      latest_feed_timestamp: latestCursor?.feedTimestamp ?? null,
      digest_hash: digestHash || null,
      updated_at: updatedAt,
    });
  }

  upsertPeerChannelState(
    peerHash: string,
    state: ReticulumChatChannelDigest,
    updatedAt = Date.now()
  ): void {
    const key = peerHash.trim().toLowerCase();
    if (!key || !Number.isInteger(state.groupId) || state.groupId <= 0) return;
    const channelId = normalizeReticulumChatChannelId(state.channelId);
    this.stmtUpsertPeerChannelState.run({
      peer_hash: key,
      group_id: state.groupId,
      channel_id: channelId,
      latest_event_id: state.latestCursor?.eventId ?? null,
      latest_feed_timestamp: state.latestCursor?.feedTimestamp ?? null,
      oldest_event_id: state.oldestCursor?.eventId ?? null,
      oldest_feed_timestamp: state.oldestCursor?.feedTimestamp ?? null,
      visible_window_hash: state.visibleWindowHash || null,
      updated_at: updatedAt,
    });
  }

  upsertVerifiedWindow(
    groupId: number,
    channelId: string,
    start: ReticulumChatFeedCursor,
    end: ReticulumChatFeedCursor,
    windowHash: string,
    verifiedAt = Date.now()
  ): void {
    if (!Number.isInteger(groupId) || groupId <= 0) return;
    if (!windowHash) return;
    this.stmtUpsertVerifiedWindow.run({
      group_id: groupId,
      channel_id: normalizeReticulumChatChannelId(channelId),
      start_event_id: start.eventId,
      start_feed_timestamp: start.feedTimestamp,
      end_event_id: end.eventId,
      end_feed_timestamp: end.feedTimestamp,
      window_hash: windowHash,
      verified_at: verifiedAt,
    });
  }

  upsertMissingRange(
    groupId: number,
    authorAddress: string,
    fromSeq: number,
    toSeq: number,
    preferredPeer = '',
    nextAttemptAt = 0
  ): void {
    const author = typeof authorAddress === 'string' ? authorAddress.trim() : '';
    const peer = typeof preferredPeer === 'string' ? preferredPeer.trim().toLowerCase() : '';
    const from = Math.max(1, Math.floor(fromSeq));
    const to = Math.max(from, Math.floor(toSeq));
    if (!Number.isInteger(groupId) || groupId <= 0 || !author) return;
    this.stmtUpsertMissingRange.run({
      group_id: groupId,
      author_address: author,
      from_seq: from,
      to_seq: to,
      preferred_peer: peer || null,
      next_attempt_at: nextAttemptAt,
    });
    const key = this.missingRangeKey(groupId, author, from, to);
    const existing = this.memoryMissingRanges.get(key);
    this.memoryMissingRanges.set(key, {
      groupId,
      authorAddress: author,
      fromSeq: from,
      toSeq: to,
      preferredPeer: peer || existing?.preferredPeer || '',
      attempts: existing?.attempts ?? 0,
      nextAttemptAt: existing
        ? Math.min(existing.nextAttemptAt, Math.max(0, Math.floor(nextAttemptAt)))
        : Math.max(0, Math.floor(nextAttemptAt)),
    });
  }

  ensureMissingRange(
    groupId: number,
    authorAddress: string,
    fromSeq: number,
    toSeq: number,
    preferredPeer = ''
  ): void {
    const author = typeof authorAddress === 'string' ? authorAddress.trim() : '';
    const peer = typeof preferredPeer === 'string' ? preferredPeer.trim().toLowerCase() : '';
    const from = Math.max(1, Math.floor(fromSeq));
    const to = Math.max(from, Math.floor(toSeq));
    if (!Number.isInteger(groupId) || groupId <= 0 || !author) return;
    this.stmtEnsureMissingRange.run({
      group_id: groupId,
      author_address: author,
      from_seq: from,
      to_seq: to,
      preferred_peer: peer || null,
      next_attempt_at: 0,
    });
    const key = this.missingRangeKey(groupId, author, from, to);
    if (!this.memoryMissingRanges.has(key)) {
      this.memoryMissingRanges.set(key, {
        groupId,
        authorAddress: author,
        fromSeq: from,
        toSeq: to,
        preferredPeer: peer,
        attempts: 0,
        nextAttemptAt: 0,
      });
    }
  }

  getMissingRange(
    groupId: number,
    authorAddress: string,
    fromSeq: number,
    toSeq: number
  ): ReticulumChatMissingRangeState | null {
    const author = typeof authorAddress === 'string' ? authorAddress.trim() : '';
    const from = Math.max(1, Math.floor(fromSeq));
    const to = Math.max(from, Math.floor(toSeq));
    if (!Number.isInteger(groupId) || groupId <= 0 || !author) return null;
    const row = this.stmtGetMissingRangeExact.get(groupId, author, from, to) as
      | ReticulumChatMissingRangeRow
      | undefined;
    return row
      ? this.missingRangeRowToState(row)
      : this.memoryMissingRanges.get(this.missingRangeKey(groupId, author, from, to)) ?? null;
  }

  claimMissingRangeAttempt(
    groupId: number,
    authorAddress: string,
    fromSeq: number,
    toSeq: number,
    preferredPeer: string,
    now: number,
    nextAttemptAt: number
  ): ReticulumChatMissingRangeState | null {
    this.ensureMissingRange(groupId, authorAddress, fromSeq, toSeq, preferredPeer);
    const current = this.getMissingRange(groupId, authorAddress, fromSeq, toSeq);
    if (!current || current.nextAttemptAt > now) return null;
    const attempts = Math.max(0, Math.floor(current.attempts || 0)) + 1;
    this.stmtUpdateMissingRangeAttempt.run({
      group_id: current.groupId,
      author_address: current.authorAddress,
      from_seq: current.fromSeq,
      to_seq: current.toSeq,
      preferred_peer: preferredPeer.trim().toLowerCase() || null,
      attempts,
      next_attempt_at: Math.max(now, Math.floor(nextAttemptAt)),
    });
    const updated = {
      ...current,
      preferredPeer: preferredPeer.trim().toLowerCase() || current.preferredPeer,
      attempts,
      nextAttemptAt: Math.max(now, Math.floor(nextAttemptAt)),
    };
    this.memoryMissingRanges.set(
      this.missingRangeKey(current.groupId, current.authorAddress, current.fromSeq, current.toSeq),
      updated
    );
    return updated;
  }

  deferMissingRange(
    groupId: number,
    authorAddress: string,
    fromSeq: number,
    toSeq: number,
    preferredPeer: string,
    nextAttemptAt: number,
    attempts = 1
  ): ReticulumChatMissingRangeState | null {
    this.ensureMissingRange(groupId, authorAddress, fromSeq, toSeq, preferredPeer);
    const current = this.getMissingRange(groupId, authorAddress, fromSeq, toSeq);
    if (!current) return null;
    const nextAttempts = Math.max(
      Math.max(0, Math.floor(current.attempts || 0)),
      Math.max(1, Math.floor(attempts || 1))
    );
    this.stmtUpdateMissingRangeBackoff.run({
      group_id: current.groupId,
      author_address: current.authorAddress,
      from_seq: current.fromSeq,
      to_seq: current.toSeq,
      preferred_peer: preferredPeer.trim().toLowerCase() || null,
      attempts: nextAttempts,
      next_attempt_at: Math.max(Math.floor(nextAttemptAt), current.nextAttemptAt),
    });
    const updated = {
      ...current,
      preferredPeer: preferredPeer.trim().toLowerCase() || current.preferredPeer,
      attempts: nextAttempts,
      nextAttemptAt: Math.max(Math.floor(nextAttemptAt), current.nextAttemptAt),
    };
    this.memoryMissingRanges.set(
      this.missingRangeKey(current.groupId, current.authorAddress, current.fromSeq, current.toSeq),
      updated
    );
    return updated;
  }

  private missingRangeKey(
    groupId: number,
    authorAddress: string,
    fromSeq: number,
    toSeq: number
  ): string {
    return `${groupId}:${authorAddress}:${fromSeq}:${toSeq}`;
  }

  private missingRangeRowToState(row: ReticulumChatMissingRangeRow): ReticulumChatMissingRangeState {
    return {
      groupId: Number(row.group_id),
      authorAddress: String(row.author_address || ''),
      fromSeq: Math.max(1, Math.floor(Number(row.from_seq || 1))),
      toSeq: Math.max(1, Math.floor(Number(row.to_seq || row.from_seq || 1))),
      preferredPeer: typeof row.preferred_peer === 'string' ? row.preferred_peer : '',
      attempts: Math.max(0, Math.floor(Number(row.attempts || 0))),
      nextAttemptAt: Math.max(0, Math.floor(Number(row.next_attempt_at || 0))),
    };
  }

  private clearMissingRangesForEvent(event: ReticulumChatEvent): void {
    const rows = this.dedupeMissingRangeRows([
      ...(this.stmtGetMissingRangesForSeq.all(
      event.groupId,
      event.authorAddress,
      event.authorSeq,
      event.authorSeq
      ) as ReticulumChatMissingRangeRow[]),
      ...this.getMemoryMissingRangeRowsForSeq(
        event.groupId,
        event.authorAddress,
        event.authorSeq
      ),
    ]);
    if (rows.length === 0) return;
    this.rewriteMissingRanges(rows, (row) => new Set([event.authorSeq]));
  }

  private pruneSatisfiedMissingRanges(): void {
    const rows = this.dedupeMissingRangeRows([
      ...(this.stmtGetAllMissingRanges.all() as ReticulumChatMissingRangeRow[]),
      ...[...this.memoryMissingRanges.values()].map((range) =>
        this.missingRangeStateToRow(range)
      ),
    ]);
    if (rows.length === 0) return;
    this.rewriteMissingRanges(rows, (row) => {
      const presentRows = this.stmtGetPresentSeqsInRange.all(
        row.group_id,
        row.author_address,
        row.from_seq,
        row.to_seq
      ) as Array<{ author_seq?: number }>;
      return new Set(
        presentRows
          .map((present) => Number(present.author_seq))
          .filter((seq) => Number.isInteger(seq))
      );
    });
  }

  private rewriteMissingRanges(
    rows: ReticulumChatMissingRangeRow[],
    presentSeqsForRow: (row: ReticulumChatMissingRangeRow) => Set<number>
  ): void {
    const tx = this.db.transaction((rangeRows: ReticulumChatMissingRangeRow[]) => {
      for (const row of rangeRows) {
        const groupId = Number(row.group_id);
        const authorAddress = typeof row.author_address === 'string' ? row.author_address : '';
        const fromSeq = Math.max(1, Math.floor(Number(row.from_seq)));
        const toSeq = Math.max(fromSeq, Math.floor(Number(row.to_seq)));
        if (!Number.isInteger(groupId) || groupId <= 0 || !authorAddress) continue;
        const presentSeqs = presentSeqsForRow(row);
        if (presentSeqs.size === 0) continue;
        this.stmtDeleteMissingRange.run(groupId, authorAddress, fromSeq, toSeq);
        this.memoryMissingRanges.delete(this.missingRangeKey(groupId, authorAddress, fromSeq, toSeq));
        let segmentStart = fromSeq;
        const sortedPresentSeqs = [...presentSeqs]
          .filter((seq) => Number.isInteger(seq) && seq >= fromSeq && seq <= toSeq)
          .sort((a, b) => a - b);
        for (const seq of sortedPresentSeqs) {
          if (segmentStart <= seq - 1) {
            this.insertMissingRangeRaw(row, segmentStart, seq - 1);
          }
          segmentStart = seq + 1;
        }
        if (segmentStart <= toSeq) {
          this.insertMissingRangeRaw(row, segmentStart, toSeq);
        }
      }
    });
    tx(rows);
  }

  private insertMissingRangeRaw(
    row: ReticulumChatMissingRangeRow,
    fromSeq: number,
    toSeq: number
  ): void {
    if (fromSeq > toSeq) return;
    this.stmtInsertMissingRangeRaw.run({
      group_id: row.group_id,
      author_address: row.author_address,
      from_seq: fromSeq,
      to_seq: toSeq,
      preferred_peer: row.preferred_peer ?? null,
      attempts: Number.isInteger(row.attempts) ? row.attempts : 0,
      next_attempt_at: Number.isInteger(row.next_attempt_at) ? row.next_attempt_at : 0,
    });
    this.memoryMissingRanges.set(
      this.missingRangeKey(row.group_id, row.author_address, fromSeq, toSeq),
      {
        groupId: row.group_id,
        authorAddress: row.author_address,
        fromSeq,
        toSeq,
        preferredPeer: row.preferred_peer ?? '',
        attempts: Number.isInteger(row.attempts) ? row.attempts : 0,
        nextAttemptAt: Number.isInteger(row.next_attempt_at) ? row.next_attempt_at : 0,
      }
    );
  }

  private getMemoryMissingRangeRowsForSeq(
    groupId: number,
    authorAddress: string,
    seq: number
  ): ReticulumChatMissingRangeRow[] {
    return [...this.memoryMissingRanges.values()]
      .filter(
        (range) =>
          range.groupId === groupId &&
          range.authorAddress === authorAddress &&
          range.fromSeq <= seq &&
          range.toSeq >= seq
      )
      .map((range) => this.missingRangeStateToRow(range));
  }

  private missingRangeStateToRow(
    range: ReticulumChatMissingRangeState
  ): ReticulumChatMissingRangeRow {
    return {
      group_id: range.groupId,
      author_address: range.authorAddress,
      from_seq: range.fromSeq,
      to_seq: range.toSeq,
      preferred_peer: range.preferredPeer || null,
      attempts: range.attempts,
      next_attempt_at: range.nextAttemptAt,
    };
  }

  private dedupeMissingRangeRows(
    rows: ReticulumChatMissingRangeRow[]
  ): ReticulumChatMissingRangeRow[] {
    const byKey = new Map<string, ReticulumChatMissingRangeRow>();
    for (const row of rows) {
      const groupId = Number(row.group_id);
      const author = String(row.author_address || '');
      const from = Math.max(1, Math.floor(Number(row.from_seq || 1)));
      const to = Math.max(from, Math.floor(Number(row.to_seq || row.from_seq || 1)));
      byKey.set(this.missingRangeKey(groupId, author, from, to), row);
    }
    return [...byKey.values()];
  }

  getAuthorMaxSeq(groupId: number, authorAddress: string): number {
    const row = this.stmtGetAuthorMaxSeq.get(
      groupId,
      authorAddress,
      groupId,
      authorAddress
    ) as
      | { seq?: number }
      | undefined;
    let maxSeq = typeof row?.seq === 'number' && Number.isFinite(row.seq) ? row.seq : 0;
    const markerRow = this.db
      .prepare(
        `
          SELECT MAX(author_seq) AS seq
          FROM rchat_expired_event_markers
          WHERE group_id = ? AND author_address = ?
        `
      )
      .get(groupId, authorAddress) as { seq?: number } | undefined;
    if (typeof markerRow?.seq === 'number' && Number.isFinite(markerRow.seq)) {
      maxSeq = Math.max(maxSeq, markerRow.seq);
    }
    for (const event of this.memoryEvents.values()) {
      if (event.groupId !== groupId || event.authorAddress !== authorAddress) continue;
      maxSeq = Math.max(maxSeq, event.authorSeq);
    }
    return maxSeq;
  }

  getAuthorEventsAfter(
    groupId: number,
    authorAddress: string,
    afterSeq: number,
    limit: number
  ): ReticulumChatEvent[] {
    const maxLimit = Math.max(1, limit);
    return this.mergeWindowEvents(
      (this.stmtGetAuthorEventsAfter.all(
        groupId,
        authorAddress,
        Math.max(0, afterSeq),
        maxLimit
      ) as EventRow[]).map(rowToEvent),
      [...this.memoryEvents.values()]
        .filter(
          (event) =>
            event.groupId === groupId &&
            event.authorAddress === authorAddress &&
            event.authorSeq > afterSeq
        )
        .sort((a, b) => a.authorSeq - b.authorSeq || a.timestamp - b.timestamp)
        .slice(0, maxLimit),
      maxLimit
    ).sort((a, b) => a.authorSeq - b.authorSeq || a.timestamp - b.timestamp);
  }

  getAuthorHeads(groupId: number, limit: number, offset = 0): ReticulumChatAuthorHead[] {
    const maxLimit = Math.max(1, limit);
    const safeOffset = Math.max(0, Math.floor(offset));
    const heads = new Map<string, ReticulumChatAuthorHead>();
    const rows = this.stmtGetAuthorHeads.all(
      groupId,
      groupId,
      maxLimit + safeOffset,
      0
    ) as Array<{
      author_address: string;
      max_seq: number;
      event_id: string;
      timestamp: number;
    }>;
    for (const row of rows) {
      heads.set(row.author_address, {
        authorAddress: row.author_address,
        maxSeq: row.max_seq,
        eventId: row.event_id,
        timestamp: row.timestamp,
      });
    }
    for (const event of this.memoryEvents.values()) {
      if (event.groupId !== groupId) continue;
      const existing = heads.get(event.authorAddress);
      if (existing && existing.maxSeq >= event.authorSeq) continue;
      heads.set(event.authorAddress, {
        authorAddress: event.authorAddress,
        maxSeq: event.authorSeq,
        eventId: event.eventId,
        timestamp: event.timestamp,
      });
    }
    return [...heads.values()]
      .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
      .slice(safeOffset)
      .slice(0, maxLimit);
  }

  getAuthorSequenceGaps(
    groupId: number,
    limit: number
  ): ReticulumChatAuthorSequenceGap[] {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    const maxLimit = Math.max(1, Math.floor(limit));
    const gaps = new Map<string, ReticulumChatAuthorSequenceGap>();

    for (const row of this.stmtGetAuthorSequenceGaps.all(groupId, groupId, maxLimit) as Array<{
      author_address?: string;
      from_seq?: number;
      to_seq?: number;
    }>) {
      const authorAddress = typeof row.author_address === 'string' ? row.author_address : '';
      const fromSeq = Number(row.from_seq);
      const toSeq = Number(row.to_seq);
      if (
        !authorAddress ||
        !Number.isInteger(fromSeq) ||
        !Number.isInteger(toSeq) ||
        toSeq < fromSeq
      ) {
        continue;
      }
      gaps.set(`${authorAddress}:${fromSeq}:${toSeq}`, { authorAddress, fromSeq, toSeq });
    }

    const memorySeqsByAuthor = new Map<string, number[]>();
    for (const event of this.memoryEvents.values()) {
      if (event.groupId !== groupId) continue;
      const seqs = memorySeqsByAuthor.get(event.authorAddress) ?? [];
      seqs.push(event.authorSeq);
      memorySeqsByAuthor.set(event.authorAddress, seqs);
    }
    for (const [authorAddress, seqs] of memorySeqsByAuthor) {
      seqs.sort((a, b) => a - b);
      for (let index = 1; index < seqs.length; index += 1) {
        const previousSeq = seqs[index - 1];
        const currentSeq = seqs[index];
        if (currentSeq <= previousSeq + 1) continue;
        const fromSeq = previousSeq + 1;
        const toSeq = currentSeq - 1;
        gaps.set(`${authorAddress}:${fromSeq}:${toSeq}`, { authorAddress, fromSeq, toSeq });
        if (gaps.size >= maxLimit) break;
      }
      if (gaps.size >= maxLimit) break;
    }

    return [...gaps.values()]
      .sort((a, b) => b.toSeq - a.toSeq || a.authorAddress.localeCompare(b.authorAddress) || b.fromSeq - a.fromSeq)
      .slice(0, maxLimit);
  }

  private mergeWindowEvents(
    primary: ReticulumChatEvent[],
    secondary: ReticulumChatEvent[],
    limit: number
  ): ReticulumChatEvent[] {
    const seen = new Set<string>();
    return [...primary, ...secondary]
      .filter((event) => {
        if (seen.has(event.eventId)) return false;
        seen.add(event.eventId);
        return true;
      })
      .sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId))
      .slice(0, limit);
  }

  private compareFeedCursors(
    a: ReticulumChatFeedCursor,
    b: ReticulumChatFeedCursor
  ): number {
    return a.feedTimestamp - b.feedTimestamp || a.eventId.localeCompare(b.eventId);
  }

  private normalizeFeedTimestamp(timestamp: number, acceptedAt = Date.now()): number {
    return Number.isFinite(timestamp) && timestamp >= 0 ? Math.floor(timestamp) : Math.floor(acceptedAt);
  }

  getSyncState(groupId: number): Record<string, number> {
    const rows = this.stmtGetGroupSeqs.all(groupId, groupId) as Array<{
      author_address: string;
      seq: number;
    }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.author_address] = row.seq;
    const markerRows = this.db
      .prepare(
        `
          SELECT author_address, MAX(author_seq) AS seq
          FROM rchat_expired_event_markers
          WHERE group_id = ?
          GROUP BY author_address
        `
      )
      .all(groupId) as Array<{ author_address?: string; seq?: number }>;
    for (const row of markerRows) {
      if (typeof row.author_address !== 'string') continue;
      const seq = Number(row.seq);
      if (!Number.isFinite(seq)) continue;
      out[row.author_address] = Math.max(out[row.author_address] ?? 0, seq);
    }
    for (const event of this.memoryEvents.values()) {
      if (event.groupId !== groupId) continue;
      out[event.authorAddress] = Math.max(
        out[event.authorAddress] ?? 0,
        event.authorSeq
      );
    }
    return out;
  }

  getChannels(groupId: number, includeArchived = false): ReticulumGroupChannel[] {
    const rows = this.stmtGetChannels.all(groupId) as Array<{
      group_id: number;
      channel_id: string;
      category_id: string | null;
      name: string;
      description: string | null;
      position: number;
      archived: number;
      write_mode?: string | null;
      read_mode?: string | null;
      write_mode_updated_at?: number | null;
      expiry_duration_ms?: number | null;
      created_by: string;
      created_at: number;
      updated_at: number;
    }>;
    const channels = rows.map((row) => ({
      groupId: row.group_id,
      channelId: normalizeReticulumChatChannelId(row.channel_id),
      ...(normalizeReticulumChatCategoryId(row.category_id) ? { categoryId: normalizeReticulumChatCategoryId(row.category_id) } : {}),
      name: normalizeReticulumChatChannelId(row.name),
      ...(row.description ? { description: row.description } : {}),
      position: row.position,
      archived: row.archived === 1,
      writeMode: normalizeReticulumChannelWriteMode(row.write_mode),
      readMode: normalizeReticulumChannelReadMode(row.read_mode),
      writeModeUpdatedAt: Number.isFinite(row.write_mode_updated_at ?? NaN)
        ? Number(row.write_mode_updated_at)
        : 0,
      ...(normalizeReticulumChatExpiryDurationMs(row.expiry_duration_ms)
        ? { expiryDurationMs: normalizeReticulumChatExpiryDurationMs(row.expiry_duration_ms) }
        : {}),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    for (const channel of this.memoryChannels.values()) {
      if (channel.groupId !== groupId) continue;
      const existingIndex = channels.findIndex(
        (item) => item.channelId === channel.channelId
      );
      if (existingIndex >= 0) {
        channels[existingIndex] = channel;
      } else {
        channels.push(channel);
      }
    }
    if (!channels.some((channel) => channel.channelId === RETICULUM_CHAT_DEFAULT_CHANNEL_ID)) {
      channels.unshift(this.defaultChannel(groupId));
    }
    if (!channels.some((channel) => channel.channelId === RETICULUM_CHAT_QORTAL_LAND_CHANNEL_ID)) {
      channels.push(this.defaultQortalLandChannel(groupId));
    }
    return channels
      .filter((channel) => includeArchived || !channel.archived)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  getChannel(groupId: number, channelId: string): ReticulumGroupChannel | null {
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    if (normalizedChannelId === RETICULUM_CHAT_DEFAULT_CHANNEL_ID) {
      const row = this.stmtGetChannel.get(groupId, normalizedChannelId) as any;
      if (!row) return this.defaultChannel(groupId);
    }
    if (normalizedChannelId === RETICULUM_CHAT_QORTAL_LAND_CHANNEL_ID) {
      const row = this.stmtGetChannel.get(groupId, normalizedChannelId) as any;
      if (!row) return this.defaultQortalLandChannel(groupId);
    }
    return this.getChannels(groupId, true).find(
      (channel) => channel.channelId === normalizedChannelId
    ) ?? null;
  }

  upsertChannel(channel: ReticulumGroupChannelInput): boolean {
    const expiryDurationMs = normalizeReticulumChatExpiryDurationMs(channel.expiryDurationMs);
    const normalizedChannel: ReticulumGroupChannel = {
      ...channel,
      channelId: normalizeReticulumChatChannelId(channel.channelId),
      categoryId: normalizeReticulumChatCategoryId(channel.categoryId) || undefined,
      name: normalizeReticulumChatChannelId(channel.name),
      position: Math.max(0, Math.floor(channel.position)),
      archived: channel.archived === true,
      writeMode: normalizeReticulumChannelWriteMode(channel.writeMode),
      readMode: normalizeReticulumChannelReadMode(channel.readMode),
      writeModeUpdatedAt: Number.isFinite(Number(channel.writeModeUpdatedAt))
        ? Math.max(0, Math.floor(Number(channel.writeModeUpdatedAt)))
        : Math.max(0, Math.floor(Number(channel.updatedAt))),
      ...(expiryDurationMs ? { expiryDurationMs } : {}),
      description: channel.description?.trim() || undefined,
    };
    this.memoryChannels.set(
      `${normalizedChannel.groupId}:${normalizedChannel.channelId}`,
      normalizedChannel
    );
    const result = this.stmtUpsertChannel.run(
      normalizedChannel.groupId,
      normalizedChannel.channelId,
      normalizedChannel.categoryId ?? null,
      normalizedChannel.name,
      normalizedChannel.description ?? null,
      normalizedChannel.position,
      normalizedChannel.archived ? 1 : 0,
      normalizedChannel.writeMode,
      normalizedChannel.readMode,
      normalizedChannel.writeModeUpdatedAt,
      normalizedChannel.expiryDurationMs ?? null,
      normalizedChannel.createdBy,
      normalizedChannel.createdAt,
      normalizedChannel.updatedAt
    );
    return result.changes > 0;
  }

  private defaultChannel(groupId: number): ReticulumGroupChannel {
    return {
      groupId,
      channelId: RETICULUM_CHAT_DEFAULT_CHANNEL_ID,
      name: RETICULUM_CHAT_DEFAULT_CHANNEL_ID,
      position: 0,
      archived: false,
      writeMode: RETICULUM_CHAT_CHANNEL_WRITE_MODE_MEMBERS,
      readMode: RETICULUM_CHAT_CHANNEL_READ_MODE_MEMBERS,
      writeModeUpdatedAt: 0,
      createdBy: '',
      createdAt: 0,
      updatedAt: 0,
    };
  }

  private defaultQortalLandChannel(groupId: number): ReticulumGroupChannel {
    return {
      groupId,
      channelId: RETICULUM_CHAT_QORTAL_LAND_CHANNEL_ID,
      name: RETICULUM_CHAT_QORTAL_LAND_CHANNEL_ID,
      position: 1,
      archived: false,
      writeMode: RETICULUM_CHAT_CHANNEL_WRITE_MODE_MEMBERS,
      readMode: RETICULUM_CHAT_CHANNEL_READ_MODE_MEMBERS,
      writeModeUpdatedAt: 0,
      expiryDurationMs: RETICULUM_CHAT_QORTAL_LAND_CHANNEL_EXPIRY_MS,
      createdBy: '',
      createdAt: 0,
      updatedAt: 0,
    };
  }

  getCategories(groupId: number): ReticulumGroupCategory[] {
    const rows = this.stmtGetCategories.all(groupId) as Array<{
      group_id: number;
      category_id: string;
      name: string;
      position: number;
      created_by: string;
      created_at: number;
      updated_at: number;
    }>;
    const categories = rows
      .map((row) => ({
        groupId: row.group_id,
        categoryId: normalizeReticulumChatCategoryId(row.category_id),
        name: normalizeReticulumChatChannelId(row.name),
        position: Math.max(0, Math.floor(row.position)),
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
      .filter((category) => !!category.categoryId);
    for (const category of this.memoryCategories.values()) {
      if (category.groupId !== groupId) continue;
      const existingIndex = categories.findIndex(
        (item) => item.categoryId === category.categoryId
      );
      if (existingIndex >= 0) {
        categories[existingIndex] = category;
      } else {
        categories.push(category);
      }
    }
    return categories.sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name)
    );
  }

  getCategory(groupId: number, categoryId: string): ReticulumGroupCategory | null {
    const normalizedCategoryId = normalizeReticulumChatCategoryId(categoryId);
    if (!normalizedCategoryId) return null;
    const row = this.stmtGetCategory.get(groupId, normalizedCategoryId) as
      | {
          group_id: number;
          category_id: string;
          name: string;
          position: number;
          created_by: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    const memory = this.memoryCategories.get(`${groupId}:${normalizedCategoryId}`);
    if (memory) return memory;
    if (!row) return null;
    return {
      groupId: row.group_id,
      categoryId: normalizeReticulumChatCategoryId(row.category_id),
      name: normalizeReticulumChatChannelId(row.name),
      position: Math.max(0, Math.floor(row.position)),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertCategory(category: ReticulumGroupCategory): boolean {
    const normalizedCategory: ReticulumGroupCategory = {
      ...category,
      categoryId: normalizeReticulumChatCategoryId(category.categoryId),
      name: normalizeReticulumChatChannelId(category.name),
      position: Math.max(0, Math.floor(category.position)),
    };
    if (!normalizedCategory.categoryId) return false;
    this.memoryCategories.set(
      `${normalizedCategory.groupId}:${normalizedCategory.categoryId}`,
      normalizedCategory
    );
    const result = this.stmtUpsertCategory.run(
      normalizedCategory.groupId,
      normalizedCategory.categoryId,
      normalizedCategory.name,
      normalizedCategory.position,
      normalizedCategory.createdBy,
      normalizedCategory.createdAt,
      normalizedCategory.updatedAt
    );
    return result.changes > 0;
  }

  upsertMetadataSnapshot(snapshot: ReticulumChatMetadataSnapshotRecord): boolean {
    if (!Number.isInteger(snapshot.groupId) || snapshot.groupId <= 0) return false;
    if (!snapshot.snapshotId || !snapshot.snapshotHash) return false;
    const result = this.stmtUpsertMetadataSnapshot.run({
      group_id: snapshot.groupId,
      snapshot_id: snapshot.snapshotId,
      version: Math.max(1, Math.floor(snapshot.version)),
      created_at: Math.max(0, Math.floor(snapshot.createdAt)),
      latest_event_id: snapshot.latestEventId || '',
      latest_feed_timestamp: Math.max(0, Math.floor(snapshot.latestFeedTimestamp || 0)),
      snapshot_hash: snapshot.snapshotHash,
      admin_address: snapshot.adminAddress,
      admin_public_key: snapshot.adminPublicKey,
      signature: snapshot.signature,
      channels_json: JSON.stringify(snapshot.channels),
      categories_json: JSON.stringify(snapshot.categories),
    });
    return result.changes > 0;
  }

  applyMetadataSnapshot(snapshot: ReticulumChatMetadataSnapshotRecord): boolean {
    if (
      !this.upsertMetadataSnapshot(snapshot) &&
      !this.getMetadataSnapshotByHash(snapshot.groupId, snapshot.snapshotHash)
    ) {
      return false;
    }
    return this.applyMetadataSnapshotProjection(snapshot);
  }

  applyStoredMetadataSnapshotProjection(snapshot: ReticulumChatMetadataSnapshotRecord): boolean {
    return this.applyMetadataSnapshotProjection(snapshot);
  }

  private applyMetadataSnapshotProjection(snapshot: ReticulumChatMetadataSnapshotRecord): boolean {
    const keepChannels = new Set(
      snapshot.channels.map((channel) => normalizeReticulumChatChannelId(channel.channelId))
    );
    const keepCategories = new Set(
      snapshot.categories
        .map((category) => normalizeReticulumChatCategoryId(category.categoryId))
        .filter(Boolean)
    );
    for (const category of snapshot.categories) {
      this.upsertCategory(category);
    }
    for (const channel of snapshot.channels) {
      this.upsertChannel(channel);
    }
    for (const existing of this.getChannels(snapshot.groupId, true)) {
      if (
        existing.channelId === RETICULUM_CHAT_DEFAULT_CHANNEL_ID ||
        existing.channelId === RETICULUM_CHAT_QORTAL_LAND_CHANNEL_ID
      ) {
        continue;
      }
      if (keepChannels.has(existing.channelId)) continue;
      this.memoryChannels.delete(`${snapshot.groupId}:${existing.channelId}`);
      this.stmtDeleteChannel.run(snapshot.groupId, existing.channelId);
    }
    for (const existing of this.getCategories(snapshot.groupId)) {
      if (keepCategories.has(existing.categoryId)) continue;
      this.deleteCategory(snapshot.groupId, existing.categoryId);
    }
    return true;
  }

  getLatestMetadataSnapshot(groupId: number): ReticulumChatMetadataSnapshotRecord | null {
    const row = this.stmtGetLatestMetadataSnapshot.get(groupId) as MetadataSnapshotRow | undefined;
    return row ? metadataSnapshotRowToRecord(row) : null;
  }

  getMetadataSnapshotByHash(
    groupId: number,
    snapshotHash: string
  ): ReticulumChatMetadataSnapshotRecord | null {
    const normalizedHash = String(snapshotHash || '').trim().toLowerCase();
    if (!normalizedHash) return null;
    const row = this.stmtGetMetadataSnapshotByHash.get(groupId, normalizedHash) as
      | MetadataSnapshotRow
      | undefined;
    return row ? metadataSnapshotRowToRecord(row) : null;
  }

  deleteCategory(groupId: number, categoryId: string): boolean {
    const normalizedCategoryId = normalizeReticulumChatCategoryId(categoryId);
    if (!normalizedCategoryId) return false;
    this.memoryCategories.delete(`${groupId}:${normalizedCategoryId}`);
    for (const [key, channel] of this.memoryChannels.entries()) {
      if (channel.groupId === groupId && channel.categoryId === normalizedCategoryId) {
        this.memoryChannels.set(key, { ...channel, categoryId: undefined });
      }
    }
    this.stmtClearChannelCategory.run(groupId, normalizedCategoryId);
    const result = this.stmtDeleteCategory.run(groupId, normalizedCategoryId);
    return result.changes > 0;
  }

  getChatSummaries(myAddress = '', onlineSince = 0): ReticulumGroupChatSummary[] {
    const groupIds = new Set(this.getKnownGroupIds());

    const summaries: ReticulumGroupChatSummary[] = [];
    for (const groupId of groupIds) {
      const channelIds = this.getSummaryChannelIds(groupId);
      const channelSummaries = channelIds
        .map((channelId) => this.getChannelSummary(groupId, channelId, myAddress, onlineSince))
        .filter((summary): summary is ReticulumChatSummary => !!summary);
      const chatNotificationSummaries = channelSummaries.filter(
        (summary) => summary.channelId !== RETICULUM_CHAT_QORTAL_LAND_CHANNEL_ID
      );
      if (chatNotificationSummaries.length === 0) continue;
      const lastChannel = chatNotificationSummaries.reduce((latest, current) =>
        current.updatedAt > latest.updatedAt ? current : latest
      );
      const unreadCount = chatNotificationSummaries.reduce(
        (total, summary) => total + summary.unreadCount,
        0
      );
      const mentionCount = chatNotificationSummaries.reduce(
        (total, summary) => total + summary.mentionCount,
        0
      );

      summaries.push({
        groupId,
        lastEvent: lastChannel.lastEvent,
        unreadCount,
        mentionCount,
        hasUnreadMention: mentionCount > 0,
        updatedAt: lastChannel.updatedAt,
        channels: channelSummaries.sort((a, b) => b.updatedAt - a.updatedAt),
      });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getKnownGroupIds(): number[] {
    const groupIds = new Set<number>();
    const rows = this.stmtGetKnownGroups.all() as Array<{ group_id: number }>;
    for (const row of rows) {
      const groupId = Number(row.group_id);
      if (Number.isInteger(groupId) && groupId > 0) groupIds.add(groupId);
    }
    for (const event of this.memoryEvents.values()) {
      if (Number.isInteger(event.groupId) && event.groupId > 0) {
        groupIds.add(event.groupId);
      }
    }
    return [...groupIds].sort((a, b) => a - b);
  }

  private getSummaryChannelIds(groupId: number): string[] {
    const channels = new Set<string>([RETICULUM_CHAT_DEFAULT_CHANNEL_ID]);
    const archivedChannels = new Set(
      this.getChannels(groupId, true)
        .filter((channel) => channel.archived)
        .map((channel) => channel.channelId)
    );
    for (const row of this.stmtGetKnownChannels.all(groupId) as Array<{ channel_id?: string }>) {
      const channelId = normalizeReticulumChatChannelId(row.channel_id);
      if (!archivedChannels.has(channelId)) channels.add(channelId);
    }
    for (const channel of this.getChannels(groupId, false)) {
      channels.add(channel.channelId);
    }
    for (const event of this.memoryEvents.values()) {
      if (event.groupId !== groupId) continue;
      const channelId = normalizeReticulumChatChannelId(event.channelId);
      if (!archivedChannels.has(channelId)) channels.add(channelId);
    }
    return [...channels];
  }

  private getChannelSummary(
    groupId: number,
    channelId: string,
    myAddress = '',
    onlineSince = 0
  ): ReticulumChatSummary | null {
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const now = Date.now();
    const events = this.getRecentMessageEvents(groupId, 500, normalizedChannelId);
    const recentEvents = this.getRecentEvents(groupId, 500, normalizedChannelId);
    const memoryLast = events[events.length - 1] ?? null;
    const row = this.stmtGetLastProjectedMessage.get(groupId, normalizedChannelId, now) as
      | MessageProjectionRow
      | undefined;
    const sqliteLast = row ? messageProjectionRowToEvent(row) : null;
    const lastEvent =
      memoryLast && (!sqliteLast || memoryLast.timestamp >= sqliteLast.timestamp)
        ? memoryLast
        : sqliteLast;
    if (!lastEvent) return null;
    const suppressUnreadState =
      normalizedChannelId === RETICULUM_CHAT_QORTAL_LAND_CHANNEL_ID;

    const watermark = this.getReadWatermark(groupId, normalizedChannelId, myAddress);
    const unreadCount = myAddress && !suppressUnreadState
      ? events.filter(
          (event) =>
            event.timestamp > watermark && event.authorAddress !== myAddress
        ).length
      : 0;
    const mentionRow = myAddress && !suppressUnreadState
      ? (this.stmtCountUnreadMentions.get(
          groupId,
          normalizedChannelId,
          myAddress,
          myAddress,
          watermark
        ) as { cnt?: number } | undefined)
      : undefined;
    const mentionCount =
      typeof mentionRow?.cnt === 'number' && Number.isFinite(mentionRow.cnt)
        ? mentionRow.cnt
        : 0;
    let memoryMentionCount = 0;
    const myMentionHash = myAddress
      ? hashReticulumChatMentionAddress(myAddress)
      : '';
    let eventMentionHashCount = 0;
    let eventMentionTargetCount = 0;
    const effectiveMentionEvents = new Map<string, ReticulumChatEvent>();
    for (const event of recentEvents) {
      if (
        event.eventType === 'message' ||
        event.eventType === 'attachment_manifest'
      ) {
        effectiveMentionEvents.set(event.eventId, event);
        continue;
      }
      if (event.eventType === 'edit' && event.targetEventId) {
        effectiveMentionEvents.set(event.targetEventId, event);
        continue;
      }
      if (event.eventType === 'delete' && event.targetEventId) {
        effectiveMentionEvents.delete(event.targetEventId);
      }
    }
    const countEventMentionHash = (event: ReticulumChatEvent) => {
      if (
        !myMentionHash ||
        event.authorAddress === myAddress ||
        event.timestamp <= watermark ||
        (event.eventType !== 'message' &&
          event.eventType !== 'attachment_manifest' &&
          event.eventType !== 'edit') ||
        !event.mentionAddressHashes?.includes(myMentionHash)
      ) {
        return;
      }
      eventMentionHashCount += 1;
    };
    const countEventMentionTarget = (event: ReticulumChatEvent) => {
      if (
        event.timestamp <= watermark ||
        (event.eventType !== 'message' &&
          event.eventType !== 'attachment_manifest' &&
          event.eventType !== 'edit') ||
        !mentionTargetAppliesTo(
          event,
          myAddress,
          normalizedChannelId,
          onlineSince,
          myMentionHash
        )
      ) {
        return;
      }
      eventMentionHashCount += 1;
    };
    if (!suppressUnreadState) {
      for (const event of effectiveMentionEvents.values()) {
        if (event.mentionAddressHashes?.includes(myMentionHash)) {
          countEventMentionHash(event);
        } else {
          countEventMentionTarget(event);
        }
      }
    }
    if (myAddress && !suppressUnreadState) {
      const mentionTargetRows = this.stmtGetUnreadMentionTargetEvents.all(
        groupId,
        normalizedChannelId,
        watermark,
        myAddress
      ) as EventRow[];
      const effectiveTargetEvents = new Map<string, ReticulumChatEvent>();
      const collectTargetCandidate = (event: ReticulumChatEvent) => {
        if (
          event.eventType === 'message' ||
          event.eventType === 'attachment_manifest'
        ) {
          effectiveTargetEvents.set(event.eventId, event);
          return;
        }
        if (event.eventType === 'edit' && event.targetEventId) {
          effectiveTargetEvents.set(event.targetEventId, event);
          return;
        }
        if (event.eventType === 'delete' && event.targetEventId) {
          effectiveTargetEvents.delete(event.targetEventId);
        }
      };
      for (const row of mentionTargetRows) {
        collectTargetCandidate(rowToEvent(row));
      }
      for (const event of this.memoryEvents.values()) {
        if (
          event.groupId !== groupId ||
          normalizeReticulumChatChannelId(event.channelId) !== normalizedChannelId ||
          event.timestamp <= watermark ||
          event.authorAddress === myAddress ||
          (sanitizeMentionTargets(event.mentionTargets).length === 0 &&
            event.eventType !== 'edit' &&
            event.eventType !== 'delete')
        ) {
          continue;
        }
        collectTargetCandidate(event);
      }
      for (const event of effectiveTargetEvents.values()) {
        if (
          mentionTargetAppliesTo(
            event,
            myAddress,
            normalizedChannelId,
            onlineSince,
            myMentionHash
          )
        ) {
          eventMentionTargetCount += 1;
        }
      }
    }
    if (myAddress && !suppressUnreadState) {
      for (const mentions of this.memoryMentions.values()) {
        for (const mention of mentions) {
          if (
            mention.groupId === groupId &&
            mention.channelId === normalizedChannelId &&
            mention.mentionedAddress === myAddress &&
            mention.authorAddress !== myAddress &&
            mention.timestamp > watermark &&
            mention.readAt === 0
          ) {
            memoryMentionCount += 1;
          }
        }
      }
    }
    const totalMentionCount = Math.max(
      mentionCount,
      memoryMentionCount,
      eventMentionHashCount,
      eventMentionTargetCount
    );
    return {
      groupId,
      channelId: normalizedChannelId,
      lastEvent,
      unreadCount,
      mentionCount: totalMentionCount,
      hasUnreadMention: totalMentionCount > 0,
      updatedAt: lastEvent.timestamp,
    };
  }

  markRead(
    groupId: number,
    channelIdOrTimestamp: string | number,
    upToTimestampOrAddress?: string | number,
    myAddress = ''
  ): void {
    const channelId =
      typeof channelIdOrTimestamp === 'string'
        ? channelIdOrTimestamp
        : RETICULUM_CHAT_DEFAULT_CHANNEL_ID;
    const timestamp = Number(
      typeof channelIdOrTimestamp === 'number'
        ? channelIdOrTimestamp
        : upToTimestampOrAddress
    );
    const effectiveAddress =
      typeof channelIdOrTimestamp === 'number'
        ? typeof upToTimestampOrAddress === 'string'
          ? upToTimestampOrAddress
          : myAddress
        : myAddress;
    if (!Number.isFinite(timestamp) || timestamp <= 0) return;
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const address = typeof effectiveAddress === 'string' ? effectiveAddress.trim() : '';
    const current = this.getReadWatermark(groupId, normalizedChannelId, address);
    if (timestamp > current) {
      this.memoryReadWatermarks.set(
        this.readWatermarkKey(groupId, normalizedChannelId, address),
        timestamp
      );
      this.stmtUpsertWatermark.run(groupId, normalizedChannelId, address, timestamp);
    }
    if (address) {
      this.stmtMarkMentionsRead.run(Date.now(), groupId, normalizedChannelId, address, timestamp);
      const readAt = Date.now();
      for (const mentions of this.memoryMentions.values()) {
        for (const mention of mentions) {
          if (
            mention.groupId === groupId &&
            mention.channelId === normalizedChannelId &&
            mention.mentionedAddress === address &&
            mention.timestamp <= timestamp &&
            mention.readAt === 0
          ) {
            mention.readAt = readAt;
          }
        }
      }
    }
  }

  getReadWatermark(groupId: number, channelId: string, address = ''): number {
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const normalizedAddress = typeof address === 'string' ? address.trim() : '';
    const memoryWatermark =
      this.memoryReadWatermarks.get(
        this.readWatermarkKey(groupId, normalizedChannelId, normalizedAddress)
      ) ?? 0;
    const row = this.stmtGetWatermark.get(groupId, normalizedChannelId, normalizedAddress) as
      | { timestamp?: number }
      | undefined;
    const sqliteWatermark =
      typeof row?.timestamp === 'number' && Number.isFinite(row.timestamp)
        ? row.timestamp
        : 0;
    const exactWatermark = Math.max(memoryWatermark, sqliteWatermark);
    if (exactWatermark > 0) {
      return exactWatermark;
    }
    if (!normalizedAddress) return 0;
    return 0;
  }

  private readWatermarkKey(groupId: number, channelId: string, address: string): string {
    return `${groupId}:${normalizeReticulumChatChannelId(channelId)}:${address}`;
  }

  getMissingEvents(
    groupId: number,
    knownAuthorSeqs: Record<string, number>,
    limit: number
  ): ReticulumChatEvent[] {
    const maxLimit = Math.max(1, limit);
    const recent = this.getRecentEvents(groupId, maxLimit);
    const out: ReticulumChatEvent[] = [];
    const seen = new Set<string>();

    for (const event of recent) {
      const knownSeq = Number(knownAuthorSeqs[event.authorAddress] ?? 0);
      if (event.authorSeq <= (Number.isFinite(knownSeq) ? knownSeq : 0)) continue;
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      out.push(event);
      if (out.length >= maxLimit) break;
    }

    for (const event of this.memoryEvents.values()) {
      if (event.groupId !== groupId) continue;
      const knownSeq = Number(knownAuthorSeqs[event.authorAddress] ?? 0);
      if (event.authorSeq <= (Number.isFinite(knownSeq) ? knownSeq : 0)) continue;
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      out.push(event);
      if (out.length >= maxLimit) break;
    }

    return out.sort((a, b) => a.timestamp - b.timestamp || a.authorSeq - b.authorSeq);
  }

  markServed(eventIds: string[]): void {
    const now = Date.now();
    for (const id of eventIds) {
      const meta = this.memoryMeta.get(id);
      if (meta) meta.lastServedAt = now;
    }
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) this.stmtMarkServed.run(now, id);
    });
    tx(eventIds);
  }

  getRelayCacheBytes(): number {
    const row = this.stmtTotalCacheBytes.get() as { total?: number } | undefined;
    const sqliteTotal = typeof row?.total === 'number' ? row.total : 0;
    let memoryTotal = 0;
    for (const meta of this.memoryMeta.values()) {
      if (!meta.ownEvent) memoryTotal += meta.wireBytes;
    }
    return Math.max(sqliteTotal, memoryTotal);
  }

  private enforceRelayCacheLimit(maxBytes = RETICULUM_CHAT_CACHE_MAX_BYTES): void {
    while (this.getRelayCacheBytes() > maxBytes) {
      const memoryCandidate = [...this.memoryMeta.entries()]
        .filter(([, meta]) => !meta.ownEvent)
        .sort(
          (a, b) =>
            a[1].lastServedAt - b[1].lastServedAt ||
            a[1].storedAt - b[1].storedAt
        )[0];
      if (memoryCandidate) {
        this.deleteCachedEvent(memoryCandidate[0]);
        continue;
      }
      const row = this.stmtEvictCandidate.get() as
        | { event_id?: string }
        | undefined;
      if (!row?.event_id) break;
      this.deleteCachedEvent(row.event_id);
    }
  }

  private enforceOfflineRelayCacheLimit(
    now = Date.now(),
    maxBytes = RETICULUM_CHAT_RELAY_CACHE_MAX_BYTES
  ): void {
    this.stmtDeleteRelayExpired.run(now);
    for (const [eventId, entry] of this.memoryRelayCache) {
      if (entry.expiresAt <= now) this.memoryRelayCache.delete(eventId);
    }
    while (this.getOfflineRelayCacheBytes(now) > maxBytes) {
      const memoryCandidate = [...this.memoryRelayCache.values()].sort(
        (a, b) => a.expiresAt - b.expiresAt || a.createdAt - b.createdAt
      )[0];
      if (memoryCandidate) {
        this.memoryRelayCache.delete(memoryCandidate.eventId);
        this.stmtDeleteRelayBlob.run(memoryCandidate.blobId);
        continue;
      }
      const row = this.stmtRelayEvictCandidate.get() as
        | { blob_id?: string }
        | undefined;
      if (!row?.blob_id) break;
      this.stmtDeleteRelayBlob.run(row.blob_id);
    }
  }

  private searchEventsMirror(
    terms: string[],
    allowedGroups: Set<number> | null,
    allowedChannels: Set<string> | null,
    allowedAuthors: Set<string> | null,
    allowedEventTypes: Set<string> | null,
    includeAdminPrivate: boolean,
    beforeTimestamp: number | null,
    afterTimestamp: number | null,
    hasAttachment: boolean,
    hasLink: boolean,
    sort: 'relevance' | 'newest' | 'oldest',
    now: number,
    limit: number,
    offset: number,
    cursor: ReticulumChatSearchCursor | null,
    cursorSort: 'newest' | 'oldest' | null
  ): ReticulumChatSearchResult[] {
    const firstTerm = terms[0];
    const rows = firstTerm
      ? (this.stmtSearchMirror.all(
          `%${firstTerm}%`,
          cursor ? 500 : Math.max((offset + limit) * 20, 500)
        ) as Array<{
          event_id: string;
          search_text: string;
        }>)
      : [];
    const results: ReticulumChatSearchResult[] = [];
    for (const row of rows) {
      const lower = row.search_text.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      if (hasLink && !lower.includes('http') && !lower.includes('www.')) {
        continue;
      }
      const event = this.getEvent(row.event_id);
      if (!event) continue;
      const rootEventId = this.rootEventIdForIndexEvent(event);
      const projection = this.computeMessageProjectionForRoot(rootEventId);
      if (!projection || projection.deleted_at !== null) continue;
      if (
        projection.expires_at !== null &&
        projection.expires_at !== undefined &&
        projection.expires_at <= now
      ) {
        continue;
      }
      if (allowedGroups && !allowedGroups.has(projection.group_id)) continue;
      if (
        allowedChannels &&
        !allowedChannels.has(
          normalizeReticulumChatChannelId(projection.channel_id)
        )
      ) {
        continue;
      }
      if (allowedAuthors && !allowedAuthors.has(projection.author_address)) {
        continue;
      }
      if (
        allowedEventTypes &&
        !allowedEventTypes.has(projection.root_event_type)
      ) {
        continue;
      }
      if (afterTimestamp !== null && projection.created_at < afterTimestamp) {
        continue;
      }
      if (beforeTimestamp !== null && projection.created_at >= beforeTimestamp) {
        continue;
      }
      if (hasAttachment && projection.has_attachment !== 1) {
        continue;
      }
      if (!includeAdminPrivate) {
        const channel = this.getChannel(
          projection.group_id,
          normalizeReticulumChatChannelId(projection.channel_id)
        );
        if (channel?.readMode === RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS) {
          continue;
        }
      }
      if (
        cursorSort &&
        !isProjectionAfterSearchCursor(projection, cursor, cursorSort)
      ) {
        continue;
      }
      results.push({
        event: messageProjectionRowToEvent(projection),
        snippet: buildPlainSnippet(row.search_text, terms),
        cursor: searchCursorFromProjection(projection),
      });
    }
    if (sort === 'oldest') {
      results.sort(
        (a, b) =>
          a.event.timestamp - b.event.timestamp ||
          a.event.eventId.localeCompare(b.event.eventId)
      );
    } else if (sort === 'newest') {
      results.sort(
        (a, b) =>
          b.event.timestamp - a.event.timestamp ||
          b.event.eventId.localeCompare(a.event.eventId)
      );
    }
    return results.slice(offset, offset + limit);
  }

  private searchEventsMemory(
    terms: string[],
    allowedGroups: Set<number> | null,
    allowedChannels: Set<string> | null,
    allowedAuthors: Set<string> | null,
    allowedEventTypes: Set<string> | null,
    includeAdminPrivate: boolean,
    beforeTimestamp: number | null,
    afterTimestamp: number | null,
    hasAttachment: boolean,
    hasLink: boolean,
    sort: 'relevance' | 'newest' | 'oldest',
    now: number,
    limit: number,
    offset: number,
    cursor: ReticulumChatSearchCursor | null,
    cursorSort: 'newest' | 'oldest' | null
  ): ReticulumChatSearchResult[] {
    const results: ReticulumChatSearchResult[] = [];
    const rootEventIds = new Set<string>();
    for (const event of this.memoryEvents.values()) {
      if (
        event.eventType === 'message' ||
        event.eventType === 'attachment_manifest'
      ) {
        rootEventIds.add(event.eventId);
      } else if (event.eventType === 'edit' && event.targetEventId) {
        rootEventIds.add(event.targetEventId);
      } else if (event.eventType === 'delete' && event.targetEventId) {
        rootEventIds.add(event.targetEventId);
      }
    }
    const events = [...rootEventIds]
      .map((rootEventId) => this.computeMessageProjectionForRoot(rootEventId))
      .filter((projection): projection is MessageProjectionRow => {
        return (
          !!projection &&
          projection.deleted_at === null &&
          (projection.expires_at === null ||
            projection.expires_at === undefined ||
            projection.expires_at > now)
        );
      })
      .sort((a, b) =>
        sort === 'oldest'
          ? a.created_at - b.created_at ||
            a.root_event_id.localeCompare(b.root_event_id)
          : b.created_at - a.created_at ||
            b.root_event_id.localeCompare(a.root_event_id)
      );
    for (const projection of events) {
      const event = messageProjectionRowToEvent(projection);
      if (allowedGroups && !allowedGroups.has(event.groupId)) continue;
      if (
        allowedChannels &&
        !allowedChannels.has(normalizeReticulumChatChannelId(event.channelId))
      ) {
        continue;
      }
      if (allowedAuthors && !allowedAuthors.has(projection.author_address)) {
        continue;
      }
      if (
        allowedEventTypes &&
        !allowedEventTypes.has(projection.root_event_type)
      ) {
        continue;
      }
      if (afterTimestamp !== null && projection.created_at < afterTimestamp) {
        continue;
      }
      if (beforeTimestamp !== null && projection.created_at >= beforeTimestamp) {
        continue;
      }
      if (hasAttachment && projection.has_attachment !== 1) {
        continue;
      }
      if (!includeAdminPrivate) {
        const channel = this.getChannel(
          projection.group_id,
          normalizeReticulumChatChannelId(projection.channel_id)
        );
        if (channel?.readMode === RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS) {
          continue;
        }
      }
      if (
        cursorSort &&
        !isProjectionAfterSearchCursor(projection, cursor, cursorSort)
      ) {
        continue;
      }
      const text =
        this.memorySearchText.get(event.eventId) ??
        searchTextFromPayload(projection.encrypted_payload);
      const lower = text.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      if (hasLink && !lower.includes('http') && !lower.includes('www.')) {
        continue;
      }
      results.push({
        event,
        snippet: buildPlainSnippet(text, terms),
        cursor: searchCursorFromProjection(projection),
      });
    }
    return results.slice(offset, offset + limit);
  }

  private backfillSearchIndex(limit = 5000): void {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM reticulum_chat_search_index')
      .get() as { cnt?: number } | undefined;
    if ((row?.cnt ?? 0) > 0) return;
    const rows = this.db
      .prepare(
        `
          SELECT * FROM reticulum_chat_events
          WHERE event_type IN ('message', 'attachment_manifest')
          ORDER BY timestamp DESC, event_id DESC
          LIMIT ?
        `
      )
      .all(limit) as EventRow[];
    if (rows.length === 0) return;
    const tx = this.db.transaction((events: EventRow[]) => {
      for (const eventRow of events) {
        const event = rowToEvent(eventRow);
        this.upsertSearchText(
          event,
          searchTextFromPayload(event.encryptedPayload),
          true
        );
      }
    });
    tx(rows);
  }

  private backfillMessageProjection(limit = 10000): void {
    const rows = this.db
      .prepare(
        `
          SELECT e.event_id
          FROM reticulum_chat_events e
          LEFT JOIN rchat_message_projection p
            ON p.root_event_id = e.event_id
          WHERE event_type IN ('message', 'attachment_manifest')
            AND p.root_event_id IS NULL
          ORDER BY timestamp DESC, event_id DESC
          LIMIT ?
        `
      )
      .all(limit) as Array<{ event_id?: string }>;
    if (rows.length === 0) return;
    const tx = this.db.transaction((eventIds: string[]) => {
      for (const eventId of eventIds) {
        this.rebuildMessageProjection(eventId);
      }
    });
    tx(
      rows
        .map((row) => (typeof row.event_id === 'string' ? row.event_id : ''))
        .filter(Boolean)
    );
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reticulum_chat_events (
        event_id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL DEFAULT 'general',
        author_address TEXT NOT NULL,
        author_public_key TEXT NOT NULL,
        author_seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        feed_timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        target_event_id TEXT,
        reply_to_event_id TEXT,
        encrypted_payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        mention_address_hashes TEXT NOT NULL DEFAULT '[]',
        mention_targets TEXT NOT NULL DEFAULT '[]',
        signature TEXT NOT NULL,
        own_event INTEGER NOT NULL DEFAULT 0,
        last_served_at INTEGER NOT NULL,
        stored_at INTEGER NOT NULL,
        accepted_at INTEGER NOT NULL,
        wire_bytes INTEGER NOT NULL,
        scrubbed_at INTEGER,
        expires_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS reticulum_chat_author_seq_idx
        ON reticulum_chat_events (group_id, author_address, author_seq);
      CREATE INDEX IF NOT EXISTS reticulum_chat_group_time_idx
        ON reticulum_chat_events (group_id, channel_id, timestamp, author_seq);
      CREATE INDEX IF NOT EXISTS idx_reticulum_chat_events_group_recent
        ON reticulum_chat_events (group_id, timestamp DESC, event_id DESC);
      DROP INDEX IF EXISTS idx_reticulum_chat_events_group_type_recent;
      CREATE INDEX IF NOT EXISTS idx_reticulum_chat_events_metadata_recent
        ON reticulum_chat_events (group_id, timestamp DESC, event_id DESC)
        WHERE event_type IN (
          'channel_create',
          'channel_update',
          'channel_archive',
          'channel_restore',
          'channel_reorder',
          'category_create',
          'category_update',
          'category_delete'
        );
      CREATE INDEX IF NOT EXISTS idx_reticulum_chat_events_feed
        ON reticulum_chat_events (group_id, channel_id, feed_timestamp, event_id);
      CREATE INDEX IF NOT EXISTS idx_reticulum_chat_events_author_seq
        ON reticulum_chat_events (group_id, author_address, author_seq);
      CREATE INDEX IF NOT EXISTS idx_reticulum_chat_events_target
        ON reticulum_chat_events (target_event_id, timestamp, event_id);
      CREATE INDEX IF NOT EXISTS reticulum_chat_cache_idx
        ON reticulum_chat_events (own_event, last_served_at, timestamp);
      CREATE TABLE IF NOT EXISTS rchat_event_headers (
        event_id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL DEFAULT 'general',
        author_address TEXT NOT NULL,
        author_public_key TEXT NOT NULL,
        author_seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        feed_timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        target_event_id TEXT,
        reply_to_event_id TEXT,
        payload_hash TEXT NOT NULL,
        mention_address_hashes TEXT NOT NULL DEFAULT '[]',
        mention_targets TEXT NOT NULL DEFAULT '[]',
        signature TEXT NOT NULL,
        own_event INTEGER NOT NULL DEFAULT 0,
        last_served_at INTEGER NOT NULL,
        stored_at INTEGER NOT NULL,
        accepted_at INTEGER NOT NULL,
        wire_bytes INTEGER NOT NULL,
        retention_state TEXT NOT NULL DEFAULT 'full',
        scrubbed_at INTEGER,
        expires_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rchat_event_headers_author_seq
        ON rchat_event_headers (group_id, author_address, author_seq);
      CREATE INDEX IF NOT EXISTS idx_rchat_event_headers_group_recent
        ON rchat_event_headers (group_id, timestamp DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS idx_rchat_event_headers_feed
        ON rchat_event_headers (group_id, channel_id, feed_timestamp, event_id);
      CREATE INDEX IF NOT EXISTS idx_rchat_event_headers_payload
        ON rchat_event_headers (payload_hash);
      CREATE TABLE IF NOT EXISTS rchat_event_payloads (
        event_id TEXT PRIMARY KEY,
        encrypted_payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        retained_until INTEGER,
        stored_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_event_payloads_retention
        ON rchat_event_payloads (retained_until, stored_at);
      CREATE TABLE IF NOT EXISTS rchat_metadata_snapshots (
        group_id INTEGER NOT NULL,
        snapshot_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        latest_event_id TEXT NOT NULL DEFAULT '',
        latest_feed_timestamp INTEGER NOT NULL DEFAULT 0,
        snapshot_hash TEXT NOT NULL,
        admin_address TEXT NOT NULL,
        admin_public_key TEXT NOT NULL,
        signature TEXT NOT NULL,
        channels_json TEXT NOT NULL,
        categories_json TEXT NOT NULL,
        PRIMARY KEY (group_id, snapshot_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rchat_metadata_snapshots_hash
        ON rchat_metadata_snapshots (group_id, snapshot_hash);
      CREATE INDEX IF NOT EXISTS idx_rchat_metadata_snapshots_latest
        ON rchat_metadata_snapshots (group_id, version DESC, created_at DESC);
      CREATE TABLE IF NOT EXISTS rchat_sync_state (
        scope TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        peer_hash TEXT NOT NULL DEFAULT '',
        state_key TEXT NOT NULL,
        state_value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, group_id, peer_hash, state_key)
      );
      CREATE TABLE IF NOT EXISTS rchat_message_projection (
        root_event_id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL DEFAULT 'general',
        author_address TEXT NOT NULL,
        author_public_key TEXT NOT NULL,
        author_seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        root_event_type TEXT NOT NULL,
        current_event_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        reply_to_event_id TEXT,
        encrypted_payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        mention_address_hashes TEXT NOT NULL DEFAULT '[]',
        mention_targets TEXT NOT NULL DEFAULT '[]',
        signature TEXT NOT NULL,
        deleted_at INTEGER,
        deleted_event_id TEXT,
        expires_at INTEGER,
        has_attachment INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_message_projection_visible
        ON rchat_message_projection (group_id, channel_id, deleted_at, created_at, root_event_id);
      CREATE INDEX IF NOT EXISTS idx_rchat_message_projection_group_visible
        ON rchat_message_projection (group_id, deleted_at, created_at, root_event_id);
      CREATE INDEX IF NOT EXISTS idx_rchat_message_projection_window
        ON rchat_message_projection (group_id, channel_id, created_at, root_event_id)
        WHERE deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS rchat_peer_group_state (
        peer_hash TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        latest_event_id TEXT,
        latest_feed_timestamp INTEGER,
        digest_hash TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (peer_hash, group_id)
      );
      CREATE TABLE IF NOT EXISTS rchat_peer_channel_state (
        peer_hash TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        latest_event_id TEXT,
        latest_feed_timestamp INTEGER,
        oldest_event_id TEXT,
        oldest_feed_timestamp INTEGER,
        visible_window_hash TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (peer_hash, group_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS rchat_verified_windows (
        group_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        start_event_id TEXT NOT NULL,
        start_feed_timestamp INTEGER NOT NULL,
        end_event_id TEXT NOT NULL,
        end_feed_timestamp INTEGER NOT NULL,
        window_hash TEXT NOT NULL,
        verified_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, channel_id, start_event_id, end_event_id)
      );
      CREATE TABLE IF NOT EXISTS rchat_missing_ranges (
        group_id INTEGER NOT NULL,
        author_address TEXT NOT NULL,
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        preferred_peer TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, author_address, from_seq, to_seq)
      );
      CREATE TABLE IF NOT EXISTS rchat_sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        priority INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        channel_id TEXT,
        peer_hash TEXT,
        operation TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE (dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_sync_queue_ready
        ON rchat_sync_queue (priority, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_rchat_peer_channel_state
        ON rchat_peer_channel_state (peer_hash, group_id, channel_id);
      CREATE INDEX IF NOT EXISTS idx_rchat_peer_group_state
        ON rchat_peer_group_state (peer_hash, group_id);
      CREATE INDEX IF NOT EXISTS idx_rchat_missing_ranges_ready
        ON rchat_missing_ranges (group_id, author_address, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_rchat_verified_windows_lookup
        ON rchat_verified_windows (group_id, channel_id, start_feed_timestamp, end_feed_timestamp);
      CREATE TABLE IF NOT EXISTS rchat_relay_cache (
        blob_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        group_id INTEGER NOT NULL,
        group_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        encoding TEXT NOT NULL DEFAULT 'plain-json-v1',
        encryption TEXT NOT NULL DEFAULT 'none',
        key_epoch INTEGER,
        encrypted_key_id TEXT,
        payload_json TEXT NOT NULL,
        source_peer_hash TEXT NOT NULL DEFAULT '',
        served_count INTEGER NOT NULL DEFAULT 0,
        last_served_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_relay_cache_event
        ON rchat_relay_cache (group_id, event_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_rchat_relay_cache_eviction
        ON rchat_relay_cache (expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_rchat_relay_cache_group_created
        ON rchat_relay_cache (group_id, created_at, event_id);
      CREATE TABLE IF NOT EXISTS rchat_group_keys (
        group_id INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        key_bytes_base64 TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        admin_public_key TEXT NOT NULL,
        admin_signature TEXT NOT NULL,
        PRIMARY KEY (group_id, epoch, key_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_group_keys_active
        ON rchat_group_keys (group_id, status, epoch, created_at);
      CREATE TABLE IF NOT EXISTS rchat_group_key_digests (
        group_id INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        admin_public_key TEXT NOT NULL,
        admin_signature TEXT NOT NULL,
        source_peer_hash TEXT NOT NULL DEFAULT '',
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, epoch, key_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_group_key_digests_latest
        ON rchat_group_key_digests (group_id, epoch, created_at);
      CREATE TABLE IF NOT EXISTS rchat_group_key_requests (
        group_id INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (group_id, epoch, key_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_group_key_requests_pending
        ON rchat_group_key_requests (status, requested_at);
      CREATE TABLE IF NOT EXISTS reticulum_chat_read_watermarks (
        group_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL DEFAULT 'general',
        address TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (group_id, channel_id, address)
      );
      CREATE TABLE IF NOT EXISTS reticulum_chat_mentions (
        event_id TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL DEFAULT 'general',
        mentioned_address TEXT NOT NULL,
        author_address TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        read_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (event_id, mentioned_address)
      );
      CREATE INDEX IF NOT EXISTS reticulum_chat_mentions_unread_idx
        ON reticulum_chat_mentions (group_id, channel_id, mentioned_address, read_at, timestamp);
      CREATE TABLE IF NOT EXISTS reticulum_chat_search_index (
        event_id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL DEFAULT 'general',
        author_address TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        search_text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reticulum_chat_search_group_time_idx
        ON reticulum_chat_search_index (group_id, channel_id, timestamp);
      CREATE VIRTUAL TABLE IF NOT EXISTS reticulum_chat_search_fts USING fts5(
        event_id UNINDEXED,
        group_id UNINDEXED,
        channel_id UNINDEXED,
        author_address UNINDEXED,
        timestamp UNINDEXED,
        event_type UNINDEXED,
        search_text,
        tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS reticulum_chat_channels (
        group_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        category_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        position INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        write_mode TEXT NOT NULL DEFAULT 'members',
        read_mode TEXT NOT NULL DEFAULT 'members',
        write_mode_updated_at INTEGER NOT NULL DEFAULT 0,
        expiry_duration_ms INTEGER,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS reticulum_chat_categories (
        group_id INTEGER NOT NULL,
        category_id TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, category_id)
      );
      CREATE TABLE IF NOT EXISTS rchat_dm_events (
        event_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        sender_public_key TEXT NOT NULL,
        sender_seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        target_event_id TEXT,
        reply_to_event_id TEXT,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        signature TEXT NOT NULL,
        own_event INTEGER NOT NULL DEFAULT 0,
        read_at INTEGER NOT NULL DEFAULT 0,
        stored_at INTEGER NOT NULL,
        wire_bytes INTEGER NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'received',
        delivery_updated_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE (conversation_id, sender_address, sender_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_dm_events_conversation_time
        ON rchat_dm_events (conversation_id, timestamp, event_id);
      CREATE INDEX IF NOT EXISTS idx_rchat_dm_events_sender_seq
        ON rchat_dm_events (conversation_id, sender_address, sender_seq);
      CREATE INDEX IF NOT EXISTS idx_rchat_dm_events_unread
        ON rchat_dm_events (conversation_id, recipient_address, read_at, timestamp);
    `);
  }

  private initRelayCacheSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rchat_relay_cache (
        blob_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        group_id INTEGER NOT NULL,
        group_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        encoding TEXT NOT NULL DEFAULT 'plain-json-v1',
        encryption TEXT NOT NULL DEFAULT 'none',
        key_epoch INTEGER,
        encrypted_key_id TEXT,
        payload_json TEXT NOT NULL,
        source_peer_hash TEXT NOT NULL DEFAULT '',
        served_count INTEGER NOT NULL DEFAULT 0,
        last_served_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_relay_cache_event
        ON rchat_relay_cache (group_id, event_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_rchat_relay_cache_eviction
        ON rchat_relay_cache (expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_rchat_relay_cache_group_created
        ON rchat_relay_cache (group_id, created_at, event_id);
    `);
  }

  private initGroupKeySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rchat_group_keys (
        group_id INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        key_bytes_base64 TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        admin_public_key TEXT NOT NULL,
        admin_signature TEXT NOT NULL,
        PRIMARY KEY (group_id, epoch, key_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_group_keys_active
        ON rchat_group_keys (group_id, status, epoch, created_at);
      CREATE TABLE IF NOT EXISTS rchat_group_key_digests (
        group_id INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        admin_public_key TEXT NOT NULL,
        admin_signature TEXT NOT NULL,
        source_peer_hash TEXT NOT NULL DEFAULT '',
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, epoch, key_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_group_key_digests_latest
        ON rchat_group_key_digests (group_id, epoch, created_at);
      CREATE TABLE IF NOT EXISTS rchat_group_key_requests (
        group_id INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (group_id, epoch, key_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_group_key_requests_pending
        ON rchat_group_key_requests (status, requested_at);
    `);
  }

  private migrateReadWatermarksSchema(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(reticulum_chat_read_watermarks)')
      .all() as Array<{ name?: string }>;
    const hasAddress = columns.some((column) => column.name === 'address');
    if (hasAddress) return;
    const tx = this.db.transaction(() => {
      this.db.exec(`
        ALTER TABLE reticulum_chat_read_watermarks
          RENAME TO reticulum_chat_read_watermarks_legacy;
        CREATE TABLE reticulum_chat_read_watermarks (
          group_id INTEGER NOT NULL,
          address TEXT NOT NULL DEFAULT '',
          timestamp INTEGER NOT NULL,
          PRIMARY KEY (group_id, address)
        );
        INSERT INTO reticulum_chat_read_watermarks (group_id, address, timestamp)
          SELECT group_id, '', timestamp
          FROM reticulum_chat_read_watermarks_legacy;
        DROP TABLE reticulum_chat_read_watermarks_legacy;
      `);
    });
    tx();
  }

  private migrateChannelWriteModeSchema(): void {
    this.ensureColumn(
      'reticulum_chat_channels',
      'write_mode',
      `
      ALTER TABLE reticulum_chat_channels
        ADD COLUMN write_mode TEXT NOT NULL DEFAULT 'members'
      `
    );
  }

  private migrateChannelReadModeSchema(): void {
    this.ensureColumn(
      'reticulum_chat_channels',
      'read_mode',
      `
      ALTER TABLE reticulum_chat_channels
        ADD COLUMN read_mode TEXT NOT NULL DEFAULT 'members'
      `
    );
  }

  private migrateChannelWriteModeUpdatedAtSchema(): void {
    this.ensureColumn(
      'reticulum_chat_channels',
      'write_mode_updated_at',
      `
      ALTER TABLE reticulum_chat_channels
        ADD COLUMN write_mode_updated_at INTEGER NOT NULL DEFAULT 0
      `
    );
  }

  private runSchemaMigrations(): void {
    const migrations: Array<{ name: string; run: () => void }> = [
      { name: 'channel-write-mode', run: () => this.migrateChannelWriteModeSchema() },
      { name: 'channel-read-mode', run: () => this.migrateChannelReadModeSchema() },
      {
        name: 'channel-write-mode-updated-at',
        run: () => this.migrateChannelWriteModeUpdatedAtSchema(),
      },
      { name: 'message-expiry', run: () => this.migrateExpirySchema() },
      {
        name: 'message-projection-attachments',
        run: () => this.migrateMessageProjectionAttachmentSchema(),
      },
      { name: 'event-mention-targets', run: () => this.migrateEventMentionTargetsSchema() },
      { name: 'event-scrubbed-at', run: () => this.migrateEventScrubbedAtSchema() },
      { name: 'dm-delivery-status', run: () => this.migrateDirectDeliveryStatusSchema() },
      { name: 'relay-cache', run: () => this.initRelayCacheSchema() },
      { name: 'group-keys', run: () => this.initGroupKeySchema() },
    ];
    for (const migration of migrations) {
      try {
        migration.run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Reticulum chat DB migration failed: ${migration.name}: ${message}`);
      }
    }
  }

  private tableColumns(tableName: string): Set<string> {
    const rows = this.db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: string }>;
    return new Set(
      rows
        .map((row) => (typeof row.name === 'string' ? row.name : ''))
        .filter(Boolean)
    );
  }

  private ensureColumn(tableName: string, columnName: string, alterSql: string): void {
    if (this.tableColumns(tableName).has(columnName)) return;
    this.db.exec(alterSql);
  }

  private verifyRequiredSchema(): void {
    const requiredTables: Array<{ table: string; columns: string[] }> = [
      {
        table: 'reticulum_chat_events',
        columns: ['channel_id', 'mention_targets', 'scrubbed_at', 'expires_at'],
      },
      {
        table: 'rchat_message_projection',
        columns: ['expires_at', 'has_attachment'],
      },
      {
        table: 'rchat_event_headers',
        columns: ['event_id', 'payload_hash', 'retention_state'],
      },
      {
        table: 'rchat_event_payloads',
        columns: ['event_id', 'encrypted_payload', 'retained_until'],
      },
      {
        table: 'rchat_metadata_snapshots',
        columns: ['group_id', 'snapshot_hash', 'channels_json', 'categories_json'],
      },
      {
        table: 'reticulum_chat_channels',
        columns: [
          'write_mode',
          'read_mode',
          'write_mode_updated_at',
          'expiry_duration_ms',
        ],
      },
      {
        table: 'rchat_expired_event_markers',
        columns: [
          'event_id',
          'group_id',
          'channel_id',
          'author_address',
          'author_seq',
          'timestamp',
          'expired_at',
        ],
      },
      {
        table: 'rchat_dm_events',
        columns: ['delivery_status', 'delivery_updated_at'],
      },
    ];
    const missing: string[] = [];
    for (const item of requiredTables) {
      const columns = this.tableColumns(item.table);
      if (columns.size === 0) {
        missing.push(`${item.table}.*`);
        continue;
      }
      for (const column of item.columns) {
        if (!columns.has(column)) missing.push(`${item.table}.${column}`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Reticulum chat DB schema migration incomplete; missing ${missing.join(', ')}`
      );
    }
  }

  private migrateExpirySchema(): void {
    this.ensureColumn(
      'reticulum_chat_channels',
      'expiry_duration_ms',
      `
        ALTER TABLE reticulum_chat_channels
          ADD COLUMN expiry_duration_ms INTEGER
      `
    );
    this.ensureColumn(
      'reticulum_chat_events',
      'expires_at',
      `
        ALTER TABLE reticulum_chat_events
          ADD COLUMN expires_at INTEGER
      `
    );
    this.ensureColumn(
      'rchat_message_projection',
      'expires_at',
      `
        ALTER TABLE rchat_message_projection
          ADD COLUMN expires_at INTEGER
      `
    );

    const markerColumns = this.tableColumns('rchat_expired_event_markers');
    if (
      markerColumns.size > 0 &&
      !['author_address', 'author_seq', 'timestamp', 'expired_at'].every((name) =>
        markerColumns.has(name)
      )
    ) {
      this.db.exec('DROP TABLE rchat_expired_event_markers');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rchat_expired_event_markers (
        event_id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL DEFAULT 'general',
        author_address TEXT NOT NULL,
        author_seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        expired_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rchat_expired_event_markers_author_seq
        ON rchat_expired_event_markers (group_id, author_address, author_seq);
      CREATE INDEX IF NOT EXISTS idx_reticulum_chat_events_expires
        ON reticulum_chat_events (expires_at);
      CREATE INDEX IF NOT EXISTS idx_rchat_message_projection_expires
        ON rchat_message_projection (expires_at);
    `);
  }

  private migrateMessageProjectionAttachmentSchema(): void {
    this.ensureColumn(
      'rchat_message_projection',
      'has_attachment',
      `
        ALTER TABLE rchat_message_projection
          ADD COLUMN has_attachment INTEGER NOT NULL DEFAULT 0
      `
    );
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rchat_message_projection_attachments
        ON rchat_message_projection (group_id, has_attachment, deleted_at, created_at, root_event_id);
    `);
    this.db.exec(`
      UPDATE rchat_message_projection
      SET has_attachment = CASE
        WHEN root_event_type = 'attachment_manifest'
          OR encrypted_payload LIKE '%"attachments"%'
        THEN 1
        ELSE 0
      END
    `);
  }

  private migrateEventMentionTargetsSchema(): void {
    this.ensureColumn(
      'reticulum_chat_events',
      'mention_targets',
      `
      ALTER TABLE reticulum_chat_events
        ADD COLUMN mention_targets TEXT NOT NULL DEFAULT '[]'
      `
    );
  }

  private migrateEventScrubbedAtSchema(): void {
    this.ensureColumn(
      'reticulum_chat_events',
      'scrubbed_at',
      `
      ALTER TABLE reticulum_chat_events
        ADD COLUMN scrubbed_at INTEGER
      `
    );
  }

  private migrateDirectDeliveryStatusSchema(): void {
    this.ensureColumn(
      'rchat_dm_events',
      'delivery_status',
      `
        ALTER TABLE rchat_dm_events
          ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'received'
      `
    );
    this.ensureColumn(
      'rchat_dm_events',
      'delivery_updated_at',
      `
        ALTER TABLE rchat_dm_events
          ADD COLUMN delivery_updated_at INTEGER NOT NULL DEFAULT 0
      `
    );
  }
}
