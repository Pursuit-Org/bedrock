"""Tests for services.record_type_bucket and the Grant-period stage gate.

Covers:
  - bucket_soql_filter fragments for every bucket (direct + relationship prefix)
  - ISA exclusion on every bucket
  - BUCKET_PATTERN accepts exactly VALID_BUCKETS
  - _validate_stage_change_logic: Grant opps need a grant period before
    'Collecting / In Effect'; non-Grant opps don't
"""

import os
import re
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services.record_type_bucket import (
    BUCKET_PATTERN,
    VALID_BUCKETS,
    bucket_soql_filter,
)


class TestBucketSoqlFilter:

    def test_all_only_excludes_isa(self):
        assert bucket_soql_filter("all", opp_prefix="") == " AND RecordType.Name != 'ISA'"

    def test_philanthropy_is_grant_plus_donation_minus_capital(self):
        frag = bucket_soql_filter("philanthropy", opp_prefix="")
        assert "RecordType.Name IN ('Grant', 'Donation')" in frag
        assert "Philanthropy_Type__c != 'Capital Grant'" in frag
        assert "'Philanthropy'" not in frag

    def test_grant(self):
        frag = bucket_soql_filter("grant", opp_prefix="")
        assert "RecordType.Name = 'Grant'" in frag
        assert "Philanthropy_Type__c != 'Capital Grant'" in frag

    def test_donation(self):
        frag = bucket_soql_filter("donation", opp_prefix="")
        assert "RecordType.Name = 'Donation'" in frag

    def test_capital_grants(self):
        frag = bucket_soql_filter("capital_grants", opp_prefix="")
        assert "Philanthropy_Type__c = 'Capital Grant'" in frag
        assert "RecordType.Name != 'ISA'" in frag

    def test_pbc(self):
        assert bucket_soql_filter("pbc", opp_prefix="") == " AND RecordType.Name = 'PBC'"

    def test_other_excludes_named_buckets(self):
        frag = bucket_soql_filter("other", opp_prefix="")
        assert "NOT IN ('Grant', 'Donation', 'PBC', 'ISA')" in frag
        assert "RecordType.Name = null" in frag
        assert "Philanthropy_Type__c != 'Capital Grant'" in frag

    def test_relationship_prefix_applied(self):
        frag = bucket_soql_filter("grant")
        assert "npe01__Opportunity__r.RecordType.Name = 'Grant'" in frag
        assert "npe01__Opportunity__r.Philanthropy_Type__c" in frag
        # no bare (unprefixed) field references
        assert " RecordType.Name" not in frag.replace("npe01__Opportunity__r.RecordType.Name", "")

    @pytest.mark.parametrize("bucket", VALID_BUCKETS)
    def test_every_bucket_excludes_isa(self, bucket):
        # Either explicitly (!= 'ISA' / NOT IN (... 'ISA')) or implicitly by
        # pinning to a non-ISA record type.
        frag = bucket_soql_filter(bucket, opp_prefix="")
        assert (
            "!= 'ISA'" in frag
            or "'ISA')" in frag
            or re.search(r"RecordType\.Name (=|IN) ", frag)
        ), frag

    def test_unknown_bucket_falls_back_to_isa_exclusion(self):
        assert bucket_soql_filter("bogus", opp_prefix="") == " AND RecordType.Name != 'ISA'"


class TestBucketPattern:

    @pytest.mark.parametrize("bucket", VALID_BUCKETS)
    def test_accepts_valid(self, bucket):
        assert re.match(BUCKET_PATTERN, bucket)

    @pytest.mark.parametrize("bucket", ["Philanthropy", "grants", "", "all|pbc", "isa"])
    def test_rejects_invalid(self, bucket):
        assert not re.match(BUCKET_PATTERN, bucket)


# ---------------------------------------------------------------------------
# Grant-period stage gate
# ---------------------------------------------------------------------------

from routes.opportunities_extra import _validate_stage_change_logic  # noqa: E402

COLLECTING = "Collecting / In Effect"
OPP_ID = "006X000000ABCDEAAA"


def _sf(opp: dict, payments: list | None = None):
    sf = MagicMock()
    sf.query = AsyncMock(side_effect=[
        {"records": [opp]},
        {"records": payments or []},
    ])
    return sf


class TestGrantPeriodGate:

    @pytest.mark.asyncio
    async def test_grant_without_dates_is_blocked(self):
        sf = _sf({"Id": OPP_ID, "Amount": 1000, "RecordType": {"Name": "Grant"},
                  "Grant_Start_Date__c": None, "Grant_End_Date__c": None})
        result = await _validate_stage_change_logic(OPP_ID, COLLECTING, sf)
        assert result["can_proceed"] is False
        assert result["action_required"] == "set_grant_period"
        # Payment query never ran — grant check short-circuits first.
        assert sf.query.await_count == 1

    @pytest.mark.asyncio
    async def test_grant_with_only_start_is_blocked(self):
        sf = _sf({"Id": OPP_ID, "Amount": 1000, "RecordType": {"Name": "Grant"},
                  "Grant_Start_Date__c": "2026-01-01", "Grant_End_Date__c": None})
        result = await _validate_stage_change_logic(OPP_ID, COLLECTING, sf)
        assert result["action_required"] == "set_grant_period"

    @pytest.mark.asyncio
    async def test_grant_with_dates_moves_on_to_payment_check(self):
        sf = _sf(
            {"Id": OPP_ID, "Amount": 1000, "RecordType": {"Name": "Grant"},
             "Grant_Start_Date__c": "2026-01-01", "Grant_End_Date__c": "2027-12-31"},
            payments=[{"npe01__Payment_Amount__c": 1000}],
        )
        result = await _validate_stage_change_logic(OPP_ID, COLLECTING, sf)
        assert result["can_proceed"] is True

    @pytest.mark.asyncio
    async def test_donation_without_dates_not_blocked_by_grant_rule(self):
        sf = _sf(
            {"Id": OPP_ID, "Amount": 500, "RecordType": {"Name": "Donation"},
             "Grant_Start_Date__c": None, "Grant_End_Date__c": None},
            payments=[{"npe01__Payment_Amount__c": 500}],
        )
        result = await _validate_stage_change_logic(OPP_ID, COLLECTING, sf)
        assert result["can_proceed"] is True

    @pytest.mark.asyncio
    async def test_other_stages_skip_validation(self):
        sf = MagicMock()
        sf.query = AsyncMock()
        result = await _validate_stage_change_logic(OPP_ID, "Contracting", sf)
        assert result["can_proceed"] is True
        sf.query.assert_not_awaited()
