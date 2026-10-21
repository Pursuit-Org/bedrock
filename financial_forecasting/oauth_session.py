"""Bound Google login attempts without invalidating another browser tab."""

import time

from authlib.integrations.starlette_client import OAuth, StarletteIntegration


class BoundedStateIntegration(StarletteIntegration):
    max_pending_states = 5

    async def set_state_data(self, session, state, data):
        prefix = f"_state_{self.name}_"
        now = time.time()
        pending = sorted(
            ((key, value) for key, value in (session or {}).items()
             if key.startswith(prefix) and value.get("exp", 0) > now),
            key=lambda item: item[1]["exp"],
        )[-(self.max_pending_states - 1):]
        # The authorization URL is only used for the redirect, not the callback.
        # Omitting that long duplicate keeps five signed-cookie states below 4KB.
        data = {key: value for key, value in data.items() if key != "url"}
        # Retain Authlib's cache marker, expiry and session-binding behavior.
        await super().set_state_data(session, state, data)
        if session is not None:
            session.update(pending)

    async def get_state_data(self, session, state):
        marker = (session or {}).get(f"_state_{self.name}_{state}")
        if not marker or marker.get("exp", 0) <= time.time():
            return None
        return await super().get_state_data(session, state)


class BoundedStateOAuth(OAuth):
    framework_integration_cls = BoundedStateIntegration
