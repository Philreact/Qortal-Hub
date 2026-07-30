import { describe, expect, it, vi } from 'vitest';
import { buildReticulumInitialHistoryState } from './reticulumInitialHistory';

const message = (signature: string, overrides: Record<string, any> = {}) => ({
  signature,
  id: signature,
  eventType: 'message',
  sender: 'sender-a',
  message: signature,
  ...overrides,
});

describe('buildReticulumInitialHistoryState', () => {
  it('preserves ordered message content and refreshes duplicate metadata', () => {
    const reply = message('message-2', {
      repliedTo: 'message-1',
      attachments: [{ fileName: 'report.txt' }],
    });
    const result = buildReticulumInitialHistoryState([
      message('message-1', {
        senderName: 'Old name',
        privilegedMentionAuthorized: false,
      }),
      reply,
      message('message-1', {
        senderName: 'Current name',
        directMentionAuthorized: true,
        privilegedMentionAuthorized: true,
      }),
    ]);

    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((item) => item.signature)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(result.messages[0]).toMatchObject({
      senderName: 'Current name',
      directMentionAuthorized: true,
      privilegedMentionAuthorized: true,
    });
    expect(result.messages[1]).toBe(reply);
  });

  it('projects reaction add and remove events by sender', () => {
    const result = buildReticulumInitialHistoryState([
      message('message-1'),
      {
        signature: 'reaction-1',
        eventType: 'reaction_add',
        chatReference: 'message-1',
        sender: 'sender-a',
        content: '👍',
      },
      {
        signature: 'reaction-2',
        eventType: 'reaction_add',
        chatReference: 'message-1',
        sender: 'sender-b',
        content: '👍',
      },
      {
        signature: 'reaction-3',
        eventType: 'reaction_remove',
        chatReference: 'message-1',
        sender: 'sender-a',
        content: '👍',
        contentState: false,
      },
    ]);

    expect(result.chatReferences['message-1'].reactions?.['👍']).toEqual([
      expect.objectContaining({ signature: 'reaction-2', sender: 'sender-b' }),
    ]);
  });

  it('projects edits and deletes without leaving a deleted message row', () => {
    const result = buildReticulumInitialHistoryState([
      message('message-1'),
      {
        signature: 'edit-1',
        eventType: 'edit',
        chatReference: 'message-1',
        sender: 'sender-a',
        decryptedData: { message: 'edited' },
        privilegedMentionAuthorized: true,
      },
      {
        signature: 'delete-1',
        eventType: 'delete',
        chatReference: 'message-1',
        sender: 'sender-a',
      },
    ]);

    expect(result.messages).toEqual([]);
    expect(result.chatReferences['message-1']).toEqual({ deleted: true });
    expect([...result.appliedEventIds]).toEqual([
      'message-1',
      'edit-1',
      'delete-1',
    ]);
  });

  it('preserves mixed edit and reaction state until a delete supersedes it', () => {
    const beforeDelete = buildReticulumInitialHistoryState([
      message('message-1', { tempSignature: 'temporary-1' }),
      {
        signature: 'reaction-1',
        eventType: 'reaction_add',
        chatReference: 'message-1',
        sender: 'sender-b',
        content: '❤️',
      },
      {
        signature: 'edit-1',
        eventType: 'edit',
        chatReference: 'message-1',
        sender: 'sender-a',
        decryptedData: { message: 'edited' },
      },
    ]);

    expect(beforeDelete.chatReferences['message-1']).toMatchObject({
      edit: { message: 'edited' },
      reactions: {
        '❤️': [expect.objectContaining({ signature: 'reaction-1' })],
      },
    });

    const afterDelete = buildReticulumInitialHistoryState([
      message('message-1', { tempSignature: 'temporary-1' }),
      {
        signature: 'delete-1',
        eventType: 'delete',
        chatReference: 'temporary-1',
        sender: 'sender-a',
      },
    ]);
    expect(afterDelete.messages).toEqual([]);
    expect(afterDelete.chatReferences['temporary-1']).toEqual({
      deleted: true,
    });
  });

  it('claims filtered events while keeping them out of rendered state', () => {
    const result = buildReticulumInitialHistoryState(
      [message('visible'), message('blocked', { sender: 'blocked-user' })],
      { shouldExclude: (item) => item.sender === 'blocked-user' }
    );

    expect(result.messages.map((item) => item.signature)).toEqual(['visible']);
    expect(result.appliedEventIds.has('blocked')).toBe(true);
  });

  it('only inserts the reconciled optimistic item', () => {
    const reconcileItem = vi.fn((item) => ({
      ...item,
      optimisticReconciled: true,
    }));
    const result = buildReticulumInitialHistoryState([message('message-1')], {
      reconcileItem,
    });

    expect(reconcileItem).toHaveBeenCalledOnce();
    expect(result.messages[0].optimisticReconciled).toBe(true);
  });

  it('merges a paginated batch into existing messages and references', () => {
    const existingReaction = {
      signature: 'reaction-existing',
      eventType: 'reaction_add',
      chatReference: 'message-current',
      sender: 'sender-b',
      content: '👍',
    };
    const initialReferences = {
      'message-current': {
        reactions: { '👍': [existingReaction] },
      },
    };
    const result = buildReticulumInitialHistoryState(
      [
        message('message-older', { timestamp: 1 }),
        {
          signature: 'reaction-new',
          eventType: 'reaction_add',
          chatReference: 'message-current',
          sender: 'sender-c',
          content: '👍',
        },
      ],
      {
        initialMessages: [message('message-current', { timestamp: 2 })],
        initialChatReferences: initialReferences,
      }
    );

    expect(result.messages.map((item) => item.signature)).toEqual([
      'message-current',
      'message-older',
    ]);
    expect(
      result.chatReferences['message-current'].reactions?.['👍']?.map(
        (reaction) => reaction.signature
      )
    ).toEqual(['reaction-existing', 'reaction-new']);
    expect(initialReferences['message-current'].reactions['👍']).toEqual([
      existingReaction,
    ]);
    expect([...result.appliedEventIds]).toEqual([
      'message-older',
      'reaction-new',
    ]);
  });
});
