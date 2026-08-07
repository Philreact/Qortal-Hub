type ReticulumNotificationChannel = {
  channelId?: unknown;
  name?: unknown;
};

const cleanChannelLabel = (value: unknown): string =>
  (typeof value === 'string' ? value : '').trim().replace(/^#/, '');

/**
 * Resolve a stable channel ID to its current human-readable metadata name.
 * The ID remains the navigation key; this label is only for presentation.
 */
export function getReticulumNotificationChannelLabel(
  channelIdValue: unknown,
  channels: unknown
): string {
  const channelId = cleanChannelLabel(channelIdValue) || 'general';
  if (!Array.isArray(channels)) return channelId;
  const channel = channels.find(
    (candidate: ReticulumNotificationChannel) =>
      cleanChannelLabel(candidate?.channelId) === channelId
  ) as ReticulumNotificationChannel | undefined;
  return cleanChannelLabel(channel?.name) || channelId;
}
