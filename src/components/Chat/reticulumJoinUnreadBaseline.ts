import { getBaseApiReact } from '../../App';
import { executeEvent } from '../../utils/events';

const RETICULUM_JOIN_UNREAD_BASELINE_PREFIX =
  'qchat-reticulum-join-unread-baseline-v1';
const DEFAULT_RETICULUM_CHANNEL_ID = 'general';

const baselineStorageKey = (
  groupId: number,
  address: string,
  joinedAt: number
) =>
  `${RETICULUM_JOIN_UNREAD_BASELINE_PREFIX}:${groupId}:${address}:${joinedAt}`;

const readStoredChannels = (key: string): Set<string> => {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || '[]');
    return new Set(
      Array.isArray(value)
        ? value
            .map((channelId) => String(channelId || '').trim())
            .filter(Boolean)
        : []
    );
  } catch {
    return new Set();
  }
};

const writeStoredChannels = (key: string, channelIds: Set<string>) => {
  try {
    window.localStorage.setItem(key, JSON.stringify([...channelIds]));
  } catch {
    // A storage failure must not prevent the read watermark from being applied.
  }
};

export const resolveReticulumMembershipJoinedAt = async (
  groupId: number,
  address: string
): Promise<number | null> => {
  const normalizedAddress = String(address || '').trim();
  if (
    !Number.isInteger(groupId) ||
    groupId <= 0 ||
    !normalizedAddress
  ) {
    return null;
  }
  const response = await fetch(
    `${getBaseApiReact()}/groups/members/${groupId}?limit=0`
  );
  if (!response.ok) return null;
  const data = await response.json();
  const member = Array.isArray(data?.members)
    ? data.members.find(
        (candidate: any) =>
          String(candidate?.member || '').trim() === normalizedAddress
      )
    : null;
  const joinedAt = Number(member?.joined);
  return Number.isFinite(joinedAt) && joinedAt > 0 ? joinedAt : null;
};

export const applyReticulumJoinUnreadBaseline = async ({
  address,
  groupId,
  joinedAt,
  knownChannelIds = [],
}: {
  address: string;
  groupId: number;
  joinedAt: number;
  knownChannelIds?: string[];
}): Promise<boolean> => {
  const normalizedAddress = String(address || '').trim();
  if (
    !Number.isInteger(groupId) ||
    groupId <= 0 ||
    !normalizedAddress ||
    !Number.isFinite(joinedAt) ||
    joinedAt <= 0 ||
    typeof window.reticulumChat?.markRead !== 'function'
  ) {
    return false;
  }

  const channelIds = new Set<string>([DEFAULT_RETICULUM_CHANNEL_ID]);
  for (const channelId of knownChannelIds) {
    const normalizedChannelId = String(channelId || '').trim();
    if (normalizedChannelId) channelIds.add(normalizedChannelId);
  }
  try {
    const channels = await window.reticulumChat.getChannels?.(groupId, true);
    if (Array.isArray(channels)) {
      for (const channel of channels as Array<{ channelId?: string }>) {
        const channelId = String(channel?.channelId || '').trim();
        if (channelId) channelIds.add(channelId);
      }
    }
  } catch {
    // The membership bridge may still be synchronizing. Callers retry.
  }

  const storageKey = baselineStorageKey(groupId, normalizedAddress, joinedAt);
  const completedChannels = readStoredChannels(storageKey);
  let changed = false;
  for (const channelId of channelIds) {
    if (completedChannels.has(channelId)) continue;
    try {
      const result = await window.reticulumChat.markRead(
        groupId,
        channelId,
        joinedAt,
        normalizedAddress
      );
      if (result?.success !== true) continue;
      completedChannels.add(channelId);
      changed = true;
    } catch {
      // A later membership/channel refresh will retry this channel.
    }
  }
  if (changed) {
    writeStoredChannels(storageKey, completedChannels);
    executeEvent('reticulum-chat-summaries-refresh', {});
  }
  return completedChannels.size > 0;
};
