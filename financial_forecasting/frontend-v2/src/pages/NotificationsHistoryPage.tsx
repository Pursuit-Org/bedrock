import { useNavigate } from "react-router-dom";
import { MailCheck } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { NotificationRow, resolveTargetUrl } from "@/components/NotificationRow";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationHistory,
  type BedrockNotification,
} from "@/services/notifications";

/** Full chronological notification history (bounded by the backend's
 *  200-row cap and the 2-week retention window) — linked from the bell
 *  dropdown's "Notifications" header. Unlike the bell, mark-all-read
 *  here dims rows in place rather than clearing them, since this page's
 *  whole purpose is to keep read notifications visible. */
export function NotificationsHistoryPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useNotificationHistory();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const items = data ?? [];
  const unread = items.reduce((n, x) => n + (x.read_at ? 0 : 1), 0);

  function handleRowClick(n: BedrockNotification) {
    if (!n.read_at) markRead.mutate(n.id);
    const url = resolveTargetUrl(n);
    if (!url) return;
    if (/^https?:\/\//.test(url)) {
      window.location.href = url;
      return;
    }
    navigate(url);
  }

  return (
    <div className="mx-auto max-w-[720px] px-7 py-6 pb-20">
      <PageHeader
        title="Notifications"
        subtitle="Everything from the last 2 weeks, newest first"
        actions={
          <button
            type="button"
            onClick={() => unread > 0 && markAllRead.mutate()}
            disabled={markAllRead.isPending || unread === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <MailCheck size={13} aria-hidden /> Mark all read
          </button>
        }
      />

      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : items.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">
            You're all caught up.
          </div>
        ) : (
          <ul className="divide-y divide-border-strong">
            {items.map((n) => (
              <NotificationRow key={n.id} n={n} onClick={() => handleRowClick(n)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
