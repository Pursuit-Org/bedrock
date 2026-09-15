import { useSearchParams } from "react-router-dom";
import { BarChart3, GraduationCap, Kanban, Megaphone, Send } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ComingSoon } from "@/components/jobs/ComingSoon";
import { cn } from "@/lib/utils";
import { JobsLeadership } from "./JobsLeadership";
import { JobsCampaigns } from "./JobsCampaigns";
import { JobsOutreach } from "./JobsOutreach";
import { JobsOpportunitiesOverview } from "./JobsOpportunitiesOverview";

type TabKey = "exec" | "outreach" | "pipeline" | "placement";

const TABS: { key: TabKey; label: string; icon: typeof BarChart3 }[] = [
  { key: "exec", label: "Overview", icon: BarChart3 },
  { key: "outreach", label: "Outreach", icon: Send },
  { key: "pipeline", label: "Pipeline", icon: Kanban },
  { key: "placement", label: "Placement", icon: GraduationCap },
];

const VALID_TABS = new Set<string>(TABS.map((t) => t.key));

/** Overview is the only tab with a second level. Campaigns lives under it
 *  rather than beside it because both answer the same question — how is the
 *  book performing — at different altitudes, where Outreach and Pipeline are
 *  different books entirely. Addressed as ?tab=exec&sub=campaigns. */
type SubKey = "overview" | "campaigns";

const SUB_TABS: { key: SubKey; label: string; icon: typeof BarChart3 }[] = [
  { key: "overview", label: "Overview", icon: BarChart3 },
  { key: "campaigns", label: "Campaigns", icon: Megaphone },
];

const VALID_SUBS = new Set<string>(SUB_TABS.map((t) => t.key));

/** The header names the view you're looking at. */
const TAB_META: Record<TabKey, { title: string; subtitle: string }> = {
  // The URL keeps ?tab=exec so existing links and bookmarks still resolve.
  exec: { title: "Overview", subtitle: "The outcomes the leadership team tracks." },
  outreach: { title: "Outreach", subtitle: "The contacts funnel, the week's queue, and what needs a decision." },
  pipeline: { title: "Pipeline", subtitle: "The employer-deal pipeline — volume, conversion and where it's stuck." },
  placement: { title: "Placement", subtitle: "Placement performance reporting." },
};

const CAMPAIGNS_META = {
  title: "Campaigns",
  subtitle: "Each tag as a prioritized outreach push — who owns it, how far it's been worked, and what's left.",
};

export function JobsPerformancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get("tab");
  const activeTab: TabKey =
    tabFromUrl && VALID_TABS.has(tabFromUrl) ? (tabFromUrl as TabKey) : "exec";

  const subFromUrl = searchParams.get("sub");
  const activeSub: SubKey =
    subFromUrl && VALID_SUBS.has(subFromUrl) ? (subFromUrl as SubKey) : "overview";
  const onCampaigns = activeTab === "exec" && activeSub === "campaigns";

  const setTab = (key: TabKey) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", key);
    // Leaving Overview drops its sub-tab, so coming back lands on Overview
    // itself rather than silently reopening Campaigns.
    next.delete("sub");
    setSearchParams(next, { replace: true });
  };

  const setSub = (key: SubKey) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "exec");
    if (key === "overview") next.delete("sub");
    else next.set("sub", key);
    setSearchParams(next, { replace: true });
  };

  const meta = onCampaigns ? CAMPAIGNS_META : TAB_META[activeTab];

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

      {activeTab === "exec" ? (
        <div className="mb-4 flex items-center gap-1 border-b border-border-strong">
          {SUB_TABS.map((t) => {
            const Icon = t.icon;
            const active = activeSub === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setSub(t.key)}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
                  active
                    ? "border-accent text-accent"
                    : "border-transparent text-ink-3 hover:text-ink-2",
                )}
              >
                <Icon size={13} />
                {t.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-1">
        {activeTab === "exec" && (onCampaigns ? <JobsCampaigns /> : <JobsLeadership />)}
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
