"""Regression evals for the Revisit reminder task (routes/jobs.py).

Revisit shipped broken and stayed broken: `_ensure_revisit_task` took the
date as a 'YYYY-MM-DD' *string* and bound it to a `$n::date` parameter.
asyncpg does not coerce there — it raises

    DataError: invalid input for query argument $4: '2026-10-08'
               ('str' object has no attribute 'toordinal')

and because that call sits inside the same transaction as the stage UPDATE,
the error rolled back a write that had already succeeded. Every Revisit
500'd and the contact never moved. Production showed it plainly: 0 rows with
a revisit_date table-wide and 0 'Revisit:%' tasks out of 68.

Neither gate that ran caught it. py_compile can't see it, and FakeConn
records arguments without type-checking them — so these tests assert the
bound argument's *type*, which is the thing that actually broke.
"""
from datetime import date

import pytest

from tests.jobs_fakes import FakeConn

TASK_LOOKUP = "FROM bedrock.jobs_task"
CONTACT_LOOKUP = "FROM bedrock.jobs_contact_membership m"


def _conn(existing_task_id=None):
    return FakeConn(
        rows={CONTACT_LOOKUP: {
            "owner_email": "rm@pursuit.org",
            "full_name": "Margaret Werner",
            "current_company": "Apollo",
        }},
        vals={TASK_LOOKUP: existing_task_id},
    )


def _deadline_args(conn):
    """Args of the statement that writes jobs_task.deadline."""
    writes = [c for c in conn.calls
              if c[0] == "execute" and "bedrock.jobs_task" in c[1] and "deadline" in c[1]]
    assert writes, f"no jobs_task deadline write ran; calls={[c[1][:60] for c in conn.calls]}"
    return writes[0][2]


@pytest.mark.asyncio
async def test_insert_binds_a_date_object_not_a_string():
    from routes.jobs import _ensure_revisit_task
    conn = _conn(existing_task_id=None)

    await _ensure_revisit_task(conn, 4242, date(2026, 10, 8), "rm@pursuit.org")

    args = _deadline_args(conn)
    assert date(2026, 10, 8) in args, f"deadline not bound as a date: {args}"
    assert "2026-10-08" not in args, "deadline bound as a str — asyncpg will DataError on $n::date"


@pytest.mark.asyncio
async def test_update_of_existing_task_binds_a_date_object():
    from routes.jobs import _ensure_revisit_task
    conn = _conn(existing_task_id="task-1")

    await _ensure_revisit_task(conn, 4242, date(2026, 10, 8), "rm@pursuit.org")

    args = _deadline_args(conn)
    assert date(2026, 10, 8) in args, f"deadline not bound as a date: {args}"
    assert "2026-10-08" not in args


@pytest.mark.asyncio
async def test_task_titled_from_contact_and_company():
    from routes.jobs import _ensure_revisit_task
    conn = _conn(existing_task_id=None)

    await _ensure_revisit_task(conn, 4242, date(2026, 10, 8), "rm@pursuit.org")

    assert "Revisit: Margaret Werner, Apollo" in _deadline_args(conn)


@pytest.mark.asyncio
async def test_endpoint_parses_revisit_date_before_calling(monkeypatch):
    """The endpoint owns the str -> date conversion; this is where it broke."""
    import routes.jobs as jobs

    captured = {}

    async def _spy(conn, contact_id, when, actor):
        captured["when"] = when

    monkeypatch.setattr(jobs, "_ensure_revisit_task", _spy)
    monkeypatch.setattr(jobs, "has_membership_history", lambda conn: _false())
    # Skip the information_schema probe (_has_column hits the real pool).
    jobs._COLUMN_CACHE[("bedrock", "jobs_contact_membership", "revisit_date")] = True

    conn = FakeConn(vals={"SELECT stage FROM bedrock.jobs_contact_membership": "assigned"})
    await jobs.update_jobs_membership(
        4242,
        jobs.MembershipPatch(stage="revisit", revisit_date="2026-10-08"),
        user={"email": "rm@pursuit.org"},
        conn=conn,
    )

    assert isinstance(captured.get("when"), date), (
        f"endpoint passed {type(captured.get('when')).__name__}, not a date — "
        "this is the exact regression that made every Revisit 500"
    )
    assert captured["when"] == date(2026, 10, 8)


async def _false():
    return False


@pytest.mark.asyncio
async def test_malformed_revisit_date_is_a_400_not_a_500():
    import routes.jobs as jobs
    from fastapi import HTTPException

    conn = FakeConn(vals={"SELECT stage FROM bedrock.jobs_contact_membership": "assigned"})
    with pytest.raises(HTTPException) as exc:
        await jobs.update_jobs_membership(
            4242,
            jobs.MembershipPatch(stage="revisit", revisit_date="08/10/2026"),
            user={"email": "rm@pursuit.org"},
            conn=conn,
        )
    assert exc.value.status_code == 400
