import { createRoot } from 'react-dom/client';
import './utils/configureDomPurify';
import App from './App.tsx';
import { QAppHost } from './components/Apps/QAppHost.tsx';
import '../src/styles/index.css';
import './messaging/MessagesToBackground.tsx';
import { MessageQueueProvider } from './messaging/MessageQueueContext.tsx';
import { ThemeProvider } from './components/Theme/ThemeContext.tsx';
import { CssBaseline } from '@mui/material';
import './i18n/i18n.js';

createRoot(document.getElementById('root')!).render(
  <>
    <ThemeProvider>
      <CssBaseline />
      <MessageQueueProvider>
        {new URLSearchParams(window.location.search).has('qappHost') ? (
          <QAppHost />
        ) : (
          <App />
        )}
      </MessageQueueProvider>
    </ThemeProvider>
  </>
);
