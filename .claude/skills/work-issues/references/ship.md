<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 9. Ship: merge → pull → rebuild → cleanup

With subagent lanes, this stage is the PARENT's serialization point: grant one
merge-ready lane at a time its turn — resume that lane agent (SendMessage) to
run its named integ fixtures and merge while it holds the turn, or run
`/run-integ` and `gh pr merge` yourself FROM THAT LANE'S WORKTREE. The
worktree matters mechanically: merge-gate verdicts (pr-review sha sentinel,
verify-pr / integ markers) are computed against the tree the command runs
from, so a merge from the main tree consults the WRONG store (measured
2026-08-28: a fresh marker in the lane worktree, the main tree's stale
sentinel blocking with a misleading sha mismatch; go-to-k/cdkd#2363). The
sentinels are GITIGNORED, so a fresh worktree has none and `markgate set` on a
sentinel-bound gate refuses (`dead scope: include matches nothing ...`) —
write the sentinel first (`/run-integ` step 11), never bypass. Ordering, not
just presence: REWRITING a sentinel after its marker is set stales that
marker, so a second broad run's `.markgate-broad-integ-test` write must be
followed by another `markgate set integ-broad`. Never two
lanes' integs or merges concurrently; everything after the merge stays with
the parent.

**A `SendMessage` that answers "queued" has NOT been delivered — read the
reply every time.** `Resuming agent ...` means the stopped agent was restarted
to receive it; `Message queued for delivery ...` delivers only if something
ELSE resumes the agent — and a lane that ended its turn "merge-ready" is
stopped by definition, so the turn-grant lands in a queue nothing drains
(go-to-k/cdkd#2417: a lane sat idle five minutes; an immediate re-send
answered `Resuming agent` and unstuck it). After any send answering "queued":
confirm the agent actually runs, or re-send at once.

**Before you watch CI, read the PR's merge state** (`/verify-pr` step 3): a PR
at `mergeable=CONFLICTING state=DIRTY` never fires CI. In a fan-out run this is
the likeliest PR state — peer lanes keep merging while yours sits open. Rebase,
force-push, and CI fires within ~30s. **`--watch` does not cover the wait for
checks to APPEAR** — with none reported it returns at once, so an `until` loop
wrapping it hot-spins through the whole tool timeout (10 min, measured
2026-09-05) and a plain `sleep` chain is refused by the harness. Poll
`gh pr checks <N> --json state` from `Monitor` or a backgrounded loop.

**~30s is push-to-queue latency, not time-to-verdict**: with runner backlog,
checks can APPEAR 10+ minutes after a push and settle minutes later — longer
than the interval between peer merges, so a lane that runs its post-rebase
suite first and pushes second arrives at green already CONFLICTING again (one
PR took FOUR rebase cycles). **PUSH FIRST, then run the post-rebase suite
while the queue drains.** For a PR that does not exist yet, pushing the branch
drains nothing — `ci.yml` fires on `pull_request`, so the queue starts at
`gh pr create`: finish the gates, create the PR, then do other work while CI
runs.

Two polling traps: **"no pending checks" is not "checks passed"** — a PR with
ZERO checks satisfies it (the CONFLICTING state above), and `gh pr checks
--json state` emits `IN_PROGRESS` / `QUEUED` / `PENDING` / `SUCCESS` /
`FAILURE` / `SKIPPED`, so a loop grepping only `PENDING` exits on the first
poll. Require that checks EXIST, and enumerate the non-terminal states. And
`mergeable` is computed lazily — seconds after a push it returns `UNKNOWN`;
re-query. (`ci-green-gate` refuses a merge on "no checks reported", so a wrong
poll costs a retry, not a bad merge.)

**FLATTEN BEFORE YOU REBASE — the default step, not a remedy.** The changelog
conflicts on nearly every parallel-lane rebase, and a commit-by-commit rebase
re-conflicts once per commit. The repo squash-merges, so flattening loses
nothing:

```bash
git reset --soft "$(git merge-base origin/main HEAD)"   # one commit
git commit -m "<the squashed message>"
git rebase origin/main                                   # at most one conflict
```

Enforced by `.claude/hooks/flatten-before-rebase-gate.sh` (refuses `git rebase
<upstream>` on a 2+-commit branch touching the append-shaped files; five lanes
across two runs bought it). `CDKD_SKIP_FLATTEN_GATE=1` for a deliberate
history-preserving rebase.

After resolving, verify BOTH sides survived:

```bash
diff <(git show origin/main:docs/changelog-cdkd.md) docs/changelog-cdkd.md | grep '^<'
# nothing printed = every line main had is still there; the '^>' lines are yours
```

Keep BOTH changelog entries, but never reflexively keep-both a SHARED
paragraph (main's copy of a bullet both sides edited once described this
lane's own issue as still open — word-level diff shows whether it is two
additions or one contested sentence). **Keep-both also DUPLICATES any entry
your side carries that main already has** — present on both sides, so the `^<`
check stays empty while the file gains a second copy. Make the resolution
mechanical: take main's side whole, append only your lines main lacks, and
assert the residual:

```bash
# after resolving, before `git rebase --continue`
PHRASE="<a phrase unique to the entry you kept>"
git show origin/main:docs/changelog-cdkd.md | grep -c "$PHRASE"   # must be 0
grep -c "$PHRASE" docs/changelog-cdkd.md                          # must be 1
diff <(git show origin/main:docs/changelog-cdkd.md) docs/changelog-cdkd.md | grep -c '^<'   # must be 0
```

**The first line is what makes the second mean anything** — a needle main
already carries can never read 1 (the first phrase reached for measured 18
hits in main's copy; the check was vacuous). Take the phrase from YOUR entry's
own subject.

**A GENERATED file in a conflict is REGENERATED, never hand-merged** — resolve
however lets the generator run, re-run it, commit ITS output (a hand-merge
matches neither side and the staleness guard rejects it; measured on
go-to-k/cdkd#2441). Take upstream's side whole only when the generator DERIVES
the file from the tree (coverage matrices, the flag matrix). The integ ledger
is the exception — its rows record real-AWS RUNS, so upstream-whole drops this
lane's own row: there it is keep-both, then normalize. **And know the
generator's INPUT is wider than the artifact suggests** — a fixture-tree edit
alone can stale `docs/cli-flag-coverage.md` + its
`docs/_generated/cli-flag-coverage.json`; regenerate in the same commit.
**The integ ledger `docs/_generated/integ-last-run.tsv`**: keep-both yields
two rows for one test, which CI's normalization step rejects — run
`vp run integ-ledger-normalize`
after any rebase touching it **and commit the rewrite before pushing**
(measured: the normalizer ran, its output was never committed, the PR went
red; confirm with `git status --porcelain -- docs/_generated/`).

```bash
gh pr merge <n> -R <owner>/<repo> --squash --delete-branch
```

**`-R` is not optional in a run that touches more than one repo.** Without it
`gh` infers the repo from the CWD, which persists across Bash calls — a merge
issued after an earlier `cd` into a sibling checkout targets THAT repo
(measured: `gh pr merge 2432` ran against cdk-local, failing only because no
such PR existed there; the error, `Could not resolve to a PullRequest`, reads
as a permissions problem). Pass `-R` on EVERY `gh` call in a multi-repo run —
`pr view`, `pr checks`, `issue comment` mis-target just as silently.

**`--delete-branch` from the PR's own worktree prints a bare `fatal: 'main' is
already used by worktree ...` and the merge SUCCEEDED anyway** — nothing in
the output says so. Confirm with `gh pr view <N> --json state` before
reacting; re-running the merge blocks on a gate and reads as a second failure.
`git worktree remove` deletes the worktree, never the branch, so finish with
an explicit `git branch -D <branch>` — `-D`, not `-d`: the repo
squash-merges, so the branch tip is never an ancestor of `main` and `-d`
refuses it as "not fully merged", the expected squash artifact. Confirm MERGED
first and the `-D` is safe.

**Merge order is not arbitrary: a lane that fixes a full-suite flake goes
FIRST**, and every other lane rebases onto it. The corollary: a PR's CI runs
on the MERGE ref, so a red check can come from a PEER's just-merged content
your local green never saw — the fix is fetch + rebase + re-run, not
distrusting the peer's new test.

**When the failing check is a CUMULATIVE BUDGET** (a byte cap, a corpus total
— any verdict that is a SUM over the tree), CI evaluates the MERGE RESULT, so
a peer growing the same file moves your verdict without touching your diff;
trimming to the LOCAL number stays red on every push. Measure what the merge
produces — `git merge-tree HEAD origin/main` — and say the resulting HEADROOM
in the report. For the `.claude/rules` corpus this is now mechanical
(`rule-file-payload.test.ts` projects the merge); any OTHER cumulative budget
still needs the hand measurement. **When you hand a trim to another lane,
check the target is REACHABLE from that lane's own bytes**: the floor is
`merge-base size`, not zero — a target below it is an instruction to cut
somebody else's entry (one dispatched target sat below the merge base alone;
the agent refused). `cap - merge_base_size` is the most headroom one lane can
leave.

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
git checkout main && git pull origin main    # bring the merges local
```

IN-PLACE — run THIS block INSTEAD, never both: `main` is checked out in the main
tree, so a `checkout main` here fails. Never leave your own tree; pull the main
checkout through `-C`. `MAIN` is derived HERE, not borrowed — each fenced block
is its own shell:

```bash
# The main checkout is always the FIRST row of `git worktree list`.
MAIN=$(git worktree list --porcelain | awk 'NR==1{print substr($0,10)}')
git -C "$MAIN" pull origin main
```

That `git pull` fails outright if the shared main tree is dirty, which it
routinely is when another lane's write lands there (§7). It fails loudly —
read the error, and do NOT restore the offending path: it is another session's
uncommitted work, and `dirty-path-restore-gate` refuses it.

**Release** is BATCHED (`CLAUDE.md` → "Release Flow" owns the rules: an
ordinary merge publishes nothing, and the standing release PR is never yours to
merge). This stage owes only the confirmation that it picked your merge up:

```bash
gh pr list --state open --search "chore(release) in:title"   # the standing release PR
```

cdkd is used from other projects via a global `pnpm link --global` pointing at
this repo's `dist/cli.js` (see `/use-cdkd`), so **a fresh `vp run build` on
updated `main` is all the linked binary needs**.

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
vp run build
```

IN-PLACE — run THIS block INSTEAD, never both. It builds the MAIN checkout:
the global link points at ITS `dist/cli.js`, so building this workspace's
leaves the user on the old binary while every log says the fix shipped.
Re-derive `MAIN` inside this block — borrowed, it is EMPTY in a fresh shell,
and bash refuses `cd ""` (nothing built) while zsh accepts it (builds whatever
tree the shell stands in); either way the linked `dist/` still holds the old
build:

```bash
MAIN=$(git worktree list --porcelain | awk 'NR==1{print substr($0,10)}')
( cd "$MAIN" && vp run build )
```

**Remove every worktree YOU created** — and only those.

MAIN-CHECKOUT (SKILL.md "Launch mode") — run THIS block, and not the next one:

```bash
git worktree remove .claude/worktrees/<branch>   # --force if it refuses on artifacts
git worktree prune
git branch -D <branch>                           # -D, not -d (squash) - see §9 above
git worktree list                                # every worktree THIS run added is gone
git branch --list '<your prefix>*'               # ...and so is every branch it added
```

IN-PLACE — run THIS block INSTEAD, never both. **An IN-PLACE run created no
worktree, so it removes none**: it must not `git worktree remove` the tree it
is running in. Cleanup of the TREE belongs to whoever created it — the wrap
SAYS that instead of doing it. What the run DOES owe is the BRANCH: put back
the one it found, delete the one it made. `<LAUNCH_BRANCH>` and `<each branch
this run created>` are SUBSTITUTION PLACEHOLDERS — the first from the opening
report, the second from your own record — not shell variables
(`references/launch-mode.md`; a fresh Bash call is a fresh shell, and an empty
`git switch ""` is not the failure you want):

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

Load-bearing details of that block:

- `--no-guess`: plain `git switch <name>` DWIMs — with the branch gone locally
  but present on `origin` it CREATES it from the remote at origin's tip and
  reports success, on exactly the path that should fall through to the
  fallback. `--no-guess` makes the missing branch an error.
- The dirty-tree check is a TEST and the FIRST link of the chain, outcome
  announced by the `|| echo` above it: `git status --porcelain` exits 0 either
  way, so the guard must read the OUTPUT, and having read it must gate what
  follows — a reader copies a line, not its intent. `git status` runs FIRST
  because `git switch` carries uncommitted changes ACROSS: checking afterwards
  reports clean only because the dirt moved with you, onto the outer tool's
  branch.
- **The `&&` chaining is load-bearing**: unchained, a FAILED switch still runs
  the `-D` — git refuses to delete only the CHECKED-OUT branch, so every other
  branch this run created (the §10-d retro branch among them) is deleted while
  the tree stays on the lane branch. Strictly worse than not cleaning up.
- The delete is PLURAL (§10-d takes a retro branch in this same tree). Confirm
  each one's PR reads `MERGED` first (`gh pr view <N> --json state`) — `-D` is
  unconditional.
- `--quiet` + `|| echo` on the `show-ref`: names the outcome instead of
  leaving "fatal: not a valid ref" to be inferred from a merged stream.

Fallback — run THIS block INSTEAD of the one above, never both. It applies ONLY
when `LAUNCH_BRANCH` was empty at probe time (the run was launched detached) or
the branch is now gone; never as the default. Running both leaves the tree
DETACHED — the end state this section exists to remove. The `show-ref` line in
the block above decides between the two arms; read its answer:

```bash
git fetch origin \
  && git switch --detach origin/main \
  && git branch -D <each branch this run created>
```

Chained end to end for the same reason, plus one of its own: an unchained
`switch --detach` after a failed `fetch` detaches at a STALE `origin/main`. No
`--no-guess` needed — `--detach` takes a commit-ish, so there is no branch
name to guess at.

**Three end states, and only one is quiet.** Staying on the lane branch leaves
a squash-merged tip the unmerged-lane Stop hook warns about every turn.
Detaching silences that but is VISIBLE-SURPRISING in the outer tool's UI
(flagged live by the maintainer). `LAUNCH_BRANCH` restored is both: the
workspace looks untouched, and the Stop hook is silent provided that tip
carries no commits of its own (checkable with
`git rev-list --count origin/main..<LAUNCH_BRANCH>`; non-zero means the branch
was already a lane — restore it anyway, it is still not yours to move, and say
in the wrap that the warning is about the outer tool's work).

Concretely, and stated so the fence has prose to permit: never `git pull` into
`<LAUNCH_BRANCH>`, never `git merge --ff-only origin/main` onto it, never
`git rebase <LAUNCH_BRANCH>`, and never `git branch -D <LAUNCH_BRANCH>`. The
branch is not yours to move, and it is not yours to remove.

**AS-IS is the whole rule: RESTORE, never ADJUST.** The first draft of this
step fast-forwarded `LAUNCH_BRANCH` to `origin/main` on the way back, so it
would not be left "stale"; that clause is WITHDRAWN. The tree and the branch
are the outer tool's artifacts and this run's job is to leave them exactly as
it found them. If the branch is behind, that is the tool's business.

**This step runs LAST, not per-lane.** §10 takes its retro branch in this same
tree, so restoring here and branching again in §10-d would just undo itself:
IN-PLACE, do the merge in §9 and come back for the restore once the retro PR
has merged. `--delete-branch` on each merge removes the branch on BOTH sides —
fine for a LANE branch, and the whole reason §5 refuses to put the lane on
`LAUNCH_BRANCH`. Do not lean on its local half (see the `fatal:` note above);
the explicit `git branch -D` stays required.

The closing check is "every worktree THIS run added is gone", **never "only
the main checkout remains"** — that phrasing points the run at a peer's live
lane. `git worktree list` cannot say whose a worktree is, and a tip already on
`main` is not evidence of a finished lane. Before removing one you do not
recognise, identify its owner — the DIRECT signal first:

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

Read every one as evidence of LIFE only — none can establish absence. An
**absent** `session-owner` is NO signal, never "unowned" (the gate claims a
worktree only on `Edit` / `Write` / `NotebookEdit` and fails open without a
session id, so a lane driven entirely through Bash never writes one — measured
on two live lanes). A **MERGED** PR is not proof of death (its owner may still
be inside §9 or §10). The stamp is CLAIM time, not last activity. A claim
younger than the 12h TTL means the owner is **presumed LIVE** — a live session
and a dead one produce identical evidence (`.claude/rules/hooks.md` and the
2026-08-10 trespass). When in doubt leave the worktree and say so in the wrap.
(Live instance: a worktree at `main`'s exact tip — every committed-state probe
reading it as residue — was a peer's live lane with uncommitted edits under a
12-minute-old claim.)

Finally, comment the outcome on each issue that was not auto-closed.
**RELEASE the claim on every issue that did NOT auto-close** — `--delete-branch`
just deleted the branch the claim names, so what is left is a lock pointing at
nothing. Derive the population mechanically:

```bash
for n in <the issues you claimed>; do
  printf '#%s: ' "$n"; gh issue view "$n" --json state -q .state
done
```

Every `OPEN` in that list needs a release comment — they are exactly the
partially-closed ones (a `Closes #N` PR auto-closes; a lane that shipped part
of an umbrella said `Refs` on purpose), i.e. the ones a future session is most
likely to pick up. Say three things: the issue is now UNCLAIMED; what the
merged PR actually closed; what remains WITH the reason it was left. Carry
forward anything expensive the lane measured (a live arm, a derived
population, a family of bugs) so the next lane inherits the evidence rather
than the diagnosis. A claim on an auto-closed issue needs nothing.

Do NOT stop here: what the run taught you is still only in this session's
context — go on to §10, which also decides WHERE each lesson belongs (memory
is the weakest of the options there, not the default one).
