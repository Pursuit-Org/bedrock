import { useMemo, useState } from "react";
import { ChevronUp, ChevronDown, Search, LayoutGrid, Table2, CheckCircle2 } from "lucide-react";

import {
  useBuilderBoard,
  useUpdateBuilderProfile,
  BUILDER_STATUS_ORDER,
  BUILDER_STATUS_LABELS,
  BUILDER_STATUS_STYLES,
  BUILDER_RATING_OPTIONS,
  BUILDER_RATING_FIELDS,
  BUILDER_FUNCTION_OPTIONS,
  BUILDER_INDUSTRY_OPTIONS,
  BUILDER_MODE_OPTIONS,
  BUILDER_DEGREE_OPTIONS,
  type BuilderBoardRow,
  type BuilderStatus,
} from "@/services/jobs";
import { cn } from "@/lib/utils";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { InlineSelect } from "@/components/ui/InlineEdit";
import {
  AddFilterButton, FilterChip, describeRule, ruleApplies,
  type FieldMeta, type FilterRule,
} from "@/pages/cleanup/Filters";
import { BuilderDetailDrawer } from "@/components/jobs/BuilderDetailDrawer";
import {
  BuilderFieldEditor, isBuilderRating as isRating, triValue, YES_NO,
  type BuilderEditableField, type BuilderListKey as ArrayKey,
  type BuilderRatingKey as RatingKey, type BuilderTriKey as TriKey,
} from "@/components/jobs/BuilderFieldEditor";

type ViewMode = "table" | "board";
type SortDir = "asc" | "desc";

// ── Columns ───────────────────────────────────────────────────────────────────
type ReadyKey = "lookbook" | "linkedin" | "github" | "cv" | "mock";
type ColKey =
  | "name" | "status" | "coach" | "applications" | "interviews" | "placements" | "readiness"
  | ArrayKey | RatingKey | `ready_${ReadyKey}` | TriKey
  | "degree" | "university" | "graduation_year" | "geo_preference";

const READY_KEYS: ReadyKey[] = ["lookbook", "linkedin", "github", "cv", "mock"];

const COLUMN_ORDER: ColKey[] = [
  "name", "status", "coach", "applications", "interviews", "placements", "readiness",
  "target_functions", "target_industries", "preferred_modes", "geo_preference",
  ...BUILDER_RATING_FIELDS.map(([k]) => k),
  ...READY_KEYS.map((k) => `ready_${k}` as const),
  "applying_regularly", "networking_regularly",
  "degree", "university", "graduation_year", "languages", "certifications",
];

const DEFAULT_VISIBLE: ColKey[] = [
  "name", "status", "coach", "applications", "interviews", "placements", "readiness",
  "target_functions", "target_industries", "preferred_modes", "geo_preference",
  ...BUILDER_RATING_FIELDS.map(([k]) => k),
];

const COL_LABELS: Record<ColKey, string> = {
  name: "Builder", status: "Status", coach: "Coach",
  applications: "Apps", interviews: "Interviews", placements: "Placements", readiness: "Readiness",
  target_functions: "Target function", target_industries: "Target industry", preferred_modes: "Work mode",
  geo_preference: "Preferred location",
  ...(Object.fromEntries(BUILDER_RATING_FIELDS) as Record<RatingKey, string>),
  ready_lookbook: "Lookbook ready", ready_linkedin: "LinkedIn ready", ready_github: "GitHub ready",
  ready_cv: "CV ready", ready_mock: "Mock interview done",
  applying_regularly: "Applying regularly", networking_regularly: "Networking regularly",
  degree: "Degree", university: "University", graduation_year: "Grad year",
  languages: "Languages", certifications: "Certifications",
};

const RIGHT_ALIGNED = new Set<ColKey>(["applications", "interviews", "placements", "readiness"]);
const isReady = (k: ColKey): k is `ready_${ReadyKey}` => k.startsWith("ready_");

// ── Filters ───────────────────────────────────────────────────────────────────
// ruleApplies splits "tags" values on commas, and "IT, Cloud & Security" has
// one — so tag filters match on a comma-free key and label it back for chips.
const tagKey = (v: string) => v.replace(/,/g, "");
const tagJoin = (vs: string[] | null | undefined) => (vs ?? []).map(tagKey).join(",");

type Field = "status" | ArrayKey | RatingKey | `ready_${ReadyKey}` | TriKey | "degree" | "university" | "graduation_year" | "geo_preference";

const FILTERABLE: Record<Field, FieldMeta<BuilderBoardRow>> = {
  status: { label: "Status", type: "select", getValue: (b) => b.status },
  target_functions: { label: "Target function", type: "tags", getValue: (b) => tagJoin(b.profile.target_functions) },
  target_industries: { label: "Target industry", type: "tags", getValue: (b) => tagJoin(b.profile.target_industries) },
  preferred_modes: { label: "Work mode", type: "tags", getValue: (b) => tagJoin(b.profile.preferred_modes) },
  geo_preference: { label: "Preferred location", type: "text", getValue: (b) => b.profile.geo_preference ?? "" },
  ...(Object.fromEntries(BUILDER_RATING_FIELDS.map(([k, label]) => [
    k, { label, type: "select", getValue: (b: BuilderBoardRow) => b.profile[k] ?? "" },
  ])) as Record<RatingKey, FieldMeta<BuilderBoardRow>>),
  ...(Object.fromEntries(READY_KEYS.map((k) => [
    `ready_${k}`, { label: COL_LABELS[`ready_${k}`], type: "select", getValue: (b: BuilderBoardRow) => (b.readiness[k] ? "yes" : "no") },
  ])) as Record<`ready_${ReadyKey}`, FieldMeta<BuilderBoardRow>>),
  applying_regularly: { label: "Applying regularly", type: "select", getValue: (b) => triValue(b.profile.applying_regularly) },
  networking_regularly: { label: "Networking regularly", type: "select", getValue: (b) => triValue(b.profile.networking_regularly) },
  degree: { label: "Degree", type: "select", getValue: (b) => b.profile.degree ?? "" },
  university: { label: "University", type: "text", getValue: (b) => b.profile.university ?? "" },
  graduation_year: { label: "Grad year", type: "number", getValue: (b) => b.profile.graduation_year },
  languages: { label: "Languages", type: "text", getValue: (b) => (b.profile.languages ?? []).join(", ") },
  certifications: { label: "Certifications", type: "text", getValue: (b) => (b.profile.certifications ?? []).join(", ") },
};

const opts = (vs: readonly string[]) => vs.map((v) => ({ value: v, label: v }));
const tagOpts = (vs: string[]) => vs.map((v) => ({ value: tagKey(v), label: v }));

const SELECT_OPTIONS: Partial<Record<Field, { value: string; label: string }[]>> = {
  status: BUILDER_STATUS_ORDER.map((s) => ({ value: s, label: BUILDER_STATUS_LABELS[s] })),
  target_functions: tagOpts(BUILDER_FUNCTION_OPTIONS),
  target_industries: tagOpts(BUILDER_INDUSTRY_OPTIONS),
  preferred_modes: tagOpts(BUILDER_MODE_OPTIONS),
  ...(Object.fromEntries(BUILDER_RATING_FIELDS.map(([k]) => [k, opts(BUILDER_RATING_OPTIONS)])) as Record<RatingKey, { value: string; label: string }[]>),
  ...(Object.fromEntries(READY_KEYS.map((k) => [`ready_${k}`, YES_NO])) as Record<`ready_${ReadyKey}`, { value: string; label: string }[]>),
  applying_regularly: YES_NO,
  networking_regularly: YES_NO,
  degree: opts(BUILDER_DEGREE_OPTIONS),
};

function renderFilterValue(field: Field, v: string): string {
  return SELECT_OPTIONS[field]?.find((o) => o.value === v)?.label ?? v;
}

export function JobsBuilders() {
  const { data, isLoading } = useBuilderBoard();
  const update = useUpdateBuilderProfile();
  const [mode, setMode] = useState<ViewMode>("table");
  const [search, setSearch] = useState("");
  const [coach, setCoach] = useState<string>("all");
  const [cohort, setCohort] = useState<string>("all");
  const [rules, setRules] = useState<FilterRule<Field>[]>([]);
  const [sortKey, setSortKey] = useState<ColKey>("status");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<number | null>(null);
  const { visible: visibleCols, toggle: toggleCol } = useColumnVisibility<ColKey>(
    "bedrock-v2:vis:jobs-builders", COLUMN_ORDER, DEFAULT_VISIBLE,
  );

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
      for (const r of rules) if (!ruleApplies(b, r, FILTERABLE)) return false;
      if (!q) return true;
      return (
        (b.name ?? "").toLowerCase().includes(q) ||
        (b.cohort ?? "").toLowerCase().includes(q) ||
        (b.email ?? "").toLowerCase().includes(q)
      );
    });
  }, [builders, search, coach, cohort, rules]);

  // Chips follow the active filters, so picking a cohort shows that cohort's
  // status breakdown rather than the all-builders totals from the server.
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<BuilderStatus, number>> = {};
    for (const b of filtered) counts[b.status] = (counts[b.status] ?? 0) + 1;
    return counts;
  }, [filtered]);

  const sorted = useMemo(() => {
    const val = (b: BuilderBoardRow): string | number => {
      const p = b.profile;
      switch (sortKey) {
        case "name": return (b.name ?? "").toLowerCase();
        case "status": return BUILDER_STATUS_ORDER.indexOf(b.status);
        case "coach": return (b.coach ?? "~").toLowerCase();
        case "applications": return b.counts.applications;
        case "interviews": return b.counts.interviews;
        case "placements": return b.counts.placements;
        case "readiness": return b.readiness.complete;
        case "graduation_year": return p.graduation_year ?? -1;
        case "applying_regularly":
        case "networking_regularly": return p[sortKey] == null ? -1 : p[sortKey] ? 1 : 0;
        case "degree":
        case "university":
        case "geo_preference": return (p[sortKey] ?? "~").toLowerCase();
      }
      if (isRating(sortKey)) return BUILDER_RATING_OPTIONS.indexOf(p[sortKey] as never);
      if (isReady(sortKey)) return b.readiness[sortKey.slice(6) as ReadyKey] ? 1 : 0;
      return (p[sortKey as ArrayKey] ?? []).join(", ").toLowerCase() || "~";
    };
    return [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  function toggleSort(k: ColKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "name" || k === "coach" || k === "university" ? "asc" : "desc"); }
  }

  const save = (userId: number, body: Record<string, unknown>) =>
    update.mutateAsync({ userId, ...body }).then(() => undefined);

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
        <div className="flex flex-wrap items-center gap-2">
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
          <AddFilterButton<Field>
            filterable={FILTERABLE as Record<Field, FieldMeta<unknown>>}
            selectOptions={SELECT_OPTIONS}
            onAdd={(r) => setRules((p) => [...p, r])}
            buttonLabel="Filter"
          />
          {mode === "table" ? (
            <ColumnChooser allColumns={COLUMN_ORDER} labels={COL_LABELS} visible={visibleCols} required={["name"]} onToggle={toggleCol} />
          ) : null}
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

      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, FILTERABLE, renderFilterValue)}
              onRemove={() => setRules((p) => p.filter((x) => x.id !== r.id))}
            />
          ))}
          <button type="button" onClick={() => setRules([])} className="ml-1 text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear all</button>
        </div>
      )}

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
        <BuilderTable
          rows={sorted} cols={visibleCols} sortKey={sortKey} sortDir={sortDir}
          onSort={toggleSort} onSelect={setSelected} onSave={save}
        />
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
function EditableCell({ b, col, onSave }: {
  b: BuilderBoardRow; col: ColKey;
  onSave: (userId: number, body: Record<string, unknown>) => Promise<void>;
}) {
  if (isReady(col)) {
    return (
      <InlineSelect
        value={b.readiness[col.slice(6) as ReadyKey] ? "yes" : "no"}
        options={YES_NO}
        onSave={(v) => onSave(b.user_id, { [col]: v === "yes" })}
      />
    );
  }
  return <BuilderFieldEditor field={col as BuilderEditableField} values={b.profile} onSave={(body) => onSave(b.user_id, body)} />;
}

function BuilderTable({
  rows, cols, sortKey, sortDir, onSort, onSelect, onSave,
}: {
  rows: BuilderBoardRow[]; cols: ColKey[]; sortKey: ColKey; sortDir: SortDir;
  onSort: (k: ColKey) => void; onSelect: (id: number) => void;
  onSave: (userId: number, body: Record<string, unknown>) => Promise<void>;
}) {
  const staticCell = (b: BuilderBoardRow, c: ColKey) => {
    switch (c) {
      case "name":
        return (
          <>
            <div className="font-medium text-ink">{b.name ?? `Builder #${b.user_id}`}</div>
            <div className="flex items-center gap-1.5 text-[11px] text-ink-4">
              {b.cohort ?? "—"}
              {b.cohort_completed ? <span className="rounded bg-[var(--green-soft)] px-1 text-[9.5px] font-semibold text-[var(--green)]">completed</span> : null}
            </div>
          </>
        );
      case "status": return <StatusChip status={b.status} overridden={b.status_overridden} />;
      case "coach": return <span className="text-ink-2">{b.coach ?? "—"}</span>;
      case "applications": return <span className="font-mono tabular-nums text-ink-2">{b.counts.applications}</span>;
      case "interviews": return <span className="font-mono tabular-nums text-ink-2">{b.counts.interviews}</span>;
      case "placements": return <span className="font-mono tabular-nums text-ink-2">{b.counts.placements}</span>;
      case "readiness": return <Readiness complete={b.readiness.complete} total={b.readiness.total} />;
      default: return undefined;
    }
  };

  return (
    <div className="max-h-[600px] overflow-auto rounded-[8px] border border-border-strong bg-surface shadow-[var(--shadow-sm)]">
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
          <tr>
            {cols.map((c) => (
              <th
                key={c}
                onClick={() => onSort(c)}
                className={cn("cursor-pointer select-none whitespace-nowrap px-4 py-2 font-semibold", RIGHT_ALIGNED.has(c) ? "text-right" : "text-left")}
              >
                <span className={cn("inline-flex items-center gap-1", RIGHT_ALIGNED.has(c) && "flex-row-reverse")}>
                  {COL_LABELS[c]}
                  {sortKey === c ? (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
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
              {cols.map((c) => {
                const fixed = staticCell(b, c);
                return fixed !== undefined ? (
                  <td key={c} className={cn("px-4 py-2.5", RIGHT_ALIGNED.has(c) && "text-right")}>{fixed}</td>
                ) : (
                  <td key={c} className="whitespace-nowrap px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                    <EditableCell b={b} col={c} onSave={onSave} />
                  </td>
                );
              })}
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
