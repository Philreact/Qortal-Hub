import { useCallback, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import './chat.css';
import { executeEvent } from '../../utils/events';
import { openHttpUrlExternally } from '../../utils/openExternalHttp';
import { Embed } from '../Embeds/Embed';
import { Box, IconButton, Tooltip, useTheme } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { QORTAL_PROTOCOL } from '../../constants/constants';
import { ReticulumUserCard } from './ReticulumUserCard';
import type { ReticulumUserCardData } from './ReticulumUserCard';

export const extractComponents = (url: string) => {
  if (!url || !url.startsWith(QORTAL_PROTOCOL)) {
    return null;
  }

  // Skip links starting with "qortal://use-"
  if (url.startsWith(QORTAL_PROTOCOL + 'use-')) {
    return null;
  }

  // Remove protocol prefix
  url = url.replace(/^qortal:\/\/?/i, '').trim();

  // If nothing meaningful left (e.g., "qortal://", "qortal:////"), return null
  if (!/[^/]/.test(url)) return null;

  // Case 1: url contains a slash -> already service-based
  if (url.includes('/')) {
    // Identifier is part of QDN resource identity when present. Keep older
    // links without identifier working, and route future reopen flows here.
    const [basePart, queryString = ''] = url.split('?');
    const parts = basePart.split('/');
    const service = parts[0].toUpperCase();
    parts.shift();
    const name = parts[0];
    parts.shift();

    const params = new URLSearchParams(queryString);
    const identifier = params.get('identifier') || undefined;
    if (identifier) {
      params.delete('identifier');
    }

    const remainingQuery = params.toString();
    const basePath = parts.join('/');
    const path = `${basePath}${remainingQuery ? `?${remainingQuery}` : ''}`;

    return { service, name, identifier, path };
  }

  // Case 2: url is just a username -> default to WEBSITE
  return {
    service: 'WEBSITE',
    name: url,
    identifier: undefined,
    path: '',
  };
};

function processText(input) {
  const linkRegex = /(qortal:\/\/\S+)/g;

  function processNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = node.textContent.split(linkRegex);
      if (parts.length > 0) {
        const fragment = document.createDocumentFragment();
        parts.forEach((part) => {
          if (part.startsWith(QORTAL_PROTOCOL)) {
            const link = document.createElement('span');
            link.setAttribute('data-url', part);
            link.setAttribute('class', 'qortal-link');
            link.textContent = part;
            fragment.appendChild(link);
          } else {
            fragment.appendChild(document.createTextNode(part));
          }
        });
        node.replaceWith(fragment);
      }
    } else {
      Array.from(node.childNodes).forEach(processNode);
    }
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = input;
  processNode(wrapper);
  return wrapper.innerHTML;
}

const linkify = (text) => {
  if (!text) return '';
  const cleanText = DOMPurify.sanitize(text);
  let textFormatted = cleanText;
  const urlPattern = /(\bhttps?:\/\/[^\s<]+|\bwww\.[^\s<]+)/g;
  textFormatted = cleanText.replace(urlPattern, (url) => {
    const href = url.startsWith('http') ? url : `https://${url}`;
    return `<a href="${DOMPurify.sanitize(href)}" class="auto-link">${DOMPurify.sanitize(url)}</a>`;
  });
  return processText(textFormatted);
};

const hasCodeBlock = (html) => /<pre[\s>]/i.test(html ?? '');

const normalizeHtmlContent = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
};

type MentionUser = {
  address: string;
  name?: string;
  role?: 'admin' | 'owner';
};

const parseReticulumChatLinkMention = (
  target: HTMLElement
): { groupId: number; channelId: string } | null => {
  const mention = target.closest?.(
    '[data-type="mention"], .mention'
  ) as HTMLElement | null;
  if (!mention) return null;
  const id = String(mention.dataset.id || '').trim();
  const match = id.match(/^reticulum-(?:group|channel):(\d+):(.+)$/);
  if (!match) return null;
  const groupId = Number(match[1]);
  if (!Number.isInteger(groupId) || groupId <= 0) return null;
  try {
    const channelId = decodeURIComponent(match[2]).trim();
    return channelId ? { groupId, channelId } : null;
  } catch {
    return null;
  }
};

export const MessageDisplay = ({
  htmlContent,
  isReply = false,
  mentionedAddresses,
  mentionUsers,
  myAddress,
  textColor,
}: {
  htmlContent: unknown;
  isReply?: boolean;
  mentionedAddresses?: string[];
  mentionUsers?: Record<string, MentionUser>;
  myAddress?: string;
  textColor?: string;
}) => {
  const theme = useTheme();
  const contentRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [mentionCard, setMentionCard] = useState<{
    anchorPlacement: 'above' | 'below';
    anchorPosition: { left: number; top: number };
    boundaryHeight: number;
    data: ReticulumUserCardData;
  } | null>(null);
  const safeHtmlContent = useMemo(
    () => normalizeHtmlContent(htmlContent),
    [htmlContent]
  );

  const sanitizedContent = useMemo(() => {
    return DOMPurify.sanitize(linkify(safeHtmlContent), {
      ALLOWED_TAGS: [
        'a',
        'b',
        'i',
        'em',
        'strong',
        'p',
        'br',
        'div',
        'span',
        'img',
        'ul',
        'ol',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'blockquote',
        'code',
        'pre',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        's',
        'hr',
      ],
      ALLOWED_ATTR: [
        'href',
        'target',
        'rel',
        'class',
        'src',
        'alt',
        'title',
        'width',
        'height',
        'align',
        'valign',
        'colspan',
        'rowspan',
        'border',
        'cellpadding',
        'cellspacing',
        'data-url',
        'data-id',
        'data-label',
        'data-type',
      ],
    }).replace(
      /<span[^>]*data-url="qortal:\/\/use-embed\/[^"]*"[^>]*>.*?<\/span>/g,
      ''
    );
  }, [safeHtmlContent]);

  const mentionUserByLabel = useMemo(() => {
    const map = new Map<string, MentionUser>();
    for (const [label, user] of Object.entries(mentionUsers || {})) {
      const normalizedLabel = label.trim().replace(/^@/, '').toLowerCase();
      if (normalizedLabel && user?.address) map.set(normalizedLabel, user);
      if (user?.address) map.set(user.address.toLowerCase(), user);
      if (user?.name) map.set(user.name.trim().toLowerCase(), user);
    }
    return map;
  }, [mentionUsers]);

  const openMentionCard = useCallback(
    (target: HTMLElement): boolean => {
      if (isReply) return false;
      const mention = target.closest?.(
        '[data-type="mention"], .mention'
      ) as HTMLElement | null;
      if (!mention) return false;
      const label = String(
        mention.dataset.label ||
          mention.dataset.id ||
          mention.textContent ||
          ''
      )
        .trim()
        .replace(/^@/, '');
      const uniqueMentionedAddresses = [
        ...new Set(
          (mentionedAddresses || [])
            .map((address) => String(address || '').trim())
            .filter(Boolean)
        ),
      ];
      const user =
        mentionUserByLabel.get(label.toLowerCase()) ||
        (uniqueMentionedAddresses.length === 1
          ? { address: uniqueMentionedAddresses[0], name: label }
          : undefined);
      if (!user?.address) return false;
      const mentionRect = mention.getBoundingClientRect();
      const chatViewport = mention.closest(
        '[data-reticulum-chat-scroll-viewport="true"]'
      ) as HTMLElement | null;
      const viewportRect = chatViewport?.getBoundingClientRect();
      const boundary = viewportRect || {
        bottom: window.innerHeight,
        height: window.innerHeight,
        left: 0,
        right: window.innerWidth,
        top: 0,
      };
      const estimatedCardHeight = user.address === myAddress ? 250 : 340;
      const cardWidth = Math.min(440, Math.max(280, boundary.right - boundary.left - 24));
      const spaceBelow = boundary.bottom - mentionRect.bottom;
      const spaceAbove = mentionRect.top - boundary.top;
      const anchorPlacement =
        spaceBelow >= estimatedCardHeight || spaceBelow >= spaceAbove
          ? 'below'
          : 'above';
      const left = Math.min(
        Math.max(mentionRect.left, boundary.left + 12),
        Math.max(boundary.left + 12, boundary.right - cardWidth - 12)
      );
      setMentionCard({
        anchorPlacement,
        anchorPosition: {
          left: Math.round(left),
          top: Math.round(
            anchorPlacement === 'above' ? mentionRect.top : mentionRect.bottom
          ),
        },
        boundaryHeight: boundary.height,
        data: {
          address: user.address,
          isMinterResolved: false,
          isOwn: user.address === myAddress,
          name: user.name || label,
          role: user.role,
          status: null,
        },
      });
      return true;
    },
    [isReply, mentionUserByLabel, mentionedAddresses, myAddress]
  );

  const handleClickCapture = (e) => {
    if (isReply) {
      const target = e.target as HTMLElement;
      const isLink =
        target.tagName === 'A' ||
        target.getAttribute?.('data-url') ||
        target.closest?.('a') ||
        target.closest?.('.qortal-link') ||
        target.closest?.('[data-url]');
      if (isLink) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  };

  const handleClick = async (e) => {
    if (isReply) {
      e.preventDefault();
      const target = e.target;
      const isLink =
        target.tagName === 'A' ||
        target.getAttribute?.('data-url') ||
        target.closest?.('a') ||
        target.closest?.('.qortal-link') ||
        target.closest?.('[data-url]');
      if (isLink) {
        e.stopPropagation();
        return;
      }
      return;
    }
    e.preventDefault();

    const target = e.target as HTMLElement;
    const reticulumChatLink = parseReticulumChatLinkMention(target);
    if (reticulumChatLink) {
      e.stopPropagation();
      executeEvent('openGroupMessage', {
        channelId: reticulumChatLink.channelId,
        from: reticulumChatLink.groupId,
      });
      return;
    }
    if (openMentionCard(target)) {
      e.stopPropagation();
      return;
    }
    if (target.tagName === 'A') {
      openHttpUrlExternally(target.getAttribute('href'));
    } else if (target.getAttribute('data-url')) {
      const url = target.getAttribute('data-url');

      let copyUrl = url;

      try {
        copyUrl = copyUrl.replace(/^(qortal:\/\/)/, '');
        if (copyUrl.startsWith('use-')) {
          const parts = copyUrl.split('/');
          parts.shift();
          const action = parts.length > 0 ? parts[0].split('-')[1] : null;
          parts.shift();
          const id = parts.length > 0 ? parts[0].split('-')[1] : null;
          if (action === 'join') {
            executeEvent('globalActionJoinGroup', { groupId: id });
            return;
          }
        }
      } catch (error) {
        console.log(error);
      }

      const res = extractComponents(url);
      if (res) {
        const { service, name, identifier, path } = res;
        executeEvent('addTab', { data: { service, name, identifier, path } });
        executeEvent('open-apps-mode', {});
      }
    }
  };

  const embedLink = safeHtmlContent.match(/qortal:\/\/use-embed\/[^\s<>]+/);

  let embedData = null;

  if (embedLink) {
    embedData = embedLink[0];
  }

  const showCopyButton = hasCodeBlock(sanitizedContent) && !isReply;

  const handleCopyCode = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const container = contentRef.current;
    if (!container) return;
    const preEls = container.querySelectorAll('.tiptap pre');
    if (!preEls.length) return;
    const text = Array.from(preEls)
      .map((el) => el.textContent?.trim() ?? '')
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('Copy failed', err);
    }
  }, []);

  return (
    <Box
      sx={{
        '--text-primary': theme.palette.text.primary,
        '--text-secondary': theme.palette.text.secondary,
        '--background-default': theme.palette.background.default,
        '--background-secondary': theme.palette.background.paper,
        '--code-block-bg': theme.palette.background.paper,
        '--code-block-accent': theme.palette.primary.main,
        '--code-block-border': theme.palette.divider,
        '--primary-main':
          theme.palette.mode === 'light'
            ? theme.palette.primary.dark
            : theme.palette.primary.main,
        ...(textColor ? { '--text-primary': textColor } : {}),
      }}
    >
      {embedLink && <Embed embedLink={embedData} />}
      <Box
        ref={contentRef}
        sx={{
          position: 'relative',
          '&:hover .message-copy-code-btn': { opacity: 1 },
        }}
      >
        <div
          className={`tiptap ${isReply ? 'isReply' : ''}`}
          dangerouslySetInnerHTML={{ __html: sanitizedContent }}
          onClick={handleClick}
          onClickCapture={handleClickCapture}
        />
        {showCopyButton && (
          <Tooltip title={copied ? 'Copied!' : 'Copy code'} leaveDelay={0}>
            <IconButton
              className="message-copy-code-btn"
              size="small"
              onClick={handleCopyCode}
              sx={{
                position: 'absolute',
                top: 4,
                right: 4,
                opacity: 0,
                transition: 'opacity 0.15s ease',
                backgroundColor: theme.palette.background.paper,
                color: theme.palette.text.secondary,
                '&:hover': {
                  backgroundColor: theme.palette.background.default,
                  color: theme.palette.text.primary,
                },
              }}
              aria-label={copied ? 'Copied!' : 'Copy code'}
            >
              <ContentCopyIcon sx={{ fontSize: '18px' }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      {mentionCard && (
        <ReticulumUserCard
          anchorEl={null}
          anchorPlacement={mentionCard.anchorPlacement}
          anchorPosition={mentionCard.anchorPosition}
          boundaryHeight={mentionCard.boundaryHeight}
          data={mentionCard.data}
          onClose={() => setMentionCard(null)}
        />
      )}
    </Box>
  );
};
