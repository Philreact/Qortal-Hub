import {
  Box,
  ButtonBase,
  IconButton,
  Paper,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import {
  lazy,
  memo,
  Profiler,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { ChatGroup } from '../Chat/ChatGroup';
import { CreateCommonSecret } from '../Chat/CreateCommonSecret';
import { base64ToUint8Array } from '../../qdn/encryption/group-encryption';
import { uint8ArrayToObject } from '../../encryption/encryption';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import CallIcon from '@mui/icons-material/Call';
import CallEndRoundedIcon from '@mui/icons-material/CallEndRounded';
import CircularProgress from '@mui/material/CircularProgress';
import ChatRoundedIcon from '@mui/icons-material/ChatRounded';
import FolderRoundedIcon from '@mui/icons-material/FolderRounded';
import ForumRoundedIcon from '@mui/icons-material/ForumRounded';
import PeopleAltRoundedIcon from '@mui/icons-material/PeopleAltRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import SecurityRoundedIcon from '@mui/icons-material/SecurityRounded';
import SportsEsportsIcon from '@mui/icons-material/SportsEsports';

import {
  clearAllQueues,
  getBaseApiReact,
  pauseAllQueues,
  resumeAllQueues,
} from '../../App';
import { ChatDirect } from '../Chat/ChatDirect';
import { CustomizedSnackbars } from '../Snackbar/Snackbar';
import { LoadingButton } from '@mui/lab';
import { LoadingSnackbar } from '../Snackbar/LoadingSnackbar';
import { GroupAnnouncements } from '../Chat/GroupAnnouncements';
import { GroupForum } from '../Chat/GroupForum';
import {
  executeEvent,
  subscribeToEvent,
  unsubscribeFromEvent,
} from '../../utils/events';
import { WebSocketActive } from './WebsocketActive';
import { WebSocketNotifications } from './WebsocketNotifications';
import {
  getGroupAdmins,
  getGroupMembers,
  getNameInfo,
  getPublishesFromAdmins,
} from './groupApi';
import { timeDifferenceForNotificationChats } from './groupConstants';
import { decryptResource } from './groupDataPublishes';
import { requestQueueMemberNames } from './groupQueues';
import type { GroupProps } from './groupTypes';
import { areKeysEqual, validateSecretKey } from './groupValidation';
import { useMessageQueue } from '../../messaging/MessageQueueContext';
import { HomeDesktop } from './HomeDesktop';
import { DesktopHeader } from '../Desktop/DesktopHeader';
import { AppsDesktop } from '../Apps/AppsDesktop';
import { DesktopSideBar } from '../Desktop/DesktopLeftSideBar';
import { AdminSpace } from '../Chat/AdminSpace';
import {
  addressInfoControllerAtom,
  chatWidgetClosedAtom,
  enabledDevModeAtom,
  groupAnnouncementsAtom,
  groupChatTimestampsAtom,
  groupsOwnerNamesAtom,
  groupsPropertiesAtom,
  isDisabledEditorEnterAtom,
  isOpenBlockedModalAtom,
  isRunningPublicNodeAtom,
  memberGroupsAtom,
  memberGroupsWithReticulumChatAtom,
  mutedGroupsAtom,
  myGroupsWhereIAmAdminAtom,
  reticulumDirectSummariesAtom,
  reticulumChatSummariesAtom,
  reticulumChatEnabledAtom,
  selectedGroupIdAtom,
  timestampEnterDataAtom,
  userInfoAtom,
  qortalGroupVoiceCallMinimizedAtom,
  qortalGroupCallPrimaryNamesAtom,
  dmFriendsByAddressAtom,
} from '../../atoms/global';
import { mergeDirectsWithFriends } from '../../lib/dm/mergeDirectsWithFriends';
import { sortArrayByTimestampAndGroupName } from '../../utils/time';
import { WalletsAppWrapper } from './WalletsAppWrapper';
import { useTranslation } from 'react-i18next';
import { GroupList } from './GroupList';
import { ReticulumGroupAboutModal } from './ReticulumGroupAbout';
import { FirstTimeQChatEmptyState } from './FirstTimeQChatEmptyState';
import { ReturningUserActivityDashboard } from './ReturningUserActivityDashboard';
import { ReturningUserCaughtUpState } from './ReturningUserCaughtUpState';
import { startReticulumGroupScoreScheduler } from './reticulumGroupScore';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { useGroupCallContext } from '../../contexts/GroupCallContext';
import { useCallSwitchGuard } from '../../contexts/CallSwitchGuardContext';
import { traceGcallAudioSurface } from '../../lib/group-call/gcallAudioSurfaceTrace';
import {
  TIME_MINUTES_10_IN_MILLISECONDS,
  TIME_MINUTES_2_IN_MILLISECONDS,
  TIME_DAYS_1_IN_MILLISECONDS,
} from '../../constants/constants';
import { useWebsocketStatus } from './useWebsocketStatus';
import { DirectsSidebar } from './DirectsSidebar';
import { GlobalChatWidget } from './GlobalChatWidget';
import { openQChatTab, QCHAT_INTERNAL_TAB_ID } from '../../utils/openQChatTab';
import {
  AdminRowBox,
  CenterBox,
  ChatContentBox,
  EncryptionKeyMessageDiv,
  FloatingButtonContainerBox,
  InnerChatBox,
  MainContentBox,
  NewChatOverlay,
  NoSelectionTypography,
  NotPartAdminListBox,
  NotPartGroupDiv,
  RootBox,
  SelectedDirectOverlay,
  SelectedGroupWrapper,
} from './Group.styles';

const RETICULUM_ACTIVE_BLUE = '#2563eb';

// Keeps the Reticulum chat tree out of unrelated Group-shell re-renders. The
// legacy ChatGroup instance below deliberately retains its existing behavior.
const ReticulumChatGroup = memo(ChatGroup);

const LazyAddGroup = lazy(() =>
  import('./AddGroup').then((m) => ({ default: m.AddGroup }))
);
const LazyFindGroupModal = lazy(() =>
  import('./FindGroupModal').then((m) => ({ default: m.FindGroupModal }))
);
const LazyManageMembers = lazy(() =>
  import('./ManageMembers').then((m) => ({ default: m.ManageMembers }))
);
const LazyBlockedUsersModal = lazy(() =>
  import('./BlockedUsersModal').then((m) => ({ default: m.BlockedUsersModal }))
);
const LazyQortalLand = lazy(() =>
  import('../QortalLand/QortalLand').then((m) => ({ default: m.QortalLand }))
);

// Re-export for backward compatibility with existing imports from Group.tsx
export {
  getAllPublishesFromAdmins,
  getGroupAdmins,
  getGroupAdminsAddress,
  getNameInfo,
  getNames,
  getNamesForAdmins,
  getGroupMembers,
  getPublishesFromAdmins,
} from './groupApi';
export { timeDifferenceForNotificationChats } from './groupConstants';
export {
  addDataPublishesFunc,
  decryptResource,
  getDataPublishesFunc,
} from './groupDataPublishes';
export {
  requestQueueAdminMemberNames,
  requestQueueMemberNames,
} from './groupQueues';
export type { GroupProps } from './groupTypes';
export { validateSecretKey } from './groupValidation';

type ReticulumBackgroundEvent = {
  authorAddress?: string;
  authorPrimaryName?: string;
  channelId?: string;
  encryptedPayload?: string;
  eventId?: string;
  eventType?: string;
  groupId?: number;
  targetEventId?: string;
  timestamp?: number;
};

type ReticulumNotificationSummary = {
  groupId?: number;
  channelId?: string;
  lastEvent?: ReticulumBackgroundEvent | null;
  unreadCount?: number;
  mentionCount?: number;
  hasUnreadMention?: boolean;
  updatedAt?: number;
  channels?: ReticulumNotificationSummary[];
};

const getReticulumMentionBadgeCount = (
  summaries: Record<string, ReticulumNotificationSummary>
): number => {
  return Object.values(summaries || {}).reduce((total, summary) => {
    return total + Math.max(0, Number(summary?.mentionCount) || 0);
  }, 0);
};

const getReticulumSummaryMentionCount = (
  summary: ReticulumNotificationSummary | undefined
): number => {
  if (!summary) return 0;
  return Math.max(0, Number(summary?.mentionCount) || 0);
};

const getReticulumChannelMentionCount = (
  summary: ReticulumNotificationSummary | undefined,
  channelId: string
): number => {
  if (!summary) return 0;
  const targetChannelId = String(channelId || 'general');
  const channels = Array.isArray(summary?.channels) ? summary.channels : [];
  const channelSummary = channels.find(
    (channel) => String(channel?.channelId || 'general') === targetChannelId
  );
  if (channelSummary) return getReticulumSummaryMentionCount(channelSummary);
  if (String(summary?.channelId || '') === targetChannelId) {
    return getReticulumSummaryMentionCount(summary);
  }
  return 0;
};

const getReticulumMentionBadgeStateForRefresh = (
  previous: Record<string, ReticulumNotificationSummary> | null,
  next: Record<string, ReticulumNotificationSummary>,
  activeGroupId: number | null,
  activeChannelId: string
): {
  count: number;
  summaries: Record<string, ReticulumNotificationSummary>;
} => {
  if (!previous)
    return { count: getReticulumMentionBadgeCount(next), summaries: next };
  const groupIds = new Set([...Object.keys(previous), ...Object.keys(next)]);
  let total = 0;
  const summaries: Record<string, ReticulumNotificationSummary> = {};
  for (const groupIdKey of groupIds) {
    const previousSummary = previous[groupIdKey];
    const nextSummary = next[groupIdKey];
    const previousCount = getReticulumSummaryMentionCount(previousSummary);
    const nextCount = getReticulumSummaryMentionCount(nextSummary);
    if (nextCount >= previousCount) {
      total += nextCount;
      if (nextSummary) summaries[groupIdKey] = nextSummary;
      continue;
    }
    const groupId = Number(groupIdKey);
    const allowDrop =
      Number.isInteger(groupId) && groupId === activeGroupId && activeChannelId
        ? Math.max(
            0,
            getReticulumChannelMentionCount(previousSummary, activeChannelId) -
              getReticulumChannelMentionCount(nextSummary, activeChannelId)
          )
        : 0;
    const droppedCount = Math.min(previousCount - nextCount, allowDrop);
    total += previousCount - droppedCount;
    if (droppedCount >= previousCount - nextCount) {
      if (nextSummary) summaries[groupIdKey] = nextSummary;
    } else if (previousSummary) {
      summaries[groupIdKey] = previousSummary;
    }
  }
  return { count: total, summaries };
};

const RETICULUM_BACKGROUND_PROCESSED_EVENT_TTL_MS = 2 * 60 * 60_000;
const RETICULUM_BACKGROUND_PROCESSED_EVENT_MAX = 10_000;
const RETICULUM_DIRECT_NAME_RETRY_DELAY_MS = 5 * 60_000;
const RETICULUM_OS_NOTIFICATION_EVENT_TYPES = new Set([
  'message',
  'attachment_manifest',
]);
const RETICULUM_OS_NOTIFICATION_MAX_TRACKED = 500;

const getGroupIdFromGroupLike = (group: unknown): number | null => {
  if (!group || typeof group !== 'object') return null;
  const candidate =
    (group as { groupId?: unknown }).groupId ??
    (group as { groupid?: unknown }).groupid ??
    (group as { group_id?: unknown }).group_id ??
    (group as { id?: unknown }).id;
  const groupId = Number(candidate);
  return Number.isInteger(groupId) && groupId > 0 ? groupId : null;
};

const getGroupIdsFromGroupLikeList = (groups: unknown): number[] => {
  if (!Array.isArray(groups)) return [];
  return [
    ...new Set(
      groups
        .map(getGroupIdFromGroupLike)
        .filter((groupId): groupId is number => groupId != null)
    ),
  ];
};

const getReticulumGroupMembershipsFromGroupLikeList = (
  groups: unknown,
  groupsProperties: Record<string, unknown>,
  localAddress: string | undefined,
  adminGroupIds: ReadonlySet<number>
): Array<{
  groupId: number;
  isPrivate: boolean;
  isAdmin: boolean;
  localAddress?: string;
}> => {
  if (!Array.isArray(groups)) return [];
  const byGroupId = new Map<number, boolean>();
  const normalizedLocalAddress =
    typeof localAddress === 'string' ? localAddress.trim() : '';
  for (const group of groups) {
    const groupId = getGroupIdFromGroupLike(group);
    if (groupId == null) continue;
    const groupObject =
      group && typeof group === 'object'
        ? (group as { isOpen?: unknown; isPrivate?: unknown })
        : {};
    const groupProperty = groupsProperties[String(groupId)] as
      | { isOpen?: unknown; isPrivate?: unknown }
      | undefined;
    const isPrivate =
      groupObject.isPrivate === true ||
      groupProperty?.isPrivate === true ||
      groupObject.isOpen === false ||
      groupProperty?.isOpen === false;
    byGroupId.set(groupId, byGroupId.get(groupId) === true || isPrivate);
  }
  return [...byGroupId.entries()].map(([groupId, isPrivate]) => ({
    groupId,
    isPrivate,
    isAdmin: adminGroupIds.has(groupId),
    ...(normalizedLocalAddress ? { localAddress: normalizedLocalAddress } : {}),
  }));
};

const collectReticulumPlainText = (value: unknown, out: string[]): void => {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReticulumPlainText(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, next] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'type' || key === 'isEdited' || key === 'mentionedAddresses') {
      continue;
    }
    collectReticulumPlainText(next, out);
  }
};

const reticulumTextFromPayload = (payload: unknown): string => {
  const strings: string[] = [];
  collectReticulumPlainText(payload, strings);
  return strings
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const parseReticulumPublicPayload = (value: unknown): unknown => {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const reticulumChannelDisplayName = (channelId?: string): string =>
  `#${String(channelId || 'general').replace(/^#/, '')}`;

const reticulumMentionedAddressesFromPayload = (payload: unknown): string[] => {
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

const resolveReticulumMentionAddresses = (
  text: string,
  nameToAddress: Map<string, string>
): string[] => {
  const rawText = String(text || '');
  const lowerText = rawText.toLowerCase();
  const mentioned = new Set<string>();
  for (const [name, address] of nameToAddress.entries()) {
    if (!name || !address) continue;
    if (lowerText.includes(`@${name}`)) mentioned.add(address);
  }
  const addressMatches = rawText.match(/@Q[1-9A-HJ-NP-Za-km-z]{20,}/g) || [];
  for (const match of addressMatches) {
    mentioned.add(match.slice(1));
  }
  return [...mentioned];
};

/** Subscribes to memberGroupsAtom and runs effects (Group does not subscribe). */
function MemberGroupsEffects({
  getGroupsWhereIAmAMember,
  getGroupsProperties,
  myAddress,
  groupsPropertiesRef,
  hasInitializedWebsocketRef,
}: {
  getGroupsWhereIAmAMember: (groups: any[]) => Promise<boolean>;
  getGroupsProperties: (address: string) => void;
  myAddress: string;
  groupsPropertiesRef: React.MutableRefObject<Record<string, unknown>>;
  hasInitializedWebsocketRef: React.MutableRefObject<boolean>;
}) {
  const memberGroups = useAtomValue(memberGroupsAtom);
  useEffect(() => {
    if (!myAddress) return;
    let cancelled = false;
    let refreshTimer: number | null = null;
    const refresh = async () => {
      const succeeded = await getGroupsWhereIAmAMember(memberGroups || []);
      if (cancelled) return;
      refreshTimer = window.setTimeout(
        refresh,
        succeeded ? TIME_MINUTES_10_IN_MILLISECONDS / 2 : 10_000
      );
    };
    void refresh();
    return () => {
      cancelled = true;
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
    };
  }, [memberGroups, myAddress, getGroupsWhereIAmAMember]);
  useEffect(() => {
    if (!myAddress) return;
    if (
      !areKeysEqual(
        getGroupIdsFromGroupLikeList(memberGroups),
        Object.keys(groupsPropertiesRef.current || {})
      )
    ) {
      getGroupsProperties(myAddress);
    }
  }, [memberGroups, myAddress, getGroupsProperties, groupsPropertiesRef]);
  useEffect(() => {
    if (
      !myAddress ||
      hasInitializedWebsocketRef.current ||
      !memberGroups?.length
    )
      return;
    window.sendMessage('setupGroupWebsocket', {}).catch((error: Error) => {
      console.error(
        'Failed to setup group websocket:',
        error?.message || 'An error occurred'
      );
    });
    hasInitializedWebsocketRef.current = true;
  }, [myAddress, memberGroups, hasInitializedWebsocketRef]);
  return null;
}

function ReticulumSectionLayer({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: active ? 'flex' : 'none',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      {children}
    </Box>
  );
}

function ReticulumGroupSectionHeader({
  activeSection,
  canManageReticulumGroup,
  groupCallDisabled,
  groupCallInCall,
  groupCallJoining,
  groupCallTooltip,
  membersPanelOpen,
  onChatClick,
  onGroupCallClick,
  onMembersClick,
  onQortalLandClick,
  onThreadsClick,
  sectionLabel,
}: {
  activeSection: string;
  canManageReticulumGroup: boolean;
  groupCallDisabled?: boolean;
  groupCallInCall?: boolean;
  groupCallJoining?: boolean;
  groupCallTooltip?: string;
  membersPanelOpen?: boolean;
  onChatClick?: () => void;
  onGroupCallClick?: () => void;
  onMembersClick?: () => void;
  onQortalLandClick?: () => void;
  onThreadsClick?: () => void;
  sectionLabel: string;
}) {
  const theme = useTheme();
  const [isAdminMenuOpen, setIsAdminMenuOpen] = useState(false);
  const [isQManagerOpen, setIsQManagerOpen] = useState(false);

  useEffect(() => {
    const syncAdminMenu = (event: any) => {
      setIsAdminMenuOpen(Boolean(event?.detail?.open ?? event?.open));
    };
    const syncQManager = (event: any) => {
      setIsQManagerOpen(Boolean(event?.detail?.open ?? event?.open));
    };
    subscribeToEvent('reticulumAdminKeysOpenState', syncAdminMenu);
    subscribeToEvent('reticulumQManagerOpenState', syncQManager);
    return () => {
      unsubscribeFromEvent('reticulumAdminKeysOpenState', syncAdminMenu);
      unsubscribeFromEvent('reticulumQManagerOpenState', syncQManager);
    };
  }, []);
  const actionSx = (active?: boolean, showLabel?: boolean) => ({
    alignItems: 'center',
    borderRadius: '8px',
    color: active ? theme.palette.common.white : theme.palette.text.secondary,
    display: 'inline-flex',
    flexShrink: 0,
    fontFamily: 'Inter',
    fontSize: 12,
    fontWeight: 600,
    gap: showLabel ? 0.6 : 0,
    height: 36,
    justifyContent: 'center',
    lineHeight: 1,
    minWidth: showLabel ? 0 : 36,
    overflow: 'hidden',
    px: showLabel ? 1 : 0,
    textAlign: 'center',
    transition: 'background-color 140ms ease, color 140ms ease',
    width: showLabel ? 'auto' : 36,
    backgroundColor: active ? RETICULUM_ACTIVE_BLUE : 'transparent',
    '&:hover': {
      backgroundColor: active
        ? RETICULUM_ACTIVE_BLUE
        : theme.palette.action.hover,
      color: active ? theme.palette.common.white : theme.palette.text.primary,
    },
  });
  const renderAction = ({
    active,
    disabled,
    icon,
    label,
    onClick,
    showLabel = false,
    tooltip,
  }: {
    active?: boolean;
    disabled?: boolean;
    icon: ReactNode;
    label: string;
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    showLabel?: boolean;
    tooltip?: string;
  }) => {
    if (typeof onClick !== 'function') return null;
    return (
      <Tooltip key={label} title={tooltip || label}>
        <span style={{ display: 'inline-flex' }}>
          <ButtonBase
            disabled={disabled}
            onClick={onClick}
            sx={actionSx(active, showLabel)}
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
      </Tooltip>
    );
  };

  return (
    <Box
      sx={{
        alignItems: 'center',
        borderBottom: `1px solid ${theme.palette.divider}`,
        display: 'flex',
        flexShrink: 0,
        gap: 0.75,
        minHeight: 50,
        overflow: 'hidden',
        px: 1.5,
      }}
    >
      <Typography
        sx={{
          flex: 1,
          fontSize: 17,
          fontWeight: 700,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {sectionLabel}
      </Typography>
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
        {renderAction({
          active: activeSection === 'land',
          label: 'Qortal Land',
          icon: <SportsEsportsIcon sx={{ fontSize: 19 }} />,
          onClick: onQortalLandClick,
          showLabel: true,
        })}
        {renderAction({
          active: activeSection === 'chat',
          label: 'Chat',
          icon: <ChatRoundedIcon sx={{ fontSize: 19 }} />,
          onClick: onChatClick,
          showLabel: true,
        })}
        {renderAction({
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
        {renderAction({
          active: activeSection === 'forum',
          label: 'Threads',
          icon: <ForumRoundedIcon sx={{ fontSize: 19 }} />,
          onClick: onThreadsClick,
        })}
        {canManageReticulumGroup &&
          renderAction({
            active: isAdminMenuOpen,
            label: 'Admins',
            icon: <SecurityRoundedIcon sx={{ fontSize: 19 }} />,
            onClick: (event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              executeEvent('toggleReticulumAdminKeys', {
                anchorRect: {
                  bottom: rect.bottom,
                  height: rect.height,
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  width: rect.width,
                },
                toggle: true,
              });
            },
          })}
        {renderAction({
          active: isQManagerOpen,
          label: 'Q-Manager',
          icon: <FolderRoundedIcon sx={{ fontSize: 19 }} />,
          onClick: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            executeEvent('openReticulumQManager', {
              anchorRect: {
                bottom: rect.bottom,
                height: rect.height,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                width: rect.width,
              },
              toggle: true,
            });
          },
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
            onClick={() => executeEvent('openReticulumChatSearch', {})}
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
  );
}

export const Group = ({
  myAddress,
  setDesktopViewMode,
  desktopViewMode,
  onOpenSettings,
}: GroupProps) => {
  const [desktopSideView, setDesktopSideView] = useState('groups');
  const [chatWidgetClosed, setChatWidgetClosed] = useAtom(chatWidgetClosedAtom);
  const [lastQappViewMode, setLastQappViewMode] = useState('apps');
  const [secretKey, setSecretKey] = useState(null);
  const [secretKeyPublishDate, setSecretKeyPublishDate] = useState(null);
  const lastFetchedSecretKey = useRef(null);
  const [secretKeyDetails, setSecretKeyDetails] = useState(null);
  const [newEncryptionNotification, setNewEncryptionNotification] =
    useState(null);
  const [memberCountFromSecretKeyData, setMemberCountFromSecretKeyData] =
    useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedDirect, setSelectedDirect] = useState(null);
  const hasInitializedWebsocket = useRef(false);
  const memberGroupsRef = useRef<any[]>([]);
  const [directs, setDirects] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [adminsWithNames, setAdminsWithNames] = useState([]);
  const [members, setMembers] = useState([]);
  const [groupOwner, setGroupOwner] = useState(null);
  const [triedToFetchSecretKey, setTriedToFetchSecretKey] = useState(false);
  const [openAddGroup, setOpenAddGroup] = useState(false);
  const [openFindGroup, setOpenFindGroup] = useState(false);
  const [openAddGroupTab, setOpenAddGroupTab] = useState<0 | 1 | 2>(0);
  const [openManageMembers, setOpenManageMembers] = useState(false);
  const setMemberGroups = useSetAtom(memberGroupsAtom);
  const [timestampEnterData, setTimestampEnterData] = useAtom(
    timestampEnterDataAtom
  );
  const groupsPropertiesRef = useRef({});
  const [chatMode, setChatMode] = useState('groups');
  const [newChat, setNewChat] = useState(false);
  const [openSnack, setOpenSnack] = useState(false);
  const [infoSnack, setInfoSnack] = useState(null);
  const [isLoadingNotifyAdmin, setIsLoadingNotifyAdmin] = useState(false);
  const [isLoadingGroups, setIsLoadingGroups] = useState(true);
  const [isLoadingGroup, setIsLoadingGroup] = useState(false);
  const [firstSecretKeyInCreation, setFirstSecretKeyInCreation] =
    useState(false);
  const [groupSection, setGroupSection] = useState('home');
  const [groupAnnouncements, setGroupAnnouncements] = useAtom(
    groupAnnouncementsAtom
  );
  const theme = useTheme();

  const [defaultThread, setDefaultThread] = useState(null);
  const [, setIsOpenDrawer] = useState(false);
  const [isOpenBlockedModal, setIsOpenBlockedUserModal] = useAtom(
    isOpenBlockedModalAtom
  );
  const [hideCommonKeyPopup, setHideCommonKeyPopup] = useState(false);
  const [isLoadingGroupMessage, setIsLoadingGroupMessage] = useState('');
  const setMutedGroups = useSetAtom(mutedGroupsAtom);
  const mutedGroups = useAtomValue(mutedGroupsAtom);
  const memberGroupsForReticulum = useAtomValue(memberGroupsAtom);
  const memberGroupsWithReticulumActivity = useAtomValue(
    memberGroupsWithReticulumChatAtom
  );
  const [memberGroupsLoadedAddress, setMemberGroupsLoadedAddress] =
    useState('');
  const [notificationReticulumChannelId, setNotificationReticulumChannelId] =
    useState('');
  const [activeReticulumChannelId, setActiveReticulumChannelId] =
    useState('general');
  const [reticulumReadEntryToken, setReticulumReadEntryToken] = useState(0);
  const [reticulumMountedGroupSections, setReticulumMountedGroupSections] =
    useState<Record<string, string[]>>({});
  const [reticulumMembersPanelOpen, setReticulumMembersPanelOpen] =
    useState(false);
  const [mobileViewMode, setMobileViewMode] = useState('home');
  const [, setMobileViewModeKeepOpen] = useState('');
  const [isQChatTabActive, setIsQChatTabActive] = useState(false);
  const timestampEnterDataRef = useRef({});
  const myAddressRef = useRef('');
  const selectedGroupRef = useRef(null);
  const selectedDirectRef = useRef(null);
  const groupSectionRef = useRef(null);
  const isLoadingOpenSectionFromNotification = useRef(false);
  const settimeoutForRefetchSecretKey = useRef(null);
  const secretKeyRef = useRef(null);
  const { clearStatesMessageQueueProvider } = useMessageQueue();
  const initiatedGetMembers = useRef(false);
  const [groupChatTimestamps, setGroupChatTimestamps] = useAtom(
    groupChatTimestampsAtom
  );
  const setReticulumChatSummaries = useSetAtom(reticulumChatSummariesAtom);
  const [reticulumChatEnabled, setReticulumChatEnabled] = useAtom(
    reticulumChatEnabledAtom
  );
  const [reticulumDirectSummaries, setReticulumDirectSummaries] = useAtom(
    reticulumDirectSummariesAtom
  );
  const [reticulumDirectNamesByAddress, setReticulumDirectNamesByAddress] =
    useState<Record<string, string>>({});
  const reticulumDirectNamesByAddressRef = useRef<Record<string, string>>({});
  const reticulumDirectNameResolutionsRef = useRef(new Set<string>());
  const reticulumDirectNameRetryAfterRef = useRef(new Map<string, number>());
  const reticulumSubscribedGroupIdsRef = useRef<Set<number>>(new Set());
  const reticulumBackgroundProcessedEventIdsRef = useRef<Map<string, number>>(
    new Map()
  );
  const reticulumGroupMentionNameCacheRef = useRef<
    Map<number, Map<string, string>>
  >(new Map());
  const reticulumSummariesRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const reticulumDirectSummariesRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const previousReticulumSummariesRef = useRef<Record<string, any> | null>(
    null
  );
  const reticulumMentionBadgeSummariesRef = useRef<Record<
    string,
    ReticulumNotificationSummary
  > | null>(null);
  const notifiedReticulumEventIdsRef = useRef<Set<string>>(new Set());
  const activeReticulumChannelIdRef = useRef('general');
  const bumpReticulumReadEntryToken = useCallback(() => {
    setReticulumReadEntryToken((token) => token + 1);
  }, []);
  const pruneReticulumBackgroundProcessedEvents = useCallback(() => {
    const now = Date.now();
    const map = reticulumBackgroundProcessedEventIdsRef.current;
    const cutoff = now - RETICULUM_BACKGROUND_PROCESSED_EVENT_TTL_MS;
    for (const [eventId, seenAt] of map.entries()) {
      if (seenAt < cutoff) map.delete(eventId);
    }
    if (map.size <= RETICULUM_BACKGROUND_PROCESSED_EVENT_MAX) return;
    const excess = map.size - RETICULUM_BACKGROUND_PROCESSED_EVENT_MAX;
    const oldest = [...map.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, excess);
    for (const [eventId] of oldest) map.delete(eventId);
  }, []);
  const hasProcessedReticulumBackgroundEvent = useCallback(
    (eventId: string) => {
      pruneReticulumBackgroundProcessedEvents();
      return reticulumBackgroundProcessedEventIdsRef.current.has(eventId);
    },
    [pruneReticulumBackgroundProcessedEvents]
  );
  const noteProcessedReticulumBackgroundEvent = useCallback(
    (eventId: string) => {
      if (!eventId) return;
      reticulumBackgroundProcessedEventIdsRef.current.set(eventId, Date.now());
      pruneReticulumBackgroundProcessedEvents();
    },
    [pruneReticulumBackgroundProcessedEvents]
  );
  const setIsEnabledDevMode = useSetAtom(enabledDevModeAtom);
  const setIsDisabledEditorEnter = useSetAtom(isDisabledEditorEnterAtom);

  useEffect(() => {
    if (!openAddGroup) {
      setOpenAddGroupTab(0);
    }
  }, [openAddGroup]);

  useEffect(() => {
    const isDevModeFromStorage = localStorage.getItem('isEnabledDevMode');
    if (isDevModeFromStorage) {
      setIsEnabledDevMode(JSON.parse(isDevModeFromStorage));
    }
    try {
      const val = localStorage.getItem('settings-disable-editor-enter');
      if (val) {
        const parsedVal = JSON.parse(val);
        if (parsedVal === false || parsedVal === true) {
          setIsDisabledEditorEnter(parsedVal);
        }
      }
    } catch (error) {
      console.log(error);
    }
  }, []);
  const [isRunningPublicNode] = useAtom(isRunningPublicNodeAtom);
  const [avatarPreviewData, setAvatarPreviewData] = useState<{
    alt: string;
    src: string;
  } | null>(null);
  const [directAvatarLoaded, setDirectAvatarLoaded] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    if (desktopViewMode === 'apps' || desktopViewMode === 'dev') {
      setLastQappViewMode(desktopViewMode);
    }
  }, [desktopViewMode]);

  const [appsMode, setAppsMode] = useState('home');
  const [appsModeDev, setAppsModeDev] = useState('home');
  const [isOpenSideViewDirects, setIsOpenSideViewDirects] = useState(false);
  const [isOpenSideViewGroups, setIsOpenSideViewGroups] = useState(false);
  const [isForceShowCreationKeyPopup, setIsForceShowCreationKeyPopup] =
    useState(false);
  const groupsOwnerNamesRef = useRef({});
  const { t } = useTranslation([
    'auth',
    'core',
    'group',
    'question',
    'tutorial',
  ]);
  useWebsocketStatus();
  const [groupsProperties, setGroupsProperties] = useAtom(groupsPropertiesAtom);
  const setGroupsOwnerNames = useSetAtom(groupsOwnerNamesAtom);
  const userInfo = useAtomValue(userInfoAtom);
  const dmFriendsByAddress = useAtomValue(dmFriendsByAddressAtom);

  const {
    roomState: gcallRoomState,
    joinGroupCall,
    leaveGroupCall,
    roomId: gcallActiveRoomId,
  } = useGroupCallContext();
  const { confirmCallSwitch } = useCallSwitchGuard();
  const setQcallMinimized = useSetAtom(qortalGroupVoiceCallMinimizedAtom);
  const setQcallPrimaryNames = useSetAtom(qortalGroupCallPrimaryNamesAtom);

  const gcallGroupNumericId = useMemo(() => {
    const id = selectedGroup?.groupId;
    if (id === undefined || id === null || id === '0') return null;
    const n = Number(id);
    return Number.isFinite(n) ? n : null;
  }, [selectedGroup?.groupId]);

  const gcallRoomIdForGroup =
    gcallGroupNumericId !== null ? `gcall-qortal-${gcallGroupNumericId}` : '';

  const inThisGroupGcall =
    gcallRoomState !== 'idle' && gcallActiveRoomId === gcallRoomIdForGroup;
  const inOtherGcall =
    gcallRoomState !== 'idle' && gcallActiveRoomId !== gcallRoomIdForGroup;

  const handleGroupCallHeaderClick = useCallback(async () => {
    traceGcallAudioSurface('ui.Group: header call icon clicked', {
      gcallGroupNumericId,
      gcallRoomIdForGroup,
      hasAudioSurface: Boolean(
        typeof window !== 'undefined' &&
        (window as Window & { audioSurface?: unknown }).audioSurface
      ),
      desktopViewMode,
    });
    if (gcallGroupNumericId === null || !gcallRoomIdForGroup) {
      traceGcallAudioSurface(
        'ui.Group: early exit (no room id for selected group)',
        {}
      );
      return;
    }
    if (inThisGroupGcall) {
      traceGcallAudioSurface('ui.Group: leaving call', { gcallRoomIdForGroup });
      await leaveGroupCall();
      return;
    }
    const confirmed = await confirmCallSwitch({
      type: 'group',
      roomId: gcallRoomIdForGroup,
    });
    if (!confirmed) return;
    // Calls deliberately start in the compact nav widget. The stage is opened
    // only when the user explicitly expands it there.
    setQcallMinimized(true);
    let memberGateAddresses: string[] = [];
    const primaryNamesByAddress: Record<string, string> = {};
    try {
      const data = await getGroupMembers(gcallGroupNumericId);
      const addressSet = new Set<string>();
      if (Array.isArray(data?.members)) {
        for (const member of data.members) {
          const address =
            typeof member?.member === 'string' ? member.member.trim() : '';
          if (address) {
            addressSet.add(address);
            const primaryName =
              typeof member?.primaryName === 'string'
                ? member.primaryName.trim()
                : '';
            if (primaryName) {
              primaryNamesByAddress[address] = primaryName;
            }
          }
        }
      }
      memberGateAddresses = [...addressSet];
      setQcallPrimaryNames(primaryNamesByAddress);
      traceGcallAudioSurface('ui.Group: synced group call member gate', {
        groupId: gcallGroupNumericId,
        memberCount: memberGateAddresses.length,
        primaryNameCount: Object.keys(primaryNamesByAddress).length,
        localIncluded: Boolean(
          userInfo?.address && addressSet.has(userInfo.address)
        ),
      });
    } catch (error) {
      traceGcallAudioSurface('ui.Group: failed group call member gate fetch', {
        groupId: gcallGroupNumericId,
        message: error instanceof Error ? error.message : 'unknown',
      });
      setInfoSnack({
        type: 'error',
        message: t('core:group_call_members_fetch_failed', {
          postProcess: 'capitalizeFirstChar',
        }),
      });
      setOpenSnack(true);
      setQcallPrimaryNames({});
      return;
    }
    await joinGroupCall(gcallRoomIdForGroup, `group:${gcallGroupNumericId}`, {
      memberGateGroupId: gcallGroupNumericId,
      memberGateGroupName: selectedGroup?.groupName,
      memberGateAddresses,
    });
  }, [
    desktopViewMode,
    gcallGroupNumericId,
    gcallRoomIdForGroup,
    inThisGroupGcall,
    confirmCallSwitch,
    joinGroupCall,
    leaveGroupCall,
    selectedGroup?.groupName,
    setQcallMinimized,
    setQcallPrimaryNames,
    t,
    userInfo?.address,
  ]);

  const setUserInfoForLevels = useSetAtom(addressInfoControllerAtom);
  const [myGroupsWhereIAmAdmin, setMyGroupsWhereIAmAdmin] = useAtom(
    myGroupsWhereIAmAdminAtom
  );
  const [
    reticulumAdminGroupsLoadedAddress,
    setReticulumAdminGroupsLoadedAddress,
  ] = useState('');
  const [reticulumMembershipsAppliedKey, setReticulumMembershipsAppliedKey] =
    useState('');
  const [reticulumSummariesLoadedMembershipKey, setReticulumSummariesLoadedMembershipKey] =
    useState('');
  const [reticulumTransportReadyRevision, setReticulumTransportReadyRevision] =
    useState(0);
  const reticulumAdminGroupIds = useMemo(
    () => new Set(getGroupIdsFromGroupLikeList(myGroupsWhereIAmAdmin)),
    [myGroupsWhereIAmAdmin]
  );
  const isPrivate = useMemo(() => {
    if (selectedGroup?.groupId === '0') return false;
    if (!selectedGroup?.groupId || !groupsProperties[selectedGroup?.groupId])
      return null;
    if (groupsProperties[selectedGroup?.groupId]?.isOpen === true) return false;
    if (groupsProperties[selectedGroup?.groupId]?.isOpen === false) return true;
    return null;
  }, [selectedGroup]);

  const setSelectedGroupId = useSetAtom(selectedGroupIdAtom);

  const toggleSideViewDirects = useCallback(() => {
    if (isOpenSideViewGroups) {
      setIsOpenSideViewGroups(false);
    }
    setIsOpenSideViewDirects((prev) => !prev);
  }, [isOpenSideViewGroups]);

  const toggleSideViewGroups = useCallback(() => {
    if (isOpenSideViewDirects) {
      setIsOpenSideViewDirects(false);
    }
    setIsOpenSideViewGroups((prev) => !prev);
  }, [isOpenSideViewDirects]);

  useEffect(() => {
    timestampEnterDataRef.current = timestampEnterData;
  }, [timestampEnterData]);

  useEffect(() => {
    groupSectionRef.current = groupSection;
  }, [groupSection]);
  useEffect(() => {
    selectedGroupRef.current = selectedGroup;
    setSelectedGroupId(selectedGroup?.groupId);
  }, [selectedGroup]);
  useEffect(() => {
    selectedDirectRef.current = selectedDirect;
  }, [selectedDirect]);
  useEffect(() => {
    activeReticulumChannelIdRef.current = activeReticulumChannelId || 'general';
  }, [activeReticulumChannelId]);

  useEffect(() => {
    if (!reticulumChatEnabled || !selectedGroup?.groupId) return;
    if (
      !['announcement', 'forum', 'land', 'members', 'adminSpace'].includes(
        groupSection
      )
    ) {
      return;
    }
    const groupId = String(selectedGroup.groupId);
    setReticulumMountedGroupSections((current) => {
      const mounted = current[groupId] || [];
      if (mounted.includes(groupSection)) return current;
      return {
        ...current,
        [groupId]: [...mounted, groupSection],
      };
    });
  }, [groupSection, reticulumChatEnabled, selectedGroup?.groupId]);

  useEffect(() => {
    secretKeyRef.current = secretKey;
  }, [secretKey]);

  useEffect(() => {
    reticulumBackgroundProcessedEventIdsRef.current.clear();
  }, [myAddress]);

  // Track view modes to prevent marking messages as read when not viewing chat
  const desktopViewModeRef = useRef(desktopViewMode);
  const mobileViewModeRef = useRef(mobileViewMode);
  const qChatTabActiveRef = useRef(false);
  const lastNonQappDesktopViewModeRef = useRef(
    desktopViewMode !== 'apps' && desktopViewMode !== 'dev'
      ? desktopViewMode
      : 'home'
  );

  useEffect(() => {
    desktopViewModeRef.current = desktopViewMode;
    if (desktopViewMode !== 'apps' && desktopViewMode !== 'dev') {
      lastNonQappDesktopViewModeRef.current = desktopViewMode;
    }
  }, [desktopViewMode]);

  useEffect(() => {
    mobileViewModeRef.current = mobileViewMode;
  }, [mobileViewMode]);

  useEffect(() => {
    qChatTabActiveRef.current = isQChatTabActive;
  }, [isQChatTabActive]);

  // Track previous view mode to detect when user returns to chat
  const prevDesktopViewModeRef = useRef(desktopViewMode);
  const prevMobileViewModeRef = useRef(mobileViewMode);
  const prevQChatTabActiveRef = useRef(isQChatTabActive);

  // Mark messages as read when user returns to chat view
  useEffect(() => {
    const wasInChatMode =
      prevQChatTabActiveRef.current || prevMobileViewModeRef.current === 'chat';

    const isNowInChatMode = isQChatTabActive || mobileViewMode === 'chat';

    // Only update timestamp when user RETURNS to chat (wasn't in chat, now is in chat)
    if (!wasInChatMode && isNowInChatMode) {
      // Update timestamp for selected group chat
      if (selectedGroupRef.current && groupSectionRef.current === 'chat') {
        window
          .sendMessage('addTimestampEnterChat', {
            timestamp: Date.now(),
            groupId: selectedGroupRef.current.groupId,
          })
          .then(() => {
            // Refresh the timestamp data to update UI
            setTimeout(() => {
              getTimestampEnterChat();
            }, 600);
          })
          .catch((error) => {
            console.error(
              'Failed to add timestamp:',
              error.message || 'An error occurred'
            );
          });
      }

      // Update timestamp for selected direct chat
      if (selectedDirectRef.current) {
        window
          .sendMessage('addTimestampEnterChat', {
            timestamp: Date.now(),
            groupId: selectedDirectRef.current.address,
          })
          .then(() => {
            // Refresh the timestamp data to update UI
            setTimeout(() => {
              getTimestampEnterChat();
            }, 600);
          })
          .catch((error) => {
            console.error(
              'Failed to add timestamp:',
              error.message || 'An error occurred'
            );
          });
      }
    }

    // Update previous view mode refs
    prevDesktopViewModeRef.current = desktopViewMode;
    prevMobileViewModeRef.current = mobileViewMode;
    prevQChatTabActiveRef.current = isQChatTabActive;
  }, [desktopViewMode, isQChatTabActive, mobileViewMode]);

  const getUserSettings = useCallback(async () => {
    try {
      return new Promise((res, rej) => {
        window
          .sendMessage('getUserSettings', {
            key: 'mutedGroups',
          })
          .then((response) => {
            if (!response?.error) {
              setMutedGroups(response || []);
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
      console.error(error);
    }
  }, [setMutedGroups]);

  useEffect(() => {
    getUserSettings();
  }, [getUserSettings]);

  const getTimestampEnterChat = useCallback(async () => {
    try {
      return new Promise((res, rej) => {
        window
          .sendMessage('getTimestampEnterChat')
          .then((response) => {
            if (!response?.error) {
              setTimestampEnterData(response);
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
  }, []);

  const fireReticulumChatNotification = useCallback(
    async ({
      channelId,
      event,
      groupId,
      hasMention,
    }: {
      channelId: string;
      event: ReticulumBackgroundEvent;
      groupId: number;
      hasMention: boolean;
    }) => {
      if (typeof window === 'undefined' || !('Notification' in window)) return;
      const disabled = await window
        .sendMessage('getUserSettings', {
          key: 'disable-push-notifications',
        })
        .catch(() => false);
      if (disabled) return;
      if (window.Notification.permission === 'default') {
        await window.Notification.requestPermission().catch(() => null);
      }
      if (window.Notification.permission !== 'granted') return;

      const group = memberGroupsRef.current?.find(
        (item: any) => Number(item?.groupId) === groupId
      );
      const groupName =
        group?.groupName || group?.name || `Group ${String(groupId)}`;
      const channelName = reticulumChannelDisplayName(channelId);
      const author =
        event.authorPrimaryName ||
        event.authorAddress ||
        (hasMention ? 'Someone' : 'New message');
      const payload = parseReticulumPublicPayload(event.encryptedPayload);
      const preview = reticulumTextFromPayload(payload).slice(0, 140);
      const title = hasMention
        ? `Mention in ${groupName} / ${channelName}`
        : `New message in ${groupName} / ${channelName}`;
      const body = preview
        ? `${author}: ${preview}`
        : hasMention
          ? `You were mentioned in ${groupName}`
          : `You have a new message in ${groupName}`;
      const notification = new window.Notification(title, {
        body,
        icon: window.location.origin + '/qortal192.png',
        data: { groupId, channelId, eventId: event.eventId },
      });
      notification.onclick = () => {
        if (typeof window?.electronAPI?.focusWindow === 'function') {
          window.electronAPI.focusWindow();
        }
        setNotificationReticulumChannelId(channelId);
        executeEvent('openGroupMessage', {
          from: groupId,
          channelId,
        });
        notification.close();
      };
      setTimeout(() => notification.close(), 10000);
    },
    []
  );

  const maybeFireReticulumChatNotification = useCallback(
    async (previous: Record<string, any> | null, next: Record<string, any>) => {
      if (!previous || !myAddressRef.current) return;
      const muted = Array.isArray(mutedGroups)
        ? mutedGroups.map((groupId) => String(groupId))
        : [];
      const candidates: Array<{
        channelId: string;
        event: ReticulumBackgroundEvent;
        groupId: number;
        hasMention: boolean;
        timestamp: number;
      }> = [];
      for (const summary of Object.values(
        next
      ) as ReticulumNotificationSummary[]) {
        const groupId = Number(summary?.groupId);
        if (!Number.isInteger(groupId) || groupId <= 0) continue;
        if (muted.includes(String(groupId))) continue;
        const previousSummary = previous[String(groupId)] as
          | ReticulumNotificationSummary
          | undefined;
        const previousChannels = Array.isArray(previousSummary?.channels)
          ? previousSummary.channels
          : [];
        const channels = Array.isArray(summary?.channels)
          ? summary.channels
          : summary?.channelId
            ? [summary]
            : [];
        for (const channel of channels) {
          const event = channel?.lastEvent;
          const eventId =
            typeof event?.eventId === 'string' ? event.eventId : '';
          const eventType =
            typeof event?.eventType === 'string' ? event.eventType : '';
          const channelId = String(
            channel?.channelId || event?.channelId || 'general'
          );
          if (
            !eventId ||
            !RETICULUM_OS_NOTIFICATION_EVENT_TYPES.has(eventType)
          ) {
            continue;
          }
          if (event?.authorAddress === myAddressRef.current) continue;
          if (notifiedReticulumEventIdsRef.current.has(eventId)) continue;
          const previousChannel =
            previousChannels.find(
              (item) => String(item?.channelId || 'general') === channelId
            ) ||
            (String(previousSummary?.channelId || '') === channelId
              ? previousSummary
              : null);
          if (previousChannel?.lastEvent?.eventId === eventId) continue;
          const unreadCount = Math.max(0, Number(channel?.unreadCount) || 0);
          const previousUnreadCount = Math.max(
            0,
            Number(previousChannel?.unreadCount) || 0
          );
          const mentionCount = Math.max(0, Number(channel?.mentionCount) || 0);
          const previousMentionCount = Math.max(
            0,
            Number(previousChannel?.mentionCount) || 0
          );
          if (
            unreadCount <= 0 ||
            (unreadCount <= previousUnreadCount &&
              mentionCount <= previousMentionCount)
          ) {
            continue;
          }
          const isViewingThisChannel =
            Number(selectedGroupRef.current?.groupId) === groupId &&
            groupSectionRef.current === 'chat' &&
            activeReticulumChannelIdRef.current === channelId &&
            (desktopViewModeRef.current === 'chat' ||
              qChatTabActiveRef.current ||
              mobileViewModeRef.current === 'chat');
          if (isViewingThisChannel) continue;
          candidates.push({
            channelId,
            event,
            groupId,
            hasMention: mentionCount > previousMentionCount,
            timestamp: Number(event?.timestamp || channel?.updatedAt || 0),
          });
        }
      }
      const newest = candidates.sort((a, b) => b.timestamp - a.timestamp)[0];
      if (!newest?.event?.eventId) return;
      notifiedReticulumEventIdsRef.current.add(newest.event.eventId);
      if (
        notifiedReticulumEventIdsRef.current.size >
        RETICULUM_OS_NOTIFICATION_MAX_TRACKED
      ) {
        const [oldest] = notifiedReticulumEventIdsRef.current;
        if (oldest) notifiedReticulumEventIdsRef.current.delete(oldest);
      }
      await fireReticulumChatNotification(newest);
    },
    [fireReticulumChatNotification, mutedGroups]
  );

  const refreshReticulumChatSummaries = useCallback(async (): Promise<boolean> => {
    try {
      const enabled = await window.reticulumChat?.isEnabled?.();
      setReticulumChatEnabled(enabled === true);
      if (!enabled) {
        previousReticulumSummariesRef.current = null;
        reticulumMentionBadgeSummariesRef.current = null;
        setReticulumChatSummaries({});
        void window.reticulumChat?.updateMentionBadge?.(0);
        return false;
      }
      const summaries = await window.reticulumChat?.getSummaries?.(myAddress);
      if (!Array.isArray(summaries)) {
        reticulumMentionBadgeSummariesRef.current = null;
        setReticulumChatSummaries({});
        void window.reticulumChat?.updateMentionBadge?.(0);
        return false;
      }
      const next = summaries.reduce(
        (acc, summary: any) => {
          const groupId = Number(summary?.groupId);
          if (!Number.isInteger(groupId) || groupId <= 0) return acc;
          acc[String(groupId)] = summary;
          return acc;
        },
        {} as Record<string, any>
      );
      const previous = previousReticulumSummariesRef.current;
      previousReticulumSummariesRef.current = next;
      setReticulumChatSummaries(next);
      const badgeState = getReticulumMentionBadgeStateForRefresh(
        reticulumMentionBadgeSummariesRef.current,
        next,
        getGroupIdFromGroupLike(selectedGroupRef.current),
        activeReticulumChannelIdRef.current || 'general'
      );
      reticulumMentionBadgeSummariesRef.current = badgeState.summaries;
      void window.reticulumChat?.updateMentionBadge?.(badgeState.count);
      void maybeFireReticulumChatNotification(previous, next);
      return true;
    } catch (error) {
      console.error(
        '[ReticulumChat] Failed to refresh group summaries:',
        error
      );
      return false;
    }
  }, [
    maybeFireReticulumChatNotification,
    myAddress,
    setReticulumChatEnabled,
    setReticulumChatSummaries,
  ]);

  const scheduleReticulumChatSummariesRefresh = useCallback(() => {
    if (reticulumSummariesRefreshTimerRef.current) {
      clearTimeout(reticulumSummariesRefreshTimerRef.current);
    }
    reticulumSummariesRefreshTimerRef.current = setTimeout(() => {
      reticulumSummariesRefreshTimerRef.current = null;
      void refreshReticulumChatSummaries();
    }, 150);
  }, [refreshReticulumChatSummaries]);

  useEffect(() => {
    myAddressRef.current = myAddress || '';
    setReticulumAdminGroupsLoadedAddress('');
    setReticulumMembershipsAppliedKey('');
    setReticulumSummariesLoadedMembershipKey('');
    previousReticulumSummariesRef.current = null;
    notifiedReticulumEventIdsRef.current.clear();
    if (!myAddress) {
      reticulumMentionBadgeSummariesRef.current = null;
      void window.reticulumChat?.updateMentionBadge?.(0);
    }
  }, [myAddress]);

  const reticulumMemberships = useMemo(
    () =>
      getReticulumGroupMembershipsFromGroupLikeList(
        memberGroupsForReticulum,
        groupsProperties,
        myAddress,
        reticulumAdminGroupIds
      ),
    [
      groupsProperties,
      memberGroupsForReticulum,
      myAddress,
      reticulumAdminGroupIds,
    ]
  );
  const reticulumMembershipsKey = useMemo(
    () =>
      JSON.stringify(
        reticulumMemberships.map(
          ({ groupId, isPrivate, isAdmin, localAddress }) => ({
            groupId,
            isPrivate,
            isAdmin,
            localAddress: localAddress || '',
          })
        )
      ),
    [reticulumMemberships]
  );

  useEffect(() => {
    return window.presence?.onStarted?.(() => {
      setReticulumTransportReadyRevision((revision) => revision + 1);
    });
  }, []);

  useEffect(() => {
    if (!myAddress) return;
    if (memberGroupsLoadedAddress !== myAddress) {
      return;
    }
    if (reticulumAdminGroupsLoadedAddress !== myAddress) {
      return;
    }
    const groupIds = getGroupIdsFromGroupLikeList(memberGroupsForReticulum);

    let cancelled = false;
    setReticulumMembershipsAppliedKey('');
    setReticulumSummariesLoadedMembershipKey('');
    void (async () => {
      const enabled = await window.reticulumChat?.isEnabled?.();
      if (cancelled || !enabled) {
        if (!cancelled) {
          for (const groupId of reticulumSubscribedGroupIdsRef.current) {
            void window.reticulumChat?.unsubscribeGroup?.(groupId);
          }
          reticulumSubscribedGroupIdsRef.current = new Set();
          void window.reticulumChat?.setLocalGroupMemberships?.([]);
          reticulumMentionBadgeSummariesRef.current = null;
          setReticulumChatSummaries({});
          void window.reticulumChat?.updateMentionBadge?.(0);
        }
        return;
      }
      const membershipResult =
        await window.reticulumChat?.setLocalGroupMemberships?.(
          reticulumMemberships
        );
      if (cancelled || membershipResult?.success !== true) return;
      setReticulumMembershipsAppliedKey(reticulumMembershipsKey);
      const nextIds = new Set(groupIds);
      const previousIds = reticulumSubscribedGroupIdsRef.current;
      for (const groupId of previousIds) {
        if (!nextIds.has(groupId)) {
          void window.reticulumChat?.unsubscribeGroup?.(groupId);
        }
      }
      for (const groupId of nextIds) {
        if (!previousIds.has(groupId)) {
          void window.reticulumChat?.subscribeGroup?.(groupId);
        }
      }
      reticulumSubscribedGroupIdsRef.current = nextIds;
      if (groupIds.length === 0) {
        reticulumMentionBadgeSummariesRef.current = null;
        setReticulumChatSummaries({});
        void window.reticulumChat?.updateMentionBadge?.(0);
        return;
      }
      const summariesLoaded = await refreshReticulumChatSummaries();
      if (cancelled || !summariesLoaded) return;
      setReticulumSummariesLoadedMembershipKey(reticulumMembershipsKey);
      scheduleReticulumChatSummariesRefresh();
    })();

    return () => {
      cancelled = true;
    };
  }, [
    memberGroupsLoadedAddress,
    memberGroupsForReticulum,
    myAddress,
    reticulumAdminGroupsLoadedAddress,
    reticulumMemberships,
    reticulumMembershipsKey,
    reticulumTransportReadyRevision,
    refreshReticulumChatSummaries,
    scheduleReticulumChatSummariesRefresh,
    setReticulumChatSummaries,
  ]);

  useEffect(() => {
    const offSummaryChanged = window.reticulumChat?.onSummaryChanged?.(
      (payload) => {
        const groupId = Number(payload?.groupId);
        if (
          Number.isInteger(groupId) &&
          groupId > 0 &&
          !reticulumSubscribedGroupIdsRef.current.has(groupId)
        ) {
          return;
        }
        scheduleReticulumChatSummariesRefresh();
      }
    );
    const refreshHandler = () => {
      scheduleReticulumChatSummariesRefresh();
    };
    subscribeToEvent('reticulum-chat-summaries-refresh', refreshHandler);
    void refreshReticulumChatSummaries();
    return () => {
      offSummaryChanged?.();
      unsubscribeFromEvent('reticulum-chat-summaries-refresh', refreshHandler);
      if (reticulumSummariesRefreshTimerRef.current) {
        clearTimeout(reticulumSummariesRefreshTimerRef.current);
        reticulumSummariesRefreshTimerRef.current = null;
      }
    };
  }, [refreshReticulumChatSummaries, scheduleReticulumChatSummariesRefresh]);

  const refreshReticulumDirectSummaries = useCallback(
    async (enabled = reticulumChatEnabled) => {
      if (!myAddress || !enabled) {
        setReticulumDirectSummaries({});
        return;
      }
      try {
        await window.reticulumChat?.setLocalDmAddresses?.([myAddress]);
        const summaries =
          await window.reticulumChat?.getDirectSummaries?.(myAddress);
        if (!Array.isArray(summaries)) {
          setReticulumDirectSummaries({});
          return;
        }
        const next = summaries.reduce(
          (acc, summary: any) => {
            const peerAddress = String(summary?.peerAddress || '').trim();
            if (!peerAddress) return acc;
            acc[peerAddress] = summary;
            return acc;
          },
          {} as Record<string, any>
        );
        setReticulumDirectSummaries(next);
      } catch (error) {
        console.error('[ReticulumChat] Failed to refresh DM summaries:', error);
      }
    },
    [myAddress, reticulumChatEnabled, setReticulumDirectSummaries]
  );

  const scheduleReticulumDirectSummariesRefresh = useCallback(
    (delayMs = 150) => {
      if (reticulumDirectSummariesRefreshTimerRef.current) {
        clearTimeout(reticulumDirectSummariesRefreshTimerRef.current);
      }
      reticulumDirectSummariesRefreshTimerRef.current = setTimeout(() => {
        reticulumDirectSummariesRefreshTimerRef.current = null;
        void refreshReticulumDirectSummaries();
      }, delayMs);
    },
    [refreshReticulumDirectSummaries]
  );

  useEffect(() => {
    let cancelled = false;
    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    void (async () => {
      const enabled = (await window.reticulumChat?.isEnabled?.()) === true;
      if (cancelled) return;
      setReticulumChatEnabled(enabled);
      if (!enabled || !myAddress) {
        setReticulumDirectSummaries({});
        void window.reticulumChat?.setLocalDmAddresses?.([]);
        return;
      }
      await window.reticulumChat?.setLocalDmAddresses?.([myAddress]);
      await refreshReticulumDirectSummaries(true);
      for (const delayMs of [750, 2000, 5000]) {
        retryTimers.push(
          setTimeout(() => {
            if (!cancelled) {
              void refreshReticulumDirectSummaries(true);
            }
          }, delayMs)
        );
      }
    })();
    return () => {
      cancelled = true;
      retryTimers.forEach((timer) => clearTimeout(timer));
      if (reticulumDirectSummariesRefreshTimerRef.current) {
        clearTimeout(reticulumDirectSummariesRefreshTimerRef.current);
        reticulumDirectSummariesRefreshTimerRef.current = null;
      }
    };
  }, [
    myAddress,
    refreshReticulumDirectSummaries,
    setReticulumChatEnabled,
    setReticulumDirectSummaries,
  ]);

  useEffect(() => {
    if (!reticulumChatEnabled || !myAddress) return;
    const offSummaryChanged = window.reticulumChat?.onDirectSummaryChanged?.(
      () => {
        scheduleReticulumDirectSummariesRefresh();
      }
    );
    scheduleReticulumDirectSummariesRefresh();
    return () => {
      offSummaryChanged?.();
      if (reticulumDirectSummariesRefreshTimerRef.current) {
        clearTimeout(reticulumDirectSummariesRefreshTimerRef.current);
        reticulumDirectSummariesRefreshTimerRef.current = null;
      }
    };
  }, [
    myAddress,
    reticulumChatEnabled,
    scheduleReticulumDirectSummariesRefresh,
  ]);

  useEffect(() => {
    if (desktopSideView !== 'directs' || !reticulumChatEnabled || !myAddress) {
      return;
    }
    scheduleReticulumDirectSummariesRefresh();
  }, [
    desktopSideView,
    myAddress,
    reticulumChatEnabled,
    scheduleReticulumDirectSummariesRefresh,
  ]);

  useEffect(() => {
    if (!reticulumChatEnabled || !myAddress) return;
    const timer = setInterval(() => {
      scheduleReticulumDirectSummariesRefresh();
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [
    myAddress,
    reticulumChatEnabled,
    scheduleReticulumDirectSummariesRefresh,
  ]);

  const refreshHomeDataFunc = useCallback(() => {
    setGroupSection('default');
    setTimeout(() => {
      setGroupSection('home');
    }, 300);
  }, []);

  const getGroupAnnouncements = useCallback(async () => {
    try {
      return new Promise((res, rej) => {
        window
          .sendMessage('getGroupNotificationTimestamp')
          .then((response) => {
            if (!response?.error) {
              setGroupAnnouncements(response);
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
  }, [t]);

  useEffect(() => {
    if (myAddress) {
      getGroupAnnouncements();
      getTimestampEnterChat();
    }
  }, [myAddress, getGroupAnnouncements, getTimestampEnterChat]);

  const getGroupOwner = useCallback(async (groupId) => {
    if (groupId == '0') return; // general group has id=0
    try {
      const url = `${getBaseApiReact()}/groups/${groupId}`;
      const response = await fetch(url);
      const data = await response.json();

      const name = await getNameInfo(data?.owner);
      if (name) {
        data.name = name;
      }
      setGroupOwner(data);
    } catch (error) {
      console.log(error);
    }
  }, []);

  useEffect(() => {
    if (!reticulumChatEnabled) {
      reticulumDirectNameResolutionsRef.current.clear();
      reticulumDirectNameRetryAfterRef.current.clear();
      reticulumDirectNamesByAddressRef.current = {};
      setReticulumDirectNamesByAddress((previous) =>
        Object.keys(previous).length ? {} : previous
      );
      return;
    }

    const knownNames: Record<string, string> = {};
    for (const direct of directs || []) {
      const address = typeof direct?.address === 'string' ? direct.address : '';
      const name = typeof direct?.name === 'string' ? direct.name.trim() : '';
      if (address && name && name !== address) knownNames[address] = name;
    }
    for (const [address, friend] of Object.entries(dmFriendsByAddress || {})) {
      const name = friend?.name?.trim();
      if (address && name) knownNames[address] = name;
    }
    if (Object.keys(knownNames).length) {
      setReticulumDirectNamesByAddress((previous) => {
        const changed = Object.entries(knownNames).some(
          ([address, name]) => previous[address] !== name
        );
        if (!changed) return previous;
        const next = { ...previous, ...knownNames };
        reticulumDirectNamesByAddressRef.current = next;
        return next;
      });
    }

    const now = Date.now();
    const unresolvedAddresses = Object.values(reticulumDirectSummaries || {})
      .map((summary: any) => String(summary?.peerAddress || '').trim())
      .filter(
        (address) =>
          address &&
          !knownNames[address] &&
          !reticulumDirectNamesByAddressRef.current[address] &&
          !reticulumDirectNameResolutionsRef.current.has(address) &&
          (reticulumDirectNameRetryAfterRef.current.get(address) || 0) <= now
      );
    if (!unresolvedAddresses.length) return;
    unresolvedAddresses.forEach((address) =>
      reticulumDirectNameResolutionsRef.current.add(address)
    );
    void Promise.all(
      unresolvedAddresses.map(async (address) => {
        try {
          const name = await requestQueueMemberNames.enqueue(() =>
            getNameInfo(address)
          );
          return [address, name || null] as const;
        } catch {
          return [address, null] as const;
        } finally {
          reticulumDirectNameResolutionsRef.current.delete(address);
        }
      })
    ).then((resolved) => {
      const entries = resolved.filter(
        (entry): entry is readonly [string, string] => Boolean(entry[1])
      );
      for (const [address, name] of resolved) {
        if (name) {
          reticulumDirectNameRetryAfterRef.current.delete(address);
        } else {
          reticulumDirectNameRetryAfterRef.current.set(
            address,
            Date.now() + RETICULUM_DIRECT_NAME_RETRY_DELAY_MS
          );
        }
      }
      if (!entries.length) return;
      setReticulumDirectNamesByAddress((previous) => {
        const additions = Object.fromEntries(entries);
        const changed = Object.entries(additions).some(
          ([address, name]) => previous[address] !== name
        );
        if (!changed) return previous;
        const next = { ...previous, ...additions };
        reticulumDirectNamesByAddressRef.current = next;
        return next;
      });
    });
  }, [
    directs,
    dmFriendsByAddress,
    reticulumChatEnabled,
    reticulumDirectSummaries,
  ]);

  const reticulumDirectRows = useMemo(() => {
    if (!reticulumChatEnabled) return [];
    return Object.values(reticulumDirectSummaries || {})
      .map((summary: any) => {
        const peerAddress = String(summary?.peerAddress || '').trim();
        const lastEvent = summary?.lastEvent || null;
        const silenced = summary?.silenced === true;
        if (!peerAddress || (!lastEvent && !silenced)) return null;
        const friend = dmFriendsByAddress?.[peerAddress];
        const resolvedName =
          friend?.name || reticulumDirectNamesByAddress[peerAddress];
        return {
          address: peerAddress,
          name: friend?.name || peerAddress,
          timestamp: Number(summary?.updatedAt || lastEvent?.timestamp || 0),
          sender: lastEvent?.senderAddress || '',
          senderName:
            lastEvent?.senderAddress === myAddress
              ? userInfo?.name
              : resolvedName || peerAddress,
          reticulumDirect: true,
          reticulumSilenced: silenced,
          unreadCount: Number(summary?.unreadCount || 0),
        };
      })
      .filter(Boolean);
  }, [
    dmFriendsByAddress,
    myAddress,
    reticulumChatEnabled,
    reticulumDirectSummaries,
    reticulumDirectNamesByAddress,
    userInfo?.name,
  ]);

  const mergedDirectRows = useMemo(() => {
    if (!reticulumChatEnabled) return directs;
    const byAddress = new Map<string, any>();
    for (const direct of directs || []) {
      if (!direct?.address) continue;
      byAddress.set(direct.address, {
        address: direct.address,
        name: direct.name || direct.address,
      });
    }
    for (const direct of reticulumDirectRows) {
      const existing = byAddress.get(direct.address);
      byAddress.set(direct.address, {
        ...(existing || {}),
        ...direct,
        name: direct.name || existing?.name || direct.address,
      });
    }
    return [...byAddress.values()];
  }, [directs, reticulumChatEnabled, reticulumDirectRows]);

  const directChatHasUnread = useMemo(() => {
    let hasUnread = false;
    mergedDirectRows.forEach((direct) => {
      if (
        Number(direct?.unreadCount || 0) > 0 ||
        (!reticulumChatEnabled &&
          direct?.sender !== myAddress &&
          direct?.timestamp &&
          ((!timestampEnterData[direct?.address] &&
            Date.now() - direct?.timestamp <
              timeDifferenceForNotificationChats) ||
            timestampEnterData[direct?.address] < direct?.timestamp))
      ) {
        hasUnread = true;
      }
    });
    return hasUnread;
  }, [timestampEnterData, mergedDirectRows, myAddress, reticulumChatEnabled]);

  const displayDirects = useMemo(() => {
    const merged = mergeDirectsWithFriends(
      mergedDirectRows,
      dmFriendsByAddress,
      myAddress,
      userInfo?.name
    );
    if (!reticulumChatEnabled) return merged;
    return [...merged].sort((a: any, b: any) => {
      const timestampA = Number(a?.timestamp || 0);
      const timestampB = Number(b?.timestamp || 0);
      if (timestampA !== timestampB) return timestampB - timestampA;
      return String(a?.name || a?.address || '').localeCompare(
        String(b?.name || b?.address || '')
      );
    });
  }, [
    mergedDirectRows,
    dmFriendsByAddress,
    myAddress,
    reticulumChatEnabled,
    userInfo?.name,
  ]);

  useEffect(() => {
    if (!reticulumChatEnabled || desktopSideView !== 'directs') return;
    if (selectedDirect || newChat) return;
    const firstDirect = displayDirects[0];
    if (!firstDirect?.address) {
      return;
    }
    setSelectedDirect(firstDirect);
    window
      .sendMessage('addTimestampEnterChat', {
        timestamp: Date.now(),
        groupId: firstDirect.address,
      })
      .catch((error) => {
        console.error(
          'Failed to add timestamp:',
          error.message || 'An error occurred'
        );
      });
    getTimestampEnterChat();
  }, [
    desktopSideView,
    displayDirects,
    getTimestampEnterChat,
    newChat,
    reticulumChatEnabled,
    selectedDirect,
  ]);

  const getSecretKey = useCallback(
    async (loadingGroupParam?: boolean, secretKeyToPublish?: boolean) => {
      try {
        setIsLoadingGroupMessage(
          t('auth:message.generic.locating_encryption_keys', {
            postProcess: 'capitalizeFirstChar',
          })
        );
        pauseAllQueues();

        let dataFromStorage;
        let publishFromStorage;
        let adminsFromStorage;

        if (
          secretKeyToPublish &&
          secretKeyRef.current &&
          lastFetchedSecretKey.current &&
          Date.now() - lastFetchedSecretKey.current <
            TIME_MINUTES_10_IN_MILLISECONDS
        ) {
          return secretKeyRef.current;
        }

        if (loadingGroupParam) {
          setIsLoadingGroup(true);
        }

        if (selectedGroup?.groupId !== selectedGroupRef.current.groupId) {
          if (settimeoutForRefetchSecretKey.current) {
            clearTimeout(settimeoutForRefetchSecretKey.current);
          }
          return;
        }

        const prevGroupId = selectedGroupRef.current.groupId;

        const { names, addresses, both } =
          adminsFromStorage || (await getGroupAdmins(selectedGroup?.groupId));
        setAdmins(addresses);
        setAdminsWithNames(both);

        if (!names.length) throw new Error('Network error');

        const publish =
          publishFromStorage ||
          (await getPublishesFromAdmins(names, selectedGroup?.groupId));

        if (prevGroupId !== selectedGroupRef.current.groupId) {
          if (settimeoutForRefetchSecretKey.current) {
            clearTimeout(settimeoutForRefetchSecretKey.current);
          }
          return;
        }

        if (publish === false) {
          setTriedToFetchSecretKey(true);
          settimeoutForRefetchSecretKey.current = setTimeout(() => {
            getSecretKey();
          }, TIME_MINUTES_2_IN_MILLISECONDS);
          return false;
        }

        setSecretKeyPublishDate(publish?.updated || publish?.created);

        let data;
        if (dataFromStorage) {
          data = dataFromStorage;
        } else {
          setIsLoadingGroupMessage(
            t('auth:message.generic.downloading_encryption_keys', {
              postProcess: 'capitalizeFirstChar',
            })
          );
          const res = await fetch(
            `${getBaseApiReact()}/arbitrary/DOCUMENT_PRIVATE/${publish.name}/${publish.identifier}?encoding=base64&rebuild=true`
          );
          data = await res.text();
        }

        const decryptedKey: any = await decryptResource(data, null);
        const dataint8Array = base64ToUint8Array(decryptedKey.data);
        const decryptedKeyToObject = uint8ArrayToObject(dataint8Array);

        if (!validateSecretKey(decryptedKeyToObject)) {
          throw new Error('SecretKey is not valid');
        }

        setSecretKeyDetails(publish);
        setSecretKey(decryptedKeyToObject);
        lastFetchedSecretKey.current = Date.now();
        setMemberCountFromSecretKeyData(decryptedKey.count);

        window
          .sendMessage('setGroupData', {
            groupId: selectedGroup?.groupId,
            secretKeyData: data,
            secretKeyResource: publish,
            admins: { names, addresses, both },
          })
          .catch((error) => {
            console.error(
              'Failed to set group data:',
              error.message || 'An error occurred'
            );
          });

        if (decryptedKeyToObject) {
          setTriedToFetchSecretKey(true);
          setFirstSecretKeyInCreation(false);
          return decryptedKeyToObject;
        } else {
          setTriedToFetchSecretKey(true);
        }
      } catch (error) {
        if (
          error === 'Unable to decrypt data' ||
          error === 'Unable to decrypt'
        ) {
          setTriedToFetchSecretKey(true);
          settimeoutForRefetchSecretKey.current = setTimeout(() => {
            getSecretKey();
          }, TIME_MINUTES_2_IN_MILLISECONDS);
        }
      } finally {
        setIsLoadingGroup(false);
        setIsLoadingGroupMessage('');
        resumeAllQueues();
      }
    },
    [
      selectedGroup?.groupId,
      setIsLoadingGroup,
      setIsLoadingGroupMessage,
      setSecretKey,
      setSecretKeyDetails,
      setTriedToFetchSecretKey,
      setFirstSecretKeyInCreation,
      setMemberCountFromSecretKeyData,
      setAdmins,
      setAdminsWithNames,
      setSecretKeyPublishDate,
    ]
  );

  /** Fetch secret key for an arbitrary group (e.g. for widget). Same flow as full chat: try cache, then network; cache on success; retry on decrypt failure. */
  const getSecretKeyForGroup = useCallback(
    async (group: { groupId: string } | null): Promise<any> => {
      if (!group?.groupId) return null;
      const groupIdStr = String(group.groupId);
      try {
        // 1. Try cached key (same as full chat when it would use storage)
        const cached: any = await window
          .sendMessage('getGroupDataSingle', { groupId: groupIdStr })
          .catch(() => null);
        if (cached?.secretKeyData && !cached?.error) {
          try {
            const decryptedKey: any = await decryptResource(
              cached.secretKeyData,
              null
            );
            const dataint8Array = base64ToUint8Array(decryptedKey.data);
            const decryptedKeyToObject = uint8ArrayToObject(dataint8Array);
            if (validateSecretKey(decryptedKeyToObject))
              return decryptedKeyToObject;
          } catch {
            // Cached key invalid or decrypt failed, fall through to fetch
          }
        }

        // 2. Fetch from network (same as full getSecretKey)
        const groupIdNum = Number(group.groupId);
        const { names, addresses, both } = await getGroupAdmins(groupIdNum);
        if (!names?.length) return null;
        const publish = await getPublishesFromAdmins(names, groupIdStr);
        if (publish === false) {
          return new Promise((resolve) => {
            setTimeout(
              () => resolve(getSecretKeyForGroup(group)),
              TIME_MINUTES_2_IN_MILLISECONDS
            );
          });
        }
        const res = await fetch(
          `${getBaseApiReact()}/arbitrary/DOCUMENT_PRIVATE/${publish.name}/${publish.identifier}?encoding=base64&rebuild=true`
        );
        const data = await res.text();
        const decryptedKey: any = await decryptResource(data, null);
        const dataint8Array = base64ToUint8Array(decryptedKey.data);
        const decryptedKeyToObject = uint8ArrayToObject(dataint8Array);
        if (!validateSecretKey(decryptedKeyToObject)) return null;

        // 3. Cache for next time (same as full chat setGroupData)
        window
          .sendMessage('setGroupData', {
            groupId: groupIdStr,
            secretKeyData: data,
            secretKeyResource: publish,
            admins: { names, addresses, both },
          })
          .catch(() => {});

        return decryptedKeyToObject;
      } catch (e) {
        if (e === 'Unable to decrypt data') {
          return new Promise((resolve) => {
            setTimeout(
              () => resolve(getSecretKeyForGroup(group)),
              TIME_MINUTES_2_IN_MILLISECONDS
            );
          });
        }
        console.error(e);
        return null;
      }
    },
    []
  );

  const getReticulumMentionNameMap = useCallback(
    async (groupId: number): Promise<Map<string, string>> => {
      const cached = reticulumGroupMentionNameCacheRef.current.get(groupId);
      if (cached) return cached;
      const map = new Map<string, string>();
      let loadedMembers = false;
      try {
        const data = await getGroupMembers(groupId);
        loadedMembers = true;
        if (Array.isArray(data?.members)) {
          for (const member of data.members) {
            const address =
              typeof member?.member === 'string' ? member.member.trim() : '';
            const name =
              typeof member?.primaryName === 'string'
                ? member.primaryName.trim()
                : '';
            if (address && name) map.set(name.toLowerCase(), address);
          }
        }
      } catch (error) {
        console.error(
          '[ReticulumChat] Failed to load members for background mentions:',
          error
        );
      }
      if (myAddress && userInfo?.name) {
        map.set(String(userInfo.name).toLowerCase(), myAddress);
      }
      if (loadedMembers) {
        reticulumGroupMentionNameCacheRef.current.set(groupId, map);
      }
      return map;
    },
    [myAddress, userInfo?.name]
  );

  useEffect(() => {
    reticulumGroupMentionNameCacheRef.current.clear();
  }, [memberGroupsForReticulum, myAddress, userInfo?.name]);

  const processReticulumBackgroundEvent = useCallback(
    async (event: ReticulumBackgroundEvent) => {
      if (!event?.eventId || !event?.groupId || !event?.eventType) return;
      if (hasProcessedReticulumBackgroundEvent(event.eventId)) {
        return;
      }

      if (event.eventType === 'delete') {
        if (event.targetEventId) {
          await window.reticulumChat?.deleteSearchText?.(event.targetEventId);
          await window.reticulumChat?.deleteMentions?.(event.targetEventId);
          noteProcessedReticulumBackgroundEvent(event.eventId);
          scheduleReticulumChatSummariesRefresh();
        }
        return;
      }

      if (
        event.eventType !== 'message' &&
        event.eventType !== 'edit' &&
        event.eventType !== 'attachment_manifest'
      ) {
        return;
      }

      const groupId = Number(event.groupId);
      if (!Number.isInteger(groupId) || groupId <= 0) return;
      const groupProperty = groupsPropertiesRef.current?.[String(groupId)] as
        | { isOpen?: boolean }
        | undefined;
      if (groupProperty?.isOpen !== true && groupProperty?.isOpen !== false) {
        return;
      }

      let payload: unknown = null;
      try {
        payload = JSON.parse(String(event.encryptedPayload || ''));
      } catch {
        payload = event.encryptedPayload || '';
      }

      const text = reticulumTextFromPayload(payload);
      const targetEventId =
        event.eventType === 'edit' && event.targetEventId
          ? event.targetEventId
          : event.eventId;
      if (!targetEventId || !text) {
        noteProcessedReticulumBackgroundEvent(event.eventId);
        scheduleReticulumChatSummariesRefresh();
        return;
      }

      await window.reticulumChat?.indexSearchText?.(targetEventId, text);
      const mentionMap = await getReticulumMentionNameMap(groupId);
      await window.reticulumChat?.replaceMentions?.(targetEventId, [
        ...new Set([
          ...reticulumMentionedAddressesFromPayload(payload),
          ...resolveReticulumMentionAddresses(text, mentionMap),
        ]),
      ]);
      noteProcessedReticulumBackgroundEvent(event.eventId);
      scheduleReticulumChatSummariesRefresh();
    },
    [
      getReticulumMentionNameMap,
      hasProcessedReticulumBackgroundEvent,
      noteProcessedReticulumBackgroundEvent,
      scheduleReticulumChatSummariesRefresh,
    ]
  );

  useEffect(() => {
    if (!myAddress) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      const enabled = await window.reticulumChat?.isEnabled?.();
      if (cancelled || enabled !== true) return;
      unsubscribe = window.reticulumChat?.onEvent?.((payload) => {
        const event = payload?.event as ReticulumBackgroundEvent | undefined;
        if (!event?.eventId) return;
        void processReticulumBackgroundEvent(event).catch((error) => {
          console.error(
            '[ReticulumChat] Background event processing failed:',
            error
          );
        });
      });
      if (cancelled) unsubscribe?.();
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [myAddress, processReticulumBackgroundEvent]);

  useEffect(() => {
    if (!myAddress) return;
    const groupIds = getGroupIdsFromGroupLikeList(memberGroupsForReticulum);
    if (groupIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      const enabled = await window.reticulumChat?.isEnabled?.();
      if (cancelled || enabled !== true) return;
      for (const groupId of groupIds) {
        if (cancelled) return;
        const history = await window.reticulumChat?.getHistory?.(
          groupId,
          'general',
          50,
          { repairNetwork: false }
        );
        if (cancelled || !Array.isArray(history)) continue;
        for (const event of history as ReticulumBackgroundEvent[]) {
          if (cancelled) return;
          await processReticulumBackgroundEvent(event);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    groupsProperties,
    memberGroupsForReticulum,
    myAddress,
    processReticulumBackgroundEvent,
  ]);

  const getAdminsForPublic = useCallback(async (selectedGroup) => {
    try {
      const { names, addresses, both } = await getGroupAdmins(
        selectedGroup?.groupId
      );
      setAdmins(addresses);
      setAdminsWithNames(both);
    } catch (error) {
      console.log(error);
    }
  }, []);

  useEffect(() => {
    if (selectedGroup && isPrivate !== null) {
      if (isPrivate) {
        setTriedToFetchSecretKey(false);
        getSecretKey(true);
      }

      getGroupOwner(selectedGroup?.groupId);
    }
    if (isPrivate === false) {
      setTriedToFetchSecretKey(true);
      if (selectedGroup?.groupId !== '0') {
        getAdminsForPublic(selectedGroup);
      }
    }
  }, [
    selectedGroup,
    isPrivate,
    getSecretKey,
    getGroupOwner,
    getAdminsForPublic,
  ]);

  const getCountNewMesg = async (groupId, after) => {
    try {
      const response = await fetch(
        `${getBaseApiReact()}/chat/messages?after=${after}&txGroupId=${groupId}&haschatreference=false&encoding=BASE64&limit=1`
      );
      const data = await response.json();
      if (data && data[0]) return data[0].timestamp;
    } catch (error) {
      console.log(error);
    }
  };

  const getLatestRegularChat = useCallback(async (groups) => {
    try {
      const groupData = {};

      const getGroupData = groups.map(async (group) => {
        if (!group.groupId || !group?.timestamp) return null;
        if (
          !groupData[group.groupId] ||
          groupData[group.groupId] < group.timestamp
        ) {
          const hasMoreRecentMsg = await getCountNewMesg(
            group.groupId,
            timestampEnterDataRef.current[group?.groupId] ||
              Date.now() - TIME_DAYS_1_IN_MILLISECONDS
          );
          if (hasMoreRecentMsg) {
            groupData[group.groupId] = hasMoreRecentMsg;
          }
        } else {
          return null;
        }
      });

      await Promise.all(getGroupData);
      setGroupChatTimestamps(groupData);
    } catch (error) {
      console.log(error);
    }
  }, []);

  useEffect(() => {
    groupsPropertiesRef.current = groupsProperties;
  }, [groupsProperties]);

  const getGroupsProperties = useCallback(async (address) => {
    try {
      const url = `${getBaseApiReact()}/groups/member/${address}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Cannot get group properties');
      const data = await response.json();
      const transformToObject = data.reduce((result, item) => {
        result[item.groupId] = item;
        return result;
      }, {});
      setGroupsProperties(transformToObject);

      // Use ownerPrimaryName from API when present (no fallback — missing means no primary name)
      const ownerNamesFromApi: Record<string, string> = {};
      Object.keys(transformToObject).forEach((key) => {
        const item = transformToObject[key];
        if (item?.ownerPrimaryName) {
          ownerNamesFromApi[key] = item.ownerPrimaryName;
          groupsOwnerNamesRef.current[key] = item.ownerPrimaryName;
        }
      });
      if (Object.keys(ownerNamesFromApi).length > 0) {
        setGroupsOwnerNames((prev) => ({ ...prev, ...ownerNamesFromApi }));
      }
    } catch (error) {
      console.log(error);
    }
  }, []);

  const getGroupsWhereIAmAMember = useCallback(
    async (_groups) => {
      if (!myAddress) return false;
      const requestedAddress = myAddress;
      try {
        const response = await fetch(
          `${getBaseApiReact()}/groups/member/${requestedAddress}?adminOnly=true`
        );
        if (!response.ok) {
          throw new Error(`Unable to load group admins: ${response.status}`);
        }
        const data = await response.json();
        if (myAddressRef.current !== requestedAddress) return false;
        const groupsAsAdmin = Array.isArray(data) ? data : (data?.groups ?? []);
        setMyGroupsWhereIAmAdmin((current) =>
          areKeysEqual(
            getGroupIdsFromGroupLikeList(current),
            getGroupIdsFromGroupLikeList(groupsAsAdmin)
          )
            ? current
            : groupsAsAdmin
        );
        setReticulumAdminGroupsLoadedAddress(requestedAddress);
        return true;
      } catch (error) {
        console.error(error);
        if (myAddressRef.current === requestedAddress) {
          setMyGroupsWhereIAmAdmin([]);
          setReticulumAdminGroupsLoadedAddress(requestedAddress);
        }
        return false;
      }
    },
    [myAddress, setMyGroupsWhereIAmAdmin]
  );

  useEffect(() => {
    // Handler function for incoming messages
    const messageHandler = (event) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const message = event.data;
      if (message?.action === 'SET_GROUPS') {
        const sortedFiltered = sortArrayByTimestampAndGroupName(
          message.payload || []
        ).filter((item: any) => item?.groupId !== '0');
        setMemberGroups(sortedFiltered);
        if (myAddressRef.current) {
          setMemberGroupsLoadedAddress(myAddressRef.current);
        }
        memberGroupsRef.current = sortedFiltered;
        getLatestRegularChat(sortedFiltered);

        // Only mark messages as read if user is actually viewing the chat
        if (
          selectedGroupRef.current &&
          groupSectionRef.current === 'chat' &&
          (desktopViewModeRef.current === 'chat' ||
            qChatTabActiveRef.current ||
            mobileViewModeRef.current === 'chat')
        ) {
          window
            .sendMessage('addTimestampEnterChat', {
              timestamp: Date.now(),
              groupId: selectedGroupRef.current.groupId,
            })
            .catch((error) => {
              console.error(
                'Failed to add timestamp:',
                error.message || 'An error occurred'
              );
            });
        }

        // Only mark direct messages as read if user is actually viewing the chat
        if (
          selectedDirectRef.current &&
          (desktopViewModeRef.current === 'chat' ||
            qChatTabActiveRef.current ||
            mobileViewModeRef.current === 'chat')
        ) {
          window
            .sendMessage('addTimestampEnterChat', {
              timestamp: Date.now(),
              groupId: selectedDirectRef.current.address,
            })
            .catch((error) => {
              console.error(
                'Failed to add timestamp:',
                error.message || 'An error occurred'
              );
            });
        }

        setTimeout(() => {
          getTimestampEnterChat();
        }, 600);
      }

      if (message?.action === 'SET_GROUP_ANNOUNCEMENTS') {
        // Update the component state with the received 'sendqort' state
        setGroupAnnouncements(message.payload);

        // Only mark announcements as read if user is actually viewing the announcement section
        if (
          selectedGroupRef.current &&
          groupSectionRef.current === 'announcement' &&
          (desktopViewModeRef.current === 'chat' ||
            qChatTabActiveRef.current ||
            mobileViewModeRef.current === 'group')
        ) {
          window
            .sendMessage('addGroupNotificationTimestamp', {
              timestamp: Date.now(),
              groupId: selectedGroupRef.current.groupId,
            })
            .catch((error) => {
              console.error(
                'Failed to add group notification timestamp:',
                error.message || 'An error occurred'
              );
            });

          setTimeout(() => {
            getGroupAnnouncements();
          }, 200);
        }
      }

      if (message?.action === 'SET_DIRECTS') {
        // Update the component state with the received 'sendqort' state
        setDirects(message.payload);
      } else if (message?.action === 'PLAY_NOTIFICATION_SOUND') {
        // audio.play();
      }
    };

    // Attach the event listener
    window.addEventListener('message', messageHandler);

    // Clean up the event listener on component unmount
    return () => {
      window.removeEventListener('message', messageHandler);
    };
  }, []);

  const getMembers = useCallback(async (groupId) => {
    try {
      const res = await getGroupMembers(groupId);
      if (groupId !== selectedGroupRef.current?.groupId) return;
      setMembers(res);
    } catch (error) {
      console.log(error);
    }
  }, []);

  useEffect(() => {
    if (
      !initiatedGetMembers.current &&
      selectedGroup?.groupId &&
      secretKey &&
      admins.includes(myAddress) &&
      selectedGroup?.groupId !== '0'
    ) {
      // getAdmins(selectedGroup?.groupId);
      getMembers(selectedGroup?.groupId);
      initiatedGetMembers.current = true;
    }
  }, [selectedGroup?.groupId, secretKey, myAddress, admins]);

  const shouldReEncrypt = useMemo(() => {
    if (triedToFetchSecretKey && !secretKeyPublishDate) return true;
    if (
      !secretKeyPublishDate ||
      !memberCountFromSecretKeyData ||
      members?.length === 0
    )
      return false;
    const isDiffMemberNumber =
      memberCountFromSecretKeyData !== members?.memberCount &&
      newEncryptionNotification?.decryptedData?.data?.numberOfMembers !==
        members?.memberCount;

    if (isDiffMemberNumber) return true;

    const latestJoined = members?.members.reduce((maxJoined, current) => {
      return current.joined > maxJoined ? current.joined : maxJoined;
    }, members?.members[0].joined);

    if (
      secretKeyPublishDate < latestJoined &&
      newEncryptionNotification?.data?.timestamp < latestJoined
    ) {
      return true;
    }
    return false;
  }, [
    memberCountFromSecretKeyData,
    members,
    secretKeyPublishDate,
    newEncryptionNotification,
    triedToFetchSecretKey,
  ]);

  const notifyAdmin = useCallback(
    async (admin) => {
      try {
        setIsLoadingNotifyAdmin(true);
        await new Promise((res, rej) => {
          window
            .sendMessage('notifyAdminRegenerateSecretKey', {
              adminAddress: admin.address,
              groupName: selectedGroup?.groupName,
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
        setInfoSnack({
          type: 'success',
          message: 'Successfully sent notification.',
        });
        setOpenSnack(true);
      } catch (error) {
        setInfoSnack({
          type: 'error',
          message: 'Unable to send notification',
        });
      } finally {
        setIsLoadingNotifyAdmin(false);
      }
    },
    [selectedGroup?.groupName, t]
  );

  const isUnread = useMemo(() => {
    if (!selectedGroup) return false;
    return (
      groupAnnouncements?.[selectedGroup?.groupId]?.seentimestamp === false
    );
  }, [groupAnnouncements, selectedGroup]);

  const openDirectChatFromNotification = useCallback(
    (e) => {
      if (isLoadingOpenSectionFromNotification.current) return;
      isLoadingOpenSectionFromNotification.current = true;
      const directAddress = e.detail?.from;

      const findDirect = displayDirects?.find(
        (direct) => direct?.address === directAddress
      );
      if (findDirect?.address === selectedDirect?.address) {
        openQChatTab();
        isLoadingOpenSectionFromNotification.current = false;
        return;
      }
      if (findDirect) {
        setDesktopSideView('directs');
        openQChatTab();
        setSelectedDirect(null);

        setNewChat(false);

        window
          .sendMessage('addTimestampEnterChat', {
            timestamp: Date.now(),
            groupId: findDirect.address,
          })
          .catch((error) => {
            console.error(
              'Failed to add timestamp:',
              error.message || 'An error occurred'
            );
          });

        setTimeout(() => {
          setSelectedDirect(findDirect);
          getTimestampEnterChat();
          isLoadingOpenSectionFromNotification.current = false;
        }, 200);
      } else {
        isLoadingOpenSectionFromNotification.current = false;
      }
    },
    [displayDirects, selectedDirect?.address, getTimestampEnterChat]
  );

  const openDirectChatFromInternal = useCallback(
    (e) => {
      const directAddress = e.detail?.address;
      const name = e.detail?.name;
      const findDirect = displayDirects?.find(
        (direct) => direct?.address === directAddress || direct?.name === name
      );

      if (findDirect) {
        openQChatTab();
        setDesktopSideView('directs');
        setSelectedDirect(null);

        setNewChat(false);

        window
          .sendMessage('addTimestampEnterChat', {
            timestamp: Date.now(),
            groupId: findDirect.address,
          })
          .catch((error) => {
            console.error(
              'Failed to add timestamp:',
              error.message || 'An error occurred'
            );
          });

        setTimeout(() => {
          setSelectedDirect(findDirect);
          getTimestampEnterChat();
        }, 200);
      } else {
        openQChatTab();
        setDesktopSideView('directs');
        setNewChat(true);
        setTimeout(() => {
          executeEvent('setDirectToValueNewChat', {
            directToValue: name || directAddress,
          });
        }, 500);
      }
    },
    [displayDirects, getTimestampEnterChat]
  );

  useEffect(() => {
    subscribeToEvent('openDirectMessageInternal', openDirectChatFromInternal);

    return () => {
      unsubscribeFromEvent(
        'openDirectMessageInternal',
        openDirectChatFromInternal
      );
    };
  }, [displayDirects, selectedDirect, openDirectChatFromInternal]);

  useEffect(() => {
    subscribeToEvent('openDirectMessage', openDirectChatFromNotification);

    return () => {
      unsubscribeFromEvent('openDirectMessage', openDirectChatFromNotification);
    };
  }, [
    displayDirects,
    selectedDirect,
    openDirectChatFromNotification,
    openDirectChatFromInternal,
  ]);

  const handleMarkAsRead = useCallback(
    (e) => {
      const { groupId } = e.detail;
      window
        .sendMessage('addTimestampEnterChat', {
          timestamp: Date.now(),
          groupId,
        })
        .catch((error) => {
          console.error(
            'Failed to add timestamp:',
            error.message || 'An error occurred'
          );
        });

      window
        .sendMessage('addGroupNotificationTimestamp', {
          timestamp: Date.now(),
          groupId,
        })
        .catch((error) => {
          console.error(
            'Failed to add group notification timestamp:',
            error.message || 'An error occurred'
          );
        });

      setTimeout(() => {
        getGroupAnnouncements();
        getTimestampEnterChat();
      }, 200);
    },
    [getGroupAnnouncements, getTimestampEnterChat]
  );

  const handleMarkAllMemberGroupsRead = useCallback(() => {
    const ids = (memberGroupsRef.current || [])
      .map((g) => g?.groupId)
      .filter((id) => id != null && id !== '');
    if (!ids.length) return;

    window
      .sendMessage('markAllMemberGroupsRead', { groupIds: ids })
      .then((response) => {
        if (response?.error) {
          console.error('Failed to mark all groups read:', response.error);
        }
      })
      .catch((error) => {
        console.error(
          'Failed to mark all groups read:',
          error.message || 'An error occurred'
        );
      });

    setTimeout(() => {
      getGroupAnnouncements();
      getTimestampEnterChat();
    }, 200);
  }, [getGroupAnnouncements, getTimestampEnterChat]);

  useEffect(() => {
    subscribeToEvent('markAsRead', handleMarkAsRead);

    return () => {
      unsubscribeFromEvent('markAsRead', handleMarkAsRead);
    };
  }, [handleMarkAsRead]);

  useEffect(() => {
    subscribeToEvent('markAllMemberGroupsRead', handleMarkAllMemberGroupsRead);

    return () => {
      unsubscribeFromEvent(
        'markAllMemberGroupsRead',
        handleMarkAllMemberGroupsRead
      );
    };
  }, [handleMarkAllMemberGroupsRead]);

  const resetAllStatesAndRefs = useCallback(() => {
    // Reset all useState values to their initial states
    setSecretKey(null);
    secretKeyRef.current = null;
    lastFetchedSecretKey.current = null;
    reticulumBackgroundProcessedEventIdsRef.current.clear();
    setSecretKeyPublishDate(null);
    setSecretKeyDetails(null);
    setNewEncryptionNotification(null);
    setMemberCountFromSecretKeyData(null);
    setIsForceShowCreationKeyPopup(false);
    setSelectedGroup(null);
    setSelectedDirect(null);
    setMemberGroups([]);
    setMemberGroupsLoadedAddress('');
    memberGroupsRef.current = [];
    setDirects([]);
    setAdmins([]);
    setAdminsWithNames([]);
    setMembers([]);
    setGroupOwner(null);
    setTriedToFetchSecretKey(false);
    setHideCommonKeyPopup(false);
    setOpenAddGroup(false);
    setOpenManageMembers(false);
    setTimestampEnterData({});
    setChatMode('groups');
    setNewChat(false);
    setOpenSnack(false);
    setInfoSnack(null);
    setIsLoadingNotifyAdmin(false);
    setIsLoadingGroups(false);
    setIsLoadingGroup(false);
    setFirstSecretKeyInCreation(false);
    setGroupSection('home');
    setGroupAnnouncements({});
    setDefaultThread(null);
    setMobileViewMode('home');
    setIsQChatTabActive(false);
    // Reset all useRef values to their initial states
    hasInitializedWebsocket.current = false;
    myAddressRef.current = '';
    selectedGroupRef.current = null;
    selectedDirectRef.current = null;
    groupSectionRef.current = null;
    qChatTabActiveRef.current = false;
    isLoadingOpenSectionFromNotification.current = false;
    settimeoutForRefetchSecretKey.current = null;
    initiatedGetMembers.current = false;
    setDesktopViewMode('home');
  }, []);

  const logoutEventFunc = useCallback(() => {
    resetAllStatesAndRefs();
    clearStatesMessageQueueProvider();
  }, [resetAllStatesAndRefs, clearStatesMessageQueueProvider]);

  useEffect(() => {
    subscribeToEvent('logout-event', logoutEventFunc);

    return () => {
      unsubscribeFromEvent('logout-event', logoutEventFunc);
    };
  }, [logoutEventFunc]);

  const openAppsMode = useCallback(() => {
    setDesktopViewMode('apps');
  }, []);

  useEffect(() => {
    subscribeToEvent('open-apps-mode', openAppsMode);

    return () => {
      unsubscribeFromEvent('open-apps-mode', openAppsMode);
    };
  }, [openAppsMode]);

  const openHomeMode = useCallback(() => {
    setDesktopViewMode('home');
  }, []);

  useEffect(() => {
    subscribeToEvent('open-home-mode', openHomeMode);

    return () => {
      unsubscribeFromEvent('open-home-mode', openHomeMode);
    };
  }, [openHomeMode]);

  const returnFromAppsMode = useCallback(() => {
    setDesktopViewMode(lastNonQappDesktopViewModeRef.current || 'home');
  }, [setDesktopViewMode]);

  useEffect(() => {
    subscribeToEvent('return-from-apps-mode', returnFromAppsMode);

    return () => {
      unsubscribeFromEvent('return-from-apps-mode', returnFromAppsMode);
    };
  }, [returnFromAppsMode]);

  const openGroupDiscovery = useCallback(() => {
    setChatMode('groups');
    setDesktopSideView('groups');
    setSelectedGroup(null);
    setSelectedDirect(null);
    setNewChat(false);
    openQChatTab();
    setOpenAddGroup(false);
    setOpenFindGroup(true);
  }, []);

  const hasConfirmedNoReticulumGroups =
    reticulumChatEnabled &&
    memberGroupsLoadedAddress === myAddress &&
    getGroupIdsFromGroupLikeList(memberGroupsForReticulum).length === 0;
  const hasConfirmedReticulumGroups =
    reticulumChatEnabled &&
    memberGroupsLoadedAddress === myAddress &&
    getGroupIdsFromGroupLikeList(memberGroupsForReticulum).length > 0;
  const reticulumActivityDashboardReady =
    hasConfirmedReticulumGroups &&
    reticulumMembershipsAppliedKey === reticulumMembershipsKey &&
    reticulumSummariesLoadedMembershipKey === reticulumMembershipsKey;
  const reticulumHasUnreadActivity = memberGroupsWithReticulumActivity.some(
    (group: any) => {
      const summary = group?.reticulumChatSummary;
      return (
        Number(summary?.unreadCount || 0) > 0 ||
        Number(summary?.mentionCount || 0) > 0 ||
        summary?.hasUnreadMention === true
      );
    }
  );
  const reticulumWelcomeDisplayName =
    typeof userInfo?.name === 'string' &&
    userInfo.name.trim() &&
    userInfo.name.trim() !== myAddress
      ? userInfo.name.trim()
      : undefined;

  useEffect(() => {
    if (!reticulumChatEnabled) return undefined;
    return startReticulumGroupScoreScheduler();
  }, [reticulumChatEnabled]);

  useEffect(() => {
    subscribeToEvent('open-group-discovery', openGroupDiscovery);

    return () => {
      unsubscribeFromEvent('open-group-discovery', openGroupDiscovery);
    };
  }, [openGroupDiscovery]);

  const openDevMode = useCallback(() => {
    setDesktopViewMode('dev');
  }, []);

  useEffect(() => {
    subscribeToEvent('open-dev-mode', openDevMode);

    return () => {
      unsubscribeFromEvent('open-dev-mode', openDevMode);
    };
  }, [openDevMode]);

  const openGroupChatFromNotification = useCallback(
    (e) => {
      if (isLoadingOpenSectionFromNotification.current) return;

      const groupId = e.detail?.from;
      const channelId =
        typeof e.detail?.channelId === 'string' ? e.detail.channelId : '';
      if (channelId) {
        setNotificationReticulumChannelId(channelId);
      }
      const findGroup = memberGroupsRef.current?.find(
        (group: any) => +group?.groupId === +groupId
      );
      if (findGroup?.groupId === selectedGroup?.groupId) {
        isLoadingOpenSectionFromNotification.current = false;
        setChatMode('groups');
        setGroupSection('chat');
        bumpReticulumReadEntryToken();
        openQChatTab();
        return;
      }
      if (findGroup) {
        setChatMode('groups');
        setSelectedGroup(null);
        setSelectedDirect(null);

        setNewChat(false);
        setSecretKey(null);
        secretKeyRef.current = null;
        setGroupOwner(null);
        lastFetchedSecretKey.current = null;
        initiatedGetMembers.current = false;
        setSecretKeyPublishDate(null);
        setAdmins([]);
        setSecretKeyDetails(null);
        setAdminsWithNames([]);
        setMembers([]);
        setMemberCountFromSecretKeyData(null);
        setIsForceShowCreationKeyPopup(false);
        setTriedToFetchSecretKey(false);
        setFirstSecretKeyInCreation(false);
        setGroupSection('chat');
        bumpReticulumReadEntryToken();
        openQChatTab();

        window
          .sendMessage('addTimestampEnterChat', {
            timestamp: Date.now(),
            groupId: findGroup.groupId,
          })
          .catch((error) => {
            console.error(
              'Failed to add timestamp:',
              error.message || 'An error occurred'
            );
          });

        setTimeout(() => {
          setSelectedGroup(findGroup);
          setMobileViewMode('group');
          setDesktopSideView('groups');
          getTimestampEnterChat();
          isLoadingOpenSectionFromNotification.current = false;
        }, 350);
      } else {
        isLoadingOpenSectionFromNotification.current = false;
      }
    },
    [bumpReticulumReadEntryToken, selectedGroup?.groupId, getTimestampEnterChat]
  );

  useEffect(() => {
    subscribeToEvent('openGroupMessage', openGroupChatFromNotification);

    return () => {
      unsubscribeFromEvent('openGroupMessage', openGroupChatFromNotification);
    };
  }, [openGroupChatFromNotification]);

  const openGroupAnnouncementFromNotification = useCallback(
    (e) => {
      const groupId = e.detail?.from;

      const findGroup = memberGroupsRef.current?.find(
        (group: any) => +group?.groupId === +groupId
      );
      if (findGroup?.groupId === selectedGroup?.groupId) {
        setGroupSection('announcement');
        openQChatTab();
        return;
      }
      if (findGroup) {
        setChatMode('groups');
        setSelectedGroup(null);
        setSecretKey(null);
        secretKeyRef.current = null;
        setGroupOwner(null);
        lastFetchedSecretKey.current = null;
        initiatedGetMembers.current = false;
        setSecretKeyPublishDate(null);
        setAdmins([]);
        setSecretKeyDetails(null);
        setAdminsWithNames([]);
        setMembers([]);
        setMemberCountFromSecretKeyData(null);
        setIsForceShowCreationKeyPopup(false);
        setTriedToFetchSecretKey(false);
        setFirstSecretKeyInCreation(false);
        setGroupSection('announcement');
        openQChatTab();
        window
          .sendMessage('addGroupNotificationTimestamp', {
            timestamp: Date.now(),
            groupId: findGroup.groupId,
          })
          .catch((error) => {
            console.error(
              'Failed to add group notification timestamp:',
              error.message || 'An error occurred'
            );
          });

        setTimeout(() => {
          setSelectedGroup(findGroup);
          setMobileViewMode('group');
          setDesktopSideView('groups');
          getGroupAnnouncements();
        }, 350);
      }
    },
    [selectedGroup?.groupId, getGroupAnnouncements]
  );

  useEffect(() => {
    subscribeToEvent(
      'openGroupAnnouncement',
      openGroupAnnouncementFromNotification
    );

    return () => {
      unsubscribeFromEvent(
        'openGroupAnnouncement',
        openGroupAnnouncementFromNotification
      );
    };
  }, [openGroupAnnouncementFromNotification]);

  const openThreadNewPostFunc = useCallback(
    (e) => {
      const data = e.detail?.data;
      const { groupId } = data;
      const findGroup = memberGroupsRef.current?.find(
        (group: any) => +group?.groupId === +groupId
      );
      if (findGroup?.groupId === selectedGroup?.groupId) {
        setGroupSection('forum');
        setDefaultThread(data);
        openQChatTab();

        return;
      }
      if (findGroup) {
        setChatMode('groups');
        setSelectedGroup(null);
        setSecretKey(null);
        secretKeyRef.current = null;
        setGroupOwner(null);
        lastFetchedSecretKey.current = null;
        initiatedGetMembers.current = false;
        setSecretKeyPublishDate(null);
        setAdmins([]);
        setSecretKeyDetails(null);
        setAdminsWithNames([]);
        setMembers([]);
        setMemberCountFromSecretKeyData(null);
        setIsForceShowCreationKeyPopup(false);
        setTriedToFetchSecretKey(false);
        setFirstSecretKeyInCreation(false);
        setGroupSection('forum');
        setDefaultThread(data);
        openQChatTab();
        setTimeout(() => {
          setSelectedGroup(findGroup);
          setMobileViewMode('group');
          setDesktopSideView('groups');
          getGroupAnnouncements();
        }, 350);
      }
    },
    [selectedGroup?.groupId, getGroupAnnouncements]
  );

  useEffect(() => {
    subscribeToEvent('openThreadNewPost', openThreadNewPostFunc);

    return () => {
      unsubscribeFromEvent('openThreadNewPost', openThreadNewPostFunc);
    };
  }, [openThreadNewPostFunc]);

  const handleSecretKeyCreationInProgress = useCallback(() => {
    setFirstSecretKeyInCreation(true);
  }, []);

  const getUserAvatarUrl = useCallback((name?: string) => {
    return name
      ? `${getBaseApiReact()}/arbitrary/THUMBNAIL/${name}/qortal_avatar?async=true`
      : '';
  }, []);

  const openAvatarPreview = useCallback(
    (src: string | null, alt?: string) => {
      if (!src) return;
      setAvatarPreviewData({
        src,
        alt: alt || '',
      });
    },
    [setAvatarPreviewData]
  );

  const closeAvatarPreview = useCallback(() => {
    setAvatarPreviewData(null);
  }, [setAvatarPreviewData]);

  const goToHome = useCallback(async () => {
    setDesktopViewMode('home');

    await new Promise((res) => {
      setTimeout(() => {
        res(null);
      }, 200);
    });
  }, []);

  const goToAnnouncements = useCallback(() => {
    setSelectedDirect(null);
    setNewChat(false);
    setGroupSection('announcement');
    window
      .sendMessage('addGroupNotificationTimestamp', {
        timestamp: Date.now(),
        groupId: selectedGroupRef.current.groupId,
      })
      .catch((error) => {
        console.error(
          'Failed to add group notification timestamp:',
          error.message || 'An error occurred'
        );
      });

    setTimeout(() => {
      getGroupAnnouncements();
    }, 200);
  }, [getGroupAnnouncements]);

  const openDrawerGroups = useCallback(() => {
    setIsOpenDrawer(true);
  }, []);

  const goToThreads = useCallback(() => {
    setSelectedDirect(null);
    setNewChat(false);
    if (reticulumChatEnabled && groupSection === 'forum') {
      setGroupSection('chat');
      bumpReticulumReadEntryToken();
      return;
    }
    setGroupSection('forum');
  }, [bumpReticulumReadEntryToken, groupSection, reticulumChatEnabled]);

  const goToQortalLand = useCallback(() => {
    setSelectedDirect(null);
    setNewChat(false);
    setGroupSection('land');
  }, []);

  const goToChat = useCallback(() => {
    setGroupSection('chat');
    bumpReticulumReadEntryToken();
    setNewChat(false);
    setSelectedDirect(null);
    if (selectedGroupRef.current) {
      window
        .sendMessage('addTimestampEnterChat', {
          timestamp: Date.now(),
          groupId: selectedGroupRef.current.groupId,
        })
        .catch((error) => {
          console.error(
            'Failed to add timestamp:',
            error.message || 'An error occurred'
          );
        });

      setTimeout(() => {
        getTimestampEnterChat();
      }, 200);
    }
  }, [bumpReticulumReadEntryToken, getTimestampEnterChat]);

  useEffect(() => {
    if (
      reticulumChatEnabled &&
      (groupSection === 'announcement' || groupSection === 'adminSpace')
    ) {
      setGroupSection('chat');
    }
  }, [groupSection, reticulumChatEnabled]);

  const toggleReticulumMembersPanel = useCallback(() => {
    setReticulumMembersPanelOpen((open) => !open);
  }, []);

  const handleReticulumChannelSelected = useCallback(
    (channelId: string) => {
      const normalizedChannelId = channelId || 'general';
      setActiveReticulumChannelId((previousChannelId) => {
        const previous = previousChannelId || 'general';
        if (previous !== normalizedChannelId) {
          bumpReticulumReadEntryToken();
        }
        return normalizedChannelId;
      });
      if (
        notificationReticulumChannelId &&
        notificationReticulumChannelId === normalizedChannelId
      ) {
        setNotificationReticulumChannelId('');
      }
    },
    [bumpReticulumReadEntryToken, notificationReticulumChannelId]
  );

  useEffect(() => {
    if (!reticulumChatEnabled) return;
    const closeMembersPanel = () => setReticulumMembersPanelOpen(false);
    subscribeToEvent('closeReticulumMembersPanel', closeMembersPanel);
    return () =>
      unsubscribeFromEvent('closeReticulumMembersPanel', closeMembersPanel);
  }, [reticulumChatEnabled]);

  const loadingGroupSnackbarInfo = useMemo(
    () => ({
      message:
        isLoadingGroupMessage ||
        t('group:message.generic.setting_group', {
          postProcess: 'capitalizeFirstChar',
        }),
    }),
    [isLoadingGroupMessage, t]
  );

  const loadingGroupsSnackbarInfo = useMemo(
    () => ({
      message: t('group:message.generic.setting_group', {
        postProcess: 'capitalizeFirstChar',
      }),
    }),
    [t]
  );

  const notPartOfKeys = useMemo(() => {
    return (
      isPrivate &&
      !admins.includes(myAddress) &&
      !secretKey &&
      triedToFetchSecretKey
    );
  }, [isPrivate, admins, myAddress, secretKey, triedToFetchSecretKey]);

  const closeChatDirect = useCallback(() => {
    setSelectedDirect(null);
    setNewChat(false);
  }, []);

  const isReticulumDirectOverlayOpen =
    reticulumChatEnabled && desktopSideView === 'directs';

  const setDesktopSideViewFromRail = useCallback(
    (view: 'groups' | 'directs') => {
      if (reticulumChatEnabled && view === 'directs') {
        setDesktopSideView((currentView) =>
          currentView === 'directs' ? 'groups' : 'directs'
        );
        return;
      }
      setDesktopSideView(view);
    },
    [reticulumChatEnabled]
  );

  const handleNotifyAdminClick = useCallback(
    (e: { currentTarget: HTMLElement | null }) => {
      const address = e.currentTarget?.getAttribute('data-admin-address');
      const admin = adminsWithNames.find((a) => a?.address === address);
      if (admin) notifyAdmin(admin);
    },
    [adminsWithNames, notifyAdmin]
  );

  const selectGroupFunc = useCallback(
    (group) => {
      setMobileViewMode('group');
      setDesktopSideView('groups');
      initiatedGetMembers.current = false;
      clearAllQueues();
      setSelectedDirect(null);
      setTriedToFetchSecretKey(false);
      setNewChat(false);
      setSelectedGroup(group);
      setUserInfoForLevels({});
      setSecretKey(null);
      secretKeyRef.current = null;
      lastFetchedSecretKey.current = null;
      setSecretKeyPublishDate(null);
      setAdmins([]);
      setSecretKeyDetails(null);
      setAdminsWithNames([]);
      setGroupOwner(null);
      setMembers([]);
      setMemberCountFromSecretKeyData(null);
      setHideCommonKeyPopup(false);
      setFirstSecretKeyInCreation(false);
      setGroupSection('chat');
      bumpReticulumReadEntryToken();
      setIsOpenDrawer(false);
      setIsForceShowCreationKeyPopup(false);
    },
    [bumpReticulumReadEntryToken]
  );

  const selectedGroupIdKey = selectedGroup?.groupId
    ? String(selectedGroup.groupId)
    : '';
  const canManageReticulumGroup = Boolean(
    reticulumAdminGroupIds.has(Number(selectedGroup?.groupId)) ||
    admins.includes(myAddress) ||
    groupOwner?.owner === myAddress
  );
  const mountedReticulumSections =
    reticulumMountedGroupSections[selectedGroupIdKey] || [];
  const shouldMountReticulumSection = useCallback(
    (section: string) =>
      groupSection === section || mountedReticulumSections.includes(section),
    [groupSection, mountedReticulumSections]
  );

  const renderQChatTabContent = ({
    hide = false,
    isSelected,
  }: {
    hide?: boolean;
    isSelected: boolean;
  }) => {
    const isVisible = isSelected && !hide;

    return (
      <Box
        sx={{
          backgroundColor: 'background.default',
          display: 'flex',
          height: '100%',
          minHeight: 0,
          overflow: 'hidden',
          position: 'relative',
          width: '100%',
        }}
      >
        {reticulumChatEnabled && <ReticulumGroupAboutModal />}
        {reticulumChatEnabled || desktopSideView !== 'directs' ? (
          <GroupList
            selectGroupFunc={selectGroupFunc}
            setDesktopSideView={setDesktopSideViewFromRail}
            desktopSideView={desktopSideView}
            directChatHasUnread={directChatHasUnread}
            chatMode={chatMode}
            selectedGroup={selectedGroup}
            getUserSettings={getUserSettings}
            setOpenAddGroup={setOpenAddGroup}
            setOpenFindGroup={setOpenFindGroup}
            setIsOpenBlockedUserModal={setIsOpenBlockedUserModal}
            myAddress={myAddress}
            reticulumChatEnabled={reticulumChatEnabled}
          />
        ) : null}
        {!reticulumChatEnabled && desktopSideView === 'directs' && (
          <DirectsSidebar
            setDesktopSideView={setDesktopSideViewFromRail}
            desktopSideView={desktopSideView}
            directChatHasUnread={directChatHasUnread}
            directs={displayDirects}
            dmFriendsByAddress={dmFriendsByAddress}
            getUserAvatarUrl={getUserAvatarUrl}
            directAvatarLoaded={directAvatarLoaded}
            setDirectAvatarLoaded={setDirectAvatarLoaded}
            setSelectedDirect={setSelectedDirect}
            setNewChat={setNewChat}
            setIsOpenDrawer={setIsOpenDrawer}
            getTimestampEnterChat={getTimestampEnterChat}
            selectedDirect={selectedDirect}
            timestampEnterData={timestampEnterData}
            timeDifferenceForNotificationChats={
              timeDifferenceForNotificationChats
            }
            myAddress={myAddress}
            openAvatarPreview={openAvatarPreview}
            avatarPreviewData={avatarPreviewData}
            closeAvatarPreview={closeAvatarPreview}
            isRunningPublicNode={isRunningPublicNode}
            setIsOpenBlockedUserModal={setIsOpenBlockedUserModal}
            reticulumChatEnabled={reticulumChatEnabled}
          />
        )}

        <Box
          sx={{
            flex: 1,
            height: '100%',
            minHeight: 0,
            minWidth: 0,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {newChat && !reticulumChatEnabled && (
            <NewChatOverlay isChatMode={isVisible}>
              <ChatDirect
                myAddress={myAddress}
                isNewChat={newChat}
                selectedDirect={undefined}
                setSelectedDirect={setSelectedDirect}
                setNewChat={setNewChat}
                getTimestampEnterChat={getTimestampEnterChat}
                close={closeChatDirect}
                setMobileViewModeKeepOpen={setMobileViewModeKeepOpen}
                reticulumChatEnabled={reticulumChatEnabled}
              />
            </NewChatOverlay>
          )}

          {isVisible &&
            !selectedDirect &&
            !newChat &&
            !selectedGroup &&
            !isReticulumDirectOverlayOpen && (
              reticulumChatEnabled ? (
                hasConfirmedNoReticulumGroups ? (
                  <FirstTimeQChatEmptyState
                    onFindCommunities={openGroupDiscovery}
                  />
                ) : reticulumActivityDashboardReady ? (
                  reticulumHasUnreadActivity ? (
                    <ReturningUserActivityDashboard
                      displayName={reticulumWelcomeDisplayName}
                      groups={memberGroupsWithReticulumActivity}
                      onBrowseCommunities={openGroupDiscovery}
                      onSelectGroup={selectGroupFunc}
                    />
                  ) : (
                    <ReturningUserCaughtUpState
                      displayName={reticulumWelcomeDisplayName}
                      onBrowseCommunities={openGroupDiscovery}
                    />
                  )
                ) : (
                  <CenterBox>
                    <CircularProgress size={28} />
                  </CenterBox>
                )
              ) : (
                <CenterBox>
                  <NoSelectionTypography>
                    {t('group:message.generic.no_selection', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </NoSelectionTypography>
                </CenterBox>
              )
            )}

          <SelectedGroupWrapper
            isVisible={
              isVisible &&
              !!selectedGroup &&
              (reticulumChatEnabled ||
                (desktopSideView !== 'directs' && !selectedDirect && !newChat))
            }
          >
            {reticulumChatEnabled && groupSection !== 'chat' && (
              <ReticulumGroupSectionHeader
                activeSection={groupSection}
                canManageReticulumGroup={canManageReticulumGroup}
                sectionLabel={
                  groupSection === 'land'
                    ? 'QortalLand'
                    : groupSection === 'forum'
                      ? 'Threads'
                      : groupSection === 'members'
                        ? 'Members'
                        : selectedGroup?.groupName || 'Group'
                }
                onChatClick={goToChat}
                onGroupCallClick={
                  gcallGroupNumericId !== null
                    ? handleGroupCallHeaderClick
                    : undefined
                }
                onQortalLandClick={goToQortalLand}
                onThreadsClick={goToThreads}
                groupCallInCall={
                  inThisGroupGcall && gcallRoomState === 'connected'
                }
                groupCallJoining={gcallRoomState === 'joining'}
                groupCallDisabled={inOtherGcall}
                groupCallTooltip={
                  inOtherGcall
                    ? t('core:group_call_blocked', {
                        postProcess: 'capitalizeFirstChar',
                      })
                    : ''
                }
                membersPanelOpen={reticulumMembersPanelOpen}
                onMembersClick={toggleReticulumMembersPanel}
              />
            )}
            {!reticulumChatEnabled && (
              <DesktopHeader
                isPrivate={isPrivate}
                selectedGroup={selectedGroup}
                groupSection={groupSection}
                isUnread={isUnread}
                goToAnnouncements={goToAnnouncements}
                goToChat={goToChat}
                goToThreads={goToThreads}
                setOpenManageMembers={setOpenManageMembers}
                directChatHasUnread={directChatHasUnread}
                chatMode={chatMode}
                openDrawerGroups={openDrawerGroups}
                goToHome={goToHome}
                mobileViewMode={mobileViewMode}
                setMobileViewMode={setMobileViewMode}
                setMobileViewModeKeepOpen={setMobileViewModeKeepOpen}
                hasUnreadDirects={directChatHasUnread}
                isHome={groupSection === 'home'}
                isGroups={desktopSideView === 'groups'}
                isDirects={desktopSideView === 'directs'}
                setDesktopSideView={setDesktopSideView}
                hasUnreadAnnouncements={isUnread}
                isAnnouncement={groupSection === 'announcement'}
                isChat={groupSection === 'chat'}
                isQortalLand={groupSection === 'land'}
                setGroupSection={setGroupSection}
                isForum={groupSection === 'forum'}
                onGroupCallClick={
                  gcallGroupNumericId !== null
                    ? handleGroupCallHeaderClick
                    : undefined
                }
                onQortalLandClick={goToQortalLand}
                groupCallInCall={
                  inThisGroupGcall && gcallRoomState === 'connected'
                }
                groupCallJoining={gcallRoomState === 'joining'}
                groupCallDisabled={inOtherGcall}
                groupCallTooltip={
                  inOtherGcall
                    ? t('core:group_call_blocked', {
                        postProcess: 'capitalizeFirstChar',
                      })
                    : ''
                }
              />
            )}

            <ChatContentBox>
              {reticulumChatEnabled && !!selectedGroup && (
                <ReticulumSectionLayer active={groupSection === 'chat'}>
                  <ReticulumChatGroup
                    myAddress={myAddress}
                    adminsWithNames={adminsWithNames}
                    isReticulumChannelAdmin={canManageReticulumGroup}
                    reticulumChannelAccessReady={
                      reticulumAdminGroupsLoadedAddress === myAddress &&
                      reticulumMembershipsAppliedKey === reticulumMembershipsKey
                    }
                    selectedGroup={selectedGroup?.groupId}
                    selectedGroupName={
                      selectedGroup?.groupName || selectedGroup?.name || ''
                    }
                    getSecretKey={getSecretKey}
                    secretKey={secretKey}
                    isPrivate={isPrivate}
                    isActive={
                      isVisible &&
                      groupSection === 'chat' &&
                      !isReticulumDirectOverlayOpen
                    }
                    setSecretKey={setSecretKey}
                    handleNewEncryptionNotification={
                      setNewEncryptionNotification
                    }
                    hide={false}
                    hideView={
                      !(isVisible && selectedGroup) ||
                      (desktopViewMode !== 'apps' && desktopViewMode !== 'dev')
                    }
                    handleSecretKeyCreationInProgress={
                      handleSecretKeyCreationInProgress
                    }
                    triedToFetchSecretKey={triedToFetchSecretKey}
                    getTimestampEnterChatParent={getTimestampEnterChat}
                    notificationReticulumChannelId={
                      notificationReticulumChannelId
                    }
                    onGroupCallClick={
                      gcallGroupNumericId !== null
                        ? handleGroupCallHeaderClick
                        : undefined
                    }
                    onQortalLandClick={goToQortalLand}
                    onThreadsClick={goToThreads}
                    onMembersClick={toggleReticulumMembersPanel}
                    membersPanelOpen={reticulumMembersPanelOpen}
                    groupCallInCall={
                      inThisGroupGcall && gcallRoomState === 'connected'
                    }
                    groupCallJoining={gcallRoomState === 'joining'}
                    groupCallDisabled={inOtherGcall}
                    groupCallTooltip={
                      inOtherGcall
                        ? t('core:group_call_blocked', {
                            postProcess: 'capitalizeFirstChar',
                          })
                        : ''
                    }
                    onReticulumChannelSelected={handleReticulumChannelSelected}
                    reticulumReadEntryToken={reticulumReadEntryToken}
                    isGroupOwner={groupOwner?.owner === myAddress}
                  />
                </ReticulumSectionLayer>
              )}
              {!reticulumChatEnabled && triedToFetchSecretKey && (
                <ChatGroup
                  myAddress={myAddress}
                  selectedGroup={selectedGroup?.groupId}
                  selectedGroupName={
                    selectedGroup?.groupName || selectedGroup?.name || ''
                  }
                  getSecretKey={getSecretKey}
                  secretKey={secretKey}
                  isPrivate={isPrivate}
                  isActive={
                    isVisible &&
                    groupSection === 'chat' &&
                    !selectedDirect &&
                    !newChat
                  }
                  setSecretKey={setSecretKey}
                  handleNewEncryptionNotification={setNewEncryptionNotification}
                  hide={groupSection !== 'chat' || !!selectedDirect || newChat}
                  hideView={
                    !(isVisible && selectedGroup) ||
                    (desktopViewMode !== 'apps' && desktopViewMode !== 'dev')
                  }
                  handleSecretKeyCreationInProgress={
                    handleSecretKeyCreationInProgress
                  }
                  triedToFetchSecretKey={triedToFetchSecretKey}
                  getTimestampEnterChatParent={getTimestampEnterChat}
                  notificationReticulumChannelId={
                    notificationReticulumChannelId
                  }
                  onGroupCallClick={
                    gcallGroupNumericId !== null
                      ? handleGroupCallHeaderClick
                      : undefined
                  }
                  onQortalLandClick={goToQortalLand}
                  onAnnouncementsClick={goToAnnouncements}
                  onThreadsClick={goToThreads}
                  onMembersClick={() => setGroupSection('members')}
                  onAdminsClick={() => setGroupSection('adminSpace')}
                  groupCallInCall={
                    inThisGroupGcall && gcallRoomState === 'connected'
                  }
                  groupCallJoining={gcallRoomState === 'joining'}
                  groupCallDisabled={inOtherGcall}
                  groupCallTooltip={
                    inOtherGcall
                      ? t('core:group_call_blocked', {
                          postProcess: 'capitalizeFirstChar',
                        })
                      : ''
                  }
                  hasUnreadAnnouncements={isUnread}
                  onReticulumChannelSelected={(channelId) => {
                    const normalizedChannelId = channelId || 'general';
                    setActiveReticulumChannelId((previousChannelId) => {
                      const previous = previousChannelId || 'general';
                      if (previous !== normalizedChannelId) {
                        bumpReticulumReadEntryToken();
                      }
                      return normalizedChannelId;
                    });
                    if (
                      notificationReticulumChannelId &&
                      notificationReticulumChannelId === normalizedChannelId
                    ) {
                      setNotificationReticulumChannelId('');
                    }
                  }}
                  reticulumReadEntryToken={reticulumReadEntryToken}
                />
              )}
              {isPrivate &&
                firstSecretKeyInCreation &&
                triedToFetchSecretKey &&
                !secretKeyPublishDate && (
                  <EncryptionKeyMessageDiv>
                    <Typography>
                      {t('group:message.generic.encryption_key', {
                        postProcess: 'capitalizeFirstChar',
                      })}
                    </Typography>
                  </EncryptionKeyMessageDiv>
                )}

              {notPartOfKeys ? (
                <>
                  {secretKeyPublishDate ||
                  (!secretKeyPublishDate && !firstSecretKeyInCreation) ? (
                    <NotPartGroupDiv>
                      <Paper
                        elevation={0}
                        sx={{
                          maxWidth: 480,
                          p: 3,
                          textAlign: 'center',
                          border: `1px solid ${theme.palette.divider}`,
                          borderRadius: 2,
                          mb: 3,
                        }}
                      >
                        <LockOutlinedIcon
                          sx={{
                            fontSize: 48,
                            color: theme.palette.text.secondary,
                            mb: 2,
                          }}
                        />
                        <Typography
                          variant="subtitle1"
                          sx={{
                            color: theme.palette.text.primary,
                            fontWeight: 500,
                            mb: 1.5,
                          }}
                        >
                          {t('group:message.generic.not_part_group', {
                            postProcess: 'capitalizeFirstChar',
                          })}
                        </Typography>
                        <Typography
                          variant="body2"
                          sx={{
                            color: theme.palette.warning.main,
                            fontWeight: 600,
                            px: 1,
                          }}
                        >
                          {t('group:message.generic.only_encrypted', {
                            postProcess: 'capitalizeFirstChar',
                          })}
                        </Typography>
                      </Paper>
                      <Typography
                        variant="body2"
                        sx={{
                          color: theme.palette.text.secondary,
                          mb: 2,
                          textAlign: 'center',
                        }}
                      >
                        {t('group:message.error.notify_admins', {
                          postProcess: 'capitalizeFirstChar',
                        })}
                      </Typography>
                      <NotPartAdminListBox>
                        {adminsWithNames.map((admin) => (
                          <AdminRowBox key={admin?.address}>
                            <Typography
                              variant="body1"
                              sx={{
                                fontWeight: 500,
                                color: theme.palette.text.primary,
                              }}
                            >
                              {admin?.name}
                            </Typography>
                            <LoadingButton
                              data-admin-address={admin?.address}
                              loading={isLoadingNotifyAdmin}
                              loadingPosition="start"
                              size="small"
                              variant="contained"
                              onClick={handleNotifyAdminClick}
                              sx={{
                                textTransform: 'none',
                                fontWeight: 600,
                              }}
                            >
                              {t('core:action.notify', {
                                postProcess: 'capitalizeFirstChar',
                              })}
                            </LoadingButton>
                          </AdminRowBox>
                        ))}
                      </NotPartAdminListBox>
                    </NotPartGroupDiv>
                  ) : null}
                </>
              ) : admins.includes(myAddress) &&
                !secretKey &&
                isPrivate &&
                triedToFetchSecretKey ? null : !triedToFetchSecretKey ? null : reticulumChatEnabled ? (
                <>
                  {shouldMountReticulumSection('forum') && (
                    <ReticulumSectionLayer active={groupSection === 'forum'}>
                      <GroupForum
                        myAddress={myAddress}
                        selectedGroup={selectedGroup}
                        getSecretKey={getSecretKey}
                        secretKey={secretKey}
                        setSecretKey={setSecretKey}
                        isAdmin={admins.includes(myAddress)}
                        hide={false}
                        defaultThread={defaultThread}
                        setDefaultThread={setDefaultThread}
                        isPrivate={isPrivate}
                      />
                    </ReticulumSectionLayer>
                  )}
                  {shouldMountReticulumSection('land') && (
                    <ReticulumSectionLayer active={groupSection === 'land'}>
                      <Suspense fallback={null}>
                        <LazyQortalLand
                          key={selectedGroup?.groupId}
                          groupId={Number(selectedGroup?.groupId)}
                          groupName={
                            selectedGroup?.groupName ||
                            selectedGroup?.name ||
                            ''
                          }
                          myAddress={myAddress}
                        />
                      </Suspense>
                    </ReticulumSectionLayer>
                  )}
                </>
              ) : (
                <>
                  <GroupAnnouncements
                    myAddress={myAddress}
                    selectedGroup={selectedGroup?.groupId}
                    getSecretKey={getSecretKey}
                    secretKey={secretKey}
                    setSecretKey={setSecretKey}
                    isAdmin={admins.includes(myAddress)}
                    handleNewEncryptionNotification={
                      setNewEncryptionNotification
                    }
                    hide={groupSection !== 'announcement'}
                    isPrivate={isPrivate}
                  />
                  <GroupForum
                    myAddress={myAddress}
                    selectedGroup={selectedGroup}
                    getSecretKey={getSecretKey}
                    secretKey={secretKey}
                    setSecretKey={setSecretKey}
                    isAdmin={admins.includes(myAddress)}
                    hide={groupSection !== 'forum'}
                    defaultThread={defaultThread}
                    setDefaultThread={setDefaultThread}
                    isPrivate={isPrivate}
                  />
                  {groupSection === 'land' && (
                    <Suspense fallback={null}>
                      <LazyQortalLand
                        key={selectedGroup?.groupId}
                        groupId={Number(selectedGroup?.groupId)}
                        groupName={
                          selectedGroup?.groupName || selectedGroup?.name || ''
                        }
                        myAddress={myAddress}
                      />
                    </Suspense>
                  )}
                  {groupSection === 'adminSpace' && (
                    <AdminSpace
                      adminsWithNames={adminsWithNames}
                      hide={groupSection !== 'adminSpace'}
                      isAdmin={admins.includes(myAddress)}
                      isOwner={groupOwner?.owner === myAddress}
                      selectedGroup={selectedGroup?.groupId}
                    />
                  )}
                  {groupSection === 'members' && (
                    <Suspense fallback={null}>
                      <LazyManageMembers
                        inline
                        selectedGroup={selectedGroup}
                        address={myAddress}
                        open
                        setOpen={setOpenManageMembers}
                        isAdmin={admins.includes(myAddress)}
                        isOwner={groupOwner?.owner === myAddress}
                      />
                    </Suspense>
                  )}
                </>
              )}

              <FloatingButtonContainerBox>
                {((isPrivate &&
                  admins.includes(myAddress) &&
                  shouldReEncrypt &&
                  triedToFetchSecretKey &&
                  !firstSecretKeyInCreation &&
                  !hideCommonKeyPopup) ||
                  isForceShowCreationKeyPopup) && (
                  <CreateCommonSecret
                    isForceShowCreationKeyPopup={isForceShowCreationKeyPopup}
                    setHideCommonKeyPopup={setHideCommonKeyPopup}
                    groupId={selectedGroup?.groupId}
                    secretKey={secretKey}
                    secretKeyDetails={secretKeyDetails}
                    myAddress={myAddress}
                    isOwner={groupOwner?.owner === myAddress}
                    setIsForceShowCreationKeyPopup={
                      setIsForceShowCreationKeyPopup
                    }
                    noSecretKey={
                      admins.includes(myAddress) &&
                      !secretKey &&
                      triedToFetchSecretKey
                    }
                  />
                )}
              </FloatingButtonContainerBox>
            </ChatContentBox>

            {reticulumChatEnabled &&
              selectedGroup &&
              reticulumMembersPanelOpen && (
                <Box
                  sx={{
                    borderLeft: `1px solid ${theme.palette.divider}`,
                    bottom: 0,
                    boxShadow:
                      groupSection === 'land'
                        ? '-12px 0 24px rgba(0, 0, 0, 0.22)'
                        : 'none',
                    position: 'absolute',
                    right: 0,
                    top: 50,
                    width: 280,
                    zIndex: 8,
                  }}
                >
                  <Suspense fallback={null}>
                    <LazyManageMembers
                      inline
                      reticulumSidebar
                      selectedGroup={selectedGroup}
                      address={myAddress}
                      open
                      setOpen={setOpenManageMembers}
                      isAdmin={admins.includes(myAddress)}
                      isOwner={groupOwner?.owner === myAddress}
                    />
                  </Suspense>
                </Box>
              )}

            {openManageMembers && !reticulumChatEnabled && (
              <Suspense fallback={null}>
                <LazyManageMembers
                  selectedGroup={selectedGroup}
                  address={myAddress}
                  open={openManageMembers}
                  setOpen={setOpenManageMembers}
                  isAdmin={admins.includes(myAddress)}
                  isOwner={groupOwner?.owner === myAddress}
                />
              </Suspense>
            )}
          </SelectedGroupWrapper>

          <Suspense fallback={null}>
            <LazyBlockedUsersModal />
          </Suspense>

          {isReticulumDirectOverlayOpen && (
            <Box
              sx={{
                backgroundColor: 'background.default',
                bottom: 0,
                boxShadow: '-18px 0 36px rgba(0, 0, 0, 0.26)',
                display: 'flex',
                left: 0,
                minHeight: 0,
                minWidth: 0,
                position: 'absolute',
                right: 0,
                top: 0,
                zIndex: 16,
              }}
            >
              <DirectsSidebar
                setDesktopSideView={setDesktopSideViewFromRail}
                desktopSideView={desktopSideView}
                directChatHasUnread={directChatHasUnread}
                directs={displayDirects}
                dmFriendsByAddress={dmFriendsByAddress}
                getUserAvatarUrl={getUserAvatarUrl}
                directAvatarLoaded={directAvatarLoaded}
                setDirectAvatarLoaded={setDirectAvatarLoaded}
                setSelectedDirect={setSelectedDirect}
                setNewChat={setNewChat}
                setIsOpenDrawer={setIsOpenDrawer}
                getTimestampEnterChat={getTimestampEnterChat}
                selectedDirect={selectedDirect}
                timestampEnterData={timestampEnterData}
                timeDifferenceForNotificationChats={
                  timeDifferenceForNotificationChats
                }
                myAddress={myAddress}
                openAvatarPreview={openAvatarPreview}
                avatarPreviewData={avatarPreviewData}
                closeAvatarPreview={closeAvatarPreview}
                isRunningPublicNode={isRunningPublicNode}
                setIsOpenBlockedUserModal={setIsOpenBlockedUserModal}
                reticulumChatEnabled={reticulumChatEnabled}
              />
              <Box
                sx={{
                  backgroundColor: 'background.default',
                  display: 'flex',
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  position: 'relative',
                }}
              >
                {newChat ? (
                  <ChatDirect
                    myAddress={myAddress}
                    isNewChat={newChat}
                    selectedDirect={undefined}
                    setSelectedDirect={setSelectedDirect}
                    setNewChat={setNewChat}
                    getTimestampEnterChat={getTimestampEnterChat}
                    close={closeChatDirect}
                    setMobileViewModeKeepOpen={setMobileViewModeKeepOpen}
                    isActive={isVisible && isReticulumDirectOverlayOpen}
                    reticulumChatEnabled={reticulumChatEnabled}
                  />
                ) : selectedDirect ? (
                  <ChatDirect
                    myAddress={myAddress}
                    isNewChat={newChat}
                    selectedDirect={selectedDirect}
                    setSelectedDirect={setSelectedDirect}
                    setNewChat={setNewChat}
                    getTimestampEnterChat={getTimestampEnterChat}
                    close={closeChatDirect}
                    setMobileViewModeKeepOpen={setMobileViewModeKeepOpen}
                    isActive={isVisible && isReticulumDirectOverlayOpen}
                    reticulumChatEnabled={reticulumChatEnabled}
                  />
                ) : (
                  <CenterBox>
                    <NoSelectionTypography>
                      No current private messages.
                    </NoSelectionTypography>
                  </CenterBox>
                )}
              </Box>
            </Box>
          )}

          {selectedDirect &&
            !newChat &&
            desktopSideView === 'directs' &&
            !reticulumChatEnabled && (
              <SelectedDirectOverlay isChatMode={isVisible}>
                <InnerChatBox>
                  <ChatDirect
                    myAddress={myAddress}
                    isNewChat={newChat}
                    selectedDirect={selectedDirect}
                    setSelectedDirect={setSelectedDirect}
                    setNewChat={setNewChat}
                    getTimestampEnterChat={getTimestampEnterChat}
                    close={closeChatDirect}
                    setMobileViewModeKeepOpen={setMobileViewModeKeepOpen}
                    isActive={isVisible && desktopSideView === 'directs'}
                    reticulumChatEnabled={reticulumChatEnabled}
                  />
                </InnerChatBox>
              </SelectedDirectOverlay>
            )}
        </Box>
      </Box>
    );
  };

  return (
    <>
      <WebSocketNotifications
        myAddress={userInfo?.address || myAddress}
        userName={userInfo?.name}
      />
      <WebSocketActive
        myAddress={myAddress}
        setIsLoadingGroups={setIsLoadingGroups}
      />

      <CustomizedSnackbars
        open={openSnack}
        setOpen={setOpenSnack}
        info={infoSnack}
        setInfo={setInfoSnack}
      />

      <RootBox>
        <MemberGroupsEffects
          getGroupsWhereIAmAMember={getGroupsWhereIAmAMember}
          getGroupsProperties={getGroupsProperties}
          myAddress={myAddress}
          groupsPropertiesRef={groupsPropertiesRef}
          hasInitializedWebsocketRef={hasInitializedWebsocket}
        />
        <DesktopSideBar
          desktopViewMode={desktopViewMode}
          toggleSideViewGroups={toggleSideViewGroups}
          toggleSideViewDirects={toggleSideViewDirects}
          goToHome={goToHome}
          mode={appsMode}
          setMode={setAppsMode}
          setDesktopSideView={setDesktopSideView}
          hasUnreadDirects={directChatHasUnread}
          isApps={desktopViewMode === 'apps'}
          isGroups={isOpenSideViewGroups}
          isDirects={isOpenSideViewDirects}
          setDesktopViewMode={setDesktopViewMode}
          lastQappViewMode={lastQappViewMode}
          setAppsModeDev={setAppsModeDev}
        />

        <MainContentBox>
          {openAddGroup && (
            <Suspense fallback={null}>
              <LazyAddGroup
                address={myAddress}
                open={openAddGroup}
                initialTab={openAddGroupTab}
                setOpen={setOpenAddGroup}
              />
            </Suspense>
          )}

          {openFindGroup && (
            <Suspense fallback={null}>
              <LazyFindGroupModal
                open={openFindGroup}
                setOpen={setOpenFindGroup}
              />
            </Suspense>
          )}

          <AppsDesktop
            desktopViewMode={desktopViewMode}
            setDesktopViewMode={setDesktopViewMode}
            devMode={appsModeDev}
            setDevMode={setAppsModeDev}
            mode={appsMode}
            setMode={setAppsMode}
            onInternalTabVisibilityChange={({ isVisible, tab }) => {
              setIsQChatTabActive(
                isVisible && tab?.internal === QCHAT_INTERNAL_TAB_ID
              );
            }}
            renderInternalTab={({ hide, isSelected, tab }) =>
              tab?.internal === QCHAT_INTERNAL_TAB_ID
                ? renderQChatTabContent({ hide, isSelected })
                : null
            }
            show={desktopViewMode === 'apps' || desktopViewMode === 'dev'}
          />

          <HomeDesktop
            refreshHomeDataFunc={refreshHomeDataFunc}
            myAddress={myAddress}
            isLoadingGroups={isLoadingGroups}
            onOpenSettings={onOpenSettings}
            setGroupSection={setGroupSection}
            setSelectedGroup={setSelectedGroup}
            getTimestampEnterChat={getTimestampEnterChat}
            setOpenManageMembers={setOpenManageMembers}
            setOpenAddGroup={setOpenAddGroup}
            setOpenAddGroupTab={setOpenAddGroupTab}
            setMobileViewMode={setMobileViewMode}
            setDesktopViewMode={setDesktopViewMode}
            desktopViewMode={desktopViewMode}
          />
        </MainContentBox>

        <LoadingSnackbar
          open={isLoadingGroup}
          info={loadingGroupSnackbarInfo}
        />

        <LoadingSnackbar
          open={isLoadingGroups}
          info={loadingGroupsSnackbarInfo}
        />
        <WalletsAppWrapper />

        {!chatWidgetClosed && (
          <GlobalChatWidget
            directs={displayDirects}
            getUserAvatarUrl={getUserAvatarUrl}
            directChatHasUnread={directChatHasUnread}
            timestampEnterData={timestampEnterData}
            timeDifferenceForNotificationChats={
              timeDifferenceForNotificationChats
            }
            myAddress={myAddress}
            directAvatarLoaded={directAvatarLoaded}
            setDirectAvatarLoaded={setDirectAvatarLoaded}
            getTimestampEnterChat={getTimestampEnterChat}
            getSecretKeyForGroup={getSecretKeyForGroup}
            onClose={() => setChatWidgetClosed(true)}
          />
        )}
      </RootBox>
    </>
  );
};
