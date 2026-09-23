import { type ReactNode } from "react";
import { Linkedin, Github, FileText, BookOpen, ExternalLink, Check } from "lucide-react";

import { Drawer } from "@/components/ui/Drawer";
import { InlineText } from "@/components/ui/InlineEdit";
import { JobStageChip } from "@/components/jobs/JobStageChip";
import {
  useBuilderDetail,
  useUpdateBuilderProfile,
  BUILDER_STATUS_LABELS,
  BUILDER_STATUS_STYLES,
  BUILDER_STATUS_ORDER,
  type JobStage,
  type BuilderJobProfile,
} from "@/services/jobs";
import { cn } from "@/lib/utils";

const READY_FIELDS: { key: keyof BuilderJobProfile; label: string }[] = [
  { key: "ready_lookbook", label: "Lookbook" },
  { key: "ready_linkedin", label: "LinkedIn" },
  { key: "ready_github", label: "GitHub" },
  { key: "ready_cv", label: "CV" },
  { key: "ready_mock", label: "Mock Interview" },
];

const RATINGS: { key: string; label: string }[] = [
  { key: "technical_capability", label: "Technical Capability" },
  { key: "ai_reasoning", label: "AI Reasoning & Troubleshooting" },
  { key: "problem_solving", label: "Problem Solving" },
  { key: "presentation", label: "Presentation & Storytelling" },
  { key: "professional_behaviors", label: "Professional Behaviors" },
];

const INTAKE_FIELDS: { key: string; label: string }[] = [
  { key: "salary_expectation", label: "Salary expectation" },
  { key: "work_preference", label: "Work preference" },
  { key: "geo_preference", label: "Geographic preference" },
  { key: "roles_interested", label: "Roles interested in" },
  { key: "what_matters_most", label: "What matters most" },
  { key: "open_to_freelance", label: "Open to freelance/contract" },
  { key: "biggest_blockers", label: "Biggest blockers" },
  { key: "years_professional_experience", label: "Years of experience" },
];

export function BuilderDetailDrawer({ userId, onClose }: { userId: number | null; onClose: () => void }) {
  const { data, isLoading } = useBuilderDetail(userId);
  const update = useUpdateBuilderProfile();

  const patch = async (body: Record<string, unknown>): Promise<void> => {
    if (userId != null) await update.mutateAsync({ userId, ...body });
  };

  const p = data?.profile;
  const id = data?.identity;

  return (
    <Drawer
      open={userId !== null}
      onClose={onClose}
      title={id?.name ?? (isLoading ? "Loading…" : "Builder")}
      subtitle={id ? (
        <span className="flex items-center gap-1.5">
          {id.cohort ?? "—"}
          {id.cohort_completed ? <span className="rounded bg-[var(--green-soft)] px-1 text-[9.5px] font-semibold text-[var(--green)]">completed</span> : null}
          {id.email ? <span className="text-ink-4">· {id.email}</span> : null}
        </span>
      ) : undefined}
      width={720}
    >
      {!data ? (
        <div className="px-5 py-10 text-center text-[13px] text-ink-4">Loading…</div>
      ) : (
        <div className="flex flex-col gap-5 px-5 py-4">
          {/* 1 · Header: status + coach + links */}
          <Section title="Status & Links">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wider text-ink-3">Status</span>
                <select
                  value={data.status}
                  onChange={(e) => patch({ job_search_status: e.target.value })}
                  className={cn("rounded-full border-0 px-2.5 py-1 text-[11.5px] font-semibold focus:outline-none focus:ring-1 focus:ring-accent",
                    BUILDER_STATUS_STYLES[data.status])}
                >
                  {BUILDER_STATUS_ORDER.map((s) => <option key={s} value={s}>{BUILDER_STATUS_LABELS[s]}</option>)}
                </select>
                {data.status_overridden ? (
                  <button onClick={() => patch({ status_overridden: false })} className="text-[10.5px] text-ink-4 underline hover:text-ink-2"
                    title={`Auto would be: ${BUILDER_STATUS_LABELS[data.derived_status]}`}>
                    use auto
                  </button>
                ) : <span className="text-[10.5px] text-ink-4">auto</span>}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] uppercase tracking-wider text-ink-3">Coach</span>
                <InlineText value={p?.pursuit_coach ?? ""} onSave={(v) => patch({ pursuit_coach: v || null })} placeholder="—" />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <LinkChip href={id?.linkedin_url ?? (p?.intake?.linkedin_url as string)} icon={<Linkedin size={12} />} label="LinkedIn" />
              <LinkChip href={id?.github_url} icon={<Github size={12} />} label="GitHub" />
              <LinkChip href={p?.resume_url} icon={<FileText size={12} />} label="Resume" />
              <LinkChip href={p?.lookbook_url} icon={<BookOpen size={12} />} label="Lookbook" />
            </div>
          </Section>

          {/* 2 · Readiness + competency scorecard */}
          <Section title="Readiness & Competencies">
            <div className="flex flex-wrap gap-2">
              {READY_FIELDS.map((f) => {
                const on = Boolean(p?.[f.key]);
                return (
                  <button key={f.key} onClick={() => patch({ [f.key]: !on })}
                    className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                      on ? "bg-[var(--green-soft)] text-[var(--green)]" : "bg-surface-2 text-ink-4 hover:text-ink-2")}>
                    <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded-full border", on ? "border-[var(--green)] bg-[var(--green)]" : "border-border-strong")}>
                      {on ? <Check size={9} className="text-white" /> : null}
                    </span>
                    {f.label}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 pt-2 sm:grid-cols-3">
              {RATINGS.map((r) => (
                <Field key={r.key} label={r.label}>
                  <InlineText value={(p?.[r.key as keyof typeof p] as string) ?? ""} onSave={(v) => patch({ [r.key]: v || null })} placeholder="—" />
                </Field>
              ))}
              <Field label="Prof. Strength"><InlineText value={p?.prof_strength ?? ""} onSave={(v) => patch({ prof_strength: v || null })} placeholder="—" /></Field>
              <Field label="Technical Strength"><InlineText value={p?.technical_strength ?? ""} onSave={(v) => patch({ technical_strength: v || null })} placeholder="—" /></Field>
            </div>
            {data.learning?.interview_readiness != null ? (
              <p className="pt-1 text-[10.5px] text-ink-4">Platform interview-readiness score: {data.learning.interview_readiness}</p>
            ) : null}
          </Section>

          {/* 3 · Job search */}
          <Section title={`Job Search — ${data.applications.length} applications · ${data.placements.length} placements`}>
            {data.applications.length === 0 && data.placements.length === 0 && data.deal_matches.length === 0 ? (
              <p className="text-[12px] text-ink-4">No applications, placements, or deal matches yet.</p>
            ) : null}
            {data.applications.length > 0 ? (
              <SubList title="Applications">
                {data.applications.map((a) => (
                  <Row key={a.id}>
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">{a.company_name ?? "—"}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-3">{a.role_title ?? "—"}</span>
                    {a.stage ? <JobStageChip stage={appStage(a.stage)} /> : null}
                    <span className="w-[80px] text-right text-[11px] text-ink-4">{a.date_applied ?? ""}</span>
                  </Row>
                ))}
              </SubList>
            ) : null}
            {data.placements.length > 0 ? (
              <SubList title="Placements">
                {data.placements.map((pl) => (
                  <Row key={pl.id}>
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">{pl.company_name ?? "Independent / Freelance"}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-3">{pl.role_title ?? "—"}</span>
                    <span className="text-[11px] text-ink-4">{pl.employment_type ?? "—"}</span>
                    <span className="w-[80px] text-right font-mono text-[11px] text-ink-2">{pl.payment_amount ? `$${Math.round(pl.payment_amount).toLocaleString()}` : "—"}</span>
                  </Row>
                ))}
              </SubList>
            ) : null}
            {data.deal_matches.length > 0 ? (
              <SubList title="Deal matches">
                {data.deal_matches.map((d) => (
                  <Row key={d.id}>
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">{d.account_name ?? "—"}</span>
                    <JobStageChip stage={d.stage} />
                  </Row>
                ))}
              </SubList>
            ) : null}
          </Section>

          {/* 4 · Preferences & intake */}
          <Section title="Preferences & Intake">
            {data.enrollment?.current_profile ? (
              <Field label="Pathfinder profile"><span className="text-ink-2">{data.enrollment.current_profile}</span></Field>
            ) : null}
            <ChipRow label="Target industries" items={p?.target_industries} />
            <ChipRow label="Preferred modes" items={p?.preferred_modes} />
            <ChipRow label="Certifications" items={p?.certifications} />
            {(p?.university || p?.degree || p?.graduation_year) ? (
              <Field label="Education"><span className="text-ink-2">{[p?.degree, p?.university, p?.graduation_year].filter(Boolean).join(" · ") || "—"}</span></Field>
            ) : null}
            <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 pt-1 sm:grid-cols-2">
              {INTAKE_FIELDS.map((f) => {
                const v = p?.intake?.[f.key];
                if (v == null || v === "") return null;
                return <Field key={f.key} label={f.label}><span className="text-ink-2">{String(v)}</span></Field>;
              })}
            </div>
            {data.intake_quiz.length > 0 ? (
              <SubList title="Job-strategy quiz">
                {data.intake_quiz.map((q) => (
                  <div key={q.question_key} className="flex flex-col gap-0.5 border-t border-border-strong py-1.5 first:border-t-0">
                    <span className="text-[10.5px] uppercase tracking-wider text-ink-4">{q.question_key.replace(/_/g, " ")}</span>
                    <span className="text-[12px] text-ink-2">{q.response_text ?? "—"}</span>
                  </div>
                ))}
              </SubList>
            ) : null}
          </Section>

          {/* 5 · Coach notes */}
          <Section title="Coach Notes">
            <Field label="General notes"><InlineText value={p?.gen_notes ?? ""} onSave={(v) => patch({ gen_notes: v || null })} placeholder="—" multiline /></Field>
            <Field label="Coach notes"><InlineText value={p?.coach_notes ?? ""} onSave={(v) => patch({ coach_notes: v || null })} placeholder="—" multiline /></Field>
            <ChipRow label="Improvement tags" items={p?.improvement_tags} />
            <ChipRow label="Flags" items={p?.coach_flags} />
          </Section>
        </div>
      )}
    </Drawer>
  );
}

// ── small building blocks ──────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] uppercase tracking-wider text-ink-4">{label}</span>
      <div className="text-[12.5px]">{children}</div>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 border-t border-border-strong py-1.5 text-[12px] first:border-t-0">{children}</div>;
}

function SubList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border-strong bg-surface-2/30 px-3 py-2">
      <div className="pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{title}</div>
      {children}
    </div>
  );
}

function ChipRow({ label, items }: { label: string; items?: string[] | null }) {
  if (!items || items.length === 0) return null;
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-1">
        {items.map((it, i) => <span key={i} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">{it}</span>)}
      </div>
    </Field>
  );
}

function LinkChip({ href, icon, label }: { href?: string | null; icon: ReactNode; label: string }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface px-2 py-1 text-[11px] text-ink-2 hover:border-accent hover:text-ink">
      {icon}{label}<ExternalLink size={9} className="text-ink-4" />
    </a>
  );
}

// job_applications stages → JobStage chip vocabulary (best-effort map).
// Display only — nothing here is written back to jobs_opportunity.
function appStage(s: string): JobStage {
  const m: Record<string, JobStage> = {
    applied: "builder_submitted",
    interview: "builder_interviewing",
    accepted: "closed_won",
    rejected: "closed_lost",
  };
  return m[s] ?? "active_in_discussions";
}
