import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Host row for an expanded-row panel that must never require horizontal
 * scrolling. Tables that scroll sideways (minWidth from column widths)
 * make a plain `<td colSpan>` span the full table width, dragging the
 * panel off-screen with the scroll. This cell instead pins its content
 * to the visible left edge (`sticky left-0`) and caps its width to the
 * nearest horizontal scroll container's clientWidth, tracked with a
 * ResizeObserver.
 *
 * In tables with no horizontal scroller (SectionCard-wrapped `w-full`
 * tables) the fallback `w-0 min-w-full` keeps the panel at exactly the
 * cell's width without contributing intrinsic width — so a wide panel
 * can't stretch an auto-layout table past its container either.
 */
export function ExpandRow({
  colSpan,
  trClassName,
  tdClassName,
  tdStyle,
  children,
}: {
  colSpan: number;
  trClassName?: string;
  tdClassName?: string;
  tdStyle?: CSSProperties;
  children: ReactNode;
}) {
  const tdRef = useRef<HTMLTableCellElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const td = tdRef.current;
    if (!td) return;
    let scroller: HTMLElement | null = null;
    for (let el = td.parentElement; el; el = el.parentElement) {
      const { overflowX } = getComputedStyle(el);
      if (overflowX === "auto" || overflowX === "scroll") {
        scroller = el;
        break;
      }
    }
    if (!scroller) return;
    const el = scroller;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <tr className={trClassName}>
      <td ref={tdRef} colSpan={colSpan} className={cn("p-0", tdClassName)} style={tdStyle}>
        <div
          className="sticky left-0 w-0 min-w-full"
          // Inline minWidth overrides the min-w-full fallback once the
          // scroller is measured — 100% of a 2000px-wide cell would
          // otherwise defeat the cap.
          style={width ? { width, minWidth: width } : undefined}
        >
          {children}
        </div>
      </td>
    </tr>
  );
}
