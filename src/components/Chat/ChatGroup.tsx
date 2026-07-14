import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { Rnd } from 'react-rnd';
import {
  userInfoAtom,
  balanceAtom,
  blockedAddressesAtom,
  groupQManagerPopupSizeAtom,
  reticulumChatSummariesAtom,
  type ReticulumChatSummaryAtomEntry,
} from '../../atoms/global';
import {
  decodeBase64ForUIChatMessages,
  objectToBase64,
} from '../../qdn/encryption/group-encryption';
import { ChatList } from './ChatList';
import Tiptap from './TipTap';
import './chat.css';
import { CustomButton } from '../../styles/App-styles';
import CircularProgress from '@mui/material/CircularProgress';
import { LoadingSnackbar } from '../Snackbar/LoadingSnackbar';
import {
  getBaseApiReact,
  getBaseApiReactSocket,
  QORTAL_APP_CONTEXT,
  pauseAllQueues,
  resumeAllQueues,
} from '../../App';
import { CustomizedSnackbars } from '../Snackbar/Snackbar';
import {
  MAX_SIZE_MESSAGE,
  MESSAGE_LIMIT_WARNING,
  MIN_REQUIRED_QORTS,
  PUBLIC_NOTIFICATION_CODE_FIRST_SECRET_KEY,
  TIME_MINUTES_2_IN_MILLISECONDS,
} from '../../constants/constants';
import { useMessageQueue } from '../../messaging/MessageQueueContext.tsx';
import {
  executeEvent,
  subscribeToEvent,
  unsubscribeFromEvent,
} from '../../utils/events';
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Portal,
  SvgIcon,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import ShortUniqueId from 'short-unique-id';
import { ReplyPreview } from './MessageItem';
import { ExitIcon } from '../../assets/Icons/ExitIcon';
import { RESOURCE_TYPE_NUMBER_GROUP_CHAT_REACTIONS } from '../../constants/constants';
import { getFee, isExtMsg } from '../../background/background.ts';
import { appHeighOffset, appHeighOffsetPx } from '../Desktop/CustomTitleBar';
import AppViewerContainer from '../Apps/AppViewerContainer';
import CloseIcon from '@mui/icons-material/Close';
import { throttle } from 'lodash';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import CallIcon from '@mui/icons-material/Call';
import CallEndRoundedIcon from '@mui/icons-material/CallEndRounded';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import ChatRoundedIcon from '@mui/icons-material/ChatRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import DriveFileRenameOutlineRoundedIcon from '@mui/icons-material/DriveFileRenameOutlineRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import EmojiEmotionsRoundedIcon from '@mui/icons-material/EmojiEmotionsRounded';
import ForumRoundedIcon from '@mui/icons-material/ForumRounded';
import ImageIcon from '@mui/icons-material/Image';
import InsertDriveFileRoundedIcon from '@mui/icons-material/InsertDriveFileRounded';
import FolderRoundedIcon from '@mui/icons-material/FolderRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import PeopleAltRoundedIcon from '@mui/icons-material/PeopleAltRounded';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import SendIcon from '@mui/icons-material/Send';
import SecurityRoundedIcon from '@mui/icons-material/SecurityRounded';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import SportsEsportsIcon from '@mui/icons-material/SportsEsports';
import TagRoundedIcon from '@mui/icons-material/TagRounded';
import VisibilityOffRoundedIcon from '@mui/icons-material/VisibilityOffRounded';
import { ContextMenu } from '../ContextMenu';
import { messageHasImage } from '../../utils/chat';
import { useTranslation } from 'react-i18next';
import {
  isDisabledTyping,
  useReticulumGroupChat,
} from '../../hooks/useReticulumGroupChat';
import { fileToBase64 } from '../../utils/fileReading';
import { generateHTML } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Mention from '@tiptap/extension-mention';
import TextStyle from '@tiptap/extension-text-style';
import {
  getGroupAdminsAddress,
  getGroupMembers,
  getPrimaryNamesForAddresses,
} from '../Group/groupApi';
import Compressor from 'compressorjs';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import EmojiPicker, { EmojiStyle, Theme } from 'emoji-picker-react';

type PendingReticulumResourceFile = {
  filePath?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  previewUrl?: string;
  base64?: string;
  width?: number;
  height?: number;
};

type ReticulumGroupChannel = {
  channelId: string;
  groupId: number;
  categoryId?: string;
  name: string;
  description?: string;
  position: number;
  archived: boolean;
  writeMode?: ReticulumGroupChannelWriteMode;
  readMode?: ReticulumGroupChannelReadMode;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

type ReticulumGroupChannelWriteMode = 'members' | 'admins';
type ReticulumGroupChannelReadMode = 'members' | 'admins';
type ReticulumGroupChannelAccessMode = 'regular' | 'admin_write' | 'admin_private';

type ReticulumSearchResult = {
  event: {
    eventId: string;
    groupId: number;
    channelId?: string;
    authorAddress?: string;
    authorPrimaryName?: string;
    senderName?: string;
    timestamp?: number;
    eventType?: string;
    encryptedPayload?: string;
  };
  snippet?: string;
  cursor?: ReticulumSearchCursor;
};

type ReticulumSearchCursor = {
  createdAt: number;
  eventId: string;
};

const RETICULUM_SEARCH_CHANNEL_CURRENT = '__current__';
const RETICULUM_SEARCH_CHANNEL_ALL = '__all__';
const RETICULUM_SEARCH_HAS_ANY = 'any';
const RETICULUM_SEARCH_HAS_ATTACHMENT = 'attachment';
const RETICULUM_SEARCH_HAS_LINK = 'link';
const RETICULUM_SEARCH_PAGE_SIZE = 20;

const RETICULUM_CHANNEL_WRITE_MODE_MEMBERS: ReticulumGroupChannelWriteMode =
  'members';
const RETICULUM_CHANNEL_WRITE_MODE_ADMINS: ReticulumGroupChannelWriteMode =
  'admins';
const RETICULUM_CHANNEL_READ_MODE_MEMBERS: ReticulumGroupChannelReadMode =
  'members';
const RETICULUM_CHANNEL_READ_MODE_ADMINS: ReticulumGroupChannelReadMode =
  'admins';
const RETICULUM_CHANNEL_ACCESS_REGULAR: ReticulumGroupChannelAccessMode =
  'regular';
const RETICULUM_CHANNEL_ACCESS_ADMIN_WRITE: ReticulumGroupChannelAccessMode =
  'admin_write';
const RETICULUM_CHANNEL_ACCESS_ADMIN_PRIVATE: ReticulumGroupChannelAccessMode =
  'admin_private';

function reticulumChannelAccessFromModes(
  writeMode?: ReticulumGroupChannelWriteMode,
  readMode?: ReticulumGroupChannelReadMode
): ReticulumGroupChannelAccessMode {
  if (readMode === RETICULUM_CHANNEL_READ_MODE_ADMINS) {
    return RETICULUM_CHANNEL_ACCESS_ADMIN_PRIVATE;
  }
  if (writeMode === RETICULUM_CHANNEL_WRITE_MODE_ADMINS) {
    return RETICULUM_CHANNEL_ACCESS_ADMIN_WRITE;
  }
  return RETICULUM_CHANNEL_ACCESS_REGULAR;
}

function reticulumChannelModesFromAccess(accessMode: ReticulumGroupChannelAccessMode): {
  writeMode: ReticulumGroupChannelWriteMode;
  readMode: ReticulumGroupChannelReadMode;
} {
  if (accessMode === RETICULUM_CHANNEL_ACCESS_ADMIN_PRIVATE) {
    return {
      writeMode: RETICULUM_CHANNEL_WRITE_MODE_ADMINS,
      readMode: RETICULUM_CHANNEL_READ_MODE_ADMINS,
    };
  }
  if (accessMode === RETICULUM_CHANNEL_ACCESS_ADMIN_WRITE) {
    return {
      writeMode: RETICULUM_CHANNEL_WRITE_MODE_ADMINS,
      readMode: RETICULUM_CHANNEL_READ_MODE_MEMBERS,
    };
  }
  return {
    writeMode: RETICULUM_CHANNEL_WRITE_MODE_MEMBERS,
    readMode: RETICULUM_CHANNEL_READ_MODE_MEMBERS,
  };
}

function cleanReticulumSearchSnippet(snippet?: string): string {
  return (typeof snippet === 'string' ? snippet : '')
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, ' ')
    .replace(/<(?!\/?mark\b)[^>]+>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function renderReticulumSearchSnippet(snippet?: string): ReactNode {
  const text = cleanReticulumSearchSnippet(snippet);
  if (!text) return '';
  const parts = text.split(/(<mark>|<\/mark>)/g);
  let highlighted = false;
  return parts
    .filter((part) => part.length > 0)
    .map((part, index) => {
      if (part === '<mark>') {
        highlighted = true;
        return null;
      }
      if (part === '</mark>') {
        highlighted = false;
        return null;
      }
      return highlighted ? (
        <Box
          component="mark"
          key={`${part}-${index}`}
          sx={{
            backgroundColor: (theme) => alpha(theme.palette.warning.main, 0.3),
            borderRadius: '3px',
            color: 'inherit',
            px: '2px',
          }}
        >
          {part}
        </Box>
      ) : (
        <span key={`${part}-${index}`}>{part}</span>
      );
    });
}

function reticulumAttachmentNamesFromRecord(record: unknown): string[] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  const attachments = (record as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return [];
  return [
    ...new Set(
      attachments
        .map((attachment) => {
          if (!attachment || typeof attachment !== 'object') return '';
          const item = attachment as Record<string, unknown>;
          return typeof item.fileName === 'string' && item.fileName.trim()
            ? item.fileName.trim()
            : typeof item.name === 'string' && item.name.trim()
              ? item.name.trim()
              : '';
        })
        .filter(Boolean)
    ),
  ];
}

function reticulumAttachmentNamesFromPayload(payload?: string): string[] {
  if (!payload) return [];
  try {
    return reticulumAttachmentNamesFromRecord(JSON.parse(payload));
  } catch {
    return [];
  }
}

function buildReticulumSearchIndexText(
  messageText: string,
  decryptedData: unknown
): string {
  const attachmentNames = reticulumAttachmentNamesFromRecord(decryptedData);
  return [messageText, ...attachmentNames]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' ');
}

function localDateStringToTimestamp(dateString: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return undefined;
  const [year, month, day] = dateString.split('-').map(Number);
  const timestamp = new Date(year, month - 1, day).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

type ReticulumGroupCategory = {
  categoryId: string;
  groupId: number;
  name: string;
  position: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

const DEFAULT_RETICULUM_CHANNEL_ID = 'general';
const QORTAL_LAND_RETICULUM_CHANNEL_ID = 'qortal-land';
const isReticulumSystemChannelId = (channelId: string) =>
  channelId === DEFAULT_RETICULUM_CHANNEL_ID ||
  channelId === QORTAL_LAND_RETICULUM_CHANNEL_ID;
const RETICULUM_CHANNEL_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000];
const RETICULUM_CHANNEL_DRAG_PREFIX = 'reticulum-channel:';
const RETICULUM_CATEGORY_DRAG_PREFIX = 'reticulum-category-drag:';
const RETICULUM_CATEGORY_DROP_PREFIX = 'reticulum-category:';

const normalizeReticulumChannelName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const normalizeReticulumDisplayName = (value: unknown) =>
  (typeof value === 'string' ? value : '')
    .normalize('NFC')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim()
    .slice(0, 80);

const reticulumDisplayNameKey = (value: unknown) =>
  normalizeReticulumDisplayName(value).toLocaleLowerCase();

const uid = new ShortUniqueId({ length: 5 });
const uidImages = new ShortUniqueId({ length: 12 });
const RETICULUM_ACTIVE_BLUE = '#2563eb';
const RETICULUM_ACTIVE_BLUE_HOVER = '#1e40af';
const Q_MANAGER_DEFAULT_WIDTH = 600;
const Q_MANAGER_DEFAULT_HEIGHT = 720;
const Q_MANAGER_MIN_WIDTH = 540;
const Q_MANAGER_MIN_HEIGHT = 560;
const Q_MANAGER_HEADER_HEIGHT = 40;
const RETICULUM_INLINE_IMAGE_THRESHOLD_BYTES = 1_000_000;
const RETICULUM_TYPING_IDLE_STOP_MS = 5_000;

const reticulumDialogPaperSx = {
  backgroundImage: 'none',
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: '10px',
  boxShadow: '0 24px 70px rgba(0,0,0,0.45)',
} as const;

const reticulumDialogTitleSx = {
  fontFamily: 'Inter',
  fontSize: 18,
  fontWeight: 800,
  pb: 1,
} as const;

const reticulumDialogContentSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1.5,
  pt: '8px !important',
} as const;

const reticulumSecondaryButtonSx = {
  borderRadius: '8px',
  color: 'text.secondary',
  fontWeight: 700,
  px: 2,
  textTransform: 'none',
  '&:hover': {
    backgroundColor: 'action.hover',
    color: 'text.primary',
  },
} as const;

const reticulumPrimaryButtonSx = {
  backgroundColor: RETICULUM_ACTIVE_BLUE,
  borderRadius: '8px',
  color: 'common.white',
  fontWeight: 700,
  px: 2.25,
  textTransform: 'none',
  '&:hover': {
    backgroundColor: RETICULUM_ACTIVE_BLUE_HOVER,
  },
} as const;

const reticulumDialogTextFieldSx = {
  '& .MuiOutlinedInput-root': {
    backgroundColor: 'background.default',
    borderRadius: '8px',
  },
  '& .MuiInputLabel-root.Mui-focused': {
    color: RETICULUM_ACTIVE_BLUE,
  },
  '& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': {
    borderColor: RETICULUM_ACTIVE_BLUE,
  },
} as const;

const ReticulumMegaphoneIcon = (props) => (
  <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M20.5 4.75c0-.79-.87-1.27-1.54-.85L10.1 9.4H5.25A2.25 2.25 0 0 0 3 11.65v.7a2.25 2.25 0 0 0 2.25 2.25H6.4l1.52 4.18c.22.6.78.99 1.42.99h2.06c.72 0 1.2-.74.91-1.4l-1.63-3.75 8.28 5.48c.67.43 1.54-.05 1.54-.85V4.75Z" />
  </SvgIcon>
);

const reticulumChannelTypeOptions = [
  {
    description: 'Everyone can read and write.',
    icon: PublicRoundedIcon,
    label: 'Regular',
    value: RETICULUM_CHANNEL_ACCESS_REGULAR,
  },
  {
    description: 'Only admins can post. Everyone can read.',
    icon: ReticulumMegaphoneIcon,
    label: 'Announcements',
    value: RETICULUM_CHANNEL_ACCESS_ADMIN_WRITE,
  },
  {
    description: 'Only admins and the group owner can access.',
    icon: VisibilityOffRoundedIcon,
    label: 'Admin Only',
    value: RETICULUM_CHANNEL_ACCESS_ADMIN_PRIVATE,
  },
] as const;

const reticulumChannelTypeOptionByAccess = (
  accessMode: ReticulumGroupChannelAccessMode
) =>
  reticulumChannelTypeOptions.find((option) => option.value === accessMode) ||
  reticulumChannelTypeOptions[0];

type QManagerAnchorRect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

const isReticulumCompressibleImage = (file: File) =>
  file.type?.startsWith('image/') === true && file.type !== 'image/gif';

const formatReticulumFileSize = (bytes?: number) => {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) return '0 bytes';
  if (size < 1024) return `${size} ${size === 1 ? 'byte' : 'bytes'}`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.ceil(size / 1024))} KB`;
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const compressReticulumImageFile = (file: File): Promise<File> =>
  new Promise((resolve) => {
    new Compressor(file, {
      quality: 0.6,
      maxWidth: 1200,
      mimeType: 'image/webp',
      success(result) {
        resolve(
          new File(
            [result],
            `${file.name.replace(/\.[^.]+$/, '') || 'image'}.webp`,
            {
              type: 'image/webp',
              lastModified: Date.now(),
            }
          )
        );
      },
      error(err) {
        console.error('Reticulum image compression error:', err);
        resolve(file);
      },
    });
  });

const reticulumChannelDragId = (channelId: string) =>
  `${RETICULUM_CHANNEL_DRAG_PREFIX}${channelId}`;

const reticulumCategoryDragId = (categoryId: string) =>
  `${RETICULUM_CATEGORY_DRAG_PREFIX}${categoryId}`;

const reticulumCategoryDropId = (categoryId: string) =>
  `${RETICULUM_CATEGORY_DROP_PREFIX}${categoryId}`;

const parseReticulumChannelDragId = (id: unknown) =>
  typeof id === 'string' && id.startsWith(RETICULUM_CHANNEL_DRAG_PREFIX)
    ? id.slice(RETICULUM_CHANNEL_DRAG_PREFIX.length)
    : '';

const parseReticulumCategoryDragId = (id: unknown) =>
  typeof id === 'string' && id.startsWith(RETICULUM_CATEGORY_DRAG_PREFIX)
    ? id.slice(RETICULUM_CATEGORY_DRAG_PREFIX.length)
    : '';

const parseReticulumCategoryDropId = (id: unknown) =>
  typeof id === 'string' && id.startsWith(RETICULUM_CATEGORY_DROP_PREFIX)
    ? id.slice(RETICULUM_CATEGORY_DROP_PREFIX.length)
    : '';

const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const mentionAddressHash = (address: string) =>
  sha256Hex(`reticulum-chat-mention:${address.trim()}`);

const buildMentionAddressHashes = async (addresses: string[]) => [
  ...new Set(
    await Promise.all(
      addresses
        .map((address) => address.trim())
        .filter(Boolean)
        .map((address) => mentionAddressHash(address))
    )
  ),
];

type ReticulumSortableChannelButtonProps = {
  channel: ReticulumGroupChannel;
  hasUnreadMention: boolean;
  isAdmin: boolean;
  mentionCount: number;
  onSelect: (channelId: string) => void;
  onSettings: (channel: ReticulumGroupChannel) => void;
  selected: boolean;
  unreadCount: number;
};

function ReticulumSortableChannelButton({
  channel,
  hasUnreadMention,
  isAdmin,
  mentionCount,
  onSelect,
  onSettings,
  selected,
  unreadCount,
}: ReticulumSortableChannelButtonProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: reticulumChannelDragId(channel.channelId),
    disabled: !isAdmin,
  });
  const hasUnread = unreadCount > 0 || hasUnreadMention;
  const emphasized = selected || hasUnread;
  const channelTypeOption = reticulumChannelTypeOptionByAccess(
    reticulumChannelAccessFromModes(channel.writeMode, channel.readMode)
  );
  const ChannelTypeIcon = channelTypeOption.icon;

  return (
    <ButtonBase
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onSelect(channel.channelId)}
      sx={{
        alignItems: 'center',
        backgroundColor: selected
          ? alpha('#9fb3c8', 0.12)
          : 'transparent',
        borderRadius: '6px',
        color: emphasized ? 'common.white' : 'text.secondary',
        cursor: 'pointer',
        display: 'flex',
        fontSize: 14,
        fontWeight: 500,
        justifyContent: 'space-between',
        mb: 0.5,
        opacity: isDragging ? 0.55 : 1,
        pl: 1.25,
        pr: 0.75,
        py: 0.75,
        position: 'relative',
        textAlign: 'left',
        lineHeight: 1.25,
        transform: CSS.Transform.toString(transform),
        transition,
        width: '100%',
        zIndex: isDragging ? 3 : 'auto',
        '&:before': {
          backgroundColor: selected ? 'primary.main' : 'transparent',
          borderRadius: '999px',
          content: '""',
          height: selected ? 22 : 0,
          left: 0,
          position: 'absolute',
          transition: 'height 120ms ease',
          width: 3,
        },
        '& .reticulum-channel-settings': {
          opacity: 0,
          pointerEvents: 'none',
        },
        textRendering: 'geometricPrecision',
        WebkitFontSmoothing: 'antialiased',
        '&:hover': {
          backgroundColor: 'action.hover',
          color: 'common.white',
        },
        '&:hover .reticulum-channel-settings': {
          opacity: 1,
          pointerEvents: 'auto',
        },
      }}
    >
      <Box
        component="span"
        sx={{
          alignItems: 'center',
          display: 'inline-flex',
          gap: 0.75,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        <ChannelTypeIcon
          aria-hidden
          sx={{
            color: emphasized ? 'inherit' : 'text.disabled',
            flexShrink: 0,
            fontSize: 18,
          }}
        />
        <Box
          component="span"
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {channel.name || channel.channelId}
        </Box>
      </Box>
      <Box
        component="span"
        sx={{
          alignItems: 'center',
          display: 'inline-flex',
          flexShrink: 0,
          gap: 0.5,
          ml: 1,
        }}
      >
        {hasUnreadMention && (
          <Tooltip
            title={
              mentionCount > 1
                ? `${mentionCount} unread mentions`
                : 'Unread mention'
            }
          >
            <Box
              component="span"
              sx={{
                alignItems: 'center',
                backgroundColor: 'error.main',
                borderRadius: '999px',
                color: 'error.contrastText',
                display: 'inline-flex',
                fontSize: 11,
                fontWeight: 800,
                height: 18,
                justifyContent: 'center',
                minWidth: 18,
                px: 0.5,
              }}
            >
              {mentionCount > 1 ? mentionCount : '@'}
            </Box>
          </Tooltip>
        )}
        {unreadCount > 0 && (
          <Tooltip
            title={
              unreadCount > 1
                ? `${unreadCount} unread messages`
                : 'Unread message'
            }
          >
            <Box
              component="span"
              sx={{
                alignItems: 'center',
                backgroundColor: hasUnreadMention
                  ? 'action.selected'
                  : 'primary.main',
                borderRadius: '999px',
                color: hasUnreadMention
                  ? 'text.primary'
                  : 'primary.contrastText',
                display: 'inline-flex',
                fontSize: 11,
                fontWeight: 800,
                height: 18,
                justifyContent: 'center',
                minWidth: 18,
                px: 0.5,
              }}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </Box>
          </Tooltip>
        )}
        {isAdmin && (
          <Box
            className="reticulum-channel-settings"
            component="button"
            aria-label={`Manage ${channel.name || channel.channelId}`}
            onClick={(event) => {
              event.stopPropagation();
              onSettings(channel);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            sx={{
              alignItems: 'center',
              background: 'transparent',
              border: 0,
              borderRadius: '4px',
              color: 'text.secondary',
              cursor: 'pointer',
              display: 'inline-flex',
              height: 22,
              justifyContent: 'center',
              ml: 0.25,
              p: 0,
              transition: 'opacity 120ms ease, color 120ms ease',
              width: 22,
              '&:hover': {
                backgroundColor: 'action.hover',
                color: 'text.primary',
              },
            }}
          >
            <SettingsOutlinedIcon sx={{ fontSize: 16 }} />
          </Box>
        )}
      </Box>
    </ButtonBase>
  );
}

function ReticulumCategoryDropZone({
  children,
  disabled,
  id,
}: {
  children: ReactNode;
  disabled: boolean;
  id: string;
}) {
  const { isOver, setNodeRef } = useDroppable({ id, disabled });

  return (
    <Box
      ref={setNodeRef}
      sx={{
        borderRadius: '8px',
        mb: 1,
        outline: isOver ? '1px solid' : '1px solid transparent',
        outlineColor: isOver ? 'primary.main' : 'transparent',
        outlineOffset: 2,
        px: isOver ? 0.5 : 0,
        py: isOver ? 0.25 : 0,
        transition: 'outline-color 120ms ease, padding 120ms ease',
      }}
    >
      {children}
    </Box>
  );
}

function ReticulumSortableCategory({
  category,
  children,
  isAdmin,
  isCollapsed,
  onContextMenu,
  onCreateChannel,
  onToggleCollapsed,
}: {
  category: ReticulumGroupCategory;
  children: ReactNode;
  isAdmin: boolean;
  isCollapsed: boolean;
  onContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    category: ReticulumGroupCategory
  ) => void;
  onCreateChannel: (categoryId: string) => void;
  onToggleCollapsed: (categoryId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: reticulumCategoryDragId(category.categoryId),
    disabled: !isAdmin,
  });

  return (
    <ReticulumCategoryDropZone
      disabled={!isAdmin}
      id={reticulumCategoryDropId(category.categoryId)}
    >
      <Box
        ref={setNodeRef}
        sx={{
          opacity: isDragging ? 0.55 : 1,
          position: 'relative',
          transform: CSS.Transform.toString(transform),
          transition,
          zIndex: isDragging ? 3 : 'auto',
        }}
      >
        <Box
          {...attributes}
          {...listeners}
          onContextMenu={(event) => onContextMenu(event, category)}
          sx={{
            alignItems: 'center',
            color: 'text.secondary',
            cursor: 'pointer',
            display: 'flex',
            fontSize: 11,
            fontWeight: 800,
            justifyContent: 'space-between',
            minHeight: 28,
            mt: 1.25,
            px: 0.5,
            textTransform: 'uppercase',
            touchAction: isAdmin ? 'none' : 'auto',
            userSelect: 'none',
          }}
        >
          <Box
            component="button"
            onClick={() => onToggleCollapsed(category.categoryId)}
            onPointerDown={(event) => event.stopPropagation()}
            sx={{
              alignItems: 'center',
              background: 'transparent',
              border: 0,
              color: 'inherit',
              cursor: 'pointer',
              display: 'inline-flex',
              font: 'inherit',
              fontWeight: 'inherit',
              gap: 0.25,
              minWidth: 0,
              overflow: 'hidden',
              p: 0,
              textAlign: 'left',
              textTransform: 'inherit',
            }}
          >
            <Tooltip title={category.name}>
              <Box
                component="span"
                sx={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {category.name}
              </Box>
            </Tooltip>
            {isCollapsed ? (
              <ChevronRightRoundedIcon sx={{ fontSize: 16 }} />
            ) : (
              <ExpandMoreRoundedIcon sx={{ fontSize: 16 }} />
            )}
          </Box>
          {isAdmin && (
            <Tooltip title={`Create channel in ${category.name}`}>
              <IconButton
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  onCreateChannel(category.categoryId);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                sx={{
                  color: 'text.secondary',
                  cursor: 'pointer',
                  ml: 0.5,
                  p: 0.25,
                  '&:hover': { color: 'text.primary' },
                }}
              >
                <AddIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        {!isCollapsed && children}
      </Box>
    </ReticulumCategoryDropZone>
  );
}

const normalizeChatHtmlContent = (raw: unknown): string => {
  if (raw == null) return '<p></p>';
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : '<p></p>';
  }
  if (typeof raw === 'object') {
    try {
      const doc = raw as { type?: string; content?: unknown };
      if (doc.type === 'doc' && Array.isArray(doc.content)) {
        return generateHTML(doc, [
          StarterKit,
          Underline,
          Highlight,
          Mention,
          TextStyle,
        ]);
      }
    } catch {
      // Fall through to empty paragraph.
    }
  }
  return '<p></p>';
};

const mentionTextFromHtml = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const escapeMentionRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const textHasMentionToken = (text: string, label: string): boolean => {
  const normalized = String(label || '').trim();
  if (!normalized) return false;
  return new RegExp(
    `(^|\\s)@${escapeMentionRegExp(normalized)}(?=$|\\s|[.,!?;:)\\]])`,
    'i'
  ).test(text);
};

const normalizeMentionTargetLabel = (value: unknown): string =>
  String(value || '').trim().slice(0, 120);

const mentionedAddressesFromPayload = (payload: unknown): string[] => {
  if (!payload || typeof payload !== 'object') return [];
  const value = (payload as { mentionedAddresses?: unknown })
    .mentionedAddresses;
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((address) => (typeof address === 'string' ? address.trim() : ''))
        .filter(Boolean)
    ),
  ];
};

export const ChatGroup = ({
  selectedGroup,
  selectedGroupName = '',
  secretKey,
  getSecretKey,
  myAddress,
  handleNewEncryptionNotification,
  hide,
  handleSecretKeyCreationInProgress,
  triedToFetchSecretKey,
  getTimestampEnterChatParent,
  hideView,
  isActive,
  isPrivate,
  notificationReticulumChannelId,
  onReticulumChannelSelected,
  onGroupCallClick,
  onQortalLandClick,
  onAnnouncementsClick,
  onThreadsClick,
  onMembersClick,
  onAdminsClick,
  membersPanelOpen = false,
  groupCallInCall = false,
  groupCallJoining = false,
  groupCallDisabled = false,
  groupCallTooltip = '',
  hasUnreadAnnouncements = false,
  reticulumReadEntryToken,
  isGroupOwner = false,
}) => {
  const userInfo = useAtomValue(userInfoAtom);
  const balance = useAtomValue(balanceAtom);
  const [qManagerPopupSize, setQManagerPopupSize] = useAtom(
    groupQManagerPopupSizeAtom
  );
  const myName = userInfo?.name;
  const { show } = useContext(QORTAL_APP_CONTEXT);
  const jotaiStore = useStore();
  const isChatSenderBlocked = useCallback(
    (item?: { sender?: string }) => {
      const addresses = jotaiStore.get(blockedAddressesAtom);
      const sender = item?.sender;
      return !!(sender && addresses[sender]);
    },
    [jotaiStore]
  );
  const [messages, setMessages] = useState([]);
  const [chatReferences, setChatReferences] = useState({});
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isMoved, setIsMoved] = useState(false);
  const [openSnack, setOpenSnack] = useState(false);
  const [infoSnack, setInfoSnack] = useState(null);
  const hasInitialized = useRef(false);
  const [isFocusedParent, setIsFocusedParent] = useState(false);
  const [replyMessage, setReplyMessage] = useState(null);
  const [onEditMessage, setOnEditMessage] = useState(null);
  const [groupMentionMembers, setGroupMentionMembers] = useState<
    { name: string; address: string }[]
  >([]);
  const [isOpenQManager, setIsOpenQManager] = useState(null);
  const [isDeleteImage, setIsDeleteImage] = useState(false);
  const [messageSize, setMessageSize] = useState(0);
  const [chatImagesToSave, setChatImagesToSave] = useState([]);
  const [pendingReticulumFiles, setPendingReticulumFiles] = useState<
    PendingReticulumResourceFile[]
  >([]);
  const [reticulumChannels, setReticulumChannels] = useState<
    ReticulumGroupChannel[]
  >([]);
  const [reticulumCategories, setReticulumCategories] = useState<
    ReticulumGroupCategory[]
  >([]);
  const [reticulumChannelStateGroupId, setReticulumChannelStateGroupId] =
    useState('');
  const [selectedReticulumChannelId, setSelectedReticulumChannelId] = useState(
    DEFAULT_RETICULUM_CHANNEL_ID
  );
  const [reticulumChannelSidebarOpen, setReticulumChannelSidebarOpen] =
    useState(false);
  const [reticulumSearchOpen, setReticulumSearchOpen] = useState(false);
  const [qManagerAnchorRect, setQManagerAnchorRect] =
    useState<QManagerAnchorRect | null>(null);
  const [reticulumSearchQuery, setReticulumSearchQuery] = useState('');
  const [reticulumSearchChannelFilter, setReticulumSearchChannelFilter] =
    useState(RETICULUM_SEARCH_CHANNEL_CURRENT);
  const [reticulumSearchAuthorFilter, setReticulumSearchAuthorFilter] =
    useState('');
  const [reticulumSearchHasFilter, setReticulumSearchHasFilter] = useState(
    RETICULUM_SEARCH_HAS_ANY
  );
  const [reticulumSearchAfterDate, setReticulumSearchAfterDate] = useState('');
  const [reticulumSearchBeforeDate, setReticulumSearchBeforeDate] =
    useState('');
  const [reticulumSearchSort, setReticulumSearchSort] = useState<
    'relevance' | 'newest' | 'oldest'
  >('relevance');
  const [reticulumSearchFilterMenu, setReticulumSearchFilterMenu] = useState<
    'in' | 'from' | 'has' | 'date' | 'sort' | null
  >(null);
  const [reticulumSearchFilterAnchorEl, setReticulumSearchFilterAnchorEl] =
    useState<HTMLElement | null>(null);
  const [reticulumSearchResults, setReticulumSearchResults] = useState<
    ReticulumSearchResult[]
  >([]);
  const [reticulumSearchPage, setReticulumSearchPage] = useState(0);
  const [reticulumSearchHasNextPage, setReticulumSearchHasNextPage] =
    useState(false);
  const [isReticulumSearchLoading, setIsReticulumSearchLoading] =
    useState(false);
  const [reticulumSearchError, setReticulumSearchError] = useState('');
  const [reticulumSearchScrollTarget, setReticulumSearchScrollTarget] =
    useState<{
      messageId: string;
      nonce: number;
    } | null>(null);
  const reticulumSearchRequestSeqRef = useRef(0);
  const reticulumSearchPageCursorsRef = useRef<
    Array<ReticulumSearchCursor | null>
  >([null]);
  const reticulumPrimaryNameCacheRef = useRef<Map<string, string>>(new Map());
  const [isReticulumChannelAdmin, setIsReticulumChannelAdmin] = useState(false);
  const [isCreateReticulumChannelOpen, setIsCreateReticulumChannelOpen] =
    useState(false);
  const [isCreatingReticulumChannel, setIsCreatingReticulumChannel] =
    useState(false);
  const [newReticulumChannelName, setNewReticulumChannelName] = useState('');
  const [newReticulumChannelError, setNewReticulumChannelError] = useState('');
  const [newReticulumChannelCategoryId, setNewReticulumChannelCategoryId] =
    useState('');
  const [newReticulumChannelAccessMode, setNewReticulumChannelAccessMode] =
    useState<ReticulumGroupChannelAccessMode>(
      RETICULUM_CHANNEL_ACCESS_REGULAR
    );
  const [reticulumChannelSettingsOpen, setReticulumChannelSettingsOpen] =
    useState(false);
  const [editingReticulumChannel, setEditingReticulumChannel] =
    useState<ReticulumGroupChannel | null>(null);
  const [reticulumChannelName, setReticulumChannelName] = useState('');
  const [reticulumChannelAccessMode, setReticulumChannelAccessMode] =
    useState<ReticulumGroupChannelAccessMode>(
      RETICULUM_CHANNEL_ACCESS_REGULAR
    );
  const [reticulumChannelError, setReticulumChannelError] = useState('');
  const [reticulumNameEmojiPicker, setReticulumNameEmojiPicker] = useState<{
    anchorEl: HTMLElement;
    target: 'channel-create' | 'channel-settings' | 'category';
  } | null>(null);
  const [reticulumChannelSettingsView, setReticulumChannelSettingsView] =
    useState<'settings' | 'confirm-delete'>('settings');
  const [reticulumDeleteConfirmationName, setReticulumDeleteConfirmationName] =
    useState('');
  const [reticulumDeleteConfirmationError, setReticulumDeleteConfirmationError] =
    useState('');
  const [isDeletingReticulumChannel, setIsDeletingReticulumChannel] =
    useState(false);
  const reticulumRemoveChannelButtonRef = useRef<HTMLButtonElement | null>(
    null
  );
  const reticulumDeleteConfirmationInputRef =
    useRef<HTMLInputElement | null>(null);
  const [isReticulumCategoryDialogOpen, setIsReticulumCategoryDialogOpen] =
    useState(false);
  const [reticulumCategoryDialogMode, setReticulumCategoryDialogMode] =
    useState<'create' | 'rename'>('create');
  const [editingReticulumCategory, setEditingReticulumCategory] =
    useState<ReticulumGroupCategory | null>(null);
  const [reticulumCategoryName, setReticulumCategoryName] = useState('');
  const [reticulumCategoryError, setReticulumCategoryError] = useState('');
  const [
    collapsedReticulumCategoryIds,
    setCollapsedReticulumCategoryIds,
  ] = useState<Set<string>>(() => new Set());
  const [reticulumCategoryMenuPosition, setReticulumCategoryMenuPosition] =
    useState<{ mouseX: number; mouseY: number } | null>(null);
  const [reticulumCategoryMenuCategory, setReticulumCategoryMenuCategory] =
    useState<ReticulumGroupCategory | null>(null);
  const [
    reticulumLargeImageChoice,
    setReticulumLargeImageChoice,
  ] = useState<{ file: File; filePath: string } | null>(null);
  const [isCompressingReticulumImage, setIsCompressingReticulumImage] =
    useState(false);
  const pendingReticulumFilesRef = useRef<PendingReticulumResourceFile[]>([]);
  const reticulumChannelRefreshSeqRef = useRef(0);
  const hasInitializedWebsocket = useRef(false);
  const socketRef = useRef(null); // WebSocket reference
  const timeoutIdRef = useRef(null); // Timeout ID reference
  const groupSocketTimeoutRef = useRef(null); // Group Socket Timeout reference
  const editorRef = useRef(null);
  const { queueChats, addToQueue, processWithNewMessages } = useMessageQueue();
  const {
    enabled: reticulumChatEnabled,
    events: reticulumChatEvents,
    hasOlder: reticulumHasOlderMessages,
    loadingOlder: reticulumLoadingOlderMessages,
    loadOlder: loadOlderReticulumMessages,
    publishEvent: publishReticulumChatEvent,
    sendTyping: sendReticulumTypingSignal,
    typing: reticulumTyping,
  } = useReticulumGroupChat(selectedGroup, selectedReticulumChannelId);
  const reticulumChatQueueId =
    reticulumChatEnabled && selectedGroup
      ? `${selectedGroup}:${selectedReticulumChannelId}`
      : selectedGroup;
  const reticulumChatEnabledRef = useRef(false);
  const [, forceUpdate] = useReducer((x) => x + 1, 0);
  const lastReadTimestamp = useRef(null);
  const handleUpdateRef = useRef(null);
  const iframeRef = useRef(null);
  const appliedReticulumEventIdsRef = useRef<Set<string>>(new Set());
  const processingReticulumEventIdsRef = useRef<Set<string>>(new Set());
  const appliedReticulumChannelMetadataEventIdsRef = useRef<Set<string>>(
    new Set()
  );
  const reticulumEventContextRef = useRef('');
  reticulumEventContextRef.current = `${selectedGroup || ''}:${
    selectedReticulumChannelId || DEFAULT_RETICULUM_CHANNEL_ID
  }`;
  const reticulumTypingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const reticulumTypingActiveRef = useRef(false);
  const reticulumChatSummaries = useAtomValue(reticulumChatSummariesAtom);
  const [windowSize, setWindowSize] = useState(() =>
    typeof window !== 'undefined'
      ? {
          width: window.innerWidth,
          height: window.innerHeight,
        }
      : { width: 800, height: 600 }
  );
  const [qManagerSize, setQManagerSize] = useState(() => {
    const maxWidth =
      typeof window !== 'undefined'
        ? Math.max(Q_MANAGER_MIN_WIDTH, window.innerWidth)
        : 800;
    const maxHeight =
      typeof window !== 'undefined'
        ? Math.max(Q_MANAGER_MIN_HEIGHT, window.innerHeight - appHeighOffset)
        : 600;
    return {
      width: Math.min(
        maxWidth,
        Math.max(
          Q_MANAGER_MIN_WIDTH,
          qManagerPopupSize?.width ?? Q_MANAGER_DEFAULT_WIDTH
        )
      ),
      height: Math.min(
        maxHeight,
        Math.max(
          Q_MANAGER_MIN_HEIGHT,
          qManagerPopupSize?.height ?? Q_MANAGER_DEFAULT_HEIGHT
        )
      ),
    };
  });
  const [isResizingQManager, setIsResizingQManager] = useState(false);
  const qManagerResizeInitialSizeRef = useRef(qManagerSize);

  const { t } = useTranslation([
    'auth',
    'core',
    'group',
    'question',
    'tutorial',
  ]);

  const maxQManagerWidth = Math.max(Q_MANAGER_MIN_WIDTH, windowSize.width);
  const maxQManagerHeight = Math.max(
    Q_MANAGER_MIN_HEIGHT,
    windowSize.height - appHeighOffset
  );

  const clampQManagerSize = useCallback(
    (size: { width: number; height: number }) => ({
      width: Math.min(
        maxQManagerWidth,
        Math.max(Q_MANAGER_MIN_WIDTH, size.width)
      ),
      height: Math.min(
        maxQManagerHeight,
        Math.max(Q_MANAGER_MIN_HEIGHT, size.height)
      ),
    }),
    [maxQManagerWidth, maxQManagerHeight]
  );

  const qManagerPosition = useMemo(
    () => {
      const anchorBottom = qManagerAnchorRect?.bottom ?? appHeighOffset + 50;
      const anchorCenter =
        qManagerAnchorRect !== null
          ? qManagerAnchorRect.left + qManagerAnchorRect.width / 2
          : windowSize.width - 120;
      return {
        x: Math.max(
          8,
          Math.min(
            windowSize.width - qManagerSize.width - 8,
            anchorCenter - qManagerSize.width / 2
          )
        ),
        y: Math.max(appHeighOffset + 8, Math.min(windowSize.height - qManagerSize.height - 8, anchorBottom + 8)),
      };
    },
    [
      windowSize.width,
      windowSize.height,
      qManagerSize.width,
      qManagerSize.height,
      qManagerAnchorRect,
    ]
  );

  useEffect(() => {
    reticulumChatEnabledRef.current = reticulumChatEnabled;
  }, [reticulumChatEnabled]);

  useEffect(() => {
    const onResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!qManagerPopupSize) return;
    setQManagerSize(clampQManagerSize(qManagerPopupSize));
  }, [qManagerPopupSize, clampQManagerSize]);

  useEffect(() => {
    setQManagerSize((current) => clampQManagerSize(current));
  }, [clampQManagerSize]);

  const handleQManagerResizeStart = useCallback(() => {
    qManagerResizeInitialSizeRef.current = qManagerSize;
    setIsResizingQManager(true);
  }, [qManagerSize]);

  const handleQManagerResize = useCallback(
    (
      _event,
      _direction,
      _elementRef,
      delta: { width: number; height: number }
    ) => {
      const initialSize = qManagerResizeInitialSizeRef.current;
      setQManagerSize(
        clampQManagerSize({
          width: initialSize.width + delta.width,
          height: initialSize.height + delta.height,
        })
      );
    },
    [clampQManagerSize]
  );

  const handleQManagerResizeStop = useCallback(
    (_event, _direction, elementRef: HTMLElement) => {
      const nextSize = clampQManagerSize({
        width: elementRef.offsetWidth,
        height: elementRef.offsetHeight,
      });

      setQManagerSize(nextSize);
      setQManagerPopupSize(nextSize);
      setIsResizingQManager(false);
    },
    [clampQManagerSize, setQManagerPopupSize]
  );

  const getTimestampEnterChat = async (selectedGroup) => {
    try {
      return new Promise((res, rej) => {
        window
          .sendMessage('getTimestampEnterChat')
          .then((response) => {
            if (!response?.error) {
              if (response && selectedGroup) {
                lastReadTimestamp.current =
                  response[selectedGroup] || undefined;
                window
                  .sendMessage('addTimestampEnterChat', {
                    timestamp: Date.now(),
                    groupId: selectedGroup,
                  })
                  .catch((error) => {
                    console.error(
                      'Failed to add timestamp:',
                      error.message || 'An error occurred'
                    );
                  });

                setTimeout(() => {
                  getTimestampEnterChatParent();
                }, 600);
              }

              res(response);
              return;
            }
            rej(response.error);
          })
          .catch((error) => {
            rej(
              error.message ||
                t('core:message.error.generic', {
                  postProcess: 'capitalizeFirstChar',
                })
            );
          });
      });
    } catch (error) {
      console.log(error);
    }
  };

  useEffect(() => {
    if (!selectedGroup || !isActive) return;
    getTimestampEnterChat(selectedGroup);
  }, [selectedGroup, isActive]);

  useEffect(() => {
    reticulumChannelRefreshSeqRef.current += 1;
    setReticulumChannels([]);
    setReticulumCategories([]);
    setSelectedReticulumChannelId(DEFAULT_RETICULUM_CHANNEL_ID);
    setReticulumChannelSettingsOpen(false);
    setEditingReticulumChannel(null);
  }, [reticulumChatEnabled, selectedGroup]);

  const refreshReticulumChannels = useCallback(async (): Promise<boolean> => {
    const groupId = Number(selectedGroup);
    const refreshSeq = ++reticulumChannelRefreshSeqRef.current;
    if (!Number.isInteger(groupId) || groupId <= 0) {
      setReticulumChannels([]);
      setReticulumCategories([]);
      setReticulumChannelStateGroupId('');
      setSelectedReticulumChannelId(DEFAULT_RETICULUM_CHANNEL_ID);
      return false;
    }
    const channels = await window.reticulumChat?.getChannels?.(groupId);
    const categories = await window.reticulumChat?.getCategories?.(groupId);
    const parsedChannels = Array.isArray(channels)
      ? (channels as ReticulumGroupChannel[])
      : [];
    const parsedCategories = Array.isArray(categories)
      ? (categories as ReticulumGroupCategory[])
      : [];
    if (reticulumChannelRefreshSeqRef.current !== refreshSeq) return false;
    setReticulumChannelStateGroupId(String(groupId));
    const availableChannels = parsedChannels.length
      ? parsedChannels.filter((channel) => !channel.archived)
      : [
          {
            channelId: DEFAULT_RETICULUM_CHANNEL_ID,
            groupId,
            name: DEFAULT_RETICULUM_CHANNEL_ID,
            position: 0,
            archived: false,
            writeMode: RETICULUM_CHANNEL_WRITE_MODE_MEMBERS,
            readMode: RETICULUM_CHANNEL_READ_MODE_MEMBERS,
            createdBy: '',
            createdAt: 0,
            updatedAt: 0,
          },
          {
            channelId: QORTAL_LAND_RETICULUM_CHANNEL_ID,
            groupId,
            name: QORTAL_LAND_RETICULUM_CHANNEL_ID,
            position: 1,
            archived: false,
            writeMode: RETICULUM_CHANNEL_WRITE_MODE_MEMBERS,
            readMode: RETICULUM_CHANNEL_READ_MODE_MEMBERS,
            createdBy: '',
            createdAt: 0,
            updatedAt: 0,
          },
        ];
    setReticulumCategories(parsedCategories);
    setReticulumChannels(availableChannels);
    setSelectedReticulumChannelId((current) =>
      availableChannels.some((channel) => channel.channelId === current)
        ? current
        : DEFAULT_RETICULUM_CHANNEL_ID
    );
    const knownChannelIds = new Set(
      parsedChannels.map((channel) => channel.channelId)
    );
    return (
      knownChannelIds.has(DEFAULT_RETICULUM_CHANNEL_ID) &&
      knownChannelIds.has(QORTAL_LAND_RETICULUM_CHANNEL_ID)
    );
  }, [selectedGroup]);

  useEffect(() => {
    if (!reticulumChatEnabled || !selectedGroup) return;
    const groupId = Number(selectedGroup);
    if (!Number.isInteger(groupId) || groupId <= 0) return;
    let cancelled = false;

    void (async () => {
      const retryDelays = [0, ...RETICULUM_CHANNEL_LOAD_RETRY_DELAYS_MS];
      let lastError: unknown = null;
      for (const delayMs of retryDelays) {
        if (delayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
        if (cancelled) return;

        try {
          // Subscription establishes the local group hint before membership-backed
          // channel reads. Both calls are idempotent after initial setup.
          await window.reticulumChat?.subscribeGroup?.(groupId);
          if (cancelled) return;
          if (await refreshReticulumChannels()) return;
        } catch (error) {
          lastError = error;
        }
      }
      if (!cancelled && lastError) {
        console.warn('Unable to finish loading Reticulum chat channels', lastError);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshReticulumChannels, reticulumChatEnabled, selectedGroup]);

  const reticulumChannelSummariesById = useMemo(() => {
    const groupId = Number(selectedGroup);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      return new Map<string, ReticulumChatSummaryAtomEntry>();
    }
    const summary = reticulumChatSummaries?.[String(groupId)];
    const channels = Array.isArray(summary?.channels) ? summary.channels : [];
    const entries: Array<[string, ReticulumChatSummaryAtomEntry]> = [];
    for (const channelSummary of channels) {
      const channelId =
        normalizeReticulumChannelName(channelSummary?.channelId || '') ||
        DEFAULT_RETICULUM_CHANNEL_ID;
      entries.push([channelId, channelSummary]);
    }
    return new Map(entries);
  }, [reticulumChatSummaries, selectedGroup]);

  const selectedReticulumGroupKey = selectedGroup ? String(selectedGroup) : '';
  const reticulumAllChannelsForSelectedGroup =
    reticulumChannelStateGroupId === selectedReticulumGroupKey
      ? reticulumChannels
      : [];
  const reticulumAllCategoriesForSelectedGroup =
    reticulumChannelStateGroupId === selectedReticulumGroupKey
      ? reticulumCategories
      : [];
  const reticulumChannelsForSelectedGroup = useMemo(
    () =>
      reticulumAllChannelsForSelectedGroup.filter(
        (channel) =>
          channel.channelId === DEFAULT_RETICULUM_CHANNEL_ID ||
          channel.readMode !== RETICULUM_CHANNEL_READ_MODE_ADMINS ||
          isReticulumChannelAdmin
      ),
    [isReticulumChannelAdmin, reticulumAllChannelsForSelectedGroup]
  );
  const reticulumCategoriesForSelectedGroup = useMemo(() => {
    if (isReticulumChannelAdmin) return reticulumAllCategoriesForSelectedGroup;
    const visibleCategoryIds = new Set(
      reticulumChannelsForSelectedGroup
        .map((channel) => channel.categoryId)
        .filter((categoryId): categoryId is string => Boolean(categoryId))
    );
    return reticulumAllCategoriesForSelectedGroup.filter((category) =>
      visibleCategoryIds.has(category.categoryId)
    );
  }, [
    isReticulumChannelAdmin,
    reticulumAllCategoriesForSelectedGroup,
    reticulumChannelsForSelectedGroup,
  ]);

  useEffect(() => {
    if (!reticulumChatEnabled) return;
    if (
      reticulumChannelsForSelectedGroup.some(
        (channel) => channel.channelId === selectedReticulumChannelId
      )
    ) {
      return;
    }
    setSelectedReticulumChannelId(DEFAULT_RETICULUM_CHANNEL_ID);
  }, [
    reticulumChannelsForSelectedGroup,
    reticulumChatEnabled,
    selectedReticulumChannelId,
  ]);

  const reticulumChannelsByCategory = useMemo(() => {
    const categoryIds = new Set(
      reticulumCategoriesForSelectedGroup.map((category) => category.categoryId)
    );
    const grouped = new Map<string, ReticulumGroupChannel[]>();
    for (const category of reticulumCategoriesForSelectedGroup)
      grouped.set(category.categoryId, []);
    grouped.set('', []);
    for (const channel of reticulumChannelsForSelectedGroup) {
      const categoryId =
        channel.categoryId && categoryIds.has(channel.categoryId)
          ? channel.categoryId
          : '';
      grouped.set(categoryId, [...(grouped.get(categoryId) ?? []), channel]);
    }
    for (const [categoryId, channels] of grouped.entries()) {
      grouped.set(
        categoryId,
        [...channels].sort(
          (a, b) => a.position - b.position || a.name.localeCompare(b.name)
        )
      );
    }
    return grouped;
  }, [reticulumCategoriesForSelectedGroup, reticulumChannelsForSelectedGroup]);

  const selectedReticulumChannel = useMemo(
    () =>
      reticulumChannelsForSelectedGroup.find(
        (channel) => channel.channelId === selectedReticulumChannelId
      ) || null,
    [reticulumChannelsForSelectedGroup, selectedReticulumChannelId]
  );
  const reticulumVisibleChannelIds = useMemo(
    () =>
      new Set(
        reticulumChannelsForSelectedGroup.map((channel) =>
          normalizeReticulumChannelName(channel.channelId)
        )
      ),
    [reticulumChannelsForSelectedGroup]
  );
  const reticulumVisibleChannelNameById = useMemo(() => {
    const entries = reticulumChannelsForSelectedGroup.map((channel) => [
      normalizeReticulumChannelName(channel.channelId),
      channel.name || channel.channelId,
    ]);
    return new Map(entries);
  }, [reticulumChannelsForSelectedGroup]);
  const reticulumMemberNameByAddress = useMemo(() => {
    const entries = groupMentionMembers
      .filter((member) => member.address)
      .map((member) => [member.address, member.name || member.address]);
    if (myAddress && myName) entries.push([myAddress, myName]);
    return new Map(entries);
  }, [groupMentionMembers, myAddress, myName]);
  const reticulumSearchAuthorOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of groupMentionMembers) {
      if (member.address) map.set(member.address, member.name || member.address);
    }
    for (const message of messages) {
      if (message?.sender) {
        map.set(
          message.sender,
          message.senderName || reticulumMemberNameByAddress.get(message.sender) || message.sender
        );
      }
    }
    if (myAddress) map.set(myAddress, myName || myAddress);
    return [...map.entries()]
      .map(([address, name]) => ({ address, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [groupMentionMembers, messages, myAddress, myName, reticulumMemberNameByAddress]);
  const reticulumSearchActiveFilterCount = useMemo(() => {
    return [
      reticulumSearchChannelFilter !== RETICULUM_SEARCH_CHANNEL_CURRENT,
      Boolean(reticulumSearchAuthorFilter),
      reticulumSearchHasFilter !== RETICULUM_SEARCH_HAS_ANY,
      Boolean(reticulumSearchAfterDate),
      Boolean(reticulumSearchBeforeDate),
      reticulumSearchSort !== 'relevance',
    ].filter(Boolean).length;
  }, [
    reticulumSearchAfterDate,
    reticulumSearchAuthorFilter,
    reticulumSearchBeforeDate,
    reticulumSearchChannelFilter,
    reticulumSearchHasFilter,
    reticulumSearchSort,
  ]);
  const reticulumSearchChannelFilterLabel = useMemo(() => {
    if (reticulumSearchChannelFilter === RETICULUM_SEARCH_CHANNEL_CURRENT) {
      const selectedChannelName =
        reticulumVisibleChannelNameById.get(selectedReticulumChannelId) ||
        selectedReticulumChannelId;
      return `#${selectedChannelName}`;
    }
    if (reticulumSearchChannelFilter === RETICULUM_SEARCH_CHANNEL_ALL) {
      return 'All channels';
    }
    return `#${
      reticulumVisibleChannelNameById.get(reticulumSearchChannelFilter) ||
      reticulumSearchChannelFilter
    }`;
  }, [
    reticulumSearchChannelFilter,
    reticulumVisibleChannelNameById,
    selectedReticulumChannelId,
  ]);
  const reticulumSearchAuthorFilterLabel = useMemo(() => {
    if (!reticulumSearchAuthorFilter) return 'Anyone';
    return (
      reticulumSearchAuthorOptions.find(
        (author) => author.address === reticulumSearchAuthorFilter
      )?.name || reticulumSearchAuthorFilter
    );
  }, [reticulumSearchAuthorFilter, reticulumSearchAuthorOptions]);
  const reticulumSearchHasFilterLabel =
    reticulumSearchHasFilter === RETICULUM_SEARCH_HAS_ATTACHMENT
      ? 'Attachment'
      : reticulumSearchHasFilter === RETICULUM_SEARCH_HAS_LINK
        ? 'Link'
        : 'Anything';
  const reticulumSearchSortLabel =
    reticulumSearchSort === 'newest'
      ? 'Newest'
      : reticulumSearchSort === 'oldest'
        ? 'Oldest'
        : 'Relevant';
  const reticulumSearchDateFilterLabel =
    reticulumSearchAfterDate || reticulumSearchBeforeDate
      ? `${reticulumSearchAfterDate || 'any'} -> ${
          reticulumSearchBeforeDate || 'any'
        }`
      : 'Any time';
  const reticulumSearchVisiblePageNumbers = useMemo(() => {
    const pages = new Set<number>([0, reticulumSearchPage]);
    if (reticulumSearchPage > 0) pages.add(reticulumSearchPage - 1);
    if (reticulumSearchHasNextPage) pages.add(reticulumSearchPage + 1);
    return [...pages].sort((a, b) => a - b);
  }, [reticulumSearchHasNextPage, reticulumSearchPage]);
  const clearReticulumSearchFilters = useCallback(() => {
    setReticulumSearchChannelFilter(RETICULUM_SEARCH_CHANNEL_CURRENT);
    setReticulumSearchAuthorFilter('');
    setReticulumSearchHasFilter(RETICULUM_SEARCH_HAS_ANY);
    setReticulumSearchAfterDate('');
    setReticulumSearchBeforeDate('');
    setReticulumSearchSort('relevance');
  }, []);
  const openReticulumSearchFilterMenu = useCallback(
    (
      menu: 'in' | 'from' | 'has' | 'date' | 'sort',
      event: ReactMouseEvent<HTMLElement>
    ) => {
      setReticulumSearchFilterMenu(menu);
      setReticulumSearchFilterAnchorEl(event.currentTarget);
    },
    []
  );
  const closeReticulumSearchFilterMenu = useCallback(() => {
    setReticulumSearchFilterMenu(null);
    setReticulumSearchFilterAnchorEl(null);
  }, []);
  const selectedReticulumChannelWriteMode =
    selectedReticulumChannel?.writeMode === RETICULUM_CHANNEL_WRITE_MODE_ADMINS
      ? RETICULUM_CHANNEL_WRITE_MODE_ADMINS
      : RETICULUM_CHANNEL_WRITE_MODE_MEMBERS;
  const canWriteSelectedReticulumChannel =
    !reticulumChatEnabled ||
    selectedReticulumChannelWriteMode !== RETICULUM_CHANNEL_WRITE_MODE_ADMINS ||
    isReticulumChannelAdmin;

  useEffect(() => {
    const groupId = Number(selectedGroup);
    if (!reticulumChatEnabled || !Number.isInteger(groupId) || groupId <= 0) {
      setIsReticulumChannelAdmin(false);
      return;
    }
    let cancelled = false;
    void getGroupAdminsAddress(groupId)
      .then((admins) => {
        if (!cancelled) setIsReticulumChannelAdmin(admins.includes(myAddress));
      })
      .catch(() => {
        if (!cancelled) setIsReticulumChannelAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [myAddress, reticulumChatEnabled, selectedGroup]);

  useEffect(() => {
    const groupId = Number(selectedGroup);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      setGroupMentionMembers([]);
      return;
    }
    let cancelled = false;
    void getGroupMembers(groupId)
      .then((data) => {
        if (cancelled) return;
        const membersWithNames = Array.isArray(data?.members)
          ? data.members
              .map((member: any) => ({
                address:
                  typeof member?.member === 'string'
                    ? member.member.trim()
                    : '',
                name:
                  typeof member?.primaryName === 'string'
                    ? member.primaryName.trim()
                    : '',
              }))
              .filter((member) => member.address && member.name)
          : [];
        setGroupMentionMembers(membersWithNames);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('Failed to load group members for mentions:', error);
          setGroupMentionMembers([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedGroup]);

  const mentionNameToAddress = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of groupMentionMembers) {
      if (member.name && member.address) {
        map.set(member.name.toLowerCase(), member.address);
      }
    }
    if (myName && myAddress) map.set(myName.toLowerCase(), myAddress);
    for (const message of messages) {
      if (message?.senderName && message?.sender) {
        map.set(String(message.senderName).toLowerCase(), message.sender);
      }
    }
    return map;
  }, [groupMentionMembers, messages, myAddress, myName]);

  const resolveMentionedAddresses = useCallback(
    (html: string): string[] => {
      const rawText = mentionTextFromHtml(html);
      const text = rawText.toLowerCase();
      if (!rawText) return [];
      const mentioned = new Set<string>();
      for (const [name, address] of mentionNameToAddress.entries()) {
        if (!name || !address) continue;
        if (text.includes(`@${name}`)) mentioned.add(address);
      }
      const addressMatches =
        rawText.match(/@Q[1-9A-HJ-NP-Za-km-z]{20,}/g) || [];
      for (const match of addressMatches) {
        mentioned.add(match.slice(1));
      }
      return [...mentioned];
    },
    [mentionNameToAddress]
  );

  const members = useMemo(() => {
    const uniqueMembers = new Set();
    uniqueMembers.add('here');
    uniqueMembers.add('everyone');
    if (selectedGroupName) uniqueMembers.add(selectedGroupName);
    reticulumChannelsForSelectedGroup.forEach((channel) => {
      if (channel?.name) uniqueMembers.add(channel.name);
    });
    groupMentionMembers.forEach((member) => {
      if (member.name) uniqueMembers.add(member.name);
    });
    messages.forEach((message) => {
      if (message?.senderName) {
        uniqueMembers.add(message?.senderName);
      }
    });

    return Array.from(uniqueMembers);
  }, [groupMentionMembers, messages, reticulumChannelsForSelectedGroup, selectedGroupName]);

  const reticulumTypingText = useMemo(() => {
    if (isDisabledTyping || !reticulumChatEnabled) return '';
    const nameByAddress = new Map<string, string>();
    for (const member of groupMentionMembers) {
      if (member.address && member.name) nameByAddress.set(member.address, member.name);
    }
    const addresses = Object.entries(reticulumTyping || {})
      .filter(([address, active]) => active === true && address && address !== myAddress)
      .map(([address]) => address)
      .slice(0, 4);
    if (addresses.length === 0) return '';
    const names = addresses.map((address) => {
      const name = nameByAddress.get(address)?.trim();
      return name || `${address.slice(0, 8)}...`;
    });
    if (names.length === 1) return `${names[0]} is typing...`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
    return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more are typing...`;
  }, [groupMentionMembers, myAddress, reticulumChatEnabled, reticulumTyping]);

  const resolveMentionTargets = useCallback(
    (html: string) => {
      const rawText = mentionTextFromHtml(html);
      const groupId = Number(selectedGroup);
      const channelId =
        normalizeReticulumChannelName(selectedReticulumChannelId) ||
        DEFAULT_RETICULUM_CHANNEL_ID;
      if (!rawText || !Number.isInteger(groupId) || groupId <= 0) return [];

      const targets = [];
      const seen = new Set<string>();
      const addTarget = (target) => {
        const key = JSON.stringify(target);
        if (seen.has(key)) return;
        seen.add(key);
        targets.push(target);
      };

      if (textHasMentionToken(rawText, 'here')) {
        addTarget({
          type: 'here',
          groupId,
          channelId,
          createdAt: Date.now(),
        });
      }
      if (textHasMentionToken(rawText, 'everyone')) {
        addTarget({ type: 'everyone', groupId });
      }
      const groupName = normalizeMentionTargetLabel(selectedGroupName);
      if (groupName && textHasMentionToken(rawText, groupName)) {
        addTarget({
          type: 'group',
          groupId,
          groupName,
        });
      }
      for (const channel of reticulumChannelsForSelectedGroup) {
        const targetChannelId =
          normalizeReticulumChannelName(channel?.channelId) ||
          DEFAULT_RETICULUM_CHANNEL_ID;
        const channelName = normalizeMentionTargetLabel(channel?.name);
        const channelIdLabel = normalizeMentionTargetLabel(channel?.channelId);
        if (
          (channelName && textHasMentionToken(rawText, channelName)) ||
          (channelIdLabel && textHasMentionToken(rawText, channelIdLabel))
        ) {
          addTarget({
            type: 'channel',
            groupId,
            channelId: targetChannelId,
            ...(channelName ? { channelName } : {}),
          });
        }
      }

      return targets;
    },
    [
      reticulumChannelsForSelectedGroup,
      selectedGroup,
      selectedGroupName,
      selectedReticulumChannelId,
    ]
  );

  const setEditorRef = (editorInstance) => {
    editorRef.current = editorInstance;
  };

  const stopReticulumTyping = useCallback(() => {
    if (reticulumTypingStopTimerRef.current) {
      clearTimeout(reticulumTypingStopTimerRef.current);
      reticulumTypingStopTimerRef.current = null;
    }
    if (
      isDisabledTyping ||
      !reticulumChatEnabled ||
      !reticulumTypingActiveRef.current ||
      !myAddress
    ) {
      reticulumTypingActiveRef.current = false;
      return;
    }
    reticulumTypingActiveRef.current = false;
    void sendReticulumTypingSignal(myAddress, false);
  }, [myAddress, reticulumChatEnabled, sendReticulumTypingSignal]);

  const noteReticulumComposerActivity = useCallback(
    (hasText: boolean) => {
      if (isDisabledTyping || !reticulumChatEnabled || !myAddress) return;
      if (!hasText) {
        stopReticulumTyping();
        return;
      }
      reticulumTypingActiveRef.current = true;
      void sendReticulumTypingSignal(myAddress, true);
      if (reticulumTypingStopTimerRef.current) {
        clearTimeout(reticulumTypingStopTimerRef.current);
      }
      reticulumTypingStopTimerRef.current = setTimeout(() => {
        stopReticulumTyping();
      }, RETICULUM_TYPING_IDLE_STOP_MS);
    },
    [myAddress, reticulumChatEnabled, sendReticulumTypingSignal, stopReticulumTyping]
  );

  useEffect(() => () => stopReticulumTyping(), [stopReticulumTyping]);

  const tempMessages = useMemo(() => {
    if (!reticulumChatQueueId) return [];
    if (queueChats[reticulumChatQueueId]) {
      return queueChats[reticulumChatQueueId]?.filter(
        (item) => !item?.chatReference
      );
    }
    return [];
  }, [queueChats, reticulumChatQueueId]);

  const tempChatReferences = useMemo(() => {
    if (!reticulumChatQueueId) return [];
    if (queueChats[reticulumChatQueueId]) {
      return queueChats[reticulumChatQueueId]?.filter(
        (item) => !!item?.chatReference
      );
    }
    return [];
  }, [queueChats, reticulumChatQueueId]);

  const secretKeyRef = useRef(null);
  const reticulumReadWasActiveRef = useRef(false);
  const lastReticulumReadEntryTokenRef = useRef<number | null>(null);
  const lastReticulumMarkedReadRef = useRef<{
    key: string;
    timestamp: number;
  } | null>(null);

  useEffect(() => {
    if (secretKey) {
      secretKeyRef.current = secretKey;
    }
  }, [secretKey]);

  useEffect(() => {
    appliedReticulumEventIdsRef.current.clear();
    processingReticulumEventIdsRef.current.clear();
    appliedReticulumChannelMetadataEventIdsRef.current.clear();
  }, [selectedGroup]);

  useEffect(() => {
    if (!reticulumChatEnabled) return;
    setMessages([]);
    setChatReferences({});
    appliedReticulumEventIdsRef.current.clear();
    processingReticulumEventIdsRef.current.clear();
  }, [reticulumChatEnabled, selectedGroup, selectedReticulumChannelId]);

  useEffect(() => {
    if (!reticulumChatEnabled || !notificationReticulumChannelId) return;
    if (
      reticulumChannelsForSelectedGroup.some(
        (channel) => channel.channelId === notificationReticulumChannelId
      )
    ) {
      setSelectedReticulumChannelId(notificationReticulumChannelId);
    }
  }, [
    notificationReticulumChannelId,
    reticulumChannelsForSelectedGroup,
    reticulumChatEnabled,
  ]);

  useEffect(() => {
    if (!reticulumChatEnabled) return;
    onReticulumChannelSelected?.(selectedReticulumChannelId);
  }, [
    onReticulumChannelSelected,
    reticulumChatEnabled,
    selectedReticulumChannelId,
  ]);

  const checkForFirstSecretKeyNotification = (messages) => {
    messages?.forEach((message) => {
      try {
        const decodeMsg = atob(message.data);
        if (decodeMsg === PUBLIC_NOTIFICATION_CODE_FIRST_SECRET_KEY) {
          handleSecretKeyCreationInProgress();
          return;
        }
      } catch (error) {
        console.log(error);
      }
    });
  };

  const updateChatMessagesWithBlocksFunc = useCallback(
    (e) => {
      if (e.detail) {
        setMessages((prev) =>
          prev?.filter((item) => !isChatSenderBlocked(item))
        );
      }
    },
    [isChatSenderBlocked]
  );

  useEffect(() => {
    subscribeToEvent(
      'updateChatMessagesWithBlocks',
      updateChatMessagesWithBlocksFunc
    );

    return () => {
      unsubscribeFromEvent(
        'updateChatMessagesWithBlocks',
        updateChatMessagesWithBlocksFunc
      );
    };
  }, [updateChatMessagesWithBlocksFunc]);

  const middletierFunc = async (data: any, groupId: string) => {
    try {
      if (hasInitialized.current) {
        const dataRemovedBlock = data?.filter(
          (item) => !isChatSenderBlocked(item)
        );

        decryptMessages(dataRemovedBlock, true);
        return;
      }
      hasInitialized.current = true;
      const url = `${getBaseApiReact()}/chat/messages?txGroupId=${groupId}&encoding=BASE64&limit=0&reverse=false`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      const responseData = await response.json();
      const dataRemovedBlock = responseData?.filter((item) => {
        return !isChatSenderBlocked(item);
      });
      decryptMessages(dataRemovedBlock, false);
    } catch (error) {
      console.error(error);
    }
  };

  const decryptMessages = (encryptedMessages: any[], isInitiated: boolean) => {
    try {
      if (!secretKeyRef.current) {
        checkForFirstSecretKeyNotification(encryptedMessages);
      }
      return new Promise((res, rej) => {
        window
          .sendMessage('decryptSingle', {
            data: encryptedMessages,
            secretKeyObject: secretKeyRef.current,
          })
          .then((response) => {
            if (!response?.error) {
              const filterUIMessages = encryptedMessages.filter(
                (item) => !isExtMsg(item.data)
              );

              const decodedUIMessages =
                decodeBase64ForUIChatMessages(filterUIMessages);

              const combineUIAndExtensionMsgsBefore = [
                ...decodedUIMessages,
                ...response,
              ];

              const combineUIAndExtensionMsgs = processWithNewMessages(
                combineUIAndExtensionMsgsBefore.map((item) => ({
                  ...item,
                  ...(item?.decryptedData || {}),
                })),
                selectedGroup
              );

              res(combineUIAndExtensionMsgs);

              if (reticulumChatEnabledRef.current) return;

              if (isInitiated) {
                const formatted = combineUIAndExtensionMsgs
                  .filter((rawItem) => !rawItem?.chatReference)
                  .map((item) => {
                    const additionalFields =
                      item?.data === 'NDAwMQ=='
                        ? {
                            text: `<p>${t(
                              'group:message.generic.group_key_created',
                              {
                                postProcess: 'capitalizeFirstChar',
                              }
                            )}</p>`,
                          }
                        : {};
                    return {
                      ...item,
                      id: item.signature,
                      text: item?.decryptedData?.message || '',
                      repliedTo:
                        item?.repliedTo || item?.decryptedData?.repliedTo,
                      unread:
                        item?.sender === myAddress
                          ? false
                          : item?.chatReference
                            ? false
                            : true,
                      isNotEncrypted: !!item?.messageText,
                      ...additionalFields,
                    };
                  });
                setMessages((prev) => [...prev, ...formatted]);
                setChatReferences((prev) => {
                  const organizedChatReferences = { ...prev };
                  combineUIAndExtensionMsgs
                    .filter(
                      (rawItem) =>
                        rawItem &&
                        rawItem.chatReference &&
                        (rawItem?.decryptedData?.type === 'reaction' ||
                          rawItem?.decryptedData?.type === 'edit' ||
                          rawItem?.type === 'edit' ||
                          rawItem?.isEdited ||
                          rawItem?.type === 'reaction')
                    )
                    .forEach((item) => {
                      try {
                        if (item?.decryptedData?.type === 'edit') {
                          organizedChatReferences[item.chatReference] = {
                            ...(organizedChatReferences[item.chatReference] ||
                              {}),
                            edit: item.decryptedData,
                          };
                        } else if (item?.type === 'edit' || item?.isEdited) {
                          organizedChatReferences[item.chatReference] = {
                            ...(organizedChatReferences[item.chatReference] ||
                              {}),
                            edit: item,
                          };
                        } else {
                          const content =
                            item?.content || item.decryptedData?.content;
                          const sender = item.sender;
                          const newTimestamp = item.timestamp;
                          const contentState =
                            item?.contentState !== undefined
                              ? item?.contentState
                              : item.decryptedData?.contentState;

                          if (
                            !content ||
                            typeof content !== 'string' ||
                            !sender ||
                            typeof sender !== 'string' ||
                            !newTimestamp
                          ) {
                            console.warn(
                              t('group:message.generic.invalid_content', {
                                postProcess: 'capitalizeFirstChar',
                              }),
                              item
                            );
                            return;
                          }

                          organizedChatReferences[item.chatReference] = {
                            ...(organizedChatReferences[item.chatReference] ||
                              {}),
                            reactions:
                              organizedChatReferences[item.chatReference]
                                ?.reactions || {},
                          };

                          organizedChatReferences[item.chatReference].reactions[
                            content
                          ] =
                            organizedChatReferences[item.chatReference]
                              .reactions[content] || [];

                          let latestTimestampForSender = null;

                          organizedChatReferences[item.chatReference].reactions[
                            content
                          ] = organizedChatReferences[
                            item.chatReference
                          ].reactions[content].filter((reaction) => {
                            if (reaction.sender === sender) {
                              latestTimestampForSender = Math.max(
                                latestTimestampForSender || 0,
                                reaction.timestamp
                              );
                            }
                            return reaction.sender !== sender;
                          });

                          if (
                            latestTimestampForSender &&
                            newTimestamp < latestTimestampForSender
                          ) {
                            return;
                          }

                          if (contentState !== false) {
                            organizedChatReferences[
                              item.chatReference
                            ].reactions[content].push(item);
                          }

                          if (
                            organizedChatReferences[item.chatReference]
                              .reactions[content].length === 0
                          ) {
                            delete organizedChatReferences[item.chatReference]
                              .reactions[content];
                          }
                        }
                      } catch (error) {
                        console.error(
                          'Error processing reaction/edit item:',
                          error,
                          item
                        );
                      }
                    });

                  return organizedChatReferences;
                });
              } else {
                let firstUnreadFound = false;
                const formatted = combineUIAndExtensionMsgs
                  .filter((rawItem) => !rawItem?.chatReference)
                  .map((item) => {
                    const additionalFields =
                      item?.data === 'NDAwMQ=='
                        ? {
                            text: `<p>${t(
                              'group:message.generic.group_key_created',
                              {
                                postProcess: 'capitalizeFirstChar',
                              }
                            )}</p>`,
                          }
                        : {};
                    const divide =
                      lastReadTimestamp.current &&
                      !firstUnreadFound &&
                      item.timestamp > lastReadTimestamp.current &&
                      myAddress !== item?.sender;

                    if (divide) {
                      firstUnreadFound = true;
                    }
                    return {
                      ...item,
                      id: item.signature,
                      text: item?.decryptedData?.message || '',
                      repliedTo:
                        item?.repliedTo || item?.decryptedData?.repliedTo,
                      isNotEncrypted: !!item?.messageText,
                      unread: false,
                      divide,
                      ...additionalFields,
                    };
                  });
                setMessages(formatted);

                setChatReferences((prev) => {
                  const organizedChatReferences = { ...prev };

                  combineUIAndExtensionMsgs
                    .filter(
                      (rawItem) =>
                        rawItem &&
                        rawItem.chatReference &&
                        (rawItem?.decryptedData?.type === 'reaction' ||
                          rawItem?.decryptedData?.type === 'edit' ||
                          rawItem?.type === 'edit' ||
                          rawItem?.isEdited ||
                          rawItem?.type === 'reaction')
                    )
                    .forEach((item) => {
                      try {
                        if (item?.decryptedData?.type === 'edit') {
                          organizedChatReferences[item.chatReference] = {
                            ...(organizedChatReferences[item.chatReference] ||
                              {}),
                            edit: item.decryptedData,
                          };
                        } else if (item?.type === 'edit' || item?.isEdited) {
                          organizedChatReferences[item.chatReference] = {
                            ...(organizedChatReferences[item.chatReference] ||
                              {}),
                            edit: item,
                          };
                        } else {
                          const content =
                            item?.content || item.decryptedData?.content;
                          const sender = item.sender;
                          const newTimestamp = item.timestamp;
                          const contentState =
                            item?.contentState !== undefined
                              ? item?.contentState
                              : item.decryptedData?.contentState;

                          if (
                            !content ||
                            typeof content !== 'string' ||
                            !sender ||
                            typeof sender !== 'string' ||
                            !newTimestamp
                          ) {
                            console.warn(
                              t('group:message.generic.invalid_content', {
                                postProcess: 'capitalizeFirstChar',
                              }),
                              item
                            );
                            return;
                          }

                          organizedChatReferences[item.chatReference] = {
                            ...(organizedChatReferences[item.chatReference] ||
                              {}),
                            reactions:
                              organizedChatReferences[item.chatReference]
                                ?.reactions || {},
                          };

                          organizedChatReferences[item.chatReference].reactions[
                            content
                          ] =
                            organizedChatReferences[item.chatReference]
                              .reactions[content] || [];

                          let latestTimestampForSender = null;

                          organizedChatReferences[item.chatReference].reactions[
                            content
                          ] = organizedChatReferences[
                            item.chatReference
                          ].reactions[content].filter((reaction) => {
                            if (reaction.sender === sender) {
                              latestTimestampForSender = Math.max(
                                latestTimestampForSender || 0,
                                reaction.timestamp
                              );
                            }
                            return reaction.sender !== sender;
                          });

                          if (
                            latestTimestampForSender &&
                            newTimestamp < latestTimestampForSender
                          ) {
                            return;
                          }

                          if (contentState !== false) {
                            organizedChatReferences[
                              item.chatReference
                            ].reactions[content].push(item);
                          }

                          if (
                            organizedChatReferences[item.chatReference]
                              .reactions[content].length === 0
                          ) {
                            delete organizedChatReferences[item.chatReference]
                              .reactions[content];
                          }
                        }
                      } catch (error) {
                        console.error(
                          'Error processing reaction item:',
                          error,
                          item
                        );
                      }
                    });

                  return organizedChatReferences;
                });
              }
            }
            rej(response.error);
          })
          .catch((error) => {
            rej(
              error.message ||
                t('core:message.error.generic', {
                  postProcess: 'capitalizeFirstChar',
                })
            );
          });
      });
    } catch (error) {
      console.log(error);
    }
  };

  const forceCloseWebSocket = () => {
    if (socketRef.current) {
      clearTimeout(timeoutIdRef.current);
      clearTimeout(groupSocketTimeoutRef.current);
      socketRef.current.close(1000, 'forced');
      socketRef.current = null;
    }
  };

  const pingGroupSocket = () => {
    try {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send('ping');
        timeoutIdRef.current = setTimeout(() => {
          if (socketRef.current) {
            socketRef.current.close();
            clearTimeout(groupSocketTimeoutRef.current);
          }
        }, 5000); // Close if no pong in 5 seconds
      }
    } catch (error) {
      console.error('Error during ping:', error);
    }
  };

  const initWebsocketMessageGroup = () => {
    if (reticulumChatEnabled) return;
    const socketLink = `${getBaseApiReactSocket()}/websockets/chat/messages?txGroupId=${selectedGroup}&encoding=BASE64&limit=100`;
    socketRef.current = new WebSocket(socketLink);

    socketRef.current.onopen = () => {
      setTimeout(pingGroupSocket, 50);
    };
    socketRef.current.onmessage = (e) => {
      try {
        if (e.data === 'pong') {
          clearTimeout(timeoutIdRef.current);
          groupSocketTimeoutRef.current = setTimeout(pingGroupSocket, 20000); // Ping every 20 seconds
        } else {
          middletierFunc(JSON.parse(e.data), selectedGroup);
          setIsLoading(false);
        }
      } catch (error) {
        console.log(error);
      }
    };
    socketRef.current.onclose = () => {
      clearTimeout(groupSocketTimeoutRef.current);
      clearTimeout(timeoutIdRef.current);
      console.warn(`WebSocket closed: ${event.reason || 'unknown reason'}`);
      if (event.reason !== 'forced' && event.code !== 1000) {
        setTimeout(() => initWebsocketMessageGroup(), 1000); // Retry after 10 seconds
      }
    };
    socketRef.current.onerror = (e) => {
      clearTimeout(groupSocketTimeoutRef.current);
      clearTimeout(timeoutIdRef.current);
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  };

  useEffect(() => {
    if (reticulumChatEnabled) {
      forceCloseWebSocket();
      setIsLoading(false);
      return;
    }
    if (hasInitializedWebsocket.current) return;
    if (triedToFetchSecretKey && !secretKey) {
      forceCloseWebSocket();
      setMessages([]);
      setIsLoading(true);
      initWebsocketMessageGroup();
    }
  }, [triedToFetchSecretKey, secretKey, isPrivate, reticulumChatEnabled]);

  useEffect(() => {
    if (reticulumChatEnabled) {
      forceCloseWebSocket();
      setIsLoading(false);
      return;
    }
    if (isPrivate === null) return;
    if (isPrivate === false || !secretKey || hasInitializedWebsocket.current)
      return;
    forceCloseWebSocket();
    setMessages([]);
    setIsLoading(true);
    pauseAllQueues();
    setTimeout(() => {
      resumeAllQueues();
    }, 6000);
    initWebsocketMessageGroup();
    hasInitializedWebsocket.current = true;
  }, [secretKey, isPrivate, reticulumChatEnabled]);

  useEffect(() => {
    const logoutEventFunc = () => {
      forceCloseWebSocket();
    };
    subscribeToEvent('logout-event', logoutEventFunc);
    return () => {
      unsubscribeFromEvent('logout-event', logoutEventFunc);
      forceCloseWebSocket();
    };
  }, []);

  useEffect(() => {
    const notifications = messages.filter(
      (message) => message?.decryptedData?.type === 'notification'
    );
    if (notifications.length === 0) return;
    const latestNotification = notifications.reduce((latest, current) => {
      return current.timestamp > latest.timestamp ? current : latest;
    }, notifications[0]);
    handleNewEncryptionNotification(latestNotification);
  }, [messages]);

  const encryptChatMessage = async (
    data: string,
    secretKeyObject: any,
    reactiontypeNumber?: number
  ) => {
    try {
      return new Promise((res, rej) => {
        window
          .sendMessage('encryptSingle', {
            data,
            secretKeyObject,
            typeNumber: reactiontypeNumber,
          })
          .then((response) => {
            if (!response?.error) {
              res(response);
              return;
            }
            rej(response.error);
          })
          .catch((error) => {
            rej(
              error.message ||
                t('core:message.error.generic', {
                  postProcess: 'capitalizeFirstChar',
                })
            );
          });
      });
    } catch (error) {
      console.log(error);
    }
  };

  const publishReticulumGroupChatEvent = useCallback(
    async ({
      encryptedPayload,
      eventType,
      channelId,
      targetEventId,
      replyToEventId,
      mentionAddressHashes = [],
      mentionTargets = [],
    }: {
      encryptedPayload: string;
      eventType:
        | 'message'
        | 'edit'
        | 'delete'
        | 'reaction_add'
        | 'reaction_remove'
        | 'attachment_manifest'
        | 'channel_create'
        | 'channel_update'
        | 'channel_archive'
        | 'channel_restore'
        | 'channel_reorder'
        | 'category_create'
        | 'category_update'
        | 'category_delete';
      channelId?: string;
      targetEventId?: string;
      replyToEventId?: string;
      mentionAddressHashes?: string[];
      mentionTargets?: Array<Record<string, unknown>>;
    }) => {
      const groupId = Number(selectedGroup);
      if (!reticulumChatEnabled || !Number.isInteger(groupId) || groupId <= 0) {
        return { success: false, error: 'Reticulum chat is disabled' };
      }
      const timestamp = Date.now();
      const eventId = crypto.randomUUID?.() || `${timestamp}-${uid.rnd()}`;
      const payloadHash = await sha256Hex(encryptedPayload);
      const eventChannelId =
        normalizeReticulumChannelName(
          channelId || selectedReticulumChannelId
        ) || DEFAULT_RETICULUM_CHANNEL_ID;
      const normalizedMentionTargets = Array.isArray(mentionTargets)
        ? mentionTargets.map((target) =>
            target?.type === 'here'
              ? { ...target, createdAt: timestamp }
              : target
          )
        : [];
      const authorSequence = await window.reticulumChat?.reserveAuthorSequence?.(
        groupId,
        myAddress
      );
      if (
        !authorSequence ||
        !/^[0-9a-f]{32}$/.test(authorSequence.authorStreamId) ||
        !Number.isInteger(authorSequence.authorSeq) ||
        authorSequence.authorSeq <= 0
      ) {
        throw new Error('Unable to reserve Reticulum chat event sequence');
      }
      let sequenceCommitted = false;
      try {
        const baseFields = {
          eventId,
          groupId,
          channelId: eventChannelId,
          authorStreamId: authorSequence.authorStreamId,
          authorSeq: authorSequence.authorSeq,
          timestamp,
          eventType,
          targetEventId: targetEventId ?? null,
          replyToEventId: replyToEventId ?? null,
          encryptedPayload,
          payloadHash,
          mentionAddressHashes,
          ...(normalizedMentionTargets.length > 0
            ? { mentionTargets: normalizedMentionTargets }
            : {}),
        };
        const signed = await window.sendMessage(
          'signReticulumChatEvent',
          baseFields
        );
        if (!signed || signed.error) {
          throw new Error(signed?.error || 'Unable to sign Reticulum chat event');
        }
        if (signed.authorAddress !== myAddress) {
          throw new Error('Signed Reticulum chat author mismatch');
        }
        const event = {
          ...baseFields,
          authorAddress: signed.authorAddress,
          authorPublicKey: signed.authorPublicKey,
          signature: signed.signature,
        };
        const result = await publishReticulumChatEvent(event);
        if (!result?.success) {
          throw new Error(result?.error || 'Reticulum chat publish failed');
        }
        sequenceCommitted = true;
        return { ...result, event };
      } finally {
        if (!sequenceCommitted) {
          try {
            await window.reticulumChat?.releaseAuthorSequence?.(
              groupId,
              myAddress,
              authorSequence.authorStreamId,
              authorSequence.authorSeq
            );
          } catch (releaseError) {
            console.warn(
              'Unable to release Reticulum chat event sequence',
              releaseError
            );
          }
        }
      }
    },
    [
      myAddress,
      publishReticulumChatEvent,
      reticulumChatEnabled,
      selectedGroup,
      selectedReticulumChannelId,
    ]
  );

  const sendChatGroup = async ({
    groupId,
    typeMessage = undefined,
    chatReference = undefined,
    messageText,
  }: any) => {
    try {
      return new Promise((res, rej) => {
        window
          .sendMessage(
            'sendChatGroup',
            {
              groupId,
              typeMessage,
              chatReference,
              messageText,
            },
            TIME_MINUTES_2_IN_MILLISECONDS
          )
          .then((response) => {
            if (!response?.error) {
              res(response);
              return;
            }
            rej(response.error);
          })
          .catch((error) => {
            rej(
              error.message ||
                t('core:message.error.generic', {
                  postProcess: 'capitalizeFirstChar',
                })
            );
          });
      });
    } catch (error) {
      throw new Error(error);
    }
  };

  const applyReticulumChatItem = useCallback(
    (item) => {
      if (!item || isChatSenderBlocked(item)) return;
      const processed = processWithNewMessages([item], reticulumChatQueueId);
      const nextItem = processed?.[0] || item;
      const targetReference = nextItem.chatReference;
      const itemType =
        nextItem?.eventType || nextItem?.decryptedData?.type || nextItem?.type;
      const isReactionItem =
        itemType === 'reaction' ||
        itemType === 'reaction_add' ||
        itemType === 'reaction_remove';

      if (targetReference && itemType === 'delete') {
        setMessages((prev) =>
          prev.some(
            (message) =>
              message?.signature === targetReference ||
              message?.tempSignature === targetReference
          )
            ? prev.filter(
                (message) =>
                  message?.signature !== targetReference &&
                  message?.tempSignature !== targetReference
              )
            : prev
        );
        setChatReferences((prev) => {
          return {
            ...prev,
            [targetReference]: {
              deleted: true,
            },
          };
        });
        return;
      }

      if (
        targetReference &&
        (itemType === 'edit' || nextItem?.isEdited || isReactionItem)
      ) {
        setChatReferences((prev) => {
          const organized = { ...prev };
          if (itemType === 'edit' || nextItem?.isEdited) {
            organized[targetReference] = {
              ...(organized[targetReference] || {}),
              edit: nextItem.decryptedData || nextItem,
            };
            return organized;
          }

          const content = nextItem?.content || nextItem?.decryptedData?.content;
          const sender = nextItem.sender;
          const contentState =
            nextItem?.contentState !== undefined
              ? nextItem.contentState
              : nextItem?.decryptedData?.contentState;
          if (!content || !sender) return organized;
          organized[targetReference] = {
            ...(organized[targetReference] || {}),
            reactions: organized[targetReference]?.reactions || {},
          };
          organized[targetReference].reactions[content] =
            organized[targetReference].reactions[content] || [];
          organized[targetReference].reactions[content] = organized[
            targetReference
          ].reactions[content].filter((reaction) => reaction.sender !== sender);
          if (contentState !== false) {
            organized[targetReference].reactions[content].push(nextItem);
          }
          if (organized[targetReference].reactions[content].length === 0) {
            delete organized[targetReference].reactions[content];
          }
          return organized;
        });
        return;
      }

      setMessages((prev) => {
        if (prev.some((message) => message.signature === nextItem.signature)) {
          return prev;
        }
        return [...prev, nextItem];
      });
    },
    [isChatSenderBlocked, processWithNewMessages, reticulumChatQueueId]
  );

  const convertReticulumEventToChatItem = useCallback(
    async (
      event,
      options?: {
        channelId?: string;
      }
    ) => {
      if (!event || Number(event.groupId) !== Number(selectedGroup))
        return null;
      const activeChannelId =
        normalizeReticulumChannelName(options?.channelId || '') ||
        selectedReticulumChannelId;
      const eventChannelId =
        normalizeReticulumChannelName(
          event.channelId || DEFAULT_RETICULUM_CHANNEL_ID
        ) || DEFAULT_RETICULUM_CHANNEL_ID;
      const isChannelMetadataEvent =
        typeof event.eventType === 'string' &&
        (event.eventType.startsWith('channel_') ||
          event.eventType.startsWith('category_'));
      const eventChannel = reticulumAllChannelsForSelectedGroup.find(
        (channel) => channel.channelId === eventChannelId
      );
      if (
        !isChannelMetadataEvent &&
        eventChannel?.readMode === RETICULUM_CHANNEL_READ_MODE_ADMINS &&
        !isReticulumChannelAdmin
      ) {
        return null;
      }
      if (
        !isChannelMetadataEvent &&
        eventChannelId !== activeChannelId
      ) {
        return null;
      }
      const baseItem = {
        signature: event.eventId,
        id: event.eventId,
        groupId: event.groupId,
        channelId: eventChannelId,
        sender: event.authorAddress,
        senderName:
          event.senderName ||
          event.authorPrimaryName ||
          reticulumMemberNameByAddress.get(event.authorAddress) ||
          (event.authorAddress === myAddress ? myName : undefined),
        timestamp: event.timestamp,
        data: event.encryptedPayload,
        chatReference: event.targetEventId || undefined,
        eventType: event.eventType,
        repliedTo: event.replyToEventId || undefined,
        replyTargetDeleted: event.replyTargetDeleted === true,
        reticulumChat: true,
      };
      let decryptedData = null;
      if (reticulumChatEnabled || isPrivate === false) {
        try {
          decryptedData = JSON.parse(event.encryptedPayload);
        } catch {
          decryptedData = { messageText: event.encryptedPayload };
        }
      } else {
        if (!secretKeyRef.current) return null;
        const decrypted = await window.sendMessage('decryptSingle', {
          data: [baseItem],
          secretKeyObject: secretKeyRef.current,
        });
        decryptedData = decrypted?.[0]?.decryptedData;
      }
      if (!decryptedData) return null;
      if (isChannelMetadataEvent) {
        const eventId = typeof event.eventId === 'string' ? event.eventId : '';
        if (
          eventId &&
          appliedReticulumChannelMetadataEventIdsRef.current.has(eventId)
        ) {
          return null;
        }
        const result = await window.reticulumChat?.applyChannelMetadata?.(
          event.eventId,
          decryptedData
        );
        if (result?.success) {
          if (eventId)
            appliedReticulumChannelMetadataEventIdsRef.current.add(eventId);
          await refreshReticulumChannels();
        }
        return null;
      }
      const normalizedText = normalizeChatHtmlContent(
        decryptedData.message || decryptedData.messageText
      );
      const searchIndexText = buildReticulumSearchIndexText(
        normalizedText,
        decryptedData
      );
      const mentionedAddresses = [
        ...new Set([
          ...mentionedAddressesFromPayload(decryptedData),
          ...resolveMentionedAddresses(normalizedText),
        ]),
      ];
      if (event.eventType === 'delete' && event.targetEventId) {
        void window.reticulumChat?.deleteSearchText?.(event.targetEventId);
        void window.reticulumChat?.deleteMentions?.(event.targetEventId);
      } else if (
        event.eventType === 'edit' &&
        event.targetEventId &&
        searchIndexText
      ) {
        void window.reticulumChat?.indexSearchText?.(
          event.eventId,
          searchIndexText
        );
        void window.reticulumChat?.replaceMentions?.(
          event.eventId,
          mentionedAddresses
        );
      } else if (
        (event.eventType === 'message' ||
          event.eventType === 'attachment_manifest') &&
        searchIndexText
      ) {
        void window.reticulumChat?.indexSearchText?.(
          event.eventId,
          searchIndexText
        );
        void window.reticulumChat?.replaceMentions?.(
          event.eventId,
          mentionedAddresses
        );
      }
      const normalizedDecryptedData = {
        ...decryptedData,
        ...(decryptedData.message !== undefined
          ? { message: normalizedText }
          : {}),
        ...(decryptedData.messageText !== undefined
          ? { messageText: normalizedText }
          : {}),
        ...(Array.isArray(decryptedData.images)
          ? {
              images: decryptedData.images.map((image) => {
                if (
                  !image ||
                  typeof image !== 'object' ||
                  image.reticulumResource !== true
                ) {
                  return image;
                }
                const fileHash =
                  typeof image.fileHash === 'string' ? image.fileHash : '';
                return {
                  ...image,
                  fileHash,
                };
              }),
            }
          : {}),
        ...(Array.isArray(decryptedData.attachments)
          ? {
              attachments: decryptedData.attachments.map((attachment) => {
                if (
                  !attachment ||
                  typeof attachment !== 'object' ||
                  attachment.reticulumResource !== true
                ) {
                  return attachment;
                }
                const fileHash =
                  typeof attachment.fileHash === 'string'
                    ? attachment.fileHash
                    : '';
                return {
                  ...attachment,
                  fileHash,
                };
              }),
            }
          : {}),
      };
      return {
        ...baseItem,
        ...normalizedDecryptedData,
        decryptedData: normalizedDecryptedData,
        message: normalizedText,
        messageText: normalizedText,
        text: normalizedText,
        eventType: event.eventType,
        isNotEncrypted: reticulumChatEnabled || isPrivate === false,
        unread: event.authorAddress === myAddress ? false : true,
      };
    },
    [
      isPrivate,
      isReticulumChannelAdmin,
      myAddress,
      myName,
      refreshReticulumChannels,
      reticulumChatEnabled,
      reticulumAllChannelsForSelectedGroup,
      reticulumMemberNameByAddress,
      resolveMentionedAddresses,
      selectedGroup,
      selectedReticulumChannelId,
    ]
  );

  useEffect(() => {
    reticulumSearchPageCursorsRef.current = [null];
    setReticulumSearchPage(0);
  }, [
    reticulumSearchAfterDate,
    reticulumSearchAuthorFilter,
    reticulumSearchBeforeDate,
    reticulumSearchChannelFilter,
    reticulumSearchHasFilter,
    reticulumSearchQuery,
    reticulumSearchSort,
    selectedGroup,
  ]);

  useEffect(() => {
    if (!reticulumChatEnabled || !reticulumSearchOpen || !selectedGroup) {
      setReticulumSearchResults([]);
      setReticulumSearchError('');
      setReticulumSearchHasNextPage(false);
      setIsReticulumSearchLoading(false);
      return;
    }
    const query = reticulumSearchQuery.trim();
    const hasExplicitFilters =
      reticulumSearchChannelFilter !== RETICULUM_SEARCH_CHANNEL_CURRENT ||
      Boolean(reticulumSearchAuthorFilter) ||
      reticulumSearchHasFilter !== RETICULUM_SEARCH_HAS_ANY ||
      Boolean(reticulumSearchAfterDate) ||
      Boolean(reticulumSearchBeforeDate) ||
      reticulumSearchSort !== 'relevance';
    if (query.length < 2 && !hasExplicitFilters) {
      setReticulumSearchResults([]);
      setReticulumSearchError('');
      setReticulumSearchHasNextPage(false);
      setIsReticulumSearchLoading(false);
      return;
    }
    const requestSeq = reticulumSearchRequestSeqRef.current + 1;
    reticulumSearchRequestSeqRef.current = requestSeq;
    setIsReticulumSearchLoading(true);
    setReticulumSearchError('');
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const channelIds =
            reticulumSearchChannelFilter === RETICULUM_SEARCH_CHANNEL_CURRENT
              ? [selectedReticulumChannelId]
              : reticulumSearchChannelFilter === RETICULUM_SEARCH_CHANNEL_ALL
                ? undefined
                : [reticulumSearchChannelFilter];
          const afterTimestamp = localDateStringToTimestamp(
            reticulumSearchAfterDate
          );
          const beforeTimestamp = localDateStringToTimestamp(
            reticulumSearchBeforeDate
          );
          const canUseCursorPaging =
            reticulumSearchSort === 'newest' ||
            reticulumSearchSort === 'oldest' ||
            query.length < 2;
          const cursor =
            canUseCursorPaging && reticulumSearchPage > 0
              ? reticulumSearchPageCursorsRef.current[reticulumSearchPage]
              : null;
          const results = (await window.reticulumChat?.search?.(query, {
            groupIds: [Number(selectedGroup)],
            channelIds,
            authorAddresses: reticulumSearchAuthorFilter
              ? [reticulumSearchAuthorFilter]
              : undefined,
            beforeTimestamp,
            afterTimestamp,
            hasAttachment:
              reticulumSearchHasFilter === RETICULUM_SEARCH_HAS_ATTACHMENT,
            hasLink: reticulumSearchHasFilter === RETICULUM_SEARCH_HAS_LINK,
            sort: reticulumSearchSort,
            limit: RETICULUM_SEARCH_PAGE_SIZE + 1,
            offset: cursor
              ? undefined
              : reticulumSearchPage * RETICULUM_SEARCH_PAGE_SIZE,
            cursor: cursor ?? undefined,
          })) as ReticulumSearchResult[] | undefined;
          if (reticulumSearchRequestSeqRef.current !== requestSeq) return;
          const visibleResults = (results ?? []).filter((result) => {
            const channelId =
              normalizeReticulumChannelName(result?.event?.channelId || '') ||
              DEFAULT_RETICULUM_CHANNEL_ID;
            return reticulumVisibleChannelIds.has(channelId);
          });
          setReticulumSearchHasNextPage(
            visibleResults.length > RETICULUM_SEARCH_PAGE_SIZE
          );
          setReticulumSearchResults(
            visibleResults.slice(0, RETICULUM_SEARCH_PAGE_SIZE)
          );
          const pageResults = visibleResults.slice(
            0,
            RETICULUM_SEARCH_PAGE_SIZE
          );
          const nextCursor = pageResults[pageResults.length - 1]?.cursor;
          if (canUseCursorPaging) {
            const nextPageCursors =
              reticulumSearchPageCursorsRef.current.slice(
                0,
                reticulumSearchPage + 1
              );
            if (
              visibleResults.length > RETICULUM_SEARCH_PAGE_SIZE &&
              nextCursor
            ) {
              nextPageCursors[reticulumSearchPage + 1] = nextCursor;
            }
            reticulumSearchPageCursorsRef.current = nextPageCursors;
          }
        } catch (error) {
          if (reticulumSearchRequestSeqRef.current !== requestSeq) return;
          console.error('[ReticulumChat] search failed', error);
          setReticulumSearchResults([]);
          setReticulumSearchHasNextPage(false);
          setReticulumSearchError('Search failed');
        } finally {
          if (reticulumSearchRequestSeqRef.current === requestSeq) {
            setIsReticulumSearchLoading(false);
          }
        }
      })();
    }, 220);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    myAddress,
    reticulumChatEnabled,
    reticulumSearchAfterDate,
    reticulumSearchAuthorFilter,
    reticulumSearchBeforeDate,
    reticulumSearchChannelFilter,
    reticulumSearchHasFilter,
    reticulumSearchOpen,
    reticulumSearchPage,
    reticulumSearchQuery,
    reticulumSearchSort,
    reticulumVisibleChannelIds,
    selectedGroup,
    selectedReticulumChannelId,
  ]);

  const reticulumSearchAuthorName = useCallback(
    (event: ReticulumSearchResult['event']) => {
      const address = event?.authorAddress || '';
      return (
        event?.senderName ||
        event?.authorPrimaryName ||
        reticulumMemberNameByAddress.get(address) ||
        address
      );
    },
    [reticulumMemberNameByAddress]
  );

  const resolvePrimaryNamesForReticulumEvents = useCallback(
    async (events: any[]) => {
      const missingAddresses = Array.from(
        new Set(
          events
            .map((event) =>
              typeof event?.authorAddress === 'string'
                ? event.authorAddress.trim()
                : ''
            )
            .filter((address) => {
              if (!address || address === myAddress) return false;
              if (reticulumMemberNameByAddress.get(address)) return false;
              return !reticulumPrimaryNameCacheRef.current.has(address);
            })
        )
      );

      if (missingAddresses.length > 0) {
        try {
          const primaryNames =
            await getPrimaryNamesForAddresses(missingAddresses);
          for (const address of missingAddresses) {
            reticulumPrimaryNameCacheRef.current.set(
              address,
              primaryNames[address]?.trim() || ''
            );
          }
        } catch (error) {
          console.error(
            '[ReticulumChat] Failed to resolve search window primary names',
            error
          );
          for (const address of missingAddresses) {
            if (!reticulumPrimaryNameCacheRef.current.has(address)) {
              reticulumPrimaryNameCacheRef.current.set(address, '');
            }
          }
        }
      }

      return events.map((event) => {
        const authorAddress =
          typeof event?.authorAddress === 'string'
            ? event.authorAddress.trim()
            : '';
        const resolvedName =
          (authorAddress === myAddress ? myName : '') ||
          reticulumMemberNameByAddress.get(authorAddress) ||
          reticulumPrimaryNameCacheRef.current.get(authorAddress) ||
          '';
        if (!resolvedName) return event;
        return {
          ...event,
          authorPrimaryName: event.authorPrimaryName || resolvedName,
          senderName: event.senderName || resolvedName,
        };
      });
    },
    [myAddress, myName, reticulumMemberNameByAddress]
  );

  const handleReticulumSearchResultClick = useCallback(
    async (result: ReticulumSearchResult) => {
      const event = result?.event;
      if (!event?.eventId || !selectedGroup) return;
      const channelId =
        normalizeReticulumChannelName(event.channelId || '') ||
        DEFAULT_RETICULUM_CHANNEL_ID;
      if (!reticulumVisibleChannelIds.has(channelId)) return;
      setSelectedReticulumChannelId(channelId);
      setIsLoading(true);
      try {
        const windowEvents =
          (await window.reticulumChat?.getMessageWindowAroundEvent?.(
            Number(selectedGroup),
            channelId,
            event.eventId,
            {
              beforeLimit: 80,
              afterLimit: 40,
            }
          )) ?? [];
        const namedWindowEvents =
          await resolvePrimaryNamesForReticulumEvents(windowEvents);
        const converted = await Promise.all(
          namedWindowEvents.map((windowEvent) =>
            convertReticulumEventToChatItem(windowEvent, { channelId })
          )
        );
        const convertedMessages = converted.filter(Boolean);
        const hasTargetMessage = convertedMessages.some(
          (message) => message?.signature === event.eventId
        );
        if (!hasTargetMessage) {
          throw new Error('search_result_window_missing_target');
        }
        setChatReferences({});
        setMessages(convertedMessages);
        setReticulumSearchScrollTarget((current) => ({
          messageId: event.eventId,
          nonce: (current?.nonce ?? 0) + 1,
        }));
        setReticulumSearchOpen(false);
      } catch (error) {
        console.error('[ReticulumChat] search result window failed', error);
        setInfoSnack({
          type: 'error',
          message: 'Unable to load search result',
        });
        setOpenSnack(true);
      } finally {
        setIsLoading(false);
      }
    },
    [
      convertReticulumEventToChatItem,
      myAddress,
      reticulumVisibleChannelIds,
      resolvePrimaryNamesForReticulumEvents,
      selectedGroup,
    ]
  );

  useEffect(() => {
    if (!reticulumChatEnabled || reticulumChatEvents.length === 0) return;
    const eventContext = `${selectedGroup || ''}:${
      selectedReticulumChannelId || DEFAULT_RETICULUM_CHANNEL_ID
    }`;
    void (async () => {
      for (const event of reticulumChatEvents) {
        const eventId = typeof event?.eventId === 'string' ? event.eventId : '';
        const processingKey = eventId ? `${eventContext}:${eventId}` : '';
        if (
          eventId &&
          (appliedReticulumEventIdsRef.current.has(eventId) ||
            processingReticulumEventIdsRef.current.has(processingKey))
        ) {
          continue;
        }
        if (processingKey)
          processingReticulumEventIdsRef.current.add(processingKey);
        try {
          const item = await convertReticulumEventToChatItem(event);
          if (reticulumEventContextRef.current !== eventContext) continue;
          if (item) {
            applyReticulumChatItem(item);
            if (eventId) appliedReticulumEventIdsRef.current.add(eventId);
          }
        } finally {
          if (processingKey)
            processingReticulumEventIdsRef.current.delete(processingKey);
        }
      }
    })();
  }, [
    applyReticulumChatItem,
    convertReticulumEventToChatItem,
    reticulumChatEnabled,
    reticulumChatEvents,
    selectedGroup,
    selectedReticulumChannelId,
  ]);

  useEffect(() => {
    if (
      !reticulumChatEnabled ||
      !isActive ||
      !selectedGroup
    ) {
      if (!isActive) {
        reticulumReadWasActiveRef.current = false;
      }
      return;
    }
    const readEntryToken =
      typeof reticulumReadEntryToken === 'number'
        ? reticulumReadEntryToken
        : null;
    const entryTokenChanged =
      readEntryToken !== null &&
      readEntryToken !== lastReticulumReadEntryTokenRef.current;
    const wasAlreadyActive = reticulumReadWasActiveRef.current === true;
    reticulumReadWasActiveRef.current = true;
    if (!entryTokenChanged && !wasAlreadyActive) {
      return;
    }
    const groupId = Number(selectedGroup);
    if (!Number.isInteger(groupId) || groupId <= 0) return;
    const latestVisibleTimestamp = reticulumChatEvents.reduce<number>((latest, event: any) => {
      if (Number(event?.groupId) !== groupId) return latest;
      const eventChannelId =
        normalizeReticulumChannelName(
          event?.channelId || DEFAULT_RETICULUM_CHANNEL_ID
        ) || DEFAULT_RETICULUM_CHANNEL_ID;
      if (eventChannelId !== selectedReticulumChannelId) return latest;
      const timestamp = Number(event?.timestamp);
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
    }, 0);
    const channelSummary = reticulumChannelSummariesById.get(
      selectedReticulumChannelId
    );
    const latestSummaryTimestamp = Math.max(
      Number(channelSummary?.lastEvent?.timestamp) || 0,
      Number(channelSummary?.updatedAt) || 0
    );
    const latestTimestamp = Math.max(
      latestVisibleTimestamp,
      latestSummaryTimestamp
    );
    if (latestTimestamp <= 0) return;
    if (entryTokenChanged) {
      lastReticulumReadEntryTokenRef.current = readEntryToken;
    }
    const readKey = `${groupId}:${selectedReticulumChannelId}:${myAddress || ''}`;
    const lastMarkedRead = lastReticulumMarkedReadRef.current;
    if (
      lastMarkedRead?.key === readKey &&
      lastMarkedRead.timestamp >= latestTimestamp
    ) {
      return;
    }
    lastReticulumMarkedReadRef.current = {
      key: readKey,
      timestamp: latestTimestamp,
    };
    void window.reticulumChat
      ?.markRead?.(
        groupId,
        selectedReticulumChannelId,
        latestTimestamp,
        myAddress
      )
      .then(() => {
        executeEvent('reticulum-chat-summaries-refresh', {});
      })
      .catch(() => {
        if (
          lastReticulumMarkedReadRef.current?.key === readKey &&
          lastReticulumMarkedReadRef.current?.timestamp === latestTimestamp
        ) {
          lastReticulumMarkedReadRef.current = null;
        }
      });
  }, [
    isActive,
    myAddress,
    reticulumReadEntryToken,
    reticulumChatEnabled,
    reticulumChatEvents,
    reticulumChannelSummariesById,
    selectedGroup,
    selectedReticulumChannelId,
  ]);

  const clearEditorContent = () => {
    if (editorRef.current) {
      setMessageSize(0);
      editorRef.current.chain().focus().clearContent().run();
    }
  };

  const clearPendingReticulumFiles = useCallback(() => {
    setPendingReticulumFiles((prev) => {
      prev.forEach((file) => {
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      });
      return [];
    });
  }, []);

  useEffect(() => {
    pendingReticulumFilesRef.current = pendingReticulumFiles;
  }, [pendingReticulumFiles]);

  useEffect(() => {
    return () => {
      pendingReticulumFilesRef.current.forEach((file) => {
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      });
    };
  }, []);

  const getImageFileDimensions = useCallback(
    (file: File): Promise<{ width: number; height: number } | null> => {
      return new Promise((resolve) => {
        if (!file.type?.startsWith('image/')) {
          resolve(null);
          return;
        }
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        const timeout = window.setTimeout(() => {
          img.onload = null;
          img.onerror = null;
          URL.revokeObjectURL(objectUrl);
          resolve(null);
        }, 5_000);
        img.onload = () => {
          window.clearTimeout(timeout);
          const width = Number(img.naturalWidth || img.width || 0);
          const height = Number(img.naturalHeight || img.height || 0);
          URL.revokeObjectURL(objectUrl);
          resolve(
            Number.isFinite(width) &&
              width > 0 &&
              Number.isFinite(height) &&
              height > 0
              ? { width, height }
              : null
          );
        };
        img.onerror = () => {
          window.clearTimeout(timeout);
          URL.revokeObjectURL(objectUrl);
          resolve(null);
        };
        img.src = objectUrl;
      });
    },
    []
  );

  const sendMessage = async () => {
    try {
      if (messageSize > MAX_SIZE_MESSAGE) return;
      if (!canWriteSelectedReticulumChannel) {
        throw new Error('Only group admins can write in this channel');
      }
      if (isPrivate === null)
        throw new Error(
          t('group:message.error:determine_group_private', {
            postProcess: 'capitalizeFirstChar',
          })
        );
      if (isSending) return;
      if (+balance < MIN_REQUIRED_QORTS)
        throw new Error(
          t('group:message.error.qortals_required', {
            quantity: MIN_REQUIRED_QORTS,
            postProcess: 'capitalizeFirstChar',
          })
        );
      pauseAllQueues();
      stopReticulumTyping();
      if (editorRef.current) {
        let htmlContent = editorRef.current.getHTML();
        const deleteImage =
          onEditMessage && isDeleteImage && messageHasImage(onEditMessage);

        const hasImage =
          chatImagesToSave?.length > 0 || onEditMessage?.images?.length > 0;
        const hasPendingReticulumFiles =
          reticulumChatEnabled && pendingReticulumFiles.length > 0;
        if (
          (!htmlContent?.trim() || htmlContent?.trim() === '<p></p>') &&
          !hasImage &&
          !hasPendingReticulumFiles &&
          !deleteImage
        )
          return;
        if (htmlContent?.trim() === '<p></p>') {
          htmlContent = null;
        }
        setIsSending(true);
        const reticulumPlainPayload = reticulumChatEnabled || isPrivate === false;
        const message =
          reticulumPlainPayload
            ? !htmlContent
              ? '<p></p>'
              : editorRef.current.getJSON()
            : htmlContent;
        const secretKeyObject = reticulumPlainPayload
          ? null
          : await getSecretKey(false, true);

        let repliedTo = replyMessage?.signature;

        if (replyMessage?.chatReference) {
          repliedTo = replyMessage?.chatReference;
        }

        const chatReference = onEditMessage?.signature;

        const publicData = reticulumPlainPayload
          ? {
              isEdited: chatReference ? true : false,
            }
          : {};

        interface ImageToPublish {
          service: string;
          identifier: string;
          name: string;
          base64: string;
        }

        const imagesToPublish: ImageToPublish[] = [];
        const getImageDimensions = (
          base64: string,
          mimeType = 'image/webp'
        ): Promise<{ width: number; height: number } | null> => {
          return new Promise((resolve) => {
            if (typeof base64 !== 'string' || !base64.trim()) {
              resolve(null);
              return;
            }
            const img = new Image();
            const timeout = window.setTimeout(() => {
              img.onload = null;
              img.onerror = null;
              resolve(null);
            }, 5_000);
            img.onload = () => {
              window.clearTimeout(timeout);
              const width = Number(img.naturalWidth || img.width || 0);
              const height = Number(img.naturalHeight || img.height || 0);
              resolve(
                Number.isFinite(width) &&
                  width > 0 &&
                  Number.isFinite(height) &&
                  height > 0
                  ? { width, height }
                  : null
              );
            };
            img.onerror = () => {
              window.clearTimeout(timeout);
              resolve(null);
            };
            img.src = `data:${mimeType};base64,${base64}`;
          });
        };

        if (deleteImage && !reticulumChatEnabled) {
          const fee = await getFee('ARBITRARY');
          await show({
            publishFee: fee.fee + ' QORT',
            message: t('core:message.question.delete_chat_image', {
              postProcess: 'capitalizeFirstChar',
            }),
          });

          await window.sendMessage('publishOnQDN', {
            data: 'RA==',
            identifier: onEditMessage?.images[0]?.identifier,
            service: onEditMessage?.images[0]?.service,
            uploadType: 'base64',
          });
        }

        if (chatImagesToSave?.length > 0 && !reticulumChatEnabled) {
          const imageToSave = chatImagesToSave[0];

          const base64ToSave = isPrivate
            ? await encryptChatMessage(imageToSave, secretKeyObject)
            : imageToSave;

          // 1 represents public group, 0 is private
          const identifier = `grp-q-manager_${isPrivate ? 0 : 1}_group_${selectedGroup}_${uidImages.rnd()}`;
          imagesToPublish.push({
            service: 'IMAGE',
            identifier,
            name: myName,
            base64: base64ToSave,
          });

          const res = await window.sendMessage(
            'PUBLISH_MULTIPLE_QDN_RESOURCES',
            {
              resources: imagesToPublish,
            },
            240000,
            true
          );
          if (res?.error)
            throw new Error(
              t('core:message.error.publish_image', {
                postProcess: 'capitalizeFirstChar',
              })
            );
        }

        const reticulumImages =
          reticulumChatEnabled &&
          (chatImagesToSave?.length > 0 ||
            pendingReticulumFiles.some((file) => file.isImage))
            ? await Promise.all(
                [
                  ...chatImagesToSave.map((base64, index) => ({
                    base64,
                    fileName: `chat-image-${Date.now()}-${index}.webp`,
                    mimeType: 'image/webp',
                    sizeBytes: 0,
                    isImage: true,
                  })),
                  ...pendingReticulumFiles.filter((file) => file.isImage),
                ].map(async (file, index) => {
                  const imageMimeType = file.mimeType || 'image/webp';
                  const base64 =
                    typeof file.base64 === 'string' && file.base64
                      ? file.base64
                      : '';
                  const dimensions =
                    file.width && file.height
                      ? { width: file.width, height: file.height }
                      : base64
                        ? await getImageDimensions(base64, imageMimeType)
                        : null;
                  if (file.filePath) {
                    const imported =
                      await window.reticulumResources?.importFilePath?.({
                        filePath: file.filePath,
                        namespace: 'reticulum-group-resource',
                        ownerId: `${selectedGroup}:${myAddress}`,
                        fileName:
                          file.fileName || `chat-image-${Date.now()}-${index}`,
                        mimeType: imageMimeType,
                        encrypted: false,
                        metadata: {
                          feature: 'reticulum-chat',
                          groupId: selectedGroup,
                          attachmentKind: 'image',
                          originalMimeType: imageMimeType,
                          ...(dimensions
                            ? {
                                width: dimensions.width,
                                height: dimensions.height,
                              }
                            : {}),
                        },
                      });
                    if (!imported?.success || !imported.manifest) {
                      throw new Error(
                        imported?.error ||
                          'Reticulum image resource import failed'
                      );
                    }
                    return {
                      ...(imported.manifest as Record<string, unknown>),
                      ...(dimensions
                        ? {
                            width: dimensions.width,
                            height: dimensions.height,
                          }
                        : {}),
                      reticulumResource: true,
                      timestamp: Date.now(),
                    };
                  }
                  if (!base64) {
                    throw new Error('Reticulum image file is not available');
                  }
                  const imported =
                    await window.reticulumResources?.importBase64?.({
                      base64,
                      namespace: 'reticulum-group-resource',
                      ownerId: `${selectedGroup}:${myAddress}`,
                      fileName:
                        file.fileName ||
                        `chat-image-${Date.now()}-${index}.webp`,
                      mimeType: imageMimeType,
                      encrypted: false,
                      metadata: {
                        feature: 'reticulum-chat',
                        groupId: selectedGroup,
                        attachmentKind: 'image',
                        originalMimeType: imageMimeType,
                        ...(dimensions
                          ? {
                              width: dimensions.width,
                              height: dimensions.height,
                            }
                          : {}),
                      },
                    });
                  if (!imported?.success || !imported.manifest) {
                    throw new Error(
                      imported?.error ||
                        'Reticulum image resource import failed'
                    );
                  }
                  return {
                    ...(imported.manifest as Record<string, unknown>),
                    ...(dimensions
                      ? {
                          width: dimensions.width,
                          height: dimensions.height,
                        }
                      : {}),
                    reticulumResource: true,
                    timestamp: Date.now(),
                  };
                })
              )
            : null;

        const reticulumAttachments =
          reticulumChatEnabled &&
          pendingReticulumFiles.some((file) => !file.isImage)
            ? await Promise.all(
                pendingReticulumFiles
                  .filter((file) => !file.isImage)
                  .map(async (file) => {
                    if (!file.filePath) {
                      throw new Error(
                        'File attachments require a local file path'
                      );
                    }
                    const imported =
                      await window.reticulumResources?.importFilePath?.({
                        filePath: file.filePath,
                        namespace: 'reticulum-group-resource',
                        ownerId: `${selectedGroup}:${myAddress}`,
                        fileName: file.fileName,
                        mimeType: file.mimeType || 'application/octet-stream',
                        encrypted: false,
                        metadata: {
                          feature: 'reticulum-chat',
                          groupId: selectedGroup,
                          attachmentKind: 'file',
                        },
                      });
                    if (!imported?.success || !imported.manifest) {
                      throw new Error(
                        imported?.error ||
                          'Reticulum file resource import failed'
                      );
                    }
                    return {
                      ...(imported.manifest as Record<string, unknown>),
                      reticulumResource: true,
                      timestamp: Date.now(),
                    };
                  })
              )
            : [];

        const images = reticulumImages
          ? reticulumImages
          : imagesToPublish?.length > 0
            ? imagesToPublish.map((item) => {
                return {
                  name: item.name,
                  identifier: item.identifier,
                  service: item.service,
                  timestamp: Date.now(),
                };
              })
            : chatReference
              ? isDeleteImage
                ? []
                : onEditMessage?.images || []
              : [];

        const mentionedAddresses = resolveMentionedAddresses(htmlContent || '');
        const mentionTargets = resolveMentionTargets(htmlContent || '');
        const mentionedAddressHashes =
          await buildMentionAddressHashes(mentionedAddresses);
        const otherData = {
          repliedTo,
          ...(onEditMessage?.decryptedData || {}),
          type: chatReference ? 'edit' : '',
          specialId: uid.rnd(),
          images: images,
          ...(reticulumAttachments.length > 0
            ? { attachments: reticulumAttachments }
            : {}),
          mentionedAddresses,
          mentionTargets,
          ...publicData,
        };
        const objectMessage = {
          ...(otherData || {}),
          [reticulumPlainPayload ? 'messageText' : 'message']: message,
          version: 3,
        };
        const message64: any = await objectToBase64(objectMessage);

        const encryptSingle =
          reticulumPlainPayload
            ? JSON.stringify(objectMessage)
            : await encryptChatMessage(message64, secretKeyObject);

        const sendMessageFunc = async () => {
          if (reticulumChatEnabled) {
            const result = await publishReticulumGroupChatEvent({
              encryptedPayload: encryptSingle,
              eventType: chatReference ? 'edit' : 'message',
              targetEventId: chatReference || undefined,
              replyToEventId: repliedTo || undefined,
              mentionAddressHashes: mentionedAddressHashes,
              mentionTargets,
            });
            return { ...result, clearQueueOnSuccess: true };
          }
          return await sendChatGroup({
            groupId: selectedGroup,
            messageText: encryptSingle,
            chatReference,
          });
        };

        // Add the function to the queue
        const messageObj = {
          message: {
            text: htmlContent,
            timestamp: Date.now(),
            senderName: myName,
            sender: myAddress,
            ...(otherData || {}),
          },
          chatReference,
        };
        addToQueue(sendMessageFunc, messageObj, 'chat', reticulumChatQueueId);
        if (!onEditMessage) {
          setTimeout(() => {
            executeEvent('sent-new-message-group', {});
          }, 150);
        }

        clearEditorContent();
        setReplyMessage(null);
        setOnEditMessage(null);
        setIsDeleteImage(false);
        setChatImagesToSave([]);
        clearPendingReticulumFiles();
      }
      // send chat message
    } catch (error) {
      const errorMsg = error?.message || error;
      setInfoSnack({
        type: 'error',
        message: errorMsg,
      });
      setOpenSnack(true);
      console.error(error);
    } finally {
      setIsSending(false);
      resumeAllQueues();
    }
  };

  useEffect(() => {
    if (!editorRef?.current) return;

    handleUpdateRef.current = throttle(async () => {
      try {
        if (isPrivate && !reticulumChatEnabled) {
          const htmlContent = editorRef.current.getHTML();
          const message64 = await objectToBase64(JSON.stringify(htmlContent));
          const secretKeyObject = await getSecretKey(false, true);
          const encryptSingle = await encryptChatMessage(
            message64,
            secretKeyObject
          );
          setMessageSize((encryptSingle?.length || 0) + 200);
        } else {
          const htmlContent = editorRef.current.getJSON();
          const message = JSON.stringify(htmlContent);
          const size = new Blob([message]).size;
          setMessageSize(size + 300);
        }
      } catch (error) {
        // calc size error
      }
    }, 1200);

    const currentEditor = editorRef.current;

    currentEditor.on('update', handleUpdateRef.current);

    return () => {
      currentEditor.off('update', handleUpdateRef.current);
    };
  }, [
    editorRef,
    encryptChatMessage,
    getSecretKey,
    isPrivate,
    reticulumChatEnabled,
    setMessageSize,
  ]);

  useEffect(() => {
    if (hide) {
      setTimeout(() => setIsMoved(true), 500); // Wait for the fade-out to complete before moving
    } else {
      setIsMoved(false); // Reset the position immediately when showing
    }
  }, [hide]);

  const onReply = useCallback(
    (message) => {
      if (onEditMessage) {
        clearEditorContent();
      }
      setReplyMessage(message);
      setOnEditMessage(null);
      setIsDeleteImage(false);
      setChatImagesToSave([]);
      editorRef?.current?.chain().focus();
    },
    [onEditMessage]
  );

  const onEdit = useCallback((message) => {
    setOnEditMessage(message);
    setReplyMessage(null);
    try {
      editorRef.current
        .chain()
        .focus()
        .setContent(
          normalizeChatHtmlContent(message?.messageText || message?.text)
        )
        .run();
    } catch (error) {
      console.error(error);
    }
  }, []);

  const getLatestOwnEditableMessage = useCallback(() => {
    let latestMessage = null;
    let latestTimestamp = -Infinity;
    let latestIndex = -1;

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || typeof message !== 'object') continue;
      if (message.sender !== myAddress) continue;
      if (message.isTemp) continue;
      if (message.chatReference) continue;

      const signature = message.signature || message.id;
      if (!signature) continue;

      const messageType =
        message.eventType || message.decryptedData?.type || message.type;
      if (
        messageType === 'edit' ||
        messageType === 'delete' ||
        messageType === 'reaction' ||
        messageType === 'reaction_add' ||
        messageType === 'reaction_remove' ||
        messageType === 'attachment_manifest'
      ) {
        continue;
      }
      if (
        reticulumChatEnabled &&
        message.reticulumChat &&
        normalizeReticulumChannelName(
          message.channelId || DEFAULT_RETICULUM_CHANNEL_ID
        ) !== selectedReticulumChannelId
      ) {
        continue;
      }

      const timestamp = Number(message.timestamp || 0);
      if (timestamp < latestTimestamp) continue;
      if (timestamp === latestTimestamp && index < latestIndex) continue;

      const edit = chatReferences?.[signature]?.edit;
      latestMessage = edit
        ? {
            ...message,
            text: edit.message,
            messageText: edit.messageText,
            images: edit.images,
            isEdit: true,
            editTimestamp: edit.timestamp,
          }
        : message;
      latestTimestamp = timestamp;
      latestIndex = index;
    }

    return latestMessage;
  }, [
    chatReferences,
    messages,
    myAddress,
    reticulumChatEnabled,
    selectedReticulumChannelId,
  ]);

  const handleComposerKeyDown = useCallback(
    (event, editor) => {
      if (event.key !== 'ArrowUp') return false;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return false;
      }
      if (event.isComposing) return false;
      if (
        onEditMessage ||
        replyMessage ||
        chatImagesToSave.length > 0 ||
        pendingReticulumFiles.length > 0
      ) {
        return false;
      }

      const html = editor?.getHTML?.()?.trim() || '';
      const text = editor?.getText?.()?.trim() || '';
      const isEmptyEditor =
        editor?.isEmpty === true || (!text && (!html || html === '<p></p>'));
      if (!isEmptyEditor) return false;

      const latestMessage = getLatestOwnEditableMessage();
      if (!latestMessage) return false;

      event.preventDefault();
      onEdit(latestMessage);
      return true;
    },
    [
      chatImagesToSave.length,
      getLatestOwnEditableMessage,
      onEdit,
      onEditMessage,
      pendingReticulumFiles.length,
      replyMessage,
    ]
  );

  const onDelete = useCallback(
    async (message) => {
      try {
        if (!reticulumChatEnabled || !message?.reticulumChat) return;
        if (isSending) return;
        if (+balance < MIN_REQUIRED_QORTS)
          throw new Error(
            t('group:message.error.qortals_required', {
              quantity: MIN_REQUIRED_QORTS,
              postProcess: 'capitalizeFirstChar',
            })
          );
        if (isPrivate === null)
          throw new Error(
            t('group:message.error:determine_group_private', {
              postProcess: 'capitalizeFirstChar',
            })
          );
        pauseAllQueues();
        setIsSending(true);

        const targetEventId = message.signature || message.id;
        if (!targetEventId) return;
        const objectMessage = {
          message: '',
          type: 'delete',
          targetEventId,
          specialId: uid.rnd(),
          version: 3,
        };
        const encryptedPayload = JSON.stringify(objectMessage);
        const result = await publishReticulumGroupChatEvent({
          encryptedPayload,
          eventType: 'delete',
          targetEventId,
        });
        if (!result?.success) {
          throw new Error(result?.error || 'Reticulum chat delete failed');
        }
        if (result?.event) {
          const item = await convertReticulumEventToChatItem(result.event);
          if (item) {
            if (typeof result.event.eventId === 'string') {
              appliedReticulumEventIdsRef.current.add(result.event.eventId);
            }
            applyReticulumChatItem(item);
          }
        }
      } catch (error) {
        const errorMsg = error?.message || error;
        setInfoSnack({
          type: 'error',
          message: errorMsg,
        });
        setOpenSnack(true);
        console.error(error);
      } finally {
        setIsSending(false);
        resumeAllQueues();
      }
    },
    [
      applyReticulumChatItem,
      balance,
      convertReticulumEventToChatItem,
      getSecretKey,
      isPrivate,
      isSending,
      publishReticulumGroupChatEvent,
      reticulumChatEnabled,
      t,
    ]
  );

  const handleReaction = useCallback(
    async (reaction, chatMessage, reactionState = true) => {
      try {
        if (isSending) return;
        if (+balance < MIN_REQUIRED_QORTS)
          throw new Error(
            t('group:message.error.qortals_required', {
              quantity: MIN_REQUIRED_QORTS,
              postProcess: 'capitalizeFirstChar',
            })
          );

        pauseAllQueues();
        setIsSending(true);

        const message = '';
        const reticulumPlainPayload = reticulumChatEnabled || isPrivate === false;
        const secretKeyObject = reticulumPlainPayload
          ? null
          : await getSecretKey(false, true);
        const otherData = {
          specialId: uid.rnd(),
          type: 'reaction',
          content: reaction,
          contentState: reactionState,
        };
        const objectMessage = {
          message,
          ...(otherData || {}),
        };
        const message64: any = await objectToBase64(objectMessage);
        const reactiontypeNumber = RESOURCE_TYPE_NUMBER_GROUP_CHAT_REACTIONS;
        const encryptSingle =
          reticulumPlainPayload
            ? JSON.stringify(objectMessage)
            : await encryptChatMessage(
                message64,
                secretKeyObject,
                reactiontypeNumber
              );
        const sendMessageFunc = async () => {
          if (reticulumChatEnabled) {
            const result = await publishReticulumGroupChatEvent({
              encryptedPayload: encryptSingle,
              eventType: reactionState ? 'reaction_add' : 'reaction_remove',
              targetEventId: chatMessage.signature,
            });
            return { ...result, clearQueueOnSuccess: true };
          }
          return await sendChatGroup({
            groupId: selectedGroup,
            messageText: encryptSingle,
            chatReference: chatMessage.signature,
          });
        };

        // Add the function to the queue
        const messageObj = {
          message: {
            text: message,
            timestamp: Date.now(),
            senderName: myName,
            sender: myAddress,
            ...(otherData || {}),
          },
          chatReference: chatMessage.signature,
        };
        addToQueue(
          sendMessageFunc,
          messageObj,
          'chat-reaction',
          reticulumChatQueueId
        );
        // send chat message
      } catch (error) {
        const errorMsg = error?.message || error;
        setInfoSnack({
          type: 'error',
          message: errorMsg,
        });
        setOpenSnack(true);
        console.error(error);
      } finally {
        setIsSending(false);
        resumeAllQueues();
      }
    },
    [
      applyReticulumChatItem,
      convertReticulumEventToChatItem,
      isPrivate,
      publishReticulumGroupChatEvent,
      reticulumChatEnabled,
    ]
  );

  const openQManager = useCallback((eventOrRect?: any) => {
    const targetRect =
      eventOrRect?.currentTarget?.getBoundingClientRect?.() ?? null;
    const possibleRect =
      eventOrRect?.detail?.anchorRect ??
      eventOrRect?.anchorRect ??
      targetRect ??
      eventOrRect;
    if (
      possibleRect &&
      typeof possibleRect.left === 'number' &&
      typeof possibleRect.bottom === 'number'
    ) {
      setQManagerAnchorRect({
        bottom: possibleRect.bottom,
        height: possibleRect.height ?? 0,
        left: possibleRect.left,
        right: possibleRect.right ?? possibleRect.left,
        top: possibleRect.top ?? possibleRect.bottom,
        width: possibleRect.width ?? 0,
      });
    }
    setIsOpenQManager(true);
  }, []);

  useEffect(() => {
    if (!reticulumChatEnabled) return;
    const openSearch = () => setReticulumSearchOpen(true);
    subscribeToEvent('openReticulumChatSearch', openSearch);
    subscribeToEvent('openReticulumQManager', openQManager);
    return () => {
      unsubscribeFromEvent('openReticulumChatSearch', openSearch);
      unsubscribeFromEvent('openReticulumQManager', openQManager);
    };
  }, [openQManager, reticulumChatEnabled]);

  const theme = useTheme();

  const insertImage = useCallback(
    (img) => {
      if (
        chatImagesToSave?.length > 0 ||
        pendingReticulumFiles.length > 0 ||
        (messageHasImage(onEditMessage) && !isDeleteImage)
      ) {
        setInfoSnack({
          type: 'error',
          message: t('core:message.generic.message_with_image', {
            postProcess: 'capitalizeFirstChar',
          }),
        });
        setOpenSnack(true);
        return;
      }
      setChatImagesToSave((prev) => [...prev, img]);
    },
    [
      chatImagesToSave,
      pendingReticulumFiles.length,
      onEditMessage?.images,
      isDeleteImage,
    ]
  );

  const addPendingReticulumFile = useCallback(
    async (
      file: File,
      options: { asAttachment?: boolean; filePathOverride?: string } = {}
    ) => {
      const filePath =
        options.filePathOverride ||
        window.reticulumResources?.getPathForFile?.(file) ||
        (typeof (file as File & { path?: unknown }).path === 'string'
          ? String((file as File & { path?: unknown }).path)
          : '');
      const isImage =
        file.type?.startsWith('image/') === true && options.asAttachment !== true;
      if (options.asAttachment && !filePath) {
        setInfoSnack({
          type: 'error',
          message: 'This file source cannot be streamed from disk',
        });
        setOpenSnack(true);
        return false;
      }
      const dimensions = isImage ? await getImageFileDimensions(file) : null;
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      const base64 = isImage && !filePath ? await fileToBase64(file) : undefined;
      setPendingReticulumFiles([
        {
          ...(filePath ? { filePath } : {}),
          fileName: file.name || 'resource.bin',
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size || 0,
          isImage,
          ...(previewUrl ? { previewUrl } : {}),
          ...(typeof base64 === 'string' && base64 ? { base64 } : {}),
          ...(dimensions
            ? {
                width: dimensions.width,
                height: dimensions.height,
              }
            : {}),
        },
      ]);
      return true;
    },
    [getImageFileDimensions]
  );

  const insertFiles = useCallback(
    async (files: File[]) => {
      const file = files.find((item) => item && item.size >= 0);
      if (!file) return;
      if (
        chatImagesToSave?.length > 0 ||
        pendingReticulumFiles.length > 0 ||
        (messageHasImage(onEditMessage) && !isDeleteImage)
      ) {
        setInfoSnack({
          type: 'error',
          message: t('core:message.generic.message_with_image', {
            postProcess: 'capitalizeFirstChar',
          }),
        });
        setOpenSnack(true);
        return;
      }

      const isImage = file.type?.startsWith('image/') === true;
      if (!reticulumChatEnabled) {
        if (!isImage) {
          setInfoSnack({
            type: 'error',
            message: 'File attachments require Reticulum chat',
          });
          setOpenSnack(true);
          return;
        }
        const base64 = await fileToBase64(file);
        insertImage(base64);
        return;
      }

      const filePath =
        window.reticulumResources?.getPathForFile?.(file) ||
        (typeof (file as File & { path?: unknown }).path === 'string'
          ? String((file as File & { path?: unknown }).path)
          : '');
      if (!isImage && !filePath) {
        setInfoSnack({
          type: 'error',
          message: 'This file source cannot be streamed from disk',
        });
        setOpenSnack(true);
        return;
      }
      if (isImage && isReticulumCompressibleImage(file)) {
        setReticulumLargeImageChoice({ file, filePath });
        return;
      }
      await addPendingReticulumFile(file, { filePathOverride: filePath });
    },
    [
      addPendingReticulumFile,
      chatImagesToSave,
      insertImage,
      isDeleteImage,
      isPrivate,
      onEditMessage,
      pendingReticulumFiles.length,
      reticulumChatEnabled,
      t,
    ]
  );

  const closeReticulumLargeImageChoice = useCallback(() => {
    if (isCompressingReticulumImage) return;
    setReticulumLargeImageChoice(null);
  }, [isCompressingReticulumImage]);

  const useReticulumCompressedImage = useCallback(async () => {
    const choice = reticulumLargeImageChoice;
    if (!choice || isCompressingReticulumImage) return;
    setIsCompressingReticulumImage(true);
    try {
      const compressed = await compressReticulumImageFile(choice.file);
      await addPendingReticulumFile(compressed);
      setReticulumLargeImageChoice(null);
    } finally {
      setIsCompressingReticulumImage(false);
    }
  }, [
    addPendingReticulumFile,
    isCompressingReticulumImage,
    reticulumLargeImageChoice,
  ]);

  const useReticulumImageAsAttachment = useCallback(async () => {
    const choice = reticulumLargeImageChoice;
    if (!choice || isCompressingReticulumImage) return;
    const added = await addPendingReticulumFile(choice.file, {
      asAttachment: true,
      filePathOverride: choice.filePath,
    });
    if (added) {
      setReticulumLargeImageChoice(null);
    }
  }, [
    addPendingReticulumFile,
    isCompressingReticulumImage,
    reticulumLargeImageChoice,
  ]);

  const publishReticulumChannelMetadata = useCallback(
    async (
      eventType:
        | 'channel_create'
        | 'channel_update'
        | 'channel_archive'
        | 'channel_reorder'
        | 'category_create'
        | 'category_update'
        | 'category_delete',
      payload: Record<string, unknown>,
      options: { refresh?: boolean } = {}
    ) => {
      if (!reticulumChatEnabled || !isReticulumChannelAdmin) return;
      const payloadText = JSON.stringify(payload);
      const result = await publishReticulumGroupChatEvent({
        encryptedPayload: payloadText,
        eventType,
        channelId:
          typeof payload.channelId === 'string'
            ? payload.channelId
            : DEFAULT_RETICULUM_CHANNEL_ID,
      });
      if (result?.event) {
        const applyResult = window.reticulumChat?.applyChannelMetadata?.(
          result.event.eventId,
          payload
        );
        if (options.refresh === false) {
          await applyResult;
        } else {
          void applyResult?.then(() => {
            void refreshReticulumChannels();
          });
        }
      }
    },
    [
      isReticulumChannelAdmin,
      publishReticulumGroupChatEvent,
      refreshReticulumChannels,
      reticulumChatEnabled,
    ]
  );

  const openReticulumNameEmojiPicker = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      target: 'channel-create' | 'channel-settings' | 'category'
    ) => {
      event.preventDefault();
      setReticulumNameEmojiPicker({ anchorEl: event.currentTarget, target });
    },
    []
  );

  const closeReticulumNameEmojiPicker = useCallback(() => {
    setReticulumNameEmojiPicker(null);
  }, []);

  const appendReticulumNameEmoji = useCallback(
    (emojiData: { emoji?: string }) => {
      const emoji = emojiData?.emoji;
      if (!emoji || !reticulumNameEmojiPicker) return;
      if (reticulumNameEmojiPicker.target === 'channel-create') {
        setNewReticulumChannelName((current) => `${current}${emoji}`);
        setNewReticulumChannelError('');
      } else if (reticulumNameEmojiPicker.target === 'channel-settings') {
        setReticulumChannelName((current) => `${current}${emoji}`);
        setReticulumChannelError('');
      } else {
        setReticulumCategoryName((current) => `${current}${emoji}`);
        setReticulumCategoryError('');
      }
      closeReticulumNameEmojiPicker();
    },
    [closeReticulumNameEmojiPicker, reticulumNameEmojiPicker]
  );

  const renderReticulumNameEmojiAdornment = (
    target: 'channel-create' | 'channel-settings' | 'category'
  ) => (
    <InputAdornment position="end">
      <Tooltip title="Choose emoji">
        <IconButton
          aria-label="Choose emoji"
          edge="end"
          onClick={(event) => openReticulumNameEmojiPicker(event, target)}
          onMouseDown={(event) => event.preventDefault()}
          size="small"
          sx={{
            borderRadius: '5px',
            color: 'text.secondary',
            height: 28,
            width: 28,
            '&:hover': {
              backgroundColor: 'action.hover',
              color: 'text.primary',
            },
          }}
        >
          <EmojiEmotionsRoundedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </InputAdornment>
  );

  const openCreateReticulumChannelDialog = useCallback((categoryId = '') => {
    setNewReticulumChannelCategoryId(categoryId);
    setNewReticulumChannelName('');
    setNewReticulumChannelAccessMode(RETICULUM_CHANNEL_ACCESS_REGULAR);
    setNewReticulumChannelError('');
    setIsCreateReticulumChannelOpen(true);
  }, []);

  const closeCreateReticulumChannelDialog = useCallback(() => {
    setIsCreateReticulumChannelOpen(false);
    setNewReticulumChannelName('');
    setNewReticulumChannelError('');
    setNewReticulumChannelCategoryId('');
    setNewReticulumChannelAccessMode(RETICULUM_CHANNEL_ACCESS_REGULAR);
    setReticulumNameEmojiPicker(null);
  }, []);

  const createReticulumChannel = useCallback(async () => {
    if (isCreatingReticulumChannel) return;
    const name = normalizeReticulumDisplayName(newReticulumChannelName);
    if (!name) {
      setNewReticulumChannelError('Enter a channel name');
      return;
    }
    if (
      reticulumChannelsForSelectedGroup.some(
        (channel) => reticulumDisplayNameKey(channel.name) === reticulumDisplayNameKey(name)
      )
    ) {
      setNewReticulumChannelError('Channel already exists');
      return;
    }
    const channelId =
      reticulumDisplayNameKey(name) === DEFAULT_RETICULUM_CHANNEL_ID
        ? DEFAULT_RETICULUM_CHANNEL_ID
        : `ch-${crypto.randomUUID?.() || `${Date.now()}-${uid.rnd()}`}`;
    const categoryIds = new Set(
      reticulumCategoriesForSelectedGroup.map((category) => category.categoryId)
    );
    const categoryId = categoryIds.has(newReticulumChannelCategoryId)
      ? newReticulumChannelCategoryId
      : '';
    const position = reticulumChannelsByCategory.get(categoryId)?.length ?? 0;
    const channelModes = reticulumChannelModesFromAccess(
      newReticulumChannelAccessMode
    );
    setIsCreatingReticulumChannel(true);
    try {
      await publishReticulumChannelMetadata('channel_create', {
        channelId,
        categoryId,
        name,
        position,
        writeMode: channelModes.writeMode,
        readMode: channelModes.readMode,
      });
      setSelectedReticulumChannelId(channelId);
      closeCreateReticulumChannelDialog();
    } finally {
      setIsCreatingReticulumChannel(false);
    }
  }, [
    closeCreateReticulumChannelDialog,
    isCreatingReticulumChannel,
    newReticulumChannelCategoryId,
    newReticulumChannelAccessMode,
    newReticulumChannelName,
    publishReticulumChannelMetadata,
    reticulumCategoriesForSelectedGroup,
    reticulumChannelsForSelectedGroup,
    reticulumChannelsByCategory,
  ]);

  const openReticulumChannelSettings = useCallback(
    (channel: ReticulumGroupChannel) => {
      setEditingReticulumChannel(channel);
      setReticulumChannelName(channel.name || channel.channelId);
      setReticulumChannelAccessMode(
        reticulumChannelAccessFromModes(channel.writeMode, channel.readMode)
      );
      setReticulumChannelError('');
      setReticulumChannelSettingsView('settings');
      setReticulumDeleteConfirmationName('');
      setReticulumDeleteConfirmationError('');
      setIsDeletingReticulumChannel(false);
      setReticulumChannelSettingsOpen(true);
    },
    []
  );

  const closeReticulumChannelSettings = useCallback(() => {
    setReticulumChannelSettingsOpen(false);
    setEditingReticulumChannel(null);
    setReticulumChannelName('');
    setReticulumChannelAccessMode(RETICULUM_CHANNEL_ACCESS_REGULAR);
    setReticulumChannelError('');
    setReticulumChannelSettingsView('settings');
    setReticulumDeleteConfirmationName('');
    setReticulumDeleteConfirmationError('');
    setIsDeletingReticulumChannel(false);
    setReticulumNameEmojiPicker(null);
  }, []);

  const saveReticulumChannelSettings = useCallback(async () => {
    if (!editingReticulumChannel) return;
    const name = normalizeReticulumDisplayName(reticulumChannelName);
    if (!name) {
      setReticulumChannelError('Enter a channel name');
      return;
    }
    const duplicate = reticulumChannelsForSelectedGroup.some(
      (channel) =>
        channel.channelId !== editingReticulumChannel.channelId &&
        reticulumDisplayNameKey(channel.name) === reticulumDisplayNameKey(name)
    );
    if (duplicate) {
      setReticulumChannelError('Channel already exists');
      return;
    }
    const channelModes = reticulumChannelModesFromAccess(
      reticulumChannelAccessMode
    );
    await publishReticulumChannelMetadata('channel_update', {
      channelId: editingReticulumChannel.channelId,
      categoryId: editingReticulumChannel.categoryId || '',
      name,
      position: editingReticulumChannel.position,
      writeMode: channelModes.writeMode,
      readMode: channelModes.readMode,
    });
    closeReticulumChannelSettings();
  }, [
    closeReticulumChannelSettings,
    editingReticulumChannel,
    publishReticulumChannelMetadata,
    reticulumChannelAccessMode,
    reticulumChannelName,
    reticulumChannelsForSelectedGroup,
  ]);

  const openCreateReticulumCategoryDialog = useCallback(() => {
    setReticulumCategoryDialogMode('create');
    setEditingReticulumCategory(null);
    setReticulumCategoryName('');
    setReticulumCategoryError('');
    setIsReticulumCategoryDialogOpen(true);
  }, []);

  const openRenameReticulumCategoryDialog = useCallback(
    (category: ReticulumGroupCategory) => {
      setReticulumCategoryDialogMode('rename');
      setEditingReticulumCategory(category);
      setReticulumCategoryName(category.name);
      setReticulumCategoryError('');
      setIsReticulumCategoryDialogOpen(true);
    },
    []
  );

  const closeReticulumCategoryDialog = useCallback(() => {
    setIsReticulumCategoryDialogOpen(false);
    setEditingReticulumCategory(null);
    setReticulumCategoryName('');
    setReticulumCategoryError('');
    setReticulumNameEmojiPicker(null);
  }, []);

  const saveReticulumCategory = useCallback(async () => {
    const name = normalizeReticulumDisplayName(reticulumCategoryName);
    if (!name) {
      setReticulumCategoryError('Enter a category name');
      return;
    }
    const duplicate = reticulumCategoriesForSelectedGroup.some(
      (category) =>
        reticulumDisplayNameKey(category.name) === reticulumDisplayNameKey(name) &&
        category.categoryId !== editingReticulumCategory?.categoryId
    );
    if (duplicate) {
      setReticulumCategoryError('Category already exists');
      return;
    }
    if (reticulumCategoryDialogMode === 'rename' && editingReticulumCategory) {
      await publishReticulumChannelMetadata('category_update', {
        categoryId: editingReticulumCategory.categoryId,
        name,
        position: editingReticulumCategory.position,
      });
    } else {
      await publishReticulumChannelMetadata('category_create', {
        categoryId: `cat-${crypto.randomUUID?.() || `${Date.now()}-${uid.rnd()}`}`,
        name,
        position: reticulumCategoriesForSelectedGroup.length,
      });
    }
    closeReticulumCategoryDialog();
  }, [
    closeReticulumCategoryDialog,
    editingReticulumCategory,
    publishReticulumChannelMetadata,
    reticulumCategoriesForSelectedGroup,
    reticulumCategoryDialogMode,
    reticulumCategoryName,
  ]);

  const deleteReticulumCategory = useCallback(
    async (category: ReticulumGroupCategory) => {
      await publishReticulumChannelMetadata('category_delete', {
        categoryId: category.categoryId,
      });
      await refreshReticulumChannels();
    },
    [publishReticulumChannelMetadata, refreshReticulumChannels]
  );

  const toggleReticulumCategoryCollapsed = useCallback((categoryId: string) => {
    setCollapsedReticulumCategoryIds((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  }, []);

  const openReticulumCategoryContextMenu = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      category: ReticulumGroupCategory
    ) => {
      if (!isReticulumChannelAdmin) return;
      event.preventDefault();
      setReticulumCategoryMenuCategory(category);
      setReticulumCategoryMenuPosition({
        mouseX: event.clientX + 2,
        mouseY: event.clientY - 6,
      });
    },
    [isReticulumChannelAdmin]
  );

  const closeReticulumCategoryContextMenu = useCallback(() => {
    setReticulumCategoryMenuPosition(null);
    setReticulumCategoryMenuCategory(null);
  }, []);

  const reticulumChannelDndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 140, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const reticulumChannelDragItems = useMemo(
    () =>
      reticulumChannelsForSelectedGroup.map((channel) =>
        reticulumChannelDragId(channel.channelId)
      ),
    [reticulumChannelsForSelectedGroup]
  );

  const reticulumCategoryDragItems = useMemo(
    () =>
      reticulumCategoriesForSelectedGroup.map((category) =>
        reticulumCategoryDragId(category.categoryId)
      ),
    [reticulumCategoriesForSelectedGroup]
  );

  const persistReticulumChannelOrder = useCallback(
    async (channels: ReticulumGroupChannel[], categoryId: string) => {
      const normalizedCategoryId = categoryId || '';
      for (let index = 0; index < channels.length; index += 1) {
        const channel = channels[index];
        if (
          channel.position === index &&
          (channel.categoryId || '') === normalizedCategoryId
        ) {
          continue;
        }
        await publishReticulumChannelMetadata(
          'channel_reorder',
          {
            channelId: channel.channelId,
            categoryId: normalizedCategoryId,
            position: index,
          },
          { refresh: false }
        );
      }
    },
    [publishReticulumChannelMetadata]
  );

  const handleReticulumChannelDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (!isReticulumChannelAdmin || !event.over) return;
      const activeChannelId = parseReticulumChannelDragId(event.active.id);
      if (!activeChannelId) return;
      const activeChannel = reticulumChannelsForSelectedGroup.find(
        (channel) => channel.channelId === activeChannelId
      );
      if (!activeChannel) return;

      const categoryIds = new Set(
        reticulumCategoriesForSelectedGroup.map((category) => category.categoryId)
      );
      const sourceCategoryId =
        activeChannel.categoryId && categoryIds.has(activeChannel.categoryId)
          ? activeChannel.categoryId
          : '';
      const overChannelId = parseReticulumChannelDragId(event.over.id);
      const overChannel = overChannelId
        ? reticulumChannelsForSelectedGroup.find(
            (channel) => channel.channelId === overChannelId
          )
        : null;
      const targetCategoryId = overChannel
        ? overChannel.categoryId && categoryIds.has(overChannel.categoryId)
          ? overChannel.categoryId
          : ''
        : parseReticulumCategoryDropId(event.over.id);
      if (targetCategoryId && !categoryIds.has(targetCategoryId)) return;

      const sourceChannels = [
        ...(reticulumChannelsByCategory.get(sourceCategoryId) ?? []),
      ];
      const targetChannels = [
        ...(reticulumChannelsByCategory.get(targetCategoryId) ?? []),
      ];
      const sourceIndex = sourceChannels.findIndex(
        (channel) => channel.channelId === activeChannelId
      );
      if (sourceIndex < 0) return;

      if (sourceCategoryId === targetCategoryId) {
        const targetIndex = overChannel
          ? targetChannels.findIndex(
              (channel) => channel.channelId === overChannel.channelId
            )
          : targetChannels.length - 1;
        if (targetIndex < 0 || sourceIndex === targetIndex) return;
        await persistReticulumChannelOrder(
          arrayMove(sourceChannels, sourceIndex, targetIndex),
          sourceCategoryId
        );
      } else {
        const [movedChannel] = sourceChannels.splice(sourceIndex, 1);
        const targetIndex = overChannel
          ? targetChannels.findIndex(
              (channel) => channel.channelId === overChannel.channelId
            )
          : targetChannels.length;
        targetChannels.splice(Math.max(0, targetIndex), 0, movedChannel);
        await persistReticulumChannelOrder(sourceChannels, sourceCategoryId);
        await persistReticulumChannelOrder(targetChannels, targetCategoryId);
      }
      await refreshReticulumChannels();
    },
    [
      isReticulumChannelAdmin,
      persistReticulumChannelOrder,
      refreshReticulumChannels,
      reticulumCategoriesForSelectedGroup,
      reticulumChannelsForSelectedGroup,
      reticulumChannelsByCategory,
    ]
  );

  const persistReticulumCategoryOrder = useCallback(
    async (categories: ReticulumGroupCategory[]) => {
      for (let index = 0; index < categories.length; index += 1) {
        const category = categories[index];
        if (category.position === index) continue;
        await publishReticulumChannelMetadata(
          'category_update',
          {
            categoryId: category.categoryId,
            name: category.name,
            position: index,
          },
          { refresh: false }
        );
      }
    },
    [publishReticulumChannelMetadata]
  );

  const handleReticulumCategoryDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (!isReticulumChannelAdmin || !event.over) return;
      const activeCategoryId = parseReticulumCategoryDragId(event.active.id);
      const overChannelId = parseReticulumChannelDragId(event.over.id);
      const overChannel = overChannelId
        ? reticulumChannelsForSelectedGroup.find(
            (channel) => channel.channelId === overChannelId
          )
        : null;
      const overCategoryId =
        parseReticulumCategoryDragId(event.over.id) ||
        overChannel?.categoryId ||
        '';
      if (!activeCategoryId || !overCategoryId) return;
      const sourceIndex = reticulumCategoriesForSelectedGroup.findIndex(
        (category) => category.categoryId === activeCategoryId
      );
      const targetIndex = reticulumCategoriesForSelectedGroup.findIndex(
        (category) => category.categoryId === overCategoryId
      );
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return;
      }
      await persistReticulumCategoryOrder(
        arrayMove(reticulumCategoriesForSelectedGroup, sourceIndex, targetIndex)
      );
      await refreshReticulumChannels();
    },
    [
      isReticulumChannelAdmin,
      persistReticulumCategoryOrder,
      refreshReticulumChannels,
      reticulumCategoriesForSelectedGroup,
      reticulumChannelsForSelectedGroup,
    ]
  );

  const archiveReticulumChannel = useCallback(
    async (channel: ReticulumGroupChannel) => {
      if (isReticulumSystemChannelId(channel.channelId)) return;
      await publishReticulumChannelMetadata('channel_archive', {
        channelId: channel.channelId,
      });
      setSelectedReticulumChannelId(DEFAULT_RETICULUM_CHANNEL_ID);
    },
    [publishReticulumChannelMetadata]
  );

  const reticulumDeleteConfirmationChannelName =
    editingReticulumChannel?.name || editingReticulumChannel?.channelId || '';
  const isReticulumDeleteConfirmationMatched =
    Boolean(reticulumDeleteConfirmationName.trim()) &&
    reticulumDisplayNameKey(reticulumDeleteConfirmationName) ===
      reticulumDisplayNameKey(reticulumDeleteConfirmationChannelName);

  const returnToReticulumChannelSettings = useCallback(() => {
    if (isDeletingReticulumChannel) return;
    setReticulumChannelSettingsView('settings');
    setReticulumDeleteConfirmationName('');
    setReticulumDeleteConfirmationError('');
    requestAnimationFrame(() => {
      reticulumRemoveChannelButtonRef.current?.focus();
    });
  }, [isDeletingReticulumChannel]);

  const openReticulumDeleteConfirmation = useCallback(() => {
    if (!editingReticulumChannel || isDeletingReticulumChannel) return;
    setReticulumDeleteConfirmationName('');
    setReticulumDeleteConfirmationError('');
    setReticulumChannelSettingsView('confirm-delete');
  }, [editingReticulumChannel, isDeletingReticulumChannel]);

  const confirmReticulumChannelDeletion = useCallback(async () => {
    if (
      !editingReticulumChannel ||
      !isReticulumDeleteConfirmationMatched ||
      isDeletingReticulumChannel
    ) {
      return;
    }

    setReticulumDeleteConfirmationError('');
    setIsDeletingReticulumChannel(true);
    try {
      await archiveReticulumChannel(editingReticulumChannel);
      closeReticulumChannelSettings();
    } catch (error) {
      setReticulumDeleteConfirmationError(
        error instanceof Error && error.message
          ? error.message
          : 'Unable to delete channel'
      );
    } finally {
      setIsDeletingReticulumChannel(false);
    }
  }, [
    archiveReticulumChannel,
    closeReticulumChannelSettings,
    editingReticulumChannel,
    isDeletingReticulumChannel,
    isReticulumDeleteConfirmationMatched,
  ]);

  const handleReticulumChannelSettingsDialogClose = useCallback(() => {
    if (isDeletingReticulumChannel) return;
    if (reticulumChannelSettingsView === 'confirm-delete') {
      returnToReticulumChannelSettings();
      return;
    }
    closeReticulumChannelSettings();
  }, [
    closeReticulumChannelSettings,
    isDeletingReticulumChannel,
    reticulumChannelSettingsView,
    returnToReticulumChannelSettings,
  ]);

  useEffect(() => {
    if (
      !reticulumChannelSettingsOpen ||
      reticulumChannelSettingsView !== 'confirm-delete'
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      reticulumDeleteConfirmationInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [reticulumChannelSettingsOpen, reticulumChannelSettingsView]);

  const renderReticulumChannelButton = (channel: ReticulumGroupChannel) => {
    const selected = channel.channelId === selectedReticulumChannelId;
    const channelSummary = reticulumChannelSummariesById.get(channel.channelId);
    const unreadCount = Math.max(0, Number(channelSummary?.unreadCount) || 0);
    const mentionCount = Math.max(0, Number(channelSummary?.mentionCount) || 0);
    const hasUnreadMention =
      channelSummary?.hasUnreadMention === true || mentionCount > 0;
    return (
      <ReticulumSortableChannelButton
        key={channel.channelId}
        channel={channel}
        hasUnreadMention={hasUnreadMention}
        isAdmin={isReticulumChannelAdmin}
        mentionCount={mentionCount}
        onSelect={(channelId) => {
          if (channelId === selectedReticulumChannelId) return;
          setSelectedReticulumChannelId(channelId);
          setMessages([]);
          setChatReferences({});
          appliedReticulumEventIdsRef.current.clear();
        }}
        onSettings={openReticulumChannelSettings}
        selected={selected}
        unreadCount={unreadCount}
      />
    );
  };

  const selectedReticulumChannelName =
    selectedReticulumChannel?.name || selectedReticulumChannelId;
  const selectedReticulumChannelTypeOption = reticulumChannelTypeOptionByAccess(
    reticulumChannelAccessFromModes(
      selectedReticulumChannel?.writeMode,
      selectedReticulumChannel?.readMode
    )
  );
  const SelectedReticulumChannelTypeIcon =
    selectedReticulumChannelTypeOption.icon;
  const newReticulumChannelNormalizedName = normalizeReticulumDisplayName(
    newReticulumChannelName
  );
  const isNewReticulumChannelNameValid = Boolean(
    newReticulumChannelNormalizedName
  );
  const handleReticulumChannelTypeKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
    currentIndex: number,
    target: 'create' | 'settings' = 'create'
  ) => {
    const selectAccessMode =
      target === 'settings'
        ? setReticulumChannelAccessMode
        : setNewReticulumChannelAccessMode;
    const elementIdPrefix =
      target === 'settings'
        ? 'reticulum-channel-settings-type'
        : 'reticulum-channel-type';
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      selectAccessMode(reticulumChannelTypeOptions[currentIndex].value);
      return;
    }
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'ArrowDown'
    ) {
      return;
    }
    event.preventDefault();
    const direction =
      event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const nextIndex =
      (currentIndex + direction + reticulumChannelTypeOptions.length) %
      reticulumChannelTypeOptions.length;
    selectAccessMode(reticulumChannelTypeOptions[nextIndex].value);
    requestAnimationFrame(() => {
      document
        .getElementById(`${elementIdPrefix}-${nextIndex}`)
        ?.focus();
    });
  };
  const reticulumHeaderActionSx = (active?: boolean, showLabel?: boolean) => ({
    alignItems: 'center',
    borderRadius: '8px',
    backgroundColor: active ? RETICULUM_ACTIVE_BLUE : 'transparent',
    color: active ? theme.palette.common.white : theme.palette.text.secondary,
    display: 'inline-flex',
    flexShrink: 0,
    fontFamily: 'Inter',
    fontSize: 12,
    fontWeight: 600,
    gap: showLabel ? 0.6 : 0,
    height: 36,
    justifyContent: 'center',
    minWidth: showLabel ? 0 : 36,
    overflow: 'hidden',
    px: showLabel ? 1 : 0,
    textAlign: 'center',
    transition: 'background-color 140ms ease, color 140ms ease',
    width: showLabel ? 'auto' : 36,
    '&:hover': {
      backgroundColor: active ? RETICULUM_ACTIVE_BLUE : theme.palette.action.hover,
      color: active ? theme.palette.common.white : theme.palette.text.primary,
    },
  }) as const;
  const renderReticulumHeaderAction = ({
    active = false,
    label,
    icon,
    onClick,
    disabled = false,
    showLabel = false,
    tooltip = '',
  }: {
    active?: boolean;
    label: string;
    icon: ReactNode;
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    disabled?: boolean;
    showLabel?: boolean;
    tooltip?: string;
  }) => {
    if (typeof onClick !== 'function') return null;
    const button = (
      <span style={{ display: 'inline-flex' }}>
        <ButtonBase
          disabled={disabled}
          onClick={onClick}
          sx={{
            ...reticulumHeaderActionSx(active, showLabel),
            opacity: disabled ? 0.45 : 1,
          }}
        >
          {icon}
          {showLabel && (
            <Box
              component="span"
              sx={{
                fontSize: 12,
                fontWeight: 600,
                lineHeight: 1.2,
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </Box>
          )}
        </ButtonBase>
      </span>
    );
    return (
      <Tooltip key={label} title={tooltip || label}>
        {button}
      </Tooltip>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flex: hide ? undefined : 1,
        flexDirection: 'column',
        height: hide ? undefined : '100%',
        left: hide && '-100000px',
        minHeight: hide ? undefined : 0,
        opacity: hide ? 0 : 1,
        padding: reticulumChatEnabled ? 0 : '10px',
        position: hide ? 'absolute' : 'relative',
        width: '100%',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          width: '100%',
        }}
      >
        {reticulumChatEnabled && (
          <Box
            sx={{
              backgroundColor: theme.palette.background.surface,
              borderRight: `1px solid ${theme.palette.divider}`,
              flexShrink: 0,
              height: '100%',
              left: { xs: reticulumChannelSidebarOpen ? 0 : '-240px', md: 0 },
              overflowY: 'auto',
              p: 0,
              position: { xs: 'absolute', md: 'relative' },
              top: 0,
              transition: { xs: 'left 0.18s ease', md: 'none' },
              width: { xs: 224, md: 220 },
              zIndex: { xs: 9, md: 'auto' },
            }}
          >
            <Box
              sx={{
                alignItems: 'center',
                borderBottom: `1px solid ${alpha(theme.palette.divider, 0.72)}`,
                display: 'flex',
                gap: 1,
                justifyContent: 'space-between',
                minHeight: 50,
                px: '10px',
                py: 0,
              }}
            >
              <ContextMenu
                getUserSettings={() => Promise.resolve()}
                groupId={selectedGroup}
                myAddress={myAddress}
                openOnClick
                reticulumGroup={{
                  groupId: selectedGroup,
                  groupName: selectedGroupName,
                  isOwner: isGroupOwner,
                }}
                showGroupInfo={false}
                showStandardActions={false}
              >
                <Tooltip title={selectedGroupName || 'Group'}>
                  <Box
                    sx={{
                      alignItems: 'center',
                      color: 'text.primary',
                      cursor: 'pointer',
                      display: 'flex',
                      gap: 0.5,
                      minWidth: 0,
                      px: 0.25,
                    }}
                  >
                    {isPrivate && (
                      <Tooltip title="Private Encrypted Group">
                        <LockRoundedIcon
                          sx={{
                            color: 'text.secondary',
                            flexShrink: 0,
                            fontSize: 15,
                            transition: 'color 140ms ease',
                            '&:hover': { color: 'text.primary' },
                          }}
                        />
                      </Tooltip>
                    )}
                    <Typography
                      sx={{
                        color: 'inherit',
                        flex: 1,
                        fontSize: 15,
                        fontWeight: 800,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {selectedGroupName || 'Group'}
                    </Typography>
                    <ExpandMoreRoundedIcon
                      sx={{ color: 'text.secondary', flexShrink: 0, fontSize: 17 }}
                    />
                  </Box>
                </Tooltip>
              </ContextMenu>
              {isReticulumChannelAdmin && (
                <Tooltip title="Create category">
                  <IconButton
                    size="small"
                    onClick={openCreateReticulumCategoryDialog}
                    sx={{ color: 'text.secondary', p: 0.5 }}
                  >
                    <CategoryOutlinedIcon sx={{ fontSize: 17 }} />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
            <Box
              sx={{
                alignItems: 'center',
                display: 'flex',
                justifyContent: 'space-between',
                mb: 1,
                mt: 1.5,
                px: '10px',
              }}
            >
              <Typography
                sx={{
                  color: 'text.secondary',
                  fontSize: 11,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                }}
              >
                Channels
              </Typography>
              {isReticulumChannelAdmin && (
                <Tooltip title="Create channel">
                  <IconButton
                    size="small"
                    onClick={() => openCreateReticulumChannelDialog()}
                    sx={{ color: 'text.secondary', p: 0.5 }}
                  >
                    <AddIcon sx={{ fontSize: 17 }} />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
            <DndContext
              collisionDetection={closestCenter}
              onDragEnd={(event) => {
                if (parseReticulumCategoryDragId(event.active.id)) {
                  void handleReticulumCategoryDragEnd(event);
                  return;
                }
                void handleReticulumChannelDragEnd(event);
              }}
              sensors={reticulumChannelDndSensors}
            >
              <SortableContext
                items={reticulumChannelDragItems}
                strategy={verticalListSortingStrategy}
              >
                <Box sx={{ px: '10px' }}>
                <ReticulumCategoryDropZone
                  disabled={!isReticulumChannelAdmin}
                  id={reticulumCategoryDropId('')}
                >
                  {(reticulumChannelsByCategory.get('') ?? []).map(
                    renderReticulumChannelButton
                  )}
                </ReticulumCategoryDropZone>
                <SortableContext
                  items={reticulumCategoryDragItems}
                  strategy={verticalListSortingStrategy}
                >
                  {reticulumCategoriesForSelectedGroup.map((category) => {
                    const channels =
                      reticulumChannelsByCategory.get(category.categoryId) ?? [];
                    return (
                      <ReticulumSortableCategory
                        category={category}
                        isAdmin={isReticulumChannelAdmin}
                        isCollapsed={collapsedReticulumCategoryIds.has(
                          category.categoryId
                        )}
                        key={category.categoryId}
                        onContextMenu={openReticulumCategoryContextMenu}
                        onCreateChannel={openCreateReticulumChannelDialog}
                        onToggleCollapsed={toggleReticulumCategoryCollapsed}
                      >
                        {channels.map(renderReticulumChannelButton)}
                      </ReticulumSortableCategory>
                    );
                  })}
                </SortableContext>
                </Box>
              </SortableContext>
            </DndContext>
            <Menu
              open={Boolean(reticulumCategoryMenuPosition)}
              onClose={closeReticulumCategoryContextMenu}
              anchorReference="anchorPosition"
              anchorPosition={
                reticulumCategoryMenuPosition
                  ? {
                      left: reticulumCategoryMenuPosition.mouseX,
                      top: reticulumCategoryMenuPosition.mouseY,
                    }
                  : undefined
              }
            >
              <MenuItem
                onClick={() => {
                  if (reticulumCategoryMenuCategory) {
                    openRenameReticulumCategoryDialog(
                      reticulumCategoryMenuCategory
                    );
                  }
                  closeReticulumCategoryContextMenu();
                }}
              >
                <ListItemIcon>
                  <DriveFileRenameOutlineRoundedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Rename category</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  if (reticulumCategoryMenuCategory) {
                    void deleteReticulumCategory(reticulumCategoryMenuCategory);
                  }
                  closeReticulumCategoryContextMenu();
                }}
              >
                <ListItemIcon>
                  <DeleteOutlineRoundedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Delete category</ListItemText>
              </MenuItem>
            </Menu>
          </Box>
        )}

        {reticulumChatEnabled && reticulumChannelSidebarOpen && (
          <Box
            onClick={() => setReticulumChannelSidebarOpen(false)}
            sx={{
              backgroundColor: alpha(theme.palette.common.black, 0.38),
              bottom: 0,
              display: { xs: 'block', md: 'none' },
              left: 0,
              position: 'absolute',
              right: 0,
              top: 0,
              zIndex: 8,
            }}
          />
        )}

        <Box
          sx={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            minHeight: 0,
            minWidth: 0,
          }}
        >
          {reticulumChatEnabled && (
            <Box
              sx={{
                alignItems: 'center',
                borderBottom: `1px solid ${theme.palette.divider}`,
                display: 'flex',
                flexWrap: 'nowrap',
                flexShrink: 0,
                gap: 0.75,
                minHeight: 50,
                overflow: 'hidden',
                px: 1.5,
              }}
            >
              <Tooltip title="Channels">
                <IconButton
                  onClick={() =>
                    setReticulumChannelSidebarOpen((open) => !open)
                  }
                  size="small"
                  sx={{
                    color: 'text.secondary',
                    display: { xs: 'inline-flex', md: 'none' },
                    flexShrink: 0,
                  }}
                >
                  <TagRoundedIcon sx={{ fontSize: 20 }} />
                </IconButton>
              </Tooltip>
              <Box
                sx={{
                  alignItems: 'center',
                  display: 'flex',
                  flex: 1,
                  gap: 0.75,
                  fontSize: 17,
                  fontWeight: 700,
                  minWidth: 0,
                  overflow: 'hidden',
                }}
              >
                <SelectedReticulumChannelTypeIcon
                  aria-hidden
                  sx={{
                    color: theme.palette.text.secondary,
                    flexShrink: 0,
                    fontSize: 18,
                  }}
                />
                <Box
                  component="span"
                  sx={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {selectedReticulumChannelName}
                </Box>
                {selectedReticulumChannel?.description && (
                  <Box
                    component="span"
                    sx={{
                      color: theme.palette.text.secondary,
                      display: { xs: 'none', lg: 'inline' },
                      fontSize: 13,
                      fontWeight: 400,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {selectedReticulumChannel.description}
                  </Box>
                )}
              </Box>
              <Box
                sx={{
                  alignItems: 'center',
                  display: 'flex',
                  flexShrink: 0,
                  gap: 0.25,
                  minWidth: 0,
                  ml: 'auto',
                  overflowX: 'auto',
                }}
              >
                {renderReticulumHeaderAction({
                  label: 'Qortal Land',
                  icon: <SportsEsportsIcon sx={{ fontSize: 19 }} />,
                  onClick: onQortalLandClick,
                  showLabel: true,
                })}
                {renderReticulumHeaderAction({
                  active: true,
                  label: 'Chat',
                  icon: <ChatRoundedIcon sx={{ fontSize: 19 }} />,
                  onClick: () => undefined,
                  showLabel: true,
                })}
                {renderReticulumHeaderAction({
                  label: groupCallJoining
                    ? 'Joining'
                    : groupCallInCall
                      ? 'Leave call'
                      : 'Group Call',
                  icon: groupCallJoining ? (
                    <CircularProgress size={17} sx={{ color: 'inherit' }} />
                  ) : groupCallInCall ? (
                    <CallEndRoundedIcon sx={{ fontSize: 19 }} />
                  ) : (
                    <CallIcon sx={{ fontSize: 19 }} />
                  ),
                  onClick: onGroupCallClick,
                  disabled: groupCallDisabled || groupCallJoining,
                  showLabel: true,
                  tooltip: groupCallTooltip,
                })}
                <Box
                  aria-hidden
                  sx={{
                    backgroundColor: theme.palette.divider,
                    flexShrink: 0,
                    height: 22,
                    mx: 0.5,
                    width: '1px',
                  }}
                />
                {renderReticulumHeaderAction({
                  label: 'Announcements',
                  icon: (
                    <ReticulumMegaphoneIcon
                      sx={{
                        color: hasUnreadAnnouncements
                          ? theme.palette.other.unread
                          : 'inherit',
                        fontSize: 20,
                      }}
                    />
                  ),
                  onClick: onAnnouncementsClick,
                })}
                {renderReticulumHeaderAction({
                  label: 'Threads',
                  icon: <ForumRoundedIcon sx={{ fontSize: 19 }} />,
                  onClick: onThreadsClick,
                })}
                {renderReticulumHeaderAction({
                  label: 'Admins',
                  icon: <SecurityRoundedIcon sx={{ fontSize: 19 }} />,
                  onClick: onAdminsClick,
                })}
                {renderReticulumHeaderAction({
                  label: 'Q-Manager',
                  icon: <FolderRoundedIcon sx={{ fontSize: 19 }} />,
                  onClick: openQManager,
                })}
                <Tooltip title={membersPanelOpen ? 'Hide members' : 'Members'}>
                  <IconButton
                    onClick={onMembersClick}
                    size="small"
                    sx={{
                      backgroundColor: membersPanelOpen
                        ? RETICULUM_ACTIVE_BLUE
                        : 'transparent',
                      borderRadius: '8px',
                      color: membersPanelOpen ? 'common.white' : 'text.secondary',
                      flexShrink: 0,
                      height: 36,
                      width: 36,
                      '&:hover': {
                        backgroundColor: membersPanelOpen
                          ? RETICULUM_ACTIVE_BLUE
                          : theme.palette.action.hover,
                        color: membersPanelOpen
                          ? 'common.white'
                          : theme.palette.text.primary,
                      },
                    }}
                  >
                    <PeopleAltRoundedIcon sx={{ fontSize: 19 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Search chat">
                  <IconButton
                    onClick={() => setReticulumSearchOpen(true)}
                    size="small"
                    sx={{
                      color: 'text.secondary',
                      flexShrink: 0,
                      height: 36,
                      width: 36,
                      '&:hover': {
                        backgroundColor: theme.palette.action.hover,
                        color: theme.palette.text.primary,
                      },
                    }}
                  >
                    <SearchRoundedIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
          )}
          <ChatList
            chatId={
              reticulumChatEnabled
                ? `${selectedGroup}:${selectedReticulumChannelId}`
                : selectedGroup
            }
            chatReferences={chatReferences}
            enableMentions
            handleReaction={handleReaction}
            hasSecretKey={!!secretKey}
            initialMessages={messages}
            isPrivate={isPrivate}
            members={members}
            myAddress={myAddress}
            myName={myName}
            hasOlderMessages={
              reticulumChatEnabled ? reticulumHasOlderMessages : undefined
            }
            isLoadingOlderMessages={
              reticulumChatEnabled ? reticulumLoadingOlderMessages : undefined
            }
            onLoadOlder={
              reticulumChatEnabled ? loadOlderReticulumMessages : undefined
            }
            onDelete={onDelete}
            onEdit={onEdit}
            onReply={onReply}
            openQManager={openQManager}
            reticulumChatEnabled={reticulumChatEnabled}
            selectedGroup={selectedGroup}
            secretKeyObject={secretKey}
            tempChatReferences={tempChatReferences}
            tempMessages={tempMessages}
            scrollToMessageId={reticulumSearchScrollTarget?.messageId}
            scrollToMessageNonce={reticulumSearchScrollTarget?.nonce}
          />

          {reticulumTypingText && (
            <Typography
              sx={{
                color: theme.palette.text.secondary,
                flexShrink: 0,
                fontSize: '12px',
                minHeight: '18px',
                px: 2,
                py: 0.5,
              }}
            >
              {reticulumTypingText}
            </Typography>
          )}

          {(reticulumChatEnabled || !!secretKey || isPrivate === false) && (
            <Box
              sx={{
                alignItems: reticulumChatEnabled ? 'center' : 'flex-end',
                backgroundColor: reticulumChatEnabled
                  ? alpha(theme.palette.background.paper, 0.72)
                  : theme.palette.background.default,
                border: `1px solid ${theme.palette.divider}`,
                borderRadius: reticulumChatEnabled ? 0 : '8px',
                borderLeft: reticulumChatEnabled ? 'none' : undefined,
                borderRight: reticulumChatEnabled ? 'none' : undefined,
                borderBottom: reticulumChatEnabled ? 'none' : undefined,
                bottom: isFocusedParent ? '0px' : 'unset',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'row',
                flexShrink: 0,
                gap: reticulumChatEnabled ? '8px' : '12px',
                minHeight: reticulumChatEnabled ? '58px' : '150px',
                overflow: 'hidden',
                padding: reticulumChatEnabled ? '8px 12px' : '16px 20px 20px',
                position: isFocusedParent ? 'fixed' : 'relative',
                top: isFocusedParent ? '0px' : 'unset',
                width: '100%',
                zIndex: isFocusedParent ? 5 : 'unset',
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  flex: 1,
                  flexShrink: 0,
                  justifyContent: reticulumChatEnabled ? 'center' : 'flex-end',
                  minWidth: 0,
                  overflow: reticulumChatEnabled ? 'visible' : 'auto',
                }}
              >
                <Box
                  sx={{
                    alignItems: 'flex-start',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '10px',
                    width: '100%',
                  }}
                >
                  {!isDeleteImage &&
                    onEditMessage &&
                    messageHasImage(onEditMessage) &&
                    onEditMessage?.images?.map((_, index) => (
                      <div
                        key={index}
                        style={{
                          height: '50px',
                          position: 'relative',
                          width: '50px',
                        }}
                      >
                        <ImageIcon
                          color="primary"
                          sx={{
                            borderRadius: '3px',
                            height: '100%',
                            width: '100%',
                          }}
                        />

                        <Tooltip title="Delete image">
                          <IconButton
                            onClick={() => setIsDeleteImage(true)}
                            size="small"
                            sx={{
                              position: 'absolute',
                              top: '50%',
                              left: '50%',
                              transform: 'translate(-50%, -50%)',
                              backgroundColor: (theme) =>
                                theme.palette.background.paper,
                              color: (theme) => theme.palette.text.primary,
                              borderRadius: '50%',
                              opacity: 0,
                              transition: 'opacity 0.2s',
                              boxShadow: (theme) => theme.shadows[2],
                              '&:hover': {
                                backgroundColor: (theme) =>
                                  theme.palette.background.default,
                                opacity: 1,
                              },
                              pointerEvents: 'auto',
                            }}
                          >
                            <CloseIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </div>
                    ))}

                  {chatImagesToSave.map((imgBase64, index) => (
                    <div
                      key={index}
                      style={{
                        height: '50px',
                        position: 'relative',
                        width: '50px',
                      }}
                    >
                      <img
                        src={`data:image/webp;base64,${imgBase64}`}
                        style={{
                          height: '100%',
                          width: '100%',
                          objectFit: 'contain',
                          borderRadius: '3px',
                        }}
                      />

                      <Tooltip title="Remove image">
                        <IconButton
                          onClick={() =>
                            setChatImagesToSave((prev) =>
                              prev.filter((_, i) => i !== index)
                            )
                          }
                          size="small"
                          sx={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            backgroundColor: (theme) =>
                              theme.palette.background.paper,
                            color: (theme) => theme.palette.text.primary,
                            borderRadius: '50%',
                            opacity: 0,
                            transition: 'opacity 0.2s',
                            boxShadow: (theme) => theme.shadows[2],
                            '&:hover': {
                              backgroundColor: (theme) =>
                                theme.palette.background.default,
                              opacity: 1,
                            },
                            pointerEvents: 'auto',
                          }}
                        >
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </div>
                  ))}

                  {pendingReticulumFiles.map((file, index) => (
                    <Box
                      key={`${file.fileName}-${index}`}
                      sx={{
                        alignItems: 'center',
                        border: '1px solid',
                        borderColor: theme.palette.divider,
                        borderRadius: '8px',
                        display: 'flex',
                        gap: '8px',
                        maxWidth: 260,
                        minHeight: '50px',
                        p: '6px 8px',
                        position: 'relative',
                      }}
                    >
                      {file.isImage && file.previewUrl ? (
                        <Box
                          component="img"
                          src={file.previewUrl}
                          sx={{
                            borderRadius: '4px',
                            flexShrink: 0,
                            height: 38,
                            objectFit: 'cover',
                            width: 38,
                          }}
                        />
                      ) : (
                        <InsertDriveFileRoundedIcon
                          sx={{
                            color: theme.palette.text.secondary,
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <Box sx={{ minWidth: 0 }}>
                        <Typography
                          sx={{
                            fontSize: '12px',
                            fontWeight: 600,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {file.fileName}
                        </Typography>
                        <Typography
                          sx={{
                            color: theme.palette.text.secondary,
                            fontSize: '11px',
                          }}
                        >
                          {file.mimeType || 'application/octet-stream'}
                        </Typography>
                      </Box>
                      <Tooltip title="Remove file">
                        <IconButton
                          onClick={() => {
                            setPendingReticulumFiles((prev) => {
                              const removed = prev[index];
                              if (removed?.previewUrl) {
                                URL.revokeObjectURL(removed.previewUrl);
                              }
                              return prev.filter((_, i) => i !== index);
                            });
                          }}
                          size="small"
                          sx={{
                            ml: 'auto',
                            flexShrink: 0,
                          }}
                        >
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  ))}
                </Box>

                {replyMessage && (
                  <Box
                    sx={{
                      alignItems: 'flex-start',
                      display: 'flex',
                      gap: '5px',
                      width: '100%',
                    }}
                  >
                    <ReplyPreview message={replyMessage} />

                    <ButtonBase
                      onClick={() => {
                        setReplyMessage(null);

                        setOnEditMessage(null);
                        setIsDeleteImage(false);
                        setChatImagesToSave([]);
                        clearPendingReticulumFiles();
                      }}
                    >
                      <ExitIcon />
                    </ButtonBase>
                  </Box>
                )}

                {onEditMessage && (
                  <Box
                    sx={{
                      alignItems: 'flex-start',
                      display: 'flex',
                      gap: '5px',
                      width: '100%',
                    }}
                  >
                    <ReplyPreview isEdit message={onEditMessage} />

                    <ButtonBase
                      onClick={() => {
                        setReplyMessage(null);
                        setOnEditMessage(null);
                        setIsDeleteImage(false);
                        setChatImagesToSave([]);
                        clearPendingReticulumFiles();
                        clearEditorContent();
                      }}
                    >
                      <ExitIcon />
                    </ButtonBase>
                  </Box>
                )}

                <Tiptap
                  enableMentions
                  setEditorRef={setEditorRef}
                  onEnter={sendMessage}
                  onKeyDown={handleComposerKeyDown}
                  onContentUpdate={(editor) => {
                    noteReticulumComposerActivity(
                      Boolean(editor.getText().trim())
                    );
                  }}
                  isChat
                  disableEnter={!canWriteSelectedReticulumChannel}
                  isFocusedParent={isFocusedParent}
                  setIsFocusedParent={setIsFocusedParent}
                  membersWithNames={members}
                  insertImage={insertImage}
                  insertFiles={insertFiles}
                  compactChat={reticulumChatEnabled}
                  placeholder={
                    reticulumChatEnabled
                      ? `Message ${selectedReticulumChannelName}`
                      : undefined
                  }
                />
                {!canWriteSelectedReticulumChannel && (
                  <Typography
                    sx={{
                      color: theme.palette.text.secondary,
                      fontSize: '12px',
                    }}
                  >
                    Only group admins can write in this channel.
                  </Typography>
                )}
                {messageSize > MESSAGE_LIMIT_WARNING && (
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'flex-start',
                      position: 'relative',
                      width: '100%',
                    }}
                  >
                    <Typography
                      sx={{
                        fontSize: '12px',
                        color:
                          messageSize > MAX_SIZE_MESSAGE
                            ? theme.palette.other.danger
                            : 'unset',
                      }}
                    >
                      {t('core:message.error.message_size', {
                        maximum: MAX_SIZE_MESSAGE,
                        size: messageSize,
                        postProcess: 'capitalizeFirstChar',
                      })}
                    </Typography>
                  </Box>
                )}
              </Box>

              <Box
                sx={{
                  flexShrink: 0,
                  paddingBottom: reticulumChatEnabled ? 0 : '2px',
                }}
              >
                <CustomButton
                  onClick={() => {
                    if (isSending || !canWriteSelectedReticulumChannel) return;
                    sendMessage();
                  }}
                  sx={{
                    alignItems: 'center',
                    backgroundColor:
                      isSending || !canWriteSelectedReticulumChannel
                        ? theme.palette.action.disabledBackground
                        : reticulumChatEnabled
                          ? RETICULUM_ACTIVE_BLUE
                          : theme.palette.background.paper,
                    border: '1px solid',
                    borderColor: reticulumChatEnabled
                      ? RETICULUM_ACTIVE_BLUE
                      : theme.palette.divider,
                    borderRadius: '8px',
                    color: reticulumChatEnabled
                      ? theme.palette.common.white
                      : theme.palette.text.primary,
                    cursor:
                      isSending || !canWriteSelectedReticulumChannel
                        ? 'default'
                        : 'pointer',
                    display: 'inline-flex',
                    gap: '6px',
                    fontSize: '14px',
                    fontWeight: 500,
                    justifyContent: 'center',
                    minHeight: reticulumChatEnabled ? '38px' : '44px',
                    minWidth: reticulumChatEnabled ? '74px' : '88px',
                    padding: reticulumChatEnabled ? '8px 14px' : '10px 16px',
                    position: 'relative',
                    transition:
                      'background-color 0.2s ease, border-color 0.2s ease',
                    '&:hover': isSending || !canWriteSelectedReticulumChannel
                      ? {}
                      : {
                          backgroundColor: reticulumChatEnabled
                            ? '#1e40af'
                            : theme.palette.action.hover,
                          borderColor: reticulumChatEnabled
                            ? '#1e40af'
                            : theme.palette.divider,
                        },
                    '& .MuiSvgIcon-root': {
                      color: reticulumChatEnabled
                        ? theme.palette.common.white
                        : 'inherit',
                    },
                  }}
                >
                  {isSending ? (
                    <CircularProgress
                      size={18}
                      sx={{
                        color: reticulumChatEnabled
                          ? theme.palette.common.white
                          : theme.palette.text.secondary,
                      }}
                    />
                  ) : (
                    <>
                      <SendIcon sx={{ fontSize: '18px' }} />
                      Send
                    </>
                  )}
                </CustomButton>
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      {reticulumChatEnabled && reticulumSearchOpen && (
        <Portal>
          <Box
            sx={{
              backgroundColor: theme.palette.background.paper,
              borderLeft: `1px solid ${theme.palette.divider}`,
              bottom: 0,
              boxShadow: theme.shadows[8],
              display: 'flex',
              flexDirection: 'column',
              position: 'fixed',
              right: 0,
              top: appHeighOffsetPx,
              width: { xs: '100vw', sm: 430 },
              zIndex: 1300,
            }}
          >
            <Box
              sx={{
                alignItems: 'center',
                borderBottom: `1px solid ${theme.palette.divider}`,
                display: 'flex',
                gap: 1,
                p: 2,
              }}
            >
              <SearchRoundedIcon sx={{ color: theme.palette.text.secondary }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: 16, fontWeight: 800 }}>
                  Search Results
                </Typography>
              </Box>
              <IconButton
                onClick={() => setReticulumSearchOpen(false)}
                size="small"
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 1.5,
                p: 2,
              }}
            >
              <TextField
                autoFocus
                fullWidth
                onChange={(event) => setReticulumSearchQuery(event.target.value)}
                placeholder={`Search ${
                  reticulumSearchChannelFilter ===
                  RETICULUM_SEARCH_CHANNEL_CURRENT
                    ? reticulumSearchChannelFilterLabel
                    : 'messages'
                }`}
                size="small"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    backgroundColor: alpha(theme.palette.common.black, 0.24),
                    borderRadius: '4px',
                    fontSize: 14,
                    height: 40,
                    '& fieldset': {
                      borderColor: alpha(theme.palette.common.white, 0.16),
                    },
                    '&:hover fieldset': {
                      borderColor: alpha(theme.palette.primary.main, 0.55),
                    },
                    '&.Mui-focused fieldset': {
                      borderColor: theme.palette.primary.main,
                    },
                  },
                }}
                value={reticulumSearchQuery}
              />
              {reticulumSearchActiveFilterCount > 0 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                  {reticulumSearchChannelFilter !==
                    RETICULUM_SEARCH_CHANNEL_CURRENT && (
                    <Chip
                      label={`in: ${reticulumSearchChannelFilterLabel}`}
                      onDelete={() =>
                        setReticulumSearchChannelFilter(
                          RETICULUM_SEARCH_CHANNEL_CURRENT
                        )
                      }
                      size="small"
                      sx={{
                        backgroundColor: alpha(theme.palette.primary.main, 0.18),
                        borderRadius: '4px',
                        color: theme.palette.primary.light,
                        height: 24,
                      }}
                    />
                  )}
                  {reticulumSearchAuthorFilter && (
                    <Chip
                      label={`from: ${reticulumSearchAuthorFilterLabel}`}
                      onDelete={() => setReticulumSearchAuthorFilter('')}
                      size="small"
                      sx={{
                        backgroundColor: alpha(theme.palette.primary.main, 0.18),
                        borderRadius: '4px',
                        color: theme.palette.primary.light,
                        height: 24,
                      }}
                    />
                  )}
                  {reticulumSearchHasFilter !== RETICULUM_SEARCH_HAS_ANY && (
                    <Chip
                      label={`has: ${reticulumSearchHasFilterLabel}`}
                      onDelete={() =>
                        setReticulumSearchHasFilter(RETICULUM_SEARCH_HAS_ANY)
                      }
                      size="small"
                      sx={{
                        backgroundColor: alpha(theme.palette.primary.main, 0.18),
                        borderRadius: '4px',
                        color: theme.palette.primary.light,
                        height: 24,
                      }}
                    />
                  )}
                  {(reticulumSearchAfterDate ||
                    reticulumSearchBeforeDate) && (
                    <Chip
                      label={`date: ${reticulumSearchDateFilterLabel}`}
                      onDelete={() => {
                        setReticulumSearchAfterDate('');
                        setReticulumSearchBeforeDate('');
                      }}
                      size="small"
                      sx={{
                        backgroundColor: alpha(theme.palette.primary.main, 0.18),
                        borderRadius: '4px',
                        color: theme.palette.primary.light,
                        height: 24,
                      }}
                    />
                  )}
                  {reticulumSearchSort !== 'relevance' && (
                    <Chip
                      label={`sort: ${reticulumSearchSortLabel}`}
                      onDelete={() => setReticulumSearchSort('relevance')}
                      size="small"
                      sx={{
                        backgroundColor: alpha(theme.palette.primary.main, 0.18),
                        borderRadius: '4px',
                        color: theme.palette.primary.light,
                        height: 24,
                      }}
                    />
                  )}
                </Box>
              )}
              <Box>
                <Box
                  sx={{
                    alignItems: 'center',
                    display: 'flex',
                    justifyContent: 'space-between',
                    mb: 0.75,
                  }}
                >
                  <Typography
                    sx={{
                      color: theme.palette.text.secondary,
                      fontSize: 11,
                      fontWeight: 800,
                      letterSpacing: 0.4,
                      textTransform: 'uppercase',
                    }}
                  >
                    Filter By
                  </Typography>
                  {reticulumSearchActiveFilterCount > 0 && (
                    <Button
                      onClick={clearReticulumSearchFilters}
                      size="small"
                      sx={{ fontSize: 11, minWidth: 0, p: 0 }}
                      variant="text"
                    >
                      Clear
                    </Button>
                  )}
                </Box>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                  {[
                    {
                      key: 'from' as const,
                      label: 'from:',
                      value: reticulumSearchAuthorFilter
                        ? reticulumSearchAuthorFilterLabel
                        : '',
                    },
                    {
                      key: 'in' as const,
                      label: 'in:',
                      value:
                        reticulumSearchChannelFilter !==
                        RETICULUM_SEARCH_CHANNEL_CURRENT
                          ? reticulumSearchChannelFilterLabel
                          : '',
                    },
                    {
                      key: 'has' as const,
                      label: 'has:',
                      value:
                        reticulumSearchHasFilter !== RETICULUM_SEARCH_HAS_ANY
                          ? reticulumSearchHasFilterLabel
                          : '',
                    },
                    {
                      key: 'date' as const,
                      label: 'date:',
                      value:
                        reticulumSearchAfterDate || reticulumSearchBeforeDate
                          ? reticulumSearchDateFilterLabel
                          : '',
                    },
                    {
                      key: 'sort' as const,
                      label: 'sort:',
                      value:
                        reticulumSearchSort !== 'relevance'
                          ? reticulumSearchSortLabel
                          : '',
                    },
                  ].map((option) => (
                    <ButtonBase
                      key={option.key}
                      onClick={(event) =>
                        openReticulumSearchFilterMenu(option.key, event)
                      }
                      sx={{
                        alignItems: 'center',
                        backgroundColor: alpha(theme.palette.common.black, 0.12),
                        border: `1px solid ${alpha(
                          theme.palette.common.white,
                          0.12
                        )}`,
                        borderRadius: '4px',
                        display: 'flex',
                        gap: 0.5,
                        justifyContent: 'flex-start',
                        maxWidth: '100%',
                        minHeight: 28,
                        px: 0.75,
                        py: 0.35,
                        textAlign: 'left',
                        '&:hover': {
                          backgroundColor: alpha(
                            theme.palette.primary.main,
                            0.12
                          ),
                          borderColor: alpha(theme.palette.primary.main, 0.45),
                        },
                      }}
                    >
                      <Typography
                        sx={{
                          color: theme.palette.primary.main,
                          fontSize: 12,
                          fontWeight: 800,
                        }}
                      >
                        {option.label}
                      </Typography>
                      <Typography
                        sx={{
                          color: theme.palette.text.primary,
                          display: option.value ? 'block' : 'none',
                          fontSize: 12,
                          maxWidth: 142,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {option.value}
                      </Typography>
                      <ChevronRightRoundedIcon
                        sx={{
                          color: theme.palette.text.secondary,
                          fontSize: 14,
                        }}
                      />
                    </ButtonBase>
                  ))}
                </Box>
              </Box>
            </Box>
            <Menu
              anchorEl={reticulumSearchFilterAnchorEl}
              onClose={closeReticulumSearchFilterMenu}
              open={Boolean(reticulumSearchFilterAnchorEl)}
              PaperProps={{
                sx: {
                  maxHeight: 340,
                  minWidth: 260,
                },
              }}
            >
              {reticulumSearchFilterMenu === 'from' && (
                <>
                  <MenuItem
                    onClick={() => {
                      setReticulumSearchAuthorFilter('');
                      closeReticulumSearchFilterMenu();
                    }}
                  >
                    Anyone
                  </MenuItem>
                  <Divider />
                  {reticulumSearchAuthorOptions.map((author) => (
                    <MenuItem
                      key={author.address}
                      onClick={() => {
                        setReticulumSearchAuthorFilter(author.address);
                        closeReticulumSearchFilterMenu();
                      }}
                    >
                      {author.name}
                    </MenuItem>
                  ))}
                </>
              )}
              {reticulumSearchFilterMenu === 'in' && (
                <>
                  <MenuItem
                    onClick={() => {
                      setReticulumSearchChannelFilter(
                        RETICULUM_SEARCH_CHANNEL_CURRENT
                      );
                      closeReticulumSearchFilterMenu();
                    }}
                  >
                    Current channel
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      setReticulumSearchChannelFilter(
                        RETICULUM_SEARCH_CHANNEL_ALL
                      );
                      closeReticulumSearchFilterMenu();
                    }}
                  >
                    All channels
                  </MenuItem>
                  <Divider />
                  {reticulumChannelsForSelectedGroup.map((channel) => {
                    const option = reticulumChannelTypeOptionByAccess(
                      reticulumChannelAccessFromModes(
                        channel.writeMode,
                        channel.readMode
                      )
                    );
                    const ChannelIcon = option.icon;
                    return (
                      <MenuItem
                        key={channel.channelId}
                        onClick={() => {
                          setReticulumSearchChannelFilter(channel.channelId);
                          closeReticulumSearchFilterMenu();
                        }}
                      >
                        <ChannelIcon
                          aria-hidden
                          sx={{
                            color: 'text.secondary',
                            fontSize: 18,
                            mr: 1,
                          }}
                        />
                        {channel.name || channel.channelId}
                      </MenuItem>
                    );
                  })}
                </>
              )}
              {reticulumSearchFilterMenu === 'has' && (
                <>
                  {[
                    [RETICULUM_SEARCH_HAS_ANY, 'Anything'],
                    [RETICULUM_SEARCH_HAS_ATTACHMENT, 'Attachment'],
                    [RETICULUM_SEARCH_HAS_LINK, 'Link'],
                  ].map(([value, label]) => (
                    <MenuItem
                      key={value}
                      onClick={() => {
                        setReticulumSearchHasFilter(value);
                        closeReticulumSearchFilterMenu();
                      }}
                    >
                      {label}
                    </MenuItem>
                  ))}
                </>
              )}
              {reticulumSearchFilterMenu === 'sort' && (
                <>
                  {[
                    ['relevance', 'Relevant'],
                    ['newest', 'Newest'],
                    ['oldest', 'Oldest'],
                  ].map(([value, label]) => (
                    <MenuItem
                      key={value}
                      onClick={() => {
                        setReticulumSearchSort(
                          value as 'relevance' | 'newest' | 'oldest'
                        );
                        closeReticulumSearchFilterMenu();
                      }}
                    >
                      {label}
                    </MenuItem>
                  ))}
                </>
              )}
              {reticulumSearchFilterMenu === 'date' && (
                <Box sx={{ display: 'grid', gap: 1, p: 1.5, width: 280 }}>
                  <TextField
                    fullWidth
                    InputLabelProps={{ shrink: true }}
                    label="After"
                    onChange={(event) =>
                      setReticulumSearchAfterDate(event.target.value)
                    }
                    size="small"
                    type="date"
                    value={reticulumSearchAfterDate}
                  />
                  <TextField
                    fullWidth
                    InputLabelProps={{ shrink: true }}
                    label="Before"
                    onChange={(event) =>
                      setReticulumSearchBeforeDate(event.target.value)
                    }
                    size="small"
                    type="date"
                    value={reticulumSearchBeforeDate}
                  />
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Button
                      onClick={() => {
                        setReticulumSearchAfterDate('');
                        setReticulumSearchBeforeDate('');
                      }}
                      size="small"
                    >
                      Clear dates
                    </Button>
                    <Button
                      onClick={closeReticulumSearchFilterMenu}
                      size="small"
                      variant="contained"
                    >
                      Done
                    </Button>
                  </Box>
                </Box>
              )}
            </Menu>
            <Box
              sx={{
                borderTop: `1px solid ${theme.palette.divider}`,
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                p: 1,
              }}
            >
              {isReticulumSearchLoading && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                  <CircularProgress size={22} />
                </Box>
              )}
              {!isReticulumSearchLoading && reticulumSearchError && (
                <Typography
                  sx={{
                    color: theme.palette.error.main,
                    fontSize: 13,
                    px: 1,
                    py: 2,
                  }}
                >
                  {reticulumSearchError}
                </Typography>
              )}
              {!isReticulumSearchLoading &&
                !reticulumSearchError &&
                (reticulumSearchQuery.trim().length >= 2 ||
                  reticulumSearchActiveFilterCount > 0) &&
                reticulumSearchResults.length === 0 && (
                  <Typography
                    sx={{
                      color: theme.palette.text.secondary,
                      fontSize: 13,
                      px: 1,
                      py: 2,
                    }}
                  >
                    No results
                  </Typography>
                )}
              {!isReticulumSearchLoading &&
                !reticulumSearchError &&
                reticulumSearchQuery.trim().length < 2 &&
                reticulumSearchActiveFilterCount === 0 && (
                  <Typography
                    sx={{
                      color: theme.palette.text.secondary,
                      fontSize: 13,
                      px: 1,
                      py: 2,
                    }}
                  >
                    Type at least 2 characters or choose a filter.
                  </Typography>
                )}
              {reticulumSearchResults.map((result) => {
                const event = result.event;
                const channelId =
                  normalizeReticulumChannelName(event.channelId || '') ||
                  DEFAULT_RETICULUM_CHANNEL_ID;
                const channelName =
                  reticulumVisibleChannelNameById.get(channelId) || channelId;
                const searchResultChannel = reticulumChannelsForSelectedGroup.find(
                  (channel) => channel.channelId === channelId
                );
                const searchResultChannelOption =
                  reticulumChannelTypeOptionByAccess(
                    reticulumChannelAccessFromModes(
                      searchResultChannel?.writeMode,
                      searchResultChannel?.readMode
                    )
                  );
                const SearchResultChannelIcon =
                  searchResultChannelOption.icon;
                const authorName = reticulumSearchAuthorName(event);
                const timestamp = Number(event.timestamp || 0);
                const attachmentNames = reticulumAttachmentNamesFromPayload(
                  event.encryptedPayload
                );
                return (
                  <ButtonBase
                    key={event.eventId}
                    onClick={() => void handleReticulumSearchResultClick(result)}
                    sx={{
                      alignItems: 'stretch',
                      backgroundColor: alpha(theme.palette.action.hover, 0.35),
                      border: `1px solid ${theme.palette.divider}`,
                      borderRadius: '8px',
                      display: 'flex',
                      mb: 1,
                      p: 1.25,
                      textAlign: 'left',
                      width: '100%',
                      transition:
                        'background-color 0.15s ease, border-color 0.15s ease',
                      '&:hover': {
                        backgroundColor: theme.palette.action.hover,
                        borderColor: alpha(theme.palette.primary.main, 0.45),
                      },
                    }}
                  >
                    <Box sx={{ minWidth: 0, width: '100%' }}>
                      <Box
                        sx={{
                          alignItems: 'center',
                          display: 'flex',
                          gap: 0.75,
                          minWidth: 0,
                        }}
                      >
                        <SearchResultChannelIcon
                          aria-hidden
                          sx={{
                            flexShrink: 0,
                            fontSize: 16,
                          }}
                        />
                        <Typography
                          sx={{
                            color: theme.palette.primary.main,
                            fontSize: 12,
                            fontWeight: 700,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {channelName}
                        </Typography>
                        <Typography
                          sx={{
                            color: theme.palette.text.secondary,
                            fontSize: 11,
                            ml: 'auto',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {timestamp
                            ? new Date(timestamp).toLocaleString([], {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              })
                            : ''}
                        </Typography>
                      </Box>
                      <Typography
                        sx={{
                          color: theme.palette.text.primary,
                          fontSize: 12,
                          fontWeight: 700,
                          mt: 0.5,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {authorName}
                      </Typography>
                      <Typography
                        component="div"
                        sx={{
                          color: theme.palette.text.secondary,
                          fontSize: 12,
                          lineHeight: 1.45,
                          mt: 0.5,
                          maxHeight: 52,
                          overflow: 'hidden',
                          wordBreak: 'break-word',
                        }}
                      >
                        {renderReticulumSearchSnippet(result.snippet)}
                      </Typography>
                      {attachmentNames.length > 0 && (
                        <Box
                          sx={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 0.5,
                            mt: 0.75,
                          }}
                        >
                          {attachmentNames.slice(0, 3).map((fileName) => (
                            <Box
                              key={fileName}
                              sx={{
                                alignItems: 'center',
                                backgroundColor: alpha(
                                  theme.palette.common.black,
                                  0.18
                                ),
                                border: `1px solid ${alpha(
                                  theme.palette.common.white,
                                  0.1
                                )}`,
                                borderRadius: '6px',
                                color: theme.palette.text.primary,
                                display: 'flex',
                                gap: 0.75,
                                maxWidth: '100%',
                                px: 0.75,
                                py: 0.5,
                              }}
                            >
                              <InsertDriveFileRoundedIcon
                                sx={{
                                  color: theme.palette.text.secondary,
                                  flexShrink: 0,
                                  fontSize: 16,
                                }}
                              />
                              <Typography
                                sx={{
                                  fontSize: 12,
                                  minWidth: 0,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {fileName}
                              </Typography>
                            </Box>
                          ))}
                        </Box>
                      )}
                    </Box>
                  </ButtonBase>
                );
              })}
            </Box>
            {(reticulumSearchPage > 0 || reticulumSearchHasNextPage) && (
              <Box
                sx={{
                  alignItems: 'center',
                  backgroundColor: theme.palette.background.paper,
                  borderTop: `1px solid ${theme.palette.divider}`,
                  display: 'flex',
                  flexShrink: 0,
                  gap: 0.5,
                  justifyContent: 'center',
                  minHeight: 52,
                  px: 1.5,
                }}
              >
                <ButtonBase
                  disabled={reticulumSearchPage === 0 || isReticulumSearchLoading}
                  onClick={() => {
                    setReticulumSearchHasNextPage(false);
                    setReticulumSearchPage((page) => Math.max(0, page - 1));
                  }}
                  sx={{
                    alignItems: 'center',
                    borderRadius: '4px',
                    color:
                      reticulumSearchPage === 0 || isReticulumSearchLoading
                        ? theme.palette.text.disabled
                        : theme.palette.text.secondary,
                    display: 'inline-flex',
                    fontSize: 13,
                    fontWeight: 700,
                    gap: 0.25,
                    minHeight: 32,
                    px: 0.75,
                    '&:hover': {
                      backgroundColor:
                        reticulumSearchPage === 0 || isReticulumSearchLoading
                          ? 'transparent'
                          : theme.palette.action.hover,
                    },
                  }}
                >
                  <ChevronRightRoundedIcon
                    sx={{ fontSize: 17, transform: 'rotate(180deg)' }}
                  />
                  Back
                </ButtonBase>
                {reticulumSearchVisiblePageNumbers.map((pageNumber, index) => (
                  <Box
                    key={pageNumber}
                    sx={{ alignItems: 'center', display: 'inline-flex' }}
                  >
                    {index > 0 &&
                      pageNumber >
                        reticulumSearchVisiblePageNumbers[index - 1] + 1 && (
                        <Typography
                          sx={{
                            color: theme.palette.text.secondary,
                            fontSize: 13,
                            fontWeight: 700,
                            px: 0.5,
                          }}
                        >
                          ...
                        </Typography>
                      )}
                    <ButtonBase
                      disabled={
                        isReticulumSearchLoading ||
                        pageNumber === reticulumSearchPage
                      }
                      onClick={() => {
                        if (pageNumber !== reticulumSearchPage) {
                          setReticulumSearchHasNextPage(false);
                          setReticulumSearchPage(pageNumber);
                        }
                      }}
                      sx={{
                        alignItems: 'center',
                        backgroundColor:
                          pageNumber === reticulumSearchPage
                            ? theme.palette.primary.main
                            : 'transparent',
                        borderRadius: '50%',
                        color:
                          pageNumber === reticulumSearchPage
                            ? theme.palette.primary.contrastText
                            : theme.palette.text.primary,
                        display: 'inline-flex',
                        fontSize: 13,
                        fontWeight: 800,
                        height: 30,
                        justifyContent: 'center',
                        width: 30,
                        '&:hover': {
                          backgroundColor:
                            pageNumber === reticulumSearchPage
                              ? theme.palette.primary.main
                              : theme.palette.action.hover,
                        },
                      }}
                    >
                      {pageNumber + 1}
                    </ButtonBase>
                  </Box>
                ))}
                {reticulumSearchHasNextPage &&
                  reticulumSearchVisiblePageNumbers[
                    reticulumSearchVisiblePageNumbers.length - 1
                  ] > reticulumSearchPage + 1 && (
                  <Typography
                    sx={{
                      color: theme.palette.text.secondary,
                      fontSize: 13,
                      fontWeight: 700,
                      px: 0.5,
                    }}
                  >
                    ...
                  </Typography>
                )}
                <ButtonBase
                  disabled={!reticulumSearchHasNextPage || isReticulumSearchLoading}
                  onClick={() => {
                    setReticulumSearchHasNextPage(false);
                    setReticulumSearchPage((page) =>
                      reticulumSearchHasNextPage ? page + 1 : page
                    );
                  }}
                  sx={{
                    alignItems: 'center',
                    borderRadius: '4px',
                    color:
                      !reticulumSearchHasNextPage || isReticulumSearchLoading
                        ? theme.palette.text.disabled
                        : theme.palette.text.primary,
                    display: 'inline-flex',
                    fontSize: 13,
                    fontWeight: 800,
                    gap: 0.25,
                    minHeight: 32,
                    px: 0.75,
                    '&:hover': {
                      backgroundColor:
                        !reticulumSearchHasNextPage || isReticulumSearchLoading
                          ? 'transparent'
                          : theme.palette.action.hover,
                    },
                  }}
                >
                  Next
                  <ChevronRightRoundedIcon sx={{ fontSize: 17 }} />
                </ButtonBase>
              </Box>
            )}
          </Box>
        </Portal>
      )}

      <Dialog
        open={Boolean(reticulumLargeImageChoice)}
        onClose={closeReticulumLargeImageChoice}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Send large image</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: '14px', mb: 1 }}>
            This image is {formatReticulumFileSize(reticulumLargeImageChoice?.file.size)}.
          </Typography>
          <Typography sx={{ color: theme.palette.text.secondary, fontSize: '13px' }}>
            Compress it for inline chat display, or send the original image as a
            downloadable attachment.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={useReticulumImageAsAttachment}
            disabled={isCompressingReticulumImage}
          >
            As attachment
          </Button>
          <Button
            onClick={useReticulumCompressedImage}
            disabled={isCompressingReticulumImage}
            variant="contained"
            autoFocus
          >
            {isCompressingReticulumImage ? 'Compressing...' : 'Compress'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={isCreateReticulumChannelOpen}
        onClose={closeCreateReticulumChannelDialog}
        fullWidth
        maxWidth={false}
        PaperProps={{
          sx: {
            ...reticulumDialogPaperSx,
            boxSizing: 'border-box',
            m: 2,
            maxHeight: 'calc(100vh - 32px)',
            maxWidth: 'calc(100vw - 32px)',
            overflow: 'hidden',
            width: 680,
          },
        }}
      >
        <DialogContent
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2.5,
            maxHeight: 'calc(100vh - 96px)',
            overflowY: 'auto',
            px: { xs: 2.5, sm: 4 },
            py: { xs: 2.5, sm: 3.5 },
          }}
        >
          <Box>
            <DialogTitle
              sx={{
                ...reticulumDialogTitleSx,
                fontSize: { xs: 25, sm: 28 },
                lineHeight: 1.15,
                p: 0,
              }}
            >
              Create text channel
            </DialogTitle>
            <Typography
              sx={{
                color: 'text.secondary',
                fontSize: 14,
                lineHeight: '20px',
                mt: 0.75,
              }}
            >
              Choose a name and decide who can view or post in this channel.
            </Typography>
          </Box>

          <Box>
            <Typography
              component="label"
              htmlFor="reticulum-channel-name-input"
              sx={{
                color: 'text.primary',
                display: 'block',
                fontSize: 15,
                fontWeight: 800,
                mb: 1,
              }}
            >
              Channel name
            </Typography>
            <TextField
              autoFocus
              fullWidth
              id="reticulum-channel-name-input"
              placeholder="e.g. support-chat"
              sx={{
                ...reticulumDialogTextFieldSx,
                '& .MuiOutlinedInput-root': {
                  ...reticulumDialogTextFieldSx['& .MuiOutlinedInput-root'],
                  height: 48,
                },
                '& .MuiOutlinedInput-input': {
                  py: 1.5,
                },
              }}
              value={newReticulumChannelName}
              error={Boolean(newReticulumChannelError)}
              FormHelperTextProps={{
                sx: {
                  fontSize: 12.5,
                  lineHeight: '18px',
                  minHeight: 18,
                  ml: 0,
                  mt: 0.75,
                },
              }}
              helperText={
                newReticulumChannelError ||
                'Use letters, numbers, special characters and emojis.'
              }
              InputProps={{
                endAdornment: renderReticulumNameEmojiAdornment(
                  'channel-create'
                ),
              }}
              onChange={(event) => {
                setNewReticulumChannelName(event.target.value);
                if (newReticulumChannelError) setNewReticulumChannelError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && isNewReticulumChannelNameValid) {
                  event.preventDefault();
                  void createReticulumChannel();
                }
              }}
            />
          </Box>

          <Box>
            <Typography
              id="reticulum-channel-type-label"
              sx={{
                color: 'text.primary',
                fontSize: 15,
                fontWeight: 800,
                mb: 1,
              }}
            >
              Channel type
            </Typography>
            <Box
              aria-labelledby="reticulum-channel-type-label"
              role="radiogroup"
              sx={{
                backgroundColor: '#0c0e13',
                border: '1px solid',
                borderColor: 'rgba(0, 0, 0, 0.72)',
                borderRadius: '10px',
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                overflow: 'hidden',
              }}
            >
              {reticulumChannelTypeOptions.map((option, index) => {
                const selected =
                  newReticulumChannelAccessMode === option.value;
                const Icon = option.icon;
                return (
                  <ButtonBase
                    aria-checked={selected}
                    aria-describedby={`reticulum-channel-type-description-${index}`}
                    aria-label={`${option.label}. ${option.description}`}
                    id={`reticulum-channel-type-${index}`}
                    key={option.value}
                    onClick={() =>
                      setNewReticulumChannelAccessMode(option.value)
                    }
                    onKeyDown={(event) =>
                      handleReticulumChannelTypeKeyDown(event, index)
                    }
                    role="radio"
                    sx={{
                      alignItems: 'center',
                      backgroundColor: selected
                        ? 'rgba(37, 99, 235, 0.12)'
                        : 'background.default',
                      borderColor: selected
                        ? RETICULUM_ACTIVE_BLUE
                        : 'rgba(0, 0, 0, 0.72)',
                      borderLeft:
                        index === 0 ? 'none' : '1px solid rgba(0, 0, 0, 0.72)',
                      borderRadius:
                        index === 0
                          ? '9px 0 0 9px'
                          : index === reticulumChannelTypeOptions.length - 1
                            ? '0 9px 9px 0'
                            : 0,
                      borderTop: 'none',
                      boxShadow: selected
                        ? `inset 0 0 0 1px ${RETICULUM_ACTIVE_BLUE}`
                        : 'none',
                      color: selected ? 'common.white' : 'text.primary',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 0.75,
                      justifyContent: 'center',
                      minHeight: { xs: 148, sm: 135 },
                      p: { xs: 1.25, sm: 1.5 },
                      position: 'relative',
                      textAlign: 'center',
                      transition:
                        'background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
                      '&:hover': {
                        backgroundColor: selected
                          ? 'rgba(37, 99, 235, 0.16)'
                          : 'action.hover',
                        borderColor: selected
                          ? RETICULUM_ACTIVE_BLUE
                          : 'text.secondary',
                      },
                      '&.Mui-focusVisible': {
                        outline: `2px solid ${RETICULUM_ACTIVE_BLUE}`,
                        outlineOffset: -4,
                      },
                      zIndex: selected ? 1 : 0,
                    }}
                    tabIndex={selected ? 0 : -1}
                  >
                    {selected && (
                      <CheckCircleRoundedIcon
                        sx={{
                          color: RETICULUM_ACTIVE_BLUE,
                          fontSize: 19,
                          position: 'absolute',
                          right: 9,
                          top: 9,
                        }}
                      />
                    )}
                    <Icon
                      sx={{
                        color: selected ? 'common.white' : 'text.secondary',
                        fontSize: 26,
                        transition: 'color 140ms ease',
                      }}
                    />
                    <Typography
                      sx={{
                        color: selected ? 'common.white' : 'text.primary',
                        fontSize: 15,
                        fontWeight: 800,
                        lineHeight: '18px',
                      }}
                    >
                      {option.label}
                    </Typography>
                    <Typography
                      id={`reticulum-channel-type-description-${index}`}
                      sx={{
                        color: 'text.secondary',
                        fontSize: 13,
                        lineHeight: '18px',
                        maxWidth: 180,
                      }}
                    >
                      {option.description}
                    </Typography>
                  </ButtonBase>
                );
              })}
            </Box>
          </Box>
        </DialogContent>
        <DialogActions
          sx={{
            borderTop: '1px solid',
            borderColor: 'divider',
            gap: 1,
            px: { xs: 2.5, sm: 4 },
            py: 1.5,
          }}
        >
          <Button
            onClick={closeCreateReticulumChannelDialog}
            sx={{ ...reticulumSecondaryButtonSx, minHeight: 40 }}
          >
            Cancel
          </Button>
          <Button
            disabled={
              !isNewReticulumChannelNameValid || isCreatingReticulumChannel
            }
            variant="contained"
            onClick={() => void createReticulumChannel()}
            sx={{
              ...reticulumPrimaryButtonSx,
              minHeight: 40,
              minWidth: 150,
              '&.Mui-disabled': {
                backgroundColor: 'action.disabledBackground',
                color: 'text.disabled',
              },
            }}
          >
            {isCreatingReticulumChannel ? (
              <CircularProgress size={18} sx={{ color: 'common.white' }} />
            ) : (
              'Create channel'
            )}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={reticulumChannelSettingsOpen}
        onClose={handleReticulumChannelSettingsDialogClose}
        fullWidth
        maxWidth={false}
        PaperProps={{
          sx: {
            ...reticulumDialogPaperSx,
            boxSizing: 'border-box',
            m: 2,
            maxHeight: 'calc(100vh - 32px)',
            maxWidth: 'calc(100vw - 32px)',
            overflow: 'hidden',
            transition: 'width 160ms ease',
            width:
              reticulumChannelSettingsView === 'confirm-delete' ? 480 : 680,
          },
        }}
      >
        {reticulumChannelSettingsView === 'confirm-delete' ? (
          <>
            <DialogContent
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2.25,
                px: { xs: 2.5, sm: 3.5 },
                py: { xs: 2.5, sm: 3 },
              }}
            >
              <Box sx={{ alignItems: 'center', display: 'flex', gap: 1 }}>
                <Tooltip title="Back to channel settings">
                  <span>
                    <IconButton
                      aria-label="Back to channel settings"
                      disabled={isDeletingReticulumChannel}
                      onClick={returnToReticulumChannelSettings}
                      size="small"
                      sx={{ color: 'text.secondary', ml: -0.5 }}
                    >
                      <ArrowBackRoundedIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <DeleteOutlineRoundedIcon
                  sx={{ color: 'error.main', fontSize: 26 }}
                />
                <DialogTitle
                  sx={{
                    ...reticulumDialogTitleSx,
                    fontSize: { xs: 24, sm: 26 },
                    lineHeight: 1.15,
                    p: 0,
                  }}
                >
                  Delete channel
                </DialogTitle>
              </Box>

              <Typography
                sx={{ color: 'text.secondary', fontSize: 14, lineHeight: '21px' }}
              >
                This action cannot be undone. To permanently delete '
                {reticulumDeleteConfirmationChannelName}', type the channel name
                below.
              </Typography>

              <Box>
                <Typography
                  component="label"
                  htmlFor="reticulum-channel-delete-confirmation-input"
                  sx={{
                    color: 'text.primary',
                    display: 'block',
                    fontSize: 15,
                    fontWeight: 800,
                    mb: 1,
                  }}
                >
                  Type {reticulumDeleteConfirmationChannelName} to confirm
                </Typography>
                <TextField
                  aria-describedby={
                    reticulumDeleteConfirmationError
                      ? 'reticulum-channel-delete-confirmation-error'
                      : undefined
                  }
                  aria-label={`Type ${reticulumDeleteConfirmationChannelName} to confirm channel deletion`}
                  autoComplete="off"
                  disabled={isDeletingReticulumChannel}
                  fullWidth
                  id="reticulum-channel-delete-confirmation-input"
                  inputRef={reticulumDeleteConfirmationInputRef}
                  onChange={(event) => {
                    setReticulumDeleteConfirmationName(event.target.value);
                    if (reticulumDeleteConfirmationError) {
                      setReticulumDeleteConfirmationError('');
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      isReticulumDeleteConfirmationMatched
                    ) {
                      event.preventDefault();
                      void confirmReticulumChannelDeletion();
                    }
                  }}
                  placeholder={reticulumDeleteConfirmationChannelName}
                  sx={{
                    ...reticulumDialogTextFieldSx,
                    '& .MuiOutlinedInput-root': {
                      ...reticulumDialogTextFieldSx['& .MuiOutlinedInput-root'],
                      height: 48,
                    },
                    '& .MuiOutlinedInput-input': { py: 1.5 },
                  }}
                  value={reticulumDeleteConfirmationName}
                  InputProps={{
                    endAdornment: isReticulumDeleteConfirmationMatched ? (
                      <InputAdornment position="end">
                        <CheckCircleRoundedIcon
                          aria-label="Channel name confirmed"
                          color="primary"
                          fontSize="small"
                        />
                      </InputAdornment>
                    ) : undefined,
                  }}
                />
                {reticulumDeleteConfirmationError && (
                  <Typography
                    id="reticulum-channel-delete-confirmation-error"
                    role="alert"
                    sx={{
                      color: 'error.main',
                      fontSize: 12.5,
                      lineHeight: '18px',
                      mt: 0.75,
                    }}
                  >
                    {reticulumDeleteConfirmationError}
                  </Typography>
                )}
              </Box>
            </DialogContent>
            <DialogActions
              sx={{
                borderTop: '1px solid',
                borderColor: 'divider',
                gap: 1,
                justifyContent: 'flex-end',
                px: { xs: 2.5, sm: 3.5 },
                py: 1.25,
              }}
            >
              <Button
                disabled={isDeletingReticulumChannel}
                onClick={returnToReticulumChannelSettings}
                sx={{ ...reticulumSecondaryButtonSx, minHeight: 40 }}
              >
                Cancel
              </Button>
              <Button
                aria-disabled={!isReticulumDeleteConfirmationMatched}
                disabled={
                  !isReticulumDeleteConfirmationMatched ||
                  isDeletingReticulumChannel
                }
                onClick={() => void confirmReticulumChannelDeletion()}
                sx={{
                  '&.Mui-disabled': {
                    backgroundColor: 'rgba(220, 38, 38, 0.28)',
                    color: 'rgba(255, 255, 255, 0.48)',
                  },
                  '&:hover': { backgroundColor: '#b91c1c' },
                  backgroundColor: '#dc2626',
                  color: 'common.white',
                  minHeight: 40,
                  minWidth: 142,
                }}
                variant="contained"
              >
                {isDeletingReticulumChannel ? (
                  <CircularProgress size={18} sx={{ color: 'common.white' }} />
                ) : (
                  'Delete channel'
                )}
              </Button>
            </DialogActions>
          </>
        ) : (
          <>
        <DialogContent
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2.5,
            maxHeight: 'calc(100vh - 96px)',
            overflowY: 'auto',
            px: { xs: 2.5, sm: 4 },
            py: { xs: 2.5, sm: 3.5 },
          }}
        >
          <Box>
            <DialogTitle
              sx={{
                ...reticulumDialogTitleSx,
                fontSize: { xs: 25, sm: 28 },
                lineHeight: 1.15,
                p: 0,
              }}
            >
              Channel settings
            </DialogTitle>
            <Typography
              sx={{
                color: 'text.secondary',
                fontSize: 14,
                lineHeight: '20px',
                mt: 0.75,
              }}
            >
              Update this channel&apos;s name and permissions.
            </Typography>
          </Box>

          <Box>
            <Typography
              component="label"
              htmlFor="reticulum-channel-settings-name-input"
              sx={{
                color: 'text.primary',
                display: 'block',
                fontSize: 15,
                fontWeight: 800,
                mb: 1,
              }}
            >
              Channel name
            </Typography>
            <TextField
              autoFocus
              fullWidth
              id="reticulum-channel-settings-name-input"
              sx={{
                ...reticulumDialogTextFieldSx,
                '& .MuiOutlinedInput-root': {
                  ...reticulumDialogTextFieldSx['& .MuiOutlinedInput-root'],
                  height: 48,
                },
                '& .MuiOutlinedInput-input': {
                  py: 1.5,
                },
              }}
              value={reticulumChannelName}
              error={Boolean(reticulumChannelError)}
              FormHelperTextProps={{
                sx: {
                  fontSize: 12.5,
                  lineHeight: '18px',
                  minHeight: 18,
                  ml: 0,
                  mt: 0.75,
                },
              }}
              helperText={
                reticulumChannelError ||
                'Use letters, numbers, special characters and emojis.'
              }
              InputProps={{
                endAdornment: renderReticulumNameEmojiAdornment(
                  'channel-settings'
                ),
              }}
              onChange={(event) => {
                setReticulumChannelName(event.target.value);
                if (reticulumChannelError) setReticulumChannelError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveReticulumChannelSettings();
                }
              }}
            />
          </Box>

          <Box>
            <Typography
              id="reticulum-channel-settings-type-label"
              sx={{
                color: 'text.primary',
                fontSize: 15,
                fontWeight: 800,
                mb: 1,
              }}
            >
              Channel type
            </Typography>
            <Box
              aria-labelledby="reticulum-channel-settings-type-label"
              role="radiogroup"
              sx={{
                backgroundColor: '#0c0e13',
                border: '1px solid',
                borderColor: 'rgba(0, 0, 0, 0.72)',
                borderRadius: '10px',
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                overflow: 'hidden',
              }}
            >
              {reticulumChannelTypeOptions.map((option, index) => {
                const selected = reticulumChannelAccessMode === option.value;
                const Icon = option.icon;
                return (
                  <ButtonBase
                    aria-checked={selected}
                    aria-describedby={`reticulum-channel-settings-type-description-${index}`}
                    aria-label={`${option.label}. ${option.description}`}
                    id={`reticulum-channel-settings-type-${index}`}
                    key={option.value}
                    onClick={() =>
                      setReticulumChannelAccessMode(option.value)
                    }
                    onKeyDown={(event) =>
                      handleReticulumChannelTypeKeyDown(
                        event,
                        index,
                        'settings'
                      )
                    }
                    role="radio"
                    sx={{
                      alignItems: 'center',
                      backgroundColor: selected
                        ? 'rgba(37, 99, 235, 0.12)'
                        : 'background.default',
                      borderColor: selected
                        ? RETICULUM_ACTIVE_BLUE
                        : 'rgba(0, 0, 0, 0.72)',
                      borderLeft:
                        index === 0 ? 'none' : '1px solid rgba(0, 0, 0, 0.72)',
                      borderRadius:
                        index === 0
                          ? '9px 0 0 9px'
                          : index === reticulumChannelTypeOptions.length - 1
                            ? '0 9px 9px 0'
                            : 0,
                      borderTop: 'none',
                      boxShadow: selected
                        ? `inset 0 0 0 1px ${RETICULUM_ACTIVE_BLUE}`
                        : 'none',
                      color: selected ? 'common.white' : 'text.primary',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 0.75,
                      justifyContent: 'center',
                      minHeight: { xs: 148, sm: 135 },
                      p: { xs: 1.25, sm: 1.5 },
                      position: 'relative',
                      textAlign: 'center',
                      transition:
                        'background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
                      '&:hover': {
                        backgroundColor: selected
                          ? 'rgba(37, 99, 235, 0.16)'
                          : 'action.hover',
                        borderColor: selected
                          ? RETICULUM_ACTIVE_BLUE
                          : 'text.secondary',
                      },
                      '&.Mui-focusVisible': {
                        outline: `2px solid ${RETICULUM_ACTIVE_BLUE}`,
                        outlineOffset: -4,
                      },
                      zIndex: selected ? 1 : 0,
                    }}
                    tabIndex={selected ? 0 : -1}
                  >
                    {selected && (
                      <CheckCircleRoundedIcon
                        sx={{
                          color: RETICULUM_ACTIVE_BLUE,
                          fontSize: 19,
                          position: 'absolute',
                          right: 9,
                          top: 9,
                        }}
                      />
                    )}
                    <Icon
                      sx={{
                        color: selected ? 'common.white' : 'text.secondary',
                        fontSize: 26,
                        transition: 'color 140ms ease',
                      }}
                    />
                    <Typography
                      sx={{
                        color: selected ? 'common.white' : 'text.primary',
                        fontSize: 15,
                        fontWeight: 800,
                        lineHeight: '18px',
                      }}
                    >
                      {option.label}
                    </Typography>
                    <Typography
                      id={`reticulum-channel-settings-type-description-${index}`}
                      sx={{
                        color: 'text.secondary',
                        fontSize: 13,
                        lineHeight: '18px',
                        maxWidth: 180,
                      }}
                    >
                      {option.description}
                    </Typography>
                  </ButtonBase>
                );
              })}
            </Box>
          </Box>
        </DialogContent>
        <DialogActions
          sx={{
            borderTop: '1px solid',
            borderColor: 'divider',
            flexWrap: 'wrap',
            gap: 1,
            justifyContent: 'space-between',
            px: { xs: 2.5, sm: 4 },
            py: 1.5,
          }}
        >
          <Box sx={{ width: { xs: '100%', sm: 'auto' } }}>
            {editingReticulumChannel &&
              !isReticulumSystemChannelId(editingReticulumChannel.channelId) && (
              <Button
                ref={reticulumRemoveChannelButtonRef}
                color="error"
                startIcon={<DeleteOutlineRoundedIcon />}
                onClick={openReticulumDeleteConfirmation}
                sx={{
                  minHeight: 40,
                  px: 1,
                  textTransform: 'none',
                }}
              >
                Remove channel
              </Button>
            )}
          </Box>
          <Box
            sx={{
              display: 'flex',
              gap: 1,
              justifyContent: 'flex-end',
              width: { xs: '100%', sm: 'auto' },
            }}
          >
            <Button
              onClick={closeReticulumChannelSettings}
              sx={{ ...reticulumSecondaryButtonSx, minHeight: 40 }}
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={() => void saveReticulumChannelSettings()}
              sx={{
                ...reticulumPrimaryButtonSx,
                minHeight: 40,
                minWidth: 140,
              }}
            >
              Save changes
            </Button>
          </Box>
        </DialogActions>
          </>
        )}
      </Dialog>

      <Dialog
        open={isReticulumCategoryDialogOpen}
        onClose={closeReticulumCategoryDialog}
        fullWidth
        maxWidth="xs"
        PaperProps={{ sx: reticulumDialogPaperSx }}
      >
        <DialogTitle sx={reticulumDialogTitleSx}>
          {reticulumCategoryDialogMode === 'rename'
            ? 'Rename category'
            : 'Create category'}
        </DialogTitle>
        <DialogContent sx={reticulumDialogContentSx}>
          <TextField
            autoFocus
            fullWidth
            label="Category name"
            placeholder="e.g. ⚡︱updates"
            sx={reticulumDialogTextFieldSx}
            value={reticulumCategoryName}
            error={Boolean(reticulumCategoryError)}
            helperText={
              reticulumCategoryError ||
              'Use letters, numbers, special characters and emojis.'
            }
            InputProps={{
              endAdornment: renderReticulumNameEmojiAdornment('category'),
            }}
            onChange={(event) => {
              setReticulumCategoryName(event.target.value);
              if (reticulumCategoryError) setReticulumCategoryError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void saveReticulumCategory();
              }
            }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={closeReticulumCategoryDialog}
            sx={reticulumSecondaryButtonSx}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void saveReticulumCategory()}
            sx={reticulumPrimaryButtonSx}
          >
            {reticulumCategoryDialogMode === 'rename' ? 'Save' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      <Popover
        anchorEl={reticulumNameEmojiPicker?.anchorEl}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        onClose={closeReticulumNameEmojiPicker}
        open={Boolean(reticulumNameEmojiPicker)}
        PaperProps={{
          sx: {
            backgroundColor: 'background.paper',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: '10px',
            boxShadow: '0 18px 48px rgba(0, 0, 0, 0.45)',
            overflow: 'hidden',
          },
        }}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
      >
        <EmojiPicker
          autoFocusSearch
          emojiStyle={EmojiStyle.NATIVE}
          height={390}
          onEmojiClick={appendReticulumNameEmoji}
          previewConfig={{ showPreview: false }}
          searchPlaceHolder="Find an emoji"
          theme={Theme.DARK}
          width={340}
        />
      </Popover>

      {(isResizingQManager || isOpenQManager !== null) && (
        <Portal>
          {isResizingQManager && (
            <Box
              aria-hidden
              sx={{
                backgroundColor: 'transparent',
                inset: 0,
                pointerEvents: 'auto',
                position: 'fixed',
                zIndex: 1399,
              }}
            />
          )}

          {isOpenQManager !== null && (
            <Rnd
              position={qManagerPosition}
              size={qManagerSize}
              minWidth={Q_MANAGER_MIN_WIDTH}
              minHeight={Q_MANAGER_MIN_HEIGHT}
              maxWidth={maxQManagerWidth}
              maxHeight={maxQManagerHeight}
              bounds="window"
              disableDragging
              enableResizing={
                isOpenQManager === true && !hideView
                  ? {
                      top: false,
                      left: true,
                      topLeft: false,
                      topRight: false,
                      right: true,
                      bottom: true,
                      bottomLeft: false,
                      bottomRight: true,
                    }
                  : false
              }
              resizeHandleStyles={{
                top: { height: 24, top: -12, zIndex: 25, cursor: 'ns-resize' },
                left: { width: 24, left: -12, zIndex: 25, cursor: 'ew-resize' },
                topLeft: {
                  width: 28,
                  height: 28,
                  left: -14,
                  top: -14,
                  zIndex: 25,
                  cursor: 'nwse-resize',
                },
              }}
              resizeHandleWrapperStyle={{ pointerEvents: 'auto' }}
              onResizeStart={handleQManagerResizeStart}
              onResize={handleQManagerResize}
              onResizeStop={handleQManagerResizeStop}
              style={{
                display: hideView || isOpenQManager !== true ? 'none' : 'block',
                position: 'fixed',
                zIndex: 1400,
              }}
            >
              <Box
                sx={{
                  backgroundColor: theme.palette.background.surface,
                  border: `1px solid ${alpha(theme.palette.divider, 0.82)}`,
                  borderRadius: '10px',
                  boxShadow:
                    theme.palette.mode === 'dark'
                      ? `0 20px 50px ${alpha(theme.palette.common.black, 0.48)}, 0 1px 0 ${alpha(theme.palette.common.white, 0.05)}`
                      : `0 18px 44px ${alpha(theme.palette.common.black, 0.16)}, 0 1px 0 ${alpha(theme.palette.common.white, 0.72)}`,
                  display: 'flex',
                  flexDirection: 'column',
                  height: '100%',
                  maxHeight: `calc(100vh - ${appHeighOffsetPx})`,
                  maxWidth: '100vw',
                  minHeight: Q_MANAGER_MIN_HEIGHT,
                  minWidth: Q_MANAGER_MIN_WIDTH,
                  overflow: 'visible',
                  position: 'relative',
                  width: '100%',
                  '&::before': {
                    backgroundColor: theme.palette.background.surface,
                    borderLeft: `1px solid ${alpha(theme.palette.divider, 0.82)}`,
                    borderTop: `1px solid ${alpha(theme.palette.divider, 0.82)}`,
                    content: '""',
                    height: 12,
                    left: '50%',
                    position: 'absolute',
                    top: -7,
                    transform: 'translateX(-50%) rotate(45deg)',
                    width: 12,
                    zIndex: 1,
                  },
                }}
              >
                <Box
                  sx={{
                    alignItems: 'center',
                    backgroundColor:
                      theme.palette.mode === 'dark'
                        ? alpha(theme.palette.background.default, 0.58)
                        : alpha(theme.palette.background.paper, 0.72),
                    borderBottom: `1px solid ${alpha(theme.palette.divider, 0.72)}`,
                    display: 'flex',
                    flex: `0 0 ${Q_MANAGER_HEADER_HEIGHT}px`,
                    gap: 1,
                    height: `${Q_MANAGER_HEADER_HEIGHT}px`,
                    justifyContent: 'space-between',
                    padding: '0 8px 0 12px',
                  }}
                >
                  <Box
                    sx={{
                      alignItems: 'center',
                      display: 'flex',
                      gap: 1,
                      minWidth: 0,
                    }}
                  >
                    <Box
                      aria-hidden
                      sx={{
                        backgroundColor: theme.palette.primary.main,
                        borderRadius: '999px',
                        boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.16)}`,
                        flexShrink: 0,
                        height: 8,
                        width: 8,
                      }}
                    />
                    <Typography
                      noWrap
                      sx={{
                        color: theme.palette.text.primary,
                        fontFamily: 'Inter',
                        fontSize: '14px',
                        fontWeight: 700,
                      }}
                    >
                      Q-Manager
                    </Typography>
                  </Box>

                  <ButtonBase
                    onClick={() => {
                      setIsOpenQManager(false);
                    }}
                    sx={{
                      alignItems: 'center',
                      borderRadius: '8px',
                      color: theme.palette.text.secondary,
                      display: 'inline-flex',
                      height: 30,
                      justifyContent: 'center',
                      transition:
                        'background-color 0.18s ease, color 0.18s ease',
                      width: 30,
                      '&:hover': {
                        backgroundColor: alpha(
                          theme.palette.text.primary,
                          0.08
                        ),
                        color: theme.palette.text.primary,
                      },
                    }}
                  >
                    <CloseIcon
                      sx={{
                        color: 'currentColor',
                        fontSize: 20,
                      }}
                    />
                  </ButtonBase>
                </Box>

                <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                  <AppViewerContainer
                    customHeight="100%"
                    app={{
                      name: 'Q-Manager',
                      path: `?groupId=${selectedGroup}`,
                      service: 'APP',
                      tabId: '5558588',
                    }}
                    isSelected
                    ref={iframeRef}
                  />
                </Box>
              </Box>
            </Rnd>
          )}
        </Portal>
      )}

      <LoadingSnackbar
        open={isLoading}
        info={{
          message: t('core:loading.chat', {
            postProcess: 'capitalizeFirstChar',
          }),
        }}
      />

      <CustomizedSnackbars
        open={openSnack}
        setOpen={setOpenSnack}
        info={infoSnack}
        setInfo={setInfoSnack}
      />
    </div>
  );
};
