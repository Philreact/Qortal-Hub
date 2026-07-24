import { describe, expect, it } from 'vitest';
import {
  projectReticulumDmEvents,
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
