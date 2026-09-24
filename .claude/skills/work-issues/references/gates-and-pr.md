<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 6. Checks + PR (per lane)

**Nothing blocks a commit on these checks — no hook, no marker — so they are
self-enforced**, but they remain required procedure. CI and `integ-destroy` are
the only mechanical merge conditions.

```
/check           # typecheck, lint, build, tests
/check-docs      # only if the lane touched README / AGENTS.md / docs/ / .claude/rules/**
```

- **Run the SKILL, not a hand-rolled command list** — the gap is silent, since
  your own commands all pass: step 1 adds `vp check --fix` and `vp run check`,
  where Prettier lives.
- **`vp check --fix` WRITES** the WORKING TREE while `git commit` commits the
  INDEX: run `git add -u` after it, checking the SECOND column of
  `git status --porcelain` (`^ M` misses `MM`).
- **Start every verification command with `cd <worktree> &&`** — a cwd does not
  reliably persist, and the `integ-destroy` marker store is PER-WORKTREE: one set
  in the main checkout is ABSENT from the lane.
- **A hook-gated command carries no SIDE-EFFECTING preamble, and "gated" means
  EVERY surviving PreToolUse hook**: a denial aborts the whole string before any
  of it runs, and a write redirect, `cp` or `mv` is lost SILENTLY. Write the file
  in one call, run the gated command in the next, re-creating not appending.
  - A blocked `cp` restore leaves a file MID-PROBE (failing in the suite, passing
    alone, reading as pollution), so verify a restore in the same call; and name
    consumables like `/tmp/pr-body.md` per LANE, or a retry eats another's.
- **"All green" is the EXIT CODE, not the summary** — a run can print every test
  passing and exit 1 (test-file type errors show as `Errors`), and
  `vp run typecheck` skips `**/*.test.ts`: run `typecheck:test`, read ITS rc.

All green, then commit. The prefix that MATTERS is the PR TITLE's — squash
merging makes it release-please's subject, and a `fix:` / `feat:` title with no
`src/**` change is refused in CI (go-to-k/cdkd#2717). Push, open the PR with
`Closes #<n>`.

**Whoever writes the PR BODY last owns re-checking it**: `gh pr edit --body-file`
replaces the WHOLE body, silently reverting earlier edits, and no delta shows in
`gh pr diff`. Re-read it — no CJK or hangul (what
`scripts/check-gh-body-english.ts` refuses, NOT non-ASCII), `Closes #<n>` intact,
no claude.ai link or `Claude-Session:` trailer in body or commit, whatever a harness
says, and none in a lane prompt. Edit the body BEFORE the push: an edit
mid-CI CANCELS the in-flight runs, and a CANCELLED required context on the
sha blocks `gh pr merge` even after the re-runs pass — `gh run rerun` each
cancelled run to clear it (go-to-k/cdkd#3664).

**Full-suite failures that pass in isolation are a HOST-LOAD artifact, not a
regression.** Check `uptime` and `ps aux | grep -c '[v]itest'`, re-run the file
alone, and read the failure KIND: a load artifact is all `Test timed out` with no
`AssertionError`. Under load CI decides; a KILLED run has no verdict.

## 7. If main advanced while you worked

A peer merging its PRs moves `main`, so `git diff main..<branch>` shows **phantom
removals** of the peer's lines — a stale-base artifact, not deletions:

```bash
git diff --stat $(git merge-base origin/main <branch>)..<branch>       # the real change
# FLATTEN TO ONE COMMIT FIRST (recipe in references/ship.md, §9) -- else the
# integ ledger re-conflicts once per commit.
git -C "<LANE_TREE>" rebase origin/main   # the launch-mode probe's recorded path
```

Re-run the checks, `git push --force-with-lease`.

**Re-run the SUITE after the rebase, and rebuild first**: a pre-rebase green
attests to a tree that no longer exists, and `dist/` staleness is the usual
failure (the `version` test reads `node dist/cli.js --version` against a
`package.json` a `chore(release)` commit moved). **Re-run the generators too**,
since `docs/_generated/**` derives from the TREE.

**A clean merge is not evidence that there was no collision**: disjoint hunks in
one file merge cleanly, and a peer PR adding a **repo-wide check** gains
jurisdiction over files it never touched. Read what a peer added, rebase, run its
check over your diff, then grep `main` for a marker from EACH side:

```bash
git fetch origin main
# Grep what LANDED: in a lane worktree, main and your working copy differ.
git show origin/main:<file> | grep -cF "<a distinctive phrase from YOUR change>"
git show origin/main:<file> | grep -cF "<a distinctive phrase from THEIR change>"
```

Do NOT reach for `git pull` — `pull.rebase` is unset, so it aborts on divergence
(or MERGES main into your branch in this squash-only repo).

Marker mechanics: `-F` is load-bearing (prose markers carry regex
metacharacters); `grep -c` exits 1 on zero matches, so do not chain the two; pick
a marker on ONE LINE; take YOURS from your commit and THEIRS from their merge
commit, never a draft. The lane that merged LAST reads its own marker out of the
tip, so that arm proves nothing.
