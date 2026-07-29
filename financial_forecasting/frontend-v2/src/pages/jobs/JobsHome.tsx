/**
 * Jobs Home — personal command center (PBD-Home-style, per-person scope).
 *
 * A person picker (Me / staff / Everyone) scopes every zone:
 *   1. Assigned contacts — the working queue: contacts in the 'assigned'
 *      membership stage, grouped This week / Earlier by real stage-entry time
 *      (membership_stage_entered_at). ✓ moves a contact to Initial outreach;
 *      the row also edits membership stage + owner inline, and expands to the
 *      full contact panel (ContactExpandTabs: activity+log, opps, listings,
 *      tasks, comments, intro).
 *   2. Opportunities — sortable/filterable table of the person's open deals
 *      with needs-attention flags; inline stage edit carries the SAME modal
 *      gating as the Pipeline tab; rows expand to the full DealExpandPanel.
 *   3. Roles — every role on the person's open opps (role owner = opp owner;
 *      jobs_role has no owner column); expands to the full roles editor +
 *      builder progression for that opp.
 *   4. Tasks — every open jobs task for the scope, inline edit + quick-add.
 *   5. Intro requests — asks addressed to me, and mine (unscoped).
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChevronRight, Circle, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Tag } from "@/components/ui/Tag";
import { InlineDate, InlineSelect } from "@/components/ui/InlineEdit";
import { RowExpandPanel } from "@/components/RowExpandPanel";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { ContactExpandTabs, OwnerSelect } from "@/components/jobs/jobsEntity";
import { OppRolesSection } from "@/components/jobs/OppRolesSection";
import { OppBuilderActivity } from "@/components/jobs/OppBuilderActivity";
import { CommittedRolesModal } from "@/components/jobs/CommittedRolesModal";
import { DealExpandPanel, PlacementsModal, ClosedLostModal, stageOptionsFor } from "./JobsTeam";
import { cn } from "@/lib/utils";
import { relDay } from "@/lib/format";
import { useSort, sortBy } from "@/lib/sort";
import { useSessionState } from "@/lib/useSessionState";
import { useActiveUsers } from "@/services/projects";
import { useCurrentUser } from "@/services/auth";
import {
  useJobsAccountNames, useJobsContacts, useJobsOpportunities, useJobsStaff,
  useOpportunitiesOverview, useStaffNameResolver, useUpdateJobsMembership,
  useUpdateContact, useUpdateOpportunity,
  useIntroRequests, useRespondIntroRequest,
  STAGE_LABELS, STAGES_ORDERED, MEMBERSHIP_STAGES, MEMBERSHIP_STAGE_LABELS,
  type ContactFilters, type DealType, type IntroRequest, type JobStage, type JobsOpportunity,
  type JobsStaff, type MembershipStage, type OppNeedsRow,
} from "@/services/jobs";
import {
  useInterviewPipeline, type InterviewPipelineOpp, type InterviewPipelineRole,
} from "@/services/jobsOpps2";
import {
  useAllJobsTasks, useUpdateTaskById, useCreateTaskForParent, useDeleteTaskById,
  type JobsTaskEnriched,
} from "@/services/jobsTasks";

const MEMBERSHIP_STAGE_OPTIONS = MEMBERSHIP_STAGES.map((s) => ({ value: s, label: MEMBERSHIP_STAGE_LABELS[s] }));

// LOCAL date, not UTC — task deadlines are date-only strings compared against
// this; toISOString() would misbucket evenings for US users (due-today → overdue).
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Shared filter shape so the page-level count and the zone hit the same
// React Query cache entry.
const assignedFilters = (owner: string | null): ContactFilters => ({
  membership_stage: "assigned",
  limit: 1000,
  rules: owner ? [{ field: "owner", op: "equals", values: [owner] }] : undefined,
});

// Contacts already moved to Initial outreach — filtered client-side to this
// week's stage entries for the "contacted" progress strip.
const contactedFilters = (owner: string | null): ContactFilters => ({
  membership_stage: "initial_outreach",
  limit: 1000,
  rules: owner ? [{ field: "owner", op: "equals", values: [owner] }] : undefined,
});

// Start of the current Sun–Sat week (local) — matches the overview/scorecard's
// Saturday week_end convention.
const startOfWeekSunday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
};

const isOpenOpp = (o: JobsOpportunity) =>
  !o.stage.startsWith("closed") && !o.stage.startsWith("on_hold");

// ── Section label + bordered panel (mirrors the Performance tab's SectionWrap) ──
function Section({ title, count, action, children }: {
  title: string; count?: number; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</span>
          {count != null && <span className="text-[11px] tabular-nums text-ink-4">{count}</span>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// ── Assigned contacts zone ────────────────────────────────────────────────────
function AssignedRow({ c, staff, expanded, onToggle }: {
  c: { contact_id: number; full_name: string | null; current_title: string | null;
       current_company: string | null; owner_email?: string | null;
       membership_stage_entered_at?: string | null };
  staff: JobsStaff[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const update = useUpdateJobsMembership();
  const updateContact = useUpdateContact();
  const [inFlight, setInFlight] = useState(false);
  const markContacted = () => {
    setInFlight(true);
    update.mutate(
      { contact_id: c.contact_id, stage: "initial_outreach" },
      {
        onSuccess: () => toast.success(`Moved ${c.full_name ?? "contact"} to Initial outreach`),
        onSettled: () => setInFlight(false),
      },
    );
  };
  // Every row here is stage 'assigned' by construction; picking another stage
  // moves the contact and the row drops out on invalidation.
  const moveStage = (v: string) =>
    new Promise<void>((resolve, reject) => {
      if (!v || v === "assigned") return resolve();
      update.mutate(
        { contact_id: c.contact_id, stage: v },
        {
          onSuccess: () => {
            toast.success(`Moved ${c.full_name ?? "contact"} to ${MEMBERSHIP_STAGE_LABELS[v as MembershipStage] ?? v}`);
            resolve();
          },
          onError: reject,
        },
      );
    });
  return (
    <>
      <div
        onClick={onToggle}
        className={cn(
          "flex cursor-pointer items-center gap-2 border-t border-border-strong px-3 py-1.5 hover:bg-surface-2/40",
          expanded && "bg-surface-2/40",
          inFlight && "pointer-events-none opacity-40",
        )}
      >
        <button type="button" title="Mark contacted → Initial outreach" disabled={inFlight}
          onClick={(e) => { e.stopPropagation(); markContacted(); }}
          className="shrink-0 text-ink-4 hover:text-green">
          <Circle size={15} />
        </button>
        <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <Link to={`/jobs/contacts/${c.contact_id}`} onClick={(e) => e.stopPropagation()}
            className="truncate text-[13px] font-medium text-ink hover:text-accent">
            {c.full_name || "—"}
          </Link>
          <div className="truncate text-[11px] text-ink-4">
            {[c.current_title, c.current_company].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        <span onClick={(e) => e.stopPropagation()} className="shrink-0">
          <InlineSelect<string>
            value="assigned"
            options={MEMBERSHIP_STAGE_OPTIONS}
            onSave={moveStage}
            renderValue={() => (
              <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-accent-ink">Assigned</span>
            )}
          />
        </span>
        <OwnerSelect className="w-[130px] shrink-0" owner={c.owner_email ?? null} staff={staff}
          onSave={(email) => new Promise<void>((resolve, reject) =>
            updateContact.mutate({ id: c.contact_id, owner_email: email || null },
              { onSuccess: () => resolve(), onError: reject }))} />
        <span className="w-[52px] shrink-0 text-right text-[11.5px] tabular-nums text-ink-4"
          title={c.membership_stage_entered_at ? `Assigned ${new Date(c.membership_stage_entered_at).toLocaleDateString()}` : "Assignment date unknown"}>
          {relDay(c.membership_stage_entered_at) ?? "—"}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-border-strong">
          <ContactExpandTabs contactId={c.contact_id} />
        </div>
      )}
    </>
  );
}

function AssignedContactsZone({ owner }: { owner: string | null }) {
  const { data, isLoading } = useJobsContacts(assignedFilters(owner));
  const { data: staff = [] } = useJobsStaff();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const contacts = data?.data ?? [];
  const weekStart = startOfWeekSunday();
  const thisWeek = contacts.filter((c) =>
    c.membership_stage_entered_at && new Date(c.membership_stage_entered_at) >= weekStart);
  const earlier = contacts.filter((c) =>
    !c.membership_stage_entered_at || new Date(c.membership_stage_entered_at) < weekStart);
  const groups = [
    { key: "week", label: "This week", items: thisWeek, cls: "bg-surface-2/60 text-ink-4" },
    { key: "earlier", label: "Earlier — still waiting on first outreach", items: earlier, cls: "bg-amber-soft text-amber" },
  ].filter((g) => g.items.length > 0);

  // Contacts moved to Initial outreach THIS WEEK — kept visible with a green
  // check at the bottom of the queue so progress stays on the board.
  const { data: contactedData } = useJobsContacts(contactedFilters(owner));
  const contacted = useMemo(() => (contactedData?.data ?? [])
    .filter((c) => c.membership_stage_entered_at && new Date(c.membership_stage_entered_at) >= weekStart)
    .sort((a, b) => (b.membership_stage_entered_at ?? "").localeCompare(a.membership_stage_entered_at ?? "")),
    [contactedData, weekStart]);
  const [showAllContacted, setShowAllContacted] = useState(false);
  const shownContacted = showAllContacted ? contacted : contacted.slice(0, 10);
  const total = contacts.length + contacted.length;
  const pct = total > 0 ? Math.round((contacted.length / total) * 100) : 0;

  return (
    <Section title="Assigned contacts" count={contacts.length}
      action={total > 0 ? (
        <div className="flex items-center gap-2" title={`${contacted.length} of ${total} contacted this week`}>
          <span className={cn("text-[11.5px] font-medium", contacted.length > 0 ? "text-green" : "text-ink-4")}>
            {contacted.length} of {total} contacted
          </span>
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-green transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : undefined}>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : contacts.length === 0 && contacted.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12.5px] text-ink-3">
            No assigned contacts. Flag prospects from{" "}
            <Link to="/jobs/contacts" className="text-accent hover:underline">Contacts</Link> to build the week's queue.
          </div>
        ) : (
          <>
            {contacts.length === 0 && (
              <div className="px-3 py-4 text-center text-[12.5px] text-green">
                Queue clear — every assigned contact has been reached. 🎉
              </div>
            )}
            {groups.map((g) => (
              <div key={g.key}>
                <div className={cn("px-3 py-1 text-[10px] font-semibold uppercase tracking-wider", g.cls)}>
                  {g.label} · {g.items.length}
                </div>
                {g.items.map((c) => (
                  <AssignedRow key={c.contact_id} c={c} staff={staff}
                    expanded={expandedId === c.contact_id}
                    onToggle={() => setExpandedId((p) => (p === c.contact_id ? null : c.contact_id))} />
                ))}
              </div>
            ))}
            {contacted.length > 0 && (
              <div>
                <div className="bg-green-soft px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-green">
                  Contacted this week · {contacted.length}
                </div>
                {shownContacted.map((c) => (
                  <ContactedRow key={c.contact_id} c={c}
                    expanded={expandedId === c.contact_id}
                    onToggle={() => setExpandedId((p) => (p === c.contact_id ? null : c.contact_id))} />
                ))}
                {contacted.length > shownContacted.length && (
                  <button type="button" onClick={() => setShowAllContacted(true)}
                    className="w-full border-t border-border-strong px-3 py-1.5 text-[12px] text-accent hover:bg-surface-2/50">
                    Show all {contacted.length} contacted
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

// A contact already moved to Initial outreach this week — the "done" state of
// the queue. Row is deliberately quiet: green check, muted text, still
// expandable to the full contact panel.
function ContactedRow({ c, expanded, onToggle }: {
  c: { contact_id: number; full_name: string | null; current_title: string | null;
       current_company: string | null; membership_stage_entered_at?: string | null };
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <div
        onClick={onToggle}
        className={cn(
          "flex cursor-pointer items-center gap-2 border-t border-border-strong px-3 py-1.5 hover:bg-surface-2/40",
          expanded && "bg-surface-2/40",
        )}
      >
        <CheckCircle2 size={15} className="shrink-0 text-green" />
        <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <Link to={`/jobs/contacts/${c.contact_id}`} onClick={(e) => e.stopPropagation()}
            className="truncate text-[13px] font-medium text-ink-3 hover:text-accent">
            {c.full_name || "—"}
          </Link>
          <div className="truncate text-[11px] text-ink-4">
            {[c.current_title, c.current_company].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        <span className="shrink-0 text-[10.5px] font-medium text-green">Initial outreach</span>
        <span className="w-[52px] shrink-0 text-right text-[11.5px] tabular-nums text-ink-4"
          title={c.membership_stage_entered_at ? `Contacted ${new Date(c.membership_stage_entered_at).toLocaleDateString()}` : undefined}>
          {relDay(c.membership_stage_entered_at) ?? "—"}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-border-strong">
          <ContactExpandTabs contactId={c.contact_id} />
        </div>
      )}
    </>
  );
}

// ── Opportunities zone ────────────────────────────────────────────────────────
type OppSortKey = "account" | "stage" | "attention" | "tasks" | "last_activity" | "owner";

function OppTableRow({ o, needs, expanded, onToggle, showOwner, resolveName, onRecordPlacements, onClosedLost, onCommittedRoles }: {
  o: JobsOpportunity;
  needs: OppNeedsRow | undefined;
  expanded: boolean;
  onToggle: () => void;
  showOwner: boolean;
  resolveName: (v: string | null | undefined) => string;
  onRecordPlacements: (deal: { id: string; account_name: string; deal_type?: DealType | null }) => void;
  onClosedLost: (deal: { id: string; account_name: string }) => void;
  onCommittedRoles: (deal: { id: string; account_name: string }) => void;
}) {
  const updateOpp = useUpdateOpportunity();
  // Keep in sync with DealRow.saveStage (JobsTeam.tsx) — same modal gating.
  function saveStage(stage: JobStage) {
    if (stage === o.stage) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      updateOpp.mutate({ id: o.id, stage }, {
        onSuccess: () => {
          const isPlacementType = o.deal_type === "ft" || o.deal_type === "pt_contract";
          if (stage === "closed_won" && isPlacementType) onRecordPlacements({ id: o.id, account_name: o.account_name, deal_type: o.deal_type });
          else if (stage === "closed_lost") onClosedLost({ id: o.id, account_name: o.account_name });
          else if (stage === "active_opportunity_confirmed" && (o.num_roles ?? 0) === 0) onCommittedRoles({ id: o.id, account_name: o.account_name });
          resolve();
        },
        onError: reject,
      });
    });
  }
  const colSpan = showOwner ? 6 : 5;
  return (
    <>
      <tr
        onClick={onToggle}
        className={cn("cursor-pointer border-t border-border-strong hover:bg-surface-2/40", expanded && "bg-surface-2/40")}
      >
        <td className="px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
            <div className="min-w-0">
              <Link to={`/jobs/opportunities/${o.id}`} onClick={(e) => e.stopPropagation()}
                className="block truncate text-[13px] font-medium text-ink hover:text-accent">
                {o.account_name}
              </Link>
              {o.title && <div className="truncate text-[11px] text-ink-4">{o.title}</div>}
            </div>
          </div>
        </td>
        <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
          <InlineSelect<JobStage>
            value={o.stage}
            options={stageOptionsFor(o.stage)}
            onSave={saveStage}
            renderValue={(v) => (
              <span className="flex items-center gap-1 text-[12.5px] text-ink-2">
                <span className="truncate">{v ? STAGE_LABELS[v] : "—"}</span>
              </span>
            )}
          />
        </td>
        <td className="px-2 py-1.5">
          {needs ? (
            <span className="inline-flex min-w-0 items-center" title={needs.why}>
              <Tag variant={needs.days_in_stage >= 30 ? "red" : "amber"}>
                <AlertTriangle size={10} className="mr-0.5 inline-block" />
                {needs.why}
              </Tag>
            </span>
          ) : <span className="text-[11.5px] text-ink-4">—</span>}
        </td>
        <td className="px-2 py-1.5 text-right text-[11.5px] tabular-nums text-ink-4">
          {(o.open_tasks ?? 0) > 0 ? o.open_tasks : "—"}
        </td>
        <td className="px-2 py-1.5 text-right text-[11.5px] tabular-nums text-ink-4"
          title={o.last_activity_at ? `Last activity ${new Date(o.last_activity_at).toLocaleDateString()}` : "No activity"}>
          {relDay(o.last_activity_at) ?? "—"}
        </td>
        {showOwner && (
          <td className="px-2 py-1.5 text-[11.5px] text-ink-3">{o.owner_email ? resolveName(o.owner_email) : "—"}</td>
        )}
      </tr>
      {expanded && (
        <tr>
          <td colSpan={colSpan} className="border-t border-border-strong bg-surface-2/20 p-0">
            <DealExpandPanel deal={o} />
          </td>
        </tr>
      )}
    </>
  );
}

function OpportunitiesZone({ owner }: { owner: string | null }) {
  const { data } = useJobsOpportunities({ owner_email: owner ?? undefined, limit: 500 });
  const { data: overview } = useOpportunitiesOverview(owner ?? undefined);
  const resolveName = useStaffNameResolver();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [q, setQ] = useSessionState<string>("jobsHome.opps.q", "");
  const [stageFilter, setStageFilter] = useSessionState<string>("jobsHome.opps.stage", "");
  const [attnOnly, setAttnOnly] = useSessionState<boolean>("jobsHome.opps.attn", false);
  const { sort, toggle } = useSort<OppSortKey>();
  // Stage-gating modals — mirrors JobsTeam root.
  const [placementModalDeal, setPlacementModalDeal] = useState<{ id: string; account_name: string; deal_type?: DealType | null } | null>(null);
  const [committedRolesDeal, setCommittedRolesDeal] = useState<{ id: string; account_name: string } | null>(null);
  const [closedLostDeal, setClosedLostDeal] = useState<{ id: string; account_name: string } | null>(null);

  const open = useMemo(() => (data?.data ?? []).filter(isOpenOpp), [data]);
  const needsById = useMemo(
    () => new Map((overview?.needs_attention ?? []).map((n) => [n.opportunity_id, n])),
    [overview],
  );
  const flagged = open.filter((o) => needsById.has(o.id)).length;
  const stagesPresent = useMemo(() => {
    const present = new Set(open.map((o) => o.stage));
    // Keep a persisted-but-absent stage filter visible in the select — otherwise
    // the browser silently renders "All stages" while the filter still applies.
    if (stageFilter) present.add(stageFilter as JobStage);
    return STAGES_ORDERED.filter((s) => present.has(s));
  }, [open, stageFilter]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return open.filter((o) =>
      (!ql || (o.account_name ?? "").toLowerCase().includes(ql) || (o.title ?? "").toLowerCase().includes(ql)) &&
      (!stageFilter || o.stage === stageFilter) &&
      (!attnOnly || needsById.has(o.id)));
  }, [open, q, stageFilter, attnOnly, needsById]);

  const rows = useMemo(() => {
    if (!sort.key) {
      // Default: attention first (most days-in-stage), then most-recent activity.
      return [...filtered].sort((a, b) => {
        const na = needsById.get(a.id); const nb = needsById.get(b.id);
        if (Boolean(na) !== Boolean(nb)) return na ? -1 : 1;
        if (na && nb && na.days_in_stage !== nb.days_in_stage) return nb.days_in_stage - na.days_in_stage;
        return (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "");
      });
    }
    return sortBy(filtered, sort, (o, key) => {
      switch (key) {
        case "account": return (o.account_name ?? "").toLowerCase();
        case "stage": return STAGES_ORDERED.indexOf(o.stage);
        case "attention": return needsById.get(o.id)?.days_in_stage ?? null;
        case "tasks": return o.open_tasks ?? 0;
        case "last_activity": return o.last_activity_at ?? null;
        case "owner": return (o.owner_email ?? "").toLowerCase();
      }
    });
  }, [filtered, sort, needsById]);

  const showOwner = owner === null;
  return (
    <Section title="Opportunities" count={filtered.length}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setAttnOnly(!attnOnly)}
            className={cn(
              "h-7 rounded-md border px-2 text-[11.5px] font-medium",
              attnOnly ? "border-red/40 bg-red-soft text-red" : "border-border-strong bg-surface text-ink-3 hover:text-ink-2",
            )}>
            Needs attention{flagged > 0 ? ` · ${flagged}` : ""}
          </button>
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}
            className="h-7 rounded-md border border-border-strong bg-surface px-1.5 text-[12px] text-ink-2 outline-none focus:border-accent">
            <option value="">All stages</option>
            {stagesPresent.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
          <span className="relative">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-4" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search account / title"
              className="h-7 w-44 rounded-md border border-border-strong bg-surface pl-6 pr-2 text-[12px] text-ink outline-none focus:border-accent" />
          </span>
        </div>
      }>
      <div className="overflow-x-auto rounded-lg border border-border-strong bg-surface">
        <table className="w-full table-fixed">
          <colgroup>
            <col />
            <col className="w-[150px]" />
            <col className="w-[290px]" />
            <col className="w-[64px]" />
            <col className="w-[70px]" />
            {showOwner && <col className="w-[130px]" />}
          </colgroup>
          <thead>
            <tr className="bg-surface-2/60">
              <th className="px-3 py-1.5 text-left"><SortableHeader label="Account" sortKey="account" sort={sort} onToggle={toggle} /></th>
              <th className="px-2 py-1.5 text-left"><SortableHeader label="Stage" sortKey="stage" sort={sort} onToggle={toggle} /></th>
              <th className="px-2 py-1.5 text-left"><SortableHeader label="Attention" sortKey="attention" sort={sort} onToggle={toggle} /></th>
              <th className="px-2 py-1.5 text-right"><SortableHeader label="Tasks" sortKey="tasks" sort={sort} onToggle={toggle} align="right" /></th>
              <th className="px-2 py-1.5 text-right"><SortableHeader label="Last" sortKey="last_activity" sort={sort} onToggle={toggle} align="right" /></th>
              {showOwner && <th className="px-2 py-1.5 text-left"><SortableHeader label="Owner" sortKey="owner" sort={sort} onToggle={toggle} /></th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={showOwner ? 6 : 5} className="px-3 py-6 text-center text-[12.5px] text-ink-3">
                {open.length === 0 ? (
                  <>No open opportunities. <Link to="/jobs/pipeline" className="text-accent hover:underline">See the pipeline →</Link></>
                ) : "No opportunities match the filters."}
              </td></tr>
            ) : rows.map((o) => (
              <OppTableRow key={o.id} o={o} needs={needsById.get(o.id)}
                expanded={expandedId === o.id}
                onToggle={() => setExpandedId((p) => (p === o.id ? null : o.id))}
                showOwner={showOwner} resolveName={resolveName}
                onRecordPlacements={setPlacementModalDeal}
                onClosedLost={setClosedLostDeal}
                onCommittedRoles={setCommittedRolesDeal} />
            ))}
          </tbody>
        </table>
      </div>

      {placementModalDeal && <PlacementsModal deal={placementModalDeal} onClose={() => setPlacementModalDeal(null)} />}
      {committedRolesDeal && <CommittedRolesModal deal={committedRolesDeal} onClose={() => setCommittedRolesDeal(null)} />}
      {closedLostDeal && <ClosedLostModal deal={closedLostDeal} onClose={() => setClosedLostDeal(null)} />}
    </Section>
  );
}

// ── Roles zone ────────────────────────────────────────────────────────────────
type RoleSortKey = "title" | "account" | "status" | "owner";

const ROLE_STATUS_VARIANT: Record<string, "green" | "amber" | "accent" | "default"> = {
  ft_placed: "green",
  trial_active: "amber",
  committed_open: "accent",
};

// Per-ROLE builder progression (opp.builders carries jobs_role_id) — the
// opp-level summary would repeat on every role row and misattribute candidates.
function roleBuildersSummary(role: InterviewPipelineRole, opp: InterviewPipelineOpp): string {
  const mine = opp.builders.filter((b) => b.jobs_role_id === role.id);
  if (mine.length === 0) return "—";
  const count = (s: string) => mine.filter((b) => b.stage === s).length;
  const parts = [
    count("applied") > 0 && `${count("applied")} applied`,
    count("interview") > 0 && `${count("interview")} interviewing`,
    count("accepted") > 0 && `${count("accepted")} accepted`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${mine.length} linked`;
}

function RolesZone({ owner }: { owner: string | null }) {
  const { data: pipeline = [], isLoading } = useInterviewPipeline();
  const resolveName = useStaffNameResolver();
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null);
  const { sort, toggle } = useSort<RoleSortKey>();

  const scoped = useMemo(() => {
    // Match the Opportunities zone's "open" definition — on-hold opps keep
    // their roles out of the working list (interview-pipeline only excludes
    // closed opps server-side).
    const live = pipeline.filter((o) => !o.stage.startsWith("on_hold"));
    return owner === null ? live
      : live.filter((o) => (o.owner_email ?? "").toLowerCase() === owner.toLowerCase());
  }, [pipeline, owner]);
  const rows = useMemo(
    () => scoped.flatMap((opp) => opp.roles.map((role) => ({ role, opp }))),
    [scoped],
  );
  const sortedRows = useMemo(() => {
    if (!sort.key) return rows; // API order: interviewing-heavy opps first
    return sortBy(rows, sort, (r, key) => {
      switch (key) {
        case "title": return (r.role.title ?? "").toLowerCase();
        case "account": return (r.opp.account_name ?? "").toLowerCase();
        case "status": return r.role.placement_status_label;
        case "owner": return (r.opp.owner_email ?? "").toLowerCase();
      }
    });
  }, [rows, sort]);
  const openCount = rows.filter((r) => r.role.status === "open").length;
  const expandedOppId = useMemo(
    () => sortedRows.find((r) => r.role.id === expandedRoleId)?.opp.opportunity_id ?? null,
    [sortedRows, expandedRoleId],
  );
  const showOwner = owner === null;
  const colSpan = showOwner ? 5 : 4;

  return (
    <Section title="Roles" count={rows.length}
      action={openCount > 0 ? <span className="text-[11.5px] text-ink-4">{openCount} open</span> : undefined}>
      <div className="overflow-x-auto rounded-lg border border-border-strong bg-surface">
        <table className="w-full table-fixed">
          <colgroup>
            <col />
            <col />
            <col className="w-[150px]" />
            <col className="w-[210px]" />
            {showOwner && <col className="w-[130px]" />}
          </colgroup>
          <thead>
            <tr className="bg-surface-2/60">
              <th className="px-3 py-1.5 text-left"><SortableHeader label="Role" sortKey="title" sort={sort} onToggle={toggle} /></th>
              <th className="px-2 py-1.5 text-left"><SortableHeader label="Account" sortKey="account" sort={sort} onToggle={toggle} /></th>
              <th className="px-2 py-1.5 text-left"><SortableHeader label="Status" sortKey="status" sort={sort} onToggle={toggle} /></th>
              <th className="px-2 py-1.5 text-left"><span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Builders</span></th>
              {showOwner && <th className="px-2 py-1.5 text-left"><SortableHeader label="Owner" sortKey="owner" sort={sort} onToggle={toggle} /></th>}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={colSpan} className="px-3 py-6 text-center text-[12.5px] text-ink-3">Loading…</td></tr>
            ) : sortedRows.length === 0 ? (
              <tr><td colSpan={colSpan} className="px-3 py-6 text-center text-[12.5px] text-ink-3">
                No roles yet on open opportunities — commit roles from an opportunity's Roles tab above.
              </td></tr>
            ) : sortedRows.map(({ role, opp }) => {
              const expanded = expandedRoleId === role.id;
              const sibling = !expanded && expandedOppId === opp.opportunity_id;
              return (
                <RoleTableRow key={role.id} role={role} opp={opp}
                  expanded={expanded} sibling={sibling} colSpan={colSpan}
                  showOwner={showOwner} resolveName={resolveName}
                  onToggle={() => setExpandedRoleId((p) => (p === role.id ? null : role.id))} />
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function RoleTableRow({ role, opp, expanded, sibling, colSpan, showOwner, resolveName, onToggle }: {
  role: InterviewPipelineRole;
  opp: InterviewPipelineOpp;
  expanded: boolean;
  sibling: boolean;
  colSpan: number;
  showOwner: boolean;
  resolveName: (v: string | null | undefined) => string;
  onToggle: () => void;
}) {
  return (
    <>
      <tr onClick={onToggle}
        className={cn("cursor-pointer border-t border-border-strong hover:bg-surface-2/40", (expanded || sibling) && "bg-surface-2/40")}>
        <td className="px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform", expanded && "rotate-90")} />
            <span className="truncate text-[13px] font-medium text-ink">{role.title || "Untitled role"}</span>
          </div>
        </td>
        <td className="px-2 py-1.5">
          <Link to={`/jobs/opportunities/${opp.opportunity_id}`} onClick={(e) => e.stopPropagation()}
            className="truncate text-[12.5px] text-ink-2 hover:text-accent">
            {opp.account_name ?? "—"}
          </Link>
        </td>
        <td className="px-2 py-1.5">
          <Tag variant={ROLE_STATUS_VARIANT[role.placement_status] ?? "default"}>{role.placement_status_label}</Tag>
        </td>
        <td className="truncate px-2 py-1.5 text-[11.5px] text-ink-4">{roleBuildersSummary(role, opp)}</td>
        {showOwner && (
          <td className="px-2 py-1.5 text-[11.5px] text-ink-3">{opp.owner_email ? resolveName(opp.owner_email) : "—"}</td>
        )}
      </tr>
      {expanded && (
        <tr>
          <td colSpan={colSpan} className="border-t border-border-strong bg-surface-2/20 p-0">
            <RowExpandPanel defaultTab="roles" tabs={[
              { id: "roles", label: "Roles", render: () => <div className="px-4 py-3"><OppRolesSection oppId={opp.opportunity_id} /></div> },
              { id: "builders", label: "Builders", render: () => <div className="px-4 py-3"><OppBuilderActivity oppId={opp.opportunity_id} /></div> },
            ]} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Tasks zone ────────────────────────────────────────────────────────────────
// NOTE: intentionally diverges from lib/risk.ts — this UI has a distinct
// "Due today" bucket, which riskForTask folds into its 7-day due-soon window.
function dueBucket(deadline: string | null): "overdue" | "today" | "upcoming" | "none" {
  if (!deadline) return "none";
  const t = todayIso();
  if (deadline < t) return "overdue";
  if (deadline === t) return "today";
  return "upcoming";
}

function TaskRow({
  task, ownerOptions, onPatch, onDelete,
}: {
  task: JobsTaskEnriched;
  ownerOptions: { value: string; label: string }[];
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const bucket = dueBucket(task.deadline);
  return (
    <div className="flex items-center gap-2 border-t border-border-strong px-3 py-1.5 hover:bg-surface-2/40">
      <button type="button" onClick={() => onPatch({ status: "Completed" })} title="Mark complete"
        className="shrink-0 text-ink-4 hover:text-green">
        <Circle size={15} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-ink">{task.title}</div>
        <div className="truncate text-[11px] text-ink-4">
          {task.parent_label}{task.parent_sublabel ? ` · ${task.parent_sublabel}` : ""}
        </div>
      </div>
      <select
        value={task.owner_ids[0] ?? ""}
        onChange={(e) => onPatch({ owner_ids: e.target.value ? [e.target.value] : [] })}
        className="h-6 max-w-[130px] rounded border border-border-strong bg-surface px-1 text-[11.5px] text-ink-2 outline-none focus:border-accent"
        title="Assignee"
      >
        <option value="">Unassigned</option>
        {ownerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div className={cn(
        "w-[92px] shrink-0 text-right text-[11.5px]",
        bucket === "overdue" ? "font-semibold text-red" : bucket === "today" ? "font-semibold text-amber" : "text-ink-3",
      )}>
        <InlineDate value={task.deadline} variant="short" align="right"
          onSave={async (v) => onPatch({ deadline: v || null })} />
      </div>
      <button type="button" onClick={onDelete} title="Delete" className="shrink-0 text-ink-4 hover:text-red">×</button>
    </div>
  );
}

function TasksZone({ owner }: { owner: string | null }) {
  const { data: tasks = [], isLoading } = useAllJobsTasks();
  const { data: users = [] } = useActiveUsers();
  const { data: accounts = [] } = useJobsAccountNames();
  const update = useUpdateTaskById();
  const create = useCreateTaskForParent();
  const del = useDeleteTaskById();

  const ownerOptions = useMemo(
    () => users.map((u) => ({ value: u.id, label: u.display_name || u.email })),
    [users],
  );
  // The page-level person picker is email-based; tasks are owned by org_users id.
  const ownerId = useMemo(
    () => owner ? users.find((u) => u.email?.toLowerCase() === owner.toLowerCase())?.id ?? null : null,
    [users, owner],
  );
  const filtered = useMemo(() => {
    if (owner === null) return tasks;
    if (!ownerId) return [];  // selected person has no org_users match → nothing to show
    return tasks.filter((t) => t.owner_ids.includes(ownerId));
  }, [tasks, owner, ownerId]);

  const groups: { key: string; label: string; items: JobsTaskEnriched[] }[] = useMemo(() => {
    const by: Record<string, JobsTaskEnriched[]> = { overdue: [], today: [], upcoming: [], none: [] };
    for (const t of filtered) by[dueBucket(t.deadline)].push(t);
    return [
      { key: "overdue", label: "Overdue", items: by.overdue },
      { key: "today", label: "Due today", items: by.today },
      { key: "upcoming", label: "Upcoming", items: by.upcoming },
      { key: "none", label: "No due date", items: by.none },
    ].filter((g) => g.items.length > 0);
  }, [filtered]);

  // Quick-add (tied to an account). Assignee defaults to the picked person.
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newAccount, setNewAccount] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newDue, setNewDue] = useState("");
  const openAdd = () => {
    setNewOwner(ownerId ?? "");
    setAdding((v) => !v);
  };
  // Keep the default assignee in step if the person picker changes while the
  // quick-add form is open — otherwise the task quietly goes to the old person.
  useEffect(() => {
    if (adding) setNewOwner(ownerId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId]);
  const submitNew = async () => {
    if (!newTitle.trim() || !newAccount) return;
    await create.mutateAsync({
      parent_type: "account", parent_id: newAccount, title: newTitle.trim(),
      owner_ids: newOwner ? [newOwner] : [], deadline: newDue || null,
    });
    setNewTitle(""); setNewDue(""); setAdding(false);
  };

  return (
    <Section title="Tasks" count={filtered.length} action={
      <button type="button" onClick={openAdd}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 hover:bg-surface-2">
        <Plus size={12} /> Add
      </button>
    }>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
        {adding && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2/40 px-3 py-2">
            <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Task title…"
              onKeyDown={(e) => { if (e.key === "Enter") void submitNew(); }}
              className="h-7 min-w-[180px] flex-1 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent" />
            <select value={newAccount} onChange={(e) => setNewAccount(e.target.value)}
              className="h-7 max-w-[180px] rounded border border-border-strong bg-surface px-1 text-[12px] text-ink-2 outline-none focus:border-accent">
              <option value="">Account…</option>
              {accounts.map((a) => <option key={a.account_key} value={a.account_key}>{a.account}</option>)}
            </select>
            <select value={newOwner} onChange={(e) => setNewOwner(e.target.value)}
              className="h-7 rounded border border-border-strong bg-surface px-1 text-[12px] text-ink-2 outline-none focus:border-accent">
              <option value="">Assignee…</option>
              {ownerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)}
              className="h-7 rounded border border-border-strong bg-surface px-1 text-[12px] text-ink-2 outline-none focus:border-accent" />
            <button type="button" onClick={() => void submitNew()} disabled={!newTitle.trim() || !newAccount}
              className="h-7 rounded bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-40">Save</button>
          </div>
        )}
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">No open tasks. 🎉</div>
        ) : groups.map((g) => (
          <div key={g.key}>
            <div className={cn(
              "px-3 py-1 text-[10px] font-semibold uppercase tracking-wider",
              g.key === "overdue" ? "bg-red-soft text-red"
                : g.key === "today" ? "bg-amber-soft text-amber"
                : "bg-surface-2/60 text-ink-4",
            )}>
              {g.label} · {g.items.length}
            </div>
            {g.items.map((t) => (
              <TaskRow key={t.id} task={t} ownerOptions={ownerOptions}
                onPatch={(patch) => update.mutate({ taskId: t.id, patch })}
                onDelete={() => del.mutate(t.id)} />
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Intro requests — asks addressed to me (staff + Sputnik builder), and mine ─
const ASK_LABELS: Record<string, string> = {
  hiring_intro: "Hiring intro", industry_advice: "Industry advice",
  job_referral: "Job referral", mock_interview: "Mock interview",
};
const askLabel = (a: string | null) => (a ? ASK_LABELS[a] ?? a.replace(/_/g, " ") : "Intro");

function IntroRequestCard({ r, mine }: { r: IntroRequest; mine: boolean }) {
  const respond = useRespondIntroRequest();
  const [note, setNote] = useState("");
  const act = (status: string) =>
    respond.mutate({ id: r.id, status, response_note: note.trim() || undefined, source: r.source });
  const isPending = r.status === "pending";
  const isAccepted = r.status === "accepted" || r.status === "approved";
  return (
    <div className="flex flex-col gap-1.5 border-t border-border-strong px-3 py-2 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Link to={`/jobs/contacts/${r.contact_id}`} className="font-medium text-ink hover:text-accent">{r.contact_name || "—"}</Link>
        {r.contact_company && <span className="text-[11.5px] text-ink-3">{r.contact_company}</span>}
        <Tag variant={r.source === "builder" ? "default" : "accent"}>{askLabel(r.specific_ask)}</Tag>
        <span className="text-[11px] text-ink-4">
          {mine ? `via ${r.connector_name || r.connector_email || "—"}` : `from ${r.requested_by_name || r.requested_by || "—"}${r.source === "builder" ? " (builder)" : ""}`}
          {r.created_at ? ` · ${relDay(r.created_at)}` : ""}
        </span>
        {!isPending && (
          <Tag variant={isAccepted ? "green" : r.status === "completed" ? "green" : "default"}>{r.status}</Tag>
        )}
      </div>
      {r.context && <div className="text-[11.5px] text-ink-3">{r.context}</div>}
      {r.response_note && <div className="text-[11.5px] italic text-ink-4">↳ {r.response_note}</div>}
      {!mine && isPending && (
        <div className="flex items-center gap-1.5">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note…"
            className="h-6 w-56 rounded border border-border-strong bg-surface px-1.5 text-[11.5px] outline-none focus:border-accent" />
          <button type="button" disabled={respond.isPending} onClick={() => act("accepted")}
            className="rounded border border-green/40 px-2 py-0.5 text-[11px] font-medium text-green hover:bg-green/10">Accept</button>
          <button type="button" disabled={respond.isPending} onClick={() => act("declined")}
            className="rounded border border-red/40 px-2 py-0.5 text-[11px] font-medium text-red hover:bg-red/10">Decline</button>
        </div>
      )}
      {!mine && isAccepted && r.source === "staff" && (
        <div>
          <button type="button" disabled={respond.isPending} onClick={() => act("completed")}
            className="rounded border border-border-strong px-2 py-0.5 text-[11px] font-medium text-ink-3 hover:border-accent hover:text-accent">Mark intro made</button>
        </div>
      )}
      {mine && isPending && (
        <div>
          <button type="button" disabled={respond.isPending} onClick={() => act("withdrawn")}
            className="rounded border border-border-strong px-2 py-0.5 text-[11px] text-ink-4 hover:text-red">Withdraw</button>
        </div>
      )}
    </div>
  );
}

function IntroRequestsZone() {
  const { data: me } = useCurrentUser();
  const [showClosed, setShowClosed] = useState(false);
  const { data: reqs = [], isLoading } = useIntroRequests("all", showClosed);
  const myEmail = me?.email?.toLowerCase();
  const inbox = reqs.filter((r) => (r.requested_by || "").toLowerCase() !== myEmail);
  const sent = reqs.filter((r) => (r.requested_by || "").toLowerCase() === myEmail);
  if (isLoading) return null;
  if (reqs.length === 0 && !showClosed) {
    // Always visible so the flow is discoverable — a one-line how-to when empty.
    return (
      <Section title="Intro requests" count={0}>
        <div className="rounded-lg border border-border-strong bg-surface px-3 py-3 text-[12px] text-ink-4">
          None yet. Open any contact and hit <span className="font-medium text-ink-2">Request intro</span> next
          to their connected staff — the request lands here for that staff member to accept, decline, or mark the intro made.
          {" "}<Link to="/jobs/contacts?connected=1" className="text-accent hover:underline">Browse staff-connected contacts →</Link>
        </div>
      </Section>
    );
  }
  return (
    <Section title="Intro requests" count={reqs.length}
      action={
        <label className="flex items-center gap-1 text-[11px] text-ink-4">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="accent-accent" /> show closed
        </label>
      }>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
          <div className="bg-surface-2/60 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">For you {inbox.length ? `(${inbox.length})` : ""}</div>
          {inbox.length === 0 ? <div className="px-3 py-4 text-center text-[12px] text-ink-4">No requests for you.</div>
            : inbox.map((r) => <IntroRequestCard key={`${r.source}-${r.id}`} r={r} mine={false} />)}
        </div>
        <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
          <div className="bg-surface-2/60 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Your requests {sent.length ? `(${sent.length})` : ""}</div>
          {sent.length === 0 ? <div className="px-3 py-4 text-center text-[12px] text-ink-4">You haven't requested any intros.</div>
            : sent.map((r) => <IntroRequestCard key={`${r.source}-${r.id}`} r={r} mine={true} />)}
        </div>
      </div>
    </Section>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export function JobsHome() {
  const { data: me } = useCurrentUser();
  const { data: staff = [] } = useJobsStaff();
  // "me" | "all" | a staff email. Resolved owner: null = Everyone.
  const [sel, setSel] = useState<string>("me");

  // Gate BEFORE any data hooks run (they live in HomeBody) — otherwise the
  // first render fires org-wide assigned/overview fetches that get thrown
  // away the moment `me` resolves.
  if (sel === "me" && !me) {
    return <div className="px-1 py-8 text-[12.5px] text-ink-3">Loading…</div>;
  }

  // "Me" resolves to the CANONICAL staff email (case/alias) so exact-match
  // server filters (contacts owner rule, opportunities owner_email) behave
  // identically to picking yourself from the dropdown. Falls back to the raw
  // login email when the staff list hasn't loaded or doesn't include the user.
  const owner: string | null = sel === "all" ? null
    : sel === "me"
      ? (staff.find((s) => s.email.toLowerCase() === me?.email?.toLowerCase())?.email ?? me?.email ?? null)
      : sel;

  return <HomeBody me={me} staff={staff} sel={sel} setSel={setSel} owner={owner} />;
}

function HomeBody({ me, staff, sel, setSel, owner }: {
  me: { email?: string; name?: string } | null | undefined;
  staff: JobsStaff[];
  sel: string;
  setSel: (v: string) => void;
  owner: string | null;
}) {
  // Same query keys as the zones — React Query dedupes, so the chips are free.
  const { data: assigned } = useJobsContacts(assignedFilters(owner));
  const { data: overview } = useOpportunitiesOverview(owner ?? undefined);
  const { data: pipelineOpps = [] } = useInterviewPipeline();
  const openRoles = useMemo(() => {
    const live = pipelineOpps.filter((o) => !o.stage.startsWith("on_hold"));
    const scoped = owner ? live.filter((o) => (o.owner_email ?? "").toLowerCase() === owner.toLowerCase()) : live;
    return scoped.reduce((n, o) => n + o.summary.open_roles, 0);
  }, [pipelineOpps, owner]);
  const { data: tasks = [] } = useAllJobsTasks();
  const { data: users = [] } = useActiveUsers();
  const ownerId = owner ? users.find((u) => u.email?.toLowerCase() === owner.toLowerCase())?.id ?? null : null;
  const myTasks = owner === null ? tasks : ownerId ? tasks.filter((t) => t.owner_ids.includes(ownerId)) : [];
  const overdue = myTasks.filter((t) => dueBucket(t.deadline) === "overdue").length;
  const attention = overview?.needs_attention?.length ?? 0;

  const greeting = (() => {
    const h = new Date().getHours();
    const tod = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    const first = me?.name?.split(" ")[0];
    return `Good ${tod}${first ? `, ${first}` : ""}`;
  })();

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[15px] font-semibold text-ink">{greeting}</h1>
          <span className="flex flex-wrap items-baseline gap-x-2.5 text-[11.5px]">
            <span className="text-ink-4">{assigned?.total ?? 0} assigned</span>
            {attention > 0 && <span className="font-semibold text-amber">· {attention} need{attention === 1 ? "s" : ""} attention</span>}
            {openRoles > 0 && <span className="text-ink-4">· {openRoles} open role{openRoles === 1 ? "" : "s"}</span>}
            {overdue > 0 && <span className="font-semibold text-red">· {overdue} overdue task{overdue === 1 ? "" : "s"}</span>}
          </span>
        </div>
        <select value={sel} onChange={(e) => setSel(e.target.value)} title="Whose week to show"
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
          <option value="me">Me</option>
          {staff.filter((s) => s.email.toLowerCase() !== me?.email?.toLowerCase()).map((s) => (
            <option key={s.email} value={s.email}>{s.name}</option>
          ))}
          <option value="all">Everyone</option>
        </select>
      </div>

      <AssignedContactsZone owner={owner} />
      <OpportunitiesZone owner={owner} />
      <RolesZone owner={owner} />
      <TasksZone owner={owner} />
      <IntroRequestsZone />
    </div>
  );
}
