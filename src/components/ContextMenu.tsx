import { useState, useRef, useMemo, useContext, useEffect } from 'react';
import {
  Box,
  Divider,
  ListItemIcon,
  Menu,
  MenuItem,
  Typography,
  styled,
  useTheme,
} from '@mui/material';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import NotificationsOffIcon from '@mui/icons-material/NotificationsOff';
import DoneAllRoundedIcon from '@mui/icons-material/DoneAllRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import UploadRoundedIcon from '@mui/icons-material/UploadRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import FolderRoundedIcon from '@mui/icons-material/FolderRounded';
import ForumRoundedIcon from '@mui/icons-material/ForumRounded';
import VisibilityOffRoundedIcon from '@mui/icons-material/VisibilityOffRounded';
import { useTranslation } from 'react-i18next';
import { executeEvent } from '../utils/events';
import { mutedGroupsAtom, txListAtom } from '../atoms/global';
import { useAtom, useSetAtom } from 'jotai';
import { getBaseApiReact, QORTAL_APP_CONTEXT } from '../App';
import { getFee } from '../background/background.ts';
import { QORTAL_PROTOCOL } from '../constants/constants.ts';
import { CustomizedSnackbars } from './Snackbar/Snackbar';
import { GroupScoreBadge } from './Group/ReticulumGroupLevel';
import { useReticulumGroupScore } from './Group/reticulumGroupScore';

export const CustomStyledMenu = styled(Menu, {
  shouldForwardProp: (prop) => prop !== 'reticulumMenu',
})(({ theme, reticulumMenu }) => ({
  '& .MuiPaper-root': {
    ...(reticulumMenu
      ? {
          backgroundImage: 'none',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: '8px',
          boxShadow: '0 12px 28px rgba(0, 0, 0, 0.28)',
          minWidth: 220,
          padding: theme.spacing(0.65),
        }
      : {
          borderRadius: '12px',
          boxShadow: '0 5px 15px rgba(0, 0, 0, 0.2)',
          padding: theme.spacing(1),
        }),
  },
  '& .MuiMenuItem-root': {
    fontSize: '13px',
    ...(reticulumMenu
      ? {
          borderRadius: '6px',
          fontWeight: 600,
          minHeight: 36,
          padding: theme.spacing(0.65, 1),
          transition: 'background-color 120ms ease',
        }
      : { transition: '0.3s background-color' }),
    '&:hover': {
      backgroundColor: theme.palette.action.hover,
    },
  },
}));

const ReticulumMenuGroupScore = ({
  groupId,
}: {
  groupId?: string | number;
}) => {
  const score = useReticulumGroupScore(groupId);
  if (!score) return null;
  return (
    <Box sx={{ px: 0.15, pt: 0.25 }}>
      <GroupScoreBadge score={score} size="menu" />
    </Box>
  );
};

export const ContextMenu = ({
  children,
  groupId,
  getUserSettings,
  myAddress = '',
  onMenuOpenChange,
  openOnClick = false,
  reticulumGroup = null,
  onChangeAvatar,
  onCreateCategory,
  onCreateChannel,
  onOpenHiddenUsers,
  showGroupInfo = true,
  showStandardActions = true,
}) => {
  const [menuPosition, setMenuPosition] = useState(null);
  const [groupInfo, setGroupInfo] = useState(null);
  const [openSnack, setOpenSnack] = useState(false);
  const [infoSnack, setInfoSnack] = useState(null);
  const longPressTimeout = useRef(null);
  const preventClick = useRef(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuInstanceIdRef = useRef(
    crypto.randomUUID?.() || `group-menu-${Math.random()}`
  );
  const theme = useTheme();
  const [mutedGroups] = useAtom(mutedGroupsAtom);
  const setTxList = useSetAtom(txListAtom);
  const { show } = useContext(QORTAL_APP_CONTEXT);
  const { t } = useTranslation(['core', 'group', 'reticulum']);
  const isMenuOpen = Boolean(menuPosition);

  const isMuted = useMemo(() => {
    return mutedGroups.includes(groupId);
  }, [mutedGroups, groupId]);

  const handleContextMenu = (event) => {
    if (!wrapperRef.current?.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();

    preventClick.current = true;

    if (menuPosition) {
      setMenuPosition(null);
      return;
    }

    executeEvent('reticulumGroupContextMenuOpened', {
      instanceId: menuInstanceIdRef.current,
    });

    setMenuPosition({
      mouseX: event.clientX,
      mouseY: event.clientY,
    });
  };

  const handleClick = (event) => {
    if (!openOnClick) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    executeEvent('reticulumGroupContextMenuOpened', {
      instanceId: menuInstanceIdRef.current,
    });
    setMenuPosition({
      mouseX: bounds.left,
      mouseY: bounds.bottom + 4,
    });
  };

  const handleTouchStart = (event) => {
    longPressTimeout.current = setTimeout(() => {
      preventClick.current = true;
      event.stopPropagation();
      setMenuPosition({
        mouseX: event.touches[0].clientX,
        mouseY: event.touches[0].clientY,
      });
    }, 500);
  };

  const handleTouchEnd = (event) => {
    clearTimeout(longPressTimeout.current);

    if (preventClick.current) {
      event.preventDefault();
      event.stopPropagation();
      preventClick.current = false;
    }
  };

  const handleSetGroupMute = () => {
    try {
      let value = [...mutedGroups];
      if (isMuted) {
        value = value.filter((group) => group !== groupId);
      } else {
        value.push(groupId);
      }
      window
        .sendMessage('addUserSettings', {
          keyValue: {
            key: 'mutedGroups',
            value,
          },
        })
        .then((response) => {
          if (response?.error) {
            console.error('Error adding user settings:', response.error);
          }
        })
        .catch((error) => {
          console.error(
            'Failed to add user settings:',
            error.message || 'An error occurred'
          );
        });

      setTimeout(() => {
        getUserSettings();
      }, 400);
    } catch (error) {
      console.error('Failed to update muted groups:', error);
    }
  };

  const handleClose = (e?) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setMenuPosition(null);
  };

  useEffect(() => {
    if (!reticulumGroup) return undefined;
    const closeOtherGroupMenu = (event: CustomEvent) => {
      if (event.detail?.instanceId !== menuInstanceIdRef.current) {
        setMenuPosition(null);
      }
    };
    document.addEventListener(
      'reticulumGroupContextMenuOpened',
      closeOtherGroupMenu as EventListener
    );
    return () => {
      document.removeEventListener(
        'reticulumGroupContextMenuOpened',
        closeOtherGroupMenu as EventListener
      );
    };
  }, [reticulumGroup]);

  useEffect(() => {
    onMenuOpenChange?.(isMenuOpen);
    return () => {
      if (isMenuOpen) onMenuOpenChange?.(false);
    };
  }, [isMenuOpen, onMenuOpenChange]);

  useEffect(() => {
    if (!menuPosition || !reticulumGroup) return undefined;
    const closeOnOutsideRightClick = (event: MouseEvent) => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      setMenuPosition(null);
    };
    document.addEventListener('contextmenu', closeOnOutsideRightClick, true);
    return () => {
      document.removeEventListener(
        'contextmenu',
        closeOnOutsideRightClick,
        true
      );
    };
  }, [menuPosition, reticulumGroup]);

  useEffect(() => {
    if (!menuPosition || !reticulumGroup?.groupId) return undefined;
    const controller = new AbortController();
    fetch(`${getBaseApiReact()}/groups/${reticulumGroup.groupId}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error('Unable to load group information');
        return response.json();
      })
      .then((data) => setGroupInfo(data))
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          console.error('Failed to load group information:', error);
        }
      });
    return () => controller.abort();
  }, [menuPosition, reticulumGroup?.groupId]);

  const displayedGroupInfo = useMemo(
    () => ({
      ...reticulumGroup,
      ...groupInfo,
      groupId: groupInfo?.groupId ?? reticulumGroup?.groupId ?? groupId,
      groupName:
        groupInfo?.groupName ??
        reticulumGroup?.groupName ??
        reticulumGroup?.name ??
        t('reticulum:group_fallback_name'),
      memberCount: groupInfo?.memberCount ?? reticulumGroup?.memberCount ?? '-',
    }),
    [groupId, groupInfo, reticulumGroup, t]
  );
  const isGroupOwner =
    reticulumGroup?.isOwner === true ||
    Boolean(
      myAddress &&
      displayedGroupInfo?.owner &&
      displayedGroupInfo.owner === myAddress
    );
  const isClosedGroup =
    displayedGroupInfo?.isOpen === false ||
    Number(displayedGroupInfo?.groupType) === 1 ||
    displayedGroupInfo?.groupType === 'CLOSED';
  const groupTypeLabel = t(
    isClosedGroup ? 'reticulum:group_type.closed' : 'reticulum:group_type.open',
    { postProcess: 'capitalizeFirstChar' }
  );

  const copyInviteLink = async (event) => {
    handleClose(event);
    try {
      const link = `${QORTAL_PROTOCOL}use-group/action-join/groupid-${displayedGroupInfo.groupId}`;
      await navigator.clipboard.writeText(link);
      setInfoSnack({
        type: 'success',
        message: t('group:context_menu.invite_link_copied'),
      });
      setOpenSnack(true);
    } catch (error) {
      setInfoSnack({
        type: 'error',
        message: t('group:context_menu.invite_link_copy_failed'),
      });
      setOpenSnack(true);
    }
  };

  const leaveGroup = async (event) => {
    handleClose(event);
    try {
      const fee = await getFee('LEAVE_GROUP');
      await show({
        message: t('core:message.question.perform_transaction', {
          action: 'LEAVE_GROUP',
          postProcess: 'capitalizeFirstChar',
        }),
        publishFee: `${fee.fee} QORT`,
      });
      const response = await window.sendMessage('leaveGroup', {
        groupId: displayedGroupInfo.groupId,
      });
      if (response?.error) throw new Error(response.error);
      setTxList((previous) => [
        {
          ...response,
          type: 'leave-group',
          label: t('group:message.success.group_leave_name', {
            group_name: displayedGroupInfo.groupName,
            postProcess: 'capitalizeFirstChar',
          }),
          labelDone: t('group:message.success.group_leave_label', {
            group_name: displayedGroupInfo.groupName,
            postProcess: 'capitalizeFirstChar',
          }),
          done: false,
          groupId: displayedGroupInfo.groupId,
        },
        ...previous,
      ]);
      setInfoSnack({
        type: 'success',
        message: t('group:message.success.group_leave', {
          postProcess: 'capitalizeFirstChar',
        }),
      });
      setOpenSnack(true);
    } catch (error) {
      if (error?.message) {
        setInfoSnack({ type: 'error', message: error.message });
        setOpenSnack(true);
      }
    }
  };

  return (
    <div
      ref={wrapperRef}
      onContextMenu={handleContextMenu}
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{ width: '100%', height: '100%' }}
    >
      {children}

      <CustomStyledMenu
        reticulumMenu={Boolean(reticulumGroup)}
        disableAutoFocus
        disableAutoFocusItem
        disableEnforceFocus
        disableRestoreFocus
        open={!!menuPosition}
        onClose={handleClose}
        anchorReference="anchorPosition"
        anchorPosition={
          menuPosition
            ? { top: menuPosition.mouseY, left: menuPosition.mouseX }
            : undefined
        }
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {showStandardActions && [
          <MenuItem
            key="mark-group-read"
            onClick={(e) => {
              handleClose(e);
              executeEvent('markAsRead', { groupId });
            }}
          >
            <ListItemIcon sx={{ minWidth: '32px' }}>
              <MailOutlineIcon
                sx={{ color: theme.palette.text.primary }}
                fontSize="small"
              />
            </ListItemIcon>
            <Typography variant="inherit" sx={{ fontSize: '14px' }}>
              {t('group:context_menu.mark_as_read')}
            </Typography>
          </MenuItem>,
          <MenuItem
            key="mute-group"
            onClick={(e) => {
              handleClose(e);
              handleSetGroupMute();
            }}
          >
            <ListItemIcon sx={{ minWidth: '32px' }}>
              <NotificationsOffIcon
                fontSize="small"
                sx={{
                  color: isMuted ? 'red' : theme.palette.text.primary,
                }}
              />
            </ListItemIcon>
            <Typography
              variant="inherit"
              sx={{ fontSize: '14px', color: isMuted && 'red' }}
            >
              {isMuted
                ? t('group:context_menu.unmute_push_notifications')
                : t('group:context_menu.mute_push_notifications')}
            </Typography>
          </MenuItem>,
          <MenuItem
            key="mark-all-groups-read"
            onClick={(e) => {
              handleClose(e);
              executeEvent('markAllMemberGroupsRead', {});
            }}
          >
            <ListItemIcon sx={{ minWidth: '32px' }}>
              <DoneAllRoundedIcon
                fontSize="small"
                sx={{ color: theme.palette.text.primary }}
              />
            </ListItemIcon>
            <Typography variant="inherit" sx={{ fontSize: '14px' }}>
              {t('group:context_menu.mark_all_read')}
            </Typography>
          </MenuItem>,
        ]}
        {reticulumGroup && (
          <MenuItem onClick={copyInviteLink}>
            <ListItemIcon sx={{ minWidth: '32px' }}>
              <ContentCopyRoundedIcon fontSize="small" />
            </ListItemIcon>
            <Typography variant="inherit" sx={{ fontSize: '14px' }}>
              {t('reticulum:copy_invite_link', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Typography>
          </MenuItem>
        )}
        {reticulumGroup && isGroupOwner && onChangeAvatar && (
          <MenuItem
            onClick={(event) => {
              handleClose(event);
              onChangeAvatar();
            }}
          >
            <ListItemIcon sx={{ minWidth: '32px' }}>
              <UploadRoundedIcon fontSize="small" />
            </ListItemIcon>
            <Typography variant="inherit" sx={{ fontSize: '14px' }}>
              {t('group:context_menu.change_group_avatar')}
            </Typography>
          </MenuItem>
        )}
        {reticulumGroup && onCreateChannel && (
          <MenuItem
            onClick={(event) => {
              handleClose(event);
              onCreateChannel();
            }}
          >
            <ListItemIcon sx={{ minWidth: '32px' }}>
              <ForumRoundedIcon fontSize="small" />
            </ListItemIcon>
            <Typography variant="inherit" sx={{ fontSize: '14px' }}>
              {t('group:context_menu.create_channel')}
            </Typography>
          </MenuItem>
        )}
        {reticulumGroup && onCreateCategory && (
          <MenuItem
            onClick={(event) => {
              handleClose(event);
              onCreateCategory();
            }}
          >
            <ListItemIcon sx={{ minWidth: '32px' }}>
              <FolderRoundedIcon fontSize="small" />
            </ListItemIcon>
            <Typography variant="inherit" sx={{ fontSize: '14px' }}>
              {t('group:context_menu.create_category')}
            </Typography>
          </MenuItem>
        )}
        {reticulumGroup && onOpenHiddenUsers && (
          <MenuItem
            onClick={(event) => {
              handleClose(event);
              onOpenHiddenUsers();
            }}
          >
            <ListItemIcon sx={{ minWidth: '32px' }}>
              <VisibilityOffRoundedIcon fontSize="small" />
            </ListItemIcon>
            <Typography variant="inherit" sx={{ fontSize: '14px' }}>
              {t('group:context_menu.hidden_users')}
            </Typography>
          </MenuItem>
        )}
        {reticulumGroup && !isGroupOwner && (
          <MenuItem onClick={leaveGroup} sx={{ color: 'error.main' }}>
            <ListItemIcon sx={{ color: 'inherit', minWidth: '32px' }}>
              <LogoutRoundedIcon fontSize="small" />
            </ListItemIcon>
            <Typography variant="inherit" sx={{ fontSize: '14px' }}>
              {t('group:context_menu.leave_group')}
            </Typography>
          </MenuItem>
        )}
        {reticulumGroup && (
          <MenuItem
            onClick={(event) => {
              handleClose(event);
              executeEvent('openReticulumGroupAbout', {
                group: displayedGroupInfo,
              });
            }}
            sx={{
              backgroundColor:
                theme.palette.mode === 'dark'
                  ? 'rgba(76, 141, 255, 0.12)'
                  : 'rgba(37, 99, 235, 0.1)',
              color: theme.palette.mode === 'dark' ? '#d7e6ff' : '#1e40af',
              '&:hover': {
                backgroundColor:
                  theme.palette.mode === 'dark'
                    ? 'rgba(76, 141, 255, 0.2)'
                    : 'rgba(37, 99, 235, 0.16)',
              },
            }}
          >
            <ListItemIcon
              sx={{
                color: theme.palette.mode === 'dark' ? '#a9c9ff' : '#1e40af',
                minWidth: '32px',
              }}
            >
              <InfoOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <Typography variant="inherit" sx={{ fontSize: '14px' }}>
              {t('group:context_menu.about_group')}
            </Typography>
          </MenuItem>
        )}
        {reticulumGroup && isMenuOpen && (
          <ReticulumMenuGroupScore groupId={displayedGroupInfo.groupId} />
        )}
        {reticulumGroup && showGroupInfo && (
          <>
            <Divider
              sx={{
                borderColor: theme.palette.divider,
                marginX: 0.75,
                marginY: 1,
              }}
            />
            <Box
              sx={{
                display: 'grid',
                gap: 0.75,
                minWidth: 230,
                px: 1.25,
                py: 0.5,
              }}
            >
              {[
                {
                  id: 'group-name',
                  label: t('group:group.name'),
                  value: displayedGroupInfo.groupName,
                },
                {
                  id: 'members',
                  label: t('group:group.member_other'),
                  value: displayedGroupInfo.memberCount,
                },
                {
                  id: 'group-type',
                  label: t('group:group.type'),
                  value: groupTypeLabel,
                },
                {
                  id: 'group-id',
                  label: t('group:group.id'),
                  value: displayedGroupInfo.groupId,
                },
              ].map(({ id, label, value }) => (
                <Box
                  key={id}
                  sx={{
                    alignItems: 'center',
                    display: 'flex',
                    gap: 2,
                    justifyContent: 'space-between',
                  }}
                >
                  <Typography
                    sx={{
                      color: 'text.secondary',
                      fontSize: 10,
                      fontWeight: 800,
                      textTransform: 'uppercase',
                    }}
                  >
                    {label}
                  </Typography>
                  <Typography
                    title={String(value ?? '-')}
                    sx={{
                      fontSize: 12,
                      fontWeight: 700,
                      maxWidth: 145,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {value ?? '-'}
                  </Typography>
                </Box>
              ))}
            </Box>
          </>
        )}
      </CustomStyledMenu>
      <CustomizedSnackbars
        open={openSnack}
        setOpen={setOpenSnack}
        info={infoSnack}
        setInfo={setInfoSnack}
      />
    </div>
  );
};
