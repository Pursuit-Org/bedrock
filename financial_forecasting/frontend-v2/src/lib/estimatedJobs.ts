/** Estimated jobs input → value to send.
 *  Blank → null (not estimated). A whole number 0–999 → that number.
 *  Anything else → undefined, which callers treat as invalid. */
export function parseEstimatedJobs(raw: string | null | undefined): number | null | undefined {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  if (!/^\d{1,3}$/.test(t)) return undefined;
  return Number(t);
}

/** Readable message from a failed API call (FastAPI `detail` or axios message). */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { detail?: unknown; error?: unknown } }; message?: string };
  const d = e?.response?.data?.detail ?? e?.response?.data?.error;
  if (typeof d === "string" && d) return d;
  if (Array.isArray(d) && d[0] && typeof d[0].msg === "string") return d[0].msg;
  return fallback;
}
