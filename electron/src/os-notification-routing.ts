import { parseQAppLaunchUrl, type QAppLaunch } from './qapp-launch';

export type OsNotificationSource = {
  appName?: unknown;
  appService?: unknown;
  appIdentifier?: unknown;
  link?: unknown;
};

export type OpenQAppNotificationHost = {
  hostId: number;
  app: QAppLaunch;
};

export type OsNotificationRoute =
  | { kind: 'hub' }
  | { kind: 'suppress' }
  | { kind: 'app'; hostId: number; path?: string };

export function routeOsNotification(
  hubVisible: boolean,
  source: OsNotificationSource | undefined,
  hosts: OpenQAppNotificationHost[]
): OsNotificationRoute {
  const fallback: OsNotificationRoute = hubVisible
    ? { kind: 'hub' }
    : { kind: 'suppress' };
  if (!source || typeof source.appName !== 'string') return fallback;
  const appName = source.appName.trim();
  if (!appName || appName.length > 256) return fallback;

  let target: QAppLaunch | null = null;
  if (source.link !== undefined && source.link !== null && source.link !== '') {
    if (typeof source.link !== 'string' || source.link.length > 4096)
      return fallback;
    target = parseQAppLaunchUrl(source.link);
    if (!target || target.name.toLowerCase() !== appName.toLowerCase())
      return fallback;
    const url = new URL(source.link);
    url.searchParams.delete('identifier');
    const query = url.searchParams.toString();
    if (query) target.path = `${target.path ?? ''}?${query}`;
  } else if (source.appService !== 'APP') {
    return fallback;
  }
  if (source.appService !== undefined && source.appService !== 'APP')
    return fallback;
  if (
    source.appIdentifier !== undefined &&
    (typeof source.appIdentifier !== 'string' ||
      source.appIdentifier.length > 256 ||
      (target?.identifier && target.identifier !== source.appIdentifier))
  )
    return fallback;

  const candidates = hosts.filter(
    ({ app }) =>
      app.service === 'APP' &&
      app.name.toLowerCase() === appName.toLowerCase() &&
      (source.appIdentifier === undefined ||
        app.identifier === source.appIdentifier) &&
      (!target?.identifier || app.identifier === target.identifier)
  );
  // An identifier-free notification must never choose between variants.
  if (candidates.length !== 1) return fallback;
  return {
    kind: 'app',
    hostId: candidates[0].hostId,
    ...(target ? { path: target.path ?? '' } : {}),
  };
}
