import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import * as path from 'path';
import type { ReticulumBridge, ReticulumSendResult } from './reticulum-bridge';
import {
  ReticulumResourceStore,
  type ReticulumResourceManifest,
} from './reticulum-resource-store';
import { warn as loggerWarn } from './logger';

export const RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT = 32;
export const RETICULUM_RESOURCE_TRANSFER_ACCEPT_CONCURRENCY = 4;
export const RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER = 1;
export const RETICULUM_RESOURCE_TRANSFER_RETRY_MS = 5_000;
export const RETICULUM_RESOURCE_TRANSFER_MAX_CHUNK_ATTEMPTS = 6;
export const RETICULUM_RESOURCE_TRANSFER_TTL_MS = 10 * 60 * 1000;
export const RETICULUM_RESOURCE_TRANSFER_PULL_THROTTLE_MS = 15_000;
export const RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS = 2 * 60 * 1000;

export type ReticulumResourceTransferRequest = {
  eventId?: string;
  fileHash: string;
  chunkIndexes?: number[];
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
  sourcePeerHash?: string;
  temporaryPath?: string;
};

export type ReticulumResourceTransferPayload = {
  status?: string;
  transferId?: string;
  path?: string;
  linkId?: string;
  auth?: Record<string, unknown>;
  reason?: string;
};

export type ReticulumResourceTransferProgress = {
  contextId: number;
  eventId?: string;
  fileHash: string;
  chunkIndex?: number;
  completedChunks?: number;
  totalChunks?: number;
  progress?: number;
  complete?: boolean;
};

export type ReticulumResourceDownloadRuntimeStatus = {
  active: boolean;
  peerCount: number;
  advertisedPeerCount: number;
  activeTransfers: number;
  pendingTransfers: number;
  requestedChunkCount: number;
  inFlightChunkCount: number;
  nextRequestAt: number | null;
};

type ReticulumResourceDownloadState<TRequestWire> = {
  contextId: number;
  fileHash: string;
  eventId?: string;
  manifest: ReticulumResourceManifest;
  peerHashes: Set<string>;
  chunkAttempts: Map<number, number>;
  chunkPeers: Map<number, Set<string>>;
  inFlightChunks: Map<number, { transferId: string; startedAt: number }>;
  fullTransfer?: { transferId: string; startedAt: number };
  nextRequestAt: number;
  featureData?: Record<string, unknown>;
  requestPayloads?: TRequestWire[];
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
  private readonly activeAccepts = new Set<string>();
  private readonly activeAcceptStartedAt = new Map<string, number>();
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
    this.activeAccepts.clear();
    this.activeAcceptStartedAt.clear();
  }

  getDownloadStatus(fileHash: string): ReticulumResourceDownloadRuntimeStatus {
    const blobId = String(fileHash || '').trim().toLowerCase();
    const state = this.downloads.get(blobId);
    if (!state) {
      return {
        active: false,
        peerCount: 0,
        advertisedPeerCount: 0,
        activeTransfers: 0,
        pendingTransfers: 0,
        requestedChunkCount: 0,
        inFlightChunkCount: 0,
        nextRequestAt: null,
      };
    }
    this.cleanupStaleActiveAccepts();
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
    return {
      active: true,
      peerCount: state.peerHashes.size,
      advertisedPeerCount: advertisedPeers.size,
      activeTransfers,
      pendingTransfers,
      requestedChunkCount: state.chunkAttempts.size,
      inFlightChunkCount: state.inFlightChunks.size,
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
    const fullResourcePath = this.tryGetCompleteResourcePath(manifest.fileHash);
    if (fullResourcePath) {
      await this.sendFullResourceOffer(contextId, request, peerKey, manifest, fullResourcePath);
      return;
    }
    const requestedIndexes = Array.isArray(request.chunkIndexes)
      ? request.chunkIndexes
      : manifest.chunkHashes
          .map((_, index) => index)
          .slice(0, RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT);
    const availableChunks = this.getAvailableRequestedChunks(manifest, requestedIndexes);
    if (availableChunks.length === 0) {
      loggerWarn(
        `[${this.loggerPrefix}] Cannot serve resource request fileHash=${request.fileHash}: no requested chunks available`
      );
      return;
    }
    for (const chunk of [...availableChunks].sort((a, b) => a.index - b.index)) {
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
        continue;
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
    }
  }

  async handleOffer(offer: ReticulumResourceTransferOffer, peerHash: string): Promise<void> {
    if (!this.isValidOffer(offer)) return;
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return;
    this.cleanupStaleActiveAccepts(false);
    const download = this.downloads.get(offer.fileHash.toLowerCase());
    if (download) this.releaseStaleInFlightChunks(download);
    const manifest = download?.manifest ?? this.resourceStore.getManifest(offer.fileHash);
    if (!manifest || manifest.fileHash.toLowerCase() !== offer.fileHash.toLowerCase()) {
      loggerWarn(
        `[${this.loggerPrefix}] Ignoring resource offer fileHash=${offer.fileHash}: manifest not found`
      );
      return;
    }
    if (this.canAcceptOffer) {
      const allowed = await this.canAcceptOffer(offer.contextId, offer, manifest);
      if (!allowed) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${offer.fileHash}: offer not allowed`
        );
        return;
      }
    }
    if (download?.fullTransfer) return;
    if (offer.chunkIndex != null) {
      const expectedChunkHash = manifest.chunkHashes[offer.chunkIndex]?.toLowerCase();
      if (!expectedChunkHash || offer.chunkHash?.toLowerCase() !== expectedChunkHash) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${offer.fileHash} chunk=${offer.chunkIndex}: chunk hash mismatch`
        );
        return;
      }
      if (offer.chunkSize !== this.expectedChunkSize(manifest, offer.chunkIndex)) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${offer.fileHash} chunk=${offer.chunkIndex}: chunk size mismatch`
        );
        return;
      }
      const localChunk = this.resourceStore.getChunk(offer.fileHash, offer.chunkIndex);
      if (localChunk?.status === 'complete' && localChunk.localPath) return;
      if (download && download.inFlightChunks.has(offer.chunkIndex)) return;
    } else {
      if (offer.sizeBytes !== manifest.sizeBytes) {
        loggerWarn(
          `[${this.loggerPrefix}] Ignoring resource offer fileHash=${offer.fileHash}: size mismatch`
        );
        return;
      }
      try {
        this.resourceStore.assembleResource(offer.fileHash);
        return;
      } catch {
        // Missing data is expected for active downloads.
      }
      if (download?.fullTransfer) return;
    }
    const trackedOffer: ReticulumResourceTransferOffer = {
      ...offer,
      fileName: offer.fileName || manifest.fileName,
      mimeType: offer.mimeType || manifest.mimeType,
      sourcePeerHash: peerKey,
    };
    this.offers.set(offer.transferId, trackedOffer);
    if (download && offer.chunkIndex != null) {
      download.peerHashes.add(peerKey);
      let peers = download.chunkPeers.get(offer.chunkIndex);
      if (!peers) {
        peers = new Set<string>();
        download.chunkPeers.set(offer.chunkIndex, peers);
      }
      peers.add(peerKey);
    } else if (download) {
      download.peerHashes.add(peerKey);
    }
    this.enqueueAccept(offer.transferId);
  }

  private tryGetCompleteResourcePath(fileHash: string): string | null {
    try {
      return this.resourceStore.assembleResource(fileHash);
    } catch {
      return null;
    }
  }

  private async sendFullResourceOffer(
    contextId: number,
    request: ReticulumResourceTransferRequest,
    peerKey: string,
    manifest: ReticulumResourceManifest,
    filePath: string
  ): Promise<void> {
    const transferId = nodeCrypto.randomBytes(8).toString('hex');
    const registered = await this.bridge?.sendReticulumResourceDetailed({
      allowedRecipientAddress: peerKey,
      transferId,
      filePath,
      fileName: manifest.fileName,
      size: manifest.sizeBytes,
      sha256: manifest.fileHash,
      resourceType: this.resourceType,
      metadata: {
        logicalResourceType: this.resourceType,
        eventId: request.eventId ?? '',
        contextId,
        ...this.contextMetadata(contextId),
        fileHash: manifest.fileHash,
        mimeType: manifest.mimeType,
        namespace: manifest.namespace,
      },
      expiresAt: this.now() + RETICULUM_RESOURCE_TRANSFER_TTL_MS,
    });
    if (!registered?.ok) {
      const failed = registered as Exclude<ReticulumSendResult, { ok: true }> | undefined;
      loggerWarn(
        `[${this.loggerPrefix}] Failed to register full resource offer fileHash=${manifest.fileHash}:`,
        failed?.error ?? failed?.reason ?? 'bridge unavailable'
      );
      return;
    }
    const offer: ReticulumResourceTransferOffer = {
      transferId,
      contextId,
      ...(request.eventId ? { eventId: request.eventId } : {}),
      fileHash: manifest.fileHash,
      sizeBytes: manifest.sizeBytes,
      fileName: manifest.fileName,
      mimeType: manifest.mimeType,
    };
    this.offers.set(transferId, { ...offer, sourcePeerHash: peerKey });
    const sent = await this.sendOfferToPeer(peerKey, contextId, offer);
    if (!sent.ok) {
      const failed = sent as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[${this.loggerPrefix}] Failed to send full resource offer fileHash=${manifest.fileHash}:`,
        failed.error ?? failed.reason
      );
      this.offers.delete(transferId);
    }
  }

  handleResourceEvent(payload: ReticulumResourceTransferPayload): void {
    if (payload?.status === 'auth' && payload.linkId && payload.transferId) {
      void this.authorize(payload);
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
    const chunks = missing.slice(0, RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT);
    const peerChunks = new Map<string, number[]>();
    const unadvertisedChunks: number[] = [];
    for (const chunkIndex of chunks) {
      const advertisedPeers = [...(state.chunkPeers.get(chunkIndex) ?? new Set<string>())]
        .map((peer) => peer.trim().toLowerCase())
        .filter((peer) => peer && state.peerHashes.has(peer));
      if (advertisedPeers.length === 0) {
        unadvertisedChunks.push(chunkIndex);
        continue;
      }
      for (const peer of advertisedPeers) {
        const list = peerChunks.get(peer) ?? [];
        list.push(chunkIndex);
        peerChunks.set(peer, list);
      }
    }
    if (unadvertisedChunks.length > 0) {
      for (const peer of state.peerHashes) {
        const peerKey = peer.trim().toLowerCase();
        if (!peerKey) continue;
        const list = peerChunks.get(peerKey) ?? [];
        list.push(...unadvertisedChunks);
        peerChunks.set(peerKey, list);
      }
    }
    let delivered = false;
    const deliveredChunks = new Set<number>();
    for (const [peerKey, peerRequestedChunks] of peerChunks.entries()) {
      const requests = await this.buildRequestPayloads(state, peerRequestedChunks);
      if (requests.length === 0) {
        loggerWarn(
          `[${this.loggerPrefix}] Could not build targeted request fileHash=${state.fileHash} chunks=${peerRequestedChunks.join(',')}`
        );
      }
      for (const request of requests) {
        const throttleKey = `${state.contextId}:${peerKey}:${state.fileHash}:${peerRequestedChunks.join(',')}`;
        const now = this.now();
        if (now - (this.requestedResources.get(throttleKey) ?? 0) < RETICULUM_RESOURCE_TRANSFER_PULL_THROTTLE_MS) {
          continue;
        }
        this.requestedResources.set(throttleKey, now);
        const result = await this.sendRequestToPeer(peerKey, state.contextId, request);
        if (result.ok) {
          delivered = true;
          for (const index of peerRequestedChunks) deliveredChunks.add(index);
        } else {
          const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
          loggerWarn(
            `[${this.loggerPrefix}] Targeted resource request failed fileHash=${state.fileHash} peer=${peerKey}:`,
            failed.error ?? failed.reason
          );
        }
      }
    }
    if (!delivered) {
      const requests = await this.buildRequestPayloads(state, chunks);
      if (requests.length === 0) {
        loggerWarn(
          `[${this.loggerPrefix}] Could not build fanout request fileHash=${state.fileHash} chunks=${chunks.join(',')}`
        );
      }
      for (const request of requests) {
        const result = await this.fanoutRequest(state.contextId, request);
        if (result.ok) {
          delivered = true;
          for (const index of chunks) deliveredChunks.add(index);
        } else {
          const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
          loggerWarn(
            `[${this.loggerPrefix}] Fanout resource request failed fileHash=${state.fileHash}:`,
            failed.error ?? failed.reason
          );
        }
      }
    }
    if (delivered) {
      for (const index of deliveredChunks) {
        state.chunkAttempts.set(index, (state.chunkAttempts.get(index) ?? 0) + 1);
      }
    }
    state.nextRequestAt = this.now() + RETICULUM_RESOURCE_TRANSFER_RETRY_MS;
    this.emitProgress(state);
  }

  private emitProgress(
    state: ReticulumResourceDownloadState<TRequestWire>,
    complete = false
  ): void {
    const totalChunks = state.manifest.chunkHashes.length;
    const missingChunks = this.getMissingChunkIndexes(state.manifest).length;
    const completedChunks = Math.max(0, totalChunks - missingChunks);
    const payload: ReticulumResourceTransferProgress = {
      contextId: state.contextId,
      eventId: state.eventId,
      fileHash: state.manifest.fileHash,
      completedChunks,
      totalChunks,
      progress: totalChunks > 0 ? completedChunks / totalChunks : 0,
      complete: complete || missingChunks === 0,
    };
    this.emit('progress', payload);
    this.onProgress?.(payload);
  }

  private getMissingChunkIndexes(manifest: ReticulumResourceManifest): number[] {
    const chunks = this.resourceStore.getChunks(manifest.fileHash);
    const byIndex = new Map(chunks.map((chunk) => [chunk.chunkIndex, chunk]));
    const missing: number[] = [];
    for (const [index, chunkHash] of manifest.chunkHashes.entries()) {
      const chunk = byIndex.get(index);
      if (!chunk || chunk.status !== 'complete' || !chunk.localPath) {
        missing.push(index);
        continue;
      }
      try {
        const bytes = fs.readFileSync(chunk.localPath);
        const actualHash = nodeCrypto.createHash('sha256').update(bytes).digest('hex');
        if (actualHash !== chunkHash.toLowerCase()) missing.push(index);
      } catch {
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
        .slice(0, RETICULUM_RESOURCE_TRANSFER_CHUNK_REQUEST_LIMIT)
    );
    const chunks = this.resourceStore.getChunks(manifest.fileHash);
    const available: Array<{ index: number; localPath: string; sizeBytes: number; chunkHash: string }> = [];
    for (const chunk of chunks) {
      if (!requested.has(chunk.chunkIndex)) continue;
      if (chunk.status !== 'complete' || !chunk.localPath) continue;
      try {
        const bytes = fs.readFileSync(chunk.localPath);
        const actualHash = nodeCrypto.createHash('sha256').update(bytes).digest('hex');
        const expectedHash = manifest.chunkHashes[chunk.chunkIndex]?.toLowerCase();
        if (actualHash !== expectedHash) continue;
        available.push({
          index: chunk.chunkIndex,
          localPath: chunk.localPath,
          sizeBytes: bytes.length,
          chunkHash: expectedHash,
        });
      } catch {
        continue;
      }
    }
    return available;
  }

  private enqueueAccept(transferId: string): void {
    if (this.pendingAccepts.includes(transferId) || this.activeAccepts.has(transferId)) {
      return;
    }
    this.pendingAccepts.push(transferId);
    void this.processAcceptQueue();
  }

  private async processAcceptQueue(): Promise<void> {
    this.cleanupStaleActiveAccepts(false);
    while (
      this.activeAccepts.size < RETICULUM_RESOURCE_TRANSFER_ACCEPT_CONCURRENCY &&
      this.pendingAccepts.length > 0
    ) {
      const pendingIndex = this.pendingAccepts.findIndex((candidateTransferId) => {
        if (this.activeAccepts.has(candidateTransferId)) return false;
        const candidateOffer = this.offers.get(candidateTransferId);
        if (!candidateOffer) return true;
        return !this.peerHasMaxActiveAccepts(candidateOffer.sourcePeerHash || '');
      });
      if (pendingIndex < 0) break;
      const [transferId] = this.pendingAccepts.splice(pendingIndex, 1);
      if (!transferId || this.activeAccepts.has(transferId)) continue;
      const offer = this.offers.get(transferId);
      if (!offer) continue;
      this.activeAccepts.add(transferId);
      this.activeAcceptStartedAt.set(transferId, this.now());
      const state = this.downloads.get(offer.fileHash);
      if (state) {
        if (offer.chunkIndex != null) {
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
    const isChunkTransfer = offer.chunkIndex != null;
    const result = await this.bridge.acceptReticulumResourceDetailed({
      peerPresenceHash: senderHash,
      reticulumIdentityPublicKeyBase64: '',
      transferId: offer.transferId,
      savePath,
      fileName: offer.fileName,
      size: offer.sizeBytes,
      sha256: offer.chunkHash || offer.fileHash,
      resourceType: isChunkTransfer
        ? this.chunkResourceType
        : this.resourceType,
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
      (offer.chunkHash && auth.chunkHash !== offer.chunkHash)
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
    this.activeAccepts.delete(transferId);
    this.activeAcceptStartedAt.delete(transferId);
    if (offer) {
      const state = this.downloads.get(offer.fileHash);
      if (state) {
        this.releaseOfferChunksInFlight(state, offer);
        this.releaseFullTransfer(state, offer);
      }
    }
    if (!success && offer) {
      const state = this.downloads.get(offer.fileHash);
      if (state) {
        state.nextRequestAt = 0;
        this.scheduleDownload(0);
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
    if (offer.chunkIndex != null) {
      state.chunkAttempts.delete(offer.chunkIndex);
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
      state.nextRequestAt = 0;
      this.scheduleDownload(0);
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
    return true;
  }

  private expectedChunkSize(manifest: ReticulumResourceManifest, chunkIndex: number): number {
    if (chunkIndex < manifest.chunkHashes.length - 1) return manifest.chunkSize;
    return manifest.sizeBytes - manifest.chunkSize * chunkIndex;
  }

  private getOfferChunkIndexes(offer: ReticulumResourceTransferOffer): number[] {
    if (offer.chunkIndex != null) return [offer.chunkIndex];
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

  private releaseStaleInFlightChunks(state: ReticulumResourceDownloadState<TRequestWire>): void {
    const now = this.now();
    for (const [chunkIndex, reservation] of state.inFlightChunks.entries()) {
      if (now - reservation.startedAt >= RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS) {
        state.inFlightChunks.delete(chunkIndex);
      }
    }
    if (state.fullTransfer && now - state.fullTransfer.startedAt >= RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS) {
      delete state.fullTransfer;
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
        this.offers.delete(transferId);
      }
    }
  }

  private peerHasMaxActiveAccepts(peerHash: string): boolean {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return false;
    let activeForPeer = 0;
    for (const transferId of this.activeAccepts) {
      const offer = this.offers.get(transferId);
      if ((offer?.sourcePeerHash || '').trim().toLowerCase() === peerKey) {
        activeForPeer += 1;
      }
    }
    return activeForPeer >= RETICULUM_RESOURCE_TRANSFER_ACCEPTS_PER_PEER;
  }

  private cleanupStaleActiveAccepts(drainQueue = true): void {
    const now = this.now();
    const staleTransferIds: string[] = [];
    for (const transferId of this.activeAccepts) {
      const startedAt = this.activeAcceptStartedAt.get(transferId) ?? now;
      if (now - startedAt >= RETICULUM_RESOURCE_TRANSFER_IN_FLIGHT_STALE_MS) {
        staleTransferIds.push(transferId);
      }
    }
    for (const transferId of staleTransferIds) {
      loggerWarn(
        `[${this.loggerPrefix}] Resource transfer stale transfer=${transferId}; releasing active slot`
      );
      this.finishTransfer(transferId, false, false);
    }
    if (drainQueue && staleTransferIds.length > 0) void this.processAcceptQueue();
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
