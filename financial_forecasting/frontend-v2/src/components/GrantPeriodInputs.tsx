import { grantPeriodError } from "@/lib/recordTypes";

/**
 * Optional grant start / end date pair for the New Opportunity modals.
 * Rendered only when the selected record type is Grant. Both optional at
 * creation; the pair is required later, before Collecting / In Effect
 * (see lib/stageGates.ts confirmGrantPeriod).
 */
export function GrantPeriodInputs({
  start,
  end,
  onChange,
  inputClassName,
  labelClassName,
}: {
  start: string;
  end: string;
  onChange: (next: { start: string; end: string }) => void;
  inputClassName: string;
  labelClassName: string;
}) {
  const error = grantPeriodError(start, end);
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className={labelClassName}>Grant start date</span>
          <input
            type="date"
            value={start}
            onChange={(e) => onChange({ start: e.target.value, end })}
            className={inputClassName}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClassName}>Grant end date</span>
          <input
            type="date"
            value={end}
            min={start || undefined}
            onChange={(e) => onChange({ start, end: e.target.value })}
            className={inputClassName}
          />
        </label>
      </div>
      {error ? <p className="text-[12px] text-red">{error}</p> : null}
    </div>
  );
}
