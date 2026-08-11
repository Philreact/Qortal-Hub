export type AudioSurfaceCommand =
  | {
      type: 'set-user';
      userInfo: any | null;
      myStatus: 'online' | 'busy' | 'offline';
    }
  | { type: 'set-ui-active'; uiActive: boolean }
  | {
      type: 'set-device-preferences';
      inputDeviceId: string | null;
      inputDeviceLabel?: string | null;
      inputDeviceGroupId?: string | null;
      outputDeviceId: string | null;
      outputDeviceLabel?: string | null;
      outputDeviceGroupId?: string | null;
    }
  | { type: 'list-audio-devices' }
  | {
      type: 'join-group-call';
      roomId: string;
      chatId: string;
      options?: {
        memberGateGroupId?: number;
        memberGateGroupName?: string;
      };
    }
  | { type: 'logout-cleanup' }
  | { type: 'leave-group-call' }
  | { type: 'set-muted'; muted: boolean }
  | { type: 'set-hear-call'; hearCall: boolean }
  | {
      type: 'export-diagnostics';
      options?: { download?: boolean; clipboard?: boolean };
    }
  | {
      type: 'set-audio-quality-profile';
      profile: 'low-latency' | 'high-stability';
    }
  | {
      type: 'start-direct-voice-receive';
      ownerId: string;
      roomId: string;
      peerAddress: string;
      roomKey: ArrayBuffer | Uint8Array;
      outputDeviceId?: string | null;
      hearCall?: boolean;
      profile?: 'low-latency' | 'high-stability';
    }
  | {
      type: 'update-direct-voice-receive';
      ownerId: string;
      outputDeviceId?: string | null;
      hearCall?: boolean;
      profile?: 'low-latency' | 'high-stability';
    }
  | { type: 'stop-direct-voice-receive'; ownerId: string }
  | {
      type: 'start-direct-voice-rtc';
      ownerId: string;
      roomId: string;
      peerAddress: string;
      initiator: boolean;
      inputDeviceId?: string | null;
      outputDeviceId?: string | null;
      muted?: boolean;
      hearCall?: boolean;
      iceServers: Array<{
        urls: string | string[];
        username?: string;
        credential?: string;
      }>;
    }
  | {
      type: 'apply-direct-voice-rtc-signal';
      ownerId: string;
      roomId: string;
      peerAddress: string;
      signal:
        | {
            kind: 'description';
            generation: string;
            description: RTCSessionDescriptionInit;
          }
        | {
            kind: 'ice';
            generation: string;
            candidate: RTCIceCandidateInit | null;
          }
        | {
            kind: 'ice-candidates';
            generation: string;
            candidates: RTCIceCandidateInit[];
          }
        | {
            kind: 'ice-refresh-request';
            generation: string;
          };
    }
  | { type: 'stop-direct-voice-rtc'; ownerId: string }
  | {
      type: 'start-direct-voice-media';
      ownerId: string;
      roomId: string;
      peerAddress: string;
      localAddress: string;
      roomKey: ArrayBuffer | Uint8Array;
      inputDeviceId?: string | null;
      outputDeviceId?: string | null;
      muted?: boolean;
      hearCall?: boolean;
      profile?: 'low-latency' | 'high-stability';
    }
  | {
      type: 'update-direct-voice-media';
      ownerId: string;
      inputDeviceId?: string | null;
      outputDeviceId?: string | null;
      muted?: boolean;
      hearCall?: boolean;
      profile?: 'low-latency' | 'high-stability';
    }
  | { type: 'stop-direct-voice-media'; ownerId: string }
  | { type: 'clear-join-error' };

export type AudioSurfaceResponseLike = {
  ok: boolean;
  payload?: unknown;
  error?: string;
};

export interface AudioSurfaceCommandEnvelope {
  commandId: string;
  command: AudioSurfaceCommand;
}

export interface AudioSurfaceCommandResultEnvelope {
  commandId: string;
  response: AudioSurfaceResponseLike;
}

export type AudioSurfaceEvent =
  | {
      type: 'engine-ready';
      bootstrapRevisionApplied: number;
    }
  | {
      type: 'engine-closed';
    }
  | {
      type: 'snapshot';
      snapshot: unknown;
    }
  | {
      type: 'diagnostics-exported';
      json: string;
    }
  | {
      type: 'engine-error';
      message: string;
    }
  | {
      type: 'direct-voice-media-ready';
      ownerId: string;
      roomId: string;
      peerAddress: string;
    }
  | {
      type: 'direct-voice-rtc-signal';
      ownerId: string;
      roomId: string;
      peerAddress: string;
      signal:
        | {
            kind: 'description';
            generation: string;
            description: RTCSessionDescriptionInit;
          }
        | {
            kind: 'ice';
            generation: string;
            candidate: RTCIceCandidateInit | null;
          }
        | {
            kind: 'ice-candidates';
            generation: string;
            candidates: RTCIceCandidateInit[];
          }
        | {
            kind: 'ice-refresh-request';
            generation: string;
          };
    }
  | {
      type: 'direct-voice-rtc-state';
      ownerId: string;
      roomId: string;
      peerAddress: string;
      state: 'connecting' | 'open' | 'closed' | 'failed';
    }
  | {
      type: 'direct-voice-rtc-diagnostic';
      ownerId: string;
      roomId: string;
      peerAddress: string;
      stage: string;
      detail: Record<string, unknown>;
    }
  | {
      type: 'group-call-rtc-state';
      roomId: string;
      peerAddress: string;
      state:
        | 'new'
        | 'connecting'
        | 'connected'
        | 'disconnected'
        | 'failed'
        | 'closed'
        | 'open';
    };

export interface AudioSurfaceBridgeStateLike {
  hostReady: boolean;
  bootstrapRevisionApplied: number;
  snapshot: unknown | null;
}

export function buildDefaultAudioSurfaceBridgeStateLike(): AudioSurfaceBridgeStateLike {
  return {
    hostReady: false,
    bootstrapRevisionApplied: 0,
    snapshot: null,
  };
}
