"""Tests for services.awards_service.

Covers:
  - is_award_eligible predicate (record type + stage gates)
  - initial_award_status (Closing vs. Active)
  - ensure_for_opp idempotency (existing → no-op; new → insert)
  - ensure_for_opp eligibility (skips ineligible record types / ISA, skips wrong stage)
  - ensure_for_opp SF lookup fallback when hints absent
"""

import sys
import os
from datetime import date
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services.awards_service import (
    ELIGIBLE_STAGES_BY_RECORD_TYPE,
    WON_PHILANTHROPY_STAGES,
    CLOSING_PHILANTHROPY_STAGES,
    is_award_eligible,
    initial_award_status,
    ensure_for_opp,
    get_for_opp,
)


# ---------------------------------------------------------------------------
# Pure-predicate tests
# ---------------------------------------------------------------------------

class TestIsAwardEligible:

    def test_grant_closed_won_is_eligible(self):
        assert is_award_eligible("Closed Won", "Grant") is True

    def test_donation_shares_grant_stages(self):
        # Grant + Donation replaced the former 'Philanthropy' record type
        # (2026-10-22) and inherit its stage allowlist.
        assert ELIGIBLE_STAGES_BY_RECORD_TYPE["Donation"] == WON_PHILANTHROPY_STAGES
        assert ELIGIBLE_STAGES_BY_RECORD_TYPE["Grant"] == WON_PHILANTHROPY_STAGES
        assert is_award_eligible("Closed / Completed", "Donation") is True

    def test_former_philanthropy_name_not_eligible(self):
        # No SF opp carries 'Philanthropy' anymore — guard against the old
        # hardcoded name creeping back in.
        assert "Philanthropy" not in ELIGIBLE_STAGES_BY_RECORD_TYPE

    def test_canonical_closed_won_is_eligible(self):
        assert is_award_eligible("closed-won", "Grant") is True

    def test_collecting_in_effect_is_eligible(self):
        # Both legacy stages are still in flight = post-award management applies.
        assert is_award_eligible("Collecting", "Grant") is True
        assert is_award_eligible("In Effect", "Grant") is True

    def test_closed_fulfilled_is_eligible(self):
        assert is_award_eligible("Closed / Fulfilled", "Grant") is True

    def test_unlisted_record_type_never_eligible(self):
        # Record types without a stage allowlist (e.g. Other In-Kind) never
        # get an award row, even on a "won" stage.
        for stage in WON_PHILANTHROPY_STAGES:
            assert is_award_eligible(stage, "Other In-Kind") is False

    def test_isa_record_type_never_eligible(self):
        # ISA / Pursuit Bond — explicitly out of scope.
        for stage in WON_PHILANTHROPY_STAGES:
            assert is_award_eligible(stage, "Pursuit Bond / Income Share Agreement") is False

    def test_pipeline_stage_not_eligible(self):
        for stage in ("identified", "qualified", "proposal-sent", "in-negotiation",
                      "verbal-commit", "Closed Lost", "closed-lost"):
            assert is_award_eligible(stage, "Grant") is False, (
                f"stage={stage!r} should not be award-eligible"
            )

    def test_in_collection_not_eligible(self):
        # ISA legacy stage on Grant record type — shouldn't happen,
        # but if it does, we don't want to backfill.
        assert is_award_eligible("In Collection", "Grant") is False

    def test_null_inputs_return_false(self):
        assert is_award_eligible(None, "Grant") is False
        assert is_award_eligible("Closed Won", None) is False
        assert is_award_eligible(None, None) is False
        assert is_award_eligible("", "Grant") is False


class TestInitialAwardStatus:

    def test_closing_stages_default_to_closing(self):
        for stage in CLOSING_PHILANTHROPY_STAGES:
            assert initial_award_status(stage) == "Closing"

    def test_active_stages_default_to_active(self):
        for stage in ("Collecting / In Effect", "Collecting", "In Effect"):
            assert initial_award_status(stage) == "Active"

    def test_closed_stages_default_to_closed(self):
        for stage in ("Closed / Completed", "Closed Won", "closed-won"):
            assert initial_award_status(stage) == "Closed"

    def test_did_not_fulfill_stages(self):
        assert initial_award_status("Closed / Did not Fulfill") == "Did Not Fulfill"


# ---------------------------------------------------------------------------
# Database-side tests (mocked asyncpg conn + sf client)
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_conn():
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value=None)
    conn.fetchval = AsyncMock(return_value=None)
    conn.execute = AsyncMock(return_value="INSERT 0 1")
    return conn


@pytest.fixture
def mock_sf():
    sf = MagicMock()
    sf.query = AsyncMock(return_value={"records": []})
    return sf


def _row_for_award(opp_id="006X000000ABCDE", status="Active",
                   award_date=date(2024, 7, 15)):
    return {
        "id": "11111111-1111-1111-1111-111111111111",
        "opportunity_id": opp_id,
        "award_status": status,
        "award_date": award_date,
        "period_end_date": None,
        "notes": "",
        "created_at": "2026-04-30T12:00:00Z",
        "updated_at": "2026-04-30T12:00:00Z",
    }


class TestEnsureForOpp:

    @pytest.mark.asyncio
    async def test_returns_existing_award_without_insert(self, mock_conn, mock_sf):
        """If an award already exists, ensure_for_opp returns it and does not insert."""
        existing = _row_for_award()
        mock_conn.fetchrow.side_effect = [existing]  # only get_for_opp lookup

        result = await ensure_for_opp(
            mock_conn, mock_sf, "006X000000ABCDE",
            stage_name_hint="Closed Won",
            record_type_hint="Grant",
        )

        assert result is not None
        assert result["opportunity_id"] == "006X000000ABCDE"
        # Only the lookup was called; no INSERT
        assert mock_conn.fetchrow.call_count == 1
        # SF was not consulted because hints were provided
        assert mock_sf.query.call_count == 0

    @pytest.mark.asyncio
    async def test_inserts_new_award_when_eligible(self, mock_conn, mock_sf):
        """First call for an eligible opp creates a new award row."""
        new_row = _row_for_award(status="Active")
        # First fetchrow: get_for_opp returns None (no existing)
        # Second fetchrow: INSERT ... RETURNING returns the new row
        mock_conn.fetchrow.side_effect = [None, new_row]

        result = await ensure_for_opp(
            mock_conn, mock_sf, "006X000000ABCDE",
            stage_name_hint="Closed Won",
            record_type_hint="Grant",
        )

        assert result is not None
        assert result["award_status"] == "Active"
        assert mock_conn.fetchrow.call_count == 2

    @pytest.mark.asyncio
    async def test_skips_ineligible_record_type(self, mock_conn, mock_sf):
        """Record types without a stage allowlist never get an award row."""
        result = await ensure_for_opp(
            mock_conn, mock_sf, "006X000000ABCDE",
            stage_name_hint="Closed Won",
            record_type_hint="Other In-Kind",
        )

        assert result is None
        # Eligibility gate failed before any DB call
        assert mock_conn.fetchrow.call_count == 0

    @pytest.mark.asyncio
    async def test_skips_pipeline_stage(self, mock_conn, mock_sf):
        """Opp not yet at award-eligible stage gets no award."""
        result = await ensure_for_opp(
            mock_conn, mock_sf, "006X000000ABCDE",
            stage_name_hint="proposal-sent",
            record_type_hint="Grant",
        )

        assert result is None
        assert mock_conn.fetchrow.call_count == 0

    @pytest.mark.asyncio
    async def test_falls_back_to_sf_when_hints_missing(self, mock_conn, mock_sf):
        """When stage/record-type hints aren't provided, fetch from SF."""
        mock_sf.query.return_value = {
            "records": [{
                "Id": "006X000000ABCDE",
                "StageName": "Closed Won",
                "CloseDate": "2024-07-15",
                "RecordType": {"Name": "Grant"},
            }]
        }
        new_row = _row_for_award()
        mock_conn.fetchrow.side_effect = [None, new_row]

        result = await ensure_for_opp(mock_conn, mock_sf, "006X000000ABCDE")

        assert result is not None
        assert mock_sf.query.call_count == 1
        # Hint-less call uses SF for both eligibility AND CloseDate proxy.

    @pytest.mark.asyncio
    async def test_sf_query_failure_returns_none(self, mock_conn, mock_sf):
        """An SF outage doesn't crash the caller — return None and let
        the auto-create handler swallow it."""
        mock_sf.query.side_effect = RuntimeError("SF down")

        result = await ensure_for_opp(mock_conn, mock_sf, "006X000000ABCDE")

        assert result is None

    @pytest.mark.asyncio
    async def test_sf_returns_no_records_returns_none(self, mock_conn, mock_sf):
        """If the opp doesn't exist in SF, return None silently."""
        mock_sf.query.return_value = {"records": []}

        result = await ensure_for_opp(mock_conn, mock_sf, "006X000000ABCDE")

        assert result is None
        assert mock_conn.fetchrow.call_count == 0

    @pytest.mark.asyncio
    async def test_concurrent_insert_returns_existing_via_refetch(self, mock_conn, mock_sf):
        """Race condition: another caller created the row between our
        get_for_opp and INSERT. ON CONFLICT DO NOTHING returns no row;
        we refetch and return the existing one."""
        existing = _row_for_award()
        # 1: get_for_opp → None (no existing yet)
        # 2: INSERT ... RETURNING → None (ON CONFLICT skipped insert)
        # 3: refetch via get_for_opp → existing row
        mock_conn.fetchrow.side_effect = [None, None, existing]

        result = await ensure_for_opp(
            mock_conn, mock_sf, "006X000000ABCDE",
            stage_name_hint="Closed Won",
            record_type_hint="Grant",
        )

        assert result is not None
        assert result["opportunity_id"] == "006X000000ABCDE"
        assert mock_conn.fetchrow.call_count == 3


class TestGetForOpp:

    @pytest.mark.asyncio
    async def test_returns_dict_when_row_found(self, mock_conn):
        existing = _row_for_award()
        mock_conn.fetchrow.return_value = existing
        result = await get_for_opp(mock_conn, "006X000000ABCDE")
        assert result is not None
        assert result["opportunity_id"] == "006X000000ABCDE"

    @pytest.mark.asyncio
    async def test_returns_none_when_not_found(self, mock_conn):
        mock_conn.fetchrow.return_value = None
        result = await get_for_opp(mock_conn, "006X000000ABCDE")
        assert result is None
