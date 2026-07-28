import { useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { ComingSoon } from "@/components/jobs/ComingSoon";
import { cn } from "@/lib/utils";
import { JobsLeadership } from "./JobsLeadership";
import { JobsOutreach } from "./JobsOutreach";
import { JobsOpportunitiesOverview } from "./JobsOpportunitiesOverview";

type TabKey = "exec" | "outreach" | "pipeline" | "placement";

const TABS: { key: TabKey; label: string }[] = [
  { key: "exec", label: "Exec view" },
  { key: "outreach", label: "Outreach" },
  { key: "pipeline", label: "Pipeline" },
  { key: "placement", label: "Placement" },
];

const VALID_TABS = new Set<string>(TABS.map((t) => t.key));

export function JobsPerformancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get("tab");
  const activeTab: TabKey =
    tabFromUrl && VALID_TABS.has(tabFromUrl) ? (tabFromUrl as TabKey) : "exec";

  const setTab = (key: TabKey) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", key);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader
        title="Performance"
        subtitle="Pipeline health, outreach, and placement metrics."
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

      {activeTab === "exec" && <JobsLeadership />}
      {activeTab === "outreach" && <JobsOutreach />}
      {activeTab === "pipeline" && <JobsOpportunitiesOverview />}
      {activeTab === "placement" && (
        <ComingSoon
          title="Placement metrics"
          description="Placement performance reporting is coming soon."
        />
      )}
    </div>
  );
}
