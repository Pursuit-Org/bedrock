import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type NotificationType =
  | "project_task_assigned"
  | "comment_mention"
  | "sf_task_assigned"
  | "sf_opp_owner_changed"
  | "intro_request"
  | "intro_response"
  | "account_owner_changed"
  | "contact_owner_changed"
  | "account_comment_added"
  | "contact_comment_added"
  | "account_file_uploaded"
  | "account_task_assigned"
  | "contact_task_assigned";

export type SlackDeliveryStatus =
  | "pending"
  | "sent"
  | "skipped"
  | "failed"
  | "disabled";

export interface NotificationPayload {
  title?: string | null;
  subtitle?: string | null;
  target_url?: string | null;
  /** Source identifiers for routing — see backend services/notifications.py. */
  project_id?: string | null;
  project_name?: string | null;
  workstream_name?: string | null;
  milestone_title?: string | null;
  task_id?: string | null;
  task_title?: string | null;
  /** For comment_mention: full body (already trimmed to 280 chars). */
  comment_body?: string | null;
  /** Resolved display name of the user that triggered the notification. */
  actor_display_name?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  comment_id?: string | null;
  sf_task_id?: string | null;
  opp_id?: string | null;

  // Intro request fields (intro_request / intro_response).
  contact_name?: string | null;
  contact_company?: string | null;
  ask?: string | null;
  context?: string | null;
  status?: string | null;
  response_note?: string | null;

  // SF Task fields surfaced by the poller.
  what_name?: string | null;
  activity_date?: string | null;

  // SF Opp owner-change fields.
  /** "gained" = recipient is the new owner; "lost" = recipient was the prior owner. */
  role?: "gained" | "lost" | string | null;
  opp_name?: string | null;
  new_owner_name?: string | null;

  // Account/Contact owner-change + owner-activity fields.
  account_name?: string | null;
  file_name?: string | null;
  assignee_name?: string | null;
}

export interface BedrockNotification {
  id: string;
  type: NotificationType;
  payload: NotificationPayload;
  actor_email: string | null;
  read_at: string | null;
  slack_status: SlackDeliveryStatus;
  created_at: string | null;
}

interface ListResponse {
  success: boolean;
  data: BedrockNotification[];
}

interface CountResponse {
  success: boolean;
  data: { count: number };
}

/** Recent notifications for the current user, newest first.
 *  Polls every 30s — light enough on a single-user GET and snappy
 *  enough that newly-assigned tasks appear on the bell without a
 *  manual reload. */
export function useNotifications(opts: { unreadOnly?: boolean } = {}) {
  return useQuery({
    queryKey: ["notifications", opts.unreadOnly ?? false],
    queryFn: async () => {
      const qs = opts.unreadOnly ? "?unread_only=true" : "";
      const { data } = await api.get<ListResponse>(`/api/notifications${qs}`);
      return data.data ?? [];
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** Tiny query for the bell badge. Separate from the full list so we
 *  can poll it more aggressively without redrawing the dropdown. */
export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: async () => {
      const { data } = await api.get<CountResponse>(
        "/api/notifications/unread-count",
      );
      return data.data.count;
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** Optimistic mark-read: flips the row's read_at in the local cache + drops the
 *  unread badge count BEFORE the server request resolves, so the UI feels
 *  instantaneous. Rolls back if the request errors. */
export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/api/notifications/${id}/read`);
    },
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: ["notifications"] });
      const nowIso = new Date().toISOString();
      const prevList = qc.getQueryData<BedrockNotification[]>(["notifications", false]);
      const prevUnread = qc.getQueryData<BedrockNotification[]>(["notifications", true]);
      const prevCount = qc.getQueryData<number>(["notifications", "unread-count"]);
      // Patch every cached list flavor (unread-only + all).
      for (const key of [["notifications", false], ["notifications", true]] as const) {
        qc.setQueryData<BedrockNotification[]>(key, (rows) =>
          (rows ?? []).map((r) => (r.id === id && !r.read_at ? { ...r, read_at: nowIso } : r)),
        );
      }
      qc.setQueryData<number>(["notifications", "unread-count"], (c) =>
        typeof c === "number" ? Math.max(0, c - 1) : c,
      );
      return { prevList, prevUnread, prevCount };
    },
    onError: (_err, _id, ctx) => {
      // Roll back on failure so the row doesn't look read when it isn't.
      if (!ctx) return;
      if (ctx.prevList !== undefined) qc.setQueryData(["notifications", false], ctx.prevList);
      if (ctx.prevUnread !== undefined) qc.setQueryData(["notifications", true], ctx.prevUnread);
      if (ctx.prevCount !== undefined) qc.setQueryData(["notifications", "unread-count"], ctx.prevCount);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

/** Mark-all-read clears the bell: rows that were unread at the time of
 *  the click are removed from the cached lists entirely (not just
 *  dimmed), so the dropdown visibly empties out. The rows still exist
 *  server-side (read_at is set, not deleted) and remain visible on the
 *  full history page. */
export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.post("/api/notifications/read-all");
    },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["notifications"] });
      const prevList = qc.getQueryData<BedrockNotification[]>(["notifications", false]);
      const prevUnread = qc.getQueryData<BedrockNotification[]>(["notifications", true]);
      const prevCount = qc.getQueryData<number>(["notifications", "unread-count"]);
      for (const key of [["notifications", false], ["notifications", true]] as const) {
        qc.setQueryData<BedrockNotification[]>(key, (rows) =>
          (rows ?? []).filter((r) => !!r.read_at),
        );
      }
      qc.setQueryData<number>(["notifications", "unread-count"], 0);
      return { prevList, prevUnread, prevCount };
    },
    onError: (_err, _v, ctx) => {
      if (!ctx) return;
      if (ctx.prevList !== undefined) qc.setQueryData(["notifications", false], ctx.prevList);
      if (ctx.prevUnread !== undefined) qc.setQueryData(["notifications", true], ctx.prevUnread);
      if (ctx.prevCount !== undefined) qc.setQueryData(["notifications", "unread-count"], ctx.prevCount);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

/** Full history (up to the backend's 200-row cap, bounded further by the
 *  2-week retention window), used by the notification history page —
 *  distinct query key from the bell's ["notifications", false] so the
 *  bell's mark-all-read clearing doesn't affect this list. */
export function useNotificationHistory() {
  return useQuery({
    queryKey: ["notifications", "history"],
    queryFn: async () => {
      const { data } = await api.get<ListResponse>("/api/notifications?limit=200");
      return data.data ?? [];
    },
    staleTime: 15_000,
  });
}

export interface NotificationPreferences {
  slack_enabled: boolean;
  account_activity_enabled: boolean;
  contact_activity_enabled: boolean;
  opportunity_activity_enabled: boolean;
}

interface PreferencesResponse {
  success: boolean;
  data: NotificationPreferences;
}

/** Per-user delivery/activity preferences (Settings → Notifications tab).
 *  In-app (bell) delivery is always on and isn't represented here. */
export function useNotificationPreferences() {
  return useQuery({
    queryKey: ["notifications", "preferences"],
    queryFn: async () => {
      const { data } = await api.get<PreferencesResponse>("/api/notifications/preferences");
      return data.data;
    },
    staleTime: 30_000,
  });
}

export function useUpdateNotificationPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (prefs: NotificationPreferences) => {
      const { data } = await api.put<PreferencesResponse>(
        "/api/notifications/preferences",
        prefs,
      );
      return data.data;
    },
    onSuccess: (data) => {
      qc.setQueryData(["notifications", "preferences"], data);
    },
  });
}
