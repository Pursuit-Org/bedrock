import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { PageHeader } from "@/components/PageHeader";
import { ConnectionsTab } from "@/pages/settings/ConnectionsTab";
import { ProfilesTab } from "@/pages/settings/ProfilesTab";
import { TargetsTab } from "@/pages/settings/TargetsTab";
import { JobsTargetsTab } from "@/pages/settings/JobsTargetsTab";
import { UsersTab } from "@/pages/settings/UsersTab";
import { cn } from "@/lib/utils";
import { usePerm } from "@/services/permissions";

type TabKey = "connections" | "targets" | "users" | "profiles";

const TABS: { key: TabKey; label: string }[] = [
  { key: "connections", label: "Connections" },
  { key: "targets", label: "Targets" },
  { key: "users", label: "Users" },
  { key: "profiles", label: "Permission Profiles" },
];

const VALID_TABS = new Set<TabKey>(["connections", "targets", "users", "profiles"]);

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [banner, setBanner] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  // OAuth callback redirects land here with sf_connected / sf_error.
  useEffect(() => {
    const sfConnected = searchParams.get("sf_connected");
    const sfError = searchParams.get("sf_error");
    if (sfConnected === "true") {
      setBanner({ kind: "success", text: "Salesforce connected successfully." });
      const next = new URLSearchParams(searchParams);
      next.delete("sf_connected");
      setSearchParams(next, { replace: true });
    } else if (sfError) {
      setBanner({
        kind: "error",
        text: `Salesforce connection failed: ${sfError}`,
      });
      const next = new URLSearchParams(searchParams);
      next.delete("sf_error");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const isAdmin = usePerm("manage_users_roles");
  const canEditProfiles = usePerm("edit_permission_profiles") || isAdmin;
  const canManageGoals = usePerm("manage_owner_goals") || isAdmin;
  const canManageJobsTargets = usePerm("manage_jobs_targets") || isAdmin;
  // Targets has two pages: Revenue (FY owner goals) and Jobs (team + targets).
  const targetsView = searchParams.get("targets") === "jobs" ? "jobs" : "revenue";
  const setTargetsView = (v: "revenue" | "jobs") => {
    const next = new URLSearchParams(searchParams);
    if (v === "jobs") next.set("targets", "jobs"); else next.delete("targets");
    setSearchParams(next, { replace: true });
  };

  const tabFromUrl = searchParams.get("tab");
  const activeTab: TabKey =
    tabFromUrl && VALID_TABS.has(tabFromUrl as TabKey)
      ? (tabFromUrl as TabKey)
      : "connections";

  // Hide tabs the caller can't access. Connections is always shown.
  // Targets always rendered; the read-only mode handles missing perms.
  const visibleTabs = TABS.filter((t) => {
    if (t.key === "users" || t.key === "profiles") return isAdmin;
    return true;
  });

  // Auto-redirect away from a hidden tab if URL points to one.
  const shouldRedirect =
    !visibleTabs.some((t) => t.key === activeTab) &&
    tabFromUrl !== null;
  useEffect(() => {
    if (!shouldRedirect) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", "connections");
    setSearchParams(next, { replace: true });
  }, [shouldRedirect, searchParams, setSearchParams]);

  const setTab = (key: TabKey) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", key);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="mx-auto max-w-[1200px] px-7 py-6 pb-20">
      <PageHeader
        title="Settings"
        subtitle="Account, integrations, targets, and permissions"
      />

      <div role="tablist" className="mb-5 flex gap-1 border-b border-border-strong">
        {visibleTabs.map((t) => {
          const isActive = t.key === activeTab;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={isActive}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "relative -mb-px h-9 px-4 text-[13px] font-medium transition-colors",
                isActive
                  ? "border-b-2 border-accent text-ink"
                  : "border-b-2 border-transparent text-ink-3 hover:text-ink-2",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {activeTab === "connections" ? <ConnectionsTab banner={banner} /> : null}
      {activeTab === "targets" ? (
        <>
          <div className="mb-4 inline-flex overflow-hidden rounded-md border border-border-strong bg-surface" role="tablist" aria-label="Targets">
            {(["revenue", "jobs"] as const).map((v, i) => (
              <button key={v} type="button" role="tab" aria-selected={targetsView === v} onClick={() => setTargetsView(v)}
                className={cn("h-8 px-4 text-[12.5px] font-medium text-ink-2", i > 0 && "border-l border-border-strong",
                  targetsView === v && "bg-surface-2 text-ink")}>
                {v === "revenue" ? "Revenue" : "Jobs"}
              </button>
            ))}
          </div>
          {targetsView === "revenue"
            ? <TargetsTab canEdit={canManageGoals} />
            : <JobsTargetsTab canEdit={canManageJobsTargets} />}
        </>
      ) : null}
      {activeTab === "users" && isAdmin ? <UsersTab /> : null}
      {activeTab === "profiles" && isAdmin ? (
        <ProfilesTab isAdmin={isAdmin} canEdit={canEditProfiles} />
      ) : null}
    </div>
  );
}
