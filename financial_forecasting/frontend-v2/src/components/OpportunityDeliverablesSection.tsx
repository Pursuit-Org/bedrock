import { Plus, Trash2 } from "lucide-react";

import { SectionCard } from "@/components/detail";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { Tag } from "@/components/ui/Tag";
import { cn } from "@/lib/utils";
import {
  useCreateDeliverable,
  useDeleteDeliverable,
  useDeliverables,
  useUpdateDeliverable,
} from "@/services/deliverables";
import type { SfDeliverable } from "@/types/salesforce";

type DeliverableType = SfDeliverable["type"];

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "LOI", label: "LOI" },
  { value: "Application", label: "Application" },
  { value: "Interim Report", label: "Interim Report" },
  { value: "Final Report", label: "Final Report" },
];

function typeVariant(type: DeliverableType) {
  switch (type) {
    case "LOI":
      return "default" as const;
    case "Application":
      return "sky" as const;
    case "Interim Report":
      return "amber" as const;
    case "Final Report":
      return "green" as const;
    default:
      return "default" as const;
  }
}

function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  return new Date(dueDate) < new Date(new Date().toDateString());
}

function DeliverableRow({
  deliverable,
  onUpdateName,
  onUpdateType,
  onUpdateDueDate,
  onUpdateRequirements,
  onUpdateCloseDate,
  onDelete,
}: {
  deliverable: SfDeliverable;
  onUpdateName: (v: string) => Promise<void>;
  onUpdateType: (v: string | null) => Promise<void>;
  onUpdateDueDate: (v: string | null) => Promise<void>;
  onUpdateRequirements: (v: string) => Promise<void>;
  onUpdateCloseDate: (v: string | null) => Promise<void>;
  onDelete: () => void;
}) {
  const overdue =
    !deliverable.close_date && isOverdue(deliverable.due_date);

  return (
    <div className="group rounded border border-border-strong bg-surface px-3 py-2.5 space-y-1.5">
      {/* Row 1: name + type + due date + delete */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <InlineText
            value={deliverable.name ?? ""}
            placeholder="Untitled deliverable"
            onSave={onUpdateName}
            className="text-[13px] font-medium text-ink"
          />
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <InlineSelect
            value={deliverable.type ?? ""}
            options={[{ value: "", label: "No type" }, ...TYPE_OPTIONS]}
            onSave={(v) => onUpdateType(v || null)}
            renderValue={(v) =>
              v ? (
                <Tag variant={typeVariant(v as DeliverableType)}>{v}</Tag>
              ) : (
                <span className="text-[11px] text-ink-3">Type</span>
              )
            }
          />
          <div className={cn("text-[12px]", overdue ? "text-red" : "text-ink-3")}>
            <InlineDate
              value={deliverable.due_date}
              onSave={onUpdateDueDate}
            />
          </div>
          <button
            type="button"
            onClick={onDelete}
            className="invisible rounded p-0.5 text-ink-4 hover:text-red group-hover:visible"
            title="Delete deliverable"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Row 2: requirements */}
      <div className="pl-0.5">
        <InlineText
          value={deliverable.requirements ?? ""}
          placeholder="Requirements…"
          onSave={onUpdateRequirements}
          className="text-[12px] text-ink-2"
        />
      </div>

      {/* Row 3: submitted date — only shown when close_date is set */}
      {deliverable.close_date ? (
        <div className="flex items-center gap-1.5 pl-0.5 text-[11.5px] text-ink-3">
          <span>Submitted:</span>
          <InlineDate value={deliverable.close_date} onSave={onUpdateCloseDate} />
        </div>
      ) : (
        <div className="flex items-center gap-1.5 pl-0.5">
          <span className="text-[11px] text-ink-4">Mark submitted:</span>
          <InlineDate value={null} onSave={onUpdateCloseDate} />
        </div>
      )}
    </div>
  );
}

export function OpportunityDeliverablesSection({
  opportunityId,
}: {
  opportunityId: string;
}) {
  const { data: deliverables = [], isLoading } = useDeliverables(opportunityId);
  const create = useCreateDeliverable(opportunityId);
  const update = useUpdateDeliverable(opportunityId);
  const remove = useDeleteDeliverable(opportunityId);

  const handleAdd = () => {
    create.mutate({ name: "New deliverable" });
  };

  return (
    <SectionCard
      title="Deliverables"
      storageScope="opportunity"
      action={
        <button
          type="button"
          onClick={handleAdd}
          disabled={create.isPending}
          className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11.5px] text-surface hover:opacity-90 disabled:opacity-50"
        >
          <Plus size={11} /> Add
        </button>
      }
    >
      <div className="px-5 py-4">
        {isLoading ? (
          <div className="text-[12px] text-ink-3">Loading deliverables…</div>
        ) : deliverables.length === 0 ? (
          <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
            No deliverables yet. Add one to track submissions, reports, and deadlines.
          </div>
        ) : (
          <div className="space-y-2">
            {deliverables.map((d) => (
              <DeliverableRow
                key={d.id}
                deliverable={d}
                onUpdateName={(v) =>
                  update.mutateAsync({ id: d.id, patch: { name: v } }).then(() => undefined)
                }
                onUpdateType={(v) =>
                  update.mutateAsync({ id: d.id, patch: { type: v } }).then(() => undefined)
                }
                onUpdateDueDate={(v) =>
                  update.mutateAsync({ id: d.id, patch: { due_date: v } }).then(() => undefined)
                }
                onUpdateRequirements={(v) =>
                  update.mutateAsync({ id: d.id, patch: { requirements: v } }).then(() => undefined)
                }
                onUpdateCloseDate={(v) =>
                  update.mutateAsync({ id: d.id, patch: { close_date: v } }).then(() => undefined)
                }
                onDelete={() => remove.mutate(d.id)}
              />
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
