import {
  Box,
  List,
  ListItemButton,
  ListItemText,
  IconButton,
  Popover,
  Tooltip,
  Typography,
  useTheme,
  type TooltipProps,
} from '@mui/material';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import PendingIcon from '@mui/icons-material/Pending';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import { getBaseApiReact } from '../../App';
import { executeEvent } from '../../utils/events';
import { useAtom } from 'jotai';
import { memberGroupsAtom, txListAtom, userInfoAtom } from '../../atoms/global';
import { useTranslation } from 'react-i18next';
import { TIME_MINUTES_1_IN_MILLISECONDS } from '../../constants/constants';
import {
  applyReticulumJoinUnreadBaseline,
  resolveReticulumMembershipJoinedAt,
} from '../Chat/reticulumJoinUnreadBaseline';

export const TaskManager = ({
  getUserInfo,
  buttonSx = undefined,
  iconSx = undefined,
  tooltipSlotProps,
  tooltipTitle,
}: {
  getUserInfo: (useTimer?: boolean) => Promise<void>;
  buttonSx?: any;
  iconSx?: any;
  tooltipSlotProps?: TooltipProps['slotProps'];
  tooltipTitle?: ReactNode;
}) => {
  const [memberGroups, setMemberGroups] = useAtom(memberGroupsAtom);
  const [txList, setTxList] = useAtom(txListAtom);
  const [userInfo] = useAtom(userInfoAtom);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const intervals = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const membershipIntervals = useRef<
    Record<string, ReturnType<typeof setInterval>>
  >({});
  const theme = useTheme();
  const { t } = useTranslation(['auth', 'core', 'group', 'question']);

  const popoverOpen = Boolean(anchorEl);

  const handleIconClick = (event: MouseEvent<HTMLElement>) => {
    setAnchorEl((prev) =>
      prev === event.currentTarget ? null : event.currentTarget
    );
  };

  const handleClosePopover = () => {
    setAnchorEl(null);
  };

  const getStatus = (
    { signature }: { signature: string },
    callback?: (ok: boolean) => void
  ) => {
    let stop = false;
    const getAnswer = async () => {
      const getTx = async () => {
        const url = `${getBaseApiReact()}/transactions/signature/${signature}`;
        const res = await fetch(url);
        return await res.json();
      };

      if (!stop) {
        stop = true;
        try {
          const txTransaction = await getTx();
          if (!txTransaction.error && txTransaction.signature) {
            await new Promise((res) =>
              setTimeout(() => {
                res(null);
              }, TIME_MINUTES_1_IN_MILLISECONDS)
            );
            setTxList((prev) => {
              const previousData = [...prev];
              const findTxWithSignature = previousData.findIndex(
                (tx) => tx.signature === signature
              );
              if (findTxWithSignature !== -1) {
                previousData[findTxWithSignature].done = true;
                return previousData;
              }
              return previousData;
            });
            if (callback) {
              callback(true);
            }
            clearInterval(intervals.current[signature]);
          }
        } catch (error) {
          console.log(error);
        }
        stop = false;
      }
    };

    intervals.current[signature] = setInterval(
      getAnswer,
      TIME_MINUTES_1_IN_MILLISECONDS
    );
  };

  useEffect(() => {
    setTxList((prev) => {
      const previousData = [...prev];
      memberGroups.forEach((group) => {
        const findGroup = txList.findIndex(
          (tx) => tx?.type === 'joined-group' && tx?.groupId === group.groupId
        );
        if (findGroup !== -1 && !previousData[findGroup]?.done) {
          previousData[findGroup].done = true;
        }
      });

      memberGroups.forEach((group) => {
        const findGroup = txList.findIndex(
          (tx) =>
            tx?.type === 'created-group' && tx?.groupName === group.groupName
        );
        if (findGroup !== -1 && !previousData[findGroup]?.done) {
          previousData[findGroup].done = true;
        }
      });

      prev.forEach((tx, index) => {
        if (
          tx?.type === 'leave-group' &&
          memberGroups.findIndex((group) => tx?.groupId === group.groupId) ===
            -1
        ) {
          previousData[index].done = true;
        }
      });

      return previousData;
    });
  }, [memberGroups, getUserInfo]);

  useEffect(() => {
    const pendingJoins = txList.filter(
      (tx) =>
        tx?.type === 'joined-group' &&
        tx?.done !== true &&
        Number.isInteger(Number(tx?.groupId)) &&
        Number(tx.groupId) > 0
    );
    for (const tx of pendingJoins) {
      const groupId = Number(tx.groupId);
      const address = String(
        tx?.memberAddress || tx?.creatorAddress || userInfo?.address || ''
      ).trim();
      if (!address) continue;
      const intervalKey = `${tx?.signature || groupId}:${address}`;
      if (membershipIntervals.current[intervalKey]) continue;
      let requestInFlight = false;
      const reconcileMembership = async () => {
        if (requestInFlight) return;
        requestInFlight = true;
        try {
          const response = await fetch(
            `${getBaseApiReact()}/groups/member/${encodeURIComponent(address)}`
          );
          if (!response.ok) return;
          const value = await response.json();
          const groups = Array.isArray(value)
            ? value
            : Array.isArray(value?.groups)
              ? value.groups
              : [];
          const confirmedGroup = groups.find(
            (group: any) => Number(group?.groupId) === groupId
          );
          if (!confirmedGroup) return;
          const joinedAt = await resolveReticulumMembershipJoinedAt(
            groupId,
            address
          ).catch(() => null);
          const confirmedMembership = joinedAt
            ? { ...confirmedGroup, reticulumJoinedAt: joinedAt }
            : confirmedGroup;

          setMemberGroups((current: any[]) => {
            const existingIndex = current.findIndex(
              (group: any) => Number(group?.groupId) === groupId
            );
            if (existingIndex === -1) return [confirmedMembership, ...current];
            const next = [...current];
            next[existingIndex] = {
              ...next[existingIndex],
              ...confirmedMembership,
            };
            return next;
          });
          setTxList((current) =>
            current.map((candidate) =>
              candidate === tx ||
              (candidate?.type === 'joined-group' &&
                Number(candidate?.groupId) === groupId &&
                candidate?.done !== true)
                ? { ...candidate, done: true }
                : candidate
            )
          );
          window.clearInterval(membershipIntervals.current[intervalKey]);
          delete membershipIntervals.current[intervalKey];

          if (joinedAt) {
            for (const delay of [0, 1_500, 4_000, 10_000]) {
              window.setTimeout(() => {
                void applyReticulumJoinUnreadBaseline({
                  address,
                  groupId,
                  joinedAt,
                });
              }, delay);
            }
          }
        } catch {
          // The transaction or node membership index may still be pending.
        } finally {
          requestInFlight = false;
        }
      };
      membershipIntervals.current[intervalKey] = window.setInterval(
        () => void reconcileMembership(),
        3_000
      );
      void reconcileMembership();
    }
  }, [setMemberGroups, setTxList, txList, userInfo?.address]);

  useEffect(
    () => () => {
      for (const timer of Object.values(intervals.current)) {
        clearInterval(timer);
      }
      for (const timer of Object.values(membershipIntervals.current)) {
        clearInterval(timer);
      }
    },
    []
  );

  const checkForName = useCallback(async (address) => {
    if (!address) return;
    const startTime = Date.now();
    const TIMEOUT = 5 * 60 * 1000; // 5 minutes
    const INTERVAL = 5000; // every 5 seconds

    async function fetchName() {
      try {
        const response = await fetch(
          `${getBaseApiReact()}/names/primary/${address}`
        );
        const nameData = await response.json();

        if (nameData?.name) {
          getUserInfo();
          return true;
        }
      } catch (err) {
        console.error('Error checking name:', err);
      }
      return false;
    }

    const checkLoop = async () => {
      const found = await fetchName();
      if (found) return; // stop polling

      if (Date.now() - startTime < TIMEOUT) {
        setTimeout(checkLoop, INTERVAL);
      }
    };

    checkLoop();
  }, []);

  useEffect(() => {
    txList.forEach((tx) => {
      if (
        [
          'created-common-secret',
          'joined-group-request',
          'join-request-accept',
        ].includes(tx?.type) &&
        tx?.signature &&
        !tx.done
      ) {
        if (!intervals.current[tx.signature]) {
          getStatus({ signature: tx.signature });
        }
      }
      if (tx?.type === 'register-name' && tx?.signature && !tx.done) {
        if (!intervals.current[tx.signature]) {
          getStatus({ signature: tx.signature }, () =>
            checkForName(tx?.creatorAddress)
          );
        }
      }
      if (
        (tx?.type === 'remove-rewardShare' || tx?.type === 'add-rewardShare') &&
        tx?.signature &&
        !tx.done
      ) {
        if (!intervals.current[tx.signature]) {
          const sendEventForRewardShare = () => {
            executeEvent('refresh-rewardshare-list', {});
          };
          getStatus({ signature: tx.signature }, sendEventForRewardShare);
        }
      }
    });
  }, [txList]);

  if (txList?.length === 0 || txList.every((item) => item?.done)) return null;

  const triggerButton = (
    <IconButton
      disableFocusRipple
      disableRipple
      aria-expanded={popoverOpen ? 'true' : 'false'}
      aria-haspopup="true"
      tabIndex={-1}
      onClick={handleIconClick}
      size="small"
      sx={{
        color: txList.some((item) => !item.done)
          ? theme.palette.primary.light
          : theme.palette.text.secondary,
        '&.MuiIconButton-root': {
          width: 26,
          height: 26,
        },
        ...(buttonSx || {}),
      }}
    >
      {txList.some((item) => !item.done) ? (
        <PendingIcon sx={iconSx || undefined} />
      ) : (
        <TaskAltIcon sx={iconSx || undefined} />
      )}
    </IconButton>
  );

  return (
    <>
      {tooltipTitle != null ? (
        <Tooltip
          arrow
          disableInteractive
          placement="bottom"
          slotProps={tooltipSlotProps}
          title={tooltipTitle}
        >
          {triggerButton}
        </Tooltip>
      ) : (
        triggerButton
      )}

      <Popover
        anchorEl={anchorEl}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        disableRestoreFocus
        open={popoverOpen}
        slotProps={{
          paper: {
            elevation: 8,
            sx: {
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 2,
              display: 'flex',
              flexDirection: 'column',
              maxHeight: 'min(400px, 70vh)',
              maxWidth: 'min(300px, calc(100vw - 16px))',
              mt: 0.75,
              overflow: 'hidden',
              width: '300px',
            },
          },
        }}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
        onClose={handleClosePopover}
      >
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 'min(400px, 70vh)',
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              alignItems: 'center',
              borderBottom: `1px solid ${theme.palette.divider}`,
              display: 'flex',
              flexShrink: 0,
              gap: 1,
              pl: 1.5,
              pr: 0.5,
              py: 1,
            }}
          >
            <Box
              sx={{
                alignItems: 'center',
                color: theme.palette.primary.main,
                display: 'flex',
                flexShrink: 0,
              }}
            >
              {txList.some((item) => !item.done) ? (
                <PendingIcon fontSize="small" />
              ) : (
                <TaskAltIcon fontSize="small" />
              )}
            </Box>
            <Typography
              fontWeight={600}
              sx={{ flex: 1, minWidth: 0, pr: 0.5 }}
              variant="subtitle2"
            >
              {t('core:message.generic.ongoing_transactions', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Typography>
            <IconButton
              aria-label={t('core:action.close', {
                postProcess: 'capitalizeFirstChar',
              })}
              edge="end"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                handleClosePopover();
              }}
            >
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </Box>

          <List
            component="nav"
            dense
            sx={{
              bgcolor: theme.palette.background.paper,
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              py: 0,
            }}
          >
            {txList.map((item) => (
              <ListItemButton
                key={item?.signature ?? `${item?.type}-${item?.groupId}`}
                sx={{ alignItems: 'flex-start', py: 1, pl: 2, pr: 2 }}
              >
                <ListItemText
                  primary={item?.done ? item.labelDone : item.label}
                  primaryTypographyProps={{
                    variant: 'body2',
                    sx: { whiteSpace: 'normal', wordBreak: 'break-word' },
                  }}
                />
              </ListItemButton>
            ))}
          </List>
        </Box>
      </Popover>
    </>
  );
};
