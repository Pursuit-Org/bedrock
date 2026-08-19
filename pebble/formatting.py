"""Shared formatting helpers for Pebble output renderers.

Pure functions, no I/O. Used by `pebble.export` (legacy markdown profile) and
intended for adoption by `pebble.orchestrator.renderer` in a follow-up.
"""

from __future__ import annotations


def escape_md_table_cell(text: str) -> str:
    """Escape a string for safe embedding in a Markdown table cell.

    Markdown tables split rows on unescaped `|`, and any newline ends the row.
    """
    return text.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def truncate_for_cell(text: str, limit: int = 240) -> tuple[str, bool]:
    """Truncate `text` to `limit` characters, appending an ellipsis if shortened.

    Returns `(maybe_truncated, was_truncated)`. The ellipsis counts toward the
    limit so the returned string is never longer than `limit`.
    """
    if len(text) <= limit:
        return text, False
    return text[: max(0, limit - 1)] + "…", True


def normalize_confidence(value: object) -> str:
    """Render a heterogeneous confidence value as a human-readable band.

    Accepts:
      - float-like in [0.0, 1.0] -> `"High (0.84)"`, `"Medium (0.62)"`, `"Low (0.21)"`
      - string `"high"` / `"medium"` / `"low"` (case-insensitive) -> `"High"` etc.
      - anything else (None, empty, unrecognized) -> `"Unknown"`
    """
    if isinstance(value, bool):
        return "Unknown"
    if isinstance(value, (int, float)):
        try:
            score = float(value)
        except (TypeError, ValueError):
            return "Unknown"
        if 0.0 <= score <= 1.0:
            band = "High" if score >= 0.7 else "Medium" if score >= 0.4 else "Low"
            return f"{band} ({score:.2f})"
        return "Unknown"
    if isinstance(value, str):
        key = value.strip().lower()
        if key in {"high", "medium", "low"}:
            return key.capitalize()
    return "Unknown"
