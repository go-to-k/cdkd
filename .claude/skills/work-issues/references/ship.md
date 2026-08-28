<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 9. Ship: merge → pull → release → rebuild → cleanup

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
Never two lanes' integs or merges concurrently; everything after the merge in
this section (pull → release → rebuild → cleanup) stays with the parent.

**Before you watch CI, read the PR's merge state** — `/verify-pr` step 3 already
says why, and the failure mode is silent, so it is worth the pointer here: a PR
at `mergeable=CONFLICTING state=DIRTY` never fires CI at all, and
`gh pr checks --watch` on one blocks forever reporting "no checks reported". In a
fan-out run this is the likeliest PR state you will meet, because peer lanes keep
merging while yours sits open — on 2026-08-19 both remaining lanes went
CONFLICTING on `docs/changelog-cdkd.md` between `gh pr create` and the first
check. Rebase, force-push, and CI fires within ~30s.

**"CI fires within ~30s" is the push-to-queue latency, not the time to a
verdict, and the difference decides whether you can merge at all.** Measured
2026-08-26: checks first APPEARED 10-13 minutes after a push (a runner-queue
backlog, with a peer's PR getting runs immediately in the same window), and
settled 6-10 minutes after that. With active peer lanes that total is LONGER
than the interval between merges to `main`, so a lane that runs its post-rebase
suite first and pushes second loses the race by construction — it arrives at
green already CONFLICTING again. One PR took FOUR rebase cycles that way.
**PUSH FIRST, then run the post-rebase suite while the queue drains**; the two
are independent, and the suite still gates the merge. Then poll tightly and
merge the moment it goes green.

**That applies to a re-push on an ALREADY-OPEN PR. For a PR that does not exist
yet, pushing the branch drains nothing** — measured 2026-08-27, `.github/workflows/ci.yml`
is `on: push: branches: [main]` / `pull_request: branches: [main]`, so a feature
branch push fires no workflow at all and the queue starts at `gh pr create`. A
run that pushes early expecting to overlap the wait simply waits later instead.
The order that helps for a NEW PR is to finish the gates, create the PR, and
only then do other work while CI runs.

Two traps in the polling itself, both hit on that run. **"No pending checks" is
not "checks passed"** — a PR with ZERO checks satisfies it, which is exactly the
CONFLICTING state above, so an exit condition must require that checks EXIST and
that none is pending — and that it tests for the states `gh` actually emits.
`gh pr checks --json state` answers `IN_PROGRESS` / `QUEUED` / `PENDING` /
`SUCCESS` / `FAILURE` / `SKIPPED`, so a loop whose "still running" test greps
only `PENDING` exits on the FIRST poll with every check still in flight, and
reports settled. Measured 2026-08-28 on two PRs, both mid-run. Enumerate the
non-terminal states, not the one you remember. And `mergeable` is computed
lazily: a `gh pr view` seconds after a push returns `UNKNOWN UNKNOWN`, which is
neither a pass nor a conflict. Re-query rather than reading it as either. The `ci-green-gate` hook refuses a
merge on "no checks reported" for the same reason, so a wrong poll costs a
retry, not a bad merge.

**FLATTEN BEFORE YOU REBASE — this is the default step, not a remedy to reach
for once the conflicts start.** The changelog conflicts on nearly every
parallel-lane rebase, and a commit-by-commit rebase re-conflicts on it ONCE PER
COMMIT. Since the repo squash-merges, flattening loses nothing:

```bash
git reset --soft "$(git merge-base origin/main HEAD)"   # one commit
git commit -m "<the squashed message>"
git rebase origin/main                                   # at most one conflict
```

Read as advice rather than as a step, it gets skipped, because at the moment you
type `git rebase` you have not hit a conflict yet and the multi-commit history
still looks worth keeping — it is not, since the merge squashes it anyway. On
2026-08-25 all three lanes of one run were rebased un-flattened first, and every
one of them stopped on `docs/changelog-cdkd.md` at its FIRST commit, with four
to six more queued behind it; each was then aborted, flattened and rebased
again, which is the same work done twice. Flatten first and the conflict is one
resolution per lane.

After resolving, verify BOTH sides survived rather than trusting the resolution
— for the changelog the cheapest form is a whole-file diff against main, which
needs no marker phrase and cannot be defeated by a hard wrap:

```bash
diff <(git show origin/main:docs/changelog-cdkd.md) docs/changelog-cdkd.md | grep '^<'
# nothing printed = every line main had is still there; the '^>' lines are yours
```
Resolve `docs/changelog-cdkd.md` by keeping BOTH entries, but never reflexively
keep-both a SHARED paragraph: `.claude/rules/code-layout.md` conflicted on one
bullet that both sides had edited, where main's version described this lane's own
issue as still open. A word-level diff of the two sides is what shows whether you
are looking at two additions or one contested sentence.

**Keep-both also DUPLICATES any entry your side carries that main already has**,
and the whole-file diff above does not catch it: the entry is present on both
sides, so nothing goes missing and the `^<` check stays empty while the file
gains a second copy. It happens because a flattened branch's changelog diff
drags neighbouring entries into the conflict hunk as context. Measured
2026-08-26: it fired on BOTH lanes of one run, duplicating an unrelated
already-merged entry each time. Make the resolution mechanical rather than
eyeballed — take main's side whole, then append only the lines of YOUR side that
main does not already contain, and assert the residual:

```bash
# after resolving, before `git rebase --continue`
grep -c "<a distinctive phrase from the entry you kept>" docs/changelog-cdkd.md   # must be 1
diff <(git show origin/main:docs/changelog-cdkd.md) docs/changelog-cdkd.md | grep -c '^<'   # must be 0
```

The first line is the one that matters; the second only re-checks what the
paragraph above already asks for.

```bash
gh pr merge <n> --squash --delete-branch     # squash is the repo's only method
```

(**`--delete-branch` prints a bare `fatal:` line and the merge SUCCEEDED anyway —
read it as the expected artifact, not a failed merge.** Run from the PR's own
worktree, as this flow requires, `gh` deletes the remote branch, then tries to
check out the default branch to delete the local one and cannot:
`failed to run git: fatal: 'main' is already used by worktree at '<main tree>'`.
Measured twice on 2026-08-21 (PRs go-to-k/cdkd#2144 and go-to-k/cdkd#2145): both
merged, and NOTHING in the output says so. Confirm with
`gh pr view <N> --json state` before reacting; the natural reaction — re-running
the merge — then blocks on a gate for an already-merged PR and reads as a second
failure. The worktree removal below does NOT then clear it:
`git worktree remove` deletes the worktree, never the branch, so the local ref
survives both steps and you must finish with an explicit `git branch -D <branch>`.
It has to be `-D`: this repo squash-merges, so the branch tip is never an ancestor of
`main` and `-d` refuses it as "not fully merged" (verified 2026-08-19 — git's own hint
is to use `-D`). Read that refusal as the expected squash artifact, not as a warning
that the work is unmerged; confirm the PR is MERGED first, and the `-D` is safe.
Measured 2026-08-19, after this sentence had claimed otherwise for months: the repo
held a dozen stale local branches — `chore/1987-mirror-duplicate-detection`,
`chore/1973-work-issues-no-src-tier`, `chore/1593-work-issues-author-association`
and more — every one merged, every worktree long gone, every branch left behind by
believing this line.) Merge each verified PR. If a later PR is behind, GitHub still
merges it when the files are disjoint — but file-disjointness is not the whole test:
a peer that added a repo-wide check has jurisdiction over your content too, so read
§7 before treating a green mergeable state as sufficient.

**Merge order is not arbitrary. A lane that fixes a full-suite flake goes FIRST**,
and every other lane rebases onto it — until then each lane's `/check` and
`/verify-pr` roll the same dice, and a red run tells you nothing about your own
change. Its corollary bites in the other direction: a PR's CI runs on the MERGE ref,
so a red check can come from a PEER's just-merged content that your local green
never saw. The fix is `git fetch` + rebase + re-run, not distrusting the peer's new
test (go-to-k/cdk-local#524 vs go-to-k/cdk-local#520, 2026-08-19; the flake case is
go-to-k/cdk-local#509 hitting the go-to-k/cdk-local#515 timeout 2/2 in its worktree,
green on the first post-merge, post-rebase run).

**When the failing check is a CUMULATIVE BUDGET, the number CI reports is not the
number your branch holds, and rebasing is not enough to see it.** A byte cap, a
corpus total, a count-of-files fence — anything whose verdict is a SUM over the tree
— is evaluated on the MERGE RESULT, so a peer who grows the same file moves your
verdict without touching your diff. On 2026-08-26 the go-to-k/cdkd#2236 lane measured
`.claude/rules/hooks.md` at 120,454 B on its branch, comfortably inside a
95,000-120,000 B band, while CI reported **123,797 B** and stayed red: peer PR
go-to-k/cdkd#2229 had merged mid-review and added 3,343 B to that same file. Trimming
to fit the LOCAL number would have landed inside the band and remained red on every
push. Measure what the merge produces — `git merge-tree HEAD origin/main` gives it
without touching the working tree, which matters because an actual `git merge` can
itself be refused by a gate whose scope the incoming range touches. Then say the
resulting HEADROOM out loud in the report, because it is what tells the next lane
whether its own addition will red the same fence.

**For the `.claude/rules` corpus specifically this is now MECHANICAL, and the reason it had to become mechanical is worth carrying: the paragraph above already said all of this and a run still hit the collision by hand.** On 2026-08-27 two lanes of ONE `/work-issues` run measured 899,843 B and 899,902 B against a 900,000 B cap, both green, merging to 900,025 B. Neither branch's CI could see it, and the second to merge would have been blamed for a budget the first one spent. `tests/unit/scripts/rule-file-payload.test.ts` now projects the merge — `origin/main`'s corpus plus THIS branch's delta against its own merge base — and fails on the projected number rather than the working-tree one. On a rebased branch the two are equal and the assertion is a no-op; on a stale one it is the only thing that sees the collision. **A cumulative budget in any OTHER file still needs the hand measurement above** — the fence knows about that one corpus, not about the shape.

**And when you hand the trim to someone else, check the target is REACHABLE from
that lane's own bytes before naming it.** The lane can only spend what it added;
everything else in the file belongs to other lanes and is not its to cut. So the
floor is `merge-base size`, not zero, and a target below that floor is an
instruction to cut somebody else's entry — which is the one thing the same
paragraph forbids. Measured 2026-08-26: `.claude/rules/hooks.md` came to
122,724 B against a 120,000 B cap, a trim was dispatched with a target of
"≤ 118,000 B, i.e. at least 2,000 B of headroom", and that was arithmetically
impossible — the merge base ALONE was 118,586 B, so reverting the lane's entry
in full still lands 586 B above the target. The agent did the arithmetic,
refused, and reported the ceiling (1,414 B of possible headroom) instead of
quietly cutting a neighbour. Do that subtraction when you WRITE the target:
`cap - merge_base_size` is the most headroom any single lane can leave, and if
that number is small the finding is that the FILE is full, which is a different
issue from this lane's diff.

```bash
git checkout main && git pull origin main    # bring the merges local
```

That `git pull` fails outright if the shared main tree is dirty, which it routinely is
when another lane's write lands there (§7). It fails loudly rather than silently, so
read the error rather than working around it — and do NOT restore the offending path:
it is another session's uncommitted work, and `dirty-path-restore-gate` refuses it.

**Release** is automated (semantic-release via `.github/workflows/`) — merging a
`fix:` / `feat:` commit to `main` produces a `chore(release): <ver> [skip ci]` bump
commit on `main` a minute or two later. Poll for it:

```bash
git fetch origin && git log origin/main --oneline -3   # look for chore(release)
```

cdkd is used from other projects via a global `pnpm link --global` that points at
this repo's `dist/cli.js` (see `/use-cdkd`), so **a fresh `vp run build` on updated
`main` is all that's needed for the linked binary to pick up the fix** — no
`npm i -g` reinstall:

```bash
vp run build
```

**Remove every worktree YOU created** — and only those (a left-behind worktree is
the silent residue of this flow):

```bash
git worktree remove .claude/worktrees/<branch>   # --force if it refuses on artifacts
git worktree prune
git branch -D <branch>                           # -D, not -d (squash) - see §9 above
git worktree list                                # every worktree THIS run added is gone
git branch --list '<your prefix>*'               # ...and so is every branch it added
```

The closing check is "every worktree THIS run added is gone", **never "only the
main checkout remains"** — that phrasing points the run at a peer's live lane.
`git worktree list` cannot say whose a worktree is, and a tip already on `main` is
not evidence of a finished lane: a worktree branched from `origin/main` carries that
exact tip until its first commit. Before removing one you do not recognise, identify
its owner — here the DIRECT signal comes first, because `worktree-owner-gate.sh`
records one:

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

Read every one of those as evidence of LIFE only — none can establish absence. An
**absent** `session-owner` is NO signal, never "unowned": the gate claims a worktree
only on `Edit` / `Write` / `NotebookEdit` and fails open without a session id, so a
lane driven entirely through Bash never writes one. (Measured 2026-08-19: the lane
that wrote this paragraph had no sentinel while it was live, and so did the
`fix/2026-retry-early-termination` lane 80 seconds after it claimed — which is why
the issue-comment probe is in the block above rather than a footnote to it.)
A **MERGED** PR is not proof of death either — its owner may still be inside §9 or
§10. And the stamp is CLAIM time, not last activity, so an age past the gate's 12h
TTL is equally what a long-running live session looks like.

A claim younger than that TTL means the owner is **presumed LIVE** — and never infer
that an owning session is dead, since a live session and a dead one produce identical
evidence (`.claude/rules/hooks.md`, and the 2026-08-10 trespass it records). When in
doubt leave the worktree and say so in the wrap.

On 2026-08-19 this run met exactly that shape:
`.claude/worktrees/1987-mirror-duplicate-detection` sat at `ae283ee4`, identical to
`main`'s tip, with no commits of its own, no pushed branch and no PR — so every
COMMITTED-state probe read it as residue. It was a peer session's live lane, holding
uncommitted edits to this same file under a `session-owner` claim 12 minutes old.
Two things would have named it: the sentinel, and §2's `status --porcelain`, which
was added afterwards precisely because a lane's dirty tree is the one place its work
is visible before it commits.

Finally, comment the outcome on each issue if it was not auto-closed. Do NOT stop
here: what the run taught you is still only in this session's context, so go on to
§10 — which also decides WHERE each lesson belongs (memory is the weakest of the
options there, not the default one).

