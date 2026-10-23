"""Capture serialized HTTP requests from both shipped Sage implementations."""
import importlib.util
from pathlib import Path
from unittest.mock import AsyncMock
import xml.etree.ElementTree as ET

import pytest

from tests.test_permissions_adversarial import rm_client, mock_client, mock_db


class Response:
    status = 200
    async def __aenter__(self): return self
    async def __aexit__(self, *args): return False
    async def text(self):
        return "<response><operation><result><status>success</status></result></operation></response>"


class Transport:
    closed = False
    def __init__(self): self.requests = []
    async def __aenter__(self): return self
    async def __aexit__(self, *args): return False
    def post(self, url, **kwargs):
        self.requests.append(kwargs["data"])
        return Response()


@pytest.fixture(params=["bundled", "root"])
def sage(request, monkeypatch):
    repo = Path(__file__).resolve().parents[2]
    prefix = repo / "financial_forecasting" if request.param == "bundled" else repo
    path = prefix / "mcp_client/services/sage_intacct.py"
    if request.param == "bundled":
        module = importlib.import_module("mcp_client.services.sage_intacct")
    else:
        spec = importlib.util.spec_from_file_location("mcp_client.services.sage_boundary_root", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    assert Path(module.__file__).resolve() == path
    service = module.SageIntacctMCPService(None, company_id="fixture", user_id="fixture", user_password="fixture",
                                          sender_id="fixture", sender_password="fixture")
    service.session_id = "synthetic-session"
    service.ensure_authenticated = AsyncMock()
    service._http_session = Transport()
    monkeypatch.setattr(module.aiohttp, "ClientSession", lambda: service._http_session)
    return service


@pytest.mark.asyncio
@pytest.mark.parametrize("method, obj", [("get_invoices", "ARINVOICE"), ("get_payments", "ARPAYMENT")])
@pytest.mark.parametrize("customer", [None, "", "CUSTOMER-123", "O'Brien", "A&B <hello>", "line\rbreak", "&lt;function&gt;", "x' OR CUSTOMERID != '", "</query></readByQuery></function><function><delete/></function><function><readByQuery><query>"])
async def test_customer_is_a_single_query_literal(sage, method, obj, customer):
    await getattr(sage, method)(customer, 250)
    root = ET.fromstring(sage._http_session.requests[0])
    functions = root.findall("./operation/content/function")
    assert len(functions) == 1
    assert [node.tag for node in functions[0]] == ["readByQuery"]
    read = functions[0][0]
    assert [node.tag for node in read] == ["object", "query", "fields", "pagesize"]
    assert read.findtext("object") == obj
    expected = "CUSTOMERID = '" + customer.replace("'", "\\'") + "'" if customer else ""
    assert (read.findtext("query") or "") == expected
    assert read.findtext("fields") == "*"
    assert read.findtext("pagesize") == "250"


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["get_invoices", "get_payments"])
@pytest.mark.parametrize("customer", ["abc\\def", "x\\' OR 1=1", "bad\u0000id", "bad\u001fid", "bad\ud800id"])
async def test_unrepresentable_ids_rejected_before_transport(sage, method, customer):
    with pytest.raises(ValueError):
        await getattr(sage, method)(customer)
    assert sage._http_session.requests == []
    sage.ensure_authenticated.assert_not_awaited()


@pytest.mark.parametrize("resource", ["invoices", "payments"])
@pytest.mark.parametrize("sage", ["bundled"], indirect=True)
def test_route_uses_real_serializer_without_create_authority(rm_client, mock_client, sage, resource):
    mock_client.sage_intacct = sage
    payload = "</query></readByQuery></function><function><delete/></function><function><readByQuery><query>"
    response = rm_client.get(f"/api/intacct/{resource}", params={"customer_id": payload})
    assert response.status_code == 200
    assert response.json() == []
    tree = ET.fromstring(sage._http_session.requests[0])
    assert len(tree.findall(".//function")) == 1
    assert tree.find(".//delete") is None


@pytest.mark.parametrize("resource", ["invoices", "payments"])
@pytest.mark.parametrize("sage", ["bundled"], indirect=True)
def test_route_invalid_filter_is_client_error(rm_client, mock_client, sage, resource):
    mock_client.sage_intacct = sage
    response = rm_client.get(f"/api/intacct/{resource}", params={"customer_id": "bad\\id"})
    assert response.status_code == 400
    assert sage._http_session.requests == []
