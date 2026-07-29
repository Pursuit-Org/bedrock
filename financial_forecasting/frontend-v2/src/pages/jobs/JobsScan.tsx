import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Briefcase,
  Check,
  ExternalLink,
  Loader2,
  Search,
  Send,
  Users,
  X,
} from "lucide-react";

import {
  useScanResults,
  useScanSummary,
  useTriageResult,
  usePromoteToPathfinder,
  useCreateOpportunityFromScan,
  formatComp,
  type ScanFilters,
  type ScanResult,
  type TriageState,
} from "@/services/jobsScan";
import { cn } from "@/lib/utils";

const STATE_TABS: { id: TriageState | "all"; label: string }[] = [
  { id: "new", label: "Needs review" },
  { id: "approved", label: "Approved" },
  { id: "promoted", label: "Published" },
  { id: "rejected", label: "Dismissed" },
  { id: "all", label: "All" },
];

const PLATFORMS = ["greenhouse", "ashby", "lever", "gem", "workday"];

function relativeDays(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function Tile({ label, value, tone }: { label: string; value: string | number; tone?: "warn" }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">
        <span className={cn(tone === "warn" && "text-amber-600")}>{value}</span>
      </div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

/** Compact provenance badge. `comp_source` tells a reviewer how much to trust a salary. */
function CompCell({ row }: { row: ScanResult }) {
  const text = formatComp(row.salary_min, row.salary_max);
  const weak = row.comp_source === "jd_regex" || !row.comp_source;
  return (
    <div className="whitespace-nowrap">
      <span className={cn(text === "—" && "text-muted-foreground")}>{text}</span>
      {text !== "—" && weak && (
        <span
          className="ml-1 text-[10px] text-muted-foreground"
          title="Parsed from the job description rather than structured data — verify before publishing"
        >
          ~
        </span>
      )}
    </div>
  );
}

function WarmCell({ row }: { row: ScanResult }) {
  if (!row.warm_contact_count) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const names = (row.warm_contacts || []).filter(Boolean);
  return (
    <div
      className="flex items-center gap-1 text-xs text-emerald-700"
      title={names.join(", ")}
    >
      <Users className="h-3.5 w-3.5 shrink-0" />
      <span className="font-medium">{row.warm_contact_count}</span>
      {names[0] && <span className="truncate max-w-[7rem]">{names[0]}</span>}
    </div>
  );
}

function ScoreCell({ score }: { score: number | null }) {
  if (score == null) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title="Not yet scored — the scan populates the queue; scoring is a separate pass"
      >
        unscored
      </span>
    );
  }
  const tone =
    score >= 75 ? "bg-emerald-100 text-emerald-800"
      : score >= 55 ? "bg-amber-100 text-amber-800"
        : "bg-muted text-muted-foreground";
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium tabular-nums", tone)}>
      {Math.round(score)}
    </span>
  );
}

export function JobsScan() {
  const [tab, setTab] = useState<TriageState | "all">("new");
  const [platform, setPlatform] = useState<string>("");
  const [warmOnly, setWarmOnly] = useState(false);
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const filters: ScanFilters = useMemo(
    () => ({
      state: tab === "all" ? undefined : tab,
      platform: platform || undefined,
      has_warm_contact: warmOnly ? true : undefined,
      q: q.trim() || undefined,
      include_closed: tab === "all",
      limit: 200,
    }),
    [tab, platform, warmOnly, q],
  );

  const { data, isLoading, isError } = useScanResults(filters);
  const { data: summary } = useScanSummary();
  const triage = useTriageResult();
  const promote = usePromoteToPathfinder();
  const createOpp = useCreateOpportunityFromScan();

  const rows = data?.results ?? [];
  const boards = summary?.boards ?? {};

  async function withBusy(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Needs review" value={summary?.by_state?.new ?? 0} />
        <Tile label="New this week" value={summary?.new_this_week ?? 0} />
        <Tile label="Published" value={summary?.by_state?.promoted ?? 0} />
        <Tile label="Boards verified" value={`${boards.verified ?? 0}/${boards.total ?? 0}`} />
        <Tile
          label="Boards needing attention"
          value={(boards.stale ?? 0) + (boards.failing ?? 0)}
          tone={(boards.stale ?? 0) + (boards.failing ?? 0) > 0 ? "warn" : undefined}
        />
      </div>

      {/* A stale board answers 200 with an empty list, so it looks identical to
          "no open roles" unless we say so out loud. */}
      {((boards.stale ?? 0) > 0 || (boards.failing ?? 0) > 0) && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {boards.stale ?? 0} board(s) have returned nothing for 3+ scans and{" "}
            {boards.failing ?? 0} failed to fetch. A company that switched ATS returns an
            empty list rather than an error, so these may be missing roles rather than
            genuinely quiet. Re-probe their slugs.
          </span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border p-0.5">
          {STATE_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {t.id !== "all" && summary?.by_state?.[t.id] != null && (
                <span className="ml-1 tabular-nums opacity-70">
                  {summary.by_state[t.id]}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search role or company"
            className="h-8 w-56 rounded-md border pl-7 pr-2 text-xs"
          />
        </div>

        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="h-8 rounded-md border px-2 text-xs"
        >
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={warmOnly}
            onChange={(e) => setWarmOnly(e.target.checked)}
          />
          Only where we know someone
        </label>

        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {rows.length} role{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[64rem] text-sm">
          <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Company</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Location</th>
              <th className="px-3 py-2 font-medium">Comp</th>
              <th className="px-3 py-2 font-medium">Fit</th>
              <th className="px-3 py-2 font-medium">Who we know</th>
              <th className="px-3 py-2 font-medium">Seen</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            )}

            {isError && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-sm text-destructive">
                  Could not load scan results.
                </td>
              </tr>
            )}

            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-sm text-muted-foreground">
                  Nothing here yet. Add companies to the watchlist, then the weekly scan
                  fills this queue.
                </td>
              </tr>
            )}

            {rows.map((row) => {
              const busy = busyId === row.id;
              const published = row.triage_state === "promoted" || !!row.promoted_posting_id;
              const tracked = !!row.opportunity_id;
              return (
                <tr key={row.id} className={cn("hover:bg-muted/30", busy && "opacity-60")}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.company ?? row.account_key}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {row.platform}
                      {row.relationship === "warm_partner" && " · warm"}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {row.url ? (
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 hover:underline"
                      >
                        {row.title ?? "Role"}
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
                      </a>
                    ) : (
                      (row.title ?? "Role")
                    )}
                    {row.matched_family && (
                      <div className="text-[11px] text-muted-foreground">{row.matched_family}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {row.is_remote ? "Remote" : (row.location ?? "—")}
                  </td>
                  <td className="px-3 py-2 text-xs"><CompCell row={row} /></td>
                  <td className="px-3 py-2"><ScoreCell score={row.score} /></td>
                  <td className="px-3 py-2"><WarmCell row={row} /></td>
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {relativeDays(row.first_seen_at)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {published && (
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800">
                          Pathfinder
                        </span>
                      )}
                      {tracked && (
                        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-800">
                          Tracked
                        </span>
                      )}

                      {!published && (
                        <button
                          disabled={busy}
                          onClick={() => withBusy(row.id, () =>
                            promote.mutateAsync({ id: row.id, share: true }))}
                          title="Publish to the builder-facing Pathfinder board"
                          className="inline-flex items-center gap-1 rounded border px-1.5 py-1 text-[11px] hover:bg-muted"
                        >
                          <Send className="h-3 w-3" /> Pathfinder
                        </button>
                      )}

                      {!tracked && (
                        <button
                          disabled={busy}
                          onClick={() => withBusy(row.id, () =>
                            createOpp.mutateAsync({ id: row.id, deal_type: "ft" }))}
                          title="Create an opportunity so this shows up in the opportunities pipeline"
                          className="inline-flex items-center gap-1 rounded border px-1.5 py-1 text-[11px] hover:bg-muted"
                        >
                          <Briefcase className="h-3 w-3" /> Opportunity
                        </button>
                      )}

                      {row.triage_state === "new" && (
                        <>
                          <button
                            disabled={busy}
                            onClick={() => withBusy(row.id, () =>
                              triage.mutateAsync({ id: row.id, triage_state: "approved" }))}
                            title="Approve without publishing yet"
                            className="rounded border p-1 hover:bg-muted"
                          >
                            <Check className="h-3 w-3" />
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => withBusy(row.id, () =>
                              triage.mutateAsync({ id: row.id, triage_state: "rejected" }))}
                            title="Dismiss — a reject survives future re-scans"
                            className="rounded border p-1 text-muted-foreground hover:bg-muted"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Roles are found by reading watched companies' public ATS boards. Nothing reaches
        builders until someone publishes it here.{" "}
        <span title="api and structured page data are trustworthy; a ~ marks a salary parsed out of the job description">
          A <span className="font-mono">~</span> next to comp means it was parsed from the
          job description — verify before publishing.
        </span>
      </p>
    </div>
  );
}
