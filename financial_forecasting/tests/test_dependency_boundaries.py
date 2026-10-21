"""Exercise real parser, cookie and HTTP-client boundaries after dependency upgrades."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.testclient import TestClient
from jose import jwt

import auth
from mcp_client.services.sage_intacct import SageIntacctMCPService


@pytest.fixture
def client():
    app = FastAPI()

    @app.post("/upload")
    async def upload(file: UploadFile = File(...), label: str = Form(...)):
        return {"name": file.filename, "label": label, "body": (await file.read()).decode()}

    @app.post("/limited-form")
    async def limited_form(request: Request):
        async with request.form(max_fields=1, max_part_size=16) as form:
            return {"fields": list(form)}

    @app.get("/account")
    async def account(user=Depends(auth.require_auth)):
        return {"user_id": user["user_id"]}

    with TestClient(app) as test_client:
        yield test_client


def test_multipart_upload_and_form_field_survive_parser_upgrade(client):
    response = client.post(
        "/upload", data={"label": "invoices"},
        files={"file": ("invoices.csv", b"amount\n100\n", "text/csv")},
    )
    assert response.status_code == 200
    assert response.json() == {
        "name": "invoices.csv", "label": "invoices", "body": "amount\n100\n",
    }


@pytest.mark.parametrize("fields", [
    [("first", (None, "one")), ("second", (None, "two"))],
    [("large", (None, "x" * 17))],
])
def test_multipart_parser_rejects_excess_fields_and_oversized_parts(client, fields):
    assert client.post("/limited-form", files=fields).status_code == 400


def test_jwt_cookie_authentication_survives_upgrade(client):
    client.cookies.set("access_token", auth.create_access_token({"email": "test@example.test"}))
    response = client.get("/account")
    assert response.status_code == 200
    assert response.json() == {"user_id": "test@example.test"}


@pytest.mark.parametrize("secret,expiry", [
    ("incorrect-signing-key", datetime.now(timezone.utc) + timedelta(hours=1)),
    (auth.JWT_SECRET_KEY, datetime.now(timezone.utc) - timedelta(hours=1)),
])
def test_invalid_or_expired_cookie_is_rejected(client, secret, expiry):
    token = jwt.encode({"email": "test@example.test", "exp": expiry}, secret, algorithm="HS256")
    client.cookies.set("access_token", token)
    assert client.get("/account").status_code == 401


def test_encrypted_oauth_cookie_round_trip_and_tamper_rejection():
    payload = {"access_token": "fixture-access-token", "refresh_token": "fixture-refresh-token"}
    encrypted = auth.encrypt_tokens(payload)
    assert auth.decrypt_tokens(encrypted) == payload
    # Change the authenticated ciphertext, not base64 padding.
    middle = len(encrypted) // 2
    replacement = "A" if encrypted[middle] != "A" else "B"
    assert auth.decrypt_tokens(encrypted[:middle] + replacement + encrypted[middle + 1:]) is None


@pytest.mark.asyncio
async def test_sage_authentication_uses_real_http_client_and_closes_session():
    async def authenticate(request):
        assert request.content_type == "application/xml"
        assert "<companyid>fixture-company</companyid>" in await request.text()
        return web.Response(text="""<response><operation>
            <authentication><status>success</status></authentication>
            <sessionid>fixture-session</sessionid><endpoint>https://example.test/xml</endpoint>
            </operation></response>""", content_type="application/xml")

    app = web.Application()
    app.router.add_post("/xml", authenticate)
    async with TestServer(app, host="127.0.0.1") as server:
        service = SageIntacctMCPService(
            MagicMock(), company_id="fixture-company", user_id="fixture-user",
            user_password="fixture-password", sender_id="fixture-sender",
            sender_password="fixture-sender-password", endpoint_url=str(server.make_url("/xml")),
        )
        session = await service._get_http_session()
        try:
            assert await service.authenticate() is True
            assert service.session_id == "fixture-session"
            assert await service._get_http_session() is session
        finally:
            await service.disconnect()
        assert session.closed
