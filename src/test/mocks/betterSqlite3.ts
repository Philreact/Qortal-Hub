type ReticulumChatRow = Record<string, any>;
type ReticulumResourceRow = Record<string, any>;
type ReticulumResourceChunkRow = Record<string, any>;

type MockStore = {
  reticulumChatEvents: ReticulumChatRow[];
  reticulumChatEventHeaders: ReticulumChatRow[];
  reticulumChatMessages: ReticulumChatRow[];
  reticulumChatExpiredEventMarkers: ReticulumChatRow[];
  reticulumChatMetadataSnapshots: ReticulumChatRow[];
  reticulumChatMetadataEntityRevisions: ReticulumChatRow[];
  reticulumChatAuthorStreams: Map<string, string>;
  reticulumChatAuthorSequenceLeases: ReticulumChatRow[];
  reticulumResources: ReticulumResourceRow[];
  reticulumResourceChunks: ReticulumResourceChunkRow[];
  schema: Map<string, Set<string>>;
};

const storesByPath = new Map<string, MockStore>();

class Statement {
  constructor(
    private readonly sql: string,
    private readonly store: MockStore
  ) {}

  all(...args: any[]) {
    const pragmaMatch = this.sql.match(/PRAGMA\s+table_info\(([^)]+)\)/i);
    if (pragmaMatch) {
      const tableName = pragmaMatch[1]?.trim().replace(/^["'`]|["'`]$/g, '') ?? '';
      return [...(this.store.schema.get(tableName) ?? new Set<string>())].map(
        (name, cid) => ({ cid, name })
      );
    }
    if (this.sql.includes('FROM rchat_author_sequence_leases')) {
      if (this.sql.includes('SELECT DISTINCT owner_id, owner_pid')) {
        const owners = new Map<string, number>();
        for (const row of this.store.reticulumChatAuthorSequenceLeases) {
          owners.set(row.owner_id, row.owner_pid);
        }
        return [...owners].map(([owner_id, owner_pid]) => ({ owner_id, owner_pid }));
      }
      return [...this.store.reticulumChatAuthorSequenceLeases];
    }
    if (this.sql.includes('FROM rchat_event_headers')) {
      const [groupId, _sameGroupId, limit, offset = 0] = args;
      const knownRows = [
        ...this.store.reticulumChatEventHeaders,
        ...this.store.reticulumChatExpiredEventMarkers,
      ].filter((row) => row.group_id === groupId);
      if (this.sql.includes('previous_seq + 1 AS from_seq')) {
        const rowsByAuthor = new Map<string, ReticulumChatRow[]>();
        for (const row of knownRows) {
          const key = `${row.author_address}:${row.author_stream_id || ''}`;
          const rows = rowsByAuthor.get(key) ?? [];
          rows.push(row);
          rowsByAuthor.set(key, rows);
        }
        const gaps: ReticulumChatRow[] = [];
        for (const rows of rowsByAuthor.values()) {
          rows.sort((a, b) => Number(a.author_seq) - Number(b.author_seq));
          for (let index = 1; index < rows.length; index += 1) {
            const previousSeq = Number(rows[index - 1].author_seq);
            const authorSeq = Number(rows[index].author_seq);
            if (authorSeq <= previousSeq + 1) continue;
            gaps.push({
              author_address: rows[index].author_address,
              author_stream_id: rows[index].author_stream_id || '',
              from_seq: previousSeq + 1,
              to_seq: authorSeq - 1,
            });
          }
        }
        return gaps
          .sort(
            (a, b) =>
              Number(b.to_seq) - Number(a.to_seq) ||
              String(a.author_address).localeCompare(String(b.author_address)) ||
              Number(b.from_seq) - Number(a.from_seq)
          )
          .slice(0, Number(limit) || undefined);
      }
      if (this.sql.includes('author_seq >= ?') && this.sql.includes('author_seq <= ?')) {
        const [rangeGroupId, authorAddress, authorStreamId, fromSeq, toSeq] = args;
        return this.store.reticulumChatEventHeaders
          .filter(
            (row) =>
              row.group_id === rangeGroupId &&
              row.author_address === authorAddress &&
              String(row.author_stream_id || '') === String(authorStreamId || '') &&
              Number(row.author_seq) >= Number(fromSeq) &&
              Number(row.author_seq) <= Number(toSeq)
          )
          .sort((a, b) => Number(a.author_seq) - Number(b.author_seq))
          .map((row) => ({ author_seq: row.author_seq }));
      }
      const byAuthor = new Map<string, ReticulumChatRow>();
      for (const row of knownRows) {
        const key = `${row.author_address}:${row.author_stream_id || ''}`;
        const existing = byAuthor.get(key);
        if (
          existing &&
          (Number(existing.author_seq) > Number(row.author_seq) ||
            (Number(existing.author_seq) === Number(row.author_seq) &&
              (Number(existing.timestamp) > Number(row.timestamp) ||
                (Number(existing.timestamp) === Number(row.timestamp) &&
                  String(existing.event_id) >= String(row.event_id)))))
        ) {
          continue;
        }
        byAuthor.set(key, row);
      }
      if (this.sql.includes('e.author_seq AS max_seq')) {
        return [...byAuthor.values()]
          .sort(
            (a, b) =>
              Number(b.timestamp) - Number(a.timestamp) ||
              String(b.event_id).localeCompare(String(a.event_id))
          )
          .slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || Infinity))
          .map((row) => ({
            author_address: row.author_address,
            author_stream_id: row.author_stream_id || '',
            max_seq: row.author_seq,
            event_id: row.event_id,
            timestamp: row.timestamp,
          }));
      }
      if (this.sql.includes('GROUP BY author_address')) {
        const sequenceField = this.sql.includes('AS seq') ? 'seq' : 'max_seq';
        return [...byAuthor.values()]
          .sort(
            (a, b) =>
              String(a.author_address).localeCompare(String(b.author_address)) ||
              String(a.author_stream_id || '').localeCompare(
                String(b.author_stream_id || '')
              )
          )
          .map((row) => ({
            author_address: row.author_address,
            author_stream_id: row.author_stream_id || '',
            [sequenceField]: row.author_seq,
          }));
      }
      return [...this.store.reticulumChatEventHeaders];
    }
    if (this.sql.includes('FROM rchat_metadata_snapshots')) {
      const [groupId, scope] = args;
      return this.store.reticulumChatMetadataSnapshots
        .filter((row) => row.group_id === groupId && (scope == null || row.scope === scope))
        .sort(
          (a, b) =>
            b.version - a.version ||
            b.created_at - a.created_at ||
            String(b.snapshot_hash).localeCompare(String(a.snapshot_hash))
        );
    }
    if (this.sql.includes('FROM rchat_metadata_entity_revisions')) {
      const [groupId] = args;
      return this.store.reticulumChatMetadataEntityRevisions
        .filter((row) => row.group_id === groupId)
        .sort(
          (a, b) =>
            String(a.entity_type).localeCompare(String(b.entity_type)) ||
            String(a.entity_id).localeCompare(String(b.entity_id))
        );
    }
    if (this.sql.includes('FROM rchat_message_projection')) {
      if (this.sql.includes('WHERE group_id = ? AND channel_id = ?')) {
        const [groupId, channelId, limit] = args;
        return this.store.reticulumChatMessages
          .filter(
            (row) =>
              row.group_id === groupId &&
              row.channel_id === channelId &&
              row.deleted_at == null
          )
          .sort(
            (a, b) =>
              b.created_at - a.created_at ||
              String(b.root_event_id).localeCompare(String(a.root_event_id))
          )
          .slice(0, limit)
          .sort(
            (a, b) =>
              a.created_at - b.created_at ||
              String(a.root_event_id).localeCompare(String(b.root_event_id))
          );
      }
      if (this.sql.includes('WHERE group_id = ? AND deleted_at IS NULL')) {
        const [groupId, limit] = args;
        return this.store.reticulumChatMessages
          .filter((row) => row.group_id === groupId && row.deleted_at == null)
          .sort(
            (a, b) =>
              b.created_at - a.created_at ||
              String(b.root_event_id).localeCompare(String(a.root_event_id))
          )
          .slice(0, limit)
          .sort(
            (a, b) =>
              a.created_at - b.created_at ||
              String(a.root_event_id).localeCompare(String(b.root_event_id))
          );
      }
    }
    if (this.sql.includes('FROM rchat_expired_event_markers')) {
      if (this.sql.includes('GROUP BY author_address')) {
        const [groupId] = args;
        const byAuthor = new Map<string, number>();
        for (const row of this.store.reticulumChatExpiredEventMarkers) {
          if (row.group_id !== groupId) continue;
          const key = `${row.author_address}:${row.author_stream_id || ''}`;
          byAuthor.set(key, Math.max(byAuthor.get(key) ?? 0, row.author_seq));
        }
        return [...byAuthor.entries()].map(([key, seq]) => {
          const separator = key.lastIndexOf(':');
          return {
            author_address: key.slice(0, separator),
            author_stream_id: key.slice(separator + 1),
            seq,
          };
        });
      }
      return this.store.reticulumChatExpiredEventMarkers;
    }
    if (this.sql.includes('FROM reticulum_resource_chunks')) {
      const [fileHash] = args;
      return this.store.reticulumResourceChunks
        .filter((row) => row.file_hash === fileHash)
        .sort((a, b) => a.chunk_index - b.chunk_index);
    }
    if (this.sql.includes('FROM reticulum_chat_events')) {
      if (this.sql.includes('WHERE event_id = ? OR target_event_id = ?')) {
        const [eventId, targetEventId] = args;
        return this.store.reticulumChatEvents
          .filter(
            (row) =>
              row.event_id === eventId || row.target_event_id === targetEventId
          )
          .sort(
            (a, b) =>
              (a.feed_timestamp ?? a.timestamp) - (b.feed_timestamp ?? b.timestamp) ||
              String(a.event_id).localeCompare(String(b.event_id))
          );
      }
      if (this.sql.includes('WHERE group_id = ? AND author_address = ? AND author_stream_id = ? AND author_seq > ?')) {
        const [groupId, authorAddress, authorStreamId, seq, limit] = args;
        return this.store.reticulumChatEvents
          .filter(
            (row) =>
              row.group_id === groupId &&
              row.author_address === authorAddress &&
              String(row.author_stream_id || '') === authorStreamId &&
              row.author_seq > seq
          )
          .sort((a, b) => a.author_seq - b.author_seq)
          .slice(0, limit);
      }
      if (this.sql.includes('e.author_seq AS max_seq')) {
        const [groupId, _sameGroupId, limit] = args;
        const byAuthor = new Map<string, any>();
        for (const row of [
          ...this.store.reticulumChatEvents,
          ...this.store.reticulumChatExpiredEventMarkers,
        ]) {
          if (row.group_id !== groupId) continue;
          const key = `${row.author_address}:${row.author_stream_id || ''}`;
          const existing = byAuthor.get(key);
          if (existing && existing.author_seq >= row.author_seq) continue;
          byAuthor.set(key, row);
        }
        return [...byAuthor.values()]
          .sort(
            (a, b) =>
              b.timestamp - a.timestamp ||
              String(b.event_id).localeCompare(String(a.event_id))
          )
          .slice(0, limit)
          .map((row) => ({
            author_address: row.author_address,
            author_stream_id: row.author_stream_id || '',
            max_seq: row.author_seq,
            event_id: row.event_id,
            timestamp: row.timestamp,
          }));
      }
      if (this.sql.includes('author_seq > ?')) {
        const [groupId, authorAddress, afterSeq, limit] = args;
        return this.store.reticulumChatEvents
          .filter(
            (row) =>
              row.group_id === groupId &&
              row.author_address === authorAddress &&
              row.author_seq > afterSeq
          )
          .sort(
            (a, b) =>
              a.author_seq - b.author_seq ||
              a.timestamp - b.timestamp ||
              String(a.event_id).localeCompare(String(b.event_id))
          )
          .slice(0, limit);
      }
      if (this.sql.includes('GROUP BY author_address')) {
        const [groupId] = args;
        const byAuthor = new Map<string, number>();
        for (const row of [
          ...this.store.reticulumChatEvents,
          ...this.store.reticulumChatExpiredEventMarkers,
        ]) {
          if (row.group_id !== groupId) continue;
          const key = `${row.author_address}:${row.author_stream_id || ''}`;
          byAuthor.set(key, Math.max(byAuthor.get(key) ?? 0, row.author_seq));
        }
        return [...byAuthor.entries()].map(([key, seq]) => {
          const separator = key.lastIndexOf(':');
          return {
            author_address: key.slice(0, separator),
            author_stream_id: key.slice(separator + 1),
            seq,
          };
        });
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
        const hasCursor = this.sql.includes('event_id < ?');
        const [groupId, timestamp, _sameTimestampOrLimit, eventIdOrUndefined, maybeLimit] = args;
        const eventId = hasCursor ? String(eventIdOrUndefined) : '';
        const limit = hasCursor ? maybeLimit : _sameTimestampOrLimit;
        return this.store.reticulumChatEvents
          .filter((row) => {
            if (row.group_id !== groupId) return false;
            if (!hasCursor) return row.timestamp < timestamp;
            if (row.timestamp < timestamp) return true;
            return row.timestamp === timestamp && String(row.event_id) < eventId;
          })
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
    if (this.sql.includes('SELECT author_seq FROM rchat_author_sequence_leases')) {
      const [groupId, authorAddress, authorStreamId, ownerId] = args;
      return this.store.reticulumChatAuthorSequenceLeases.find(
        (row) =>
          row.group_id === groupId &&
          row.author_address === authorAddress &&
          row.author_stream_id === authorStreamId &&
          (!this.sql.includes('owner_id = ?') || row.owner_id === ownerId)
      );
    }
    if (this.sql.includes('COALESCE(MAX(author_seq), 0) AS max_seq')) {
      const [groupId, authorAddress, authorStreamId] = args;
      const rows = this.sql.includes('FROM rchat_event_headers')
        ? this.store.reticulumChatEventHeaders
        : this.sql.includes('FROM rchat_author_sequence_leases')
          ? this.store.reticulumChatAuthorSequenceLeases
          : this.store.reticulumChatExpiredEventMarkers;
      return {
        max_seq: rows
          .filter(
            (row) =>
              row.group_id === groupId &&
              row.author_address === authorAddress &&
              row.author_stream_id === authorStreamId
          )
          .reduce((max, row) => Math.max(max, Number(row.author_seq) || 0), 0),
      };
    }
    if (
      this.sql.includes('SELECT MAX(author_seq) AS seq') &&
      this.sql.includes('FROM rchat_event_headers')
    ) {
      const [groupId, authorAddress, authorStreamId] = args;
      const seq = [
        ...this.store.reticulumChatEventHeaders,
        ...this.store.reticulumChatExpiredEventMarkers,
      ]
        .filter(
          (row) =>
            row.group_id === groupId &&
            row.author_address === authorAddress &&
            String(row.author_stream_id || '') === String(authorStreamId || '')
        )
        .reduce((max, row) => Math.max(max, Number(row.author_seq) || 0), 0);
      return { seq };
    }
    if (this.sql.includes('SELECT stream_id FROM rchat_author_streams')) {
      const streamId = this.store.reticulumChatAuthorStreams.get(String(args[0] || ''));
      return streamId ? { stream_id: streamId } : undefined;
    }
    if (this.sql.includes('FROM rchat_metadata_snapshots')) {
      const [groupId, value] = args;
      return this.store.reticulumChatMetadataSnapshots
        .filter((row) => {
          if (row.group_id !== groupId) return false;
          if (this.sql.includes('snapshot_hash = ?')) return row.snapshot_hash === value;
          if (this.sql.includes('scope = ?')) return row.scope === value;
          return true;
        })
        .sort(
          (a, b) =>
            b.version - a.version ||
            b.created_at - a.created_at ||
            String(b.snapshot_hash).localeCompare(String(a.snapshot_hash))
        )[0];
    }
    if (this.sql.includes('FROM rchat_metadata_entity_revisions')) {
      const [groupId, entityType, entityId] = args;
      return this.store.reticulumChatMetadataEntityRevisions.find(
        (row) =>
          row.group_id === groupId &&
          row.entity_type === entityType &&
          row.entity_id === entityId
      );
    }
    if (this.sql.includes('FROM rchat_message_projection')) {
      if (this.sql.includes('COUNT(*) AS cnt')) {
        return { cnt: this.store.reticulumChatMessages.length };
      }
    }
    if (this.sql.includes('FROM reticulum_resources')) {
      const [fileHash] = args;
      return this.store.reticulumResources.find((row) => row.file_hash === fileHash);
    }
    if (this.sql.includes('FROM reticulum_resource_chunks')) {
      if (this.sql.includes('COUNT(*) AS count')) {
        const [fileHash] = args;
        return {
          count: this.store.reticulumResourceChunks.filter(
            (row) => row.file_hash === fileHash && row.status !== 'complete'
          ).length,
        };
      }
      const [fileHash, chunkIndex] = args;
      return this.store.reticulumResourceChunks.find(
        (row) => row.file_hash === fileHash && row.chunk_index === chunkIndex
      );
    }
    if (this.sql.includes('FROM rchat_expired_event_markers')) {
      if (this.sql.includes('MAX(author_seq) AS seq')) {
        const [groupId, authorAddress, authorStreamId] = args;
        let seq = 0;
        for (const row of this.store.reticulumChatExpiredEventMarkers) {
          if (
            row.group_id === groupId &&
            row.author_address === authorAddress &&
            String(row.author_stream_id || '') === String(authorStreamId || '')
          ) {
            seq = Math.max(seq, Number(row.author_seq) || 0);
          }
        }
        return { seq };
      }
    }
    if (this.sql.includes('FROM reticulum_chat_events')) {
      if (this.sql.includes('WHERE event_id = ?')) {
        const [eventId] = args;
        const row = this.store.reticulumChatEvents.find(
          (item) => item.event_id === eventId
        );
        if (!row) return undefined;
        return this.sql.includes('SELECT 1') ? { 1: 1 } : row;
      }
      if (this.sql.includes('MAX(author_seq) AS seq')) {
        const [groupId, authorAddress, authorStreamId, markerGroupId, markerAuthorAddress, markerStreamId] = args;
        let seq = 0;
        for (const row of [
          ...this.store.reticulumChatEvents,
          ...this.store.reticulumChatExpiredEventMarkers,
        ]) {
          if (
            row.group_id === groupId &&
            row.author_address === authorAddress &&
            String(row.author_stream_id || '') === authorStreamId
          ) {
            seq = Math.max(seq, Number(row.author_seq) || 0);
          }
          if (
            row.group_id === markerGroupId &&
            row.author_address === markerAuthorAddress &&
            String(row.author_stream_id || '') === markerStreamId
          ) {
            seq = Math.max(seq, Number(row.author_seq) || 0);
          }
        }
        return { seq };
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
    if (this.sql.includes('INSERT INTO rchat_author_sequence_leases')) {
      const values = Array.from(arguments);
      const row = {
        group_id: values[0],
        author_address: values[1],
        author_stream_id: values[2],
        author_seq: values[3],
        owner_id: values[4],
        owner_pid: values[5],
        created_at: values[6],
      };
      if (
        this.store.reticulumChatAuthorSequenceLeases.some(
          (existing) =>
            existing.group_id === row.group_id &&
            existing.author_address === row.author_address &&
            existing.author_stream_id === row.author_stream_id &&
            existing.author_seq === row.author_seq
        )
      ) {
        throw new Error('UNIQUE constraint failed: rchat_author_sequence_leases');
      }
      this.store.reticulumChatAuthorSequenceLeases.push(row);
      return {
        changes: 1,
        lastInsertRowid: this.store.reticulumChatAuthorSequenceLeases.length,
      };
    }
    if (this.sql.includes('DELETE FROM rchat_author_sequence_leases')) {
      const values = Array.from(arguments);
      const before = this.store.reticulumChatAuthorSequenceLeases.length;
      if (this.sql.includes('group_id = ?')) {
        const [groupId, authorAddress, authorStreamId, authorSeq, ownerId] = values;
        this.store.reticulumChatAuthorSequenceLeases =
          this.store.reticulumChatAuthorSequenceLeases.filter(
            (row) =>
              !(
                row.group_id === groupId &&
                row.author_address === authorAddress &&
                row.author_stream_id === authorStreamId &&
                row.author_seq === authorSeq &&
                row.owner_id === ownerId
              )
          );
      } else {
        this.store.reticulumChatAuthorSequenceLeases =
          this.store.reticulumChatAuthorSequenceLeases.filter(
            (row) => row.owner_id !== values[0]
          );
      }
      return {
        changes: before - this.store.reticulumChatAuthorSequenceLeases.length,
        lastInsertRowid: 0,
      };
    }
    if (this.sql.includes('INSERT OR IGNORE INTO rchat_event_headers')) {
      if (
        this.store.reticulumChatEventHeaders.some(
          (row) => row.event_id === params.event_id
        )
      ) {
        return { changes: 0, lastInsertRowid: 0 };
      }
      this.store.reticulumChatEventHeaders.push({ ...params });
      return {
        changes: 1,
        lastInsertRowid: this.store.reticulumChatEventHeaders.length,
      };
    }
    if (this.sql.includes('INSERT OR IGNORE INTO rchat_author_streams')) {
      if (!this.store.reticulumChatAuthorStreams.has(params.author_address)) {
        this.store.reticulumChatAuthorStreams.set(params.author_address, params.stream_id);
        return { changes: 1, lastInsertRowid: 1 };
      }
      return { changes: 0, lastInsertRowid: 0 };
    }
    if (this.sql.includes('INSERT OR REPLACE INTO rchat_metadata_snapshots')) {
      const values = Array.from(arguments);
      const row = params && typeof params === 'object' && !Array.isArray(params)
        ? { ...params }
        : {
            group_id: values[0], snapshot_id: values[1], scope: values[2],
            parent_snapshot_hash: values[3], version: values[4], created_at: values[5],
            latest_event_id: values[6], latest_feed_timestamp: values[7],
            snapshot_hash: values[8], admin_address: values[9], admin_public_key: values[10],
            signature: values[11], channels_json: values[12], categories_json: values[13],
          };
      const index = this.store.reticulumChatMetadataSnapshots.findIndex(
        (existing) =>
          (existing.group_id === row.group_id && existing.snapshot_id === row.snapshot_id) ||
          (existing.group_id === row.group_id && existing.snapshot_hash === row.snapshot_hash)
      );
      if (index >= 0) this.store.reticulumChatMetadataSnapshots[index] = row;
      else this.store.reticulumChatMetadataSnapshots.push(row);
      return {
        changes: 1,
        lastInsertRowid: index >= 0 ? index + 1 : this.store.reticulumChatMetadataSnapshots.length,
      };
    }
    if (this.sql.includes('INSERT INTO rchat_metadata_entity_revisions')) {
      const values = Array.from(arguments);
      const row = {
        group_id: values[0],
        entity_type: values[1],
        entity_id: values[2],
        event_id: values[3],
        event_type: values[4],
        event_timestamp: values[5],
        deleted: values[6],
        state_hash: values[7],
        source_kind: values[8] ?? 'event',
      };
      const index = this.store.reticulumChatMetadataEntityRevisions.findIndex(
        (existing) =>
          existing.group_id === row.group_id &&
          existing.entity_type === row.entity_type &&
          existing.entity_id === row.entity_id
      );
      if (index >= 0) this.store.reticulumChatMetadataEntityRevisions[index] = row;
      else this.store.reticulumChatMetadataEntityRevisions.push(row);
      return {
        changes: 1,
        lastInsertRowid:
          index >= 0 ? index + 1 : this.store.reticulumChatMetadataEntityRevisions.length,
      };
    }
    if (this.sql.includes('INSERT INTO reticulum_resources')) {
      const index = this.store.reticulumResources.findIndex(
        (row) => row.file_hash === params.file_hash
      );
      if (index >= 0) {
        this.store.reticulumResources[index] = {
          ...this.store.reticulumResources[index],
          ...params,
        };
        return { changes: 1, lastInsertRowid: index + 1 };
      }
      this.store.reticulumResources.push({ ...params });
      return { changes: 1, lastInsertRowid: this.store.reticulumResources.length };
    }
    if (this.sql.includes('UPDATE reticulum_resources')) {
      const [status, assembledPath, updatedAt, fileHash] = Array.isArray(params)
        ? params
        : [params, second, arguments[2], arguments[3]];
      const row = this.store.reticulumResources.find(
        (item) => item.file_hash === fileHash
      );
      if (row) {
        row.status = status;
        row.assembled_path = assembledPath;
        row.updated_at = updatedAt;
      }
      return { changes: row ? 1 : 0, lastInsertRowid: 0 };
    }
    if (this.sql.includes('INSERT INTO reticulum_resource_chunks')) {
      const index = this.store.reticulumResourceChunks.findIndex(
        (row) =>
          row.file_hash === params.file_hash &&
          row.chunk_index === params.chunk_index
      );
      if (index >= 0) {
        this.store.reticulumResourceChunks[index] = {
          ...this.store.reticulumResourceChunks[index],
          ...params,
        };
        return { changes: 1, lastInsertRowid: index + 1 };
      }
      this.store.reticulumResourceChunks.push({ ...params });
      return {
        changes: 1,
        lastInsertRowid: this.store.reticulumResourceChunks.length,
      };
    }
    if (this.sql.includes('UPDATE reticulum_resource_chunks')) {
      const [localPath, updatedAt, fileHash, chunkIndex] = Array.isArray(params)
        ? params
        : [params, second, arguments[2], arguments[3]];
      const row = this.store.reticulumResourceChunks.find(
        (item) => item.file_hash === fileHash && item.chunk_index === chunkIndex
      );
      if (row) {
        row.status = 'complete';
        row.local_path = localPath;
        row.updated_at = updatedAt;
      }
      return { changes: row ? 1 : 0, lastInsertRowid: 0 };
    }
    if (this.sql.includes('INSERT OR IGNORE INTO reticulum_chat_events')) {
      if (
        this.store.reticulumChatEvents.some(
          (row) =>
            row.event_id === params.event_id ||
            (row.group_id === params.group_id &&
              row.author_address === params.author_address &&
              String(row.author_stream_id || '') ===
                String(params.author_stream_id || '') &&
              row.author_seq === params.author_seq)
        )
      ) {
        return { changes: 0, lastInsertRowid: 0 };
      }
      this.store.reticulumChatEvents.push({ ...params });
      return { changes: 1, lastInsertRowid: this.store.reticulumChatEvents.length };
    }
    if (this.sql.includes('INSERT OR IGNORE INTO rchat_expired_event_markers')) {
      const values = Array.from(arguments);
      const [eventId, groupId, channelId, authorAddress, authorStreamId, authorSeq, timestamp, expiredAt] =
        values;
      if (
        this.store.reticulumChatExpiredEventMarkers.some(
          (row) => row.event_id === eventId
        )
      ) {
        return { changes: 0, lastInsertRowid: 0 };
      }
      this.store.reticulumChatExpiredEventMarkers.push({
        event_id: eventId,
        group_id: groupId,
        channel_id: channelId,
        author_address: authorAddress,
        author_stream_id: authorStreamId,
        author_seq: authorSeq,
        timestamp,
        expired_at: expiredAt,
      });
      return {
        changes: 1,
        lastInsertRowid: this.store.reticulumChatExpiredEventMarkers.length,
      };
    }
    if (this.sql.includes('INSERT INTO rchat_message_projection')) {
      const index = this.store.reticulumChatMessages.findIndex(
        (row) => row.root_event_id === params.root_event_id
      );
      if (index >= 0) {
        this.store.reticulumChatMessages[index] = {
          ...this.store.reticulumChatMessages[index],
          ...params,
        };
        return { changes: 1, lastInsertRowid: index + 1 };
      }
      this.store.reticulumChatMessages.push({ ...params });
      return {
        changes: 1,
        lastInsertRowid: this.store.reticulumChatMessages.length,
      };
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
    if (this.sql.includes('DELETE FROM rchat_message_projection WHERE root_event_id = ?')) {
      const before = this.store.reticulumChatMessages.length;
      this.store.reticulumChatMessages = this.store.reticulumChatMessages.filter(
        (row) => row.root_event_id !== params
      );
      return {
        changes: before - this.store.reticulumChatMessages.length,
        lastInsertRowid: 0,
      };
    }
    return { changes: 0, lastInsertRowid: 0 };
  }
}

class MockDatabase {
  private readonly store: MockStore;

  constructor(dbPath = ':memory:') {
    const key = String(dbPath);
    const store = storesByPath.get(key) ?? {
      reticulumChatEvents: [],
      reticulumChatEventHeaders: [],
      reticulumChatMessages: [],
      reticulumChatExpiredEventMarkers: [],
      reticulumChatMetadataSnapshots: [],
      reticulumChatMetadataEntityRevisions: [],
      reticulumChatAuthorStreams: new Map(),
      reticulumChatAuthorSequenceLeases: [],
      reticulumResources: [],
      reticulumResourceChunks: [],
      schema: new Map<string, Set<string>>(),
    };
    storesByPath.set(key, store);
    this.store = store;
  }

  close() {
    return undefined;
  }

  exec(sql = '') {
    this.applySchemaSql(String(sql));
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

  private applySchemaSql(sql: string): void {
    const dropTablePattern = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_]+)/gi;
    let dropMatch: RegExpExecArray | null;
    while ((dropMatch = dropTablePattern.exec(sql))) {
      this.store.schema.delete(dropMatch[1]);
    }

    const createTablePattern =
      /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)\s*\(([\s\S]*?)\);/gi;
    let createMatch: RegExpExecArray | null;
    while ((createMatch = createTablePattern.exec(sql))) {
      const tableName = createMatch[1];
      const columns = this.store.schema.get(tableName) ?? new Set<string>();
      for (const line of createMatch[2].split('\n')) {
        const trimmed = line.trim().replace(/,$/, '');
        if (!trimmed) continue;
        const [name = ''] = trimmed.split(/\s+/);
        const normalized = name.replace(/^["'`]|["'`]$/g, '');
        if (
          !normalized ||
          ['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT'].includes(
            normalized.toUpperCase()
          )
        ) {
          continue;
        }
        columns.add(normalized);
      }
      this.store.schema.set(tableName, columns);
    }

    const alterAddPattern =
      /ALTER\s+TABLE\s+([A-Za-z0-9_]+)\s+ADD\s+COLUMN\s+([A-Za-z0-9_]+)/gi;
    let alterMatch: RegExpExecArray | null;
    while ((alterMatch = alterAddPattern.exec(sql))) {
      const [, tableName, columnName] = alterMatch;
      const columns = this.store.schema.get(tableName) ?? new Set<string>();
      columns.add(columnName);
      this.store.schema.set(tableName, columns);
    }
  }
}

export default MockDatabase;
export type Database = InstanceType<typeof MockDatabase>;
