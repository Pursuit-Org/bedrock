/**
 * The campaign pipeline as a Sankey: every pipeline contact flows left to right
 * and each column splits the one before it.
 *
 *   In pipeline → contacted / not yet contacted → the stage each one is at
 *
 * The buckets and their counts are campaignBuckets.ts (PRO-100): "contacted"
 * is the campaign row's and the Activation card's rule, so the three agree.
 * Both branches feed the stage nodes, because stage and contact don't move
 * together: a contact can be ruled out without a word, or worked and still be
 * at Assigned.
 *
 * Why a Sankey rather than a stacked bar or a column flowchart: those show the
 * same numbers, but neither shows what splits into what. Ribbon width carries
 * the share, so a branch that collapses between columns is visible without
 * reading a single figure.
 *
 * Layout is recharts', deliberately. It nudges nodes vertically to minimise
 * ribbon crossings, so a node's position is the library balancing the
 * picture, not the data saying anything; the ordering question is answered by
 * the colours and the labels instead.
 *
 * Zero-value branches are dropped, not drawn at zero height. A campaign with
 * nobody at Revisit should not show a Revisit label attached to an invisible
 * ribbon, and recharts lays out degenerate links badly anyway.
 */
import { useMemo } from "react";
import { Sankey, Tooltip as ReTooltip, ResponsiveContainer, Layer, Rectangle } from "recharts";

import type { TagCampaignStats } from "@/services/jobs";
import {
  BUCKET_LABELS, pipelineCounts, pipelineLinks, type PipelineBucket,
} from "@/components/jobs/campaignBuckets";
import { cn } from "@/lib/utils";

export { BUCKET_LABELS, inBucket, type PipelineBucket } from "@/components/jobs/campaignBuckets";

/** Grey means "no progress claimed": the whole population, the branch nobody
 *  has contacted, and the queue still waiting at Assigned. Everything that is
 *  a step forward or a decision gets its own hue, so the eye can follow one
 *  outcome from its ribbon to its label. */
const GREY = "#9aa1ab";
const COLORS: Record<PipelineBucket, string> = {
  all: GREY,
  contacted: "#4242EA",
  not_contacted: GREY,
  assigned: "#0ea5e9",
  initial_outreach: "#8b5cf6",
  scheduling: "#2dd4bf",
  call_booked: "#0d9488",
  converted_to_opportunity: "#16a34a",
  revisit: "#f59e0b",
  not_a_fit: "#fb7185",
};

/** `bucket` rides on each node so the click handler knows what was clicked —
 *  recharts hands the renderer whatever is on the node object. */
interface SankeyNode { name: string; value: number; bucket: PipelineBucket; color: string }
interface SankeyLink { source: number; target: number; value: number; bucket: PipelineBucket; fill: string }

export function buildPipelineSankey(stats: TagCampaignStats): {
  nodes: SankeyNode[]; links: SankeyLink[];
} | null {
  const counts = pipelineCounts(stats.totals);
  const edges = pipelineLinks(stats.totals);
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
    value: e.value,
    bucket: e.to,
    // The ribbon carries the colour of what it feeds, so an outcome reads as
    // one hue from the split that produced it all the way to its label.
    fill: COLORS[e.to],
  }));
  return {
    nodes: order.map((id) => ({
      name: BUCKET_LABELS[id], value: counts[id], bucket: id, color: COLORS[id],
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
