import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Advisory data-hygiene flags for the pipeline review.
 *
 * The rules live on the server (services/pipeline_review.py) because four of
 * the five test PAYMENT fields, and the grid never loads payments. What comes
 * back is already reduced to "which cells to tint, and why".
 */

/** A payment behind a payment-level hit, so the cell can name it on hover. */
export interface FlaggedPayment {
  id: string;
  name: string | null;
  scheduled_date: string | null;
  amount: number | null;
  rules: string[];
}

export interface OpportunityFlags {
  /** Grid column key → the rules that tinted it. Keys match ColKey in Pipeline.tsx. */
  cells: Record<string, string[]>;
  payments: FlaggedPayment[];
}

export interface ReviewRule {
  key: string;
  label: string;
}

export interface PipelineReviewFlags {
  generated_at: string | null;
  severity: "advisory";
  rules: ReviewRule[];
  /** Only opportunities that tripped at least one rule appear here. */
  flagged: Record<string, OpportunityFlags>;
}

const EMPTY: PipelineReviewFlags = {
  generated_at: null,
  severity: "advisory",
  rules: [],
  flagged: {},
};

export function usePipelineReviewFlags() {
  return useQuery<PipelineReviewFlags>({
    queryKey: ["pipeline-review-flags"],
    queryFn: async () => {
      const { data } = await api.get<PipelineReviewFlags>(
        "/api/salesforce/pipeline-review-flags",
      );
      return data ?? EMPTY;
    },
    // Two bulk SOQL queries behind this; the server caches it too. Nothing here
    // is worth refetching on every focus.
    staleTime: 5 * 60_000,
    // Flags are advisory decoration. If they fail, the grid must still work —
    // so no retry storm and no error surfaced to the page.
    retry: false,
  });
}

/** Rule key → human sentence, for the hover text. */
export function ruleLabels(flags?: PipelineReviewFlags): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of flags?.rules ?? []) out[r.key] = r.label;
  return out;
}

/**
 * Salesforce deep link for an opportunity.
 *
 * Angie reviews with Salesforce open alongside Bedrock — she needs fields
 * Bedrock doesn't surface (secondary owner, the closed-lost reason Erica
 * added) and wants them in a separate tab so the review keeps its filters.
 * Host matches services/files.ts, which already builds Lightning URLs.
 */
export function salesforceOpportunityUrl(id: string): string {
  return `https://joinpursuit.lightning.force.com/lightning/r/Opportunity/${encodeURIComponent(id)}/view`;
}
