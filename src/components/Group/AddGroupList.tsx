import {
  Avatar,
  Box,
  ButtonBase,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  ListItem,
  ListItemButton,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import GroupIcon from '@mui/icons-material/Group';
import PersonIcon from '@mui/icons-material/Person';
import DescriptionIcon from '@mui/icons-material/Description';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AutoSizer, List } from 'react-virtualized';
import { QORTAL_APP_CONTEXT, getBaseApiReact } from '../../App';
import { LoadingButton } from '@mui/lab';
import { getFee } from '../../background/background.ts';
import LockIcon from '@mui/icons-material/Lock';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import WhatshotRoundedIcon from '@mui/icons-material/WhatshotRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import { useTranslation } from 'react-i18next';
import { useAtom, useSetAtom } from 'jotai';
import { memberGroupsAtom, txListAtom } from '../../atoms/global';
import { formatTimestamp } from '../../utils/time.ts';
import { Spacer } from '../../common/Spacer.tsx';
import Logo2 from '../../assets/svgs/Logo2.svg';
import {
  getGroupLevel,
  getGroupLevelColor,
} from './ReticulumGroupLevel';
import {
  getCommunityLevel,
  getLegacyLevel,
} from './ReticulumGroupAbout';

const GROUP_ROW_HEIGHT = 88;
const FIND_GROUPS_PAGE_SIZE = 10;
const FIND_GROUPS_AVATAR_LIMIT = 20;

export const isOpenGroup = (group) =>
  group?.isOpen === true || group?.groupType === 0 || group?.groupType === 'OPEN';
const formatMemberCount = (count) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    Number(count) || 0
  );

export const AddGroupList = ({ setInfoSnack, setOpenSnack }) => {
  const { show } = useContext(QORTAL_APP_CONTEXT);
  const [memberGroups] = useAtom(memberGroupsAtom);
  const setTxList = useSetAtom(txListAtom);
  const { t } = useTranslation([
    'auth',
    'core',
    'group',
    'question',
    'tutorial',
  ]);
  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [ownerAddress, setOwnerAddress] = useState(null);
  const [ownerPrimaryName, setOwnerPrimaryName] = useState(null);
  const [ownerLoading, setOwnerLoading] = useState(false);
  const listRef = useRef(null);
  const [inputValue, setInputValue] = useState('');
  const [sortMode, setSortMode] = useState<'popular' | 'newest'>('popular');
  const [showOpen, setShowOpen] = useState(false);
  const [showPrivate, setShowPrivate] = useState(false);
  const [visibleCount, setVisibleCount] = useState(FIND_GROUPS_PAGE_SIZE);
  const [topGroupOwnerNames, setTopGroupOwnerNames] = useState({});
  const [publicActivityByGroup, setPublicActivityByGroup] = useState<
    Record<
      string,
      {
        messages24h: number;
        messages7d: number;
        activeAuthors7d: number;
        observedAt: number;
        confidence: number;
      }
    >
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const theme = useTheme();

  useEffect(() => {
    if (!selectedGroup?.groupId) {
      setOwnerAddress(null);
      setOwnerPrimaryName(null);
      return;
    }
    let cancelled = false;
    setOwnerLoading(true);
    setOwnerAddress(null);
    setOwnerPrimaryName(null);
    const fetchOwner = async () => {
      try {
        const res = await fetch(
          `${getBaseApiReact()}/groups/${selectedGroup.groupId}`
        );
        const data = await res.json();
        if (cancelled || !data?.owner) return;
        setOwnerAddress(data.owner);
        if (!cancelled && data.ownerPrimaryName)
          setOwnerPrimaryName(data.ownerPrimaryName);
      } catch (err) {
        if (!cancelled) {
          setOwnerAddress(null);
          setOwnerPrimaryName(null);
        }
      } finally {
        if (!cancelled) setOwnerLoading(false);
      }
    };
    fetchOwner();
    return () => {
      cancelled = true;
    };
  }, [selectedGroup?.groupId]);

  // Derive filtered list from groups + search so refetches (e.g. when memberGroups updates) don't clear the filter
  const filteredItems = useMemo(() => {
    const query = (inputValue || '').trim().toLowerCase();
    return groups
      .filter((item) => {
        const matchesQuery = !query || item.groupName.toLowerCase().includes(query);
        const matchesAccess = (!showOpen && !showPrivate) ||
          (showOpen && isOpenGroup(item)) ||
          (showPrivate && !isOpenGroup(item));
        return matchesQuery && matchesAccess;
      })
      .sort((a, b) => {
        if (sortMode === 'newest') {
          return Number(b?.created || 0) - Number(a?.created || 0);
        }
        const aActivity = isOpenGroup(a)
          ? publicActivityByGroup[String(a?.groupId)]
          : undefined;
        const bActivity = isOpenGroup(b)
          ? publicActivityByGroup[String(b?.groupId)]
          : undefined;
        if (aActivity || bActivity) {
          if (!aActivity) return 1;
          if (!bActivity) return -1;
          const activityOrder =
            bActivity.activeAuthors7d - aActivity.activeAuthors7d ||
            bActivity.messages24h - aActivity.messages24h ||
            bActivity.messages7d - aActivity.messages7d;
          if (activityOrder !== 0) return activityOrder;
        }
        const aLevel = getGroupLevel(
          getLegacyLevel(a?.created ?? a?.creationTimestamp ?? a?.createdAt),
          getCommunityLevel(Number(a?.memberCount) || 0)
        ) ?? -1;
        const bLevel = getGroupLevel(
          getLegacyLevel(b?.created ?? b?.creationTimestamp ?? b?.createdAt),
          getCommunityLevel(Number(b?.memberCount) || 0)
        ) ?? -1;
        return bLevel - aLevel || Number(b?.memberCount || 0) - Number(a?.memberCount || 0);
      });
  }, [
    groups,
    inputValue,
    publicActivityByGroup,
    showOpen,
    showPrivate,
    sortMode,
  ]);

  const avatarEligibleGroupIds = useMemo(
    () => new Set(
      [...groups]
        .sort((a, b) => Number(b?.memberCount || 0) - Number(a?.memberCount || 0))
        .slice(0, FIND_GROUPS_AVATAR_LIMIT)
        .map((group) => String(group.groupId))
    ),
    [groups]
  );
  const visibleItems = useMemo(
    () => filteredItems.slice(0, visibleCount),
    [filteredItems, visibleCount]
  );

  useEffect(() => {
    setVisibleCount(FIND_GROUPS_PAGE_SIZE);
    listRef.current?.scrollToRow?.(0);
  }, [inputValue, showOpen, showPrivate, sortMode]);

  // Discover only the owners needed for the top twenty avatar requests.  Groups
  // further down the directory deliberately keep the local fallback artwork.
  useEffect(() => {
    let cancelled = false;
    const topGroups = [...groups]
      .sort((a, b) => Number(b?.memberCount || 0) - Number(a?.memberCount || 0))
      .slice(0, FIND_GROUPS_AVATAR_LIMIT);
    if (topGroups.length === 0) {
      setTopGroupOwnerNames({});
      return undefined;
    }
    void Promise.all(
      topGroups.map(async (group) => {
        try {
          const response = await fetch(`${getBaseApiReact()}/groups/${group.groupId}`);
          const data = await response.json();
          return [String(group.groupId), data?.ownerPrimaryName || null];
        } catch {
          return [String(group.groupId), null];
        }
      })
    ).then((entries) => {
      if (!cancelled) setTopGroupOwnerNames(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [groups]);

  const handleChange = (event) => {
    setInputValue(event.target.value);
  };

  const getGroups = async () => {
    setGroupsLoading(true);
    try {
      const response = await fetch(`${getBaseApiReact()}/groups/?limit=0`);
      const groupData = await response.json();
      const publicGroupIds = groupData
        .filter(isOpenGroup)
        .map((group) => Number(group?.groupId))
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0);
      await window.reticulumChat?.setPublicGroupDirectory?.(publicGroupIds);
      const activity = await window.reticulumChat?.getPublicGroupActivity?.();
      if (Array.isArray(activity)) {
        setPublicActivityByGroup(
          Object.fromEntries(
            activity.map((summary) => [String(summary.groupId), summary])
          )
        );
      }
      const filteredGroup = groupData.filter(
        (item) => !memberGroups.find((group) => group.groupId === item.groupId)
      );
      setGroups(filteredGroup);
    } catch (error) {
      console.error(error);
    } finally {
      setGroupsLoading(false);
    }
  };

  useEffect(() => {
    getGroups();
  }, [memberGroups]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const activity = await window.reticulumChat?.getPublicGroupActivity?.();
      if (cancelled || !Array.isArray(activity)) return;
      setPublicActivityByGroup(
        Object.fromEntries(
          activity.map((summary) => [String(summary.groupId), summary])
        )
      );
    };
    const initialTimer = window.setTimeout(() => void refresh(), 2_000);
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, []);

  const handleOpenDialog = (group) => {
    setSelectedGroup(group);
  };

  const handleCloseDialog = () => {
    setSelectedGroup(null);
  };

  const handleCopyAddress = () => {
    if (ownerAddress) {
      navigator.clipboard
        .writeText(ownerAddress)
        .then(() => {
          setInfoSnack({
            type: 'success',
            message: t('auth:action.copy_address', {
              postProcess: 'capitalizeFirstChar',
            }),
          });
          setOpenSnack(true);
        })
        .catch(() => {
          setInfoSnack({
            type: 'error',
            message: t('question:message.error.copy_clipboard', {
              postProcess: 'capitalizeFirstChar',
            }),
          });
          setOpenSnack(true);
        });
    }
  };

  const handleJoinGroup = async (group, isOpen) => {
    try {
      const groupId = group.groupId;

      const fee = await getFee('JOIN_GROUP');

      await show({
        message: t('core:message.question.perform_transaction', {
          action: 'JOIN_GROUP',
          postProcess: 'capitalizeFirstChar',
        }),
        publishFee: fee.fee + ' QORT',
      });
      setIsLoading(true);

      await new Promise((res, rej) => {
        window
          .sendMessage('joinGroup', {
            groupId,
          })
          .then((response) => {
            if (!response?.error) {
              setInfoSnack({
                type: 'success',
                message: t('group:message.success.group_join', {
                  postProcess: 'capitalizeFirstChar',
                }),
              });

              if (isOpen) {
                setTxList((prev) => [
                  {
                    ...response,
                    type: 'joined-group',
                    label: t('group:message.success.group_join_label', {
                      group_name: group?.groupName,
                      postProcess: 'capitalizeFirstChar',
                    }),
                    labelDone: t('group:message.success.group_join_label', {
                      group_name: group?.groupName,
                      postProcess: 'capitalizeFirstChar',
                    }),
                    done: false,
                    groupId,
                  },
                  ...prev,
                ]);
              } else {
                setTxList((prev) => [
                  {
                    ...response,
                    type: 'joined-group-request',
                    label: t('group:message.success.group_join_request', {
                      group_name: group?.groupName,
                      postProcess: 'capitalizeFirstChar',
                    }),
                    labelDone: t('group:message.success.group_join_outcome', {
                      group_name: group?.groupName,
                      postProcess: 'capitalizeFirstChar',
                    }),
                    done: false,
                    groupId,
                  },
                  ...prev,
                ]);
              }
              setOpenSnack(true);
              handleCloseDialog();
              res(response);
              return;
            } else {
              setInfoSnack({
                type: 'error',
                message: response?.error,
              });
              setOpenSnack(true);
              rej(response.error);
            }
          })
          .catch((error) => {
            setInfoSnack({
              type: 'error',
              message:
                error.message ||
                t('core:message.error.generic', {
                  postProcess: 'capitalizeFirstChar',
                }),
            });
            setOpenSnack(true);
            rej(error);
          });
      });
      setIsLoading(false);
    } catch (error) {
      console.log(error);
    } finally {
      setIsLoading(false);
    }
  };

  const rowRenderer = ({ index, key, parent, style }) => {
    if (index === visibleItems.length) {
      return (
        <div key={key} style={style}>
          <Box sx={{ alignItems: 'center', borderTop: `1px solid ${theme.palette.divider}`, display: 'flex', height: '100%', justifyContent: 'center' }}>
            <ButtonBase onClick={() => setVisibleCount((count) => Math.min(count + FIND_GROUPS_PAGE_SIZE, filteredItems.length))} sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: '7px', color: 'text.secondary', fontSize: 13.5, fontWeight: 650, minHeight: 34, px: 3.5, '&:hover': { backgroundColor: theme.palette.action.hover, color: 'text.primary' } }}>
              Load more
            </ButtonBase>
          </Box>
        </div>
      );
    }
    const group = visibleItems[index];
    const memberCount = group?.memberCount ?? 0;
    const openGroup = isOpenGroup(group);
    const publicActivity = openGroup
      ? publicActivityByGroup[String(group?.groupId)]
      : undefined;
    const ownerName = topGroupOwnerNames[String(group?.groupId)];
    const showRemoteAvatar = avatarEligibleGroupIds.has(String(group?.groupId)) && Boolean(ownerName);
    const avatarUrl = showRemoteAvatar
      ? `${getBaseApiReact()}/arbitrary/THUMBNAIL/${encodeURIComponent(ownerName)}/qortal_group_avatar_${group.groupId}?async=true`
      : undefined;
    const legacyLevel = getLegacyLevel(group?.created ?? group?.creationTimestamp ?? group?.createdAt);
    const communityLevel = getCommunityLevel(Number(memberCount) || 0);
    const level = getGroupLevel(legacyLevel, communityLevel);
    const levelColor = getGroupLevelColor(level);
    const createdDate = group?.created ? formatTimestamp(group.created) : '—';

    return (
      <div key={key} style={style}>
        <ListItem disablePadding sx={{ borderBottom: `1px solid ${theme.palette.divider}`, px: 0 }}>
          <ListItemButton
            onClick={() => handleOpenDialog(group)}
            sx={{
              borderRadius: 0,
              py: 0.9,
              px: 1,
              alignItems: 'center',
              gap: 1.2,
              minHeight: GROUP_ROW_HEIGHT,
              '&:hover': {
                bgcolor: theme.palette.action.hover,
              },
            }}
          >
            <Avatar
              alt=""
              imgProps={{ loading: 'lazy' }}
              src={avatarUrl}
              sx={{ backgroundColor: '#151a22', border: `1px solid ${theme.palette.divider}`, flexShrink: 0, height: 58, width: 58 }}
            >
              <Box alt="" component="img" src={Logo2} sx={{ height: 30, width: 30 }} />
            </Avatar>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                alignSelf: 'flex-start',
                flexShrink: 0,
                mr: 0,
                mt: 0.15,
              }}
            >
              {!openGroup ? (
                <LockIcon
                  sx={{
                    color: theme.palette.text.secondary,
                    fontSize: 18,
                  }}
                />
              ) : (
                <PublicRoundedIcon
                  sx={{
                    color: theme.palette.text.secondary,
                    fontSize: 18,
                  }}
                />
              )}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                sx={{
                  display: 'inline-block',
                  fontSize: 16,
                  fontWeight: 750,
                  color: theme.palette.text.primary,
                  lineHeight: '21px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {group?.groupName}
              </Typography>
              {level !== null && (
                <Tooltip title={`Group Level ${level} (${legacyLevel} legacy + ${communityLevel} community)`}>
                  <Box aria-label={`Group Level ${level}`} component="span" sx={{ alignItems: 'center', backgroundColor: levelColor, borderRadius: '50%', boxShadow: `0 2px 7px ${levelColor}55`, color: '#ffffff', display: 'inline-flex', fontSize: 12, fontWeight: 800, height: 28, justifyContent: 'center', ml: 0.8, verticalAlign: 'middle', width: 28 }}>
                    {level}
                  </Box>
                </Tooltip>
              )}
              {group?.description && (
                <Tooltip disableInteractive placement="top-start" title={group.description}>
                <Typography
                  variant="body2"
                  sx={{
                    color: theme.palette.text.secondary,
                  mt: 0.2,
                  fontSize: 13,
                  lineHeight: '18px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'block',
                }}
                >
                  {group.description}
                </Typography>
                </Tooltip>
              )}
              <Typography
                sx={{
                  color: theme.palette.text.secondary,
                  opacity: 0.85,
                  display: 'none',
                  fontSize: 12,
                  mt: 0.25,
                  lineHeight: 1.4,
                }}
              >
                {memberCount} {t('group:group.member', { count: memberCount })}
                {' • '}
                {t('group:group.created', {
                  postProcess: 'capitalizeFirstChar',
                  date: createdDate,
                })}
              </Typography>
            </Box>
            <Box sx={{ color: 'text.secondary', display: { xs: 'none', sm: 'block' }, flex: '0 0 112px', textAlign: 'right' }}>
              {publicActivity ? (
                <>
                  <Typography noWrap sx={{ fontSize: 13, lineHeight: '18px' }}>
                    {formatMemberCount(publicActivity.activeAuthors7d)} active
                  </Typography>
                  <Typography noWrap sx={{ fontSize: 12, lineHeight: '17px', opacity: 0.8 }}>
                    {formatMemberCount(publicActivity.messages7d)} messages
                  </Typography>
                </>
              ) : (
                <Typography noWrap sx={{ fontSize: 13, lineHeight: '18px' }}>
                  {formatMemberCount(memberCount)} {memberCount === 1 ? 'member' : 'members'}
                </Typography>
              )}
            </Box>
            <ButtonBase
              aria-label={`${openGroup ? 'Join' : 'Request to join'} ${group?.groupName}`}
              onClick={(event) => { event.stopPropagation(); handleJoinGroup(group, openGroup); }}
              sx={{ backgroundColor: openGroup ? 'primary.main' : 'transparent', border: `1px solid ${openGroup ? theme.palette.primary.main : theme.palette.divider}`, borderRadius: '7px', color: openGroup ? 'primary.contrastText' : 'text.secondary', flex: '0 0 84px', fontSize: 14, fontWeight: 650, minHeight: 42, px: 1.25, '&:hover': { backgroundColor: openGroup ? 'primary.dark' : theme.palette.action.hover, color: openGroup ? 'primary.contrastText' : 'text.primary' } }}
            >
              {openGroup ? 'Join' : 'Request'}
            </ButtonBase>
          </ListItemButton>
        </ListItem>
      </div>
    );
  };

  const isSelectedGroupOpen =
    selectedGroup != null && selectedGroup?.isOpen !== false;

  return (
    <>
      <Dialog
        open={selectedGroup != null}
        onClose={handleCloseDialog}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 3,
            maxWidth: 440,
            boxShadow: theme.shadows[12],
            overflow: 'hidden',
            bgcolor: theme.palette.background.default,
          },
        }}
        sx={{
          '& .MuiDialog-container': {
            alignItems: 'center',
            justifyContent: 'center',
          },
        }}
      >
        {selectedGroup && (
          <>
            <DialogTitle
              sx={{
                fontWeight: 700,
                fontSize: '1.25rem',
                letterSpacing: '-0.02em',
                py: 2,
                px: 2.5,
                borderBottom: `1px solid ${theme.palette.divider}`,
              }}
            >
              <Typography
                component="span"
                sx={{
                  color: theme.palette.text.secondary,
                  fontWeight: 500,
                  fontSize: '0.875rem',
                  display: 'block',
                  mb: 0.5,
                }}
              >
                {t('core:action.join', {
                  postProcess: 'capitalizeFirstChar',
                })}
              </Typography>
              <Typography
                component="span"
                sx={{
                  wordBreak: 'break-word',
                  lineHeight: 1.3,
                }}
              >
                {selectedGroup.groupName}
              </Typography>
            </DialogTitle>
            <DialogContent sx={{ px: 2.5, pt: 3, pb: 2 }}>
              <Spacer height="15px" />
              {ownerLoading && (
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{
                    mb: 2,
                    py: 1.5,
                    px: 2,
                    borderRadius: 2,
                    bgcolor: theme.palette.action.hover,
                  }}
                >
                  <CircularProgress size={18} thickness={4} />
                  <Typography variant="body2" color="text.secondary">
                    {t('core:loading.generic', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </Typography>
                </Stack>
              )}

              {selectedGroup.isOpen === false && (
                <Typography
                  variant="body2"
                  sx={{
                    color: theme.palette.text.secondary,
                    mb: 2,
                    lineHeight: 1.6,
                  }}
                >
                  {t('group:message.generic.closed_group', {
                    postProcess: 'capitalizeFirstChar',
                  })}
                </Typography>
              )}

              <Stack spacing={2}>
                <Box>
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={0.75}
                    sx={{ mb: 1.5 }}
                  >
                    <DescriptionIcon
                      sx={{
                        fontSize: 18,
                        color: theme.palette.text.secondary,
                      }}
                    />
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: 600,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: theme.palette.text.secondary,
                      }}
                    >
                      {t('group:group.description', {
                        postProcess: 'capitalizeFirstChar',
                      })}
                    </Typography>
                  </Stack>
                  <Typography
                    variant="body2"
                    sx={{
                      color: theme.palette.text.primary,
                      lineHeight: 1.5,
                      pl: 2.75,
                    }}
                  >
                    {selectedGroup.description &&
                    selectedGroup.description.trim() !== ''
                      ? selectedGroup.description
                      : '—'}
                  </Typography>
                </Box>

                <Box>
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={0.75}
                    sx={{ mb: 0.5 }}
                  >
                    <GroupIcon
                      sx={{
                        fontSize: 18,
                        color: theme.palette.text.secondary,
                      }}
                    />
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: 600,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: theme.palette.text.secondary,
                      }}
                    >
                      {t('group:group.member_number', {
                        postProcess: 'capitalizeFirstChar',
                      })}
                    </Typography>
                  </Stack>
                  <Typography
                    variant="body2"
                    sx={{
                      color: theme.palette.text.primary,
                      pl: 2.75,
                    }}
                  >
                    {selectedGroup.memberCount ?? 0}{' '}
                    {t('group:group.member', {
                      count: selectedGroup.memberCount ?? 0,
                    })}
                  </Typography>
                </Box>

                <Box>
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={0.75}
                    sx={{ mb: 1.5 }}
                  >
                    <PersonIcon
                      sx={{
                        fontSize: 18,
                        color: theme.palette.text.secondary,
                      }}
                    />
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: 600,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: theme.palette.text.secondary,
                      }}
                    >
                      {t('group:group.owner', {
                        postProcess: 'capitalizeFirstChar',
                      })}
                    </Typography>
                  </Stack>
                  <Box sx={{ pl: 2.75 }}>
                    {ownerLoading ? (
                      <Stack spacing={0.75}>
                        <Skeleton
                          variant="text"
                          width="40%"
                          height={20}
                          sx={{ bgcolor: theme.palette.action.hover }}
                        />
                        <Skeleton
                          variant="text"
                          width="90%"
                          height={16}
                          sx={{ bgcolor: theme.palette.action.hover }}
                        />
                      </Stack>
                    ) : (
                      <>
                        {ownerPrimaryName && (
                          <Typography
                            variant="body2"
                            sx={{
                              fontWeight: 500,
                              color: theme.palette.text.primary,
                              mb: 0.25,
                            }}
                          >
                            {ownerPrimaryName}
                          </Typography>
                        )}
                        {ownerAddress && (
                          <Stack
                            direction="row"
                            alignItems="center"
                            spacing={0.5}
                            flexWrap="wrap"
                          >
                            <Typography
                              variant="body2"
                              sx={{
                                color: theme.palette.text.secondary,
                                fontSize: '0.78rem',
                                fontWeight: 600,
                                letterSpacing: '-0.01em',
                                wordBreak: 'break-all',
                              }}
                            >
                              {ownerAddress}
                            </Typography>
                            <IconButton
                              size="small"
                              onClick={handleCopyAddress}
                              aria-label={t('auth:action.copy_address', {
                                postProcess: 'capitalizeFirstChar',
                              })}
                              sx={{
                                color: theme.palette.text.secondary,
                                '&:hover': {
                                  color: theme.palette.primary.main,
                                  bgcolor: theme.palette.action.selected,
                                },
                              }}
                            >
                              <ContentCopyIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        )}
                        {!ownerAddress && !ownerLoading && (
                          <Typography variant="body2" color="text.secondary">
                            —
                          </Typography>
                        )}
                      </>
                    )}
                  </Box>
                </Box>
              </Stack>

              <Divider sx={{ mt: 3.5, mb: 2 }} />

              <LoadingButton
                fullWidth
                loading={isLoading}
                loadingPosition="start"
                variant="contained"
                color="primary"
                onClick={() =>
                  handleJoinGroup(selectedGroup, isSelectedGroupOpen)
                }
                sx={{
                  py: 1.5,
                  borderRadius: 2,
                  textTransform: 'uppercase',
                  fontWeight: 600,
                  letterSpacing: '0.1em',
                  fontSize: '0.8125rem',
                  boxShadow: theme.shadows[2],
                  '&:hover': {
                    boxShadow: theme.shadows[4],
                  },
                }}
              >
                {t('group:action.join_group', {
                  postProcess: 'capitalizeFirstChar',
                })}
              </LoadingButton>
            </DialogContent>
          </>
        )}
      </Dialog>

      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          gap: 2,
          minHeight: 0,
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.35 }}>
          <TextField
            placeholder="Search by group name"
            variant="outlined"
            fullWidth
            value={inputValue}
            onChange={handleChange}
            InputProps={{
              startAdornment: <InputAdornment position="start"><SearchRoundedIcon sx={{ color: 'text.secondary', fontSize: 20 }} /></InputAdornment>,
              endAdornment: inputValue ? <InputAdornment position="end"><IconButton aria-label="Clear search" onClick={() => setInputValue('')} size="small"><CloseRoundedIcon fontSize="small" /></IconButton></InputAdornment> : undefined,
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                borderRadius: '8px',
                bgcolor: theme.palette.background.paper,
                fontSize: 16,
                minHeight: 48,
                px: 1.25,
                '&:hover .MuiOutlinedInput-notchedOutline': {
                  borderColor: theme.palette.action.hover,
                },
                '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                  borderWidth: 2,
                },
              },
            }}
          />
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
            {[
              { icon: <WhatshotRoundedIcon sx={{ fontSize: 20 }} />, label: 'Popular', selected: sortMode === 'popular', onClick: () => setSortMode('popular') },
              { icon: <ScheduleRoundedIcon sx={{ fontSize: 20 }} />, label: 'Newest', selected: sortMode === 'newest', onClick: () => setSortMode('newest') },
              { icon: <PublicRoundedIcon sx={{ fontSize: 20 }} />, label: 'Open', selected: showOpen, onClick: () => setShowOpen((current) => !current) },
              { icon: <LockIcon sx={{ fontSize: 20 }} />, label: 'Private', selected: showPrivate, onClick: () => setShowPrivate((current) => !current) },
            ].map((filter) => (
              <ButtonBase aria-pressed={filter.selected} key={filter.label} onClick={filter.onClick} sx={{ backgroundColor: filter.selected ? 'primary.main' : 'transparent', border: `1px solid ${filter.selected ? theme.palette.primary.main : theme.palette.divider}`, borderRadius: '8px', color: filter.selected ? 'primary.contrastText' : 'text.secondary', fontSize: 15, fontWeight: 600, gap: 0.9, height: 42, minWidth: 120, px: 1.6, '&:hover': { backgroundColor: filter.selected ? 'primary.dark' : theme.palette.action.hover } }}>{filter.icon}{filter.label}</ButtonBase>
            ))}
          </Box>
        </Box>

        <Box
          sx={{
            position: 'relative',
            width: '100%',
            flexGrow: 1,
            minHeight: 0,
          }}
        >
          <Box sx={{ alignItems: 'center', borderBottom: `1px solid ${theme.palette.divider}`, display: 'flex', justifyContent: 'space-between', mb: 0 }}>
            <Typography sx={{ fontSize: 18, fontWeight: 750, lineHeight: '25px', pb: 1.1 }}>Groups</Typography>
            <Typography sx={{ color: 'text.secondary', fontSize: 13, pb: 1.1 }}>{sortMode === 'popular' ? 'Sorted by Server Level' : 'Sorted by newest'}</Typography>
          </Box>
          {groupsLoading ? (
            <Stack
              alignItems="center"
              justifyContent="center"
              spacing={1.5}
              sx={{
                width: '100%',
                height: '100%',
                minHeight: 200,
              }}
            >
              <CircularProgress size={32} thickness={4} />
              <Typography variant="body2" color="text.secondary">
                {t('core:loading.generic', {
                  postProcess: 'capitalizeFirstChar',
                })}
              </Typography>
            </Stack>
          ) : filteredItems.length === 0 ? (
            <Stack
              alignItems="center"
              justifyContent="center"
              sx={{
                width: '100%',
                height: '100%',
                minHeight: 200,
              }}
            >
              <Typography variant="body2" color="text.secondary">
                {t('group:group.no_groups_found', {
                  postProcess: 'capitalizeFirstChar',
                })}
              </Typography>
            </Stack>
          ) : (
            <AutoSizer>
              {({ height, width }) => (
                <List
                  ref={listRef}
                  width={width}
                  height={height}
                  rowCount={visibleItems.length + (visibleItems.length < filteredItems.length ? 1 : 0)}
                  rowHeight={({ index }) => index === visibleItems.length ? 60 : GROUP_ROW_HEIGHT}
                  rowRenderer={rowRenderer}
                />
              )}
            </AutoSizer>
          )}
        </Box>
      </Box>
    </>
  );
};
