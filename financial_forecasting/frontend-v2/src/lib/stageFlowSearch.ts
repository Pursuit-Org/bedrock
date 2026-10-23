/**
 * Stage Flow search (Kwame 2026-10-23): type a contact, an opportunity or an
 * account and the chart narrows to it and everything at the same account.
 *
 * "Duckbill" matches contacts at Duckbill, deals on the Duckbill account, and
 * a contact or deal whose own name contains it; every other contact and deal
 * at a matched account rides along, so the funnel reads for the whole account.
 *
 * Runs on the payload already loaded: members, moves and activity carry ids,
 * names and companies, and `directory` names the contacts counted by id alone.
 * Pool, Net New, Conversion and the Target List recount from what's left.
 * Target, Δ and Trend don't (targets are team-level and the prior period's
 * moves aren't shipped), so the chart shows "—" there while a search is on.
 */
import type { StageFlow, StageFlowRow } from "@/services/jobs";

// Targets are team-level: they don't scale to one account, so they drop out.
const NO_TARGET = { targetable: false, target: null, delta: null } as const;

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export interface StageFlowSearchResult {
  data: StageFlow;
  contacts: number;
  opportunities: number;
  /** Matched accounts, as displayed (first spelling seen). */
  accounts: string[];
}

export function searchStageFlow(data: StageFlow, query: string): StageFlowSearchResult | null {
  const q = norm(query);
  if (!q) return null;

  // Every record we can name: contact → its company; deal → its account.
  const contactAccount = new Map<string, string>();
  const dealAccount = new Map<string, string>();
  const display = new Map<string, string>();
  const hitContacts = new Set<string>();
  const hitDeals = new Set<string>();
  const accounts = new Set<string>();
  const see = (band: "outreach" | "pipeline", id: string, name: string | null, detail: string | null) => {
    // A contact's detail is its company; a deal's name is its account.
    const account = band === "outreach" ? detail : name;
    const key = norm(account);
    (band === "outreach" ? contactAccount : dealAccount).set(id, key);
    if (key && !display.has(key)) display.set(key, (account ?? "").trim());
    if (norm(name).includes(q) || norm(detail).includes(q)) {
      (band === "outreach" ? hitContacts : hitDeals).add(id);
      if (key) accounts.add(key);
    }
  };
  data.members.forEach((m) => see(m.band, m.id, m.name, m.detail));
  data.moved.forEach((m) => see(m.band, m.id, m.name, m.detail));
  (data.directory ?? []).forEach((d) => see("outreach", d.id, d.name, d.detail));

  const keepContact = (id: string) => hitContacts.has(id) || accounts.has(contactAccount.get(id) ?? "");
  const keepDeal = (id: string) => hitDeals.has(id) || accounts.has(dealAccount.get(id) ?? "");
  const keep = (band: "outreach" | "pipeline", id: string) => (band === "outreach" ? keepContact(id) : keepDeal(id));

  const members = data.members.filter((m) => keep(m.band, m.id));
  const moved = data.moved.filter((m) => keep(m.band, m.id));
  const activity = (data.activity ?? []).filter((a) => keepContact(a.id));

  const recount = (band: "outreach" | "pipeline", row: StageFlowRow): StageFlowRow => {
    if (row.kind === "activity") {
      const n = activity.filter((a) => a.row === row.key).reduce((s, a) => s + a.n, 0);
      return { ...row, ...NO_TARGET, moved_in: n, breakdown: null, unlinked: 0 };
    }
    if (row.kind === "universe") {
      if (!row.target_set) return row;
      const ts = row.target_set;
      const by: Record<string, string[]> = {};
      Object.entries(ts.by_stage ?? {}).forEach(([k, ids]) => {
        const left = ids.filter(keepContact);
        if (left.length) by[k] = left;
      });
      const processed = ts.processed.filter(keepContact);
      const outstanding = ts.outstanding.filter(keepContact);
      return {
        ...row, target_set: { processed, outstanding, by_stage: by },
        in_now: row.in_now ? { ...row.in_now, total: processed.length + outstanding.length } : null,
      };
    }
    const keys = row.children ?? [row.key];
    let in_now = row.in_now;
    if (in_now) {
      const cells = [0, 0, 0, 0, 0];
      members.forEach((m) => { if (m.band === band && keys.includes(m.stage)) cells[m.bucket] += 1; });
      in_now = { total: cells.reduce((a, b) => a + b, 0), cells };
    }
    // Distinct records, as the endpoint counts them.
    const movedIn = new Set(moved.filter((m) => m.band === band && keys.includes(m.stage)).map((m) => m.id)).size;
    const conversion = row.conversion
      ? { on: moved.filter((m) => m.band === band && m.stage === row.key && m.advanced).length, of: movedIn }
      : null;
    return { ...row, ...NO_TARGET, in_now, moved_in: movedIn, conversion };
  };

  const bands = data.bands.map((b) => ({ ...b, rows: b.rows.map((r) => recount(b.key, r)) }));
  const contacts = new Set([...members, ...moved].filter((m) => m.band === "outreach").map((m) => m.id));
  (data.directory ?? []).forEach((d) => { if (keepContact(d.id)) contacts.add(d.id); });
  const opportunities = new Set([...members, ...moved].filter((m) => m.band === "pipeline").map((m) => m.id));
  return {
    data: { ...data, bands, members, moved, activity },
    contacts: contacts.size,
    opportunities: opportunities.size,
    accounts: [...accounts].map((k) => display.get(k) ?? k).sort((a, b) => a.localeCompare(b)),
  };
}
