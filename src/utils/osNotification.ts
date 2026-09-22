export type OsNotificationRequest = {
  title: string;
  body: string;
  icon?: string;
  silent?: boolean;
  direct?: boolean;
  clickId?: string;
  source?: {
    appName?: string;
    appService?: string;
    appIdentifier?: string;
    link?: string;
  };
};

export async function showOsNotification(
  request: OsNotificationRequest,
  onBrowserClick?: () => void
): Promise<boolean> {
  if (window.electronAPI?.showOsNotification) {
    return window.electronAPI.showOsNotification(request);
  }
  if (!('Notification' in window) || Notification.permission !== 'granted')
    return false;
  const notification = new Notification(request.title, {
    body: request.body,
    icon: request.icon,
    silent: request.silent,
    data: request.clickId ? { id: request.clickId } : undefined,
  });
  notification.onclick = () => {
    onBrowserClick?.();
    notification.close();
  };
  setTimeout(() => notification.close(), 10_000);
  return true;
}
