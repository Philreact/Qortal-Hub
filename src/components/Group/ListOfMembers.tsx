import {
  Avatar,
  Box,
  ListItem,
  ListItemAvatar,
  ListItemButton,
  ListItemText,
  Popover,
  Typography,
  useTheme,
} from '@mui/material';
import { useMemo, useRef, useState } from 'react';
import { AutoSizer, List } from 'react-virtualized';
import { LoadingButton } from '@mui/lab';
import { getFee } from '../../background/background.ts';
import { getBaseApiReact } from '../../App';
import { useTranslation } from 'react-i18next';
import { useOnlineAddresses } from '../../hooks/usePresence';
import { useAtomValue } from 'jotai';
import { statusMapAtom } from '../../atoms/presence';
import { PresenceStatusBadge } from '../common/PresenceStatusBadge';
import { getFallbackAvatarOutlineSx } from '../Chat/clickableAvatarStyles';
import { hasInvisibleCharacters } from '../../utils/hasInvisibleCharacters';

const MEMBER_ROW_HEIGHT = 64;

const ListOfMembers = ({
  members,
  groupId,
  setInfoSnack,
  setOpenSnack,
  isAdmin,
  isOwner,
  show,
  ownerAddress,
  compact = false,
}) => {
  const [popoverAnchor, setPopoverAnchor] = useState(null); // Track which list item the popover is anchored to
  const [openPopoverIndex, setOpenPopoverIndex] = useState(null); // Track which list item has the popover open
  const [isLoadingKick, setIsLoadingKick] = useState(false);
  const [isLoadingBan, setIsLoadingBan] = useState(false);
  const [isLoadingMakeAdmin, setIsLoadingMakeAdmin] = useState(false);
  const [isLoadingRemoveAdmin, setIsLoadingRemoveAdmin] = useState(false);
  const theme = useTheme();
  const { t } = useTranslation([
    'auth',
    'core',
    'group',
    'question',
    'tutorial',
  ]);
  const listRef = useRef(null);
  const onlineAddresses = useOnlineAddresses();
  const statusMap = useAtomValue(statusMapAtom);
  const sortedMembers = useMemo(() => {
    return [...(members || [])].sort((a, b) => {
      const aIsOwner = a?.member === ownerAddress;
      const bIsOwner = b?.member === ownerAddress;
      if (aIsOwner !== bIsOwner) return aIsOwner ? -1 : 1;

      const aIsAdmin = Boolean(a?.isAdmin);
      const bIsAdmin = Boolean(b?.isAdmin);
      if (aIsAdmin !== bIsAdmin) return aIsAdmin ? -1 : 1;

      const aLabel = (a?.primaryName || a?.name || a?.member || '').toString();
      const bLabel = (b?.primaryName || b?.name || b?.member || '').toString();
      return aLabel.localeCompare(bLabel, undefined, {
        sensitivity: 'base',
      });
    });
  }, [members, ownerAddress]);

  const handlePopoverOpen = (event, index) => {
    setPopoverAnchor(event.currentTarget);
    setOpenPopoverIndex(index);
  };

  const handlePopoverClose = () => {
    setPopoverAnchor(null);
    setOpenPopoverIndex(null);
  };

  const handleKick = async (address) => {
    try {
      const fee = await getFee('GROUP_KICK');
      await show({
        message: t('core:message.question.perform_transaction', {
          action: 'GROUP_KICK',
          postProcess: 'capitalizeFirstChar',
        }),
        publishFee: fee.fee + ' QORT',
      });

      setIsLoadingKick(true);
      new Promise((res, rej) => {
        window
          .sendMessage('kickFromGroup', {
            groupId,
            qortalAddress: address,
          })
          .then((response) => {
            if (!response?.error) {
              setInfoSnack({
                type: 'success',
                message: t('group:message.success.group_kick', {
                  postProcess: 'capitalizeFirstChar',
                }),
              });
              setOpenSnack(true);
              handlePopoverClose();
              res(response);
              return;
            }
            setInfoSnack({
              type: 'error',
              message: response?.error,
            });
            setOpenSnack(true);
            rej(response.error);
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
    } catch (error) {
      console.log(error);
    } finally {
      setIsLoadingKick(false);
    }
  };

  const handleBan = async (address) => {
    try {
      const fee = await getFee('GROUP_BAN');

      await show({
        message: t('core:message.question.perform_transaction', {
          action: 'GROUP_BAN',
          postProcess: 'capitalizeFirstChar',
        }),
        publishFee: fee.fee + ' QORT',
      });

      setIsLoadingBan(true);

      await new Promise((res, rej) => {
        window
          .sendMessage('banFromGroup', {
            groupId,
            qortalAddress: address,
            rBanTime: 0,
          })
          .then((response) => {
            if (!response?.error) {
              setInfoSnack({
                type: 'success',
                message: t('group:message.success.group_ban', {
                  postProcess: 'capitalizeFirstChar',
                }),
              });
              setOpenSnack(true);
              handlePopoverClose();
              res(response);
              return;
            }
            setInfoSnack({
              type: 'error',
              message: response?.error,
            });
            setOpenSnack(true);
            rej(response.error);
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
    } catch (error) {
      console.log(error);
    } finally {
      setIsLoadingBan(false);
    }
  };

  const makeAdmin = async (address) => {
    try {
      const fee = await getFee('ADD_GROUP_ADMIN');
      await show({
        message: t('core:message.question.perform_transaction', {
          action: 'ADD_GROUP_ADMIN',
          postProcess: 'capitalizeFirstChar',
        }),
        publishFee: fee.fee + ' QORT',
      });
      setIsLoadingMakeAdmin(true);
      await new Promise((res, rej) => {
        window
          .sendMessage('makeAdmin', {
            groupId,
            qortalAddress: address,
          })
          .then((response) => {
            if (!response?.error) {
              setInfoSnack({
                type: 'success',
                message: t('group:message.success.group_member_admin', {
                  postProcess: 'capitalizeFirstChar',
                }),
              });
              setOpenSnack(true);
              handlePopoverClose();
              res(response);
              return;
            }
            setInfoSnack({
              type: 'error',
              message: response?.error,
            });
            setOpenSnack(true);
            rej(response.error);
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
    } catch (error) {
      console.log(error);
    } finally {
      setIsLoadingMakeAdmin(false);
    }
  };

  const removeAdmin = async (address) => {
    try {
      const fee = await getFee('REMOVE_GROUP_ADMIN');
      await show({
        message: t('core:message.question.perform_transaction', {
          action: 'REMOVE_GROUP_ADMIN',
          postProcess: 'capitalizeFirstChar',
        }),
        publishFee: fee.fee + ' QORT',
      });
      setIsLoadingRemoveAdmin(true);
      await new Promise((res, rej) => {
        window
          .sendMessage('removeAdmin', {
            groupId,
            qortalAddress: address,
          })
          .then((response) => {
            if (!response?.error) {
              setInfoSnack({
                type: 'success',
                message: t('group:message.success.group_remove_member', {
                  postProcess: 'capitalizeFirstChar',
                }),
              });
              setOpenSnack(true);
              handlePopoverClose();
              res(response);
              return;
            }
            setInfoSnack({
              type: 'error',
              message: response?.error,
            });
            setOpenSnack(true);
            rej(response.error);
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
    } catch (error) {
      console.log(error);
    } finally {
      setIsLoadingRemoveAdmin(false);
    }
  };

  const rowRenderer = ({ index, key, style }) => {
    const member = sortedMembers[index];
    const memberLabel = compact
      ? member?.primaryName || member?.name || 'Member'
      : member?.primaryName || member?.member;
    const hasUnsafeMemberName = Boolean(
      member?.primaryName && hasInvisibleCharacters(member.primaryName)
    );
    const popoverWidth =
      popoverAnchor?.getBoundingClientRect?.().width || (compact ? 240 : 325);

    return (
      <div key={key} style={style}>
        {isOwner && (
          <Popover
            open={openPopoverIndex === index}
            anchorEl={popoverAnchor}
            onClose={handlePopoverClose}
            transformOrigin={{
              vertical: 'top',
              horizontal: 'left',
            }}
            anchorOrigin={{
              vertical: 'bottom',
              horizontal: 'left',
            }}
            slotProps={{
              paper: {
                sx: {
                  backgroundColor: theme.palette.background.paper,
                  border: `1px solid ${theme.palette.divider}`,
                  borderRadius: '8px',
                  boxShadow: theme.shadows[8],
                  mt: 0.5,
                  overflow: 'hidden',
                  width: popoverWidth,
                },
              },
            }}
          >
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0.25,
                p: 0.5,
              }}
            >
              {isOwner && (
                <>
                  <LoadingButton
                    fullWidth
                    loading={isLoadingKick}
                    loadingPosition="start"
                    onClick={() => handleKick(member?.member)}
                    sx={{
                      borderRadius: '6px',
                      color: 'text.primary',
                      justifyContent: 'flex-start',
                      px: 1.25,
                      textTransform: 'none',
                    }}
                    variant="text"
                  >
                    {t('group:action.kick_member', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </LoadingButton>

                  <LoadingButton
                    fullWidth
                    loading={isLoadingBan}
                    loadingPosition="start"
                    onClick={() => handleBan(member?.member)}
                    sx={{
                      borderRadius: '6px',
                      color: 'error.main',
                      justifyContent: 'flex-start',
                      px: 1.25,
                      textTransform: 'none',
                    }}
                    variant="text"
                  >
                    {t('group:action.ban', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </LoadingButton>

                  <LoadingButton
                    fullWidth
                    loading={isLoadingMakeAdmin}
                    loadingPosition="start"
                    onClick={() => makeAdmin(member?.member)}
                    sx={{
                      borderRadius: '6px',
                      color: 'text.primary',
                      justifyContent: 'flex-start',
                      px: 1.25,
                      textTransform: 'none',
                    }}
                    variant="text"
                  >
                    {t('group:action.make_admin', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </LoadingButton>

                  <LoadingButton
                    fullWidth
                    loading={isLoadingRemoveAdmin}
                    loadingPosition="start"
                    onClick={() => removeAdmin(member?.member)}
                    sx={{
                      borderRadius: '6px',
                      color: 'text.primary',
                      justifyContent: 'flex-start',
                      px: 1.25,
                      textTransform: 'none',
                    }}
                    variant="text"
                  >
                    {t('group:action.remove_admin', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </LoadingButton>
                </>
              )}
            </Box>
          </Popover>
        )}

        <ListItem key={member?.member} disablePadding>
          <ListItemButton
            onClick={
              isOwner ? (event) => handlePopoverOpen(event, index) : undefined
            }
            sx={{
              borderRadius: compact ? '6px' : undefined,
              cursor: isOwner ? 'pointer' : 'default',
              minHeight: compact ? 50 : undefined,
              px: compact ? 1 : undefined,
              py: compact ? 0.5 : undefined,
            }}
          >
            <ListItemAvatar sx={{ minWidth: compact ? 42 : undefined }}>
              <PresenceStatusBadge
                online={onlineAddresses.has(member?.member)}
                status={statusMap.get(member?.member) ?? null}
              >
                <Avatar
                  alt={memberLabel}
                  sx={{
                    height: compact ? 34 : undefined,
                    width: compact ? 34 : undefined,
                    ...(!member?.primaryName
                      ? getFallbackAvatarOutlineSx(theme)
                      : {}),
                  }}
                  src={
                    member?.primaryName
                      ? `${getBaseApiReact()}/arbitrary/THUMBNAIL/${member?.primaryName}/qortal_avatar?async=true`
                      : ''
                  }
                />
              </PresenceStatusBadge>
            </ListItemAvatar>

            <ListItemText
              id={memberLabel}
              primary={memberLabel}
              primaryTypographyProps={{
                sx: {
                  color: 'text.primary',
                  fontSize: compact ? 13 : undefined,
                  fontWeight: compact ? 700 : undefined,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  ...(hasUnsafeMemberName
                    ? {
                        textDecorationLine: 'line-through',
                        textDecorationThickness: '2px',
                        textDecorationColor: theme.palette.error.main,
                      }
                    : {}),
                },
              }}
            />
            {(member?.isAdmin || member?.member === ownerAddress) && (
              <Typography
                sx={{
                  color: theme.palette.text.primary,
                  marginLeft: 'auto',
                  fontSize: compact ? 10 : undefined,
                  fontWeight: compact ? 800 : undefined,
                }}
              >
                {member?.member === ownerAddress
                  ? t('group:group.owner', {
                      postProcess: 'capitalizeFirstChar',
                    })
                  : t('core:admin', {
                      postProcess: 'capitalizeFirstChar',
                    })}
              </Typography>
            )}
          </ListItemButton>
        </ListItem>
      </div>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {!compact && (
        <p>
          {t('core:list.members', {
            postProcess: 'capitalizeFirstChar',
          })}
        </p>
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 1,
          height: compact ? '100%' : '500px',
          minHeight: 0,
          position: 'relative',
          width: '100%',
        }}
      >
        <AutoSizer>
          {({ height, width }) => (
            <List
              height={height}
              overscanRowCount={8}
              ref={listRef}
              rowCount={sortedMembers.length}
              rowHeight={compact ? 52 : MEMBER_ROW_HEIGHT}
              rowRenderer={rowRenderer}
              width={width}
            />
          )}
        </AutoSizer>
      </div>
    </div>
  );
};

export default ListOfMembers;
