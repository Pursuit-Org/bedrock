import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, ChevronDown, ExternalLink } from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import {
  useMetricDrill,
  STAGE_LABELS,
  DEAL_TYPE_LABELS,
  type JobStage,
  type DealType,
} from "@/services/jobs";

// Pretty-print known coded values; pass everything else through.
function formatCell(colKey: string, value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  const v = String(value);
  if (colKey === "stage" && v in STAGE_LABELS) {
    return STAGE_LABELS[v as JobStage];
  }
  if (colKey === "deal_type" && v in DEAL_TYPE_LABELS) {
    return DEAL_TYPE_LABELS[v as DealType];
  }
  // Format any date/datetime column (named *_date / *_touch / when, or an
  // ISO-shaped value) to a readable "Jun 10, 2026" — never show raw ISO.
  const looksDateCol = /(_date|_touch|^when$|^date$)/.test(colKey);
  const looksIso = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v);
  if (looksDateCol || looksIso) {
    // A bare YYYY-MM-DD is a calendar day: read it as local, not UTC midnight.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }
  if (colKey === "type") return v.charAt(0).toUpperCase() + v.slice(1);
  return v;
}

/** The records behind a leadership-dashboard number. Read-only: the outcome
 *  drills list one row per builder the card counted (PRO-99), expandable to
 *  their roles. Pay, titles and stages are edited on the builder
 *  (Placement › Builders) or through the role on the opportunity. */
export function MetricDrawer({
  metricKey,
  segment,
  jobType,
  part,
  onClose,
}: {
  metricKey: string | null;
  /** L3 cohort the card was scoped to, so the drill matches the number. */
  segment?: string;
  /** The job type the card was scoped to (D4). */
  jobType?: string;
  /** One line of the Placed card (PRO-105). */
  part?: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useMetricDrill(metricKey, segment, jobType, part);
  const open = metricKey !== null;
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  useEffect(() => setExpandedRow(null), [metricKey]);

  const noun = data?.entity === "builder" ? "builder" : data?.entity === "role" ? "role" : "record";
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={data?.title ?? "Details"}
      subtitle={data
        ? data.count > data.rows.length
          ? `Showing the ${data.rows.length.toLocaleString()} most recent of ${data.count.toLocaleString()} records`
          : `${data.count.toLocaleString()} ${noun}${data.count === 1 ? "" : "s"}`
        : undefined}
      width={820}
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
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </td>
                      {data.columns.map((c, ci) => (
                        <td
                          key={c.key}
                          className={ci === 0 ? "px-3 py-2 font-medium text-ink" : "px-3 py-2 text-ink-2"}
                        >
                          {formatCell(c.key, row[c.key])}
                        </td>
                      ))}
                    </tr>
                    {isExpanded ? (
                      <tr className="border-t border-border-strong bg-surface-2/40">
                        <td colSpan={data.columns.length + 1} className="px-3 py-2 pl-10">
                          {children.length === 0 ? (
                            <div className="py-2 text-[11.5px] text-ink-3">No roles.</div>
                          ) : (
                            <table className="w-full text-[11.5px]">
                              <thead className="text-[9.5px] uppercase tracking-wider text-ink-3">
                                <tr>
                                  {(data.child_columns ?? []).map((cc) => (
                                    <th key={cc.key} className="px-2 py-1.5 text-left font-semibold">
                                      {cc.label}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {children.map((child, ci) => (
                                  <tr key={ci} className="border-t border-border-strong/60">
                                    {(data.child_columns ?? []).map((cc) => (
                                      <td key={cc.key} className="px-2 py-1.5 text-ink-2">
                                        {cc.key === "company" && child.opportunity_id ? (
                                          <Link
                                            to={`/jobs/opportunities/${child.opportunity_id}`}
                                            className="inline-flex items-center gap-1 text-accent hover:underline"
                                          >
                                            {formatCell(cc.key, child[cc.key])} <ExternalLink size={10} />
                                          </Link>
                                        ) : (
                                          formatCell(cc.key, child[cc.key])
                                        )}
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
                  {data.columns.map((c, ci) => (
                    <td
                      key={c.key}
                      className={ci === 0 ? "px-3 py-2 font-medium text-ink" : "px-3 py-2 text-ink-2"}
                    >
                      {formatCell(c.key, row[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Drawer>
  );
}
