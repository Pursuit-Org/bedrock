/**
 * The campaign pipeline as a Sankey: every contact flows left to right and each
 * column splits the one before it.
 *
 *   All contacts → assigned / not assigned
 *                → contacted / awaiting contact
 *                → converted · call booked · in outreach · revisit · not a fit
 *
 * Why a Sankey rather than a stacked bar or a column flowchart: those show the
 * same seven numbers, but neither shows what splits into what. Ribbon width
 * carries the share, so a branch that collapses between columns is visible
 * without reading a single figure.
 *
 * Layout is recharts', deliberately. It nudges nodes vertically to minimise
 * ribbon crossings, which is why "Assigned" does not sit flush at the top of
 * its column — the position is the library balancing the picture, not the data
 * saying anything. A hand-laid version that pinned the order read worse, so the
 * ordering question is answered by the colours and the labels instead.
 *
 * Zero-value branches are dropped, not drawn at zero height. A campaign with
 * nobody at Revisit should not show a Revisit label attached to an invisible
 * ribbon, and recharts lays out degenerate links badly anyway.
 */
import { useMemo } from "react";
import { Sankey, Tooltip as ReTooltip, ResponsiveContainer, Layer, Rectangle } from "recharts";

import type { TagCampaignStats, MembershipStage } from "@/services/jobs";
import { cn } from "@/lib/utils";

/** Bucket ids double as the filter the detail panel applies to the contact
 *  list, so a label and the rows it opens can never mean different things. */
export type PipelineBucket =
  | "all" | "assigned" | "unassigned" | "contacted" | "awaiting"
  | "converted" | "call_booked" | "in_outreach" | "revisit" | "not_a_fit";

/** Grey means "no progress claimed" — the whole population, and the two
 *  branches that are waiting rather than advancing. Everything representing a
 *  step forward or a decision gets its own hue, so the eye can follow one
 *  outcome from its ribbon to its label. */
const GREY = "#9aa1ab";
const COLORS: Record<PipelineBucket, string> = {
  all: GREY,
  assigned: "#0ea5e9",
  unassigned: GREY,
  contacted: "#4242EA",
  awaiting: GREY,
  converted: "#16a34a",
  call_booked: "#0d9488",
  in_outreach: "#8b5cf6",
  revisit: "#f59e0b",
  not_a_fit: "#fb7185",
};

const LABELS: Record<PipelineBucket, string> = {
  all: "All contacts",
  assigned: "Assigned",
  unassigned: "Not assigned",
  contacted: "Contacted",
  awaiting: "Awaiting contact",
  converted: "Converted to oppty",
  call_booked: "Call booked",
  in_outreach: "In outreach",
  revisit: "Revisit",
  not_a_fit: "Not a fit",
};

export const BUCKET_LABELS = LABELS;

const TERMINALS: { id: PipelineBucket; stage: MembershipStage }[] = [
  { id: "converted", stage: "converted_to_opportunity" },
  { id: "call_booked", stage: "call_booked" },
  { id: "in_outreach", stage: "initial_outreach" },
  { id: "revisit", stage: "revisit" },
  { id: "not_a_fit", stage: "not_a_fit" },
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

/** `bucket` rides on each node so the click handler knows what was clicked —
 *  recharts hands the renderer whatever is on the node object. */
interface SankeyNode { name: string; value: number; bucket: PipelineBucket; color: string }
interface SankeyLink { source: number; target: number; value: number; bucket: PipelineBucket; fill: string }

export function buildPipelineSankey(stats: TagCampaignStats): {
  nodes: SankeyNode[]; links: SankeyLink[];
} | null {
  const counts = pipelineCounts(stats);

  const EDGES: { from: PipelineBucket; to: PipelineBucket }[] = [
    { from: "all", to: "assigned" },
    { from: "all", to: "unassigned" },
    { from: "assigned", to: "contacted" },
    { from: "assigned", to: "awaiting" },
    ...TERMINALS.map((t) => ({ from: "contacted" as PipelineBucket, to: t.id })),
  ];
  const edges = EDGES.filter((e) => counts[e.to] > 0 && counts[e.from] > 0);

  if (edges.length === 0) return null;

  // Only nodes an edge actually touches, indexed in first-seen order so the
  // link indices below stay valid.
  const order: PipelineBucket[] = [];
  const idx = new Map<PipelineBucket, number>();
  const seen = (id: PipelineBucket) => {
    if (!idx.has(id)) { idx.set(id, order.length); order.push(id); }
    return idx.get(id) as number;
  };
  const links = edges.map((e) => ({
    source: seen(e.from),
    target: seen(e.to),
    value: counts[e.to],
    bucket: e.to,
    // The ribbon carries the colour of what it feeds, so an outcome reads as
    // one hue from the split that produced it all the way to its label.
    fill: COLORS[e.to],
  }));
  return {
    nodes: order.map((id) => ({
      name: LABELS[id], value: counts[id], bucket: id, color: COLORS[id],
    })),
    links,
  };
}

type NodePayload = { name?: string; value?: number; bucket?: PipelineBucket; color?: string };

function SankeyNodeShape(props: {
  x?: number; y?: number; width?: number; height?: number;
  payload?: NodePayload; containerWidth?: number;
  selected?: PipelineBucket | null;
  onSelect?: (b: PipelineBucket | null) => void;
}) {
  const {
    x = 0, y = 0, width = 0, height = 0, payload, containerWidth = 0,
    selected = null, onSelect,
  } = props;
  const bucket = payload?.bucket;
  const color = payload?.color ?? GREY;
  const value = payload?.value ?? 0;
  const active = selected !== null && selected === bucket;
  const dim = selected !== null && selected !== "all" && !active;

  // Last column labels to the right of the node; everything else labels above
  // it, where there is no ribbon to collide with.
  const terminal = x + width > containerWidth - 140;
  const labelX = terminal ? x + width + 8 : x;
  const labelY = terminal ? y + height / 2 : y - 6;

  return (
    <Layer
      opacity={dim ? 0.45 : 1}
      className={onSelect ? "cursor-pointer" : undefined}
      onClick={() => bucket && onSelect?.(active ? null : bucket)}
    >
      <Rectangle x={x} y={y} width={width} height={height} fill={color} radius={2} />
      <text
        x={labelX}
        y={labelY}
        textAnchor="start"
        dominantBaseline={terminal ? "middle" : "auto"}
        fontSize={11}
        fill={active ? color : "var(--color-ink-2)"}
        fontWeight={active ? 600 : 400}
        className="select-none"
      >
        {payload?.name}
        <tspan fontWeight={600} dx={6}>{value.toLocaleString()}</tspan>
      </text>
      {/* Generous hit target over the label, so the text is clickable without
          demanding pixel accuracy on a thin node. */}
      <rect
        x={labelX - 3}
        y={terminal ? y + height / 2 - 9 : y - 18}
        width={136}
        height={18}
        fill="transparent"
      />
    </Layer>
  );
}

function SankeyLinkShape(props: {
  sourceX?: number; targetX?: number; sourceY?: number; targetY?: number;
  sourceControlX?: number; targetControlX?: number; linkWidth?: number;
  payload?: { fill?: string; bucket?: PipelineBucket };
  selected?: PipelineBucket | null;
}) {
  const {
    sourceX = 0, targetX = 0, sourceY = 0, targetY = 0,
    sourceControlX = 0, targetControlX = 0, linkWidth = 0, payload, selected = null,
  } = props;
  const dim = selected !== null && selected !== "all" && selected !== payload?.bucket;
  return (
    <path
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      stroke={payload?.fill ?? GREY}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={dim ? 0.1 : 0.32}
      fill="none"
    />
  );
}

export function PipelineSankey({ stats, height = 300, selected, onSelect }: {
  stats: TagCampaignStats;
  height?: number;
  selected: PipelineBucket | null;
  onSelect: (b: PipelineBucket | null) => void;
}) {
  const data = useMemo(() => buildPipelineSankey(stats), [stats]);

  if (!data) {
    return (
      <div className="grid h-[220px] place-items-center rounded-lg border border-dashed border-border-strong text-[12.5px] text-ink-3">
        Nobody in this campaign's pipeline yet.
      </div>
    );
  }
  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={height}>
        <Sankey
          data={data}
          nodeWidth={9}
          nodePadding={18}
          // Right margin holds the terminal labels; top holds the above-node ones.
          margin={{ top: 16, right: 132, bottom: 6, left: 4 }}
          node={<SankeyNodeShape selected={selected} onSelect={onSelect} />}
          link={<SankeyLinkShape selected={selected} />}
        >
          <ReTooltip
            contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }}
          />
        </Sankey>
      </ResponsiveContainer>
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
