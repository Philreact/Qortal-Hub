const ROUTE_BOUND_ID_LENGTH = 36;
const ROUTE_HASH_HEX_LENGTH = 32;
const ROUTE_HASH_BASE64URL_LENGTH = 22;
const ROUTE_BOUND_RANDOM_LENGTH = 13;

export type RouteBoundIdKind = 'presence' | 'call';

const PREFIX_BY_KIND: Record<RouteBoundIdKind, string> = {
  presence: 'P',
  call: 'C',
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/** 96-bit opaque id for short-lived wire deduplication. */
export function createCompactWireId(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)));
}

function hexToBytes(hex: string): Uint8Array | null {
  const normalized = hex.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${ROUTE_HASH_HEX_LENGTH}}$`).test(normalized)) {
    return null;
  }
  const bytes = new Uint8Array(ROUTE_HASH_HEX_LENGTH / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Creates an opaque, UUID-sized identifier whose signed value also attests to
 * the originating Reticulum destination. Existing clients continue treating
 * it as an ordinary session/call id, so this adds no wire bytes.
 */
export function createRouteBoundId(
  kind: RouteBoundIdKind,
  destinationHash: string
): string | null {
  const destinationBytes = hexToBytes(destinationHash);
  if (!destinationBytes) return null;
  const route = bytesToBase64Url(destinationBytes);
  if (route.length !== ROUTE_HASH_BASE64URL_LENGTH) return null;

  const entropy = bytesToBase64Url(
    crypto.getRandomValues(new Uint8Array(10))
  ).slice(0, ROUTE_BOUND_RANDOM_LENGTH);
  const id = `${PREFIX_BY_KIND[kind]}${route}${entropy}`;
  return id.length === ROUTE_BOUND_ID_LENGTH ? id : null;
}

export function routeBoundIdMatchesDestination(
  kind: RouteBoundIdKind,
  id: string,
  destinationHash: string
): boolean {
  const destinationBytes = hexToBytes(destinationHash);
  if (!destinationBytes || id.length !== ROUTE_BOUND_ID_LENGTH) return false;
  const route = bytesToBase64Url(destinationBytes);
  return id.startsWith(`${PREFIX_BY_KIND[kind]}${route}`);
}
