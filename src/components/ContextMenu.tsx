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
import { useTranslation } from 'react-i18next';
import { executeEvent } from '../utils/events';
import { mutedGroupsAtom, txListAtom } from '../atoms/global';
import { useAtom, useSetAtom } from 'jotai';
import { getBaseApiReact, QORTAL_APP_CONTEXT } from '../App';
import { getFee } from '../background/background.ts';
import { QORTAL_PROTOCOL } from '../constants/constants.ts';
import { CustomizedSnackbars } from './Snackbar/Snackbar';

const CustomStyledMenu = styled(Menu)(({ theme }) => ({
  '& .MuiPaper-root': {
    borderRadius: '12px',
    padding: theme.spacing(1),
    boxShadow: '0 5px 15px rgba(0, 0, 0, 0.2)',
  },
  '& .MuiMenuItem-root': {
    fontSize: '14px',
    transition: '0.3s background-color',
    '&:hover': {
      backgroundColor: theme.palette.action.hover,
    },
  },
}));

export const ContextMenu = ({
  children,
  groupId,
  getUserSettings,
  myAddress = '',
  onMenuOpenChange,
  openOnClick = false,
  reticulumGroup = null,
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
  const { t } = useTranslation(['core', 'group']);
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
        'Group',
      memberCount:
        groupInfo?.memberCount ?? reticulumGroup?.memberCount ?? '-',
    }),
    [groupId, groupInfo, reticulumGroup]
  );
  const isGroupOwner =
    reticulumGroup?.isOwner === true ||
    Boolean(
      myAddress &&
        displayedGroupInfo?.owner &&
        displayedGroupInfo.owner === myAddress
    );

  const copyInviteLink = async (event) => {
    handleClose(event);
    try {
      const link = `${QORTAL_PROTOCOL}use-group/action-join/groupid-${displayedGroupInfo.groupId}`;
      await navigator.clipboard.writeText(link);
      setInfoSnack({ type: 'success', message: 'Invite link copied' });
      setOpenSnack(true);
    } catch (error) {
      setInfoSnack({ type: 'error', message: 'Could not copy invite link' });
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
              Copy Invite Link
            </Typography>
          </MenuItem>
        )}
        {reticulumGroup && !isGroupOwner && (
          <MenuItem onClick={leaveGroup} sx={{ color: 'error.main' }}>
            <ListItemIcon sx={{ color: 'inherit', minWidth: '32px' }}>
              <LogoutRoundedIcon fontSize="small" />
            </ListItemIcon>
            <Typography variant="inherit" sx={{ fontSize: '14px' }}>
              Leave Group
            </Typography>
          </MenuItem>
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
            <Box sx={{ display: 'grid', gap: 0.75, minWidth: 230, px: 1.25, py: 0.5 }}>
              {[
                ['Group ID', displayedGroupInfo.groupId],
                ['Group Name', displayedGroupInfo.groupName],
                ['Members', displayedGroupInfo.memberCount],
              ].map(([label, value]) => (
                <Box
                  key={label}
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
