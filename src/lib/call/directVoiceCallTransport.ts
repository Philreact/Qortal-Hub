/**
 * Compile-time DM audio transport preference.
 *
 * `true` preserves the existing Reticulum audio data plane as the primary path.
 * `false` prefers a native WebRTC audio track negotiated over authenticated
 * Reticulum signaling and retains Reticulum as the automatic media fallback.
 */
export const isReticulumCallEnabled = false;
