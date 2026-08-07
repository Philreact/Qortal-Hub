import { validateAddress } from '../../utils/validateAddress';

export type DirectTargetSearchResult = {
  name: string;
  address: string;
};

/** Resolve user-entered DM text to the Qortal address used on the wire. */
export function resolveDirectTarget(
  value: string,
  results: DirectTargetSearchResult[]
): DirectTargetSearchResult | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (validateAddress(trimmed)) {
    return { address: trimmed, name: trimmed };
  }
  const exact = (results || []).filter(
    (result) => result.name === trimmed && validateAddress(result.address)
  );
  return exact.length === 1 ? exact[0] : null;
}
