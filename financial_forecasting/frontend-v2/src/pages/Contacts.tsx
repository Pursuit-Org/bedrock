import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Fragment } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Mail, Search } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { ContactExpandPanel, CONTACT_PANEL_HEIGHT } from "@/components/ContactExpandPanel";
import { PageHeader } from "@/components/PageHeader";
import { InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { ColGroup, ResizableTh } from "@/components/ui/ResizableTable";
import { ExpandRow } from "@/components/ui/ExpandRow";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Toolbar } from "@/components/ui/Toolbar";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { fmtDate, initials } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { cn } from "@/lib/utils";
import {
  AddFilterButton,
  FilterChip,
  type FieldMeta,
  type FilterRule,
  describeRule,
  ruleApplies,
} from "@/pages/cleanup/Filters";
import { useContacts, useUpdateContact } from "@/services/contacts";
import { usePerm } from "@/services/permissions";
import { useActiveUsers, useUsers } from "@/services/users";
import type { SfContact } from "@/types/salesforce";

interface ContactFilter {
  philOnly: boolean;
}

// ── Chip filter model ────────────────────────────────────────────────────

const CONTACTS_FILTERABLE = {
  name: {
    label: "Name",
    type: "text",
    getValue: (c: SfContact) =>
      [c.FirstName, c.LastName].filter(Boolean).join(" ") || c.Name || "",
  },
  account: { label: "Account", type: "text", getValue: (c: SfContact) => c.Account?.Name ?? "" },
  email: { label: "Email", type: "text", getValue: (c: SfContact) => c.Email ?? "" },
  title: { label: "Title", type: "text", getValue: (c: SfContact) => c.Title ?? "" },
  owner: { label: "Owner", type: "select", getValue: (c: SfContact) => c.OwnerId ?? "" },
  philanthropy: {
    label: "Philanthropic",
    type: "select",
    getValue: (c: SfContact) =>
      c.Philanthropic_Contact__c || c.Philanthropy__c ? "Yes" : "No",
  },
  boardStatus: {
    label: "Board status",
    type: "select",
    getValue: (c: SfContact) => c.Board_Status__c ?? "",
  },
  state: { label: "State", type: "text", getValue: (c: SfContact) => c.MailingState ?? "" },
  lastActivity: {
    label: "Last activity",
    type: "date",
    getValue: (c: SfContact) =>
      c.Last_Activity_Date__c ?? c.LastActivityDate ?? null,
  },
} satisfies Record<string, FieldMeta<SfContact>>;

type ContactField = keyof typeof CONTACTS_FILTERABLE;

interface ContactsSavedView {
  filter?: ContactFilter;
  rules?: FilterRule<ContactField>[];
  visibleCols?: ColKey[];
  widths?: Partial<Record<ColKey, number>>;
}

type ColKey =
  | "name"
  | "account"
  | "email"
  | "phone"
  | "owner"
  | "lastActivity";

const COLUMN_ORDER: ColKey[] = [
  "name",
  "account",
  "email",
  "phone",
  "owner",
  "lastActivity",
];

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  name: 260,
  account: 220,
  email: 240,
  phone: 150,
  owner: 160,
  lastActivity: 130,
};

const COL_LABELS: Record<ColKey, string> = {
  name: "Contact",
  account: "Account",
  email: "Email",
  phone: "Phone",
  owner: "Owner",
  lastActivity: "Last activity",
};

const ROW_HEIGHT = 44; // px — must match the row's actual rendered height

/** Stable router-state for outbound detail-page links so BackLinks
 *  render "Back to Contacts" instead of their static defaults. */
const CONTACTS_REFERRER = {
  from: { pathname: "/contacts", label: "Contacts" },
} as const;

function extractContact(c: SfContact, key: ColKey): unknown {
  switch (key) {
    case "name":
      return (
        [c.LastName, c.FirstName].filter(Boolean).join(" ") || c.Name || ""
      );
    case "account":
      return c.Account?.Name ?? "";
    case "email":
      return c.Email ?? "";
    case "phone":
      return c.Phone || c.MobilePhone || "";
    case "owner":
      return c.Owner?.Name ?? "";
    case "lastActivity":
      return c.Last_Activity_Date__c ?? c.LastActivityDate ?? null;
  }
}

export function ContactsPage() {
  const navigate = useNavigate();
  const contactsQ = useContacts();
  const usersQ = useActiveUsers();
  // All users (active + inactive). Used only for the chip-filter owner
  // facet — write-side pickers stay on `usersQ` (active only).
  const allUsersQ = useUsers();
  const updateContact = useUpdateContact();
  const canEdit = usePerm("edit_contacts");

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<ContactFilter>({ philOnly: false });
  const [rules, setRules] = useState<FilterRule<ContactField>[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { philOnly } = filter;
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility("bedrock-v2:vis:contacts", COLUMN_ORDER);

  const { sort, toggle } = useSort<ColKey>({ key: "name", direction: "asc" });
  const { widths, startResize, replaceAll: replaceWidths } = useColumnWidths<ColKey>(
    "bedrock-v2:cols:contacts",
    DEFAULT_WIDTHS,
  );

  const contacts = contactsQ.data ?? [];

  // Contacts that match the toolbar filters (Philanthropy-only toggle +
  // search). Used to populate the chip-filter owner facet so it
  // reflects what's visible in the table. Chip `rules` are excluded to
  // avoid the picker collapsing once an owner filter is applied.
  const contactsInView = useMemo(() => {
    const needle = q.toLowerCase();
    return contacts.filter((c) => {
      if (philOnly && !c.Philanthropic_Contact__c && !c.Philanthropy__c) {
        return false;
      }
      if (q) {
        const hit =
          (c.Name ?? "").toLowerCase().includes(needle) ||
          (c.FirstName ?? "").toLowerCase().includes(needle) ||
          (c.LastName ?? "").toLowerCase().includes(needle) ||
          (c.Email ?? "").toLowerCase().includes(needle) ||
          (c.Account?.Name ?? "").toLowerCase().includes(needle) ||
          (c.Title ?? "").toLowerCase().includes(needle);
        if (!hit) return false;
      }
      return true;
    });
  }, [contacts, philOnly, q]);

  // Chip-filter facets — owner options are the union of:
  //   (a) every active SF user, and
  //   (b) inactive users with at least one row in the current view.
  // Board status comes from contacts visible in the current view.
  const chipFacets = useMemo(() => {
    const all = allUsersQ.data ?? [];
    const activeById = new Map(
      all.filter((u) => u.IsActive).map((u) => [u.Id, u]),
    );
    const inactiveById = new Map(
      all.filter((u) => !u.IsActive).map((u) => [u.Id, u]),
    );

    const ownersInView = new Set<string>();
    const ownerNameFromData = new Map<string, string>();
    const boardStatuses = new Set<string>();
    for (const c of contactsInView) {
      if (c.OwnerId) {
        ownersInView.add(c.OwnerId);
        if (c.Owner?.Name) ownerNameFromData.set(c.OwnerId, c.Owner.Name);
      }
      if (c.Board_Status__c) boardStatuses.add(c.Board_Status__c);
    }

    type OwnerOption = { value: string; label: string };
    const ownerOptions: OwnerOption[] = [];
    for (const u of activeById.values()) {
      ownerOptions.push({ value: u.Id, label: u.Name });
    }
    for (const id of ownersInView) {
      if (activeById.has(id)) continue;
      const inactive = inactiveById.get(id);
      const name = inactive?.Name ?? ownerNameFromData.get(id) ?? id;
      ownerOptions.push({ value: id, label: `${name} (inactive)` });
    }
    ownerOptions.sort((x, y) => x.label.localeCompare(y.label));

    return {
      owner: ownerOptions,
      boardStatus: Array.from(boardStatuses)
        .sort()
        .map((v) => ({ value: v, label: v })),
      philanthropy: [
        { value: "Yes", label: "Yes" },
        { value: "No", label: "No" },
      ],
    };
  }, [contactsInView, allUsersQ.data]);

  const ownerLabelLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of usersQ.data ?? []) m.set(u.Id, u.Name);
    for (const c of contacts) {
      if (c.OwnerId && !m.has(c.OwnerId) && c.Owner?.Name) {
        m.set(c.OwnerId, c.Owner.Name);
      }
    }
    return (id: string) => m.get(id) ?? id;
  }, [usersQ.data, contacts]);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    const f = contacts.filter((c) => {
      if (philOnly && !c.Philanthropic_Contact__c && !c.Philanthropy__c) {
        return false;
      }
      if (q) {
        const hit =
          (c.Name ?? "").toLowerCase().includes(needle) ||
          (c.FirstName ?? "").toLowerCase().includes(needle) ||
          (c.LastName ?? "").toLowerCase().includes(needle) ||
          (c.Email ?? "").toLowerCase().includes(needle) ||
          (c.Account?.Name ?? "").toLowerCase().includes(needle) ||
          (c.Title ?? "").toLowerCase().includes(needle);
        if (!hit) return false;
      }
      for (const r of rules) {
        if (!ruleApplies(c, r, CONTACTS_FILTERABLE)) return false;
      }
      return true;
    });
    return sortBy(f, sort, extractContact);
  }, [contacts, q, philOnly, rules, sort]);

  const ownerOptions = useMemo(
    () =>
      (usersQ.data ?? []).map((u) => ({
        value: u.Id,
        label: u.Name,
      })),
    [usersQ.data],
  );

  const saveTitle = useCallback(
    (id: string, title: string) =>
      updateContact.mutateAsync({ id, patch: { Title: title } }).then(() => undefined),
    [updateContact],
  );

  const saveEmail = useCallback(
    (id: string, email: string) =>
      updateContact.mutateAsync({ id, patch: { Email: email } }).then(() => undefined),
    [updateContact],
  );

  const savePhone = useCallback(
    (id: string, phone: string) =>
      updateContact.mutateAsync({ id, patch: { Phone: phone } }).then(() => undefined),
    [updateContact],
  );

  const saveOwner = useCallback(
    async (id: string, ownerId: string) => {
      const ownerName =
        (usersQ.data ?? []).find((u) => u.Id === ownerId)?.Name ?? null;
      await updateContact.mutateAsync({
        id,
        patch: { OwnerId: ownerId },
        displayPatch: { Owner: { Name: ownerName } },
      });
    },
    [updateContact, usersQ.data],
  );

  const isLoading = contactsQ.isLoading;
  const isError = contactsQ.isError;
  const error = contactsQ.error;

  const tableMinWidth = totalWidth(widths);

  // ── Virtualization ─────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) =>
      filtered[i]?.Id === expandedId ? ROW_HEIGHT + CONTACT_PANEL_HEIGHT : ROW_HEIGHT,
    overscan: 8,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [expandedId, virtualizer]);
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom =
    totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  return (
    <div className="flex h-full flex-col px-7 py-6 pb-6">
      <PageHeader
        title="Contacts"
        subtitle={
          isLoading
            ? "Loading…"
            : `${filtered.length.toLocaleString()} of ${contacts.length.toLocaleString()} contacts`
        }
      />

      <Toolbar>
        <button
          onClick={() => setFilter((f) => ({ ...f, philOnly: !f.philOnly }))}
          className={cn(
            "h-7 rounded border px-3 text-[12.5px] font-medium",
            philOnly
              ? "border-ink bg-ink text-surface"
              : "border-border-strong bg-surface text-ink-2",
          )}
        >
          Philanthropic only
        </button>
        <div className="relative">
          <Search
            size={12}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            placeholder="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-56 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
          />
        </div>
        <AddFilterButton<ContactField>
          filterable={CONTACTS_FILTERABLE as Record<ContactField, FieldMeta<unknown>>}
          selectOptions={{
            owner: chipFacets.owner,
            boardStatus: chipFacets.boardStatus,
            philanthropy: chipFacets.philanthropy,
          }}
          onAdd={(r) => setRules((prev) => [...prev, r])}
          buttonLabel="Filter"
        />
        <div className="ml-auto flex items-center gap-2">
          <ColumnChooser
            allColumns={COLUMN_ORDER}
            labels={COL_LABELS}
            visible={visibleCols}
            required={["name"]}
            onToggle={toggleCol}
          />
          <SavedViewsPicker<ContactsSavedView>
            scopeKey="contacts"
            currentFilters={{ filter, rules, visibleCols, widths }}
            onLoad={(v) => {
              setFilter(v.filter ?? { philOnly: false });
              setRules(v.rules ?? []);
              if (v.visibleCols && v.visibleCols.length > 0) {
                replaceVisibleCols(v.visibleCols);
              }
              if (v.widths && Object.keys(v.widths).length > 0) {
                replaceWidths(v.widths);
              }
            }}
          />
        </div>
      </Toolbar>

      {/* Active filter chips. Border-attached strip, same pattern as
          Pipeline / Accounts: continues the toolbar card downward into
          the table, aligned px-3 with the toolbar above. */}
      {rules.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-x border-t border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, CONTACTS_FILTERABLE, (field, v) =>
                field === "owner" ? ownerLabelLookup(v) : v,
              )}
              onRemove={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}
            />
          ))}
          <button
            type="button"
            onClick={() => setRules([])}
            className="ml-1 whitespace-nowrap text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline"
          >
            Clear all
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto rounded-b-lg border border-border-strong bg-surface"
      >
        <table
          className="border-collapse"
          style={{
            tableLayout: "fixed",
            width: "100%",
            minWidth: tableMinWidth,
          }}
        >
          <ColGroup order={visibleCols} widths={widths} />
          <thead className="sticky top-0 z-10">
            <tr>
              {visibleCols.map((key, idx) => (
                <ResizableTh
                  key={key}
                  width={widths[key]}
                  onStartResize={(e) => startResize(key, e)}
                  align="left"
                  isLast={idx === visibleCols.length - 1}
                >
                  <SortableHeader
                    label={COL_LABELS[key]}
                    sortKey={key}
                    sort={sort}
                    onToggle={toggle}
                  />
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <SkeletonRows colCount={visibleCols.length} />
            ) : isError ? (
              <tr>
                <td
                  colSpan={visibleCols.length}
                  className="px-7 py-10 text-center text-[13px] text-red"
                >
                  Failed to load contacts
                  {error instanceof Error ? `: ${error.message}` : ""}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={visibleCols.length}
                  className="px-7 py-10 text-center text-[13px] text-ink-3"
                >
                  {contacts.length === 0
                    ? "No contacts. (Is Salesforce connected?)"
                    : "No contacts match your filters."}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 ? (
                  <tr aria-hidden style={{ height: paddingTop }}>
                    <td colSpan={visibleCols.length} />
                  </tr>
                ) : null}
                {virtualItems.map((vi) => {
                  const c = filtered[vi.index];
                  const isExpanded = c.Id === expandedId;
                  return (
                    <Fragment key={c.Id}>
                      <ContactRow
                        c={c}
                        ownerOptions={ownerOptions}
                        visibleCols={visibleCols}
                        canEdit={canEdit}
                        isExpanded={isExpanded}
                        onToggleExpand={() =>
                          setExpandedId(isExpanded ? null : c.Id)
                        }
                        onOpen={() => navigate(`/contacts/${c.Id}`, { state: CONTACTS_REFERRER })}
                        onSaveTitle={(title) => saveTitle(c.Id, title)}
                        onSaveEmail={(email) => saveEmail(c.Id, email)}
                        onSavePhone={(phone) => savePhone(c.Id, phone)}
                        onSaveOwner={(ownerId) => saveOwner(c.Id, ownerId)}
                      />
                      {isExpanded ? (
                        <ExpandRow colSpan={visibleCols.length}>
                          <ContactExpandPanel contactId={c.Id} />
                        </ExpandRow>
                      ) : null}
                    </Fragment>
                  );
                })}
                {paddingBottom > 0 ? (
                  <tr aria-hidden style={{ height: paddingBottom }}>
                    <td colSpan={visibleCols.length} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RowProps {
  c: SfContact;
  ownerOptions: { value: string; label: string }[];
  visibleCols: ColKey[];
  canEdit: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onOpen: () => void;
  onSaveTitle: (title: string) => Promise<void>;
  onSaveEmail: (email: string) => Promise<void>;
  onSavePhone: (phone: string) => Promise<void>;
  onSaveOwner: (ownerId: string) => Promise<void>;
}

const ContactRow = memo(function ContactRow({
  c,
  ownerOptions,
  visibleCols,
  canEdit,
  isExpanded,
  onToggleExpand,
  onOpen,
  onSaveTitle,
  onSaveEmail,
  onSavePhone,
  onSaveOwner,
}: RowProps) {
  const fullName =
    [c.FirstName, c.LastName].filter(Boolean).join(" ") || c.Name || "—";

  const cells: Record<ColKey, React.ReactNode> = {
    name: (
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          className="flex-shrink-0 text-ink-4 transition-colors hover:text-ink-2"
          aria-label={isExpanded ? "Collapse details" : "Expand details"}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <div className="grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-full bg-surface-2 text-[9px] font-semibold text-ink-2">
          {initials(fullName === "—" ? "?" : fullName)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <button
            type="button"
            onClick={onOpen}
            className="truncate text-left font-medium hover:underline"
            title={fullName}
          >
            {fullName}
          </button>
          {canEdit ? (
            <InlineText
              value={c.Title}
              onSave={onSaveTitle}
              placeholder="Add title…"
              className="px-1 py-0.5 text-[11px] text-ink-3"
            />
          ) : (
            <span className="truncate px-1 text-[11px] text-ink-3">
              {c.Title ?? ""}
            </span>
          )}
        </div>
      </div>
    ),
    account: c.AccountId ? (
      <Link
        to={`/accounts/${c.AccountId}`}
        state={CONTACTS_REFERRER}
        className="block truncate text-ink-2 hover:underline"
        title={c.Account?.Name ?? ""}
      >
        {c.Account?.Name ?? "—"}
      </Link>
    ) : (
      <span className="text-ink-4">—</span>
    ),
    email: canEdit ? (
      <MailtoEditableCell value={c.Email} onSave={onSaveEmail} />
    ) : (
      c.Email ? (
        <a
          href={`mailto:${c.Email}`}
          className="inline-flex min-w-0 items-center gap-1 truncate text-ink-2 hover:text-accent-ink"
        >
          <Mail size={11} className="flex-shrink-0" />
          <span className="truncate">{c.Email}</span>
        </a>
      ) : (
        <span className="text-ink-4">—</span>
      )
    ),
    phone: canEdit ? (
      <InlineText
        value={c.Phone || c.MobilePhone}
        onSave={onSavePhone}
        placeholder="Add phone…"
        className="px-1 py-0.5"
      />
    ) : (
      <span className="text-ink-3">{c.Phone || c.MobilePhone || "—"}</span>
    ),
    owner: canEdit ? (
      <InlineSelect
        value={c.OwnerId}
        options={ownerOptions}
        onSave={onSaveOwner}
        renderValue={(v) => (
          <span className="truncate text-[12.5px] text-ink-2">
            {c.Owner?.Name ??
              ownerOptions.find((o) => o.value === v)?.label ??
              "—"}
          </span>
        )}
      />
    ) : (
      <span className="text-ink-2">{c.Owner?.Name ?? "—"}</span>
    ),
    lastActivity: (
      <span
        className="cursor-pointer truncate text-[13px] tabular-nums text-ink-2"
        onClick={onOpen}
      >
        {fmtDate(c.Last_Activity_Date__c ?? c.LastActivityDate)}
      </span>
    ),
  };

  const cellCls: Record<ColKey, string> = {
    name: "overflow-hidden px-3 py-1 text-[13px]",
    account: "overflow-hidden px-3 py-1 text-[12.5px]",
    email: "overflow-hidden px-3 py-1 text-[12.5px]",
    phone: "overflow-hidden px-3 py-1 text-[12.5px] text-ink-3",
    owner: "overflow-hidden px-3 py-1 text-[12.5px] text-ink-2",
    lastActivity: "overflow-hidden px-3 py-1 text-[12.5px]",
  };

  return (
    <tr
      className="group/row border-b border-border-strong hover:bg-surface-2"
      style={{ height: ROW_HEIGHT }}
    >
      {visibleCols.map((key) => (
        <td key={key} className={cellCls[key]}>
          {cells[key]}
        </td>
      ))}
    </tr>
  );
});

/**
 * Editable email cell. Shows a mailto: link when idle so a click opens
 * the user's mail client; clicking the surrounding cell (not the link
 * itself) flips to an inline editor identical to InlineText's edit mode.
 *
 * We can't reuse InlineText directly because its display mode is a
 * <button> (opens edit on click) — we need the link affordance too, so
 * we ship this small twin here rather than threading a new prop through
 * the shared component.
 */
function MailtoEditableCell({
  value,
  onSave,
}: {
  value: string | null | undefined;
  onSave: (next: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(value ?? "");
    setOptimistic((prev) => (prev != null && prev === value ? null : prev));
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const display = optimistic ?? value;

  const commit = async () => {
    if (saving) return;
    if ((draft ?? "").trim() === (value ?? "").trim()) {
      setEditing(false);
      return;
    }
    setOptimistic(draft);
    setEditing(false);
    setSaving(true);
    try {
      await onSave(draft);
    } catch {
      setOptimistic(null);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="rounded ring-2 ring-accent">
        <input
          ref={inputRef}
          type="email"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(value ?? "");
              setEditing(false);
            } else if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          placeholder="Add email…"
          className="block w-full border-0 bg-transparent px-1.5 py-1 text-[13px] text-ink outline-none placeholder:text-ink-4"
        />
      </div>
    );
  }

  if (!display) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="flex w-full items-center rounded px-1.5 py-1 text-left text-[13px] italic text-ink-4 hover:bg-surface hover:ring-1 hover:ring-border-strong"
      >
        Add email…
      </button>
    );
  }

  return (
    <div
      className="group/edit flex w-full items-center rounded px-1.5 py-1 hover:bg-surface hover:ring-1 hover:ring-border-strong"
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      <a
        href={`mailto:${display}`}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-ink-2 hover:text-accent-ink"
        title={`${display} — double-click to edit`}
      >
        <Mail size={11} className="flex-shrink-0" />
        <span className="truncate">{display}</span>
      </a>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="ml-1 rounded px-1 py-0.5 text-[10px] text-ink-3 opacity-0 transition-opacity hover:bg-surface-2 group-hover/edit:opacity-100"
        title="Edit"
      >
        edit
      </button>
    </div>
  );
}

function SkeletonRows({ colCount }: { colCount: number }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="border-b border-border-strong">
          <td colSpan={colCount} className="px-3 py-2.5">
            <div className="h-4 w-full animate-pulse rounded bg-surface-2" />
          </td>
        </tr>
      ))}
    </>
  );
}
