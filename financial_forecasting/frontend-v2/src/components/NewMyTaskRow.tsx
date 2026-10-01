import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";

import { Tag } from "@/components/ui/Tag";
import { useAccounts } from "@/services/accounts";
import { useContacts } from "@/services/contacts";
import { useCreateGenericTask, useOpportunities } from "@/services/opportunities";
import { useActiveUsers } from "@/services/users";
import { cn } from "@/lib/utils";
import { rankByQuery, SEARCH_MIN_CHARS } from "@/lib/search";

/** Selected parent record. Drives WhoId (Contact) or WhatId (Opp/Account)
 *  on the eventual create call. `null` = orphan task (My Tasks only). */
interface LinkTarget {
  type: "opportunity" | "account" | "contact";
  id: string;
  label: string;
}

/**
 * Inline composer above the My Tasks list. Subject + Assignee + Due
 * + optional Link-to (opp/account/contact). Hitting Enter or "Create"
 * fires useCreateGenericTask — optimistic insert routes the new row
 * into the right cache list based on which Whom/What is set.
 */
export function NewMyTaskRow() {
  const [subject, setSubject] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [link, setLink] = useState<LinkTarget | null>(null);

  const usersQ = useActiveUsers();
  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );
  const createTask = useCreateGenericTask();

  const submit = () => {
    const trimmed = subject.trim();
    if (!trimmed) return;
    const body: Parameters<typeof createTask.mutate>[0] = {
      Subject: trimmed,
      OwnerId: ownerId || undefined,
      ActivityDate: dueDate || undefined,
    };
    if (link?.type === "contact") body.WhoId = link.id;
    if (link && link.type !== "contact") body.WhatId = link.id;
    setSubject("");
    setOwnerId("");
    setDueDate("");
    setLink(null);
    void createTask.mutate(body);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2/40 px-5 py-2">
      <Plus size={13} className="flex-shrink-0 text-ink-3" />
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="New task — press Enter to create"
        // Subject input flexes to absorb the empty space, pushing
        // Link / Assignee / Date / Create to the right edge of the
        // table. min-w-0 so it can shrink past its content width when
        // the row wraps on a narrow viewport.
        className="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
      />
      <div className="flex flex-shrink-0 items-center gap-2">
        {link ? (
          <span className="inline-flex items-center gap-1">
            <Tag variant="accent">
              {link.type === "opportunity" ? "Opp" : link.type === "account" ? "Acct" : "Contact"}: {link.label}
            </Tag>
            <button
              type="button"
              onClick={() => setLink(null)}
              aria-label="Clear link"
              className="text-ink-3 hover:text-ink-2"
            >
              <X size={12} />
            </button>
          </span>
        ) : (
          <LinkPicker onPick={setLink} />
        )}
        {ownerOptions.length > 0 ? (
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            title="Assignee"
            className="h-7 max-w-[160px] flex-shrink-0 rounded border border-border-strong bg-surface px-1.5 text-[12px] text-ink outline-none focus:border-accent"
          >
            <option value="">Assignee…</option>
            {ownerOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : null}
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          title="Due date"
          className="h-7 flex-shrink-0 rounded border border-border-strong bg-surface px-1.5 text-[12px] text-ink outline-none focus:border-accent"
        />
        {subject.trim() ? (
          <button
            type="button"
            onClick={submit}
            className="h-7 rounded border border-ink bg-ink px-3 text-[12px] font-medium text-surface hover:opacity-90"
          >
            Create
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Cross-entity record picker. Click "Link to…" to open a dropdown with
 * a search input; matches across Opps / Accounts / Contacts are
 * surfaced in three small sections. Click a result to select.
 */
function LinkPicker({ onPick }: { onPick: (target: LinkTarget) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Portal-positioned popover (position:fixed) so SectionCard's
  // overflow-hidden doesn't clip the dropdown when the picker is
  // mounted inside it. Track trigger rect on open + scroll + resize.
  const POPOVER_WIDTH = 320;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const recompute = () => {
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      const margin = 8;
      let left = r.left;
      if (left + POPOVER_WIDTH > window.innerWidth - margin) {
        left = Math.max(margin, r.right - POPOVER_WIDTH);
      }
      setPos({ top: r.bottom + 4, left });
    };
    recompute();
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open]);

  const oppsQ = useOpportunities();
  const accountsQ = useAccounts();
  const contactsQ = useContacts();

  const matches = useMemo(() => {
    if (q.trim().length < SEARCH_MIN_CHARS) return { opps: [], accounts: [], contacts: [] };
    const opps = rankByQuery(oppsQ.data ?? [], q, (o) => [o.Name]).slice(0, 8);
    const accounts = rankByQuery(accountsQ.data ?? [], q, (a) => [a.Name]).slice(0, 8);
    const contacts = rankByQuery(contactsQ.data ?? [], q, (c) => [
      `${c.FirstName ?? ""} ${c.LastName ?? ""}`,
      c.Email,
    ]).slice(0, 8);
    return { opps, accounts, contacts };
  }, [q, oppsQ.data, accountsQ.data, contactsQ.data]);

  // Close on click-outside. Portal content lives at document.body so
  // a parent wrapper can't see clicks inside the popover — listen on
  // the document and compare against both the trigger and the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (target: LinkTarget) => {
    onPick(target);
    setOpen(false);
    setQ("");
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-7 flex-shrink-0 rounded border border-dashed border-border-strong bg-surface px-2 text-[11.5px] text-ink-3 hover:border-border-strong hover:text-ink-2"
      >
        Link to…
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={popoverRef}
              style={{ position: "fixed", top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
              className="z-50 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl"
            >
              <input
            autoFocus
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search opps, accounts, contacts…"
            className="h-8 w-full border-b border-border-strong bg-surface px-3 text-[12.5px] outline-none placeholder:text-ink-4"
          />
          <div className="max-h-[280px] overflow-y-auto py-1">
            {q.trim().length < 2 ? (
              <div className="px-3 py-3 text-center text-[11.5px] text-ink-3">
                Type at least 2 characters…
              </div>
            ) : (
              <>
                <Section
                  title="Opportunities"
                  isLoading={oppsQ.isLoading}
                  isError={oppsQ.isError}
                  count={matches.opps.length}
                >
                  {matches.opps.map((o) => (
                    <Row
                      key={o.Id}
                      onClick={() => pick({ type: "opportunity", id: o.Id, label: o.Name ?? o.Id })}
                      primary={o.Name ?? "(unnamed)"}
                      secondary={(o.Account?.Name ?? "") + (o.StageName ? ` · ${o.StageName}` : "")}
                    />
                  ))}
                </Section>
                <Section
                  title="Accounts"
                  isLoading={accountsQ.isLoading}
                  isError={accountsQ.isError}
                  count={matches.accounts.length}
                >
                  {matches.accounts.map((a) => (
                    <Row
                      key={a.Id}
                      onClick={() => pick({ type: "account", id: a.Id, label: a.Name ?? a.Id })}
                      primary={a.Name ?? "(unnamed)"}
                      secondary={a.Industry ?? ""}
                    />
                  ))}
                </Section>
                <Section
                  title="Contacts"
                  isLoading={contactsQ.isLoading}
                  isError={contactsQ.isError}
                  count={matches.contacts.length}
                >
                  {matches.contacts.map((c) => {
                    const name = `${c.FirstName ?? ""} ${c.LastName ?? ""}`.trim() || "(unnamed)";
                    return (
                      <Row
                        key={c.Id}
                        onClick={() => pick({ type: "contact", id: c.Id, label: name })}
                        primary={name}
                        secondary={c.Email ?? ""}
                      />
                    );
                  })}
                </Section>
              </>
            )}
          </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function Section({
  title,
  isLoading,
  isError,
  count,
  children,
}: {
  title: string;
  isLoading: boolean;
  isError: boolean;
  count: number;
  children: React.ReactNode;
}) {
  // Always render the section header so loading/error states for a
  // given entity type are visible — silent omission (the previous
  // "if empty return null" behavior) hid the case where useAccounts
  // hadn't returned yet, making the picker look like it didn't search
  // accounts at all.
  return (
    <div>
      <div className="flex items-center justify-between bg-surface-2 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        <span>{title}</span>
        {isLoading ? <span className="text-ink-4">loading…</span> : null}
        {!isLoading && isError ? <span className="text-red">error</span> : null}
        {!isLoading && !isError && count === 0 ? <span className="font-normal normal-case text-ink-4">no matches</span> : null}
      </div>
      {children}
    </div>
  );
}

function Row({
  onClick,
  primary,
  secondary,
}: {
  onClick: () => void;
  primary: string;
  secondary: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-surface-2",
      )}
    >
      <span className="truncate text-[12.5px] text-ink">{primary}</span>
      {secondary ? <span className="truncate text-[11px] text-ink-3">{secondary}</span> : null}
    </button>
  );
}
