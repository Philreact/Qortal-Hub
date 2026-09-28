import json
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
import sys

RESOURCE_DIR = Path(__file__).resolve().parent
if str(RESOURCE_DIR) not in sys.path:
    sys.path.insert(0, str(RESOURCE_DIR))

from qortal_python_diagnostics import PythonDiagnosticsProfiler


class PythonDiagnosticsProfilerTests(unittest.TestCase):
    def test_writes_bounded_thread_and_stack_report(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            profiler = PythonDiagnosticsProfiler(
                process_name="test-process",
                output_dir=Path(temporary),
                duration_seconds=0.15,
                interval_seconds=0.02,
            )
            profiler.start()

            finished = threading.Event()

            def worker() -> None:
                finished.wait(0.08)

            thread = threading.Thread(target=worker, name="diagnostic-test-worker")
            thread.start()
            time.sleep(0.06)
            finished.set()
            thread.join(timeout=1.0)
            profiler.finish()

            report = json.loads(profiler.output_path.read_text(encoding="utf-8"))
            self.assertEqual(report["schemaVersion"], 1)
            self.assertEqual(report["process"], "test-process")
            self.assertGreaterEqual(report["samplerTicks"], 1)
            self.assertGreaterEqual(report["peakThreadCount"], 2)
            self.assertEqual(
                report["threadStartsByName"].get("diagnostic-test-worker"), 1
            )
            self.assertTrue(report["topObservedStacks"])

    def test_measures_and_restores_reticulum_diagnostics(self) -> None:
        class FakeEventedSocketIO:
            wakeup_fileno = 7
            event_backend = "epoll"
            read_events = 4
            write_events = 2
            read_bytes = 100
            write_bytes = 50
            read_budget_hits = 0
            write_budget_hits = 0
            tx_buffer_max = 12
            socket_close_count = 1
            socket_error_count = 0
            _read_mask_value = 1
            _read_write_mask_value = 3

            @staticmethod
            def _poll(_timeout: float):
                return [(7, 1), (8, 1)]

            @staticmethod
            def _read_mask():
                return FakeEventedSocketIO._read_mask_value

            @staticmethod
            def _read_write_mask():
                return FakeEventedSocketIO._read_write_mask_value

            @staticmethod
            def wake():
                return None

            @staticmethod
            def _modify_or_recover_fileno(_fileno, _mask, _owner=None):
                return True

            @staticmethod
            def _read_client_socket(_fileno, _interface, _client_socket):
                FakeEventedSocketIO.read_bytes += 25
                return False

            @staticmethod
            def _write_client_socket(_fileno, _interface, _client_socket):
                FakeEventedSocketIO.write_bytes += 10
                return False

        class FakeLink:
            def _Link__watchdog_job(self) -> str:
                return "link"

        class FakeResource:
            def _Resource__watchdog_job(self) -> str:
                return "resource"

        class FakeTransport:
            @staticmethod
            def outbound(_packet):
                return "outbound"

        class FakePacket:
            def __init__(self):
                self.raw = bytes(20)
                self.packet_type = None
                self.context = None
                self.destination_type = None

            def unpack(self):
                self.packet_type = 0
                self.context = 14
                self.destination_type = 3
                return True

        modules = {
            "RNS.Interfaces.EventedSocketIO": types.SimpleNamespace(
                EventedSocketIO=FakeEventedSocketIO
            ),
            "RNS.Link": types.SimpleNamespace(Link=FakeLink),
            "RNS.Resource": types.SimpleNamespace(Resource=FakeResource),
            "RNS.Transport": types.SimpleNamespace(Transport=FakeTransport),
            "RNS.Packet": types.SimpleNamespace(Packet=FakePacket),
        }
        previous = {name: sys.modules.get(name) for name in modules}
        sys.modules.update(modules)
        original_poll = FakeEventedSocketIO._poll
        original_link = FakeLink._Link__watchdog_job
        original_resource = FakeResource._Resource__watchdog_job
        original_unpack = FakePacket.unpack
        original_outbound = FakeTransport.outbound
        try:
            with tempfile.TemporaryDirectory() as temporary:
                profiler = PythonDiagnosticsProfiler(
                    process_name="reticulum-test",
                    output_dir=Path(temporary),
                    duration_seconds=1,
                    interval_seconds=1,
                )
                profiler._ensure_reticulum_instrumentation()
                original_json_loads = json.loads
                profiler._patch_bridge_json_loads()
                self.assertEqual(
                    profiler._bridge_wire_label({"t": "RCHAT", "k": "land_state"}),
                    "RCHAT/land_state",
                )
                self.assertEqual(json.loads('{"t":"WIRE_TEST"}')["t"], "WIRE_TEST")
                self.assertEqual(FakeEventedSocketIO._poll(1), [(7, 1), (8, 1)])
                FakeEventedSocketIO.wake()
                FakeEventedSocketIO._modify_or_recover_fileno(8, 3)
                FakeEventedSocketIO._modify_or_recover_fileno(8, 3)
                interface = type(
                    "Interface", (), {"__str__": lambda _self: "local-test"}
                )()
                FakeEventedSocketIO._read_client_socket(8, interface, object())
                FakeEventedSocketIO._write_client_socket(8, interface, object())
                self.assertEqual(FakeLink()._Link__watchdog_job(), "link")
                self.assertEqual(FakeResource()._Resource__watchdog_job(), "resource")
                self.assertTrue(FakePacket().unpack())
                outbound_packet = types.SimpleNamespace(
                    packet_type=2,
                    context=0,
                    raw=bytes(51),
                    destination=types.SimpleNamespace(type=1),
                )
                self.assertEqual(
                    FakeTransport.outbound(outbound_packet), "outbound"
                )
                profiler.finish()

                report = json.loads(
                    profiler.output_path.read_text(encoding="utf-8")
                )
                self.assertEqual(
                    report["reticulum"]["measured"],
                    {
                        "linkWatchdogJobs": 1,
                        "interestReadWriteRequests": 2,
                        "interestRedundantRequests": 1,
                        "interestUpdateCalls": 2,
                        "pollCalls": 1,
                        "pollDataEvents": 1,
                        "pollEvents": 2,
                        "pollWakeupEvents": 1,
                        "resourceWatchdogJobs": 1,
                        "wakeCalls": 1,
                    },
                )
                self.assertEqual(report["reticulum"]["localIo"]["readBytes"], 125)
                self.assertEqual(
                    report["reticulum"]["interfaceIo"]["local-test"],
                    {
                        "readBytes": 25,
                        "readEvents": 1,
                        "writeBytes": 10,
                        "writeEvents": 1,
                    },
                )
                self.assertEqual(
                    report["reticulum"]["packetIo"],
                    {
                        "inbound": [
                            {
                                "packetType": 0,
                                "context": 14,
                                "destinationType": 3,
                                "packets": 1,
                                "bytes": 20,
                            }
                        ],
                        "outbound": [
                            {
                                "packetType": 2,
                                "context": 0,
                                "destinationType": 1,
                                "packets": 1,
                                "bytes": 51,
                            }
                        ],
                    },
                )
                self.assertEqual(
                    report["reticulum"]["bridgeJsonLoads"],
                    [
                        {
                            "caller": "test_measures_and_restores_reticulum_diagnostics",
                            "wireType": "WIRE_TEST",
                            "loads": 1,
                            "bytes": 17,
                        }
                    ],
                )
                self.assertIs(FakeEventedSocketIO._poll, original_poll)
                self.assertIs(FakeLink._Link__watchdog_job, original_link)
                self.assertIs(FakeResource._Resource__watchdog_job, original_resource)
                self.assertIs(FakePacket.unpack, original_unpack)
                self.assertIs(FakeTransport.outbound, original_outbound)
                self.assertIs(json.loads, original_json_loads)
        finally:
            for name, module in previous.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module


if __name__ == "__main__":
    unittest.main()
