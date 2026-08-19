/**
 * Revisit date picker.
 *
 * Revisit replaces On Hold, and the whole reason it does is the date: On Hold
 * had no mechanism, so "park this and come back" quietly meant "forget this".
 * Saving here stores the date on the membership AND files a `bedrock.jobs_task`
 * for the contact's owner, which the Jobs Home Overdue/Today/Upcoming widget
 * already renders — so the reminder shows up on the day with no new surface.
 */
import { useState } from "react";
import { CalendarClock } from "lucide-react";

/** Local YYYY-MM-DD. toISOString() would shift the day for anyone west of UTC,
 *  which on a date-only field means the reminder lands a day early. */
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const addMonths = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() + n); return iso(d); };

/** First day of the quarter after the one we're in. */
const nextQuarter = () => {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) + 1;       // 1-4; 4 rolls into next year
  return iso(new Date(d.getFullYear(), q * 3, 1));
};

// "Next quarter" used to be addMonths(3) — the same date as "In 3 months", so
// the two buttons produced identical values and, because the active state is a
// value comparison, clicking either lit up both. It now means the calendar
// quarter, which is what anyone picking it expects.
const PRESETS: { label: string; get: () => string }[] = [
  { label: "In 2 weeks", get: () => addDays(14) },
  { label: "In 1 month", get: () => addMonths(1) },
  { label: "In 3 months", get: () => addMonths(3) },
  { label: "Next quarter", get: nextQuarter },
];

export function RevisitDialog({ contactName, onCancel, onSave }: {
  contactName: string;
  onCancel: () => void;
  onSave: (date: string) => void;
}) {
  const [value, setValue] = useState(addMonths(1));
  const today = iso(new Date());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onCancel}>
      <div className="w-full max-w-[380px] rounded-xl border border-border-strong bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <CalendarClock size={15} className="text-accent" />
          <h2 className="text-[14px] font-semibold text-ink">Revisit {contactName}</h2>
        </div>
        <p className="mt-1 text-[12px] text-ink-3">
          We'll put this on the owner's task list for that day.
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => {
            const v = p.get();
            return (
              <button key={p.label} type="button" onClick={() => setValue(v)}
                className={`rounded-md border px-2 py-1 text-[12px] font-medium transition-colors ${
                  value === v
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border-strong bg-surface text-ink-2 hover:bg-surface-2"}`}>
                {p.label}
              </button>
            );
          })}
        </div>

        <label className="mt-3 block">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Or pick a date</span>
          <input type="date" value={value} min={today}
            onChange={(e) => { if (e.target.value) setValue(e.target.value); }}
            className="mt-1 h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px] text-ink outline-none focus:border-accent" />
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel}
            className="h-8 rounded-md border border-border-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2">
            Cancel
          </button>
          <button type="button" onClick={() => onSave(value)}
            className="h-8 rounded-md bg-accent px-3 text-[12.5px] font-semibold text-white hover:opacity-90">
            Set revisit
          </button>
        </div>
      </div>
    </div>
  );
}
