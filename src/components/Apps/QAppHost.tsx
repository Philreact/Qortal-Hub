import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  ListSubheader,
  Menu,
  MenuItem,
  Snackbar,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { AppViewer } from './AppViewer';
import { navigationControllerAtom } from '../../atoms/global';
import { executeEvent } from '../../utils/events';
import { handleSetGlobalApikey } from '../../utils/globalApi';
import LogoSelected from '../../assets/svgs/LogoSelected.svg';
import QortalHubIcon from '../../assets/sidebar/qortal-logo-official.png';
import { QortalRequestExtensionDialog } from '../App/QortalRequestExtensionDialog';
import { QAppScreenCapturePermission } from './QAppScreenCapturePermission';

type PermissionPrompt = {
  promptId: string;
  appName: string;
  payload: Record<string, unknown>;
};

type HostConfig = Awaited<
  ReturnType<
    NonNullable<NonNullable<typeof window.electronAPI>['getQAppHostConfig']>
  >
>;

export function QAppHost() {
  const [config, setConfig] = useState<HostConfig | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [uninstallBusy, setUninstallBusy] = useState(false);
  const [uninstallError, setUninstallError] = useState(false);
  const [showHubError, setShowHubError] = useState(false);
  const [permissionQueue, setPermissionQueue] = useState<PermissionPrompt[]>(
    []
  );
  const [confirmedPromptId, setConfirmedPromptId] = useState<string | null>(
    null
  );
  const permissionCheckbox = useRef<{
    promptId: string;
    value: boolean;
  } | null>(null);
  const navigationController = useAtomValue(navigationControllerAtom);
  const { t } = useTranslation('core');
  const theme = useTheme();

  useEffect(() => {
    let active = true;
    void window.electronAPI
      ?.getQAppHostConfig?.()
      .then((value) => {
        if (!active) return;
        handleSetGlobalApikey({ url: value.baseUrl, apikey: '' });
        window.sendMessage = ((action, payload, timeout, isExtension) =>
          window.electronAPI!.requestFromQAppHost!(
            action,
            payload,
            timeout,
            isExtension === true
          )) as typeof window.sendMessage;
        document.title = value.app.name;
        setConfig(value);
      })
      .catch(() => window.close());
    return () => {
      active = false;
    };
  }, []);

  useEffect(
    () =>
      window.electronAPI?.onQAppHostNavigate?.((app) => {
        document.title = app.name;
        setConfig((current) => (current ? { ...current, app } : current));
      }),
    []
  );

  useEffect(
    () =>
      window.electronAPI?.onQAppHostPermissionPrompt?.((prompt) => {
        if (!prompt || typeof prompt.promptId !== 'string') return;
        setPermissionQueue((queue) => [...queue, prompt]);
      }),
    []
  );

  useEffect(
    () =>
      window.electronAPI?.onQAppHostPermissionDismiss?.((promptId) => {
        setPermissionQueue((queue) =>
          queue.filter((prompt) => prompt.promptId !== promptId)
        );
      }),
    []
  );

  const currentPermission = permissionQueue[0];
  const answerPermission = (accepted: boolean) => {
    if (!currentPermission) return;
    if (
      accepted &&
      currentPermission.payload.confirmCheckbox &&
      confirmedPromptId !== currentPermission.promptId
    )
      return;
    window.electronAPI?.respondToQAppHostPermission?.(
      currentPermission.promptId,
      {
        accepted,
        checkbox1:
          accepted &&
          (permissionCheckbox.current?.promptId === currentPermission.promptId
            ? permissionCheckbox.current.value
            : (
                currentPermission.payload.checkbox1 as
                  | { value?: boolean }
                  | undefined
              )?.value === true),
      }
    );
    permissionCheckbox.current = null;
    setConfirmedPromptId(null);
    setPermissionQueue((queue) => queue.slice(1));
  };

  if (!config) return null;
  const tabId = config.app.tabId;
  const avatarUrl = `${config.baseUrl}/arbitrary/THUMBNAIL/${encodeURIComponent(config.app.name)}/qortal_avatar?async=true`;
  const navigation = navigationController[tabId];
  const backLabel = t('core:action.back', {
    postProcess: 'capitalizeFirstChar',
  });
  const refreshLabel = t('core:action.refresh', {
    postProcess: 'capitalizeFirstChar',
  });
  const copyLinkLabel = t('core:action.copy_link', {
    postProcess: 'capitalizeFirstChar',
  });
  const openHubLabel = t('core:action.open_hub', {
    postProcess: 'capitalizeFirstChar',
  });
  const uninstallLabel = t('core:action.uninstall_app', {
    postProcess: 'capitalizeFirstChar',
  });

  const uninstall = async () => {
    if (uninstallBusy) return;
    setUninstallBusy(true);
    setUninstallError(false);
    try {
      if (!window.electronAPI?.uninstallQAppHost) {
        setUninstallError(true);
        return;
      }
      await window.electronAPI.uninstallQAppHost();
      setConfirmUninstall(false);
    } catch {
      setUninstallError(true);
    } finally {
      setUninstallBusy(false);
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        minHeight: 0,
        overflow: 'hidden',
        width: '100vw',
      }}
    >
      <Box
        component="nav"
        sx={{
          alignItems: 'center',
          bgcolor: 'background.default',
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          flex: '0 0 56px',
          gap: 1,
          minWidth: 0,
          px: 1.5,
        }}
      >
        <Tooltip title={backLabel}>
          <span>
            <IconButton
              aria-label={backLabel}
              disabled={!navigation?.hasBack}
              onClick={() => executeEvent(`navigateBackApp-${tabId}`, {})}
              size="small"
            >
              <ArrowBackRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={refreshLabel}>
          <IconButton
            aria-label={refreshLabel}
            onClick={() => executeEvent('refreshApp', { tabId })}
            size="small"
          >
            <RefreshRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Avatar
          alt={config.app.name}
          src={avatarUrl}
          sx={{ height: 28, ml: 1, width: 28 }}
        >
          <Box component="img" src={LogoSelected} alt="" sx={{ width: 20 }} />
        </Avatar>
        <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <Typography noWrap sx={{ fontSize: 13, fontWeight: 600 }}>
            {config.app.name}
          </Typography>
          {navigation?.currentLink && (
            <Typography
              color="text.secondary"
              noWrap
              sx={{ fontSize: 11, lineHeight: 1.1 }}
            >
              {navigation.currentLink}
            </Typography>
          )}
        </Box>
        <Tooltip title={copyLinkLabel}>
          <span>
            <IconButton
              aria-label={copyLinkLabel}
              disabled={!navigation?.currentLink}
              onClick={() => {
                void navigator.clipboard
                  .writeText(navigation.currentLink)
                  .catch(() => undefined);
              }}
              size="small"
            >
              <ContentCopyRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={openHubLabel}>
          <IconButton
            aria-label={openHubLabel}
            onClick={() => {
              const showHub = window.electronAPI?.showHubFromQAppHost;
              if (!showHub) {
                setShowHubError(true);
                return;
              }
              void showHub().catch(() => setShowHubError(true));
            }}
            size="small"
          >
            <Box
              component="img"
              src={QortalHubIcon}
              alt=""
              sx={{ width: 24, height: 24, objectFit: 'contain' }}
            />
          </IconButton>
        </Tooltip>
        <Tooltip title={t('core:more')}>
          <IconButton
            aria-label={t('core:more')}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
            size="small"
          >
            <MoreVertRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={() => setMenuAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        PaperProps={{
          sx: {
            mt: 0.75,
            minWidth: 258,
            maxWidth: 320,
            bgcolor: 'background.paper',
            backgroundImage: 'none',
            border: 1,
            borderColor: 'border.subtle',
            borderRadius: 2.5,
            boxShadow: `0 18px 42px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.38 : 0.14)}`,
            overflow: 'hidden',
          },
        }}
        MenuListProps={{ sx: { py: 0 } }}
      >
        <ListSubheader
          component="div"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.25,
            px: 1.75,
            py: 1.5,
            bgcolor: 'transparent',
            lineHeight: 'normal',
          }}
        >
          <Avatar src={avatarUrl} alt="" sx={{ width: 30, height: 30 }}>
            <Box component="img" src={LogoSelected} alt="" sx={{ width: 20 }} />
          </Avatar>
          <Typography
            noWrap
            sx={{ fontSize: 13, fontWeight: 650, minWidth: 0 }}
          >
            {config.app.name}
          </Typography>
        </ListSubheader>
        <Divider sx={{ mx: 1.25 }} />
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            setUninstallError(false);
            setConfirmUninstall(true);
          }}
          sx={{
            mx: 0.75,
            my: 0.75,
            px: 1,
            py: 0.9,
            gap: 1.25,
            borderRadius: 1.75,
            color: 'error.main',
            '&:hover': { bgcolor: alpha(theme.palette.error.main, 0.09) },
          }}
        >
          <Box
            sx={{
              width: 34,
              height: 34,
              borderRadius: 1.25,
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              bgcolor: alpha(theme.palette.error.main, 0.12),
            }}
          >
            <DeleteOutlineRoundedIcon fontSize="small" />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>
              {uninstallLabel}
            </Typography>
            <Typography
              sx={{ color: 'text.secondary', fontSize: 11.5, lineHeight: 1.4 }}
            >
              {t('core:action.remove_app_shortcut', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Typography>
          </Box>
        </MenuItem>
      </Menu>
      <Dialog
        open={confirmUninstall}
        onClose={() => {
          if (!uninstallBusy) setConfirmUninstall(false);
        }}
        aria-labelledby="qapp-uninstall-title"
        aria-describedby="qapp-uninstall-description"
        PaperProps={{
          sx: {
            width: 'calc(100% - 32px)',
            maxWidth: 430,
            bgcolor: 'background.paper',
            backgroundImage: 'none',
            border: 1,
            borderColor: 'border.subtle',
            borderRadius: 3,
            boxShadow: `0 24px 64px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.45 : 0.18)}`,
          },
        }}
      >
        <DialogTitle
          id="qapp-uninstall-title"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            px: 3,
            pt: 3,
            pb: 1.5,
          }}
        >
          <Box
            sx={{
              display: 'grid',
              placeItems: 'center',
              width: 42,
              height: 42,
              flexShrink: 0,
              borderRadius: 2,
              color: 'error.main',
              bgcolor: alpha(theme.palette.error.main, 0.12),
            }}
          >
            <DeleteOutlineRoundedIcon />
          </Box>
          <Typography
            component="span"
            sx={{ fontSize: 18, fontWeight: 700, lineHeight: 1.25 }}
          >
            {uninstallLabel}
          </Typography>
        </DialogTitle>
        <DialogContent sx={{ px: 3, pb: 1 }}>
          <DialogContentText
            id="qapp-uninstall-description"
            sx={{ color: 'text.secondary', fontSize: 14, lineHeight: 1.6 }}
          >
            {t('core:message.question.uninstall_app', {
              app: config.app.name,
            })}
          </DialogContentText>
          {uninstallError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {t('core:message.error.generic')}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ gap: 1, px: 3, pt: 1.5, pb: 3 }}>
          <Button
            variant="outlined"
            disabled={uninstallBusy}
            onClick={() => setConfirmUninstall(false)}
            sx={{
              minWidth: 112,
              borderRadius: 2,
              borderColor: 'border.main',
              color: 'text.primary',
            }}
          >
            {t('core:action.cancel', {
              postProcess: 'capitalizeFirstChar',
            })}
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={uninstallBusy}
            onClick={() => void uninstall()}
            startIcon={<DeleteOutlineRoundedIcon fontSize="small" />}
            sx={{ minWidth: 142, borderRadius: 2, boxShadow: 'none' }}
          >
            {uninstallLabel}
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={showHubError}
        autoHideDuration={4000}
        onClose={() => setShowHubError(false)}
      >
        <Alert severity="error" onClose={() => setShowHubError(false)}>
          {t('core:message.error.generic')}
        </Alert>
      </Snackbar>
      <Box
        component="main"
        sx={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden', width: '100%' }}
      >
        <AppViewer app={config.app} isDevMode={false} />
      </Box>
      <QortalRequestExtensionDialog
        key={currentPermission?.promptId ?? 'none'}
        open={!!currentPermission}
        message={currentPermission?.payload ?? null}
        sendPaymentError=""
        confirmRequestRead={confirmedPromptId === currentPermission?.promptId}
        onConfirmRequestReadChange={(checked) =>
          setConfirmedPromptId(
            checked ? (currentPermission?.promptId ?? null) : null
          )
        }
        onCheckbox1Change={(checked) => {
          permissionCheckbox.current = currentPermission
            ? { promptId: currentPermission.promptId, value: checked }
            : null;
        }}
        onAccept={() => answerPermission(true)}
        onCancel={() => answerPermission(false)}
        onCountdownComplete={() => answerPermission(false)}
      />
      <QAppScreenCapturePermission active />
    </Box>
  );
}
