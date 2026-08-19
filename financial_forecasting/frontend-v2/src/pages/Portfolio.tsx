/**
 * Portfolio Home — per-user homebase.
 *
 * Layout (top → bottom, by priority):
 *   1. Tasks, grouped by opp/account/project, with inline edit
 *   2. Accounts table, expandable rows
 *   3. Opportunities table, expandable rows
 *   4. Awards table, expandable rows
 *
 * Sections live in src/pages/portfolio/* — this file resolves the
 * target user from the URL (or auth), filters the global data sets to
 * that user's slice, then hands the slices off.
 *
 * Identity rules:
 *   - `/portfolio`             → authenticated user (from /auth/me)
 *   - `/portfolio/:identifier` → email or 15/18-char Salesforce User Id
 *   - Email is the canonical key (matches project.owner_email);
 *     sfUserId is required to filter SF-owned entities (Account.OwnerId,
 *     Opportunity.OwnerId). When SF isn't connected, those sections
 *     degrade gracefully with an empty-state.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Check, ChevronDown, RotateCcw, Search } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/services/accounts";
import { useAwards } from "@/services/awards";
import { useCurrentUser } from "@/services/auth";
import { usePortfolioUpcomingDeliverables } from "@/services/deliverables";
import { useOpportunities } from "@/services/opportunities";
import { usePerm } from "@/services/permissions";
import { useProjects } from "@/services/projects";
import { useUsers } from "@/services/users";
import { UpcomingDeliverablesPanel } from "@/components/UpcomingDeliverablesPanel";
import type { SfUser } from "@/types/salesforce";

import { PortfolioTasks } from "./portfolio/PortfolioTasks";
import { PortfolioAccounts } from "./portfolio/PortfolioAccounts";
import { PortfolioOpportunities } from "./portfolio/PortfolioOpportunities";
import { PortfolioAwards } from "./portfolio/PortfolioAwards";

interface ResolvedUser {
  email: string;
  displayName: string;
  /** Salesforce user id when discoverable. */
  sfUserId: string | null;
  picture?: string;
}

function useResolvedUser(identifier?: string): {
  user: ResolvedUser | null;
  loading: boolean;
  isSelf: boolean;
} {
  const meQ = useCurrentUser();
  const sfUsersQ = useUsers();

  const sfUsers = sfUsersQ.data ?? [];
  const isSelf = !identifier;

  if (isSelf) {
    const me = meQ.data;
    if (!me) return { user: null, loading: meQ.isLoading, isSelf: true };
    return {
      user: {
        email: me.email,
        displayName: me.name || me.email,
        sfUserId: me.salesforce_user_id ?? matchSfUserId(sfUsers, me.email),
        picture: me.picture,
      },
      loading: false,
      isSelf: true,
    };
  }

  const looksLikeSfId = /^[A-Za-z0-9]{15,18}$/.test(identifier);
  const match = sfUsers.find((u) =>
    looksLikeSfId
      ? u.Id === identifier
      : (u.Email ?? "").toLowerCase() === identifier.toLowerCase(),
  );

  if (!match && sfUsersQ.isLoading) {
    return { user: null, loading: true, isSelf: false };
  }
  if (!match) {
    if (!looksLikeSfId) {
      // Unknown email — still usable for bedrock-only entities.
      return {
        user: { email: identifier, displayName: identifier, sfUserId: null },
        loading: false,
        isSelf: false,
      };
    }
    return { user: null, loading: false, isSelf: false };
  }
  return {
    user: {
      email: match.Email ?? identifier,
      displayName: match.Name,
      sfUserId: match.Id,
    },
    loading: false,
    isSelf: false,
  };
}

function matchSfUserId(sfUsers: SfUser[], email: string): string | null {
  const lower = email.toLowerCase();
  const match = sfUsers.find((u) => (u.Email ?? "").toLowerCase() === lower);
  return match?.Id ?? null;
}

export function PortfolioPage() {
  const params = useParams<{ identifier?: string }>();
  const { user, loading, isSelf } = useResolvedUser(params.identifier);

  if (loading) {
    return (
      <div className="px-7 py-6">
        <PageHeader title="Portfolio" subtitle="Loading…" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="px-7 py-6">
        <PageHeader
          title="Portfolio"
          subtitle="Could not resolve that user. They may be inactive in Salesforce."
        />
      </div>
    );
  }

  return <PortfolioBody user={user} isSelf={isSelf} />;
}

function PortfolioBody({ user, isSelf }: { user: ResolvedUser; isSelf: boolean }) {
  const meQ = useCurrentUser();
  const sfUsersQ = useUsers();
  const accountsQ = useAccounts();
  const oppsQ = useOpportunities();
  const projectsQ = useProjects();
  const awardsQ = useAwards();

  // Permission to edit propagates from the global "edit_all_opportunities"
  // permission used elsewhere in the app. Stage and core opp fields are
  // gated on this same perm by the existing pages.
  const canEditOpps = usePerm("edit_all_opportunities");
  const canEditAccounts = usePerm("edit_accounts");
  const canEditAwards = usePerm("edit_awards");

  const { data: upcomingDeliverables = [] } = usePortfolioUpcomingDeliverables(user.sfUserId);

  // Slices owned by this user.
  const myAccounts = useMemo(
    () => filterByOwnerSfId(accountsQ.data ?? [], user.sfUserId),
    [accountsQ.data, user.sfUserId],
  );
  const myOpps = useMemo(
    () => filterByOwnerSfId(oppsQ.data ?? [], user.sfUserId),
    [oppsQ.data, user.sfUserId],
  );
  const oppIdsOwnedByUser = useMemo(
    () => new Set(myOpps.map((o) => o.Id)),
    [myOpps],
  );
  // Award ownership flows through award.opportunity_id → opp.OwnerId.
  const myAwards = useMemo(
    () =>
      (awardsQ.data ?? []).filter((a) => oppIdsOwnedByUser.has(a.opportunity_id)),
    [awardsQ.data, oppIdsOwnedByUser],
  );

  const oppsById = useMemo(() => byId(oppsQ.data ?? []), [oppsQ.data]);

  const subtitle = isSelf
    ? `${user.displayName} · your portfolio at a glance`
    : `Viewing ${user.displayName} · ${user.email}`;

  return (
    <div className="flex flex-col gap-5 px-7 py-6 pb-12">
      <PageHeader
        title={isSelf ? "Home" : `${user.displayName}'s Portfolio`}
        subtitle={subtitle}
        actions={
          <ViewAsPicker
            currentSfId={user.sfUserId}
            currentLabel={user.displayName}
            users={sfUsersQ.data ?? []}
            usersLoading={sfUsersQ.isLoading}
            myEmail={meQ.data?.email ?? null}
            isSelf={isSelf}
          />
        }
      />

      <PortfolioTasks
        sfUserId={user.sfUserId}
        userEmail={user.email}
        userDisplayName={user.displayName}
        projects={projectsQ.data ?? []}
        projectsLoading={projectsQ.isLoading}
      />

      <UpcomingDeliverablesPanel deliverables={upcomingDeliverables} context="portfolio" />

      <PortfolioOpportunities
        opps={myOpps}
        loading={oppsQ.isLoading}
        sfReady={Boolean(user.sfUserId)}
        canEdit={canEditOpps}
      />

      <PortfolioAwards
        awards={myAwards}
        oppsById={oppsById}
        loading={awardsQ.isLoading}
        canEdit={canEditAwards}
      />

      <PortfolioAccounts
        accounts={myAccounts}
        loading={accountsQ.isLoading}
        sfReady={Boolean(user.sfUserId)}
        canEdit={canEditAccounts}
      />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function filterByOwnerSfId<T extends { OwnerId?: string | null }>(
  rows: T[],
  sfUserId: string | null,
): T[] {
  if (!sfUserId) return [];
  return rows.filter((r) => r.OwnerId === sfUserId);
}


function byId<T extends { Id?: string }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) {
    if (r.Id) m.set(r.Id, r);
  }
  return m;
}

// ── "View as" user picker ────────────────────────────────────────────────

interface ViewAsPickerProps {
  /** SF user id currently being viewed — null when SF couldn't resolve.
   *  We key the trigger by id (rather than email) so the same display
   *  name on different SF users doesn't confuse the selected state. */
  currentSfId: string | null;
  currentLabel: string;
  users: SfUser[];
  usersLoading: boolean;
  /** Authenticated user's email — used to identify the "Me" entry and
   *  to provide the "Back to my portfolio" shortcut. */
  myEmail: string | null;
  isSelf: boolean;
}

/**
 * Lightweight search dropdown for switching the Portfolio's viewed
 * user. Navigates to `/portfolio/:sfUserId` on selection (or `/portfolio`
 * when the user picks themselves).
 *
 * Why inline here and not in @/components/ui: the dropdown is small,
 * routes to a Portfolio route, and pulls Portfolio's specific "back to
 * me" semantic. Lifting it would force callers to thread auth context
 * for marginal reuse.
 */
function ViewAsPicker({
  currentSfId,
  currentLabel,
  users,
  usersLoading,
  myEmail,
  isSelf,
}: ViewAsPickerProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click / escape.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const active = useMemo(
    () => users.filter((u) => u.IsActive ?? true).sort((a, b) => a.Name.localeCompare(b.Name)),
    [users],
  );

  const filtered = useMemo(() => {
    if (!q.trim()) return active.slice(0, 50);
    const lower = q.trim().toLowerCase();
    return active
      .filter((u) => {
        if (u.Name.toLowerCase().includes(lower)) return true;
        if ((u.Email ?? "").toLowerCase().includes(lower)) return true;
        return false;
      })
      .slice(0, 50);
  }, [active, q]);

  function pick(sfId: string | null) {
    setOpen(false);
    setQ("");
    if (sfId == null) navigate("/portfolio");
    else navigate(`/portfolio/${sfId}`);
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center gap-2">
        {!isSelf && myEmail ? (
          <button
            type="button"
            onClick={() => pick(null)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2"
            title="Return to your own portfolio"
          >
            <RotateCcw size={12} />
            Back to me
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "inline-flex items-center gap-2 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium hover:bg-surface-2",
            !isSelf && "border-accent/40",
          )}
        >
          <span className="text-[10.5px] uppercase tracking-wider text-ink-3">View as</span>
          <span className="max-w-[180px] truncate">{currentLabel}</span>
          <ChevronDown size={12} className="text-ink-3" />
        </button>
      </div>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+4px)] z-30 w-[280px] rounded-md border border-border-strong bg-surface shadow-lg">
          <div className="flex items-center gap-2 border-b border-border-strong px-3 py-2">
            <Search size={13} className="flex-shrink-0 text-ink-3" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search teammates…"
              className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] outline-none placeholder:text-ink-4"
            />
          </div>
          <ul className="max-h-[320px] overflow-y-auto py-1">
            {myEmail ? (
              <li>
                <button
                  type="button"
                  onClick={() => pick(null)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2"
                >
                  <div className="flex flex-col leading-tight">
                    <span className="font-medium">Me</span>
                    <span className="text-[11px] text-ink-3">{myEmail}</span>
                  </div>
                  {isSelf ? <Check size={13} className="flex-shrink-0 text-accent" /> : null}
                </button>
              </li>
            ) : null}

            {usersLoading ? (
              <li className="px-3 py-2 text-[12px] text-ink-3">Loading teammates…</li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-2 text-[12px] text-ink-3">No matches.</li>
            ) : (
              filtered.map((u) => {
                const isSelected = currentSfId === u.Id;
                return (
                  <li key={u.Id}>
                    <button
                      type="button"
                      onClick={() => pick(u.Id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2",
                        isSelected && "bg-surface-2",
                      )}
                    >
                      <div className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate font-medium">{u.Name}</span>
                        {u.Email ? (
                          <span className="truncate text-[11px] text-ink-3">{u.Email}</span>
                        ) : null}
                      </div>
                      {isSelected ? (
                        <Check size={13} className="flex-shrink-0 text-accent" />
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
