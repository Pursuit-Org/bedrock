import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  useJobsAccounts,
  useStuckContacts,
  useRespondedContacts,
  useUpdateJobsMembership,
  MEMBERSHIP_STAGE_LABELS,
  type MembershipStage,
} from "@/services/jobs";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { useContactStageChange } from "@/lib/useContactStageChange";
import { Panel } from "@/pages/jobs/JobsOpportunitiesOverview";
import { relDay } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * "Requiring attention": replies waiting on a decision, contacts stuck in
 * initial outreach, and accounts awaiting activation, for one owner.
 *
 * Lived at the bottom of the Outreach tab until 2026-09-21, under a "Current
 * state" divider whose whole job was to say the period bar did not apply here.
 * Kwame moved it to Jobs Home, which is the right home: these are three queues
 * belonging to a PERSON, not three measurements of a period, and Jobs Home is
 * already the page you open to see what is on your plate. The divider did not
 * come with it — on Jobs Home nothing is period-scoped, so there is nothing
 * left for it to distinguish from.
 */

// ── Section header ────────────────────────────────────────────────────────────
export function SectionHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-[13px] font-bold uppercase tracking-wider text-ink-3">{title}</h2>
      {note && <span className="text-[12.5px] text-ink-4">{note}</span>}
    </div>
  );
}

function useAwaitingActivation(staffEmails: Set<string>) {
  const { data: accounts = [] } = useJobsAccounts(undefined, "all");
  return useMemo(() => accounts
    .filter((a) => a.owner_email && staffEmails.has(a.owner_email.toLowerCase()) && a.prospect_count === 0)
    .sort((a, b) => (a.owner_email ?? "").localeCompare(b.owner_email ?? "") || a.account.localeCompare(b.account)),
    [accounts, staffEmails]);
}

function HygieneBlock({ nameOf, staffEmails }: { nameOf: (email: string) => string; staffEmails: Set<string> }) {
  const all = useAwaitingActivation(staffEmails);
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState("onfile");
  const [ownerF, setOwnerF] = useState("");
  const owners = useMemo(() => ownerOptions(all, (a) => a.owner_email), [all]);
  // 60+ accounts is too many to scan raw — "which of mine have people I could
  // flag today" is the actual question, so that's the default sort.
  const noProspect = useMemo(() => {
    const rows = ownerF
      ? all.filter((a) => ((a.owner_email ?? "").toLowerCase() || "(unowned)") === ownerF)
      : [...all];
    if (sort === "name") return rows.sort((a, b) => a.account.localeCompare(b.account));
    if (sort === "recent") return rows.sort((a, b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? ""));
    if (sort === "stalest") return rows.sort((a, b) => (a.last_activity_at ?? "").localeCompare(b.last_activity_at ?? ""));
    return rows.sort((a, b) => (b.contact_count ?? 0) - (a.contact_count ?? 0));
  }, [all, sort, ownerF]);

  // Two different problems: contacts exist but nobody's been flagged into the
  // pipeline (just activate one) vs genuinely nobody on file (go find someone).
  const withPeople = useMemo(() => noProspect.filter((a) => (a.contact_count ?? 0) > 0).length, [noProspect]);
  const shown = showAll ? noProspect : noProspect.slice(0, 10);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11.5px] text-ink-3">
          {noProspect.length} owned accounts with nobody in the prospect list — {withPeople} have contacts on file to flag,{" "}
          {noProspect.length - withPeople} have nobody yet
        </p>
        <ListControls sort={sort} setSort={setSort} owner={ownerF} setOwner={setOwnerF}
          owners={owners} nameOf={nameOf}
          sortOpts={[
            { value: "onfile", label: "Most contacts on file" },
            { value: "stalest", label: "Stalest activity" },
            { value: "recent", label: "Most recent activity" },
            { value: "name", label: "Account name" },
          ]} />
      </div>
      {noProspect.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
          <div className="bg-amber-soft px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber">
            Assigned, no contact identified · {noProspect.length}
          </div>
          <table className="w-full text-[12.5px]">
            <thead><tr className="bg-surface-2/60 text-left text-[10.5px] uppercase tracking-wider text-ink-3">
              <th className="px-3 py-1.5 font-semibold">Account</th>
              <th className="px-2 py-1.5 font-semibold">Owner</th>
              <th className="px-2 py-1.5 font-semibold">Status</th>
              <th className="px-2 py-1.5 text-right font-semibold" title="Contacts on file at this company, flagged or not">On file</th>
              <th className="px-2 py-1.5 text-right font-semibold">Last activity</th>
              <th className="px-2 py-1.5"></th>
            </tr></thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.account_key} className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <span className="font-medium text-ink">{a.account}</span>
                    {a.prospect_sibling && (
                      <Link to={`/jobs/accounts?q=${encodeURIComponent(a.prospect_sibling.account)}`}
                        className="block truncate text-[10.5px] text-amber hover:underline"
                        title="Same company filed under another name — the prospects are over there">
                        ⤳ {a.prospect_sibling.prospects} prospects under “{a.prospect_sibling.account}” — likely the same company
                      </Link>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-ink-2">{a.owner_email ? nameOf(a.owner_email) : "—"}</td>
                  <td className="px-2 py-1.5 text-[11.5px] text-ink-3">{a.account_status}</td>
                  <td className={cn("px-2 py-1.5 text-right tabular-nums text-[11.5px]", (a.contact_count ?? 0) > 0 ? "text-ink-2" : "text-ink-4")}>
                    {a.contact_count ?? 0}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-[11.5px] text-ink-4">{relDay(a.last_activity_at) ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Link to={`/jobs/contacts?q=${encodeURIComponent(a.account)}`}
                      className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-semibold hover:underline",
                        (a.contact_count ?? 0) > 0 ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-ink-3")}>
                      {(a.contact_count ?? 0) > 0 ? `Flag one of ${a.contact_count} →` : "Find contacts →"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {noProspect.length > shown.length && (
            <button type="button" onClick={() => setShowAll(true)}
              className="w-full border-t border-border-strong px-3 py-1.5 text-[12px] text-accent hover:bg-surface-2/50">
              Show all {noProspect.length}
            </button>
          )}
        </div>
      )}

    </div>
  );
}

/** Replied but still in initial outreach — the owner decides where each goes.
 *  Deliberately never auto-advances: a positive reply belongs in Converted, a
 *  neutral/negative one in On hold / Not a fit, and only a human can tell. */
function RespondedPanel({ owner, nameOf }: { owner?: string; nameOf: (e: string) => string }) {
  const { data: raw = [], isLoading } = useRespondedContacts(owner);
  const [sort, setSort] = useState("oldest");
  const [ownerF, setOwnerF] = useState("");
  const owners = useMemo(() => ownerOptions(raw, (r) => r.owner_email), [raw]);
  const data = useMemo(() => {
    const rows = ownerF
      ? raw.filter((r) => ((r.owner_email ?? "").toLowerCase() || "(unowned)") === ownerF)
      : [...raw];
    const key = (r: typeof rows[number]) => r.last_reply ?? "";
    if (sort === "recent") return rows.sort((a, b) => key(b).localeCompare(key(a)));
    if (sort === "touches") return rows.sort((a, b) => (b.touches ?? 0) - (a.touches ?? 0));
    return rows.sort((a, b) => key(a).localeCompare(key(b)));  // oldest reply first
  }, [raw, sort, ownerF]);
  const update = useUpdateJobsMembership();
  const stageChange = useContactStageChange();
  const [showAll, setShowAll] = useState(false);
  const move = (c: { contact_id: number; full_name: string | null }, stage: MembershipStage) => {
    // Revisit goes through the shared handler so it asks for a date and files
    // the follow-up task; the other decisions are one-click.
    if (stage === "revisit") {
      // change() now rejects when the dialog is cancelled, and this path
      // has no InlineSelect to roll back — swallow it rather than emit an
      // unhandled rejection every time someone changes their mind.
      stageChange.change(c.contact_id, c.full_name ?? "Contact", stage).catch(() => {});
      return;
    }
    update.mutate({ contact_id: c.contact_id, stage }, {
      onSuccess: () => toast.success(`${c.full_name ?? "Contact"} → ${MEMBERSHIP_STAGE_LABELS[stage]}`),
    });
  };
  const shown = showAll ? data : data.slice(0, 8);
  return (
    <Panel
      action={
        <ListControls sort={sort} setSort={setSort} owner={ownerF} setOwner={setOwnerF}
          owners={owners} nameOf={nameOf}
          sortOpts={[
            { value: "oldest", label: "Longest un-actioned" },
            { value: "recent", label: "Most recent reply" },
            { value: "touches", label: "Most touches" },
          ]} />
      }
      title="Replied — needs a decision"
      badge={data.length ? String(data.length) : undefined}
      desc="They came back to us and are still in initial outreach. Read the reply, then move them — nothing advances on its own.">
      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>
      ) : data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-[12.5px] text-ink-4">
          No replies waiting on a decision.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border-strong">
          {shown.map((c) => (
            <div key={c.contact_id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <Link to={`/jobs/contacts/${c.contact_id}`} className="text-[13px] font-semibold text-ink hover:text-accent">
                    {c.full_name || "—"}
                  </Link>
                  <span className="text-[11.5px] text-ink-3">{c.current_company || "—"}</span>
                  <span className="text-[11px] text-ink-4">
                    replied {relDay(c.last_reply) ?? "—"} ago · {c.touches} touch{c.touches === 1 ? "" : "es"}
                  </span>
                </div>
                {c.snippet && <p className="mt-0.5 line-clamp-2 text-[11.5px] italic text-ink-3">“{c.snippet}”</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => move(c, "converted_to_opportunity")}
                  className="rounded-full border border-[var(--green)]/40 bg-[var(--green-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--green)] hover:brightness-95">
                  Converted
                </button>
                <button type="button" onClick={() => move(c, "revisit")}
                  title="Park with a date — files a task for the owner"
                  className="rounded-full border border-[var(--amber)]/40 bg-[var(--amber-soft)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--amber)] hover:brightness-95">
                  Revisit
                </button>
                <button type="button" onClick={() => move(c, "not_a_fit")}
                  className="rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-ink-3 hover:text-ink-2">
                  Not a fit
                </button>
              </div>
            </div>
          ))}
          {data.length > shown.length && (
            <button type="button" onClick={() => setShowAll(true)}
              className="py-2 text-left text-[12px] text-accent hover:underline">Show all {data.length}</button>
          )}
        </div>
      )}
      {stageChange.dialog}
    </Panel>
  );
}

/** Contacts stuck in initial outreach — 3+ touches, no reply. The cue to find a
 *  different contact at that account (replaced the account working list). */
function StuckContactsPanel({ owner, nameOf }: { owner?: string; nameOf: (e: string) => string }) {
  const { data: raw = [], isLoading } = useStuckContacts(3, owner);
  const [sort, setSort] = useState("touches");
  const [ownerF, setOwnerF] = useState("");
  // One shared handler: it builds the options from what the database accepts
  // (greying out anything the migration hasn't enabled) and routes Revisit
  // through its date dialog.
  const stageChange = useContactStageChange();
  const owners = useMemo(() => ownerOptions(raw, (r) => r.owner_email), [raw]);
  const data = useMemo(() => {
    const rows = ownerF
      ? raw.filter((r) => ((r.owner_email ?? "").toLowerCase() || "(unowned)") === ownerF)
      : [...raw];
    if (sort === "stalest") return rows.sort((a, b) => (a.last_touch ?? "").localeCompare(b.last_touch ?? ""));
    if (sort === "recent") return rows.sort((a, b) => (b.last_touch ?? "").localeCompare(a.last_touch ?? ""));
    return rows.sort((a, b) => (b.touches ?? 0) - (a.touches ?? 0));
  }, [raw, sort, ownerF]);
  // Stage editable in place: the usual next move here is On hold / Not a fit,
  // or Converted if the account came good through another contact.
  const [showAll, setShowAll] = useState(false);
  if (isLoading) return <div className="flex items-center gap-2 px-1 py-4 text-[12.5px] text-ink-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>;
  if (data.length === 0) {
    return <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-[12.5px] text-ink-4">
      Nobody stuck — every contact in initial outreach has replied or is under 3 touches.
    </div>;
  }
  const shown = showAll ? data : data.slice(0, 15);
  return (
    <div className="flex flex-col gap-2">
      <ListControls sort={sort} setSort={setSort} owner={ownerF} setOwner={setOwnerF}
        owners={owners} nameOf={nameOf}
        sortOpts={[
          { value: "touches", label: "Most touches" },
          { value: "stalest", label: "Stalest (oldest touch)" },
          { value: "recent", label: "Most recent touch" },
        ]} />
    <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
      <table className="w-full text-[12.5px]">
        <thead><tr className="bg-surface-2/60 text-left text-[10.5px] uppercase tracking-wider text-ink-3">
          <th className="px-3 py-1.5 font-semibold">Contact</th>
          <th className="px-2 py-1.5 font-semibold">Company</th>
          <th className="px-2 py-1.5 text-right font-semibold">Touches</th>
          <th className="px-2 py-1.5 text-right font-semibold">Last touch</th>
          <th className="px-2 py-1.5 font-semibold">Stage</th>
          <th className="px-2 py-1.5 text-right font-semibold" title="Other jobs prospects already identified at this company">Others at account</th>
        </tr></thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.contact_id} className="border-t border-border-strong">
              <td className="px-3 py-1.5">
                <Link to={`/jobs/contacts/${c.contact_id}`} className="font-medium text-ink hover:text-accent">{c.full_name || "—"}</Link>
                {c.current_title && <span className="block truncate text-[11px] text-ink-4">{c.current_title}</span>}
              </td>
              <td className="px-2 py-1.5 text-ink-2">{c.current_company || "—"}</td>
              <td className={cn("px-2 py-1.5 text-right tabular-nums font-semibold", c.touches >= 5 ? "text-red" : "text-amber")}>{c.touches}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-[11.5px] text-ink-4">{relDay(c.last_touch) ?? "—"}</td>
              <td className="px-2 py-1.5">
                <InlineSelect<string>
                  value="initial_outreach"
                  options={stageChange.options}
                  onSave={(v) => {
                    if (!v || v === "initial_outreach") return Promise.resolve();
                    return stageChange.change(c.contact_id, c.full_name ?? "this contact", v);
                  }}
                  renderValue={() => (
                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3">Initial outreach</span>
                  )}
                />
              </td>
              <td className="px-2 py-1.5 text-right">
                {c.other_contacts_at_account > 0 ? (
                  <Link to={`/jobs/contacts?q=${encodeURIComponent(c.current_company ?? "")}`}
                    className="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent-ink hover:underline">
                    {c.other_contacts_at_account} other{c.other_contacts_at_account === 1 ? "" : "s"} →
                  </Link>
                ) : (
                  <Link to={`/jobs/accounts?q=${encodeURIComponent(c.current_company ?? "")}`}
                    className="text-[10.5px] font-semibold text-amber hover:underline">find a contact →</Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.length > shown.length && (
        <button type="button" onClick={() => setShowAll(true)}
          className="w-full border-t border-border-strong px-3 py-1.5 text-[12px] text-accent hover:bg-surface-2/50">
          Show all {data.length}
        </button>
      )}
    </div>
    {stageChange.dialog}
    </div>
  );
}

// ── Requiring attention ─────────────────────────────────────────────────────
// One place for the three queues that need a human: replies awaiting a
// decision, contacts stuck in outreach, accounts with nobody flagged. Each card
// is the headline; clicking it opens the same detail table that used to sit in
// its own full-width section.

type AttentionKey = "replied" | "stuck" | "activation";

/** Sort + owner filter strip shared by the three Requiring Attention details —
 *  each list is long enough that scanning it unsorted is the actual work. */
function ListControls({ sort, setSort, sortOpts, owner, setOwner, owners, nameOf }: {
  sort: string;
  setSort: (v: string) => void;
  sortOpts: { value: string; label: string }[];
  owner: string;
  setOwner: (v: string) => void;
  owners: string[];
  nameOf: (email: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Sort</span>
      <select value={sort} onChange={(e) => setSort(e.target.value)}
        className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
        {sortOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="ml-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Owner</span>
      <select value={owner} onChange={(e) => setOwner(e.target.value)}
        className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
        <option value="">All owners</option>
        {owners.map((o) => <option key={o} value={o}>{o === "(unowned)" ? "Unowned" : nameOf(o)}</option>)}
      </select>
    </div>
  );
}

/** Distinct owner keys present in a list, for its filter dropdown. */
function ownerOptions<T>(rows: T[], pick: (r: T) => string | null | undefined): string[] {
  const set = new Set<string>();
  for (const r of rows) set.add((pick(r) ?? "").toLowerCase() || "(unowned)");
  return [...set].sort();
}

const DAY_MS = 86_400_000;

function AttentionCard({ label, value, sub, tone, active, onClick }: {
  label: string;
  value: number | undefined;
  sub: React.ReactNode;
  tone: "ink" | "red" | "amber" | "accent";
  active: boolean;
  onClick: () => void;
}) {
  const toneCls = {
    ink: "text-ink",
    red: "text-red",
    amber: "text-amber",
    accent: "text-accent",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className={cn(
        "flex flex-col items-start gap-1 rounded-xl border bg-surface px-4 py-3 text-left transition-colors",
        active
          ? "border-accent ring-1 ring-accent/30"
          : "border-border-strong hover:bg-surface-2/50",
      )}
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>
      <span className={cn("text-[26px] font-semibold leading-none tabular-nums", toneCls)}>
        {value ?? "—"}
      </span>
      <span className="text-[11px] leading-snug text-ink-3">{sub}</span>
      <span className="mt-0.5 inline-flex items-center gap-0.5 text-[10.5px] font-semibold text-accent">
        {active ? "Hide detail" : "See detail"}
        {active ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </span>
    </button>
  );
}

export function RequiringAttention({ owner, nameOf, staffEmails }: {
  owner?: string;
  nameOf: (email: string) => string;
  staffEmails: Set<string>;
}) {
  const [open, setOpen] = useState<AttentionKey | null>(null);
  const { data: replied = [] } = useRespondedContacts(owner);
  const { data: stuck = [] } = useStuckContacts(3, owner);
  const awaiting = useAwaitingActivation(staffEmails);

  // Trend on replies: last 7 days vs the 7 before, off each row's last_reply.
  // There's no prior-period endpoint, so this is derived from the same payload
  // rather than being a second fetch that could disagree with the count.
  const replyTrend = useMemo(() => {
    const now = Date.now();
    let recent = 0;
    let prior = 0;
    for (const r of replied) {
      if (!r.last_reply) continue;
      const age = now - new Date(r.last_reply).getTime();
      if (age < 7 * DAY_MS) recent += 1;
      else if (age < 14 * DAY_MS) prior += 1;
    }
    return { recent, prior };
  }, [replied]);

  const stuckStats = useMemo(() => {
    if (stuck.length === 0) return null;
    const touches = stuck.reduce((n, s) => n + (s.touches ?? 0), 0) / stuck.length;
    const withTouch = stuck.filter((s) => s.last_touch);
    const days = withTouch.length
      ? withTouch.reduce((n, s) => n + (Date.now() - new Date(s.last_touch as string).getTime()), 0)
        / withTouch.length / DAY_MS
      : null;
    return { touches, days };
  }, [stuck]);

  const withPeople = awaiting.filter((a) => (a.contact_count ?? 0) > 0).length;

  return (
    <div className="flex flex-col gap-3">
      <SectionHead title="Requiring attention" />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <AttentionCard
          label="Replies needing a decision"
          value={replied.length}
          // Black, not red: a reply is a good outcome waiting on a decision, not
          // a failure. The 7-day trend below still colours when it's climbing.
          tone="ink"
          active={open === "replied"}
          onClick={() => setOpen(open === "replied" ? null : "replied")}
          sub={
            <>
              {replyTrend.recent} in the last 7d
              {replyTrend.prior > 0 ? (
                <>
                  {" · "}
                  <span className={replyTrend.recent >= replyTrend.prior ? "text-red" : "text-[var(--green)]"}>
                    {replyTrend.recent >= replyTrend.prior ? "▲" : "▼"}{" "}
                    {Math.abs(replyTrend.recent - replyTrend.prior)}
                  </span>{" "}
                  vs prior 7d
                </>
              ) : null}
            </>
          }
        />
        <AttentionCard
          label="Stuck in initial outreach"
          value={stuck.length}
          tone="amber"
          active={open === "stuck"}
          onClick={() => setOpen(open === "stuck" ? null : "stuck")}
          sub={
            stuckStats
              ? `avg ${stuckStats.touches.toFixed(1)} touches${
                  stuckStats.days != null ? ` · last touch ${Math.round(stuckStats.days)}d ago` : ""
                }`
              : "nobody stuck — 3+ touches, no reply"
          }
        />
        <AttentionCard
          label="Accounts awaiting activation"
          value={awaiting.length}
          tone="accent"
          active={open === "activation"}
          onClick={() => setOpen(open === "activation" ? null : "activation")}
          sub={`${withPeople} have contacts on file to flag`}
        />
      </div>

      {open === "replied" ? <RespondedPanel owner={owner} nameOf={nameOf} /> : null}
      {open === "stuck" ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11.5px] text-ink-3">
            3+ touches, no reply — time to work a different contact at the account
          </p>
          <StuckContactsPanel owner={owner} nameOf={nameOf} />
        </div>
      ) : null}
      {open === "activation" ? <HygieneBlock nameOf={nameOf} staffEmails={staffEmails} /> : null}
    </div>
  );
}
