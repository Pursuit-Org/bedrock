"""PRO-97: the Jobs numbers, their dictionary entries, and the shared rules.

No database. The dictionary drafts (db/dictionary/jobs_metrics.json) are what
Jac imports into bedrock.dd_metrics; these tests keep them, the registry in
services/jobs_metrics.py and the import script consistent with each other.
"""
from datetime import date, datetime, timedelta

import pytest

from scripts import import_jobs_dictionary as imp
from services import jobs_metrics as jm

DRAFTS = imp.load_drafts()
BY_KEY = {c["bedrock_key"]: c for c in DRAFTS["concepts"]}


def _cut(concept_key, cut_key):
    return next((m for m in BY_KEY[concept_key].get("cuts", []) if m["key"] == cut_key), None)


# ── the registry and the drafts agree ────────────────────────────────────────

def test_every_concept_bedrock_uses_is_drafted():
    assert set(jm.CONCEPTS) == set(BY_KEY)
    for key, concept in jm.CONCEPTS.items():
        assert BY_KEY[key]["name"] == concept.name
        assert BY_KEY[key].get("metric_id") == concept.metric_id


@pytest.mark.parametrize("key", sorted(jm.MEASURES) + sorted(jm.UNSHOWN_MEASURES))
def test_every_number_has_a_drafted_measure(key):
    m = jm.MEASURES.get(key) or jm.UNSHOWN_MEASURES[key]
    cut = _cut(m.concept, m.cut)
    assert cut is not None, f"{key}: no measure {m.cut!r} drafted under {m.concept!r}"
    assert cut["definition"].strip()
    # A reference query, or a stated reason there isn't one yet.
    assert cut["sql_query"] or cut.get("caveat"), f"{key}: no query and no caveat"
    if m.column and cut["sql_query"]:
        assert f"AS {m.column}" in cut["sql_query"]


def test_measure_keys_are_unique_within_a_concept():
    for c in DRAFTS["concepts"]:
        keys = [m["key"] for m in c.get("cuts", [])]
        assert len(keys) == len(set(keys)), c["name"]


def test_new_concepts_carry_what_the_ticket_asks_for():
    """Definition, what's counted, what it's divided by, its date, its slices."""
    for c in DRAFTS["concepts"]:
        if c.get("metric_id"):
            continue
        assert c["stage"] == "Jobs" and c["status"] == "draft" and c["definition"]
        for m in c.get("cuts", []):
            assert m["status"] in ("draft", "needs_review", "blocked", "confirmed")
            assert m.get("denominator"), f"{c['name']}.{m['key']}: say what it's divided by"


@pytest.mark.parametrize("cut", sorted(jm.OUTREACH_COLUMNS))
def test_outreach_queries_are_the_counting_module(cut):
    """The dictionary holds outreach_counting's rules, not a copy that
    drifts. If this fails, regenerate the outreach queries in the JSON from
    jobs_metrics.dictionary_outreach_sql."""
    assert _cut("employer_outreach", cut)["sql_query"] == jm.dictionary_outreach_sql(cut).strip()


def test_depth_query_is_the_counting_module():
    assert _cut("employer_outreach", "activity_depth")["sql_query"] == jm.dictionary_depth_sql().strip()


def test_placement_queries_apply_the_whole_rule():
    """Each placement measure filters on every part of the rule Nina settled
    on 10/7, the same parts counts_as_placement checks."""
    for concept, cut in [("employment", "ever_employed_count"), ("employment", "builders_with_paid_work"),
                         ("employment", "actively_employed_count"), ("salary", "avg_ft_salary_placed"),
                         ("salary", "avg_ft_salary_secured"), ("employment", "ft_roles_secured")]:
        sql = _cut(concept, cut)["sql_query"]
        for part in ("exclude_from_metrics", "payment_amount > 0", "'pro_bono'", "'pipeline'",
                     "start_date", "deleted_at IS NOT NULL"):
            assert part in sql, f"{concept}.{cut} misses {part}"
        assert "u.role" not in sql, "Pursuit's own hires count whatever their role is now"


def test_stalled_queries_use_the_d3_limits_and_skip_comments():
    p = "employer_pipeline"
    assert "interval '4 weeks'" in _cut(p, "stalled_opportunities")["sql_query"]
    assert "interval '2 weeks'" in _cut(p, "stalled_contacts")["sql_query"]
    assert "interval '6 weeks'" in _cut(p, "stalled_accounts")["sql_query"]
    for k in ("stalled_opportunities", "stalled_contacts", "stalled_accounts"):
        assert "'note'" not in _cut(p, k)["sql_query"]
        assert "a.type IN ('email', 'call', 'meeting', 'linkedin', 'text')" in _cut(p, k)["sql_query"]


def test_windowed_queries_read_the_dictionary_window():
    for c in DRAFTS["concepts"]:
        for m in c.get("cuts", []):
            sql = m["sql_query"]
            if "FROM w)" in sql and ("start_at FROM w" in sql or "end_at FROM w" in sql):
                assert sql.startswith("WITH w AS (") and "dd.window_from" in sql, m["key"]


# ── define(): the words come only from the dictionary ────────────────────────

@pytest.fixture
def dictionary():
    jm.reset()
    yield
    jm.reset()


def test_a_number_not_yet_in_the_dictionary_says_so(dictionary):
    d = jm.define("outreach", value=56)
    assert d["status"] == "not_in_dictionary"
    assert d["definition"] is None and d["value"] == 56
    assert d["concept"] == "Employer outreach" and d["measure"] == "outreach_sent"


def test_a_number_reads_its_definition_and_status(dictionary):
    jm.load([{"metric_id": 171, "name": "Employment", "status": "draft", "definition": "concept words",
              "cuts": '[{"key": "ever_employed_count", "label": "Placed (ever)", "status": "confirmed",'
                      ' "definition": "measure words", "numerator": "n", "denominator": "d"}]'}])
    start, end = jm.date_window("2026-09-21", "2026-09-27")
    d = jm.define("placed_ft", value=14, window=(start, end), filters={"segment": "all", "owner": "a@x"},
                  records={"endpoint": "/api/jobs/metrics/placements", "params": {}})
    assert d["definition"] == "measure words" and d["status"] == "confirmed"
    assert d["metric_id"] == 171 and d["column"] == "full_time"
    assert d["window"] == {"from": "2026-09-21", "to": "2026-09-27", "tz": "America/New_York"}
    assert d["filters"] == {"owner": "a@x"}          # "all" is no filter


def test_a_concept_without_the_measure_falls_back_to_its_words(dictionary):
    jm.load([{"metric_id": 171, "name": "Employment", "status": "draft", "definition": "concept words",
              "cuts": []}])
    d = jm.define("placed_ft")
    assert d["status"] == "measure_not_in_dictionary" and d["definition"] == "concept words"


def test_unknown_numbers_are_a_programming_error():
    with pytest.raises(KeyError):
        jm.define("no_such_number")


# ── the week (D8) ────────────────────────────────────────────────────────────

def test_meeting_weeks():
    wed = date(2026, 10, 7)
    assert jm.meeting_week("monday", wed) == (date(2026, 9, 28), date(2026, 10, 4))
    assert jm.meeting_week("thursday", wed) == (date(2026, 10, 5), date(2026, 10, 11))
    assert jm.meeting_week("monday", date(2026, 10, 5)) == (date(2026, 9, 28), date(2026, 10, 4))
    assert jm.calendar_week(date(2026, 10, 11)) == (date(2026, 10, 5), date(2026, 10, 11))


def test_date_window_is_new_york_days_inclusive():
    start, end = jm.date_window("2026-09-21", "2026-09-27")
    assert start.isoformat() == "2026-09-21T00:00:00-04:00"
    assert end.isoformat() == "2026-09-28T00:00:00-04:00"
    with pytest.raises(ValueError):
        jm.date_window("2026-09-27", "2026-09-21")


def test_prior_window_counts_days_across_a_clock_change():
    start, end = jm.date_window("2026-11-02", "2026-11-08")       # the week after DST ends
    p_start, p_end = jm.prior_window(start, end)
    assert p_start.isoformat() == "2026-10-26T00:00:00-04:00"
    assert p_end == start


# ── stalled (D3) ─────────────────────────────────────────────────────────────

def test_stalled_limits():
    now = datetime(2026, 10, 7, 12, tzinfo=jm.NY)
    assert jm.is_stalled("opportunity", now - timedelta(days=29), now)
    assert not jm.is_stalled("opportunity", now - timedelta(days=28), now)
    assert jm.is_stalled("contact", now - timedelta(days=15), now)
    assert not jm.is_stalled("account", now - timedelta(days=41), now)
    assert jm.is_stalled("account", None, now)
    assert jm.stalled_label("opportunity") == "No activity in 4+ weeks"


def test_comments_are_not_activity():
    sql = jm.external_activity_sql("a")
    assert "'note'" not in sql and "a.type IN ('email', 'call', 'meeting', 'linkedin', 'text')" in sql


# ── placed and paid work ─────────────────────────────────────────────────────

TODAY = date(2026, 10, 7)


def _job(uid, **kw):
    base = dict(id=uid, user_id=uid, employment_type="full_time", engagement_stage="active",
                payment_amount=80000, start_date=date(2026, 7, 1), end_date=None,
                influenced=True, excluded=False)
    base.update(kw)
    return base


def test_the_placement_rule():
    rows = [
        _job(1),                                                    # counts
        _job(2, excluded=True),                                     # test account
        _job(3, payment_amount=None, employment_type="contract"),   # unpriced
        _job(4, employment_type="pro_bono"),
        _job(5, engagement_stage="pipeline"),                       # not a job yet
        _job(6, start_date=date(2026, 11, 1)),                      # not started
        _job(7, start_date=None),                                   # counts; date is a gap
        _job(8, employment_type="contract", payment_amount=12000),  # paid, not FT
        _job(9, engagement_stage="ended"),                          # left: still placed
        _job(9, id=99, employment_type="contract", payment_amount=5000),
    ]
    p = jm.placements(rows, today=TODAY)
    assert p.ft_uids == {1, 7, 9}
    assert p.paid_uids == {1, 7, 8, 9}
    assert p.ft_no_longer_in_role == 1
    assert p.avg_ft_salary_placed == 80000
    assert p.avg_ft_salary_secured([100000, None]) == 85000
    assert jm.placements(rows, user_ids={1, 8}, today=TODAY).paid_uids == {1, 8}


def test_in_role_honours_an_end_date():
    assert jm.in_role(_job(1, end_date=date(2026, 10, 7)), TODAY)
    assert not jm.in_role(_job(1, end_date=date(2026, 10, 6)), TODAY)
    assert not jm.in_role(_job(1, engagement_stage="completed"), TODAY)


def test_committed_roles_are_one_rule():
    sql = jm.committed_roles_sql("count(*)")
    for part in ("r.status = 'open'", "o.deleted_at IS NULL", "r.commitment = 'committed'",
                 "r.is_trial = false", "o.deal_type = 'ft'"):
        assert part in sql


# ── the import script ────────────────────────────────────────────────────────

def test_import_merges_measures_by_key_and_keeps_the_rest():
    live = [{"key": "a", "label": "A", "status": "draft", "definition": "old", "last_result": {"n": 1}},
            {"key": "b", "label": "B", "status": "draft"}]
    merged, skipped = imp.merge_cuts(live, [{"key": "a", "label": "A", "status": "draft", "definition": "new"},
                                            {"key": "c", "label": "C", "status": "draft"}])
    assert [m["key"] for m in merged] == ["a", "b", "c"]
    assert merged[0]["definition"] == "new" and merged[0]["last_result"] == {"n": 1}
    assert skipped == []


def test_import_replaces_a_hand_entered_measure_by_its_label():
    live = [{"key": "cut_4_mqtpsi60", "label": "Outreach", "status": "draft"}]
    merged, _ = imp.merge_cuts(live, [{"key": "outreach_sent", "label": "Outreach", "status": "draft"}])
    assert [m["key"] for m in merged] == ["outreach_sent"]


def test_import_never_touches_what_the_group_confirmed():
    live_row = {"metric_id": 171, "name": "Employment", "status": "confirmed", "definition": "signed off",
                "caveats": "c", "cuts": [{"key": "a", "label": "A", "status": "confirmed", "definition": "x"}]}
    concept = {"definition": "draft words", "caveats_append": "more",
               "cuts": [{"key": "a", "label": "A", "status": "draft", "definition": "y"}]}
    row, notes = imp.target_row(concept, live_row)
    assert row["definition"] == "signed off" and row["caveats"] == "c"
    assert row["cuts"][0]["definition"] == "x"
    assert len(notes) == 2


def test_import_appends_caveats_once():
    live_row = {"metric_id": 164, "status": "draft", "caveats": "old", "cuts": []}
    row, _ = imp.target_row({"caveats_append": "new"}, live_row)
    assert row["caveats"] == "old\n\nnew"
    row2, _ = imp.target_row({"caveats_append": "new"}, row)
    assert row2["caveats"] == "old\n\nnew"


def test_markdown_copy_is_current():
    """The readable copy is generated; regenerate it after editing the JSON:
    python -m scripts.import_jobs_dictionary --markdown db/dictionary/jobs_metrics.md"""
    assert imp.DRAFTS.with_suffix(".md").read_text(encoding="utf-8") == imp.markdown(DRAFTS)


# ── the checks: dictionary query vs Bedrock's calculation ────────────────────

from scripts import check_jobs_metrics as check  # noqa: E402


@pytest.mark.parametrize("chk", check.CHECKS, ids=lambda c: c.number)
def test_each_check_reads_a_real_column_of_its_reference_query(chk):
    sql = check._reference_sql(chk.number, DRAFTS)
    assert sql and f"AS {chk.column}" in sql


def test_every_single_value_number_on_the_tabs_is_checked():
    """Numbers whose reference query returns one row are compared one to one.
    The rest (stage tables, buckets, targets) are listed so the gap is known."""
    checked = {c.number for c in check.CHECKS}
    not_single = {"contacts_by_stage", "contacts_entering_stage", "opportunities_by_stage",
                  "opportunities_entering_stage", "time_in_stage", "activity_depth",
                  "contact_cohort_conversion", "stage_flow_conversion", "opportunity_stage_ratio",
                  "campaign_contacts", "campaign_accounts", "campaign_reached", "campaign_conversion",
                  "activity_target", "jobs_projection", "contacted", "won_open_tasks"}
    assert set(jm.MEASURES) - checked == not_single


@pytest.mark.skipif(not __import__("os").environ.get("CHECK_DATABASE_URL"),
                    reason="needs CHECK_DATABASE_URL (a login that can read public.users)")
def test_dictionary_and_bedrock_agree_on_the_last_week():
    import asyncio
    import asyncpg
    from services import jobs_targets_store

    async def run():
        import os
        pool = await asyncpg.create_pool(os.environ["CHECK_DATABASE_URL"], min_size=1, max_size=2)
        try:
            await jobs_targets_store.refresh(pool, force=True)
            async with pool.acquire() as conn:
                d_from, d_to = jm.meeting_week("monday")
                return await check.compare(conn, d_from, d_to)
        finally:
            await pool.close()

    results = asyncio.run(run())
    assert [r for r in results if not r["match"]] == []
