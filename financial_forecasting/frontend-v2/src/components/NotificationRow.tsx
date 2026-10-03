import { useMemo } from "react";

import { cn } from "@/lib/utils";
import type { BedrockNotification, NotificationType } from "@/services/notifications";

/** Shared row renderer for the notification bell dropdown and the full
 *  history page — headline + structured detail rows mirror the Slack
 *  message layout (see backend services/notifications.py::_format_slack_message). */
export function NotificationRow({
  n,
  onClick,
}: {
  n: BedrockNotification;
  onClick: () => void;
}) {
  const isUnread = !n.read_at;
  const icon = typeIcon(n.type);
  const time = useRelativeTime(n.created_at);
  const p = n.payload ?? {};
  const actor = p.actor_display_name || n.actor_email || "Someone";

  let headline = "";
  let details: { label: string; value: string; bold?: boolean }[] = [];
  if (n.type === "project_task_assigned") {
    headline = `${actor} assigned you a task`;
    if (p.project_name) details.push({ label: "Project", value: p.project_name });
    if (p.workstream_name) details.push({ label: "Workstream", value: p.workstream_name });
    if (p.milestone_title) details.push({ label: "Milestone", value: p.milestone_title });
    if (p.task_title || p.subtitle) {
      details.push({ label: "Task", value: p.task_title || p.subtitle || "", bold: true });
    }
  } else if (n.type === "comment_mention") {
    headline = `${actor} mentioned you in a comment`;
    if (p.project_name) details.push({ label: "Project", value: p.project_name });
    if (p.task_title) details.push({ label: "Task", value: p.task_title });
    const body = p.comment_body || p.subtitle || "";
    if (body) details.push({ label: "Comment", value: body, bold: true });
  } else if (n.type === "sf_task_assigned") {
    headline = `${actor} assigned you a Salesforce task`;
    if (p.what_name) details.push({ label: "Related", value: p.what_name });
    if (p.activity_date) details.push({ label: "Due", value: p.activity_date });
    const task = p.task_title || p.subtitle || "";
    if (task) details.push({ label: "Task", value: task, bold: true });
  } else if (n.type === "sf_opp_owner_changed") {
    const role = p.role;
    const oppName = p.opp_name || p.subtitle || "";
    if (role === "gained") {
      headline = `${actor} made you the owner`;
      if (oppName) details.push({ label: "Opportunity", value: oppName, bold: true });
    } else if (role === "lost") {
      headline = `${actor} reassigned an opportunity`;
      if (oppName) details.push({ label: "Opportunity", value: oppName });
      if (p.new_owner_name) details.push({ label: "Now owned by", value: p.new_owner_name });
    } else {
      headline = "Opportunity ownership changed";
      if (oppName) details.push({ label: "", value: oppName });
    }
  } else if (n.type === "account_owner_changed" || n.type === "contact_owner_changed") {
    const noun = n.type === "account_owner_changed" ? "account" : "contact";
    const nounLabel = noun === "account" ? "Account" : "Contact";
    const role = p.role;
    const name = p.account_name || p.contact_name || p.subtitle || "";
    if (role === "gained") {
      headline = `${actor} made you the owner`;
      if (name) details.push({ label: nounLabel, value: name, bold: true });
    } else if (role === "lost") {
      headline = `${actor} reassigned an ${noun}`;
      if (name) details.push({ label: nounLabel, value: name });
      if (p.new_owner_name) details.push({ label: "Now owned by", value: p.new_owner_name });
    } else {
      headline = `${nounLabel} ownership changed`;
      if (name) details.push({ label: "", value: name });
    }
  } else if (n.type === "account_comment_added" || n.type === "contact_comment_added") {
    const noun = n.type === "account_comment_added" ? "account" : "contact";
    const name = p.account_name || p.contact_name || "";
    headline = `${actor} commented on an ${noun} you own`;
    if (name) details.push({ label: noun === "account" ? "Account" : "Contact", value: name, bold: true });
    const body = p.comment_body || p.subtitle || "";
    if (body) details.push({ label: "Comment", value: body });
  } else if (n.type === "account_file_uploaded") {
    headline = `${actor} uploaded a file to an account you own`;
    if (p.account_name) details.push({ label: "Account", value: p.account_name, bold: true });
    if (p.file_name) details.push({ label: "File", value: p.file_name });
  } else if (n.type === "account_task_assigned" || n.type === "contact_task_assigned") {
    const noun = n.type === "account_task_assigned" ? "account" : "contact";
    const name = p.account_name || p.contact_name || "";
    headline = `${actor} assigned a task on an ${noun} you own`;
    if (name) details.push({ label: noun === "account" ? "Account" : "Contact", value: name, bold: true });
    if (p.task_title || p.subtitle) details.push({ label: "Task", value: p.task_title || p.subtitle || "" });
    if (p.assignee_name) details.push({ label: "Assigned to", value: p.assignee_name });
  } else if (n.type === "intro_request") {
    headline = `${actor} asked you for an intro`;
    const who = [p.contact_name, p.contact_company ? `(${p.contact_company})` : ""].filter(Boolean).join(" ");
    if (who) details.push({ label: "Contact", value: who, bold: true });
    if (p.ask) details.push({ label: "Ask", value: p.ask });
    if (p.context) details.push({ label: "Context", value: p.context });
  } else if (n.type === "intro_response") {
    const verb = p.status === "accepted" ? "accepted" : p.status === "declined" ? "declined" : p.status === "completed" ? "made" : "updated";
    headline = verb === "made" ? `${actor} made the intro` : `${actor} ${verb} your intro request`;
    if (p.contact_name) details.push({ label: "Contact", value: p.contact_name, bold: true });
    if (p.response_note) details.push({ label: "Note", value: p.response_note });
  } else {
    headline = p.title || prettyType(n.type);
    if (p.subtitle) details.push({ label: "", value: p.subtitle });
  }

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2",
          isUnread && "bg-blue-50/60",
        )}
      >
        <span className="mt-0.5 select-none text-[14px]" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn(
              "truncate text-[12.5px]",
              isUnread ? "font-semibold text-ink" : "font-medium text-ink-2",
            )}>
              {headline}
            </span>
            {time ? (
              <span className="ml-auto flex-shrink-0 text-[10.5px] text-ink-3">{time}</span>
            ) : null}
          </div>
          {details.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5">
              {details.map((d, i) => (
                <li key={i} className="text-[11.5px] text-ink-3 line-clamp-2">
                  {d.label ? <span className="font-semibold text-ink-2">{d.label}:</span> : null}
                  {d.label ? " " : ""}
                  <span className={cn(d.bold && "font-semibold text-ink-2")}>{d.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {isUnread ? (
          <span
            className="mt-1.5 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent"
            aria-label="unread"
          />
        ) : null}
      </button>
    </li>
  );
}

/** Defensive URL resolution. Older notifications were enqueued before
 *  the backend started populating `target_url`; fall back to building
 *  a sensible deep-link from whatever IDs are on the payload. */
export function resolveTargetUrl(n: BedrockNotification): string | null {
  const p = n.payload ?? {};
  if (p.target_url) return p.target_url;
  const projectId = p.project_id ?? null;
  const taskId = p.task_id ?? p.entity_id ?? null;
  if (projectId && taskId) return `/projects/${projectId}?task=${taskId}`;
  if (projectId) return `/projects/${projectId}`;
  return null;
}

function typeIcon(t: NotificationType): string {
  switch (t) {
    case "project_task_assigned":
      return "📋";
    case "comment_mention":
      return "💬";
    case "sf_task_assigned":
      return "🔔";
    case "sf_opp_owner_changed":
      return "🤝";
    case "intro_request":
      return "👋";
    case "intro_response":
      return "🤝";
    case "account_owner_changed":
    case "contact_owner_changed":
      return "🤝";
    case "account_comment_added":
    case "contact_comment_added":
      return "💬";
    case "account_file_uploaded":
      return "📎";
    case "account_task_assigned":
    case "contact_task_assigned":
      return "🔔";
  }
}

function prettyType(t: NotificationType): string {
  switch (t) {
    case "project_task_assigned":
      return "Task assigned";
    case "comment_mention":
      return "Mention";
    case "sf_task_assigned":
      return "New Salesforce task";
    case "sf_opp_owner_changed":
      return "Opportunity owner change";
    case "intro_request":
      return "Intro request";
    case "intro_response":
      return "Intro request update";
    case "account_owner_changed":
      return "Account owner change";
    case "contact_owner_changed":
      return "Contact owner change";
    case "account_comment_added":
      return "Account comment";
    case "contact_comment_added":
      return "Contact comment";
    case "account_file_uploaded":
      return "Account file upload";
    case "account_task_assigned":
      return "Account task";
    case "contact_task_assigned":
      return "Contact task";
  }
}

/** Compact "5m" / "2h" / "Yesterday" relative-time label. */
export function useRelativeTime(iso: string | null): string {
  return useMemo(() => {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const diffSec = Math.max(0, (Date.now() - t) / 1000);
    if (diffSec < 45) return "just now";
    if (diffSec < 60 * 60) return `${Math.round(diffSec / 60)}m`;
    if (diffSec < 60 * 60 * 24) return `${Math.round(diffSec / 3600)}h`;
    if (diffSec < 60 * 60 * 24 * 2) return "Yesterday";
    if (diffSec < 60 * 60 * 24 * 7) return `${Math.floor(diffSec / 86400)}d`;
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }, [iso]);
}
