import React from 'react';
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { createStore, Provider as JotaiProvider } from 'jotai';

i18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: {
      group: {
        'dashboard.account_status_busy': 'Busy',
        'dashboard.account_status_idle': 'Idle',
        'dashboard.account_status_offline': 'Offline',
        'dashboard.account_status_online': 'Online',
      },
    },
  },
  interpolation: { escapeValue: false },
});

import { isIdleAtom, myStatusAtom } from '../../atoms/presence';
import {
  ACCOUNT_STATUS_KEYS,
  useAccountStatusDisplay,
  useAccountStatusOptions,
} from './accountStatus';

const theme = createTheme();

const renderWithStore = <T,>(hook: () => T, store = createStore()) => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <JotaiProvider store={store}>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider theme={theme}>{children}</ThemeProvider>
      </I18nextProvider>
    </JotaiProvider>
  );

  return { ...renderHook(hook, { wrapper }), store };
};

describe('useAccountStatusOptions', () => {
  it('exposes the three selectable statuses with labels and colours', () => {
    const { result } = renderWithStore(() => useAccountStatusOptions());

    expect(result.current.map((option) => option.key)).toEqual(
      ACCOUNT_STATUS_KEYS
    );
    expect(result.current.map((option) => option.label)).toEqual([
      'Online',
      'Busy',
      'Offline',
    ]);
    expect(result.current.every((option) => option.color.length > 0)).toBe(
      true
    );
  });
});

describe('useAccountStatusDisplay', () => {
  it('reflects the chosen status', () => {
    const store = createStore();
    store.set(myStatusAtom, 'busy');
    const { result } = renderWithStore(() => useAccountStatusDisplay(), store);

    expect(result.current.displayStatus).toBe('busy');
    expect(result.current.label).toBe('Busy');
  });

  it('shows idle over an online selection without changing it', () => {
    const store = createStore();
    store.set(isIdleAtom, true);
    const { result } = renderWithStore(() => useAccountStatusDisplay(), store);

    expect(result.current.displayStatus).toBe('idle');
    expect(result.current.label).toBe('Idle');
    expect(result.current.myStatus).toBe('online');
  });

  it('keeps an explicit offline selection while idle', () => {
    const store = createStore();
    store.set(isIdleAtom, true);
    store.set(myStatusAtom, 'offline');
    const { result } = renderWithStore(() => useAccountStatusDisplay(), store);

    expect(result.current.displayStatus).toBe('offline');
    expect(result.current.label).toBe('Offline');
  });

  it('writes the picked status back to the shared atom', () => {
    const store = createStore();
    const { result } = renderWithStore(() => useAccountStatusDisplay(), store);

    act(() => {
      result.current.setMyStatus('busy');
    });

    expect(store.get(myStatusAtom)).toBe('busy');
    expect(result.current.displayStatus).toBe('busy');
  });
});
