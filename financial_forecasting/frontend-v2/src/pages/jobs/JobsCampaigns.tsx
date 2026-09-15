/**
 * Jobs · Campaigns.
 *
 * Campaigns as a first-class view rather than a block buried in the Outreach
 * tab. The primitive is unchanged — a campaign is a curated contact tag from
 * `bedrock.contact_tag_catalog`, whose `sort_order` is the outreach priority
 * and whose `owner_email` is the accountable staffer. This page adds the
 * portfolio rollup the embedded list never had: how much of the tagged
 * universe is actually being worked, and which campaigns have nobody on them.
 *
 * Conversion is defined here exactly as the per-campaign row defines it —
 * converted ÷ (contacted + converted) — so the header total and the rows can
 * never tell two different stories.
 */
import { useMemo } from "react";

import { PageHeader } from "@/components/PageHeader";
import { TagCampaigns } from "@/components/jobs/TagCampaigns";
import { useTagCampaigns, type TagCampaign } from "@/services/jobs";
import { cn } from "@/lib/utils";

const EMPTY_FUNNEL = { not_yet: 0, assigned: 0, contacted: 0, converted: 0, on_hold: 0 };

/** Portfolio totals over every campaign. Kept in one place so the strip and
 *  any future export read the same numbers. */
function rollup(camps: TagCampaign[]) {
  let inPipeline = 0;
  let contacted = 0;
  let converted = 0;
  let onHold = 0;
  let unworked = 0;
  for (const c of camps) {
    const f = c.funnel ?? EMPTY_FUNNEL;
    inPipeline += c.in_pipeline ?? 0;
    contacted += f.contacted ?? 0;
    converted += f.converted ?? 0;
    onHold += f.on_hold ?? 0;
    // not_yet (no stage at all) + assigned (claimed, not yet reached) are both
    // "nobody has contacted this person" — the backlog the priority order exists
    // to burn down.
    unworked += (f.not_yet ?? 0) + (f.assigned ?? 0);
  }
  const reached = contacted + converted;
  return {
    campaigns: camps.length,
    inPipeline,
    contacted,
    converted,
    onHold,
    unworked,
    reached,
    // Same 5-record floor as the per-campaign row: below that a percentage is
    // noise dressed up as a signal.
    conversionPct: reached >= 5 ? Math.round((100 * converted) / reached) : null,
    coveragePct: inPipeline > 0 ? Math.round((100 * reached) / inPipeline) : null,
    unowned: camps.filter((c) => !c.owner_email).length,
  };
}

function Stat({ label, value, sub, tone = "ink" }: {
  label: string;
  value: string;
  sub: string;
  tone?: "ink" | "accent" | "green" | "amber";
}) {
  const toneCls = {
    ink: "text-ink",
    accent: "text-accent",
    green: "text-green",
    amber: "text-amber",
  }[tone];
  return (
    <div className="flex flex-col items-start gap-1 rounded-xl border border-border-strong bg-surface px-4 py-3">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>
      <span className={cn("text-[26px] font-semibold leading-none tabular-nums", toneCls)}>{value}</span>
      <span className="text-[11px] leading-snug text-ink-3">{sub}</span>
    </div>
  );
}

export function JobsCampaignsPage() {
  const { data, isLoading } = useTagCampaigns();
  const r = useMemo(() => rollup(data ?? []), [data]);

  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader
        title="Campaigns"
        subtitle="Every contact tag as a prioritized outreach campaign — who owns it, how far it's been worked, and what's left."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Campaigns"
          value={isLoading ? "—" : r.campaigns.toLocaleString()}
          sub={r.unowned > 0 ? `${r.unowned} with no owner` : "all owned"}
          tone={r.unowned > 0 ? "amber" : "ink"}
        />
        <Stat
          label="In pipeline"
          value={isLoading ? "—" : r.inPipeline.toLocaleString()}
          sub="tagged contacts flagged as jobs prospects"
        />
        <Stat
          label="Reached"
          value={isLoading ? "—" : r.reached.toLocaleString()}
          sub={r.coveragePct === null ? "no contacts in pipeline" : `${r.coveragePct}% of the pipeline · ${r.unworked.toLocaleString()} not yet contacted`}
          tone="accent"
        />
        <Stat
          label="Converted"
          value={isLoading ? "—" : r.converted.toLocaleString()}
          sub={r.conversionPct === null ? "too few reached to rate" : `${r.conversionPct}% of those reached`}
          tone={r.converted > 0 ? "green" : "ink"}
        />
      </div>

      <div className="mt-5">
        <TagCampaigns />
      </div>
    </div>
  );
}
