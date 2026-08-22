export const QORTAL_PROJECT_GROUP_ID = 1144;

export const isQortalProjectGroup = (group: { groupId?: unknown } | null) =>
  Number(group?.groupId) === QORTAL_PROJECT_GROUP_ID;

export const isPinnedTopGroup = (
  sortMode: string,
  group: { groupId?: unknown } | null
) => sortMode === 'top' && isQortalProjectGroup(group);

export const comparePinnedTopGroups = (
  left: { groupId?: unknown },
  right: { groupId?: unknown }
) => Number(isQortalProjectGroup(right)) - Number(isQortalProjectGroup(left));
