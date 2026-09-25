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
     The user almost certainly meant to run `/create-pr` from that worktree — every later `git` / `gh pr view` call defaults to cwd, so running from the parent worktree on `main` reports "no PR found for branch 'main'" while a feature branch with commits sits elsewhere. **Stop and ask** whether to proceed in the listed worktree (offer `cd <path>`) before falling through to "create a new branch".
   - If on `main` and no other worktrees have non-main branches, ask the user for a branch name and create it: `git checkout -b <branch-name>`.
   - Branch naming convention: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/` prefix.
   - Later steps assume cwd is that worktree; if the user defers the cd, abort rather than guess.

2. **Run `/verify-pr`** — typecheck, lint, build, tests, CI, docs consistency, leftover resources. If any check fails, stop and report.

3. **Ensure changes are committed and pushed**:
   - `git status` — commit any uncommitted changes that belong to this branch's work
   - `git push -u origin <branch>` — ensure remote is up to date

4. **Check if PR already exists** for the current branch:
   - `gh pr view --json number,url -q '.url' 2>/dev/null`
   - If a PR exists, update its title/body (see /verify-pr step 12) and report the URL

5. **Gather PR context**:
   - `git log main...HEAD --oneline` — all commits in this branch
   - `git diff main...HEAD --stat` — changed files summary
   - Determine base branch (default: `main`, overridable with `--base`)

6. **Draft PR title and body**:
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

7. **Create PR**:
   ```bash
   gh pr create --title "..." --body "$(cat <<'EOF'
   ...
   EOF
   )"
   ```

8. **Report** the PR URL.

## Important

- Do NOT create a PR if any `/verify-pr` check fails
- Always push before creating the PR
- If the branch has no commits ahead of main, warn and stop
- **Verify a PR update landed, with `gh pr view`.** A wrong `--body-file` path or a shell-eaten backtick writes the wrong body silently. `gh api repos/{owner}/{repo}/pulls/{number} -X PATCH -F body=@<file>` is the better spelling for a body full of backticks, since `@<file>` is read verbatim
