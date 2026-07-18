import base64
import importlib.util
import json
import queue
import tempfile
import threading
import time
import unittest
from unittest import mock
from pathlib import Path

import RNS


BRIDGE_PATH = Path(__file__).with_name("presence_bridge.py")
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58_encode(data):
    leading_zeroes = len(data) - len(data.lstrip(b"\x00"))
    value = int.from_bytes(data, "big")
    encoded = ""
    while value > 0:
        value, remainder = divmod(value, 58)
        encoded = BASE58_ALPHABET[remainder] + encoded
    return ("1" * leading_zeroes) + (encoded or ("1" if not data else ""))


def load_bridge():
    spec = importlib.util.spec_from_file_location("presence_bridge_under_test", BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeLink:
    def __init__(self):
        self.closed_callback = None
        self.packet_callback = None
        self.remote_identified_callback = None
        self.resource_strategy = None
        self.resource_callback = None
        self.resource_started_callback = None
        self.resource_concluded_callback = None
        self.teardown_called = False

    def get_mdu(self):
        return 4096

    def set_link_closed_callback(self, callback):
        self.closed_callback = callback

    def set_packet_callback(self, callback):
        self.packet_callback = callback

    def set_remote_identified_callback(self, callback):
        self.remote_identified_callback = callback

    def set_resource_strategy(self, strategy):
        self.resource_strategy = strategy

    def set_resource_callback(self, callback):
        self.resource_callback = callback

    def set_resource_started_callback(self, callback):
        self.resource_started_callback = callback

    def set_resource_concluded_callback(self, callback):
        self.resource_concluded_callback = callback

    def teardown(self):
        self.teardown_called = True


class FakeSessionReceipt:
    def __init__(self):
        self.progress = 0.0
        self.metadata = None
        self.response = None

    def get_progress(self):
        return self.progress

    def get_response(self):
        return self.response


class FakeSessionLink(FakeLink):
    def __init__(self, link_id=None):
        super().__init__()
        self.link_id = link_id or bytes.fromhex("77" * 16)
        self.requests = []
        self.identified_with = None
        self.remote_identity = None
        self.outgoing_resources = []

    def identify(self, identity):
        self.identified_with = identity

    def get_remote_identity(self):
        return self.remote_identity

    def request(self, path, data=None, **callbacks):
        receipt = FakeSessionReceipt()
        self.requests.append((path, data, callbacks, receipt))
        return receipt


class FakePacket:
    def __init__(self, link):
        self.link = link


class FakeRnsPacket:
    MDU = 500
    ENCRYPTED_MDU = 500
    sent_links = []
    sent_payloads = []

    def __init__(self, link, data, create_receipt=False):
        self.link = link
        self.data = data
        self.create_receipt = create_receipt

    def send(self):
        self.__class__.sent_links.append(self.link)
        self.__class__.sent_payloads.append(self.data)
        return True


class FakeDestination:
    def __init__(self):
        self.hash = bytes.fromhex("44" * 16)


class PresenceBridgeLandStateFastPathTest(unittest.TestCase):
    def setUp(self):
        self.bridge = load_bridge()
        self.bridge._destination = FakeDestination()
        self.group_id = 73
        self.author = "Q-land-author"
        self.session_id = "land-session"
        self.source_hash = "11" * 16
        self.target_hash = "22" * 16
        self.origin = "AQIDBAUGBwgJCgsMDQ4PEA"
        self.private_key = RNS.Cryptography.Ed25519PrivateKey.generate()
        public_key = self.private_key.public_key().public_bytes()
        expires_at = int((time.time() + 60) * 1000)
        self.bridge._configure_land_state_forwarding(
            [
                {
                    "groupId": self.group_id,
                    "targets": [
                        {
                            "peerPresenceHash": self.target_hash,
                            "expiresAt": expires_at,
                        }
                    ],
                }
            ],
            [
                {
                    "groupId": self.group_id,
                    "authorAddress": self.author,
                    "sessionId": self.session_id,
                    "ephemeralPublicKey": base58_encode(public_key),
                    "expiresAt": expires_at,
                }
            ],
            7,
        )

    def state(self, sequence=1, signature=None):
        timestamp = int(time.time() * 1000)
        fields = {
            "authorAddress": self.author,
            "direction": "r",
            "groupId": self.group_id,
            "movement": "walk",
            "roomId": "room",
            "sequence": sequence,
            "sessionId": self.session_id,
            "timestamp": timestamp,
            "type": "QORTAL_LAND_STATE",
            "x": 50,
            "y": 60,
        }
        signed_bytes = json.dumps(
            fields,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        encoded_signature = signature
        if encoded_signature is None:
            encoded_signature = base58_encode(
                self.private_key.sign(signed_bytes)
            )
        return {
            "t": "RCHAT",
            "k": "land_state",
            "g": self.group_id,
            "a": self.author,
            "s": self.session_id,
            "q": sequence,
            "x": 50,
            "y": 60,
            "u": "room",
            "d": "r",
            "m": "walk",
            "ts": timestamp,
            "z": encoded_signature,
            "o": self.origin,
            "h": 1,
        }

    def queue_without_scheduler(self, message):
        with mock.patch.object(
            self.bridge,
            "_enqueue_scheduler_task",
            return_value=True,
        ):
            queued = self.bridge._queue_land_state_fast_path(
                message,
                self.source_hash,
                "source-link",
            )
        self.assertTrue(queued)
        return next(reversed(self.bridge._land_state_forward_pending))

    def test_preserves_full_origin_and_reports_the_forwarding_revision(self):
        message = self.state()
        pending_key = self.queue_without_scheduler(message)
        emitted = []
        sent = []
        with mock.patch.object(
            self.bridge,
            "_send_wire_to_established_overlay_peer",
            side_effect=lambda peer, wire, _traffic: sent.append((peer, wire)) or True,
        ), mock.patch.object(
            self.bridge,
            "_emit_call_bridge_message",
            side_effect=lambda *args, **kwargs: emitted.append((args, kwargs)) or True,
        ):
            self.bridge._process_land_state_fast_path(pending_key)

        self.assertEqual(len(sent), 1)
        forwarded = json.loads(sent[0][1].decode("utf-8"))
        self.assertEqual(forwarded["o"], self.origin)
        self.assertTrue(emitted[0][1]["land_state_fast_forwarded"])
        self.assertEqual(emitted[0][1]["land_state_forwarding_revision"], 7)

    def test_destination_hash_matching_requires_exact_hash_equivalence(self):
        full_hash = "0102030405060708090a0b0c0d0e0f10"
        same_prefix = "01020304" + ("ff" * 12)

        self.assertTrue(
            self.bridge._land_state_hash_matches(self.origin, full_hash)
        )
        self.assertFalse(
            self.bridge._land_state_hash_matches(full_hash, same_prefix)
        )

    def test_invalid_origin_is_replaced_with_the_verified_ingress_peer(self):
        message = self.state()
        message["o"] = "invalid"
        pending_key = self.queue_without_scheduler(message)
        sent = []
        with mock.patch.object(
            self.bridge,
            "_send_wire_to_established_overlay_peer",
            side_effect=lambda peer, wire, _traffic: sent.append((peer, wire)) or True,
        ), mock.patch.object(
            self.bridge,
            "_emit_call_bridge_message",
            return_value=True,
        ):
            self.bridge._process_land_state_fast_path(pending_key)

        self.assertEqual(len(sent), 1)
        forwarded = json.loads(sent[0][1].decode("utf-8"))
        self.assertEqual(forwarded["o"], self.source_hash)

    def test_route_revision_change_forces_electron_fallback(self):
        pending_key = self.queue_without_scheduler(self.state())
        emitted = []

        def send_and_change_revision(_peer, _wire, _traffic):
            self.bridge._land_state_forwarding_revision = 8
            return True

        with mock.patch.object(
            self.bridge,
            "_send_wire_to_established_overlay_peer",
            side_effect=send_and_change_revision,
        ), mock.patch.object(
            self.bridge,
            "_emit_call_bridge_message",
            side_effect=lambda *args, **kwargs: emitted.append((args, kwargs)) or True,
        ):
            self.bridge._process_land_state_fast_path(pending_key)

        self.assertFalse(emitted[0][1]["land_state_fast_forwarded"])
        self.assertIsNone(emitted[0][1]["land_state_forwarding_revision"])

    def test_unverified_higher_sequence_does_not_replace_pending_valid_state(self):
        valid_key = self.queue_without_scheduler(self.state(sequence=1))
        invalid_key = self.queue_without_scheduler(
            self.state(sequence=999, signature="invalid")
        )
        self.assertEqual(len(self.bridge._land_state_forward_pending), 2)
        emitted = []
        with mock.patch.object(
            self.bridge,
            "_send_wire_to_established_overlay_peer",
            return_value=True,
        ) as send, mock.patch.object(
            self.bridge,
            "_emit_call_bridge_message",
            side_effect=lambda *args, **kwargs: emitted.append((args, kwargs)) or True,
        ):
            self.bridge._process_land_state_fast_path(valid_key)
            self.bridge._process_land_state_fast_path(invalid_key)

        self.assertEqual(send.call_count, 1)
        self.assertEqual(len(emitted), 1)

    def test_oversized_target_plan_falls_back_instead_of_installing_part_of_it(self):
        expires_at = int((time.time() + 60) * 1000)
        targets = [
            {
                "peerPresenceHash": f"{index:032x}",
                "expiresAt": expires_at,
            }
            for index in range(
                1,
                self.bridge._LAND_STATE_FORWARDING_MAX_TARGETS_PER_GROUP + 2,
            )
        ]
        self.bridge._configure_land_state_forwarding(
            [{"groupId": self.group_id, "targets": targets}],
            [],
            8,
        )
        self.assertNotIn(
            self.group_id,
            self.bridge._land_state_forwarding_plans,
        )

    def test_sequence_zero_is_forwarded_only_once(self):
        message = self.state(sequence=0)
        emitted = []
        with mock.patch.object(
            self.bridge,
            "_send_wire_to_established_overlay_peer",
            return_value=True,
        ) as send, mock.patch.object(
            self.bridge,
            "_emit_call_bridge_message",
            side_effect=lambda *args, **kwargs: emitted.append((args, kwargs)) or True,
        ):
            self.bridge._process_land_state_fast_path(
                self.queue_without_scheduler(message)
            )
            self.bridge._process_land_state_fast_path(
                self.queue_without_scheduler(message)
            )

        self.assertEqual(send.call_count, 1)
        self.assertEqual(len(emitted), 1)


class PresenceBridgeAudioForwardFastPathTest(unittest.TestCase):
    def setUp(self):
        self.bridge = load_bridge()
        self.room_id = "gcall-qortal-716"
        self.source_hash = "11" * 16
        self.target_hash = "22" * 16

    def plan(self, ingress_link="source-link", target_link="target-link"):
        return {
            "roomId": self.room_id,
            "topologyEpoch": 7,
            "rules": [
                {
                    "sourceAddress": "Q-source",
                    "ingress": {
                        "address": "Q-source",
                        "transport": "link",
                        "linkId": ingress_link,
                        "peerPresenceHash": self.source_hash,
                        "peerDestinationHash": self.source_hash,
                    },
                    "targets": [
                        {
                            "address": "Q-target",
                            "transport": "link",
                            "linkId": target_link,
                            "peerPresenceHash": self.target_hash,
                            "peerDestinationHash": self.target_hash,
                        }
                    ],
                }
            ],
        }

    def test_exact_verified_ingress_forwards_unchanged_media(self):
        rooms, rules = self.bridge._configure_audio_forwarding_plans([self.plan()])
        self.assertEqual((rooms, rules), (1, 1))
        captured = []
        with mock.patch.object(
            self.bridge,
            "_audio_data_plane_broadcast_inbound_audio",
            return_value=True,
        ), mock.patch.object(
            self.bridge,
            "_put_audio_decoded_batch_keep_newest",
            side_effect=lambda frames: captured.extend(frames) or True,
        ):
            handled = self.bridge._try_group_audio_forward_fast_path(
                self.room_id,
                "source-link",
                self.source_hash,
                self.source_hash,
                1234,
                b"encrypted-media",
                b"inbound-batch",
            )
        self.assertTrue(handled)
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0][0], "target-link")
        self.assertEqual(captured[0][1], self.room_id)
        self.assertEqual(captured[0][5], b"encrypted-media")

    def test_link_media_does_not_fall_back_to_hash_matching(self):
        self.bridge._configure_audio_forwarding_plans([self.plan()])
        with mock.patch.object(
            self.bridge,
            "_audio_data_plane_broadcast_inbound_audio",
        ) as broadcast:
            handled = self.bridge._try_group_audio_forward_fast_path(
                self.room_id,
                "unverified-link",
                self.source_hash,
                self.source_hash,
                1234,
                b"encrypted-media",
                b"inbound-batch",
            )
        self.assertFalse(handled)
        broadcast.assert_not_called()

    def test_packet_media_matches_only_the_configured_peer_hash(self):
        plan = self.plan()
        ingress = plan["rules"][0]["ingress"]
        ingress["transport"] = "packet"
        ingress["linkId"] = ""
        self.bridge._configure_audio_forwarding_plans([plan])
        captured = []
        with mock.patch.object(
            self.bridge,
            "_audio_data_plane_broadcast_inbound_audio",
            return_value=True,
        ), mock.patch.object(
            self.bridge,
            "_put_audio_decoded_batch_keep_newest",
            side_effect=lambda frames: captured.extend(frames) or True,
        ):
            handled = self.bridge._try_group_audio_forward_fast_path(
                self.room_id,
                "",
                self.source_hash,
                "",
                1234,
                b"encrypted-media",
                b"inbound-batch",
            )
            rejected = self.bridge._try_group_audio_forward_fast_path(
                self.room_id,
                "",
                "33" * 16,
                "",
                1235,
                b"other-media",
                b"other-batch",
            )
        self.assertTrue(handled)
        self.assertFalse(rejected)
        self.assertEqual(len(captured), 1)

    def test_forward_queue_rejection_does_not_duplicate_local_delivery(self):
        self.bridge._configure_audio_forwarding_plans([self.plan()])
        with mock.patch.object(
            self.bridge,
            "_audio_data_plane_broadcast_inbound_audio",
            return_value=True,
        ), mock.patch.object(
            self.bridge,
            "_put_audio_decoded_batch_keep_newest",
            return_value=False,
        ):
            handled = self.bridge._try_group_audio_forward_fast_path(
                self.room_id,
                "source-link",
                self.source_hash,
                self.source_hash,
                1234,
                b"encrypted-media",
                b"inbound-batch",
            )
        self.assertTrue(handled)

    def test_plan_replacement_removes_stale_room_and_loop_target(self):
        loop_plan = self.plan(target_link="source-link")
        rooms, rules = self.bridge._configure_audio_forwarding_plans([loop_plan])
        self.assertEqual((rooms, rules), (1, 1))
        stored_rule = self.bridge._audio_forwarding_plans_by_room[self.room_id][
            "rules"
        ][0]
        self.assertEqual(stored_rule["targets"], [])

        rooms, rules = self.bridge._configure_audio_forwarding_plans([])
        self.assertEqual((rooms, rules), (0, 0))
        self.assertNotIn(self.room_id, self.bridge._audio_forwarding_plans_by_room)


class PresenceBridgeOverlayAudioPromotionTest(unittest.TestCase):
    def setUp(self):
        self.bridge = load_bridge()
        self.sender_peer_hash = "22" * 16
        self.original_rns_packet = RNS.Packet

    def tearDown(self):
        RNS.Packet = self.original_rns_packet

    def drain_audio_queue(self):
        while True:
            try:
                self.bridge._audio_binary_out_queue.get_nowait()
            except queue.Empty:
                return

    def group_audio_wire(self):
        room = b"gcall-qortal-1"
        sender_hash = bytes.fromhex(self.sender_peer_hash)
        payload = b"opus"
        return (
            self.bridge._GROUP_AUDIO_BINARY_MAGIC
            + bytes(
                (
                    self.bridge._GROUP_AUDIO_BINARY_VERSION,
                    len(room),
                    len(sender_hash),
                )
            )
            + len(payload).to_bytes(2, "big")
            + room
            + sender_hash
            + payload
        )

    def group_audio_heartbeat_wire(self):
        return self.bridge.json.dumps(
            {
                "t": self.bridge._GROUP_AUDIO_HEARTBEAT_WIRE_TYPE,
                "R": "gcall-qortal-1",
                "c": "PING",
                "m": int(time.time() * 1000),
                "r": self.sender_peer_hash,
            }
        ).encode("utf-8")

    def group_audio_heartbeat_wire_without_sender(self):
        return self.bridge.json.dumps(
            {
                "t": self.bridge._GROUP_AUDIO_HEARTBEAT_WIRE_TYPE,
                "R": "gcall-qortal-1",
                "c": "PING",
                "m": int(time.time() * 1000),
            }
        ).encode("utf-8")

    def qchat_file_auth_wire(self, transfer_id="transfer-1", peer_hash=None):
        return self.bridge.json.dumps(
            {
                "type": "QCHAT_FILE_LINK_AUTH",
                "transferId": transfer_id,
                "senderAddress": "Q-sender",
                "downloaderAddress": "Q-downloader",
                "downloaderPublicKey": "pub-downloader",
                "downloaderReticulumDestinationHash": peer_hash
                or self.sender_peer_hash,
                "downloaderReticulumIdentityPublicKeyBase64": "identity",
                "timestamp": int(time.time() * 1000),
                "signature": "sig",
            }
        ).encode("utf-8")

    def install_overlay_state(self, incoming=True):
        link = FakeLink()
        link_id = "overlay-test-link"
        peer_hash = "11" * 16
        now = time.time()
        self.bridge._overlay_links_by_id[link_id] = {
            "link": link,
            "peerPresenceHash": peer_hash,
            "incoming": incoming,
            "established": True,
            "established_at": now,
            "created_at": now,
            "pending_packets": self.bridge.deque(maxlen=4),
            "last_activity_at": now,
            "last_rx_at": None,
        }
        self.bridge._overlay_link_ids_by_object[id(link)] = link_id
        self.bridge._active_overlay_link_id_by_peer_hash[peer_hash] = link_id
        if incoming:
            self.bridge._inbound_overlay_neighbors[peer_hash] = now
        else:
            self.bridge._active_overlay_neighbors[peer_hash] = now
        return link, link_id, peer_hash

    def install_audio_state(
        self,
        link_id,
        peer_hash=None,
        established=True,
        link=None,
        last_activity_at=None,
    ):
        peer_hash = peer_hash or self.sender_peer_hash
        link = link or FakeLink()
        now = time.time()
        self.bridge._audio_links_by_id[link_id] = {
            "link": link,
            "peerPresenceHash": peer_hash,
            "peerDestinationHash": peer_hash,
            "incoming": False,
            "established": established,
            "established_at": now if established else None,
            "created_at": now - 10,
            "last_activity_at": last_activity_at if last_activity_at is not None else now,
            "last_rx_at": None,
            "last_send_ok_at": None,
            "send_lock": self.bridge.threading.RLock(),
            "generation": 0,
            "closing": False,
        }
        self.bridge._audio_link_ids_by_object[id(link)] = link_id
        return link

    def drain_json_events(self):
        events = []
        while True:
            try:
                events.append(self.bridge._json_event_queue.get_nowait())
            except queue.Empty:
                return events

    def drain_json_responses(self):
        responses = []
        while True:
            try:
                responses.append(self.bridge._json_resp_queue.get_nowait())
            except queue.Empty:
                return responses

    def install_fake_rns_packet(self):
        FakeRnsPacket.sent_links = []
        FakeRnsPacket.sent_payloads = []
        RNS.Packet = FakeRnsPacket
        self.bridge.RNS.Packet = FakeRnsPacket
        self.bridge._destination = FakeDestination()

    def test_incoming_overlay_group_audio_promotes_link_without_teardown(self):
        self.drain_audio_queue()
        link, overlay_link_id, overlay_peer_hash = self.install_overlay_state(
            incoming=True
        )
        packet = FakePacket(link)
        self.bridge._known_peers[self.sender_peer_hash] = object()
        self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash] = {
            "desired": True,
        }

        self.bridge.on_overlay_link_packet(self.group_audio_wire(), packet)

        self.assertNotIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertNotIn(id(link), self.bridge._overlay_link_ids_by_object)
        self.assertNotIn(
            overlay_peer_hash,
            self.bridge._active_overlay_link_id_by_peer_hash,
        )
        self.assertNotIn(overlay_peer_hash, self.bridge._inbound_overlay_neighbors)
        self.assertFalse(link.teardown_called)

        audio_link_id = self.bridge.get_audio_link_id(link)
        self.assertIsInstance(audio_link_id, str)
        audio_state = self.bridge.get_audio_link_state(audio_link_id)
        self.assertIsNotNone(audio_state)
        self.assertTrue(audio_state["incoming"])
        self.assertEqual(audio_state["peerPresenceHash"], self.sender_peer_hash)
        self.assertEqual(audio_state["peerDestinationHash"], self.sender_peer_hash)
        self.assertEqual(audio_state["promoted_from_overlay_link_id"], overlay_link_id)
        self.assertIs(link.packet_callback, self.bridge.on_audio_link_packet)
        self.assertGreater(self.bridge._audio_binary_out_queue.qsize(), 0)

    def test_incoming_overlay_group_audio_without_desired_audio_is_not_promoted(self):
        self.drain_audio_queue()
        link, overlay_link_id, _peer_hash = self.install_overlay_state(incoming=True)
        packet = FakePacket(link)
        self.bridge._known_peers[self.sender_peer_hash] = object()

        self.bridge.on_overlay_link_packet(self.group_audio_wire(), packet)

        self.assertIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertIsNone(self.bridge.get_audio_link_id(link))
        self.assertFalse(link.teardown_called)
        self.assertEqual(self.bridge._audio_binary_out_queue.qsize(), 0)

    def test_incoming_overlay_gac_promotes_link_when_audio_is_desired(self):
        self.drain_audio_queue()
        link, overlay_link_id, _overlay_peer_hash = self.install_overlay_state(
            incoming=True
        )
        packet = FakePacket(link)
        self.bridge._known_peers[self.sender_peer_hash] = object()
        self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash] = {
            "desired": True,
        }

        self.bridge.on_overlay_link_packet(self.group_audio_heartbeat_wire(), packet)

        self.assertNotIn(overlay_link_id, self.bridge._overlay_links_by_id)
        audio_link_id = self.bridge.get_audio_link_id(link)
        self.assertIsInstance(audio_link_id, str)
        audio_state = self.bridge.get_audio_link_state(audio_link_id)
        self.assertIsNotNone(audio_state)
        self.assertTrue(audio_state["incoming"])
        self.assertEqual(audio_state["peerPresenceHash"], self.sender_peer_hash)
        self.assertEqual(audio_state["peerDestinationHash"], self.sender_peer_hash)
        self.assertIs(link.packet_callback, self.bridge.on_audio_link_packet)

    def test_incoming_overlay_gac_without_desired_audio_is_not_promoted(self):
        self.drain_audio_queue()
        link, overlay_link_id, _peer_hash = self.install_overlay_state(incoming=True)
        packet = FakePacket(link)
        self.bridge._known_peers[self.sender_peer_hash] = object()

        self.bridge.on_overlay_link_packet(self.group_audio_heartbeat_wire(), packet)

        self.assertIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertIsNone(self.bridge.get_audio_link_id(link))
        self.assertFalse(link.teardown_called)

    def test_incoming_overlay_gac_without_sender_is_not_promoted(self):
        self.drain_audio_queue()
        link, overlay_link_id, _peer_hash = self.install_overlay_state(incoming=True)
        packet = FakePacket(link)
        self.bridge._known_peers[self.sender_peer_hash] = object()
        self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash] = {
            "desired": True,
        }

        self.bridge.on_overlay_link_packet(
            self.group_audio_heartbeat_wire_without_sender(),
            packet,
        )

        self.assertIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertIsNone(self.bridge.get_audio_link_id(link))
        self.assertFalse(link.teardown_called)

    def test_stale_audio_mapping_does_not_allow_overlay_promotion(self):
        self.drain_audio_queue()
        link, overlay_link_id, _peer_hash = self.install_overlay_state(incoming=True)
        packet = FakePacket(link)
        self.bridge._known_peers[self.sender_peer_hash] = object()
        self.bridge._active_audio_link_id_by_peer_hash[self.sender_peer_hash] = "stale-link"

        self.bridge.on_overlay_link_packet(self.group_audio_wire(), packet)

        self.assertIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertIsNone(self.bridge.get_audio_link_id(link))
        self.assertFalse(link.teardown_called)
        self.assertEqual(self.bridge._audio_binary_out_queue.qsize(), 0)

    def test_audio_send_with_stale_link_id_uses_established_peer_link(self):
        self.install_fake_rns_packet()
        current_link = self.install_audio_state("current-audio-link")
        self.bridge._active_audio_link_id_by_peer_hash[self.sender_peer_hash] = "stale-audio-link"
        self.bridge._outgoing_audio_link_id_by_peer_hash[self.sender_peer_hash] = "stale-audio-link"

        self.bridge._process_audio_batch(
            [
                (
                    "stale-audio-link",
                    "gcall-qortal-1",
                    self.sender_peer_hash,
                    "",
                    int(time.time() * 1000),
                    b"opus",
                )
            ]
        )

        self.assertEqual(FakeRnsPacket.sent_links, [current_link])
        self.assertEqual(
            self.bridge._active_audio_link_id_by_peer_hash[self.sender_peer_hash],
            "current-audio-link",
        )
        failures = [
            frame
            for frame in self.drain_json_events()
            if frame.get("event") == "group_audio_send_failed"
        ]
        self.assertEqual(failures, [])

    def test_audio_heartbeat_with_stale_link_id_uses_established_peer_link(self):
        self.install_fake_rns_packet()
        current_link = self.install_audio_state("current-audio-link")
        self.bridge._active_audio_link_id_by_peer_hash[self.sender_peer_hash] = "stale-audio-link"
        self.bridge._outgoing_audio_link_id_by_peer_hash[self.sender_peer_hash] = "stale-audio-link"

        self.bridge.handle_send_group_audio_link_heartbeat(
            "req-1",
            {
                "linkId": "stale-audio-link",
                "peerPresenceHash": self.sender_peer_hash,
                "roomId": "gcall-qortal-1",
                "command": "PING",
            },
        )

        self.assertEqual(FakeRnsPacket.sent_links, [current_link])
        responses = self.drain_json_responses()
        self.assertEqual(len(responses), 1)
        self.assertTrue(responses[0].get("ok"))
        self.assertEqual(
            responses[0].get("payload", {}).get("linkId"),
            "current-audio-link",
        )

    def test_audio_open_stops_after_max_establish_attempts(self):
        self.bridge._destination = FakeDestination()
        self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash] = {
            "desired": True,
            "attempts": self.bridge._AUDIO_LINK_MAX_ESTABLISH_ATTEMPTS,
            "retry_delay": self.bridge._AUDIO_LINK_RETRY_MIN_SECONDS,
            "retry_timer": None,
            "last_failure_reason": "establish_timeout",
        }

        ok, payload, error = self.bridge._open_group_audio_link_for_peer(
            self.sender_peer_hash,
            retry_reason="establish_timeout",
        )

        self.assertFalse(ok)
        self.assertEqual(payload.get("code"), "max_establish_attempts")
        self.assertEqual(error, "Max group audio link establish attempts reached")
        events = [
            frame
            for frame in self.drain_json_events()
            if frame.get("event") == "group_audio_send_failed"
        ]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].get("payload", {}).get("reason"), "max_establish_attempts")
        self.assertEqual(events[0].get("payload", {}).get("code"), "max_establish_attempts")

    def test_audio_retry_not_scheduled_after_max_establish_attempts(self):
        self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash] = {
            "desired": True,
            "attempts": self.bridge._AUDIO_LINK_MAX_ESTABLISH_ATTEMPTS,
            "retry_delay": self.bridge._AUDIO_LINK_RETRY_MIN_SECONDS,
            "retry_timer": None,
            "last_failure_reason": "establish_timeout",
        }

        self.bridge._schedule_audio_link_retry(self.sender_peer_hash, "establish_timeout")
        self.bridge._schedule_audio_link_retry(self.sender_peer_hash, "establish_timeout")

        desired = self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash]
        self.assertIsNone(desired.get("retry_timer"))
        self.assertEqual(desired.get("last_failure_reason"), "max_establish_attempts")
        events = [
            frame
            for frame in self.drain_json_events()
            if frame.get("event") == "group_audio_send_failed"
        ]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].get("payload", {}).get("reason"), "max_establish_attempts")
        self.assertEqual(events[0].get("payload", {}).get("code"), "max_establish_attempts")

    def test_audio_retry_timer_callback_does_not_enqueue_after_max_attempts(self):
        enqueued = []
        original_enqueue = self.bridge._enqueue_scheduler_task
        original_timer = self.bridge.threading.Timer

        class FakeTimer:
            def __init__(self, delay, function):
                self.delay = delay
                self.function = function
                self.daemon = False
                self.started = False

            def start(self):
                self.started = True

            def cancel(self):
                self.started = False

        try:
            self.bridge._enqueue_scheduler_task = lambda *args, **kwargs: enqueued.append(
                (args, kwargs)
            )
            self.bridge.threading.Timer = FakeTimer
            self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash] = {
                "desired": True,
                "attempts": self.bridge._AUDIO_LINK_MAX_ESTABLISH_ATTEMPTS - 1,
                "retry_delay": self.bridge._AUDIO_LINK_RETRY_MIN_SECONDS,
                "retry_timer": None,
                "last_failure_reason": "establish_timeout",
            }

            self.bridge._schedule_audio_link_retry(
                self.sender_peer_hash,
                "establish_timeout",
                immediate=True,
            )
            desired = self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash]
            timer = desired.get("retry_timer")
            self.assertIsNotNone(timer)
            desired["attempts"] = self.bridge._AUDIO_LINK_MAX_ESTABLISH_ATTEMPTS

            timer.function()

            self.assertEqual(enqueued, [])
            events = [
                frame
                for frame in self.drain_json_events()
                if frame.get("event") == "group_audio_send_failed"
            ]
            self.assertEqual(len(events), 1)
            self.assertEqual(
                events[0].get("payload", {}).get("code"),
                "max_establish_attempts",
            )
        finally:
            self.bridge._enqueue_scheduler_task = original_enqueue
            self.bridge.threading.Timer = original_timer

    def test_audio_established_resets_establish_attempts(self):
        link = self.install_audio_state("current-audio-link", established=False)
        self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash] = {
            "desired": True,
            "attempts": self.bridge._AUDIO_LINK_MAX_ESTABLISH_ATTEMPTS,
            "retry_delay": self.bridge._AUDIO_LINK_RETRY_MAX_SECONDS,
            "retry_timer": None,
            "last_failure_reason": "establish_timeout",
            "max_attempts_emitted": True,
        }

        self.bridge.on_outgoing_audio_link_established(link)

        desired = self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash]
        self.assertEqual(desired.get("attempts"), 0)
        self.assertEqual(desired.get("retry_delay"), self.bridge._AUDIO_LINK_RETRY_MIN_SECONDS)
        self.assertEqual(desired.get("last_failure_reason"), "")
        self.assertFalse(desired.get("max_attempts_emitted"))

    def test_outbound_overlay_group_audio_is_not_promoted(self):
        self.drain_audio_queue()
        link, overlay_link_id, _peer_hash = self.install_overlay_state(incoming=False)
        packet = FakePacket(link)
        self.bridge._known_peers[self.sender_peer_hash] = object()
        self.bridge._audio_link_desired_by_peer_hash[self.sender_peer_hash] = {
            "desired": True,
        }

        self.bridge.on_overlay_link_packet(self.group_audio_wire(), packet)

        self.assertIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertIsNone(self.bridge.get_audio_link_id(link))
        self.assertFalse(link.teardown_called)
        self.assertEqual(self.bridge._audio_binary_out_queue.qsize(), 0)

    def test_incoming_overlay_qchat_auth_promotes_when_transfer_is_pending(self):
        link, overlay_link_id, overlay_peer_hash = self.install_overlay_state(
            incoming=True
        )
        packet = FakePacket(link)
        self.bridge._qchat_file_pending_sends_by_transfer["transfer-1"] = {
            "expires_at": time.time() + 60,
        }

        self.bridge.on_overlay_link_packet(self.qchat_file_auth_wire(), packet)

        self.assertNotIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertNotIn(id(link), self.bridge._overlay_link_ids_by_object)
        self.assertNotIn(
            overlay_peer_hash,
            self.bridge._active_overlay_link_id_by_peer_hash,
        )
        self.assertNotIn(overlay_peer_hash, self.bridge._inbound_overlay_neighbors)
        self.assertFalse(link.teardown_called)

        file_link_id = self.bridge.get_qchat_file_link_id(link)
        self.assertIsInstance(file_link_id, str)
        file_state = self.bridge.get_qchat_file_link_state(file_link_id)
        self.assertIsNotNone(file_state)
        self.assertTrue(file_state["incoming"])
        self.assertEqual(file_state["peerPresenceHash"], self.sender_peer_hash)
        self.assertEqual(file_state["transferId"], "transfer-1")
        self.assertIs(link.packet_callback, self.bridge.on_qchat_file_link_packet)

    def test_incoming_overlay_qchat_auth_without_pending_transfer_is_not_promoted(self):
        link, overlay_link_id, _peer_hash = self.install_overlay_state(incoming=True)
        packet = FakePacket(link)

        self.bridge.on_overlay_link_packet(self.qchat_file_auth_wire(), packet)

        self.assertIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertIsNone(self.bridge.get_qchat_file_link_id(link))
        self.assertFalse(link.teardown_called)

    def test_incoming_overlay_qchat_auth_with_expired_transfer_is_not_promoted(self):
        link, overlay_link_id, _peer_hash = self.install_overlay_state(incoming=True)
        packet = FakePacket(link)
        self.bridge._qchat_file_pending_sends_by_transfer["transfer-1"] = {
            "expires_at": time.time() - 1,
        }

        self.bridge.on_overlay_link_packet(self.qchat_file_auth_wire(), packet)

        self.assertIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertIsNone(self.bridge.get_qchat_file_link_id(link))
        self.assertFalse(link.teardown_called)

    def test_incoming_overlay_qchat_auth_with_invalid_peer_hash_is_not_promoted(self):
        link, overlay_link_id, _peer_hash = self.install_overlay_state(incoming=True)
        packet = FakePacket(link)
        self.bridge._qchat_file_pending_sends_by_transfer["transfer-1"] = {
            "expires_at": time.time() + 60,
        }

        self.bridge.on_overlay_link_packet(
            self.qchat_file_auth_wire(peer_hash="not-a-hash"),
            packet,
        )

        self.assertIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertIsNone(self.bridge.get_qchat_file_link_id(link))
        self.assertFalse(link.teardown_called)

    def test_outbound_overlay_qchat_auth_is_not_promoted(self):
        link, overlay_link_id, _peer_hash = self.install_overlay_state(incoming=False)
        packet = FakePacket(link)
        self.bridge._qchat_file_pending_sends_by_transfer["transfer-1"] = {
            "expires_at": time.time() + 60,
        }

        self.bridge.on_overlay_link_packet(self.qchat_file_auth_wire(), packet)

        self.assertIn(overlay_link_id, self.bridge._overlay_links_by_id)
        self.assertIsNone(self.bridge.get_qchat_file_link_id(link))
        self.assertFalse(link.teardown_called)


class PresenceBridgeResourceSchedulingTest(unittest.TestCase):
    def setUp(self):
        self.bridge = load_bridge()
        self.peer_hash = "ab" * 16

    def test_resource_commands_use_fast_control_lane(self):
        actions = (
            "accept_reticulum_chat_resource",
            "send_reticulum_chat_resource",
            "authorize_reticulum_chat_resource",
            "reject_reticulum_chat_resource",
            "cancel_reticulum_resource",
        )
        for action in actions:
            with self.subTest(action=action):
                self.assertEqual(
                    self.bridge._scheduler_lane_for_command(action),
                    "resource-control",
                )

    def test_resource_open_shard_is_stable_for_a_peer(self):
        lane = self.bridge._resource_open_scheduler_lane(self.peer_hash)
        self.assertEqual(
            lane,
            self.bridge._resource_open_scheduler_lane(self.peer_hash.upper()),
        )
        self.assertIn(lane, self.bridge._SCHEDULER_QUEUE_MAX_BY_LANE)
        self.assertTrue(lane.startswith("resource-open-"))

    def test_only_one_link_handshake_starts_per_peer(self):
        first = {"peerPresenceHash": self.peer_hash, "transferId": "first"}
        second = {"peerPresenceHash": self.peer_hash, "transferId": "second"}
        scheduled = []
        started = []
        with mock.patch.object(
            self.bridge,
            "_enqueue_scheduler_task",
            side_effect=lambda lane, name, fn, *args, **kwargs: scheduled.append(
                (lane, name, fn, args, kwargs)
            )
            or True,
        ), mock.patch.object(
            self.bridge,
            "_run_qchat_file_open_task",
            side_effect=lambda state: started.append(state),
        ):
            self.assertTrue(self.bridge._queue_qchat_file_open_state(first))
            self.assertTrue(self.bridge._queue_qchat_file_open_state(second))
            self.assertEqual(len(scheduled), 1)

            self.bridge._run_qchat_file_peer_open_queue(self.peer_hash)
            self.assertEqual(started, [first])

            self.bridge._run_qchat_file_peer_open_queue(self.peer_hash)
            self.assertEqual(started, [first])

            self.bridge._release_qchat_file_open_slot(first)
            self.bridge._run_qchat_file_peer_open_queue(self.peer_hash)
            self.assertEqual(started, [first, second])

    def test_chat_opens_are_queued_before_bulk_resources(self):
        bulk = {
            "peerPresenceHash": self.peer_hash,
            "transferId": "bulk",
            "resourceType": "reticulum_group_resource",
        }
        chat = {
            "peerPresenceHash": self.peer_hash,
            "transferId": "chat",
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
        }
        with mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ):
            self.assertTrue(self.bridge._queue_qchat_file_open_state(bulk))
            self.assertTrue(self.bridge._queue_qchat_file_open_state(chat))

        queued = list(self.bridge._qchat_file_open_queue_by_peer[self.peer_hash])
        self.assertEqual([item["transferId"] for item in queued], ["chat", "bulk"])

    def test_active_resource_links_are_bounded_per_peer(self):
        waiting = {
            "peerPresenceHash": self.peer_hash,
            "transferId": "waiting",
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
        }
        started = []
        with mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ):
            self.assertTrue(self.bridge._queue_qchat_file_open_state(waiting))
        for index in range(self.bridge._QCHAT_FILE_ACTIVE_OUTGOING_MAX_PER_PEER):
            self.bridge._qchat_file_links_by_id[f"active-{index}"] = {
                "peerPresenceHash": self.peer_hash,
                "incoming": False,
                "transferId": f"active-{index}",
            }
        with mock.patch.object(
            self.bridge,
            "_run_qchat_file_open_task",
            side_effect=lambda state: started.append(state),
        ):
            self.bridge._run_qchat_file_peer_open_queue(self.peer_hash)
            self.assertEqual(started, [])
            self.bridge._qchat_file_links_by_id.pop("active-0")
            self.bridge._run_qchat_file_peer_open_queue(self.peer_hash)
            self.assertEqual(started, [waiting])

    def test_chat_can_use_reserved_slot_while_bulk_is_at_its_limit(self):
        bulk_waiting = {
            "peerPresenceHash": self.peer_hash,
            "transferId": "bulk-waiting",
            "resourceType": "reticulum_group_resource",
        }
        chat_waiting = {
            "peerPresenceHash": self.peer_hash,
            "transferId": "chat-waiting",
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
        }
        with mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ):
            self.assertTrue(self.bridge._queue_qchat_file_open_state(bulk_waiting))
            self.assertTrue(self.bridge._queue_qchat_file_open_state(chat_waiting))
        for index in range(self.bridge._QCHAT_FILE_BULK_ACTIVE_MAX_PER_PEER):
            self.bridge._qchat_file_links_by_id[f"bulk-active-{index}"] = {
                "peerPresenceHash": self.peer_hash,
                "incoming": False,
                "transferId": f"bulk-active-{index}",
                "resourceType": "reticulum_group_resource",
            }
        started = []
        with mock.patch.object(
            self.bridge,
            "_run_qchat_file_open_task",
            side_effect=lambda state: started.append(state),
        ):
            self.bridge._run_qchat_file_peer_open_queue(self.peer_hash)

        self.assertEqual(started, [chat_waiting])
        self.assertIn(
            bulk_waiting,
            self.bridge._qchat_file_open_queue_by_peer[self.peer_hash],
        )

    def test_successful_link_removal_wakes_waiting_peer_queue(self):
        waiting = {"peerPresenceHash": self.peer_hash, "transferId": "waiting"}
        with mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ):
            self.assertTrue(self.bridge._queue_qchat_file_open_state(waiting))
        link = FakeLink()
        active = {
            "peerPresenceHash": self.peer_hash,
            "transferId": "completed",
            "incoming": False,
            "link": link,
        }
        self.bridge._qchat_file_links_by_id["completed-link"] = active
        self.bridge._qchat_file_link_ids_by_object[id(link)] = "completed-link"

        with mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ) as schedule, mock.patch.object(
            self.bridge,
            "_teardown_reticulum_link_bounded",
        ):
            self.bridge._qchat_file_receiver_transfer_done(
                self.peer_hash,
                "completed",
            )

        schedule.assert_any_call(self.peer_hash)
        self.assertIn(
            waiting,
            self.bridge._qchat_file_open_queue_by_peer[self.peer_hash],
        )

    def test_final_unestablished_link_failure_cleans_pending_transfer(self):
        transfer_id = "max-attempts"
        link = FakeLink()
        pending = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
        }
        state = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
            "incoming": False,
            "established": False,
            "open_attempts": self.bridge._QCHAT_FILE_LINK_MAX_OPEN_ATTEMPTS,
            "authMessage": {"type": "test"},
            "receive_root": pending,
            "link": link,
        }
        self.bridge._qchat_file_store_pending_receive(self.peer_hash, pending)
        self.bridge._qchat_file_links_by_id["max-link"] = state
        self.bridge._qchat_file_link_ids_by_object[id(link)] = "max-link"

        with mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ), mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
            self.bridge.on_qchat_file_link_closed(link)

        failed = [
            call
            for call in emit.call_args_list
            if call.args and call.args[0] == "failed"
        ]
        self.assertEqual(len(failed), 1)
        self.assertEqual(
            failed[0].args[1]["reason"],
            "file_link_open_attempts_exhausted",
        )
        self.assertNotIn(
            transfer_id,
            self.bridge._qchat_file_accepts_by_transfer,
        )
        self.assertTrue(pending.get("cancelled"))

    def test_exhausted_parallel_link_keeps_viable_sibling_transfer(self):
        transfer_id = "parallel-transfer"
        failed_link = FakeLink()
        pending = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
        }
        failed_state = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
            "incoming": False,
            "established": False,
            "open_attempts": self.bridge._QCHAT_FILE_LINK_MAX_OPEN_ATTEMPTS,
            "authMessage": {"type": "test"},
            "receive_root": pending,
            "link": failed_link,
        }
        sibling = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
            "incoming": False,
            "established": True,
            "receive_root": pending,
        }
        self.bridge._qchat_file_store_pending_receive(self.peer_hash, pending)
        self.bridge._qchat_file_links_by_id["failed-link"] = failed_state
        self.bridge._qchat_file_link_ids_by_object[id(failed_link)] = "failed-link"
        self.bridge._qchat_file_links_by_id["sibling-link"] = sibling

        with mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ), mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
            self.bridge.on_qchat_file_link_closed(failed_link)

        self.assertFalse(
            any(call.args and call.args[0] == "failed" for call in emit.call_args_list)
        )
        self.assertIn(
            transfer_id,
            self.bridge._qchat_file_accepts_by_transfer,
        )
        self.assertFalse(pending.get("cancelled", False))

    def test_path_timeout_cleans_pending_transfer(self):
        transfer_id = "path-timeout"
        pending = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
        }
        state = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
            "incoming": False,
            "receive_root": pending,
        }
        self.bridge._qchat_file_store_pending_receive(self.peer_hash, pending)

        with mock.patch.object(
            self.bridge,
            "_open_qchat_file_link_for_state",
            side_effect=TimeoutError("no path"),
        ), mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ), mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
            self.bridge._run_qchat_file_open_task(state)

        emit.assert_any_call(
            "failed",
            mock.ANY,
        )
        self.assertNotIn(
            transfer_id,
            self.bridge._qchat_file_accepts_by_transfer,
        )
        self.assertTrue(pending.get("cancelled"))

    def test_path_timeout_keeps_viable_parallel_sibling(self):
        transfer_id = "parallel-path-timeout"
        pending = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
        }
        timed_out_state = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
            "incoming": False,
            "receive_root": pending,
        }
        sibling = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
            "incoming": False,
            "established": True,
            "receive_root": pending,
        }
        self.bridge._qchat_file_store_pending_receive(self.peer_hash, pending)
        self.bridge._qchat_file_links_by_id["path-sibling"] = sibling

        with mock.patch.object(
            self.bridge,
            "_open_qchat_file_link_for_state",
            side_effect=TimeoutError("no path"),
        ), mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ), mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
            self.bridge._run_qchat_file_open_task(timed_out_state)

        self.assertFalse(
            any(call.args and call.args[0] == "failed" for call in emit.call_args_list)
        )
        self.assertIn(
            transfer_id,
            self.bridge._qchat_file_accepts_by_transfer,
        )
        self.assertFalse(pending.get("cancelled", False))

    def test_path_timeout_fails_once_when_only_queued_siblings_remain(self):
        transfer_id = "queued-path-timeout"
        pending = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
        }
        timed_out_state = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
            "incoming": False,
            "receive_root": pending,
        }
        queued_sibling = {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
            "incoming": False,
            "receive_root": pending,
        }
        self.bridge._qchat_file_store_pending_receive(self.peer_hash, pending)
        with mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ):
            self.assertTrue(
                self.bridge._queue_qchat_file_open_state(queued_sibling)
            )

        with mock.patch.object(
            self.bridge,
            "_open_qchat_file_link_for_state",
            side_effect=TimeoutError("no path"),
        ), mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ), mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
            self.bridge._run_qchat_file_open_task(timed_out_state)

        failed = [
            call
            for call in emit.call_args_list
            if call.args and call.args[0] == "failed"
        ]
        self.assertEqual(len(failed), 1)
        self.assertNotIn(
            transfer_id,
            self.bridge._qchat_file_accepts_by_transfer,
        )
        self.assertTrue(pending.get("cancelled"))

    def test_terminal_cleanup_does_not_cancel_another_peer_transfer(self):
        current = {
            "peerPresenceHash": self.peer_hash,
            "transferId": "current-transfer",
        }
        stale_state = {
            "peerPresenceHash": self.peer_hash,
            "transferId": "stale-transfer",
            "incoming": False,
        }
        self.bridge._qchat_file_store_pending_receive(self.peer_hash, current)

        with mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ), mock.patch.object(self.bridge, "_qchat_file_emit"):
            self.bridge._qchat_file_fail_open_state(
                stale_state,
                "link_open_failed",
                force_transfer_failure=True,
            )

        self.assertIn(
            "current-transfer",
            self.bridge._qchat_file_accepts_by_transfer,
        )
        self.assertFalse(current.get("cancelled", False))

    def test_cancelled_transfer_is_removed_from_open_queue(self):
        receive_root = {"cancelled": False}
        waiting = {
            "peerPresenceHash": self.peer_hash,
            "transferId": "cancelled",
            "receive_root": receive_root,
        }
        with mock.patch.object(
            self.bridge,
            "_schedule_qchat_file_peer_open_drain",
            return_value=True,
        ):
            self.assertTrue(self.bridge._queue_qchat_file_open_state(waiting))
        receive_root["cancelled"] = True

        with mock.patch.object(
            self.bridge,
            "_run_qchat_file_open_task",
        ) as open_task:
            self.bridge._run_qchat_file_peer_open_queue(self.peer_hash)

        open_task.assert_not_called()
        self.assertNotIn(
            self.peer_hash,
            self.bridge._qchat_file_open_queue_by_peer,
        )
        self.assertNotIn(id(waiting), self.bridge._qchat_file_open_queue_state_ids)

    def test_waiting_for_path_does_not_consume_link_attempt(self):
        state = {
            "peerPresenceHash": self.peer_hash,
            "peerIdentity": object(),
            "transferId": "waiting-for-path",
        }
        outbound = FakeDestination()
        outbound.hash = bytes.fromhex(self.peer_hash)
        with mock.patch.object(
            self.bridge,
            "build_outbound_destination",
            return_value=outbound,
        ), mock.patch.object(
            self.bridge,
            "_request_qchat_file_path",
            return_value=False,
        ):
            with self.assertRaises(self.bridge._QChatFilePathPending):
                self.bridge._open_qchat_file_link_for_state(state)

        self.assertEqual(int(state.get("open_attempts") or 0), 0)
        self.assertGreater(float(state.get("path_wait_started_at") or 0), 0)

    def test_failed_cached_path_is_refreshed_only_once_while_polling(self):
        state = {
            "peerPresenceHash": self.peer_hash,
            "peerIdentity": object(),
            "transferId": "refresh-once",
        }
        outbound = FakeDestination()
        outbound.hash = bytes.fromhex(self.peer_hash)
        refresh_permissions = []

        def request_path(_destination_hash, _peer_hash, **kwargs):
            refresh_permissions.append(kwargs.get("allow_failed_path_refresh"))
            return False

        with mock.patch.object(
            self.bridge,
            "build_outbound_destination",
            return_value=outbound,
        ), mock.patch.object(
            self.bridge,
            "_peer_has_recent_unestablished_link_failure",
            return_value=True,
        ), mock.patch.object(
            self.bridge,
            "_request_qchat_file_path",
            side_effect=request_path,
        ):
            for _ in range(2):
                with self.assertRaises(self.bridge._QChatFilePathPending):
                    self.bridge._open_qchat_file_link_for_state(state)

        self.assertEqual(refresh_permissions, [True, False])
        self.assertTrue(state.get("failed_path_refresh_requested"))
        self.assertEqual(int(state.get("open_attempts") or 0), 0)


class PresenceBridgeReusableResourceSessionTest(unittest.TestCase):
    def setUp(self):
        self.bridge = load_bridge()
        self.peer_hash = "ab" * 16

    def pending(
        self,
        transfer_id,
        *,
        resource_type=None,
        event_id="",
        sha256="",
        timestamp=None,
    ):
        resource_type = resource_type or self.bridge._RETICULUM_CHAT_RESOURCE_TYPE
        auth = {
            "type": "RCR",
            "transferId": transfer_id,
            "ts": timestamp if timestamp is not None else int(time.time() * 1000),
        }
        if event_id:
            auth["eventId"] = event_id
        return {
            "peerPresenceHash": self.peer_hash,
            "transferId": transfer_id,
            "savePath": f"/tmp/{transfer_id}.recv",
            "fileName": f"{transfer_id}.bin",
            "size": 128,
            "sha256": sha256,
            "resourceType": resource_type,
            "metadata": {
                "groupId": 716,
                **({"eventId": event_id} if event_id else {}),
            },
            "peerIdentity": object(),
            "authMessage": auth,
        }

    def session(self, lane="fast", established=True):
        session_id = f"session-{lane}"
        link = FakeSessionLink()
        state = {
            "linkId": session_id,
            "manager_kind": "resource_session",
            "sessionKey": self.bridge._resource_session_key(self.peer_hash, lane),
            "sessionLane": lane,
            "peerPresenceHash": self.peer_hash,
            "incoming": False,
            "established": established,
            "remote_ready": established,
            "provider_ready_sent": established,
            "created_at": time.time(),
            "last_used_at": time.time(),
            "pending_jobs": [],
            "active_requests": {},
            "provider_active": 0,
            "link": link,
            "generation": 1,
            "activity_generation": 1,
        }
        self.bridge._qchat_file_links_by_id[session_id] = state
        self.bridge._qchat_file_link_ids_by_object[id(link)] = session_id
        self.bridge._resource_sessions_by_key[state["sessionKey"]] = session_id
        return state, link

    def test_managed_accept_uses_reusable_session_instead_of_link_queue(self):
        payload = {
            "peerPresenceHash": self.peer_hash,
            "reticulumIdentityPublicKeyBase64": "identity",
            "authMessage": {"type": "RCR", "ts": int(time.time() * 1000)},
            "transferId": "managed",
            "savePath": "/tmp/managed.recv",
            "fileName": "managed.bin",
            "size": 128,
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
        }
        with mock.patch.object(
            self.bridge,
            "_parse_qchat_file_peer_identity",
            return_value=object(),
        ), mock.patch.object(
            self.bridge,
            "_resource_session_accept",
        ) as accept_session, mock.patch.object(
            self.bridge,
            "_open_qchat_file_link_async",
        ) as open_legacy:
            self.bridge.handle_accept_qchat_file_resource("req", payload)

        accept_session.assert_called_once()
        open_legacy.assert_not_called()

    def test_fast_and_bulk_resources_use_separate_peer_sessions(self):
        fast_job = {
            "pending": self.pending("fast"),
            "created_at": time.time(),
        }
        bulk_job = {
            "pending": self.pending(
                "bulk",
                resource_type="reticulum_group_resource_range",
            ),
            "created_at": time.time(),
        }
        with mock.patch.object(self.bridge, "_resource_session_poll_path"):
            self.assertTrue(self.bridge._resource_session_enqueue_job(fast_job)[0])
            self.assertTrue(self.bridge._resource_session_enqueue_job(bulk_job)[0])

        self.assertIn(
            self.bridge._resource_session_key(self.peer_hash, "fast"),
            self.bridge._resource_sessions_by_key,
        )
        self.assertIn(
            self.bridge._resource_session_key(self.peer_hash, "bulk"),
            self.bridge._resource_sessions_by_key,
        )
        self.assertEqual(len(self.bridge._resource_sessions_by_key), 2)

    def test_live_event_and_history_use_separate_priority_lanes(self):
        history_pending = self.pending("history")
        history_pending["metadata"].update(
            {
                "logicalResourceType": "reticulum_chat_history_page",
                "channelId": "general",
                "direction": "before",
            }
        )
        history_pending["authMessage"].update({"before": {"id": "cursor"}})
        live_pending = self.pending(
            "live",
            event_id="event-live",
            sha256="11" * 32,
        )
        history_job = {"pending": history_pending, "created_at": time.time()}
        live_job = {"pending": live_pending, "created_at": time.time() + 0.01}

        with mock.patch.object(self.bridge, "_resource_session_poll_path"):
            self.assertTrue(self.bridge._resource_session_enqueue_job(history_job)[0])
            self.assertTrue(self.bridge._resource_session_enqueue_job(live_job)[0])

        fast_id = self.bridge._resource_sessions_by_key[
            self.bridge._resource_session_key(self.peer_hash, "fast")
        ]
        bulk_id = self.bridge._resource_sessions_by_key[
            self.bridge._resource_session_key(self.peer_hash, "bulk")
        ]
        self.assertEqual(
            [
                job["pending"]["transferId"]
                for job in self.bridge._qchat_file_links_by_id[fast_id]["pending_jobs"]
            ],
            ["live"],
        )
        self.assertEqual(
            [
                job["pending"]["transferId"]
                for job in self.bridge._qchat_file_links_by_id[bulk_id]["pending_jobs"]
            ],
            ["history"],
        )

    def test_dm_history_page_uses_bulk_lane(self):
        self.assertEqual(
            self.bridge._resource_session_lane(
                self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
                "reticulum_chat_dm_page",
            ),
            "bulk",
        )

    def test_prepare_command_reuses_pending_session_and_reports_state(self):
        peer_identity = object()
        payload = {
            "peerPresenceHash": self.peer_hash,
            "reticulumIdentityPublicKeyBase64": "identity",
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
            "logicalResourceType": "reticulum_chat_history_page",
        }
        with mock.patch.object(
            self.bridge,
            "_resource_session_poll_path",
        ) as poll_path, mock.patch.object(self.bridge, "emit_resp") as emit_resp:
            with mock.patch.object(
                self.bridge,
                "_parse_qchat_file_peer_identity",
                return_value=peer_identity,
            ) as parse_identity:
                self.bridge.handle_prepare_reticulum_resource_session("one", payload)
                self.bridge.handle_prepare_reticulum_resource_session("two", payload)

        poll_path.assert_called_once()
        parse_identity.assert_has_calls(
            [
                mock.call(self.peer_hash, "identity"),
                mock.call(self.peer_hash, "identity"),
            ]
        )
        self.assertEqual(len(self.bridge._resource_sessions_by_key), 1)
        session_id = next(iter(self.bridge._resource_sessions_by_key.values()))
        self.assertIs(
            self.bridge._qchat_file_links_by_id[session_id]["peerIdentity"],
            peer_identity,
        )
        self.assertEqual(emit_resp.call_count, 2)
        self.assertTrue(all(call.args[1] for call in emit_resp.call_args_list))
        self.assertTrue(
            all(
                call.kwargs["payload"]["status"] == "pending"
                and call.kwargs["payload"]["lane"] == "bulk"
                for call in emit_resp.call_args_list
            )
        )

    def test_prepare_command_recalls_identity_when_public_key_is_omitted(self):
        peer_identity = object()
        payload = {
            "peerPresenceHash": self.peer_hash,
            "reticulumIdentityPublicKeyBase64": "",
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
        }

        def recall(peer_hash, source):
            self.assertEqual(peer_hash, self.peer_hash)
            self.assertEqual(source, "ts_seed")
            self.bridge._known_peers[peer_hash] = peer_identity
            return True

        with mock.patch.object(
            self.bridge,
            "ensure_known_peer_from_recall",
            side_effect=recall,
        ), mock.patch.object(
            self.bridge,
            "_resource_session_poll_path",
        ) as poll_path, mock.patch.object(self.bridge, "emit_resp") as emit_resp:
            self.bridge.handle_prepare_reticulum_resource_session("req", payload)

        poll_path.assert_called_once()
        session_id = next(iter(self.bridge._resource_sessions_by_key.values()))
        self.assertIs(
            self.bridge._qchat_file_links_by_id[session_id]["peerIdentity"],
            peer_identity,
        )
        emit_resp.assert_called_once_with(
            "req",
            True,
            payload=mock.ANY,
        )

    def test_prepare_command_rejects_unverified_peer_identity(self):
        payload = {
            "peerPresenceHash": self.peer_hash,
            "reticulumIdentityPublicKeyBase64": "bad-identity",
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
        }
        with mock.patch.object(
            self.bridge,
            "_parse_qchat_file_peer_identity",
            side_effect=ValueError("identity mismatch"),
        ), mock.patch.object(
            self.bridge,
            "_resource_session_poll_path",
        ) as poll_path, mock.patch.object(self.bridge, "emit_resp") as emit_resp:
            self.bridge.handle_prepare_reticulum_resource_session("req", payload)

        poll_path.assert_not_called()
        emit_resp.assert_called_once_with(
            "req",
            False,
            payload={"code": "bad_reticulum_identity"},
            error="identity mismatch",
        )

    def test_prepare_command_parses_real_reticulum_identity(self):
        peer_identity = RNS.Identity()
        peer_hash = self.bridge.destination_hash_hex(
            self.bridge.build_outbound_destination(peer_identity).hash
        )
        public_key = base64.b64encode(peer_identity.get_public_key()).decode("ascii")
        payload = {
            "peerPresenceHash": peer_hash,
            "reticulumIdentityPublicKeyBase64": public_key,
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
        }

        with mock.patch.object(
            self.bridge,
            "_resource_session_poll_path",
        ) as poll_path, mock.patch.object(self.bridge, "emit_resp") as emit_resp:
            self.bridge.handle_prepare_reticulum_resource_session("req", payload)

        poll_path.assert_called_once()
        session_id = next(iter(self.bridge._resource_sessions_by_key.values()))
        parsed_identity = self.bridge._qchat_file_links_by_id[session_id]["peerIdentity"]
        self.assertEqual(parsed_identity.get_public_key(), peer_identity.get_public_key())
        emit_resp.assert_called_once_with("req", True, payload=mock.ANY)

    def test_capacity_does_not_evict_a_connecting_session(self):
        state, link = self.session(established=False)
        with mock.patch.object(
            self.bridge,
            "_RESOURCE_SESSION_MAX_TOTAL",
            1,
        ), mock.patch.object(
            self.bridge,
            "_teardown_reticulum_link_bounded",
        ) as teardown:
            available = self.bridge._resource_session_evict_idle_for_capacity()

        self.assertFalse(available)
        self.assertIn(state["sessionKey"], self.bridge._resource_sessions_by_key)
        self.assertFalse(link.teardown_called)
        teardown.assert_not_called()

    def test_session_waits_for_provider_ready_before_dispatch(self):
        state, link = self.session(established=False)
        self.bridge._destination = FakeDestination()
        with mock.patch.object(
            self.bridge,
            "_send_packet_on_link",
            return_value=True,
        ), mock.patch.object(
            self.bridge,
            "_resource_session_dispatch_pending",
        ), mock.patch.object(
            self.bridge,
            "_resource_session_schedule_idle_close",
        ), mock.patch.object(self.bridge, "emit_event") as emit_event:
            self.bridge.on_outgoing_resource_session_established(link)
            self.assertTrue(state["established"])
            self.assertFalse(state["remote_ready"])
            self.assertFalse(
                any(
                    call.args[0] == "reticulum_resource_session"
                    and call.args[1].get("status") == "ready"
                    for call in emit_event.call_args_list
                )
            )
            self.bridge._handle_qchat_file_link_packet(
                json.dumps(
                    {
                        "type": self.bridge._RESOURCE_SESSION_READY_TYPE,
                        "r": self.peer_hash,
                        "lane": "fast",
                    }
                ).encode("utf-8"),
                FakePacket(link),
            )

        self.assertTrue(state["remote_ready"])
        emit_event.assert_any_call(
            "reticulum_resource_session",
            {
                "status": "ready",
                "peerPresenceHash": self.peer_hash,
                "lane": "fast",
                "linkId": state["linkId"],
            },
        )

    def test_first_packet_classifies_incoming_resource_session_without_overlay(self):
        link = FakeSessionLink()
        remote_identity = object()
        link.remote_identity = remote_identity
        self.bridge._destination = FakeDestination()
        hello = json.dumps(
            {
                "type": self.bridge._RESOURCE_SESSION_HELLO_TYPE,
                "r": self.peer_hash,
                "lane": "fast",
            }
        ).encode("utf-8")

        with mock.patch.object(
            self.bridge,
            "_schedule_inbound_classify_fallback",
        ), mock.patch.object(
            self.bridge,
            "_destination_hash_for_identity",
            return_value=self.peer_hash,
        ), mock.patch.object(
            self.bridge,
            "_send_packet_on_link",
            return_value=True,
        ) as send_packet, mock.patch.object(
            self.bridge,
            "_resource_session_schedule_idle_close",
        ), mock.patch.object(
            self.bridge,
            "_teardown_reticulum_link_bounded",
        ):
            self.bridge.on_incoming_unified_link_established(link)
            link.packet_callback(hello, FakePacket(link))

            link_id = self.bridge.get_qchat_file_link_id(link)
            self.assertIsInstance(link_id, str)
            self.assertIsNone(self.bridge.get_overlay_link_id(link))
            state = self.bridge.get_qchat_file_link_state(link_id)
            self.assertEqual(state["linkId"], link_id)
            self.assertEqual(state["manager_kind"], "resource_session")
            self.assertEqual(state["peerPresenceHash"], self.peer_hash)
            self.assertTrue(state["provider_ready_sent"])
            send_packet.assert_called_once()

            link.closed_callback(link)

        self.assertIsNone(self.bridge.get_qchat_file_link_id(link))
        self.assertNotIn(link_id, self.bridge._qchat_file_links_by_id)

    def test_parallel_dispatch_never_exceeds_lane_limit(self):
        state, link = self.session()
        job_count = self.bridge._RESOURCE_SESSION_FAST_CONCURRENCY + 6
        state["pending_jobs"] = [
            {
                "pending": self.pending(f"parallel-{index}"),
                "created_at": time.time(),
                "followers": [],
            }
            for index in range(job_count)
        ]

        threads = [
            threading.Thread(
                target=self.bridge._resource_session_dispatch_pending,
                args=(state,),
            )
            for _ in range(4)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)

        self.assertEqual(
            len(state["active_requests"]),
            self.bridge._RESOURCE_SESSION_FAST_CONCURRENCY,
        )
        self.assertEqual(
            len(link.requests),
            self.bridge._RESOURCE_SESSION_FAST_CONCURRENCY,
        )
        self.assertEqual(
            len(state["pending_jobs"]),
            job_count - self.bridge._RESOURCE_SESSION_FAST_CONCURRENCY,
        )

    def test_identical_event_downloads_share_one_network_job(self):
        first = self.pending("first", event_id="event-1", sha256="22" * 32)
        second = self.pending("second", event_id="event-1", sha256="22" * 32)
        self.bridge._qchat_file_store_pending_receive(self.peer_hash, first)
        self.bridge._qchat_file_store_pending_receive(self.peer_hash, second)

        with mock.patch.object(
            self.bridge,
            "_resource_session_enqueue_job",
            return_value=(True, ""),
        ) as enqueue, mock.patch.object(self.bridge, "emit_resp"):
            self.bridge._resource_session_accept("req-1", first)
            self.bridge._resource_session_accept("req-2", second)

        self.assertEqual(enqueue.call_count, 1)
        canonical = self.bridge._resource_session_jobs_by_transfer["first"]
        self.assertEqual(len(canonical["followers"]), 1)
        self.assertIs(
            self.bridge._resource_session_jobs_by_transfer["second"],
            canonical["followers"][0],
        )

    def test_stale_authorization_is_not_dispatched(self):
        state, link = self.session()
        job = {
            "pending": self.pending(
                "stale",
                timestamp=int(
                    (time.time() - self.bridge._RESOURCE_SESSION_AUTH_MAX_QUEUE_SECONDS - 1)
                    * 1000
                ),
            ),
            "created_at": time.time() - 100,
            "followers": [],
        }
        with mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
            dispatched = self.bridge._resource_session_dispatch_job(state, job)

        self.assertFalse(dispatched)
        self.assertEqual(link.requests, [])
        self.assertTrue(job["completed"])
        self.assertTrue(
            any(
                call.args[0] == "failed"
                and call.args[1]["reason"] == "resource_auth_refresh_required"
                for call in emit.call_args_list
            )
        )

    def test_request_exception_fails_job_instead_of_leaving_it_active(self):
        state, link = self.session()
        job = {
            "pending": self.pending("request-exception"),
            "created_at": time.time(),
            "followers": [],
            "session": state,
        }
        with mock.patch.object(
            link,
            "request",
            side_effect=RuntimeError("request failed"),
        ), mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
            dispatched = self.bridge._resource_session_dispatch_job(state, job)

        self.assertFalse(dispatched)
        self.assertTrue(job["completed"])
        self.assertNotIn("request-exception", state["active_requests"])
        self.assertTrue(
            any(
                call.args[0] == "failed"
                and call.args[1]["reason"] == "resource_request_send_failed"
                for call in emit.call_args_list
            )
        )

    def test_late_response_after_cancellation_closes_response_file(self):
        job = {
            "completed": True,
            "pending": self.pending("late-response"),
        }
        receipt = FakeSessionReceipt()
        receipt.response = tempfile.TemporaryFile()

        self.bridge._resource_session_response_received(job, receipt)

        self.assertTrue(receipt.response.closed)

    def test_establishment_timeout_fails_jobs_once_and_refreshes_path(self):
        state, link = self.session(established=False)
        state["link_created_at"] = time.time() - 31
        jobs = [
            {
                "pending": self.pending(f"job-{index}"),
                "created_at": time.time(),
                "followers": [],
                "session": state,
            }
            for index in range(2)
        ]
        state["pending_jobs"] = jobs
        with mock.patch.object(
            self.bridge,
            "_force_overlay_peer_path_refresh",
        ) as refresh, mock.patch.object(
            self.bridge,
            "_teardown_reticulum_link_bounded",
        ) as teardown, mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
            self.bridge._resource_session_open_timeout(state)

        refresh.assert_called_once()
        teardown.assert_called_once_with(link, mock.ANY)
        self.assertTrue(all(job["completed"] for job in jobs))
        self.assertEqual(
            len([call for call in emit.call_args_list if call.args[0] == "failed"]),
            2,
        )
        self.assertNotIn(state["sessionKey"], self.bridge._resource_sessions_by_key)

    def test_provider_request_waits_for_existing_electron_authorization(self):
        state, link = self.session()
        state["incoming"] = True
        transfer_id = "provider"
        with tempfile.NamedTemporaryFile(delete=False) as temp_file:
            temp_file.write(b"resource-response")
            file_path = temp_file.name
        pending = {
            "allowedRecipientAddress": "",
            "transferId": transfer_id,
            "filePath": file_path,
            "fileName": "provider.bin",
            "size": len(b"resource-response"),
            "sha256": "",
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
            "metadata": {"eventId": "event-provider"},
            "expires_at": time.time() + 60,
        }
        self.bridge._qchat_file_pending_sends_by_transfer[transfer_id] = pending

        def authorize_on_event(status, payload):
            if status != "auth":
                return
            key = self.bridge._resource_session_waiter_key(
                state["linkId"],
                transfer_id,
            )
            waiter = self.bridge._resource_session_provider_waiters[key]
            waiter["authorized"] = True
            waiter["event"].set()

        try:
            remote_identity = object()
            with mock.patch.object(
                self.bridge,
                "_qchat_file_emit",
                side_effect=authorize_on_event,
            ), mock.patch.object(self.bridge, "_resource_session_watch_provider_file"):
                with mock.patch.object(
                    self.bridge,
                    "_destination_hash_for_identity",
                    return_value=self.peer_hash,
                ):
                    response = self.bridge._resource_session_response_generator(
                        self.bridge._RESOURCE_SESSION_REQUEST_PATH,
                        {
                            "version": 1,
                            "transferId": transfer_id,
                            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
                            "metadata": {"eventId": "event-provider"},
                            "authMessage": {"type": "RCR"},
                        },
                        b"request",
                        link.link_id,
                        remote_identity,
                        time.time(),
                    )
            self.assertIsInstance(response, tuple)
            self.assertEqual(response[1]["transferId"], transfer_id)
            self.assertEqual(state["provider_active"], 1)
            self.assertEqual(response[0].read(), b"resource-response")
            response[0].close()
        finally:
            Path(file_path).unlink(missing_ok=True)

    def test_provider_rejects_unidentified_resource_session(self):
        _state, link = self.session()
        with mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
            response = self.bridge._resource_session_response_generator(
                self.bridge._RESOURCE_SESSION_REQUEST_PATH,
                {
                    "version": 1,
                    "transferId": "unidentified",
                    "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
                    "metadata": {"eventId": "event-unidentified"},
                    "authMessage": {"type": "RCR"},
                },
                b"request",
                link.link_id,
                None,
                time.time(),
            )

        self.assertEqual(response["reason"], "resource_peer_unidentified")
        emit.assert_not_called()

    def test_provider_rejects_request_after_idle_close_commits(self):
        state, link = self.session()
        state["incoming"] = True
        state["closing"] = True
        remote_identity = object()
        with mock.patch.object(
            self.bridge,
            "_destination_hash_for_identity",
            return_value=self.peer_hash,
        ), mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
            response = self.bridge._resource_session_response_generator(
                self.bridge._RESOURCE_SESSION_REQUEST_PATH,
                {
                    "version": 1,
                    "transferId": "closing",
                    "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
                    "metadata": {"eventId": "event-closing"},
                    "authMessage": {"type": "RCR"},
                },
                b"request",
                link.link_id,
                remote_identity,
                time.time(),
            )

        self.assertEqual(response["reason"], "resource_session_unavailable")
        self.assertEqual(state["provider_active"], 0)
        emit.assert_not_called()

    def test_provider_concurrency_limit_rejects_without_emitting_auth(self):
        acquired = []
        for _ in range(self.bridge._RESOURCE_SESSION_PROVIDER_CONCURRENCY):
            self.assertTrue(
                self.bridge._resource_session_provider_slots.acquire(blocking=False)
            )
            acquired.append(True)
        try:
            with mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
                response = self.bridge._resource_session_response_generator(
                    self.bridge._RESOURCE_SESSION_REQUEST_PATH,
                    {},
                    b"request",
                    b"link",
                    None,
                    time.time(),
                )
            self.assertEqual(response["reason"], "resource_provider_busy")
            emit.assert_not_called()
        finally:
            for _ in acquired:
                self.bridge._resource_session_provider_slots.release()

    def test_provider_slot_is_held_until_progressing_response_completes(self):
        state, link = self.session()
        state["incoming"] = True
        state["provider_active"] = 1
        transfer_id = "provider-progress"
        request_id = bytes.fromhex("88" * 16)

        class ProviderResource:
            def __init__(self):
                self.request_id = request_id
                self.status = RNS.Resource.TRANSFERRING
                self.progress = 0.0

            def get_progress(self):
                return self.progress

        resource = ProviderResource()
        link.outgoing_resources.append(resource)
        with tempfile.NamedTemporaryFile(delete=False) as temp_file:
            temp_file.write(b"progressing-resource")
            file_path = temp_file.name
        file_handle = open(file_path, "rb")
        pending = {
            "transferId": transfer_id,
            "fileName": "progress.bin",
            "size": len(b"progressing-resource"),
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
        }
        self.bridge._qchat_file_pending_sends_by_transfer[transfer_id] = pending
        self.assertTrue(
            self.bridge._resource_session_provider_slots.acquire(blocking=False)
        )

        try:
            with mock.patch.object(
                self.bridge,
                "_RESOURCE_SESSION_RESPONSE_STALL_TIMEOUT_SECONDS",
                0.25,
            ), mock.patch.object(
                self.bridge,
                "_resource_session_schedule_idle_close",
            ), mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
                self.bridge._resource_session_watch_provider_file(
                    file_handle,
                    pending,
                    state,
                    request_id,
                )
                for progress in (0.1, 0.2, 0.3, 0.4):
                    time.sleep(0.11)
                    resource.progress = progress
                resource.status = RNS.Resource.COMPLETE
                deadline = time.time() + 2
                while state["provider_active"] > 0 and time.time() < deadline:
                    time.sleep(0.02)

            self.assertEqual(state["provider_active"], 0)
            self.assertNotIn(
                transfer_id,
                self.bridge._qchat_file_pending_sends_by_transfer,
            )
            self.assertTrue(
                any(
                    call.args[0] == "sent"
                    and call.args[1]["transferId"] == transfer_id
                    for call in emit.call_args_list
                )
            )
            available_slots = 0
            while self.bridge._resource_session_provider_slots.acquire(blocking=False):
                available_slots += 1
            self.assertEqual(
                available_slots,
                self.bridge._RESOURCE_SESSION_PROVIDER_CONCURRENCY,
            )
            for _ in range(available_slots):
                self.bridge._resource_session_provider_slots.release()
        finally:
            if not file_handle.closed:
                file_handle.close()
            Path(file_path).unlink(missing_ok=True)

    def test_provider_watcher_follows_all_resource_segments(self):
        state, link = self.session()
        state["incoming"] = True
        state["provider_active"] = 1
        transfer_id = "provider-segments"
        request_id = bytes.fromhex("99" * 16)

        class ProviderSegment:
            def __init__(self, index, status, progress):
                self.request_id = request_id
                self.segment_index = index
                self.total_segments = 2
                self.status = status
                self.progress = progress
                self.next_segment = None

            def get_progress(self):
                return self.progress

        second = ProviderSegment(2, RNS.Resource.TRANSFERRING, 0.5)
        first = ProviderSegment(1, RNS.Resource.COMPLETE, 0.5)
        first.next_segment = second
        link.outgoing_resources.append(first)
        with tempfile.NamedTemporaryFile(delete=False) as temp_file:
            temp_file.write(b"segmented-resource")
            file_path = temp_file.name
        file_handle = open(file_path, "rb")
        pending = {
            "transferId": transfer_id,
            "fileName": "segments.bin",
            "size": len(b"segmented-resource"),
            "resourceType": self.bridge._RETICULUM_CHAT_RESOURCE_TYPE,
        }
        self.bridge._qchat_file_pending_sends_by_transfer[transfer_id] = pending
        self.assertTrue(
            self.bridge._resource_session_provider_slots.acquire(blocking=False)
        )

        try:
            with mock.patch.object(
                self.bridge,
                "_RESOURCE_SESSION_RESPONSE_STALL_TIMEOUT_SECONDS",
                1.0,
            ), mock.patch.object(
                self.bridge,
                "_resource_session_schedule_idle_close",
            ), mock.patch.object(self.bridge, "_qchat_file_emit") as emit:
                self.bridge._resource_session_watch_provider_file(
                    file_handle,
                    pending,
                    state,
                    request_id,
                )
                time.sleep(0.15)
                self.assertEqual(state["provider_active"], 1)
                self.assertFalse(
                    any(call.args[0] == "sent" for call in emit.call_args_list)
                )
                second.progress = 1.0
                second.status = RNS.Resource.COMPLETE
                deadline = time.time() + 2
                while state["provider_active"] > 0 and time.time() < deadline:
                    time.sleep(0.02)

            self.assertEqual(state["provider_active"], 0)
            self.assertTrue(
                any(call.args[0] == "sent" for call in emit.call_args_list)
            )
        finally:
            if not file_handle.closed:
                file_handle.close()
            Path(file_path).unlink(missing_ok=True)

    def test_cancelled_request_does_not_close_reusable_session(self):
        state, link = self.session()
        pending = self.pending("cancel-me")
        job = {
            "pending": pending,
            "created_at": time.time(),
            "followers": [],
            "session": state,
            "semanticKey": "cancel-key",
        }
        state["active_requests"]["cancel-me"] = job
        self.bridge._resource_session_jobs_by_transfer["cancel-me"] = job
        self.bridge._resource_session_jobs_by_semantic_key["cancel-key"] = job
        self.bridge._qchat_file_store_pending_receive(self.peer_hash, pending)

        with mock.patch.object(self.bridge, "_qchat_file_emit"):
            closed = self.bridge._qchat_file_cancel_transfer(
                "cancel-me",
                self.peer_hash,
                "test-cancel",
            )

        self.assertEqual(closed, 0)
        self.assertFalse(link.teardown_called)
        self.assertIn(state["sessionKey"], self.bridge._resource_sessions_by_key)
        self.assertTrue(job["completed"])


if __name__ == "__main__":
    unittest.main()
