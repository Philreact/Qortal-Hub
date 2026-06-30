import {
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
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Portal,
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
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import DriveFileRenameOutlineRoundedIcon from '@mui/icons-material/DriveFileRenameOutlineRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import ImageIcon from '@mui/icons-material/Image';
import InsertDriveFileRoundedIcon from '@mui/icons-material/InsertDriveFileRounded';
import SendIcon from '@mui/icons-material/Send';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { messageHasImage } from '../../utils/chat';
import { useTranslation } from 'react-i18next';
import { useReticulumGroupChat } from '../../hooks/useReticulumGroupChat';
import { fileToBase64 } from '../../utils/fileReading';
import { generateHTML } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Mention from '@tiptap/extension-mention';
import TextStyle from '@tiptap/extension-text-style';
import { getGroupAdminsAddress, getGroupMembers } from '../Group/groupApi';
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
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

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
const RETICULUM_CHANNEL_DRAG_PREFIX = 'reticulum-channel:';
const RETICULUM_CATEGORY_DROP_PREFIX = 'reticulum-category:';

const normalizeReticulumChannelName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const uid = new ShortUniqueId({ length: 5 });
const uidImages = new ShortUniqueId({ length: 12 });
const Q_MANAGER_DEFAULT_WIDTH = 400;
const Q_MANAGER_DEFAULT_HEIGHT = 600;
const Q_MANAGER_MIN_WIDTH = 360;
const Q_MANAGER_MIN_HEIGHT = 420;
const Q_MANAGER_HEADER_HEIGHT = 40;

const reticulumChannelDragId = (channelId: string) =>
  `${RETICULUM_CHANNEL_DRAG_PREFIX}${channelId}`;

const reticulumCategoryDropId = (categoryId: string) =>
  `${RETICULUM_CATEGORY_DROP_PREFIX}${categoryId}`;

const parseReticulumChannelDragId = (id: unknown) =>
  typeof id === 'string' && id.startsWith(RETICULUM_CHANNEL_DRAG_PREFIX)
    ? id.slice(RETICULUM_CHANNEL_DRAG_PREFIX.length)
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

  return (
    <ButtonBase
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onSelect(channel.channelId)}
      sx={{
        alignItems: 'center',
        backgroundColor: selected ? 'action.selected' : 'transparent',
        borderRadius: '6px',
        color: selected ? 'text.primary' : 'text.secondary',
        cursor: isAdmin ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
        display: 'flex',
        fontSize: 14,
        fontWeight: selected ? 700 : 500,
        justifyContent: 'space-between',
        mb: 0.5,
        opacity: isDragging ? 0.55 : 1,
        px: 1,
        py: 0.75,
        textAlign: 'left',
        transform: CSS.Transform.toString(transform),
        transition,
        width: '100%',
        zIndex: isDragging ? 3 : 'auto',
        '& .reticulum-channel-settings': {
          opacity: selected ? 1 : 0,
          pointerEvents: selected ? 'auto' : 'none',
        },
        '&:hover': {
          backgroundColor: 'action.hover',
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
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        # {channel.name || channel.channelId}
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

const nextReticulumAuthorSeq = (groupId: string | number, address: string) => {
  const key = `reticulum-chat-author-seq:${groupId}:${address}`;
  const current = Number(window.localStorage.getItem(key) || '0');
  const next = Number.isFinite(current) ? current + 1 : 1;
  window.localStorage.setItem(key, String(next));
  return next;
};

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
  reticulumReadEntryToken,
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
  const [isReticulumChannelAdmin, setIsReticulumChannelAdmin] = useState(false);
  const [isCreateReticulumChannelOpen, setIsCreateReticulumChannelOpen] =
    useState(false);
  const [newReticulumChannelName, setNewReticulumChannelName] = useState('');
  const [newReticulumChannelError, setNewReticulumChannelError] = useState('');
  const [newReticulumChannelCategoryId, setNewReticulumChannelCategoryId] =
    useState('');
  const [reticulumChannelSettingsOpen, setReticulumChannelSettingsOpen] =
    useState(false);
  const [editingReticulumChannel, setEditingReticulumChannel] =
    useState<ReticulumGroupChannel | null>(null);
  const [reticulumChannelName, setReticulumChannelName] = useState('');
  const [reticulumChannelError, setReticulumChannelError] = useState('');
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
    publishEvent: publishReticulumChatEvent,
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
  const appliedReticulumChannelMetadataEventIdsRef = useRef<Set<string>>(
    new Set()
  );
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
    () => ({
      x: Math.max(0, windowSize.width - qManagerSize.width),
      y: Math.max(0, windowSize.height - qManagerSize.height),
    }),
    [
      windowSize.width,
      windowSize.height,
      qManagerSize.width,
      qManagerSize.height,
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

  const refreshReticulumChannels = useCallback(async () => {
    const groupId = Number(selectedGroup);
    const refreshSeq = ++reticulumChannelRefreshSeqRef.current;
    if (!Number.isInteger(groupId) || groupId <= 0) {
      setReticulumChannels([]);
      setReticulumCategories([]);
      setReticulumChannelStateGroupId('');
      setSelectedReticulumChannelId(DEFAULT_RETICULUM_CHANNEL_ID);
      return;
    }
    const metadataHistory =
      await window.reticulumChat?.getChannelMetadataHistory?.(groupId, 500);
    if (Array.isArray(metadataHistory)) {
      for (const event of metadataHistory) {
        if (reticulumChannelRefreshSeqRef.current !== refreshSeq) return;
        const eventRecord =
          event && typeof event === 'object'
            ? (event as Record<string, any>)
            : null;
        if (!eventRecord) continue;
        const eventId =
          typeof eventRecord.eventId === 'string' ? eventRecord.eventId : '';
        if (
          eventId &&
          appliedReticulumChannelMetadataEventIdsRef.current.has(eventId)
        ) {
          continue;
        }
        const eventType =
          typeof eventRecord.eventType === 'string' ? eventRecord.eventType : '';
        if (
          !eventType.startsWith('channel_') &&
          !eventType.startsWith('category_')
        ) {
          continue;
        }
        let metadataPayload: unknown = null;
        if (reticulumChatEnabled || isPrivate === false) {
          try {
            metadataPayload = JSON.parse(String(eventRecord.encryptedPayload || ''));
          } catch {
            metadataPayload = null;
          }
        } else if (secretKeyRef.current) {
          const decrypted = await window.sendMessage('decryptSingle', {
            data: [
              {
                signature: eventRecord.eventId,
                id: eventRecord.eventId,
                groupId: eventRecord.groupId,
                channelId:
                  normalizeReticulumChannelName(
                    eventRecord.channelId || DEFAULT_RETICULUM_CHANNEL_ID
                  ) || DEFAULT_RETICULUM_CHANNEL_ID,
                sender: eventRecord.authorAddress,
                timestamp: eventRecord.timestamp,
                data: eventRecord.encryptedPayload,
                eventType: eventRecord.eventType,
                reticulumChat: true,
              },
            ],
            secretKeyObject: secretKeyRef.current,
          });
          metadataPayload = decrypted?.[0]?.decryptedData;
        }
        if (!metadataPayload) continue;
        const result = await window.reticulumChat?.applyChannelMetadata?.(
          eventRecord.eventId,
          metadataPayload
        );
        if (result?.success && eventId) {
          appliedReticulumChannelMetadataEventIdsRef.current.add(eventId);
        }
      }
    }
    if (reticulumChannelRefreshSeqRef.current !== refreshSeq) return;
    const channels = await window.reticulumChat?.getChannels?.(groupId);
    const categories = await window.reticulumChat?.getCategories?.(groupId);
    const parsedChannels = Array.isArray(channels)
      ? (channels as ReticulumGroupChannel[])
      : [];
    const parsedCategories = Array.isArray(categories)
      ? (categories as ReticulumGroupCategory[])
      : [];
    if (reticulumChannelRefreshSeqRef.current !== refreshSeq) return;
    setReticulumChannelStateGroupId(String(groupId));
    const visibleChannels = parsedChannels.length
      ? parsedChannels.filter((channel) => !channel.archived)
      : [
          {
            channelId: DEFAULT_RETICULUM_CHANNEL_ID,
            groupId,
            name: DEFAULT_RETICULUM_CHANNEL_ID,
            position: 0,
            archived: false,
            createdBy: '',
            createdAt: 0,
            updatedAt: 0,
          },
        ];
    setReticulumCategories(parsedCategories);
    setReticulumChannels(visibleChannels);
    setSelectedReticulumChannelId((current) =>
      visibleChannels.some((channel) => channel.channelId === current)
        ? current
        : DEFAULT_RETICULUM_CHANNEL_ID
    );
  }, [isPrivate, reticulumChatEnabled, selectedGroup]);

  useEffect(() => {
    if (!reticulumChatEnabled || !selectedGroup) return;
    void refreshReticulumChannels();
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
  const reticulumChannelsForSelectedGroup =
    reticulumChannelStateGroupId === selectedReticulumGroupKey
      ? reticulumChannels
      : [];
  const reticulumCategoriesForSelectedGroup =
    reticulumChannelStateGroupId === selectedReticulumGroupKey
      ? reticulumCategories
      : [];

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
    appliedReticulumChannelMetadataEventIdsRef.current.clear();
  }, [selectedGroup]);

  useEffect(() => {
    if (!reticulumChatEnabled) return;
    setMessages([]);
    setChatReferences({});
    appliedReticulumEventIdsRef.current.clear();
  }, [reticulumChatEnabled, selectedReticulumChannelId]);

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
                          : !!item?.chatReference
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
    let socketLink = `${getBaseApiReactSocket()}/websockets/chat/messages?txGroupId=${selectedGroup}&encoding=BASE64&limit=100`;
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
      const baseFields = {
        eventId,
        groupId,
        channelId: eventChannelId,
        authorSeq: nextReticulumAuthorSeq(groupId, myAddress),
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
      if (signed?.error) throw new Error(signed.error);
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
      return { ...result, event };
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
          if (!prev?.[targetReference]) return prev;
          const organized = { ...prev };
          delete organized[targetReference];
          return organized;
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
    async (event) => {
      if (!event || Number(event.groupId) !== Number(selectedGroup))
        return null;
      const eventChannelId =
        normalizeReticulumChannelName(
          event.channelId || DEFAULT_RETICULUM_CHANNEL_ID
        ) || DEFAULT_RETICULUM_CHANNEL_ID;
      const isChannelMetadataEvent =
        typeof event.eventType === 'string' &&
        (event.eventType.startsWith('channel_') ||
          event.eventType.startsWith('category_'));
      if (
        !isChannelMetadataEvent &&
        eventChannelId !== selectedReticulumChannelId
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
          (event.authorAddress === myAddress ? myName : undefined),
        timestamp: event.timestamp,
        data: event.encryptedPayload,
        chatReference: event.targetEventId || undefined,
        eventType: event.eventType,
        repliedTo: event.replyToEventId || undefined,
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
        normalizedText
      ) {
        void window.reticulumChat?.indexSearchText?.(
          event.targetEventId,
          normalizedText
        );
        void window.reticulumChat?.replaceMentions?.(
          event.targetEventId,
          mentionedAddresses
        );
      } else if (
        (event.eventType === 'message' ||
          event.eventType === 'attachment_manifest') &&
        normalizedText
      ) {
        void window.reticulumChat?.indexSearchText?.(
          event.eventId,
          normalizedText
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
      myAddress,
      myName,
      refreshReticulumChannels,
      reticulumChatEnabled,
      resolveMentionedAddresses,
      selectedGroup,
      selectedReticulumChannelId,
    ]
  );

  useEffect(() => {
    if (!reticulumChatEnabled || reticulumChatEvents.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const event of reticulumChatEvents) {
        const eventId = typeof event?.eventId === 'string' ? event.eventId : '';
        if (eventId && appliedReticulumEventIdsRef.current.has(eventId))
          continue;
        const item = await convertReticulumEventToChatItem(event);
        if (!cancelled && item) {
          applyReticulumChatItem(item);
          if (eventId) appliedReticulumEventIdsRef.current.add(eventId);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    applyReticulumChatItem,
    convertReticulumEventToChatItem,
    reticulumChatEnabled,
    reticulumChatEvents,
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

  const openQManager = useCallback(() => {
    setIsOpenQManager(true);
  }, []);

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
      const dimensions = isImage ? await getImageFileDimensions(file) : null;
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      const needsBase64ImagePayload = isImage && !filePath;
      const base64 = needsBase64ImagePayload
        ? await fileToBase64(file)
        : undefined;
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
    },
    [
      chatImagesToSave,
      getImageFileDimensions,
      insertImage,
      isDeleteImage,
      isPrivate,
      onEditMessage,
      pendingReticulumFiles.length,
      reticulumChatEnabled,
      t,
    ]
  );

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

  const openCreateReticulumChannelDialog = useCallback((categoryId = '') => {
    setNewReticulumChannelCategoryId(categoryId);
    setNewReticulumChannelName('');
    setNewReticulumChannelError('');
    setIsCreateReticulumChannelOpen(true);
  }, []);

  const closeCreateReticulumChannelDialog = useCallback(() => {
    setIsCreateReticulumChannelOpen(false);
    setNewReticulumChannelName('');
    setNewReticulumChannelError('');
    setNewReticulumChannelCategoryId('');
  }, []);

  const createReticulumChannel = useCallback(async () => {
    const name = normalizeReticulumChannelName(newReticulumChannelName);
    if (!name) {
      setNewReticulumChannelError(
        'Use lowercase letters, numbers, and hyphens'
      );
      return;
    }
    if (reticulumChannelsForSelectedGroup.some((channel) => channel.name === name)) {
      setNewReticulumChannelError('Channel already exists');
      return;
    }
    const channelId =
      name === DEFAULT_RETICULUM_CHANNEL_ID
        ? DEFAULT_RETICULUM_CHANNEL_ID
        : `ch-${crypto.randomUUID?.() || `${Date.now()}-${uid.rnd()}`}`;
    const categoryIds = new Set(
      reticulumCategoriesForSelectedGroup.map((category) => category.categoryId)
    );
    const categoryId = categoryIds.has(newReticulumChannelCategoryId)
      ? newReticulumChannelCategoryId
      : '';
    const position = reticulumChannelsByCategory.get(categoryId)?.length ?? 0;
    await publishReticulumChannelMetadata('channel_create', {
      channelId,
      categoryId,
      name,
      position,
    });
    setSelectedReticulumChannelId(channelId);
    closeCreateReticulumChannelDialog();
  }, [
    closeCreateReticulumChannelDialog,
    newReticulumChannelCategoryId,
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
      setReticulumChannelError('');
      setReticulumChannelSettingsOpen(true);
    },
    []
  );

  const closeReticulumChannelSettings = useCallback(() => {
    setReticulumChannelSettingsOpen(false);
    setEditingReticulumChannel(null);
    setReticulumChannelName('');
    setReticulumChannelError('');
  }, []);

  const saveReticulumChannelSettings = useCallback(async () => {
    if (!editingReticulumChannel) return;
    const name = normalizeReticulumChannelName(reticulumChannelName);
    if (!name) {
      setReticulumChannelError('Use lowercase letters, numbers, and hyphens');
      return;
    }
    const duplicate = reticulumChannelsForSelectedGroup.some(
      (channel) =>
        channel.channelId !== editingReticulumChannel.channelId &&
        channel.name === name
    );
    if (duplicate) {
      setReticulumChannelError('Channel already exists');
      return;
    }
    await publishReticulumChannelMetadata('channel_update', {
      channelId: editingReticulumChannel.channelId,
      categoryId: editingReticulumChannel.categoryId || '',
      name,
      position: editingReticulumChannel.position,
    });
    closeReticulumChannelSettings();
  }, [
    closeReticulumChannelSettings,
    editingReticulumChannel,
    publishReticulumChannelMetadata,
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
  }, []);

  const saveReticulumCategory = useCallback(async () => {
    const name = normalizeReticulumChannelName(reticulumCategoryName);
    if (!name) {
      setReticulumCategoryError('Use lowercase letters, numbers, and hyphens');
      return;
    }
    const duplicate = reticulumCategoriesForSelectedGroup.some(
      (category) =>
        category.name === name &&
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

  const archiveReticulumChannel = useCallback(
    async (channel: ReticulumGroupChannel) => {
      if (channel.channelId === DEFAULT_RETICULUM_CHANNEL_ID) return;
      await publishReticulumChannelMetadata('channel_archive', {
        channelId: channel.channelId,
      });
      setSelectedReticulumChannelId(DEFAULT_RETICULUM_CHANNEL_ID);
    },
    [publishReticulumChannelMetadata]
  );

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
        padding: '10px',
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
              borderRight: `1px solid ${theme.palette.divider}`,
              flexShrink: 0,
              mr: 1.5,
              overflowY: 'auto',
              pr: 1.5,
              width: { xs: 132, sm: 180, md: 220 },
            }}
          >
            <Box
              sx={{
                alignItems: 'center',
                display: 'flex',
                justifyContent: 'space-between',
                mb: 1,
              }}
            >
              <Typography
                sx={{
                  color: 'text.secondary',
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                }}
              >
                Channels
              </Typography>
              {isReticulumChannelAdmin && (
                <Box sx={{ display: 'inline-flex', gap: 0.5 }}>
                  <Tooltip title="Create category">
                    <IconButton
                      size="small"
                      onClick={openCreateReticulumCategoryDialog}
                      sx={{ color: 'text.secondary' }}
                    >
                      <CategoryOutlinedIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Create channel">
                    <IconButton
                      size="small"
                      onClick={() => openCreateReticulumChannelDialog()}
                      sx={{ color: 'text.secondary' }}
                    >
                      <AddIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                </Box>
              )}
            </Box>
            <DndContext
              collisionDetection={closestCenter}
              onDragEnd={(event) => {
                void handleReticulumChannelDragEnd(event);
              }}
              sensors={reticulumChannelDndSensors}
            >
              <SortableContext
                items={reticulumChannelDragItems}
                strategy={verticalListSortingStrategy}
              >
                <ReticulumCategoryDropZone
                  disabled={!isReticulumChannelAdmin}
                  id={reticulumCategoryDropId('')}
                >
                  {(reticulumChannelsByCategory.get('') ?? []).map(
                    renderReticulumChannelButton
                  )}
                </ReticulumCategoryDropZone>
                {reticulumCategoriesForSelectedGroup.map((category) => {
                  const channels =
                    reticulumChannelsByCategory.get(category.categoryId) ?? [];
                  const isCollapsed = collapsedReticulumCategoryIds.has(
                    category.categoryId
                  );
                  return (
                    <ReticulumCategoryDropZone
                      key={category.categoryId}
                      disabled={!isReticulumChannelAdmin}
                      id={reticulumCategoryDropId(category.categoryId)}
                    >
                      <Box
                        sx={{
                          alignItems: 'center',
                          color: 'text.secondary',
                          display: 'flex',
                          fontSize: 12,
                          fontWeight: 800,
                          justifyContent: 'space-between',
                          minHeight: 28,
                          mt: 1.25,
                          px: 0.5,
                          textTransform: 'uppercase',
                          userSelect: 'none',
                        }}
                        onContextMenu={(event) =>
                          openReticulumCategoryContextMenu(event, category)
                        }
                      >
                        <Box
                          component="button"
                          onClick={() =>
                            toggleReticulumCategoryCollapsed(
                              category.categoryId
                            )
                          }
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
                          {isCollapsed ? (
                            <ChevronRightRoundedIcon sx={{ fontSize: 16 }} />
                          ) : (
                            <ExpandMoreRoundedIcon sx={{ fontSize: 16 }} />
                          )}
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
                        </Box>
                        {isReticulumChannelAdmin && (
                          <Tooltip title={`Create channel in ${category.name}`}>
                            <IconButton
                              size="small"
                              onClick={(event) => {
                                event.stopPropagation();
                                openCreateReticulumChannelDialog(
                                  category.categoryId
                                );
                              }}
                              sx={{
                                color: 'text.secondary',
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
                      {!isCollapsed &&
                        channels.map(renderReticulumChannelButton)}
                    </ReticulumCategoryDropZone>
                  );
                })}
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
            <Typography
              sx={{
                borderBottom: `1px solid ${theme.palette.divider}`,
                flexShrink: 0,
                fontSize: 18,
                fontWeight: 700,
                mb: 1,
                pb: 1,
              }}
            >
              #{' '}
              {reticulumChannelsForSelectedGroup.find(
                (channel) => channel.channelId === selectedReticulumChannelId
              )?.name || selectedReticulumChannelId}
            </Typography>
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
            onDelete={onDelete}
            onEdit={onEdit}
            onReply={onReply}
            openQManager={openQManager}
            reticulumChatEnabled={reticulumChatEnabled}
            selectedGroup={selectedGroup}
            secretKeyObject={secretKey}
            tempChatReferences={tempChatReferences}
            tempMessages={tempMessages}
          />

          {(reticulumChatEnabled || !!secretKey || isPrivate === false) && (
            <Box
              sx={{
                alignItems: 'flex-end',
                backgroundColor: theme.palette.background.default,
                border: `1px solid ${theme.palette.divider}`,
                borderRadius: '8px',
                bottom: isFocusedParent ? '0px' : 'unset',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'row',
                flexShrink: 0,
                gap: '12px',
                minHeight: '150px',
                overflow: 'hidden',
                padding: '16px 20px 20px',
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
                  justifyContent: 'flex-end',
                  minWidth: 0,
                  overflow: 'auto',
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
                  isChat
                  disableEnter={false}
                  isFocusedParent={isFocusedParent}
                  setIsFocusedParent={setIsFocusedParent}
                  membersWithNames={members}
                  insertImage={insertImage}
                  insertFiles={insertFiles}
                />
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
                  paddingBottom: '2px',
                }}
              >
                <CustomButton
                  onClick={() => {
                    if (isSending) return;
                    sendMessage();
                  }}
                  sx={{
                    alignItems: 'center',
                    backgroundColor: isSending
                      ? theme.palette.action.disabledBackground
                      : theme.palette.background.paper,
                    border: '1px solid',
                    borderColor: theme.palette.divider,
                    borderRadius: '8px',
                    color: theme.palette.text.primary,
                    cursor: isSending ? 'default' : 'pointer',
                    display: 'inline-flex',
                    gap: '6px',
                    fontSize: '14px',
                    fontWeight: 500,
                    justifyContent: 'center',
                    minHeight: '44px',
                    minWidth: '88px',
                    padding: '10px 16px',
                    position: 'relative',
                    transition:
                      'background-color 0.2s ease, border-color 0.2s ease',
                    '&:hover': isSending
                      ? {}
                      : {
                          backgroundColor: theme.palette.action.hover,
                          borderColor: theme.palette.divider,
                        },
                  }}
                >
                  {isSending ? (
                    <CircularProgress
                      size={18}
                      sx={{ color: theme.palette.text.secondary }}
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

      <Dialog
        open={isCreateReticulumChannelOpen}
        onClose={closeCreateReticulumChannelDialog}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Create text channel</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Channel name"
            value={newReticulumChannelName}
            error={Boolean(newReticulumChannelError)}
            helperText={
              newReticulumChannelError ||
              (newReticulumChannelCategoryId
                ? `Creates inside ${
                    reticulumCategoriesForSelectedGroup.find(
                      (category) =>
                        category.categoryId === newReticulumChannelCategoryId
                    )?.name || 'selected category'
                  }`
                : 'Example: support-chat')
            }
            onChange={(event) => {
              setNewReticulumChannelName(event.target.value);
              if (newReticulumChannelError) setNewReticulumChannelError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void createReticulumChannel();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeCreateReticulumChannelDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void createReticulumChannel()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={reticulumChannelSettingsOpen}
        onClose={closeReticulumChannelSettings}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Channel settings</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Channel name"
            value={reticulumChannelName}
            error={Boolean(reticulumChannelError)}
            helperText={reticulumChannelError || 'Example: support-chat'}
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
          {editingReticulumChannel?.channelId !==
            DEFAULT_RETICULUM_CHANNEL_ID && (
            <Button
              color="error"
              startIcon={<DeleteOutlineRoundedIcon />}
              onClick={() => {
                if (!editingReticulumChannel) return;
                void archiveReticulumChannel(editingReticulumChannel).then(() => {
                  closeReticulumChannelSettings();
                });
              }}
              sx={{ mt: 2 }}
            >
              Remove channel
            </Button>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeReticulumChannelSettings}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void saveReticulumChannelSettings()}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={isReticulumCategoryDialogOpen}
        onClose={closeReticulumCategoryDialog}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>
          {reticulumCategoryDialogMode === 'rename'
            ? 'Rename category'
            : 'Create category'}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Category name"
            value={reticulumCategoryName}
            error={Boolean(reticulumCategoryError)}
            helperText={reticulumCategoryError || 'Example: project-chat'}
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
        <DialogActions>
          <Button onClick={closeReticulumCategoryDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void saveReticulumCategory()}
          >
            {reticulumCategoryDialogMode === 'rename' ? 'Save' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

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
                      top: true,
                      left: true,
                      topLeft: true,
                      topRight: false,
                      right: false,
                      bottom: false,
                      bottomLeft: false,
                      bottomRight: false,
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
                  borderBottom: 'none',
                  borderRadius: '8px 8px 0 0',
                  boxShadow:
                    theme.palette.mode === 'dark'
                      ? `0 -18px 46px ${alpha(theme.palette.common.black, 0.46)}, 0 -1px 0 ${alpha(theme.palette.common.white, 0.05)}`
                      : `0 -14px 36px ${alpha(theme.palette.common.black, 0.16)}, 0 -1px 0 ${alpha(theme.palette.common.white, 0.72)}`,
                  display: 'flex',
                  flexDirection: 'column',
                  height: '100%',
                  maxHeight: `calc(100vh - ${appHeighOffsetPx})`,
                  maxWidth: '100vw',
                  minHeight: Q_MANAGER_MIN_HEIGHT,
                  minWidth: Q_MANAGER_MIN_WIDTH,
                  overflow: 'hidden',
                  position: 'relative',
                  width: '100%',
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
