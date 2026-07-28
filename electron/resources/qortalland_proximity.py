"""Qortal Land proximity voice over authenticated, dedicated Reticulum links."""

from __future__ import annotations

import hashlib
import math
import queue
import secrets
import struct
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional

import RNS
from RNS.vendor import umsgpack


DISCOVERY_TYPE = "QLPV1"
LINK_MAGIC = b"QLP1"
MEDIA_MAGIC = b"PVA1"
CONTROL_MAGIC = b"PVC1"
LOCAL_AUDIO_MAGIC = b"QLA1"
PROTOCOL_VERSION = 1
MAX_PEERS = 7
MAX_OPUS_BYTES = 320
MAX_LOCAL_AUDIO_BYTES = 2 * 1024
FULL_VOLUME_DISTANCE = 100.0
AUDIBLE_DISTANCE = 400.0
AUDIBLE_EXIT_DISTANCE = 460.0
PRECONNECT_DISTANCE = 520.0
RELEASE_DISTANCE = 600.0
LAND_STATE_MAX_AGE = 5.0
DISCOVERY_MAX_AGE = 25.0
HEARTBEAT_INTERVAL = 5.0
LINK_DEAD_AFTER = 15.0
LINK_TIMEOUT = 30.0
CAPABILITY_MAX_AGE_MS = 4 * 60 * 60 * 1000
CAPABILITY_CLOCK_SKEW_MS = 2 * 60 * 1000
LOCAL_AUDIO_HEADER = struct.Struct(">4sBBHIIQH")
RNS_AUDIO_HEADER = struct.Struct(">4sBBIIIH")
MEDIA_DRAIN_MAX_FRAMES = 24
MEDIA_DRAIN_TIME_BUDGET = 0.012

PROXIMITY_COMMANDS = {
    "ENABLE_PROXIMITY_VOICE",
    "SUBMIT_PROXIMITY_SESSION_SIGNATURE",
    "DISABLE_PROXIMITY_VOICE",
    "UPDATE_PROXIMITY_POSITION",
    "SET_PROXIMITY_TRANSMIT",
    "SET_PROXIMITY_SUSPENDED",
    "SET_PROXIMITY_PEER_POLICY",
    "GET_PROXIMITY_STATE",
    "GET_PROXIMITY_DIAGNOSTICS",
}
COMMAND_FIELDS = {
    "ENABLE_PROXIMITY_VOICE": ({"type", "requestId", "mode"}, {"type", "requestId"}),
    "SUBMIT_PROXIMITY_SESSION_SIGNATURE": ({"type", "requestId", "signature", "publicKey"}, {"type", "requestId", "signature", "publicKey"}),
    "DISABLE_PROXIMITY_VOICE": ({"type", "requestId"}, {"type", "requestId"}),
    "UPDATE_PROXIMITY_POSITION": ({"type", "requestId", "landSessionId", "sequence", "roomId", "x", "y"}, {"type", "requestId", "landSessionId", "sequence", "roomId", "x", "y"}),
    "SET_PROXIMITY_TRANSMIT": ({"type", "requestId", "transmitting", "mode"}, {"type", "requestId", "transmitting"}),
    "SET_PROXIMITY_SUSPENDED": ({"type", "requestId", "suspended"}, {"type", "requestId", "suspended"}),
    "SET_PROXIMITY_PEER_POLICY": ({"type", "requestId", "address", "sessionId", "muted", "volume", "blocked"}, {"type", "requestId", "address"}),
    "GET_PROXIMITY_STATE": ({"type", "requestId"}, {"type", "requestId"}),
    "GET_PROXIMITY_DIAGNOSTICS": ({"type", "requestId"}, {"type", "requestId"}),
}


def _canonical(fields: Dict[str, Any]) -> bytes:
    import json
    return json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _safe_close(link) -> None:
    if link is None:
        return
    try:
        link.teardown()
    except Exception:
        try:
            link.close()
        except Exception:
            pass


class QortalLandProximityVoiceManager:
    def __init__(
        self,
        emit: Callable[[str, Dict[str, Any]], None],
        send_binary: Callable[[bytes, int], bool],
        log: Callable[[str], None],
        resolve_peer: Callable[[str, str], Optional[str]],
        resolve_identity: Callable[[str], Any],
        build_destination: Callable[[Any], Any],
        link_id_bytes: Callable[[Any], bytes],
        enqueue: Callable[[Callable[..., Any], tuple], bool],
        broadcast_discovery: Callable[[Dict[str, Any]], None],
        verify_wallet: Callable[[Dict[str, Any], str, str], bool],
        derive_address: Callable[[str], str],
        decode_base58: Callable[[str], bytes],
        enqueue_media: Optional[Callable[[Callable[..., Any], tuple], bool]] = None,
        resolve_link_peer_hash: Optional[Callable[[Any], str]] = None,
    ):
        self.emit = emit
        self.send_binary = send_binary
        self.log = log
        self.resolve_peer = resolve_peer
        self.resolve_identity = resolve_identity
        self.build_destination = build_destination
        self.link_id_bytes = link_id_bytes
        self.enqueue = enqueue
        self.enqueue_media = enqueue_media or enqueue
        self.broadcast_discovery = broadcast_discovery
        self.verify_wallet = verify_wallet
        self.derive_address = derive_address
        self.decode_base58 = decode_base58
        self.resolve_link_peer_hash = resolve_link_peer_hash
        self.lock = threading.RLock()
        self.context: Optional[Dict[str, Any]] = None
        self.enabled = False
        self.suspended = False
        self.suspended_at: Optional[float] = None
        self.transmitting = False
        self.mode = "push-to-talk"
        self.position: Optional[Dict[str, Any]] = None
        self.position_sequence = -1
        self.pending_position_command: Optional[tuple[Dict[str, Any], Callable[..., None]]] = None
        self.position_drain_scheduled = False
        self.ephemeral_private = None
        self.pending_ephemeral_private = None
        self.pending_fields: Optional[Dict[str, Any]] = None
        self.capability: Optional[Dict[str, Any]] = None
        self.capability_signature = ""
        self.capability_hash = b""
        self.remote_capabilities: Dict[str, Dict[str, Any]] = {}
        self.remote_positions: Dict[str, Dict[str, Any]] = {}
        self.links: Dict[str, Dict[str, Any]] = {}
        self.links_by_object: Dict[int, str] = {}
        self.source_ids: Dict[str, int] = {}
        self.next_source_id = 1
        self.stream_generation = secrets.randbits(31) or 1
        self.local_media_max_sequence = -1
        self.local_audio_queue: "queue.Queue[tuple[float, bytes]]" = queue.Queue(maxsize=32)
        self.media_drain_scheduled = False
        self.used_link_nonces: Dict[bytes, float] = {}
        self.blocked_addresses: set[str] = set()
        self.path_requested_at: Dict[str, float] = {}
        self.link_retry: Dict[str, Dict[str, float]] = {}
        self.replacement_since: Dict[str, float] = {}
        self.visible_capacity_peers: set[str] = set()
        self.last_discovery_at = 0.0
        self.last_stats_at = 0.0
        self.last_media_log_at = 0.0
        self.capacity_reduced_until = 0.0
        self.renderer_lost_at: Optional[float] = None
        self.diagnostic_last: Dict[str, float] = {}
        self.stats = {
            "localFrames": 0, "sentFrames": 0, "receivedFrames": 0,
            "staleDrops": 0, "queueDrops": 0, "invalidFrames": 0,
            "localQueueDrops": 0, "rendererQueueDrops": 0,
            "duplicateDrops": 0, "sequenceSkips": 0, "linkFailures": 0,
        }

    def _trace(self, stage: str, address: str = "", code: str = "", throttle: float = 0.0) -> None:
        key = f"{stage}:{address}:{code}"
        now = time.time()
        if throttle > 0 and now - self.diagnostic_last.get(key, 0.0) < throttle:
            return
        self.diagnostic_last[key] = now
        peer = hashlib.sha256(str(address or "unknown").encode("utf-8")).hexdigest()[:10]
        suffix = f" code={str(code)[:48]}" if code else ""
        self.log(f"[qortalland-proximity] stage={stage} peer={peer}{suffix}")

    @staticmethod
    def _peer_key(address: str, session_id: str) -> str:
        return f"{str(address or '').strip()}:{str(session_id or '').strip()}"

    def set_context(self, context: Dict[str, Any]) -> None:
        previous = self.context
        if previous and (
            previous.get("address") != context.get("address")
            or previous.get("groupId") != context.get("groupId")
            or previous.get("landSessionId") != context.get("landSessionId")
            or previous.get("localDestinationHash") != context.get("localDestinationHash")
        ):
            self.disable("land_context_changed")
        self.context = dict(context)

    def clear_context(self) -> None:
        self.disable("land_context_cleared")
        self.context = None

    def handle_command(self, message: Dict[str, Any], command_result: Callable[..., None]) -> None:
        command = str(message.get("type") or "")
        request_id = message.get("requestId")
        try:
            allowed, required = COMMAND_FIELDS.get(command, (set(), set()))
            if (
                not isinstance(request_id, str) or not request_id or len(request_id) > 80
                or not required.issubset(message.keys()) or not set(message.keys()).issubset(allowed)
            ):
                raise ValueError("invalid_proximity_command_schema")
            if command == "ENABLE_PROXIMITY_VOICE":
                self._enable(message)
            elif command == "SUBMIT_PROXIMITY_SESSION_SIGNATURE":
                self._submit_signature(message)
            elif command == "DISABLE_PROXIMITY_VOICE":
                self.disable("user_disabled")
            elif command == "UPDATE_PROXIMITY_POSITION":
                self._update_position(message)
            elif command == "SET_PROXIMITY_TRANSMIT":
                if not isinstance(message.get("transmitting"), bool):
                    raise ValueError("invalid_proximity_transmit")
                if "mode" in message:
                    mode = str(message.get("mode") or "")
                    if mode not in {"push-to-talk", "open-mic"}:
                        raise ValueError("invalid_proximity_mode")
                    self.mode = mode
                self._set_transmit(message.get("transmitting") is True)
            elif command == "SET_PROXIMITY_SUSPENDED":
                if not isinstance(message.get("suspended"), bool):
                    raise ValueError("invalid_proximity_suspension")
                self.suspended = message.get("suspended") is True
                self.suspended_at = time.time() if self.suspended else None
                if self.suspended:
                    self.transmitting = False
                self._send_control_all({"c": "pause" if self.suspended else "resume"})
                self._emit_state()
                self._broadcast(True)
            elif command == "SET_PROXIMITY_PEER_POLICY":
                self._set_peer_policy(message)
            elif command in {"GET_PROXIMITY_STATE", "GET_PROXIMITY_DIAGNOSTICS"}:
                self._emit_snapshot(diagnostics=command.endswith("DIAGNOSTICS"))
            else:
                raise ValueError("invalid_proximity_command")
            command_result(request_id, True)
        except Exception as exc:
            command_result(request_id, False, str(exc)[:160])

    def queue_position_command(self, message: Dict[str, Any], command_result: Callable[..., None]) -> bool:
        with self.lock:
            previous = self.pending_position_command
            self.pending_position_command = (dict(message), command_result)
            if previous is not None:
                previous_message, previous_result = previous
                previous_result(previous_message.get("requestId"), True, payload={"coalesced": True})
            if self.position_drain_scheduled:
                return True
            self.position_drain_scheduled = True
        if self.enqueue(self._drain_position_command, ()):
            return True
        with self.lock:
            pending = self.pending_position_command
            self.pending_position_command = None
            self.position_drain_scheduled = False
        if pending is not None:
            pending[1](pending[0].get("requestId"), False, "command_queue_full")
        return False

    def _drain_position_command(self) -> None:
        with self.lock:
            pending = self.pending_position_command
            self.pending_position_command = None
            self.position_drain_scheduled = False
        if pending is not None:
            self.handle_command(pending[0], pending[1])

    def _enable(self, message: Dict[str, Any]) -> None:
        if not self.context:
            raise ValueError("land_context_required")
        try:
            group_id = int(self.context.get("groupId") or 0)
        except (TypeError, ValueError):
            group_id = 0
        if not 0 < group_id <= 0x7FFFFFFF:
            raise ValueError("invalid_proximity_group")
        mode = str(message.get("mode") or "push-to-talk")
        if mode not in {"push-to-talk", "open-mic"}:
            raise ValueError("invalid_proximity_mode")
        self.mode = mode
        self.pending_ephemeral_private = RNS.Cryptography.Ed25519PrivateKey.generate()
        ephemeral_public = self.pending_ephemeral_private.public_key().public_bytes().hex()
        now_ms = int(time.time() * 1000)
        self.pending_fields = {
            "type": "QORTAL_LAND_PROXIMITY_VOICE_SESSION",
            "protocolVersion": PROTOCOL_VERSION,
            "address": self.context["address"],
            "signerPublicKey": self.context["publicKey"],
            "ephemeralPublicKey": ephemeral_public,
            "groupId": self.context["groupId"],
            "landSessionId": self.context["landSessionId"],
            "destinationHash": self.context["localDestinationHash"],
            "instanceId": self.context.get("instanceId", ""),
            # The fresh ephemeral key already provides a unique 256-bit value.
            # Reuse it as the signed nonce so compact discovery does not have to
            # carry a second redundant 32-byte random value.
            "nonce": ephemeral_public,
            "createdAt": now_ms,
            "expiresAt": now_ms + CAPABILITY_MAX_AGE_MS,
        }
        self.emit("PROXIMITY_SIGNATURE_REQUIRED", {"fields": dict(self.pending_fields)})
        self.emit("PROXIMITY_STATE", {"state": "authorizing", "mode": self.mode})

    def _submit_signature(self, message: Dict[str, Any]) -> None:
        fields = self.pending_fields
        signature = str(message.get("signature") or "")
        public_key = str(message.get("publicKey") or "")
        if (
            not fields or not signature or len(signature) > 128
            or len(public_key) > 64 or public_key != fields.get("signerPublicKey")
        ):
            raise ValueError("unexpected_proximity_signature")
        if self.derive_address(public_key) != fields.get("address"):
            raise ValueError("proximity_signer_mismatch")
        if not self.verify_wallet(fields, public_key, signature):
            raise ValueError("invalid_proximity_signature")
        if self.pending_ephemeral_private is None:
            raise ValueError("missing_proximity_ephemeral_key")
        self.ephemeral_private = self.pending_ephemeral_private
        self.pending_ephemeral_private = None
        self.capability = dict(fields)
        self.capability_signature = signature
        self.capability_hash = hashlib.sha256(_canonical(fields) + self.decode_base58(signature)).digest()
        self.pending_fields = None
        self.enabled = True
        self.suspended = False
        self.suspended_at = None
        self.stream_generation = (self.stream_generation + 1) & 0x7FFFFFFF or 1
        self.local_media_max_sequence = -1
        self._broadcast(True)
        self._emit_state()

    def disable(self, reason: str) -> None:
        was_enabled = self.enabled
        if was_enabled:
            self._broadcast(False)
        with self.lock:
            states = list(self.links.values())
            self.links.clear()
            self.links_by_object.clear()
        for state in states:
            _safe_close(state.get("link"))
        self.enabled = False
        self.suspended = False
        self.suspended_at = None
        self.transmitting = False
        self.pending_fields = None
        self.pending_ephemeral_private = None
        self.capability = None
        self.capability_signature = ""
        self.capability_hash = b""
        self.ephemeral_private = None
        self.position = None
        self.position_sequence = -1
        self.local_media_max_sequence = -1
        with self.lock:
            pending_position = self.pending_position_command
            self.pending_position_command = None
            self.position_drain_scheduled = False
        if pending_position is not None:
            pending_position[1](pending_position[0].get("requestId"), False, "proximity_disabled")
        self.source_ids.clear()
        self.next_source_id = 1
        self.remote_capabilities.clear()
        self.remote_positions.clear()
        self.used_link_nonces.clear()
        self.path_requested_at.clear()
        self.link_retry.clear()
        self.replacement_since.clear()
        self.visible_capacity_peers.clear()
        self.diagnostic_last.clear()
        while True:
            try:
                self.local_audio_queue.get_nowait()
            except queue.Empty:
                break
        self.media_drain_scheduled = False
        self.renderer_lost_at = None
        self.emit("PROXIMITY_STATE", {"state": "off", "reason": reason, "mode": self.mode})

    def renderer_connected(self) -> None:
        self.renderer_lost_at = None
        self.stream_generation = (self.stream_generation + 1) & 0x7FFFFFFF or 1
        self.local_media_max_sequence = -1
        self.source_ids.clear()
        self.next_source_id = 1
        for peer_key, state in self.links.items():
            state["sourceId"] = self._source_id(peer_key)
            self._emit_peer(peer_key, state)

    def renderer_lost(self) -> None:
        if self.enabled and self.renderer_lost_at is None:
            self.renderer_lost_at = time.time()
        self.transmitting = False
        self._send_control_all({"c": "talk", "a": False})

    def _update_position(self, message: Dict[str, Any]) -> None:
        if not self.context:
            raise ValueError("land_context_required")
        sequence = message.get("sequence")
        x, y = message.get("x"), message.get("y")
        room = str(message.get("roomId") or "")
        if (
            not isinstance(sequence, int) or isinstance(sequence, bool)
            or sequence <= self.position_sequence
            or not isinstance(x, (int, float)) or isinstance(x, bool)
            or not isinstance(y, (int, float)) or isinstance(y, bool)
            or not math.isfinite(float(x)) or not math.isfinite(float(y))
            or not room or len(room) > 64
            or str(message.get("landSessionId") or "") != self.context["landSessionId"]
        ):
            raise ValueError("invalid_proximity_position")
        old_room = self.position.get("roomId") if self.position else None
        self.position_sequence = sequence
        self.position = {"roomId": room, "x": float(x), "y": float(y), "at": time.time()}
        if old_room != room:
            self._broadcast(True)
        self._reconcile()

    def _set_transmit(self, transmitting: bool) -> None:
        self.transmitting = bool(transmitting and self.enabled and not self.suspended)
        self._send_control_all({"c": "talk", "a": self.transmitting})
        self.emit("PROXIMITY_SPEAKING_STATE", {
            "address": self.context.get("address") if self.context else "",
            "speaking": self.transmitting,
        })

    def _set_peer_policy(self, message: Dict[str, Any]) -> None:
        address = str(message.get("address") or "")
        session_id = str(message.get("sessionId") or "")
        if len(address) < 20 or len(address) > 64:
            raise ValueError("invalid_peer_address")
        if "blocked" in message and not isinstance(message.get("blocked"), bool):
            raise ValueError("invalid_peer_block_policy")
        if "muted" in message and not isinstance(message.get("muted"), bool):
            raise ValueError("invalid_peer_mute_policy")
        if message.get("blocked") is True:
            self.blocked_addresses.add(address)
            for peer_key, capability in list(self.remote_capabilities.items()):
                if capability.get("address") == address:
                    self._drop_remote(peer_key, "blocked")
            return
        if message.get("blocked") is False:
            self.blocked_addresses.discard(address)
        volume = message.get("volume", 1.0)
        if not isinstance(volume, (int, float)) or not math.isfinite(float(volume)):
            raise ValueError("invalid_peer_volume")
        targets = [self._peer_key(address, session_id)] if session_id else [
            key for key, state in self.links.items() if state.get("address") == address
        ]
        for peer_key in targets:
            state = self.links.get(peer_key)
            if not state:
                continue
            state["muted"] = message.get("muted") is True
            state["volume"] = max(0.0, min(2.0, float(volume)))
            self._emit_peer(peer_key, state)

    def _broadcast(self, enabled: bool) -> None:
        if not self.context:
            return
        wire: Dict[str, Any] = {
            "t": DISCOVERY_TYPE,
            "v": PROTOCOL_VERSION,
            "e": bool(enabled and self.enabled),
            "a": self.context["address"],
            "g": self.context["groupId"],
            "s": self.context["landSessionId"],
            "u": self.position.get("roomId") if self.position else self.context.get("roomId", ""),
            "b": bool(self.suspended),
            "ts": int(time.time() * 1000),
            "p": 0,
        }
        if self.capability:
            wire["c"] = self.capability
            wire["z"] = self.capability_signature
            wire["h"] = self.capability_hash.hex()
        if self.ephemeral_private and wire.get("h"):
            signed_announcement = {
                key: wire[key]
                for key in ("t", "v", "e", "a", "g", "s", "u", "b", "ts", "h")
            }
            wire["j"] = self.ephemeral_private.sign(_canonical(signed_announcement)).hex()
        self.broadcast_discovery(wire)
        self.last_discovery_at = time.time()

    def on_discovery(self, wire: Dict[str, Any], peer_hash: str) -> bool:
        if wire.get("t") != DISCOVERY_TYPE:
            return False
        try:
            required_wire = {"t", "v", "e", "a", "g", "s", "u", "b", "ts", "p", "c", "z", "h", "j"}
            if (
                set(wire.keys()) != required_wire
                or wire.get("v") != PROTOCOL_VERSION
                or not isinstance(wire.get("e"), bool)
                or not isinstance(wire.get("b"), bool)
                or not isinstance(wire.get("p"), int) or isinstance(wire.get("p"), bool)
                or not 0 <= wire["p"] <= 3
                or not isinstance(wire.get("u"), str) or not 0 < len(wire["u"]) <= 64
                or not isinstance(wire.get("h"), str) or len(wire["h"]) != 64
                or not isinstance(wire.get("j"), str) or len(wire["j"]) != 128
            ):
                return True
            address = str(wire.get("a") or "")
            session_id = str(wire.get("s") or "")
            peer_key = self._peer_key(address, session_id)
            local_key = self._peer_key(
                self.context.get("address") if self.context else "",
                self.context.get("landSessionId") if self.context else "",
            )
            if not address or not session_id or not self.context or peer_key == local_key:
                return True
            if str(wire.get("g") or "") != str(self.context.get("groupId") or ""):
                return True
            timestamp = wire.get("ts")
            if (
                not isinstance(timestamp, int) or isinstance(timestamp, bool)
                or abs(int(time.time() * 1000) - timestamp) > 30_000
            ):
                return True
            fields = wire.get("c")
            signature = str(wire.get("z") or "")
            if not isinstance(fields, dict) or not self._valid_remote_capability(fields, signature, address):
                return True
            if (
                str(fields.get("groupId") or "") != str(wire.get("g") or "")
                or str(fields.get("landSessionId") or "") != str(wire.get("s") or "")
            ):
                return True
            expected_hash = hashlib.sha256(_canonical(fields) + self.decode_base58(signature)).digest()
            if str(wire.get("h") or "") != expected_hash.hex():
                return True
            announcement_signature = wire.get("j")
            signed_announcement = {
                key: wire.get(key)
                for key in ("t", "v", "e", "a", "g", "s", "u", "b", "ts", "h")
            }
            try:
                ephemeral_key = bytes.fromhex(str(fields.get("ephemeralPublicKey") or ""))
                signature_bytes = bytes.fromhex(str(announcement_signature or ""))
                if len(signature_bytes) != 64:
                    return True
                RNS.Cryptography.Ed25519PublicKey.from_public_bytes(ephemeral_key).verify(
                    signature_bytes, _canonical(signed_announcement)
                )
            except Exception:
                return True
            destination_hash = str(fields.get("destinationHash") or "").lower()
            resolved_peer = str(self.resolve_peer(address, destination_hash) or "").lower()
            if not resolved_peer:
                return True
            if wire.get("e") is not True:
                self._drop_remote(peer_key, "disabled")
                return True
            self.remote_capabilities[peer_key] = {
                "address": address, "sessionId": session_id,
                "fields": fields, "signature": signature, "hash": expected_hash,
                "peerHash": resolved_peer, "roomId": str(wire.get("u") or ""),
                "busy": wire.get("b") is True, "at": time.time(),
            }
            self._trace("discovery_accepted", address, throttle=10.0)
            self._reconcile()
        except Exception:
            self.stats["invalidFrames"] += 1
        return True

    def _valid_remote_capability(self, fields: Dict[str, Any], signature: str, address: str) -> bool:
        required = {
            "type", "protocolVersion", "address", "signerPublicKey", "ephemeralPublicKey",
            "groupId", "landSessionId", "destinationHash", "instanceId", "nonce", "createdAt", "expiresAt",
        }
        if set(fields.keys()) != required or fields.get("type") != "QORTAL_LAND_PROXIMITY_VOICE_SESSION":
            return False
        now_ms = int(time.time() * 1000)
        created, expires = fields.get("createdAt"), fields.get("expiresAt")
        if not isinstance(created, int) or not isinstance(expires, int):
            return False
        if created > now_ms + CAPABILITY_CLOCK_SKEW_MS or expires <= now_ms or expires - created > CAPABILITY_MAX_AGE_MS:
            return False
        public_key = str(fields.get("signerPublicKey") or "")
        try:
            bytes.fromhex(str(fields.get("nonce") or ""))
            bytes.fromhex(str(fields.get("ephemeralPublicKey") or ""))
        except ValueError:
            return False
        return (
            fields.get("protocolVersion") == PROTOCOL_VERSION
            and isinstance(fields.get("instanceId"), str)
            and self._valid_instance_id(str(fields.get("instanceId")))
            and isinstance(fields.get("landSessionId"), str)
            and 0 < len(str(fields.get("landSessionId"))) <= 24
            and isinstance(fields.get("destinationHash"), str)
            and len(str(fields.get("destinationHash"))) == 32
            and all(char in "0123456789abcdef" for char in str(fields.get("destinationHash")).lower())
            and isinstance(fields.get("nonce"), str)
            and len(str(fields.get("nonce"))) == 64
            and isinstance(fields.get("ephemeralPublicKey"), str)
            and len(str(fields.get("ephemeralPublicKey"))) == 64
            and fields.get("address") == address
            and self.derive_address(public_key) == address
            and self.verify_wallet(fields, public_key, signature)
        )

    @staticmethod
    def _valid_instance_id(value: str) -> bool:
        try:
            return len(value) == 36 and uuid.UUID(value).version == 4
        except (ValueError, AttributeError):
            return False

    def on_land_state(self, wire: Dict[str, Any], peer_hash: str) -> None:
        address = str(wire.get("a") or "")
        session_id = str(wire.get("s") or "")
        x, y = wire.get("x"), wire.get("y")
        timestamp = wire.get("ts")
        if (
            not address or not session_id or not isinstance(x, (int, float)) or isinstance(x, bool)
            or not isinstance(y, (int, float)) or isinstance(y, bool)
            or not math.isfinite(float(x)) or not math.isfinite(float(y))
            or not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool)
            or abs(time.time() * 1000 - float(timestamp)) > LAND_STATE_MAX_AGE * 1000
        ):
            return
        peer_key = self._peer_key(address, session_id)
        self.remote_positions[peer_key] = {
            "address": address, "groupId": str(wire.get("g") or ""), "sessionId": session_id,
            "roomId": str(wire.get("u") or ""), "x": float(x),
            "y": float(y), "peerHash": str(peer_hash or "").lower(),
            "at": time.time(),
        }
        self._reconcile()

    def _eligible(self) -> list[tuple[float, str]]:
        if not self.enabled or self.suspended or not self.position or not self.context:
            return []
        now = time.time()
        candidates: list[tuple[float, str]] = []
        for peer_key, capability in self.remote_capabilities.items():
            address = str(capability.get("address") or "")
            if address in self.blocked_addresses:
                continue
            position = self.remote_positions.get(peer_key)
            if not position or capability.get("busy"):
                continue
            if now - capability["at"] > DISCOVERY_MAX_AGE or now - position["at"] > LAND_STATE_MAX_AGE:
                continue
            if int(capability["fields"].get("expiresAt") or 0) <= int(now * 1000):
                continue
            if str(capability["fields"].get("landSessionId") or "") != str(position.get("sessionId") or ""):
                continue
            if position["roomId"] != self.position["roomId"]:
                continue
            if str(position["groupId"]) != str(self.context["groupId"]):
                continue
            distance = math.hypot(position["x"] - self.position["x"], position["y"] - self.position["y"])
            if distance <= PRECONNECT_DISTANCE or (peer_key in self.links and distance <= RELEASE_DISTANCE):
                candidates.append((distance, peer_key))
        candidates.sort(key=lambda item: (item[0], item[1]))
        by_peer = {peer_key: distance for distance, peer_key in candidates}
        capacity = 5 if now < self.capacity_reduced_until else MAX_PEERS
        selected = [peer_key for peer_key in self.links if peer_key in by_peer]
        selected.sort(key=lambda peer_key: (by_peer[peer_key], peer_key))
        selected = selected[:capacity]
        for _distance, peer_key in candidates:
            if len(selected) >= capacity:
                break
            if peer_key not in selected:
                selected.append(peer_key)
        if len(selected) >= capacity:
            outsiders = [(distance, peer_key) for distance, peer_key in candidates if peer_key not in selected]
            if outsiders:
                newcomer_distance, newcomer = outsiders[0]
                worst = max(selected, key=lambda peer_key: (by_peer[peer_key], peer_key))
                worst_distance = by_peer[worst]
                margin = max(60.0, worst_distance * 0.15)
                if newcomer_distance <= worst_distance - margin:
                    since = self.replacement_since.setdefault(newcomer, now)
                    if now - since >= 3.0:
                        selected.remove(worst)
                        selected.append(newcomer)
                        self.replacement_since.pop(newcomer, None)
                else:
                    self.replacement_since.pop(newcomer, None)
        active_candidates = {peer_key for _distance, peer_key in candidates}
        for peer_key in list(self.replacement_since):
            if peer_key not in active_candidates:
                self.replacement_since.pop(peer_key, None)
        return sorted(((by_peer[peer_key], peer_key) for peer_key in selected), key=lambda item: (item[0], item[1]))

    def _reconcile(self) -> None:
        selected = {peer_key: distance for distance, peer_key in self._eligible()}
        now = time.time()
        capacity = 5 if now < self.capacity_reduced_until else MAX_PEERS
        for peer_key, state in list(self.links.items()):
            distance = selected.get(peer_key)
            if distance is None:
                remote_position = self.remote_positions.get(peer_key)
                if (
                    self.position and remote_position
                    and remote_position.get("roomId") != self.position.get("roomId")
                ):
                    state.setdefault("roomMismatchAt", now)
                    if now - state["roomMismatchAt"] >= 5.0:
                        self._close_peer(peer_key, "room_changed")
                    continue
                state.pop("roomMismatchAt", None)
                if len(selected) >= capacity and float(state.get("distance") or 9999) <= RELEASE_DISTANCE:
                    self._close_peer(peer_key, "capacity_rebalanced")
                    continue
                state.setdefault("outsideAt", now)
                if now - state["outsideAt"] >= 30 or float(state.get("distance") or 9999) > RELEASE_DISTANCE:
                    self._close_peer(peer_key, "out_of_range")
                continue
            state.pop("outsideAt", None)
            state.pop("roomMismatchAt", None)
            state["distance"] = distance
            self._emit_peer(peer_key, state)
        local_key = self._peer_key(str(self.context["address"]), str(self.context["landSessionId"]))
        for peer_key, distance in selected.items():
            if peer_key in self.links:
                continue
            if local_key < peer_key:
                self._open_peer(peer_key, distance)
        visible_capacity: set[str] = set()
        if self.enabled and self.position:
            now = time.time()
            for peer_key, capability in self.remote_capabilities.items():
                address = str(capability.get("address") or "")
                if peer_key in selected or peer_key in self.links or address in self.blocked_addresses:
                    continue
                distance = self._distance_to(peer_key)
                if (
                    distance <= PRECONNECT_DISTANCE
                    and now - float(capability.get("at") or 0) <= DISCOVERY_MAX_AGE
                    and capability.get("busy") is not True
                ):
                    visible_capacity.add(peer_key)
                    self._emit_peer(peer_key, {
                        "address": address, "sessionId": capability.get("sessionId"),
                        "phase": "capacity", "sourceId": self._source_id(peer_key),
                        "authenticated": False, "muted": False, "volume": 1.0,
                    })
        for peer_key in self.visible_capacity_peers - visible_capacity:
            capability = self.remote_capabilities.get(peer_key) or {}
            self.emit("PROXIMITY_PEER_STATE", {
                "peerKey": peer_key, "address": capability.get("address", ""),
                "sessionId": capability.get("sessionId", ""), "state": "disconnected",
                "sourceId": self.source_ids.get(peer_key, 0), "reason": "not_nearby",
            })
        self.visible_capacity_peers = visible_capacity

    def _open_peer(self, peer_key: str, distance: float) -> None:
        retry = self.link_retry.get(peer_key) or {}
        if time.time() < float(retry.get("nextAt") or 0):
            return
        capability = self.remote_capabilities.get(peer_key)
        if not capability:
            return
        address = str(capability.get("address") or "")
        session_id = str(capability.get("sessionId") or "")
        advertised_hash = str(capability.get("fields", {}).get("destinationHash") or "").lower()
        peer_hash = str(self.resolve_peer(address, advertised_hash) or "").lower()
        if not peer_hash or peer_hash != advertised_hash:
            return
        identity = self.resolve_identity(peer_hash) if peer_hash else None
        if identity is None:
            self._trace("candidate_waiting_identity", address, throttle=5.0)
            return
        try:
            destination = self.build_destination(identity)
            destination_hash = bytes(destination.hash)
            if not RNS.Transport.has_path(destination_hash):
                now = time.time()
                if now - self.path_requested_at.get(peer_key, 0) >= 1.0:
                    self.path_requested_at[peer_key] = now
                    RNS.Transport.request_path(destination_hash)
                    self._trace("candidate_requesting_path", address, throttle=5.0)
                return
            state = {
                "peerKey": peer_key, "address": address, "sessionId": session_id,
                "peerHash": peer_hash, "distance": distance,
                "phase": "opening", "createdAt": time.time(), "lastActivity": time.time(),
                "authenticated": False, "muted": False, "volume": 1.0,
                "sourceId": self._source_id(peer_key), "txSequence": 0,
                "sendLock": threading.RLock(),
            }
            link = RNS.Link(destination, established_callback=self._outbound_established, closed_callback=self._link_closed)
            state["link"] = link
            with self.lock:
                self.links[peer_key] = state
                self.links_by_object[id(link)] = peer_key
            self._trace("link_opening", address)
            self._emit_peer(peer_key, state)
        except Exception as exc:
            self.stats["linkFailures"] += 1
            self._schedule_retry(peer_key)
            self.log(f"[qortalland-proximity] open failed peer={address[:8]} code={str(exc)[:80]}")

    def _schedule_retry(self, peer_key: str) -> None:
        previous = self.link_retry.get(peer_key) or {}
        attempts = min(6, int(previous.get("attempts") or 0) + 1)
        delay = min(5.0, 0.25 * (2 ** (attempts - 1)))
        self.link_retry[peer_key] = {"attempts": attempts, "nextAt": time.time() + delay}

    def _outbound_established(self, link) -> None:
        state = self._state_for_link(link)
        if not state or not self.capability or not self.ephemeral_private or not self.position:
            return
        link_id = bytes(self.link_id_bytes(link) or b"")
        nonce = secrets.token_bytes(16)
        hello = {
            "v": PROTOCOL_VERSION, "f": self.context["address"], "t": state["address"],
            "g": str(self.context["groupId"]), "s": self.context["landSessionId"],
            "o": state["sessionId"],
            "r": self.position["roomId"], "c": self.capability_hash, "l": link_id,
            "n": nonce, "ts": int(time.time() * 1000),
        }
        hello["z"] = self.ephemeral_private.sign(umsgpack.packb(hello))
        raw = LINK_MAGIC + umsgpack.packb(hello)
        if len(raw) > 425:
            self._close_peer(state["peerKey"], "classifier_oversized")
            return
        state["phase"] = "authenticating"
        state["linkId"] = link_id
        state["nonce"] = nonce
        link.set_packet_callback(self._on_packet)
        self._send_packet(state, raw)
        self._trace("classifier_sent", state["address"])
        self._emit_peer(state["peerKey"], state)

    def handle_classifier(self, link, raw: bytes) -> bool:
        if not isinstance(raw, (bytes, bytearray)) or not raw.startswith(LINK_MAGIC):
            return False
        try:
            hello = umsgpack.unpackb(bytes(raw[len(LINK_MAGIC):]))
            if not isinstance(hello, dict) or not self._verify_link_hello(link, hello):
                self._trace("classifier_rejected", str(hello.get("f") or "") if isinstance(hello, dict) else "", "validation")
                _safe_close(link)
                return True
            address = str(hello["f"])
            session_id = str(hello["s"])
            peer_key = self._peer_key(address, session_id)
            capacity = 5 if time.time() < self.capacity_reduced_until else MAX_PEERS
            if len(self.links) >= capacity and peer_key not in self.links:
                self._send_control({"link": link}, {"c": "reject", "r": "capacity"})
                _safe_close(link)
                return True
            existing = self.links.get(peer_key)
            if existing:
                _safe_close(existing.get("link"))
            position = self.remote_positions.get(peer_key) or {}
            remote = self.remote_capabilities.get(peer_key) or {}
            state = {
                "peerKey": peer_key, "address": address, "sessionId": session_id,
                "peerHash": str(remote.get("fields", {}).get("destinationHash") or ""),
                "distance": self._distance_to(peer_key), "phase": "connected", "link": link,
                "linkId": bytes(self.link_id_bytes(link) or b""), "authenticated": True,
                "createdAt": time.time(), "lastActivity": time.time(), "muted": False,
                "volume": 1.0, "sourceId": self._source_id(peer_key), "txSequence": 0,
                "remoteCapabilityHash": hello["c"], "nonce": hello["n"],
                "sendLock": threading.RLock(),
            }
            with self.lock:
                self.links[peer_key] = state
                self.links_by_object[id(link)] = peer_key
            self.link_retry.pop(peer_key, None)
            link.set_packet_callback(self._on_packet)
            link.set_link_closed_callback(self._link_closed)
            accept = {
                "v": PROTOCOL_VERSION, "a": self.context["address"],
                "c": "accept", "f": self.context["address"], "t": address,
                "s": self.context["landSessionId"], "o": session_id,
                "h": self.capability_hash, "q": hello["c"], "l": state["linkId"],
                "n": hello["n"], "r": secrets.token_bytes(16),
                "ts": int(time.time() * 1000),
            }
            accept["z"] = self.ephemeral_private.sign(umsgpack.packb(accept))
            state["authAccept"] = accept
            state["lastAuthAccept"] = time.time()
            state["authAcceptAttempts"] = 1
            self._send_control(state, accept)
            self._trace("accept_sent", address)
            self._emit_peer(peer_key, state)
        except Exception:
            self.stats["invalidFrames"] += 1
            _safe_close(link)
        return True

    def _verify_link_hello(self, link, hello: Dict[str, Any]) -> bool:
        required = {"v", "f", "t", "g", "s", "o", "r", "c", "l", "n", "ts", "z"}
        if (
            set(hello.keys()) != required or hello.get("v") != PROTOCOL_VERSION
            or not self.context or not self.enabled or self.suspended or not self.capability
        ):
            return False
        address = str(hello.get("f") or "")
        session_id = str(hello.get("s") or "")
        peer_key = self._peer_key(address, session_id)
        local_key = self._peer_key(str(self.context["address"]), str(self.context["landSessionId"]))
        remote = self.remote_capabilities.get(peer_key)
        now = time.time()
        # Exactly one side is allowed to initiate, so crossed/duplicate links
        # converge without timing-dependent winner selection.
        if (
            not remote or now - float(remote.get("at") or 0) > DISCOVERY_MAX_AGE
            or peer_key >= local_key
            or hello.get("t") != self.context["address"]
            or hello.get("o") != self.context["landSessionId"]
            or str(hello.get("g")) != str(self.context["groupId"])
        ):
            return False
        destination_hash = str(remote.get("fields", {}).get("destinationHash") or "").lower()
        resolved_peer = str(self.resolve_peer(address, destination_hash) or "").lower()
        link_peer = str(self.resolve_link_peer_hash(link) or "").lower() if self.resolve_link_peer_hash else ""
        if not resolved_peer or resolved_peer != destination_hash or link_peer != destination_hash:
            return False
        if hello.get("c") != remote["hash"] or hello.get("l") != bytes(self.link_id_bytes(link) or b""):
            return False
        position = self.remote_positions.get(peer_key) or {}
        if (
            not self.position
            or now - float(self.position.get("at") or 0) > LAND_STATE_MAX_AGE
            or now - float(position.get("at") or 0) > LAND_STATE_MAX_AGE
            or (
            hello.get("s") != remote["fields"].get("landSessionId")
            or hello.get("s") != position.get("sessionId")
            or hello.get("r") != self.position.get("roomId")
            or hello.get("r") != position.get("roomId")
            )
        ):
            return False
        nonce = hello.get("n")
        if not isinstance(nonce, bytes) or len(nonce) != 16 or nonce in self.used_link_nonces:
            return False
        if abs(int(time.time() * 1000) - int(hello.get("ts") or 0)) > CAPABILITY_CLOCK_SKEW_MS:
            return False
        signed = dict(hello)
        signature = signed.pop("z")
        ephemeral_hex = str(remote["fields"].get("ephemeralPublicKey") or "")
        try:
            RNS.Cryptography.Ed25519PublicKey.from_public_bytes(bytes.fromhex(ephemeral_hex)).verify(signature, umsgpack.packb(signed))
        except Exception:
            return False
        self.used_link_nonces[nonce] = now
        return self._distance_to(peer_key) <= PRECONNECT_DISTANCE

    def _send_packet(self, state: Dict[str, Any], raw: bytes) -> None:
        link = state.get("link")
        if link is None:
            return
        send_lock = state.get("sendLock")
        if send_lock is None:
            send_lock = threading.RLock()
            state["sendLock"] = send_lock
        with send_lock:
            RNS.Packet(link, raw).send()
        state["lastSend"] = time.time()

    def _send_control(self, state: Dict[str, Any], payload: Dict[str, Any]) -> None:
        link = state.get("link")
        if link is None:
            return
        # Signed handshake controls already contain ``v`` and ``ts``. Preserve
        # their insertion order because MessagePack signatures cover the exact
        # encoded bytes, not just the map's key/value pairs.
        if "v" in payload and "ts" in payload:
            body = dict(payload)
        else:
            body = {"v": PROTOCOL_VERSION, "ts": int(time.time() * 1000), **payload}
        raw = CONTROL_MAGIC + umsgpack.packb(body)
        if len(raw) > 425:
            raise ValueError("proximity_control_oversized")
        self._send_packet(state, raw)

    def _send_control_all(self, payload: Dict[str, Any]) -> None:
        for state in list(self.links.values()):
            if state.get("authenticated"):
                try:
                    self._send_control(state, payload)
                except Exception:
                    pass

    def _on_packet(self, raw: bytes, packet) -> None:
        link = getattr(packet, "link", None)
        state = self._state_for_link(link)
        if not state:
            return
        state["lastActivity"] = time.time()
        if raw.startswith(CONTROL_MAGIC):
            try:
                control = umsgpack.unpackb(raw[len(CONTROL_MAGIC):])
            except Exception:
                return
            command = control.get("c") if isinstance(control, dict) else None
            if (
                not isinstance(control, dict) or control.get("v") != PROTOCOL_VERSION
                or abs(int(time.time() * 1000) - int(control.get("ts") or 0)) > CAPABILITY_CLOCK_SKEW_MS
            ):
                self.stats["invalidFrames"] += 1
                return
            if command == "accept":
                remote = self.remote_capabilities.get(state["peerKey"])
                required = {"v", "a", "c", "f", "t", "s", "o", "h", "q", "l", "n", "r", "ts", "z"}
                rejection = ""
                if not remote:
                    rejection = "missing_remote_capability"
                elif set(control.keys()) != required:
                    rejection = "schema"
                elif control.get("h") != remote.get("hash"):
                    rejection = "remote_capability_hash"
                elif control.get("q") != self.capability_hash:
                    rejection = "local_capability_hash"
                elif control.get("f") != state["address"]:
                    rejection = "sender"
                elif control.get("s") != state["sessionId"]:
                    rejection = "sender_session"
                elif not self.context or control.get("t") != self.context["address"]:
                    rejection = "recipient"
                elif not self.context or control.get("o") != self.context["landSessionId"]:
                    rejection = "recipient_session"
                elif control.get("l") != state.get("linkId"):
                    rejection = "link_id"
                elif control.get("n") != state.get("nonce"):
                    rejection = "nonce"
                elif not isinstance(control.get("r"), bytes) or len(control["r"]) != 16:
                    rejection = "response_nonce"
                elif abs(int(time.time() * 1000) - int(control.get("ts") or 0)) > CAPABILITY_CLOCK_SKEW_MS:
                    rejection = "timestamp"
                if rejection:
                    self._trace("accept_rejected", state["address"], rejection, throttle=2.0)
                    return
                signed = dict(control)
                signature = signed.pop("z")
                try:
                    remote_key = bytes.fromhex(str(remote["fields"].get("ephemeralPublicKey") or ""))
                    RNS.Cryptography.Ed25519PublicKey.from_public_bytes(remote_key).verify(
                        signature, umsgpack.packb(signed)
                    )
                except Exception:
                    self._trace("accept_rejected", state["address"], "signature", throttle=2.0)
                    return
                state["authenticated"] = True
                state["phase"] = "connected"
                self.link_retry.pop(state["peerKey"], None)
                self._send_control(state, {
                    "c": "auth_ack", "l": state["linkId"], "n": state["nonce"],
                })
                self._trace("link_authenticated", state["address"], "outbound")
                self._emit_peer(state["peerKey"], state)
            elif command == "auth_ack":
                if (
                    set(control.keys()) != {"v", "ts", "c", "l", "n"}
                    or control.get("l") != state.get("linkId")
                    or control.get("n") != state.get("nonce")
                    or not state.get("authAccept")
                ):
                    return
                state.pop("authAccept", None)
                state.pop("lastAuthAccept", None)
                state.pop("authAcceptAttempts", None)
                state["authenticated"] = True
                state["phase"] = "connected"
                self.link_retry.pop(state["peerKey"], None)
                self._trace("link_authenticated", state["address"], "inbound")
                self._emit_peer(state["peerKey"], state)
            elif command == "ping":
                if set(control.keys()) != {"v", "ts", "c"}:
                    return
                self._send_control(state, {"c": "pong"})
            elif command == "pong":
                if set(control.keys()) != {"v", "ts", "c"}:
                    return
                ping_at = float(state.get("pingAt") or 0)
                if ping_at > 0:
                    state["rttMs"] = max(0, int((time.time() - ping_at) * 1000))
                    state["pingAt"] = 0.0
            elif command == "talk":
                if set(control.keys()) != {"v", "ts", "c", "a"} or not isinstance(control.get("a"), bool):
                    return
                state["remoteSpeaking"] = control.get("a") is True
                state["speakingUntil"] = time.time() + 0.35 if state["remoteSpeaking"] else 0.0
                self.emit("PROXIMITY_SPEAKING_STATE", {
                    "peerKey": state["peerKey"], "address": state["address"],
                    "sessionId": state["sessionId"], "speaking": state["remoteSpeaking"],
                })
            elif command in {"pause", "resume"}:
                if set(control.keys()) != {"v", "ts", "c"}:
                    return
                state["remotePaused"] = command == "pause"
                if command == "pause":
                    self.emit("PROXIMITY_SPEAKING_STATE", {
                        "peerKey": state["peerKey"], "address": state["address"],
                        "sessionId": state["sessionId"], "speaking": False,
                    })
                self._emit_peer(state["peerKey"], state)
            elif command == "close":
                if not set(control.keys()).issubset({"v", "ts", "c", "r"}):
                    return
                self._close_peer(state["peerKey"], "remote_closed")
            elif command == "reject":
                if set(control.keys()) != {"v", "ts", "c", "r"}:
                    return
                self._close_peer(state["peerKey"], str(control.get("r") or "rejected")[:40])
            return
        if not raw.startswith(MEDIA_MAGIC) or not state.get("authenticated"):
            return
        try:
            magic, version, flags, generation, sequence, capture_ms, length = RNS_AUDIO_HEADER.unpack_from(raw)
            payload = raw[RNS_AUDIO_HEADER.size:]
            if (
                magic != MEDIA_MAGIC or version != PROTOCOL_VERSION or flags != 0
                or length != len(payload) or not payload or length > MAX_OPUS_BYTES
            ):
                raise ValueError("invalid media")
            if state.get("muted") or state.get("remotePaused") or self.suspended or self._distance_to(state["peerKey"]) > AUDIBLE_EXIT_DISTANCE:
                return
            if state.get("rxGeneration") != generation:
                retired = state.setdefault("rxRetiredGenerations", set())
                if generation in retired:
                    self.stats["staleDrops"] += 1
                    return
                previous_generation = state.get("rxGeneration")
                if previous_generation is not None:
                    retired.add(previous_generation)
                    if len(retired) > 8:
                        retired.pop()
                state["rxGeneration"] = generation
                state["rxMaxSequence"] = sequence
                state["rxSeenSequences"] = {sequence}
            else:
                seen = state.setdefault("rxSeenSequences", set())
                maximum = int(state.get("rxMaxSequence") or 0)
                if sequence in seen:
                    self.stats["duplicateDrops"] += 1
                    return
                if maximum > sequence and maximum - sequence > 32:
                    self.stats["staleDrops"] += 1
                    return
                seen.add(sequence)
                if sequence > maximum:
                    if maximum >= 0 and sequence > maximum + 1:
                        self.stats["sequenceSkips"] += sequence - maximum - 1
                    maximum = sequence
                    state["rxMaxSequence"] = sequence
                state["rxSeenSequences"] = {item for item in seen if maximum - item <= 32}
            frame = LOCAL_AUDIO_HEADER.pack(
                LOCAL_AUDIO_MAGIC, PROTOCOL_VERSION, 1, state["sourceId"], generation,
                sequence, int(time.time() * 1000), len(payload),
            ) + payload
            if self.send_binary(frame, state["sourceId"]):
                self.stats["receivedFrames"] += 1
                state["speakingUntil"] = time.time() + 0.35
                if not state.get("remoteSpeaking"):
                    state["remoteSpeaking"] = True
                    self.emit("PROXIMITY_SPEAKING_STATE", {
                        "peerKey": state["peerKey"], "address": state["address"],
                        "sessionId": state["sessionId"], "speaking": True,
                    })
        except Exception:
            self.stats["invalidFrames"] += 1

    def handle_local_audio(self, raw: bytes) -> bool:
        if not isinstance(raw, bytes) or len(raw) > MAX_LOCAL_AUDIO_BYTES:
            self.stats["invalidFrames"] += 1
            return False
        try:
            magic, version, kind, source_id, generation, sequence, captured_at, length = LOCAL_AUDIO_HEADER.unpack_from(raw)
            payload = raw[LOCAL_AUDIO_HEADER.size:]
            if (
                magic != LOCAL_AUDIO_MAGIC or version != PROTOCOL_VERSION or kind != 0 or source_id != 0
                or generation != self.stream_generation
                or length != len(payload) or not payload or length > MAX_OPUS_BYTES
            ):
                raise ValueError("invalid local media")
            now_ms = int(time.time() * 1000)
            if captured_at > now_ms + 2_000:
                self.stats["invalidFrames"] += 1
                return False
            if now_ms - captured_at > 200:
                self.stats["staleDrops"] += 1
                return True
            if sequence <= self.local_media_max_sequence:
                self.stats["staleDrops"] += 1
                return True
            self.local_media_max_sequence = sequence
            if not self.enabled or self.suspended or not self.transmitting:
                return True
            self.stats["localFrames"] += 1
            for state in list(self.links.values()):
                if not state.get("authenticated") or state.get("remotePaused") or self._distance_to(state["peerKey"]) > AUDIBLE_EXIT_DISTANCE:
                    continue
                frame = RNS_AUDIO_HEADER.pack(MEDIA_MAGIC, PROTOCOL_VERSION, 0, generation, sequence, captured_at & 0xFFFFFFFF, len(payload)) + payload
                try:
                    self._send_packet(state, frame)
                    self.stats["sentFrames"] += 1
                except Exception:
                    self.stats["linkFailures"] += 1
            return True
        except Exception:
            self.stats["invalidFrames"] += 1
            return False

    def queue_local_audio(self, raw: bytes) -> bool:
        if not isinstance(raw, bytes) or len(raw) < LOCAL_AUDIO_HEADER.size or len(raw) > MAX_LOCAL_AUDIO_BYTES:
            return False
        item = (time.time(), raw)
        try:
            self.local_audio_queue.put_nowait(item)
        except queue.Full:
            try:
                self.local_audio_queue.get_nowait()
                self.stats["queueDrops"] += 1
                self.stats["localQueueDrops"] += 1
                self.capacity_reduced_until = time.time() + 10.0
                self.local_audio_queue.put_nowait(item)
            except (queue.Empty, queue.Full):
                self.stats["queueDrops"] += 1
                self.stats["localQueueDrops"] += 1
                return True
        with self.lock:
            if self.media_drain_scheduled:
                return True
            self.media_drain_scheduled = True
        if not self.enqueue_media(self._drain_local_audio, ()):
            with self.lock:
                self.media_drain_scheduled = False
            return False
        return True

    def _drain_local_audio(self) -> None:
        started_at = time.monotonic()
        drained = 0
        while drained < MEDIA_DRAIN_MAX_FRAMES:
            try:
                queued_at, raw = self.local_audio_queue.get_nowait()
            except queue.Empty:
                break
            if time.time() - queued_at <= 0.2:
                self.handle_local_audio(raw)
            else:
                self.stats["staleDrops"] += 1
            drained += 1
            # Drain short bursts in one scheduler turn instead of repeatedly
            # yielding after four frames. Retain a strict time budget so media
            # cannot monopolise its RNS lane when a send becomes slow.
            if drained >= 4 and time.monotonic() - started_at >= MEDIA_DRAIN_TIME_BUDGET:
                break
        with self.lock:
            self.media_drain_scheduled = False
            has_more = not self.local_audio_queue.empty()
        if has_more:
            with self.lock:
                if self.media_drain_scheduled:
                    return
                self.media_drain_scheduled = True
            if not self.enqueue_media(self._drain_local_audio, ()):
                with self.lock:
                    self.media_drain_scheduled = False
    def tick(self) -> None:
        now = time.time()
        if self.renderer_lost_at is not None and now - self.renderer_lost_at >= 30.0:
            self.disable("renderer_recovery_expired")
            return
        if self.suspended_at is not None and now - self.suspended_at >= 30.0:
            for peer_key in list(self.links):
                self._close_peer(peer_key, "call_suspension_timeout")
        if self.pending_fields and int(self.pending_fields.get("createdAt") or 0) + CAPABILITY_CLOCK_SKEW_MS <= int(now * 1000):
            self.disable("authorization_expired")
            return
        if self.capability and int(self.capability.get("expiresAt") or 0) <= int(now * 1000):
            self.disable("capability_expired")
            return
        if (
            self.enabled and self.capability and not self.pending_fields
            and int(self.capability.get("expiresAt") or 0) - int(now * 1000) <= 5 * 60 * 1000
        ):
            self._enable({"mode": self.mode})
        if self.enabled and now - self.last_discovery_at >= 10:
            self._broadcast(True)
        if self.enabled and now - self.last_stats_at >= 5:
            self.last_stats_at = now
            self.emit("PROXIMITY_TRANSPORT_STATS", {
                "stats": dict(self.stats),
                "bitrate": 16000 if now < self.capacity_reduced_until else 24000,
                "capacityReduced": now < self.capacity_reduced_until,
            })
        if self.enabled and now - self.last_media_log_at >= 15 and (
            self.stats["localFrames"] or self.stats["receivedFrames"]
        ):
            self.last_media_log_at = now
            self.log(
                "[qortalland-proximity] stage=media_stats "
                f"peers={sum(1 for state in self.links.values() if state.get('authenticated'))} "
                f"local={self.stats['localFrames']} sent={self.stats['sentFrames']} "
                f"received={self.stats['receivedFrames']} skips={self.stats['sequenceSkips']} "
                f"duplicates={self.stats['duplicateDrops']} stale={self.stats['staleDrops']} "
                f"queueDrops={self.stats['queueDrops']} localQueueDrops={self.stats['localQueueDrops']} "
                f"rendererQueueDrops={self.stats['rendererQueueDrops']} invalid={self.stats['invalidFrames']} "
                f"linkFailures={self.stats['linkFailures']}"
            )
        for nonce, used_at in list(self.used_link_nonces.items()):
            if now - used_at > 300:
                self.used_link_nonces.pop(nonce, None)
        for peer_key, capability in list(self.remote_capabilities.items()):
            if now - float(capability.get("at") or 0) > DISCOVERY_MAX_AGE:
                self._drop_remote(peer_key, "discovery_expired")
        for peer_key, state in list(self.links.items()):
            if state.get("remoteSpeaking") and now >= float(state.get("speakingUntil") or 0):
                state["remoteSpeaking"] = False
                self.emit("PROXIMITY_SPEAKING_STATE", {
                    "peerKey": peer_key, "address": state["address"],
                    "sessionId": state["sessionId"], "speaking": False,
                })
            age = now - float(state.get("lastActivity") or state.get("createdAt") or now)
            if state.get("authenticated") and age > LINK_DEAD_AFTER:
                self._schedule_retry(peer_key)
                self._close_peer(peer_key, "heartbeat_timeout")
                continue
            if not state.get("authenticated") and now - float(state.get("createdAt") or now) > LINK_TIMEOUT:
                self._schedule_retry(peer_key)
                self._close_peer(peer_key, "establishment_timeout")
                continue
            if (
                state.get("authAccept")
                and now - float(state.get("lastAuthAccept") or 0) >= 1.0
            ):
                attempts = int(state.get("authAcceptAttempts") or 1)
                if attempts >= 10:
                    state.pop("authAccept", None)
                    state.pop("lastAuthAccept", None)
                    state.pop("authAcceptAttempts", None)
                else:
                    try:
                        state["lastAuthAccept"] = now
                        state["authAcceptAttempts"] = attempts + 1
                        self._send_control(state, state["authAccept"])
                    except Exception:
                        self.stats["linkFailures"] += 1
            if state.get("authenticated") and now - float(state.get("lastSend") or 0) >= HEARTBEAT_INTERVAL:
                try:
                    state["pingAt"] = now
                    self._send_control(state, {"c": "ping"})
                except Exception:
                    pass
        self._reconcile()

    def owns_link(self, link) -> bool:
        return id(link) in self.links_by_object

    def _link_closed(self, link) -> None:
        state = self._state_for_link(link)
        if state:
            peer_key = state["peerKey"]
            with self.lock:
                self.links_by_object.pop(id(link), None)
                if self.links.get(peer_key, {}).get("link") is link:
                    self.links.pop(peer_key, None)
            self._schedule_retry(peer_key)
            self._trace("link_closed", state["address"], "callback", throttle=1.0)
            self.emit("PROXIMITY_PEER_STATE", {
                "peerKey": peer_key, "address": state["address"], "sessionId": state["sessionId"],
                "state": "disconnected", "sourceId": state.get("sourceId", 0),
            })

    def _close_peer(self, peer_key: str, reason: str) -> None:
        state = self.links.pop(peer_key, None)
        if not state:
            return
        link = state.get("link")
        self.links_by_object.pop(id(link), None)
        try:
            if state.get("authenticated"):
                self._send_control(state, {"c": "close", "r": reason})
        except Exception:
            pass
        _safe_close(link)
        self.emit("PROXIMITY_PEER_STATE", {
            "peerKey": peer_key, "address": state["address"], "sessionId": state["sessionId"],
            "state": "disconnected", "reason": reason, "sourceId": state.get("sourceId", 0),
        })

    def _drop_remote(self, peer_key: str, reason: str) -> None:
        self.remote_capabilities.pop(peer_key, None)
        self.remote_positions.pop(peer_key, None)
        self._close_peer(peer_key, reason)
        self.source_ids.pop(peer_key, None)
        self.path_requested_at.pop(peer_key, None)
        self.link_retry.pop(peer_key, None)
        self.replacement_since.pop(peer_key, None)
        self.visible_capacity_peers.discard(peer_key)

    def _state_for_link(self, link) -> Optional[Dict[str, Any]]:
        peer_key = self.links_by_object.get(id(link))
        return self.links.get(peer_key) if peer_key else None

    def _distance_to(self, peer_key: str) -> float:
        remote = self.remote_positions.get(peer_key)
        if (
            not remote or not self.position
            or time.time() - float(remote.get("at") or 0) > LAND_STATE_MAX_AGE
            or remote.get("roomId") != self.position.get("roomId")
        ):
            return float("inf")
        return math.hypot(float(remote["x"]) - self.position["x"], float(remote["y"]) - self.position["y"])

    def _source_id(self, peer_key: str) -> int:
        existing = self.source_ids.get(peer_key)
        if existing:
            return existing
        source_id = self.next_source_id
        self.next_source_id = 1 if source_id >= 65535 else source_id + 1
        self.source_ids[peer_key] = source_id
        return source_id

    def _gain(self, distance: float) -> float:
        if distance <= FULL_VOLUME_DISTANCE:
            return 1.0
        if distance >= AUDIBLE_DISTANCE:
            return 0.0
        t = (distance - FULL_VOLUME_DISTANCE) / (AUDIBLE_DISTANCE - FULL_VOLUME_DISTANCE)
        return max(0.0, min(1.0, 1.0 - (t * t * (3.0 - 2.0 * t))))

    def _emit_peer(self, peer_key: str, state: Dict[str, Any]) -> None:
        capability = self.remote_capabilities.get(peer_key) or {}
        address = str(state.get("address") or capability.get("address") or "")
        session_id = str(state.get("sessionId") or capability.get("sessionId") or "")
        distance = self._distance_to(peer_key)
        remote = self.remote_positions.get(peer_key) or {}
        relative_x = 0.0 if not self.position else float(remote.get("x") or self.position["x"]) - self.position["x"]
        self.emit("PROXIMITY_PEER_STATE", {
            "peerKey": peer_key, "address": address, "sessionId": session_id,
            "state": state.get("phase", "nearby"),
            "sourceId": state.get("sourceId", self._source_id(peer_key)),
            "distance": distance if math.isfinite(distance) else None,
            "gain": self._gain(distance), "pan": max(-0.65, min(0.65, relative_x / 300.0)),
            "muted": state.get("muted") is True, "volume": state.get("volume", 1.0),
            "rttMs": state.get("rttMs"),
            "audible": (
                distance <= AUDIBLE_EXIT_DISTANCE and state.get("authenticated") is True
                and not self.suspended and not state.get("remotePaused")
            ),
        })

    def _emit_state(self) -> None:
        state = "suspended" if self.suspended else "ready" if self.enabled else "off"
        self.emit("PROXIMITY_STATE", {
            "state": state, "mode": self.mode, "transmitting": self.transmitting,
            "connected": sum(1 for item in self.links.values() if item.get("authenticated")),
            "maxPeers": MAX_PEERS, "streamGeneration": self.stream_generation,
        })

    def _emit_snapshot(self, diagnostics: bool = False) -> None:
        peers = []
        for peer_key, state in self.links.items():
            distance = self._distance_to(peer_key)
            remote = self.remote_positions.get(peer_key) or {}
            relative_x = 0.0 if not self.position else float(remote.get("x") or self.position["x"]) - self.position["x"]
            peers.append({
                "peerKey": peer_key, "address": state.get("address", ""),
                "sessionId": state.get("sessionId", ""),
                "state": state.get("phase"), "sourceId": state.get("sourceId"),
                "distance": distance if math.isfinite(distance) else None, "gain": self._gain(distance),
                "pan": max(-0.65, min(0.65, relative_x / 300.0)),
                "muted": state.get("muted") is True, "volume": state.get("volume", 1.0),
                "audible": (
                    distance <= AUDIBLE_EXIT_DISTANCE and state.get("authenticated") is True
                    and not self.suspended and not state.get("remotePaused")
                ),
            })
        payload: Dict[str, Any] = {
            "enabled": self.enabled, "suspended": self.suspended, "mode": self.mode,
            "transmitting": self.transmitting, "streamGeneration": self.stream_generation,
            "peers": peers,
        }
        if diagnostics:
            payload["stats"] = dict(self.stats)
        self.emit("PROXIMITY_SNAPSHOT", payload)
