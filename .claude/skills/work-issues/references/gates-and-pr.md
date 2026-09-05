<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 6. Gates + PR (per lane)

**Before the session's FIRST commit, run CLAUDE.md's gate-liveness probe.**
Ordinary git output means the gates are not firing ONLY if something was there
to trip; with the markers already fresh — or the tree still CLEAN, which is
where a retro branch starts — it proves nothing, so use CLAUDE.md's shape
probe. Until the probe is CONCLUSIVE, every gate step below is self-enforced:
run each by hand and say so in the report.

From inside the worktree, run the local quality checks and record the markers:

```
/check          # typecheck, lint, build, tests → sets the `check` marker
/check-docs      # only if the lane touched README.md / CLAUDE.md / docs/ / .claude/rules/**
```

**Run the SKILL; do not hand-roll its command list and set the marker
yourself.** The marker attests that `/check` ran; setting it after a private
typecheck/lint/build/test sequence records something that did not happen, and
the gap is silent because the commands you did run all pass — `/check` step 1
adds `vp check --fix` plus `vp run check`, where Prettier lives (measured:
three hand-rolled rounds while `vp run format:check` was failing the whole
time).

**`vp check --fix` WRITES, so `git commit` after it can commit a tree you did
not test**: `--fix` reformats the WORKING TREE while `git commit` commits the
INDEX — anything staged before the fix is committed pre-format, surfacing only
as CI's `format:check` minutes later. Run `git add -u` after `--fix`, and
confirm with `git status --porcelain` — matching `^ M` is not enough (a file
both staged and reformatted shows `MM`); test for a non-empty second column.

**Start every marker and gate command with an explicit `cd <worktree> &&`.**
"Repo root" means the WORKTREE's root, and a shell cwd does not reliably
persist between tool calls. The marker store is PER-WORKTREE (CLAUDE.md →
multi-session uncommitted-work safety) — a marker recorded in the main
checkout is simply ABSENT from the lane, surfacing as a `check-gate` refusal
reading "you never ran /check" seconds after you ran it.

**A gated command carries no SIDE-EFFECTING preamble in its Bash call, and
"gated" means EVERY PreToolUse hook.** The leading `cd <worktree> &&` is fine;
nothing that WRITES may share the call — a denial aborts the whole string
BEFORE any of it runs, including hooks unrelated to the merge flow (a
`cp <snapshot> && python3 <<'EOF'` was refused by an unrelated gate because
the heredoc quoted an SDK command name — the restore never ran). Enforced by
`.claude/hooks/gated-command-preamble-gate.sh`, added after the written rule
was violated twice in one lane (per §10-b: a rule violated despite being
stated is escalated, not restated). The gate blocks preambles whose loss is
SILENT (`markgate set`, a write redirect, `cp` / `mv`); it allows `cd`, reads,
and `git add` (whose loss fails loudly). Consequences, each seen live: both
`markgate set`s in `markgate set check && markgate set docs && git commit …`
are discarded with the refusal, and the retry reads as "the marker will not
stick"; a body file written in the same call as a refused `gh pr create`
leaves NO file behind, and a `>>` retry appends to nothing and ships a
fragment (go-to-k/cdk-local#525 opened with no `Closes` line). Write the file
in one call, run the gated command in the next; re-create rather than append
after any refusal.

- **Its worst signature is a file left MID-PROBE** — a blocked `cp` restore
  leaves the probe mutation in place, and the symptom (three tests failing in
  the full suite, passing alone) reads as cross-file pollution. **Verify a
  restore rather than assuming it, in the same call**:
  `cp <snap> <file> && grep -c '<a marker of the fixed state>' <file>`.
- **Its next-worst is a STALE file from an earlier session** — `/tmp/pr-body.md`
  is conventional and shared, so a gate can report violations this session
  never wrote. If a gate names text you do not recognise, check the file's
  mtime. Give body files a per-session name (the scratchpad directory plus a
  suffix), as §5 does for probe files.

**"All green" is the EXIT CODE, not the summary.** A run can report every test
passing and still exit non-zero, printing the two facts on adjacent lines
(measured: `Tests 14371 passed` / `Type Errors  no errors`, exit 1, with
`Errors  20 errors` in between — type errors in a test file). Capture the rc
explicitly (`vp test run > /tmp/out 2>&1; rc=$?`). And `vp run typecheck`
covers `tsconfig.json` (src + types), NOT `**/*.test.ts` — for any diff
touching `tests/**`, run `vp run typecheck:test` and read ITS rc (that split
is why `/check` step 2 lists it separately).

All green, then commit (conventional-commit; `fix:` for a user-visible fix,
`chore:` for `.claude/**` / tooling — `commit-prefix-scope-gate` blocks a
`fix:`/`feat:` commit with no `src/**` change). `check-gate` requires fresh
markers. Push, open the PR with `Closes #<n>`.

**A cluster of full-suite failures that pass in isolation is a HOST-LOAD
artifact, not a regression.** Tests that spawn subprocesses or inherit the 5 s
default timeout fail on elapsed time exactly when peer agents run their own
suites. Before reading a full-suite red as your change: **check the load**
(`uptime`, `ps aux | grep -c '[v]itest'`), re-run the file alone, re-run at
`--maxWorkers=4`. **Read the failure KIND, not the count** — a load artifact
produces `Test timed out in <N>ms` and ZERO `AssertionError`s (measured: 14
failures, 12 timeouts, 0 assertions, at load 73+). **Past a certain load no
local re-run settles it and CI is the authority** (at load 137-201 with 40
peer vitest processes, `--maxWorkers=4` AND single-file isolation both still
failed; the PR merged on a green dedicated-runner CI). **Do not use the stash
test to decide this** — the stashed and unstashed runs are minutes apart, so a
load spike ending in between reads as "the diff caused it" (drawn and
falsified within the hour, 2026-09-02).

## 7. If main advanced while you worked (parallel merges)

A peer merging its PRs moves `main` (and, when the release PR merges, a
`chore(release)` commit). Your branch
is now behind and `git diff main..<branch>` shows **phantom removals** of the
peer's added lines — a stale-base artifact, NOT real deletions. Confirm the
true diff and rebase:

```bash
git diff --stat $(git merge-base origin/main <branch>)..<branch>       # the real change
# FLATTEN TO ONE COMMIT FIRST -- recipe in references/ship.md (§9); the
# flatten-before-rebase-gate hook refuses this line otherwise.
git -C "<LANE_TREE>" rebase origin/main   # the path the launch-mode probe recorded
```

Re-run gates, `git push --force-with-lease`.

**Re-run the SUITE after the rebase, not just the gates — and rebuild first.**
A pre-rebase green attests to a tree that no longer exists: the rebase pulls
in every peer commit merged since the fork, including test files your run
never executed (measured across three lanes: one green before, RED after —
`dist/` staleness, because the `version` test compares `node dist/cli.js
--version` against the `package.json` a release bump just moved; a rebase
crossing a `chore(release)` commit desynchronises them by construction, hence
rebuild THEN run). **Re-run the GENERATORS too** — `/check` step 3's
`vp run gen:all-matrices`, not just `vp test run`: `docs/_generated/**` derives
from the whole TREE, so a `tests/integration/**` edit adding no source line
still moves a count (go-to-k/cdkd#2611: one `--log-group-identifier` line in a
`verify.sh` took `cli-flag-coverage` 324 → 325).

**A clean merge is not evidence that there was no collision.** Two lanes
editing the same file merge cleanly whenever their hunks fall in disjoint
sections, so §3's one-lane-per-file rule fails silently. The second shape is a
peer PR adding a **repo-wide check** (a tree-globbing test, a new lint, a
scanner over every `.md`), which gains jurisdiction over content in files it
never touched — neither PR's CI exercises the pair, so `main` can go red on a
merge where both sides were green (go-to-k/cdkd#1990's prose scanner vs a file
that took ten merges in one day). When a peer merges, read WHAT it added, then
rebase and RUN its check over your own diff before merging yours. After a
merge landing in a file another PR touched in the same window, grep `main` for
a marker string from EACH side:

```bash
git fetch origin main
# Grep what LANDED, not your working copy: in a lane worktree the two differ.
git show origin/main:<file> | grep -cF "<a distinctive phrase from YOUR change>"
git show origin/main:<file> | grep -cF "<a distinctive phrase from THEIR change>"
```

Do NOT reach for `git pull` here — `pull.rebase` is unset, so on a feature
branch it aborts on divergence (or, configured the other way, MERGES main into
your branch in a squash-only repo), and in the shared main tree it fails on
any dirty file. `git fetch` + `git show` reads main without touching a tree.

Marker mechanics, each measured: `-F` is load-bearing (prose markers are full
of regex metacharacters; without it a silent non-match reports the false
lost-content alarm this check exists to prevent); `grep -c` exits 1 on zero
matches, so do not chain the two greps; **pick a marker on ONE LINE of the
merged file** (hard-wrapped prose spans lines and the wrap column differs per
repo — before believing a 0, print the whole line with
`git show origin/main:<file> | grep -n "<one short word>"`); source YOUR
marker from your own commit and THEIR marker from THEIR merge commit
(`git show "$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid):<file>"`),
never from a draft — lanes reword between draft and merge. When one comes back
0, settle it with `diff <(git show origin/main:<file>) <file>` from your lane
worktree. Read the counts asymmetrically: whichever lane merged LAST has its
marker read back out of the tip, so that arm is tautological — two `1`s are
one real confirmation plus one tautology. (Context: two PRs rewrote SKILL.md
2m46s apart and both survived only because their hunks landed ~25 lines apart
— luck, not §3 holding.)
