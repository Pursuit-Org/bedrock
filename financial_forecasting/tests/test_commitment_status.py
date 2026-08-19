"""Tests for services.commitment_status — pure function, no DB.

Table-driven cases for: no progress logged yet, on-pace, ahead, behind,
post-deadline incomplete, post-deadline complete, qualitative
not-started -> in-progress -> met progression, the not-met terminal
override, and a degenerate (zero) target.
"""

import sys
import os
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services.commitment_status import compute_commitment_status


START = date(2026, 1, 1)
DEADLINE = date(2027, 1, 1)  # 365-day window
TODAY = date(2026, 7, 2)  # ~50% elapsed


class TestQuantitative:

    def test_no_progress_logged_yet_is_under(self):
        # ~50% elapsed, 0% progress -> well below the band -> under.
        status = compute_commitment_status(
            commitment_type="quantitative",
            target_value=100,
            latest_value=None,
            latest_qualitative_status=None,
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "under"

    def test_on_pace_is_on_track(self):
        status = compute_commitment_status(
            commitment_type="quantitative",
            target_value=100,
            latest_value=50,  # ~50% progress at ~50% elapsed
            latest_qualitative_status=None,
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "on-track"

    def test_well_ahead_of_pace_is_ahead(self):
        status = compute_commitment_status(
            commitment_type="quantitative",
            target_value=100,
            latest_value=90,  # 90% progress at ~50% elapsed
            latest_qualitative_status=None,
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "ahead"

    def test_well_behind_pace_is_under(self):
        status = compute_commitment_status(
            commitment_type="quantitative",
            target_value=100,
            latest_value=10,  # 10% progress at ~50% elapsed
            latest_qualitative_status=None,
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "under"

    def test_target_hit_before_deadline_is_complete(self):
        status = compute_commitment_status(
            commitment_type="quantitative",
            target_value=100,
            latest_value=100,
            latest_qualitative_status=None,
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "complete"

    def test_overshoot_is_still_complete(self):
        status = compute_commitment_status(
            commitment_type="quantitative",
            target_value=100,
            latest_value=140,
            latest_qualitative_status=None,
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "complete"

    def test_past_deadline_incomplete_is_under(self):
        status = compute_commitment_status(
            commitment_type="quantitative",
            target_value=100,
            latest_value=80,
            latest_qualitative_status=None,
            start_date=START,
            deadline=DEADLINE,
            today=date(2027, 2, 1),  # after deadline
        )
        assert status == "under"

    def test_past_deadline_complete_is_still_complete(self):
        status = compute_commitment_status(
            commitment_type="quantitative",
            target_value=100,
            latest_value=100,
            latest_qualitative_status=None,
            start_date=START,
            deadline=DEADLINE,
            today=date(2027, 2, 1),
        )
        assert status == "complete"

    def test_degenerate_zero_target_is_complete(self):
        status = compute_commitment_status(
            commitment_type="quantitative",
            target_value=0,
            latest_value=0,
            latest_qualitative_status=None,
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "complete"


class TestQualitative:

    def test_not_started_partway_through_is_under(self):
        # not-started -> progress weight 0.0, ~50% elapsed -> under.
        status = compute_commitment_status(
            commitment_type="qualitative",
            target_value=None,
            latest_value=None,
            latest_qualitative_status="not-started",
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "under"

    def test_in_progress_at_midpoint_is_on_track(self):
        # in-progress -> weight 0.5, ~50% elapsed -> on-track.
        status = compute_commitment_status(
            commitment_type="qualitative",
            target_value=None,
            latest_value=None,
            latest_qualitative_status="in-progress",
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "on-track"

    def test_in_progress_early_is_ahead(self):
        # in-progress -> weight 0.5, but only ~10% elapsed -> ahead.
        status = compute_commitment_status(
            commitment_type="qualitative",
            target_value=None,
            latest_value=None,
            latest_qualitative_status="in-progress",
            start_date=START,
            deadline=DEADLINE,
            today=date(2026, 2, 5),
        )
        assert status == "ahead"

    def test_met_is_complete_even_before_deadline(self):
        status = compute_commitment_status(
            commitment_type="qualitative",
            target_value=None,
            latest_value=None,
            latest_qualitative_status="met",
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "complete"

    def test_not_met_is_under_even_before_deadline(self):
        # Terminal override — a confirmed miss doesn't wait for the date.
        status = compute_commitment_status(
            commitment_type="qualitative",
            target_value=None,
            latest_value=None,
            latest_qualitative_status="not-met",
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "under"

    def test_no_log_yet_defaults_to_not_started(self):
        status = compute_commitment_status(
            commitment_type="qualitative",
            target_value=None,
            latest_value=None,
            latest_qualitative_status=None,
            start_date=START,
            deadline=DEADLINE,
            today=TODAY,
        )
        assert status == "under"
