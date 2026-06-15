type ReticulumChatRow = Record<string, any>;

const storesByPath = new Map<string, { reticulumChatEvents: ReticulumChatRow[] }>();

class Statement {
  constructor(
    private readonly sql: string,
    private readonly store: { reticulumChatEvents: ReticulumChatRow[] }
  ) {}

  all(...args: any[]) {
    if (this.sql.includes('FROM reticulum_chat_events')) {
      if (this.sql.includes('WHERE group_id = ? AND author_address = ? AND author_seq > ?')) {
        const [groupId, authorAddress, seq, limit] = args;
        return this.store.reticulumChatEvents
          .filter(
            (row) =>
              row.group_id === groupId &&
              row.author_address === authorAddress &&
              row.author_seq > seq
          )
          .sort((a, b) => a.author_seq - b.author_seq)
          .slice(0, limit);
      }
      if (this.sql.includes('GROUP BY author_address')) {
        const [groupId] = args;
        const byAuthor = new Map<string, number>();
        for (const row of this.store.reticulumChatEvents) {
          if (row.group_id !== groupId) continue;
          byAuthor.set(
            row.author_address,
            Math.max(byAuthor.get(row.author_address) ?? 0, row.author_seq)
          );
        }
        return [...byAuthor.entries()].map(([author_address, seq]) => ({
          author_address,
          seq,
        }));
      }
      if (this.sql.includes('timestamp > ? OR (timestamp = ? AND event_id > ?)')) {
        const [groupId, timestamp, _sameTimestamp, eventId, limit] = args;
        return this.store.reticulumChatEvents
          .filter((row) => {
            if (row.group_id !== groupId) return false;
            if (row.timestamp > timestamp) return true;
            return row.timestamp === timestamp && String(row.event_id) > String(eventId);
          })
          .sort(
            (a, b) =>
              a.timestamp - b.timestamp ||
              String(a.event_id).localeCompare(String(b.event_id))
          )
          .slice(0, limit);
      }
      if (this.sql.includes('timestamp >= ?')) {
        const [groupId, timestamp, limit] = args;
        return this.store.reticulumChatEvents
          .filter((row) => row.group_id === groupId && row.timestamp >= timestamp)
          .sort(
            (a, b) =>
              a.timestamp - b.timestamp ||
              String(a.event_id).localeCompare(String(b.event_id))
          )
          .slice(0, limit);
      }
      if (this.sql.includes('timestamp < ?')) {
        const [groupId, timestamp, limit] = args;
        return this.store.reticulumChatEvents
          .filter((row) => row.group_id === groupId && row.timestamp < timestamp)
          .sort(
            (a, b) =>
              b.timestamp - a.timestamp ||
              String(b.event_id).localeCompare(String(a.event_id))
          )
          .slice(0, limit)
          .sort(
            (a, b) =>
              a.timestamp - b.timestamp ||
              String(a.event_id).localeCompare(String(b.event_id))
          );
      }
      if (this.sql.includes('WHERE group_id = ?')) {
        const [groupId, limit] = args;
        return this.store.reticulumChatEvents
          .filter((row) => row.group_id === groupId)
          .sort(
            (a, b) =>
              b.timestamp - a.timestamp ||
              String(b.event_id).localeCompare(String(a.event_id))
          )
          .slice(0, limit)
          .sort(
            (a, b) =>
              a.timestamp - b.timestamp ||
              String(a.event_id).localeCompare(String(b.event_id))
          );
      }
    }
    return [];
  }

  get(...args: any[]) {
    if (this.sql.includes('FROM reticulum_chat_events')) {
      if (this.sql.includes('WHERE event_id = ?')) {
        const [eventId] = args;
        const row = this.store.reticulumChatEvents.find(
          (item) => item.event_id === eventId
        );
        if (!row) return undefined;
        return this.sql.includes('SELECT 1') ? { 1: 1 } : row;
      }
      if (this.sql.includes('SUM(wire_bytes)')) {
        return {
          total: this.store.reticulumChatEvents
            .filter((row) => row.own_event === 0)
            .reduce((sum, row) => sum + row.wire_bytes, 0),
        };
      }
      if (this.sql.includes('WHERE own_event = 0')) {
        return this.store.reticulumChatEvents
          .filter((row) => row.own_event === 0)
          .sort(
            (a, b) =>
              a.last_served_at - b.last_served_at ||
              a.timestamp - b.timestamp ||
              a.stored_at - b.stored_at
          )
          .map((row) => ({ event_id: row.event_id }))[0];
      }
    }
    return undefined;
  }

  run(params?: any, second?: any) {
    if (this.sql.includes('INSERT OR IGNORE INTO reticulum_chat_events')) {
      if (
        this.store.reticulumChatEvents.some(
          (row) =>
            row.event_id === params.event_id ||
            (row.group_id === params.group_id &&
              row.author_address === params.author_address &&
              row.author_seq === params.author_seq)
        )
      ) {
        return { changes: 0, lastInsertRowid: 0 };
      }
      this.store.reticulumChatEvents.push({ ...params });
      return { changes: 1, lastInsertRowid: this.store.reticulumChatEvents.length };
    }
    if (this.sql.includes('UPDATE reticulum_chat_events SET last_served_at = ?')) {
      const [lastServedAt, eventId] = [params, second];
      const row = this.store.reticulumChatEvents.find(
        (item) => item.event_id === eventId
      );
      if (row) row.last_served_at = lastServedAt;
      return { changes: row ? 1 : 0, lastInsertRowid: 0 };
    }
    if (this.sql.includes('DELETE FROM reticulum_chat_events WHERE event_id = ?')) {
      const before = this.store.reticulumChatEvents.length;
      this.store.reticulumChatEvents = this.store.reticulumChatEvents.filter(
        (row) => row.event_id !== params
      );
      return {
        changes: before - this.store.reticulumChatEvents.length,
        lastInsertRowid: 0,
      };
    }
    return { changes: 0, lastInsertRowid: 0 };
  }
}

class MockDatabase {
  private readonly store: { reticulumChatEvents: ReticulumChatRow[] };

  constructor(dbPath = ':memory:') {
    const key = String(dbPath);
    const store = storesByPath.get(key) ?? { reticulumChatEvents: [] };
    storesByPath.set(key, store);
    this.store = store;
  }

  close() {
    return undefined;
  }

  exec() {
    return undefined;
  }

  prepare(sql = '') {
    return new Statement(String(sql), this.store);
  }

  pragma() {
    return undefined;
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: Parameters<T>) => fn(...args)) as T;
  }
}

export default MockDatabase;
export type Database = InstanceType<typeof MockDatabase>;
