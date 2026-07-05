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
import {
  ReticulumChatDatabase,
  type ReticulumChatChannelDigest,
  type ReticulumChatFeedCursor,
  type ReticulumChatGroupKey,
  type ReticulumChatGroupKeyDigest,
  type ReticulumChatGroupKeyRequest,
  type ReticulumChatRelayCacheEntry,
  type ReticulumChatRelayDigestEntry,
  RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS,
  RETICULUM_CHAT_CHANNEL_READ_MODE_MEMBERS,
  RETICULUM_CHAT_CHANNEL_WRITE_MODE_ADMINS,
  RETICULUM_CHAT_CHANNEL_WRITE_MODE_MEMBERS,
  RETICULUM_CHAT_RELAY_EVENT_MAX_BYTES,
  RETICULUM_CHAT_DEFAULT_CHANNEL_ID,
  normalizeReticulumChatChannelId,
  normalizeReticulumChatCategoryId,
  normalizeReticulumDmConversationId,
  reticulumChatRelayBlobId,
  reticulumDmConversationId,
  type ReticulumGroupChannel,
  type ReticulumGroupChannelReadMode,
  type ReticulumGroupChannelWriteMode,
  type ReticulumGroupCategory,
  type ReticulumGroupChatSummary,
  type ReticulumChatSearchResult,
} from './reticulum-chat-db';
import type {
  ReticulumBridge,
  ReticulumSendFailureReason,
  ReticulumSendResult,
} from './reticulum-bridge';
import { log as loggerLog, warn as loggerWarn } from './logger';
import {
  byteLengthUtf8JsonWithBridgeSender,
  RT_RETICULUM_MAX_WIRE_JSON_BYTES,
  wireFitsReticulum,
} from './reticulum-wire-size';
import {
  ReticulumResourceStore,
  type ReticulumResourceManifest,
} from './reticulum-resource-store';
import {
  ReticulumResourceTransferManager,
  type ReticulumResourceByteRange,
  type ReticulumResourceTransferProgress,
  type ReticulumResourceTransferRequest,
} from './reticulum-resource-transfer';

export type ReticulumChatEventType =
  | 'message'
  | 'edit'
  | 'delete'
  | 'reaction_add'
  | 'reaction_remove'
  | 'attachment_manifest'
  | 'channel_create'
  | 'channel_update'
  | 'channel_archive'
  | 'channel_restore'
  | 'channel_reorder'
  | 'category_create'
  | 'category_update'
  | 'category_delete';

export type ReticulumChatMentionTarget =
  | { type: 'here'; groupId: number; channelId: string; createdAt: number }
  | { type: 'everyone'; groupId: number }
  | { type: 'group'; groupId: number; groupName?: string }
  | { type: 'channel'; groupId: number; channelId: string; channelName?: string }
  | { type: 'user'; addressHash: string };

export interface ReticulumChatEvent {
  eventId: string;
  groupId: number;
  channelId: string;
  authorAddress: string;
  authorPublicKey: string;
  authorSeq: number;
  timestamp: number;
  eventType: ReticulumChatEventType;
  targetEventId?: string;
  replyToEventId?: string;
  encryptedPayload: string;
  payloadHash: string;
  mentionAddressHashes: string[];
  mentionTargets?: ReticulumChatMentionTarget[];
  signature: string;
}

export type ReticulumDmEventType =
  | 'message'
  | 'edit'
  | 'delete'
  | 'reaction_add'
  | 'reaction_remove';

export type ReticulumDmDeliveryStatus = 'pending' | 'sent' | 'received';

export interface ReticulumDmEvent {
  eventId: string;
  conversationId: string;
  senderAddress: string;
  recipientAddress: string;
  senderPublicKey: string;
  senderSeq: number;
  timestamp: number;
  eventType: ReticulumDmEventType;
  targetEventId?: string;
  replyToEventId?: string;
  payload: string;
  payloadHash: string;
  signature: string;
  localDeliveryStatus?: ReticulumDmDeliveryStatus;
  localDeliveryUpdatedAt?: number;
}

export type ReticulumDmSummary = {
  peerAddress: string;
  conversationId: string;
  lastEvent: ReticulumDmEvent | null;
  unreadCount: number;
  updatedAt: number;
};

type ReticulumChatFeedPriority = 'metadata';

export interface ReticulumChatEventHint {
  eventId: string;
  groupId: number;
  channelId: string;
  authorAddress: string;
  authorSeq: number;
  timestamp: number;
  eventType: ReticulumChatEventType;
  payloadHash: string;
  mentionAddressHashes: string[];
}

export interface ReticulumChatEventOffer {
  transferId: string;
  eventId: string;
  groupId: number;
  payloadHash: string;
  wireHash: string;
  sizeBytes: number;
  continuation?: {
    channelId: string;
    direction: 'after' | 'before';
    cursor: ReticulumChatFeedCursor;
  };
  sourcePeerHash?: string;
  senderReticulumDestinationHash?: string;
  senderReticulumIdentityPublicKeyBase64?: string;
  relayRequestId?: string;
  relayStore?: boolean;
  relayCached?: boolean;
  relayBlobId?: string;
}

export interface ReticulumChatEventPageOffer {
  transferId: string;
  groupId: number;
  channelId: string;
  direction: 'after' | 'before' | 'range';
  priority?: ReticulumChatFeedPriority;
  includeCursor?: boolean;
  pageHash: string;
  sizeBytes: number;
  eventCount: number;
  start?: ReticulumChatFeedCursor;
  end?: ReticulumChatFeedCursor;
  hasMore?: boolean;
  sourcePeerHash?: string;
  senderReticulumDestinationHash?: string;
  senderReticulumIdentityPublicKeyBase64?: string;
  relayRequestId?: string;
  requestedAt?: number;
  requesterAddress?: string;
  repairRange?: ReticulumChatAuthorRange;
}

export interface ReticulumDmPageOffer {
  transferId: string;
  conversationId: string;
  pageHash: string;
  sizeBytes: number;
  eventCount: number;
  hasMore?: boolean;
  sourcePeerHash?: string;
  senderReticulumDestinationHash?: string;
  senderReticulumIdentityPublicKeyBase64?: string;
  requestedAt?: number;
  requesterAddress?: string;
  requesterPeerHash?: string;
  peerAddress?: string;
  after?: number;
  limit?: number;
  requestId?: string;
  requesterPublicKey?: string;
  timestamp?: number;
  signature?: string;
}

type ReticulumChatEventOfferOptions = {
  continuation?: ReticulumChatEventOffer['continuation'];
  recipientPeerHash?: string;
  relayRequestId?: string;
  sourcePeerHash?: string;
  relayStore?: boolean;
  relayCached?: boolean;
  relayBlobId?: string;
  allowCachedServe?: boolean;
  repairRange?: ReticulumChatAuthorRange;
};

type ReticulumChatAuthorRange = {
  a: string;
  from: number;
  to: number;
};

type ReticulumChatResourceServeCheck =
  | { ok: true }
  | { ok: false; reason: string };

export interface ReticulumChatEventOfferWire {
  x: string;
  id: string;
  ph?: string;
  wh: string;
  s: number;
  fc?: string;
  fd?: 'a' | 'b';
  fid?: string;
  fts?: number;
  rr?: string;
  sp?: string;
  sd?: string;
  rk?: string;
  rs?: 1;
  rc?: 1;
  bid?: string;
}

export interface ReticulumChatEventPageOfferWire {
  x: string;
  c: string;
  d: 'a' | 'b' | 'r';
  p?: 'm';
  ph: string;
  s: number;
  n: number;
  sid?: string;
  sts?: number;
  eid?: string;
  ets?: number;
  more?: 1;
  rr?: string;
  sp?: string;
  sd?: string;
  rk?: string;
  r?: [string, number, number];
}

export interface ReticulumChatEventRequestWire {
  id: string;
  a: string;
  pk: string;
  ts: number;
  sig: string;
}

export interface ReticulumChatHistoryPageRequestWire {
  c: string;
  d: 'after' | 'before';
  p?: 'm';
  after?: ReticulumChatFeedCursorWire;
  before?: ReticulumChatFeedCursorWire;
  inc?: 1;
  limit?: number;
  a: string;
  pk: string;
  ts: number;
  sig: string;
}

type ReticulumChatResourceAuthWire = {
  t: 'RCR';
  x: string;
  g: number;
  a: string;
  p: string;
  ts: number;
  z: string;
};

type ReticulumChatEventPageResourceAuthWire = {
  t: 'RCP';
  x: string;
  g: number;
  a: string;
  p: string;
  ts: number;
  z: string;
};

export interface ReticulumChatResourceRequestWire {
  eid?: string;
  fh: string;
  b: Array<[number, number]>;
  pk: string;
  ts: number;
  sig: string;
}

export type ReticulumChatRelayQueryWire = {
  ids: string[];
  o?: string;
  rid?: string;
  h?: number;
};

export type ReticulumChatRelayAckWire = {
  id: string;
  ok: boolean;
  reason?: string;
  bid?: string;
};

export type ReticulumChatRelayDigestEntryWire = {
  id: string;
  ts: number;
  c: string;
  a?: string;
  seq?: number;
  ph?: string;
  bid?: string;
};

export type ReticulumChatGroupKeyDigestWire = {
  e: number;
  id: string;
  p: string;
  ts: number;
  s: string;
};

export type ReticulumChatGroupKeyRequestWire = {
  e: number;
  id: string;
  r: string;
  p: string;
  ts: number;
  s: string;
};

export type ReticulumChatGroupKeyResponseWire = {
  e: number;
  id: string;
  r: string;
  kb: string;
  p: string;
  ts: number;
  s: string;
};

export type ReticulumChatLocalGroupMembership =
  | number
  | {
      groupId?: unknown;
      groupid?: unknown;
      group_id?: unknown;
      id?: unknown;
      isPrivate?: unknown;
      isOpen?: unknown;
      localAddress?: unknown;
      address?: unknown;
      isAdmin?: unknown;
    };

type ReticulumChatVerifiedReticulumPeer = {
  destinationHash: string;
  address: string;
  lastSeen?: number;
};

type ReticulumChatResourceFindRoute = {
  reversePeerHash: string;
  groupId: number;
  fileHash: string;
  sizeBytes: number;
  expiresAt: number;
};

type ReticulumDmResourceFindRoute = {
  reversePeerHash: string;
  conversationId: string;
  fileHash: string;
  sizeBytes: number;
  expiresAt: number;
};

type ReticulumChatPullQueueItem = {
  hint: ReticulumChatEventHint;
  peerHashes: Set<string>;
  attempts: number;
  nextAttemptAt: number;
  inFlight: boolean;
};

type ReticulumChatLocalSignature = {
  authorAddress: string;
  authorPublicKey: string;
  signature: string;
};

type ReticulumChatControlRetryItem = {
  key: string;
  wire: ReticulumChatWire;
  peerHash?: string;
  excludePeerPresenceHashes?: string[];
  attempts: number;
  nextAttemptAt: number;
};

export type ReticulumChatProtocolFeature =
  | 'digest'
  | 'digest_req'
  | 'feed_req'
  | 'range_req'
  | 'resource_v2'
  | 'relay_cache'
  | 'group_keys'
  | 'dm';

export type ReticulumChatDigestWire = {
  c: string;
  latest?: ReticulumChatFeedCursorWire;
  oldest?: ReticulumChatFeedCursorWire;
  wh?: string;
};

export type ReticulumChatFeedCursorWire = {
  id: string;
  ts: number;
};

export type ReticulumChatEventBatchWire = {
  start?: ReticulumChatFeedCursorWire;
  end?: ReticulumChatFeedCursorWire;
  dir: 'after' | 'before' | 'range';
  p?: 'm';
  more?: boolean;
  wh: string;
  events: ReticulumChatEvent[];
};

export type ReticulumDmEventObjectWire = {
  id: string;
  c?: string;
  s: string;
  r: string;
  p: string;
  q: number;
  n: number;
  k: ReticulumDmEventType;
  x?: string;
  y?: string;
  l: string;
  h?: string;
  z: string;
};

export type ReticulumDmEventTypeWire = ReticulumDmEventType | 'm' | 'e' | 'd' | 'ra' | 'rr';

export type ReticulumDmEventTupleWire = [
  id: string,
  senderAddress: string,
  recipientAddress: string,
  senderPublicKey: string,
  senderSeq: number,
  timestamp: number,
  eventType: ReticulumDmEventTypeWire,
  payload: string,
  signature: string,
  targetEventId?: string,
  replyToEventId?: string,
];

export type ReticulumDmEventCompactTupleWire = [
  version: 'v2',
  id: string,
  recipientAddress: string,
  senderPublicKey: string,
  senderSeq: number,
  timestamp: number,
  eventType: ReticulumDmEventTypeWire,
  payload: string,
  signature: string,
  targetEventId?: string,
  replyToEventId?: string,
];

export type ReticulumDmEventWire =
  | ReticulumDmEventTupleWire
  | ReticulumDmEventCompactTupleWire
  | ReticulumDmEventObjectWire;

export type ReticulumDmRequestWire = {
  b: string;
  a?: number;
  after?: number;
  l?: number;
  limit?: number;
  q?: string;
  rp?: string;
  p?: string;
  n?: number;
  z?: string;
};

export type ReticulumDmResourceRequestWire = {
  c: string;
  b: string;
  fh: string;
  r: Array<[number, number]>;
  q?: string;
  rp?: string;
  p?: string;
  n?: number;
  z?: string;
};

export type ReticulumDmResourceFindWire = {
  c?: string;
  a?: string;
  b: string;
  q: string;
  f: string;
  s?: number;
  h?: number;
  m?: number;
  x: number;
  p?: string;
  n?: number;
  z?: string;
};

export type ReticulumDmPageOfferWire = {
  x: string;
  c: string;
  ph: string;
  s: number;
  n: number;
  more?: 1;
  sd?: string;
};

export type ReticulumDmNotifyWire = {
  b: string;
  sp: string;
  q: string;
  r?: string;
  h?: number;
  m?: number;
  p: string;
  n: number;
  z: string;
};

export type ReticulumDmProbeWire = {
  q: string;
  h?: number;
  m?: number;
  p: string;
  n: number;
  z: string;
};

type ReticulumDmPageResource = {
  v: 1;
  c: string;
  after: number;
  more?: boolean;
  events: ReticulumDmEventWire[];
};

export type ReticulumChatWire =
  | { t: 'RCHAT'; k: 'hello'; v: 1; f: ReticulumChatProtocolFeature[] }
  | { t: 'RCHAT'; k: 'group_sub'; groups: number[]; mode: 'summary' | 'active'; o?: string; h?: number }
  | { t: 'RCHAT'; k: 'unsub'; g: number }
  | { t: 'RCHAT'; k: 'event_req'; g: number; q: ReticulumChatEventRequestWire; o?: string; rid?: string; h?: number }
  | { t: 'RCHAT'; k: 'event_offer'; g: number; o: ReticulumChatEventOfferWire }
  | { t: 'RCHAT'; k: 'event_page_offer'; g: number; p: ReticulumChatEventPageOfferWire }
  | { t: 'RCHAT'; k: 'identity_req'; d: string; rid: string; h: number; m: number; x: number }
  | { t: 'RCHAT'; k: 'identity_offer'; d: string; rk: string; rid: string }
  | {
      t: 'RCHAT';
      k: 'rf';
      g: number;
      q: string;
      f: string;
      s: number;
      h?: number;
      m?: number;
      x: number;
      p: string;
      n: number;
      z: string;
    }
  | { t: 'RCHAT'; k: 'resource_have'; g: number; fh: string; s: number; rid?: string; sp?: string; rk?: string }
  | {
      t: 'RCHAT';
      k: 'group_digest';
      g: number;
      latest?: ReticulumChatFeedCursorWire;
      channels?: ReticulumChatDigestWire[];
      more?: boolean;
      nextOffset?: number;
      digestHash?: string;
      sd?: string;
    }
  | {
      t: 'RCHAT';
      k: 'digest_req';
      g: number;
      offset?: number;
      limit?: number;
      o?: string;
      rid?: string;
      h?: number;
    }
  | {
      t: 'RCHAT';
      k: 'feed_req';
      g: number;
      c: string;
      after?: ReticulumChatFeedCursorWire;
      before?: ReticulumChatFeedCursorWire;
      inc?: 1;
      p?: 'm';
      limit?: number;
      o?: string;
      rid?: string;
      h?: number;
    }
  | {
      t: 'RCHAT';
      k: 'range_req';
      g: number;
      ranges: Array<{ a: string; from: number; to: number }>;
      limit?: number;
      o?: string;
      rid?: string;
      h?: number;
    }
  | { t: 'RCHAT'; k: 'relay_query'; g: number; q: ReticulumChatRelayQueryWire }
  | { t: 'RCHAT'; k: 'relay_ack'; g: number; a: ReticulumChatRelayAckWire }
  | {
      t: 'RCHAT';
      k: 'relay_digest';
      g: number;
      events: ReticulumChatRelayDigestEntryWire[];
      more?: boolean;
      nextOffset?: number;
    }
  | { t: 'RCHAT'; k: 'gkd'; g: number; d: ReticulumChatGroupKeyDigestWire }
  | { t: 'RCHAT'; k: 'gkq'; g: number; q: ReticulumChatGroupKeyRequestWire }
  | { t: 'RCHAT'; k: 'gks'; g: number; r: ReticulumChatGroupKeyResponseWire }
  | {
      t: 'RCHAT';
      k: 'event_batch';
      g: number;
      c: string;
      batch: ReticulumChatEventBatchWire;
    }
  | { t: 'RCHAT'; k: 'dm_event'; e: ReticulumDmEventWire | ReticulumDmEvent }
  | { t: 'RCHAT'; k: 'dm_notify'; d: ReticulumDmNotifyWire }
  | { t: 'RCHAT'; k: 'dm_probe'; q: ReticulumDmProbeWire }
  | { t: 'RCHAT'; k: 'dm_req'; q: ReticulumDmRequestWire }
  | { t: 'RCHAT'; k: 'dm_resource_find'; q: ReticulumDmResourceFindWire }
  | { t: 'RCHAT'; k: 'dm_resource_have'; c: string; fh: string; s: number; rid?: string; sp?: string; rk?: string }
  | { t: 'RCHAT'; k: 'dm_page_offer'; p: ReticulumDmPageOfferWire }
  | {
      t: 'RCHAT';
      k: 'dm_page';
      c?: string;
      e?: Array<ReticulumDmEventWire | ReticulumDmEvent>;
      events?: Array<ReticulumDmEventWire | ReticulumDmEvent>;
      m?: 1;
      more?: boolean;
    }
  | { t: 'RCHAT'; k: 'typing'; g: number; c: string; a: string; ts: number; active: boolean; o?: string; h?: number };

export interface ReticulumChatManagerOptions {
  dbPath?: string;
  bridge?: ReticulumBridge | null;
  now?: () => number;
  localNotifyDebounceMs?: number;
  signLocalFields?: (
    fields: Record<string, unknown>
  ) => Promise<ReticulumChatLocalSignature | null>;
  validateGroupMember?: (groupId: number, address: string) => Promise<boolean | null>;
  validateGroupAdmin?: (groupId: number, address: string) => Promise<boolean>;
  getVerifiedReticulumPeers?: () => ReticulumChatVerifiedReticulumPeer[];
  hasGoodOverlayHealth?: () => boolean;
  resourceStore?: ReticulumResourceStore | null;
}

const RETICULUM_CHAT_MAX_FUTURE_SKEW_MS = 5 * 60_000;
const RETICULUM_CHAT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const RETICULUM_CHAT_CONTROL_MAX_AGE_MS = 2 * 60_000;
const RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS = 30_000;
const RETICULUM_CHAT_TYPING_TTL_MS = 8_000;
const RETICULUM_CHAT_TYPING_REFRESH_MS = 3_000;
const isDisabledTyping = false;
export const isDisabledRelayCache = true;
const RETICULUM_CHAT_PROTOCOL_VERSION = 1;
const isDisableReticulumGroupKeys = true;
const RETICULUM_CHAT_PROTOCOL_FEATURES: ReticulumChatProtocolFeature[] = [
  'digest',
  'digest_req',
  'feed_req',
  'range_req',
  'resource_v2',
  'dm',
  ...(!isDisabledRelayCache ? ['relay_cache' as const] : []),
  ...(!isDisableReticulumGroupKeys ? ['group_keys' as const] : []),
];
const RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS = 100;
const RETICULUM_CHAT_EVENT_PAGE_IMPORT_YIELD_EVERY = 20;
const RETICULUM_CHAT_METADATA_SUPERSEDE_SCAN_LIMIT = 5000;
const RETICULUM_CHAT_MAX_EVENT_PAGE_BYTES = 1024 * 1024;
const RETICULUM_CHAT_MAX_DIGEST_GROUPS_PER_PAGE = 20;
const RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE = 50;
const RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP = 16;
const RETICULUM_CHAT_GROUP_DIGEST_WINDOW_EVENTS = 200;
const RETICULUM_CHAT_MAX_RECENT_AUTHOR_SAMPLE = 20;
const RETICULUM_CHAT_MAX_IN_FLIGHT_PER_PEER = 4;
const RETICULUM_CHAT_MAX_IN_FLIGHT_ACTIVE = 8;
const RETICULUM_CHAT_MAX_IN_FLIGHT_BACKGROUND = 8;
const RETICULUM_CHAT_MAX_BACKGROUND_WORK_PER_TICK = 10;
const RETICULUM_CHAT_SYNC_TICK_MS = 250;
const RETICULUM_CHAT_DIGEST_DEDUPE_TTL_MS = 30_000;
const RETICULUM_CHAT_BACKGROUND_DIGEST_REFRESH_MS = 60_000;
const RETICULUM_CHAT_ACTIVE_DIGEST_REFRESH_MS = 10_000;
const RETICULUM_CHAT_PEER_VIOLATION_COOLDOWN_MS = 5 * 60_000;
const RETICULUM_CHAT_MAX_PEER_VIOLATIONS_BEFORE_COOLDOWN = 3;
const RETICULUM_CHAT_PULL_THROTTLE_MS = 15_000;
const RETICULUM_CHAT_PULL_RETRY_MS = 5_000;
const RETICULUM_CHAT_PULL_MAX_ATTEMPTS = 8;
const RETICULUM_CHAT_PULL_QUEUE_CONCURRENCY = 3;
const RETICULUM_CHAT_PULL_QUEUE_TICK_MS = 250;
const RETICULUM_CHAT_EVENT_OFFER_CONCURRENCY = 4;
const RETICULUM_CHAT_RESOURCE_TTL_MS = 10 * 60 * 1000;
const RETICULUM_CHAT_DIRECT_HISTORY_PAGE_REQUEST_STALE_MS = 60_000;
const RETICULUM_CHAT_LOCAL_NOTIFY_DEBOUNCE_MS = 50;
const RETICULUM_CHAT_SIGNED_RESOURCE_AUTH_RETRY_MS = 1_000;
const RETICULUM_CHAT_SIGNED_RESOURCE_AUTH_MAX_RETRIES = 15;
const RETICULUM_CHAT_ALL_CHANNELS_ID = '*';
const RETICULUM_CHAT_SUBSCRIPTION_REFRESH_MS = RETICULUM_CHAT_BACKGROUND_DIGEST_REFRESH_MS;
const RETICULUM_CHAT_SUBSCRIPTION_REFRESH_JITTER_MS = 10_000;
const RETICULUM_CHAT_PEER_SUBSCRIPTION_TTL_MS = 2 * 60_000;
const RETICULUM_CHAT_SUBSCRIPTION_FANOUT_BATCH_SIZE = 8;
const RETICULUM_CHAT_SUBSCRIPTION_FANOUT_BATCH_INTERVAL_MS = 200;
const RETICULUM_CHAT_SUBSCRIPTION_FANOUT_DEDUPE_MS = 30_000;
const RETICULUM_CHAT_ACTIVE_GROUP_DIGEST_TTL_MS = 10 * 60 * 1_000;
const RETICULUM_CHAT_GROUP_REPAIR_DEBOUNCE_MS = 5_000;
const RETICULUM_CHAT_NEWEST_PAGE_PUSH_DEBOUNCE_MS = 30_000;
const RETICULUM_CHAT_AUTHOR_GAP_REPAIR_DEBOUNCE_MS = 5_000;
const RETICULUM_CHAT_AUTHOR_GAP_NO_PROGRESS_TTL_MS = 10 * 60_000;
const RETICULUM_CHAT_AUTHOR_GAP_NO_PROGRESS_MAX = 4096;
const RETICULUM_CHAT_HISTORY_PAGE_NO_PROGRESS_TTL_MS = 10 * 60_000;
const RETICULUM_CHAT_HISTORY_PAGE_NO_PROGRESS_MAX = 4096;
const RETICULUM_CHAT_MEMBER_CACHE_TTL_MS = 5 * 60_000;
const RETICULUM_CHAT_METADATA_PROJECTION_RETRY_MS = 30_000;
const RETICULUM_CHAT_EVENT_SOURCE_PEER_TTL_MS = 2 * 60 * 60_000;
const RETICULUM_CHAT_EVENT_SOURCE_PEER_MAX_EVENTS = 10_000;
const RETICULUM_CHAT_CONTROL_DEDUP_TTL_MS = 30_000;
const RETICULUM_CHAT_CONTROL_DEDUP_MAX = 4096;
const RETICULUM_CHAT_CONTROL_RETRY_MS = 3_000;
const RETICULUM_CHAT_CONTROL_RETRY_TICK_MS = 250;
const RETICULUM_CHAT_CONTROL_RETRY_MAX_ATTEMPTS = 10;
const RETICULUM_CHAT_CONTROL_RETRY_MAX = 512;
const RETICULUM_CHAT_RELAY_REPLICATION_TARGET = 3;
const RETICULUM_CHAT_RELAY_QUERY_MAX_IDS = 16;
const RETICULUM_CHAT_RELAY_QUERY_DEBOUNCE_MS = 30_000;
const RETICULUM_CHAT_RELAY_DIGEST_PAGE_SIZE = 8;

type ReticulumChatAdminValidationStatus = 'admin' | 'not_admin' | 'unknown';
type ReticulumChatMetadataProjectionResult = 'applied' | 'skipped' | 'deferred';
const RETICULUM_CHAT_RELAY_DIGEST_MAX_EVENTS_PER_SUB = 64;
const RETICULUM_CHAT_RELAY_DIGEST_DEBOUNCE_MS = 30_000;
const RETICULUM_CHAT_GROUP_KEY_DIGEST_REFRESH_MS = 60_000;
const RETICULUM_CHAT_GROUP_KEY_REQUEST_DEBOUNCE_MS = 30_000;
const RETICULUM_CHAT_RESOURCE_RELAY_ROUTE_TTL_MS = 2 * 60_000;
const RETICULUM_CHAT_RESOURCE_RELAY_MAX_ROUTES = 2048;
const RETICULUM_CHAT_RESOURCE_DISCOVERY_TTL_MS = 60_000;
const RETICULUM_CHAT_RESOURCE_FIND_TTL_MS = 30_000;
const RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS = 5;
const RETICULUM_CHAT_RESOURCE_FIND_ROUTE_TTL_MS = 2 * 60_000;
const RETICULUM_CHAT_RESOURCE_FIND_ROUTE_MAX = 4096;
const RETICULUM_DM_RESOURCE_CONTEXT_ID = 1;
const RETICULUM_CHAT_IDENTITY_REQUEST_TTL_MS = 30_000;
const RETICULUM_CHAT_IDENTITY_REQUEST_MAX_HOPS = 5;
const RETICULUM_CHAT_IDENTITY_REQUEST_TIMEOUT_MS = 8_000;
const RETICULUM_CHAT_IDENTITY_ROUTE_TTL_MS = 2 * 60_000;
const RETICULUM_CHAT_IDENTITY_ROUTE_MAX = 4096;
const RETICULUM_CHAT_DM_NOTIFY_TTL_MS = 30_000;
const RETICULUM_CHAT_DM_NOTIFY_MAX_HOPS = 5;
const RETICULUM_CHAT_DM_PROBE_TTL_MS = 30_000;
const RETICULUM_CHAT_DM_PROBE_MAX_HOPS = 5;
const RETICULUM_CHAT_DM_DISCOVERY_ROUTE_TTL_MS = 2 * 60_000;
const RETICULUM_CHAT_DM_DISCOVERY_ROUTE_MAX = 4096;
const RETICULUM_CHAT_DM_PROBE_REFRESH_MS = 5 * 60_000;
const RETICULUM_CHAT_GROUP_ROUTE_TTL_MS = 5 * 60_000;
const RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS = 8;
const RETICULUM_CHAT_GROUP_ROUTE_MAX_ROUTES = 4096;
const RETICULUM_CHAT_GROUP_ROUTE_FORWARD_DEDUPE_MS = 60_000;
const RETICULUM_CHAT_GROUP_CONTROL_RELAY_TTL_MS = 2 * 60_000;
const RETICULUM_CHAT_GROUP_CONTROL_RELAY_MAX_ROUTES = 4096;
const VALID_EVENT_TYPES = new Set<ReticulumChatEventType>([
  'message',
  'edit',
  'delete',
  'reaction_add',
  'reaction_remove',
  'attachment_manifest',
  'channel_create',
  'channel_update',
  'channel_archive',
  'channel_restore',
  'channel_reorder',
  'category_create',
  'category_update',
  'category_delete',
]);

const CHANNEL_METADATA_EVENT_TYPES = new Set<ReticulumChatEventType>([
  'channel_create',
  'channel_update',
  'channel_archive',
  'channel_restore',
  'channel_reorder',
  'category_create',
  'category_update',
  'category_delete',
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
  size?: number;
  fileName?: string;
  mimeType?: string;
  fileHash?: string;
  resourceType?: string;
  metadata?: Record<string, unknown>;
  linkId?: string;
  auth?: Record<string, unknown>;
  reason?: string;
  canceled?: boolean;
};

type ReticulumChatEventSourcePeerRecord = {
  peers: Set<string>;
  updatedAt: number;
};

type ReticulumChatPeerViolationRecord = {
  count: number;
  lastAt: number;
  cooldownUntil: number;
};

type ReticulumChatGroupInterestRoute = {
  reversePeerHash: string;
  originPeerHash: string;
  groupId: number;
  hops: number;
  expiresAt: number;
};

type ReticulumDmProbeRoute = {
  reversePeerHash: string;
  requesterAddress: string;
  expiresAt: number;
};

type ReticulumDmNotifyRoute = {
  reversePeerHash: string;
  conversationId: string;
  sourcePeerHash: string;
  expiresAt: number;
};

type ReticulumChatEventRelayRoute = {
  reversePeerHash: string;
  originPeerHash: string;
  groupId: number;
  eventId: string;
  expiresAt: number;
};

type ReticulumChatIdentityRoute = {
  reversePeerHash: string;
  destinationHash: string;
  expiresAt: number;
};

type ReticulumChatIdentityWaiter = {
  destinationHash: string;
  resolve: (publicKeyBase64: string | null) => void;
  timeout: ReturnType<typeof setTimeout>;
  expiresAt: number;
};

export function buildReticulumChatSignedFields(
  event: ReticulumChatEvent
): Record<string, unknown> {
  const mentionTargets = normalizeReticulumChatMentionTargets(
    event.mentionTargets,
    event
  );
  return {
    authorAddress: event.authorAddress,
    authorPublicKey: event.authorPublicKey,
    authorSeq: event.authorSeq,
    channelId: normalizeReticulumChatChannelId(event.channelId),
    encryptedPayload: event.encryptedPayload,
    eventId: event.eventId,
    eventType: event.eventType,
    groupId: event.groupId,
    mentionAddressHashes: event.mentionAddressHashes,
    ...(mentionTargets.length > 0 ? { mentionTargets } : {}),
    payloadHash: event.payloadHash,
    replyToEventId: event.replyToEventId ?? null,
    targetEventId: event.targetEventId ?? null,
    timestamp: event.timestamp,
  };
}

export function buildReticulumDmSignedFields(
  event: ReticulumDmEvent
): Record<string, unknown> {
  return {
    authorAddress: event.senderAddress,
    authorPublicKey: event.senderPublicKey,
    conversationId: normalizeReticulumDmConversationId(event.conversationId),
    eventId: event.eventId,
    eventType: event.eventType,
    payload: event.payload,
    payloadHash: event.payloadHash,
    recipientAddress: event.recipientAddress,
    replyToEventId: event.replyToEventId ?? null,
    senderSeq: event.senderSeq,
    targetEventId: event.targetEventId ?? null,
    timestamp: event.timestamp,
  };
}

export function buildReticulumDmNotifySignedFields(input: {
  peerAddress: string;
  sourcePeerHash: string;
  requestId: string;
  probeRequestId?: string;
  maxHops: number;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    maxHops: input.maxHops,
    peerAddress: input.peerAddress,
    probeRequestId: input.probeRequestId ?? null,
    requestId: input.requestId,
    sourcePeerHash: input.sourcePeerHash,
    timestamp: input.timestamp,
    type: 'RCHAT_DM_NOTIFY',
  };
}

export function buildReticulumDmProbeSignedFields(input: {
  requestId: string;
  maxHops: number;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    maxHops: input.maxHops,
    requestId: input.requestId,
    timestamp: input.timestamp,
    type: 'RCHAT_DM_PROBE',
  };
}

export function buildReticulumDmRequestSignedFields(input: {
  peerAddress: string;
  after: number;
  limit: number;
  requesterPeerHash: string;
  requestId: string;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    after: input.after,
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    limit: input.limit,
    peerAddress: input.peerAddress,
    requestId: input.requestId,
    requesterPeerHash: input.requesterPeerHash,
    timestamp: input.timestamp,
    type: 'RCHAT_DM_REQ',
  };
}

export function buildReticulumDmResourceRequestSignedFields(input: {
  conversationId: string;
  peerAddress: string;
  fileHash: string;
  byteRanges: Array<[number, number]>;
  requestId?: string;
  requesterPeerHash: string;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    byteRanges: normalizeByteRanges(input.byteRanges),
    conversationId: normalizeReticulumDmConversationId(input.conversationId),
    fileHash: input.fileHash,
    peerAddress: input.peerAddress,
    requestId: input.requestId ?? null,
    requesterPeerHash: input.requesterPeerHash,
    timestamp: input.timestamp,
    type: 'RCHAT_DM_RESOURCE_REQ',
  };
}

export function buildReticulumDmResourceFindSignedFields(input: {
  conversationId: string;
  peerAddress: string;
  requestId: string;
  fileHash: string;
  sizeBytes: number;
  maxHops: number;
  expiresAt: number;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    conversationId: normalizeReticulumDmConversationId(input.conversationId),
    expiresAt: input.expiresAt,
    fileHash: input.fileHash,
    maxHops: input.maxHops,
    peerAddress: input.peerAddress,
    requestId: input.requestId,
    sizeBytes: input.sizeBytes,
    timestamp: input.timestamp,
    type: 'RCHAT_DM_RESOURCE_FIND',
  };
}

export function normalizeReticulumChatMentionTargets(
  value: unknown,
  event?: Partial<Pick<ReticulumChatEvent, 'groupId' | 'channelId' | 'timestamp'>>
): ReticulumChatMentionTarget[] {
  if (!Array.isArray(value)) return [];
  const groupId = Number(event?.groupId);
  const eventChannelId = normalizeReticulumChatChannelId(event?.channelId);
  const createdAt = Number(event?.timestamp);
  const targets: ReticulumChatMentionTarget[] = [];
  const seen = new Set<string>();

  const add = (target: ReticulumChatMentionTarget) => {
    const key = JSON.stringify(target);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const target = raw as Record<string, unknown>;
    const type = typeof target.type === 'string' ? target.type : '';
    if (type === 'user') {
      const addressHash =
        typeof target.addressHash === 'string' ? target.addressHash.trim().toLowerCase() : '';
      if (/^[0-9a-f]{64}$/i.test(addressHash)) add({ type: 'user', addressHash });
      continue;
    }

    const targetGroupId = Number(target.groupId);
    if (
      !Number.isInteger(targetGroupId) ||
      targetGroupId <= 0 ||
      (Number.isInteger(groupId) && targetGroupId !== groupId)
    ) {
      continue;
    }

    if (type === 'everyone') {
      add({ type: 'everyone', groupId: targetGroupId });
      continue;
    }
    if (type === 'group') {
      const groupName =
        typeof target.groupName === 'string' ? target.groupName.trim().slice(0, 120) : '';
      add({
        type: 'group',
        groupId: targetGroupId,
        ...(groupName ? { groupName } : {}),
      });
      continue;
    }
    if (type === 'channel') {
      const channelId = normalizeReticulumChatChannelId(target.channelId);
      const channelName =
        typeof target.channelName === 'string' ? target.channelName.trim().slice(0, 120) : '';
      add({
        type: 'channel',
        groupId: targetGroupId,
        channelId,
        ...(channelName ? { channelName } : {}),
      });
      continue;
    }
    if (type === 'here') {
      const channelId = normalizeReticulumChatChannelId(target.channelId || eventChannelId);
      const targetCreatedAt = Number(target.createdAt);
      add({
        type: 'here',
        groupId: targetGroupId,
        channelId,
        createdAt: Number.isFinite(targetCreatedAt)
          ? targetCreatedAt
          : Number.isFinite(createdAt)
            ? createdAt
            : Date.now(),
      });
    }
  }

  return targets.slice(0, 32);
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

type ReticulumChatEventPageResource = {
  v: 1;
  g: number;
  c: string;
  d: 'after' | 'before' | 'range';
  p?: 'm';
  more?: boolean;
  start?: ReticulumChatFeedCursorWire;
  end?: ReticulumChatFeedCursorWire;
  wh: string;
  events: ReticulumChatEvent[];
};

function serializeReticulumChatEventPage(page: ReticulumChatEventPageResource): string {
  return JSON.stringify(page);
}

function hashReticulumChatEventPage(pageJson: string): string {
  return nodeCrypto
    .createHash('sha256')
    .update(pageJson, 'utf8')
    .digest('hex');
}

export function hashReticulumChatEventWire(event: ReticulumChatEvent): string {
  return nodeCrypto
    .createHash('sha256')
    .update(serializeReticulumChatEvent(event), 'utf8')
    .digest('hex');
}

function normalizePeerHashFromWire(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (/^[0-9a-f]{16,64}$/.test(normalized)) return normalized;
  try {
    const padded = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Buffer.from(
      `${padded}${'='.repeat((4 - (padded.length % 4)) % 4)}`,
      'base64'
    );
    if (bytes.length !== 16) return undefined;
    return bytes.toString('hex');
  } catch {
    return undefined;
  }
}

function compactPeerHashForWire(peerHash: string): string {
  const normalized = normalizePeerHashFromWire(peerHash);
  if (!normalized || normalized.length !== 32) return peerHash;
  return Buffer.from(normalized, 'hex')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizeRoutePeerHash(value: unknown): string | undefined {
  const normalized = normalizePeerHashFromWire(value);
  if (normalized) return normalized;
  if (typeof value !== 'string') return undefined;
  const fallback = value.trim().toLowerCase();
  return /^[a-z0-9._:-]{1,128}$/.test(fallback) ? fallback : undefined;
}

function normalizeReticulumIdentityPublicKeyBase64(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  try {
    const pad = '='.repeat((4 - (trimmed.length % 4)) % 4);
    const decoded = Buffer.from(trimmed + pad, 'base64');
    return decoded.length === 64 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export function buildReticulumChatEventHint(
  event: ReticulumChatEvent
): ReticulumChatEventHint {
  return {
    eventId: event.eventId,
    groupId: event.groupId,
    channelId: normalizeReticulumChatChannelId(event.channelId),
    authorAddress: event.authorAddress,
    authorSeq: event.authorSeq,
    timestamp: event.timestamp,
    eventType: event.eventType,
    payloadHash: event.payloadHash,
    mentionAddressHashes: event.mentionAddressHashes,
  };
}

function eventOfferToWire(offer: ReticulumChatEventOffer): ReticulumChatEventOfferWire {
  const providerDestinationHash =
    normalizeRoutePeerHash(offer.senderReticulumDestinationHash) ??
    normalizeRoutePeerHash(offer.sourcePeerHash);
  return {
    x: offer.transferId,
    id: offer.eventId,
    wh: offer.wireHash,
    s: offer.sizeBytes,
    ...(offer.relayRequestId ? { rr: offer.relayRequestId } : {}),
    ...(providerDestinationHash ? { sd: compactPeerHashForWire(providerDestinationHash) } : {}),
    ...(offer.relayStore ? { rs: 1 as const } : {}),
    ...(offer.relayCached ? { rc: 1 as const } : {}),
  };
}

function buildEventOfferControlWire(
  groupId: number,
  offer: ReticulumChatEventOffer
): Extract<ReticulumChatWire, { k: 'event_offer' }> {
  return {
    t: 'RCHAT',
    k: 'event_offer',
    g: groupId,
    o: eventOfferToWire(offer),
  };
}

function eventOfferFromWire(groupId: number, wire: unknown): ReticulumChatEventOffer | null {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const o = wire as Partial<ReticulumChatEventOfferWire>;
  const continuation =
    typeof o.fc === 'string' &&
    (o.fd === 'a' || o.fd === 'b') &&
    typeof o.fid === 'string' &&
    Number.isFinite(Number(o.fts))
      ? {
          channelId:
            o.fc === RETICULUM_CHAT_ALL_CHANNELS_ID
              ? RETICULUM_CHAT_ALL_CHANNELS_ID
              : normalizeReticulumChatChannelId(o.fc),
          direction: o.fd === 'b' ? 'before' as const : 'after' as const,
          cursor: {
            eventId: o.fid,
            feedTimestamp: Number(o.fts),
          },
        }
      : undefined;
  const sourcePeerHash =
    typeof o.sp === 'string' && o.sp
      ? normalizePeerHashFromWire(o.sp) ?? o.sp
      : typeof o.sd === 'string' && o.sd
        ? normalizePeerHashFromWire(o.sd) ?? o.sd
        : undefined;
  return {
    transferId: String(o.x || ''),
    eventId: String(o.id || ''),
    groupId,
    payloadHash: String(o.ph || ''),
    wireHash: String(o.wh || ''),
    sizeBytes: Number(o.s || 0),
    ...(continuation ? { continuation } : {}),
    ...(typeof o.rr === 'string' && o.rr ? { relayRequestId: o.rr } : {}),
    ...(sourcePeerHash ? { sourcePeerHash } : {}),
    ...(typeof o.sd === 'string' && o.sd ? { senderReticulumDestinationHash: normalizePeerHashFromWire(o.sd) ?? o.sd } : {}),
    ...(typeof o.rk === 'string' && o.rk ? { senderReticulumIdentityPublicKeyBase64: o.rk } : {}),
    ...(o.rs === 1 ? { relayStore: true } : {}),
    ...(o.rc === 1 ? { relayCached: true } : {}),
    ...(typeof o.bid === 'string' && /^[0-9a-f]{64}$/i.test(o.bid) ? { relayBlobId: o.bid.toLowerCase() } : {}),
  };
}

function normalizeReticulumChatAuthorRange(range: unknown): ReticulumChatAuthorRange | null {
  if (!range || typeof range !== 'object' || Array.isArray(range)) return null;
  const candidate = range as { a?: unknown; from?: unknown; to?: unknown };
  const authorAddress = typeof candidate.a === 'string' ? candidate.a.trim() : '';
  const fromSeq = Number(candidate.from);
  const toSeq = Number(candidate.to);
  if (
    !authorAddress ||
    !Number.isInteger(fromSeq) ||
    !Number.isInteger(toSeq) ||
    fromSeq <= 0 ||
    toSeq < fromSeq
  ) {
    return null;
  }
  return { a: authorAddress, from: fromSeq, to: toSeq };
}

function authorRangeToWireTuple(range: ReticulumChatAuthorRange | undefined): [string, number, number] | undefined {
  const normalized = normalizeReticulumChatAuthorRange(range);
  if (!normalized) return undefined;
  return [normalized.a, normalized.from, normalized.to];
}

function authorRangeFromWireTuple(tuple: unknown): ReticulumChatAuthorRange | null {
  if (!Array.isArray(tuple) || tuple.length !== 3) return null;
  return normalizeReticulumChatAuthorRange({
    a: tuple[0],
    from: tuple[1],
    to: tuple[2],
  });
}

function eventPageOfferToWire(offer: ReticulumChatEventPageOffer): ReticulumChatEventPageOfferWire {
  const providerDestinationHash =
    normalizeRoutePeerHash(offer.senderReticulumDestinationHash) ??
    normalizeRoutePeerHash(offer.sourcePeerHash);
  const repairRange = offer.direction === 'range'
    ? authorRangeToWireTuple(offer.repairRange)
    : undefined;
  return {
    x: offer.transferId,
    c: offer.channelId,
    d: offer.direction === 'before' ? 'b' : offer.direction === 'range' ? 'r' : 'a',
    ...(feedPriorityToWire(offer.priority) ? { p: feedPriorityToWire(offer.priority) } : {}),
    ph: offer.pageHash,
    s: offer.sizeBytes,
    n: offer.eventCount,
    ...(offer.hasMore ? { more: 1 as const } : {}),
    ...(offer.relayRequestId ? { rr: offer.relayRequestId } : {}),
    ...(providerDestinationHash ? { sd: compactPeerHashForWire(providerDestinationHash) } : {}),
    ...(repairRange ? { r: repairRange } : {}),
  };
}

function buildEventPageOfferControlWire(
  groupId: number,
  offer: ReticulumChatEventPageOffer
): Extract<ReticulumChatWire, { k: 'event_page_offer' }> {
  return {
    t: 'RCHAT',
    k: 'event_page_offer',
    g: groupId,
    p: eventPageOfferToWire(offer),
  };
}

function eventPageOfferFromWire(groupId: number, wire: unknown): ReticulumChatEventPageOffer | null {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const p = wire as Partial<ReticulumChatEventPageOfferWire>;
  const priority = feedPriorityFromWire(p.p);
  if (p.p != null && !priority) return null;
  const start =
    typeof p.sid === 'string' && Number.isFinite(Number(p.sts))
      ? { eventId: p.sid, feedTimestamp: Number(p.sts) }
      : undefined;
  const end =
    typeof p.eid === 'string' && Number.isFinite(Number(p.ets))
      ? { eventId: p.eid, feedTimestamp: Number(p.ets) }
      : undefined;
  const direction = p.d === 'b' ? 'before' : p.d === 'r' ? 'range' : 'after';
  const repairRange = direction === 'range' ? authorRangeFromWireTuple(p.r) : null;
  if (p.r != null && !repairRange) return null;
  return {
    transferId: String(p.x || ''),
    groupId,
    channelId:
      p.c === RETICULUM_CHAT_ALL_CHANNELS_ID
        ? RETICULUM_CHAT_ALL_CHANNELS_ID
        : normalizeReticulumChatChannelId(p.c),
    direction,
    ...(priority ? { priority } : {}),
    pageHash: String(p.ph || ''),
    sizeBytes: Number(p.s || 0),
    eventCount: Number(p.n || 0),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(p.more === 1 ? { hasMore: true } : {}),
    ...(typeof p.rr === 'string' && p.rr ? { relayRequestId: p.rr } : {}),
    ...(typeof p.sp === 'string' && p.sp ? { sourcePeerHash: normalizePeerHashFromWire(p.sp) ?? p.sp } : {}),
    ...(typeof p.sd === 'string' && p.sd ? { senderReticulumDestinationHash: normalizePeerHashFromWire(p.sd) ?? p.sd } : {}),
    ...(typeof p.rk === 'string' && p.rk ? { senderReticulumIdentityPublicKeyBase64: p.rk } : {}),
    ...(repairRange ? { repairRange } : {}),
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
  if (
    typeof e.channelId !== 'string' ||
    normalizeReticulumChatChannelId(e.channelId) !== e.channelId
  ) {
    return false;
  }
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
  if (
    !Array.isArray(e.mentionAddressHashes) ||
    e.mentionAddressHashes.some(
      (hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)
    )
  ) {
    return false;
  }
  if (
    e.mentionTargets != null &&
    normalizeReticulumChatMentionTargets(e.mentionTargets, e).length !==
      e.mentionTargets.length
  ) {
    return false;
  }
  if (typeof e.signature !== 'string' || !e.signature) return false;
  try {
    return deriveAddressFromPublicKey(e.authorPublicKey) === e.authorAddress;
  } catch {
    return false;
  }
}

export function validateReticulumDmEventShape(
  event: unknown,
  now = Date.now()
): event is ReticulumDmEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const e = event as Partial<ReticulumDmEvent>;
  if (typeof e.eventId !== 'string' || e.eventId.length < 8) return false;
  if (!normalizeReticulumDmConversationId(e.conversationId)) return false;
  if (typeof e.senderAddress !== 'string' || !e.senderAddress) return false;
  if (typeof e.recipientAddress !== 'string' || !e.recipientAddress) return false;
  if (e.senderAddress === e.recipientAddress) return false;
  if (
    e.conversationId !==
    reticulumDmConversationId(e.senderAddress, e.recipientAddress)
  ) {
    return false;
  }
  if (typeof e.senderPublicKey !== 'string' || !e.senderPublicKey) return false;
  if (!Number.isInteger(e.senderSeq) || (e.senderSeq as number) <= 0) return false;
  if (!Number.isFinite(e.timestamp)) return false;
  if ((e.timestamp as number) > now + RETICULUM_CHAT_MAX_FUTURE_SKEW_MS) return false;
  if ((e.timestamp as number) < now - RETICULUM_CHAT_MAX_AGE_MS) return false;
  if (
    e.eventType !== 'message' &&
    e.eventType !== 'edit' &&
    e.eventType !== 'delete' &&
    e.eventType !== 'reaction_add' &&
    e.eventType !== 'reaction_remove'
  ) {
    return false;
  }
  if (typeof e.payload !== 'string') return false;
  if (Buffer.byteLength(e.payload, 'utf8') > RETICULUM_CHAT_RELAY_EVENT_MAX_BYTES) return false;
  if (typeof e.payloadHash !== 'string' || !/^[0-9a-f]{64}$/i.test(e.payloadHash)) return false;
  if (hashReticulumChatPayload(e.payload) !== e.payloadHash.toLowerCase()) return false;
  if (e.targetEventId != null && typeof e.targetEventId !== 'string') return false;
  if (e.replyToEventId != null && typeof e.replyToEventId !== 'string') return false;
  if (typeof e.signature !== 'string' || !e.signature) return false;
  try {
    return deriveAddressFromPublicKey(e.senderPublicKey) === e.senderAddress;
  } catch {
    return false;
  }
}

export function buildReticulumChatEventRequestSignedFields(input: {
  groupId: number;
  eventId: string;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    eventId: input.eventId,
    groupId: input.groupId,
    timestamp: input.timestamp,
    type: 'RCHAT_EVENT_REQ',
  };
}

export function buildReticulumChatHistoryPageRequestSignedFields(input: {
  groupId: number;
  channelId: string;
  direction: 'after' | 'before';
  priority?: ReticulumChatFeedPriority;
  after?: ReticulumChatFeedCursorWire;
  before?: ReticulumChatFeedCursorWire;
  includeCursor?: boolean;
  limit: number;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    channelId:
      input.channelId === RETICULUM_CHAT_ALL_CHANNELS_ID
        ? RETICULUM_CHAT_ALL_CHANNELS_ID
        : normalizeReticulumChatChannelId(input.channelId),
    direction: input.direction,
    ...(input.priority ? { priority: input.priority } : {}),
    after: input.after ?? null,
    before: input.before ?? null,
    groupId: input.groupId,
    includeCursor: input.includeCursor === true,
    limit: Math.max(1, Math.min(RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS, Math.floor(input.limit))),
    timestamp: input.timestamp,
    type: 'RCHAT_HISTORY_PAGE_REQ',
  };
}

export function buildReticulumChatResourceAuthSignedFields(input: {
  groupId: number;
  transferId: string;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    groupId: input.groupId,
    timestamp: input.timestamp,
    transferId: input.transferId,
    type: 'RCHAT_RESOURCE_AUTH',
  };
}

export function buildReticulumChatResourceRequestSignedFields(input: {
  groupId: number;
  eventId?: string;
  fileHash: string;
  byteRanges: Array<[number, number]>;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  const byteRanges = normalizeByteRanges(input.byteRanges);
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    eventId: input.eventId ?? null,
    fileHash: input.fileHash,
    groupId: input.groupId,
    byteRanges,
    timestamp: input.timestamp,
    type: 'RCHAT_RESOURCE_REQ',
  };
}

export function buildReticulumChatResourceFindSignedFields(input: {
  groupId: number;
  requestId: string;
  fileHash: string;
  sizeBytes: number;
  maxHops: number;
  expiresAt: number;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    expiresAt: input.expiresAt,
    fileHash: input.fileHash,
    groupId: input.groupId,
    maxHops: input.maxHops,
    requestId: input.requestId,
    sizeBytes: input.sizeBytes,
    timestamp: input.timestamp,
    type: 'RCHAT_RESOURCE_FIND',
  };
}

export function buildReticulumChatGroupKeyDigestSignedFields(input: {
  groupId: number;
  epoch: number;
  keyId: string;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    epoch: input.epoch,
    groupId: input.groupId,
    keyId: input.keyId.toLowerCase(),
    timestamp: input.timestamp,
    type: 'RCHAT_GROUP_KEY_DIGEST',
  };
}

export function buildReticulumChatGroupKeyRequestSignedFields(input: {
  groupId: number;
  epoch: number;
  keyId: string;
  requestId: string;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    epoch: input.epoch,
    groupId: input.groupId,
    keyId: input.keyId.toLowerCase(),
    requestId: input.requestId.toLowerCase(),
    timestamp: input.timestamp,
    type: 'RCHAT_GROUP_KEY_REQ',
  };
}

export function buildReticulumChatGroupKeyResponseSignedFields(input: {
  groupId: number;
  epoch: number;
  keyId: string;
  keyBytesBase64: string;
  requestId: string;
  authorAddress: string;
  authorPublicKey: string;
  timestamp: number;
}): Record<string, unknown> {
  return {
    authorAddress: input.authorAddress,
    authorPublicKey: input.authorPublicKey,
    epoch: input.epoch,
    groupId: input.groupId,
    keyBytesBase64: input.keyBytesBase64,
    keyId: input.keyId.toLowerCase(),
    requestId: input.requestId.toLowerCase(),
    timestamp: input.timestamp,
    type: 'RCHAT_GROUP_KEY_RES',
  };
}

function isReticulumGroupKeyId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isReticulumGroupKeyRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8,64}$/i.test(value);
}

function reticulumGroupKeyBytesFromBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function reticulumGroupKeyIdFromBase64(value: string): string {
  return nodeCrypto.createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex');
}

function byteRangesFromWire(ranges: unknown): ReticulumResourceByteRange[] | null {
  if (!Array.isArray(ranges)) return null;
  const parsed: ReticulumResourceByteRange[] = [];
  for (const range of ranges) {
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !Number.isInteger(range[0]) ||
      !Number.isInteger(range[1]) ||
      range[0] < 0 ||
      range[1] <= range[0]
    ) {
      return null;
    }
    parsed.push({ startByte: range[0], endByteExclusive: range[1] });
  }
  return parsed;
}

function normalizeByteRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const parsed = byteRangesFromWire(ranges);
  if (!parsed) return [];
  return parsed
    .sort((a, b) => a.startByte - b.startByte || a.endByteExclusive - b.endByteExclusive)
    .map((range) => [range.startByte, range.endByteExclusive]);
}

function isFeedCursorWire(value: unknown): value is ReticulumChatFeedCursorWire {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as Partial<ReticulumChatFeedCursorWire>;
  return (
    typeof cursor.id === 'string' &&
    cursor.id.length >= 8 &&
    Number.isFinite(cursor.ts) &&
    cursor.ts >= 0
  );
}

function feedPriorityToWire(priority: ReticulumChatFeedPriority | undefined): 'm' | undefined {
  return priority === 'metadata' ? 'm' : undefined;
}

function feedPriorityFromWire(value: unknown): ReticulumChatFeedPriority | undefined {
  return value === 'm' ? 'metadata' : undefined;
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

export function verifyReticulumDmEvent(event: ReticulumDmEvent): boolean {
  try {
    const derived = deriveAddressFromPublicKey(event.senderPublicKey);
    if (derived !== event.senderAddress) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(buildReticulumDmSignedFields(event))
      ),
      new Uint8Array(base58Decode(event.signature)),
      new Uint8Array(base58Decode(event.senderPublicKey))
    );
  } catch {
    return false;
  }
}

function normalizeReticulumControlRequestId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8,64}$/.test(normalized) ? normalized : '';
}

function deriveReticulumControlAuthor(publicKey: unknown): string {
  if (typeof publicKey !== 'string' || !publicKey) return '';
  try {
    return deriveAddressFromPublicKey(publicKey);
  } catch {
    return '';
  }
}

export function verifyReticulumDmNotify(
  wire: ReticulumDmNotifyWire,
  now = Date.now()
): boolean {
  const peerAddress = typeof wire?.b === 'string' ? wire.b.trim() : '';
  const requestId = normalizeReticulumControlRequestId(wire?.q);
  const sourcePeerHash = normalizePeerHashFromWire(wire?.sp) ?? '';
  const probeRequestId = normalizeReticulumControlRequestId(wire?.r) || undefined;
  const maxHops = wire.m == null ? RETICULUM_CHAT_DM_NOTIFY_MAX_HOPS : Number(wire.m);
  const hop = wire.h == null ? 0 : Number(wire.h);
  if (!peerAddress) return false;
  if (!requestId || !sourcePeerHash) return false;
  if (!Number.isFinite(wire.n)) return false;
  if (wire.n > now + RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
  if (wire.n < now - RETICULUM_CHAT_DM_NOTIFY_TTL_MS) return false;
  if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > RETICULUM_CHAT_DM_NOTIFY_MAX_HOPS) return false;
  if (!Number.isInteger(hop) || hop < 0 || hop > maxHops) return false;
  const authorAddress = deriveReticulumControlAuthor(wire.p);
  if (!authorAddress || authorAddress === peerAddress) return false;
  if (typeof wire.z !== 'string' || !wire.z) return false;
  try {
    const signedFields = buildReticulumDmNotifySignedFields({
      peerAddress,
      sourcePeerHash,
      requestId,
      probeRequestId,
      maxHops,
      authorAddress,
      authorPublicKey: wire.p,
      timestamp: wire.n,
    });
    return nacl.sign.detached.verify(
      new Uint8Array(canonicalizeForSigning(signedFields)),
      new Uint8Array(base58Decode(wire.z)),
      new Uint8Array(base58Decode(wire.p))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumDmProbe(
  wire: ReticulumDmProbeWire,
  now = Date.now()
): boolean {
  const requestId = normalizeReticulumControlRequestId(wire?.q);
  const maxHops = wire.m == null ? RETICULUM_CHAT_DM_PROBE_MAX_HOPS : Number(wire.m);
  const hop = wire.h == null ? 0 : Number(wire.h);
  if (!requestId) return false;
  if (!Number.isFinite(wire.n)) return false;
  if (wire.n > now + RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
  if (wire.n < now - RETICULUM_CHAT_DM_PROBE_TTL_MS) return false;
  if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > RETICULUM_CHAT_DM_PROBE_MAX_HOPS) return false;
  if (!Number.isInteger(hop) || hop < 0 || hop > maxHops) return false;
  const authorAddress = deriveReticulumControlAuthor(wire.p);
  if (!authorAddress) return false;
  if (typeof wire.z !== 'string' || !wire.z) return false;
  try {
    const signedFields = buildReticulumDmProbeSignedFields({
      requestId,
      maxHops,
      authorAddress,
      authorPublicKey: wire.p,
      timestamp: wire.n,
    });
    return nacl.sign.detached.verify(
      new Uint8Array(canonicalizeForSigning(signedFields)),
      new Uint8Array(base58Decode(wire.z)),
      new Uint8Array(base58Decode(wire.p))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumDmRequest(
  wire: ReticulumDmRequestWire,
  now = Date.now()
): boolean {
  const peerAddress = typeof wire?.b === 'string' ? wire.b.trim() : '';
  const requestId = normalizeReticulumControlRequestId(wire?.q);
  const requesterPeerHash = normalizePeerHashFromWire(wire?.rp) ?? '';
  const after = Math.max(0, Math.floor(Number(wire?.a ?? wire?.after ?? 0)));
  const limit = Math.max(1, Math.min(50, Math.floor(Number(wire?.l ?? wire?.limit ?? 50))));
  if (!peerAddress) return false;
  if (!requestId || !requesterPeerHash) return false;
  if (!Number.isFinite(wire.n)) return false;
  if (wire.n > now + RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
  if (wire.n < now - RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return false;
  const authorAddress = deriveReticulumControlAuthor(wire.p);
  if (!authorAddress || authorAddress === peerAddress) return false;
  if (typeof wire.z !== 'string' || !wire.z) return false;
  try {
    const signedFields = buildReticulumDmRequestSignedFields({
      peerAddress,
      after,
      limit,
      requesterPeerHash,
      requestId,
      authorAddress,
      authorPublicKey: wire.p,
      timestamp: wire.n,
    });
    return nacl.sign.detached.verify(
      new Uint8Array(canonicalizeForSigning(signedFields)),
      new Uint8Array(base58Decode(wire.z)),
      new Uint8Array(base58Decode(wire.p))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumDmResourceRequest(
  wire: ReticulumDmResourceRequestWire,
  now = Date.now()
): boolean {
  try {
    const conversationId = normalizeReticulumDmConversationId(wire?.c);
    const peerAddress = typeof wire?.b === 'string' ? wire.b.trim() : '';
    const fileHash = typeof wire?.fh === 'string' ? wire.fh.trim().toLowerCase() : '';
    const byteRanges = normalizeByteRanges(wire?.r ?? []);
    const requesterPeerHash = normalizePeerHashFromWire(wire?.rp) ?? '';
    const requestId = wire?.q ? normalizeReticulumControlRequestId(wire.q) : undefined;
    if (!conversationId || !peerAddress) return false;
    if (!/^[0-9a-f]{64}$/i.test(fileHash)) return false;
    if (byteRanges.length === 0) return false;
    if (!requesterPeerHash) return false;
    if (!Number.isFinite(wire.n)) return false;
    if (wire.n > now + RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
    if (wire.n < now - RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return false;
    const authorAddress = deriveReticulumControlAuthor(wire.p);
    if (!authorAddress || authorAddress === peerAddress) return false;
    if (reticulumDmConversationId(authorAddress, peerAddress) !== conversationId) return false;
    if (typeof wire.z !== 'string' || !wire.z) return false;
    const signedFields = buildReticulumDmResourceRequestSignedFields({
      conversationId,
      peerAddress,
      fileHash,
      byteRanges,
      requestId,
      requesterPeerHash,
      authorAddress,
      authorPublicKey: wire.p,
      timestamp: wire.n,
    });
    return nacl.sign.detached.verify(
      new Uint8Array(canonicalizeForSigning(signedFields)),
      new Uint8Array(base58Decode(wire.z)),
      new Uint8Array(base58Decode(wire.p))
    );
  } catch {
    return false;
  }
}

export function getReticulumDmResourceFindRejectReason(
  wire: ReticulumDmResourceFindWire,
  now = Date.now()
): string | null {
  try {
    const peerAddress = typeof wire?.b === 'string' ? wire.b.trim() : '';
    const requesterAddressFromWire = typeof wire?.a === 'string' ? wire.a.trim() : '';
    if (!peerAddress) return 'missing_peer_address';
    if (!requesterAddressFromWire && !wire?.p) return 'missing_requester_address';
    if (typeof wire.q !== 'string' || !/^[0-9a-f]{8,64}$/i.test(wire.q)) return 'invalid_request_id';
    if (typeof wire.f !== 'string' || !/^[0-9a-f]{64}$/i.test(wire.f)) return 'invalid_file_hash';
    if (wire.s != null && (!Number.isInteger(wire.s) || wire.s <= 0)) return 'invalid_size';
    const hop = wire.h == null ? 0 : wire.h;
    const maxHops = wire.m == null ? RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS : wire.m;
    if (!Number.isInteger(hop) || hop < 0) return 'invalid_hop';
    if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS) return 'invalid_max_hops';
    if (!Number.isFinite(wire.x) || wire.x <= now) return 'expired';
    if (wire.x - now > RETICULUM_CHAT_RESOURCE_FIND_TTL_MS + RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return 'expires_too_far';
    const authorAddress = wire.p ? deriveAddressFromPublicKey(wire.p) : requesterAddressFromWire;
    if (!authorAddress || authorAddress === peerAddress) return 'invalid_requester_address';
    if (requesterAddressFromWire && requesterAddressFromWire !== authorAddress) return 'requester_mismatch';
    const derivedConversationId = reticulumDmConversationId(authorAddress, peerAddress);
    const providedConversationId = normalizeReticulumDmConversationId(wire?.c);
    const conversationId = providedConversationId || derivedConversationId;
    if (!conversationId) return 'invalid_conversation';
    if (!derivedConversationId || derivedConversationId !== conversationId) return 'conversation_mismatch';
    if (!wire.p && !wire.z && wire.n == null) return null;
    if (typeof wire.p !== 'string' || !wire.p) return 'missing_public_key';
    if (typeof wire.z !== 'string' || !wire.z) return 'missing_signature';
    if (!Number.isFinite(wire.n)) return 'invalid_timestamp';
    if (wire.n - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return 'timestamp_in_future';
    if (now - wire.n > RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return 'timestamp_too_old';
    if (wire.s == null) return 'missing_signed_size';
    const ok = nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumDmResourceFindSignedFields({
            conversationId,
            peerAddress,
            requestId: wire.q.toLowerCase(),
            fileHash: wire.f.toLowerCase(),
            sizeBytes: wire.s,
            maxHops,
            expiresAt: wire.x,
            authorAddress,
            authorPublicKey: wire.p,
            timestamp: wire.n,
          })
        )
      ),
      new Uint8Array(base58Decode(wire.z)),
      new Uint8Array(base58Decode(wire.p))
    );
    return ok ? null : 'bad_signature';
  } catch {
    return 'exception';
  }
}

export function verifyReticulumChatEventRequest(
  groupId: number,
  request: ReticulumChatEventRequestWire,
  now = Date.now()
): boolean {
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    if (typeof request.id !== 'string' || request.id.length < 8) return false;
    if (typeof request.a !== 'string' || !request.a) return false;
    if (typeof request.pk !== 'string' || !request.pk) return false;
    if (typeof request.sig !== 'string' || !request.sig) return false;
    if (!Number.isFinite(request.ts)) return false;
    if (request.ts - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
    if (now - request.ts > RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return false;
    const derived = deriveAddressFromPublicKey(request.pk);
    if (derived !== request.a) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumChatEventRequestSignedFields({
            groupId,
            eventId: request.id,
            authorAddress: request.a,
            authorPublicKey: request.pk,
            timestamp: request.ts,
          })
        )
      ),
      new Uint8Array(base58Decode(request.sig)),
      new Uint8Array(base58Decode(request.pk))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumChatHistoryPageRequest(
  groupId: number,
  request: ReticulumChatHistoryPageRequestWire,
  now = Date.now()
): boolean {
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    if (
      request.c !== RETICULUM_CHAT_ALL_CHANNELS_ID &&
      normalizeReticulumChatChannelId(request.c) !== request.c
    ) {
      return false;
    }
    if (request.d !== 'after' && request.d !== 'before') return false;
    const priority = feedPriorityFromWire(request.p);
    if (request.p != null && !priority) return false;
    if (request.after != null && !isFeedCursorWire(request.after)) return false;
    if (request.before != null && !isFeedCursorWire(request.before)) return false;
    if (request.after != null && request.before != null) return false;
    if (request.inc != null && request.inc !== 1) return false;
    const limit = Number(request.limit ?? RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS);
    if (!Number.isInteger(limit) || limit <= 0 || limit > RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS) return false;
    if (typeof request.a !== 'string' || !request.a) return false;
    if (typeof request.pk !== 'string' || !request.pk) return false;
    if (typeof request.sig !== 'string' || !request.sig) return false;
    if (!Number.isFinite(request.ts)) return false;
    if (request.ts - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
    if (now - request.ts > RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return false;
    const derived = deriveAddressFromPublicKey(request.pk);
    if (derived !== request.a) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumChatHistoryPageRequestSignedFields({
            groupId,
            channelId: request.c,
            direction: request.d,
            priority,
            after: request.after,
            before: request.before,
            includeCursor: request.inc === 1,
            limit,
            authorAddress: request.a,
            authorPublicKey: request.pk,
            timestamp: request.ts,
          })
        )
      ),
      new Uint8Array(base58Decode(request.sig)),
      new Uint8Array(base58Decode(request.pk))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumChatResourceAuth(
  groupId: number,
  request: ReticulumChatResourceAuthWire | ReticulumChatEventPageResourceAuthWire,
  now = Date.now()
): boolean {
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    if (request.g !== groupId) return false;
    if (typeof request.x !== 'string' || request.x.length < 8) return false;
    if (typeof request.a !== 'string' || !request.a) return false;
    if (typeof request.p !== 'string' || !request.p) return false;
    if (typeof request.z !== 'string' || !request.z) return false;
    if (!Number.isFinite(request.ts)) return false;
    if (request.ts - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
    if (now - request.ts > RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return false;
    const derived = deriveAddressFromPublicKey(request.p);
    if (derived !== request.a) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumChatResourceAuthSignedFields({
            groupId,
            transferId: request.x,
            authorAddress: request.a,
            authorPublicKey: request.p,
            timestamp: request.ts,
          })
        )
      ),
      new Uint8Array(base58Decode(request.z)),
      new Uint8Array(base58Decode(request.p))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumChatResourceRequest(
  groupId: number,
  request: ReticulumChatResourceRequestWire,
  now = Date.now()
): boolean {
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    if (request.eid != null && (typeof request.eid !== 'string' || request.eid.length < 8)) return false;
    if (typeof request.fh !== 'string' || !/^[0-9a-f]{64}$/i.test(request.fh)) return false;
    const byteRanges = normalizeByteRanges(request.b ?? []);
    if (byteRanges.length === 0) return false;
    if (typeof request.pk !== 'string' || !request.pk) return false;
    if (typeof request.sig !== 'string' || !request.sig) return false;
    if (!Number.isFinite(request.ts)) return false;
    if (request.ts - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
    if (now - request.ts > RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return false;
    const derived = deriveAddressFromPublicKey(request.pk);
    if (!derived) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumChatResourceRequestSignedFields({
            groupId,
            eventId: request.eid,
            fileHash: request.fh,
            byteRanges,
            authorAddress: derived,
            authorPublicKey: request.pk,
            timestamp: request.ts,
          })
        )
      ),
      new Uint8Array(base58Decode(request.sig)),
      new Uint8Array(base58Decode(request.pk))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumChatResourceFind(
  groupId: number,
  wire: Extract<ReticulumChatWire, { k: 'rf' }>,
  now = Date.now()
): boolean {
  return getReticulumChatResourceFindRejectReason(groupId, wire, now) === null;
}

export function getReticulumChatResourceFindRejectReason(
  groupId: number,
  wire: Extract<ReticulumChatWire, { k: 'rf' }>,
  now = Date.now()
): string | null {
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return 'invalid_group';
    if (typeof wire.q !== 'string' || !/^[0-9a-f]{8,64}$/i.test(wire.q)) return 'invalid_request_id';
    if (typeof wire.f !== 'string' || !/^[0-9a-f]{64}$/i.test(wire.f)) return 'invalid_file_hash';
    if (!Number.isInteger(wire.s) || wire.s <= 0) return 'invalid_size';
    const hop = wire.h == null ? 0 : wire.h;
    const maxHops = wire.m == null ? RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS : wire.m;
    if (!Number.isInteger(hop) || hop < 0) return 'invalid_hop';
    if (!Number.isInteger(maxHops) || maxHops < 0 || maxHops > RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS) return 'invalid_max_hops';
    if (!Number.isFinite(wire.x) || wire.x <= now) return 'expired';
    if (wire.x - now > RETICULUM_CHAT_RESOURCE_FIND_TTL_MS + RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return 'expires_too_far';
    if (typeof wire.p !== 'string' || !wire.p) return 'missing_public_key';
    if (typeof wire.z !== 'string' || !wire.z) return 'missing_signature';
    if (!Number.isFinite(wire.n)) return 'invalid_timestamp';
    if (wire.n - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return 'timestamp_in_future';
    if (now - wire.n > RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return 'timestamp_too_old';
    const authorAddress = deriveAddressFromPublicKey(wire.p);
    if (!authorAddress) return 'invalid_public_key';
    const ok = nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumChatResourceFindSignedFields({
            groupId,
            requestId: wire.q.toLowerCase(),
            fileHash: wire.f.toLowerCase(),
            sizeBytes: wire.s,
            maxHops,
            expiresAt: wire.x,
            authorAddress,
            authorPublicKey: wire.p,
            timestamp: wire.n,
          })
        )
      ),
      new Uint8Array(base58Decode(wire.z)),
      new Uint8Array(base58Decode(wire.p))
    );
    return ok ? null : 'bad_signature';
  } catch {
    return 'exception';
  }
}

export function verifyReticulumChatGroupKeyDigest(
  groupId: number,
  wire: ReticulumChatGroupKeyDigestWire,
  now = Date.now()
): boolean {
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    if (!Number.isInteger(wire.e) || wire.e <= 0) return false;
    if (!isReticulumGroupKeyId(wire.id)) return false;
    if (typeof wire.p !== 'string' || !wire.p) return false;
    if (typeof wire.s !== 'string' || !wire.s) return false;
    if (!Number.isFinite(wire.ts)) return false;
    if (wire.ts - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
    if (now - wire.ts > RETICULUM_CHAT_MAX_AGE_MS) return false;
    const derived = deriveAddressFromPublicKey(wire.p);
    if (!derived) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumChatGroupKeyDigestSignedFields({
            groupId,
            epoch: wire.e,
            keyId: wire.id,
            authorAddress: derived,
            authorPublicKey: wire.p,
            timestamp: wire.ts,
          })
        )
      ),
      new Uint8Array(base58Decode(wire.s)),
      new Uint8Array(base58Decode(wire.p))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumChatGroupKeyRequest(
  groupId: number,
  wire: ReticulumChatGroupKeyRequestWire,
  now = Date.now()
): boolean {
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    if (!Number.isInteger(wire.e) || wire.e <= 0) return false;
    if (!isReticulumGroupKeyId(wire.id)) return false;
    if (!isReticulumGroupKeyRequestId(wire.r)) return false;
    if (typeof wire.p !== 'string' || !wire.p) return false;
    if (typeof wire.s !== 'string' || !wire.s) return false;
    if (!Number.isFinite(wire.ts)) return false;
    if (wire.ts - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
    if (now - wire.ts > RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return false;
    const derived = deriveAddressFromPublicKey(wire.p);
    if (!derived) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumChatGroupKeyRequestSignedFields({
            groupId,
            epoch: wire.e,
            keyId: wire.id,
            requestId: wire.r,
            authorAddress: derived,
            authorPublicKey: wire.p,
            timestamp: wire.ts,
          })
        )
      ),
      new Uint8Array(base58Decode(wire.s)),
      new Uint8Array(base58Decode(wire.p))
    );
  } catch {
    return false;
  }
}

export function verifyReticulumChatGroupKeyResponse(
  groupId: number,
  wire: ReticulumChatGroupKeyResponseWire,
  now = Date.now()
): boolean {
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    if (!Number.isInteger(wire.e) || wire.e <= 0) return false;
    if (!isReticulumGroupKeyId(wire.id)) return false;
    if (!isReticulumGroupKeyRequestId(wire.r)) return false;
    if (!reticulumGroupKeyBytesFromBase64(wire.kb)) return false;
    if (reticulumGroupKeyIdFromBase64(wire.kb) !== wire.id.toLowerCase()) return false;
    if (typeof wire.p !== 'string' || !wire.p) return false;
    if (typeof wire.s !== 'string' || !wire.s) return false;
    if (!Number.isFinite(wire.ts)) return false;
    if (wire.ts - now > RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return false;
    if (now - wire.ts > RETICULUM_CHAT_CONTROL_MAX_AGE_MS) return false;
    const derived = deriveAddressFromPublicKey(wire.p);
    if (!derived) return false;
    return nacl.sign.detached.verify(
      new Uint8Array(
        canonicalizeForSigning(
          buildReticulumChatGroupKeyResponseSignedFields({
            groupId,
            epoch: wire.e,
            keyId: wire.id,
            keyBytesBase64: wire.kb,
            requestId: wire.r,
            authorAddress: derived,
            authorPublicKey: wire.p,
            timestamp: wire.ts,
          })
        )
      ),
      new Uint8Array(base58Decode(wire.s)),
      new Uint8Array(base58Decode(wire.p))
    );
  } catch {
    return false;
  }
}

function defaultReticulumChatDbPath(): string {
  return path.join(app.getPath('appData'), 'qortal-shared', 'reticulum-chat.db');
}

function ownAddressMatches(addresses: Set<string>, address: string): boolean {
  return addresses.has(String(address || '').trim());
}

function reticulumDmEventTypeToWire(eventType: ReticulumDmEventType): ReticulumDmEventTypeWire {
  switch (eventType) {
    case 'message':
      return 'm';
    case 'edit':
      return 'e';
    case 'delete':
      return 'd';
    case 'reaction_add':
      return 'ra';
    case 'reaction_remove':
      return 'rr';
    default:
      return eventType;
  }
}

function reticulumDmEventTypeFromWire(eventType: unknown): ReticulumDmEventType {
  switch (eventType) {
    case 'm':
      return 'message';
    case 'e':
      return 'edit';
    case 'd':
      return 'delete';
    case 'ra':
      return 'reaction_add';
    case 'rr':
      return 'reaction_remove';
    default:
      return eventType as ReticulumDmEventType;
  }
}

function reticulumDmEventForWire(event: ReticulumDmEvent): ReticulumDmEventWire {
  const tuple: ReticulumDmEventCompactTupleWire = [
    'v2',
    event.eventId,
    event.recipientAddress,
    event.senderPublicKey,
    event.senderSeq,
    event.timestamp,
    reticulumDmEventTypeToWire(event.eventType),
    event.payload,
    event.signature,
  ];
  if (event.targetEventId || event.replyToEventId) {
    tuple[9] = event.targetEventId || '';
    tuple[10] = event.replyToEventId || '';
  }
  return tuple;
}

function reticulumDmEventFromWire(wire: unknown): ReticulumDmEvent | null {
  if (Array.isArray(wire)) {
    if (wire[0] === 'v2') {
      const [
        _version,
        eventId,
        recipientAddress,
        senderPublicKey,
        senderSeq,
        timestamp,
        eventType,
        payload,
        signature,
        targetEventId,
        replyToEventId,
      ] = wire as ReticulumDmEventCompactTupleWire;
      const normalizedPayload = String(payload ?? '');
      const normalizedSenderPublicKey = String(senderPublicKey || '');
      const senderAddress = deriveReticulumControlAuthor(normalizedSenderPublicKey);
      const normalizedRecipientAddress = String(recipientAddress || '');
      return {
        eventId: String(eventId || ''),
        conversationId: reticulumDmConversationId(senderAddress, normalizedRecipientAddress),
        senderAddress,
        recipientAddress: normalizedRecipientAddress,
        senderPublicKey: normalizedSenderPublicKey,
        senderSeq: Number(senderSeq || 0),
        timestamp: Number(timestamp || 0),
        eventType: reticulumDmEventTypeFromWire(eventType),
        ...(typeof targetEventId === 'string' && targetEventId ? { targetEventId } : {}),
        ...(typeof replyToEventId === 'string' && replyToEventId ? { replyToEventId } : {}),
        payload: normalizedPayload,
        payloadHash: hashReticulumChatPayload(normalizedPayload),
        signature: String(signature || ''),
      };
    }
    const [
      eventId,
      senderAddress,
      recipientAddress,
      senderPublicKey,
      senderSeq,
      timestamp,
      eventType,
      payload,
      signature,
      targetEventId,
      replyToEventId,
    ] = wire as ReticulumDmEventTupleWire;
    const normalizedPayload = String(payload ?? '');
    return {
      eventId: String(eventId || ''),
      conversationId: reticulumDmConversationId(String(senderAddress || ''), String(recipientAddress || '')),
      senderAddress: String(senderAddress || ''),
      recipientAddress: String(recipientAddress || ''),
      senderPublicKey: String(senderPublicKey || ''),
      senderSeq: Number(senderSeq || 0),
      timestamp: Number(timestamp || 0),
      eventType: reticulumDmEventTypeFromWire(eventType),
      ...(typeof targetEventId === 'string' && targetEventId ? { targetEventId } : {}),
      ...(typeof replyToEventId === 'string' && replyToEventId ? { replyToEventId } : {}),
      payload: normalizedPayload,
      payloadHash: hashReticulumChatPayload(normalizedPayload),
      signature: String(signature || ''),
    };
  }
  if (!wire || typeof wire !== 'object') return null;
  const candidate = wire as Partial<ReticulumDmEventObjectWire & ReticulumDmEvent>;
  if (
    typeof candidate.id === 'string' ||
    typeof candidate.s === 'string' ||
    typeof candidate.r === 'string' ||
    typeof candidate.p === 'string'
  ) {
    const senderAddress = String(candidate.s || '');
    const recipientAddress = String(candidate.r || '');
    const payload = String(candidate.l ?? '');
    const event: ReticulumDmEvent = {
      eventId: String(candidate.id || ''),
      conversationId: String(candidate.c || reticulumDmConversationId(senderAddress, recipientAddress)),
      senderAddress,
      recipientAddress,
      senderPublicKey: String(candidate.p || ''),
      senderSeq: Number(candidate.q || 0),
      timestamp: Number(candidate.n || 0),
      eventType: reticulumDmEventTypeFromWire(candidate.k),
      ...(typeof candidate.x === 'string' ? { targetEventId: candidate.x } : {}),
      ...(typeof candidate.y === 'string' ? { replyToEventId: candidate.y } : {}),
      payload,
      payloadHash: String(candidate.h || hashReticulumChatPayload(payload)),
      signature: String(candidate.z || ''),
    };
    return event;
  }
  const full = candidate as Partial<ReticulumDmEvent>;
  if (
    typeof full.eventId === 'string' &&
    typeof full.conversationId === 'string' &&
    typeof full.senderAddress === 'string' &&
    typeof full.recipientAddress === 'string'
  ) {
    return full as ReticulumDmEvent;
  }
  return null;
}

function serializeReticulumDmPageResource(page: ReticulumDmPageResource): string {
  return JSON.stringify(page);
}

function hashReticulumDmPageResource(blob: string): string {
  return nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
}

export class ReticulumChatManager extends EventEmitter {
  private readonly db: ReticulumChatDatabase;
  private readonly now: () => number;
  private readonly dbPath: string;
  private readonly localNotifyDir: string;
  private readonly localNotifyDebounceMs: number;
  private isClosed = false;
  private signLocalFields?: (
    fields: Record<string, unknown>
  ) => Promise<ReticulumChatLocalSignature | null>;
  private validateGroupMember?: (groupId: number, address: string) => Promise<boolean | null>;
  private validateGroupAdmin?: (groupId: number, address: string) => Promise<boolean>;
  private getVerifiedReticulumPeers?: () => ReticulumChatVerifiedReticulumPeer[];
  private hasGoodOverlayHealth?: () => boolean;
  private resourceStore: ReticulumResourceStore | null;
  private bridge: ReticulumBridge | null;
  private resourceTransfer: ReticulumResourceTransferManager<ReticulumChatResourceRequestWire> | null = null;
  private directResourceTransfer: ReticulumResourceTransferManager<ReticulumDmResourceRequestWire> | null = null;
  private localGroupIds = new Set<number>();
  private localPrivateGroupIds = new Set<number>();
  private localGroupAdminIds = new Set<number>();
  private localGroupAddresses = new Map<number, string>();
  private localDmAddresses = new Set<string>();
  private subscribedGroups = new Set<number>();
  private peerSubscriptions = new Map<string, Map<number, number>>();
  private groupMemberValidationCache = new Map<string, { isMember: boolean; expiresAt: number }>();
  private groupAdminValidationCache = new Map<string, { isAdmin: boolean; expiresAt: number }>();
  private requestedEventPulls = new Map<string, number>();
  private pendingEventPulls = new Map<string, ReticulumChatPullQueueItem>();
  private outboundRelayCachedEventResources = new Map<
    string,
    { groupId: number; eventId: string; event: ReticulumChatEvent; expiresAt: number }
  >();
  private outboundRelayStoreEventResources = new Map<
    string,
    { groupId: number; eventId: string; expiresAt: number }
  >();
  private outboundEventPageResources = new Map<
    string,
    { groupId: number; channelId: string; pageHash: string; eventIds: Set<string>; expiresAt: number }
  >();
  private eventPullQueueTimer: ReturnType<typeof setTimeout> | null = null;
  private controlRetryQueue = new Map<string, ReticulumChatControlRetryItem>();
  private controlRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private controlRetryActive = false;
  private subscriptionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionFanoutQueue: ReticulumChatWire[] = [];
  private subscriptionFanoutQueuedKeys = new Set<string>();
  private subscriptionFanoutLastSentAt = new Map<string, number>();
  private subscriptionFanoutTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionFanoutSentInBatch = 0;
  private subscriptionDigestRefreshOffset = 0;
  private eventPullQueueActive = false;
  private recentGroupRepairRequests = new Map<string, number>();
  private recentMetadataRepairRequests = new Map<string, number>();
  private recentMetadataPagePushes = new Map<string, number>();
  private recentNewestPagePushes = new Map<string, number>();
  private recentAuthorGapRepairRequests = new Map<string, number>();
  private authorGapNoProgressSuppressions = new Map<string, number>();
  private historyPageNoProgressSuppressions = new Map<string, number>();
  private historyPageHashNoProgressSuppressions = new Map<string, number>();
  private resourceOffers = new Map<string, ReticulumChatEventOffer>();
  private eventPageOffers = new Map<string, ReticulumChatEventPageOffer>();
  private signedResourceAuthRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private signedResourceAuthRetryAttempts = new Map<string, number>();
  private directHistoryPageRequests = new Map<string, ReticulumChatEventPageOffer>();
  private directHistoryPageRequestKeys = new Map<string, string>();
  private directHistoryPageTransferKeys = new Map<string, string>();
  private directDmPageRequests = new Map<string, ReticulumDmPageOffer>();
  private eventSourcePeers = new Map<string, ReticulumChatEventSourcePeerRecord>();
  private lastTypingSentAt = new Map<string, number>();
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private observedDbEventIds = new Set<string>();
  private channelMetadataProjectionQueue: string[] = [];
  private channelMetadataProjectionQueuedIds = new Set<string>();
  private channelMetadataProjectionAttemptedIds = new Set<string>();
  private channelMetadataProjectionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private channelMetadataProjectionActive = false;
  private channelMetadataProjectionRepairGroups = new Set<number>();
  private activeDigestGroups = new Map<number, number>();
  private activeChannelSubscriptions = new Map<number, Set<string>>();
  private recentInboundControlWires = new Map<string, number>();
  private recentServedSyncRequests = new Map<string, number>();
  private recentRelayQueries = new Map<string, number>();
  private recentRelayDigestsServed = new Map<string, number>();
  private recentResourceDiscoveryRequests = new Map<string, number>();
  private recentGroupKeyDigestsSent = new Map<string, number>();
  private recentGroupKeyRequests = new Map<string, number>();
  private groupKeyCreateInFlight = new Map<number, Promise<ReticulumChatGroupKey | null>>();
  private lastRelayNoPeersLogAt = 0;
  private peerProtocolViolations = new Map<string, ReticulumChatPeerViolationRecord>();
  private resourceFindRoutes = new Map<string, ReticulumChatResourceFindRoute>();
  private localResourceFindRequests = new Map<string, number>();
  private directResourceFindRoutes = new Map<string, ReticulumDmResourceFindRoute>();
  private localDirectResourceFindRequests = new Map<string, number>();
  private recentDirectResourceDiscoveryRequests = new Map<string, number>();
  private learnedResourceIdentityPublicKeys = new Map<string, string>();
  private identityRequestRoutes = new Map<string, ReticulumChatIdentityRoute>();
  private localIdentityRequests = new Map<string, ReticulumChatIdentityWaiter>();
  private groupInterestRoutes = new Map<string, ReticulumChatGroupInterestRoute>();
  private forwardedGroupSubKeys = new Map<string, number>();
  private forwardedGroupControlKeys = new Map<string, number>();
  private dmDigestTimer: ReturnType<typeof setInterval> | null = null;
  private pendingInitialDmDiscovery = false;
  private recentDmRequests = new Map<string, number>();
  private recentDmDiscoveryKeys = new Map<string, number>();
  private dmProbeRoutes = new Map<string, ReticulumDmProbeRoute>();
  private dmNotifyRoutes = new Map<string, ReticulumDmNotifyRoute>();
  private dmConversationRouteIds = new Map<string, { requestId: string; expiresAt: number }>();
  private eventRelayRoutes = new Map<string, ReticulumChatEventRelayRoute>();
  private localNotifyWatcher: fs.FSWatcher | null = null;
  private localNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  private localNotifyScanInterval: ReturnType<typeof setInterval> | null = null;
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
    this.signLocalFields = options.signLocalFields;
    this.validateGroupMember = options.validateGroupMember;
    this.validateGroupAdmin = options.validateGroupAdmin;
    this.getVerifiedReticulumPeers = options.getVerifiedReticulumPeers;
    this.hasGoodOverlayHealth = options.hasGoodOverlayHealth;
    this.resourceStore = options.resourceStore ?? null;
    this.bridge = options.bridge ?? null;
    this.db = new ReticulumChatDatabase(this.dbPath);
    this.resourceTransfer = this.createResourceTransfer();
    this.directResourceTransfer = this.createDirectResourceTransfer();
    fs.mkdirSync(this.localNotifyDir, { recursive: true });
    this.attachBridge(this.bridge);
    this.restorePersistedGroupSubscriptions();
  }

  setBridge(bridge: ReticulumBridge | null): void {
    if (this.bridge === bridge) return;
    this.detachBridge();
    this.bridge = bridge;
    this.resourceTransfer?.setBridge(bridge);
    this.directResourceTransfer?.setBridge(bridge);
    this.attachBridge(bridge);
  }

  private createResourceTransfer(): ReticulumResourceTransferManager<ReticulumChatResourceRequestWire> | null {
    if (!this.resourceStore) return null;
    return new ReticulumResourceTransferManager<ReticulumChatResourceRequestWire>({
      bridge: this.bridge,
      resourceStore: this.resourceStore,
      now: this.now,
      loggerPrefix: 'ReticulumChatResourceTransfer',
      resourceType: 'reticulum_group_resource',
      rangeResourceType: 'reticulum_group_resource_range',
      authMessageType: 'RETICULUM_GROUP_RESOURCE_AUTH',
      contextMetadataKey: 'groupId',
      buildRequestPayloads: async (state, ranges) =>
        this.buildSignedResourceRequestBatches(
          state.contextId,
          state.manifest,
          state.eventId,
          ranges
        ),
      canServeRequest: async (groupId, request, manifest) => {
        const fileHash = request.fileHash.toLowerCase();
        if (manifest.fileHash.toLowerCase() !== fileHash) {
          loggerWarn(
            `[ReticulumChat] Refusing resource ${fileHash}: manifest hash mismatch`
          );
          return false;
        }
        if (!this.resourceManifestBelongsToGroup(manifest, groupId)) {
          loggerWarn(
            `[ReticulumChat] Refusing resource ${fileHash}: resource is not for group=${groupId}`
          );
          return false;
        }
        if (request.eventId) {
          const event = this.db.getEvent(request.eventId);
          if (!event || event.groupId !== groupId) {
            loggerWarn(
              `[ReticulumChat] Refusing resource ${fileHash}: event ${request.eventId} is not for group=${groupId}`
            );
            return false;
          }
          if (
            request.requesterAddress &&
            !(await this.canRequesterReadEvent(event, request.requesterAddress))
          ) {
            loggerWarn(
              `[ReticulumChat] Refusing resource ${fileHash}: requester cannot read channel=${normalizeReticulumChatChannelId(event.channelId)}`
            );
            return false;
          }
        }
        if (!request.requesterAddress) {
          loggerWarn(
            `[ReticulumChat] Refusing resource ${fileHash}: signed requester address missing`
          );
          return false;
        }
        const requesterIsMember = await this.isValidatedRequesterGroupMember(
          groupId,
          request.requesterAddress,
          'resource'
        );
        if (requesterIsMember !== true) {
          loggerWarn(
            `[ReticulumChat] Refusing resource ${fileHash}: ${requesterIsMember === null ? 'requester membership validation unavailable' : 'requester is not a group member'}`
          );
          return false;
        }
        loggerLog(
          `[ReticulumChat] cached_resource_serve_allowed group=${groupId} file=${fileHash.slice(0, 12)} requester=${request.requesterAddress}`
        );
        return true;
      },
      parseAuthRequest: (groupId, auth, peerHash) =>
        this.resourceAuthToTransferRequest(groupId, auth, peerHash),
      resolvePeerIdentity: (peerHash, reason) =>
        this.ensureResourcePeerIdentity(peerHash, reason),
      onProgress: (progress) => this.emitResourceTransferProgress(progress),
    });
  }

  private createDirectResourceTransfer(): ReticulumResourceTransferManager<ReticulumDmResourceRequestWire> | null {
    if (!this.resourceStore) return null;
    return new ReticulumResourceTransferManager<ReticulumDmResourceRequestWire>({
      bridge: this.bridge,
      resourceStore: this.resourceStore,
      now: this.now,
      loggerPrefix: 'ReticulumDmResourceTransfer',
      resourceType: 'reticulum_resource_dm',
      rangeResourceType: 'reticulum_resource_dm_range',
      authMessageType: 'RETICULUM_DM_RESOURCE_AUTH',
      buildRequestPayloads: async (state, ranges) =>
        this.buildSignedDirectResourceRequestBatches(
          state.manifest,
          state.eventId,
          ranges,
          state.featureData
        ),
      canServeRequest: async (_contextId, request, manifest) => {
        const fileHash = request.fileHash.toLowerCase();
        if (manifest.fileHash.toLowerCase() !== fileHash) {
          loggerWarn(
            `[ReticulumChat] Refusing DM resource ${fileHash}: manifest hash mismatch`
          );
          return false;
        }
        const conversationId = normalizeReticulumDmConversationId(request.conversationId);
        if (!conversationId || !this.resourceManifestBelongsToDirectConversation(manifest, conversationId)) {
          loggerWarn(
            `[ReticulumChat] Refusing DM resource ${fileHash}: resource is not for conversation=${conversationId || 'unknown'}`
          );
          return false;
        }
        if (!request.requesterAddress || !request.peerAddress) {
          loggerWarn(
            `[ReticulumChat] Refusing DM resource ${fileHash}: signed requester or peer address missing`
          );
          return false;
        }
        if (reticulumDmConversationId(request.requesterAddress, request.peerAddress) !== conversationId) {
          loggerWarn(
            `[ReticulumChat] Refusing DM resource ${fileHash}: requester is not in conversation=${conversationId.slice(0, 16)}`
          );
          return false;
        }
        if (request.eventId) {
          const event = this.db.getDirectEvent(request.eventId);
          if (!event || event.conversationId !== conversationId) {
            loggerWarn(
              `[ReticulumChat] Refusing DM resource ${fileHash}: event ${request.eventId} is not for conversation=${conversationId.slice(0, 16)}`
            );
            return false;
          }
        }
        loggerLog(
          `[ReticulumChat] dm_resource_serve_allowed conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} requester=${request.requesterAddress}`
        );
        return true;
      },
      parseAuthRequest: (_contextId, auth, peerHash) =>
        this.directResourceAuthToTransferRequest(auth, peerHash),
      resolvePeerIdentity: (peerHash, reason) =>
        this.ensureResourcePeerIdentity(peerHash, reason),
      onProgress: (progress) => this.emitDirectResourceTransferProgress(progress),
    });
  }

  private resourceAuthToTransferRequest(
    groupId: number,
    auth: Record<string, unknown>,
    peerHash: string
  ): ReticulumResourceTransferRequest | null {
    const candidate: ReticulumChatResourceRequestWire = {
      fh:
        typeof auth.fh === 'string'
          ? auth.fh
          : typeof auth.fileHash === 'string'
            ? auth.fileHash
            : '',
      b: Array.isArray(auth.b)
        ? auth.b
        : Array.isArray(auth.byteRanges)
          ? normalizeByteRanges(auth.byteRanges as Array<[number, number]>)
          : [],
      pk: typeof auth.pk === 'string' ? auth.pk : '',
      ts: Number(auth.ts),
      sig: typeof auth.sig === 'string' ? auth.sig : '',
      ...(typeof auth.eid === 'string' && auth.eid ? { eid: auth.eid } : {}),
      ...(typeof auth.rid === 'string' && auth.rid ? { rid: auth.rid } : {}),
    };
    if (!Number.isInteger(groupId) || groupId <= 0) return null;
    if (!verifyReticulumChatResourceRequest(groupId, candidate, this.now())) return null;
    const ranges = byteRangesFromWire(candidate.b ?? []) ?? [];
    if (ranges.length === 0) return null;
    return {
      eventId: candidate.eid,
      fileHash: candidate.fh,
      ranges,
      requesterAddress: deriveAddressFromPublicKey(candidate.pk),
      requesterPeerHash:
        this.normalizeResourcePeerHash(peerHash) ??
        this.normalizeResourcePeerHash(auth.requesterPeerHash),
    };
  }

  private directResourceAuthToTransferRequest(
    auth: Record<string, unknown>,
    peerHash: string
  ): ReticulumResourceTransferRequest | null {
    const candidate: ReticulumDmResourceRequestWire = {
      c: typeof auth.c === 'string' ? auth.c : '',
      b: typeof auth.b === 'string' ? auth.b : '',
      fh:
        typeof auth.fh === 'string'
          ? auth.fh
          : typeof auth.fileHash === 'string'
            ? auth.fileHash
            : '',
      r: Array.isArray(auth.r)
        ? (auth.r as Array<[number, number]>)
        : Array.isArray(auth.byteRanges)
          ? normalizeByteRanges(auth.byteRanges as Array<[number, number]>)
          : [],
      ...(typeof auth.q === 'string' && auth.q ? { q: auth.q } : {}),
      rp:
        typeof auth.rp === 'string'
          ? auth.rp
          : typeof auth.requesterPeerHash === 'string'
            ? auth.requesterPeerHash
            : '',
      p: typeof auth.p === 'string' ? auth.p : '',
      n: Number(auth.n),
      z: typeof auth.z === 'string' ? auth.z : '',
    };
    if (!verifyReticulumDmResourceRequest(candidate, this.now())) return null;
    const ranges = byteRangesFromWire(candidate.r ?? []) ?? [];
    if (ranges.length === 0) return null;
    const requesterAddress = deriveAddressFromPublicKey(candidate.p);
    const conversationId = normalizeReticulumDmConversationId(candidate.c);
    return {
      eventId: typeof auth.eventId === 'string' && auth.eventId ? auth.eventId : undefined,
      fileHash: candidate.fh,
      ranges,
      requesterAddress,
      requesterPeerHash:
        this.normalizeResourcePeerHash(peerHash) ??
        this.normalizeResourcePeerHash(candidate.rp) ??
        this.normalizeResourcePeerHash(auth.requesterPeerHash),
      conversationId,
      peerAddress: candidate.b,
      relayRequestId: candidate.q,
    };
  }

  private emitResourceTransferProgress(progress: ReticulumResourceTransferProgress): void {
    this.emit('resource', {
      groupId: progress.contextId,
      eventId: progress.eventId,
      fileHash: progress.fileHash,
      bytesTransferred: progress.bytesTransferred,
      totalBytes: progress.totalBytes,
      progress: progress.progress,
      complete: progress.complete,
      failed: progress.failed,
      canceled: progress.canceled,
    });
  }

  private emitDirectResourceTransferProgress(progress: ReticulumResourceTransferProgress): void {
    this.emit('resource', {
      direct: true,
      eventId: progress.eventId,
      fileHash: progress.fileHash,
      bytesTransferred: progress.bytesTransferred,
      totalBytes: progress.totalBytes,
      progress: progress.progress,
      complete: progress.complete,
      failed: progress.failed,
      canceled: progress.canceled,
    });
  }

  setRuntimeCallbacks(
    options: Pick<
      ReticulumChatManagerOptions,
      | 'signLocalFields'
      | 'validateGroupMember'
      | 'validateGroupAdmin'
      | 'getVerifiedReticulumPeers'
      | 'hasGoodOverlayHealth'
      | 'resourceStore'
    >
  ): void {
    this.signLocalFields = options.signLocalFields;
    this.validateGroupMember = options.validateGroupMember;
    this.validateGroupAdmin = options.validateGroupAdmin;
    this.getVerifiedReticulumPeers = options.getVerifiedReticulumPeers;
    this.hasGoodOverlayHealth = options.hasGoodOverlayHealth;
    if ('resourceStore' in options) {
      this.resourceStore = options.resourceStore ?? null;
      this.resourceTransfer?.close();
      this.directResourceTransfer?.close();
      this.resourceTransfer = this.createResourceTransfer();
      this.directResourceTransfer = this.createDirectResourceTransfer();
    }
    this.groupMemberValidationCache.clear();
    this.groupAdminValidationCache.clear();
    if (this.signLocalFields) this.retryPendingSignedResourceAuthOffers();
  }

  close(): void {
    this.isClosed = true;
    this.stopDmDigestTimer();
    this.detachBridge();
    this.stopLocalNotificationWatcher();
    this.stopSubscriptionRefreshTimer();
    this.clearSubscriptionFanoutQueue();
    if (this.eventPullQueueTimer) {
      clearTimeout(this.eventPullQueueTimer);
      this.eventPullQueueTimer = null;
    }
    if (this.controlRetryTimer) {
      clearTimeout(this.controlRetryTimer);
      this.controlRetryTimer = null;
    }
    this.controlRetryQueue.clear();
    this.resourceFindRoutes.clear();
    this.localResourceFindRequests.clear();
    this.learnedResourceIdentityPublicKeys.clear();
    this.identityRequestRoutes.clear();
    for (const waiter of this.localIdentityRequests.values()) {
      clearTimeout(waiter.timeout);
      waiter.resolve(null);
    }
    this.localIdentityRequests.clear();
    this.recentResourceDiscoveryRequests.clear();
    this.directResourceFindRoutes.clear();
    this.localDirectResourceFindRequests.clear();
    this.recentDirectResourceDiscoveryRequests.clear();
    this.groupInterestRoutes.clear();
    this.forwardedGroupSubKeys.clear();
    this.forwardedGroupControlKeys.clear();
    this.recentDmRequests.clear();
    this.recentDmDiscoveryKeys.clear();
    this.dmProbeRoutes.clear();
    this.dmNotifyRoutes.clear();
    this.dmConversationRouteIds.clear();
    this.directDmPageRequests.clear();
    this.eventRelayRoutes.clear();
    this.resourceTransfer?.close();
    this.directResourceTransfer?.close();
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
    for (const timer of this.signedResourceAuthRetryTimers.values()) clearTimeout(timer);
    this.signedResourceAuthRetryTimers.clear();
    this.signedResourceAuthRetryAttempts.clear();
    for (const timer of this.channelMetadataProjectionRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.channelMetadataProjectionRetryTimers.clear();
    this.channelMetadataProjectionQueue = [];
    this.channelMetadataProjectionQueuedIds.clear();
    this.channelMetadataProjectionAttemptedIds.clear();
    this.channelMetadataProjectionRepairGroups.clear();
    this.db.close();
  }

  private normalizeLocalGroupMemberships(
    memberships: ReticulumChatLocalGroupMembership[]
  ): Array<{ groupId: number; isPrivate: boolean; isAdmin: boolean; localAddress?: string }> {
    const byGroupId = new Map<
      number,
      { isPrivate: boolean; isAdmin: boolean; localAddress?: string }
    >();
    for (const membership of memberships) {
      let groupId: number;
      let isPrivate = false;
      let isAdmin = false;
      let localAddress = '';
      if (typeof membership === 'number') {
        groupId = membership;
      } else if (membership && typeof membership === 'object') {
        groupId = Number(
          membership.groupId ??
          membership.groupid ??
          membership.group_id ??
          membership.id
        );
        if (membership.isPrivate === true || membership.isOpen === false) {
          isPrivate = true;
        }
        isAdmin = membership.isAdmin === true;
        localAddress =
          typeof membership.localAddress === 'string'
            ? membership.localAddress.trim()
            : typeof membership.address === 'string'
              ? membership.address.trim()
              : '';
      } else {
        continue;
      }
      if (!Number.isInteger(groupId) || groupId <= 0) continue;
      const existing = byGroupId.get(groupId);
      byGroupId.set(groupId, {
        isPrivate: existing?.isPrivate === true || isPrivate,
        isAdmin: existing?.isAdmin === true || isAdmin,
        localAddress: existing?.localAddress || localAddress || undefined,
      });
    }
    return [...byGroupId.entries()].map(([groupId, membership]) => ({
      groupId,
      ...membership,
    }));
  }

  private isLocalPrivateGroup(groupId: number): boolean {
    return this.localPrivateGroupIds.has(groupId);
  }

  setLocalGroupMemberships(memberships: ReticulumChatLocalGroupMembership[]): void {
    const normalizedMemberships = this.normalizeLocalGroupMemberships(memberships);
    const nextGroupIds = normalizedMemberships.map(({ groupId }) => groupId);
    this.localPrivateGroupIds = new Set(
      normalizedMemberships
        .filter(({ isPrivate }) => isPrivate)
        .map(({ groupId }) => groupId)
    );
    this.localGroupAdminIds = new Set(
      normalizedMemberships
        .filter(({ isAdmin }) => isAdmin)
        .map(({ groupId }) => groupId)
    );
    this.localGroupAddresses = new Map(
      normalizedMemberships
        .filter(({ localAddress }) => typeof localAddress === 'string' && localAddress.length > 0)
        .map(({ groupId, localAddress }) => [groupId, localAddress as string])
    );
    this.localGroupIds = new Set(nextGroupIds);
    for (const groupId of this.getSubscriptions()) {
      if (this.localGroupIds.has(groupId)) continue;
      this.subscribedGroups.delete(groupId);
      this.activeChannelSubscriptions.delete(groupId);
      this.removeQueuedSubscriptionFanouts(groupId);
      void this.fanout({ t: 'RCHAT', k: 'unsub', g: groupId });
    }
    if (this.subscribedGroups.size === 0) {
      this.stopSubscriptionRefreshTimer();
      this.clearSubscriptionFanoutQueue();
    }
    for (const groupId of nextGroupIds) {
      this.queueChannelMetadataProjectionRepair(groupId);
      const [latestEvent] = this.db.getRecentEvents(groupId, 1, null);
      if (latestEvent) {
        this.emitSummaryChanged(groupId, latestEvent);
      }
      void this.ensureGroupKeyState(groupId);
    }
  }

  setLocalDmAddresses(addresses: string[]): void {
    this.localDmAddresses = new Set(
      (Array.isArray(addresses) ? addresses : [])
        .map((address) => String(address || '').trim())
        .filter(Boolean)
    );
    if (this.localDmAddresses.size > 0) {
      this.pendingInitialDmDiscovery = true;
      this.startDmDigestTimer();
      this.flushPendingDmDiscoveryIfHealthy('auth');
    } else {
      this.pendingInitialDmDiscovery = false;
      this.stopDmDigestTimer();
    }
  }

  notifyOverlayHealthChanged(isHealthy: boolean): void {
    if (!isHealthy) return;
    this.flushPendingDmDiscoveryIfHealthy('overlay-health');
  }

  getDirectHistory(myAddress: string, peerAddress: string, limit = 100): ReticulumDmEvent[] {
    const conversationId = reticulumDmConversationId(myAddress, peerAddress);
    return this.db.getDirectHistory(conversationId, limit);
  }

  getDirectSummaries(myAddress: string): ReticulumDmSummary[] {
    return this.db.getDirectSummaries(myAddress);
  }

  markDirectRead(myAddress: string, peerAddress: string, upToTimestamp: number): void {
    const conversationId = reticulumDmConversationId(myAddress, peerAddress);
    this.db.markDirectRead(conversationId, myAddress, upToTimestamp);
    this.emit('directSummaryChanged', { conversationId, peerAddress });
  }

  async publishDirectEvent(event: ReticulumDmEvent): Promise<ReticulumSendResult> {
    const now = this.now();
    if (
      !validateReticulumDmEventShape(event, now) ||
      !this.acceptsDirectConversation(event) ||
      !verifyReticulumDmEvent(event)
    ) {
      return { ok: false, reason: 'send-command-failed', error: 'Invalid direct event' };
    }
    if (!this.db.hasDirectEvent(event.eventId)) {
      this.acceptDirectEvent(event, true, { deliveryStatus: 'pending' });
    }
    const peers = this.getVerifiedReticulumPeers?.() ?? [];
    const recipientPeer = peers
      .filter((peer) => peer.address === event.recipientAddress)
      .sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0))[0];
    await this.announceDirectNotifyForEvent(
      event,
      recipientPeer?.destinationHash ? [recipientPeer.destinationHash] : [],
      recipientPeer?.destinationHash ? [recipientPeer.destinationHash] : []
    );
    return { ok: true };
  }

  getSubscriptions(): number[] {
    return [...this.subscribedGroups].sort((a, b) => a - b);
  }

  private restorePersistedGroupSubscriptions(): void {
    const groupIds = this.db.getKnownGroupIds();
    if (groupIds.length === 0) return;
    for (const groupId of groupIds) {
      this.localGroupIds.add(groupId);
      this.subscribedGroups.add(groupId);
      this.queueChannelMetadataProjectionRepair(groupId);
    }
    this.startLocalNotificationWatcher();
    this.startSubscriptionRefreshTimer();
    this.enqueueSubscriptionFanouts([this.buildHelloWire()]);
    this.refreshSubscriptions();
  }

  subscribeGroup(groupId: number): void {
    this.assertGroupId(groupId);
    const alreadySubscribed = this.ensureGroupSubscribed(groupId);
    this.queueChannelMetadataProjectionRepair(groupId);
    if (!alreadySubscribed) this.announceGroupSubscription(groupId);
  }

  private ensureGroupSubscribed(groupId: number): boolean {
    this.assertGroupId(groupId);
    const alreadySubscribed = this.subscribedGroups.has(groupId);
    if (!this.localGroupIds.has(groupId)) {
      loggerWarn(
        `[ReticulumChat] Subscribing group=${groupId} before membership sync completed; adding local group hint`
      );
      this.localGroupIds.add(groupId);
    }
    this.markGroupHistoryObserved(groupId);
    this.subscribedGroups.add(groupId);
    this.startLocalNotificationWatcher();
    this.startSubscriptionRefreshTimer();
    return alreadySubscribed;
  }

  reannounceSubscriptions(): void {
    if (this.subscribedGroups.size === 0) return;
    this.enqueueSubscriptionFanouts([this.buildHelloWire()]);
    this.refreshSubscriptions();
  }

  private announceGroupSubscription(groupId: number): void {
    void this.ensureGroupKeyState(groupId);
    this.enqueueSubscriptionFanouts([
      this.buildHelloWire(),
      { t: 'RCHAT', k: 'group_sub', groups: [groupId], mode: 'summary' },
      this.buildGroupDigestWire(groupId),
    ]);
  }

  private announceActiveGroupSubscription(groupId: number): void {
    if (!this.subscribedGroups.has(groupId) || !this.localGroupIds.has(groupId)) return;
    void this.ensureGroupKeyState(groupId);
    this.enqueueSubscriptionFanouts([
      { t: 'RCHAT', k: 'group_sub', groups: [groupId], mode: 'active' },
      this.buildGroupDigestWire(groupId, 0, RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP),
    ]);
  }

  unsubscribeGroup(groupId: number): void {
    this.assertGroupId(groupId);
    this.subscribedGroups.delete(groupId);
    this.activeChannelSubscriptions.delete(groupId);
    this.removeQueuedSubscriptionFanouts(groupId);
    if (this.subscribedGroups.size === 0) {
      this.stopLocalNotificationWatcher();
      this.stopSubscriptionRefreshTimer();
      this.clearSubscriptionFanoutQueue();
    }
    void this.fanout({ t: 'RCHAT', k: 'unsub', g: groupId });
  }

  subscribeChannel(groupId: number, channelId: string): void {
    this.assertGroupId(groupId);
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const channel = this.db.getChannel(groupId, normalizedChannelId);
    if (!channel || channel.archived) return;
    this.ensureGroupSubscribed(groupId);
    const activeChannels = this.activeChannelSubscriptions.get(groupId) ?? new Set<string>();
    const alreadyActive = activeChannels.has(normalizedChannelId);
    activeChannels.add(normalizedChannelId);
    this.activeChannelSubscriptions.set(groupId, activeChannels);
    if (!alreadyActive) this.announceActiveGroupSubscription(groupId);
  }

  unsubscribeChannel(groupId: number, channelId: string): void {
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const activeChannels = this.activeChannelSubscriptions.get(groupId);
    if (!activeChannels) return;
    activeChannels.delete(normalizedChannelId);
    if (activeChannels.size === 0) this.activeChannelSubscriptions.delete(groupId);
  }

  async publishEvent(event: ReticulumChatEvent): Promise<ReticulumSendResult> {
    if (!Number.isInteger(event?.groupId) || event.groupId <= 0) {
      return {
        ok: false,
        reason: 'send-command-failed',
        error: 'Cannot publish Reticulum chat event: invalid group id',
      };
    }
    const channelId = normalizeReticulumChatChannelId(event.channelId);
    if (!CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) {
      const channel = this.db.getChannel(event.groupId, channelId);
      if (!channel || channel.archived) {
        return {
          ok: false,
          reason: 'send-command-failed',
          error: 'Cannot publish Reticulum chat event to an archived or unknown channel',
        };
      }
      if (channel.writeMode === RETICULUM_CHAT_CHANNEL_WRITE_MODE_ADMINS) {
        const authorIsAdmin = await this.isValidatedGroupAdmin(
          event.groupId,
          typeof event?.authorAddress === 'string' ? event.authorAddress : ''
        );
        if (!authorIsAdmin) {
          return {
            ok: false,
            reason: 'send-command-failed',
            error: 'Cannot publish Reticulum chat event: channel is read-only for non-admins',
          };
        }
      }
    }
    const authorIsMember = await this.isValidatedGroupMember(
      event.groupId,
      typeof event?.authorAddress === 'string' ? event.authorAddress : ''
    );
    if (!authorIsMember) {
      return {
        ok: false,
        reason: 'send-command-failed',
        error: 'Cannot publish Reticulum chat event: author is not a current group member',
      };
    }
    this.localGroupIds.add(event.groupId);
    const accepted = this.acceptEvent(event, true);
    if (!accepted) {
      return { ok: false, reason: 'send-command-failed', error: 'Invalid event' };
    }
    const fanoutResult = await this.fanoutPublishedEvent(event, channelId);
    if (!fanoutResult.ok) {
      const failed = fanoutResult as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[ReticulumChat] Stored event ${event.eventId} locally, but live event delivery failed:`,
        failed.error ?? failed.reason
      );
    }
    void this.replicateEventToRelayCache(event);
    return { ok: true };
  }

  sendTyping(
    groupId: number,
    channelId: string,
    authorAddress: string,
    active: boolean
  ): void {
    if (isDisabledTyping) return;
    this.assertLocalGroupMember(groupId);
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const key = `${groupId}:${normalizedChannelId}:${authorAddress}`;
    const now = this.now();
    if (active && now - (this.lastTypingSentAt.get(key) ?? 0) < RETICULUM_CHAT_TYPING_REFRESH_MS) {
      return;
    }
    this.lastTypingSentAt.set(key, now);
    void this.fanout({
      t: 'RCHAT',
      k: 'typing',
      g: groupId,
      c: normalizedChannelId,
      a: authorAddress,
      ts: now,
      active,
    });
  }

  async requestResource(
    groupId: number,
    manifest: ReticulumResourceManifest,
    eventId?: string
  ): Promise<ReticulumSendResult> {
    this.assertGroupId(groupId);
    if (!this.resourceStore) {
      return { ok: false, reason: 'send-command-failed', error: 'Resource store unavailable' };
    }
    if (!this.resourceTransfer) {
      return { ok: false, reason: 'send-command-failed', error: 'Resource transfer unavailable' };
    }
    if (!this.isValidReticulumResourceManifest(manifest)) {
      return { ok: false, reason: 'send-command-failed', error: 'Invalid resource manifest' };
    }
    if (!this.resourceManifestBelongsToGroup(manifest, groupId)) {
      return { ok: false, reason: 'send-command-failed', error: 'Resource is not for this group' };
    }
    this.resourceStore.storeManifest(manifest);
    this.resourceStore.recordGroupReference({
      fileHash: manifest.fileHash,
      groupId,
      eventId,
      ownerId: manifest.ownerId,
      createdAt: manifest.createdAt,
    });
    const candidatePeers = this.getResourceRequestPeers(eventId);
    this.resourceTransfer.requestResource({
      contextId: groupId,
      manifest,
      eventId,
      candidatePeers,
    });
    void this.announceResourceDiscovery(groupId, manifest, candidatePeers, true);
    return { ok: true };
  }

  async requestDirectResource(
    myAddress: string,
    peerAddress: string,
    manifest: ReticulumResourceManifest,
    eventId?: string
  ): Promise<ReticulumSendResult> {
    const localAddress = typeof myAddress === 'string' ? myAddress.trim() : '';
    const remoteAddress = typeof peerAddress === 'string' ? peerAddress.trim() : '';
    if (!localAddress || !remoteAddress || localAddress === remoteAddress) {
      return { ok: false, reason: 'send-command-failed', error: 'Invalid DM participants' };
    }
    if (!this.resourceStore) {
      return { ok: false, reason: 'send-command-failed', error: 'Resource store unavailable' };
    }
    if (!this.directResourceTransfer) {
      return { ok: false, reason: 'send-command-failed', error: 'Direct resource transfer unavailable' };
    }
    if (!this.isValidReticulumResourceManifest(manifest)) {
      return { ok: false, reason: 'send-command-failed', error: 'Invalid resource manifest' };
    }
    const conversationId = reticulumDmConversationId(localAddress, remoteAddress);
    if (!this.resourceManifestBelongsToDirectConversation(manifest, conversationId)) {
      return { ok: false, reason: 'send-command-failed', error: 'Resource is not for this DM conversation' };
    }
    this.resourceStore.storeManifest(manifest);
    const candidatePeers = this.getDirectResourceRequestPeers(remoteAddress, eventId);
    this.directResourceTransfer.requestResource({
      contextId: RETICULUM_DM_RESOURCE_CONTEXT_ID,
      manifest,
      eventId,
      candidatePeers: [],
      featureData: {
        conversationId,
        requesterAddress: localAddress,
        peerAddress: remoteAddress,
      },
    });
    void this.announceDirectResourceDiscovery(
      conversationId,
      remoteAddress,
      manifest,
      candidatePeers,
      true
    );
    return { ok: true };
  }

  cancelResource(fileHash: string): boolean {
    const groupCanceled = this.resourceTransfer?.cancelResource(fileHash) ?? false;
    const directCanceled = this.directResourceTransfer?.cancelResource(fileHash) ?? false;
    return groupCanceled || directCanceled;
  }

  getResourceDownloadStatus(fileHash: string) {
    const groupStatus = this.resourceTransfer?.getDownloadStatus(fileHash) ?? null;
    const directStatus = this.directResourceTransfer?.getDownloadStatus(fileHash) ?? null;
    if (directStatus?.active) return directStatus;
    if (groupStatus?.active) return groupStatus;
    return directStatus ?? groupStatus ?? null;
  }

  getHistory(
    groupId: number,
    channelIdOrLimit: string | number = RETICULUM_CHAT_DEFAULT_CHANNEL_ID,
    limitMaybe = 100
  ): ReticulumChatEvent[] {
    this.assertGroupId(groupId);
    const channelId =
      typeof channelIdOrLimit === 'string'
        ? channelIdOrLimit
        : null;
    const limit = typeof channelIdOrLimit === 'number' ? channelIdOrLimit : limitMaybe;
    return this.db.getRecentEvents(
      groupId,
      Math.max(1, Math.min(500, limit)),
      channelId
    );
  }

  getMessageHistory(
    groupId: number,
    channelIdOrLimit: string | number = RETICULUM_CHAT_DEFAULT_CHANNEL_ID,
    limitMaybe = 100
  ): ReticulumChatEvent[] {
    this.assertGroupId(groupId);
    const channelId =
      typeof channelIdOrLimit === 'string'
        ? channelIdOrLimit
        : null;
    const limit = typeof channelIdOrLimit === 'number' ? channelIdOrLimit : limitMaybe;
    return this.db.getRecentMessageEvents(
      groupId,
      Math.max(1, Math.min(500, limit)),
      channelId
    );
  }

  getChannelMetadataHistory(groupId: number, limit = 200): ReticulumChatEvent[] {
    this.assertGroupId(groupId);
    return this.db.getChannelMetadataEvents(groupId, Math.max(1, Math.min(500, limit)));
  }

  getSyncState(groupId: number): Record<string, number> {
    this.assertGroupId(groupId);
    return this.db.getSyncState(groupId);
  }

  getChatSummaries(myAddress = '', onlineSince = 0): ReticulumGroupChatSummary[] {
    return this.db.getChatSummaries(myAddress, onlineSince);
  }

  searchEvents(
    query: string,
    options: { groupIds?: number[]; channelIds?: string[]; limit?: number } = {}
  ): ReticulumChatSearchResult[] {
    return this.db.searchEvents(query, options);
  }

  indexSearchText(eventId: string, text: string): boolean {
    return this.db.indexSearchText(eventId, text);
  }

  deleteSearchText(eventId: string): boolean {
    return this.db.deleteSearchText(eventId);
  }

  replaceMentionsForEvent(
    eventId: string,
    mentionedAddresses: string[]
  ): boolean {
    const event = this.db.getEvent(eventId);
    const replaced = this.db.replaceMentionsForEvent(eventId, mentionedAddresses);
    if (replaced && event) this.emitSummaryChanged(event.groupId, event);
    return replaced;
  }

  deleteMentionsForEvent(eventId: string): boolean {
    const event = this.db.getEvent(eventId);
    const deleted = this.db.deleteMentionsForEvent(eventId);
    if (deleted && event) this.emitSummaryChanged(event.groupId, event);
    return deleted;
  }

  markRead(
    groupId: number,
    channelId: string,
    upToTimestamp: number,
    myAddress = ''
  ): void {
    this.assertGroupId(groupId);
    this.db.markRead(groupId, channelId, upToTimestamp, myAddress);
    this.emitSummaryChanged(groupId);
  }

  private peerKey(peerPresenceHash: string, senderDestinationHash = ''): string {
    return (peerPresenceHash || senderDestinationHash).trim().toLowerCase();
  }

  private localPeerHash(): string | undefined {
    return normalizePeerHashFromWire(this.bridge?.getLocalDestinationHash?.());
  }

  private async localReticulumResourceIdentity(): Promise<{
    destinationHash?: string;
    identityPublicKeyBase64?: string;
  }> {
    const destinationHash = this.localPeerHash();
    let identityPublicKeyBase64: string | undefined;
    try {
      identityPublicKeyBase64 = normalizeReticulumIdentityPublicKeyBase64(
        await this.bridge?.getLocalIdentityPublicKeyBase64?.()
      );
    } catch {
      identityPublicKeyBase64 = undefined;
    }
    return {
      ...(destinationHash ? { destinationHash } : {}),
      ...(identityPublicKeyBase64 ? { identityPublicKeyBase64 } : {}),
    };
  }

  private routePeerHash(value: unknown): string | undefined {
    return normalizeRoutePeerHash(value);
  }

  private compactRoutePeerHash(peerHash: string): string {
    return compactPeerHashForWire(peerHash);
  }

  private groupInterestRouteKey(groupId: number, originPeerHash: string): string {
    return `${groupId}:${originPeerHash.trim().toLowerCase()}`;
  }

  private groupControlRouteKey(
    kind: string,
    groupId: number,
    originPeerHash: string,
    payloadKey: string
  ): string {
    return `${kind}:${groupId}:${originPeerHash.trim().toLowerCase()}:${payloadKey}`;
  }

  private normalizeGroupControlRequestId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    return /^[0-9a-f]{8,64}$/.test(normalized) ? normalized : undefined;
  }

  private groupControlRequestId(
    kind: string,
    groupId: number,
    originPeerHash: string,
    payloadKey: string
  ): string {
    return nodeCrypto
      .createHash('sha256')
      .update(`${kind}:${groupId}:${originPeerHash.trim().toLowerCase()}:${payloadKey}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
  }

  private eventRelayRequestId(
    groupId: number,
    eventId: string,
    originPeerHash: string
  ): string {
    return nodeCrypto
      .createHash('sha256')
      .update(`${groupId}:${eventId}:${originPeerHash.trim().toLowerCase()}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
  }

  private pruneGroupInterestRoutes(now = this.now()): void {
    for (const [key, route] of this.groupInterestRoutes) {
      if (route.expiresAt <= now) this.groupInterestRoutes.delete(key);
    }
    for (const [key, expiresAt] of this.forwardedGroupSubKeys) {
      if (expiresAt <= now) this.forwardedGroupSubKeys.delete(key);
    }
    if (this.groupInterestRoutes.size > RETICULUM_CHAT_GROUP_ROUTE_MAX_ROUTES) {
      const excess = this.groupInterestRoutes.size - RETICULUM_CHAT_GROUP_ROUTE_MAX_ROUTES;
      const oldest = [...this.groupInterestRoutes.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, excess);
      for (const [key] of oldest) this.groupInterestRoutes.delete(key);
    }
  }

  private pruneGroupControlRoutes(now = this.now()): void {
    for (const [key, expiresAt] of this.forwardedGroupControlKeys) {
      if (expiresAt <= now) this.forwardedGroupControlKeys.delete(key);
    }
    for (const [key, route] of this.eventRelayRoutes) {
      if (route.expiresAt <= now) this.eventRelayRoutes.delete(key);
    }
    if (this.eventRelayRoutes.size > RETICULUM_CHAT_GROUP_CONTROL_RELAY_MAX_ROUTES) {
      const excess = this.eventRelayRoutes.size - RETICULUM_CHAT_GROUP_CONTROL_RELAY_MAX_ROUTES;
      const oldest = [...this.eventRelayRoutes.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, excess);
      for (const [key] of oldest) this.eventRelayRoutes.delete(key);
    }
  }

  private compactRecentMap(map: Map<string, number>, ttlMs: number, maxEntries: number): void {
    const now = this.now();
    for (const [key, timestamp] of map) {
      if (now - timestamp > ttlMs) map.delete(key);
    }
    while (map.size > maxEntries) {
      const oldestKey = map.keys().next().value as string | undefined;
      if (!oldestKey) break;
      map.delete(oldestKey);
    }
  }

  private markRecentOrDuplicate(
    map: Map<string, number>,
    key: string,
    ttlMs: number,
    maxEntries: number
  ): boolean {
    const now = this.now();
    const lastSeenAt = map.get(key);
    if (lastSeenAt != null && now - lastSeenAt <= ttlMs) {
      return true;
    }
    map.set(key, now);
    if (map.size > maxEntries) this.compactRecentMap(map, ttlMs, maxEntries);
    return false;
  }

  private hashControlPayload(value: unknown): string {
    return nodeCrypto
      .createHash('sha256')
      .update(JSON.stringify(value) ?? '', 'utf8')
      .digest('hex')
      .slice(0, 24);
  }

  private shouldDropDuplicateInboundControlWire(
    wire: Record<string, unknown>,
    groupId: number,
    peerHash: string
  ): boolean {
    if (!peerHash) return false;
    const kind = typeof wire.k === 'string' ? wire.k : '';
    if (
      kind !== 'group_digest' &&
      kind !== 'digest_req' &&
      kind !== 'group_sub' &&
      kind !== 'typing' &&
      kind !== 'relay_digest' &&
      kind !== 'gkd' &&
      kind !== 'gkq' &&
      kind !== 'rf' &&
      kind !== 'feed_req' &&
      kind !== 'range_req' &&
      kind !== 'event_batch'
    ) {
      return false;
    }
    const key = `${peerHash}:${groupId}:${kind}:${this.hashControlPayload(wire)}`;
    return this.markRecentOrDuplicate(
      this.recentInboundControlWires,
      key,
      RETICULUM_CHAT_CONTROL_DEDUP_TTL_MS,
      RETICULUM_CHAT_CONTROL_DEDUP_MAX
    );
  }

  private shouldServeControlRequest(
    wire: Record<string, unknown>,
    groupId: number,
    peerHash: string
  ): boolean {
    if (!peerHash) return true;
    const key = `${peerHash}:${groupId}:${String(wire.k || '')}:${this.hashControlPayload(wire)}`;
    return !this.markRecentOrDuplicate(
      this.recentServedSyncRequests,
      key,
      RETICULUM_CHAT_DIGEST_DEDUPE_TTL_MS,
      RETICULUM_CHAT_CONTROL_DEDUP_MAX
    );
  }

  handleWire(
    wire: Record<string, unknown>,
    peerPresenceHash = '',
    senderDestinationHash = ''
  ): void {
    if (wire.t !== 'RCHAT' || typeof wire.k !== 'string') return;
    const peerHash = this.peerKey(peerPresenceHash, senderDestinationHash);
    if (this.isPeerProtocolCooledDown(peerHash)) return;

    switch (wire.k) {
      case 'hello':
        if (!this.isCompatibleHello(wire)) {
          this.notePeerViolation(peerHash, 'bad_hello');
        }
        return;
      case 'group_sub':
        this.handleGroupSub(wire, peerHash);
        return;
      case 'unsub':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.notePeerSubscription(peerHash, groupId, false);
        return;
      }
      case 'event_req':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleEventResourceRequest(
          groupId,
          wire,
          peerHash
        );
        return;
      }
      case 'event_offer':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleEventOffer(eventOfferFromWire(groupId, wire.o), peerHash);
        return;
      }
      case 'event_page_offer':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleEventPageOffer(eventPageOfferFromWire(groupId, wire.p), peerHash);
        return;
      }
      case 'relay_query':
      {
        if (isDisabledRelayCache) return;
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleRelayQuery(groupId, wire, peerHash);
        return;
      }
      case 'relay_ack':
      {
        if (isDisabledRelayCache) return;
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleRelayAck(groupId, wire.a, peerHash);
        return;
      }
      case 'relay_digest':
      {
        if (isDisabledRelayCache) return;
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleRelayDigest(groupId, wire, peerHash);
        return;
      }
      case 'gkd':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleGroupKeyDigest(groupId, wire.d, peerHash);
        return;
      }
      case 'gkq':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleGroupKeyRequest(groupId, wire.q, peerHash);
        return;
      }
      case 'gks':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleGroupKeyResponse(groupId, wire.r, peerHash);
        return;
      }
      case 'identity_req':
      {
        void this.handleIdentityRequest(wire as Extract<ReticulumChatWire, { k: 'identity_req' }>, peerHash);
        return;
      }
      case 'identity_offer':
      {
        void this.handleIdentityOffer(wire as Extract<ReticulumChatWire, { k: 'identity_offer' }>, peerHash);
        return;
      }
      case 'rf':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleResourceFind(groupId, wire as Extract<ReticulumChatWire, { k: 'rf' }>, peerHash);
        return;
      }
      case 'resource_have':
      {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleResourceHave(groupId, wire, peerHash);
        return;
      }
      case 'group_digest': {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        this.handleGroupDigest(groupId, wire, peerHash);
        return;
      }
      case 'digest_req': {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleDigestReq(groupId, wire, peerHash);
        return;
      }
      case 'feed_req': {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleFeedReq(groupId, wire, peerHash);
        return;
      }
      case 'range_req': {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleRangeReq(groupId, wire, peerHash);
        return;
      }
      case 'event_batch': {
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        void this.handleEventBatch(groupId, wire, peerHash);
        return;
      }
      case 'dm_event':
        this.handleDirectEvent(wire as Extract<ReticulumChatWire, { k: 'dm_event' }>, peerHash);
        return;
      case 'dm_notify':
        void this.handleDirectNotify(wire as Extract<ReticulumChatWire, { k: 'dm_notify' }>, peerHash);
        return;
      case 'dm_probe':
        void this.handleDirectProbe(wire as Extract<ReticulumChatWire, { k: 'dm_probe' }>, peerHash);
        return;
      case 'dm_req':
        void this.handleDirectRequest(wire as Extract<ReticulumChatWire, { k: 'dm_req' }>, peerHash);
        return;
      case 'dm_resource_find':
        void this.handleDirectResourceFind(wire as Extract<ReticulumChatWire, { k: 'dm_resource_find' }>, peerHash);
        return;
      case 'dm_resource_have':
        void this.handleDirectResourceHave(wire as Extract<ReticulumChatWire, { k: 'dm_resource_have' }>, peerHash);
        return;
      case 'dm_page_offer':
        void this.handleDirectPageOffer(wire as Extract<ReticulumChatWire, { k: 'dm_page_offer' }>, peerHash);
        return;
      case 'dm_page':
        this.handleDirectPage(wire as Extract<ReticulumChatWire, { k: 'dm_page' }>, peerHash);
        return;
      case 'typing':
      {
        if (isDisabledTyping) return;
        const groupId = Number(wire.g);
        if (!Number.isInteger(groupId) || groupId <= 0) return;
        if (typeof wire.a !== 'string') return;
        void this.forwardTypingToInterestRoutes(
          groupId,
          wire as Extract<ReticulumChatWire, { k: 'typing' }>,
          peerHash
        );
        if (!this.localGroupIds.has(groupId) || !this.subscribedGroups.has(groupId)) return;
        if (this.shouldDropDuplicateInboundControlWire(wire, groupId, peerHash)) return;
        this.applyTyping(
          groupId,
          normalizeReticulumChatChannelId(wire.c),
          wire.a,
          wire.active === true
        );
        return;
      }
      default:
        return;
    }
  }

  private isCompatibleHello(wire: Record<string, unknown>): boolean {
    if (wire.v !== RETICULUM_CHAT_PROTOCOL_VERSION) return false;
    if (!Array.isArray(wire.f)) return false;
    const features = new Set(wire.f.map((item) => String(item)));
    return RETICULUM_CHAT_PROTOCOL_FEATURES.every((feature) => features.has(feature));
  }

  private noteGroupInterestRoute(
    groupId: number,
    originPeerHash: string,
    reversePeerHash: string,
    hops: number
  ): void {
    const origin = this.routePeerHash(originPeerHash);
    const reverse = this.routePeerHash(reversePeerHash);
    const local = this.localPeerHash();
    if (!origin || !reverse || (local && origin === local)) return;
    this.pruneGroupInterestRoutes();
    const key = this.groupInterestRouteKey(groupId, origin);
    const existing = this.groupInterestRoutes.get(key);
    if (existing && existing.hops < hops) {
      existing.expiresAt = Math.max(
        existing.expiresAt,
        this.now() + RETICULUM_CHAT_GROUP_ROUTE_TTL_MS
      );
      return;
    }
    this.groupInterestRoutes.set(key, {
      reversePeerHash: reverse,
      originPeerHash: origin,
      groupId,
      hops,
      expiresAt: this.now() + RETICULUM_CHAT_GROUP_ROUTE_TTL_MS,
    });
  }

  private shouldForwardGroupSub(
    groupId: number,
    originPeerHash: string,
    inboundPeerHash: string
  ): boolean {
    const origin = this.routePeerHash(originPeerHash);
    const inbound = this.routePeerHash(inboundPeerHash);
    if (!origin || !inbound) return false;
    const key = `${groupId}:${origin}:${inbound}`;
    const now = this.now();
    const expiresAt = this.forwardedGroupSubKeys.get(key) ?? 0;
    if (expiresAt > now) return false;
    this.forwardedGroupSubKeys.set(
      key,
      now + RETICULUM_CHAT_GROUP_ROUTE_FORWARD_DEDUPE_MS
    );
    return true;
  }

  private async forwardGroupSub(
    groups: number[],
    mode: 'summary' | 'active',
    originPeerHash: string,
    inboundPeerHash: string,
    hops: number
  ): Promise<void> {
    const origin = this.routePeerHash(originPeerHash);
    const inbound = this.routePeerHash(inboundPeerHash);
    const local = this.localPeerHash();
    if (!origin || !inbound || (local && origin === local)) return;
    if (hops >= RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS) return;
    const forwardGroups = groups.filter((groupId) =>
      this.shouldForwardGroupSub(groupId, origin, inbound)
    );
    if (!forwardGroups.length) return;
    for (let offset = 0; offset < forwardGroups.length; offset += RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE) {
      const page = forwardGroups.slice(offset, offset + RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE);
      const wire: ReticulumChatWire = {
        t: 'RCHAT',
        k: 'group_sub',
        groups: page,
        mode,
        o: this.compactRoutePeerHash(origin),
        h: hops + 1,
      };
      void this.fanout(wire, [inbound, origin, ...(local ? [local] : [])]);
    }
  }

  private async forwardGroupDigestToInterestRoutes(
    groupId: number,
    wire: Record<string, unknown>,
    inboundPeerHash: string
  ): Promise<void> {
    const inbound = this.routePeerHash(inboundPeerHash);
    if (!inbound) return;
    this.pruneGroupInterestRoutes();
    this.pruneGroupControlRoutes();
    const local = this.localPeerHash();
    const payloadKey = this.hashControlPayload(wire);
    for (const route of this.groupInterestRoutes.values()) {
      if (route.groupId !== groupId) continue;
      if (route.reversePeerHash === inbound) continue;
      if (local && route.originPeerHash === local) continue;
      const key = this.groupControlRouteKey(
        'group_digest',
        groupId,
        route.originPeerHash,
        `${inbound}:${payloadKey}`
      );
      if ((this.forwardedGroupControlKeys.get(key) ?? 0) > this.now()) continue;
      this.forwardedGroupControlKeys.set(
        key,
        this.now() + RETICULUM_CHAT_GROUP_CONTROL_RELAY_TTL_MS
      );
      void this.sendToPeer(route.reversePeerHash, wire as ReticulumChatWire);
    }
  }

  private handleDirectEvent(
    wire: Extract<ReticulumChatWire, { k: 'dm_event' }>,
    peerHash: string
  ): void {
    const event = reticulumDmEventFromWire(wire.e);
    if (!event) return;
    const accepted = this.acceptDirectEvent(event, false);
    if (!accepted) return;
  }

  private markDirectEventSent(event: ReticulumDmEvent): void {
    this.db.markDirectDeliveryStatus(event.eventId, 'sent');
    const peerAddress = ownAddressMatches(this.localDmAddresses, event.senderAddress)
      ? event.recipientAddress
      : event.senderAddress;
    this.emit('directEvent', {
      event: {
        ...event,
        localDeliveryStatus: 'sent',
        localDeliveryUpdatedAt: this.now(),
      },
    });
    this.emit('directSummaryChanged', {
      conversationId: event.conversationId,
      peerAddress,
    });
  }

  private pruneDmDiscoveryRoutes(now = this.now()): void {
    for (const [requestId, route] of this.dmProbeRoutes) {
      if (route.expiresAt <= now) this.dmProbeRoutes.delete(requestId);
    }
    for (const [requestId, route] of this.dmNotifyRoutes) {
      if (route.expiresAt <= now) this.dmNotifyRoutes.delete(requestId);
    }
    for (const [key, route] of this.dmConversationRouteIds) {
      if (route.expiresAt <= now) this.dmConversationRouteIds.delete(key);
    }
    for (const [key, expiresAt] of this.recentDmDiscoveryKeys) {
      if (expiresAt <= now) this.recentDmDiscoveryKeys.delete(key);
    }
    for (const [transferId, request] of this.directDmPageRequests) {
      const requestedAt = Number(request.requestedAt || 0);
      if (
        requestedAt > 0 &&
        now - requestedAt > RETICULUM_CHAT_DIRECT_HISTORY_PAGE_REQUEST_STALE_MS
      ) {
        this.directDmPageRequests.delete(transferId);
      }
    }
    const trimOldest = <T>(map: Map<string, T>, max: number) => {
      if (map.size <= max) return;
      const excess = map.size - max;
      for (const key of [...map.keys()].slice(0, excess)) map.delete(key);
    };
    trimOldest(this.dmProbeRoutes, RETICULUM_CHAT_DM_DISCOVERY_ROUTE_MAX);
    trimOldest(this.dmNotifyRoutes, RETICULUM_CHAT_DM_DISCOVERY_ROUTE_MAX);
    trimOldest(this.dmConversationRouteIds, RETICULUM_CHAT_DM_DISCOVERY_ROUTE_MAX);
    trimOldest(this.recentDmDiscoveryKeys, RETICULUM_CHAT_DM_DISCOVERY_ROUTE_MAX);
  }

  private dmConversationRouteKey(sourcePeerHash: string, conversationId: string): string {
    return `${sourcePeerHash}:${conversationId}`;
  }

  private localDmAddressForConversation(addressA: string, addressB: string): string {
    if (ownAddressMatches(this.localDmAddresses, addressA)) return addressA;
    if (ownAddressMatches(this.localDmAddresses, addressB)) return addressB;
    return '';
  }

  private async buildSignedDirectRequestWire(
    conversationId: string,
    addressA: string,
    addressB: string,
    after: number,
    limit: number,
    requestIdHint?: string
  ): Promise<Extract<ReticulumChatWire, { k: 'dm_req' }> | null> {
    if (!this.signLocalFields) return null;
    const requesterPeerHash = this.getLocalResourcePeerHash();
    if (!requesterPeerHash) return null;
    const localAddress = this.localDmAddressForConversation(addressA, addressB);
    if (!localAddress) return null;
    const peerAddress = localAddress === addressA ? addressB : addressA;
    const requestId =
      normalizeReticulumControlRequestId(requestIdHint) ||
      nodeCrypto.randomBytes(4).toString('hex');
    const timestamp = this.now();
    const safeAfter = Math.max(0, Math.floor(after || 0));
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit || 50)));
    const signed = await this.signLocalFields({
      type: 'RCHAT_DM_REQ',
      peerAddress,
      after: safeAfter,
      limit: safeLimit,
      requestId,
      requesterPeerHash,
      timestamp,
    }).catch(() => null);
    if (
      !signed ||
      signed.authorAddress !== localAddress ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return null;
    }
    const request: Extract<ReticulumChatWire, { k: 'dm_req' }> = {
      t: 'RCHAT',
      k: 'dm_req',
      q: {
        b: peerAddress,
        a: safeAfter,
        l: safeLimit,
        q: requestId,
        rp: this.compactResourcePeerHash(requesterPeerHash),
        p: signed.authorPublicKey,
        n: timestamp,
        z: signed.signature,
      },
    };
    if (!verifyReticulumDmRequest(request.q, timestamp)) return null;
    return wireFitsReticulum(request) ? request : null;
  }

  private async requestDirectMissingEvents(
    conversationId: string,
    addressA: string,
    addressB: string,
    sourcePeerHash: string,
    remoteEventId: string,
    remoteTimestamp: number,
    inboundPeerHash?: string,
    options: { force?: boolean; requestId?: string } = {}
  ): Promise<void> {
    const localLatest = this.db.getDirectLatestEvent(conversationId);
    const senderLatest = this.db.getDirectLatestEventFromSender(conversationId, addressA);
    const cursorLatest =
      senderLatest ||
      (localLatest && localLatest.senderAddress === addressA ? localLatest : null);
    if (
      localLatest &&
      remoteEventId === localLatest.eventId &&
      ownAddressMatches(this.localDmAddresses, localLatest.senderAddress) &&
      localLatest.localDeliveryStatus !== 'sent'
    ) {
      this.markDirectEventSent(localLatest);
    }
    if (
      cursorLatest &&
      remoteTimestamp < Number.MAX_SAFE_INTEGER &&
      (cursorLatest.timestamp > remoteTimestamp ||
        (cursorLatest.timestamp === remoteTimestamp &&
          (!remoteEventId || cursorLatest.eventId >= remoteEventId)))
    ) {
      return;
    }
    const source = this.normalizeResourcePeerHash(sourcePeerHash);
    if (!source || !this.localDmAddressForConversation(addressA, addressB)) return;
    const requestKeyPart = options.requestId ? `:${options.requestId}` : '';
    const key = `${source}:${conversationId}:${remoteTimestamp}:${remoteEventId}${requestKeyPart}`;
    const now = this.now();
    this.pruneDmDiscoveryRoutes(now);
    const last = this.recentDmRequests.get(key) || 0;
    if (!options.force && now - last < 10_000) return;
    this.recentDmRequests.set(key, now);
    const request = await this.buildSignedDirectRequestWire(
      conversationId,
      addressA,
      addressB,
      cursorLatest ? Math.max(0, cursorLatest.timestamp - 1) : 0,
      50,
      options.requestId
    );
    if (!request) return;
    const transferId =
      normalizeReticulumControlRequestId(request.q.q) ||
      nodeCrypto.randomBytes(8).toString('hex');
    const requesterAddress = deriveReticulumControlAuthor(request.q.p);
    const requesterPeerHash = this.normalizeResourcePeerHash(request.q.rp) || '';
    this.directDmPageRequests.set(transferId, {
      transferId,
      conversationId,
      pageHash: '',
      sizeBytes: RETICULUM_CHAT_MAX_EVENT_PAGE_BYTES,
      eventCount: 50,
      sourcePeerHash: source,
      requestedAt: now,
      requesterAddress,
      requesterPeerHash,
      peerAddress: typeof request.q.b === 'string' ? request.q.b : '',
      after: Number(request.q.a ?? request.q.after ?? 0),
      limit: Number(request.q.l ?? request.q.limit ?? 50),
      requestId: typeof request.q.q === 'string' ? request.q.q : '',
      requesterPublicKey: typeof request.q.p === 'string' ? request.q.p : '',
      timestamp: Number(request.q.n || 0),
      signature: typeof request.q.z === 'string' ? request.q.z : '',
    });
    if (
      this.bridge &&
      typeof this.bridge.acceptReticulumChatResourceDetailed === 'function'
    ) {
      try {
        const resolvedIdentity = await this.ensureResourcePeerIdentity(source, 'dm-page-resource');
        if (resolvedIdentity !== null) {
          const accepted = await this.bridge.acceptReticulumChatResourceDetailed({
            peerPresenceHash: source,
            reticulumIdentityPublicKeyBase64: resolvedIdentity,
            transferId,
            savePath: this.tempEventBlobPath(`${transferId}.dm-page.recv`),
            fileName: `${transferId}.dm-page.json`,
            size: RETICULUM_CHAT_MAX_EVENT_PAGE_BYTES,
            metadata: {
              resourceType: 'reticulum_chat_event',
              logicalResourceType: 'reticulum_chat_dm_page',
              conversationId,
              variableSize: true,
            },
            authMessage: {
              type: 'RETICULUM_CHAT_DM_PAGE_REQUEST',
              transferId,
              ...request.q,
            },
          });
          if (accepted.ok) return;
        }
      } catch (err) {
        loggerWarn(
          `[ReticulumChat] dm_page_link_failed conversation=${conversationId.slice(0, 16)} peer=${source.slice(0, 16)} reason=${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const direct = await this.sendToPeer(source, request);
    if (direct.ok) return;
    const inbound = inboundPeerHash ? this.normalizeResourcePeerHash(inboundPeerHash) : undefined;
    if (inbound && inbound !== source) {
      void this.sendToPeer(inbound, request);
    }
  }

  private async handleDirectNotify(
    wire: Extract<ReticulumChatWire, { k: 'dm_notify' }>,
    peerHash: string
  ): Promise<void> {
    const notify = wire.d;
    const now = this.now();
    if (!verifyReticulumDmNotify(notify, now)) return;
    const reversePeerHash = this.normalizeResourcePeerHash(peerHash);
    const sourcePeerHash = this.normalizeResourcePeerHash(notify.sp);
    const requestId = normalizeReticulumControlRequestId(notify.q);
    if (!reversePeerHash || !sourcePeerHash || !requestId) return;
    const authorAddress = deriveReticulumControlAuthor(notify.p);
    const peerAddress = typeof notify.b === 'string' ? notify.b.trim() : '';
    const conversationId = reticulumDmConversationId(authorAddress, peerAddress);
    if (!authorAddress || !peerAddress || !conversationId) return;
    this.pruneDmDiscoveryRoutes(now);
    const recentKey = `notify:${requestId}`;
    if ((this.recentDmDiscoveryKeys.get(recentKey) ?? 0) > now) return;
    this.recentDmDiscoveryKeys.set(
      recentKey,
      now + RETICULUM_CHAT_DM_DISCOVERY_ROUTE_TTL_MS
    );
    if (sourcePeerHash !== this.getLocalResourcePeerHash()) {
      this.dmNotifyRoutes.set(requestId, {
        reversePeerHash,
        conversationId,
        sourcePeerHash,
        expiresAt: Math.min(
          notify.n + RETICULUM_CHAT_DM_NOTIFY_TTL_MS,
          now + RETICULUM_CHAT_DM_DISCOVERY_ROUTE_TTL_MS
        ),
      });
    }
    this.dmConversationRouteIds.set(
      this.dmConversationRouteKey(sourcePeerHash, conversationId),
      {
        requestId,
        expiresAt: Math.min(
          notify.n + RETICULUM_CHAT_DM_NOTIFY_TTL_MS,
          now + RETICULUM_CHAT_DM_DISCOVERY_ROUTE_TTL_MS
        ),
      }
    );

    if (this.localDmAddressForConversation(authorAddress, peerAddress)) {
      await this.requestDirectMissingEvents(
        conversationId,
        authorAddress,
        peerAddress,
        sourcePeerHash,
        '',
        Number.MAX_SAFE_INTEGER,
        reversePeerHash,
        { requestId }
      );
    }

    const probeRequestId = normalizeReticulumControlRequestId(notify.r);
    if (probeRequestId) {
      const route = this.dmProbeRoutes.get(probeRequestId);
      if (route && route.expiresAt > now) {
        void this.sendToPeer(route.reversePeerHash, wire);
        return;
      }
    }

    const hop = notify.h ?? 0;
    const maxHops = notify.m ?? RETICULUM_CHAT_DM_NOTIFY_MAX_HOPS;
    if (hop >= maxHops || now >= notify.n + RETICULUM_CHAT_DM_NOTIFY_TTL_MS) return;
    const forwarded: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'dm_notify',
      d: {
        ...notify,
        h: hop + 1,
      },
    };
    if (!wireFitsReticulum(forwarded)) return;
    const localPeerHash = this.getLocalResourcePeerHash();
    void this.fanout(forwarded, [
      reversePeerHash,
      sourcePeerHash,
      ...(localPeerHash ? [localPeerHash] : []),
    ]);
  }

  private async handleDirectProbe(
    wire: Extract<ReticulumChatWire, { k: 'dm_probe' }>,
    peerHash: string
  ): Promise<void> {
    const probe = wire.q;
    const now = this.now();
    if (!verifyReticulumDmProbe(probe, now)) return;
    const reversePeerHash = this.normalizeResourcePeerHash(peerHash);
    const requestId = normalizeReticulumControlRequestId(probe.q);
    if (!reversePeerHash || !requestId) return;
    const requesterAddress = deriveReticulumControlAuthor(probe.p);
    if (!requesterAddress) return;
    this.pruneDmDiscoveryRoutes(now);
    const recentKey = `probe:${requestId}`;
    if ((this.recentDmDiscoveryKeys.get(recentKey) ?? 0) > now) return;
    this.recentDmDiscoveryKeys.set(
      recentKey,
      now + RETICULUM_CHAT_DM_DISCOVERY_ROUTE_TTL_MS
    );
    this.dmProbeRoutes.set(requestId, {
      reversePeerHash,
      requesterAddress,
      expiresAt: Math.min(
        probe.n + RETICULUM_CHAT_DM_PROBE_TTL_MS,
        now + RETICULUM_CHAT_DM_DISCOVERY_ROUTE_TTL_MS
      ),
    });

    const summaries = this.db.getDirectSummaries(requesterAddress).slice(0, 16);
    for (const summary of summaries) {
      const latest = summary.lastEvent;
      if (!latest || !this.acceptsDirectConversation(latest)) continue;
      const notify = await this.buildSignedDirectNotifyWire(
        latest.senderAddress,
        latest.recipientAddress,
        latest,
        requestId
      );
      if (notify) void this.sendToPeer(reversePeerHash, notify);
    }

    const hop = probe.h ?? 0;
    const maxHops = probe.m ?? RETICULUM_CHAT_DM_PROBE_MAX_HOPS;
    if (hop >= maxHops || now >= probe.n + RETICULUM_CHAT_DM_PROBE_TTL_MS) return;
    const forwarded: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'dm_probe',
      q: {
        ...probe,
        h: hop + 1,
      },
    };
    if (!wireFitsReticulum(forwarded)) return;
    const localPeerHash = this.getLocalResourcePeerHash();
    void this.fanout(forwarded, [
      reversePeerHash,
      ...(localPeerHash ? [localPeerHash] : []),
    ]);
  }

  private async handleDirectRequest(
    wire: Extract<ReticulumChatWire, { k: 'dm_req' }>,
    peerHash: string
  ): Promise<void> {
    const request = wire.q;
    if (!verifyReticulumDmRequest(request, this.now())) return;
    const requesterAddress = deriveReticulumControlAuthor(request.p);
    const peerAddress = typeof request.b === 'string' ? request.b.trim() : '';
    const conversationId = reticulumDmConversationId(requesterAddress, peerAddress);
    if (!requesterAddress || !peerAddress || !conversationId) return;
    const requestId = normalizeReticulumControlRequestId(request.q);
    const requesterPeerHash = this.normalizeResourcePeerHash(request.rp);
    if (!requestId || !requesterPeerHash) return;
    if (
      !ownAddressMatches(this.localDmAddresses, requesterAddress) &&
      !ownAddressMatches(this.localDmAddresses, peerAddress)
    ) {
      const route = this.dmNotifyRoutes.get(requestId);
      if (
        route &&
        route.expiresAt > this.now() &&
        route.conversationId === conversationId
      ) {
        void this.sendToPeer(route.reversePeerHash, wire);
      }
      return;
    }
    const after = Number(request.a ?? request.after ?? 0);
    const limit = Math.max(1, Math.min(50, Number(request.l ?? request.limit ?? 50)));
    const events = this.db.getDirectEventsAfter(conversationId, after, limit + 1);
    if (events.length === 0) return;
    await this.sendDirectDmPageResourceOffer(
      requesterPeerHash,
      conversationId,
      after,
      limit,
      events,
      requestId
    );
  }

  private async sendDirectDmPageResourceOffer(
    requesterPeerHash: string,
    conversationId: string,
    after: number,
    limit: number,
    events: ReticulumDmEvent[],
    transferIdHint?: string
  ): Promise<void> {
    if (!this.bridge || typeof this.bridge.sendReticulumChatResourceDetailed !== 'function') return;
    const peer = this.normalizeResourcePeerHash(requesterPeerHash);
    if (!peer) return;
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit || 50)));
    const selected = events.slice(0, safeLimit);
    const page = this.buildDirectDmPageResourceBlob(
      conversationId,
      selected,
      Math.max(0, Math.floor(after || 0)),
      events.length > selected.length
    );
    if (!page) return;
    const localResourceIdentity = await this.localReticulumResourceIdentity();
    const transferId =
      normalizeReticulumControlRequestId(transferIdHint) ||
      nodeCrypto.randomBytes(8).toString('hex');
    const filePath = this.writeTempEventBlob(transferId, page.blob);
    const registered = await this.bridge.sendReticulumChatResourceDetailed({
      allowedRecipientAddress: peer,
      transferId,
      filePath,
      fileName: `${transferId}.dm-page.json`,
      size: page.sizeBytes,
      sha256: page.pageHash,
      metadata: {
        resourceType: 'reticulum_chat_event',
        logicalResourceType: 'reticulum_chat_dm_page',
        conversationId,
        pageHash: page.pageHash,
        eventCount: page.eventCount,
        size: page.sizeBytes,
        variableSize: true,
      },
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    if (!registered.ok) {
      this.safeUnlink(filePath);
      return;
    }
    const offer: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'dm_page_offer',
      p: {
        x: transferId,
        c: conversationId,
        ph: page.pageHash,
        s: page.sizeBytes,
        n: page.eventCount,
        ...(page.hasMore ? { more: 1 as const } : {}),
        ...(localResourceIdentity.destinationHash
          ? { sd: this.compactResourcePeerHash(localResourceIdentity.destinationHash) }
          : {}),
      },
    };
    if (wireFitsReticulum(offer)) void this.sendToPeer(peer, offer);
  }

  private async handleDirectPageOffer(
    wire: Extract<ReticulumChatWire, { k: 'dm_page_offer' }>,
    peerHash: string
  ): Promise<void> {
    const offer = wire.p;
    const transferId = normalizeReticulumControlRequestId(offer?.x);
    const conversationId = normalizeReticulumDmConversationId(offer?.c);
    const pageHash = String(offer?.ph || '').trim().toLowerCase();
    const sizeBytes = Number(offer?.s || 0);
    const eventCount = Number(offer?.n || 0);
    if (
      !transferId ||
      !conversationId ||
      !/^[0-9a-f]{64}$/i.test(pageHash) ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > RETICULUM_CHAT_MAX_EVENT_PAGE_BYTES ||
      !Number.isInteger(eventCount) ||
      eventCount <= 0 ||
      eventCount > 50
    ) {
      return;
    }
    const pending = this.directDmPageRequests.get(transferId);
    if (!pending || pending.conversationId !== conversationId) return;
    if (!this.bridge || typeof this.bridge.acceptReticulumChatResourceDetailed !== 'function') return;
    const sourcePeerHash =
      this.normalizeResourcePeerHash(offer.sd) ||
      this.normalizeResourcePeerHash(peerHash) ||
      pending.sourcePeerHash ||
      '';
    if (!sourcePeerHash) return;
    let reticulumIdentityPublicKeyBase64 = '';
    try {
      const resolvedIdentity = await this.ensureResourcePeerIdentity(sourcePeerHash, 'dm-page-offer');
      if (resolvedIdentity === null) return;
      reticulumIdentityPublicKeyBase64 = resolvedIdentity;
    } catch {
      return;
    }
    pending.pageHash = pageHash;
    pending.sizeBytes = sizeBytes;
    pending.eventCount = eventCount;
    pending.hasMore = offer.more === 1;
    pending.sourcePeerHash = sourcePeerHash;
    const result = await this.bridge.acceptReticulumChatResourceDetailed({
      peerPresenceHash: sourcePeerHash,
      reticulumIdentityPublicKeyBase64,
      transferId,
      savePath: this.tempEventBlobPath(`${transferId}.dm-page.recv`),
      fileName: `${transferId}.dm-page.json`,
      size: sizeBytes,
      sha256: pageHash,
      metadata: {
        resourceType: 'reticulum_chat_event',
        logicalResourceType: 'reticulum_chat_dm_page',
        conversationId,
        pageHash,
        eventCount,
        variableSize: true,
      },
      authMessage: {
        type: 'RETICULUM_CHAT_DM_PAGE_REQUEST',
        transferId,
        b: pending.peerAddress || '',
        a: Math.max(0, Math.floor(Number(pending.after || 0))),
        l: Math.max(1, Math.min(50, Math.floor(Number(pending.limit || 50)))),
        q: pending.requestId || transferId,
        rp: pending.requesterPeerHash || this.getLocalResourcePeerHash() || '',
        p: pending.requesterPublicKey || '',
        n: Number(pending.timestamp || 0),
        z: pending.signature || '',
      },
    });
    if (!result.ok) this.directDmPageRequests.delete(transferId);
  }

  private handleDirectPage(
    wire: Extract<ReticulumChatWire, { k: 'dm_page' }>,
    _peerHash: string
  ): void {
    const wireEvents = Array.isArray(wire.e) ? wire.e : wire.events;
    if (!Array.isArray(wireEvents)) return;
    const firstEvent = reticulumDmEventFromWire(wireEvents[0]);
    const conversationId =
      normalizeReticulumDmConversationId(wire.c) ||
      normalizeReticulumDmConversationId(firstEvent?.conversationId);
    if (!conversationId) return;
    let accepted = false;
    let lastEvent: ReticulumDmEvent | null = null;
    for (const wireEvent of wireEvents) {
      const event = reticulumDmEventFromWire(wireEvent);
      if (!event) continue;
      if (event?.conversationId !== conversationId) continue;
      const inserted = this.acceptDirectEvent(event, false);
      accepted = accepted || inserted;
      if (
        !lastEvent ||
        event.timestamp > lastEvent.timestamp ||
        (event.timestamp === lastEvent.timestamp && event.eventId > lastEvent.eventId)
      ) {
        lastEvent = event;
      }
    }
    if ((wire.more === true || wire.m === 1) && accepted && lastEvent) {
      const sourcePeerHash = this.normalizeResourcePeerHash(_peerHash) || '';
      this.pruneDmDiscoveryRoutes();
      const routeId = sourcePeerHash
        ? this.dmConversationRouteIds.get(
            this.dmConversationRouteKey(sourcePeerHash, conversationId)
          )
        : undefined;
      void this.requestDirectMissingEvents(
        conversationId,
        lastEvent.senderAddress,
        lastEvent.recipientAddress,
        _peerHash,
        lastEvent.eventId,
        Number.MAX_SAFE_INTEGER,
        _peerHash,
        { force: true, requestId: routeId && routeId.expiresAt > this.now() ? routeId.requestId : undefined }
      );
    }
  }

  private async forwardTypingToInterestRoutes(
    groupId: number,
    wire: Extract<ReticulumChatWire, { k: 'typing' }>,
    inboundPeerHash: string
  ): Promise<void> {
    const inbound = this.routePeerHash(inboundPeerHash);
    const origin = this.routePeerHash(wire.o) ?? inbound;
    if (!inbound || !origin) return;
    const hops = Math.max(
      0,
      Math.min(
        RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS,
        Number.isInteger(Number(wire.h)) ? Number(wire.h) : 0
      )
    );
    if (hops >= RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS) return;
    this.pruneGroupInterestRoutes();
    this.pruneGroupControlRoutes();
    this.noteGroupInterestRoute(groupId, origin, inbound, hops);
    const local = this.localPeerHash();
    const forwarded: Extract<ReticulumChatWire, { k: 'typing' }> = {
      ...wire,
      o: this.compactRoutePeerHash(origin),
      h: hops + 1,
    };
    const payloadKey = this.hashControlPayload(forwarded);
    for (const route of this.groupInterestRoutes.values()) {
      if (route.groupId !== groupId) continue;
      if (route.reversePeerHash === inbound) continue;
      if (local && route.originPeerHash === local) continue;
      const key = this.groupControlRouteKey(
        'typing',
        groupId,
        route.originPeerHash,
        `${inbound}:${payloadKey}`
      );
      if ((this.forwardedGroupControlKeys.get(key) ?? 0) > this.now()) continue;
      this.forwardedGroupControlKeys.set(
        key,
        this.now() + RETICULUM_CHAT_TYPING_TTL_MS
      );
      void this.sendToPeer(route.reversePeerHash, forwarded);
    }
  }

  private relayGroupControlRequest(
    kind: 'digest_req' | 'feed_req' | 'range_req' | 'event_req' | 'relay_query',
    groupId: number,
    wire: Record<string, unknown>,
    inboundPeerHash: string,
    payloadKey: string
  ): boolean {
    const inbound = this.routePeerHash(inboundPeerHash);
    const origin = this.routePeerHash(wire.o) ?? inbound;
    const local = this.localPeerHash();
    if (!inbound || !origin || (local && origin === local)) return false;
    if (!this.groupInterestRoutes.has(this.groupInterestRouteKey(groupId, origin))) {
      return false;
    }
    const hops = Math.max(
      0,
      Math.min(
        RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS,
        Number.isInteger(Number(wire.h)) ? Number(wire.h) : 0
      )
    );
    if (hops >= RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS) return false;
    const dedupeKey = this.groupControlRouteKey(kind, groupId, origin, payloadKey);
    const now = this.now();
    if ((this.forwardedGroupControlKeys.get(dedupeKey) ?? 0) > now) return true;
    this.forwardedGroupControlKeys.set(
      dedupeKey,
      now + RETICULUM_CHAT_GROUP_CONTROL_RELAY_TTL_MS
    );
    this.noteGroupInterestRoute(groupId, origin, inbound, hops);
    const requestId =
      this.normalizeGroupControlRequestId(wire.rid) ??
      (
        kind === 'event_req' && wire.q && typeof wire.q === 'object'
          ? this.eventRelayRequestId(
              groupId,
              String((wire.q as Partial<ReticulumChatEventRequestWire>).id || ''),
              origin
            )
          : this.groupControlRequestId(kind, groupId, origin, payloadKey)
      );
    if (kind === 'event_req' || kind === 'relay_query') {
      const eventIds =
        kind === 'event_req'
          ? [String((wire.q as Partial<ReticulumChatEventRequestWire> | undefined)?.id || '')]
          : (
              Array.isArray((wire.q as Partial<ReticulumChatRelayQueryWire> | undefined)?.ids)
                ? ((wire.q as Partial<ReticulumChatRelayQueryWire>).ids ?? [])
                    .filter((id): id is string => typeof id === 'string' && id.length >= 8)
                    .slice(0, RETICULUM_CHAT_RELAY_QUERY_MAX_IDS)
                : []
            );
      for (const eventId of eventIds) {
        const routeKey =
          kind === 'event_req'
            ? requestId
            : this.eventRelayRequestId(groupId, eventId, origin);
        this.eventRelayRoutes.set(routeKey, {
          reversePeerHash: inbound,
          originPeerHash: origin,
          groupId,
          eventId,
          expiresAt: now + RETICULUM_CHAT_GROUP_CONTROL_RELAY_TTL_MS,
        });
      }
    }
    const forwarded = {
      ...wire,
      o: this.compactRoutePeerHash(origin),
      ...(kind === 'relay_query' ? {} : { rid: requestId }),
      h: hops + 1,
    } as ReticulumChatWire;
    if (kind === 'event_req' && !wireFitsReticulum(forwarded)) {
      delete (forwarded as Partial<Extract<ReticulumChatWire, { k: 'event_req' }>>).rid;
    }
    void this.fanout(forwarded, [inbound, origin, ...(local ? [local] : [])]);
    return true;
  }

  private handleGroupSub(wire: Record<string, unknown>, peerHash: string): void {
    if (!Array.isArray(wire.groups)) return;
    const groups = wire.groups
      .map((groupId) => Number(groupId))
      .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
      .slice(0, RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE);
    const inboundPeerHash = this.routePeerHash(peerHash);
    const originPeerHash = this.routePeerHash(wire.o) ?? inboundPeerHash;
    const hops = Math.max(0, Math.min(
      RETICULUM_CHAT_GROUP_ROUTE_MAX_HOPS,
      Number.isInteger(Number(wire.h)) ? Number(wire.h) : 0
    ));
    if (!inboundPeerHash || !originPeerHash) return;
    for (const groupId of groups) {
      this.notePeerSubscription(originPeerHash, groupId, true);
      this.noteGroupInterestRoute(groupId, originPeerHash, inboundPeerHash, hops);
      this.requestKnownAuthorGaps(groupId, peerHash, 'group_sub');
      if (this.shouldDropDuplicateInboundControlWire(wire, groupId, peerHash)) {
        continue;
      }
      const localMemberSubscription =
        this.subscribedGroups.has(groupId) && this.localGroupIds.has(groupId);
      if (localMemberSubscription || this.hasLocalGroupHistory(groupId)) {
        void this.sendToPeer(peerHash, this.buildGroupDigestWire(groupId));
      }
      if (localMemberSubscription) {
        if (hops === 0 && originPeerHash === inboundPeerHash) {
          void this.pushMetadataHistoryPageToPeer(peerHash, groupId, 'group_sub');
        }
        if (hops === 0 && originPeerHash === inboundPeerHash) {
          void this.pushNewestHistoryPageToPeer(peerHash, groupId, 'group_sub');
        }
      }
      void this.serveRelayDigestForGroup(peerHash, groupId);
      void this.serveGroupKeyDigestForGroup(peerHash, groupId);
    }
    void this.forwardGroupSub(
      groups,
      wire.mode === 'active' ? 'active' : 'summary',
      originPeerHash,
      inboundPeerHash,
      hops
    );
  }

  private handleGroupDigest(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): void {
    void this.forwardGroupDigestToInterestRoutes(groupId, wire, peerHash);
    if (!this.localGroupIds.has(groupId) || !this.subscribedGroups.has(groupId)) return;
    if (this.shouldDropDuplicateInboundControlWire(wire, groupId, peerHash)) return;
    const providerPeerHash =
      this.routePeerHash(wire.sd) ??
      this.routePeerHash(peerHash) ??
      peerHash.trim().toLowerCase();
    const remoteGroupLatest = this.cursorFromWire(wire.latest);
    const remoteDigestHash = typeof wire.digestHash === 'string' ? wire.digestHash : '';
    this.db.upsertPeerGroupState(
      providerPeerHash || peerHash,
      groupId,
      remoteGroupLatest,
      remoteDigestHash,
      this.now()
    );
    this.requestKnownAuthorGaps(groupId, peerHash, 'group_digest');
    const channels = Array.isArray(wire.channels)
      ? wire.channels.slice(0, RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP)
      : [];
    let requestedFromChannelDigest = false;
    let pushedFromChannelDigest = false;
    let requestedWindowRepair = false;
    const localGroupLatest = this.getGroupDigestLatestCursor(groupId);
    const localDigestHash = this.buildGroupDigestHash(groupId);
    const remoteDigestNeedsRepair =
      !!remoteDigestHash && remoteDigestHash !== localDigestHash;
    const remoteHasCursorDetail =
      !!remoteGroupLatest ||
      channels.some((rawChannel) => {
        if (!rawChannel || typeof rawChannel !== 'object' || Array.isArray(rawChannel)) return false;
        return !!this.cursorFromWire((rawChannel as Partial<ReticulumChatDigestWire>).latest);
      });
    const remoteIsBehindGroup =
      !!localGroupLatest &&
      (
        !remoteGroupLatest ||
        this.compareCursors(localGroupLatest, remoteGroupLatest) > 0
      );
    const remoteAtOrAheadOfLocalGroup =
      !!remoteGroupLatest &&
      (
        !localGroupLatest ||
        this.compareCursors(remoteGroupLatest, localGroupLatest) >= 0
      );
    const needsNewestGroupRepair =
      !!remoteGroupLatest &&
      remoteAtOrAheadOfLocalGroup &&
      (
        !localGroupLatest ||
        this.compareCursors(remoteGroupLatest, localGroupLatest) > 0 ||
        remoteDigestNeedsRepair
      );
    if (
      remoteDigestNeedsRepair &&
      remoteGroupLatest &&
      this.shouldRequestMetadataRepair(providerPeerHash || peerHash, groupId)
    ) {
      void this.requestLinkedHistoryPage(
        providerPeerHash || peerHash,
        groupId,
        RETICULUM_CHAT_ALL_CHANNELS_ID,
        remoteGroupLatest,
        'before',
        true,
        'metadata-first-digest-repair',
        peerHash,
        'metadata'
      );
      loggerLog(
        `[ReticulumChat] Requesting metadata-first repair group=${groupId} peer=${peerHash.slice(0, 16)} provider=${providerPeerHash.slice(0, 16) || 'unknown'} remoteLatest=${remoteGroupLatest.eventId}`
      );
    }
    let newestGroupRepairRequested = false;
    if (
      needsNewestGroupRepair &&
      this.shouldRequestGroupRepair(peerHash, groupId, RETICULUM_CHAT_ALL_CHANNELS_ID)
    ) {
      void this.requestLinkedHistoryPage(
        providerPeerHash || peerHash,
        groupId,
        RETICULUM_CHAT_ALL_CHANNELS_ID,
        remoteGroupLatest,
        'before',
        true,
        'newest-group-repair',
        peerHash
      );
      loggerLog(
        `[ReticulumChat] Requesting newest group repair group=${groupId} peer=${peerHash.slice(0, 16)} provider=${providerPeerHash.slice(0, 16) || 'unknown'} remoteLatest=${remoteGroupLatest.eventId} localLatest=${localGroupLatest?.eventId ?? 'none'} reason=${remoteDigestNeedsRepair ? 'digest-mismatch' : 'remote-newer'}`
      );
      if (
        localGroupLatest &&
        this.compareCursors(remoteGroupLatest, localGroupLatest) === 0
      ) {
        void this.sendFeedPageToPeer(
          peerHash,
          groupId,
          RETICULUM_CHAT_ALL_CHANNELS_ID,
          remoteGroupLatest,
          'before'
        ).catch((err) => {
          loggerWarn(
            `[ReticulumChat] Newest group repair push failed group=${groupId} peer=${peerHash.slice(0, 16)}:`,
            err
          );
        });
      }
      requestedFromChannelDigest = true;
      requestedWindowRepair = true;
      newestGroupRepairRequested = true;
    }
    for (const rawChannel of channels) {
      if (!rawChannel || typeof rawChannel !== 'object' || Array.isArray(rawChannel)) continue;
      const channel = rawChannel as Partial<ReticulumChatDigestWire>;
      const channelId = normalizeReticulumChatChannelId(channel.c);
      const remoteLatest = this.cursorFromWire(channel.latest);
      const remoteOldest = this.cursorFromWire(channel.oldest);
      this.db.upsertPeerChannelState(
        peerHash,
        {
          groupId,
          channelId,
          latestCursor: remoteLatest,
          oldestCursor: remoteOldest,
          visibleWindowHash: typeof channel.wh === 'string' ? channel.wh : '',
        },
        this.now()
      );
      if (newestGroupRepairRequested) continue;
      const localLatest = this.db.getLatestFeedCursor(groupId, channelId);
      const localWindowHash = this.db.computeWindowHash(
        this.db.getRecentEvents(groupId, 25, channelId)
      );
      const remoteWindowHash = typeof channel.wh === 'string' ? channel.wh : '';
      const channelWindowMismatch = !!remoteWindowHash && remoteWindowHash !== localWindowHash;
      if (channelWindowMismatch && remoteLatest) {
        requestedWindowRepair = this.requestVisibleWindowRepair(
          peerHash,
          groupId,
          channelId,
          remoteLatest,
          localLatest,
          'channel-window-mismatch'
        ) || requestedWindowRepair;
        if (requestedWindowRepair) {
          requestedFromChannelDigest = true;
          pushedFromChannelDigest = true;
        }
        continue;
      }
      if (!remoteLatest) continue;
      if (!localLatest || this.compareCursors(remoteLatest, localLatest) > 0) {
        if (localLatest) {
          this.sendRepairFeedRequest(peerHash, {
            t: 'RCHAT',
            k: 'feed_req',
            g: groupId,
            c: channelId,
            after: this.cursorToWire(localLatest),
            limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
          }, 'channel-after-local-latest');
        } else {
          void this.requestPeerEventById(peerHash, groupId, remoteLatest.eventId, 'cold-channel-latest');
          this.sendRepairFeedRequest(peerHash, {
            t: 'RCHAT',
            k: 'feed_req',
            g: groupId,
            c: channelId,
            before: this.cursorToWire(remoteLatest),
            inc: 1,
            limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
          }, 'cold-channel-latest');
        }
        requestedFromChannelDigest = true;
      } else if (this.compareCursors(localLatest, remoteLatest) > 0) {
        void this.sendFeedPageToPeer(peerHash, groupId, channelId, remoteLatest, 'after');
        pushedFromChannelDigest = true;
      }
    }
    if (
      !requestedWindowRepair &&
      remoteDigestNeedsRepair &&
      !!remoteGroupLatest &&
      !!localGroupLatest
    ) {
      const repaired = this.requestVisibleWindowRepair(
        peerHash,
        groupId,
        RETICULUM_CHAT_ALL_CHANNELS_ID,
        remoteGroupLatest,
        localGroupLatest,
        'group-window-mismatch'
      );
      if (repaired) {
        requestedFromChannelDigest = true;
        pushedFromChannelDigest = true;
        requestedWindowRepair = true;
      }
    }
    if (
      !requestedFromChannelDigest &&
      !pushedFromChannelDigest &&
      remoteIsBehindGroup &&
      (
        remoteDigestNeedsRepair ||
        !remoteHasCursorDetail ||
        (remoteGroupLatest && this.compareCursors(localGroupLatest, remoteGroupLatest) > 0)
      )
    ) {
      void this.sendNewestFeedPageToPeer(
        peerHash,
        groupId,
        RETICULUM_CHAT_ALL_CHANNELS_ID,
        localGroupLatest
      );
      loggerLog(
        `[ReticulumChat] Sync push group=${groupId} peer=${peerHash.slice(0, 16)} newest=${localGroupLatest.eventId} reason=peer-behind`
      );
      pushedFromChannelDigest = true;
    }
    if (
      !requestedFromChannelDigest &&
      !pushedFromChannelDigest &&
      (
        (remoteGroupLatest &&
          (!localGroupLatest || this.compareCursors(remoteGroupLatest, localGroupLatest) > 0)) ||
        (!remoteGroupLatest && remoteDigestNeedsRepair)
      )
    ) {
      if (this.shouldRequestGroupRepair(peerHash, groupId)) {
        const channelsToRepair = this.db
          .getChannels(groupId, true)
          .filter((channel) => channel.readMode !== RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS)
          .slice(0, RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP);
        const knownRepairChannelIds = channelsToRepair
          .map((channel) => normalizeReticulumChatChannelId(channel.channelId))
          .filter((channelId) =>
            channelId !== RETICULUM_CHAT_DEFAULT_CHANNEL_ID ||
            this.db.getLatestFeedCursor(groupId, RETICULUM_CHAT_DEFAULT_CHANNEL_ID) != null
          );
        const repairChannelIds = remoteGroupLatest
          ? (
              knownRepairChannelIds.length
                ? knownRepairChannelIds
                : [RETICULUM_CHAT_ALL_CHANNELS_ID]
            )
          : [RETICULUM_CHAT_ALL_CHANNELS_ID];
        for (const channelId of repairChannelIds) {
          const localLatest =
            channelId === RETICULUM_CHAT_ALL_CHANNELS_ID
              ? null
              : this.db.getLatestFeedCursor(groupId, channelId);
          const afterCursor = remoteGroupLatest ? localLatest : null;
          if (remoteGroupLatest && !afterCursor) {
            void this.requestPeerEventById(peerHash, groupId, remoteGroupLatest.eventId, 'cold-group-latest');
            this.sendRepairFeedRequest(peerHash, {
              t: 'RCHAT',
              k: 'feed_req',
              g: groupId,
              c: channelId,
              before: this.cursorToWire(remoteGroupLatest),
              inc: 1,
              limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
            }, 'cold-group-latest');
          } else {
            this.sendRepairFeedRequest(peerHash, {
              t: 'RCHAT',
              k: 'feed_req',
              g: groupId,
              c: channelId,
              ...(afterCursor ? { after: this.cursorToWire(afterCursor) } : {}),
              limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
            }, 'group-digest-repair');
          }
        }
      }
    }
    if (
      wire.more === true &&
      Number.isInteger(wire.nextOffset) &&
      Number(wire.nextOffset) >= 0
    ) {
      void this.sendToPeer(
        peerHash,
        {
          t: 'RCHAT',
          k: 'digest_req',
          g: groupId,
          offset: Number(wire.nextOffset),
          limit: RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP,
        }
      );
    }
  }

  private async handleDigestReq(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    if (!this.canServeGroupHistory(groupId)) {
      this.relayGroupControlRequest(
        'digest_req',
        groupId,
        wire,
        peerHash,
        this.hashControlPayload({
          offset: wire.offset,
          limit: wire.limit,
        })
      );
      return;
    }
    if (!this.shouldServeControlRequest(wire, groupId, peerHash)) return;
    const rawOffset = Number(wire.offset);
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const limit = this.normalizeDigestLimit(wire.limit);
    await this.sendToPeer(peerHash, this.buildGroupDigestWire(groupId, offset, limit));
  }

  private relayResponseOptionsFromWire(
    wire: Record<string, unknown>
  ): Omit<ReticulumChatEventOfferOptions, 'continuation'> | undefined {
    const recipientPeerHash = this.routePeerHash(wire.o);
    const relayRequestId = this.normalizeGroupControlRequestId(wire.rid);
    const sourcePeerHash = this.localPeerHash();
    if (!recipientPeerHash && !relayRequestId && !sourcePeerHash) return undefined;
    return {
      ...(recipientPeerHash ? { recipientPeerHash } : {}),
      ...(relayRequestId ? { relayRequestId } : {}),
      ...(sourcePeerHash ? { sourcePeerHash } : {}),
    };
  }

  private getFeedPageEvents(
    groupId: number,
    channelId: string,
    before: ReticulumChatFeedCursor | null,
    after: ReticulumChatFeedCursor | null,
    includeBeforeCursor: boolean,
    limit: number,
    priority?: ReticulumChatFeedPriority
  ): ReticulumChatEvent[] {
    if (priority === 'metadata') {
      if (before) {
        return includeBeforeCursor
          ? this.db.getChannelMetadataPageAtOrBefore(groupId, before, limit)
          : this.db.getChannelMetadataPageBefore(groupId, before, limit);
      }
      return this.db.getChannelMetadataPageAfter(groupId, after, limit);
    }
    return channelId === RETICULUM_CHAT_ALL_CHANNELS_ID
      ? (
          before
            ? (
                includeBeforeCursor
                  ? this.db.getGroupFeedPageAtOrBefore(groupId, before, limit)
                  : this.db.getGroupFeedPageBefore(groupId, before, limit)
              )
            : this.db.getGroupFeedPageAfter(groupId, after, limit)
        )
      : (
          before
            ? (
                includeBeforeCursor
                  ? this.db.getFeedPageAtOrBefore(groupId, channelId, before, limit)
                  : this.db.getFeedPageBefore(groupId, channelId, before, limit)
              )
            : this.db.getFeedPageAfter(groupId, channelId, after, limit)
        );
  }

  private isChannelAdminPrivate(groupId: number, channelId: string): boolean {
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    if (!normalizedChannelId || normalizedChannelId === RETICULUM_CHAT_ALL_CHANNELS_ID) {
      return false;
    }
    const channel = this.db.getChannel(groupId, normalizedChannelId);
    return channel?.readMode === RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS;
  }

  private async canRequesterReadChannel(
    groupId: number,
    channelId: string,
    requesterAddress?: string
  ): Promise<boolean> {
    if (!this.isChannelAdminPrivate(groupId, channelId)) return true;
    const normalizedAddress =
      typeof requesterAddress === 'string' ? requesterAddress.trim() : '';
    if (!normalizedAddress) return false;
    return this.isValidatedGroupAdmin(groupId, normalizedAddress);
  }

  private async canRequesterReadEvent(
    event: ReticulumChatEvent,
    requesterAddress?: string
  ): Promise<boolean> {
    if (CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) return true;
    return this.canRequesterReadChannel(
      event.groupId,
      normalizeReticulumChatChannelId(event.channelId),
      requesterAddress
    );
  }

  private async canLocalUserReadEvent(event: ReticulumChatEvent): Promise<boolean> {
    if (CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) return true;
    const channelId = normalizeReticulumChatChannelId(event.channelId);
    if (!this.isChannelAdminPrivate(event.groupId, channelId)) return true;
    if (this.localGroupAdminIds.has(event.groupId)) return true;
    const localAddress = this.localGroupAddresses.get(event.groupId);
    if (!localAddress) return false;
    return this.isValidatedGroupAdmin(event.groupId, localAddress);
  }

  private async filterEventsForRequesterReadAccess(
    groupId: number,
    events: ReticulumChatEvent[],
    requesterAddress?: string
  ): Promise<ReticulumChatEvent[]> {
    if (events.length === 0) return events;
    const adminPrivateChannels = new Set<string>();
    for (const event of events) {
      if (event.groupId !== groupId || CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) {
        continue;
      }
      const channelId = normalizeReticulumChatChannelId(event.channelId);
      if (this.isChannelAdminPrivate(groupId, channelId)) {
        adminPrivateChannels.add(channelId);
      }
    }
    if (adminPrivateChannels.size === 0) return events;
    const normalizedAddress =
      typeof requesterAddress === 'string' ? requesterAddress.trim() : '';
    const requesterIsAdmin = normalizedAddress
      ? await this.isValidatedGroupAdmin(groupId, normalizedAddress)
      : false;
    if (requesterIsAdmin) return events;
    return events.filter((event) => {
      if (event.groupId !== groupId || CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) {
        return true;
      }
      return !adminPrivateChannels.has(normalizeReticulumChatChannelId(event.channelId));
    });
  }

  private async handleFeedReq(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    if (!this.canServeGroupHistory(groupId)) {
      this.relayGroupControlRequest(
        'feed_req',
        groupId,
        wire,
        peerHash,
        this.hashControlPayload({
          c: wire.c,
          after: wire.after,
          before: wire.before,
          inc: wire.inc,
          p: wire.p,
          limit: wire.limit,
        })
      );
      return;
    }
    if (!this.shouldServeControlRequest(wire, groupId, peerHash)) return;
    const channelId =
      wire.c === RETICULUM_CHAT_ALL_CHANNELS_ID
        ? RETICULUM_CHAT_ALL_CHANNELS_ID
        : normalizeReticulumChatChannelId(wire.c);
    const limit = this.normalizeFeedLimit(wire.limit);
    const before = this.cursorFromWire(wire.before);
    const after = before ? null : this.cursorFromWire(wire.after);
    const includeBeforeCursor = before != null && wire.inc === 1;
    const priority = feedPriorityFromWire(wire.p);
    if (wire.p != null && !priority) return;
    const events = this.getFeedPageEvents(
      groupId,
      channelId,
      before,
      after,
      includeBeforeCursor,
      limit + 1,
      priority
    );
    const hasMore = events.length > limit;
    const visibleEvents = before && hasMore
      ? events.slice(events.length - limit)
      : events.slice(0, limit);
    const readableEvents = await this.filterEventsForRequesterReadAccess(
      groupId,
      visibleEvents
    );
    if (readableEvents.length) this.db.markServed(readableEvents.map((event) => event.eventId));
    await this.sendEventBatchOrResourceDigest(
      peerHash,
      groupId,
      channelId,
      readableEvents,
      hasMore,
      before ? 'before' : 'after',
      this.relayResponseOptionsFromWire(wire),
      priority
    );
  }

  private async handleRangeReq(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    if (!this.canServeGroupHistory(groupId)) {
      this.relayGroupControlRequest(
        'range_req',
        groupId,
        wire,
        peerHash,
        this.hashControlPayload({
          ranges: wire.ranges,
          limit: wire.limit,
        })
      );
      return;
    }
    if (!this.shouldServeControlRequest(wire, groupId, peerHash)) return;
    if (!Array.isArray(wire.ranges)) return;
    const limit = this.normalizeFeedLimit(wire.limit);
    let budget = limit;
    for (const rawRange of wire.ranges.slice(0, RETICULUM_CHAT_MAX_RECENT_AUTHOR_SAMPLE)) {
      const normalizedRange = normalizeReticulumChatAuthorRange(rawRange);
      if (!normalizedRange) continue;
      const { a: author, from, to } = normalizedRange;
      if (budget <= 0) break;
      const eventsWithProbe = this.db.getAuthorEventsRange(groupId, author, from, to, budget + 1);
      const events = eventsWithProbe.slice(0, budget);
      if (events.length === 0) continue;
      const hasMore = eventsWithProbe.length > events.length;
      const readableEvents = await this.filterEventsForRequesterReadAccess(groupId, events);
      if (readableEvents.length === 0) continue;
      this.db.markServed(readableEvents.map((event) => event.eventId));
      await this.sendEventBatchOrResourceDigest(
        peerHash,
        groupId,
        RETICULUM_CHAT_ALL_CHANNELS_ID,
        readableEvents,
        hasMore,
        'range',
        {
          ...this.relayResponseOptionsFromWire(wire),
          repairRange: normalizedRange,
        }
      );
      budget -= readableEvents.length;
      if (budget <= 0) break;
    }
  }

  private async handleEventBatch(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    if (!this.localGroupIds.has(groupId) || !this.subscribedGroups.has(groupId)) return;
    if (this.shouldDropDuplicateInboundControlWire(wire, groupId, peerHash)) return;
    const allChannels = wire.c === RETICULUM_CHAT_ALL_CHANNELS_ID;
    const channelId = allChannels
      ? RETICULUM_CHAT_ALL_CHANNELS_ID
      : normalizeReticulumChatChannelId(wire.c);
    const batch = wire.batch && typeof wire.batch === 'object' && !Array.isArray(wire.batch)
      ? wire.batch as Partial<ReticulumChatEventBatchWire>
      : null;
    if (!batch || !Array.isArray(batch.events)) return;
    const priority = feedPriorityFromWire(batch.p);
    if (batch.p != null && !priority) return;
    const incomingEvents = batch.events.slice(0, RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS);
    const validWindowEvents: ReticulumChatEvent[] = [];
    for (const candidate of incomingEvents) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const event = candidate as ReticulumChatEvent;
      if (
        event.groupId !== groupId ||
        (priority === 'metadata' && !CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) ||
        (!allChannels && normalizeReticulumChatChannelId(event.channelId) !== channelId)
      ) {
        this.notePeerViolation(peerHash, 'event_batch_out_of_bounds');
        continue;
      }
      if (!validateReticulumChatEventShape(event, this.now()) || !verifyReticulumChatEvent(event)) {
        this.notePeerViolation(peerHash, 'event_batch_invalid_event');
        continue;
      }
      if (!(await this.canAcceptEventForChannelWritePolicy(event))) {
        this.notePeerViolation(peerHash, 'event_batch_channel_write_forbidden');
        continue;
      }
      if (!(await this.canLocalUserReadEvent(event))) {
        this.notePeerViolation(peerHash, 'event_batch_channel_read_forbidden');
        continue;
      }
      validWindowEvents.push(event);
      this.noteEventSourcePeer(event.eventId, peerHash);
      this.requestMissingAuthorRangeBeforeAccept(event, peerHash);
      const inserted = this.acceptEvent(event, false);
      if (inserted) {
        this.pendingEventPulls.delete(this.eventPullKey(event.groupId, event.eventId));
        this.emit('event', { event });
      }
    }
    const start = this.cursorFromWire(batch.start);
    const end = this.cursorFromWire(batch.end);
    if (
      !allChannels &&
      start &&
      end &&
      typeof batch.wh === 'string' &&
      batch.wh === this.db.computeWindowHash(validWindowEvents)
    ) {
      this.db.upsertVerifiedWindow(groupId, channelId, start, end, batch.wh, this.now());
    } else if (!allChannels && validWindowEvents.length > 0) {
      this.notePeerViolation(peerHash, 'event_batch_window_hash_mismatch');
    }
    if (batch.more === true) {
      const direction = batch.dir === 'before' ? 'before' : 'after';
      const cursor = this.cursorFromWire(direction === 'before' ? batch.start : batch.end);
      if (cursor) {
        this.sendRepairFeedRequest(peerHash, {
          t: 'RCHAT',
          k: 'feed_req',
          g: groupId,
          c: channelId,
          [direction]: this.cursorToWire(cursor),
          ...(feedPriorityToWire(priority) ? { p: feedPriorityToWire(priority) } : {}),
          limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
        }, 'event-batch-more');
      }
    }
  }

  private requestMissingAuthorRangeBeforeAccept(
    event: ReticulumChatEvent,
    peerHash: string
  ): void {
    const localMaxSeq = this.db.getAuthorMaxSeq(event.groupId, event.authorAddress);
    if (event.authorSeq <= localMaxSeq + 1) return;
    const fromSeq = localMaxSeq + 1;
    const toSeq = event.authorSeq - 1;
    this.db.upsertMissingRange(
      event.groupId,
      event.authorAddress,
      fromSeq,
      toSeq,
      peerHash,
      this.now()
    );
    this.sendAuthorRangeRepairRequests(
      event.groupId,
      peerHash,
      [{ a: event.authorAddress, from: fromSeq, to: toSeq }],
      'incoming_event_gap'
    );
  }

  private shouldRequestAuthorGapRepair(peerHash: string, groupId: number): boolean {
    const key = `${peerHash.trim().toLowerCase()}:${groupId}`;
    const now = this.now();
    const lastRequestedAt = this.recentAuthorGapRepairRequests.get(key) ?? 0;
    if (now - lastRequestedAt < RETICULUM_CHAT_AUTHOR_GAP_REPAIR_DEBOUNCE_MS) return false;
    this.recentAuthorGapRepairRequests.set(key, now);
    return true;
  }

  private authorGapSuppressionKey(
    peerHash: string,
    groupId: number,
    range: ReticulumChatAuthorRange
  ): string {
    return [
      peerHash.trim().toLowerCase(),
      groupId,
      range.a.trim(),
      Math.max(1, Math.floor(range.from)),
      Math.max(1, Math.floor(range.to)),
    ].join('|');
  }

  private compactAuthorGapNoProgressSuppressions(now = this.now()): void {
    for (const [key, expiresAt] of this.authorGapNoProgressSuppressions) {
      if (expiresAt <= now) this.authorGapNoProgressSuppressions.delete(key);
    }
    if (this.authorGapNoProgressSuppressions.size <= RETICULUM_CHAT_AUTHOR_GAP_NO_PROGRESS_MAX) {
      return;
    }
    const sorted = [...this.authorGapNoProgressSuppressions.entries()]
      .sort((a, b) => a[1] - b[1]);
    for (
      const [key] of sorted.slice(
        0,
        this.authorGapNoProgressSuppressions.size - RETICULUM_CHAT_AUTHOR_GAP_NO_PROGRESS_MAX
      )
    ) {
      this.authorGapNoProgressSuppressions.delete(key);
    }
  }

  private isAuthorGapRangeSuppressed(
    peerHash: string,
    groupId: number,
    range: ReticulumChatAuthorRange,
    now = this.now()
  ): boolean {
    this.compactAuthorGapNoProgressSuppressions(now);
    const key = this.authorGapSuppressionKey(peerHash, groupId, range);
    const expiresAt = this.authorGapNoProgressSuppressions.get(key) ?? 0;
    if (expiresAt <= now) {
      this.authorGapNoProgressSuppressions.delete(key);
      return false;
    }
    return true;
  }

  private markAuthorGapRangeNoProgress(
    peerHash: string,
    groupId: number,
    range: ReticulumChatAuthorRange,
    reason: string
  ): void {
    const normalized = normalizeReticulumChatAuthorRange(range);
    if (!normalized) return;
    const peer = peerHash.trim().toLowerCase();
    if (!peer) return;
    const expiresAt = this.now() + RETICULUM_CHAT_AUTHOR_GAP_NO_PROGRESS_TTL_MS;
    this.authorGapNoProgressSuppressions.set(
      this.authorGapSuppressionKey(peer, groupId, normalized),
      expiresAt
    );
    this.compactAuthorGapNoProgressSuppressions();
    loggerLog(
      `[ReticulumChat] author_gap_range_no_progress_suppressed group=${groupId} peer=${peer.slice(0, 16)} author=${normalized.a} from=${normalized.from} to=${normalized.to} ttlMs=${RETICULUM_CHAT_AUTHOR_GAP_NO_PROGRESS_TTL_MS} reason=${reason}`
    );
  }

  private clearAuthorGapRangeSuppression(
    peerHash: string,
    groupId: number,
    range: ReticulumChatAuthorRange
  ): void {
    const normalized = normalizeReticulumChatAuthorRange(range);
    if (!normalized) return;
    const peer = peerHash.trim().toLowerCase();
    if (!peer) return;
    this.authorGapNoProgressSuppressions.delete(
      this.authorGapSuppressionKey(peer, groupId, normalized)
    );
  }

  private compactHistoryPageNoProgressSuppressions(now = this.now()): void {
    for (const [key, expiresAt] of this.historyPageNoProgressSuppressions) {
      if (expiresAt <= now) this.historyPageNoProgressSuppressions.delete(key);
    }
    for (const [key, expiresAt] of this.historyPageHashNoProgressSuppressions) {
      if (expiresAt <= now) this.historyPageHashNoProgressSuppressions.delete(key);
    }
    if (this.historyPageNoProgressSuppressions.size > RETICULUM_CHAT_HISTORY_PAGE_NO_PROGRESS_MAX) {
      const sorted = [...this.historyPageNoProgressSuppressions.entries()]
        .sort((a, b) => a[1] - b[1]);
      for (
        const [key] of sorted.slice(
          0,
          this.historyPageNoProgressSuppressions.size - RETICULUM_CHAT_HISTORY_PAGE_NO_PROGRESS_MAX
        )
      ) {
        this.historyPageNoProgressSuppressions.delete(key);
      }
    }
    if (this.historyPageHashNoProgressSuppressions.size > RETICULUM_CHAT_HISTORY_PAGE_NO_PROGRESS_MAX) {
      const sorted = [...this.historyPageHashNoProgressSuppressions.entries()]
        .sort((a, b) => a[1] - b[1]);
      for (
        const [key] of sorted.slice(
          0,
          this.historyPageHashNoProgressSuppressions.size - RETICULUM_CHAT_HISTORY_PAGE_NO_PROGRESS_MAX
        )
      ) {
        this.historyPageHashNoProgressSuppressions.delete(key);
      }
    }
  }

  private historyPageHashSuppressionKey(
    peerHash: string,
    offer: ReticulumChatEventPageOffer
  ): string {
    return [
      peerHash.trim().toLowerCase(),
      offer.groupId,
      offer.channelId,
      offer.direction,
      offer.priority ?? 'normal',
      offer.pageHash.trim().toLowerCase(),
    ].join('|');
  }

  private isHistoryPageRequestSuppressed(requestKey: string, now = this.now()): boolean {
    this.compactHistoryPageNoProgressSuppressions(now);
    const expiresAt = this.historyPageNoProgressSuppressions.get(requestKey) ?? 0;
    if (expiresAt <= now) {
      this.historyPageNoProgressSuppressions.delete(requestKey);
      return false;
    }
    return true;
  }

  private isHistoryPageHashSuppressed(
    peerHash: string,
    offer: ReticulumChatEventPageOffer,
    now = this.now()
  ): boolean {
    this.compactHistoryPageNoProgressSuppressions(now);
    const key = this.historyPageHashSuppressionKey(peerHash, offer);
    const expiresAt = this.historyPageHashNoProgressSuppressions.get(key) ?? 0;
    if (expiresAt <= now) {
      this.historyPageHashNoProgressSuppressions.delete(key);
      return false;
    }
    return true;
  }

  private markHistoryPageNoProgress(
    peerHash: string,
    offer: ReticulumChatEventPageOffer,
    reason: string
  ): void {
    const peer = peerHash.trim().toLowerCase();
    if (!peer || offer.direction === 'range') return;
    const expiresAt = this.now() + RETICULUM_CHAT_HISTORY_PAGE_NO_PROGRESS_TTL_MS;
    const requestKey = this.directHistoryPageTransferKeys.get(offer.transferId);
    if (requestKey) {
      this.historyPageNoProgressSuppressions.set(requestKey, expiresAt);
    }
    this.historyPageHashNoProgressSuppressions.set(
      this.historyPageHashSuppressionKey(peer, offer),
      expiresAt
    );
    this.compactHistoryPageNoProgressSuppressions();
    loggerLog(
      `[ReticulumChat] history_page_no_progress_suppressed group=${offer.groupId} channel=${offer.channelId} peer=${peer.slice(0, 16)} direction=${offer.direction} page=${offer.pageHash.slice(0, 12)} ttlMs=${RETICULUM_CHAT_HISTORY_PAGE_NO_PROGRESS_TTL_MS} reason=${reason}`
    );
  }

  private requestKnownAuthorGaps(
    groupId: number,
    peerHash: string,
    reason: string,
    force = false
  ): boolean {
    const peer = peerHash.trim().toLowerCase();
    if (!peer || !this.localGroupIds.has(groupId) || !this.subscribedGroups.has(groupId)) {
      return false;
    }
    const gaps = this.db.getAuthorSequenceGaps(
      groupId,
      RETICULUM_CHAT_MAX_RECENT_AUTHOR_SAMPLE
    );
    if (gaps.length === 0) return false;
    if (!force && !this.shouldRequestAuthorGapRepair(peer, groupId)) return false;
    if (force) {
      this.recentAuthorGapRepairRequests.set(`${peer}:${groupId}`, this.now());
    }
    const now = this.now();
    const ranges = gaps.flatMap((gap) => {
      const range = { a: gap.authorAddress, from: gap.fromSeq, to: gap.toSeq };
      const pagedRange = this.newestAuthorRangePage(range);
      if (
        this.isAuthorGapRangeSuppressed(peer, groupId, range, now) ||
        this.isAuthorGapRangeSuppressed(peer, groupId, pagedRange, now)
      ) {
        return [];
      }
      this.db.upsertMissingRange(
        groupId,
        gap.authorAddress,
        gap.fromSeq,
        gap.toSeq,
        peer,
        now
      );
      return [range];
    });
    if (ranges.length === 0) {
      loggerLog(
        `[ReticulumChat] author_gap_repair_suppressed group=${groupId} peer=${peer.slice(0, 16)} gaps=${gaps.length} reason=${reason}`
      );
      return false;
    }
    loggerLog(
      `[ReticulumChat] Requesting author gap repair group=${groupId} peer=${peer.slice(0, 16)} gaps=${ranges.length} reason=${reason}`
    );
    this.sendAuthorRangeRepairRequests(groupId, peer, ranges, reason);
    return true;
  }

  private sendAuthorRangeRepairRequests(
    groupId: number,
    peerHash: string,
    ranges: Array<{ a: string; from: number; to: number }>,
    reason: string
  ): void {
    const peer = peerHash.trim().toLowerCase();
    for (const range of ranges) {
      const normalizedRange = normalizeReticulumChatAuthorRange(range);
      if (!normalizedRange) continue;
      const pagedRange = this.newestAuthorRangePage(normalizedRange);
      if (
        this.isAuthorGapRangeSuppressed(peer, groupId, normalizedRange) ||
        this.isAuthorGapRangeSuppressed(peer, groupId, pagedRange)
      ) {
        loggerLog(
          `[ReticulumChat] author_gap_range_repair_suppressed group=${groupId} peer=${peer.slice(0, 16)} author=${normalizedRange.a} from=${normalizedRange.from} to=${normalizedRange.to} reason=${reason}`
        );
        continue;
      }
      const wire: ReticulumChatWire = {
        t: 'RCHAT',
        k: 'range_req',
        g: groupId,
        ranges: [pagedRange],
        limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
      };
      if (!wireFitsReticulum(wire)) {
        loggerWarn(
          `[ReticulumChat] Skipping oversized author gap repair group=${groupId} author=${pagedRange.a} from=${pagedRange.from} to=${pagedRange.to} reason=${reason}`
        );
        continue;
      }
      if (!peer) {
        loggerWarn(
          `[ReticulumChat] Skipping author gap repair group=${groupId} author=${pagedRange.a} from=${pagedRange.from} to=${pagedRange.to} reason=${reason}: missing peer`
        );
        continue;
      }
      void this.sendToPeer(peer, wire).then((result) => {
        if (result.ok !== false) return;
        loggerWarn(
          `[ReticulumChat] Targeted author gap repair failed group=${groupId} peer=${peer.slice(0, 16)} reason=${result.reason}; retrying targeted path`
        );
      });
    }
  }

  private newestAuthorRangePage(range: { a: string; from: number; to: number }): {
    a: string;
    from: number;
    to: number;
  } {
    const safeFrom = Math.max(1, Math.floor(range.from));
    const safeTo = Math.max(safeFrom, Math.floor(range.to));
    const pageFrom = Math.max(
      safeFrom,
      safeTo - RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS + 1
    );
    return { a: range.a, from: pageFrom, to: safeTo };
  }

  private async sendEventBatchOrResourceDigest(
    peerHash: string,
    groupId: number,
    channelId: string,
    events: ReticulumChatEvent[],
    hasMore: boolean,
    direction: 'after' | 'before' | 'range' = 'after',
    options: Omit<ReticulumChatEventOfferOptions, 'continuation'> = {},
    priority?: ReticulumChatFeedPriority
  ): Promise<void> {
    const pageResult = await this.offerEventPageResource(
      peerHash,
      groupId,
      channelId,
      events,
      hasMore,
      direction,
      options,
      priority
    );
    if (pageResult.ok) {
      await this.sendToPeer(peerHash, this.buildGroupDigestWire(groupId));
      return;
    }
    const failedPageResult = pageResult as Exclude<ReticulumSendResult, { ok: true }>;
    const pageFailureDetail = failedPageResult.error
      ? `${failedPageResult.reason}:${failedPageResult.error}`
      : failedPageResult.reason;
    loggerWarn(
      `[ReticulumChat] Event page resource offer failed group=${groupId} peer=${peerHash.slice(0, 16)} reason=${pageFailureDetail}; page will be retried by digest/range repair`
    );
    await this.sendToPeer(peerHash, this.buildGroupDigestWire(groupId));
  }

  private async fanoutPublishedEvent(
    event: ReticulumChatEvent,
    _channelId: string
  ): Promise<ReticulumSendResult> {
    const interestedPeers = this.getInterestedPeers(event.groupId);
    let offeredCount = 0;
    let lastOfferFailure: Exclude<ReticulumSendResult, { ok: true }> | null = null;
    for (const peerHash of interestedPeers) {
      const result = await this.offerEventResource(peerHash, event.groupId, event.eventId);
      if (result.ok) {
        offeredCount += 1;
      } else {
        lastOfferFailure = result as Exclude<ReticulumSendResult, { ok: true }>;
      }
    }

    const digestResult = await this.fanout(this.buildGroupDigestWire(event.groupId));
    if (digestResult.ok || offeredCount > 0) return { ok: true };
    if (interestedPeers.length > 0 && lastOfferFailure) return lastOfferFailure;
    return digestResult;
  }

  private async sendFeedPageToPeer(
    peerHash: string,
    groupId: number,
    channelId: string,
    after: ReticulumChatFeedCursor | null,
    direction: 'after' | 'before' | 'range' = 'after',
    options: Omit<ReticulumChatEventOfferOptions, 'continuation'> = {},
    priority?: ReticulumChatFeedPriority
  ): Promise<void> {
    const before = direction === 'before' && after ? after : null;
    const afterCursor = before ? null : after;
    const events = this.getFeedPageEvents(
      groupId,
      channelId,
      before,
      afterCursor,
      false,
      RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS + 1,
      priority
    );
    const hasMore = events.length > RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS;
    const visibleEvents = direction === 'before' && hasMore
      ? events.slice(events.length - RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS)
      : events.slice(0, RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS);
    const readableEvents = await this.filterEventsForRequesterReadAccess(
      groupId,
      visibleEvents
    );
    if (readableEvents.length) this.db.markServed(readableEvents.map((event) => event.eventId));
    await this.sendEventBatchOrResourceDigest(
      peerHash,
      groupId,
      channelId,
      readableEvents,
      hasMore,
      direction,
      options,
      priority
    );
  }

  private async sendNewestFeedPageToPeer(
    peerHash: string,
    groupId: number,
    channelId: string,
    latestCursor: ReticulumChatFeedCursor | null,
    options: Omit<ReticulumChatEventOfferOptions, 'continuation'> = {}
  ): Promise<void> {
    if (!latestCursor) return;
    const events = channelId === RETICULUM_CHAT_ALL_CHANNELS_ID
      ? this.db.getGroupFeedPageAtOrBefore(
          groupId,
          latestCursor,
          RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS + 1
        )
      : this.db.getFeedPageAtOrBefore(
          groupId,
          channelId,
          latestCursor,
          RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS + 1
        );
    const hasMore = events.length > RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS;
    const visibleEvents = hasMore
      ? events.slice(events.length - RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS)
      : events.slice(0, RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS);
    if (visibleEvents.length) this.db.markServed(visibleEvents.map((event) => event.eventId));
    await this.sendEventBatchOrResourceDigest(
      peerHash,
      groupId,
      channelId,
      visibleEvents,
      hasMore,
      'before',
      options
    );
  }

  private async pushNewestHistoryPageToPeer(
    peerHash: string,
    groupId: number,
    reason: string
  ): Promise<void> {
    const peer = peerHash.trim().toLowerCase();
    if (!peer || !this.canServeGroupHistory(groupId)) return;
    const latestCursor = this.getGroupDigestLatestCursor(groupId);
    if (!latestCursor) return;
    if (!this.shouldPushNewestHistoryPage(peer, groupId)) return;
    try {
      await this.sendNewestFeedPageToPeer(
        peer,
        groupId,
        RETICULUM_CHAT_ALL_CHANNELS_ID,
        latestCursor
      );
      loggerLog(
        `[ReticulumChat] Sync page push group=${groupId} peer=${peer.slice(0, 16)} newest=${latestCursor.eventId} reason=${reason}`
      );
    } catch (err) {
      loggerWarn(
        `[ReticulumChat] Sync page push failed group=${groupId} peer=${peer.slice(0, 16)} reason=${reason}:`,
        err
      );
    }
  }

  private async pushMetadataHistoryPageToPeer(
    peerHash: string,
    groupId: number,
    reason: string
  ): Promise<void> {
    const peer = peerHash.trim().toLowerCase();
    if (!peer || !this.canServeGroupHistory(groupId)) return;
    if (!this.shouldPushMetadataHistoryPage(peer, groupId)) return;
    const events = this.db.getChannelMetadataEvents(
      groupId,
      RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS + 1
    );
    if (events.length === 0) return;
    const hasMore = events.length > RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS;
    const visibleEvents = hasMore
      ? events.slice(events.length - RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS)
      : events.slice(0, RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS);
    if (visibleEvents.length) this.db.markServed(visibleEvents.map((event) => event.eventId));
    try {
      await this.sendEventBatchOrResourceDigest(
        peer,
        groupId,
        RETICULUM_CHAT_ALL_CHANNELS_ID,
        visibleEvents,
        hasMore,
        'before',
        {},
        'metadata'
      );
      loggerLog(
        `[ReticulumChat] Metadata sync page push group=${groupId} peer=${peer.slice(0, 16)} events=${visibleEvents.length} reason=${reason}`
      );
    } catch (err) {
      loggerWarn(
        `[ReticulumChat] Metadata sync page push failed group=${groupId} peer=${peer.slice(0, 16)} reason=${reason}:`,
        err
      );
    }
  }

  private sendRepairFeedRequest(
    peerHash: string,
    wire: Extract<ReticulumChatWire, { k: 'feed_req' }>,
    reason: string
  ): void {
    void this.sendTargetedSyncControlRequest(peerHash, wire, reason);
  }

  private async buildSignedHistoryPageRequest(
    groupId: number,
    channelId: string,
    cursor: ReticulumChatFeedCursor | null,
    direction: 'after' | 'before',
    includeCursor: boolean,
    priority?: ReticulumChatFeedPriority
  ): Promise<ReticulumChatHistoryPageRequestWire | null> {
    if (!this.signLocalFields) return null;
    const normalizedChannelId =
      channelId === RETICULUM_CHAT_ALL_CHANNELS_ID
        ? RETICULUM_CHAT_ALL_CHANNELS_ID
        : normalizeReticulumChatChannelId(channelId);
    const cursorWire = this.cursorToWire(cursor);
    const timestamp = this.now();
    const signed = await this.signLocalFields({
      groupId,
      channelId: normalizedChannelId,
      direction,
      priority,
      after: direction === 'after' ? cursorWire ?? null : null,
      before: direction === 'before' ? cursorWire ?? null : null,
      includeCursor,
      limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
      timestamp,
      type: 'RCHAT_HISTORY_PAGE_REQ',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign history page request:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return null;
    }
    const requesterIsMember = await this.isValidatedGroupMember(groupId, signed.authorAddress);
    if (!requesterIsMember) {
      loggerWarn(
        `[ReticulumChat] Refusing history page request for group=${groupId}: local signer is not a group member`
      );
      return null;
    }
    const request: ReticulumChatHistoryPageRequestWire = {
      c: normalizedChannelId,
      d: direction,
      ...(feedPriorityToWire(priority) ? { p: feedPriorityToWire(priority) } : {}),
      ...(direction === 'after' && cursorWire ? { after: cursorWire } : {}),
      ...(direction === 'before' && cursorWire ? { before: cursorWire } : {}),
      ...(includeCursor ? { inc: 1 as const } : {}),
      limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
      a: signed.authorAddress,
      pk: signed.authorPublicKey,
      ts: timestamp,
      sig: signed.signature,
    };
    return verifyReticulumChatHistoryPageRequest(groupId, request, timestamp) ? request : null;
  }

  private historyPageCursorKey(cursor: ReticulumChatFeedCursor | null): string {
    if (!cursor) return 'none';
    return `${cursor.feedTimestamp}:${cursor.eventId}`;
  }

  private directHistoryPageRequestKey(
    peerHash: string,
    groupId: number,
    channelId: string,
    direction: 'after' | 'before',
    cursor: ReticulumChatFeedCursor | null,
    includeCursor: boolean,
    priority?: ReticulumChatFeedPriority
  ): string {
    return [
      peerHash.trim().toLowerCase(),
      groupId,
      channelId,
      direction,
      includeCursor ? 'inc' : 'exc',
      priority ?? 'normal',
      this.historyPageCursorKey(cursor),
    ].join('|');
  }

  private trackDirectHistoryPageRequest(
    key: string,
    offer: ReticulumChatEventPageOffer
  ): void {
    this.directHistoryPageRequests.set(offer.transferId, offer);
    this.directHistoryPageRequestKeys.set(key, offer.transferId);
    this.directHistoryPageTransferKeys.set(offer.transferId, key);
  }

  private removeDirectHistoryPageRequest(transferId: string): ReticulumChatEventPageOffer | undefined {
    const offer = this.directHistoryPageRequests.get(transferId);
    this.directHistoryPageRequests.delete(transferId);
    const key = this.directHistoryPageTransferKeys.get(transferId);
    if (key) {
      this.directHistoryPageTransferKeys.delete(transferId);
      if (this.directHistoryPageRequestKeys.get(key) === transferId) {
        this.directHistoryPageRequestKeys.delete(key);
      }
    }
    return offer;
  }

  private cancelDirectHistoryPageRequest(transferId: string, reason: string): void {
    const offer = this.removeDirectHistoryPageRequest(transferId);
    if (!offer || !this.bridge || typeof this.bridge.cancelReticulumResourceDetailed !== 'function') {
      return;
    }
    void this.bridge.cancelReticulumResourceDetailed({
      transferId,
      peerPresenceHash: offer.sourcePeerHash,
      reason,
    }).then((result) => {
      if (!result.ok) {
        const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[ReticulumChat] history_page_link_cancel_failed group=${offer.groupId} peer=${(offer.sourcePeerHash || '').slice(0, 16) || 'unknown'} transfer=${transferId} reason=${failed.error ?? failed.reason ?? 'cancel_failed'}`
        );
      }
    }).catch((err) => {
      loggerWarn(
        `[ReticulumChat] history_page_link_cancel_failed group=${offer.groupId} peer=${(offer.sourcePeerHash || '').slice(0, 16) || 'unknown'} transfer=${transferId} reason=${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  private cancelRelatedDirectHistoryPageRequests(
    offer: ReticulumChatEventPageOffer,
    keepTransferId: string,
    reason: string
  ): void {
    if (offer.direction === 'range') return;
    const sourcePeerHash = (offer.sourcePeerHash || '').trim().toLowerCase();
    for (const [transferId, pending] of [...this.directHistoryPageRequests]) {
      if (transferId === keepTransferId) continue;
      if (pending.direction === 'range') continue;
      if (pending.groupId !== offer.groupId) continue;
      if (pending.channelId !== offer.channelId) continue;
      if (pending.direction !== offer.direction) continue;
      if ((pending.priority ?? '') !== (offer.priority ?? '')) continue;
      if (sourcePeerHash && (pending.sourcePeerHash || '').trim().toLowerCase() !== sourcePeerHash) continue;
      loggerLog(
        `[ReticulumChat] history_page_link_cancelled group=${offer.groupId} channel=${offer.channelId} peer=${(pending.sourcePeerHash || '').slice(0, 16) || 'unknown'} transfer=${transferId} reason=${reason}`
      );
      this.cancelDirectHistoryPageRequest(transferId, reason);
    }
  }

  private didDirectHistoryPageCursorAdvance(
    offer: ReticulumChatEventPageOffer,
    cursor: ReticulumChatFeedCursor
  ): boolean {
    if (offer.direction === 'before') {
      return !offer.start || this.compareCursors(cursor, offer.start) < 0;
    }
    if (offer.direction === 'after') {
      return !offer.end || this.compareCursors(cursor, offer.end) > 0;
    }
    return true;
  }

  private async requestLinkedHistoryPage(
    peerHash: string,
    groupId: number,
    channelId: string,
    cursor: ReticulumChatFeedCursor | null,
    direction: 'after' | 'before',
    includeCursor: boolean,
    reason: string,
    fallbackPeerHash = peerHash,
    priority?: ReticulumChatFeedPriority
  ): Promise<void> {
    const peer = peerHash.trim().toLowerCase();
    const fallbackPeer = fallbackPeerHash.trim().toLowerCase();
    const normalizedChannelId =
      channelId === RETICULUM_CHAT_ALL_CHANNELS_ID
        ? RETICULUM_CHAT_ALL_CHANNELS_ID
        : normalizeReticulumChatChannelId(channelId);
    const requestKey = this.directHistoryPageRequestKey(
      peer,
      groupId,
      normalizedChannelId,
      direction,
      cursor,
      includeCursor,
      priority
    );
    if (this.isHistoryPageRequestSuppressed(requestKey)) {
      loggerLog(
        `[ReticulumChat] history_page_link_suppressed_no_progress group=${groupId} channel=${normalizedChannelId} peer=${peer.slice(0, 16)} direction=${direction} cursor=${cursor?.eventId ?? 'none'} reason=${reason}`
      );
      return;
    }
    const existingTransferId = this.directHistoryPageRequestKeys.get(requestKey);
    if (existingTransferId) {
      const existingOffer = this.directHistoryPageRequests.get(existingTransferId);
      if (existingOffer) {
        const requestedAt = Number(existingOffer.requestedAt ?? 0);
        const ageMs = requestedAt > 0 ? this.now() - requestedAt : Number.POSITIVE_INFINITY;
        if (ageMs < RETICULUM_CHAT_DIRECT_HISTORY_PAGE_REQUEST_STALE_MS) {
          loggerLog(
            `[ReticulumChat] history_page_link_deduped group=${groupId} channel=${normalizedChannelId} peer=${peer.slice(0, 16)} transfer=${existingTransferId} direction=${direction} cursor=${cursor?.eventId ?? 'none'} ageMs=${Math.max(0, Math.round(ageMs))} reason=${reason}`
          );
          return;
        }
        loggerWarn(
          `[ReticulumChat] history_page_link_stale_retry group=${groupId} channel=${normalizedChannelId} peer=${peer.slice(0, 16)} oldTransfer=${existingTransferId} direction=${direction} cursor=${cursor?.eventId ?? 'none'} ageMs=${Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs)) : -1} reason=${reason}`
        );
        this.removeDirectHistoryPageRequest(existingTransferId);
      } else {
        this.directHistoryPageRequestKeys.delete(requestKey);
        this.directHistoryPageTransferKeys.delete(existingTransferId);
      }
    }
    const fallbackWire: Extract<ReticulumChatWire, { k: 'feed_req' }> = {
      t: 'RCHAT',
      k: 'feed_req',
      g: groupId,
      c: normalizedChannelId,
      ...(direction === 'after' && cursor ? { after: this.cursorToWire(cursor) } : {}),
      ...(direction === 'before' && cursor ? { before: this.cursorToWire(cursor) } : {}),
      ...(includeCursor ? { inc: 1 as const } : {}),
      ...(feedPriorityToWire(priority) ? { p: feedPriorityToWire(priority) } : {}),
      limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
    };
    if (!peer || !this.bridge || typeof this.bridge.acceptReticulumChatResourceDetailed !== 'function') {
      this.sendRepairFeedRequest(fallbackPeer || peer, fallbackWire, `${reason}:linked-unavailable`);
      return;
    }
    const transferId = nodeCrypto.randomBytes(8).toString('hex');
    this.trackDirectHistoryPageRequest(requestKey, {
      transferId,
      groupId,
      channelId: normalizedChannelId,
      direction,
      ...(priority ? { priority } : {}),
      ...(includeCursor ? { includeCursor: true } : {}),
      pageHash: '',
      sizeBytes: RETICULUM_CHAT_MAX_EVENT_PAGE_BYTES,
      eventCount: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
      ...(cursor ? { [direction === 'before' ? 'start' : 'end']: cursor } : {}),
      sourcePeerHash: peer,
      requestedAt: this.now(),
    });
    const request = await this.buildSignedHistoryPageRequest(
      groupId,
      normalizedChannelId,
      cursor,
      direction,
      includeCursor,
      priority
    );
    if (!request) {
      this.removeDirectHistoryPageRequest(transferId);
      this.sendRepairFeedRequest(fallbackPeer || peer, fallbackWire, `${reason}:linked-unavailable`);
      return;
    }
    const pendingOffer = this.directHistoryPageRequests.get(transferId);
    if (pendingOffer) {
      pendingOffer.requesterAddress = request.a;
    }
    let reticulumIdentityPublicKeyBase64 = '';
    try {
      const resolvedIdentity = await this.ensureResourcePeerIdentity(peer, 'history-page-resource');
      if (resolvedIdentity === null) {
        this.removeDirectHistoryPageRequest(transferId);
        this.sendRepairFeedRequest(fallbackPeer || peer, fallbackWire, `${reason}:identity-unavailable`);
        return;
      }
      reticulumIdentityPublicKeyBase64 = resolvedIdentity;
    } catch (err) {
      loggerWarn(
        `[ReticulumChat] Linked history page identity resolve failed group=${groupId} peer=${peer.slice(0, 16)} reason=${err instanceof Error ? err.message : String(err)}`
      );
      this.removeDirectHistoryPageRequest(transferId);
      this.sendRepairFeedRequest(fallbackPeer || peer, fallbackWire, `${reason}:identity-error`);
      return;
    }
    loggerLog(
      `[ReticulumChat] history_page_link_requested group=${groupId} channel=${normalizedChannelId} peer=${peer.slice(0, 16)} transfer=${transferId} direction=${direction} cursor=${cursor?.eventId ?? 'none'} reason=${reason}`
    );
    const result = await this.bridge.acceptReticulumChatResourceDetailed({
      peerPresenceHash: peer,
      reticulumIdentityPublicKeyBase64,
      transferId,
      savePath: this.tempEventBlobPath(`${transferId}.history-page.recv`),
      fileName: `${groupId}-${transferId}.history-page.json`,
      size: RETICULUM_CHAT_MAX_EVENT_PAGE_BYTES,
      metadata: {
        resourceType: 'reticulum_chat_event',
        logicalResourceType: 'reticulum_chat_history_page',
        groupId,
        channelId: normalizedChannelId,
        direction,
        ...(feedPriorityToWire(priority) ? { p: feedPriorityToWire(priority) } : {}),
        variableSize: true,
      },
      authMessage: {
        type: 'RETICULUM_CHAT_HISTORY_PAGE_REQUEST',
        transferId,
        groupId,
        ...request,
        requesterPeerHash: this.bridge.getLocalDestinationHash?.() ?? '',
      },
    });
    if (!result.ok) {
      this.removeDirectHistoryPageRequest(transferId);
      const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[ReticulumChat] history_page_link_failed group=${groupId} peer=${peer.slice(0, 16)} reason=${failed.error ?? failed.reason}; falling back to feed_req`
      );
      this.sendRepairFeedRequest(fallbackPeer || peer, fallbackWire, `${reason}:linked-failed`);
    }
  }

  private async sendTargetedSyncControlRequest(
    peerHash: string,
    wire: ReticulumChatWire,
    reason: string
  ): Promise<void> {
    const peer = peerHash.trim().toLowerCase();
    if (!peer) {
      loggerWarn(
        `[ReticulumChat] Targeted sync control skipped group=${'g' in wire ? wire.g : 'n/a'} kind=${wire.k} reason=missing-peer context=${reason}`
      );
      return;
    }
    const result = await this.sendToPeer(peer, wire);
    if (result.ok !== false) return;
    const failedResult = result as Exclude<ReticulumSendResult, { ok: true }>;
    loggerWarn(
      `[ReticulumChat] Targeted sync control failed group=${'g' in wire ? wire.g : 'n/a'} kind=${wire.k} peer=${peer.slice(0, 16)} reason=${failedResult.reason} context=${reason}; retrying targeted path`
    );
  }

  private requestVisibleWindowRepair(
    peerHash: string,
    groupId: number,
    channelId: string,
    remoteLatest: ReticulumChatFeedCursor,
    localLatest: ReticulumChatFeedCursor | null,
    reason: string
  ): boolean {
    if (!this.shouldRequestGroupRepair(peerHash, groupId, channelId)) return false;
    void this.requestPeerEventById(peerHash, groupId, remoteLatest.eventId, reason);
    this.sendRepairFeedRequest(
      peerHash,
      {
        t: 'RCHAT',
        k: 'feed_req',
        g: groupId,
        c: channelId,
        before: this.cursorToWire(remoteLatest),
        inc: 1,
        limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
      },
      reason
    );
    if (localLatest) {
      void this.sendFeedPageToPeer(peerHash, groupId, channelId, localLatest, 'before').catch((err) => {
        loggerWarn(
          `[ReticulumChat] Sync repair push failed group=${groupId} channel=${channelId} peer=${peerHash.slice(0, 16)} direction=before reason=${reason}:`,
          err
        );
      });
      if (this.compareCursors(localLatest, remoteLatest) > 0) {
        void this.sendFeedPageToPeer(peerHash, groupId, channelId, remoteLatest, 'after').catch((err) => {
          loggerWarn(
            `[ReticulumChat] Sync repair push failed group=${groupId} channel=${channelId} peer=${peerHash.slice(0, 16)} direction=after reason=${reason}:`,
            err
          );
        });
      } else if (this.compareCursors(remoteLatest, localLatest) > 0) {
        this.sendRepairFeedRequest(peerHash, {
          t: 'RCHAT',
          k: 'feed_req',
          g: groupId,
          c: channelId,
          after: this.cursorToWire(localLatest),
          limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
        }, reason);
      }
    }
    loggerLog(
      `[ReticulumChat] Sync repair group=${groupId} channel=${channelId} peer=${peerHash.slice(0, 16)} remoteLatest=${remoteLatest.eventId} localLatest=${localLatest?.eventId ?? 'none'} reason=${reason}`
    );
    return true;
  }

  private async requestPeerEventById(
    peerHash: string,
    groupId: number,
    eventId: string,
    reason: string
  ): Promise<void> {
    if (!eventId || this.db.hasEvent(eventId)) return;
    const request = await this.buildSignedEventRequestWire(groupId, eventId);
    if (!request) {
      loggerWarn(
        `[ReticulumChat] Cannot request repair event ${eventId}: local signing unavailable reason=${reason}`
      );
      return;
    }
    const wire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'event_req',
      g: groupId,
      q: request,
    };
    const result = await this.sendToPeer(peerHash, wire);
    if (result.ok === false) {
      loggerWarn(
        `[ReticulumChat] Repair event request failed group=${groupId} event=${eventId} peer=${peerHash.slice(0, 16)} reason=${reason}:`,
        result.error ?? result.reason
      );
    }
  }

  private compareCursors(a: ReticulumChatFeedCursor, b: ReticulumChatFeedCursor): number {
    return a.feedTimestamp - b.feedTimestamp || a.eventId.localeCompare(b.eventId);
  }

  private normalizeFeedLimit(value: unknown): number {
    const limit = Number(value);
    if (!Number.isFinite(limit)) return RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS;
    return Math.max(1, Math.min(RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS, Math.floor(limit)));
  }

  private normalizeDigestLimit(value: unknown): number {
    const limit = Number(value);
    if (!Number.isFinite(limit)) return RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP;
    return Math.max(1, Math.min(RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP, Math.floor(limit)));
  }

  private notePeerViolation(peerHash: string, reason: string): void {
    const key = peerHash.trim().toLowerCase();
    if (!key) return;
    const now = this.now();
    const existing = this.peerProtocolViolations.get(key);
    const count = existing && now - existing.lastAt < RETICULUM_CHAT_PEER_VIOLATION_COOLDOWN_MS
      ? existing.count + 1
      : 1;
    const cooldownUntil = count >= RETICULUM_CHAT_MAX_PEER_VIOLATIONS_BEFORE_COOLDOWN
      ? now + RETICULUM_CHAT_PEER_VIOLATION_COOLDOWN_MS
      : 0;
    this.peerProtocolViolations.set(key, { count, lastAt: now, cooldownUntil });
    loggerWarn(
      `[ReticulumChat] Peer protocol violation peer=${key} reason=${reason} count=${count}` +
        (cooldownUntil ? ` cooldownMs=${cooldownUntil - now}` : '')
    );
  }

  private isPeerProtocolCooledDown(peerHash: string): boolean {
    const key = peerHash.trim().toLowerCase();
    if (!key) return false;
    const record = this.peerProtocolViolations.get(key);
    if (!record || record.cooldownUntil <= 0) return false;
    const now = this.now();
    if (record.cooldownUntil > now) return true;
    this.peerProtocolViolations.delete(key);
    return false;
  }

  private async yieldEventPageImportTurn(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  private acceptEvent(candidate: unknown, ownEvent: boolean): boolean {
    const now = this.now();
    if (!validateReticulumChatEventShape(candidate, now)) return false;
    const event = candidate;
    if (!this.localGroupIds.has(event.groupId)) return false;
    if (!verifyReticulumChatEvent(event)) return false;
    return this.acceptValidatedEvent(event, ownEvent);
  }

  private acceptsDirectConversation(event: ReticulumDmEvent): boolean {
    if (ownAddressMatches(this.localDmAddresses, event.senderAddress)) return true;
    if (ownAddressMatches(this.localDmAddresses, event.recipientAddress)) return true;
    return false;
  }

  private acceptDirectEvent(
    candidate: unknown,
    ownEvent: boolean,
    options: { deliveryStatus?: ReticulumDmDeliveryStatus } = {}
  ): boolean {
    const now = this.now();
    if (!validateReticulumDmEventShape(candidate, now)) return false;
    const event = candidate;
    if (!this.acceptsDirectConversation(event)) return false;
    if (!verifyReticulumDmEvent(event)) return false;
    if (this.db.hasDirectEvent(event.eventId)) return false;
    const inserted = this.db.insertDirectEvent(
      event,
      ownEvent,
      options.deliveryStatus
    );
    if (inserted) {
      const emittedEvent: ReticulumDmEvent = {
        ...event,
        localDeliveryStatus:
          options.deliveryStatus || (ownEvent ? 'pending' : 'received'),
        localDeliveryUpdatedAt: now,
      };
      const peerAddress = this.localDmAddresses.has(event.senderAddress)
        ? event.recipientAddress
        : event.senderAddress;
      this.emit('directEvent', { event: emittedEvent });
      this.emit('directSummaryChanged', {
        conversationId: event.conversationId,
        peerAddress,
      });
    }
    return inserted;
  }

  private acceptValidatedEvent(
    event: ReticulumChatEvent,
    ownEvent: boolean,
    options: { emitSummary?: boolean } = {}
  ): boolean {
    if (this.db.hasEvent(event.eventId)) return false;
    const inserted = this.db.insertEvent(event, ownEvent);
    if (inserted) {
      this.queueChannelMetadataProjection(event);
      this.observedDbEventIds.add(event.eventId);
      this.writeLocalEventNotification(event);
      if (options.emitSummary !== false) {
        this.emitSummaryChanged(event.groupId, event);
      }
    }
    return inserted;
  }

  async applyChannelMetadataEvent(eventId: string, payload: unknown): Promise<boolean> {
    return (await this.applyChannelMetadataEventForProjection(eventId, payload)) === 'applied';
  }

  private async applyChannelMetadataEventForProjection(
    eventId: string,
    payload: unknown
  ): Promise<ReticulumChatMetadataProjectionResult> {
    if (this.isClosed) return 'deferred';
    const event = this.db.getEvent(eventId);
    if (!event || !CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) {
      loggerWarn(
        `[ReticulumChat] Ignoring channel metadata event ${eventId}: event missing or wrong type`
      );
      return 'skipped';
    }
    const authorAdminStatus = await this.getValidatedGroupAdminStatus(
      event.groupId,
      event.authorAddress
    );
    if (this.isClosed) return 'deferred';
    if (authorAdminStatus === 'unknown') {
      loggerWarn(
        `[ReticulumChat] channel_metadata_projection_deferred event=${event.eventId} group=${event.groupId} type=${event.eventType} author=${event.authorAddress} reason=admin_validation_unavailable`
      );
      return 'deferred';
    }
    if (authorAdminStatus !== 'admin') {
      loggerWarn(
        `[ReticulumChat] channel_metadata_projection_skipped event=${event.eventId} group=${event.groupId} type=${event.eventType} author=${event.authorAddress} reason=author_not_group_admin`
      );
      return 'skipped';
    }
    if (await this.isSupersededChannelMetadataEvent(event, payload)) {
      return 'applied';
    }
    if (event.eventType.startsWith('category_')) {
      const category = this.categoryFromMetadataPayload(event, payload);
      if (!category) {
        loggerWarn(
          `[ReticulumChat] Ignoring category metadata event ${event.eventId}: invalid metadata payload`
        );
        return 'skipped';
      }
      const changed =
        event.eventType === 'category_delete'
          ? this.db.deleteCategory(category.groupId, category.categoryId)
          : this.db.upsertCategory(category);
      if (
        !changed &&
        event.eventType !== 'category_delete' &&
        !this.db.getCategory(category.groupId, category.categoryId)
      ) {
        loggerWarn(
          `[ReticulumChat] Failed to persist category metadata event ${event.eventId}:`,
          category
        );
        return 'deferred';
      }
      this.emitSummaryChanged(event.groupId, event);
      loggerLog(
        `[ReticulumChat] channel_metadata_projection_applied event=${event.eventId} group=${event.groupId} type=${event.eventType} entity=category:${category.categoryId}`
      );
      return 'applied';
    }

    const channel = this.channelFromMetadataPayload(event, payload);
    if (!channel) {
      loggerWarn(
        `[ReticulumChat] Ignoring channel metadata event ${event.eventId}: invalid metadata payload`
      );
      return 'skipped';
    }
    const changed = this.db.upsertChannel(channel);
    if (!changed && !this.db.getChannel(channel.groupId, channel.channelId)) {
      loggerWarn(
        `[ReticulumChat] Failed to persist channel metadata event ${event.eventId}:`,
        channel
      );
      return 'deferred';
    }
    this.emitSummaryChanged(event.groupId, event);
    loggerLog(
      `[ReticulumChat] channel_metadata_projection_applied event=${event.eventId} group=${event.groupId} type=${event.eventType} entity=channel:${channel.channelId}`
    );
    return 'applied';
  }

  getChannels(groupId: number, includeArchived = false): ReticulumGroupChannel[] {
    this.assertGroupId(groupId);
    return this.db.getChannels(groupId, includeArchived);
  }

  getCategories(groupId: number): ReticulumGroupCategory[] {
    this.assertGroupId(groupId);
    return this.db.getCategories(groupId);
  }

  private queueChannelMetadataProjection(event: ReticulumChatEvent): void {
    if (this.isClosed) return;
    if (!CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) return;
    if (this.channelMetadataProjectionAttemptedIds.has(event.eventId)) return;
    if (this.channelMetadataProjectionQueuedIds.has(event.eventId)) return;
    this.channelMetadataProjectionQueuedIds.add(event.eventId);
    this.channelMetadataProjectionQueue.push(event.eventId);
    void this.processChannelMetadataProjectionQueue();
  }

  private queueChannelMetadataProjectionRepair(groupId: number, limit = 500): void {
    if (this.isClosed) return;
    if (!Number.isInteger(groupId) || groupId <= 0) return;
    if (this.channelMetadataProjectionRepairGroups.has(groupId)) return;
    this.channelMetadataProjectionRepairGroups.add(groupId);
    try {
      for (const event of this.db.getChannelMetadataEvents(groupId, limit)) {
        this.queueChannelMetadataProjection(event);
      }
    } finally {
      this.channelMetadataProjectionRepairGroups.delete(groupId);
    }
  }

  private async processChannelMetadataProjectionQueue(): Promise<void> {
    if (this.isClosed) return;
    if (this.channelMetadataProjectionActive) return;
    this.channelMetadataProjectionActive = true;
    try {
      while (!this.isClosed && this.channelMetadataProjectionQueue.length > 0) {
        const eventId = this.channelMetadataProjectionQueue.shift();
        if (!eventId) continue;
        this.channelMetadataProjectionQueuedIds.delete(eventId);
        if (this.channelMetadataProjectionAttemptedIds.has(eventId)) continue;
        const event = this.db.getEvent(eventId);
        if (!event || !CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) continue;
        const result = await this.tryApplyPublicChannelMetadata(event);
        if (result === 'deferred') {
          this.scheduleChannelMetadataProjectionRetry(event.eventId);
        } else {
          this.channelMetadataProjectionAttemptedIds.add(eventId);
        }
        await this.yieldEventPageImportTurn();
      }
    } finally {
      this.channelMetadataProjectionActive = false;
      if (!this.isClosed && this.channelMetadataProjectionQueue.length > 0) {
        void this.processChannelMetadataProjectionQueue();
      }
    }
  }

  private async tryApplyPublicChannelMetadata(
    event: ReticulumChatEvent
  ): Promise<ReticulumChatMetadataProjectionResult> {
    if (!CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) return 'skipped';
    try {
      return await this.applyChannelMetadataEventForProjection(
        event.eventId,
        JSON.parse(event.encryptedPayload)
      );
    } catch {
      // Invalid or legacy-encrypted metadata cannot be projected without a parsed payload.
      return 'skipped';
    }
  }

  private scheduleChannelMetadataProjectionRetry(eventId: string): void {
    if (this.isClosed || !eventId) return;
    if (this.channelMetadataProjectionRetryTimers.has(eventId)) return;
    loggerLog(
      `[ReticulumChat] channel_metadata_projection_retry_scheduled event=${eventId} retryMs=${RETICULUM_CHAT_METADATA_PROJECTION_RETRY_MS}`
    );
    const timer = setTimeout(() => {
      this.channelMetadataProjectionRetryTimers.delete(eventId);
      if (this.isClosed) return;
      const event = this.db.getEvent(eventId);
      if (!event || !CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) return;
      loggerLog(
        `[ReticulumChat] channel_metadata_projection_retry event=${eventId} group=${event.groupId} type=${event.eventType}`
      );
      this.queueChannelMetadataProjection(event);
    }, RETICULUM_CHAT_METADATA_PROJECTION_RETRY_MS);
    this.channelMetadataProjectionRetryTimers.set(eventId, timer);
  }

  private metadataEntityKey(event: ReticulumChatEvent, payload: unknown): string | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const data = payload as Record<string, unknown>;
    if (event.eventType.startsWith('channel_')) {
      const channelId = normalizeReticulumChatChannelId(
        typeof data.channelId === 'string' ? data.channelId : event.channelId
      );
      return channelId ? `channel:${channelId}` : null;
    }
    if (event.eventType.startsWith('category_')) {
      const categoryId = normalizeReticulumChatCategoryId(data.categoryId);
      return categoryId ? `category:${categoryId}` : null;
    }
    return null;
  }

  private async isSupersededChannelMetadataEvent(
    event: ReticulumChatEvent,
    payload: unknown
  ): Promise<boolean> {
    const entityKey = this.metadataEntityKey(event, payload);
    if (!entityKey) return false;
    let cursor = this.eventCursor(event);
    let scanned = 0;
    while (scanned < RETICULUM_CHAT_METADATA_SUPERSEDE_SCAN_LIMIT) {
      const page = this.db.getChannelMetadataPageAfter(
        event.groupId,
        cursor,
        Math.min(101, RETICULUM_CHAT_METADATA_SUPERSEDE_SCAN_LIMIT - scanned)
      );
      if (page.length === 0) return false;
      for (const newerEvent of page) {
        scanned += 1;
        cursor = this.eventCursor(newerEvent);
        let newerPayload: unknown;
        try {
          newerPayload = JSON.parse(newerEvent.encryptedPayload);
        } catch {
          continue;
        }
        if (this.metadataEntityKey(newerEvent, newerPayload) !== entityKey) continue;
        if (!(await this.isValidatedGroupAdmin(newerEvent.groupId, newerEvent.authorAddress))) {
          continue;
        }
        return true;
      }
      if (page.length < 101) return false;
    }
    return false;
  }

  private channelFromMetadataPayload(
    event: ReticulumChatEvent,
    payload: unknown
  ): ReticulumGroupChannel | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const data = payload as Record<string, unknown>;
    const channelId = normalizeReticulumChatChannelId(
      typeof data.channelId === 'string' ? data.channelId : event.channelId
    );
    const existing = this.db.getChannel(event.groupId, channelId);
    const now = event.timestamp;
    const name = normalizeReticulumChatChannelId(data.name ?? channelId);
    const categoryId = normalizeReticulumChatCategoryId(data.categoryId);
    const description =
      typeof data.description === 'string' && data.description.trim()
        ? data.description.trim().slice(0, 240)
        : undefined;
    const writeMode: ReticulumGroupChannelWriteMode =
      data.writeMode === RETICULUM_CHAT_CHANNEL_WRITE_MODE_ADMINS
        ? RETICULUM_CHAT_CHANNEL_WRITE_MODE_ADMINS
        : data.writeMode === RETICULUM_CHAT_CHANNEL_WRITE_MODE_MEMBERS
          ? RETICULUM_CHAT_CHANNEL_WRITE_MODE_MEMBERS
          : existing?.writeMode ?? RETICULUM_CHAT_CHANNEL_WRITE_MODE_MEMBERS;
    const readMode: ReticulumGroupChannelReadMode =
      data.readMode === RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS
        ? RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS
        : data.readMode === RETICULUM_CHAT_CHANNEL_READ_MODE_MEMBERS
          ? RETICULUM_CHAT_CHANNEL_READ_MODE_MEMBERS
          : existing?.readMode ?? RETICULUM_CHAT_CHANNEL_READ_MODE_MEMBERS;
    const writeModeUpdatedAt =
      data.writeMode === RETICULUM_CHAT_CHANNEL_WRITE_MODE_ADMINS ||
      data.writeMode === RETICULUM_CHAT_CHANNEL_WRITE_MODE_MEMBERS ||
      !existing
        ? now
        : existing.writeModeUpdatedAt ?? existing.updatedAt;
    const position = Number.isFinite(Number(data.position))
      ? Math.max(0, Math.floor(Number(data.position)))
      : existing?.position ?? (channelId === RETICULUM_CHAT_DEFAULT_CHANNEL_ID ? 0 : 1000);
    if (event.eventType === 'channel_archive') {
      if (!existing || channelId === RETICULUM_CHAT_DEFAULT_CHANNEL_ID) return null;
      return { ...existing, archived: true, updatedAt: now };
    }
    if (event.eventType === 'channel_restore') {
      if (!existing) return null;
      return { ...existing, archived: false, updatedAt: now };
    }
    if (event.eventType === 'channel_reorder') {
      if (!existing) return null;
      return {
        ...existing,
        ...(Object.prototype.hasOwnProperty.call(data, 'categoryId')
          ? { categoryId: categoryId || undefined }
          : {}),
        position,
        updatedAt: now,
      };
    }
    return {
      groupId: event.groupId,
      channelId,
      ...(Object.prototype.hasOwnProperty.call(data, 'categoryId')
        ? { categoryId: categoryId || undefined }
        : { categoryId: existing?.categoryId }),
      name,
      ...(description ? { description } : {}),
      position,
      archived: existing?.archived ?? false,
      writeMode,
      readMode,
      writeModeUpdatedAt,
      createdBy: existing?.createdBy || event.authorAddress,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
  }

  private categoryFromMetadataPayload(
    event: ReticulumChatEvent,
    payload: unknown
  ): ReticulumGroupCategory | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const data = payload as Record<string, unknown>;
    const categoryId = normalizeReticulumChatCategoryId(data.categoryId);
    if (!categoryId) return null;
    const existing = this.db.getCategory(event.groupId, categoryId);
    const now = event.timestamp;
    const name = normalizeReticulumChatChannelId(data.name ?? categoryId.replace(/^cat-/, ''));
    const position = Number.isFinite(Number(data.position))
      ? Math.max(0, Math.floor(Number(data.position)))
      : existing?.position ?? 1000;
    if (event.eventType === 'category_delete') {
      if (!existing) {
        return {
          groupId: event.groupId,
          categoryId,
          name,
          position,
          createdBy: event.authorAddress,
          createdAt: now,
          updatedAt: now,
        };
      }
      return { ...existing, updatedAt: now };
    }
    return {
      groupId: event.groupId,
      categoryId,
      name,
      position,
      createdBy: existing?.createdBy || event.authorAddress,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
  }

  private emitSummaryChanged(groupId: number, event?: ReticulumChatEvent): void {
    this.emit('summaryChanged', {
      groupId,
      eventId: event?.eventId,
      timestamp: event?.timestamp ?? this.now(),
    });
  }

  private markGroupHistoryObserved(groupId: number): void {
    this.activeDigestGroups.set(groupId, this.now());
    for (const event of this.db.getRecentEvents(groupId, 500, null)) {
      this.observedDbEventIds.add(event.eventId);
    }
  }

  private canServeGroupHistory(groupId: number): boolean {
    return this.localGroupIds.has(groupId);
  }

  private hasLocalGroupHistory(groupId: number): boolean {
    return this.db.getKnownGroupIds().includes(groupId);
  }

  private async isValidatedGroupMember(groupId: number, address: string): Promise<boolean | null> {
    if (!Number.isInteger(groupId) || groupId <= 0) return false;
    const normalizedAddress = address.trim();
    if (!normalizedAddress) return false;
    if (!this.validateGroupMember) return this.localGroupIds.has(groupId);
    const cacheKey = `${groupId}:${normalizedAddress}`;
    const cached = this.groupMemberValidationCache.get(cacheKey);
    const now = this.now();
    if (cached && cached.expiresAt > now) return cached.isMember;
    let isMember: boolean | null = null;
    try {
      isMember = await this.validateGroupMember(groupId, normalizedAddress);
    } catch (err) {
      loggerWarn(
        `[ReticulumChat] Group membership validation failed for group=${groupId} address=${normalizedAddress}:`,
        err
      );
      return null;
    }
    if (isMember == null) {
      loggerWarn(
        `[ReticulumChat] Group membership validation unavailable for group=${groupId} address=${normalizedAddress}`
      );
      return null;
    }
    this.groupMemberValidationCache.set(cacheKey, {
      isMember,
      expiresAt: now + RETICULUM_CHAT_MEMBER_CACHE_TTL_MS,
    });
    return isMember;
  }

  private async isValidatedRequesterGroupMember(
    groupId: number,
    address: string,
    context: string
  ): Promise<boolean | null> {
    if (!this.validateGroupMember) {
      loggerWarn(
        `[ReticulumChat] Refusing ${context} request for group=${groupId}: membership validator unavailable`
      );
      return false;
    }
    return this.isValidatedGroupMember(groupId, address);
  }

  private async isValidatedGroupAdmin(groupId: number, address: string): Promise<boolean> {
    return (await this.getValidatedGroupAdminStatus(groupId, address)) === 'admin';
  }

  private async getValidatedGroupAdminStatus(
    groupId: number,
    address: string
  ): Promise<ReticulumChatAdminValidationStatus> {
    if (!Number.isInteger(groupId) || groupId <= 0) return 'not_admin';
    const normalizedAddress = address.trim();
    if (!normalizedAddress) return 'not_admin';
    if (!this.validateGroupAdmin) return this.localGroupIds.has(groupId) ? 'admin' : 'not_admin';
    const cacheKey = `${groupId}:${normalizedAddress}`;
    const cached = this.groupAdminValidationCache.get(cacheKey);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      const status = cached.isAdmin ? 'admin' : 'not_admin';
      loggerLog(
        `[ReticulumChat] group_admin_validation_cache_hit group=${groupId} address=${normalizedAddress} status=${status} ttlMs=${cached.expiresAt - now}`
      );
      return status;
    }
    let isAdmin = false;
    try {
      isAdmin = await this.validateGroupAdmin(groupId, normalizedAddress);
    } catch (err) {
      loggerWarn(
        `[ReticulumChat] group_admin_validation_unknown group=${groupId} address=${normalizedAddress}:`,
        err
      );
      return 'unknown';
    }
    loggerLog(
      `[ReticulumChat] group_admin_validation_resolved group=${groupId} address=${normalizedAddress} status=${isAdmin ? 'admin' : 'not_admin'}`
    );
    this.groupAdminValidationCache.set(cacheKey, {
      isAdmin,
      expiresAt: now + RETICULUM_CHAT_MEMBER_CACHE_TTL_MS,
    });
    return isAdmin ? 'admin' : 'not_admin';
  }

  private async canAcceptEventForChannelWritePolicy(
    event: ReticulumChatEvent
  ): Promise<boolean> {
    if (CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) return true;
    const channel = this.db.getChannel(
      event.groupId,
      normalizeReticulumChatChannelId(event.channelId)
    );
    if (!channel || channel.archived) return true;
    if (channel.writeMode !== RETICULUM_CHAT_CHANNEL_WRITE_MODE_ADMINS) {
      return true;
    }
    const writeModeUpdatedAt = Number.isFinite(channel.writeModeUpdatedAt ?? NaN)
      ? Number(channel.writeModeUpdatedAt)
      : channel.updatedAt;
    if (event.timestamp < writeModeUpdatedAt) {
      return true;
    }
    return this.isValidatedGroupAdmin(event.groupId, event.authorAddress);
  }

  private startLocalNotificationWatcher(): void {
    if (this.localNotifyWatcher) return;
    fs.mkdirSync(this.localNotifyDir, { recursive: true });
    this.cleanupOldLocalNotifications();
    this.scanLocalNotifications();
    if (!this.localNotifyScanInterval) {
      this.localNotifyScanInterval = setInterval(() => {
        this.scanLocalNotifications();
      }, 2_000);
      this.localNotifyScanInterval.unref?.();
    }
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
    if (this.localNotifyScanInterval) {
      clearInterval(this.localNotifyScanInterval);
      this.localNotifyScanInterval = null;
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
      if (!this.subscribedGroups.has(groupId) || !this.localGroupIds.has(groupId)) {
        return false;
      }
      const event = this.db.getEvent(eventId);
      if (!event || event.groupId !== groupId) return false;
      this.observedDbEventIds.add(event.eventId);
      this.emitSummaryChanged(event.groupId, event);
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

  private buildHelloWire(): ReticulumChatWire {
    return {
      t: 'RCHAT',
      k: 'hello',
      v: RETICULUM_CHAT_PROTOCOL_VERSION,
      f: RETICULUM_CHAT_PROTOCOL_FEATURES,
    };
  }

  private startDmDigestTimer(): void {
    if (this.dmDigestTimer || this.isClosed) return;
    this.dmDigestTimer = setInterval(() => {
      void this.runDmDiscovery('timer');
    }, RETICULUM_CHAT_DM_PROBE_REFRESH_MS);
    this.dmDigestTimer.unref?.();
  }

  private stopDmDigestTimer(): void {
    if (!this.dmDigestTimer) return;
    clearInterval(this.dmDigestTimer);
    this.dmDigestTimer = null;
  }

  private isOverlayHealthyForDmDiscovery(): boolean {
    if (this.isClosed || this.localDmAddresses.size === 0) return false;
    if (this.hasGoodOverlayHealth) {
      try {
        return this.hasGoodOverlayHealth();
      } catch (err) {
        loggerWarn('[ReticulumChat] DM discovery overlay health callback failed:', err);
        return false;
      }
    }
    const peers = this.getVerifiedReticulumPeers?.() ?? [];
    return peers.some((peer) => typeof peer.destinationHash === 'string' && peer.destinationHash.length > 0);
  }

  private flushPendingDmDiscoveryIfHealthy(reason: string): void {
    if (!this.pendingInitialDmDiscovery) return;
    if (!this.isOverlayHealthyForDmDiscovery()) return;
    this.pendingInitialDmDiscovery = false;
    void this.runDmDiscovery(reason);
  }

  private async runDmDiscovery(reason: string): Promise<void> {
    void reason;
    if (!this.isOverlayHealthyForDmDiscovery()) {
      this.pendingInitialDmDiscovery = this.localDmAddresses.size > 0;
      return;
    }
    await this.broadcastDmProbes();
    await this.broadcastDmNotificationsForLocalAddresses();
  }

  private async buildSignedDirectNotifyWire(
    addressA: string,
    addressB: string,
    latest: ReticulumDmEvent,
    probeRequestId?: string
  ): Promise<Extract<ReticulumChatWire, { k: 'dm_notify' }> | null> {
    if (!this.signLocalFields) return null;
    const conversationId = reticulumDmConversationId(addressA, addressB);
    if (!conversationId || latest.conversationId !== conversationId) return null;
    const sourcePeerHash = this.getLocalResourcePeerHash();
    if (!sourcePeerHash) return null;
    const localAddress = this.localDmAddressForConversation(addressA, addressB);
    if (!localAddress) return null;
    const peerAddress = localAddress === addressA ? addressB : addressA;
    const timestamp = this.now();
    const requestId = nodeCrypto.randomBytes(4).toString('hex');
    const maxHops = RETICULUM_CHAT_DM_NOTIFY_MAX_HOPS;
    const normalizedProbeRequestId = normalizeReticulumControlRequestId(probeRequestId);
    const signed = await this.signLocalFields({
      type: 'RCHAT_DM_NOTIFY',
      peerAddress,
      sourcePeerHash,
      requestId,
      probeRequestId: normalizedProbeRequestId || null,
      maxHops,
      timestamp,
    }).catch(() => null);
    if (
      !signed ||
      !this.localDmAddresses.has(signed.authorAddress) ||
      (signed.authorAddress !== addressA && signed.authorAddress !== addressB)
    ) {
      return null;
    }
    const notify: Extract<ReticulumChatWire, { k: 'dm_notify' }> = {
      t: 'RCHAT',
      k: 'dm_notify',
      d: {
        b: peerAddress,
        sp: this.compactResourcePeerHash(sourcePeerHash),
        q: requestId,
        ...(normalizedProbeRequestId ? { r: normalizedProbeRequestId } : {}),
        p: signed.authorPublicKey,
        n: timestamp,
        z: signed.signature,
      },
    };
    if (!verifyReticulumDmNotify(notify.d, timestamp)) return null;
    return wireFitsReticulum(notify) ? notify : null;
  }

  private async buildSignedDirectProbeWire(
    requesterAddress: string
  ): Promise<Extract<ReticulumChatWire, { k: 'dm_probe' }> | null> {
    if (!this.signLocalFields || !requesterAddress) return null;
    const timestamp = this.now();
    const requestId = nodeCrypto.randomBytes(4).toString('hex');
    const maxHops = RETICULUM_CHAT_DM_PROBE_MAX_HOPS;
    const signed = await this.signLocalFields({
      type: 'RCHAT_DM_PROBE',
      requestId,
      maxHops,
      timestamp,
    }).catch(() => null);
    if (!signed || signed.authorAddress !== requesterAddress) return null;
    const probe: Extract<ReticulumChatWire, { k: 'dm_probe' }> = {
      t: 'RCHAT',
      k: 'dm_probe',
      q: {
        q: requestId,
        p: signed.authorPublicKey,
        n: timestamp,
        z: signed.signature,
      },
    };
    if (!verifyReticulumDmProbe(probe.q, timestamp)) return null;
    return wireFitsReticulum(probe) ? probe : null;
  }

  private async announceDirectNotifyForEvent(
    event: ReticulumDmEvent,
    excludePeerHashes: string[] = [],
    directPeerHashes: string[] = []
  ): Promise<void> {
    const notify = await this.buildSignedDirectNotifyWire(
      event.senderAddress,
      event.recipientAddress,
      event
    );
    if (!notify) return;
    for (const peerHash of directPeerHashes) {
      const peer = this.normalizeResourcePeerHash(peerHash);
      if (peer) void this.sendToPeer(peer, notify);
    }
    const localPeerHash = this.getLocalResourcePeerHash();
    await this.fanout(notify, [
      ...excludePeerHashes,
      ...(localPeerHash ? [localPeerHash] : []),
    ]);
  }

  private async broadcastDmProbes(): Promise<void> {
    if (this.localDmAddresses.size === 0) return;
    for (const localAddress of this.localDmAddresses) {
      const probe = await this.buildSignedDirectProbeWire(localAddress);
      if (!probe) continue;
      const localPeerHash = this.getLocalResourcePeerHash();
      await this.fanout(probe, localPeerHash ? [localPeerHash] : []);
    }
  }

  private async broadcastDmNotificationsForLocalAddresses(): Promise<void> {
    if (this.localDmAddresses.size === 0) return;
    for (const localAddress of this.localDmAddresses) {
      const summaries = this.db.getDirectSummaries(localAddress).slice(0, 16);
      for (const summary of summaries) {
        const latest = summary.lastEvent;
        if (!latest || !this.acceptsDirectConversation(latest)) continue;
        await this.announceDirectNotifyForEvent(latest);
      }
    }
  }

  private cursorToWire(cursor: ReticulumChatFeedCursor | null): ReticulumChatFeedCursorWire | undefined {
    if (!cursor) return undefined;
    return { id: cursor.eventId, ts: cursor.feedTimestamp };
  }

  private cursorFromWire(wire: unknown): ReticulumChatFeedCursor | null {
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
    const cursor = wire as Partial<ReticulumChatFeedCursorWire>;
    const eventId = typeof cursor.id === 'string' ? cursor.id : '';
    const feedTimestamp = Number(cursor.ts);
    if (!eventId || !Number.isFinite(feedTimestamp) || feedTimestamp < 0) return null;
    return { eventId, feedTimestamp };
  }

  private eventCursor(event: ReticulumChatEvent): ReticulumChatFeedCursor {
    return { eventId: event.eventId, feedTimestamp: event.timestamp };
  }

  private buildDigestChannelWire(channel: ReticulumChatChannelDigest): ReticulumChatDigestWire {
    const latest = this.cursorToWire(channel.latestCursor);
    const oldest = this.cursorToWire(channel.oldestCursor);
    return {
      c: channel.channelId,
      ...(latest ? { latest } : {}),
      ...(oldest ? { oldest } : {}),
      ...(channel.visibleWindowHash ? { wh: channel.visibleWindowHash } : {}),
    };
  }

  private buildDigestChannelWireVariants(channel: ReticulumChatChannelDigest): ReticulumChatDigestWire[] {
    const full = this.buildDigestChannelWire(channel);
    const variants: ReticulumChatDigestWire[] = [full];
    if (full.wh) {
      const { wh: _wh, ...withoutWindowHash } = full;
      variants.push(withoutWindowHash);
    }
    if (full.oldest || full.wh) {
      variants.push({
        c: full.c,
        ...(full.latest ? { latest: full.latest } : {}),
      });
    }
    return variants.filter((variant, index, all) =>
      all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(variant)) === index
    );
  }

  private buildGroupDigestWire(
    groupId: number,
    offset = 0,
    limit = RETICULUM_CHAT_MAX_DIGEST_CHANNELS_PER_GROUP
  ): ReticulumChatWire {
    void offset;
    void limit;
    const latest = this.cursorToWire(this.getGroupDigestLatestCursor(groupId));
    const localPeerHash = this.localPeerHash();
    const wire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'group_digest',
      g: groupId,
      ...(latest ? { latest } : {}),
      digestHash: this.buildGroupDigestHash(groupId),
      ...(localPeerHash ? { sd: this.compactRoutePeerHash(localPeerHash) } : {}),
    };
    if (wireFitsReticulum(wire)) return wire;
    const { digestHash: _digestHash, ...withoutHash } = wire;
    return withoutHash;
  }

  private buildGroupDigestHash(groupId: number): string {
    return this.db.computeWindowHash(this.getGroupDigestEvents(groupId));
  }

  private getGroupDigestLatestCursor(groupId: number): ReticulumChatFeedCursor | null {
    const events = this.getGroupDigestEvents(groupId);
    let latest: ReticulumChatFeedCursor | null = null;
    for (const event of events) {
      const cursor = this.eventCursor(event);
      if (!latest || this.compareCursors(cursor, latest) > 0) latest = cursor;
    }
    return latest;
  }

  private getGroupDigestEvents(groupId: number): ReticulumChatEvent[] {
    const limit = RETICULUM_CHAT_GROUP_DIGEST_WINDOW_EVENTS;
    const candidates = new Map<string, ReticulumChatEvent>();
    const add = (event: ReticulumChatEvent): void => {
      if (event.groupId !== groupId) return;
      if (
        !CHANNEL_METADATA_EVENT_TYPES.has(event.eventType) &&
        this.isChannelAdminPrivate(groupId, event.channelId)
      ) {
        return;
      }
      candidates.set(event.eventId, event);
    };

    for (const event of this.db.getRecentEvents(groupId, limit * 4, null)) add(event);
    for (const event of this.db.getChannelMetadataEvents(groupId, limit)) add(event);

    const publicChannels = this.db
      .getChannels(groupId, true)
      .filter((channel) => channel.readMode !== RETICULUM_CHAT_CHANNEL_READ_MODE_ADMINS);
    for (const channel of publicChannels) {
      for (const event of this.db.getRecentEvents(groupId, limit, channel.channelId)) add(event);
    }

    return [...candidates.values()]
      .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))
      .slice(0, limit)
      .sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
  }

  private getGroupLatestCursor(groupId: number): ReticulumChatFeedCursor | null {
    let latest: ReticulumChatFeedCursor | null = null;
    for (const channelId of this.db.getChannels(groupId, true).map((channel) => channel.channelId)) {
      const cursor = this.db.getLatestFeedCursor(groupId, channelId);
      if (!cursor) continue;
      if (!latest || cursor.feedTimestamp > latest.feedTimestamp ||
        (cursor.feedTimestamp === latest.feedTimestamp && cursor.eventId > latest.eventId)) {
        latest = cursor;
      }
    }
    for (const event of this.db.getRecentEvents(groupId, 1_000, null)) {
      const cursor = this.eventCursor(event);
      if (!latest || cursor.feedTimestamp > latest.feedTimestamp ||
        (cursor.feedTimestamp === latest.feedTimestamp && cursor.eventId > latest.eventId)) {
        latest = cursor;
      }
    }
    return latest;
  }

  private buildEventHintWire(event: ReticulumChatEvent): ReticulumChatWire {
    const localPeerHash = this.localPeerHash();
    return {
      t: 'RCHAT',
      k: 'group_digest',
      g: event.groupId,
      latest: this.cursorToWire(this.eventCursor(event)),
      digestHash: this.buildGroupDigestHash(event.groupId),
      ...(localPeerHash ? { sd: this.compactRoutePeerHash(localPeerHash) } : {}),
    };
  }

  private eventPullKey(groupId: number, eventId: string): string {
    return `${groupId}:${eventId}`;
  }

  private enqueueEventPull(peerHash: string, hint: ReticulumChatEventHint): void {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return;
    const queueKey = this.eventPullKey(hint.groupId, hint.eventId);
    const existing = this.pendingEventPulls.get(queueKey);
    if (existing) {
      existing.peerHashes.add(peerKey);
      this.scheduleEventPullQueue();
      return;
    }
    this.pendingEventPulls.set(queueKey, {
      hint,
      peerHashes: new Set([peerKey]),
      attempts: 0,
      nextAttemptAt: 0,
      inFlight: false,
    });
    this.scheduleEventPullQueue();
  }

  private enqueueRelayQuery(
    groupId: number,
    eventIds: string[],
    reason: string,
    peerHash = ''
  ): void {
    if (isDisabledRelayCache) return;
    const ids = [...new Set(eventIds)]
      .filter((id) => typeof id === 'string' && id.length >= 8 && !this.db.hasEvent(id))
      .slice(0, RETICULUM_CHAT_RELAY_QUERY_MAX_IDS);
    if (ids.length === 0) return;
    const peer = peerHash.trim().toLowerCase();
    const key = `${groupId}:${peer || 'fanout'}:${ids.sort().join(',')}`;
    const now = this.now();
    if (now - (this.recentRelayQueries.get(key) ?? 0) < RETICULUM_CHAT_RELAY_QUERY_DEBOUNCE_MS) {
      return;
    }
    this.recentRelayQueries.set(key, now);
    const wire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'relay_query',
      g: groupId,
      q: { ids },
    };
    loggerLog(
      `[ReticulumChat] relay_query queued group=${groupId} ids=${ids.length} reason=${reason}${peer ? ` peer=${peer}` : ''}`
    );
    if (peer) void this.sendToPeer(peer, wire);
    else void this.fanout(wire);
  }

  private scheduleEventPullQueue(delayMs = 0): void {
    if (this.eventPullQueueTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.eventPullQueueTimer);
      this.eventPullQueueTimer = null;
    }
    this.eventPullQueueTimer = setTimeout(() => {
      this.eventPullQueueTimer = null;
      void this.processEventPullQueue();
    }, Math.max(0, delayMs));
    this.eventPullQueueTimer.unref?.();
  }

  private async processEventPullQueue(): Promise<void> {
    if (this.eventPullQueueActive) return;
    this.eventPullQueueActive = true;
    try {
      const now = this.now();
      let dispatched = 0;
      for (const [queueKey, item] of this.pendingEventPulls) {
        if (dispatched >= RETICULUM_CHAT_PULL_QUEUE_CONCURRENCY) break;
        if (item.inFlight || item.nextAttemptAt > now) continue;
        if (this.db.hasEvent(item.hint.eventId)) {
          this.pendingEventPulls.delete(queueKey);
          continue;
        }
        if (item.attempts >= RETICULUM_CHAT_PULL_MAX_ATTEMPTS) {
          loggerWarn(
            `[ReticulumChat] Giving up event pull ${item.hint.eventId} after ${item.attempts} attempts`
          );
          this.enqueueRelayQuery(item.hint.groupId, [item.hint.eventId], 'pull-max-attempts');
          this.pendingEventPulls.delete(queueKey);
          continue;
        }
        const peerKey = item.peerHashes.values().next().value;
        if (typeof peerKey !== 'string' || !peerKey) {
          this.enqueueRelayQuery(item.hint.groupId, [item.hint.eventId], 'pull-no-source');
          this.pendingEventPulls.delete(queueKey);
          continue;
        }
        item.inFlight = true;
        dispatched += 1;
        await this.requestEventPull(peerKey, item);
      }
    } finally {
      this.eventPullQueueActive = false;
      if (this.pendingEventPulls.size > 0) {
        this.scheduleEventPullQueue(RETICULUM_CHAT_PULL_QUEUE_TICK_MS);
      }
    }
  }

  private async requestEventPull(peerKey: string, item: ReticulumChatPullQueueItem): Promise<void> {
    const hint = item.hint;
    const requestKey = `${hint.groupId}:${peerKey}:${hint.eventId}`;
    const now = this.now();
    if (now - (this.requestedEventPulls.get(requestKey) ?? 0) < RETICULUM_CHAT_PULL_THROTTLE_MS) {
      item.inFlight = false;
      item.nextAttemptAt = now + RETICULUM_CHAT_PULL_RETRY_MS;
      return;
    }
    this.requestedEventPulls.set(requestKey, now);
    item.attempts += 1;
    const signedRequest = await this.buildSignedEventRequestWire(
      hint.groupId,
      hint.eventId
    );
    if (!signedRequest) {
      item.inFlight = false;
      item.nextAttemptAt = now + RETICULUM_CHAT_PULL_RETRY_MS;
      loggerWarn(
        `[ReticulumChat] Cannot request event ${hint.eventId}: local signing unavailable`
      );
      return;
    }
    const result = await this.sendToPeer(peerKey, {
      t: 'RCHAT',
      k: 'event_req',
      g: hint.groupId,
      q: signedRequest,
    });
    item.inFlight = false;
    if (this.db.hasEvent(hint.eventId)) {
      this.pendingEventPulls.delete(this.eventPullKey(hint.groupId, hint.eventId));
      return;
    }
    if (!result.ok) {
      const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[ReticulumChat] Event pull request failed for ${hint.eventId}:`,
        failed.error ?? failed.reason
      );
      this.enqueueRelayQuery(hint.groupId, [hint.eventId], `pull-send-failed:${failed.reason}`);
      item.nextAttemptAt = now + RETICULUM_CHAT_PULL_RETRY_MS;
      return;
    }
    item.nextAttemptAt = now + RETICULUM_CHAT_PULL_THROTTLE_MS;
  }

  private async sendEventHintToInterestedPeers(
    event: ReticulumChatEvent,
    excludePeerPresenceHashes: string[] = []
  ): Promise<string[]> {
    const peerHashes = this.getInterestedPeers(event.groupId, excludePeerPresenceHashes);
    if (!peerHashes.length) return [];
    const wire = this.buildEventHintWire(event);
    const deliveredPeerHashes: string[] = [];
    for (const peerHash of peerHashes) {
      const result = await this.sendToPeer(peerHash, wire);
      if (result.ok) {
        deliveredPeerHashes.push(peerHash);
      } else {
        const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
        `[ReticulumChat] Targeted event batch failed for ${event.eventId}:`,
          failed.error ?? failed.reason
        );
      }
    }
    return deliveredPeerHashes;
  }

  private async buildSignedEventRequestWire(
    groupId: number,
    eventId: string
  ): Promise<ReticulumChatEventRequestWire | null> {
    if (!this.signLocalFields) return null;
    const timestamp = this.now();
    const signed = await this.signLocalFields({
      eventId,
      groupId,
      timestamp,
      type: 'RCHAT_EVENT_REQ',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign event request:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return null;
    }
    const wire: ReticulumChatEventRequestWire = {
      id: eventId,
      a: signed.authorAddress,
      pk: signed.authorPublicKey,
      ts: timestamp,
      sig: signed.signature,
    };
    if (!verifyReticulumChatEventRequest(groupId, wire, timestamp)) return null;
    return wire;
  }

  private async buildSignedResourceAuthWire(
    groupId: number,
    transferId: string,
    type: ReticulumChatResourceAuthWire['t'] | ReticulumChatEventPageResourceAuthWire['t']
  ): Promise<ReticulumChatResourceAuthWire | ReticulumChatEventPageResourceAuthWire | null> {
    if (!this.signLocalFields) return null;
    const timestamp = this.now();
    const signed = await this.signLocalFields({
      groupId,
      timestamp,
      transferId,
      type: 'RCHAT_RESOURCE_AUTH',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign resource auth:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return null;
    }
    const wire = {
      t: type,
      x: transferId,
      g: groupId,
      a: signed.authorAddress,
      p: signed.authorPublicKey,
      ts: timestamp,
      z: signed.signature,
    };
    if (!verifyReticulumChatResourceAuth(groupId, wire, timestamp)) return null;
    return wire;
  }

  private groupKeyDigestToWire(
    digest: ReticulumChatGroupKeyDigest | ReticulumChatGroupKey
  ): Extract<ReticulumChatWire, { k: 'gkd' }> {
    return {
      t: 'RCHAT',
      k: 'gkd',
      g: digest.groupId,
      d: {
        e: digest.epoch,
        id: digest.keyId.toLowerCase(),
        p: digest.adminPublicKey,
        ts: digest.createdAt,
        s: digest.adminSignature,
      },
    };
  }

  private async ensureGroupKeyState(groupId: number): Promise<void> {
    if (isDisableReticulumGroupKeys) return;
    if (!this.isLocalPrivateGroup(groupId)) return;
    const activeKey = this.db.getActiveGroupKey(groupId);
    if (activeKey) {
      await this.announceGroupKeyDigest(activeKey);
      return;
    }
    const latestDigest = this.db.getLatestGroupKeyDigest(groupId);
    if (latestDigest) {
      await this.requestGroupKey(latestDigest, latestDigest.sourcePeerHash);
      return;
    }
    await this.createGroupKeyIfAdmin(groupId);
  }

  private async createGroupKeyIfAdmin(groupId: number): Promise<ReticulumChatGroupKey | null> {
    if (isDisableReticulumGroupKeys) return null;
    const inFlight = this.groupKeyCreateInFlight.get(groupId);
    if (inFlight) return inFlight;
    const createPromise = this.createGroupKeyIfAdminNow(groupId);
    this.groupKeyCreateInFlight.set(groupId, createPromise);
    try {
      return await createPromise;
    } finally {
      if (this.groupKeyCreateInFlight.get(groupId) === createPromise) {
        this.groupKeyCreateInFlight.delete(groupId);
      }
    }
  }

  private async createGroupKeyIfAdminNow(groupId: number): Promise<ReticulumChatGroupKey | null> {
    if (!this.signLocalFields || !this.isLocalPrivateGroup(groupId)) return null;
    const existing = this.db.getActiveGroupKey(groupId);
    if (existing) return existing;
    const latestDigest = this.db.getLatestGroupKeyDigest(groupId);
    if (latestDigest) return null;

    const keyBytes = nodeCrypto.randomBytes(32);
    const keyBytesBase64 = keyBytes.toString('base64');
    const keyId = nodeCrypto.createHash('sha256').update(keyBytes).digest('hex');
    const epoch = 1;
    const createdAt = this.now();
    const signed = await this.signLocalFields({
      epoch,
      groupId,
      keyId,
      timestamp: createdAt,
      type: 'RCHAT_GROUP_KEY_DIGEST',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign group key digest:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return null;
    }
    const isAdmin = await this.isValidatedGroupAdmin(groupId, signed.authorAddress);
    if (!isAdmin) return null;
    const key: ReticulumChatGroupKey = {
      groupId,
      epoch,
      keyId,
      keyBytesBase64,
      createdBy: signed.authorAddress,
      createdAt,
      status: 'active',
      adminPublicKey: signed.authorPublicKey,
      adminSignature: signed.signature,
    };
    const digestWire = this.groupKeyDigestToWire(key);
    if (!verifyReticulumChatGroupKeyDigest(groupId, digestWire.d, createdAt)) return null;
    if (!wireFitsReticulum(digestWire)) {
      loggerWarn(
        `[ReticulumChat] Refusing to create oversized group key digest group=${groupId} bytes=${byteLengthUtf8JsonWithBridgeSender(digestWire)}`
      );
      return null;
    }
    this.db.upsertGroupKey(key);
    this.db.upsertGroupKeyDigest({
      groupId,
      epoch,
      keyId,
      createdBy: signed.authorAddress,
      createdAt,
      adminPublicKey: signed.authorPublicKey,
      adminSignature: signed.signature,
      sourcePeerHash: '',
      seenAt: createdAt,
    });
    loggerLog(
      `[ReticulumChat] group_key_created group=${groupId} epoch=${epoch} key=${keyId.slice(0, 12)} admin=${signed.authorAddress}`
    );
    await this.announceGroupKeyDigest(key);
    return key;
  }

  private async announceGroupKeyDigest(
    digest: ReticulumChatGroupKeyDigest | ReticulumChatGroupKey
  ): Promise<void> {
    if (isDisableReticulumGroupKeys) return;
    const key = `${digest.groupId}:${digest.epoch}:${digest.keyId}`;
    const now = this.now();
    if (now - (this.recentGroupKeyDigestsSent.get(key) ?? 0) < RETICULUM_CHAT_GROUP_KEY_DIGEST_REFRESH_MS) {
      return;
    }
    const wire = this.groupKeyDigestToWire(digest);
    if (!wireFitsReticulum(wire)) {
      loggerWarn(
        `[ReticulumChat] group_key_digest skipped group=${digest.groupId} reason=wire_too_large bytes=${byteLengthUtf8JsonWithBridgeSender(wire)}`
      );
      return;
    }
    this.recentGroupKeyDigestsSent.set(key, now);
    const result = await this.fanout(wire);
    if (result.ok) {
      loggerLog(
        `[ReticulumChat] group_key_digest_sent group=${digest.groupId} epoch=${digest.epoch} key=${digest.keyId.slice(0, 12)}`
      );
    }
  }

  private async serveGroupKeyDigestForGroup(peerHash: string, groupId: number): Promise<void> {
    if (isDisableReticulumGroupKeys) return;
    if (!this.isLocalPrivateGroup(groupId)) return;
    const digest =
      this.db.getLatestGroupKeyDigest(groupId) ??
      this.db.getActiveGroupKey(groupId);
    if (!digest) {
      void this.createGroupKeyIfAdmin(groupId);
      return;
    }
    const peer = this.routePeerHash(peerHash);
    if (!peer) return;
    const rateKey = `${peer}:${groupId}:${digest.epoch}:${digest.keyId}`;
    const now = this.now();
    if (now - (this.recentGroupKeyDigestsSent.get(rateKey) ?? 0) < RETICULUM_CHAT_GROUP_KEY_DIGEST_REFRESH_MS) {
      return;
    }
    const wire = this.groupKeyDigestToWire(digest);
    if (!wireFitsReticulum(wire)) return;
    this.recentGroupKeyDigestsSent.set(rateKey, now);
    void this.sendToPeer(peer, wire);
  }

  private async requestGroupKey(
    digest: ReticulumChatGroupKeyDigest,
    peerHash = ''
  ): Promise<void> {
    if (isDisableReticulumGroupKeys) return;
    if (!this.signLocalFields) return;
    if (this.db.getGroupKey(digest.groupId, digest.epoch, digest.keyId)) return;
    if (!this.isLocalPrivateGroup(digest.groupId)) return;
    const now = this.now();
    const requestKey = `${digest.groupId}:${digest.epoch}:${digest.keyId}:${peerHash || 'fanout'}`;
    if (now - (this.recentGroupKeyRequests.get(requestKey) ?? 0) < RETICULUM_CHAT_GROUP_KEY_REQUEST_DEBOUNCE_MS) {
      return;
    }
    const requestId = nodeCrypto.randomBytes(8).toString('hex');
    const signed = await this.signLocalFields({
      epoch: digest.epoch,
      groupId: digest.groupId,
      keyId: digest.keyId,
      requestId,
      timestamp: now,
      type: 'RCHAT_GROUP_KEY_REQ',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign group key request:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return;
    }
    const requesterIsMember = await this.isValidatedGroupMember(digest.groupId, signed.authorAddress);
    if (!requesterIsMember) return;
    const wire: Extract<ReticulumChatWire, { k: 'gkq' }> = {
      t: 'RCHAT',
      k: 'gkq',
      g: digest.groupId,
      q: {
        e: digest.epoch,
        id: digest.keyId.toLowerCase(),
        r: requestId,
        p: signed.authorPublicKey,
        ts: now,
        s: signed.signature,
      },
    };
    if (!verifyReticulumChatGroupKeyRequest(digest.groupId, wire.q, now)) return;
    if (!wireFitsReticulum(wire)) {
      loggerWarn(
        `[ReticulumChat] group_key_request skipped group=${digest.groupId} reason=wire_too_large bytes=${byteLengthUtf8JsonWithBridgeSender(wire)}`
      );
      return;
    }
    this.db.upsertGroupKeyRequest({
      groupId: digest.groupId,
      epoch: digest.epoch,
      keyId: digest.keyId,
      requestId,
      requestedAt: now,
      attempts: 1,
      status: 'pending',
    });
    this.recentGroupKeyRequests.set(requestKey, now);
    const peer = this.routePeerHash(peerHash);
    if (peer) void this.sendToPeer(peer, wire);
    else void this.fanout(wire);
    loggerLog(
      `[ReticulumChat] group_key_request_sent group=${digest.groupId} epoch=${digest.epoch} key=${digest.keyId.slice(0, 12)}${peer ? ` peer=${peer.slice(0, 16)}` : ''}`
    );
  }

  private async buildSignedGroupKeyResponseWire(
    groupId: number,
    key: ReticulumChatGroupKey,
    request: ReticulumChatGroupKeyRequestWire
  ): Promise<Extract<ReticulumChatWire, { k: 'gks' }> | null> {
    if (isDisableReticulumGroupKeys) return null;
    if (!this.signLocalFields) return null;
    const now = this.now();
    const signed = await this.signLocalFields({
      epoch: key.epoch,
      groupId,
      keyBytesBase64: key.keyBytesBase64,
      keyId: key.keyId,
      requestId: request.r,
      timestamp: now,
      type: 'RCHAT_GROUP_KEY_RES',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign group key response:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return null;
    }
    const responderIsAdmin = await this.isValidatedGroupAdmin(groupId, signed.authorAddress);
    if (!responderIsAdmin) return null;
    const wire: Extract<ReticulumChatWire, { k: 'gks' }> = {
      t: 'RCHAT',
      k: 'gks',
      g: groupId,
      r: {
        e: key.epoch,
        id: key.keyId.toLowerCase(),
        r: request.r.toLowerCase(),
        kb: key.keyBytesBase64,
        p: signed.authorPublicKey,
        ts: now,
        s: signed.signature,
      },
    };
    if (!verifyReticulumChatGroupKeyResponse(groupId, wire.r, now)) return null;
    if (!wireFitsReticulum(wire)) {
      loggerWarn(
        `[ReticulumChat] group_key_response skipped group=${groupId} reason=wire_too_large bytes=${byteLengthUtf8JsonWithBridgeSender(wire)}`
      );
      return null;
    }
    return wire;
  }

  private async handleGroupKeyDigest(
    groupId: number,
    value: unknown,
    peerHash: string
  ): Promise<void> {
    if (isDisableReticulumGroupKeys) return;
    if (!this.isLocalPrivateGroup(groupId)) return;
    const now = this.now();
    const wire = value as ReticulumChatGroupKeyDigestWire;
    if (!verifyReticulumChatGroupKeyDigest(groupId, wire, now)) {
      loggerWarn(`[ReticulumChat] group_key_digest_ignored group=${groupId} reason=invalid`);
      return;
    }
    const authorAddress = deriveAddressFromPublicKey(wire.p);
    const isAdmin = await this.isValidatedGroupAdmin(groupId, authorAddress);
    if (!isAdmin) {
      loggerWarn(
        `[ReticulumChat] group_key_digest_ignored group=${groupId} key=${wire.id.slice(0, 12)} reason=not_admin author=${authorAddress}`
      );
      return;
    }
    const sourcePeerHash = this.routePeerHash(peerHash) ?? '';
    const digest: ReticulumChatGroupKeyDigest = {
      groupId,
      epoch: wire.e,
      keyId: wire.id.toLowerCase(),
      createdBy: authorAddress,
      createdAt: wire.ts,
      adminPublicKey: wire.p,
      adminSignature: wire.s,
      sourcePeerHash,
      seenAt: now,
    };
    this.db.upsertGroupKeyDigest(digest);
    loggerLog(
      `[ReticulumChat] group_key_digest_received group=${groupId} epoch=${digest.epoch} key=${digest.keyId.slice(0, 12)} peer=${sourcePeerHash.slice(0, 16) || 'unknown'}`
    );
    if (!this.db.getGroupKey(groupId, digest.epoch, digest.keyId)) {
      void this.requestGroupKey(digest, sourcePeerHash);
    }
  }

  private async handleGroupKeyRequest(
    groupId: number,
    value: unknown,
    peerHash: string
  ): Promise<void> {
    if (isDisableReticulumGroupKeys) return;
    if (!this.isLocalPrivateGroup(groupId)) return;
    const now = this.now();
    const wire = value as ReticulumChatGroupKeyRequestWire;
    if (!verifyReticulumChatGroupKeyRequest(groupId, wire, now)) {
      loggerWarn(`[ReticulumChat] group_key_request_ignored group=${groupId} reason=invalid`);
      return;
    }
    const requesterAddress = deriveAddressFromPublicKey(wire.p);
    const requesterIsMember = await this.isValidatedGroupMember(groupId, requesterAddress);
    if (!requesterIsMember) {
      loggerWarn(
        `[ReticulumChat] group_key_request_ignored group=${groupId} key=${wire.id.slice(0, 12)} reason=requester_not_member requester=${requesterAddress}`
      );
      return;
    }
    const key = this.db.getGroupKey(groupId, wire.e, wire.id);
    if (!key) {
      loggerLog(
        `[ReticulumChat] group_key_request_ignored group=${groupId} epoch=${wire.e} key=${wire.id.slice(0, 12)} reason=key_not_available`
      );
      return;
    }
    const response = await this.buildSignedGroupKeyResponseWire(groupId, key, wire);
    if (!response) return;
    const peer = this.routePeerHash(peerHash);
    if (!peer) {
      loggerWarn(
        `[ReticulumChat] group_key_response_skipped group=${groupId} key=${wire.id.slice(0, 12)} reason=unknown_peer`
      );
      return;
    }
    const result = await this.sendToPeer(peer, response);
    if (result.ok) {
      loggerLog(
        `[ReticulumChat] group_key_response_sent group=${groupId} epoch=${wire.e} key=${wire.id.slice(0, 12)} peer=${peer.slice(0, 16)}`
      );
    } else if (result.ok === false) {
      loggerWarn(
        `[ReticulumChat] group_key_response_failed group=${groupId} epoch=${wire.e} key=${wire.id.slice(0, 12)} peer=${peer.slice(0, 16)} reason=${result.reason}`
      );
    }
  }

  private async handleGroupKeyResponse(
    groupId: number,
    value: unknown,
    peerHash: string
  ): Promise<void> {
    if (isDisableReticulumGroupKeys) return;
    if (!this.isLocalPrivateGroup(groupId)) return;
    const now = this.now();
    const wire = value as ReticulumChatGroupKeyResponseWire;
    if (!verifyReticulumChatGroupKeyResponse(groupId, wire, now)) {
      loggerWarn(`[ReticulumChat] group_key_response_ignored group=${groupId} reason=invalid`);
      return;
    }
    const responderAddress = deriveAddressFromPublicKey(wire.p);
    const responderIsAdmin = await this.isValidatedGroupAdmin(groupId, responderAddress);
    if (!responderIsAdmin) {
      loggerWarn(
        `[ReticulumChat] group_key_response_ignored group=${groupId} key=${wire.id.slice(0, 12)} reason=responder_not_admin responder=${responderAddress}`
      );
      return;
    }
    const pending = this.db
      .listPendingGroupKeyRequests()
      .find(
        (request: ReticulumChatGroupKeyRequest) =>
          request.groupId === groupId &&
          request.epoch === wire.e &&
          request.keyId === wire.id.toLowerCase() &&
          request.requestId === wire.r.toLowerCase()
      );
    if (!pending) {
      loggerLog(
        `[ReticulumChat] group_key_response_ignored group=${groupId} epoch=${wire.e} key=${wire.id.slice(0, 12)} reason=no_pending_request`
      );
      return;
    }
    const digest = this.db
      .listGroupKeyDigests(groupId, 16)
      .find((entry) => entry.epoch === wire.e && entry.keyId === wire.id.toLowerCase());
    const key: ReticulumChatGroupKey = {
      groupId,
      epoch: wire.e,
      keyId: wire.id.toLowerCase(),
      keyBytesBase64: wire.kb,
      createdBy: digest?.createdBy ?? responderAddress,
      createdAt: digest?.createdAt ?? wire.ts,
      status: 'active',
      adminPublicKey: digest?.adminPublicKey ?? wire.p,
      adminSignature: digest?.adminSignature ?? wire.s,
    };
    if (reticulumGroupKeyIdFromBase64(key.keyBytesBase64) !== key.keyId) {
      loggerWarn(
        `[ReticulumChat] group_key_response_ignored group=${groupId} key=${wire.id.slice(0, 12)} reason=key_hash_mismatch`
      );
      return;
    }
    this.db.upsertGroupKey(key);
    this.db.markGroupKeyRequestStatus(groupId, wire.e, wire.id, 'fulfilled');
    loggerLog(
      `[ReticulumChat] group_key_received group=${groupId} epoch=${wire.e} key=${wire.id.slice(0, 12)} peer=${(this.routePeerHash(peerHash) ?? '').slice(0, 16) || 'unknown'}`
    );
    await this.announceGroupKeyDigest(key);
  }

  private async buildSignedResourceRequestWire(
    groupId: number,
    manifest: ReticulumResourceManifest,
    eventId?: string,
    ranges: ReticulumResourceByteRange[] = []
  ): Promise<ReticulumChatResourceRequestWire | null> {
    if (!this.signLocalFields) return null;
    const timestamp = this.now();
    const byteRanges = ranges.map((range) => [range.startByte, range.endByteExclusive] as [number, number]);
    const signed = await this.signLocalFields({
      eventId: null,
      fileHash: manifest.fileHash,
      byteRanges: normalizeByteRanges(byteRanges),
      groupId,
      timestamp,
      type: 'RCHAT_RESOURCE_REQ',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign resource request:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return null;
    }
    const requesterIsMember = await this.isValidatedGroupMember(
      groupId,
      signed.authorAddress
    );
    if (!requesterIsMember) {
      loggerWarn(
        `[ReticulumChat] Refusing resource request for group=${groupId}: local signer is not a group member`
      );
      return null;
    }
    this.localGroupIds.add(groupId);
    const baseWire: ReticulumChatResourceRequestWire = {
      fh: manifest.fileHash,
      b: normalizeByteRanges(byteRanges),
      pk: signed.authorPublicKey,
      ts: timestamp,
      sig: signed.signature,
    };
    if (!verifyReticulumChatResourceRequest(groupId, baseWire, timestamp)) return null;
    return baseWire;
  }

  private getResourceRequestPeers(eventId?: string): string[] {
    this.pruneEventSourcePeers();
    const localPeerHash = this.getLocalResourcePeerHash();
    const peers = new Set<string>();
    if (eventId) {
      for (const peer of this.eventSourcePeers.get(eventId)?.peers ?? []) {
        if (peer && peer !== localPeerHash) peers.add(peer);
      }
    }
    return [...peers];
  }

  private getDirectResourceRequestPeers(peerAddress: string, eventId?: string): string[] {
    this.pruneEventSourcePeers();
    const localPeerHash = this.getLocalResourcePeerHash();
    const peers = new Set<string>();
    const normalizedPeerAddress = typeof peerAddress === 'string' ? peerAddress.trim() : '';
    if (eventId) {
      for (const peer of this.eventSourcePeers.get(eventId)?.peers ?? []) {
        if (peer && peer !== localPeerHash) peers.add(peer);
      }
    }
    for (const peer of this.getVerifiedReticulumPeers?.() ?? []) {
      if (peer.address !== normalizedPeerAddress) continue;
      const destinationHash = this.normalizeResourcePeerHash(peer.destinationHash);
      if (destinationHash && destinationHash !== localPeerHash) peers.add(destinationHash);
    }
    return [...peers];
  }

  private pruneResourceDiscoveryRequests(now = this.now()): void {
    for (const [key, expiresAt] of this.recentResourceDiscoveryRequests.entries()) {
      if (expiresAt <= now) this.recentResourceDiscoveryRequests.delete(key);
    }
  }

  private pruneDirectResourceDiscoveryRequests(now = this.now()): void {
    for (const [key, expiresAt] of this.recentDirectResourceDiscoveryRequests.entries()) {
      if (expiresAt <= now) this.recentDirectResourceDiscoveryRequests.delete(key);
    }
  }

  private pruneResourceFindRoutes(now = this.now()): void {
    for (const [requestId, route] of this.resourceFindRoutes) {
      if (route.expiresAt <= now) this.resourceFindRoutes.delete(requestId);
    }
    for (const [requestId, expiresAt] of this.localResourceFindRequests) {
      if (expiresAt <= now) this.localResourceFindRequests.delete(requestId);
    }
    if (this.resourceFindRoutes.size > RETICULUM_CHAT_RESOURCE_FIND_ROUTE_MAX) {
      const excess = this.resourceFindRoutes.size - RETICULUM_CHAT_RESOURCE_FIND_ROUTE_MAX;
      const oldest = [...this.resourceFindRoutes.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, excess);
      for (const [requestId] of oldest) this.resourceFindRoutes.delete(requestId);
    }
    if (this.localResourceFindRequests.size > RETICULUM_CHAT_RESOURCE_FIND_ROUTE_MAX) {
      const excess = this.localResourceFindRequests.size - RETICULUM_CHAT_RESOURCE_FIND_ROUTE_MAX;
      const oldest = [...this.localResourceFindRequests.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, excess);
      for (const [requestId] of oldest) this.localResourceFindRequests.delete(requestId);
    }
  }

  private pruneDirectResourceFindRoutes(now = this.now()): void {
    for (const [requestId, route] of this.directResourceFindRoutes) {
      if (route.expiresAt <= now) this.directResourceFindRoutes.delete(requestId);
    }
    for (const [requestId, expiresAt] of this.localDirectResourceFindRequests) {
      if (expiresAt <= now) this.localDirectResourceFindRequests.delete(requestId);
    }
    if (this.directResourceFindRoutes.size > RETICULUM_CHAT_RESOURCE_FIND_ROUTE_MAX) {
      const excess = this.directResourceFindRoutes.size - RETICULUM_CHAT_RESOURCE_FIND_ROUTE_MAX;
      const oldest = [...this.directResourceFindRoutes.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, excess);
      for (const [requestId] of oldest) this.directResourceFindRoutes.delete(requestId);
    }
    if (this.localDirectResourceFindRequests.size > RETICULUM_CHAT_RESOURCE_FIND_ROUTE_MAX) {
      const excess = this.localDirectResourceFindRequests.size - RETICULUM_CHAT_RESOURCE_FIND_ROUTE_MAX;
      const oldest = [...this.localDirectResourceFindRequests.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, excess);
      for (const [requestId] of oldest) this.localDirectResourceFindRequests.delete(requestId);
    }
  }

  private async buildSignedResourceFindWire(
    groupId: number,
    manifest: ReticulumResourceManifest
  ): Promise<Extract<ReticulumChatWire, { k: 'rf' }> | null> {
    const fileHash = manifest.fileHash.toLowerCase();
    if (!this.signLocalFields) {
      loggerWarn(
        `[ReticulumChat] resource_find_build_failed group=${groupId} file=${fileHash.slice(0, 12)} reason=no_signer`
      );
      return null;
    }
    const localPeerHash = this.getLocalResourcePeerHash();
    if (!localPeerHash) {
      loggerWarn(
        `[ReticulumChat] resource_find_build_failed group=${groupId} file=${fileHash.slice(0, 12)} reason=no_local_peer`
      );
      return null;
    }
    const timestamp = this.now();
    const expiresAt = timestamp + RETICULUM_CHAT_RESOURCE_FIND_TTL_MS;
    const requestId = nodeCrypto.randomBytes(4).toString('hex');
    const maxHops = RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS;
    const signed = await this.signLocalFields({
      expiresAt,
      fileHash: manifest.fileHash.toLowerCase(),
      groupId,
      maxHops,
      requestId,
      sizeBytes: manifest.sizeBytes,
      timestamp,
      type: 'RCHAT_RESOURCE_FIND',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign resource discovery request:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      loggerWarn(
        `[ReticulumChat] resource_find_build_failed group=${groupId} file=${fileHash.slice(0, 12)} reason=invalid_signature_payload`
      );
      return null;
    }
    const requesterIsMember = await this.isValidatedGroupMember(groupId, signed.authorAddress);
    if (!requesterIsMember) {
      loggerWarn(
        `[ReticulumChat] Refusing resource discovery for group=${groupId}: local signer is not a group member`
      );
      return null;
    }
    this.localGroupIds.add(groupId);
    const wire: Extract<ReticulumChatWire, { k: 'rf' }> = {
      t: 'RCHAT',
      k: 'rf',
      g: groupId,
      q: requestId,
      f: fileHash,
      s: manifest.sizeBytes,
      x: expiresAt,
      p: signed.authorPublicKey,
      n: timestamp,
      z: signed.signature,
    };
    if (!verifyReticulumChatResourceFind(groupId, wire, timestamp)) {
      loggerWarn(
        `[ReticulumChat] resource_find_build_failed group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=verify_failed`
      );
      return null;
    }
    if (!wireFitsReticulum(wire)) {
      loggerWarn(
        `[ReticulumChat] resource_find_build_failed group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=wire_too_large bytes=${byteLengthUtf8JsonWithBridgeSender(wire)}`
      );
      return null;
    }
    return wire;
  }

  private async announceResourceDiscovery(
    groupId: number,
    manifest: ReticulumResourceManifest,
    candidatePeers: string[],
    force = false
  ): Promise<void> {
    const fileHash = manifest.fileHash.toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(fileHash)) {
      loggerWarn(
        `[ReticulumChat] resource_find_skipped group=${groupId} file=${String(manifest.fileHash || '').slice(0, 12)} reason=invalid_file_hash`
      );
      return;
    }
    if (!Number.isInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0) {
      loggerWarn(
        `[ReticulumChat] resource_find_skipped group=${groupId} file=${fileHash.slice(0, 12)} reason=invalid_size`
      );
      return;
    }
    const now = this.now();
    this.pruneResourceDiscoveryRequests(now);
    const key = `${groupId}:${fileHash}`;
    const rateLimitedUntil = this.recentResourceDiscoveryRequests.get(key) ?? 0;
    if (!force && rateLimitedUntil > now) {
      loggerLog(
        `[ReticulumChat] resource_find_skipped group=${groupId} file=${fileHash.slice(0, 12)} reason=rate_limited retryMs=${rateLimitedUntil - now}`
      );
      return;
    }
    const wire = await this.buildSignedResourceFindWire(groupId, manifest);
    if (!wire) {
      loggerWarn(
        `[ReticulumChat] resource_find_skipped group=${groupId} file=${fileHash.slice(0, 12)} reason=build_failed`
      );
      return;
    }
    const localPeerHash = this.getLocalResourcePeerHash();
    const exclude = [
      ...candidatePeers,
      ...(localPeerHash ? [localPeerHash] : []),
    ];
    const result = await this.fanoutOnce(wire, exclude);
    if (result.ok) {
      this.recentResourceDiscoveryRequests.set(
        key,
        this.now() + RETICULUM_CHAT_RESOURCE_DISCOVERY_TTL_MS
      );
      this.localResourceFindRequests.set(
        wire.q,
        this.now() + RETICULUM_CHAT_RESOURCE_FIND_ROUTE_TTL_MS
      );
      loggerLog(
        `[ReticulumChat] resource_find_sent group=${groupId} file=${fileHash.slice(0, 12)} rid=${wire.q.slice(0, 12)} excluded=${exclude.length} maxHops=${wire.m ?? RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS}`
      );
    } else {
      const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[ReticulumChat] resource_find_send_failed group=${groupId} file=${fileHash.slice(0, 12)} rid=${wire.q.slice(0, 12)} reason=${failed.reason}`
      );
    }
  }

  private async buildSignedDirectResourceFindWire(
    conversationId: string,
    peerAddress: string,
    manifest: ReticulumResourceManifest
  ): Promise<Extract<ReticulumChatWire, { k: 'dm_resource_find' }> | null> {
    const fileHash = manifest.fileHash.toLowerCase();
    if (!this.signLocalFields) {
      loggerWarn(
        `[ReticulumChat] dm_resource_find_build_failed conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} reason=no_signer`
      );
      return null;
    }
    const localPeerHash = this.getLocalResourcePeerHash();
    if (!localPeerHash) {
      loggerWarn(
        `[ReticulumChat] dm_resource_find_build_failed conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} reason=no_local_peer`
      );
      return null;
    }
    const timestamp = this.now();
    const expiresAt = timestamp + RETICULUM_CHAT_RESOURCE_FIND_TTL_MS;
    const requestId = nodeCrypto.randomBytes(4).toString('hex');
    const maxHops = RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS;
    const signed = await this.signLocalFields({
      conversationId,
      peerAddress,
      requestId,
      fileHash,
      sizeBytes: manifest.sizeBytes,
      maxHops,
      expiresAt,
      timestamp,
      type: 'RCHAT_DM_RESOURCE_FIND',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign DM resource discovery request:', err);
      return null;
    });
    if (
      !signed ||
      typeof signed.authorAddress !== 'string' ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string' ||
      reticulumDmConversationId(signed.authorAddress, peerAddress) !== conversationId
    ) {
      loggerWarn(
        `[ReticulumChat] dm_resource_find_build_failed conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} reason=invalid_signature_payload`
      );
      return null;
    }
    const wire: Extract<ReticulumChatWire, { k: 'dm_resource_find' }> = {
      t: 'RCHAT',
      k: 'dm_resource_find',
      q: {
        a: signed.authorAddress,
        b: peerAddress,
        q: requestId,
        f: fileHash,
        x: expiresAt,
      },
    };
    const rejectReason = getReticulumDmResourceFindRejectReason(wire.q, timestamp);
    if (rejectReason) {
      loggerWarn(
        `[ReticulumChat] dm_resource_find_build_failed conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=${rejectReason}`
      );
      return null;
    }
    if (!wireFitsReticulum(wire)) {
      loggerWarn(
        `[ReticulumChat] dm_resource_find_build_failed conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=wire_too_large bytes=${byteLengthUtf8JsonWithBridgeSender(wire)}`
      );
      return null;
    }
    return wire;
  }

  private async announceDirectResourceDiscovery(
    conversationId: string,
    peerAddress: string,
    manifest: ReticulumResourceManifest,
    candidatePeers: string[],
    force = false
  ): Promise<void> {
    const normalizedConversationId = normalizeReticulumDmConversationId(conversationId);
    const fileHash = manifest.fileHash.toLowerCase();
    if (!normalizedConversationId || !/^[0-9a-f]{64}$/i.test(fileHash)) return;
    if (!Number.isInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0) return;
    const now = this.now();
    this.pruneDirectResourceDiscoveryRequests(now);
    const key = `${normalizedConversationId}:${fileHash}`;
    const rateLimitedUntil = this.recentDirectResourceDiscoveryRequests.get(key) ?? 0;
    if (!force && rateLimitedUntil > now) {
      loggerLog(
        `[ReticulumChat] dm_resource_find_skipped conversation=${normalizedConversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} reason=rate_limited retryMs=${rateLimitedUntil - now}`
      );
      return;
    }
    const wire = await this.buildSignedDirectResourceFindWire(
      normalizedConversationId,
      peerAddress,
      manifest
    );
    if (!wire) {
      loggerWarn(
        `[ReticulumChat] dm_resource_find_skipped conversation=${normalizedConversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} reason=build_failed`
      );
      return;
    }
    const localPeerHash = this.getLocalResourcePeerHash();
    const directPeers = [
      ...new Set(
        candidatePeers
          .map((peer) => this.normalizeResourcePeerHash(peer))
          .filter((peer): peer is string => Boolean(peer) && peer !== localPeerHash)
      ),
    ];
    let directSent = false;
    for (const peer of directPeers) {
      const direct = await this.sendToPeer(peer, wire);
      if (direct.ok) {
        directSent = true;
        loggerLog(
          `[ReticulumChat] dm_resource_find_sent_direct conversation=${normalizedConversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${wire.q.q.slice(0, 12)} peer=${peer.slice(0, 16)}`
        );
      } else {
        const failed = direct as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[ReticulumChat] dm_resource_find_direct_failed conversation=${normalizedConversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${wire.q.q.slice(0, 12)} peer=${peer.slice(0, 16)} reason=${failed.reason}`
        );
      }
    }
    const exclude = [
      ...(directSent ? directPeers : []),
      ...(localPeerHash ? [localPeerHash] : []),
    ];
    const result = directSent ? { ok: true as const } : await this.fanoutOnce(wire, exclude);
    if (result.ok) {
      this.recentDirectResourceDiscoveryRequests.set(
        key,
        this.now() + RETICULUM_CHAT_RESOURCE_DISCOVERY_TTL_MS
      );
      this.localDirectResourceFindRequests.set(
        wire.q.q,
        this.now() + RETICULUM_CHAT_RESOURCE_FIND_ROUTE_TTL_MS
      );
      loggerLog(
        `[ReticulumChat] dm_resource_find_sent conversation=${normalizedConversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${wire.q.q.slice(0, 12)} direct=${directSent ? directPeers.length : 0} excluded=${exclude.length} maxHops=${wire.q.m ?? RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS}`
      );
    } else {
      const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
      loggerWarn(
        `[ReticulumChat] dm_resource_find_send_failed conversation=${normalizedConversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${wire.q.q.slice(0, 12)} reason=${failed.reason}`
      );
    }
  }

  private noteEventSourcePeer(eventId: string, peerHash: string): void {
    const eventKey = typeof eventId === 'string' ? eventId.trim() : '';
    const peerKey = typeof peerHash === 'string' ? peerHash.trim().toLowerCase() : '';
    if (!eventKey || !peerKey) return;
    const now = this.now();
    let record = this.eventSourcePeers.get(eventKey);
    if (!record) {
      record = { peers: new Set<string>(), updatedAt: now };
      this.eventSourcePeers.set(eventKey, record);
    }
    record.peers.add(peerKey);
    record.updatedAt = now;
    this.pruneEventSourcePeers(now);
  }

  private pruneEventSourcePeers(now = this.now()): void {
    const cutoff = now - RETICULUM_CHAT_EVENT_SOURCE_PEER_TTL_MS;
    for (const [eventId, record] of this.eventSourcePeers.entries()) {
      if (record.updatedAt < cutoff || record.peers.size === 0) {
        this.eventSourcePeers.delete(eventId);
      }
    }
    if (this.eventSourcePeers.size <= RETICULUM_CHAT_EVENT_SOURCE_PEER_MAX_EVENTS) {
      return;
    }
    const excess =
      this.eventSourcePeers.size - RETICULUM_CHAT_EVENT_SOURCE_PEER_MAX_EVENTS;
    const oldest = [...this.eventSourcePeers.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, excess);
    for (const [eventId] of oldest) {
      this.eventSourcePeers.delete(eventId);
    }
  }

  private async buildSignedResourceRequestBatches(
    groupId: number,
    manifest: ReticulumResourceManifest,
    eventId: string | undefined,
    ranges: ReticulumResourceByteRange[]
  ): Promise<ReticulumChatResourceRequestWire[]> {
    const batches: ReticulumChatResourceRequestWire[] = [];
    for (const range of ranges) {
      const request = await this.buildSignedResourceRequestWire(
        groupId,
        manifest,
        eventId,
        [range]
      );
      if (request) batches.push(request);
    }
    return batches;
  }

  private async buildSignedDirectResourceRequestWire(
    manifest: ReticulumResourceManifest,
    eventId: string | undefined,
    ranges: ReticulumResourceByteRange[],
    featureData?: Record<string, unknown>
  ): Promise<ReticulumDmResourceRequestWire | null> {
    if (!this.signLocalFields) return null;
    const conversationId = normalizeReticulumDmConversationId(featureData?.conversationId);
    const peerAddress = typeof featureData?.peerAddress === 'string' ? featureData.peerAddress.trim() : '';
    const requesterAddress = typeof featureData?.requesterAddress === 'string' ? featureData.requesterAddress.trim() : '';
    const requesterPeerHash = this.getLocalResourcePeerHash();
    if (!conversationId || !peerAddress || !requesterAddress || !requesterPeerHash) return null;
    if (reticulumDmConversationId(requesterAddress, peerAddress) !== conversationId) return null;
    if (!this.resourceManifestBelongsToDirectConversation(manifest, conversationId)) return null;
    const timestamp = this.now();
    const requestId = nodeCrypto.randomBytes(4).toString('hex');
    const byteRanges = ranges.map((range) => [range.startByte, range.endByteExclusive] as [number, number]);
    const signed = await this.signLocalFields({
      conversationId,
      peerAddress,
      fileHash: manifest.fileHash.toLowerCase(),
      byteRanges: normalizeByteRanges(byteRanges),
      requestId,
      requesterPeerHash,
      timestamp,
      type: 'RCHAT_DM_RESOURCE_REQ',
    }).catch((err) => {
      loggerWarn('[ReticulumChat] Failed to sign DM resource request:', err);
      return null;
    });
    if (
      !signed ||
      signed.authorAddress !== requesterAddress ||
      typeof signed.authorPublicKey !== 'string' ||
      typeof signed.signature !== 'string'
    ) {
      return null;
    }
    const wire: ReticulumDmResourceRequestWire = {
      c: conversationId,
      b: peerAddress,
      fh: manifest.fileHash.toLowerCase(),
      r: normalizeByteRanges(byteRanges),
      q: requestId,
      rp: this.compactResourcePeerHash(requesterPeerHash),
      p: signed.authorPublicKey,
      n: timestamp,
      z: signed.signature,
    };
    if (!verifyReticulumDmResourceRequest(wire, timestamp)) return null;
    return wire;
  }

  private async buildSignedDirectResourceRequestBatches(
    manifest: ReticulumResourceManifest,
    eventId: string | undefined,
    ranges: ReticulumResourceByteRange[],
    featureData?: Record<string, unknown>
  ): Promise<ReticulumDmResourceRequestWire[]> {
    const batches: ReticulumDmResourceRequestWire[] = [];
    for (const range of ranges) {
      const request = await this.buildSignedDirectResourceRequestWire(
        manifest,
        eventId,
        [range],
        featureData
      );
      if (request) batches.push(request);
    }
    return batches;
  }

  private getLocalResourcePeerHash(): string | undefined {
    return this.normalizeResourcePeerHash(this.bridge?.getLocalDestinationHash?.());
  }

  private normalizeResourcePeerHash(value: unknown): string | undefined {
    return normalizePeerHashFromWire(value);
  }

  private compactResourcePeerHash(peerHash: string): string {
    return compactPeerHashForWire(peerHash);
  }

  private normalizeIdentityRequestId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    return /^[0-9a-f]{16,64}$/.test(normalized) ? normalized : undefined;
  }

  private pruneIdentityRoutes(now = this.now()): void {
    for (const [requestId, route] of this.identityRequestRoutes) {
      if (route.expiresAt <= now) this.identityRequestRoutes.delete(requestId);
    }
    if (this.identityRequestRoutes.size > RETICULUM_CHAT_IDENTITY_ROUTE_MAX) {
      const excess = this.identityRequestRoutes.size - RETICULUM_CHAT_IDENTITY_ROUTE_MAX;
      const oldest = [...this.identityRequestRoutes.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, excess);
      for (const [requestId] of oldest) this.identityRequestRoutes.delete(requestId);
    }
    for (const [requestId, waiter] of this.localIdentityRequests) {
      if (waiter.expiresAt <= now) {
        clearTimeout(waiter.timeout);
        waiter.resolve(null);
        this.localIdentityRequests.delete(requestId);
      }
    }
  }

  private async bridgeKnowsPeerIdentity(peerHash: string): Promise<boolean> {
    const peer = this.normalizeResourcePeerHash(peerHash);
    if (!peer || !this.bridge) return false;
    if (typeof this.bridge.ensurePeerIdentityKnown === 'function') {
      return this.bridge.ensurePeerIdentityKnown(peer);
    }
    return true;
  }

  private async ensureResourcePeerIdentity(
    peerHash: string,
    reason: string
  ): Promise<string | null> {
    const peer = this.normalizeResourcePeerHash(peerHash);
    if (!peer) return '';
    const learnedPublicKey = this.learnedResourceIdentityPublicKeys.get(peer);
    if (learnedPublicKey) return learnedPublicKey;
    if (await this.bridgeKnowsPeerIdentity(peer)) return '';
    const publicKey = await this.requestReticulumPeerIdentity(peer, reason);
    if (!publicKey) return null;
    return (await this.noteResourceIdentityPublicKey(peer, publicKey)) ? publicKey : null;
  }

  private async noteResourceIdentityPublicKey(
    peerHash: string,
    identityPublicKeyBase64: unknown
  ): Promise<string | null> {
    const peer = this.normalizeResourcePeerHash(peerHash);
    const publicKey = normalizeReticulumIdentityPublicKeyBase64(identityPublicKeyBase64);
    if (!peer || !publicKey) return null;
    if (!(await this.registerOfferResourceIdentity(peer, publicKey))) return null;
    this.learnedResourceIdentityPublicKeys.set(peer, publicKey);
    if (this.learnedResourceIdentityPublicKeys.size > RETICULUM_CHAT_IDENTITY_ROUTE_MAX) {
      const oldestPeer = this.learnedResourceIdentityPublicKeys.keys().next().value;
      if (oldestPeer) this.learnedResourceIdentityPublicKeys.delete(oldestPeer);
    }
    return publicKey;
  }

  private requestReticulumPeerIdentity(peerHash: string, reason: string): Promise<string | null> {
    const peer = this.normalizeResourcePeerHash(peerHash);
    if (!peer) return Promise.resolve(null);
    this.pruneIdentityRoutes();
    for (const waiter of this.localIdentityRequests.values()) {
      if (waiter.destinationHash === peer) {
        return new Promise((resolve) => {
          const originalResolve = waiter.resolve;
          waiter.resolve = (publicKey) => {
            originalResolve(publicKey);
            resolve(publicKey);
          };
        });
      }
    }
    const requestId = nodeCrypto.randomBytes(12).toString('hex');
    const expiresAt = this.now() + RETICULUM_CHAT_IDENTITY_REQUEST_TTL_MS;
    const wire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'identity_req',
      d: this.compactResourcePeerHash(peer),
      rid: requestId,
      h: 0,
      m: RETICULUM_CHAT_IDENTITY_REQUEST_MAX_HOPS,
      x: expiresAt,
    };
    if (!wireFitsReticulum(wire)) return Promise.resolve(null);
    loggerLog(
      `[ReticulumChat] identity_req_sent peer=${peer.slice(0, 16)} rid=${requestId.slice(0, 12)} reason=${reason}`
    );
    void this.fanoutOnce(wire, []);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const waiter = this.localIdentityRequests.get(requestId);
        if (waiter) {
          this.localIdentityRequests.delete(requestId);
          waiter.resolve(null);
        }
      }, RETICULUM_CHAT_IDENTITY_REQUEST_TIMEOUT_MS);
      this.localIdentityRequests.set(requestId, {
        destinationHash: peer,
        resolve,
        timeout,
        expiresAt,
      });
    });
  }

  private async handleIdentityRequest(
    wire: Extract<ReticulumChatWire, { k: 'identity_req' }>,
    peerHash: string
  ): Promise<void> {
    const reversePeerHash = this.normalizeResourcePeerHash(peerHash);
    const destinationHash = this.normalizeResourcePeerHash(wire.d);
    const requestId = this.normalizeIdentityRequestId(wire.rid);
    const now = this.now();
    if (!reversePeerHash || !destinationHash || !requestId) return;
    if (!Number.isInteger(wire.h) || wire.h < 0) return;
    if (!Number.isInteger(wire.m) || wire.m < 0 || wire.m > RETICULUM_CHAT_IDENTITY_REQUEST_MAX_HOPS) return;
    if (!Number.isFinite(wire.x) || wire.x <= now) return;
    if (wire.x - now > RETICULUM_CHAT_IDENTITY_REQUEST_TTL_MS + RETICULUM_CHAT_CONTROL_MAX_FUTURE_SKEW_MS) return;
    this.pruneIdentityRoutes(now);
    this.identityRequestRoutes.set(requestId, {
      reversePeerHash,
      destinationHash,
      expiresAt: Math.min(wire.x, now + RETICULUM_CHAT_IDENTITY_ROUTE_TTL_MS),
    });
    const localPeerHash = this.getLocalResourcePeerHash();
    if (localPeerHash && destinationHash === localPeerHash && this.bridge) {
      const publicKey = await this.bridge.getLocalIdentityPublicKeyBase64?.();
      const normalized = normalizeReticulumIdentityPublicKeyBase64(publicKey);
      if (!normalized) return;
      const offer: ReticulumChatWire = {
        t: 'RCHAT',
        k: 'identity_offer',
        d: this.compactResourcePeerHash(destinationHash),
        rk: normalized,
        rid: requestId,
      };
      if (!wireFitsReticulum(offer)) return;
      const result = await this.sendToPeer(reversePeerHash, offer);
      if (result.ok) {
        loggerLog(
          `[ReticulumChat] identity_offer_sent peer=${destinationHash.slice(0, 16)} rid=${requestId.slice(0, 12)} to=${reversePeerHash.slice(0, 16)}`
        );
      }
      return;
    }
    if (wire.h >= wire.m) return;
    const forwarded: ReticulumChatWire = {
      ...wire,
      h: wire.h + 1,
    };
    if (!wireFitsReticulum(forwarded)) return;
    void this.fanoutOnce(forwarded, [reversePeerHash, destinationHash, ...(localPeerHash ? [localPeerHash] : [])]);
  }

  private async handleIdentityOffer(
    wire: Extract<ReticulumChatWire, { k: 'identity_offer' }>,
    peerHash: string
  ): Promise<void> {
    const destinationHash = this.normalizeResourcePeerHash(wire.d);
    const requestId = this.normalizeIdentityRequestId(wire.rid);
    const publicKey = normalizeReticulumIdentityPublicKeyBase64(wire.rk);
    if (!destinationHash || !requestId || !publicKey) return;
    this.pruneIdentityRoutes();
    const waiter = this.localIdentityRequests.get(requestId);
    if (waiter) {
      if (waiter.destinationHash !== destinationHash) return;
      this.localIdentityRequests.delete(requestId);
      clearTimeout(waiter.timeout);
      waiter.resolve(publicKey);
      loggerLog(
        `[ReticulumChat] identity_offer_received peer=${destinationHash.slice(0, 16)} rid=${requestId.slice(0, 12)} from=${peerHash.slice(0, 16)}`
      );
      return;
    }
    const route = this.identityRequestRoutes.get(requestId);
    if (!route || route.destinationHash !== destinationHash || route.expiresAt <= this.now()) return;
    const relayed: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'identity_offer',
      d: this.compactResourcePeerHash(destinationHash),
      rk: publicKey,
      rid: requestId,
    };
    if (!wireFitsReticulum(relayed)) return;
    void this.sendToPeer(route.reversePeerHash, relayed);
  }

  private normalizeResourceFindRequestId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    return /^[0-9a-f]{8,64}$/.test(normalized) ? normalized : undefined;
  }

  private canAcceptResourceFind(
    groupId: number,
    wire: Extract<ReticulumChatWire, { k: 'rf' }>
  ): boolean {
    return verifyReticulumChatResourceFind(groupId, wire, this.now());
  }

  private checkLocalResourceServeAvailability(
    groupId: number,
    fileHash: string,
    sizeBytes: number
  ): ReticulumChatResourceServeCheck {
    const manifest = this.resourceStore?.getManifest(fileHash);
    if (!manifest) return { ok: false, reason: 'manifest_missing' };
    if (manifest.fileHash.toLowerCase() !== fileHash) return { ok: false, reason: 'hash_mismatch' };
    if (manifest.sizeBytes !== sizeBytes) return { ok: false, reason: 'size_mismatch' };
    if (!this.resourceManifestBelongsToGroup(manifest, groupId)) return { ok: false, reason: 'wrong_group' };
    try {
      const sourcePath =
        this.resourceStore?.getVerifiedAssembledPath(fileHash) ??
        this.resourceStore?.assembleResource(fileHash);
      return sourcePath ? { ok: true } : { ok: false, reason: 'not_complete' };
    } catch {
      return { ok: false, reason: 'not_complete' };
    }
  }

  private checkLocalDirectResourceServeAvailability(
    conversationId: string,
    fileHash: string,
    sizeBytes?: number
  ): ReticulumChatResourceServeCheck {
    const manifest = this.resourceStore?.getManifest(fileHash);
    if (!manifest) return { ok: false, reason: 'manifest_missing' };
    if (manifest.fileHash.toLowerCase() !== fileHash) return { ok: false, reason: 'hash_mismatch' };
    if (sizeBytes != null && manifest.sizeBytes !== sizeBytes) return { ok: false, reason: 'size_mismatch' };
    if (!this.resourceManifestBelongsToDirectConversation(manifest, conversationId)) {
      return { ok: false, reason: 'wrong_conversation' };
    }
    try {
      const sourcePath =
        this.resourceStore?.getVerifiedAssembledPath(fileHash) ??
        this.resourceStore?.assembleResource(fileHash);
      return sourcePath ? { ok: true } : { ok: false, reason: 'not_complete' };
    } catch {
      return { ok: false, reason: 'not_complete' };
    }
  }

  private async handleResourceFind(
    groupId: number,
    wire: Extract<ReticulumChatWire, { k: 'rf' }>,
    fromPeerHash: string
  ): Promise<void> {
    const reversePeerHash = this.normalizeResourcePeerHash(fromPeerHash);
    const requestIdForLog = typeof wire.q === 'string' ? wire.q.slice(0, 12) : '-';
    const fileHashForLog = typeof wire.f === 'string' ? wire.f.slice(0, 12) : '-';
    if (!reversePeerHash) {
      loggerWarn(
        `[ReticulumChat] resource_find_rejected group=${groupId} file=${fileHashForLog} rid=${requestIdForLog} reason=invalid_peer`
      );
      return;
    }
    const rejectReason = getReticulumChatResourceFindRejectReason(groupId, wire, this.now());
    if (rejectReason) {
      loggerWarn(
        `[ReticulumChat] resource_find_rejected group=${groupId} file=${fileHashForLog} rid=${requestIdForLog} peer=${reversePeerHash.slice(0, 16)} reason=${rejectReason}`
      );
      return;
    }
    const requestId = this.normalizeResourceFindRequestId(wire.q);
    const fileHash = wire.f.toLowerCase();
    const sizeBytes = Number(wire.s);
    const hop = wire.h ?? 0;
    const maxHops = wire.m ?? RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS;
    if (!requestId) {
      loggerWarn(
        `[ReticulumChat] resource_find_rejected group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestIdForLog} peer=${reversePeerHash.slice(0, 16)} reason=invalid_request_id`
      );
      return;
    }
    const localPeerHash = this.getLocalResourcePeerHash();

    const now = this.now();
    this.pruneResourceFindRoutes(now);
    if (this.localResourceFindRequests.has(requestId) || this.resourceFindRoutes.has(requestId)) {
      loggerLog(
        `[ReticulumChat] resource_find_skipped group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} peer=${reversePeerHash.slice(0, 16)} reason=duplicate`
      );
      return;
    }
    const routeExpiresAt = Math.min(
      wire.x,
      now + RETICULUM_CHAT_RESOURCE_FIND_ROUTE_TTL_MS
    );
    this.resourceFindRoutes.set(requestId, {
      reversePeerHash,
      groupId,
      fileHash,
      sizeBytes,
      expiresAt: routeExpiresAt,
    });

    const localServe = this.checkLocalResourceServeAvailability(groupId, fileHash, sizeBytes);
    if (localServe.ok && localPeerHash) {
      const requesterAddress = deriveAddressFromPublicKey(wire.p);
      const requesterMembership = requesterAddress
        ? await this.isValidatedRequesterGroupMember(groupId, requesterAddress, 'resource_find')
        : false;
      if (requesterMembership !== true) {
        loggerWarn(
          `[ReticulumChat] resource_find_local_skip group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=${requesterMembership === null ? 'requester_membership_unavailable' : 'requester_not_member'}`
        );
        return;
      }
      const response: ReticulumChatWire = {
        t: 'RCHAT',
        k: 'resource_have',
        g: groupId,
        fh: fileHash,
        s: sizeBytes,
        rid: requestId,
        sp: this.compactResourcePeerHash(localPeerHash),
      };
      if (!wireFitsReticulum(response)) {
        loggerWarn(
          `[ReticulumChat] resource_have_skipped group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=wire_too_large`
        );
        return;
      }
      const result = await this.sendToPeer(reversePeerHash, response);
      if (result.ok) {
        loggerLog(
          `[ReticulumChat] resource_have_sent group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} peer=${reversePeerHash.slice(0, 16)}`
        );
      } else {
        const reason = 'reason' in result ? result.reason : 'send_failed';
        loggerWarn(
          `[ReticulumChat] resource_have_send_failed group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} peer=${reversePeerHash.slice(0, 16)} reason=${reason}`
        );
      }
      return;
    }
    if ('reason' in localServe) {
      loggerLog(
        `[ReticulumChat] resource_find_local_skip group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=${localServe.reason}`
      );
    } else if (!localPeerHash) {
      loggerLog(
        `[ReticulumChat] resource_find_local_skip group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=missing_local_peer`
      );
    }

    if (hop >= maxHops || now >= wire.x) {
      loggerLog(
        `[ReticulumChat] resource_find_forward_skip group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=${hop >= maxHops ? 'max_hops' : 'expired'}`
      );
      return;
    }
    const forwarded: ReticulumChatWire = {
      ...wire,
      h: hop + 1,
    };
    if (!wireFitsReticulum(forwarded)) {
      loggerWarn(
        `[ReticulumChat] resource_find_forward_skip group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=wire_too_large`
      );
      return;
    }
    const exclude = [
      reversePeerHash,
      ...(localPeerHash ? [localPeerHash] : []),
    ];
    const result = await this.fanoutOnce(forwarded, exclude);
    if (result.ok) {
      loggerLog(
        `[ReticulumChat] resource_find_forwarded group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} hop=${forwarded.h}/${maxHops}`
      );
    } else {
      const reason = 'reason' in result ? result.reason : 'send_failed';
      loggerWarn(
        `[ReticulumChat] resource_find_forward_failed group=${groupId} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=${reason}`
      );
    }
  }

  private async handleResourceHave(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    const previousPeerHash = this.normalizeResourcePeerHash(peerHash);
    const sourcePeerHash =
      this.normalizeResourcePeerHash(wire.sp) ??
      previousPeerHash;
    const requestId = this.normalizeResourceFindRequestId(wire.rid);
    if (!sourcePeerHash) return;
    const localPeerHash = this.getLocalResourcePeerHash();
    if (localPeerHash && sourcePeerHash === localPeerHash) return;
    const fileHash = typeof wire.fh === 'string' ? wire.fh.trim().toLowerCase() : '';
    const sizeBytes = Number(wire.s);
    if (!/^[0-9a-f]{64}$/i.test(fileHash) || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      return;
    }
    if (requestId && !this.localResourceFindRequests.has(requestId)) {
      const route = this.resourceFindRoutes.get(requestId);
      if (
        !route ||
        route.groupId !== groupId ||
        route.fileHash !== fileHash ||
        route.sizeBytes !== sizeBytes ||
        route.expiresAt <= this.now()
      ) {
        return;
      }
      const response: ReticulumChatWire = {
        t: 'RCHAT',
        k: 'resource_have',
        g: groupId,
        fh: fileHash,
        s: sizeBytes,
        rid: requestId,
        sp: this.compactResourcePeerHash(sourcePeerHash),
      };
      if (!wireFitsReticulum(response)) return;
      void this.sendToPeer(route.reversePeerHash, response);
      return;
    }
    if (!this.subscribedGroups.has(groupId) || !this.localGroupIds.has(groupId)) return;
    const manifest = this.resourceStore?.getManifest(fileHash);
    if (
      !manifest ||
      manifest.fileHash.toLowerCase() !== fileHash ||
      manifest.sizeBytes !== sizeBytes ||
      !this.resourceManifestBelongsToGroup(manifest, groupId)
    ) {
      return;
    }
    await this.noteResourceIdentityPublicKey(sourcePeerHash, wire.rk);
    const added = this.resourceTransfer?.addCandidatePeers(fileHash, [sourcePeerHash]) ?? false;
    if (added) {
      loggerLog(
        `[ReticulumChat] resource_have_received group=${groupId} file=${fileHash.slice(0, 12)}${requestId ? ` rid=${requestId.slice(0, 12)}` : ''} peer=${sourcePeerHash.slice(0, 16)}`
      );
    }
  }

  private async handleDirectResourceFind(
    wire: Extract<ReticulumChatWire, { k: 'dm_resource_find' }>,
    fromPeerHash: string
  ): Promise<void> {
    const reversePeerHash = this.normalizeResourcePeerHash(fromPeerHash);
    const query = wire.q;
    const requestIdForLog = typeof query?.q === 'string' ? query.q.slice(0, 12) : '-';
    const fileHashForLog = typeof query?.f === 'string' ? query.f.slice(0, 12) : '-';
    const conversationIdForLog = normalizeReticulumDmConversationId(query?.c);
    if (!reversePeerHash) {
      loggerWarn(
        `[ReticulumChat] dm_resource_find_rejected conversation=${conversationIdForLog.slice(0, 16) || '-'} file=${fileHashForLog} rid=${requestIdForLog} reason=invalid_peer`
      );
      return;
    }
    const rejectReason = getReticulumDmResourceFindRejectReason(query, this.now());
    if (rejectReason) {
      loggerWarn(
        `[ReticulumChat] dm_resource_find_rejected conversation=${conversationIdForLog.slice(0, 16) || '-'} file=${fileHashForLog} rid=${requestIdForLog} peer=${reversePeerHash.slice(0, 16)} reason=${rejectReason}`
      );
      return;
    }
    const requestId = this.normalizeResourceFindRequestId(query.q);
    const peerAddress = query.b.trim();
    const requesterAddress =
      (typeof query.a === 'string' ? query.a.trim() : '') ||
      (query.p ? deriveAddressFromPublicKey(query.p) : '');
    const conversationId =
      normalizeReticulumDmConversationId(query.c) ||
      reticulumDmConversationId(requesterAddress, peerAddress);
    const fileHash = query.f.toLowerCase();
    const requestedSizeBytes = Number(query.s);
    const hop = query.h ?? 0;
    const maxHops = query.m ?? RETICULUM_CHAT_RESOURCE_FIND_MAX_HOPS;
    if (!requestId || !conversationId) return;
    const localPeerHash = this.getLocalResourcePeerHash();
    const now = this.now();
    this.pruneDirectResourceFindRoutes(now);
    if (
      this.localDirectResourceFindRequests.has(requestId) ||
      this.directResourceFindRoutes.has(requestId)
    ) {
      loggerLog(
        `[ReticulumChat] dm_resource_find_skipped conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} peer=${reversePeerHash.slice(0, 16)} reason=duplicate`
      );
      return;
    }
    this.directResourceFindRoutes.set(requestId, {
      reversePeerHash,
      conversationId,
      fileHash,
      sizeBytes: Number.isInteger(requestedSizeBytes) && requestedSizeBytes > 0 ? requestedSizeBytes : 0,
      expiresAt: Math.min(query.x, now + RETICULUM_CHAT_RESOURCE_FIND_ROUTE_TTL_MS),
    });

    const localServe = this.checkLocalDirectResourceServeAvailability(
      conversationId,
      fileHash,
      Number.isInteger(requestedSizeBytes) && requestedSizeBytes > 0 ? requestedSizeBytes : undefined
    );
    const localManifest = this.resourceStore?.getManifest(fileHash);
    const sizeBytes = localManifest?.sizeBytes ?? requestedSizeBytes;
    if (
      localServe.ok &&
      localPeerHash &&
      requesterAddress &&
      reticulumDmConversationId(requesterAddress, peerAddress) === conversationId
    ) {
      const localIdentity = await this.localReticulumResourceIdentity();
      const response: ReticulumChatWire = {
        t: 'RCHAT',
        k: 'dm_resource_have',
        c: conversationId,
        fh: fileHash,
        s: sizeBytes,
        rid: requestId,
        sp: this.compactResourcePeerHash(localPeerHash),
        ...(localIdentity.identityPublicKeyBase64 ? { rk: localIdentity.identityPublicKeyBase64 } : {}),
      };
      if (!wireFitsReticulum(response)) {
        loggerWarn(
          `[ReticulumChat] dm_resource_have_skipped conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=wire_too_large`
        );
        return;
      }
      const result = await this.sendToPeer(reversePeerHash, response);
      if (result.ok) {
        loggerLog(
          `[ReticulumChat] dm_resource_have_sent conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} peer=${reversePeerHash.slice(0, 16)}`
        );
      } else {
        const reason = 'reason' in result ? result.reason : 'send_failed';
        loggerWarn(
          `[ReticulumChat] dm_resource_have_send_failed conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} peer=${reversePeerHash.slice(0, 16)} reason=${reason}`
        );
      }
      return;
    }
    if ('reason' in localServe) {
      loggerLog(
        `[ReticulumChat] dm_resource_find_local_skip conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=${localServe.reason}`
      );
    }

    if (hop >= maxHops || now >= query.x) {
      loggerLog(
        `[ReticulumChat] dm_resource_find_forward_skip conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=${hop >= maxHops ? 'max_hops' : 'expired'}`
      );
      return;
    }
    const forwarded: ReticulumChatWire = {
      ...wire,
      q: {
        ...query,
        h: hop + 1,
      },
    };
    if (!wireFitsReticulum(forwarded)) {
      loggerWarn(
        `[ReticulumChat] dm_resource_find_forward_skip conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=wire_too_large`
      );
      return;
    }
    const result = await this.fanoutOnce(forwarded, [
      reversePeerHash,
      ...(localPeerHash ? [localPeerHash] : []),
    ]);
    if (result.ok) {
      loggerLog(
        `[ReticulumChat] dm_resource_find_forwarded conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} hop=${hop + 1}/${maxHops}`
      );
    } else {
      const reason = 'reason' in result ? result.reason : 'send_failed';
      loggerWarn(
        `[ReticulumChat] dm_resource_find_forward_failed conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)} rid=${requestId.slice(0, 12)} reason=${reason}`
      );
    }
  }

  private async handleDirectResourceHave(
    wire: Extract<ReticulumChatWire, { k: 'dm_resource_have' }>,
    peerHash: string
  ): Promise<void> {
    const previousPeerHash = this.normalizeResourcePeerHash(peerHash);
    const sourcePeerHash =
      this.normalizeResourcePeerHash(wire.sp) ??
      previousPeerHash;
    const requestId = this.normalizeResourceFindRequestId(wire.rid);
    if (!sourcePeerHash) return;
    const localPeerHash = this.getLocalResourcePeerHash();
    if (localPeerHash && sourcePeerHash === localPeerHash) return;
    const conversationId = normalizeReticulumDmConversationId(wire.c);
    const fileHash = typeof wire.fh === 'string' ? wire.fh.trim().toLowerCase() : '';
    const sizeBytes = Number(wire.s);
    if (!conversationId || !/^[0-9a-f]{64}$/i.test(fileHash) || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      return;
    }
    if (requestId && !this.localDirectResourceFindRequests.has(requestId)) {
      const route = this.directResourceFindRoutes.get(requestId);
      if (
        !route ||
        route.conversationId !== conversationId ||
        route.fileHash !== fileHash ||
        (route.sizeBytes > 0 && route.sizeBytes !== sizeBytes) ||
        route.expiresAt <= this.now()
      ) {
        return;
      }
      const response: ReticulumChatWire = {
        t: 'RCHAT',
        k: 'dm_resource_have',
        c: conversationId,
        fh: fileHash,
        s: sizeBytes,
        rid: requestId,
        sp: this.compactResourcePeerHash(sourcePeerHash),
        ...(wire.rk ? { rk: wire.rk } : {}),
      };
      if (!wireFitsReticulum(response)) return;
      void this.sendToPeer(route.reversePeerHash, response);
      return;
    }
    const manifest = this.resourceStore?.getManifest(fileHash);
    if (
      !manifest ||
      manifest.fileHash.toLowerCase() !== fileHash ||
      manifest.sizeBytes !== sizeBytes ||
      !this.resourceManifestBelongsToDirectConversation(manifest, conversationId)
    ) {
      return;
    }
    await this.noteResourceIdentityPublicKey(sourcePeerHash, wire.rk);
    const added = this.directResourceTransfer?.addCandidatePeers(fileHash, [sourcePeerHash]) ?? false;
    if (added) {
      loggerLog(
        `[ReticulumChat] dm_resource_have_received conversation=${conversationId.slice(0, 16)} file=${fileHash.slice(0, 12)}${requestId ? ` rid=${requestId.slice(0, 12)}` : ''} peer=${sourcePeerHash.slice(0, 16)}`
      );
    }
  }

  private async handleEventResourceRequest(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    const candidate = wire.q;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const request = candidate as ReticulumChatEventRequestWire;
    if (!verifyReticulumChatEventRequest(groupId, request, this.now())) return;
    const event = this.db.getEvent(request.id);
    if (!event || event.groupId !== groupId || this.db.isEventPayloadScrubbed(request.id)) {
      this.relayGroupControlRequest(
        'event_req',
        groupId,
        wire,
        peerHash,
        this.hashControlPayload({
          id: request.id,
          a: request.a,
          pk: request.pk,
          ts: request.ts,
          sig: request.sig,
        })
      );
      return;
    }
    const requesterIsMember = await this.isValidatedRequesterGroupMember(
      groupId,
      request.a,
      'event_resource'
    );
    if (requesterIsMember !== true) {
      loggerWarn(
        `[ReticulumChat] Refusing event resource ${request.id}: ${requesterIsMember === null ? 'requester membership validation unavailable' : 'requester is not a group member'}`
      );
      return;
    }
    if (!(await this.canRequesterReadEvent(event, request.a))) {
      loggerWarn(
        `[ReticulumChat] Refusing event resource ${request.id}: requester cannot read channel=${normalizeReticulumChatChannelId(event.channelId)}`
      );
      return;
    }
    loggerLog(
      `[ReticulumChat] cached_event_serve_allowed group=${groupId} event=${request.id} requester=${request.a}`
    );
    await this.offerEventResource(peerHash, groupId, request.id, {
      ...this.relayResponseOptionsFromWire(wire),
      allowCachedServe: true,
    });
  }

  private isRelayEligibleEvent(event: ReticulumChatEvent): boolean {
    if (isDisabledRelayCache) return false;
    if (event.eventType === 'attachment_manifest') return false;
    if (
      !CHANNEL_METADATA_EVENT_TYPES.has(event.eventType) &&
      this.isChannelAdminPrivate(event.groupId, event.channelId)
    ) {
      return false;
    }
    const sizeBytes = Buffer.byteLength(serializeReticulumChatEvent(event), 'utf8');
    return sizeBytes > 0 && sizeBytes <= RETICULUM_CHAT_RELAY_EVENT_MAX_BYTES;
  }

  private getRelayCandidatePeers(event: ReticulumChatEvent): string[] {
    this.prunePeerSubscriptions();
    const local = this.localPeerHash();
    const excluded = new Set([local].filter((hash): hash is string => !!hash));
    const interested = new Set(this.getInterestedPeers(event.groupId));
    const peers = [...this.peerSubscriptions.keys()]
      .map((peer) => peer.trim().toLowerCase())
      .filter((peer) => peer && !excluded.has(peer) && !interested.has(peer));
    const establishedPeers = this.getEstablishedOverlayPeerHashes();
    const establishedCandidates = peers.filter((peer) => establishedPeers.has(peer));
    const fallbackCandidates = peers.filter((peer) => !establishedPeers.has(peer));
    return [
      ...this.shuffleRelayPeers(establishedCandidates),
      ...this.shuffleRelayPeers(fallbackCandidates),
    ].slice(0, RETICULUM_CHAT_RELAY_REPLICATION_TARGET);
  }

  private getEstablishedOverlayPeerHashes(): Set<string> {
    if (!this.bridge || typeof this.bridge.getOverlayLinkSnapshots !== 'function') {
      return new Set();
    }
    return new Set(
      this.bridge
        .getOverlayLinkSnapshots()
        .map((snap) => snap.peerPresenceHash.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  private shuffleRelayPeers(peers: string[]): string[] {
    const shuffled = [...peers];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = nodeCrypto.randomInt(index + 1);
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  private async replicateEventToRelayCache(event: ReticulumChatEvent): Promise<void> {
    if (isDisabledRelayCache) return;
    if (!this.isRelayEligibleEvent(event)) return;
    const peers = this.getRelayCandidatePeers(event);
    if (peers.length === 0) {
      const now = this.now();
      if (now - this.lastRelayNoPeersLogAt >= 60_000) {
        this.lastRelayNoPeersLogAt = now;
        loggerLog(`[ReticulumChat] relay_store skipped reason=no-relay-peers`);
      }
      return;
    }
    let accepted = 0;
    for (const peerHash of peers) {
      const result = await this.offerEventResource(peerHash, event.groupId, event.eventId, {
        relayStore: true,
      });
      if (result.ok) accepted += 1;
      else {
        const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[ReticulumChat] relay_store send failed event=${event.eventId} peer=${peerHash}:`,
          failed.error ?? failed.reason
        );
      }
    }
    loggerLog(
      `[ReticulumChat] relay_store queued event=${event.eventId} peers=${peers.length} accepted=${accepted}`
    );
  }

  private async handleRelayQuery(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): Promise<void> {
    if (isDisabledRelayCache) return;
    if (!peerHash) return;
    const query = wire.q;
    if (!query || typeof query !== 'object' || Array.isArray(query)) return;
    const q = query as Partial<ReticulumChatRelayQueryWire>;
    const ids = Array.isArray(q.ids)
      ? q.ids
          .filter((id): id is string => typeof id === 'string' && id.length >= 8)
          .slice(0, RETICULUM_CHAT_RELAY_QUERY_MAX_IDS)
      : [];
    if (ids.length === 0) return;
    if (!this.shouldServeControlRequest({ k: 'relay_query', ids }, groupId, peerHash)) return;

    let offered = 0;
    const relayOptions = this.relayResponseOptionsFromWire(wire);
    for (const eventId of ids) {
      const localEvent = this.db.getEvent(eventId);
      if (localEvent && localEvent.groupId === groupId && this.isRelayEligibleEvent(localEvent)) {
        const result = await this.offerEventResource(peerHash, groupId, eventId, {
          relayCached: true,
          ...relayOptions,
        });
        if (result.ok) offered += 1;
        continue;
      }
      const cached = this.db.getRelayEventBlob(groupId, eventId, this.now());
      if (!cached) continue;
      const result = await this.offerRelayCachedEventResource(
        peerHash,
        cached,
        relayOptions
      );
      if (result.ok) offered += 1;
      else {
        const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[ReticulumChat] relay_query offer failed group=${groupId} event=${eventId} peer=${peerHash}:`,
          failed.error ?? failed.reason
        );
      }
    }
    if (offered === 0) {
      const relayed = this.relayGroupControlRequest(
        'relay_query',
        groupId,
        wire,
        peerHash,
        this.hashControlPayload({ ids })
      );
      if (relayed) {
        loggerLog(
          `[ReticulumChat] relay_query forwarded group=${groupId} peer=${peerHash} requested=${ids.length}`
        );
        return;
      }
    }
    loggerLog(
      `[ReticulumChat] relay_query served group=${groupId} peer=${peerHash} requested=${ids.length} offered=${offered}`
    );
  }

  private relayDigestEntryToWire(
    entry: ReticulumChatRelayDigestEntry
  ): ReticulumChatRelayDigestEntryWire {
    return {
      id: entry.eventId,
      ts: entry.timestamp,
      c: normalizeReticulumChatChannelId(entry.channelId),
      a: entry.authorAddress,
      seq: entry.authorSeq,
      ph: entry.payloadHash,
      bid: entry.blobId,
    };
  }

  private buildRelayDigestWire(
    groupId: number,
    entries: ReticulumChatRelayDigestEntry[],
    more: boolean,
    offset: number
  ): Extract<ReticulumChatWire, { k: 'relay_digest' }> | null {
    const fullEvents = entries.map((entry) => this.relayDigestEntryToWire(entry));
    for (let eventCount = fullEvents.length; eventCount > 0; eventCount -= 1) {
      const page = fullEvents.slice(0, eventCount);
      for (let compactLevel = 0; compactLevel <= 4; compactLevel += 1) {
        const events = page.map((event) => {
          const compacted: ReticulumChatRelayDigestEntryWire = {
            id: event.id,
            ts: event.ts,
            c: event.c,
          };
          if (compactLevel <= 3 && event.seq != null) compacted.seq = event.seq;
          if (compactLevel <= 2 && event.a) compacted.a = event.a;
          if (compactLevel <= 1 && event.ph) compacted.ph = event.ph;
          if (compactLevel === 0 && event.bid) compacted.bid = event.bid;
          return compacted;
        });
        const wire: Extract<ReticulumChatWire, { k: 'relay_digest' }> = {
          t: 'RCHAT',
          k: 'relay_digest',
          g: groupId,
          events,
          ...(more ? { more: true, nextOffset: offset + events.length } : {}),
        };
        if (wireFitsReticulum(wire)) return wire;
      }
    }
    return null;
  }

  private async serveRelayDigestForGroup(peerHash: string, groupId: number): Promise<void> {
    if (isDisabledRelayCache) return;
    const peer = peerHash.trim().toLowerCase();
    if (!peer) return;
    const key = `${peer}:${groupId}`;
    const now = this.now();
    const lastServedAt = this.recentRelayDigestsServed.get(key);
    if (lastServedAt != null && now - lastServedAt < RETICULUM_CHAT_RELAY_DIGEST_DEBOUNCE_MS) {
      return;
    }
    const firstEntry = this.db.listRelayDigestEntries(groupId, 0, 1, now);
    if (firstEntry.length === 0) {
      this.recentRelayDigestsServed.set(key, now);
      loggerLog(
        `[ReticulumChat] relay_digest_skipped group=${groupId} peer=${peer} reason=empty`
      );
      return;
    }
    this.recentRelayDigestsServed.set(key, now);
    let offset = 0;
    let served = 0;
    let more = false;
    while (served < RETICULUM_CHAT_RELAY_DIGEST_MAX_EVENTS_PER_SUB) {
      const limit = Math.min(
        RETICULUM_CHAT_RELAY_DIGEST_PAGE_SIZE,
        RETICULUM_CHAT_RELAY_DIGEST_MAX_EVENTS_PER_SUB - served
      );
      const entries = this.db.listRelayDigestEntries(groupId, offset, limit, now);
      if (entries.length === 0) {
        more = false;
        break;
      }
      const potentiallyMore =
        entries.length > 1 ||
        this.db.listRelayDigestEntries(groupId, offset + entries.length, 1, now).length > 0;
      const wire = this.buildRelayDigestWire(
        groupId,
        entries,
        potentiallyMore,
        offset
      );
      if (!wire) {
        loggerWarn(
          `[ReticulumChat] relay_digest_skipped group=${groupId} peer=${peer} reason=wire_too_large`
        );
        break;
      }
      const sentCount = wire.events.length;
      if (sentCount === 0) break;
      const result = await this.sendToPeer(peer, wire);
      if (!result.ok) {
        const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
        loggerWarn(
          `[ReticulumChat] relay_digest send failed group=${groupId} peer=${peer}:`,
          failed.error ?? failed.reason
        );
        break;
      }
      served += sentCount;
      offset += sentCount;
      more = this.db.listRelayDigestEntries(groupId, offset, 1, now).length > 0;
      if (!more) break;
    }
    loggerLog(
      `[ReticulumChat] relay_digest_served group=${groupId} peer=${peer} count=${served} more=${more}`
    );
  }

  private handleRelayDigest(
    groupId: number,
    wire: Record<string, unknown>,
    peerHash: string
  ): void {
    if (isDisabledRelayCache) return;
    void this.forwardGroupDigestToInterestRoutes(groupId, wire, peerHash);
    if (!this.localGroupIds.has(groupId) || !this.subscribedGroups.has(groupId)) return;
    if (this.shouldDropDuplicateInboundControlWire(wire, groupId, peerHash)) return;
    if (!Array.isArray(wire.events)) return;
    const missing: string[] = [];
    const entries = wire.events.slice(0, RETICULUM_CHAT_RELAY_DIGEST_MAX_EVENTS_PER_SUB);
    for (const rawEntry of entries) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as Partial<ReticulumChatRelayDigestEntryWire>;
      if (
        typeof entry.id !== 'string' ||
        entry.id.length < 8 ||
        typeof entry.ts !== 'number' ||
        typeof entry.c !== 'string' ||
        (entry.a != null && typeof entry.a !== 'string') ||
        (entry.seq != null && !Number.isInteger(entry.seq)) ||
        (entry.ph != null && typeof entry.ph !== 'string') ||
        (entry.bid != null && typeof entry.bid !== 'string')
      ) {
        continue;
      }
      if (!this.db.hasEvent(entry.id)) missing.push(entry.id);
    }
    loggerLog(
      `[ReticulumChat] relay_digest_received group=${groupId} peer=${peerHash} entries=${entries.length} missing=${missing.length}`
    );
    if (missing.length > 0) {
      this.enqueueRelayQuery(groupId, missing, 'relay-digest', peerHash);
    }
  }

  private handleRelayAck(groupId: number, ack: unknown, peerHash: string): void {
    if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return;
    const a = ack as Partial<ReticulumChatRelayAckWire>;
    if (typeof a.id !== 'string' || a.id.length < 8 || typeof a.ok !== 'boolean') return;
    loggerLog(
      `[ReticulumChat] relay_ack group=${groupId} event=${a.id} peer=${peerHash} ok=${a.ok}${
        a.reason ? ` reason=${a.reason}` : ''
      }${a.bid ? ` blob=${a.bid}` : ''}`
    );
  }

  private sendRelayAck(
    peerHash: string,
    groupId: number,
    eventId: string,
    ok: boolean,
    reason?: string,
    blobId?: string
  ): void {
    const peer = peerHash.trim().toLowerCase();
    if (!peer) return;
    const wire: ReticulumChatWire = {
      t: 'RCHAT',
      k: 'relay_ack',
      g: groupId,
      a: {
        id: eventId,
        ok,
        ...(reason ? { reason } : {}),
        ...(blobId ? { bid: blobId } : {}),
      },
    };
    if (wireFitsReticulum(wire)) void this.sendToPeer(peer, wire);
  }

  private async offerRelayCachedEventResource(
    peerHash: string,
    entry: ReticulumChatRelayCacheEntry,
    options: Omit<ReticulumChatEventOfferOptions, 'continuation'> = {}
  ): Promise<ReticulumSendResult> {
    if (isDisabledRelayCache) {
      return { ok: false, reason: 'send-command-failed', error: 'Relay cache disabled' };
    }
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return { ok: false, reason: 'unknown-peer-presence-hash' };
    if (!this.bridge) return { ok: false, reason: 'bridge-unavailable' };
    if (typeof this.bridge.sendReticulumChatResourceDetailed !== 'function') {
      return { ok: false, reason: 'send-command-failed', error: 'Bridge chat resource send unavailable' };
    }
    let event: ReticulumChatEvent;
    try {
      const parsed = JSON.parse(entry.payloadJson) as unknown;
      if (!this.canStoreRelayEventResource(parsed)) {
        return { ok: false, reason: 'send-command-failed', error: 'Invalid relay cache event blob' };
      }
      event = parsed;
    } catch {
      return { ok: false, reason: 'send-command-failed', error: 'Invalid relay cache JSON' };
    }
    const wireHash = reticulumChatRelayBlobId(entry.payloadJson);
    if (wireHash !== entry.blobId) {
      return { ok: false, reason: 'send-command-failed', error: 'Relay cache blob hash mismatch' };
    }
    const localResourceIdentity = await this.localReticulumResourceIdentity();
    const transferId = nodeCrypto.randomBytes(8).toString('hex');
    const filePath = this.writeTempEventBlob(transferId, entry.payloadJson);
    const recipientPeerKey = (options.recipientPeerHash ?? peerKey).trim().toLowerCase();
    const registered = await this.bridge.sendReticulumChatResourceDetailed({
      allowedRecipientAddress: recipientPeerKey,
      transferId,
      filePath,
      fileName: `${event.eventId}.json`,
      size: entry.sizeBytes,
      sha256: entry.blobId,
      metadata: {
        resourceType: 'reticulum_chat_event',
        eventId: event.eventId,
        groupId: event.groupId,
        payloadHash: event.payloadHash,
        wireHash: entry.blobId,
        sizeBytes: entry.sizeBytes,
        relayCached: true,
        relayBlobId: entry.blobId,
      },
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    if (!registered.ok) return registered;
    this.outboundRelayCachedEventResources.set(transferId, {
      groupId: event.groupId,
      eventId: event.eventId,
      event,
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    const offer: ReticulumChatEventOffer = {
      transferId,
      eventId: event.eventId,
      groupId: event.groupId,
      payloadHash: event.payloadHash,
      wireHash: entry.blobId,
      sizeBytes: entry.sizeBytes,
      sourcePeerHash: options.sourcePeerHash ?? entry.sourcePeerHash,
      ...(localResourceIdentity.destinationHash
        ? { senderReticulumDestinationHash: localResourceIdentity.destinationHash }
        : {}),
      ...(options.relayRequestId ? { relayRequestId: options.relayRequestId } : {}),
      relayCached: true,
      relayBlobId: entry.blobId,
    };
    return this.sendToPeer(peerKey, buildEventOfferControlWire(event.groupId, offer));
  }

  private buildEventPageResourceBlob(
    groupId: number,
    channelId: string,
    events: ReticulumChatEvent[],
    hasMore: boolean,
    direction: 'after' | 'before' | 'range',
    priority?: ReticulumChatFeedPriority
  ): {
    pageEvents: ReticulumChatEvent[];
    orderedPageEvents: ReticulumChatEvent[];
    blob: string;
    pageHash: string;
    sizeBytes: number;
    eventCount: number;
    truncatedForSize: boolean;
  } | null {
    const boundedEvents = events.slice(0, RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS);
    const selectedEvents: ReticulumChatEvent[] = [];
    for (const event of boundedEvents) {
      if (event.groupId !== groupId) continue;
      if (this.db.isEventPayloadScrubbed(event.eventId)) continue;
      if (priority === 'metadata' && !CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) {
        continue;
      }
      if (
        channelId !== RETICULUM_CHAT_ALL_CHANNELS_ID &&
        normalizeReticulumChatChannelId(event.channelId) !== channelId
      ) {
        continue;
      }
      selectedEvents.push(event);
    }
    if (selectedEvents.length === 0) return null;

    let pageEvents = selectedEvents;
    let truncatedForSize = false;
    let blob = '';
    let pageHash = '';
    while (pageEvents.length > 0) {
      const ordered = [...pageEvents].sort(
        (a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId)
      );
      const start = ordered[0] ? this.cursorToWire(this.eventCursor(ordered[0])) : undefined;
      const end = ordered[ordered.length - 1]
        ? this.cursorToWire(this.eventCursor(ordered[ordered.length - 1]))
        : undefined;
      const page: ReticulumChatEventPageResource = {
        v: 1,
        g: groupId,
        c: channelId,
        d: direction,
        ...(feedPriorityToWire(priority) ? { p: feedPriorityToWire(priority) } : {}),
        ...(hasMore || truncatedForSize ? { more: true } : {}),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        wh: this.db.computeWindowHash(ordered),
        events: pageEvents,
      };
      blob = serializeReticulumChatEventPage(page);
      if (Buffer.byteLength(blob, 'utf8') <= RETICULUM_CHAT_MAX_EVENT_PAGE_BYTES) {
        pageHash = hashReticulumChatEventPage(blob);
        return {
          pageEvents,
          orderedPageEvents: ordered,
          blob,
          pageHash,
          sizeBytes: Buffer.byteLength(blob, 'utf8'),
          eventCount: pageEvents.length,
          truncatedForSize,
        };
      }
      truncatedForSize = true;
      if (direction === 'before') {
        pageEvents = pageEvents.slice(1);
      } else {
        pageEvents = pageEvents.slice(0, -1);
      }
    }
    return null;
  }

  private async offerEventPageResource(
    peerHash: string,
    groupId: number,
    channelId: string,
    events: ReticulumChatEvent[],
    hasMore: boolean,
    direction: 'after' | 'before' | 'range',
    options: Omit<ReticulumChatEventOfferOptions, 'continuation'> = {},
    priority?: ReticulumChatFeedPriority
  ): Promise<ReticulumSendResult> {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return { ok: false, reason: 'unknown-peer-presence-hash' };
    if (!this.bridge) return { ok: false, reason: 'bridge-unavailable' };
    if (typeof this.bridge.sendReticulumChatResourceDetailed !== 'function') {
      return { ok: false, reason: 'send-command-failed', error: 'Bridge chat resource send unavailable' };
    }
    if (!options.allowCachedServe && !this.localGroupIds.has(groupId)) {
      return { ok: false, reason: 'send-command-failed', error: 'Not a local group member' };
    }
    if (events.length === 0) return { ok: false, reason: 'send-command-failed', error: 'No events to offer' };

    const pageResource = this.buildEventPageResourceBlob(
      groupId,
      channelId,
      events,
      hasMore,
      direction,
      priority
    );
    if (!pageResource) {
      return { ok: false, reason: 'send-command-failed', error: 'No valid events to offer' };
    }

    const localResourceIdentity = await this.localReticulumResourceIdentity();
    if (!localResourceIdentity.destinationHash) {
      return { ok: false, reason: 'send-command-failed', error: 'Missing local Reticulum destination hash' };
    }
    const transferId = nodeCrypto.randomBytes(8).toString('hex');
    const filePath = this.writeTempEventBlob(transferId, pageResource.blob);
    const recipientPeerKey = (options.recipientPeerHash ?? peerKey).trim().toLowerCase();
    const offer: ReticulumChatEventPageOffer = {
      transferId,
      groupId,
      channelId,
      direction,
      ...(priority ? { priority } : {}),
      pageHash: pageResource.pageHash,
      sizeBytes: pageResource.sizeBytes,
      eventCount: pageResource.eventCount,
      ...(pageResource.orderedPageEvents[0] ? { start: this.eventCursor(pageResource.orderedPageEvents[0]) } : {}),
      ...(pageResource.orderedPageEvents[pageResource.orderedPageEvents.length - 1]
        ? { end: this.eventCursor(pageResource.orderedPageEvents[pageResource.orderedPageEvents.length - 1]) }
        : {}),
      ...(hasMore || pageResource.truncatedForSize ? { hasMore: true } : {}),
      ...(options.relayRequestId ? { relayRequestId: options.relayRequestId } : {}),
      ...(options.sourcePeerHash ? { sourcePeerHash: options.sourcePeerHash } : {}),
      ...(localResourceIdentity.destinationHash
        ? { senderReticulumDestinationHash: localResourceIdentity.destinationHash }
        : {}),
      ...(direction === 'range' && options.repairRange ? { repairRange: options.repairRange } : {}),
    };
    const wire = buildEventPageOfferControlWire(groupId, offer);
    if (!wireFitsReticulum(wire)) {
      this.safeUnlink(filePath);
      return { ok: false, reason: 'send-command-failed', error: 'Event page offer too large' };
    }
    const registered = await this.bridge.sendReticulumChatResourceDetailed({
      allowedRecipientAddress: recipientPeerKey,
      transferId,
      filePath,
      fileName: `${groupId}-${transferId}.event-page.json`,
      size: pageResource.sizeBytes,
      sha256: pageResource.pageHash,
      metadata: {
        resourceType: 'reticulum_chat_event_page',
        groupId,
        channelId,
        ...(feedPriorityToWire(priority) ? { p: feedPriorityToWire(priority) } : {}),
        pageHash: pageResource.pageHash,
        eventCount: pageResource.eventCount,
      },
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    if (!registered.ok) {
      this.safeUnlink(filePath);
      return registered;
    }

    this.outboundEventPageResources.set(transferId, {
      groupId,
      channelId,
      pageHash: pageResource.pageHash,
      eventIds: new Set(pageResource.pageEvents.map((event) => event.eventId)),
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    const sent = await this.sendToPeer(peerKey, wire);
    if (sent.ok) return sent;

    const failedSent = sent as Exclude<ReticulumSendResult, { ok: true }>;
    const retryable = this.shouldRetryControlSend(wire, failedSent.reason);
    if (!retryable) {
      this.outboundEventPageResources.delete(transferId);
      this.safeUnlink(filePath);
    }
    return sent;
  }

  private async offerEventResource(
    peerHash: string,
    groupId: number,
    eventId: string,
    options: ReticulumChatEventOfferOptions = {}
  ): Promise<ReticulumSendResult> {
    const peerKey = peerHash.trim().toLowerCase();
    if (!peerKey) return { ok: false, reason: 'unknown-peer-presence-hash' };
    if (!this.bridge) return { ok: false, reason: 'bridge-unavailable' };
    if (!options.allowCachedServe && !this.localGroupIds.has(groupId)) {
      return { ok: false, reason: 'send-command-failed', error: 'Not a local group member' };
    }
    const event = this.db.getEvent(eventId);
    if (!event || event.groupId !== groupId) {
      return { ok: false, reason: 'send-command-failed', error: 'Event not found for group' };
    }
    if (this.db.isEventPayloadScrubbed(eventId)) {
      return { ok: false, reason: 'send-command-failed', error: 'Event payload has been deleted' };
    }
    if (typeof this.bridge.sendReticulumChatResourceDetailed !== 'function') {
      return { ok: false, reason: 'send-command-failed', error: 'Bridge chat resource send unavailable' };
    }
    const blob = serializeReticulumChatEvent(event);
    const wireHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
    const localResourceIdentity = await this.localReticulumResourceIdentity();
    const transferId = nodeCrypto.randomBytes(8).toString('hex');
    const filePath = this.writeTempEventBlob(transferId, blob);
    const offer: ReticulumChatEventOffer = {
      transferId,
      eventId: event.eventId,
      groupId,
      payloadHash: event.payloadHash,
      wireHash,
      sizeBytes: Buffer.byteLength(blob, 'utf8'),
      ...(options.continuation ? { continuation: options.continuation } : {}),
      ...(options.relayRequestId ? { relayRequestId: options.relayRequestId } : {}),
      ...(options.sourcePeerHash ? { sourcePeerHash: options.sourcePeerHash } : {}),
      ...(options.relayStore ? { relayStore: true } : {}),
      ...(options.relayCached ? { relayCached: true } : {}),
      ...(options.relayBlobId ? { relayBlobId: options.relayBlobId } : {}),
      ...(localResourceIdentity.destinationHash
        ? { senderReticulumDestinationHash: localResourceIdentity.destinationHash }
        : {}),
    };
    const recipientPeerKey = (options.recipientPeerHash ?? peerKey).trim().toLowerCase();
    const registered = await this.bridge.sendReticulumChatResourceDetailed({
      allowedRecipientAddress: recipientPeerKey,
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
        relayStore: options.relayStore === true,
        relayCached: options.relayCached === true,
        relayBlobId: options.relayBlobId ?? '',
      },
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    if (!registered.ok) return registered;
    if (options.relayStore === true) {
      this.outboundRelayStoreEventResources.set(transferId, {
        groupId,
        eventId: event.eventId,
        expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
      });
    }
    const wire = buildEventOfferControlWire(groupId, offer);
    if (!wireFitsReticulum(wire)) {
      this.outboundRelayStoreEventResources.delete(transferId);
      this.safeUnlink(filePath);
      return { ok: false, reason: 'send-command-failed', error: 'Event offer too large' };
    }
    return this.sendToPeer(peerKey, wire);
  }

  private handleEventOffer(candidate: unknown, peerHash: string): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      loggerWarn('[ReticulumChat] Dropping inbound event offer: invalid offer payload');
      return;
    }
    const offer = candidate as Partial<ReticulumChatEventOffer>;
    if (!this.isValidEventOffer(offer)) {
      loggerWarn('[ReticulumChat] Dropping inbound event offer: invalid offer shape');
      return;
    }
    if (offer.relayStore === true) {
      this.acceptRelayStoreEventOffer(offer as ReticulumChatEventOffer, peerHash);
      return;
    }
    const relayRequestId = this.normalizeGroupControlRequestId(offer.relayRequestId);
    const hasImplicitRelayRoute =
      !relayRequestId &&
      !!this.routePeerHash(offer.sourcePeerHash) &&
      [...this.eventRelayRoutes.values()].some(
        (route) => route.groupId === offer.groupId && route.eventId === offer.eventId
      );
    if (!relayRequestId && !hasImplicitRelayRoute) {
      this.acceptLocalEventOffer(offer as ReticulumChatEventOffer, peerHash);
      return;
    }
    void this.maybeRelayEventOffer(
      offer.groupId,
      offer as ReticulumChatEventOffer,
      peerHash
    ).then((relayed) => {
      if (relayed) return;
      this.acceptLocalEventOffer(offer as ReticulumChatEventOffer, peerHash);
    });
  }

  private handleEventPageOffer(candidate: unknown, peerHash: string): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      loggerWarn('[ReticulumChat] Dropping inbound event page offer: invalid offer payload');
      return;
    }
    const offer = candidate as Partial<ReticulumChatEventPageOffer>;
    if (!this.isValidEventPageOffer(offer)) {
      loggerWarn('[ReticulumChat] Dropping inbound event page offer: invalid offer shape');
      return;
    }
    if (!this.subscribedGroups.has(offer.groupId) || !this.localGroupIds.has(offer.groupId)) {
      loggerWarn(
        `[ReticulumChat] Dropping inbound event page offer group=${offer.groupId}: subscribed=${this.subscribedGroups.has(offer.groupId)} localMember=${this.localGroupIds.has(offer.groupId)}`
      );
      return;
    }
    const sourcePeerHash =
      this.routePeerHash(offer.sourcePeerHash) ??
      this.routePeerHash(offer.senderReticulumDestinationHash) ??
      peerHash.trim().toLowerCase();
    if (!sourcePeerHash) return;
    const trackedOffer: ReticulumChatEventPageOffer = {
      ...offer,
      sourcePeerHash,
    };
    if (this.isHistoryPageHashSuppressed(sourcePeerHash, trackedOffer)) {
      loggerLog(
        `[ReticulumChat] event_page_offer_suppressed_no_progress group=${trackedOffer.groupId} channel=${trackedOffer.channelId} peer=${sourcePeerHash.slice(0, 16)} direction=${trackedOffer.direction} page=${trackedOffer.pageHash.slice(0, 12)}`
      );
      return;
    }
    this.eventPageOffers.set(trackedOffer.transferId, trackedOffer);
    void this.acceptEventPageResource(sourcePeerHash, trackedOffer);
  }

  private isValidEventPageOffer(
    offer: Partial<ReticulumChatEventPageOffer>
  ): offer is ReticulumChatEventPageOffer {
    if (typeof offer.transferId !== 'string' || !offer.transferId) return false;
    if (!Number.isInteger(offer.groupId) || offer.groupId <= 0) return false;
    if (typeof offer.channelId !== 'string' || !offer.channelId) return false;
    if (
      offer.channelId !== RETICULUM_CHAT_ALL_CHANNELS_ID &&
      normalizeReticulumChatChannelId(offer.channelId) !== offer.channelId
    ) {
      return false;
    }
    if (
      offer.direction !== 'after' &&
      offer.direction !== 'before' &&
      offer.direction !== 'range'
    ) {
      return false;
    }
    if (offer.priority != null && offer.priority !== 'metadata') return false;
    if (typeof offer.pageHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.pageHash)) return false;
    if (!Number.isInteger(offer.sizeBytes) || offer.sizeBytes <= 0) return false;
    if (offer.sizeBytes > RETICULUM_CHAT_MAX_EVENT_PAGE_BYTES) return false;
    if (!Number.isInteger(offer.eventCount) || offer.eventCount <= 0) return false;
    if (offer.eventCount > RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS) return false;
    if (offer.relayRequestId != null && !this.normalizeGroupControlRequestId(offer.relayRequestId)) return false;
    if (offer.sourcePeerHash != null && !this.routePeerHash(offer.sourcePeerHash)) return false;
    if (offer.senderReticulumDestinationHash != null && !this.routePeerHash(offer.senderReticulumDestinationHash)) return false;
    if (
      offer.senderReticulumIdentityPublicKeyBase64 != null &&
      !normalizeReticulumIdentityPublicKeyBase64(offer.senderReticulumIdentityPublicKeyBase64)
    ) {
      return false;
    }
    return true;
  }

  private acceptLocalEventOffer(offer: ReticulumChatEventOffer, peerHash: string): void {
    if (!this.subscribedGroups.has(offer.groupId) || !this.localGroupIds.has(offer.groupId)) {
      loggerWarn(
        `[ReticulumChat] Dropping inbound event offer ${offer.eventId}: group=${offer.groupId} subscribed=${this.subscribedGroups.has(offer.groupId)} localMember=${this.localGroupIds.has(offer.groupId)}`
      );
      return;
    }
    if (this.db.hasEvent(offer.eventId)) return;
    const sourcePeerHash =
      this.routePeerHash(offer.sourcePeerHash) ??
      this.routePeerHash(offer.senderReticulumDestinationHash) ??
      peerHash.trim().toLowerCase();
    const trackedOffer = {
      ...offer,
      sourcePeerHash,
    };
    this.noteEventSourcePeer(offer.eventId, sourcePeerHash);
    this.resourceOffers.set(offer.transferId, trackedOffer);
    void this.acceptEventResource(sourcePeerHash, trackedOffer);
  }

  private acceptRelayStoreEventOffer(offer: ReticulumChatEventOffer, peerHash: string): void {
    if (isDisabledRelayCache) {
      const sourcePeerHash = this.routePeerHash(peerHash) ?? peerHash.trim().toLowerCase();
      if (sourcePeerHash) {
        this.sendRelayAck(sourcePeerHash, offer.groupId, offer.eventId, false, 'relay-cache-disabled');
      }
      return;
    }
    const sourcePeerHash = this.routePeerHash(peerHash) ?? peerHash.trim().toLowerCase();
    if (!sourcePeerHash) return;
    if (offer.sizeBytes > RETICULUM_CHAT_RELAY_EVENT_MAX_BYTES) {
      loggerWarn(
        `[ReticulumChat] relay_store rejected event=${offer.eventId} reason=payload-too-large size=${offer.sizeBytes}`
      );
      this.sendRelayAck(sourcePeerHash, offer.groupId, offer.eventId, false, 'payload-too-large');
      return;
    }
    const trackedOffer = {
      ...offer,
      sourcePeerHash,
    };
    this.resourceOffers.set(offer.transferId, trackedOffer);
    void this.acceptEventResource(sourcePeerHash, trackedOffer);
  }

  private isValidEventOffer(offer: Partial<ReticulumChatEventOffer>): offer is ReticulumChatEventOffer {
    if (typeof offer.transferId !== 'string' || !offer.transferId) return false;
    if (typeof offer.eventId !== 'string' || offer.eventId.length < 8) return false;
    if (!Number.isInteger(offer.groupId) || offer.groupId <= 0) return false;
    if (
      offer.payloadHash != null &&
      offer.payloadHash !== '' &&
      !/^[0-9a-f]{64}$/i.test(offer.payloadHash)
    ) {
      return false;
    }
    if (typeof offer.wireHash !== 'string' || !/^[0-9a-f]{64}$/i.test(offer.wireHash)) return false;
    if (!Number.isInteger(offer.sizeBytes) || offer.sizeBytes <= 0) return false;
    if (offer.relayRequestId != null && !this.normalizeGroupControlRequestId(offer.relayRequestId)) return false;
    if (offer.sourcePeerHash != null && !this.routePeerHash(offer.sourcePeerHash)) return false;
    if (offer.senderReticulumDestinationHash != null && !this.routePeerHash(offer.senderReticulumDestinationHash)) return false;
    if (
      offer.senderReticulumIdentityPublicKeyBase64 != null &&
      !normalizeReticulumIdentityPublicKeyBase64(offer.senderReticulumIdentityPublicKeyBase64)
    ) {
      return false;
    }
    if (offer.relayStore != null && typeof offer.relayStore !== 'boolean') return false;
    if (offer.relayCached != null && typeof offer.relayCached !== 'boolean') return false;
    if (offer.relayBlobId != null && !/^[0-9a-f]{64}$/i.test(offer.relayBlobId)) return false;
    if (offer.continuation) {
      if (offer.continuation.direction !== 'after' && offer.continuation.direction !== 'before') return false;
      if (typeof offer.continuation.channelId !== 'string' || !offer.continuation.channelId) return false;
      if (
        typeof offer.continuation.cursor?.eventId !== 'string' ||
        offer.continuation.cursor.eventId.length < 8 ||
        !Number.isFinite(offer.continuation.cursor.feedTimestamp)
      ) {
        return false;
      }
    }
    return true;
  }

  private async maybeRelayEventOffer(
    groupId: number,
    offer: ReticulumChatEventOffer,
    inboundPeerHash: string
  ): Promise<boolean> {
    const requestId = this.normalizeGroupControlRequestId(offer.relayRequestId);
    this.pruneGroupControlRoutes();
    const routes = requestId
      ? [this.eventRelayRoutes.get(requestId)].filter((route): route is ReticulumChatEventRelayRoute => !!route)
      : [...this.eventRelayRoutes.values()].filter(
          (route) => route.groupId === groupId && route.eventId === offer.eventId
        );
    if (routes.length === 0) return false;
    const local = this.localPeerHash();
    const sourcePeerHash =
      this.routePeerHash(offer.sourcePeerHash) ??
      this.routePeerHash(inboundPeerHash);
    if (!sourcePeerHash) return false;
    let relayed = false;
    for (const route of routes) {
      if (route.groupId !== groupId || route.eventId !== offer.eventId) continue;
      if (local && route.originPeerHash === local) continue;
      const relayOffer: ReticulumChatEventOffer = {
        ...offer,
        sourcePeerHash,
        ...(requestId ? { relayRequestId: requestId } : {}),
      };
      const wire = buildEventOfferControlWire(groupId, relayOffer);
      const result = await this.sendToPeer(route.reversePeerHash, wire);
      relayed = result.ok || relayed;
    }
    return relayed;
  }

  private isValidReticulumResourceManifest(candidate: unknown): candidate is ReticulumResourceManifest {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const manifest = candidate as Partial<ReticulumResourceManifest>;
    if (typeof manifest.namespace !== 'string' || !manifest.namespace) return false;
    if (typeof manifest.fileName !== 'string' || !manifest.fileName) return false;
    if (typeof manifest.mimeType !== 'string' || !manifest.mimeType) return false;
    if (!Number.isInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0) return false;
    if (typeof manifest.fileHash !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.fileHash)) return false;
    return true;
  }

  private resourceManifestBelongsToGroup(
    manifest: ReticulumResourceManifest,
    groupId: number
  ): boolean {
    const metadata = manifest.metadata && typeof manifest.metadata === 'object' ? manifest.metadata : {};
    const metadataGroupId = Number(metadata.groupId);
    if (Number.isInteger(metadataGroupId) && metadataGroupId === groupId) return true;
    const ownerId = typeof manifest.ownerId === 'string' ? manifest.ownerId : '';
    if (ownerId.startsWith(`${groupId}:`) || ownerId.startsWith(`group:${groupId}:`)) return true;
    if (this.resourceStore?.hasGroupReference(manifest.fileHash, groupId)) return true;
    return false;
  }

  private resourceManifestBelongsToDirectConversation(
    manifest: ReticulumResourceManifest,
    conversationId: string
  ): boolean {
    const normalizedConversationId = normalizeReticulumDmConversationId(conversationId);
    if (!normalizedConversationId) return false;
    const metadata = manifest.metadata && typeof manifest.metadata === 'object' ? manifest.metadata : {};
    const metadataConversationId = normalizeReticulumDmConversationId(metadata.conversationId);
    if (metadataConversationId && metadataConversationId === normalizedConversationId) return true;
    const senderAddress = typeof metadata.senderAddress === 'string' ? metadata.senderAddress.trim() : '';
    const recipientAddress = typeof metadata.recipientAddress === 'string' ? metadata.recipientAddress.trim() : '';
    if (
      senderAddress &&
      recipientAddress &&
      reticulumDmConversationId(senderAddress, recipientAddress) === normalizedConversationId
    ) {
      return true;
    }
    const ownerId = typeof manifest.ownerId === 'string' ? manifest.ownerId : '';
    return (
      ownerId.startsWith(`dm:${normalizedConversationId}:`) ||
      ownerId.startsWith(`direct:${normalizedConversationId}:`)
    );
  }

  private signedResourceAuthRetryKey(kind: 'event' | 'event_page', transferId: string): string {
    return `${kind}:${transferId}`;
  }

  private clearSignedResourceAuthRetry(kind: 'event' | 'event_page', transferId: string): void {
    const key = this.signedResourceAuthRetryKey(kind, transferId);
    const timer = this.signedResourceAuthRetryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.signedResourceAuthRetryTimers.delete(key);
    this.signedResourceAuthRetryAttempts.delete(key);
  }

  private scheduleSignedResourceAuthRetry(
    kind: 'event',
    peerHash: string,
    offer: ReticulumChatEventOffer
  ): boolean;
  private scheduleSignedResourceAuthRetry(
    kind: 'event_page',
    peerHash: string,
    offer: ReticulumChatEventPageOffer
  ): boolean;
  private scheduleSignedResourceAuthRetry(
    kind: 'event' | 'event_page',
    peerHash: string,
    offer: ReticulumChatEventOffer | ReticulumChatEventPageOffer
  ): boolean {
    if (this.isClosed) return false;
    const key = this.signedResourceAuthRetryKey(kind, offer.transferId);
    const attempts = (this.signedResourceAuthRetryAttempts.get(key) ?? 0) + 1;
    if (attempts > RETICULUM_CHAT_SIGNED_RESOURCE_AUTH_MAX_RETRIES) {
      this.clearSignedResourceAuthRetry(kind, offer.transferId);
      return false;
    }
    this.signedResourceAuthRetryAttempts.set(key, attempts);
    if (this.signedResourceAuthRetryTimers.has(key)) return true;
    loggerWarn(
      `[ReticulumChat] Deferring ${kind === 'event_page' ? 'event page' : 'event'} resource accept group=${offer.groupId} transfer=${offer.transferId} reason=signed_auth_unavailable attempt=${attempts}`
    );
    const timer = setTimeout(() => {
      this.signedResourceAuthRetryTimers.delete(key);
      if (this.isClosed) return;
      if (kind === 'event') {
        const currentOffer = this.resourceOffers.get(offer.transferId);
        if (!currentOffer) {
          this.signedResourceAuthRetryAttempts.delete(key);
          return;
        }
        void this.acceptEventResource(peerHash, currentOffer);
        return;
      }
      const currentOffer =
        this.eventPageOffers.get(offer.transferId) ??
        this.directHistoryPageRequests.get(offer.transferId);
      if (!currentOffer) {
        this.signedResourceAuthRetryAttempts.delete(key);
        return;
      }
      void this.acceptEventPageResource(peerHash, currentOffer);
    }, RETICULUM_CHAT_SIGNED_RESOURCE_AUTH_RETRY_MS);
    this.signedResourceAuthRetryTimers.set(key, timer);
    return true;
  }

  private retryPendingSignedResourceAuthOffers(): void {
    for (const key of [...this.signedResourceAuthRetryAttempts.keys()]) {
      const [kind, transferId] = key.split(':', 2);
      if (!transferId) continue;
      if (kind === 'event') {
        const offer = this.resourceOffers.get(transferId);
        const peerHash = (
          offer?.sourcePeerHash ||
          offer?.senderReticulumDestinationHash ||
          ''
        ).trim().toLowerCase();
        if (offer && peerHash) void this.acceptEventResource(peerHash, offer);
        continue;
      }
      if (kind === 'event_page') {
        const offer =
          this.eventPageOffers.get(transferId) ??
          this.directHistoryPageRequests.get(transferId);
        const peerHash = (
          offer?.sourcePeerHash ||
          offer?.senderReticulumDestinationHash ||
          ''
        ).trim().toLowerCase();
        if (offer && peerHash) void this.acceptEventPageResource(peerHash, offer);
      }
    }
  }

  private async acceptEventResource(peerHash: string, offer: ReticulumChatEventOffer): Promise<void> {
    if (!this.bridge || typeof this.bridge.acceptReticulumChatResourceDetailed !== 'function') {
      this.handleEventResourceFailure(offer.transferId, 'accept_unavailable');
      return;
    }
    const senderHash = (offer.senderReticulumDestinationHash || peerHash).trim().toLowerCase();
    if (!senderHash) {
      loggerWarn(`[ReticulumChat] Cannot accept event resource ${offer.eventId}: missing sender Reticulum identity`);
      this.handleEventResourceFailure(offer.transferId, 'missing_sender_identity');
      return;
    }
    let reticulumIdentityPublicKeyBase64 =
      offer.senderReticulumIdentityPublicKeyBase64?.trim() ?? '';
    if (!reticulumIdentityPublicKeyBase64) {
      if (normalizePeerHashFromWire(senderHash)) {
        const resolvedIdentity = await this.ensureResourcePeerIdentity(senderHash, 'event-resource');
        if (resolvedIdentity === null) {
          this.handleEventResourceFailure(offer.transferId, 'missing_sender_identity');
          return;
        }
        reticulumIdentityPublicKeyBase64 = resolvedIdentity;
      }
    }
    const authMessage = offer.relayStore === true
      ? {
          type: 'RETICULUM_CHAT_RESOURCE_AUTH',
          transferId: offer.transferId,
          eventId: offer.eventId,
          groupId: offer.groupId,
        }
      : await this.buildSignedResourceAuthWire(offer.groupId, offer.transferId, 'RCR');
    if (!authMessage) {
      if (this.scheduleSignedResourceAuthRetry('event', senderHash, offer)) return;
      this.handleEventResourceFailure(offer.transferId, 'signed_auth_unavailable');
      return;
    }
    this.clearSignedResourceAuthRetry('event', offer.transferId);
    const result = await this.bridge.acceptReticulumChatResourceDetailed({
      peerPresenceHash: senderHash,
      reticulumIdentityPublicKeyBase64,
      transferId: offer.transferId,
      savePath: this.tempEventBlobPath(`${offer.transferId}.recv`),
      fileName: `${offer.eventId}.json`,
      size: offer.sizeBytes,
      sha256: offer.wireHash,
      metadata: {
        resourceType: 'reticulum_chat_event',
        eventId: offer.eventId,
        groupId: offer.groupId,
        payloadHash: offer.payloadHash,
        wireHash: offer.wireHash,
      },
      authMessage,
    });
    if (!result.ok) {
      const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
      this.handleEventResourceFailure(
        offer.transferId,
        failed.error ?? failed.reason ?? 'accept_failed'
      );
    }
  }

  private async acceptEventPageResource(
    peerHash: string,
    offer: ReticulumChatEventPageOffer
  ): Promise<void> {
    if (!this.bridge || typeof this.bridge.acceptReticulumChatResourceDetailed !== 'function') {
      this.handleEventPageResourceFailure(offer.transferId, 'accept_unavailable');
      return;
    }
    const senderHash = (offer.senderReticulumDestinationHash || peerHash).trim().toLowerCase();
    if (!senderHash) {
      loggerWarn(
        `[ReticulumChat] Cannot accept event page resource group=${offer.groupId}: missing sender Reticulum identity`
      );
      this.handleEventPageResourceFailure(offer.transferId, 'missing_sender_identity');
      return;
    }
    let reticulumIdentityPublicKeyBase64 =
      offer.senderReticulumIdentityPublicKeyBase64?.trim() ?? '';
    if (!reticulumIdentityPublicKeyBase64) {
      if (normalizePeerHashFromWire(senderHash)) {
        const resolvedIdentity = await this.ensureResourcePeerIdentity(senderHash, 'event-page-resource');
        if (resolvedIdentity === null) {
          this.handleEventPageResourceFailure(offer.transferId, 'missing_sender_identity');
          return;
        }
        reticulumIdentityPublicKeyBase64 = resolvedIdentity;
      }
    }
    const authMessage =
      await this.buildSignedResourceAuthWire(offer.groupId, offer.transferId, 'RCP');
    if (!authMessage) {
      if (this.scheduleSignedResourceAuthRetry('event_page', senderHash, offer)) return;
      this.handleEventPageResourceFailure(offer.transferId, 'signed_auth_unavailable');
      return;
    }
    this.clearSignedResourceAuthRetry('event_page', offer.transferId);
    const result = await this.bridge.acceptReticulumChatResourceDetailed({
      peerPresenceHash: senderHash,
      reticulumIdentityPublicKeyBase64,
      transferId: offer.transferId,
      savePath: this.tempEventBlobPath(`${offer.transferId}.page.recv`),
      fileName: `${offer.groupId}-${offer.transferId}.event-page.json`,
      size: offer.sizeBytes,
      sha256: offer.pageHash,
      metadata: {
        resourceType: 'reticulum_chat_event_page',
        groupId: offer.groupId,
        channelId: offer.channelId,
        pageHash: offer.pageHash,
      },
      authMessage,
    });
    if (!result.ok) {
      const failed = result as Exclude<ReticulumSendResult, { ok: true }>;
      this.handleEventPageResourceFailure(
        offer.transferId,
        failed.error ?? failed.reason ?? 'accept_failed'
      );
    }
  }

  private async registerOfferResourceIdentity(
    peerHash: string,
    identityPublicKeyBase64: string | undefined
  ): Promise<boolean> {
    const peer = normalizePeerHashFromWire(peerHash);
    const publicKey = normalizeReticulumIdentityPublicKeyBase64(identityPublicKeyBase64);
    if (!peer || !publicKey || !this.bridge) return false;
    if (typeof this.bridge.registerPeerIdentityFromGroupJoin !== 'function') return false;
    return this.bridge.registerPeerIdentityFromGroupJoin(peer, publicKey);
  }

  handleResourceEvent(payload: ReticulumChatResourcePayload): void {
    if (payload?.status === 'auth' && payload.linkId && payload.transferId) {
      void this.authorizeResource(payload);
      return;
    }
    if (payload?.status === 'failed' && payload.transferId) {
      if (this.directDmPageRequests.has(payload.transferId)) {
        this.directDmPageRequests.delete(payload.transferId);
      } else if (this.eventPageOffers.has(payload.transferId) || this.directHistoryPageRequests.has(payload.transferId)) {
        this.handleEventPageResourceFailure(
          payload.transferId,
          typeof payload.reason === 'string' ? payload.reason : 'resource_failed'
        );
      } else {
        this.handleEventResourceFailure(
          payload.transferId,
          typeof payload.reason === 'string' ? payload.reason : 'resource_failed'
        );
      }
      return;
    }
    if (payload?.status !== 'received' || !payload.path || !payload.transferId) return;
    if (this.directDmPageRequests.has(payload.transferId)) {
      void this.importReceivedDirectDmPageResource(payload);
    } else if (this.eventPageOffers.has(payload.transferId) || this.directHistoryPageRequests.has(payload.transferId)) {
      void this.importReceivedEventPageResource(payload);
    } else {
      void this.importReceivedEventResource(payload);
    }
  }

  handleGenericResourceEvent(payload: ReticulumChatResourcePayload): void {
    const authType =
      payload.auth && typeof payload.auth === 'object'
        ? String(payload.auth.type || '')
        : '';
    const resourceType = String(
      payload.resourceType ??
        payload.metadata?.resourceType ??
        payload.metadata?.logicalResourceType ??
        payload.fileName ??
        ''
    );
    if (
      authType === 'RETICULUM_DM_RESOURCE_AUTH' ||
      resourceType.startsWith('reticulum_resource_dm')
    ) {
      this.directResourceTransfer?.handleResourceEvent(payload);
      return;
    }
    this.resourceTransfer?.handleResourceEvent(payload);
  }

  private async importReceivedDirectDmPageResource(payload: ReticulumChatResourcePayload): Promise<void> {
    if (!payload.path || !payload.transferId) return;
    const request = this.directDmPageRequests.get(payload.transferId);
    if (!request) return;
    try {
      const blob = fs.readFileSync(payload.path, 'utf8');
      const actualHash = hashReticulumDmPageResource(blob);
      const expectedHash = String(request.pageHash || '').trim().toLowerCase();
      if (expectedHash && actualHash !== expectedHash) {
        this.directDmPageRequests.delete(payload.transferId);
        loggerWarn(
          `[ReticulumChat] dm_page_hash_mismatch transfer=${payload.transferId} expected=${expectedHash} actual=${actualHash}`
        );
        return;
      }
      const parsed = JSON.parse(blob) as Partial<ReticulumDmPageResource>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        parsed.v !== 1 ||
        parsed.c !== request.conversationId ||
        !Array.isArray(parsed.events) ||
        parsed.events.length > Math.max(1, Math.min(50, Number(request.limit || 50)))
      ) {
        this.directDmPageRequests.delete(payload.transferId);
        loggerWarn(`[ReticulumChat] invalid_dm_page transfer=${payload.transferId}`);
        return;
      }
      let accepted = false;
      let lastEvent: ReticulumDmEvent | null = null;
      for (const wireEvent of parsed.events) {
        const event = reticulumDmEventFromWire(wireEvent);
        if (!event || event.conversationId !== request.conversationId) continue;
        const inserted = this.acceptDirectEvent(event, false);
        accepted = accepted || inserted;
        if (
          !lastEvent ||
          event.timestamp > lastEvent.timestamp ||
          (event.timestamp === lastEvent.timestamp && event.eventId > lastEvent.eventId)
        ) {
          lastEvent = event;
        }
      }
      this.directDmPageRequests.delete(payload.transferId);
      loggerLog(
        `[ReticulumChat] dm_page_imported conversation=${request.conversationId.slice(0, 16)} peer=${(request.sourcePeerHash || '').slice(0, 16)} events=${parsed.events.length} accepted=${accepted} more=${parsed.more === true}`
      );
      if (parsed.more === true && lastEvent && request.sourcePeerHash) {
        await this.requestDirectMissingEvents(
          request.conversationId,
          lastEvent.senderAddress,
          lastEvent.recipientAddress,
          request.sourcePeerHash,
          lastEvent.eventId,
          Number.MAX_SAFE_INTEGER,
          undefined,
          { force: true }
        );
      }
    } catch (err) {
      this.directDmPageRequests.delete(payload.transferId);
      loggerWarn(
        `[ReticulumChat] dm_page_import_failed transfer=${payload.transferId} reason=${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async importReceivedEventPageResource(payload: ReticulumChatResourcePayload): Promise<void> {
    if (!payload.path || !payload.transferId) return;
    const isDirectHistoryPageRequest = this.directHistoryPageRequests.has(payload.transferId);
    const offer =
      this.eventPageOffers.get(payload.transferId) ??
      this.directHistoryPageRequests.get(payload.transferId);
    if (!offer) return;
    const expectedPageHash = offer.pageHash.trim().toLowerCase();
    try {
      const blob = fs.readFileSync(payload.path, 'utf8');
      const pageHash = hashReticulumChatEventPage(blob);
      if (expectedPageHash && pageHash !== expectedPageHash) {
        this.handleEventPageResourceFailure(offer.transferId, 'page_hash_mismatch');
        return;
      }
      const parsed = JSON.parse(blob) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.handleEventPageResourceFailure(offer.transferId, 'invalid_event_page');
        return;
      }
      const page = parsed as Partial<ReticulumChatEventPageResource>;
      if (
        page.v !== 1 ||
        page.g !== offer.groupId ||
        page.c !== offer.channelId ||
        page.d !== offer.direction ||
        feedPriorityFromWire(page.p) !== offer.priority ||
        typeof page.wh !== 'string' ||
        !Array.isArray(page.events) ||
        page.events.length > offer.eventCount ||
        page.events.length > RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS
      ) {
        this.handleEventPageResourceFailure(offer.transferId, 'invalid_event_page');
        return;
      }
      const sourcePeerHash = offer.sourcePeerHash || payload.peerPresenceHash || '';
      const repairRange = offer.direction === 'range'
        ? normalizeReticulumChatAuthorRange(offer.repairRange)
        : null;
      const validWindowEvents: ReticulumChatEvent[] = [];
      let insertedCount = 0;
      let insertedRepairRangeCount = 0;
      let rejectedInvalidCount = 0;
      let rejectedOutOfBoundsCount = 0;
      let rejectedNonMemberCount = 0;
      let skippedKnownCount = 0;
      let processedSinceYield = 0;
      for (const candidate of page.events) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          rejectedInvalidCount += 1;
          this.notePeerViolation(sourcePeerHash, 'event_page_invalid_event');
          continue;
        }
        const candidateEventId =
          typeof (candidate as Partial<ReticulumChatEvent>).eventId === 'string'
            ? (candidate as Partial<ReticulumChatEvent>).eventId?.trim() ?? ''
            : '';
        if (candidateEventId && this.db.hasEvent(candidateEventId)) {
          skippedKnownCount += 1;
          const candidateGroupId = (candidate as Partial<ReticulumChatEvent>).groupId;
          if (candidateGroupId === offer.groupId) {
            this.pendingEventPulls.delete(
              this.eventPullKey(offer.groupId, candidateEventId)
            );
          }
          processedSinceYield += 1;
          if (processedSinceYield >= RETICULUM_CHAT_EVENT_PAGE_IMPORT_YIELD_EVERY) {
            processedSinceYield = 0;
            await this.yieldEventPageImportTurn();
          }
          continue;
        }
        const acceptedEvent = await this.acceptableInboundEventResource(candidate);
        if (!acceptedEvent) {
          rejectedInvalidCount += 1;
          this.notePeerViolation(sourcePeerHash, 'event_page_invalid_event');
          continue;
        }
        const event = acceptedEvent;
        if (
          event.groupId !== offer.groupId ||
          (offer.priority === 'metadata' && !CHANNEL_METADATA_EVENT_TYPES.has(event.eventType)) ||
          (
            offer.channelId !== RETICULUM_CHAT_ALL_CHANNELS_ID &&
            normalizeReticulumChatChannelId(event.channelId) !== offer.channelId
          )
        ) {
          rejectedOutOfBoundsCount += 1;
          this.notePeerViolation(sourcePeerHash, 'event_page_out_of_bounds');
          continue;
        }
        const authorIsMember = await this.isValidatedGroupMember(
          event.groupId,
          event.authorAddress
        );
        if (!authorIsMember) {
          rejectedNonMemberCount += 1;
          this.notePeerViolation(sourcePeerHash, 'event_page_non_member_author');
          continue;
        }
        if (!(await this.canAcceptEventForChannelWritePolicy(event))) {
          rejectedInvalidCount += 1;
          this.notePeerViolation(sourcePeerHash, 'event_page_channel_write_forbidden');
          continue;
        }
        if (
          isDirectHistoryPageRequest &&
          !(await this.canRequesterReadEvent(event, offer.requesterAddress))
        ) {
          rejectedInvalidCount += 1;
          this.notePeerViolation(sourcePeerHash, 'event_page_channel_read_forbidden');
          continue;
        }
        validWindowEvents.push(event);
        this.noteEventSourcePeer(event.eventId, sourcePeerHash);
        this.requestMissingAuthorRangeBeforeAccept(event, sourcePeerHash);
        if (this.acceptValidatedEvent(event, false, { emitSummary: false })) {
          insertedCount += 1;
          if (
            repairRange &&
            event.authorAddress === repairRange.a &&
            event.authorSeq >= repairRange.from &&
            event.authorSeq <= repairRange.to
          ) {
            insertedRepairRangeCount += 1;
          }
          this.pendingEventPulls.delete(this.eventPullKey(event.groupId, event.eventId));
          this.emit('event', { event });
        }
        processedSinceYield += 1;
        if (processedSinceYield >= RETICULUM_CHAT_EVENT_PAGE_IMPORT_YIELD_EVERY) {
          processedSinceYield = 0;
          await this.yieldEventPageImportTurn();
        }
      }
      const start = this.cursorFromWire(page.start);
      const end = this.cursorFromWire(page.end);
      if (
        skippedKnownCount === 0 &&
        offer.channelId !== RETICULUM_CHAT_ALL_CHANNELS_ID &&
        start &&
        end &&
        page.wh === this.db.computeWindowHash(validWindowEvents)
      ) {
        this.db.upsertVerifiedWindow(
          offer.groupId,
          offer.channelId,
          start,
          end,
          page.wh,
          this.now()
        );
      } else if (
        offer.channelId !== RETICULUM_CHAT_ALL_CHANNELS_ID &&
        skippedKnownCount === 0 &&
        validWindowEvents.length > 0
      ) {
        this.notePeerViolation(sourcePeerHash, 'event_page_window_hash_mismatch');
      }
      if (insertedCount > 0) {
        this.emitSummaryChanged(offer.groupId);
      }
      if (repairRange && sourcePeerHash && insertedRepairRangeCount > 0) {
        this.clearAuthorGapRangeSuppression(sourcePeerHash, offer.groupId, repairRange);
      }
      const noProgressKnownPage =
        insertedCount === 0 &&
        skippedKnownCount > 0 &&
        rejectedInvalidCount === 0 &&
        rejectedOutOfBoundsCount === 0 &&
        rejectedNonMemberCount === 0;
      if (noProgressKnownPage && sourcePeerHash && offer.direction !== 'range') {
        this.markHistoryPageNoProgress(
          sourcePeerHash,
          offer,
          page.more === true ? 'known_page_more' : 'known_page'
        );
      }
      loggerLog(
        `[ReticulumChat] event_page_imported group=${offer.groupId} channel=${offer.channelId} peer=${sourcePeerHash.slice(0, 16)} events=${page.events.length} inserted=${insertedCount} skipped_known=${skippedKnownCount} rejected_invalid=${rejectedInvalidCount} rejected_bounds=${rejectedOutOfBoundsCount} rejected_non_member=${rejectedNonMemberCount} more=${page.more === true}`
      );
      this.cancelRelatedDirectHistoryPageRequests(
        {
          ...offer,
          sourcePeerHash,
        },
        payload.transferId,
        'history_page_satisfied'
      );
      if (page.more === true) {
        if (offer.direction === 'range') {
          if (sourcePeerHash && repairRange && insertedRepairRangeCount === 0) {
            this.markAuthorGapRangeNoProgress(
              sourcePeerHash,
              offer.groupId,
              repairRange,
              'range_page_more_no_progress'
            );
          } else if (sourcePeerHash) {
            this.requestKnownAuthorGaps(
              offer.groupId,
              sourcePeerHash,
              'range_page_more',
              true
            );
          }
        } else if (noProgressKnownPage) {
          loggerLog(
            `[ReticulumChat] history_page_more_stopped_no_progress group=${offer.groupId} channel=${offer.channelId} peer=${sourcePeerHash.slice(0, 16)} transfer=${offer.transferId} direction=${offer.direction}`
          );
        } else {
          const cursor = this.cursorFromWire(offer.direction === 'before' ? page.start : page.end);
          if (cursor && sourcePeerHash) {
            if (
              isDirectHistoryPageRequest &&
              !this.didDirectHistoryPageCursorAdvance(offer, cursor)
            ) {
              loggerWarn(
                `[ReticulumChat] history_page_more_stalled group=${offer.groupId} channel=${offer.channelId} peer=${sourcePeerHash.slice(0, 16)} transfer=${offer.transferId} direction=${offer.direction} cursor=${cursor.eventId}`
              );
            } else {
              void this.requestLinkedHistoryPage(
                sourcePeerHash,
                offer.groupId,
                offer.channelId,
                cursor,
                offer.direction,
                false,
                'event-page-more',
                sourcePeerHash,
                offer.priority
              );
            }
          }
        }
      } else if (repairRange && sourcePeerHash && insertedRepairRangeCount === 0) {
        this.markAuthorGapRangeNoProgress(
          sourcePeerHash,
          offer.groupId,
          repairRange,
          'range_page_no_progress'
        );
      }
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to import event page resource:', err);
      this.handleEventPageResourceFailure(offer.transferId, 'page_import_failed');
    } finally {
      this.eventPageOffers.delete(payload.transferId);
      this.removeDirectHistoryPageRequest(payload.transferId);
    }
  }

  private async importReceivedEventResource(payload: ReticulumChatResourcePayload): Promise<void> {
    if (!payload.path || !payload.transferId) return;
    const offer = this.resourceOffers.get(payload.transferId);
    if (!offer) return;
    try {
      const blob = fs.readFileSync(payload.path, 'utf8');
      const wireHash = nodeCrypto.createHash('sha256').update(blob, 'utf8').digest('hex');
      if (wireHash !== offer.wireHash.toLowerCase()) {
        this.retryEventPullAfterResourceFailure(offer, 'wire_hash_mismatch');
        return;
      }
      const parsed = JSON.parse(blob) as unknown;
      if (offer.relayStore === true) {
        if (isDisabledRelayCache) {
          this.sendRelayAck(offer.sourcePeerHash || payload.peerPresenceHash || '', offer.groupId, offer.eventId, false, 'relay-cache-disabled');
          return;
        }
        if (!this.canStoreRelayEventResource(parsed)) {
          loggerWarn(
            `[ReticulumChat] relay_store rejected event=${offer.eventId} reason=invalid_event_resource`
          );
          this.sendRelayAck(offer.sourcePeerHash || payload.peerPresenceHash || '', offer.groupId, offer.eventId, false, 'invalid_event_resource');
          return;
        }
        const event = parsed as ReticulumChatEvent;
        if (event.groupId !== offer.groupId || event.eventId !== offer.eventId) {
          loggerWarn(
            `[ReticulumChat] relay_store rejected event=${offer.eventId} reason=offer_mismatch`
          );
          this.sendRelayAck(offer.sourcePeerHash || payload.peerPresenceHash || '', offer.groupId, offer.eventId, false, 'offer_mismatch');
          return;
        }
        const stored = this.db.storeRelayEventBlob(
          event,
          blob,
          offer.sourcePeerHash || payload.peerPresenceHash || '',
          this.now()
        );
        if ('reason' in stored) {
          loggerWarn(
            `[ReticulumChat] relay_store rejected event=${event.eventId} reason=${stored.reason}`
          );
          this.sendRelayAck(offer.sourcePeerHash || payload.peerPresenceHash || '', offer.groupId, offer.eventId, false, stored.reason);
          return;
        }
        loggerLog(
          `[ReticulumChat] relay_store accepted event=${event.eventId} group=${event.groupId} blob=${stored.blobId} stored=${stored.stored}`
        );
        this.sendRelayAck(offer.sourcePeerHash || payload.peerPresenceHash || '', offer.groupId, offer.eventId, true, undefined, stored.blobId);
        return;
      }
      const acceptedEvent = await this.acceptableInboundEventResource(parsed);
      if (!acceptedEvent) {
        this.retryEventPullAfterResourceFailure(offer, 'invalid_event_resource');
        return;
      }
      const candidate = acceptedEvent;
      const authorIsMember = await this.isValidatedGroupMember(
        candidate.groupId,
        candidate.authorAddress
      );
      if (!authorIsMember) {
        this.retryEventPullAfterResourceFailure(offer, 'non_member_event_author');
        return;
      }
      const event = parsed as ReticulumChatEvent;
      if (!(await this.canAcceptEventForChannelWritePolicy(event))) {
        this.notePeerViolation(
          offer.sourcePeerHash || payload.peerPresenceHash || '',
          'event_resource_channel_write_forbidden'
        );
        return;
      }
      const sourcePeerHash = offer.sourcePeerHash || payload.peerPresenceHash || '';
      this.requestMissingAuthorRangeBeforeAccept(event, sourcePeerHash);
      if (this.acceptEvent(parsed, false)) {
        this.noteEventSourcePeer(event.eventId, sourcePeerHash);
        this.pendingEventPulls.delete(this.eventPullKey(event.groupId, event.eventId));
        this.emit('event', { event });
        this.requestFeedContinuationFromOffer(offer, event, sourcePeerHash);
        const exclude = payload.peerPresenceHash ? [payload.peerPresenceHash] : [];
        void this.sendEventHintToInterestedPeers(event, exclude).then((targetedPeers) => {
          void this.fanout(this.buildEventHintWire(event), [...exclude, ...targetedPeers]);
        });
      } else {
        this.retryEventPullAfterResourceFailure(offer, 'invalid_event_resource');
      }
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to import event resource:', err);
      this.retryEventPullAfterResourceFailure(offer, 'resource_import_failed');
    } finally {
      this.resourceOffers.delete(payload.transferId);
    }
  }

  private requestFeedContinuationFromOffer(
    offer: ReticulumChatEventOffer,
    event: ReticulumChatEvent,
    peerHash: string
  ): void {
    const continuation = offer.continuation;
    const peer = peerHash.trim().toLowerCase();
    if (!continuation || !peer) return;
    if (event.eventId !== continuation.cursor.eventId) return;
    if (event.groupId !== offer.groupId) return;
    if (!this.localGroupIds.has(event.groupId) || !this.subscribedGroups.has(event.groupId)) return;
    if (
      continuation.channelId !== RETICULUM_CHAT_ALL_CHANNELS_ID &&
      normalizeReticulumChatChannelId(event.channelId) !== continuation.channelId
    ) {
      return;
    }
    const wire: Extract<ReticulumChatWire, { k: 'feed_req' }> = {
      t: 'RCHAT',
      k: 'feed_req',
      g: event.groupId,
      c: continuation.channelId,
      [continuation.direction]: this.cursorToWire(continuation.cursor),
      limit: RETICULUM_CHAT_MAX_FEED_PAGE_EVENTS,
    };
    loggerLog(
      `[ReticulumChat] Requesting feed continuation group=${event.groupId} channel=${continuation.channelId} peer=${peer.slice(0, 16)} direction=${continuation.direction} cursor=${continuation.cursor.eventId}`
    );
    this.sendRepairFeedRequest(peer, wire, 'event-resource-continuation');
  }

  private async acceptableInboundEventResource(candidate: unknown): Promise<ReticulumChatEvent | null> {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    if (!validateReticulumChatEventShape(candidate, this.now())) return null;
    const event = candidate as ReticulumChatEvent;
    if (!this.localGroupIds.has(event.groupId)) return null;
    if (!verifyReticulumChatEvent(event)) return null;
    if (!(await this.canLocalUserReadEvent(event))) return null;
    return event;
  }

  private canStoreRelayEventResource(candidate: unknown): candidate is ReticulumChatEvent {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    if (!validateReticulumChatEventShape(candidate, this.now())) return false;
    const event = candidate as ReticulumChatEvent;
    if (!this.isRelayEligibleEvent(event)) return false;
    return verifyReticulumChatEvent(event);
  }

  private handleEventResourceFailure(transferId: string, reason: string): void {
    const offer = this.resourceOffers.get(transferId);
    if (!offer) return;
    this.resourceOffers.delete(transferId);
    this.retryEventPullAfterResourceFailure(offer, reason);
  }

  private handleEventPageResourceFailure(transferId: string, reason: string): void {
    const offer =
      this.eventPageOffers.get(transferId) ??
      this.directHistoryPageRequests.get(transferId);
    if (!offer) return;
    this.eventPageOffers.delete(transferId);
    this.removeDirectHistoryPageRequest(transferId);
    loggerWarn(
      `[ReticulumChat] Event page resource failed group=${offer.groupId} channel=${offer.channelId} peer=${(offer.sourcePeerHash || '').slice(0, 16) || 'unknown'} reason=${reason}`
    );
  }

  private retryEventPullAfterResourceFailure(
    offer: ReticulumChatEventOffer,
    reason: string
  ): void {
    const queueKey = this.eventPullKey(offer.groupId, offer.eventId);
    const item = this.pendingEventPulls.get(queueKey);
    if (!item || this.db.hasEvent(offer.eventId)) return;
    const failedPeer = (
      offer.sourcePeerHash ||
      offer.senderReticulumDestinationHash ||
      ''
    ).trim().toLowerCase();
    if (failedPeer) item.peerHashes.delete(failedPeer);
    item.inFlight = false;
    item.nextAttemptAt = 0;
    if (item.peerHashes.size === 0) {
      this.enqueueRelayQuery(offer.groupId, [offer.eventId], `resource-failed:${reason}`);
      this.pendingEventPulls.delete(queueKey);
      return;
    }
    loggerWarn(
      `[ReticulumChat] Event resource failed for ${offer.eventId}, trying another peer:`,
      reason
    );
    this.scheduleEventPullQueue();
  }

  private async authorizeResource(payload: ReticulumChatResourcePayload): Promise<void> {
    if (!this.bridge || !payload.linkId || !payload.transferId) return;
    const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
    if (auth.type === 'RETICULUM_CHAT_DM_PAGE_REQUEST') {
      await this.authorizeDirectDmPageResource(payload, auth);
      return;
    }
    if (auth.type === 'RETICULUM_CHAT_HISTORY_PAGE_REQUEST') {
      await this.authorizeLinkedHistoryPageResource(payload, auth);
      return;
    }
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const eventId = String(auth.eventId || auth.id || payload.eventId || metadata.eventId || '');
    const groupId = Number(auth.groupId || auth.g || payload.groupId || metadata.groupId || 0);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      await this.bridge.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
        reason: 'bad_resource_auth',
      });
      return;
    }
    const now = this.now();
    if (!isDisabledRelayCache) {
      for (const [transferId, relay] of this.outboundRelayStoreEventResources) {
        if (relay.expiresAt <= now) this.outboundRelayStoreEventResources.delete(transferId);
      }
      const relayStore = this.outboundRelayStoreEventResources.get(payload.transferId);
      if (
        relayStore &&
        relayStore.groupId === groupId &&
        (!eventId || relayStore.eventId === eventId) &&
        relayStore.expiresAt > now
      ) {
        loggerLog(
          `[ReticulumChat] relay_store_resource_authorized group=${groupId} event=${relayStore.eventId} transfer=${payload.transferId}`
        );
        await this.bridge.authorizeReticulumChatResourceDetailed?.({
          linkId: payload.linkId,
          transferId: payload.transferId,
        });
        return;
      }
    }
    for (const [transferId, page] of this.outboundEventPageResources) {
      if (page.expiresAt <= now) this.outboundEventPageResources.delete(transferId);
    }
    const page = this.outboundEventPageResources.get(payload.transferId);
    const pageHash = String(auth.pageHash || auth.ph || metadata.pageHash || payload.wireHash || payload.sha256 || '');
    if (
      !eventId &&
      page &&
      page.groupId === groupId &&
      page.expiresAt > now &&
      (!pageHash || pageHash.toLowerCase() === page.pageHash.toLowerCase())
    ) {
      const compactPageAuth =
        auth.t === 'RCP'
          ? {
              t: 'RCP' as const,
              x: String(auth.x || payload.transferId || ''),
              g: groupId,
              a: String(auth.a || ''),
              p: String(auth.p || ''),
              ts: Number(auth.ts || 0),
              z: String(auth.z || ''),
            }
          : null;
      const requestedPriority = compactPageAuth ? undefined : feedPriorityFromWire(auth.p);
      const pageRequest: ReticulumChatHistoryPageRequestWire | null = compactPageAuth
        ? null
        : {
            c:
              auth.c === RETICULUM_CHAT_ALL_CHANNELS_ID
                ? RETICULUM_CHAT_ALL_CHANNELS_ID
                : normalizeReticulumChatChannelId(auth.c ?? page.channelId),
            d: auth.d === 'after' ? 'after' : 'before',
            ...(isFeedCursorWire(auth.after) ? { after: auth.after } : {}),
            ...(isFeedCursorWire(auth.before) ? { before: auth.before } : {}),
            ...(auth.inc === 1 ? { inc: 1 as const } : {}),
            ...(requestedPriority ? { p: feedPriorityToWire(requestedPriority) } : {}),
            limit: this.normalizeFeedLimit(auth.limit),
            a: String(auth.a || ''),
            pk: String(auth.pk || ''),
            ts: Number(auth.ts || 0),
            sig: String(auth.sig || ''),
          };
      if (!compactPageAuth && auth.p != null && !requestedPriority) {
        await this.bridge.rejectReticulumChatResourceDetailed?.({
          linkId: payload.linkId,
          transferId: payload.transferId,
          reason: 'invalid_history_priority',
        });
        return;
      }
      const pageAuthOk = compactPageAuth
        ? compactPageAuth.x === payload.transferId &&
          verifyReticulumChatResourceAuth(groupId, compactPageAuth, now)
        : !!pageRequest && verifyReticulumChatHistoryPageRequest(groupId, pageRequest, now);
      if (!pageAuthOk) {
        await this.bridge.rejectReticulumChatResourceDetailed?.({
          linkId: payload.linkId,
          transferId: payload.transferId,
          reason: 'signed_request_required',
        });
        return;
      }
      const requesterAddress = compactPageAuth ? compactPageAuth.a : pageRequest?.a ?? '';
      const requesterIsMember = await this.isValidatedRequesterGroupMember(
        groupId,
        requesterAddress,
        'event_page_resource'
      );
      if (requesterIsMember !== true) {
        await this.bridge.rejectReticulumChatResourceDetailed?.({
          linkId: payload.linkId,
          transferId: payload.transferId,
          reason: requesterIsMember === null
            ? 'requester_membership_unavailable'
            : 'requester_not_group_member',
        });
        return;
      }
      if (
        page.channelId !== RETICULUM_CHAT_ALL_CHANNELS_ID &&
        !(await this.canRequesterReadChannel(groupId, page.channelId, requesterAddress))
      ) {
        await this.bridge.rejectReticulumChatResourceDetailed?.({
          linkId: payload.linkId,
          transferId: payload.transferId,
          reason: 'channel_read_forbidden',
        });
        return;
      }
      for (const pageEventId of page.eventIds) {
        const pageEvent = this.db.getEvent(pageEventId);
        if (pageEvent && !(await this.canRequesterReadEvent(pageEvent, requesterAddress))) {
          await this.bridge.rejectReticulumChatResourceDetailed?.({
            linkId: payload.linkId,
            transferId: payload.transferId,
            reason: 'channel_read_forbidden',
          });
          return;
        }
      }
      loggerLog(
        `[ReticulumChat] event_page_auth_authorized group=${groupId} channel=${page.channelId} requester=${requesterAddress} transfer=${payload.transferId} link=${payload.linkId} events=${page.eventIds.size}`
      );
      await this.bridge.authorizeReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
      });
      return;
    }
    if (!eventId) {
      loggerWarn(
        `[ReticulumChat] event_page_auth_rejected transfer=${payload.transferId} link=${payload.linkId} group=${groupId} reason=bad_page_resource_auth has_page=${page ? 'yes' : 'no'} page_hash_match=${page && pageHash ? pageHash.toLowerCase() === page.pageHash.toLowerCase() : 'n/a'}`
      );
      await this.bridge.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
        reason: 'bad_resource_auth',
      });
      return;
    }
    const event = this.db.getEvent(eventId);
    if (!event || event.groupId !== groupId) {
      if (isDisabledRelayCache) {
        await this.bridge.rejectReticulumChatResourceDetailed?.({
          linkId: payload.linkId,
          transferId: payload.transferId,
          reason: 'unknown_event',
        });
        return;
      }
      for (const [transferId, relay] of this.outboundRelayCachedEventResources) {
        if (relay.expiresAt <= now) this.outboundRelayCachedEventResources.delete(transferId);
      }
      const relay = this.outboundRelayCachedEventResources.get(payload.transferId);
      if (relay && relay.groupId === groupId && relay.eventId === eventId && relay.expiresAt > now) {
        const compactAuth =
          auth.t === 'RCR'
            ? {
                t: 'RCR' as const,
                x: String(auth.x || payload.transferId || ''),
                g: groupId,
                a: String(auth.a || ''),
                p: String(auth.p || ''),
                ts: Number(auth.ts || 0),
                z: String(auth.z || ''),
              }
            : null;
        const request = compactAuth
          ? null
          : {
              id: eventId,
              a: String(auth.a || auth.authorAddress || ''),
              pk: String(auth.pk || ''),
              ts: Number(auth.ts || 0),
              sig: String(auth.sig || ''),
            };
        const authOk = compactAuth
          ? compactAuth.x === payload.transferId &&
            verifyReticulumChatResourceAuth(groupId, compactAuth, now)
          : !!request && verifyReticulumChatEventRequest(groupId, request, now);
        if (!authOk) {
          await this.bridge.rejectReticulumChatResourceDetailed?.({
            linkId: payload.linkId,
            transferId: payload.transferId,
            reason: 'signed_request_required',
          });
          return;
        }
        const requesterAddress = compactAuth ? compactAuth.a : request?.a ?? '';
        const requesterIsMember = await this.isValidatedRequesterGroupMember(
          groupId,
          requesterAddress,
          'relay_cached_event_resource'
        );
        if (requesterIsMember !== true) {
          await this.bridge.rejectReticulumChatResourceDetailed?.({
            linkId: payload.linkId,
            transferId: payload.transferId,
            reason: requesterIsMember === null
              ? 'requester_membership_unavailable'
              : 'requester_not_group_member',
          });
          return;
        }
        if (!(await this.canRequesterReadEvent(relay.event, requesterAddress))) {
          await this.bridge.rejectReticulumChatResourceDetailed?.({
            linkId: payload.linkId,
            transferId: payload.transferId,
            reason: 'channel_read_forbidden',
          });
          return;
        }
        await this.bridge.authorizeReticulumChatResourceDetailed?.({
          linkId: payload.linkId,
          transferId: payload.transferId,
        });
        return;
      }
      await this.bridge.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
        reason: 'unknown_event',
      });
      return;
    }
    const compactAuth =
      auth.t === 'RCR'
        ? {
            t: 'RCR' as const,
            x: String(auth.x || payload.transferId || ''),
            g: groupId,
            a: String(auth.a || ''),
            p: String(auth.p || ''),
            ts: Number(auth.ts || 0),
            z: String(auth.z || ''),
          }
        : null;
    const requesterAddress =
      compactAuth
        ? compactAuth.a
        : typeof auth.a === 'string'
          ? auth.a
            : typeof auth.authorAddress === 'string'
              ? auth.authorAddress
              : '';
    const request = compactAuth
      ? null
      : {
          id: eventId,
          a: requesterAddress,
          pk: typeof auth.pk === 'string' ? auth.pk : '',
          ts: Number(auth.ts || 0),
          sig: typeof auth.sig === 'string' ? auth.sig : '',
        };
    const authOk = compactAuth
      ? compactAuth.x === payload.transferId &&
        verifyReticulumChatResourceAuth(groupId, compactAuth, now)
      : !!request && verifyReticulumChatEventRequest(groupId, request, now);
    if (!authOk) {
      await this.bridge.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
        reason: 'signed_request_required',
      });
      return;
    }
    const requesterIsMember = await this.isValidatedRequesterGroupMember(
      groupId,
      requesterAddress,
      'event_resource'
    );
    if (requesterIsMember !== true) {
      await this.bridge.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
        reason: requesterIsMember === null
          ? 'requester_membership_unavailable'
          : 'requester_not_group_member',
      });
      return;
    }
    if (
      !(await this.canRequesterReadEvent(event, requesterAddress))
    ) {
      await this.bridge.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId,
        transferId: payload.transferId,
        reason: 'channel_read_forbidden',
      });
      return;
    }
    await this.bridge.authorizeReticulumChatResourceDetailed?.({
      linkId: payload.linkId,
      transferId: payload.transferId,
    });
  }

  private buildDirectDmPageResourceBlob(
    conversationId: string,
    events: ReticulumDmEvent[],
    after: number,
    hasMore: boolean
  ): {
    pageEvents: ReticulumDmEvent[];
    blob: string;
    pageHash: string;
    sizeBytes: number;
    eventCount: number;
    hasMore: boolean;
  } | null {
    const boundedEvents = events.filter((event) => event.conversationId === conversationId);
    if (boundedEvents.length === 0) return null;
    let pageEvents = boundedEvents;
    let truncatedForSize = false;
    while (pageEvents.length > 0) {
      const page: ReticulumDmPageResource = {
        v: 1,
        c: conversationId,
        after,
        ...(hasMore || truncatedForSize ? { more: true } : {}),
        events: pageEvents.map(reticulumDmEventForWire),
      };
      const blob = serializeReticulumDmPageResource(page);
      const sizeBytes = Buffer.byteLength(blob, 'utf8');
      if (sizeBytes <= RETICULUM_CHAT_MAX_EVENT_PAGE_BYTES) {
        return {
          pageEvents,
          blob,
          pageHash: hashReticulumDmPageResource(blob),
          sizeBytes,
          eventCount: pageEvents.length,
          hasMore: page.more === true,
        };
      }
      truncatedForSize = true;
      pageEvents = pageEvents.slice(0, -1);
    }
    return null;
  }

  private async authorizeDirectDmPageResource(
    payload: ReticulumChatResourcePayload,
    auth: Record<string, unknown>
  ): Promise<void> {
    if (!this.bridge || !payload.linkId || !payload.transferId) return;
    const reject = async (reason: string) => {
      await this.bridge?.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId!,
        transferId: payload.transferId!,
        reason,
      });
    };
    if (typeof this.bridge.sendReticulumChatResourceDetailed !== 'function') {
      await reject('send_unavailable');
      return;
    }
    const request: ReticulumDmRequestWire = {
      b: String(auth.b || ''),
      a: Number(auth.a ?? auth.after ?? 0),
      l: Number(auth.l ?? auth.limit ?? 50),
      q: String(auth.q || auth.requestId || payload.transferId || ''),
      rp: String(auth.rp || auth.requesterPeerHash || ''),
      p: String(auth.p || ''),
      n: Number(auth.n || auth.timestamp || 0),
      z: String(auth.z || auth.signature || ''),
    };
    if (
      String(auth.transferId || payload.transferId || '') !== payload.transferId ||
      !verifyReticulumDmRequest(request, this.now())
    ) {
      await reject('signed_request_required');
      return;
    }
    const requesterAddress = deriveReticulumControlAuthor(request.p);
    const peerAddress = typeof request.b === 'string' ? request.b.trim() : '';
    const conversationId = reticulumDmConversationId(requesterAddress, peerAddress);
    if (!requesterAddress || !peerAddress || !conversationId) {
      await reject('bad_dm_request');
      return;
    }
    const requesterPeerHash = this.normalizeResourcePeerHash(request.rp);
    if (!requesterPeerHash) {
      await reject('missing_requester_peer');
      return;
    }
    const after = Math.max(0, Math.floor(Number(request.a ?? request.after ?? 0)));
    const limit = Math.max(1, Math.min(50, Math.floor(Number(request.l ?? request.limit ?? 50))));
    const events = this.db.getDirectEventsAfter(conversationId, after, limit + 1);
    if (events.length === 0) {
      await reject('no_dm_events');
      return;
    }
    const pageEvents = events.slice(0, limit);
    const page = this.buildDirectDmPageResourceBlob(
      conversationId,
      pageEvents,
      after,
      events.length > pageEvents.length
    );
    if (!page) {
      await reject('dm_page_too_large');
      return;
    }
    const filePath = this.writeTempEventBlob(payload.transferId, page.blob);
    const registered = await this.bridge.sendReticulumChatResourceDetailed({
      allowedRecipientAddress: requesterPeerHash,
      transferId: payload.transferId,
      filePath,
      fileName: `${payload.transferId}.dm-page.json`,
      size: page.sizeBytes,
      sha256: page.pageHash,
      metadata: {
        resourceType: 'reticulum_chat_event',
        logicalResourceType: 'reticulum_chat_dm_page',
        conversationId,
        pageHash: page.pageHash,
        eventCount: page.eventCount,
        size: page.sizeBytes,
        variableSize: true,
      },
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    if (!registered.ok) {
      this.safeUnlink(filePath);
      await reject('dm_page_register_failed');
      return;
    }
    for (const event of page.pageEvents) {
      if (
        ownAddressMatches(this.localDmAddresses, event.senderAddress) &&
        event.recipientAddress === requesterAddress
      ) {
        this.markDirectEventSent(event);
      }
    }
    loggerLog(
      `[ReticulumChat] dm_page_link_authorized conversation=${conversationId.slice(0, 16)} requester=${requesterAddress} transfer=${payload.transferId} events=${page.eventCount} more=${page.hasMore === true}`
    );
    await this.bridge.authorizeReticulumChatResourceDetailed?.({
      linkId: payload.linkId,
      transferId: payload.transferId,
    });
  }

  private async authorizeLinkedHistoryPageResource(
    payload: ReticulumChatResourcePayload,
    auth: Record<string, unknown>
  ): Promise<void> {
    if (!this.bridge || !payload.linkId || !payload.transferId) return;
    const groupId = Number(auth.groupId || payload.groupId || 0);
    const requestedPriority = feedPriorityFromWire(auth.p);
    const request: ReticulumChatHistoryPageRequestWire = {
      c:
        auth.c === RETICULUM_CHAT_ALL_CHANNELS_ID
          ? RETICULUM_CHAT_ALL_CHANNELS_ID
          : normalizeReticulumChatChannelId(auth.c),
      d: auth.d === 'after' ? 'after' : 'before',
      ...(isFeedCursorWire(auth.after) ? { after: auth.after } : {}),
      ...(isFeedCursorWire(auth.before) ? { before: auth.before } : {}),
      ...(auth.inc === 1 ? { inc: 1 as const } : {}),
      ...(requestedPriority ? { p: feedPriorityToWire(requestedPriority) } : {}),
      limit: this.normalizeFeedLimit(auth.limit),
      a: String(auth.a || ''),
      pk: String(auth.pk || ''),
      ts: Number(auth.ts || 0),
      sig: String(auth.sig || ''),
    };
    const reject = async (reason: string) => {
      await this.bridge?.rejectReticulumChatResourceDetailed?.({
        linkId: payload.linkId || '',
        transferId: payload.transferId || '',
        reason,
      });
    };
    if (!Number.isInteger(groupId) || groupId <= 0) {
      await reject('bad_history_page_auth');
      return;
    }
    if (auth.p != null && !requestedPriority) {
      await reject('invalid_history_priority');
      return;
    }
    if (!this.hasLocalGroupHistory(groupId)) {
      await reject('history_unavailable');
      return;
    }
    if (!verifyReticulumChatHistoryPageRequest(groupId, request, this.now())) {
      await reject('bad_history_page_auth');
      return;
    }
    const requesterIsMember = await this.isValidatedRequesterGroupMember(
      groupId,
      request.a,
      'history_page'
    );
    if (requesterIsMember !== true) {
      const reason =
        requesterIsMember === null ? 'requester_membership_unavailable' : 'requester_not_group_member';
      loggerWarn(
        `[ReticulumChat] Refusing history page group=${groupId}: reason=${reason}`
      );
      await reject(reason);
      return;
    }
    loggerLog(
      `[ReticulumChat] cached_history_serve_allowed group=${groupId} requester=${request.a} transfer=${payload.transferId}`
    );
    const channelId =
      request.c === RETICULUM_CHAT_ALL_CHANNELS_ID
        ? RETICULUM_CHAT_ALL_CHANNELS_ID
        : normalizeReticulumChatChannelId(request.c);
    if (
      channelId !== RETICULUM_CHAT_ALL_CHANNELS_ID &&
      !(await this.canRequesterReadChannel(groupId, channelId, request.a))
    ) {
      loggerWarn(
        `[ReticulumChat] Refusing history page group=${groupId} channel=${channelId}: requester cannot read channel`
      );
      await reject('channel_read_forbidden');
      return;
    }
    const before = this.cursorFromWire(request.before);
    const after = before ? null : this.cursorFromWire(request.after);
    const includeBeforeCursor = before != null && request.inc === 1;
    const limit = this.normalizeFeedLimit(request.limit);
    const priority = feedPriorityFromWire(request.p);
    if (request.p != null && !priority) {
      await reject('invalid_history_priority');
      return;
    }
    const events = this.getFeedPageEvents(
      groupId,
      channelId,
      before,
      after,
      includeBeforeCursor,
      limit + 1,
      priority
    );
    const hasMore = events.length > limit;
    const direction = before ? 'before' as const : 'after' as const;
    const visibleEvents = before && hasMore
      ? events.slice(events.length - limit)
      : events.slice(0, limit);
    const readableEvents = await this.filterEventsForRequesterReadAccess(
      groupId,
      visibleEvents,
      request.a
    );
    if (readableEvents.length === 0) {
      await reject('no_history_events');
      return;
    }
    const pageResource = this.buildEventPageResourceBlob(
      groupId,
      channelId,
      readableEvents,
      hasMore,
      direction,
      priority
    );
    if (!pageResource) {
      await reject('history_page_too_large');
      return;
    }
    const filePath = this.writeTempEventBlob(payload.transferId, pageResource.blob);
    const requesterPeerHash = String(
      auth.requesterPeerHash || payload.peerPresenceHash || ''
    ).trim().toLowerCase();
    if (!requesterPeerHash) {
      this.safeUnlink(filePath);
      await reject('missing_requester_peer');
      return;
    }
    const registered = await this.bridge.sendReticulumChatResourceDetailed({
      allowedRecipientAddress: requesterPeerHash,
      transferId: payload.transferId,
      filePath,
      fileName: `${groupId}-${payload.transferId}.history-page.json`,
      size: pageResource.sizeBytes,
      sha256: pageResource.pageHash,
      metadata: {
        resourceType: 'reticulum_chat_event',
        logicalResourceType: 'reticulum_chat_history_page',
        groupId,
        channelId,
        ...(feedPriorityToWire(priority) ? { p: feedPriorityToWire(priority) } : {}),
        pageHash: pageResource.pageHash,
        eventCount: pageResource.eventCount,
        size: pageResource.sizeBytes,
        variableSize: true,
      },
      expiresAt: this.now() + RETICULUM_CHAT_RESOURCE_TTL_MS,
    });
    if (!registered.ok) {
      this.safeUnlink(filePath);
      await reject('history_page_register_failed');
      return;
    }
    if (readableEvents.length) this.db.markServed(readableEvents.map((event) => event.eventId));
    loggerLog(
      `[ReticulumChat] history_page_link_authorized group=${groupId} channel=${channelId} peer=${requesterPeerHash.slice(0, 16)} transfer=${payload.transferId} events=${pageResource.eventCount} more=${hasMore}`
    );
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

  private safeUnlink(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup for temporary event page files.
    }
  }

  private applyTyping(
    groupId: number,
    channelId: string,
    authorAddress: string,
    active: boolean
  ): void {
    const normalizedChannelId = normalizeReticulumChatChannelId(channelId);
    const key = `${groupId}:${normalizedChannelId}:${authorAddress}`;
    const existing = this.typingTimers.get(key);
    if (existing) clearTimeout(existing);
    if (!active) {
      this.typingTimers.delete(key);
      this.emit('typing', {
        groupId,
        channelId: normalizedChannelId,
        authorAddress,
        active: false,
      });
      return;
    }
    this.emit('typing', {
      groupId,
      channelId: normalizedChannelId,
      authorAddress,
      active: true,
    });
    const timer = setTimeout(() => {
      this.typingTimers.delete(key);
      this.emit('typing', {
        groupId,
        channelId: normalizedChannelId,
        authorAddress,
        active: false,
      });
    }, RETICULUM_CHAT_TYPING_TTL_MS);
    timer.unref?.();
    this.typingTimers.set(key, timer);
  }

  private startSubscriptionRefreshTimer(): void {
    if (this.subscriptionRefreshTimer || this.subscribedGroups.size === 0) return;
    this.scheduleSubscriptionRefresh();
  }

  private stopSubscriptionRefreshTimer(): void {
    if (!this.subscriptionRefreshTimer) return;
    clearTimeout(this.subscriptionRefreshTimer);
    this.subscriptionRefreshTimer = null;
  }

  private stopSubscriptionFanoutTimer(): void {
    if (!this.subscriptionFanoutTimer) return;
    clearTimeout(this.subscriptionFanoutTimer);
    this.subscriptionFanoutTimer = null;
  }

  private clearSubscriptionFanoutQueue(): void {
    this.subscriptionFanoutQueue = [];
    this.subscriptionFanoutQueuedKeys.clear();
    this.subscriptionFanoutSentInBatch = 0;
    this.stopSubscriptionFanoutTimer();
  }

  private enqueueSubscriptionFanouts(wires: ReticulumChatWire[]): void {
    const now = this.now();
    for (const wire of wires) {
      const key = this.subscriptionFanoutKey(wire);
      if (!key) continue;
      if (wire.k === 'group_digest' && this.subscriptionFanoutQueuedKeys.has(key)) {
        this.replaceQueuedSubscriptionFanout(key, wire);
        continue;
      }
      if (this.subscriptionFanoutQueuedKeys.has(key)) {
        continue;
      }
      const lastSentAt = this.subscriptionFanoutLastSentAt.get(key) ?? 0;
      if (now - lastSentAt < RETICULUM_CHAT_SUBSCRIPTION_FANOUT_DEDUPE_MS) continue;
      this.subscriptionFanoutQueuedKeys.add(key);
      this.subscriptionFanoutQueue.push(wire);
    }
    this.drainSubscriptionFanoutQueue();
  }

  private replaceQueuedSubscriptionFanout(key: string, wire: ReticulumChatWire): void {
    const index = this.subscriptionFanoutQueue.findIndex((queued) => this.subscriptionFanoutKey(queued) === key);
    if (index >= 0) this.subscriptionFanoutQueue[index] = wire;
  }

  private removeQueuedSubscriptionFanouts(groupId: number): void {
    this.subscriptionFanoutQueue = this.subscriptionFanoutQueue.filter((wire) => {
      const remove = this.getWireGroupIds(wire).includes(groupId);
      if (remove) {
        const key = this.subscriptionFanoutKey(wire);
        if (key) this.subscriptionFanoutQueuedKeys.delete(key);
      }
      return !remove;
    });
  }

  private scheduleSubscriptionFanoutDrain(): void {
    if (this.subscriptionFanoutTimer) return;
    this.subscriptionFanoutTimer = setTimeout(() => {
      this.subscriptionFanoutTimer = null;
      this.subscriptionFanoutSentInBatch = 0;
      this.drainSubscriptionFanoutQueue();
    }, RETICULUM_CHAT_SUBSCRIPTION_FANOUT_BATCH_INTERVAL_MS);
    this.subscriptionFanoutTimer.unref?.();
  }

  private drainSubscriptionFanoutQueue(): void {
    while (
      this.subscriptionFanoutQueue.length > 0 &&
      this.subscriptionFanoutSentInBatch < RETICULUM_CHAT_SUBSCRIPTION_FANOUT_BATCH_SIZE
    ) {
      const wire = this.subscriptionFanoutQueue.shift();
      if (!wire) break;
      const key = this.subscriptionFanoutKey(wire);
      if (key) this.subscriptionFanoutQueuedKeys.delete(key);
      const groups = this.getWireGroupIds(wire);
      if (
        groups.length > 0 &&
        !groups.some((groupId) => this.subscribedGroups.has(groupId) && this.localGroupIds.has(groupId))
      ) {
        continue;
      }
      this.subscriptionFanoutSentInBatch += 1;
      if (key) this.subscriptionFanoutLastSentAt.set(key, this.now());
      void this.fanout(wire);
    }
    if (this.subscriptionFanoutQueue.length > 0 || this.subscriptionFanoutSentInBatch > 0) {
      this.scheduleSubscriptionFanoutDrain();
    }
  }

  private scheduleSubscriptionRefresh(): void {
    if (this.subscriptionRefreshTimer || this.subscribedGroups.size === 0) return;
    const jitter = Math.floor(Math.random() * RETICULUM_CHAT_SUBSCRIPTION_REFRESH_JITTER_MS);
    this.subscriptionRefreshTimer = setTimeout(() => {
      this.subscriptionRefreshTimer = null;
      this.refreshSubscriptions();
      this.scheduleSubscriptionRefresh();
    }, RETICULUM_CHAT_SUBSCRIPTION_REFRESH_MS + jitter);
    this.subscriptionRefreshTimer.unref?.();
  }

  private refreshSubscriptions(): void {
    this.prunePeerSubscriptions();
    const groups = this.getSubscriptions();
    const wires: ReticulumChatWire[] = [];
    for (let offset = 0; offset < groups.length; offset += RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE) {
      const page = groups.slice(offset, offset + RETICULUM_CHAT_MAX_GROUPS_PER_SUB_PAGE);
      if (page.length) wires.push({ t: 'RCHAT', k: 'group_sub', groups: page, mode: 'summary' });
    }
    for (const groupId of this.getDigestRefreshGroups(groups)) {
      wires.push(this.buildGroupDigestWire(groupId));
    }
    this.enqueueSubscriptionFanouts(wires);
  }

  private getDigestRefreshGroups(groups: number[]): number[] {
    const now = this.now();
    for (const [groupId, observedAt] of this.activeDigestGroups) {
      if (
        now - observedAt > RETICULUM_CHAT_ACTIVE_GROUP_DIGEST_TTL_MS ||
        !this.subscribedGroups.has(groupId) ||
        !this.localGroupIds.has(groupId)
      ) {
        this.activeDigestGroups.delete(groupId);
      }
    }

    const groupSet = new Set(groups);
    const activeGroups = [...this.activeDigestGroups.entries()]
      .filter(([groupId]) => groupSet.has(groupId))
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([groupId]) => groupId)
      .slice(0, RETICULUM_CHAT_MAX_DIGEST_GROUPS_PER_PAGE);

    const slots = RETICULUM_CHAT_MAX_DIGEST_GROUPS_PER_PAGE - activeGroups.length;
    if (slots <= 0) return activeGroups;

    const activeSet = new Set(activeGroups);
    const backgroundGroups = groups.filter((groupId) => !activeSet.has(groupId));
    if (backgroundGroups.length === 0) {
      this.subscriptionDigestRefreshOffset = 0;
      return activeGroups;
    }

    const start = this.subscriptionDigestRefreshOffset % backgroundGroups.length;
    const count = Math.min(slots, backgroundGroups.length);
    const rotated: number[] = [];
    for (let index = 0; index < count; index += 1) {
      rotated.push(backgroundGroups[(start + index) % backgroundGroups.length]);
    }
    this.subscriptionDigestRefreshOffset = (start + Math.max(1, count)) % backgroundGroups.length;
    return [...activeGroups, ...rotated];
  }

  private getWireGroupIds(wire: ReticulumChatWire): number[] {
    if ('g' in wire && Number.isInteger(wire.g) && wire.g > 0) return [wire.g];
    if (wire.k === 'group_sub') return wire.groups.filter((groupId) => Number.isInteger(groupId) && groupId > 0);
    return [];
  }

  private subscriptionFanoutKey(wire: ReticulumChatWire): string {
    if (wire.k === 'hello') return 'hello';
    if (wire.k === 'group_sub') {
      const groups = wire.groups
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
        .sort((a, b) => a - b);
      return `group_sub:${wire.mode}:${groups.join(',')}`;
    }
    if (wire.k === 'group_digest') return `group_digest:${wire.g}`;
    return this.hashControlPayload(wire);
  }

  private shouldRequestGroupRepair(
    peerHash: string,
    groupId: number,
    scope = 'group'
  ): boolean {
    const key = `${peerHash.trim().toLowerCase()}:${groupId}:${scope}`;
    const now = this.now();
    const lastRequestedAt = this.recentGroupRepairRequests.get(key) ?? 0;
    if (now - lastRequestedAt < RETICULUM_CHAT_GROUP_REPAIR_DEBOUNCE_MS) return false;
    this.recentGroupRepairRequests.set(key, now);
    return true;
  }

  private shouldRequestMetadataRepair(peerHash: string, groupId: number): boolean {
    const key = `${peerHash.trim().toLowerCase()}:${groupId}`;
    const now = this.now();
    const lastRequestedAt = this.recentMetadataRepairRequests.get(key) ?? 0;
    if (now - lastRequestedAt < RETICULUM_CHAT_GROUP_REPAIR_DEBOUNCE_MS) return false;
    this.recentMetadataRepairRequests.set(key, now);
    return true;
  }

  private shouldPushMetadataHistoryPage(peerHash: string, groupId: number): boolean {
    const key = `${peerHash.trim().toLowerCase()}:${groupId}`;
    const now = this.now();
    const lastPushedAt = this.recentMetadataPagePushes.get(key) ?? 0;
    if (now - lastPushedAt < RETICULUM_CHAT_NEWEST_PAGE_PUSH_DEBOUNCE_MS) return false;
    this.recentMetadataPagePushes.set(key, now);
    return true;
  }

  private shouldPushNewestHistoryPage(peerHash: string, groupId: number): boolean {
    const key = `${peerHash.trim().toLowerCase()}:${groupId}`;
    const now = this.now();
    const lastPushedAt = this.recentNewestPagePushes.get(key) ?? 0;
    if (now - lastPushedAt < RETICULUM_CHAT_NEWEST_PAGE_PUSH_DEBOUNCE_MS) return false;
    this.recentNewestPagePushes.set(key, now);
    return true;
  }

  private notePeerSubscription(peerHash: string, groupId: number, active: boolean): void {
    const key = peerHash.trim().toLowerCase();
    if (!key) return;
    this.prunePeerSubscriptions();
    const groups = this.peerSubscriptions.get(key) ?? new Map<number, number>();
    if (active) groups.set(groupId, this.now() + RETICULUM_CHAT_PEER_SUBSCRIPTION_TTL_MS);
    else groups.delete(groupId);
    if (groups.size) this.peerSubscriptions.set(key, groups);
    else this.peerSubscriptions.delete(key);
  }

  private prunePeerSubscriptions(now = this.now()): void {
    for (const [peerHash, groups] of this.peerSubscriptions) {
      for (const [groupId, expiresAt] of groups) {
        if (expiresAt <= now) groups.delete(groupId);
      }
      if (groups.size === 0) this.peerSubscriptions.delete(peerHash);
    }
  }

  private getInterestedPeers(
    groupId: number,
    excludePeerPresenceHashes: string[] = []
  ): string[] {
    this.prunePeerSubscriptions();
    const excluded = new Set(
      excludePeerPresenceHashes.map((hash) => hash.trim().toLowerCase()).filter(Boolean)
    );
    const peers: string[] = [];
    for (const [peerHash, groups] of this.peerSubscriptions) {
      if (groups.has(groupId) && !excluded.has(peerHash)) peers.push(peerHash);
    }
    return peers;
  }

  private async fanout(
    wire: ReticulumChatWire,
    excludePeerPresenceHashes: string[] = []
  ): Promise<ReticulumSendResult> {
    const result = await this.fanoutOnce(wire, excludePeerPresenceHashes);
    if (result.ok === false && this.shouldRetryControlSend(wire, result.reason)) {
      this.enqueueControlRetry({ wire, excludePeerPresenceHashes });
    }
    return result;
  }

  private async fanoutOnce(
    wire: ReticulumChatWire,
    excludePeerPresenceHashes: string[] = []
  ): Promise<ReticulumSendResult> {
    return this.fanoutManyOnce([wire], excludePeerPresenceHashes);
  }

  private async fanoutManyOnce(
    wires: ReticulumChatWire[],
    excludePeerPresenceHashes: string[] = []
  ): Promise<ReticulumSendResult> {
    if (!this.bridge) return { ok: false, reason: 'bridge-unavailable' };
    for (const wire of wires) {
      if (!wireFitsReticulum(wire)) {
        return {
          ok: false,
          reason: 'wire-too-large',
          error: `Reticulum chat wire ${byteLengthUtf8JsonWithBridgeSender(wire)} bytes exceeds ${RT_RETICULUM_MAX_WIRE_JSON_BYTES}`,
        };
      }
    }
    if (typeof this.bridge.fanoutReticulumChatDetailed !== 'function') {
      return { ok: false, reason: 'send-command-failed', error: 'Bridge chat fanout unavailable' };
    }
    return this.bridge.fanoutReticulumChatDetailed(wires, excludePeerPresenceHashes);
  }

  private async sendToPeer(peerHash: string, wire: ReticulumChatWire): Promise<ReticulumSendResult> {
    const result = await this.sendToPeerOnce(peerHash, wire);
    if (result.ok === false && this.shouldRetryControlSend(wire, result.reason)) {
      this.enqueueControlRetry({ peerHash: peerHash.trim().toLowerCase(), wire });
    }
    return result;
  }

  private async sendToPeerOnce(peerHash: string, wire: ReticulumChatWire): Promise<ReticulumSendResult> {
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

  private shouldRetryControlSend(
    wire: ReticulumChatWire,
    reason: ReticulumSendFailureReason
  ): boolean {
    if (!this.isRetryableControlWire(wire)) return false;
    return (
      reason === 'no-route' ||
      reason === 'packet-send-false' ||
      reason === 'bridge-not-ready' ||
      reason === 'bridge-timeout' ||
      reason === 'bridge-exception' ||
      reason === 'bridge-overloaded' ||
      reason === 'bridge-not-started'
    );
  }

  private isRetryableControlWire(wire: ReticulumChatWire): boolean {
    switch (wire.k) {
      case 'feed_req':
      case 'digest_req':
      case 'range_req':
      case 'event_req':
      case 'relay_query':
      case 'relay_digest':
      case 'gkd':
      case 'gkq':
      case 'gks':
      case 'event_offer':
      case 'event_page_offer':
      case 'event_batch':
      case 'rf':
      case 'resource_have':
      case 'dm_notify':
      case 'dm_probe':
      case 'dm_req':
      case 'dm_resource_find':
      case 'dm_resource_have':
        return true;
      default:
        return false;
    }
  }

  private controlRetryKey(item: {
    wire: ReticulumChatWire;
    peerHash?: string;
    excludePeerPresenceHashes?: string[];
  }): string {
    const target = item.peerHash
      ? `peer:${item.peerHash.trim().toLowerCase()}`
      : `fanout:${[...(item.excludePeerPresenceHashes ?? [])].map((hash) => hash.trim().toLowerCase()).sort().join(',')}`;
    return `${target}:${this.hashControlPayload(item.wire)}`;
  }

  private enqueueControlRetry(item: {
    wire: ReticulumChatWire;
    peerHash?: string;
    excludePeerPresenceHashes?: string[];
  }): void {
    const key = this.controlRetryKey(item);
    const now = this.now();
    const existing = this.controlRetryQueue.get(key);
    if (existing) {
      existing.wire = item.wire;
      existing.peerHash = item.peerHash?.trim().toLowerCase();
      existing.excludePeerPresenceHashes = item.excludePeerPresenceHashes;
      existing.nextAttemptAt = Math.min(existing.nextAttemptAt, now + RETICULUM_CHAT_CONTROL_RETRY_MS);
      this.scheduleControlRetryQueue(RETICULUM_CHAT_CONTROL_RETRY_TICK_MS);
      return;
    }
    if (this.controlRetryQueue.size >= RETICULUM_CHAT_CONTROL_RETRY_MAX) {
      const oldestKey = this.controlRetryQueue.keys().next().value as string | undefined;
      if (oldestKey) this.controlRetryQueue.delete(oldestKey);
    }
    this.controlRetryQueue.set(key, {
      key,
      wire: item.wire,
      peerHash: item.peerHash?.trim().toLowerCase(),
      excludePeerPresenceHashes: item.excludePeerPresenceHashes,
      attempts: 0,
      nextAttemptAt: now + RETICULUM_CHAT_CONTROL_RETRY_MS,
    });
    this.scheduleControlRetryQueue(RETICULUM_CHAT_CONTROL_RETRY_TICK_MS);
  }

  private scheduleControlRetryQueue(delayMs: number): void {
    if (this.controlRetryTimer) return;
    this.controlRetryTimer = setTimeout(() => {
      this.controlRetryTimer = null;
      void this.drainControlRetryQueue();
    }, Math.max(0, delayMs));
    this.controlRetryTimer.unref?.();
  }

  private async drainControlRetryQueue(): Promise<void> {
    if (this.controlRetryActive) return;
    this.controlRetryActive = true;
    try {
      const now = this.now();
      for (const item of [...this.controlRetryQueue.values()]) {
        if (item.nextAttemptAt > now) continue;
        item.attempts += 1;
        const result = item.peerHash
          ? await this.sendToPeerOnce(item.peerHash, item.wire)
          : await this.fanoutOnce(item.wire, item.excludePeerPresenceHashes ?? []);
        if (result.ok) {
          this.controlRetryQueue.delete(item.key);
          continue;
        }
        if (result.ok === false && (
          item.attempts >= RETICULUM_CHAT_CONTROL_RETRY_MAX_ATTEMPTS ||
          !this.shouldRetryControlSend(item.wire, result.reason)
        )) {
          this.controlRetryQueue.delete(item.key);
          loggerWarn(
            `[ReticulumChat] Control retry dropped kind=${item.wire.k} attempts=${item.attempts}:`,
            result.error ?? result.reason
          );
          continue;
        }
        item.nextAttemptAt = this.now() + RETICULUM_CHAT_CONTROL_RETRY_MS;
      }
    } finally {
      this.controlRetryActive = false;
      if (this.controlRetryQueue.size > 0) {
        this.scheduleControlRetryQueue(RETICULUM_CHAT_CONTROL_RETRY_TICK_MS);
      }
    }
  }

  private attachBridge(bridge: ReticulumBridge | null): void {
    if (!bridge) return;
    bridge.on('reticulum-chat-message', this.onBridgeChatMessage);
    bridge.on('reticulum-chat-resource', this.onBridgeChatResource);
    bridge.on('reticulum-resource', this.onBridgeGenericResource);
  }

  private detachBridge(): void {
    if (!this.bridge) return;
    this.bridge.off('reticulum-chat-message', this.onBridgeChatMessage);
    this.bridge.off('reticulum-chat-resource', this.onBridgeChatResource);
    this.bridge.off('reticulum-resource', this.onBridgeGenericResource);
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

  private onBridgeGenericResource = (payload: ReticulumChatResourcePayload): void => {
    try {
      this.handleGenericResourceEvent(payload);
    } catch (err) {
      loggerWarn('[ReticulumChat] Failed to handle generic resource event:', err);
    }
  };

  private assertGroupId(groupId: number): void {
    if (!Number.isInteger(groupId) || groupId <= 0) {
      throw new Error('Invalid groupId');
    }
  }

  private assertLocalGroupMember(groupId: number): void {
    this.assertGroupId(groupId);
    if (!this.localGroupIds.has(groupId)) {
      throw new Error('Local user is not a member of this group');
    }
  }
}

let singleton: ReticulumChatManager | null = null;

export function readReticulumChatHistoryFromDb(
  groupId: number,
  channelId = RETICULUM_CHAT_DEFAULT_CHANNEL_ID,
  limit = 100
): ReticulumChatEvent[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    return db.getRecentEvents(groupId, Math.max(1, Math.min(500, limit)), channelId);
  } finally {
    db.close();
  }
}

export function readReticulumChatMessageHistoryFromDb(
  groupId: number,
  channelId = RETICULUM_CHAT_DEFAULT_CHANNEL_ID,
  limit = 100
): ReticulumChatEvent[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    return db.getRecentMessageEvents(groupId, Math.max(1, Math.min(500, limit)), channelId);
  } finally {
    db.close();
  }
}

export function readReticulumChatChannelMetadataHistoryFromDb(
  groupId: number,
  limit = 200
): ReticulumChatEvent[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    return db.getChannelMetadataEvents(groupId, Math.max(1, Math.min(500, limit)));
  } finally {
    db.close();
  }
}

export function readReticulumChatSummariesFromDb(
  myAddress = '',
  onlineSince = 0
): ReticulumGroupChatSummary[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.getChatSummaries(myAddress, onlineSince);
  } finally {
    db.close();
  }
}

export function readReticulumChatSyncStateFromDb(
  groupId: number
): Record<string, number> {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return {};
    return db.getSyncState(groupId);
  } finally {
    db.close();
  }
}

export function markReticulumChatReadInDb(
  groupId: number,
  channelId: string,
  upToTimestamp: number,
  myAddress = ''
): void {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return;
    db.markRead(groupId, channelId, upToTimestamp, myAddress);
  } finally {
    db.close();
  }
}

export function searchReticulumChatFromDb(
  query: string,
  options: { groupIds?: number[]; channelIds?: string[]; limit?: number } = {}
): ReticulumChatSearchResult[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.searchEvents(query, options);
  } finally {
    db.close();
  }
}

export function readReticulumChatChannelsFromDb(
  groupId: number,
  includeArchived = false
): ReticulumGroupChannel[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    return db.getChannels(groupId, includeArchived);
  } finally {
    db.close();
  }
}

export function readReticulumChatCategoriesFromDb(
  groupId: number
): ReticulumGroupCategory[] {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    if (!Number.isInteger(groupId) || groupId <= 0) return [];
    return db.getCategories(groupId);
  } finally {
    db.close();
  }
}

export function applyReticulumChatChannelMetadataInDb(
  eventId: string,
  payload: unknown
): Promise<boolean> {
  const manager = new ReticulumChatManager({
    dbPath: defaultReticulumChatDbPath(),
  });
  return manager.applyChannelMetadataEvent(eventId, payload).finally(() => {
    manager.close();
  });
}

export function startReticulumChatManager(
  bridge?: ReticulumBridge | null,
  dbPath?: string,
  options: Pick<
    ReticulumChatManagerOptions,
    | 'signLocalFields'
    | 'validateGroupMember'
    | 'validateGroupAdmin'
    | 'getVerifiedReticulumPeers'
    | 'hasGoodOverlayHealth'
    | 'resourceStore'
  > = {}
): ReticulumChatManager {
  if (singleton) {
    singleton.setBridge(bridge ?? null);
    singleton.setRuntimeCallbacks(options);
    return singleton;
  }
  singleton = new ReticulumChatManager({
    bridge: bridge ?? null,
    dbPath,
    signLocalFields: options.signLocalFields,
    validateGroupMember: options.validateGroupMember,
    validateGroupAdmin: options.validateGroupAdmin,
    getVerifiedReticulumPeers: options.getVerifiedReticulumPeers,
    hasGoodOverlayHealth: options.hasGoodOverlayHealth,
    resourceStore: options.resourceStore,
  });
  loggerLog('[ReticulumChat] Manager started');
  return singleton;
}
export function indexReticulumChatSearchTextInDb(
  eventId: string,
  text: string
): boolean {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.indexSearchText(eventId, text);
  } finally {
    db.close();
  }
}

export function deleteReticulumChatSearchTextInDb(eventId: string): boolean {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.deleteSearchText(eventId);
  } finally {
    db.close();
  }
}

export function replaceReticulumChatMentionsInDb(
  eventId: string,
  mentionedAddresses: string[]
): boolean {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.replaceMentionsForEvent(eventId, mentionedAddresses);
  } finally {
    db.close();
  }
}

export function deleteReticulumChatMentionsInDb(eventId: string): boolean {
  const db = new ReticulumChatDatabase(defaultReticulumChatDbPath());
  try {
    return db.deleteMentionsForEvent(eventId);
  } finally {
    db.close();
  }
}

export function getReticulumChatManager(): ReticulumChatManager | null {
  return singleton;
}

export function stopReticulumChatManager(): void {
  singleton?.close();
  singleton = null;
}
