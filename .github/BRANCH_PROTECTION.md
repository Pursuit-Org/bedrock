# Branch protection setup — `dev` and `main`

Manual one-time setup so nothing lands on `dev` or `main` without
going through a PR that Jacqueline reviews.

GitHub does not let you configure branch protection via a checked-in
file — it's a Settings-page click-through. Follow the steps below for
**each** of the two branches: `main` first (highest stakes), then `dev`.

---

## Steps

1. Go to https://github.com/Pursuit-Org/bedrock/settings/branches
2. Click **Add branch ruleset** (or **Add rule** in the legacy UI).
3. **Ruleset name**: `protect-main` (or `protect-dev`).
4. **Enforcement status**: Active.
5. **Target branches**:
   - Add target → Include by pattern → `main` (or `dev`).
6. Under **Branch rules**, enable:

   - ☑ **Restrict deletions** — nobody can `git push --delete`.
   - ☑ **Require linear history** — blocks merge commits; pushes the
         team toward squash-merge or rebase-merge. Optional but
         recommended for clean history.
   - ☑ **Require a pull request before merging**
     - **Required approvals**: 1
     - ☑ **Dismiss stale pull request approvals when new commits are
            pushed** — forces re-review if the branch is updated.
     - ☑ **Require review from Code Owners** — uses the
            `.github/CODEOWNERS` file in this repo.
     - ☐ Require approval of the most recent reviewable push
            (recommended off unless you want strict re-review on tiny
            edits).
   - ☑ **Block force pushes** — nobody can `git push --force`.
   - ☐ Require status checks to pass — only enable if you wire up CI
         later. Set to `tsc` / `vite build` checks once a workflow
         exists.

7. Under **Bypass list** (optional): leave empty unless you want a
   break-glass admin (yourself with Repo Admin role can already bypass
   in emergencies via the Settings page).

8. Click **Create**.

9. Repeat for the other branch.

---

## What this enforces

- No direct `git push` to `main` / `dev` — every change has to go
  through a Pull Request.
- Every PR auto-requests review from `@jacrev-pursuit` (via
  CODEOWNERS) and can't be merged until that review is approved.
- Force-pushes and branch deletions on `main` / `dev` are blocked.

## What this does NOT enforce

- Doesn't prevent the PR author from approving their own PR if they
  have admin rights. To block self-approval on a 1-person review
  requirement, GitHub requires the **organization** plan ($21/seat).
  For a small team, social pressure + "Required reviewers" works.
- Doesn't run any automated tests. To wire up CI, add a workflow at
  `.github/workflows/ci.yml` running `tsc --noEmit` + `npm run build`
  + `pytest tests/` and reference those checks in the rule's
  "Require status checks" section.

## After turning these on

Anyone who tries to push directly to `main` or `dev` gets:

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: error: At least 1 approving review is required by reviewers
       with write access.
```

That's the signal everyone's working through the right channels.
