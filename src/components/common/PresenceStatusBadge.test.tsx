import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

i18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: {
      core: {
        'message.generic.presence_status': 'Status: {{status}}',
      },
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

import { PresenceStatusBadge } from './PresenceStatusBadge';

const theme = createTheme();

const renderBadge = (props: React.ComponentProps<typeof PresenceStatusBadge>) =>
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider theme={theme}>
        <PresenceStatusBadge {...props} />
      </ThemeProvider>
    </I18nextProvider>
  );

describe('PresenceStatusBadge', () => {
  it('labels each status through the shared presence labels', () => {
    for (const [status, label] of [
      ['online', 'Online'],
      ['busy', 'Busy'],
      ['idle', 'Idle'],
      ['offline', 'Offline'],
    ] as const) {
      const { unmount } = renderBadge({
        status,
        children: <span>avatar</span>,
      });

      expect(screen.getByLabelText(`Status: ${label}`)).toBeInTheDocument();
      unmount();
    }
  });

  it('falls back to offline for a peer with no presence', () => {
    renderBadge({ status: null, children: <span>avatar</span> });

    expect(screen.getByLabelText('Status: Offline')).toBeInTheDocument();
  });

  it('reports offline when the peer is explicitly not online', () => {
    renderBadge({ online: false, status: 'busy', children: <span>a</span> });

    expect(screen.getByLabelText('Status: Offline')).toBeInTheDocument();
  });
});
