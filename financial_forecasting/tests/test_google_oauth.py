"""Google routes with real Authlib state, token exchange and ID-token verification."""

import base64
import json
import time
from urllib.parse import parse_qs, urlparse

import httpx2 as httpx
import pytest
from authlib.integrations.httpx_client import AsyncOAuth2Client
from authlib.jose import JsonWebKey, jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.sessions import SessionMiddleware

from auth import decrypt_tokens, verify_token
from oauth_session import BoundedStateOAuth
from routes import auth as routes


@pytest.fixture
def google_flow(monkeypatch):
    key = JsonWebKey.generate_key("RSA", 2048, is_private=True, options={"kid": "fixture"})
    nonces = {}
    exchanges = []

    def provider(request):
        if request.url.path == "/.well-known/openid-configuration":
            return httpx.Response(200, json={
                "issuer": "https://provider.test", "authorization_endpoint": "https://provider.test/authorize",
                "token_endpoint": "https://provider.test/token", "jwks_uri": "https://provider.test/jwks",
                "id_token_signing_alg_values_supported": ["RS256"],
            })
        if request.url.path == "/jwks":
            return httpx.Response(200, json={"keys": [key.as_dict(is_private=False)]})
        assert request.url.path == "/token"
        code = parse_qs(request.content.decode())["code"][0]
        exchanges.append(code)
        claims = {"iss": "https://provider.test", "aud": "fixture-client", "sub": "fixture-user",
                  "iat": int(time.time()), "exp": int(time.time()) + 300,
                  "nonce": nonces[code], "email": "fixture@example.test", "name": "Fixture User"}
        token = jwt.encode({"alg": "RS256", "kid": "fixture"}, claims, key).decode()
        return httpx.Response(200, json={"access_token": "fixture-access", "refresh_token": "fixture-refresh",
                                        "token_type": "Bearer", "expires_in": 300, "id_token": token})

    class ProviderClient(AsyncOAuth2Client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(provider)
            super().__init__(*args, **kwargs)

    oauth = BoundedStateOAuth()
    oauth.register("google", client_id="fixture-client", client_secret="fixture-secret",
                   server_metadata_url="https://provider.test/.well-known/openid-configuration",
                   client_kwargs={"scope": routes.oauth.google.client_kwargs["scope"]})
    oauth.google.client_cls = ProviderClient
    monkeypatch.setattr(routes, "oauth", oauth)
    monkeypatch.setattr(routes, "_google_tokens", {})
    monkeypatch.delenv("ALLOWED_EMAILS", raising=False)
    monkeypatch.setattr("db.get_pool", lambda: None)
    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key="fixture-session-secret")
    app.include_router(routes.router)

    with TestClient(app) as client:
        def start():
            response = client.get("/auth/google", follow_redirects=False)
            assert response.status_code == 302
            query = parse_qs(urlparse(response.headers["location"]).query)
            state = query["state"][0]
            nonces[state] = query["nonce"][0]
            assert len(response.headers["set-cookie"]) < 4096
            return state

        def finish(state):
            return client.get("/auth/google/callback", params={"state": state, "code": state},
                              follow_redirects=False)

        yield client, start, finish, nonces, exchanges


@pytest.mark.parametrize("reverse", [False, True])
def test_two_login_tabs_complete_in_either_order(google_flow, reverse):
    client, start, finish, _, exchanges = google_flow
    states = [start(), start()]
    for state in reversed(states) if reverse else states:
        response = finish(state)
        assert response.headers["location"].endswith("/dashboard")
        assert verify_token(client.cookies["access_token"])["email"] == "fixture@example.test"
        assert decrypt_tokens(client.cookies["google_tokens"])["refresh_token"] == "fixture-refresh"
    assert len(exchanges) == 2
    assert finish(states[0]).headers["location"].endswith("error=auth_failed")
    assert len(exchanges) == 2  # Consumed state is rejected before another exchange.


def test_pending_attempts_are_bounded_and_keep_newest(google_flow):
    client, start, finish, _, exchanges = google_flow
    states = [start() for _ in range(8)]
    session = json.loads(base64.b64decode(client.cookies["session"].split(".")[0]))
    assert len([key for key in session if key.startswith("_state_google_")]) == 5
    assert finish(states[0]).headers["location"].endswith("error=auth_failed")
    assert exchanges == []
    assert finish(states[-1]).headers["location"].endswith("/dashboard")


def test_callback_requires_the_initiating_session(google_flow):
    client, start, finish, _, exchanges = google_flow
    state = start()
    client.cookies.clear()
    assert finish(state).headers["location"].endswith("error=auth_failed")
    assert exchanges == []


def test_nonce_mismatch_is_rejected(google_flow):
    _, start, finish, nonces, _ = google_flow
    state = start()
    nonces[state] = "wrong-nonce"
    assert finish(state).headers["location"].endswith("error=auth_failed")


def test_expired_state_is_rejected_before_token_exchange(google_flow, monkeypatch):
    _, start, finish, _, exchanges = google_flow
    state = start()
    monkeypatch.setattr(routes.oauth.google.framework, "expires_in", -1)
    expired_state = start()
    assert finish(expired_state).headers["location"].endswith("error=auth_failed")
    assert exchanges == []
    assert finish(state).headers["location"].endswith("/dashboard")
