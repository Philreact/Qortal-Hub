/**
 * Compile-time DM audio transport preference.
 *
 * `true` preserves the existing Reticulum audio data plane as the primary path.
 * `false` prefers an authenticated WebRTC DataChannel and retains Reticulum as
 * the automatic fallback while ICE is connecting or unavailable.
 */
export const isReticulumCallEnabled = false;
