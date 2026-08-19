import { type ReactNode } from "react";

import { cn } from "@/lib/utils";

type Variant = "default" | "accent" | "green" | "amber" | "red" | "sky" | "zinc";

const VARIANTS: Record<Variant, string> = {
  default: "bg-surface-2 text-ink-2 border border-border-strong",
  accent: "bg-accent-soft text-accent-ink border border-transparent",
  green: "bg-green-soft text-green border border-transparent",
  amber: "bg-amber-soft text-amber border border-transparent",
  red: "bg-red-soft text-red border border-transparent",
  sky: "bg-sky-soft text-sky border border-transparent",
  zinc: "bg-zinc-100 text-zinc-500 border border-transparent dark:bg-zinc-800 dark:text-zinc-400",
};

export function Tag({
  children,
  variant = "default",
  className,
}: {
  children: ReactNode;
  variant?: Variant;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium",
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
