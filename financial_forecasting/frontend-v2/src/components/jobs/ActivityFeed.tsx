/**
 * The activity feed shared by Campaigns and Outreach → Outbound Detail.
 *
 * Bulk work arrives as many identical rows — one staffer marking eight Red
 * Canary contacts Not a fit in a sitting — so rows collapse on
 * (day, kind, stage, editor, owner) and expand to name every contact behind
 * them. Owner is the contact's assignment; Editor is who actually did the
 * thing. They routinely differ, which is the whole point of showing both.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import {
  ArrowRight, Calendar, ChevronDown, ChevronRight, Linkedin, Loader2, Mail,
  MessageSquare, Plus, StickyNote,
} from "lucide-react";

import {
  useStaffNameResolver, MEMBERSHIP_STAGE_LABELS,
  type CampaignEvent, type CampaignEventCategory, type MembershipStage,
} from "@/services/jobs";
import { cn } from "@/lib/utils";

/** Card chrome, duplicated from JobsCampaigns rather than imported, so this
 *  component has no dependency back on the page that first used it. */
function Section({ title, note, action, children }: {
  title: string; note?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border-strong bg-surface px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
          {note ? <p className="mt-0.5 text-[11.5px] text-ink-3">{note}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const ACTIVITY_PAGE = 10;

const TOUCH_META: Record<string, { label: string; icon: React.ReactNode }> = {
  email: { label: "Email", icon: <Mail size={11} /> },
  meeting: { label: "Call booked", icon: <Calendar size={11} /> },
  call: { label: "Call booked", icon: <Calendar size={11} /> },
  text: { label: "Text", icon: <MessageSquare size={11} /> },
  linkedin: { label: "LinkedIn", icon: <Linkedin size={11} /> },
  note: { label: "Note", icon: <StickyNote size={11} /> },
};

const SEGMENTS: { key: "all" | CampaignEventCategory; label: string; title: string }[] = [
  { key: "all", label: "All activity", title: "Everything below, newest first" },
  { key: "outreach", label: "Outreach", title: "Emails, calls booked, texts, LinkedIn and notes" },
  { key: "funnel", label: "Funnel", title: "Stage changes and contacts added to the pipeline" },
];

/** Bulk work arrives as many identical rows — one staffer marking eight Red
 *  Canary contacts Not a fit in a sitting. Collapsing them on
 *  (day, kind, stage, editor, owner) turns a wall into one legible line, and
 *  the owner stays in the key so a collapsed row never shows two owners. */
interface EventGroup {
  key: string;
  at: string | null;
  kind: CampaignEvent["kind"];
  subkind: string | null;
  from_stage: MembershipStage | null;
  to_stage: MembershipStage | null;
  editor: string | null;
  owner: string | null;
  owner_source: CampaignEvent["owner_source"];
  events: CampaignEvent[];
}

function groupEvents(events: CampaignEvent[]): EventGroup[] {
  const out: EventGroup[] = [];
  const index = new Map<string, EventGroup>();
  for (const e of events) {
    const day = e.at ? e.at.slice(0, 10) : "";
    const key = [day, e.kind, e.subkind ?? "", e.from_stage ?? "", e.to_stage ?? "",
      e.editor ?? "", e.owner ?? ""].join("|");
    const existing = index.get(key);
    if (existing) { existing.events.push(e); continue; }
    const g: EventGroup = {
      key, at: e.at, kind: e.kind, subkind: e.subkind,
      from_stage: e.from_stage, to_stage: e.to_stage,
      editor: e.editor, owner: e.owner, owner_source: e.owner_source, events: [e],
    };
    index.set(key, g);
    out.push(g);
  }
  return out;
}

const stageLabel = (s: MembershipStage | null) => (s ? MEMBERSHIP_STAGE_LABELS[s] ?? s : null);

function groupBadge(g: EventGroup): { label: string; icon: React.ReactNode; color: string } {
  if (g.kind === "added") return { label: "Added", icon: <Plus size={11} />, color: "var(--accent)" };
  if (g.kind === "stage") {
    return {
      label: stageLabel(g.to_stage) ?? "Moved",
      icon: <ArrowRight size={11} />,
      color: g.to_stage === "converted_to_opportunity" ? "var(--green)"
        : g.to_stage === "not_a_fit" ? "var(--ink-3)"
        : g.to_stage === "revisit" ? "var(--amber)" : "var(--sky)",
    };
  }
  const m = TOUCH_META[g.subkind ?? ""] ?? { label: "Touch", icon: <Mail size={11} /> };
  return { ...m, color: "var(--accent)" };
}

/** The line that says what happened, in the team's own words. A stage move
 *  names both ends — "Assigned → Initial outreach" — because the destination
 *  alone loses whether the contact moved forward or backward. */
function groupDetail(g: EventGroup): string {
  if (g.kind === "stage") {
    const from = stageLabel(g.from_stage);
    const to = stageLabel(g.to_stage) ?? "—";
    return from ? `${from} → ${to}` : `Set to ${to}`;
  }
  if (g.kind === "added") return "Added to the pipeline";
  return g.events[0]?.subject ?? "";
}

function OwnerFilter({ owners, value, onChange, nameOf }: {
  owners: { email: string; contacts: number }[];
  value: string | null;
  onChange: (v: string | null) => void;
  nameOf: (e: string | null | undefined) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
          value ? "border-accent text-accent" : "border-border-strong text-ink-2 hover:bg-surface-2",
        )}
      >
        Owner: {value ? nameOf(value) : "All"}
        <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-30 mt-1 max-h-[300px] w-[260px] overflow-y-auto rounded-lg border border-border-strong bg-surface p-1 shadow-lg">
            <button
              type="button"
              onClick={() => { onChange(null); setOpen(false); }}
              className={cn("flex w-full items-center rounded px-2 py-1.5 text-[12.5px] hover:bg-surface-2",
                value === null ? "font-semibold text-accent" : "text-ink")}
            >
              All owners
            </button>
            {owners.map((o) => (
              <button
                key={o.email}
                type="button"
                onClick={() => { onChange(o.email); setOpen(false); }}
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-surface-2",
                  value === o.email ? "font-semibold text-accent" : "text-ink")}
              >
                <span className="min-w-0 flex-1 truncate" title={o.email}>{nameOf(o.email)}</span>
                <span className="shrink-0 tabular-nums text-[11px] text-ink-4">{o.contacts}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Expanded detail: every contact behind the row, named explicitly, with the
 *  email subject and preview where there is one. This is the answer to "it says
 *  2 contacts — who at Vertech did we actually reach?". */
function GroupDetail({ g }: { g: EventGroup }) {
  return (
    <div className="border-b border-border-strong bg-surface-2/40 px-3 py-2">
      <div className="flex flex-col gap-1.5">
        {g.events.map((e, i) => (
          <div key={`${e.contact_id}-${i}`} className="flex items-start gap-3">
            <Link
              to={`/jobs/contacts/${e.contact_id}`}
              className="w-[180px] shrink-0 truncate text-[12.5px] font-medium text-ink hover:text-accent"
            >
              {e.contact_name ?? "—"}
            </Link>
            <span className="w-[160px] shrink-0 truncate text-[12px] text-ink-3" title={e.account ?? undefined}>
              {e.account ?? "—"}
            </span>
            <div className="min-w-0 flex-1">
              {e.subject ? (
                <div className="truncate text-[12px] text-ink-2" title={e.subject}>{e.subject}</div>
              ) : null}
              {e.snippet ? (
                <div className="line-clamp-2 text-[11.5px] leading-snug text-ink-4">{e.snippet}</div>
              ) : null}
              {!e.subject && !e.snippet && e.kind === "stage" ? (
                <div className="text-[11.5px] text-ink-4">{groupDetail({ ...g, events: [e] })}</div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ActivityFeed({
  events, owners, isLoading, title, note, showSegments = true, owner, onOwner,
}: {
  events: CampaignEvent[];
  owners: { email: string; contacts: number }[];
  isLoading: boolean;
  title?: string;
  note?: string;
  /** Campaigns mixes touches with stage changes, so it needs the All / Outreach
   *  / Funnel split. A sends-only feed has nothing to segment. */
  showSegments?: boolean;
  /** Omit both to hide the owner control — Outbound Detail scopes the feed with
   *  the page's own sender filter instead. */
  owner?: string | null;
  onOwner?: (v: string | null) => void;
}) {
  const [segment, setSegment] = useState<"all" | CampaignEventCategory>("all");
  const [showAll, setShowAll] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const nameOf = useStaffNameResolver();

  const groups = useMemo(() => {
    const rows = showSegments
      ? events.filter((e) => segment === "all" || e.category === segment)
      : events;
    return groupEvents(rows);
  }, [events, segment, showSegments]);
  const shown = showAll ? groups : groups.slice(0, ACTIVITY_PAGE);

  return (
    <Section
      title={title ?? "Activity"}
      note={note ?? "Owner is who the contact or their account is assigned to in Bedrock. Editor is who made the change. Click a row for the contacts behind it."}
      action={
        <div className="flex flex-wrap items-center gap-2">
          {showSegments && (
          <div className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface-2 p-1">
            {SEGMENTS.map((sgm) => (
              <button
                key={sgm.key}
                type="button"
                title={sgm.title}
                onClick={() => { setSegment(sgm.key); setShowAll(false); }}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                  segment === sgm.key ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
                )}
              >
                {sgm.label}
              </button>
            ))}
          </div>
          )}
          {onOwner ? (
            <OwnerFilter owners={owners} value={owner ?? null} onChange={onOwner} nameOf={nameOf} />
          ) : null}
        </div>
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-ink-3">
          <Loader2 size={14} className="animate-spin" /> Loading activity…
        </div>
      ) : groups.length === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border-strong px-4 py-8 text-[12px] text-ink-4">
          No activity in this period.
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="flex items-center gap-3 border-b border-border-strong px-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">
            <span className="w-[14px] shrink-0" />
            <span className="w-[92px] shrink-0">Event</span>
            <span className="w-[170px] shrink-0">Contact</span>
            <span className="w-[150px] shrink-0">Account</span>
            <span className="min-w-0 flex-1">Detail</span>
            <span className="w-[92px] shrink-0">Owner</span>
            <span className="w-[92px] shrink-0">Editor</span>
            <span className="w-[52px] shrink-0 text-right">When</span>
          </div>
          {shown.map((g) => {
            const badge = groupBadge(g);
            const n = g.events.length;
            const first = g.events[0];
            const accounts = Array.from(new Set(g.events.map((e) => e.account).filter(Boolean)));
            const open = openKey === g.key;
            return (
              <div key={g.key} className="border-b border-border-strong last:border-b-0">
                <button
                  type="button"
                  onClick={() => setOpenKey(open ? null : g.key)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2/50"
                >
                  {open
                    ? <ChevronDown size={14} className="w-[14px] shrink-0 text-ink-4" />
                    : <ChevronRight size={14} className="w-[14px] shrink-0 text-ink-4" />}
                  <span
                    className="inline-flex w-[92px] shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold"
                    style={{ color: badge.color }}
                  >
                    {badge.icon}<span className="truncate">{badge.label}</span>
                  </span>
                  <span className="w-[170px] shrink-0 truncate text-[13px] font-semibold text-ink">
                    {n === 1 ? (first.contact_name ?? "—") : `${n} contacts`}
                  </span>
                  <span className="w-[150px] shrink-0 truncate text-[12px] text-ink-3"
                    title={accounts.join(", ")}>
                    {accounts[0] ?? "—"}
                    {accounts.length > 1 ? <span className="text-ink-4"> +{accounts.length - 1}</span> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{groupDetail(g)}</span>
                  <span
                    className="w-[92px] shrink-0 truncate text-[11px] text-ink-4"
                    title={g.owner
                      ? `${g.owner}${g.owner_source === "account" ? " (account owner)" : " (contact owner)"}`
                      : "Nobody assigned"}
                  >
                    {g.owner ? nameOf(g.owner) : "—"}
                  </span>
                  <span className="w-[92px] shrink-0 truncate text-[11px] text-ink-4" title={g.editor ?? undefined}>
                    {g.editor ? nameOf(g.editor) : "—"}
                  </span>
                  <span className="w-[52px] shrink-0 text-right text-[11px] text-ink-4">
                    {g.at ? format(new Date(g.at), "MMM d") : "—"}
                  </span>
                </button>
                {open ? <GroupDetail g={g} /> : null}
              </div>
            );
          })}
          {groups.length > ACTIVITY_PAGE ? (
            <button type="button" onClick={() => setShowAll((v) => !v)}
              className="mt-2 self-start text-[12px] font-medium text-accent hover:underline">
              {showAll ? "Show less" : `Show all ${groups.length}`}
            </button>
          ) : null}
        </div>
      )}
    </Section>
  );
}

