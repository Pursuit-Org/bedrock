# Email body display everywhere + shared cleanEmailText (follow-up to PR #273)

Roll the full-email-body pattern (HTML cleaning + show more/less) out to every
frontend-v2 surface that renders email activity, and fix the PR #273 review
findings.

## Plan

- [x] `src/lib/emailText.ts` — single shared module:
  - `decodeEntities` — `&amp;` decoded LAST so `&amp;lt;` → literal `&lt;` (no double-decode)
  - `cleanEmailText` — tag-strip → decode → whitespace normalize (email fields only)
  - `cleanPlainText` — decode + light whitespace normalize, NO tag-strip (Task/Event notes keep `Sarah <sarah@x.org>`)
  - `activityBodyText(a)` — picks `email_body_text ?? email_snippet ?? description`, tag-stripping only email fields (and description only for `type === "email"` rows)
- [x] `ActivityTimeline.tsx` — shared helpers; description tag-strip regression fixed; subjects decoded; search + mentions-me match the cleaned text users see
- [x] `expand/ActivityTab.tsx` — shared helpers; subject decode-only (no tag-strip of legit angle-bracket text); body via `activityBodyText` + show-more; search matches display
- [x] `jobs/JobsActivityList.tsx` — shared helpers; email bodies tag-stripped; show-more toggle added
- [x] `pages/jobs/JobsTeam.tsx` ActivityRow — shared helpers (local textarea decoder removed); cleaned body; show-more toggle replaces the inner scroll box
- [x] New `components/ActivityListRow.tsx` shared by Contact/Account/Opportunity drawers — rows expand to full cleaned body + show-more (previously one-line snippet only)
- [x] `pages/jobs/JobsOutreach.tsx` TouchLog — cleaned snippet, rows expandable to full body
- [x] Verify: typecheck ✓, build ✓ (repo has no eslint.config — lint script is broken pre-existing), helper behaviors unit-verified with node
- [ ] Out of scope, flagged separately: backend 4000-char `email_body_text` cap in `_row_to_dict` (PR #273 review "important" #2)

## Review

All seven surfaces that render email activity now share one cleaning module
(`src/lib/emailText.ts`) and the same show more/less pattern. Verified by
`tsc --noEmit`, `vite build`, and direct node tests of the helpers:
`&amp;lt;` decodes once to `&lt;`; `<div>Hi &lt;sarah@x.org&gt;</div>` cleans to
`Hi <sarah@x.org>`; task/meeting descriptions keep angle-bracket text intact;
email-type descriptions still get tag-stripped.

Not addressed here (backend): `_row_to_dict` silently truncates
`email_body_text` at 4000 chars, so "Show more" can present a truncated body
as complete.
