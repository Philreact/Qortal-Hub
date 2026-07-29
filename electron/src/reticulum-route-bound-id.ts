import { Buffer } from 'buffer';

const ROUTE_BOUND_ID_LENGTH = 36;
const ROUTE_HASH_BASE64URL_LENGTH = 22;
const ROUTE_BOUND_RANDOM_LENGTH = 13;

export type RouteBoundIdKind = 'presence' | 'call';

const PREFIX_BY_KIND: Record<RouteBoundIdKind, string> = {
  presence: 'P',
  call: 'C',
};

/**
 * Extracts the Reticulum destination committed inside a signed session/call
 * id. The compact id remains exactly UUID-sized, so the binding is wire-free.
 */
export function getRouteBoundDestinationHash(
  kind: RouteBoundIdKind,
  id: string
): string | null {
  if (
    typeof id !== 'string' ||
    id.length !== ROUTE_BOUND_ID_LENGTH ||
    id[0] !== PREFIX_BY_KIND[kind]
  ) {
    return null;
  }
  const encodedRoute = id.slice(1, 1 + ROUTE_HASH_BASE64URL_LENGTH);
  const entropy = id.slice(1 + ROUTE_HASH_BASE64URL_LENGTH);
  if (
    !/^[A-Za-z0-9_-]{22}$/.test(encodedRoute) ||
    !new RegExp(`^[A-Za-z0-9_-]{${ROUTE_BOUND_RANDOM_LENGTH}}$`).test(entropy)
  ) {
    return null;
  }
  try {
    const base64 = encodedRoute.replace(/-/g, '+').replace(/_/g, '/') + '==';
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length !== 16) return null;
    return bytes.toString('hex');
  } catch {
    return null;
  }
}
