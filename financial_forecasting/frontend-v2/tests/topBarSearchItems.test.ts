// Run: npm run test  (node --test, native TypeScript stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildItems } from "../src/components/topBarSearchItems.ts";

const noSf = { Account: [], Contact: [], Opportunity: [] };

test("top-bar search returns jobs accounts and deals, not just contacts", () => {
  const items = buildItems(
    {
      sf: noSf,
      jobsAccounts: [{ account_key: "blackstone", account: "Blackstone", opp_count: 7 }],
      jobsDeals: [{ id: "d1", account_name: "Blackstone", title: "Data Analyst", stage: "ask_submitted" }],
    },
    (s) => (s === "ask_submitted" ? "Ask Submitted" : s),
  );
  assert.deepEqual(items, [
    { group: "Jobs Accounts", label: "Blackstone", sub: "7 deals", href: "/jobs/accounts/blackstone" },
    { group: "Jobs Deals", label: "Blackstone — Data Analyst", sub: "Ask Submitted", href: "/jobs/opportunities/d1" },
  ]);
});

test("jobs account keys are URL-encoded and deals without a title use the account", () => {
  const items = buildItems({
    sf: noSf,
    jobsAccounts: [{ account_key: "at&t / labs", account: "AT&T / Labs", opp_count: 0 }],
    jobsDeals: [{ id: "d2", account_name: "AT&T / Labs", title: null, stage: "closed_won" }],
  });
  assert.equal(items[0].href, "/jobs/accounts/at%26t%20%2F%20labs");
  assert.equal(items[0].sub, "No deals yet");
  assert.equal(items[1].label, "AT&T / Labs");
});

test("existing groups keep their order around the new ones", () => {
  const items = buildItems({
    sf: {
      Account: [{ Id: "001", Name: "Acme" }],
      Contact: [{ Id: "003", Name: "Ana", Email: "ana@acme.com" }],
      Opportunity: [{ Id: "006", Name: "Acme gift" }],
    },
    jobsContacts: [
      // Same email as the SF contact: shown once, under PBD Contacts.
      { contact_id: 1, full_name: "Ana", email: "ANA@acme.com", current_title: null, current_company: "Acme" },
      { contact_id: 2, full_name: "Ben", email: null, current_title: "CTO", current_company: "Acme" },
    ],
    jobsAccounts: [{ account_key: "acme", account: "Acme", opp_count: 1 }],
    jobsDeals: [{ id: "d3", account_name: "Acme", title: null, stage: "builder_submitted" }],
  });
  assert.deepEqual(
    items.map((i) => i.group),
    ["Accounts", "Jobs Accounts", "PBD Contacts", "Jobs Contacts", "Opportunities", "Jobs Deals"],
  );
});
