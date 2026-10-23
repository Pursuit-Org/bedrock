"""Salesforce MCP service integration."""

import logging
from typing import Any, Callable, Dict, List, Optional
import asyncio
from simple_salesforce import Salesforce
from simple_salesforce.exceptions import (
    SalesforceAuthenticationFailed,
    SalesforceExpiredSession,
)

from .base import BaseMCPService

logger = logging.getLogger(__name__)

# Timeout for individual Salesforce API calls via run_in_executor.
# If simple_salesforce hangs on a network call, we give up after this
# many seconds rather than blocking the asyncio event loop forever.
_SF_CALL_TIMEOUT = 30.0  # seconds

# How long to wait for the reauth lock before giving up. The lock holder
# is itself doing an authenticated SF call (capped at _SF_CALL_TIMEOUT),
# so 2× gives it room to complete plus retry.
_REAUTH_LOCK_TIMEOUT = 75.0  # seconds


def _is_session_error(exc: Exception) -> bool:
    """Check if an exception indicates the Salesforce session has expired."""
    if isinstance(exc, SalesforceExpiredSession):
        return True
    msg = str(exc).lower()
    return "invalid_session_id" in msg or "session expired" in msg


async def _run_sf(fn: Callable, *, timeout: float = _SF_CALL_TIMEOUT) -> Any:
    """Run a synchronous simple_salesforce call in a thread, with a hard timeout.

    Raises asyncio.TimeoutError if the call does not complete within `timeout`
    seconds — preventing hung threads from blocking the event loop forever.
    """
    loop = asyncio.get_running_loop()
    return await asyncio.wait_for(
        loop.run_in_executor(None, fn),
        timeout=timeout,
    )


class SalesforceMCPService(BaseMCPService):
    """Salesforce MCP service integration."""

    def __init__(
        self,
        client,
        username: Optional[str] = None,
        password: Optional[str] = None,
        security_token: Optional[str] = None,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        domain: Optional[str] = None,
    ):
        super().__init__(client)
        self.username = username or self.get_config_value("SALESFORCE_USERNAME")
        self.password = password or self.get_config_value("SALESFORCE_PASSWORD")
        self.security_token = security_token or self.get_config_value("SALESFORCE_SECURITY_TOKEN")
        self.client_id = client_id or self.get_config_value("SALESFORCE_CLIENT_ID")
        self.client_secret = client_secret or self.get_config_value("SALESFORCE_CLIENT_SECRET")
        self.domain = domain or self.get_config_value("SALESFORCE_DOMAIN", "login")
        self.sf_client: Optional[Salesforce] = None
        self._reauth_lock = asyncio.Lock()

        # Check if we have either security token method or OAuth method
        has_security_token = all([self.username, self.password, self.security_token])
        has_oauth = all([self.username, self.password, self.client_id, self.client_secret])

        if not (has_security_token or has_oauth):
            raise ValueError("Salesforce credentials are required: either (username, password, security_token) or (username, password, client_id, client_secret)")

    async def authenticate(self) -> bool:
        """Authenticate with Salesforce API."""
        try:
            if self.client_id and self.client_secret:
                import requests

                oauth_url = (
                    f"https://{self.domain}.salesforce.com/services/oauth2/token"
                    if self.domain != "login"
                    else "https://login.salesforce.com/services/oauth2/token"
                )
                oauth_data = {
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                }

                oauth_response = await _run_sf(
                    lambda: requests.post(oauth_url, data=oauth_data)
                )

                if oauth_response.status_code == 200:
                    token_data = oauth_response.json()
                    self.sf_client = await _run_sf(
                        lambda: Salesforce(
                            instance_url=token_data["instance_url"],
                            session_id=token_data["access_token"],
                        )
                    )
                else:
                    if self.username and self.password:
                        self.sf_client = await _run_sf(
                            lambda: Salesforce(
                                username=self.username,
                                password=self.password,
                                consumer_key=self.client_id,
                                consumer_secret=self.client_secret,
                                domain=self.domain,
                            )
                        )
                    else:
                        raise Exception(f"OAuth failed: {oauth_response.text}")
            else:
                self.sf_client = await _run_sf(
                    lambda: Salesforce(
                        username=self.username,
                        password=self.password,
                        security_token=self.security_token,
                        domain=self.domain,
                    )
                )

            safe_username = self.username.replace("\\", "\\\\").replace("'", "\\'")
            user_info = await _run_sf(
                lambda: self.sf_client.query(
                    f"SELECT Id, Name FROM User WHERE Username = '{safe_username}'"
                )
            )

            if user_info["totalSize"] > 0:
                self._authenticated = True
                self._config.update({
                    "user_id": user_info["records"][0]["Id"],
                    "user_name": user_info["records"][0]["Name"],
                    "instance_url": self.sf_client.sf_instance,
                })
                logger.info(f"Salesforce authenticated as {self._config['user_name']}")
                return True
            return False

        except SalesforceAuthenticationFailed as e:
            logger.warning(f"Salesforce authentication failed: {e}")
            if self.username and self.password:
                try:
                    from simple_salesforce import SalesforceLogin
                    session_id, instance = await _run_sf(
                        lambda: SalesforceLogin(
                            username=self.username,
                            password=self.password,
                            domain=self.domain or "login",
                        )
                    )
                    self.sf_client = Salesforce(instance=instance, session_id=session_id)
                    self._authenticated = True
                    logger.info(f"Salesforce connected via SalesforceLogin fallback: {self.username}")
                    return True
                except Exception as fallback_err:
                    logger.error(f"Salesforce fallback auth also failed: {fallback_err}")
            return False
        except asyncio.TimeoutError:
            logger.error("Salesforce authentication timed out after %ss", _SF_CALL_TIMEOUT)
            return False
        except Exception as e:
            logger.error(f"Salesforce connection error: {e}")
            return False

    async def _reauthenticate(self) -> bool:
        """Re-authenticate after session expiry.

        Uses a timed lock acquisition so a hung authenticate() call in another
        coroutine cannot deadlock all subsequent SF callers forever.
        """
        try:
            await asyncio.wait_for(
                self._reauth_lock.acquire(),
                timeout=_REAUTH_LOCK_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.error(
                "Timed out waiting for Salesforce reauth lock after %ss — "
                "another reauth is likely stuck. Returning False.",
                _REAUTH_LOCK_TIMEOUT,
            )
            return False

        try:
            # Another caller may have refreshed while we waited for the lock.
            if self._authenticated:
                return True
            logger.info("Salesforce session expired — re-authenticating...")
            success = await self.authenticate()
            if success:
                logger.info("Salesforce re-authentication succeeded")
            else:
                logger.error("Salesforce re-authentication failed")
            return success
        finally:
            self._reauth_lock.release()

    async def _call_with_refresh(self, operation: Callable, error_label: str):
        """Execute a Salesforce operation with automatic session refresh on expiry.

        1. Ensure authenticated
        2. Run the operation
        3. If session expired: reset auth, re-authenticate, retry once
        4. If retry also fails: raise
        """
        await self.ensure_authenticated()

        try:
            return await operation()
        except Exception as first_err:
            if not _is_session_error(first_err):
                raise Exception(f"{error_label}: {first_err}") from first_err

        # Session expired — reset flag and re-authenticate
        logger.warning(f"Salesforce session expired during {error_label}")
        self._authenticated = False
        if not await self._reauthenticate():
            raise Exception(
                f"{error_label}: session expired and re-authentication failed"
            )

        # Retry once with fresh session
        try:
            return await operation()
        except Exception as retry_err:
            raise Exception(f"{error_label} (after re-auth): {retry_err}") from retry_err

    async def get_service_info(self) -> Dict[str, Any]:
        """Get Salesforce service information."""
        await self.ensure_authenticated()

        return {
            "service": "salesforce",
            "authenticated": self._authenticated,
            "config": {
                key: self._config[key]
                for key in ("user_id", "user_name", "instance_url")
                if key in self._config
            },
            "available_tools": await self._get_available_tools(),
        }

    async def _get_available_tools(self) -> List[str]:
        """Get available Salesforce tools from MCP server."""
        tools = []
        if not self.client:
            return tools
        for tool_name, tool_def in self.client.available_tools.items():
            if "salesforce" in tool_name.lower() or "sf" in tool_name.lower():
                tools.append(tool_name)
        return tools

    async def query(self, soql: str) -> Dict[str, Any]:
        """Execute SOQL query."""
        async def _do():
            if self.client and "salesforce_query" in self.client.available_tools:
                return await self.client.call_tool(
                    "salesforce_query",
                    {"query": soql}
                )
            if self.sf_client:
                return await _run_sf(lambda: self.sf_client.query(soql))
            raise Exception("No Salesforce client available")

        return await self._call_with_refresh(_do, "Failed to execute query")

    async def query_all(self, soql: str) -> Dict[str, Any]:
        """Execute SOQL query with automatic pagination (returns all records)."""
        async def _do():
            if self.sf_client:
                return await _run_sf(lambda: self.sf_client.query_all(soql))
            raise Exception("No Salesforce client available")

        return await self._call_with_refresh(_do, "Failed to execute query_all")

    async def create_record(self, sobject: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new record."""
        async def _do():
            if self.client and "salesforce_create" in self.client.available_tools:
                return await self.client.call_tool(
                    "salesforce_create",
                    {"sobject": sobject, "data": data}
                )
            if self.sf_client:
                sobject_client = getattr(self.sf_client, sobject)
                return await _run_sf(lambda: sobject_client.create(data))
            raise Exception("No Salesforce client available")

        return await self._call_with_refresh(_do, f"Failed to create {sobject}")

    async def update_record(
        self, sobject: str, record_id: str, data: Dict[str, Any]
    ) -> bool:
        """Update an existing record."""
        async def _do():
            if self.client and "salesforce_update" in self.client.available_tools:
                result = await self.client.call_tool(
                    "salesforce_update",
                    {"sobject": sobject, "id": record_id, "data": data}
                )
                return result.get("success", False)
            if self.sf_client:
                sobject_client = getattr(self.sf_client, sobject)
                result = await _run_sf(lambda: sobject_client.update(record_id, data))
                return result == 204
            raise Exception("No Salesforce client available")

        return await self._call_with_refresh(_do, f"Failed to update {sobject}")

    async def delete_record(self, sobject: str, record_id: str) -> bool:
        """Delete a record."""
        async def _do():
            if self.client and "salesforce_delete" in self.client.available_tools:
                result = await self.client.call_tool(
                    "salesforce_delete",
                    {"sobject": sobject, "id": record_id}
                )
                return result.get("success", False)
            if self.sf_client:
                sobject_client = getattr(self.sf_client, sobject)
                result = await _run_sf(lambda: sobject_client.delete(record_id))
                return result == 204
            raise Exception("No Salesforce client available")

        return await self._call_with_refresh(_do, f"Failed to delete {sobject}")

    async def get_record(self, sobject: str, record_id: str) -> Dict[str, Any]:
        """Get a record by ID."""
        async def _do():
            if self.client and "salesforce_get" in self.client.available_tools:
                return await self.client.call_tool(
                    "salesforce_get",
                    {"sobject": sobject, "id": record_id}
                )
            if self.sf_client:
                sobject_client = getattr(self.sf_client, sobject)
                return await _run_sf(lambda: sobject_client.get(record_id))
            raise Exception("No Salesforce client available")

        return await self._call_with_refresh(_do, f"Failed to get {sobject}")

    async def describe_sobject(self, sobject: str) -> Dict[str, Any]:
        """Describe an SObject (get metadata)."""
        async def _do():
            if self.client and "salesforce_describe" in self.client.available_tools:
                return await self.client.call_tool(
                    "salesforce_describe",
                    {"sobject": sobject}
                )
            if self.sf_client:
                sobject_client = getattr(self.sf_client, sobject)
                return await _run_sf(lambda: sobject_client.describe())
            raise Exception("No Salesforce client available")

        return await self._call_with_refresh(_do, f"Failed to describe {sobject}")

    async def search(self, sosl: str) -> Dict[str, Any]:
        """Execute SOSL search."""
        async def _do():
            if self.client and "salesforce_search" in self.client.available_tools:
                return await self.client.call_tool(
                    "salesforce_search",
                    {"query": sosl}
                )
            if self.sf_client:
                return await _run_sf(lambda: self.sf_client.search(sosl))
            raise Exception("No Salesforce client available")

        return await self._call_with_refresh(_do, "Failed to execute search")
