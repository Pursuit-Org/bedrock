import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";

import { ActivitySourceIcon } from "@/components/ActivitySourceIcon";
import { useActivities, type ActivityFilters } from "@/services/activities";
import { useAccounts } from "@/services/accounts";
import { useContacts } from "@/services/contacts";
import { useOpportunities } from "@/services/opportunities";
import { activityBodyText, cleanEmailText, decodeEntities } from "@/lib/emailText";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BedrockActivity } from "@/types/salesforce";

const EMAIL_PREVIEW_LENGTH = 800;

function isEmailOrMeeting(a: BedrockActivity): boolean {
  const t = (a.type ?? "").toLowerCase();
  const s = (a.source ?? "").toLowerCase();
  return (
    t === "email" ||
    t === "meeting" ||
    t === "calendar-event" ||
    t === "calendar" ||
    t === "event" ||
    s.includes("gmail") ||
    s.includes("calendar") ||
    s.includes("fireflies")
  );
}

export function ActivityTab({
  filters,
  emptyMessage = "No activity yet.",
  limit = 100,
}: {
  filters: ActivityFilters;
  emptyMessage?: string;
  limit?: number;
}) {
  const { data: raw = [], isLoading } = useActivities({ limit, ...filters });
  const [query, setQuery] = useState("");

  const activities = useMemo(() => raw.filter(isEmailOrMeeting), [raw]);

  const { data: opps = [] } = useOpportunities();
  const { data: accounts = [] } = useAccounts();
  // Pull contacts so we can resolve participants from `contact_ids` to
  // names/emails (the activity itself only stores ids). Contacts also
  // carry an AccountId so we can include the participant's company in
  // the search index.
  const { data: contacts = [] } = useContacts();

  const oppNames = useMemo(
    () => new Map(opps.map((o) => [o.Id, o.Name] as const)),
    [opps],
  );
  const accountNames = useMemo(
    () => new Map(accounts.map((a) => [a.Id, a.Name] as const)),
    [accounts],
  );
  const contactById = useMemo(
    () => new Map(contacts.map((c) => [c.Id, c] as const)),
    [contacts],
  );

  // Filter on subject, snippet, description, resolved context name,
  // activity owner, AND each participant's name + email + company.
  // Memo-keyed on the data and query so typing stays cheap.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return activities;
    return activities.filter((a) => {
      const ctx =
        a._context_name ??
        (a.opportunity_id ? oppNames.get(a.opportunity_id) ?? null : null) ??
        (a.account_id ? accountNames.get(a.account_id) ?? null : null) ??
        "";
      // Search the cleaned text the rows actually display (plus the plain
      // description, which meetings show as notes).
      const fields: string[] = [
        decodeEntities(a.subject),
        activityBodyText(a),
        a.description ?? "",
        ctx,
        a.owner_name ?? "",
        a.owner_email ?? "",
      ];
      for (const cid of a.contact_ids ?? []) {
        const c = contactById.get(cid);
        if (!c) continue;
        if (c.Name) fields.push(c.Name);
        if (c.FirstName) fields.push(c.FirstName);
        if (c.LastName) fields.push(c.LastName);
        if (c.Email) fields.push(c.Email);
        const company = c.AccountId ? accountNames.get(c.AccountId) : null;
        if (company) fields.push(company);
      }
      return fields.some((f) => f.toLowerCase().includes(q));
    });
  }, [activities, query, oppNames, accountNames, contactById]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border-strong px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        <span>
          {isLoading
            ? "Activity (…)"
            : `Activity (${visible.length}${visible.length !== activities.length ? ` of ${activities.length}` : ""})`}
        </span>
        {activities.length > 0 ? <ActivitySearchBox value={query} onChange={setQuery} /> : null}
      </div>
      <div className="flex-1 overflow-auto pb-3">
        {isLoading ? (
          <div className="px-5 py-4 text-center text-[12px] text-ink-3">Loading activity…</div>
        ) : activities.length === 0 ? (
          <div className="px-5 py-4 text-center text-[12px] text-ink-3">{emptyMessage}</div>
        ) : visible.length === 0 ? (
          <div className="px-5 py-4 text-center text-[12px] text-ink-3">No activity matches.</div>
        ) : (
          <ul className="flex flex-col">
            {visible.map((a) => (
              <ActivityRow
                key={a.id}
                a={a}
                oppNames={oppNames}
                accountNames={accountNames}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ActivitySearchBox({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <div className="relative">
      <Search
        size={11}
        className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-ink-4"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter activity…"
        className="h-6 w-[180px] rounded border border-border-strong bg-surface pl-5 pr-5 text-[11.5px] font-normal normal-case text-ink outline-none focus:border-accent"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2"
          aria-label="Clear"
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );
}

function ActivityRow({
  a,
  oppNames,
  accountNames,
}: {
  a: BedrockActivity;
  oppNames: Map<string, string>;
  accountNames: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);

  const dateStr = fmtDate(a.occurred_at ?? a.activity_date ?? a.created_at ?? null);
  // Subjects are plain text — decode entities only, so legit angle-bracket
  // text ("RE: <proposal>") isn't eaten. The snippet fallback IS email HTML.
  const subject =
    decodeEntities(a.subject) || cleanEmailText(a.email_snippet) || "(no subject)";

  const contextName =
    a._context_name ??
    (a.opportunity_id ? oppNames.get(a.opportunity_id) : null) ??
    (a.account_id ? accountNames.get(a.account_id) : null) ??
    null;

  const isMeeting =
    ["meeting", "calendar-event", "calendar", "event"].includes(
      (a.type ?? "").toLowerCase(),
    ) || (a.source ?? "").toLowerCase().includes("calendar") || (a.source ?? "").toLowerCase().includes("fireflies");

  // Detail content — what to show when expanded. Full email body when the
  // row has one (tag-stripped); plain descriptions pass through untouched.
  const body = activityBodyText(a);

  const hasDetail =
    !!(body && body !== subject) ||
    !!a.meeting_duration_minutes ||
    !!a.meeting_location;

  return (
    <li className="border-b border-border-strong last:border-b-0">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-2 text-left",
          hasDetail && "cursor-pointer hover:bg-surface-2/50",
          !hasDetail && "cursor-default",
        )}
      >
        <span className="mt-0.5 flex-shrink-0 text-ink-4">
          {hasDetail ? (
            open ? <ChevronDown size={11} /> : <ChevronRight size={11} />
          ) : (
            <span className="w-[11px]" />
          )}
        </span>
        <span className="mt-0.5 flex-shrink-0">
          <ActivitySourceIcon source={a.source} type={a.type} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-ink" title={subject}>
            {subject}
          </span>
          {contextName ? (
            <span className="block truncate text-[10.5px] text-ink-3">
              {contextName}
            </span>
          ) : null}
        </span>
        <span className="flex-shrink-0 text-right">
          <span className="mono text-[11px] text-ink-3">{dateStr}</span>
        </span>
      </button>

      {open && hasDetail ? (
        <div className="border-t border-border-strong bg-surface-2/40 px-4 py-2.5 text-[12px]">
          {isMeeting && (a.meeting_duration_minutes || a.meeting_location) ? (
            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
              {a.meeting_duration_minutes ? (
                <span>{a.meeting_duration_minutes} min</span>
              ) : null}
              {a.meeting_location ? <span>{a.meeting_location}</span> : null}
            </div>
          ) : null}
          {body && body !== subject ? (
            <>
              <p className="whitespace-pre-wrap break-words text-[12px] text-ink-2">
                {showFull || body.length <= EMAIL_PREVIEW_LENGTH
                  ? body
                  : body.slice(0, EMAIL_PREVIEW_LENGTH) + "…"}
              </p>
              {body.length > EMAIL_PREVIEW_LENGTH ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowFull((v) => !v); }}
                  className="mt-1 text-[11px] text-accent hover:underline"
                >
                  {showFull ? "Show less" : "Show more"}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
