import { contextBridge, ipcRenderer } from 'electron';

// A sandboxed preload cannot load the full Hub preload, which imports Node
// modules. Keep this bridge limited to the Q-App host window's own IPC.
contextBridge.exposeInMainWorld('CapacitorCustomPlatform', {
  name: 'electron',
  plugins: {},
});

function onEvent(channel: string, callback: (payload: any) => void) {
  const listener = (_event: Electron.IpcRendererEvent, payload: any) =>
    callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('electronAPI', {
  isQAppHost: true,
  getQAppHostConfig: () => ipcRenderer.invoke('qappHost:getConfig'),
  showHubFromQAppHost: () => ipcRenderer.invoke('qappHost:showHub'),
  uninstallQAppHost: () => ipcRenderer.invoke('qappHost:uninstall'),
  requestQAppHostPermissionLocal: (payload: unknown) =>
    ipcRenderer.invoke('qappHost:permissionPromptLocal', payload),
  onQAppHostPermissionPrompt: (callback: (prompt: unknown) => void) =>
    onEvent('qappHost:permissionPrompt', callback),
  onQAppHostPermissionDismiss: (callback: (promptId: string) => void) =>
    onEvent('qappHost:permissionDismiss', callback),
  respondToQAppHostPermission: (promptId: string, answer: unknown) =>
    ipcRenderer.send('qappHost:permissionRespond', promptId, answer),
  onQAppHostNavigate: (callback: (app: unknown) => void) =>
    onEvent('qappHost:navigate', callback),
  onQAppHostThemeMode: (callback: (mode: 'light' | 'dark') => void) =>
    onEvent('qappHost:themeMode', callback),
  openTabFromQAppHost: (tab: unknown) =>
    ipcRenderer.invoke('qappHost:openTab', tab),
  requestFromQAppHost: (
    action: string,
    payload: unknown,
    timeout: number,
    isExtension: boolean
  ) =>
    ipcRenderer.invoke(
      'qappHost:request',
      action,
      payload,
      timeout,
      isExtension
    ),
  qappGuestPrepare: (owner: unknown, url: string, isDevMode: boolean) =>
    ipcRenderer.invoke('qappGuest:prepare', owner, url, isDevMode),
  qappGuestRelease: (owner: unknown) =>
    ipcRenderer.invoke('qappGuest:release', owner),
  qappFileSave: (owner: unknown, request: unknown) =>
    ipcRenderer.invoke('qappFileSave:request', owner, request),
  onQAppReticulumEvent: (callback: (payload: unknown) => void) =>
    onEvent('qappReticulum:event', callback),
  onPrivateChannelEvent: (callback: (payload: unknown) => void) =>
    onEvent('privateChannel:event', callback),
  onQAppMoqEvent: (callback: (payload: unknown) => void) =>
    onEvent('qappMoq:event', callback),
  onDisplayMediaRequest: (callback: (request: unknown) => void) =>
    onEvent('display-media:request', callback),
  onDisplayMediaCancel: (callback: (requestId: string) => void) =>
    onEvent('display-media:cancel', callback),
  authorizeDisplayMedia: (requestId: string, accepted: boolean) =>
    ipcRenderer.send('display-media:authorize', { requestId, accepted }),
  selectDisplayMedia: (requestId: string, sourceId?: string) =>
    ipcRenderer.send('display-media:select', { requestId, sourceId }),
});
