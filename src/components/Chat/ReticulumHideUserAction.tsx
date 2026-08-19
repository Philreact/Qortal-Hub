import { useEffect, useState } from 'react';
import {
  CircularProgress,
  ListItemIcon,
  ListItemText,
  MenuItem,
} from '@mui/material';
import VisibilityOffRoundedIcon from '@mui/icons-material/VisibilityOffRounded';
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded';
import { useTranslation } from 'react-i18next';

export type ReticulumSilenceContext = {
  disabled?: boolean;
  groupId?: number;
  ownerAddress: string;
  scopeType: 'dm' | 'group';
};

type ReticulumHideUserActionProps = {
  address: string;
  context: ReticulumSilenceContext;
  handleClose: () => void;
  initiallyShowDurations?: boolean;
  menuItemSx?: object;
};

export const ReticulumHideUserAction = ({
  address,
  context,
  handleClose,
  initiallyShowDurations = false,
  menuItemSx,
}: ReticulumHideUserActionProps) => {
  const { t } = useTranslation(['reticulum']);
  const [silence, setSilence] = useState<any>(null);
  const [showDurations, setShowDurations] = useState(initiallyShowDurations);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (
      context?.disabled ||
      !address ||
      !context?.ownerAddress ||
      !context?.scopeType
    ) {
      return;
    }
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
  }, [
    address,
    context?.disabled,
    context?.groupId,
    context?.ownerAddress,
    context?.scopeType,
  ]);

  if (context?.disabled) {
    return (
      <MenuItem disabled sx={menuItemSx}>
        <ListItemIcon>
          <VisibilityOffRoundedIcon />
        </ListItemIcon>
        <ListItemText
          primary={t('reticulum:hide_user.hide', {
            postProcess: 'capitalizeFirstChar',
          })}
        />
      </MenuItem>
    );
  }

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
        throw new Error(
          result?.error ||
            t('reticulum:hide_user.error_hide', {
              postProcess: 'capitalizeFirstChar',
            })
        );
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
        throw new Error(
          result?.error ||
            t('reticulum:hide_user.error_unhide', {
              postProcess: 'capitalizeFirstChar',
            })
        );
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
      <MenuItem disabled={isLoading} onClick={clearSilence} sx={menuItemSx}>
        <ListItemIcon>
          {isLoading ? (
            <CircularProgress size={17} />
          ) : (
            <VisibilityRoundedIcon />
          )}
        </ListItemIcon>
        <ListItemText
          primary={t('reticulum:hide_user.unhide', {
            postProcess: 'capitalizeFirstChar',
          })}
        />
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
        sx={menuItemSx}
      >
        <ListItemIcon>
          <VisibilityOffRoundedIcon />
        </ListItemIcon>
        <ListItemText
          primary={t('reticulum:hide_user.hide', {
            postProcess: 'capitalizeFirstChar',
          })}
        />
      </MenuItem>
    );
  }

  return (
    <>
      <MenuItem
        disabled={isLoading}
        onClick={() => applySilence(60 * 60 * 1000)}
        sx={menuItemSx}
      >
        <ListItemIcon>
          <VisibilityOffRoundedIcon />
        </ListItemIcon>
        <ListItemText
          primary={t('reticulum:hide_user.for_1_hour', {
            postProcess: 'capitalizeFirstChar',
          })}
        />
      </MenuItem>
      <MenuItem
        disabled={isLoading}
        onClick={() => applySilence(24 * 60 * 60 * 1000)}
        sx={menuItemSx}
      >
        <ListItemIcon>
          <VisibilityOffRoundedIcon />
        </ListItemIcon>
        <ListItemText
          primary={t('reticulum:hide_user.for_24_hours', {
            postProcess: 'capitalizeFirstChar',
          })}
        />
      </MenuItem>
      <MenuItem
        disabled={isLoading}
        onClick={() => applySilence(null)}
        sx={menuItemSx}
      >
        <ListItemIcon>
          {isLoading ? (
            <CircularProgress size={17} />
          ) : (
            <VisibilityOffRoundedIcon />
          )}
        </ListItemIcon>
        <ListItemText
          primary={t('reticulum:hide_user.until_unhidden', {
            postProcess: 'capitalizeFirstChar',
          })}
        />
      </MenuItem>
    </>
  );
};
