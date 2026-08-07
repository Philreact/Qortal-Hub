import { generateHTML } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import Mention from '@tiptap/extension-mention';
import TextStyle from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { normalizeReticulumChatHtmlContent } from './reticulumMessageHtml';

const extensions = [StarterKit, Underline, Highlight, Mention, TextStyle];

describe('normalizeReticulumChatHtmlContent', () => {
  it('matches the existing TipTap HTML for rich chat content', () => {
    const document = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            {
              type: 'text',
              marks: [{ type: 'bold' }, { type: 'underline' }],
              text: 'Qortal',
            },
            { type: 'text', text: ' ' },
            {
              type: 'mention',
              attrs: { id: 'Qexample', label: 'Example' },
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      marks: [{ type: 'highlight' }],
                      text: 'Highlighted',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(normalizeReticulumChatHtmlContent(document)).toBe(
      generateHTML(document, extensions)
    );
  });

  it('preserves string messages and safely handles unsupported content', () => {
    expect(normalizeReticulumChatHtmlContent('  <p>hello</p>  ')).toBe(
      '<p>hello</p>'
    );
    expect(normalizeReticulumChatHtmlContent('')).toBe('<p></p>');
    expect(normalizeReticulumChatHtmlContent({ type: 'unknown' })).toBe(
      '<p></p>'
    );
  });
});
