export const groupSectionUsesSecretKey = (
  reticulumChatEnabled: boolean,
  groupSection: string
): boolean => !reticulumChatEnabled || groupSection === 'forum';

export const shouldLoadSecretKeyOnGroupEntry = (
  reticulumChatEnabled: boolean,
  isPrivate: boolean
): boolean => isPrivate && !reticulumChatEnabled;

export const shouldLoadSecretKeyForSection = (
  reticulumChatEnabled: boolean,
  isPrivate: boolean,
  groupSection: string
): boolean => reticulumChatEnabled && isPrivate && groupSection === 'forum';
