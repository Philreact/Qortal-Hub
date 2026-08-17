import { useMemo } from 'react';
import { useTheme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { isIdleAtom, type SelectableStatus } from '../../atoms/presence';
import { statusDotColor, useMyStatus } from '../../hooks/usePresence';

/**
 * What the UI can show for the local account: the statuses the user may pick,
 * plus `'idle'`, which is derived from inactivity and never selectable.
 */
export type PresenceDisplayStatus = SelectableStatus | 'idle';

/** Order the picker renders in, on every surface that offers one. */
export const ACCOUNT_STATUS_KEYS: SelectableStatus[] = [
  'online',
  'busy',
  'offline',
];

export type AccountStatusOption = {
  key: SelectableStatus;
  color: string;
  label: string;
};

/**
 * Dot colour for the local account. `'offline'` is intentionally not
 * `statusDotColor('offline')`: the picker shows "appear offline" as a muted
 * theme grey rather than the flat grey used for peers who are really gone.
 */
function useAccountStatusColor() {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';

  return useMemo(
    () => (status: PresenceDisplayStatus) =>
      status === 'offline'
        ? isDarkMode
          ? alpha(theme.palette.common.white, 0.36)
          : alpha(theme.palette.text.primary, 0.32)
        : statusDotColor(status),
    [isDarkMode, theme.palette.common.white, theme.palette.text.primary]
  );
}

/**
 * Translated label for any presence status, the local account's or a peer's.
 * Widened to `string | null` to match `statusDotColor`, its colour counterpart:
 * `null` — a peer we hold no presence for — reads as offline, and anything
 * unrecognised falls through to online, exactly as the dot colour does.
 */
export function usePresenceStatusLabel() {
  const { t } = useTranslation(['group']);

  return useMemo(
    () => (status: PresenceDisplayStatus | string | null) => {
      if (status === 'busy')
        return t('group:dashboard.account_status_busy', {
          defaultValue: 'Busy',
        });

      if (!status || status === 'offline')
        return t('group:dashboard.account_status_offline', {
          defaultValue: 'Offline',
        });

      if (status === 'idle')
        return t('group:dashboard.account_status_idle', {
          defaultValue: 'Idle',
        });

      return t('group:dashboard.account_status_online', {
        defaultValue: 'Online',
      });
    },
    [t]
  );
}

/** The selectable statuses, with their label and dot colour. */
export function useAccountStatusOptions(): AccountStatusOption[] {
  const getColor = useAccountStatusColor();
  const getLabel = usePresenceStatusLabel();

  return useMemo(
    () =>
      ACCOUNT_STATUS_KEYS.map((key) => ({
        key,
        color: getColor(key),
        label: getLabel(key),
      })),
    [getColor, getLabel]
  );
}

/**
 * Current status of the local account as it should be displayed, together with
 * the chosen status and its setter. Idle overrides the chosen status for
 * display only — going idle must not clear an explicit "appear offline".
 */
export function useAccountStatusDisplay(): {
  color: string;
  displayStatus: PresenceDisplayStatus;
  label: string;
  myStatus: SelectableStatus;
  setMyStatus: (status: SelectableStatus) => void;
} {
  const [myStatus, setMyStatus] = useMyStatus();
  const isIdle = useAtomValue(isIdleAtom);
  const getColor = useAccountStatusColor();
  const getLabel = usePresenceStatusLabel();
  const displayStatus: PresenceDisplayStatus =
    isIdle && myStatus !== 'offline' ? 'idle' : myStatus;

  return {
    color: getColor(displayStatus),
    displayStatus,
    label: getLabel(displayStatus),
    myStatus,
    setMyStatus,
  };
}
