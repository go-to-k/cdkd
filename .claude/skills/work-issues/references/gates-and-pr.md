<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 6. Gates + PR (per lane)

**Before the session's FIRST commit, prove the gates are ALIVE.** Registration is
not execution. This repo's gates have always fired — it wires its hooks with no
`if` at all — but both siblings spent a day with every gate registered and INERT
(go-to-k/cdk-real-drift#1801: an `if` holding `A or B` matches nothing), and the
failure is silent in the worst direction, since an ungated commit looks exactly
like one that passed. `/hooks` lists what is REGISTERED, so it cannot see this.
One command can:

```bash
git commit --dry-run -m "gate liveness probe"   # from the repo root, on main
```

Run it as YOUR OWN Bash tool call. PreToolUse hooks gate the agent's tool calls
and nothing else — the identical line typed by a human into a terminal bypasses
the hook system entirely, so it always looks "unblocked" and proves nothing. That
mistake was made while writing this rule.

`--dry-run` commits nothing whatever the tree looks like. Expected: `Blocked by
branch-gate` (the root is on `main`) or `Blocked by check-gate` (markers stale).
Git's ordinary output instead means the gates are not firing, and every gate step
below is then self-enforced: run each check by hand and say so in the report.


From inside the worktree, run the local quality checks and record the markers:

```
/check          # typecheck, lint, build, tests → sets the `check` marker
/check-docs      # only if the lane touched README.md / CLAUDE.md / docs/ / .claude/rules/**
```

**Run the SKILL; do not hand-roll its command list and set the marker yourself.**
The `check` marker attests that `/check` ran, so setting it after a private
sequence of `typecheck` / `lint` / `build` / `test` records something that did not
happen — and the gap is silent, because the commands you did run all pass. What
`/check` step 1 adds over that list is `vp check --fix` plus `vp run check`, which
is where Prettier lives. Measured 2026-08-27: a lane hand-rolled the list for
THREE consecutive rounds and `vp run format:check` was failing the whole time on a
line a constant rename had pushed past the width; it surfaced only when a reviewer
ran the CI command directly. The temptation is real and comes from this very
section — the cwd rule below makes invoking a skill feel less controllable than
typing the commands — so the resolution is to invoke the skill AND control the cwd,
never to substitute one for the other.

**`vp check --fix` WRITES, so `git commit` after it can commit a tree you did not
test.** `--fix` reformats the WORKING TREE; `git commit` (without `-a`) commits the
INDEX. Anything an agent staged before the fix ran is committed in its pre-format
shape while the reformatted bytes sit unstaged, so the suite you just ran and the
commit you just made are different trees — and the difference surfaces only as CI's
`format:check`, minutes later, on a diff that looks untouched. Run `git add -u` (or
re-stage the named files) after `--fix` and before the commit, and confirm with
`git status --porcelain` — **matching on `^ M` is not enough**: a file that is both
staged and reformatted shows as `MM`, which that pattern misses. Test for a
non-empty second column instead. Measured 2026-08-28: hit twice in one lane, and
the marker was innocent both times — it digests the working tree, so it matched
what was tested and not what was committed.

**Start every marker and gate command with an explicit `cd <worktree> &&`.** Both
skills say to run from "the repo root", which in this mandated worktree flow means
the WORKTREE's root, not the main checkout — and a shell cwd does not reliably
persist between tool calls, so the wrong tree is the default outcome rather than a
slip (the `bash cwd silent reset` gotcha below). The marker store is PER-WORKTREE
here: markgate writes under `$(git rev-parse --git-dir)`, which resolves to
`.git/worktrees/<name>` inside a linked worktree, so a marker recorded in the main
checkout never becomes visible from the lane at all. It does not record the wrong
content — it is simply absent, and the symptom is a `check-gate` refusal that reads
as "you never ran /check" seconds after you ran it. Measured 2026-08-19, one repo,
one moment: `markgate status` in the main checkout printed
`check  mismatch  22h36m ago  digest differs` while the same command in this lane's
worktree printed `check  no marker  -  (configured)`.

**A gated command carries no SIDE-EFFECTING preamble in its Bash call, and
"gated" means EVERY PreToolUse hook, not just this repo's markgate ones.** The
leading `cd <worktree> &&` above is fine — the gates resolve it themselves — but
nothing that WRITES may share the call. `check-gate`, `verify-pr-gate` and the
`integ-*` gates are PreToolUse hooks, so they judge the call BEFORE any of it
runs, and a denial aborts the whole string — and so do the global safety hooks
that have nothing to do with the merge flow. On 2026-08-21 a
`cp <snapshot> src/cli/commands/scrub.ts && python3 <<'EOF' … EOF` was refused by
the SECRET-FETCHING gate, because the heredoc quoted an SDK command name; the
restore never ran, and the file stayed mutated from the previous probe. Do not
reason about which hooks can fire — assume any call can be refused, and keep
writes in their own call.

**This paragraph is now enforced by `.claude/hooks/gated-command-preamble-gate.sh`,
because saying it twice did not work.** The rule above, with its three worked
examples, was in this file and had been read when a run on 2026-08-25 violated it
TWICE inside one lane — `mise exec -- markgate set docs && … && git commit -F …`
(both `set`s discarded, so the retry hit the same refusal and read as "the marker
will not stick"), then `cat > /tmp/commit-msg.txt <<'MSG' … MSG && git commit -F
/tmp/commit-msg.txt` (file never written; the retry failed with `could not read
log file`). Section 10-b's own rule applies: when a rule is ALREADY in the text
and gets violated anyway, that proves the sentence is not load-bearing, so
escalate rather than restate.

The gate blocks only preambles whose loss is SILENT — `markgate set`, a write
redirect, `cp` / `mv`. It deliberately still allows `cd <dir> &&` (required
above), reads, and `git add` (losing that one fails the commit LOUDLY with
"nothing to commit", so nothing is believed). A write AFTER the gated command is
also fine: it is that command's own output.

Three consequences, each seen live.
`markgate set check && markgate set docs && git commit …` is refused in full,
including the two `set`s that would have satisfied the gate; and a call whose
preamble has a side effect — `cat > body.md <<'EOF' … EOF` then `gh pr create
--body-file body.md` — leaves NO file behind when the gate refuses. Rebuilding the
retry with `>>` then appends to nothing and ships a fragment: go-to-k/cdk-local#525
opened carrying only its review section, with no `Closes` line, and silently lost
the issue auto-close. Write the body file in one call, run the gated command in the
next, and re-create rather than append after any refusal. And the restore case
above: a `cp` that never ran leaves the file exactly as your last probe left it.

**Its worst signature is a file left MID-PROBE, because that one does not look
like a missing write at all.** The absent-file and stale-file shapes below at
least point at the call that failed; a restore that silently did not happen
leaves the tree in a state you deliberately created earlier and have already
mentally undone. Measured 2026-08-21: the blocked `cp` above left `scrub.ts`
carrying a mutation from a completed probe, and the symptom was three tests
failing in the FULL suite while passing alone — which reads as cross-file
pollution, not as a missing restore. That misreading cost pairing test files,
instrumenting the classifier, and two wrong hypotheses before `grep` on the
mutated line settled it in one command.

So **verify a restore rather than assuming it**, in the same call that performs
it: `cp <snap> <file> && grep -c '<a marker of the fixed state>' <file>`. It is
one command, it converts a silent failure into an immediate `0`, and it is the
only thing that distinguishes "my probe is undone" from "my probe is undone as
far as I know". The same check is what caught a reviewer agent's restore
reverting live edits earlier in that run (§5) — there it was run deliberately
and worked; here it was skipped and did not.

**Its next-worst signature is a STALE file from an earlier
session**, since these paths are conventional (`/tmp/pr-body.md`) and shared.
The gate then inspects that file and reports violations from content this
session never wrote — measured 2026-08-21, when a `gh pr create` whose heredoc
had not run was refused for four bare `#N` refs belonging to a lane from days
earlier, none of which were in the draft on screen. If a gate names text you do
not recognise, check the file's mtime before hunting for the text. Give body
files a per-session name (the scratchpad directory, plus a suffix) for the same
reason §5 gives probe files one.

**"All green" is the EXIT CODE, not the summary.** A run can report every test
passing and still exit non-zero, and this repo's runner prints the two facts on
ADJACENT lines with opposite polarity: on 2026-08-20 a lane finished
`Tests 14371 passed (14371)` / `Type Errors  no errors` and exited **1**, with
`Errors  20 errors` in between — twenty type errors in the test file. Capture the
rc explicitly (`vp run test > /tmp/out 2>&1; rc=$?`) rather than reading the tail.

The same lane is why `typecheck:test` is listed separately in `/check` step 2:
`vp run typecheck` covers `tsconfig.json` (src + types) and NOT `**/*.test.ts`,
so that agent reported "typecheck ✅" twice, truthfully, while the errors sat in
a file that task never reads. For any diff touching `tests/**`, run
`vp run typecheck:test` and read ITS rc.

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
executed. Measured 2026-08-20 across three lanes: two were green before and after,
one was green before and RED after. That one turned out to be `dist/` staleness
rather than a peer's code (the `version` test compares `node dist/cli.js --version`
against `package.json`, and the release bump that rode in with the peer merges
moved the latter), which is exactly why the order is **rebuild, then run** — a
rebase that crosses a `chore(release)` commit desynchronises them by construction.
The lesson survives the benign diagnosis: without re-running, all three lanes would
have opened PRs on the untested claim that the pre-rebase green still held.

**A clean merge is not evidence that there was no collision** — and the collision
does not have to be content-vs-content. Two lanes editing the SAME file merge
without a conflict whenever their hunks fall in disjoint SECTIONS, so §3's
one-lane-per-file rule fails **silently** — unlike the rebase conflict above, which
at least announces itself. The second shape is a peer PR that adds a **repo-wide
check** — a test globbing the tree (`git ls-files`, a `readdirSync` over a
directory), a new lint rule, a scanner over every `.md` — which gains jurisdiction
over content in files it never touched. File-disjointness says nothing there,
because the collision is THEIR test against YOUR content, and neither PR's CI
exercises the pair: yours ran before their check existed, theirs ran before your
content did, so `main` can go red on a merge where both sides were green and
nothing conflicted. This run is the live instance: go-to-k/cdkd#1990's scanner
reads every line of prose in `.claude/skills/work-issues/SKILL.md`, and that one
file took ten merges on 2026-08-19 alone (go-to-k/cdkd#1969 through
go-to-k/cdkd#2035) — any of them opened before the scanner and merged after it
would have been judged by a check its own CI never ran. So when a peer merges, read
WHAT it added, not only which files it touched — then rebase and RUN its check over
your own diff before merging yours. After a merge that lands in a file another PR
touched in the same window, grep `main` for a marker string from EACH side before
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
other way it MERGES main into your branch — the opposite of the rebase prescribed at
the top of this section, in a squash-only repo; in the shared main tree it fails
outright on any dirty file. `git fetch` + `git show` reads main without touching a
working tree.

`-F` is load-bearing: prose markers are full of regex metacharacters (`.`, `[`, `*`),
and without it a marker silently fails to match and reports the false lost-content
alarm this whole check exists to prevent. It is the double quotes, not `-F`, that
handle apostrophes — and a marker containing a double quote needs different quoting
again, so prefer a phrase with neither. Remember `grep -c` exits 1 on zero matches —
the very case you are hunting — so do not chain the two greps.

**Pick a marker that sits on ONE LINE of the merged file.** These files are
hard-wrapped prose and `grep` is line-based, so a perfectly verbatim phrase that spans
a wrap scores 0 — the same false lost-content alarm a missing `-F` produces, from a
marker that is not wrong at all. Measured in cdk-local on 2026-08-19: a phrase lifted
verbatim from go-to-k/cdk-local#530's own merged text ("calibrate the detection rule
against the PRE-FIX broken tree") scored 0 / rc=1 against the merge commit, because
the merged file wraps after "calibrate the"; re-picked inside one line ("signature
literally") it scored 1. Re-measured against THIS repo's own copy of the paragraph
above the same day, because the wrap column differs per repo: the verbatim
"no collision. Two lanes editing the SAME file" scored 0 / rc=1, while
"SAME file merge without a conflict" — the very next words — scored 1 / rc=0. So
before believing a 0, check the wrap —
`git show origin/main:<file> | grep -n "<one short word from the phrase>"` prints the
whole line, which shows where it actually breaks.

Source YOUR marker from your own commit and THEIR marker from THEIR merge commit
(`git show "$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid):<file>"`), never
from a draft you read earlier — a lane routinely rewords a sentence between the draft
you saw and the commit it merges, so a marker lifted from the draft comes back 0 and
reads as lost content. When one does come back 0, settle it from your lane worktree
with `diff <(git show origin/main:<file>) <file>`: the lines YOUR commit removed
should be exactly the ones you meant to replace.

Read the two counts asymmetrically: whichever lane merged LAST has its marker read
back out of what is now the tip, so that arm is tautological. The load-bearing one is
the EARLIER-merged lane's marker — two `1`s are one real confirmation plus one
tautology, never two independent ones.

On 2026-08-19 go-to-k/cdkd#1984 and go-to-k/cdkd#1985 both rewrote
`.claude/skills/work-issues/SKILL.md` and merged 2m46s apart (04:27:29Z and
04:30:15Z). Both survived — not because §3 held, but because their hunks landed in
different sections, the closest pair about 25 lines apart. Design would have
serialized them into one lane; this was luck. The lane that added this paragraph then
ran the check against go-to-k/cdkd#2000 and got a false 0 from a draft-sourced marker,
which is why the sourcing rule above is stated.

