import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import {
  useAward,
  useAwardReports,
  useCreateAwardReport,
} from "@/services/awards";
import { useCreateTask, useOpportunities, useUpdateOpportunity } from "@/services/opportunities";
import {
  useCreateProject,
  useLinkProjectToOpportunity,
  useProjects,
} from "@/services/projects";

/**
 * Post-stage award setup workflow — fires after a Contracting →
 * Collecting / In Effect transition that produced a new award. Three
 * sections, each independently saveable or deferrable via a
 * "Remind me later" affordance that drops a SF Task (due in 7 days)
 * onto the parent opportunity.
 *
 *   1. Award start + end dates → patches the Bedrock Award row
 *   2. Reporting requirements + cadence → patches the Award row
 *      (free-text notes for now, structured cadence picklist)
 *   3. Project link (Bedrock projects) — pick existing or create new
 *
 * The dialog can be dismissed at any point; pending sections do NOT
 * block stage progression (the stage change already committed). It's
 * a follow-up checklist, not a gate.
 */
export function AwardSetupDialog({
  awardId,
  opportunityId,
  onClose,
}: {
  awardId: string;
  opportunityId: string;
  onClose: () => void;
}) {
  const createTask = useCreateTask();
  const updateOpp = useUpdateOpportunity();
  const projectsQ = useProjects();
  const createProject = useCreateProject();
  const linkProject = useLinkProjectToOpportunity();
  const createAwardReport = useCreateAwardReport(awardId);
  // Existing reports list — surface in the deliverables editor so the
  // user sees what's already on the award (e.g. from a prior session).
  const reportsQ = useAwardReports(awardId);
  // Award row carries the linked opportunity name + account name —
  // used to give the dialog a clear "this is for X" context line.
  const awardQ = useAward(awardId);
  const award = awardQ.data;

  // ── Section 1: Grant dates (writes to SF Opportunity) ─────────────
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [datesSaved, setDatesSaved] = useState(false);

  // Prefill from the opportunity's grant period fields when they were set
  // ahead of the award (e.g. via the Grant Period section on the opp page),
  // so the user confirms instead of re-typing. Seed once, never clobber input.
  const { data: seedOpps } = useOpportunities();
  const [datesSeeded, setDatesSeeded] = useState(false);
  useEffect(() => {
    if (datesSeeded || !seedOpps) return;
    const opp = seedOpps.find((o) => o.Id === opportunityId);
    if (!opp) return;
    if (!startDate && opp.Grant_Start_Date__c) setStartDate(opp.Grant_Start_Date__c.slice(0, 10));
    if (!endDate && opp.Grant_End_Date__c) setEndDate(opp.Grant_End_Date__c.slice(0, 10));
    setDatesSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedOpps, datesSeeded]);

  const saveDates = () => {
    if (!startDate && !endDate) {
      toast.error("Set at least one date or use Remind me later");
      return;
    }
    // Optimistic: mark this section done immediately. The SF write
    // happens in the background with a sonner toast for progress.
    const patch: Record<string, unknown> = {};
    if (startDate) patch.Grant_Start_Date__c = startDate;
    if (endDate) patch.Grant_End_Date__c = endDate;
    const toastId = `grant-dates-${opportunityId}-${Date.now()}`;
    toast.loading("Saving grant dates…", { id: toastId });
    setDatesSaved(true);
    void (async () => {
      try {
        await updateOpp.mutateAsync({ id: opportunityId, patch });
        toast.success("Grant dates saved", { id: toastId });
      } catch (e) {
        toast.error(`Couldn't save dates: ${errorMessage(e)}`, { id: toastId, duration: 8000 });
        setDatesSaved(false);
      }
    })();
  };

  const remindDates = () => {
    void createReminderTask(
      createTask,
      opportunityId,
      "[Award setup] Confirm grant start + end dates",
      `Post-Collecting follow-up: set Grant_Start_Date__c and Grant_End_Date__c on the opportunity so reporting + payment schedules align. Award id: ${awardId}`,
    ).then(() => setDatesSaved(true));
  };

  // ── Section 2: Reporting deliverables (each with a due date) ──────
  interface DeliverableRow {
    id: string; // local id for React key + remove
    title: string;
    due_date: string;
  }
  const [deliverables, setDeliverables] = useState<DeliverableRow[]>([]);
  const [reportingSaved, setReportingSaved] = useState(false);

  // Seed from existing AwardReports on the award (so re-opening the
  // dialog doesn't lose what was already entered).
  const [reportingSeeded, setReportingSeeded] = useState(false);
  useEffect(() => {
    const data = reportsQ.data;
    if (!data || reportingSeeded) return;
    setDeliverables(
      data.map((r) => ({
        id: r.id,
        title: r.notes || "Report",
        due_date: r.due_date,
      })),
    );
    setReportingSeeded(true);
  }, [reportsQ.data, reportingSeeded]);

  const addDeliverable = () => {
    setDeliverables((prev) => [
      ...prev,
      { id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title: "", due_date: "" },
    ]);
  };

  const removeDeliverable = (id: string) => {
    setDeliverables((prev) => prev.filter((d) => d.id !== id));
  };

  const updateDeliverable = (id: string, patch: Partial<DeliverableRow>) => {
    setDeliverables((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const saveReporting = () => {
    const existingIds = new Set((reportsQ.data ?? []).map((r) => r.id));
    const toCreate = deliverables.filter(
      (d) => !existingIds.has(d.id) && d.title.trim() && d.due_date,
    );
    if (toCreate.length === 0) {
      toast.error("Add at least one deliverable with a title and due date");
      return;
    }
    const toastId = `deliverables-${awardId}-${Date.now()}`;
    toast.loading(`Saving ${toCreate.length} deliverable${toCreate.length === 1 ? "" : "s"}…`, { id: toastId });
    setReportingSaved(true);
    void (async () => {
      try {
        // Sequential to avoid hammering bedrock.award_report inserts.
        for (const d of toCreate) {
          await createAwardReport.mutateAsync({
            due_date: d.due_date,
            notes: d.title.trim(),
          });
        }
        toast.success(`${toCreate.length} deliverable${toCreate.length === 1 ? "" : "s"} saved`, { id: toastId });
      } catch (e) {
        toast.error(`Couldn't save deliverables: ${errorMessage(e)}`, { id: toastId, duration: 8000 });
        setReportingSaved(false);
      }
    })();
  };

  const remindReporting = () => {
    void createReminderTask(
      createTask,
      opportunityId,
      "[Award setup] Log reporting deliverables + due dates",
      `Post-Collecting follow-up: capture the funder's required deliverables and the due date for each as AwardReport rows on the award. Award id: ${awardId}`,
    ).then(() => setReportingSaved(true));
  };

  // ── Section 3: Project ────────────────────────────────────────────
  const [projectMode, setProjectMode] = useState<"none" | "link" | "create">("none");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [projectSaved, setProjectSaved] = useState(false);

  // Seed from any project already linked to this opp so the picker
  // shows the existing selection (and "saved" state). Runs once when
  // projects list arrives so the user's in-flight choices stick.
  const [projectSeeded, setProjectSeeded] = useState(false);
  useEffect(() => {
    const data = projectsQ.data;
    if (!data || projectSeeded) return;
    const existing = data.find((p) => p.opportunity_id === opportunityId);
    if (existing) {
      setProjectMode("link");
      setSelectedProjectId(existing.id);
      setProjectSaved(true);
    }
    setProjectSeeded(true);
  }, [projectsQ.data, opportunityId, projectSeeded]);

  // Show every project the user has access to. Filtering out projects
  // already linked to other opps would hide most of the catalog
  // (most projects are scoped to an opp), making the picker look
  // empty even when there's plenty to choose from. If the user picks
  // one that's already on another opp, useLinkProjectToOpportunity
  // will reassign it — which is the right behavior for moving a
  // project to a new award.
  const eligibleProjects = projectsQ.data ?? [];

  const saveProject = () => {
    if (projectMode === "link" && !selectedProjectId) {
      toast.error("Pick a project to link");
      return;
    }
    if (projectMode === "create" && !newProjectName.trim()) {
      toast.error("Give the new project a name");
      return;
    }
    const toastId = `project-link-${opportunityId}-${Date.now()}`;
    toast.loading(projectMode === "link" ? "Linking project…" : "Creating project…", { id: toastId });
    setProjectSaved(true);
    void (async () => {
      try {
        if (projectMode === "link") {
          await linkProject.mutateAsync({ projectId: selectedProjectId, opportunityId });
          toast.success("Project linked", { id: toastId });
        } else if (projectMode === "create") {
          await createProject.mutateAsync({
            name: newProjectName.trim(),
            opportunity_id: opportunityId,
          });
          toast.success("Project created and linked", { id: toastId });
        }
      } catch (e) {
        toast.error(`Couldn't save project: ${errorMessage(e)}`, { id: toastId, duration: 8000 });
        setProjectSaved(false);
      }
    })();
  };

  const remindProject = () => {
    void createReminderTask(
      createTask,
      opportunityId,
      "[Award setup] Create or link implementation project",
      `Post-Collecting follow-up: if this award requires implementation, create or link a project so the team has a working space for deliverables. Award id: ${awardId}`,
    ).then(() => setProjectSaved(true));
  };

  const allDone = datesSaved && reportingSaved && projectSaved;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-[700px] flex-col overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl">
        <header className="flex items-start justify-between border-b border-border-strong px-5 py-3">
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Award setup
            </div>
            <h2 className="mt-0.5 truncate text-[15px] font-semibold text-ink">
              {award?.opportunity_name ?? "Set up the new award"}
            </h2>
            {award?.account_name ? (
              <div className="mt-0.5 truncate text-[11.5px] text-ink-3">
                {award.account_name}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 text-ink-3 hover:text-ink-2"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-4 text-[12.5px] leading-relaxed text-ink-2">
            The award record auto-generated from this stage change. Confirm the dates, reporting plan, and project setup
            below — or use <strong>Remind me later</strong> on any section to drop a task on the opportunity (due in 1 week).
          </p>

          <div className="flex flex-col gap-3">
            <SetupSection
              label="1 · Grant start + end dates"
              saved={datesSaved}
              saving={createTask.isPending}
              onSave={saveDates}
              onRemindLater={remindDates}
            >
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                    Grant start date
                  </span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                    Grant end date
                  </span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className={inputCls}
                  />
                </label>
              </div>
            </SetupSection>

            <SetupSection
              label="2 · Reporting deliverables"
              saved={reportingSaved}
              saving={false}
              onSave={saveReporting}
              onRemindLater={remindReporting}
            >
              <p className="mb-2 text-[11.5px] text-ink-3">
                Add each deliverable the funder requires. Saved deliverables live on the award as scheduled reports.
              </p>
              {deliverables.length === 0 ? (
                <div className="rounded border border-dashed border-border-strong px-3 py-3 text-center text-[11.5px] text-ink-3">
                  No deliverables yet — click <strong>Add deliverable</strong> below to start.
                </div>
              ) : (
                <table className="w-full table-fixed border-collapse text-[12.5px]">
                  <colgroup>
                    <col />
                    <col className="w-[140px]" />
                    <col className="w-[28px]" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="border-b border-border-strong bg-surface-2 px-2 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                        Deliverable
                      </th>
                      <th className="border-b border-border-strong bg-surface-2 px-2 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                        Due date
                      </th>
                      <th className="border-b border-border-strong bg-surface-2 px-2 py-1.5" aria-label="Remove" />
                    </tr>
                  </thead>
                  <tbody>
                    {deliverables.map((d) => {
                      const isExisting = !d.id.startsWith("new-");
                      return (
                        <tr key={d.id} className={isExisting ? "opacity-60" : ""}>
                          <td className="px-1 py-1">
                            {isExisting ? (
                              <span className="text-[12.5px] text-ink-2">{d.title}</span>
                            ) : (
                              <input
                                type="text"
                                value={d.title}
                                placeholder="e.g. Quarterly impact report"
                                onChange={(e) => updateDeliverable(d.id, { title: e.target.value })}
                                className="w-full rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[12px] outline-none focus:border-accent"
                              />
                            )}
                          </td>
                          <td className="px-1 py-1">
                            {isExisting ? (
                              <span className="mono text-[12.5px] tabular-nums text-ink-2">{d.due_date}</span>
                            ) : (
                              <input
                                type="date"
                                value={d.due_date}
                                onChange={(e) => updateDeliverable(d.id, { due_date: e.target.value })}
                                className="w-full rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[12px] outline-none focus:border-accent"
                              />
                            )}
                          </td>
                          <td className="px-1 py-1 text-right">
                            {isExisting ? (
                              <span className="text-[9px] uppercase tracking-wider text-green">saved</span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => removeDeliverable(d.id)}
                                className="rounded p-0.5 text-ink-3 hover:bg-surface hover:text-red"
                                aria-label="Remove deliverable"
                              >
                                <Trash2 size={11} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <button
                type="button"
                onClick={addDeliverable}
                className="mt-2 inline-flex items-center gap-1 self-start rounded border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:bg-surface-2"
              >
                <Plus size={11} /> Add deliverable
              </button>
            </SetupSection>

            <SetupSection
              label="3 · Project (if implementation required)"
              saved={projectSaved}
              saving={createProject.isPending || linkProject.isPending}
              onSave={projectMode === "none" ? null : saveProject}
              onRemindLater={remindProject}
            >
              <div className="flex items-center gap-2 text-[12.5px]">
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="project-mode"
                    checked={projectMode === "none"}
                    onChange={() => setProjectMode("none")}
                  />
                  No implementation needed
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="project-mode"
                    checked={projectMode === "link"}
                    onChange={() => setProjectMode("link")}
                  />
                  Link existing
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="project-mode"
                    checked={projectMode === "create"}
                    onChange={() => setProjectMode("create")}
                  />
                  Create new
                </label>
              </div>
              {projectMode === "link" ? (
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className={`${inputCls} mt-2`}
                >
                  <option value="">Pick a project…</option>
                  {eligibleProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : null}
              {projectMode === "create" ? (
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="New project name"
                  className={`${inputCls} mt-2`}
                />
              ) : null}
            </SetupSection>
          </div>

          {allDone ? (
            <div className="mt-4 rounded border border-green/30 bg-green/5 px-3 py-2 text-[12.5px] text-green">
              All set — you can close this dialog.
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border-strong bg-surface-2/40 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="text-[12.5px] text-ink-3 hover:text-ink-2"
          >
            {allDone ? "Done" : "Close"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

const inputCls =
  "h-8 rounded border border-border-strong bg-surface px-2 text-[12.5px] outline-none focus:border-accent";

function SetupSection({
  label,
  saved,
  saving,
  onSave,
  onRemindLater,
  children,
}: {
  label: string;
  saved: boolean;
  saving: boolean;
  /** When null, the Save action is hidden (e.g. for the "no
   *  implementation needed" project state where nothing to save). */
  onSave: (() => void) | null;
  onRemindLater: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-border-strong bg-surface-2/40 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink">{label}</span>
        {saved ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-green">
            <CheckCircle2 size={12} /> done
          </span>
        ) : null}
      </div>
      <div className="flex flex-col">{children}</div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onRemindLater}
          disabled={saving}
          className="text-[11.5px] text-ink-3 underline-offset-2 hover:underline disabled:opacity-50"
          title="Create a task on the opportunity, due in 1 week"
        >
          Remind me later
        </button>
        {onSave ? (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="inline-flex h-7 items-center gap-1.5 rounded bg-ink px-2.5 text-[11.5px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : null}
            Save
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              toast.success("Acknowledged — no implementation needed");
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded bg-ink px-2.5 text-[11.5px] font-medium text-surface hover:opacity-90"
          >
            Skip
          </button>
        )}
      </div>
    </div>
  );
}

interface CreateTaskHook {
  mutateAsync: (input: {
    opportunityId: string;
    body: {
      Subject: string;
      ActivityDate?: string | null;
      Description?: string | null;
    };
  }) => Promise<unknown>;
  isPending?: boolean;
}

async function createReminderTask(
  createTask: CreateTaskHook,
  opportunityId: string,
  subject: string,
  description: string,
): Promise<void> {
  // Due 7 days from today — the playbook's "remind me next week" rule.
  const due = new Date();
  due.setDate(due.getDate() + 7);
  const dueIso = due.toISOString().slice(0, 10);
  // Identify the section in the toast so misfires (e.g. wrong button
  // wired up) are obvious to the user — they'll see the actual subject
  // we sent, not a generic "Reminder created".
  const label = subject.replace(/^\[Award setup\]\s*/, "");
  try {
    await createTask.mutateAsync({
      opportunityId,
      body: {
        Subject: subject,
        ActivityDate: dueIso,
        Description: description,
      },
    });
    toast.success(`Reminder created: "${label}" — due ${dueIso}`);
  } catch (e) {
    toast.error(`Couldn't create reminder: ${errorMessage(e)}`);
  }
}

function errorMessage(e: unknown): string {
  const err = e as {
    response?: { data?: { detail?: string | { message?: string } } };
    message?: string;
  };
  const detail = err.response?.data?.detail;
  if (typeof detail === "string") return detail;
  return detail?.message ?? err.message ?? "Unknown error";
}
