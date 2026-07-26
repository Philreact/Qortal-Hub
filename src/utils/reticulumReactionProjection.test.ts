import { describe, expect, it } from 'vitest';
import { projectReticulumReactionReferences } from './reticulumReactionProjection';

const reaction = ({
  eventId,
  eventType = 'reaction_add',
  content = '👍',
  sender = 'alice',
  targetEventId = 'message-1',
  timestamp,
}: {
  eventId: string;
  eventType?: 'reaction_add' | 'reaction_remove';
  content?: string;
  sender?: string;
  targetEventId?: string;
  timestamp: number;
}) => ({
  authorAddress: sender,
  authorSeq: timestamp,
  authorStreamId: `${sender}-stream`,
  encryptedPayload: JSON.stringify({ content, type: 'reaction' }),
  eventId,
  eventType,
  targetEventId,
  timestamp,
});

describe('Reticulum reaction projection', () => {
  it('keeps add-only reactions when the event list refreshes', () => {
    const references = projectReticulumReactionReferences([
      reaction({ eventId: 'reaction-1', timestamp: 10 }),
      { eventId: 'message-2', eventType: 'message', timestamp: 20 },
    ]);

    expect(references['message-1'].reactions['👍']).toHaveLength(1);
    expect(references['message-1'].reactions['👍'][0].sender).toBe('alice');
  });

  it('uses event order rather than arrival order', () => {
    const references = projectReticulumReactionReferences([
      reaction({
        eventId: 'reaction-remove',
        eventType: 'reaction_remove',
        timestamp: 20,
      }),
      reaction({ eventId: 'reaction-add', timestamp: 10 }),
    ]);

    expect(references['message-1']).toBeUndefined();
  });

  it('uses author sequence when timestamps from one stream are skewed', () => {
    const add = reaction({ eventId: 'reaction-add', timestamp: 20 });
    const remove = reaction({
      eventId: 'reaction-remove',
      eventType: 'reaction_remove',
      timestamp: 10,
    });
    add.authorSeq = 1;
    remove.authorSeq = 2;

    expect(
      projectReticulumReactionReferences([remove, add])['message-1']
    ).toBeUndefined();
  });

  it('does not let one sender replace another sender reaction', () => {
    const references = projectReticulumReactionReferences([
      reaction({ eventId: 'reaction-1', sender: 'alice', timestamp: 10 }),
      reaction({ eventId: 'reaction-2', sender: 'bob', timestamp: 20 }),
    ]);

    expect(references['message-1'].reactions['👍']).toHaveLength(2);
  });
});
