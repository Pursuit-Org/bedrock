import { useMemo, useState } from "react";
import { ChevronUp, ChevronDown, Search, LayoutGrid, Table2, CheckCircle2 } from "lucide-react";

import {
  useBuilderBoard,
  BUILDER_STATUS_ORDER,
  BUILDER_STATUS_LABELS,
  BUILDER_STATUS_STYLES,
  type BuilderBoardRow,
  type BuilderStatus,
} from "@/services/jobs";
import { cn } from "@/lib/utils";
import { BuilderDetailDrawer } from "@/components/jobs/BuilderDetailDrawer";

type ViewMode = "table" | "board";
type SortKey = "name" | "status" | "coach" | "applications" | "interviews" | "placements" | "readiness";
type SortDir = "asc" | "desc";

export function JobsBuilders() {
  const { data, isLoading } = useBuilderBoard();
  const [mode, setMode] = useState<ViewMode>("table");
  const [search, setSearch] = useState("");
  const [coach, setCoach] = useState<string>("all");
  const [cohort, setCohort] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<number | null>(null);

  const builders = data?.builders ?? [];

  const coaches = useMemo(
    () => Array.from(new Set(builders.map((b) => b.coach).filter(Boolean))).sort() as string[],
    [builders],
  );

  // Cohort filter values: "l3plus" (the whole job-ready pool), "l3plus:<L3
  // class>" (one slice of it — the same segments as the dashboard filter), or a
  // plain cohort name for builders still in L3. Largest first within each
  // group; names don't sort chronologically ("L3 - March 2026" < "L3 - August 2026").
  const cohortOptions = useMemo(() => {
    const tally = (keys: string[]) => {
      const m = new Map<string, number>();
      for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
      return Array.from(m, ([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    };
    const pool = builders.filter((b) => b.l3plus_segment);
    return {
      l3plusTotal: pool.length,
      segments: tally(pool.map((b) => b.l3plus_segment!)),
      others: tally(builders.filter((b) => !b.l3plus_segment && b.cohort).map((b) => b.cohort!)),
    };
  }, [builders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return builders.filter((b) => {
      if (coach !== "all" && b.coach !== coach) return false;
      if (cohort === "l3plus") { if (!b.l3plus_segment) return false; }
      else if (cohort.startsWith("l3plus:")) { if (b.l3plus_segment !== cohort.slice(7)) return false; }
      else if (cohort !== "all" && (b.l3plus_segment || b.cohort !== cohort)) return false;
      if (!q) return true;
      return (
        (b.name ?? "").toLowerCase().includes(q) ||
        (b.cohort ?? "").toLowerCase().includes(q) ||
        (b.email ?? "").toLowerCase().includes(q)
      );
    });
  }, [builders, search, coach, cohort]);

  // Chips follow the active filters, so picking a cohort shows that cohort's
  // status breakdown rather than the all-builders totals from the server.
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<BuilderStatus, number>> = {};
    for (const b of filtered) counts[b.status] = (counts[b.status] ?? 0) + 1;
    return counts;
  }, [filtered]);

  const sorted = useMemo(() => {
    const val = (b: BuilderBoardRow): string | number => {
      switch (sortKey) {
        case "name": return (b.name ?? "").toLowerCase();
        case "status": return BUILDER_STATUS_ORDER.indexOf(b.status);
        case "coach": return (b.coach ?? "~").toLowerCase();
        case "applications": return b.counts.applications;
        case "interviews": return b.counts.interviews;
        case "placements": return b.counts.placements;
        case "readiness": return b.readiness.complete;
      }
    };
    return [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "name" || k === "coach" ? "asc" : "desc"); }
  }

  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-border-strong bg-surface-2 p-1">
          {([["table", Table2, "Table"], ["board", LayoutGrid, "Board"]] as const).map(([m, Icon, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                mode === m ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
              )}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={cohort}
            onChange={(e) => setCohort(e.target.value)}
            className="rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[12.5px] text-ink focus:border-accent focus:outline-none"
          >
            <option value="all">All cohorts ({builders.length})</option>
            {cohortOptions.l3plusTotal > 0 ? (
              <optgroup label="L3+ · by L3 class">
                <option value="l3plus">All L3+ ({cohortOptions.l3plusTotal})</option>
                {cohortOptions.segments.map((c) => (
                  <option key={c.name} value={`l3plus:${c.name}`}>{c.name} ({c.n})</option>
                ))}
              </optgroup>
            ) : null}
            {cohortOptions.others.length > 0 ? (
              <optgroup label="In L3">
                {cohortOptions.others.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.n})</option>)}
              </optgroup>
            ) : null}
          </select>
          <select
            value={coach}
            onChange={(e) => setCoach(e.target.value)}
            className="rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[12.5px] text-ink focus:border-accent focus:outline-none"
          >
            <option value="all">All coaches</option>
            {coaches.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search builder, cohort…"
              className="w-[230px] rounded-md border border-border-strong bg-surface py-1.5 pl-8 pr-3 text-[12.5px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Status summary chips */}
      {data ? (
        <div className="flex flex-wrap gap-2">
          {BUILDER_STATUS_ORDER.map((s) => (
            <span key={s} className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium", BUILDER_STATUS_STYLES[s])}>
              {BUILDER_STATUS_LABELS[s]}
              <span className="font-mono font-semibold tabular-nums">{statusCounts[s] ?? 0}</span>
            </span>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        <div className="px-4 py-10 text-center text-[13px] text-ink-4">Loading builders…</div>
      ) : mode === "table" ? (
        <BuilderTable rows={sorted} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} onSelect={setSelected} />
      ) : (
        <BuilderBoardView rows={filtered} onSelect={setSelected} />
      )}

      <BuilderDetailDrawer userId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// ── Status chip ───────────────────────────────────────────────────────────────
function StatusChip({ status, overridden }: { status: BuilderStatus; overridden?: boolean }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", BUILDER_STATUS_STYLES[status])}
      title={overridden ? "Manually set" : "Auto-derived"}
    >
      {BUILDER_STATUS_LABELS[status]}
      {overridden ? <span className="opacity-60">•</span> : null}
    </span>
  );
}

function Readiness({ complete, total }: { complete: number; total: number }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] tabular-nums">
      <CheckCircle2 size={12} className={complete === total ? "text-[var(--green)]" : "text-ink-4"} />
      {complete}/{total}
    </span>
  );
}

// ── Table ───────────────────────────────────────────────────────────────────
function BuilderTable({
  rows, sortKey, sortDir, onSort, onSelect,
}: {
  rows: BuilderBoardRow[]; sortKey: SortKey; sortDir: SortDir;
  onSort: (k: SortKey) => void; onSelect: (id: number) => void;
}) {
  const cols: { key: SortKey; label: string; align?: "right" }[] = [
    { key: "name", label: "Builder" },
    { key: "status", label: "Status" },
    { key: "coach", label: "Coach" },
    { key: "applications", label: "Apps", align: "right" },
    { key: "interviews", label: "Interviews", align: "right" },
    { key: "placements", label: "Placements", align: "right" },
    { key: "readiness", label: "Readiness", align: "right" },
  ];
  return (
    <div className="max-h-[600px] overflow-auto rounded-[8px] border border-border-strong bg-surface shadow-[var(--shadow-sm)]">
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                onClick={() => onSort(c.key)}
                className={cn("cursor-pointer select-none px-4 py-2 font-semibold", c.align === "right" ? "text-right" : "text-left")}
              >
                <span className={cn("inline-flex items-center gap-1", c.align === "right" && "flex-row-reverse")}>
                  {c.label}
                  {sortKey === c.key ? (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols.length} className="px-4 py-8 text-center text-ink-4">No builders.</td></tr>
          ) : rows.map((b) => (
            <tr
              key={b.user_id}
              onClick={() => onSelect(b.user_id)}
              className="cursor-pointer border-t border-border-strong hover:bg-surface-2/50"
            >
              <td className="px-4 py-2.5">
                <div className="font-medium text-ink">{b.name ?? `Builder #${b.user_id}`}</div>
                <div className="flex items-center gap-1.5 text-[11px] text-ink-4">
                  {b.cohort ?? "—"}
                  {b.cohort_completed ? <span className="rounded bg-[var(--green-soft)] px-1 text-[9.5px] font-semibold text-[var(--green)]">completed</span> : null}
                </div>
              </td>
              <td className="px-4 py-2.5"><StatusChip status={b.status} overridden={b.status_overridden} /></td>
              <td className="px-4 py-2.5 text-ink-2">{b.coach ?? "—"}</td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-ink-2">{b.counts.applications}</td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-ink-2">{b.counts.interviews}</td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-ink-2">{b.counts.placements}</td>
              <td className="px-4 py-2.5 text-right"><Readiness complete={b.readiness.complete} total={b.readiness.total} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Board ─────────────────────────────────────────────────────────────────────
function BuilderBoardView({ rows, onSelect }: { rows: BuilderBoardRow[]; onSelect: (id: number) => void }) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {BUILDER_STATUS_ORDER.map((status) => {
        const col = rows.filter((b) => b.status === status);
        return (
          <div key={status} className="flex min-w-[220px] flex-1 flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold", BUILDER_STATUS_STYLES[status])}>
                {BUILDER_STATUS_LABELS[status]}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-ink-4">{col.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {col.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border-strong px-3 py-4 text-center text-[11px] text-ink-4">—</div>
              ) : col.map((b) => (
                <button
                  key={b.user_id}
                  onClick={() => onSelect(b.user_id)}
                  className="flex flex-col gap-1 rounded-lg border border-border-strong bg-surface px-3 py-2 text-left shadow-sm transition-colors hover:bg-surface-2/50"
                >
                  <span className="text-[12.5px] font-medium text-ink">{b.name ?? `Builder #${b.user_id}`}</span>
                  <span className="text-[10.5px] text-ink-4">{b.cohort ?? "—"} · {b.coach ?? "no coach"}</span>
                  <span className="flex items-center gap-2 text-[10.5px] text-ink-3">
                    <span>{b.counts.applications} apps</span>
                    <span>{b.counts.interviews} int</span>
                    <span>{b.counts.placements} plc</span>
                    <span className="ml-auto"><Readiness complete={b.readiness.complete} total={b.readiness.total} /></span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
