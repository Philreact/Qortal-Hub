/**
 * Keep the Reticulum group-media implementation available as a production
 * fallback. When false, encrypted Opus packets prefer WebRTC DataChannels on
 * topology edges and fall back to Reticulum per edge until the channel opens.
 */
export const isReticulumGroupCallEnabled = false;
