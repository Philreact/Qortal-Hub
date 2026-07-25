import type { MentionSuggestionItem } from './TipTap';

type TiptapJsonNode = {
  attrs?: Record<string, unknown>;
  content?: TiptapJsonNode[];
  marks?: Array<Record<string, unknown>>;
  text?: string;
  type?: string;
};

const escapePattern = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const shouldSkipTextNormalization = (node: TiptapJsonNode): boolean =>
  node.type === 'codeBlock' || node.type === 'code';

/**
 * Converts exact, manually typed @labels into the same structured mention
 * nodes produced by the autocomplete menu. This keeps notification, access,
 * navigation, and user-card behavior identical for both input paths.
 */
export const normalizeExactReticulumMentions = (
  document: Record<string, unknown>,
  suggestions: MentionSuggestionItem[] = []
): { changed: boolean; document: Record<string, unknown> } => {
  const suggestionByLabel = new Map<string, MentionSuggestionItem>();
  for (const suggestion of suggestions) {
    const label = String(suggestion?.label || '').trim();
    if (!label) continue;
    const normalizedLabel = label.toLowerCase();
    if (!suggestionByLabel.has(normalizedLabel)) {
      suggestionByLabel.set(normalizedLabel, suggestion);
    }
  }
  const labels = [...suggestionByLabel.keys()].sort(
    (left, right) => right.length - left.length
  );
  if (labels.length === 0) return { changed: false, document };

  const mentionPattern = new RegExp(
    `(^|[\\s(])@(${labels.map(escapePattern).join('|')})(?=$|[\\s.,!?;:)\\]])`,
    'gi'
  );
  let changed = false;

  const normalizeNode = (node: TiptapJsonNode): TiptapJsonNode => {
    if (shouldSkipTextNormalization(node)) return node;
    if (node.type === 'mention') return node;

    if (node.type === 'text' && typeof node.text === 'string') {
      const matches = [...node.text.matchAll(mentionPattern)];
      if (matches.length === 0) return node;

      const content: TiptapJsonNode[] = [];
      let cursor = 0;
      for (const match of matches) {
        const matchIndex = match.index ?? 0;
        const leadingCharacter = match[1] || '';
        const mentionStart = matchIndex + leadingCharacter.length;
        if (mentionStart > cursor) {
          content.push({
            ...node,
            text: node.text.slice(cursor, mentionStart),
          });
        }
        const suggestion = suggestionByLabel.get(match[2].toLowerCase());
        if (!suggestion) continue;
        content.push({
          attrs: {
            id: suggestion.id,
            label: suggestion.label,
          },
          type: 'mention',
        });
        cursor = matchIndex + match[0].length;
      }
      if (cursor < node.text.length) {
        content.push({ ...node, text: node.text.slice(cursor) });
      }
      changed = true;
      return {
        content,
        type: '__reticulumMentionFragment',
      };
    }

    if (!Array.isArray(node.content)) return node;
    const normalizedContent = node.content.flatMap((child) => {
      const normalizedChild = normalizeNode(child);
      return normalizedChild.type === '__reticulumMentionFragment'
        ? normalizedChild.content || []
        : [normalizedChild];
    });
    return normalizedContent === node.content
      ? node
      : { ...node, content: normalizedContent };
  };

  const normalizedDocument = normalizeNode(document as TiptapJsonNode);
  return {
    changed,
    document: changed
      ? (normalizedDocument as Record<string, unknown>)
      : document,
  };
};
