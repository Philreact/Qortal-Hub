import Database, { type Database as DB, type Statement } from 'better-sqlite3';
import * as nodeCrypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ReticulumChatEvent } from './reticulum-chat';

export const RETICULUM_CHAT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const RETICULUM_CHAT_DEFAULT_CHANNEL_ID = 'general';

export type ReticulumGroupChannel = {
  channelId: string;
  groupId: number;
  categoryId?: string;
  name: string;
  description?: string;
  position: number;
  archived: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
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
  signature: string;
  own_event: number;
  last_served_at: number;
  stored_at: number;
  accepted_at: number;
  wire_bytes: number;
};

function rowToEvent(row: EventRow): ReticulumChatEvent {
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
    signature: row.signature,
  };
}

export function normalizeReticulumChatChannelId(value: unknown): string {
  if (typeof value !== 'string') return RETICULUM_CHAT_DEFAULT_CHANNEL_ID;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(normalized) ||
    normalized === RETICULUM_CHAT_DEFAULT_CHANNEL_ID
    ? normalized
    : RETICULUM_CHAT_DEFAULT_CHANNEL_ID;
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

export function hashReticulumChatMentionAddress(address: string): string {
  return nodeCrypto
    .createHash('sha256')
    .update(`reticulum-chat-mention:${address.trim()}`, 'utf8')
    .digest('hex');
}

function eventWireBytes(event: ReticulumChatEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
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

function normalizeSearchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 20_000);
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
    .map((term) => `${term}*`)
    .join(' AND ');
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
  private db: DB;
  private memoryEvents = new Map<string, ReticulumChatEvent>();
  private memorySearchText = new Map<string, string>();
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
  private memoryMeta = new Map<
    string,
    { ownEvent: boolean; lastServedAt: number; storedAt: number; wireBytes: number }
  >();
  private stmtInsertEvent: Statement;
  private stmtGetEvent: Statement;
  private stmtHasEvent: Statement;
  private stmtGetRecentEvents: Statement;
  private stmtGetChannelMetadataEvents: Statement;
  private stmtGetEventsAfter: Statement;
  private stmtGetEventsAfterCursor: Statement;
  private stmtGetEventsBefore: Statement;
  private stmtGetEventsBeforeCursor: Statement;
  private stmtGetGroupEventsAfter: Statement;
  private stmtGetGroupEventsAfterCursor: Statement;
  private stmtGetGroupEventsBeforeCursor: Statement;
  private stmtGetAuthorMaxSeq: Statement;
  private stmtGetAuthorEventsAfter: Statement;
  private stmtGetAuthorHeads: Statement;
  private stmtGetAuthorSequenceGaps: Statement;
  private stmtGetMissingByAuthor: Statement;
  private stmtGetGroupSeqs: Statement;
  private stmtGetKnownGroups: Statement;
  private stmtGetKnownChannels: Statement;
  private stmtGetLastDisplayEvent: Statement;
  private stmtCountUnreadDisplayEvents: Statement;
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
  private stmtUpsertSearchMirror: Statement;
  private stmtDeleteSearchMirror: Statement;
  private stmtSearchMirror: Statement;
  private stmtUpsertSearchText: Statement;
  private stmtDeleteSearchText: Statement;
  private stmtSearchEvents: Statement;
  private stmtUpsertChannel: Statement;
  private stmtGetChannels: Statement;
  private stmtGetChannel: Statement;
  private stmtUpsertCategory: Statement;
  private stmtGetCategories: Statement;
  private stmtGetCategory: Statement;
  private stmtDeleteCategory: Statement;
  private stmtClearChannelCategory: Statement;
  private stmtGetLatestCursor: Statement;
  private stmtGetOldestCursor: Statement;
  private stmtGetChannelDigests: Statement;
  private stmtGetFeedPageAfter: Statement;
  private stmtGetFeedPageBefore: Statement;
  private stmtGetAuthorEventsRange: Statement;
  private stmtUpsertPeerGroupState: Statement;
  private stmtUpsertPeerChannelState: Statement;
  private stmtUpsertVerifiedWindow: Statement;
  private stmtUpsertMissingRange: Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();

    this.stmtInsertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO reticulum_chat_events
        (event_id, group_id, author_address, author_public_key, author_seq,
         timestamp, feed_timestamp, event_type, target_event_id, reply_to_event_id,
         encrypted_payload, payload_hash, mention_address_hashes, signature, own_event,
         last_served_at, stored_at, accepted_at, wire_bytes, channel_id)
      VALUES
        (@event_id, @group_id, @author_address, @author_public_key, @author_seq,
         @timestamp, @feed_timestamp, @event_type, @target_event_id, @reply_to_event_id,
         @encrypted_payload, @payload_hash, @mention_address_hashes, @signature, @own_event,
         @last_served_at, @stored_at, @accepted_at, @wire_bytes, @channel_id)
    `);
    this.stmtGetEvent = this.db.prepare(
      'SELECT * FROM reticulum_chat_events WHERE event_id = ? LIMIT 1'
    );
    this.stmtHasEvent = this.db.prepare(
      'SELECT 1 FROM reticulum_chat_events WHERE event_id = ? LIMIT 1'
    );
    this.stmtGetRecentEvents = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ? AND channel_id = ?
        ORDER BY timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY timestamp ASC, event_id ASC
    `);
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
    this.stmtGetEventsAfter = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND feed_timestamp > ?
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetEventsAfterCursor = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND (feed_timestamp > ? OR (feed_timestamp = ? AND event_id > ?))
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetEventsBefore = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND feed_timestamp < ?
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetEventsBeforeCursor = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND (feed_timestamp < ? OR (feed_timestamp = ? AND event_id < ?))
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetGroupEventsAfter = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND feed_timestamp > ?
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetGroupEventsAfterCursor = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND (feed_timestamp > ? OR (feed_timestamp = ? AND event_id > ?))
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetGroupEventsBeforeCursor = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ? AND (feed_timestamp < ? OR (feed_timestamp = ? AND event_id < ?))
        ORDER BY feed_timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY feed_timestamp ASC, event_id ASC
    `);
    this.stmtGetAuthorMaxSeq = this.db.prepare(`
      SELECT MAX(author_seq) AS seq
      FROM reticulum_chat_events
      WHERE group_id = ? AND author_address = ?
    `);
    this.stmtGetAuthorEventsAfter = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND author_address = ? AND author_seq > ?
      ORDER BY author_seq ASC, timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetAuthorHeads = this.db.prepare(`
      SELECT e.author_address, e.author_seq AS max_seq, e.event_id, e.timestamp
      FROM reticulum_chat_events e
      JOIN (
        SELECT author_address, MAX(author_seq) AS max_seq
        FROM reticulum_chat_events
        WHERE group_id = ?
        GROUP BY author_address
      ) h ON h.author_address = e.author_address AND h.max_seq = e.author_seq
      WHERE e.group_id = ?
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
        FROM reticulum_chat_events
        WHERE group_id = ?
      )
      SELECT author_address,
             previous_seq + 1 AS from_seq,
             author_seq - 1 AS to_seq
      FROM ordered
      WHERE previous_seq IS NOT NULL
        AND author_seq > previous_seq + 1
      ORDER BY author_address ASC, from_seq ASC
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
      FROM reticulum_chat_events
      WHERE group_id = ?
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
    this.stmtGetLastDisplayEvent = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND event_type IN ('message', 'attachment_manifest')
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
    this.stmtSearchEvents = this.db.prepare(`
      SELECT event_id,
             snippet(reticulum_chat_search_fts, 5, '<mark>', '</mark>', '...', 12) AS snippet
      FROM reticulum_chat_search_fts
      WHERE reticulum_chat_search_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.stmtUpsertChannel = this.db.prepare(`
      INSERT OR REPLACE INTO reticulum_chat_channels
        (group_id, channel_id, category_id, name, description, position, archived, created_by, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    this.stmtDeleteCategory = this.db.prepare(
      'DELETE FROM reticulum_chat_categories WHERE group_id = ? AND category_id = ?'
    );
    this.stmtClearChannelCategory = this.db.prepare(
      'UPDATE reticulum_chat_channels SET category_id = NULL WHERE group_id = ? AND category_id = ?'
    );
    this.stmtGetLatestCursor = this.db.prepare(`
      SELECT event_id, feed_timestamp
      FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ?
      ORDER BY feed_timestamp DESC, event_id DESC
      LIMIT 1
    `);
    this.stmtGetOldestCursor = this.db.prepare(`
      SELECT event_id, feed_timestamp
      FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ?
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
      ORDER BY feed_timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetFeedPageBefore = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ?
          AND channel_id = ?
          AND (feed_timestamp < ? OR (feed_timestamp = ? AND event_id < ?))
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
      ORDER BY author_seq ASC, feed_timestamp ASC, event_id ASC
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
    this.backfillSearchIndex();
  }

  close(): void {
    this.db.close();
  }

  insertEvent(event: ReticulumChatEvent, ownEvent: boolean): boolean {
    const now = Date.now();
    const feedTimestamp = this.normalizeFeedTimestamp(event.timestamp, now);
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
      signature: event.signature,
      own_event: ownEvent ? 1 : 0,
      last_served_at: now,
      stored_at: now,
      accepted_at: now,
      wire_bytes: eventWireBytes(event),
    });
    const inserted = result.changes > 0;
    if (inserted) {
      this.memoryEvents.set(event.eventId, event);
      this.memoryMeta.set(event.eventId, {
        ownEvent,
        lastServedAt: now,
        storedAt: now,
        wireBytes: eventWireBytes(event),
      });
      this.upsertSearchText(
        event,
        searchTextFromPayload(event.encryptedPayload),
        false
      );
    }
    if (!ownEvent) this.enforceRelayCacheLimit();
    return inserted;
  }

  hasEvent(eventId: string): boolean {
    return this.memoryEvents.has(eventId) || !!this.stmtHasEvent.get(eventId);
  }

  getEvent(eventId: string): ReticulumChatEvent | null {
    const inMemory = this.memoryEvents.get(eventId);
    if (inMemory) return inMemory;
    const row = this.stmtGetEvent.get(eventId) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
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

  indexSearchText(eventId: string, text: string): boolean {
    const event = this.getEvent(eventId);
    if (!event) return false;
    this.upsertSearchText(event, text, true);
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
      event.eventId,
      uniqueMentionedAddresses.map((mentionedAddress) => ({
        groupId: event.groupId,
        channelId: normalizeReticulumChatChannelId(event.channelId),
        mentionedAddress,
        authorAddress: event.authorAddress,
        timestamp: event.timestamp,
        readAt: 0,
      }))
    );
    const tx = this.db.transaction(() => {
      this.stmtDeleteMentionsForEvent.run(event.eventId);
      for (const mentionedAddress of uniqueMentionedAddresses) {
          this.stmtUpsertMention.run(
          event.eventId,
          event.groupId,
          normalizeReticulumChatChannelId(event.channelId),
          mentionedAddress,
          event.authorAddress,
          event.timestamp
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
    options: { groupIds?: number[]; channelIds?: string[]; limit?: number } = {}
  ): ReticulumChatSearchResult[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    const terms = buildSearchTerms(query);
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
    const groupIds = (options.groupIds ?? [])
      .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
      .slice(0, 500);
    const queryLimit = groupIds.length > 0 ? Math.max(limit * 10, 200) : limit;
    const allowedGroups = groupIds.length > 0 ? new Set(groupIds) : null;
    const channelIds = (options.channelIds ?? [])
      .map(normalizeReticulumChatChannelId)
      .filter(Boolean);
    const allowedChannels = channelIds.length > 0 ? new Set(channelIds) : null;
    const rows = this.stmtSearchEvents.all(ftsQuery, queryLimit) as Array<{
      event_id: string;
      snippet?: string;
    }>;
    const results: ReticulumChatSearchResult[] = [];
    for (const row of rows) {
      const event = this.getEvent(row.event_id);
      if (!event) continue;
      if (allowedGroups && !allowedGroups.has(event.groupId)) continue;
      if (allowedChannels && !allowedChannels.has(normalizeReticulumChatChannelId(event.channelId))) continue;
      results.push({ event, snippet: row.snippet ?? '' });
      if (results.length >= limit) break;
    }
    if (results.length > 0) return results;
    const mirrorResults = this.searchEventsMirror(terms, allowedGroups, allowedChannels, limit);
    return mirrorResults.length > 0
      ? mirrorResults
      : this.searchEventsMemory(terms, allowedGroups, allowedChannels, limit);
  }

  getRecentEvents(groupId: number, limit: number, channelId: string | null = null): ReticulumChatEvent[] {
    const normalizedChannelId = channelId == null ? null : normalizeReticulumChatChannelId(channelId);
    if (normalizedChannelId == null) {
      const rows = this.db
        .prepare(`
          SELECT * FROM (
            SELECT * FROM reticulum_chat_events
            WHERE group_id = ?
            ORDER BY timestamp DESC, event_id DESC
            LIMIT ?
          )
          ORDER BY timestamp ASC, event_id ASC
        `)
        .all(groupId, limit) as EventRow[];
      return this.mergeWindowEvents(
        rows.map(rowToEvent),
        [...this.memoryEvents.values()]
          .filter((event) => event.groupId === groupId)
          .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
          .slice(0, limit),
        limit
      );
    }
    return this.mergeWindowEvents(
      (this.stmtGetRecentEvents.all(groupId, normalizedChannelId, limit) as EventRow[]).map(rowToEvent),
      [...this.memoryEvents.values()]
        .filter((event) => event.groupId === groupId && normalizeReticulumChatChannelId(event.channelId) === normalizedChannelId)
        .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
        .slice(0, limit),
      limit
    );
  }

  getChannelMetadataEvents(groupId: number, limit: number): ReticulumChatEvent[] {
    const maxLimit = Math.max(1, Math.min(500, limit));
    const metadataTypes = new Set([
      'channel_create',
      'channel_update',
      'channel_archive',
      'channel_restore',
      'channel_reorder',
      'category_create',
      'category_update',
      'category_delete',
    ]);
    return this.mergeWindowEvents(
      (this.stmtGetChannelMetadataEvents.all(groupId, maxLimit) as EventRow[]).map(rowToEvent),
      [...this.memoryEvents.values()]
        .filter((event) => event.groupId === groupId && metadataTypes.has(event.eventType))
        .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
        .slice(0, maxLimit),
      maxLimit
    ).filter((event) => metadataTypes.has(event.eventType));
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
              ORDER BY timestamp ASC, event_id ASC
              LIMIT ?
            `).all(groupId, afterTimestamp, limit) as EventRow[])
          : (this.stmtGetEventsAfter.all(groupId, normalizedChannelId, afterTimestamp, limit) as EventRow[]));
    const matchesAfter = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
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
                ORDER BY timestamp DESC, event_id DESC
                LIMIT ?
              )
              ORDER BY timestamp ASC, event_id ASC
            `).all(groupId, beforeTimestamp, limit) as EventRow[])
          : (this.stmtGetEventsBefore.all(groupId, normalizedChannelId, beforeTimestamp, limit) as EventRow[]));
    const matchesBefore = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
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
      .filter((event) => event.groupId === groupId)
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
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
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
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
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
      if (normalizeReticulumChatChannelId(event.channelId) !== normalizedChannelId) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        cursor
      ) < 0;
    };
    return this.mergeWindowEvents(
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
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
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
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.stmtGetGroupEventsBeforeCursor.all(
      groupId,
      cursor.feedTimestamp,
      cursor.feedTimestamp,
      cursor.eventId,
      safeLimit
    ) as EventRow[];
    const matches = (event: ReticulumChatEvent): boolean => {
      if (event.groupId !== groupId) return false;
      return this.compareFeedCursors(
        { eventId: event.eventId, feedTimestamp: this.normalizeFeedTimestamp(event.timestamp) },
        cursor
      ) < 0;
    };
    return this.mergeWindowEvents(
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
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.stmtGetAuthorEventsRange.all(
      groupId,
      authorAddress,
      safeFrom,
      safeTo,
      safeLimit
    ) as EventRow[];
    return this.mergeWindowEvents(
      rows.map(rowToEvent),
      [...this.memoryEvents.values()].filter(
        (event) =>
          event.groupId === groupId &&
          event.authorAddress === authorAddress &&
          event.authorSeq >= safeFrom &&
          event.authorSeq <= safeTo
      ),
      safeLimit
    ).sort((a, b) => a.authorSeq - b.authorSeq || a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
  }

  computeWindowHash(events: ReticulumChatEvent[]): string {
    const ids = [...new Set(events.map((event) => event.eventId))]
      .sort((a, b) => {
        const eventA = events.find((event) => event.eventId === a);
        const eventB = events.find((event) => event.eventId === b);
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
    nextAttemptAt = Date.now()
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
  }

  getAuthorMaxSeq(groupId: number, authorAddress: string): number {
    const row = this.stmtGetAuthorMaxSeq.get(groupId, authorAddress) as
      | { seq?: number }
      | undefined;
    let maxSeq = typeof row?.seq === 'number' && Number.isFinite(row.seq) ? row.seq : 0;
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
    const rows = this.stmtGetAuthorHeads.all(groupId, groupId, maxLimit + safeOffset, 0) as Array<{
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

    for (const row of this.stmtGetAuthorSequenceGaps.all(groupId, maxLimit) as Array<{
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
      .sort((a, b) => a.authorAddress.localeCompare(b.authorAddress) || a.fromSeq - b.fromSeq)
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
    const rows = this.stmtGetGroupSeqs.all(groupId) as Array<{
      author_address: string;
      seq: number;
    }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.author_address] = row.seq;
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
    return this.getChannels(groupId, true).find(
      (channel) => channel.channelId === normalizedChannelId
    ) ?? null;
  }

  upsertChannel(channel: ReticulumGroupChannel): boolean {
    const normalizedChannel: ReticulumGroupChannel = {
      ...channel,
      channelId: normalizeReticulumChatChannelId(channel.channelId),
      categoryId: normalizeReticulumChatCategoryId(channel.categoryId) || undefined,
      name: normalizeReticulumChatChannelId(channel.name),
      position: Math.max(0, Math.floor(channel.position)),
      archived: channel.archived === true,
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

  getChatSummaries(myAddress = ''): ReticulumGroupChatSummary[] {
    const groupIds = new Set(this.getKnownGroupIds());

    const summaries: ReticulumGroupChatSummary[] = [];
    for (const groupId of groupIds) {
      const channelIds = this.getSummaryChannelIds(groupId);
      const channelSummaries = channelIds
        .map((channelId) => this.getChannelSummary(groupId, channelId, myAddress))
        .filter((summary): summary is ReticulumChatSummary => !!summary);
      if (channelSummaries.length === 0) continue;
      const lastChannel = channelSummaries.reduce((latest, current) =>
        current.updatedAt > latest.updatedAt ? current : latest
      );
      const unreadCount = channelSummaries.reduce(
        (total, summary) => total + summary.unreadCount,
        0
      );
      const mentionCount = channelSummaries.reduce(
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
    for (const row of this.stmtGetKnownChannels.all(groupId) as Array<{ channel_id?: string }>) {
      channels.add(normalizeReticulumChatChannelId(row.channel_id));
    }
    for (const channel of this.getChannels(groupId, true)) {
      channels.add(channel.channelId);
    }
    for (const event of this.memoryEvents.values()) {
      if (event.groupId === groupId) channels.add(normalizeReticulumChatChannelId(event.channelId));
    }
    return [...channels];
  }

  private getChannelSummary(
    groupId: number,
    channelId: string,
    myAddress = ''
  ): ReticulumChatSummary | null {
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const recentEvents = this.getRecentEvents(groupId, 500, normalizedChannelId);
    const events = recentEvents.filter(
      (event) =>
        event.eventType === 'message' ||
        event.eventType === 'attachment_manifest'
    );
    const memoryLast = events[events.length - 1] ?? null;
    const row = this.stmtGetLastDisplayEvent.get(groupId, normalizedChannelId) as
      | EventRow
      | undefined;
    const sqliteLast = row ? rowToEvent(row) : null;
    const lastEvent =
      memoryLast && (!sqliteLast || memoryLast.timestamp >= sqliteLast.timestamp)
        ? memoryLast
        : sqliteLast;
    if (!lastEvent) return null;

    const watermark = this.getReadWatermark(groupId, normalizedChannelId, myAddress);
    const unreadRow = this.stmtCountUnreadDisplayEvents.get(
      groupId,
      normalizedChannelId,
      watermark,
      myAddress
    ) as { cnt?: number } | undefined;
    const unreadCount =
      typeof unreadRow?.cnt === 'number' && Number.isFinite(unreadRow.cnt)
        ? unreadRow.cnt
        : 0;
    let memoryUnreadCount = 0;
    if (myAddress) {
      for (const event of this.memoryEvents.values()) {
        if (
          event.groupId === groupId &&
          normalizeReticulumChatChannelId(event.channelId) === normalizedChannelId &&
          (event.eventType === 'message' ||
            event.eventType === 'attachment_manifest') &&
          event.timestamp > watermark &&
          event.authorAddress !== myAddress
        ) {
          memoryUnreadCount += 1;
        }
      }
    }
    const mentionRow = myAddress
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
    for (const event of effectiveMentionEvents.values()) {
      countEventMentionHash(event);
    }
    if (myAddress) {
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
      eventMentionHashCount
    );
    return {
      groupId,
      channelId: normalizedChannelId,
      lastEvent,
      unreadCount: Math.max(unreadCount, memoryUnreadCount),
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
        this.memoryMeta.delete(memoryCandidate[0]);
        this.memoryEvents.delete(memoryCandidate[0]);
        this.memorySearchText.delete(memoryCandidate[0]);
        this.memoryMentions.delete(memoryCandidate[0]);
        this.stmtDeleteSearchText.run(memoryCandidate[0]);
        this.stmtDeleteSearchMirror.run(memoryCandidate[0]);
        this.stmtDeleteMentionsForEvent.run(memoryCandidate[0]);
        this.stmtDeleteEvent.run(memoryCandidate[0]);
        continue;
      }
      const row = this.stmtEvictCandidate.get() as
        | { event_id?: string }
        | undefined;
      if (!row?.event_id) break;
      this.stmtDeleteSearchText.run(row.event_id);
      this.stmtDeleteSearchMirror.run(row.event_id);
      this.stmtDeleteMentionsForEvent.run(row.event_id);
      this.stmtDeleteEvent.run(row.event_id);
    }
  }

  private searchEventsMirror(
    terms: string[],
    allowedGroups: Set<number> | null,
    allowedChannels: Set<string> | null,
    limit: number
  ): ReticulumChatSearchResult[] {
    const firstTerm = terms[0];
    if (!firstTerm) return [];
    const rows = this.stmtSearchMirror.all(`%${firstTerm}%`, Math.max(limit * 20, 500)) as Array<{
      event_id: string;
      search_text: string;
    }>;
    const results: ReticulumChatSearchResult[] = [];
    for (const row of rows) {
      const lower = row.search_text.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      const event = this.getEvent(row.event_id);
      if (!event) continue;
      if (allowedGroups && !allowedGroups.has(event.groupId)) continue;
      if (
        allowedChannels &&
        !allowedChannels.has(normalizeReticulumChatChannelId(event.channelId))
      ) {
        continue;
      }
      results.push({
        event,
        snippet: buildPlainSnippet(row.search_text, terms),
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  private searchEventsMemory(
    terms: string[],
    allowedGroups: Set<number> | null,
    allowedChannels: Set<string> | null,
    limit: number
  ): ReticulumChatSearchResult[] {
    const results: ReticulumChatSearchResult[] = [];
    const events = [...this.memoryEvents.values()].sort(
      (a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId)
    );
    for (const event of events) {
      if (allowedGroups && !allowedGroups.has(event.groupId)) continue;
      if (
        allowedChannels &&
        !allowedChannels.has(normalizeReticulumChatChannelId(event.channelId))
      ) {
        continue;
      }
      const text =
        this.memorySearchText.get(event.eventId) ??
        searchTextFromPayload(event.encryptedPayload);
      const lower = text.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      results.push({ event, snippet: buildPlainSnippet(text, terms) });
      if (results.length >= limit) break;
    }
    return results;
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
        signature TEXT NOT NULL,
        own_event INTEGER NOT NULL DEFAULT 0,
        last_served_at INTEGER NOT NULL,
        stored_at INTEGER NOT NULL,
        accepted_at INTEGER NOT NULL,
        wire_bytes INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS reticulum_chat_author_seq_idx
        ON reticulum_chat_events (group_id, author_address, author_seq);
      CREATE INDEX IF NOT EXISTS reticulum_chat_group_time_idx
        ON reticulum_chat_events (group_id, channel_id, timestamp, author_seq);
      CREATE INDEX IF NOT EXISTS idx_reticulum_chat_events_feed
        ON reticulum_chat_events (group_id, channel_id, feed_timestamp, event_id);
      CREATE INDEX IF NOT EXISTS idx_reticulum_chat_events_author_seq
        ON reticulum_chat_events (group_id, author_address, author_seq);
      CREATE INDEX IF NOT EXISTS reticulum_chat_cache_idx
        ON reticulum_chat_events (own_event, last_served_at, timestamp);
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
}
