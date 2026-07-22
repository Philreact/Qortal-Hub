import json
import threading
import time
import unittest
from unittest import mock

import RNS

from qortalland_games import (
    GameMessage,
    MAGIC,
    MAX_CHANNEL_PAYLOAD,
    QortalLandGameManager,
    _b58encode,
    canonical_bytes,
    derive_qortal_address,
    umsgpack,
    verify_signature,
)


class QortalLandGameProtocolTest(unittest.TestCase):
    def setUp(self):
        self.manager = object.__new__(QortalLandGameManager)
        self.private_key = RNS.Cryptography.Ed25519PrivateKey.generate()
        self.public_key = _b58encode(self.private_key.public_key().public_bytes())
        self.address = derive_qortal_address(self.public_key)

    def make_manager(self):
        events = []
        manager = QortalLandGameManager(
            emit=lambda *_args: None,
            log=lambda *_args: None,
            resolve_peer=lambda _address: "11" * 16,
            resolve_identity=lambda _peer: object(),
            build_destination=lambda identity: identity,
            link_id_bytes=lambda _link: b"\x22" * 16,
            enqueue=lambda fn, args: bool(fn(*args) is None or True),
        )
        manager.send_event = lambda event, payload=None: events.append((event, payload or {}))
        return manager, events

    def test_missing_path_uses_bridge_hard_refresh(self):
        refreshes = []

        class Destination:
            hash = bytes.fromhex("11" * 16)

        manager, _events = self.make_manager()
        manager.build_destination = lambda _identity: Destination()
        manager.refresh_path = lambda peer, reason: refreshes.append((peer, reason)) or False
        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        manager.matches[match_id] = {
            "matchId": match_id,
            "peerHash": "11" * 16,
            "phase": "establishing",
            "establishDeadline": time.time() + 30,
            "openAttempts": 0,
        }
        manager._schedule_open_retry = mock.Mock()

        with mock.patch.object(RNS.Transport, "has_path", return_value=False), mock.patch.object(
            RNS.Transport, "request_path"
        ) as request_path:
            manager._attempt_open(match_id)

        self.assertEqual(refreshes, [("11" * 16, "game_link_no_path")])
        request_path.assert_called_once_with(bytes.fromhex("11" * 16))
        manager._schedule_open_retry.assert_called_once_with(match_id)

    def test_socket_writer_drains_media_without_waiting_on_empty_control_queue(self):
        manager, _events = self.make_manager()

        class Socket:
            def __init__(self):
                self.frames = []

            def send(self, frame):
                self.frames.append(frame)

            def close(self, *_args):
                pass

        socket = Socket()
        manager.socket = socket
        for index in range(8):
            self.assertTrue(manager.send_binary(bytes([index]), source_id=1))

        writer = threading.Thread(target=manager._socket_writer, daemon=True)
        writer.start()
        deadline = time.monotonic() + 0.1
        while len(socket.frames) < 8 and time.monotonic() < deadline:
            time.sleep(0.001)
        manager.stop_event.set()
        manager.socket_writer_wakeup.set()
        writer.join(timeout=0.2)

        self.assertEqual(socket.frames, [bytes([index]) for index in range(8)])
        self.assertEqual(manager.proximity.stats["rendererQueueDrops"], 0)

    def test_failed_link_attempt_hard_refreshes_before_retry(self):
        refreshes = []
        manager, _events = self.make_manager()
        manager.refresh_path = lambda peer, reason: refreshes.append((peer, reason)) or True
        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        link = object()
        manager.matches[match_id] = {
            "matchId": match_id,
            "peerHash": "11" * 16,
            "phase": "establishing",
            "establishDeadline": time.time() + 30,
            "openAttempts": 1,
            "link": link,
        }
        manager.links_by_object[id(link)] = match_id
        manager._schedule_open_retry = mock.Mock()

        with mock.patch.object(RNS.Transport, "request_path") as request_path:
            manager._link_closed(link)

        self.assertEqual(refreshes, [("11" * 16, "game_link_attempt_closed")])
        request_path.assert_not_called()
        manager._schedule_open_retry.assert_called_once_with(match_id)

    def test_qortal_address_cross_language_fixture(self):
        self.assertEqual(
            derive_qortal_address("1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE"),
            "QhxqB8rvXYDguai48oNNjfRCUigaXHmf8Q",
        )

    def test_signature_verification_rejects_altered_fields(self):
        fields = {"address": self.address, "matchId": "match", "type": "fixture"}
        signature = _b58encode(self.private_key.sign(canonical_bytes(fields)))
        self.assertTrue(verify_signature(fields, self.public_key, signature))
        self.assertFalse(verify_signature({**fields, "matchId": "other"}, self.public_key, signature))

    def test_initial_state_hash_matches_typescript_fixture(self):
        state = {
            "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "requesterNonce": "11" * 16,
            "recipientNonce": "22" * 15 + "00",
        }
        # This seed selects the requester (seat 1).
        self.assertEqual(self.manager._starter(state), "requester")
        self.assertEqual(
            self.manager._initial_state_hash(state),
            "c095c107701a8a8137e036b8e917173b93663115cde740dd29500c600ca77aaf",
        )

    def test_checkers_initial_state_hash_matches_typescript_fixture(self):
        state = {
            "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "roundId": "00112233-4455-6677-8899-aabbccddeeff",
            "requesterNonce": "11" * 16,
            "recipientNonce": "22" * 15 + "00",
            "game": "checkers",
            "rulesVersion": 1,
        }
        self.assertEqual(self.manager._starter(state), "requester")
        self.assertEqual(
            self.manager._initial_state_hash(state),
            "d8f380b461ea12fe5c662de0ba7c5707de3afdf36ec1f9d4222719b6b22cad7e",
        )

    def test_chess_initial_state_hash_matches_typescript_fixture(self):
        state = {
            "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "roundId": "00112233-4455-6677-8899-aabbccddeeff",
            "requesterNonce": "11" * 16,
            "recipientNonce": "22" * 15 + "00",
            "game": "chess",
            "rulesVersion": 1,
        }
        self.assertEqual(self.manager._starter(state), "recipient")
        self.assertEqual(
            self.manager._initial_state_hash(state),
            "cc48133f2305d376d6d48e9e858239ae9ea6db7af7692c607d68b0af8a70a8bb",
        )

    def test_checkers_move_shape_supports_paths_and_rejects_columns(self):
        state = {
            "game": "checkers", "roundId": "00112233-4455-6677-8899-aabbccddeeff",
            "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "requesterNonce": "11" * 16, "recipientNonce": "22" * 15 + "00",
            "transcript": [],
        }
        move = {
            "messageId": "11112233-4455-4677-8899-aabbccddeeff", "ply": 1,
            "from": 42, "path": [24, 10],
            "previousStateHash": self.manager._initial_state_hash(state),
            "resultingStateHash": "33" * 32,
        }
        self.manager._validate_move_shape(state, move)
        with self.assertRaisesRegex(ValueError, "invalid_checkers_move"):
            self.manager._validate_move_shape(state, {**move, "path": []})

    def test_chess_move_shape_supports_promotion(self):
        state = {
            "game": "chess", "roundId": "00112233-4455-6677-8899-aabbccddeeff",
            "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "requesterNonce": "11" * 16, "recipientNonce": "22" * 15 + "00",
            "transcript": [],
        }
        move = {
            "messageId": "11112233-4455-4677-8899-aabbccddeeff", "ply": 1,
            "from": 8, "to": 0, "promotion": 5,
            "previousStateHash": self.manager._initial_state_hash(state),
            "resultingStateHash": "33" * 32,
        }
        self.manager._validate_move_shape(state, move)
        with self.assertRaisesRegex(ValueError, "invalid_chess_move"):
            self.manager._validate_move_shape(state, {**move, "promotion": 6})
        with self.assertRaisesRegex(ValueError, "invalid_chess_move"):
            self.manager._validate_move_shape(state, {**move, "promotion": []})
        with self.assertRaisesRegex(ValueError, "invalid_chess_move"):
            self.manager._validate_move_shape(state, {**move, "promotion": True})

    def test_compact_invite_round_trip_fits_classifier_packet(self):
        fields = {
            "type": "QORTAL_LAND_GAME_INVITE",
            "protocolVersion": 2,
            "game": "connect-four",
            "gameVersion": 1,
            "rulesVersion": 1,
            "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "groupId": "123",
            "requesterAddress": self.address,
            "recipientAddress": self.address,
            "signerPublicKey": self.public_key,
            "requesterNonce": "11" * 16,
            "linkId": "22" * 16,
            "createdAt": 1_760_000_000_000,
            "expiresAt": 1_760_000_060_000,
        }
        envelope = {
            "fields": fields,
            "publicKey": self.public_key,
            "signature": _b58encode(self.private_key.sign(canonical_bytes(fields))),
        }
        packed = self.manager._encode_handshake(envelope)
        raw = MAGIC + umsgpack.packb(packed)
        self.assertLessEqual(len(raw), MAX_CHANNEL_PAYLOAD)
        self.assertEqual(self.manager._decode_handshake(umsgpack.unpackb(raw[4:])), envelope)

    def test_compact_resume_request_binds_round_and_fits_classifier_packet(self):
        fields = {
            "type": "QORTAL_LAND_GAME_RESUME_REQUEST",
            "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "roundId": "11112233-4455-4677-8899-aabbccddeeff",
            "requesterAddress": self.address,
            "signerPublicKey": self.public_key,
            "linkId": "22" * 16,
            "requesterNonce": "33" * 16,
            "lastAcknowledgedPly": 4,
            "stateHash": "44" * 32,
            "transcriptHash": "55" * 32,
            "createdAt": int(time.time() * 1000),
        }
        envelope = {
            "fields": fields,
            "publicKey": self.public_key,
            "signature": _b58encode(self.private_key.sign(canonical_bytes(fields))),
        }
        raw = MAGIC + umsgpack.packb(self.manager._encode_handshake(envelope))
        self.assertLessEqual(len(raw), MAX_CHANNEL_PAYLOAD)
        self.assertEqual(self.manager._decode_handshake(umsgpack.unpackb(raw[4:])), envelope)

    def test_signed_resume_accept_keeps_resume_confirmation_phase(self):
        manager, _events = self.make_manager()

        class Channel:
            def send(self, message):
                message.pack()
                return object()

        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        round_id = "11112233-4455-4677-8899-aabbccddeeff"
        fields = {
            "type": "QORTAL_LAND_GAME_RESUME_ACCEPT",
            "matchId": match_id,
            "roundId": round_id,
            "responderAddress": self.address,
            "signerPublicKey": self.public_key,
            "linkId": "22" * 16,
            "requesterNonce": "33" * 16,
            "recipientNonce": "44" * 16,
            "lastAcknowledgedPly": 0,
            "stateHash": "55" * 32,
            "transcriptHash": "66" * 32,
            "createdAt": int(time.time() * 1000),
        }
        challenge_id = "resume-challenge"
        manager.matches[match_id] = {
            "matchId": match_id,
            "roundId": round_id,
            "phase": "awaiting_resume_confirm",
            "channel": Channel(),
            "lastActivity": time.time(),
        }
        manager.signature_challenges[challenge_id] = {
            "matchId": match_id,
            "kind": fields["type"],
            "fields": fields,
            "created": time.time(),
        }
        manager._submit_signature({
            "challengeId": challenge_id,
            "publicKey": self.public_key,
            "signature": _b58encode(self.private_key.sign(canonical_bytes(fields))),
        })
        self.assertEqual(manager.matches[match_id]["phase"], "awaiting_resume_confirm")

    def test_outgoing_move_enters_transcript_only_after_remote_ack(self):
        manager, events = self.make_manager()

        class Channel:
            def send(self, _message):
                return object()

        state = {
            "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "requester": self.address,
            "recipient": self.address,
            "requesterNonce": "11" * 16,
            "recipientNonce": "22" * 15 + "00",
            "phase": "active",
            "channel": Channel(),
            "transcript": [],
            "lastActivity": 0,
        }
        manager.matches[state["matchId"]] = state
        move = {
            "type": "MOVE",
            "messageId": "10000000-0000-4000-8000-000000000001",
            "ply": 1,
            "column": 3,
            "previousStateHash": manager._initial_state_hash(state),
            "resultingStateHash": "aa" * 32,
        }
        manager._send_active({"matchId": state["matchId"], "message": move})
        self.assertEqual(state["transcript"], [])
        manager._on_channel(
            state["matchId"],
            GameMessage({
                "k": "game",
                "m": {
                    "type": "MOVE_ACK",
                    "matchId": state["matchId"],
                    "messageId": move["messageId"],
                    "ply": 1,
                    "stateHash": move["resultingStateHash"],
                },
            }),
        )
        self.assertEqual(len(state["transcript"]), 1)
        self.assertEqual(events[-1][0], "GAME_MESSAGE")

    def test_incoming_move_enters_transcript_only_after_local_ack(self):
        manager, _events = self.make_manager()

        class Channel:
            def send(self, _message):
                return object()

        state = {
            "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "requester": self.address,
            "recipient": self.address,
            "requesterNonce": "11" * 16,
            "recipientNonce": "22" * 15 + "00",
            "phase": "active",
            "channel": Channel(),
            "transcript": [],
            "lastActivity": 0,
        }
        manager.matches[state["matchId"]] = state
        move = {
            "type": "MOVE",
            "matchId": state["matchId"],
            "messageId": "10000000-0000-4000-8000-000000000002",
            "ply": 1,
            "column": 2,
            "previousStateHash": manager._initial_state_hash(state),
            "resultingStateHash": "bb" * 32,
        }
        manager._on_channel(state["matchId"], GameMessage({"k": "game", "m": move}))
        self.assertEqual(state["transcript"], [])
        manager._send_active({
            "matchId": state["matchId"],
            "message": {
                "type": "MOVE_ACK",
                "messageId": move["messageId"],
                "ply": 1,
                "stateHash": move["resultingStateHash"],
            },
        })
        self.assertEqual(len(state["transcript"]), 1)

    def test_websocket_authenticates_before_accepting_context(self):
        manager, _events = self.make_manager()
        manager.token = "token"
        manager.instance_id = "instance"

        class Request:
            headers = {"Origin": "capacitor-electron://-"}

        class Socket:
            request = Request()

            def __init__(self, token):
                self.token = token
                self.closed = None
                self.sent = []

            def recv(self, timeout=None):
                self.timeout = timeout
                return json.dumps({"type": "AUTH", "token": self.token, "instanceId": "instance"})

            def __iter__(self):
                return iter([json.dumps({
                    "type": "SET_LAND_CONTEXT",
                    "requestId": "request",
                    "address": self_address,
                    "publicKey": self_public_key,
                    "groupId": "1",
                    "landSessionId": "land",
                    "roomId": "room",
                })])

            def send(self, value):
                self.sent.append(value)

            def close(self, code, reason):
                self.closed = (code, reason)

        self_address = self.address
        self_public_key = self.public_key
        invalid = Socket("wrong")
        manager._socket_handler(invalid)
        self.assertIsNotNone(invalid.closed)
        self.assertIsNone(manager.land_context)

        valid = Socket("token")
        manager._socket_handler(valid)
        self.assertEqual(manager.land_context["address"], self.address)
        self.assertEqual(valid.timeout, 2.0)

    def test_development_origin_parsing_rejects_non_loopback_userinfo(self):
        manager, _events = self.make_manager()
        manager.development = True
        self.assertTrue(manager._origin_allowed("http://127.0.0.1:5173"))
        self.assertTrue(manager._origin_allowed("http://localhost:5173"))
        self.assertFalse(manager._origin_allowed("http://localhost:5173.example.test"))
        self.assertFalse(manager._origin_allowed("http://localhost:5173@evil.example"))
        manager.development = False
        self.assertFalse(manager._origin_allowed("http://127.0.0.1:5173"))

    def test_snapshot_preserves_an_unacknowledged_outbound_move(self):
        manager, _events = self.make_manager()
        pending = {"messageId": "10000000-0000-4000-8000-000000000003", "ply": 1}
        state = {
            "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "requester": self.address,
            "recipient": self.address,
            "requesterNonce": "11" * 16,
            "recipientNonce": "22" * 15 + "00",
            "phase": "active",
            "transcript": [],
            "pendingOutboundMoves": {pending["messageId"]: pending},
        }
        self.assertEqual(manager._public_state(state)["pendingOutboundMove"], pending)

    def test_explicit_completed_close_releases_match(self):
        manager, events = self.make_manager()
        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        manager.matches[match_id] = {
            "matchId": match_id,
            "phase": "ending",
            "outbound": True,
            "requester": self.address,
            "recipient": "Qopponent1111111111111111111111111111",
        }

        manager._cancel_or_close_match(match_id, completed=True)

        self.assertNotIn(match_id, manager.matches)
        self.assertEqual(events[-1], ("GAME_ENDED", {"matchId": match_id, "outcome": "completed"}))

    def test_round_completion_keeps_authenticated_channel(self):
        manager, events = self.make_manager()

        class Channel:
            def __init__(self):
                self.sent = []

            def send(self, message):
                self.sent.append(message.payload)
                return object()

        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        channel = Channel()
        manager.matches[match_id] = {
            "matchId": match_id,
            "roundId": match_id,
            "phase": "ending",
            "channel": channel,
            "outbound": True,
            "requester": self.address,
            "recipient": "Qopponent1111111111111111111111111111",
            "transcript": [],
        }

        manager._send_active({
            "matchId": match_id,
            "message": {"type": "GAME_OVER_ACK", "messageId": "10000000-0000-4000-8000-000000000010", "ply": 0, "stateHash": "aa" * 32},
        })

        self.assertIn(match_id, manager.matches)
        self.assertIs(manager.matches[match_id]["channel"], channel)
        self.assertEqual(manager.matches[match_id]["phase"], "session_idle")
        self.assertEqual(events[-1][0], "GAME_LINK_STATE")

    def test_next_game_reuses_channel_and_can_switch_game_type(self):
        manager, _events = self.make_manager()

        class Channel:
            def __init__(self):
                self.sent = []

            def send(self, message):
                self.sent.append(message.payload)
                return object()

        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        round_id = "11112233-4455-4677-8899-aabbccddeeff"
        channel = Channel()
        state = {
            "matchId": match_id,
            "roundId": match_id,
            "phase": "session_idle",
            "channel": channel,
            "outbound": True,
            "requester": self.address,
            "recipient": "Qopponent1111111111111111111111111111",
            "requesterNonce": "11" * 16,
            "recipientNonce": "22" * 16,
            "game": "connect-four",
            "gameVersion": 1,
            "rulesVersion": 1,
            "transcript": [{"ply": 1}],
        }
        manager.matches[match_id] = state
        manager._send_active({
            "matchId": match_id,
            "message": {
                "type": "ROUND_REQUEST", "messageId": "10000000-0000-4000-8000-000000000011",
                "roundId": round_id, "requesterNonce": "33" * 16,
                "game": "checkers", "gameVersion": 1, "rulesVersion": 1,
            },
        })
        manager._on_channel(match_id, GameMessage({"k": "game", "m": {
            "type": "ROUND_RESPONSE", "matchId": match_id,
            "messageId": "10000000-0000-4000-8000-000000000012",
            "roundId": round_id, "accepted": True, "recipientNonce": "44" * 16,
        }}))

        self.assertIs(state["channel"], channel)
        self.assertEqual(state["phase"], "active")
        self.assertEqual(state["roundId"], round_id)
        self.assertEqual(state["game"], "checkers")
        self.assertEqual(state["transcript"], [])

    def test_largest_checkers_move_fits_channel_payload(self):
        message = GameMessage({"k": "game", "m": {
            "type": "MOVE", "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "roundId": "11112233-4455-4677-8899-aabbccddeeff",
            "messageId": "22222233-4455-4677-8899-aabbccddeeff", "ply": 200,
            "from": 63, "path": list(range(12)),
            "previousStateHash": "aa" * 32, "resultingStateHash": "bb" * 32,
        }})
        self.assertLessEqual(len(message.pack()), MAX_CHANNEL_PAYLOAD)

    def test_chess_promotion_move_fits_channel_payload(self):
        message = GameMessage({"k": "game", "m": {
            "type": "MOVE", "matchId": "00112233-4455-6677-8899-aabbccddeeff",
            "roundId": "11112233-4455-4677-8899-aabbccddeeff",
            "messageId": "22222233-4455-4677-8899-aabbccddeeff", "ply": 600,
            "from": 8, "to": 0, "promotion": 5,
            "previousStateHash": "aa" * 32, "resultingStateHash": "bb" * 32,
        }})
        self.assertLessEqual(len(message.pack()), MAX_CHANNEL_PAYLOAD)

    def test_reusable_round_accepts_each_supported_game(self):
        manager, _events = self.make_manager()
        state = {"roundId": "00112233-4455-6677-8899-aabbccddeeff"}
        for index, game in enumerate(("connect-four", "checkers", "chess"), start=1):
            manager._validate_round_control(state, {
                "roundId": f"{index:08d}-4455-4677-8899-aabbccddeeff",
                "game": game, "gameVersion": 1, "rulesVersion": 1,
            })

    def test_delayed_move_from_previous_round_is_ignored(self):
        manager, events = self.make_manager()
        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        state = {
            "matchId": match_id,
            "roundId": "11112233-4455-4677-8899-aabbccddeeff",
            "phase": "active", "transcript": [], "lastRx": time.time(),
        }
        manager.matches[match_id] = state
        manager._on_channel(match_id, GameMessage({"k": "game", "m": {
            "type": "MOVE", "matchId": match_id,
            "roundId": "22222233-4455-4677-8899-aabbccddeeff",
            "messageId": "10000000-0000-4000-8000-000000000013", "ply": 1, "column": 3,
            "previousStateHash": "aa" * 32, "resultingStateHash": "bb" * 32,
        }}))
        self.assertEqual(state["transcript"], [])
        self.assertFalse(any(event == "GAME_ERROR" for event, _payload in events))

    def test_chat_chunks_reassemble_and_fit_channel_limit(self):
        sender, _sender_events = self.make_manager()
        receiver, receiver_events = self.make_manager()

        class Channel:
            def __init__(self):
                self.messages = []

            def send(self, message):
                self.assert_payload_fits(message)
                self.messages.append(message.payload)
                return object()

            @staticmethod
            def assert_payload_fits(message):
                if len(message.pack()) > MAX_CHANNEL_PAYLOAD:
                    raise AssertionError("chat chunk exceeded channel payload")

        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        sender_channel = Channel()
        receiver_channel = Channel()
        sender_state = {
            "matchId": match_id, "roundId": match_id, "phase": "active",
            "channel": sender_channel, "outbound": True,
            "requester": self.address, "recipient": "Qremote111111111111111111111111111111",
            "chatMessages": [],
        }
        receiver_state = {
            "matchId": match_id, "roundId": match_id, "phase": "active",
            "channel": receiver_channel, "outbound": False,
            "requester": self.address, "recipient": "Qremote111111111111111111111111111111",
            "chatMessages": [], "lastRx": time.time(),
        }
        sender.matches[match_id] = sender_state
        receiver.matches[match_id] = receiver_state
        text_value = "🙂" * 500
        message_id = "10000000-0000-4000-8000-000000000014"

        sender._send_active({"matchId": match_id, "message": {
            "type": "CHAT_MESSAGE", "messageId": message_id,
            "text": text_value, "createdAt": int(time.time() * 1000),
        }})
        for payload in sender_channel.messages:
            receiver._on_channel(match_id, GameMessage(payload))

        self.assertGreater(len(sender_channel.messages), 1)
        self.assertEqual(receiver_state["chatMessages"][0]["text"], text_value)
        self.assertEqual(receiver_events[-1][0], "GAME_MESSAGE")
        self.assertEqual(receiver_events[-1][1]["matchId"], match_id)
        self.assertEqual(receiver_events[-1][1]["message"]["matchId"], match_id)
        self.assertEqual(receiver_channel.messages[-1]["m"]["type"], "CHAT_ACK")

    def test_chat_snapshot_history_is_batched_below_local_frame_limit(self):
        manager, _events = self.make_manager()
        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        manager.matches[match_id] = {"chatMessages": [
            {
                "messageId": str(index).zfill(36), "authorAddress": self.address,
                "text": "🙂" * 500, "createdAt": index + 1, "delivered": True,
            }
            for index in range(100)
        ]}
        batches = manager._chat_history_batches(match_id)
        self.assertEqual(sum(len(batch["messages"]) for batch in batches), 100)
        self.assertTrue(all(len(json.dumps(batch).encode("utf-8")) <= 16 * 1024 for batch in batches))

    def test_typing_signal_never_tears_down_the_game(self):
        manager, events = self.make_manager()
        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        state = {
            "matchId": match_id, "roundId": match_id, "phase": "active",
            "requester": self.address, "recipient": "Qremote111111111111111111111111111111",
            "outbound": False, "lastRx": time.time(),
        }
        manager.matches[match_id] = state

        manager._on_channel(match_id, GameMessage({"k": "game", "m": {
            "type": "CHAT_TYPING", "matchId": match_id, "active": True,
        }}))
        self.assertEqual(state["phase"], "active")
        self.assertEqual(events[-1][0], "GAME_MESSAGE")

        manager._on_channel(match_id, GameMessage({"k": "game", "m": {
            "type": "CHAT_TYPING", "matchId": match_id, "active": "yes",
        }}))
        self.assertIn(match_id, manager.matches)
        self.assertEqual(state["phase"], "active")
        self.assertEqual(events[-1][1]["code"], "chat_error")

    def test_cancelled_invitation_releases_match_immediately(self):
        manager, events = self.make_manager()
        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        opponent = "Qopponent1111111111111111111111111111"
        manager.matches[match_id] = {
            "matchId": match_id,
            "phase": "awaiting_response",
            "outbound": True,
            "requester": self.address,
            "recipient": opponent,
            "channel": None,
        }

        manager._cancel_or_close_match(match_id)

        self.assertNotIn(match_id, manager.matches)
        self.assertEqual(events[-1], ("GAME_ENDED", {"matchId": match_id, "outcome": "cancelled"}))

    def test_signed_accept_cannot_change_the_responder_identity(self):
        manager, _events = self.make_manager()
        match_id = "00112233-4455-6677-8899-aabbccddeeff"
        state = {
            "matchId": match_id,
            "phase": "awaiting_response",
            "outbound": True,
            "requester": "Qrequester111111111111111111111111111",
            "recipient": self.address,
            "requesterNonce": "11" * 16,
            "inviteHash": "33" * 32,
            "linkId": "22" * 16,
        }
        fields = {
            "type": "QORTAL_LAND_GAME_ACCEPT",
            "inviteHash": state["inviteHash"],
            "matchId": match_id,
            "requesterNonce": state["requesterNonce"],
            "recipientNonce": "44" * 16,
            "responderAddress": state["requester"],
            "signerPublicKey": self.public_key,
            "linkId": state["linkId"],
            "createdAt": int(time.time() * 1000),
        }
        envelope = {
            "fields": fields,
            "publicKey": self.public_key,
            "signature": _b58encode(self.private_key.sign(canonical_bytes(fields))),
        }
        with self.assertRaisesRegex(ValueError, "invalid_accept"):
            manager._handle_handshake(state, envelope)


if __name__ == "__main__":
    unittest.main()
