import { parentPort } from 'worker_threads';
import type { KeyObject } from 'crypto';
import type { Database as DB } from 'better-sqlite3';
import type { SerializedReticulumChatAuthorTreeSnapshot } from './reticulum-chat-author-tree';

// This worker is unpacked from app.asar so Node can execute it directly.
// Avoid emitted tslib helpers, which are not resolvable from that location.
const fs = require('fs') as typeof import('fs');
const nodeCrypto = require('crypto') as typeof import('crypto');
const path = require('path') as typeof import('path');

function openReadOnlyDatabase(dbPath: string): DB {
  // Signature-only workers never load the native SQLite binding.
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function loadAuthorTree(): typeof import('./reticulum-chat-author-tree') {
  // The worker is unpacked so Electron can execute it directly, while its
  // pure-JS helper remains in app.asar. Resolve that split explicitly.
  if (__dirname.includes('app.asar.unpacked')) {
    const packedDir = __dirname.replace('app.asar.unpacked', 'app.asar');
    return require(
      path.join(packedDir, 'reticulum-chat-author-tree.js')
    ) as typeof import('./reticulum-chat-author-tree');
  }
  return require('./reticulum-chat-author-tree') as typeof import('./reticulum-chat-author-tree');
}

const DIGEST_WINDOW_EVENTS = 200;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const LAND_STATE_PUBLIC_KEY_CACHE_MAX = 256;
const landStatePublicKeyCache = new Map<string, KeyObject>();
// Digest state is invalidated by accepted group mutations in the manager. This
// cap is only a conservative safety refresh; the next signed event expiry can
// shorten it precisely.
const DIGEST_STATE_MAX_CACHE_MS = 15 * 60_000;
const METADATA_EVENT_TYPES = [
  'channel_create',
  'channel_update',
  'channel_archive',
  'channel_restore',
  'channel_reorder',
  'category_create',
  'category_update',
  'category_delete',
] as const;

export type SerializedReticulumChatDigestState = {
  snapshot: {
    latest: { eventId: string; feedTimestamp: number } | null;
    digestHash: string;
  };
  channelHeads: Array<{
    channelId: string;
    latest: { eventId: string; feedTimestamp: number } | null;
    hash: string;
  }>;
  channelHash: string;
  validUntil: number;
};

export type ReticulumChatWorkerTask =
  | {
      id: number;
      kind:
        | 'prepare_event_resource'
        | 'prepare_event_page_resource'
        | 'prepare_dm_page_resource'
        | 'prepare_land_chat_resource';
      path: string;
    }
  | {
      id: number;
      kind: 'compute_digest_hash';
      events: Array<{
        eventId?: unknown;
        timestamp?: unknown;
        feedTimestamp?: unknown;
      }>;
    }
  | {
      id: number;
      kind: 'build_author_tree';
      dbPath: string;
      groupId: number;
      createdAt: number;
    }
  | {
      id: number;
      kind: 'build_group_digest_state';
      dbPath: string;
      groupId: number;
      createdAt: number;
    }
  | {
      id: number;
      kind: 'verify_land_state_signature';
      signedBytes: Uint8Array;
      signature: Uint8Array;
      publicKey: Uint8Array;
    };

export type ReticulumChatWorkerTaskInput =
  | Omit<Extract<ReticulumChatWorkerTask, { path: string }>, 'id'>
  | Omit<
      Extract<ReticulumChatWorkerTask, { kind: 'compute_digest_hash' }>,
      'id'
    >
  | Omit<Extract<ReticulumChatWorkerTask, { kind: 'build_author_tree' }>, 'id'>
  | Omit<
      Extract<ReticulumChatWorkerTask, { kind: 'build_group_digest_state' }>,
      'id'
    >
  | Omit<
      Extract<ReticulumChatWorkerTask, { kind: 'verify_land_state_signature' }>,
      'id'
    >;

export type ReticulumChatPreparedResourceKind = Exclude<
  ReticulumChatWorkerTask['kind'],
  | 'compute_digest_hash'
  | 'build_author_tree'
  | 'build_group_digest_state'
  | 'verify_land_state_signature'
>;

export type ReticulumChatWorkerPreparedResourceResult = {
  id: number;
  ok: true;
  kind: ReticulumChatPreparedResourceKind;
  blob: string;
  hash: string;
  parsed: unknown;
  prepMs: number;
  bytes: number;
  eventCount?: number;
};

export type ReticulumChatWorkerResult =
  | ReticulumChatWorkerPreparedResourceResult
  | {
      id: number;
      ok: true;
      kind: 'compute_digest_hash';
      hash: string;
      prepMs: number;
      eventCount: number;
    }
  | {
      id: number;
      ok: true;
      kind: 'build_author_tree';
      snapshot: SerializedReticulumChatAuthorTreeSnapshot;
      prepMs: number;
    }
  | {
      id: number;
      ok: true;
      kind: 'build_group_digest_state';
      state: SerializedReticulumChatDigestState;
      prepMs: number;
    }
  | {
      id: number;
      ok: true;
      kind: 'verify_land_state_signature';
      valid: boolean;
      prepMs: number;
    }
  | {
      id: number;
      ok: false;
      kind: ReticulumChatWorkerTask['kind'];
      error: string;
      prepMs: number;
    };

function sha256Utf8(input: string): string {
  return nodeCrypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

function hashStateValue(value: Record<string, unknown>): string {
  return sha256Utf8(canonicalize(value));
}

function normalizeFeedTimestamp(timestamp: unknown): number {
  const value = Number(timestamp);
  return Number.isFinite(value) ? Math.floor(value) : 0;
}

function computeDigestHash(
  events: Array<{
    eventId?: unknown;
    timestamp?: unknown;
    feedTimestamp?: unknown;
  }>
): string {
  const eventsById = new Map<string, { eventId: string; timestamp: number }>();
  for (const event of events) {
    const eventId = typeof event.eventId === 'string' ? event.eventId : '';
    if (!eventId || eventsById.has(eventId)) continue;
    eventsById.set(eventId, {
      eventId,
      timestamp: normalizeFeedTimestamp(event.timestamp),
    });
  }
  const ids = [...eventsById.keys()].sort((a, b) => {
    const eventA = eventsById.get(a);
    const eventB = eventsById.get(b);
    if (!eventA || !eventB) return a.localeCompare(b);
    return (
      eventA.timestamp - eventB.timestamp ||
      eventA.eventId.localeCompare(eventB.eventId)
    );
  });
  return sha256Utf8(JSON.stringify(ids));
}

type DigestEventRow = {
  event_id: string;
  channel_id: string;
  timestamp: number;
  feed_timestamp: number;
  event_type: string;
  expires_at: number | null;
};

function normalizeChannelId(value: unknown): string {
  const normalized =
    typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized || 'general';
}

function digestEventFromRow(row: DigestEventRow): {
  eventId: string;
  channelId: string;
  timestamp: number;
  feedTimestamp: number;
  eventType: string;
  expiresAt: number | null;
} {
  return {
    eventId: row.event_id,
    channelId: normalizeChannelId(row.channel_id),
    timestamp: Number(row.timestamp),
    feedTimestamp: Number(row.feed_timestamp),
    eventType: row.event_type,
    expiresAt: Number.isFinite(row.expires_at) ? Number(row.expires_at) : null,
  };
}

export function buildGroupDigestState(
  dbPath: string,
  groupId: number,
  createdAt = Date.now()
): SerializedReticulumChatDigestState {
  if (!Number.isInteger(groupId) || groupId <= 0) {
    throw new Error('Invalid digest state group');
  }
  const db = openReadOnlyDatabase(dbPath);
  try {
    const build = db.transaction((): SerializedReticulumChatDigestState => {
      const visibleSql = '(expires_at IS NULL OR expires_at > ?)';
      const persistedChannels = db
        .prepare(
          `
      SELECT channel_id, read_mode
      FROM reticulum_chat_channels
      WHERE group_id = ?
      ORDER BY channel_id ASC
    `
        )
        .all(groupId) as Array<{
        channel_id: string;
        read_mode?: string | null;
      }>;
      const channelMap = new Map<
        string,
        { channel_id: string; read_mode?: string | null }
      >([
        ['general', { channel_id: 'general', read_mode: 'members' }],
        ['qortal-land', { channel_id: 'qortal-land', read_mode: 'members' }],
      ]);
      for (const channel of persistedChannels) {
        channelMap.set(normalizeChannelId(channel.channel_id), channel);
      }
      const channels = [...channelMap.values()];
      const adminPrivateChannels = new Set(
        channels
          .filter((channel) => channel.read_mode === 'admins')
          .map((channel) => normalizeChannelId(channel.channel_id))
      );
      const candidates = new Map<
        string,
        ReturnType<typeof digestEventFromRow>
      >();
      const addCandidate = (row: DigestEventRow): void => {
        const event = digestEventFromRow(row);
        if (
          !METADATA_EVENT_TYPES.includes(
            event.eventType as (typeof METADATA_EVENT_TYPES)[number]
          ) &&
          adminPrivateChannels.has(event.channelId)
        ) {
          return;
        }
        candidates.set(event.eventId, event);
      };
      const recentRows = db
        .prepare(
          `
      SELECT event_id, channel_id, timestamp, feed_timestamp, event_type, expires_at
      FROM reticulum_chat_events
      WHERE group_id = ? AND ${visibleSql}
      ORDER BY timestamp DESC, event_id DESC
      LIMIT ?
    `
        )
        .all(groupId, createdAt, DIGEST_WINDOW_EVENTS * 4) as DigestEventRow[];
      recentRows.forEach(addCandidate);
      const metadataPlaceholders = METADATA_EVENT_TYPES.map(() => '?').join(
        ', '
      );
      const metadataRows = db
        .prepare(
          `
      SELECT event_id, channel_id, timestamp, feed_timestamp, event_type, expires_at
      FROM reticulum_chat_events
      WHERE group_id = ? AND event_type IN (${metadataPlaceholders}) AND ${visibleSql}
      ORDER BY timestamp DESC, event_id DESC
      LIMIT ?
    `
        )
        .all(
          groupId,
          ...METADATA_EVENT_TYPES,
          createdAt,
          DIGEST_WINDOW_EVENTS
        ) as DigestEventRow[];
      metadataRows.forEach(addCandidate);
      if (candidates.size < DIGEST_WINDOW_EVENTS) {
        const recentByChannel = db.prepare(`
        SELECT event_id, channel_id, timestamp, feed_timestamp, event_type, expires_at
        FROM reticulum_chat_events
        WHERE group_id = ? AND channel_id = ? AND ${visibleSql}
        ORDER BY timestamp DESC, event_id DESC
        LIMIT ?
      `);
        for (const channel of channels) {
          if (channel.read_mode === 'admins') continue;
          const rows = recentByChannel.all(
            groupId,
            normalizeChannelId(channel.channel_id),
            createdAt,
            DIGEST_WINDOW_EVENTS
          ) as DigestEventRow[];
          rows.forEach(addCandidate);
          if (candidates.size >= DIGEST_WINDOW_EVENTS) break;
        }
      }
      const digestEvents = [...candidates.values()]
        .sort(
          (a, b) =>
            b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId)
        )
        .slice(0, DIGEST_WINDOW_EVENTS)
        .sort(
          (a, b) =>
            a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId)
        );
      const latestEvent = digestEvents.reduce<
        (typeof digestEvents)[number] | null
      >(
        (latest, event) =>
          !latest ||
          event.timestamp > latest.timestamp ||
          (event.timestamp === latest.timestamp &&
            event.eventId > latest.eventId)
            ? event
            : latest,
        null
      );
      const recentChannelEvents = db.prepare(`
      SELECT event_id, channel_id, timestamp, feed_timestamp, event_type, expires_at
      FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND ${visibleSql}
      ORDER BY timestamp DESC, event_id DESC
      LIMIT 25
    `);
      const latestChannelCursor = db.prepare(`
      SELECT event_id, feed_timestamp
      FROM reticulum_chat_events
      WHERE group_id = ? AND channel_id = ? AND ${visibleSql}
      ORDER BY feed_timestamp DESC, event_id DESC
      LIMIT 1
    `);
      const channelHeads = channels
        .map((channel) => {
          const channelId = normalizeChannelId(channel.channel_id);
          const rows = recentChannelEvents.all(
            groupId,
            channelId,
            createdAt
          ) as DigestEventRow[];
          const latest = latestChannelCursor.get(
            groupId,
            channelId,
            createdAt
          ) as { event_id?: string; feed_timestamp?: number } | undefined;
          return {
            channelId,
            latest:
              latest?.event_id && Number.isFinite(latest.feed_timestamp)
                ? {
                    eventId: latest.event_id,
                    feedTimestamp: Number(latest.feed_timestamp),
                  }
                : null,
            hash: computeDigestHash(
              rows.map((row) => ({
                eventId: row.event_id,
                timestamp: row.timestamp,
              }))
            ),
          };
        })
        .sort((a, b) => a.channelId.localeCompare(b.channelId));
      const nextExpiry = db
        .prepare(
          `
      SELECT MIN(expires_at) AS next_expiry
      FROM reticulum_chat_events
      WHERE group_id = ? AND expires_at IS NOT NULL AND expires_at > ?
    `
        )
        .get(groupId, createdAt) as { next_expiry?: number | null } | undefined;
      const nextExpiryAt = Number(nextExpiry?.next_expiry);
      return {
        snapshot: {
          latest: latestEvent
            ? {
                eventId: latestEvent.eventId,
                feedTimestamp: latestEvent.timestamp,
              }
            : null,
          digestHash: computeDigestHash(digestEvents),
        },
        channelHeads,
        channelHash: hashStateValue({
          t: 'channel_heads_v3',
          g: groupId,
          heads: channelHeads.map((head) => [
            head.channelId,
            head.latest
              ? { id: head.latest.eventId, ts: head.latest.feedTimestamp }
              : null,
            head.hash,
          ]),
        }),
        validUntil: Math.max(
          createdAt + 1,
          Math.min(
            createdAt + DIGEST_STATE_MAX_CACHE_MS,
            Number.isFinite(nextExpiryAt) && nextExpiryAt > createdAt
              ? nextExpiryAt
              : Number.POSITIVE_INFINITY
          )
        ),
      };
    });
    return build();
  } finally {
    db.close();
  }
}

function prepareResource(
  task: Extract<ReticulumChatWorkerTask, { path: string }>
): ReticulumChatWorkerResult {
  const startedAt = Date.now();
  try {
    const blob = fs.readFileSync(task.path, 'utf8');
    const parsed = JSON.parse(blob) as unknown;
    return {
      id: task.id,
      ok: true,
      kind: task.kind,
      blob,
      hash: sha256Utf8(blob),
      parsed,
      prepMs: Date.now() - startedAt,
      bytes: Buffer.byteLength(blob, 'utf8'),
      eventCount:
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Array.isArray((parsed as { events?: unknown }).events)
          ? (parsed as { events: unknown[] }).events.length
          : undefined,
    };
  } catch (err) {
    return {
      id: task.id,
      ok: false,
      kind: task.kind,
      error: err instanceof Error ? err.message : String(err),
      prepMs: Date.now() - startedAt,
    };
  }
}

function buildAuthorTree(
  task: Extract<ReticulumChatWorkerTask, { kind: 'build_author_tree' }>
): ReticulumChatWorkerResult {
  const startedAt = Date.now();
  let db: DB | null = null;
  try {
    if (!Number.isInteger(task.groupId) || task.groupId <= 0) {
      throw new Error('Invalid author tree group');
    }
    db = openReadOnlyDatabase(task.dbPath);
    const heads = db
      .prepare(
        `
      SELECT author_address AS authorAddress,
             author_stream_id AS authorStreamId,
             MAX(author_seq) AS maxSeq
      FROM (
        SELECT author_address, author_stream_id, author_seq
        FROM rchat_event_headers
        WHERE group_id = ?
        UNION ALL
        SELECT author_address, author_stream_id, author_seq
        FROM rchat_expired_event_markers
        WHERE group_id = ?
      )
      GROUP BY author_address, author_stream_id
      ORDER BY author_address ASC, author_stream_id ASC
    `
      )
      .all(task.groupId, task.groupId) as Array<{
      authorAddress: string;
      authorStreamId: string;
      maxSeq: number;
    }>;
    const {
      buildReticulumChatAuthorTreeSnapshot,
      serializeReticulumChatAuthorTreeSnapshot,
    } = loadAuthorTree();
    const snapshot = buildReticulumChatAuthorTreeSnapshot(
      task.groupId,
      heads,
      task.createdAt
    );
    return {
      id: task.id,
      ok: true,
      kind: task.kind,
      snapshot: serializeReticulumChatAuthorTreeSnapshot(snapshot),
      prepMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      id: task.id,
      ok: false,
      kind: task.kind,
      error: err instanceof Error ? err.message : String(err),
      prepMs: Date.now() - startedAt,
    };
  } finally {
    db?.close();
  }
}

function buildGroupDigestStateResult(
  task: Extract<ReticulumChatWorkerTask, { kind: 'build_group_digest_state' }>
): ReticulumChatWorkerResult {
  const startedAt = Date.now();
  try {
    return {
      id: task.id,
      ok: true,
      kind: task.kind,
      state: buildGroupDigestState(task.dbPath, task.groupId, task.createdAt),
      prepMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      id: task.id,
      ok: false,
      kind: task.kind,
      error: err instanceof Error ? err.message : String(err),
      prepMs: Date.now() - startedAt,
    };
  }
}

function verifyLandStateSignature(
  task: Extract<
    ReticulumChatWorkerTask,
    { kind: 'verify_land_state_signature' }
  >
): ReticulumChatWorkerResult {
  const startedAt = Date.now();
  try {
    const signedBytes = Buffer.from(task.signedBytes);
    const signature = Buffer.from(task.signature);
    const publicKey = Buffer.from(task.publicKey);
    if (
      signature.length !== ED25519_SIGNATURE_BYTES ||
      publicKey.length !== ED25519_PUBLIC_KEY_BYTES
    ) {
      return {
        id: task.id,
        ok: true,
        kind: task.kind,
        valid: false,
        prepMs: Date.now() - startedAt,
      };
    }

    const cacheKey = publicKey.toString('hex');
    let publicKeyObject = landStatePublicKeyCache.get(cacheKey);
    if (publicKeyObject) {
      // Refresh insertion order so active Land sessions remain cached.
      landStatePublicKeyCache.delete(cacheKey);
      landStatePublicKeyCache.set(cacheKey, publicKeyObject);
    } else {
      publicKeyObject = nodeCrypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
        format: 'der',
        type: 'spki',
      });
      if (landStatePublicKeyCache.size >= LAND_STATE_PUBLIC_KEY_CACHE_MAX) {
        const oldestKey = landStatePublicKeyCache.keys().next().value;
        if (typeof oldestKey === 'string') {
          landStatePublicKeyCache.delete(oldestKey);
        }
      }
      landStatePublicKeyCache.set(cacheKey, publicKeyObject);
    }

    const valid = nodeCrypto.verify(
      null,
      signedBytes,
      publicKeyObject,
      signature
    );
    return {
      id: task.id,
      ok: true,
      kind: task.kind,
      valid,
      prepMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      id: task.id,
      ok: false,
      kind: task.kind,
      error: err instanceof Error ? err.message : String(err),
      prepMs: Date.now() - startedAt,
    };
  }
}

parentPort?.on('message', (task: ReticulumChatWorkerTask) => {
  if (!task || typeof task.id !== 'number') return;
  if (task.kind === 'compute_digest_hash') {
    const startedAt = Date.now();
    try {
      const events = Array.isArray(task.events) ? task.events : [];
      parentPort?.postMessage({
        id: task.id,
        ok: true,
        kind: task.kind,
        hash: computeDigestHash(events),
        prepMs: Date.now() - startedAt,
        eventCount: events.length,
      } satisfies ReticulumChatWorkerResult);
    } catch (err) {
      parentPort?.postMessage({
        id: task.id,
        ok: false,
        kind: task.kind,
        error: err instanceof Error ? err.message : String(err),
        prepMs: Date.now() - startedAt,
      } satisfies ReticulumChatWorkerResult);
    }
    return;
  }
  if (task.kind === 'build_author_tree') {
    parentPort?.postMessage(buildAuthorTree(task));
    return;
  }
  if (task.kind === 'build_group_digest_state') {
    parentPort?.postMessage(buildGroupDigestStateResult(task));
    return;
  }
  if (task.kind === 'verify_land_state_signature') {
    parentPort?.postMessage(verifyLandStateSignature(task));
    return;
  }
  parentPort?.postMessage(prepareResource(task));
});
