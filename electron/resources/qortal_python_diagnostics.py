"""Opt-in, bounded diagnostics for Qortal Hub Python processes.

The profiler deliberately uses only the Python standard library so it can run
inside bundled runtimes. It is completely inert unless
``QORTAL_PYTHON_DIAGNOSTICS`` is enabled.
"""

from __future__ import annotations

import atexit
from collections import Counter
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
import traceback
from typing import Any, Dict, Optional, Tuple


_ENABLED_VALUES = {"1", "true", "yes", "on"}
_MAX_STACK_DEPTH = 24
_MAX_STACK_SIGNATURES = 2048
_MAX_REPORTED_STACKS = 256
_MAX_THREAD_NAMES = 512
_HEX_ID_RE = re.compile(r"(?i)(?<![0-9a-f])[0-9a-f]{12,}(?![0-9a-f])")
_active_profiler: Optional["PythonDiagnosticsProfiler"] = None
_start_lock = threading.Lock()


def _bounded_float(raw: object, fallback: float, minimum: float, maximum: float) -> float:
    try:
        value = float(str(raw))
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, value))


def _safe_process_name(value: object) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "python")).strip("-.")
    return normalized[:64] or "python"


def _safe_thread_name(value: object) -> str:
    # Dynamic transfer/event IDs would otherwise create an unbounded number of
    # buckets while adding no useful information to a thread-class report.
    normalized = _HEX_ID_RE.sub("<id>", str(value or "unnamed"))
    return normalized[:160] or "unnamed"


def _safe_frame_path(filename: str) -> str:
    normalized = str(filename or "").replace("\\", "/")
    for marker in ("/RNS/", "/electron/resources/"):
        if marker in normalized:
            return f"{marker.strip('/')}/{normalized.split(marker, 1)[1]}"
    return os.path.basename(normalized) or "<unknown>"


class PythonDiagnosticsProfiler:
    def __init__(
        self,
        process_name: str,
        output_dir: Path,
        duration_seconds: float,
        interval_seconds: float,
    ) -> None:
        self.process_name = _safe_process_name(process_name)
        self.output_dir = output_dir
        self.duration_seconds = duration_seconds
        self.interval_seconds = interval_seconds
        self.started_wall = time.time()
        self.started_monotonic = time.monotonic()
        self.pid = os.getpid()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._finished = False
        self._sampler_thread: Optional[threading.Thread] = None
        self._original_thread_start = threading.Thread.start
        self._thread_start_wrapper = None
        self._threads_present_at_start: Counter[str] = Counter()
        self._thread_starts: Counter[str] = Counter()
        self._thread_observations: Counter[str] = Counter()
        self._stack_counts: Counter[Tuple[str, Tuple[str, ...]]] = Counter()
        self._native_thread_ids: Dict[str, set[int]] = {}
        self._reticulum_counts: Counter[str] = Counter()
        self._reticulum_count_lock = threading.Lock()
        self._reticulum_patches: list[Tuple[Any, str, Any, bool]] = []
        self._reticulum_patched_targets: set[str] = set()
        self._reticulum_interest_masks: Dict[int, int] = {}
        self._reticulum_interface_io: Dict[str, Counter[str]] = {}
        self._reticulum_packet_io: Dict[str, Counter[Tuple[int, int, int]]] = {
            "inbound": Counter(),
            "outbound": Counter(),
        }
        self._reticulum_packet_bytes: Dict[str, Counter[Tuple[int, int, int]]] = {
            "inbound": Counter(),
            "outbound": Counter(),
        }
        self._bridge_json_loads: Counter[Tuple[str, str]] = Counter()
        self._bridge_json_load_bytes: Counter[Tuple[str, str]] = Counter()
        self._stack_overflow_samples = 0
        self._thread_name_overflow = 0
        self._peak_thread_count = 0
        self._sampler_ticks = 0
        self._errors: Counter[str] = Counter()
        timestamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(self.started_wall))
        self.output_path = output_dir / f"{self.process_name}-{self.pid}-{timestamp}.json"

    def start(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        profiler = self
        original_start = self._original_thread_start

        def tracked_start(thread: threading.Thread, *args: Any, **kwargs: Any) -> Any:
            profiler._record_thread_start(thread)
            return original_start(thread, *args, **kwargs)

        self._thread_start_wrapper = tracked_start
        threading.Thread.start = tracked_start  # type: ignore[assignment]
        try:
            self._record_existing_threads()
            self._sampler_thread = threading.Thread(
                target=self._sample_loop,
                name="qortal-python-diagnostics",
                daemon=True,
            )
            self._sampler_thread.start()
        except Exception:
            if threading.Thread.start is self._thread_start_wrapper:
                threading.Thread.start = self._original_thread_start  # type: ignore[assignment]
            raise

    def _record_existing_threads(self) -> None:
        for thread in threading.enumerate():
            name = _safe_thread_name(getattr(thread, "name", "unnamed"))
            self._threads_present_at_start[name] += 1

    def _record_thread_start(self, thread: threading.Thread) -> None:
        name = _safe_thread_name(getattr(thread, "name", "unnamed"))
        with self._lock:
            if name in self._thread_starts or len(self._thread_starts) < _MAX_THREAD_NAMES:
                self._thread_starts[name] += 1
            else:
                self._thread_name_overflow += 1

    def _sample_loop(self) -> None:
        deadline = self.started_monotonic + self.duration_seconds
        while not self._stop.wait(self.interval_seconds):
            try:
                self._sample_once()
            except Exception as exc:  # Diagnostics must never affect the app.
                with self._lock:
                    self._errors[type(exc).__name__] += 1
            if time.monotonic() >= deadline:
                break
        self.finish()

    def _sample_once(self) -> None:
        self._ensure_reticulum_instrumentation()
        frames = sys._current_frames()
        threads = list(threading.enumerate())
        names_by_ident = {
            thread.ident: _safe_thread_name(thread.name)
            for thread in threads
            if thread.ident is not None
        }
        sampled: list[Tuple[str, Tuple[str, ...]]] = []
        for ident, frame in frames.items():
            name = names_by_ident.get(ident, f"unknown-{ident}")
            extracted = traceback.extract_stack(frame, limit=_MAX_STACK_DEPTH)
            stack = tuple(
                f"{_safe_frame_path(item.filename)}:{item.name}:{item.lineno}"
                for item in extracted
            )
            sampled.append((name, stack))

        with self._lock:
            self._sampler_ticks += 1
            self._peak_thread_count = max(self._peak_thread_count, len(threads))
            for thread in threads:
                native_id = getattr(thread, "native_id", None)
                if not isinstance(native_id, int):
                    continue
                name = _safe_thread_name(thread.name)
                if name not in self._native_thread_ids:
                    if len(self._native_thread_ids) >= _MAX_THREAD_NAMES:
                        self._thread_name_overflow += 1
                        continue
                    self._native_thread_ids[name] = set()
                self._native_thread_ids[name].add(native_id)
            for name, stack in sampled:
                if name in self._thread_observations or len(self._thread_observations) < _MAX_THREAD_NAMES:
                    self._thread_observations[name] += 1
                else:
                    self._thread_name_overflow += 1
                key = (name, stack)
                if key in self._stack_counts or len(self._stack_counts) < _MAX_STACK_SIGNATURES:
                    self._stack_counts[key] += 1
                else:
                    self._stack_overflow_samples += 1

    def _ensure_reticulum_instrumentation(self) -> None:
        event_module = sys.modules.get("RNS.Interfaces.EventedSocketIO")
        event_class = getattr(event_module, "EventedSocketIO", None)
        if event_class is not None and "event-poll" not in self._reticulum_patched_targets:
            original_poll = getattr(event_class, "_poll", None)
            if callable(original_poll):
                profiler = self

                def measured_poll(timeout: float) -> Any:
                    events = original_poll(timeout)
                    event_count = len(events)
                    wakeup_fileno = getattr(event_class, "wakeup_fileno", None)
                    wakeup_events = sum(
                        1 for fileno, _event in events if fileno == wakeup_fileno
                    )
                    with profiler._reticulum_count_lock:
                        profiler._reticulum_counts["pollCalls"] += 1
                        profiler._reticulum_counts["pollEvents"] += event_count
                        profiler._reticulum_counts["pollWakeupEvents"] += wakeup_events
                        profiler._reticulum_counts["pollDataEvents"] += (
                            event_count - wakeup_events
                        )
                        if event_count == 0:
                            profiler._reticulum_counts["pollTimeouts"] += 1
                    return events

                event_class._poll = staticmethod(measured_poll)
                self._reticulum_patches.append(
                    (event_class, "_poll", original_poll, True)
                )
                self._reticulum_patched_targets.add("event-poll")

            original_wake = getattr(event_class, "wake", None)
            if callable(original_wake):
                profiler = self

                def measured_wake(_original: Any = original_wake) -> Any:
                    with profiler._reticulum_count_lock:
                        profiler._reticulum_counts["wakeCalls"] += 1
                    return _original()

                event_class.wake = staticmethod(measured_wake)
                self._reticulum_patches.append(
                    (event_class, "wake", original_wake, True)
                )

            original_modify = getattr(event_class, "_modify_or_recover_fileno", None)
            if callable(original_modify):
                profiler = self

                def measured_modify(
                    fileno: int,
                    mask: int,
                    owner: Any = None,
                    _original: Any = original_modify,
                ) -> Any:
                    with profiler._reticulum_count_lock:
                        profiler._reticulum_counts["interestUpdateCalls"] += 1
                        if profiler._reticulum_interest_masks.get(fileno) == mask:
                            profiler._reticulum_counts[
                                "interestRedundantRequests"
                            ] += 1
                        if mask == event_class._read_mask():
                            profiler._reticulum_counts[
                                "interestReadOnlyRequests"
                            ] += 1
                        elif mask == event_class._read_write_mask():
                            profiler._reticulum_counts[
                                "interestReadWriteRequests"
                            ] += 1
                    result = _original(fileno, mask, owner)
                    if result:
                        with profiler._reticulum_count_lock:
                            profiler._reticulum_interest_masks[fileno] = mask
                    return result

                event_class._modify_or_recover_fileno = staticmethod(measured_modify)
                self._reticulum_patches.append(
                    (
                        event_class,
                        "_modify_or_recover_fileno",
                        original_modify,
                        True,
                    )
                )

            self._patch_reticulum_io_method(
                event_class, "_read_client_socket", "read"
            )
            self._patch_reticulum_io_method(
                event_class, "_write_client_socket", "write"
            )

        self._patch_reticulum_watchdog(
            "RNS.Link", "Link", "_Link__watchdog_job", "linkWatchdogJobs"
        )
        self._patch_reticulum_watchdog(
            "RNS.Resource",
            "Resource",
            "_Resource__watchdog_job",
            "resourceWatchdogJobs",
        )
        self._patch_reticulum_packets()
        main_module = sys.modules.get("__main__")
        main_file = str(getattr(main_module, "__file__", "") or "")
        if main_file.endswith("presence_bridge.py"):
            self._patch_bridge_json_loads()

    @staticmethod
    def _bridge_wire_label(value: Any) -> str:
        if not isinstance(value, dict):
            return type(value).__name__
        outer_type = value.get("t")
        inner_kind = value.get("k")
        if (
            outer_type == "RCHAT"
            and isinstance(inner_kind, str)
            and inner_kind
        ):
            return f"{_safe_thread_name(outer_type)[:38]}/{_safe_thread_name(inner_kind)[:38]}"
        for key in ("t", "type", "k", "action"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate:
                return _safe_thread_name(candidate)[:80]
        return "object"

    def _patch_bridge_json_loads(self) -> None:
        if "bridge-json-loads" in self._reticulum_patched_targets:
            return
        original_loads = getattr(json, "loads", None)
        if not callable(original_loads):
            return
        profiler = self

        def measured_loads(value: Any, *args: Any, **kwargs: Any) -> Any:
            result = original_loads(value, *args, **kwargs)
            try:
                caller = _safe_thread_name(sys._getframe(1).f_code.co_name)
                label = profiler._bridge_wire_label(result)
                byte_count = (
                    len(value)
                    if isinstance(value, (str, bytes, bytearray, memoryview))
                    else 0
                )
                with profiler._reticulum_count_lock:
                    key = (caller, label)
                    profiler._bridge_json_loads[key] += 1
                    profiler._bridge_json_load_bytes[key] += byte_count
            except Exception:
                pass
            return result

        json.loads = measured_loads
        self._reticulum_patches.append((json, "loads", original_loads, False))
        self._reticulum_patched_targets.add("bridge-json-loads")

    def _note_reticulum_packet(
        self,
        direction: str,
        packet_type: int,
        context: int,
        destination_type: int,
        byte_count: int,
    ) -> None:
        key = (int(packet_type), int(context), int(destination_type))
        with self._reticulum_count_lock:
            self._reticulum_packet_io[direction][key] += 1
            self._reticulum_packet_bytes[direction][key] += max(0, int(byte_count))

    def _patch_reticulum_packets(self) -> None:
        packet_module = sys.modules.get("RNS.Packet")
        packet_class = getattr(packet_module, "Packet", None)
        transport_module = sys.modules.get("RNS.Transport")
        transport_class = getattr(transport_module, "Transport", None)

        if packet_class is not None and "packet-unpack" not in self._reticulum_patched_targets:
            original_unpack = getattr(packet_class, "unpack", None)
            if callable(original_unpack):
                profiler = self

                def measured_unpack(
                    packet: Any,
                    _original: Any = original_unpack,
                ) -> Any:
                    result = _original(packet)
                    packet_type = getattr(packet, "packet_type", None)
                    context = getattr(packet, "context", None)
                    destination_type = getattr(packet, "destination_type", None)
                    raw = getattr(packet, "raw", None)
                    if (
                        result
                        and isinstance(packet_type, int)
                        and isinstance(context, int)
                        and isinstance(destination_type, int)
                    ):
                        profiler._note_reticulum_packet(
                            "inbound",
                            packet_type,
                            context,
                            destination_type,
                            len(raw)
                            if isinstance(raw, (bytes, bytearray, memoryview))
                            else 0,
                        )
                    return result

                packet_class.unpack = measured_unpack
                self._reticulum_patches.append(
                    (packet_class, "unpack", original_unpack, False)
                )
                self._reticulum_patched_targets.add("packet-unpack")

        if transport_class is not None and "transport-outbound" not in self._reticulum_patched_targets:
            original_outbound = getattr(transport_class, "outbound", None)
            if callable(original_outbound):
                profiler = self

                def measured_outbound(
                    packet: Any,
                    _original: Any = original_outbound,
                ) -> Any:
                    raw = getattr(packet, "raw", None)
                    packet_type = getattr(packet, "packet_type", None)
                    context = getattr(packet, "context", None)
                    destination = getattr(packet, "destination", None)
                    destination_type = getattr(destination, "type", None)
                    if (
                        isinstance(packet_type, int)
                        and isinstance(context, int)
                        and isinstance(destination_type, int)
                    ):
                        byte_count = (
                            len(raw)
                            if isinstance(raw, (bytes, bytearray, memoryview))
                            else 0
                        )
                        profiler._note_reticulum_packet(
                            "outbound",
                            packet_type,
                            context,
                            destination_type,
                            byte_count,
                        )
                    return _original(packet)

                transport_class.outbound = staticmethod(measured_outbound)
                self._reticulum_patches.append(
                    (transport_class, "outbound", original_outbound, True)
                )
                self._reticulum_patched_targets.add("transport-outbound")

    def _patch_reticulum_watchdog(
        self, module_name: str, class_name: str, method_name: str, counter_name: str
    ) -> None:
        if counter_name in self._reticulum_patched_targets:
            return
        module = sys.modules.get(module_name)
        owner = getattr(module, class_name, None)
        original = getattr(owner, method_name, None)
        if not callable(original):
            return
        profiler = self

        def measured(instance: Any, *args: Any, **kwargs: Any) -> Any:
            with profiler._reticulum_count_lock:
                profiler._reticulum_counts[counter_name] += 1
            return original(instance, *args, **kwargs)

        setattr(owner, method_name, measured)
        self._reticulum_patches.append((owner, method_name, original, False))
        self._reticulum_patched_targets.add(counter_name)

    def _patch_reticulum_io_method(
        self, event_class: Any, method_name: str, direction: str
    ) -> None:
        target_name = f"interface-{direction}"
        if target_name in self._reticulum_patched_targets:
            return
        original = getattr(event_class, method_name, None)
        if not callable(original):
            return
        profiler = self
        byte_counter = "read_bytes" if direction == "read" else "write_bytes"

        def measured(
            fileno: int,
            interface: Any,
            client_socket: Any,
            _original: Any = original,
        ) -> Any:
            before = int(getattr(event_class, byte_counter, 0))
            result = _original(fileno, interface, client_socket)
            transferred = max(
                0, int(getattr(event_class, byte_counter, 0)) - before
            )
            label = _safe_thread_name(str(interface))
            with profiler._reticulum_count_lock:
                if (
                    label in profiler._reticulum_interface_io
                    or len(profiler._reticulum_interface_io) < _MAX_THREAD_NAMES
                ):
                    counts = profiler._reticulum_interface_io.setdefault(
                        label, Counter()
                    )
                    counts[f"{direction}Events"] += 1
                    counts[f"{direction}Bytes"] += transferred
                else:
                    profiler._thread_name_overflow += 1
            return result

        setattr(event_class, method_name, staticmethod(measured))
        self._reticulum_patches.append(
            (event_class, method_name, original, True)
        )
        self._reticulum_patched_targets.add(target_name)

    def finish(self) -> None:
        with self._lock:
            if self._finished:
                return
            self._finished = True
        self._stop.set()
        if threading.Thread.start is self._thread_start_wrapper:
            threading.Thread.start = self._original_thread_start  # type: ignore[assignment]
        try:
            self._write_report()
        finally:
            self._restore_reticulum_instrumentation()

    def _restore_reticulum_instrumentation(self) -> None:
        for owner, name, original, is_static in reversed(self._reticulum_patches):
            try:
                setattr(owner, name, staticmethod(original) if is_static else original)
            except Exception:
                pass
        self._reticulum_patches.clear()

    def _reticulum_report(self) -> Dict[str, Any]:
        with self._reticulum_count_lock:
            measured = dict(self._reticulum_counts)
            interface_io = {
                name: dict(counts)
                for name, counts in self._reticulum_interface_io.items()
            }
            packet_io = {
                direction: [
                    {
                        "packetType": packet_type,
                        "context": context,
                        "destinationType": destination_type,
                        "packets": count,
                        "bytes": self._reticulum_packet_bytes[direction][
                            (packet_type, context, destination_type)
                        ],
                    }
                    for (packet_type, context, destination_type), count in counts.most_common()
                ]
                for direction, counts in self._reticulum_packet_io.items()
            }
            bridge_json_loads = [
                {
                    "caller": caller,
                    "wireType": wire_type,
                    "loads": count,
                    "bytes": self._bridge_json_load_bytes[(caller, wire_type)],
                }
                for (caller, wire_type), count in self._bridge_json_loads.most_common()
            ]
        event_module = sys.modules.get("RNS.Interfaces.EventedSocketIO")
        event_class = getattr(event_module, "EventedSocketIO", None)
        local_io: Dict[str, Any] = {}
        if event_class is not None:
            local_io = {
                "backend": getattr(event_class, "event_backend", None),
                "readEvents": getattr(event_class, "read_events", 0),
                "writeEvents": getattr(event_class, "write_events", 0),
                "readBytes": getattr(event_class, "read_bytes", 0),
                "writeBytes": getattr(event_class, "write_bytes", 0),
                "readBudgetHits": getattr(event_class, "read_budget_hits", 0),
                "writeBudgetHits": getattr(event_class, "write_budget_hits", 0),
                "txBufferMax": getattr(event_class, "tx_buffer_max", 0),
                "socketCloses": getattr(event_class, "socket_close_count", 0),
                "socketErrors": getattr(event_class, "socket_error_count", 0),
            }
        return {
            "measured": measured,
            "localIo": local_io,
            "interfaceIo": interface_io,
            "packetIo": packet_io,
            "bridgeJsonLoads": bridge_json_loads,
        }

    def _write_report(self) -> None:
        try:
            current_threads = list(threading.enumerate())
            with self._lock:
                top_stacks = self._stack_counts.most_common(_MAX_REPORTED_STACKS)
                report: Dict[str, Any] = {
                    "schemaVersion": 1,
                    "process": self.process_name,
                    "pid": self.pid,
                    "startedAtMs": round(self.started_wall * 1000),
                    "completedAtMs": round(time.time() * 1000),
                    "durationSeconds": round(time.monotonic() - self.started_monotonic, 3),
                    "sampleIntervalMs": round(self.interval_seconds * 1000, 3),
                    "samplerTicks": self._sampler_ticks,
                    "peakThreadCount": self._peak_thread_count,
                    "threadsPresentAtStart": dict(self._threads_present_at_start.most_common()),
                    "threadStartsByName": dict(self._thread_starts.most_common()),
                    "threadObservationsByName": dict(self._thread_observations.most_common()),
                    "nativeThreadIdsByName": {
                        name: sorted(native_ids)
                        for name, native_ids in self._native_thread_ids.items()
                    },
                    "threadsAliveAtEnd": [
                        {
                            "name": _safe_thread_name(thread.name),
                            "ident": thread.ident,
                            "nativeId": getattr(thread, "native_id", None),
                            "daemon": thread.daemon,
                        }
                        for thread in current_threads[:_MAX_THREAD_NAMES]
                    ],
                    "topObservedStacks": [
                        {
                            "thread": name,
                            "samples": count,
                            "stack": list(stack),
                        }
                        for (name, stack), count in top_stacks
                    ],
                    "boundedDrops": {
                        "stackSamples": self._stack_overflow_samples,
                        "threadNames": self._thread_name_overflow,
                    },
                    "errors": dict(self._errors),
                    "reticulum": self._reticulum_report(),
                    "note": (
                        "Observed stacks include sleeping threads and are not direct CPU percentages. "
                        "Use nativeId to correlate with an OS CPU sample."
                    ),
                }
            temporary = self.output_path.with_suffix(".json.tmp")
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump(report, handle, separators=(",", ":"), sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.output_path)
        except Exception:
            # Profiling must never crash or stall Reticulum during shutdown.
            return


def start_from_env(process_name: Optional[str] = None) -> Optional[PythonDiagnosticsProfiler]:
    global _active_profiler
    if str(os.environ.get("QORTAL_PYTHON_DIAGNOSTICS", "")).strip().lower() not in _ENABLED_VALUES:
        return None
    with _start_lock:
        if _active_profiler is not None:
            return _active_profiler
        name = process_name or os.environ.get("QORTAL_PYTHON_DIAGNOSTICS_PROCESS") or "python"
        output_raw = os.environ.get("QORTAL_PYTHON_DIAGNOSTICS_DIR") or os.getcwd()
        duration = _bounded_float(
            os.environ.get("QORTAL_PYTHON_DIAGNOSTICS_DURATION_SECONDS"), 60.0, 5.0, 600.0
        )
        interval_ms = _bounded_float(
            os.environ.get("QORTAL_PYTHON_DIAGNOSTICS_INTERVAL_MS"), 100.0, 20.0, 1000.0
        )
        profiler = PythonDiagnosticsProfiler(
            process_name=str(name),
            output_dir=Path(output_raw).expanduser(),
            duration_seconds=duration,
            interval_seconds=interval_ms / 1000.0,
        )
        try:
            profiler.start()
        except Exception:
            return None
        _active_profiler = profiler
        atexit.register(profiler.finish)
        return profiler
