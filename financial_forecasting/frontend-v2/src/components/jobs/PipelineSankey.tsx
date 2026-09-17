/**
 * The campaign pipeline as a Sankey: every contact flows left to right and each
 * column splits the one before it.
 *
 *   All contacts → assigned / not assigned
 *                → contacted / awaiting contact
 *                → converted · call booked · in outreach · revisit · not a fit
 *
 * Why a Sankey rather than the stacked bar or the column flowchart it replaces:
 * both showed the same seven numbers, but neither showed what splits into what.
 * Ribbon width carries the share, so a branch that collapses between columns is
 * visible without reading a single figure.
 *
 * Zero-value branches are dropped, not drawn at zero height. A campaign with
 * nobody at Revisit should not show a Revisit label attached to an invisible
 * ribbon, and recharts lays out degenerate links badly anyway.
 */
import { useMemo } from "react";
import { Sankey, Tooltip as ReTooltip, ResponsiveContainer, Layer, Rectangle } from "recharts";

import type { TagCampaignStats, MembershipStage } from "@/services/jobs";

const NODE_FILL = "#6b7280";      // slate — the reference's neutral node
const LINK_GREY = "#c9cdd3";
const LINK_GREEN = "#7ac9ae";
const LINK_TEAL = "#9dd8d0";
const LINK_ROSE = "#f0b9b9";

interface SankeyNode { name: string; value: number }
interface SankeyLink { source: number; target: number; value: number; fill: string }

/** Node ids in flow order. Terminal nodes carry the colour that survives into
 *  the ribbon feeding them, so the eye follows one hue end to end. */
const TERMINALS: { id: string; stage: MembershipStage; name: string; fill: string }[] = [
  { id: "converted", stage: "converted_to_opportunity", name: "Converted to oppty", fill: LINK_GREEN },
  { id: "call_booked", stage: "call_booked", name: "Call booked", fill: LINK_TEAL },
  { id: "in_outreach", stage: "initial_outreach", name: "In outreach", fill: LINK_GREY },
  { id: "revisit", stage: "revisit", name: "Revisit", fill: LINK_GREY },
  { id: "not_a_fit", stage: "not_a_fit", name: "Not a fit", fill: LINK_ROSE },
];

export function buildPipelineSankey(stats: TagCampaignStats): {
  nodes: SankeyNode[]; links: SankeyLink[];
} | null {
  const st = stats.totals.stages;
  const total = stats.totals.in_pipeline;
  const notAssigned = stats.totals.no_stage;
  const assigned = Math.max(0, total - notAssigned);
  const awaiting = st.assigned ?? 0;
  const contacted = Math.max(0, assigned - awaiting);

  const names: Record<string, string> = {
    all: "All contacts",
    assigned: "Assigned",
    unassigned: "Not assigned",
    contacted: "Contacted",
    awaiting: "Awaiting contact",
    ...Object.fromEntries(TERMINALS.map((t) => [t.id, t.name])),
  };

  const edges: { from: string; to: string; value: number; fill: string }[] = [
    { from: "all", to: "assigned", value: assigned, fill: LINK_GREY },
    { from: "all", to: "unassigned", value: notAssigned, fill: LINK_GREY },
    { from: "assigned", to: "contacted", value: contacted, fill: LINK_GREY },
    { from: "assigned", to: "awaiting", value: awaiting, fill: LINK_GREY },
    ...TERMINALS.map((t) => ({
      from: "contacted", to: t.id, value: st[t.stage] ?? 0, fill: t.fill,
    })),
  ].filter((e) => e.value > 0);

  if (edges.length === 0) return null;

  // Only nodes an edge actually touches, indexed in first-seen order so the
  // link indices below stay valid.
  const order: string[] = [];
  const idx = new Map<string, number>();
  const seen = (id: string) => {
    if (!idx.has(id)) { idx.set(id, order.length); order.push(id); }
    return idx.get(id) as number;
  };
  const links = edges.map((e) => ({
    source: seen(e.from), target: seen(e.to), value: e.value, fill: e.fill,
  }));
  const totals: Record<string, number> = {
    all: total, assigned, unassigned: notAssigned, contacted, awaiting,
    ...Object.fromEntries(TERMINALS.map((t) => [t.id, st[t.stage] ?? 0])),
  };
  return { nodes: order.map((id) => ({ name: names[id], value: totals[id] ?? 0 })), links };
}

/** recharts hands the renderer geometry plus the laid-out node. `depth` is the
 *  column, which is all we need to decide which side the label sits on. */
function SankeyNodeShape(props: {
  x?: number; y?: number; width?: number; height?: number;
  index?: number; payload?: { name?: string; value?: number; depth?: number };
  containerWidth?: number;
}) {
  const { x = 0, y = 0, width = 0, height = 0, payload, containerWidth = 0 } = props;
  const name = payload?.name ?? "";
  const value = payload?.value ?? 0;
  // Last column labels to the right of the node; everything else labels above
  // it, where there is no ribbon to collide with.
  const isTerminal = x + width > containerWidth - 140;
  return (
    <Layer>
      <Rectangle x={x} y={y} width={width} height={height} fill={NODE_FILL} radius={1} />
      {isTerminal ? (
        <text x={x + width + 8} y={y + height / 2} textAnchor="start" dominantBaseline="middle"
          fontSize={11} fill="var(--color-ink-2)">
          {name}
          <tspan fontWeight={600} dx={6}>{value.toLocaleString()}</tspan>
        </text>
      ) : (
        <text x={x} y={y - 5} textAnchor="start" fontSize={11} fill="var(--color-ink-2)">
          {name}
          <tspan fontWeight={600} dx={6}>{value.toLocaleString()}</tspan>
        </text>
      )}
    </Layer>
  );
}

function SankeyLinkShape(props: {
  sourceX?: number; targetX?: number; sourceY?: number; targetY?: number;
  sourceControlX?: number; targetControlX?: number; linkWidth?: number;
  payload?: { fill?: string };
}) {
  const {
    sourceX = 0, targetX = 0, sourceY = 0, targetY = 0,
    sourceControlX = 0, targetControlX = 0, linkWidth = 0, payload,
  } = props;
  return (
    <path
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      stroke={payload?.fill ?? LINK_GREY}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={0.75}
      fill="none"
    />
  );
}

export function PipelineSankey({ stats, height = 300 }: {
  stats: TagCampaignStats;
  height?: number;
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
    <ResponsiveContainer width="100%" height={height}>
      <Sankey
        data={data}
        nodeWidth={9}
        nodePadding={18}
        // Right margin holds the terminal labels; top holds the above-node ones.
        margin={{ top: 16, right: 132, bottom: 6, left: 4 }}
        node={<SankeyNodeShape />}
        link={<SankeyLinkShape />}
      >
        <ReTooltip
          contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-border)" }}
        />
      </Sankey>
    </ResponsiveContainer>
  );
}
