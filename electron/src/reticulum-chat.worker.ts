import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import Database, { type Database as DB } from 'better-sqlite3';
import type {
  SerializedReticulumChatAuthorTreeSnapshot,
} from './reticulum-chat-author-tree';

const path = require('path') as typeof import('path');

function loadAuthorTree(): typeof import('./reticulum-chat-author-tree') {
  // The worker is unpacked so Electron can execute it directly, while its
  // pure-JS helper remains in app.asar. Resolve that split explicitly.
  if (__dirname.includes('app.asar.unpacked')) {
    const packedDir = __dirname.replace('app.asar.unpacked', 'app.asar');
    return require(path.join(
      packedDir,
      'reticulum-chat-author-tree.js'
    )) as typeof import('./reticulum-chat-author-tree');
  }
  return require('./reticulum-chat-author-tree') as typeof import('./reticulum-chat-author-tree');
}

const {
  buildReticulumChatAuthorTreeSnapshot,
  serializeReticulumChatAuthorTreeSnapshot,
} = loadAuthorTree();

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
      events: Array<{ eventId?: unknown; timestamp?: unknown; feedTimestamp?: unknown }>;
    }
  | {
      id: number;
      kind: 'build_author_tree';
      dbPath: string;
      groupId: number;
      createdAt: number;
    };

export type ReticulumChatWorkerTaskInput =
  | Omit<
      Extract<ReticulumChatWorkerTask, { path: string }>,
      'id'
    >
  | Omit<
      Extract<ReticulumChatWorkerTask, { kind: 'compute_digest_hash' }>,
      'id'
    >
  | Omit<
      Extract<ReticulumChatWorkerTask, { kind: 'build_author_tree' }>,
      'id'
    >;

export type ReticulumChatPreparedResourceKind = Exclude<
  ReticulumChatWorkerTask['kind'],
  'compute_digest_hash' | 'build_author_tree'
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
      ok: false;
      kind: ReticulumChatWorkerTask['kind'];
      error: string;
      prepMs: number;
    };

function sha256Utf8(input: string): string {
  return nodeCrypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function normalizeFeedTimestamp(timestamp: unknown): number {
  const value = Number(timestamp);
  return Number.isFinite(value) ? Math.floor(value) : 0;
}

function computeDigestHash(events: Array<{ eventId?: unknown; timestamp?: unknown; feedTimestamp?: unknown }>): string {
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
    return eventA.timestamp - eventB.timestamp || eventA.eventId.localeCompare(eventB.eventId);
  });
  return sha256Utf8(JSON.stringify(ids));
}

function prepareResource(task: Extract<ReticulumChatWorkerTask, { path: string }>): ReticulumChatWorkerResult {
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
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { events?: unknown }).events)
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
    db = new Database(task.dbPath, { readonly: true, fileMustExist: true });
    const heads = db.prepare(`
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
    `).all(task.groupId, task.groupId) as Array<{
      authorAddress: string;
      authorStreamId: string;
      maxSeq: number;
    }>;
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
  parentPort?.postMessage(prepareResource(task));
});
