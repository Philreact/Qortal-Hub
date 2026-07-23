export const QORTAL_LAND_PRESENCE_EVENT = 'qortal-land:presence';

export type QortalLandAvailability = {
  afk: boolean;
  dnd: boolean;
};

export type QortalLandPresenceMember = QortalLandAvailability & {
  address: string;
  roomId: string;
  lastSeenAt: number;
};

export type QortalLandPresenceSnapshot = {
  groupId: number;
  members: QortalLandPresenceMember[];
};

const latestSnapshots = new Map<number, QortalLandPresenceSnapshot>();

export const getQortalLandPresence = (
  groupId: number
): QortalLandPresenceSnapshot | null => latestSnapshots.get(groupId) ?? null;

export const publishQortalLandPresence = (
  snapshot: QortalLandPresenceSnapshot
): void => {
  latestSnapshots.set(snapshot.groupId, snapshot);
  window.dispatchEvent(
    new CustomEvent<QortalLandPresenceSnapshot>(QORTAL_LAND_PRESENCE_EVENT, {
      detail: snapshot,
    })
  );
};
