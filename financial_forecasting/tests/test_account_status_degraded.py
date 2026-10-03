"""_attach_account_status when the bedrock DB is unreachable.

#291 made the status derivation survive a DB outage. Review found that it
then produced confidently wrong statuses — an account with an active
award read "Prospect", one with recent activity "Dormant" — and cached
them for every user for CACHE_TTL_ACCOUNTS. Only the statuses Salesforce
alone can settle may be attached in that mode, and the caller is told not
to cache.
"""
import pytest

import main as main_module


class _FakeSF:
    def __init__(self, opps):
        self._opps = opps

    async def query_all(self, soql):
        return {"records": self._opps}


def _open_active(oid, acct):
    return {"Id": oid, "AccountId": acct, "StageName": "Ask in Progress",
            "IsClosed": False, "IsWon": False, "Active_Opportunity__c": True}


def _closed_won(oid, acct):
    return {"Id": oid, "AccountId": acct, "StageName": "Closed Won",
            "IsClosed": True, "IsWon": True, "Active_Opportunity__c": False}


@pytest.mark.asyncio
async def test_db_down_keeps_sf_only_statuses_and_leaves_the_rest_absent(monkeypatch):
    import db
    monkeypatch.setattr(db, "get_pool", lambda: None)
    accounts = [
        {"Id": "A_pursuing", "Active__c": True},
        {"Id": "A_onhold", "Active__c": True, "Qualification_Status__c": "Not Qualified"},
        {"Id": "A_deprioritized", "Active__c": False},
        # Closed-won opp: with the DB up this is Stewarding or Dormant
        # depending on award/activity rows we cannot see right now.
        {"Id": "A_won", "Active__c": True},
        # Nothing at all: with the DB up this would be Prospect — but a
        # Prospect verdict needs to know there are no awards, and we don't.
        {"Id": "A_nothing", "Active__c": True},
    ]
    sf = _FakeSF([_open_active("o1", "A_pursuing"), _closed_won("o2", "A_won")])

    complete = await main_module._attach_account_status(accounts, sf)

    assert complete is False
    by_id = {a["Id"]: a["account_status"] for a in accounts}
    assert by_id["A_pursuing"] == "Pursuing"
    assert by_id["A_onhold"] == "On Hold"
    assert by_id["A_deprioritized"] == "Deprioritized"
    assert by_id["A_won"] is None
    assert by_id["A_nothing"] is None


@pytest.mark.asyncio
async def test_db_up_attaches_every_status_and_reports_complete(monkeypatch):
    import db

    class _Conn:
        async def fetch(self, sql, *args):
            return []

    class _Acquire:
        async def __aenter__(self):
            return _Conn()

        async def __aexit__(self, *a):
            return False

    class _Pool:
        def acquire(self):
            return _Acquire()

    monkeypatch.setattr(db, "get_pool", lambda: _Pool())
    accounts = [{"Id": "A_nothing", "Active__c": True}]
    complete = await main_module._attach_account_status(accounts, _FakeSF([]))
    assert complete is True
    assert accounts[0]["account_status"] == "Prospect"
