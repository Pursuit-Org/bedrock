import { useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { ComingSoon } from "@/components/jobs/ComingSoon";
import { cn } from "@/lib/utils";
import { JobsBuilders } from "./JobsBuilders";

type TabKey = "roles" | "builders";

const TABS: { key: TabKey; label: string }[] = [
  { key: "roles", label: "Roles" },
  { key: "builders", label: "Builders" },
];

const VALID_TABS = new Set<string>(TABS.map((t) => t.key));

export function JobsPlacementPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get("tab");
  // Default to Builders (real content) until the Roles page is built.
  const activeTab: TabKey =
    tabFromUrl && VALID_TABS.has(tabFromUrl) ? (tabFromUrl as TabKey) : "builders";

  const setTab = (key: TabKey) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", key);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader
        title="Placement"
        subtitle="Open roles and per-builder job search."
      />

      <div role="tablist" className="mb-5 flex gap-1 border-b border-border-strong">
        {TABS.map((t) => {
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

      {activeTab === "roles" && (
        <ComingSoon title="Roles" description="Role tracking is coming soon." />
      )}
      {activeTab === "builders" && <JobsBuilders />}
    </div>
  );
}
