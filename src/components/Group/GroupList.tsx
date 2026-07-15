import {
  Avatar,
  Box,
  ButtonBase,
  GlobalStyles,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  type DragOverEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import PhoneInTalkIcon from '@mui/icons-material/PhoneInTalk';
import { HubsIcon } from '../../assets/Icons/HubsIcon';
import { MessagingIcon } from '../../assets/Icons/MessagingIcon';
import { ContextMenu } from '../ContextMenu';
import { getBaseApiReact } from '../../App';
import { formatEmailDate } from './qmailUtils';
import CampaignIcon from '@mui/icons-material/Campaign';
import MarkChatUnreadIcon from '@mui/icons-material/MarkChatUnread';
import LockIcon from '@mui/icons-material/Lock';
import AlternateEmailIcon from '@mui/icons-material/AlternateEmail';
import { CustomButton } from '../../styles/App-styles';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import PersonOffIcon from '@mui/icons-material/PersonOff';
import {
  groupAnnouncementSelector,
  groupChatTimestampSelector,
  groupPropertySelector,
  groupsAnnHasUnreadAtom,
  groupChatHasUnreadAtom,
  groupsOwnerNamesSelector,
  isRunningPublicNodeAtom,
  memberGroupsWithReticulumChatAtom,
  qortalGroupMeshCallActiveAtom,
  qortalGroupMeshCallMaxParticipantsAtom,
  qortalGroupMeshCallParticipantCountAtom,
  qortalGroupSelfGcallRoomIdAtom,
  timestampEnterDataSelector,
} from '../../atoms/global';
import { timeDifferenceForNotificationChats } from './Group';
import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { AvatarPreviewModal } from '../Chat/AvatarPreviewModal';
import { getClickableAvatarSx } from '../Chat/clickableAvatarStyles';
import {
  meshCallActiveForMemberGroup,
  meshCallMaxParticipantsForMemberGroup,
  meshCallParticipantCountForMemberGroup,
} from '../../lib/group-call/qortalGroupIdKey';

const RETICULUM_GROUP_ORDER_STORAGE_KEY = 'qortal_reticulum_group_order_v1';
const RETICULUM_ACTIVE_BLUE = '#2563eb';
const RETICULUM_AVATAR_PALETTE = [
  '#7dd3fc',
  '#86efac',
  '#f9a8d4',
  '#c4b5fd',
  '#fcd34d',
  '#fdba74',
  '#a7f3d0',
  '#93c5fd',
  '#f0abfc',
  '#fca5a5',
];

type GroupDragInsertionPosition = 'before' | 'after';

type GroupDragTarget = {
  activeId: string;
  overId: string;
  position: GroupDragInsertionPosition;
};

const groupDragInsertionPosition = (
  event: DragEndEvent | DragOverEvent
): GroupDragInsertionPosition => {
  const translated = event.active.rect.current.translated;
  if (!translated || !event.over) return 'before';
  const activeMiddle = translated.top + translated.height / 2;
  const overMiddle = event.over.rect.top + event.over.rect.height / 2;
  return activeMiddle > overMiddle ? 'after' : 'before';
};

const moveGroupByInsertion = <T,>(
  items: T[],
  sourceIndex: number,
  targetIndex: number,
  position: GroupDragInsertionPosition
) => {
  const next = [...items];
  const [moved] = next.splice(sourceIndex, 1);
  const rawIndex = targetIndex + (position === 'after' ? 1 : 0);
  const insertionIndex = Math.max(
    0,
    Math.min(rawIndex - (sourceIndex < rawIndex ? 1 : 0), next.length)
  );
  next.splice(insertionIndex, 0, moved);
  return next;
};

function GroupDropIndicator({
  position,
}: {
  position: GroupDragInsertionPosition;
}) {
  return (
    <Box
      aria-hidden
      sx={{
        backgroundColor: RETICULUM_ACTIVE_BLUE,
        borderRadius: '999px',
        boxShadow: '0 0 0 1px rgba(37, 99, 235, 0.22)',
        height: 2,
        left: 6,
        pointerEvents: 'none',
        position: 'absolute',
        right: 6,
        ...(position === 'before' ? { top: -4 } : { bottom: -4 }),
        zIndex: 7,
      }}
    />
  );
}

const getPastelAvatarColor = (value?: string | number) => {
  const key = String(value || 'group');
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % RETICULUM_AVATAR_PALETTE.length;
  }
  return RETICULUM_AVATAR_PALETTE[Math.abs(hash) % RETICULUM_AVATAR_PALETTE.length];
};

const ReticulumDmMorphIcon = ({
  active,
  color,
}: {
  active: boolean;
  color: string;
}) => (
  <Box
    component="span"
    sx={{
      color,
      display: 'inline-flex',
      height: 25,
      overflow: 'hidden',
      position: 'relative',
      width: 25,
      '@keyframes reticulumDmLand': {
        '0%': { opacity: 0, transform: 'translateY(-30px) scale(0.96)' },
        '55%': { opacity: 1 },
        '100%': { opacity: 1, transform: 'translateY(0) scale(1)' },
      },
      '@keyframes reticulumDmExit': {
        '0%': { opacity: 1, transform: 'translateY(0) scale(1)' },
        '100%': { opacity: 0, transform: 'translateY(30px) scale(0.94)' },
      },
      '@keyframes reticulumQortalDrop': {
        '0%': { opacity: 0, transform: 'translateY(-30px) scale(0.94)' },
        '55%': { opacity: 1 },
        '100%': { opacity: 1, transform: 'translateY(0) scale(1)' },
      },
      '@keyframes reticulumQortalExit': {
        '0%': { opacity: 1, transform: 'translateY(0) scale(1)' },
        '100%': { opacity: 0, transform: 'translateY(30px) scale(0.94)' },
      },
      '& svg': {
        display: 'block',
        height: '100%',
        inset: 0,
        overflow: 'visible',
        position: 'absolute',
        transformBox: 'fill-box',
        transformOrigin: '50% 50%',
        width: '100%',
      },
      '& .reticulum-dm-front': {
        animation: active
          ? 'reticulumDmExit 360ms cubic-bezier(0.3, 0, 0.2, 1) both'
          : 'reticulumDmLand 420ms cubic-bezier(0.2, 0.9, 0.2, 1) both',
        opacity: active ? 0 : 1,
        transform: active
          ? 'translateY(30px) scale(0.94)'
          : 'translateY(0) scale(1)',
      },
      '& .reticulum-dm-back': {
        animation: active
          ? 'reticulumQortalDrop 420ms cubic-bezier(0.2, 0.9, 0.2, 1) both'
          : 'reticulumQortalExit 360ms cubic-bezier(0.3, 0, 0.2, 1) both',
        opacity: active ? 1 : 0,
        transform: active
          ? 'translateY(0) scale(1)'
          : 'translateY(30px) scale(0.94)',
      },
    }}
  >
    <svg
      aria-hidden="true"
      className="reticulum-dm-front"
      focusable="false"
      viewBox="0 0 32 32"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      >
        <path d="M4.8 15.9 26.4 5.7 20 26.2l-4.4-8.1-6.8 5.2 2.3-7.3z" />
        <path d="M11.2 16 20 10.2" opacity="0.55" />
      </g>
    </svg>
    <svg
      aria-hidden="true"
      className="reticulum-dm-back"
      focusable="false"
      viewBox="0 0 32 32"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.45"
      >
        <path d="M16 3.8 25.7 9.4v11.2L16 26.2l-9.7-5.6V9.4z" opacity="0.95" />
        <path d="M16 8.2 22 11.7v7L16 22.2l-6-3.5v-7z" />
        <path d="M13.2 20.5 16 22.1l2.6-1.5" />
        <path d="M20.7 18.1 27.4 22.5" />
      </g>
    </svg>
  </Box>
);

const GroupListInner = ({
  selectGroupFunc,
  setDesktopSideView,
  desktopSideView,
  directChatHasUnread,
  chatMode,
  selectedGroup,
  getUserSettings,
  setOpenAddGroup,
  setIsOpenBlockedUserModal,
  myAddress,
  reticulumChatEnabled,
}) => {
  const theme = useTheme();
  const { t } = useTranslation([
    'auth',
    'core',
    'group',
    'question',
    'tutorial',
  ]);
  const [isRunningPublicNode] = useAtom(isRunningPublicNodeAtom);
  const groups = useAtomValue(memberGroupsWithReticulumChatAtom);
  const groupChatHasUnread = useAtomValue(groupChatHasUnreadAtom);
  const groupsAnnHasUnread = useAtomValue(groupsAnnHasUnreadAtom);
  const railMode = Boolean(reticulumChatEnabled);
  const [manualGroupOrder, setManualGroupOrder] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const parsed = JSON.parse(
        window.localStorage.getItem(RETICULUM_GROUP_ORDER_STORAGE_KEY) || '[]'
      );
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  });
  const [groupDragTarget, setGroupDragTarget] =
    useState<GroupDragTarget | null>(null);
  const groupDndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const orderedGroups = useMemo(() => {
    if (!railMode) return groups;
    const orderIndex = new Map(
      manualGroupOrder.map((groupId, index) => [String(groupId), index])
    );
    return [...groups].sort((a: any, b: any) => {
      const aIndex = orderIndex.get(String(a?.groupId));
      const bIndex = orderIndex.get(String(b?.groupId));
      if (aIndex != null && bIndex != null) return aIndex - bIndex;
      if (aIndex != null) return -1;
      if (bIndex != null) return 1;
      return 0;
    });
  }, [groups, manualGroupOrder, railMode]);
  const orderedGroupIds = useMemo(
    () => orderedGroups.map((group: any) => String(group?.groupId)),
    [orderedGroups]
  );

  const persistManualGroupOrder = useCallback((nextOrder: string[]) => {
    setManualGroupOrder(nextOrder);
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      RETICULUM_GROUP_ORDER_STORAGE_KEY,
      JSON.stringify(nextOrder)
    );
  }, []);

  const handleGroupDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = orderedGroupIds.indexOf(String(active.id));
      const newIndex = orderedGroupIds.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;
      persistManualGroupOrder(
        moveGroupByInsertion(
          orderedGroupIds,
          oldIndex,
          newIndex,
          groupDragInsertionPosition(event)
        )
      );
    },
    [orderedGroupIds, persistManualGroupOrder]
  );

  const handleGroupDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over || event.active.id === event.over.id) {
      setGroupDragTarget(null);
      return;
    }
    setGroupDragTarget({
      activeId: String(event.active.id),
      overId: String(event.over.id),
      position: groupDragInsertionPosition(event),
    });
  }, []);

  if (railMode) {
    return (
      <Box
        sx={{
          alignItems: 'center',
          background: theme.palette.background.surface,
          borderRight: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          height: '100%',
          padding: '10px 9px',
          width: '72px',
        }}
      >
        <GlobalStyles
          styles={{
            '.MuiTooltip-tooltip': {
              backgroundColor: `color-mix(in srgb, ${theme.palette.background.surface} 70%, #000) !important`,
              border: `1px solid ${theme.palette.divider} !important`,
              borderRadius: '6px',
              boxShadow: '0 8px 18px rgba(0, 0, 0, 0.28)',
              color: theme.palette.text.primary,
              fontSize: 12,
              fontWeight: 600,
              padding: '6px 8px',
            },
            '.MuiTooltip-arrow': {
              color: `color-mix(in srgb, ${theme.palette.background.surface} 70%, #000) !important`,
            },
          }}
        />
        <Tooltip
          placement="right"
          title={
            desktopSideView === 'directs' ? 'Groups' : 'Direct Messages'
          }
        >
          <ButtonBase
            onClick={() => {
              setDesktopSideView('directs');
            }}
            sx={{
              alignItems: 'center',
              backgroundColor:
                desktopSideView === 'directs'
                  ? theme.palette.action.selected
                  : 'transparent',
              borderRadius: '8px',
              display: 'flex',
              height: 42,
              justifyContent: 'center',
              mb: 1,
              position: 'relative',
              width: 42,
              '&:hover': {
                backgroundColor: theme.palette.action.hover,
              },
            }}
          >
            {directChatHasUnread && (
              <Box
                aria-hidden
                sx={{
                  backgroundColor: theme.palette.primary.main,
                  border: `2px solid ${theme.palette.background.surface}`,
                  borderRadius: '50%',
                  height: 12,
                  position: 'absolute',
                  right: 4,
                  top: 4,
                  width: 12,
                }}
              />
            )}
            <ReticulumDmMorphIcon
              active={desktopSideView === 'directs'}
              color={
                directChatHasUnread
                  ? theme.palette.primary.main
                  : desktopSideView === 'directs'
                    ? theme.palette.text.primary
                    : theme.palette.text.secondary
              }
            />
          </ButtonBase>
        </Tooltip>
        <Box
          sx={{
            borderTop: '1px solid',
            borderColor: 'divider',
            mb: 1,
            width: 34,
          }}
        />

        <Box
          sx={{
            alignItems: 'center',
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            gap: '6px',
            minHeight: 0,
            overflowX: 'visible',
            overflowY: 'auto',
            scrollbarWidth: 'none',
            width: '100%',
            msOverflowStyle: 'none',
            '&::-webkit-scrollbar': {
              display: 'none',
              height: 0,
              width: 0,
            },
            '&::-webkit-scrollbar-corner': {
              display: 'none',
            },
          }}
        >
          <DndContext
            collisionDetection={closestCenter}
            onDragCancel={() => setGroupDragTarget(null)}
            onDragEnd={(event) => {
              setGroupDragTarget(null);
              handleGroupDragEnd(event);
            }}
            onDragOver={handleGroupDragOver}
            sensors={groupDndSensors}
          >
            <SortableContext
              items={orderedGroupIds}
              strategy={verticalListSortingStrategy}
            >
              <List
                className="group-list"
                dense
                sx={{
                  alignItems: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  overflow: 'visible',
                  p: 0,
                  width: '100%',
                }}
              >
                {orderedGroups.map((group: any) => (
                  <GroupItem
                    selectGroupFunc={selectGroupFunc}
                    key={group.groupId}
                    group={group}
                    dropPosition={
                      groupDragTarget?.activeId !== String(group.groupId) &&
                      groupDragTarget?.overId === String(group.groupId)
                        ? groupDragTarget.position
                        : undefined
                    }
                    selectedGroupId={selectedGroup?.groupId ?? null}
                    getUserSettings={getUserSettings}
                    myAddress={myAddress}
                    reticulumChatEnabled={reticulumChatEnabled}
                    railMode
                  />
                ))}
              </List>
            </SortableContext>
          </DndContext>
        </Box>

        <Box
          sx={{
            alignItems: 'center',
            borderTop: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            mt: 1,
            pt: 1,
            width: '100%',
          }}
        >
          <Tooltip
            placement="right"
            title={t('group:group.group', {
              postProcess: 'capitalizeFirstChar',
            })}
          >
            <ButtonBase
              onClick={() => {
                setOpenAddGroup(true);
              }}
              sx={{
                alignItems: 'center',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '8px',
                color: theme.palette.text.secondary,
                display: 'flex',
                height: 34,
                justifyContent: 'center',
                width: 34,
                '&:hover': {
                  backgroundColor: theme.palette.action.hover,
                  color: theme.palette.text.primary,
                },
              }}
            >
              <AddCircleOutlineIcon sx={{ fontSize: 21 }} />
            </ButtonBase>
          </Tooltip>

          {!isRunningPublicNode && (
            <Tooltip placement="right" title="Blocked users">
              <ButtonBase
                onClick={() => {
                  setIsOpenBlockedUserModal(true);
                }}
                sx={{
                  alignItems: 'center',
                  borderRadius: '8px',
                  color: theme.palette.text.secondary,
                  display: 'flex',
                  height: 34,
                  justifyContent: 'center',
                  width: 34,
                  '&:hover': {
                    backgroundColor: theme.palette.action.hover,
                    color: theme.palette.text.primary,
                  },
                }}
              >
                <PersonOffIcon sx={{ fontSize: 20 }} />
              </ButtonBase>
            </Tooltip>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        alignItems: 'flex-start',
        background: theme.palette.background.surface,
        borderRadius: '0 12px 12px 0',
        borderLeft: '1px solid',
        borderColor: 'divider',
        boxShadow: '6px 0 20px rgba(0,0,0,0.18), 2px 0 8px rgba(0,0,0,0.08)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: '0',
        width: '400px',
      }}
    >
      <Box
        sx={{
          alignItems: 'stretch',
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          gap: '10px',
          justifyContent: 'center',
          padding: '14px 12px',
          width: '100%',
        }}
      >
        <ButtonBase
          onClick={() => {
            setDesktopSideView('groups');
          }}
          sx={{
            position: 'relative',
            borderRadius: '12px',
            flex: 1,
            minWidth: 0,
            padding: '14px 12px',
            backgroundColor:
              desktopSideView === 'groups'
                ? theme.palette.action.selected
                : 'transparent',
            transition: 'background-color 0.15s ease',
            '&:hover': {
              backgroundColor:
                desktopSideView === 'groups'
                  ? theme.palette.action.selected
                  : theme.palette.action.hover,
            },
          }}
        >
          {(groupChatHasUnread || groupsAnnHasUnread) && (
            <Box
              sx={{
                position: 'absolute',
                top: 8,
                right: 8,
                width: 14,
                height: 14,
                borderRadius: '50%',
                backgroundColor: theme.palette.primary.main,
                border: `2px solid ${theme.palette.background.paper}`,
              }}
              aria-hidden
            />
          )}
          <Box
            sx={{
              alignItems: 'center',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              justifyContent: 'center',
              width: '100%',
            }}
          >
            <HubsIcon
              height={26}
              width={26}
              color={
                groupChatHasUnread || groupsAnnHasUnread
                  ? theme.palette.primary.main
                  : desktopSideView === 'groups'
                    ? theme.palette.text.primary
                    : theme.palette.text.secondary
              }
            />
            <Typography
              sx={{
                color:
                  groupChatHasUnread || groupsAnnHasUnread
                    ? theme.palette.primary.main
                    : desktopSideView === 'groups'
                      ? theme.palette.text.primary
                      : theme.palette.text.secondary,
                fontFamily: 'Inter',
                fontSize: '13px',
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              {t('group:group.group_other', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Typography>
          </Box>
        </ButtonBase>

        <ButtonBase
          onClick={() => {
            setDesktopSideView('directs');
          }}
          sx={{
            position: 'relative',
            borderRadius: '12px',
            flex: 1,
            minWidth: 0,
            padding: '14px 12px',
            backgroundColor:
              desktopSideView === 'directs'
                ? theme.palette.action.selected
                : 'transparent',
            transition: 'background-color 0.15s ease',
            '&:hover': {
              backgroundColor:
                desktopSideView === 'directs'
                  ? theme.palette.action.selected
                  : theme.palette.action.hover,
            },
          }}
        >
          {directChatHasUnread && (
            <Box
              sx={{
                position: 'absolute',
                top: 8,
                right: 8,
                width: 14,
                height: 14,
                borderRadius: '50%',
                backgroundColor: theme.palette.primary.main,
                border: `2px solid ${theme.palette.background.paper}`,
              }}
              aria-hidden
            />
          )}
          <Box
            sx={{
              alignItems: 'center',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              justifyContent: 'center',
              width: '100%',
            }}
          >
            <MessagingIcon
              height={26}
              width={26}
              color={
                directChatHasUnread
                  ? theme.palette.primary.main
                  : desktopSideView === 'directs'
                    ? theme.palette.text.primary
                    : theme.palette.text.secondary
              }
            />
            <Typography
              sx={{
                color: directChatHasUnread
                  ? theme.palette.primary.main
                  : desktopSideView === 'directs'
                    ? theme.palette.text.primary
                    : theme.palette.text.secondary,
                fontFamily: 'Inter',
                fontSize: '13px',
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              {t('group:group.dm', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Typography>
          </Box>
        </ButtonBase>
      </Box>

      <Box
        sx={{
          alignItems: 'flex-start',
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          left: chatMode === 'directs' && '-1000px',
          overflowY: 'auto',
          padding: '12px 8px',
          position: chatMode === 'directs' && 'fixed',
          visibility: chatMode === 'directs' && 'hidden',
          width: '100%',
        }}
      >
        <List
          sx={{
            width: '100%',
            padding: 0,
          }}
          className="group-list"
          dense={false}
        >
          {groups.map((group: any) => (
            <GroupItem
              selectGroupFunc={selectGroupFunc}
              key={group.groupId}
              group={group}
              selectedGroupId={selectedGroup?.groupId ?? null}
              getUserSettings={getUserSettings}
              myAddress={myAddress}
              reticulumChatEnabled={reticulumChatEnabled}
            />
          ))}
        </List>
      </Box>

      <Box
        sx={{
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          gap: '10px',
          justifyContent: 'center',
          padding: '16px 12px',
          width: '100%',
        }}
      >
        <CustomButton
          onClick={() => {
            setOpenAddGroup(true);
          }}
          sx={{
            flex: 1,
            gap: '8px',
            padding: '10px 16px',
          }}
        >
          <AddCircleOutlineIcon
            sx={{
              color: theme.palette.text.primary,
              fontSize: '20px',
            }}
          />
          {t('group:group.group', { postProcess: 'capitalizeFirstChar' })}
        </CustomButton>

        {!isRunningPublicNode && (
          <CustomButton
            onClick={() => {
              setIsOpenBlockedUserModal(true);
            }}
            sx={{
              minWidth: 'unset',
              padding: '10px',
            }}
          >
            <PersonOffIcon
              sx={{
                color: theme.palette.text.secondary,
                fontSize: '22px',
              }}
            />
          </CustomButton>
        )}
      </Box>
    </Box>
  );
};

GroupListInner.displayName = 'GroupList';

export const GroupList = memo(GroupListInner);

interface GroupItemProps {
  selectGroupFunc: (group: any) => void;
  group: any;
  dropPosition?: GroupDragInsertionPosition;
  selectedGroupId: string | null;
  getUserSettings: () => Promise<any>;
  myAddress: string;
  reticulumChatEnabled?: boolean;
  railMode?: boolean;
}

const GroupItem = memo(
  ({
    selectGroupFunc,
    group,
    dropPosition,
    selectedGroupId,
    getUserSettings,
    myAddress,
    reticulumChatEnabled = false,
    railMode = false,
  }: GroupItemProps) => {
    const theme = useTheme();
    const { t } = useTranslation(['core', 'group']);
    const {
      attributes,
      listeners,
      setNodeRef,
      isDragging,
    } = useSortable({
      id: String(group?.groupId),
      disabled: !railMode,
    });
    const ownerName = useAtomValue(groupsOwnerNamesSelector(group?.groupId));
    const announcement = useAtomValue(
      groupAnnouncementSelector(group?.groupId)
    );
    const groupProperty = useAtomValue(groupPropertySelector(group?.groupId));
    const groupChatTimestamp = useAtomValue(
      groupChatTimestampSelector(group?.groupId)
    );
    const timestampEnterData = useAtomValue(
      timestampEnterDataSelector(group?.groupId)
    );
    const meshCallActiveByGroup = useAtomValue(qortalGroupMeshCallActiveAtom);
    const meshCallParticipantCountByGroup = useAtomValue(
      qortalGroupMeshCallParticipantCountAtom
    );
    const meshCallMaxParticipantsByGroup = useAtomValue(
      qortalGroupMeshCallMaxParticipantsAtom
    );
    const selfGcallRoomId = useAtomValue(qortalGroupSelfGcallRoomIdAtom);
    const [isPreviewOpen, setIsPreviewOpen] = useState(false);
    const [previewSrc, setPreviewSrc] = useState(null);
    const [isAvatarLoaded, setIsAvatarLoaded] = useState(false);
    const [isGroupTooltipOpen, setIsGroupTooltipOpen] = useState(false);
    const [isGroupContextMenuOpen, setIsGroupContextMenuOpen] = useState(false);
    const avatarUrl = useMemo(() => {
      if (!ownerName) return null;
      return `${getBaseApiReact()}/arbitrary/THUMBNAIL/${ownerName}/qortal_group_avatar_${group?.groupId}?async=true`;
    }, [ownerName, group?.groupId]);
    useEffect(() => {
      setIsAvatarLoaded(false);
    }, [avatarUrl]);

    const selectGroupHandler = useCallback(() => {
      selectGroupFunc(group);
    }, [group, selectGroupFunc]);

    const stopEvent = useCallback((event) => {
      event.stopPropagation();
      if (event.nativeEvent?.stopImmediatePropagation) {
        event.nativeEvent.stopImmediatePropagation();
      }
    }, []);

    const handleAvatarClick = useCallback(
      (event) => {
        if (!avatarUrl || !isAvatarLoaded) return;
        event.preventDefault();
        stopEvent(event);
        setPreviewSrc(avatarUrl);
        setIsPreviewOpen(true);
      },
      [avatarUrl, isAvatarLoaded, stopEvent]
    );

    const handleClosePreview = useCallback(() => {
      setIsPreviewOpen(false);
      setPreviewSrc(null);
    }, [setIsPreviewOpen, setPreviewSrc]);

    const isSelected = group?.groupId === selectedGroupId;
    const reticulumUnreadCount = Math.max(
      0,
      Number(group?.reticulumChatSummary?.unreadCount || 0)
    );
    const hasReticulumUnread =
      reticulumUnreadCount > 0;
    const hasReticulumMention =
      group?.reticulumChatSummary?.hasUnreadMention === true ||
      (group?.reticulumChatSummary?.mentionCount ?? 0) > 0;

    const gcallRoomIdForRow =
      group?.groupId && group.groupId !== '0' && Number.isFinite(Number(group.groupId))
        ? `gcall-qortal-${Number(group.groupId)}`
        : null;
    const imInThisGroupGcall =
      Boolean(gcallRoomIdForRow) && selfGcallRoomId === gcallRoomIdForRow;
    const meshShowsCall = meshCallActiveForMemberGroup(
      meshCallActiveByGroup,
      group?.groupId
    );
    const meshCallParticipantCount = meshCallParticipantCountForMemberGroup(
      meshCallParticipantCountByGroup,
      group?.groupId
    );
    const meshCallMaxParticipants = meshCallMaxParticipantsForMemberGroup(
      meshCallMaxParticipantsByGroup,
      group?.groupId
    );
    const showGroupCallIndicator = Boolean(gcallRoomIdForRow) && (imInThisGroupGcall || meshShowsCall);

    if (railMode) {
      const groupLabel =
        group.groupId === '0' ? 'General' : group.groupName || 'Group';
      const fallbackAvatarColor = getPastelAvatarColor(
        group?.groupId || group?.groupName
      );
      const unreadBadgeLabel =
        reticulumUnreadCount > 99 ? '99+' : String(reticulumUnreadCount);
      const avatarNode = ownerName ? (
        <Avatar
          sx={{
            backgroundColor: isAvatarLoaded
              ? isSelected
                ? RETICULUM_ACTIVE_BLUE
                : theme.palette.background.surface
              : fallbackAvatarColor,
            color: theme.palette.common.white,
            display: 'flex',
            fontWeight: 800,
            height: 38,
            m: 'auto',
            width: 38,
            zIndex: 1,
          }}
          alt={group?.groupName?.charAt(0)}
          src={avatarUrl || undefined}
          imgProps={{
            onLoad: () => {
              setIsAvatarLoaded(true);
            },
            onError: () => {
              setIsAvatarLoaded(false);
            },
          }}
        >
          {group?.groupName?.charAt(0).toUpperCase()}
        </Avatar>
      ) : (
        <Avatar
          alt={group?.groupName?.charAt(0)}
          sx={{
            backgroundColor: fallbackAvatarColor,
            color: theme.palette.common.white,
            display: 'flex',
            fontWeight: 800,
            height: 38,
            m: 'auto',
            width: 38,
            zIndex: 1,
          }}
        >
          {group?.groupName?.charAt(0).toUpperCase() || 'G'}
        </Avatar>
      );

      return (
        <Tooltip
          disableFocusListener
          disableHoverListener
          disableTouchListener
          open={isGroupTooltipOpen && !isGroupContextMenuOpen && !isDragging}
          placement="right"
          title={groupLabel}
        >
          <ListItem
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            onClick={() => {
              setIsGroupTooltipOpen(false);
              selectGroupHandler();
            }}
            onContextMenuCapture={() => setIsGroupTooltipOpen(false)}
            onMouseEnter={() => setIsGroupTooltipOpen(true)}
            onMouseLeave={() => setIsGroupTooltipOpen(false)}
            onPointerDownCapture={() => setIsGroupTooltipOpen(false)}
            sx={{
              alignItems: 'center',
              backgroundColor: isSelected
                ? RETICULUM_ACTIVE_BLUE
                : 'transparent',
              borderRadius: '8px',
              boxSizing: 'border-box',
              cursor: 'pointer',
              display: 'grid',
              flexShrink: 0,
              height: 52,
              justifyContent: 'center',
              minHeight: 52,
              placeItems: 'center',
              mb: 0,
              opacity: isDragging ? 0.58 : 1,
              overflow: 'visible',
              p: 0,
              position: 'relative',
              width: 52,
              zIndex: isDragging ? 4 : 'auto',
              '&:hover': {
                backgroundColor: isSelected
                  ? RETICULUM_ACTIVE_BLUE
                  : theme.palette.action.hover,
              },
            }}
          >
            {dropPosition && <GroupDropIndicator position={dropPosition} />}
            <ContextMenu
              getUserSettings={getUserSettings}
              groupId={group.groupId}
              myAddress={myAddress}
              onMenuOpenChange={setIsGroupContextMenuOpen}
              reticulumGroup={group}
            >
              <Box
                sx={{
                  alignItems: 'center',
                  display: 'flex',
                  height: '100%',
                  justifyContent: 'center',
                  left: 0,
                  margin: 'auto',
                  overflow: 'visible',
                  position: 'relative',
                  right: 0,
                  width: '100%',
                }}
              >
                {avatarNode}

                {(hasReticulumUnread ||
                  (!reticulumChatEnabled &&
                    group?.data &&
                    groupChatTimestamp &&
                    group?.sender !== myAddress &&
                    group?.timestamp &&
                    ((!timestampEnterData &&
                      Date.now() - group?.timestamp <
                        timeDifferenceForNotificationChats) ||
                      timestampEnterData < group?.timestamp))) && (
                  <Box
                    sx={{
                      alignItems: 'center',
                      backgroundColor: RETICULUM_ACTIVE_BLUE,
                      border: `2px solid ${theme.palette.background.surface}`,
                      borderRadius: '50%',
                      bottom: -2,
                      color: theme.palette.common.white,
                      display: 'flex',
                      fontSize: 10,
                      fontWeight: 800,
                      height: 18,
                      justifyContent: 'center',
                      lineHeight: 1,
                      minWidth: 18,
                      px: hasReticulumUnread && reticulumUnreadCount > 9 ? 0.45 : 0,
                      position: 'absolute',
                      right: -2,
                      zIndex: 2,
                    }}
                  >
                    {hasReticulumUnread ? unreadBadgeLabel : ''}
                  </Box>
                )}

                {hasReticulumMention && (
                  <AlternateEmailIcon
                    sx={{
                      backgroundColor: theme.palette.background.surface,
                      borderRadius: '50%',
                      color: theme.palette.other.unread,
                      fontSize: 16,
                      position: 'absolute',
                      right: 0,
                      top: 0,
                      zIndex: 2,
                    }}
                  />
                )}

                {announcement && !announcement?.seentimestamp && (
                  <CampaignIcon
                    sx={{
                      backgroundColor: theme.palette.background.surface,
                      borderRadius: '50%',
                      color: theme.palette.other.unread,
                      fontSize: 16,
                      left: 0,
                      position: 'absolute',
                      top: 0,
                      zIndex: 2,
                    }}
                  />
                )}

                {showGroupCallIndicator && (
                  <PhoneInTalkIcon
                    sx={{
                      backgroundColor: theme.palette.background.surface,
                      borderRadius: '50%',
                      color: imInThisGroupGcall
                        ? theme.palette.primary.main
                        : theme.palette.info.main,
                      fontSize: 16,
                      left: 0,
                      position: 'absolute',
                      top: 17,
                      zIndex: 2,
                    }}
                  />
                )}
              </Box>
            </ContextMenu>

            <AvatarPreviewModal
              open={isPreviewOpen}
              src={previewSrc}
              alt={group?.groupName}
              onClose={handleClosePreview}
            />
          </ListItem>
        </Tooltip>
      );
    }

    return (
      <ListItem
        onClick={selectGroupHandler}
        sx={{
          borderRadius: '10px',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          marginBottom: '6px',
          padding: '12px 14px',
          width: '100%',
          backgroundColor: isSelected
            ? theme.palette.action.selected
            : 'transparent',
          borderLeft: isSelected
            ? `3px solid ${theme.palette.primary.main}`
            : '3px solid transparent',
          transition: 'background-color 0.15s ease, border-color 0.15s ease',
          '&:hover': {
            backgroundColor: isSelected
              ? theme.palette.action.selected
              : theme.palette.action.hover,
          },
        }}
      >
        <ContextMenu getUserSettings={getUserSettings} groupId={group.groupId}>
          <Box
            sx={{
              alignItems: 'center',
              display: 'flex',
              gap: '20px',
              width: '100%',
            }}
          >
            <ListItemAvatar sx={{ minWidth: 44, marginRight: 0 }}>
              {ownerName ? (
                <Avatar
                  sx={{
                    height: 40,
                    width: 40,
                    ...getClickableAvatarSx(theme, isAvatarLoaded),
                  }}
                  alt={group?.groupName?.charAt(0)}
                  src={avatarUrl || undefined}
                  onClick={handleAvatarClick}
                  onMouseDown={(event) => {
                    if (isAvatarLoaded) {
                      stopEvent(event);
                    }
                  }}
                  onTouchStart={(event) => {
                    if (isAvatarLoaded) {
                      stopEvent(event);
                    }
                  }}
                  imgProps={{
                    onLoad: () => {
                      setIsAvatarLoaded(true);
                    },
                    onError: () => {
                      setIsAvatarLoaded(false);
                    },
                  }}
                >
                  {group?.groupName?.charAt(0).toUpperCase()}
                </Avatar>
              ) : (
                <Avatar
                  alt={group?.groupName?.charAt(0)}
                  sx={{ height: 40, width: 40 }}
                >
                  {group?.groupName?.charAt(0).toUpperCase() || 'G'}
                </Avatar>
              )}
            </ListItemAvatar>

            <ListItemText
              primary={group.groupId === '0' ? 'General' : group.groupName}
              secondary={
                !group?.timestamp
                  ? t('core:message.generic.no_messages', {
                      postProcess: 'capitalizeFirstChar',
                    })
                  : t('group:last_message_date', {
                      date: formatEmailDate(group?.timestamp),
                    })
              }
              primaryTypographyProps={{
                sx: {
                  color: theme.palette.text.primary,
                  fontFamily: 'Inter',
                  fontSize: '15px',
                  fontWeight: 600,
                  lineHeight: 1.3,
                },
              }}
              secondaryTypographyProps={{
                sx: {
                  color: theme.palette.text.secondary,
                  fontFamily: 'Inter',
                  fontSize: '12px',
                  lineHeight: 1.4,
                  marginTop: '3px',
                },
              }}
              sx={{
                flex: 1,
                minWidth: 0,
                margin: 0,
                overflow: 'hidden',
              }}
            />

            {announcement && !announcement?.seentimestamp && (
              <CampaignIcon
                sx={{
                  color: theme.palette.other.unread,
                  fontSize: '20px',
                  flexShrink: 0,
                }}
              />
            )}

            <Box
              sx={{
                alignItems: 'center',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                flexShrink: 0,
                justifyContent: 'center',
                marginLeft: '4px',
              }}
            >
              {(hasReticulumUnread ||
                (!reticulumChatEnabled &&
                  group?.data &&
                  groupChatTimestamp &&
                  group?.sender !== myAddress &&
                  group?.timestamp &&
                  ((!timestampEnterData &&
                    Date.now() - group?.timestamp <
                      timeDifferenceForNotificationChats) ||
                    timestampEnterData < group?.timestamp))) && (
                  <MarkChatUnreadIcon
                    sx={{
                      color: theme.palette.other.unread,
                      fontSize: '18px',
                    }}
                  />
                )}

              {hasReticulumMention && (
                <AlternateEmailIcon
                  sx={{
                    color: theme.palette.other.unread,
                    fontSize: '18px',
                  }}
                />
              )}

              {groupProperty?.isOpen === false && (
                <LockIcon
                  sx={{
                    color: theme.palette.other.positive,
                    fontSize: '18px',
                  }}
                />
              )}

              {showGroupCallIndicator && (
                <Box
                  sx={{
                    alignItems: 'center',
                    color: imInThisGroupGcall
                      ? theme.palette.primary.main
                      : theme.palette.info.main,
                    display: 'flex',
                    gap: '3px',
                    flexShrink: 0,
                  }}
                  title={
                    imInThisGroupGcall
                      ? t('core:group_list_call_youre_in', {
                          postProcess: 'capitalizeFirstChar',
                        })
                      : t('core:group_list_call_active', {
                          postProcess: 'capitalizeFirstChar',
                        })
                  }
                >
                  <PhoneInTalkIcon
                    sx={{
                      color: 'inherit',
                      fontSize: '18px',
                      flexShrink: 0,
                    }}
                  />
                  {meshCallParticipantCount !== null && (
                    <Typography
                      component="span"
                      sx={{
                        color: 'inherit',
                        fontFamily: 'Inter',
                        fontSize: '11px',
                        fontWeight: 700,
                        lineHeight: 1,
                        minWidth: '7px',
                      }}
                    >
                      {meshCallParticipantCount}
                      {meshCallMaxParticipants !== null
                        ? `/${meshCallMaxParticipants}`
                        : ''}
                    </Typography>
                  )}
                </Box>
              )}
            </Box>
          </Box>
        </ContextMenu>

        <AvatarPreviewModal
          open={isPreviewOpen}
          src={previewSrc}
          alt={group?.groupName}
          onClose={handleClosePreview}
        />
      </ListItem>
    );
  }
);
