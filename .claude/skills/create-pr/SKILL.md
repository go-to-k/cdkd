---
name: create-pr
description: Run /verify-pr checks, then create a GitHub PR if all pass. Automates the full flow from quality checks to PR creation.
argument-hint: "[--base <branch>]"
---

# Create PR

Run all quality checks and create a GitHub PR if everything passes.

## Steps

1. **Ensure on a feature branch with the right cwd**:
   - `git branch --show-current` — check current branch
   - **Multi-worktree pre-flight**: if the current branch is `main` (or `master`), also run `git worktree list --porcelain` and check whether any other worktree is on a non-main branch. If yes, surface that explicitly:
     ```
     git worktree list --porcelain | awk '/^worktree /{wt=$2} /^branch refs\/heads\//{b=substr($0,index($0,"refs/heads/")+11); if (b!="main" && b!="master") print wt " on branch " b}'
     ```
     The user almost certainly intended to run `/create-pr` from that worktree's path — every subsequent `git` / `gh pr view` call defaults to cwd, so running from the parent worktree on `main` produces "no PR found for branch 'main'" even when a feature branch with commits is sitting in another worktree. **Stop and ask** the user whether to proceed in the listed worktree (offering `cd <path>` as the next step) before falling through to "create a new branch".
   - If on `main` and no other worktrees have non-main branches, ask the user for a branch name and create it: `git checkout -b <branch-name>`.
   - Branch naming convention: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/` prefix.
   - Subsequent steps assume cwd is the worktree of the feature branch being PR'd. If the user defers the cd, abort instead of guessing.

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
   - Title: concise, under 70 characters
   - **Base the title and body on the actual diff (`git diff main...HEAD`), not just commit messages** — commit messages may reflect intermediate iterations that were later reverted
   - **Always write the PR title and body in English**
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
- `gh pr edit` may fail silently (e.g., Projects Classic deprecation). After updating a PR, verify the result with `gh pr view`. If `gh pr edit` fails, fall back to `gh api repos/{owner}/{repo}/pulls/{number} -X PATCH`
