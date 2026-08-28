"""Auth router — Google OAuth, Salesforce OAuth, /auth/me, logout."""

import os
import logging
from datetime import datetime, timezone
from typing import Dict, Optional
from urllib.parse import quote, quote_plus

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from authlib.integrations.starlette_client import OAuth
from simple_salesforce import Salesforce

from auth import (
    create_access_token,
    get_current_user,
    encrypt_tokens,
    decrypt_tokens,
    cookie_params,
    IS_PRODUCTION,
    FRONTEND_URL,
)
from security import validate_salesforce_id

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Google OAuth setup (Authlib)
# ---------------------------------------------------------------------------

GOOGLE_CLIENT_ID = os.getenv('GOOGLE_CLIENT_ID')
GOOGLE_CLIENT_SECRET = os.getenv('GOOGLE_CLIENT_SECRET')
GOOGLE_REDIRECT_URI = os.getenv('GOOGLE_REDIRECT_URI', 'http://localhost:8000/auth/google/callback')

oauth = OAuth()
oauth.register(
    name='google',
    client_id=GOOGLE_CLIENT_ID,
    client_secret=GOOGLE_CLIENT_SECRET,
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={
        'scope': 'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly',
        'access_type': 'offline',
        'prompt': 'consent',
    }
)

# In-memory cache of Google tokens keyed by email
_google_tokens: Dict[str, Dict] = {}

# PBD calendar ID
PBD_CALENDAR_ID = os.getenv(
    'PBD_CALENDAR_ID',
    'c_f06065f4e4551cee88f8d465a6a77a24c8333c66a0077770a3e60b8d26251e98@group.calendar.google.com'
)


# ---------------------------------------------------------------------------
# Google credential helper (used by calendar/gmail endpoints in main.py)
# ---------------------------------------------------------------------------

def get_google_credentials(email: str, request: Request = None):
    """Build google.oauth2.credentials.Credentials for a user.

    Checks in-memory cache first, then falls back to encrypted cookie.
    Proactively refreshes expired tokens if a refresh_token is available.
    """
    from google.oauth2.credentials import Credentials
    import google.auth.transport.requests

    tokens = _google_tokens.get(email)

    # If not in memory, try to restore from encrypted cookie
    if (not tokens or not tokens.get('access_token')) and request:
        cookie = request.cookies.get("google_tokens")
        if cookie:
            try:
                restored = decrypt_tokens(cookie)
                if restored and restored.get('access_token'):
                    tokens = restored
                    _google_tokens[email] = tokens
                    has_refresh = bool(restored.get('refresh_token'))
                    logger.info(f"Restored Google tokens from cookie for {email} (has refresh_token: {has_refresh})")
                else:
                    logger.warning(f"Google cookie decrypted but missing access_token for {email}")
            except Exception as e:
                logger.warning(f"Failed to decrypt Google tokens cookie for {email}: {e}")
        else:
            logger.info(f"No google_tokens cookie found for {email} — user needs to re-login via Google")

    if not tokens or not tokens.get('access_token'):
        logger.warning(f"No Google tokens available for {email}")
        return None

    refresh_token = tokens.get('refresh_token')
    if not refresh_token:
        logger.warning(f"No refresh_token for {email} - Google APIs will fail if access token is expired. User needs to re-login.")

    # Convert expires_at (unix timestamp from Authlib) to naive UTC datetime.
    # google-auth uses datetime.utcnow() internally — expiry MUST be naive
    # or the comparison raises TypeError.
    expiry = None
    expires_at = tokens.get('expires_at')
    if expires_at:
        try:
            expiry = datetime.fromtimestamp(float(expires_at), tz=timezone.utc).replace(tzinfo=None)
        except (ValueError, TypeError, OSError):
            logger.warning(f"Invalid expires_at for {email}: {expires_at}")

    creds = Credentials(
        token=tokens['access_token'],
        refresh_token=refresh_token,
        token_uri='https://oauth2.googleapis.com/token',
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        expiry=expiry,
    )

    # Proactively refresh if the token is expired and we have a refresh token
    if creds.expired and refresh_token:
        try:
            creds.refresh(google.auth.transport.requests.Request())
            tokens['access_token'] = creds.token
            if creds.expiry:
                # creds.expiry is naive UTC; .replace(tz=utc).timestamp() converts correctly
                # (bare .timestamp() would interpret as local time — wrong)
                tokens['expires_at'] = creds.expiry.replace(tzinfo=timezone.utc).timestamp()
            _google_tokens[email] = tokens
            logger.info(f"Proactively refreshed Google access token for {email}")
        except Exception as e:
            logger.warning(f"Failed to refresh Google token for {email}: {e}")

    return creds


# ---------------------------------------------------------------------------
# Google OAuth endpoints
# ---------------------------------------------------------------------------

@router.get("/auth/google")
async def auth_google(request: Request):
    """Initiate Google OAuth flow."""
    # Clear any stale state from previous (possibly failed) OAuth attempts so
    # the new state we're about to generate is the only one in the session.
    # Without this, multiple rapid "Sign in" clicks leave old state in the
    # session cookie that makes the next callback fail with mismatching_state.
    request.session.clear()
    return await oauth.google.authorize_redirect(
        request, GOOGLE_REDIRECT_URI,
        access_type='offline',
        prompt='consent',
    )


@router.get("/auth/google/callback")
async def auth_google_callback(request: Request):
    """Handle Google OAuth callback."""
    try:
        token = await oauth.google.authorize_access_token(request)

        user_info = token.get('userinfo')
        if not user_info:
            raise HTTPException(status_code=400, detail="Failed to get user info from Google")

        email = user_info['email']

        # Optional allowlist
        allowed_emails_raw = os.getenv('ALLOWED_EMAILS', '').strip()
        if allowed_emails_raw:
            allowed = {e.strip().lower() for e in allowed_emails_raw.split(',') if e.strip()}
            if allowed and email.lower() not in allowed:
                logger.warning(f"Rejected login: {email} not in ALLOWED_EMAILS")
                return RedirectResponse(url=f"{FRONTEND_URL}/login?error=access_denied")

        # Cache Google API tokens in memory
        google_token_data = {
            'access_token': token.get('access_token'),
            'refresh_token': token.get('refresh_token'),
            'expires_at': token.get('expires_at'),
            'token_type': token.get('token_type', 'Bearer'),
        }
        _google_tokens[email] = google_token_data
        logger.info(f"Stored Google tokens for {email} (has refresh: {bool(token.get('refresh_token'))})")

        # Provision the org_users row + stamp last_login_at. Doing this
        # here (rather than waiting for the first permission-gated route
        # to lazy-create it) ensures every successful login leaves a
        # trace that the Users tab can filter on.
        try:
            from db import get_pool
            from routes.permissions import record_bedrock_login
            pool = get_pool()
            if pool is not None:
                async with pool.acquire() as conn:
                    await record_bedrock_login(email, user_info.get('name', ''), conn)
        except Exception as e:
            logger.warning(f"record_bedrock_login failed for {email}: {e}")

        # Create JWT
        access_token = create_access_token({
            "email": email,
            "name": user_info.get('name', ''),
            "picture": user_info.get('picture', ''),
            "sub": user_info['sub'],
        })

        # Redirect to the dashboard — the post-login landing page.
        # (Old code redirected to /priorities, which no longer exists in
        # frontend-v2; the alias-route worked most of the time but lost
        # races against AuthGate when the cookie hadn't propagated yet.)
        response = RedirectResponse(url=f"{FRONTEND_URL}/dashboard")
        cp = cookie_params()
        response.set_cookie(key="access_token", value=access_token, **cp)

        # Persist Google tokens in encrypted cookie
        encrypted_google = encrypt_tokens(google_token_data)
        response.set_cookie(key="google_tokens", value=encrypted_google, **cp)

        return response

    except Exception as e:
        logger.error(f"OAuth callback error: {e}")
        return RedirectResponse(url=f"{FRONTEND_URL}/login?error=auth_failed")


# ---------------------------------------------------------------------------
# /auth/me — current user + connection status
# ---------------------------------------------------------------------------

@router.get("/auth/me")
async def get_me(request: Request):
    """Get current authenticated user, including SF/Google connection status."""
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Salesforce connection status
    sf_cookie = request.cookies.get("sf_tokens")
    if sf_cookie:
        tokens = decrypt_tokens(sf_cookie)
        if tokens:
            user["salesforce_connected"] = True
            user["salesforce_user_id"] = tokens.get("user_id")
            user["salesforce_user_name"] = tokens.get("user_name")
        else:
            user["salesforce_connected"] = False
            user["salesforce_user_id"] = None
            user["salesforce_user_name"] = None
    else:
        user["salesforce_connected"] = False
        user["salesforce_user_id"] = None
        user["salesforce_user_name"] = None

    # Google connection status
    email = user.get("email")
    google_tokens = _google_tokens.get(email) if email else None
    google_cookie = request.cookies.get("google_tokens") if not google_tokens else None
    user["google_connected"] = bool(
        (google_tokens and google_tokens.get("access_token"))
        or (google_cookie and decrypt_tokens(google_cookie))
    )
    user["google_email"] = email

    # Slack — bot-level check
    user["slack_configured"] = bool(os.getenv('SLACK_BOT_TOKEN'))
    user["slack_workspace"] = None

    # PBD calendar ID
    user["calendar_pbd_id"] = PBD_CALENDAR_ID

    return user


# ---------------------------------------------------------------------------
# Logout
# ---------------------------------------------------------------------------

@router.post("/auth/logout")
async def logout(response: Response):
    """Logout user by clearing all auth cookies."""
    cp = cookie_params()
    del cp["max_age"]  # delete_cookie doesn't take max_age
    response.delete_cookie("access_token", **cp)
    response.delete_cookie("sf_tokens", **cp)
    response.delete_cookie("google_tokens", **cp)
    return {"message": "Logged out successfully"}


# ---------------------------------------------------------------------------
# Salesforce OAuth
# ---------------------------------------------------------------------------

def _get_sf_callback_uri() -> str:
    """Build SF OAuth callback URI."""
    if IS_PRODUCTION:
        return os.getenv('GOOGLE_REDIRECT_URI', '').replace('/auth/google/callback', '/callback')
    return 'http://localhost:8000/callback'


@router.get("/auth/salesforce")
async def auth_salesforce(request: Request):
    """Initiate Salesforce OAuth flow. User must be logged in via Google first."""
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Login with Google first")

    sf_domain = os.getenv('SALESFORCE_DOMAIN', 'login')
    client_id = os.getenv('SALESFORCE_CLIENT_ID', '')
    redirect_uri = _get_sf_callback_uri()

    auth_url = (
        f"https://{sf_domain}.salesforce.com/services/oauth2/authorize?"
        f"response_type=code&"
        f"client_id={client_id}&"
        f"redirect_uri={quote(redirect_uri, safe='')}"
    )
    logger.info(f"SF OAuth redirect to: {auth_url}")
    return RedirectResponse(url=auth_url)


@router.get("/callback")
async def auth_salesforce_callback(request: Request, code: str = None, error: str = None):
    """Handle Salesforce OAuth callback — exchange code for tokens."""
    if error:
        return RedirectResponse(url=f"{FRONTEND_URL}/settings?sf_error={quote_plus(error)}")

    if not code:
        return RedirectResponse(url=f"{FRONTEND_URL}/settings?sf_error=no_code")

    user = await get_current_user(request)
    if not user:
        return RedirectResponse(url=f"{FRONTEND_URL}/login?error=not_authenticated")

    sf_domain = os.getenv('SALESFORCE_DOMAIN', 'login')
    token_url = f"https://{sf_domain}.salesforce.com/services/oauth2/token"
    redirect_uri = _get_sf_callback_uri()

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(token_url, data={
                "grant_type": "authorization_code",
                "code": code,
                "client_id": os.getenv('SALESFORCE_CLIENT_ID', ''),
                "client_secret": os.getenv('SALESFORCE_CLIENT_SECRET', ''),
                "redirect_uri": redirect_uri,
            })

        if resp.status_code != 200:
            logger.error(f"SF token exchange failed: {resp.status_code} {resp.text}")
            return RedirectResponse(url=f"{FRONTEND_URL}/settings?sf_error=token_exchange_failed")

        token_data = resp.json()

        identity_url = token_data.get("id", "")
        sf_user_id = identity_url.split("/")[-1] if identity_url else None

        # Get SF user name
        sf_user_name = None
        if sf_user_id:
            validate_salesforce_id(sf_user_id, "sf_user_id")
            try:
                instance = token_data["instance_url"].replace("https://", "")
                temp_sf = Salesforce(instance=instance, session_id=token_data["access_token"])
                sf_user_info = temp_sf.query(f"SELECT Name, Email FROM User WHERE Id = '{sf_user_id}'")
                if sf_user_info.get("records"):
                    sf_user_name = sf_user_info["records"][0].get("Name")
            except Exception as e:
                logger.warning(f"Could not fetch SF user name: {e}")

        sf_tokens = {
            "access_token": token_data["access_token"],
            "refresh_token": token_data.get("refresh_token"),
            "instance_url": token_data["instance_url"],
            "user_id": sf_user_id,
            "user_name": sf_user_name,
            "issued_at": token_data.get("issued_at"),
        }
        encrypted = encrypt_tokens(sf_tokens)

        response = RedirectResponse(url=f"{FRONTEND_URL}/settings?sf_connected=true")
        response.set_cookie(key="sf_tokens", value=encrypted, **cookie_params())

        logger.info(f"Salesforce connected for {user.get('email')} -> SF:{sf_user_name} ({sf_user_id})")
        return response

    except Exception as e:
        logger.error(f"Salesforce OAuth error: {e}")
        return RedirectResponse(url=f"{FRONTEND_URL}/settings?sf_error=exception")


# ---------------------------------------------------------------------------
# Salesforce status / disconnect
# ---------------------------------------------------------------------------

async def _refresh_sf_token(refresh_token: str) -> Optional[dict]:
    """Refresh an expired Salesforce access token."""
    try:
        sf_domain = os.getenv('SALESFORCE_DOMAIN', 'login')
        token_url = f"https://{sf_domain}.salesforce.com/services/oauth2/token"

        async with httpx.AsyncClient() as client:
            resp = await client.post(token_url, data={
                "grant_type": "refresh_token",
                "client_id": os.getenv('SALESFORCE_CLIENT_ID', ''),
                "client_secret": os.getenv('SALESFORCE_CLIENT_SECRET', ''),
                "refresh_token": refresh_token,
            })

        if resp.status_code == 200:
            data = resp.json()
            return {
                "access_token": data["access_token"],
                "instance_url": data["instance_url"],
                "refresh_token": refresh_token,
                "user_id": data.get("id", "").split("/")[-1] if data.get("id") else None,
            }
        else:
            logger.error(f"SF token refresh failed: {resp.status_code} {resp.text}")
            return None
    except Exception as e:
        logger.error(f"SF token refresh error: {e}")
        return None


@router.get("/auth/salesforce/status")
async def salesforce_status(request: Request, response: Response):
    """Check the current user's Salesforce connection status.

    If the access token has expired but we have a refresh token, refresh it
    in-band and persist the new tokens back to the sf_tokens cookie so that
    subsequent requests see a fresh session. (Previously the refreshed token
    was only returned in the response body and silently dropped, leaving the
    client stuck with an expired cookie — see BUG-AUTH-1.)
    """
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    sf_cookie = request.cookies.get("sf_tokens")
    if not sf_cookie:
        return {"connected": False, "message": "Salesforce not connected"}

    tokens = decrypt_tokens(sf_cookie)
    if not tokens:
        return {"connected": False, "message": "Invalid token data"}

    try:
        instance = tokens["instance_url"].replace("https://", "").replace("http://", "")
        test_sf = Salesforce(instance=instance, session_id=tokens["access_token"])
        test_sf.query("SELECT Id FROM User LIMIT 1")

        return {
            "connected": True,
            "user_id": tokens.get("user_id"),
            "user_name": tokens.get("user_name"),
            "instance_url": tokens.get("instance_url"),
        }
    except Exception:
        refresh_token = tokens.get("refresh_token")
        if refresh_token:
            new_tokens = await _refresh_sf_token(refresh_token)
            if new_tokens:
                merged = {
                    "access_token": new_tokens["access_token"],
                    "refresh_token": new_tokens.get("refresh_token") or refresh_token,
                    "instance_url": new_tokens["instance_url"],
                    "user_id": new_tokens.get("user_id") or tokens.get("user_id"),
                    "user_name": tokens.get("user_name"),
                    "issued_at": tokens.get("issued_at"),
                }
                try:
                    response.set_cookie(
                        key="sf_tokens",
                        value=encrypt_tokens(merged),
                        **cookie_params(),
                    )
                except Exception as cookie_err:
                    logger.error(f"Failed to persist refreshed SF tokens: {cookie_err}")

                return {
                    "connected": True,
                    "user_id": merged["user_id"],
                    "user_name": merged["user_name"],
                    "instance_url": merged["instance_url"],
                    "refreshed": True,
                }

        return {
            "connected": False,
            "message": "Connection expired",
            "needs_reconnect": True,
        }


@router.post("/auth/salesforce/disconnect")
async def disconnect_salesforce(request: Request, response: Response):
    """Disconnect Salesforce for the current user."""
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    cp = cookie_params()
    del cp["max_age"]
    response.delete_cookie("sf_tokens", **cp)

    return {"message": "Salesforce disconnected"}
