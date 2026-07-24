import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getQChatMentionNotificationsEnabled,
  QCHAT_MENTION_NOTIFICATIONS_UPDATED_EVENT,
  setQChatMentionNotificationsEnabled,
} from './qChatMentionNotifications';

describe('Q-Chat mention notification setting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is enabled by default and reads the dedicated disabled setting', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(true);
    vi.stubGlobal('window', { ...window, sendMessage });

    await expect(getQChatMentionNotificationsEnabled()).resolves.toBe(true);
    await expect(getQChatMentionNotificationsEnabled()).resolves.toBe(false);
  });

  it('persists the inverse disabled value and broadcasts the change', async () => {
    const sendMessage = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('window', { ...window, sendMessage });
    const listener = vi.fn();
    document.addEventListener(
      QCHAT_MENTION_NOTIFICATIONS_UPDATED_EVENT,
      listener
    );

    await setQChatMentionNotificationsEnabled(false);

    expect(sendMessage).toHaveBeenCalledWith('addUserSettings', {
      keyValue: {
        key: 'q-chat-mention-notifications-disabled',
        value: true,
      },
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { enabled: false } })
    );

    document.removeEventListener(
      QCHAT_MENTION_NOTIFICATIONS_UPDATED_EVENT,
      listener
    );
  });
});
