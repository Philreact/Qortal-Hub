export type QAppLaunch = {
  service: 'APP';
  name: string;
  identifier?: string;
  path?: string;
};

export const DEFAULT_HUB_LAUNCH_PORT = 55000;

export type HubLaunchCommand =
  | { type: 'focus' }
  | { type: 'show-launcher' }
  | { type: 'open-qapp'; app: QAppLaunch };

export function parseQAppLaunchUrl(value: string): QAppLaunch | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'qortal:' || url.hostname.toUpperCase() !== 'APP') {
      return null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const name = decodeURIComponent(parts[0]).trim();
    if (
      !name ||
      name.length > 256 ||
      name.includes('/') ||
      [...name].some((character) => character.charCodeAt(0) < 32)
    ) {
      return null;
    }
    const path = parts.slice(1).join('/');
    const identifier = url.searchParams.get('identifier')?.trim();
    if (path.length > 2048 || (identifier && identifier.length > 256)) {
      return null;
    }
    return {
      service: 'APP',
      name,
      ...(path ? { path } : {}),
      ...(identifier ? { identifier } : {}),
    };
  } catch {
    return null;
  }
}

export function parseHubLaunchCommand(argv: string[]): HubLaunchCommand | null {
  const argument = argv.find((value) => value.startsWith('--open-qapp='));
  if (!argument) return null;
  const app = parseQAppLaunchUrl(argument.slice('--open-qapp='.length));
  return app ? { type: 'open-qapp', app } : null;
}

export function parseHubLaunchMessage(value: unknown): HubLaunchCommand | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.type === 'focus') return { type: 'focus' };
  if (record.type === 'show-launcher') return { type: 'show-launcher' };
  if (
    record.type !== 'open-qapp' ||
    !record.app ||
    typeof record.app !== 'object'
  ) {
    return null;
  }
  const app = record.app as Record<string, unknown>;
  if (app.service !== 'APP' || typeof app.name !== 'string') return null;
  const url = `qortal://APP/${encodeURIComponent(app.name)}${
    typeof app.path === 'string' && app.path ? `/${app.path}` : ''
  }${
    typeof app.identifier === 'string' && app.identifier
      ? `?identifier=${encodeURIComponent(app.identifier)}`
      : ''
  }`;
  const parsed = parseQAppLaunchUrl(url);
  return parsed ? { type: 'open-qapp', app: parsed } : null;
}
