import { cn } from "@/lib/utils";
import { useCountUp } from "@/hooks/useCountUp";

// ── Palette ────────────────────────────────────────────────────────────────
// Bright, friendly gradients keyed to a metric "tone". Tuned to stay
// enterprise-credible: soft saturation, generous rounding, gentle shadow.

export type BubbleTone = "violet" | "emerald" | "amber" | "sky" | "rose";

interface ToneSpec {
  /** soft card background gradient */
  bg: string;
  /** ring / accent stroke */
  ring: string;
  /** big number text color */
  ink: string;
  /** track behind the ring */
  track: string;
  /** soft glow used on celebratory state */
  glow: string;
}

export const BUBBLE_TONES: Record<BubbleTone, ToneSpec> = {
  violet: {
    bg: "linear-gradient(150deg, #f4f3ff 0%, #ffffff 62%)",
    ring: "#6d5efc",
    ink: "#4f3fe0",
    track: "#e7e4ff",
    glow: "0 0 0 1px #d9d4ff, 0 8px 26px -10px rgba(109,94,252,0.55)",
  },
  emerald: {
    bg: "linear-gradient(150deg, #effbf4 0%, #ffffff 62%)",
    ring: "#15b87f",
    ink: "#0f9466",
    track: "#d6f4e6",
    glow: "0 0 0 1px #c4eedb, 0 8px 26px -10px rgba(21,184,127,0.5)",
  },
  amber: {
    bg: "linear-gradient(150deg, #fff8ec 0%, #ffffff 62%)",
    ring: "#f0a32b",
    ink: "#c47d12",
    track: "#fdeccd",
    glow: "0 0 0 1px #fbe2bb, 0 8px 26px -10px rgba(240,163,43,0.5)",
  },
  sky: {
    bg: "linear-gradient(150deg, #eef7ff 0%, #ffffff 62%)",
    ring: "#2f9bf0",
    ink: "#1f7fcf",
    track: "#d4ebfd",
    glow: "0 0 0 1px #c2e2fb, 0 8px 26px -10px rgba(47,155,240,0.5)",
  },
  rose: {
    bg: "linear-gradient(150deg, #fff0f5 0%, #ffffff 62%)",
    ring: "#ec4f8c",
    ink: "#cf3273",
    track: "#fbd9e7",
    glow: "0 0 0 1px #f8c8dc, 0 8px 26px -10px rgba(236,79,140,0.5)",
  },
};

// ── Progress ring ────────────────────────────────────────────────────────────

function ProgressRing({
  pct,
  tone,
  size = 46,
  stroke = 5,
  children,
}: {
  pct: number;
  tone: ToneSpec;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * c;

  return (
    <div
      className="relative flex flex-shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone.track}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone.ring}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          style={{ transition: "stroke-dasharray 700ms cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      {children ? (
        <div className="absolute inset-0 flex items-center justify-center">
          {children}
        </div>
      ) : null}
    </div>
  );
}

// ── Number formatting ────────────────────────────────────────────────────────

export type ValueFormat = "int" | "salary";

function formatAnimated(n: number, format: ValueFormat): string {
  const rounded = Math.round(n);
  if (format === "salary") {
    return `$${rounded.toLocaleString("en-US")}`;
  }
  return rounded.toLocaleString("en-US");
}

// ── Stat bubble ──────────────────────────────────────────────────────────────

export function JobsStatBubble({
  label,
  value,
  tone,
  icon,
  format = "int",
  sub,
  subLead,
  progressPct,
  progressLabel,
  celebrate = false,
  isLoading = false,
  big = false,
  onClick,
}: {
  label: string;
  /** numeric value to count-up to */
  value: number;
  tone: BubbleTone;
  icon?: React.ReactNode;
  format?: ValueFormat;
  /** small caption beneath the number */
  sub?: string;
  /** emphasized breakdown line right under the number */
  subLead?: React.ReactNode;
  /** 0–100, drives the ring; omit to hide the ring */
  progressPct?: number;
  /** centered label inside the ring (e.g. "80%") */
  progressLabel?: string;
  /** soft glow when a win is present (the ✨ badge was dropped 2026-08-04) */
  celebrate?: boolean;
  isLoading?: boolean;
  /** larger hero variant — bigger number, label, padding */
  big?: boolean;
  onClick?: () => void;
}) {
  const spec = BUBBLE_TONES[tone];
  const animated = useCountUp(isLoading ? 0 : value);
  const display = isLoading ? "—" : formatAnimated(animated, format);

  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={cn(
        "group relative flex flex-col rounded-2xl border border-white/60",
        big ? "gap-3 p-6" : "gap-2.5 p-4",
        "transition-[transform,box-shadow] duration-200",
        onClick && "cursor-pointer hover:-translate-y-0.5",
      )}
      style={{
        background: spec.bg,
        boxShadow: celebrate
          ? spec.glow
          : "0 1px 2px rgba(20,18,14,0.04), 0 6px 18px -12px rgba(20,18,14,0.25)",
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn("flex flex-shrink-0 items-center justify-center rounded-lg", big ? "h-8 w-8" : "h-6 w-6")}
          style={{ color: spec.ink, background: spec.track }}
        >
          {icon}
        </span>
        <span
          className={cn("font-semibold uppercase tracking-wider", big ? "text-[12.5px]" : "text-[10.5px]")}
          style={{ color: spec.ink }}
        >
          {label}
        </span>
      </div>

      <div className="flex items-end justify-between gap-2">
        <span
          className={cn("font-mono font-bold leading-none tabular-nums", big ? "text-[46px]" : "text-[30px]")}
          style={{ color: isLoading ? "var(--ink-4)" : spec.ink }}
        >
          {display}
        </span>
        {progressPct != null ? (
          <ProgressRing pct={isLoading ? 0 : progressPct} tone={spec} size={big ? 84 : 60} stroke={big ? 8 : 6}>
            {progressLabel ? (
              <span
                className={cn("font-mono font-bold tabular-nums", big ? "text-[17px]" : "text-[12.5px]")}
                style={{ color: spec.ink }}
              >
                {isLoading ? "" : progressLabel}
              </span>
            ) : null}
          </ProgressRing>
        ) : null}
      </div>

      {subLead ? (
        <span className={cn("font-medium text-ink-2", big ? "text-[13px]" : "text-[11px]")}>{subLead}</span>
      ) : null}
      {sub ? <span className={cn("text-ink-3", big ? "text-[12px]" : "text-[10.5px]")}>{sub}</span> : null}
    </div>
  );
}
