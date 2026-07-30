export type ReticulumRendererFields = Record<string, unknown>;

// These fields describe verified transport identity, routing, ordering, or
// renderer state. A payload may retain same-named application data inside
// `decryptedData` for compatibility, but it must not publish it as top-level
// event metadata.
const RETICULUM_RESERVED_RENDERER_FIELDS = new Set([
  'authorAddress',
  'authorPrimaryName',
  'authorPublicKey',
  'authorSeq',
  'authorStreamId',
  'channelId',
  'chatReference',
  'conversationId',
  'decryptedData',
  'directMentionAuthorized',
  'eventId',
  'eventType',
  'expiresAt',
  'groupId',
  'id',
  'isNotEncrypted',
  'localDeliveryStatus',
  'localDeliveryUpdatedAt',
  'payloadHash',
  'privilegedMentionAuthorized',
  'recipientAddress',
  'repliedTo',
  'replyTargetDeleted',
  'replyToEventId',
  'reticulumChat',
  'reticulumDeliveryStatus',
  'reticulumDeliveryUpdatedAt',
  'reticulumDirect',
  'sender',
  'senderAddress',
  'senderName',
  'senderPublicKey',
  'senderSeq',
  'senderStreamId',
  'signature',
  'targetEventId',
  'timestamp',
  'unread',
]);

const reticulumPayloadContentFields = (
  payload: ReticulumRendererFields
): ReticulumRendererFields => {
  const content: ReticulumRendererFields = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!RETICULUM_RESERVED_RENDERER_FIELDS.has(key)) content[key] = value;
  }
  return content;
};

/**
 * Combines user-authored chat content with metadata derived from a verified
 * Reticulum event. Payload fields are intentionally flexible, but they must
 * never replace or manufacture top-level identity and transport fields.
 */
export const mergeReticulumPayloadWithVerifiedEnvelope = (
  payload: ReticulumRendererFields,
  envelope: ReticulumRendererFields
): ReticulumRendererFields => ({
  ...reticulumPayloadContentFields(payload),
  ...envelope,
  decryptedData: payload,
});
