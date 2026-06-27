import Database, { type Database as DB, type Statement } from 'better-sqlite3';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';

export const RETICULUM_RESOURCE_RANGE_SIZE = 1024 * 1024;
export const RETICULUM_RESOURCE_MAX_RANGE_SIZE = 1024 * 1024;

export type ReticulumResourceManifest = {
  namespace: string;
  ownerId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
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

export type ReticulumResourceByteRangeStatus = {
  fileHash: string;
  startByte: number;
  endByteExclusive: number;
  sizeBytes: number;
  status: 'complete';
  updatedAt: number;
};

export type ReticulumResourceGroupRef = {
  fileHash: string;
  groupId: number;
  eventId?: string;
  ownerId?: string;
  createdAt: number;
  updatedAt: number;
};

export type ReticulumResourceImportOptions = {
  sourcePath: string;
  namespace: string;
  ownerId?: string;
  fileName?: string;
  mimeType?: string;
  encrypted?: boolean;
  metadata?: Record<string, unknown>;
};

export type ReticulumResourceStoreOptions = {
  dbPath?: string;
  rootDir?: string;
  tempDir?: string;
  now?: () => number;
};

type ResourceRow = {
  namespace: string;
  owner_id: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  file_hash: string;
  encrypted: number;
  status: string;
  assembled_path: string | null;
  partial_path: string | null;
  metadata: string | null;
  thumbnail: string | null;
  created_at: number;
  updated_at: number;
  final_verified_at: number | null;
};

type RangeRow = {
  file_hash: string;
  start_byte: number;
  end_byte_exclusive: number;
  status: string;
  updated_at: number;
};

function defaultReticulumResourceRootDir(): string {
  return path.join(app.getPath('appData'), 'qortal-shared', 'reticulum-resources');
}

function defaultReticulumResourceDbPath(): string {
  return path.join(app.getPath('appData'), 'qortal-shared', 'reticulum-resources.db');
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

function sha256File(filePath: string): string {
  const hash = nodeCrypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function normalizeManifest(manifest: ReticulumResourceManifest): ReticulumResourceManifest {
  return {
    ...manifest,
    fileHash:
      typeof manifest.fileHash === 'string'
        ? manifest.fileHash.trim().toLowerCase()
        : '',
    fileName: safeFileName(manifest.fileName),
    mimeType: manifest.mimeType || 'application/octet-stream',
    encrypted: manifest.encrypted === true,
  };
}

function rowToManifest(row: ResourceRow): ReticulumResourceManifest {
  return {
    namespace: row.namespace,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
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
  private readonly tempDir: string;
  private readonly now: () => number;
  private readonly stmtUpsertResource: Statement;
  private readonly stmtGetResource: Statement;
  private readonly stmtUpdateResourceStatus: Statement;
  private readonly stmtUpdatePartialPath: Statement;
  private readonly stmtDeleteRanges: Statement;
  private readonly stmtInsertRange: Statement;
  private readonly stmtGetRanges: Statement;
  private readonly stmtUpsertGroupRef: Statement;
  private readonly stmtHasGroupRef: Statement;
  private readonly stmtListGroupRefs: Statement;

  constructor(options: ReticulumResourceStoreOptions = {}) {
    this.rootDir = options.rootDir ?? defaultReticulumResourceRootDir();
    this.tempDir = options.tempDir ?? os.tmpdir();
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
        (file_hash, namespace, owner_id, file_name, mime_type, size_bytes,
         encrypted, status, assembled_path, partial_path, metadata, thumbnail,
         created_at, updated_at, final_verified_at)
      VALUES
        (@file_hash, @namespace, @owner_id, @file_name, @mime_type, @size_bytes,
         @encrypted, @status, @assembled_path, @partial_path, @metadata, @thumbnail,
         @created_at, @updated_at, @final_verified_at)
      ON CONFLICT(file_hash) DO UPDATE SET
        namespace = excluded.namespace,
        owner_id = excluded.owner_id,
        file_name = excluded.file_name,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        encrypted = excluded.encrypted,
        status = CASE
          WHEN reticulum_resources.status = 'complete' THEN reticulum_resources.status
          ELSE excluded.status
        END,
        assembled_path = COALESCE(excluded.assembled_path, reticulum_resources.assembled_path),
        partial_path = COALESCE(excluded.partial_path, reticulum_resources.partial_path),
        metadata = excluded.metadata,
        thumbnail = excluded.thumbnail,
        updated_at = excluded.updated_at,
        final_verified_at = COALESCE(excluded.final_verified_at, reticulum_resources.final_verified_at)
    `);
    this.stmtGetResource = this.db.prepare(
      'SELECT * FROM reticulum_resources WHERE file_hash = ? LIMIT 1'
    );
    this.stmtUpdateResourceStatus = this.db.prepare(`
      UPDATE reticulum_resources
      SET status = ?, assembled_path = ?, partial_path = ?, updated_at = ?, final_verified_at = ?
      WHERE file_hash = ?
    `);
    this.stmtUpdatePartialPath = this.db.prepare(`
      UPDATE reticulum_resources
      SET partial_path = ?, updated_at = ?
      WHERE file_hash = ?
    `);
    this.stmtDeleteRanges = this.db.prepare(`
      DELETE FROM reticulum_resource_ranges
      WHERE file_hash = ?
    `);
    this.stmtInsertRange = this.db.prepare(`
      INSERT OR REPLACE INTO reticulum_resource_ranges
        (file_hash, start_byte, end_byte_exclusive, status, updated_at)
      VALUES (?, ?, ?, 'complete', ?)
    `);
    this.stmtGetRanges = this.db.prepare(`
      SELECT * FROM reticulum_resource_ranges
      WHERE file_hash = ? AND status = 'complete'
      ORDER BY start_byte ASC, end_byte_exclusive ASC
    `);
    this.stmtUpsertGroupRef = this.db.prepare(`
      INSERT INTO reticulum_resource_group_refs
        (file_hash, group_id, event_id, owner_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_hash, group_id, event_id) DO UPDATE SET
        owner_id = COALESCE(excluded.owner_id, reticulum_resource_group_refs.owner_id),
        updated_at = excluded.updated_at
    `);
    this.stmtHasGroupRef = this.db.prepare(`
      SELECT 1 FROM reticulum_resource_group_refs
      WHERE file_hash = ? AND group_id = ?
      LIMIT 1
    `);
    this.stmtListGroupRefs = this.db.prepare(`
      SELECT file_hash, group_id, event_id, owner_id, created_at, updated_at
      FROM reticulum_resource_group_refs
      WHERE file_hash = ?
      ORDER BY group_id ASC, event_id ASC
    `);
  }

  close(): void {
    this.db.close();
  }

  importLocalFile(options: ReticulumResourceImportOptions): ReticulumResourceManifest {
    const sourcePath = path.resolve(options.sourcePath);
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error('sourcePath must be a file');
    const now = this.now();
    const digest = sha256File(sourcePath);
    const manifest: ReticulumResourceManifest = {
      namespace: options.namespace,
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
      fileName: safeFileName(options.fileName || sourcePath),
      mimeType: options.mimeType || 'application/octet-stream',
      sizeBytes: stat.size,
      fileHash: digest,
      encrypted: options.encrypted ?? true,
      createdAt: now,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };
    const normalized = normalizeManifest(manifest);
    this.validateManifest(normalized);
    const assembledPath = this.assembledPath(normalized);
    fs.mkdirSync(path.dirname(assembledPath), { recursive: true });
    fs.copyFileSync(sourcePath, assembledPath);
    this.storeManifest(normalized, {
      status: 'complete',
      assembledPath,
      finalVerifiedAt: now,
    });
    fs.writeFileSync(this.manifestPath(digest), JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
  }

  storeManifest(
    manifest: ReticulumResourceManifest,
    options: {
      status?: 'pending' | 'complete';
      assembledPath?: string | null;
      partialPath?: string | null;
      finalVerifiedAt?: number | null;
    } = {}
  ): void {
    const normalized = normalizeManifest(manifest);
    this.validateManifest(normalized);
    const now = this.now();
    const existing = this.stmtGetResource.get(normalized.fileHash) as ResourceRow | undefined;
    this.stmtUpsertResource.run({
      namespace: normalized.namespace,
      owner_id: normalized.ownerId ?? null,
      file_name: safeFileName(normalized.fileName),
      mime_type: normalized.mimeType,
      size_bytes: normalized.sizeBytes,
      file_hash: normalized.fileHash,
      encrypted: normalized.encrypted ? 1 : 0,
      status: existing?.status === 'complete' ? 'complete' : options.status ?? 'pending',
      assembled_path: options.assembledPath ?? existing?.assembled_path ?? null,
      partial_path: options.partialPath ?? existing?.partial_path ?? null,
      metadata: normalized.metadata ? JSON.stringify(normalized.metadata) : null,
      thumbnail: normalized.thumbnail ? JSON.stringify(normalized.thumbnail) : null,
      created_at: normalized.createdAt || now,
      updated_at: now,
      final_verified_at: options.finalVerifiedAt ?? existing?.final_verified_at ?? null,
    });
    fs.mkdirSync(this.blobDir(normalized.fileHash), { recursive: true });
    fs.writeFileSync(
      this.manifestPath(normalized.fileHash),
      JSON.stringify(normalized, null, 2),
      'utf8'
    );
    this.recordManifestGroupReference(normalized);
  }

  getManifest(fileHash: string): ReticulumResourceManifest | null {
    const row = this.stmtGetResource.get(String(fileHash || '').trim().toLowerCase()) as
      | ResourceRow
      | undefined;
    return row ? rowToManifest(row) : null;
  }

  getCompletedRanges(fileHash: string): ReticulumResourceByteRangeStatus[] {
    const normalizedFileHash = String(fileHash || '').trim().toLowerCase();
    const rows = (this.stmtGetRanges.all(normalizedFileHash) as RangeRow[])
      .map((row) => ({
        fileHash: row.file_hash,
        startByte: row.start_byte,
        endByteExclusive: row.end_byte_exclusive,
        sizeBytes: Math.max(0, row.end_byte_exclusive - row.start_byte),
        status: 'complete' as const,
        updatedAt: row.updated_at,
      }));
    if (rows.length > 0) return rows;
    return this.readRangeStateFile(normalizedFileHash);
  }

  getCompletedBytes(fileHash: string): number {
    return this.getCompletedRanges(fileHash).reduce(
      (total, range) => total + Math.max(0, range.endByteExclusive - range.startByte),
      0
    );
  }

  getLatestRangeUpdatedAt(fileHash: string): number | null {
    return this.getCompletedRanges(fileHash).reduce(
      (latest: number | null, range) =>
        latest == null ? range.updatedAt : Math.max(latest, range.updatedAt),
      null
    );
  }

  getPartialPath(fileHash: string): string | null {
    const row = this.stmtGetResource.get(String(fileHash || '').trim().toLowerCase()) as
      | ResourceRow
      | undefined;
    if (!row) return null;
    if (row.partial_path) return row.partial_path;
    const candidate = this.partialPath(rowToManifest(row));
    return fs.existsSync(candidate) ? candidate : null;
  }

  recordGroupReference(input: {
    fileHash: string;
    groupId: number;
    eventId?: string;
    ownerId?: string;
    createdAt?: number;
  }): void {
    const fileHash = String(input.fileHash || '').trim().toLowerCase();
    const groupId = Number(input.groupId);
    if (!/^[0-9a-f]{64}$/i.test(fileHash)) throw new Error('Invalid file hash');
    if (!Number.isInteger(groupId) || groupId <= 0) throw new Error('Invalid group id');
    const eventId =
      typeof input.eventId === 'string' && input.eventId.trim()
        ? input.eventId.trim()
        : '';
    const ownerId =
      typeof input.ownerId === 'string' && input.ownerId.trim()
        ? input.ownerId.trim()
        : null;
    const now = this.now();
    this.stmtUpsertGroupRef.run(
      fileHash,
      groupId,
      eventId,
      ownerId,
      Number.isFinite(input.createdAt) ? Number(input.createdAt) : now,
      now
    );
    this.writeGroupReferenceStateFile(
      fileHash,
      this.mergeGroupReferences([
        ...this.listGroupReferences(fileHash),
        {
          fileHash,
          groupId,
          ...(eventId ? { eventId } : {}),
          ...(ownerId ? { ownerId } : {}),
          createdAt: Number.isFinite(input.createdAt) ? Number(input.createdAt) : now,
          updatedAt: now,
        },
      ])
    );
  }

  hasGroupReference(fileHash: string, groupId: number): boolean {
    const normalizedFileHash = String(fileHash || '').trim().toLowerCase();
    const normalizedGroupId = Number(groupId);
    if (!/^[0-9a-f]{64}$/i.test(normalizedFileHash)) return false;
    if (!Number.isInteger(normalizedGroupId) || normalizedGroupId <= 0) return false;
    return (
      !!this.stmtHasGroupRef.get(normalizedFileHash, normalizedGroupId) ||
      this.readGroupReferenceStateFile(normalizedFileHash).some(
        (ref) => ref.groupId === normalizedGroupId
      )
    );
  }

  listGroupReferences(fileHash: string): ReticulumResourceGroupRef[] {
    const normalizedFileHash = String(fileHash || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(normalizedFileHash)) return [];
    return this.mergeGroupReferences([
      ...this.listDbGroupReferences(normalizedFileHash),
      ...this.readGroupReferenceStateFile(normalizedFileHash),
    ]);
  }

  private listDbGroupReferences(fileHash: string): ReticulumResourceGroupRef[] {
    return (this.stmtListGroupRefs.all(fileHash) as Array<{
      file_hash: string;
      group_id: number;
      event_id: string | null;
      owner_id: string | null;
      created_at: number;
      updated_at: number;
    }>).map((row) => ({
      fileHash: row.file_hash,
      groupId: row.group_id,
      ...(row.event_id ? { eventId: row.event_id } : {}),
      ...(row.owner_id ? { ownerId: row.owner_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  ensurePartialFile(fileHash: string): string {
    const manifest = this.getManifest(fileHash);
    if (!manifest) throw new Error('Unknown resource manifest');
    const row = this.stmtGetResource.get(manifest.fileHash) as ResourceRow | undefined;
    const existingPath = row?.partial_path || this.partialPath(manifest);
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    const fd = fs.openSync(existingPath, 'a');
    fs.closeSync(fd);
    fs.truncateSync(existingPath, manifest.sizeBytes);
    this.stmtUpdatePartialPath.run(existingPath, this.now(), manifest.fileHash);
    return existingPath;
  }

  storeByteRange(
    fileHash: string,
    startByte: number,
    endByteExclusive: number,
    bytes: Buffer
  ): void {
    const manifest = this.getManifest(fileHash);
    if (!manifest) throw new Error('Unknown resource manifest');
    this.validateRange(manifest, startByte, endByteExclusive);
    if (bytes.length !== endByteExclusive - startByte) {
      throw new Error('Range size mismatch');
    }
    const partialPath = this.ensurePartialFile(manifest.fileHash);
    const fd = fs.openSync(partialPath, 'r+');
    try {
      fs.writeSync(fd, bytes, 0, bytes.length, startByte);
    } finally {
      fs.closeSync(fd);
    }
    this.recordCompletedRange(manifest.fileHash, startByte, endByteExclusive);
  }

  readByteRange(fileHash: string, startByte: number, endByteExclusive: number): {
    path: string;
    sizeBytes: number;
    sha256: string;
  } {
    const manifest = this.getManifest(fileHash);
    if (!manifest) throw new Error('Unknown resource manifest');
    this.validateRange(manifest, startByte, endByteExclusive);
    const sourcePath = this.assembleResource(manifest.fileHash);
    const sizeBytes = endByteExclusive - startByte;
    const tempPath = this.createPlaintextTempPath(
      manifest.fileHash,
      `.range-${startByte}-${endByteExclusive}.bin`
    );
    const source = fs.openSync(sourcePath, 'r');
    const out = fs.openSync(tempPath, 'w');
    const hash = nodeCrypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, sizeBytes)));
    let remaining = sizeBytes;
    let offset = startByte;
    try {
      while (remaining > 0) {
        const readSize = Math.min(buffer.length, remaining);
        const bytesRead = fs.readSync(source, buffer, 0, readSize, offset);
        if (bytesRead <= 0) throw new Error('Unexpected EOF while reading range');
        const slice = buffer.subarray(0, bytesRead);
        fs.writeSync(out, slice);
        hash.update(slice);
        remaining -= bytesRead;
        offset += bytesRead;
      }
    } finally {
      fs.closeSync(source);
      fs.closeSync(out);
    }
    return {
      path: tempPath,
      sizeBytes,
      sha256: hash.digest('hex'),
    };
  }

  discardResourceData(fileHash: string): void {
    const manifest = this.getManifest(fileHash);
    if (!manifest) return;
    const row = this.stmtGetResource.get(manifest.fileHash) as ResourceRow | undefined;
    const now = this.now();
    if (row?.partial_path) fs.rmSync(row.partial_path, { force: true });
    if (row?.assembled_path) fs.rmSync(row.assembled_path, { force: true });
    fs.rmSync(this.partialPath(manifest), { force: true });
    fs.rmSync(this.rangeStatePath(manifest.fileHash), { force: true });
    if (!manifest.encrypted) {
      fs.rmSync(path.dirname(this.assembledPath(manifest)), { recursive: true, force: true });
    } else {
      fs.rmSync(this.assembledPath(manifest), { force: true });
    }
    this.stmtDeleteRanges.run(manifest.fileHash);
    this.stmtUpdateResourceStatus.run('pending', null, null, now, null, manifest.fileHash);
  }

  assembleResource(fileHash: string): string {
    const manifest = this.getManifest(fileHash);
    if (!manifest) throw new Error('Unknown resource manifest');
    const row = this.stmtGetResource.get(manifest.fileHash) as ResourceRow | undefined;
    if (row?.assembled_path && fs.existsSync(row.assembled_path)) {
      try {
        const stat = fs.statSync(row.assembled_path);
        if (stat.isFile() && stat.size === manifest.sizeBytes) {
          const actualFileHash = sha256File(row.assembled_path);
          if (actualFileHash === manifest.fileHash.toLowerCase()) {
            return row.assembled_path;
          }
        }
      } catch {
        // Fall through and verify the partial file if present.
      }
    }
    const partialPath = row?.partial_path || this.partialPath(manifest);
    if (!fs.existsSync(partialPath)) {
      throw new Error('Resource has no partial file');
    }
    const ranges = this.getCompletedRanges(manifest.fileHash);
    if (!this.rangesCoverFile(ranges, manifest.sizeBytes)) {
      throw new Error('Resource has missing byte ranges');
    }
    const stat = fs.statSync(partialPath);
    if (!stat.isFile() || stat.size !== manifest.sizeBytes) {
      throw new Error('Partial file size mismatch');
    }
    const actualFileHash = sha256File(partialPath);
    if (actualFileHash !== manifest.fileHash.toLowerCase()) {
      throw new Error('Assembled file hash mismatch');
    }
    const assembledPath = this.assembledPath(manifest);
    const tempPath = `${assembledPath}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(assembledPath), { recursive: true });
    fs.copyFileSync(partialPath, tempPath);
    fs.renameSync(tempPath, assembledPath);
    fs.rmSync(partialPath, { force: true });
    this.stmtUpdateResourceStatus.run(
      'complete',
      assembledPath,
      null,
      this.now(),
      this.now(),
      manifest.fileHash
    );
    return assembledPath;
  }

  createPlaintextTempPath(fileHash: string, extension = ''): string {
    const manifest = this.getManifest(fileHash);
    const suffix = extension || path.extname(manifest?.fileName || '') || '.bin';
    const safeSuffix = suffix.startsWith('.') ? suffix : `.${suffix}`;
    const tempDir = path.join(this.tempDir, 'qortal-reticulum-resources');
    fs.mkdirSync(tempDir, { recursive: true });
    return path.join(
      tempDir,
      `${fileHash}-${nodeCrypto.randomBytes(6).toString('hex')}${safeSuffix}`
    );
  }

  private initSchema(): void {
    const existing = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reticulum_resources'")
      .get() as { name: string } | undefined;
    if (existing) {
      const columns = this.db
        .prepare('PRAGMA table_info(reticulum_resources)')
        .all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      if (names.has('chunk_hashes') || !names.has('partial_path')) {
        this.db.exec(`
          DROP TABLE IF EXISTS reticulum_resource_chunks;
          DROP TABLE IF EXISTS reticulum_resource_ranges;
          DROP TABLE IF EXISTS reticulum_resources;
        `);
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reticulum_resources (
        file_hash TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        owner_id TEXT,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        encrypted INTEGER NOT NULL,
        status TEXT NOT NULL,
        assembled_path TEXT,
        partial_path TEXT,
        metadata TEXT,
        thumbnail TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        final_verified_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reticulum_resources_namespace
        ON reticulum_resources(namespace, updated_at DESC);
      CREATE TABLE IF NOT EXISTS reticulum_resource_ranges (
        file_hash TEXT NOT NULL,
        start_byte INTEGER NOT NULL,
        end_byte_exclusive INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(file_hash, start_byte, end_byte_exclusive),
        FOREIGN KEY(file_hash) REFERENCES reticulum_resources(file_hash) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reticulum_resource_ranges_status
        ON reticulum_resource_ranges(file_hash, status, start_byte);
      CREATE TABLE IF NOT EXISTS reticulum_resource_group_refs (
        file_hash TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        event_id TEXT NOT NULL DEFAULT '',
        owner_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(file_hash, group_id, event_id),
        FOREIGN KEY(file_hash) REFERENCES reticulum_resources(file_hash) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reticulum_resource_group_refs_group
        ON reticulum_resource_group_refs(group_id, file_hash);
    `);
  }

  private validateManifest(manifest: ReticulumResourceManifest): void {
    if (!manifest.fileHash || !manifest.namespace) throw new Error('Invalid resource identity');
    if (!manifest.fileName || !manifest.mimeType) throw new Error('Invalid resource metadata');
    if (!Number.isInteger(manifest.sizeBytes) || manifest.sizeBytes < 0) {
      throw new Error('Invalid resource size');
    }
    if (!/^[0-9a-f]{64}$/i.test(manifest.fileHash)) throw new Error('Invalid file hash');
  }

  private validateRange(
    manifest: ReticulumResourceManifest,
    startByte: number,
    endByteExclusive: number
  ): void {
    if (!Number.isInteger(startByte) || !Number.isInteger(endByteExclusive)) {
      throw new Error('Invalid byte range');
    }
    if (startByte < 0 || endByteExclusive <= startByte || endByteExclusive > manifest.sizeBytes) {
      throw new Error('Invalid byte range');
    }
    if (endByteExclusive - startByte > RETICULUM_RESOURCE_MAX_RANGE_SIZE) {
      throw new Error('Byte range too large');
    }
  }

  private recordCompletedRange(
    fileHash: string,
    startByte: number,
    endByteExclusive: number
  ): void {
    const now = this.now();
    const ranges = this.mergeRanges([
      ...this.getCompletedRanges(fileHash),
      {
        fileHash,
        startByte,
        endByteExclusive,
        sizeBytes: endByteExclusive - startByte,
        status: 'complete' as const,
        updatedAt: now,
      },
    ]);
    this.stmtDeleteRanges.run(fileHash);
    for (const range of ranges) {
      this.stmtInsertRange.run(fileHash, range.startByte, range.endByteExclusive, now);
    }
    this.writeRangeStateFile(fileHash, ranges);
  }

  private mergeRanges(
    ranges: ReticulumResourceByteRangeStatus[]
  ): ReticulumResourceByteRangeStatus[] {
    const sorted = ranges
      .filter(
        (range) =>
          Number.isInteger(range.startByte) &&
          Number.isInteger(range.endByteExclusive) &&
          range.startByte >= 0 &&
          range.endByteExclusive > range.startByte
      )
      .sort((a, b) => a.startByte - b.startByte || a.endByteExclusive - b.endByteExclusive);
    const merged: ReticulumResourceByteRangeStatus[] = [];
    for (const range of sorted) {
      const previous = merged[merged.length - 1];
      if (previous && range.startByte <= previous.endByteExclusive) {
        previous.endByteExclusive = Math.max(previous.endByteExclusive, range.endByteExclusive);
        previous.sizeBytes = previous.endByteExclusive - previous.startByte;
        previous.updatedAt = Math.max(previous.updatedAt, range.updatedAt);
      } else {
        merged.push({ ...range });
      }
    }
    return merged;
  }

  private rangesCoverFile(
    ranges: ReticulumResourceByteRangeStatus[],
    sizeBytes: number
  ): boolean {
    if (sizeBytes === 0) return true;
    const merged = this.mergeRanges(ranges);
    return (
      merged.length === 1 &&
      merged[0]?.startByte === 0 &&
      merged[0]?.endByteExclusive === sizeBytes
    );
  }

  private recordManifestGroupReference(manifest: ReticulumResourceManifest): void {
    const groupId = this.groupIdFromManifest(manifest);
    if (!groupId) return;
    const metadata = manifest.metadata && typeof manifest.metadata === 'object' ? manifest.metadata : {};
    const eventId =
      typeof metadata.eventId === 'string' && metadata.eventId.trim()
        ? metadata.eventId.trim()
        : undefined;
    this.recordGroupReference({
      fileHash: manifest.fileHash,
      groupId,
      eventId,
      ownerId: manifest.ownerId,
      createdAt: manifest.createdAt,
    });
  }

  private groupIdFromManifest(manifest: ReticulumResourceManifest): number | null {
    const metadata = manifest.metadata && typeof manifest.metadata === 'object' ? manifest.metadata : {};
    const metadataGroupId = Number(metadata.groupId);
    if (Number.isInteger(metadataGroupId) && metadataGroupId > 0) return metadataGroupId;
    const ownerId = typeof manifest.ownerId === 'string' ? manifest.ownerId : '';
    const ownerMatch = ownerId.match(/^(?:group:)?(\d+):/);
    if (ownerMatch) {
      const ownerGroupId = Number(ownerMatch[1]);
      if (Number.isInteger(ownerGroupId) && ownerGroupId > 0) return ownerGroupId;
    }
    return null;
  }

  private blobDir(fileHash: string): string {
    return path.join(this.rootDir, 'blobs', fileHash);
  }

  private manifestPath(fileHash: string): string {
    return path.join(this.blobDir(fileHash), 'manifest.json');
  }

  private rangeStatePath(fileHash: string): string {
    return path.join(this.blobDir(fileHash), 'ranges.json');
  }

  private groupReferenceStatePath(fileHash: string): string {
    return path.join(this.blobDir(fileHash), 'group-refs.json');
  }

  private partialPath(manifest: ReticulumResourceManifest): string {
    return path.join(this.blobDir(manifest.fileHash), 'download.partial');
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

  private readRangeStateFile(fileHash: string): ReticulumResourceByteRangeStatus[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.rangeStatePath(fileHash), 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return this.mergeRanges(
        parsed
          .filter((range): range is ReticulumResourceByteRangeStatus => {
            const candidate = range as Partial<ReticulumResourceByteRangeStatus>;
            return (
              candidate.fileHash === fileHash &&
              Number.isInteger(candidate.startByte) &&
              Number.isInteger(candidate.endByteExclusive) &&
              candidate.status === 'complete' &&
              Number.isFinite(candidate.updatedAt)
            );
          })
          .map((range) => ({
            fileHash,
            startByte: range.startByte,
            endByteExclusive: range.endByteExclusive,
            sizeBytes: Math.max(0, range.endByteExclusive - range.startByte),
            status: 'complete' as const,
            updatedAt: Number(range.updatedAt),
          }))
      );
    } catch {
      return [];
    }
  }

  private readGroupReferenceStateFile(fileHash: string): ReticulumResourceGroupRef[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.groupReferenceStatePath(fileHash), 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return this.mergeGroupReferences(
        parsed
          .filter((ref): ref is ReticulumResourceGroupRef => {
            const candidate = ref as Partial<ReticulumResourceGroupRef>;
            return (
              candidate.fileHash === fileHash &&
              Number.isInteger(candidate.groupId) &&
              candidate.groupId > 0 &&
              Number.isFinite(candidate.createdAt) &&
              Number.isFinite(candidate.updatedAt)
            );
          })
          .map((ref) => ({
            fileHash,
            groupId: ref.groupId,
            ...(typeof ref.eventId === 'string' && ref.eventId ? { eventId: ref.eventId } : {}),
            ...(typeof ref.ownerId === 'string' && ref.ownerId ? { ownerId: ref.ownerId } : {}),
            createdAt: Number(ref.createdAt),
            updatedAt: Number(ref.updatedAt),
          }))
      );
    } catch {
      return [];
    }
  }

  private writeGroupReferenceStateFile(
    fileHash: string,
    refs: ReticulumResourceGroupRef[]
  ): void {
    fs.mkdirSync(this.blobDir(fileHash), { recursive: true });
    fs.writeFileSync(
      this.groupReferenceStatePath(fileHash),
      JSON.stringify(this.mergeGroupReferences(refs), null, 2),
      'utf8'
    );
  }

  private mergeGroupReferences(refs: ReticulumResourceGroupRef[]): ReticulumResourceGroupRef[] {
    const merged = new Map<string, ReticulumResourceGroupRef>();
    for (const ref of refs) {
      if (ref.fileHash && !/^[0-9a-f]{64}$/i.test(ref.fileHash)) continue;
      if (!Number.isInteger(ref.groupId) || ref.groupId <= 0) continue;
      const eventId = typeof ref.eventId === 'string' ? ref.eventId : '';
      const key = `${ref.fileHash}:${ref.groupId}:${eventId}`;
      const existing = merged.get(key);
      merged.set(key, {
        fileHash: ref.fileHash,
        groupId: ref.groupId,
        ...(eventId ? { eventId } : {}),
        ...(ref.ownerId ? { ownerId: ref.ownerId } : existing?.ownerId ? { ownerId: existing.ownerId } : {}),
        createdAt: existing
          ? Math.min(existing.createdAt, ref.createdAt)
          : ref.createdAt,
        updatedAt: existing
          ? Math.max(existing.updatedAt, ref.updatedAt)
          : ref.updatedAt,
      });
    }
    return [...merged.values()].sort(
      (a, b) =>
        a.groupId - b.groupId ||
        (a.eventId || '').localeCompare(b.eventId || '')
    );
  }

  private writeRangeStateFile(
    fileHash: string,
    ranges: ReticulumResourceByteRangeStatus[]
  ): void {
    fs.mkdirSync(this.blobDir(fileHash), { recursive: true });
    fs.writeFileSync(
      this.rangeStatePath(fileHash),
      JSON.stringify(
        ranges.map((range) => ({
          fileHash,
          startByte: range.startByte,
          endByteExclusive: range.endByteExclusive,
          sizeBytes: Math.max(0, range.endByteExclusive - range.startByte),
          status: 'complete',
          updatedAt: range.updatedAt,
        })),
        null,
        2
      ),
      'utf8'
    );
  }
}
