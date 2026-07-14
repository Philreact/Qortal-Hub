import importlib.util
import json
import queue
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


if __name__ == "__main__":
    unittest.main()
