import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import * as path from 'path';
import type { ReticulumBridge, ReticulumSendResult } from './reticulum-bridge';
import {
  ReticulumResourceStore,
  type ReticulumResourceManifest,
} from './reticulum-resource-store';
import { log as loggerLog, warn as loggerWarn } from './logger';

export const RETICULUM_RESOURCE_TRANSFER_INITIAL_BLOCK_CHUNKS = 2;
export const RETICULUM_RESOURCE_TRANSFER_MAX_BLOCK_CHUNKS = 16;
export const RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT =
  RETICULUM_RESOURCE_TRANSFER_MAX_BLOCK_CHUNKS;
export const RETICULUM_RESOURCE_TRANSFER_ACCEPT_CONCURRENCY = 4;
export const RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER = 1;
export const RETICULUM_RESOURCE_TRANSFER_RETRY_MS = 5_000;
export const RETICULUM_RESOURCE_TRANSFER_MAX_CHUNK_ATTEMPTS = 6;
export const RETICULUM_RESOURCE_TRANSFER_TTL_MS = 10 * 60 * 1000;
export const RETICULUM_RESOURCE_TRANSFER_PULL_THROTTLE_MS = 15_000;
export const RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS = 75_000;
export const RETICULUM_RESOURCE_TRANSFER_COMPLETE_FILE_RESPONSE_TIMEOUT_MS = 15_000;
const RETICULUM_RESOURCE_TRANSFER_ACCEPT_STALE_MS = 75_000;
const RETICULUM_RESOURCE_TRANSFER_SPEED_LOG_MS = 5_000;

export type ReticulumResourceTransferRequest = {
  eventId?: string;
  fileHash: string;
  chunkIndexes?: number[];
  requireCompleteFile?: boolean;
  requesterAddress?: string;
};

export type ReticulumResourceTransferOffer = {
  transferId: string;
  contextId: number;
  eventId?: string;
  fileHash: string;
  sizeBytes: number;
  fileName: string;
  mimeType: string;
  chunkIndex?: number;
  chunkHash?: string;
  chunkSize?: number;
  bundleHash?: string;
  chunkIndexes?: number[];
  chunks?: Array<{
    index: number;
    hash: string;
    sizeBytes: number;
    offset: number;
  }>;
  sourcePeerHash?: string;
  temporaryPath?: string;
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
  chunkIndex?: number;
  completedChunks?: number;
  totalChunks?: number;
  fullFileTransfer?: boolean;
  bytesTransferred?: number;
  totalBytes?: number;
  progress?: number;
  complete?: boolean;
  failed?: boolean;
};

export type ReticulumResourceDownloadRuntimeStatus = {
  active: boolean;
  peerCount: number;
  advertisedPeerCount: number;
  activeTransfers: number;
  pendingTransfers: number;
  requestedChunkCount: number;
  inFlightChunkCount: number;
  currentBytesPerSecond: number;
  averageBytesPerSecond: number;
  nextRequestAt: number | null;
};

function chunkIndexesToRanges(chunkIndexes: number[]): Array<[number, number]> {
  const sorted = [...new Set(chunkIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const index of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous[0] + previous[1] === index) {
      previous[1] += 1;
    } else {
      ranges.push([index, 1]);
    }
  }
  return ranges;
}

function offerChunkRanges(offer: ReticulumResourceTransferOffer): Array<[number, number]> {
  if (!Array.isArray(offer.chunks) || offer.chunks.length === 0) return [];
  return chunkIndexesToRanges(offer.chunks.map((chunk) => chunk.index));
}

function sameChunkRanges(a: unknown, b: Array<[number, number]>): boolean {
  if (!Array.isArray(a)) return b.length === 0;
  if (a.length !== b.length) return false;
  return a.every(
    (range, index) =>
      Array.isArray(range) &&
      range.length === 2 &&
      range[0] === b[index]?.[0] &&
      range[1] === b[index]?.[1]
  );
}

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

type ReticulumResourceDownloadState<TRequestWire> = {
  contextId: number;
  fileHash: string;
  eventId?: string;
  manifest: ReticulumResourceManifest;
  peerHashes: Set<string>;
  chunkAttempts: Map<number, number>;
  chunkPeers: Map<number, Set<string>>;
  inFlightChunks: Map<number, { transferId: string; startedAt: number }>;
  peerBlockChunkLimits: Map<string, number>;
  fullTransfer?: { transferId: string; startedAt: number };
  nextRequestAt: number;
  featureData?: Record<string, unknown>;
  requestPayloads?: TRequestWire[];
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
  chunkResourceType?: string;
  authMessageType?: string;
  contextMetadataKey?: string;
  buildRequestPayloads: (
    state: {
      contextId: number;
      eventId?: string;
      manifest: ReticulumResourceManifest;
      featureData?: Record<string, unknown>;
    },
    chunkIndexes: number[]
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

export class ReticulumResourceTransferManager<TRequestWire> extends EventEmitter {
  private bridge: ReticulumBridge | null;
  private readonly resourceStore: ReticulumResourceStore;
  private readonly now: () => number;
  private readonly loggerPrefix: string;
  private readonly resourceType: string;
  private readonly chunkResourceType: string;
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
    this.resourceType = options.resourceType ?? 'reticulum_resource';
    this.chunkResourceType = options.chunkResourceType ?? 'reticulum_resource_chunk';
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
  }

  getDownloadStatus(fileHash: string): ReticulumResourceDownloadRuntimeStatus {
    const blobId = String(fileHash || '').trim().toLowerCase();
    const state = this.downloads.get(blobId);
    if (!state) {
      return this.emptyDownloadStatus();
    }
    this.cleanupStaleAccepts();
    if (!this.downloads.has(blobId)) {
      return this.emptyDownloadStatus();
    }
    this.releaseStaleInFlightChunks(state);
    const advertisedPeers = new Set<string>();
    for (const peers of state.chunkPeers.values()) {
      for (const peer of peers) {
        const peerKey = peer.trim().toLowerCase();
        if (peerKey) advertisedPeers.add(peerKey);
      }
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
    let totalBytes = 0;
    let oldestStartedAt = 0;
    for (const transferId of this.activeAccepts) {
      const offer = this.offers.get(transferId);
      if (offer?.fileHash.toLowerCase() !== blobId) continue;
      const sample = this.transferSpeedSamples.get(transferId);
      if (!sample) continue;
      currentBytesPerSecond += Math.max(0, sample.bytesPerSecond || 0);
      totalBytes += Math.max(0, sample.bytes || 0);
      oldestStartedAt = oldestStartedAt === 0
        ? sample.startedAt
        : Math.min(oldestStartedAt, sample.startedAt);
    }
    const elapsedMs = oldestStartedAt > 0 ? Math.max(1, this.now() - oldestStartedAt) : 0;
    return {
      active: true,
      peerCount: state.peerHashes.size,
      advertisedPeerCount: advertisedPeers.size,
      activeTransfers,
      pendingTransfers,
      requestedChunkCount: state.chunkAttempts.size,
      inFlightChunkCount: state.inFlightChunks.size,
      currentBytesPerSecond,
      averageBytesPerSecond: elapsedMs > 0 ? (totalBytes * 1000) / elapsedMs : 0,
      nextRequestAt: state.nextRequestAt || null,
    };
  }

  private emptyDownloadStatus(): ReticulumResourceDownloadRuntimeStatus {
    return {
      active: false,
      peerCount: 0,
      advertisedPeerCount: 0,
      activeTransfers: 0,
      pendingTransfers: 0,
      requestedChunkCount: 0,
      inFlightChunkCount: 0,
      currentBytesPerSecond: 0,
      averageBytesPerSecond: 0,
      nextRequestAt: null,
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
      chunkHashes: options.manifest.chunkHashes.map((hash) => hash.toLowerCase()),
    };
    this.resourceStore.storeManifest(manifest);
    try {
      this.resourceStore.assembleResource(blobId);
      return;
    } catch {
      // Missing chunks are expected; continue into network retrieval.
    }
    const state = this.upsertDownload(
      options.contextId,
      manifest,
      options.eventId,
      options.candidatePeers ?? [],
      options.featureData
    );
    state.chunkAttempts.delete(-1);
    state.nextRequestAt = 0;
    this.emitProgress(state);
    this.scheduleDownload(0);
  }

  async handleRequest(
    contextId: number,
    request: ReticulumResourceTransferRequest,
    peerHash: string
  ): Promise<void> {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey || !this.bridge) return;
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
    if (request.requireCompleteFile) {
      let filePath = '';
      try {
        filePath = this.resourceStore.assembleResource(manifest.fileHash);
      } catch {
        loggerWarn(
          `[${this.loggerPrefix}] Cannot serve complete resource request fileHash=${request.fileHash}: complete file unavailable`
        );
        return;
      }
      const transferId = nodeCrypto.randomBytes(8).toString('hex');
      const fileName = manifest.fileName || `${manifest.fileHash}.bin`;
      const registered = await this.bridge.sendReticulumResourceDetailed({
        allowedRecipientAddress: peerKey,
        transferId,
        filePath,
        fileName,
        size: manifest.sizeBytes,
        sha256: manifest.fileHash,
        resourceType: this.resourceType,
        streamMode: false,
        metadata: {
          logicalResourceType: this.resourceType,
          eventId: request.eventId ?? '',
          contextId,
          ...this.contextMetadata(contextId),
          fileHash: manifest.fileHash,
          completeFile: true,
          mimeType: manifest.mimeType,
          namespace: manifest.namespace,
        },
        expiresAt: this.now() + RETICULUM_RESOURCE_TRANSFER_TTL_MS,
      });
      if (!registered.ok) {
        const failed = registered as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[${this.loggerPrefix}] Failed to register complete file offer fileHash=${manifest.fileHash}:`,
          failed.error ?? failed.reason
        );
        return;
      }
      const offer: ReticulumResourceTransferOffer = {
        transferId,
        contextId,
        ...(request.eventId ? { eventId: request.eventId } : {}),
        fileHash: manifest.fileHash,
        sizeBytes: manifest.sizeBytes,
        fileName,
        mimeType: manifest.mimeType,
      };
      this.offers.set(transferId, { ...offer, sourcePeerHash: peerKey });
      const sent = await this.sendOfferToPeer(peerKey, contextId, offer);
      if (!sent.ok) {
        const failed = sent as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[${this.loggerPrefix}] Failed to send complete file offer fileHash=${manifest.fileHash}:`,
          failed.error ?? failed.reason
        );
        this.offers.delete(transferId);
      }
      return;
    }
    const requestedIndexes = Array.isArray(request.chunkIndexes)
      ? request.chunkIndexes
      : manifest.chunkHashes
          .map((_, index) => index)
          .slice(0, RETICULUM_RESOURCE_TRANSFER_INITIAL_BLOCK_CHUNKS);
    const availableChunks = this.getAvailableRequestedChunks(manifest, requestedIndexes);
    if (availableChunks.length === 0) {
      loggerWarn(
        `[${this.loggerPrefix}] Cannot serve resource request fileHash=${request.fileHash}: no requested chunks available`
      );
      return;
    }
    if (availableChunks.length === 1) {
      const chunk = availableChunks[0];
      const transferId = nodeCrypto.randomBytes(8).toString('hex');
      const fileName = `${manifest.fileHash}.chunk-${chunk.index}`;
      const registered = await this.bridge.sendReticulumResourceDetailed({
        allowedRecipientAddress: peerKey,
        transferId,
        filePath: chunk.localPath,
        fileName,
        size: chunk.sizeBytes,
        sha256: chunk.chunkHash,
        resourceType: this.chunkResourceType,
        metadata: {
          logicalResourceType: this.chunkResourceType,
          eventId: request.eventId ?? '',
          contextId,
          ...this.contextMetadata(contextId),
          fileHash: manifest.fileHash,
          rangeStartChunk: chunk.index,
          chunkCount: 1,
          chunkIndex: chunk.index,
          chunkHash: chunk.chunkHash,
          chunkSize: chunk.sizeBytes,
          mimeType: manifest.mimeType,
          namespace: manifest.namespace,
        },
        expiresAt: this.now() + RETICULUM_RESOURCE_TRANSFER_TTL_MS,
      });
      if (!registered.ok) {
        const failed = registered as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[${this.loggerPrefix}] Failed to register chunk offer fileHash=${manifest.fileHash} chunk=${chunk.index}:`,
          failed.error ?? failed.reason
        );
        return;
      }
      const offer: ReticulumResourceTransferOffer = {
        transferId,
        contextId,
        ...(request.eventId ? { eventId: request.eventId } : {}),
        fileHash: manifest.fileHash,
        sizeBytes: chunk.sizeBytes,
        fileName,
        mimeType: manifest.mimeType,
        chunkIndex: chunk.index,
        chunkHash: chunk.chunkHash,
        chunkSize: chunk.sizeBytes,
      };
      this.offers.set(transferId, { ...offer, sourcePeerHash: peerKey });
      const sent = await this.sendOfferToPeer(peerKey, contextId, offer);
      if (!sent.ok) {
        const failed = sent as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[${this.loggerPrefix}] Failed to send chunk offer fileHash=${manifest.fileHash} chunk=${chunk.index}:`,
          failed.error ?? failed.reason
        );
        this.offers.delete(transferId);
      }
      return;
    }
    const bundle = this.createChunkBundle(
      manifest,
      [...availableChunks].sort((a, b) => a.index - b.index)
    );
    if (!bundle) return;
    const transferId = nodeCrypto.randomBytes(8).toString('hex');
    const fileName = `${manifest.fileHash}.block-${bundle.chunks[0]?.index ?? 0}`;
    const bundleHash = nodeCrypto.createHash('sha256').update(fs.readFileSync(bundle.path)).digest('hex');
    const chunkRanges = chunkIndexesToRanges(bundle.chunks.map((chunk) => chunk.index));
    const rangeStartChunk = bundle.chunks[0]?.index ?? 0;
    const registered = await this.bridge.sendReticulumResourceDetailed({
      allowedRecipientAddress: peerKey,
      transferId,
      filePath: bundle.path,
      fileName,
      size: bundle.sizeBytes,
      sha256: bundleHash,
      resourceType: this.chunkResourceType,
      metadata: {
        logicalResourceType: this.chunkResourceType,
        eventId: request.eventId ?? '',
        contextId,
        ...this.contextMetadata(contextId),
        fileHash: manifest.fileHash,
        chunkBundle: true,
        rangeStartChunk,
        chunkCount: bundle.chunks.length,
        chunkRanges,
        blockHash: bundleHash,
        bundleHash,
        mimeType: manifest.mimeType,
        namespace: manifest.namespace,
      },
      expiresAt: this.now() + RETICULUM_RESOURCE_TRANSFER_TTL_MS,
    });
    if (!registered.ok) {
      const failed = registered as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[${this.loggerPrefix}] Failed to register chunk bundle fileHash=${manifest.fileHash} chunks=${bundle.chunks.map((chunk) => chunk.index).join(',')}:`,
        failed.error ?? failed.reason
      );
      this.cleanupTemporaryPath(bundle.path);
      return;
    }
    const offer: ReticulumResourceTransferOffer = {
      transferId,
      contextId,
      ...(request.eventId ? { eventId: request.eventId } : {}),
      fileHash: manifest.fileHash,
      sizeBytes: bundle.sizeBytes,
      fileName,
      mimeType: manifest.mimeType,
      chunkIndex: bundle.chunks.length === 1 ? bundle.chunks[0]?.index : undefined,
      chunkHash: bundle.chunks.length === 1 ? bundle.chunks[0]?.hash : undefined,
      chunkSize: bundle.chunks.length === 1 ? bundle.chunks[0]?.sizeBytes : undefined,
      bundleHash,
      chunkIndexes: bundle.chunks.map((chunk) => chunk.index),
      chunks: bundle.chunks,
      temporaryPath: bundle.path,
    };
    this.offers.set(transferId, { ...offer, sourcePeerHash: peerKey });
    const sent = await this.sendOfferToPeer(peerKey, contextId, offer);
    if (!sent.ok) {
      const failed = sent as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[${this.loggerPrefix}] Failed to send chunk bundle offer fileHash=${manifest.fileHash} chunks=${bundle.chunks.map((chunk) => chunk.index).join(',')}:`,
        failed.error ?? failed.reason
      );
      this.offers.delete(transferId);
      this.cleanupTemporaryPath(bundle.path);
    }
  }

  async handleOffer(offer: ReticulumResourceTransferOffer, peerHash: string): Promise<void> {
    if (!this.isValidOffer(offer)) return;
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return;
    this.cleanupStaleAccepts(false);
    const download = this.downloads.get(offer.fileHash.toLowerCase());
    if (download) this.releaseStaleInFlightChunks(download);
    const manifest = download?.manifest ?? this.resourceStore.getManifest(offer.fileHash);
    if (!manifest || manifest.fileHash.toLowerCase() !== offer.fileHash.toLowerCase()) {
      loggerWarn(
        `[${this.loggerPrefix}] Ignoring resource offer fileHash=${offer.fileHash}: manifest not found`
      );
      return;
    }
    const normalizedOffer = this.normalizeChunkBundleOffer(offer, manifest);
    if (!normalizedOffer) return;
    if (this.canAcceptOffer) {
      const allowed = await this.canAcceptOffer(normalizedOffer.contextId, normalizedOffer, manifest);
      if (!allowed) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${normalizedOffer.fileHash}: offer not allowed`
        );
        return;
      }
    }
    if (download?.fullTransfer) return;
    if (normalizedOffer.chunkIndex != null) {
      const expectedChunkHash = manifest.chunkHashes[normalizedOffer.chunkIndex]?.toLowerCase();
      if (!expectedChunkHash || normalizedOffer.chunkHash?.toLowerCase() !== expectedChunkHash) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${normalizedOffer.fileHash} chunk=${normalizedOffer.chunkIndex}: chunk hash mismatch`
        );
        return;
      }
      if (normalizedOffer.chunkSize !== this.expectedChunkSize(manifest, normalizedOffer.chunkIndex)) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${normalizedOffer.fileHash} chunk=${normalizedOffer.chunkIndex}: chunk size mismatch`
        );
        return;
      }
      const localChunk = this.resourceStore.getChunk(normalizedOffer.fileHash, normalizedOffer.chunkIndex);
      if (localChunk?.status === 'complete' && localChunk.localPath) return;
      if (download && download.inFlightChunks.has(normalizedOffer.chunkIndex)) return;
      if (this.peerHasActiveOrPendingAcceptForResource(peerKey, normalizedOffer.fileHash)) return;
    } else if (Array.isArray(normalizedOffer.chunks) && normalizedOffer.chunks.length > 0) {
      if (!this.isValidChunkBundleOffer(normalizedOffer, manifest)) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${normalizedOffer.fileHash}: invalid chunk bundle`
        );
        return;
      }
      const neededChunks = normalizedOffer.chunks.filter((chunk) => {
        const localChunk = this.resourceStore.getChunk(normalizedOffer.fileHash, chunk.index);
        if (localChunk?.status === 'complete' && localChunk.localPath) return false;
        if (download?.inFlightChunks.has(chunk.index)) return false;
        return true;
      });
      if (neededChunks.length === 0) return;
      if (neededChunks.length !== normalizedOffer.chunks.length) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${normalizedOffer.fileHash}: partial chunk bundle overlap`
        );
        return;
      }
      if (this.peerHasActiveOrPendingAcceptForResource(peerKey, normalizedOffer.fileHash)) return;
    } else {
      if (normalizedOffer.sizeBytes !== manifest.sizeBytes) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${normalizedOffer.fileHash}: size mismatch`
        );
        return;
      }
      try {
        this.resourceStore.assembleResource(normalizedOffer.fileHash);
        return;
      } catch {
        // Missing data is expected for active downloads.
      }
      if (download?.fullTransfer) return;
      if (this.peerHasActiveOrPendingAcceptForResource(peerKey, normalizedOffer.fileHash)) return;
    }
    const trackedOffer: ReticulumResourceTransferOffer = {
      ...normalizedOffer,
      fileName: normalizedOffer.fileName || manifest.fileName,
      mimeType: normalizedOffer.mimeType || manifest.mimeType,
      sourcePeerHash: peerKey,
    };
    this.offers.set(normalizedOffer.transferId, trackedOffer);
    if (download && normalizedOffer.chunkIndex != null) {
      download.peerHashes.add(peerKey);
      let peers = download.chunkPeers.get(normalizedOffer.chunkIndex);
      if (!peers) {
        peers = new Set<string>();
        download.chunkPeers.set(normalizedOffer.chunkIndex, peers);
      }
      peers.add(peerKey);
    } else if (download && Array.isArray(normalizedOffer.chunks)) {
      download.peerHashes.add(peerKey);
      for (const chunk of normalizedOffer.chunks) {
        let peers = download.chunkPeers.get(chunk.index);
        if (!peers) {
          peers = new Set<string>();
          download.chunkPeers.set(chunk.index, peers);
        }
        peers.add(peerKey);
      }
    } else if (download) {
      download.peerHashes.add(peerKey);
    }
    this.enqueueAccept(normalizedOffer.transferId);
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
      chunkAttempts: new Map(),
      chunkPeers: new Map(),
      inFlightChunks: new Map(),
      peerBlockChunkLimits: new Map(),
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
    this.releaseStaleInFlightChunks(state);
    if (state.fullTransfer) {
      this.emitProgress(state);
      return;
    }
    const missing = this.getMissingChunkIndexes(state.manifest).filter((index) => {
      if (state.inFlightChunks.has(index)) return false;
      const attempts = state.chunkAttempts.get(index) ?? 0;
      return attempts < RETICULUM_RESOURCE_TRANSFER_MAX_CHUNK_ATTEMPTS;
    });
    if ((state.chunkAttempts.get(-1) ?? 0) > 0) {
      this.emitProgress(state, false, undefined, true);
      this.downloads.delete(state.fileHash);
      return;
    }
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
    const requestChunks = missing.length > 0 ? [missing[0]] : [];
    const availablePeers = [...state.peerHashes]
      .map((peer) => peer.trim().toLowerCase())
      .filter((peer) => peer && !this.peerHasActiveOrPendingAcceptForResource(peer, state.fileHash));
    for (const peerKey of availablePeers) {
      const requests = await this.buildRequestPayloads(state, requestChunks);
      if (requests.length === 0) {
        loggerWarn(
          `[${this.loggerPrefix}] Could not build targeted complete-file request fileHash=${state.fileHash}`
        );
      }
      for (const request of requests) {
        const throttleKey = `${state.contextId}:${peerKey}:${state.fileHash}:complete`;
        const now = this.now();
        if (now - (this.requestedResources.get(throttleKey) ?? 0) < RETICULUM_RESOURCE_TRANSFER_PULL_THROTTLE_MS) {
          continue;
        }
        this.requestedResources.set(throttleKey, now);
        const result = await this.sendRequestToPeer(peerKey, state.contextId, request);
        if (result.ok) {
          delivered = true;
        } else {
          const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
          loggerWarn(
            `[${this.loggerPrefix}] Targeted complete-file request failed fileHash=${state.fileHash} peer=${peerKey}:`,
            failed.error ?? failed.reason
          );
        }
      }
    }
    if (!delivered) {
      const requests = await this.buildRequestPayloads(state, requestChunks);
      if (requests.length === 0) {
        loggerWarn(
          `[${this.loggerPrefix}] Could not build complete-file fanout request fileHash=${state.fileHash}`
        );
      }
      for (const request of requests) {
        const result = await this.fanoutRequest(state.contextId, request);
        if (result.ok) {
          delivered = true;
        } else {
          const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
          loggerWarn(
            `[${this.loggerPrefix}] Complete-file fanout request failed fileHash=${state.fileHash}:`,
            failed.error ?? failed.reason
          );
        }
      }
    }
    state.chunkAttempts.set(-1, (state.chunkAttempts.get(-1) ?? 0) + 1);
    state.nextRequestAt = this.now() + RETICULUM_RESOURCE_TRANSFER_COMPLETE_FILE_RESPONSE_TIMEOUT_MS;
    if (!delivered) {
      this.emitProgress(state, false, undefined, true);
      this.downloads.delete(state.fileHash);
      return;
    }
    this.emitProgress(state);
  }

  private assignMissingChunksToPeers(
    state: ReticulumResourceDownloadState<TRequestWire>,
    missing: number[],
    peers: string[]
  ): Map<string, number[]> {
    const assignments = new Map<string, number[]>();
    const assigned = new Set<number>();
    const missingSet = new Set(missing);
    for (const peer of peers) {
      const limit = this.peerBlockChunkLimit(state, peer);
      const advertised = missing.filter(
        (index) =>
          !assigned.has(index) &&
          missingSet.has(index) &&
          (state.chunkPeers.get(index)?.has(peer) ?? false)
      );
      const candidates = advertised.length > 0
        ? advertised
        : missing.filter((index) => !assigned.has(index));
      if (candidates.length === 0) continue;
      const block = this.takeContiguousChunkRun(candidates, candidates[0], limit);
      if (block.length === 0) continue;
      assignments.set(peer, block);
      for (const index of block) assigned.add(index);
    }
    return assignments;
  }

  private takeContiguousChunkRun(
    indexes: number[],
    startIndex: number,
    limit: number
  ): number[] {
    const indexSet = new Set(indexes);
    const block: number[] = [];
    let next = startIndex;
    while (
      block.length < limit &&
      Number.isInteger(next) &&
      next >= 0 &&
      indexSet.has(next)
    ) {
      block.push(next);
      next += 1;
    }
    return block;
  }

  private peerBlockChunkLimit(
    state: ReticulumResourceDownloadState<TRequestWire>,
    peerHash: string
  ): number {
    const peerKey = peerHash.trim().toLowerCase();
    const current = state.peerBlockChunkLimits.get(peerKey);
    if (Number.isInteger(current) && current > 0) {
      return Math.max(
        RETICULUM_RESOURCE_TRANSFER_INITIAL_BLOCK_CHUNKS,
        Math.min(RETICULUM_RESOURCE_TRANSFER_MAX_BLOCK_CHUNKS, current)
      );
    }
    return RETICULUM_RESOURCE_TRANSFER_INITIAL_BLOCK_CHUNKS;
  }

  private growPeerBlockLimit(
    state: ReticulumResourceDownloadState<TRequestWire>,
    peerHash: string
  ): void {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return;
    const current = this.peerBlockChunkLimit(state, peerKey);
    state.peerBlockChunkLimits.set(
      peerKey,
      Math.min(RETICULUM_RESOURCE_TRANSFER_MAX_BLOCK_CHUNKS, current * 2)
    );
  }

  private shrinkPeerBlockLimit(
    state: ReticulumResourceDownloadState<TRequestWire>,
    peerHash: string
  ): void {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return;
    state.peerBlockChunkLimits.set(peerKey, RETICULUM_RESOURCE_TRANSFER_INITIAL_BLOCK_CHUNKS);
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
    const totalChunks = state.manifest.chunkHashes.length;
    const completedChunks = activeTransfer
      ? this.getCompletedChunkCountFast(state.manifest)
      : Math.max(0, totalChunks - this.getMissingChunkIndexes(state.manifest).length);
    let displayCompletedChunks = completedChunks;
    let progress =
      totalChunks > 0 ? completedChunks / totalChunks : 0;
    const isFullFileTransfer = !!activeTransfer &&
      activeTransfer?.offer.chunkIndex == null &&
      (!Array.isArray(activeTransfer.offer.chunks) || activeTransfer.offer.chunks.length === 0);
    if (activeTransfer && totalChunks > 0) {
      const transferProgress = Math.max(0, Math.min(1, activeTransfer.progress));
      const transferChunkCount = this.offerProgressChunkCount(
        activeTransfer.offer,
        totalChunks,
        completedChunks
      );
      const estimatedCompletedChunks = Math.max(
        completedChunks,
        Math.min(totalChunks, completedChunks + transferChunkCount * transferProgress)
      );
      displayCompletedChunks = Math.floor(estimatedCompletedChunks);
      progress = Math.max(progress, estimatedCompletedChunks / totalChunks);
      if (
        isFullFileTransfer &&
        Number.isFinite(activeTransfer.bytesTransferred) &&
        activeTransfer.bytesTransferred != null &&
        activeTransfer.offer.sizeBytes > 0
      ) {
        const byteProgress = Math.max(
          0,
          Math.min(1, activeTransfer.bytesTransferred / activeTransfer.offer.sizeBytes)
        );
        progress = Math.max(progress, byteProgress);
        displayCompletedChunks = Math.max(
          displayCompletedChunks,
          Math.floor(totalChunks * byteProgress)
        );
      }
    }
    const payload: ReticulumResourceTransferProgress = {
      contextId: state.contextId,
      eventId: state.eventId,
      fileHash: state.manifest.fileHash,
      completedChunks: displayCompletedChunks,
      totalChunks,
      ...(isFullFileTransfer ? { fullFileTransfer: true } : {}),
      ...(activeTransfer &&
      isFullFileTransfer
        ? {
            bytesTransferred: Math.max(
              0,
              Math.min(
                activeTransfer.offer.sizeBytes,
                Math.floor(Number(activeTransfer.bytesTransferred) || 0)
              )
            ),
            totalBytes: activeTransfer.offer.sizeBytes,
          }
        : {}),
      progress,
      complete: complete || (!activeTransfer && completedChunks >= totalChunks),
      failed,
    };
    this.emit('progress', payload);
    this.onProgress?.(payload);
  }

  private handleTransferProgress(payload: ReticulumResourceTransferPayload): void {
    if (typeof payload.progress !== 'number') return;
    const offer = this.offers.get(payload.transferId || '');
    if (!offer) return;
    const state = this.downloads.get(offer.fileHash);
    if (!state) return;
    this.activeAcceptStartedAt.set(offer.transferId, this.now());
    this.refreshOfferChunksInFlight(state, offer);
    this.logTransferSpeed(offer, payload);
    this.emitProgress(state, false, {
      offer,
      progress: payload.progress,
      bytesTransferred: Number(payload.bytesTransferred),
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

  private offerProgressChunkCount(
    offer: ReticulumResourceTransferOffer,
    totalChunks: number,
    completedChunks: number
  ): number {
    if (Array.isArray(offer.chunks) && offer.chunks.length > 0) {
      return offer.chunks.length;
    }
    if (offer.chunkIndex != null) return 1;
    return Math.max(0, totalChunks - completedChunks);
  }

  private getCompletedChunkCountFast(manifest: ReticulumResourceManifest): number {
    const chunks = this.resourceStore.getChunks(manifest.fileHash);
    let completed = 0;
    for (const chunk of chunks) {
      if (
        chunk.status === 'complete' &&
        chunk.localPath &&
        Number.isInteger(chunk.chunkIndex) &&
        chunk.chunkIndex >= 0 &&
        chunk.chunkIndex < manifest.chunkHashes.length
      ) {
        completed += 1;
      }
    }
    return completed;
  }

  private getMissingChunkIndexes(manifest: ReticulumResourceManifest): number[] {
    const chunks = this.resourceStore.getChunks(manifest.fileHash);
    const byIndex = new Map(chunks.map((chunk) => [chunk.chunkIndex, chunk]));
    const missing: number[] = [];
    for (const [index] of manifest.chunkHashes.entries()) {
      const chunk = byIndex.get(index);
      if (!chunk || chunk.status !== 'complete' || !chunk.localPath) {
        missing.push(index);
      }
    }
    return missing;
  }

  private getAvailableRequestedChunks(
    manifest: ReticulumResourceManifest,
    requestedIndexes: number[]
  ): Array<{ index: number; localPath: string; sizeBytes: number; chunkHash: string }> {
    const requested = new Set(
      requestedIndexes
        .filter((index) => Number.isInteger(index) && index >= 0 && index < manifest.chunkHashes.length)
        .slice(0, RETICULUM_RESOURCE_TRANSFER_MAX_BLOCK_CHUNKS)
    );
    const chunks = this.resourceStore.getChunks(manifest.fileHash);
    const available: Array<{ index: number; localPath: string; sizeBytes: number; chunkHash: string }> = [];
    for (const chunk of chunks) {
      if (!requested.has(chunk.chunkIndex)) continue;
      if (chunk.status !== 'complete' || !chunk.localPath) continue;
      const expectedHash = manifest.chunkHashes[chunk.chunkIndex]?.toLowerCase();
      if (!expectedHash) continue;
      available.push({
        index: chunk.chunkIndex,
        localPath: chunk.localPath,
        sizeBytes: chunk.sizeBytes,
        chunkHash: expectedHash,
      });
    }
    return available;
  }

  private createChunkBundle(
    manifest: ReticulumResourceManifest,
    chunks: Array<{ index: number; localPath: string; sizeBytes: number; chunkHash: string }>
  ): {
    path: string;
    sizeBytes: number;
    chunks: NonNullable<ReticulumResourceTransferOffer['chunks']>;
  } | null {
    if (chunks.length === 0) return null;
    const tempPath = this.resourceStore.createPlaintextTempPath(
      manifest.fileHash,
      `.bundle-${chunks[0]?.index ?? 0}.bin`
    );
    let offset = 0;
    const bundleChunks: NonNullable<ReticulumResourceTransferOffer['chunks']> = [];
    const out = fs.openSync(tempPath, 'w');
    let failed = false;
    try {
      for (const chunk of chunks) {
        const bytes = fs.readFileSync(chunk.localPath);
        const actualHash = nodeCrypto.createHash('sha256').update(bytes).digest('hex');
        if (actualHash !== chunk.chunkHash.toLowerCase()) {
          throw new Error(`chunk hash mismatch for ${chunk.index}`);
        }
        fs.writeSync(out, bytes, 0, bytes.length, offset);
        bundleChunks.push({
          index: chunk.index,
          hash: chunk.chunkHash.toLowerCase(),
          sizeBytes: bytes.length,
          offset,
        });
        offset += bytes.length;
      }
    } catch {
      failed = true;
    } finally {
      fs.closeSync(out);
    }
    if (failed) {
      this.cleanupTemporaryPath(tempPath);
      return null;
    }
    return {
      path: tempPath,
      sizeBytes: offset,
      chunks: bundleChunks,
    };
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
      if (state) {
        if (offer.chunkIndex != null || (Array.isArray(offer.chunks) && offer.chunks.length > 0)) {
          this.markOfferChunksInFlight(state, offer);
        } else {
          state.fullTransfer = { transferId: offer.transferId, startedAt: this.now() };
        }
      }
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
    const isChunkTransfer =
      offer.chunkIndex != null || (Array.isArray(offer.chunks) && offer.chunks.length > 0);
    const chunkRanges = offerChunkRanges(offer);
    const result = await this.bridge.acceptReticulumResourceDetailed({
      peerPresenceHash: senderHash,
      reticulumIdentityPublicKeyBase64: '',
      transferId: offer.transferId,
      savePath,
      fileName: offer.fileName,
      size: offer.sizeBytes,
      sha256: offer.bundleHash || offer.chunkHash || offer.fileHash,
      resourceType: isChunkTransfer
        ? this.chunkResourceType
        : this.resourceType,
      streamMode: false,
      metadata: {
        logicalResourceType: isChunkTransfer
          ? this.chunkResourceType
          : this.resourceType,
        eventId: offer.eventId ?? '',
        contextId: offer.contextId,
        ...this.contextMetadata(offer.contextId),
        fileHash: offer.fileHash,
        chunkIndex: offer.chunkIndex ?? null,
        chunkHash: offer.chunkHash ?? '',
        bundleHash: offer.bundleHash ?? '',
        chunkBundle: Array.isArray(offer.chunks) && offer.chunks.length > 0,
        chunkRanges,
        mimeType: offer.mimeType,
      },
      authMessage: {
        type: this.authMessageType,
        transferId: offer.transferId,
        eventId: offer.eventId ?? '',
        contextId: offer.contextId,
        ...this.contextMetadata(offer.contextId),
        fileHash: offer.fileHash,
        chunkIndex: offer.chunkIndex ?? null,
        chunkHash: offer.chunkHash ?? '',
        chunkSize: offer.chunkSize ?? null,
        bundleHash: offer.bundleHash ?? '',
        chunkBundle: Array.isArray(offer.chunks) && offer.chunks.length > 0,
        chunkRanges,
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
    if (
      !offer ||
      Number(auth.contextId) !== offer.contextId ||
      auth.fileHash !== offer.fileHash ||
      (offer.chunkIndex != null && Number(auth.chunkIndex) !== offer.chunkIndex) ||
      (offer.chunkHash && auth.chunkHash !== offer.chunkHash) ||
      (offer.bundleHash && auth.bundleHash !== offer.bundleHash) ||
      (Array.isArray(offer.chunks) && !sameChunkRanges(auth.chunkRanges, offerChunkRanges(offer)))
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
      if (offer.chunkIndex != null) {
        const expectedChunkHash = pendingManifest.chunkHashes[offer.chunkIndex]?.toLowerCase();
        if (!expectedChunkHash || actualHash !== expectedChunkHash) {
          loggerWarn(
            `[${this.loggerPrefix}] Cannot import resource chunk fileHash=${offer.fileHash} chunk=${offer.chunkIndex}: hash mismatch`
          );
          return;
        }
        this.resourceStore.storeChunk(offer.fileHash, offer.chunkIndex, bytes);
        try {
          this.resourceStore.assembleResource(offer.fileHash);
        } catch {
          // More chunks are still missing.
        }
        this.emit('resource', {
          contextId: offer.contextId,
          eventId: offer.eventId,
          fileHash: offer.fileHash,
          chunkIndex: offer.chunkIndex,
        });
        this.handleReceivedChunk(offer);
        return;
      }
      if (Array.isArray(offer.chunks) && offer.chunks.length > 0) {
        if (offer.bundleHash && actualHash !== offer.bundleHash.toLowerCase()) {
          loggerWarn(
            `[${this.loggerPrefix}] Cannot import resource chunk bundle fileHash=${offer.fileHash}: bundle hash mismatch`
          );
          return;
        }
        if (!this.importReceivedChunkBundle(offer, bytes, pendingManifest)) {
          return;
        }
        try {
          this.resourceStore.assembleResource(offer.fileHash);
        } catch {
          // More chunks are still missing.
        }
        this.emit('resource', {
          contextId: offer.contextId,
          eventId: offer.eventId,
          fileHash: offer.fileHash,
        });
        this.handleReceivedChunk(offer);
        return;
      }
      if (actualHash !== offer.fileHash.toLowerCase()) {
        loggerWarn(
          `[${this.loggerPrefix}] Cannot import resource fileHash=${offer.fileHash}: hash mismatch`
        );
        return;
      }
      const metadata =
        pendingManifest?.metadata && typeof pendingManifest.metadata === 'object'
          ? pendingManifest.metadata
          : {};
      this.resourceStore.importLocalFile({
        sourcePath: payload.path,
        namespace: pendingManifest?.namespace || 'reticulum-resource',
        ownerId: pendingManifest?.ownerId,
        fileName: pendingManifest?.fileName || offer.fileName,
        mimeType: pendingManifest?.mimeType || offer.mimeType,
        chunkSize: pendingManifest?.chunkSize,
        encrypted: pendingManifest?.encrypted ?? false,
        metadata: {
          ...metadata,
          contextId: offer.contextId,
          ...this.contextMetadata(offer.contextId),
          eventId: offer.eventId ?? (metadata.eventId as string | undefined) ?? '',
          receivedViaReticulum: true,
        },
      });
      this.emit('resource', {
        contextId: offer.contextId,
        eventId: offer.eventId,
        fileHash: offer.fileHash,
      });
      this.handleReceivedChunk(offer, true);
    } catch (err) {
      loggerWarn(`[${this.loggerPrefix}] Failed to import received resource:`, err);
      this.finishTransfer(payload.transferId, false);
    } finally {
      const state = this.downloads.get(offer.fileHash);
      if (state) {
        this.releaseOfferChunksInFlight(state, offer);
        this.releaseFullTransfer(state, offer);
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
    const isFullFileOffer =
      !!offer &&
      offer.chunkIndex == null &&
      (!Array.isArray(offer.chunks) || offer.chunks.length === 0);
    if (offer) this.cleanupTemporaryOfferFile(offer);
    this.offers.delete(transferId);
    this.transferSpeedSamples.delete(transferId);
    this.activeAccepts.delete(transferId);
    this.activeAcceptStartedAt.delete(transferId);
    if (offer) {
      const state = this.downloads.get(offer.fileHash);
      if (state) {
        if (!success && offer.sourcePeerHash) {
          this.shrinkPeerBlockLimit(state, offer.sourcePeerHash);
        }
        this.releaseOfferChunksInFlight(state, offer);
        this.releaseFullTransfer(state, offer);
        if (!success && isFullFileOffer) {
          this.clearPendingOffersForFile(offer.fileHash, offer.transferId);
          this.emitProgress(state, false, undefined, true);
          this.downloads.delete(offer.fileHash);
        }
      }
    }
    if (drainQueue) void this.processAcceptQueue();
  }

  private handleReceivedChunk(
    offer: ReticulumResourceTransferOffer,
    completeResource = false
  ): void {
    const state = this.downloads.get(offer.fileHash);
    if (!state) return;
    if (offer.sourcePeerHash) {
      this.growPeerBlockLimit(state, offer.sourcePeerHash);
    }
    if (offer.chunkIndex != null) {
      state.chunkAttempts.delete(offer.chunkIndex);
    }
    for (const chunkIndex of this.getOfferChunkIndexes(offer)) {
      state.chunkAttempts.delete(chunkIndex);
    }
    this.releaseOfferChunksInFlight(state, offer);
    this.releaseFullTransfer(state, offer);
    try {
      this.resourceStore.assembleResource(offer.fileHash);
      this.emitProgress(state, true);
      this.clearPendingOffersForFile(offer.fileHash, offer.transferId);
      this.downloads.delete(offer.fileHash);
      return;
    } catch {
      if (completeResource) {
        this.clearPendingOffersForFile(offer.fileHash, offer.transferId);
        this.downloads.delete(offer.fileHash);
        return;
      }
      this.emitProgress(state);
    }
  }

  private isValidOffer(offer: ReticulumResourceTransferOffer): boolean {
    if (typeof offer.transferId !== 'string' || !offer.transferId) return false;
    if (!Number.isInteger(offer.contextId) || offer.contextId <= 0) return false;
    if (offer.eventId != null && (typeof offer.eventId !== 'string' || offer.eventId.length < 8)) return false;
    if (typeof offer.fileHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.fileHash)) return false;
    if (!Number.isInteger(offer.sizeBytes) || offer.sizeBytes <= 0) return false;
    if (offer.chunkIndex != null && (!Number.isInteger(offer.chunkIndex) || offer.chunkIndex < 0)) return false;
    if (
      offer.chunkIndex != null &&
      (typeof offer.chunkHash !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(offer.chunkHash) ||
        !Number.isInteger(offer.chunkSize) ||
        offer.chunkSize <= 0)
    ) {
      return false;
    }
    if (offer.chunkHash != null && (typeof offer.chunkHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.chunkHash))) {
      return false;
    }
    if (offer.chunkSize != null && (!Number.isInteger(offer.chunkSize) || offer.chunkSize <= 0)) return false;
    if (offer.bundleHash != null && (typeof offer.bundleHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.bundleHash))) {
      return false;
    }
    if (offer.chunkIndexes != null) {
      if (
        !Array.isArray(offer.chunkIndexes) ||
        offer.chunkIndexes.length === 0 ||
        offer.chunkIndexes.some((index) => !Number.isInteger(index) || index < 0)
      ) {
        return false;
      }
    }
    if (offer.chunks != null) {
      if (!Array.isArray(offer.chunks) || offer.chunks.length === 0) return false;
      for (const chunk of offer.chunks) {
        if (
          !chunk ||
          !Number.isInteger(chunk.index) ||
          chunk.index < 0 ||
          typeof chunk.hash !== 'string' ||
          !/^[0-9a-f]{64}$/i.test(chunk.hash) ||
          !Number.isInteger(chunk.sizeBytes) ||
          chunk.sizeBytes <= 0 ||
          !Number.isInteger(chunk.offset) ||
          chunk.offset < 0
        ) {
          return false;
        }
      }
    }
    return true;
  }

  private normalizeChunkBundleOffer(
    offer: ReticulumResourceTransferOffer,
    manifest: ReticulumResourceManifest
  ): ReticulumResourceTransferOffer | null {
    if (Array.isArray(offer.chunks) && offer.chunks.length > 0) return offer;
    if (!Array.isArray(offer.chunkIndexes) || offer.chunkIndexes.length === 0) return offer;
    const seen = new Set<number>();
    const chunks: NonNullable<ReticulumResourceTransferOffer['chunks']> = [];
    let offset = 0;
    for (const index of offer.chunkIndexes) {
      if (seen.has(index)) return null;
      seen.add(index);
      const hash = manifest.chunkHashes[index]?.toLowerCase();
      if (!hash) return null;
      const sizeBytes = this.expectedChunkSize(manifest, index);
      chunks.push({
        index,
        hash,
        sizeBytes,
        offset,
      });
      offset += sizeBytes;
    }
    if (offer.sizeBytes !== offset) return null;
    return {
      ...offer,
      chunks,
    };
  }

  private isValidChunkBundleOffer(
    offer: ReticulumResourceTransferOffer,
    manifest: ReticulumResourceManifest
  ): boolean {
    if (!Array.isArray(offer.chunks) || offer.chunks.length === 0) return false;
    let expectedOffset = 0;
    const seen = new Set<number>();
    for (const chunk of offer.chunks) {
      if (seen.has(chunk.index)) return false;
      seen.add(chunk.index);
      const expectedHash = manifest.chunkHashes[chunk.index]?.toLowerCase();
      if (!expectedHash || chunk.hash.toLowerCase() !== expectedHash) return false;
      if (chunk.sizeBytes !== this.expectedChunkSize(manifest, chunk.index)) return false;
      if (chunk.offset !== expectedOffset) return false;
      expectedOffset += chunk.sizeBytes;
    }
    return offer.sizeBytes === expectedOffset;
  }

  private importReceivedChunkBundle(
    offer: ReticulumResourceTransferOffer,
    bytes: Buffer,
    manifest: ReticulumResourceManifest
  ): boolean {
    if (!this.isValidChunkBundleOffer(offer, manifest)) return false;
    if (bytes.length !== offer.sizeBytes) {
      loggerWarn(
        `[${this.loggerPrefix}] Cannot import resource chunk bundle fileHash=${offer.fileHash}: size mismatch`
      );
      return false;
    }
    for (const chunk of offer.chunks ?? []) {
      const chunkBytes = bytes.subarray(chunk.offset, chunk.offset + chunk.sizeBytes);
      const actualHash = nodeCrypto.createHash('sha256').update(chunkBytes).digest('hex');
      if (actualHash !== chunk.hash.toLowerCase()) {
        loggerWarn(
          `[${this.loggerPrefix}] Cannot import resource chunk bundle fileHash=${offer.fileHash} chunk=${chunk.index}: hash mismatch`
        );
        return false;
      }
    }
    for (const chunk of offer.chunks ?? []) {
      const chunkBytes = bytes.subarray(chunk.offset, chunk.offset + chunk.sizeBytes);
      this.resourceStore.storeChunk(offer.fileHash, chunk.index, Buffer.from(chunkBytes));
    }
    return true;
  }

  private expectedChunkSize(manifest: ReticulumResourceManifest, chunkIndex: number): number {
    if (chunkIndex < manifest.chunkHashes.length - 1) return manifest.chunkSize;
    return manifest.sizeBytes - manifest.chunkSize * chunkIndex;
  }

  private getOfferChunkIndexes(offer: ReticulumResourceTransferOffer): number[] {
    if (offer.chunkIndex != null) return [offer.chunkIndex];
    if (Array.isArray(offer.chunks)) return offer.chunks.map((chunk) => chunk.index);
    return [];
  }

  private markOfferChunksInFlight(
    state: ReticulumResourceDownloadState<TRequestWire>,
    offer: ReticulumResourceTransferOffer
  ): void {
    const startedAt = this.now();
    for (const chunkIndex of this.getOfferChunkIndexes(offer)) {
      state.inFlightChunks.set(chunkIndex, {
        transferId: offer.transferId,
        startedAt,
      });
    }
  }

  private releaseOfferChunksInFlight(
    state: ReticulumResourceDownloadState<TRequestWire>,
    offer: ReticulumResourceTransferOffer
  ): void {
    for (const chunkIndex of this.getOfferChunkIndexes(offer)) {
      const reservation = state.inFlightChunks.get(chunkIndex);
      if (reservation?.transferId === offer.transferId) {
        state.inFlightChunks.delete(chunkIndex);
      }
    }
  }

  private refreshOfferChunksInFlight(
    state: ReticulumResourceDownloadState<TRequestWire>,
    offer: ReticulumResourceTransferOffer
  ): void {
    const now = this.now();
    for (const chunkIndex of this.getOfferChunkIndexes(offer)) {
      const reservation = state.inFlightChunks.get(chunkIndex);
      if (reservation?.transferId === offer.transferId) {
        reservation.startedAt = now;
      }
    }
  }

  private releaseStaleInFlightChunks(state: ReticulumResourceDownloadState<TRequestWire>): void {
    const now = this.now();
    for (const [chunkIndex, reservation] of state.inFlightChunks.entries()) {
      if (now - reservation.startedAt >= RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS) {
        state.inFlightChunks.delete(chunkIndex);
      }
    }
  }

  private releaseFullTransfer(
    state: ReticulumResourceDownloadState<TRequestWire>,
    offer: ReticulumResourceTransferOffer
  ): void {
    if (state.fullTransfer?.transferId === offer.transferId) {
      delete state.fullTransfer;
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

  private peerHasActiveOrPendingAcceptForResource(peerHash: string, fileHash: string): boolean {
    const peerKey = peerHash.trim().toLowerCase();
    const blobId = fileHash.trim().toLowerCase();
    if (!peerKey || !blobId) return false;
    for (const transferId of this.activeAccepts) {
      const offer = this.offers.get(transferId);
      if (
        (offer?.sourcePeerHash || '').trim().toLowerCase() === peerKey &&
        (offer?.fileHash || '').trim().toLowerCase() === blobId
      ) {
        return true;
      }
    }
    for (const transferId of this.pendingAccepts) {
      const offer = this.offers.get(transferId);
      if (
        (offer?.sourcePeerHash || '').trim().toLowerCase() === peerKey &&
        (offer?.fileHash || '').trim().toLowerCase() === blobId
      ) {
        return true;
      }
    }
    return false;
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
