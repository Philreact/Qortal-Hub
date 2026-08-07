import ChatBubbleOutlineRoundedIcon from '@mui/icons-material/ChatBubbleOutlineRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded';
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded';
import {
  Avatar,
  Box,
  Button,
  ButtonBase,
  Typography,
  alpha,
  useTheme,
} from '@mui/material';
import { useAtomValue } from 'jotai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getBaseApiReact } from '../../App';
import { groupsOwnerNamesAtom } from '../../atoms/global';
import {
  orderReticulumGroups,
  readReticulumGroupOrder,
  subscribeToReticulumGroupOrder,
} from './reticulumGroupRail';
import { QChatWhatsNewDialog } from './QChatWhatsNewDialog';

const RETICULUM_NOTIFICATION_RED = '#f23f42';
const RETICULUM_UNREAD_BLUE = '#168bff';
const ACTIVITY_CARD_BACKGROUND = 'rgba(28, 31, 39, 0.86)';

type ActivityGroup = {
  groupId: string | number;
  groupName?: string;
  name?: string;
  reticulumChatSummary?: {
    unreadCount?: number;
    mentionCount?: number;
    hasUnreadMention?: boolean;
  };
};

type NormalizedActivityGroup = {
  avatarUrl?: string;
  group: ActivityGroup;
  groupId: string;
  mentionCount: number;
  name: string;
  newMessageCount: number;
};

type ReturningUserActivityDashboardProps = {
  displayName?: string;
  groups: ActivityGroup[];
  initialVisibleCount?: number;
  onBrowseCommunities: () => void;
  onSelectGroup: (group: ActivityGroup) => void;
};

const activityLabel = ({
  mentionCount,
  name,
  newMessageCount,
}: NormalizedActivityGroup) => {
  const parts = [`Open ${name}`];
  if (newMessageCount > 0) {
    parts.push(
      `${newMessageCount} new ${newMessageCount === 1 ? 'message' : 'messages'}`
    );
  }
  if (mentionCount > 0) {
    parts.push(`${mentionCount} ${mentionCount === 1 ? 'mention' : 'mentions'}`);
  }
  return parts.join(', ');
};

function GroupActivityCard({
  item,
  onSelect,
}: {
  item: NormalizedActivityGroup;
  onSelect: () => void;
}) {
  const theme = useTheme();
  const initial = item.name.trim().charAt(0).toUpperCase() || 'G';
  const lightMode = theme.palette.mode === 'light';
  return (
    <ButtonBase
      aria-label={activityLabel(item)}
      onClick={onSelect}
      sx={{
        alignItems: 'center',
        backgroundColor: lightMode
          ? alpha(theme.palette.primary.main, 0.09)
          : ACTIVITY_CARD_BACKGROUND,
        border: '1px solid',
        borderColor: lightMode
          ? alpha(theme.palette.primary.main, 0.18)
          : 'rgba(255, 255, 255, 0.065)',
        borderRadius: '10px',
        boxShadow: '0 7px 20px rgba(0, 0, 0, 0.18)',
        boxSizing: 'border-box',
        cursor: 'pointer',
        display: 'flex',
        height: 124,
        justifyContent: 'flex-start',
        overflow: 'hidden',
        p: 2,
        position: 'relative',
        textAlign: 'left',
        transition:
          'background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease',
        width: '100%',
        '&:hover': {
          backgroundColor: lightMode
            ? alpha(theme.palette.primary.main, 0.14)
            : 'rgba(36, 40, 50, 0.94)',
          borderColor: lightMode
            ? alpha(theme.palette.primary.main, 0.3)
            : 'rgba(93, 160, 255, 0.22)',
          boxShadow: '0 10px 26px rgba(0, 0, 0, 0.26)',
          transform: 'translateY(-1px)',
        },
        '&:active': {
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.18)',
          transform: 'translateY(0)',
        },
        '&:focus-visible': {
          outline: '2px solid #4d9aff',
          outlineOffset: 2,
        },
      }}
    >
      <Box
        aria-hidden
        sx={{
          backgroundColor: RETICULUM_UNREAD_BLUE,
          borderRadius: '50%',
          boxShadow: '0 0 9px rgba(22, 139, 255, 0.48)',
          height: 10,
          position: 'absolute',
          right: 16,
          top: 16,
          width: 10,
        }}
      />
      <Avatar
        alt=""
        src={item.avatarUrl}
        sx={{
          backgroundColor: 'transparent',
          color: 'common.white',
          flexShrink: 0,
          fontSize: 22,
          fontWeight: 750,
          height: 56,
          mr: 2,
          width: 56,
        }}
      >
        {initial}
      </Avatar>
      <Box sx={{ minWidth: 0, pr: 2.5 }}>
        <Typography
          sx={{
            color: 'text.primary',
            fontSize: 16,
            fontWeight: 650,
            lineHeight: 1.25,
            mb: 0.75,
          }}
          noWrap
        >
          {item.name}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.45 }}>
          {item.newMessageCount > 0 && (
            <Typography
              sx={{ color: 'text.secondary', fontSize: 13.5, lineHeight: 1.35 }}
            >
              {item.newMessageCount} new{' '}
              {item.newMessageCount === 1 ? 'message' : 'messages'}
            </Typography>
          )}
          {item.mentionCount > 0 && (
            <Box sx={{ alignItems: 'center', display: 'flex', gap: 0.75 }}>
              <Typography
                sx={{ color: 'text.secondary', fontSize: 13.5, lineHeight: 1.35 }}
              >
                {item.mentionCount}{' '}
                {item.mentionCount === 1 ? 'mention' : 'mentions'}
              </Typography>
              <Box
                component="span"
                sx={{
                  backgroundColor: RETICULUM_NOTIFICATION_RED,
                  borderRadius: '6px',
                  color: 'common.white',
                  fontSize: 11,
                  fontWeight: 750,
                  lineHeight: '19px',
                  minWidth: 30,
                  px: 0.65,
                  textAlign: 'center',
                }}
              >
                @ {item.mentionCount}
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    </ButtonBase>
  );
}

export function ReturningUserActivityDashboard({
  displayName,
  groups,
  initialVisibleCount = 9,
  onBrowseCommunities,
  onSelectGroup,
}: ReturningUserActivityDashboardProps) {
  const theme = useTheme();
  const ownerNames = useAtomValue(groupsOwnerNamesAtom) as Record<
    string,
    string | undefined
  >;
  const [manualGroupOrder, setManualGroupOrder] = useState(
    readReticulumGroupOrder
  );
  const [expanded, setExpanded] = useState(false);
  const [isWhatsNewOpen, setIsWhatsNewOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(
    () => subscribeToReticulumGroupOrder(setManualGroupOrder),
    []
  );

  const activityGroups = useMemo(() => {
    return orderReticulumGroups(groups || [], manualGroupOrder)
      .map((group): NormalizedActivityGroup | null => {
        const groupId = String(group?.groupId ?? '');
        if (!groupId || groupId === '0') return null;
        const summary = group?.reticulumChatSummary;
        const newMessageCount = Math.max(
          0,
          Number(summary?.unreadCount) || 0
        );
        const mentionCount = Math.max(
          0,
          Number(summary?.mentionCount) || 0
        );
        if (newMessageCount === 0 && mentionCount === 0) return null;
        const name = group?.groupName || group?.name || `Group ${groupId}`;
        const ownerName = ownerNames[groupId];
        return {
          avatarUrl: ownerName
            ? `${getBaseApiReact()}/arbitrary/THUMBNAIL/${ownerName}/qortal_group_avatar_${groupId}?async=true`
            : undefined,
          group,
          groupId,
          mentionCount,
          name,
          newMessageCount,
        };
      })
      .filter((group): group is NormalizedActivityGroup => Boolean(group));
  }, [groups, manualGroupOrder, ownerNames]);

  const hasMore = activityGroups.length > initialVisibleCount;
  const visibleGroups = expanded
    ? activityGroups
    : activityGroups.slice(0, initialVisibleCount);
  const placeholderCount = expanded
    ? 0
    : Math.max(0, initialVisibleCount - visibleGroups.length);

  const collapseGroups = () => {
    setExpanded(false);
    window.requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ behavior: 'smooth', top: 0 });
    });
  };

  return (
    <Box
      ref={scrollContainerRef}
      sx={{
        height: '100%',
        minHeight: 0,
        overflowX: 'hidden',
        overflowY: 'auto',
        position: 'relative',
        scrollbarWidth: 'none',
        width: '100%',
        '&::-webkit-scrollbar': { display: 'none' },
      }}
    >
      <Button
        onClick={() => setIsWhatsNewOpen(true)}
        variant="outlined"
        sx={{
          borderColor: 'rgba(151, 161, 178, 0.35)',
          borderRadius: '8px',
          color: 'text.secondary',
          fontSize: 13,
          fontWeight: 650,
          position: 'absolute',
          right: { xs: 16, sm: 24 },
          textTransform: 'none',
          top: { xs: 16, sm: 24 },
          zIndex: 3,
          '&:hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.055)',
            borderColor: 'rgba(151, 161, 178, 0.58)',
            color: 'text.primary',
          },
        }}
      >
        What's New?
      </Button>

      <Box
        sx={{
          alignItems: 'center',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          minHeight: '100%',
          px: 3,
          py: { xs: 7, md: 8 },
        }}
      >
        <Typography
          component="h2"
          sx={{
            color: 'text.primary',
            fontSize: { xs: 30, md: 38 },
            fontWeight: 600,
            letterSpacing: '-0.02em',
            lineHeight: 1.15,
            mb: 1.25,
            textAlign: 'center',
          }}
        >
          {displayName ? `Welcome back, ${displayName}!` : 'Welcome back!'}
        </Typography>
        <Typography
          sx={{
            color: 'text.secondary',
            fontSize: { xs: 15, md: 17 },
            lineHeight: 1.45,
            mb: activityGroups.length > 0 ? 4.5 : 0,
            textAlign: 'center',
          }}
        >
          {activityGroups.length > 0
            ? "Here's what you've missed while you were away."
            : "You're all caught up. No new messages right now."}
        </Typography>

        {activityGroups.length > 0 && (
          <>
            <Box
              sx={{
                display: 'grid',
                gap: 1.5,
                gridTemplateColumns: {
                  xs: 'minmax(0, 1fr)',
                  sm: 'repeat(2, minmax(0, 280px))',
                  md: 'repeat(3, minmax(0, 280px))',
                },
                justifyContent: 'center',
                maxWidth: 880,
                width: '100%',
              }}
            >
              {visibleGroups.map((item) => (
                <GroupActivityCard
                  item={item}
                  key={item.groupId}
                  onSelect={() => onSelectGroup(item.group)}
                />
              ))}
              {Array.from({ length: placeholderCount }, (_, index) => (
                <Box
                  aria-hidden
                  data-qchat-activity-placeholder
                  key={`activity-placeholder-${index}`}
                  sx={{
                    backgroundColor:
                      theme.palette.mode === 'light'
                        ? alpha(theme.palette.text.primary, 0.055)
                        : ACTIVITY_CARD_BACKGROUND,
                    border: '1px solid',
                    borderColor:
                      theme.palette.mode === 'light'
                        ? alpha(theme.palette.text.primary, 0.1)
                        : 'rgba(255, 255, 255, 0.035)',
                    borderRadius: '10px',
                    boxSizing: 'border-box',
                    height: 124,
                    opacity: theme.palette.mode === 'light' ? 1 : 0.38,
                    pointerEvents: 'none',
                    width: '100%',
                  }}
                />
              ))}
            </Box>

            {hasMore && (
              <Button
                aria-expanded={expanded}
                onClick={expanded ? collapseGroups : () => setExpanded(true)}
                startIcon={<ChatBubbleOutlineRoundedIcon sx={{ fontSize: 18 }} />}
                endIcon={
                  expanded ? (
                    <ExpandLessRoundedIcon sx={{ fontSize: 19 }} />
                  ) : (
                    <ChevronRightRoundedIcon sx={{ fontSize: 19 }} />
                  )
                }
                sx={{
                  color: 'text.secondary',
                  fontSize: 13.5,
                  fontWeight: 500,
                  mt: 3,
                  textTransform: 'none',
                  '&:hover': {
                    backgroundColor: 'rgba(255, 255, 255, 0.045)',
                    color: 'text.primary',
                  },
                }}
              >
                {expanded ? 'Show fewer servers' : 'View all servers'}
              </Button>
            )}

            {!hasMore && (
              <Box
                sx={{
                  alignItems: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  mt: 4.5,
                }}
              >
                <Button
                  aria-label="Browse Communities"
                  onClick={onBrowseCommunities}
                  startIcon={<GroupsRoundedIcon sx={{ fontSize: 19 }} />}
                  variant="outlined"
                  sx={{
                    backgroundColor: 'transparent',
                    borderColor: 'rgba(125, 158, 202, 0.42)',
                    borderRadius: '8px',
                    color: 'text.primary',
                    fontSize: 13,
                    fontWeight: 600,
                    height: 40,
                    textTransform: 'none',
                    transition:
                      'background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease',
                    width: 210,
                    '&:hover': {
                      backgroundColor: 'rgba(38, 48, 64, 0.62)',
                      borderColor: 'rgba(87, 157, 255, 0.72)',
                      boxShadow: '0 7px 18px rgba(0, 0, 0, 0.2)',
                    },
                    '&:active': {
                      backgroundColor: 'rgba(13, 18, 26, 0.62)',
                      boxShadow: 'none',
                    },
                    '&:focus-visible': {
                      outline: '2px solid',
                      outlineColor: 'primary.main',
                      outlineOffset: 2,
                    },
                  }}
                >
                  Browse Communities
                </Button>
                <Typography
                  sx={{
                    color: 'text.secondary',
                    fontSize: 13.5,
                    lineHeight: 1.45,
                    mt: 1.75,
                  }}
                >
                  Looking for something new? Discover more communities.
                </Typography>
              </Box>
            )}
          </>
        )}
      </Box>

      <QChatWhatsNewDialog
        onClose={() => setIsWhatsNewOpen(false)}
        open={isWhatsNewOpen}
      />
    </Box>
  );
}
