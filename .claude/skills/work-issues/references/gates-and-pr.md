<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 6. Gates + PR (per lane)

**Before the session's FIRST commit, prove the gates are ALIVE.** Registration is
not execution: both siblings spent a day with every gate registered and INERT
(go-to-k/cdk-real-drift#1801 — an `if` holding `A or B` matches nothing), and an
ungated commit looks exactly like one that passed. `/hooks` lists what is
REGISTERED, so it cannot see this. One command can:

```bash
git commit --dry-run -m "gate liveness probe"   # from the repo root, on main
```

Run it as YOUR OWN Bash tool call — PreToolUse hooks gate the agent's tool
calls only, so the identical line typed by a human proves nothing. `--dry-run`
commits nothing whatever the tree looks like. Expected: `Blocked by
branch-gate` (the root is on `main`) or `Blocked by check-gate` (markers
stale). Git's ordinary output means the gates are NOT firing — every gate step
below is then self-enforced: run each check by hand and say so in the report.

From inside the worktree, run the local quality checks and record the markers:

```
/check          # typecheck, lint, build, tests → sets the `check` marker
/check-docs      # only if the lane touched README.md / CLAUDE.md / docs/ / .claude/rules/**
```

**Run the SKILL; do not hand-roll its command list and set the marker
yourself.** The `check` marker attests that `/check` ran; setting it after a
private `typecheck` / `lint` / `build` / `test` sequence records something that
did not happen, and the gap is silent because the commands you did run all
pass. What `/check` step 1 adds is `vp check --fix` plus `vp run check` —
where Prettier lives (measured 2026-08-27: three hand-rolled rounds while
`vp run format:check` was failing the whole time). Invoke the skill AND
control the cwd — never substitute one for the other.

**`vp check --fix` WRITES, so `git commit` after it can commit a tree you did not
test.** `--fix` reformats the WORKING TREE; `git commit` (without `-a`) commits
the INDEX — anything staged before the fix is committed pre-format while the
reformatted bytes sit unstaged, and the difference surfaces only as CI's
`format:check` minutes later. Run `git add -u` after `--fix` and before the
commit, and confirm with `git status --porcelain` — **matching on `^ M` is not
enough**: a file both staged and reformatted shows `MM`; test for a non-empty
second column. Measured 2026-08-28, twice in one lane — the marker was innocent
both times (it digests the working tree, which matched what was tested, not
what was committed).

**Start every marker and gate command with an explicit `cd <worktree> &&`.**
"Repo root" in this flow means the WORKTREE's root, and a shell cwd does not
reliably persist between tool calls (the `bash cwd silent reset` gotcha), so
the wrong tree is the default outcome. The marker store is PER-WORKTREE:
markgate writes under `$(git rev-parse --git-dir)`, which resolves to
`.git/worktrees/<name>` in a linked worktree, so a marker recorded in the main
checkout is simply ABSENT from the lane — the symptom is a `check-gate` refusal
reading "you never ran /check" seconds after you ran it (measured 2026-08-19:
`check  mismatch` in the main checkout vs `check  no marker` in the lane).

**A gated command carries no SIDE-EFFECTING preamble in its Bash call, and
"gated" means EVERY PreToolUse hook, not just this repo's markgate ones.** The
leading `cd <worktree> &&` is fine — gates resolve it — but nothing that WRITES
may share the call: PreToolUse hooks judge the call BEFORE any of it runs, and
a denial aborts the whole string, including hooks unrelated to the merge flow
(2026-08-21: a `cp <snapshot> … && python3 <<'EOF'` was refused by the
secret-fetching gate because the heredoc quoted an SDK command name — the
restore never ran). Do not reason about which hooks can fire; assume any call
can be refused, and keep writes in their own call.

**This paragraph is now enforced by `.claude/hooks/gated-command-preamble-gate.sh`,
because saying it twice did not work.** The rule with three worked examples was
already in this file when a 2026-08-25 run violated it twice in one lane
(`markgate set docs && … && git commit -F …` — both `set`s discarded, retry read
as "the marker will not stick"; then `cat > /tmp/commit-msg.txt <<'MSG' … &&
git commit -F …` — file never written). Per §10-b: a rule already in the text
and violated anyway proves the sentence is not load-bearing — escalate, do not
restate. The gate blocks only preambles whose loss is SILENT — `markgate set`,
a write redirect, `cp` / `mv`. It allows `cd <dir> &&`, reads, and `git add`
(losing that one fails the commit LOUDLY with "nothing to commit"). A write
AFTER the gated command is fine: it is that command's own output.

Consequences, each seen live: `markgate set check && markgate set docs &&
git commit …` is refused in full, including the `set`s that would have
satisfied the gate. A body file written in the same call as the refused
`gh pr create` leaves NO file behind; rebuilding the retry with `>>` appends
to nothing and ships a fragment — go-to-k/cdk-local#525 opened with no
`Closes` line and silently lost the issue auto-close. Write the body file in
one call, run the gated command in the next, and re-create rather than append
after any refusal.

**Its worst signature is a file left MID-PROBE, because that does not look like
a missing write at all** — the tree is in a state you deliberately created and
have already mentally undone. Measured 2026-08-21: the blocked `cp` left
`scrub.ts` carrying a probe mutation; the symptom — three tests failing in the
FULL suite while passing alone — read as cross-file pollution and cost two
wrong hypotheses. So **verify a restore rather than assuming it**, in the same
call: `cp <snap> <file> && grep -c '<a marker of the fixed state>' <file>` —
one command that converts a silent failure into an immediate `0`.

**Its next-worst signature is a STALE file from an earlier session**, since
paths like `/tmp/pr-body.md` are conventional and shared — the gate then
inspects that file and reports violations this session never wrote (measured
2026-08-21: four bare refs from a lane days earlier). If a gate names text you
do not recognise, check the file's mtime before hunting for the text. Give
body files a per-session name (the scratchpad directory plus a suffix), for
the same reason §5 gives probe files one.

**"All green" is the EXIT CODE, not the summary.** A run can report every test
passing and still exit non-zero, printing the two facts on ADJACENT lines with
opposite polarity: on 2026-08-20 a lane finished `Tests 14371 passed (14371)` /
`Type Errors  no errors` and exited **1**, with `Errors  20 errors` in between —
twenty type errors in the test file. Capture the rc explicitly
(`vp run test > /tmp/out 2>&1; rc=$?`) rather than reading the tail. The same
lane is why `typecheck:test` is listed separately in `/check` step 2:
`vp run typecheck` covers `tsconfig.json` (src + types) and NOT `**/*.test.ts`,
so "typecheck ✅" was reported truthfully while the errors sat in a file that
task never reads. For any diff touching `tests/**`, run `vp run typecheck:test`
and read ITS rc.

All green, then commit (conventional-commit; `fix:` for a user-visible provider /
deploy fix, `chore:` for `.claude/**` / tooling — the `commit-prefix-scope-gate`
hook blocks a `fix:`/`feat:` commit with no `src/**` change). The `check-gate` hook
requires the fresh markers or it blocks the commit. Push, and open the PR with
`Closes #<n>`.

## 7. If main advanced while you worked (parallel merges)

A peer agent merging its PRs moves `main` (+ a `chore(release)` bump). Your branch
is now behind and `git diff main..<branch>` shows **phantom removals** of the
peer's added lines — that is the stale-base artifact, NOT real deletions. Confirm
the TRUE diff and rebase:

```bash
git diff --stat $(git merge-base origin/main <branch>)..<branch>       # the real change
git -C .claude/worktrees/<branch> rebase origin/main                    # clean if disjoint
```

Re-run gates, `git push --force-with-lease`.

**Re-run the SUITE after the rebase, not just the gates — and rebuild first.**
A pre-rebase green attests to a tree that no longer exists: the rebase pulls in
every peer commit merged since the fork, including test files your run never
executed. Measured 2026-08-20 across three lanes: one was green before and RED
after — `dist/` staleness (the `version` test compares `node dist/cli.js
--version` against `package.json`, and the release bump that rode in with the
peer merges moved the latter), which is why the order is **rebuild, then run**:
a rebase crossing a `chore(release)` commit desynchronises them by
construction. Without re-running, all three lanes would have opened PRs on the
untested claim that the pre-rebase green still held.

**A clean merge is not evidence that there was no collision** — and the
collision does not have to be content-vs-content. Two lanes editing the SAME
file merge without a conflict whenever their hunks fall in disjoint SECTIONS,
so §3's one-lane-per-file rule fails **silently**. The second shape is a peer
PR adding a **repo-wide check** — a test globbing the tree, a new lint rule, a
scanner over every `.md` — which gains jurisdiction over content in files it
never touched: the collision is THEIR test against YOUR content, and neither
PR's CI exercises the pair (yours ran before their check existed, theirs
before your content did), so `main` can go red on a merge where both sides
were green (live instance: go-to-k/cdkd#1990's prose scanner vs a file that
took ten merges in one day). So when a peer merges, read WHAT it added, not
only which files it touched — then rebase and RUN its check over your own diff
before merging yours. After a merge that lands in a file another PR touched in
the same window, grep `main` for a marker string from EACH side before
believing both survived:

```bash
git fetch origin main
# Grep what LANDED, not your working copy: in a lane worktree the two differ, and a
# grep of <file> passes happily while main is missing the lines you are checking for.
git show origin/main:<file> | grep -cF "<a distinctive phrase from YOUR change>"
git show origin/main:<file> | grep -cF "<a distinctive phrase from THEIR change>"
```

Do NOT reach for `git pull` here. `pull.rebase` is unset in this repo, so in a lane
worktree on its feature branch it aborts on divergent branches, and configured the
other way it MERGES main into your branch — the opposite of the rebase prescribed
above, in a squash-only repo; in the shared main tree it fails outright on any
dirty file. `git fetch` + `git show` reads main without touching a working tree.

`-F` is load-bearing: prose markers are full of regex metacharacters, and without
it a marker silently fails to match and reports the false lost-content alarm this
check exists to prevent. Double quotes (not `-F`) handle apostrophes — a marker
containing a double quote needs different quoting again, so prefer a phrase with
neither. `grep -c` exits 1 on zero matches — the very case you are hunting — so
do not chain the two greps.

**Pick a marker that sits on ONE LINE of the merged file.** These files are
hard-wrapped prose and `grep` is line-based, so a verbatim phrase spanning a
wrap scores 0 — the same false alarm as a missing `-F`; and the wrap column
differs per repo, so a phrase that works in one sibling scores 0 in another
(measured twice on 2026-08-19 — once against go-to-k/cdk-local#530's own
merged text, once against this repo's copy of the paragraph above). Before
believing a 0, check the wrap:
`git show origin/main:<file> | grep -n "<one short word from the phrase>"`
prints the whole line.

Source YOUR marker from your own commit and THEIR marker from THEIR merge
commit
(`git show "$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid):<file>"`),
never from a draft you read earlier — a lane routinely rewords between draft
and merge, so a draft-sourced marker comes back 0 and reads as lost content
(measured against go-to-k/cdkd#2000). When one does come back 0, settle it
from your lane worktree with `diff <(git show origin/main:<file>) <file>`: the
lines YOUR commit removed should be exactly the ones you meant to replace.

Read the two counts asymmetrically: whichever lane merged LAST has its marker
read back out of what is now the tip, so that arm is tautological — two `1`s
are one real confirmation (the EARLIER-merged lane's) plus one tautology.
Context: go-to-k/cdkd#1984 / go-to-k/cdkd#1985 both rewrote SKILL.md and
merged 2m46s apart; both survived only because their hunks landed ~25 lines
apart — luck, not §3 holding.
