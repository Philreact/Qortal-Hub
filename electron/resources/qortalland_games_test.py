import json
import time
import unittest

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
            "8ab8939dc9b20b1b6607882d575f86f922b6538deb7eff06298063a829a54fff",
        )

    def test_compact_invite_round_trip_fits_classifier_packet(self):
        fields = {
            "type": "QORTAL_LAND_GAME_INVITE",
            "protocolVersion": 1,
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

    def test_completed_match_closes_without_blocking_an_immediate_rematch(self):
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
        self.assertEqual(manager.cooldowns, {})
        self.assertEqual(events[-1], ("GAME_ENDED", {"matchId": match_id, "outcome": "completed"}))

    def test_cancelled_invitation_keeps_the_pair_cooldown(self):
        manager, _events = self.make_manager()
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

        self.assertGreater(manager.cooldowns[opponent], time.time())

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
