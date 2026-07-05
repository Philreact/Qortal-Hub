import { useCallback, useEffect, useRef, useState } from 'react';
import { getPrimaryNamesForAddresses } from '../components/Group/groupApi';

const RETICULUM_CHAT_EVENT_BATCH_MS = 400;
export const isDisabledTyping = false;

type ReticulumChatHookEvent = {
  authorAddress?: unknown;
  eventId?: unknown;
  groupId?: unknown;
  senderName?: unknown;
  authorPrimaryName?: unknown;
  [key: string]: unknown;
};

const mergeReticulumEvents = (
  prev: unknown[],
  incoming: ReticulumChatHookEvent[]
): unknown[] => {
  const knownIds = new Set(
    prev
      .map((item) => (item as { eventId?: unknown })?.eventId)
      .filter((id): id is string => typeof id === 'string' && !!id)
  );
  let added = false;
  const next = [...prev];
  for (const event of incoming) {
    const eventId = typeof event.eventId === 'string' ? event.eventId : '';
    if (eventId && knownIds.has(eventId)) continue;
    if (eventId) knownIds.add(eventId);
    next.push(event);
    added = true;
  }
  if (!added) return prev;
  return next.sort((a, b) => {
    const at = Number((a as { timestamp?: unknown }).timestamp || 0);
    const bt = Number((b as { timestamp?: unknown }).timestamp || 0);
    return at - bt;
  });
};

const addPrimaryNamesToEvents = async (
  events: ReticulumChatHookEvent[],
  primaryNameCache: Map<string, string>
): Promise<ReticulumChatHookEvent[]> => {
  const addresses = Array.from(
    new Set(
      events
        .map((event) => event.authorAddress)
        .filter((address): address is string => typeof address === 'string' && !!address)
    )
  );
  if (addresses.length === 0) return events;

  const missingAddresses = addresses.filter(
    (address) => !primaryNameCache.has(address)
  );

  if (missingAddresses.length > 0) {
    try {
      const primaryNames = await getPrimaryNamesForAddresses(missingAddresses);
      for (const address of missingAddresses) {
        primaryNameCache.set(address, primaryNames[address]?.trim() || '');
      }
    } catch (error) {
      console.error('[useReticulumGroupChat] Failed to resolve primary names:', error);
    }
  }

  return events.map((event) => {
    const authorAddress =
      typeof event.authorAddress === 'string' ? event.authorAddress : '';
    const primaryName = authorAddress ? primaryNameCache.get(authorAddress)?.trim() : '';
    if (!primaryName) return event;
    return {
      ...event,
      authorPrimaryName: primaryName,
      senderName: typeof event.senderName === 'string' && event.senderName
        ? event.senderName
        : primaryName,
    };
  });
};

export function useReticulumGroupChat(
  groupId?: number | string | null,
  channelId = 'general'
) {
  const normalizedChannelId =
    typeof channelId === 'string' && channelId.trim()
      ? channelId.trim().toLowerCase()
      : 'general';
  const numericGroupId =
    typeof groupId === 'string' ? Number(groupId) : (groupId ?? null);
  const validGroupId =
    Number.isInteger(numericGroupId) && Number(numericGroupId) > 0
      ? Number(numericGroupId)
      : null;
  const [enabled, setEnabled] = useState(false);
  const [events, setEvents] = useState<unknown[]>([]);
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const pendingEventsRef = useRef<ReticulumChatHookEvent[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const primaryNameCacheRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const value = await window.reticulumChat?.isEnabled?.();
      if (!cancelled) setEnabled(value === true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const flushPendingEvents = useCallback(async () => {
    const pending = pendingEventsRef.current;
    pendingEventsRef.current = [];
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    if (pending.length === 0) return;

    const enriched = await addPrimaryNamesToEvents(
      pending,
      primaryNameCacheRef.current
    );
    setEvents((prev) => mergeReticulumEvents(prev, enriched));
  }, []);

  const enqueueIncomingEvent = useCallback(
    (event: ReticulumChatHookEvent) => {
      pendingEventsRef.current.push(event);
      if (batchTimerRef.current) return;
      batchTimerRef.current = setTimeout(() => {
        void flushPendingEvents();
      }, RETICULUM_CHAT_EVENT_BATCH_MS);
    },
    [flushPendingEvents]
  );

  useEffect(() => {
    if (!enabled || validGroupId == null) return;
    let cancelled = false;
    void window.reticulumChat?.subscribeGroup?.(validGroupId);
    void window.reticulumChat?.subscribeChannel?.(validGroupId, normalizedChannelId);
    setEvents([]);
    setTyping({});
    const historyPromise =
      window.reticulumChat?.getMessageHistory?.(
        validGroupId,
        normalizedChannelId,
        200
      ) ??
      window.reticulumChat?.getHistory?.(
        validGroupId,
        normalizedChannelId,
        200
      );
    void historyPromise?.then(async (history) => {
      if (cancelled || !Array.isArray(history)) return;
      const enriched = await addPrimaryNamesToEvents(
        history as ReticulumChatHookEvent[],
        primaryNameCacheRef.current
      );
      if (!cancelled) {
        setEvents((prev) => mergeReticulumEvents(prev, enriched));
      }
    });

    const offEvent = window.reticulumChat?.onEvent?.((payload) => {
      const event = payload?.event as ReticulumChatHookEvent;
      if (!event || event.groupId !== validGroupId) return;
      const eventType = typeof event.eventType === 'string' ? event.eventType : '';
      if (
        !eventType.startsWith('channel_') &&
        !eventType.startsWith('category_') &&
        typeof event.channelId === 'string' &&
        event.channelId !== normalizedChannelId
      ) {
        return;
      }
      enqueueIncomingEvent(event);
    });
    const offTyping = isDisabledTyping
      ? undefined
      : window.reticulumChat?.onTyping?.((payload) => {
          if (payload.groupId !== validGroupId) return;
          if (payload.channelId !== normalizedChannelId) return;
          if (typeof payload.authorAddress !== 'string' || !payload.authorAddress) {
            return;
          }
          setTyping((prev) => {
            if (payload.active) {
              if (prev[payload.authorAddress] === true) return prev;
              return {
                ...prev,
                [payload.authorAddress]: true,
              };
            }
            if (prev[payload.authorAddress] !== true) return prev;
            const next = { ...prev };
            delete next[payload.authorAddress];
            return next;
          });
        });

    return () => {
      cancelled = true;
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      pendingEventsRef.current = [];
      primaryNameCacheRef.current.clear();
      offEvent?.();
      offTyping?.();
      void window.reticulumChat?.unsubscribeChannel?.(validGroupId, normalizedChannelId);
    };
  }, [enabled, enqueueIncomingEvent, normalizedChannelId, validGroupId]);

  const publishEvent = useCallback(
    async (event: unknown) => {
      if (!enabled || validGroupId == null) {
        return { success: false, error: 'Reticulum chat is disabled' };
      }
      const result =
        (await window.reticulumChat?.publishEvent?.(event)) ?? {
          success: false,
          error: 'Reticulum chat API unavailable',
        };
      if (result?.success) {
        const chatEvent = event as ReticulumChatHookEvent;
        if (
          Number(chatEvent?.groupId) === validGroupId &&
          ((typeof chatEvent?.channelId === 'string' &&
            chatEvent.channelId === normalizedChannelId) ||
            chatEvent?.channelId == null)
        ) {
          const enriched = await addPrimaryNamesToEvents(
            [chatEvent],
            primaryNameCacheRef.current
          );
          setEvents((prev) => mergeReticulumEvents(prev, enriched));
        }
      }
      return result;
    },
    [enabled, normalizedChannelId, validGroupId]
  );

  const sendTyping = useCallback(
    async (authorAddress: string, active: boolean) => {
      if (isDisabledTyping) {
        return { success: true };
      }
      if (!enabled || validGroupId == null) {
        return { success: false, error: 'Reticulum chat is disabled' };
      }
      return (
        (await window.reticulumChat?.sendTyping?.(
          validGroupId,
          normalizedChannelId,
          authorAddress,
          active
        )) ?? {
          success: false,
          error: 'Reticulum chat API unavailable',
        }
      );
    },
    [enabled, normalizedChannelId, validGroupId]
  );

  return {
    enabled,
    events,
    typing,
    publishEvent,
    sendTyping,
  };
}
