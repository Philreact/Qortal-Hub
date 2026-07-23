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

type ReticulumChatVisibilityChange = {
  groupId: number;
  targetAddress: string;
  active: boolean;
  revision: number;
};

type ReticulumDiscussionIndex = {
  replyCounts: Record<string, number>;
  rootByEventId: Record<string, string>;
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
        const primaryName = primaryNames[address]?.trim();
        // A missing result can be transient. Do not cache it so it can resolve later.
        if (primaryName) primaryNameCache.set(address, primaryName);
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
      senderName: primaryName,
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
  const [loadedInitialHistoryKey, setLoadedInitialHistoryKey] = useState('');
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const eventsRef = useRef<unknown[]>([]);
  const activeChatKeyRef = useRef('');
  const pendingEventsRef = useRef<ReticulumChatHookEvent[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const primaryNameCacheRef = useRef<Map<string, string>>(new Map());
  const primaryNameRetryAttemptsRef = useRef(0);
  const [primaryNameRetryToken, setPrimaryNameRetryToken] = useState(0);
  const loadingOlderRef = useRef(false);
  const retryOlderAfterRef = useRef(0);
  const visibilityRevisionRef = useRef(0);
  const [visibilityChange, setVisibilityChange] =
    useState<ReticulumChatVisibilityChange | null>(null);
  const [discussionIndex, setDiscussionIndex] =
    useState<ReticulumDiscussionIndex>({
      replyCounts: {},
      rootByEventId: {},
    });
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

  const enrichVisibleEvents = useCallback(
    async (incoming: ReticulumChatHookEvent[], expectedChatKey: string) => {
      const enriched = await addPrimaryNamesToEvents(
        incoming,
        primaryNameCacheRef.current
      );
      if (!expectedChatKey || activeChatKeyRef.current !== expectedChatKey) return;
      const enrichedById = new Map(
        enriched
          .filter((event) => typeof event.eventId === 'string' && !!event.eventId)
          .map((event) => [event.eventId as string, event])
      );
      if (enrichedById.size === 0) return;
      let changed = false;
      const next = eventsRef.current.map((item) => {
        const eventId = (item as ReticulumChatHookEvent)?.eventId;
        const replacement =
          typeof eventId === 'string' ? enrichedById.get(eventId) : undefined;
        if (!replacement) return item;
        const current = item as ReticulumChatHookEvent;
        if (
          current.senderName === replacement.senderName &&
          current.authorPrimaryName === replacement.authorPrimaryName
        ) {
          return item;
        }
        changed = true;
        return replacement;
      });
      if (!changed || activeChatKeyRef.current !== expectedChatKey) return;
      eventsRef.current = next;
      setEvents(next);
    },
    []
  );

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

  const flushPendingEvents = useCallback(() => {
    const expectedChatKey = activeChatKeyRef.current;
    const pending = pendingEventsRef.current;
    pendingEventsRef.current = [];
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    if (pending.length === 0) return;
    retryOlderAfterRef.current = 0;
    setHasOlder(true);
    mergeEvents(pending, expectedChatKey);
    void enrichVisibleEvents(pending, expectedChatKey);
  }, [enrichVisibleEvents, mergeEvents]);

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
    setVisibilityChange(null);
    setTyping({});
    setLoadingOlder(false);
    setHasOlder(false);
    loadingOlderRef.current = false;
    retryOlderAfterRef.current = 0;
    primaryNameRetryAttemptsRef.current = 0;
    const historyVisibilityRevision = visibilityRevisionRef.current;
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
    void historyPromise
      ?.then((history) => {
        if (
          cancelled ||
          visibilityRevisionRef.current !== historyVisibilityRevision ||
          !Array.isArray(history)
        ) {
          return;
        }
        const historyEvents = history as ReticulumChatHookEvent[];
        setHasOlder(historyEvents.length > 0);
        mergeEvents(historyEvents, expectedChatKey);
        void enrichVisibleEvents(historyEvents, expectedChatKey);
        setLoadedInitialHistoryKey(expectedChatKey);
      })
      .catch(() => {
        if (!cancelled) {
          setHasOlder(false);
          setLoadedInitialHistoryKey(expectedChatKey);
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
    const offSilence = window.reticulumChat?.onSilenceChanged?.((payload) => {
      if (
        payload.scopeType !== 'group' ||
        Number(payload.scopeId) !== validGroupId
      ) {
        return;
      }
      const silenceVisibilityRevision = visibilityRevisionRef.current + 1;
      visibilityRevisionRef.current = silenceVisibilityRevision;
      if (payload.active) {
        pendingEventsRef.current = pendingEventsRef.current.filter(
          (event) => event.authorAddress !== payload.targetAddress
        );
        const visibleEvents = eventsRef.current.filter(
          (event) =>
            (event as ReticulumChatHookEvent).authorAddress !==
            payload.targetAddress
        );
        if (visibleEvents.length !== eventsRef.current.length) {
          eventsRef.current = visibleEvents;
          setEvents(visibleEvents);
        }
        setTyping((prev) => {
          if (prev[payload.targetAddress] !== true) return prev;
          const next = { ...prev };
          delete next[payload.targetAddress];
          return next;
        });
      }
      setVisibilityChange({
        groupId: validGroupId,
        targetAddress: payload.targetAddress,
        active: payload.active,
        revision: silenceVisibilityRevision,
      });
      void window.reticulumChat?.getMessageHistory?.(
        validGroupId,
        normalizedChannelId,
        RETICULUM_CHAT_INITIAL_HISTORY_LIMIT,
        { repairNetwork: false }
      )
        ?.then((history) => {
          if (
            cancelled ||
            activeChatKeyRef.current !== expectedChatKey ||
            visibilityRevisionRef.current !== silenceVisibilityRevision ||
            !Array.isArray(history)
          ) {
            return;
          }
          const historyEvents = history as ReticulumChatHookEvent[];
          eventsRef.current = historyEvents;
          setEvents(historyEvents);
          setHasOlder(historyEvents.length > 0);
          void enrichVisibleEvents(historyEvents, expectedChatKey);
        })
        .catch((error) => {
          console.warn(
            '[useReticulumGroupChat] Failed to refresh after silence change:',
            error
          );
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
      offSilence?.();
      void window.reticulumChat?.unsubscribeChannel?.(validGroupId, normalizedChannelId);
    };
  }, [
    enabled,
    enqueueIncomingEvent,
    enrichVisibleEvents,
    mergeEvents,
    normalizedChannelId,
    validGroupId,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      validGroupId == null ||
      primaryNameRetryAttemptsRef.current >= 3
    ) {
      return;
    }

    const unresolvedEvents = (eventsRef.current as ReticulumChatHookEvent[]).filter(
      (event) => {
        const address =
          typeof event.authorAddress === 'string' ? event.authorAddress : '';
        return address && !primaryNameCacheRef.current.get(address)?.trim();
      }
    );
    if (unresolvedEvents.length === 0) return;

    const expectedChatKey = `${validGroupId}:${normalizedChannelId}`;
    const retryTimer = window.setTimeout(() => {
      if (activeChatKeyRef.current !== expectedChatKey) return;
      primaryNameRetryAttemptsRef.current += 1;
      void enrichVisibleEvents(unresolvedEvents, expectedChatKey);
      setPrimaryNameRetryToken((token) => token + 1);
    }, 2500);

    return () => window.clearTimeout(retryTimer);
  }, [
    enabled,
    enrichVisibleEvents,
    events,
    normalizedChannelId,
    primaryNameRetryToken,
    validGroupId,
  ]);

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
          retryOlderAfterRef.current = 0;
          mergeEvents([chatEvent], expectedChatKey);
          void enrichVisibleEvents([chatEvent], expectedChatKey);
        }
      }
      return result;
    },
    [enabled, enrichVisibleEvents, mergeEvents, normalizedChannelId, validGroupId]
  );

  const loadOlder = useCallback(async () => {
    if (!enabled || validGroupId == null) return { added: 0 };
    if (loadingOlderRef.current) return { added: 0 };
    if (Date.now() < retryOlderAfterRef.current) return { added: 0 };

    const expectedChatKey = `${validGroupId}:${normalizedChannelId}`;
    const historyVisibilityRevision = visibilityRevisionRef.current;
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
      if (
        activeChatKeyRef.current !== expectedChatKey ||
        visibilityRevisionRef.current !== historyVisibilityRevision
      ) {
        return { added: 0 };
      }
      if (!Array.isArray(history) || history.length === 0) {
        setHasOlder(false);
        retryOlderAfterRef.current =
          Date.now() + RETICULUM_CHAT_EMPTY_OLDER_RETRY_MS;
        return { added: 0 };
      }

      if (activeChatKeyRef.current !== expectedChatKey) return { added: 0 };
      const historyEvents = history as ReticulumChatHookEvent[];
      const added = mergeEvents(historyEvents, expectedChatKey);
      void enrichVisibleEvents(historyEvents, expectedChatKey);
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
  }, [
    enabled,
    enrichVisibleEvents,
    getOldestCursor,
    mergeEvents,
    normalizedChannelId,
    validGroupId,
  ]);

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

  useEffect(() => {
    if (!enabled || validGroupId == null) {
      setDiscussionIndex({ replyCounts: {}, rootByEventId: {} });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.reticulumChat
        ?.getDiscussionIndex?.(validGroupId, normalizedChannelId)
        .then((index) => {
          if (cancelled) return;
          setDiscussionIndex({
            replyCounts: index?.replyCounts || {},
            rootByEventId: index?.rootByEventId || {},
          });
        })
        .catch(() => {
          if (!cancelled) {
            setDiscussionIndex({ replyCounts: {}, rootByEventId: {} });
          }
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    enabled,
    events,
    normalizedChannelId,
    validGroupId,
    visibilityChange?.revision,
  ]);

  const getDiscussionMessages = useCallback(
    async (eventId: string) => {
      if (!enabled || validGroupId == null || !eventId) return [];
      const discussionEvents =
        (await window.reticulumChat?.getDiscussionMessages?.(
          validGroupId,
          normalizedChannelId,
          eventId
        )) || [];
      return addPrimaryNamesToEvents(
        discussionEvents as ReticulumChatHookEvent[],
        primaryNameCacheRef.current
      );
    },
    [enabled, normalizedChannelId, validGroupId]
  );

  return {
    enabled,
    events,
    hasOlder,
    initialHistoryReady:
      activeChatKey !== '' && loadedInitialHistoryKey === activeChatKey,
    loadingOlder,
    loadOlder,
    typing,
    visibilityChange,
    discussionIndex,
    getDiscussionMessages,
    publishEvent,
    sendTyping,
  };
}
