"""Avoid other test modules' global removal of production lifespan handlers."""

import os
from pathlib import Path
import subprocess
import sys


def test_real_application_lifespan_in_fresh_process():
    result = subprocess.run(
        [sys.executable, str(Path(__file__).with_name("startup_probe.py"))],
        env={"PATH": os.environ.get("PATH", ""), "JWT_SECRET_KEY": "ci-test-secret-not-for-production",
             "DATABASE_URL": "", "FRONTEND_URL": "http://localhost:4200"},
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Real startup, background scheduling, health and shutdown passed" in result.stdout
