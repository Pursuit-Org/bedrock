"""Pebble research orchestrator.

This package replaces the former single-file `pebble/orchestrator.py`. All
existing behavior lives unchanged in `_pipeline.py`; this `__init__.py`
re-exports the symbols that callers outside the package import today, so
existing import sites keep working without modification.

Future work (the L2 swarm) will add sibling modules (`schemas.py`,
`planner.py`, `renderer.py`, ...) inside this package.
"""

from ._pipeline import (
    ProspectBudgetTracker,
    activate_foragers,
    quorum_verify_claims,
    research_single_prospect,
    score_source_richness,
    synthesize_profile,
    verify_urls,
)

__all__ = [
    "ProspectBudgetTracker",
    "activate_foragers",
    "quorum_verify_claims",
    "research_single_prospect",
    "score_source_richness",
    "synthesize_profile",
    "verify_urls",
]
