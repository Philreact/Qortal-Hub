import { executeEvent } from './events';

export const QCHAT_MENTION_NOTIFICATIONS_UPDATED_EVENT =
  'q-chat-mention-notifications-updated';
export const QCHAT_MENTION_NOTIFICATION_APP_NAME = 'q-chat';
export const QCHAT_MENTION_NOTIFICATION_EVENT = 'Q_CHAT_MENTION';

const QCHAT_MENTION_NOTIFICATIONS_DISABLED_KEY =
  'q-chat-mention-notifications-disabled';

export async function getQChatMentionNotificationsEnabled(): Promise<boolean> {
  const disabled = await window
    .sendMessage('getUserSettings', {
      key: QCHAT_MENTION_NOTIFICATIONS_DISABLED_KEY,
    })
    .catch(() => false);
  return disabled !== true;
}

export async function setQChatMentionNotificationsEnabled(
  enabled: boolean
): Promise<void> {
  const response = await window.sendMessage('addUserSettings', {
    keyValue: {
      key: QCHAT_MENTION_NOTIFICATIONS_DISABLED_KEY,
      value: !enabled,
    },
  });
  if (response?.error) {
    throw new Error(response.error);
  }
  executeEvent(QCHAT_MENTION_NOTIFICATIONS_UPDATED_EVENT, { enabled });
  if (enabled) {
    executeEvent('reticulum-chat-summaries-refresh', {});
  }
}
