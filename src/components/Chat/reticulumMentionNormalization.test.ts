import { describe, expect, it } from 'vitest';
import type { MentionSuggestionItem } from './TipTap';
import { normalizeExactReticulumMentions } from './reticulumMentionNormalization';

const suggestions: MentionSuggestionItem[] = [
  {
    description: 'Notify all members',
    id: 'everyone',
    kind: 'everyone',
    label: 'everyone',
    section: 'special',
  },
  {
    description: 'Member',
    id: 'Qabc123',
    kind: 'person',
    label: 'Alice',
    section: 'people',
  },
  {
    description: 'Channel',
    id: 'reticulum-channel:7:general-chat',
    kind: 'channel',
    label: 'general-chat',
    section: 'channels',
  },
];

describe('normalizeExactReticulumMentions', () => {
  it('turns exact manually typed labels into structured mention nodes', () => {
    const result = normalizeExactReticulumMentions(
      {
        content: [
          {
            content: [
              {
                text: 'Hi @Alice, notify @everyone in @general-chat.',
                type: 'text',
              },
            ],
            type: 'paragraph',
          },
        ],
        type: 'doc',
      },
      suggestions
    );

    expect(result.changed).toBe(true);
    expect(result.document).toEqual({
      content: [
        {
          content: [
            { text: 'Hi ', type: 'text' },
            { attrs: { id: 'Qabc123', label: 'Alice' }, type: 'mention' },
            { text: ', notify ', type: 'text' },
            {
              attrs: { id: 'everyone', label: 'everyone' },
              type: 'mention',
            },
            { text: ' in ', type: 'text' },
            {
              attrs: {
                id: 'reticulum-channel:7:general-chat',
                label: 'general-chat',
              },
              type: 'mention',
            },
            { text: '.', type: 'text' },
          ],
          type: 'paragraph',
        },
      ],
      type: 'doc',
    });
  });

  it('does not convert partial, unknown, or code-block labels', () => {
    const document = {
      content: [
        {
          content: [{ text: '@everyoneElse @unknown', type: 'text' }],
          type: 'paragraph',
        },
        {
          content: [{ text: '@everyone', type: 'text' }],
          type: 'codeBlock',
        },
      ],
      type: 'doc',
    };
    const result = normalizeExactReticulumMentions(document, suggestions);

    expect(result.changed).toBe(false);
    expect(result.document).toBe(document);
  });
});
