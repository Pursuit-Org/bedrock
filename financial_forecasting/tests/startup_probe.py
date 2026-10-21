"""Run the real application lifespan in a fresh process with isolated services."""

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
import main


def run():
    client = MagicMock(connected_services={"salesforce": object()})
    connections = ["connect_salesforce", "connect_sage_intacct", "connect_slack",
                   "connect_google_calendar", "connect_gmail", "connect_fireflies", "disconnect_all"]
    for name in connections:
        setattr(client, name, AsyncMock())
    with patch.object(main, "init_db", new_callable=AsyncMock) as init_db, \
         patch.object(main, "close_db", new_callable=AsyncMock) as close_db, \
         patch.object(main, "UnifiedMCPClient", return_value=client), \
         patch.object(main, "ForecastingEngine"), patch.object(main, "DataSyncService"), \
         patch("db.get_pool", return_value=MagicMock()), \
         patch.object(main, "get_db_status", return_value="connected"), \
         patch.object(main, "background_sync_task", new_callable=AsyncMock) as sync, \
         patch.object(main, "background_award_reconciler_task", new_callable=AsyncMock) as awards, \
         patch("services.sf_notification_poller.run_forever", new_callable=AsyncMock) as sf_poller, \
         patch("services.intro_notification_poller.run_forever", new_callable=AsyncMock) as intro_poller, \
         patch("services.notification_cleanup.run_forever", new_callable=AsyncMock) as cleanup:
        assert main.startup_event in main.app.router.on_startup
        assert main.shutdown_event in main.app.router.on_shutdown
        with TestClient(main.app) as http:
            response = http.get("/health")
            assert response.status_code == 200
            assert response.json()["success"] is True
            assert response.json()["meta"]["services"]["mcp_client"] is True
            init_db.assert_awaited_once()
            for name in connections[:-1]:
                getattr(client, name).assert_awaited_once()
            for task in (sync, awards, sf_poller, intro_poller, cleanup):
                task.assert_awaited_once()
        close_db.assert_awaited_once()
        client.disconnect_all.assert_awaited_once()
    print("Real startup, background scheduling, health and shutdown passed")


if __name__ == "__main__":
    run()
