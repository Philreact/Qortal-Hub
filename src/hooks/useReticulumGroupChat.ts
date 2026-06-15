import { useCallback, useEffect, useRef, useState } from 'react';
import { getPrimaryNamesForAddresses } from '../components/Group/groupApi';

const RETICULUM_CHAT_EVENT_BATCH_MS = 400;

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

export function useReticulumGroupChat(groupId?: number | string | null) {
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
    void window.reticulumChat?.isEnabled?.().then((value) => {
      if (!cancelled) setEnabled(value === true);
    });
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
    void window.reticulumChat?.setLocalGroupMemberships?.([validGroupId]);
    void window.reticulumChat?.subscribeGroup?.(validGroupId);
    void window.reticulumChat?.getHistory?.(validGroupId, 200).then(async (history) => {
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
      enqueueIncomingEvent(event);
    });
    const offTyping = window.reticulumChat?.onTyping?.((payload) => {
      if (payload.groupId !== validGroupId) return;
      setTyping((prev) => ({
        ...prev,
        [payload.authorAddress]: payload.active,
      }));
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
    };
  }, [enabled, enqueueIncomingEvent, validGroupId]);

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
        if (Number(chatEvent?.groupId) === validGroupId) {
          const enriched = await addPrimaryNamesToEvents(
            [chatEvent],
            primaryNameCacheRef.current
          );
          setEvents((prev) => mergeReticulumEvents(prev, enriched));
        }
      }
      return result;
    },
    [enabled, validGroupId]
  );

  const sendTyping = useCallback(
    async (authorAddress: string, active: boolean) => {
      if (!enabled || validGroupId == null) {
        return { success: false, error: 'Reticulum chat is disabled' };
      }
      return (
        (await window.reticulumChat?.sendTyping?.(
          validGroupId,
          authorAddress,
          active
        )) ?? {
          success: false,
          error: 'Reticulum chat API unavailable',
        }
      );
    },
    [enabled, validGroupId]
  );

  return {
    enabled,
    events,
    typing,
    publishEvent,
    sendTyping,
  };
}
