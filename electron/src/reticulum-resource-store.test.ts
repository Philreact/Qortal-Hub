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

function cryptoHash(value: Buffer): string {
  return nodeCrypto.createHash('sha256').update(value).digest('hex');
}

describe('reticulum resource store', () => {
  const stores: ReticulumResourceStore[] = [];

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
  });

  it('imports a local file as a verified assembled resource', () => {
    const { dir, store } = tempStore();
    stores.push(store);
    const sourcePath = path.join(dir, 'source.bin');
    const contents = Buffer.concat([
      Buffer.from('first range data'),
      Buffer.alloc(64, 7),
      Buffer.from('last range data'),
    ]);
    fs.writeFileSync(sourcePath, contents);

    const manifest = store.importLocalFile({
      sourcePath,
      namespace: 'test.feature',
      fileName: 'image.enc',
      mimeType: 'application/octet-stream',
      encrypted: true,
    });

    expect(manifest.namespace).toBe('test.feature');
    expect(manifest.encrypted).toBe(true);
    expect(manifest.fileHash).toBe(cryptoHash(contents));
    expect(store.getCompletedRanges(manifest.fileHash)).toEqual([]);

    const assembledPath = store.assembleResource(manifest.fileHash);
    expect(path.basename(assembledPath)).toBe('assembled.enc');
    expect(fs.readFileSync(assembledPath)).toEqual(contents);
    expect(store.getVerifiedAssembledPath(manifest.fileHash)).toBe(assembledPath);
  });

  it('keeps separate group references for the same file hash', () => {
    const { dir, store } = tempStore();
    stores.push(store);
    const sourcePath = path.join(dir, 'shared.bin');
    const contents = Buffer.from('same bytes posted in two groups');
    fs.writeFileSync(sourcePath, contents);

    const firstManifest = store.importLocalFile({
      sourcePath,
      namespace: 'reticulum-chat-file',
      ownerId: '81:sender',
      fileName: 'shared.bin',
      mimeType: 'application/octet-stream',
      encrypted: false,
      metadata: { groupId: 81, eventId: 'event-group-81' },
    });
    store.importLocalFile({
      sourcePath,
      namespace: 'reticulum-chat-file',
      ownerId: '82:sender',
      fileName: 'shared.bin',
      mimeType: 'application/octet-stream',
      encrypted: false,
      metadata: { groupId: 82, eventId: 'event-group-82' },
    });

    expect(store.getManifest(firstManifest.fileHash)?.metadata?.groupId).toBe(82);
    expect(store.hasGroupReference(firstManifest.fileHash, 81)).toBe(true);
    expect(store.hasGroupReference(firstManifest.fileHash, 82)).toBe(true);
    expect(store.listGroupReferences(firstManifest.fileHash)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileHash: firstManifest.fileHash,
          groupId: 81,
          eventId: 'event-group-81',
        }),
        expect.objectContaining({
          fileHash: firstManifest.fileHash,
          groupId: 82,
          eventId: 'event-group-82',
        }),
      ])
    );
    expect(fs.readFileSync(store.assembleResource(firstManifest.fileHash))).toEqual(contents);
  });

  it('stores received byte ranges and assembles after final file hash verification', () => {
    const { store } = tempStore();
    stores.push(store);
    const first = Buffer.from('a'.repeat(16 * 1024));
    const second = Buffer.from('second');
    const contents = Buffer.concat([first, second]);
    const manifest: ReticulumResourceManifest = {
      namespace: 'test.feature',
      fileName: 'payload.enc',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash: cryptoHash(contents),
      encrypted: true,
      createdAt: 100_000,
    };

    store.storeManifest(manifest);
    expect(store.getManifest(manifest.fileHash)?.fileHash).toBe(manifest.fileHash);
    expect(() => store.assembleResource(manifest.fileHash)).toThrow(/partial file/);

    store.storeByteRange(manifest.fileHash, first.length, contents.length, second);
    expect(store.getCompletedBytes(manifest.fileHash)).toBe(second.length);
    expect(() => store.assembleResource(manifest.fileHash)).toThrow(/missing byte ranges/);

    store.storeByteRange(manifest.fileHash, 0, first.length, first);
    const assembledPath = store.assembleResource(manifest.fileHash);
    expect(fs.readFileSync(assembledPath)).toEqual(contents);
  });

  it('rejects invalid received byte ranges before writing to the partial file', () => {
    const { store } = tempStore();
    stores.push(store);
    const contents = Buffer.from('valid bytes');
    const manifest: ReticulumResourceManifest = {
      namespace: 'test.feature',
      fileName: 'payload.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash: cryptoHash(contents),
      encrypted: false,
      createdAt: 100_000,
    };

    store.storeManifest(manifest);
    expect(() => store.storeByteRange(manifest.fileHash, 0, 5, Buffer.from('no'))).toThrow(
      /Range size mismatch/
    );
    expect(() =>
      store.storeByteRange(manifest.fileHash, 0, contents.length + 1, Buffer.alloc(contents.length + 1))
    ).toThrow(/Invalid byte range/);
    expect(store.getCompletedRanges(manifest.fileHash)).toEqual([]);
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

    expect(store.getVerifiedAssembledPath(manifest.fileHash)).toBe(assembledPath);
    expect(store.assembleResource(manifest.fileHash)).toBe(assembledPath);
    expect(fs.readFileSync(assembledPath)).toEqual(contents);
    expect(fs.statSync(assembledPath).mtimeMs).toBe(10_000);
  });

  it('does not report a verified assembled path when the verified file is missing', () => {
    const { dir, store } = tempStore();
    stores.push(store);
    const sourcePath = path.join(dir, 'source.bin');
    const contents = Buffer.from('missing assembled path');
    fs.writeFileSync(sourcePath, contents);

    const manifest = store.importLocalFile({
      sourcePath,
      namespace: 'test.feature',
      fileName: 'missing.bin',
      mimeType: 'application/octet-stream',
      encrypted: false,
    });
    const assembledPath = store.getVerifiedAssembledPath(manifest.fileHash);
    expect(assembledPath).toBeTruthy();

    fs.rmSync(assembledPath!, { force: true });

    expect(store.getVerifiedAssembledPath(manifest.fileHash)).toBe(null);
    expect(() => store.assembleResource(manifest.fileHash)).toThrow(/partial file/);
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
    const tempPath = store.createPlaintextTempPath(cryptoHash(Buffer.from('resource')), '.range.bin');

    expect(path.dirname(tempPath)).toBe(path.join(tempRoot, 'qortal-reticulum-resources'));
    fs.writeFileSync(tempPath, Buffer.from('ok'));
    expect(fs.readFileSync(tempPath, 'utf8')).toBe('ok');
  });

  it('discards downloaded byte ranges while keeping the manifest retryable', () => {
    const { store } = tempStore();
    stores.push(store);
    const first = Buffer.from('a'.repeat(16 * 1024));
    const second = Buffer.from('b'.repeat(16 * 1024));
    const contents = Buffer.concat([first, second]);
    const manifest: ReticulumResourceManifest = {
      namespace: 'test.feature',
      fileName: 'payload.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash: cryptoHash(contents),
      encrypted: false,
      createdAt: 100_000,
    };

    store.storeManifest(manifest);
    store.storeByteRange(manifest.fileHash, 0, first.length, first);
    const partialPath = store.getPartialPath(manifest.fileHash);
    expect(partialPath && fs.existsSync(partialPath)).toBe(true);

    store.discardResourceData(manifest.fileHash);

    expect(store.getManifest(manifest.fileHash)?.fileHash).toBe(manifest.fileHash);
    expect(store.getCompletedRanges(manifest.fileHash)).toEqual([]);
    expect(partialPath && fs.existsSync(partialPath)).toBe(false);
  });
});
