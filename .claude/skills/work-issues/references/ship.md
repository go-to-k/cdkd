<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 9. Ship: merge → pull → rebuild → cleanup

With subagent lanes, this stage is the PARENT's serialization point: grant one
merge-ready lane at a time its turn — resume that lane agent (SendMessage) to
run its named integ fixtures and merge while it holds the turn, or run
`/run-integ` and `gh pr merge` yourself FROM THAT LANE'S WORKTREE. The
worktree matters mechanically, not stylistically: merge-gate verdicts
(pr-review sha sentinel, verify-pr / integ markers) are computed against the
tree the command runs from, so a merge issued from the main tree consults the
WRONG store — measured 2026-08-28, when a fresh pr-review marker sat in the
lane worktree while the main tree's stale sentinel blocked the merge with a
misleading sha mismatch (go-to-k/cdkd#2363 records the cwd-race side of it).
Those sentinels are also GITIGNORED, so a fresh worktree has none at all and
`markgate set` on a sentinel-bound gate refuses there — `dead scope: include
matches nothing this gate can see ...; the digest would be a constant that
never goes stale` — which is the gate declining to record an empty set, not a
markgate fault. Write the sentinel first (`/run-integ` step 11), never bypass.
Never two lanes' integs or merges concurrently; everything after the merge in
this section (pull → rebuild → cleanup) stays with the parent.

**A `SendMessage` that answers "queued" has NOT been delivered — read the reply
every time.** The tool returns one of two things: `Resuming agent ...`, meaning
the agent was stopped and has been RESTARTED to receive it, or `Message queued
for delivery at its next tool round`, which delivers only if something ELSE
resumes the agent. A lane that ended its turn on "merge-ready" is stopped by
definition, so the turn-grant it is waiting for lands in a queue nothing will
drain — and both sides then look identical to a party waiting on the other.
Measured 2026-09-02 (go-to-k/cdkd#2417): a lane sat idle about five minutes
mid-pipeline that way, surfaced only by the maintainer asking why nothing was
running, and an immediate re-send answered `Resuming agent` and unstuck it. So
after any send: if the answer was "queued", either confirm the agent actually
runs (its next completion notification) or re-send at once. A queued message is
never a granted turn.

**Before you watch CI, read the PR's merge state** (`/verify-pr` step 3): a PR
at `mergeable=CONFLICTING state=DIRTY` never fires CI at all, and
`gh pr checks --watch` on one blocks forever reporting "no checks reported". In
a fan-out run this is the likeliest PR state you will meet, because peer lanes
keep merging while yours sits open (2026-08-19: both remaining lanes went
CONFLICTING on `docs/changelog-cdkd.md` between `gh pr create` and the first
check). Rebase, force-push, and CI fires within ~30s.

**"CI fires within ~30s" is the push-to-queue latency, not the time to a
verdict, and the difference decides whether you can merge at all.** Measured
2026-08-26: checks first APPEARED 10-13 minutes after a push (runner-queue
backlog) and settled 6-10 minutes after that — with active peer lanes that
total is LONGER than the interval between merges to `main`, so a lane that runs
its post-rebase suite first and pushes second arrives at green already
CONFLICTING again (one PR took FOUR rebase cycles that way). **PUSH FIRST, then
run the post-rebase suite while the queue drains** — the two are independent,
and the suite still gates the merge. Then poll tightly and merge the moment it
goes green.

**That applies to a re-push on an ALREADY-OPEN PR. For a PR that does not exist
yet, pushing the branch drains nothing** — `.github/workflows/ci.yml` is
`on: push: branches: [main]` / `pull_request: branches: [main]`, so a feature
branch push fires no workflow and the queue starts at `gh pr create` (measured
2026-08-27). For a NEW PR: finish the gates, create the PR, and only then do
other work while CI runs.

Two polling traps, both hit live. **"No pending checks" is not "checks
passed"** — a PR with ZERO checks satisfies it, which is exactly the
CONFLICTING state above, so an exit condition must require that checks EXIST
and that none is pending — and that it tests for the states `gh` actually
emits: `gh pr checks --json state` answers `IN_PROGRESS` / `QUEUED` /
`PENDING` / `SUCCESS` / `FAILURE` / `SKIPPED`, so a loop grepping only
`PENDING` exits on the FIRST poll with every check still in flight (measured
2026-08-28 on two PRs). Enumerate the non-terminal states, not the one you
remember. And `mergeable` is computed lazily: a `gh pr view` seconds after a
push returns `UNKNOWN UNKNOWN` — neither a pass nor a conflict; re-query. The
`ci-green-gate` hook refuses a merge on "no checks reported", so a wrong poll
costs a retry, not a bad merge.

**FLATTEN BEFORE YOU REBASE — this is the default step, not a remedy to reach
for once the conflicts start.** The changelog conflicts on nearly every
parallel-lane rebase, and a commit-by-commit rebase re-conflicts on it ONCE PER
COMMIT. The repo squash-merges, so flattening loses nothing:

```bash
git reset --soft "$(git merge-base origin/main HEAD)"   # one commit
git commit -m "<the squashed message>"
git rebase origin/main                                   # at most one conflict
```

Read as advice it gets skipped — at the moment you type `git rebase` you have
not hit a conflict yet — so it now has a HOOK behind it,
`.claude/hooks/flatten-before-rebase-gate.sh`, which refuses `git rebase
<upstream>` when the branch carries 2+ commits and touches one of the two
append-shaped files above. Five lanes across two runs bought it: on 2026-08-25
all three lanes of one run rebased un-flattened, every one stopped on
`docs/changelog-cdkd.md` at its FIRST commit with more queued behind, and each
was aborted, flattened and rebased again; on 2026-09-02 BOTH lanes of one
IN-PLACE run did it again (go-to-k/cdkd#2428 / go-to-k/cdkd#2450), where
flattening turned four conflicts into one. `CDKD_SKIP_FLATTEN_GATE=1` bypasses
it for a deliberate history-preserving rebase.

After resolving, verify BOTH sides survived rather than trusting the resolution
— for the changelog the cheapest form is a whole-file diff against main, which
needs no marker phrase and cannot be defeated by a hard wrap:

```bash
diff <(git show origin/main:docs/changelog-cdkd.md) docs/changelog-cdkd.md | grep '^<'
# nothing printed = every line main had is still there; the '^>' lines are yours
```
Resolve `docs/changelog-cdkd.md` by keeping BOTH entries, but never reflexively
keep-both a SHARED paragraph: `.claude/rules/code-layout.md` once conflicted on
one bullet both sides had edited, where main's version described this lane's
own issue as still open. A word-level diff of the two sides shows whether you
are looking at two additions or one contested sentence.

**Keep-both also DUPLICATES any entry your side carries that main already has**,
and the whole-file diff above does not catch it: the entry is present on both
sides, so the `^<` check stays empty while the file gains a second copy (a
flattened branch's changelog diff drags neighbouring entries into the conflict
hunk as context; measured 2026-08-26 on BOTH lanes of one run). Make the
resolution mechanical: take main's side whole, append only the lines of YOUR
side that main does not already contain, and assert the residual:

```bash
# after resolving, before `git rebase --continue`
PHRASE="<a phrase unique to the entry you kept>"
git show origin/main:docs/changelog-cdkd.md | grep -c "$PHRASE"   # must be 0
grep -c "$PHRASE" docs/changelog-cdkd.md                          # must be 1
diff <(git show origin/main:docs/changelog-cdkd.md) docs/changelog-cdkd.md | grep -c '^<'   # must be 0
```

**The first line is what makes the second mean anything.** A needle main
already carries can never read 1, so the count then passes or fails for
reasons that have nothing to do with your duplicate. Measured 2026-08-29: the
phrase first reached for was `CloudControlProvider`, and
`git show origin/main:docs/changelog-cdkd.md | grep -c CloudControlProvider`
returned **18** that day — the check was vacuous. Take the phrase from YOUR
entry's own subject and prove it absent from main's copy before counting. The
third line re-checks the paragraph above.

**A GENERATED file in a conflict is REGENERATED, never hand-merged.** Resolve
it however lets the generator run, then re-run the generator and commit ITS
output — a hand-merge produces a file matching NEITHER side, which the staleness
guard rejects with a diff nobody wrote and no generator can explain. Measured
2026-09-02 on go-to-k/cdkd#2441: `docs/cli-flag-coverage.md` conflicted on a
parallel-lane rebase, and resolve-to-upstream + regenerate was the only clean
answer.

**Take upstream's side whole only when the generator DERIVES the file from the
tree**, which is the usual case (the coverage matrices, the flag matrix) and the
one where your side carries no information the regenerate cannot recompute. The
integ ledger is the exception, and the paragraph below is about exactly that:
its rows record real-AWS RUNS, so upstream-whole would silently drop this lane's
own row — there it is keep-both, then normalize.

**And know what the generator's INPUT actually is — it is wider than the
artifact suggests.** The same PR went red having added no flag and touched no
CLI option declaration: adding a `cdkd list --verbose` assertion to
`tests/integration/local-invoke/verify.sh` was enough, because the FIXTURE TREE
is an input to `docs/_generated/cli-flag-coverage.json` alongside
`src/cli/options.ts`. Regenerate in the same commit as the fixture edit, or CI
reports the staleness two steps away from its cause.

**The integ ledger is the OTHER generated file a parallel-lane rebase merges,
and it fails in a different shape:** keeping both sides yields two rows for
the SAME test, which `docs/_generated/integ-last-run.tsv`'s one-row-per-test
invariant forbids and CI's `integ-last-run ledger is normalized` step rejects.
Re-run `vp run integ-ledger-normalize` after any rebase that touched it **and
commit the rewrite before pushing** — measured 2026-08-29, the normalizer ran
but its output was never committed and the PR went red. Confirm with `git
status --porcelain -- docs/_generated/`, never with the normalizer's own
output: a grep over a check log that keeps only error lines reports a dirty
tree as clean.

```bash
gh pr merge <n> -R <owner>/<repo> --squash --delete-branch   # squash is the only method here
```

**`-R` is not optional in a run that touches more than one repo.** Without it
`gh` infers the repo from the CWD, and a cwd persists across Bash calls — so a
merge issued after any earlier `cd` into a sibling checkout targets THAT repo.
Measured 2026-09-02: `gh pr merge 2432` ran against cdk-local because a marker
check had left the shell there, and it failed only because no PR 2432 existed
in that repo. Had one existed, the wrong PR would have merged. The error it
gives is `Could not resolve to a PullRequest with the number of <n>`, which
reads as a GitHub or permissions problem and sends you to the wrong diagnosis
entirely. Pass `-R` on EVERY `gh` call in a multi-repo run — `pr view`,
`pr checks` and `issue comment` mis-target just as silently, they just fail
less loudly.

(**`--delete-branch` prints a bare `fatal:` line and the merge SUCCEEDED
anyway — read it as the expected artifact, not a failed merge.** Run from the
PR's own worktree, `gh` deletes the remote branch, then cannot check out the
default branch to delete the local one:
`failed to run git: fatal: 'main' is already used by worktree at '<main tree>'`.
Measured twice 2026-08-21 (go-to-k/cdkd#2144, go-to-k/cdkd#2145): both merged
and NOTHING in the output says so. Confirm with `gh pr view <N> --json state`
before reacting — re-running the merge blocks on a gate for an already-merged
PR and reads as a second failure. `git worktree remove` deletes the worktree,
never the branch, so finish with an explicit `git branch -D <branch>`. It has
to be `-D`: the repo squash-merges, so the branch tip is never an ancestor of
`main` and `-d` refuses it as "not fully merged" — the expected squash
artifact, not a warning that the work is unmerged; confirm MERGED first and
the `-D` is safe. Measured 2026-08-19: a dozen stale merged local branches had
been left behind by believing otherwise.) Merge each verified PR. If a later
PR is behind, GitHub still merges it when the files are disjoint — but
file-disjointness is not the whole test: a peer that added a repo-wide check
has jurisdiction over your content too (§7).

**Merge order is not arbitrary. A lane that fixes a full-suite flake goes
FIRST**, and every other lane rebases onto it — until then each lane's
`/check` and `/verify-pr` roll the same dice. The corollary bites the other
way: a PR's CI runs on the MERGE ref, so a red check can come from a PEER's
just-merged content your local green never saw — the fix is `git fetch` +
rebase + re-run, not distrusting the peer's new test (go-to-k/cdk-local#524 vs
go-to-k/cdk-local#520; the flake case is go-to-k/cdk-local#509 hitting the
go-to-k/cdk-local#515 timeout, 2026-08-19).

**When the failing check is a CUMULATIVE BUDGET, the number CI reports is not
the number your branch holds, and rebasing is not enough to see it.** A byte
cap, a corpus total, a count-of-files fence — anything whose verdict is a SUM
over the tree — is evaluated on the MERGE RESULT, so a peer who grows the same
file moves your verdict without touching your diff (measured 2026-08-26 on the
go-to-k/cdkd#2236 lane: local inside the band, CI red — peer go-to-k/cdkd#2229
had merged mid-review and added 3,343 B to the same file; trimming to the
LOCAL number would have stayed red on every push). Measure what the merge
produces — `git merge-tree HEAD origin/main` gives it without touching the
working tree (an actual `git merge` can itself be refused by a gate whose
scope the incoming range touches). Then say the resulting HEADROOM out loud in
the report — it tells the next lane whether its own addition will red the same
fence.

**For the `.claude/rules` corpus specifically this is now MECHANICAL, and the
reason is worth carrying: the paragraph above already said all of this and a
run still hit the collision by hand** (2026-08-27: two lanes of ONE run
measured 899,843 B and 899,902 B against a 900,000 B cap, both green, merging
to 900,025 B — neither branch's CI could see it).
`tests/unit/scripts/rule-file-payload.test.ts` now projects the merge
(`origin/main`'s corpus plus THIS branch's delta against its own merge base)
and fails on the projected number; on a rebased branch the assertion is a
no-op, on a stale one it is the only thing that sees the collision. **A
cumulative budget in any OTHER file still needs the hand measurement above** —
the fence knows about that one corpus, not the shape.

**And when you hand the trim to someone else, check the target is REACHABLE
from that lane's own bytes before naming it.** The lane can only spend what it
added; the floor is `merge-base size`, not zero, and a target below that floor
is an instruction to cut somebody else's entry (measured 2026-08-26: a
"≤ 118,000 B" target dispatched when the merge base ALONE was 118,586 B — the
agent refused and reported the real ceiling instead of quietly cutting a
neighbour). Do the subtraction when you WRITE the target:
`cap - merge_base_size` is the most headroom any single lane can leave, and if
that number is small the finding is that the FILE is full — a different issue
from this lane's diff.

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
git checkout main && git pull origin main    # bring the merges local
```

IN-PLACE — run THIS block INSTEAD, never both: `main` is checked out in the main
tree, so a `checkout main` here fails with "already used by worktree at ...".
Never leave your own tree; pull the main checkout through `-C`. `MAIN` is
derived HERE and not borrowed from a neighbouring block — each fenced block is
its own Bash call and its own shell, so a variable assigned in another one is
empty here:

```bash
# The main checkout is always the FIRST row of `git worktree list`.
MAIN=$(git worktree list --porcelain | awk 'NR==1{print substr($0,10)}')
git -C "$MAIN" pull origin main
```

That `git pull` fails outright if the shared main tree is dirty, which it
routinely is when another lane's write lands there (§7). It fails loudly — read
the error, and do NOT restore the offending path: it is another session's
uncommitted work, and `dirty-path-restore-gate` refuses it.

**Release** is BATCHED (release-please via `.github/workflows/release.yml`) —
merging a `fix:` / `feat:` commit to `main` publishes NOTHING by itself: it
only creates/updates the standing `chore(release): <ver>` release PR. The npm
release happens when the maintainer merges that release PR, so do NOT poll for
a version bump after an ordinary merge, and never merge the release PR unless
the user asked for a release. Confirm the release PR picked up the merge
instead:

```bash
gh pr list --state open --search "chore(release) in:title"   # the standing release PR
```

cdkd is used from other projects via a global `pnpm link --global` that points at
this repo's `dist/cli.js` (see `/use-cdkd`), so **a fresh `vp run build` on updated
`main` is all that's needed for the linked binary to pick up the fix** — no
`npm i -g` reinstall.

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
vp run build
```

IN-PLACE — run THIS block INSTEAD, never both. It builds the MAIN checkout: the
global link points at ITS `dist/cli.js`, so building this workspace's leaves the
user on the old binary while every log says the fix shipped. Re-derive `MAIN`
inside this block — borrowing it from the earlier one gives an EMPTY variable in
a fresh shell, and an empty `cd` does not fail in the way you would want.
Measured 2026-08-31: bash REFUSES `cd ""` (rc=1, `cd: null directory`), so the
`&&` short-circuits and NOTHING is built at all, while zsh accepts it (rc=0) and
builds whatever tree the shell happens to be standing in. The end state is the
same one that matters — the globally linked `dist/` still holds the old build
while the log says the fix shipped — and the only difference is whether you get
a one-line complaint or a silently wrong build:

```bash
MAIN=$(git worktree list --porcelain | awk 'NR==1{print substr($0,10)}')
( cd "$MAIN" && vp run build )
```

**Remove every worktree YOU created** — and only those (a left-behind worktree is
the silent residue of this flow).

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
git worktree remove .claude/worktrees/<branch>   # --force if it refuses on artifacts
git worktree prune
git branch -D <branch>                           # -D, not -d (squash) - see §9 above
git worktree list                                # every worktree THIS run added is gone
git branch --list '<your prefix>*'               # ...and so is every branch it added
```

IN-PLACE — run THIS block INSTEAD, never both. **An IN-PLACE run created no
worktree, so it removes none**: it must not `git worktree remove` the tree it is
running in (that deletes its own cwd). Cleanup of the TREE belongs to whoever
created it — the outer tool or the operator — so the wrap SAYS that instead of
doing it, and the run ends with the tree still there. What it DOES owe is the
BRANCH: put back the one it found, delete the one it made. `<LAUNCH_BRANCH>` and
`<each branch this run created>` are SUBSTITUTION PLACEHOLDERS — the first from
the opening report, the second from your own record of what you branched — not
shell variables (`references/launch-mode.md` — a fresh Bash call is a fresh
shell, and an empty `git switch ""` is not the failure you want):

```bash
git show-ref --verify --quiet refs/heads/<LAUNCH_BRANCH> || echo 'gone -> use the fallback'
DIRTY=$(git status --porcelain)
[ -z "$DIRTY" ] || echo 'dirty -> commit or stash first, then re-run this block'
[ -z "$DIRTY" ] \
  && git switch --no-guess <LAUNCH_BRANCH> \
  && git branch -D <each branch this run created>  # AS-IS: no pull, no rebase, no fast-forward
git branch --show-current      # must print <LAUNCH_BRANCH>
git branch --list '<your prefix>*'             # ...and every branch this run added is gone
```

`-D`, not `-d`: the repo squash-merges, so a merged lane branch is never an
ancestor of `main` and `-d` refuses it (§9 above). And the switch is AS-IS — no
pull, no rebase, no fast-forward — which is the whole point of the step.

**Three further details in that block are each load-bearing, and none is
obvious.**

`--no-guess` on the switch. Plain `git switch <name>` DWIMs: with the branch gone
LOCALLY but still present on `origin`, it CREATES it from the remote and reports
success (measured: `Switched to a new branch`, rc=0, tracking set). That
re-creates the outer tool's branch at ORIGIN's tip — an ADJUST, which the rule
below forbids — and it does so on exactly the path that was supposed to fall
through to the fallback. `--no-guess` makes the missing branch an error instead.

The dirty-tree check is a TEST, and it is the FIRST link of the chain rather
than a line of its own — with the outcome ANNOUNCED on the line above it,
because a chain that simply stops produces no output at all. Making the test the
chain head fixed one problem and introduced another: a dirty tree used to say
`exit 1`, and silently doing nothing is a worse answer than either, one line
below the `|| echo` that exists to keep the neighbouring command
self-describing. `git status --porcelain` exits 0 whether the tree is
dirty or clean, so `&&` cannot carry ITS verdict — the guard has to read the
OUTPUT, which is what `[ -z ... ]` does. But having read it, the result must
gate what follows: a reader copies a line, not its intent, and an unchained
guard is one someone runs and then continues past. Left ungated this is the
worst failure in the section — the dirt lands on the outer tool's branch AND
the `-D` removes the only branches holding this run's commits.

`--quiet` on the `show-ref`, with an explicit `|| echo`. Without it a missing
branch prints `fatal: 'refs/heads/X' - not a valid ref` and exits 128, so on the
merged stream an agent actually reads, "no output" is not the signal — the
`|| echo` names the outcome instead of leaving it to be inferred.

**The `&&` is load-bearing, not style.** Unchained, a FAILED switch still runs
the `-D`: git refuses to delete only the branch that is CHECKED OUT, so every
other branch this run created — the §10-d retro branch among them — is deleted
while the tree stays on the lane branch it was supposed to leave. That is
strictly worse than not cleaning up at all, because the tree now looks
half-restored and the branch that would let you retry is gone.

`git status` runs FIRST because `git switch` carries uncommitted changes across
to the branch you land on — checking afterwards reports a clean-looking tree only
because the dirt moved with you, onto the outer tool's branch. And the delete is
PLURAL: §10-d takes a retro branch in this same tree, so by the time this runs
there are usually two. Confirm each one's PR reads `MERGED` first
(`gh pr view <N> --json state`) — `-D` is unconditional and recoverable only
through the reflog.

Fallback — run THIS block INSTEAD of the one above, never both. It applies ONLY
when `LAUNCH_BRANCH` was empty at probe time (the run was launched detached) or
the branch is now gone; never as the default. Running both leaves the tree
DETACHED, which is the end state this whole section exists to remove, and only
the second command errors — after the detach has already happened. The
`show-ref` line in the block above is what decides between the two arms, so read
its answer rather than deciding from memory:

```bash
git fetch origin \
  && git switch --detach origin/main \
  && git branch -D <each branch this run created>
```

Chained end to end for the same reason, plus one of its own: an unchained
`switch --detach` after a failed `fetch` detaches at a STALE `origin/main`. No
`--no-guess` is needed here — `--detach` takes a commit-ish, so there is no
branch name for git to guess at.

**Three end states, and only one of them is quiet.** Staying on the lane branch
leaves a squash-merged tip that the unmerged-lane Stop hook warns about on EVERY
turn (its tip is never an ancestor of `main` — the same squash artifact that
forces `-D` above). Detaching silences that, and was this step's recommendation
until 2026-09-02 — but it is VISIBLE-SURPRISING in the outer tool's UI, which
created the workspace ON a branch and displays the detached state prominently;
the maintainer flagged it live. `LAUNCH_BRANCH` restored is both: it sits at whatever tip the outer tool left,
and the workspace looks untouched. The Stop hook is then silent PROVIDED that tip
carries no commits of its own — true for a workspace branch the tool cut from
`main` and never committed to, which is the ordinary case, and checkable with
`git rev-list --count origin/main..<LAUNCH_BRANCH>`. If that count is non-zero the
branch was already a lane before this run touched it: restore it anyway (it is
still not yours to move) and say so in the wrap, because the warning you then see
is about the outer tool's work, not yours.

Concretely, and stated so the fence has prose to permit: never `git pull` into
`<LAUNCH_BRANCH>`, never `git merge --ff-only origin/main` onto it, never
`git rebase <LAUNCH_BRANCH>`, and never `git branch -D <LAUNCH_BRANCH>`. The
branch is not yours to move, and it is not yours to remove.

**AS-IS is the whole rule: RESTORE, never ADJUST.** The first draft of this step
fast-forwarded `LAUNCH_BRANCH` to `origin/main` on the way back, so it would not
be left "stale"; that clause is WITHDRAWN. The tree and the branch are the outer
tool's artifacts and this run's job is to leave them exactly as it found them —
a fast-forward is an edit to somebody else's branch, made for the convenience of
a run that is on its way out, and "it was only a fast-forward" is precisely the
reasoning that produced the detached HEAD this rule replaces. If the branch is
behind, that is the tool's business.

**This step runs LAST, not per-lane.** §10 takes its retro branch in this same
tree, so restoring here and branching again in §10-d would just undo itself:
IN-PLACE, do the merge in §9 and come back for the restore once the retro PR has
merged. `--delete-branch` on each merge removes the branch on BOTH sides, which is fine
for a LANE branch and is the whole reason §5 refuses to put the lane on
`LAUNCH_BRANCH`. Do not lean on its local half here: when run from the PR's own worktree, `gh`
cannot check out the default branch to complete the local deletion (see the
`fatal:` note above), so the explicit `git branch -D` stays required.

The closing check is "every worktree THIS run added is gone", **never "only the
main checkout remains"** — that phrasing points the run at a peer's live lane.
`git worktree list` cannot say whose a worktree is, and a tip already on `main`
is not evidence of a finished lane: a worktree branched from `origin/main`
carries that exact tip until its first commit. Before removing one you do not
recognise, identify its owner — the DIRECT signal first, because
`worktree-owner-gate.sh` records one:

```bash
cat "$(git -C <worktree> rev-parse --git-dir)/session-owner"  # "<session id> <UTC claim>"
git -C <worktree> status --porcelain                          # uncommitted work = live
gh pr list --state all --head <its branch>                    # read the STATE column
# The probe that works on a lane too young to have published anything else: a
# worktree is NAMED for the issue its lane took, and §4 makes the claim comment the
# first thing a lane that TOOK an issue writes. Read the WHOLE thread rather than
# §4's filtered form — a lane that stood down retracts in a comment no
# "Working on this" filter matches, so a matched claim can already be withdrawn.
gh issue view <the number in the worktree's name> --json comments \
  --jq '.comments[] | "\(.createdAt)\t\(.author.login)\t\(.body[0:80])"'
# No number in the name (`chore/work-issues-retro-20260819`)? Then there is no
# pointer — fall back to the probes above, and leave the worktree if they disagree.
```

Read every one of those as evidence of LIFE only — none can establish absence.
An **absent** `session-owner` is NO signal, never "unowned": the gate claims a
worktree only on `Edit` / `Write` / `NotebookEdit` and fails open without a
session id, so a lane driven entirely through Bash never writes one (measured
2026-08-19 on two live lanes — why the issue-comment probe is in the block
above rather than a footnote). A **MERGED** PR is not proof of death either —
its owner may still be inside §9 or §10. And the stamp is CLAIM time, not last
activity, so an age past the gate's 12h TTL is equally what a long-running
live session looks like.

A claim younger than that TTL means the owner is **presumed LIVE** — never
infer that an owning session is dead, since a live session and a dead one
produce identical evidence (`.claude/rules/hooks.md`, and the 2026-08-10
trespass it records). When in doubt leave the worktree and say so in the wrap.
Live instance (2026-08-19): a worktree at `main`'s exact tip — no commits, no
pushed branch, no PR, every COMMITTED-state probe reading it as residue — was
a peer's live lane holding uncommitted edits under a 12-minute-old
`session-owner` claim; only the sentinel and §2's `status --porcelain` would
have named it.

Finally, comment the outcome on each issue if it was not auto-closed.
**RELEASE the claim on every issue that did NOT auto-close.** `--delete-branch`
has just deleted the branch your claim names, so what is left on the issue is a
lock pointing at nothing: the next session reads "Working on this in branch
<gone>" and either skips a free issue or has to prove you are finished. Derive
the population mechanically rather than from memory -- it is every issue this
run CLAIMED, minus the ones now CLOSED:

```bash
for n in <the issues you claimed>; do
  printf '#%s: ' "$n"; gh issue view "$n" --json state -q .state
done
```

Every `OPEN` in that list needs a release comment. **They are exactly the
partially-closed ones** -- a `Closes #N` PR auto-closes its issue and needs
nothing, while a lane that shipped part of an umbrella said `Refs` on purpose,
which auto-closes nothing. So the issues that keep a stale claim are the same
ones a future session is most likely to pick up, which is what makes this worth
a mechanical step rather than a habit.

Say three things in the comment, because a bare "released" makes the next
session re-derive what you already know: that the issue is now UNCLAIMED, what
the merged PR actually closed, and what remains WITH the reason it was left --
an unsettled trade-off and a missing design decision read very differently to
someone deciding whether to start. Carry forward anything expensive the lane
measured (a live arm it built, a population it derived, a family of bugs it
found), so the next lane inherits the evidence rather than the diagnosis.

A claim on an issue that DID auto-close needs nothing: a closed issue is not a
lock, and commenting on it only adds noise.

Do NOT
stop here: what the run taught you is still only in this session's context, so
go on to §10 — which also decides WHERE each lesson belongs (memory is the
weakest of the options there, not the default one).
