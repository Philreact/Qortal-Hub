import {
  desktopCapturer,
  ipcMain,
  systemPreferences,
  type BrowserWindow,
  type DesktopCapturerSource,
} from 'electron';
import { randomUUID } from 'crypto';

/** Permission-controlled OS bridge. Source selection UI lives in the requesting app. */
export function installDisplayMediaPicker(
  window: BrowserWindow,
  platform: NodeJS.Platform = process.platform
): void {
  let cancelPending: (() => void) | null = null;
  window.webContents.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      const frame = request.frame;
      if (
        !frame ||
        frame.detached ||
        !request.userGesture ||
        !request.videoRequested ||
        frame.top !== window.webContents.mainFrame ||
        window.isDestroyed()
      ) {
        callback({});
        return;
      }
      // One chooser at a time; a new request cannot replace another app's prompt.
      if (cancelPending) {
        callback({});
        return;
      }
      const requestId = randomUUID();
      const originalUrl = frame.url;
      let sources: DesktopCapturerSource[] = [];
      let settled = false;
      let authorized = false;
      const deliver = (payload: unknown) =>
        frame
          .executeJavaScript(
            // Core's q-apps.js treats unmarked messages as RPC requests and
            // tries to transfer a nonexistent reply port. These are UI events.
            `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify({ ...(payload as object), requestedHandler: 'UI' })}, origin: window.location.origin, source: window }));`
          )
          .catch(() => undefined);
      const finish = (sourceId?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ipcMain.removeListener('display-media:select', selected);
        ipcMain.removeListener('display-media:authorize', authorize);
        cancelPending = null;
        const source = sources.find((value) => value.id === sourceId);
        const valid =
          !window.isDestroyed() &&
          !frame.detached &&
          frame.url === originalUrl &&
          frame.top === window.webContents.mainFrame;
        callback(valid && source ? { video: source } : {});
        if (!frame.detached)
          void deliver({ action: 'QAPP_SCREEN_CAPTURE_CANCEL', requestId });
        if (!window.isDestroyed())
          window.webContents.send('display-media:cancel', requestId);
      };
      const selected = (
        event: Electron.IpcMainEvent,
        payload: { requestId?: string; sourceId?: string }
      ) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          payload?.requestId !== requestId
        )
          return;
        if (!authorized) return;
        finish(payload.sourceId);
      };
      const authorize = (
        event: Electron.IpcMainEvent,
        payload: { requestId?: string; accepted?: boolean }
      ) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          payload?.requestId !== requestId ||
          authorized
        )
          return;
        if (payload.accepted !== true) {
          finish();
          return;
        }
        authorized = true;
        void enumerate().catch(() => finish());
      };
      const timer = setTimeout(() => finish(), 60_000);
      cancelPending = () => finish();
      ipcMain.on('display-media:select', selected);
      ipcMain.on('display-media:authorize', authorize);
      const enumerate = async () => {
        if (platform === 'darwin') {
          const status = systemPreferences.getMediaAccessStatus('screen');
          if (status === 'denied' || status === 'restricted') {
            await deliver({
              action: 'QAPP_SCREEN_CAPTURE_ERROR',
              requestId,
              code: 'SCREEN_OS_PERMISSION_REQUIRED',
            });
            finish();
            return;
          }
        }
        return desktopCapturer
          .getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 240, height: 135 },
          })
          .then((available) => {
            if (settled) return;
            if (
              window.isDestroyed() ||
              frame.detached ||
              frame.url !== originalUrl
            ) {
              finish();
              return;
            }
            sources = available.slice(0, 60);
            if (!sources.length) {
              finish();
              return;
            }
            return deliver({
              action: 'QAPP_SCREEN_CAPTURE_SOURCES',
              requestId,
              sources: sources.map((source) => ({
                id: source.id,
                name: source.name.slice(0, 160),
                thumbnail: source.thumbnail.toDataURL(),
              })),
            });
          })
          .catch(() => finish());
      };
      // The random, one-use request ID is disclosed only to the requesting frame
      // after permission. Other Q-Apps cannot select a source for this request.
      window.webContents.send('display-media:request', {
        requestId,
        origin: request.securityOrigin,
      });
    }
  );
  window.once('closed', () => cancelPending?.());
}
