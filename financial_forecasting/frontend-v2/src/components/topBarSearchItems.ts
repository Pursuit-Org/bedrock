// Result building for the top-bar search. Plain module (no React, no path
// aliases) so `npm run test` can import it.
import { jobsAccountPath, jobsOpportunityPath } from "./jobs/jobsPaths.ts";

export interface SfRecord {
  Id: string;
  Name?: string;
  Email?: string;
  StageName?: string;
  Amount?: number;
  CloseDate?: string;
  AccountName?: string;
}

export interface SearchResults {
  Account?: SfRecord[];
  Contact?: SfRecord[];
  Opportunity?: SfRecord[];
}

export interface ResultItem {
  group: string;
  label: string;
  sub?: string | null;
  href: string;
}

/** A bedrock/jobs contact (public.contacts) — not necessarily in Salesforce. */
export interface BedrockContact {
  contact_id: number;
  full_name: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
}

/** /api/jobs/accounts/search */
export interface JobsAccountHit {
  account_key: string;
  account: string;
  opp_count: number;
}

/** /api/jobs/opportunities/search */
export interface JobsDealHit {
  id: string;
  account_name: string | null;
  title: string | null;
  stage: string;
}

export interface SearchSources {
  sf: SearchResults;
  jobsContacts?: BedrockContact[];
  jobsAccounts?: JobsAccountHit[];
  jobsDeals?: JobsDealHit[];
}

export function buildItems(
  { sf, jobsContacts = [], jobsAccounts = [], jobsDeals = [] }: SearchSources,
  stageLabel: (stage: string) => string = (s) => s,
): ResultItem[] {
  const out: ResultItem[] = [];
  for (const r of sf.Account ?? []) {
    out.push({
      group: "Accounts",
      label: r.Name ?? r.Id,
      href: `/accounts/${r.Id}`,
    });
  }
  // Jobs accounts are named by company text, not a Salesforce record, so an
  // employer the jobs team works (Blackstone) can exist only here (Kwame
  // 2026-10-02). Own group, like Jobs Contacts below, so the header says
  // which section the link opens.
  for (const a of jobsAccounts) {
    out.push({
      group: "Jobs Accounts",
      label: a.account,
      sub: a.opp_count ? `${a.opp_count} deal${a.opp_count === 1 ? "" : "s"}` : "No deals yet",
      href: jobsAccountPath(a.account_key),
    });
  }
  const sfEmails = new Set<string>();
  for (const r of sf.Contact ?? []) {
    if (r.Email) sfEmails.add(r.Email.toLowerCase());
    out.push({
      group: "PBD Contacts",
      label: r.Name ?? r.Id,
      sub: r.Email ?? null,
      href: `/contacts/${r.Id}`,
    });
  }
  // Bedrock/jobs contacts (32k+ in public.contacts, incl. people not in SF).
  // Searches name + email + company, so e.g. "adonis" surfaces its contacts.
  // Kept in a separate "Jobs Contacts" group (rather than merged into PBD
  // Contacts above) so the dropdown's group header always makes clear which
  // Bedrock section a same-named contact belongs to — a person can be a PBD
  // (Salesforce) contact and a Jobs (public.contacts) contact with different
  // emails, and previously both rendered under one unlabeled "Contacts"
  // header with no way to tell which link went where.
  for (const c of jobsContacts) {
    if (c.email && sfEmails.has(c.email.toLowerCase())) continue;
    const name = c.full_name ?? c.email ?? `#${c.contact_id}`;
    out.push({
      group: "Jobs Contacts",
      label: name,
      sub: [c.current_title, c.current_company].filter(Boolean).join(" · ") || c.email || null,
      // Deep-link straight to the contact's detail drawer (opens on arrival).
      href: `/jobs/contacts?contact=${c.contact_id}`,
    });
  }
  for (const r of sf.Opportunity ?? []) {
    out.push({
      group: "Opportunities",
      label: r.Name ?? r.Id,
      sub: r.AccountName ?? r.StageName ?? null,
      href: `/opportunities/${r.Id}`,
    });
  }
  for (const d of jobsDeals) {
    const account = d.account_name?.trim() || "Untitled";
    out.push({
      group: "Jobs Deals",
      label: d.title?.trim() ? `${account} — ${d.title.trim()}` : account,
      sub: stageLabel(d.stage),
      href: jobsOpportunityPath(d.id),
    });
  }
  return out;
}
