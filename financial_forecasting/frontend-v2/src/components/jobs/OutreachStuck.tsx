import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";

import {
  useOutreachStuck,
  MEMBERSHIP_STAGE_LABELS,
  type OutreachScopeKind,
  type StuckContact,
  type StuckReasonKind,
  type StuckRow,
} from "@/services/jobs";
import { Panel } from "@/pages/jobs/JobsOpportunitiesOverview";
import { MetricInfo } from "@/components/jobs/MetricInfo";
import { ListWhy } from "@/components/jobs/ListWhy";
import { jobsAccountPath } from "@/components/jobs/jobsPaths";
import { share, stuckReasonText, waitingLabel } from "@/components/jobs/outreachText";
import { relDay } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Contacts listed before "Show all". */
const LIST_PAGE = 15;

/** Reasons in the order they are read off (first match wins), each its own colour. */
const REASON_TONE: Record<StuckReasonKind, string> = {
  intro: "bg-accent-soft text-accent",
  revisit: "bg-surface-2 text-ink-2",
  not_a_fit: "bg-surface-2 text-ink-3",
  none: "bg-red-soft text-red",
};

/**
 * Where outreach is stuck (PRO-106, Kwame 10/2): per owner, of the contacts
 * assigned, how many were reached out to and how many got to a booked call,
 * and why the rest weren't reached. Every number opens the contacts behind it.
 *
 * Every week of the campaign, read now, so the period above doesn't apply and
 * the panel says so. Scope and Sender do: they pick whose contacts.
 */
export function OutreachStuck({ scope, owner, nameOf }: {
  scope: OutreachScopeKind;
  owner?: string;
  nameOf: (email: string) => string;
}) {
  // undefined = the current campaign (D10); "all" = every Jobs contact.
  const [campaign, setCampaign] = useState<string | undefined>(undefined);
  const { data, isLoading, isError } = useOutreachStuck(campaign, scope, owner);
  // Which list is open: one owner (or everyone) and a step of the funnel.
  const [open, setOpen] = useState<{ owner: string | null | "*"; which: StuckReasonKind | "not_reached" } | null>(null);

  const campaignLabel = data
    ? data.campaign === "all" ? "Every Jobs contact"
      : `${data.campaigns.find((c) => c.key === data.campaign)?.label ?? data.campaign}`
        + (data.campaigns.find((c) => c.key === data.campaign)?.current ? " (current)" : "")
    : "";
  const ownerName = (o: string | null) => (o ? nameOf(o) : "Unowned");

  const listed = useMemo(() => {
    if (!data || !open) return [];
    return data.contacts.filter((c) => c.reason
      && (open.owner === "*" || c.owner === open.owner)
      && (open.which === "not_reached" || c.reason.kind === open.which));
  }, [data, open]);

  const toggle = (o: string | null | "*", which: StuckReasonKind | "not_reached") =>
    setOpen(open && open.owner === o && open.which === which ? null : { owner: o, which });

  const picker = data ? (
    <select value={campaign ?? data.campaign} onChange={(e) => { setCampaign(e.target.value); setOpen(null); }}
      className="h-7 max-w-[220px] rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
      title="Which contacts: one campaign's, or every Jobs contact">
      <optgroup label="Current">
        {data.campaigns.filter((c) => c.current).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
      </optgroup>
      {data.campaigns.some((c) => !c.current) && (
        <optgroup label="Past campaigns">
          {data.campaigns.filter((c) => !c.current).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </optgroup>
      )}
      <option value="all">Every Jobs contact</option>
    </select>
  ) : null;

  return (
    <Panel
      title="Where outreach is stuck"
      desc={data ? `${campaignLabel} · every week of the campaign, so the period above doesn't apply` : undefined}
      info={<MetricInfo definition={data?.definitions.assigned} />}
      action={picker}
    >
      {isLoading && (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-ink-3">
          <Loader2 size={13} className="animate-spin" /> Loading…
        </div>
      )}
      {isError && <div className="text-[12.5px] text-red">Couldn't load where outreach is stuck.</div>}
      {data && (
        <>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border-strong text-[10.5px] uppercase tracking-wider text-ink-3">
                <th className="py-1.5 pr-2 text-left font-semibold">Owner</th>
                <th className="px-2 py-1.5 text-right font-semibold">
                  Assigned<MetricInfo definition={data.definitions.assigned} className="ml-0.5 align-middle" />
                </th>
                <th className="px-2 py-1.5 text-right font-semibold">
                  Reached out<MetricInfo definition={data.definitions.reached} className="ml-0.5 align-middle" />
                </th>
                <th className="px-2 py-1.5 text-right font-semibold">
                  Call booked<MetricInfo definition={data.definitions.call_booked} className="ml-0.5 align-middle" />
                </th>
                <th className="px-2 py-1.5 text-left font-semibold">
                  Not reached yet, and why <ListWhy listKey="outreach_stuck" className="align-middle" />
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length > 1 && (
                <StuckLine label="Everyone shown" row={{ owner: null, on_team: false, ...data.totals }}
                  reasons={data.reasons} strong open={open?.owner === "*" ? open.which : null}
                  onOpen={(w) => toggle("*", w)} />
              )}
              {data.rows.map((r) => (
                <StuckLine key={r.owner ?? "(unowned)"} label={ownerName(r.owner)} row={r} reasons={data.reasons}
                  open={open && open.owner === r.owner ? open.which : null}
                  onOpen={(w) => toggle(r.owner, w)} />
              ))}
              {data.rows.length === 0 && (
                <tr><td colSpan={5} className="py-5 text-center text-[12.5px] text-ink-4">
                  No contacts in this campaign for the owners picked.
                </td></tr>
              )}
            </tbody>
          </table>
          {open && (
            <StuckList
              title={`${open.owner === "*" ? "Everyone shown" : ownerName(open.owner)} · ${
                open.which === "not_reached" ? "not reached yet"
                  : data.reasons.find((x) => x.key === open.which)?.label.toLowerCase()}`}
              contacts={listed} nameOf={nameOf} />
          )}
          {data.totals.reasons.none > 0 && (
            <p className="mt-3 text-[11px] text-ink-4">
              Nothing records why a contact is waiting yet (D6 is open), so only a pending intro request,
              Revisit or Not a fit can say why. The other {data.totals.reasons.none} read "No reason recorded".
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function StuckLine({ label, row, reasons, strong, open, onOpen }: {
  label: string;
  row: StuckRow;
  reasons: { key: StuckReasonKind; label: string }[];
  strong?: boolean;
  open: StuckReasonKind | "not_reached" | null;
  onOpen: (which: StuckReasonKind | "not_reached") => void;
}) {
  const pct = (n: number) => {
    const p = share(n, row.assigned);
    return p == null ? "" : `${p}%`;
  };
  return (
    <tr className={cn("border-b border-border align-top", strong && "bg-surface-2/60 font-semibold")}>
      <td className={cn("py-2 pr-2", strong ? "text-[11px] uppercase tracking-wider text-ink-3" : "font-medium text-ink")}>
        {label}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{row.assigned}</td>
      <td className="px-2 py-2 text-right tabular-nums">
        {row.reached} <span className="text-[11px] font-normal text-ink-4">{pct(row.reached)}</span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {row.call_booked} <span className="text-[11px] font-normal text-ink-4">{pct(row.call_booked)}</span>
      </td>
      <td className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" disabled={!row.not_reached} onClick={() => onOpen("not_reached")}
            title="List every contact not reached yet"
            className={cn("rounded px-1.5 py-0.5 font-semibold tabular-nums",
              open === "not_reached" ? "bg-accent-soft text-accent"
                : row.not_reached ? "text-ink hover:bg-surface-2" : "text-ink-4")}>
            {row.not_reached}
          </button>
          {reasons.filter((x) => row.reasons[x.key] > 0).map((x) => (
            <button key={x.key} type="button" onClick={() => onOpen(x.key)}
              className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", REASON_TONE[x.key],
                open === x.key && "ring-1 ring-accent")}>
              {x.label} {row.reasons[x.key]}
            </button>
          ))}
        </div>
      </td>
    </tr>
  );
}

function StuckList({ title, contacts, nameOf }: {
  title: string;
  contacts: StuckContact[];
  nameOf: (email: string) => string;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? contacts : contacts.slice(0, LIST_PAGE);
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border-strong">
      <div className="flex items-center justify-between border-b border-border-strong bg-surface-2 px-3 py-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{title}</span>
        <span className="text-[11px] tabular-nums text-ink-4">{contacts.length} · waiting longest first</span>
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10.5px] uppercase tracking-wider text-ink-3">
            <th className="px-3 py-1.5 font-semibold">Contact</th>
            <th className="px-2 py-1.5 font-semibold">Account</th>
            <th className="px-2 py-1.5 font-semibold">Owner</th>
            <th className="px-2 py-1.5 font-semibold">Stage</th>
            <th className="px-2 py-1.5 font-semibold" title="Since the contact was assigned to the Jobs pipeline">Waiting</th>
            <th className="px-2 py-1.5 font-semibold">Why</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.contact_id} className="border-t border-border-strong">
              <td className="px-3 py-1.5">
                <Link to={`/jobs/contacts/${c.contact_id}`} className="font-medium text-ink hover:text-accent hover:underline">
                  {c.name ?? "—"}
                </Link>
              </td>
              <td className="max-w-[160px] truncate px-2 py-1.5" title={c.company ?? undefined}>
                {c.account_key ? (
                  <Link to={jobsAccountPath(c.account_key)} className="text-ink-2 hover:text-accent hover:underline">
                    {c.company}
                  </Link>
                ) : <span className="text-ink-4">—</span>}
              </td>
              <td className="px-2 py-1.5 text-ink-3">{c.owner ? nameOf(c.owner) : "Unowned"}</td>
              <td className="px-2 py-1.5 text-ink-3">{c.stage ? MEMBERSHIP_STAGE_LABELS[c.stage] ?? c.stage : "—"}</td>
              <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-ink-3"
                title={c.assigned_at ? `Assigned ${relDay(c.assigned_at) ?? ""}` : "No assigned date"}>
                {waitingLabel(c.days_waiting)}
              </td>
              <td className="px-2 py-1.5">
                {c.reason ? (
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px]", REASON_TONE[c.reason.kind])}>
                    {stuckReasonText(c.reason)}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
          {contacts.length === 0 && (
            <tr><td colSpan={6} className="px-3 py-4 text-center text-ink-4">Nobody here.</td></tr>
          )}
        </tbody>
      </table>
      {contacts.length > LIST_PAGE && (
        <button type="button" onClick={() => setShowAll((v) => !v)}
          className="w-full border-t border-border-strong px-3 py-1.5 text-[11.5px] font-medium text-accent hover:bg-surface-2">
          {showAll ? "Show less" : `Show all ${contacts.length}`}
        </button>
      )}
    </div>
  );
}
