/**
 * AI-first candidate review (human in the loop). Enrichment is pre-computed in
 * the background and persisted, so the list + drawer show AI findings instantly.
 * The drawer: shows the AI read (name/title/company + reasoning), proposes an
 * account linkage, proposes existing-contact links you approve in one click,
 * shows the emails, and promotes/dismisses.
 */
import { useEffect, useMemo, useState } from "react";
import { Sparkles, Building2, Mail, UserPlus, X, ChevronDown, ChevronRight, Loader2, Check, Link2, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Drawer } from "@/components/ui/Drawer";
import { Tag } from "@/components/ui/Tag";
import { CompanyPicker } from "@/components/jobs/CompanyPicker";
import { NewAccountDialog } from "@/components/jobs/NewAccountDialog";
import {
  useCandidates, useCandidateDetail, useContactSearch, useEnrichCandidate, useLinkCandidate,
  useCandidateSfMatch, useLinkCandidateSf,
  usePromoteCandidate, useDismissCandidate, useBulkDismissCandidates, useBulkRestoreCandidates, useSetCandidateAccount, useMergeContacts, useJobsAccountNames, useCandidateOwners,
  type JobCandidate,
} from "@/services/jobs";
import { ListWhy } from "@/components/jobs/ListWhy";

/** Short display label for a staff owner email (e.g. "avni@pursuit.org" -> "Avni"). */
const ownerLabel = (email: string) => {
  const lp = email.split("@")[0].replace(/[._]/g, " ");
  return lp.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const confTone = (c?: string | null) => (c === "high" ? "green" : c === "medium" ? "amber" : "default") as "green" | "amber" | "default";

function EmailItem({ e }: { e: { subject: string | null; email_from: string | null; email_to: string[] | null; snippet: string | null; body: string | null; activity_date: string | null } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border-strong">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-2/40">
        {open ? <ChevronDown size={13} className="mt-0.5 shrink-0 text-ink-4" /> : <ChevronRight size={13} className="mt-0.5 shrink-0 text-ink-4" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] text-ink">{e.subject || "(no subject)"}</div>
          <div className="truncate text-[11px] text-ink-4">{e.email_from} · {fmtDate(e.activity_date)}</div>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-8 text-[12px] leading-relaxed text-ink-2">
          {e.email_to?.length ? <div className="mb-1 text-[11px] text-ink-4">To: {e.email_to.join(", ")}</div> : null}
          <div className="whitespace-pre-wrap">{e.body || e.snippet || "(no body)"}</div>
        </div>
      )}
    </div>
  );
}

function CandidateDrawer({ contactId, onClose }: { contactId: number | null; onClose: () => void }) {
  const { data, isLoading } = useCandidateDetail(contactId);
  const enrich = useEnrichCandidate();
  const link = useLinkCandidate();
  const sfMatch = useCandidateSfMatch(contactId);
  const linkSf = useLinkCandidateSf();
  const promote = usePromoteCandidate();
  const dismiss = useDismissCandidate();
  const { data: accounts = [] } = useJobsAccountNames();

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  // A suggested or enriched company that isn't an account yet goes through the
  // duplicate-checking dialog before it can be used (D9, PRO-101).
  const [newAccount, setNewAccount] = useState<string | null>(null);
  const [linkQ, setLinkQ] = useState("");
  const { data: linkResults } = useContactSearch(linkQ.trim().length >= 2 ? linkQ.trim() : "");
  const merge = useMergeContacts();
  const [canonicalId, setCanonicalId] = useState<number | null>(null);

  // Seed from persisted enrichment (or the contact) the moment detail loads.
  useEffect(() => {
    if (!data) return;
    const e = data.enrichment;
    setName(data.contact.full_name || e?.full_name || "");
    setTitle(data.contact.current_title || e?.title || "");
    setCompany(data.contact.current_company || e?.company || data.suggested_account?.account_name || "");
    setCanonicalId((data?.possible_duplicates ?? [])[0]?.contact_id ?? null);
  }, [data?.contact.contact_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const accountKeys = useMemo(() => new Set(accounts.map((a) => a.account_key)), [accounts]);
  const notAnAccount = !!company.trim() && accounts.length > 0 && !accountKeys.has(company.trim().toLowerCase());
  const e = data?.enrichment;
  const sug = data?.suggested_account;
  const dups = data?.possible_duplicates ?? [];
  const sf = sfMatch.data?.match;
  const busy = promote.isPending || dismiss.isPending || link.isPending || linkSf.isPending || merge.isPending;

  return (
    <Drawer open={contactId != null} onClose={onClose}
      title={data?.contact.full_name || e?.full_name || data?.contact.email || "Candidate"}
      subtitle={data?.contact.email} width={680}>
      {isLoading || !data ? (
        <div className="flex items-center gap-2 p-6 text-[13px] text-ink-3"><Loader2 size={15} className="animate-spin" /> Loading…</div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          {/* AI enrichment (pre-computed, instant) */}
          <div className="rounded-lg border border-accent/30 bg-accent-soft/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent-ink"><Sparkles size={12} /> AI enrichment</span>
              <button type="button" onClick={() => contactId && enrich.mutate(contactId)}
                disabled={enrich.isPending}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent-soft disabled:opacity-50">
                {enrich.isPending ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Re-enrich
              </button>
            </div>
            {!e ? (
              <div className="text-[12px] text-ink-3">Not enriched yet — hit Re-enrich.</div>
            ) : (
              <div className="flex flex-col gap-1.5 text-[12px]">
                <div className="flex flex-wrap items-center gap-2">
                  {e.is_employer_contact === false && <Tag variant="amber">Not an employer contact</Tag>}
                  {e.confidence && <Tag variant={confTone(e.confidence)}>{e.confidence} confidence</Tag>}
                </div>
                {e.reasoning && <p className="text-[11.5px] leading-relaxed text-ink-2">{e.reasoning}</p>}
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {e.full_name && e.full_name !== name && <Suggest label={`Name: ${e.full_name}`} onClick={() => setName(e.full_name!)} />}
                  {e.title && e.title !== title && <Suggest label={`Title: ${e.title}`} onClick={() => setTitle(e.title!)} />}
                  {e.company && e.company !== company && <Suggest label={`Company: ${e.company}`} onClick={() => setCompany(e.company!)} />}
                </div>
              </div>
            )}
          </div>

          {/* Salesforce match — definitive (email). Approve → import + pipeline. */}
          {sf && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-green/40 bg-green-soft/40 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-green"><Building2 size={12} /> Found in Salesforce</div>
                <div className="mt-1 truncate text-[12.5px] text-ink">
                  {sf.name}{sf.account_name ? <span className="text-ink-4"> · {sf.account_name}</span> : ""}{sf.title ? <span className="text-ink-4"> · {sf.title}</span> : ""}
                </div>
              </div>
              <button type="button" disabled={busy}
                onClick={() => contactId && linkSf.mutate({ id: contactId, match: sf }, { onSuccess: onClose })}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-green px-2.5 text-[12px] font-medium text-white disabled:opacity-40">
                <Link2 size={12} /> Link
              </button>
            </div>
          )}

          {/* Likely existing contacts — link the candidate into one, or when
              there are several (they're dupes of each other) merge them all. */}
          {dups.length > 0 && (
            <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber">
                <Link2 size={12} /> {dups.length > 1 ? `${dups.length} existing contacts with this name` : "Likely existing contact"}
              </div>
              <div className="flex flex-col gap-1.5">
                {dups.map((d) => (
                  <div key={d.contact_id} className="flex items-center justify-between gap-2">
                    <label className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink">
                      {dups.length > 1 && (
                        <input type="radio" name="canonical" checked={canonicalId === d.contact_id}
                          onChange={() => setCanonicalId(d.contact_id)} className="accent-amber" title="Keep this one" />
                      )}
                      <span className="truncate">
                        {d.full_name}{d.current_company ? <span className="text-ink-4"> · {d.current_company}</span> : ""}
                        {d.current_title ? <span className="text-ink-4"> · {d.current_title}</span> : ""}
                      </span>
                    </label>
                    <button type="button" disabled={busy}
                      onClick={() => contactId && link.mutate({ id: contactId, target: d.contact_id }, { onSuccess: onClose })}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-amber px-2.5 text-[12px] font-medium text-white disabled:opacity-40">
                      <Link2 size={12} /> Link
                    </button>
                  </div>
                ))}
              </div>
              {dups.length > 1 && (
                <button type="button" disabled={busy}
                  onClick={() => {
                    const canon = canonicalId ?? dups[0].contact_id;
                    const losers = [contactId!, ...dups.map((d) => d.contact_id).filter((id) => id !== canon)];
                    merge.mutate({ canonicalId: canon, loserIds: losers }, { onSuccess: onClose });
                  }}
                  className="mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-amber px-2.5 text-[12px] font-medium text-amber hover:bg-amber-soft disabled:opacity-40">
                  Merge all into the selected contact
                </button>
              )}
            </div>
          )}

          {/* Manual link — for when suggestions miss (e.g. candidate name is
              just an email address). Search any existing contact and link. */}
          <div className="rounded-lg border border-border-strong p-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">Link to an existing contact</div>
            <input value={linkQ} onChange={(ev) => setLinkQ(ev.target.value)} placeholder="Search contacts by name, company, email…"
              className="h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-4 focus:border-accent" />
            {linkQ.trim().length >= 2 && (
              <div className="mt-1.5 flex max-h-44 flex-col gap-1 overflow-auto">
                {(linkResults ?? []).filter((r) => r.contact_id !== contactId).slice(0, 8).map((r) => (
                  <div key={r.contact_id} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-surface-2/60">
                    <div className="min-w-0 truncate text-[12.5px] text-ink">
                      {r.full_name || r.email}
                      {r.current_company ? <span className="text-ink-4"> · {r.current_company}</span> : ""}
                    </div>
                    <button type="button" disabled={busy}
                      onClick={() => contactId && link.mutate({ id: contactId, target: r.contact_id }, { onSuccess: onClose })}
                      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-accent px-2 text-[11.5px] font-medium text-accent hover:bg-accent-soft disabled:opacity-40">
                      <Link2 size={11} /> Link
                    </button>
                  </div>
                ))}
                {(linkResults ?? []).length === 0 && <div className="px-1.5 py-1 text-[12px] text-ink-4">No matches.</div>}
              </div>
            )}
          </div>

          {/* Editable fields */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field label="Full name"><input value={name} onChange={(ev) => setName(ev.target.value)} className={inputCls} /></Field>
            <Field label="Title"><input value={title} onChange={(ev) => setTitle(ev.target.value)} className={inputCls} /></Field>
            {/* Picked from existing accounts, or created through the dialog
                that checks for duplicates first (D9, PRO-101). */}
            <Field label="Company / account">
              <CompanyPicker value={company} onChange={setCompany} />
              {notAnAccount && (
                <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-amber-700">
                  Not an account yet.
                  <button type="button" onClick={() => setNewAccount(company)} className="font-medium text-accent hover:underline">Create it</button>
                  or pick another.
                </div>
              )}
            </Field>
          </div>

          {newAccount && (
            <NewAccountDialog initialName={newAccount} onClose={() => setNewAccount(null)}
              onPicked={(a) => setCompany(a.display)} />
          )}

          {/* Account linkage suggestion */}
          {sug && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border-strong bg-surface px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Building2 size={14} className="shrink-0 text-ink-4" />
                <div className="min-w-0">
                  <div className="text-[12.5px] text-ink">
                    {sug.in_pipeline ? "Link to" : "New account"}: <span className="font-semibold">{sug.account_name}</span>
                    <Tag variant={confTone(sug.confidence)} className="ml-2">{sug.confidence}</Tag>
                  </div>
                  <div className="truncate text-[11px] text-ink-4">{sug.reason}</div>
                </div>
              </div>
              {sug.account_name && company !== sug.account_name && (
                <button type="button"
                  // A suggested account not in the pipeline yet is created
                  // through the duplicate-checking dialog, like any other.
                  onClick={() => sug.in_pipeline ? setCompany(sug.account_name!) : setNewAccount(sug.account_name!)}
                  className="shrink-0 rounded border border-accent/40 px-2 py-1 text-[12px] text-accent hover:bg-accent-soft">Use</button>
              )}

            </div>
          )}

          {/* Emails */}
          <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
            <div className="flex items-center gap-1.5 bg-surface-2/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              <Mail size={12} /> Emails · {data.emails.length}
            </div>
            {data.emails.length === 0 ? <div className="px-3 py-4 text-[12px] text-ink-3">No emails.</div>
              : data.emails.map((em) => <EmailItem key={em.id} e={em} />)}
          </div>

          {/* Actions */}
          <div className="sticky bottom-0 flex items-center gap-2 border-t border-border-strong bg-surface pt-3">
            <button type="button" disabled={busy || !name || notAnAccount}
              title={notAnAccount ? "Pick an existing account or create this one first" : undefined}
              onClick={() => contactId && promote.mutate(
                { id: contactId, full_name: name || undefined, current_title: title || undefined, current_company: company || undefined },
                { onSuccess: onClose })}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-[13px] font-medium text-white disabled:opacity-40">
              <UserPlus size={14} /> Add to pipeline
            </button>
            <button type="button" disabled={busy}
              onClick={() => contactId && dismiss.mutate(contactId, { onSuccess: onClose })}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border-strong px-3 text-[13px] text-ink-2 hover:bg-red-soft hover:text-red disabled:opacity-40">
              <X size={14} /> Dismiss
            </button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

const inputCls = "h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>{children}</label>;
}
function Suggest({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-surface px-2 py-0.5 text-[11px] text-accent hover:bg-accent-soft">
      <Check size={10} /> {label}
    </button>
  );
}

function Section({ title, count, why, action, children }: {
  title: string; count?: number;
  /** The list's key in services/jobs_lists.py, for its "Why these?" (PRO-105). */
  why?: string;
  action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</span>
        {count != null && <span className="text-[11px] tabular-nums text-ink-4">{count}</span>}
        {why ? <ListWhy listKey={why} /> : null}
        {action && <div className="ml-auto self-center">{action}</div>}
      </div>
      {children}
    </div>
  );
}

function CandidateRow({ c, onOpen, selected, onToggleSelect, onLink, onApprove, busy, dismissedView }: {
  c: JobCandidate; onOpen: () => void; selected: boolean; onToggleSelect: () => void;
  onLink: (target: number) => void; onApprove: (company: string) => void;
  busy: boolean; dismissedView: boolean;
}) {
  const display = c.ai_name || c.full_name || c.email;
  const company = c.ai_company || c.suggested_account;
  return (
    <div className={cn("flex w-full items-center gap-2 border-t border-border-strong px-3 py-2 hover:bg-surface-2/40",
      selected && "bg-accent-soft/40")}>
      <input type="checkbox" checked={selected} onChange={onToggleSelect} onClick={(e) => e.stopPropagation()}
        className="shrink-0 accent-accent" aria-label={`Select ${display}`} />
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] text-ink">{display}</span>
            {c.enriched && <Sparkles size={11} className="shrink-0 text-accent" />}
            {c.is_employer_contact === false && <span className="shrink-0 text-[10px] text-ink-4">· not employer</span>}
          </div>
          <div className="truncate text-[11px] text-ink-4">
            {c.email} · {c.email_count} email{c.email_count === 1 ? "" : "s"}{c.last_subject ? ` · ${c.last_subject}` : ""}
          </div>
        </div>
      </button>
      {/* One-click actions (only in the active review view) */}
      {!dismissedView && c.top_dup_id ? (
        <button type="button" disabled={busy}
          title={`Link to existing contact: ${display}${c.top_dup_company ? ` · ${c.top_dup_company}` : ""}${c.top_dup_title ? ` · ${c.top_dup_title}` : ""}`}
          onClick={(e) => { e.stopPropagation(); onLink(c.top_dup_id!); }}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-amber px-2 text-[11.5px] font-medium text-white disabled:opacity-40">
          <Link2 size={11} /> Link → {c.top_dup_company || c.top_dup_title || "existing"}
        </button>
      ) : !dismissedView && (c.dup_match_count ?? 0) > 1 ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(); }}
          title={`${c.dup_match_count} existing contacts named ${display} — open to pick / merge`}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-amber px-2 text-[11.5px] font-medium text-amber hover:bg-amber-soft">
          <Link2 size={11} /> {c.dup_match_count} matches
        </button>
      ) : c.account_linked ? (
        <span title={`Account linked${company ? `: ${company}` : ""}`}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-green-soft px-2 text-[11.5px] font-medium text-green">
          <Check size={11} /> {company ? (company.length > 16 ? company.slice(0, 15) + "…" : company) : "Linked"}
        </span>
      ) : !dismissedView && company ? (
        <button type="button" disabled={busy} title={`Link account: ${company} (stays in review to edit + promote)`}
          onClick={(e) => { e.stopPropagation(); onApprove(company); }}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-accent px-2 text-[11.5px] font-medium text-accent hover:bg-accent-soft disabled:opacity-40">
          <Building2 size={11} /> {company.length > 16 ? company.slice(0, 15) + "…" : company}
        </button>
      ) : null}
      <ChevronRight size={14} className="shrink-0 text-ink-4" />
    </div>
  );
}

export function CandidatesZone({ defaultOwner }: { defaultOwner?: string } = {}) {
  const [owner, setOwner] = useState<string>(defaultOwner ?? "");  // "" = everyone
  const [view, setView] = useState<"candidate" | "dismissed">("candidate");
  const { data: cands = [], isLoading } = useCandidates(owner || undefined, view);
  const { data: owners = [] } = useCandidateOwners();
  const bulkDismiss = useBulkDismissCandidates();
  const bulkRestore = useBulkRestoreCandidates();
  const link = useLinkCandidate();
  const setAccount = useSetCandidateAccount();
  const [openId, setOpenId] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const dismissedView = view === "dismissed";

  // Client-side search across the fields shown on the row.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return cands;
    return cands.filter((c) => {
      const hay = [c.ai_name, c.full_name, c.email, c.ai_company, c.suggested_account, c.last_subject]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [cands, q]);
  const shown = showAll ? filtered : filtered.slice(0, 20);

  const toggle = (id: number) => setSelected((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const shownIds = shown.map((c) => c.contact_id);
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => selected.has(id));
  const toggleAllShown = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allShownSelected) shownIds.forEach((id) => next.delete(id));
    else shownIds.forEach((id) => next.add(id));
    return next;
  });
  const doBulkDismiss = () => {
    if (selected.size === 0) return;
    // Global + effectively permanent → confirm before removing for everyone.
    const ok = window.confirm(
      `Dismiss ${selected.size} candidate${selected.size === 1 ? "" : "s"} for the whole team? ` +
      `They leave everyone's review queue. You can restore them from the Dismissed view.`);
    if (!ok) return;
    bulkDismiss.mutate([...selected], { onSuccess: () => setSelected(new Set()) });
  };
  const doBulkRestore = () => {
    if (selected.size === 0) return;
    bulkRestore.mutate([...selected], { onSuccess: () => setSelected(new Set()) });
  };

  const controls = (
    <div className="flex items-center gap-2">
      <div className="flex items-center rounded-md border border-border-strong p-0.5 text-[11.5px]">
        {(["candidate", "dismissed"] as const).map((v) => (
          <button key={v} type="button"
            onClick={() => { setView(v); setSelected(new Set()); setShowAll(false); }}
            className={cn("rounded px-2 py-0.5 font-medium",
              view === v ? "bg-accent text-white" : "text-ink-3 hover:text-ink")}>
            {v === "candidate" ? "Reviewing" : "Dismissed"}
          </button>
        ))}
      </div>
      <input value={q} onChange={(e) => { setQ(e.target.value); setShowAll(false); }}
        placeholder="Search candidates…"
        className="h-7 w-48 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent" />
      <select value={owner} onChange={(e) => { setOwner(e.target.value); setShowAll(false); setSelected(new Set()); }}
        className="rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink">
        <option value="">Everyone</option>
        {owners.map((o) => <option key={o.owner} value={o.owner}>{ownerLabel(o.owner)} ({o.count})</option>)}
      </select>
    </div>
  );
  return (
    <Section title={dismissedView ? "Dismissed candidates" : "Candidates to review"} count={cands.length}
      why="candidates" action={controls}>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : cands.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">
            {dismissedView ? "No dismissed candidates."
              : owner ? `No candidates for ${ownerLabel(owner)}. 🎉` : "Nothing to review. 🎉"}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">No candidates match “{q}”.</div>
        ) : (
          <>
            {selected.size > 0 ? (
              <div className="flex items-center justify-between gap-2 bg-accent-soft/60 px-3 py-1.5 text-[12px]">
                <label className="flex items-center gap-1.5 text-ink-2">
                  <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} className="accent-accent" />
                  {selected.size} selected
                </label>
                {dismissedView ? (
                  <button type="button" disabled={bulkRestore.isPending} onClick={doBulkRestore}
                    className="inline-flex items-center gap-1 rounded-md bg-green px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40">
                    <Check size={12} /> Restore {selected.size}
                  </button>
                ) : (
                  <button type="button" disabled={bulkDismiss.isPending} onClick={doBulkDismiss}
                    className="inline-flex items-center gap-1 rounded-md bg-red px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40">
                    <X size={12} /> Dismiss {selected.size}
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-surface-2/60 px-3 py-1.5 text-[11px] text-ink-4">
                <input type="checkbox" checked={false} onChange={toggleAllShown} className="accent-accent" aria-label="Select all shown" />
                {dismissedView
                  ? "Dismissed candidates — removed from everyone's queue. Select rows to restore."
                  : `People we emailed${owner ? ` (${ownerLabel(owner)})` : ""}, enriched by AI. Open to confirm, or select rows to dismiss in bulk.`}
              </div>
            )}
            {shown.map((c) => (
              <CandidateRow key={c.contact_id} c={c} onOpen={() => setOpenId(c.contact_id)}
                selected={selected.has(c.contact_id)} onToggleSelect={() => toggle(c.contact_id)}
                dismissedView={dismissedView}
                busy={link.isPending || setAccount.isPending}
                onLink={(target) => link.mutate({ id: c.contact_id, target })}
                onApprove={(company) => setAccount.mutate({ id: c.contact_id, company })} />
            ))}
            {filtered.length > shown.length && (
              <button type="button" onClick={() => setShowAll(true)}
                className="border-t border-border-strong px-3 py-2 text-[12px] text-accent hover:bg-surface-2/50">Show all {filtered.length}</button>
            )}
          </>
        )}
      </div>
      <CandidateDrawer contactId={openId} onClose={() => setOpenId(null)} />
    </Section>
  );
}
