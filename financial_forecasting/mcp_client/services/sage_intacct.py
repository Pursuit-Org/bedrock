"""Sage Intacct MCP service integration."""

from typing import Any, Dict, List, Optional, Union
import asyncio
import xml.etree.ElementTree as ET
import aiohttp
import base64
from datetime import datetime, date

from .base import BaseMCPService


class InvalidSageQuery(ValueError):
    """A filter cannot be represented safely by legacy readByQuery."""


class SageIntacctMCPService(BaseMCPService):
    """Sage Intacct MCP service integration."""

    def __init__(
        self,
        client,
        company_id: Optional[str] = None,
        user_id: Optional[str] = None,
        user_password: Optional[str] = None,
        sender_id: Optional[str] = None,
        sender_password: Optional[str] = None,
        endpoint_url: Optional[str] = None,
    ):
        super().__init__(client)
        self.company_id = company_id or self.get_config_value("SAGE_INTACCT_COMPANY_ID")
        self.user_id = user_id or self.get_config_value("SAGE_INTACCT_USER_ID")
        self.user_password = user_password or self.get_config_value("SAGE_INTACCT_USER_PASSWORD")
        self.sender_id = sender_id or self.get_config_value("SAGE_INTACCT_SENDER_ID")
        self.sender_password = sender_password or self.get_config_value("SAGE_INTACCT_SENDER_PASSWORD")
        self.endpoint_url = endpoint_url or self.get_config_value(
            "SAGE_INTACCT_ENDPOINT_URL", 
            "https://api.intacct.com/ia/xml/xmlgw.phtml"
        )
        
        # Validate required credentials
        required_fields = [self.company_id, self.user_id, self.user_password, self.sender_id, self.sender_password]
        if not all(required_fields):
            raise ValueError("Sage Intacct credentials are required: company_id, user_id, user_password, sender_id, sender_password")
        
        self.session_id: Optional[str] = None
        self.endpoint_url_session: Optional[str] = None
        self._http_session: Optional[aiohttp.ClientSession] = None

    async def _get_http_session(self) -> aiohttp.ClientSession:
        if self._http_session is None or self._http_session.closed:
            self._http_session = aiohttp.ClientSession()
        return self._http_session

    async def disconnect(self) -> None:
        if self._http_session and not self._http_session.closed:
            await self._http_session.close()
        self._http_session = None

    async def authenticate(self) -> bool:
        """Authenticate with Sage Intacct API and get session."""
        try:
            # Create authentication XML request
            auth_xml = self._create_auth_request()
            
            session = await self._get_http_session()
            async with session.post(
                self.endpoint_url,
                data=auth_xml,
                headers={'Content-Type': 'application/xml'}
            ) as response:
                if response.status == 200:
                    response_text = await response.text()
                    return self._parse_auth_response(response_text)
                else:
                    print(f"Sage Intacct authentication failed with status: {response.status}")
                    return False
                        
        except Exception as e:
            print(f"Sage Intacct authentication error: {e}")
            return False

    def _create_auth_request(self) -> str:
        """Create XML authentication request."""
        request_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<request>
    <control>
        <senderid>{self.sender_id}</senderid>
        <password>{self.sender_password}</password>
        <controlid>auth-{datetime.now().strftime('%Y%m%d%H%M%S')}</controlid>
        <uniqueid>false</uniqueid>
        <dtdversion>3.0</dtdversion>
    </control>
    <operation>
        <authentication>
            <login>
                <userid>{self.user_id}</userid>
                <companyid>{self.company_id}</companyid>
                <password>{self.user_password}</password>
            </login>
        </authentication>
        <content>
            <function controlid="get-session">
                <getAPISession></getAPISession>
            </function>
        </content>
    </operation>
</request>"""
        return request_xml

    def _parse_auth_response(self, response_xml: str) -> bool:
        """Parse authentication response and extract session info."""
        try:
            root = ET.fromstring(response_xml)
            
            # Check for authentication success
            auth_status = root.find('.//authentication/status')
            if auth_status is not None and auth_status.text == 'success':
                # Extract session information
                session_id = root.find('.//sessionid')
                endpoint = root.find('.//endpoint')
                
                if session_id is not None and endpoint is not None:
                    self.session_id = session_id.text
                    self.endpoint_url_session = endpoint.text
                    self._authenticated = True
                    
                    # Update config with session info
                    self._config.update({
                        "company_id": self.company_id,
                        "user_id": self.user_id,
                        "session_id": self.session_id,
                        "endpoint_url": self.endpoint_url_session,
                    })
                    return True
            
            # Check for errors
            error_message = root.find('.//error/description2')
            if error_message is not None:
                print(f"Sage Intacct authentication error: {error_message.text}")
            
            return False
            
        except ET.ParseError as e:
            print(f"Failed to parse Sage Intacct response: {e}")
            return False

    async def get_service_info(self) -> Dict[str, Any]:
        """Get Sage Intacct service information."""
        await self.ensure_authenticated()
        
        return {
            "service": "sage_intacct",
            "authenticated": self._authenticated,
            "config": self._config,
            "available_tools": await self._get_available_tools(),
        }

    async def _get_available_tools(self) -> List[str]:
        """Get available Sage Intacct tools from MCP server."""
        tools = []
        for tool_name, tool_def in self.client.available_tools.items():
            if "intacct" in tool_name.lower() or "sage" in tool_name.lower():
                tools.append(tool_name)
        return tools

    async def _make_api_request(self, function_xml: str) -> Dict[str, Any]:
        """Make authenticated API request to Sage Intacct."""
        await self.ensure_authenticated()
        
        request_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<request>
    <control>
        <senderid>{self.sender_id}</senderid>
        <password>{self.sender_password}</password>
        <controlid>request-{datetime.now().strftime('%Y%m%d%H%M%S')}</controlid>
        <uniqueid>false</uniqueid>
        <dtdversion>3.0</dtdversion>
    </control>
    <operation>
        <authentication>
            <sessionid>{self.session_id}</sessionid>
        </authentication>
        <content>
            {function_xml}
        </content>
    </operation>
</request>"""

        session = await self._get_http_session()
        async with session.post(
            self.endpoint_url_session or self.endpoint_url,
            data=request_xml,
            headers={'Content-Type': 'application/xml'}
        ) as response:
            if response.status == 200:
                response_text = await response.text()
                return self._parse_api_response(response_text)
            else:
                raise Exception(f"API request failed with status: {response.status}")

    def _parse_api_response(self, response_xml: str) -> Dict[str, Any]:
        """Parse API response XML."""
        try:
            root = ET.fromstring(response_xml)
            
            # Check for operation success
            operation_status = root.find('.//operation/result/status')
            if operation_status is not None and operation_status.text == 'success':
                # Extract data from response
                data_elements = root.findall('.//data')
                results = []
                
                for data_elem in data_elements:
                    # Convert XML element to dictionary
                    result = self._xml_to_dict(data_elem)
                    results.append(result)
                
                return {
                    "success": True,
                    "data": results if len(results) > 1 else (results[0] if results else {}),
                    "count": len(results)
                }
            else:
                # Handle errors
                error_elements = root.findall('.//error')
                errors = []
                for error_elem in error_elements:
                    error_desc = error_elem.find('description2')
                    if error_desc is not None:
                        errors.append(error_desc.text)
                
                return {
                    "success": False,
                    "errors": errors,
                    "data": None
                }
                
        except ET.ParseError as e:
            return {
                "success": False,
                "errors": [f"Failed to parse response: {e}"],
                "data": None
            }

    def _xml_to_dict(self, element) -> Dict[str, Any]:
        """Convert XML element to dictionary."""
        result = {}
        
        # Handle attributes
        if element.attrib:
            result.update(element.attrib)
        
        # Handle child elements
        for child in element:
            if len(child) == 0:
                # Leaf node
                result[child.tag] = child.text
            else:
                # Has children
                if child.tag in result:
                    # Multiple elements with same tag - convert to list
                    if not isinstance(result[child.tag], list):
                        result[child.tag] = [result[child.tag]]
                    result[child.tag].append(self._xml_to_dict(child))
                else:
                    result[child.tag] = self._xml_to_dict(child)
        
        return result

    # Financial Data Methods
    
    async def get_customers(self, limit: int = 100) -> Dict[str, Any]:
        """Get customer list."""
        function_xml = f"""
        <function controlid="get-customers">
            <readByQuery>
                <object>CUSTOMER</object>
                <query></query>
                <fields>*</fields>
                <pagesize>{limit}</pagesize>
            </readByQuery>
        </function>"""
        
        return await self._make_api_request(function_xml)

    @staticmethod
    def _customer_read_xml(control_id: str, object_name: str, customer_id: Optional[str], limit: int) -> str:
        if customer_id is not None:
            if not isinstance(customer_id, str) or "\\" in customer_id:
                # Sage documents apostrophe escaping, but not literal backslashes.
                raise InvalidSageQuery("customer_id cannot contain backslashes")
            if any(not (c in "\t\n\r" or " " <= c <= "\ud7ff" or "\ue000" <= c <= "\ufffd" or "\U00010000" <= c <= "\U0010ffff") for c in customer_id):
                raise InvalidSageQuery("customer_id contains invalid XML characters")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
            raise InvalidSageQuery("limit must be between 1 and 1000")
        # Encode the query language first; XML text serialization is a separate boundary.
        literal = customer_id.replace("'", "\\'") if customer_id else ""
        query = "CUSTOMERID = '" + literal + "'" if customer_id else ""
        function = ET.Element("function", {"controlid": control_id})
        read = ET.SubElement(function, "readByQuery")
        for tag, value in (("object", object_name), ("query", query), ("fields", "*"), ("pagesize", str(limit))):
            ET.SubElement(read, tag).text = value
        # XML parsers normalize literal CR to LF; a character reference preserves the ID.
        return ET.tostring(function, encoding="unicode").replace("\r", "&#13;")

    async def get_invoices(self, customer_id: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
        """Get invoices, optionally filtered by customer."""
        return await self._make_api_request(self._customer_read_xml("get-invoices", "ARINVOICE", customer_id, limit))

    async def get_payments(self, customer_id: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
        """Get payments, optionally filtered by customer."""
        return await self._make_api_request(self._customer_read_xml("get-payments", "ARPAYMENT", customer_id, limit))

    async def create_invoice(self, invoice_data: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new invoice."""
        # Extract required fields
        customer_id = invoice_data.get('customer_id')
        date_created = invoice_data.get('date_created', date.today().strftime('%m/%d/%Y'))
        
        # Build line items XML
        line_items_xml = ""
        for item in invoice_data.get('line_items', []):
            line_items_xml += f"""
            <lineitem>
                <accountlabel>{item.get('account_label', 'Sales')}</accountlabel>
                <amount>{item.get('amount', 0)}</amount>
                <memo>{item.get('description', '')}</memo>
            </lineitem>"""
        
        function_xml = f"""
        <function controlid="create-invoice">
            <create_invoice>
                <customerid>{customer_id}</customerid>
                <datecreated>
                    <year>{date_created.split('/')[2]}</year>
                    <month>{date_created.split('/')[0]}</month>
                    <day>{date_created.split('/')[1]}</day>
                </datecreated>
                <invoiceitems>
                    {line_items_xml}
                </invoiceitems>
            </create_invoice>
        </function>"""
        
        return await self._make_api_request(function_xml)

    async def get_cash_flow_data(self, start_date: str, end_date: str) -> Dict[str, Any]:
        """Get cash flow data for forecasting."""
        # Get accounts receivable aging
        ar_function = f"""
        <function controlid="get-ar-aging">
            <readByQuery>
                <object>ARINVOICE</object>
                <query>STATE != 'Paid' AND WHENCREATED >= '{start_date}' AND WHENCREATED <= '{end_date}'</query>
                <fields>RECORDNO,CUSTOMERID,CUSTOMERNAME,TOTALDUE,WHENCREATED,WHENDUE,STATE</fields>
                <pagesize>1000</pagesize>
            </readByQuery>
        </function>"""
        
        return await self._make_api_request(ar_function)

    async def get_financial_metrics(self) -> Dict[str, Any]:
        """Get key financial metrics for dashboard."""
        # This would typically involve multiple API calls to get various metrics
        # For now, we'll get basic AR and cash position
        
        function_xml = """
        <function controlid="get-financial-summary">
            <readByQuery>
                <object>GLACCOUNT</object>
                <query>ACCOUNTTYPE = 'accountsreceivable' OR ACCOUNTTYPE = 'cash'</query>
                <fields>ACCOUNTNO,TITLE,NORMALBALANCE,ACCOUNTTYPE</fields>
                <pagesize>100</pagesize>
            </readByQuery>
        </function>"""
        
        return await self._make_api_request(function_xml)

