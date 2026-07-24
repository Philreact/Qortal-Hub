import { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MessageItem } from './MessageItem';
import { subscribeToEvent, unsubscribeFromEvent } from '../../utils/events';
import { Box, Button, Typography, useTheme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded';
import { ChatOptions } from './ChatOptions';
import ErrorBoundary from '../../common/ErrorBoundary';
import { useTranslation } from 'react-i18next';

type ReactionItem = {
  sender: string;
  senderName?: string;
};

export type ReactionsMap = {
  [reactionType: string]: ReactionItem[];
};

const getMessageTimestampMs = (message: any): number | null => {
  const value = Number(message?.timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const isReticulumMessageContinuation = (
  previousMessage: any,
  message: any
): boolean => {
  if (
    !previousMessage ||
    !message ||
    previousMessage?.divide ||
    message?.divide
  ) {
    return false;
  }
  if (!previousMessage?.sender || previousMessage.sender !== message?.sender) {
    return false;
  }
  const previousSystemType =
    previousMessage?.qchatSystem?.type ||
    previousMessage?.decryptedData?.qchatSystem?.type;
  const systemType =
    message?.qchatSystem?.type || message?.decryptedData?.qchatSystem?.type;
  if (previousSystemType || systemType) return false;

  const previousTimestamp = getMessageTimestampMs(previousMessage);
  const timestamp = getMessageTimestampMs(message);
  if (previousTimestamp === null || timestamp === null) return false;

  const elapsed = timestamp - previousTimestamp;
  return elapsed >= 0 && elapsed <= 2 * 60 * 1000;
};

type ChatListProps = {
  [key: string]: any;
  initialMessages: any;
  myAddress: any;
  tempMessages: any;
  onReply: any;
  onEdit: any;
  onDelete?: any;
  handleReaction: any;
  chatReferences: any;
  tempChatReferences: any;
  members?: any;
  myName?: any;
  selectedGroup?: any;
  enableMentions?: any;
  openQManager?: any;
  onAcceptQchatFileTransfer?: (message: any) => void;
  qchatFileTransferStates?: Record<string, any>;
  qchatCompletedTransfers?: Record<string, any>;
  hasSecretKey?: any;
  isPrivate?: any;
  reticulumChatEnabled?: boolean;
  reticulumInitialHistoryReady?: boolean;
  reticulumGroupAvatarOwnerName?: string;
  reticulumGroupDisplayName?: string;
  reticulumMentionUsers?: Record<string, { address: string; name?: string }>;
  reticulumMemberJoinedByAddress?: Record<string, number>;
  reticulumMemberRolesByAddress?: Record<string, 'owner' | 'admin'>;
  reticulumMemberRolesReady?: boolean;
  reticulumUnreadCount?: number;
  onReticulumUnreadAcknowledged?: () => void;
  reticulumDiscussionReplyCounts?: Record<string, number>;
  onOpenReticulumDiscussion?: (message: any) => void;
  secretKeyObject?: any;
  compactScrollButton?: boolean;
  chatId?: any;
  hasOlderMessages?: boolean;
  isLoadingOlderMessages?: boolean;
  onLoadOlder?: () =>
    | void
    | { added?: number }
    | Promise<void | { added?: number }>;
  scrollToMessageId?: string;
  scrollToMessageNonce?: number;
};

export const ChatList = ({
  initialMessages,
  myAddress,
  tempMessages,
  onReply,
  onEdit,
  onDelete,
  handleReaction,
  chatReferences,
  tempChatReferences,
  members,
  myName,
  selectedGroup,
  enableMentions,
  openQManager,
  onAcceptQchatFileTransfer,
  qchatFileTransferStates,
  qchatCompletedTransfers,
  hasSecretKey,
  isPrivate,
  reticulumChatEnabled = false,
  reticulumInitialHistoryReady = true,
  reticulumGroupAvatarOwnerName,
  reticulumGroupDisplayName,
  reticulumMentionUsers,
  reticulumMemberJoinedByAddress,
  reticulumMemberRolesByAddress,
  reticulumMemberRolesReady = true,
  reticulumUnreadCount = 0,
  onReticulumUnreadAcknowledged,
  reticulumDiscussionReplyCounts,
  onOpenReticulumDiscussion,
  secretKeyObject,
  compactScrollButton = false,
  chatId,
  hasOlderMessages,
  isLoadingOlderMessages = false,
  onLoadOlder,
  scrollToMessageId,
  scrollToMessageNonce,
}: ChatListProps) => {
  const theme = useTheme();
  const parentRef = useRef(null);
  const [messages, setMessages] = useState(initialMessages);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [showScrollDownButton, setShowScrollDownButton] = useState(false);
  const [highlightedMessageIndex, setHighlightedMessageIndex] = useState<
    number | null
  >(null);
  const [reticulumUnreadBoundaryIndex, setReticulumUnreadBoundaryIndex] =
    useState<number | null>(null);
  const hasLoadedInitialRef = useRef(false);
  const scrollingIntervalRef = useRef(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const scrollRetryTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scrollRetryFrameRef = useRef<number | null>(null);
  const scrollRetrySequenceRef = useRef(0);
  const lastHandledScrollTargetRef = useRef('');
  const lastSeenUnreadMessageTimestamp = useRef(null);
  const loadingOlderFromScrollRef = useRef(false);
  const lastAutoFillMessageCountRef = useRef(-1);
  const previousMessageCountRef = useRef(0);
  const reticulumUnreadPromptShownRef = useRef(false);
  const pendingInitialReticulumBottomRef = useRef(false);
  const pendingInitialReticulumUnreadIndexRef = useRef<number | null>(null);
  const initialReticulumRevealTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [positionedReticulumChatIdentity, setPositionedReticulumChatIdentity] =
    useState('');

  const chatIdentity = useMemo(() => {
    if (chatId != null) {
      if (typeof chatId === 'object') {
        if (chatId.groupId != null) return `group:${chatId.groupId}`;
        if (chatId.id != null) return `chat:${chatId.id}`;
        if (chatId.address != null) return `direct:${chatId.address}`;
      }
      return String(chatId);
    }
    if (selectedGroup?.groupId != null) return `group:${selectedGroup.groupId}`;
    if (selectedGroup?.id != null) return `group:${selectedGroup.id}`;
    return 'chat';
  }, [chatId, selectedGroup?.groupId, selectedGroup?.id]);

  // Shared scroll button styling (memoized so Button sx refs stay stable)
  const scrollButtonSx = useMemo(
    () => ({
      position: 'absolute' as const,
      right: 20,
      bottom: 20,
      zIndex: 10,
      borderRadius: '24px',
      textTransform: 'none' as const,
      fontWeight: 600,
      fontSize: '0.875rem',
      px: 2,
      py: 1.25,
      boxShadow:
        theme.palette.mode === 'dark'
          ? '0 4px 20px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08)'
          : '0 4px 14px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06)',
      backgroundColor: theme.palette.background.paper,
      color: theme.palette.text.primary,
      border: `1px solid ${theme.palette.divider}`,
      transition:
        'box-shadow 0.2s ease, transform 0.15s ease, background-color 0.2s ease',
      '&:hover': {
        backgroundColor: theme.palette.action.hover,
        boxShadow:
          theme.palette.mode === 'dark'
            ? `0 6px 24px rgba(0,0,0,0.5), 0 0 0 1px ${theme.palette.primary.main}40`
            : `0 6px 20px rgba(0,0,0,0.15), 0 0 0 1px ${theme.palette.primary.light}60`,
      },
      '&:active': {
        transform: 'scale(0.98)',
      },
    }),
    [theme]
  );
  const scrollButtonCompactSx = useMemo(
    () => ({
      ...scrollButtonSx,
      right: 16,
      bottom: 16,
      borderRadius: '50%',
      px: 0,
      py: 0,
      minWidth: 40,
      width: 40,
      height: 40,
      '& .MuiButton-startIcon': { margin: 0 },
    }),
    [scrollButtonSx]
  );
  const getMessageKey = useCallback(
    (message: any, index: number) =>
      message?.tempSignature ||
      message?.signature ||
      message?.identifier ||
      `${chatIdentity}:row:${index}`,
    [chatIdentity]
  );

  // Initialize the virtualizer
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getItemKey: (index) => getMessageKey(messages[index], index),
    getScrollElement: () => parentRef?.current,
    estimateSize: useCallback(() => 80, []), // Provide an estimated height of items, adjust this as needed
    overscan: 10, // Number of items to render outside the visible area to improve smoothness
    // Keep the visible Reticulum content anchored when a reply preview or image
    // above the viewport settles to a different measured height.
    shouldAdjustScrollPositionOnItemSizeChange: (item, _delta, instance) => {
      if (!reticulumChatEnabled) return true;
      return (
        item.start < instance.getScrollOffset() + instance.scrollAdjustments
      );
    },
  });

  const clearScrollRetries = useCallback(() => {
    scrollRetrySequenceRef.current += 1;
    if (scrollRetryFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRetryFrameRef.current);
      scrollRetryFrameRef.current = null;
    }
    scrollRetryTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    scrollRetryTimeoutsRef.current = [];
  }, []);

  const clearInitialReticulumReveal = useCallback(() => {
    if (initialReticulumRevealTimeoutRef.current) {
      window.clearTimeout(initialReticulumRevealTimeoutRef.current);
      initialReticulumRevealTimeoutRef.current = null;
    }
  }, []);

  const scrollToIndexAfterMeasurements = useCallback(
    (
      index: number,
      align: 'start' | 'end' = 'end',
      retryDelays: number[] = [50, 150, 350, 700]
    ) => {
      if (index < 0) return;

      clearScrollRetries();
      const sequence = scrollRetrySequenceRef.current;
      const scroll = () => {
        if (scrollRetrySequenceRef.current !== sequence) return;
        rowVirtualizer.scrollToIndex(index, { align });
      };

      scroll();
      scrollRetryFrameRef.current = window.requestAnimationFrame(scroll);
      retryDelays.forEach((delay) => {
        const timeoutId = window.setTimeout(scroll, delay);
        scrollRetryTimeoutsRef.current.push(timeoutId);
      });
    },
    [clearScrollRetries, rowVirtualizer]
  );

  useEffect(() => {
    hasLoadedInitialRef.current = false;
    lastSeenUnreadMessageTimestamp.current = null;
    previousMessageCountRef.current = 0;
    reticulumUnreadPromptShownRef.current = false;
    pendingInitialReticulumBottomRef.current = false;
    pendingInitialReticulumUnreadIndexRef.current = null;
    setReticulumUnreadBoundaryIndex(null);
    setPositionedReticulumChatIdentity('');
    clearInitialReticulumReveal();
    clearScrollRetries();
  }, [chatIdentity, clearInitialReticulumReveal, clearScrollRetries]);

  useEffect(() => {
    return () => {
      clearScrollRetries();
      clearInitialReticulumReveal();
    };
  }, [clearInitialReticulumReveal, clearScrollRetries]);

  const isAtBottom = useMemo(() => {
    if (parentRef.current && rowVirtualizer?.isScrolling !== undefined) {
      const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 10; // Adjust threshold as needed
      return atBottom;
    }

    return false;
  }, [rowVirtualizer?.isScrolling]);

  const isPinnedToBottom = useCallback(() => {
    const scrollElement = parentRef.current as HTMLDivElement | null;
    if (!scrollElement) return false;

    // Reticulum follows only when the reader is actually at the end. A tiny
    // tolerance accounts for sub-pixel layout without treating an upward read
    // position as pinned.
    return (
      scrollElement.scrollHeight -
        scrollElement.scrollTop -
        scrollElement.clientHeight <=
      4
    );
  }, []);

  const loadOlderFromTop = useCallback(async () => {
    if (!onLoadOlder) return;
    if (hasOlderMessages === false) return;
    if (isLoadingOlderMessages || loadingOlderFromScrollRef.current) return;

    const scrollElement = parentRef.current as HTMLDivElement | null;
    if (!scrollElement) return;

    const previousScrollHeight = scrollElement.scrollHeight;
    const previousScrollTop = scrollElement.scrollTop;
    loadingOlderFromScrollRef.current = true;
    try {
      await onLoadOlder();
      window.requestAnimationFrame(() => {
        const nextScrollElement = parentRef.current as HTMLDivElement | null;
        if (!nextScrollElement) return;
        const heightDelta =
          nextScrollElement.scrollHeight - previousScrollHeight;
        if (heightDelta > 0) {
          nextScrollElement.scrollTop = previousScrollTop + heightDelta;
        }
      });
    } finally {
      loadingOlderFromScrollRef.current = false;
    }
  }, [hasOlderMessages, isLoadingOlderMessages, onLoadOlder]);

  const handleScroll = useCallback(() => {
    const scrollElement = parentRef.current as HTMLDivElement | null;
    if (!scrollElement) return;
    if (scrollElement.scrollTop <= 160) {
      void loadOlderFromTop();
    }
  }, [loadOlderFromTop]);

  const cancelReticulumScrollRetries = useCallback(() => {
    if (!reticulumChatEnabled) return;
    clearScrollRetries();
    const scrollElement = parentRef.current as HTMLDivElement | null;
    if (!scrollElement) return;
    // scrollToIndex owns an additional internal retry timer in dynamic mode.
    // Reasserting the current offset cancels that target without moving the
    // reader, so a previous bottom/search jump cannot fight manual scrolling.
    rowVirtualizer.scrollToOffset(scrollElement.scrollTop, { align: 'start' });
  }, [clearScrollRetries, reticulumChatEnabled, rowVirtualizer]);

  useEffect(() => {
    if (!onLoadOlder || hasOlderMessages === false) return;
    const scrollElement = parentRef.current as HTMLDivElement | null;
    if (!scrollElement) return;
    if (lastAutoFillMessageCountRef.current === messages.length) return;
    if (scrollElement.scrollHeight > scrollElement.clientHeight + 32) return;
    lastAutoFillMessageCountRef.current = messages.length;
    void loadOlderFromTop();
  }, [hasOlderMessages, loadOlderFromTop, messages.length, onLoadOlder]);

  useEffect(() => {
    if (!parentRef.current || rowVirtualizer?.isScrolling === undefined) return;
    if (isAtBottom) {
      if (scrollingIntervalRef.current) {
        clearTimeout(scrollingIntervalRef.current);
      }
      setShowScrollDownButton(false);
      return;
    } else if (rowVirtualizer?.isScrolling) {
      if (scrollingIntervalRef.current) {
        clearTimeout(scrollingIntervalRef.current);
      }
      setShowScrollDownButton(false);
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight <= 300;
    if (!atBottom) {
      scrollingIntervalRef.current = setTimeout(() => {
        setShowScrollDownButton(true);
      }, 250);
    } else {
      setShowScrollDownButton(false);
    }
  }, [rowVirtualizer?.isScrolling, isAtBottom]);

  // Update message list with unique signatures and tempMessages
  useEffect(() => {
    if (reticulumChatEnabled && !reticulumInitialHistoryReady) {
      previousMessageCountRef.current = 0;
      setMessages([]);
      return;
    }

    const uniqueInitialMessagesMap = new Map();

    // Only add a message if it doesn't already exist in the Map
    initialMessages.forEach((message) => {
      if (!message || typeof message !== 'object') return;
      const signature = message.signature || message.tempSignature;
      if (!signature) return;
      if (!uniqueInitialMessagesMap.has(signature)) {
        uniqueInitialMessagesMap.set(signature, message);
      }
    });

    const uniqueInitialMessages = Array.from(uniqueInitialMessagesMap.values())
      .filter((message) => {
        const directType =
          message?.type ||
          message?.decryptedData?.type ||
          message?.decryptedData?.data?.type;
        const directStatus =
          message?.status ||
          message?.data?.status ||
          message?.decryptedData?.status ||
          message?.decryptedData?.data?.status ||
          message?.decryptedData?.data?.data?.status;
        return !(
          directType === 'qchat-dm-file-transfer' && directStatus === 'accepted'
        );
      })
      .sort((a, b) => a.timestamp - b.timestamp);
    const totalMessages = [
      ...uniqueInitialMessages,
      ...(tempMessages || []),
    ].filter(
      (message) =>
        message &&
        typeof message === 'object' &&
        (message.signature || message.tempSignature)
    );

    if (totalMessages.length === 0) {
      previousMessageCountRef.current = 0;
      setMessages([]);
      setShowScrollButton(false);
      setShowScrollDownButton(false);
      if (reticulumChatEnabled) {
        setPositionedReticulumChatIdentity(chatIdentity);
      }
      return;
    }

    const hasNewMessages =
      hasLoadedInitialRef.current &&
      totalMessages.length > previousMessageCountRef.current;
    const latestMessage = totalMessages[totalMessages.length - 1];
    const isLatestMessageMine =
      latestMessage?.sender === myAddress ||
      latestMessage?.message?.sender === myAddress;
    const followIncomingReticulumMessages =
      reticulumChatEnabled &&
      hasNewMessages &&
      (isPinnedToBottom() || isLatestMessageMine);
    previousMessageCountRef.current = totalMessages.length;

    setMessages(totalMessages);

    const updateTimeout = window.setTimeout(
      () => {
        if (followIncomingReticulumMessages) {
          scrollToBottom(totalMessages, undefined, true, isLatestMessageMine);
          return;
        }

        const isInitialLoad = !hasLoadedInitialRef.current;
        const initialReticulumUnreadCount = Math.max(
          0,
          Number(reticulumUnreadCount) || 0
        );
        const initialReticulumUnreadIndexes = totalMessages.reduce<number[]>(
          (indexes, message, index) => {
            if (
              !message?.chatReference &&
              !message?.isTemp &&
              message?.sender !== myAddress
            ) {
              indexes.push(index);
            }
            return indexes;
          },
          []
        );
        const shouldAcknowledgeInitialReticulumUnread =
          reticulumChatEnabled &&
          !reticulumUnreadPromptShownRef.current &&
          initialReticulumUnreadCount > 0 &&
          initialReticulumUnreadIndexes.length > 0;
        const firstReticulumUnreadIndex =
          shouldAcknowledgeInitialReticulumUnread
            ? initialReticulumUnreadIndexes[
                Math.max(
                  0,
                  initialReticulumUnreadIndexes.length -
                    initialReticulumUnreadCount
                )
              ]
            : null;

        if (
          typeof firstReticulumUnreadIndex === 'number' &&
          Number.isInteger(firstReticulumUnreadIndex)
        ) {
          reticulumUnreadPromptShownRef.current = true;
          pendingInitialReticulumUnreadIndexRef.current =
            firstReticulumUnreadIndex;
          setReticulumUnreadBoundaryIndex(firstReticulumUnreadIndex);
          onReticulumUnreadAcknowledged?.();
        }

        const hasUnreadMessages = totalMessages.some(
          (msg) =>
            msg.unread &&
            !msg?.chatReference &&
            !msg?.isTemp &&
            ((!msg?.chatReference &&
              msg?.timestamp > lastSeenUnreadMessageTimestamp.current) ||
              0)
        );

        if (reticulumChatEnabled) {
          // Reticulum maintains its own unread boundary and prompt. Do not let
          // the legacy Q-Chat unread button compete with its landing scroll.
          setShowScrollButton(false);
        } else if (parentRef.current) {
          const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
          const atBottom = scrollTop + clientHeight >= scrollHeight - 10; // Adjust threshold as needed
          if (!atBottom && hasUnreadMessages) {
            setShowScrollButton(hasUnreadMessages);
            setShowScrollDownButton(false);
          } else {
            handleMessageSeen();
          }
        }
        if (isInitialLoad) {
          if (scrollToMessageId && !reticulumChatEnabled) {
            hasLoadedInitialRef.current = true;
            return;
          }
          const reticulumScrollTargetIndex =
            reticulumChatEnabled && scrollToMessageId
              ? totalMessages.findIndex(
                  (message) =>
                    message.signature === scrollToMessageId ||
                    message.tempSignature === scrollToMessageId ||
                    message.identifier === scrollToMessageId ||
                    message.message?.signature === scrollToMessageId
                )
              : -1;
          const findDivideIndex = totalMessages.findIndex(
            (item) => !!item?.divide
          );
          const divideIndex = reticulumChatEnabled
            ? undefined
            : findDivideIndex !== -1
              ? findDivideIndex
              : undefined;
          if (reticulumChatEnabled) {
            // Position the hidden Reticulum viewport before revealing it. This
            // prevents history, stale rows, and virtual row measurements from
            // becoming visible as a sequence of scroll jumps.
            const unreadIndex = pendingInitialReticulumUnreadIndexRef.current;
            pendingInitialReticulumUnreadIndexRef.current = null;
            pendingInitialReticulumBottomRef.current = false;
            window.requestAnimationFrame(() => {
              if (reticulumScrollTargetIndex >= 0) {
                scrollToIndexAfterMeasurements(
                  reticulumScrollTargetIndex,
                  'start',
                  [30, 60]
                );
              } else if (typeof unreadIndex === 'number') {
                scrollToIndexAfterMeasurements(unreadIndex, 'start', [30, 60]);
              } else {
                // Let the virtualizer keep the final row targeted while its
                // estimated message heights are replaced with measurements.
                // Its dynamic scrollToIndex correction stops as soon as the
                // measured end offset matches, and manual input cancels it via
                // cancelReticulumScrollRetries.
                scrollToIndexAfterMeasurements(
                  totalMessages.length - 1,
                  'end',
                  [30, 60]
                );
              }
              clearInitialReticulumReveal();
              initialReticulumRevealTimeoutRef.current = window.setTimeout(
                () => {
                  clearScrollRetries();
                  setPositionedReticulumChatIdentity(chatIdentity);
                  initialReticulumRevealTimeoutRef.current = null;
                },
                90
              );
            });
          } else {
            scrollToBottom(totalMessages, divideIndex, true);
          }
          hasLoadedInitialRef.current = true;
        }
      },
      reticulumChatEnabled ? 100 : 500
    );

    return () => {
      window.clearTimeout(updateTimeout);
    };
  }, [
    chatIdentity,
    initialMessages,
    isPinnedToBottom,
    myAddress,
    onReticulumUnreadAcknowledged,
    reticulumChatEnabled,
    reticulumInitialHistoryReady,
    reticulumUnreadCount,
    tempMessages,
    scrollToMessageId,
    clearInitialReticulumReveal,
    clearScrollRetries,
    scrollToIndexAfterMeasurements,
  ]);

  const scrollToBottom = (
    initialMsgs?: unknown[],
    divideIndex?: number,
    markSeen = true,
    settleReticulumLayout = false
  ) => {
    const index = initialMsgs ? initialMsgs.length - 1 : messages.length - 1;
    if (reticulumChatEnabled && divideIndex === undefined) {
      clearScrollRetries();
      const pinToBottom = () => {
        const scrollElement = parentRef.current as HTMLDivElement | null;
        if (!scrollElement) return;
        // Directly pinning avoids scrollToIndex's recursive dynamic-size retry.
        // Scheduled calls below still follow late Reticulum row measurements.
        scrollElement.scrollTop = scrollElement.scrollHeight;
      };
      pinToBottom();
      scrollRetryFrameRef.current = window.requestAnimationFrame(() => {
        pinToBottom();
        scrollRetryFrameRef.current = window.requestAnimationFrame(pinToBottom);
      });
      // Invite previews and message media can finish measuring after the first
      // virtualizer pass. Only hold the initial channel landing at the bottom
      // long enough for those rows to settle; regular incoming messages keep
      // the immediate, non-intrusive follow behavior.
      if (settleReticulumLayout) {
        [80, 220, 500, 950, 1500].forEach((delay) => {
          const timeoutId = window.setTimeout(pinToBottom, delay);
          scrollRetryTimeoutsRef.current.push(timeoutId);
        });
      }
    } else if (rowVirtualizer) {
      if (divideIndex !== undefined) {
        scrollToIndexAfterMeasurements(divideIndex, 'start');
      } else {
        scrollToIndexAfterMeasurements(
          index,
          'end',
          reticulumChatEnabled && !initialMsgs ? [50] : [50, 150, 350, 700]
        );
      }
    }
    if (markSeen) handleMessageSeen();
  };

  const handleMessageSeen = useCallback(() => {
    setMessages((prevMessages) =>
      prevMessages.map((msg) => ({
        ...msg,
        unread: false,
      }))
    );
    setShowScrollButton(false);
    lastSeenUnreadMessageTimestamp.current = Date.now();
  }, []);

  const sentNewMessageGroupFunc = useCallback(() => {
    // Reticulum follows locally-authored messages from the state update above.
    // The legacy event can run before the optimistic row has mounted and pull
    // the reader back to the previous last message.
    if (reticulumChatEnabled) return;
    const { scrollHeight, scrollTop, clientHeight } = parentRef.current;

    // Check if the user is within 200px from the bottom
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    if (distanceFromBottom <= 700) {
      scrollToBottom();
    }
  }, [messages, reticulumChatEnabled]);

  useEffect(() => {
    subscribeToEvent('sent-new-message-group', sentNewMessageGroupFunc);
    return () => {
      unsubscribeFromEvent('sent-new-message-group', sentNewMessageGroupFunc);
    };
  }, [sentNewMessageGroupFunc]);

  const lastSignature = useMemo(() => {
    if (!messages || messages?.length === 0) return null;
    const lastIndex = messages.length - 1;
    return messages[lastIndex]?.signature;
  }, [messages]);

  const goToMessage = useCallback((idx: number) => {
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }
    rowVirtualizer.scrollToIndex(idx);
    setHighlightedMessageIndex(idx);
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedMessageIndex(null);
      highlightTimeoutRef.current = null;
    }, 1200);
  }, []);

  useEffect(() => {
    if (!scrollToMessageId) return;
    const targetRequestKey = `${scrollToMessageId}:${
      scrollToMessageNonce ?? 0
    }`;
    if (lastHandledScrollTargetRef.current === targetRequestKey) return;
    const targetIndex = messages.findIndex((message) => {
      if (!message || typeof message !== 'object') return false;
      return (
        message.signature === scrollToMessageId ||
        message.tempSignature === scrollToMessageId ||
        message.identifier === scrollToMessageId ||
        message.message?.signature === scrollToMessageId
      );
    });
    if (targetIndex === -1) return;
    lastHandledScrollTargetRef.current = targetRequestKey;
    goToMessage(targetIndex);
    handleMessageSeen();
  }, [
    goToMessage,
    handleMessageSeen,
    messages,
    scrollToMessageId,
    scrollToMessageNonce,
  ]);

  // Memoize per-row payload so MessageItem receives stable references and memo can skip re-renders
  const processedRows = useMemo(() => {
    return messages.map((msg, index) => {
      let message = msg || null;
      let replyIndex = -1;
      let reply = null;
      let replyExpiredMeta = null;
      let reactions = null;
      let isUpdating = false;
      try {
        if (message) {
          replyIndex = messages.findIndex(
            (m) => m?.signature === message?.repliedTo
          );
          if (message?.repliedTo && replyIndex !== -1) {
            reply = { ...(messages[replyIndex] || {}) };
            if (chatReferences?.[reply?.signature]?.edit) {
              const edit = chatReferences[reply?.signature]?.edit;
              reply.decryptedData = edit;
              reply.text = edit?.message;
              reply.messageText = edit?.messageText;
              reply.editTimestamp = edit?.timestamp;
            }
          } else if (message?.repliedTo && replyIndex === -1) {
            const editMeta = chatReferences?.[message?.repliedTo]?.edit;
            const replyWasDeleted =
              message?.replyTargetDeleted === true ||
              chatReferences?.[message?.repliedTo]?.deleted === true;
            if (replyWasDeleted) {
              replyExpiredMeta = { deleted: true };
            } else if (editMeta) {
              replyExpiredMeta = {
                senderName: editMeta?.senderName,
                sender: editMeta?.sender,
                messageText:
                  editMeta?.messageText !== undefined
                    ? editMeta?.messageText
                    : undefined,
                text:
                  editMeta?.message !== undefined
                    ? editMeta?.message
                    : undefined,
                decryptedData: editMeta,
                editTimestamp: editMeta?.timestamp,
              };
            } else {
              replyExpiredMeta = { missing: true };
            }
          }
          if (message?.message && message?.groupDirectId) {
            replyIndex = messages.findIndex(
              (m) => m?.signature === message?.message?.repliedTo
            );
            if (message?.message?.repliedTo && replyIndex !== -1) {
              reply = messages[replyIndex] || null;
            }
            message = {
              ...(message?.message || {}),
              isTemp: true,
              unread: false,
              status: message?.status,
            };
          }
          if (chatReferences?.[message.signature]) {
            reactions = chatReferences[message.signature]?.reactions || null;
            if (chatReferences[message.signature]?.edit) {
              message = {
                ...message,
                text: chatReferences[message.signature]?.edit?.message,
                messageText:
                  chatReferences[message.signature]?.edit?.messageText,
                images: chatReferences[message.signature]?.edit?.images,
                isEdit: true,
                editTimestamp:
                  chatReferences[message.signature]?.edit?.timestamp,
              };
            }
          }
          if (
            tempChatReferences?.some(
              (item) => item?.chatReference === message?.signature
            )
          ) {
            isUpdating = true;
          }
          if (reticulumChatEnabled && index === reticulumUnreadBoundaryIndex) {
            message = { ...message, divide: true };
          }
        }
      } catch (err) {
        message = null;
        reply = null;
        reactions = null;
      }
      return {
        message,
        reply,
        replyIndex,
        replyExpiredMeta,
        reactions,
        isUpdating,
      };
    });
  }, [
    chatReferences,
    messages,
    reticulumChatEnabled,
    reticulumUnreadBoundaryIndex,
    tempChatReferences,
  ]);

  const { t } = useTranslation([
    'auth',
    'core',
    'group',
    'question',
    'tutorial',
  ]);

  return (
    <Box
      data-reticulum-chat-root={reticulumChatEnabled ? 'true' : undefined}
      sx={{
        display: 'flex',
        height: '100%',
        width: '100%',
      }}
    >
      <Box
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          position: 'relative',
          width: '100%',
        }}
      >
        <Box
          data-reticulum-chat-scroll-viewport={
            reticulumChatEnabled ? 'true' : undefined
          }
          ref={parentRef}
          onScroll={handleScroll}
          onWheel={cancelReticulumScrollRetries}
          onTouchStart={cancelReticulumScrollRetries}
          onPointerDown={cancelReticulumScrollRetries}
          style={{
            display: 'flex',
            flexGrow: 1,
            height: '0px',
            overflow: 'auto',
            position: 'relative',
            visibility:
              reticulumChatEnabled &&
              positionedReticulumChatIdentity !== chatIdentity
                ? 'hidden'
                : 'visible',
          }}
          sx={
            reticulumChatEnabled
              ? {
                  scrollbarColor: 'transparent transparent',
                  scrollbarWidth: 'auto',
                  '&::-webkit-scrollbar': { width: '8px' },
                  '&::-webkit-scrollbar-button': { display: 'none', height: 0 },
                  '&::-webkit-scrollbar-track': {
                    backgroundColor: 'transparent',
                  },
                  '&::-webkit-scrollbar-thumb': {
                    backgroundColor: 'transparent',
                    backgroundClip: 'padding-box',
                    border: '1px solid transparent',
                    borderRadius: '8px',
                    minHeight: '40px',
                  },
                  '&:hover': {
                    scrollbarColor: `${alpha(theme.palette.text.secondary, 0.52)} transparent`,
                    '&::-webkit-scrollbar-thumb': {
                      backgroundColor: alpha(
                        theme.palette.text.secondary,
                        0.52
                      ),
                      backgroundClip: 'padding-box',
                    },
                    '&::-webkit-scrollbar-thumb:hover': {
                      backgroundColor: alpha(
                        theme.palette.text.secondary,
                        0.74
                      ),
                      backgroundClip: 'padding-box',
                    },
                  },
                }
              : undefined
          }
        >
          <Box
            sx={{
              height: rowVirtualizer.getTotalSize(),
              width: '100%',
            }}
          >
            <Box
              sx={{
                left: 0,
                position: 'absolute',
                top: 0,
                width: '100%',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const index = virtualRow.index;
                const rowPayload = processedRows[index];
                if (!rowPayload) {
                  return (
                    <Box
                      key={virtualRow.index}
                      sx={{
                        alignItems: 'center',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '5px',
                        left: '50%',
                        padding: '10px 0',
                        position: 'absolute',
                        top: 0,
                        transform: `translateY(${virtualRow.start}px) translateX(-50%)`,
                        width: '100%',
                      }}
                    >
                      <Typography>
                        {t('core:message.error.message_loading', {
                          postProcess: 'capitalizeFirstChar',
                        })}
                      </Typography>
                    </Box>
                  );
                }
                const {
                  message,
                  reply,
                  replyIndex,
                  replyExpiredMeta,
                  reactions,
                  isUpdating,
                } = rowPayload;
                const isGroupedWithPrevious =
                  reticulumChatEnabled &&
                  isReticulumMessageContinuation(
                    processedRows[index - 1]?.message,
                    message
                  );
                const rowKey = getMessageKey(
                  messages[virtualRow.index],
                  virtualRow.index
                );
                if (!message) {
                  return (
                    <Box
                      key={rowKey}
                      sx={{
                        alignItems: 'center',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '5px',
                        left: '50%',
                        padding: '10px 0',
                        position: 'absolute',
                        top: 0,
                        transform: `translateY(${virtualRow.start}px) translateX(-50%)`,
                        width: '100%',
                      }}
                    >
                      <Typography>
                        {t('core:message.error.message_loading', {
                          postProcess: 'capitalizeFirstChar',
                        })}
                      </Typography>
                    </Box>
                  );
                }

                return (
                  <Box
                    data-index={virtualRow.index} //needed for dynamic row height measurement
                    ref={rowVirtualizer.measureElement} //measure dynamic row height
                    key={rowKey}
                    sx={{
                      alignItems: 'center',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '5px',
                      left: '50%', // Move to the center horizontally
                      overscrollBehavior: 'none',
                      padding: reticulumChatEnabled ? '3px 0' : '10px 0',
                      position: 'absolute',
                      top: 0,
                      transform: `translateY(${virtualRow.start}px) translateX(-50%)`, // Adjust for centering
                      width: '100%', // Control width (90% of the parent)
                    }}
                  >
                    <ErrorBoundary
                      fallback={
                        <Typography>
                          {t('group:message.generic.invalid_data', {
                            postProcess: 'capitalizeFirstChar',
                          })}
                        </Typography>
                      }
                    >
                      <MessageItem
                        key={rowKey}
                        handleReaction={handleReaction}
                        isLast={index === messages.length - 1}
                        isGroupedWithPrevious={isGroupedWithPrevious}
                        isPrivate={isPrivate}
                        isScrollTarget={
                          highlightedMessageIndex === virtualRow.index
                        }
                        isTemp={!!message?.isTemp}
                        isUpdating={isUpdating}
                        lastSignature={lastSignature}
                        message={message}
                        myAddress={myAddress}
                        selectedGroup={selectedGroup}
                        secretKeyObject={secretKeyObject}
                        onEdit={onEdit}
                        onDelete={onDelete}
                        onReply={onReply}
                        onAcceptQchatFileTransfer={onAcceptQchatFileTransfer}
                        qchatFileTransferStates={qchatFileTransferStates}
                        qchatCompletedTransfers={qchatCompletedTransfers}
                        onSeen={handleMessageSeen}
                        reactions={reactions}
                        reply={reply}
                        replyIndex={replyIndex}
                        replyExpiredMeta={replyExpiredMeta}
                        reticulumChatEnabled={reticulumChatEnabled}
                        reticulumDiscussionReplyCount={
                          reticulumDiscussionReplyCounts?.[
                            String(message?.signature || '')
                          ] || 0
                        }
                        onOpenReticulumDiscussion={
                          onOpenReticulumDiscussion
                        }
                        reticulumGroupAvatarOwnerName={
                          reticulumGroupAvatarOwnerName
                        }
                        reticulumGroupDisplayName={reticulumGroupDisplayName}
                        reticulumMentionUsers={reticulumMentionUsers}
                        reticulumMemberJoinedByAddress={
                          reticulumMemberJoinedByAddress
                        }
                        reticulumMemberRolesByAddress={
                          reticulumMemberRolesByAddress
                        }
                        reticulumMemberRolesReady={reticulumMemberRolesReady}
                        scrollToItem={goToMessage}
                      />
                    </ErrorBoundary>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>

        {!reticulumChatEnabled && showScrollButton && (
          <Button
            onClick={() => scrollToBottom()}
            startIcon={<KeyboardArrowDownRoundedIcon sx={{ fontSize: 20 }} />}
            sx={{
              ...scrollButtonSx,
              backgroundColor: theme.palette.primary.dark,
              color: theme.palette.primary.contrastText,
              border: `1px solid ${theme.palette.primary.main}`,
              '&:hover': {
                ...scrollButtonSx['&:hover'],
                backgroundColor: theme.palette.primary.main,
                color: theme.palette.primary.contrastText,
              },
            }}
          >
            {t('group:action.scroll_unread_messages', {
              postProcess: 'capitalizeFirstChar',
            })}
          </Button>
        )}

        {showScrollDownButton &&
          !showScrollButton &&
          (compactScrollButton ? (
            <Button
              onClick={() => scrollToBottom()}
              aria-label={t('group:action.scroll_bottom', {
                postProcess: 'capitalizeFirstChar',
              })}
              sx={scrollButtonCompactSx}
            >
              <KeyboardArrowDownRoundedIcon sx={{ fontSize: 22 }} />
            </Button>
          ) : (
            <Button
              onClick={() => scrollToBottom()}
              startIcon={<KeyboardArrowDownRoundedIcon sx={{ fontSize: 20 }} />}
              sx={scrollButtonSx}
            >
              {t('group:action.scroll_bottom', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Button>
          ))}
      </Box>

      {enableMentions &&
        !reticulumChatEnabled &&
        (hasSecretKey || isPrivate === false) && (
          <ChatOptions
            goToMessage={goToMessage}
            isPrivate={isPrivate}
            members={members}
            messages={messages}
            myName={myName}
            openQManager={openQManager}
            reticulumChatEnabled={reticulumChatEnabled}
            selectedGroup={selectedGroup}
          />
        )}
    </Box>
  );
};
