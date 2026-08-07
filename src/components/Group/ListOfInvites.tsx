import { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Box,
  IconButton,
  ListItem,
  ListItemAvatar,
  ListItemButton,
  ListItemText,
  Popover,
  Tooltip,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import {
  AutoSizer,
  CellMeasurer,
  CellMeasurerCache,
  List,
} from 'react-virtualized';
import { getNameInfo } from './Group';
import { getFee } from '../../background/background.ts';
import { LoadingButton } from '@mui/lab';
import { getBaseApiReact } from '../../App';
import { useTranslation } from 'react-i18next';
import { hasInvisibleCharacters } from '../../utils/hasInvisibleCharacters';

export const getMemberInvites = async (groupNumber) => {
  const response = await fetch(
    `${getBaseApiReact()}/groups/invites/group/${groupNumber}?limit=0`
  );
  const groupData = await response.json();
  return groupData;
};

const getNames = async (listOfMembers, includeNoNames) => {
  const members = [];
  if (listOfMembers && Array.isArray(listOfMembers)) {
    for (const member of listOfMembers) {
      if (member.invitee) {
        const name = await getNameInfo(member.invitee);
        if (name) {
          members.push({ ...member, name });
        } else if (includeNoNames) {
          members.push({ ...member, name: name || '' });
        }
      }
    }
  }
  return members;
};

const cache = new CellMeasurerCache({
  fixedWidth: true,
  defaultHeight: 50,
});

export const ListOfInvites = ({
  groupId,
  setInfoSnack,
  setOpenSnack,
  show,
  compact = false,
}) => {
  const [invites, setInvites] = useState([]);
  const [popoverAnchor, setPopoverAnchor] = useState(null); // Track which list item the popover is anchored to
  const [openPopoverIndex, setOpenPopoverIndex] = useState(null); // Track which list item has the popover open
  const [isLoadingCancelInvite, setIsLoadingCancelInvite] = useState(false);
  const { t } = useTranslation([
    'auth',
    'core',
    'group',
    'question',
    'tutorial',
  ]);
  const listRef = useRef(null);

  const getInvites = async (groupId) => {
    try {
      const res = await getMemberInvites(groupId);
      const resWithNames = await getNames(res, true);
      setInvites(resWithNames);
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    if (groupId) {
      getInvites(groupId);
    }
  }, [groupId]);

  const handlePopoverOpen = (event, index) => {
    setPopoverAnchor(event.currentTarget);
    setOpenPopoverIndex(index);
  };

  const handlePopoverClose = () => {
    setPopoverAnchor(null);
    setOpenPopoverIndex(null);
  };

  const handleCancelInvitation = async (address) => {
    try {
      const fee = await getFee('CANCEL_GROUP_INVITE');

      await show({
        message: t('core:message.question.perform_transaction', {
          action: 'CANCEL_GROUP_INVITE',
          postProcess: 'capitalizeFirstChar',
        }),
        publishFee: fee.fee + ' QORT',
      });

      setIsLoadingCancelInvite(true);

      await new Promise((res, rej) => {
        window
          .sendMessage('cancelInvitationToGroup', {
            groupId,
            qortalAddress: address,
          })
          .then((response) => {
            if (!response?.error) {
              setInfoSnack({
                type: 'success',
                message: t('group:message.success.invitation_cancellation', {
                  postProcess: 'capitalizeFirstChar',
                }),
              });
              setOpenSnack(true);
              handlePopoverClose();
              setInvites((current) =>
                current.filter((invite) => invite?.invitee !== address)
              );
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
      setIsLoadingCancelInvite(false);
    }
  };

  const rowRenderer = ({ index, key, parent, style }) => {
    const member = invites[index];
    const memberLabel = member?.name || member?.invitee;
    const hasUnsafeMemberName = Boolean(
      member?.name && hasInvisibleCharacters(member.name)
    );

    return (
      <CellMeasurer
        key={key}
        cache={cache}
        parent={parent}
        columnIndex={0}
        rowIndex={index}
      >
        {({ measure }) => (
          <div style={style} onLoad={measure}>
            <ListItem disablePadding>
              {!compact && (
              <Popover
                open={openPopoverIndex === index}
                anchorEl={popoverAnchor}
                onClose={handlePopoverClose}
                anchorOrigin={{
                  vertical: 'bottom',
                  horizontal: 'center',
                }}
                transformOrigin={{
                  vertical: 'top',
                  horizontal: 'center',
                }}
                style={{ marginTop: '8px' }}
              >
                <Box
                  sx={{
                    alignItems: 'center',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    height: '250px',
                    padding: '10px',
                    width: '325px',
                  }}
                >
                  <LoadingButton
                    loading={isLoadingCancelInvite}
                    loadingPosition="start"
                    variant="contained"
                    onClick={() => handleCancelInvitation(member?.invitee)}
                  >
                    {t('core:action.cancel_invitation', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </LoadingButton>
                </Box>
              </Popover>
              )}

              <ListItemButton
                onClick={
                  compact ? undefined : (event) => handlePopoverOpen(event, index)
                }
                sx={{
                  borderRadius: compact ? '6px' : undefined,
                  minHeight: compact ? 48 : undefined,
                  px: compact ? 1 : undefined,
                  py: compact ? 0.5 : undefined,
                  '& .compact-row-action': {
                    opacity: 0,
                    pointerEvents: 'none',
                    transition: 'opacity 120ms ease',
                  },
                  '&:hover .compact-row-action': {
                    opacity: 1,
                    pointerEvents: 'auto',
                  },
                }}
              >
                <ListItemAvatar sx={{ minWidth: compact ? 40 : undefined }}>
                  <Avatar
                    alt={member?.name}
                    src={
                      member?.name
                        ? `${getBaseApiReact()}/arbitrary/THUMBNAIL/${member?.name}/qortal_avatar?async=true`
                        : ''
                    }
                    sx={{
                      height: compact ? 32 : undefined,
                      width: compact ? 32 : undefined,
                    }}
                  />
                </ListItemAvatar>

                <ListItemText
                  primary={memberLabel}
                  primaryTypographyProps={{
                    sx: {
                      fontSize: compact ? 13 : undefined,
                      fontWeight: compact ? 700 : undefined,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      textTransform: compact ? 'capitalize' : undefined,
                      whiteSpace: 'nowrap',
                      ...(hasUnsafeMemberName
                        ? {
                            textDecorationLine: 'line-through',
                            textDecorationThickness: '2px',
                            textDecorationColor: 'error.main',
                          }
                        : {}),
                    },
                  }}
                />
                {compact && (
                  <Tooltip title="Cancel Invitation">
                    <IconButton
                      className="compact-row-action"
                      disabled={isLoadingCancelInvite}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleCancelInvitation(member?.invitee);
                      }}
                      size="small"
                      sx={{
                        color: 'error.main',
                        flexShrink: 0,
                        height: 28,
                        width: 28,
                        '&:hover': {
                          backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        },
                      }}
                    >
                      <CloseRoundedIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                )}
              </ListItemButton>
            </ListItem>
          </div>
        )}
      </CellMeasurer>
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
          {t('group:invitees_list', {
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
              ref={listRef}
              width={width}
              height={height}
              rowCount={invites.length}
              rowHeight={compact ? 48 : cache.rowHeight}
              rowRenderer={rowRenderer}
              deferredMeasurementCache={compact ? undefined : cache}
            />
          )}
        </AutoSizer>
      </div>
    </div>
  );
};
