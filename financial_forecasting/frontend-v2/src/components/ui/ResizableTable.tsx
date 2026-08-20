import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Drag-reorder wiring for one header cell — see `useColumnDrag`. */
export type ColumnDrag = {
  onDragStart: () => void;
  onDragEnter: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  dragging?: boolean;
  dropEdge?: "left" | "right" | null;
};

/**
 * Spreadsheet-style column drag-reorder for a row of `ResizableTh` headers.
 * Owns the transient drag state; persistence happens in the `move` callback
 * (wire it to `useColumnVisibility().move`, which writes the reordered layout
 * to the same localStorage key as visibility toggles).
 *
 *   const colDrag = useColumnDrag(visibleCols, moveCol);
 *   <ResizableTh drag={colDrag(key)} ... />
 */
export function useColumnDrag<K extends string>(
  order: K[],
  move: (col: K, target: K) => void,
): (key: K) => ColumnDrag {
  // `dragCol` is what's moving, `dropCol` is what it's hovering.
  const [dragCol, setDragCol] = useState<K | null>(null);
  const [dropCol, setDropCol] = useState<K | null>(null);
  return (key: K) => ({
    onDragStart: () => setDragCol(key),
    onDragEnter: () => setDropCol(key),
    onDrop: () => {
      if (dragCol) move(dragCol, key);
      setDragCol(null);
      setDropCol(null);
    },
    onDragEnd: () => {
      setDragCol(null);
      setDropCol(null);
    },
    dragging: dragCol === key,
    // The line marks where the column will land: to the right of the target
    // when dragging rightwards, left when leftwards.
    dropEdge:
      dragCol && dropCol === key && dragCol !== key
        ? order.indexOf(dragCol) < order.indexOf(key)
          ? "right"
          : "left"
        : null,
  });
}

/**
 * <th> that renders an unobtrusive drag handle on its right edge.
 * Pair with `useColumnWidths` (lib/columnWidths.ts) to make table
 * columns user-resizable + persistent.
 */
export function ResizableTh({
  children,
  width,
  onStartResize,
  isLast,
  align = "left",
  className,
  drag,
}: {
  children: ReactNode;
  width: number;
  onStartResize: (e: React.PointerEvent) => void;
  isLast?: boolean;
  align?: "left" | "right";
  className?: string;
  /** Opt-in column reordering (from `useColumnDrag`). Omit and the header
   *  behaves exactly as before. `dropEdge` draws the insertion line while a
   *  column is dragged over this one; `dragging` dims the column being moved. */
  drag?: ColumnDrag;
}) {
  return (
    <th
      style={{ width }}
      draggable={drag ? true : undefined}
      onDragStart={drag ? () => drag.onDragStart() : undefined}
      onDragEnter={drag ? () => drag.onDragEnter() : undefined}
      // Without preventDefault the browser refuses the drop outright.
      onDragOver={drag ? (e) => e.preventDefault() : undefined}
      onDrop={drag ? (e) => { e.preventDefault(); drag.onDrop(); } : undefined}
      onDragEnd={drag ? () => drag.onDragEnd() : undefined}
      className={cn(
        "relative border-b border-border-strong bg-surface-2 px-3 py-2",
        align === "right" ? "text-right" : "text-left",
        drag && "cursor-grab active:cursor-grabbing",
        drag?.dragging && "opacity-40",
        className,
      )}
    >
      {/* Insertion line — a shadow of the column's landing spot, drawn inside
          the cell so it can't disturb the fixed table layout. */}
      {drag?.dropEdge ? (
        <span
          className={cn(
            "pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-accent",
            drag.dropEdge === "left" ? "left-0" : "right-0",
          )}
          aria-hidden
        />
      ) : null}
      {children}
      {!isLast ? (
        <span
          onPointerDown={onStartResize}
          // The resize strip must not become the drag source, or grabbing the
          // edge to widen a column would move it instead.
          draggable={false}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
          className="group absolute right-0 top-0 z-10 flex h-full w-1.5 cursor-col-resize touch-none items-center justify-center hover:bg-accent/40 active:bg-accent"
          aria-hidden
        >
          <span className="block h-full w-px bg-border-strong group-hover:bg-accent" />
        </span>
      ) : null}
    </th>
  );
}

/**
 * Renders a <colgroup> from a width map so the browser uses
 * `table-layout: fixed` widths authoritatively. Order matters — must
 * match the <th> / <td> order.
 */
export function ColGroup<K extends string>({
  order,
  widths,
}: {
  order: K[];
  widths: Record<K, number>;
}) {
  return (
    <colgroup>
      {order.map((k) => (
        <col key={k} style={{ width: widths[k] }} />
      ))}
    </colgroup>
  );
}
