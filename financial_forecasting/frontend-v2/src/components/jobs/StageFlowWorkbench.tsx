/**
 * The Stage Flow drill: the records behind one number, as a working list.
 *
 * Opens from any Pool, Net New or breakdown number on the Overview Stage Flow.
 * Contacts render with the Contacts page's own rows and opportunities with the
 * Pipeline page's, so every field, inline editor (stage, owner, tags, dates)
 * and the expand panel (comments, tasks, activity) behave exactly as they do
 * there. On top: search, quick filters, a column picker, and bulk stage /
 * owner for selected contacts. Edits invalidate the ["jobs"] queries, so the
 * chart behind the drawer updates as the team works the list.
 *
 * Which records: the caller passes the `(id, stage)` keys the clicked number
 * counted, so the list is exactly that number, then this fetches the full rows.
 */
import { useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";

import {
  MEMBERSHIP_STAGES,
  MEMBERSHIP_STAGE_LABELS,
  STAGE_LABELS,
  useBulkContactOwner,
  useFlagContactsForJobs,
  useJobsContacts,
  useJobsOpportunities,
  type DealType,
  type JobStage,
  type MembershipStage,
} from "@/services/jobs";
import { Drawer } from "@/components/ui/Drawer";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { CommittedRolesModal } from "@/components/jobs/CommittedRolesModal";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { cn } from "@/lib/utils";
import { COLUMN_ORDER, COL_LABELS, ContactRow, type ColKey } from "@/pages/jobs/JobsContacts";
import {
  ClosedLostModal, DealRow, OPP_COLUMN_ORDER, OPP_COL_LABELS,
  PlacementsModal, type OppColKey,
} from "@/pages/jobs/JobsTeam";

// A leaner default than the full pages, so the drill's own context columns
// (In stage, Net new, From) fit without scrolling. Columns adds the rest, and
// the choice is remembered per browser.
const DRILL_CONTACT_COLS: ColKey[] = ["name", "flag", "company", "title", "owner", "last_touch", "tasks"];
const DRILL_OPP_COLS: OppColKey[] = ["company", "role", "stage", "likelihood", "deal_type", "owner", "target_close", "est_jobs", "tasks"];
// "role" holds the deal's title ("Vertech OP_Sep2026"), which is the
// opportunity's name, so the drill calls it that (Kwame 2026-10-22).
const DRILL_OPP_LABELS: Record<OppColKey, string> = { ...OPP_COL_LABELS, role: "Opportunity" };

/** What the clicked number counted, one entry per record (a contact can appear
 *  under two stages of a summary row, so the stage travels with it). */
export interface WorkbenchRecord {
  id: string;
  stage: string;
  /** "12d" in stage (Pool) or "Oct 5" moved (Net New). */
  when: string;
  /** Net New only: the stage it came from, already labelled. */
  from?: string | null;
  /** Activity drills: the context cells, matching `contextHead`. */
  extra?: string[];
}

export function StageFlowWorkbench({ band, title, subtitle, isPool, contextHead, records, stageLabel, nameOf, onClose }: {
  band: "outreach" | "pipeline";
  title: string;
  subtitle: string;
  isPool: boolean;
  /** Overrides the context columns (In stage / Net new, From), e.g. Sends, Last. */
  contextHead?: string[];
  records: WorkbenchRecord[];
  stageLabel: (s: string | null) => string;
  nameOf: (e: string | null) => string;
  onClose: () => void;
}) {
  const width = typeof window !== "undefined" ? Math.min(1320, window.innerWidth - 32) : 1200;
  return (
    <Drawer open onClose={onClose} title={title} subtitle={subtitle} width={width}>
      {band === "outreach"
        ? <ContactsList isPool={isPool} contextHead={contextHead} records={records} stageLabel={stageLabel} nameOf={nameOf} />
        : <OpportunitiesList isPool={isPool} contextHead={contextHead} records={records} stageLabel={stageLabel} nameOf={nameOf} />}
    </Drawer>
  );
}

// ── Shared toolbar ───────────────────────────────────────────────────────────

const SELECT = "h-8 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent";

function Toolbar({ search, onSearch, owners, owner, onOwner, stages, stage, onStage, shown, total, columns }: {
  search: string; onSearch: (v: string) => void;
  owners: { value: string; label: string }[]; owner: string; onOwner: (v: string) => void;
  stages: { value: string; label: string }[]; stage: string; onStage: (v: string) => void;
  shown: number; total: number; columns: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2 px-4 py-2.5">
      <label className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
        <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search name, company, title…"
          className="h-8 w-64 rounded-md border border-border-strong bg-surface pl-8 pr-2 text-[12.5px] text-ink outline-none focus:border-accent" />
      </label>
      <select value={owner} onChange={(e) => onOwner(e.target.value)} className={SELECT} aria-label="Owner">
        <option value="">All owners</option>
        {owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {stages.length > 1 && (
        <select value={stage} onChange={(e) => onStage(e.target.value)} className={SELECT} aria-label="Stage">
          <option value="">All stages</option>
          {stages.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      )}
      <span className="ml-auto text-[12px] tabular-nums text-ink-3">
        {shown === total ? `${total.toLocaleString()} shown` : `${shown.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      {columns}
    </div>
  );
}

function ownerOptions(emails: (string | null | undefined)[], nameOf: (e: string | null) => string) {
  const set = [...new Set(emails.map((e) => (e ?? "").toLowerCase()))];
  return set.map((e) => ({ value: e || "(none)", label: e ? nameOf(e) : "No owner" }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** One place left (-1) or right (+1) among the shown columns. */
function stepMove<K extends string>(visible: K[], move: (col: K, target: K) => void) {
  return (col: K, dir: -1 | 1) => {
    const target = visible[visible.indexOf(col) + dir];
    if (target) move(col, target);
  };
}

const matchesOwner = (owner: string, email: string | null | undefined) =>
  !owner || (owner === "(none)" ? !email : (email ?? "").toLowerCase() === owner);

function Loading() {
  return <div className="flex flex-1 items-center justify-center py-16 text-ink-4"><Loader2 size={16} className="animate-spin" /></div>;
}

function Empty({ text }: { text: string }) {
  return (
    <div className="m-4 rounded-lg border border-dashed border-border-strong px-4 py-10 text-center text-[12.5px] text-ink-4">{text}</div>
  );
}

// ── Contacts ─────────────────────────────────────────────────────────────────

// Revisit asks for a date per contact, so it isn't offered in bulk.
const BULK_STAGES = MEMBERSHIP_STAGES.filter((s) => s !== "revisit");

function ContactsList({ isPool, contextHead, records, stageLabel, nameOf }: {
  isPool: boolean; contextHead?: string[]; records: WorkbenchRecord[];
  stageLabel: (s: string | null) => string; nameOf: (e: string | null) => string;
}) {
  const byId = useMemo(() => {
    const m = new Map<number, WorkbenchRecord>();
    records.forEach((r) => { if (!m.has(Number(r.id))) m.set(Number(r.id), r); });
    return m;
  }, [records]);
  const ids = useMemo(() => [...byId.keys()], [byId]);
  const q = useJobsContacts({ ids, limit: 5000 });
  const { visible, toggle, move } = useColumnVisibility<ColKey>("bedrock-v2:vis:stage-flow-drill-contacts", COLUMN_ORDER, DRILL_CONTACT_COLS);

  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("");
  const [stage, setStage] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkStage, setBulkStage] = useState("");
  const [bulkOwner, setBulkOwner] = useState("");
  const flag = useFlagContactsForJobs();
  const setOwnerBulk = useBulkContactOwner();

  const all = q.data?.data ?? [];
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter((c) =>
      (!s || [c.full_name, c.current_company, c.current_title, c.email].some((v) => (v ?? "").toLowerCase().includes(s)))
      && matchesOwner(owner, c.owner_email)
      && (!stage || c.membership_stage === stage));
  }, [all, search, owner, stage]);
  const owners = useMemo(() => ownerOptions(all.map((c) => c.owner_email), nameOf), [all, nameOf]);
  const stages = useMemo(() => [...new Set(all.map((c) => c.membership_stage).filter(Boolean) as string[])]
    .map((s) => ({ value: s, label: MEMBERSHIP_STAGE_LABELS[s as MembershipStage] ?? s })), [all]);

  const allChecked = rows.length > 0 && rows.every((c) => selected.has(c.contact_id));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((c) => c.contact_id)));
  const applyBulk = () => {
    const contact_ids = [...selected];
    const done = () => { setSelected(new Set()); setBulkStage(""); setBulkOwner(""); };
    if (bulkStage) flag.mutate({ contact_ids, stage: bulkStage }, { onSuccess: () => { if (!bulkOwner) done(); } });
    if (bulkOwner) setOwnerBulk.mutate({ contact_ids, owner_email: bulkOwner === "(none)" ? null : bulkOwner }, { onSuccess: done });
  };
  const busy = flag.isPending || setOwnerBulk.isPending;

  const extraHead = contextHead ?? (isPool ? ["In stage"] : ["Net new", "From"]);
  const extra = (id: number) => {
    const r = byId.get(id);
    if (!r) return [];
    if (r.extra) return r.extra;
    return isPool ? [r.when] : [r.when, r.from ? stageLabel(r.from) : "—"];
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar search={search} onSearch={setSearch} owners={owners} owner={owner} onOwner={setOwner}
        stages={stages} stage={stage} onStage={setStage} shown={rows.length} total={all.length}
        columns={<ColumnChooser allColumns={COLUMN_ORDER} labels={COL_LABELS} visible={visible} required={["name"]} onToggle={toggle} onMove={stepMove(visible, move)} />} />
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-accent-soft px-4 py-2 text-[12.5px]">
          <span className="font-semibold text-accent-ink">{selected.size} selected</span>
          <select value={bulkStage} onChange={(e) => setBulkStage(e.target.value)} className={SELECT} aria-label="Set stage">
            <option value="">Set stage…</option>
            {BULK_STAGES.map((s) => <option key={s} value={s}>{MEMBERSHIP_STAGE_LABELS[s]}</option>)}
          </select>
          <select value={bulkOwner} onChange={(e) => setBulkOwner(e.target.value)} className={SELECT} aria-label="Set owner">
            <option value="">Set owner…</option>
            {owners.filter((o) => o.value !== "(none)").map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            <option value="(none)">No owner</option>
          </select>
          <button type="button" disabled={busy || (!bulkStage && !bulkOwner)} onClick={applyBulk}
            className="h-8 rounded-md bg-accent px-3 font-medium text-white disabled:opacity-50">
            {busy ? "Updating…" : "Update"}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className="text-ink-3 hover:text-ink">Clear</button>
          <span className="text-[11.5px] text-ink-4">Revisit needs a date: set it on the row.</span>
        </div>
      )}
      {q.isLoading ? <Loading /> : rows.length === 0 ? <Empty text={all.length ? "Nothing matches these filters." : "No contacts here."} /> : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-20 bg-surface-2">
              <tr className="text-[10.5px] uppercase tracking-wider text-ink-3">
                {visible.map((k, i) => (
                  <th key={k} className={cn("px-3 py-2 font-semibold", i === 0 && "sticky left-0 z-30 bg-surface-2")}>
                    {/* Select-all rides with Name, where each row's checkbox is, wherever Name is moved. */}
                    {k === "name" ? (
                      <span className="flex items-center gap-2">
                        <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all"
                          className="h-3.5 w-3.5 accent-[color:var(--accent,#4242EA)]" />
                        {COL_LABELS[k]}
                      </span>
                    ) : COL_LABELS[k]}
                  </th>
                ))}
                {extraHead.map((h) => <th key={h} className="border-l border-border px-3 py-2 font-semibold text-accent-ink">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <ContactRow key={c.contact_id} contact={c} visibleCols={visible}
                  expanded={expanded === c.contact_id}
                  onOpen={() => setExpanded(expanded === c.contact_id ? null : c.contact_id)}
                  selected={selected.has(c.contact_id)}
                  onToggleSelect={() => setSelected((s) => {
                    const n = new Set(s); if (n.has(c.contact_id)) n.delete(c.contact_id); else n.add(c.contact_id); return n;
                  })}
                  extraCells={extra(c.contact_id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Hint />
    </div>
  );
}

// ── Opportunities ────────────────────────────────────────────────────────────

function OpportunitiesList({ isPool, contextHead, records, stageLabel, nameOf }: {
  isPool: boolean; contextHead?: string[]; records: WorkbenchRecord[];
  stageLabel: (s: string | null) => string; nameOf: (e: string | null) => string;
}) {
  const byId = useMemo(() => {
    const m = new Map<string, WorkbenchRecord>();
    records.forEach((r) => { if (!m.has(r.id)) m.set(r.id, r); });
    return m;
  }, [records]);
  const ids = useMemo(() => [...byId.keys()], [byId]);
  const q = useJobsOpportunities({ ids, limit: 500 });
  const { visible, toggle, move } = useColumnVisibility<OppColKey>("bedrock-v2:vis:stage-flow-drill-opps-v2", OPP_COLUMN_ORDER, DRILL_OPP_COLS);

  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("");
  const [stage, setStage] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [placementDeal, setPlacementDeal] = useState<{ id: string; account_name: string; deal_type?: DealType | null } | null>(null);
  const [committedDeal, setCommittedDeal] = useState<{ id: string; account_name: string } | null>(null);
  const [lostDeal, setLostDeal] = useState<{ id: string; account_name: string } | null>(null);

  const all = q.data?.data ?? [];
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter((o) =>
      (!s || [o.account_name, o.title].some((v) => (v ?? "").toLowerCase().includes(s)))
      && matchesOwner(owner, o.owner_email)
      && (!stage || o.stage === stage));
  }, [all, search, owner, stage]);
  const owners = useMemo(() => ownerOptions(all.map((o) => o.owner_email), nameOf), [all, nameOf]);
  const stages = useMemo(() => [...new Set(all.map((o) => o.stage))]
    .map((s) => ({ value: s, label: STAGE_LABELS[s as JobStage] ?? s })), [all]);

  const extraHead = contextHead ?? (isPool ? ["In stage"] : ["Net new", "From"]);
  const extra = (id: string) => {
    const r = byId.get(id);
    if (!r) return [];
    if (r.extra) return r.extra;
    return isPool ? [r.when] : [r.when, r.from ? stageLabel(r.from) : "—"];
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar search={search} onSearch={setSearch} owners={owners} owner={owner} onOwner={setOwner}
        stages={stages} stage={stage} onStage={setStage} shown={rows.length} total={all.length}
        columns={<ColumnChooser allColumns={OPP_COLUMN_ORDER} labels={DRILL_OPP_LABELS} visible={visible} required={["company"]} onToggle={toggle} onMove={stepMove(visible, move)} />} />
      {q.isLoading ? <Loading /> : rows.length === 0 ? <Empty text={all.length ? "Nothing matches these filters." : "No opportunities here."} /> : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-20 bg-surface-2">
              <tr className="text-[10.5px] uppercase tracking-wider text-ink-3">
                {visible.map((k, i) => (
                  <th key={k} className={cn("px-3 py-2 font-semibold", i === 0 && "sticky left-0 z-30 bg-surface-2")}>{DRILL_OPP_LABELS[k]}</th>
                ))}
                {extraHead.map((h) => <th key={h} className="border-l border-border px-3 py-2 font-semibold text-accent-ink">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <DealRow key={o.id} deal={o} visibleCols={visible}
                  isExpanded={expanded === o.id}
                  onToggle={() => setExpanded(expanded === o.id ? null : o.id)}
                  onRecordPlacements={setPlacementDeal} onCommittedRoles={setCommittedDeal} onClosedLost={setLostDeal}
                  extraCells={extra(o.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Hint />
      {placementDeal && <PlacementsModal deal={placementDeal} onClose={() => setPlacementDeal(null)} />}
      {committedDeal && <CommittedRolesModal deal={committedDeal} onClose={() => setCommittedDeal(null)} />}
      {lostDeal && <ClosedLostModal deal={lostDeal} onClose={() => setLostDeal(null)} />}
    </div>
  );
}

function Hint() {
  return (
    <div className="border-t border-border-strong px-4 py-2 text-[11.5px] text-ink-4">
      Click a row for comments, tasks and activity. Stage, owner and other fields edit in place; the chart updates as you go.
    </div>
  );
}
