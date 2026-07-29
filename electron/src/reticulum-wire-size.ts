/**
 * Single source of truth for Reticulum JSON wire size before/after Python injects `r`.
 * Must match `presence_bridge.py` `_call_wire_json_bytes` + `out["r"] = destination_hash_hex(...)`.
 */

/**
 * The Python bridge injects `r` via `destination_hash_hex(_destination.hash)` — RNS
 * destination addresses are 16 bytes → 32 hex chars (see Reticulum manual).
 * Must match that width so pre-send size matches `_call_wire_json_bytes` in
 * presence_bridge.py. Align with `RNS.Packet.ENCRYPTED_MDU` (383 in typical builds);
 * `handle_send_*` compares `len(wire_bytes)` to that MDU.
 */
export const RT_RETICULUM_MAX_WIRE_JSON_BYTES = 383;

/** Same length as real `r` on the wire (was incorrectly 64, over-counting by ~32 bytes). */
const BRIDGE_SENDER_HASH_PLACEHOLDER = '0'.repeat(32);
/** Call/group-call overlay ids are fixed-width 64-bit hex values. */
const OVERLAY_MESSAGE_ID_PLACEHOLDER = '0'.repeat(16);

function withBridgeSender(
  obj: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...obj,
    // `r` is transport-owned. Python always replaces any inbound-hop value
    // with the authenticated sender of this hop before encoding.
    r: BRIDGE_SENDER_HASH_PLACEHOLDER,
  };
}

function withOverlayDefaults(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const out = withBridgeSender(obj);
  if (typeof out.X !== 'string') out.X = OVERLAY_MESSAGE_ID_PLACEHOLDER;
  if (typeof out.L !== 'number') out.L = 0;
  return out;
}

/**
 * Exact UTF-8 byte length after Python adds only `r`. Reticulum chat uses this
 * form because its routing metadata is already present in the supplied object.
 */
export function byteLengthUtf8JsonWithBridgeSenderOnly(
  obj: Record<string, unknown>
): number {
  return Buffer.byteLength(JSON.stringify(withBridgeSender(obj)), 'utf8');
}

/**
 * Conservative size used by call encoders before their overlay layer attaches
 * the `X` message id and `L` hop count.
 */
export function byteLengthUtf8JsonWithBridgeSender(
  obj: Record<string, unknown>
): number {
  return Buffer.byteLength(JSON.stringify(withOverlayDefaults(obj)), 'utf8');
}

export function byteLengthUtf8JsonWithBridgeSenderAndTarget(
  obj: Record<string, unknown>,
  targetAddress: string
): number {
  return Buffer.byteLength(
    JSON.stringify({
      ...withOverlayDefaults(obj),
      U: targetAddress,
    }),
    'utf8'
  );
}

export function wireFitsReticulum(obj: Record<string, unknown>): boolean {
  return (
    byteLengthUtf8JsonWithBridgeSender(obj) <= RT_RETICULUM_MAX_WIRE_JSON_BYTES
  );
}

export function wireFitsReticulumChat(obj: Record<string, unknown>): boolean {
  return (
    byteLengthUtf8JsonWithBridgeSenderOnly(obj) <=
    RT_RETICULUM_MAX_WIRE_JSON_BYTES
  );
}
