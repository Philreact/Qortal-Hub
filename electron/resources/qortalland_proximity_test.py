import struct
import time
import unittest
from unittest.mock import patch

import RNS
from RNS.vendor import umsgpack

from presence_bridge import (
    _MAX_ENCRYPTED_WIRE_BYTES,
    _decode_qortalland_proximity_discovery,
    _encode_qortalland_proximity_discovery,
)
from qortalland_games import _b58encode, canonical_bytes, derive_qortal_address, verify_signature, _b58decode
from qortalland_proximity import (
    CONTROL_MAGIC,
    LINK_MAGIC,
    LOCAL_AUDIO_HEADER,
    LOCAL_AUDIO_MAGIC,
    QortalLandProximityVoiceManager,
)


class ProximityVoiceManagerTest(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.discovery = []
        self.wallet = RNS.Cryptography.Ed25519PrivateKey.generate()
        self.public_key = _b58encode(self.wallet.public_key().public_bytes())
        self.address = derive_qortal_address(self.public_key)
        self.manager = QortalLandProximityVoiceManager(
            emit=lambda event, payload: self.events.append((event, payload)),
            send_binary=lambda _frame, _source: True,
            log=lambda _message: None,
            resolve_peer=lambda _address, preferred="": preferred or None,
            resolve_identity=lambda _peer: None,
            build_destination=lambda identity: identity,
            link_id_bytes=lambda _link: b"\0" * 16,
            enqueue=lambda fn, args: bool(fn(*args) is not False),
            broadcast_discovery=self.discovery.append,
            verify_wallet=verify_signature,
            derive_address=derive_qortal_address,
            decode_base58=_b58decode,
            identify_link=lambda _link: None,
        )
        self.manager.set_context({
            "address": self.address,
            "publicKey": self.public_key,
            "groupId": "7",
            "landSessionId": "land-1",
            "roomId": "club",
            "localDestinationHash": "aa" * 16,
            "instanceId": "00112233-4455-4677-8899-aabbccddeeff",
        })

    def authorize(self):
        self.manager._enable({"mode": "push-to-talk"})
        fields = self.manager.pending_fields
        signature = _b58encode(self.wallet.sign(canonical_bytes(fields)))
        self.manager._submit_signature({"signature": signature, "publicKey": self.public_key})

    def test_tick_is_idle_until_land_context_exists(self):
        self.manager.context = None
        self.manager._reconcile = lambda: self.fail("reconcile ran without land context")

        self.manager.tick()

    def test_reconcile_is_idle_without_land_context(self):
        self.manager.context = None
        self.manager._eligible = lambda: self.fail("eligibility ran without land context")

        self.manager._reconcile()

    def test_tick_reconciles_when_land_context_exists(self):
        reconciled = []
        self.manager._reconcile = lambda: reconciled.append(True)

        self.manager.tick()

        self.assertEqual(reconciled, [True])

    def test_enable_requires_wallet_signature_and_disable_clears_secrets(self):
        self.authorize()
        self.assertTrue(self.manager.enabled)
        self.assertEqual(len(self.manager.capability_hash), 32)
        self.manager.disable("test")
        self.assertFalse(self.manager.enabled)
        self.assertIsNone(self.manager.ephemeral_private)
        self.assertEqual(self.manager.capability_signature, "")

    def test_outbound_link_identifies_before_classifier(self):
        self.authorize()
        self.manager._update_position({
            "landSessionId": "land-1", "sequence": 1,
            "roomId": "club", "x": 10, "y": 10,
        })
        order = []
        self.manager.identify_link = lambda _link: order.append("identify")

        class Link:
            def set_packet_callback(self, _callback):
                order.append("callback")

        link = Link()
        peer_key = "peer:session"
        self.manager.links[peer_key] = {
            "peerKey": peer_key,
            "address": "Q-peer",
            "sessionId": "peer-session",
            "link": link,
            "phase": "opening",
        }
        self.manager.links_by_object[id(link)] = peer_key
        self.manager._send_packet = lambda _state, _raw: order.append("classifier") or True

        self.manager._outbound_established(link)

        self.assertEqual(order[0], "identify")
        self.assertLess(order.index("identify"), order.index("classifier"))

    def test_rejects_tampered_session_signature(self):
        self.manager._enable({"mode": "push-to-talk"})
        with self.assertRaisesRegex(ValueError, "invalid_proximity_signature"):
            self.manager._submit_signature({
                "signature": _b58encode(b"x" * 64),
                "publicKey": self.public_key,
            })

    def test_local_binary_audio_is_unsigned_and_gated_by_transmit(self):
        self.authorize()
        self.manager._update_position({
            "landSessionId": "land-1", "sequence": 1,
            "roomId": "club", "x": 10, "y": 10,
        })
        payload = b"opus"
        frame = LOCAL_AUDIO_HEADER.pack(
            LOCAL_AUDIO_MAGIC, 1, 0, 0, self.manager.stream_generation,
            1, int(time.time() * 1000), len(payload),
        ) + payload
        self.assertTrue(self.manager.handle_local_audio(frame))
        self.assertEqual(self.manager.stats["localFrames"], 0)
        self.manager._set_transmit(True)
        frame = LOCAL_AUDIO_HEADER.pack(
            LOCAL_AUDIO_MAGIC, 1, 0, 0, self.manager.stream_generation,
            2, int(time.time() * 1000), len(payload),
        ) + payload
        self.assertTrue(self.manager.handle_local_audio(frame))
        self.assertEqual(self.manager.stats["localFrames"], 1)

    def test_media_drain_consumes_a_short_burst_in_one_scheduler_turn(self):
        self.authorize()
        self.manager._set_transmit(True)
        scheduled = []
        self.manager.enqueue_media = lambda fn, args: bool(scheduled.append((fn, args)) or True)
        captured_at = int(time.time() * 1000)
        for sequence in range(1, 13):
            payload = f"opus-{sequence}".encode()
            frame = LOCAL_AUDIO_HEADER.pack(
                LOCAL_AUDIO_MAGIC, 1, 0, 0, self.manager.stream_generation,
                sequence, captured_at, len(payload),
            ) + payload
            self.assertTrue(self.manager.queue_local_audio(frame))

        self.assertEqual(len(scheduled), 1)
        fn, args = scheduled.pop()
        fn(*args)
        self.assertEqual(self.manager.stats["localFrames"], 12)
        self.assertTrue(self.manager.local_audio_queue.empty())
        self.assertEqual(scheduled, [])

    def test_local_media_queue_reports_its_own_overflow_counter(self):
        scheduled = []
        self.manager.enqueue_media = lambda fn, args: bool(scheduled.append((fn, args)) or True)
        captured_at = int(time.time() * 1000)
        for sequence in range(1, 34):
            payload = b"opus"
            frame = LOCAL_AUDIO_HEADER.pack(
                LOCAL_AUDIO_MAGIC, 1, 0, 0, self.manager.stream_generation,
                sequence, captured_at, len(payload),
            ) + payload
            self.assertTrue(self.manager.queue_local_audio(frame))

        self.assertEqual(self.manager.stats["queueDrops"], 1)
        self.assertEqual(self.manager.stats["localQueueDrops"], 1)
        self.assertEqual(self.manager.stats["rendererQueueDrops"], 0)

    def test_distance_gain_has_full_fade_and_silence_boundaries(self):
        self.assertEqual(self.manager._gain(50), 1.0)
        self.assertGreater(self.manager._gain(250), 0.0)
        self.assertLess(self.manager._gain(250), 1.0)
        self.assertEqual(self.manager._gain(400), 0.0)

    def test_command_schema_rejects_extra_fields(self):
        results = []
        self.manager.handle_command(
            {"type": "GET_PROXIMITY_STATE", "requestId": "one", "unsafe": True},
            lambda *args, **kwargs: results.append((args, kwargs)),
        )
        self.assertFalse(results[0][0][1])
        self.assertIn("schema", results[0][0][2])

    def test_renderer_replacement_rotates_media_generation_and_source_ids(self):
        self.authorize()
        first_generation = self.manager.stream_generation
        self.manager.source_ids["peer"] = 41
        self.manager.renderer_connected()
        self.assertNotEqual(self.manager.stream_generation, first_generation)
        self.assertEqual(self.manager.source_ids, {})

    def test_authoritative_shared_path_opens_peer_when_local_table_misses(self):
        peer_hash = "11" * 16
        peer_key = "Q-remote:land-remote"

        class Destination:
            hash = bytes.fromhex(peer_hash)

        self.manager.remote_capabilities[peer_key] = {
            "address": "Q-remote",
            "sessionId": "land-remote",
            "fields": {"destinationHash": peer_hash},
        }
        self.manager.resolve_peer = lambda _address, preferred="": preferred
        self.manager.resolve_identity = lambda _peer: object()
        self.manager.build_destination = lambda _identity: Destination()
        self.manager.path_available = lambda _destination_hash: True
        link = object()

        with patch.object(RNS.Transport, "has_path", return_value=False), patch.object(
            RNS, "Link", return_value=link
        ) as open_link, patch.object(RNS.Transport, "request_path") as request_path:
            self.manager._open_peer(peer_key, 10.0)

        open_link.assert_called_once()
        request_path.assert_not_called()
        self.assertEqual(self.manager.links[peer_key]["link"], link)

    def test_malformed_proximity_classifier_is_consumed_and_closed(self):
        class Link:
            closed = False

            def teardown(self):
                self.closed = True

        link = Link()
        self.assertTrue(self.manager.handle_classifier(link, LINK_MAGIC + b"not-msgpack"))
        self.assertTrue(link.closed)

    def test_compact_discovery_fits_reticulum_and_round_trips_maximum_fields(self):
        self.manager.set_context({
            "address": self.address,
            "publicKey": self.public_key,
            "groupId": str(0x7FFFFFFF),
            "landSessionId": "s" * 24,
            "roomId": "r" * 64,
            "localDestinationHash": "aa" * 16,
            "instanceId": "00112233-4455-4677-8899-aabbccddeeff",
        })
        self.authorize()
        wire = self.discovery[-1]
        encoded = _encode_qortalland_proximity_discovery(wire)
        self.assertIsNotNone(encoded)
        self.assertLessEqual(len(encoded), _MAX_ENCRYPTED_WIRE_BYTES)
        self.assertEqual(_decode_qortalland_proximity_discovery(encoded), wire)

    def test_discovery_announcement_signature_rejects_changed_room(self):
        remote_wallet = RNS.Cryptography.Ed25519PrivateKey.generate()
        remote_public_key = _b58encode(remote_wallet.public_key().public_bytes())
        remote_address = derive_qortal_address(remote_public_key)
        remote_discovery = []
        remote = QortalLandProximityVoiceManager(
            emit=lambda *_args: None,
            send_binary=lambda *_args: True,
            log=lambda _message: None,
            resolve_peer=lambda _address, preferred="": preferred or None,
            resolve_identity=lambda _peer: None,
            build_destination=lambda identity: identity,
            link_id_bytes=lambda _link: b"\0" * 16,
            enqueue=lambda fn, args: bool(fn(*args) is not False),
            broadcast_discovery=remote_discovery.append,
            verify_wallet=verify_signature,
            derive_address=derive_qortal_address,
            decode_base58=_b58decode,
        )
        remote.set_context({
            "address": remote_address,
            "publicKey": remote_public_key,
            "groupId": "7",
            "landSessionId": "land-1",
            "roomId": "club",
            "localDestinationHash": "bb" * 16,
            "instanceId": "11112233-4455-4677-8899-aabbccddeeff",
        })
        remote._enable({"mode": "push-to-talk"})
        remote._submit_signature({
            "signature": _b58encode(remote_wallet.sign(canonical_bytes(remote.pending_fields))),
            "publicKey": remote_public_key,
        })
        # A freshly signed Land capability must not depend on the separate
        # presence-lease cache having caught up yet. The exact RNS endpoint is
        # still authenticated when the private link handshake completes.
        self.manager.resolve_peer = lambda _address, preferred="": None
        encoded = _encode_qortalland_proximity_discovery(remote_discovery[-1])
        self.assertIsNotNone(encoded)
        decoded = _decode_qortalland_proximity_discovery(encoded)
        self.assertIsNotNone(decoded)
        tampered = {**decoded, "u": "another-room"}
        self.assertTrue(self.manager.on_discovery(tampered, "cd" * 16))
        remote_key = self.manager._peer_key(remote_address, "land-1")
        self.assertNotIn(remote_key, self.manager.remote_capabilities)
        self.assertTrue(self.manager.on_discovery(decoded, "cd" * 16))
        self.assertIn(remote_key, self.manager.remote_capabilities)

    def test_same_account_land_sessions_keep_independent_routes_and_audio_sources(self):
        self.authorize()
        self.manager._update_position({
            "landSessionId": "land-1", "sequence": 1,
            "roomId": "club", "x": 0, "y": 0,
        })
        resolved = []
        self.manager.resolve_peer = lambda address, preferred="": (
            resolved.append((address, preferred)) or preferred
        )

        for session_id, destination_hash, x in (
            ("land-2", "bb" * 16, 20),
            ("land-3", "cc" * 16, 40),
        ):
            discovery = []
            remote = QortalLandProximityVoiceManager(
                emit=lambda *_args: None,
                send_binary=lambda *_args: True,
                log=lambda _message: None,
                resolve_peer=lambda _address, preferred="": preferred or None,
                resolve_identity=lambda _peer: None,
                build_destination=lambda identity: identity,
                link_id_bytes=lambda _link: b"\0" * 16,
                enqueue=lambda fn, args: bool(fn(*args) is not False),
                broadcast_discovery=discovery.append,
                verify_wallet=verify_signature,
                derive_address=derive_qortal_address,
                decode_base58=_b58decode,
            )
            remote.set_context({
                "address": self.address,
                "publicKey": self.public_key,
                "groupId": "7",
                "landSessionId": session_id,
                "roomId": "club",
                "localDestinationHash": destination_hash,
                "instanceId": f"{x:08x}-4455-4677-8899-aabbccddeeff",
            })
            remote._enable({"mode": "push-to-talk"})
            remote._submit_signature({
                "signature": _b58encode(self.wallet.sign(canonical_bytes(remote.pending_fields))),
                "publicKey": self.public_key,
            })
            decoded = _decode_qortalland_proximity_discovery(
                _encode_qortalland_proximity_discovery(discovery[-1])
            )
            self.assertTrue(self.manager.on_discovery(decoded, "dd" * 16))
            self.manager.on_land_state({
                "a": self.address, "s": session_id, "g": "7", "u": "club",
                "x": x, "y": 0, "ts": int(time.time() * 1000),
            }, "dd" * 16)

        keys = [
            self.manager._peer_key(self.address, "land-2"),
            self.manager._peer_key(self.address, "land-3"),
        ]
        self.assertEqual(set(self.manager.remote_capabilities), set(keys))
        self.assertEqual(set(self.manager.remote_positions), set(keys))
        self.assertEqual({peer_key for _distance, peer_key in self.manager._eligible()}, set(keys))
        self.assertNotEqual(self.manager._source_id(keys[0]), self.manager._source_id(keys[1]))
        self.assertIn((self.address, "bb" * 16), resolved)
        self.assertIn((self.address, "cc" * 16), resolved)

    def test_link_hello_is_bound_to_both_land_sessions_and_authenticated_endpoint(self):
        self.authorize()
        self.manager._update_position({
            "landSessionId": "land-1", "sequence": 1,
            "roomId": "club", "x": 0, "y": 0,
        })
        destination_hash = "bb" * 16
        discovery = []
        remote = QortalLandProximityVoiceManager(
            emit=lambda *_args: None,
            send_binary=lambda *_args: True,
            log=lambda _message: None,
            resolve_peer=lambda _address, preferred="": preferred or None,
            resolve_identity=lambda _peer: None,
            build_destination=lambda identity: identity,
            link_id_bytes=lambda _link: b"l" * 16,
            enqueue=lambda fn, args: bool(fn(*args) is not False),
            broadcast_discovery=discovery.append,
            verify_wallet=verify_signature,
            derive_address=derive_qortal_address,
            decode_base58=_b58decode,
        )
        remote.set_context({
            "address": self.address, "publicKey": self.public_key,
            "groupId": "7", "landSessionId": "land-0", "roomId": "club",
            "localDestinationHash": destination_hash,
            "instanceId": "11112233-4455-4677-8899-aabbccddeeff",
        })
        remote._enable({"mode": "push-to-talk"})
        remote._submit_signature({
            "signature": _b58encode(self.wallet.sign(canonical_bytes(remote.pending_fields))),
            "publicKey": self.public_key,
        })
        decoded = _decode_qortalland_proximity_discovery(
            _encode_qortalland_proximity_discovery(discovery[-1])
        )
        self.manager.resolve_peer = lambda address, preferred="": (
            preferred if address == self.address and preferred == destination_hash else None
        )
        self.manager.resolve_link_peer_hash = lambda _link: destination_hash
        self.assertTrue(self.manager.on_discovery(decoded, "dd" * 16))
        self.manager.on_land_state({
            "a": self.address, "s": "land-0", "g": "7", "u": "club",
            "x": 20, "y": 0, "ts": int(time.time() * 1000),
        }, "dd" * 16)
        peer_key = self.manager._peer_key(self.address, "land-0")
        capability = self.manager.remote_capabilities[peer_key]
        link = object()
        hello = {
            "v": 1, "f": self.address, "t": self.address, "g": "7",
            "s": "land-0", "o": "land-1", "r": "club",
            "c": capability["hash"], "l": b"\0" * 16,
            "n": b"n" * 16, "ts": int(time.time() * 1000),
        }
        hello["z"] = remote.ephemeral_private.sign(umsgpack.packb(hello))
        self.assertTrue(self.manager._verify_link_hello(link, hello))

        wrong_target = {**hello, "o": "land-other", "n": b"o" * 16}
        signed_wrong_target = dict(wrong_target)
        signed_wrong_target.pop("z")
        wrong_target["z"] = remote.ephemeral_private.sign(umsgpack.packb(signed_wrong_target))
        self.assertFalse(self.manager._verify_link_hello(link, wrong_target))

        self.manager.resolve_link_peer_hash = lambda _link: "cc" * 16
        wrong_link = {**hello, "n": b"p" * 16}
        signed_wrong_link = dict(wrong_link)
        signed_wrong_link.pop("z")
        wrong_link["z"] = remote.ephemeral_private.sign(umsgpack.packb(signed_wrong_link))
        self.assertFalse(self.manager._verify_link_hello(link, wrong_link))

    def test_inbound_link_retries_accept_until_optional_auth_ack(self):
        self.authorize()
        link = object()
        address = "Q" + "p" * 33
        link_id = b"l" * 16
        nonce = b"n" * 16
        accept = {"c": "accept", "marker": "test"}
        state = {
            "peerKey": f"{address}:land-2", "address": address, "sessionId": "land-2",
            "link": link,
            "linkId": link_id,
            "nonce": nonce,
            "phase": "connected",
            "authenticated": True,
            "authAccept": accept,
            "lastAuthAccept": time.time() - 2,
            "authAcceptAttempts": 1,
            "createdAt": time.time(),
            "lastActivity": time.time(),
            "sourceId": 1,
        }
        self.manager.links[state["peerKey"]] = state
        self.manager.links_by_object[id(link)] = state["peerKey"]
        sent = []
        self.manager._send_control = lambda _state, payload: sent.append(payload)
        self.manager._reconcile = lambda: None

        self.manager.tick()
        self.assertIn(accept, sent)
        self.assertTrue(state["authenticated"])

        packet = type("Packet", (), {"link": link})()
        ack = {
            "v": 1, "ts": int(time.time() * 1000), "c": "auth_ack",
            "l": link_id, "n": nonce,
        }
        self.manager._on_packet(CONTROL_MAGIC + umsgpack.packb(ack), packet)
        self.assertTrue(state["authenticated"])
        self.assertEqual(state["phase"], "connected")
        self.assertNotIn("authAccept", state)

    def test_signed_control_preserves_messagepack_key_order(self):
        payload = {
            "v": 1, "a": self.address, "c": "accept", "f": self.address,
            "t": self.address, "h": b"h" * 32, "q": b"q" * 32,
            "l": b"l" * 16, "n": b"n" * 16, "r": b"r" * 16,
            "ts": int(time.time() * 1000), "z": b"z" * 64,
        }
        captured = []

        class Packet:
            def __init__(self, _link, raw):
                captured.append(raw)

            def send(self):
                return None

        with patch("qortalland_proximity.RNS.Packet", Packet):
            self.manager._send_control({"link": object()}, payload)

        decoded = umsgpack.unpackb(captured[0][len(CONTROL_MAGIC):])
        self.assertEqual(list(decoded.keys()), list(payload.keys()))
        signed = dict(decoded)
        signed.pop("z")
        self.assertEqual(umsgpack.packb(signed), umsgpack.packb({key: value for key, value in payload.items() if key != "z"}))


if __name__ == "__main__":
    unittest.main()
