#!/bin/bash
# Refresh pip's vendored trust store without downgrading a newer patched pip.
set -euo pipefail

python_executable="${1:-python}"
if ! "$python_executable" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  echo "Python 3.10+ is required for the patched pip bootstrap."
  exit 1
fi

if "$python_executable" -c 'from importlib.metadata import version; from pip._vendor.packaging.version import Version; raise SystemExit(10 if Version(version("pip")) < Version("26.2.2") else 0)'; then
  echo "pip already has the patched trust store (26.2.2 or newer)."
else
  check_status=$?
  if [ "$check_status" -ne 10 ]; then
    echo "Unable to check pip's version; leaving this environment unchanged."
    exit "$check_status"
  fi
  # Official Python security guidance pins both the wheel URL and SHA256 hash.
  "$python_executable" -m pip install "pip @ https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/pip-26.2.2-py3-none-any.whl#sha256=fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"
fi
