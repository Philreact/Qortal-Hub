import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import {
  ReticulumResourceStore,
  type ReticulumResourceManifest,
} from './reticulum-resource-store';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-store-test-'));
}

function tempStore(): { dir: string; store: ReticulumResourceStore } {
  const dir = tempDir();
  return {
    dir,
    store: new ReticulumResourceStore({
      dbPath: path.join(dir, 'resources.db'),
      rootDir: path.join(dir, 'resources'),
      now: () => 100_000,
    }),
  };
}

describe('reticulum resource store', () => {
  const stores: ReticulumResourceStore[] = [];

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
  });

  it('imports a local file as hashed chunks and assembles the encrypted payload', () => {
    const { dir, store } = tempStore();
    stores.push(store);
    const sourcePath = path.join(dir, 'source.bin');
    const contents = Buffer.concat([
      Buffer.from('first chunk data'),
      Buffer.alloc(64, 7),
      Buffer.from('last chunk data'),
    ]);
    fs.writeFileSync(sourcePath, contents);

    const manifest = store.importLocalFile({
      sourcePath,
      namespace: 'test.feature',
      fileName: 'image.enc',
      mimeType: 'application/octet-stream',
      chunkSize: 16 * 1024,
      encrypted: true,
    });

    expect(manifest.namespace).toBe('test.feature');
    expect(manifest.encrypted).toBe(true);
    expect(manifest.chunkHashes).toHaveLength(1);
    expect(store.getChunks(manifest.fileHash)).toEqual([
      expect.objectContaining({
        fileHash: manifest.fileHash,
        chunkIndex: 0,
        status: 'complete',
        sizeBytes: contents.length,
      }),
    ]);

    const assembledPath = store.assembleResource(manifest.fileHash);
    expect(path.basename(assembledPath)).toBe('assembled.enc');
    expect(fs.readFileSync(assembledPath)).toEqual(contents);
  });

  it('stores a received manifest and verifies chunks before assembly', () => {
    const { store } = tempStore();
    stores.push(store);
    const first = Buffer.from('a'.repeat(16 * 1024));
    const second = Buffer.from('second');
    const manifest: ReticulumResourceManifest = {
      namespace: 'test.feature',
      fileName: 'payload.enc',
      mimeType: 'application/octet-stream',
      sizeBytes: first.length + second.length,
      chunkSize: first.length,
      chunkHashes: [
        cryptoHash(first),
        cryptoHash(second),
      ],
      fileHash: cryptoHash(Buffer.concat([first, second])),
      encrypted: true,
      createdAt: 100_000,
    };

    store.storeManifest(manifest);
    expect(store.getManifest(manifest.fileHash)?.fileHash).toBe(manifest.fileHash);
    expect(store.getChunks(manifest.fileHash).map((chunk) => chunk.status)).toEqual([
      'missing',
      'missing',
    ]);
    expect(() => store.storeChunk(manifest.fileHash, 0, Buffer.from('wrong'))).toThrow(
      /Chunk hash mismatch/
    );

    store.storeChunk(manifest.fileHash, 0, first);
    store.storeChunk(manifest.fileHash, 1, second);

    const assembledPath = store.assembleResource(manifest.fileHash);
    expect(fs.readFileSync(assembledPath)).toEqual(Buffer.concat([first, second]));
  });

  it('reuses an existing assembled resource instead of rebuilding it', () => {
    const { dir, store } = tempStore();
    stores.push(store);
    const sourcePath = path.join(dir, 'source.bin');
    const contents = Buffer.from('reuse assembled bytes');
    fs.writeFileSync(sourcePath, contents);

    const manifest = store.importLocalFile({
      sourcePath,
      namespace: 'test.feature',
      fileName: 'reuse.bin',
      mimeType: 'application/octet-stream',
      encrypted: false,
    });

    const assembledPath = store.assembleResource(manifest.fileHash);
    const oldTime = new Date(10_000);
    fs.utimesSync(assembledPath, oldTime, oldTime);

    expect(store.assembleResource(manifest.fileHash)).toBe(assembledPath);
    expect(fs.readFileSync(assembledPath)).toEqual(contents);
    expect(fs.statSync(assembledPath).mtimeMs).toBe(10_000);
  });

  it('assembles public resources to the original safe filename', () => {
    const { dir, store } = tempStore();
    stores.push(store);
    const sourcePath = path.join(dir, 'public-image.png');
    const contents = Buffer.from('public image bytes');
    fs.writeFileSync(sourcePath, contents);

    const manifest = store.importLocalFile({
      sourcePath,
      namespace: 'test.public',
      fileName: 'public-image.png',
      mimeType: 'image/png',
      encrypted: false,
    });

    const assembledPath = store.assembleResource(manifest.fileHash);
    expect(path.basename(assembledPath)).toBe('public-image.png');
    expect(path.basename(path.dirname(assembledPath))).toBe('assembled');
    expect(fs.readFileSync(assembledPath)).toEqual(contents);
  });

  it('creates the plaintext temp directory before returning a temp path', () => {
    const dir = tempDir();
    const tempRoot = path.join(dir, 'missing-temp-root');
    const store = new ReticulumResourceStore({
      dbPath: path.join(dir, 'resources.db'),
      rootDir: path.join(dir, 'resources'),
      tempDir: tempRoot,
      now: () => 100_000,
    });
    stores.push(store);
    const tempPath = store.createPlaintextTempPath(cryptoHash(Buffer.from('resource')), '.bundle-0.bin');

    expect(path.dirname(tempPath)).toBe(path.join(tempRoot, 'qortal-reticulum-resources'));
    fs.writeFileSync(tempPath, Buffer.from('ok'));
    expect(fs.readFileSync(tempPath, 'utf8')).toBe('ok');
  });
});

function cryptoHash(value: Buffer): string {
  return nodeCrypto.createHash('sha256').update(value).digest('hex');
}
