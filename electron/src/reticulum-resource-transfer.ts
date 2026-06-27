import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import * as path from 'path';
import type { ReticulumBridge, ReticulumSendResult } from './reticulum-bridge';
import {
  RETICULUM_RESOURCE_MAX_RANGE_SIZE,
  RETICULUM_RESOURCE_RANGE_SIZE,
  ReticulumResourceStore,
  type ReticulumResourceManifest,
} from './reticulum-resource-store';
import { log as loggerLog, warn as loggerWarn } from './logger';

export const RETICULUM_RESOURCE_TRANSFER_RANGE_BYTES = RETICULUM_RESOURCE_RANGE_SIZE;
export const RETICULUM_RESOURCE_TRANSFER_ACCEPT_CONCURRENCY = 4;
export const RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER = 1;
export const RETICULUM_RESOURCE_TRANSFER_RETRY_MS = 5_000;
export const RETICULUM_RESOURCE_TRANSFER_MAX_RANGE_ATTEMPTS = 6;
export const RETICULUM_RESOURCE_TRANSFER_TTL_MS = 10 * 60 * 1000;
export const RETICULUM_RESOURCE_TRANSFER_PULL_THROTTLE_MS = 15_000;
export const RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS = 180_000;
export const RETICULUM_RESOURCE_TRANSFER_RESPONSE_TIMEOUT_MS = 45_000;
export const RETICULUM_RESOURCE_TRANSFER_OVERLAY_STALE_THROTTLE_MS = 30_000;
export const RETICULUM_RESOURCE_TRANSFER_OVERLAY_THROTTLE_RETRY_MS = 5_000;
const RETICULUM_RESOURCE_TRANSFER_ACCEPT_STALE_MS = 180_000;
const RETICULUM_RESOURCE_TRANSFER_SPEED_LOG_MS = 5_000;

export type ReticulumResourceByteRange = {
  startByte: number;
  endByteExclusive: number;
};

export type ReticulumResourceTransferRequest = {
  eventId?: string;
  fileHash: string;
  ranges: ReticulumResourceByteRange[];
  requesterAddress?: string;
  requesterPeerHash?: string;
  relayRequestId?: string;
};

export type ReticulumResourceTransferOffer = {
  transferId: string;
  contextId: number;
  eventId?: string;
  fileHash: string;
  totalSizeBytes: number;
  sizeBytes: number;
  fileName: string;
  mimeType: string;
  ranges: ReticulumResourceByteRange[];
  payloadHash: string;
  sourcePeerHash?: string;
  relayRequestId?: string;
  temporaryPath?: string;
  receiveTemporaryPath?: string;
};

export type ReticulumResourceTransferPayload = {
  status?: string;
  transferId?: string;
  path?: string;
  linkId?: string;
  auth?: Record<string, unknown>;
  progress?: number;
  bytesTransferred?: number;
  bytesPerSecond?: number;
  reason?: string;
};

export type ReticulumResourceTransferProgress = {
  contextId: number;
  eventId?: string;
  fileHash: string;
  bytesTransferred?: number;
  totalBytes?: number;
  progress?: number;
  complete?: boolean;
  failed?: boolean;
  canceled?: boolean;
};

export type ReticulumResourceDownloadRuntimeStatus = {
  active: boolean;
  peerCount: number;
  candidatePeerCount: number;
  advertisedPeerCount: number;
  activeTransfers: number;
  pendingTransfers: number;
  requestedRangeCount: number;
  inFlightRangeCount: number;
  bytesTransferred?: number;
  totalBytes?: number;
  progress?: number;
  currentBytesPerSecond: number;
  averageBytesPerSecond: number;
  nextRequestAt: number | null;
};

type ReticulumResourceDownloadState<TRequestWire> = {
  contextId: number;
  fileHash: string;
  eventId?: string;
  manifest: ReticulumResourceManifest;
  peerHashes: Set<string>;
  sourcePeerHashes: Set<string>;
  rangeAttempts: Map<string, number>;
  rangePeers: Map<string, Set<string>>;
  inFlightRanges: Map<string, { transferId: string; startedAt: number }>;
  peerBulkThrottleUntil: Map<string, number>;
  peerBulkThrottleLoggedAt: Map<string, number>;
  nextRequestAt: number;
  featureData?: Record<string, unknown>;
};

type TransferSpeedSample = {
  at: number;
  bytes: number;
  loggedAt: number;
  startedAt: number;
  bytesPerSecond: number;
};

export type ReticulumResourceTransferOptions<TRequestWire> = {
  bridge?: ReticulumBridge | null;
  resourceStore: ReticulumResourceStore;
  now?: () => number;
  loggerPrefix?: string;
  resourceType?: string;
  rangeResourceType?: string;
  authMessageType?: string;
  contextMetadataKey?: string;
  buildRequestPayloads: (
    state: {
      contextId: number;
      eventId?: string;
      manifest: ReticulumResourceManifest;
      featureData?: Record<string, unknown>;
    },
    ranges: ReticulumResourceByteRange[]
  ) => Promise<TRequestWire[]>;
  sendRequestToPeer: (
    peerHash: string,
    contextId: number,
    request: TRequestWire
  ) => Promise<ReticulumSendResult>;
  fanoutRequest: (
    contextId: number,
    request: TRequestWire
  ) => Promise<ReticulumSendResult>;
  sendOfferToPeer: (
    peerHash: string,
    contextId: number,
    offer: ReticulumResourceTransferOffer
  ) => Promise<ReticulumSendResult>;
  canServeRequest?: (
    contextId: number,
    request: ReticulumResourceTransferRequest,
    manifest: ReticulumResourceManifest
  ) => boolean | Promise<boolean>;
  canAcceptOffer?: (
    contextId: number,
    offer: ReticulumResourceTransferOffer,
    manifest: ReticulumResourceManifest
  ) => boolean | Promise<boolean>;
  onProgress?: (progress: ReticulumResourceTransferProgress) => void;
};

function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatBytesPerSecond(bytesPerSecond: number): string {
  return `${formatByteCount(bytesPerSecond)}/s`;
}

function rangeKey(range: ReticulumResourceByteRange): string {
  return `${range.startByte}:${range.endByteExclusive}`;
}

function normalizeRange(range: ReticulumResourceByteRange): ReticulumResourceByteRange {
  return {
    startByte: Math.floor(range.startByte),
    endByteExclusive: Math.floor(range.endByteExclusive),
  };
}

function rangeSize(range: ReticulumResourceByteRange): number {
  return Math.max(0, range.endByteExclusive - range.startByte);
}

function validRangeForManifest(
  manifest: ReticulumResourceManifest,
  range: ReticulumResourceByteRange
): boolean {
  return (
    Number.isInteger(range.startByte) &&
    Number.isInteger(range.endByteExclusive) &&
    range.startByte >= 0 &&
    range.endByteExclusive > range.startByte &&
    range.endByteExclusive <= manifest.sizeBytes &&
    rangeSize(range) <= RETICULUM_RESOURCE_MAX_RANGE_SIZE
  );
}

function mergeRanges(ranges: ReticulumResourceByteRange[]): ReticulumResourceByteRange[] {
  const sorted = ranges
    .map(normalizeRange)
    .filter((range) => range.endByteExclusive > range.startByte)
    .sort((a, b) => a.startByte - b.startByte || a.endByteExclusive - b.endByteExclusive);
  const merged: ReticulumResourceByteRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.startByte <= previous.endByteExclusive) {
      previous.endByteExclusive = Math.max(previous.endByteExclusive, range.endByteExclusive);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export class ReticulumResourceTransferManager<TRequestWire> extends EventEmitter {
  private bridge: ReticulumBridge | null;
  private readonly resourceStore: ReticulumResourceStore;
  private readonly now: () => number;
  private readonly loggerPrefix: string;
  private readonly rangeResourceType: string;
  private readonly authMessageType: string;
  private readonly contextMetadataKey?: string;
  private readonly buildRequestPayloads: ReticulumResourceTransferOptions<TRequestWire>['buildRequestPayloads'];
  private readonly sendRequestToPeer: ReticulumResourceTransferOptions<TRequestWire>['sendRequestToPeer'];
  private readonly fanoutRequest: ReticulumResourceTransferOptions<TRequestWire>['fanoutRequest'];
  private readonly sendOfferToPeer: ReticulumResourceTransferOptions<TRequestWire>['sendOfferToPeer'];
  private readonly canServeRequest?: ReticulumResourceTransferOptions<TRequestWire>['canServeRequest'];
  private readonly canAcceptOffer?: ReticulumResourceTransferOptions<TRequestWire>['canAcceptOffer'];
  private readonly onProgress?: ReticulumResourceTransferOptions<TRequestWire>['onProgress'];
  private readonly downloads = new Map<string, ReticulumResourceDownloadState<TRequestWire>>();
  private readonly offers = new Map<string, ReticulumResourceTransferOffer>();
  private readonly requestedResources = new Map<string, number>();
  private readonly pendingAccepts: string[] = [];
  private readonly pendingAcceptQueuedAt = new Map<string, number>();
  private readonly activeAccepts = new Set<string>();
  private readonly activeAcceptStartedAt = new Map<string, number>();
  private readonly transferSpeedSamples = new Map<string, TransferSpeedSample>();
  private downloadTimer: ReturnType<typeof setTimeout> | null = null;
  private schedulerActive = false;

  constructor(options: ReticulumResourceTransferOptions<TRequestWire>) {
    super();
    this.bridge = options.bridge ?? null;
    this.resourceStore = options.resourceStore;
    this.now = options.now ?? Date.now;
    this.loggerPrefix = options.loggerPrefix ?? 'ReticulumResourceTransfer';
    this.rangeResourceType = options.rangeResourceType ?? 'reticulum_resource_range';
    this.authMessageType = options.authMessageType ?? 'RETICULUM_RESOURCE_AUTH';
    this.contextMetadataKey = options.contextMetadataKey;
    this.buildRequestPayloads = options.buildRequestPayloads;
    this.sendRequestToPeer = options.sendRequestToPeer;
    this.fanoutRequest = options.fanoutRequest;
    this.sendOfferToPeer = options.sendOfferToPeer;
    this.canServeRequest = options.canServeRequest;
    this.canAcceptOffer = options.canAcceptOffer;
    this.onProgress = options.onProgress;
  }

  setBridge(bridge: ReticulumBridge | null): void {
    this.bridge = bridge;
  }

  close(): void {
    if (this.downloadTimer) {
      clearTimeout(this.downloadTimer);
      this.downloadTimer = null;
    }
    for (const offer of this.offers.values()) {
      this.cleanupTemporaryOfferFile(offer);
    }
    this.downloads.clear();
    this.offers.clear();
    this.requestedResources.clear();
    this.pendingAccepts.length = 0;
    this.pendingAcceptQueuedAt.clear();
    this.activeAccepts.clear();
    this.activeAcceptStartedAt.clear();
    this.transferSpeedSamples.clear();
  }

  getDownloadStatus(fileHash: string): ReticulumResourceDownloadRuntimeStatus {
    const blobId = String(fileHash || '').trim().toLowerCase();
    const state = this.downloads.get(blobId);
    if (!state) {
      return this.emptyDownloadStatus(blobId);
    }
    this.cleanupStaleAccepts();
    this.releaseStaleInFlightRanges(state);
    const advertisedPeers = new Set<string>();
    for (const peers of state.rangePeers.values()) {
      for (const peer of peers) {
        const peerKey = peer.trim().toLowerCase();
        if (peerKey) advertisedPeers.add(peerKey);
      }
    }
    for (const peer of state.sourcePeerHashes) {
      const peerKey = peer.trim().toLowerCase();
      if (peerKey) advertisedPeers.add(peerKey);
    }
    let activeTransfers = 0;
    for (const transferId of this.activeAccepts) {
      if (this.offers.get(transferId)?.fileHash.toLowerCase() === blobId) {
        activeTransfers += 1;
      }
    }
    let pendingTransfers = 0;
    for (const transferId of this.pendingAccepts) {
      if (this.offers.get(transferId)?.fileHash.toLowerCase() === blobId) {
        pendingTransfers += 1;
      }
    }
    let currentBytesPerSecond = 0;
    let activeSampleBytes = 0;
    let oldestStartedAt = 0;
    for (const transferId of this.activeAccepts) {
      const offer = this.offers.get(transferId);
      if (offer?.fileHash.toLowerCase() !== blobId) continue;
      const sample = this.transferSpeedSamples.get(transferId);
      if (!sample) continue;
      currentBytesPerSecond += Math.max(0, sample.bytesPerSecond || 0);
      activeSampleBytes += Math.max(0, sample.bytes || 0);
      oldestStartedAt = oldestStartedAt === 0
        ? sample.startedAt
        : Math.min(oldestStartedAt, sample.startedAt);
    }
    const totalBytes = Math.max(0, Math.floor(Number(state.manifest.sizeBytes) || 0));
    const completedBytes = this.resourceStore.getCompletedBytes(blobId);
    const bytesTransferred =
      totalBytes > 0
        ? Math.max(0, Math.min(totalBytes, completedBytes + activeSampleBytes))
        : 0;
    const elapsedMs = oldestStartedAt > 0 ? Math.max(1, this.now() - oldestStartedAt) : 0;
    return {
      active: true,
      peerCount: state.sourcePeerHashes.size,
      candidatePeerCount: state.peerHashes.size,
      advertisedPeerCount: advertisedPeers.size,
      activeTransfers,
      pendingTransfers,
      requestedRangeCount: state.rangeAttempts.size,
      inFlightRangeCount: state.inFlightRanges.size,
      bytesTransferred,
      totalBytes,
      progress: totalBytes > 0 ? bytesTransferred / totalBytes : 0,
      currentBytesPerSecond,
      averageBytesPerSecond:
        elapsedMs > 0 ? (bytesTransferred * 1000) / elapsedMs : 0,
      nextRequestAt: state.nextRequestAt || null,
    };
  }

  requestResource(options: {
    contextId: number;
    manifest: ReticulumResourceManifest;
    eventId?: string;
    candidatePeers?: string[];
    featureData?: Record<string, unknown>;
  }): void {
    const blobId = options.manifest.fileHash.toLowerCase();
    const manifest: ReticulumResourceManifest = {
      ...options.manifest,
      fileHash: blobId,
    };
    this.resourceStore.storeManifest(manifest);
    try {
      this.resourceStore.assembleResource(blobId);
      return;
    } catch {
      // Missing bytes are expected; continue into network retrieval.
    }
    this.resourceStore.ensurePartialFile(blobId);
    const existingDownload = this.downloads.get(blobId);
    const state = this.upsertDownload(
      options.contextId,
      manifest,
      options.eventId,
      options.candidatePeers ?? [],
      options.featureData
    );
    if (!existingDownload || state.nextRequestAt <= this.now()) {
      state.nextRequestAt = 0;
    }
    this.emitProgress(state);
    this.scheduleDownload(Math.max(0, state.nextRequestAt - this.now()));
  }

  cancelResource(fileHash: string, reason = 'user_cancelled'): boolean {
    const blobId = String(fileHash || '').trim().toLowerCase();
    if (!blobId) return false;
    const state = this.downloads.get(blobId);
    const transferIds = new Set<string>();
    for (const [transferId, offer] of this.offers.entries()) {
      if (offer.fileHash.toLowerCase() === blobId) {
        transferIds.add(transferId);
      }
    }
    if (!state && transferIds.size === 0) return false;

    if (state) {
      const payload: ReticulumResourceTransferProgress = {
        contextId: state.contextId,
        eventId: state.eventId,
        fileHash: state.fileHash,
        bytesTransferred: 0,
        totalBytes: state.manifest.sizeBytes,
        progress: 0,
        complete: false,
        failed: false,
        canceled: true,
      };
      this.emit('progress', payload);
      this.onProgress?.(payload);
      state.inFlightRanges.clear();
      state.rangeAttempts.clear();
      this.downloads.delete(blobId);
    }
    this.resourceStore.discardResourceData(blobId);

    for (const key of [...this.requestedResources.keys()]) {
      if (key.includes(blobId)) this.requestedResources.delete(key);
    }

    for (let index = this.pendingAccepts.length - 1; index >= 0; index -= 1) {
      const transferId = this.pendingAccepts[index];
      if (!transferIds.has(transferId)) continue;
      this.pendingAccepts.splice(index, 1);
      this.pendingAcceptQueuedAt.delete(transferId);
    }

    for (const transferId of transferIds) {
      const offer = this.offers.get(transferId);
      if (offer) this.cleanupTemporaryOfferFile(offer);
      this.offers.delete(transferId);
      this.transferSpeedSamples.delete(transferId);
      this.activeAccepts.delete(transferId);
      this.activeAcceptStartedAt.delete(transferId);
      const cancelPromise = this.bridge?.cancelReticulumResourceDetailed?.({
        transferId,
        peerPresenceHash: offer?.sourcePeerHash,
        reason,
      });
      if (cancelPromise) {
        void cancelPromise.catch((err) => {
          loggerWarn(
            `[${this.loggerPrefix}] Failed to cancel bridge resource transfer=${transferId}:`,
            err
          );
        });
      }
    }

    loggerLog(
      `[${this.loggerPrefix}] resource_download_cancelled fileHash=${blobId} ` +
        `transfers=${transferIds.size} reason=${reason}`
    );
    void this.processAcceptQueue();
    return true;
  }

  async handleRequest(
    contextId: number,
    request: ReticulumResourceTransferRequest,
    peerHash: string
  ): Promise<void> {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey || !this.bridge) return;
    const recipientPeerKey = (request.requesterPeerHash || peerKey).trim().toLowerCase();
    if (!recipientPeerKey) return;
    const manifest = this.resourceStore.getManifest(request.fileHash);
    if (!manifest || manifest.fileHash.toLowerCase() !== request.fileHash.toLowerCase()) {
      loggerWarn(
        `[${this.loggerPrefix}] Cannot serve resource request fileHash=${request.fileHash}: manifest not found`
      );
      return;
    }
    if (this.canServeRequest) {
      const allowed = await this.canServeRequest(contextId, request, manifest);
      if (!allowed) {
        loggerWarn(
          `[${this.loggerPrefix}] Cannot serve resource request fileHash=${request.fileHash}: request not allowed`
        );
        return;
      }
    }
    let sourcePath = '';
    try {
      sourcePath = this.resourceStore.assembleResource(manifest.fileHash);
    } catch {
      loggerWarn(
        `[${this.loggerPrefix}] Cannot serve resource request fileHash=${request.fileHash}: complete file unavailable`
      );
      return;
    }
    if (!sourcePath) return;
    const ranges = mergeRanges(request.ranges || [])
      .filter((range) => validRangeForManifest(manifest, range))
      .slice(0, 1);
    if (ranges.length === 0) {
      loggerWarn(
        `[${this.loggerPrefix}] Cannot serve resource request fileHash=${request.fileHash}: no valid ranges`
      );
      return;
    }
    for (const range of ranges) {
      const rangePayload = this.resourceStore.readByteRange(
        manifest.fileHash,
        range.startByte,
        range.endByteExclusive
      );
      const transferId = nodeCrypto.randomBytes(8).toString('hex');
      const fileName = `${manifest.fileHash}.range-${range.startByte}-${range.endByteExclusive}.bin`;
      const registered = await this.bridge.sendReticulumResourceDetailed({
        allowedRecipientAddress: recipientPeerKey,
        transferId,
        filePath: rangePayload.path,
        fileName,
        size: rangePayload.sizeBytes,
        sha256: rangePayload.sha256,
        resourceType: this.rangeResourceType,
        metadata: {
          logicalResourceType: this.rangeResourceType,
          eventId: request.eventId ?? '',
          contextId,
          ...this.contextMetadata(contextId),
          fileHash: manifest.fileHash,
          totalSizeBytes: manifest.sizeBytes,
          byteRanges: [[range.startByte, range.endByteExclusive]],
          payloadHash: rangePayload.sha256,
          mimeType: manifest.mimeType,
          namespace: manifest.namespace,
        },
        expiresAt: this.now() + RETICULUM_RESOURCE_TRANSFER_TTL_MS,
      });
      if (!registered.ok) {
        const failed = registered as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[${this.loggerPrefix}] Failed to register byte range offer fileHash=${manifest.fileHash} range=${rangeKey(range)}:`,
          failed.error ?? failed.reason
        );
        this.cleanupTemporaryPath(rangePayload.path);
        continue;
      }
      const offer: ReticulumResourceTransferOffer = {
        transferId,
        contextId,
        ...(request.eventId ? { eventId: request.eventId } : {}),
        fileHash: manifest.fileHash,
        totalSizeBytes: manifest.sizeBytes,
        sizeBytes: rangePayload.sizeBytes,
        fileName,
        mimeType: manifest.mimeType,
        ranges: [range],
        payloadHash: rangePayload.sha256,
        temporaryPath: rangePayload.path,
        ...(request.relayRequestId ? { relayRequestId: request.relayRequestId } : {}),
      };
      this.offers.set(transferId, { ...offer, sourcePeerHash: peerKey });
      loggerLog(
        `[${this.loggerPrefix}] resource_range_streaming fileHash=${manifest.fileHash} ` +
          `peer=${peerKey.slice(0, 16)} transfer=${transferId} range=${rangeKey(range)} ` +
          `bytes=${rangePayload.sizeBytes}`
      );
      const sent = await this.sendOfferToPeer(peerKey, contextId, offer);
      if (!sent.ok) {
        const failed = sent as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[${this.loggerPrefix}] Failed to send byte range offer fileHash=${manifest.fileHash} range=${rangeKey(range)}:`,
          failed.error ?? failed.reason
        );
        this.cleanupTemporaryOfferFile(offer);
        this.offers.delete(transferId);
      }
    }
  }

  async handleOffer(offer: ReticulumResourceTransferOffer, peerHash: string): Promise<void> {
    if (!this.isValidOffer(offer)) return;
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return;
    this.cleanupStaleAccepts(false);
    const download = this.downloads.get(offer.fileHash.toLowerCase());
    if (download) this.releaseStaleInFlightRanges(download);
    const manifest = download?.manifest ?? this.resourceStore.getManifest(offer.fileHash);
    if (!manifest || manifest.fileHash.toLowerCase() !== offer.fileHash.toLowerCase()) {
      loggerWarn(
        `[${this.loggerPrefix}] Ignoring resource offer fileHash=${offer.fileHash}: manifest not found`
      );
      return;
    }
    const sourcePeerKey = (offer.sourcePeerHash || peerKey).trim().toLowerCase();
    if (!sourcePeerKey) return;
    if (this.canAcceptOffer) {
      const allowed = await this.canAcceptOffer(offer.contextId, offer, manifest);
      if (!allowed) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${offer.fileHash}: offer not allowed`
        );
        return;
      }
    }
    const ranges = mergeRanges(offer.ranges);
    if (
      ranges.length !== 1 ||
      ranges.some((range) => !validRangeForManifest(manifest, range))
    ) {
      loggerWarn(
        `[${this.loggerPrefix}] Ignoring resource offer fileHash=${offer.fileHash}: invalid byte ranges`
      );
      return;
    }
    const range = ranges[0];
    if (offer.sizeBytes !== rangeSize(range)) {
      loggerWarn(
        `[${this.loggerPrefix}] Ignoring resource offer fileHash=${offer.fileHash}: size mismatch`
      );
      return;
    }
    if (this.rangeAlreadyComplete(manifest.fileHash, range)) return;
    if (download?.inFlightRanges.has(rangeKey(range))) return;
    if (this.peerHasMaxActiveOrPendingAcceptsForResource(sourcePeerKey, offer.fileHash)) return;
    const trackedOffer: ReticulumResourceTransferOffer = {
      ...offer,
      totalSizeBytes: manifest.sizeBytes,
      fileName: offer.fileName || manifest.fileName,
      mimeType: offer.mimeType || manifest.mimeType,
      ranges,
      sourcePeerHash: sourcePeerKey,
    };
    this.offers.set(offer.transferId, trackedOffer);
    if (download) {
      download.peerHashes.add(sourcePeerKey);
      download.sourcePeerHashes.add(sourcePeerKey);
      for (const offeredRange of ranges) {
        let peers = download.rangePeers.get(rangeKey(offeredRange));
        if (!peers) {
          peers = new Set<string>();
          download.rangePeers.set(rangeKey(offeredRange), peers);
        }
        peers.add(sourcePeerKey);
      }
    }
    this.enqueueAccept(offer.transferId);
  }

  handleResourceEvent(payload: ReticulumResourceTransferPayload): void {
    if (payload?.status === 'auth' && payload.linkId && payload.transferId) {
      void this.authorize(payload);
      return;
    }
    if (payload?.status === 'receiving' && payload.transferId) {
      this.handleTransferProgress(payload);
      return;
    }
    if (payload?.status === 'failed' && payload.transferId) {
      this.finishTransfer(payload.transferId, false);
      return;
    }
    if (payload?.status === 'sent' && payload.transferId) {
      this.finishTransfer(payload.transferId, true);
      return;
    }
    if (payload?.status !== 'received' || !payload.path || !payload.transferId) return;
    void this.importReceived(payload);
  }

  private emptyDownloadStatus(fileHash = ''): ReticulumResourceDownloadRuntimeStatus {
    const manifest = fileHash ? this.resourceStore.getManifest(fileHash) : null;
    const totalBytes = Math.max(0, Number(manifest?.sizeBytes || 0));
    const bytesTransferred = fileHash ? this.resourceStore.getCompletedBytes(fileHash) : 0;
    return {
      active: false,
      peerCount: 0,
      candidatePeerCount: 0,
      advertisedPeerCount: 0,
      activeTransfers: 0,
      pendingTransfers: 0,
      requestedRangeCount: 0,
      inFlightRangeCount: 0,
      bytesTransferred,
      totalBytes,
      progress: totalBytes > 0 ? Math.min(1, bytesTransferred / totalBytes) : 0,
      currentBytesPerSecond: 0,
      averageBytesPerSecond: 0,
      nextRequestAt: null,
    };
  }

  private upsertDownload(
    contextId: number,
    manifest: ReticulumResourceManifest,
    eventId: string | undefined,
    peerHashes: string[],
    featureData?: Record<string, unknown>
  ): ReticulumResourceDownloadState<TRequestWire> {
    const blobId = manifest.fileHash.toLowerCase();
    const existing = this.downloads.get(blobId);
    if (existing) {
      existing.contextId = contextId;
      existing.eventId = eventId || existing.eventId;
      existing.manifest = manifest;
      existing.featureData = featureData ?? existing.featureData;
      for (const peer of peerHashes) {
        const peerKey = peer.trim().toLowerCase();
        if (peerKey) existing.peerHashes.add(peerKey);
      }
      return existing;
    }
    const state: ReticulumResourceDownloadState<TRequestWire> = {
      contextId,
      fileHash: blobId,
      ...(eventId ? { eventId } : {}),
      manifest,
      peerHashes: new Set(peerHashes.map((peer) => peer.trim().toLowerCase()).filter(Boolean)),
      sourcePeerHashes: new Set(),
      rangeAttempts: new Map(),
      rangePeers: new Map(),
      inFlightRanges: new Map(),
      peerBulkThrottleUntil: new Map(),
      peerBulkThrottleLoggedAt: new Map(),
      nextRequestAt: 0,
      ...(featureData ? { featureData } : {}),
    };
    this.downloads.set(blobId, state);
    return state;
  }

  private scheduleDownload(delayMs = RETICULUM_RESOURCE_TRANSFER_RETRY_MS): void {
    if (this.downloadTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.downloadTimer);
      this.downloadTimer = null;
    }
    this.downloadTimer = setTimeout(() => {
      this.downloadTimer = null;
      void this.processDownloads();
    }, Math.max(0, delayMs));
    this.downloadTimer.unref?.();
  }

  private async processDownloads(): Promise<void> {
    if (this.schedulerActive) return;
    this.schedulerActive = true;
    try {
      this.cleanupStaleAccepts(false);
      const now = this.now();
      let nextDelay: number | null = null;
      for (const state of this.downloads.values()) {
        if (state.nextRequestAt > now) {
          const delay = state.nextRequestAt - now;
          nextDelay = nextDelay === null ? delay : Math.min(nextDelay, delay);
          continue;
        }
        await this.dispatchRequests(state);
      }
      if (this.downloads.size > 0) {
        this.scheduleDownload(nextDelay ?? RETICULUM_RESOURCE_TRANSFER_RETRY_MS);
      }
    } finally {
      this.schedulerActive = false;
    }
  }

  private async dispatchRequests(state: ReticulumResourceDownloadState<TRequestWire>): Promise<void> {
    this.releaseStaleInFlightRanges(state);
    const missing = this.getMissingRanges(state.manifest).filter((range) => {
      if (state.inFlightRanges.has(rangeKey(range))) return false;
      const attempts = state.rangeAttempts.get(rangeKey(range)) ?? 0;
      return attempts < RETICULUM_RESOURCE_TRANSFER_MAX_RANGE_ATTEMPTS;
    });
    if (missing.length === 0) {
      try {
        this.resourceStore.assembleResource(state.fileHash);
        this.emitProgress(state, true);
        this.downloads.delete(state.fileHash);
      } catch {
        this.emitProgress(state);
      }
      return;
    }
    let delivered = false;
    const knownPeers = [...state.peerHashes]
      .map((peer) => peer.trim().toLowerCase())
      .filter(Boolean);
    const availablePeers = knownPeers.filter(
      (peer) => !this.peerHasMaxActiveOrPendingAcceptsForResource(peer, state.fileHash)
    );
    if (knownPeers.length > 0 && availablePeers.length === 0) {
      state.nextRequestAt = this.now() + RETICULUM_RESOURCE_TRANSFER_RETRY_MS;
      this.emitProgress(state);
      return;
    }
    const requestedRanges: ReticulumResourceByteRange[] = [];
    let throttledPeerCount = 0;
    const assigned = new Set<string>();
    for (const peerKey of availablePeers) {
      if (this.shouldThrottlePeerForBulk(state, peerKey)) {
        throttledPeerCount += 1;
        continue;
      }
      const requestRange =
        missing.find(
          (range) => !assigned.has(rangeKey(range)) && (state.rangePeers.get(rangeKey(range))?.has(peerKey) ?? false)
        ) ?? missing.find((range) => !assigned.has(rangeKey(range)));
      if (!requestRange) continue;
      assigned.add(rangeKey(requestRange));
      const requests = await this.buildRequestPayloads(state, [requestRange]);
      if (requests.length === 0) {
        loggerWarn(
          `[${this.loggerPrefix}] Could not build targeted range request fileHash=${state.fileHash} peer=${peerKey}`
        );
      }
      for (const request of requests) {
        const throttleKey = `${state.contextId}:${peerKey}:${state.fileHash}:${rangeKey(requestRange)}`;
        const now = this.now();
        if (now - (this.requestedResources.get(throttleKey) ?? 0) < RETICULUM_RESOURCE_TRANSFER_PULL_THROTTLE_MS) {
          continue;
        }
        this.requestedResources.set(throttleKey, now);
        loggerLog(
          `[${this.loggerPrefix}] resource_range_requested fileHash=${state.fileHash} ` +
            `peer=${peerKey.slice(0, 16)} range=${rangeKey(requestRange)}`
        );
        const result = await this.sendRequestToPeer(peerKey, state.contextId, request);
        if (result.ok) {
          delivered = true;
          requestedRanges.push(requestRange);
        } else {
          const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
          loggerWarn(
            `[${this.loggerPrefix}] Targeted range request failed fileHash=${state.fileHash} peer=${peerKey} range=${rangeKey(requestRange)}:`,
            failed.error ?? failed.reason
          );
        }
      }
    }
    if (!delivered && throttledPeerCount > 0) {
      state.nextRequestAt = this.now() + RETICULUM_RESOURCE_TRANSFER_OVERLAY_THROTTLE_RETRY_MS;
      this.emitProgress(state);
      return;
    }
    if (!delivered) {
      const requestRange = missing[0];
      const requests = await this.buildRequestPayloads(state, [requestRange]);
      if (requests.length === 0) {
        loggerWarn(
          `[${this.loggerPrefix}] Could not build range fanout request fileHash=${state.fileHash}`
        );
      }
      for (const request of requests) {
        loggerLog(
          `[${this.loggerPrefix}] resource_range_requested fileHash=${state.fileHash} ` +
            `peer=fanout range=${rangeKey(requestRange)}`
        );
        const result = await this.fanoutRequest(state.contextId, request);
        if (result.ok) {
          delivered = true;
          requestedRanges.push(requestRange);
        } else {
          const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
          loggerWarn(
            `[${this.loggerPrefix}] Range fanout request failed fileHash=${state.fileHash} range=${rangeKey(requestRange)}:`,
            failed.error ?? failed.reason
          );
        }
      }
    }
    for (const range of requestedRanges) {
      state.rangeAttempts.set(rangeKey(range), (state.rangeAttempts.get(rangeKey(range)) ?? 0) + 1);
    }
    state.nextRequestAt = delivered
      ? this.now() + RETICULUM_RESOURCE_TRANSFER_RESPONSE_TIMEOUT_MS
      : this.now() + RETICULUM_RESOURCE_TRANSFER_RETRY_MS;
    this.emitProgress(state);
  }

  private overlayPeerLastRxAgeMs(peerHash: string): number | null {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey || !this.bridge) return null;
    const snapshots = this.bridge.getOverlayLinkSnapshots?.();
    if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
    let lastRxAt = 0;
    for (const snap of snapshots) {
      if ((snap.peerPresenceHash || '').trim().toLowerCase() !== peerKey) continue;
      if (Number.isFinite(snap.lastRxAt) && snap.lastRxAt > lastRxAt) {
        lastRxAt = snap.lastRxAt;
      }
    }
    return lastRxAt > 0 ? Math.max(0, this.now() - lastRxAt) : null;
  }

  private shouldThrottlePeerForBulk(
    state: ReticulumResourceDownloadState<TRequestWire>,
    peerHash: string
  ): boolean {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return false;
    const now = this.now();
    const throttledUntil = state.peerBulkThrottleUntil.get(peerKey) ?? 0;
    if (throttledUntil > now) {
      return true;
    }
    const lastRxAgeMs = this.overlayPeerLastRxAgeMs(peerHash);
    if (
      lastRxAgeMs == null ||
      lastRxAgeMs < RETICULUM_RESOURCE_TRANSFER_OVERLAY_STALE_THROTTLE_MS
    ) {
      state.peerBulkThrottleUntil.delete(peerKey);
      state.peerBulkThrottleLoggedAt.delete(peerKey);
      return false;
    }
    state.peerBulkThrottleUntil.set(
      peerKey,
      now + RETICULUM_RESOURCE_TRANSFER_OVERLAY_THROTTLE_RETRY_MS
    );
    const lastLoggedAt = state.peerBulkThrottleLoggedAt.get(peerKey) ?? 0;
    if (
      lastLoggedAt === 0 ||
      now - lastLoggedAt >= RETICULUM_RESOURCE_TRANSFER_OVERLAY_THROTTLE_RETRY_MS
    ) {
      state.peerBulkThrottleLoggedAt.set(peerKey, now);
      loggerLog(
        `[${this.loggerPrefix}] resource_session_throttled fileHash=${state.fileHash} ` +
          `peer=${peerKey.slice(0, 16)} overlayLastRxAgeMs=${Math.round(lastRxAgeMs)} ` +
          `retryMs=${RETICULUM_RESOURCE_TRANSFER_OVERLAY_THROTTLE_RETRY_MS}`
      );
    }
    return true;
  }

  private emitProgress(
    state: ReticulumResourceDownloadState<TRequestWire>,
    complete = false,
    activeTransfer?: {
      offer: ReticulumResourceTransferOffer;
      progress: number;
      bytesTransferred?: number;
    },
    failed = false
  ): void {
    const totalBytes = Math.max(0, Math.floor(Number(state.manifest.sizeBytes) || 0));
    const completedBytes = this.resourceStore.getCompletedBytes(state.fileHash);
    const activeBytes =
      activeTransfer && Number.isFinite(activeTransfer.bytesTransferred)
        ? Math.max(0, Math.min(activeTransfer.offer.sizeBytes, Number(activeTransfer.bytesTransferred)))
        : 0;
    const bytesTransferred = totalBytes > 0
      ? Math.max(0, Math.min(totalBytes, completedBytes + activeBytes))
      : 0;
    const payload: ReticulumResourceTransferProgress = {
      contextId: state.contextId,
      eventId: state.eventId,
      fileHash: state.manifest.fileHash,
      bytesTransferred,
      totalBytes,
      progress: totalBytes > 0 ? bytesTransferred / totalBytes : 0,
      complete: complete || bytesTransferred >= totalBytes,
      failed,
    };
    this.emit('progress', payload);
    this.onProgress?.(payload);
  }

  private handleTransferProgress(payload: ReticulumResourceTransferPayload): void {
    const offer = this.offers.get(payload.transferId || '');
    if (!offer) return;
    const state = this.downloads.get(offer.fileHash);
    if (!state) return;
    const payloadBytes = Number(payload.bytesTransferred);
    const boundedBytes = Number.isFinite(payloadBytes) && payloadBytes >= 0
      ? Math.min(offer.sizeBytes, Math.floor(payloadBytes))
      : null;
    const progress = typeof payload.progress === 'number'
      ? Math.max(0, Math.min(1, payload.progress))
      : boundedBytes != null && offer.sizeBytes > 0
        ? boundedBytes / offer.sizeBytes
        : 0;
    this.activeAcceptStartedAt.set(offer.transferId, this.now());
    this.refreshOfferRangesInFlight(state, offer);
    this.logTransferSpeed(offer, payload);
    this.emitProgress(state, false, {
      offer,
      progress,
      bytesTransferred: boundedBytes ?? 0,
    });
  }

  private logTransferSpeed(
    offer: ReticulumResourceTransferOffer,
    payload: ReticulumResourceTransferPayload
  ): void {
    if (!offer.transferId || offer.sizeBytes <= 0) return;
    const now = this.now();
    const progress = typeof payload.progress === 'number' ? payload.progress : 0;
    const boundedProgress = Math.max(0, Math.min(1, progress));
    const payloadBytes = Number(payload.bytesTransferred);
    const bytes = Number.isFinite(payloadBytes) && payloadBytes >= 0
      ? Math.min(offer.sizeBytes, Math.floor(payloadBytes))
      : Math.floor(offer.sizeBytes * boundedProgress);
    const previous = this.transferSpeedSamples.get(offer.transferId);
    if (!previous || bytes < previous.bytes) {
      this.transferSpeedSamples.set(offer.transferId, {
        at: now,
        bytes,
        loggedAt: now,
        startedAt: now,
        bytesPerSecond: Number(payload.bytesPerSecond) || 0,
      });
      loggerLog(
        `[${this.loggerPrefix}] Download speed fileHash=${offer.fileHash} ` +
          `transfer=${offer.transferId} ` +
          `peer=${(offer.sourcePeerHash || '').slice(0, 16) || 'unknown'} ` +
          `range=${offer.ranges.map(rangeKey).join(',')} ` +
          `progress=${Math.round(boundedProgress * 100)}% ` +
          `speed=${formatBytesPerSecond(Number(payload.bytesPerSecond) || 0)} ` +
          `received=${formatByteCount(bytes)}/${formatByteCount(offer.sizeBytes)}`
      );
      return;
    }
    const elapsedMs = now - previous.at;
    const logElapsedMs = now - previous.loggedAt;
    if (
      elapsedMs <= 0 ||
      (logElapsedMs < RETICULUM_RESOURCE_TRANSFER_SPEED_LOG_MS && boundedProgress < 1)
    ) {
      return;
    }
    const payloadBytesPerSecond = Number(payload.bytesPerSecond);
    const bytesPerSecond = Number.isFinite(payloadBytesPerSecond) && payloadBytesPerSecond >= 0
      ? payloadBytesPerSecond
      : ((bytes - previous.bytes) * 1000) / elapsedMs;
    const remainingBytes = Math.max(0, offer.sizeBytes - bytes);
    const etaSeconds =
      bytesPerSecond > 0 ? Math.ceil(remainingBytes / bytesPerSecond) : null;
    loggerLog(
      `[${this.loggerPrefix}] Download speed fileHash=${offer.fileHash} ` +
        `transfer=${offer.transferId} ` +
        `peer=${(offer.sourcePeerHash || '').slice(0, 16) || 'unknown'} ` +
        `range=${offer.ranges.map(rangeKey).join(',')} ` +
        `progress=${Math.round(boundedProgress * 100)}% ` +
        `speed=${formatBytesPerSecond(bytesPerSecond)} ` +
        `received=${formatByteCount(bytes)}/${formatByteCount(offer.sizeBytes)}` +
        (etaSeconds != null ? ` eta=${etaSeconds}s` : '')
    );
    this.transferSpeedSamples.set(offer.transferId, {
      at: now,
      bytes,
      loggedAt: now,
      startedAt: previous.startedAt,
      bytesPerSecond,
    });
  }

  private enqueueAccept(transferId: string): void {
    if (this.pendingAccepts.includes(transferId) || this.activeAccepts.has(transferId)) {
      return;
    }
    this.pendingAccepts.push(transferId);
    this.pendingAcceptQueuedAt.set(transferId, this.now());
    void this.processAcceptQueue();
  }

  private async processAcceptQueue(): Promise<void> {
    this.cleanupStaleAccepts(false);
    while (
      this.activeAccepts.size < RETICULUM_RESOURCE_TRANSFER_ACCEPT_CONCURRENCY &&
      this.pendingAccepts.length > 0
    ) {
      const pendingIndex = this.pendingAccepts.findIndex((candidateTransferId) => {
        if (this.activeAccepts.has(candidateTransferId)) return false;
        const candidateOffer = this.offers.get(candidateTransferId);
        if (!candidateOffer) return true;
        return !this.peerHasMaxActiveAcceptsForResource(
          candidateOffer.sourcePeerHash || '',
          candidateOffer.fileHash
        );
      });
      if (pendingIndex < 0) break;
      const [transferId] = this.pendingAccepts.splice(pendingIndex, 1);
      if (!transferId || this.activeAccepts.has(transferId)) continue;
      this.pendingAcceptQueuedAt.delete(transferId);
      const offer = this.offers.get(transferId);
      if (!offer) continue;
      this.activeAccepts.add(transferId);
      this.activeAcceptStartedAt.set(transferId, this.now());
      const state = this.downloads.get(offer.fileHash);
      if (state) this.markOfferRangesInFlight(state, offer);
      await this.accept(offer.sourcePeerHash || '', offer);
    }
  }

  private async accept(peerHash: string, offer: ReticulumResourceTransferOffer): Promise<void> {
    if (!this.bridge) {
      this.finishTransfer(offer.transferId, false);
      return;
    }
    const senderHash = (offer.sourcePeerHash || peerHash).trim().toLowerCase();
    if (!senderHash) {
      loggerWarn(`[${this.loggerPrefix}] Cannot accept resource ${offer.fileHash}: missing sender identity`);
      this.finishTransfer(offer.transferId, false);
      return;
    }
    const savePath = this.resourceStore.createPlaintextTempPath(
      offer.fileHash,
      path.extname(offer.fileName) || '.bin'
    );
    offer.receiveTemporaryPath = savePath;
    loggerLog(
      `[${this.loggerPrefix}] resource_session_opened fileHash=${offer.fileHash} ` +
        `peer=${senderHash.slice(0, 16)} transfer=${offer.transferId} ` +
        `mode=range range=${offer.ranges.map(rangeKey).join(',')} bytes=${offer.sizeBytes}`
    );
    const result = await this.bridge.acceptReticulumResourceDetailed({
      peerPresenceHash: senderHash,
      reticulumIdentityPublicKeyBase64: '',
      transferId: offer.transferId,
      savePath,
      fileName: offer.fileName,
      size: offer.sizeBytes,
      sha256: offer.payloadHash,
      resourceType: this.rangeResourceType,
      metadata: {
        logicalResourceType: this.rangeResourceType,
        eventId: offer.eventId ?? '',
        contextId: offer.contextId,
        ...this.contextMetadata(offer.contextId),
        fileHash: offer.fileHash,
        totalSizeBytes: offer.totalSizeBytes,
        byteRanges: offer.ranges.map((range) => [range.startByte, range.endByteExclusive]),
        payloadHash: offer.payloadHash,
        mimeType: offer.mimeType,
      },
      authMessage: {
        type: this.authMessageType,
        transferId: offer.transferId,
        eventId: offer.eventId ?? '',
        contextId: offer.contextId,
        ...this.contextMetadata(offer.contextId),
        fileHash: offer.fileHash,
        totalSizeBytes: offer.totalSizeBytes,
        byteRanges: offer.ranges.map((range) => [range.startByte, range.endByteExclusive]),
        payloadHash: offer.payloadHash,
      },
    });
    if (!result.ok) {
      const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[${this.loggerPrefix}] Failed to accept resource offer fileHash=${offer.fileHash} transfer=${offer.transferId}:`,
        failed.error ?? failed.reason
      );
      this.finishTransfer(offer.transferId, false);
    }
  }

  private async authorize(payload: ReticulumResourceTransferPayload): Promise<void> {
    const transferId = typeof payload.transferId === 'string' ? payload.transferId : '';
    if (!transferId || !this.bridge) return;
    const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
    if (auth.type !== this.authMessageType) {
      loggerWarn(
        `[${this.loggerPrefix}] Rejecting resource auth transfer=${transferId}: bad auth type`
      );
      await this.bridge.rejectReticulumResourceDetailed?.({
        linkId: payload.linkId || '',
        transferId,
        reason: 'bad_auth_type',
      });
      this.finishTransfer(transferId, false);
      return;
    }
    const offer = this.offers.get(transferId);
    const authRanges = Array.isArray(auth.byteRanges)
      ? auth.byteRanges
      : [];
    const expectedRanges = offer?.ranges.map((range) => [range.startByte, range.endByteExclusive]) ?? [];
    if (
      !offer ||
      Number(auth.contextId) !== offer.contextId ||
      auth.fileHash !== offer.fileHash ||
      auth.payloadHash !== offer.payloadHash ||
      JSON.stringify(authRanges) !== JSON.stringify(expectedRanges)
    ) {
      loggerWarn(
        `[${this.loggerPrefix}] Rejecting resource auth transfer=${transferId}: metadata mismatch`
      );
      await this.bridge.rejectReticulumResourceDetailed?.({
        linkId: payload.linkId || '',
        transferId,
        reason: 'resource_auth_mismatch',
      });
      this.finishTransfer(transferId, false);
      return;
    }
    await this.bridge.authorizeReticulumResourceDetailed({
      linkId: payload.linkId || '',
      transferId,
    });
  }

  private async importReceived(payload: ReticulumResourceTransferPayload): Promise<void> {
    if (!payload.path || !payload.transferId) return;
    const offer = this.offers.get(payload.transferId);
    if (!offer) {
      await fs.promises.unlink(payload.path).catch(() => undefined);
      return;
    }
    try {
      const bytes = fs.readFileSync(payload.path);
      const actualHash = nodeCrypto.createHash('sha256').update(bytes).digest('hex');
      const pendingManifest = this.resourceStore.getManifest(offer.fileHash);
      if (!pendingManifest) {
        loggerWarn(
          `[${this.loggerPrefix}] Cannot import resource transfer=${offer.transferId}: manifest not found`
        );
        return;
      }
      if (pendingManifest.fileHash.toLowerCase() !== offer.fileHash.toLowerCase()) {
        loggerWarn(
          `[${this.loggerPrefix}] Cannot import resource transfer=${offer.transferId}: manifest file hash mismatch`
        );
        return;
      }
      if (actualHash !== offer.payloadHash.toLowerCase()) {
        loggerWarn(
          `[${this.loggerPrefix}] Cannot import resource range fileHash=${offer.fileHash}: payload hash mismatch`
        );
        return;
      }
      if (offer.ranges.length !== 1) {
        loggerWarn(
          `[${this.loggerPrefix}] Cannot import resource range fileHash=${offer.fileHash}: invalid range count`
        );
        return;
      }
      const range = offer.ranges[0];
      this.resourceStore.storeByteRange(
        offer.fileHash,
        range.startByte,
        range.endByteExclusive,
        bytes
      );
      loggerLog(
        `[${this.loggerPrefix}] resource_range_stored fileHash=${offer.fileHash} ` +
          `transfer=${offer.transferId} range=${rangeKey(range)} bytes=${bytes.length}`
      );
      this.emit('resource', {
        contextId: offer.contextId,
        eventId: offer.eventId,
        fileHash: offer.fileHash,
      });
      this.handleReceivedRange(offer);
    } catch (err) {
      loggerWarn(`[${this.loggerPrefix}] Failed to import received resource:`, err);
      this.finishTransfer(payload.transferId, false);
    } finally {
      const state = this.downloads.get(offer.fileHash);
      if (state) {
        this.releaseOfferRangesInFlight(state, offer);
      }
      this.offers.delete(payload.transferId);
      this.transferSpeedSamples.delete(payload.transferId);
      this.activeAccepts.delete(payload.transferId);
      this.activeAcceptStartedAt.delete(payload.transferId);
      void this.processAcceptQueue();
      await fs.promises.unlink(payload.path).catch(() => undefined);
    }
  }

  private finishTransfer(transferId: string, success: boolean, drainQueue = true): void {
    const offer = this.offers.get(transferId);
    if (offer) this.cleanupTemporaryOfferFile(offer);
    this.offers.delete(transferId);
    this.transferSpeedSamples.delete(transferId);
    this.activeAccepts.delete(transferId);
    this.activeAcceptStartedAt.delete(transferId);
    if (offer) {
      const state = this.downloads.get(offer.fileHash);
      if (state) {
        this.releaseOfferRangesInFlight(state, offer);
        if (!success) {
          state.nextRequestAt = 0;
          this.emitProgress(state);
          this.scheduleDownload(0);
        }
      }
    }
    if (drainQueue) void this.processAcceptQueue();
  }

  private handleReceivedRange(offer: ReticulumResourceTransferOffer): void {
    const state = this.downloads.get(offer.fileHash);
    if (!state) return;
    for (const range of offer.ranges) {
      state.rangeAttempts.delete(rangeKey(range));
    }
    this.releaseOfferRangesInFlight(state, offer);
    try {
      this.resourceStore.assembleResource(offer.fileHash);
      loggerLog(
        `[${this.loggerPrefix}] resource_session_completed fileHash=${offer.fileHash} ` +
          `transfer=${offer.transferId} mode=byte-range`
      );
      this.emitProgress(state, true);
      this.clearPendingOffersForFile(offer.fileHash, offer.transferId);
      this.downloads.delete(offer.fileHash);
      return;
    } catch {
      this.emitProgress(state);
      state.nextRequestAt = 0;
      this.scheduleDownload(0);
    }
  }

  private isValidOffer(offer: ReticulumResourceTransferOffer): boolean {
    if (typeof offer.transferId !== 'string' || !offer.transferId) return false;
    if (!Number.isInteger(offer.contextId) || offer.contextId <= 0) return false;
    if (offer.eventId != null && (typeof offer.eventId !== 'string' || offer.eventId.length < 8)) return false;
    if (typeof offer.fileHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.fileHash)) return false;
    if (!Number.isInteger(offer.totalSizeBytes) || offer.totalSizeBytes <= 0) return false;
    if (!Number.isInteger(offer.sizeBytes) || offer.sizeBytes <= 0) return false;
    if (typeof offer.payloadHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.payloadHash)) return false;
    if (!Array.isArray(offer.ranges) || offer.ranges.length !== 1) return false;
    const totalRangeBytes = offer.ranges.reduce((total, range) => total + rangeSize(range), 0);
    return totalRangeBytes === offer.sizeBytes;
  }

  private getMissingRanges(manifest: ReticulumResourceManifest): ReticulumResourceByteRange[] {
    const completed = mergeRanges(
      this.resourceStore.getCompletedRanges(manifest.fileHash).map((range) => ({
        startByte: range.startByte,
        endByteExclusive: range.endByteExclusive,
      }))
    );
    const missing: ReticulumResourceByteRange[] = [];
    let cursor = 0;
    for (const range of completed) {
      if (range.startByte > cursor) {
        missing.push(...this.splitRange(cursor, range.startByte));
      }
      cursor = Math.max(cursor, range.endByteExclusive);
    }
    if (cursor < manifest.sizeBytes) {
      missing.push(...this.splitRange(cursor, manifest.sizeBytes));
    }
    return missing;
  }

  private splitRange(startByte: number, endByteExclusive: number): ReticulumResourceByteRange[] {
    const ranges: ReticulumResourceByteRange[] = [];
    let cursor = startByte;
    while (cursor < endByteExclusive) {
      const end = Math.min(endByteExclusive, cursor + RETICULUM_RESOURCE_TRANSFER_RANGE_BYTES);
      ranges.push({ startByte: cursor, endByteExclusive: end });
      cursor = end;
    }
    return ranges;
  }

  private rangeAlreadyComplete(fileHash: string, candidate: ReticulumResourceByteRange): boolean {
    return this.resourceStore.getCompletedRanges(fileHash).some(
      (range) =>
        range.startByte <= candidate.startByte &&
        range.endByteExclusive >= candidate.endByteExclusive
    );
  }

  private markOfferRangesInFlight(
    state: ReticulumResourceDownloadState<TRequestWire>,
    offer: ReticulumResourceTransferOffer
  ): void {
    const startedAt = this.now();
    for (const range of offer.ranges) {
      state.inFlightRanges.set(rangeKey(range), {
        transferId: offer.transferId,
        startedAt,
      });
    }
  }

  private releaseOfferRangesInFlight(
    state: ReticulumResourceDownloadState<TRequestWire>,
    offer: ReticulumResourceTransferOffer
  ): void {
    for (const range of offer.ranges) {
      const reservation = state.inFlightRanges.get(rangeKey(range));
      if (reservation?.transferId === offer.transferId) {
        state.inFlightRanges.delete(rangeKey(range));
      }
    }
  }

  private refreshOfferRangesInFlight(
    state: ReticulumResourceDownloadState<TRequestWire>,
    offer: ReticulumResourceTransferOffer
  ): void {
    const now = this.now();
    for (const range of offer.ranges) {
      const reservation = state.inFlightRanges.get(rangeKey(range));
      if (reservation?.transferId === offer.transferId) {
        reservation.startedAt = now;
      }
    }
  }

  private releaseStaleInFlightRanges(state: ReticulumResourceDownloadState<TRequestWire>): void {
    const now = this.now();
    for (const [key, reservation] of state.inFlightRanges.entries()) {
      if (now - reservation.startedAt >= RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS) {
        state.inFlightRanges.delete(key);
      }
    }
  }

  private clearPendingOffersForFile(fileHash: string, exceptTransferId = ''): void {
    const blobId = fileHash.toLowerCase();
    for (let index = this.pendingAccepts.length - 1; index >= 0; index -= 1) {
      const transferId = this.pendingAccepts[index];
      if (transferId === exceptTransferId) continue;
      const offer = this.offers.get(transferId);
      if (offer?.fileHash.toLowerCase() === blobId) {
        this.pendingAccepts.splice(index, 1);
        this.pendingAcceptQueuedAt.delete(transferId);
        this.cleanupTemporaryOfferFile(offer);
        this.offers.delete(transferId);
      }
    }
  }

  private peerHasMaxActiveAcceptsForResource(peerHash: string, fileHash: string): boolean {
    const peerKey = peerHash.trim().toLowerCase();
    const blobId = fileHash.trim().toLowerCase();
    if (!peerKey) return false;
    let activeForPeer = 0;
    for (const transferId of this.activeAccepts) {
      const offer = this.offers.get(transferId);
      if (
        (offer?.sourcePeerHash || '').trim().toLowerCase() === peerKey &&
        (offer?.fileHash || '').trim().toLowerCase() === blobId
      ) {
        activeForPeer += 1;
      }
    }
    return activeForPeer >= RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER;
  }

  private peerHasMaxActiveOrPendingAcceptsForResource(peerHash: string, fileHash: string): boolean {
    const peerKey = peerHash.trim().toLowerCase();
    const blobId = fileHash.trim().toLowerCase();
    if (!peerKey || !blobId) return false;
    let activeOrPendingForPeer = 0;
    for (const transferId of this.activeAccepts) {
      const offer = this.offers.get(transferId);
      if (
        (offer?.sourcePeerHash || '').trim().toLowerCase() === peerKey &&
        (offer?.fileHash || '').trim().toLowerCase() === blobId
      ) {
        activeOrPendingForPeer += 1;
      }
    }
    for (const transferId of this.pendingAccepts) {
      const offer = this.offers.get(transferId);
      if (
        (offer?.sourcePeerHash || '').trim().toLowerCase() === peerKey &&
        (offer?.fileHash || '').trim().toLowerCase() === blobId
      ) {
        activeOrPendingForPeer += 1;
      }
    }
    return activeOrPendingForPeer >= RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER;
  }

  private cleanupStaleAccepts(drainQueue = true): void {
    const now = this.now();
    const stalePendingTransferIds: string[] = [];
    for (const transferId of this.pendingAccepts) {
      const queuedAt = this.pendingAcceptQueuedAt.get(transferId) ?? now;
      if (now - queuedAt >= RETICULUM_RESOURCE_TRANSFER_ACCEPT_STALE_MS) {
        stalePendingTransferIds.push(transferId);
      }
    }
    if (stalePendingTransferIds.length > 0) {
      const stale = new Set(stalePendingTransferIds);
      for (let index = this.pendingAccepts.length - 1; index >= 0; index -= 1) {
        const transferId = this.pendingAccepts[index];
        if (!stale.has(transferId)) continue;
        this.pendingAccepts.splice(index, 1);
        this.pendingAcceptQueuedAt.delete(transferId);
        const offer = this.offers.get(transferId);
        if (!offer) continue;
        loggerWarn(
          `[${this.loggerPrefix}] Resource transfer pending accept stale transfer=${transferId}; dropping offer`
        );
        this.cleanupTemporaryOfferFile(offer);
        this.offers.delete(transferId);
      }
    }

    const staleTransferIds: string[] = [];
    for (const transferId of this.activeAccepts) {
      const startedAt = this.activeAcceptStartedAt.get(transferId) ?? now;
      if (now - startedAt >= RETICULUM_RESOURCE_TRANSFER_ACCEPT_STALE_MS) {
        staleTransferIds.push(transferId);
      }
    }
    for (const transferId of staleTransferIds) {
      loggerWarn(
        `[${this.loggerPrefix}] Resource transfer stale transfer=${transferId}; releasing active slot`
      );
      this.finishTransfer(transferId, false, false);
    }
    if (drainQueue && (stalePendingTransferIds.length > 0 || staleTransferIds.length > 0)) {
      void this.processAcceptQueue();
    }
  }

  private contextMetadata(contextId: number): Record<string, number> {
    if (!this.contextMetadataKey) return {};
    return { [this.contextMetadataKey]: contextId };
  }

  private cleanupTemporaryOfferFile(offer: ReticulumResourceTransferOffer): void {
    this.cleanupTemporaryPath(offer.temporaryPath);
    this.cleanupTemporaryPath(offer.receiveTemporaryPath);
    delete offer.temporaryPath;
    delete offer.receiveTemporaryPath;
  }

  private cleanupTemporaryPath(filePath: string | undefined): void {
    if (!filePath) return;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup for temporary transfer files.
    }
  }
}
