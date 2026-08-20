import { useMemo } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Check, Plus, RefreshCw, Trash2 } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { BackLink as SharedBackLink, LinkedProjectsCard } from "@/components/detail";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { Tag } from "@/components/ui/Tag";
import { fmtDate, fmtMoneyFull } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAccountEnrichment } from "@/services/accounts";
import {
  useAward,
  useAwardReports,
  useCreateAwardReport,
  useDeleteAwardReport,
  useGenerateAwardSchedule,
  useUpdateAward,
  useUpdateAwardReport,
  type Award,
  type AwardReport,
  type AwardReportStatus,
  type AwardStatus,
} from "@/services/awards";
import { useCommitmentsByAward, type Commitment, type CommitmentStatus } from "@/services/commitments";
import { TaskListTab } from "@/components/expand/TaskListTab";
import { useCreateTask, useOpportunities, useOpportunityTasks, useUpdateOpportunity } from "@/services/opportunities";
import { useOpportunityPayments, useUpdatePayment, type SfPayment } from "@/services/payments";
import { useActiveUsers } from "@/services/users";
import { usePerm } from "@/services/permissions";
import type { SfOpportunity } from "@/types/salesforce";

const REPORT_STATUS_OPTIONS: { value: AwardReportStatus; label: string }[] = [
  { value: "Pending", label: "Pending" },
  { value: "Submitted", label: "Submitted" },
  { value: "Approved", label: "Approved" },
  { value: "Skipped", label: "Skipped" },
];

const AWARD_STATUS_OPTIONS: { value: AwardStatus; label: string }[] = [
  { value: "Active", label: "Active" },
  { value: "Closing", label: "Closing" },
  { value: "Closed", label: "Closed" },
  { value: "Did Not Fulfill", label: "Did Not Fulfill" },
];

const FREQ_OPTIONS = [
  { value: "Annual", label: "Annual" },
  { value: "Semi-Annual", label: "Semi-Annual" },
  { value: "Quarterly", label: "Quarterly" },
  { value: "Monthly", label: "Monthly" },
  { value: "Interim + Final", label: "Interim + Final" },
  { value: "Final Only", label: "Final Only" },
  { value: "None", label: "None" },
];

function awardStatusVariant(s: AwardStatus): "green" | "amber" | "red" | "default" {
  if (s === "Active") return "green";
  if (s === "Closing") return "amber";
  if (s === "Did Not Fulfill") return "red";
  return "default";
}

function reportTagVariant(status: AwardReportStatus, dueDate: string): "green" | "amber" | "red" | "default" {
  if (status === "Approved" || status === "Submitted") return "green";
  if (status === "Skipped") return "default";
  const due = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (due < today) return "red";
  const days = (due.getTime() - today.getTime()) / 86_400_000;
  if (days <= 30) return "amber";
  return "default";
}

export function AwardDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { data: award, isLoading } = useAward(id);
  const { data: opps } = useOpportunities();

  const opp = useMemo<SfOpportunity | undefined>(
    () => (opps ?? []).find((o) => o.Id === award?.opportunity_id),
    [opps, award?.opportunity_id],
  );

  if (isLoading || !award) {
    return (
      <div className="mx-auto max-w-[1320px] px-7 py-6">
        <BackLink />
        <div className="mt-6 rounded-lg border border-border-strong bg-surface p-10 text-center text-[13px] text-ink-3 shadow-sm">
          {isLoading ? "Loading award…" : "Award not found."}
        </div>
      </div>
    );
  }

  return <Loaded award={award} opp={opp} />;
}

function Loaded({ award, opp }: { award: Award; opp: SfOpportunity | undefined }) {
  // Prefer live SF data (most current) when present; fall back to the
  // server-enriched fields on `award` so users without a personal SF
  // session still see the header / stats. AccountId is used by the
  // logo enrichment query — when neither is available, fall back to
  // null (avatar will use the account name initial).
  const accountId = opp?.AccountId ?? award.account_id ?? null;
  const enrichment = useAccountEnrichment(accountId);
  const canEdit = usePerm("edit_awards");
  const updateAward = useUpdateAward();
  const updateOpp = useUpdateOpportunity();
  const usersQ = useActiveUsers();
  const location = useLocation();

  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  const patchAward = (patch: Record<string, unknown>) =>
    updateAward.mutateAsync({ id: award.id, patch }).then(() => undefined);

  const account = opp?.Account?.Name ?? award.account_name ?? "—";
  const oppName = opp?.Name ?? award.opportunity_name ?? award.opportunity_id;
  // Referrer for cross-detail jumps (award → account / project) so
  // those pages' BackLinks return here instead of their default lists.
  const referrer = {
    from: { pathname: location.pathname, label: oppName || "Award" },
  };
  const ownerName = opp?.Owner?.Name ?? award.owner_name ?? "—";
  const total = opp?.Amount ?? award.amount ?? 0;
  const paid = opp?.npe01__Payments_Made__c ?? award.payments_made ?? 0;
  const pending = Math.max(0, total - paid);
  const recordTypeName = opp?.RecordType?.Name ?? award.record_type_name ?? null;

  return (
    <div className="mx-auto max-w-[1320px] px-7 py-6 pb-20">
      <BackLink />

      {/* Header */}
      <div className="mt-4 flex items-start gap-4">
        <AccountAvatar
          name={account === "—" ? oppName : account}
          logoUrl={enrichment.data?.logo_url ?? null}
          size={48}
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[24px] font-bold leading-tight tracking-tight text-ink">
            {oppName}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            {canEdit ? (
              <InlineSelect
                value={award.award_status}
                options={AWARD_STATUS_OPTIONS}
                onSave={(v) => patchAward({ award_status: v })}
                renderValue={(v) => v ? <Tag variant={awardStatusVariant(v as AwardStatus)}>{v}</Tag> : <Tag>—</Tag>}
              />
            ) : (
              <Tag variant={awardStatusVariant(award.award_status)}>{award.award_status}</Tag>
            )}
            {recordTypeName ? <Tag>{recordTypeName}</Tag> : null}
            {accountId ? (
              <Link
                to={`/accounts/${accountId}`}
                state={referrer}
                className="underline-offset-4 hover:underline"
              >
                · {account}
              </Link>
            ) : account !== "—" ? (
              <span>· {account}</span>
            ) : null}
            {award.opportunity_id ? (
              <Link
                to={`/opportunities/${award.opportunity_id}`}
                state={referrer}
                className="inline-flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-0.5 text-[11.5px] text-ink-2 hover:bg-surface-2"
                title="Open the underlying Salesforce opportunity"
              >
                View opportunity →
              </Link>
            ) : null}
            <span>·</span>
            {/* Owner is editable only when SF is connected on the
                client (writes go through SF). Read-only fallback when
                we only have the enriched name. */}
            {canEdit && opp ? (
              <InlineSelect
                value={opp.OwnerId ?? ""}
                options={ownerOptions}
                onSave={async (ownerId) => {
                  const ownerLabel = ownerOptions.find((o) => o.value === ownerId)?.label ?? null;
                  await updateOpp.mutateAsync({
                    id: opp.Id,
                    patch: { OwnerId: ownerId },
                    displayPatch: { Owner: ownerLabel ? { Name: ownerLabel } : null } as Record<string, unknown>,
                  });
                }}
                renderValue={() => <span>{opp.Owner?.Name ?? "—"}</span>}
              />
            ) : (
              <span>{ownerName}</span>
            )}
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total" value={total > 0 ? fmtMoneyFull(total) : "—"} />
        <Stat label="Paid" value={paid > 0 ? fmtMoneyFull(paid) : "—"} accent="green" />
        <Stat label="Pending" value={pending > 0 ? fmtMoneyFull(pending) : "—"} accent="amber" />
        <Stat
          label="Awarded"
          value={award.award_date ? fmtDate(award.award_date) : "—"}
          sub={award.period_end_date ? `Period ends ${fmtDate(award.period_end_date)}` : undefined}
        />
      </div>

      {/* Body — two-column layout */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Section title="Commitments" flush>
            <CommitmentsDetail awardId={award.id} />
          </Section>

          <Section title="Reporting requirements">
            <ReportingDetail award={award} canEdit={canEdit} onPatch={patchAward} />
          </Section>

          <Section title="Payments">
            <PaymentsDetail opportunityId={award.opportunity_id} canEdit={canEdit} />
          </Section>

          <Section title="Tasks" flush>
            <TasksDetail opportunityId={award.opportunity_id} />
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Award details">
            <AwardMetaDetail award={award} canEdit={canEdit} onPatch={patchAward} />
          </Section>

          <Section title="Linked projects">
            <LinkedProjectsCard
              entityType="award"
              entityId={award.id}
              referrerLabel="Award"
            />
          </Section>

          <Section title="Notes">
            {canEdit ? (
              <textarea
                defaultValue={award.notes ?? ""}
                onBlur={(e) => {
                  if (e.target.value !== (award.notes ?? "")) {
                    patchAward({ notes: e.target.value });
                  }
                }}
                rows={6}
                placeholder="Notes about this award…"
                className="w-full resize-y rounded border border-border-strong bg-surface px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent"
              />
            ) : (
              <p className="whitespace-pre-wrap text-[12.5px] text-ink-2">
                {award.notes || <span className="text-ink-4">No notes.</span>}
              </p>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

// ── Header bits ───────────────────────────────────────────────────────────

function BackLink() {
  return <SharedBackLink defaultTo="/awards" defaultLabel="Awards" />;
}

function Section({
  title,
  children,
  flush = false,
}: {
  title: string;
  children: React.ReactNode;
  /** When true, drop the inner padding + horizontal pad and let the
   *  child render edge-to-edge. Useful when the child is itself a
   *  bordered table (so the page isn't a card-in-a-card-in-a-card). */
  flush?: boolean;
}) {
  return (
    <section className="rounded-lg border border-border-strong bg-surface shadow-sm">
      <header className="border-b border-border-strong px-4 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          {title}
        </h2>
      </header>
      <div className={flush ? "" : "px-4 py-3"}>{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "amber";
}) {
  return (
    <div className="rounded-md border border-border-strong bg-surface px-3 py-2.5 shadow-sm">
      <div className="text-[11px] uppercase tracking-wider text-ink-3">{label}</div>
      <div
        className={cn(
          "mono mt-1 text-[18px] font-semibold tabular-nums",
          accent === "green" && "text-green-700",
          accent === "amber" && "text-amber-700",
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[11px] text-ink-3">{sub}</div> : null}
    </div>
  );
}

// ── Award meta (sidebar) ──────────────────────────────────────────────────

function AwardMetaDetail({
  award,
  canEdit,
  onPatch,
}: {
  award: Award;
  canEdit: boolean;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <dl className="space-y-2 text-[12px]">
      <Row label="Frequency">
        {canEdit ? (
          <InlineSelect
            value={award.reporting_frequency ?? ""}
            options={FREQ_OPTIONS}
            onSave={(v) => onPatch({ reporting_frequency: v || null })}
            renderValue={(v) => (
              <span className={cn(v ? "text-ink" : "text-ink-4")}>
                {v || "Not set"}
              </span>
            )}
          />
        ) : (
          <span className="text-ink-2">{award.reporting_frequency ?? "—"}</span>
        )}
      </Row>
      <Row label="Awarded">
        <span className="mono text-ink-2">{fmtDate(award.award_date)}</span>
      </Row>
      <Row label="Period ends">
        {canEdit ? (
          <InlineDate
            value={award.period_end_date}
            onSave={(v) => onPatch({ period_end_date: v })}
          />
        ) : (
          <span className="mono text-ink-2">{fmtDate(award.period_end_date)}</span>
        )}
      </Row>
      <Row label="Contract file">
        {canEdit ? (
          <InlineText
            value={award.contract_file_link ?? ""}
            placeholder="Add a link"
            onSave={(v) => onPatch({ contract_file_link: v || null })}
          />
        ) : award.contract_file_link ? (
          <a
            href={award.contract_file_link}
            target="_blank"
            rel="noreferrer"
            className="text-ink-2 underline-offset-4 hover:underline"
          >
            View document
          </a>
        ) : (
          <span className="text-ink-4">—</span>
        )}
      </Row>
    </dl>
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

// ── Reporting section ─────────────────────────────────────────────────────

function ReportingDetail({
  award,
  canEdit,
}: {
  award: Award;
  canEdit: boolean;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const { data: reports = [], isLoading } = useAwardReports(award.id);
  const createReport = useCreateAwardReport(award.id);
  const updateReport = useUpdateAwardReport(award.id);
  const deleteReport = useDeleteAwardReport(award.id);
  const generate = useGenerateAwardSchedule(award.id);

  const canGenerate =
    !!award.reporting_frequency &&
    !!award.period_end_date &&
    (award.reporting_frequency === "Final Only" || !!award.award_date);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[12px] text-ink-3">
          {reports.length} scheduled · <span className="text-green-700">{award.report_done} done</span>
          {award.report_overdue > 0 ? (
            <> · <span className="text-red">{award.report_overdue} overdue</span></>
          ) : null}
        </div>
        {canEdit ? (
          <div className="flex items-center gap-1.5">
            {canGenerate ? (
              <button
                type="button"
                onClick={() => generate.mutate()}
                disabled={generate.isPending}
                className="flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-0.5 text-[11.5px] text-ink-2 hover:bg-surface-2"
                title="Replace pending reports with a schedule generated from frequency + period dates"
              >
                <RefreshCw size={11} /> Generate schedule
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                const today = new Date().toISOString().slice(0, 10);
                createReport.mutate({
                  due_date: today,
                  status: "Pending",
                  notes: "New deliverable",
                });
              }}
              className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11.5px] text-surface hover:opacity-90"
            >
              <Plus size={11} /> Add report
            </button>
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading reports…</div>
      ) : reports.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No scheduled reports yet.
          {canGenerate
            ? " Click Generate schedule above to create them from the frequency + period dates."
            : " Set Frequency and Period ends to generate a schedule."}
        </div>
      ) : (
        <div className="space-y-1">
          {reports.map((r) => (
            <ReportRow
              key={r.id}
              report={r}
              canEdit={canEdit}
              onUpdateStatus={(s) =>
                updateReport.mutateAsync({ id: r.id, patch: { status: s } }).then(() => undefined)
              }
              onUpdateDate={(d) =>
                updateReport.mutateAsync({ id: r.id, patch: { due_date: d ?? r.due_date } }).then(() => undefined)
              }
              onUpdateNotes={(n) =>
                updateReport.mutateAsync({ id: r.id, patch: { notes: n } }).then(() => undefined)
              }
              onDelete={() => deleteReport.mutate(r.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReportRow({
  report,
  canEdit,
  onUpdateStatus,
  onUpdateDate,
  onUpdateNotes,
  onDelete,
}: {
  report: AwardReport;
  canEdit: boolean;
  onUpdateStatus: (s: AwardReportStatus) => Promise<void>;
  onUpdateDate: (d: string | null) => Promise<void>;
  onUpdateNotes: (n: string) => Promise<void>;
  onDelete: () => void;
}) {
  const variant = reportTagVariant(report.status, report.due_date);
  const isDone = report.status === "Submitted" || report.status === "Approved";
  return (
    <div className="group flex items-center gap-2 rounded border border-border-strong bg-surface px-3 py-1.5">
      <button
        type="button"
        onClick={() => onUpdateStatus(isDone ? "Pending" : "Submitted")}
        disabled={!canEdit}
        className={cn(
          "grid h-4 w-4 flex-shrink-0 place-items-center rounded border transition-colors",
          isDone
            ? "border-green-500 bg-green-500 text-surface"
            : "border-border-strong hover:border-accent",
          !canEdit && "cursor-default",
        )}
        aria-label={isDone ? "Mark as pending" : "Mark as submitted"}
      >
        {isDone ? <Check size={10} strokeWidth={3} /> : null}
      </button>

      <div className="min-w-0 flex-1">
        {canEdit ? (
          <InlineText
            value={report.notes ?? ""}
            placeholder="Untitled deliverable"
            onSave={onUpdateNotes}
            className="text-[12.5px] font-medium text-ink"
          />
        ) : (
          <span className="block truncate text-[12.5px] font-medium text-ink">
            {report.notes || "Untitled deliverable"}
          </span>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
        {canEdit ? (
          <InlineDate value={report.due_date} onSave={onUpdateDate} />
        ) : (
          <span className="mono text-[12px] text-ink-2">{fmtDate(report.due_date)}</span>
        )}
        {canEdit ? (
          <InlineSelect
            value={report.status}
            options={REPORT_STATUS_OPTIONS}
            onSave={(s) => onUpdateStatus(s as AwardReportStatus)}
            renderValue={(v) => <Tag variant={variant}>{v || "Pending"}</Tag>}
          />
        ) : (
          <Tag variant={variant}>{report.status}</Tag>
        )}
        {report.submitted_at ? (
          <span className="mono text-[10.5px] text-ink-3">
            submitted {fmtDate(report.submitted_at)}
          </span>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            onClick={onDelete}
            className="text-ink-4 opacity-0 transition-opacity hover:text-red group-hover:opacity-100"
            aria-label="Delete report"
          >
            <Trash2 size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── Payments section ──────────────────────────────────────────────────────

const PAYMENT_METHOD_OPTIONS = [
  { value: "Check", label: "Check" },
  { value: "ACH", label: "ACH" },
  { value: "Wire", label: "Wire" },
  { value: "Credit Card", label: "Credit Card" },
  { value: "Other", label: "Other" },
];

function PaymentsDetail({
  opportunityId,
  canEdit,
}: {
  opportunityId: string;
  canEdit: boolean;
}) {
  const { data: payments = [], isLoading } = useOpportunityPayments(opportunityId);
  const updatePayment = useUpdatePayment(opportunityId);

  const totalPaid = payments
    .filter((p) => p.npe01__Paid__c)
    .reduce((s, p) => s + (p.npe01__Payment_Amount__c ?? 0), 0);
  const totalScheduled = payments.reduce((s, p) => s + (p.npe01__Payment_Amount__c ?? 0), 0);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-[12px] text-ink-3">
        <span>{payments.length} payment{payments.length === 1 ? "" : "s"}</span>
        <span className="mono">
          <span className="text-green-700">{fmtMoneyFull(totalPaid)} paid</span>
          {" · "}
          <span className="text-amber-700">{fmtMoneyFull(totalScheduled - totalPaid)} pending</span>
        </span>
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading payments…</div>
      ) : payments.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No payment schedules in Salesforce.
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border-strong">
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">Status</th>
                <th className="px-3 py-1.5 text-left font-semibold">Scheduled</th>
                <th className="px-3 py-1.5 text-left font-semibold">Paid on</th>
                <th className="px-3 py-1.5 text-left font-semibold">Method</th>
                <th className="px-3 py-1.5 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <PaymentRow
                  key={p.Id}
                  payment={p}
                  canEdit={canEdit}
                  onPatch={async (patch) => {
                    await updatePayment.mutateAsync({ id: p.Id, patch });
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PaymentRow({
  payment: p,
  canEdit,
  onPatch,
}: {
  payment: SfPayment;
  canEdit: boolean;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const paid = p.npe01__Paid__c;
  const scheduledDate = p.npe01__Scheduled_Date__c;
  const overdue = !paid && scheduledDate && new Date(scheduledDate).getTime() < Date.now();

  return (
    <tr className="border-t border-border-strong">
      <td className="px-3 py-1.5">
        {canEdit ? (
          <button
            type="button"
            onClick={() =>
              onPatch({
                npe01__Paid__c: !paid,
                ...(paid ? { npe01__Payment_Date__c: null } : { npe01__Payment_Date__c: new Date().toISOString().slice(0, 10) }),
              })
            }
          >
            <Tag variant={paid ? "green" : overdue ? "red" : "amber"}>
              {paid ? "Paid" : overdue ? "Overdue" : "Scheduled"}
            </Tag>
          </button>
        ) : (
          <Tag variant={paid ? "green" : overdue ? "red" : "amber"}>
            {paid ? "Paid" : overdue ? "Overdue" : "Scheduled"}
          </Tag>
        )}
      </td>
      <td className="mono px-3 py-1.5 text-[11.5px] text-ink-2">
        {canEdit ? (
          <InlineDate
            value={scheduledDate}
            onSave={(v) => onPatch({ npe01__Scheduled_Date__c: v })}
          />
        ) : (
          fmtDate(scheduledDate)
        )}
      </td>
      <td className="mono px-3 py-1.5 text-[11.5px] text-ink-2">
        {canEdit ? (
          <InlineDate
            value={p.npe01__Payment_Date__c}
            onSave={(v) => onPatch({ npe01__Payment_Date__c: v })}
          />
        ) : (
          fmtDate(p.npe01__Payment_Date__c)
        )}
      </td>
      <td className="px-3 py-1.5 text-ink-2">
        {canEdit ? (
          <InlineSelect
            value={p.npe01__Payment_Method__c ?? ""}
            options={PAYMENT_METHOD_OPTIONS}
            onSave={(v) => onPatch({ npe01__Payment_Method__c: v || null })}
            renderValue={(v) => <span className={cn(v ? "text-ink" : "text-ink-4")}>{v || "—"}</span>}
          />
        ) : (
          p.npe01__Payment_Method__c || "—"
        )}
      </td>
      <td className="mono px-3 py-1.5 text-right font-medium tabular-nums">
        {canEdit ? (
          <InlineText
            value={p.npe01__Payment_Amount__c != null ? String(p.npe01__Payment_Amount__c) : ""}
            onSave={async (raw) => {
              const num = parseFloat(raw.replace(/[^0-9.-]/g, ""));
              if (!Number.isFinite(num)) return;
              await onPatch({ npe01__Payment_Amount__c: num });
            }}
            placeholder="—"
            className="justify-end text-right"
          />
        ) : (
          fmtMoneyFull(p.npe01__Payment_Amount__c ?? 0, true)
        )}
      </td>
    </tr>
  );
}

// ── Tasks section ─────────────────────────────────────────────────────────

function TasksDetail({ opportunityId }: { opportunityId: string }) {
  const { data: tasks = [], isLoading } = useOpportunityTasks(opportunityId);
  const usersQ = useActiveUsers();
  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );
  const createTask = useCreateTask();

  // Reuse the shared TaskListTab so the Award page gets the same full
  // CRUD surface that every other expand panel has — inline-edit on
  // subject / status / owner / due, hover-revealed delete, and an
  // inline "new task" footer row that creates tasks tied to the
  // award's underlying opportunity.
  return (
    <TaskListTab
      unstyled
      tasks={tasks}
      isLoading={isLoading}
      placeholder="Add a task — press Enter to create"
      emptyMessage="No open tasks for this award."
      ownerOptions={ownerOptions}
      onCreate={async ({ subject, ownerId, activityDate }) => {
        await createTask.mutateAsync({
          opportunityId,
          body: {
            Subject: subject,
            OwnerId: ownerId ?? undefined,
            ActivityDate: activityDate ?? undefined,
          },
        });
      }}
    />
  );
}

// ── Commitments section ───────────────────────────────────────────────────
//
// Grant owners work from here directly — the award is already the page's
// context, so unlike the standalone /commitments dashboard's create flow
// there's no award picker; new commitments are created against this award.

function commitmentStatusVariant(s: CommitmentStatus): "green" | "sky" | "amber" | "red" {
  if (s === "complete") return "green";
  if (s === "ahead") return "sky";
  if (s === "under") return "red";
  return "amber";
}

function CommitmentsDetail({ awardId }: { awardId: string }) {
  const { data: commitments = [], isLoading } = useCommitmentsByAward(awardId);

  if (isLoading) {
    return <div className="px-4 py-4 text-[12px] text-ink-3">Loading commitments…</div>;
  }

  if (commitments.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No commitments logged for this award yet.{" "}
        <Link to={`/commitments?award=${awardId}`} className="underline-offset-4 hover:underline">
          Log the first one →
        </Link>
      </div>
    );
  }

  const tracked = commitments.filter((c: Commitment) => c.tracking_tier === "tracked");
  const reference = commitments.length - tracked.length;

  return (
    <div>
      <div className="flex items-center justify-between border-b border-border-strong px-4 py-2 text-[11.5px] text-ink-3">
        <span>
          {commitments.length} commitment{commitments.length === 1 ? "" : "s"}
          {reference > 0 ? ` — ${tracked.length} tracked · ${reference} reference` : ""}
        </span>
        <Link
          to={`/commitments?award=${awardId}`}
          className="text-ink-2 underline-offset-4 hover:underline"
        >
          + Add commitment
        </Link>
      </div>
      <div className="divide-y divide-border-strong">
        {commitments.map((c: Commitment) => (
          <Link
            key={c.id}
            to={`/commitments/${c.id}`}
            className="flex items-center gap-2 px-4 py-2 hover:bg-surface-2"
          >
            <Tag variant={commitmentStatusVariant(c.status)}>{c.status}</Tag>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={c.title}>
              {c.title}
            </span>
            <span className="mono flex-shrink-0 text-[11px] text-ink-3">{fmtDate(c.deadline)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

