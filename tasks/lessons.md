# Lessons Learned

> Updated after every correction or mistake. Patterns to avoid repeating.
> Review at session start.

## 2026-10-20 — PRO-110 Thursday Pipeline (2 lessons)

1. **The local dev backend reads prod with a read-only login that can't run `builder_by_id`.** Anything that calls `_funnel_milestones` (or `INTERVIEW_APPLICATIONS_SQL`) 500s locally, even though prod works. The backend's output goes to a pipe owned by an earlier session, so `/tmp/bedrock-backend.log` is empty. **Rule**: to see a route's real error, call the route function from a script in the WSL clone (`.venv/bin/python`, `await db.init_db()`, then the handler with a pool connection). Nothing can be written from the browser locally; don't plan a browser test that saves.

2. **A gated stage change must reject with `Error("Stage change cancelled")`, not resolve.** `InlineSelect` keeps an optimistic value after a resolved save, so the cell showed "Closed — Lost" behind the reason modal and after Cancel. A rejection with that exact message clears the value silently. **Rule**: when a picker hands a change to a modal, reject with that message, and check the cell after Cancel in the browser.

## 2026-10-20 — PRO-106 Monday Outreach (2 lessons)

1. **Copying into the served clone with `sed … > file` can leave Vite caching an empty module.** The redirect truncates the file first; Vite's watcher fired on the empty file, cached an empty transform under its `?t=` stamp, and the Pipeline tab went blank ("does not provide an export named jobsAccountPath") even after the file was whole again. **Rule**: write to a temp file and `mv` it into place, then confirm the served size (`curl -s localhost:4200/src/<file> | wc -c`) for every copied file before opening the browser.

2. **Check whether the field a view groups by is actually filled before building on it.** The plan grouped "where outreach is stuck" by the pipeline (membership) owner, but only 7 of 117 Operation 35 memberships had one; 115 contacts had a contact owner. One count query before writing the endpoint would have shown it. **Rule**: before grouping or filtering a new view by a column, count how often it's filled on prod for the records the view covers.

## 2026-10-20 — PRO-105 info icons (2 lessons)

1. **Starting the WSL dev servers from Claude Code: `./dev.sh` dies with the session, and `bash -lc` finds Windows `npm`.** `wsl -e bash -lc "./dev.sh"` returned "started", but its `nohup` children were killed when that `wsl` call exited, so nothing listened on :8000 or :4200. Under `-lc` (no nvm) `npm` resolved to the Windows one through the inherited PATH and failed on the UNC path. **Rule**: run each server as its own long-lived background command, `wsl.exe -e bash -ic "cd … && exec .venv/bin/python main.py"` and `wsl.exe -e bash -ic "cd …/frontend-v2 && exec npx vite --host 0.0.0.0 --port 4200"`, then confirm with `curl` before opening the browser.

2. **Two files whose names differ only in case clash on Windows.** `MetricInfo.tsx` and `metricInfo.ts` in one folder made `tsc` report the module as the same file. **Rule**: name a component's pure helper module differently, not by case (`metricInfoText.ts`).

## 2026-10-14 — Mockup tab (1 lesson)

1. **The dev server on :4200 runs from a WSL clone, not the Windows checkout.** I edited `C:\Users\XX\dev\bedrock` and called it done once :4200 answered, but the server (`vite`) runs in WSL from `/home/nqpursuit/dev/bedrock`. Nina loaded the tab and nothing had changed. A 200 from Vite proved nothing either: an unknown path also returns 200, the SPA fallback. **Rule**: before saying a frontend change is live, find the process on the port (`Get-NetTCPConnection -LocalPort 4200` → `wslrelay.exe` means WSL; then `readlink /proc/<vite pid>/cwd`) and confirm the served module contains the change (`curl localhost:4200/src/<file> | grep <new symbol>`). Edit in the clone that is actually served, or copy the files there when both clones are on the same branch and commit with a clean tree.

## 2026-10-07 — PRO-98 follow-up (1 lesson)

1. **When an answer covers more than one open question, apply it to all of them.** Nina answered "Keep everyone in the settings so that history does not shift." That decided both open items: keep history, AND keep everyone (Damon included) on the team. I applied it only to history and asked again about Damon, so she had to repeat herself. **Rule**: before re-asking, re-read the person's last answers against every open question; if the answer is plausibly already there, state the reading back ("I'm taking that as: Damon stays on") instead of asking.

## 2026-10-06 — PRO-98 outreach counting (2 lessons)

1. **Never cut a row into one-per-key when exporting fixtures for logic that dedups.** The anonymized fixture kept the earliest event per (account, sender) as `ARRAY[company]`, so one email that reached two accounts became two rows with one identity. The rules' cross-mailbox dedup kept one and silently erased the other account's history: calendar week pinned 20 accounts activated where the data says 15. Caught only because a second, independent implementation (`outreach_counting.reference_sql()` run on production) disagreed. **Rule**: export whole events with every field the rules read; when a pinned number comes from a fixture, cross-check it once against a query on the real data before trusting the pin.

2. **Before reproducing an audit's numbers, vary the window boundaries first.** The 9/30 audit was described as "New York time" but only reproduced on UTC day boundaries (the app's own date handling then). Ten minutes of guessing at filters would have been saved by trying UTC vs NY first. **Rule**: when a reference number won't reproduce, check timezone and inclusive/exclusive window edges before touching the definition.

## 2026-04-16 — F1 buckets + Intacct kill switch (2 lessons)

1. **Prefer env vars + `os.getenv` over a `config.py` indirection module.** When adding a feature flag (e.g., `INTACCT_AUTO_INVOICE_ENABLED`) in PR #135, my first draft added it to `financial_forecasting/config.py`. Turned out: (a) `config.py` is intentionally gitignored (legacy credentials file), (b) the only real consumer was `routes/auth.py` for Salesforce OAuth app creds — 8 call sites easily swapped to `os.getenv`. JP's call: retire `config.py` entirely, don't perpetuate the indirection. **Rule**: for any new backend config value, read env directly via a call-time helper (`def _flag_enabled() -> bool: return os.getenv(...).strip().lower() == "true"`). Tests flip with `monkeypatch.setenv` — standard pytest, no module-attr monkeypatching. Keep `.gitignore`'s `config.py` line as a safety net with a comment explaining the retirement, so a future contributor with old muscle memory can't accidentally re-introduce secrets-in-source.

2. **`MagicMock()` does NOT auto-bridge private attr to public property.** `tests/conftest.py:326` set `client._connected_services = {...}` for ~six months; production `UnifiedMCPClient.connected_services` is a `@property` wrapping `self._connected_services.copy()`. In the mock, `client.connected_services` returned an auto-generated child MagicMock whose `__contains__` defaults to False — silently short-circuiting 15 tests at `data_sync.py:29` `"sage_intacct" in self.mcp_client.connected_services`. Verification trick: `python3 -c "from unittest.mock import MagicMock; m=MagicMock(); print('x' in m.foo)"` returns False, not True. **Rule**: when a mock fixture stands in for a class with `@property` accessors, set BOTH the public attr AND any private backing attr — MagicMock doesn't invoke property descriptors. And when test assertions expect a code path to execute but it silently doesn't, first suspect is always the mock fixture disagreeing with the real class's attr shape.

## 2026-04-15 — Pipeline Flow rework (4 lessons)

1. **Don't propose superset/approximate compromises for user-facing analysis.** My original Pipeline Flow plan said "for custom date ranges, the AI Analyze endpoint sees a wider window than the overlay — acceptable compromise, note with a code comment, defer proper fix." JP rejected it: "enable Analyze to work with any selection of Users or other filters on." The right move was to extend the backend endpoint to accept `start`/`end` explicitly, not paper over the semantic gap. **Rule**: when the on-screen number and the AI's input to an explanation of that number aren't the same, that's a bug, not a compromise — fix the backend.

2. **Regex-validated inputs let you interpolate into SOQL safely without escaping.** Follows the existing `validate_salesforce_id` / `_SF_ID_PATTERN` pattern at `security.py:8`. For dates: `re.compile(r'^\d{4}-\d{2}-\d{2}$')` — digits and hyphen only, no quote, no whitespace, no wildcard, no SOQL keyword. Constructing `CreatedDate >= {start}T00:00:00Z` is then injection-safe. **Document the discipline in the comment** at the interpolation site so reviewers can audit. Don't reach for `escape_soql_string` when the regex has already excluded every SOQL-breaking character — escaping would add noise without adding safety.

3. **React hooks' `useEffect` with deps on a later-declared `useMemo` triggers a TDZ error.** `useEffect(cb, [ownerProgress])` where `ownerProgress` is `const ownerProgress = useMemo(...)` below — the deps array is evaluated immediately during render, before the memo's `const` binding exists. Fix: move the `useEffect` below the memo. Don't try to work around with refs or initial-render guards; just reorder.

4. **SF datetime string `"2026-04-01T10:00:00.000+0000"` ≠ JS `toISOString()` `"…Z"` under lexical compare.** When client-filtering a SF `CreatedDate` range, `parseISO(h.CreatedDate).getTime()` vs `rangeStart.getTime()` — always parse both sides to `Date`, never compare as strings. Learned from the `history.filter` in `PipelineFunnel.tsx`.

## 2026-03-26 — M7 Projects QA (2 bugs)

1. **useEffect dependency arrays: don't include both a list and a selected-item.** If a useEffect validates `selectedId` against `items[]`, and depends on `[items, selectedId]`, it fires when `selectedId` changes — but `items` may be stale (async refetch in flight). The effect sees the new ID isn't in the old list and resets selection. Fix: use functional updater in setState to read latest state, depend only on `[items]`.

2. **Salesforce API returns PascalCase keys.** The `globalSearch` endpoint returns `{Opportunity: [], Contact: [], Account: [], Task: []}`. Always use PascalCase when accessing these — don't guess lowercase. `GlobalSearch.tsx` does this correctly; new code should match its pattern, not invent a new one.

## 2026-03-25 — GCal Calendar Fix (3 layered bugs)

1. **Don't gate data fetches on UI collapse state.** The calendar `useQuery` had `enabled: !prefs.collapsed['calendar']`, but the desktop layout (CalendarInboxSplit) has its own resizable-panel collapse that's independent of `prefs.collapsed['calendar']`. Result: user sees the calendar panel but data never loads. Fix: removed the `enabled` gate — always fetch, staleTime handles frequency.

2. **Set `expiry` on `google.oauth2.credentials.Credentials`.** Without it, `creds.expired` is always `False` and proactive token refresh never fires. The `expires_at` unix timestamp from Authlib must be converted to a **naive UTC datetime** (`datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None)`) because google-auth's `_helpers.utcnow()` returns naive. Timezone-aware expiry raises `TypeError`.

3. **Don't return HTTP 500 for calendar errors.** React-query sees 500 → `calResponse` is `undefined` → no error shown. Return structured JSON `{data:[], error:"..."}` so the frontend can display it. Separate `calNeedsReauth` (token expired) from `calErrorMsg` (general error) in the frontend.

## 2026-03-18 — Production-Grade Security MVP

- **JWT and Fernet**: Both must derive from the same `JWT_SECRET_KEY`. Define it once early (after load_dotenv), use everywhere.
- **Production secret**: When `FRONTEND_URL` starts with `https`, fail fast if `JWT_SECRET_KEY` is missing or < 32 chars.
- **Dev bypass**: REMOVED 2026-04-08. The `REACT_APP_DEV_BYPASS` branch in `AuthContext.tsx` was stripped entirely. Multi-layer guards (REACT_APP env var + localhost runtime check + NODE_ENV !== 'production') were structurally safe but added attack surface for no real benefit. All environments now require real Google OAuth — local dev included.
- **Calendar**: Restrict to PBD server-side; reject `primary` and arbitrary calendar IDs. Surface re-auth UX when tokens expire.

