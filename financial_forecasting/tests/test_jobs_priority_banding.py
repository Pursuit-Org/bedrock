"""Regression guards for the My Network priority banding.

WHY THIS FILE EXISTS: the banding is a hand-written SQL CASE with seven branches
whose ORDER carries the meaning. Two silent bugs shipped into it on 2026-08-05 and
neither was visible by reading the code:

  1. `(col = 'x')::int` is NULL when the column is NULL, which makes the whole sum
     NULL and every comparison against it NULL. 1,083 contacts fell to unranked
     despite meeting the other two criteria.
  2. `ILIKE '%pursuit%'` also matches "In Wild Pursuit", a real founder lead.

Both were caught by comparing the SQL against an independent implementation of the
rule over every network row. That comparison is the second test here.

Two layers:

  * test_ordering_invariants — pure, no database. Asserts the branch ORDER that
    makes the rule mean what it says. Runs anywhere, including CI if it ever exists.
  * test_matches_reference_implementation — needs a live segundo-db. Skips cleanly
    without one. This is the one that catches a NULL-propagation or regex bug.

The reference implementation is deliberately written from the RULE, not derived from
the SQL — a copy of the SQL would agree with itself and prove nothing.
"""
import os
import re

import pytest

from routes.jobs import (
    _ACCOUNT_FLOOR_BAND,
    _PORTCO_EXISTS,
    _PRIORITY_HEADCOUNT,
    _PRIORITY_SENIORITY,
    _PRIORITY_SENIORITY_HEADCOUNT_WINDOW,
    _PRIORITY_SENIORITY_TOP,
    _PRIORITY_TRISTATE,
    _net_priority_case,
    _seniority_case,
    _tristate_case,
)

# ── layer 1: ordering invariants (no database) ───────────────────────────────


def test_ordering_invariants():
    """The branch order IS the rule. Reordering silently changes the meaning.

    Asserted by the relative position of each branch's distinctive marker rather
    than by counting WHENs: _seniority_case and _tristate_case are inlined into the
    expression and contribute their own WHENs (33 in total), so any count-based
    assertion here tests the shape of the generated string, not the invariant.
    """
    sql = _net_priority_case(_PORTCO_EXISTS, _ACCOUNT_FLOOR_BAND)

    def pos(needle: str) -> int:
        i = sql.find(needle)
        assert i != -1, f"{needle!r} missing from the CASE"
        return i

    exclusion = pos("^pursuit($|[^a-z])")
    portco = pos("company_investor")
    floor = pos("priority_account_floor")
    else_null = pos("ELSE NULL")

    # The exclusion must come FIRST: Pursuit staff and alumni are never banded, no
    # matter how well they score or which account they work at.
    assert exclusion < portco, "the Pursuit/alumni exclusion must precede every banding branch"
    assert exclusion < floor, "the exclusion must outrank the account floor"

    # The account floor must be LAST. "P2 minimum" is only true because every P1
    # path has already been taken by the time it runs — moved earlier it would
    # demote P1 rows to P2.
    assert floor > portco, "the account floor must come after the portco branches"
    assert floor < else_null, "the account floor must still be inside the CASE"

    # A row that matches nothing is unranked, not banded.
    assert sql.rstrip().endswith("ELSE NULL\nEND")


def test_exclusion_is_prefix_anchored_not_substring():
    """`ILIKE '%pursuit%'` also swallows 'In Wild Pursuit', a real founder lead."""
    sql = _net_priority_case()
    assert "^pursuit($|[^a-z])" in sql
    assert "%pursuit%" not in sql.lower()


def test_fit_terms_are_null_safe():
    """Every fit term must be coalesced before being summed.

    Without it a NULL size_bucket makes the sum NULL, every comparison against it
    NULL, and the row falls through to unranked — the 2026-08-05 bug that silently
    dropped 1,083 contacts.

    Counted as `coalesce(<anything>, false)` groups, not as a raw `false)::int`
    substring: the inlined tri-state and seniority CASEs also end in `false)::int`,
    so the naive count is 9 and asserting 3 fails on correct code.
    """
    sql = _net_priority_case()
    terms = re.findall(r"coalesce\((?:[^()]|\([^()]*\))*false\)", sql, re.DOTALL)
    assert len(terms) == 3, f"all three fit terms must be NULL-safe, found {len(terms)}"


def test_seniority_window_is_an_allow_list():
    """A size band added later must not silently start earning P1."""
    assert "1-10" not in _PRIORITY_SENIORITY_HEADCOUNT_WINDOW
    assert "5000+" not in _PRIORITY_SENIORITY_HEADCOUNT_WINDOW
    assert _PRIORITY_SENIORITY_TOP in ("Highest",)


def test_degrades_without_the_optional_tables():
    """Both optional tables absent must yield valid SQL, not a crash or a stray None."""
    sql = _net_priority_case(None, None)
    assert "None" not in sql
    assert "company_investor" not in sql
    assert "priority_account_floor" not in sql
    assert "false" in sql and "NULL::text" in sql


# ── layer 2: the SQL against an independent implementation of the rule ───────

NET_FROM = (
    "public.staff_contact_relationships r "
    "JOIN public.contacts c ON c.contact_id = r.contact_id "
    "LEFT JOIN public.companies co ON co.company_id = c.company_id"
)
LIVE = "coalesce(c.contact_stage,'') <> 'merged'"


def _conn():
    """A live segundo-db connection, or None so the test skips."""
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        env = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
        if os.path.exists(env):
            for line in open(env):
                if line.strip().startswith("DATABASE_URL="):
                    dsn = line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    if not dsn:
        return None
    try:
        import psycopg2
        import psycopg2.extras
        c = psycopg2.connect(dsn, connect_timeout=5)
        return c
    except Exception:
        return None


def _expected(row) -> str | None:
    """Jac's rule, written from the rule and NOT from the SQL.

    fits = headcount exactly 51-200 · tri-state Yes|Unknown · seniority High|Highest

        excluded (Pursuit / alumni)          -> unranked, always
        Highest seniority at 11-50..1001-5000 -> P1
        portfolio company and >=2 fits        -> P1
        portfolio company                     -> P2
        3 fits                                -> P1
        2 fits                                -> P2
        account floor                         -> its band
        otherwise                             -> unranked
    """
    company = (row["current_company"] or "").strip().lower()
    tags = row["tags"] or []
    is_pursuit = company == "pursuit" or (
        company.startswith("pursuit") and (len(company) == 7 or not company[7].isalpha()))
    if is_pursuit or any(t.startswith("alumni") for t in tags):
        return None
    if (row["seniority"] == _PRIORITY_SENIORITY_TOP
            and row["headcount_band"] in _PRIORITY_SENIORITY_HEADCOUNT_WINDOW):
        return "P1"
    fits = sum([
        row["headcount_band"] == _PRIORITY_HEADCOUNT,
        row["tristate"] in _PRIORITY_TRISTATE,
        row["seniority"] in _PRIORITY_SENIORITY,
    ])
    if row["is_portco"]:
        return "P1" if fits >= 2 else "P2"
    if fits == 3:
        return "P1"
    if fits == 2:
        return "P2"
    return row["floor_band"] or None


def test_matches_reference_implementation():
    """Every network row must band identically in SQL and in Python."""
    conn = _conn()
    if conn is None:
        pytest.skip("no reachable DATABASE_URL — this check needs live segundo-db")
    import psycopg2.extras
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cur.execute("SELECT to_regclass('bedrock.company_investor') IS NOT NULL AS x")
        has_portco = cur.fetchone()["x"]
        cur.execute("SELECT to_regclass('bedrock.priority_account_floor') IS NOT NULL AS x")
        has_floor = cur.fetchone()["x"]
        case = _net_priority_case(_PORTCO_EXISTS if has_portco else None,
                                  _ACCOUNT_FLOOR_BAND if has_floor else None)
        portco_sel = f"({_PORTCO_EXISTS})" if has_portco else "false"
        floor_sel = f"({_ACCOUNT_FLOOR_BAND})" if has_floor else "NULL::text"
        cur.execute(f"""
            SELECT c.contact_id, c.full_name, c.current_company, c.tags,
                   co.size_bucket AS headcount_band,
                   ({_tristate_case('co.hq_location')}) AS tristate,
                   ({_seniority_case('c.current_title')}) AS seniority,
                   {portco_sel} AS is_portco,
                   {floor_sel} AS floor_band,
                   ({case}) AS sql_band
              FROM {NET_FROM} WHERE {LIVE}
        """)
        rows = cur.fetchall()
    finally:
        conn.close()

    assert rows, "no network rows returned — fixture or permissions problem"
    bad = [r for r in rows if r["sql_band"] != _expected(r)]
    if bad:
        sample = "\n".join(
            f"  {r['full_name']!r} @ {r['current_company']!r} hc={r['headcount_band']!r} "
            f"tri={r['tristate']!r} sen={r['seniority']!r} portco={r['is_portco']} "
            f"floor={r['floor_band']!r} -> sql={r['sql_band']!r} expected={_expected(r)!r}"
            for r in bad[:8])
        pytest.fail(f"{len(bad)} of {len(rows)} rows band differently in SQL:\n{sample}")


def test_account_floor_never_demotes():
    """The floor may only RAISE an unranked row. It must never lower a P1."""
    conn = _conn()
    if conn is None:
        pytest.skip("no reachable DATABASE_URL — this check needs live segundo-db")
    cur = conn.cursor()
    try:
        cur.execute("SELECT to_regclass('bedrock.priority_account_floor') IS NOT NULL")
        if not cur.fetchone()[0]:
            pytest.skip("bedrock.priority_account_floor not applied")
        cur.execute("SELECT to_regclass('bedrock.company_investor') IS NOT NULL")
        portco = _PORTCO_EXISTS if cur.fetchone()[0] else None
        with_floor = _net_priority_case(portco, _ACCOUNT_FLOOR_BAND)
        without = _net_priority_case(portco, None)
        cur.execute(f"""
            SELECT count(*) FROM {NET_FROM}
             WHERE {LIVE}
               AND ({without}) = 'P1'
               AND coalesce(({with_floor}), 'zz') <> 'P1'
        """)
        demoted = cur.fetchone()[0]
    finally:
        conn.close()
    assert demoted == 0, f"{demoted} rows were demoted by the account floor"
