/**
 * Display helpers — match the mockup's conventions
 * (bedrock-mockup/project/primitives.jsx).
 */

/**
 * Compact currency for tables, summaries, footers. Always whole dollars
 * (rounds), uses K / M / B suffixes, one decimal up to 9.9, no decimal at
 * 10+. Negatives render as -$1.5K (sign before the dollar).
 */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null || n === 0) return "$0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);

  // Thresholds are slightly under each tier boundary so rounding never
  // produces "$1000K" or "$1000M" — those roll up to the next tier.
  if (abs >= 999_500_000_000) return `${sign}$${trimAbbr(abs / 1_000_000_000_000)}T`;
  if (abs >= 999_500_000)     return `${sign}$${trimAbbr(abs / 1_000_000_000)}B`;
  if (abs >= 999_500)         return `${sign}$${trimAbbr(abs / 1_000_000)}M`;
  if (abs >= 999.5)           return `${sign}$${trimAbbr(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

/** "1.5" up to 9.9; "16" at 10+; trims trailing ".0". */
function trimAbbr(n: number): string {
  if (n >= 10) return Math.round(n).toString();
  const r = Math.round(n * 10) / 10;
  return r % 1 === 0 ? r.toString() : r.toFixed(1);
}

const _moneyFullFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const _moneyFullCentsFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Full currency with commas. By default, whole dollars only (`$1,500`).
 * Pass `showCents` for two-decimal precision (`$1,500.50`) — appropriate
 * for line-item payment amounts where cents matter.
 */
export function fmtMoneyFull(
  n: number | null | undefined,
  showCents = false,
): string {
  const value = n ?? 0;
  return showCents
    ? _moneyFullCentsFormatter.format(value)
    : _moneyFullFormatter.format(value);
}

/**
 * SF returns date-only fields like ActivityDate / CloseDate as bare
 * "YYYY-MM-DD" strings. `new Date("2026-05-30")` parses those as UTC
 * midnight, which in any timezone west of UTC renders as the prior
 * day (May 29 in ET). Detect the date-only shape and construct a
 * local Date instead so the displayed day always matches what was
 * stored. Datetime strings (with a "T") still go through the normal
 * Date parser, since for those the time-of-day matters.
 */
function parseDateForDisplay(iso: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  return new Date(iso);
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = parseDateForDisplay(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = parseDateForDisplay(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Render a duration in ms as the largest sensible unit:
 *   < 60s    → "Ns"
 *   < 60m    → "Nm"
 *   < 24h    → "Nh"
 *   < 14d    → "Nd"
 *   < 60d    → "Nw"
 *   < 365d   → "Nmo"
 *   ≥ 365d   → "N.Yyr"
 *
 * Used by the StageProgression bar and other "time spent" displays.
 * Keeps output to 2-3 chars + unit so it fits in tight UI spots.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.round(min)}m`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)}h`;
  const day = hr / 24;
  if (day < 14) return `${Math.round(day)}d`;
  const week = day / 7;
  if (day < 60) return `${Math.round(week)}w`;
  if (day < 365) return `${Math.round(day / 30)}mo`;
  const yr = day / 365;
  return yr >= 10 ? `${Math.round(yr)}yr` : `${yr.toFixed(1)}yr`;
}

/** Compact relative day: "today", "3d", "2mo", "1y". Null-safe. */
export const relDay = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "1d" : d < 30 ? `${d}d` : d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
};
