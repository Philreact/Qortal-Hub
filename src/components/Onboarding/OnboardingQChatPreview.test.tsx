import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OnboardingQChatPreview } from './OnboardingQChatPreview';

const i18n = createInstance();
void i18n.init({
  fallbackLng: 'en',
  lng: 'en',
  resources: {
    en: {
      group: {
        chat_group: { qortal_land: 'Qortal Land' },
        onboarding: {
          preview: {
            badge: 'Guided Preview',
            category: {
              community: 'Community',
              official: 'Official',
              support: 'Support',
            },
            channel: {
              announcements: 'Announcements',
              bug_reports: 'Bug Reports',
              general_chat: 'General Chat',
              official_links: 'Official Links',
              qort_trading: 'QORT Trading',
              qortal_land: 'Qortal Land',
              qortal_marketing: 'Qortal Marketing',
              rules: 'Rules',
              tasks_and_ideas: 'Tasks & Ideas',
            },
            notice: 'Preview notice',
            owner: 'Owner',
            qortino_message: 'Preview message',
          },
        },
      },
      reticulum: {
        mode_pill: {
          enter_qortal_land: 'Enter QortalLand',
        },
      },
    },
  },
});

const theme = createTheme({
  palette: {
    background: {
      surface: '#17191f',
    },
  },
});

beforeAll(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
});

describe('OnboardingQChatPreview', () => {
  it('provides stable channel and QortalLand spotlight targets', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider theme={theme}>
          <OnboardingQChatPreview />
        </ThemeProvider>
      </I18nextProvider>
    );

    expect(screen.getByTestId('onboarding-qchat-preview')).toBeInTheDocument();
    expect(screen.getAllByText('Rules')).not.toHaveLength(0);
    expect(screen.getByText('Qortino')).toBeInTheDocument();
    expect(
      container.querySelector('[data-tour="hub-onboarding-channel"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-tour="hub-group-qortal-land"]')
    ).not.toBeNull();
  });
});
