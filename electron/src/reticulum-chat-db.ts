import Database, { type Database as DB, type Statement } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { ReticulumChatEvent } from './reticulum-chat';

export const RETICULUM_CHAT_CACHE_MAX_BYTES = 50 * 1024 * 1024;

export type ReticulumChatAuthorHead = {
  authorAddress: string;
  maxSeq: number;
  eventId: string;
  timestamp: number;
};

export type ReticulumChatSummary = {
  groupId: number;
  lastEvent: ReticulumChatEvent | null;
  unreadCount: number;
  updatedAt: number;
};

export type ReticulumChatSearchResult = {
  event: ReticulumChatEvent;
  snippet: string;
};

type EventRow = {
  event_id: string;
  group_id: number;
  author_address: string;
  author_public_key: string;
  author_seq: number;
  timestamp: number;
  event_type: string;
  target_event_id: string | null;
  reply_to_event_id: string | null;
  encrypted_payload: string;
  payload_hash: string;
  signature: string;
  own_event: number;
  last_served_at: number;
  stored_at: number;
  wire_bytes: number;
};

function rowToEvent(row: EventRow): ReticulumChatEvent {
  return {
    eventId: row.event_id,
    groupId: row.group_id,
    authorAddress: row.author_address,
    authorPublicKey: row.author_public_key,
    authorSeq: row.author_seq,
    timestamp: row.timestamp,
    eventType: row.event_type as ReticulumChatEvent['eventType'],
    ...(row.target_event_id ? { targetEventId: row.target_event_id } : {}),
    ...(row.reply_to_event_id ? { replyToEventId: row.reply_to_event_id } : {}),
    encryptedPayload: row.encrypted_payload,
    payloadHash: row.payload_hash,
    signature: row.signature,
  };
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
  for (const key of [
    'message',
    'messageText',
    'text',
    'content',
    'filename',
    'fileName',
    'mimeType',
  ]) {
    if (key in record) collectSearchStrings(record[key], out);
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

function buildFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((term) => term.trim().replace(/"/g, ''))
    .filter((term) => term.length >= 2)
    .slice(0, 12)
    .map((term) => `"${term}"*`)
    .join(' AND ');
}

export class ReticulumChatDatabase {
  private db: DB;
  private memoryEvents = new Map<string, ReticulumChatEvent>();
  private memoryMeta = new Map<
    string,
    { ownEvent: boolean; lastServedAt: number; storedAt: number; wireBytes: number }
  >();
  private stmtInsertEvent: Statement;
  private stmtGetEvent: Statement;
  private stmtHasEvent: Statement;
  private stmtGetRecentEvents: Statement;
  private stmtGetEventsAfter: Statement;
  private stmtGetEventsAfterCursor: Statement;
  private stmtGetEventsBefore: Statement;
  private stmtGetEventsBeforeCursor: Statement;
  private stmtGetAuthorMaxSeq: Statement;
  private stmtGetAuthorEventsAfter: Statement;
  private stmtGetAuthorHeads: Statement;
  private stmtGetMissingByAuthor: Statement;
  private stmtGetGroupSeqs: Statement;
  private stmtGetKnownGroups: Statement;
  private stmtGetLastDisplayEvent: Statement;
  private stmtCountUnreadDisplayEvents: Statement;
  private stmtGetWatermark: Statement;
  private stmtUpsertWatermark: Statement;
  private stmtMarkServed: Statement;
  private stmtTotalCacheBytes: Statement;
  private stmtEvictCandidate: Statement;
  private stmtDeleteEvent: Statement;
  private stmtUpsertSearchText: Statement;
  private stmtDeleteSearchText: Statement;
  private stmtSearchEvents: Statement;
  private stmtSearchEventsForGroups: Statement;

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
         timestamp, event_type, target_event_id, reply_to_event_id,
         encrypted_payload, payload_hash, signature, own_event,
         last_served_at, stored_at, wire_bytes)
      VALUES
        (@event_id, @group_id, @author_address, @author_public_key, @author_seq,
         @timestamp, @event_type, @target_event_id, @reply_to_event_id,
         @encrypted_payload, @payload_hash, @signature, @own_event,
         @last_served_at, @stored_at, @wire_bytes)
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
        WHERE group_id = ?
        ORDER BY timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY timestamp ASC, event_id ASC
    `);
    this.stmtGetEventsAfter = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND timestamp >= ?
      ORDER BY timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetEventsAfterCursor = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND (timestamp > ? OR (timestamp = ? AND event_id > ?))
      ORDER BY timestamp ASC, event_id ASC
      LIMIT ?
    `);
    this.stmtGetEventsBefore = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ? AND timestamp < ?
        ORDER BY timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY timestamp ASC, event_id ASC
    `);
    this.stmtGetEventsBeforeCursor = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM reticulum_chat_events
        WHERE group_id = ? AND (timestamp < ? OR (timestamp = ? AND event_id < ?))
        ORDER BY timestamp DESC, event_id DESC
        LIMIT ?
      )
      ORDER BY timestamp ASC, event_id ASC
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
    this.stmtGetLastDisplayEvent = this.db.prepare(`
      SELECT * FROM reticulum_chat_events
      WHERE group_id = ? AND event_type IN ('message', 'attachment_manifest')
      ORDER BY timestamp DESC, event_id DESC
      LIMIT 1
    `);
    this.stmtCountUnreadDisplayEvents = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM reticulum_chat_events
      WHERE group_id = ?
        AND event_type IN ('message', 'attachment_manifest')
        AND timestamp > ?
        AND author_address != ?
    `);
    this.stmtGetWatermark = this.db.prepare(
      'SELECT timestamp FROM reticulum_chat_read_watermarks WHERE group_id = ?'
    );
    this.stmtUpsertWatermark = this.db.prepare(`
      INSERT INTO reticulum_chat_read_watermarks (group_id, timestamp)
      VALUES (?, ?)
      ON CONFLICT(group_id) DO UPDATE SET timestamp = excluded.timestamp
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
    this.stmtUpsertSearchText = this.db.prepare(`
      INSERT INTO reticulum_chat_search_fts
        (event_id, group_id, author_address, timestamp, event_type, search_text)
      VALUES (?, ?, ?, ?, ?, ?)
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
    this.stmtSearchEventsForGroups = this.db.prepare(`
      SELECT event_id,
             snippet(reticulum_chat_search_fts, 5, '<mark>', '</mark>', '...', 12) AS snippet
      FROM reticulum_chat_search_fts
      WHERE reticulum_chat_search_fts MATCH ?
        AND group_id IN (
          SELECT CAST(value AS INTEGER) FROM json_each(?)
        )
      ORDER BY rank
      LIMIT ?
    `);
  }

  close(): void {
    this.db.close();
  }

  insertEvent(event: ReticulumChatEvent, ownEvent: boolean): boolean {
    const existed = this.hasEvent(event.eventId);
    const now = Date.now();
    this.stmtInsertEvent.run({
      event_id: event.eventId,
      group_id: event.groupId,
      author_address: event.authorAddress,
      author_public_key: event.authorPublicKey,
      author_seq: event.authorSeq,
      timestamp: event.timestamp,
      event_type: event.eventType,
      target_event_id: event.targetEventId ?? null,
      reply_to_event_id: event.replyToEventId ?? null,
      encrypted_payload: event.encryptedPayload,
      payload_hash: event.payloadHash,
      signature: event.signature,
      own_event: ownEvent ? 1 : 0,
      last_served_at: now,
      stored_at: now,
      wire_bytes: eventWireBytes(event),
    });
    if (!existed) {
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
    return !existed;
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
    if (replaceExisting) this.stmtDeleteSearchText.run(event.eventId);
    this.stmtUpsertSearchText.run(
      event.eventId,
      event.groupId,
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

  searchEvents(
    query: string,
    options: { groupIds?: number[]; limit?: number } = {}
  ): ReticulumChatSearchResult[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
    const groupIds = (options.groupIds ?? [])
      .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
      .slice(0, 500);
    const rows = groupIds.length > 0
      ? (this.stmtSearchEventsForGroups.all(
          ftsQuery,
          JSON.stringify(groupIds),
          limit
        ) as Array<{ event_id: string; snippet?: string }>)
      : (this.stmtSearchEvents.all(ftsQuery, limit) as Array<{
          event_id: string;
          snippet?: string;
        }>);
    const results: ReticulumChatSearchResult[] = [];
    for (const row of rows) {
      const event = this.getEvent(row.event_id);
      if (!event) continue;
      results.push({ event, snippet: row.snippet ?? '' });
    }
    return results;
  }

  getRecentEvents(groupId: number, limit: number): ReticulumChatEvent[] {
    return this.mergeWindowEvents(
      (this.stmtGetRecentEvents.all(groupId, limit) as EventRow[]).map(rowToEvent),
      [...this.memoryEvents.values()]
        .filter((event) => event.groupId === groupId)
        .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
        .slice(0, limit),
      limit
    );
  }

  getEventsAfter(
    groupId: number,
    afterTimestamp: number,
    limit: number,
    afterEventId?: string
  ): ReticulumChatEvent[] {
    const sqliteRows = afterEventId
      ? (this.stmtGetEventsAfterCursor.all(
          groupId,
          afterTimestamp,
          afterTimestamp,
          afterEventId,
          limit
        ) as EventRow[])
      : (this.stmtGetEventsAfter.all(groupId, afterTimestamp, limit) as EventRow[]);
    return this.mergeWindowEvents(
      sqliteRows.map(rowToEvent),
      [...this.memoryEvents.values()]
        .filter((event) => {
          if (event.groupId !== groupId) return false;
          if (!afterEventId) return event.timestamp >= afterTimestamp;
          return event.timestamp > afterTimestamp ||
            (event.timestamp === afterTimestamp && event.eventId > afterEventId);
        })
        .sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId))
        .slice(0, limit),
      limit
    );
  }

  getEventsBefore(
    groupId: number,
    beforeTimestamp: number,
    limit: number,
    beforeEventId?: string
  ): ReticulumChatEvent[] {
    const sqliteRows = beforeEventId
      ? (this.stmtGetEventsBeforeCursor.all(
          groupId,
          beforeTimestamp,
          beforeTimestamp,
          beforeEventId,
          limit
        ) as EventRow[])
      : (this.stmtGetEventsBefore.all(groupId, beforeTimestamp, limit) as EventRow[]);
    return this.mergeWindowEvents(
      sqliteRows.map(rowToEvent),
      [...this.memoryEvents.values()]
        .filter((event) => {
          if (event.groupId !== groupId) return false;
          if (!beforeEventId) return event.timestamp < beforeTimestamp;
          return event.timestamp < beforeTimestamp ||
            (event.timestamp === beforeTimestamp && event.eventId < beforeEventId);
        })
        .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
        .slice(0, limit),
      limit
    );
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

  getChatSummaries(myAddress = ''): ReticulumChatSummary[] {
    const rows = this.stmtGetKnownGroups.all() as Array<{ group_id: number }>;
    const groupIds = new Set(rows.map((row) => row.group_id));
    for (const event of this.memoryEvents.values()) {
      groupIds.add(event.groupId);
    }

    const summaries: ReticulumChatSummary[] = [];
    for (const groupId of groupIds) {
      const events = this.getRecentEvents(groupId, 500).filter(
        (event) =>
          event.eventType === 'message' ||
          event.eventType === 'attachment_manifest'
      );
      const memoryLast = events[events.length - 1] ?? null;
      const row = this.stmtGetLastDisplayEvent.get(groupId) as
        | EventRow
        | undefined;
      const sqliteLast = row ? rowToEvent(row) : null;
      const lastEvent =
        memoryLast && (!sqliteLast || memoryLast.timestamp >= sqliteLast.timestamp)
          ? memoryLast
          : sqliteLast;
      if (!lastEvent) continue;

      const watermark = this.getReadWatermark(groupId);
      const unreadRow = this.stmtCountUnreadDisplayEvents.get(
        groupId,
        watermark,
        myAddress
      ) as { cnt?: number } | undefined;
      let unreadCount =
        typeof unreadRow?.cnt === 'number' && Number.isFinite(unreadRow.cnt)
          ? unreadRow.cnt
          : 0;

      summaries.push({
        groupId,
        lastEvent,
        unreadCount,
        updatedAt: lastEvent.timestamp,
      });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  markRead(groupId: number, upToTimestamp: number): void {
    const timestamp = Number(upToTimestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return;
    const current = this.getReadWatermark(groupId);
    if (timestamp <= current) return;
    this.stmtUpsertWatermark.run(groupId, timestamp);
  }

  getReadWatermark(groupId: number): number {
    const row = this.stmtGetWatermark.get(groupId) as
      | { timestamp?: number }
      | undefined;
    return typeof row?.timestamp === 'number' && Number.isFinite(row.timestamp)
      ? row.timestamp
      : 0;
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
        this.stmtDeleteEvent.run(memoryCandidate[0]);
        continue;
      }
      const row = this.stmtEvictCandidate.get() as
        | { event_id?: string }
        | undefined;
      if (!row?.event_id) break;
      this.stmtDeleteEvent.run(row.event_id);
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reticulum_chat_events (
        event_id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        author_address TEXT NOT NULL,
        author_public_key TEXT NOT NULL,
        author_seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        target_event_id TEXT,
        reply_to_event_id TEXT,
        encrypted_payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        signature TEXT NOT NULL,
        own_event INTEGER NOT NULL DEFAULT 0,
        last_served_at INTEGER NOT NULL,
        stored_at INTEGER NOT NULL,
        wire_bytes INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS reticulum_chat_author_seq_idx
        ON reticulum_chat_events (group_id, author_address, author_seq);
      CREATE INDEX IF NOT EXISTS reticulum_chat_group_time_idx
        ON reticulum_chat_events (group_id, timestamp, author_seq);
      CREATE INDEX IF NOT EXISTS reticulum_chat_cache_idx
        ON reticulum_chat_events (own_event, last_served_at, timestamp);
      CREATE TABLE IF NOT EXISTS reticulum_chat_read_watermarks (
        group_id INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL
      );
    `);
  }
}
