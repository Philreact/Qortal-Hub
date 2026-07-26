import { describe, expect, it } from 'vitest';
import { mergeDirectsWithFriends } from './mergeDirectsWithFriends';

describe('mergeDirectsWithFriends', () => {
  it('adds saved friends who do not have a conversation yet', () => {
    const rows = mergeDirectsWithFriends(
      [],
      {
        QfriendA: {
          publicKey: 'friend-public-key',
          name: 'Friend A',
          addedAt: 1,
        },
      },
      'Qme',
      'Me'
    );

    expect(rows).toEqual([
      {
        address: 'QfriendA',
        name: 'Friend A',
        sender: 'Qme',
        senderName: 'Me',
        timestamp: undefined,
      },
    ]);
  });

  it('preserves an existing Reticulum conversation instead of duplicating it', () => {
    const conversation = {
      address: 'QfriendA',
      name: 'Friend A',
      timestamp: 100,
      unreadCount: 2,
      reticulumDirect: true,
    };

    const rows = mergeDirectsWithFriends(
      [conversation],
      {
        QfriendA: {
          publicKey: 'friend-public-key',
          name: 'Friend A',
          addedAt: 1,
        },
      },
      'Qme',
      'Me'
    );

    expect(rows).toEqual([conversation]);
  });

  it('contains only supplied conversations and saved friends', () => {
    const rows = mergeDirectsWithFriends(
      [{ address: 'QreticulumPeer', timestamp: 100 }],
      {
        QfriendA: {
          publicKey: 'friend-public-key',
          addedAt: 1,
        },
      },
      'Qme',
      'Me'
    );

    expect(rows.map((row) => row.address)).toEqual([
      'QreticulumPeer',
      'QfriendA',
    ]);
    expect(rows.some((row) => row.address === 'QlegacyPeer')).toBe(false);
  });
});
