import {
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
  ButtonBase,
  IconButton,
  Portal,
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
import ImageIcon from '@mui/icons-material/Image';
import SendIcon from '@mui/icons-material/Send';
import { messageHasImage } from '../../utils/chat';
import { useTranslation } from 'react-i18next';
import { useReticulumGroupChat } from '../../hooks/useReticulumGroupChat';
import { generateHTML } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Mention from '@tiptap/extension-mention';
import TextStyle from '@tiptap/extension-text-style';
import { getGroupMembers } from '../Group/groupApi';

const uid = new ShortUniqueId({ length: 5 });
const uidImages = new ShortUniqueId({ length: 12 });
const Q_MANAGER_DEFAULT_WIDTH = 400;
const Q_MANAGER_DEFAULT_HEIGHT = 600;
const Q_MANAGER_MIN_WIDTH = 360;
const Q_MANAGER_MIN_HEIGHT = 420;
const Q_MANAGER_HEADER_HEIGHT = 40;

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

const buildMentionAddressHashes = async (addresses: string[]) =>
  [
    ...new Set(
      await Promise.all(
        addresses
          .map((address) => address.trim())
          .filter(Boolean)
          .map((address) => mentionAddressHash(address))
      )
    ),
  ];

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

const mentionedAddressesFromPayload = (payload: unknown): string[] => {
  if (!payload || typeof payload !== 'object') return [];
  const value = (payload as { mentionedAddresses?: unknown }).mentionedAddresses;
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
  } = useReticulumGroupChat(selectedGroup);
  const reticulumChatEnabledRef = useRef(false);
  const [, forceUpdate] = useReducer((x) => x + 1, 0);
  const lastReadTimestamp = useRef(null);
  const handleUpdateRef = useRef(null);
  const iframeRef = useRef(null);
  const appliedReticulumEventIdsRef = useRef<Set<string>>(new Set());
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
      const addressMatches = rawText.match(/@Q[1-9A-HJ-NP-Za-km-z]{20,}/g) || [];
      for (const match of addressMatches) {
        mentioned.add(match.slice(1));
      }
      return [...mentioned];
    },
    [mentionNameToAddress]
  );

  const members = useMemo(() => {
    const uniqueMembers = new Set();
    groupMentionMembers.forEach((member) => {
      if (member.name) uniqueMembers.add(member.name);
    });
    messages.forEach((message) => {
      if (message?.senderName) {
        uniqueMembers.add(message?.senderName);
      }
    });

    return Array.from(uniqueMembers);
  }, [groupMentionMembers, messages]);

  const setEditorRef = (editorInstance) => {
    editorRef.current = editorInstance;
  };

  const tempMessages = useMemo(() => {
    if (!selectedGroup) return [];
    if (queueChats[selectedGroup]) {
      return queueChats[selectedGroup]?.filter((item) => !item?.chatReference);
    }
    return [];
  }, [selectedGroup, queueChats]);

  const tempChatReferences = useMemo(() => {
    if (!selectedGroup) return [];
    if (queueChats[selectedGroup]) {
      return queueChats[selectedGroup]?.filter((item) => !!item?.chatReference);
    }
    return [];
  }, [selectedGroup, queueChats]);

  const secretKeyRef = useRef(null);

  useEffect(() => {
    if (secretKey) {
      secretKeyRef.current = secretKey;
    }
  }, [secretKey]);

  useEffect(() => {
    appliedReticulumEventIdsRef.current.clear();
  }, [selectedGroup]);

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
      targetEventId,
      replyToEventId,
      mentionAddressHashes = [],
    }: {
      encryptedPayload: string;
      eventType:
        | 'message'
        | 'edit'
        | 'delete'
        | 'reaction_add'
        | 'reaction_remove'
        | 'attachment_manifest';
      targetEventId?: string;
      replyToEventId?: string;
      mentionAddressHashes?: string[];
    }) => {
      const groupId = Number(selectedGroup);
      if (!reticulumChatEnabled || !Number.isInteger(groupId) || groupId <= 0) {
        return { success: false, error: 'Reticulum chat is disabled' };
      }
      const timestamp = Date.now();
      const eventId = crypto.randomUUID?.() || `${timestamp}-${uid.rnd()}`;
      const payloadHash = await sha256Hex(encryptedPayload);
      const baseFields = {
        eventId,
        groupId,
        authorSeq: nextReticulumAuthorSeq(groupId, myAddress),
        timestamp,
        eventType,
        targetEventId: targetEventId ?? null,
        replyToEventId: replyToEventId ?? null,
        encryptedPayload,
        payloadHash,
        mentionAddressHashes,
      };
      const signed = await window.sendMessage('signReticulumChatEvent', baseFields);
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
    [myAddress, publishReticulumChatEvent, reticulumChatEnabled, selectedGroup]
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

  const applyReticulumChatItem = useCallback((item) => {
    if (!item || isChatSenderBlocked(item)) return;
    const processed = processWithNewMessages([item], selectedGroup);
    const nextItem = processed?.[0] || item;
    const targetReference = nextItem.chatReference;
    const itemType =
      nextItem?.eventType || nextItem?.decryptedData?.type || nextItem?.type;

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
      (itemType === 'edit' || nextItem?.isEdited || itemType === 'reaction')
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
        organized[targetReference].reactions[content] =
          organized[targetReference].reactions[content].filter(
            (reaction) => reaction.sender !== sender
        );
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
  }, [isChatSenderBlocked, processWithNewMessages, selectedGroup]);

  const convertReticulumEventToChatItem = useCallback(
    async (event) => {
      if (!event || Number(event.groupId) !== Number(selectedGroup)) return null;
      const baseItem = {
        signature: event.eventId,
        id: event.eventId,
        groupId: event.groupId,
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
      if (isPrivate === false) {
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
        ...(decryptedData.message !== undefined ? { message: normalizedText } : {}),
        ...(decryptedData.messageText !== undefined ? { messageText: normalizedText } : {}),
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
      };
      return {
        ...baseItem,
        ...normalizedDecryptedData,
        decryptedData: normalizedDecryptedData,
        text: normalizedText,
        eventType: event.eventType,
        isNotEncrypted: isPrivate === false,
        unread: event.authorAddress === myAddress ? false : true,
      };
    },
    [isPrivate, myAddress, myName, resolveMentionedAddresses, selectedGroup]
  );

  useEffect(() => {
    if (!reticulumChatEnabled || reticulumChatEvents.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const event of reticulumChatEvents) {
        const eventId = typeof event?.eventId === 'string' ? event.eventId : '';
        if (eventId && appliedReticulumEventIdsRef.current.has(eventId)) continue;
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
      !selectedGroup ||
      reticulumChatEvents.length === 0
    ) {
      return;
    }
    const groupId = Number(selectedGroup);
    if (!Number.isInteger(groupId) || groupId <= 0) return;
    const latestTimestamp = reticulumChatEvents.reduce((latest, event: any) => {
      if (Number(event?.groupId) !== groupId) return latest;
      const timestamp = Number(event?.timestamp);
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
    }, 0);
    if (latestTimestamp <= 0) return;
    void window.reticulumChat?.markRead?.(
      groupId,
      latestTimestamp,
      myAddress
    ).then(() => {
      executeEvent('reticulum-chat-summaries-refresh', {});
    });
  }, [isActive, myAddress, reticulumChatEnabled, reticulumChatEvents, selectedGroup]);

  const clearEditorContent = () => {
    if (editorRef.current) {
      setMessageSize(0);
      editorRef.current.chain().focus().clearContent().run();
    }
  };

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
        if (
          (!htmlContent?.trim() || htmlContent?.trim() === '<p></p>') &&
          !hasImage &&
          !deleteImage
        )
          return;
        if (htmlContent?.trim() === '<p></p>') {
          htmlContent = null;
        }
        setIsSending(true);
        const message =
          isPrivate === false
            ? !htmlContent
              ? '<p></p>'
              : editorRef.current.getJSON()
            : htmlContent;
        const secretKeyObject = await getSecretKey(false, true);

        let repliedTo = replyMessage?.signature;

        if (replyMessage?.chatReference) {
          repliedTo = replyMessage?.chatReference;
        }

        const chatReference = onEditMessage?.signature;

        const publicData = isPrivate
          ? {}
          : {
              isEdited: chatReference ? true : false,
            };

        interface ImageToPublish {
          service: string;
          identifier: string;
          name: string;
          base64: string;
        }

        const imagesToPublish: ImageToPublish[] = [];

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
          reticulumChatEnabled && chatImagesToSave?.length > 0
            ? await Promise.all(
                chatImagesToSave.map(async (base64, index) => {
                  const imageMimeType = 'image/webp';
                  const resourceBase64 =
                    isPrivate === true
                      ? await encryptChatMessage(
                          await objectToBase64({
                            imageBase64: base64,
                            mimeType: imageMimeType,
                            version: 1,
                          }),
                          secretKeyObject
                        )
                      : base64;
                  const imported = await window.reticulumResources?.importBase64?.({
                    base64: resourceBase64,
                    namespace: 'reticulum-chat-image',
                    ownerId: `${selectedGroup}:${myAddress}`,
                    fileName: `chat-image-${Date.now()}-${index}.webp`,
                    mimeType:
                      isPrivate === true
                        ? 'application/qortal-encrypted-reticulum-resource'
                        : imageMimeType,
                    encrypted: isPrivate === true,
                    metadata: {
                      feature: 'reticulum-chat',
                      groupId: selectedGroup,
                      originalMimeType: imageMimeType,
                    },
                  });
                  if (!imported?.success || !imported.manifest) {
                    throw new Error(
                      imported?.error || 'Reticulum image resource import failed'
                    );
                  }
                  return {
                    ...(imported.manifest as Record<string, unknown>),
                    reticulumResource: true,
                    timestamp: Date.now(),
                  };
                })
              )
            : null;

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
        const mentionedAddressHashes =
          await buildMentionAddressHashes(mentionedAddresses);
        const otherData = {
          repliedTo,
          ...(onEditMessage?.decryptedData || {}),
          type: chatReference ? 'edit' : '',
          specialId: uid.rnd(),
          images: images,
          mentionedAddresses,
          ...publicData,
        };
        const objectMessage = {
          ...(otherData || {}),
          [isPrivate ? 'message' : 'messageText']: message,
          version: 3,
        };
        const message64: any = await objectToBase64(objectMessage);

        const encryptSingle =
          isPrivate === false
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
        addToQueue(sendMessageFunc, messageObj, 'chat', selectedGroup);
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
        if (isPrivate) {
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
  }, [editorRef, setMessageSize, isPrivate]);

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
        .setContent(normalizeChatHtmlContent(message?.messageText || message?.text))
        .run();
    } catch (error) {
      console.error(error);
    }
  }, []);

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
        const secretKeyObject = await getSecretKey(false, true);
        const objectMessage = {
          message: '',
          type: 'delete',
          targetEventId,
          specialId: uid.rnd(),
          version: 3,
        };
        const message64: any = await objectToBase64(objectMessage);
        const encryptedPayload =
          isPrivate === false
            ? JSON.stringify(objectMessage)
            : await encryptChatMessage(message64, secretKeyObject);
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
        const secretKeyObject = await getSecretKey(false, true);
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
          isPrivate === false
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
        addToQueue(sendMessageFunc, messageObj, 'chat-reaction', selectedGroup);
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
    [chatImagesToSave, onEditMessage?.images, isDeleteImage]
  );

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
      <ChatList
        chatId={selectedGroup}
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

      {(!!secretKey || isPrivate === false) && (
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
              isChat
              disableEnter={false}
              isFocusedParent={isFocusedParent}
              setIsFocusedParent={setIsFocusedParent}
              membersWithNames={members}
              insertImage={insertImage}
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
