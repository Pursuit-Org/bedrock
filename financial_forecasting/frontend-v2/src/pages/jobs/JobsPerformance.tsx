import { useSearchParams } from "react-router-dom";
import { BarChart3, GraduationCap, Kanban, Send } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ComingSoon } from "@/components/jobs/ComingSoon";
import { cn } from "@/lib/utils";
import { JobsLeadership } from "./JobsLeadership";
import { JobsOutreach } from "./JobsOutreach";
import { JobsOpportunitiesOverview } from "./JobsOpportunitiesOverview";

type TabKey = "exec" | "outreach" | "pipeline" | "placement";

const TABS: { key: TabKey; label: string; icon: typeof BarChart3 }[] = [
  { key: "exec", label: "Exec view", icon: BarChart3 },
  { key: "outreach", label: "Outreach", icon: Send },
  { key: "pipeline", label: "Pipeline", icon: Kanban },
  { key: "placement", label: "Placement", icon: GraduationCap },
];

const VALID_TABS = new Set<string>(TABS.map((t) => t.key));

/** One page, four views — the header names the one you're looking at. */
const TAB_META: Record<TabKey, { title: string; subtitle: string }> = {
  exec: { title: "Exec view", subtitle: "The outcomes the leadership team tracks." },
  outreach: { title: "Outreach", subtitle: "The contacts funnel, the week's queue, and what needs a decision." },
  pipeline: { title: "Pipeline", subtitle: "The employer-deal pipeline — volume, conversion and where it's stuck." },
  placement: { title: "Placement", subtitle: "Placement performance reporting." },
};

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
        title={TAB_META[activeTab].title}
        subtitle={TAB_META[activeTab].subtitle}
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface-2 p-1">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                    activeTab === t.key
                      ? "bg-surface text-ink shadow-sm"
                      : "text-ink-3 hover:text-ink-2",
                  )}
                >
                  <Icon size={13} />
                  {t.label}
                </button>
              );
            })}
          </div>
        }
      />

      <div className="mt-1">
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
    </div>
  );
}
