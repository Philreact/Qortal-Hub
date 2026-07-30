import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { getPrimaryNamesForAddresses } from '../components/Group/groupApi';

const RETICULUM_CHAT_EVENT_BATCH_MS = 400;
const RETICULUM_CHAT_INITIAL_HISTORY_LIMIT = 200;
const RETICULUM_CHAT_OLDER_HISTORY_LIMIT = 100;
const RETICULUM_CHAT_NEWER_HISTORY_LIMIT = 100;
const RETICULUM_CHAT_EMPTY_OLDER_RETRY_MS = 3000;
export const isDisabledTyping = false;

type ReticulumChatHookEvent = {
  authorAddress?: unknown;
  eventId?: unknown;
  groupId?: unknown;
  senderName?: unknown;
  authorPrimaryName?: unknown;
  expiresAt?: number | null;
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

type ReticulumMessageCursor = {
  eventId: string;
  timestamp: number;
};

type ReticulumHistoryMode = 'latest' | 'anchored';

const messageCursorAt = (
  events: readonly unknown[],
  edge: 'oldest' | 'newest'
): ReticulumMessageCursor | null => {
  let cursor: ReticulumMessageCursor | null = null;
  for (const item of events) {
    const event = item as ReticulumChatHookEvent;
    if (
      event?.eventType !== 'message' &&
      event?.eventType !== 'attachment_manifest'
    ) {
      continue;
    }
    const eventId = typeof event.eventId === 'string' ? event.eventId : '';
    const timestamp = Number(event.timestamp);
    if (!eventId || !Number.isFinite(timestamp) || timestamp < 0) continue;
    if (
      !cursor ||
      (edge === 'oldest'
        ? timestamp < cursor.timestamp ||
          (timestamp === cursor.timestamp && eventId < cursor.eventId)
        : timestamp > cursor.timestamp ||
          (timestamp === cursor.timestamp && eventId > cursor.eventId))
    ) {
      cursor = { eventId, timestamp };
    }
  }
  return cursor;
};

const concurrentEventsForReplacement = (
  currentEvents: readonly ReticulumChatHookEvent[],
  replacementEvents: readonly ReticulumChatHookEvent[],
  eventIdsAtRequestStart: ReadonlySet<string>,
  includeConcurrentRoots: boolean
): ReticulumChatHookEvent[] => {
  const concurrentEvents = currentEvents.filter(
    (event) =>
      typeof event.eventId === 'string' &&
      !eventIdsAtRequestStart.has(event.eventId)
  );
  if (concurrentEvents.length === 0) return [];
  const newestReplacementCursor = messageCursorAt(replacementEvents, 'newest');
  const visibleRootIds = new Set(
    replacementEvents
      .filter(
        (event) =>
          event.eventType === 'message' ||
          event.eventType === 'attachment_manifest'
      )
      .map((event) => event.eventId)
      .filter((eventId): eventId is string => typeof eventId === 'string')
  );
  for (const event of concurrentEvents) {
    if (
      event.eventType !== 'message' &&
      event.eventType !== 'attachment_manifest'
    ) {
      continue;
    }
    const eventId = typeof event.eventId === 'string' ? event.eventId : '';
    if (!eventId) continue;
    const timestamp = Number(event.timestamp);
    if (
      includeConcurrentRoots ||
      !newestReplacementCursor ||
      (Number.isFinite(timestamp) &&
        (timestamp < newestReplacementCursor.timestamp ||
          (timestamp === newestReplacementCursor.timestamp &&
            eventId <= newestReplacementCursor.eventId)))
    ) {
      visibleRootIds.add(eventId);
    }
  }
  return concurrentEvents.filter((event) => {
    if (
      event.eventType === 'message' ||
      event.eventType === 'attachment_manifest'
    ) {
      return (
        typeof event.eventId === 'string' && visibleRootIds.has(event.eventId)
      );
    }
    if (
      event.eventType?.startsWith('channel_') ||
      event.eventType?.startsWith('category_')
    ) {
      return true;
    }
    return (
      typeof event.targetEventId === 'string' &&
      visibleRootIds.has(event.targetEventId)
    );
  });
};

const mergeReticulumEvents = (
  prev: unknown[],
  incoming: ReticulumChatHookEvent[]
): unknown[] => {
  const indexById = new Map<string, number>();
  prev.forEach((item, index) => {
    const eventId = (item as { eventId?: unknown })?.eventId;
    if (typeof eventId === 'string' && eventId) indexById.set(eventId, index);
  });
  let changed = false;
  const next = [...prev];
  for (const event of incoming) {
    const eventId = typeof event.eventId === 'string' ? event.eventId : '';
    const existingIndex = eventId ? indexById.get(eventId) : undefined;
    if (existingIndex !== undefined) {
      const existing = next[existingIndex] as ReticulumChatHookEvent;
      const authorizationChanged =
        existing.privilegedMentionAuthorized !==
        event.privilegedMentionAuthorized;
      if (authorizationChanged) {
        next[existingIndex] = { ...existing, ...event };
        changed = true;
      }
      continue;
    }
    if (eventId) indexById.set(eventId, next.length);
    next.push(event);
    changed = true;
  }
  if (!changed) return prev;
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
        .filter(
          (address): address is string =>
            typeof address === 'string' && !!address
        )
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
      console.error(
        '[useReticulumGroupChat] Failed to resolve primary names:',
        error
      );
    }
  }

  return events.map((event) => {
    const authorAddress =
      typeof event.authorAddress === 'string' ? event.authorAddress : '';
    const primaryName = authorAddress
      ? primaryNameCache.get(authorAddress)?.trim()
      : '';
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
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [historyMode, setHistoryMode] =
    useState<ReticulumHistoryMode>('latest');
  const [historyWindowRevision, setHistoryWindowRevision] = useState(0);
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
  const loadingNewerRef = useRef(false);
  const historyModeRef = useRef<ReticulumHistoryMode>('latest');
  const hasNewerRef = useRef(false);
  const historyWindowGenerationRef = useRef(0);
  const retryOlderAfterRef = useRef(0);
  const visibilityRevisionRef = useRef(0);
  const [visibilityChange, setVisibilityChange] =
    useState<ReticulumChatVisibilityChange | null>(null);
  const [discussionIndex, setDiscussionIndex] =
    useState<ReticulumDiscussionIndex>({
      replyCounts: {},
      rootByEventId: {},
    });
  const activeChatKey =
    enabled && validGroupId != null
      ? `${validGroupId}:${normalizedChannelId}`
      : '';

  const updateHistoryMode = useCallback((mode: ReticulumHistoryMode) => {
    historyModeRef.current = mode;
    setHistoryMode(mode);
  }, []);

  const updateHasNewer = useCallback((value: boolean) => {
    hasNewerRef.current = value;
    setHasNewer(value);
  }, []);

  const replaceHistoryWindow = useCallback(
    (
      nextEvents: ReticulumChatHookEvent[],
      expectedChatKey: string,
      mode: ReticulumHistoryMode
    ) => {
      if (!expectedChatKey || activeChatKeyRef.current !== expectedChatKey)
        return false;
      eventsRef.current = nextEvents;
      setEvents(nextEvents);
      updateHistoryMode(mode);
      setHistoryWindowRevision((revision) => revision + 1);
      return true;
    },
    [updateHistoryMode]
  );
  useLayoutEffect(() => {
    activeChatKeyRef.current = activeChatKey;
    return () => {
      if (activeChatKeyRef.current === activeChatKey)
        activeChatKeyRef.current = '';
    };
  }, [activeChatKey]);

  const mergeEvents = useCallback(
    (incoming: ReticulumChatHookEvent[], expectedChatKey: string) => {
      if (!expectedChatKey || activeChatKeyRef.current !== expectedChatKey)
        return 0;
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
    },
    []
  );

  const enrichVisibleEvents = useCallback(
    async (incoming: ReticulumChatHookEvent[], expectedChatKey: string) => {
      const enriched = await addPrimaryNamesToEvents(
        incoming,
        primaryNameCacheRef.current
      );
      if (!expectedChatKey || activeChatKeyRef.current !== expectedChatKey)
        return;
      const enrichedById = new Map(
        enriched
          .filter(
            (event) => typeof event.eventId === 'string' && !!event.eventId
          )
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
    return messageCursorAt(eventsRef.current, 'oldest');
  }, []);

  const getNewestCursor = useCallback(() => {
    return messageCursorAt(eventsRef.current, 'newest');
  }, []);

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
    let eventsToMerge = pending;
    const oldestVisibleCursor = messageCursorAt(eventsRef.current, 'oldest');
    const newestVisibleCursor = messageCursorAt(eventsRef.current, 'newest');
    if (historyModeRef.current === 'anchored' && hasNewerRef.current) {
      const visibleMessageIds = new Set(
        (eventsRef.current as ReticulumChatHookEvent[])
          .filter(
            (event) =>
              event.eventType === 'message' ||
              event.eventType === 'attachment_manifest'
          )
          .map((event) => event.eventId)
          .filter((eventId): eventId is string => typeof eventId === 'string')
      );
      eventsToMerge = pending.filter((event) => {
        const eventType =
          typeof event.eventType === 'string' ? event.eventType : '';
        if (
          eventType.startsWith('channel_') ||
          eventType.startsWith('category_')
        ) {
          return true;
        }
        if (eventType === 'message' || eventType === 'attachment_manifest') {
          const timestamp = Number(event.timestamp);
          const eventId =
            typeof event.eventId === 'string' ? event.eventId : '';
          return Boolean(
            newestVisibleCursor &&
            eventId &&
            Number.isFinite(timestamp) &&
            (timestamp < newestVisibleCursor.timestamp ||
              (timestamp === newestVisibleCursor.timestamp &&
                eventId <= newestVisibleCursor.eventId))
          );
        }
        const targetEventId =
          typeof event.targetEventId === 'string' ? event.targetEventId : '';
        return !!targetEventId && visibleMessageIds.has(targetEventId);
      });
      if (eventsToMerge.length !== pending.length) updateHasNewer(true);
    }
    if (eventsToMerge.length === 0) return;
    mergeEvents(eventsToMerge, expectedChatKey);
    if (
      oldestVisibleCursor &&
      eventsToMerge.some((event) => {
        if (
          event.eventType !== 'message' &&
          event.eventType !== 'attachment_manifest'
        ) {
          return false;
        }
        const timestamp = Number(event.timestamp);
        const eventId = typeof event.eventId === 'string' ? event.eventId : '';
        return (
          !!eventId &&
          Number.isFinite(timestamp) &&
          (timestamp < oldestVisibleCursor.timestamp ||
            (timestamp === oldestVisibleCursor.timestamp &&
              eventId < oldestVisibleCursor.eventId))
        );
      })
    ) {
      setHasOlder(true);
    }
    void enrichVisibleEvents(eventsToMerge, expectedChatKey);
  }, [enrichVisibleEvents, mergeEvents, updateHasNewer]);

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
    const historyWindowGeneration = ++historyWindowGenerationRef.current;
    void window.reticulumChat?.subscribeGroup?.(validGroupId);
    void window.reticulumChat?.subscribeChannel?.(
      validGroupId,
      normalizedChannelId
    );
    // Clear the authoritative ref immediately, but leave the previous React
    // snapshot in place until the local history read resolves. Consumers gate
    // it with initialHistoryReady, so publishing an intermediate empty array
    // only caused an extra full chat render between selection and history.
    eventsRef.current = [];
    setVisibilityChange(null);
    setTyping((current) => (Object.keys(current).length === 0 ? current : {}));
    setLoadingOlder(false);
    setLoadingNewer(false);
    setHasOlder(false);
    updateHasNewer(false);
    updateHistoryMode('latest');
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    retryOlderAfterRef.current = 0;
    primaryNameRetryAttemptsRef.current = 0;
    const historyVisibilityRevision = visibilityRevisionRef.current;
    const structuredHistoryPromise =
      window.reticulumChat?.getMessageHistoryPage?.(
        validGroupId,
        normalizedChannelId,
        RETICULUM_CHAT_INITIAL_HISTORY_LIMIT
      );
    const historyPromise = structuredHistoryPromise
      ? structuredHistoryPromise.then((page) => ({
          events: Array.isArray(page?.events) ? page.events : [],
          hasOlder: page?.hasMore === true,
        }))
      : (
          window.reticulumChat?.getMessageHistory?.(
            validGroupId,
            normalizedChannelId,
            RETICULUM_CHAT_INITIAL_HISTORY_LIMIT
          ) ??
          window.reticulumChat?.getHistory?.(
            validGroupId,
            normalizedChannelId,
            RETICULUM_CHAT_INITIAL_HISTORY_LIMIT
          )
        )?.then((history) => ({
          events: Array.isArray(history) ? history : [],
          hasOlder: Array.isArray(history) && history.length > 0,
        }));
    void historyPromise
      ?.then((historyPage) => {
        if (
          cancelled ||
          historyWindowGenerationRef.current !== historyWindowGeneration ||
          visibilityRevisionRef.current !== historyVisibilityRevision ||
          !Array.isArray(historyPage.events)
        ) {
          return;
        }
        const historyEvents = historyPage.events as ReticulumChatHookEvent[];
        setHasOlder(historyPage.hasOlder);
        mergeEvents(historyEvents, expectedChatKey);
        updateHistoryMode('latest');
        setHistoryWindowRevision((revision) => revision + 1);
        void enrichVisibleEvents(historyEvents, expectedChatKey);
        setLoadedInitialHistoryKey(expectedChatKey);
      })
      .catch(() => {
        if (
          !cancelled &&
          historyWindowGenerationRef.current === historyWindowGeneration
        ) {
          // The successful path replaces the retained snapshot through
          // mergeEvents. On failure, explicitly publish the authoritative
          // empty ref before declaring this channel ready so stale events from
          // the previous channel can never be processed under the new key.
          setEvents(eventsRef.current);
          setHasOlder(false);
          setLoadedInitialHistoryKey(expectedChatKey);
        }
      });

    const offEvent = window.reticulumChat?.onEvent?.((payload) => {
      const event = payload?.event as ReticulumChatHookEvent;
      if (!event || event.groupId !== validGroupId) return;
      const eventType =
        typeof event.eventType === 'string' ? event.eventType : '';
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
          if (
            typeof payload.authorAddress !== 'string' ||
            !payload.authorAddress
          ) {
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
      const silenceHistoryWindowGeneration =
        ++historyWindowGenerationRef.current;
      loadingOlderRef.current = false;
      loadingNewerRef.current = false;
      setLoadingOlder(false);
      setLoadingNewer(false);
      const eventIdsAtRequestStart = new Set(
        (eventsRef.current as ReticulumChatHookEvent[])
          .map((event) => event.eventId)
          .filter((eventId): eventId is string => typeof eventId === 'string')
      );
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
      void window.reticulumChat
        ?.getMessageHistory?.(
          validGroupId,
          normalizedChannelId,
          RETICULUM_CHAT_INITIAL_HISTORY_LIMIT,
          { repairNetwork: false }
        )
        ?.then((history) => {
          if (
            cancelled ||
            historyWindowGenerationRef.current !==
              silenceHistoryWindowGeneration ||
            activeChatKeyRef.current !== expectedChatKey ||
            visibilityRevisionRef.current !== silenceVisibilityRevision ||
            !Array.isArray(history)
          ) {
            return;
          }
          const historyEvents = history as ReticulumChatHookEvent[];
          const concurrentEvents = concurrentEventsForReplacement(
            eventsRef.current as ReticulumChatHookEvent[],
            historyEvents,
            eventIdsAtRequestStart,
            true
          );
          replaceHistoryWindow(historyEvents, expectedChatKey, 'latest');
          if (concurrentEvents.length > 0) {
            mergeEvents(concurrentEvents, expectedChatKey);
          }
          updateHasNewer(false);
          setHasOlder(historyEvents.length > 0);
          void enrichVisibleEvents(historyEvents, expectedChatKey);
          setLoadedInitialHistoryKey(expectedChatKey);
        })
        .catch((error) => {
          if (
            !cancelled &&
            activeChatKeyRef.current === expectedChatKey &&
            historyWindowGenerationRef.current ===
              silenceHistoryWindowGeneration
          ) {
            setLoadedInitialHistoryKey(expectedChatKey);
          }
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
      void window.reticulumChat?.unsubscribeChannel?.(
        validGroupId,
        normalizedChannelId
      );
    };
  }, [
    enabled,
    enqueueIncomingEvent,
    enrichVisibleEvents,
    mergeEvents,
    normalizedChannelId,
    replaceHistoryWindow,
    updateHasNewer,
    updateHistoryMode,
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

    const unresolvedEvents = (
      eventsRef.current as ReticulumChatHookEvent[]
    ).filter((event) => {
      const address =
        typeof event.authorAddress === 'string' ? event.authorAddress : '';
      return address && !primaryNameCacheRef.current.get(address)?.trim();
    });
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
      const result = (await window.reticulumChat?.publishEvent?.(event)) ?? {
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
          const eventType =
            typeof chatEvent.eventType === 'string' ? chatEvent.eventType : '';
          const targetEventId =
            typeof chatEvent.targetEventId === 'string'
              ? chatEvent.targetEventId
              : '';
          const visibleTarget =
            !!targetEventId &&
            (eventsRef.current as ReticulumChatHookEvent[]).some(
              (visibleEvent) => visibleEvent.eventId === targetEventId
            );
          if (
            historyModeRef.current === 'anchored' &&
            hasNewerRef.current &&
            (eventType === 'message' ||
              eventType === 'attachment_manifest' ||
              !visibleTarget)
          ) {
            updateHasNewer(true);
          } else {
            mergeEvents([chatEvent], expectedChatKey);
            void enrichVisibleEvents([chatEvent], expectedChatKey);
          }
        }
      }
      return result;
    },
    [
      enabled,
      enrichVisibleEvents,
      mergeEvents,
      normalizedChannelId,
      updateHasNewer,
      validGroupId,
    ]
  );

  const loadOlder = useCallback(async () => {
    if (!enabled || validGroupId == null) return { added: 0 };
    if (loadingOlderRef.current) return { added: 0 };
    if (Date.now() < retryOlderAfterRef.current) return { added: 0 };

    const expectedChatKey = `${validGroupId}:${normalizedChannelId}`;
    const historyVisibilityRevision = visibilityRevisionRef.current;
    const historyWindowGeneration = historyWindowGenerationRef.current;
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
      const structuredPage =
        await window.reticulumChat?.getMessageHistoryPage?.(
          validGroupId,
          normalizedChannelId,
          RETICULUM_CHAT_OLDER_HISTORY_LIMIT,
          options
        );
      const history = structuredPage
        ? structuredPage.events
        : ((await window.reticulumChat?.getMessageHistory?.(
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
          )));
      if (
        activeChatKeyRef.current !== expectedChatKey ||
        historyWindowGenerationRef.current !== historyWindowGeneration ||
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
      if (activeChatKeyRef.current === expectedChatKey) {
        setHasOlder(
          structuredPage ? structuredPage.hasMore === true : added > 0
        );
      }
      return { added };
    } catch (error) {
      if (activeChatKeyRef.current === expectedChatKey) {
        retryOlderAfterRef.current =
          Date.now() + RETICULUM_CHAT_EMPTY_OLDER_RETRY_MS;
      }
      console.warn(
        '[useReticulumGroupChat] Failed to load older messages:',
        error
      );
      return { added: 0 };
    } finally {
      if (
        activeChatKeyRef.current === expectedChatKey &&
        historyWindowGenerationRef.current === historyWindowGeneration
      ) {
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
    replaceHistoryWindow,
    updateHasNewer,
    validGroupId,
  ]);

  const loadNewer = useCallback(async () => {
    if (!enabled || validGroupId == null) return { added: 0 };
    if (loadingNewerRef.current || !hasNewerRef.current) return { added: 0 };
    const newest = getNewestCursor();
    if (!newest) return { added: 0 };
    const expectedChatKey = `${validGroupId}:${normalizedChannelId}`;
    const historyVisibilityRevision = visibilityRevisionRef.current;
    const historyWindowGeneration = historyWindowGenerationRef.current;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    try {
      const options = {
        afterTimestamp: newest.timestamp,
        afterEventId: newest.eventId,
        repairNetwork: true,
      };
      const structuredPage =
        await window.reticulumChat?.getMessageHistoryPage?.(
          validGroupId,
          normalizedChannelId,
          RETICULUM_CHAT_NEWER_HISTORY_LIMIT,
          options
        );
      const history = structuredPage
        ? structuredPage.events
        : ((await window.reticulumChat?.getMessageHistory?.(
            validGroupId,
            normalizedChannelId,
            RETICULUM_CHAT_NEWER_HISTORY_LIMIT,
            options
          )) ?? []);
      if (
        activeChatKeyRef.current !== expectedChatKey ||
        historyWindowGenerationRef.current !== historyWindowGeneration ||
        visibilityRevisionRef.current !== historyVisibilityRevision
      ) {
        return { added: 0 };
      }
      if (!Array.isArray(history) || history.length === 0) {
        updateHasNewer(false);
        updateHistoryMode('latest');
        return { added: 0 };
      }
      const historyEvents = history as ReticulumChatHookEvent[];
      const added = mergeEvents(historyEvents, expectedChatKey);
      void enrichVisibleEvents(historyEvents, expectedChatKey);
      const more = structuredPage ? structuredPage.hasMore === true : added > 0;
      updateHasNewer(more);
      if (!more) updateHistoryMode('latest');
      return { added };
    } catch (error) {
      console.warn(
        '[useReticulumGroupChat] Failed to load newer messages:',
        error
      );
      return { added: 0 };
    } finally {
      if (
        activeChatKeyRef.current === expectedChatKey &&
        historyWindowGenerationRef.current === historyWindowGeneration
      ) {
        loadingNewerRef.current = false;
        setLoadingNewer(false);
      }
    }
  }, [
    enabled,
    enrichVisibleEvents,
    getNewestCursor,
    mergeEvents,
    normalizedChannelId,
    updateHasNewer,
    updateHistoryMode,
    validGroupId,
  ]);

  const jumpToLatest = useCallback(async () => {
    if (!enabled || validGroupId == null) return { success: false };
    const expectedChatKey = `${validGroupId}:${normalizedChannelId}`;
    const historyVisibilityRevision = visibilityRevisionRef.current;
    const historyWindowGeneration = ++historyWindowGenerationRef.current;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    const eventIdsAtRequestStart = new Set(
      (eventsRef.current as ReticulumChatHookEvent[])
        .map((event) => event.eventId)
        .filter((eventId): eventId is string => typeof eventId === 'string')
    );
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    try {
      const structuredPage =
        await window.reticulumChat?.getMessageHistoryPage?.(
          validGroupId,
          normalizedChannelId,
          RETICULUM_CHAT_INITIAL_HISTORY_LIMIT,
          { repairNetwork: true }
        );
      const history = structuredPage
        ? structuredPage.events
        : ((await window.reticulumChat?.getMessageHistory?.(
            validGroupId,
            normalizedChannelId,
            RETICULUM_CHAT_INITIAL_HISTORY_LIMIT,
            { repairNetwork: true }
          )) ?? []);
      if (
        activeChatKeyRef.current !== expectedChatKey ||
        historyWindowGenerationRef.current !== historyWindowGeneration ||
        visibilityRevisionRef.current !== historyVisibilityRevision ||
        !Array.isArray(history)
      ) {
        return { success: false };
      }
      const historyEvents = history as ReticulumChatHookEvent[];
      const concurrentEvents = concurrentEventsForReplacement(
        eventsRef.current as ReticulumChatHookEvent[],
        historyEvents,
        eventIdsAtRequestStart,
        true
      );
      if (!replaceHistoryWindow(historyEvents, expectedChatKey, 'latest')) {
        return { success: false };
      }
      if (concurrentEvents.length > 0) {
        mergeEvents(concurrentEvents, expectedChatKey);
      }
      setHasOlder(
        structuredPage
          ? structuredPage.hasMore === true
          : historyEvents.length > 0
      );
      updateHasNewer(false);
      void enrichVisibleEvents(historyEvents, expectedChatKey);
      return { success: true };
    } catch (error) {
      console.warn(
        '[useReticulumGroupChat] Failed to jump to latest messages:',
        error
      );
      return { success: false };
    } finally {
      if (
        activeChatKeyRef.current === expectedChatKey &&
        historyWindowGenerationRef.current === historyWindowGeneration
      ) {
        loadingNewerRef.current = false;
        setLoadingNewer(false);
      }
    }
  }, [
    enabled,
    enrichVisibleEvents,
    mergeEvents,
    normalizedChannelId,
    replaceHistoryWindow,
    updateHasNewer,
    validGroupId,
  ]);

  const openAroundEvent = useCallback(
    async (
      eventId: string,
      options: { beforeLimit?: number; afterLimit?: number } = {}
    ) => {
      if (!enabled || validGroupId == null || !eventId) {
        return { success: false };
      }
      const expectedChatKey = `${validGroupId}:${normalizedChannelId}`;
      const historyVisibilityRevision = visibilityRevisionRef.current;
      const historyWindowGeneration = ++historyWindowGenerationRef.current;
      loadingOlderRef.current = false;
      loadingNewerRef.current = false;
      setLoadingOlder(false);
      setLoadingNewer(false);
      const eventIdsAtRequestStart = new Set(
        (eventsRef.current as ReticulumChatHookEvent[])
          .map((event) => event.eventId)
          .filter((knownEventId): knownEventId is string =>
            Boolean(knownEventId)
          )
      );
      const requestedBeforeLimit = Number(options.beforeLimit ?? 80);
      const requestedAfterLimit = Number(options.afterLimit ?? 40);
      const beforeLimit = Number.isFinite(requestedBeforeLimit)
        ? Math.max(0, Math.floor(requestedBeforeLimit))
        : 80;
      const afterLimit = Number.isFinite(requestedAfterLimit)
        ? Math.max(0, Math.floor(requestedAfterLimit))
        : 40;
      try {
        const structuredPage =
          await window.reticulumChat?.getMessageWindowPageAroundEvent?.(
            validGroupId,
            normalizedChannelId,
            eventId,
            { beforeLimit, afterLimit }
          );
        let history: unknown[];
        let hasOlder: boolean;
        let hasNewerValue: boolean;
        if (structuredPage) {
          history = Array.isArray(structuredPage.events)
            ? structuredPage.events
            : [];
          hasOlder = structuredPage.hasOlder === true;
          hasNewerValue = structuredPage.hasNewer === true;
        } else {
          const fallback =
            (await window.reticulumChat?.getMessageWindowAroundEvent?.(
              validGroupId,
              normalizedChannelId,
              eventId,
              {
                beforeLimit: beforeLimit + 1,
                afterLimit: afterLimit + 1,
              }
            )) ?? [];
          const targetIndex = fallback.findIndex(
            (event: any) => event?.eventId === eventId
          );
          if (targetIndex < 0) return { success: false };
          const before = fallback.slice(0, targetIndex);
          const after = fallback.slice(targetIndex + 1);
          hasOlder = before.length > beforeLimit;
          hasNewerValue = after.length > afterLimit;
          history = [
            ...(beforeLimit > 0 ? before.slice(-beforeLimit) : []),
            fallback[targetIndex],
            ...after.slice(0, afterLimit),
          ];
        }
        if (
          activeChatKeyRef.current !== expectedChatKey ||
          historyWindowGenerationRef.current !== historyWindowGeneration ||
          visibilityRevisionRef.current !== historyVisibilityRevision ||
          !history.some((event: any) => event?.eventId === eventId)
        ) {
          return { success: false };
        }
        const historyEvents = history as ReticulumChatHookEvent[];
        const concurrentEvents = concurrentEventsForReplacement(
          eventsRef.current as ReticulumChatHookEvent[],
          historyEvents,
          eventIdsAtRequestStart,
          !hasNewerValue
        );
        const oldestWindowCursor = messageCursorAt(historyEvents, 'oldest');
        const concurrentOlderRoot = Boolean(
          oldestWindowCursor &&
          concurrentEvents.some((event) => {
            if (
              event.eventType !== 'message' &&
              event.eventType !== 'attachment_manifest'
            ) {
              return false;
            }
            const timestamp = Number(event.timestamp);
            const concurrentEventId =
              typeof event.eventId === 'string' ? event.eventId : '';
            return (
              !!concurrentEventId &&
              Number.isFinite(timestamp) &&
              (timestamp < oldestWindowCursor.timestamp ||
                (timestamp === oldestWindowCursor.timestamp &&
                  concurrentEventId < oldestWindowCursor.eventId))
            );
          })
        );
        if (!replaceHistoryWindow(historyEvents, expectedChatKey, 'anchored')) {
          return { success: false };
        }
        if (concurrentEvents.length > 0) {
          mergeEvents(concurrentEvents, expectedChatKey);
        }
        setHasOlder(hasOlder || concurrentOlderRoot);
        updateHasNewer(hasNewerValue);
        if (!hasNewerValue) updateHistoryMode('latest');
        void enrichVisibleEvents(historyEvents, expectedChatKey);
        return { success: true };
      } catch (error) {
        console.warn(
          '[useReticulumGroupChat] Failed to open message window:',
          error
        );
        return { success: false };
      }
    },
    [
      enabled,
      enrichVisibleEvents,
      mergeEvents,
      normalizedChannelId,
      replaceHistoryWindow,
      updateHasNewer,
      updateHistoryMode,
      validGroupId,
    ]
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
    hasNewer,
    historyMode,
    historyWindowRevision,
    initialHistoryReady:
      activeChatKey !== '' && loadedInitialHistoryKey === activeChatKey,
    loadingOlder,
    loadingNewer,
    loadOlder,
    loadNewer,
    jumpToLatest,
    openAroundEvent,
    typing,
    visibilityChange,
    discussionIndex,
    getDiscussionMessages,
    publishEvent,
    sendTyping,
  };
}
