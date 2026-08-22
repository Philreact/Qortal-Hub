export const RETICULUM_SELF_WELCOME_STORAGE_PREFIX =
  'qchat-reticulum-self-welcome-v1';
export const RETICULUM_SELF_WELCOME_RECENT_JOIN_MS = 24 * 60 * 60 * 1000;

type ReticulumSelfWelcomeIdentity = {
  address: string;
  groupId: number;
  joinedAt: number;
};

const cleanedWelcomeKeys = new Set<string>();

export const reticulumSelfWelcomeStorageKey = ({
  address,
  groupId,
  joinedAt,
}: ReticulumSelfWelcomeIdentity) =>
  `${RETICULUM_SELF_WELCOME_STORAGE_PREFIX}:${groupId}:${address}:${joinedAt}`;

const parseReticulumSelfWelcomeStorageKey = (key: string) => {
  const prefix = `${RETICULUM_SELF_WELCOME_STORAGE_PREFIX}:`;
  if (!key.startsWith(prefix)) return null;

  const parts = key.slice(prefix.length).split(':');
  if (parts.length !== 3) return null;
  const groupId = Number(parts[0]);
  const address = String(parts[1] || '').trim();
  const joinedAt = Number(parts[2]);
  if (
    !Number.isInteger(groupId) ||
    groupId <= 0 ||
    !address ||
    !Number.isFinite(joinedAt) ||
    joinedAt <= 0
  ) {
    return null;
  }

  return { address, groupId, joinedAt };
};

export const cleanupReticulumSelfWelcomeMarkers = (
  identity: ReticulumSelfWelcomeIdentity,
  now = Date.now()
) => {
  if (typeof window === 'undefined') return false;

  const currentKey = reticulumSelfWelcomeStorageKey(identity);
  const recentJoinCutoff = now - RETICULUM_SELF_WELCOME_RECENT_JOIN_MS;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(`${RETICULUM_SELF_WELCOME_STORAGE_PREFIX}:`)) {
        continue;
      }

      const parsed = parseReticulumSelfWelcomeStorageKey(key);
      if (!parsed) {
        window.localStorage.removeItem(key);
        continue;
      }

      const obsoleteMembership =
        parsed.groupId === identity.groupId &&
        parsed.address === identity.address &&
        key !== currentKey;
      const oldInactiveMembership =
        key !== currentKey && parsed.joinedAt < recentJoinCutoff;
      if (obsoleteMembership || oldInactiveMembership) {
        window.localStorage.removeItem(key);
      }
    }
    return true;
  } catch {
    // Cleanup is best-effort and must never interfere with welcome publishing.
    return false;
  }
};

export const cleanupReticulumSelfWelcomeMarkersOnce = (
  identity: ReticulumSelfWelcomeIdentity
) => {
  const currentKey = reticulumSelfWelcomeStorageKey(identity);
  if (cleanedWelcomeKeys.has(currentKey)) return;
  if (cleanedWelcomeKeys.size >= 256) cleanedWelcomeKeys.clear();
  if (cleanupReticulumSelfWelcomeMarkers(identity)) {
    cleanedWelcomeKeys.add(currentKey);
  }
};
