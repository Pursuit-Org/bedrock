import axios from "axios";
import { api } from "@/lib/api";
import type { SfAccount, SfContact, SfOpportunity } from "@/types/salesforce";

export type IntelligenceFocus = "overview" | "prospecting" | "narrative_fit" | "health";

export interface AccountIntelligenceResult {
  brief: string;
  generated_at: string;
  sources_used: string[];
  focus: IntelligenceFocus;
}

export interface ActivityItem {
  date?: string;
  type?: string;
  subject?: string;
  snippet?: string;
  owner?: string;
}

export async function fetchAccountIntelligence(
  account: SfAccount,
  contacts: SfContact[],
  opps: SfOpportunity[],
  activities: ActivityItem[],
  focus: IntelligenceFocus = "overview",
): Promise<AccountIntelligenceResult> {
  const ownerName = account.Owner?.Name ?? "";
  try {
    const { data } = await api.post<AccountIntelligenceResult>("/api/ai/account-intelligence", {
      account_id: account.Id,
      account_name: account.Name,
      account_type: account.Type ?? "",
      account_website: account.Website ?? "",
      owner_name: ownerName,
      focus,
      contacts: contacts.slice(0, 20).map((c) => ({
        Name: c.Name,
        Title: c.Title,
        Email: c.Email,
        LinkedIn_URL__c: c.LinkedIn_URL__c,
      })),
      opps: opps.slice(0, 30).map((o) => ({
        Name: o.Name,
        StageName: o.StageName,
        Amount: o.Amount,
        CloseDate: o.CloseDate,
        RecordType: o.RecordType,
      })),
      activities: activities.slice(0, 50),
    });
    return data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const detail: string = err.response?.data?.detail ?? "";
      if (err.response?.status === 503) {
        throw new Error(
          detail.includes("ANTHROPIC_API_KEY")
            ? "AI is not configured — add ANTHROPIC_API_KEY to your .env file and restart the backend."
            : detail || "AI service unavailable (503).",
        );
      }
      if (err.response?.status === 401) {
        throw new Error("Not authenticated — please sign in.");
      }
      throw new Error(detail || err.message);
    }
    throw err;
  }
}
