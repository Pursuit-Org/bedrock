// Display labels for opportunity fields stored as codes. Kept free of React and
// path aliases so `npm run test` (node --test) can import it directly.

/** Every value in CLOSED_LOST_REASONS in routes/jobs.py, including the ones the
 *  picker no longer offers, so older deals still read as words. */
export const CLOSED_LOST_LABELS: Record<string, string> = {
  budget: "No budget", timing: "Timing / not now", hired_elsewhere: "Hired elsewhere",
  not_a_fit: "Not a fit", no_response: "Went cold", role_cancelled: "Role cancelled",
  not_interested: "Not interested", not_selected: "Not selected",
  not_responsive: "Not responsive", revisit: "Revisit later", other: "Other",
};

/** Priority is stored 1–5 with 5 the highest and shown as P1, everywhere. The
 *  opportunity page offered P1 as 1, so a priority set there read as P5 on
 *  every other surface (PRO-110). */
export const PRIORITY_OPTIONS: { value: string; label: string }[] = [
  { value: "5", label: "P1 — Highest" },
  { value: "4", label: "P2 — High" },
  { value: "3", label: "P3 — Medium" },
  { value: "2", label: "P4 — Low" },
  { value: "1", label: "P5 — Lowest" },
];

export function closedLostLabel(reason: string): string {
  return CLOSED_LOST_LABELS[reason] ?? reason;
}

/** Heading for an opportunity with no title. Most deals are named by their
 *  account, so "Untitled opportunity" on every one of them said nothing (PLN-03). */
export function untitledOppHeading(accountName: string | null | undefined): string {
  const name = accountName?.trim();
  return name ? `${name} opportunity` : "Untitled opportunity";
}
