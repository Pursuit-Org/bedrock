/**
 * Log a touch against an opportunity: the Pipeline drawer and the opportunity
 * detail page share this one form.
 *
 * Same five types as logging at a contact or an account (Kwame 2026-09-24):
 * call, email, text, LinkedIn, and facilitated intro. Email was missing here, so
 * a send the Gmail sync missed could be logged at the contact but not the deal.
 *
 * A facilitated intro is not a bedrock.activity row — activity.type has no
 * 'intro' — and bedrock.intro_request is keyed on a contact with no deal
 * variant. So an intro logged here names one of the deal's linked contacts and
 * posts to the intro endpoint, exactly as the account form does. The deal's
 * own feed then shows it, because the opportunity endpoint folds in intros for
 * its linked contacts.
 */
import { useState } from "react";
import { Plus } from "lucide-react";

import { CallKindPicker } from "@/components/jobs/CallKindPicker";
import { cn } from "@/lib/utils";
import { useLogActivity, type CallKind, type JobContact } from "@/services/jobs";
import { INTRO_ASKS, useIntroConnectors, useLogFacilitatedIntro } from "@/services/jobsAccounts";

const TYPES = [
  { value: "call",     label: "Call" },
  { value: "email",    label: "Email" },
  { value: "text",     label: "Text" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "intro",    label: "Facilitated Intro" },
] as const;
type LogType = (typeof TYPES)[number]["value"];

const fieldCls = "w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40";
const labelCls = "mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-4";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function OppLogActivityForm({ dealId, contacts, className }: {
  dealId: string;
  /** The deal's linked contacts — who an intro can name. */
  contacts: JobContact[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<LogType>("call");
  const [date, setDate] = useState(todayIso);
  const [desc, setDesc] = useState("");
  const [callKind, setCallKind] = useState<CallKind | null>(null);
  const [introContact, setIntroContact] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [ask, setAsk] = useState("hiring_intro");

  const logActivity = useLogActivity();
  const { mutateAsync: logIntro, isPending: introPending } = useLogFacilitatedIntro();
  const { data: connectors = [] } = useIntroConnectors();

  const isIntro = type === "intro";
  // The note is optional on every type (Kwame 2026-09-24): "I texted her on
  // the 14th" is a complete record, and demanding prose to log it loses touches.
  const canSubmit = isIntro ? !!introContact && !!connectorId : true;
  const pending = logActivity.isPending || introPending;

  function reset() {
    setType("call");
    setDate(todayIso());
    setDesc("");
    setCallKind(null);
    setIntroContact("");
    setConnectorId("");
    setOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    if (isIntro) {
      await logIntro({
        contact_id: Number(introContact),
        connector_staff_id: Number(connectorId),
        specific_ask: ask || null,
        context: desc.trim() || null,
        occurred_on: date || undefined,
      });
    } else {
      await logActivity.mutateAsync({
        jobs_opportunity_id: dealId,
        type,
        description: desc.trim() || undefined,
        activity_date: date || todayIso(),
        // Only a call carries a kind; the API drops it on anything else, but
        // not sending it keeps the request honest about what was asked.
        call_kind: type === "call" ? callKind : null,
      });
    }
    reset();
  }

  // The "+ Log" button matches the Accounts activity tab (Kwame 2026-09-24),
  // so logging a touch looks the same wherever you do it. It sits beside the
  // label rather than at the far right: in the Pipeline drawer the row spans
  // the whole deal table, which is wider than a laptop screen, and a
  // right-aligned button landed off-screen.
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Activity</span>
        <button type="button" onClick={() => (open ? reset() : setOpen(true))}
          className="flex items-center gap-1 rounded border border-border-strong px-2 py-0.5 text-[11px] text-ink-3 hover:border-accent hover:text-accent">
          <Plus size={11} /> Log
        </button>
      </div>
      {open && (
    <form onSubmit={(e) => void handleSubmit(e)}
      className="mx-3 mb-2 flex flex-col gap-2 rounded-md border border-dashed border-border-strong bg-surface-2/40 px-3 py-2">
      <div className="flex flex-wrap gap-1">
        {TYPES.map((t) => (
          <button key={t.value} type="button" onClick={() => setType(t.value)}
            className={cn(
              "rounded border px-2 py-0.5 text-[11px] font-medium transition-colors",
              type === t.value
                ? "border-accent bg-accent/5 text-accent"
                : "border-border-strong bg-surface text-ink-3 hover:text-ink-2",
            )}>
            {t.label}
          </button>
        ))}
      </div>

      {type === "call" && <CallKindPicker value={callKind} onChange={setCallKind} />}

      {isIntro && (
        contacts.length === 0 ? (
          <p className="text-[11.5px] text-ink-3">
            An intro is logged against a person. Link a contact to this deal in the Contacts tab first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[170px] flex-1">
              <label className={labelCls}>Who was introduced</label>
              <select value={introContact} onChange={(e) => setIntroContact(e.target.value)} className={fieldCls}>
                <option value="">Select a contact…</option>
                {contacts.map((c) => (
                  <option key={c.contact_id} value={c.contact_id}>{c.full_name || c.email || `Contact ${c.contact_id}`}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[170px] flex-1">
              <label className={labelCls}>Introduced by</label>
              <select value={connectorId} onChange={(e) => setConnectorId(e.target.value)}
                title="Who made the intro. Credit for it goes to you, the person logging it."
                className={fieldCls}>
                <option value="">Select a colleague…</option>
                {connectors.map((c) => (
                  <option key={c.staff_user_id} value={c.staff_user_id}>{c.display_name || c.email}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[140px] flex-1">
              <label className={labelCls}>Ask</label>
              <select value={ask} onChange={(e) => setAsk(e.target.value)} className={fieldCls}>
                {INTRO_ASKS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
          </div>
        )
      )}

      <input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} className={fieldCls} />

      <textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)}
        placeholder={isIntro ? "Context (optional)" : "What happened? (optional)"}
        className={cn(fieldCls, "resize-none")} />

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending || !canSubmit}
          className="rounded bg-accent px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50">
          {pending ? "Logging…" : "Log"}
        </button>
        <button type="button" onClick={reset} className="text-[12px] text-ink-3 hover:text-ink-2">Cancel</button>
      </div>
    </form>
      )}
    </div>
  );
}
