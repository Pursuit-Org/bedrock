import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Tag } from "@/components/ui/Tag";
import { activityBodyText, decodeEntities } from "@/lib/emailText";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BedrockActivity } from "@/types/salesforce";

const EMAIL_PREVIEW_LENGTH = 800;

/**
 * Compact activity row for the record drawers (Account / Contact /
 * Opportunity). One-line preview; rows with a body expand to the full
 * cleaned email text or notes, with a show more/less toggle for long emails.
 */
export function ActivityListRow({ a }: { a: BedrockActivity }) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const body = activityBodyText(a);
  const hasBody = body.length > 0;

  return (
    <li className="border-b border-border-strong last:border-b-0">
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        disabled={!hasBody}
        aria-expanded={hasBody ? open : undefined}
        className={cn(
          "flex w-full items-start gap-2 px-4 py-2 text-left",
          hasBody ? "hover:bg-surface-2/50" : "cursor-default",
        )}
      >
        <span className="mt-1 flex-shrink-0 text-ink-3">
          {hasBody ? (
            open ? <ChevronDown size={11} /> : <ChevronRight size={11} />
          ) : (
            <span className="block w-[11px]" />
          )}
        </span>
        <Tag>{a.type}</Tag>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">
            {decodeEntities(a.subject) || "(no subject)"}
          </div>
          {hasBody && !open ? (
            <div className="line-clamp-1 text-[11.5px] text-ink-3">{body}</div>
          ) : null}
        </div>
        <div className="mono flex-shrink-0 text-[10.5px] text-ink-3">
          {fmtDate(a.occurred_at ?? a.created_at ?? null)}
        </div>
      </button>
      {open && hasBody ? (
        <div className="border-t border-border-strong bg-surface-2/40 px-4 py-2.5 pl-[35px]">
          <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-2">
            {showFull || body.length <= EMAIL_PREVIEW_LENGTH
              ? body
              : body.slice(0, EMAIL_PREVIEW_LENGTH) + "…"}
          </p>
          {body.length > EMAIL_PREVIEW_LENGTH ? (
            <button
              type="button"
              onClick={() => setShowFull((v) => !v)}
              className="mt-1 text-[11px] text-accent hover:underline"
            >
              {showFull ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
