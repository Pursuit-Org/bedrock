"""PRO-105: every Jobs list says how it picks its rows ("Why these?").

The words live in services/jobs_lists.py. These keep them complete and keep
the frontend from asking for a list that has none.
"""
import re
from pathlib import Path

import pytest

from services import jobs_lists
from tests.jobs_fakes import FakeConn, make_jobs_client

FRONTEND = Path(__file__).resolve().parent.parent / "frontend-v2" / "src"


@pytest.fixture(autouse=True)
def _clear():
    from main import app
    yield
    app.dependency_overrides.clear()


@pytest.mark.parametrize("key", sorted(jobs_lists.LISTS))
def test_every_list_says_who_order_cap_and_dates(key):
    e = jobs_lists.LISTS[key]
    assert set(e) == set(jobs_lists.FIELDS), key
    assert e["who"] and e["order"] and e["cap"], key
    assert isinstance(e["dates"], list) and isinstance(e["notes"], list), key


def test_every_list_the_frontend_asks_for_has_words():
    asked = set()
    for f in FRONTEND.rglob("*.tsx"):
        text = f.read_text(encoding="utf-8")
        asked |= set(re.findall(r'listKey="([a-z_]+)"', text))
        asked |= set(re.findall(r'\bwhy="([a-z_]+)"', text))
    assert asked, "no ListWhy in the frontend"
    assert asked <= set(jobs_lists.LISTS), asked - set(jobs_lists.LISTS)


def test_the_page_reads_them_in_one_call():
    r = make_jobs_client(FakeConn()).get("/api/jobs/lists/why")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert set(d) == set(jobs_lists.LISTS)
    assert d["replied_needs_decision"]["key"] == "replied_needs_decision"


def test_every_list_note_is_shown_somewhere():
    """A note no page asks for is a list that lost its button."""
    asked = set()
    for f in FRONTEND.rglob("*.tsx"):
        text = f.read_text(encoding="utf-8")
        asked |= set(re.findall(r'listKey="([a-z_]+)"', text))
        asked |= set(re.findall(r'\bwhy="([a-z_]+)"', text))
    assert set(jobs_lists.LISTS) <= asked, set(jobs_lists.LISTS) - asked
