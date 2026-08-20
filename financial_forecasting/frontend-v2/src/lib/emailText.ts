/**
 * Text cleaning for activity rows (synced Gmail/Salesforce/Calendar + manual logs).
 *
 * Synced email fields (`email_body_text`, `email_snippet`) arrive as raw HTML
 * with encoded entities. Plain-text fields (Task/Event `description`, manual
 * notes) may legitimately contain angle brackets — "Sarah <sarah@x.org>",
 * "<placeholder>" — so only email fields get tag-stripped.
 */

/**
 * Decode common HTML entities. `&amp;` decodes LAST so an already-escaped
 * sequence like `&amp;lt;` becomes the literal text "&lt;" instead of
 * double-decoding to "<".
 */
export function decodeEntities(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&#(\d+);/g, (m, n: string) => {
      const cp = Number(n);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => {
      const cp = parseInt(n, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Clean an HTML email body/snippet for plain-text rendering: strip tags,
 * decode entities, normalize whitespace. Tags are stripped BEFORE decoding so
 * text-level angle brackets (`&lt;sarah@x.org&gt;` in the source) survive.
 */
export function cleanEmailText(raw: string | null | undefined): string {
  if (!raw) return "";
  return decodeEntities(raw.replace(/<[^>]+>/g, " "))
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Clean a plain-text note/description: decode entities and tidy blank lines,
 * but never strip angle-bracket text and keep the author's line formatting.
 */
export function cleanPlainText(raw: string | null | undefined): string {
  if (!raw) return "";
  return decodeEntities(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The subset of activity fields the body picker needs — satisfied by both
 * `BedrockActivity` (CRM) and `ActivityEntry` (jobs). */
export interface ActivityTextSource {
  type?: string | null;
  email_body_text?: string | null;
  email_snippet?: string | null;
  description?: string | null;
}

/**
 * Pick and clean the fullest body text for an activity row. Email fields are
 * HTML and get tag-stripped; a `description` fallback is tag-stripped only for
 * actual email rows (SF email tasks copy the HTML body into description) —
 * plain Task/Event/call notes pass through `cleanPlainText` untouched.
 */
export function activityBodyText(a: ActivityTextSource): string {
  const emailRaw = a.email_body_text || a.email_snippet;
  if (emailRaw) return cleanEmailText(emailRaw);
  if (!a.description) return "";
  return (a.type ?? "").toLowerCase() === "email"
    ? cleanEmailText(a.description)
    : cleanPlainText(a.description);
}
