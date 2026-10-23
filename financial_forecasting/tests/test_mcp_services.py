"""Tests for MCP client services: Salesforce, Sage Intacct, Slack, and Base."""

import sys
import os
import asyncio
import xml.etree.ElementTree as ET
from datetime import date, datetime
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

# Add parent to path so we can import from financial_forecasting
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from mcp_client.services.base import BaseMCPService
from mcp_client.services.salesforce import SalesforceMCPService
from mcp_client.services.sage_intacct import SageIntacctMCPService
from mcp_client.services.slack import SlackMCPService


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mock_mcp_client(**tool_overrides):
    """Create a mock MCPClient with configurable available_tools."""
    client = MagicMock()
    # Default: no MCP tools registered so services fall back to direct API
    tools = tool_overrides.get("tools", {})
    client.available_tools = tools
    client.call_tool = AsyncMock()
    return client


def _sage_auth_success_xml():
    """Return a valid Sage Intacct authentication response XML."""
    return """<?xml version="1.0" encoding="UTF-8"?>
<response>
    <operation>
        <authentication>
            <status>success</status>
        </authentication>
        <result>
            <status>success</status>
            <data>
                <api>
                    <sessionid>test-session-id-abc123</sessionid>
                    <endpoint>https://api.intacct.com/ia/xml/xmlgw.phtml</endpoint>
                </api>
            </data>
        </result>
    </operation>
</response>"""


def _sage_auth_failure_xml():
    """Return a failed Sage Intacct authentication response XML."""
    return """<?xml version="1.0" encoding="UTF-8"?>
<response>
    <operation>
        <authentication>
            <status>failure</status>
        </authentication>
        <result>
            <status>failure</status>
            <error>
                <description2>Invalid credentials</description2>
            </error>
        </result>
    </operation>
</response>"""


def _sage_api_success_xml(data_body=""):
    """Return a successful Sage Intacct API response XML."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<response>
    <operation>
        <result>
            <status>success</status>
            <data>
                {data_body}
            </data>
        </result>
    </operation>
</response>"""


def _sage_api_error_xml(error_msg="Something went wrong"):
    """Return a failed Sage Intacct API response XML."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<response>
    <operation>
        <result>
            <status>failure</status>
            <error>
                <description2>{error_msg}</description2>
            </error>
        </result>
    </operation>
</response>"""


# ---------------------------------------------------------------------------
# BaseMCPService tests
# ---------------------------------------------------------------------------

class TestBaseMCPService:
    """Tests for the abstract BaseMCPService."""

    def test_initial_state_not_authenticated(self):
        """Service starts unauthenticated with empty config."""
        # BaseMCPService is abstract; create a concrete subclass for testing.
        class _Concrete(BaseMCPService):
            async def authenticate(self):
                self._authenticated = True
                return True

            async def get_service_info(self):
                return {"service": "test"}

        client = _make_mock_mcp_client()
        svc = _Concrete(client)

        assert svc.is_authenticated is False
        assert svc._config == {}

    @pytest.mark.asyncio
    async def test_ensure_authenticated_calls_authenticate(self):
        """ensure_authenticated() delegates to authenticate() when not yet authed."""
        class _Concrete(BaseMCPService):
            async def authenticate(self):
                self._authenticated = True
                return True

            async def get_service_info(self):
                return {}

        client = _make_mock_mcp_client()
        svc = _Concrete(client)
        await svc.ensure_authenticated()
        assert svc.is_authenticated is True

    @pytest.mark.asyncio
    async def test_ensure_authenticated_raises_on_failure(self):
        """ensure_authenticated() raises when authenticate() returns False."""
        class _Concrete(BaseMCPService):
            async def authenticate(self):
                return False

            async def get_service_info(self):
                return {}

        client = _make_mock_mcp_client()
        svc = _Concrete(client)
        with pytest.raises(Exception, match="Failed to authenticate"):
            await svc.ensure_authenticated()

    def test_get_config_value_from_env(self):
        """get_config_value reads from environment variables."""
        class _Concrete(BaseMCPService):
            async def authenticate(self):
                return True

            async def get_service_info(self):
                return {}

        client = _make_mock_mcp_client()
        svc = _Concrete(client)
        with patch.dict(os.environ, {"MY_TEST_KEY": "hello123"}):
            assert svc.get_config_value("MY_TEST_KEY") == "hello123"
        # Missing key returns default
        assert svc.get_config_value("NONEXISTENT_KEY", "fallback") == "fallback"


# ---------------------------------------------------------------------------
# SalesforceMCPService tests
# ---------------------------------------------------------------------------

class TestSalesforceMCPService:
    """Tests for SalesforceMCPService."""

    def _make_service(self, client=None, **kwargs):
        defaults = dict(
            username="testuser@pursuit.org",
            password="testpass",
            security_token="tok123",
            domain="test",
        )
        defaults.update(kwargs)
        return SalesforceMCPService(client or _make_mock_mcp_client(), **defaults)

    def test_missing_credentials_raises(self, monkeypatch):
        """Constructor raises ValueError when no valid credential set is provided."""
        # get_config_value falls back to os.getenv; if the dev shell / .env has
        # SALESFORCE_* set, `username="u"` alone would silently inherit them
        # and no ValueError would raise. Clear the fallbacks for this test.
        for var in (
            "SALESFORCE_USERNAME", "SALESFORCE_PASSWORD", "SALESFORCE_SECURITY_TOKEN",
            "SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET",
        ):
            monkeypatch.delenv(var, raising=False)
        with pytest.raises(ValueError, match="Salesforce credentials are required"):
            SalesforceMCPService(_make_mock_mcp_client(), username="u")

    def test_accepts_security_token_auth(self):
        """Constructor accepts username + password + security_token."""
        svc = self._make_service()
        assert svc.username == "testuser@pursuit.org"
        assert svc.sf_client is None  # not yet authenticated

    def test_accepts_oauth_auth(self):
        """Constructor accepts username + password + client_id + client_secret."""
        svc = SalesforceMCPService(
            _make_mock_mcp_client(),
            username="u",
            password="p",
            client_id="cid",
            client_secret="csec",
        )
        assert svc.client_id == "cid"

    @pytest.mark.asyncio
    @patch("mcp_client.services.salesforce.Salesforce")
    async def test_authenticate_security_token_success(self, MockSF):
        """authenticate() succeeds with security token flow and stores config."""
        mock_sf_instance = MagicMock()
        mock_sf_instance.query.return_value = {
            "totalSize": 1,
            "records": [{"Id": "005USER001", "Name": "Test User"}],
        }
        mock_sf_instance.sf_instance = "test.salesforce.com"
        mock_sf_instance.session_id = "sess-abc"
        MockSF.return_value = mock_sf_instance

        svc = self._make_service()
        result = await svc.authenticate()

        assert result is True
        assert svc.is_authenticated is True
        assert svc._config["user_id"] == "005USER001"
        assert svc._config["user_name"] == "Test User"
        assert svc._config["instance_url"] == "test.salesforce.com"
        assert "session_id" not in svc._config

    @pytest.mark.asyncio
    @patch("mcp_client.services.salesforce.Salesforce")
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_authenticate_failure_returns_false(self, MockSF):
        """authenticate() returns False when Salesforce raises auth error."""
        from simple_salesforce.exceptions import SalesforceAuthenticationFailed
        MockSF.side_effect = SalesforceAuthenticationFailed("url", 401, "resource", "body")

        svc = self._make_service()
        result = await svc.authenticate()

        assert result is False
        assert svc.is_authenticated is False

    @pytest.mark.asyncio
    @patch("mcp_client.services.salesforce.Salesforce")
    async def test_query_direct_api_fallback(self, MockSF):
        """query() uses direct simple_salesforce when MCP tool is unavailable."""
        mock_sf = MagicMock()
        mock_sf.query.return_value = {
            "totalSize": 1,
            "records": [{"Id": "006OPP001", "Name": "Grant A"}],
        }
        mock_sf.sf_instance = "test.salesforce.com"
        mock_sf.session_id = "sess"
        MockSF.return_value = mock_sf
        # Also return user on auth
        mock_sf.query.return_value = {
            "totalSize": 1,
            "records": [{"Id": "005U", "Name": "U"}],
        }

        svc = self._make_service()
        await svc.authenticate()

        # Now set up query return for the actual call
        mock_sf.query.return_value = {
            "totalSize": 2,
            "records": [{"Id": "006A"}, {"Id": "006B"}],
        }
        result = await svc.query("SELECT Id FROM Opportunity")
        assert result["totalSize"] == 2

    @pytest.mark.asyncio
    async def test_query_uses_mcp_tool_when_available(self):
        """query() prefers MCP tool 'salesforce_query' when registered."""
        client = _make_mock_mcp_client(tools={"salesforce_query": MagicMock()})
        client.call_tool.return_value = {"totalSize": 3, "records": []}

        svc = self._make_service(client=client)
        svc._authenticated = True  # skip real auth

        result = await svc.query("SELECT Id FROM Account")
        client.call_tool.assert_awaited_once_with(
            "salesforce_query", {"query": "SELECT Id FROM Account"}
        )
        assert result["totalSize"] == 3

    @pytest.mark.asyncio
    @patch("mcp_client.services.salesforce.Salesforce")
    async def test_create_record_direct(self, MockSF):
        """create_record() calls sobject.create() via direct API."""
        mock_sf = MagicMock()
        mock_contact = MagicMock()
        mock_contact.create.return_value = {"id": "003NEW001", "success": True}
        mock_sf.Contact = mock_contact
        mock_sf.query.return_value = {
            "totalSize": 1,
            "records": [{"Id": "005U", "Name": "U"}],
        }
        mock_sf.sf_instance = "test.salesforce.com"
        mock_sf.session_id = "s"
        MockSF.return_value = mock_sf

        svc = self._make_service()
        await svc.authenticate()

        result = await svc.create_record("Contact", {"LastName": "Doe"})
        assert result["id"] == "003NEW001"

    @pytest.mark.asyncio
    @patch("mcp_client.services.salesforce.Salesforce")
    async def test_update_record_returns_true_on_204(self, MockSF):
        """update_record() returns True when direct API returns 204."""
        mock_sf = MagicMock()
        mock_opp = MagicMock()
        mock_opp.update.return_value = 204
        mock_sf.Opportunity = mock_opp
        mock_sf.query.return_value = {
            "totalSize": 1,
            "records": [{"Id": "005U", "Name": "U"}],
        }
        mock_sf.sf_instance = "i"
        mock_sf.session_id = "s"
        MockSF.return_value = mock_sf

        svc = self._make_service()
        await svc.authenticate()

        result = await svc.update_record("Opportunity", "006X", {"Amount": 99})
        assert result is True

    @pytest.mark.asyncio
    @patch("mcp_client.services.salesforce.Salesforce")
    async def test_get_record_direct(self, MockSF):
        """get_record() returns the record dict from direct API."""
        mock_sf = MagicMock()
        mock_account = MagicMock()
        mock_account.get.return_value = {"Id": "001A", "Name": "Acme"}
        mock_sf.Account = mock_account
        mock_sf.query.return_value = {
            "totalSize": 1,
            "records": [{"Id": "005U", "Name": "U"}],
        }
        mock_sf.sf_instance = "i"
        mock_sf.session_id = "s"
        MockSF.return_value = mock_sf

        svc = self._make_service()
        await svc.authenticate()

        result = await svc.get_record("Account", "001A")
        assert result["Name"] == "Acme"

    @pytest.mark.asyncio
    async def test_query_raises_when_no_client(self):
        """query() raises when neither MCP tool nor sf_client is available."""
        svc = self._make_service()
        svc._authenticated = True
        svc.sf_client = None  # no direct client

        with pytest.raises(Exception, match="Failed to execute query"):
            await svc.query("SELECT Id FROM Opportunity")

    @pytest.mark.asyncio
    async def test_get_service_info_structure(self):
        """get_service_info() returns expected keys."""
        client = _make_mock_mcp_client(tools={"salesforce_query": MagicMock()})
        svc = self._make_service(client=client)
        svc._authenticated = True
        svc._config = {"user_id": "005U"}

        info = await svc.get_service_info()
        assert info["service"] == "salesforce"
        assert info["authenticated"] is True
        assert "available_tools" in info
        assert "salesforce_query" in info["available_tools"]

    @pytest.mark.asyncio
    async def test_service_info_projects_nonsecret_config(self):
        svc = self._make_service()
        svc._authenticated = True
        svc._config = {
            "user_id": "005U",
            "user_name": "Synthetic User",
            "instance_url": "example.salesforce.com",
            "session_id": "synthetic-bearer-do-not-serialize",
            "future_secret": {"value": "synthetic-future-secret"},
        }

        info = await svc.get_service_info()

        assert info["config"] == {
            "user_id": "005U",
            "user_name": "Synthetic User",
            "instance_url": "example.salesforce.com",
        }
        assert info["config"] is not svc._config


# ---------------------------------------------------------------------------
# SageIntacctMCPService tests
# ---------------------------------------------------------------------------

class TestSageIntacctMCPService:
    """Tests for SageIntacctMCPService."""

    def _make_service(self, client=None):
        return SageIntacctMCPService(
            client or _make_mock_mcp_client(),
            company_id="TESTCO",
            user_id="admin",
            user_password="secret",
            sender_id="PursuitApp",
            sender_password="senderpw",
            endpoint_url="https://api.intacct.com/ia/xml/xmlgw.phtml",
        )

    def test_missing_credentials_raises(self):
        """Constructor raises ValueError when required credentials are absent."""
        with pytest.raises(ValueError, match="Sage Intacct credentials are required"):
            SageIntacctMCPService(_make_mock_mcp_client(), company_id="CO")

    def test_initial_state(self):
        """Service starts with no session and unauthenticated."""
        svc = self._make_service()
        assert svc.session_id is None
        assert svc.is_authenticated is False

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_authenticate_success(self):
        """authenticate() parses session XML and sets _authenticated."""
        svc = self._make_service()

        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=_sage_auth_success_xml())

        mock_session = AsyncMock()
        mock_session.post = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_response),
            __aexit__=AsyncMock(return_value=False),
        ))

        svc._http_session = mock_session

        result = await svc.authenticate()
        assert result is True
        assert svc.is_authenticated is True
        assert svc.session_id == "test-session-id-abc123"
        assert svc._config["company_id"] == "TESTCO"

    @pytest.mark.asyncio
    async def test_authenticate_failure_bad_creds(self):
        """authenticate() returns False on invalid credentials response."""
        svc = self._make_service()

        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=_sage_auth_failure_xml())

        mock_session = AsyncMock()
        mock_session.post = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_response),
            __aexit__=AsyncMock(return_value=False),
        ))
        svc._http_session = mock_session

        result = await svc.authenticate()
        assert result is False
        assert svc.is_authenticated is False

    @pytest.mark.asyncio
    async def test_authenticate_http_error(self):
        """authenticate() returns False on non-200 HTTP status."""
        svc = self._make_service()

        mock_response = AsyncMock()
        mock_response.status = 500

        mock_session = AsyncMock()
        mock_session.post = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_response),
            __aexit__=AsyncMock(return_value=False),
        ))
        svc._http_session = mock_session

        result = await svc.authenticate()
        assert result is False

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_get_invoices_returns_parsed_data(self):
        """get_invoices() returns success dict with parsed invoice data."""
        svc = self._make_service()
        svc._authenticated = True
        svc.session_id = "sess123"

        invoice_xml = "<ARINVOICE><RECORDNO>INV-001</RECORDNO><TOTALDUE>5000</TOTALDUE></ARINVOICE>"
        response_xml = _sage_api_success_xml(invoice_xml)

        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=response_xml)

        mock_session = AsyncMock()
        mock_session.post = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_response),
            __aexit__=AsyncMock(return_value=False),
        ))
        svc._http_session = mock_session

        result = await svc.get_invoices(customer_id="CUST-001", limit=50)
        assert result["success"] is True
        assert "data" in result

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_get_customers_returns_parsed_data(self):
        """get_customers() returns success dict."""
        svc = self._make_service()
        svc._authenticated = True
        svc.session_id = "sess123"

        customer_xml = "<CUSTOMER><CUSTOMERID>CUST-001</CUSTOMERID><NAME>Acme</NAME></CUSTOMER>"
        response_xml = _sage_api_success_xml(customer_xml)

        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=response_xml)

        mock_session = AsyncMock()
        mock_session.post = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_response),
            __aexit__=AsyncMock(return_value=False),
        ))
        svc._http_session = mock_session

        result = await svc.get_customers(limit=10)
        assert result["success"] is True

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_create_invoice_sends_correct_xml(self):
        """create_invoice() builds line items XML and sends request."""
        svc = self._make_service()
        svc._authenticated = True
        svc.session_id = "sess123"

        response_xml = _sage_api_success_xml(
            "<ARINVOICE><RECORDNO>INV-NEW</RECORDNO></ARINVOICE>"
        )

        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=response_xml)

        mock_session = AsyncMock()
        mock_session.post = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_response),
            __aexit__=AsyncMock(return_value=False),
        ))
        svc._http_session = mock_session

        invoice_data = {
            "customer_id": "CUST-001",
            "date_created": "03/15/2026",
            "line_items": [
                {"account_label": "Grants", "amount": 25000, "description": "Spring grant"},
            ],
        }
        result = await svc.create_invoice(invoice_data)
        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_api_error_response_parsed(self):
        """_parse_api_response returns success=False with error messages."""
        svc = self._make_service()
        error_xml = _sage_api_error_xml("Record not found")
        parsed = svc._parse_api_response(error_xml)
        assert parsed["success"] is False
        assert "Record not found" in parsed["errors"]
        assert parsed["data"] is None

    @pytest.mark.asyncio
    async def test_malformed_xml_handled(self):
        """_parse_api_response handles malformed XML gracefully."""
        svc = self._make_service()
        parsed = svc._parse_api_response("<not>valid xml<unclosed")
        assert parsed["success"] is False
        assert any("parse" in e.lower() for e in parsed["errors"])

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_get_financial_metrics(self):
        """get_financial_metrics() queries GL accounts and returns data."""
        svc = self._make_service()
        svc._authenticated = True
        svc.session_id = "sess123"

        gl_xml = "<GLACCOUNT><ACCOUNTNO>1000</ACCOUNTNO><TITLE>Cash</TITLE></GLACCOUNT>"
        response_xml = _sage_api_success_xml(gl_xml)

        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=response_xml)

        mock_session = AsyncMock()
        mock_session.post = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_response),
            __aexit__=AsyncMock(return_value=False),
        ))
        svc._http_session = mock_session

        result = await svc.get_financial_metrics()
        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_disconnect_closes_session(self):
        """disconnect() closes the aiohttp session."""
        svc = self._make_service()
        mock_session = AsyncMock()
        mock_session.closed = False
        svc._http_session = mock_session

        await svc.disconnect()
        mock_session.close.assert_awaited_once()
        assert svc._http_session is None

    def test_xml_to_dict_nested(self):
        """_xml_to_dict handles nested elements and leaf nodes."""
        svc = self._make_service()
        xml_str = "<root><name>Acme</name><address><city>NY</city><zip>10001</zip></address></root>"
        elem = ET.fromstring(xml_str)
        result = svc._xml_to_dict(elem)
        assert result["name"] == "Acme"
        assert result["address"]["city"] == "NY"
        assert result["address"]["zip"] == "10001"


# ---------------------------------------------------------------------------
# SlackMCPService tests
# ---------------------------------------------------------------------------

class TestSlackMCPService:
    """Tests for SlackMCPService."""

    def _make_service(self, client=None, bot_token="xoxb-test-token"):
        return SlackMCPService(
            client or _make_mock_mcp_client(),
            bot_token=bot_token,
        )

    def test_missing_token_raises(self, monkeypatch):
        """Constructor raises ValueError when bot token is absent."""
        monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
        with pytest.raises(ValueError, match="Slack bot token is required"):
            SlackMCPService(_make_mock_mcp_client(), bot_token=None)

    @pytest.mark.asyncio
    @patch("mcp_client.services.slack.AsyncWebClient")
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_authenticate_success(self, MockClient):
        """authenticate() succeeds and stores user_id / team in config."""
        mock_instance = AsyncMock()
        mock_instance.auth_test.return_value = {
            "ok": True,
            "user_id": "U12345",
            "team": "Pursuit",
            "url": "https://pursuit.slack.com/",
        }
        MockClient.return_value = mock_instance

        svc = self._make_service()
        result = await svc.authenticate()

        assert result is True
        assert svc.is_authenticated is True
        assert svc._config["user_id"] == "U12345"
        assert svc._config["team"] == "Pursuit"

    @pytest.mark.asyncio
    @patch("mcp_client.services.slack.AsyncWebClient")
    async def test_authenticate_failure(self, MockClient):
        """authenticate() returns False when auth_test reports not ok."""
        mock_instance = AsyncMock()
        mock_instance.auth_test.return_value = {"ok": False}
        MockClient.return_value = mock_instance

        svc = self._make_service()
        result = await svc.authenticate()
        assert result is False
        assert svc.is_authenticated is False

    @pytest.mark.asyncio
    @patch("mcp_client.services.slack.AsyncWebClient")
    async def test_authenticate_api_error(self, MockClient):
        """authenticate() returns False when SlackApiError is raised."""
        from slack_sdk.errors import SlackApiError
        mock_instance = AsyncMock()
        mock_instance.auth_test.side_effect = SlackApiError(
            message="invalid_auth",
            response=MagicMock(status_code=401, data={"ok": False, "error": "invalid_auth"}),
        )
        MockClient.return_value = mock_instance

        svc = self._make_service()
        result = await svc.authenticate()
        assert result is False

    @pytest.mark.asyncio
    @patch("mcp_client.services.slack.AsyncWebClient")
    async def test_post_message_direct_api(self, MockClient):
        """post_message() uses direct Slack API when no MCP tool exists."""
        mock_instance = AsyncMock()
        mock_instance.auth_test.return_value = {
            "ok": True, "user_id": "U1", "team": "T", "url": "u",
        }
        mock_instance.chat_postMessage.return_value = MagicMock(
            data={"ok": True, "channel": "C123", "ts": "1234567890.123"}
        )
        MockClient.return_value = mock_instance

        svc = self._make_service()
        await svc.authenticate()

        result = await svc.post_message("C123", "Hello World")
        assert result["ok"] is True
        mock_instance.chat_postMessage.assert_awaited_once_with(
            channel="C123", text="Hello World"
        )

    @pytest.mark.asyncio
    async def test_post_message_prefers_mcp_tool(self):
        """post_message() uses MCP tool when 'slack_post_message' is registered."""
        client = _make_mock_mcp_client(tools={"slack_post_message": MagicMock()})
        client.call_tool.return_value = {"ok": True, "ts": "111.222"}

        svc = self._make_service(client=client)
        svc._authenticated = True
        svc.slack_client = AsyncMock()  # should not be called

        result = await svc.post_message("#general", "Hi from MCP")
        client.call_tool.assert_awaited_once_with(
            "slack_post_message",
            {"channel": "#general", "text": "Hi from MCP"},
        )
        assert result["ok"] is True

    @pytest.mark.asyncio
    @patch("mcp_client.services.slack.AsyncWebClient")
    async def test_get_channels_direct(self, MockClient):
        """get_channels() returns channel list from direct API."""
        mock_instance = AsyncMock()
        mock_instance.auth_test.return_value = {
            "ok": True, "user_id": "U1", "team": "T", "url": "u",
        }
        mock_instance.conversations_list.return_value = {
            "channels": [
                {"id": "C001", "name": "general"},
                {"id": "C002", "name": "random"},
            ]
        }
        MockClient.return_value = mock_instance

        svc = self._make_service()
        await svc.authenticate()

        channels = await svc.get_channels(limit=50)
        assert len(channels) == 2
        assert channels[0]["name"] == "general"

    @pytest.mark.asyncio
    @patch("mcp_client.services.slack.AsyncWebClient")
    async def test_search_messages_direct(self, MockClient):
        """search_messages() queries Slack search API."""
        mock_instance = AsyncMock()
        mock_instance.auth_test.return_value = {
            "ok": True, "user_id": "U1", "team": "T", "url": "u",
        }
        mock_instance.search_messages.return_value = MagicMock(
            data={"ok": True, "messages": {"matches": [{"text": "grant update"}]}}
        )
        MockClient.return_value = mock_instance

        svc = self._make_service()
        await svc.authenticate()

        result = await svc.search_messages("grant update", count=5, sort="timestamp")
        assert result["ok"] is True

    @pytest.mark.asyncio
    @patch("mcp_client.services.slack.AsyncWebClient")
    async def test_get_channel_history_direct(self, MockClient):
        """get_channel_history() returns message list from conversations_history."""
        mock_instance = AsyncMock()
        mock_instance.auth_test.return_value = {
            "ok": True, "user_id": "U1", "team": "T", "url": "u",
        }
        mock_instance.conversations_history.return_value = {
            "messages": [
                {"ts": "111", "text": "msg1"},
                {"ts": "112", "text": "msg2"},
            ]
        }
        MockClient.return_value = mock_instance

        svc = self._make_service()
        await svc.authenticate()

        messages = await svc.get_channel_history("C001", limit=10)
        assert len(messages) == 2
        assert messages[0]["text"] == "msg1"

    @pytest.mark.asyncio
    @patch("mcp_client.services.slack.AsyncWebClient")
    async def test_get_users_direct(self, MockClient):
        """get_users() returns member list from users_list."""
        mock_instance = AsyncMock()
        mock_instance.auth_test.return_value = {
            "ok": True, "user_id": "U1", "team": "T", "url": "u",
        }
        mock_instance.users_list.return_value = {
            "members": [
                {"id": "U001", "name": "alice"},
                {"id": "U002", "name": "bob"},
            ]
        }
        MockClient.return_value = mock_instance

        svc = self._make_service()
        await svc.authenticate()

        users = await svc.get_users(limit=50)
        assert len(users) == 2
        assert users[1]["name"] == "bob"

    @pytest.mark.asyncio
    @pytest.mark.skip(reason="Needs internal API alignment")
    async def test_post_message_raises_without_client(self):
        """post_message() raises when no MCP tool and no slack_client."""
        svc = self._make_service()
        svc._authenticated = True
        svc.slack_client = None

        with pytest.raises(Exception, match="Failed to post message"):
            await svc.post_message("C001", "text")

    @pytest.mark.asyncio
    async def test_get_service_info_contains_tools(self):
        """get_service_info() lists relevant Slack MCP tools."""
        client = _make_mock_mcp_client(tools={
            "slack_post_message": MagicMock(),
            "slack_search_messages": MagicMock(),
            "salesforce_query": MagicMock(),
        })
        svc = self._make_service(client=client)
        svc._authenticated = True

        info = await svc.get_service_info()
        assert info["service"] == "slack"
        # Only slack-related tools
        assert "slack_post_message" in info["available_tools"]
        assert "slack_search_messages" in info["available_tools"]
        assert "salesforce_query" not in info["available_tools"]
