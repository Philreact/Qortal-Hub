export type ReticulumHistoryChatItem = Record<string, any>;

export type ReticulumHistoryReferences = Record<
  string,
  {
    deleted?: boolean;
    edit?: ReticulumHistoryChatItem;
    reactions?: Record<string, ReticulumHistoryChatItem[]>;
  }
>;

type BuildReticulumInitialHistoryOptions = {
  initialMessages?: ReticulumHistoryChatItem[];
  initialChatReferences?: ReticulumHistoryReferences;
  shouldExclude?: (item: ReticulumHistoryChatItem) => boolean;
  reconcileItem?: (item: ReticulumHistoryChatItem) => ReticulumHistoryChatItem;
};

export const reticulumHistoryItemSpecialId = (item: ReticulumHistoryChatItem) =>
  item?.specialId || item?.decryptedData?.specialId;

/**
 * Applies an ordered, already-converted Reticulum history batch in memory.
 * This mirrors the live event reducer in ChatGroup and can start from existing
 * state, allowing initial history, pagination, and live bursts to each commit
 * to React state once instead of once per event.
 */
export const buildReticulumInitialHistoryState = (
  items: Array<ReticulumHistoryChatItem | null | undefined>,
  options: BuildReticulumInitialHistoryOptions = {}
) => {
  const messages: Array<ReticulumHistoryChatItem | null> = [
    ...(options.initialMessages || []),
  ];
  const messageIndexBySignature = new Map<string, number>();
  const messageIndexByTemporarySignature = new Map<string, number>();
  const chatReferences: ReticulumHistoryReferences = {
    ...(options.initialChatReferences || {}),
  };
  const appliedEventIds = new Set<string>();

  messages.forEach((message, index) => {
    if (message?.signature) {
      messageIndexBySignature.set(String(message.signature), index);
    }
    if (message?.tempSignature) {
      messageIndexByTemporarySignature.set(
        String(message.tempSignature),
        index
      );
    }
  });

  const removeMessageAt = (index: number) => {
    const message = messages[index];
    if (!message) return;
    if (message.signature) {
      messageIndexBySignature.delete(String(message.signature));
    }
    if (message.tempSignature) {
      messageIndexByTemporarySignature.delete(String(message.tempSignature));
    }
    messages[index] = null;
  };

  for (const originalItem of items) {
    if (!originalItem) continue;

    const eventId =
      typeof originalItem.signature === 'string'
        ? originalItem.signature
        : typeof originalItem.id === 'string'
          ? originalItem.id
          : '';
    // The live path claims converted events before applying UI filtering.
    if (eventId) appliedEventIds.add(eventId);
    if (options.shouldExclude?.(originalItem)) continue;

    const targetReference = originalItem.chatReference;
    const itemType =
      originalItem.eventType ||
      originalItem.decryptedData?.type ||
      originalItem.type;
    const isReactionItem =
      itemType === 'reaction' ||
      itemType === 'reaction_add' ||
      itemType === 'reaction_remove';

    if (targetReference && itemType === 'delete') {
      const target = String(targetReference);
      const signatureIndex = messageIndexBySignature.get(target);
      const temporaryIndex = messageIndexByTemporarySignature.get(target);
      if (signatureIndex !== undefined) removeMessageAt(signatureIndex);
      if (temporaryIndex !== undefined && temporaryIndex !== signatureIndex) {
        removeMessageAt(temporaryIndex);
      }
      chatReferences[target] = { deleted: true };
      continue;
    }

    const nextItem = options.reconcileItem?.(originalItem) || originalItem;
    if (options.shouldExclude?.(nextItem)) continue;

    if (
      targetReference &&
      (itemType === 'edit' || nextItem.isEdited || isReactionItem)
    ) {
      const target = String(targetReference);
      const existingReference = chatReferences[target] || {};
      if (itemType === 'edit' || nextItem.isEdited) {
        chatReferences[target] = {
          ...existingReference,
          edit: {
            ...(nextItem.decryptedData || nextItem),
            directMentionAuthorized: nextItem.directMentionAuthorized === true,
            privilegedMentionAuthorized:
              nextItem.privilegedMentionAuthorized === true,
          },
        };
        continue;
      }

      const content = nextItem.content || nextItem.decryptedData?.content;
      const sender = nextItem.sender;
      if (!content || !sender) continue;
      const contentState =
        nextItem.contentState !== undefined
          ? nextItem.contentState
          : nextItem.decryptedData?.contentState;
      const reactions = { ...(existingReference.reactions || {}) };
      const matchingReactions = [...(reactions[content] || [])].filter(
        (reaction) => reaction.sender !== sender
      );
      if (contentState !== false) matchingReactions.push(nextItem);
      if (matchingReactions.length > 0) {
        reactions[content] = matchingReactions;
      } else {
        delete reactions[content];
      }
      chatReferences[target] = {
        ...existingReference,
        reactions,
      };
      continue;
    }

    const signature =
      typeof nextItem.signature === 'string' ? nextItem.signature : '';
    const existingIndex = signature
      ? messageIndexBySignature.get(signature)
      : undefined;
    if (existingIndex !== undefined) {
      const existingMessage = messages[existingIndex];
      if (!existingMessage) continue;
      let updatedMessage = existingMessage;
      if (
        existingMessage.privilegedMentionAuthorized !==
        nextItem.privilegedMentionAuthorized
      ) {
        updatedMessage = {
          ...updatedMessage,
          directMentionAuthorized: nextItem.directMentionAuthorized === true,
          privilegedMentionAuthorized:
            nextItem.privilegedMentionAuthorized === true,
        };
      }
      if (
        nextItem.senderName &&
        updatedMessage.senderName !== nextItem.senderName
      ) {
        updatedMessage = {
          ...updatedMessage,
          senderName: nextItem.senderName,
        };
      }
      messages[existingIndex] = updatedMessage;
      continue;
    }

    const nextIndex = messages.length;
    messages.push(nextItem);
    if (signature) messageIndexBySignature.set(signature, nextIndex);
    if (nextItem.tempSignature) {
      messageIndexByTemporarySignature.set(
        String(nextItem.tempSignature),
        nextIndex
      );
    }
  }

  return {
    messages: messages.filter(
      (message): message is ReticulumHistoryChatItem => message !== null
    ),
    chatReferences,
    appliedEventIds,
  };
};
