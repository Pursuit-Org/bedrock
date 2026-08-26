import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, Search } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { AwardPicker, type AwardOption } from "@/components/ui/AwardPicker";
import { Tag } from "@/components/ui/Tag";
import { ButtonGroup, Toolbar } from "@/components/ui/Toolbar";
import { fmtDate } from "@/lib/format";
import { useAwards } from "@/services/awards";
import {
  useCommitments,
  useCreateCommitment,
  type Commitment,
  type CommitmentStatus,
  type CommitmentType,
} from "@/services/commitments";
import { useOpportunities } from "@/services/opportunities";
import { usePerm } from "@/services/permissions";
import type { SfOpportunity } from "@/types/salesforce";

function statusVariant(s: CommitmentStatus): "green" | "sky" | "amber" | "red" {
  if (s === "complete") return "green";
  if (s === "ahead") return "sky";
  if (s === "under") return "red";
  return "amber"; // on-track
}

function statusLabel(s: CommitmentStatus): string {
  if (s === "on-track") return "On track";
  if (s === "ahead") return "Ahead";
  if (s === "under") return "Under";
  return "Complete";
}

function progressLabel(c: Commitment): string {
  if (c.commitment_type === "quantitative") {
    const target = c.target_value != null ? c.target_value.toLocaleString() : "—";
    const actual = c.latest_value != null ? c.latest_value.toLocaleString() : "0";
    return `${actual} / ${target}${c.target_unit ? ` ${c.target_unit}` : ""}`;
  }
  return c.latest_qualitative_status?.replace(/-/g, " ") ?? "not started";
}

export function CommitmentsPage() {
  const [tier, setTier] = useState<"tracked" | "all">("tracked");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const canManage = usePerm("manage_commitments");

  // Deep-link from AwardDetail's "+ Add commitment" — pre-opens the
  // create dialog with that award already selected instead of making
  // the grant owner search for it again.
  const [searchParams, setSearchParams] = useSearchParams();
  const preselectedAwardId = searchParams.get("award");
  useEffect(() => {
    if (preselectedAwardId) setCreating(true);
  }, [preselectedAwardId]);

  const { data: commitments = [], isLoading } = useCommitments(tier);
  const { data: awardsData } = useAwards();
  const { data: oppsData } = useOpportunities({});

  const oppById = useMemo(() => {
    const m = new Map<string, SfOpportunity>();
    for (const o of oppsData ?? []) m.set(o.Id, o);
    return m;
  }, [oppsData]);

  const awardById = useMemo(() => {
    const m = new Map<string, { id: string; opportunity_id: string }>();
    for (const a of awardsData ?? []) m.set(a.id, a);
    return m;
  }, [awardsData]);

  const awardOptions: AwardOption[] = useMemo(
    () =>
      (awardsData ?? []).map((a) => {
        const opp = oppById.get(a.opportunity_id);
        return {
          value: a.id,
          label: opp?.Name ?? a.opportunity_id,
          sublabel: opp?.Account?.Name ?? undefined,
        };
      }),
    [awardsData, oppById],
  );

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    if (!needle) return commitments;
    return commitments.filter((c) => {
      const award = awardById.get(c.award_id);
      const opp = award ? oppById.get(award.opportunity_id) : undefined;
      return (
        c.title.toLowerCase().includes(needle) ||
        (opp?.Name ?? "").toLowerCase().includes(needle) ||
        (opp?.Account?.Name ?? "").toLowerCase().includes(needle)
      );
    });
  }, [commitments, q, awardById, oppById]);

  const groups = useMemo(() => {
    const byAward = new Map<string, Commitment[]>();
    for (const c of filtered) {
      const arr = byAward.get(c.award_id) ?? [];
      arr.push(c);
      byAward.set(c.award_id, arr);
    }
    return Array.from(byAward.entries())
      .map(([awardId, items]) => {
        const award = awardById.get(awardId);
        const opp = award ? oppById.get(award.opportunity_id) : undefined;
        return {
          awardId,
          oppName: opp?.Name ?? award?.opportunity_id ?? awardId,
          accountName: opp?.Account?.Name ?? null,
          items: items.sort((a, b) => a.deadline.localeCompare(b.deadline)),
        };
      })
      .sort((a, b) => a.oppName.localeCompare(b.oppName));
  }, [filtered, awardById, oppById]);

  return (
    <div className="mx-auto max-w-[1200px] px-7 py-6">
      <PageHeader
        title="Commitments"
        subtitle={
          isLoading
            ? "Loading…"
            : `${filtered.length.toLocaleString()} commitment${filtered.length === 1 ? "" : "s"} across ${groups.length} award${groups.length === 1 ? "" : "s"}`
        }
        actions={
          canManage ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90"
            >
              <Plus size={13} /> New Commitment
            </button>
          ) : undefined
        }
      />

      <Toolbar className="rounded-b-lg border-b">
        <ButtonGroup
          value={tier}
          onChange={(v) => setTier(v as "tracked" | "all")}
          options={[
            { value: "tracked", label: "Tracked" },
            { value: "all", label: "Show reference too" },
          ]}
        />
        <div className="relative">
          <Search
            size={12}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            placeholder="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-56 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
          />
        </div>
      </Toolbar>

      <div className="mt-4 space-y-4">
        {isLoading ? (
          <div className="rounded-lg border border-border-strong bg-surface px-4 py-10 text-center text-[13px] text-ink-3">
            Loading commitments…
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-lg border border-border-strong bg-surface px-4 py-10 text-center text-[13px] text-ink-3">
            {commitments.length === 0
              ? "No commitments logged yet."
              : "No commitments match your search."}
          </div>
        ) : (
          groups.map((g) => <AwardGroup key={g.awardId} group={g} />)
        )}
      </div>

      {creating ? (
        <CreateCommitmentDialog
          awardOptions={awardOptions}
          initialAwardId={preselectedAwardId}
          onClose={() => {
            setCreating(false);
            if (preselectedAwardId) {
              searchParams.delete("award");
              setSearchParams(searchParams, { replace: true });
            }
          }}
        />
      ) : null}
    </div>
  );
}

// ── Award group ───────────────────────────────────────────────────────────

function rollupSummary(items: Commitment[]): string {
  const counts: Record<CommitmentStatus, number> = {
    "on-track": 0,
    ahead: 0,
    under: 0,
    complete: 0,
  };
  for (const c of items) counts[c.status]++;
  const parts: string[] = [];
  if (counts["on-track"]) parts.push(`${counts["on-track"]} on track`);
  if (counts.ahead) parts.push(`${counts.ahead} ahead`);
  if (counts.under) parts.push(`${counts.under} under`);
  if (counts.complete) parts.push(`${counts.complete} complete`);
  return parts.join(", ");
}

function AwardGroup({
  group,
}: {
  group: { awardId: string; oppName: string; accountName: string | null; items: Commitment[] };
}) {
  const tracked = group.items.filter((c) => c.tracking_tier === "tracked").length;
  const reference = group.items.length - tracked;

  return (
    <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border-strong bg-surface-2 px-4 py-2">
        <div className="min-w-0">
          <Link
            to={`/awards/${group.awardId}`}
            className="truncate text-[13.5px] font-semibold text-ink hover:underline"
          >
            {group.oppName}
          </Link>
          {group.accountName ? (
            <span className="ml-1.5 text-[12px] text-ink-3">· {group.accountName}</span>
          ) : null}
        </div>
        <div className="flex-shrink-0 text-[11.5px] text-ink-3">
          {group.items.length} commitment{group.items.length === 1 ? "" : "s"} — {rollupSummary(group.items)}
          {reference > 0 ? (
            <span className="ml-2">
              · {tracked} tracked · {reference} reference
            </span>
          ) : null}
        </div>
      </div>
      <div className="divide-y divide-border-strong">
        {group.items.map((c) => (
          <CommitmentRow key={c.id} commitment={c} />
        ))}
      </div>
    </div>
  );
}

function CommitmentRow({ commitment: c }: { commitment: Commitment }) {
  return (
    <Link
      to={`/commitments/${c.id}`}
      className="flex items-center gap-3 px-4 py-2 hover:bg-surface-2"
    >
      <Tag variant={statusVariant(c.status)}>{statusLabel(c.status)}</Tag>
      <TypeTag type={c.commitment_type} />
      {c.tracking_tier === "reference" ? <Tag>Reference</Tag> : null}
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={c.title}>
        {c.title}
      </span>
      <span className="mono flex-shrink-0 text-[11.5px] text-ink-3">{progressLabel(c)}</span>
      <span className="mono flex-shrink-0 text-[11.5px] text-ink-3">{fmtDate(c.deadline)}</span>
      <span className="flex-shrink-0 truncate text-[11.5px] text-ink-3" style={{ maxWidth: 120 }}>
        {c.owner || "—"}
      </span>
    </Link>
  );
}

function TypeTag({ type }: { type: CommitmentType }) {
  return <Tag>{type === "quantitative" ? "Quant" : "Qual"}</Tag>;
}

// ── Create dialog ─────────────────────────────────────────────────────────

function CreateCommitmentDialog({
  awardOptions,
  initialAwardId,
  onClose,
}: {
  awardOptions: AwardOption[];
  initialAwardId?: string | null;
  onClose: () => void;
}) {
  const createCommitment = useCreateCommitment();
  const [awardId, setAwardId] = useState<string | null>(initialAwardId ?? null);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<CommitmentType>("quantitative");
  const [targetValue, setTargetValue] = useState("");
  const [targetUnit, setTargetUnit] = useState("");
  const [startDate, setStartDate] = useState("");
  const [deadline, setDeadline] = useState("");
  const [contractLanguage, setContractLanguage] = useState("");
  const [deliveryPlan, setDeliveryPlan] = useState("");
  const [owner, setOwner] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!awardId) return setError("Pick which award this commitment belongs to.");
    if (!title.trim()) return setError("Title is required.");
    if (!startDate) return setError("Start date is required.");
    if (!deadline) return setError("Deadline is required.");
    if (type === "quantitative" && !targetValue) {
      return setError("Target is required for a quantitative commitment.");
    }
    try {
      await createCommitment.mutateAsync({
        award_id: awardId,
        commitment_type: type,
        title: title.trim(),
        contract_language: contractLanguage,
        delivery_plan: deliveryPlan,
        target_value: type === "quantitative" ? Number(targetValue) : null,
        target_unit: type === "quantitative" ? targetUnit : null,
        start_date: startDate,
        deadline,
        owner,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create commitment");
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg rounded-lg border border-border-strong bg-surface p-5 shadow-xl">
        <h2 className="text-[15px] font-semibold text-ink">New Commitment</h2>
        <p className="mt-0.5 text-[12px] text-ink-3">
          Pick the award (contract) this obligation was signed under.
        </p>

        <div className="mt-4 space-y-3">
          <Field label="Award / contract">
            <AwardPicker value={awardId} options={awardOptions} onSelect={setAwardId} />
          </Field>

          <Field label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. 50 Builders enrolled"
              className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
            />
          </Field>

          <div className="flex gap-3">
            <Field label="Type" className="flex-1">
              <ButtonGroup
                value={type}
                onChange={(v) => setType(v as CommitmentType)}
                options={[
                  { value: "quantitative", label: "Quantitative" },
                  { value: "qualitative", label: "Qualitative" },
                ]}
              />
            </Field>
          </div>

          {type === "quantitative" ? (
            <div className="flex gap-3">
              <Field label="Target" className="flex-1">
                <input
                  type="number"
                  value={targetValue}
                  onChange={(e) => setTargetValue(e.target.value)}
                  className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
                />
              </Field>
              <Field label="Unit" className="flex-1">
                <input
                  value={targetUnit}
                  onChange={(e) => setTargetUnit(e.target.value)}
                  placeholder="e.g. Builders"
                  className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
                />
              </Field>
            </div>
          ) : null}

          <div className="flex gap-3">
            <Field label="Start date" className="flex-1">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
              />
            </Field>
            <Field label="Deadline" className="flex-1">
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
              />
            </Field>
          </div>

          <Field label="Contract language" hint="Exact wording from the signed contract — quoted verbatim, never paraphrased.">
            <textarea
              value={contractLanguage}
              onChange={(e) => setContractLanguage(e.target.value)}
              rows={2}
              className="w-full resize-y rounded border border-border-strong bg-surface px-3 py-2 text-[13px] italic outline-none focus:border-accent"
            />
          </Field>

          <Field label="Delivery plan" hint="Pursuit's own plan for how we'll deliver — distinct from the contract language above.">
            <textarea
              value={deliveryPlan}
              onChange={(e) => setDeliveryPlan(e.target.value)}
              rows={2}
              className="w-full resize-y rounded border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
            />
          </Field>

          <Field label="Owner">
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
            />
          </Field>
        </div>

        {error ? <p className="mt-3 text-[12px] text-red">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border-strong px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={createCommitment.isPending}
            className="rounded bg-accent px-3 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
          >
            {createCommitment.isPending ? "Creating…" : "Create commitment"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-3">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-[11px] text-ink-4">{hint}</p> : null}
    </div>
  );
}
