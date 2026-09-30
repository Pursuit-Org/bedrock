import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

import { apiErrorMessage } from "@/lib/estimatedJobs";
import { cn } from "@/lib/utils";
import { useJobsStaff } from "@/services/jobs";
import {
  useJobsTargets, useSaveJobsTeam, useSaveOutreachTargets, useSavePipelineTargets,
  type JobsTargets, type OutreachMetric, type TeamMode,
} from "@/services/jobsTargets";

/**
 * Settings > Targets > Jobs (Kwame 2026-09-29).
 *
 * Three sections, each saved on its own:
 *   Team      who counts as the Jobs team. Drives every team-scoped Jobs
 *             number, the Owner cut, and the rows of the grid below.
 *   Outreach  weekly targets per person, plus a team row per metric that is
 *             either the sum of the people or a number set directly (a team
 *             target while everyone individually carries 0).
 *   Pipeline  jobs target per quarter, drawn on the Jobs Projection chart.
 */
export function JobsTargetsTab({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, isError } = useJobsTargets();
  const staffQ = useJobsStaff();
  const nameOf = useMemo(() => {
    const m = new Map((staffQ.data ?? []).map((s) => [s.email.toLowerCase(), s.name]));
    return (e: string) => m.get(e) ?? e.split("@")[0];
  }, [staffQ.data]);

  if (isLoading) return <div className="flex justify-center py-10 text-ink-4"><Loader2 size={16} className="animate-spin" /></div>;
  if (isError || !data) return <div className="py-10 text-center text-[12.5px] text-ink-3">Couldn't load Jobs targets.</div>;

  const editable = canEdit && data.available;
  return (
    <div className="flex flex-col gap-5">
      {!data.available && (
        <div className="rounded-lg border border-[var(--amber)]/40 bg-[var(--amber-soft)] px-4 py-2.5 text-[12.5px] text-ink-2">
          <b>Pending migration.</b> These are today's built-in targets and team. Editing turns on once
          Jac runs <code className="text-[11.5px]">migrations/2026-09-29-jobs-targets.sql</code>.
        </div>
      )}
      {data.available && !canEdit && (
        <div className="rounded-lg border border-border-strong bg-surface-2 px-4 py-2.5 text-[12.5px] text-ink-3">
          Read-only: the <code className="text-[11.5px]">manage_jobs_targets</code> permission is needed to edit.
        </div>
      )}
      <TeamSection data={data} editable={editable} nameOf={nameOf} staff={staffQ.data ?? []} />
      <OutreachSection data={data} editable={editable} nameOf={nameOf} />
      <PipelineSection data={data} editable={editable} />
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────

function Section({ title, desc, children, footer }: {
  title: string; desc: string; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      <div className="border-b border-border-strong bg-surface-2 px-5 py-2.5">
        <div className="text-[13px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[12px] text-ink-3">{desc}</div>
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer && <div className="flex items-center justify-end gap-3 border-t border-border-strong px-5 py-2.5">{footer}</div>}
    </section>
  );
}

function SaveBar({ dirty, saving, error, onSave, onReset, editable }: {
  dirty: boolean; saving: boolean; error: string | null; onSave: () => void; onReset: () => void; editable: boolean;
}) {
  if (!editable) return null;
  return (
    <>
      {error && <span role="alert" className="mr-auto text-[12px] text-[var(--red)]">{error}</span>}
      {dirty && !saving && (
        <button type="button" onClick={onReset} className="text-[12.5px] text-ink-3 hover:text-ink">Discard</button>
      )}
      <button type="button" onClick={onSave} disabled={!dirty || saving}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40">
        {saving && <Loader2 size={12} className="animate-spin" />}Save
      </button>
    </>
  );
}

/** "" → null; a whole number 0–100000 → it; else undefined (invalid). */
function parseTarget(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^\d{1,6}$/.test(t)) return undefined;
  const n = Number(t);
  return n <= 100_000 ? n : undefined;
}

function NumInput({ value, onChange, disabled, invalid, label, className }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; invalid?: boolean; label: string; className?: string;
}) {
  return (
    <input type="text" inputMode="numeric" value={value} placeholder="—" aria-label={label} title={label}
      disabled={disabled} onChange={(e) => onChange(e.target.value)}
      className={cn("h-7 w-16 rounded border bg-surface px-1.5 text-right text-[12.5px] tabular-nums text-ink outline-none",
        "focus:border-accent disabled:border-transparent disabled:bg-transparent",
        invalid ? "border-[var(--red)]" : "border-border-strong", className)} />
  );
}

// ── Team ─────────────────────────────────────────────────────────────────────

function TeamSection({ data, editable, nameOf, staff }: {
  data: JobsTargets; editable: boolean; nameOf: (e: string) => string; staff: { email: string; name: string }[];
}) {
  const [members, setMembers] = useState<string[]>(data.team);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useSaveJobsTeam();
  useEffect(() => { setMembers(data.team); }, [data.team]);
  const dirty = members.join(",") !== data.team.join(",");
  const candidates = staff.filter((s) => !members.includes(s.email.toLowerCase()));

  const add = () => {
    const e = adding.trim().toLowerCase();
    if (!e) return;
    if (!/^[a-z0-9.+-]+@pursuit\.org$/.test(e)) { setError("Use a @pursuit.org address (letters, numbers, . + -)."); return; }
    if (!members.includes(e)) setMembers([...members, e]);
    setAdding(""); setError(null);
  };

  return (
    <Section title="Jobs team"
      desc="Who counts as the Jobs team: the 'Jobs Team' scope on every Jobs page, the Owner cut, and the rows below. Changing it moves team numbers everywhere."
      footer={<SaveBar editable={editable} dirty={dirty} saving={save.isPending} error={error}
        onReset={() => { setMembers(data.team); setError(null); }}
        onSave={() => save.mutate(members, { onError: (e) => setError(apiErrorMessage(e, "Couldn't save the team.")), onSuccess: () => setError(null) })} />}>
      <div className="flex flex-wrap items-center gap-2">
        {members.map((e) => (
          <span key={e} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border-strong bg-surface-2 pl-3 pr-1.5 text-[12.5px] text-ink">
            {nameOf(e)} <span className="text-[11px] text-ink-4">{e}</span>
            {editable && (
              <button type="button" aria-label={`Remove ${e}`} disabled={members.length <= 1}
                onClick={() => setMembers(members.filter((m) => m !== e))}
                className="grid h-5 w-5 place-items-center rounded-full text-ink-4 hover:bg-surface hover:text-[var(--red)] disabled:opacity-30"
                title={members.length <= 1 ? "The team needs at least one person" : "Remove from the team"}>
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        {editable && (
          <span className="inline-flex items-center gap-1">
            <input list="jobs-team-staff" value={adding} onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder="Add person (email)"
              aria-label="Add a team member by email"
              className="h-7 w-56 rounded border border-border-strong bg-surface px-2 text-[12.5px] outline-none focus:border-accent" />
            <datalist id="jobs-team-staff">
              {candidates.map((s) => <option key={s.email} value={s.email.toLowerCase()}>{s.name}</option>)}
            </datalist>
            <button type="button" onClick={add} className="inline-flex h-7 items-center gap-1 rounded border border-border-strong px-2 text-[12px] text-ink-2 hover:text-accent">
              <Plus size={12} />Add
            </button>
          </span>
        )}
      </div>
    </Section>
  );
}

// ── Outreach ─────────────────────────────────────────────────────────────────

type TeamDraft = { mode: TeamMode | "none"; value: string };

function initOutreach(data: JobsTargets) {
  const owners: Record<string, Record<string, string>> = {};
  for (const e of data.team) {
    owners[e] = {};
    for (const m of data.metrics) {
      const v = data.owners[e]?.[m.key];
      owners[e][m.key] = v == null ? "" : String(v);
    }
  }
  const team: Record<string, TeamDraft> = {};
  for (const m of data.metrics) {
    const t = data.team_targets[m.key];
    team[m.key] = { mode: t?.mode ?? "none", value: t?.mode === "set" && t.value != null ? String(t.value) : "" };
  }
  return { owners, team };
}

function OutreachSection({ data, editable, nameOf }: {
  data: JobsTargets; editable: boolean; nameOf: (e: string) => string;
}) {
  const [draft, setDraft] = useState(() => initOutreach(data));
  const [error, setError] = useState<string | null>(null);
  const save = useSaveOutreachTargets();
  const initial = useMemo(() => JSON.stringify(initOutreach(data)), [data]);
  // Re-sync from the server when it changes, without throwing away unsaved
  // edits: saving the Team section refetches this data, and that used to
  // wipe any cells typed here. With edits in progress, keep them and only
  // add rows for people who joined (and drop rows for people who left).
  const prevInitial = useRef(initial);
  useEffect(() => {
    if (initial === prevInitial.current) return;
    const fresh = JSON.parse(initial) as ReturnType<typeof initOutreach>;
    setDraft((d) => {
      if (JSON.stringify(d) === prevInitial.current) return fresh;
      const owners: typeof d.owners = {};
      for (const e of Object.keys(fresh.owners)) owners[e] = d.owners[e] ?? fresh.owners[e];
      return { owners, team: d.team };
    });
    prevInitial.current = initial;
  }, [initial]);
  const dirty = JSON.stringify(draft) !== initial;

  const invalid = (raw: string) => parseTarget(raw) === undefined;
  const anyInvalid = Object.values(draft.owners).some((r) => Object.values(r).some(invalid))
    || Object.values(draft.team).some((t) => t.mode === "set" && (t.value.trim() === "" || invalid(t.value)));

  const teamEffective = (m: OutreachMetric): number | null => {
    // Before the migration the live number comes from the built-in targets,
    // which still count Kwame's 10 outreach a week even though he isn't on
    // the team shown above; show what the app actually uses.
    if (!data.available) return data.team_targets[m]?.effective ?? null;
    const t = draft.team[m];
    if (t.mode === "none") return null;
    if (t.mode === "set") return parseTarget(t.value) ?? null;
    const vals = data.team.map((e) => parseTarget(draft.owners[e]?.[m] ?? "")).filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };

  const submit = () => {
    if (anyInvalid) { setError("Targets must be whole numbers; a set team total needs a number."); return; }
    const owners: Record<string, Partial<Record<OutreachMetric, number | null>>> = {};
    for (const [e, row] of Object.entries(draft.owners)) {
      owners[e] = {};
      for (const [m, raw] of Object.entries(row)) owners[e][m as OutreachMetric] = parseTarget(raw) ?? null;
    }
    const team: Partial<Record<OutreachMetric, { mode: TeamMode; value?: number | null }>> = {};
    for (const [m, t] of Object.entries(draft.team)) {
      if (t.mode === "none") continue;
      team[m as OutreachMetric] = t.mode === "set" ? { mode: "set", value: parseTarget(t.value) ?? null } : { mode: "sum" };
    }
    save.mutate({ owners, team }, {
      onError: (e) => setError(apiErrorMessage(e, "Couldn't save outreach targets.")),
      onSuccess: () => setError(null),
    });
  };

  return (
    <Section title="Outreach targets"
      desc="Weekly targets. Monthly views use four weeks of this; daily views use a fifth. Leave a cell blank for no target."
      footer={<SaveBar editable={editable} dirty={dirty} saving={save.isPending} error={error}
        onReset={() => { setDraft(JSON.parse(initial)); setError(null); }} onSave={submit} />}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[12.5px]">
          <thead>
            <tr className="text-[10.5px] uppercase tracking-wider text-ink-3">
              <th className="py-1.5 pr-3 text-left font-semibold">Owner</th>
              {data.metrics.map((m) => <th key={m.key} className="px-2 py-1.5 text-right font-semibold">{m.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.team.map((e) => (
              <tr key={e} className="border-t border-border">
                <td className="py-1.5 pr-3">
                  <div className="font-medium text-ink">{nameOf(e)}</div>
                  <div className="text-[11px] text-ink-4">{e}</div>
                </td>
                {data.metrics.map((m) => (
                  <td key={m.key} className="px-2 py-1.5 text-right">
                    <NumInput label={`${nameOf(e)} · ${m.label} per week`} disabled={!editable}
                      value={draft.owners[e]?.[m.key] ?? ""} invalid={invalid(draft.owners[e]?.[m.key] ?? "")}
                      onChange={(v) => setDraft((d) => ({ ...d, owners: { ...d.owners, [e]: { ...d.owners[e], [m.key]: v } } }))} />
                  </td>
                ))}
              </tr>
            ))}
            {/* Team row: sum of the people above, or its own number. */}
            <tr className="border-t-2 border-border-strong bg-surface-2/50 align-top">
              <td className="py-2 pr-3">
                <div className="font-semibold text-ink">Team total</div>
                <div className="text-[11px] text-ink-4">per metric: sum of owners, or set a number</div>
              </td>
              {data.metrics.map((m) => {
                const t = draft.team[m.key];
                const eff = teamEffective(m.key);
                return (
                  <td key={m.key} className="px-2 py-2 text-right">
                    <select value={t.mode} disabled={!editable} aria-label={`Team ${m.label}: how it's set`}
                      onChange={(ev) => setDraft((d) => ({ ...d, team: { ...d.team, [m.key]: { ...t, mode: ev.target.value as TeamDraft["mode"] } } }))}
                      className="mb-1 h-7 rounded border border-border-strong bg-surface px-1 text-[11.5px] text-ink-2 outline-none focus:border-accent disabled:border-transparent disabled:bg-transparent">
                      <option value="sum">Sum of owners</option>
                      <option value="set">Set total</option>
                      <option value="none">No target</option>
                    </select>
                    <div>
                      {t.mode === "set" ? (
                        <NumInput label={`Team ${m.label} per week`} disabled={!editable} value={t.value}
                          invalid={t.value.trim() === "" || invalid(t.value)}
                          onChange={(v) => setDraft((d) => ({ ...d, team: { ...d.team, [m.key]: { ...t, value: v } } }))} />
                      ) : (
                        <span className="inline-block h-7 w-16 pr-1.5 text-right font-semibold leading-7 tabular-nums text-ink">
                          {eff ?? "—"}
                        </span>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

function quarterStarts(): { start: string; label: string }[] {
  const now = new Date();
  const q0 = Math.floor(now.getMonth() / 3);
  const out = [];
  for (let k = -1; k <= 4; k++) {
    const idx = now.getFullYear() * 4 + q0 + k;
    const y = Math.floor(idx / 4), q = idx % 4;
    out.push({ start: `${y}-${String(q * 3 + 1).padStart(2, "0")}-01`, label: `Q${q + 1} ${y}` });
  }
  return out;
}

function PipelineSection({ data, editable }: { data: JobsTargets; editable: boolean }) {
  const quarters = useMemo(() => {
    // Always the next few quarters, plus any further-out quarter that already has a target.
    const base = quarterStarts();
    const extra = data.pipeline.filter((p) => !base.some((b) => b.start === p.period_start))
      .map((p) => {
        const [y, m] = p.period_start.split("-").map(Number);
        return { start: p.period_start, label: `Q${Math.floor((m - 1) / 3) + 1} ${y}` };
      });
    return [...base, ...extra].sort((a, b) => a.start.localeCompare(b.start));
  }, [data.pipeline]);
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const q of quarters) m[q.start] = String(data.pipeline.find((p) => p.period_start === q.start)?.value ?? "");
    return m;
  }, [quarters, data.pipeline]);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const save = useSavePipelineTargets();
  useEffect(() => { setDraft(initial); }, [initial]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const anyInvalid = Object.values(draft).some((v) => parseTarget(v) === undefined);
  const total = Object.values(draft).reduce((s, v) => s + (parseTarget(v) ?? 0), 0);

  const submit = () => {
    if (anyInvalid) { setError("Targets must be whole numbers."); return; }
    const changed = quarters.filter((q) => draft[q.start] !== initial[q.start])
      .map((q) => ({ period_start: q.start, value: parseTarget(draft[q.start]) ?? null }));
    save.mutate(changed, {
      onError: (e) => setError(apiErrorMessage(e, "Couldn't save pipeline targets.")),
      onSuccess: () => setError(null),
    });
  };

  return (
    <Section title="Pipeline: jobs targets"
      desc="Jobs to land per quarter. Shown as the target on Jobs › Performance › Pipeline › Jobs Projection; a month reads its quarter's target ÷ 3."
      footer={<SaveBar editable={editable} dirty={dirty} saving={save.isPending} error={error}
        onReset={() => { setDraft(initial); setError(null); }} onSave={submit} />}>
      <div className="flex flex-wrap items-end gap-4">
        {quarters.map((q) => (
          <label key={q.start} className="flex flex-col items-end gap-1">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{q.label}</span>
            <NumInput label={`Jobs target ${q.label}`} disabled={!editable} value={draft[q.start] ?? ""}
              invalid={parseTarget(draft[q.start] ?? "") === undefined}
              onChange={(v) => setDraft((d) => ({ ...d, [q.start]: v }))} className="w-20" />
          </label>
        ))}
        <span className="ml-auto text-[12px] tabular-nums text-ink-3">{total} jobs across these quarters</span>
      </div>
    </Section>
  );
}
