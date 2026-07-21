import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyConnectFourMove,
  connectFourDropRow,
  createConnectFourState,
  deriveConnectFourStartingSeat,
  hashConnectFourState,
  type ConnectFourMove,
  type ConnectFourSeat,
} from './connectFour';
import {
  ConnectFourGameDialog,
  type ConnectFourGameView,
} from './ConnectFourGameDialog';

type Target = { address: string; name?: string };
type Match = ConnectFourGameView;

type Options = {
  address: string;
  publicKey?: string;
  groupId: number;
  sessionId: string;
  roomId: string;
  enabled: boolean;
  onActiveChange?: (active: boolean) => void;
  onPlayerSeen?: (address: string) => void;
  resolvePlayerName?: (address: string) => string;
};

const randomHex = (bytes: number): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value, (part) => part.toString(16).padStart(2, '0')).join('');
};

export const canSignQortalLandGameHandshake = (
  fields: Record<string, unknown>,
  current: Match | null,
  address: string,
  publicKey: string
): boolean => {
  const type = String(fields.type || '');
  if (fields.signerPublicKey !== publicKey) return false;
  if (type === 'QORTAL_LAND_GAME_DECLINE' && ['busy', 'superseded'].includes(String(fields.reason))) {
    return fields.responderAddress === address;
  }
  if (!current || fields.matchId !== current.matchId) return false;
  if (
    type === 'QORTAL_LAND_GAME_INVITE' ||
    type === 'QORTAL_LAND_GAME_RESUME_REQUEST' ||
    type === 'QORTAL_LAND_GAME_RESUME_CONFIRM'
  ) {
    const identityMatches = (
      fields.requesterAddress === address &&
      current.requesterAddress === address &&
      (!fields.recipientAddress || fields.recipientAddress === current.recipientAddress)
    );
    if (!identityMatches) return false;
    if (type === 'QORTAL_LAND_GAME_INVITE') {
      return (
        fields.protocolVersion === 1 &&
        fields.game === 'connect-four' &&
        fields.gameVersion === 1 &&
        fields.rulesVersion === 1 &&
        fields.requesterNonce === current.requesterNonce
      );
    }
    return true;
  }
  if (type === 'QORTAL_LAND_GAME_CONFIRM') {
    return (
      fields.requesterAddress === address &&
      current.requesterAddress === address &&
      fields.requesterNonce === current.requesterNonce &&
      fields.recipientNonce === current.recipientNonce
    );
  }
  if (
    type === 'QORTAL_LAND_GAME_ACCEPT' ||
    type === 'QORTAL_LAND_GAME_DECLINE' ||
    type === 'QORTAL_LAND_GAME_RESUME_ACCEPT'
  ) {
    if (fields.responderAddress !== address || current.recipientAddress !== address) {
      return false;
    }
    if (type === 'QORTAL_LAND_GAME_ACCEPT') {
      return (
        fields.requesterNonce === current.requesterNonce &&
        fields.recipientNonce === current.recipientNonce
      );
    }
    return true;
  }
  return false;
};

export function useQortalLandGame(options: Options) {
  const {
    address,
    publicKey,
    groupId,
    sessionId,
    roomId,
    enabled,
    onActiveChange,
    onPlayerSeen,
    resolvePlayerName,
  } = options;
  const [transportReady, setTransportReady] = useState(false);
  const [match, setMatch] = useState<Match | null>(null);
  const [now, setNow] = useState(Date.now());
  const socketRef = useRef<WebSocket | null>(null);
  const matchRef = useRef<Match | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const eventChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingCommandsRef = useRef(new Map<string, { type: string; matchId?: string }>());
  const moveInFlightRef = useRef(false);

  useEffect(() => { matchRef.current = match; }, [match]);
  const replaceMatch = useCallback((next: Match | null) => {
    matchRef.current = next;
    setMatch(next);
  }, []);
  const updateMatch = useCallback((updater: (current: Match | null) => Match | null) => {
    const next = updater(matchRef.current);
    matchRef.current = next;
    setMatch(next);
  }, []);
  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Game transport is unavailable');
    const requestId = crypto.randomUUID();
    pendingCommandsRef.current.set(requestId, {
      type,
      ...(typeof payload.matchId === 'string' ? { matchId: payload.matchId } : {}),
    });
    socket.send(JSON.stringify({ type, requestId, ...payload }));
    return requestId;
  }, []);

  const failProtocol = useCallback((reason: string) => {
    const current = matchRef.current;
    if (!current) return;
    try {
      if (['active', 'finishing', 'reconnecting'].includes(current.phase)) {
        send('SEND_GAME_MESSAGE', {
          matchId: current.matchId,
          message: { type: 'PROTOCOL_ERROR', messageId: crypto.randomUUID(), reason },
        });
      } else {
        send('CLOSE_GAME_LINK', { matchId: current.matchId });
      }
    } catch { /* link may already be gone */ }
    updateMatch((value) => value && ({ ...value, phase: 'finished', outcome: { type: 'protocol-error' }, error: reason }));
  }, [send, updateMatch]);

  const handleGameMessage = useCallback(async (message: Record<string, unknown>) => {
    const current = matchRef.current;
    if (!current || message.matchId !== current.matchId || !current.state || !current.localSeat) return;
    if (message.type === 'MOVE_ACK') {
      if (message.messageId !== current.pendingMoveId || message.stateHash !== current.stateHash) {
        failProtocol('Move acknowledgement did not match local state');
        return;
      }
      const acknowledged = {
        ...current,
        pendingMoveId: undefined,
        pendingSince: undefined,
        lastRoundTripMs: current.pendingSince
          ? Math.max(1, Date.now() - current.pendingSince)
          : current.lastRoundTripMs,
      };
      if (current.state.outcome) {
        send('SEND_GAME_MESSAGE', {
          matchId: current.matchId,
          message: {
            type: 'GAME_OVER',
            messageId: crypto.randomUUID(),
            ply: current.state.ply,
            stateHash: current.stateHash,
            outcome: current.state.outcome,
          },
        });
        acknowledged.phase = 'finishing';
        acknowledged.outcome = current.state.outcome;
      }
      replaceMatch(acknowledged);
      return;
    }
    if (message.type === 'RESIGN') {
      const winner = current.localSeat;
      send('SEND_GAME_MESSAGE', { matchId: current.matchId, message: { type: 'RESIGN_ACK', messageId: crypto.randomUUID() } });
      replaceMatch({ ...current, phase: 'finished', outcome: { type: 'resigned', winner } });
      return;
    }
    if (message.type === 'RESIGN_ACK') {
      replaceMatch({ ...current, phase: 'finished', outcome: current.outcome });
      return;
    }
    if (message.type === 'GAME_OVER') {
      if (
        message.ply !== current.state.ply ||
        message.stateHash !== current.stateHash ||
        JSON.stringify(message.outcome) !== JSON.stringify(current.state.outcome)
      ) {
        failProtocol('Final game state did not match');
        return;
      }
      send('SEND_GAME_MESSAGE', {
        matchId: current.matchId,
        message: {
          type: 'GAME_OVER_ACK',
          messageId: String(message.messageId || crypto.randomUUID()),
          ply: current.state.ply,
          stateHash: current.stateHash,
        },
      });
      replaceMatch({
        ...current,
        phase: 'finished',
        outcome: current.state.outcome || undefined,
      });
      return;
    }
    if (message.type === 'GAME_OVER_ACK') {
      if (message.ply !== current.state.ply || message.stateHash !== current.stateHash) {
        failProtocol('Final game acknowledgement did not match');
        return;
      }
      replaceMatch({
        ...current,
        phase: 'finished',
        outcome: current.state.outcome || current.outcome,
      });
      return;
    }
    if (message.type === 'PROTOCOL_ERROR') {
      replaceMatch({ ...current, phase: 'finished', outcome: { type: 'protocol-error' }, error: String(message.reason || '') });
      return;
    }
    if (message.type !== 'MOVE' && message.type !== 'SYNC_MOVE') return;
    const move = message as unknown as ConnectFourMove;
    try {
      if (current.pendingMoveId || move.ply !== current.state.ply + 1 || move.previousStateHash !== current.stateHash) {
        throw new Error('Unexpected move sequence');
      }
      const remoteSeat = current.localSeat === 1 ? 2 : 1;
      const next = applyConnectFourMove(current.state, remoteSeat, move.column);
      const resultingHash = await hashConnectFourState(next);
      if (resultingHash !== move.resultingStateHash) throw new Error('Move state hash mismatch');
      send('SEND_GAME_MESSAGE', {
        matchId: current.matchId,
        message: { type: 'MOVE_ACK', messageId: move.messageId, ply: move.ply, stateHash: resultingHash },
      });
      const nextMatch: Match = {
        ...current,
        state: next,
        stateHash: resultingHash,
        moves: [...current.moves, move],
      };
      if (next.outcome) {
        nextMatch.phase = 'finishing';
        nextMatch.outcome = next.outcome;
        send('SEND_GAME_MESSAGE', {
          matchId: current.matchId,
          message: { type: 'GAME_OVER', messageId: crypto.randomUUID(), ply: next.ply, stateHash: resultingHash, outcome: next.outcome },
        });
      }
      replaceMatch(nextMatch);
    } catch (error) {
      failProtocol(error instanceof Error ? error.message : 'Illegal remote move');
    }
  }, [failProtocol, replaceMatch, send]);

  const handleEvent = useCallback(async (event: Record<string, unknown>) => {
    if (event.type === 'TRANSPORT_STATE') {
      setTransportReady(event.state === 'ready');
      return;
    }
    if (event.type === 'SIGNATURE_REQUIRED') {
      const fields = event.fields;
      if (!publicKey || !fields || typeof fields !== 'object' || Array.isArray(fields)) return;
      if (!canSignQortalLandGameHandshake(fields as Record<string, unknown>, matchRef.current, address, publicKey)) {
        failProtocol('Rejected an unexpected game handshake signature request');
        return;
      }
      const response = await window.sendMessage?.('signPresenceMessage', fields, 10_000) as { signature?: string; error?: string } | undefined;
      if (!response?.signature || response.error) {
        failProtocol(response?.error || 'Wallet declined the game handshake');
        return;
      }
      send('SUBMIT_HANDSHAKE_SIGNATURE', {
        challengeId: event.challengeId,
        matchId: event.matchId,
        signature: response.signature,
        publicKey,
      });
      return;
    }
    if (event.type === 'COMMAND_RESULT' && event.ok === false) {
      const requestId = String(event.requestId || '');
      const pending = pendingCommandsRef.current.get(requestId);
      pendingCommandsRef.current.delete(requestId);
      if (!pending || !pending.matchId || pending.matchId !== matchRef.current?.matchId) {
        return;
      }
      const error = String(event.error || 'Game command failed');
      updateMatch((value) => value && ({ ...value, phase: 'finished', error }));
      return;
    }
    if (event.type === 'COMMAND_RESULT') {
      pendingCommandsRef.current.delete(String(event.requestId || ''));
      return;
    }
    if (event.type === 'GAME_LINK_STATE') {
      if (event.matchId && event.matchId !== matchRef.current?.matchId) return;
      const state = String(event.state || '');
      updateMatch((value) => value && ({
        ...value,
        phase: state === 'waiting_response' ? 'waiting' : state === 'recovering' ? 'reconnecting' : value.phase,
        reconnectDeadline: typeof event.deadlineAt === 'number' ? event.deadlineAt : value.reconnectDeadline,
      }));
      return;
    }
    if (event.type === 'GAME_INVITE_RECEIVED') {
      if (matchRef.current && event.matchId !== matchRef.current.matchId) return;
      onPlayerSeen?.(String(event.requesterAddress));
      replaceMatch({
        matchId: String(event.matchId), requesterAddress: String(event.requesterAddress),
        recipientAddress: String(event.recipientAddress || address),
        requesterNonce: String(event.requesterNonce || ''), phase: 'incoming',
        requesterName: resolvePlayerName?.(String(event.requesterAddress)),
        recipientName: 'You',
        moves: [],
        expiresAt: Number(event.expiresAt),
      });
      return;
    }
    if (event.type === 'GAME_STARTED' || event.type === 'GAME_SNAPSHOT') {
      if (matchRef.current && event.matchId !== matchRef.current.matchId) return;
      const requesterAddress = String(event.requesterAddress);
      const recipientAddress = String(event.recipientAddress);
      const requesterNonce = String(event.requesterNonce);
      const recipientNonce = String(event.recipientNonce);
      const startingSeat = await deriveConnectFourStartingSeat(
        String(event.matchId), requesterNonce, recipientNonce
      );
      const localSeat: ConnectFourSeat = address === requesterAddress ? 1 : 2;
      let state = createConnectFourState(startingSeat);
      let stateHash = await hashConnectFourState(state);
      const transcript = Array.isArray(event.transcript) ? event.transcript : [];
      const moves: ConnectFourMove[] = [];
      for (const raw of transcript) {
        if (!raw || typeof raw !== 'object') throw new Error('Invalid snapshot move');
        const move = raw as ConnectFourMove;
        if (
          move.ply !== state.ply + 1 ||
          move.previousStateHash !== stateHash ||
          !Number.isInteger(move.column)
        ) {
          throw new Error('Snapshot move sequence mismatch');
        }
        const seat = state.nextSeat;
        state = applyConnectFourMove(state, seat, move.column);
        stateHash = await hashConnectFourState(state);
        if (stateHash !== move.resultingStateHash) throw new Error('Snapshot transcript mismatch');
        moves.push(move);
      }
      let pendingMoveId: string | undefined;
      const pendingRaw = event.pendingOutboundMove;
      if (pendingRaw && typeof pendingRaw === 'object' && !Array.isArray(pendingRaw)) {
        const pending = pendingRaw as ConnectFourMove;
        if (
          state.outcome ||
          state.nextSeat !== localSeat ||
          pending.ply !== state.ply + 1 ||
          pending.previousStateHash !== stateHash ||
          typeof pending.messageId !== 'string' ||
          !Number.isInteger(pending.column)
        ) {
          throw new Error('Snapshot pending move mismatch');
        }
        state = applyConnectFourMove(state, localSeat, pending.column);
        stateHash = await hashConnectFourState(state);
        if (stateHash !== pending.resultingStateHash) {
          throw new Error('Snapshot pending move hash mismatch');
        }
        pendingMoveId = pending.messageId;
        moves.push(pending);
      }
      updateMatch((previous) => ({
        ...(previous || {} as Match), matchId: String(event.matchId), requesterAddress,
        recipientAddress, requesterNonce, recipientNonce, startingSeat,
        localSeat,
        phase: pendingMoveId ? 'active' : state.outcome ? 'finished' : 'active', state, stateHash,
        pendingMoveId,
        pendingSince: pendingMoveId ? Date.now() : undefined,
        moves,
        outcome: state.outcome || undefined,
      }));
      return;
    }
    if (event.type === 'GAME_MESSAGE' && event.message && typeof event.message === 'object') {
      await handleGameMessage(event.message as Record<string, unknown>);
      return;
    }
    if (event.type === 'GAME_INVITE_RESPONSE') {
      if (event.matchId !== matchRef.current?.matchId) return;
      if (event.accepted === true) {
        const recipientNonce = String(event.recipientNonce || '');
        if (!/^[0-9a-f]{32}$/i.test(recipientNonce)) {
          failProtocol('Accepted invitation did not include a valid recipient nonce');
          return;
        }
        updateMatch((value) => value && ({
          ...value,
          recipientNonce,
          phase: 'starting',
        }));
        return;
      }
      updateMatch((value) => value && ({
        ...value,
        phase: 'finished',
        error: `Invitation ${String(event.reason || 'declined')}`,
      }));
      return;
    }
    if (event.type === 'GAME_ENDED') {
      if (event.matchId !== matchRef.current?.matchId) return;
      const result = String(event.outcome || 'abandoned');
      updateMatch((value) => value && ({
        ...value,
        phase: 'finished',
        outcome: result === 'protocol_error' ? { type: 'protocol-error' } : result === 'abandoned' || result === 'link_closed' || result === 'land_context_cleared' ? { type: 'abandoned' } : value.outcome,
        error: result === 'declined' || result === 'expired' ? result : value.error,
      }));
    }
  }, [address, failProtocol, handleGameMessage, onPlayerSeen, publicKey, replaceMatch, resolvePlayerName, send, updateMatch]);

  useEffect(() => {
    let cancelled = false;
    let connecting = false;
    const connect = async () => {
      if (
        cancelled ||
        connecting ||
        socketRef.current ||
        !enabled ||
        !publicKey ||
        !window.qortalLandGames
      ) return;
      connecting = true;
      let bootstrap: Awaited<ReturnType<NonNullable<typeof window.qortalLandGames>['getTransportBootstrap']>>;
      try {
        bootstrap = await window.qortalLandGames.getTransportBootstrap();
      } catch {
        bootstrap = null;
      }
      connecting = false;
      if (cancelled || !bootstrap) {
        if (!cancelled) reconnectTimerRef.current = window.setTimeout(connect, 1500);
        return;
      }
      const socket = new WebSocket(bootstrap.url);
      socketRef.current = socket;
      socket.addEventListener('open', () => {
        if (cancelled || socketRef.current !== socket) {
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: 'AUTH', token: bootstrap.token, instanceId: bootstrap.instanceId }));
        socket.send(JSON.stringify({
          type: 'SET_LAND_CONTEXT', requestId: crypto.randomUUID(), address, publicKey,
          groupId: String(groupId), landSessionId: sessionId, roomId,
        }));
        socket.send(JSON.stringify({ type: 'GET_ACTIVE_MATCH', requestId: crypto.randomUUID() }));
      });
      socket.addEventListener('message', (message) => {
        if (socketRef.current !== socket) return;
        let parsed: Record<string, unknown>;
        try {
          const value = JSON.parse(String(message.data));
          if (!value || typeof value !== 'object' || Array.isArray(value)) return;
          parsed = value as Record<string, unknown>;
        } catch {
          return;
        }
        eventChainRef.current = eventChainRef.current
          .then(() => handleEvent(parsed))
          .catch((error) => {
            failProtocol(error instanceof Error ? error.message : 'Invalid game event');
          });
      });
      socket.addEventListener('close', () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        pendingCommandsRef.current.clear();
        setTransportReady(false);
        updateMatch((value) => value?.phase === 'active'
          ? { ...value, phase: 'reconnecting', reconnectDeadline: Date.now() + 30_000 }
          : value);
        if (!cancelled) reconnectTimerRef.current = window.setTimeout(connect, 1000);
      });
    };
    void connect();
    const disposeRestart = window.qortalLandGames?.onTransportRestarted(() => {
      const oldSocket = socketRef.current;
      socketRef.current = null;
      oldSocket?.close();
      void connect();
    });
    return () => {
      cancelled = true;
      disposeRestart?.();
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      try { send('CLEAR_LAND_CONTEXT'); } catch { /* already disconnected */ }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [address, enabled, failProtocol, groupId, handleEvent, publicKey, roomId, send, sessionId, updateMatch]);

  useEffect(() => {
    const active = Boolean(match && match.phase !== 'idle' && match.phase !== 'finished');
    onActiveChange?.(active);
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [match, onActiveChange]);

  const challenge = useCallback(async (target: Target) => {
    if (!transportReady || matchRef.current || target.address === address) return;
    const matchId = crypto.randomUUID();
    const requesterNonce = randomHex(16);
    replaceMatch({
      matchId,
      requesterAddress: address,
      recipientAddress: target.address,
      requesterNonce,
      requesterName: 'You',
      recipientName: target.name || resolvePlayerName?.(target.address),
      phase: 'opening',
      moves: [],
    });
    send('OPEN_GAME_LINK', { matchId, recipientAddress: target.address, requesterNonce });
  }, [address, replaceMatch, resolvePlayerName, send, transportReady]);

  const respond = useCallback((accepted: boolean) => {
    const current = matchRef.current;
    if (!current) return;
    const recipientNonce = accepted ? randomHex(16) : undefined;
    send('RESPOND_TO_INVITE', {
      matchId: current.matchId,
      decision: accepted ? 'accept' : 'decline',
      ...(accepted ? { recipientNonce } : { reason: 'declined' }),
    });
    replaceMatch({
      ...current,
      recipientNonce: recipientNonce || current.recipientNonce,
      phase: accepted ? 'starting' : 'finished',
      error: accepted ? undefined : 'declined',
    });
  }, [replaceMatch, send]);

  const playColumn = useCallback(async (column: number): Promise<boolean> => {
    const current = matchRef.current;
    if (moveInFlightRef.current || !current?.state || !current.localSeat || current.phase !== 'active' || current.pendingMoveId || current.state.nextSeat !== current.localSeat || connectFourDropRow(current.state, column) === null) return false;
    moveInFlightRef.current = true;
    try {
      const previousStateHash = current.stateHash || await hashConnectFourState(current.state);
      const next = applyConnectFourMove(current.state, current.localSeat, column);
      const resultingStateHash = await hashConnectFourState(next);
      const messageId = crypto.randomUUID();
      const move: ConnectFourMove = { messageId, ply: next.ply, column, previousStateHash, resultingStateHash };
      replaceMatch({
        ...current,
        state: next,
        stateHash: resultingStateHash,
        pendingMoveId: messageId,
        pendingSince: Date.now(),
        moves: [...current.moves, move],
      });
      send('SEND_GAME_MESSAGE', { matchId: current.matchId, message: { type: 'MOVE', ...move } });
      return true;
    } catch (error) {
      failProtocol(error instanceof Error ? error.message : 'Move failed');
      return false;
    } finally {
      moveInFlightRef.current = false;
    }
  }, [failProtocol, replaceMatch, send]);

  const resign = useCallback(() => {
    const current = matchRef.current;
    if (!current?.localSeat) return;
    if (!window.confirm('Resign this Connect Four game?')) return;
    send('RESIGN_GAME', { matchId: current.matchId });
    replaceMatch({ ...current, phase: 'finishing', outcome: { type: 'resigned', winner: current.localSeat === 1 ? 2 : 1 } });
  }, [replaceMatch, send]);

  const close = useCallback(() => {
    const current = matchRef.current;
    if (current) {
      try {
        send('CLOSE_GAME_LINK', {
          matchId: current.matchId,
          completed: current.phase === 'finished' && Boolean(current.state),
        });
      } catch { /* done */ }
    }
    replaceMatch(null);
  }, [replaceMatch, send]);

  const rematch = useCallback(() => {
    const current = matchRef.current;
    if (!current || current.phase !== 'finished' || !current.state || !transportReady) return;
    const peerAddress = current.requesterAddress === address
      ? current.recipientAddress
      : current.requesterAddress;
    const peerName = current.requesterAddress === address
      ? current.recipientName
      : current.requesterName;
    try {
      send('CLOSE_GAME_LINK', { matchId: current.matchId, completed: true });
    } catch {
      // The Python manager may already have released the completed match.
    }
    const matchId = crypto.randomUUID();
    const requesterNonce = randomHex(16);
    replaceMatch({
      matchId,
      requesterAddress: address,
      recipientAddress: peerAddress,
      requesterNonce,
      requesterName: 'You',
      recipientName: peerName || resolvePlayerName?.(peerAddress),
      phase: 'opening',
      moves: [],
    });
    send('OPEN_GAME_LINK', { matchId, recipientAddress: peerAddress, requesterNonce });
  }, [address, replaceMatch, resolvePlayerName, send, transportReady]);

  const modal = (
    <ConnectFourGameDialog
      address={address}
      match={match}
      now={now}
      onClose={close}
      onPlayColumn={playColumn}
      onRematch={rematch}
      onResign={resign}
      onRespond={respond}
      resolvePlayerName={resolvePlayerName}
      transportReady={transportReady}
    />
  );

  const presence = useMemo(() => (
    match && ['starting', 'active', 'finishing', 'reconnecting'].includes(match.phase)
      ? {
          matchId: match.matchId,
          peerAddress:
            match.requesterAddress === address
              ? match.recipientAddress
              : match.requesterAddress,
        }
      : null
  ), [address, match?.matchId, match?.phase, match?.recipientAddress, match?.requesterAddress]);

  return {
    transportReady,
    busy: Boolean(match),
    presence,
    challenge,
    modal,
  };
}
