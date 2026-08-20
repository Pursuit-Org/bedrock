import { memo, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { NewMyTaskRow } from "@/components/NewMyTaskRow";
import { PageHeader } from "@/components/PageHeader";
import {
  SourceBadge,
  TaskDrawer,
  priorityVariant,
  statusVariant,
  type FlatTask,
} from "@/components/TaskDrawer";
import { ColGroup, ResizableTh, useColumnDrag } from "@/components/ui/ResizableTable";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Tag } from "@/components/ui/Tag";
import { ButtonGroup, Toolbar } from "@/components/ui/Toolbar";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { fmtDate } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { cn } from "@/lib/utils";
import { useOpportunities } from "@/services/opportunities";
import { useAllProjectDetails } from "@/services/projects";
import { useMyTasks, type SfMyTask } from "@/services/tasks";
import type { SfOpportunity } from "@/types/salesforce";

// ── Filters ────────────────────────────────────────────────────────────

const SOURCE_FILTERS = [
  { value: "All", label: "All" },
  { value: "CRM", label: "CRM" },
  { value: "Projects", label: "Projects" },
] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number]["value"];

const STATUS_FILTERS = [
  { value: "Open", label: "Open" },
  { value: "Today", label: "Today" },
  { value: "Overdue", label: "Overdue" },
  { value: "Completed", label: "Completed" },
  { value: "All", label: "All" },
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

const COMPLETED_STATUSES = new Set([
  "completed",
  "closed",
  "done",
  "cancelled",
]);

function isCompleted(t: FlatTask): boolean {
  return COMPLETED_STATUSES.has((t.status ?? "").toLowerCase());
}

function isOverdue(t: FlatTask): boolean {
  if (!t.deadline) return false;
  if (isCompleted(t)) return false;
  const d = new Date(t.deadline).getTime();
  if (Number.isNaN(d)) return false;
  return d < Date.now() - 24 * 3600 * 1000;
}

function isToday(t: FlatTask): boolean {
  if (!t.deadline) return false;
  const d = new Date(t.deadline);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

// ── Columns ────────────────────────────────────────────────────────────

type ColKey =
  | "source"
  | "title"
  | "status"
  | "owner"
  | "deadline"
  | "priority";

const COLUMN_ORDER: ColKey[] = [
  "source",
  "title",
  "status",
  "owner",
  "deadline",
  "priority",
];

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  source: 88,
  title: 460,
  status: 130,
  owner: 170,
  deadline: 130,
  priority: 110,
};

const COL_LABELS: Record<ColKey, string> = {
  source: "Source",
  title: "Task",
  status: "Status",
  owner: "Owner",
  deadline: "Deadline",
  priority: "Priority",
};

const ROW_HEIGHT = 44;

function extract(t: FlatTask, key: ColKey): unknown {
  switch (key) {
    case "source": return t.source;
    case "title": return t.title;
    case "status": return t.status;
    case "owner": return t.owner;
    case "deadline": return t.deadline;
    case "priority": return t.priority;
  }
}

// ── Mappers ────────────────────────────────────────────────────────────

function sfToFlat(t: SfMyTask, oppById: Map<string, SfOpportunity>): FlatTask {
  const opp = t.WhatId ? oppById.get(t.WhatId) : undefined;
  // Prefer the opportunity name (richer than the formatted task's WhatName,
  // and lets us link to the opp detail page). Fall back to whatever SF
  // gave us via the WhatName lookup.
  const parentLabel = opp?.Name ?? t.WhatName ?? null;
  const parentLink =
    t.WhatId && opp ? `/opportunities/${t.WhatId}` : null;
  // Guard against junk SF subjects: ~1,266 SF Tasks have Subject literally set
  // to the string "true" (a boolean stringified by whatever created them), which
  // otherwise renders as a "true" task title. Treat true/false as untitled.
  const rawSubject = (t.Subject ?? "").trim();
  const cleanSubject = ["true", "false"].includes(rawSubject.toLowerCase()) ? "" : rawSubject;
  return {
    source: "crm",
    id: t.Id,
    title: cleanSubject || "(no subject)",
    status: t.Status ?? "Open",
    priority: t.Priority ?? null,
    owner: t.OwnerName ?? null,
    deadline: t.ActivityDate ?? null,
    description: t.Description ?? null,
    parentLabel,
    parentLink,
    type: t.Type ?? null,
  };
}

// ── Page ───────────────────────────────────────────────────────────────

export function TasksPage() {
  const myTasksQ = useMyTasks();
  const oppsQ = useOpportunities();
  const projectsQ = useAllProjectDetails();

  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("All");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("Open");
  const [q, setQ] = useState("");
  const [drawerTask, setDrawerTask] = useState<FlatTask | null>(null);

  const { sort, toggle } = useSort<ColKey>({
    key: "deadline",
    direction: "asc",
  });
  const { widths, startResize } = useColumnWidths<ColKey>(
    "bedrock-v2:cols:tasks",
    DEFAULT_WIDTHS,
  );
  // No column chooser here — every column stays visible — but the visibility
  // hook is still the store for a drag-reordered, persisted column order.
  const { visible: colOrder, move: moveCol } =
    useColumnVisibility<ColKey>("bedrock-v2:vis:tasks", COLUMN_ORDER);
  const colDrag = useColumnDrag(colOrder, moveCol);

  // Build a quick lookup for opp WhatId → SfOpportunity so CRM tasks can
  // resolve their parent name + link without a second fetch.
  const oppById = useMemo(() => {
    const m = new Map<string, SfOpportunity>();
    for (const o of oppsQ.data ?? []) m.set(o.Id, o);
    return m;
  }, [oppsQ.data]);

  const sfTasks = myTasksQ.data ?? [];
  const projectDetails = projectsQ.details;
  // Lookup: SF task id → SfMyTask, so the drawer can switch to inline
  // edit mode when the row's source === "crm".
  const sfTaskById = useMemo(() => {
    const m = new Map<string, SfMyTask>();
    for (const t of sfTasks) m.set(t.Id, t);
    return m;
  }, [sfTasks]);

  // ── Unified list ─────────────────────────────────────────────────────
  // CRM rows come from `/api/salesforce/my-tasks`. Project rows come from
  // walking projects → workstreams → milestones → tasks.
  const allTasks: FlatTask[] = useMemo(() => {
    const crmRows: FlatTask[] = sfTasks.map((t) => sfToFlat(t, oppById));

    const projectRows: FlatTask[] = [];
    for (const p of projectDetails) {
      for (const w of p.workstreams ?? []) {
        for (const m of w.milestones ?? []) {
          for (const t of m.tasks ?? []) {
            projectRows.push({
              source: "project",
              id: t.id,
              title: t.title,
              status: t.status,
              priority: null, // project tasks have no Priority field
              owner: t.owner,
              deadline: t.deadline,
              description: t.description,
              parentLabel: `${p.name} · ${m.title}`,
              parentLink: p.id ? `/projects/${p.id}` : null,
            });
          }
        }
      }
    }

    return [...crmRows, ...projectRows];
  }, [sfTasks, oppById, projectDetails]);

  const crmCount = sfTasks.length;
  const projectCount = allTasks.length - crmCount;

  // ── Filtering + sort ─────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = allTasks.filter((t) => {
      // Source filter
      if (sourceFilter === "CRM" && t.source !== "crm") return false;
      if (sourceFilter === "Projects" && t.source !== "project") return false;

      // Status filter
      if (statusFilter === "Open" && isCompleted(t)) return false;
      if (statusFilter === "Completed" && !isCompleted(t)) return false;
      if (statusFilter === "Overdue" && !isOverdue(t)) return false;
      if (statusFilter === "Today" && !isToday(t)) return false;
      // "All" → no status gate

      // Search (title / owner / parent)
      if (needle) {
        const hay =
          (t.title ?? "").toLowerCase() +
          " " +
          (t.owner ?? "").toLowerCase() +
          " " +
          (t.parentLabel ?? "").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    return sortBy(out, sort, extract);
  }, [allTasks, sourceFilter, statusFilter, q, sort]);

  const isLoading =
    myTasksQ.isLoading || oppsQ.isLoading || projectsQ.isLoading;
  const isProjectsError = projectsQ.isError;

  // ── Virtualization ───────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom =
    totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  const tableMinWidth = totalWidth(widths);

  // Subtitle uses the unfiltered totals so it reads as "what we know
  // about", not "what's currently visible".
  const subtitle = isLoading
    ? "Loading…"
    : `${filtered.length.toLocaleString()} of ${allTasks.length.toLocaleString()} tasks · ${crmCount.toLocaleString()} CRM · ${projectCount.toLocaleString()} project`;

  return (
    <div className="flex h-full flex-col px-7 py-6 pb-6">
      <PageHeader title="Tasks" subtitle={subtitle} />

      {/* Status banner — only surface if something is unusual.
          If CRM is 0, that almost always means SF isn't connected for this
          user (or they have no open tasks). Don't render that as an error. */}
      {!isLoading && crmCount === 0 && projectCount > 0 ? (
        <div className="mb-3 rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-[11.5px] text-ink-3">
          No Salesforce tasks loaded. Showing{" "}
          <span className="font-medium text-ink-2">
            {projectCount.toLocaleString()} project tasks
          </span>{" "}
          only — connect Salesforce in Settings to unify CRM tasks here.
        </div>
      ) : null}
      {!isLoading && isProjectsError ? (
        <div className="mb-3 rounded-md border border-red/40 bg-red-soft px-3 py-2 text-[11.5px] text-red">
          Couldn't load Bedrock project tasks. CRM tasks still shown.
        </div>
      ) : null}

      <NewMyTaskRow />

      <Toolbar>
        <ButtonGroup
          value={sourceFilter}
          onChange={(v) => setSourceFilter(v as SourceFilter)}
          options={SOURCE_FILTERS.map((s) => ({
            value: s.value,
            label: s.label,
          }))}
        />
        <ButtonGroup
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
          options={STATUS_FILTERS.map((s) => ({
            value: s.value,
            label: s.label,
          }))}
        />
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            placeholder="Search title, owner, project, account"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-80 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] text-ink outline-none focus:border-accent"
          />
        </div>
        <span className="ml-auto text-[11.5px] text-ink-3">
          {filtered.length.toLocaleString()}
        </span>
      </Toolbar>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto rounded-b-lg border border-border-strong bg-surface"
      >
        <table
          className="border-collapse"
          style={{
            tableLayout: "fixed",
            width: "100%",
            minWidth: tableMinWidth,
          }}
        >
          <ColGroup order={colOrder} widths={widths} />
          <thead className="sticky top-0 z-10">
            <tr>
              {colOrder.map((key, idx) => (
                <ResizableTh
                  key={key}
                  width={widths[key]}
                  onStartResize={(e) => startResize(key, e)}
                  align="left"
                  isLast={idx === colOrder.length - 1}
                  drag={colDrag(key)}
                >
                  <SortableHeader
                    label={COL_LABELS[key]}
                    sortKey={key}
                    sort={sort}
                    onToggle={toggle}
                  />
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <SkeletonRows />
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMN_ORDER.length}
                  className="px-7 py-10 text-center text-[13px] text-ink-3"
                >
                  {allTasks.length === 0
                    ? "No tasks. Connect Salesforce or create a project task."
                    : "No tasks match your filters."}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 ? (
                  <tr aria-hidden style={{ height: paddingTop }}>
                    <td colSpan={COLUMN_ORDER.length} />
                  </tr>
                ) : null}
                {virtualItems.map((vi) => {
                  const t = filtered[vi.index];
                  return (
                    <TaskRow
                      key={`${t.source}:${t.id}`}
                      t={t}
                      order={colOrder}
                      onOpen={() => setDrawerTask(t)}
                    />
                  );
                })}
                {paddingBottom > 0 ? (
                  <tr aria-hidden style={{ height: paddingBottom }}>
                    <td colSpan={COLUMN_ORDER.length} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>

      <TaskDrawer
        task={drawerTask}
        rawTask={
          drawerTask?.source === "crm"
            ? (sfTaskById.get(drawerTask.id) as SfMyTask | undefined) ?? null
            : null
        }
        onClose={() => setDrawerTask(null)}
      />
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────────

interface RowProps {
  t: FlatTask;
  order: ColKey[];
  onOpen: () => void;
}

// Cells render in `order` so drag-reordered headers stay aligned with rows.
function renderCell(t: FlatTask, key: ColKey) {
  switch (key) {
    case "source":
      return (
        <td key={key} className="overflow-hidden px-3 py-1">
          <SourceBadge source={t.source} />
        </td>
      );
    case "title":
      return (
        <td key={key} className="overflow-hidden px-3 py-1 text-[13px]">
          <div className="flex flex-col leading-tight">
            <span className="truncate font-medium" title={t.title}>
              {t.title}
            </span>
            {t.parentLabel ? (
              <span
                className="truncate text-[11.5px] text-ink-3"
                title={t.parentLabel}
              >
                {t.parentLabel}
              </span>
            ) : null}
          </div>
        </td>
      );
    case "status":
      return (
        <td key={key} className="overflow-hidden px-3 py-1 text-[13px]">
          <Tag variant={statusVariant(t.status)}>{t.status || "—"}</Tag>
        </td>
      );
    case "owner":
      return (
        <td key={key} className="overflow-hidden truncate px-3 py-1 text-[12.5px] text-ink-2">
          {t.owner || <span className="text-ink-4">—</span>}
        </td>
      );
    case "deadline":
      return (
        <td
          key={key}
          className={cn(
            "mono overflow-hidden px-3 py-1 text-[11.5px] tabular-nums",
            isOverdue(t) ? "font-semibold text-red" : "text-ink-3",
          )}
        >
          {fmtDate(t.deadline)}
        </td>
      );
    case "priority":
      return (
        <td key={key} className="overflow-hidden px-3 py-1 text-[12.5px]">
          {t.source === "crm" && t.priority ? (
            <Tag variant={priorityVariant(t.priority)}>{t.priority}</Tag>
          ) : (
            <span className="text-ink-4">—</span>
          )}
        </td>
      );
  }
}

const TaskRow = memo(function TaskRow({ t, order, onOpen }: RowProps) {
  return (
    <tr
      className="cursor-pointer border-b border-border-strong hover:bg-surface-2"
      style={{ height: ROW_HEIGHT }}
      onClick={onOpen}
    >
      {order.map((key) => renderCell(t, key))}
    </tr>
  );
});

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="border-b border-border-strong">
          <td colSpan={COLUMN_ORDER.length} className="px-3 py-2.5">
            <div className="h-4 w-full animate-pulse rounded bg-surface-2" />
          </td>
        </tr>
      ))}
    </>
  );
}
