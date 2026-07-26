"""Private Qortal Land game links and their authenticated loopback control plane.

This module deliberately exposes a small, typed command surface.  It never
accepts arbitrary Reticulum operations from the renderer.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import secrets
import threading
import time
import urllib.parse
import uuid
from collections import deque
from typing import Any, Callable, Dict, Optional

import RNS
from RNS.Channel import CEType, ChannelException, MessageBase
from RNS.vendor import umsgpack
from qortalland_proximity import PROXIMITY_COMMANDS, QortalLandProximityVoiceManager

try:
    from websockets.sync.server import serve
except ImportError:  # The frozen bundle and development bootstrap install it.
    serve = None


MAGIC = b"QLG1"
MSGTYPE = 0x0514
MAX_LOCAL_FRAME = 16 * 1024
MAX_CHANNEL_PAYLOAD = 425
AUTH_TIMEOUT = 2.0
INVITE_TTL = 60
LINK_TIMEOUT = 45
RECOVERY_WINDOW = 30
HEARTBEAT_INTERVAL = 10
PROTOCOL_VERSION = 2
GAME_CONFIGS = {
    "connect-four": {"gameVersion": 1, "rulesVersion": 1, "maxPly": 42},
    "checkers": {"gameVersion": 1, "rulesVersion": 1, "maxPly": 200},
    "chess": {"gameVersion": 1, "rulesVersion": 1, "maxPly": 600},
}
ADDRESS_VERSION = 58
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
BASE58_MAP = {c: i for i, c in enumerate(BASE58_ALPHABET)}

COMMANDS = {
    "SET_LAND_CONTEXT",
    "CLEAR_LAND_CONTEXT",
    "OPEN_GAME_LINK",
    "SUBMIT_HANDSHAKE_SIGNATURE",
    "RESPOND_TO_INVITE",
    "SEND_GAME_MESSAGE",
    "RESIGN_GAME",
    "CLOSE_GAME_LINK",
    "GET_ACTIVE_MATCH",
} | PROXIMITY_COMMANDS

HANDSHAKE_TYPES = {
    "QORTAL_LAND_GAME_INVITE",
    "QORTAL_LAND_GAME_ACCEPT",
    "QORTAL_LAND_GAME_DECLINE",
    "QORTAL_LAND_GAME_CONFIRM",
    "QORTAL_LAND_GAME_RESUME_REQUEST",
    "QORTAL_LAND_GAME_RESUME_ACCEPT",
    "QORTAL_LAND_GAME_RESUME_CONFIRM",
}

HANDSHAKE_FIELD_ORDER = {
    "QORTAL_LAND_GAME_INVITE": (
        "type", "protocolVersion", "game", "gameVersion", "rulesVersion",
        "matchId", "groupId", "requesterAddress", "recipientAddress",
        "signerPublicKey", "requesterNonce", "linkId", "createdAt", "expiresAt",
    ),
    "QORTAL_LAND_GAME_ACCEPT": (
        "type", "inviteHash", "matchId", "requesterNonce", "recipientNonce",
        "responderAddress", "signerPublicKey", "linkId", "createdAt",
    ),
    "QORTAL_LAND_GAME_DECLINE": (
        "type", "inviteHash", "matchId", "responderAddress", "signerPublicKey",
        "reason", "linkId", "createdAt",
    ),
    "QORTAL_LAND_GAME_CONFIRM": (
        "type", "acceptHash", "matchId", "requesterNonce", "recipientNonce",
        "starter", "initialStateHash", "requesterAddress", "signerPublicKey",
        "linkId", "createdAt",
    ),
    "QORTAL_LAND_GAME_RESUME_REQUEST": (
        "type", "matchId", "roundId", "requesterAddress", "signerPublicKey", "linkId",
        "requesterNonce", "lastAcknowledgedPly", "stateHash", "transcriptHash", "createdAt",
    ),
    "QORTAL_LAND_GAME_RESUME_ACCEPT": (
        "type", "matchId", "roundId", "responderAddress", "signerPublicKey", "linkId",
        "requesterNonce", "recipientNonce", "lastAcknowledgedPly", "stateHash", "transcriptHash", "createdAt",
    ),
    "QORTAL_LAND_GAME_RESUME_CONFIRM": (
        "type", "matchId", "roundId", "requesterAddress", "signerPublicKey", "linkId",
        "requesterNonce", "recipientNonce", "lastAcknowledgedPly", "stateHash", "transcriptHash", "createdAt",
    ),
}
HANDSHAKE_TYPE_CODES = {name: index + 1 for index, name in enumerate(HANDSHAKE_FIELD_ORDER)}
HANDSHAKE_TYPES_BY_CODE = {code: name for name, code in HANDSHAKE_TYPE_CODES.items()}
HEX_FIELD_LENGTHS = {
    "requesterNonce": 16,
    "recipientNonce": 16,
    "linkId": 16,
    "inviteHash": 32,
    "acceptHash": 32,
    "initialStateHash": 32,
    "stateHash": 32,
    "transcriptHash": 32,
}
ADDRESS_FIELDS = {"requesterAddress", "recipientAddress", "responderAddress"}

ACTIVE_TYPES = {
    "MOVE",
    "MOVE_ACK",
    "MATCH_PING",
    "MATCH_PONG",
    "RESIGN",
    "RESIGN_ACK",
    "GAME_OVER",
    "GAME_OVER_ACK",
    "SYNC_REQUEST",
    "SYNC_MOVE",
    "START_ACK",
    "PROTOCOL_ERROR",
    "ROUND_REQUEST",
    "ROUND_RESPONSE",
    "ROUND_CANCEL",
    "CHAT_MESSAGE",
    "CHAT_CHUNK",
    "CHAT_ACK",
    "CHAT_TYPING",
}

ROUND_PHASES = {"session_idle", "round_waiting", "round_incoming"}
ROUND_BOUND_TYPES = {"MOVE", "MOVE_ACK", "RESIGN", "RESIGN_ACK", "GAME_OVER", "GAME_OVER_ACK", "SYNC_REQUEST", "SYNC_MOVE"}
CHAT_MAX_CHARS = 500
CHAT_MAX_BYTES = 2000
CHAT_CHUNK_BYTES = 180
CHAT_HISTORY_LIMIT = 100
GAME_SEND_QUEUE_MAX = 128
GAME_SEND_FLUSH_BUDGET = 16
EPHEMERAL_GAME_MESSAGE_TYPES = {"MATCH_PING", "MATCH_PONG", "CHAT_TYPING"}


def _b58decode(value: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError("invalid base58 value")
    number = 0
    for char in value:
        if char not in BASE58_MAP:
            raise ValueError("invalid base58 character")
        number = number * 58 + BASE58_MAP[char]
    body = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\0" * (len(value) - len(value.lstrip("1"))) + body


def _b58encode(value: bytes) -> str:
    number = int.from_bytes(value, "big")
    out = ""
    while number:
        number, remainder = divmod(number, 58)
        out = BASE58_ALPHABET[remainder] + out
    return "1" * (len(value) - len(value.lstrip(b"\0"))) + (out or "")


def derive_qortal_address(public_key_b58: str) -> str:
    public_key = _b58decode(public_key_b58)
    if len(public_key) != 32:
        raise ValueError("invalid public key length")
    sha = hashlib.sha256(public_key).digest()
    ripe = hashlib.new("ripemd160", sha).digest()
    versioned = bytes([ADDRESS_VERSION]) + ripe
    checksum = hashlib.sha256(hashlib.sha256(versioned).digest()).digest()[:4]
    return _b58encode(versioned + checksum)


def canonical_bytes(fields: Dict[str, Any]) -> bytes:
    return json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def valid_hex(value: Any, byte_length: int) -> bool:
    if not isinstance(value, str) or len(value) != byte_length * 2:
        return False
    try:
        return len(bytes.fromhex(value)) == byte_length
    except ValueError:
        return False


def verify_signature(fields: Dict[str, Any], public_key_b58: str, signature_b58: str) -> bool:
    try:
        public_key = _b58decode(public_key_b58)
        signature = _b58decode(signature_b58)
        if len(public_key) != 32 or len(signature) != 64:
            return False
        RNS.Cryptography.Ed25519PublicKey.from_public_bytes(public_key).verify(
            signature, canonical_bytes(fields)
        )
        return True
    except Exception:
        return False


class GameMessage(MessageBase):
    MSGTYPE = MSGTYPE

    def __init__(self, payload: Optional[Dict[str, Any]] = None):
        self.payload = payload or {}

    def pack(self) -> bytes:
        raw = umsgpack.packb(self.payload)
        if len(raw) > MAX_CHANNEL_PAYLOAD:
            raise ValueError("game channel payload exceeds 425 bytes")
        return raw

    def unpack(self, raw: bytes):
        if len(raw) > MAX_CHANNEL_PAYLOAD:
            raise ValueError("oversized game channel payload")
        value = umsgpack.unpackb(raw)
        if not isinstance(value, dict):
            raise ValueError("game channel payload must be a map")
        self.payload = value


class QortalLandGameManager:
    def __init__(
        self,
        emit: Callable[[str, Dict[str, Any]], None],
        log: Callable[[str], None],
        resolve_peer: Callable[[str], Optional[str]],
        resolve_identity: Callable[[str], Any],
        build_destination: Callable[[Any], Any],
        link_id_bytes: Callable[[Any], bytes],
        enqueue: Callable[[Callable[..., Any], tuple], bool],
        refresh_path: Optional[Callable[[str, str], bool]] = None,
        broadcast_proximity: Optional[Callable[[Dict[str, Any]], None]] = None,
        enqueue_proximity_media: Optional[Callable[[Callable[..., Any], tuple], bool]] = None,
    ):
        self.emit = emit
        self.log = log
        self.resolve_peer = resolve_peer
        self.resolve_identity = resolve_identity
        self.build_destination = build_destination
        self.link_id_bytes = link_id_bytes
        self.enqueue = enqueue
        self.refresh_path = refresh_path
        self.lock = threading.RLock()
        self.land_context: Optional[Dict[str, Any]] = None
        self.matches: Dict[str, Dict[str, Any]] = {}
        self.links_by_object: Dict[int, str] = {}
        self.used_nonces: Dict[str, float] = {}
        self.signature_challenges: Dict[str, Dict[str, Any]] = {}
        self.socket = None
        self.socket_lock = threading.Lock()
        self.socket_send_lock = threading.Lock()
        self.socket_out: "queue.Queue[Optional[tuple[Any, Dict[str, Any]]]]" = queue.Queue(maxsize=256)
        self.socket_media_out: "deque[tuple[Any, bytes, int, float]]" = deque()
        self.socket_media_lock = threading.Lock()
        self.socket_writer_wakeup = threading.Event()
        self.server = None
        self.server_thread: Optional[threading.Thread] = None
        self.monitor_thread: Optional[threading.Thread] = None
        self.stop_event = threading.Event()
        self.token = os.environ.get("QORTAL_LAND_REALTIME_TOKEN") or os.environ.get("QORTAL_LAND_GAMES_TOKEN", "")
        self.instance_id = os.environ.get("QORTAL_LAND_REALTIME_INSTANCE_ID") or os.environ.get("QORTAL_LAND_GAMES_INSTANCE_ID", "")
        self.development = (os.environ.get("QORTAL_LAND_REALTIME_DEV") or os.environ.get("QORTAL_LAND_GAMES_DEV", "0")) == "1"
        self.proximity = QortalLandProximityVoiceManager(
            emit=self.send_event,
            send_binary=self.send_binary,
            log=log,
            resolve_peer=resolve_peer,
            resolve_identity=resolve_identity,
            build_destination=build_destination,
            link_id_bytes=link_id_bytes,
            enqueue=enqueue,
            enqueue_media=enqueue_proximity_media,
            broadcast_discovery=broadcast_proximity or (lambda _wire: None),
            verify_wallet=verify_signature,
            derive_address=derive_qortal_address,
            decode_base58=_b58decode,
        )

    def start_server(self) -> Optional[int]:
        if self.server_thread and self.server_thread.is_alive():
            return None
        if serve is None or not self.token or not self.instance_id:
            self.log("[qortalland-game] websocket unavailable: dependency or bootstrap missing")
            return None
        self.stop_event.clear()
        self.socket_writer_wakeup.clear()
        ready: "queue.Queue[int]" = queue.Queue(maxsize=1)

        def run() -> None:
            try:
                with serve(
                    self._socket_handler,
                    "127.0.0.1",
                    0,
                    max_size=MAX_LOCAL_FRAME,
                    max_queue=128,
                    origins=None,
                ) as server:
                    self.server = server
                    ready.put(server.socket.getsockname()[1])
                    server.serve_forever()
            except Exception as exc:
                self.log(f"[qortalland-game] websocket failed code=server_error err={str(exc)[:120]}")
            finally:
                self.server = None

        self.server_thread = threading.Thread(target=run, name="qortalland-game-ws", daemon=True)
        self.server_thread.start()
        try:
            port = ready.get(timeout=5)
        except queue.Empty:
            return None
        self.monitor_thread = threading.Thread(target=self._monitor, name="qortalland-game-monitor", daemon=True)
        self.monitor_thread.start()
        threading.Thread(target=self._socket_writer, name="qortalland-game-ws-writer", daemon=True).start()
        return port

    def stop(self) -> None:
        self.stop_event.set()
        self.socket_writer_wakeup.set()
        if self.server is not None:
            try:
                self.server.shutdown()
            except Exception:
                pass
        with self.socket_lock:
            socket_client = self.socket
            self.socket = None
        if socket_client is not None:
            try:
                socket_client.close(1001, "bridge stopping")
            except Exception:
                pass
        with self.lock:
            states = list(self.matches.values())
            self.matches.clear()
            self.links_by_object.clear()
        for state in states:
            self._teardown(state.get("link"))
        self.proximity.disable("bridge_stopping")

    def _origin_allowed(self, origin: Optional[str]) -> bool:
        if origin == "capacitor-electron://-":
            return True
        if self.development and isinstance(origin, str):
            try:
                parsed = urllib.parse.urlparse(origin)
                port = parsed.port
                return (
                    parsed.scheme in {"http", "https"}
                    and parsed.hostname in {"127.0.0.1", "localhost"}
                    and isinstance(port, int)
                    and 0 < port <= 65535
                    and parsed.username is None
                    and parsed.password is None
                    and parsed.path in {"", "/"}
                    and not parsed.params
                    and not parsed.query
                    and not parsed.fragment
                )
            except (TypeError, ValueError):
                return False
        return False

    def _socket_handler(self, websocket) -> None:
        origin = websocket.request.headers.get("Origin")
        if not self._origin_allowed(origin):
            websocket.close(1008, "invalid origin")
            return
        try:
            raw = websocket.recv(timeout=AUTH_TIMEOUT)
            auth = json.loads(raw) if isinstance(raw, str) else None
        except Exception:
            websocket.close(1008, "authentication required")
            return
        if (
            not isinstance(auth, dict)
            or set(auth.keys()) != {"type", "token", "instanceId"}
            or auth.get("type") != "AUTH"
            or auth.get("instanceId") != self.instance_id
            or not secrets.compare_digest(str(auth.get("token") or ""), self.token)
        ):
            websocket.close(1008, "authentication failed")
            return
        with self.socket_lock:
            previous = self.socket
            self.socket = websocket
        if previous is not None and previous is not websocket:
            try:
                previous.close(1008, "application socket replaced")
            except Exception:
                pass
        with self.socket_media_lock:
            self.socket_media_out.clear()
        self._send_direct(websocket, {"type": "TRANSPORT_STATE", "state": "ready", "instanceId": self.instance_id})
        if not self.enqueue(self._proximity_renderer_connected, ()):
            self.send_event("PROXIMITY_ERROR", {"code": "control_queue_full"})
        with self.lock:
            for state in self.matches.values():
                state.pop("renderer_lost_at", None)
        snapshot = self._active_snapshot()
        if snapshot:
            self._send_direct(websocket, {"type": "GAME_SNAPSHOT", **snapshot})
            for history in self._chat_history_batches(snapshot["matchId"]):
                self._send_direct(websocket, history)
            state = self.matches.get(str(snapshot.get("matchId") or ""))
            if state:
                for pending_move in list(state.get("pendingInboundMoves", {}).values()):
                    self._send_direct(
                        websocket,
                        {
                            "type": "GAME_MESSAGE",
                            "matchId": state["matchId"],
                            "message": pending_move,
                        },
                    )
        with self.lock:
            pending_challenges = list(self.signature_challenges.items())
        for challenge_id, challenge in pending_challenges:
            self._send_direct(
                websocket,
                {
                    "type": "SIGNATURE_REQUIRED",
                    "challengeId": challenge_id,
                    "matchId": challenge.get("matchId"),
                    "handshakeType": challenge.get("kind"),
                    "fields": challenge.get("fields"),
                },
            )
        try:
            for raw in websocket:
                if isinstance(raw, bytes):
                    if len(raw) > 2 * 1024 or not self.proximity.queue_local_audio(raw):
                        websocket.close(1009, "invalid media frame")
                        break
                    continue
                if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_LOCAL_FRAME:
                    websocket.close(1009, "frame too large")
                    break
                try:
                    message = json.loads(raw)
                except Exception:
                    websocket.close(1007, "invalid json")
                    break
                if not isinstance(message, dict) or message.get("type") not in COMMANDS:
                    self._command_result(message.get("requestId") if isinstance(message, dict) else None, False, "invalid_command")
                    continue
                if message.get("type") == "UPDATE_PROXIMITY_POSITION":
                    self.proximity.queue_position_command(message, self._command_result)
                    continue
                if not self.enqueue(self.handle_command, (message,)):
                    self._command_result(message.get("requestId"), False, "command_queue_full")
                    websocket.close(1013, "command queue full")
                    break
        finally:
            lost_current_socket = False
            with self.socket_lock:
                if self.socket is websocket:
                    self.socket = None
                    lost_current_socket = True
            if lost_current_socket:
                now = time.time()
                if not self.enqueue(self.proximity.renderer_lost, ()):
                    self.proximity.renderer_lost_at = now
                    self.proximity.transmitting = False
                with self.lock:
                    for state in self.matches.values():
                        if state.get("phase") in {"active", "ending", "session_idle", "round_waiting", "round_incoming"}:
                            state["renderer_lost_at"] = now

    def _send_direct(self, websocket, event: Dict[str, Any]) -> bool:
        try:
            with self.socket_send_lock:
                websocket.send(json.dumps(event, separators=(",", ":")))
            return True
        except Exception:
            return False

    def send_event(self, event_type: str, payload: Optional[Dict[str, Any]] = None) -> None:
        event = {"type": event_type, **(payload or {})}
        with self.socket_lock:
            socket_client = self.socket
        if socket_client is not None:
            try:
                self.socket_out.put_nowait((socket_client, event))
                self.socket_writer_wakeup.set()
            except queue.Full:
                try:
                    socket_client.close(1013, "event queue stalled")
                except Exception:
                    pass

    def send_binary(self, frame: bytes, source_id: int) -> bool:
        with self.socket_lock:
            socket_client = self.socket
        if socket_client is None:
            return False
        with self.socket_media_lock:
            source_count = sum(
                1 for _socket, _frame, queued_source, _queued_at in self.socket_media_out
                if queued_source == source_id
            )
            if source_count >= 8 or (len(self.socket_media_out) >= 128 and source_count > 0):
                for index, (_socket, _frame, queued_source, _queued_at) in enumerate(self.socket_media_out):
                    if queued_source == source_id:
                        del self.socket_media_out[index]
                        self.proximity.stats["queueDrops"] += 1
                        self.proximity.stats["rendererQueueDrops"] += 1
                        break
            elif len(self.socket_media_out) >= 128:
                self.socket_media_out.popleft()
                self.proximity.stats["queueDrops"] += 1
                self.proximity.stats["rendererQueueDrops"] += 1
            self.socket_media_out.append((socket_client, bytes(frame), source_id, time.monotonic()))
        self.socket_writer_wakeup.set()
        return True

    def _socket_writer(self) -> None:
        control_burst = 0
        while not self.stop_event.is_set():
            item = None
            if control_burst < 8:
                try:
                    item = self.socket_out.get_nowait()
                except queue.Empty:
                    pass
            if item is not None:
                socket_client, event = item
                with self.socket_lock:
                    current = self.socket
                if socket_client is current and not self._send_direct(socket_client, event):
                    try:
                        socket_client.close(1011, "event delivery failed")
                    except Exception:
                        pass
                control_burst += 1
                continue
            with self.socket_media_lock:
                media_item = self.socket_media_out.popleft() if self.socket_media_out else None
            if media_item is None:
                control_burst = 0
                if not self.socket_out.empty():
                    continue
                self.socket_writer_wakeup.wait(0.02)
                self.socket_writer_wakeup.clear()
                continue
            socket_client, frame, _source_id, queued_at = media_item
            control_burst = 0
            if time.monotonic() - queued_at > 0.2:
                continue
            with self.socket_lock:
                current = self.socket
            if socket_client is current:
                try:
                    with self.socket_send_lock:
                        socket_client.send(frame)
                except Exception:
                    try:
                        socket_client.close(1011, "media delivery failed")
                    except Exception:
                        pass

    def _proximity_renderer_connected(self) -> None:
        self.proximity.renderer_connected()
        self.proximity._emit_snapshot()

    def _command_result(self, request_id: Any, ok: bool, error: str = "", payload: Optional[Dict[str, Any]] = None) -> None:
        event: Dict[str, Any] = {"requestId": str(request_id or ""), "ok": ok}
        if error:
            event["error"] = error
        if payload:
            event["payload"] = payload
        self.send_event("COMMAND_RESULT", event)

    def handle_command(self, message: Dict[str, Any]) -> None:
        command = message.get("type")
        request_id = message.get("requestId")
        try:
            if command in PROXIMITY_COMMANDS:
                self.proximity.handle_command(message, self._command_result)
                return
            if command == "SET_LAND_CONTEXT":
                self._set_context(message)
            elif command == "CLEAR_LAND_CONTEXT":
                self._clear_context("land_context_cleared")
            elif command == "OPEN_GAME_LINK":
                self._open(message)
            elif command == "SUBMIT_HANDSHAKE_SIGNATURE":
                self._submit_signature(message)
            elif command == "RESPOND_TO_INVITE":
                self._respond(message)
            elif command == "SEND_GAME_MESSAGE":
                self._send_active(message)
            elif command == "RESIGN_GAME":
                self._send_active({**message, "message": {"type": "RESIGN", "messageId": str(uuid.uuid4())}})
            elif command == "CLOSE_GAME_LINK":
                self._cancel_or_close_match(
                    str(message.get("matchId") or ""),
                    completed=message.get("completed") is True,
                )
            elif command == "GET_ACTIVE_MATCH":
                snapshot = self._active_snapshot()
                if snapshot:
                    self.send_event("GAME_SNAPSHOT", snapshot)
                    for history in self._chat_history_batches(snapshot["matchId"]):
                        self.send_event("GAME_CHAT_HISTORY", {key: value for key, value in history.items() if key != "type"})
            self._command_result(request_id, True)
        except Exception as exc:
            self._command_result(request_id, False, str(exc)[:160])

    def _set_context(self, message: Dict[str, Any]) -> None:
        required = ("address", "publicKey", "groupId", "landSessionId", "roomId")
        context = {key: str(message.get(key) or "").strip() for key in required}
        if any(not context[key] for key in required):
            raise ValueError("incomplete_land_context")
        if derive_qortal_address(context["publicKey"]) != context["address"]:
            raise ValueError("land_identity_mismatch")
        with self.lock:
            previous = dict(self.land_context or {})
            changed_session = bool(previous) and any(
                previous.get(key) != context.get(key)
                for key in ("address", "publicKey", "groupId", "landSessionId")
            )
            match_ids = list(self.matches) if changed_session else []
        for match_id in match_ids:
            self._close_match(match_id, "land_context_changed")
        with self.lock:
            self.land_context = context
        self.proximity.set_context({**context, "instanceId": self.instance_id})

    def _clear_context(self, reason: str) -> None:
        with self.lock:
            self.land_context = None
            match_ids = list(self.matches)
        for match_id in match_ids:
            self._close_match(match_id, reason)
        self.proximity.clear_context()

    def _busy(self, except_match: str = "") -> bool:
        return any(mid != except_match and state.get("phase") not in {"ended", "closed"} for mid, state in self.matches.items())

    def _open(self, message: Dict[str, Any]) -> None:
        with self.lock:
            context = dict(self.land_context or {})
            if not context:
                raise ValueError("land_context_required")
            if self._busy():
                raise ValueError("game_busy")
        match_id = str(message.get("matchId") or "")
        recipient = str(message.get("recipientAddress") or "").strip()
        nonce = str(message.get("requesterNonce") or "").strip().lower()
        game = str(message.get("game") or "connect-four")
        config = GAME_CONFIGS.get(game)
        if not config:
            raise ValueError("unsupported_game")
        uuid.UUID(match_id)
        if len(bytes.fromhex(nonce)) != 16 or not recipient or recipient == context["address"]:
            raise ValueError("invalid_game_invitation")
        peer_hash = self.resolve_peer(recipient)
        if not peer_hash:
            raise ValueError("recipient_not_verified")
        identity = self.resolve_identity(peer_hash)
        if identity is None:
            raise ValueError("recipient_identity_unavailable")
        state = {
            "matchId": match_id,
            "roundId": match_id,
            "requester": context["address"],
            "recipient": recipient,
            "requesterPublicKey": context["publicKey"],
            "requesterNonce": nonce,
            "groupId": context["groupId"],
            "game": game,
            "gameVersion": config["gameVersion"],
            "rulesVersion": config["rulesVersion"],
            "peerHash": peer_hash,
            "phase": "establishing",
            "outbound": True,
            "establishDeadline": time.time() + LINK_TIMEOUT,
            "openAttempts": 0,
            "createdAt": int(time.time() * 1000),
            "expiresAt": int((time.time() + INVITE_TTL) * 1000),
            "transcript": [],
            "lastActivity": time.time(),
            "lastRx": time.time(),
            "initialStateHash": str(message.get("initialStateHash") or ""),
        }
        with self.lock:
            self.matches[match_id] = state
        timer = threading.Timer(LINK_TIMEOUT, self._queue_establish_timeout, args=(match_id,))
        timer.daemon = True
        state["establishTimer"] = timer
        timer.start()
        self.send_event("GAME_LINK_STATE", {"matchId": match_id, "state": "establishing"})
        self.log(
            f"[qortalland-game] link opening match={match_id[:8]} peer={str(peer_hash)[:8]}"
        )
        self._attempt_open(match_id)

    def _queue_establish_timeout(self, match_id: str) -> None:
        self.enqueue(self._establish_timeout, (match_id,))

    def _schedule_open_retry(self, match_id: str, delay: float = 1.0) -> None:
        state = self.matches.get(match_id)
        if not state or state.get("phase") != "establishing" or state.get("openRetryTimer"):
            return

        def fire() -> None:
            current = self.matches.get(match_id)
            if current:
                current.pop("openRetryTimer", None)
            self.enqueue(self._attempt_open, (match_id,))

        timer = threading.Timer(delay, fire)
        timer.daemon = True
        state["openRetryTimer"] = timer
        timer.start()

    def _attempt_open(self, match_id: str) -> None:
        state = self.matches.get(match_id)
        if (
            not state
            or state.get("phase") != "establishing"
            or state.get("link") is not None
            or time.time() >= float(state.get("establishDeadline") or 0)
        ):
            return
        try:
            identity = self.resolve_identity(state["peerHash"])
            if identity is None:
                raise ValueError("recipient_identity_unavailable")
            destination = self.build_destination(identity)
            destination_hash = bytes(destination.hash)
            if destination_hash.hex() != str(state["peerHash"]).lower():
                raise ValueError("recipient_destination_mismatch")
            if not RNS.Transport.has_path(destination_hash):
                refreshed = False
                if self.refresh_path is not None:
                    try:
                        refreshed = self.refresh_path(
                            state["peerHash"],
                            "game_link_no_path",
                        ) is True
                    except Exception as exc:
                        self.log(
                            f"[qortalland-game] path refresh failed match={match_id[:8]} "
                            f"peer={str(state['peerHash'])[:8]} code={str(exc)[:80]}"
                        )
                if not refreshed:
                    RNS.Transport.request_path(destination_hash)
                self.log(
                    f"[qortalland-game] path refresh requested match={match_id[:8]} "
                    f"peer={str(state['peerHash'])[:8]} hard={str(self.refresh_path is not None).lower()}"
                )
                self._schedule_open_retry(match_id)
                return
            state["openAttempts"] = int(state.get("openAttempts") or 0) + 1
            link = RNS.Link(
                destination,
                established_callback=self._outbound_established,
                closed_callback=self._link_closed,
            )
            state["link"] = link
            with self.lock:
                self.links_by_object[id(link)] = match_id
            self.log(
                f"[qortalland-game] link attempt match={match_id[:8]} peer={str(state['peerHash'])[:8]} attempt={state['openAttempts']}"
            )
        except Exception as exc:
            self.log(
                f"[qortalland-game] link attempt failed match={match_id[:8]} code={str(exc)[:80]}"
            )
            self._schedule_open_retry(match_id)

    def _outbound_established(self, link) -> None:
        state = self._state_for_link(link)
        if not state:
            return
        timer = state.pop("establishTimer", None)
        if timer:
            timer.cancel()
        retry_timer = state.pop("openRetryTimer", None)
        if retry_timer:
            retry_timer.cancel()
        self.log(
            f"[qortalland-game] link established match={state['matchId'][:8]} peer={str(state.get('peerHash') or '')[:8]} attempt={int(state.get('openAttempts') or 0)}"
        )
        self._configure_channel(state)
        state["phase"] = "awaiting_invite_signature"
        state["linkId"] = self.link_id_bytes(link).hex()
        fields = self._invite_fields(state)
        self._require_signature(state, "QORTAL_LAND_GAME_INVITE", fields)
        self.send_event("GAME_LINK_STATE", {"matchId": state["matchId"], "state": "established"})

    def _invite_fields(self, state: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "type": "QORTAL_LAND_GAME_INVITE",
            "protocolVersion": PROTOCOL_VERSION,
            "game": state["game"],
            "gameVersion": state["gameVersion"],
            "rulesVersion": state["rulesVersion"],
            "matchId": state["matchId"],
            "groupId": state["groupId"],
            "requesterAddress": state["requester"],
            "recipientAddress": state["recipient"],
            "signerPublicKey": state["requesterPublicKey"],
            "requesterNonce": state["requesterNonce"],
            "linkId": state["linkId"],
            "createdAt": state["createdAt"],
            "expiresAt": state["expiresAt"],
        }

    def _require_signature(self, state: Dict[str, Any], kind: str, fields: Dict[str, Any]) -> None:
        challenge_id = str(uuid.uuid4())
        self.signature_challenges[challenge_id] = {"matchId": state["matchId"], "kind": kind, "fields": fields, "created": time.time()}
        self.send_event("SIGNATURE_REQUIRED", {"challengeId": challenge_id, "matchId": state["matchId"], "handshakeType": kind, "fields": fields})

    def _submit_signature(self, message: Dict[str, Any]) -> None:
        challenge_id = str(message.get("challengeId") or "")
        challenge = self.signature_challenges.get(challenge_id)
        if not challenge or time.time() - challenge["created"] > INVITE_TTL:
            self.signature_challenges.pop(challenge_id, None)
            raise ValueError("signature_challenge_expired")
        public_key = str(message.get("publicKey") or "")
        signature = str(message.get("signature") or "")
        fields = challenge["fields"]
        if fields.get("signerPublicKey") != public_key or not verify_signature(fields, public_key, signature):
            raise ValueError("invalid_handshake_signature")
        signer = derive_qortal_address(public_key)
        expected = (
            fields.get("requesterAddress")
            if challenge["kind"] in {
                "QORTAL_LAND_GAME_INVITE",
                "QORTAL_LAND_GAME_CONFIRM",
                "QORTAL_LAND_GAME_RESUME_REQUEST",
                "QORTAL_LAND_GAME_RESUME_CONFIRM",
            }
            else fields.get("responderAddress")
        )
        if signer != expected:
            raise ValueError("handshake_signer_mismatch")
        self.signature_challenges.pop(challenge_id, None)
        state = self.matches.get(challenge["matchId"])
        if not state:
            raise ValueError("match_not_found")
        envelope = {"fields": fields, "publicKey": public_key, "signature": signature}
        kind = challenge["kind"]
        if kind == "QORTAL_LAND_GAME_INVITE":
            raw = MAGIC + umsgpack.packb(self._encode_handshake(envelope))
            if len(raw) > MAX_CHANNEL_PAYLOAD:
                raise ValueError("invite_payload_too_large")
            if not self._send_raw(state["link"], raw):
                raise ValueError("invite_send_failed")
            state["inviteEnvelope"] = envelope
            state["inviteHash"] = hashlib.sha256(canonical_bytes(envelope)).hexdigest()
            state["phase"] = "awaiting_response"
            self.send_event("GAME_LINK_STATE", {"matchId": state["matchId"], "state": "waiting_response"})
        elif kind == "QORTAL_LAND_GAME_RESUME_REQUEST":
            raw = MAGIC + umsgpack.packb(self._encode_handshake(envelope))
            if len(raw) > MAX_CHANNEL_PAYLOAD or not self._send_raw(state["link"], raw):
                raise ValueError("resume_send_failed")
            state["phase"] = "awaiting_resume_accept"
        else:
            self._send_channel(state, {"k": "handshake", "e": self._encode_handshake(envelope)})
            if kind.endswith("DECLINE"):
                close_timer = threading.Timer(
                    3,
                    self._close_match,
                    args=(state["matchId"], "declined"),
                )
                close_timer.daemon = True
                close_timer.start()
            elif kind == "QORTAL_LAND_GAME_ACCEPT":
                state["acceptEnvelope"] = envelope
                state["phase"] = "awaiting_confirm"
            elif kind == "QORTAL_LAND_GAME_RESUME_ACCEPT":
                state["phase"] = "awaiting_resume_confirm"
            elif kind.endswith("CONFIRM"):
                state["phase"] = "awaiting_start_ack"

    def _encode_handshake(self, envelope: Dict[str, Any]) -> Dict[str, Any]:
        # Field names are compacted by position; canonical verification rebuilds the exact object.
        fields = envelope["fields"]
        kind = str(fields.get("type") or "")
        order = HANDSHAKE_FIELD_ORDER.get(kind)
        if order is None or set(fields) != set(order):
            raise ValueError("invalid_handshake_schema")
        values = []
        for key in order:
            if key in {"type", "signerPublicKey"}:
                continue
            value = fields[key]
            if key in {"matchId", "roundId"}:
                value = uuid.UUID(str(value)).bytes
            elif key in HEX_FIELD_LENGTHS:
                value = bytes.fromhex(str(value))
                expected = HEX_FIELD_LENGTHS[key]
                if expected is not None and len(value) != expected:
                    raise ValueError("invalid_handshake_binary_field")
            elif key in ADDRESS_FIELDS:
                value = _b58decode(str(value))
            values.append(value)
        return {"t": HANDSHAKE_TYPE_CODES[kind], "v": values, "p": _b58decode(envelope["publicKey"]), "s": _b58decode(envelope["signature"])}

    def _decode_handshake(self, packed: Dict[str, Any]) -> Dict[str, Any]:
        kind = HANDSHAKE_TYPES_BY_CODE.get(packed.get("t"), "")
        order = HANDSHAKE_FIELD_ORDER.get(kind)
        values = packed.get("v")
        wire_order = [key for key in (order or ()) if key not in {"type", "signerPublicKey"}]
        if order is None or not isinstance(values, list) or len(values) != len(wire_order):
            raise ValueError("invalid_handshake_fields")
        public_key = _b58encode(bytes(packed.get("p") or b""))
        fields: Dict[str, Any] = {"type": kind, "signerPublicKey": public_key}
        for key, value in zip(wire_order, values):
            if key in {"matchId", "roundId"}:
                value = str(uuid.UUID(bytes=bytes(value)))
            elif key in HEX_FIELD_LENGTHS:
                value = bytes(value).hex()
            elif key in ADDRESS_FIELDS:
                value = _b58encode(bytes(value))
            fields[key] = value
        return {"fields": fields, "publicKey": public_key, "signature": _b58encode(bytes(packed.get("s") or b""))}

    def handle_classifier(self, link, raw: bytes) -> bool:
        if not isinstance(raw, (bytes, bytearray)) or not bytes(raw).startswith(MAGIC):
            return False
        if len(raw) > MAX_CHANNEL_PAYLOAD:
            self._teardown(link)
            return True
        try:
            envelope = self._decode_handshake(umsgpack.unpackb(bytes(raw)[len(MAGIC):]))
            fields = envelope["fields"]
            if fields.get("type") == "QORTAL_LAND_GAME_RESUME_REQUEST":
                self._adopt_resume_link(link, envelope)
                return True
            if fields.get("linkId") != self.link_id_bytes(link).hex():
                raise ValueError("wrong_link_identifier")
            self._validate_invite(fields, envelope)
            match_id = fields["matchId"]
            with self.lock:
                context = dict(self.land_context or {})
                existing = next((s for s in self.matches.values() if s.get("phase") not in {"closed", "ended"}), None)
            if existing:
                # Deterministically resolve crossed invitations.
                if existing.get("outbound") and uuid.UUID(match_id).bytes < uuid.UUID(existing["matchId"]).bytes:
                    self._close_match(existing["matchId"], "superseded")
                else:
                    self._prepare_signed_busy_decline(
                        link,
                        envelope,
                        "superseded" if existing.get("outbound") else "busy",
                    )
                    return True
            state = {
                "matchId": match_id,
                "roundId": match_id,
                "requester": fields["requesterAddress"],
                "recipient": fields["recipientAddress"],
                "requesterPublicKey": fields["signerPublicKey"],
                "requesterNonce": fields["requesterNonce"],
                "groupId": fields["groupId"],
                "game": fields["game"],
                "gameVersion": fields["gameVersion"],
                "rulesVersion": fields["rulesVersion"],
                "linkId": fields["linkId"],
                "link": link,
                "outbound": False,
                "phase": "invited",
                "inviteEnvelope": envelope,
                "inviteHash": hashlib.sha256(canonical_bytes(envelope)).hexdigest(),
                "createdAt": fields["createdAt"],
                "expiresAt": fields["expiresAt"],
                "transcript": [],
                "lastActivity": time.time(),
                "lastRx": time.time(),
            }
            with self.lock:
                self.matches[match_id] = state
                self.links_by_object[id(link)] = match_id
            self._configure_channel(state)
            self.send_event(
                "GAME_INVITE_RECEIVED",
                {
                    "matchId": match_id,
                    "requesterAddress": state["requester"],
                    "recipientAddress": state["recipient"],
                    "requesterNonce": state["requesterNonce"],
                    "game": state["game"],
                    "gameVersion": state["gameVersion"],
                    "rulesVersion": state["rulesVersion"],
                    "expiresAt": state["expiresAt"],
                },
            )
        except Exception as exc:
            self.log(f"[qortalland-game] invite rejected code={str(exc)[:80]}")
            self._teardown(link)
        return True

    def _prepare_signed_busy_decline(self, link, envelope: Dict[str, Any], reason: str) -> None:
        fields = envelope["fields"]
        context = self.land_context
        if not context or self.socket is None:
            self._teardown(link)
            return
        match_id = fields["matchId"]
        state = {
            "matchId": match_id,
            "roundId": match_id,
            "requester": fields["requesterAddress"],
            "recipient": fields["recipientAddress"],
            "requesterPublicKey": fields["signerPublicKey"],
            "requesterNonce": fields["requesterNonce"],
            "groupId": fields["groupId"],
            "game": fields["game"],
            "gameVersion": fields["gameVersion"],
            "rulesVersion": fields["rulesVersion"],
            "linkId": fields["linkId"],
            "link": link,
            "outbound": False,
            "phase": "busy_decline",
            "inviteEnvelope": envelope,
            "inviteHash": hashlib.sha256(canonical_bytes(envelope)).hexdigest(),
            "createdAt": fields["createdAt"],
            "expiresAt": fields["expiresAt"],
            "transcript": [],
            "lastActivity": time.time(),
            "lastRx": time.time(),
        }
        with self.lock:
            self.matches[match_id] = state
            self.links_by_object[id(link)] = match_id
        self._configure_channel(state)
        decline_fields = {
            "type": "QORTAL_LAND_GAME_DECLINE",
            "inviteHash": state["inviteHash"],
            "matchId": match_id,
            "responderAddress": context["address"],
            "signerPublicKey": context["publicKey"],
            "reason": reason,
            "linkId": state["linkId"],
            "createdAt": int(time.time() * 1000),
        }
        self._require_signature(state, decline_fields["type"], decline_fields)

    def _resume_state_fields(self, state: Dict[str, Any]) -> Dict[str, Any]:
        return self._transcript_summary(state, len(state.get("transcript") or []))

    def _transcript_summary(self, state: Dict[str, Any], ply: int) -> Dict[str, Any]:
        transcript = list(state.get("transcript") or [])[:max(0, int(ply))]
        transcript_hash = hashlib.sha256(
            json.dumps(transcript, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        state_hash = (
            str(transcript[-1].get("resultingStateHash") or "")
            if transcript
            else self._initial_state_hash(state)
        )
        return {
            "lastAcknowledgedPly": len(transcript),
            "stateHash": state_hash,
            "transcriptHash": transcript_hash,
        }

    def _adopt_resume_link(self, link, envelope: Dict[str, Any]) -> None:
        fields = envelope["fields"]
        match_id = str(fields.get("matchId") or "")
        state = self.matches.get(match_id)
        context = self.land_context or {}
        if not state or state.get("phase") != "recovering" or state.get("outbound"):
            raise ValueError("resume_match_unavailable")
        if (
            fields.get("requesterAddress") != state["requester"]
            or fields.get("roundId") != (state.get("roundId") or state["matchId"])
            or context.get("address") != state["recipient"]
            or fields.get("signerPublicKey") != envelope["publicKey"]
            or derive_qortal_address(envelope["publicKey"]) != state["requester"]
            or fields.get("linkId") != self.link_id_bytes(link).hex()
            or not verify_signature(fields, envelope["publicKey"], envelope["signature"])
        ):
            raise ValueError("invalid_resume_request")
        created_at = fields.get("createdAt")
        if (
            not isinstance(created_at, int)
            or isinstance(created_at, bool)
            or abs(int(time.time() * 1000) - created_at) > RECOVERY_WINDOW * 1000
        ):
            raise ValueError("stale_resume_request")
        if (
            not valid_hex(fields.get("requesterNonce"), 16)
            or not valid_hex(fields.get("stateHash"), 32)
            or not valid_hex(fields.get("transcriptHash"), 32)
            or not isinstance(fields.get("lastAcknowledgedPly"), int)
            or isinstance(fields.get("lastAcknowledgedPly"), bool)
        ):
            raise ValueError("invalid_resume_fields")
        nonce_key = f"resume:{state['requester']}:{fields.get('requesterNonce')}"
        if self.used_nonces.get(nonce_key, 0) > time.time():
            raise ValueError("replayed_resume_nonce")
        local = self._resume_state_fields(state)
        remote_ply = int(fields.get("lastAcknowledgedPly") or 0)
        local_ply = int(local["lastAcknowledgedPly"])
        if remote_ply < 0 or remote_ply > int(GAME_CONFIGS[state["game"]]["maxPly"]):
            raise ValueError("invalid_resume_ply")
        if remote_ply <= local_ply:
            expected = self._transcript_summary(state, remote_ply)
            if fields.get("stateHash") != expected["stateHash"] or fields.get("transcriptHash") != expected["transcriptHash"]:
                raise ValueError("resume_state_conflict")
        state["peerResumePly"] = remote_ply
        self.used_nonces[nonce_key] = time.time() + 5 * 60
        old_link = state.get("link")
        with self.lock:
            if old_link is not None:
                self.links_by_object.pop(id(old_link), None)
            self.links_by_object[id(link)] = match_id
        state["link"] = link
        state["linkId"] = fields["linkId"]
        state["resumeRequesterNonce"] = fields["requesterNonce"]
        state["lastActivity"] = time.time()
        state["lastRx"] = time.time()
        self._configure_channel(state)
        responder_nonce = secrets.token_hex(16)
        state["resumeRecipientNonce"] = responder_nonce
        accept_fields = {
            "type": "QORTAL_LAND_GAME_RESUME_ACCEPT",
            "matchId": match_id,
            "roundId": state.get("roundId") or match_id,
            "responderAddress": state["recipient"],
            "signerPublicKey": context.get("publicKey"),
            "linkId": state["linkId"],
            "requesterNonce": state["resumeRequesterNonce"],
            "recipientNonce": responder_nonce,
            **local,
            "createdAt": int(time.time() * 1000),
        }
        state["phase"] = "awaiting_resume_confirm"
        self._require_signature(state, accept_fields["type"], accept_fields)

    def owns_link(self, link) -> bool:
        with self.lock:
            return id(link) in self.links_by_object

    def _validate_invite(self, fields: Dict[str, Any], envelope: Dict[str, Any]) -> None:
        context = self.land_context
        if not context:
            raise ValueError("unavailable")
        config = GAME_CONFIGS.get(str(fields.get("game") or ""))
        if (
            fields.get("type") != "QORTAL_LAND_GAME_INVITE"
            or fields.get("protocolVersion") != PROTOCOL_VERSION
            or not config
            or fields.get("gameVersion") != config["gameVersion"]
            or fields.get("rulesVersion") != config["rulesVersion"]
        ):
            raise ValueError("unsupported")
        if fields.get("recipientAddress") != context.get("address") or fields.get("groupId") != context.get("groupId"):
            raise ValueError("wrong_recipient")
        now_ms = int(time.time() * 1000)
        created_at = fields.get("createdAt")
        expires_at = fields.get("expiresAt")
        if (
            not isinstance(created_at, int)
            or isinstance(created_at, bool)
            or not isinstance(expires_at, int)
            or isinstance(expires_at, bool)
            or expires_at <= now_ms
            or created_at > now_ms + 30_000
            or created_at < now_ms - INVITE_TTL * 1000
            or expires_at <= created_at
            or expires_at - created_at > INVITE_TTL * 1000
        ):
            raise ValueError("expired")
        uuid.UUID(str(fields.get("matchId") or ""))
        if len(bytes.fromhex(str(fields.get("requesterNonce") or ""))) != 16:
            raise ValueError("invalid_nonce")
        nonce_key = f"{fields.get('requesterAddress')}:{fields.get('requesterNonce')}"
        if self.used_nonces.get(nonce_key, 0) > time.time():
            raise ValueError("replayed_nonce")
        public_key = envelope["publicKey"]
        if fields.get("signerPublicKey") != public_key or derive_qortal_address(public_key) != fields.get("requesterAddress") or not verify_signature(fields, public_key, envelope["signature"]):
            raise ValueError("invalid_signature")
        if not self.resolve_peer(str(fields.get("requesterAddress") or "")):
            raise ValueError("unverified_peer")
        self.used_nonces[nonce_key] = time.time() + 5 * 60

    def _respond(self, message: Dict[str, Any]) -> None:
        match_id = str(message.get("matchId") or "")
        decision = str(message.get("decision") or "").lower()
        state = self.matches.get(match_id)
        context = self.land_context or {}
        if not state or state.get("phase") != "invited" or decision not in {"accept", "decline"}:
            raise ValueError("invalid_invite_response")
        now = int(time.time() * 1000)
        if now >= int(state.get("expiresAt") or 0):
            self._close_match(match_id, "expired")
            raise ValueError("invite_expired")
        if decision == "accept":
            recipient_nonce = str(message.get("recipientNonce") or secrets.token_hex(16)).lower()
            if len(bytes.fromhex(recipient_nonce)) != 16:
                raise ValueError("invalid_nonce")
            state["recipientNonce"] = recipient_nonce
            fields = {
                "type": "QORTAL_LAND_GAME_ACCEPT",
                "inviteHash": state["inviteHash"],
                "matchId": match_id,
                "requesterNonce": state["requesterNonce"],
                "recipientNonce": recipient_nonce,
                "responderAddress": context["address"],
                "signerPublicKey": context["publicKey"],
                "linkId": state["linkId"],
                "createdAt": now,
            }
            self._require_signature(state, fields["type"], fields)
        else:
            fields = {
                "type": "QORTAL_LAND_GAME_DECLINE",
                "inviteHash": state["inviteHash"],
                "matchId": match_id,
                "responderAddress": context["address"],
                "signerPublicKey": context["publicKey"],
                "reason": str(message.get("reason") or "declined")[:32],
                "linkId": state["linkId"],
                "createdAt": now,
            }
            self._require_signature(state, fields["type"], fields)

    def _configure_channel(self, state: Dict[str, Any]) -> None:
        link = state["link"]
        link.set_link_closed_callback(self._link_closed)
        channel = link.get_channel()
        channel.register_message_type(GameMessage)
        channel.add_message_handler(lambda message: self._on_channel(state["matchId"], message))
        state["channel"] = channel

    def _send_channel(self, state: Dict[str, Any], payload: Dict[str, Any]) -> None:
        if len(umsgpack.packb(payload)) > MAX_CHANNEL_PAYLOAD:
            raise ValueError("channel_payload_too_large")
        envelope = state["channel"].send(GameMessage(payload))
        state["lastActivity"] = time.time()
        if envelope is None:
            raise ValueError("channel_send_failed")

    @staticmethod
    def _is_channel_temporarily_unavailable(exc: Exception) -> bool:
        return (
            isinstance(exc, ChannelException)
            and getattr(exc, "type", None) == CEType.ME_LINK_NOT_READY
        ) or str(exc).lower() in {
            "channel_send_failed",
            "('link is not ready',)",
            "('outlet did not transmit packet',)",
        }

    @staticmethod
    def _game_send_key(payload: Dict[str, Any]) -> str:
        message = payload.get("m") if isinstance(payload, dict) else None
        if not isinstance(message, dict):
            return ""
        message_type = str(message.get("type") or "")
        message_id = str(message.get("messageId") or "")
        if not message_type:
            return ""
        if message_type == "START_ACK":
            return message_type
        if not message_id:
            return ""
        if message_type == "CHAT_CHUNK":
            return f"{message_type}:{message_id}:{message.get('index')}"
        return f"{message_type}:{message_id}"

    @staticmethod
    def _is_ephemeral_game_payload(payload: Dict[str, Any]) -> bool:
        message = payload.get("m") if isinstance(payload, dict) else None
        return (
            isinstance(message, dict)
            and str(message.get("type") or "") in EPHEMERAL_GAME_MESSAGE_TYPES
        )

    def _queue_game_payload(
        self,
        state: Dict[str, Any],
        payload: Dict[str, Any],
        recovery_priority: bool = False,
    ) -> bool:
        if self._is_ephemeral_game_payload(payload):
            return False
        with self.lock:
            priority_queue = state.setdefault("recoveryGameSendQueue", deque())
            normal_queue = state.setdefault("gameSendQueue", deque())
            key = self._game_send_key(payload)
            if key and any(
                self._game_send_key(queued) == key
                for queued in (*priority_queue, *normal_queue)
            ):
                return True
            if len(priority_queue) + len(normal_queue) >= GAME_SEND_QUEUE_MAX:
                raise ValueError("game_send_queue_full")
            (priority_queue if recovery_priority else normal_queue).append(payload)
        return True

    def _send_game_payload(
        self,
        state: Dict[str, Any],
        message: Dict[str, Any],
        recovery_priority: bool = False,
    ) -> bool:
        payload = {"k": "game", "m": message}
        with self.lock:
            priority_queue = state.setdefault("recoveryGameSendQueue", deque())
            normal_queue = state.setdefault("gameSendQueue", deque())
            has_queued_payload = bool(priority_queue or normal_queue)
        if has_queued_payload:
            queued = self._queue_game_payload(
                state,
                payload,
                recovery_priority=recovery_priority,
            )
            self._flush_game_send_queue(state)
            return queued
        try:
            self._send_channel(state, payload)
            return True
        except Exception as exc:
            if not self._is_channel_temporarily_unavailable(exc):
                raise
            queued = self._queue_game_payload(
                state,
                payload,
                recovery_priority=recovery_priority,
            )
            now = time.time()
            if queued and now - float(state.get("lastGameSendDeferredLog") or 0) >= 2:
                state["lastGameSendDeferredLog"] = now
                self.log(
                    f"[qortalland-game] send deferred match={state['matchId'][:8]} "
                    f"queued={len(priority_queue) + len(normal_queue)} code=channel_not_ready"
                )
            return queued

    def _flush_game_send_queue(self, state: Dict[str, Any]) -> None:
        if state.get("phase") not in {"active", "ending", *ROUND_PHASES}:
            return
        with self.lock:
            if state.get("gameSendFlushActive"):
                return
            state["gameSendFlushActive"] = True
        try:
            sent = 0
            while sent < GAME_SEND_FLUSH_BUDGET:
                with self.lock:
                    priority_queue = state.setdefault("recoveryGameSendQueue", deque())
                    normal_queue = state.setdefault("gameSendQueue", deque())
                    queue_to_use = priority_queue if priority_queue else normal_queue
                    if not queue_to_use:
                        return
                    payload = queue_to_use[0]
                    queued_message = payload.get("m") if isinstance(payload, dict) else None
                    if (
                        isinstance(queued_message, dict)
                        and queued_message.get("type") == "MOVE"
                        and queued_message.get("roundId") == state.get("roundId")
                        and queued_message.get("messageId")
                    ):
                        state.setdefault("pendingOutboundMoves", {}).setdefault(
                            str(queued_message["messageId"]),
                            {**queued_message, "type": "MOVE"},
                        )
                try:
                    self._send_channel(state, payload)
                except Exception as exc:
                    if not self._is_channel_temporarily_unavailable(exc):
                        self.log(
                            f"[qortalland-game] queued send failed match={state['matchId'][:8]} "
                            f"code={str(exc)[:80]}"
                        )
                    return
                with self.lock:
                    if queue_to_use and queue_to_use[0] is payload:
                        queue_to_use.popleft()
                sent += 1
        finally:
            with self.lock:
                state["gameSendFlushActive"] = False

    def _flush_game_send_queues(self) -> None:
        with self.lock:
            states = list(self.matches.values())
        for state in states:
            self._flush_game_send_queue(state)

    def _current_state_hash(self, state: Dict[str, Any]) -> str:
        transcript = state.get("transcript") or []
        return (
            str(transcript[-1].get("resultingStateHash") or "")
            if transcript
            else self._initial_state_hash(state)
        )

    def _validate_move_shape(self, state: Dict[str, Any], move: Dict[str, Any]) -> None:
        try:
            uuid.UUID(str(move.get("messageId") or ""))
        except Exception as exc:
            raise ValueError("invalid_move_message_id") from exc
        ply = move.get("ply")
        game = str(state.get("game") or "connect-four")
        max_ply = int(GAME_CONFIGS.get(game, {}).get("maxPly") or 0)
        if not isinstance(ply, int) or isinstance(ply, bool) or ply < 1 or ply > max_ply:
            raise ValueError("invalid_move_ply")
        if game == "connect-four":
            column = move.get("column")
            if not isinstance(column, int) or isinstance(column, bool) or column < 0 or column > 6:
                raise ValueError("invalid_move_column")
        elif game == "checkers":
            origin = move.get("from")
            path = move.get("path")
            if (
                not isinstance(origin, int) or isinstance(origin, bool) or origin < 0 or origin > 63
                or not isinstance(path, list) or not 1 <= len(path) <= 12
                or any(not isinstance(square, int) or isinstance(square, bool) or square < 0 or square > 63 for square in path)
            ):
                raise ValueError("invalid_checkers_move")
        elif game == "chess":
            origin = move.get("from")
            destination = move.get("to")
            promotion = move.get("promotion")
            if (
                not isinstance(origin, int) or isinstance(origin, bool) or origin < 0 or origin > 63
                or not isinstance(destination, int) or isinstance(destination, bool) or destination < 0 or destination > 63
                or (
                    promotion is not None
                    and (
                        not isinstance(promotion, int)
                        or isinstance(promotion, bool)
                        or promotion not in {2, 3, 4, 5}
                    )
                )
            ):
                raise ValueError("invalid_chess_move")
        else:
            raise ValueError("unsupported_game")
        if ply != len(state.get("transcript") or []) + 1:
            raise ValueError("unexpected_move_ply")
        previous_hash = str(move.get("previousStateHash") or "")
        resulting_hash = str(move.get("resultingStateHash") or "")
        if len(previous_hash) != 64 or len(resulting_hash) != 64:
            raise ValueError("invalid_move_hash")
        bytes.fromhex(previous_hash)
        bytes.fromhex(resulting_hash)
        if previous_hash != self._current_state_hash(state):
            raise ValueError("move_previous_hash_mismatch")

    @staticmethod
    def _same_move(left: Dict[str, Any], right: Dict[str, Any]) -> bool:
        keys = ("roundId", "messageId", "ply", "column", "from", "to", "path", "promotion", "previousStateHash", "resultingStateHash")
        return all(left.get(key) == right.get(key) for key in keys)

    def _reset_round(
        self, state: Dict[str, Any], round_id: str, requester_nonce: str,
        recipient_nonce: str, game: Optional[str] = None
    ) -> None:
        uuid.UUID(round_id)
        if not valid_hex(requester_nonce, 16) or not valid_hex(recipient_nonce, 16):
            raise ValueError("invalid_round_nonce")
        selected_game = game or str((state.get("pendingRound") or {}).get("game") or state.get("game") or "")
        config = GAME_CONFIGS.get(selected_game)
        if not config:
            raise ValueError("unsupported_round")
        state.update({
            "roundId": round_id,
            "game": selected_game,
            "gameVersion": config["gameVersion"],
            "rulesVersion": config["rulesVersion"],
            "roundRequesterNonce": requester_nonce,
            "roundRecipientNonce": recipient_nonce,
            "phase": "active",
            "transcript": [],
            "pendingOutboundMoves": {},
            "pendingInboundMoves": {},
            "moveAcks": {},
            "seen": set(),
            "lastRx": time.time(),
        })
        state.pop("pendingRound", None)

    def _finish_round(self, state: Dict[str, Any]) -> None:
        state["phase"] = "session_idle"
        state.pop("pendingRound", None)
        state.setdefault("pendingInboundMoves", {}).clear()
        state.setdefault("pendingOutboundMoves", {}).clear()
        self.send_event("GAME_LINK_STATE", {
            "matchId": state["matchId"], "roundId": state.get("roundId"), "state": "session_idle"
        })

    @staticmethod
    def _validate_chat_message(message: Dict[str, Any]) -> tuple[str, str, int]:
        message_id = str(message.get("messageId") or "")
        uuid.UUID(message_id)
        text = message.get("text")
        created_at = message.get("createdAt")
        if not isinstance(text, str) or not text.strip() or len(text) > CHAT_MAX_CHARS:
            raise ValueError("invalid_chat_text")
        raw = text.encode("utf-8")
        if len(raw) > CHAT_MAX_BYTES:
            raise ValueError("chat_message_too_large")
        now_ms = int(time.time() * 1000)
        if (
            not isinstance(created_at, int) or isinstance(created_at, bool) or
            created_at <= 0 or abs(created_at - now_ms) > 24 * 60 * 60 * 1000
        ):
            raise ValueError("invalid_chat_timestamp")
        return message_id, text, created_at

    @staticmethod
    def _remember_chat(state: Dict[str, Any], record: Dict[str, Any]) -> None:
        history = state.setdefault("chatMessages", [])
        existing = next((item for item in history if item.get("messageId") == record.get("messageId")), None)
        if existing:
            existing.update(record)
            return
        history.append(record)
        if len(history) > CHAT_HISTORY_LIMIT:
            del history[:-CHAT_HISTORY_LIMIT]

    def _send_chat_chunks(self, state: Dict[str, Any], message_id: str, text_value: str, created_at: int) -> None:
        raw = text_value.encode("utf-8")
        chunks = [raw[index:index + CHAT_CHUNK_BYTES] for index in range(0, len(raw), CHAT_CHUNK_BYTES)]
        for index, chunk in enumerate(chunks):
            self._send_game_payload(state, {
                "type": "CHAT_CHUNK", "matchId": state["matchId"], "messageId": message_id,
                "createdAt": created_at, "index": index, "total": len(chunks), "data": chunk,
            })

    def _receive_chat_chunk(self, state: Dict[str, Any], message: Dict[str, Any]) -> None:
        message_id = str(message.get("messageId") or "")
        uuid.UUID(message_id)
        index = message.get("index")
        total = message.get("total")
        created_at = message.get("createdAt")
        data = message.get("data")
        max_chunks = (CHAT_MAX_BYTES + CHAT_CHUNK_BYTES - 1) // CHAT_CHUNK_BYTES
        if (
            not isinstance(index, int) or isinstance(index, bool) or
            not isinstance(total, int) or isinstance(total, bool) or
            index < 0 or total < 1 or total > max_chunks or index >= total or
            not isinstance(created_at, int) or isinstance(created_at, bool) or
            not isinstance(data, bytes) or len(data) > CHAT_CHUNK_BYTES
        ):
            raise ValueError("invalid_chat_chunk")
        if any(item.get("messageId") == message_id for item in state.get("chatMessages", [])):
            self._send_game_payload(state, {"type": "CHAT_ACK", "matchId": state["matchId"], "messageId": message_id})
            return
        assemblies = state.setdefault("inboundChatChunks", {})
        if message_id not in assemblies and len(assemblies) >= 16:
            raise ValueError("too_many_partial_chat_messages")
        assembly = assemblies.setdefault(message_id, {"total": total, "createdAt": created_at, "chunks": {}, "started": time.time()})
        if assembly["total"] != total or assembly["createdAt"] != created_at:
            raise ValueError("conflicting_chat_chunk")
        if index in assembly["chunks"] and assembly["chunks"][index] != data:
            raise ValueError("conflicting_chat_chunk")
        assembly["chunks"][index] = data
        if len(assembly["chunks"]) != total:
            return
        raw = b"".join(assembly["chunks"][part] for part in range(total))
        assemblies.pop(message_id, None)
        try:
            text_value = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("invalid_chat_encoding") from exc
        self._validate_chat_message({"messageId": message_id, "text": text_value, "createdAt": created_at})
        author = state["recipient"] if state.get("outbound") else state["requester"]
        record = {"messageId": message_id, "text": text_value, "createdAt": created_at, "authorAddress": author, "delivered": True}
        self._remember_chat(state, record)
        self.send_event("GAME_MESSAGE", {
            "matchId": state["matchId"],
            "message": {"type": "CHAT_MESSAGE", "matchId": state["matchId"], **record},
        })
        self._send_game_payload(state, {"type": "CHAT_ACK", "matchId": state["matchId"], "messageId": message_id})

    def _validate_round_control(self, state: Dict[str, Any], message: Dict[str, Any]) -> None:
        round_id = str(message.get("roundId") or "")
        uuid.UUID(round_id)
        if round_id == state.get("roundId"):
            raise ValueError("round_already_used")
        game = str(message.get("game") or "")
        config = GAME_CONFIGS.get(game)
        if not config or message.get("gameVersion") != config["gameVersion"] or message.get("rulesVersion") != config["rulesVersion"]:
            raise ValueError("unsupported_round")

    def _chat_error(self, state: Dict[str, Any], reason: str) -> None:
        self.log(f"[qortalland-game] chat rejected match={state['matchId'][:8]} code={reason[:48]}")
        self.send_event("GAME_ERROR", {
            "matchId": state["matchId"], "code": "chat_error", "message": reason[:120]
        })

    def _append_accepted_move(self, state: Dict[str, Any], move: Dict[str, Any]) -> None:
        self._validate_move_shape(state, move)
        state.setdefault("transcript", []).append({**move, "type": "MOVE"})

    def _on_channel(self, match_id: str, message: MessageBase) -> bool:
        state = self.matches.get(match_id)
        payload = message.payload if isinstance(message, GameMessage) else None
        if not state or not isinstance(payload, dict):
            return False
        state["lastActivity"] = time.time()
        state["lastRx"] = time.time()
        if payload.get("k") == "handshake":
            try:
                self._handle_handshake(state, self._decode_handshake(payload.get("e") or {}))
            except Exception as exc:
                self._protocol_error(state, str(exc))
            return True
        if payload.get("k") == "cancel":
            if (
                state.get("phase") not in {"invited", "awaiting_response"}
                or payload.get("matchId") != match_id
            ):
                self._protocol_error(state, "unexpected_cancel")
            else:
                self._close_match(match_id, "cancelled")
            return True
        if payload.get("k") != "game" or state.get("phase") not in {"active", "ending", "awaiting_start_ack", *ROUND_PHASES}:
            self._protocol_error(state, "unexpected_message")
            return True
        game_message = payload.get("m")
        if not isinstance(game_message, dict) or game_message.get("type") not in ACTIVE_TYPES or game_message.get("matchId") not in {None, match_id}:
            self._protocol_error(state, "invalid_game_message")
            return True
        message_type = str(game_message.get("type") or "")
        message_id = str(game_message.get("messageId") or "")
        if message_type == "CHAT_CHUNK":
            try:
                self._receive_chat_chunk(state, game_message)
            except Exception as exc:
                state.setdefault("inboundChatChunks", {}).pop(message_id, None)
                self._chat_error(state, str(exc))
            return True
        if message_type == "CHAT_MESSAGE":
            self._chat_error(state, "unexpected_chat_message")
            return True
        if message_type == "CHAT_ACK":
            record = next((item for item in state.get("chatMessages", []) if item.get("messageId") == message_id), None)
            local_author = state["requester"] if state.get("outbound") else state["recipient"]
            if record and record.get("authorAddress") == local_author:
                record["delivered"] = True
                self.send_event("GAME_MESSAGE", {"matchId": match_id, "message": game_message})
            return True
        if message_type == "CHAT_TYPING":
            if not isinstance(game_message.get("active"), bool):
                self._chat_error(state, "invalid_chat_typing")
            else:
                now = time.time()
                if game_message["active"] and now - float(state.get("lastRemoteTyping") or 0) < 0.2:
                    return True
                state["lastRemoteTyping"] = now
                self.send_event("GAME_MESSAGE", {"matchId": match_id, "message": game_message})
            return True
        if message_type == "ROUND_REQUEST":
            try:
                self._validate_round_control(state, game_message)
                if not valid_hex(game_message.get("requesterNonce"), 16):
                    raise ValueError("round_not_available")
                if state.get("phase") == "ending":
                    self._finish_round(state)
                if state.get("phase") == "round_waiting":
                    pending = state.get("pendingRound") or {}
                    incoming_id = str(game_message["roundId"])
                    pending_id = str(pending.get("roundId") or "")
                    if uuid.UUID(incoming_id).bytes > uuid.UUID(pending_id).bytes:
                        self._send_game_payload(state, {
                            "type": "ROUND_RESPONSE", "matchId": match_id,
                            "messageId": str(uuid.uuid4()), "roundId": incoming_id,
                            "accepted": False, "reason": "superseded",
                        })
                        return True
                    if incoming_id == pending_id:
                        return True
                elif state.get("phase") != "session_idle":
                    raise ValueError("round_not_available")
                state["pendingRound"] = {
                    "roundId": game_message["roundId"],
                    "requesterNonce": game_message["requesterNonce"],
                    "game": game_message["game"],
                    "requestedByRemote": True,
                }
                state["phase"] = "round_incoming"
                self.send_event("GAME_MESSAGE", {"matchId": match_id, "message": game_message})
            except Exception as exc:
                self._protocol_error(state, str(exc))
            return True
        if message_type == "ROUND_RESPONSE":
            pending = state.get("pendingRound") or {}
            if state.get("phase") != "round_waiting" or game_message.get("roundId") != pending.get("roundId"):
                # This may be the response to the losing request in a crossed-rematch race.
                return True
            if game_message.get("accepted") is True:
                try:
                    self._reset_round(state, pending["roundId"], pending["requesterNonce"], str(game_message.get("recipientNonce") or ""))
                except Exception as exc:
                    self._protocol_error(state, str(exc))
                    return True
            else:
                state["phase"] = "session_idle"
                state.pop("pendingRound", None)
            self.send_event("GAME_MESSAGE", {"matchId": match_id, "message": game_message})
            return True
        if message_type == "ROUND_CANCEL":
            pending = state.get("pendingRound") or {}
            if state.get("phase") == "round_incoming" and game_message.get("roundId") == pending.get("roundId"):
                state["phase"] = "session_idle"
                state.pop("pendingRound", None)
                self.send_event("GAME_MESSAGE", {"matchId": match_id, "message": game_message})
            return True
        if message_type in ROUND_BOUND_TYPES and game_message.get("roundId") != state.get("roundId"):
            # A delayed packet from a completed round must not poison the reusable session.
            return True
        if message_type in {"MOVE", "SYNC_MOVE"}:
            normalized_move = {**game_message, "type": "MOVE"}
            pending_inbound = state.setdefault("pendingInboundMoves", {})
            existing_pending = pending_inbound.get(message_id)
            if existing_pending is not None:
                if not self._same_move(existing_pending, normalized_move):
                    self._protocol_error(state, "conflicting_duplicate_move")
                return True
            cached_ack = state.setdefault("moveAcks", {}).get(message_id)
            if cached_ack is not None:
                accepted = next(
                    (move for move in state.get("transcript") or [] if move.get("messageId") == message_id),
                    None,
                )
                if accepted is None or not self._same_move(accepted, normalized_move):
                    self._protocol_error(state, "conflicting_accepted_move")
                else:
                    self._send_game_payload(state, cached_ack)
                return True
            try:
                self._validate_move_shape(state, normalized_move)
            except Exception as exc:
                self._protocol_error(state, str(exc))
                return True
            pending_inbound[message_id] = normalized_move
            self.send_event("GAME_MESSAGE", {"matchId": match_id, "message": game_message})
            return True
        if message_type == "MOVE_ACK":
            pending_outbound = state.setdefault("pendingOutboundMoves", {})
            pending_move = pending_outbound.get(message_id)
            if pending_move is None:
                already_accepted = any(
                    move.get("messageId") == message_id
                    for move in state.get("transcript") or []
                )
                if already_accepted:
                    return True
                self._protocol_error(state, "unexpected_move_ack")
                return True
            if (
                game_message.get("ply") != pending_move.get("ply")
                or game_message.get("stateHash") != pending_move.get("resultingStateHash")
            ):
                self._protocol_error(state, "conflicting_move_ack")
                return True
            try:
                self._append_accepted_move(state, pending_move)
            except Exception as exc:
                self._protocol_error(state, str(exc))
                return True
            pending_outbound.pop(message_id, None)
            self.send_event("GAME_MESSAGE", {"matchId": match_id, "message": game_message})
            return True
        seen = state.setdefault("seen", set())
        if message_id and message_id in seen:
            cached_ack = state.setdefault("moveAcks", {}).get(message_id)
            if cached_ack is not None:
                self._send_game_payload(state, cached_ack)
            return True
        if message_id:
            if len(seen) >= 256:
                seen.pop()
            seen.add(message_id)
        if game_message.get("type") == "MATCH_PING":
            self._send_game_payload(state, {"type": "MATCH_PONG", "matchId": match_id, "messageId": message_id})
        elif game_message.get("type") == "START_ACK":
            resume_phase = str(state.pop("resumeReturnPhase", "active"))
            state["phase"] = resume_phase if resume_phase in {"active", "ending", "round_waiting", "round_incoming"} else "active"
            state.pop("disconnectedAt", None)
            if state["phase"] in {"active", "ending"}:
                self._send_missing_sync_moves(state)
            self._flush_game_send_queue(state)
            self.send_event("GAME_STARTED", self._public_state(state))
        else:
            self.send_event("GAME_MESSAGE", {"matchId": match_id, "message": game_message})
            if message_type in {"RESIGN_ACK", "GAME_OVER_ACK"}:
                self._finish_round(state)
        return True

    def _schedule_terminal_close(self, match_id: str, delay: float = 2.0) -> None:
        state = self.matches.get(match_id)
        round_id = state.get("roundId") if state else None
        timer = threading.Timer(delay, self._finish_round_by_id, args=(match_id, round_id))
        timer.daemon = True
        timer.start()

    def _finish_round_by_id(self, match_id: str, round_id: Optional[str]) -> None:
        state = self.matches.get(match_id)
        if state and state.get("phase") == "ending" and state.get("roundId") == round_id:
            self._finish_round(state)

    def _send_missing_sync_moves(self, state: Dict[str, Any]) -> None:
        transcript = list(state.get("transcript") or [])
        peer_ply = int(state.pop("peerResumePly", len(transcript)) or 0)
        for move in transcript[max(0, peer_ply):]:
            self._send_game_payload(
                state,
                {**move, "type": "SYNC_MOVE"},
                recovery_priority=True,
            )

    def _handle_handshake(self, state: Dict[str, Any], envelope: Dict[str, Any]) -> None:
        fields = envelope["fields"]
        public_key = envelope["publicKey"]
        kind = fields.get("type")
        if kind not in HANDSHAKE_TYPES or fields.get("matchId") != state["matchId"] or fields.get("linkId") != state["linkId"] or fields.get("signerPublicKey") != public_key or not verify_signature(fields, public_key, envelope["signature"]):
            raise ValueError("invalid_handshake")
        created_at = fields.get("createdAt")
        if (
            not isinstance(created_at, int)
            or isinstance(created_at, bool)
            or abs(int(time.time() * 1000) - created_at) > INVITE_TTL * 1000
        ):
            raise ValueError("stale_handshake")
        signer = derive_qortal_address(public_key)
        if kind == "QORTAL_LAND_GAME_ACCEPT":
            if (
                state.get("phase") != "awaiting_response"
                or not state.get("outbound")
                or signer != state["recipient"]
                or fields.get("responderAddress") != state["recipient"]
                or fields.get("inviteHash") != state["inviteHash"]
                or fields.get("requesterNonce") != state["requesterNonce"]
                or not valid_hex(fields.get("recipientNonce"), 16)
            ):
                raise ValueError("invalid_accept")
            state["recipientNonce"] = fields["recipientNonce"]
            state["acceptEnvelope"] = envelope
            accept_hash = hashlib.sha256(canonical_bytes(envelope)).hexdigest()
            starter = self._starter(state)
            fields_out = {
                "type": "QORTAL_LAND_GAME_CONFIRM",
                "acceptHash": accept_hash,
                "matchId": state["matchId"],
                "requesterNonce": state["requesterNonce"],
                "recipientNonce": state["recipientNonce"],
                "starter": starter,
                "initialStateHash": self._initial_state_hash(state),
                "requesterAddress": state["requester"],
                "signerPublicKey": state["requesterPublicKey"],
                "linkId": state["linkId"],
                "createdAt": int(time.time() * 1000),
            }
            self.send_event(
                "GAME_INVITE_RESPONSE",
                {
                    "matchId": state["matchId"],
                    "accepted": True,
                    "recipientNonce": state["recipientNonce"],
                },
            )
            self._require_signature(state, fields_out["type"], fields_out)
        elif kind == "QORTAL_LAND_GAME_DECLINE":
            if (
                state.get("phase") != "awaiting_response"
                or not state.get("outbound")
                or signer != state["recipient"]
                or fields.get("responderAddress") != state["recipient"]
                or fields.get("inviteHash") != state["inviteHash"]
                or fields.get("reason") not in {"declined", "busy", "superseded"}
            ):
                raise ValueError("invalid_decline")
            self.send_event("GAME_INVITE_RESPONSE", {"matchId": state["matchId"], "accepted": False, "reason": fields.get("reason")})
            self._close_match(state["matchId"], "declined")
        elif kind == "QORTAL_LAND_GAME_CONFIRM":
            expected_accept_hash = hashlib.sha256(canonical_bytes(state.get("acceptEnvelope") or {})).hexdigest()
            if (
                state.get("phase") != "awaiting_confirm"
                or state.get("outbound")
                or signer != state["requester"]
                or fields.get("requesterAddress") != state["requester"]
                or fields.get("starter") != self._starter(state)
                or fields.get("acceptHash") != expected_accept_hash
                or fields.get("initialStateHash") != self._initial_state_hash(state)
                or fields.get("requesterNonce") != state["requesterNonce"]
                or fields.get("recipientNonce") != state["recipientNonce"]
            ):
                raise ValueError("invalid_confirm")
            state["phase"] = "active"
            self._send_game_payload(
                state,
                {"type": "START_ACK", "matchId": state["matchId"], "messageId": str(uuid.uuid4())},
                recovery_priority=True,
            )
            self.send_event("GAME_STARTED", self._public_state(state))
        elif kind == "QORTAL_LAND_GAME_RESUME_ACCEPT":
            local = self._resume_state_fields(state)
            remote_ply_value = fields.get("lastAcknowledgedPly")
            remote_ply = (
                remote_ply_value
                if isinstance(remote_ply_value, int) and not isinstance(remote_ply_value, bool)
                else -1
            )
            local_ply = int(local["lastAcknowledgedPly"])
            compatible = 0 <= remote_ply <= int(GAME_CONFIGS[state["game"]]["maxPly"])
            if compatible and remote_ply <= local_ply:
                expected = self._transcript_summary(state, remote_ply)
                compatible = (
                    fields.get("stateHash") == expected["stateHash"]
                    and fields.get("transcriptHash") == expected["transcriptHash"]
                )
            if (
                state.get("phase") != "awaiting_resume_accept"
                or not state.get("outbound")
                or signer != state["recipient"]
                or fields.get("responderAddress") != state["recipient"]
                or fields.get("roundId") != (state.get("roundId") or state["matchId"])
                or fields.get("requesterNonce") != state.get("resumeRequesterNonce")
                or not valid_hex(fields.get("recipientNonce"), 16)
                or not valid_hex(fields.get("stateHash"), 32)
                or not valid_hex(fields.get("transcriptHash"), 32)
                or not compatible
            ):
                raise ValueError("invalid_resume_accept")
            state["resumeRecipientNonce"] = fields["recipientNonce"]
            state["peerResumePly"] = remote_ply
            context = self.land_context or {}
            confirm_fields = {
                "type": "QORTAL_LAND_GAME_RESUME_CONFIRM",
                "matchId": state["matchId"],
                "roundId": state.get("roundId") or state["matchId"],
                "requesterAddress": state["requester"],
                "signerPublicKey": context.get("publicKey"),
                "linkId": state["linkId"],
                "requesterNonce": state["resumeRequesterNonce"],
                "recipientNonce": state["resumeRecipientNonce"],
                "lastAcknowledgedPly": local["lastAcknowledgedPly"],
                "stateHash": local["stateHash"],
                "transcriptHash": local["transcriptHash"],
                "createdAt": int(time.time() * 1000),
            }
            self._require_signature(state, confirm_fields["type"], confirm_fields)
        elif kind == "QORTAL_LAND_GAME_RESUME_CONFIRM":
            local = self._resume_state_fields(state)
            remote_ply_value = fields.get("lastAcknowledgedPly")
            remote_ply = (
                remote_ply_value
                if isinstance(remote_ply_value, int) and not isinstance(remote_ply_value, bool)
                else -1
            )
            local_ply = int(local["lastAcknowledgedPly"])
            compatible = 0 <= remote_ply <= int(GAME_CONFIGS[state["game"]]["maxPly"])
            if compatible and remote_ply <= local_ply:
                expected = self._transcript_summary(state, remote_ply)
                compatible = fields.get("stateHash") == expected["stateHash"] and fields.get("transcriptHash") == expected["transcriptHash"]
            if (
                state.get("phase") != "awaiting_resume_confirm"
                or state.get("outbound")
                or signer != state["requester"]
                or fields.get("requesterAddress") != state["requester"]
                or fields.get("roundId") != (state.get("roundId") or state["matchId"])
                or fields.get("requesterNonce") != state.get("resumeRequesterNonce")
                or fields.get("recipientNonce") != state.get("resumeRecipientNonce")
                or not valid_hex(fields.get("stateHash"), 32)
                or not valid_hex(fields.get("transcriptHash"), 32)
                or not compatible
            ):
                raise ValueError("invalid_resume_confirm")
            state["peerResumePly"] = remote_ply
            resume_phase = str(state.pop("resumeReturnPhase", "active"))
            state["phase"] = resume_phase if resume_phase in {"active", "ending", "round_waiting", "round_incoming"} else "active"
            state.pop("disconnectedAt", None)
            self._send_game_payload(
                state,
                {"type": "START_ACK", "matchId": state["matchId"], "messageId": str(uuid.uuid4())},
                recovery_priority=True,
            )
            if state["phase"] in {"active", "ending"}:
                self._send_missing_sync_moves(state)
            self._flush_game_send_queue(state)
            self.send_event("GAME_STARTED", self._public_state(state))

    def _starter(self, state: Dict[str, Any]) -> str:
        round_id = state.get("roundId") or state["matchId"]
        requester_nonce = state.get("roundRequesterNonce") or state["requesterNonce"]
        recipient_nonce = state.get("roundRecipientNonce") or state["recipientNonce"]
        prefix = f"qortalland-game:v2:{state.get('game') or 'connect-four'}:".encode("utf-8")
        digest = hashlib.sha256(prefix + uuid.UUID(round_id).bytes + bytes.fromhex(requester_nonce) + bytes.fromhex(recipient_nonce)).digest()
        return "requester" if digest[-1] & 1 == 0 else "recipient"

    def _initial_state_hash(self, state: Dict[str, Any]) -> str:
        next_seat = 1 if self._starter(state) == "requester" else 2
        if state.get("game") == "checkers":
            board = [0] * 64
            for row in range(3):
                for column in range(8):
                    if (row + column) % 2 == 1:
                        board[row * 8 + column] = 2
            for row in range(5, 8):
                for column in range(8):
                    if (row + column) % 2 == 1:
                        board[row * 8 + column] = 1
            value = {
                "board": board,
                "game": "checkers",
                "nextSeat": next_seat,
                "outcome": None,
                "ply": 0,
                "protocolVersion": PROTOCOL_VERSION,
                "quietPly": 0,
                "rulesVersion": state.get("rulesVersion") or 1,
            }
        elif state.get("game") == "chess":
            white_seat = 1 if self._starter(state) == "requester" else 2
            black_seat = 2 if white_seat == 1 else 1
            signed = lambda seat, kind: kind if seat == 1 else -kind
            back_rank = [4, 2, 3, 5, 6, 3, 2, 4]
            board = [0] * 64
            for column, kind in enumerate(back_rank):
                board[column] = signed(black_seat, kind)
                board[8 + column] = signed(black_seat, 1)
                board[48 + column] = signed(white_seat, 1)
                board[56 + column] = signed(white_seat, kind)
            value = {
                "board": board,
                "castlingRights": [True, True, True, True],
                "enPassant": None,
                "game": "chess",
                "halfmoveClock": 0,
                "nextSeat": white_seat,
                "outcome": None,
                "ply": 0,
                "protocolVersion": PROTOCOL_VERSION,
                "rulesVersion": state.get("rulesVersion") or 1,
                "whiteSeat": white_seat,
            }
        else:
            value = {
                "board": [0] * 42,
                "game": "connect-four",
                "nextSeat": next_seat,
                "outcome": None,
                "ply": 0,
                "protocolVersion": PROTOCOL_VERSION,
                "rulesVersion": state.get("rulesVersion") or 1,
            }
        canonical = json.dumps(
            value,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(canonical).hexdigest()

    def _send_active(self, message: Dict[str, Any]) -> None:
        match_id = str(message.get("matchId") or "")
        state = self.matches.get(match_id)
        game_message = message.get("message")
        if not state or state.get("phase") not in {"active", "ending", *ROUND_PHASES} or not isinstance(game_message, dict) or game_message.get("type") not in ACTIVE_TYPES:
            raise ValueError("match_not_active")
        game_message = {**game_message, "matchId": match_id}
        message_type = str(game_message.get("type") or "")
        message_id = str(game_message.get("messageId") or "")
        if message_type == "CHAT_MESSAGE":
            message_id, text_value, created_at = self._validate_chat_message(game_message)
            if any(item.get("messageId") == message_id for item in state.get("chatMessages", [])):
                raise ValueError("duplicate_chat_message")
            author = state["requester"] if state.get("outbound") else state["recipient"]
            record = {
                "messageId": message_id, "text": text_value, "createdAt": created_at,
                "authorAddress": author, "delivered": False,
            }
            self._remember_chat(state, record)
            try:
                self._send_chat_chunks(state, message_id, text_value, created_at)
            except Exception:
                state["chatMessages"] = [item for item in state.get("chatMessages", []) if item.get("messageId") != message_id]
                raise
            return
        if message_type in {"CHAT_CHUNK", "CHAT_ACK"}:
            raise ValueError("internal_chat_message")
        if message_type == "CHAT_TYPING":
            if not isinstance(game_message.get("active"), bool):
                raise ValueError("invalid_chat_typing")
            now = time.time()
            if game_message["active"] and now - float(state.get("lastLocalTyping") or 0) < 0.2:
                return
            state["lastLocalTyping"] = now
            self._send_game_payload(state, {
                "type": "CHAT_TYPING", "matchId": match_id, "active": game_message["active"]
            })
            return
        if message_type == "ROUND_REQUEST":
            self._validate_round_control(state, game_message)
            if state.get("phase") == "ending":
                self._finish_round(state)
            if state.get("phase") != "session_idle" or not valid_hex(game_message.get("requesterNonce"), 16):
                raise ValueError("round_not_available")
            state["pendingRound"] = {
                "roundId": game_message["roundId"],
                "requesterNonce": game_message["requesterNonce"],
                "game": game_message["game"],
                "requestedByRemote": False,
            }
            state["phase"] = "round_waiting"
            self._send_game_payload(state, game_message)
            return
        if message_type == "ROUND_RESPONSE":
            pending = state.get("pendingRound") or {}
            if state.get("phase") != "round_incoming" or game_message.get("roundId") != pending.get("roundId"):
                raise ValueError("unexpected_round_response")
            if game_message.get("accepted") is True:
                if not valid_hex(game_message.get("recipientNonce"), 16):
                    raise ValueError("invalid_round_nonce")
            self._send_game_payload(state, game_message)
            if game_message.get("accepted") is True:
                self._reset_round(state, pending["roundId"], pending["requesterNonce"], str(game_message.get("recipientNonce") or ""))
            else:
                state["phase"] = "session_idle"
                state.pop("pendingRound", None)
            return
        if message_type == "ROUND_CANCEL":
            pending = state.get("pendingRound") or {}
            if state.get("phase") != "round_waiting" or game_message.get("roundId") != pending.get("roundId"):
                raise ValueError("unexpected_round_cancel")
            self._send_game_payload(state, game_message)
            state["phase"] = "session_idle"
            state.pop("pendingRound", None)
            return
        game_message = {**game_message, "roundId": state.get("roundId")}
        if message_type in {"MOVE", "SYNC_MOVE"}:
            normalized_move = {**game_message, "type": "MOVE"}
            self._validate_move_shape(state, normalized_move)
            if state.setdefault("pendingOutboundMoves", {}) or state.setdefault("pendingInboundMoves", {}):
                raise ValueError("move_already_pending")
            state["pendingOutboundMoves"][message_id] = normalized_move
            try:
                self._send_game_payload(state, game_message)
            except Exception:
                state["pendingOutboundMoves"].pop(message_id, None)
                raise
            return
        if message_type == "MOVE_ACK":
            pending_move = state.setdefault("pendingInboundMoves", {}).get(message_id)
            if pending_move is None:
                cached = state.setdefault("moveAcks", {}).get(message_id)
                if cached == game_message:
                    self._send_game_payload(state, cached)
                    return
                raise ValueError("unexpected_move_ack")
            if (
                game_message.get("ply") != pending_move.get("ply")
                or game_message.get("stateHash") != pending_move.get("resultingStateHash")
            ):
                raise ValueError("conflicting_move_ack")
            transcript = state.setdefault("transcript", [])
            transcript_length = len(transcript)
            self._append_accepted_move(state, pending_move)
            try:
                self._send_game_payload(state, game_message)
            except Exception:
                del transcript[transcript_length:]
                raise
            state["pendingInboundMoves"].pop(message_id, None)
            state.setdefault("moveAcks", {})[message_id] = game_message
            return
        self._send_game_payload(state, game_message)
        if message_type in {"RESIGN", "GAME_OVER"}:
            state["phase"] = "ending"
            self._schedule_terminal_close(match_id, 5.0)
        elif message_type in {"RESIGN_ACK", "GAME_OVER_ACK"}:
            self._finish_round(state)

    def _protocol_error(self, state: Dict[str, Any], reason: str) -> None:
        self.send_event("GAME_ERROR", {"matchId": state["matchId"], "code": "protocol_error", "message": reason[:120]})
        try:
            self._send_channel(state, {"k": "game", "m": {"type": "PROTOCOL_ERROR", "matchId": state["matchId"], "messageId": str(uuid.uuid4()), "reason": reason[:32]}})
        except Exception:
            pass
        self._close_match(state["matchId"], "protocol_error")

    def _cancel_or_close_match(self, match_id: str, completed: bool = False) -> None:
        state = self.matches.get(match_id)
        if not state:
            return
        if completed and state.get("phase") == "ending":
            self._close_match(match_id, "completed")
            return
        if state.get("phase") == "awaiting_response" and state.get("channel") is not None:
            try:
                self._send_channel(
                    state,
                    {"k": "cancel", "matchId": match_id, "reason": "cancelled"},
                )
            except Exception:
                pass
        self._close_match(match_id, "cancelled")

    def _monitor(self) -> None:
        while not self.stop_event.wait(1):
            self.enqueue(self.proximity.tick, ())
            self.enqueue(self._flush_game_send_queues, ())
            now = time.time()
            for nonce_key, expiry in list(self.used_nonces.items()):
                if expiry <= now:
                    self.used_nonces.pop(nonce_key, None)
            for challenge_id, challenge in list(self.signature_challenges.items()):
                if now - float(challenge.get("created") or 0) >= INVITE_TTL:
                    self.signature_challenges.pop(challenge_id, None)
            with self.lock:
                states = list(self.matches.values())
            for state in states:
                assemblies = state.get("inboundChatChunks") or {}
                for message_id, assembly in list(assemblies.items()):
                    if now - float(assembly.get("started") or now) >= RECOVERY_WINDOW:
                        assemblies.pop(message_id, None)
                if (
                    state.get("phase") not in {
                        "active",
                        "recovering",
                        "awaiting_resume_accept",
                        "awaiting_resume_confirm", "session_idle", "round_waiting", "round_incoming", "ending",
                    }
                    and now * 1000 >= state.get("expiresAt", 0)
                ):
                    self._close_match(state["matchId"], "expired")
                    continue
                if state.get("phase") in {"active", "session_idle", "round_waiting", "round_incoming", "ending"}:
                    last_rx = float(state.get("lastRx") or now)
                    if now - last_rx >= HEARTBEAT_INTERVAL and now - float(state.get("lastPing") or 0) >= HEARTBEAT_INTERVAL:
                        try:
                            ping_id = str(uuid.uuid4())
                            self._send_game_payload(state, {"type": "MATCH_PING", "matchId": state["matchId"], "messageId": ping_id})
                            state["lastPing"] = now
                        except Exception:
                            pass
                    if now - last_rx >= RECOVERY_WINDOW:
                        if state.get("outbound"):
                            self._teardown(state.get("link"))
                        else:
                            state["phase"] = "recovering"
                            state["disconnectedAt"] = now
                            self.send_event("GAME_LINK_STATE", {"matchId": state["matchId"], "state": "recovering", "deadlineAt": int((now + RECOVERY_WINDOW) * 1000)})
                    elif state.get("renderer_lost_at") and now - state["renderer_lost_at"] >= RECOVERY_WINDOW:
                        self._close_match(state["matchId"], "abandoned")
                elif state.get("phase") in {"recovering", "awaiting_resume_accept", "awaiting_resume_confirm"}:
                    if now - float(state.get("disconnectedAt") or now) >= RECOVERY_WINDOW:
                        self._close_match(state["matchId"], "abandoned")

    def _establish_timeout(self, match_id: str) -> None:
        state = self.matches.get(match_id)
        if state and state.get("phase") == "establishing":
            self.log(
                f"[qortalland-game] link timeout match={match_id[:8]} peer={str(state.get('peerHash') or '')[:8]} attempts={int(state.get('openAttempts') or 0)}"
            )
            self._close_match(match_id, "establishment_timeout")

    def _link_closed(self, link) -> None:
        state = self._state_for_link(link)
        if not state:
            return
        if state.get("phase") == "establishing" and state.get("link") is link:
            with self.lock:
                self.links_by_object.pop(id(link), None)
            state["link"] = None
            self.log(
                f"[qortalland-game] link attempt closed match={state['matchId'][:8]} peer={str(state.get('peerHash') or '')[:8]} attempt={int(state.get('openAttempts') or 0)}"
            )
            if time.time() < float(state.get("establishDeadline") or 0):
                try:
                    refreshed = False
                    if self.refresh_path is not None:
                        refreshed = self.refresh_path(
                            state["peerHash"],
                            "game_link_attempt_closed",
                        ) is True
                    if not refreshed:
                        RNS.Transport.request_path(bytes.fromhex(str(state["peerHash"])))
                except Exception:
                    pass
                self._schedule_open_retry(state["matchId"])
            else:
                self._close_match(state["matchId"], "establishment_timeout", teardown=False)
            return
        if state.get("phase") == "session_idle":
            self._close_match(state["matchId"], "link_closed", teardown=False)
            return
        if state.get("phase") in {"active", "ending", "round_waiting", "round_incoming", "awaiting_resume_accept", "awaiting_resume_confirm", "awaiting_start_ack"}:
            state["resumeReturnPhase"] = state.get("resumeReturnPhase") or state.get("phase")
            state["phase"] = "recovering"
            state.setdefault("disconnectedAt", time.time())
            # The renderer rebuilds unacknowledged state from the authenticated
            # resume snapshot. Deferred MOVE payloads remain queued and restore
            # their pending entry immediately before retransmission.
            state.setdefault("pendingInboundMoves", {}).clear()
            state.setdefault("pendingOutboundMoves", {}).clear()
            self.send_event("GAME_LINK_STATE", {"matchId": state["matchId"], "state": "recovering", "deadlineAt": int((time.time() + RECOVERY_WINDOW) * 1000)})
            # Resume authentication is intentionally surfaced, never silently trusted.
            self.send_event("GAME_ERROR", {"matchId": state["matchId"], "code": "resume_required", "message": "Private link interrupted"})
            if state.get("outbound"):
                timer = threading.Timer(1.0, self._reopen_for_resume, args=(state["matchId"],))
                timer.daemon = True
                timer.start()
        else:
            self._close_match(state["matchId"], "link_closed", teardown=False)

    def _reopen_for_resume(self, match_id: str) -> None:
        state = self.matches.get(match_id)
        if not state or state.get("phase") != "recovering" or time.time() - float(state.get("disconnectedAt") or 0) >= RECOVERY_WINDOW:
            return
        try:
            identity = self.resolve_identity(state["peerHash"])
            if identity is None:
                raise ValueError("resume_identity_unavailable")
            link = RNS.Link(self.build_destination(identity), established_callback=self._resume_outbound_established, closed_callback=self._link_closed)
            old_link = state.get("link")
            with self.lock:
                if old_link is not None:
                    self.links_by_object.pop(id(old_link), None)
                self.links_by_object[id(link)] = match_id
            state["link"] = link
        except Exception:
            timer = threading.Timer(2.0, self._reopen_for_resume, args=(match_id,))
            timer.daemon = True
            timer.start()

    def _resume_outbound_established(self, link) -> None:
        state = self._state_for_link(link)
        if not state or state.get("phase") != "recovering":
            return
        state["linkId"] = self.link_id_bytes(link).hex()
        state["resumeRequesterNonce"] = secrets.token_hex(16)
        state["lastActivity"] = time.time()
        self._configure_channel(state)
        context = self.land_context or {}
        fields = {
            "type": "QORTAL_LAND_GAME_RESUME_REQUEST",
            "matchId": state["matchId"],
            "roundId": state.get("roundId") or state["matchId"],
            "requesterAddress": state["requester"],
            "signerPublicKey": context.get("publicKey"),
            "linkId": state["linkId"],
            "requesterNonce": state["resumeRequesterNonce"],
            **self._resume_state_fields(state),
            "createdAt": int(time.time() * 1000),
        }
        self._require_signature(state, fields["type"], fields)

    def _state_for_link(self, link) -> Optional[Dict[str, Any]]:
        with self.lock:
            match_id = self.links_by_object.get(id(link))
            return self.matches.get(match_id) if match_id else None

    def _public_state(self, state: Dict[str, Any]) -> Dict[str, Any]:
        pending_outbound = list(state.get("pendingOutboundMoves", {}).values())
        return {
            "matchId": state["matchId"],
            "game": state.get("game") or "connect-four",
            "gameVersion": state.get("gameVersion") or 1,
            "rulesVersion": state.get("rulesVersion") or 1,
            "requesterAddress": state["requester"],
            "recipientAddress": state["recipient"],
            "requesterNonce": state.get("roundRequesterNonce") or state["requesterNonce"],
            "recipientNonce": state.get("roundRecipientNonce") or state.get("recipientNonce"),
            "starter": self._starter(state) if state.get("recipientNonce") else None,
            "phase": state.get("phase"),
            "expiresAt": state.get("expiresAt"),
            "transcript": list(state.get("transcript") or []),
            "pendingOutboundMove": pending_outbound[0] if pending_outbound else None,
            "pendingRound": dict(state.get("pendingRound") or {}),
        }

    def _chat_history_batches(self, match_id: str) -> list[Dict[str, Any]]:
        state = self.matches.get(match_id)
        history = [dict(item) for item in (state or {}).get("chatMessages", [])]
        return [
            {"type": "GAME_CHAT_HISTORY", "matchId": match_id, "messages": history[index:index + 2]}
            for index in range(0, len(history), 2)
        ]

    def _active_snapshot(self) -> Optional[Dict[str, Any]]:
        with self.lock:
            state = next((s for s in self.matches.values() if s.get("phase") not in {"closed", "ended"}), None)
            if not state:
                return None
            return self._public_state(state)

    def _close_match(self, match_id: str, reason: str, teardown: bool = True) -> None:
        with self.lock:
            state = self.matches.pop(match_id, None)
            if not state:
                return
            link = state.get("link")
            if link is not None:
                self.links_by_object.pop(id(link), None)
            for challenge_id, challenge in list(self.signature_challenges.items()):
                if challenge.get("matchId") == match_id:
                    self.signature_challenges.pop(challenge_id, None)
        timer = state.get("establishTimer")
        if timer:
            timer.cancel()
        retry_timer = state.get("openRetryTimer")
        if retry_timer:
            retry_timer.cancel()
        if teardown:
            self._teardown(link)
        self.send_event("GAME_ENDED", {"matchId": match_id, "outcome": reason})

    @staticmethod
    def _send_raw(link, raw: bytes) -> bool:
        try:
            packet = RNS.Packet(link, raw)
            return packet.send() is not None
        except Exception:
            return False

    @staticmethod
    def _teardown(link) -> None:
        if link is not None:
            try:
                link.teardown()
            except Exception:
                pass
