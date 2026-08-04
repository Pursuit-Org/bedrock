/**
 * Tag Campaigns — Performance section to prioritize outreach by tag.
 * Lists every tag as a campaign (alumni cohorts merged into "Fellow Alumni")
 * with a funnel bar (untouched → assigned → contacted → converted), contact/
 * account counts, and a staff owner. Drag to reorder priority; the saved order
 * (catalog.sort_order) drives the "Priority" sort on the Contacts page.
 */
import { useEffect, useState } from "react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, GripVertical, Loader2 } from "lucide-react";

import { useTagCampaigns, useSetTagCampaignOrder, useSetCampaignOwner, useStaff,
  useTagCampaignRecords, MEMBERSHIP_STAGE_LABELS,
  type TagCampaign, type MembershipStage } from "@/services/jobs";
import { Link } from "react-router-dom";
import { relDay } from "@/lib/format";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { useSessionState } from "@/lib/useSessionState";
import { cn } from "@/lib/utils";

// Single funnel bar over the IN-PIPELINE contacts only (those with a stage),
// worked-first left→right: converted (green) → contacted (accent) → not-yet-
// contacted (grey, the remaining assigned-but-unworked). Contacts with no
// membership (not in pipeline) are excluded from the bar entirely.
// Disjoint stage buckets over the in-pipeline set, worked-first left→right:
// Converted → Contacted (initial_outreach only) → On hold → Not yet contacted (grey).
const STAGE_LEGEND = [
  { label: "Converted", cls: "bg-green-500" },
  { label: "Contacted", cls: "bg-accent" },
  { label: "On hold", cls: "bg-amber-400" },
  { label: "Assigned", cls: "bg-sky-400" },
  { label: "No stage", cls: "bg-stone-300" },
];
function FunnelBar({ f }: { f: TagCampaign["funnel"] }) {
  // Coalesce each field — a stale cached response may carry an older funnel
  // shape; never let an undefined value crash the bar.
  const n = (v: number | undefined) => v ?? 0;
  const parts = [
    { label: "Converted", cls: "bg-green-500", n: n(f.converted) },
    { label: "Contacted", cls: "bg-accent", n: n(f.contacted) },
    { label: "On hold", cls: "bg-amber-400", n: n(f.on_hold) },
    { label: "Assigned", cls: "bg-sky-400", n: n(f.assigned) },
    { label: "No stage", cls: "bg-stone-300", n: n(f.not_yet) },
  ];
  const d = parts.reduce((s, p) => s + p.n, 0) || 1;
  return (
    <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-surface-2" title={parts.map((p) => `${p.label}: ${p.n.toLocaleString()}`).join("  ·  ")}>
      {parts.map((p) => p.n > 0 && <div key={p.label} className={cn("h-full", p.cls)} style={{ width: `${(100 * p.n) / d}%` }} />)}
    </div>
  );
}

const EMPTY_FUNNEL = { not_yet: 0, assigned: 0, contacted: 0, converted: 0, on_hold: 0 };
type DrillKind = "contacts" | "accounts" | null;

// ── Campaign picker ─────────────────────────────────────────────────────────
/** Which campaigns to show. Empty = all, which is also the reset state, so the
 *  common case needs no selection. Checkbox list rather than a native multi-
 *  select: cmd-clicking options is not a discoverable way to pick "CISO and
 *  Board", and the counts help you decide what's worth looking at. */
function CampaignPicker({ all, selected, onChange }: {
  all: TagCampaign[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = new Set(selected);
  const label = chosen.size === 0
    ? `All campaigns (${all.length})`
    : chosen.size === 1
      ? all.find((c) => chosen.has(c.key))?.label ?? "1 campaign"
      : `${chosen.size} campaigns`;

  const toggle = (key: string) => {
    // With nothing selected every box renders checked ("all"), so the first
    // click has to mean "hide this one": seed from the full list and remove it.
    // Toggling against the empty set did the opposite of what the checkbox
    // showed — you unchecked a box and it became the only one selected.
    const next = chosen.size === 0 ? new Set(all.map((c) => c.key)) : new Set(chosen);
    next.has(key) ? next.delete(key) : next.add(key);
    // Never leave nothing showing: the last checked box won't uncheck, which
    // beats an empty table you can't tell from a broken one.
    if (next.size === 0) return;
    // All selected is the same view as none selected — normalise to "all" so the
    // header stops claiming a filter that isn't narrowing anything.
    onChange(next.size === all.length ? [] : [...next]);
  };

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)}
        title="Choose which campaigns to show"
        className={cn("flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium",
          chosen.size ? "border-accent/40 bg-accent-soft text-accent" : "border-border-strong bg-surface text-ink-2 hover:bg-surface-2")}>
        {label}
        <ChevronDown size={12} />
      </button>
      {open && (
        <>
          {/* Backdrop closes the panel on any outside click. */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-30 mt-1 max-h-[320px] w-[280px] overflow-y-auto rounded-lg border border-border-strong bg-surface p-1 shadow-lg">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[10.5px] font-bold uppercase tracking-wider text-ink-4">Show campaigns</span>
              {chosen.size > 0 && (
                <button type="button" onClick={() => onChange([])}
                  className="text-[11px] font-medium text-accent hover:underline">Show all</button>
              )}
            </div>
            {all.map((c) => (
              <label key={c.key}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12.5px] text-ink hover:bg-surface-2">
                <input type="checkbox" checked={chosen.size === 0 || chosen.has(c.key)}
                  onChange={() => toggle(c.key)} className="accent-[var(--accent)]" />
                <span className="min-w-0 flex-1 truncate" title={c.label}>{c.label}</span>
                <span className="shrink-0 tabular-nums text-[11px] text-ink-4">{c.in_pipeline.toLocaleString()}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ c, rank, staffOptions, drill, onDrill }: {
  c: TagCampaign; rank: number; staffOptions: { value: string; label: string }[];
  drill: DrillKind; onDrill: (d: DrillKind) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.key });
  const setOwner = useSetCampaignOwner();
  const staffName = (email: string | null) => staffOptions.find((s) => s.value === email)?.label ?? email ?? "—";
  const f = c.funnel ?? EMPTY_FUNNEL;   // defensive: stale cache may lack funnel
  const contacted = Math.max(0, f.contacted ?? 0); // initial_outreach only
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("border-b border-border-strong bg-surface text-[12.5px] last:border-b-0",
        isDragging && "relative z-10 rounded shadow-lg ring-1 ring-accent")}
    >
    <div className="flex items-center gap-3 px-3 py-2">
      <button type="button" {...attributes} {...listeners} className="cursor-grab touch-none text-ink-4 hover:text-ink-2 active:cursor-grabbing" aria-label={`Reorder ${c.label}`}><GripVertical size={14} /></button>
      <span className="w-5 text-right font-mono text-[11px] text-ink-4">{rank}</span>
      <span className="w-40 shrink-0 truncate font-medium text-ink" title={c.label}>{c.label}</span>
      {/* single funnel bar over the in-pipeline contacts only */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <FunnelBar f={f} />
        <button type="button"
          onClick={() => onDrill(drill === "contacts" ? null : "contacts")}
          title="List the contacts in this campaign, with who's been contacted and when"
          className={cn("w-24 shrink-0 text-right tabular-nums text-[10.5px] hover:underline",
            drill === "contacts" ? "text-accent" : "text-ink-3 hover:text-accent")}>
          {contacted.toLocaleString()}/{c.in_pipeline.toLocaleString()} in pipe
        </button>
      </div>
      <button type="button"
        onClick={() => onDrill(drill === "accounts" ? null : "accounts")}
        title="List the accounts these contacts sit at"
        className={cn("w-20 shrink-0 text-right tabular-nums hover:underline",
          drill === "accounts" ? "text-accent" : "text-ink-2 hover:text-accent")}>
        {c.accounts.toLocaleString()} <span className="text-ink-4">acct</span>
      </button>
      {/* conversion = converted / (contacted + converted) — where traction is */}
      <span className="w-14 shrink-0 text-right tabular-nums text-[11.5px]"
        title={`${f.converted} converted of ${contacted + (f.converted ?? 0)} contacted`}>
        {contacted + (f.converted ?? 0) >= 5
          ? <span className={cn((f.converted ?? 0) > 0 ? "text-green" : "text-ink-4")}>{Math.round((100 * (f.converted ?? 0)) / (contacted + (f.converted ?? 0)))}%</span>
          : <span className="text-ink-4">—</span>}
      </span>
      {/* owner */}
      <span className="w-36 shrink-0" onClick={(e) => e.stopPropagation()}>
        <InlineSelect<string>
          value={c.owner_email ?? ""}
          options={staffOptions}
          emptyLabel="Set owner"
          renderValue={(v) => { const e = (v || c.owner_email) || null; return <span className={cn("truncate text-[12px]", e ? "text-ink-2" : "text-ink-4")}>{e ? staffName(e) : "Set owner"}</span>; }}
          onSave={(v) => new Promise<void>((res, rej) => setOwner.mutate({ key: c.key, owner_email: v || null }, { onSuccess: () => res(), onError: rej }))}
        />
      </span>
    </div>
    {drill ? <CampaignDrill campaignKey={c.key} kind={drill} label={c.label} /> : null}
    </div>
  );
}

const CAMPAIGN_DRILL_CAP = 10;

/** Contacts or accounts behind a campaign's numbers. The contact list marks who
 *  has actually been reached and when — the whole point of the campaign view is
 *  knowing what's left to work. */
function CampaignDrill({ campaignKey, kind, label }: {
  campaignKey: string; kind: "contacts" | "accounts"; label: string;
}) {
  const { data, isLoading } = useTagCampaignRecords(campaignKey);
  const [showAll, setShowAll] = useState(false);

  if (isLoading) return <div className="px-3 py-2.5 text-[12px] text-ink-3">Loading…</div>;

  const rows = kind === "contacts" ? (data?.contacts ?? []) : (data?.accounts ?? []);
  const shown = showAll ? rows : rows.slice(0, CAMPAIGN_DRILL_CAP);
  if (rows.length === 0)
    return <div className="px-3 py-2.5 text-[12px] text-ink-4">Nothing in the pipeline for {label} yet.</div>;

  return (
    <div className="border-t border-border-strong bg-surface-2/40 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          {label} · {kind === "contacts" ? "contacts in pipeline" : "accounts"}
        </span>
        <span className="text-[11px] tabular-nums text-ink-4">{rows.length}</span>
      </div>
      <div className="overflow-hidden rounded border border-border-strong bg-surface">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-surface-2/60 text-left text-[10.5px] uppercase tracking-wider text-ink-3">
              {kind === "contacts" ? (
                <>
                  <th className="px-3 py-1.5 font-semibold">Contact</th>
                  <th className="px-2 py-1.5 font-semibold">Company</th>
                  <th className="px-2 py-1.5 font-semibold">Reached</th>
                  <th className="px-2 py-1.5 font-semibold">When</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Touches</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Last touch</th>
                </>
              ) : (
                <>
                  <th className="px-3 py-1.5 font-semibold">Account</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Contacts</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Reached</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {kind === "contacts"
              ? (shown as NonNullable<typeof data>["contacts"]).map((r) => {
                  // "Reached" = past the assigned queue. Anyone still unstaged or
                  // merely assigned has not been contacted yet.
                  const reached = r.stage === "initial_outreach" || r.stage === "converted_to_opportunity";
                  return (
                    <tr key={r.contact_id} className="border-t border-border-strong">
                      <td className="px-3 py-1.5">
                        <Link to={`/jobs/contacts/${r.contact_id}`}
                          className="font-medium text-ink hover:text-accent hover:underline">
                          {r.full_name ?? "—"}
                        </Link>
                      </td>
                      <td className="px-2 py-1.5 truncate text-ink-2">{r.company ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        <span className={cn("rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold",
                          reached ? "bg-green-soft text-green" : "bg-surface-2 text-ink-3")}>
                          {r.stage ? (MEMBERSHIP_STAGE_LABELS[r.stage as MembershipStage] ?? r.stage) : "Not yet"}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-ink-3">{relDay(r.stage_entered_at) ?? "—"}</td>
                      <td className={cn("px-2 py-1.5 text-right tabular-nums", r.touches > 0 ? "text-ink-2" : "text-ink-4")}>
                        {r.touches}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink-4">{relDay(r.last_touch) ?? "—"}</td>
                    </tr>
                  );
                })
              : (shown as NonNullable<typeof data>["accounts"]).map((a) => (
                  <tr key={a.company} className="border-t border-border-strong">
                    <td className="px-3 py-1.5">
                      <Link to={`/jobs/accounts?q=${encodeURIComponent(a.company)}`}
                        className="font-medium text-ink hover:text-accent hover:underline">
                        {a.company}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">{a.contacts}</td>
                    <td className={cn("px-2 py-1.5 text-right tabular-nums", a.contacted > 0 ? "text-green" : "text-ink-4")}>
                      {a.contacted}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {rows.length > shown.length ? (
          <button type="button" onClick={() => setShowAll(true)}
            className="w-full border-t border-border-strong px-3 py-1.5 text-[11.5px] font-medium text-accent hover:bg-surface-2">
            Show all {rows.length}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function TagCampaigns() {
  const { data, isLoading } = useTagCampaigns();
  const { data: staff = [] } = useStaff();
  const save = useSetTagCampaignOrder();
  const [items, setItems] = useState<TagCampaign[]>([]);
  // One drill open at a time — two expanded tables at this row height turns
  // the list into a wall.
  const [openDrill, setOpenDrill] = useState<{ key: string; kind: "contacts" | "accounts" } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const staffOptions = [{ value: "", label: "— none —" }, ...staff.map((s) => ({ value: s.email, label: s.name }))];
  // Empty = show everything. Survives navigating away and back, since "only CISO
  // and Board" is a lens you keep for a whole review, not a single glance.
  const [picked, setPicked] = useSessionState<string[]>("jobsOutreach.campaigns.picked", []);
  const pickedSet = new Set(picked);
  // Rows to render. Ranks and reordering still index the FULL list below, so a
  // drag while filtered can never renumber or reshuffle the hidden campaigns.
  const visible = pickedSet.size === 0 ? items : items.filter((i) => pickedSet.has(i.key));

  // Sync from server WITHOUT clobbering an in-progress reorder: adopt the
  // server order only on first load or when the set of campaigns changes;
  // otherwise keep the current (possibly just-dragged) order and only refresh
  // each row's counts. Prevents the drag from snapping back after save.
  useEffect(() => {
    if (!data) return;
    setItems((prev) => {
      const prevKeys = new Set(prev.map((i) => i.key));
      const sameSet = prev.length === data.length && data.every((i) => prevKeys.has(i.key));
      if (prev.length && sameSet) {
        const byKey = Object.fromEntries(data.map((i) => [i.key, i]));
        return prev.map((i) => byKey[i.key] ?? i);   // keep order, refresh counts
      }
      return data;                                    // first load / set changed
    });
  }, [data]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.key === active.id);
    const to = items.findIndex((i) => i.key === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(items, from, to);
    setItems(next);
    save.mutate(next.map((i) => i.key));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Campaigns · outreach priority</span>
        <CampaignPicker all={items} selected={picked} onChange={setPicked} />
        {save.isPending && <Loader2 size={12} className="animate-spin text-ink-4" />}
        {/* Only speaks up when a filter is on, where "3 of 5" is the one thing
            the header can't otherwise tell you. The drag/legend explainer was
            standing instructions for a control you can just use. */}
        {pickedSet.size ? (
          <span className="text-[11px] text-ink-4">
            {visible.length} of {items.length} shown · # is the true priority rank
          </span>
        ) : null}
        {/* legend (stage funnel) */}
        <span className="ml-auto flex items-center gap-3 text-[10.5px] text-ink-4">
          {STAGE_LEGEND.map((s) => <span key={s.label} className="flex items-center gap-1"><span className={cn("inline-block h-2.5 w-2.5 rounded-sm", s.cls)} />{s.label}</span>)}
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border-strong">
        <div className="flex items-center gap-3 border-b border-border-strong bg-surface-2 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          <span className="w-[14px]" /><span className="w-5 text-right">#</span>
          <span className="w-40 shrink-0">Campaign</span>
          <span className="min-w-0 flex-1">Pipeline funnel (in-pipeline only)</span>
          <span className="w-20 shrink-0 text-right">Accounts</span>
          <span className="w-14 shrink-0 text-right" title="converted ÷ contacted">Conv.</span>
          <span className="w-36 shrink-0">Owner</span>
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-ink-3"><Loader2 size={14} className="animate-spin" /> Loading campaigns…</div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={visible.map((i) => i.key)} strategy={verticalListSortingStrategy}>
              {visible.map((c) => (
                <Row key={c.key} c={c} rank={items.findIndex((i) => i.key === c.key) + 1} staffOptions={staffOptions}
                  drill={openDrill?.key === c.key ? openDrill.kind : null}
                  onDrill={(d) => setOpenDrill(d ? { key: c.key, kind: d } : null)} />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
