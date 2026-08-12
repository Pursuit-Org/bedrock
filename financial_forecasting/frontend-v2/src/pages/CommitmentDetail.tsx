import { useState } from "react";
import { useParams } from "react-router-dom";
import { Trash2 } from "lucide-react";

import { BackLink as SharedBackLink } from "@/components/detail";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { Tag } from "@/components/ui/Tag";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  useCommitment,
  useCommitmentLog,
  useCreateProgressLog,
  useDeleteProgressLog,
  useUpdateCommitment,
  type CommitmentStatus,
  type CommitmentType,
  type QualitativeStatus,
  type TrackingTier,
} from "@/services/commitments";
import { usePerm } from "@/services/permissions";

function statusVariant(s: CommitmentStatus): "green" | "sky" | "amber" | "red" {
  if (s === "complete") return "green";
  if (s === "ahead") return "sky";
  if (s === "under") return "red";
  return "amber";
}

function statusLabel(s: CommitmentStatus): string {
  if (s === "on-track") return "On track";
  if (s === "ahead") return "Ahead";
  if (s === "under") return "Under";
  return "Complete";
}

const TIER_OPTIONS: { value: TrackingTier; label: string }[] = [
  { value: "tracked", label: "Tracked" },
  { value: "reference", label: "Reference" },
];

const QUAL_STATUS_OPTIONS: { value: QualitativeStatus; label: string }[] = [
  { value: "not-started", label: "Not started" },
  { value: "in-progress", label: "In progress" },
  { value: "met", label: "Met" },
  { value: "not-met", label: "Not met" },
  { value: "pending-verification", label: "Pending verification" },
];

function BackLink() {
  return <SharedBackLink defaultTo="/commitments" defaultLabel="Commitments" />;
}

export function CommitmentDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { data: commitment, isLoading } = useCommitment(id);
  const canManage = usePerm("manage_commitments");
  const updateCommitment = useUpdateCommitment();

  if (isLoading || !commitment) {
    return (
      <div className="mx-auto max-w-[900px] px-7 py-6">
        <BackLink />
        <div className="mt-6 rounded-lg border border-border-strong bg-surface p-10 text-center text-[13px] text-ink-3 shadow-sm">
          {isLoading ? "Loading commitment…" : "Commitment not found."}
        </div>
      </div>
    );
  }

  const patch = (p: Record<string, unknown>) =>
    updateCommitment.mutateAsync({ id: commitment.id, patch: p }).then(() => undefined);

  return (
    <div className="mx-auto max-w-[900px] px-7 py-6 pb-20">
      <BackLink />

      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Tag variant={statusVariant(commitment.status)}>{statusLabel(commitment.status)}</Tag>
          <Tag>{commitment.commitment_type === "quantitative" ? "Quantitative" : "Qualitative"}</Tag>
          {canManage ? (
            <InlineSelect
              value={commitment.tracking_tier}
              options={TIER_OPTIONS}
              onSave={(v) => patch({ tracking_tier: v })}
              renderValue={(v) => <Tag>{v === "reference" ? "Reference" : "Tracked"}</Tag>}
            />
          ) : commitment.tracking_tier === "reference" ? (
            <Tag>Reference</Tag>
          ) : null}
        </div>

        <h1 className="mt-2 text-[22px] font-bold leading-tight tracking-tight text-ink">
          {canManage ? (
            <InlineText value={commitment.title} onSave={(v) => patch({ title: v })} className="text-[22px] font-bold" />
          ) : (
            commitment.title
          )}
        </h1>

        {commitment.opportunity_name || commitment.account_name ? (
          <a
            href={`/awards/${commitment.award_id}`}
            className="mt-1 inline-block text-[12.5px] text-ink-3 underline-offset-4 hover:underline"
          >
            {commitment.opportunity_name}
            {commitment.account_name ? ` · ${commitment.account_name}` : ""}
          </a>
        ) : null}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Section title="Contract language">
            <p className="whitespace-pre-wrap text-[13px] italic text-ink-2">
              {commitment.contract_language || (
                <span className="text-ink-4">No contract language recorded.</span>
              )}
            </p>
          </Section>

          <Section title="Delivery plan">
            {canManage ? (
              <textarea
                defaultValue={commitment.delivery_plan}
                onBlur={(e) => {
                  if (e.target.value !== commitment.delivery_plan) {
                    patch({ delivery_plan: e.target.value });
                  }
                }}
                rows={4}
                placeholder="Pursuit's own plan for delivering on this commitment…"
                className="w-full resize-y rounded border border-border-strong bg-surface px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent"
              />
            ) : (
              <p className="whitespace-pre-wrap text-[13px] text-ink-2">
                {commitment.delivery_plan || <span className="text-ink-4">No delivery plan yet.</span>}
              </p>
            )}
          </Section>

          <Section title="Progress log" flush>
            <ProgressLogPanel commitmentId={commitment.id} awardId={commitment.award_id} type={commitment.commitment_type} canManage={canManage} />
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Details">
            <dl className="space-y-2 text-[12px]">
              <Row label="Target">
                <span className="mono text-ink-2">
                  {commitment.commitment_type === "quantitative"
                    ? `${commitment.latest_value ?? 0} / ${commitment.target_value ?? "—"}${commitment.target_unit ? ` ${commitment.target_unit}` : ""}`
                    : (commitment.latest_qualitative_status ?? "not-started").replace(/-/g, " ")}
                </span>
              </Row>
              <Row label="Start date">
                {canManage ? (
                  <InlineDate value={commitment.start_date} onSave={(v) => patch({ start_date: v })} />
                ) : (
                  <span className="mono text-ink-2">{fmtDate(commitment.start_date)}</span>
                )}
              </Row>
              <Row label="Deadline">
                {canManage ? (
                  <InlineDate value={commitment.deadline} onSave={(v) => patch({ deadline: v })} />
                ) : (
                  <span className="mono text-ink-2">{fmtDate(commitment.deadline)}</span>
                )}
              </Row>
              <Row label="Owner">
                {canManage ? (
                  <InlineText value={commitment.owner} onSave={(v) => patch({ owner: v })} />
                ) : (
                  <span className="text-ink-2">{commitment.owner || "—"}</span>
                )}
              </Row>
            </dl>
          </Section>

          <Section title="Notes">
            {canManage ? (
              <textarea
                defaultValue={commitment.notes ?? ""}
                onBlur={(e) => {
                  if (e.target.value !== (commitment.notes ?? "")) {
                    patch({ notes: e.target.value });
                  }
                }}
                rows={5}
                placeholder="Notes about this commitment…"
                className="w-full resize-y rounded border border-border-strong bg-surface px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent"
              />
            ) : (
              <p className="whitespace-pre-wrap text-[12.5px] text-ink-2">
                {commitment.notes || <span className="text-ink-4">No notes.</span>}
              </p>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  flush = false,
}: {
  title: string;
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="rounded-lg border border-border-strong bg-surface shadow-sm">
      <header className="border-b border-border-strong px-4 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</h2>
      </header>
      <div className={flush ? "" : "px-4 py-3"}>{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 flex-1 text-right">{children}</dd>
    </div>
  );
}

// ── Progress log ──────────────────────────────────────────────────────────

function ProgressLogPanel({
  commitmentId,
  awardId,
  type,
  canManage,
}: {
  commitmentId: string;
  awardId: string;
  type: CommitmentType;
  canManage: boolean;
}) {
  const { data: log = [], isLoading } = useCommitmentLog(commitmentId);
  const createLog = useCreateProgressLog(commitmentId, awardId);
  const deleteLog = useDeleteProgressLog(commitmentId, awardId);

  const [value, setValue] = useState("");
  const [status, setStatus] = useState<QualitativeStatus>("in-progress");
  const [note, setNote] = useState("");

  const submit = async () => {
    if (type === "quantitative" && !value) return;
    await createLog.mutateAsync({
      recorded_value: type === "quantitative" ? Number(value) : null,
      recorded_status: type === "qualitative" ? status : null,
      note,
    });
    setValue("");
    setNote("");
  };

  return (
    <div>
      {canManage ? (
        <div className="flex flex-wrap items-end gap-2 border-b border-border-strong px-4 py-3">
          {type === "quantitative" ? (
            <input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="New value"
              className="w-28 rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
            />
          ) : (
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as QualitativeStatus)}
              className="rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
            >
              {QUAL_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="min-w-[160px] flex-1 rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={createLog.isPending}
            className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
          >
            Log update
          </button>
        </div>
      ) : null}

      {isLoading ? (
        <div className="px-4 py-4 text-[12px] text-ink-3">Loading progress…</div>
      ) : log.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-ink-3">
          No progress logged yet.
        </div>
      ) : (
        <div className="divide-y divide-border-strong">
          {log.map((entry) => (
            <div key={entry.id} className="group flex items-start gap-3 px-4 py-2.5">
              <span className="mono flex-shrink-0 text-[11px] text-ink-3">
                {fmtDate(entry.recorded_at)}
              </span>
              <div className="min-w-0 flex-1">
                <span className="mono text-[13px] font-medium text-ink">
                  {entry.recorded_value != null
                    ? entry.recorded_value.toLocaleString()
                    : (entry.recorded_status ?? "").replace(/-/g, " ")}
                </span>
                {entry.note ? (
                  <span className="ml-2 text-[12px] text-ink-3">{entry.note}</span>
                ) : null}
                <div className="text-[10.5px] text-ink-4">{entry.recorded_by_email}</div>
              </div>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => deleteLog.mutate(entry.id)}
                  className={cn(
                    "flex-shrink-0 text-ink-4 opacity-0 transition-opacity hover:text-red group-hover:opacity-100",
                  )}
                  aria-label="Delete entry"
                >
                  <Trash2 size={12} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
