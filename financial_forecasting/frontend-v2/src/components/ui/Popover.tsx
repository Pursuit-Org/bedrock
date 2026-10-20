import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

/**
 * Click-to-open panel around Radix Popover. Portalled, so a card with
 * `overflow: hidden` can't clip it. Usage:
 *
 *   <Popover content={<p>…</p>}>
 *     <button aria-label="How is this calculated?"><Info size={12} /></button>
 *   </Popover>
 *
 * Unlike <Tooltip>, it holds links and buttons, stays open until dismissed,
 * and is reachable by keyboard.
 */
export function Popover({
  content,
  children,
  side = "bottom",
  align = "start",
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            "z-50 w-80 max-w-[calc(100vw-24px)] rounded-lg border border-border bg-surface p-3 text-[12.5px] text-ink-2 shadow-lg",
            "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            className,
          )}
          // A click inside a card shouldn't also open the card's drill.
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** Closes the popover it sits in, for an action inside it. */
export const PopoverClose = PopoverPrimitive.Close;
