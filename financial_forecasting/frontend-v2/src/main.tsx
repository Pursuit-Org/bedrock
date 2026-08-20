import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Long stale time + persistent cache means navigation between
      // pages reuses fetched data instantly. Mutations + onSettled
      // refetch keep things fresh.
      staleTime: 60_000,
      gcTime: 24 * 60 * 60 * 1000, // 24h — needed for persister to keep the data
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});

const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: "bedrock-v3:rq-cache",
  // 5 MiB cap (default is 5 MB). Accounts + opps payloads can be large.
  throttleTime: 1000,
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        // Bump this when query shapes change so old caches don't poison new code.
        // v2 — 2026-05-03: Award / opp / contact schemas changed substantially
        // (prior-stage map, IsClosed/IsWon, ISA exclusion, etc.). Older
        // persisted caches were triggering "promise.then is not a function"
        // during hydrate.
        // v3 — 2026-05-05: Exclude permissions from persisted cache so
        // manage_users_roles never comes from a stale localStorage snapshot.
        // v4 — 2026-08-18: jobs/staff-sourced changed from a flat application
        // array to grouped {company_name, role_title, applications: [...]} —
        // old cached shape has no .applications, crashing render on hydrate.
        buster: "v4",
        dehydrateOptions: {
          // Only persist queries that finished successfully — pending /
          // error states carry a state.promise field that doesn't survive
          // JSON.stringify, which causes "promise.then is not a function"
          // during hydrate. Skip auth and permissions — those must always
          // be fresh on reload so permission changes take effect immediately.
          shouldDehydrateQuery: (q) => {
            const k = q.queryKey;
            if (Array.isArray(k) && (k[0] === "auth" || k[0] === "permissions")) return false;
            return q.state.status === "success" && q.state.data !== undefined;
          },
        },
        // Hide the splash if hydration is slow.
        maxAge: 24 * 60 * 60 * 1000,
      }}
    >
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </BrowserRouter>
    </PersistQueryClientProvider>
  </React.StrictMode>,
);
