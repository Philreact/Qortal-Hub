import { describe, expect, it, vi } from 'vitest';
import { returnToQChat } from './homeNavigation';

describe('home Q-Chat navigation', () => {
  it('returns to chat without replacing the selected group', () => {
    const setGroupSection = vi.fn();
    const openQChat = vi.fn();

    returnToQChat(setGroupSection, openQChat);

    expect(setGroupSection).toHaveBeenCalledExactlyOnceWith('chat');
    expect(openQChat).toHaveBeenCalledOnce();
  });
});
