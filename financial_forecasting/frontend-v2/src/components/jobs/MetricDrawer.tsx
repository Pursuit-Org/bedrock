import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, ChevronDown, ExternalLink } from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import {
  useMetricDrill,
  useUpdateOpportunity,
  useUpdatePlacementSalary,
  useUpdatePlacementStage,
  useUpdatePlacementTitle,
  STAGES_ORDERED,
  STAGE_LABELS,
  DEAL_TYPE_LABELS,
  type JobStage,
  type DealType,
  type MetricDrill,
} from "@/services/jobs";
import { useUpdateRole } from "@/services/jobsOpps2";
import { OppRolesSection } from "@/components/jobs/OppRolesSection";
import { PlacementEndDialog } from "@/components/jobs/PlacementEndDialog";
import { useQueryClient } from "@tanstack/react-query";

// Pretty-print known coded values; pass everything else through.
function formatCell(colKey: string, value: string | null): string {
  if (value == null || value === "") return "—";
  if (colKey === "stage" && value in STAGE_LABELS) {
    return STAGE_LABELS[value as JobStage];
  }
  if (colKey === "deal_type" && value in DEAL_TYPE_LABELS) {
    return DEAL_TYPE_LABELS[value as DealType];
  }
  // Format any date/datetime column (named *_date / *_touch / when, or an
  // ISO-shaped value) to a readable "Jun 10, 2026" — never show raw ISO.
  const looksDateCol = /(_date|_touch|^when$|^date$)/.test(colKey);
  const looksIso = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(value);
  if (looksDateCol || looksIso) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }
  if (colKey === "type") return value.charAt(0).toUpperCase() + value.slice(1);
  return value;
}

// Contact-stage options (value/label).

const selectClass =
  "border border-border-strong rounded px-1.5 py-0.5 text-[12px] bg-surface " +
  "cursor-pointer transition-colors hover:border-ink-3 hover:bg-surface-2 " +
  "focus:outline-none focus:ring-1 focus:ring-border-strong";

type EditableSelect = {
  value: string;
  options: { value: string; label: string }[];
  onChange: (newValue: string) => void;
};

export function MetricDrawer({
  metricKey,
  segment,
  onClose,
}: {
  metricKey: string | null;
  /** L3 cohort the card was scoped to, so the drill matches the number. */
  segment?: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useMetricDrill(metricKey, segment);
  const updateOpportunity = useUpdateOpportunity();
  const updatePlacementSalary = useUpdatePlacementSalary();
  const updatePlacementStage = useUpdatePlacementStage();
  const updatePlacementTitle = useUpdatePlacementTitle();
  const updateRole = useUpdateRole();
  const queryClient = useQueryClient();

  // Save an edited salary from the FT-salary drill: placed rows write to the
  // placement, committed rows to the role (both stay in sync server-side).
  async function saveSalary(row: Record<string, string | null>, value: number) {
    if (row.kind === "committed" || row.kind === "role") {
      await updateRole.mutateAsync({ roleId: String(row.id), approx_salary: value });
      queryClient.invalidateQueries({ queryKey: ["jobs", "metric"] });
      queryClient.invalidateQueries({ queryKey: ["jobs", "placements"] });
    } else if (row.id != null) {
      await updatePlacementSalary.mutateAsync({ id: String(row.id), salary: value });
    }
  }

  // Save an edited role title from the FT Roles Secured drill: role rows write
  // to the jobs_role, placed rows to the placement (title syncs server-side).
  async function saveTitle(row: Record<string, string | null>, value: string) {
    if (row.kind === "role") {
      await updateRole.mutateAsync({ roleId: String(row.id), title: value });
    } else if (row.id != null) {
      await updatePlacementTitle.mutateAsync({ id: String(row.id), role_title: value });
    }
    queryClient.invalidateQueries({ queryKey: ["jobs", "metric"] });
    queryClient.invalidateQueries({ queryKey: ["jobs", "placements"] });
  }
  const open = metricKey !== null;
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  // Set when a placement's Status is moved to a terminal stage — the end-date
  // dialog owns the write from there.
  const [endingPlacement, setEndingPlacement] = useState<{
    id: string; stage: string; builder: string; role: string;
  } | null>(null);
  useEffect(() => setExpandedRow(null), [metricKey]);

  // Decide whether a given (entity, column) is an editable dropdown.
  // Returns the select config, or null for read-only text.
  function getEditableSelect(
    entity: MetricDrill["entity"],
    colKey: string,
    row: Record<string, string | null>,
  ): EditableSelect | null {
    const id = row.id;
    if (id == null) return null;

    if (entity === "deal" && colKey === "stage") {
      return {
        value: row[colKey] ?? "",
        options: STAGES_ORDERED.map((s) => ({ value: s, label: STAGE_LABELS[s] })),
        onChange: async (newValue) => {
          await updateOpportunity.mutateAsync({ id, stage: newValue as JobStage });
          queryClient.invalidateQueries({ queryKey: ["jobs"] });
        },
      };
    }

    if (entity === "deal" && colKey === "deal_type") {
      return {
        value: row[colKey] ?? "",
        options: (Object.keys(DEAL_TYPE_LABELS) as DealType[]).map((t) => ({
          value: t,
          label: DEAL_TYPE_LABELS[t],
        })),
        onChange: async (newValue) => {
          await updateOpportunity.mutateAsync({ id, deal_type: newValue as DealType });
          queryClient.invalidateQueries({ queryKey: ["jobs"] });
        },
      };
    }


    // Marking a placed builder as having left. Only real placement records are
    // editable — trial and committed-req rows have no employment record behind
    // them. 'pipeline' is left out: it means "not placed yet", which isn't a
    // thing you'd say about a row in this list.
    if (entity === "placement" && colKey === "status" && row.kind === "placed") {
      return {
        value: row.engagement_stage ?? "active",
        options: [
          { value: "active", label: "In role" },
          { value: "completed", label: "Completed" },
          { value: "ended", label: "No longer in role" },
        ],
        onChange: async (newValue) => {
          // Ending needs a date (the API rejects a terminal stage without one),
          // so collect it first rather than firing a write that would 422.
          // Reopening is unambiguous and writes straight through.
          if (newValue === "completed" || newValue === "ended") {
            setEndingPlacement({
              id,
              stage: newValue,
              builder: row.builder ?? "—",
              role: row.role ?? "—",
            });
            return;
          }
          await updatePlacementStage.mutateAsync({ id, engagement_stage: newValue });
          queryClient.invalidateQueries({ queryKey: ["jobs"] });
        },
      };
    }

    return null;
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={data?.title ?? "Details"}
      subtitle={data
        ? data.count >= 500
          ? "500 most recent shown — the metric counts all records"
          : `${data.count} record${data.count === 1 ? "" : "s"}`
        : undefined}
      width={760}
    >
      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-surface-2" />
            ))}
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-ink-3">No records.</div>
        ) : data.child_columns && data.child_columns.length > 0 ? (
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="w-7 px-2 py-2" />
                {data.columns.map((c) => (
                  <th key={c.key} className="px-3 py-2 text-left font-semibold">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => {
                const isExpanded = expandedRow === i;
                const children = row._children ?? [];
                return (
                  <Fragment key={i}>
                    <tr
                      className="cursor-pointer border-t border-border-strong hover:bg-surface-2/50"
                      onClick={() => setExpandedRow((cur) => (cur === i ? null : i))}
                    >
                      <td className="px-2 py-2 text-ink-3">
                        {isExpanded ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </td>
                      {data.columns.map((c, ci) => (
                        <td
                          key={c.key}
                          className={
                            ci === 0
                              ? "px-3 py-2 font-medium text-ink"
                              : "px-3 py-2 text-ink-2"
                          }
                        >
                          {formatCell(c.key, row[c.key])}
                        </td>
                      ))}
                    </tr>
                    {isExpanded ? (
                      <tr className="border-t border-border-strong bg-surface-2/40">
                        <td colSpan={data.columns.length + 1} className="px-3 py-2 pl-10">
                          {children.length === 0 ? (
                            <div className="py-2 text-[11.5px] text-ink-3">
                              No placements.
                            </div>
                          ) : (
                            <table className="w-full text-[11.5px]">
                              <thead className="text-[9.5px] uppercase tracking-wider text-ink-3">
                                <tr>
                                  {(data.child_columns ?? []).map((cc) => (
                                    <th
                                      key={cc.key}
                                      className="px-2 py-1.5 text-left font-semibold"
                                    >
                                      {cc.label}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {children.map((child, ci) => (
                                  <tr
                                    key={ci}
                                    className="border-t border-border-strong/60"
                                  >
                                    {(data.child_columns ?? []).map((cc) => (
                                      <td key={cc.key} className="px-2 py-1.5 text-ink-2">
                                        {formatCell(cc.key, child[cc.key])}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : data.entity === "placement" ? (
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="w-7 px-2 py-2" />
                {data.columns.map((c) => (
                  <th key={c.key} className="px-3 py-2 text-left font-semibold">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => {
                const isExpanded = expandedRow === i;
                return (
                  <Fragment key={i}>
                    <tr
                      className="cursor-pointer border-t border-border-strong hover:bg-surface-2/50"
                      onClick={() => setExpandedRow((cur) => (cur === i ? null : i))}
                    >
                      <td className="px-2 py-2 text-ink-3">
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </td>
                      {data.columns.map((c, ci) => (
                        <td
                          key={c.key}
                          className={ci === 0 ? "px-3 py-2 font-medium text-ink" : "px-3 py-2 text-ink-2"}
                        >
                          {c.key === "salary"
                            ? row.salary
                              ? `$${Number(row.salary).toLocaleString("en-US")}`
                              : "—"
                            : formatCell(c.key, row[c.key])}
                        </td>
                      ))}
                    </tr>
                    {isExpanded ? (
                      <tr className="border-t border-border-strong bg-surface-2/40">
                        <td colSpan={data.columns.length + 1} className="px-4 py-3 pl-9">
                          {row.opportunity_id ? (
                            // The same roles editor used on the Opportunity page /
                            // Accounts tab: edit fields, hire a builder, add roles.
                            <div className="flex flex-col gap-2">
                              <Link
                                to={`/jobs/opportunities/${row.opportunity_id}`}
                                className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-accent hover:underline"
                              >
                                Open opportunity <ExternalLink size={11} />
                              </Link>
                              <OppRolesSection oppId={row.opportunity_id} />
                            </div>
                          ) : (
                            <div className="flex flex-col gap-2">
                              <span className="text-[11.5px] text-ink-3">
                                This placement isn't linked to an opportunity — edit it directly:
                              </span>
                              <div className="flex items-center gap-3">
                                <TextInput value={row.role} onSave={(v) => saveTitle(row, v)} />
                                <SalaryInput value={row.salary} onSave={(v) => saveSalary(row, v)} />
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                {data.columns.map((c) => (
                  <th key={c.key} className="px-3 py-2 text-left font-semibold">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className="border-t border-border-strong hover:bg-surface-2/50">
                  {data.columns.map((c, ci) => {
                    const editable = getEditableSelect(data.entity, c.key, row);
                    const salaryEditable = data.entity === "salary" && c.key === "salary" && row.id != null;
                    return (
                      <td
                        key={c.key}
                        className={ci === 0 ? "px-3 py-2 font-medium text-ink" : "px-3 py-2 text-ink-2"}
                      >
                        {salaryEditable ? (
                          <SalaryInput value={row.salary} onSave={(v) => saveSalary(row, v)} />
                        ) : editable ? (
                          <select
                            className={selectClass}
                            value={editable.value}
                            onChange={(e) => editable.onChange(e.target.value)}
                          >
                            {editable.value === "" && (
                              <option value="" disabled>
                                —
                              </option>
                            )}
                            {editable.options.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          formatCell(c.key, row[c.key])
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {endingPlacement && (
        <PlacementEndDialog
          placementId={endingPlacement.id}
          stage={endingPlacement.stage}
          builder={endingPlacement.builder}
          role={endingPlacement.role}
          onClose={() => setEndingPlacement(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ["jobs"] })}
        />
      )}
    </Drawer>
  );
}

// Inline-editable salary (number) for the FT-salary drill. Saves on Enter/blur
// when the value changed; shows a $-prefixed numeric input.
function SalaryInput({ value, onSave }: { value: string | null; onSave: (v: number) => void }) {
  const initial = value ?? "";
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const commit = async () => {
    const n = parseInt(draft.replace(/[^0-9]/g, ""), 10);
    if (Number.isNaN(n) || String(n) === initial) { setDraft(initial); return; }
    setSaving(true);
    try { await onSave(n); } finally { setSaving(false); }
  };
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="text-ink-3">$</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setDraft(initial); }}
        disabled={saving}
        inputMode="numeric"
        className="w-24 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[12px] tabular-nums outline-none focus:border-accent disabled:opacity-50"
      />
    </span>
  );
}

// Inline-editable text (role title). Saves on Enter/blur when changed;
// Escape resets. Mirrors SalaryInput.
function TextInput({ value, onSave }: { value: string | null; onSave: (v: string) => void }) {
  const initial = value ?? "";
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const commit = async () => {
    const v = draft.trim();
    if (!v || v === initial) { setDraft(initial); return; }
    setSaving(true);
    try { await onSave(v); } finally { setSaving(false); }
  };
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setDraft(initial); }}
      disabled={saving}
      className="w-44 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[12px] outline-none focus:border-accent disabled:opacity-50"
    />
  );
}
