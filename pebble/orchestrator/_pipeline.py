"""Orchestrator: pipeline stages, ProspectBudgetTracker.

Decomposition pattern:
    The orchestrator breaks complex prospect research into tier-appropriate tasks:
    - Complex work → decompose into narrow sub-tasks → dispatch to Workers
    - Domain analysis across sources → dispatch to Foragers
    - Synthesis of pre-processed claims → dispatch to Queen
    - The quorum verifiers are the canonical example: one complex "verify everything"
      task → three narrow single-lens tasks (source credibility, consistency, cross-ref)

    When adding new tasks, match complexity to tier:
    - WORKER: single data source extraction (api_response_extractor is a known exception
      with 2 sources — ProPublica + SEC — because extraction across two related sources
      is simpler than analysis)
    - FORAGER: multi-source domain analysis (wealth_indicator, philanthropy)
    - QUEEN: synthesis of pre-processed claims only
"""

import asyncio
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Callable

from ..model_client import ModelClient
from ..harness import WorkerHarness, HarnessConfig, AgentOutcome, TaskSpec, harness_config_for_agent
from ..storage.db import log_harness_outcome, get_source_reliability, save_profile, save_source_scores, save_session
from ..data_sources import (
    fetch_organization,
    search_organizations,
    fetch_company,
    search_contributions,
    search_filings,
    search_awards,
    fetch_full_profile,
    search_officers,
)
from ..data_sources.sec import search_cik
from ..claim_templates import (
    claims_from_fec,
    claims_from_usaspending,
    claims_from_opencorporates,
    claims_from_edgar_search,
    claims_from_wikipedia_infobox,
)

logger = logging.getLogger("pebble.orchestrator")

PROSPECT_COST_CAP_USD = 0.50

# Strip markdown fences that LLMs sometimes wrap around JSON
_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)

# Claim ranking constants
_ORIGIN_RANK = {"forager": 0, "llm_extracted": 1, "template": 2}
_CONFIDENCE_RANK = {"high": 0, "medium": 1, "low": 2}
_DOLLAR_RE = re.compile(r"\$[\d,]+\.?\d*")


def _strip_fences(text: str) -> str:
    """Remove markdown code fences wrapping JSON output."""
    m = _FENCE_RE.match(text.strip())
    return m.group(1) if m else text


def _extract_dollar_amount(claim: dict) -> float:
    """Extract dollar amount from claim text for ranking FEC contributions."""
    m = _DOLLAR_RE.search(claim.get("text", ""))
    return float(m.group().replace("$", "").replace(",", "")) if m else 0.0


def _rank_claims(claims: list[dict]) -> list[dict]:
    """Rank claims so the most valuable survive truncation.

    Ranking rules:
    - Origin priority: forager (0) > llm_extracted (1) > template (2)
    - Within same origin: high confidence > medium > low
    - FEC template dedup: keep only the 3 largest contributions by dollar amount
    """
    fec = [c for c in claims if c.get("origin") == "template" and "contributed $" in c.get("text", "")]
    non_fec = [c for c in claims if c not in fec]
    fec_top = sorted(fec, key=_extract_dollar_amount, reverse=True)[:3]
    combined = non_fec + fec_top
    combined.sort(key=lambda c: (
        _ORIGIN_RANK.get(c.get("origin", "template"), 2),
        _CONFIDENCE_RANK.get(c.get("confidence", "medium"), 1),
    ))
    return combined


def _safe_truncate(records, max_chars: int = 2000) -> str:
    """Serialize records individually, stop when byte limit reached."""
    parts = []
    total = 2  # for "[]"
    items = records if isinstance(records, list) else [records]
    for r in items:
        s = json.dumps(r)
        if total + len(s) + 2 > max_chars:
            break
        parts.append(s)
        total += len(s) + 2
    return "[" + ", ".join(parts) + "]"


@dataclass
class ProspectBudgetTracker:
    """Sum costs per prospect; abort if cap exceeded."""

    prospect_id: str
    total_cost_usd: float = 0.0
    cap_usd: float = PROSPECT_COST_CAP_USD

    def add(self, cost_usd: float) -> None:
        self.total_cost_usd += cost_usd

    def would_exceed(self, additional_cost_usd: float) -> bool:
        return self.total_cost_usd + additional_cost_usd > self.cap_usd

    def exceeded(self) -> bool:
        return self.total_cost_usd > self.cap_usd


async def _log_result(result, agent_name: str, prospect_id: str | None = None, user_email: str | None = None) -> None:
    """Log harness outcome to harness_log."""
    await log_harness_outcome(
        agent_name=agent_name,
        outcome=result.outcome.value,
        cost_usd=result.cost_usd if result.outcome == AgentOutcome.SUCCESS else None,
        tokens_input=result.tokens_used.get("input", 0),
        tokens_output=result.tokens_used.get("output", 0),
        attempts=result.attempts,
        elapsed_seconds=result.elapsed_seconds,
        error=result.error,
        prospect_id=prospect_id,
        user_email=user_email,
    )


async def stage1_enrich_prospect(
    prospect: dict,
    structured_claims: list[dict],
    propublica_data: dict | None,
    sec_data: dict | None,
    client: ModelClient,
    budget: ProspectBudgetTracker,
) -> dict:
    """
    Stage 1: Merge structured claims (from templates) with LLM-extracted claims.
    Only sends ProPublica + SEC data to Haiku for extraction; structured data skips LLM.
    """
    if budget.exceeded():
        return {"prospect_id": prospect["id"], "claims": structured_claims, "partial": True, "failed_agents": ["budget_exceeded"]}

    # If no ProPublica/SEC data, skip LLM entirely — return just structured claims
    if not propublica_data and not sec_data:
        return {"prospect_id": prospect["id"], "claims": structured_claims}

    # Build context for Haiku extraction of ProPublica + SEC only
    context_parts = []
    sources = []

    if propublica_data:
        org = propublica_data.get("organization", {})
        context_parts.append(f"ProPublica 990: {_safe_truncate(org)}")
        sources.append("https://projects.propublica.org/nonprofits/organizations/" + str(org.get("ein", "")))

    if sec_data:
        context_parts.append(f"SEC: {_safe_truncate(sec_data)}")
        sources.append("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=" + str(sec_data.get("cik", "")))

    harness = WorkerHarness("api_response_extractor", harness_config_for_agent("api_response_extractor"), client)
    spec = TaskSpec(
        agent_name="api_response_extractor",
        data={"prospect": prospect, "context_parts": context_parts},
        source_urls=sources,
    )
    result = await asyncio.to_thread(harness.execute_task, spec)

    await _log_result(result, "api_response_extractor", prospect["id"])

    llm_claims = []
    if result.outcome in (AgentOutcome.SUCCESS, AgentOutcome.ESCALATED):
        budget.add(result.cost_usd)
        try:
            raw = _strip_fences(result.data.get("content", "{}"))
            data = json.loads(raw)
            llm_claims = data.get("claims", [])
            for c in llm_claims:
                if isinstance(c, dict):
                    c["origin"] = "llm_extracted"
        except json.JSONDecodeError:
            logger.warning("Failed to parse LLM claims for %s", prospect["id"])

    # Merge: structured claims first (higher reliability), then LLM-extracted
    all_claims = list(structured_claims) + [c for c in llm_claims if isinstance(c, dict) and c.get("source_url")]

    failed = []
    if result.outcome not in (AgentOutcome.SUCCESS, AgentOutcome.ESCALATED):
        failed.append("api_response_extractor")

    return {
        "prospect_id": prospect["id"],
        "claims": all_claims,
        "partial": bool(failed),
        "failed_agents": failed,
    }



def stage2_score(prospects: list[dict], amount: float = 0, probability: float = 50) -> float:
    """Stage 2: Quick-score formula. amount x (probability/100) x size_factor."""
    if amount <= 0:
        return 0.0
    import math
    size_factor = 1 + math.log10(1 + amount / 1_000_000)
    return amount * (probability / 100) * size_factor



async def score_source_richness(
    propublica_data: dict | None,
    sec_data: dict | None,
    fec_data: list | None,
    edgar_data: list | None,
    usa_data: list | None,
    wiki_data: dict | None,
    oc_data: list | None,
    *,
    lda_data: list | None = None,
    finra_data: list | None = None,
    federal_register_data: list | None = None,
    fec_committees_data: list | None = None,
    insider_data: list | None = None,
) -> dict[str, float]:
    """Scout-Recruit: score each source's data richness (waggle dance). Pure Python, no LLM."""
    scores: dict[str, float] = {}

    # ProPublica: full org with filings = 1.0, org found = 0.5, None = 0.0
    if propublica_data:
        org = propublica_data.get("organization", {})
        scores["propublica"] = 1.0 if org.get("filings_with_data", 0) > 0 else 0.5
    else:
        scores["propublica"] = 0.0

    # SEC: company with filings = 1.0, company found = 0.5, None = 0.0
    if sec_data:
        filings = sec_data.get("filings", sec_data.get("recent", {}))
        scores["sec"] = 1.0 if filings else 0.5
    else:
        scores["sec"] = 0.0

    # List-based sources: min(1.0, len(results) / 5)
    scores["fec"] = min(1.0, len(fec_data) / 5) if fec_data else 0.0
    scores["edgar"] = min(1.0, len(edgar_data) / 5) if edgar_data else 0.0
    scores["usaspending"] = min(1.0, len(usa_data) / 5) if usa_data else 0.0
    scores["opencorporates"] = min(1.0, len(oc_data) / 5) if oc_data else 0.0

    # Wikipedia: 1.0 if extract > 200 chars, 0.5 if shorter, 0.0 if None
    if wiki_data:
        extract = wiki_data.get("extract", "") if isinstance(wiki_data, dict) else ""
        scores["wikipedia"] = 1.0 if len(extract) > 200 else (0.5 if extract else 0.0)
    else:
        scores["wikipedia"] = 0.0

    # New sources (Stage B)
    scores["lda"] = min(1.0, len(lda_data) / 3) if lda_data else 0.0
    scores["finra"] = min(1.0, len(finra_data) / 2) if finra_data else 0.0
    scores["federal_register"] = min(1.0, len(federal_register_data) / 3) if federal_register_data else 0.0
    scores["fec_committees"] = min(1.0, len(fec_committees_data) / 2) if fec_committees_data else 0.0
    scores["insider_transactions"] = min(1.0, len(insider_data) / 2) if insider_data else 0.0

    # Pheromone adjustment: dampen unreliable sources, boost reliable ones.
    # Sources that consistently fail (e.g., OpenCorporates 401s) get dampened toward 0.
    # Sources with high verification pass rates stay at full strength.
    for source_name in scores:
        reliability = await get_source_reliability(source_name)
        scores[source_name] *= reliability

    return scores


async def activate_foragers(
    source_scores: dict[str, float],
    data_results: dict,
    prospect: dict,
    client: ModelClient,
    budget: ProspectBudgetTracker,
    prospect_type: str = "",
) -> list[dict]:
    """Division of Labor: activate specialist FORAGER agents when their signal threshold is met.

    Thresholds are adjusted based on prospect_type:
    - CORPORATE: lower wealth threshold (1.5 → 1.0) — wealth signals are core
    - FOUNDATION/NONPROFIT: lower philanthropy threshold (0.5 → 0.3) — org financials are core
    - GOVERNMENT: factor in LDA + Federal Register scores for influence assessment
    """
    forager_claims: list[dict] = []

    wealth_score = source_scores.get("fec", 0) + source_scores.get("opencorporates", 0) + source_scores.get("usaspending", 0)
    philanthropy_score = source_scores.get("propublica", 0) + source_scores.get("edgar", 0) + source_scores.get("wikipedia", 0)

    # Prospect-type-specific threshold adjustments
    wealth_threshold = 1.5
    philanthropy_threshold = 0.5

    if prospect_type == "corporate":
        wealth_threshold = 1.0
        # Also factor in FINRA and insider transaction signals
        wealth_score += source_scores.get("finra", 0) + source_scores.get("insider_transactions", 0)
    elif prospect_type in ("foundation", "nonprofit", "academic"):
        philanthropy_threshold = 0.3
    elif prospect_type == "government":
        # LDA + Federal Register boost the wealth score for influence assessment
        wealth_score += source_scores.get("lda", 0) + source_scores.get("federal_register", 0)
        wealth_threshold = 1.0

    tasks = []

    # Wealth indicator: fires when financial signals >= threshold
    if wealth_score >= wealth_threshold and not budget.exceeded():
        source_urls = []
        if data_results.get("fec_data"):
            source_urls.append("https://api.open.fec.gov/")
        if data_results.get("oc_data"):
            source_urls.append("https://api.opencorporates.com/")
        if data_results.get("usa_data"):
            source_urls.append("https://api.usaspending.gov/")

        spec = TaskSpec(
            agent_name="wealth_indicator_agent",
            data={
                "prospect": prospect,
                "fec_data": data_results.get("fec_data", []),
                "oc_data": data_results.get("oc_data", []),
                "usa_data": data_results.get("usa_data", []),
            },
            source_urls=source_urls,
        )
        tasks.append(("wealth_indicator_agent", spec))

    # Philanthropy: fires when nonprofit signals >= threshold
    # (adjusted per prospect type — lower for foundations/nonprofits)
    if philanthropy_score >= philanthropy_threshold and not budget.exceeded():
        source_urls = []
        if data_results.get("propublica_data"):
            ein = data_results["propublica_data"].get("organization", {}).get("ein", "")
            source_urls.append(f"https://projects.propublica.org/nonprofits/organizations/{ein}")
        if data_results.get("edgar_data"):
            source_urls.append("https://efts.sec.gov/LATEST/search-index")
        if data_results.get("wiki_data"):
            name = f"{prospect.get('first_name', '')}_{prospect.get('last_name', '')}".strip("_")
            source_urls.append(f"https://en.wikipedia.org/wiki/{name}")

        # Build enriched wiki context for philanthropy agent
        wiki_raw = data_results.get("wiki_data")
        wiki_for_agent = None
        if wiki_raw and isinstance(wiki_raw, dict):
            wiki_for_agent = {
                "extract": wiki_raw.get("extract", ""),
                "full_text": wiki_raw.get("full_text", "")[:3000],
                "infobox": wiki_raw.get("infobox", {}),
                "board_memberships": wiki_raw.get("board_memberships", []),
                "career_history": wiki_raw.get("career_history", []),
            }

        spec = TaskSpec(
            agent_name="philanthropy_agent",
            data={
                "prospect": prospect,
                "propublica_data": data_results.get("propublica_data"),
                "edgar_data": data_results.get("edgar_data", []),
                "wiki_data": wiki_for_agent,
            },
            source_urls=source_urls,
        )
        tasks.append(("philanthropy_agent", spec))

    # Execute foragers (in parallel via asyncio)
    async def _run_forager(agent_name: str, spec: TaskSpec) -> list[dict]:
        harness = WorkerHarness(agent_name, harness_config_for_agent(agent_name), client)
        result = await asyncio.to_thread(harness.execute_task, spec)
        await _log_result(result, agent_name, prospect.get("id"))

        if result.outcome in (AgentOutcome.SUCCESS, AgentOutcome.ESCALATED):
            budget.add(result.cost_usd)
            try:
                raw = _strip_fences(result.data.get("content", "{}"))
                data = json.loads(raw)
                claims = data.get("claims", [])
                for c in claims:
                    if isinstance(c, dict):
                        c["origin"] = "forager"
                return [c for c in claims if isinstance(c, dict) and c.get("source_url")]
            except json.JSONDecodeError:
                logger.warning("Failed to parse forager claims from %s", agent_name)
        return []

    if tasks:
        results = await asyncio.gather(*[_run_forager(name, spec) for name, spec in tasks])
        for claim_list in results:
            forager_claims.extend(claim_list)

    return forager_claims


async def quorum_verify_claims(
    claims: list[dict],
    prospect: dict,
    client: ModelClient,
    budget: ProspectBudgetTracker,
    user_email: str | None = None,
) -> list[dict]:
    """Quorum Sensing: 3 independent Haiku verifiers, majority vote (2-of-3) to include a claim."""
    if not claims or budget.exceeded():
        return claims

    # Build numbered claim list for verifier input
    claim_lines = []
    for i, c in enumerate(claims):
        text = c.get("text", "")
        url = c.get("source_url", "")
        confidence = c.get("confidence", "medium")
        claim_lines.append(f"[{i}] {text} (source: {url}, confidence: {confidence})")
    claims_text = "\n".join(claim_lines)

    verifier_names = ["verifier_source", "verifier_consistency", "verifier_crossref"]

    async def _run_verifier(agent_name: str) -> set[int]:
        """Run a single verifier, return set of approved claim indices."""
        harness = WorkerHarness(agent_name, harness_config_for_agent(agent_name), client)
        spec = TaskSpec(
            agent_name=agent_name,
            data={"claims_text": claims_text},
        )
        result = await asyncio.to_thread(harness.execute_task, spec)
        await _log_result(result, agent_name, prospect.get("id"))

        if result.outcome in (AgentOutcome.SUCCESS, AgentOutcome.ESCALATED):
            budget.add(result.cost_usd)
            try:
                raw = _strip_fences(result.data.get("content", "{}"))
                data = json.loads(raw)
                approved = set(data.get("approved", []))
                return approved
            except (json.JSONDecodeError, TypeError):
                logger.warning("Failed to parse verifier output from %s", agent_name)
        # On failure, approve all (fail-open to avoid losing claims)
        return set(range(len(claims)))

    # Run all 3 verifiers in parallel
    results = await asyncio.gather(*[_run_verifier(name) for name in verifier_names])

    # Majority vote: claim included if approved by 2-of-3
    verified = []
    for i, claim in enumerate(claims):
        votes = sum(1 for approved_set in results if i in approved_set)
        if votes >= 2:
            claim["verification_votes"] = votes
            verified.append(claim)
        else:
            logger.info("Quorum rejected claim %d (%d/3 votes): %s", i, votes, claim.get("text", "")[:80])
            # Log rejection details for future pattern analysis (Level 2 swarm learning)
            rejecting_verifiers = [
                verifier_names[j] for j, approved_set in enumerate(results) if i not in approved_set
            ]
            await log_harness_outcome(
                agent_name="quorum_rejection",
                outcome="rejected",
                error=json.dumps({
                    "claim_index": i,
                    "claim_text": claim.get("text", "")[:200],
                    "votes": votes,
                    "rejected_by": rejecting_verifiers,
                    "origin": claim.get("origin", "unknown"),
                }),
                prospect_id=prospect.get("id"),
                user_email=user_email,
            )

    logger.info("Quorum verification: %d/%d claims passed (2-of-3 vote)", len(verified), len(claims))

    # Log quorum summary for Level 3 yield analysis (accepted + rejected in one entry)
    await log_harness_outcome(
        agent_name="quorum_summary",
        outcome="success",
        error=json.dumps({
            "total_claims": len(claims),
            "accepted": len(verified),
            "rejected": len(claims) - len(verified),
            "origins": {
                origin: sum(1 for c in claims if c.get("origin") == origin)
                for origin in {"forager", "llm_extracted", "template"}
            },
        }),
        prospect_id=prospect.get("id"),
        user_email=user_email,
    )

    return verified


async def synthesize_profile(
    verified_claims: list[dict],
    prospect: dict,
    client: ModelClient,
    budget: ProspectBudgetTracker,
    wikipedia_context: str | None = None,
    conflicts: list[dict] | None = None,
    skipped_sources: list[str] | None = None,
) -> dict:
    """Synthesis: Opus produces summary + confidence from pre-verified, origin-tagged claims.

    Claims are ranked before truncation so forager analytical findings (board seats,
    executive roles, org financials) survive over bulk template data (individual FEC donations).
    """
    if budget.exceeded():
        return {"claims": verified_claims, "summary": "", "confidence_score": "low", "partial": True, "failed_agents": ["budget"]}

    ranked = _rank_claims(verified_claims)
    logger.info(
        "Ranked %d claims for synthesis (forager: %d, llm: %d, template: %d)",
        len(ranked),
        sum(1 for c in ranked if c.get("origin") == "forager"),
        sum(1 for c in ranked if c.get("origin") == "llm_extracted"),
        sum(1 for c in ranked if c.get("origin") == "template"),
    )

    verified_json = _safe_truncate(ranked, max_chars=6000)
    wiki_synth = f"\n\nWikipedia context:\n{wikipedia_context[:2000]}" if wikipedia_context else ""
    name = f"{prospect.get('first_name', '')} {prospect.get('last_name', '')}".strip()

    system = (
        "You write prospect research summaries for nonprofit development officers. "
        "Prioritize: executive roles, board seats, organizational leadership, and giving "
        "capacity indicators over individual transaction records. "
        'Claims tagged origin:"forager" are cross-referenced analytical findings — weight these heavily. '
        'Claims tagged origin:"template" are raw data points from public databases. '
        "Always distinguish current from former positions. Never state someone 'serves as' a role "
        "unless evidence shows the position is active. Use 'formerly served as' for past positions. "
        "Output valid JSON only, no markdown fences."
    )

    if conflicts:
        conflict_desc = "; ".join(c["description"] for c in conflicts[:5])
        system += f" Data conflicts detected: {conflict_desc}. Address discrepancies in your analysis."
    if skipped_sources:
        system += f" Unavailable sources: {', '.join(skipped_sources)}. Note any gaps."

    prompt = (
        f"Write a 2-3 sentence research brief for a development officer about {name}. "
        f"Focus on: current role, organizational affiliations, board service, giving capacity, "
        f"and philanthropic activity. Mention individual donations only if they reveal a "
        f"pattern (e.g., consistent max-out giving, bipartisan strategy).\n\n"
        f"Claims (ranked by analytical value):\n{verified_json}{wiki_synth}\n\n"
        f'Output JSON: {{"summary": "...", "confidence_score": "high|medium|low"}}'
    )

    harness = WorkerHarness("profile_synthesizer", harness_config_for_agent("profile_synthesizer"), client)
    result = await asyncio.to_thread(harness.execute, prompt, system=system)

    await _log_result(result, "profile_synthesizer", prospect.get("id"))

    if result.outcome not in (AgentOutcome.SUCCESS, AgentOutcome.ESCALATED):
        return {"claims": verified_claims, "summary": "", "confidence_score": "low", "partial": True, "failed_agents": ["profile_synthesizer"]}

    budget.add(result.cost_usd)

    try:
        raw = _strip_fences(result.data.get("content", "{}"))
        data = json.loads(raw)
        return {
            "claims": verified_claims,
            "summary": data.get("summary", ""),
            "confidence_score": data.get("confidence_score", "medium"),
            "partial": False,
            "failed_agents": [],
        }
    except json.JSONDecodeError:
        return {"claims": verified_claims, "summary": "", "confidence_score": "medium", "partial": False, "failed_agents": []}


async def verify_urls(claims: list[dict], timeout: float = 5.0) -> tuple[list[dict], list[dict]]:
    """Verify claim source_urls via HEAD request. Returns (live, dropped)."""
    import httpx

    async def check_one(claim: dict) -> tuple[dict, bool]:
        url = claim.get("source_url", "")
        if not url:
            return claim, False
        try:
            async with httpx.AsyncClient(follow_redirects=True) as client:
                r = await client.head(url, timeout=timeout)
                if r.status_code == 405:  # HEAD not allowed, try GET
                    r = await client.get(url, timeout=timeout)
                return claim, r.status_code != 404
        except httpx.HTTPError:
            return claim, True  # Network error — keep claim, let Opus decide

    results = await asyncio.gather(*[check_one(c) for c in claims])
    live = [c for c, ok in results if ok]
    dropped = [c for c, ok in results if not ok]
    return live, dropped


# ---------------------------------------------------------------------------
# Helpers moved from main.py for use by the extracted pipeline
# ---------------------------------------------------------------------------

async def _noop():
    return None


def _safe_result(val):
    """Return None if val is an Exception (from gather return_exceptions)."""
    return None if isinstance(val, BaseException) else val


# ---------------------------------------------------------------------------
# Extracted per-prospect pipeline
# ---------------------------------------------------------------------------

async def fetch_research_data(
    prospect: dict,
    cancel_check: Callable[[], bool],
) -> dict | None:
    """Phase 1 (7 parallel fetches) + Phase 2 (dependent EIN/CIK fetches).

    Returns a dict of all fetched data, or None if cancelled during fetching.
    """
    # Collect org names: organizations list, or single organization
    org_names = list(prospect.get("organizations") or [])
    if prospect.get("organization") and prospect["organization"] not in org_names:
        org_names.insert(0, prospect["organization"])
    primary_org = org_names[0] if org_names else prospect.get("organization")

    ein = prospect.get("ein")
    name = f"{prospect.get('first_name', '')} {prospect.get('last_name', '')}".strip() or primary_org or ""

    # Phase 1: All independent fetches in parallel
    phase1 = await asyncio.gather(
        asyncio.to_thread(search_organizations, primary_org) if primary_org and not ein else _noop(),
        asyncio.to_thread(search_cik, primary_org) if primary_org else _noop(),
        asyncio.to_thread(search_contributions, name, 10) if name else _noop(),
        asyncio.to_thread(search_filings, name) if name else _noop(),
        asyncio.to_thread(search_awards, name) if name else _noop(),
        asyncio.to_thread(fetch_full_profile, name) if name else _noop(),
        asyncio.to_thread(search_officers, name) if name else _noop(),
        return_exceptions=True,
    )
    ein_orgs, cik_result, fec_data, edgar_data, usa_data, wiki_data, oc_data = [_safe_result(r) for r in phase1]

    # Cancel checkpoint: after data fetches, before dependent fetches
    if cancel_check():
        return None

    # Phase 2: Dependent fetches (need EIN / CIK from phase 1)
    ein = ein or (str(ein_orgs[0]["ein"]) if ein_orgs and ein_orgs[0].get("ein") else None)
    cik_val = cik_result
    phase2 = await asyncio.gather(
        asyncio.to_thread(fetch_organization, ein) if ein else _noop(),
        asyncio.to_thread(fetch_company, cik_val) if cik_val else _noop(),
        return_exceptions=True,
    )
    propublica_data, sec_data = [_safe_result(r) for r in phase2]

    return {
        "ein": ein,
        "name": name,
        "primary_org": primary_org,
        "ein_orgs": ein_orgs,
        "cik_result": cik_result,
        "fec_data": fec_data,
        "edgar_data": edgar_data,
        "usa_data": usa_data,
        "wiki_data": wiki_data,
        "oc_data": oc_data,
        "propublica_data": propublica_data,
        "sec_data": sec_data,
    }


async def research_single_prospect(
    prospect: dict,
    contact_id: str,
    client: ModelClient,
    cancel_check: Callable[[], bool],
    user_email: str | None = None,
) -> dict:
    """Full per-prospect research pipeline.

    Returns a result dict with keys: contact_id, claims_count, and optionally cancelled=True.
    Saves profile and session to the database (matching prior inline behavior).
    """
    budget = ProspectBudgetTracker(prospect_id=contact_id)
    # Derive name/org early for session saving
    org_names = list(prospect.get("organizations") or [])
    if prospect.get("organization") and prospect["organization"] not in org_names:
        org_names.insert(0, prospect["organization"])
    primary_org = org_names[0] if org_names else prospect.get("organization")
    name = f"{prospect.get('first_name', '')} {prospect.get('last_name', '')}".strip() or primary_org or ""

    try:
        # Fetch all research data (Phase 1 + Phase 2)
        research_data = await fetch_research_data(prospect, cancel_check)
        if research_data is None:
            # Cancelled during fetch
            logger.info("Cancelled during fetch for %s", contact_id)
            return {"contact_id": contact_id, "cancelled": True}

        fec_data = research_data["fec_data"]
        edgar_data = research_data["edgar_data"]
        usa_data = research_data["usa_data"]
        wiki_data = research_data["wiki_data"]
        oc_data = research_data["oc_data"]
        propublica_data = research_data["propublica_data"]
        sec_data = research_data["sec_data"]

        # Score source richness (waggle dance)
        source_scores = await score_source_richness(
            propublica_data, sec_data, fec_data, edgar_data,
            usa_data, wiki_data, oc_data,
        )
        await save_source_scores(contact_id, source_scores)
        logger.info("Source scores for %s: %s", contact_id, source_scores)

        # Build structured claims from templates (no LLM)
        structured_claims = []
        structured_claims.extend(claims_from_fec(fec_data or []))
        structured_claims.extend(claims_from_usaspending(usa_data or []))
        structured_claims.extend(claims_from_opencorporates(oc_data or []))
        structured_claims.extend(claims_from_edgar_search(edgar_data or []))
        structured_claims.extend(claims_from_wikipedia_infobox(wiki_data))

        # Cancel checkpoint: before LLM-heavy stages
        if cancel_check():
            logger.info("Cancelled before foragers for %s", contact_id)
            await save_profile(contact_id, {"claims": structured_claims, "summary": "", "confidence_score": "low", "partial": True, "failed_agents": ["cancelled"]})
            await _save_session_for_prospect(contact_id, {"claims": structured_claims}, name, primary_org, budget, "cancelled")
            return {"contact_id": contact_id, "claims_count": len(structured_claims), "cancelled": True}

        # Activate specialist foragers (conditional on richness thresholds)
        forager_claims = await activate_foragers(
            source_scores,
            {
                "fec_data": fec_data,
                "oc_data": oc_data,
                "usa_data": usa_data,
                "propublica_data": propublica_data,
                "edgar_data": edgar_data,
                "wiki_data": wiki_data,
            },
            prospect, client, budget,
        )

        # Stage 1: LLM extraction for ProPublica + SEC only
        enriched = await stage1_enrich_prospect(prospect, structured_claims, propublica_data, sec_data, client, budget)
        llm_claims = [c for c in enriched.get("claims", []) if isinstance(c, dict) and c.get("source_url")]

        # Merge all claims: template + forager + llm-extracted
        all_claims = llm_claims + forager_claims
        logger.info(
            "Claim pool for %s: %d template, %d forager, %d llm = %d total",
            contact_id, len(structured_claims), len(forager_claims),
            len(llm_claims) - len(structured_claims), len(all_claims),
        )

        # Cancel checkpoint: before verification and synthesis
        if cancel_check():
            logger.info("Cancelled before verification for %s", contact_id)
            await save_profile(contact_id, {"claims": all_claims, "summary": "", "confidence_score": "low", "partial": True, "failed_agents": ["cancelled"]})
            await _save_session_for_prospect(contact_id, {"claims": all_claims}, name, primary_org, budget, "cancelled")
            return {"contact_id": contact_id, "claims_count": len(all_claims), "cancelled": True}

        # URL pre-filter: drop claims with dead source URLs
        if all_claims and not budget.exceeded():
            all_claims, dropped = await verify_urls(all_claims)
            if dropped:
                logger.info(
                    "URL pre-filter dropped %d claims: %s",
                    len(dropped), [c.get("source_url") for c in dropped],
                )

        # Quorum verification (replaces single Opus fact-check)
        # Build enriched Wikipedia context: full text + infobox summary
        wikipedia_context = None
        if wiki_data:
            parts = []
            if wiki_data.get("full_text"):
                parts.append(wiki_data["full_text"][:3000])
            elif wiki_data.get("extract"):
                parts.append(wiki_data["extract"])
            infobox = wiki_data.get("infobox", {})
            if infobox:
                infobox_summary = ", ".join(f"{k}: {v}" for k, v in infobox.items())
                parts.append(f"Infobox: {infobox_summary}")
            wikipedia_context = "\n\n".join(parts) if parts else None
        verified_claims = all_claims
        if all_claims and not budget.exceeded():
            verified_claims = await quorum_verify_claims(all_claims, prospect, client, budget, user_email=user_email)

        # Cancel checkpoint: before synthesis (most expensive LLM call)
        if cancel_check():
            logger.info("Cancelled before synthesis for %s", contact_id)
            await save_profile(contact_id, {"claims": verified_claims, "summary": "", "confidence_score": "medium", "partial": True, "failed_agents": ["cancelled"]})
            await _save_session_for_prospect(contact_id, {"claims": verified_claims}, name, primary_org, budget, "cancelled")
            return {"contact_id": contact_id, "claims_count": len(verified_claims), "cancelled": True}

        # Synthesis (Opus, with pre-verified origin-tagged claims)
        if verified_claims and not budget.exceeded():
            profile_data = await synthesize_profile(verified_claims, prospect, client, budget, wikipedia_context=wikipedia_context)
            profile = {
                "claims": profile_data.get("claims", verified_claims),
                "summary": profile_data.get("summary", ""),
                "confidence_score": profile_data.get("confidence_score", "medium"),
                "partial": profile_data.get("partial", False),
                "failed_agents": profile_data.get("failed_agents", []),
            }
        else:
            profile = {
                "claims": verified_claims,
                "summary": "",
                "confidence_score": "medium",
                "partial": enriched.get("partial", False),
                "failed_agents": enriched.get("failed_agents", []),
            }
    except Exception as e:
        logger.exception("Prospect %s failed: %s", contact_id, e)
        profile = {
            "claims": [],
            "summary": "",
            "confidence_score": "low",
            "partial": True,
            "failed_agents": ["pipeline_error"],
        }

    await save_profile(contact_id, profile)
    # Save session history entry
    session_status = "cancelled" if cancel_check() else "completed"
    await _save_session_for_prospect(contact_id, profile, name, primary_org, budget, session_status)
    return {"contact_id": contact_id, "claims_count": len(profile["claims"])}


async def _save_session_for_prospect(
    contact_id: str,
    profile: dict,
    name: str,
    primary_org: str | None,
    budget: ProspectBudgetTracker,
    status: str,
) -> None:
    """Save a research session entry. Shared by normal and cancel paths."""
    await save_session(
        session_id=str(uuid.uuid4()),
        contact_id=contact_id,
        profile=profile,
        prospect_name=name,
        prospect_org=primary_org or "",
        cost_usd=budget.total_cost_usd,
        status=status,
    )
