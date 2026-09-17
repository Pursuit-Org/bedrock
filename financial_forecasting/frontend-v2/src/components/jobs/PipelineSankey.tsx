/**
 * The campaign pipeline as a Sankey, laid out by hand rather than by recharts.
 *
 *   All contacts → assigned / not assigned
 *                → contacted / awaiting contact
 *                → converted · call booked · in outreach · revisit · not a fit
 *
 * Why not recharts' Sankey: it runs a crossing-minimisation pass that nudges
 * nodes vertically and gives no way to pin their order, so "Assigned" floated
 * to the middle of the column while the dead-end branch beside it drifted. In a
 * funnel the ordering IS the message — the branch that keeps moving belongs on
 * top, the ones that stop belong below it — so the layout is deterministic here
 * and children are stacked in declared order, anchored to their parent's band.
 *
 * Every node is a tree node with exactly one parent, which is what makes the
 * layout a single pass: a node's height is its value, and its children stack
 * inside that height starting at its top edge. A branch that terminates early
 * simply leaves the columns to its right empty, which is the shape of the
 * funnel rather than a gap in it.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { TagCampaignStats } from "@/services/jobs";
import { cn } from "@/lib/utils";

/** Bucket ids double as the filter the detail panel applies to the contact
 *  list, so a label and the rows it opens can never mean different things. */
export type PipelineBucket =
  | "all" | "assigned" | "unassigned" | "contacted" | "awaiting"
  | "converted" | "call_booked" | "in_outreach" | "revisit" | "not_a_fit";

interface NodeDef {
  id: PipelineBucket;
  label: string;
  parent: PipelineBucket | null;
  /** Node fill. Grey means "no progress claimed": the whole population, and the
   *  two branches that are waiting rather than advancing. Everything that
   *  represents a step forward or a decision gets its own hue. */
  color: string;
}

const GREY = "#9aa1ab";
const NODES: NodeDef[] = [
  { id: "all", label: "All contacts", parent: null, color: GREY },
  { id: "assigned", label: "Assigned", parent: "all", color: "#0ea5e9" },
  { id: "unassigned", label: "Not assigned", parent: "all", color: GREY },
  { id: "contacted", label: "Contacted", parent: "assigned", color: "#4242EA" },
  { id: "awaiting", label: "Awaiting contact", parent: "assigned", color: GREY },
  { id: "converted", label: "Converted to oppty", parent: "contacted", color: "#16a34a" },
  { id: "call_booked", label: "Call booked", parent: "contacted", color: "#0d9488" },
  { id: "in_outreach", label: "In outreach", parent: "contacted", color: "#8b5cf6" },
  { id: "revisit", label: "Revisit", parent: "contacted", color: "#f59e0b" },
  { id: "not_a_fit", label: "Not a fit", parent: "contacted", color: "#fb7185" },
];

/** Counts per bucket, derived once so the chart and the detail panel agree. */
export function pipelineCounts(stats: TagCampaignStats): Record<PipelineBucket, number> {
  const st = stats.totals.stages;
  const all = stats.totals.in_pipeline;
  const unassigned = stats.totals.no_stage;
  const assigned = Math.max(0, all - unassigned);
  const awaiting = st.assigned ?? 0;
  return {
    all,
    assigned,
    unassigned,
    contacted: Math.max(0, assigned - awaiting),
    awaiting,
    converted: st.converted_to_opportunity ?? 0,
    call_booked: st.call_booked ?? 0,
    in_outreach: st.initial_outreach ?? 0,
    revisit: st.revisit ?? 0,
    not_a_fit: st.not_a_fit ?? 0,
  };
}

interface Placed extends NodeDef {
  value: number; depth: number; x: number; y: number; h: number;
}

const NODE_W = 10;
const GAP = 5;          // between siblings
const LABEL_W = 132;    // room for the rightmost column's labels
const PAD_Y = 16;
/** Floor on a node's drawn height — a 4-of-449 branch would otherwise be a
 *  hairline, and an invisible branch reads as a missing one. */
const MIN_H = 3;

function layout(counts: Record<PipelineBucket, number>, width: number, height: number) {
  // Drop empty buckets, and any node orphaned by a dropped parent. A campaign
  // with nobody at Revisit should show no Revisit label, not one attached to a
  // zero-height ribbon.
  const live = new Map<PipelineBucket, NodeDef>();
  for (const n of NODES) {
    if (counts[n.id] <= 0) continue;
    if (n.parent && !live.has(n.parent)) continue;
    live.set(n.id, n);
  }
  if (!live.has("all")) return null;

  const childrenOf = (id: PipelineBucket) => NODES.filter((n) => n.parent === id && live.has(n.id));
  const depthOf = (n: NodeDef): number => (n.parent ? depthOf(NODES.find((x) => x.id === n.parent) as NodeDef) + 1 : 0);
  const leaves = [...live.values()].filter((n) => childrenOf(n.id).length === 0).length;
  const maxDepth = Math.max(...[...live.values()].map(depthOf));

  const usableH = Math.max(40, height - PAD_Y * 2 - Math.max(0, leaves - 1) * GAP);
  const scale = usableH / Math.max(1, counts.all);
  const colStep = maxDepth > 0 ? (width - LABEL_W - NODE_W) / maxDepth : 0;

  const placed: Placed[] = [];
  const place = (n: NodeDef, top: number) => {
    const d = depthOf(n);
    const h = Math.max(MIN_H, counts[n.id] * scale);
    placed.push({ ...n, value: counts[n.id], depth: d, x: d * colStep, y: top, h });
    let cursor = top;
    for (const c of childrenOf(n.id)) {
      place(c, cursor);
      cursor += Math.max(MIN_H, counts[c.id] * scale) + GAP;
    }
  };
  place(live.get("all") as NodeDef, PAD_Y);

  const byId = new Map(placed.map((p) => [p.id, p]));
  const ribbons = placed
    .filter((p) => p.parent)
    .map((p) => ({ id: p.id, from: byId.get(p.parent as PipelineBucket) as Placed, to: p }));

  return { placed, ribbons, maxDepth };
}

/** Width from the DOM, height fixed by the caller — the chart has to fill the
 *  card it sits in, and the card's width is whatever the grid gives it. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function PipelineSankey({ stats, height = 300, selected, onSelect }: {
  stats: TagCampaignStats;
  height?: number;
  selected: PipelineBucket | null;
  onSelect: (b: PipelineBucket | null) => void;
}) {
  const [ref, width] = useWidth();
  const counts = useMemo(() => pipelineCounts(stats), [stats]);
  const model = useMemo(
    () => (width > 260 ? layout(counts, width, height) : null),
    [counts, width, height],
  );

  return (
    <div ref={ref} className="w-full">
      {counts.all === 0 ? (
        <div className="grid h-[220px] place-items-center rounded-lg border border-dashed border-border-strong text-[12.5px] text-ink-3">
          Nobody in this campaign's pipeline yet.
        </div>
      ) : !model ? (
        <div style={{ height }} />
      ) : (
        <svg width={width} height={height} role="img" aria-label="Campaign pipeline">
          {model.ribbons.map(({ id, from, to }) => {
            const x1 = from.x + NODE_W;
            const x2 = to.x;
            const mid = (x1 + x2) / 2;
            // Ribbon spans the child's full height on both ends: each child has
            // exactly one parent, so there is nothing to apportion.
            const d = `M${x1},${to.y} C${mid},${to.y} ${mid},${to.y} ${x2},${to.y}
                       L${x2},${to.y + to.h} C${mid},${to.y + to.h} ${mid},${to.y + to.h} ${x1},${to.y + to.h} Z`;
            const dim = selected !== null && selected !== "all" && selected !== id;
            return (
              <path key={id} d={d} fill={to.color} opacity={dim ? 0.12 : 0.28} />
            );
          })}
          {model.placed.map((n) => {
            const terminal = n.depth === model.maxDepth;
            const active = selected === n.id;
            const dim = selected !== null && selected !== "all" && !active;
            const labelX = terminal ? n.x + NODE_W + 8 : n.x;
            const labelY = terminal ? n.y + n.h / 2 : n.y - 6;
            return (
              <g
                key={n.id}
                onClick={() => onSelect(active ? null : n.id)}
                className="cursor-pointer"
                opacity={dim ? 0.45 : 1}
              >
                <rect x={n.x} y={n.y} width={NODE_W} height={n.h} fill={n.color} rx={2} />
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor="start"
                  dominantBaseline={terminal ? "middle" : "auto"}
                  fontSize={11}
                  fill={active ? n.color : "var(--color-ink-2)"}
                  fontWeight={active ? 600 : 400}
                  className="select-none"
                >
                  {n.label}
                  <tspan fontWeight={600} dx={6}>{n.value.toLocaleString()}</tspan>
                </text>
                {/* Generous hit target over the label, so the text is clickable
                    without demanding pixel accuracy. */}
                <rect
                  x={labelX - 2}
                  y={terminal ? n.y + n.h / 2 - 9 : n.y - 18}
                  width={LABEL_W}
                  height={18}
                  fill="transparent"
                />
              </g>
            );
          })}
        </svg>
      )}
      <p className={cn("mt-1 text-[11px]", selected ? "text-accent" : "text-ink-4")}>
        {selected ? "Showing that bucket — click it again to clear" : "Click a label to list its contacts"}
      </p>
    </div>
  );
}

/** Which contacts belong to a bucket, given a membership stage. Mirrors
 *  pipelineCounts exactly, so a label's number and its list always match. */
export function inBucket(bucket: PipelineBucket, stage: string | null): boolean {
  switch (bucket) {
    case "all": return true;
    case "unassigned": return stage === null;
    case "assigned": return stage !== null;
    case "awaiting": return stage === "assigned";
    case "contacted": return stage !== null && stage !== "assigned";
    case "converted": return stage === "converted_to_opportunity";
    case "call_booked": return stage === "call_booked";
    case "in_outreach": return stage === "initial_outreach";
    case "revisit": return stage === "revisit" || stage === "on_hold";
    case "not_a_fit": return stage === "not_a_fit";
  }
}

export const BUCKET_LABELS: Record<PipelineBucket, string> =
  Object.fromEntries(NODES.map((n) => [n.id, n.label])) as Record<PipelineBucket, string>;
