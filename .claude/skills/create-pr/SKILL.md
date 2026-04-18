---
name: create-pr
description: Run /verify-pr checks, then create a GitHub PR if all pass. Automates the full flow from quality checks to PR creation.
argument-hint: "[--base <branch>]"
---

# Create PR

Run all quality checks and create a GitHub PR if everything passes.

## Steps

1. **Ensure on a feature branch**:
   - `git branch --show-current` — check current branch
   - If on `main`, ask the user for a branch name and create it: `git checkout -b <branch-name>`
   - Branch naming convention: `feat/`, `fix/`, `refactor/`, `docs/` prefix

2. **Run `/verify-pr`** — typecheck, lint, build, tests, CI, docs consistency, leftover resources. If any check fails, stop and report.

4. **Ensure changes are committed and pushed**:
   - `git status` — if uncommitted changes exist, ask the user whether to commit them
   - `git push -u origin <branch>` — ensure remote is up to date

5. **Check if PR already exists** for the current branch:
   - `gh pr view --json number,url -q '.url' 2>/dev/null`
   - If PR exists, report the URL and ask if the user wants to update it

6. **Gather PR context**:
   - `git log main...HEAD --oneline` — all commits in this branch
   - `git diff main...HEAD --stat` — changed files summary
   - Determine base branch (default: `main`, overridable with `--base`)

7. **Draft PR title and body**:
   - Title: concise, under 70 characters, based on the commits
   - Body format:
     ```
     ## Summary
     - bullet points of what changed and why

     ## Test plan
     - [ ] Unit tests pass (N files, M tests)
     - [ ] Integration test: <which ones were run, if any>
     - [ ] Documentation updated
     ```

8. **Create PR**:
   ```bash
   gh pr create --title "..." --body "$(cat <<'EOF'
   ...
   EOF
   )"
   ```

9. **Report** the PR URL.

## Important

- Do NOT create a PR if any `/verify-pr` check fails
- Always push before creating the PR
- If the branch has no commits ahead of main, warn and stop
