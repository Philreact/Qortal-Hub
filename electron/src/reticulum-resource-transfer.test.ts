import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { ReticulumResourceStore, type ReticulumResourceManifest } from './reticulum-resource-store';
import {
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
});
