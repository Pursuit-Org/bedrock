import { memo, useMemo, useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";

import { PageHeader } from "@/components/PageHeader";
import { ColGroup, ResizableTh, useColumnDrag } from "@/components/ui/ResizableTable";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Toolbar } from "@/components/ui/Toolbar";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { useCurrentUser } from "@/services/auth";
import { useProjects, useCreateProject, type BedrockProject } from "@/services/projects";
import { toast } from "sonner";

type OwnerFilter = "all" | "mine";
type ActivityFilter = "all" | "recent";
const RECENT_DAYS = 30;

type ColKey = "name" | "owner" | "created" | "updated";

const COLUMN_ORDER: ColKey[] = ["name", "owner", "created", "updated"];

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  name: 360,
  owner: 200,
  created: 130,
  updated: 130,
};

const COL_LABELS: Record<ColKey, string> = {
  name: "Project",
  owner: "Owner",
  created: "Created",
  updated: "Updated",
};

const ROW_HEIGHT = 44; // px — must match the row's actual rendered height

/** Stable router-state for outbound detail-page links so BackLinks
 *  render "Back to Projects". */
const PROJECTS_REFERRER = {
  from: { pathname: "/projects", label: "Projects" },
} as const;

function extractProject(p: BedrockProject, key: ColKey): unknown {
  switch (key) {
    case "name":
      return p.name;
    case "owner":
      return p.owner_email;
    case "created":
      return p.created_at;
    case "updated":
      return p.updated_at;
  }
}

export function ProjectsPage() {
  const { data, isLoading, isError, error } = useProjects();
  const { data: me } = useCurrentUser();
  const [q, setQ] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const navigate = useNavigate();

  const { sort, toggle } = useSort<ColKey>({
    key: "updated",
    direction: "desc",
  });
  const { widths, startResize } = useColumnWidths<ColKey>(
    "bedrock-v2:cols:projects",
    DEFAULT_WIDTHS,
  );
  // No column chooser here — every column stays visible — but the visibility
  // hook is still the store for a drag-reordered, persisted column order.
  const { visible: colOrder, move: moveCol } =
    useColumnVisibility<ColKey>("bedrock-v2:vis:projects", COLUMN_ORDER);
  const colDrag = useColumnDrag(colOrder, moveCol);

  const createProject = useCreateProject();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const p = await createProject.mutateAsync({ name: newName.trim() });
      setShowCreate(false);
      setNewName("");
      navigate(`/projects/${p.id}`, { state: PROJECTS_REFERRER });
      toast.success("Project created");
    } catch {
      toast.error("Failed to create project");
    }
  };

  const projects = data ?? [];

  const recentCutoff = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - RECENT_DAYS);
    return d.toISOString();
  }, []);
  const myEmail = me?.email?.toLowerCase() ?? "";

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    const f = projects.filter((p) => {
      if (ownerFilter === "mine") {
        if (!myEmail || (p.owner_email ?? "").toLowerCase() !== myEmail) return false;
      }
      if (activityFilter === "recent") {
        if (!p.updated_at || p.updated_at < recentCutoff) return false;
      }
      if (!ql) return true;
      return (
        p.name.toLowerCase().includes(ql) ||
        (p.description ?? "").toLowerCase().includes(ql) ||
        (p.owner_email ?? "").toLowerCase().includes(ql)
      );
    });
    return sortBy(f, sort, extractProject);
  }, [projects, q, ownerFilter, activityFilter, myEmail, recentCutoff, sort]);

  // Counts for the pill labels — computed off `projects` (pre-filter) so
  // pill counts don't drop to 0 as the user narrows.
  const counts = useMemo(() => {
    const mine = myEmail
      ? projects.filter((p) => (p.owner_email ?? "").toLowerCase() === myEmail).length
      : 0;
    const recent = projects.filter(
      (p) => p.updated_at && p.updated_at >= recentCutoff,
    ).length;
    return { all: projects.length, mine, recent };
  }, [projects, myEmail, recentCutoff]);

  const tableMinWidth = totalWidth(widths);

  // ── Virtualization ─────────────────────────────────────────────────
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

  return (
    <div className="flex h-full flex-col px-7 py-6 pb-6">
      <PageHeader
        title="Projects"
        subtitle={
          isLoading
            ? "Loading…"
            : `${projects.length.toLocaleString()} projects`
        }
        actions={
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90"
          >
            <Plus size={14} /> New project
          </button>
        }
      />

      {showCreate && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-border-strong bg-surface-2 px-4 py-3">
          <input
            autoFocus
            placeholder="Project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="h-8 flex-1 rounded border border-border-strong bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={!newName.trim() || createProject.isPending}
            className="h-8 rounded-md bg-ink px-4 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:opacity-40"
          >
            {createProject.isPending ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            onClick={() => { setShowCreate(false); setNewName(""); }}
            className="text-ink-3 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <Toolbar>
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            placeholder="Search projects, owner, description"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-72 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] text-ink outline-none focus:border-accent"
          />
        </div>

        <FilterPills<OwnerFilter>
          ariaLabel="Owner filter"
          value={ownerFilter}
          onChange={setOwnerFilter}
          options={[
            { value: "all", label: "All", count: counts.all },
            { value: "mine", label: "Mine", count: counts.mine },
          ]}
        />

        <FilterPills<ActivityFilter>
          ariaLabel="Activity filter"
          value={activityFilter}
          onChange={setActivityFilter}
          options={[
            { value: "all", label: "Any time" },
            { value: "recent", label: "Recent", count: counts.recent },
          ]}
        />

        <span className="ml-auto text-[11.5px] text-ink-3">
          {filtered.length.toLocaleString()} of{" "}
          {projects.length.toLocaleString()}
        </span>
      </Toolbar>

      {/*
        Single scroll container. Header is sticky, body is virtualized via
        spacer rows above + below the visible window. Total row count
        stays under ~30 in the DOM regardless of dataset size.
      */}
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
            ) : isError ? (
              <tr>
                <td
                  colSpan={COLUMN_ORDER.length}
                  className="px-7 py-10 text-center text-[13px] text-red"
                >
                  Failed to load projects
                  {error instanceof Error ? `: ${error.message}` : ""}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMN_ORDER.length}
                  className="px-7 py-10 text-center text-[13px] text-ink-3"
                >
                  {projects.length === 0
                    ? "No projects yet."
                    : "No projects match your search."}
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
                  const p = filtered[vi.index];
                  return (
                    <ProjectRow
                      key={p.id}
                      p={p}
                      order={colOrder}
                      onOpen={() => navigate(`/projects/${p.id}`, { state: PROJECTS_REFERRER })}
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

    </div>
  );
}

interface RowProps {
  p: BedrockProject;
  order: ColKey[];
  onOpen: () => void;
}

// Cells render in `order` so drag-reordered headers stay aligned with rows.
function renderCell(p: BedrockProject, key: ColKey) {
  switch (key) {
    case "name":
      return (
        <td key={key} className="overflow-hidden px-3 py-1 text-[13px]">
          <span
            className="block truncate font-medium hover:underline"
            title={p.name}
          >
            {p.name}
          </span>
          {p.description ? (
            <span
              className="block truncate text-[11.5px] text-ink-3"
              title={p.description}
            >
              {p.description}
            </span>
          ) : null}
        </td>
      );
    case "owner":
      return (
        <td key={key} className="overflow-hidden truncate px-3 py-1 text-[12.5px] text-ink-2">
          {p.owner_email ?? <span className="text-ink-4">—</span>}
        </td>
      );
    case "created":
      return (
        <td key={key} className="mono overflow-hidden truncate px-3 py-1 text-[11.5px] text-ink-3">
          {fmtDate(p.created_at)}
        </td>
      );
    case "updated":
      return (
        <td key={key} className="mono overflow-hidden truncate px-3 py-1 text-[11.5px] text-ink-3">
          {fmtDate(p.updated_at)}
        </td>
      );
  }
}

const ProjectRow = memo(function ProjectRow({ p, order, onOpen }: RowProps) {
  return (
    <tr
      className="group/row cursor-pointer border-b border-border-strong hover:bg-surface-2"
      style={{ height: ROW_HEIGHT }}
      onClick={onOpen}
    >
      {order.map((key) => renderCell(p, key))}
    </tr>
  );
});

interface FilterPillsProps<V extends string> {
  ariaLabel: string;
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: string; count?: number }[];
}

function FilterPills<V extends string>({
  ariaLabel,
  value,
  onChange,
  options,
}: FilterPillsProps<V>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex overflow-hidden rounded-md border border-border-strong bg-surface"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex items-center gap-1.5 border-l border-border-strong px-2.5 py-1 text-[11.5px] font-medium first:border-l-0",
              active
                ? "bg-ink text-surface"
                : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
            )}
          >
            <span>{opt.label}</span>
            {typeof opt.count === "number" ? (
              <span
                className={cn(
                  "rounded px-1 text-[10.5px] tabular-nums",
                  active ? "bg-surface/20" : "bg-surface-2 text-ink-3",
                )}
              >
                {opt.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

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
