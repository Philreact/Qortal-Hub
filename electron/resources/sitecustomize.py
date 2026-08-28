"""Early opt-in diagnostics hook for script-based Reticulum runtimes."""

import os

if str(os.environ.get("QORTAL_PYTHON_DIAGNOSTICS", "")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}:
    try:
        from qortal_python_diagnostics import start_from_env

        start_from_env()
    except Exception:
        # sitecustomize must never prevent Python or Reticulum from starting.
        pass
