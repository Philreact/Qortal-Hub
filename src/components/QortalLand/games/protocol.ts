import type {
  ConnectFourMove,
  ConnectFourOutcome,
  ConnectFourSeat,
  ConnectFourState,
} from './connectFour';

export const QORTAL_LAND_GAME_PROTOCOL = 'qortalland-game' as const;
export const QORTAL_LAND_GAME_PROTOCOL_VERSION = 1 as const;

export type QortalLandGameBootstrap = {
  url: string;
  token: string;
  instanceId: string;
};

export type QortalLandGamePhase =
  | 'idle'
  | 'opening'
  | 'waiting'
  | 'incoming'
  | 'starting'
  | 'active'
  | 'finishing'
  | 'reconnecting'
  | 'finished';

export type QortalLandGameParticipant = {
  address: string;
  publicKey?: string;
  name?: string;
};

export type QortalLandGameMatch = {
  matchId: string;
  groupId: number;
  gameType: 'connect-four';
  rulesVersion: 1;
  requester: QortalLandGameParticipant;
  recipient: QortalLandGameParticipant;
  requesterNonce: string;
  recipientNonce?: string;
  localSeat?: ConnectFourSeat;
  startingSeat?: ConnectFourSeat;
  phase: QortalLandGamePhase;
  state?: ConnectFourState;
  stateHash?: string;
  moves: ConnectFourMove[];
  pendingMoveId?: string;
  expiresAt?: number;
  reconnectDeadline?: number;
  outcome?: ConnectFourOutcome;
  error?: string;
};

export type GameSocketCommand = {
  id: string;
  type:
    | 'AUTH'
    | 'SET_LAND_CONTEXT'
    | 'CLEAR_LAND_CONTEXT'
    | 'OPEN_GAME_LINK'
    | 'SUBMIT_HANDSHAKE_SIGNATURE'
    | 'RESPOND_TO_INVITE'
    | 'SEND_GAME_MESSAGE'
    | 'RESIGN_GAME'
    | 'CLOSE_GAME_LINK'
    | 'GET_ACTIVE_MATCH';
  [key: string]: unknown;
};

export type GameSocketEvent = {
  type: string;
  [key: string]: unknown;
};

export type ConnectFourWireMessage =
  | ({ type: 'MOVE' | 'SYNC_MOVE'; matchId: string } & ConnectFourMove)
  | {
      type: 'MOVE_ACK';
      matchId: string;
      messageId: string;
      ply: number;
      stateHash: string;
    }
  | {
      type: 'MATCH_PING' | 'MATCH_PONG' | 'RESIGN' | 'RESIGN_ACK';
      matchId: string;
      messageId: string;
    }
  | {
      type: 'GAME_OVER';
      matchId: string;
      messageId: string;
      ply: number;
      stateHash: string;
      outcome: ConnectFourOutcome;
    }
  | {
      type: 'GAME_OVER_ACK';
      matchId: string;
      messageId: string;
      ply: number;
      stateHash: string;
    }
  | { type: 'SYNC_REQUEST'; matchId: string; messageId: string; fromPly: number }
  | { type: 'PROTOCOL_ERROR'; matchId: string; messageId: string; reason: string };
