"""Export research profiles as Markdown (and optionally PDF in the future)."""

from datetime import datetime, timezone

from .formatting import escape_md_table_cell, normalize_confidence, truncate_for_cell

_CLAIM_TEXT_LIMIT = 240


def render_profile_markdown(profile: dict, prospect_name: str, prospect_org: str) -> str:
    """Render a research profile as a Markdown document.

    Args:
        profile: Profile dict with claims, summary, confidence_score, and
            optionally `partial` (bool) and `partial_reason` (str).
        prospect_name: Display name of the prospect.
        prospect_org: Organization name (may be blank).

    Returns:
        Markdown string. Stable structure across runs — pinned by tests in
        `pebble/tests/test_export.py`.
    """
    lines: list[str] = []
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    confidence = normalize_confidence(profile.get("confidence_score"))

    lines.append(f"# Prospect Research: {prospect_name}")
    if prospect_org:
        lines.append(f"**Organization:** {prospect_org}")
    lines.append(f"**Generated:** {generated}")
    lines.append(f"**Confidence:** {confidence}")
    if profile.get("partial"):
        lines.append("**Status:** Partial (some agents failed)")
    lines.append("")

    summary = (profile.get("summary") or "").strip()
    claims = profile.get("claims") or []

    if not summary and not claims:
        lines.append("## No information gathered")
        lines.append("")
        reason = (profile.get("partial_reason") or "").strip()
        if reason:
            lines.append(f"This research run did not produce any claims. Reason: {reason}")
        else:
            lines.append(
                "This research run did not produce any claims. The agents may have "
                "timed out or found no public information for this prospect."
            )
        lines.append("")
        return "\n".join(lines)

    if summary:
        lines.append("## Summary")
        lines.append("")
        lines.append(summary)
        lines.append("")

    truncated_claims: list[tuple[int, str]] = []
    if claims:
        lines.append(f"## Claims ({len(claims)})")
        lines.append("")
        lines.append("| # | Claim | Source | Confidence | Status |")
        lines.append("|---|-------|--------|------------|--------|")
        for i, claim in enumerate(claims, 1):
            raw_text = claim.get("text", "")
            short, was_truncated = truncate_for_cell(raw_text, _CLAIM_TEXT_LIMIT)
            cell_text = escape_md_table_cell(short)
            if was_truncated:
                cell_text = f"{cell_text} [^c{i}]"
                truncated_claims.append((i, raw_text))
            url = claim.get("source_url", "")
            source_link = f"[Link]({url})" if url else "-"
            conf_cell = normalize_confidence(claim.get("confidence", "medium"))
            temporal = (claim.get("temporal_status") or "").strip()
            status = temporal if temporal and temporal != "unknown" else "-"
            lines.append(f"| {i} | {cell_text} | {source_link} | {conf_cell} | {status} |")
        lines.append("")

        if truncated_claims:
            lines.append("### Full claim text")
            lines.append("")
            for idx, full_text in truncated_claims:
                normalized = full_text.replace("\r\n", "\n").strip()
                lines.append(f"[^c{idx}]: {normalized}")
            lines.append("")

    source_lines = _render_sources_section(claims)
    if source_lines:
        lines.extend(source_lines)

    return "\n".join(lines)


def _render_sources_section(claims: list[dict]) -> list[str]:
    """Build the `## Sources` section ordered by first-appearance in claims.

    Each URL appears once; multi-claim URLs get a `(N claims)` suffix.
    Uses `source_title` when present, falling back to the bare URL.
    """
    counts: dict[str, int] = {}
    titles: dict[str, str] = {}
    order: list[str] = []
    for claim in claims:
        url = (claim.get("source_url") or "").strip()
        if not url:
            continue
        if url not in counts:
            counts[url] = 0
            order.append(url)
        counts[url] += 1
        title = (claim.get("source_title") or "").strip()
        if title and url not in titles:
            titles[url] = title

    if not order:
        return []

    out: list[str] = ["## Sources", ""]
    for url in order:
        title = titles.get(url)
        label = f"[{title}]({url})" if title else url
        suffix = f" ({counts[url]} claims)" if counts[url] > 1 else ""
        out.append(f"- {label}{suffix}")
    out.append("")
    return out


def render_profile_pdf(markdown_text: str) -> bytes:
    """Best-effort PDF rendering from markdown text.

    Falls back to returning the markdown as UTF-8 bytes if PDF libraries
    are not available.
    """
    try:
        import markdown as md

        html = md.markdown(markdown_text, extensions=["tables"])
        full_html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
body {{ font-family: sans-serif; margin: 2em; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #ccc; padding: 6px 10px; text-align: left; }}
th {{ background: #f5f5f5; }}
</style></head><body>{html}</body></html>"""

        try:
            from weasyprint import HTML
            return HTML(string=full_html).write_pdf()
        except ImportError:
            return markdown_text.encode("utf-8")
    except ImportError:
        return markdown_text.encode("utf-8")
