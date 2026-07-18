import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { ReticulumResourceStore, type ReticulumResourceManifest } from './reticulum-resource-store';
import {
  RETICULUM_RESOURCE_TRANSFER_COMPLETION_GRACE_MS,
  RETICULUM_RESOURCE_TRANSFER_TTL_MS,
  ReticulumResourceTransferManager,
} from './reticulum-resource-transfer';

describe('reticulum resource transfer storage protection', () => {
  const stores: ReticulumResourceStore[] = [];
  const transfers: Array<ReticulumResourceTransferManager<Record<string, never>>> = [];

  afterEach(() => {
    while (transfers.length) transfers.pop()?.close();
    while (stores.length) stores.pop()?.close();
  });

  it('recreates expired leases and reservations when a provider appears later', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-transfer-test-'));
    let now = 100_000;
    const store = new ReticulumResourceStore({
      dbPath: path.join(dir, 'resources.db'),
      rootDir: path.join(dir, 'resources'),
      now: () => now,
    });
    stores.push(store);
    const contents = Buffer.from('resumed transfer');
    const manifest: ReticulumResourceManifest = {
      namespace: 'reticulum-group-resource',
      ownerId: '716:sender',
      fileName: 'resumed.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash: nodeCrypto.createHash('sha256').update(contents).digest('hex'),
      encrypted: false,
      createdAt: now,
      metadata: { groupId: 716 },
    };
    const transfer = new ReticulumResourceTransferManager<Record<string, never>>({
      resourceStore: store,
      now: () => now,
      buildRequestPayloads: async () => [],
    });
    transfers.push(transfer);

    transfer.requestResource({ contextId: 716, manifest });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const state = (transfer as any).downloads.get(manifest.fileHash);
    expect(state?.waitingForProvider).toBe(true);
    const oldLeaseId = state.storageLeaseId;
    const oldReservationId = state.storageReservationId;

    now += RETICULUM_RESOURCE_TRANSFER_TTL_MS - 1;
    await (transfer as any).processDownloads();
    now += 2;
    expect(store.getStorageStatus().reservedBytes).toBe(0);
    expect(transfer.addCandidatePeers(manifest.fileHash, ['provider-a'])).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.storageLeaseId).not.toBe(oldLeaseId);
    expect(state.storageReservationId).not.toBe(oldReservationId);
    expect(store.getStorageStatus().reservedBytes).toBe(contents.length);
  });

  it('builds the missing-range index once and keeps active ranges pending', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-transfer-test-'));
    const store = new ReticulumResourceStore({
      dbPath: path.join(dir, 'resources.db'),
      rootDir: path.join(dir, 'resources'),
    });
    stores.push(store);
    const sizeBytes = 2 * 1024 * 1024;
    const manifest: ReticulumResourceManifest = {
      namespace: 'reticulum-group-resource',
      ownerId: '716:sender',
      fileName: 'large.bin',
      mimeType: 'application/octet-stream',
      sizeBytes,
      fileHash: 'a'.repeat(64),
      encrypted: false,
      createdAt: Date.now(),
      metadata: { groupId: 716 },
    };
    store.storeManifest(manifest, { provenance: 'remote_downloaded' });
    const completedRangeSpy = vi.spyOn(store, 'getCompletedRanges');
    const transfer = new ReticulumResourceTransferManager<Record<string, never>>({
      resourceStore: store,
      buildRequestPayloads: async () => [],
    });
    transfers.push(transfer);

    const state = (transfer as any).upsertDownload(716, manifest, undefined, ['provider-a']);
    expect(completedRangeSpy).toHaveBeenCalledTimes(1);
    const firstRange = state.missingRanges.values().next().value;
    const firstKey = `${firstRange.startByte}:${firstRange.endByteExclusive}`;
    state.inFlightRanges.set(firstKey, { transferId: 'active-transfer', startedAt: Date.now() });

    await (transfer as any).dispatchRequests(state);
    await (transfer as any).dispatchRequests(state);

    expect(completedRangeSpy).toHaveBeenCalledTimes(1);
    expect((transfer as any).downloads.has(manifest.fileHash)).toBe(true);
    expect(state.missingRanges.size).toBe(2);
  });

  it('does not report completion until the assembled file is verified', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-transfer-test-'));
    const store = new ReticulumResourceStore({
      dbPath: path.join(dir, 'resources.db'),
      rootDir: path.join(dir, 'resources'),
    });
    stores.push(store);
    const contents = Buffer.from('verify before complete');
    const manifest: ReticulumResourceManifest = {
      namespace: 'reticulum-group-resource',
      ownerId: '716:sender',
      fileName: 'verify.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash: nodeCrypto.createHash('sha256').update(contents).digest('hex'),
      encrypted: false,
      createdAt: Date.now(),
      metadata: { groupId: 716 },
    };
    store.storeManifest(manifest, { provenance: 'remote_downloaded' });
    const onProgress = vi.fn();
    const transfer = new ReticulumResourceTransferManager<Record<string, never>>({
      resourceStore: store,
      buildRequestPayloads: async () => [],
      onProgress,
    });
    transfers.push(transfer);
    const state = (transfer as any).upsertDownload(716, manifest, undefined, ['provider-a']);
    const range = { startByte: 0, endByteExclusive: contents.length };
    const offer = {
      transferId: 'progress-only',
      contextId: 716,
      fileHash: manifest.fileHash,
      totalSizeBytes: contents.length,
      sizeBytes: contents.length,
      fileName: 'verify.bin',
      mimeType: manifest.mimeType,
      ranges: [range],
      sourcePeerHash: 'provider-a',
    };

    (transfer as any).emitProgress(state, false, {
      offer,
      progress: 1,
      bytesTransferred: contents.length,
    });

    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 1, complete: false, failed: false })
    );

    await store.storeByteRangeAsync(manifest.fileHash, 0, contents.length, contents);
    await (transfer as any).handleReceivedRange(offer);

    expect(store.getVerifiedAssembledPath(manifest.fileHash)).toBeTruthy();
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 1, complete: true, failed: false })
    );
  });

  it('retries a fully received range after the completion callback grace period', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-transfer-test-'));
    let now = 10_000;
    const store = new ReticulumResourceStore({
      dbPath: path.join(dir, 'resources.db'),
      rootDir: path.join(dir, 'resources'),
      now: () => now,
    });
    stores.push(store);
    const contents = Buffer.from('completion callback');
    const manifest: ReticulumResourceManifest = {
      namespace: 'reticulum-group-resource',
      ownerId: '716:sender',
      fileName: 'callback.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash: nodeCrypto.createHash('sha256').update(contents).digest('hex'),
      encrypted: false,
      createdAt: now,
      metadata: { groupId: 716 },
    };
    store.storeManifest(manifest, { provenance: 'remote_downloaded' });
    const cancelReticulumResourceDetailed = vi.fn(async () => ({ ok: true as const }));
    const onProgress = vi.fn();
    const transfer = new ReticulumResourceTransferManager<Record<string, never>>({
      bridge: { cancelReticulumResourceDetailed } as any,
      resourceStore: store,
      now: () => now,
      buildRequestPayloads: async () => [],
      onProgress,
    });
    transfers.push(transfer);
    const state = (transfer as any).upsertDownload(716, manifest, undefined, ['provider-a']);
    const range = { startByte: 0, endByteExclusive: contents.length };
    const offer = {
      transferId: 'missing-completion-callback',
      contextId: 716,
      fileHash: manifest.fileHash,
      totalSizeBytes: contents.length,
      sizeBytes: contents.length,
      fileName: 'callback.bin',
      mimeType: manifest.mimeType,
      ranges: [range],
      sourcePeerHash: 'provider-a',
    };
    (transfer as any).offers.set(offer.transferId, offer);
    (transfer as any).activeAccepts.add(offer.transferId);
    (transfer as any).activeAcceptStartedAt.set(offer.transferId, now);
    (transfer as any).transferProgressWatch.set(offer.transferId, {
      lastProgressAt: now,
      lastProgressBytes: 0,
    });
    state.inFlightRanges.set(`0:${contents.length}`, {
      transferId: offer.transferId,
      startedAt: now,
    });
    (transfer as any).requestedResources.set(
      `716:provider-a:${manifest.fileHash}:0:${contents.length}`,
      now
    );

    transfer.handleResourceEvent({
      status: 'receiving',
      transferId: offer.transferId,
      progress: 1,
      bytesTransferred: contents.length,
    });
    expect((transfer as any).nextActiveTransferWatchDelay()).toBe(
      RETICULUM_RESOURCE_TRANSFER_COMPLETION_GRACE_MS
    );
    now += RETICULUM_RESOURCE_TRANSFER_COMPLETION_GRACE_MS - 1;
    expect((transfer as any).nextActiveTransferWatchDelay()).toBe(1);
    (transfer as any).retryNoProgressTransfers();
    expect(cancelReticulumResourceDetailed).not.toHaveBeenCalled();

    now += 1;
    (transfer as any).retryNoProgressTransfers();

    expect(cancelReticulumResourceDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: offer.transferId,
        reason: 'resource_range_completion_timeout',
      })
    );
    expect((transfer as any).activeAccepts.has(offer.transferId)).toBe(false);
    expect(state.inFlightRanges.size).toBe(0);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 0, complete: false, reset: true })
    );
    expect(
      (transfer as any).requestedResources.has(
        `716:provider-a:${manifest.fileHash}:0:${contents.length}`
      )
    ).toBe(false);
  });

  it('discards corrupt assembled data and retries with another provider', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-resource-transfer-test-'));
    const store = new ReticulumResourceStore({
      dbPath: path.join(dir, 'resources.db'),
      rootDir: path.join(dir, 'resources'),
    });
    stores.push(store);
    const contents = Buffer.from('expected resource bytes');
    const corruptContents = Buffer.from('corrupted resource byte');
    expect(corruptContents.length).toBe(contents.length);
    const manifest: ReticulumResourceManifest = {
      namespace: 'reticulum-group-resource',
      ownerId: '716:sender',
      fileName: 'integrity.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: contents.length,
      fileHash: nodeCrypto.createHash('sha256').update(contents).digest('hex'),
      encrypted: false,
      createdAt: Date.now(),
      metadata: { groupId: 716 },
    };
    store.storeManifest(manifest, { provenance: 'remote_downloaded' });
    await store.storeByteRangeAsync(manifest.fileHash, 0, contents.length, corruptContents);
    const onProgress = vi.fn();
    const transfer = new ReticulumResourceTransferManager<Record<string, never>>({
      resourceStore: store,
      buildRequestPayloads: async () => [],
      onProgress,
    });
    transfers.push(transfer);
    const state = (transfer as any).upsertDownload(
      716,
      manifest,
      undefined,
      ['bad-provider', 'alternate-provider']
    );
    const offer = {
      transferId: 'corrupt-assembly',
      contextId: 716,
      fileHash: manifest.fileHash,
      totalSizeBytes: contents.length,
      sizeBytes: contents.length,
      fileName: 'integrity.bin',
      mimeType: manifest.mimeType,
      ranges: [{ startByte: 0, endByteExclusive: contents.length }],
      sourcePeerHash: 'bad-provider',
    };

    await (transfer as any).handleReceivedRange(offer);

    expect(store.getCompletedBytes(manifest.fileHash)).toBe(0);
    expect(state.peerHashes.has('bad-provider')).toBe(false);
    expect(state.rejectedPeerHashes.has('bad-provider')).toBe(true);
    expect(state.peerHashes.has('alternate-provider')).toBe(true);
    expect(state.missingRanges.size).toBe(1);
    expect(state.waitingForProvider).toBe(false);
    expect((transfer as any).downloads.has(manifest.fileHash)).toBe(true);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bytesTransferred: 0,
        progress: 0,
        complete: false,
        failed: false,
        reset: true,
      })
    );
  });
});
