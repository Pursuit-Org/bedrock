import { useEffect, useState } from "react";
import { Check } from "lucide-react";

import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
  type NotificationPreferences,
} from "@/services/notifications";

const ACTIVITY_BUCKETS: {
  key: keyof Pick<
    NotificationPreferences,
    "account_activity_enabled" | "contact_activity_enabled" | "opportunity_activity_enabled"
  >;
  label: string;
  hint: string;
}[] = [
  { key: "account_activity_enabled", label: "Accounts", hint: "Ownership changes, comments, and files on accounts you own" },
  { key: "contact_activity_enabled", label: "Contacts", hint: "Ownership changes and comments on contacts you own" },
  { key: "opportunity_activity_enabled", label: "Opportunities", hint: "Ownership changes on opportunities you own" },
];

export function NotificationsTab() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();

  // Local draft so toggles feel instant; synced from the server value
  // whenever it changes underneath us (first load, or another tab).
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  function set(patch: Partial<NotificationPreferences>) {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    update.mutate(next);
  }

  if (isError) {
    return (
      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
        <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
          <div className="text-[12.5px] font-medium text-ink">Couldn't load notification preferences</div>
          <div className="max-w-[420px] text-[11.5px] text-ink-3">
            {error instanceof Error ? error.message : "The server returned an error."}
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isRefetching}
            className="mt-1 rounded-md border border-border-strong px-3 py-1 text-[12px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
          >
            {isRefetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      </div>
    );
  }

  if (isLoading || !draft) {
    return (
      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
        <div className="px-5 py-6 text-center text-[12px] text-ink-3">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
        <div className="border-b border-border-strong bg-surface-2 px-5 py-2.5">
          <div className="text-[13px] font-semibold text-ink">Delivery</div>
          <div className="mt-0.5 text-[12px] text-ink-3">Where notifications reach you</div>
        </div>
        <ul className="divide-y divide-border-strong">
          <li className="flex items-center justify-between gap-3 px-5 py-3">
            <div>
              <div className="text-[12.5px] font-medium text-ink">In-app</div>
              <div className="text-[11.5px] text-ink-3">The bell always shows your notifications</div>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink-3">
              <Check size={12} aria-hidden /> Always on
            </span>
          </li>
          <li className="flex items-center justify-between gap-3 px-5 py-3">
            <div>
              <div className="text-[12.5px] font-medium text-ink">Slack</div>
              <div className="text-[11.5px] text-ink-3">Also DM me on Slack when I get a notification</div>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={draft.slack_enabled}
                onChange={(e) => set({ slack_enabled: e.target.checked })}
                className="h-3.5 w-3.5 cursor-pointer"
              />
            </label>
          </li>
        </ul>
      </div>

      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
        <div className="border-b border-border-strong bg-surface-2 px-5 py-2.5">
          <div className="text-[13px] font-semibold text-ink">Activity on records you own</div>
          <div className="mt-0.5 text-[12px] text-ink-3">
            Turn a category off to stop getting notified about it entirely
          </div>
        </div>
        <ul className="divide-y divide-border-strong">
          {ACTIVITY_BUCKETS.map((b) => (
            <li key={b.key} className="flex items-center justify-between gap-3 px-5 py-3">
              <div>
                <div className="text-[12.5px] font-medium text-ink">{b.label}</div>
                <div className="text-[11.5px] text-ink-3">{b.hint}</div>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft[b.key]}
                  onChange={(e) => set({ [b.key]: e.target.checked })}
                  className="h-3.5 w-3.5 cursor-pointer"
                />
              </label>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
