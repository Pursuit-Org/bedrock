import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ExternalLink, Plus, Trash2, RefreshCw } from "lucide-react";

import { TaskListTab } from "@/components/expand/TaskListTab";
import { InlineDate, InlineSelect } from "@/components/ui/InlineEdit";
import { Tag } from "@/components/ui/Tag";
import {
  useAwardReports,
  useCreateAwardReport,
  useDeleteAwardReport,
  useGenerateAwardSchedule,
  useUpdateAwardReport,
  type Award,
  type AwardReport,
  type AwardReportStatus,
} from "@/services/awards";
import { useOpportunityPayments } from "@/services/payments";
import { useCreateTask, useOpportunityTasks } from "@/services/opportunities";
import { useActiveUsers } from "@/services/users";
import {
  useCreateProject,
  useLinkProjectToOpportunity,
  useProjects,
} from "@/services/projects";
import { fmtDate, fmtMoneyFull } from "@/lib/format";
import { cn } from "@/lib/utils";

export const AWARD_PANEL_HEIGHT = 320; // matches style={{ height }}

const REPORT_STATUS_OPTIONS: { value: AwardReportStatus; label: string }[] = [
  { value: "Pending", label: "Pending" },
  { value: "Submitted", label: "Submitted" },
  { value: "Approved", label: "Approved" },
  { value: "Skipped", label: "Skipped" },
];

function reportTagVariant(status: AwardReportStatus, dueDate: string): "green" | "amber" | "red" | "default" {
  if (status === "Approved" || status === "Submitted") return "green";
  if (status === "Skipped") return "default";
  // Pending
  const due = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (due < today) return "red";
  const days = (due.getTime() - today.getTime()) / 86_400_000;
  if (days <= 30) return "amber";
  return "default";
}

type Tab = "reports" | "payments" | "tasks" | "projects";

export function AwardExpandPanel({ award }: { award: Award }) {
  const [tab, setTab] = useState<Tab>("reports");
  const projectsQ = useProjects();
  const linkedProjects = useMemo(
    () => (projectsQ.data ?? []).filter((p) => p.opportunity_id === award.opportunity_id),
    [projectsQ.data, award.opportunity_id],
  );

  return (
    <div className="overflow-hidden border-t border-b border-border-strong bg-surface-2/40" style={{ height: AWARD_PANEL_HEIGHT }}>
      <div className="flex flex-wrap items-center gap-1 border-b border-border-strong bg-surface px-4 pt-2">
        <TabButton active={tab === "reports"} onClick={() => setTab("reports")}>
          Reports {award.report_total > 0 ? `· ${award.report_done}/${award.report_total}` : ""}
        </TabButton>
        <TabButton active={tab === "payments"} onClick={() => setTab("payments")}>
          Payments
        </TabButton>
        <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")}>
          Tasks
        </TabButton>
        <TabButton active={tab === "projects"} onClick={() => setTab("projects")}>
          Projects {linkedProjects.length > 0 ? `· ${linkedProjects.length}` : ""}
        </TabButton>
      </div>

      <div className="h-[calc(100%-32px)] overflow-y-auto pb-2">
        {tab === "reports" && <ReportsTab award={award} />}
        {tab === "payments" && <PaymentsTab opportunityId={award.opportunity_id} />}
        {tab === "tasks" && <TasksTab opportunityId={award.opportunity_id} />}
        {tab === "projects" && (
          <ProjectsTab
            award={award}
            linkedProjects={linkedProjects}
            allProjects={projectsQ.data ?? []}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "border-b-2 px-3 pb-1.5 pt-1 text-[12px] font-medium transition-colors",
        active
          ? "border-accent text-ink"
          : "border-transparent text-ink-3 hover:text-ink-2",
      )}
    >
      {children}
    </button>
  );
}

// ── Reports tab ───────────────────────────────────────────────────────────

function ReportsTab({ award }: { award: Award }) {
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
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          {reports.length} report{reports.length === 1 ? "" : "s"}
          {award.reporting_frequency ? ` · ${award.reporting_frequency}` : ""}
        </span>
        <div className="flex items-center gap-1.5">
          {canGenerate ? (
            <button
              type="button"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              className="flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-0.5 text-[11.5px] text-ink-2 hover:bg-surface-2"
              title="Generate from frequency + period dates (replaces existing pending reports)"
            >
              <RefreshCw size={11} /> Generate schedule
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              const today = new Date().toISOString().slice(0, 10);
              createReport.mutate({ due_date: today, status: "Pending" });
            }}
            className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11.5px] text-surface hover:opacity-90"
          >
            <Plus size={11} /> Add report
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : reports.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No scheduled reports yet.
          {canGenerate
            ? " Click Generate schedule to stamp them out from the frequency + period dates."
            : " Set reporting frequency and period end date on the award to generate a schedule."}
        </div>
      ) : (
        <div className="space-y-1">
          {reports.map((r) => (
            <ReportRow
              key={r.id}
              report={r}
              onUpdateStatus={(status) => updateReport.mutate({ id: r.id, patch: { status } })}
              onUpdateDate={(due_date) =>
                updateReport.mutate({ id: r.id, patch: { due_date: due_date ?? r.due_date } })
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
  onUpdateStatus,
  onUpdateDate,
  onDelete,
}: {
  report: AwardReport;
  onUpdateStatus: (status: AwardReportStatus) => void;
  onUpdateDate: (date: string | null) => void;
  onDelete: () => void;
}) {
  const variant = reportTagVariant(report.status, report.due_date);
  const isDone = report.status === "Submitted" || report.status === "Approved";
  return (
    <div className="group flex items-center gap-2 rounded border border-border-strong bg-surface px-3 py-1.5">
      <button
        type="button"
        onClick={() => onUpdateStatus(isDone ? "Pending" : "Submitted")}
        className={cn(
          "grid h-4 w-4 place-items-center rounded border transition-colors",
          isDone
            ? "border-green-500 bg-green-500 text-surface"
            : "border-border-strong hover:border-accent",
        )}
        aria-label={isDone ? "Mark as pending" : "Mark as submitted"}
      >
        {isDone ? <Check size={10} strokeWidth={3} /> : null}
      </button>

      <InlineDate
        value={report.due_date}
        onSave={(v) => Promise.resolve(onUpdateDate(v))}
      />

      <div className="ml-auto flex items-center gap-2">
        <InlineSelect
          value={report.status}
          options={REPORT_STATUS_OPTIONS}
          onSave={(v) => Promise.resolve(onUpdateStatus(v as AwardReportStatus))}
          renderValue={(v) => (
            <Tag variant={variant}>{v || "Pending"}</Tag>
          )}
        />
        {report.submitted_at ? (
          <span className="mono text-[10.5px] text-ink-3">
            submitted {fmtDate(report.submitted_at)}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onDelete}
          className="text-ink-4 opacity-0 transition-opacity hover:text-red group-hover:opacity-100"
          aria-label="Delete report"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Payments tab ──────────────────────────────────────────────────────────

function PaymentsTab({ opportunityId }: { opportunityId: string }) {
  const { data: payments = [], isLoading } = useOpportunityPayments(opportunityId);

  const totalPaid = payments
    .filter((p) => p.npe01__Paid__c)
    .reduce((s, p) => s + (p.npe01__Payment_Amount__c ?? 0), 0);
  const totalScheduled = payments.reduce((s, p) => s + (p.npe01__Payment_Amount__c ?? 0), 0);

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-ink-3">
        <span>{payments.length} payment{payments.length === 1 ? "" : "s"}</span>
        <span className="mono">
          {fmtMoneyFull(totalPaid)} paid · {fmtMoneyFull(totalScheduled - totalPaid)} pending
        </span>
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : payments.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No payment schedules in Salesforce.
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border-strong bg-surface">
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
              {payments.map((p) => {
                const paid = p.npe01__Paid__c;
                const scheduledDate = p.npe01__Scheduled_Date__c;
                const overdue =
                  !paid &&
                  scheduledDate &&
                  new Date(scheduledDate).getTime() < Date.now();
                return (
                  <tr key={p.Id} className="border-t border-border-strong">
                    <td className="px-3 py-1.5">
                      <Tag variant={paid ? "green" : overdue ? "red" : "amber"}>
                        {paid ? "Paid" : overdue ? "Overdue" : "Scheduled"}
                      </Tag>
                    </td>
                    <td className="mono px-3 py-1.5 text-[11.5px] text-ink-2">
                      {fmtDate(scheduledDate)}
                    </td>
                    <td className="mono px-3 py-1.5 text-[11.5px] text-ink-2">
                      {fmtDate(p.npe01__Payment_Date__c)}
                    </td>
                    <td className="px-3 py-1.5 text-ink-2">
                      {p.npe01__Payment_Method__c || "—"}
                    </td>
                    <td className="mono px-3 py-1.5 text-right font-medium tabular-nums">
                      {fmtMoneyFull(p.npe01__Payment_Amount__c ?? 0, true)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Tasks tab ─────────────────────────────────────────────────────────────

function TasksTab({ opportunityId }: { opportunityId: string }) {
  const { data: tasks = [], isLoading } = useOpportunityTasks(opportunityId);
  const usersQ = useActiveUsers();
  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );
  const createTask = useCreateTask();

  return (
    <TaskListTab
      tasks={tasks}
      isLoading={isLoading}
      placeholder="Add a task — press Enter to create"
      emptyMessage="No open tasks for this opportunity."
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

// ── Projects tab ──────────────────────────────────────────────────────────

function ProjectsTab({
  award,
  linkedProjects,
  allProjects,
}: {
  award: Award;
  linkedProjects: { id: string; name: string; description: string }[];
  allProjects: { id: string; name: string; opportunity_id: string | null }[];
}) {
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [newName, setNewName] = useState("");
  const [linkPick, setLinkPick] = useState("");
  const createProject = useCreateProject();
  const linkProject = useLinkProjectToOpportunity();

  const linkableProjects = allProjects.filter(
    (p) => p.opportunity_id !== award.opportunity_id,
  );

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          {linkedProjects.length} project{linkedProjects.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => { setLinking(true); setCreating(false); }}
            className="flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-0.5 text-[11.5px] text-ink-2 hover:bg-surface-2"
          >
            Link existing
          </button>
          <button
            type="button"
            onClick={() => { setCreating(true); setLinking(false); }}
            className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11.5px] text-surface hover:opacity-90"
          >
            <Plus size={11} /> New project
          </button>
        </div>
      </div>

      {creating ? (
        <form
          className="mb-2 flex items-center gap-2 rounded border border-border-strong bg-surface px-3 py-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            await createProject.mutateAsync({
              name: newName.trim(),
              opportunity_id: award.opportunity_id,
            });
            setNewName("");
            setCreating(false);
          }}
        >
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New project name"
            className="h-7 flex-1 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
          />
          <button type="submit" className="rounded bg-accent px-2 py-0.5 text-[11.5px] text-surface">
            Create
          </button>
          <button type="button" onClick={() => setCreating(false)} className="text-[11.5px] text-ink-3 hover:text-ink-2">
            Cancel
          </button>
        </form>
      ) : null}

      {linking ? (
        <form
          className="mb-2 flex items-center gap-2 rounded border border-border-strong bg-surface px-3 py-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!linkPick) return;
            await linkProject.mutateAsync({
              projectId: linkPick,
              opportunityId: award.opportunity_id,
            });
            setLinkPick("");
            setLinking(false);
          }}
        >
          <select
            autoFocus
            value={linkPick}
            onChange={(e) => setLinkPick(e.target.value)}
            // min-w-0 lets the select shrink below its widest <option> —
            // a long project name must not widen the panel.
            className="h-7 min-w-0 flex-1 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
          >
            <option value="">Choose a project to link…</option>
            {linkableProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.opportunity_id ? " (currently linked elsewhere)" : ""}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded bg-accent px-2 py-0.5 text-[11.5px] text-surface">
            Link
          </button>
          <button type="button" onClick={() => setLinking(false)} className="text-[11.5px] text-ink-3 hover:text-ink-2">
            Cancel
          </button>
        </form>
      ) : null}

      {linkedProjects.length === 0 && !creating && !linking ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No projects linked yet. Use "New project" to scope and track work for this award.
        </div>
      ) : (
        <div className="space-y-1">
          {linkedProjects.map((p) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="group flex items-center gap-2 rounded border border-border-strong bg-surface px-3 py-1.5 hover:border-accent"
            >
              <span className="flex-1 truncate text-[12.5px] font-medium text-ink">
                {p.name}
              </span>
              {p.description ? (
                <span className="truncate text-[11.5px] text-ink-3" title={p.description}>
                  {p.description}
                </span>
              ) : null}
              <ExternalLink size={12} className="flex-shrink-0 text-ink-4 group-hover:text-accent" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
