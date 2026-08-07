import { describe, expect, it } from 'vitest';
import { getReticulumNotificationChannelLabel } from './reticulumNotificationChannel';

describe('Reticulum notification channel labels', () => {
  it('uses the channel metadata name instead of its internal ID', () => {
    expect(
      getReticulumNotificationChannelLabel('ch-123', [
        { channelId: 'ch-123', name: 'tasks-and-ideas' },
      ])
    ).toBe('tasks-and-ideas');
  });

  it('keeps the channel ID as a safe fallback', () => {
    expect(getReticulumNotificationChannelLabel('ch-123', [])).toBe('ch-123');
    expect(getReticulumNotificationChannelLabel(undefined, undefined)).toBe(
      'general'
    );
  });

  it('does not duplicate a display prefix stored in metadata', () => {
    expect(
      getReticulumNotificationChannelLabel('general', [
        { channelId: 'general', name: '#general-chat' },
      ])
    ).toBe('general-chat');
  });
});
