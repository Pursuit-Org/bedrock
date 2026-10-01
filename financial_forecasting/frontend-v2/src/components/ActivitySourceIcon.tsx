import { CheckSquare, Handshake, Phone, Sparkles, StickyNote } from "lucide-react";

import { Tag } from "@/components/ui/Tag";

/**
 * Icon for an activity row, picked from `source` (preferred — explicit
 * provenance like "gmail" / "slack" / "fireflies") falling back to `type`
 * (generic categories: "email" / "meeting" / "call" / "note" / "task").
 *
 * Brand glyphs (Gmail, Google Calendar, Slack, Salesforce) are inline
 * SVG so we don't pull in an icon library — paths cribbed from
 * Simple Icons (CC0). Renders at brand color so the timeline reads
 * at a glance: red blob = email, blue calendar = meeting, etc.
 *
 * Resolution order:
 *   1. Explicit source (e.g. "gmail" → Gmail) wins
 *   2. Activity type (e.g. "meeting" → Google Calendar)
 *   3. Fallback chip with the raw type label
 */
export function ActivitySourceIcon({
  source,
  type,
  size = 16,
}: {
  source?: string | null;
  type?: string | null;
  size?: number;
}) {
  const s = (source || "").toLowerCase();
  const t = (type || "").toLowerCase();

  // Source-specific overrides (most explicit first)
  if (s.includes("fireflies") || t === "transcript") {
    return <Sparkles size={size} className="text-amber-600" aria-label="Fireflies" />;
  }
  if (s.includes("slack") || t === "message") {
    return <SlackIcon size={size} />;
  }

  // Generic types — these usually map cleanly to a known brand
  if (t === "email" || s.includes("gmail")) {
    return <GmailIcon size={size} />;
  }
  if (t === "meeting" || t === "calendar-event" || t === "calendar" || t === "event") {
    return <GoogleCalendarIcon size={size} />;
  }
  if (t === "call" || t === "phone") {
    return <Phone size={size} className="text-ink-3" aria-label="Call" />;
  }
  if (t === "task") {
    return <CheckSquare size={size} className="text-ink-3" aria-label="Task" />;
  }
  // A facilitated intro is not a bedrock.activity row at all — it comes from
  // bedrock.intro_request, folded into the contact timeline so the touch the
  // Outreach scorecard counts is visible where the touches are.
  if (t === "intro") {
    return <Handshake size={size} className="text-accent" aria-label="Facilitated intro" />;
  }
  if (t === "note") {
    return <StickyNote size={size} className="text-ink-3" aria-label="Note" />;
  }

  // Salesforce-sourced fallback for anything else
  if (s === "salesforce") {
    return <SalesforceIcon size={size} />;
  }

  return <Tag>{type ?? "activity"}</Tag>;
}

/* ────────────────────────────────────────────────────────────────────
 * Brand SVGs — Simple Icons paths, full color.
 * ──────────────────────────────────────────────────────────────────── */

function GmailIcon({ size }: { size: number }) {
  // Verbatim from Wikipedia's Gmail_icon_(2020).svg — viewBox 52 42 88 66.
  // Five color zones layered to form the iconic "M" with rounded peaks.
  return (
    <svg
      width={size}
      height={Math.round((size * 66) / 88)}
      viewBox="52 42 88 66"
      role="img"
      aria-label="Gmail"
      style={{ verticalAlign: "middle" }}
    >
      <title>Gmail</title>
      <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
      <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
      <path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
      <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
      <path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
    </svg>
  );
}

function GoogleCalendarIcon({ size }: { size: number }) {
  // Google Calendar 2020 mark — rounded-square frame with colored
  // edges (blue top + left, yellow right, green bottom, red diagonal
  // bottom-right tab) and a centered "31" in Google blue. Drawn in a
  // 76x76 viewBox so all the tile edges line up at small sizes.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 76 76"
      role="img"
      aria-label="Meeting"
      style={{ verticalAlign: "middle" }}
    >
      <title>Meeting</title>
      {/* Background frame in light blue, top-rounded corners */}
      <path fill="#4285f4" d="M58 0H6C2.685 0 0 2.685 0 6v52h18V18h40z" />
      {/* Blue top-right corner tab */}
      <path fill="#1967d2" d="M76 18V6c0-3.315-2.685-6-6-6H58v18z" />
      {/* Yellow right strip */}
      <path fill="#fbbc04" d="M76 18H58v40h18z" />
      {/* Green bottom strip */}
      <path fill="#34a853" d="M58 58H18v18h40z" />
      {/* Dark green bottom-left corner */}
      <path fill="#188038" d="M0 58v12c0 3.315 2.685 6 6 6h12V58z" />
      {/* Red diagonal bottom-right corner tab */}
      <path fill="#ea4335" d="M58 76l18-18H58z" />
      {/* White center page */}
      <path fill="#fff" d="M58 18H18v40h40z" />
      {/* "31" letterforms (3 + 1) — single path, Google blue */}
      <path
        fill="#4285f4"
        d="M26.205 49.03c-1.495-1.01-2.53-2.485-3.095-4.435l3.47-1.43c.315 1.2.865 2.13 1.65 2.79.78.66 1.73.985 2.84.985 1.135 0 2.11-.345 2.925-1.035s1.225-1.57 1.225-2.635c0-1.09-.43-1.98-1.29-2.67-.86-.69-1.94-1.035-3.23-1.035h-2.005V36.13h1.8c1.11 0 2.045-.3 2.805-.9.76-.6 1.14-1.42 1.14-2.465 0-.93-.34-1.67-1.02-2.225-.68-.555-1.54-.835-2.585-.835-1.02 0-1.83.27-2.43.815a4.784 4.784 0 00-1.31 2.005l-3.435-1.43c.455-1.29 1.29-2.43 2.515-3.415 1.225-.985 2.79-1.48 4.69-1.48 1.405 0 2.67.27 3.79.815 1.12.545 2 1.3 2.635 2.26.635.965.95 2.045.95 3.245 0 1.225-.295 2.26-.885 3.11-.59.85-1.315 1.5-2.175 1.955v.205a6.605 6.605 0 012.79 2.175c.725.975 1.09 2.14 1.09 3.5 0 1.36-.345 2.575-1.035 3.64S36.38 49.01 35.17 49.62c-1.215.61-2.58.92-4.095.92-1.755.005-3.375-.5-4.87-1.51zM47.52 31.81l-3.81 2.755-1.905-2.89 6.835-4.93h2.62V50h-3.74z"
      />
    </svg>
  );
}

function SlackIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Slack"
    >
      <title>Slack</title>
      <path
        fill="#E01E5A"
        d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
      />
      <path
        fill="#36C5F0"
        d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
      />
      <path
        fill="#2EB67D"
        d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"
      />
      <path
        fill="#ECB22E"
        d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
      />
    </svg>
  );
}

function SalesforceIcon({ size }: { size: number }) {
  // Cloud-shape blob in Salesforce blue. Source: Simple Icons.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Salesforce"
    >
      <title>Salesforce</title>
      <path
        fill="#00A1E0"
        d="M9.998 5.688a4.118 4.118 0 0 1 3.21-1.547 4.142 4.142 0 0 1 3.626 2.108 5.013 5.013 0 0 1 2.05-.434c2.785 0 5.045 2.282 5.045 5.097 0 2.815-2.26 5.097-5.045 5.097-.34 0-.672-.034-.994-.099a3.692 3.692 0 0 1-3.225 1.886c-.561 0-1.092-.124-1.567-.346A4.224 4.224 0 0 1 9.18 19.85a4.211 4.211 0 0 1-3.916-2.604 3.851 3.851 0 0 1-1.6.346C1.638 17.59 0 15.929 0 13.86c0-1.4.752-2.622 1.872-3.275a4.296 4.296 0 0 1-.36-1.722c0-2.392 1.946-4.32 4.34-4.32a4.34 4.34 0 0 1 3.428 1.677c.215.243.456.7.718 1.468Z"
      />
    </svg>
  );
}
