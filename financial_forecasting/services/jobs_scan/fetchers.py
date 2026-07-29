"""Per-platform ATS board fetchers, normalized to one schema.

All endpoints are unauthenticated public JSON. One GET per company returns that
company's whole board, which is what makes the company the INPUT rather than
something reverse-engineered from search snippets.

Every fetcher returns list[ScannedRole]. Per-company failure raises FetchError;
the orchestrator records it and continues rather than killing the run.

Comp is resolved lazily: `fetch_board` returns roles with whatever comp the list
endpoint gave (often none), and `enrich_comp` fills the rest with a second
request per posting. Keep that split -- Greenhouse has no comp in its API at
all, so enriching a 414-role board costs 414 requests. Pre-filter first.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from .comp import CompResult, extract_comp, extract_greenhouse_pay_ranges

logger = logging.getLogger(__name__)

TIMEOUT = 25.0
USER_AGENT = "Mozilla/5.0 (compatible; pursuit-jobs-scan/1.0)"
HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}


class FetchError(Exception):
    """A board could not be fetched. Recorded per-company, never fatal."""


@dataclass
class ScannedRole:
    platform: str
    slug: str
    external_job_id: str
    title: Optional[str] = None
    location: Optional[str] = None
    is_remote: bool = False
    url: Optional[str] = None
    description: Optional[str] = None
    salary_min: Optional[int] = None
    salary_max: Optional[int] = None
    comp_source: str = "not_found"
    posted_at: Optional[datetime] = None
    raw: dict[str, Any] = field(default_factory=dict)

    def apply_comp(self, result: CompResult) -> None:
        if result.found:
            self.salary_min = result.min_amount
            self.salary_max = result.max_amount
            self.comp_source = result.source


def _strip_html(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    # Greenhouse double-escapes its content body; unescape twice before stripping.
    import html as _html

    text = _html.unescape(_html.unescape(value))
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip() or None


def _looks_remote(*values: Optional[str]) -> bool:
    return any("remote" in (v or "").lower() for v in values)


def _epoch_ms(value: Any) -> Optional[datetime]:
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def _iso(value: Any) -> Optional[datetime]:
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _get(client: httpx.Client, url: str, **kw) -> httpx.Response:
    try:
        return client.get(url, timeout=TIMEOUT, headers=HEADERS, **kw)
    except httpx.HTTPError as exc:
        raise FetchError(f"{type(exc).__name__}: {exc}") from exc


# ---------------------------------------------------------------------------
# Greenhouse
# ---------------------------------------------------------------------------
def fetch_greenhouse(client: httpx.Client, slug: str) -> list[ScannedRole]:
    # content=true is required for the JD body; comp is never in this response.
    r = _get(client, f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true")
    if r.status_code == 404:
        raise FetchError("board not found (404)")
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}")
    try:
        jobs = r.json().get("jobs") or []
    except ValueError as exc:
        raise FetchError("non-JSON response") from exc

    roles = []
    for job in jobs:
        loc = (job.get("location") or {}).get("name")
        offices = ", ".join(
            o.get("name", "") for o in (job.get("offices") or []) if o.get("name")
        )
        description = _strip_html(job.get("content"))
        role = ScannedRole(
            platform="greenhouse",
            slug=slug,
            external_job_id=str(job.get("id")),
            title=job.get("title"),
            location=loc or offices or None,
            is_remote=_looks_remote(loc, offices),
            url=job.get("absolute_url"),
            description=description,
            posted_at=_iso(job.get("updated_at")),
            raw=job,
        )
        # Fallback only; the structured page read in enrich_comp is better.
        role.apply_comp(extract_comp(description))
        roles.append(role)
    return roles


def _enrich_greenhouse(client: httpx.Client, role: ScannedRole) -> None:
    """Read Greenhouse's structured pay_ranges off the rendered job page."""
    url = f"https://job-boards.greenhouse.io/{role.slug}/jobs/{role.external_job_id}"
    try:
        r = _get(client, url, headers={"User-Agent": USER_AGENT})
    except FetchError:
        return
    if r.status_code != 200:
        return
    result = extract_greenhouse_pay_ranges(r.text)
    if result.found:
        role.apply_comp(result)


# ---------------------------------------------------------------------------
# Ashby
# ---------------------------------------------------------------------------
def fetch_ashby(client: httpx.Client, slug: str) -> list[ScannedRole]:
    r = _get(
        client,
        f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true",
    )
    # Some boards exist but don't expose the posting API. Fall back to the
    # rendered page rather than treating it as missing.
    if r.status_code in (400, 404):
        return _fetch_ashby_rendered(client, slug)
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}")
    try:
        jobs = r.json().get("jobs") or []
    except ValueError as exc:
        raise FetchError("non-JSON response") from exc

    roles = []
    for job in jobs:
        description = job.get("descriptionPlain") or _strip_html(job.get("descriptionHtml"))
        role = ScannedRole(
            platform="ashby",
            slug=slug,
            external_job_id=str(job.get("id")),
            title=job.get("title"),
            location=job.get("location"),
            is_remote=bool(job.get("isRemote")) or _looks_remote(job.get("location")),
            url=job.get("jobUrl"),
            description=description,
            posted_at=_iso(job.get("publishedAt")),
            raw=job,
        )
        comp = job.get("compensation") or {}
        summary = (
            comp.get("scrapeableCompensationSalarySummary")
            or comp.get("compensationTierSummary")
        )
        parsed = extract_comp(summary, source="api") if summary else CompResult()
        role.apply_comp(parsed if parsed.found else extract_comp(description))
        roles.append(role)
    return roles


def _fetch_ashby_rendered(client: httpx.Client, slug: str) -> list[ScannedRole]:
    """Parse window.__appData off the rendered board when the API 404s."""
    r = _get(client, f"https://jobs.ashbyhq.com/{slug}",
             headers={"User-Agent": USER_AGENT})
    if r.status_code != 200:
        raise FetchError(f"board not found (rendered HTTP {r.status_code})")

    marker = "window.__appData = "
    idx = r.text.find(marker)
    if idx == -1:
        raise FetchError("board not found (no __appData)")
    try:
        data, _ = json.JSONDecoder().raw_decode(r.text[idx + len(marker):])
    except ValueError as exc:
        raise FetchError("could not decode __appData") from exc

    postings = (data.get("jobBoard") or {}).get("jobPostings") or []
    roles = []
    for job in postings:
        job_id = str(job.get("id") or job.get("extId") or "")
        if not job_id:
            continue
        roles.append(ScannedRole(
            platform="ashby",
            slug=slug,
            external_job_id=job_id,
            title=job.get("title"),
            location=job.get("locationName") or job.get("secondaryLocations"),
            is_remote=bool(job.get("isRemote")),
            url=f"https://jobs.ashbyhq.com/{slug}/{job_id}",
            # NOTE: this index carries no JD text. enrich_comp fetches it, and
            # the playbook's 65-of-259 empty-description bug came from skipping
            # that step -- so never treat a rendered-path role as complete.
            description=None,
            raw=job,
        ))
    return roles


def _enrich_ashby(client: httpx.Client, role: ScannedRole) -> None:
    """Read JSON-LD off an Ashby posting page for comp and description."""
    try:
        r = _get(client, f"https://jobs.ashbyhq.com/{role.slug}/{role.external_job_id}",
                 headers={"User-Agent": USER_AGENT})
    except FetchError:
        return
    if r.status_code != 200:
        return

    m = re.search(
        r'<script type="application/ld\+json">(.*?)</script>', r.text, re.S
    )
    if not m:
        return
    try:
        ld = json.loads(m.group(1))
    except ValueError:
        return

    if not role.description:
        role.description = _strip_html(ld.get("description"))

    salary = (ld.get("baseSalary") or {}).get("value") or {}
    # Only trust structured comp when it is explicitly annual.
    if str(salary.get("unitText", "")).upper() == "YEAR":
        lo, hi = salary.get("minValue"), salary.get("maxValue")
        try:
            lo_i = int(lo) if lo else None
            hi_i = int(hi) if hi else None
        except (TypeError, ValueError):
            lo_i = hi_i = None
        if lo_i and lo_i >= 1000:
            role.apply_comp(CompResult(lo_i, hi_i or lo_i, "ashby_jsonld"))
            return
    if not role.salary_min:
        role.apply_comp(extract_comp(role.description))


# ---------------------------------------------------------------------------
# Lever
# ---------------------------------------------------------------------------
def fetch_lever(client: httpx.Client, slug: str) -> list[ScannedRole]:
    # slug is stored pre-encoded; Lever slugs may contain spaces ("Loop%20AI").
    r = _get(client, f"https://api.lever.co/v0/postings/{slug}?mode=json")
    if r.status_code in (400, 404):
        raise FetchError("board not found")
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}")
    try:
        payload = r.json()
    except ValueError as exc:
        raise FetchError("non-JSON response") from exc
    # Lever returns a bare array. Anything else means "not a Lever board".
    if not isinstance(payload, list):
        raise FetchError("not a Lever board (non-list response)")

    roles = []
    for job in payload:
        categories = job.get("categories") or {}
        location = categories.get("location")
        commitment = categories.get("commitment")
        description = " ".join(
            p for p in (job.get("descriptionPlain"), job.get("additionalPlain")) if p
        ) or None
        role = ScannedRole(
            platform="lever",
            slug=slug,
            external_job_id=str(job.get("id")),
            title=job.get("text"),
            location=location,
            is_remote=(str(job.get("workplaceType", "")).lower() == "remote")
                      or _looks_remote(location, commitment),
            url=job.get("hostedUrl"),
            description=description,
            posted_at=_epoch_ms(job.get("createdAt")),
            raw=job,
        )
        salary = job.get("salaryRange") or {}
        lo, hi = salary.get("min"), salary.get("max")
        if lo or hi:
            try:
                role.apply_comp(CompResult(int(lo) if lo else None,
                                           int(hi) if hi else None, "api"))
            except (TypeError, ValueError):
                pass
        if not role.salary_min:
            role.apply_comp(extract_comp(description))
        roles.append(role)
    return roles


# ---------------------------------------------------------------------------
# Gem
# ---------------------------------------------------------------------------
_GEM_URL = "https://jobs.gem.com/api/public/graphql/batch"

# The server validates operationName against a hardcoded allowlist. Renaming
# either query -- or attempting introspection -- returns a generic error, so
# these two names must stay exactly as-is. Field selections inside them are free.
_GEM_LIST_QUERY = """query JobBoardList($boardId: String!) {
  oatsExternalJobPostings(boardId: $boardId) {
    jobPostings {
      id extId title
      locations { id name city isoCountry isRemote extId }
      job { id locationType employmentType }
    }
  }
}"""

_GEM_DETAIL_QUERY = """query ExternalJobPostingQuery($boardId: String!, $extId: String!) {
  oatsExternalJobPosting(boardId: $boardId, extId: $extId) {
    id title descriptionHtml extId startDateTs firstPublishedTsSec
    locations { name city isoCountry isRemote }
    job { locationType employmentType }
    jobPostSectionHtml { introHtml outroHtml }
    compensationHtml
  }
}"""


def _gem_post(client: httpx.Client, operation: str, query: str, variables: dict) -> dict:
    # The body must be a JSON array of operations even for a single operation.
    body = [{"operationName": operation, "query": query, "variables": variables}]
    try:
        r = client.post(_GEM_URL, json=body, timeout=TIMEOUT,
                        headers={"User-Agent": USER_AGENT,
                                 "Content-Type": "application/json"})
    except httpx.HTTPError as exc:
        raise FetchError(f"{type(exc).__name__}: {exc}") from exc
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}")
    try:
        payload = r.json()
    except ValueError as exc:
        raise FetchError("non-JSON response") from exc
    entry = payload[0] if isinstance(payload, list) and payload else payload
    if not isinstance(entry, dict) or entry.get("errors"):
        raise FetchError(f"gem error: {str(entry)[:160]}")
    return entry.get("data") or {}


def fetch_gem(client: httpx.Client, slug: str) -> list[ScannedRole]:
    data = _gem_post(client, "JobBoardList", _GEM_LIST_QUERY, {"boardId": slug})
    postings = ((data.get("oatsExternalJobPostings") or {}).get("jobPostings")) or []

    roles = []
    for job in postings:
        ext_id = str(job.get("extId") or job.get("id") or "")
        if not ext_id:
            continue
        locations = job.get("locations") or []
        loc_name = ", ".join(l.get("name", "") for l in locations if l.get("name")) or None
        job_meta = job.get("job") or {}
        roles.append(ScannedRole(
            platform="gem",
            slug=slug,
            external_job_id=ext_id,
            title=job.get("title"),
            location=loc_name,
            is_remote=any(l.get("isRemote") for l in locations)
                      or str(job_meta.get("locationType", "")).upper() == "REMOTE",
            url=f"https://jobs.gem.com/{slug}/{ext_id}",
            raw=job,
        ))
    return roles


def _enrich_gem(client: httpx.Client, role: ScannedRole) -> None:
    """Gem's list response carries no comp or JD; the detail call has both."""
    try:
        data = _gem_post(client, "ExternalJobPostingQuery", _GEM_DETAIL_QUERY,
                         {"boardId": role.slug, "extId": role.external_job_id})
    except FetchError:
        return
    posting = data.get("oatsExternalJobPosting") or {}
    if not posting:
        return

    sections = posting.get("jobPostSectionHtml") or {}
    role.description = _strip_html(" ".join(filter(None, [
        sections.get("introHtml"), posting.get("descriptionHtml"),
        sections.get("outroHtml"),
    ]))) or role.description
    role.raw = {**role.raw, "detail": posting}

    comp_text = _strip_html(posting.get("compensationHtml"))
    parsed = extract_comp(comp_text) if comp_text else CompResult()
    role.apply_comp(parsed if parsed.found else extract_comp(role.description))


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------
FETCHERS = {
    "greenhouse": fetch_greenhouse,
    "ashby": fetch_ashby,
    "lever": fetch_lever,
    "gem": fetch_gem,
}

ENRICHERS = {
    "greenhouse": _enrich_greenhouse,
    "ashby": _enrich_ashby,
    "gem": _enrich_gem,
    # Lever ships comp and JD in its list response; nothing more to fetch.
    "lever": None,
}


def fetch_board(client: httpx.Client, platform: str, slug: str) -> list[ScannedRole]:
    fetcher = FETCHERS.get(platform)
    if fetcher is None:
        raise FetchError(f"no fetcher for platform {platform!r}")
    return fetcher(client, slug)


def enrich_comp(client: httpx.Client, role: ScannedRole) -> None:
    """Second-pass fetch for comp and JD text. Call ONLY on pre-filter survivors."""
    enricher = ENRICHERS.get(role.platform)
    if enricher is not None:
        enricher(client, role)
