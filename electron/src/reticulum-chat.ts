import * as nodeCrypto from 'crypto';
import { EventEmitter } from 'events';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import nacl from 'tweetnacl';
import {
  base58Decode,
  canonicalizeForSigning,
  deriveAddressFromPublicKey,
} from './presence';
import { ReticulumChatDatabase } from './reticulum-chat-db';
import type { ReticulumBridge, ReticulumSendResult } from './reticulum-bridge';
import { log as loggerLog, warn as loggerWarn } from './logger';
import {
  byteLengthUtf8JsonWithBridgeSender,
  RT_RETICULUM_MAX_WIRE_JSON_BYTES,
  wireFitsReticulum,
} from './reticulum-wire-size';

export type ReticulumChatEventType =
  | 'message'
  | 'edit'
  | 'delete'
  | 'reaction_add'
  | 'reaction_remove'
  | 'attachment_manifest';

export interface ReticulumChatEvent {
  eventId: string;
  groupId: number;
  authorAddress: string;
  authorPublicKey: string;
  authorSeq: number;
  timestamp: number;
  eventType: ReticulumChatEventType;
  targetEventId?: string;
  replyToEventId?: string;
  encryptedPayload: string;
  payloadHash: string;
  signature: string;
}

export interface ReticulumChatEventHint {
  eventId: string;
  groupId: number;
  authorAddress: string;
  authorSeq: number;
  timestamp: number;
  eventType: ReticulumChatEventType;
  payloadHash: string;
}

export interface ReticulumChatEventHintWire {
  id: string;
  a: string;
  n: number;
  ts: number;
  et: ReticulumChatEventType;
  ph: string;
}

export interface ReticulumChatEventOffer {
  transferId: string;
  eventId: string;
  groupId: number;
  payloadHash: string;
  wireHash: string;
  sizeBytes: number;
  senderReticulumDestinationHash?: string;
  senderReticulumIdentityPublicKeyBase64?: string;
}

export interface ReticulumChatEventOfferWire {
  x: string;
  id: string;
  ph: string;
  wh: string;
  s: number;
}

export type ReticulumChatSyncMode = 'latest' | 'after' | 'before';

export type ReticulumChatWire =
  | { t: 'RCHAT'; k: 'sub'; g: number }
  | { t: 'RCHAT'; k: 'unsub'; g: number }
  | { t: 'RCHAT'; k: 'event_hint'; g: number; h: ReticulumChatEventHintWire }
  | { t: 'RCHAT'; k: 'event_req'; g: number; id: string }
  | { t: 'RCHAT'; k: 'event_offer'; g: number; o: ReticulumChatEventOfferWire }
  | { t: 'RCHAT'; k: 'hint'; g: number; ids?: string[]; seqs?: Record<string, number> }
  | {
      t: 'RCHAT';
      k: 'sync_req';
      g: number;
      mode?: ReticulumChatSyncMode;
      ts?: number;
      id?: string;
      limit?: number;
      seqs?: Record<string, number>;
    }
  | {
      t: 'RCHAT';
      k: 'sync_hints';
      g: number;
      hints: ReticulumChatEventHintWire[];
      more?: boolean;
      nextTs?: number;
      nextId?: string;
      moreBefore?: boolean;
      prevTs?: number;
      prevId?: string;
    }
  | { t: 'RCHAT'; k: 'typing'; g: number; a: string; ts: number; active: boolean };

export interface ReticulumChatManagerOptions {
  dbPath?: string;
  bridge?: ReticulumBridge | null;
  now?: () => number;
  localNotifyDebounceMs?: number;
}

const RETICULUM_CHAT_MAX_FUTURE_SKEW_MS = 60_000;
const RETICULUM_CHAT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const RETICULUM_CHAT_TYPING_TTL_MS = 8_000;
const RETICULUM_CHAT_TYPING_REFRESH_MS = 3_000;
const RETICULUM_CHAT_SYNC_LIMIT = 200;
const RETICULUM_CHAT_DEFAULT_SYNC_WINDOW = 100;
const RETICULUM_CHAT_SYNC_OVERLAP_MS = 5_000;
const RETICULUM_CHAT_PULL_THROTTLE_MS = 15_000;
const RETICULUM_CHAT_RESOURCE_TTL_MS = 10 * 60 * 1000;
const RETICULUM_CHAT_LOCAL_NOTIFY_DEBOUNCE_MS = 50;
const VALID_EVENT_TYPES = new Set<ReticulumChatEventType>([
  'message',
  'edit',
  'delete',
  'reaction_add',
  'reaction_remove',
  'attachment_manifest',
]);

type ReticulumChatResourcePayload = {
  status?: string;
  transferId?: string;
  peerPresenceHash?: string;
  path?: string;
  sha256?: string;
  eventId?: string;
  groupId?: number;
  payloadHash?: string;
  wireHash?: string;
  sizeBytes?: number;
  linkId?: string;
  auth?: Record<string, unknown>;
  reason?: string;
};

export function buildReticulumChatSignedFields(
  event: ReticulumChatEvent
): Record<string, unknown> {
  return {
    authorAddress: event.authorAddress,
    authorPublicKey: event.authorPublicKey,
    authorSeq: event.authorSeq,
    encryptedPayload: event.encryptedPayload,
    eventId: event.eventId,
    eventType: event.eventType,
    groupId: event.groupId,
    payloadHash: event.payloadHash,
    replyToEventId: event.replyToEventId ?? null,
    targetEventId: event.targetEventId ?? null,
    timestamp: event.timestamp,
  };
}

export function hashReticulumChatPayload(encryptedPayload: string): string {
  return nodeCrypto
    .createHash('sha256')
    .update(encryptedPayload, 'utf8')
    .digest('hex');
}

export function serializeReticulumChatEvent(event: ReticulumChatEvent): string {
  return JSON.stringify(event);
}

export function hashReticulumChatEventWire(event: ReticulumChatEvent): string {
  return nodeCrypto
    .createHash('sha256')
    .update(serializeReticulumChatEvent(event), 'utf8')
    .digest('hex');
}

export function buildReticulumChatEventHint(
  event: ReticulumChatEvent
): ReticulumChatEventHint {
  return {
    eventId: event.eventId,
    groupId: event.groupId,
    authorAddress: event.authorAddress,
    authorSeq: event.authorSeq,
    timestamp: event.timestamp,
    eventType: event.eventType,
    payloadHash: event.payloadHash,
  };
}

function eventHintToWire(hint: ReticulumChatEventHint): ReticulumChatEventHintWire {
  return {
    id: hint.eventId,
    a: hint.authorAddress,
    n: hint.authorSeq,
    ts: hint.timestamp,
    et: hint.eventType,
    ph: hint.payloadHash,
  };
}

function eventHintFromWire(groupId: number, wire: unknown): ReticulumChatEventHint | null {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const h = wire as Partial<ReticulumChatEventHintWire>;
  return {
    eventId: String(h.id || ''),
    groupId,
    authorAddress: String(h.a || ''),
    authorSeq: Number(h.n || 0),
    timestamp: Number(h.ts || 0),
    eventType: h.et as ReticulumChatEventType,
    payloadHash: String(h.ph || ''),
  };
}

function eventOfferToWire(offer: ReticulumChatEventOffer): ReticulumChatEventOfferWire {
  return {
    x: offer.transferId,
    id: offer.eventId,
    ph: offer.payloadHash,
    wh: offer.wireHash,
    s: offer.sizeBytes,
  };
}

function eventOfferFromWire(groupId: number, wire: unknown): ReticulumChatEventOffer | null {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const o = wire as Partial<ReticulumChatEventOfferWire>;
  return {
    transferId: String(o.x || ''),
    eventId: String(o.id || ''),
    groupId,
    payloadHash: String(o.ph || ''),
    wireHash: String(o.wh || ''),
    sizeBytes: Number(o.s || 0),
  };
}

export function validateReticulumChatEventShape(
  event: unknown,
  now = Date.now()
): event is ReticulumChatEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const e = event as Partial<ReticulumChatEvent>;
  if (typeof e.eventId !== 'string' || e.eventId.length < 8) return false;
  if (!Number.isInteger(e.groupId) || (e.groupId as number) <= 0) return false;
  if (typeof e.authorAddress !== 'string' || !e.authorAddress) return false;
  if (typeof e.authorPublicKey !== 'string' || !e.authorPublicKey) return false;
  if (!Number.isInteger(e.authorSeq) || (e.authorSeq as number) <= 0) return false;
  if (!Number.isFinite(e.timestamp)) return false;
  if ((e.timestamp as number) > now + RETICULUM_CHAT_MAX_FUTURE_SKEW_MS) return false;
  if ((e.timestamp as number) < now - RETICULUM_CHAT_MAX_AGE_MS) return false;
  if (typeof e.eventType !== 'string' || !VALID_EVENT_TYPES.has(e.eventType as ReticulumChatEventType)) return false;
  if (e.targetEventId != null && typeof e.targetEventId !== 'string') return false;
  if (e.replyToEventId != null && typeof e.replyToEventId !== 'string') return false;
  if (typeof e.encryptedPayload !== 'string' || !e.encryptedPayload) return false;
  if (typeof e.payloadHash !== 'string' || !/^[0-9a-f]{64}$/i.test(e.payloadHash)) return false;
  if (hashReticulumChatPayload(e.encryptedPayload) !== e.payloadHash.toLowerCase()) return false;
  if (typeof e.signature !== 'string' || !e.signature) return false;
  try {
    return deriveAddressFromPublicKey(e.authorPublicKey) === e.authorAddress;
  } catch {
    return false;
  }
}

export function verifyReticulumChatEvent(event: ReticulumChatEvent): boolean {
  try {
    const derived = deriveAddressFromPublicKey(event.authorPublicKey);
    if (derived !== event.authorAddress) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(buildReticulumChatSignedFields(event))
      ),
      new Uint8Array(base58Decode(event.signature)),
      new Uint8Array(base58Decode(event.authorPublicKey))
    );
  } catch {
    return false;
  }
}

function defaultReticulumChatDbPath(): string {
  return path.join(app.getPath('appData'), 'qortal-shared', 'reticulum-chat.db');
}

export class ReticulumChatManager extends EventEmitter {
  private readonly db: ReticulumChatDatabase;
  private readonly now: () => number;
  private readonly dbPath: string;
  private readonly localNotifyDir: string;
  private readonly localNotifyDebounceMs: number;
  private bridge: ReticulumBridge | null;
  private localGroupIds = new Set<number>();
  private subscribedGroups = new Set<number>();
  private peerSubscriptions = new Map<string, Set<number>>();
  private requestedEventPulls = new Map<string, number>();
  private resourceOffers = new Map<string, ReticulumChatEventOffer>();
  private lastTypingSentAt = new Map<string, number>();
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private observedDbEventIds = new Set<string>();
  private localNotifyWatcher: fs.FSWatcher | null = null;
  private localNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  private seenLocalNotifyFiles = new Set<string>();

  constructor(options: ReticulumChatManagerOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.dbPath = options.dbPath ?? defaultReticulumChatDbPath();
    this.localNotifyDir = path.join(path.dirname(this.dbPath), 'reticulum-chat-notify');
    this.localNotifyDebounceMs = Math.max(
      10,
      options.localNotifyDebounceMs ?? RETICULUM_CHAT_LOCAL_NOTIFY_DEBOUNCE_MS
    );
    this.bridge = options.bridge ?? null;
    this.db = new ReticulumChatDatabase(this.dbPath);
    fs.mkdirSync(this.localNotifyDir, { recursive: true });
    this.attachBridge(this.bridge);
  }

  setBridge(bridge: ReticulumBridge | null): void {
    if (this.bridge === bridge) return;
    this.detachBridge();
    this.bridge = bridge;
    this.attachBridge(bridge);
  }

  close(): void {
    this.detachBridge();
    this.stopLocalNotificationWatcher();
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
    this.db.close();
  }

  setLocalGroupMemberships(groupIds: number[]): void {
    this.localGroupIds = new Set(groupIds.filter((id) => Number.isInteger(id) && id > 0));
  }

  getSubscriptions(): number[] {
    return [...this.subscribedGroups].sort((a, b) => a - b);
  }

  subscribeGroup(groupId: number): void {
    this.assertGroupId(groupId);
    this.markGroupHistoryObserved(groupId);
    this.subscribedGroups.add(groupId);
    this.startLocalNotificationWatcher();
    void this.fanout({ t: 'RCHAT', k: 'sub', g: groupId });
    void this.fanout(this.buildSyncReqWire(groupId));
  }

  unsubscribeGroup(groupId: number): void {
    this.assertGroupId(groupId);
    this.subscribedGroups.delete(groupId);
    if (this.subscribedGroups.size === 0) this.stopLocalNotificationWatcher();
    void this.fanout({ t: 'RCHAT', k: 'unsub', g: groupId });
  }

  async publishEvent(event: ReticulumChatEvent): Promise<ReticulumSendResult> {
    const accepted = this.acceptEvent(event, true);
    if (!accepted) {
      return { ok: false, reason: 'send-command-failed', error: 'Invalid event' };
    }
    const fanoutResult = await this.fanout(this.buildEventHintWire(event));
    if (!fanoutResult.ok) {
      const failed = fanoutResult as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[ReticulumChat] Stored event ${event.eventId} locally, but live hint fanout failed:`,
        failed.error ?? failed.reason
      );
    }
    return { ok: true };
  }

  sendTyping(groupId: number, authorAddress: string, active: boolean): void {
    this.assertGroupId(groupId);
    const key = `${groupId}:${authorAddress}`;
    const now = this.now();
    if (active && now - (this.lastTypingSentAt.get(key) ?? 0) < RETICULUM_CHAT_TYPING_REFRESH_MS) {
      return;
    }
    this.lastTypingSentAt.set(key, now);
    void this.fanout({ t: 'RCHAT', k: 'typing', g: groupId, a: authorAddress, ts: now, active });
  }

  getHistory(groupId: number, limit = 100): ReticulumChatEvent[] {
    this.assertGroupId(groupId);
    return this.db.getRecentEvents(groupId, Math.max(1, Math.min(500, limit)));
  }

  getSyncState(groupId: number): Record<string, number> {
    this.assertGroupId(groupId);
    return this.db.getSyncState(groupId);
  }

  handleWire(
    wire: Record<string, unknown>,
    peerPresenceHash = '',
    senderDestinationHash = ''
  ): void {
    if (wire.t !== 'RCHAT' || typeof wire.k !== 'string') return;
    const groupId = Number(wire.g);
    if (!Number.isInteger(groupId) || groupId <= 0) return;

    switch (wire.k) {
      case 'sub':
        this.notePeerSubscription(peerPresenceHash || senderDestinationHash, groupId, true);
        if (this.subscribedGroups.has(groupId)) {
          void this.sendToPeer(peerPresenceHash || senderDestinationHash, this.buildSyncReqWire(groupId));
        }
        return;
      case 'unsub':
        this.notePeerSubscription(peerPresenceHash || senderDestinationHash, groupId, false);
        return;
      case 'event_hint':
        this.handleEventHint(eventHintFromWire(groupId, wire.h), peerPresenceHash || senderDestinationHash);
        return;
      case 'hint':
        if (this.subscribedGroups.has(groupId)) {
          void this.sendToPeer(peerPresenceHash || senderDestinationHash, this.buildSyncReqWire(groupId));
        }
        return;
      case 'event_req':
        if (typeof wire.id !== 'string' || !wire.id) return;
        void this.offerEventResource(peerPresenceHash || senderDestinationHash, groupId, wire.id);
        return;
      case 'event_offer':
        this.handleEventOffer(eventOfferFromWire(groupId, wire.o), peerPresenceHash || senderDestinationHash);
        return;
      case 'sync_req': {
        if (!this.canServeGroupHistory(groupId)) return;
        const syncLimit = this.normalizeSyncLimit(wire.limit);
        const events = this.getEventsForSyncRequest(
          groupId,
          wire,
          Math.min(RETICULUM_CHAT_SYNC_LIMIT + 1, syncLimit + 1)
        );
        if (events.length) this.db.markServed(events.map((e) => e.eventId));
        void this.sendSyncHintsToPeer(
          peerPresenceHash || senderDestinationHash,
          groupId,
          events,
          syncLimit,
          typeof wire.mode === 'string' ? wire.mode : undefined
        );
        return;
      }
      case 'sync_hints':
        if (!Array.isArray(wire.hints)) return;
        for (const hint of wire.hints) {
          this.handleEventHint(eventHintFromWire(groupId, hint), peerPresenceHash || senderDestinationHash);
        }
        if (
          wire.more === true &&
          this.subscribedGroups.has(groupId) &&
          typeof wire.nextTs === 'number' &&
          Number.isFinite(wire.nextTs) &&
          typeof wire.nextId === 'string' &&
          wire.nextId
        ) {
          void this.sendToPeer(peerPresenceHash || senderDestinationHash, {
            t: 'RCHAT',
            k: 'sync_req',
            g: groupId,
            mode: 'after',
            ts: wire.nextTs,
            id: wire.nextId,
            limit: RETICULUM_CHAT_DEFAULT_SYNC_WINDOW,
          });
        }
        if (
          wire.moreBefore === true &&
          this.subscribedGroups.has(groupId) &&
          typeof wire.prevTs === 'number' &&
          Number.isFinite(wire.prevTs) &&
          typeof wire.prevId === 'string' &&
          wire.prevId
        ) {
          void this.sendToPeer(peerPresenceHash || senderDestinationHash, {
            t: 'RCHAT',
            k: 'sync_req',
            g: groupId,
            mode: 'before',
            ts: wire.prevTs,
            id: wire.prevId,
            limit: RETICULUM_CHAT_DEFAULT_SYNC_WINDOW,
          });
        }
        return;
      case 'typing':
        if (typeof wire.a !== 'string') return;
        this.applyTyping(groupId, wire.a, wire.active === true);
        return;
      default:
        return;
    }
  }

  private acceptEvent(candidate: unknown, ownEvent: boolean): boolean {
    const now = this.now();
    if (!validateReticulumChatEventShape(candidate, now)) return false;
    const event = candidate;
    if (!ownEvent && !this.localGroupIds.has(event.groupId)) return false;
    if (!verifyReticulumChatEvent(event)) return false;
    if (this.db.hasEvent(event.eventId)) return false;
    const inserted = this.db.insertEvent(event, ownEvent);
    if (inserted) {
      this.observedDbEventIds.add(event.eventId);
      this.writeLocalEventNotification(event);
    }
    return inserted;
  }

  private markGroupHistoryObserved(groupId: number): void {
    for (const event of this.db.getRecentEvents(groupId, 500)) {
      this.observedDbEventIds.add(event.eventId);
    }
  }

  private canServeGroupHistory(groupId: number): boolean {
    return (
      this.subscribedGroups.has(groupId) ||
      this.localGroupIds.has(groupId) ||
      this.db.getRecentEvents(groupId, 1).length > 0
    );
  }

  private startLocalNotificationWatcher(): void {
    if (this.localNotifyWatcher) return;
    fs.mkdirSync(this.localNotifyDir, { recursive: true });
    this.cleanupOldLocalNotifications();
    this.scanLocalNotifications();
    try {
      this.localNotifyWatcher = fs.watch(this.localNotifyDir, () => {
        this.scheduleLocalNotificationScan();
      });
      this.scheduleLocalNotificationScan();
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to watch local event notifications:', err);
      this.localNotifyWatcher = null;
    }
  }

  private stopLocalNotificationWatcher(): void {
    if (this.localNotifyTimer) {
      clearTimeout(this.localNotifyTimer);
      this.localNotifyTimer = null;
    }
    if (!this.localNotifyWatcher) return;
    this.localNotifyWatcher.close();
    this.localNotifyWatcher = null;
  }

  private scheduleLocalNotificationScan(): void {
    if (this.localNotifyTimer) clearTimeout(this.localNotifyTimer);
    this.localNotifyTimer = setTimeout(() => {
      this.localNotifyTimer = null;
      this.scanLocalNotifications();
    }, this.localNotifyDebounceMs);
    this.localNotifyTimer.unref?.();
  }

  private scanLocalNotifications(): void {
    try {
      const files = fs.readdirSync(this.localNotifyDir);
      for (const file of files) {
        if (this.seenLocalNotifyFiles.has(file)) continue;
        if (!file.endsWith('.json')) {
          this.seenLocalNotifyFiles.add(file);
          continue;
        }
        if (this.handleLocalNotificationFile(path.join(this.localNotifyDir, file))) {
          this.seenLocalNotifyFiles.add(file);
        }
      }
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to scan local event notifications:', err);
    }
  }

  private handleLocalNotificationFile(filePath: string): boolean {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const note = JSON.parse(raw) as { eventId?: unknown; groupId?: unknown };
      const eventId = typeof note.eventId === 'string' ? note.eventId : '';
      const groupId = Number(note.groupId);
      if (!eventId || !Number.isInteger(groupId) || groupId <= 0) return true;
      if (!this.subscribedGroups.has(groupId) || !this.localGroupIds.has(groupId)) return true;
      if (this.observedDbEventIds.has(eventId)) return true;
      const event = this.db.getEvent(eventId);
      if (!event || event.groupId !== groupId) return false;
      this.observedDbEventIds.add(event.eventId);
      this.emit('event', { event });
      return true;
    } catch {
      return false;
    }
  }

  private writeLocalEventNotification(event: ReticulumChatEvent): void {
    try {
      fs.mkdirSync(this.localNotifyDir, { recursive: true });
      const fileName = `${event.groupId}-${event.timestamp}-${nodeCrypto.randomBytes(6).toString('hex')}.json`;
      const filePath = path.join(this.localNotifyDir, fileName);
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          eventId: event.eventId,
          groupId: event.groupId,
          timestamp: event.timestamp,
        }),
        'utf8'
      );
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to write local event notification:', err);
    }
  }

  private cleanupOldLocalNotifications(): void {
    try {
      const cutoff = this.now() - 10 * 60 * 1000;
      for (const file of fs.readdirSync(this.localNotifyDir)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.localNotifyDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) fs.rmSync(filePath, { force: true });
      }
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to clean local event notifications:', err);
    }
  }

  private buildEventHintWire(event: ReticulumChatEvent): ReticulumChatWire {
    return {
      t: 'RCHAT',
      k: 'event_hint',
      g: event.groupId,
      h: eventHintToWire(buildReticulumChatEventHint(event)),
    };
  }

  private buildSyncReqWire(groupId: number): ReticulumChatWire {
    const history = this.db.getRecentEvents(groupId, 1);
    if (history.length === 0) {
      return {
        t: 'RCHAT',
        k: 'sync_req',
        g: groupId,
        mode: 'latest',
        limit: RETICULUM_CHAT_DEFAULT_SYNC_WINDOW,
      };
    }
    const latest = history[history.length - 1];
    return {
      t: 'RCHAT',
      k: 'sync_req',
      g: groupId,
      mode: 'after',
      ts: Math.max(0, latest.timestamp - RETICULUM_CHAT_SYNC_OVERLAP_MS),
      limit: RETICULUM_CHAT_DEFAULT_SYNC_WINDOW,
    };
  }

  private getEventsForSyncRequest(
    groupId: number,
    wire: Record<string, unknown>,
    limit: number
  ): ReticulumChatEvent[] {
    const mode = typeof wire.mode === 'string' ? wire.mode : '';
    if (mode === 'latest') {
      return this.db.getRecentEvents(groupId, limit);
    }
    if (mode === 'after') {
      const afterEventId = typeof wire.id === 'string' && wire.id ? wire.id : undefined;
      return this.db.getEventsAfter(groupId, this.normalizeTimestamp(wire.ts), limit, afterEventId);
    }
    if (mode === 'before') {
      const beforeEventId = typeof wire.id === 'string' && wire.id ? wire.id : undefined;
      return this.db.getEventsBefore(
        groupId,
        this.normalizeTimestamp(wire.ts, this.now()),
        limit,
        beforeEventId
      );
    }

    const seqs =
      typeof wire.seqs === 'object' && wire.seqs
        ? (wire.seqs as Record<string, number>)
        : {};
    if (Object.keys(seqs).length > 0) {
      return this.db.getMissingEvents(groupId, seqs, limit);
    }
    return this.db.getRecentEvents(groupId, limit);
  }

  private normalizeSyncLimit(value: unknown): number {
    const limit = Number(value);
    if (!Number.isFinite(limit)) return RETICULUM_CHAT_DEFAULT_SYNC_WINDOW;
    return Math.max(1, Math.min(RETICULUM_CHAT_SYNC_LIMIT, Math.floor(limit)));
  }

  private normalizeTimestamp(value: unknown, fallback = 0): number {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp < 0) return fallback;
    return timestamp;
  }

  private async sendSyncHintsToPeer(
    peerHash: string,
    groupId: number,
    events: ReticulumChatEvent[],
    pageSize = RETICULUM_CHAT_DEFAULT_SYNC_WINDOW,
    mode?: string
  ): Promise<void> {
    const normalizedPageSize = Math.max(1, pageSize);
    const wantsOlderContinuation = mode === 'latest' || mode === 'before';
    const hasMore = events.length > normalizedPageSize;
    const visibleEvents = wantsOlderContinuation && hasMore
      ? events.slice(events.length - normalizedPageSize)
      : events.slice(0, normalizedPageSize);
    const continuation = wantsOlderContinuation
      ? visibleEvents[0]
      : visibleEvents[visibleEvents.length - 1];
    const hints = visibleEvents.map((event) => eventHintToWire(buildReticulumChatEventHint(event)));
    const continuationHint = wantsOlderContinuation ? hints[0] : hints[hints.length - 1];
    let batch: ReticulumChatEventHintWire[] = [];
    let sentContinuation = false;
    for (const hint of hints) {
      const next = [...batch, hint];
      const nextHasContinuation = hasMore && next.includes(continuationHint);
      const wire: ReticulumChatWire = this.buildSyncHintsWire(
        groupId,
        next,
        nextHasContinuation ? continuation : undefined,
        wantsOlderContinuation ? 'before' : 'after'
      );
      if (wireFitsReticulum(wire)) {
        batch = next;
        continue;
      }
      if (batch.length > 0) {
        const batchHasContinuation = hasMore && batch.includes(continuationHint);
        await this.sendToPeer(
          peerHash,
          this.buildSyncHintsWire(
            groupId,
            batch,
            batchHasContinuation ? continuation : undefined,
            wantsOlderContinuation ? 'before' : 'after'
          )
        );
        if (batchHasContinuation) sentContinuation = true;
      }
      batch = [hint];
      const single = this.buildSyncHintsWire(
        groupId,
        batch,
        hasMore && batch.includes(continuationHint) ? continuation : undefined,
        wantsOlderContinuation ? 'before' : 'after'
      );
      if (!wireFitsReticulum(single)) {
        await this.sendToPeer(peerHash, { t: 'RCHAT', k: 'event_hint', g: groupId, h: hint });
        if (hasMore && hint === continuationHint && continuation) {
          await this.sendToPeer(peerHash, {
            t: 'RCHAT',
            k: 'sync_hints',
            g: groupId,
            hints: [],
            ...(wantsOlderContinuation
              ? {
                  moreBefore: true,
                  prevTs: continuation.timestamp,
                  prevId: continuation.eventId,
                }
              : {
                  more: true,
                  nextTs: continuation.timestamp,
                  nextId: continuation.eventId,
                }),
          });
          sentContinuation = true;
        }
        batch = [];
      }
    }
    if (batch.length > 0) {
      const finalHasContinuation = hasMore && !sentContinuation && batch.includes(continuationHint);
      await this.sendToPeer(
        peerHash,
        this.buildSyncHintsWire(
          groupId,
          batch,
          finalHasContinuation ? continuation : undefined,
          wantsOlderContinuation ? 'before' : 'after'
        )
      );
    }
  }

  private buildSyncHintsWire(
    groupId: number,
    hints: ReticulumChatEventHintWire[],
    continuation?: ReticulumChatEvent,
    direction: 'after' | 'before' = 'after'
  ): ReticulumChatWire {
    if (!continuation) return { t: 'RCHAT', k: 'sync_hints', g: groupId, hints };
    if (direction === 'before') {
      return {
        t: 'RCHAT',
        k: 'sync_hints',
        g: groupId,
        hints,
        moreBefore: true,
        prevTs: continuation.timestamp,
        prevId: continuation.eventId,
      };
    }
    return {
      t: 'RCHAT',
      k: 'sync_hints',
      g: groupId,
      hints,
      more: true,
      nextTs: continuation.timestamp,
      nextId: continuation.eventId,
    };
  }

  private handleEventHint(candidate: unknown, peerHash: string): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const hint = candidate as Partial<ReticulumChatEventHint>;
    if (!this.isValidEventHint(hint)) return;
    if (!this.subscribedGroups.has(hint.groupId) || !this.localGroupIds.has(hint.groupId)) return;
    if (this.db.hasEvent(hint.eventId)) return;
    void this.requestEventPull(peerHash, hint);
  }

  private isValidEventHint(hint: Partial<ReticulumChatEventHint>): hint is ReticulumChatEventHint {
    if (typeof hint.eventId !== 'string' || hint.eventId.length < 8) return false;
    if (!Number.isInteger(hint.groupId) || hint.groupId <= 0) return false;
    if (typeof hint.authorAddress !== 'string' || !hint.authorAddress) return false;
    if (!Number.isInteger(hint.authorSeq) || hint.authorSeq <= 0) return false;
    if (!Number.isFinite(hint.timestamp)) return false;
    if (typeof hint.eventType !== 'string' || !VALID_EVENT_TYPES.has(hint.eventType as ReticulumChatEventType)) return false;
    if (typeof hint.payloadHash !== 'string' || !/^[0-9a-f]{64}$/i.test(hint.payloadHash)) return false;
    return true;
  }

  private async requestEventPull(peerHash: string, hint: ReticulumChatEventHint): Promise<void> {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return;
    const requestKey = `${hint.groupId}:${peerKey}:${hint.eventId}`;
    const now = this.now();
    if (now - (this.requestedEventPulls.get(requestKey) ?? 0) < RETICULUM_CHAT_PULL_THROTTLE_MS) {
      return;
    }
    this.requestedEventPulls.set(requestKey, now);
    await this.sendToPeer(peerKey, { t: 'RCHAT', k: 'event_req', g: hint.groupId, id: hint.eventId });
  }

  private async offerEventResource(peerHash: string, groupId: number, eventId: string): Promise<void> {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey || !this.bridge) return;
    const event = this.db.getEvent(eventId);
    if (!event || event.groupId !== groupId) return;
    if (typeof this.bridge.sendReticulumChatResourceDetailed !== 'function') return;
    const blob = serializeReticulumChatEvent(event);
    const wireHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
    const transferId = nodeCrypto.randomBytes(8).toString('hex');
    const filePath = this.writeTempEventBlob(transferId, blob);
    const offer: ReticulumChatEventOffer = {
      transferId,
      eventId: event.eventId,
      groupId,
      payloadHash: event.payloadHash,
      wireHash,
      sizeBytes: Buffer.byteLength(blob, 'utf8'),
    };
    const registered = await this.bridge.sendReticulumChatResourceDetailed({
      allowedRecipientAddress: peerKey,
      transferId,
      filePath,
      fileName: `${event.eventId}.json`,
      size: offer.sizeBytes,
      sha256: wireHash,
      metadata: {
        resourceType: 'reticulum_chat_event',
        eventId: event.eventId,
        groupId,
        payloadHash: event.payloadHash,
        wireHash,
        sizeBytes: offer.sizeBytes,
      },
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    if (!registered.ok) return;
    await this.sendToPeer(peerKey, { t: 'RCHAT', k: 'event_offer', g: groupId, o: eventOfferToWire(offer) });
  }

  private handleEventOffer(candidate: unknown, peerHash: string): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const offer = candidate as Partial<ReticulumChatEventOffer>;
    if (!this.isValidEventOffer(offer)) return;
    if (!this.subscribedGroups.has(offer.groupId) || !this.localGroupIds.has(offer.groupId)) return;
    if (this.db.hasEvent(offer.eventId)) return;
    this.resourceOffers.set(offer.transferId, offer);
    void this.acceptEventResource(peerHash, offer);
  }

  private isValidEventOffer(offer: Partial<ReticulumChatEventOffer>): offer is ReticulumChatEventOffer {
    if (typeof offer.transferId !== 'string' || !offer.transferId) return false;
    if (typeof offer.eventId !== 'string' || offer.eventId.length < 8) return false;
    if (!Number.isInteger(offer.groupId) || offer.groupId <= 0) return false;
    if (typeof offer.payloadHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.payloadHash)) return false;
    if (typeof offer.wireHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.wireHash)) return false;
    if (!Number.isInteger(offer.sizeBytes) || offer.sizeBytes <= 0) return false;
    return true;
  }

  private async acceptEventResource(peerHash: string, offer: ReticulumChatEventOffer): Promise<void> {
    if (!this.bridge || typeof this.bridge.acceptReticulumChatResourceDetailed !== 'function') return;
    const senderHash = (offer.senderReticulumDestinationHash || peerHash).trim().toLowerCase();
    if (!senderHash) {
      loggerWarn(`[ReticulumChat] Cannot accept event resource ${offer.eventId}: missing sender Reticulum identity`);
      return;
    }
    await this.bridge.acceptReticulumChatResourceDetailed({
      peerPresenceHash: senderHash,
      reticulumIdentityPublicKeyBase64: offer.senderReticulumIdentityPublicKeyBase64?.trim() ?? '',
      transferId: offer.transferId,
      savePath: this.tempEventBlobPath(`${offer.transferId}.recv`),
      fileName: `${offer.eventId}.json`,
      size: offer.sizeBytes,
      sha256: offer.wireHash,
      authMessage: {
        type: 'RETICULUM_CHAT_RESOURCE_AUTH',
        transferId: offer.transferId,
        eventId: offer.eventId,
        groupId: offer.groupId,
      },
    });
  }

  handleResourceEvent(payload: ReticulumChatResourcePayload): void {
    if (payload?.status === 'auth' && payload.linkId && payload.transferId) {
      void this.authorizeResource(payload);
      return;
    }
    if (payload?.status !== 'received' || !payload.path || !payload.transferId) return;
    const offer = this.resourceOffers.get(payload.transferId);
    if (!offer) return;
    try {
      const blob = fs.readFileSync(payload.path, 'utf8');
      const wireHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
      if (wireHash !== offer.wireHash.toLowerCase()) return;
      const parsed = JSON.parse(blob) as unknown;
      if (this.acceptEvent(parsed, false)) {
        const event = parsed as ReticulumChatEvent;
        this.emit('event', { event });
        void this.fanout(this.buildEventHintWire(event), payload.peerPresenceHash ? [payload.peerPresenceHash] : []);
      }
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to import event resource:', err);
    } finally {
      this.resourceOffers.delete(payload.transferId);
    }
  }

  private async authorizeResource(payload: ReticulumChatResourcePayload): Promise<void> {
    if (!this.bridge || !payload.linkId || !payload.transferId) return;
    const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
    const eventId = String(auth.eventId || payload.eventId || '');
    const groupId = Number(auth.groupId || payload.groupId || 0);
    if (!eventId || !Number.isInteger(groupId) || groupId <= 0) {
      await this.bridge.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
        reason: 'bad_resource_auth',
      });
      return;
    }
    const event = this.db.getEvent(eventId);
    if (!event || event.groupId !== groupId) {
      await this.bridge.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
        reason: 'unknown_event',
      });
      return;
    }
    await this.bridge.authorizeReticulumChatResourceDetailed?.({
      linkId: payload.linkId,
      transferId: payload.transferId,
    });
  }

  private tempEventBlobPath(name: string): string {
    const dir = path.join(app.getPath('temp'), 'qortal-reticulum-chat-events');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, path.basename(name));
  }

  private writeTempEventBlob(transferId: string, contents: string): string {
    const filePath = this.tempEventBlobPath(`${transferId}.json`);
    fs.writeFileSync(filePath, contents, 'utf8');
    return filePath;
  }

  private applyTyping(groupId: number, authorAddress: string, active: boolean): void {
    const key = `${groupId}:${authorAddress}`;
    const existing = this.typingTimers.get(key);
    if (existing) clearTimeout(existing);
    if (!active) {
      this.typingTimers.delete(key);
      this.emit('typing', { groupId, authorAddress, active: false });
      return;
    }
    this.emit('typing', { groupId, authorAddress, active: true });
    const timer = setTimeout(() => {
      this.typingTimers.delete(key);
      this.emit('typing', { groupId, authorAddress, active: false });
    }, RETICULUM_CHAT_TYPING_TTL_MS);
    timer.unref?.();
    this.typingTimers.set(key, timer);
  }

  private notePeerSubscription(peerHash: string, groupId: number, active: boolean): void {
    const key = peerHash.trim().toLowerCase();
    if (!key) return;
    const set = this.peerSubscriptions.get(key) ?? new Set<number>();
    if (active) set.add(groupId);
    else set.delete(groupId);
    if (set.size) this.peerSubscriptions.set(key, set);
    else this.peerSubscriptions.delete(key);
  }

  private async fanout(
    wire: ReticulumChatWire,
    excludePeerPresenceHashes: string[] = []
  ): Promise<ReticulumSendResult> {
    if (!this.bridge) return { ok: false, reason: 'bridge-unavailable' };
    if (!wireFitsReticulum(wire)) {
      return {
        ok: false,
        reason: 'wire-too-large',
        error: `Reticulum chat wire ${byteLengthUtf8JsonWithBridgeSender(wire)} bytes exceeds ${RT_RETICULUM_MAX_WIRE_JSON_BYTES}`,
      };
    }
    if (typeof this.bridge.fanoutReticulumChatDetailed !== 'function') {
      return { ok: false, reason: 'send-command-failed', error: 'Bridge chat fanout unavailable' };
    }
    return this.bridge.fanoutReticulumChatDetailed([wire], excludePeerPresenceHashes);
  }

  private async sendToPeer(peerHash: string, wire: ReticulumChatWire): Promise<ReticulumSendResult> {
    const key = peerHash.trim().toLowerCase();
    if (!key || !this.bridge) return { ok: false, reason: 'unknown-peer-presence-hash' };
    if (!wireFitsReticulum(wire)) {
      return {
        ok: false,
        reason: 'wire-too-large',
        error: `Reticulum chat wire ${byteLengthUtf8JsonWithBridgeSender(wire)} bytes exceeds ${RT_RETICULUM_MAX_WIRE_JSON_BYTES}`,
      };
    }
    if (typeof this.bridge.sendReticulumChatDetailed !== 'function') {
      return { ok: false, reason: 'send-command-failed', error: 'Bridge chat send unavailable' };
    }
    return this.bridge.sendReticulumChatDetailed(key, wire);
  }

  private attachBridge(bridge: ReticulumBridge | null): void {
    if (!bridge) return;
    bridge.on('reticulum-chat-message', this.onBridgeChatMessage);
    bridge.on('reticulum-chat-resource', this.onBridgeChatResource);
  }

  private detachBridge(): void {
    if (!this.bridge) return;
    this.bridge.off('reticulum-chat-message', this.onBridgeChatMessage);
    this.bridge.off('reticulum-chat-resource', this.onBridgeChatResource);
  }

  private onBridgeChatMessage = (
    wire: Record<string, unknown>,
    senderDestinationHash: string,
    peerPresenceHash: string
  ): void => {
    try {
      this.handleWire(wire, peerPresenceHash, senderDestinationHash);
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to handle inbound wire:', err);
    }
  };

  private onBridgeChatResource = (payload: ReticulumChatResourcePayload): void => {
    try {
      this.handleResourceEvent(payload);
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to handle resource event:', err);
    }
  };

  private assertGroupId(groupId: number): void {
    if (!Number.isInteger(groupId) || groupId <= 0) {
      throw new Error('Invalid groupId');
    }
  }
}

let singleton: ReticulumChatManager | null = null;

export function startReticulumChatManager(
  bridge?: ReticulumBridge | null,
  dbPath?: string
): ReticulumChatManager {
  if (singleton) {
    singleton.setBridge(bridge ?? null);
    return singleton;
  }
  singleton = new ReticulumChatManager({ bridge: bridge ?? null, dbPath });
  loggerLog('[ReticulumChat] Manager started');
  return singleton;
}

export function getReticulumChatManager(): ReticulumChatManager | null {
  return singleton;
}

export function stopReticulumChatManager(): void {
  singleton?.close();
  singleton = null;
}
