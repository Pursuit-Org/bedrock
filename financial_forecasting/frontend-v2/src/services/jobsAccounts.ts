import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ActivityEntry, CallKind } from "@/services/jobs";

// ── Types ────────────────────────────────────────────────────────────────────

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export interface AccountGroupContact {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  contact_stage: string | null;
  linkedin_url: string | null;
}

export interface AccountGroup {
  account: string;
  contact_count: number;
  contacts: AccountGroupContact[];
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * GET /api/jobs/contacts/by-account → AccountGroup[]
 * Prospects grouped by account, already ordered by contact_count desc.
 */
export function useAccountsByAccount(dealType?: string) {
  return useQuery<AccountGroup[]>({
    queryKey: ["jobs", "contacts-by-account", dealType ?? "all"],
    queryFn: async () => {
      const qs = dealType && dealType !== "all" ? `?deal_type=${dealType}` : "";
      const { data } = await api.get<ApiResponse<AccountGroup[]>>(
        `/api/jobs/contacts/by-account${qs}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

/** "email" backfills a send the Gmail sync missed; the API shapes it like a
 *  synced email so it lands in the same emailed-contacts metric. */
export type ProspectActivityType = "call" | "text" | "linkedin" | "email";

export interface ProspectActivityBody {
  contact_id: number;
  type: ProspectActivityType;
  description: string;
  /** ISO date — lets a call/text from a few days ago be logged retroactively
   *  (TKT-126). Omitted → the server stamps now(). */
  activity_date?: string;
  /** Discovery or general — only meaningful on a call, and dropped server-side
   *  on anything else. The Activity Pipeline's Discovery Calls row is only as
   *  good as this answer, and the person who just had the call is the only one
   *  who can give it. */
  call_kind?: CallKind | null;
}

/**
 * POST /api/jobs/activity with a contact-scoped activity.
 * The backend accepts contact_id (type ∈ call|text|linkedin) and links the
 * activity to the contact rather than a deal. Invalidates the contact detail
 * query so the timeline refreshes.
 */
export function useLogProspectActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ProspectActivityBody) => {
      const { data } = await api.post<ApiResponse<ActivityEntry>>(
        "/api/jobs/activity",
        body,
      );
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "contact", vars.contact_id] });
      qc.invalidateQueries({ queryKey: ["jobs", "contacts-by-account"] });
      toast.success("Activity logged");
    },
    onError: () => toast.error("Failed to log activity"),
  });
}


// ── Facilitated intros ───────────────────────────────────────────────────────

/** A staff member who can be named as the connector on a logged intro. */
export interface IntroConnector {
  staff_user_id: number;
  display_name: string | null;
  email: string | null;
}

/** Everyone the intro can be attributed to.
 *
 *  The whole staff map, not just the people with an imported LinkedIn
 *  connection to this contact: an intro that already happened is not evidence
 *  we imported the connection. Rarely changes, so it caches for the session. */
export function useIntroConnectors() {
  return useQuery({
    queryKey: ["jobs", "intro-connectors"],
    queryFn: async (): Promise<IntroConnector[]> => {
      const { data } = await api.get<ApiResponse<IntroConnector[]>>("/api/jobs/intro-connectors");
      return data.data ?? [];
    },
    staleTime: 30 * 60_000,
  });
}

/** The ask types a facilitated intro can carry, mirroring ASK_LABELS on the
 *  server. Free text lives in the note, not here. */
export const INTRO_ASKS: { value: string; label: string }[] = [
  { value: "hiring_intro",            label: "Hiring intro" },
  { value: "industry_advice",         label: "Industry advice" },
  { value: "job_referral",            label: "Job referral" },
  { value: "informational_interview", label: "Informational interview" },
  { value: "introductory_call",       label: "Intro call" },
  { value: "other",                   label: "Other" },
];

export interface LoggedIntroBody {
  contact_id: number;
  /** Who made the intro. */
  connector_staff_id: number;
  specific_ask?: string | null;
  context?: string | null;
  /** ISO date it happened. Omitted → today. */
  occurred_on?: string;
}

/** Log an intro that already happened.
 *
 *  Separate from useCreateIntroRequest, which ASKS a colleague for one and
 *  leaves it pending. This writes a completed row, which is what the Outreach
 *  scorecard's Facilitated Intro counts, and credits whoever logs it. */
export function useLogFacilitatedIntro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: LoggedIntroBody) => {
      const { data } = await api.post<ApiResponse<{ id: string }>>(
        "/api/jobs/intro-requests/logged", body,
      );
      return data.data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["jobs", "contact", vars.contact_id] });
      qc.invalidateQueries({ queryKey: ["jobs", "intro-requests"] });
      // The intro is outreach, so the scorecard and its drills are now stale.
      qc.invalidateQueries({ queryKey: ["jobs", "outreach"] });
      qc.invalidateQueries({ queryKey: ["jobs", "owner-scorecard"] });
      toast.success("Facilitated intro logged");
    },
    onError: (e: unknown) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Failed to log the intro");
    },
  });
}
