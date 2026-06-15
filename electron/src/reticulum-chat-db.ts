import Database, { type Database as DB, type Statement } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { ReticulumChatEvent } from './reticulum-chat';

export const RETICULUM_CHAT_CACHE_MAX_BYTES = 50 * 1024 * 1024;

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
  private stmtGetMissingByAuthor: Statement;
  private stmtGetGroupSeqs: Statement;
  private stmtMarkServed: Statement;
  private stmtTotalCacheBytes: Statement;
  private stmtEvictCandidate: Statement;
  private stmtDeleteEvent: Statement;

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
    `);
  }
}
