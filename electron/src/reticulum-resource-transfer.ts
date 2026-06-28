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
export const RETICULUM_RESOURCE_TRANSFER_ACCEPT_CONCURRENCY = 8;
export const RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER = 4;
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
const RETICULUM_RESOURCE_TRANSFER_ZERO_PROGRESS_RETRY_MS = 10_000;
const RETICULUM_RESOURCE_TRANSFER_STALLED_PROGRESS_RETRY_MS = 20_000;

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
  payloadHash?: string;
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
  peerPresenceHash?: string;
  auth?: Record<string, unknown>;
  progress?: number;
  bytesTransferred?: number;
  bytesPerSecond?: number;
  sha256?: string;
  payloadHash?: string;
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

type TransferProgressWatch = {
  lastProgressAt: number;
  lastProgressBytes: number;
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
  canServeRequest?: (
    contextId: number,
    request: ReticulumResourceTransferRequest,
    manifest: ReticulumResourceManifest
  ) => boolean | Promise<boolean>;
  parseAuthRequest?: (
    contextId: number,
    auth: Record<string, unknown>,
    peerHash: string
  ) => ReticulumResourceTransferRequest | null | Promise<ReticulumResourceTransferRequest | null>;
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
  private readonly canServeRequest?: ReticulumResourceTransferOptions<TRequestWire>['canServeRequest'];
  private readonly parseAuthRequest?: ReticulumResourceTransferOptions<TRequestWire>['parseAuthRequest'];
  private readonly onProgress?: ReticulumResourceTransferOptions<TRequestWire>['onProgress'];
  private readonly downloads = new Map<string, ReticulumResourceDownloadState<TRequestWire>>();
  private readonly offers = new Map<string, ReticulumResourceTransferOffer>();
  private readonly requestedResources = new Map<string, number>();
  private readonly activeAccepts = new Set<string>();
  private readonly activeAcceptStartedAt = new Map<string, number>();
  private readonly transferSpeedSamples = new Map<string, TransferSpeedSample>();
  private readonly transferProgressWatch = new Map<string, TransferProgressWatch>();
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
    this.canServeRequest = options.canServeRequest;
    this.parseAuthRequest = options.parseAuthRequest;
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
    this.activeAccepts.clear();
    this.activeAcceptStartedAt.clear();
    this.transferSpeedSamples.clear();
    this.transferProgressWatch.clear();
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
    const pendingTransfers = 0;
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
    const resetForRetry =
      existingDownload &&
      !this.hasActiveAcceptsForResource(blobId) &&
      !this.hasActiveBulkThrottle(state);
    if (resetForRetry) {
      state.rangeAttempts.clear();
      state.inFlightRanges.clear();
      this.clearRequestedResourcesForFile(blobId);
    }
    if (resetForRetry || !existingDownload || state.nextRequestAt <= this.now()) {
      state.nextRequestAt = 0;
    }
    this.emitProgress(state);
    this.scheduleDownload(Math.max(0, state.nextRequestAt - this.now()));
  }

  addCandidatePeers(fileHash: string, peerHashes: string[]): boolean {
    const blobId = String(fileHash || '').trim().toLowerCase();
    if (!blobId || peerHashes.length === 0) return false;
    const state = this.downloads.get(blobId);
    if (!state) return false;
    let added = false;
    for (const peer of peerHashes) {
      const peerKey = peer.trim().toLowerCase();
      if (!peerKey || state.peerHashes.has(peerKey)) continue;
      state.peerHashes.add(peerKey);
      added = true;
    }
    if (!added) return false;
    state.nextRequestAt = 0;
    this.emitProgress(state);
    this.scheduleDownload(0);
    return true;
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

    this.clearRequestedResourcesForFile(blobId);

    for (const transferId of transferIds) {
      const offer = this.offers.get(transferId);
      if (offer) this.cleanupTemporaryOfferFile(offer);
      this.offers.delete(transferId);
      this.transferSpeedSamples.delete(transferId);
      this.transferProgressWatch.delete(transferId);
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
    return true;
  }

  handleResourceEvent(payload: ReticulumResourceTransferPayload): void {
    if (payload?.status === 'auth' && payload.linkId && payload.transferId) {
      void this.handleAuth(payload);
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
      this.retryNoProgressTransfers();
      this.cleanupStaleAccepts();
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
        const activeWatchDelay = this.activeAccepts.size > 0
          ? RETICULUM_RESOURCE_TRANSFER_RETRY_MS
          : null;
        const delay = nextDelay == null
          ? (activeWatchDelay ?? RETICULUM_RESOURCE_TRANSFER_RETRY_MS)
          : activeWatchDelay == null
            ? nextDelay
            : Math.min(nextDelay, activeWatchDelay);
        this.scheduleDownload(delay);
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
      (peer) => !this.peerHasMaxActiveAcceptsForResource(peer, state.fileHash)
    );
    if (knownPeers.length > 0 && availablePeers.length === 0) {
      state.nextRequestAt = this.now() + RETICULUM_RESOURCE_TRANSFER_RETRY_MS;
      this.emitProgress(state);
      return;
    }
    const requestedRanges: ReticulumResourceByteRange[] = [];
    let throttledPeerCount = 0;
    let capacityLimited = false;
    const assigned = new Set<string>();
    for (const peerKey of availablePeers) {
      if (this.activeAccepts.size >= RETICULUM_RESOURCE_TRANSFER_ACCEPT_CONCURRENCY) {
        capacityLimited = true;
        break;
      }
      if (this.shouldThrottlePeerForBulk(state, peerKey)) {
        throttledPeerCount += 1;
        continue;
      }
      while (
        this.activeAccepts.size < RETICULUM_RESOURCE_TRANSFER_ACCEPT_CONCURRENCY &&
        !this.peerHasMaxActiveAcceptsForResource(peerKey, state.fileHash)
      ) {
        const requestRange =
          missing.find(
            (range) => !assigned.has(rangeKey(range)) && (state.rangePeers.get(rangeKey(range))?.has(peerKey) ?? false)
          ) ?? missing.find((range) => !assigned.has(rangeKey(range)));
        if (!requestRange) break;
        assigned.add(rangeKey(requestRange));
        const requests = await this.buildRequestPayloads(state, [requestRange]);
        if (requests.length === 0) {
          loggerWarn(
            `[${this.loggerPrefix}] Could not build targeted range request fileHash=${state.fileHash} peer=${peerKey}`
          );
          continue;
        }
        for (const request of requests) {
          if (this.activeAccepts.size >= RETICULUM_RESOURCE_TRANSFER_ACCEPT_CONCURRENCY) {
            capacityLimited = true;
            break;
          }
          if (this.peerHasMaxActiveAcceptsForResource(peerKey, state.fileHash)) break;
          const throttleKey = `${state.contextId}:${peerKey}:${state.fileHash}:${rangeKey(requestRange)}`;
          const now = this.now();
          if (now - (this.requestedResources.get(throttleKey) ?? 0) < RETICULUM_RESOURCE_TRANSFER_PULL_THROTTLE_MS) {
            continue;
          }
          this.requestedResources.set(throttleKey, now);
          loggerLog(
            `[${this.loggerPrefix}] resource_range_link_requested fileHash=${state.fileHash} ` +
              `peer=${peerKey.slice(0, 16)} range=${rangeKey(requestRange)}`
          );
          const result = await this.openRangeLink(peerKey, state, requestRange, request);
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
    }
    if (!delivered && capacityLimited) {
      state.nextRequestAt = this.now() + RETICULUM_RESOURCE_TRANSFER_RETRY_MS;
      this.emitProgress(state);
      return;
    }
    if (!delivered && throttledPeerCount > 0) {
      state.nextRequestAt = this.now() + RETICULUM_RESOURCE_TRANSFER_OVERLAY_THROTTLE_RETRY_MS;
      this.emitProgress(state);
      return;
    }
    if (!delivered && knownPeers.length === 0) {
      loggerLog(
        `[${this.loggerPrefix}] resource_range_waiting_for_provider fileHash=${state.fileHash} ` +
          `missingRanges=${missing.length}`
      );
    }
    for (const range of requestedRanges) {
      state.rangeAttempts.set(rangeKey(range), (state.rangeAttempts.get(rangeKey(range)) ?? 0) + 1);
    }
    state.nextRequestAt = delivered
      ? this.now() + RETICULUM_RESOURCE_TRANSFER_RESPONSE_TIMEOUT_MS
      : this.now() + RETICULUM_RESOURCE_TRANSFER_RETRY_MS;
    this.emitProgress(state);
  }

  private async openRangeLink(
    peerHash: string,
    state: ReticulumResourceDownloadState<TRequestWire>,
    range: ReticulumResourceByteRange,
    request: TRequestWire
  ): Promise<ReticulumSendResult> {
    if (!this.bridge || typeof this.bridge.acceptReticulumResourceDetailed !== 'function') {
      return { ok: false, reason: 'bridge-unavailable', error: 'Reticulum bridge unavailable' };
    }
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) {
      return { ok: false, reason: 'unknown-peer-presence-hash', error: 'Missing peer hash' };
    }
    const transferId = nodeCrypto.randomBytes(8).toString('hex');
    const fileName = `${state.fileHash}.range-${range.startByte}-${range.endByteExclusive}.bin`;
    const sizeBytes = rangeSize(range);
    const savePath = this.resourceStore.createPlaintextTempPath(
      state.fileHash,
      path.extname(fileName) || '.bin'
    );
    const requestFields =
      request && typeof request === 'object' && !Array.isArray(request)
        ? { ...(request as Record<string, unknown>) }
        : {};
    const authMessage = {
      ...requestFields,
      type: this.authMessageType,
      transferId,
      eventId: state.eventId ?? '',
      contextId: state.contextId,
      ...(this.contextMetadataKey ? { [this.contextMetadataKey]: state.contextId } : {}),
      fileHash: state.fileHash,
      totalSizeBytes: state.manifest.sizeBytes,
      byteRanges: [[range.startByte, range.endByteExclusive]],
      requesterPeerHash: this.bridge.getLocalDestinationHash?.() ?? '',
    };
    const offer: ReticulumResourceTransferOffer = {
      transferId,
      contextId: state.contextId,
      ...(state.eventId ? { eventId: state.eventId } : {}),
      fileHash: state.fileHash,
      totalSizeBytes: state.manifest.sizeBytes,
      sizeBytes,
      fileName,
      mimeType: state.manifest.mimeType,
      ranges: [range],
      sourcePeerHash: peerKey,
      receiveTemporaryPath: savePath,
    };
    this.offers.set(transferId, offer);
    this.activeAccepts.add(transferId);
    const startedAt = this.now();
    this.activeAcceptStartedAt.set(transferId, startedAt);
    this.transferProgressWatch.set(transferId, {
      lastProgressAt: startedAt,
      lastProgressBytes: 0,
    });
    this.markOfferRangesInFlight(state, offer);
    loggerLog(
      `[${this.loggerPrefix}] resource_session_opened fileHash=${state.fileHash} ` +
        `peer=${peerKey.slice(0, 16)} transfer=${transferId} mode=link-auth-range ` +
        `range=${rangeKey(range)} bytes=${sizeBytes}`
    );
    const result = await this.bridge.acceptReticulumResourceDetailed({
      peerPresenceHash: peerKey,
      reticulumIdentityPublicKeyBase64: '',
      transferId,
      savePath,
      fileName,
      size: sizeBytes,
      resourceType: this.rangeResourceType,
      metadata: {
        logicalResourceType: this.rangeResourceType,
        eventId: state.eventId ?? '',
        contextId: state.contextId,
        ...this.contextMetadata(state.contextId),
        fileHash: state.fileHash,
        totalSizeBytes: state.manifest.sizeBytes,
        byteRanges: [[range.startByte, range.endByteExclusive]],
        mimeType: state.manifest.mimeType,
      },
      authMessage,
    });
    if (!result.ok) {
      this.finishTransfer(transferId, false);
    }
    return result;
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
    this.updateTransferProgressWatch(offer.transferId, boundedBytes ?? 0);
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

  private async handleAuth(payload: ReticulumResourceTransferPayload): Promise<void> {
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
    if (!offer) {
      await this.serveLinkedRangeRequest(payload, auth as Record<string, unknown>);
      return;
    }
    if (offer.temporaryPath && !offer.receiveTemporaryPath) {
      await this.authorizeProvidedOffer(payload, auth as Record<string, unknown>, offer);
      return;
    }
    await this.authorizeAcceptedOffer(payload, auth as Record<string, unknown>, offer);
  }

  private async authorizeProvidedOffer(
    payload: ReticulumResourceTransferPayload,
    auth: Record<string, unknown>,
    offer: ReticulumResourceTransferOffer
  ): Promise<void> {
    const transferId = offer.transferId;
    const authRanges = Array.isArray(auth.byteRanges)
      ? auth.byteRanges
      : [];
    const expectedRanges = offer.ranges.map((range) => [range.startByte, range.endByteExclusive]);
    if (
      Number(auth.contextId) !== offer.contextId ||
      auth.fileHash !== offer.fileHash ||
      JSON.stringify(authRanges) !== JSON.stringify(expectedRanges)
    ) {
      loggerWarn(
        `[${this.loggerPrefix}] Rejecting provided resource auth transfer=${transferId}: metadata mismatch`
      );
      await this.bridge?.rejectReticulumResourceDetailed?.({
        linkId: payload.linkId || '',
        transferId,
        reason: 'resource_auth_mismatch',
      });
      this.finishTransfer(transferId, false);
      return;
    }
    await this.bridge?.authorizeReticulumResourceDetailed({
      linkId: payload.linkId || '',
      transferId,
    });
  }

  private async authorizeAcceptedOffer(
    payload: ReticulumResourceTransferPayload,
    auth: Record<string, unknown>,
    offer: ReticulumResourceTransferOffer
  ): Promise<void> {
    const transferId = offer.transferId;
    const authRanges = Array.isArray(auth.byteRanges)
      ? auth.byteRanges
      : [];
    const expectedRanges = offer?.ranges.map((range) => [range.startByte, range.endByteExclusive]) ?? [];
    if (
      Number(auth.contextId) !== offer.contextId ||
      auth.fileHash !== offer.fileHash ||
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
    if (offer.payloadHash && auth.payloadHash !== offer.payloadHash) {
      loggerWarn(
        `[${this.loggerPrefix}] Rejecting resource auth transfer=${transferId}: payload hash mismatch`
      );
      await this.bridge?.rejectReticulumResourceDetailed?.({
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

  private async serveLinkedRangeRequest(
    payload: ReticulumResourceTransferPayload,
    auth: Record<string, unknown>
  ): Promise<void> {
    if (!this.bridge || !payload.linkId || !payload.transferId || !this.parseAuthRequest) return;
    const contextId = Number(
      (this.contextMetadataKey ? auth[this.contextMetadataKey] : undefined) ??
        auth.contextId ??
        0
    );
    const authPeerHash =
      typeof auth.requesterPeerHash === 'string' ? auth.requesterPeerHash : '';
    const peerHash = String(payload.peerPresenceHash || authPeerHash || '').trim().toLowerCase();
    const request = await this.parseAuthRequest(contextId, auth, peerHash);
    const transferId = payload.transferId;
    if (!request || !Number.isInteger(contextId) || contextId <= 0) {
      await this.bridge.rejectReticulumResourceDetailed?.({
        linkId: payload.linkId,
        transferId,
        reason: 'bad_resource_auth',
      });
      return;
    }
    const manifest = this.resourceStore.getManifest(request.fileHash);
    if (!manifest || manifest.fileHash.toLowerCase() !== request.fileHash.toLowerCase()) {
      await this.bridge.rejectReticulumResourceDetailed?.({
        linkId: payload.linkId,
        transferId,
        reason: 'manifest_not_found',
      });
      return;
    }
    if (this.canServeRequest) {
      const allowed = await this.canServeRequest(contextId, request, manifest);
      if (!allowed) {
        await this.bridge.rejectReticulumResourceDetailed?.({
          linkId: payload.linkId,
          transferId,
          reason: 'request_not_allowed',
        });
        return;
      }
    }
    const ranges = mergeRanges(request.ranges || [])
      .filter((range) => validRangeForManifest(manifest, range))
      .slice(0, 1);
    if (ranges.length === 0) {
      await this.bridge.rejectReticulumResourceDetailed?.({
        linkId: payload.linkId,
        transferId,
        reason: 'invalid_ranges',
      });
      return;
    }
    let sourcePath = '';
    try {
      sourcePath = this.resourceStore.assembleResource(manifest.fileHash);
    } catch {
      await this.bridge.rejectReticulumResourceDetailed?.({
        linkId: payload.linkId,
        transferId,
        reason: 'resource_unavailable',
      });
      return;
    }
    if (!sourcePath) {
      await this.bridge.rejectReticulumResourceDetailed?.({
        linkId: payload.linkId,
        transferId,
        reason: 'resource_unavailable',
      });
      return;
    }
    const range = ranges[0];
    const requesterPeerHash = String(request.requesterPeerHash || peerHash || '').trim().toLowerCase();
    if (!requesterPeerHash) {
      await this.bridge.rejectReticulumResourceDetailed?.({
        linkId: payload.linkId,
        transferId,
        reason: 'missing_requester_peer',
      });
      return;
    }
    const rangePayload = this.resourceStore.readByteRange(
      manifest.fileHash,
      range.startByte,
      range.endByteExclusive
    );
    const registered = await this.bridge.sendReticulumResourceDetailed({
      allowedRecipientAddress: requesterPeerHash,
      transferId,
      filePath: rangePayload.path,
      fileName: `${manifest.fileHash}.range-${range.startByte}-${range.endByteExclusive}.bin`,
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
      this.cleanupTemporaryPath(rangePayload.path);
      const failed = registered as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[${this.loggerPrefix}] Failed to register linked byte range fileHash=${manifest.fileHash} range=${rangeKey(range)}:`,
        failed.error ?? failed.reason
      );
      await this.bridge.rejectReticulumResourceDetailed?.({
        linkId: payload.linkId,
        transferId,
        reason: 'resource_register_failed',
      });
      return;
    }
    const offer: ReticulumResourceTransferOffer = {
      transferId,
      contextId,
      ...(request.eventId ? { eventId: request.eventId } : {}),
      fileHash: manifest.fileHash,
      totalSizeBytes: manifest.sizeBytes,
      sizeBytes: rangePayload.sizeBytes,
      fileName: `${manifest.fileHash}.range-${range.startByte}-${range.endByteExclusive}.bin`,
      mimeType: manifest.mimeType,
      ranges: [range],
      payloadHash: rangePayload.sha256,
      temporaryPath: rangePayload.path,
      sourcePeerHash: requesterPeerHash,
      ...(request.relayRequestId ? { relayRequestId: request.relayRequestId } : {}),
    };
    this.offers.set(transferId, offer);
    loggerLog(
      `[${this.loggerPrefix}] resource_range_streaming fileHash=${manifest.fileHash} ` +
        `peer=${requesterPeerHash.slice(0, 16) || 'unknown'} transfer=${transferId} ` +
        `mode=linked-auth range=${rangeKey(range)} bytes=${rangePayload.sizeBytes}`
    );
    await this.bridge.authorizeReticulumResourceDetailed({
      linkId: payload.linkId,
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
      const expectedPayloadHash =
        typeof offer.payloadHash === 'string' && /^[0-9a-f]{64}$/i.test(offer.payloadHash)
          ? offer.payloadHash.toLowerCase()
          : typeof payload.payloadHash === 'string' && /^[0-9a-f]{64}$/i.test(payload.payloadHash)
            ? payload.payloadHash.toLowerCase()
            : typeof payload.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(payload.sha256)
              ? payload.sha256.toLowerCase()
              : '';
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
      if (expectedPayloadHash && actualHash !== expectedPayloadHash) {
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
      this.transferProgressWatch.delete(payload.transferId);
      this.activeAccepts.delete(payload.transferId);
      this.activeAcceptStartedAt.delete(payload.transferId);
      await fs.promises.unlink(payload.path).catch(() => undefined);
    }
  }

  private finishTransfer(transferId: string, success: boolean): void {
    const offer = this.offers.get(transferId);
    if (offer) this.cleanupTemporaryOfferFile(offer);
    this.offers.delete(transferId);
    this.transferSpeedSamples.delete(transferId);
    this.transferProgressWatch.delete(transferId);
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
  }

  private updateTransferProgressWatch(transferId: string, bytesTransferred: number): void {
    const watch = this.transferProgressWatch.get(transferId);
    if (!watch) return;
    const bytes = Math.max(0, Math.floor(bytesTransferred));
    if (bytes > watch.lastProgressBytes) {
      watch.lastProgressBytes = bytes;
      watch.lastProgressAt = this.now();
    }
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
    if (
      offer.payloadHash != null &&
      (typeof offer.payloadHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.payloadHash))
    ) return false;
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

  private retryNoProgressTransfers(): void {
    const now = this.now();
    const retryTransferIds: string[] = [];
    for (const transferId of this.activeAccepts) {
      const offer = this.offers.get(transferId);
      const watch = this.transferProgressWatch.get(transferId);
      if (!offer || !watch) continue;
      const receivedBytes = Math.max(0, Math.floor(watch.lastProgressBytes));
      const thresholdMs = receivedBytes <= 0
        ? RETICULUM_RESOURCE_TRANSFER_ZERO_PROGRESS_RETRY_MS
        : RETICULUM_RESOURCE_TRANSFER_STALLED_PROGRESS_RETRY_MS;
      const ageMs = now - watch.lastProgressAt;
      if (ageMs >= thresholdMs) {
        loggerWarn(
          `[${this.loggerPrefix}] resource_range_no_progress_retry fileHash=${offer.fileHash} ` +
            `transfer=${transferId} peer=${(offer.sourcePeerHash || '').slice(0, 16) || 'unknown'} ` +
            `range=${offer.ranges.map(rangeKey).join(',')} ` +
            `bytesReceived=${receivedBytes}/${offer.sizeBytes} ageMs=${Math.round(ageMs)} ` +
            `thresholdMs=${thresholdMs}`
        );
        retryTransferIds.push(transferId);
      }
    }
    for (const transferId of retryTransferIds) {
      this.cancelTransferForRetry(transferId, 'resource_range_no_progress_retry');
    }
  }

  private cancelTransferForRetry(transferId: string, reason: string): void {
    const offer = this.offers.get(transferId);
    const cancelPromise = this.bridge?.cancelReticulumResourceDetailed?.({
      transferId,
      peerPresenceHash: offer?.sourcePeerHash,
      reason,
    });
    if (cancelPromise) {
      void cancelPromise.catch((err) => {
        loggerWarn(
          `[${this.loggerPrefix}] Failed to cancel stalled resource transfer=${transferId}:`,
          err
        );
      });
    }
    this.finishTransfer(transferId, false);
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

  private hasActiveAcceptsForResource(fileHash: string): boolean {
    const blobId = fileHash.trim().toLowerCase();
    for (const transferId of this.activeAccepts) {
      if (this.offers.get(transferId)?.fileHash.toLowerCase() === blobId) {
        return true;
      }
    }
    return false;
  }

  private hasActiveBulkThrottle(state: ReticulumResourceDownloadState<TRequestWire>): boolean {
    const now = this.now();
    for (const until of state.peerBulkThrottleUntil.values()) {
      if (until > now) return true;
    }
    return false;
  }

  private clearRequestedResourcesForFile(fileHash: string): void {
    const blobId = fileHash.trim().toLowerCase();
    if (!blobId) return;
    for (const key of [...this.requestedResources.keys()]) {
      if (key.includes(blobId)) this.requestedResources.delete(key);
    }
  }

  private cleanupStaleAccepts(): void {
    const now = this.now();
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
      this.finishTransfer(transferId, false);
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
