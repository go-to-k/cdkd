<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 8. Verify before merge (`/verify-pr` + `/run-integ`)

### 8-a. Fix cascades — a round's fix producing the next round's blocker

- **After round two, name what the rounds have in common**, then take the narrow
  fix and FILE the structural one — across PRs too (#3979). Ask for it first.
- **A cascade stops when the artifact CLAIMS LESS** — tally the blockers by
  PART of the diff and offer that part's DELETION; stop reviewing the patch and
  question its SHAPE.

### 8-b. Integ ordering vs review rounds and rebases

**Run the integ LAST — after every reviewer RETURNS and the final edit to any
`integ-destroy`-scoped file.** A lane runs no integ (it still runs `triage.md`'s
throwaway CFn change set itself: never brief it down to read-only probes,
#5401), so only the parent finds an integ-time AWS-side rejection:
run a NEW arm once EARLY too, as soon as the lane has written it, between review
rounds (never during a `src` fix round); that run sets no marker and is no §8-d
proof — a new arm's first AWS contact can reject its shape (#4618). Sequence:
dispatch reviewers → (new arm: early run) → apply EVERY finding, nits included →
rebase → integ → marker. A UNIT-test-only fix round may overlap the parent's
integ in the lane's tree. Brief the lane: no build, `/check` or `/verify-pr`
there (a build rewrites the live fixture's `dist/`), no rebase or install, never
the live fixture's directory, and stage only its own test files (the integ's
ledger row lands there, #4302). A
lane REPORTS `mise exec -- markgate status integ-destroy --explain`'s line,
never "integ not needed": comment-only edits count (#3873).
The gate's `hash: diff` stales on a rebase only when main changed a scoped
file THIS branch changes too, so a set marker on a MERGEABLE PR needs no
rebase (`mise exec -- markgate status`) — unless main changed code the fixture
EXERCISES (a code path its run takes, not merely a file it loads; #4683):
re-run it on the rebased head (#3726).

- **DECLARE the tree final, in words, to whoever is still editing it** — every
  scoped touch buys another real-AWS run. The one exception to §8-h's "nits
  included": a COMMENT-ONLY nit found after the integ may ride this run's next
  lane on that file, whose integ re-runs anyway, named in that lane's PR body
  (#3977); with no such lane, fix it here and re-run. Scope the reviewers to the
  delta and paste its COMMIT MESSAGE into the brief: they read `gh pr diff`, not
  `git log`.

### 8-c. The live-test tiers

Run `/verify-pr`: it adds CI, docs, cleanup, review and a **live-test of the
changed behavior** to `/check`.
Run `/check-docs` ONCE per PR, at the FINAL sha: it is the required step for
SEMANTIC docs consistency, because CI covers only the structural checks. Unit
tests passing is necessary but NOT sufficient:

- **Deletion / DAG-order / state-cleanup change** → unmergeable until an
  integ's **destroy** step completes cleanly (`integ-destroy`); a CROSS-CUTTING
  change takes a BROAD-set fixture, a narrow one never reaching the
  multi-resource VPC / Lambda / Custom-Resource paths. Run one via
  **`/run-integ <name>`** — never raw `cdkd deploy` / `cdkd destroy`, the
  bypass being not those NAMES but **any real-AWS work outside a fixture**.
  `/pick-integ` picks the fixture(s).
- **Non-deletion source change** → still live-test the fixed path end to end
  (deploy → the redeploy that reproduced the bug → destroy). A lane barred from
  real-AWS RUNS still WRITES the arm; the parent runs it. "No fixture can reach
  it" needs `grep -rl '<type's last segment>' tests/integration/*/lib` empty
  first (an L2 fixture need not spell the full type; one an L2 creates
  IMPLICITLY needs a synthed template grepped) — an existing fixture takes the new arm
  (#4369).
- **A change to what cdkd PRINTS or DECIDES** (a message's text or line split,
  a refuse / adopt outcome) → `grep -rlF --include='*.sh' --include='*.ts'
  --include='*.mjs' --exclude-dir=node_modules '<old text>' tests/integration`
  (`.ts` / `.mjs` helpers read output; a top-level helper's hit means every
  fixture sourcing it); dropped AWS text (an id an SDK error echoes) has no
  literal, so grep its error code and API call, in fixtures the PR never edits
  too (#5268). Run each fixture named before merge, whatever the change's own
  tier: no vitest run executes them, so one stays red on `main` (#4394, #5046).
- **Any diff with no `src/**` change** (docs, toolchain, CI, hooks, skills,
  tests, config) → exempt from the tiers above, never from `/verify-pr` step 9;
  never conclude a CI job cannot fail on your diff from its NAME. Both arms
  apply to a diff doing both:
  - **It changes what a command or gate DOES** → the verification IS that
    command (`.claude/hooks/run-tests.sh` for a hook, the workflow step's
    command for CI, `vp run check` for lint config, which lints `src/**` only).
    Run it BEFORE and AFTER, building the BEFORE tree in §8-d's throwaway tree,
    never `git checkout -- <path>` / `git restore`. Drive the FAILURE
    direction too, and guard the fix's SHAPE with a test under
    `tests/unit/scripts/` or a case in the hook's `<name>.test.sh`.
  - **It changes PROSE only** (a skill, a rule, a doc — including this file) →
    the CLAIMS are the artifact. Resolve every gate, hook, skill, path, task
    and command the new text names against this repo's files, and RUN each
    command the text will send the next agent to run.

### 8-d. Integ arms owe a discrimination proof (mutation-probe on real AWS)

BEFORE the final integ, revert the fix, rebuild, run, confirm the arm goes RED
**at YOUR assertion — read which one fired**, then remove the throwaway tree (below). A red
ELSEWHERE proves nothing: at the CREATE the shape is unreachable, so redo
`triage.md`'s CFn premise (#5204); at an older step, harden it and re-run
(#5218). A GREEN pre-fix run BLOCKS the merge: rework the arm so the symptom reaches AWS
(#4927). A failure HINT's needle is
copied from that red run, never reasoned (#4336); a refusal the
log tail lacks is the failed resource's `error.message` / `awsErrorCode` in
`s3://<bucket>/<prefix>/<Stack>/<region>/deployments/*.jsonl`. **Revert in a
THROWAWAY detached tree at the PUSHED final sha, never the lane's** — there is
nothing to restore, and a restore in the lane tree is refused by
`dirty-path-restore-gate` and, as `cp`, by the classifier (#5401). Inside
`bash -c` (zsh mangles `$B:src`), each copy written beside the file FIRST — a
redirect onto the file truncates it even when `git show` fails:

```bash
git -C <MAIN_CHECKOUT> worktree add --detach <MAIN_CHECKOUT>/.claude/worktrees/probe-<PR> <final sha>
bash -c 'P=<MAIN_CHECKOUT>/.claude/worktrees/probe-<PR>; B=$(git -C "$P" merge-base origin/main HEAD)
[ -n "$B" ] || { echo "no merge base - nothing reverted"; exit 1; }
for f in $(git -C "$P" diff --name-only --no-renames --diff-filter=M "$B" HEAD -- src/); do
  git -C "$P" show "$B:$f" > "$P/$f.pre" && mv "$P/$f.pre" "$P/$f"
done; git -C "$P" status --short'   # must list every ` M` src/ file of the diff
# then in that tree: mise trust && mise install && vp install && vp run build,
# run the fixture (a hook / CI BEFORE tree runs that command), and afterwards:
git -C <MAIN_CHECKOUT> worktree remove --force <MAIN_CHECKOUT>/.claude/worktrees/probe-<PR>
```

Run it UNNARROWED on the FINAL diff: a lane's file list is a hint, stale after a
fix round. For §8-c's hook / CI
BEFORE tree, replace `src/` with the changed command's own paths. A file NEW in
the PR stays, unimported by pre-fix code; one the fix DELETED or moved is
restored by hand. The pre-fix run can mint resources the fixture's sweep cannot
name: scan the account by stack prefix and resource family too. Probe each HALF
of a multi-part fix separately, and add a NEGATIVE CONTROL. Where the fix SKIPS
something, give the fixture a second, ORDINARY difference — a phase redeploying
a byte-identical template diffs as `NO_CHANGE` and never reads the flag under
test. Two more vacuity shapes:

- **Every assertion PREDATES your change → the run is somebody else's
  regression net.** `git diff origin/main -- <fixture>`, then add the one that
  could only pass AFTER it, guarded against vacuity — a `NOTE` naming your
  issue is that slot: make it a `FAIL` before the run (#4548).
- **When a fix REMOVES a behaviour, an assertion that it HAPPENS goes
  over-determined, not red.**

### 8-e. Watching runs and pollers

**Never leave a real-AWS run unwatched** — a hung integ is indistinguishable
from a slow one; `/run-integ` step 5 carries the watchdog recipe. **ANCHOR the
predicate a poller waits on**: a line written only at the END
(`grep -q "^suite_rc="` — unanchored, `test_rc=` matches `typecheck_test_rc=`)
plus `kill -0 <YOUR run's PID>`, never `pgrep -f <name>`, which also matches
any poller or peer run whose command line carries it; over a state prefix, read
only `state.json` / `lock.json` (`deployments/` is always there). "Completed,
exit 0" is the rc of what you BACKGROUNDED, so run the long job as that call's
SOLE command.

### 8-f. Fixture environment prechecks

**Check a fixture's unstated PRECONDITIONS before spending a run** — they
refuse rather than explain:

```bash
aws s3api head-bucket --bucket "cdk-hnb659fds-assets-<acct>-<region>"   # bootstrapped?
aws s3 ls "s3://cdkd-state-<acct>/cdkd-bootstrap/"                      # cdkd regions
```

**A docker-dependent fixture is an environment blocker — prefer one reaching
the same code without it.** Where docker is required (any `local-*` fixture),
verify registry reach FIRST: `docker pull hello-world` under a 120s cap. A
`[verify] SKIP` exits 0 and is NOT a pass.

### 8-g. Prose claims are verified to the bar code is

- **Sweep by CLAIM, over NORMALISED text** (every TRACKED file, comment leaders
  stripped, whitespace collapsed, matched across line breaks — never
  `git grep`), and fix the prose.
- **A COUNT is never repaired by recounting** — delete it (preferred), fence it
  with a floor AND a cap from a test that reads the code, or attribute it as a
  dated measurement. A correction is itself a claim: RUN it, and re-derive
  every `file:line` a fix round invalidated.

### 8-h. Reviewer findings are inputs, not verdicts

- **Fix what a reviewer DEMONSTRATES, nits included** — "pre-existing" or "not
  a regression" is no decline in a file the PR holds (go-to-k/cdkd#3640;
  `filing.md`'s scope tripwire still applies); WITHDRAW an addition whose part
  keeps producing blockers. A right finding can carry a wrong FIX: check the
  PREMISE, and record a decline in the PR body.

### 8-i. Fresh deploys, and who verifies what

**A fresh deploy is a fresh FIXTURE**: `/new-integ` scaffolds one, `/run-integ`
deploys and tears it down (§8-c). **UNIQUE stack names only**
(e.g. `Cdkd<Issue>Verify`): the account may hold the maintainer's production
stacks. After teardown, sweep for orphans it cannot reach (`/aws/lambda/*` log
groups, RETAIN resources, Secrets in recovery, KMS keys pending deletion), then
run AGENTS.md's leftover check, which the `deployments/` store survives.

**`/run-integ` records `integ-destroy`, which `gh pr merge` needs beside
`main`'s ruleset checks**; `/verify-pr` and `/review-pr` record nothing — run them anyway.

**The independent review round is the ORCHESTRATOR's; a LANE's own reviewers
never substitute for it** (go-to-k/cdkd#2383) — they are its children and
inherit its premise. The parent runs its round once the lane reports
merge-ready, ONCE, on the final sha — brief each reviewer with the maintainer's
design answers and "what does this break that CFn or the CDK CLI accepts?" (a
redaction slice adds: "sweep every helper that returns or mutates the ORIGINAL
SDK error after the try — created-before-failure cleanup, orphan notes, retire
paths", #5161), to read by explicit sha after
`git fetch origin +refs/pull/<N>/head:refs/review/pr-<N>`: `FETCH_HEAD` is
shared across worktrees, `fetch.prune` DELETES a ref fetched from the short
`pull/<N>/head`, and without `+` a force-push is rejected. A later fix round goes to the same reviewer with the delta. **The reviewer set is
`/review-pr`'s**, which sizes `src/**` only: count the FIXTURE into it too.
