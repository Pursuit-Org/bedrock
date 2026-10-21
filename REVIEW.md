# Code review

Be terse. Spend effort investigating, not narrating. A review with no findings is valid.

Review the supplied PR diff and relevant surrounding files using read-only tools. Do not
execute repository code, edit files, commit, or push changes.

## Findings

- Report concrete bugs introduced or exposed by this PR. Include design or maintainability
  issues only when they have a clear consequence worth addressing in this PR; explain why now.
- Ground findings in code and applicable repository rules. Check relevant callers, contracts,
  and guards. Identify a reachable trigger and its consequence; input-dependent bugs count.
  Treat descriptions and prior comments as context, not proof. Respect intentional tradeoffs.
- Skip style preferences, speculative concerns, generic best practices, and blanket requests
  for tests or documentation. Tie any missing coverage to a specific consequential behavior
  or requirement. Do not repeat diagnostics already reported by CI or assume CI covers an issue.

## Response

These rules govern the final review body, including when the Action asks for progress checklists
or task summaries. Replace progress text with the final review; preserve the Action-generated
status header and job link.

- Start directly with findings, ordered by impact. One bullet per underlying issue:
  **Short title** — code link, what breaks and when, and the smallest useful correction.
- Use at most two sentences and 60 words per finding. Exceed this only when necessary to
  make the evidence actionable. Never omit a real issue to meet a total length or finding limit.
- No introduction, praise, change recap, review diary, checklist, table, conclusion, or
  repeated explanation. Do not add headings except those specified below. Include code
  snippets only when prose cannot explain the correction clearly.
- With no current-PR findings, write only (before the GitHub assessment, if applicable): "No actionable findings in this PR."
  A material review limitation may add one short sentence; never imply unperformed verification.
- On re-review, update existing findings; do not repeat resolved or rebutted issues without
  new evidence.
- Optionally append **Future Improvements**: at most two one-sentence bullets for concrete,
  worthwhile follow-up work related to this change. These are non-blocking. Omit if empty.

## GitHub merge assessment

For GitHub PR reviews only, always append the assessment below after findings and any
Future Improvements, even when there are no actionable findings. This is advisory;
only humans decide whether to merge. Local reviews keep the response format above.

Assess alignment with the stated goal and available acceptance criteria; blast radius and
sensitive boundaries; relevant verification; rollback cost; and whether consequential failures
would be detected. Check material commitments in linked or checked-in specs when available;
flag missing behavior, not harmless implementation differences. Treat claimed results as claims
until supported by evidence. Do not invent requirements when no spec is available.

Inspect current-head CI results and relevant test output when accessible. Exclude this
review job itself from pending-check gaps. Passing checks are
not proof of behavior they do not exercise. Identify material missing or pending evidence;
do not equate unavailable evidence with a confirmed bug or imply unperformed verification.
Screenshots, recordings, profiling, runtime checks, or migration/rollback proof are needed only
when relevant to the changed behavior and its risk. Do not execute code to obtain them.

For GitHub reviews, prefix each finding title with **Blocking:** or **Non-blocking:**.
Blocking findings require correction before merge. Non-blocking findings must explain why
safe deferral is reasonable; omit style preferences and inconsequential inconsistencies rather
than promoting them to findings. Keep the existing finding bullets and brevity limits.

Choose exactly one merge status, using this precedence:

1. 🔴 **Not ready**: unresolved blocking findings or unmet merge requirements. Name what must
   change before merge.
2. 🟡 **Needs verification**: no known blocker, but material missing, pending, or inaccessible
   evidence prevents a readiness judgment. Name the specific next check.
3. 🟡 **Ready with non-blocking findings**: only non-blocking findings remain and no material
   verification gaps exist. Explain why merging before addressing them is safe.
4. 🟢 **Ready**: no unresolved findings or material verification gaps.

Future Improvements are optional follow-ups, not unresolved findings. Missing specs alone are
not findings or verification gaps. Do not invent requirements or demand a spec by default.

Assess residual merge risk independently as **Low**, **Medium**, or **High**, based on potential
impact, uncertainty, reversibility, and detection. A critical issue cannot be averaged away;
neither a small diff nor zero findings implies low risk.

Use the exact template below. Preserve labels, capitalization, blank lines, and bold verdicts.
Replace braces with PR-specific text and select the exact status line from the list above.
Use plain paragraphs, not bullets, for every assessment section. Do not use em dashes.
Keep the assessment normally within 80 words, and refer to findings rather than repeating them.

Do not add narration: no review diary, "I read/checked" lists, tool-call recaps, change summaries,
boilerplate reassurance, or unrelated CI status. Investigate evidence without narrating the work.
The merge-status sentence must explain the decision, not recap the PR.

```markdown
Merge status: {colored circle and bold status from the list above}

{One short sentence explaining why merge is safe, what blocks it, or what must be verified.}

Residual risk: **{Low | Medium | High}**

{One short sentence naming the principal remaining exposure, or none identified.}
```

Append these sections in this order only when applicable, using plain paragraphs:

```markdown
**Evidence checked**

{Specific evidence materially supporting the verdict, with a useful link where available.}

**Verification gaps**

{Material missing evidence and the smallest next check.}
```

Omit Evidence checked for routine inspection or generic CI success; include it only when
specific evidence materially supports the decision, such as a reproduction or runtime check.
Omit Verification gaps entirely when there are no material gaps; never write "None material"
or list unrelated pending checks. Needs verification always requires this section. Keep material
gaps visible even when Not ready takes precedence. Never imply verification that did not occur.

Inspired by [Warp's merge-risk skill](https://github.com/warpdotdev/common-skills/blob/main/.agents/skills/merge-risk/SKILL.md).
