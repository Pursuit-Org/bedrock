"""Structural tests for pebble.export.render_profile_markdown.

These tests pin the output **format** so regressions are caught loudly.
They assert on document structure (sections, ordering, table shape) rather
than substring presence, so reordering or rewording a section will fail.
"""

import re

from pebble.export import render_profile_markdown, render_profile_pdf


def _claim(text: str, **overrides) -> dict:
    """Helper: build a claim dict with sensible defaults."""
    base = {
        "text": text,
        "source_url": "",
        "confidence": "medium",
        "temporal_status": "",
    }
    base.update(overrides)
    return base


def _section_indices(md: str) -> dict[str, int]:
    """Return a map of section heading text -> line index for `##` headings."""
    out: dict[str, int] = {}
    for i, line in enumerate(md.splitlines()):
        if line.startswith("## "):
            out[line[3:].strip()] = i
    return out


# --- Header --------------------------------------------------------------


def test_header_section_always_present():
    md = render_profile_markdown(
        {"summary": "x", "claims": [], "confidence_score": "high"},
        "Jane Doe",
        "Acme Corp",
    )
    lines = md.splitlines()
    assert lines[0] == "# Prospect Research: Jane Doe"
    assert lines[1] == "**Organization:** Acme Corp"
    assert lines[2].startswith("**Generated:** ")
    # Timestamp shape: YYYY-MM-DD HH:MM UTC
    assert re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC", lines[2])
    assert lines[3] == "**Confidence:** High"


def test_header_omits_organization_when_blank():
    md = render_profile_markdown(
        {"summary": "x", "claims": [], "confidence_score": "high"},
        "Jane Doe",
        "",
    )
    lines = md.splitlines()
    assert lines[0] == "# Prospect Research: Jane Doe"
    assert lines[1].startswith("**Generated:** ")


def test_partial_status_line_only_when_partial():
    md_partial = render_profile_markdown(
        {"summary": "x", "claims": [], "partial": True}, "J", "A"
    )
    md_complete = render_profile_markdown({"summary": "x", "claims": []}, "J", "A")
    assert "**Status:** Partial (some agents failed)" in md_partial
    assert "**Status:**" not in md_complete


# --- Empty-state --------------------------------------------------------


def test_empty_state_when_no_data():
    md = render_profile_markdown(
        {"summary": "", "claims": [], "partial": True}, "Jane", "Acme"
    )
    sections = _section_indices(md)
    assert "No information gathered" in sections
    assert "Summary" not in sections
    assert "Claims (0)" not in sections
    assert "Sources" not in sections


def test_empty_state_uses_partial_reason_when_provided():
    md = render_profile_markdown(
        {"summary": "", "claims": [], "partial_reason": "All agents timed out"},
        "J",
        "A",
    )
    assert "All agents timed out" in md


def test_empty_state_has_generic_fallback_without_reason():
    md = render_profile_markdown({"summary": "", "claims": []}, "J", "A")
    assert "did not produce any claims" in md


def test_summary_alone_skips_empty_state():
    md = render_profile_markdown(
        {"summary": "Some prose.", "claims": []}, "J", "A"
    )
    sections = _section_indices(md)
    assert "Summary" in sections
    assert "No information gathered" not in sections


# --- Summary ------------------------------------------------------------


def test_summary_block_emitted_when_present():
    md = render_profile_markdown(
        {"summary": "Founder of Acme.", "claims": [_claim("c1")]}, "J", "A"
    )
    lines = md.splitlines()
    summary_idx = lines.index("## Summary")
    assert lines[summary_idx + 1] == ""
    assert lines[summary_idx + 2] == "Founder of Acme."


def test_summary_block_omitted_when_blank():
    md = render_profile_markdown(
        {"summary": "   ", "claims": [_claim("c1")]}, "J", "A"
    )
    assert "## Summary" not in md


# --- Claims table -------------------------------------------------------


def test_claims_table_structure():
    md = render_profile_markdown(
        {
            "summary": "",
            "claims": [
                _claim("First claim", source_url="https://a.example"),
                _claim("Second claim", source_url="https://b.example"),
            ],
        },
        "J",
        "A",
    )
    lines = md.splitlines()
    header_idx = lines.index("## Claims (2)")
    # Section: heading, blank, table-header, separator, 2 data rows, blank.
    assert lines[header_idx + 1] == ""
    assert lines[header_idx + 2] == "| # | Claim | Source | Confidence | Status |"
    assert lines[header_idx + 3] == "|---|-------|--------|------------|--------|"
    assert lines[header_idx + 4].startswith("| 1 | First claim |")
    assert lines[header_idx + 5].startswith("| 2 | Second claim |")
    # Each data row has exactly the right column count (6 pipes for 5 cols).
    for row_idx in (header_idx + 4, header_idx + 5):
        assert lines[row_idx].count("|") - lines[row_idx].count("\\|") == 6


def test_claim_text_escapes_pipes_and_newlines():
    md = render_profile_markdown(
        {"summary": "", "claims": [_claim("a|b\nc")]},
        "J",
        "A",
    )
    # In the table cell the pipe is escaped and the newline becomes a space.
    assert "| a\\|b c |" in md


def test_claim_truncation_above_limit():
    long_text = "x" * 300
    md = render_profile_markdown(
        {"summary": "", "claims": [_claim(long_text)]},
        "J",
        "A",
    )
    lines = md.splitlines()
    # Truncated text in table cell ends with ellipsis + footnote anchor.
    row = next(ln for ln in lines if ln.startswith("| 1 |"))
    assert "…" in row
    assert "[^c1]" in row
    # Detail section follows the table.
    detail_idx = lines.index("### Full claim text")
    footnote = lines[detail_idx + 2]
    assert footnote.startswith("[^c1]: ")
    assert footnote.endswith("x" * 50)  # full text restored


def test_claim_at_limit_not_truncated():
    text = "y" * 240
    md = render_profile_markdown(
        {"summary": "", "claims": [_claim(text)]},
        "J",
        "A",
    )
    assert "### Full claim text" not in md
    assert "[^c1]" not in md


def test_claim_confidence_normalized():
    md = render_profile_markdown(
        {
            "summary": "",
            "claims": [
                _claim("c1", confidence=0.84),
                _claim("c2", confidence="low"),
                _claim("c3", confidence=None),
            ],
        },
        "J",
        "A",
    )
    lines = md.splitlines()
    row1 = next(ln for ln in lines if ln.startswith("| 1 |"))
    row2 = next(ln for ln in lines if ln.startswith("| 2 |"))
    row3 = next(ln for ln in lines if ln.startswith("| 3 |"))
    assert "High (0.84)" in row1
    assert "Low" in row2 and "(0." not in row2
    assert "Unknown" in row3


def test_top_level_confidence_normalized():
    md_float = render_profile_markdown(
        {"summary": "x", "claims": [], "confidence_score": 0.62}, "J", "A"
    )
    md_missing = render_profile_markdown({"summary": "x", "claims": []}, "J", "A")
    assert "**Confidence:** Medium (0.62)" in md_float
    assert "**Confidence:** Unknown" in md_missing


# --- Sources ------------------------------------------------------------


def test_sources_section_ordering_by_first_appearance():
    md = render_profile_markdown(
        {
            "summary": "",
            "claims": [
                _claim("c1", source_url="https://b.example"),
                _claim("c2", source_url="https://a.example"),
                _claim("c3", source_url="https://b.example"),
            ],
        },
        "J",
        "A",
    )
    lines = md.splitlines()
    sources_idx = lines.index("## Sources")
    # First-appearance order: b before a, with b carrying a multi-claim suffix.
    assert lines[sources_idx + 2] == "- https://b.example (2 claims)"
    assert lines[sources_idx + 3] == "- https://a.example"


def test_sources_section_uses_titles_when_present():
    md = render_profile_markdown(
        {
            "summary": "",
            "claims": [
                _claim(
                    "c1",
                    source_url="https://a.example",
                    source_title="A Example Page",
                ),
                _claim("c2", source_url="https://b.example"),
            ],
        },
        "J",
        "A",
    )
    assert "- [A Example Page](https://a.example)" in md
    assert "- https://b.example" in md


def test_sources_section_omitted_when_no_urls():
    md = render_profile_markdown(
        {"summary": "x", "claims": [_claim("c1")]}, "J", "A"
    )
    assert "## Sources" not in md


# --- PDF smoke ----------------------------------------------------------


def test_render_profile_pdf_smoke_returns_bytes():
    md = "# Hello"
    out = render_profile_pdf(md)
    assert isinstance(out, bytes)
    assert len(out) > 0
