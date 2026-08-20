import { useMemo, useRef, useState } from "react";
import { Plus, Search, Trash2, X } from "lucide-react";

import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { sortBy, useSort } from "@/lib/sort";
import { useDeleteTask, useUpdateTask } from "@/services/opportunities";
import { cn } from "@/lib/utils";
import type { SfTask } from "@/types/salesforce";

type TaskSortKey = "subject" | "status" | "due";

const STATUS_OPTIONS = [
  { value: "Not Started", label: "Not Started" },
  { value: "In Progress", label: "In Progress" },
  { value: "Waiting on someone else", label: "Waiting" },
  { value: "Deferred", label: "Deferred" },
  { value: "Completed", label: "Completed" },
];

export function isTaskClosed(t: SfTask): boolean {
  if (t.IsClosed != null) return !!t.IsClosed;
  return t.Status === "Completed";
}

function isOverdue(t: SfTask): boolean {
  if (!t.ActivityDate || isTaskClosed(t)) return false;
  const due = new Date(t.ActivityDate);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

/**
 * Editable task list rendered in the same Payments-style table the
 * other expand-tabs use: bordered card, sticky thead with column
 * labels, inline-edit cells. `onCreate` is optional — when provided,
 * the "add task" row sits inside the same card under the table.
 *
 * `contextResolver` returns a per-row label (e.g. parent opp name)
 * shown as a subtitle line under the subject — used by the Account
 * panel for tasks rolled up from child opps.
 */
/** Payload from the inline new-task row. Subject is required;
 *  assignee + due date are optional and only sent to the backend
 *  when set by the user. */
export interface NewTaskInput {
  subject: string;
  ownerId?: string | null;
  activityDate?: string | null;
}

export function TaskListTab({
  tasks,
  isLoading,
  emptyMessage = "No open tasks.",
  placeholder = "Add a task — press Enter to create",
  onCreate,
  ownerOptions,
  contextResolver,
  unstyled = false,
}: {
  tasks: SfTask[];
  isLoading: boolean;
  emptyMessage?: string;
  placeholder?: string;
  /** Receives the full new-task input. Subject is always present;
   *  ownerId and activityDate are present only when the user filled
   *  the corresponding inline control. */
  onCreate?: (input: NewTaskInput) => Promise<void>;
  /** Active users to surface in the assignee picker. When omitted,
   *  the picker is hidden and the row only accepts subject + date. */
  ownerOptions?: { value: string; label: string }[];
  contextResolver?: (t: SfTask) => string | null;
  /** When true, drop the outer wrapper padding + border so the
   *  table renders edge-to-edge inside an already-bordered Section.
   *  Used by the AwardDetail Tasks panel. */
  unstyled?: boolean;
}) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  // Tap the overdue counter to filter the list. State is local to the
  // panel so different parent records (per-account, per-owner) each
  // keep their own toggle.
  const [overdueOnly, setOverdueOnly] = useState(false);
  // Open / Completed / All scope. Defaults to open; completed tasks are
  // returned by the backend already, just hidden until you switch.
  const [scope, setScope] = useState<"open" | "completed" | "all">("open");
  const [query, setQuery] = useState("");
  const { sort, toggle } = useSort<TaskSortKey>();

  const open = useMemo(
    () => tasks.filter((t) => !isTaskClosed(t)),
    [tasks],
  );
  const closed = useMemo(
    () => tasks.filter((t) => isTaskClosed(t)),
    [tasks],
  );
  const overdueCount = useMemo(
    () => open.filter(isOverdue).length,
    [open],
  );
  const visible = useMemo(() => {
    let base = scope === "open" ? open : scope === "completed" ? closed : [...open, ...closed];
    if (scope === "open" && overdueOnly) base = base.filter(isOverdue);
    const q = query.trim().toLowerCase();
    const filtered = base.filter((t) => {
      if (!q) return true;
      if ((t.Subject ?? "").toLowerCase().includes(q)) return true;
      if ((t.Status ?? "").toLowerCase().includes(q)) return true;
      if ((t.WhatName ?? "").toLowerCase().includes(q)) return true;
      return false;
    });
    if (sort.key == null) return filtered;
    return sortBy(filtered, sort, (t, key) => {
      switch (key) {
        case "subject": return t.Subject ?? "";
        case "status": return t.Status ?? "";
        case "due": return t.ActivityDate ?? "";
      }
    });
  }, [open, closed, scope, overdueOnly, query, sort]);

  const saveStatus = (id: string, status: string) =>
    updateTask.mutateAsync({ id, patch: { Status: status } }).then(() => undefined);
  const saveDate = (id: string, date: string | null) =>
    updateTask.mutateAsync({ id, patch: { ActivityDate: date } }).then(() => undefined);
  const saveOwner = (id: string, ownerId: string) =>
    updateTask.mutateAsync({ id, patch: { OwnerId: ownerId } }).then(() => undefined);
  const saveSubject = (id: string, subject: string) =>
    updateTask.mutateAsync({ id, patch: { Subject: subject } }).then(() => undefined);
  const removeTask = (t: SfTask) => {
    if (t.Id.startsWith("__tmp__")) return; // optimistic row, not yet on the server
    const confirmed = window.confirm(
      `Delete task "${t.Subject ?? "(no subject)"}"? This can't be undone.`,
    );
    if (!confirmed) return;
    void deleteTask.mutateAsync(t.Id);
  };
  const toggleComplete = (t: SfTask) =>
    void updateTask.mutateAsync({
      id: t.Id,
      patch: { Status: isTaskClosed(t) ? "Not Started" : "Completed" },
    });

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-wider text-ink-3">
        <div className="flex items-center gap-3">
          {/* Open / Completed / All scope toggle */}
          <div className="inline-flex rounded border border-border-strong bg-surface-2 p-0.5">
            {([["open", "Open", open.length], ["completed", "Completed", closed.length], ["all", "All", open.length + closed.length]] as const).map(
              ([s, label, n]) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setScope(s); if (s !== "open") setOverdueOnly(false); }}
                  className={cn(
                    "rounded px-2 py-0.5 text-[10.5px] font-semibold normal-case transition-colors",
                    scope === s ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
                  )}
                >
                  {label} <span className="tabular-nums opacity-70">{n}</span>
                </button>
              ),
            )}
          </div>
          {overdueOnly ? (
            <button
              type="button"
              onClick={() => setOverdueOnly(false)}
              className="normal-case text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              showing overdue — show all open
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          {scope === "open" && overdueCount > 0 ? (
            <button
              type="button"
              onClick={() => setOverdueOnly((v) => !v)}
              className={cn(
                "font-semibold text-amber-700 underline-offset-2 hover:underline",
                overdueOnly && "underline",
              )}
              aria-pressed={overdueOnly}
              title={overdueOnly ? "Show all open tasks" : "Show overdue only"}
            >
              {overdueCount} overdue
            </button>
          ) : null}
          {tasks.length > 0 ? <TaskSearchBox value={query} onChange={setQuery} /> : null}
        </div>
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading tasks…</div>
      ) : (
        <div
          className={cn(
            "max-w-full",
            unstyled
              ? "block"
              : "overflow-hidden rounded border border-border-strong bg-surface",
          )}
        >
          {/* w-full + table-fixed with an unsized Subject column: the fixed
              columns keep their widths and Subject absorbs whatever the
              panel has left, so the table can never force horizontal
              scrolling inside an expanded row. */}
          <table className="w-full table-fixed text-[12px]">
            <colgroup>
              <col style={{ width: 36 }} />
              <col />
              <col style={{ width: 150 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 42 }} />
            </colgroup>
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-2 py-1.5"></th>
                <th className="px-2 py-1.5 text-left font-semibold">
                  <SortableHeader label="Subject" sortKey="subject" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-2 py-1.5 text-left font-semibold">
                  <SortableHeader label="Status" sortKey="status" sort={sort} onToggle={toggle} />
                </th>
                <th className="px-2 py-1.5 text-left font-semibold">
                  Owner
                </th>
                <th className="px-2 py-1.5 text-right font-semibold">
                  <SortableHeader label="Due" sortKey="due" sort={sort} onToggle={toggle} align="right" />
                </th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-5 text-center text-[12px] italic text-ink-3"
                  >
                    {overdueOnly
                      ? "No overdue tasks."
                      : scope === "completed"
                        ? "No completed tasks."
                        : scope === "all"
                          ? "No tasks."
                          : emptyMessage}
                  </td>
                </tr>
              ) : (
                visible.map((t) => (
                  <TaskRow
                    key={t.Id}
                    t={t}
                    ownerOptions={ownerOptions ?? []}
                    contextLabel={contextResolver?.(t) ?? null}
                    onToggleComplete={() => toggleComplete(t)}
                    onSaveSubject={(s) => saveSubject(t.Id, s)}
                    onSaveStatus={(s) => saveStatus(t.Id, s)}
                    onSaveDate={(d) => saveDate(t.Id, d)}
                    onSaveOwner={(o) => saveOwner(t.Id, o)}
                    onDelete={() => removeTask(t)}
                  />
                ))
              )}
            </tbody>
          </table>
          {onCreate && !overdueOnly && scope !== "completed" ? (
            <NewTaskRow placeholder={placeholder} onCreate={onCreate} ownerOptions={ownerOptions} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  t,
  ownerOptions,
  contextLabel,
  onToggleComplete,
  onSaveSubject,
  onSaveStatus,
  onSaveDate,
  onSaveOwner,
  onDelete,
}: {
  t: SfTask;
  ownerOptions: { value: string; label: string }[];
  contextLabel: string | null;
  onToggleComplete: () => void;
  onSaveSubject: (next: string) => Promise<void>;
  onSaveStatus: (next: string) => Promise<void>;
  onSaveDate: (next: string | null) => Promise<void>;
  onSaveOwner: (next: string) => Promise<void>;
  onDelete: () => void;
}) {
  const closed = isTaskClosed(t);
  const overdue = isOverdue(t);
  const isOptimistic = t.Id.startsWith("__tmp__");
  return (
    <tr
      className={cn(
        "group border-t border-border-strong",
        closed && "text-ink-3",
      )}
    >
      <td className="px-2 py-1.5 align-middle">
        <input
          type="checkbox"
          checked={closed}
          onChange={onToggleComplete}
          className="h-3.5 w-3.5 cursor-pointer"
          aria-label={closed ? "Reopen task" : "Mark complete"}
        />
      </td>
      <td className="px-2 py-1.5 align-middle">
        <InlineText
          value={t.Subject ?? ""}
          onSave={onSaveSubject}
          placeholder="(no subject)"
          className={cn("text-[12.5px]", closed && "line-through")}
        />
        {contextLabel ? (
          <span
            className="block truncate text-[10.5px] text-ink-3"
            title={contextLabel}
          >
            {contextLabel}
          </span>
        ) : null}
      </td>
      <td className="px-2 py-1.5 align-middle">
        <InlineSelect
          value={t.Status ?? null}
          options={STATUS_OPTIONS}
          onSave={onSaveStatus}
        />
      </td>
      <td className="px-2 py-1.5 align-middle">
        {ownerOptions.length > 0 ? (
          <InlineSelect
            value={t.OwnerId ?? null}
            options={ownerOptions}
            onSave={onSaveOwner}
            renderValue={() => (
              <span className="block truncate text-[12px] text-ink-2" title={t.OwnerName ?? undefined}>
                {t.OwnerName ?? ownerOptions.find((o) => o.value === t.OwnerId)?.label ?? "—"}
              </span>
            )}
          />
        ) : (
          <span className="block truncate text-[12px] text-ink-3" title={t.OwnerName ?? undefined}>
            {t.OwnerName ?? "—"}
          </span>
        )}
      </td>
      <td
        className={cn(
          "px-2 py-1.5 align-middle text-right",
          overdue && "text-red",
        )}
      >
        <InlineDate
          value={t.ActivityDate}
          onSave={onSaveDate}
          align="right"
          placeholder="—"
        />
      </td>
      <td className="px-1 py-1.5 align-middle text-right">
        <button
          type="button"
          onClick={onDelete}
          disabled={isOptimistic}
          aria-label="Delete task"
          title={isOptimistic ? "Saving…" : "Delete task"}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
        >
          <Trash2 size={13} className="text-ink-3 hover:text-red" />
        </button>
      </td>
    </tr>
  );
}

function NewTaskRow({
  onCreate,
  placeholder,
  ownerOptions,
}: {
  onCreate: (input: NewTaskInput) => Promise<void>;
  placeholder: string;
  ownerOptions?: { value: string; label: string }[];
}) {
  const [subject, setSubject] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the row the instant Enter is pressed so the user can keep
  // typing more tasks without waiting for the server. The mutation
  // runs in the background; React Query's optimistic insert on
  // useCreateTask makes the new row appear in the list immediately.
  //
  // Also schedule a focus on the next frame: the optimistic insert
  // triggers a parent re-render that can briefly steal focus on slow
  // hardware. Re-focusing after the commit keeps the input live so
  // the user can keep typing without grabbing the mouse.
  const submit = () => {
    const trimmed = subject.trim();
    if (!trimmed) return;
    const payload = {
      subject: trimmed,
      ownerId: ownerId || null,
      activityDate: dueDate || null,
    };
    setSubject("");
    setOwnerId("");
    setDueDate("");
    void onCreate(payload);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border-strong bg-surface-2/40 px-4 py-1.5">
      <Plus size={13} className="flex-shrink-0 text-ink-3" />
      <input
        ref={inputRef}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        className="min-w-[180px] flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-4"
      />
      {ownerOptions && ownerOptions.length > 0 ? (
        <select
          value={ownerId}
          onChange={(e) => setOwnerId(e.target.value)}
          title="Assignee"
          className="h-6 max-w-[140px] flex-shrink-0 rounded border border-border-strong bg-surface px-1.5 text-[11.5px] text-ink outline-none focus:border-accent"
        >
          <option value="">Assignee…</option>
          {ownerOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : null}
      <input
        type="date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        title="Due date"
        className="h-6 flex-shrink-0 rounded border border-border-strong bg-surface px-1.5 text-[11.5px] text-ink outline-none focus:border-accent"
      />
      {subject.trim() ? (
        <button
          type="button"
          onClick={submit}
          className="rounded border border-ink bg-ink px-2 py-0.5 text-[11px] font-medium text-surface hover:opacity-90"
        >
          Create
        </button>
      ) : null}
    </div>
  );
}

function TaskSearchBox({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <div className="relative">
      <Search
        size={11}
        className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-ink-4"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter tasks…"
        className="h-6 w-[160px] rounded border border-border-strong bg-surface pl-5 pr-5 text-[11.5px] normal-case outline-none focus:border-accent"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2"
          aria-label="Clear"
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );
}
