/**
 * Canonical section container for entity detail pages (Account, Opp,
 * Contact, Award, Project).
 *
 * Features:
 *   - Optional collapse with localStorage persistence
 *   - Smart-default open/closed driven by data ("any open work?")
 *   - Optional header action slot ("+ Add", filter pill, etc.)
 *   - Storage scoped per page-type so the same section name doesn't
 *     collide across detail pages
 *
 * AccountDetail had a copy of this with hard-coded scope; OpportunityDetail
 * and ContactDetail had stripped-down versions without collapse. This
 * is the consolidated version — all detail pages should import this.
 */
import type React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { useCollapsible } from "@/lib/collapsible";

export interface SectionCardProps {
  title: string;
  /** Optional node rendered on the left of the header, after the title. */
  leftAction?: React.ReactNode;
  /** Optional action node rendered on the right of the header
   *  (e.g. "+ Add" button, status pill toggle). */
  action?: React.ReactNode;
  /** Default open/closed when the user hasn't expressed a preference
   *  yet. Pass a *current* boolean (e.g. `tasks.some((t) => isOpen(t))`)
   *  to drive a smart default — re-syncs as data loads. */
  defaultOpen?: boolean;
  /** When `false`, header is non-interactive and content is always
   *  shown. Use for "essentials" sections (Details on AccountDetail). */
  collapsible?: boolean;
  /** Storage scope qualifier — appended to the persistence key so the
   *  same section name on different page types tracks state independently.
   *  Defaults to "default". */
  storageScope?: string;
  children: React.ReactNode;
}

export function SectionCard({
  title,
  leftAction,
  action,
  defaultOpen = true,
  collapsible = true,
  storageScope = "default",
  children,
}: SectionCardProps) {
  const { open, toggle } = useCollapsible(
    `bedrock-v2:section:${storageScope}:${title}`,
    defaultOpen,
  );
  const isOpen = collapsible ? open : true;
  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      <div className="flex items-center gap-3 border-b border-border-strong bg-surface-2 px-5 py-2.5">
        {collapsible ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={isOpen}
            className="flex items-center gap-2 text-left"
          >
            {isOpen ? (
              <ChevronDown size={12} className="flex-shrink-0 text-ink-3" aria-hidden="true" />
            ) : (
              <ChevronRight size={12} className="flex-shrink-0 text-ink-3" aria-hidden="true" />
            )}
            <span className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
              {title}
            </span>
          </button>
        ) : (
          <span className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
            {title}
          </span>
        )}
        {leftAction ?? null}
        <div className="flex-1" />
        {action ?? null}
      </div>
      {isOpen ? children : null}
    </section>
  );
}
