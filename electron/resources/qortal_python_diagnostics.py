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

    def finish(self) -> None:
        with self._lock:
            if self._finished:
                return
            self._finished = True
        self._stop.set()
        if threading.Thread.start is self._thread_start_wrapper:
            threading.Thread.start = self._original_thread_start  # type: ignore[assignment]
        self._write_report()

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
