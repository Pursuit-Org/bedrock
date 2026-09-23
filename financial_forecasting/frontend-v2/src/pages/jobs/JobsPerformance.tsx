import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { BarChart3, GraduationCap, Kanban, Megaphone, Send } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ComingSoon } from "@/components/jobs/ComingSoon";
import { cn } from "@/lib/utils";
import { JobsLeadership } from "./JobsLeadership";
import { JobsCampaigns } from "./JobsCampaigns";
import { JobsOutreach } from "./JobsOutreach";
import { JobsOpportunitiesOverview } from "./JobsOpportunitiesOverview";

type TabKey = "exec" | "campaigns" | "outreach" | "pipeline" | "placement";

const TABS: { key: TabKey; label: string; icon: typeof BarChart3 }[] = [
  { key: "exec", label: "Overview", icon: BarChart3 },
  { key: "campaigns", label: "Campaigns", icon: Megaphone },
  { key: "outreach", label: "Outreach", icon: Send },
  { key: "pipeline", label: "Pipeline", icon: Kanban },
  { key: "placement", label: "Placement", icon: GraduationCap },
];

const VALID_TABS = new Set<string>(TABS.map((t) => t.key));

/** The header names the view you're looking at. */
const TAB_META: Record<TabKey, { title: string; subtitle: string }> = {
  // The URL keeps ?tab=exec so existing links and bookmarks still resolve.
  exec: { title: "Overview", subtitle: "The outcomes the leadership team tracks." },
  campaigns: {
    title: "Campaigns",
    subtitle: "Each tag as a prioritized outreach push — who owns it, how far it's been worked, and what's left.",
  },
  outreach: { title: "Outreach", subtitle: "The contacts funnel, the week's queue, and what needs a decision." },
  pipeline: { title: "Pipeline", subtitle: "The employer-deal pipeline — volume, conversion and where it's stuck." },
  placement: { title: "Placement", subtitle: "Placement performance reporting." },
};

export function JobsPerformancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get("tab");
  const activeTab: TabKey =
    tabFromUrl && VALID_TABS.has(tabFromUrl) ? (tabFromUrl as TabKey) : "exec";

  // Campaigns used to be a sub-tab of Overview (?tab=exec&sub=campaigns).
  // Rewrite those URLs so existing links and bookmarks land on the new
  // top-level tab instead of silently dropping to Overview.
  const legacyCampaignsSub = activeTab === "exec" && searchParams.get("sub") === "campaigns";
  useEffect(() => {
    if (!legacyCampaignsSub) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", "campaigns");
    next.delete("sub");
    setSearchParams(next, { replace: true });
  }, [legacyCampaignsSub, searchParams, setSearchParams]);

  const setTab = (key: TabKey) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", key);
    // Clear the retired sub-tab param so an old URL doesn't keep round-tripping.
    next.delete("sub");
    setSearchParams(next, { replace: true });
  };

  const meta = TAB_META[activeTab];

  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader
        title={meta.title}
        subtitle={meta.subtitle}
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
        {activeTab === "campaigns" && <JobsCampaigns />}
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
