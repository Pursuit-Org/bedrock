# Python installer security alignment

Scope: installation entry points and setup documentation only; dependency changes
are reviewed separately. The standalone MCP client needs Python 3.10+, while the
backend and Pebble need Python 3.11+ for their patched dependency stack.

- [x] Check the selected interpreter or existing virtual environment before installation.
- [x] Use the official hash-pinned pip bootstrap before downloading application packages.
- [x] Align root, backend and Pebble setup instructions.
- [x] Validate failure paths, bootstrap ordering, and shell syntax without network access.
- [ ] Complete independent Codex and Claude reviews and open the PR.

Validation: bash syntax and seven offline installer tests pass. The tests cover
unsupported host/venv Python, secure bootstrap ordering and failure containment.
No dependency manifests or application routes are changed by this PR.

Review corrections: setup commands stop if bootstrap fails, and backend guides
use the `.venv` selected first by dev.sh. Related entry-point messages link to the
secure setup instead of suggesting unbootstrapped installs. Root package metadata,
Docker and existing backend CI bootstraps are deliberately handled in the separate
dependency-security PR to avoid overlapping changes.

Further review fixes: preserve supported existing environments, avoid replacing
their interpreter configuration, preserve newer patched pip, and check each shell
script independently. A shared bootstrap helper is used by all documented setup
paths. The helper also passed against a real patched temporary virtual environment.
