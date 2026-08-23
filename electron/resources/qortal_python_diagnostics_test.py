import json
import tempfile
import threading
import time
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


if __name__ == "__main__":
    unittest.main()
