import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import CallRoundedIcon from '@mui/icons-material/CallRounded';
import CallEndRoundedIcon from '@mui/icons-material/CallEndRounded';
import PaidRoundedIcon from '@mui/icons-material/PaidRounded';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import {
  Box,
  Button,
  ClickAwayListener,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from '@mui/material';
import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { balanceAtom, userInfoAtom } from '../../atoms/global';
import defaultCharacterSpritesheetUrl from '../../assets/qortalland/default-character-spritesheet.png';
import { useVoiceCall, type VoiceCallApi } from '../../hooks/useVoiceCall';
import { getPrimaryNamesForAddresses } from '../Group/groupApi';

type LandPlayerState = {
  authorAddress: string;
  sessionId: string;
  sequence: number;
  roomId: LandRoomId;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  displayX: number;
  displayY: number;
  direction: string;
  movement: string;
  sentAt: number;
  receivedAt: number;
  lastSeenAt: number;
  interpolationMs: number;
  velocityX: number;
  velocityY: number;
};

type LocalLandState = {
  roomId: LandRoomId;
  x: number;
  y: number;
  direction: string;
  movement: string;
};

type LandChatBubble = {
  messageId: string;
  authorAddress: string;
  sessionId: string;
  sequence: number;
  text: string;
  createdAt: number;
  expiresAt: number;
};

type LandActionTarget = {
  key: string;
  authorAddress: string;
  sessionId: string;
  roomId: LandRoomId;
  menuX: number;
  menuY: number;
};

type LandActionAnimation = {
  actionId: string;
  type: 'qort_received';
  fromAddress: string;
  toAddress: string;
  targetSessionId: string;
  amount: number;
  roomId: LandRoomId;
  createdAt: number;
  expiresAt: number;
};

type LandCallPresence = {
  callId: string;
  peerAddress: string;
  roomId: LandRoomId;
  expiresAt: number;
};

type QortalLandProps = {
  groupId: number;
  groupName: string;
  myAddress: string;
};

const LAND_WIDTH = 1800;
const LAND_HEIGHT = 820;
const FLOOR_TOP_Y = 300;
const FLOOR_BOTTOM_Y = 690;
const LAND_SEND_INTERVAL_MS = 200;
const LAND_HEARTBEAT_MS = 2000;
const LAND_REMOTE_TTL_MS = 30000;
const LAND_REMOTE_MIN_INTERPOLATION_MS = 220;
const LAND_REMOTE_MAX_INTERPOLATION_MS = 950;
const LAND_REMOTE_EXTRAPOLATE_MS = 1100;
const LAND_REMOTE_STOP_WALKING_AFTER_MS = 1450;
const LAND_REMOTE_MAX_VELOCITY_PX_PER_MS = 0.32;
const LAND_REMOTE_MAX_EXTRAPOLATE_DISTANCE = 180;
const LAND_CHAT_BUBBLE_TTL_MS = 15000;
const LAND_CHAT_MAX_TEXT_BYTES = 1024;
const LAND_CHAT_MAX_INPUT_CHARS = 420;
const LAND_ACTION_ANIMATION_TTL_MS = 3200;
const LAND_CALL_STATUS_INTERVAL_MS = 10000;
const LAND_CALL_STATUS_TTL_MS = 26000;
const QORTAL_LAND_CHANNEL_ID = 'qortal-land';
const LAND_CHARACTER_SPRITESHEET_KEY = 'qortalland-default-character';
const LAND_CHARACTER_IDLE_SIDE_ANIM_KEY = 'qortalland-default-character-idle-side';
const LAND_CHARACTER_WALK_SIDE_ANIM_KEY = 'qortalland-default-character-walk-side';
const LAND_CHARACTER_IDLE_DOWN_ANIM_KEY = 'qortalland-default-character-idle-down';
const LAND_CHARACTER_WALK_DOWN_ANIM_KEY = 'qortalland-default-character-walk-down';
const LAND_CHARACTER_IDLE_UP_ANIM_KEY = 'qortalland-default-character-idle-up';
const LAND_CHARACTER_WALK_UP_ANIM_KEY = 'qortalland-default-character-walk-up';
const LAND_CHARACTER_FRAME_SIZE = 320;
const LAND_CHARACTER_FRAMES_PER_DIRECTION = 7;
const LAND_CHARACTER_FEET_BASELINE = 292;
const LAND_CHARACTER_RENDER_SCALE = 0.56;
const LAND_CHARACTER_LABEL_OFFSET = 248;
const LAND_CHARACTER_CHAT_BUBBLE_OFFSET = 292;
type LandRoomId = 'club' | 'skywalk' | 'mall' | 'park';
const QORTAL_LAND_DEFAULT_ROOM_ID: LandRoomId = 'club';
const QORTAL_LAND_SKYWALK_ROOM_ID: LandRoomId = 'skywalk';
const QORTAL_LAND_MALL_ROOM_ID: LandRoomId = 'mall';
const QORTAL_LAND_PARK_ROOM_ID: LandRoomId = 'park';

type ReticulumChatEventForLand = {
  eventId?: unknown;
  groupId?: unknown;
  channelId?: unknown;
  authorAddress?: unknown;
  authorPublicKey?: unknown;
  authorSeq?: unknown;
  timestamp?: unknown;
  eventType?: unknown;
  encryptedPayload?: unknown;
  payloadHash?: unknown;
  mentionAddressHashes?: unknown;
  signature?: unknown;
};

const createSessionId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID().replace(/-/g, '').slice(0, 24);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`.slice(0, 24);
};

const createLandChatMessageId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
};

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || target.isContentEditable;
};

const addressHue = (address: string): number => {
  let hash = 0;
  for (let index = 0; index < address.length; index += 1) {
    hash = (hash * 31 + address.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
};

const shortAddress = (address: string): string => {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
};

const displayNameForAddress = (
  address: string,
  primaryNameCache: Map<string, string>
): string => {
  const primaryName = primaryNameCache.get(address)?.trim();
  return primaryName || shortAddress(address);
};

const buildDirectVoiceCallChatId = (addressA: string, addressB: string): string => {
  return `direct:${[addressA, addressB].sort().join(':')}`;
};

const clampNumber = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const finiteNumber = (value: unknown): number | null => {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
};

const normalizeQortBalance = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return normalizeQortBalance(record.balance ?? record.confirmed ?? record.qort ?? record.QORT);
  }
  return 0;
};

const formatQortAmount = (value: number): string => {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 8,
    minimumFractionDigits: 0,
  }).format(value);
};

const estimateRemoteInterpolationMs = (distance: number, stateGapMs: number): number => {
  const distanceWindow = distance * 3.2;
  const gapWindow = stateGapMs > LAND_SEND_INTERVAL_MS * 2 ? stateGapMs * 0.42 : 0;
  return clampNumber(
    Math.max(LAND_REMOTE_MIN_INTERPOLATION_MS, distanceWindow, gapWindow),
    LAND_REMOTE_MIN_INTERPOLATION_MS,
    LAND_REMOTE_MAX_INTERPOLATION_MS
  );
};

const clampRemoteVelocity = (velocity: number): number => {
  return clampNumber(velocity, -LAND_REMOTE_MAX_VELOCITY_PX_PER_MS, LAND_REMOTE_MAX_VELOCITY_PX_PER_MS);
};

const normalizeLandRoomId = (value: unknown): LandRoomId => {
  return value === QORTAL_LAND_SKYWALK_ROOM_ID ||
    value === QORTAL_LAND_MALL_ROOM_ID ||
    value === QORTAL_LAND_PARK_ROOM_ID
    ? value
    : QORTAL_LAND_DEFAULT_ROOM_ID;
};

const initialPositionForAddress = (address: string): { roomId: LandRoomId; x: number; y: number } => {
  const hue = addressHue(address);
  return {
    roomId: QORTAL_LAND_DEFAULT_ROOM_ID,
    x: 430 + (hue % 8) * 110,
    y: 490 + (hue % 4) * 28,
  };
};

const roomFloorRange = (roomId: LandRoomId): { top: number; bottom: number } => {
  if (roomId === QORTAL_LAND_SKYWALK_ROOM_ID) return { top: 338, bottom: 666 };
  if (roomId === QORTAL_LAND_MALL_ROOM_ID) return { top: 332, bottom: 700 };
  if (roomId === QORTAL_LAND_PARK_ROOM_ID) return { top: 326, bottom: 704 };
  return { top: FLOOR_TOP_Y, bottom: FLOOR_BOTTOM_Y };
};

const floorBoundsForRoomY = (roomId: LandRoomId, y: number): { minX: number; maxX: number } => {
  const range = roomFloorRange(roomId);
  const ratio = Math.max(0, Math.min(1, (y - range.top) / (range.bottom - range.top)));
  if (roomId === QORTAL_LAND_SKYWALK_ROOM_ID) {
    return {
      minX: 128 + ratio * 22,
      maxX: 1672 - ratio * 22,
    };
  }
  if (roomId === QORTAL_LAND_MALL_ROOM_ID) {
    return {
      minX: 150 - ratio * 80,
      maxX: 1650 + ratio * 80,
    };
  }
  if (roomId === QORTAL_LAND_PARK_ROOM_ID) {
    return {
      minX: 110 - ratio * 86,
      maxX: 1690 + ratio * 86,
    };
  }
  return {
    minX: 205 - ratio * 130,
    maxX: 1595 + ratio * 130,
  };
};

const floorBoundsForY = (y: number): { minX: number; maxX: number } => {
  return floorBoundsForRoomY(QORTAL_LAND_DEFAULT_ROOM_ID, y);
};

const floorScaleForRoomY = (roomId: LandRoomId, y: number): number => {
  const range = roomFloorRange(roomId);
  const ratio = Math.max(0, Math.min(1, (y - range.top) / (range.bottom - range.top)));
  return 0.78 + ratio * 0.36;
};

const characterScaleForRoomY = (roomId: LandRoomId, y: number): number => {
  return floorScaleForRoomY(roomId, y) * LAND_CHARACTER_RENDER_SCALE;
};

const avatarScaleXForDirection = (direction: string, scale: number): number => {
  return direction === 'l' ? -scale : scale;
};

const avatarAnimationKeyForDirection = (direction: string, moving: boolean): string => {
  if (direction === 'u') {
    return moving ? LAND_CHARACTER_WALK_UP_ANIM_KEY : LAND_CHARACTER_IDLE_UP_ANIM_KEY;
  }
  if (direction === 'd') {
    return moving ? LAND_CHARACTER_WALK_DOWN_ANIM_KEY : LAND_CHARACTER_IDLE_DOWN_ANIM_KEY;
  }
  return moving ? LAND_CHARACTER_WALK_SIDE_ANIM_KEY : LAND_CHARACTER_IDLE_SIDE_ANIM_KEY;
};

const clampLandPosition = (
  roomId: LandRoomId,
  x: number,
  y: number
): { x: number; y: number } => {
  const range = roomFloorRange(roomId);
  const nextY = Math.max(range.top + 24, Math.min(range.bottom - 28, y));
  const bounds = floorBoundsForRoomY(roomId, nextY);
  return {
    x: Math.max(bounds.minX + 35, Math.min(bounds.maxX - 35, x)),
    y: nextY,
  };
};

export function QortalLand({ groupId, groupName, myAddress }: QortalLandProps) {
  const theme = useTheme();
  const balance = useAtomValue(balanceAtom);
  const userInfo = useAtomValue(userInfoAtom);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<import('phaser').Game | null>(null);
  const movementKeysRef = useRef<Set<string>>(new Set());
  const remotePlayersRef = useRef<Map<string, LandPlayerState>>(new Map());
  const landChatBubblesRef = useRef<Map<string, LandChatBubble>>(new Map());
  const landActionAnimationsRef = useRef<Map<string, LandActionAnimation>>(new Map());
  const landCallPresenceRef = useRef<Map<string, LandCallPresence>>(new Map());
  const landCallPeerPublicKeysRef = useRef<Map<string, string>>(new Map());
  const landCallPeersRef = useRef<Map<string, { peerAddress: string; chatId: string }>>(new Map());
  const landCallListenersRef = useRef<Set<(event: string, payload: unknown) => void>>(new Set());
  const activeLandCallIdRef = useRef<string | null>(null);
  const lastAnnouncedLandCallRef = useRef<{
    callId: string;
    peerAddress: string;
    chatId: string;
  } | null>(null);
  const primaryNameCacheRef = useRef<Map<string, string>>(new Map());
  const pendingPrimaryNameLookupsRef = useRef<Set<string>>(new Set());
  const primaryNameLookupTimerRef = useRef<number | null>(null);
  const currentRoomRef = useRef<LandRoomId>(QORTAL_LAND_DEFAULT_ROOM_ID);
  const localStateRef = useRef<LocalLandState>({
    ...initialPositionForAddress(myAddress || ''),
    direction: 'r',
    movement: 'idle',
  });
  const lastSentRef = useRef<LocalLandState & { sentAt: number }>({
    ...localStateRef.current,
    sentAt: 0,
  });
  const sequenceRef = useRef(0);
  const landChatSequenceRef = useRef(0);
  const chatAuthorSeqRef = useRef(0);
  const [reticulumReady, setReticulumReady] = useState<boolean | null>(null);
  const [chatText, setChatText] = useState('');
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [chatError, setChatError] = useState('');
  const [actionTarget, setActionTarget] = useState<LandActionTarget | null>(null);
  const [sendQortTarget, setSendQortTarget] = useState<LandActionTarget | null>(null);
  const [sendQortAmount, setSendQortAmount] = useState('1');
  const [sendQortError, setSendQortError] = useState('');
  const [isSendingQort, setIsSendingQort] = useState(false);
  const [activeLandCallPeerAddress, setActiveLandCallPeerAddress] = useState<string | null>(null);
  const [landCallPresenceVersion, setLandCallPresenceVersion] = useState(0);
  const sessionId = useMemo(() => createSessionId(), []);
  const qortBalance = useMemo(() => normalizeQortBalance(balance), [balance]);

  const emitLandCallEvent = useCallback((event: string, payload: unknown) => {
    for (const listener of landCallListenersRef.current) {
      listener(event, payload);
    }
  }, []);

  const sendLandCallSignal = useCallback(
    async (payload: Record<string, unknown>) => {
      const result = await window.reticulumChat?.sendLandCall?.(groupId, payload);
      return result?.success === true
        ? { success: true }
        : { success: false, error: result?.error || 'QortalLand call signal failed' };
    },
    [groupId]
  );

  const landCallApi = useMemo<VoiceCallApi>(() => ({
    initiate: async (
      targetAddress,
      chatId,
      localAddress,
      signature,
      publicKey,
      callId,
      timestamp
    ) => {
      landCallPeersRef.current.set(callId, { peerAddress: targetAddress, chatId });
      activeLandCallIdRef.current = callId;
      setActiveLandCallPeerAddress(targetAddress);
      const result = await sendLandCallSignal({
        callType: 'request',
        callId,
        fromAddress: localAddress,
        toAddress: targetAddress,
        chatId,
        fromPublicKey: publicKey,
        signature,
        roomId: currentRoomRef.current,
        timestamp,
      });
      return result.success ? { success: true, callId } : result;
    },
    accept: async (callId, signature, publicKey, timestamp) => {
      const peer = landCallPeersRef.current.get(callId);
      if (!peer) return { success: false, error: 'Unknown QortalLand call' };
      activeLandCallIdRef.current = callId;
      setActiveLandCallPeerAddress(peer.peerAddress);
      return sendLandCallSignal({
        callType: 'accept',
        callId,
        fromAddress: myAddress,
        toAddress: peer.peerAddress,
        chatId: peer.chatId,
        fromPublicKey: publicKey,
        signature,
        roomId: currentRoomRef.current,
        timestamp,
      });
    },
    reject: async (callId, reason, signature, publicKey, timestamp) => {
      const peer = landCallPeersRef.current.get(callId);
      if (!peer) return { success: true };
      const result = await sendLandCallSignal({
        callType: 'reject',
        callId,
        fromAddress: myAddress,
        toAddress: peer.peerAddress,
        chatId: peer.chatId,
        fromPublicKey: publicKey,
        signature,
        reason: reason || 'rejected',
        roomId: currentRoomRef.current,
        timestamp: timestamp ?? Date.now(),
      });
      landCallPeersRef.current.delete(callId);
      if (activeLandCallIdRef.current === callId) {
        activeLandCallIdRef.current = null;
        setActiveLandCallPeerAddress(null);
      }
      return result;
    },
    hangup: async (callId, signature, publicKey, timestamp) => {
      const peer = landCallPeersRef.current.get(callId);
      if (!peer) return { success: true };
      const result = await sendLandCallSignal({
        callType: 'hangup',
        callId,
        fromAddress: myAddress,
        toAddress: peer.peerAddress,
        chatId: peer.chatId,
        fromPublicKey: publicKey,
        signature,
        roomId: currentRoomRef.current,
        timestamp,
      });
      landCallPeersRef.current.delete(callId);
      if (activeLandCallIdRef.current === callId) {
        activeLandCallIdRef.current = null;
        setActiveLandCallPeerAddress(null);
      }
      return result;
    },
    setLocalAddresses: async () => ({ success: true }),
    onEvent: (cb) => {
      landCallListenersRef.current.add(cb);
      return () => {
        landCallListenersRef.current.delete(cb);
      };
    },
  }), [myAddress, sendLandCallSignal]);

  const landVoiceCall = useVoiceCall({
    callApi: landCallApi,
    skipSystemReadiness: true,
    skipDirectFriendValidation: true,
    getPeerPublicKey: (address) => landCallPeerPublicKeysRef.current.get(address),
    createCallId: () => createSessionId().slice(0, 20),
    suppressGlobalSnackbars: true,
  });
  const landVoiceCallStateRef = useRef(landVoiceCall.callState);
  useEffect(() => {
    landVoiceCallStateRef.current = landVoiceCall.callState;
  }, [landVoiceCall.callState]);

  const touchLandCallPresence = useCallback((
    address: string,
    peerAddress: string,
    callId: string,
    roomId: LandRoomId,
    ttlMs = LAND_CALL_STATUS_TTL_MS
  ) => {
    const normalized = address.trim();
    if (!normalized || !callId) return;
    landCallPresenceRef.current.set(normalized, {
      callId,
      peerAddress,
      roomId,
      expiresAt: Date.now() + ttlMs,
    });
    setLandCallPresenceVersion((value) => value + 1);
  }, []);

  const clearLandCallPresence = useCallback((addresses: string[]) => {
    let changed = false;
    for (const address of addresses) {
      if (address && landCallPresenceRef.current.delete(address)) changed = true;
    }
    if (changed) setLandCallPresenceVersion((value) => value + 1);
  }, []);

  const isAddressInLandCall = useCallback((address: string): boolean => {
    const presence = landCallPresenceRef.current.get(address);
    return Boolean(presence && presence.expiresAt > Date.now());
  }, []);

  const queuePrimaryNameLookups = useCallback((addresses: string[]) => {
    const missingAddresses = addresses
      .map((address) => address.trim())
      .filter((address) => {
        if (!address) return false;
        if (primaryNameCacheRef.current.has(address)) return false;
        if (pendingPrimaryNameLookupsRef.current.has(address)) return false;
        return true;
      });
    if (missingAddresses.length === 0) return;

    missingAddresses.forEach((address) => pendingPrimaryNameLookupsRef.current.add(address));
    if (primaryNameLookupTimerRef.current !== null) return;

    primaryNameLookupTimerRef.current = window.setTimeout(() => {
      primaryNameLookupTimerRef.current = null;
      const batch = Array.from(pendingPrimaryNameLookupsRef.current);
      pendingPrimaryNameLookupsRef.current.clear();
      if (batch.length === 0) return;

      void getPrimaryNamesForAddresses(batch)
        .then((primaryNames) => {
          batch.forEach((address) => {
            primaryNameCacheRef.current.set(address, primaryNames[address]?.trim() || '');
          });
        })
        .catch((error) => {
          console.error('[QortalLand] Failed to resolve primary names:', error);
        });
    }, 120);
  }, []);

  useEffect(() => {
    queuePrimaryNameLookups([myAddress]);
  }, [myAddress, queuePrimaryNameLookups]);

  useEffect(() => {
    return () => {
      if (primaryNameLookupTimerRef.current !== null) {
        window.clearTimeout(primaryNameLookupTimerRef.current);
        primaryNameLookupTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!actionTarget) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActionTarget(null);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [actionTarget]);

  const publishLandEventPayload = useCallback(async (payload: Record<string, unknown>) => {
    const timestamp = Date.now();
    const eventId = createLandChatMessageId();
    const syncState = await window.reticulumChat?.getSyncState?.(groupId);
    const latestAuthorSeq = Math.max(
      chatAuthorSeqRef.current,
      Number(syncState?.[myAddress] ?? 0) || 0
    );
    const authorSeq = latestAuthorSeq + 1;
    const encryptedPayload = JSON.stringify({
      ...payload,
      qortalLand: true,
      sessionId,
      version: 1,
    });
    const payloadHash = await sha256Hex(encryptedPayload);
    const baseFields = {
      eventId,
      groupId,
      channelId: QORTAL_LAND_CHANNEL_ID,
      authorSeq,
      timestamp,
      eventType: 'message',
      targetEventId: null,
      replyToEventId: null,
      encryptedPayload,
      payloadHash,
      mentionAddressHashes: [],
    };
    const signed = await window.sendMessage?.('signReticulumChatEvent', baseFields, 10000) as
      | {
          authorAddress?: string;
          authorPublicKey?: string;
          signature?: string;
          error?: string;
        }
      | undefined;
    if (!signed || signed.error) {
      throw new Error(signed?.error || 'Unable to sign QortalLand event');
    }
    if (signed.authorAddress !== myAddress) {
      throw new Error('Signed QortalLand author mismatch');
    }
    const result = await window.reticulumChat?.publishEvent?.({
      ...baseFields,
      authorAddress: signed.authorAddress,
      authorPublicKey: signed.authorPublicKey,
      signature: signed.signature,
    });
    if (!result?.success) {
      throw new Error(result?.error || 'QortalLand event send failed');
    }
    chatAuthorSeqRef.current = authorSeq;
    return { eventId, timestamp };
  }, [groupId, myAddress, sessionId]);

  useEffect(() => {
    let cancelled = false;
    void window.reticulumChat?.isEnabled?.().then((enabled) => {
      if (!cancelled) setReticulumReady(enabled === true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const pressedKeys = movementKeysRef.current;
    const normalizeMovementKey = (key: string): string => key.trim().toLowerCase();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const key = normalizeMovementKey(event.key);
      if (!['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's'].includes(key)) return;
      pressedKeys.add(key);
      event.preventDefault();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      pressedKeys.delete(normalizeMovementKey(event.key));
    };
    const clearKeys = () => {
      pressedKeys.clear();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', clearKeys);
    document.addEventListener('visibilitychange', clearKeys);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', clearKeys);
      document.removeEventListener('visibilitychange', clearKeys);
      clearKeys();
    };
  }, []);

  const sendLandChat = useCallback(async () => {
    if (isSendingChat || reticulumReady !== true) return;
    const text = chatText.trim().replace(/\s+/g, ' ');
    if (!text) return;
    if (utf8ByteLength(text) > LAND_CHAT_MAX_TEXT_BYTES) {
      setChatError('Message is too large');
      return;
    }
    setIsSendingChat(true);
    setChatError('');
    try {
      const landSequence = landChatSequenceRef.current + 1;
      landChatSequenceRef.current = landSequence;
      await publishLandEventPayload({
        qortalLandType: 'chat',
        messageText: text,
        landSequence,
      });
      setChatText('');
      if (isEditableTarget(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'QortalLand chat send failed');
    } finally {
      setIsSendingChat(false);
    }
  }, [chatText, isSendingChat, publishLandEventPayload, reticulumReady]);

  const addQortReceivedAnimation = useCallback((
    actionId: string,
    fromAddress: string,
    toAddress: string,
    targetSessionId: string,
    amount: number,
    roomId: LandRoomId
  ) => {
    const now = Date.now();
    landActionAnimationsRef.current.set(actionId, {
      actionId,
      type: 'qort_received',
      fromAddress,
      toAddress,
      targetSessionId,
      amount,
      roomId,
      createdAt: now,
      expiresAt: now + LAND_ACTION_ANIMATION_TTL_MS,
    });
  }, []);

  const openSendQortDialog = useCallback((target: LandActionTarget) => {
    setActionTarget(null);
    setSendQortTarget(target);
    setSendQortAmount('1');
    setSendQortError('');
  }, []);

  const closeSendQortDialog = useCallback(() => {
    if (isSendingQort) return;
    setSendQortTarget(null);
    setSendQortError('');
  }, [isSendingQort]);

  const handleSendQort = useCallback(async () => {
    if (!sendQortTarget || isSendingQort) return;
    const amount = Number(sendQortAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setSendQortError('Enter a valid QORT amount');
      return;
    }
    if (amount > qortBalance) {
      setSendQortError('Insufficient QORT balance');
      return;
    }
    setIsSendingQort(true);
    setSendQortError('');
    try {
      const paymentResult = await window.sendMessage?.('sendCoin', {
        amount,
        receiver: sendQortTarget.authorAddress,
        password: null,
        skipConfirmPassword: true,
      }, 120000) as { payload?: unknown; error?: string } | undefined;
      if (!paymentResult || paymentResult.error) {
        throw new Error(paymentResult?.error || 'QORT payment failed');
      }

      const actionId = createLandChatMessageId();
      let actionResult: { success: boolean; error?: string } | null = null;
      try {
        actionResult = await window.reticulumChat?.sendLandAction?.(
          groupId,
          {
            actionId,
            actionType: 'qort_received',
            fromAddress: myAddress,
            toAddress: sendQortTarget.authorAddress,
            targetSessionId: sendQortTarget.sessionId,
            amount,
            roomId: sendQortTarget.roomId,
          }
        ) ?? null;
      } catch (error) {
        console.warn('Failed to send QortalLand QORT action:', error);
      }
      if (actionResult && actionResult.success !== true) {
        console.warn('Failed to send QortalLand QORT action:', actionResult.error);
      }
      addQortReceivedAnimation(
        actionId,
        myAddress,
        sendQortTarget.authorAddress,
        sendQortTarget.sessionId,
        amount,
        sendQortTarget.roomId
      );
      setSendQortTarget(null);
      setSendQortAmount('1');
    } catch (error) {
      setSendQortError(error instanceof Error ? error.message : 'QORT payment failed');
    } finally {
      setIsSendingQort(false);
    }
  }, [
    addQortReceivedAnimation,
    groupId,
    isSendingQort,
    myAddress,
    qortBalance,
    sendQortAmount,
    sendQortTarget,
  ]);

  const signLandCallFields = useCallback(
    async (fields: Record<string, unknown>) => {
      if (!userInfo?.publicKey) {
        throw new Error('Missing local public key');
      }
      const response = await window.sendMessage?.('signPresenceMessage', fields, 10_000) as
        | { signature?: string; error?: string }
        | undefined;
      if (!response?.signature || response.error) {
        throw new Error(response?.error || 'Unable to sign QortalLand call');
      }
      return {
        signature: response.signature,
        publicKey: userInfo.publicKey,
      };
    },
    [userInfo?.publicKey]
  );

  const startLandCall = useCallback(
    (target: LandActionTarget) => {
      if (!myAddress || landVoiceCall.callState !== 'idle') return;
      if (isAddressInLandCall(target.authorAddress)) return;
      const chatId = buildDirectVoiceCallChatId(myAddress, target.authorAddress);
      setActionTarget(null);
      setActiveLandCallPeerAddress(target.authorAddress);
      void landVoiceCall.initiateCall(target.authorAddress, chatId, signLandCallFields);
    },
    [
      isAddressInLandCall,
      landVoiceCall,
      myAddress,
      signLandCallFields,
    ]
  );

  useEffect(() => {
    if (!Number.isInteger(groupId) || groupId <= 0 || !myAddress) return;
    void window.reticulumChat?.subscribeGroup?.(groupId);
    void window.reticulumChat?.subscribeChannel?.(groupId, QORTAL_LAND_CHANNEL_ID);
    const unsubscribe = window.reticulumChat?.onLandState?.((payload) => {
      if (payload.groupId !== groupId) return;
      if (payload.authorAddress === myAddress && payload.sessionId === sessionId) return;
      queuePrimaryNameLookups([payload.authorAddress]);
      const key = `${payload.authorAddress}:${payload.sessionId}`;
      const existing = remotePlayersRef.current.get(key);
      const now = Date.now();
      const roomId = normalizeLandRoomId(payload.roomId);
      if (payload.movement === 'leave') {
        if (!existing || payload.sequence >= existing.sequence) {
          remotePlayersRef.current.delete(key);
        }
        return;
      }
      if (existing && payload.sequence <= existing.sequence) {
        existing.lastSeenAt = now;
        return;
      }
      const sentAt = finiteNumber(payload.timestamp) ?? now;
      const roomChanged = Boolean(existing && existing.roomId !== roomId);
      const fromX = roomChanged ? payload.x : existing?.displayX ?? existing?.x ?? payload.x;
      const fromY = roomChanged ? payload.y : existing?.displayY ?? existing?.y ?? payload.y;
      const stateGapMs = existing
        ? clampNumber(
            sentAt > existing.sentAt ? sentAt - existing.sentAt : now - existing.receivedAt,
            LAND_SEND_INTERVAL_MS,
            5000
          )
        : LAND_SEND_INTERVAL_MS;
      const velocitySourceMs = Math.max(stateGapMs, 1);
      const velocityX = existing && !roomChanged
        ? clampRemoteVelocity((payload.x - existing.x) / velocitySourceMs)
        : 0;
      const velocityY = existing && !roomChanged
        ? clampRemoteVelocity((payload.y - existing.y) / velocitySourceMs)
        : 0;
      const distance = Math.hypot(payload.x - fromX, payload.y - fromY);
      remotePlayersRef.current.set(key, {
        authorAddress: payload.authorAddress,
        sessionId: payload.sessionId,
        sequence: payload.sequence,
        roomId,
        x: payload.x,
        y: payload.y,
        fromX,
        fromY,
        displayX: fromX,
        displayY: fromY,
        direction: payload.direction || existing?.direction || 'r',
        movement: payload.movement || 'idle',
        sentAt,
        receivedAt: now,
        lastSeenAt: now,
        interpolationMs: estimateRemoteInterpolationMs(distance, stateGapMs),
        velocityX,
        velocityY,
      });
    });
    return () => {
      unsubscribe?.();
      void window.reticulumChat?.unsubscribeChannel?.(groupId, QORTAL_LAND_CHANNEL_ID);
      void window.reticulumChat?.sendLandState?.(groupId, myAddress, {
        sessionId,
        sequence: sequenceRef.current + 1,
        ...localStateRef.current,
        movement: 'leave',
      });
    };
  }, [groupId, myAddress, queuePrimaryNameLookups, sessionId]);

  useEffect(() => {
    if (!Number.isInteger(groupId) || groupId <= 0 || !myAddress) return;
    const unsubscribe = window.reticulumChat?.onEvent?.(({ event }) => {
      const payload = event as ReticulumChatEventForLand;
      if (Number(payload.groupId) !== groupId) return;
      if (payload.channelId !== QORTAL_LAND_CHANNEL_ID) return;
      if (payload.eventType !== 'message') return;
      if (
        typeof payload.eventId !== 'string' ||
        typeof payload.authorAddress !== 'string' ||
        typeof payload.encryptedPayload !== 'string'
      ) {
        return;
      }
      let decoded: Record<string, unknown>;
      try {
        decoded = JSON.parse(payload.encryptedPayload) as Record<string, unknown>;
      } catch {
        return;
      }
      if (decoded.qortalLand !== true) return;
      const text = String(decoded.messageText || decoded.message || '').trim();
      if (!text) return;
      const session = typeof decoded.sessionId === 'string' ? decoded.sessionId : sessionId;
      const sequence = Number(decoded.landSequence);
      queuePrimaryNameLookups([payload.authorAddress]);
      const now = Date.now();
      landChatBubblesRef.current.set(payload.eventId, {
        messageId: payload.eventId,
        authorAddress: payload.authorAddress,
        sessionId: session,
        sequence: Number.isFinite(sequence) ? sequence : 0,
        text,
        createdAt: now,
        expiresAt: now + LAND_CHAT_BUBBLE_TTL_MS,
      });
    });
    return () => {
      unsubscribe?.();
    };
  }, [groupId, myAddress, queuePrimaryNameLookups, sessionId]);

  useEffect(() => {
    if (!Number.isInteger(groupId) || groupId <= 0 || !myAddress) return;
    const unsubscribe = window.reticulumChat?.onLandAction?.((payload) => {
      if (payload.groupId !== groupId) return;
      if (payload.actionType !== 'qort_received') return;
      const actionId = typeof payload.actionId === 'string' ? payload.actionId : '';
      const fromAddress = typeof payload.fromAddress === 'string' ? payload.fromAddress : '';
      const toAddress = typeof payload.toAddress === 'string' ? payload.toAddress : '';
      const targetSessionId = typeof payload.targetSessionId === 'string' ? payload.targetSessionId : '';
      const amount = finiteNumber(payload.amount);
      if (!actionId || !fromAddress || !toAddress || !targetSessionId || amount === null || amount <= 0) return;
      if (landActionAnimationsRef.current.has(actionId)) return;
      queuePrimaryNameLookups([fromAddress, toAddress]);
      addQortReceivedAnimation(
        actionId,
        fromAddress,
        toAddress,
        targetSessionId,
        amount,
        normalizeLandRoomId(payload.roomId)
      );
    });
    return () => {
      unsubscribe?.();
    };
  }, [addQortReceivedAnimation, groupId, myAddress, queuePrimaryNameLookups]);

  useEffect(() => {
    if (!Number.isInteger(groupId) || groupId <= 0 || !myAddress) return;
    const unsubscribe = window.reticulumChat?.onLandCall?.((payload) => {
      if (payload.groupId !== groupId) return;
      const callType = typeof payload.callType === 'string' ? payload.callType : '';
      const callId = typeof payload.callId === 'string' ? payload.callId : '';
      const fromAddress = typeof payload.fromAddress === 'string' ? payload.fromAddress : '';
      const toAddress = typeof payload.toAddress === 'string' ? payload.toAddress : '';
      const chatId =
        typeof payload.chatId === 'string' && payload.chatId
          ? payload.chatId
          : fromAddress && toAddress
            ? buildDirectVoiceCallChatId(fromAddress, toAddress)
            : '';
      const roomId = normalizeLandRoomId(payload.roomId);
      if (!callId || !fromAddress || !toAddress) return;
      if (payload.fromPublicKey) {
        landCallPeerPublicKeysRef.current.set(fromAddress, payload.fromPublicKey);
      }

      if (callType === 'request') {
        const localBusy = toAddress === myAddress
          ? landVoiceCallStateRef.current !== 'idle' || Boolean(activeLandCallIdRef.current)
          : false;
        if (toAddress !== myAddress || fromAddress === myAddress) return;
        if (localBusy) {
          void (async () => {
            const timestamp = Date.now();
            const signed = await signLandCallFields({
              type: 'CALL_REJECT',
              callId,
              timestamp,
            });
            await sendLandCallSignal({
              callType: 'reject',
              callId,
              fromAddress: myAddress,
              toAddress: fromAddress,
              chatId,
              fromPublicKey: signed.publicKey,
              signature: signed.signature,
              reason: 'busy',
              roomId: currentRoomRef.current,
              timestamp,
            });
          })().catch(() => {});
          return;
        }
        landCallPeersRef.current.set(callId, { peerAddress: fromAddress, chatId });
        activeLandCallIdRef.current = callId;
        setActiveLandCallPeerAddress(fromAddress);
        queuePrimaryNameLookups([fromAddress]);
        emitLandCallEvent('call:incoming', {
          callId,
          fromAddress,
          chatId,
        });
        return;
      }

      if (callType === 'accept') {
        touchLandCallPresence(fromAddress, toAddress, callId, roomId);
        touchLandCallPresence(toAddress, fromAddress, callId, roomId);
        if (toAddress !== myAddress) return;
        landCallPeersRef.current.set(callId, { peerAddress: fromAddress, chatId });
        activeLandCallIdRef.current = callId;
        setActiveLandCallPeerAddress(fromAddress);
        queuePrimaryNameLookups([fromAddress]);
        emitLandCallEvent('call:accepted', { callId });
        return;
      }

      if (callType === 'reject') {
        clearLandCallPresence([fromAddress, toAddress]);
        if (toAddress === myAddress) {
          emitLandCallEvent('call:rejected', { callId, reason: payload.reason || 'rejected' });
        }
        landCallPeersRef.current.delete(callId);
        if (activeLandCallIdRef.current === callId) {
          activeLandCallIdRef.current = null;
          setActiveLandCallPeerAddress(null);
        }
        return;
      }

      if (callType === 'hangup' || callType === 'ended') {
        clearLandCallPresence([fromAddress, toAddress]);
        if (callType === 'ended') {
          return;
        }
        if (toAddress === myAddress) {
          emitLandCallEvent('call:hangup', { callId });
        }
        landCallPeersRef.current.delete(callId);
        if (activeLandCallIdRef.current === callId) {
          activeLandCallIdRef.current = null;
          setActiveLandCallPeerAddress(null);
        }
        return;
      }

      if (callType === 'status') {
        touchLandCallPresence(fromAddress, toAddress, callId, roomId);
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [
    clearLandCallPresence,
    emitLandCallEvent,
    groupId,
    isAddressInLandCall,
    myAddress,
    queuePrimaryNameLookups,
    sendLandCallSignal,
    signLandCallFields,
    touchLandCallPresence,
  ]);

  useEffect(() => {
    if (reticulumReady !== true || !Number.isInteger(groupId) || groupId <= 0 || !myAddress) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      const current = localStateRef.current;
      const previous = lastSentRef.current;
      const moved =
        Math.abs(current.x - previous.x) >= 2 ||
        Math.abs(current.y - previous.y) >= 2 ||
        current.direction !== previous.direction ||
        current.movement !== previous.movement;
      if (!moved && now - previous.sentAt < LAND_HEARTBEAT_MS) return;
      sequenceRef.current += 1;
      lastSentRef.current = { ...current, sentAt: now };
      void window.reticulumChat?.sendLandState?.(groupId, myAddress, {
        sessionId,
        sequence: sequenceRef.current,
        ...current,
      });
    }, LAND_SEND_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [groupId, myAddress, reticulumReady, sessionId]);

  useEffect(() => {
    if (!myAddress || reticulumReady !== true) return;
    const callActive = landVoiceCall.callState === 'connected';
    const callId = activeLandCallIdRef.current;
    const peer = callId ? landCallPeersRef.current.get(callId) : null;
    if (!callActive || !callId || !peer) return;
    const sendStatus = () => {
      touchLandCallPresence(myAddress, peer.peerAddress, callId, currentRoomRef.current);
      void sendLandCallSignal({
        callType: 'status',
        callId,
        fromAddress: myAddress,
        toAddress: peer.peerAddress,
        chatId: peer.chatId,
        roomId: currentRoomRef.current,
        timestamp: Date.now(),
      });
    };
    sendStatus();
    const interval = window.setInterval(sendStatus, LAND_CALL_STATUS_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [
    landVoiceCall.callState,
    myAddress,
    reticulumReady,
    sendLandCallSignal,
    touchLandCallPresence,
  ]);

  useEffect(() => {
    const callActive = landVoiceCall.callState === 'connected';
    const callId = activeLandCallIdRef.current;
    const peer = callId ? landCallPeersRef.current.get(callId) : null;
    if (callActive && callId && peer) {
      lastAnnouncedLandCallRef.current = {
        callId,
        peerAddress: peer.peerAddress,
        chatId: peer.chatId,
      };
      return;
    }
    const previous = lastAnnouncedLandCallRef.current;
    if (!previous || !myAddress || reticulumReady !== true) return;
    lastAnnouncedLandCallRef.current = null;
    void sendLandCallSignal({
      callType: 'ended',
      callId: previous.callId,
      fromAddress: myAddress,
      toAddress: previous.peerAddress,
      chatId: previous.chatId,
      roomId: currentRoomRef.current,
      timestamp: Date.now(),
    });
    clearLandCallPresence([myAddress, previous.peerAddress]);
    landCallPeersRef.current.delete(previous.callId);
    if (activeLandCallIdRef.current === previous.callId) {
      activeLandCallIdRef.current = null;
      setActiveLandCallPeerAddress(null);
    }
  }, [
    clearLandCallPresence,
    landVoiceCall.callState,
    myAddress,
    reticulumReady,
    sendLandCallSignal,
  ]);

  useEffect(() => {
    if (!containerRef.current || !myAddress) return;
    let destroyed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame = 0;

    void import('phaser').then((Phaser) => {
      if (destroyed || !containerRef.current) return;
      const localHue = addressHue(myAddress);
      const localColor = Phaser.Display.Color.HSLToColor(localHue / 360, 0.62, 0.58).color;
      const remoteHueBase = (localHue + 145) % 360;

      class QortalLandScene extends Phaser.Scene {
        private localAvatar?: any;
        private localLabel?: any;
        private remotes = new Map<string, any>();
        private remoteLabels = new Map<string, any>();
        private chatBubbles = new Map<string, { container: any; background: any; text: any }>();
        private actionAnimations = new Map<string, { container: any; coins: any[]; text: any }>();
        private callIndicators = new Map<string, { container: any; badge: any; phone: any }>();
        private background?: any;
        private lightSweep?: any;
        private foreground?: any;
        private propLayers: any[] = [];

        constructor() {
          super('QortalLandScene');
        }

        preload() {
          this.load.spritesheet(LAND_CHARACTER_SPRITESHEET_KEY, defaultCharacterSpritesheetUrl, {
            frameWidth: LAND_CHARACTER_FRAME_SIZE,
            frameHeight: LAND_CHARACTER_FRAME_SIZE,
          });
        }

        create() {
          this.cameras.main.setBounds(0, 0, LAND_WIDTH, LAND_HEIGHT);
          this.ensureCharacterAnimations();
          currentRoomRef.current = localStateRef.current.roomId;
          this.drawWorld();
          const start = localStateRef.current;
          const startScale = characterScaleForRoomY(start.roomId, start.y);
          this.localAvatar = this.createAvatar(start.x, start.y, localColor, true);
          this.localLabel = this.add
            .text(
              start.x,
              start.y - LAND_CHARACTER_LABEL_OFFSET * startScale,
              displayNameForAddress(myAddress, primaryNameCacheRef.current),
              {
              color: '#f8fbff',
              fontFamily: 'Inter, Arial, sans-serif',
              fontSize: '12px',
              stroke: '#10151c',
              strokeThickness: 4,
              }
            )
            .setOrigin(0.5);
          this.localAvatar.setScale(startScale);
          this.localAvatar.setDepth(start.y + 20);
          this.localLabel.setDepth(start.y + 90);
          this.cameras.main.centerOn(start.x, start.y);
          this.cameras.main.startFollow(this.localAvatar, true, 1, 1);
          this.scale.on('resize', this.drawWorld, this);
        }

        update(time: number, delta: number) {
          this.animateRoom(time);
          this.updateLocalPlayer(delta);
          this.updateRemotePlayers();
          try {
            this.updateChatBubbles();
          } catch (error) {
            console.warn('[QortalLand] Chat bubble update failed', error);
            landChatBubblesRef.current.clear();
            for (const [messageId, bubbleObjects] of this.chatBubbles.entries()) {
              this.removeChatBubble(messageId, bubbleObjects);
            }
          }
          try {
            this.updateActionAnimations();
          } catch (error) {
            console.warn('[QortalLand] Action animation update failed', error);
            landActionAnimationsRef.current.clear();
            for (const [actionId, animationObjects] of this.actionAnimations.entries()) {
              this.removeActionAnimation(actionId, animationObjects);
            }
          }
          try {
            this.updateCallIndicators();
          } catch (error) {
            console.warn('[QortalLand] Call indicator update failed', error);
            for (const [indicatorKey, indicatorObjects] of this.callIndicators.entries()) {
              this.removeCallIndicator(indicatorKey, indicatorObjects);
            }
          }
        }

        private drawWorld() {
          this.background?.destroy();
          this.lightSweep?.destroy();
          this.foreground?.destroy();
          this.propLayers.forEach((layer) => layer.destroy());
          this.propLayers = [];
          const g = this.add.graphics();
          const roomId = currentRoomRef.current;
          if (roomId === QORTAL_LAND_SKYWALK_ROOM_ID) {
            this.drawSkywalkWorld(g);
            this.background = g;
            g.setDepth(-100);
            this.drawSkywalkDepthProps();
            this.lightSweep = this.add.graphics();
            this.lightSweep.setDepth(-80);
            this.foreground = this.add.graphics();
            this.drawForeground(this.foreground);
            this.foreground.setDepth(roomFloorRange(roomId).bottom + 170);
            return;
          }
          if (roomId === QORTAL_LAND_MALL_ROOM_ID) {
            this.drawMallWorld(g);
            this.background = g;
            g.setDepth(-100);
            this.drawMallDepthProps();
            this.lightSweep = this.add.graphics();
            this.lightSweep.setDepth(-80);
            this.foreground = this.add.graphics();
            this.drawForeground(this.foreground);
            this.foreground.setDepth(roomFloorRange(roomId).bottom + 170);
            return;
          }
          if (roomId === QORTAL_LAND_PARK_ROOM_ID) {
            this.drawParkWorld(g);
            this.background = g;
            g.setDepth(-100);
            this.drawParkDepthProps();
            this.lightSweep = this.add.graphics();
            this.lightSweep.setDepth(-80);
            this.foreground = this.add.graphics();
            this.drawForeground(this.foreground);
            this.foreground.setDepth(roomFloorRange(roomId).bottom + 170);
            return;
          }
          g.fillStyle(0x070914, 1);
          g.fillRect(0, 0, LAND_WIDTH, LAND_HEIGHT);
          g.fillStyle(0x10152a, 1);
          g.fillRect(0, 0, LAND_WIDTH, FLOOR_TOP_Y);
          this.drawSideWalls(g);
          this.drawCeilingRig(g);

          g.fillStyle(0x0c0d19, 1);
          g.fillPoints([
            new Phaser.Geom.Point(205, FLOOR_TOP_Y),
            new Phaser.Geom.Point(1595, FLOOR_TOP_Y),
            new Phaser.Geom.Point(1725, FLOOR_BOTTOM_Y),
            new Phaser.Geom.Point(75, FLOOR_BOTTOM_Y),
          ], true);
          g.lineStyle(3, 0x1be7ff, 0.16);
          g.strokePoints([
            new Phaser.Geom.Point(205, FLOOR_TOP_Y),
            new Phaser.Geom.Point(1595, FLOOR_TOP_Y),
            new Phaser.Geom.Point(1725, FLOOR_BOTTOM_Y),
            new Phaser.Geom.Point(75, FLOOR_BOTTOM_Y),
            new Phaser.Geom.Point(205, FLOOR_TOP_Y),
          ], false);

          this.drawFloorTexture(g);
          g.lineStyle(1, 0x00e7ff, 0.055);
          for (let i = 1; i <= 4; i += 1) {
            const t = i / 5;
            const leftX = 205 - t * 130;
            const rightX = 1595 + t * 130;
            const y = FLOOR_TOP_Y + t * (FLOOR_BOTTOM_Y - FLOOR_TOP_Y);
            g.lineBetween(leftX, y, rightX, y);
          }
          for (let i = 1; i <= 6; i += 1) {
            const t = i / 7;
            const topX = 205 + t * 1390;
            const bottomX = 75 + t * 1650;
            g.lineBetween(topX, FLOOR_TOP_Y, bottomX, FLOOR_BOTTOM_Y);
          }

          g.fillStyle(0x111730, 1);
          g.fillRoundedRect(470, 170, 860, 118, 18);
          g.fillStyle(0x1a2448, 1);
          g.fillRoundedRect(500, 204, 800, 58, 14);
          g.fillStyle(0x090b18, 1);
          g.fillRoundedRect(420, 270, 960, 62, 16);
          g.lineStyle(4, 0xff2bd6, 0.46);
          g.strokeRoundedRect(420, 270, 960, 62, 16);
          g.lineStyle(2, 0x00f0ff, 0.34);
          g.strokeRoundedRect(500, 204, 800, 58, 14);
          for (let x = 545; x <= 1245; x += 70) {
            g.fillStyle(x % 140 === 0 ? 0xff2bd6 : 0x2cf8ff, 0.58);
            g.fillRoundedRect(x, 214, 28, 38, 6);
          }

          g.fillStyle(0x050611, 1);
          g.fillRoundedRect(760, 92, 280, 72, 20);
          g.lineStyle(3, 0xff2bd6, 0.58);
          g.strokeRoundedRect(760, 92, 280, 72, 20);
          g.lineStyle(2, 0x2cf8ff, 0.42);
          g.strokeRoundedRect(778, 110, 244, 36, 14);

          this.drawNeonText(g, 803, 118);
          this.drawSkywalkDoor(g, 1478, 118);
          this.drawDanceFloor(g);
          this.drawLightBeams(g);
          this.background = g;
          g.setDepth(-100);

          this.drawDepthProps();
          this.lightSweep = this.add.graphics();
          this.lightSweep.setDepth(-80);
          this.foreground = this.add.graphics();
          this.drawForeground(this.foreground);
          this.foreground.setDepth(FLOOR_BOTTOM_Y + 170);
        }

        private ensureCharacterAnimations() {
          if (!this.anims.exists(LAND_CHARACTER_IDLE_SIDE_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_IDLE_SIDE_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, { start: 0, end: 0 }),
              frameRate: 1,
              repeat: 0,
            });
          }
          if (!this.anims.exists(LAND_CHARACTER_WALK_SIDE_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_WALK_SIDE_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, {
                start: 0,
                end: LAND_CHARACTER_FRAMES_PER_DIRECTION - 1,
              }),
              frameRate: 10,
              repeat: -1,
            });
          }
          if (!this.anims.exists(LAND_CHARACTER_IDLE_DOWN_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_IDLE_DOWN_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, {
                start: LAND_CHARACTER_FRAMES_PER_DIRECTION,
                end: LAND_CHARACTER_FRAMES_PER_DIRECTION,
              }),
              frameRate: 1,
              repeat: 0,
            });
          }
          if (!this.anims.exists(LAND_CHARACTER_WALK_DOWN_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_WALK_DOWN_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, {
                start: LAND_CHARACTER_FRAMES_PER_DIRECTION,
                end: LAND_CHARACTER_FRAMES_PER_DIRECTION * 2 - 1,
              }),
              frameRate: 10,
              repeat: -1,
            });
          }
          if (!this.anims.exists(LAND_CHARACTER_IDLE_UP_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_IDLE_UP_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, {
                start: LAND_CHARACTER_FRAMES_PER_DIRECTION * 2,
                end: LAND_CHARACTER_FRAMES_PER_DIRECTION * 2,
              }),
              frameRate: 1,
              repeat: 0,
            });
          }
          if (!this.anims.exists(LAND_CHARACTER_WALK_UP_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_WALK_UP_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, {
                start: LAND_CHARACTER_FRAMES_PER_DIRECTION * 2,
                end: LAND_CHARACTER_FRAMES_PER_DIRECTION * 3 - 1,
              }),
              frameRate: 10,
              repeat: -1,
            });
          }
        }

        private createAvatar(x: number, y: number, _color: number, _local: boolean) {
          const avatar = this.add.sprite(x, y, LAND_CHARACTER_SPRITESHEET_KEY, LAND_CHARACTER_FRAMES_PER_DIRECTION);
          avatar.setOrigin(0.5, LAND_CHARACTER_FEET_BASELINE / LAND_CHARACTER_FRAME_SIZE);
          avatar.setSize(104, 174);
          avatar.play(LAND_CHARACTER_IDLE_DOWN_ANIM_KEY);
          avatar.setData('lastAnimation', LAND_CHARACTER_IDLE_DOWN_ANIM_KEY);
          return avatar;
        }

        private animateAvatar(avatar: any, moving: boolean, direction: string) {
          const animationKey = avatarAnimationKeyForDirection(direction, moving);
          if (avatar?.getData?.('lastAnimation') === animationKey) return;
          avatar?.play?.(animationKey, true);
          avatar?.setData?.('lastAnimation', animationKey);
        }

        private createPropLayer(depth: number) {
          const layer = this.add.graphics();
          layer.setDepth(depth);
          this.propLayers.push(layer);
          return layer;
        }

        private drawNeonText(g: any, x: number, y: number) {
          g.fillStyle(0xff2bd6, 1);
          g.fillRoundedRect(x, y, 16, 8, 4);
          g.fillRoundedRect(x, y + 8, 8, 16, 4);
          g.fillRoundedRect(x + 18, y, 8, 24, 4);
          g.fillRoundedRect(x + 32, y, 8, 24, 4);
          g.fillRoundedRect(x + 32, y + 16, 16, 8, 4);
          g.fillStyle(0x2cf8ff, 1);
          g.fillRoundedRect(x + 62, y, 10, 24, 5);
          g.fillRoundedRect(x + 80, y, 10, 24, 5);
          g.fillRoundedRect(x + 98, y, 10, 24, 5);
          g.fillRoundedRect(x + 116, y, 10, 24, 5);
          g.fillStyle(0xffae00, 1);
          g.fillRoundedRect(x + 146, y, 14, 24, 4);
          g.fillRoundedRect(x + 164, y, 14, 24, 4);
        }

        private drawFloorTexture(g: any) {
          for (let i = 0; i < 14; i += 1) {
            const y = FLOOR_TOP_Y + 26 + (i % 13) * 28;
            const bounds = floorBoundsForY(y);
            const availableWidth = Math.max(1, bounds.maxX - bounds.minX - 120);
            const x = bounds.minX + 34 + ((i * 73) % availableWidth);
            const width = 56 + (i % 5) * 22;
            g.fillStyle(i % 2 === 0 ? 0x2cf8ff : 0xff2bd6, 0.018);
            g.fillRoundedRect(x, y, width, 5, 3);
          }
          for (let i = 0; i < 5; i += 1) {
            const y = 366 + i * 18;
            const bounds = floorBoundsForY(y);
            g.lineStyle(1, 0xffffff, 0.018);
            g.lineBetween(bounds.minX + 24, y, bounds.maxX - 24, y + 2);
          }
          g.fillStyle(0x2cf8ff, 0.022);
          g.fillEllipse(705, 520, 420, 72);
          g.fillStyle(0xff2bd6, 0.018);
          g.fillEllipse(1125, 580, 520, 92);
        }

        private drawSideWalls(g: any) {
          g.fillStyle(0x080b19, 0.92);
          g.fillPoints([
            new Phaser.Geom.Point(0, 128),
            new Phaser.Geom.Point(205, FLOOR_TOP_Y),
            new Phaser.Geom.Point(75, FLOOR_BOTTOM_Y),
            new Phaser.Geom.Point(0, FLOOR_BOTTOM_Y + 40),
          ], true);
          g.fillStyle(0x0b1022, 0.92);
          g.fillPoints([
            new Phaser.Geom.Point(LAND_WIDTH, 128),
            new Phaser.Geom.Point(1595, FLOOR_TOP_Y),
            new Phaser.Geom.Point(1725, FLOOR_BOTTOM_Y),
            new Phaser.Geom.Point(LAND_WIDTH, FLOOR_BOTTOM_Y + 40),
          ], true);
          g.lineStyle(2, 0x2cf8ff, 0.055);
          for (let y = 220; y <= 560; y += 170) {
            g.lineBetween(18, y, 155, y + 72);
            g.lineBetween(LAND_WIDTH - 18, y, LAND_WIDTH - 155, y + 72);
          }
          g.lineStyle(3, 0xff2bd6, 0.11);
          g.lineBetween(0, 128, 205, FLOOR_TOP_Y);
          g.lineStyle(3, 0x2cf8ff, 0.11);
          g.lineBetween(LAND_WIDTH, 128, 1595, FLOOR_TOP_Y);
        }

        private drawCeilingRig(g: any) {
          g.lineStyle(5, 0x050611, 0.9);
          g.lineBetween(360, 78, 1440, 78);
          g.lineStyle(2, 0x2cf8ff, 0.16);
          g.lineBetween(360, 78, 760, 165);
          g.lineBetween(1440, 78, 1040, 165);
          for (let x = 460; x <= 1340; x += 176) {
            g.fillStyle(0x090b18, 1);
            g.fillCircle(x, 78, 18);
            g.lineStyle(2, x % 352 === 0 ? 0xff2bd6 : 0x2cf8ff, 0.42);
            g.strokeCircle(x, 78, 14);
          }
          g.fillStyle(0xc7f8ff, 0.62);
          g.fillCircle(900, 86, 28);
          g.fillStyle(0x2cf8ff, 0.14);
          g.fillCircle(900, 86, 46);
          g.lineStyle(1, 0x10152a, 0.5);
          for (let offset = -20; offset <= 20; offset += 10) {
            g.lineBetween(900 + offset, 61, 900 - offset, 111);
            g.lineBetween(875, 86 + offset, 925, 86 - offset);
          }
        }

        private drawSkywalkDoor(g: any, x: number, y: number) {
          g.fillStyle(0x070914, 0.96);
          g.fillRoundedRect(x - 34, y - 20, 204, 238, 16);
          g.lineStyle(2, 0x2cf8ff, 0.12);
          g.strokeRoundedRect(x - 34, y - 20, 204, 238, 16);
          g.fillStyle(0x2cf8ff, 0.055);
          g.fillRoundedRect(x - 18, y - 4, 172, 208, 20);
          g.fillStyle(0xff2bd6, 0.04);
          g.fillRoundedRect(x - 5, y + 8, 146, 184, 18);
          g.fillStyle(0x050713, 0.98);
          g.fillRoundedRect(x, y, 136, 188, 16);
          g.fillStyle(0x091225, 1);
          g.fillRoundedRect(x + 14, y + 16, 108, 156, 12);
          g.fillStyle(0x02030a, 1);
          g.fillRoundedRect(x + 31, y + 34, 74, 120, 10);
          g.fillStyle(0x101b3a, 0.92);
          g.fillRoundedRect(x + 38, y + 42, 60, 104, 8);
          for (let i = 0; i < 6; i += 1) {
            const alpha = 0.18 + i * 0.055;
            g.lineStyle(2, i % 2 === 0 ? 0x2cf8ff : 0xff2bd6, alpha);
            g.lineBetween(x + 46 + i * 4, y + 50, x + 84 - i * 2, y + 140);
          }
          for (let i = 0; i < 7; i += 1) {
            g.fillStyle(i % 2 === 0 ? 0x2cf8ff : 0xff2bd6, 0.42);
            g.fillCircle(x + 52 + (i % 3) * 14, y + 55 + i * 13, 2.5);
          }
          g.lineStyle(5, 0x2cf8ff, 0.78);
          g.strokeRoundedRect(x + 14, y + 16, 108, 156, 12);
          g.lineStyle(3, 0xff2bd6, 0.5);
          g.strokeRoundedRect(x + 26, y + 28, 84, 132, 10);
          for (let i = 0; i < 4; i += 1) {
            g.lineStyle(2, 0x2cf8ff, 0.28 - i * 0.04);
            g.strokeRoundedRect(x + 5 - i * 7, y + 5 - i * 7, 126 + i * 14, 178 + i * 14, 16);
          }
          g.fillStyle(0xf8fbff, 0.74);
          g.fillCircle(x + 104, y + 100, 5);
          g.fillStyle(0x2cf8ff, 0.3);
          g.fillRoundedRect(x + 18, y + 188, 100, 12, 6);
          g.fillStyle(0xff2bd6, 0.24);
          g.fillRoundedRect(x + 34, y + 204, 68, 8, 4);
          g.fillStyle(0xffae00, 0.5);
          g.fillTriangle(x + 68, y + 183, x + 58, y + 170, x + 78, y + 170);
        }

        private drawParkPortal(g: any, x: number, y: number, flip = false) {
          const accent = 0x78ff9a;
          const secondary = 0x2cf8ff;
          g.fillStyle(0x02050a, 0.86);
          g.fillEllipse(x + 72, y + 196, 168, 34);
          for (let i = 0; i < 4; i += 1) {
            g.lineStyle(3, i % 2 === 0 ? accent : secondary, 0.2 - i * 0.028);
            g.strokeRoundedRect(x - i * 9, y - i * 7, 144 + i * 18, 202 + i * 14, 34);
          }
          g.fillStyle(0x061018, 0.98);
          g.fillRoundedRect(x + 8, y + 8, 128, 184, 28);
          g.fillStyle(0x10242a, 0.94);
          g.fillRoundedRect(x + 21, y + 22, 102, 158, 24);
          g.fillStyle(0x78ff9a, 0.12);
          g.fillRoundedRect(x + 32, y + 34, 80, 136, 22);
          for (let i = 0; i < 5; i += 1) {
            const offset = flip ? -i * 7 : i * 7;
            g.lineStyle(2, i % 2 === 0 ? accent : secondary, 0.28 + i * 0.04);
            g.lineBetween(x + 44 + offset, y + 48, x + 96 - offset * 0.4, y + 158);
          }
          g.lineStyle(5, accent, 0.72);
          g.strokeRoundedRect(x + 18, y + 18, 108, 164, 26);
          g.lineStyle(2, secondary, 0.5);
          g.strokeRoundedRect(x + 32, y + 34, 80, 132, 22);
          g.fillStyle(0xf8fbff, 0.8);
          g.fillCircle(x + (flip ? 42 : 103), y + 104, 4);
          g.fillStyle(accent, 0.32);
          g.fillRoundedRect(x + 24, y + 188, 96, 10, 5);
          g.fillStyle(secondary, 0.22);
          g.fillRoundedRect(x + 42, y + 202, 60, 7, 4);
        }

        private drawSkylineWindow(g: any, x: number, y: number, width: number, height: number) {
          g.fillStyle(0x050817, 1);
          g.fillRoundedRect(x, y, width, height, 18);
          g.fillStyle(0x07142c, 1);
          g.fillRoundedRect(x + 12, y + 12, width - 24, height - 24, 14);
          g.lineStyle(4, 0x2cf8ff, 0.32);
          g.strokeRoundedRect(x, y, width, height, 18);
          g.lineStyle(2, 0xff2bd6, 0.18);
          g.lineBetween(x + 40, y + height - 38, x + width - 40, y + height - 38);
          g.fillStyle(0xff2bd6, 0.14);
          g.fillCircle(x + width * 0.68, y + 74, 42);
          g.fillStyle(0x2cf8ff, 0.08);
          g.fillCircle(x + width * 0.25, y + 92, 62);
          for (let tower = 0; tower < 17; tower += 1) {
            const towerX = x + 54 + tower * ((width - 120) / 16);
            const towerW = 34 + (tower % 4) * 9;
            const towerH = 62 + (tower % 5) * 28;
            const baseY = y + height - 42;
            g.fillStyle(tower % 2 === 0 ? 0x070a18 : 0x0b1024, 0.96);
            g.fillRect(towerX, baseY - towerH, towerW, towerH);
            for (let row = 0; row < Math.floor(towerH / 18); row += 1) {
              for (let col = 0; col < Math.max(1, Math.floor(towerW / 13)); col += 1) {
                const lit = (tower + row + col) % 3 !== 0;
                g.fillStyle(lit ? 0x2cf8ff : 0x17213c, lit ? 0.52 : 0.32);
                g.fillRoundedRect(towerX + 6 + col * 13, baseY - towerH + 10 + row * 17, 7, 6, 2);
              }
            }
          }
          g.fillStyle(0x000000, 0.2);
          g.fillRect(x + 18, y + height - 54, width - 36, 32);
        }

        private drawSkywalkWorld(g: any) {
          const range = roomFloorRange(QORTAL_LAND_SKYWALK_ROOM_ID);
          g.fillStyle(0x050714, 1);
          g.fillRect(0, 0, LAND_WIDTH, LAND_HEIGHT);
          g.fillStyle(0x0c1226, 1);
          g.fillRect(0, 0, LAND_WIDTH, range.top);
          this.drawSkylineWindow(g, 64, 42, LAND_WIDTH - 128, 238);
          g.fillStyle(0x050711, 1);
          g.fillPoints([
            new Phaser.Geom.Point(128, range.top),
            new Phaser.Geom.Point(1672, range.top),
            new Phaser.Geom.Point(1650, range.bottom),
            new Phaser.Geom.Point(150, range.bottom),
          ], true);
          g.fillStyle(0x10172d, 0.86);
          g.fillPoints([
            new Phaser.Geom.Point(150, range.top + 26),
            new Phaser.Geom.Point(1650, range.top + 26),
            new Phaser.Geom.Point(1605, range.bottom - 18),
            new Phaser.Geom.Point(195, range.bottom - 18),
          ], true);
          g.lineStyle(3, 0x2cf8ff, 0.22);
          g.strokePoints([
            new Phaser.Geom.Point(128, range.top),
            new Phaser.Geom.Point(1672, range.top),
            new Phaser.Geom.Point(1650, range.bottom),
            new Phaser.Geom.Point(150, range.bottom),
            new Phaser.Geom.Point(128, range.top),
          ], false);
          for (let i = 0; i < 6; i += 1) {
            const y = range.top + 56 + i * 44;
            const bounds = floorBoundsForRoomY(QORTAL_LAND_SKYWALK_ROOM_ID, y);
            g.lineStyle(1, 0xffffff, 0.035);
            g.lineBetween(bounds.minX + 50, y, bounds.maxX - 50, y);
          }
          g.fillStyle(0x050711, 1);
          g.fillRoundedRect(132, 292, 150, 118, 14);
          g.lineStyle(3, 0xff2bd6, 0.4);
          g.strokeRoundedRect(132, 292, 150, 118, 14);
          g.fillStyle(0x2cf8ff, 0.1);
          g.fillRoundedRect(154, 316, 106, 52, 10);
          g.fillStyle(0xf8fbff, 0.8);
          g.fillCircle(244, 352, 4);
          this.drawParkPortal(g, 1518, 250, true);
          this.drawEscalator(g, LAND_WIDTH / 2, 560, false);
          g.fillStyle(0xffae00, 0.08);
          g.fillEllipse(LAND_WIDTH / 2, 586, 360, 82);
        }

        private drawMallWorld(g: any) {
          const range = roomFloorRange(QORTAL_LAND_MALL_ROOM_ID);
          g.fillStyle(0x060811, 1);
          g.fillRect(0, 0, LAND_WIDTH, LAND_HEIGHT);
          g.fillStyle(0x10182a, 1);
          g.fillRect(0, 0, LAND_WIDTH, range.top);
          g.fillStyle(0x050711, 1);
          g.fillPoints([
            new Phaser.Geom.Point(150, range.top),
            new Phaser.Geom.Point(1650, range.top),
            new Phaser.Geom.Point(1730, range.bottom),
            new Phaser.Geom.Point(70, range.bottom),
          ], true);
          g.fillStyle(0x0d1222, 1);
          g.fillPoints([
            new Phaser.Geom.Point(190, range.top + 42),
            new Phaser.Geom.Point(1610, range.top + 42),
            new Phaser.Geom.Point(1665, range.bottom - 12),
            new Phaser.Geom.Point(135, range.bottom - 12),
          ], true);
          g.lineStyle(3, 0x2cf8ff, 0.16);
          g.strokePoints([
            new Phaser.Geom.Point(150, range.top),
            new Phaser.Geom.Point(1650, range.top),
            new Phaser.Geom.Point(1730, range.bottom),
            new Phaser.Geom.Point(70, range.bottom),
            new Phaser.Geom.Point(150, range.top),
          ], false);
          for (let row = 0; row < 5; row += 1) {
            const y = range.top + 74 + row * 58;
            const bounds = floorBoundsForRoomY(QORTAL_LAND_MALL_ROOM_ID, y);
            g.lineStyle(1, 0xffffff, 0.035);
            g.lineBetween(bounds.minX + 60, y, bounds.maxX - 60, y + 2);
          }
          this.drawEscalator(g, LAND_WIDTH / 2, 360, true);
          this.drawCinemaStorefront(g, 480, 132, 840, 210);
          g.fillStyle(0x2cf8ff, 0.05);
          g.fillEllipse(900, 585, 840, 120);
        }

        private drawParkWorld(g: any) {
          const range = roomFloorRange(QORTAL_LAND_PARK_ROOM_ID);
          g.fillStyle(0x030711, 1);
          g.fillRect(0, 0, LAND_WIDTH, LAND_HEIGHT);
          g.fillStyle(0x071329, 1);
          g.fillRect(0, 0, LAND_WIDTH, range.top + 18);

          g.fillStyle(0x14224a, 0.62);
          g.fillCircle(1390, 92, 58);
          g.fillStyle(0x78ff9a, 0.08);
          g.fillCircle(1390, 92, 86);
          g.fillStyle(0xff2bd6, 0.08);
          g.fillCircle(430, 154, 72);

          for (let i = 0; i < 18; i += 1) {
            const towerX = 70 + i * 96;
            const towerW = 44 + (i % 4) * 14;
            const towerH = 64 + (i % 6) * 22;
            const baseY = range.top + 12;
            g.fillStyle(i % 2 === 0 ? 0x070d1d : 0x091225, 0.92);
            g.fillRect(towerX, baseY - towerH, towerW, towerH);
            for (let row = 0; row < Math.floor(towerH / 22); row += 1) {
              for (let col = 0; col < Math.max(1, Math.floor(towerW / 18)); col += 1) {
                const lit = (i + row + col) % 4 !== 0;
                g.fillStyle(lit ? 0x2cf8ff : 0x17213c, lit ? 0.38 : 0.22);
                g.fillRoundedRect(towerX + 10 + col * 17, baseY - towerH + 14 + row * 20, 8, 7, 2);
              }
            }
          }

          g.fillStyle(0x07180f, 1);
          g.fillPoints([
            new Phaser.Geom.Point(110, range.top),
            new Phaser.Geom.Point(1690, range.top),
            new Phaser.Geom.Point(1776, range.bottom),
            new Phaser.Geom.Point(24, range.bottom),
          ], true);
          g.fillStyle(0x102a18, 0.95);
          g.fillPoints([
            new Phaser.Geom.Point(150, range.top + 38),
            new Phaser.Geom.Point(1650, range.top + 38),
            new Phaser.Geom.Point(1714, range.bottom - 10),
            new Phaser.Geom.Point(86, range.bottom - 10),
          ], true);

          g.fillStyle(0x06110d, 0.95);
          g.fillPoints([
            new Phaser.Geom.Point(520, range.top + 34),
            new Phaser.Geom.Point(710, range.top + 34),
            new Phaser.Geom.Point(1080, range.bottom - 14),
            new Phaser.Geom.Point(830, range.bottom - 14),
          ], true);
          g.fillStyle(0x203723, 0.85);
          g.fillPoints([
            new Phaser.Geom.Point(552, range.top + 50),
            new Phaser.Geom.Point(688, range.top + 50),
            new Phaser.Geom.Point(1028, range.bottom - 26),
            new Phaser.Geom.Point(868, range.bottom - 26),
          ], true);

          g.lineStyle(4, 0x78ff9a, 0.18);
          g.strokePoints([
            new Phaser.Geom.Point(110, range.top),
            new Phaser.Geom.Point(1690, range.top),
            new Phaser.Geom.Point(1776, range.bottom),
            new Phaser.Geom.Point(24, range.bottom),
            new Phaser.Geom.Point(110, range.top),
          ], false);

          g.fillStyle(0x2cf8ff, 0.12);
          g.fillEllipse(1220, 560, 340, 110);
          g.fillStyle(0x071922, 0.96);
          g.fillEllipse(1220, 560, 290, 82);
          g.lineStyle(3, 0x2cf8ff, 0.34);
          g.strokeEllipse(1220, 560, 290, 82);
          g.fillStyle(0xf8fbff, 0.24);
          g.fillEllipse(1174, 540, 72, 12);
          g.fillStyle(0x78ff9a, 0.16);
          g.fillCircle(1220, 536, 34);

          this.drawParkPortal(g, 126, 250);
          this.drawParkTree(g, 310, 386, 0x78ff9a);
          this.drawParkTree(g, 1510, 388, 0x2cf8ff);
          this.drawParkTree(g, 420, 596, 0x78ff9a);
          this.drawParkTree(g, 1470, 616, 0xff2bd6);
          this.drawParkBench(g, 600, 482, 0x2cf8ff);
          this.drawParkBench(g, 1330, 462, 0xffae00);
          this.drawParkBench(g, 720, 642, 0x78ff9a);
        }

        private drawParkTree(g: any, x: number, y: number, color: number) {
          g.fillStyle(0x02040a, 0.35);
          g.fillEllipse(x, y + 62, 128, 28);
          g.fillStyle(0x1b1020, 1);
          g.fillRoundedRect(x - 13, y + 8, 26, 86, 10);
          g.fillStyle(color, 0.16);
          g.fillCircle(x, y, 64);
          g.fillStyle(color, 0.22);
          g.fillCircle(x - 34, y + 20, 42);
          g.fillCircle(x + 34, y + 20, 42);
          g.fillStyle(0x07180f, 0.96);
          g.fillCircle(x, y + 10, 46);
          g.lineStyle(2, color, 0.42);
          g.strokeCircle(x, y + 10, 46);
          g.fillStyle(color, 0.48);
          g.fillCircle(x + 30, y - 10, 5);
          g.fillCircle(x - 24, y + 22, 4);
        }

        private drawParkBench(g: any, x: number, y: number, color: number) {
          g.fillStyle(0x02040a, 0.32);
          g.fillEllipse(x + 82, y + 52, 190, 24);
          g.fillStyle(0x070914, 0.98);
          g.fillRoundedRect(x, y, 164, 32, 10);
          g.fillStyle(0x11182b, 1);
          g.fillRoundedRect(x + 12, y + 8, 140, 14, 7);
          g.lineStyle(3, color, 0.42);
          g.strokeRoundedRect(x, y, 164, 32, 10);
          g.fillStyle(color, 0.28);
          g.fillRoundedRect(x + 22, y + 36, 120, 12, 6);
          g.fillStyle(0x050711, 1);
          g.fillRoundedRect(x + 28, y + 26, 14, 38, 5);
          g.fillRoundedRect(x + 122, y + 26, 14, 38, 5);
        }

        private drawEscalator(g: any, centerX: number, centerY: number, up: boolean) {
          const topY = centerY - 92;
          const bottomY = centerY + 112;
          const topHalf = up ? 120 : 92;
          const bottomHalf = up ? 72 : 150;
          g.fillStyle(0x02040b, 0.62);
          g.fillEllipse(centerX, bottomY + 30, 360, 48);
          g.fillStyle(0x070a17, 0.98);
          g.fillPoints([
            new Phaser.Geom.Point(centerX - topHalf, topY),
            new Phaser.Geom.Point(centerX + topHalf, topY),
            new Phaser.Geom.Point(centerX + bottomHalf, bottomY),
            new Phaser.Geom.Point(centerX - bottomHalf, bottomY),
          ], true);
          g.fillStyle(0x121a30, 1);
          g.fillPoints([
            new Phaser.Geom.Point(centerX - topHalf + 28, topY + 18),
            new Phaser.Geom.Point(centerX + topHalf - 28, topY + 18),
            new Phaser.Geom.Point(centerX + bottomHalf - 26, bottomY - 18),
            new Phaser.Geom.Point(centerX - bottomHalf + 26, bottomY - 18),
          ], true);
          g.lineStyle(5, 0x2cf8ff, 0.34);
          g.lineBetween(centerX - topHalf, topY, centerX - bottomHalf, bottomY);
          g.lineBetween(centerX + topHalf, topY, centerX + bottomHalf, bottomY);
          for (let i = 0; i < 7; i += 1) {
            const t = i / 6;
            const y = topY + 32 + t * (bottomY - topY - 64);
            const half = topHalf + (bottomHalf - topHalf) * t - 38;
            g.lineStyle(2, 0xffffff, 0.08);
            g.lineBetween(centerX - half, y, centerX + half, y);
          }
          g.fillStyle(0xffae00, 0.18);
          g.fillRoundedRect(centerX - 92, topY - 34, 184, 24, 10);
          g.lineStyle(2, 0xffae00, 0.42);
          g.strokeRoundedRect(centerX - 92, topY - 34, 184, 24, 10);
        }

        private drawCinemaStorefront(g: any, x: number, y: number, width: number, height: number) {
          g.fillStyle(0x03040b, 1);
          g.fillRoundedRect(x, y, width, height, 18);
          g.fillStyle(0x0d1022, 1);
          g.fillRoundedRect(x + 24, y + 26, width - 48, height - 52, 16);
          g.lineStyle(5, 0xff2bd6, 0.52);
          g.strokeRoundedRect(x, y, width, height, 18);
          g.lineStyle(3, 0x2cf8ff, 0.38);
          g.strokeRoundedRect(x + 24, y + 26, width - 48, height - 52, 16);
          g.fillStyle(0x050711, 1);
          g.fillRoundedRect(x + 82, y + 60, width - 164, 72, 14);
          g.lineStyle(2, 0xffae00, 0.62);
          g.strokeRoundedRect(x + 82, y + 60, width - 164, 72, 14);
          g.fillStyle(0x2cf8ff, 1);
          g.fillRoundedRect(x + 204, y + 82, 22, 30, 5);
          g.fillRoundedRect(x + 234, y + 82, 22, 30, 5);
          g.fillStyle(0xff2bd6, 1);
          g.fillRoundedRect(x + 282, y + 82, 22, 30, 5);
          g.fillRoundedRect(x + 312, y + 82, 88, 10, 5);
          g.fillRoundedRect(x + 312, y + 102, 62, 10, 5);
          g.fillStyle(0xffae00, 1);
          g.fillRoundedRect(x + 428, y + 82, 84, 10, 5);
          g.fillRoundedRect(x + 428, y + 102, 84, 10, 5);
          g.fillStyle(0x050711, 1);
          g.fillRoundedRect(x + width / 2 - 88, y + height - 62, 176, 62, 14);
          g.lineStyle(2, 0xffffff, 0.1);
          g.lineBetween(x + width / 2, y + height - 58, x + width / 2, y + height - 4);
          for (let i = 0; i < 10; i += 1) {
            g.fillStyle(i % 2 === 0 ? 0xffae00 : 0x2cf8ff, 0.72);
            g.fillCircle(x + 70 + i * 78, y + 26, 6);
          }
        }

        private drawBooth(g: any, x: number, y: number, color: number) {
          g.fillStyle(0x03040c, 0.35);
          g.fillEllipse(x + 126, y + 85, 250, 42);
          g.fillStyle(0x090b16, 1);
          g.fillRoundedRect(x, y, 250, 88, 18);
          g.fillStyle(0x040611, 0.96);
          g.fillPoints([
            new Phaser.Geom.Point(x + 12, y + 60),
            new Phaser.Geom.Point(x + 238, y + 60),
            new Phaser.Geom.Point(x + 216, y + 104),
            new Phaser.Geom.Point(x + 34, y + 104),
          ], true);
          g.fillStyle(0x11172d, 1);
          g.fillRoundedRect(x + 8, y + 8, 234, 70, 16);
          g.fillStyle(0x151b35, 1);
          g.fillRoundedRect(x + 18, y + 15, 214, 45, 14);
          g.fillStyle(0x080a14, 1);
          g.fillRoundedRect(x + 58, y + 42, 134, 34, 10);
          g.lineStyle(4, color, 0.55);
          g.strokeRoundedRect(x + 14, y + 12, 222, 54, 16);
          g.fillStyle(color, 0.18);
          g.fillRoundedRect(x + 28, y + 72, 194, 16, 8);
          g.lineStyle(2, 0xffffff, 0.08);
          g.lineBetween(x + 24, y + 22, x + 226, y + 22);
        }

        private drawBottleShelf(g: any, x: number, y: number, width: number) {
          g.fillStyle(0x050611, 0.94);
          g.fillRoundedRect(x, y, width, 86, 12);
          g.lineStyle(2, 0x2cf8ff, 0.12);
          g.strokeRoundedRect(x, y, width, 86, 12);
          for (let row = 0; row < 2; row += 1) {
            g.lineStyle(1, 0xffffff, 0.045);
            g.lineBetween(x + 16, y + 30 + row * 32, x + width - 16, y + 30 + row * 32);
            for (let col = 0; col < 13; col += 1) {
              const bottleX = x + 24 + col * ((width - 48) / 12);
              const bottleColor = col % 3 === 0 ? 0xff2bd6 : col % 3 === 1 ? 0x2cf8ff : 0xffae00;
              g.fillStyle(bottleColor, 0.36);
              g.fillRoundedRect(bottleX, y + 13 + row * 32, 10, 22, 3);
              g.fillStyle(0xffffff, 0.08);
              g.fillRoundedRect(bottleX + 2, y + 16 + row * 32, 3, 12, 2);
            }
          }
        }

        private drawSpeakerStack(g: any, x: number, y: number, accent: number) {
          g.fillStyle(0x03040b, 0.98);
          g.fillRoundedRect(x, y, 76, 126, 10);
          g.lineStyle(2, accent, 0.25);
          g.strokeRoundedRect(x, y, 76, 126, 10);
          for (let i = 0; i < 3; i += 1) {
            const cy = y + 27 + i * 36;
            g.fillStyle(0x10162a, 1);
            g.fillCircle(x + 38, cy, 18);
            g.lineStyle(1, accent, 0.24);
            g.strokeCircle(x + 38, cy, 13);
            g.fillStyle(accent, 0.1);
            g.fillCircle(x + 38, cy, 7);
          }
        }

        private drawFloorPlanter(g: any, x: number, y: number, color: number) {
          g.fillStyle(0x03040c, 0.34);
          g.fillEllipse(x, y + 44, 102, 24);
          g.fillStyle(0x070a14, 1);
          g.fillRoundedRect(x - 32, y + 18, 64, 42, 10);
          g.lineStyle(2, color, 0.24);
          g.strokeRoundedRect(x - 32, y + 18, 64, 42, 10);
          for (let i = -2; i <= 2; i += 2) {
            g.lineStyle(4, i % 2 === 0 ? 0x2cf8ff : 0xff2bd6, 0.22);
            g.lineBetween(x, y + 24, x + i * 18, y - 18 - Math.abs(i) * 5);
          }
        }

        private drawDanceFloor(g: any) {
          const centerX = LAND_WIDTH / 2;
          const top = 430;
          const bottom = 645;
          g.fillStyle(0x02040b, 0.45);
          g.fillPoints([
            new Phaser.Geom.Point(centerX - 455, bottom),
            new Phaser.Geom.Point(centerX + 455, bottom),
            new Phaser.Geom.Point(centerX + 405, bottom + 34),
            new Phaser.Geom.Point(centerX - 405, bottom + 34),
          ], true);
          g.fillStyle(0x0a0d19, 0.96);
          g.fillPoints([
            new Phaser.Geom.Point(centerX - 315, top),
            new Phaser.Geom.Point(centerX + 315, top),
            new Phaser.Geom.Point(centerX + 455, bottom),
            new Phaser.Geom.Point(centerX - 455, bottom),
          ], true);
          for (let row = 0; row < 5; row += 1) {
            for (let col = 0; col < 9; col += 1) {
              const hue = (row * 42 + col * 24) % 360;
              const color = Phaser.Display.Color.HSLToColor(hue / 360, 0.9, 0.55).color;
              const rowY = top + 18 + row * 38;
              const rowWidth = 540 + row * 42;
              const cellW = rowWidth / 9 - 8;
              const startX = centerX - rowWidth / 2 + col * (rowWidth / 9);
              g.fillStyle(color, 0.1 + ((row + col) % 2) * 0.07);
              const skew = row * 5;
              g.fillPoints([
                new Phaser.Geom.Point(startX + skew, rowY),
                new Phaser.Geom.Point(startX + cellW + skew, rowY),
                new Phaser.Geom.Point(startX + cellW + skew + 6, rowY + 26),
                new Phaser.Geom.Point(startX + skew - 6, rowY + 26),
              ], true);
            }
          }
          g.lineStyle(3, 0xff2bd6, 0.32);
          g.strokePoints([
            new Phaser.Geom.Point(centerX - 315, top),
            new Phaser.Geom.Point(centerX + 315, top),
            new Phaser.Geom.Point(centerX + 455, bottom),
            new Phaser.Geom.Point(centerX - 455, bottom),
            new Phaser.Geom.Point(centerX - 315, top),
          ], false);
        }

        private drawBarDetails(g: any) {
          g.fillStyle(0x02030a, 0.4);
          g.fillEllipse(900, 390, 950, 62);
          g.fillStyle(0x03040b, 1);
          g.fillPoints([
            new Phaser.Geom.Point(420, 338),
            new Phaser.Geom.Point(1380, 338),
            new Phaser.Geom.Point(1330, 400),
            new Phaser.Geom.Point(470, 400),
          ], true);
          g.lineStyle(2, 0x2cf8ff, 0.12);
          g.lineBetween(470, 400, 1330, 400);
          g.fillStyle(0x050611, 0.98);
          g.fillRoundedRect(420, 314, 960, 54, 14);
          g.fillStyle(0x11172d, 1);
          g.fillRoundedRect(452, 324, 896, 30, 10);
          g.lineStyle(3, 0xff2bd6, 0.34);
          g.strokeRoundedRect(420, 314, 960, 54, 14);
          for (let x = 448; x <= 1320; x += 96) {
            g.fillStyle(0x050611, 0.95);
            g.fillRoundedRect(x, 336, 34, 46, 8);
            g.fillStyle(x % 192 === 0 ? 0xff2bd6 : 0x2cf8ff, 0.46);
            g.fillCircle(x + 17, 332, 10);
          }
          this.drawBottleShelf(g, 540, 178, 720);
        }

        private drawDepthProps() {
          const barLayer = this.createPropLayer(370);
          this.drawBarDetails(barLayer);

          const backLeftBooth = this.createPropLayer(480);
          this.drawBooth(backLeftBooth, 170, 390, 0xff2bd6);
          const backRightBooth = this.createPropLayer(480);
          this.drawBooth(backRightBooth, 1360, 390, 0x2cf8ff);

          const midProps = this.createPropLayer(545);
          this.drawFloorPlanter(midProps, 1480, 520, 0x9a5cff);
          this.drawFloorPlanter(midProps, 320, 520, 0xffae00);

          const frontLeftBooth = this.createPropLayer(665);
          this.drawBooth(frontLeftBooth, 300, 570, 0x9a5cff);
          const frontRightBooth = this.createPropLayer(665);
          this.drawBooth(frontRightBooth, 1220, 570, 0xffae00);

          const speakerLayer = this.createPropLayer(620);
          this.drawSpeakerStack(speakerLayer, 118, 540, 0x2cf8ff);
          this.drawSpeakerStack(speakerLayer, 1606, 540, 0xff2bd6);
        }

        private drawSkywalkDepthProps() {
          const railLayer = this.createPropLayer(410);
          railLayer.fillStyle(0x02040a, 0.72);
          railLayer.fillRoundedRect(180, 382, 1440, 38, 16);
          railLayer.lineStyle(3, 0x2cf8ff, 0.24);
          railLayer.lineBetween(205, 392, 1595, 392);
          for (let x = 240; x <= 1560; x += 120) {
            railLayer.fillStyle(0x2cf8ff, 0.2);
            railLayer.fillRoundedRect(x, 398, 10, 42, 5);
          }
          const kioskLayer = this.createPropLayer(610);
          this.drawBooth(kioskLayer, 1225, 545, 0x2cf8ff);
          this.drawFloorPlanter(kioskLayer, 380, 560, 0xff2bd6);
        }

        private drawMallDepthProps() {
          const signLayer = this.createPropLayer(360);
          signLayer.fillStyle(0x050711, 0.9);
          signLayer.fillRoundedRect(300, 368, 260, 86, 16);
          signLayer.lineStyle(3, 0xffae00, 0.4);
          signLayer.strokeRoundedRect(300, 368, 260, 86, 16);
          signLayer.fillStyle(0xffae00, 0.46);
          signLayer.fillRoundedRect(332, 394, 128, 10, 5);
          signLayer.fillRoundedRect(332, 418, 88, 8, 4);
          const loungeLayer = this.createPropLayer(650);
          this.drawBooth(loungeLayer, 210, 585, 0x2cf8ff);
          this.drawBooth(loungeLayer, 1330, 585, 0xff2bd6);
        }

        private drawParkDepthProps() {
          const railLayer = this.createPropLayer(365);
          railLayer.fillStyle(0x02040a, 0.44);
          railLayer.fillRoundedRect(260, 342, 1280, 24, 12);
          railLayer.lineStyle(3, 0x78ff9a, 0.2);
          railLayer.lineBetween(292, 354, 1508, 354);
          for (let x = 340; x <= 1460; x += 140) {
            railLayer.fillStyle(0x78ff9a, 0.2);
            railLayer.fillRoundedRect(x, 360, 9, 32, 5);
          }

          const midLayer = this.createPropLayer(520);
          this.drawParkBench(midLayer, 245, 468, 0x2cf8ff);
          this.drawParkTree(midLayer, 1580, 490, 0x78ff9a);

          const frontLayer = this.createPropLayer(682);
          this.drawParkTree(frontLayer, 250, 638, 0x2cf8ff);
          this.drawParkTree(frontLayer, 1605, 650, 0x78ff9a);
          this.drawParkBench(frontLayer, 1110, 652, 0xff2bd6);
        }

        private drawLightBeams(g: any) {
          g.fillStyle(0x2cf8ff, 0.032);
          g.fillTriangle(250, 75, 640, FLOOR_BOTTOM_Y, 860, FLOOR_BOTTOM_Y);
          g.fillStyle(0xff2bd6, 0.032);
          g.fillTriangle(1540, 80, 950, FLOOR_BOTTOM_Y, 1190, FLOOR_BOTTOM_Y);
          g.fillStyle(0xffae00, 0.024);
          g.fillTriangle(900, 40, 720, FLOOR_BOTTOM_Y, 1080, FLOOR_BOTTOM_Y);
        }

        private drawForeground(g: any) {
          const roomId = currentRoomRef.current;
          const range = roomFloorRange(roomId);
          g.fillStyle(0x050611, 0.82);
          g.fillRoundedRect(120, range.bottom + 6, LAND_WIDTH - 240, 46, 18);
          const color =
            roomId === QORTAL_LAND_MALL_ROOM_ID
              ? 0x2cf8ff
              : roomId === QORTAL_LAND_PARK_ROOM_ID
                ? 0x78ff9a
                : 0xff2bd6;
          g.lineStyle(3, color, 0.2);
          g.lineBetween(150, range.bottom + 12, LAND_WIDTH - 150, range.bottom + 12);
        }

        private animateRoom(time: number) {
          if (!this.lightSweep) return;
          this.lightSweep.clear();
          const roomId = currentRoomRef.current;
          if (roomId === QORTAL_LAND_SKYWALK_ROOM_ID) {
            const pulse = 0.5 + Math.sin(time / 260) * 0.5;
            this.lightSweep.fillStyle(0x2cf8ff, 0.035 + pulse * 0.025);
            this.lightSweep.fillEllipse(900, 260, 1180, 58);
            this.lightSweep.fillStyle(0xff2bd6, 0.025);
            this.lightSweep.fillTriangle(250, 46, 850, 666, 1020, 666);
            return;
          }
          if (roomId === QORTAL_LAND_MALL_ROOM_ID) {
            const pulse = 0.5 + Math.sin(time / 220) * 0.5;
            this.lightSweep.fillStyle(0xffae00, 0.035 + pulse * 0.018);
            this.lightSweep.fillEllipse(900, 356, 600, 80);
            this.lightSweep.fillStyle(0x2cf8ff, 0.028);
            this.lightSweep.fillTriangle(900, 310, 560, 700, 1240, 700);
            return;
          }
          if (roomId === QORTAL_LAND_PARK_ROOM_ID) {
            const pulse = 0.5 + Math.sin(time / 360) * 0.5;
            this.lightSweep.fillStyle(0x78ff9a, 0.025 + pulse * 0.018);
            this.lightSweep.fillEllipse(1220, 560, 420, 120);
            this.lightSweep.fillStyle(0x2cf8ff, 0.022);
            this.lightSweep.fillTriangle(1388, 92, 1040, 704, 1420, 704);
            this.lightSweep.fillStyle(0xff2bd6, 0.018);
            this.lightSweep.fillEllipse(520, 470, 360, 70);
            return;
          }
          const sweepX = 260 + ((time / 18) % 1280);
          const pulse = 0.5 + Math.sin(time / 180) * 0.5;
          this.lightSweep.fillStyle(0x2cf8ff, 0.04);
          this.lightSweep.fillTriangle(sweepX - 90, 90, sweepX + 60, FLOOR_BOTTOM_Y, sweepX + 210, FLOOR_BOTTOM_Y);
          this.lightSweep.fillStyle(0xff2bd6, 0.035);
          this.lightSweep.fillTriangle(LAND_WIDTH - sweepX + 90, 95, LAND_WIDTH - sweepX - 90, FLOOR_BOTTOM_Y, LAND_WIDTH - sweepX - 260, FLOOR_BOTTOM_Y);
          this.lightSweep.fillStyle(0xff2bd6, 0.04 + pulse * 0.035);
          this.lightSweep.fillEllipse(LAND_WIDTH / 2, 540, 620 + pulse * 40, 190 + pulse * 22);
          this.lightSweep.fillStyle(0x2cf8ff, 0.055);
          for (let index = 0; index < 5; index += 1) {
            const angle = time / 520 + index * 0.9;
            const x = LAND_WIDTH / 2 + Math.cos(angle) * 330;
            const y = 520 + Math.sin(angle * 1.3) * 82;
            this.lightSweep.fillCircle(x, y, 12 + pulse * 8);
          }
        }

        private drawChatBubble(background: any, textObject: any) {
          const width = Math.min(250, Math.max(78, Math.ceil(textObject.width) + 28));
          const height = Math.max(34, Math.ceil(textObject.height) + 18);
          background.clear();
          background.fillStyle(0x070914, 0.88);
          background.fillRoundedRect(-width / 2, -height, width, height, 12);
          background.lineStyle(2, 0x2cf8ff, 0.68);
          background.strokeRoundedRect(-width / 2, -height, width, height, 12);
          background.fillStyle(0x070914, 0.88);
          background.fillTriangle(-9, 0, 9, 0, 0, 10);
          background.lineStyle(2, 0x2cf8ff, 0.42);
          background.lineBetween(-9, 0, 0, 10);
          background.lineBetween(9, 0, 0, 10);
          textObject.setPosition(-width / 2 + 14, -height + 9);
        }

        private createChatBubble(bubble: LandChatBubble) {
          const background = this.add.graphics();
          const textObject = this.add.text(0, 0, bubble.text, {
            align: 'center',
            color: '#f8fbff',
            fontFamily: 'Inter, Arial, sans-serif',
            fontSize: '13px',
            lineSpacing: 3,
            wordWrap: { width: 220, useAdvancedWrap: true },
          });
          const container = this.add.container(0, 0, [background, textObject]);
          container.setDepth(9999);
          this.drawChatBubble(background, textObject);
          return { container, background, text: textObject };
        }

        private removeChatBubble(
          messageId: string,
          bubbleObjects = this.chatBubbles.get(messageId)
        ) {
          if (!bubbleObjects) return;
          this.chatBubbles.delete(messageId);
          try {
            if (typeof bubbleObjects.container?.removeAll === 'function') {
              bubbleObjects.container.removeAll(true);
            }
            if (bubbleObjects.container?.scene) {
              bubbleObjects.container.destroy();
            }
          } catch (error) {
            console.warn('[QortalLand] Failed to remove chat bubble', error);
          }
        }

        private updateChatBubbles() {
          const now = Date.now();
          for (const [messageId, bubble] of landChatBubblesRef.current.entries()) {
            if (bubble.expiresAt > now) continue;
            landChatBubblesRef.current.delete(messageId);
          }
          for (const [messageId, bubbleObjects] of this.chatBubbles.entries()) {
            if (landChatBubblesRef.current.has(messageId)) continue;
            this.removeChatBubble(messageId, bubbleObjects);
          }
          for (const [messageId, bubble] of landChatBubblesRef.current.entries()) {
            let avatar: any | undefined;
            if (bubble.authorAddress === myAddress && bubble.sessionId === sessionId) {
              avatar = this.localAvatar;
            } else {
              avatar = this.remotes.get(`${bubble.authorAddress}:${bubble.sessionId}`);
            }
            let bubbleObjects = this.chatBubbles.get(messageId);
            if (!bubbleObjects) {
              bubbleObjects = this.createChatBubble(bubble);
              this.chatBubbles.set(messageId, bubbleObjects);
            }
            if (!avatar) {
              bubbleObjects.container.setVisible(false);
              continue;
            }
            if (bubbleObjects.text.text !== bubble.text) {
              bubbleObjects.text.setText(bubble.text);
              this.drawChatBubble(bubbleObjects.background, bubbleObjects.text);
            }
            const remainingMs = bubble.expiresAt - now;
            const fadeAlpha = Math.max(0, Math.min(1, remainingMs / 2000));
            const ageMs = now - bubble.createdAt;
            const rise = Math.min(12, ageMs / 700);
            const scale = Math.abs(avatar.scaleY || 1);
            bubbleObjects.container.setVisible(true);
            bubbleObjects.container.setPosition(avatar.x, avatar.y - LAND_CHARACTER_CHAT_BUBBLE_OFFSET * scale - rise);
            bubbleObjects.container.setAlpha(remainingMs < 2000 ? fadeAlpha : 1);
            bubbleObjects.container.setDepth(avatar.depth + 120);
          }
        }

        private createQortActionAnimation(animation: LandActionAnimation) {
          const container = this.add.container(0, 0);
          const glow = this.add.graphics();
          glow.fillStyle(0xffd65c, 0.2);
          glow.fillCircle(0, 0, 34);
          glow.lineStyle(2, 0xffd65c, 0.5);
          glow.strokeCircle(0, 0, 24);
          const text = this.add.text(0, -4, `+${formatQortAmount(animation.amount)} QORT`, {
            align: 'center',
            color: '#fff4c7',
            fontFamily: 'Inter, Arial, sans-serif',
            fontSize: '16px',
            fontWeight: '700',
            stroke: '#2a1600',
            strokeThickness: 5,
          }).setOrigin(0.5);
          const coins = Array.from({ length: 7 }, (_, index) => {
            const coin = this.add.graphics();
            coin.fillStyle(0xffc84a, 1);
            coin.fillCircle(0, 0, 5 + (index % 2));
            coin.lineStyle(1, 0xfff2a8, 0.86);
            coin.strokeCircle(0, 0, 5 + (index % 2));
            container.add(coin);
            return coin;
          });
          container.add([glow, text]);
          container.setDepth(12000);
          return { container, coins, text };
        }

        private removeActionAnimation(
          actionId: string,
          animationObjects = this.actionAnimations.get(actionId)
        ) {
          if (!animationObjects) return;
          this.actionAnimations.delete(actionId);
          try {
            if (typeof animationObjects.container?.removeAll === 'function') {
              animationObjects.container.removeAll(true);
            }
            if (animationObjects.container?.scene) {
              animationObjects.container.destroy();
            }
          } catch (error) {
            console.warn('[QortalLand] Failed to remove action animation', error);
          }
        }

        private updateActionAnimations() {
          const now = Date.now();
          for (const [actionId, animation] of landActionAnimationsRef.current.entries()) {
            if (animation.expiresAt > now) continue;
            landActionAnimationsRef.current.delete(actionId);
          }
          for (const [actionId, animationObjects] of this.actionAnimations.entries()) {
            if (landActionAnimationsRef.current.has(actionId)) continue;
            this.removeActionAnimation(actionId, animationObjects);
          }
          for (const [actionId, animation] of landActionAnimationsRef.current.entries()) {
            let avatar: any | undefined;
            if (animation.toAddress === myAddress && animation.targetSessionId === sessionId) {
              avatar = this.localAvatar;
            } else {
              avatar = this.remotes.get(`${animation.toAddress}:${animation.targetSessionId}`);
            }
            let animationObjects = this.actionAnimations.get(actionId);
            if (!animationObjects) {
              animationObjects = this.createQortActionAnimation(animation);
              this.actionAnimations.set(actionId, animationObjects);
            }
            if (!avatar || animation.roomId !== currentRoomRef.current) {
              animationObjects.container.setVisible(false);
              continue;
            }
            const ageMs = now - animation.createdAt;
            const progress = Phaser.Math.Clamp(ageMs / LAND_ACTION_ANIMATION_TTL_MS, 0, 1);
            const fadeAlpha = progress > 0.72 ? Phaser.Math.Clamp((1 - progress) / 0.28, 0, 1) : 1;
            const scale = Math.abs(avatar.scaleY || 1);
            const rise = 12 + progress * 46;
            animationObjects.container.setVisible(true);
            animationObjects.container.setAlpha(fadeAlpha);
            animationObjects.container.setPosition(avatar.x, avatar.y - LAND_CHARACTER_CHAT_BUBBLE_OFFSET * scale - rise);
            animationObjects.container.setDepth(avatar.depth + 180);
            animationObjects.text.setScale(1 + Math.sin(progress * Math.PI) * 0.08);
            animationObjects.coins.forEach((coin, index) => {
              const angle = progress * Math.PI * 2.5 + index * 0.9;
              const radius = 14 + progress * (28 + index * 2);
              coin.setPosition(Math.cos(angle) * radius, 10 + Math.sin(angle) * radius * 0.55);
              coin.setAlpha(fadeAlpha * (0.95 - progress * 0.25));
            });
          }
        }

        private createCallIndicator() {
          const container = this.add.container(0, 0);
          const badge = this.add.graphics();
          badge.fillStyle(0x020714, 0.82);
          badge.fillCircle(0, 0, 20);
          badge.fillStyle(0x2cf8ff, 0.95);
          badge.fillCircle(0, 0, 15);
          badge.lineStyle(2, 0xf8fbff, 0.86);
          badge.strokeCircle(0, 0, 15);
          badge.lineStyle(2, 0x2cf8ff, 0.28);
          badge.strokeCircle(0, 0, 22);
          const phone = this.add.text(0, -1, '☎', {
            align: 'center',
            color: '#06101d',
            fontFamily: 'Arial, sans-serif',
            fontSize: '20px',
            fontStyle: 'bold',
          }).setOrigin(0.5);
          container.add([badge, phone]);
          container.setDepth(13000);
          return { container, badge, phone };
        }

        private removeCallIndicator(
          indicatorKey: string,
          indicatorObjects = this.callIndicators.get(indicatorKey)
        ) {
          if (!indicatorObjects) return;
          this.callIndicators.delete(indicatorKey);
          try {
            if (typeof indicatorObjects.container?.removeAll === 'function') {
              indicatorObjects.container.removeAll(true);
            }
            if (indicatorObjects.container?.scene) {
              indicatorObjects.container.destroy();
            }
          } catch (error) {
            console.warn('[QortalLand] Failed to remove call indicator', error);
          }
        }

        private updateCallIndicators() {
          const now = Date.now();
          for (const [address, presence] of landCallPresenceRef.current.entries()) {
            if (presence.expiresAt > now) continue;
            landCallPresenceRef.current.delete(address);
          }

          const activeIndicators = new Map<string, { avatar: any; roomId: LandRoomId }>();
          const localPresence = landCallPresenceRef.current.get(myAddress);
          if (
            this.localAvatar &&
            localPresence &&
            localPresence.expiresAt > now &&
            localPresence.roomId === currentRoomRef.current
          ) {
            activeIndicators.set(`local:${myAddress}`, {
              avatar: this.localAvatar,
              roomId: localPresence.roomId,
            });
          }

          for (const [key, player] of remotePlayersRef.current.entries()) {
            const presence = landCallPresenceRef.current.get(player.authorAddress);
            const avatar = this.remotes.get(key);
            if (
              !presence ||
              presence.expiresAt <= now ||
              presence.roomId !== currentRoomRef.current ||
              player.roomId !== currentRoomRef.current ||
              !avatar
            ) {
              continue;
            }
            activeIndicators.set(`remote:${key}`, {
              avatar,
              roomId: presence.roomId,
            });
          }

          for (const [indicatorKey, indicatorObjects] of this.callIndicators.entries()) {
            if (activeIndicators.has(indicatorKey)) continue;
            this.removeCallIndicator(indicatorKey, indicatorObjects);
          }

          for (const [indicatorKey, { avatar }] of activeIndicators.entries()) {
            let indicatorObjects = this.callIndicators.get(indicatorKey);
            if (!indicatorObjects) {
              indicatorObjects = this.createCallIndicator();
              this.callIndicators.set(indicatorKey, indicatorObjects);
            }
            const scale = Math.abs(avatar.scaleY || 1);
            indicatorObjects.container.setVisible(true);
            indicatorObjects.container.setPosition(
              avatar.x + 36 * scale,
              avatar.y - (LAND_CHARACTER_LABEL_OFFSET + 28) * scale
            );
            indicatorObjects.container.setScale(Math.max(0.78, Math.min(1.04, scale * 0.9)));
            indicatorObjects.container.setAlpha(0.9 + Math.sin(this.time.now / 260) * 0.08);
            indicatorObjects.container.setDepth(avatar.depth + 220);
          }
        }

        private updateLocalPlayer(delta: number) {
          if (!this.localAvatar) return;
          const step = (190 * delta) / 1000;
          const pressedKeys = movementKeysRef.current;
          const left = pressedKeys.has('arrowleft') || pressedKeys.has('a');
          const right = pressedKeys.has('arrowright') || pressedKeys.has('d');
          const up = pressedKeys.has('arrowup') || pressedKeys.has('w');
          const down = pressedKeys.has('arrowdown') || pressedKeys.has('s');
          let x = this.localAvatar.x;
          let y = this.localAvatar.y;
          let direction = localStateRef.current.direction;
          if (left) {
            x -= step;
            direction = 'l';
          }
          if (right) {
            x += step;
            direction = 'r';
          }
          if (up) {
            y -= step;
          }
          if (down) {
            y += step;
          }
          if (!left && !right) {
            if (up) {
              direction = 'u';
            } else if (down) {
              direction = 'd';
            }
          }
          let roomId = currentRoomRef.current;
          ({ x, y } = clampLandPosition(roomId, x, y));
          const transition = this.getRoomTransition(roomId, x, y);
          if (transition) {
            roomId = transition.roomId;
            currentRoomRef.current = roomId;
            x = transition.x;
            y = transition.y;
            direction = transition.direction;
            movementKeysRef.current.clear();
            this.drawWorld();
          }
          const moving = Boolean(left || right || up || down);
          const scale = characterScaleForRoomY(roomId, y);
          const localLabelText = displayNameForAddress(myAddress, primaryNameCacheRef.current);
          if (this.localLabel?.text !== localLabelText) {
            this.localLabel?.setText(localLabelText);
          }
          this.localAvatar.setPosition(x, y);
          this.localAvatar.setScale(avatarScaleXForDirection(direction, scale), scale);
          this.animateAvatar(this.localAvatar, moving, direction);
          this.localLabel?.setPosition(x, y - LAND_CHARACTER_LABEL_OFFSET * scale);
          this.localAvatar.setDepth(y + 20);
          this.localLabel?.setDepth(y + 90);
          localStateRef.current = {
            roomId,
            x,
            y,
            direction,
            movement: moving ? 'walk' : 'idle',
          };
        }

        private getRoomTransition(
          roomId: LandRoomId,
          x: number,
          y: number
        ): { roomId: LandRoomId; x: number; y: number; direction: string } | null {
          if (
            roomId === QORTAL_LAND_DEFAULT_ROOM_ID &&
            x >= 1450 &&
            x <= 1645 &&
            y <= FLOOR_TOP_Y + 58
          ) {
            return { roomId: QORTAL_LAND_SKYWALK_ROOM_ID, x: 220, y: 430, direction: 'r' };
          }
          if (
            roomId === QORTAL_LAND_SKYWALK_ROOM_ID &&
            x >= 1548 &&
            y <= 466
          ) {
            return { roomId: QORTAL_LAND_PARK_ROOM_ID, x: 304, y: 500, direction: 'r' };
          }
          if (
            roomId === QORTAL_LAND_SKYWALK_ROOM_ID &&
            x >= 760 &&
            x <= 1040 &&
            y >= 526
          ) {
            return { roomId: QORTAL_LAND_MALL_ROOM_ID, x: 900, y: 565, direction: 'd' };
          }
          if (
            roomId === QORTAL_LAND_SKYWALK_ROOM_ID &&
            x <= 210 &&
            y <= 440
          ) {
            return { roomId: QORTAL_LAND_DEFAULT_ROOM_ID, x: 1545, y: FLOOR_TOP_Y + 72, direction: 'd' };
          }
          if (
            roomId === QORTAL_LAND_MALL_ROOM_ID &&
            x >= 760 &&
            x <= 1040 &&
            y <= 460
          ) {
            return { roomId: QORTAL_LAND_SKYWALK_ROOM_ID, x: 900, y: 470, direction: 'u' };
          }
          if (
            roomId === QORTAL_LAND_PARK_ROOM_ID &&
            x <= 232 &&
            y <= 470
          ) {
            return { roomId: QORTAL_LAND_SKYWALK_ROOM_ID, x: 1488, y: 492, direction: 'l' };
          }
          return null;
        }

        private updateRemotePlayers() {
          const now = Date.now();
          for (const [key, player] of remotePlayersRef.current.entries()) {
            if (now - player.lastSeenAt > LAND_REMOTE_TTL_MS) {
              remotePlayersRef.current.delete(key);
            }
          }
          for (const [key, avatar] of this.remotes.entries()) {
            const player = remotePlayersRef.current.get(key);
            if (player && player.roomId === currentRoomRef.current) continue;
            avatar.destroy(true);
            this.remotes.delete(key);
            this.remoteLabels.get(key)?.destroy();
            this.remoteLabels.delete(key);
          }
          let remoteIndex = 0;
          for (const [key, player] of remotePlayersRef.current.entries()) {
            if (player.roomId !== currentRoomRef.current) continue;
            let avatar = this.remotes.get(key);
            if (!avatar) {
              const scale = characterScaleForRoomY(player.roomId, player.y);
              const color = Phaser.Display.Color.HSLToColor(
                ((remoteHueBase + remoteIndex * 37) % 360) / 360,
                0.6,
                0.56
              ).color;
              avatar = this.createAvatar(player.x, player.y, color, false);
              avatar.setInteractive({
                alphaTolerance: 8,
                pixelPerfect: true,
                useHandCursor: true,
              });
              avatar.on('pointerdown', (pointer: any, _localX: number, _localY: number, event: any) => {
                event?.stopPropagation?.();
                const bounds = containerRef.current?.getBoundingClientRect();
                if (!bounds) return;
                const pointerEvent = pointer?.event as PointerEvent | undefined;
                const menuX = clampNumber(
                  (pointerEvent?.clientX ?? bounds.left + bounds.width / 2) - bounds.left,
                  12,
                  Math.max(12, bounds.width - 236)
                );
                const menuY = clampNumber(
                  (pointerEvent?.clientY ?? bounds.top + bounds.height / 2) - bounds.top,
                  54,
                  Math.max(54, bounds.height - 148)
                );
                setActionTarget({
                  key,
                  authorAddress: player.authorAddress,
                  sessionId: player.sessionId,
                  roomId: player.roomId,
                  menuX,
                  menuY,
                });
              });
              this.remotes.set(key, avatar);
              const label = this.add
                .text(
                  player.x,
                  player.y - LAND_CHARACTER_LABEL_OFFSET * scale,
                  displayNameForAddress(player.authorAddress, primaryNameCacheRef.current),
                  {
                    color: '#f8fbff',
                    fontFamily: 'Inter, Arial, sans-serif',
                    fontSize: '12px',
                    stroke: '#10151c',
                    strokeThickness: 4,
                  }
                )
                .setOrigin(0.5);
              this.remoteLabels.set(key, label);
            }
            const elapsedSinceUpdate = now - player.receivedAt;
            const interpolationProgress = Phaser.Math.Clamp(
              elapsedSinceUpdate / player.interpolationMs,
              0,
              1
            );
            const easedProgress = Phaser.Math.Easing.Sine.InOut(interpolationProgress);
            let nextX = Phaser.Math.Linear(player.fromX, player.x, easedProgress);
            let nextY = Phaser.Math.Linear(player.fromY, player.y, easedProgress);
            const afterTargetMs = Math.max(0, elapsedSinceUpdate - player.interpolationMs);
            const shouldPredict =
              player.movement === 'walk' &&
              afterTargetMs > 0 &&
              afterTargetMs <= LAND_REMOTE_EXTRAPOLATE_MS &&
              (Math.abs(player.velocityX) > 0.001 || Math.abs(player.velocityY) > 0.001);
            if (shouldPredict) {
              const velocityLength = Math.hypot(player.velocityX, player.velocityY);
              const maxPredictionMs =
                velocityLength > 0
                  ? Math.min(afterTargetMs, LAND_REMOTE_MAX_EXTRAPOLATE_DISTANCE / velocityLength)
                  : 0;
              const predicted = clampLandPosition(
                player.roomId,
                player.x + player.velocityX * maxPredictionMs,
                player.y + player.velocityY * maxPredictionMs
              );
              nextX = predicted.x;
              nextY = predicted.y;
            }
            player.displayX = nextX;
            player.displayY = nextY;
            const scale = characterScaleForRoomY(player.roomId, nextY);
            const label = this.remoteLabels.get(key);
            const labelText = displayNameForAddress(player.authorAddress, primaryNameCacheRef.current);
            if (label?.text !== labelText) {
              label?.setText(labelText);
            }
            avatar.setPosition(nextX, nextY);
            avatar.setScale(avatarScaleXForDirection(player.direction, scale), scale);
            this.animateAvatar(
              avatar,
              player.movement === 'walk' && elapsedSinceUpdate <= LAND_REMOTE_STOP_WALKING_AFTER_MS,
              player.direction
            );
            avatar.setDepth(nextY + 20);
            label?.setPosition(nextX, nextY - LAND_CHARACTER_LABEL_OFFSET * scale);
            label?.setDepth(nextY + 90);
            remoteIndex += 1;
          }
        }
      }

      const width = Math.max(320, containerRef.current.clientWidth || 900);
      const height = Math.max(320, containerRef.current.clientHeight || 560);
      const game = new Phaser.Game({
        type: Phaser.CANVAS,
        parent: containerRef.current,
        backgroundColor: '#101820',
        scale: {
          mode: Phaser.Scale.RESIZE,
          width,
          height,
        },
        scene: QortalLandScene,
      });
      gameRef.current = game;
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || destroyed) return;
        if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = 0;
          if (destroyed) return;
          game.scale.resize(
            Math.max(320, Math.floor(entry.contentRect.width)),
            Math.max(320, Math.floor(entry.contentRect.height))
          );
        });
      });
      resizeObserver.observe(containerRef.current);
    });

    return () => {
      destroyed = true;
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      gameRef.current?.destroy(true);
      gameRef.current = null;
      remotePlayersRef.current.clear();
      landChatBubblesRef.current.clear();
      landActionAnimationsRef.current.clear();
      landCallPresenceRef.current.clear();
    };
  }, [myAddress]);

  const actionTargetName = actionTarget
    ? displayNameForAddress(actionTarget.authorAddress, primaryNameCacheRef.current)
    : '';
  const sendQortTargetName = sendQortTarget
    ? displayNameForAddress(sendQortTarget.authorAddress, primaryNameCacheRef.current)
    : '';
  const sendQortAmountNumber = Number(sendQortAmount);
  const canSendQort =
    Boolean(sendQortTarget) &&
    Number.isFinite(sendQortAmountNumber) &&
    sendQortAmountNumber > 0 &&
    sendQortAmountNumber <= qortBalance &&
    reticulumReady === true &&
    !isSendingQort;
  void landCallPresenceVersion;
  const actionTargetInCall = actionTarget ? isAddressInLandCall(actionTarget.authorAddress) : false;
  const localLandCallActive = ['calling', 'ringing', 'connected'].includes(landVoiceCall.callState);
  const canStartLandCall =
    Boolean(actionTarget) &&
    reticulumReady === true &&
    landVoiceCall.callState === 'idle' &&
    !actionTargetInCall;
  const activeLandCallPeerName = activeLandCallPeerAddress
    ? displayNameForAddress(activeLandCallPeerAddress, primaryNameCacheRef.current)
    : '';
  const incomingLandCallName = landVoiceCall.incomingCall
    ? displayNameForAddress(landVoiceCall.incomingCall.fromAddress, primaryNameCacheRef.current)
    : '';
  const activeLandCallSubtitle = (() => {
    if (landVoiceCall.callState === 'calling') return landVoiceCall.startupStatus.detail || 'Calling...';
    if (landVoiceCall.callState === 'ringing') return 'Incoming call';
    if (landVoiceCall.callState === 'connected') {
      const minutes = Math.floor(landVoiceCall.callDuration / 60).toString().padStart(2, '0');
      const seconds = Math.floor(landVoiceCall.callDuration % 60).toString().padStart(2, '0');
      return landVoiceCall.callMediaReady ? `Connected ${minutes}:${seconds}` : landVoiceCall.startupStatus.detail || 'Connecting audio...';
    }
    return '';
  })();

  return (
    <Box
      sx={{
        backgroundColor: '#101820',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
        width: '100%',
      }}
    >
      <Box
        sx={{
          alignItems: 'center',
          backgroundColor: 'rgba(9, 13, 18, 0.72)',
          borderBottom: `1px solid ${theme.palette.divider}`,
          display: 'flex',
          gap: 1.5,
          height: 42,
          justifyContent: 'space-between',
          padding: '0 14px',
          zIndex: 2,
        }}
      >
        <Typography sx={{ color: theme.palette.text.primary, fontSize: 14, fontWeight: 700 }}>
          QortalLand
        </Typography>
        <Typography sx={{ color: theme.palette.text.secondary, fontSize: 12 }}>
          {groupName}
        </Typography>
      </Box>
      <Box
        ref={containerRef}
        sx={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          width: '100%',
          '& canvas': {
            display: 'block',
          },
        }}
      />
      {reticulumReady === true && (
        <Box
          sx={{
            alignItems: 'center',
            backgroundColor: 'rgba(7, 9, 20, 0.82)',
            border: '1px solid rgba(44, 248, 255, 0.24)',
            borderRadius: '8px',
            bottom: 16,
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
            display: 'flex',
            gap: 1,
            left: '50%',
            maxWidth: 620,
            padding: '8px 10px',
            position: 'absolute',
            transform: 'translateX(-50%)',
            width: 'min(620px, calc(100% - 32px))',
            zIndex: 3,
          }}
        >
          <TextField
            autoComplete="off"
            error={Boolean(chatError)}
            helperText={chatError || `${utf8ByteLength(chatText.trim())}/${LAND_CHAT_MAX_TEXT_BYTES} bytes`}
            placeholder="Say something"
            size="small"
            value={chatText}
            variant="filled"
            onChange={(event) => {
              const next = event.target.value.slice(0, LAND_CHAT_MAX_INPUT_CHARS);
              setChatText(next);
              if (chatError) setChatError('');
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendLandChat();
              }
            }}
            sx={{
              flex: 1,
              '& .MuiFilledInput-root': {
                backgroundColor: 'rgba(11, 16, 32, 0.92)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '6px',
                color: theme.palette.text.primary,
                fontSize: 13,
                minHeight: 42,
                overflow: 'hidden',
                '&:before, &:after': { display: 'none' },
              },
              '& .MuiFormHelperText-root': {
                color: chatError ? theme.palette.error.light : 'rgba(248, 251, 255, 0.52)',
                fontSize: 10,
                lineHeight: 1.2,
                marginLeft: 0.5,
                marginTop: 0.35,
              },
            }}
          />
          <IconButton
            aria-label="Send QortalLand chat"
            disabled={isSendingChat || !chatText.trim()}
            onClick={() => void sendLandChat()}
            sx={{
              backgroundColor: 'rgba(44, 248, 255, 0.16)',
              border: '1px solid rgba(44, 248, 255, 0.28)',
              borderRadius: '6px',
              color: '#2cf8ff',
              height: 42,
              width: 42,
              '&:hover': {
                backgroundColor: 'rgba(44, 248, 255, 0.24)',
              },
              '&.Mui-disabled': {
                color: 'rgba(248, 251, 255, 0.3)',
              },
            }}
          >
            <SendRoundedIcon fontSize="small" />
          </IconButton>
        </Box>
      )}
      {actionTarget && !sendQortTarget && (
        <ClickAwayListener
          mouseEvent="onMouseDown"
          touchEvent="onTouchStart"
          onClickAway={() => setActionTarget(null)}
        >
          <Box
            onMouseDown={(event) => event.stopPropagation()}
            sx={{
              background: `linear-gradient(180deg, ${alpha('#10182a', 0.98)}, ${alpha('#070914', 0.96)})`,
              border: `1px solid ${alpha('#2cf8ff', 0.34)}`,
              borderRadius: '10px',
              boxShadow: `0 18px 38px ${alpha('#000', 0.44)}, 0 0 24px ${alpha('#2cf8ff', 0.1)}`,
              left: actionTarget.menuX,
              minWidth: 220,
              overflow: 'hidden',
              padding: '10px',
              position: 'absolute',
              top: actionTarget.menuY,
              zIndex: 5,
            }}
          >
            <Box sx={{ alignItems: 'flex-start', display: 'flex', gap: 1, justifyContent: 'space-between' }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  sx={{
                    color: theme.palette.text.primary,
                    fontSize: 13,
                    fontWeight: 700,
                    lineHeight: 1.2,
                    marginBottom: 0.5,
                  }}
                >
                  {actionTargetName}
                </Typography>
                <Typography
                  sx={{
                    color: alpha(theme.palette.text.secondary, 0.9),
                    fontSize: 11,
                    marginBottom: 1,
                  }}
                >
                  {shortAddress(actionTarget.authorAddress)}
                </Typography>
              </Box>
              <IconButton
                aria-label="Close player actions"
                onClick={() => setActionTarget(null)}
                size="small"
                sx={{
                  color: alpha(theme.palette.text.secondary, 0.85),
                  height: 24,
                  marginRight: -0.5,
                  marginTop: -0.5,
                  width: 24,
                  '&:hover': {
                    backgroundColor: alpha('#fff', 0.08),
                    color: theme.palette.text.primary,
                  },
                }}
              >
                <CloseRoundedIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Box>
            <Button
              fullWidth
              startIcon={<PaidRoundedIcon fontSize="small" />}
              onClick={() => openSendQortDialog(actionTarget)}
              sx={{
                backgroundColor: alpha('#ffcf5a', 0.15),
                border: `1px solid ${alpha('#ffcf5a', 0.34)}`,
                borderRadius: '8px',
                color: '#ffe59b',
                fontSize: 12,
                fontWeight: 800,
                justifyContent: 'flex-start',
                textTransform: 'none',
                '&:hover': {
                  backgroundColor: alpha('#ffcf5a', 0.23),
                },
              }}
            >
              Send QORT
            </Button>
            <Button
              disabled={!canStartLandCall}
              fullWidth
              startIcon={<CallRoundedIcon fontSize="small" />}
              onClick={() => startLandCall(actionTarget)}
              sx={{
                backgroundColor: actionTargetInCall ? alpha('#fff', 0.05) : alpha('#2cf8ff', 0.12),
                border: `1px solid ${actionTargetInCall ? alpha('#fff', 0.1) : alpha('#2cf8ff', 0.3)}`,
                borderRadius: '8px',
                color: actionTargetInCall ? alpha(theme.palette.text.secondary, 0.9) : '#9ffcff',
                fontSize: 12,
                fontWeight: 800,
                justifyContent: 'flex-start',
                marginTop: 1,
                textTransform: 'none',
                '&:hover': {
                  backgroundColor: alpha('#2cf8ff', 0.2),
                },
                '&.Mui-disabled': {
                  color: actionTargetInCall ? alpha('#ffcf5a', 0.72) : alpha('#fff', 0.32),
                },
              }}
            >
              {actionTargetInCall ? 'In a call' : 'Call'}
            </Button>
          </Box>
        </ClickAwayListener>
      )}
      {localLandCallActive && (
        <Box
          sx={{
            alignItems: 'center',
            background: `linear-gradient(135deg, ${alpha('#091425', 0.94)}, ${alpha('#070914', 0.9)})`,
            border: `1px solid ${alpha('#2cf8ff', 0.26)}`,
            borderRadius: '12px',
            boxShadow: `0 18px 42px ${alpha('#000', 0.42)}, 0 0 28px ${alpha('#2cf8ff', 0.08)}`,
            display: 'flex',
            gap: 1.25,
            left: 16,
            maxWidth: 'min(360px, calc(100% - 32px))',
            padding: '10px 12px',
            position: 'absolute',
            top: 56,
            zIndex: 4,
          }}
        >
          <Box
            sx={{
              alignItems: 'center',
              backgroundColor: alpha('#2cf8ff', 0.16),
              border: `1px solid ${alpha('#2cf8ff', 0.42)}`,
              borderRadius: '50%',
              color: '#9ffcff',
              display: 'flex',
              height: 38,
              justifyContent: 'center',
              width: 38,
            }}
          >
            <CallRoundedIcon fontSize="small" />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ color: theme.palette.text.primary, fontSize: 13, fontWeight: 800 }}>
              {activeLandCallPeerName || 'QortalLand call'}
            </Typography>
            <Typography sx={{ color: alpha(theme.palette.text.secondary, 0.92), fontSize: 11 }}>
              {activeLandCallSubtitle}
            </Typography>
          </Box>
          <IconButton
            aria-label="End QortalLand call"
            onClick={() => void landVoiceCall.hangUp()}
            sx={{
              backgroundColor: alpha('#ff4f6d', 0.16),
              border: `1px solid ${alpha('#ff4f6d', 0.34)}`,
              color: '#ff9aaa',
              height: 34,
              marginLeft: 'auto',
              width: 34,
              '&:hover': {
                backgroundColor: alpha('#ff4f6d', 0.28),
              },
            }}
          >
            <CallEndRoundedIcon fontSize="small" />
          </IconButton>
        </Box>
      )}
      <Dialog
        open={Boolean(sendQortTarget)}
        onClose={closeSendQortDialog}
        PaperProps={{
          sx: {
            background: `linear-gradient(180deg, ${alpha('#11182a', 0.98)}, ${alpha('#070914', 0.98)})`,
            border: `1px solid ${alpha('#ffcf5a', 0.24)}`,
            borderRadius: '12px',
            boxShadow: `0 24px 70px ${alpha('#000', 0.55)}, 0 0 34px ${alpha('#ffcf5a', 0.08)}`,
            color: theme.palette.text.primary,
            width: 'min(420px, calc(100vw - 36px))',
          },
        }}
      >
        <DialogTitle
          sx={{
            alignItems: 'center',
            display: 'flex',
            gap: 1,
            padding: '18px 20px 8px',
          }}
        >
          <PaidRoundedIcon sx={{ color: '#ffcf5a' }} />
          <Box>
            <Typography sx={{ fontSize: 17, fontWeight: 800 }}>Send QORT</Typography>
            <Typography sx={{ color: theme.palette.text.secondary, fontSize: 12 }}>
              To {sendQortTargetName || 'player'}
            </Typography>
          </Box>
        </DialogTitle>
        <DialogContent sx={{ padding: '10px 20px 4px' }}>
          <Box
            sx={{
              backgroundColor: alpha('#000', 0.18),
              border: `1px solid ${alpha('#fff', 0.08)}`,
              borderRadius: '9px',
              marginBottom: 1.5,
              padding: '10px 12px',
            }}
          >
            <Typography sx={{ color: theme.palette.text.secondary, fontSize: 11 }}>
              Recipient
            </Typography>
            <Typography sx={{ fontSize: 14, fontWeight: 800 }}>
              {sendQortTargetName || '-'}
            </Typography>
            <Typography sx={{ color: alpha(theme.palette.text.secondary, 0.85), fontSize: 11 }}>
              {sendQortTarget?.authorAddress || ''}
            </Typography>
          </Box>
          <Typography sx={{ color: theme.palette.text.secondary, fontSize: 12, marginBottom: 1 }}>
            Balance: <Box component="span" sx={{ color: '#ffe59b', fontWeight: 800 }}>
              {formatQortAmount(qortBalance)} QORT
            </Box>
          </Typography>
          <Stack direction="row" spacing={1} sx={{ marginBottom: 1.5 }}>
            {['1', '5', '10'].map((amount) => (
              <Button
                key={amount}
                onClick={() => {
                  setSendQortAmount(amount);
                  if (sendQortError) setSendQortError('');
                }}
                sx={{
                  backgroundColor: sendQortAmount === amount ? alpha('#ffcf5a', 0.24) : alpha('#fff', 0.06),
                  border: `1px solid ${sendQortAmount === amount ? alpha('#ffcf5a', 0.52) : alpha('#fff', 0.1)}`,
                  borderRadius: '8px',
                  color: sendQortAmount === amount ? '#ffe59b' : theme.palette.text.primary,
                  flex: 1,
                  fontWeight: 800,
                  minWidth: 0,
                  textTransform: 'none',
                  '&:hover': {
                    backgroundColor: alpha('#ffcf5a', 0.18),
                  },
                }}
              >
                {amount}
              </Button>
            ))}
            <Button
              onClick={() => {
                setSendQortAmount('');
                if (sendQortError) setSendQortError('');
              }}
              sx={{
                backgroundColor: !['1', '5', '10'].includes(sendQortAmount) ? alpha('#2cf8ff', 0.12) : alpha('#fff', 0.06),
                border: `1px solid ${!['1', '5', '10'].includes(sendQortAmount) ? alpha('#2cf8ff', 0.34) : alpha('#fff', 0.1)}`,
                borderRadius: '8px',
                color: theme.palette.text.primary,
                flex: 1,
                fontWeight: 800,
                minWidth: 0,
                textTransform: 'none',
              }}
            >
              Other
            </Button>
          </Stack>
          <TextField
            autoFocus
            error={Boolean(sendQortError)}
            fullWidth
            label="Amount"
            placeholder="0.00000000"
            size="small"
            type="number"
            value={sendQortAmount}
            InputProps={{
              endAdornment: <InputAdornment position="end">QORT</InputAdornment>,
            }}
            onChange={(event) => {
              setSendQortAmount(event.target.value);
              if (sendQortError) setSendQortError('');
            }}
            sx={{ marginBottom: 1.2 }}
          />
          <Typography
            sx={{
              color: sendQortError ? theme.palette.error.light : theme.palette.text.secondary,
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {sendQortError || 'Click Send QORT to submit the payment. The room animation is sent after it succeeds.'}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ padding: '12px 20px 18px' }}>
          <Button
            disabled={isSendingQort}
            onClick={closeSendQortDialog}
            sx={{ color: theme.palette.text.secondary, textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            disabled={!canSendQort}
            onClick={() => void handleSendQort()}
            sx={{
              backgroundColor: alpha('#ffcf5a', 0.18),
              border: `1px solid ${alpha('#ffcf5a', 0.38)}`,
              borderRadius: '8px',
              color: '#ffe59b',
              fontWeight: 800,
              minWidth: 118,
              textTransform: 'none',
              '&:hover': {
                backgroundColor: alpha('#ffcf5a', 0.26),
              },
              '&.Mui-disabled': {
                color: alpha('#fff', 0.32),
              },
            }}
          >
            {isSendingQort ? 'Sending...' : 'Send QORT'}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={Boolean(landVoiceCall.incomingCall)}
        onClose={() => landVoiceCall.rejectCall()}
        PaperProps={{
          sx: {
            background: `linear-gradient(180deg, ${alpha('#10182a', 0.98)}, ${alpha('#070914', 0.98)})`,
            border: `1px solid ${alpha('#2cf8ff', 0.28)}`,
            borderRadius: '12px',
            boxShadow: `0 24px 70px ${alpha('#000', 0.55)}, 0 0 34px ${alpha('#2cf8ff', 0.08)}`,
            color: theme.palette.text.primary,
            width: 'min(390px, calc(100vw - 36px))',
          },
        }}
      >
        <DialogTitle
          sx={{
            alignItems: 'center',
            display: 'flex',
            gap: 1,
            padding: '18px 20px 8px',
          }}
        >
          <CallRoundedIcon sx={{ color: '#9ffcff' }} />
          <Box>
            <Typography sx={{ fontSize: 17, fontWeight: 800 }}>Incoming Call</Typography>
            <Typography sx={{ color: theme.palette.text.secondary, fontSize: 12 }}>
              {incomingLandCallName || 'QortalLand player'}
            </Typography>
          </Box>
        </DialogTitle>
        <DialogContent sx={{ padding: '10px 20px 4px' }}>
          <Typography sx={{ color: theme.palette.text.secondary, fontSize: 13, lineHeight: 1.45 }}>
            Accept this QortalLand voice call?
          </Typography>
        </DialogContent>
        <DialogActions sx={{ padding: '12px 20px 18px' }}>
          <Button
            onClick={() => landVoiceCall.rejectCall()}
            sx={{ color: theme.palette.text.secondary, textTransform: 'none' }}
          >
            Decline
          </Button>
          <Button
            onClick={() => void landVoiceCall.acceptCall()}
            startIcon={<CallRoundedIcon fontSize="small" />}
            sx={{
              backgroundColor: alpha('#2cf8ff', 0.16),
              border: `1px solid ${alpha('#2cf8ff', 0.38)}`,
              borderRadius: '8px',
              color: '#9ffcff',
              fontWeight: 800,
              minWidth: 108,
              textTransform: 'none',
              '&:hover': {
                backgroundColor: alpha('#2cf8ff', 0.26),
              },
            }}
          >
            Accept
          </Button>
        </DialogActions>
      </Dialog>
      {reticulumReady === false && (
        <Box
          sx={{
            alignItems: 'center',
            backgroundColor: 'rgba(9, 13, 18, 0.86)',
            bottom: 0,
            display: 'flex',
            justifyContent: 'center',
            left: 0,
            position: 'absolute',
            right: 0,
            top: 42,
            zIndex: 3,
          }}
        >
          <Typography sx={{ color: theme.palette.text.secondary, fontSize: 14 }}>
            Reticulum chat is disabled
          </Typography>
        </Box>
      )}
    </Box>
  );
}
