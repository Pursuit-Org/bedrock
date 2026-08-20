import { useSearchParams } from "react-router-dom";
import { ClipboardList, GraduationCap } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { RolesBoard } from "@/components/jobs/RolesBoard";
import { cn } from "@/lib/utils";
import { JobsBuilders } from "./JobsBuilders";

type TabKey = "roles" | "builders";

const TABS: { key: TabKey; label: string; icon: typeof ClipboardList }[] = [
  { key: "roles", label: "Roles", icon: ClipboardList },
  { key: "builders", label: "Builders", icon: GraduationCap },
];

const VALID_TABS = new Set<string>(TABS.map((t) => t.key));

export function JobsPlacementPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get("tab");
  const activeTab: TabKey =
    tabFromUrl && VALID_TABS.has(tabFromUrl) ? (tabFromUrl as TabKey) : "roles";

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
        {activeTab === "roles" && <RolesBoard />}
        {activeTab === "builders" && <JobsBuilders />}
      </div>
    </div>
  );
}
