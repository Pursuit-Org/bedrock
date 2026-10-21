"""Exercise installer control flow with fake interpreters and no downloads."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


FAKE_PYTHON = r'''
import json, os, pathlib, shutil, sys
args = sys.argv[1:]
is_venv = "venv" in pathlib.Path(sys.argv[0]).parts
with open(os.environ["INSTALL_LOG"], "a") as log:
    log.write(json.dumps(["venv" if is_venv else "host", args]) + "\n")
if args[0] == "-c":
    if "pip._vendor.packaging" in args[1]:
        if os.environ.get("PIP_CHECK_ERROR"):
            sys.exit(1)
        sys.exit(0 if os.environ.get("PATCHED_PIP") else 10)
    sys.exit(int(os.environ.get("BAD_VENV" if is_venv else "BAD_HOST", "0")))
if args[:2] == ["-m", "venv"]:
    target = pathlib.Path(args[2]) / "bin" / "python"
    target.parent.mkdir(parents=True)
    shutil.copy2(sys.argv[0], target)
if args[:3] == ["-m", "pip", "install"] and "pip @ " in args[-1]:
    sys.exit(int(os.environ.get("FAIL_BOOTSTRAP", "0")))
'''


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        shutil.copy2(Path(__file__).parents[1] / "install.sh", self.root / "scripts/install.sh")
        shutil.copy2(Path(__file__).parents[1] / "bootstrap-pip.sh", self.root / "scripts/bootstrap-pip.sh")
        (self.root / "bin").mkdir()
        self.python = self.root / "bin/python3"
        self.python.write_text(f"#!{sys.executable}\n" + FAKE_PYTHON)
        self.python.chmod(0o755)
        self.log = self.root / "install.log"

    def run_installer(self, **settings):
        env = {"PATH": f"{self.root / 'bin'}:/usr/bin:/bin", "INSTALL_LOG": str(self.log), **settings}
        result = subprocess.run(["/bin/bash", str(self.root / "scripts/install.sh")],
                                cwd="/tmp", env=env, capture_output=True, text=True, timeout=10)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        installs = [args for _, args in calls if args[:3] == ["-m", "pip", "install"]]
        return result, calls, installs

    def test_unsupported_host_fails_before_venv_or_download(self):
        result, _, installs = self.run_installer(BAD_HOST="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Python 3.10+", result.stdout)
        self.assertFalse((self.root / "venv").exists())
        self.assertEqual(installs, [])

    def test_unsupported_existing_venv_fails_before_download(self):
        target = self.root / "venv/bin/python"
        target.parent.mkdir(parents=True)
        shutil.copy2(self.python, target)
        result, _, installs = self.run_installer(BAD_VENV="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Existing venv", result.stdout)
        self.assertEqual(installs, [])

    def test_bootstrap_precedes_app_installs_and_uses_venv_python(self):
        result, calls, installs = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(installs), 3)
        self.assertIn("pip-26.2.2-py3-none-any.whl#sha256=fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70", installs[0][-1])
        self.assertEqual(installs[1][-2:], ["-r", "requirements.txt"])
        self.assertEqual(installs[2][-2:], ["-e", "."])
        self.assertTrue(all(interpreter == "venv" for interpreter, args in calls if args in installs))

    def test_failed_bootstrap_stops_before_application_install(self):
        result, _, installs = self.run_installer(FAIL_BOOTSTRAP="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(installs), 1)

    def test_existing_supported_venv_does_not_require_supported_host(self):
        target = self.root / "venv/bin/python"
        target.parent.mkdir(parents=True)
        shutil.copy2(self.python, target)
        result, calls, _ = self.run_installer(BAD_HOST="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(interpreter == "venv" for interpreter, _ in calls))

    def test_already_patched_pip_is_not_downgraded(self):
        result, _, installs = self.run_installer(PATCHED_PIP="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(installs), 2)
        self.assertEqual(installs[0][-2:], ["-r", "requirements.txt"])

    def test_unreadable_pip_version_fails_without_downgrading(self):
        result, _, installs = self.run_installer(PIP_CHECK_ERROR="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(installs, [])
        self.assertIn("leaving this environment unchanged", result.stdout)


if __name__ == "__main__":
    unittest.main()
