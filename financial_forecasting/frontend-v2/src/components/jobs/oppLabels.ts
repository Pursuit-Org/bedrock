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

export function closedLostLabel(reason: string): string {
  return CLOSED_LOST_LABELS[reason] ?? reason;
}

/** Heading for an opportunity with no title. Most deals are named by their
 *  account, so "Untitled opportunity" on every one of them said nothing (PLN-03). */
export function untitledOppHeading(accountName: string | null | undefined): string {
  const name = accountName?.trim();
  return name ? `${name} opportunity` : "Untitled opportunity";
}
