import { describe, expect, it } from 'vitest';
import {
  projectReticulumDmEvents,
  reticulumDmEventToChatMessage,
  type ReticulumDmEvent,
} from './useReticulumDirectChat';

const event = (
  overrides: Partial<ReticulumDmEvent> &
    Pick<ReticulumDmEvent, 'eventId' | 'eventType' | 'senderAddress'>
): ReticulumDmEvent => ({
  conversationId: 'conversation',
  recipientAddress: overrides.senderAddress === 'alice' ? 'bob' : 'alice',
  senderPublicKey: 'public-key',
  senderSeq: 1,
  timestamp: 1,
  payload: '',
  payloadHash: 'hash',
  signature: 'signature',
  ...overrides,
});

describe('Reticulum DM event projection', () => {
  it('does not let DM payload data replace verified event metadata', () => {
    const message = event({
      eventId: 'message-1',
      eventType: 'edit',
      senderAddress: 'alice',
      recipientAddress: 'bob',
      senderName: 'Alice',
      targetEventId: 'verified-target',
      replyToEventId: 'verified-reply',
      timestamp: 42,
      payload: JSON.stringify({
        chatReference: 'spoofed-target',
        messageText: 'hello',
        otherData: {
          id: 'spoofed-id',
          signature: 'spoofed-signature',
          eventType: 'delete',
          sender: 'mallory',
          senderAddress: 'mallory',
          senderName: 'Mallory',
          recipientAddress: 'mallory-recipient',
          timestamp: 1,
          messageText: 'spoofed message',
          chatReference: 'spoofed-target',
          repliedTo: 'spoofed-reply',
          reticulumChat: false,
          reticulumDirect: false,
          reticulumDeliveryStatus: 'pending',
          decryptedData: { content: 'spoofed' },
        },
      }),
    });

    expect(reticulumDmEventToChatMessage(message)).toMatchObject({
      id: 'message-1',
      signature: 'message-1',
      eventType: 'edit',
      sender: 'alice',
      senderAddress: 'alice',
      senderName: 'Alice',
      recipientAddress: 'bob',
      timestamp: 42,
      chatReference: 'verified-target',
      repliedTo: 'verified-reply',
      messageText: 'hello',
      reticulumChat: true,
      reticulumDirect: true,
      reticulumDeliveryStatus: undefined,
      decryptedData: expect.objectContaining({
        sender: 'mallory',
      }),
    });
  });

  it('projects reaction state onto its target without rendering action events', () => {
    const message = event({
      eventId: 'message-1',
      eventType: 'message',
      senderAddress: 'alice',
      payload: 'hello',
    });
    const reaction = event({
      eventId: 'reaction-1',
      eventType: 'reaction_add',
      senderAddress: 'bob',
      targetEventId: message.eventId,
      timestamp: 2,
      payload: JSON.stringify({
        otherData: { content: '👍', contentState: true, type: 'reaction' },
      }),
    });

    const projected = projectReticulumDmEvents([message, reaction]);

    expect(projected.messages).toHaveLength(1);
    expect(
      projected.chatReferences[message.eventId].reactions?.['👍']?.[0]?.sender
    ).toBe('bob');
  });

  it('applies reaction removal as the latest sender state', () => {
    const message = event({
      eventId: 'message-1',
      eventType: 'message',
      senderAddress: 'alice',
    });
    const add = event({
      eventId: 'reaction-1',
      eventType: 'reaction_add',
      senderAddress: 'bob',
      targetEventId: message.eventId,
      timestamp: 2,
      payload: JSON.stringify({ otherData: { content: '😂' } }),
    });
    const remove = event({
      eventId: 'reaction-2',
      eventType: 'reaction_remove',
      senderAddress: 'bob',
      targetEventId: message.eventId,
      timestamp: 3,
      payload: JSON.stringify({ otherData: { content: '😂' } }),
    });

    const projected = projectReticulumDmEvents([remove, message, add]);

    expect(
      projected.chatReferences[message.eventId].reactions?.['😂']
    ).toBeUndefined();
  });

  it('allows only the original sender to delete a DM', () => {
    const message = event({
      eventId: 'message-1',
      eventType: 'message',
      senderAddress: 'alice',
    });
    const unauthorizedDelete = event({
      eventId: 'delete-1',
      eventType: 'delete',
      senderAddress: 'bob',
      targetEventId: message.eventId,
      timestamp: 2,
    });
    expect(
      projectReticulumDmEvents([message, unauthorizedDelete]).messages
    ).toHaveLength(1);

    const authorizedDelete = event({
      eventId: 'delete-2',
      eventType: 'delete',
      senderAddress: 'alice',
      targetEventId: message.eventId,
      timestamp: 3,
    });
    const projected = projectReticulumDmEvents([message, authorizedDelete]);
    expect(projected.messages).toHaveLength(0);
    expect(projected.chatReferences[message.eventId].deleted).toBe(true);
  });
});
