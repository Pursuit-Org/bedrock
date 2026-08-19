import { NavLink, Outlet, useLocation, useNavigationType } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  BarChart3,
  Building2,
  Briefcase,
  GraduationCap,
  Kanban,
  UserSearch,
  GitBranch,
  Trophy,
  ClipboardCheck,
  FolderOpen,
  Users,
  Sparkles,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  Link as LinkIcon,
  Home,
  Network,
  MessageSquarePlus,
  Receipt,
} from "lucide-react";

import { NotificationBell } from "@/components/NotificationBell";
import { TopBarSearch } from "@/components/TopBarSearch";
import { cn } from "@/lib/utils";
import { recordNavigation, saveScroll, restoreScroll } from "@/lib/navHistory";
import { useCurrentUser, useSalesforceStatus, startSalesforceConnect } from "@/services/auth";

const NAV_GROUPS = [
  {
    label: "PBD",
    items: [
      { to: "/portfolio", label: "PBD Home",  icon: Home },
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/cashflow",  label: "Cash Flow", icon: TrendingUp },
      { to: "/contacts",  label: "Contacts",  icon: Users },
      { to: "/accounts",  label: "Accounts",  icon: Building2 },
      { to: "/pipeline",  label: "Pipeline",  icon: GitBranch },
      { to: "/awards",    label: "Awards",    icon: Trophy },
      { to: "/commitments", label: "Commitments", icon: ClipboardCheck },
      { to: "/payments",  label: "Payments",  icon: Receipt },
      // Tasks page hidden 2026-05-04 — pending a Salesforce data-hygiene
      // pass to close the years-old open-task backlog. Tasks remain
      // visible on the per-record expand panels and detail pages, where
      // scoping makes the noise tractable. To restore the global page,
      // re-add `{ to: "/tasks", label: "Tasks", icon: CheckSquare }` and
      // re-import CheckSquare from lucide-react. Route at App.tsx is
      // still wired so direct URLs continue to work.
    ],
  },
  {
    label: "Jobs",
    items: [
      { to: "/jobs", label: "Jobs Home", icon: Briefcase },
      { to: "/jobs/performance", label: "Dashboard", icon: BarChart3 },
      { to: "/jobs/contacts", label: "Contacts", icon: Users },
      { to: "/jobs/accounts", label: "Accounts", icon: Building2 },
      { to: "/jobs/pipeline", label: "Pipeline", icon: Kanban },
      { to: "/jobs/placement", label: "Placement", icon: GraduationCap },
    ],
  },
  {
    label: "xOrg",
    items: [
      { to: "/projects", label: "Projects", icon: FolderOpen },
      { to: "/cleanup",  label: "SF Cleanup", icon: Sparkles },
      { to: "/jobs/candidates", label: "Candidates", icon: UserSearch },
      { to: "/jobs/network", label: "My Network", icon: Network },
    ],
  },
] as const;

const NAV_COLLAPSED_W = 52;
const NAV_EXPANDED_W = 232;

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("bedrock:sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("bedrock:sidebar-collapsed", String(next)); } catch {}
      return next;
    });
  return { collapsed, toggle };
}

export function AppShell() {
  const { collapsed, toggle } = useSidebarCollapsed();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const sf = useSalesforceStatus();

  // Pages that don't fundamentally need Salesforce — Settings (so the user
  // can connect SF), Projects (planning lives in Bedrock's own DB),
  // Feedback (intake form), and individual Award detail pages (status /
  // reports / dates live in bedrock; the SF-derived header is
  // server-enriched via the service-account client). Anything else
  // 503s the SF gate when SF is off.
  // Award LIST (`/awards`) still depends on a client-side join with
  // useOpportunities(), so it's intentionally NOT in this list — we
  // exempt only the `/awards/:id` detail route via the trailing slash.
  const SF_OPTIONAL_PREFIXES = [
    "/settings",
    "/projects",
    "/feedback",
    "/awards/",
    // The Jobs area is bedrock-DB-backed; its Salesforce calls are link-only
    // and degrade gracefully (never required to render). Don't hard-gate it
    // behind an SF connection — this also lets local dev (no SF creds) use the
    // jobs tool without a workaround.
    "/jobs",
  ];
  const sfOptional = SF_OPTIONAL_PREFIXES.some((p) => pathname.startsWith(p));
  const sfNotConnected = !sf.isLoading && sf.data?.connected === false;

  const navType = useNavigationType();
  const prevPathRef = useRef(pathname);
  useEffect(() => {
    const prev = prevPathRef.current;
    prevPathRef.current = pathname;

    // Save scroll position of the page we're leaving
    if (prev !== pathname && scrollRef.current) {
      saveScroll(prev, scrollRef.current.scrollTop);
    }

    if (navType === "POP") {
      // Back/forward — restore the saved scroll position
      const saved = restoreScroll(pathname);
      if (saved !== null && scrollRef.current) {
        // Defer so the DOM has time to render before scrolling
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: saved });
        });
      }
    } else {
      // Forward navigation — scroll to top
      scrollRef.current?.scrollTo({ top: 0 });
    }
    recordNavigation();
  }, [pathname, navType]);

  // ⌘K is now handled by TopBarSearch (focuses the inline input
  // instead of opening a modal). Keeping the keydown effect a no-op
  // here would just shadow that handler — drop it.

  return (
    <div
      // `grid-rows-[minmax(0,1fr)]` is not decoration. Without an explicit row
      // the grid gets one `auto` row, sized max(available, content) — so a
      // sidebar taller than the viewport grows the row past 100vh and the
      // container's overflow-hidden clips the bottom off both columns. It
      // happens to hold today because the aside also sets overflow-hidden
      // (which zeroes a grid item's automatic minimum size), but that is a
      // side effect propping the layout up, not a decision. Pin the row.
      className="grid h-screen grid-rows-[minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-200"
      style={{
        gridTemplateColumns: `${collapsed ? NAV_COLLAPSED_W : NAV_EXPANDED_W}px 1fr`,
      }}
    >
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <main className="flex flex-col overflow-hidden">
        {/* Top bar — inline search (left/center) + notification bell
            (right). Page title removed: the active sidebar item is the
            canonical "you are here" indicator, and a duplicate label
            in the top bar was costing vertical space for no signal. */}
        <header className="flex h-9 flex-shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
          <TopBarSearch />
          <NotificationBell />
        </header>
        {sfNotConnected && !sfOptional ? (
          <SalesforceGate />
        ) : (
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <Outlet />
          </div>
        )}
      </main>
    </div>
  );
}

function SalesforceGate() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-ink-3">
        <LinkIcon size={22} />
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-[17px] font-semibold text-ink">Connect Salesforce</h2>
        <p className="max-w-[340px] text-[13px] text-ink-3">
          Bedrock reads and writes directly to your Salesforce org. Connect your account to get started.
        </p>
      </div>
      <button
        type="button"
        onClick={startSalesforceConnect}
        className="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-surface hover:opacity-90"
      >
        Connect Salesforce
      </button>
      <p className="text-[11.5px] text-ink-4">
        You can also connect in{" "}
        <a href="/settings" className="underline hover:text-ink-2">
          Settings → Connections
        </a>
      </p>
    </div>
  );
}

function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** Kept in the prop type for callers that still pass it (top-bar
   *  search trigger replaced the sidebar one as of 2026-05-20). */
  onSearchOpen?: () => void;
}) {
  const { data: user } = useCurrentUser();
  const sf = useSalesforceStatus();
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  // Keep the current page's nav item visible. Now that the nav scrolls, a deep
  // link or a jump between groups can land with the active item out of view,
  // which reads as "this page isn't in the nav". `nearest` scrolls the minimum
  // needed, so an already-visible item doesn't jump.
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>("[aria-current='page']");
    if (!active) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    active.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [pathname, collapsed]);

  return (
    // Three bands: a fixed brand row, a scrolling nav, and a pinned footer.
    // `min-h-0` is load-bearing — a flex child defaults to min-height:auto and
    // refuses to shrink below its content, so without it the nav below can
    // never scroll no matter what overflow it declares.
    <aside
      className={cn(
        "relative flex min-h-0 flex-col gap-1 overflow-hidden border-r border-border bg-surface-2 transition-all duration-200",
        collapsed ? "p-2" : "p-3",
      )}
    >
      {/* Logo / wordmark — toggle lives in this row, anchored to the
          right edge when expanded and stacked under the logo when
          collapsed (so it can't overlap the user avatar at bottom). */}
      <div
        className={cn(
          "flex flex-shrink-0 items-center gap-2 px-1 py-3",
          collapsed && "flex-col gap-2 px-0",
        )}
      >
        <img
          src="/bedrock-logo.png"
          alt="Bedrock"
          className="h-8 w-8 flex-shrink-0 rounded-md"
        />
        {!collapsed && (
          <div className="flex flex-col leading-tight">
            <span className="text-[15px] font-semibold tracking-tight">Bedrock</span>
            <span className="text-[11px] text-ink-3">Pursuit · Workspace</span>
          </div>
        )}
        <button
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "grid h-6 w-6 flex-shrink-0 place-items-center rounded-md text-ink-3 hover:bg-black/[0.05] hover:text-ink",
            !collapsed && "ml-auto",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>
      </div>

      {/* Search trigger moved to the top bar (2026-05-20). */}

      {/* The only scrolling band. Everything that must always be reachable —
          Feedback, Settings, the signed-in user — lives BELOW it, pinned, so
          no amount of nav growth can push them off screen. That was the bug:
          19 items plus group headers overflowed a laptop viewport and the
          footer got clipped by the aside's overflow-hidden, leaving no route
          to Settings at all (and so no way to reconnect Salesforce). */}
      <nav
        ref={navRef}
        aria-label="Main"
        className="nav-scroll -mr-1 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pr-1"
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                {group.label}
              </div>
            )}
            <div className="flex flex-col gap-px">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  title={collapsed ? item.label : undefined}
                  end={item.to === "/jobs"}
                  className={({ isActive }) =>
                    cn(
                      "flex select-none items-center rounded-md text-[13px] font-medium text-ink-2 hover:bg-black/[0.04] hover:text-ink",
                      collapsed
                        ? "h-9 w-9 justify-center"
                        : "gap-2.5 px-2.5 py-1.5",
                      isActive &&
                        "border border-border-strong bg-surface text-ink shadow-sm",
                    )
                  }
                >
                  <item.icon size={16} className="flex-shrink-0 opacity-70" />
                  {!collapsed && <span>{item.label}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Pinned. `flex-shrink-0` keeps it at its natural height while the nav
          above absorbs the pressure; the hairline reads as the edge of the
          scrolling region so a half-visible nav item doesn't look like the end
          of the list. `mt-auto` is gone — the nav's flex-1 does that job now,
          and leaving both in fights over the free space. */}
      <div className="mt-2 flex flex-shrink-0 flex-col gap-px border-t border-border pt-2">
        <NavLink
          to="/feedback"
          title={collapsed ? "Bug reports & feature requests" : undefined}
          className={({ isActive }) =>
            cn(
              "flex select-none items-center rounded-md text-[13px] font-medium text-ink-2 hover:bg-black/[0.04] hover:text-ink",
              collapsed ? "h-9 w-9 justify-center" : "gap-2.5 px-2.5 py-1.5",
              isActive && "border border-border-strong bg-surface text-ink shadow-sm",
            )
          }
        >
          <MessageSquarePlus size={16} className="flex-shrink-0 opacity-70" />
          {!collapsed && <span>Feedback</span>}
        </NavLink>
        <NavLink
          to="/settings"
          title={
            collapsed
              ? sf.data?.connected
                ? `Settings · SF: ${sf.data.user_name ?? "connected"}`
                : "Settings · Salesforce not connected"
              : undefined
          }
          className={({ isActive }) =>
            cn(
              "flex select-none items-center rounded-md text-[13px] font-medium text-ink-2 hover:bg-black/[0.04] hover:text-ink",
              collapsed ? "h-9 w-9 justify-center" : "gap-2.5 px-2.5 py-1.5",
              isActive && "border border-border-strong bg-surface text-ink shadow-sm",
            )
          }
        >
          <SettingsIcon size={16} className="flex-shrink-0 opacity-70" />
          {!collapsed && (
            <>
              <span className="flex-1">Settings</span>
              {!sf.isLoading && (
                <span
                  className={cn(
                    "inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full",
                    sf.data?.connected ? "bg-green" : "bg-amber",
                  )}
                  title={sf.data?.connected ? `SF: ${sf.data.user_name ?? "connected"}` : "Salesforce not connected"}
                />
              )}
            </>
          )}
        </NavLink>

        {/* User avatar (bell moved to the top-bar 2026-05-20). */}
        {user && (
          <div
            className={cn(
              "mt-2 flex items-center rounded-md px-1 py-2",
              collapsed ? "justify-center" : "gap-2 px-2.5",
            )}
          >
            {user.picture ? (
              <img
                src={user.picture}
                alt=""
                className="h-6 w-6 flex-shrink-0 rounded-full border border-border-strong"
              />
            ) : (
              <div className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-surface text-[11px] font-semibold text-ink-2">
                {user.name?.[0] ?? "?"}
              </div>
            )}
            {!collapsed && (
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[12px] font-medium">{user.name}</span>
                <span className="truncate text-[11px] text-ink-4">{user.email}</span>
              </div>
            )}
          </div>
        )}
      </div>

    </aside>
  );
}
