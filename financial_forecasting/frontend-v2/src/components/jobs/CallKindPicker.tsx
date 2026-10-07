import { useSetCallKind, useStageVocabulary, type CallKind } from "@/services/jobs";
import { cn } from "@/lib/utils";
import { localTodayIso, type CallDetails } from "@/components/jobs/callLog";

/**
 * What kind of call this was — discovery, or check-in / other.
 *
 * Asked at log time rather than inferred from the note later: the person who
 * just had the call is the only one who knows, and the Activity Pipeline's
 * Total Calls breakdown is only as good as this answer. Required when logging
 * (PRO-102): while it was optional, 2 of 176 calls carried one.
 *
 * Options and their availability come from /stage-vocabulary, the same probe the
 * stage pickers use. Until bedrock.activity.call_kind exists the buttons render
 * disabled with the reason on hover — visible and explained beats missing, and a
 * disabled button cannot produce a save the API would have to drop.
 */
export function CallKindPicker({ value, onChange, required = false, className }: {
  value: CallKind | null;
  onChange: (v: CallKind | null) => void;
  /** Required: no way back to "no type" once one is picked. */
  required?: boolean;
  className?: string;
}) {
  const { data: vocab } = useStageVocabulary();
  const kinds = vocab?.call_kinds ?? [];
  if (kinds.length === 0) return null;
  const ready = kinds.some((k) => k.available);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-4">Call type</span>
        {!ready ? (
          <span className="text-[10px] uppercase tracking-wide text-ink-4">pending migration</span>
        ) : required && !value ? (
          <span className="text-[10px] text-ink-4">required</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {kinds.map((k) => {
          const selected = value === k.value;
          return (
            <button
              key={k.value}
              type="button"
              disabled={!k.available}
              aria-pressed={selected}
              title={k.available ? k.description ?? undefined : k.unavailable_reason ?? undefined}
              // Clicking the selected one clears it where a type is optional: a
              // call type is a judgement, and there has to be a way back to "I'd
              // rather not say" without reloading the form.
              onClick={() => onChange(selected && !required ? null : k.value)}
              className={cn(
                "rounded border px-2 py-0.5 text-[11px] font-medium transition-colors",
                selected
                  ? "border-accent bg-accent/5 text-accent"
                  : "border-border-strong bg-surface text-ink-3 hover:text-ink-2",
                !k.available && "cursor-not-allowed opacity-50 hover:text-ink-3",
              )}
            >
              {k.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A call or meeting's type, changeable in place (PRO-102). A synced calendar
 * meeting has nobody to ask when it lands, so this is how a meeting with a
 * pipeline contact becomes a discovery call. An untyped one counts as
 * check-in / other, and says so. Clicks stay inside: it sits on rows that
 * expand when clicked.
 */
export function CallKindChip({ activityId, value, className }: {
  activityId: string;
  value: CallKind | null | undefined;
  className?: string;
}) {
  const { data: vocab } = useStageVocabulary();
  const set = useSetCallKind();
  const kinds = (vocab?.call_kinds ?? []).filter((k) => k.available);
  if (kinds.length === 0) return null;
  const current = value ?? "";
  return (
    <span className={cn("inline-flex shrink-0", className)}
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <select
        value={current}
        disabled={set.isPending}
        aria-label="Call type"
        title={current ? "Call type — change it here" : "No call type yet: counts as check-in / other"}
        onChange={(e) => set.mutate({ id: activityId, call_kind: (e.target.value || null) as CallKind | null })}
        className={cn(
          "rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide leading-none disabled:opacity-50",
          current === "discovery"
            ? "border-accent/40 bg-accent/10 text-accent"
            : current
              ? "border-border-strong bg-surface-2 text-ink-3"
              : "border-amber-300 bg-amber-50 text-amber-700",
        )}
      >
        <option value="">No type</option>
        {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
      </select>
    </span>
  );
}

/** Whether a call type can be stored yet (the 2026-09-21 migration). */
export function useCallTypesAvailable(): boolean {
  const { data: vocab } = useStageVocabulary();
  return !!vocab?.call_kinds?.some((k) => k.available);
}

const dateCls = "rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40";
const dateLabelCls = "mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-4";

/**
 * Everything a call asks for (PRO-102): its type, the day it was booked and the
 * day it was held. Calls booked counts a call on the day it was booked (Nick's
 * ask); held can be ahead of today for a call booked for later, and left empty
 * it is the day booked. Each log form shows this in place of its own date.
 */
export function CallDetailsFields({ value, onChange, className }: {
  value: CallDetails;
  onChange: (v: CallDetails) => void;
  className?: string;
}) {
  const today = localTodayIso();
  return (
    <div className={cn("flex flex-wrap items-end gap-3", className)}>
      <CallKindPicker required value={value.kind} onChange={(kind) => onChange({ ...value, kind })} />
      <div>
        <label className={dateLabelCls}>Booked on</label>
        <input type="date" required value={value.booked} max={today}
          onChange={(e) => onChange({ ...value, booked: e.target.value })} className={dateCls} />
      </div>
      <div>
        <label className={dateLabelCls} title="When the call happens or happened. Leave empty if it's the same day it was booked.">
          Held on <span className="font-normal normal-case tracking-normal">(optional)</span>
        </label>
        <input type="date" value={value.held} min={value.booked || undefined}
          onChange={(e) => onChange({ ...value, held: e.target.value })} className={dateCls} />
      </div>
    </div>
  );
}
