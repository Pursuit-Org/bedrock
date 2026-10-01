import { InlineMultiSelect, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import {
  BUILDER_RATING_OPTIONS,
  BUILDER_RATING_FIELDS,
  BUILDER_FUNCTION_OPTIONS,
  BUILDER_INDUSTRY_OPTIONS,
  BUILDER_MODE_OPTIONS,
  BUILDER_DEGREE_OPTIONS,
  type BuilderProfileFields,
} from "@/services/jobs";

/** One editor per job-profile field, shared by the Builders table cells and
 *  the builder drawer so both offer the same fixed option lists. */
export type BuilderRatingKey = (typeof BUILDER_RATING_FIELDS)[number][0];
export type BuilderListKey = "target_functions" | "target_industries" | "preferred_modes" | "languages" | "certifications";
export type BuilderTriKey = "applying_regularly" | "networking_regularly";
export type BuilderEditableField =
  | BuilderRatingKey | BuilderListKey | BuilderTriKey
  | "degree" | "university" | "graduation_year" | "geo_preference";

export const isBuilderRating = (k: string): k is BuilderRatingKey => BUILDER_RATING_FIELDS.some(([r]) => r === k);

export const triValue = (v: boolean | null | undefined) => (v == null ? "" : v ? "yes" : "no");

export const YES_NO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

const opts = (vs: readonly string[]) => vs.map((v) => ({ value: v, label: v }));

// "clear" is a sentinel option so a nullable dropdown can be emptied again —
// InlineSelect's own empty option is a disabled placeholder.
const CLEAR = "__clear";
const withClear = (o: { value: string; label: string }[]) => [...o, { value: CLEAR, label: "— clear" }];
const RATING_SELECT = withClear(opts(BUILDER_RATING_OPTIONS));
const DEGREE_SELECT = withClear(opts(BUILDER_DEGREE_OPTIONS));
const TRI_SELECT = withClear(YES_NO);

const LIST_OPTIONS: Partial<Record<BuilderListKey, string[]>> = {
  target_functions: BUILDER_FUNCTION_OPTIONS,
  target_industries: BUILDER_INDUSTRY_OPTIONS,
  preferred_modes: BUILDER_MODE_OPTIONS,
};

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function BuilderFieldEditor({ field, values: p, onSave, className }: {
  field: BuilderEditableField;
  values: BuilderProfileFields;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  className?: string;
}) {
  const put = (k: string, v: unknown) => onSave({ [k]: v });

  if (isBuilderRating(field) || field === "degree") {
    return (
      <InlineSelect
        value={p[field]}
        options={field === "degree" ? DEGREE_SELECT : RATING_SELECT}
        onSave={(v) => put(field, v === CLEAR ? null : v)}
        className={className}
      />
    );
  }
  if (field === "applying_regularly" || field === "networking_regularly") {
    return (
      <InlineSelect
        value={triValue(p[field]) || null}
        options={TRI_SELECT}
        onSave={(v) => put(field, v === CLEAR ? null : v === "yes")}
        className={className}
      />
    );
  }
  if (field === "target_functions" || field === "target_industries" || field === "preferred_modes") {
    return (
      <InlineMultiSelect
        value={p[field]}
        options={LIST_OPTIONS[field]!}
        onSave={(v) => put(field, v)}
        className={className ?? "min-w-[170px]"}
      />
    );
  }
  if (field === "languages" || field === "certifications") {
    return (
      <InlineText
        value={(p[field] ?? []).join(", ")}
        placeholder="comma-separated"
        onSave={(v) => put(field, splitList(v))}
        className={className}
      />
    );
  }
  if (field === "geo_preference") {
    // Lives in intake (the intake form's geo answer); PATCH merges intake.
    return (
      <div className={className ?? "max-w-[240px]"} title={p.geo_preference ?? undefined}>
        <InlineText value={p.geo_preference} placeholder="e.g. NYC, remote" onSave={(v) => put("intake", { geo_preference: v.trim() || null })} />
      </div>
    );
  }
  if (field === "university") {
    return <InlineText value={p.university} onSave={(v) => put(field, v.trim() || null)} className={className} />;
  }
  // graduation_year
  return (
    <InlineText
      value={p.graduation_year != null ? String(p.graduation_year) : ""}
      onSave={(v) => {
        const t = v.trim();
        if (t && !/^\d{4}$/.test(t)) throw new Error("Enter a 4-digit year");
        return put(field, t ? Number(t) : null);
      }}
      className={className}
    />
  );
}
