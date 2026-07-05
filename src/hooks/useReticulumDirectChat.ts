import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const RETICULUM_DIRECT_EVENT_BATCH_MS = 250;

type ReticulumDmEvent = {
  eventId: string;
  conversationId: string;
  senderAddress: string;
  recipientAddress: string;
  senderPublicKey: string;
  senderSeq: number;
  timestamp: number;
  eventType: 'message' | 'edit' | 'delete' | 'reaction_add' | 'reaction_remove';
  targetEventId?: string;
  replyToEventId?: string;
  payload: string;
  payloadHash: string;
  signature: string;
  localDeliveryStatus?: 'pending' | 'sent' | 'received';
  localDeliveryUpdatedAt?: number;
};

const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const conversationIdFor = async (addressA: string, addressB: string) => {
  const [a, b] = [addressA, addressB].sort();
  return sha256Hex(`rchat-dm-v1:${a}:${b}`);
};

const parsePayload = (payload: string): any => {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export const reticulumDmEventToChatMessage = (event: ReticulumDmEvent) => {
  const payload = parsePayload(event.payload);
  const otherData =
    payload.otherData && typeof payload.otherData === 'object'
      ? payload.otherData
      : {};
  return {
    id: event.eventId,
    signature: event.eventId,
    chatReference: payload.chatReference || event.targetEventId,
    repliedTo: otherData.repliedTo || event.replyToEventId,
    timestamp: event.timestamp,
    sender: event.senderAddress,
    text: payload.messageText || '',
    message: payload.messageText || '',
    unread: false,
    reticulumDirect: true,
    reticulumDeliveryStatus: event.localDeliveryStatus,
    reticulumDeliveryUpdatedAt: event.localDeliveryUpdatedAt,
    decryptedData: {
      ...otherData,
      data: otherData.data,
    },
    ...otherData,
  };
};

const mergeEvents = (prev: ReticulumDmEvent[], incoming: ReticulumDmEvent[]) => {
  const byId = new Map(prev.map((event) => [event.eventId, event]));
  for (const event of incoming) byId.set(event.eventId, event);
  return [...byId.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId)
  );
};

export function useReticulumDirectChat(myAddress?: string, peerAddress?: string) {
  const [enabled, setEnabled] = useState(false);
  const [events, setEvents] = useState<ReticulumDmEvent[]>([]);
  const pendingRef = useRef<ReticulumDmEvent[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSenderSeqRef = useRef(0);

  const valid = Boolean(myAddress && peerAddress);
  const messages = useMemo(() => events.map(reticulumDmEventToChatMessage), [events]);

  const flushPending = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = [];
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    if (pending.length === 0) return;
    setEvents((prev) => mergeEvents(prev, pending));
  }, []);

  const enqueue = useCallback(
    (event: ReticulumDmEvent) => {
      pendingRef.current.push(event);
      if (batchTimerRef.current) return;
      batchTimerRef.current = setTimeout(
        flushPending,
        RETICULUM_DIRECT_EVENT_BATCH_MS
      );
    },
    [flushPending]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const value = await window.reticulumChat?.isEnabled?.();
      if (cancelled) return;
      const nextEnabled = value === true;
      setEnabled(nextEnabled);
      if (nextEnabled && myAddress) {
        void window.reticulumChat?.setLocalDmAddresses?.([myAddress]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [myAddress]);

  useEffect(() => {
    if (!enabled || !valid || !myAddress || !peerAddress) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    void window.reticulumChat?.getDirectHistory?.(myAddress, peerAddress, 200)
      ?.then((history) => {
        if (cancelled || !Array.isArray(history)) return;
        setEvents(history as ReticulumDmEvent[]);
      });
    const off = window.reticulumChat?.onDirectEvent?.(({ event }) => {
      const candidate = event as ReticulumDmEvent;
      if (
        candidate?.senderAddress !== myAddress &&
        candidate?.recipientAddress !== myAddress
      ) return;
      if (
        candidate?.senderAddress !== peerAddress &&
        candidate?.recipientAddress !== peerAddress
      ) return;
      enqueue(candidate);
    });
    return () => {
      cancelled = true;
      off?.();
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
    };
  }, [enabled, enqueue, myAddress, peerAddress, valid]);

  const publish = useCallback(
    async ({
      chatReference,
      messageText,
      otherData,
      peerAddressOverride,
    }: {
      chatReference?: string;
      messageText: string;
      otherData?: Record<string, unknown>;
      peerAddressOverride?: string;
    }) => {
      const actualPeerAddress = String(peerAddressOverride || peerAddress || '').trim();
      if (!enabled || !myAddress || !actualPeerAddress) {
        return { success: false, error: 'Reticulum chat is disabled' };
      }
      const conversationId = await conversationIdFor(myAddress, actualPeerAddress);
      const timestamp = Date.now();
      const eventId = crypto.randomUUID?.() || `${timestamp}-${Math.random()}`;
      const payload = JSON.stringify({
        chatReference: chatReference || undefined,
        messageText,
        otherData: otherData || {},
      });
      const payloadHash = await sha256Hex(payload);
      const existingSeqs = events
        .filter((event) => event.senderAddress === myAddress)
        .map((event) => Number(event.senderSeq || 0));
      const senderSeq = Math.max(
        lastSenderSeqRef.current + 1,
        timestamp * 1000,
        ...existingSeqs.map((seq) => seq + 1)
      );
      lastSenderSeqRef.current = senderSeq;
      const type = String(otherData?.type || '');
      const eventType =
        type === 'edit'
          ? 'edit'
          : type === 'reaction' && otherData?.contentState === false
            ? 'reaction_remove'
            : type === 'reaction'
              ? 'reaction_add'
              : type === 'delete'
                ? 'delete'
                : 'message';
      const baseFields = {
        conversationId,
        eventId,
        eventType,
        payload,
        payloadHash,
        recipientAddress: actualPeerAddress,
        replyToEventId: (otherData?.repliedTo as string) || null,
        senderSeq,
        targetEventId: chatReference || null,
        timestamp,
      };
      const signed = await window.sendMessage(
        'signReticulumChatEvent',
        baseFields
      );
      if (signed?.error) throw new Error(signed.error);
      if (signed?.authorAddress !== myAddress) {
        throw new Error('Signed DM author mismatch');
      }
      const event: ReticulumDmEvent = {
        ...baseFields,
        replyToEventId: baseFields.replyToEventId || undefined,
        targetEventId: baseFields.targetEventId || undefined,
        senderAddress: signed.authorAddress,
        senderPublicKey: signed.authorPublicKey,
        signature: signed.signature,
        localDeliveryStatus: 'pending',
        localDeliveryUpdatedAt: Date.now(),
      };
      await window.reticulumChat?.setLocalDmAddresses?.([myAddress]);
      const result = await window.reticulumChat?.publishDirectEvent?.(event);
      if (result?.success) setEvents((prev) => mergeEvents(prev, [event]));
      return result;
    },
    [enabled, events, myAddress, peerAddress]
  );

  const markRead = useCallback(
    async (upToTimestamp: number) => {
      if (!enabled || !myAddress || !peerAddress) return;
      await window.reticulumChat?.markDirectRead?.(
        myAddress,
        peerAddress,
        upToTimestamp
      );
    },
    [enabled, myAddress, peerAddress]
  );

  return {
    enabled,
    events,
    messages,
    publish,
    markRead,
  };
}
