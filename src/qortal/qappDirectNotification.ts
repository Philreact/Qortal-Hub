export type DirectNotificationInput = {
  title: string;
  body: string;
  link?: string;
};

export function parseQAppDirectNotification(
  payload: unknown,
  appName: string,
  appIdentifier?: string
): DirectNotificationInput | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  if (!appName.trim() || appName.length > 256) return null;
  const value = payload as Record<string, unknown>;
  const title = value.title === undefined ? '' : value.title;
  if (typeof title !== 'string' || title.length > 120) return null;
  if (/[\r\n]/.test(title)) return null;
  if (typeof value.body !== 'string' || value.body.length > 1000) return null;
  const body = value.body.trim();
  if (!body || body.length > 1000) return null;
  if (
    [...`${title}${body}`].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        (code < 32 && code !== 10) ||
        code === 127 ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
  )
    return null;
  const result: DirectNotificationInput = {
    title: title.trim() ? `${appName} · ${title.trim()}` : appName,
    body,
  };
  if (result.title.length > 256) return null;
  if (value.link === undefined || value.link === '') return result;
  if (typeof value.link !== 'string' || value.link.length > 2048) return null;
  try {
    const url = new URL(value.link);
    const name = decodeURIComponent(url.pathname.split('/')[1] ?? '');
    const identifier = url.searchParams.get('identifier') ?? undefined;
    if (
      url.protocol !== 'qortal:' ||
      url.hostname.toUpperCase() !== 'APP' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      name.toLowerCase() !== appName.toLowerCase() ||
      (identifier !== undefined && identifier !== appIdentifier)
    )
      return null;
    if (appIdentifier && identifier === undefined) {
      url.searchParams.set('identifier', appIdentifier);
    }
    result.link = url.toString();
    return result;
  } catch {
    return null;
  }
}
