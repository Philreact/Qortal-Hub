import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getPrimaryNamesForAddresses } from '../components/Group/groupApi';

const RETICULUM_CHAT_EVENT_BATCH_MS = 400;
const RETICULUM_CHAT_INITIAL_HISTORY_LIMIT = 200;
const RETICULUM_CHAT_OLDER_HISTORY_LIMIT = 100;
const RETICULUM_CHAT_EMPTY_OLDER_RETRY_MS = 3000;
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
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const eventsRef = useRef<unknown[]>([]);
  const activeChatKeyRef = useRef('');
  const pendingEventsRef = useRef<ReticulumChatHookEvent[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const primaryNameCacheRef = useRef<Map<string, string>>(new Map());
  const loadingOlderRef = useRef(false);
  const retryOlderAfterRef = useRef(0);
  const activeChatKey = enabled && validGroupId != null
    ? `${validGroupId}:${normalizedChannelId}`
    : '';
  useLayoutEffect(() => {
    activeChatKeyRef.current = activeChatKey;
    return () => {
      if (activeChatKeyRef.current === activeChatKey) activeChatKeyRef.current = '';
    };
  }, [activeChatKey]);

  const mergeEvents = useCallback((incoming: ReticulumChatHookEvent[], expectedChatKey: string) => {
    if (!expectedChatKey || activeChatKeyRef.current !== expectedChatKey) return 0;
    const previous = eventsRef.current;
    const knownIds = new Set(
      previous
        .map((item) => (item as { eventId?: unknown })?.eventId)
        .filter((id): id is string => typeof id === 'string' && !!id)
    );
    const added = incoming.reduce((count, event) => {
      const eventId = typeof event.eventId === 'string' ? event.eventId : '';
      if (!eventId || knownIds.has(eventId)) return count;
      knownIds.add(eventId);
      return count + 1;
    }, 0);
    const merged = mergeReticulumEvents(previous, incoming);
    eventsRef.current = merged;
    setEvents(merged);
    return added;
  }, []);

  const getOldestCursor = useCallback(() => {
    let oldest: { eventId: string; timestamp: number } | null = null;
    for (const item of events) {
      const event = item as ReticulumChatHookEvent;
      const eventId = typeof event?.eventId === 'string' ? event.eventId : '';
      const timestamp = Number(event?.timestamp);
      if (!eventId || !Number.isFinite(timestamp) || timestamp < 0) continue;
      if (
        !oldest ||
        timestamp < oldest.timestamp ||
        (timestamp === oldest.timestamp && eventId < oldest.eventId)
      ) {
        oldest = { eventId, timestamp };
      }
    }
    return oldest;
  }, [events]);

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
    const expectedChatKey = activeChatKeyRef.current;
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
    if (activeChatKeyRef.current !== expectedChatKey) return;
    retryOlderAfterRef.current = 0;
    setHasOlder(true);
    mergeEvents(enriched, expectedChatKey);
  }, [mergeEvents]);

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
    const expectedChatKey = `${validGroupId}:${normalizedChannelId}`;
    void window.reticulumChat?.subscribeGroup?.(validGroupId);
    void window.reticulumChat?.subscribeChannel?.(validGroupId, normalizedChannelId);
    eventsRef.current = [];
    setEvents([]);
    setTyping({});
    setLoadingOlder(false);
    setHasOlder(false);
    loadingOlderRef.current = false;
    retryOlderAfterRef.current = 0;
    const historyPromise =
      window.reticulumChat?.getMessageHistory?.(
        validGroupId,
        normalizedChannelId,
        RETICULUM_CHAT_INITIAL_HISTORY_LIMIT
      ) ??
      window.reticulumChat?.getHistory?.(
        validGroupId,
        normalizedChannelId,
        RETICULUM_CHAT_INITIAL_HISTORY_LIMIT
      );
    void historyPromise?.then(async (history) => {
      if (cancelled || !Array.isArray(history)) return;
      const enriched = await addPrimaryNamesToEvents(
        history as ReticulumChatHookEvent[],
        primaryNameCacheRef.current
      );
      if (!cancelled) {
        setHasOlder(enriched.length > 0);
        mergeEvents(enriched, expectedChatKey);
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
  }, [enabled, enqueueIncomingEvent, mergeEvents, normalizedChannelId, validGroupId]);

  const publishEvent = useCallback(
    async (event: unknown) => {
      if (!enabled || validGroupId == null) {
        return { success: false, error: 'Reticulum chat is disabled' };
      }
      const expectedChatKey = `${validGroupId}:${normalizedChannelId}`;
      const result =
        (await window.reticulumChat?.publishEvent?.(event)) ?? {
          success: false,
          error: 'Reticulum chat API unavailable',
        };
      if (activeChatKeyRef.current !== expectedChatKey) return result;
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
          if (activeChatKeyRef.current !== expectedChatKey) return result;
          retryOlderAfterRef.current = 0;
          mergeEvents(enriched, expectedChatKey);
        }
      }
      return result;
    },
    [enabled, mergeEvents, normalizedChannelId, validGroupId]
  );

  const loadOlder = useCallback(async () => {
    if (!enabled || validGroupId == null) return { added: 0 };
    if (loadingOlderRef.current) return { added: 0 };
    if (Date.now() < retryOlderAfterRef.current) return { added: 0 };

    const expectedChatKey = `${validGroupId}:${normalizedChannelId}`;
    const oldest = getOldestCursor();
    if (!oldest) return { added: 0 };

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const options = {
        beforeTimestamp: oldest.timestamp,
        beforeEventId: oldest.eventId,
        repairNetwork: true,
      };
      const history =
        (await window.reticulumChat?.getMessageHistory?.(
          validGroupId,
          normalizedChannelId,
          RETICULUM_CHAT_OLDER_HISTORY_LIMIT,
          options
        )) ??
        (await window.reticulumChat?.getHistory?.(
          validGroupId,
          normalizedChannelId,
          RETICULUM_CHAT_OLDER_HISTORY_LIMIT,
          options
        ));
      if (activeChatKeyRef.current !== expectedChatKey) return { added: 0 };
      if (!Array.isArray(history) || history.length === 0) {
        setHasOlder(false);
        retryOlderAfterRef.current =
          Date.now() + RETICULUM_CHAT_EMPTY_OLDER_RETRY_MS;
        return { added: 0 };
      }

      const enriched = await addPrimaryNamesToEvents(
        history as ReticulumChatHookEvent[],
        primaryNameCacheRef.current
      );
      if (activeChatKeyRef.current !== expectedChatKey) return { added: 0 };
      const added = mergeEvents(enriched, expectedChatKey);
      retryOlderAfterRef.current =
        added > 0 ? 0 : Date.now() + RETICULUM_CHAT_EMPTY_OLDER_RETRY_MS;
      if (activeChatKeyRef.current === expectedChatKey) setHasOlder(added > 0);
      return { added };
    } catch (error) {
      if (activeChatKeyRef.current === expectedChatKey) {
        retryOlderAfterRef.current =
          Date.now() + RETICULUM_CHAT_EMPTY_OLDER_RETRY_MS;
      }
      console.warn('[useReticulumGroupChat] Failed to load older messages:', error);
      return { added: 0 };
    } finally {
      if (activeChatKeyRef.current === expectedChatKey) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [enabled, getOldestCursor, mergeEvents, normalizedChannelId, validGroupId]);

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
    hasOlder,
    loadingOlder,
    loadOlder,
    typing,
    publishEvent,
    sendTyping,
  };
}
