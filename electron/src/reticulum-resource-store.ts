import Database, { type Database as DB, type Statement } from 'better-sqlite3';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';

export const RETICULUM_RESOURCE_DEFAULT_CHUNK_SIZE = 512 * 1024;
export const RETICULUM_RESOURCE_MIN_CHUNK_SIZE = 16 * 1024;
export const RETICULUM_RESOURCE_MAX_CHUNK_SIZE = 512 * 1024;

export type ReticulumResourceManifest = {
  resourceId: string;
  namespace: string;
  ownerId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  chunkSize: number;
  chunkHashes: string[];
  fileHash: string;
  encrypted: boolean;
  createdAt: number;
  metadata?: Record<string, unknown>;
  thumbnail?: {
    mimeType: string;
    sizeBytes: number;
    hash: string;
    width?: number;
    height?: number;
  };
};

export type ReticulumResourceChunkStatus = {
  resourceId: string;
  chunkIndex: number;
  chunkHash: string;
  sizeBytes: number;
  status: 'missing' | 'complete';
  localPath: string | null;
  updatedAt: number;
};

export type ReticulumResourceImportOptions = {
  sourcePath: string;
  namespace: string;
  ownerId?: string;
  resourceId?: string;
  fileName?: string;
  mimeType?: string;
  chunkSize?: number;
  encrypted?: boolean;
  metadata?: Record<string, unknown>;
};

export type ReticulumResourceStoreOptions = {
  dbPath?: string;
  rootDir?: string;
  now?: () => number;
};

type ResourceRow = {
  resource_id: string;
  namespace: string;
  owner_id: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  chunk_size: number;
  chunk_count: number;
  chunk_hashes: string;
  file_hash: string;
  encrypted: number;
  status: string;
  assembled_path: string | null;
  metadata: string | null;
  thumbnail: string | null;
  created_at: number;
  updated_at: number;
};

type ChunkRow = {
  resource_id: string;
  chunk_index: number;
  chunk_hash: string;
  size_bytes: number;
  status: string;
  local_path: string | null;
  updated_at: number;
};

function defaultReticulumResourceRootDir(): string {
  return path.join(app.getPath('appData'), 'qortal-shared', 'reticulum-resources');
}

function defaultReticulumResourceDbPath(): string {
  return path.join(app.getPath('appData'), 'qortal-shared', 'reticulum-resources.db');
}

function sha256Hex(bytes: Buffer | string): string {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeChunkSize(value: unknown): number {
  const n = Number(value || RETICULUM_RESOURCE_DEFAULT_CHUNK_SIZE);
  if (!Number.isFinite(n)) return RETICULUM_RESOURCE_DEFAULT_CHUNK_SIZE;
  return Math.max(
    RETICULUM_RESOURCE_MIN_CHUNK_SIZE,
    Math.min(RETICULUM_RESOURCE_MAX_CHUNK_SIZE, Math.floor(n))
  );
}

function safeFileName(value: string): string {
  const base = path.basename(value || 'resource.bin').replace(/[^\w.\- ()]+/g, '_');
  return base || 'resource.bin';
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function rowToManifest(row: ResourceRow): ReticulumResourceManifest {
  return {
    resourceId: row.resource_id,
    namespace: row.namespace,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    chunkSize: row.chunk_size,
    chunkHashes: parseJsonArray(row.chunk_hashes),
    fileHash: row.file_hash,
    encrypted: row.encrypted === 1,
    createdAt: row.created_at,
    ...(parseJsonObject(row.metadata) ? { metadata: parseJsonObject(row.metadata) } : {}),
    ...(parseJsonObject(row.thumbnail)
      ? { thumbnail: parseJsonObject(row.thumbnail) as ReticulumResourceManifest['thumbnail'] }
      : {}),
  };
}

export class ReticulumResourceStore {
  private readonly db: DB;
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly stmtUpsertResource: Statement;
  private readonly stmtGetResource: Statement;
  private readonly stmtUpdateResourceStatus: Statement;
  private readonly stmtUpsertChunk: Statement;
  private readonly stmtGetChunk: Statement;
  private readonly stmtGetChunks: Statement;
  private readonly stmtUpdateChunkComplete: Statement;
  private readonly stmtCountMissingChunks: Statement;

  constructor(options: ReticulumResourceStoreOptions = {}) {
    this.rootDir = options.rootDir ?? defaultReticulumResourceRootDir();
    this.now = options.now ?? Date.now;
    const dbPath = options.dbPath ?? defaultReticulumResourceDbPath();
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();

    this.stmtUpsertResource = this.db.prepare(`
      INSERT INTO reticulum_resources
        (resource_id, namespace, owner_id, file_name, mime_type, size_bytes,
         chunk_size, chunk_count, chunk_hashes, file_hash, encrypted, status,
         assembled_path, metadata, thumbnail, created_at, updated_at)
      VALUES
        (@resource_id, @namespace, @owner_id, @file_name, @mime_type, @size_bytes,
         @chunk_size, @chunk_count, @chunk_hashes, @file_hash, @encrypted, @status,
         @assembled_path, @metadata, @thumbnail, @created_at, @updated_at)
      ON CONFLICT(resource_id) DO UPDATE SET
        namespace = excluded.namespace,
        owner_id = excluded.owner_id,
        file_name = excluded.file_name,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        chunk_size = excluded.chunk_size,
        chunk_count = excluded.chunk_count,
        chunk_hashes = excluded.chunk_hashes,
        file_hash = excluded.file_hash,
        encrypted = excluded.encrypted,
        metadata = excluded.metadata,
        thumbnail = excluded.thumbnail,
        updated_at = excluded.updated_at
    `);
    this.stmtGetResource = this.db.prepare(
      'SELECT * FROM reticulum_resources WHERE resource_id = ? LIMIT 1'
    );
    this.stmtUpdateResourceStatus = this.db.prepare(`
      UPDATE reticulum_resources
      SET status = ?, assembled_path = ?, updated_at = ?
      WHERE resource_id = ?
    `);
    this.stmtUpsertChunk = this.db.prepare(`
      INSERT INTO reticulum_resource_chunks
        (resource_id, chunk_index, chunk_hash, size_bytes, status, local_path, updated_at)
      VALUES
        (@resource_id, @chunk_index, @chunk_hash, @size_bytes, @status, @local_path, @updated_at)
      ON CONFLICT(resource_id, chunk_index) DO UPDATE SET
        chunk_hash = excluded.chunk_hash,
        size_bytes = excluded.size_bytes,
        status = excluded.status,
        local_path = excluded.local_path,
        updated_at = excluded.updated_at
    `);
    this.stmtGetChunk = this.db.prepare(`
      SELECT * FROM reticulum_resource_chunks
      WHERE resource_id = ? AND chunk_index = ?
      LIMIT 1
    `);
    this.stmtGetChunks = this.db.prepare(`
      SELECT * FROM reticulum_resource_chunks
      WHERE resource_id = ?
      ORDER BY chunk_index ASC
    `);
    this.stmtUpdateChunkComplete = this.db.prepare(`
      UPDATE reticulum_resource_chunks
      SET status = 'complete', local_path = ?, updated_at = ?
      WHERE resource_id = ? AND chunk_index = ?
    `);
    this.stmtCountMissingChunks = this.db.prepare(`
      SELECT COUNT(*) AS count FROM reticulum_resource_chunks
      WHERE resource_id = ? AND status != 'complete'
    `);
  }

  close(): void {
    this.db.close();
  }

  importLocalFile(options: ReticulumResourceImportOptions): ReticulumResourceManifest {
    const sourcePath = path.resolve(options.sourcePath);
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error('sourcePath must be a file');
    const chunkSize = normalizeChunkSize(options.chunkSize);
    const now = this.now();
    const stagingId = nodeCrypto.randomBytes(12).toString('hex');
    const stagingDir = path.join(this.rootDir, 'staging', stagingId);
    const stagingChunksDir = path.join(stagingDir, 'chunks');
    fs.mkdirSync(stagingChunksDir, { recursive: true });
    const chunkHashes: string[] = [];
    const fileHash = nodeCrypto.createHash('sha256');
    const fd = fs.openSync(sourcePath, 'r');
    try {
      let offset = 0;
      let chunkIndex = 0;
      while (offset < stat.size) {
        const size = Math.min(chunkSize, stat.size - offset);
        const buffer = Buffer.alloc(size);
        fs.readSync(fd, buffer, 0, size, offset);
        fileHash.update(buffer);
        const chunkHash = sha256Hex(buffer);
        chunkHashes.push(chunkHash);
        fs.writeFileSync(this.chunkPath(stagingChunksDir, chunkIndex), buffer);
        offset += size;
        chunkIndex += 1;
      }
    } finally {
      fs.closeSync(fd);
    }
    const digest = fileHash.digest('hex');
    const resourceId = options.resourceId?.trim() || sha256Hex(`${options.namespace}:${digest}`);
    const blobDir = this.blobDir(digest);
    const chunksDir = this.chunksDir(digest);
    fs.rmSync(blobDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(blobDir), { recursive: true });
    fs.renameSync(stagingDir, blobDir);
    fs.mkdirSync(chunksDir, { recursive: true });

    const manifest: ReticulumResourceManifest = {
      resourceId,
      namespace: options.namespace,
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
      fileName: safeFileName(options.fileName || sourcePath),
      mimeType: options.mimeType || 'application/octet-stream',
      sizeBytes: stat.size,
      chunkSize,
      chunkHashes,
      fileHash: digest,
      encrypted: options.encrypted ?? true,
      createdAt: now,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };
    this.storeManifest(manifest);
    for (const [chunkIndex, chunkHash] of chunkHashes.entries()) {
      const sizeBytes =
        chunkIndex === chunkHashes.length - 1
          ? stat.size - chunkSize * chunkIndex
          : chunkSize;
      this.stmtUpdateChunkComplete.run(
        this.chunkPath(chunksDir, chunkIndex),
        now,
        resourceId,
        chunkIndex
      );
      this.stmtUpsertChunk.run({
        resource_id: resourceId,
        chunk_index: chunkIndex,
        chunk_hash: chunkHash,
        size_bytes: sizeBytes,
        status: 'complete',
        local_path: this.chunkPath(chunksDir, chunkIndex),
        updated_at: now,
      });
    }
    this.stmtUpdateResourceStatus.run('complete', null, now, resourceId);
    fs.writeFileSync(this.manifestPath(digest), JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  }

  storeManifest(manifest: ReticulumResourceManifest): void {
    this.validateManifest(manifest);
    const now = this.now();
    this.stmtUpsertResource.run({
      resource_id: manifest.resourceId,
      namespace: manifest.namespace,
      owner_id: manifest.ownerId ?? null,
      file_name: safeFileName(manifest.fileName),
      mime_type: manifest.mimeType,
      size_bytes: manifest.sizeBytes,
      chunk_size: manifest.chunkSize,
      chunk_count: manifest.chunkHashes.length,
      chunk_hashes: JSON.stringify(manifest.chunkHashes),
      file_hash: manifest.fileHash,
      encrypted: manifest.encrypted ? 1 : 0,
      status: 'pending',
      assembled_path: null,
      metadata: manifest.metadata ? JSON.stringify(manifest.metadata) : null,
      thumbnail: manifest.thumbnail ? JSON.stringify(manifest.thumbnail) : null,
      created_at: manifest.createdAt || now,
      updated_at: now,
    });
    for (const [chunkIndex, chunkHash] of manifest.chunkHashes.entries()) {
      const existing = this.getChunk(manifest.resourceId, chunkIndex);
      this.stmtUpsertChunk.run({
        resource_id: manifest.resourceId,
        chunk_index: chunkIndex,
        chunk_hash: chunkHash,
        size_bytes: this.expectedChunkSize(manifest, chunkIndex),
        status: existing?.status === 'complete' ? 'complete' : 'missing',
        local_path: existing?.localPath ?? null,
        updated_at: now,
      });
    }
    fs.mkdirSync(this.blobDir(manifest.fileHash), { recursive: true });
    fs.writeFileSync(
      this.manifestPath(manifest.fileHash),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );
  }

  getManifest(resourceId: string): ReticulumResourceManifest | null {
    const row = this.stmtGetResource.get(resourceId) as ResourceRow | undefined;
    return row ? rowToManifest(row) : null;
  }

  getChunk(resourceId: string, chunkIndex: number): ReticulumResourceChunkStatus | null {
    const row = this.stmtGetChunk.get(resourceId, chunkIndex) as ChunkRow | undefined;
    return row ? this.rowToChunkStatus(row) : null;
  }

  getChunks(resourceId: string): ReticulumResourceChunkStatus[] {
    return (this.stmtGetChunks.all(resourceId) as ChunkRow[]).map((row) =>
      this.rowToChunkStatus(row)
    );
  }

  storeChunk(resourceId: string, chunkIndex: number, bytes: Buffer): void {
    const manifest = this.getManifest(resourceId);
    if (!manifest) throw new Error('Unknown resource manifest');
    const expectedHash = manifest.chunkHashes[chunkIndex];
    if (!expectedHash) throw new Error('Invalid chunk index');
    const actualHash = sha256Hex(bytes);
    if (actualHash !== expectedHash.toLowerCase()) {
      throw new Error('Chunk hash mismatch');
    }
    const chunksDir = this.chunksDir(manifest.fileHash);
    fs.mkdirSync(chunksDir, { recursive: true });
    const localPath = this.chunkPath(chunksDir, chunkIndex);
    fs.writeFileSync(localPath, bytes);
    this.stmtUpdateChunkComplete.run(localPath, this.now(), resourceId, chunkIndex);
    if (this.hasAllChunks(resourceId)) {
      this.stmtUpdateResourceStatus.run('complete', null, this.now(), resourceId);
    }
  }

  assembleResource(resourceId: string): string {
    const manifest = this.getManifest(resourceId);
    if (!manifest) throw new Error('Unknown resource manifest');
    const chunks = this.getChunks(resourceId);
    if (chunks.length !== manifest.chunkHashes.length || chunks.some((c) => c.status !== 'complete')) {
      throw new Error('Resource has missing chunks');
    }
    const assembledPath = this.assembledPath(manifest);
    const tempPath = `${assembledPath}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(assembledPath), { recursive: true });
    const out = fs.openSync(tempPath, 'w');
    const fileHash = nodeCrypto.createHash('sha256');
    try {
      for (const chunk of chunks) {
        if (!chunk.localPath) throw new Error('Chunk local path missing');
        const data = fs.readFileSync(chunk.localPath);
        const actualChunkHash = sha256Hex(data);
        if (actualChunkHash !== chunk.chunkHash.toLowerCase()) {
          throw new Error(`Chunk ${chunk.chunkIndex} hash mismatch`);
        }
        fileHash.update(data);
        fs.writeSync(out, data);
      }
    } finally {
      fs.closeSync(out);
    }
    const actualFileHash = fileHash.digest('hex');
    if (actualFileHash !== manifest.fileHash.toLowerCase()) {
      fs.rmSync(tempPath, { force: true });
      throw new Error('Assembled file hash mismatch');
    }
    fs.renameSync(tempPath, assembledPath);
    this.stmtUpdateResourceStatus.run('complete', assembledPath, this.now(), resourceId);
    return assembledPath;
  }

  createPlaintextTempPath(resourceId: string, extension = ''): string {
    const manifest = this.getManifest(resourceId);
    const suffix = extension || path.extname(manifest?.fileName || '') || '.bin';
    const safeSuffix = suffix.startsWith('.') ? suffix : `.${suffix}`;
    return path.join(
      os.tmpdir(),
      'qortal-reticulum-resources',
      `${resourceId}-${nodeCrypto.randomBytes(6).toString('hex')}${safeSuffix}`
    );
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reticulum_resources (
        resource_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        owner_id TEXT,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        chunk_size INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        chunk_hashes TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        encrypted INTEGER NOT NULL,
        status TEXT NOT NULL,
        assembled_path TEXT,
        metadata TEXT,
        thumbnail TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reticulum_resources_namespace
        ON reticulum_resources(namespace, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reticulum_resources_file_hash
        ON reticulum_resources(file_hash);
      CREATE TABLE IF NOT EXISTS reticulum_resource_chunks (
        resource_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL,
        local_path TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(resource_id, chunk_index),
        FOREIGN KEY(resource_id) REFERENCES reticulum_resources(resource_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reticulum_resource_chunks_status
        ON reticulum_resource_chunks(resource_id, status);
    `);
  }

  private validateManifest(manifest: ReticulumResourceManifest): void {
    if (!manifest.resourceId || !manifest.namespace) throw new Error('Invalid resource identity');
    if (!manifest.fileName || !manifest.mimeType) throw new Error('Invalid resource metadata');
    if (!Number.isInteger(manifest.sizeBytes) || manifest.sizeBytes < 0) {
      throw new Error('Invalid resource size');
    }
    if (normalizeChunkSize(manifest.chunkSize) !== manifest.chunkSize) {
      throw new Error('Invalid chunk size');
    }
    if (!/^[0-9a-f]{64}$/i.test(manifest.fileHash)) throw new Error('Invalid file hash');
    if (!Array.isArray(manifest.chunkHashes) || manifest.chunkHashes.length === 0) {
      throw new Error('Missing chunk hashes');
    }
    if (manifest.chunkHashes.some((hash) => !/^[0-9a-f]{64}$/i.test(hash))) {
      throw new Error('Invalid chunk hash');
    }
  }

  private hasAllChunks(resourceId: string): boolean {
    const row = this.stmtCountMissingChunks.get(resourceId) as { count: number } | undefined;
    return row?.count === 0;
  }

  private expectedChunkSize(manifest: ReticulumResourceManifest, chunkIndex: number): number {
    if (chunkIndex < manifest.chunkHashes.length - 1) return manifest.chunkSize;
    return manifest.sizeBytes - manifest.chunkSize * chunkIndex;
  }

  private rowToChunkStatus(row: ChunkRow): ReticulumResourceChunkStatus {
    return {
      resourceId: row.resource_id,
      chunkIndex: row.chunk_index,
      chunkHash: row.chunk_hash,
      sizeBytes: row.size_bytes,
      status: row.status === 'complete' ? 'complete' : 'missing',
      localPath: row.local_path,
      updatedAt: row.updated_at,
    };
  }

  private blobDir(fileHash: string): string {
    return path.join(this.rootDir, 'blobs', fileHash);
  }

  private chunksDir(fileHash: string): string {
    return path.join(this.blobDir(fileHash), 'chunks');
  }

  private manifestPath(fileHash: string): string {
    return path.join(this.blobDir(fileHash), 'manifest.json');
  }

  private assembledPath(manifest: ReticulumResourceManifest): string {
    if (manifest.encrypted) {
      return path.join(this.blobDir(manifest.fileHash), 'assembled.enc');
    }
    return path.join(
      this.blobDir(manifest.fileHash),
      'assembled',
      safeFileName(manifest.fileName)
    );
  }

  private chunkPath(chunksDir: string, chunkIndex: number): string {
    return path.join(chunksDir, `${String(chunkIndex).padStart(8, '0')}.part`);
  }
}
