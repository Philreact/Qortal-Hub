import { act, render, screen, waitFor } from '@testing-library/react';
import { useTheme } from '@mui/material/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from './ThemeContext';

function ThemeModeProbe() {
  const theme = useTheme();
  return <output data-testid="theme-mode">{theme.palette.mode}</output>;
}

describe('ThemeProvider in a Q-App window', () => {
  afterEach(() => {
    localStorage.clear();
    delete window.electronAPI;
  });

  it('uses the Hub mode and follows later Hub changes', async () => {
    let onThemeMode: ((mode: 'light' | 'dark') => void) | undefined;
    window.electronAPI = {
      isQAppHost: true,
      getQAppHostConfig: vi.fn().mockResolvedValue({ themeMode: 'light' }),
      onQAppHostThemeMode: vi.fn((callback) => {
        onThemeMode = callback;
        return () => undefined;
      }),
    };
    localStorage.setItem(
      'saved_ui_theme',
      JSON.stringify({ mode: 'dark', currentThemeId: 'default' })
    );

    render(
      <ThemeProvider>
        <ThemeModeProbe />
      </ThemeProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId('theme-mode')).toHaveTextContent('light')
    );
    act(() => onThemeMode?.('dark'));
    await waitFor(() =>
      expect(screen.getByTestId('theme-mode')).toHaveTextContent('dark')
    );
  });
});
