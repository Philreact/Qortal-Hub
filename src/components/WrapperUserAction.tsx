import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Popover,
  Button,
  Box,
  CircularProgress,
  Divider,
  ListItemIcon,
  ListItemText,
  MenuItem,
  useTheme,
} from '@mui/material';
import ChatBubbleOutlineRoundedIcon from '@mui/icons-material/ChatBubbleOutlineRounded';
import AccountBalanceWalletRoundedIcon from '@mui/icons-material/AccountBalanceWalletRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import PersonSearchRoundedIcon from '@mui/icons-material/PersonSearchRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import VisibilityOffRoundedIcon from '@mui/icons-material/VisibilityOffRounded';
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded';
import { executeEvent } from '../utils/events';
import { useBlockedAddresses } from '../hooks/useBlockUsers';
import { useAtom } from 'jotai';
import { isRunningPublicNodeAtom } from '../atoms/global';
import { useTranslation } from 'react-i18next';
import { CustomStyledMenu } from './ContextMenu';
import { ReticulumUserCard } from './Chat/ReticulumUserCard';
import type { ReticulumUserCardData } from './Chat/ReticulumUserCard';

export const WrapperUserAction = ({
  children,
  address,
  name,
  disabled,
  reticulumMenu = false,
  reticulumUserCard,
  reticulumSilenceContext,
  trigger = 'click',
  fullWidth = false,
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

  const [anchorEl, setAnchorEl] = useState(null);
  const [cardAnchorEl, setCardAnchorEl] = useState(null);
  const cardInstanceId = useRef(crypto.randomUUID?.() || `user-card-${Math.random()}`);

  const handleOpen = (event) => {
    if (trigger === 'contextMenu') event.preventDefault();
    event.stopPropagation(); // Prevent parent onClick from firing
    setAnchorEl(event.currentTarget);
  };

  // Handle closing the Popover
  const handleClose = useCallback(() => {
    setAnchorEl(null);
  }, []);

  const handleCardOpen = (event) => {
    event.stopPropagation();
    window.dispatchEvent(
      new CustomEvent('reticulum-user-card-open', {
        detail: cardInstanceId.current,
      })
    );
    setCardAnchorEl(event.currentTarget);
  };

  const handleCardClose = useCallback(() => {
    setCardAnchorEl(null);
  }, []);

  useEffect(() => {
    const closeOtherUserCards = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== cardInstanceId.current) {
        setCardAnchorEl(null);
      }
    };

    window.addEventListener('reticulum-user-card-open', closeOtherUserCards);
    return () => {
      window.removeEventListener('reticulum-user-card-open', closeOtherUserCards);
    };
  }, []);

  // Determine if the popover is open
  const open = Boolean(anchorEl);
  const id = open ? address || name : undefined;

  if (disabled) {
    return children;
  }

  return (
    <>
      <Box
        onClick={reticulumUserCard ? handleCardOpen : trigger === 'click' ? handleOpen : undefined}
        onContextMenu={trigger === 'contextMenu' ? handleOpen : undefined}
        sx={{
          alignItems: 'center',
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          cursor: 'pointer',
          display: fullWidth ? 'flex' : 'inline-flex',
          height: fullWidth ? 'auto' : 'fit-content',
          justifyContent: 'center',
          maxHeight: '100%', // Prevent flex shrink behavior in a flex container
          maxWidth: '100%', // Optional: Limit the width to avoid overflow
          padding: 0,
          width: fullWidth ? '100%' : 'fit-content',
        }}
      >
        {/* Render the child without altering dimensions */}
        {children}
      </Box>

      {reticulumUserCard && (
        <ReticulumUserCard
          anchorEl={cardAnchorEl}
          data={reticulumUserCard}
          onClose={handleCardClose}
        />
      )}

      {/* Reticulum uses the same menu surface as the group controls. */}
      {open && (
        reticulumMenu ? (
          <CustomStyledMenu
            id={id}
            reticulumMenu
            open={open}
            anchorEl={anchorEl}
            onClose={handleClose}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
            slotProps={{
              paper: {
                onClick: (event) => event.stopPropagation(),
                sx: {
                  // User actions intentionally keep their lighter surface.
                  backgroundColor: `${theme.palette.background.paper} !important`,
                  overflow: 'hidden',
                },
              },
            }}
          >
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              {/* Option 1: Message */}
              <MenuItem
                onClick={() => {
                  handleClose();
                  setTimeout(() => {
                    executeEvent('openDirectMessageInternal', { address, name });
                  }, 200);
                }}
                sx={reticulumMenuItemSx}
              >
                <ListItemIcon><ChatBubbleOutlineRoundedIcon /></ListItemIcon>
                <ListItemText primary="Send Message" />
              </MenuItem>

              <MenuItem
                onClick={() => {
                  executeEvent('openPaymentInternal', { address, name });
                  handleClose();
                }}
                sx={reticulumMenuItemSx}
              >
                <ListItemIcon><AccountBalanceWalletRoundedIcon /></ListItemIcon>
                <ListItemText primary="Send QORT" />
              </MenuItem>

              <MenuItem
                onClick={() => {
                  navigator.clipboard.writeText(address || '');
                  handleClose();
                }}
                sx={reticulumMenuItemSx}
              >
                <ListItemIcon><ContentCopyRoundedIcon /></ListItemIcon>
                <ListItemText primary="Copy Address" />
              </MenuItem>

              <MenuItem
                onClick={() => {
                  executeEvent('openUserLookupDrawer', {
                    addressOrName: name || address,
                  });
                  handleClose();
                }}
                sx={reticulumMenuItemSx}
              >
                <ListItemIcon><PersonSearchRoundedIcon /></ListItemIcon>
                <ListItemText primary="User Details" />
              </MenuItem>

              {reticulumSilenceContext && (
                <Divider sx={{ borderColor: theme.palette.divider, my: 0.45 }} />
              )}
              {reticulumSilenceContext && (
                <ReticulumHideUser
                  handleClose={handleClose}
                  address={address}
                  context={reticulumSilenceContext}
                />
              )}
            </Box>
          </CustomStyledMenu>
        ) : (
          <Popover
            id={id}
            open={open}
            anchorEl={anchorEl}
            onClose={handleClose}
            anchorOrigin={{
              vertical: 'bottom',
              horizontal: 'center',
            }}
            transformOrigin={{
              vertical: 'top',
              horizontal: 'center',
            }}
            slotProps={{
              paper: {
                onClick: (event) => event.stopPropagation(),
              },
            }}
          >
          <Box
            sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 2 }}
          >
            {/* Option 1: Message */}
            <Button
              variant="text"
              onClick={() => {
                handleClose();
                setTimeout(() => {
                  executeEvent('openDirectMessageInternal', {
                    address,
                    name,
                  });
                }, 200);
              }}
              sx={{
                color: theme.palette.text.primary,
                justifyContent: 'flex-start',
              }}
            >
              {t('core:message.message', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Button>

            {/* Option 2: Send QORT */}
            <Button
              variant="text"
              onClick={() => {
                executeEvent('openPaymentInternal', {
                  address,
                  name,
                });
                handleClose();
              }}
              sx={{
                color: theme.palette.text.primary,
                justifyContent: 'flex-start',
              }}
            >
              {t('core:action.send_qort', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Button>

            <Button
              variant="text"
              onClick={() => {
                navigator.clipboard.writeText(address || '');
                handleClose();
              }}
              sx={{
                color: theme.palette.text.primary,
                justifyContent: 'flex-start',
              }}
            >
              {t('auth:action.copy_address', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Button>

            <Button
              variant="text"
              onClick={() => {
                executeEvent('openUserLookupDrawer', {
                  addressOrName: name || address,
                });
                handleClose();
              }}
              sx={{
                color: theme.palette.text.primary,
                justifyContent: 'flex-start',
              }}
            >
              {t('core:user_lookup', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Button>

            {!isRunningPublicNode && (
              <BlockUser
                handleClose={handleClose}
                address={address}
                name={name}
              />
            )}
          </Box>
          </Popover>
        )
      )}
    </>
  );
};

const reticulumMenuItemSx = {
  borderRadius: '6px',
  fontSize: 13,
  fontWeight: 600,
  minHeight: 36,
  px: 1,
  py: 0.65,
  transition: 'background-color 120ms ease',
  '&:hover': { backgroundColor: 'action.hover' },
  '& .MuiListItemIcon-root': {
    color: 'text.secondary',
    minWidth: 30,
  },
  '& .MuiSvgIcon-root': { fontSize: 18 },
};

const BlockUser = ({ address, name, handleClose, reticulumMenu = false }) => {
  const [isAlreadyBlocked, setIsAlreadyBlocked] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const { isUserBlocked, addToBlockList, removeBlockFromList } =
    useBlockedAddresses(true);
  const theme = useTheme();
  const { t } = useTranslation([
    'auth',
    'core',
    'group',
    'question',
    'tutorial',
  ]);

  useEffect(() => {
    if (!address) return;
    setIsAlreadyBlocked(isUserBlocked(address, name));
  }, [address, setIsAlreadyBlocked, isUserBlocked, name]);

  const handleBlock = async () => {
    try {
      setIsLoading(true);
      executeEvent('blockUserFromOutside', { user: address });
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoading(false);
      handleClose();
    }
  };

  if (reticulumMenu) {
    return (
      <MenuItem
        disabled={isLoading}
        onClick={handleBlock}
        sx={{
          ...reticulumMenuItemSx,
          color: 'error.main',
          '& .MuiListItemIcon-root': { color: 'error.main', minWidth: 30 },
          '&:hover': { backgroundColor: 'rgba(239, 68, 68, 0.12)' },
        }}
      >
        <ListItemIcon>
          {isLoading ? <CircularProgress color="error" size={17} /> : <BlockRoundedIcon />}
        </ListItemIcon>
        <ListItemText primary={isAlreadyBlocked ? 'Unblock' : 'Block'} />
      </MenuItem>
    );
  }

  return (
    <Button
      variant="text"
      onClick={handleBlock}
      sx={{
        color: theme.palette.text.primary,
        gap: '10px',
        justifyContent: 'flex-start',
      }}
    >
      {(isAlreadyBlocked === null || isLoading) && (
        <CircularProgress color="secondary" size={24} />
      )}
      {isAlreadyBlocked &&
        t('auth:action.unblock_name', { postProcess: 'capitalizeFirstChar' })}
      {isAlreadyBlocked === false &&
        t('auth:action.block_name', { postProcess: 'capitalizeFirstChar' })}
    </Button>
  );
};

const ReticulumHideUser = ({ address, context, handleClose }) => {
  const [silence, setSilence] = useState<any>(null);
  const [showDurations, setShowDurations] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!address || !context?.ownerAddress || !context?.scopeType) return;
    void window.reticulumChat
      ?.getSilence?.(
        context.ownerAddress,
        address,
        context.scopeType,
        context.groupId
      )
      .then((value) => {
        if (!cancelled) setSilence(value);
      })
      .catch((error) => {
        console.error('[ReticulumChat] Failed to read silence state:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [address, context?.groupId, context?.ownerAddress, context?.scopeType]);

  const applySilence = async (durationMs: number | null) => {
    if (isLoading) return;
    try {
      setIsLoading(true);
      const result = await window.reticulumChat?.setSilence?.(
        context.ownerAddress,
        address,
        context.scopeType,
        durationMs,
        context.groupId
      );
      if (!result?.success) {
        throw new Error(result?.error || 'Unable to hide user');
      }
      handleClose();
    } catch (error) {
      console.error('[ReticulumChat] Failed to hide user:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const clearSilence = async () => {
    if (isLoading) return;
    try {
      setIsLoading(true);
      const result = await window.reticulumChat?.clearSilence?.(
        context.ownerAddress,
        address,
        context.scopeType,
        context.groupId
      );
      if (!result?.success) {
        throw new Error(result?.error || 'Unable to unhide user');
      }
      handleClose();
    } catch (error) {
      console.error('[ReticulumChat] Failed to unhide user:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (silence?.active) {
    return (
      <MenuItem disabled={isLoading} onClick={clearSilence} sx={reticulumMenuItemSx}>
        <ListItemIcon>
          {isLoading ? <CircularProgress size={17} /> : <VisibilityRoundedIcon />}
        </ListItemIcon>
        <ListItemText primary="Unhide" />
      </MenuItem>
    );
  }

  if (!showDurations) {
    return (
      <MenuItem
        disabled={isLoading}
        onClick={(event) => {
          event.stopPropagation();
          setShowDurations(true);
        }}
        sx={reticulumMenuItemSx}
      >
        <ListItemIcon><VisibilityOffRoundedIcon /></ListItemIcon>
        <ListItemText primary="Hide" />
      </MenuItem>
    );
  }

  return (
    <>
      <MenuItem disabled={isLoading} onClick={() => applySilence(60 * 60 * 1000)} sx={reticulumMenuItemSx}>
        <ListItemIcon><VisibilityOffRoundedIcon /></ListItemIcon>
        <ListItemText primary="Hide for 1 hour" />
      </MenuItem>
      <MenuItem disabled={isLoading} onClick={() => applySilence(24 * 60 * 60 * 1000)} sx={reticulumMenuItemSx}>
        <ListItemIcon><VisibilityOffRoundedIcon /></ListItemIcon>
        <ListItemText primary="Hide for 24 hours" />
      </MenuItem>
      <MenuItem disabled={isLoading} onClick={() => applySilence(null)} sx={reticulumMenuItemSx}>
        <ListItemIcon>
          {isLoading ? <CircularProgress size={17} /> : <VisibilityOffRoundedIcon />}
        </ListItemIcon>
        <ListItemText primary="Hide until unhidden" />
      </MenuItem>
    </>
  );
};
