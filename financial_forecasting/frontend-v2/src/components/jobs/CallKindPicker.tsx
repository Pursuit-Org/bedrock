import { useStageVocabulary, type CallKind } from "@/services/jobs";
import { cn } from "@/lib/utils";

/**
 * What kind of call this was — discovery or general.
 *
 * Asked at log time rather than inferred from the note later: the person who
 * just had the call is the only one who knows, and the Activity Pipeline's
 * Total Calls breakdown is only as good as this answer.
 *
 * Options and their availability come from /stage-vocabulary, the same probe the
 * stage pickers use. Until bedrock.activity.call_kind exists the buttons render
 * disabled with the reason on hover — visible and explained beats missing, and a
 * disabled button cannot produce a save the API would have to drop.
 */
export function CallKindPicker({ value, onChange, className }: {
  value: CallKind | null;
  onChange: (v: CallKind | null) => void;
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
        {!ready && (
          <span className="text-[10px] uppercase tracking-wide text-ink-4">pending migration</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {kinds.map((k) => {
          const selected = value === k.value;
          return (
            <button
              key={k.value}
              type="button"
              disabled={!k.available}
              title={k.available ? k.description ?? undefined : k.unavailable_reason ?? undefined}
              // Clicking the selected one clears it: a call type is a judgement,
              // and there has to be a way back to "I'd rather not say" without
              // reloading the form.
              onClick={() => onChange(selected ? null : k.value)}
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
