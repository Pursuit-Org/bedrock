/**
 * The list behind a number.
 *
 * Every headline on the Outreach and Campaign views can be opened to show what
 * it counts: who, at which account, who owns them and who did the thing. Five
 * rows by default — enough to recognise the shape of the number without the
 * card turning into a table — and the rest behind one click.
 *
 * Owner and Editor are always both shown. They routinely differ (Avni moving a
 * contact Kwame owns), and that difference is the point of opening the list.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";

import { useStaffNameResolver } from "@/services/jobs";
import { cn } from "@/lib/utils";

export interface DrillRow {
  at: string | null;
  /** Contact name, or the account name when the number counts accounts. */
  name: string | null;
  account: string | null;
  owner: string | null;
  editor: string | null;
  /** Email subject, stage move, or whatever else identifies this row. */
  detail: string | null;
  subkind?: string | null;
  contact_id?: number | null;
}

const DRILL_PAGE = 5;

export function DrillList({ rows, emptyLabel = "Nothing in this period.", className }: {
  rows: DrillRow[];
  emptyLabel?: string;
  className?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const nameOf = useStaffNameResolver();

  if (rows.length === 0) {
    return (
      <div className={cn("rounded-lg border border-dashed border-border-strong px-4 py-5 text-center text-[12px] text-ink-4", className)}>
        {emptyLabel}
      </div>
    );
  }
  const shown = showAll ? rows : rows.slice(0, DRILL_PAGE);
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center gap-3 border-b border-border-strong pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">
        <span className="w-[168px] shrink-0">Name</span>
        <span className="w-[140px] shrink-0">Account</span>
        <span className="min-w-0 flex-1">Detail</span>
        <span className="w-[88px] shrink-0">Owner</span>
        <span className="w-[88px] shrink-0">Editor</span>
        <span className="w-[52px] shrink-0 text-right">When</span>
      </div>
      {shown.map((r, i) => (
        <div key={`${r.name}-${r.at}-${i}`} className="flex items-center gap-3 border-b border-border-strong py-1.5 last:border-b-0">
          <span className="w-[168px] shrink-0 truncate text-[12.5px] font-medium text-ink" title={r.name ?? undefined}>
            {r.contact_id ? (
              <Link to={`/jobs/contacts/${r.contact_id}`} className="hover:text-accent">{r.name ?? "—"}</Link>
            ) : (r.name ?? "—")}
          </span>
          <span className="w-[140px] shrink-0 truncate text-[12px] text-ink-3" title={r.account ?? undefined}>
            {r.account ?? "—"}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3" title={r.detail ?? undefined}>
            {r.detail ?? "—"}
          </span>
          <span className="w-[88px] shrink-0 truncate text-[11px] text-ink-4" title={r.owner ?? "Nobody assigned"}>
            {r.owner ? nameOf(r.owner) : "—"}
          </span>
          <span className="w-[88px] shrink-0 truncate text-[11px] text-ink-4" title={r.editor ?? undefined}>
            {r.editor ? nameOf(r.editor) : "—"}
          </span>
          <span className="w-[52px] shrink-0 text-right text-[11px] text-ink-4">
            {r.at ? format(new Date(r.at), "MMM d") : "—"}
          </span>
        </div>
      ))}
      {rows.length > DRILL_PAGE ? (
        <button type="button" onClick={() => setShowAll((v) => !v)}
          className="mt-2 self-start text-[12px] font-medium text-accent hover:underline">
          {showAll ? "Show less" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}
