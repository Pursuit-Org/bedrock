import type { FunnelType } from "@/services/jobs";

// Kept free of React and path aliases so `npm run test` (node --test) can
// import it directly.

export const FUNNEL_NOUN: Record<FunnelType, string> = {
  opportunities: "companies",
  prospects: "contacts",
  builders: "builders",
};

// Snapshot mode: every bar is how many records sit in the stage right now. The
// opportunities subtitle used to say "transitions in the last 30d", which only
// describes the Recent Movement list inside each stage, not the counts (OVR-09).
const SNAPSHOT_SUBTITLE: Record<FunnelType, string> = {
  opportunities: "Employer deals in each stage now",
  prospects: "Jobs-pipeline contacts in each stage now",
  builders: "Builder applications by stage",
};

export function funnelSubtitle(funnel: FunnelType, isPeriod: boolean, periodLabel?: string): string {
  if (isPeriod) {
    return `${FUNNEL_NOUN[funnel]} that entered each stage${periodLabel ? ` · ${periodLabel}` : ""}`;
  }
  return SNAPSHOT_SUBTITLE[funnel];
}
