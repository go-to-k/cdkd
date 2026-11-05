<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 8. Verify before merge (`/verify-pr` + `/run-integ`)

### 8-a. Fix cascades — a round's fix producing the next round's blocker

- **After round two, name what the rounds have in common**, then take the narrow
  fix and FILE the structural one — across PRs too (#3979). Ask for it first.
- **A cascade stops when the artifact CLAIMS LESS** — tally the blockers by
  PART of the diff and offer that part's DELETION; stop reviewing the patch and
  question its SHAPE. Two rounds running that find NEW failure modes in code
  serving a shape CFn refuses: refuse the shape pre-flight (#5614).

### 8-b. Integ ordering vs review rounds and rebases

**Run the integ LAST — after every reviewer RETURNS and the final edit to any
`integ-destroy`-scoped file.** A lane runs no integ (it still runs `triage.md`'s
throwaway CFn change set itself: never brief it down to read-only probes,
#5401), so only the parent finds an integ-time AWS-side rejection:
run a NEW or edited arm EARLY, to GREEN, once the lane writes it, from a
`--detach` sibling at the pushed sha (§8-d's `worktree add`, no revert), so no
fix round waits on it (#2762). It and §8-d's probe set no marker and commit no
ledger row (`/run-integ` step 11; the final run's row replaces theirs, #5795),
and it is no §8-d proof (#4618).
Sequence: reviewers → early run → EVERY finding, nits included → §8-d probe →
rebase → integ → marker (an hour-long probe stales the base, #5475). A
UNIT-test-only fix round may overlap the parent's integ in the lane's tree.
Brief the lane: no build, `/check` or `/verify-pr` there (a build rewrites the
live fixture's `dist/`), no rebase or install, never the live fixture's
directory, and stage only its own test files (the integ's ledger row lands
there, #4302). A lane REPORTS
`mise exec -- markgate status integ-destroy --explain`'s line, never "integ not
needed": comment-only edits count (#3873).
The gate's `hash: diff` stales on a rebase only when main changed a scoped
file THIS branch changes too, so a set marker on a MERGEABLE PR needs no
rebase (`mise exec -- markgate status`) — unless main changed code the fixture
EXERCISES (a code path its run takes, not merely a file it loads; #4683):
re-run it on the rebased head (#3726).

- **DECLARE the tree final to whoever is still editing it.** The one
  exception to §8-h's "nits
  included": a COMMENT-ONLY nit found after the integ may ride this run's next
  lane on that file, whose integ re-runs anyway, named in that lane's PR body
  (#3977); with no such lane, fix it here and re-run. Scope the reviewers to the
  delta by `git range-diff` or the PR's file list (a two-dot diff over a
  rebase shows peers' files, #5651) and paste its COMMIT MESSAGE into the brief:
  they read `gh pr diff`, not `git log`.

### 8-c. The live-test tiers

Run `/verify-pr`, which adds a **live-test of the changed behavior** to `/check`.
Run `/check-docs` ONCE per PR, at the FINAL sha: CI covers only the structural
checks.

- **Deletion / DAG-order / state-cleanup change** → unmergeable until an
  integ's **destroy** step completes cleanly (`integ-destroy`); a CROSS-CUTTING
  change takes a BROAD-set fixture (multi-resource VPC / Lambda /
  Custom-Resource paths). A gate-only run's RED is a defect,
  never flake (#5699). Run one via
  **`/run-integ <name>`** — never raw `cdkd deploy` / `cdkd destroy`, the
  bypass being **any real-AWS work outside a fixture**.
  `/pick-integ` picks the fixture(s).
- **Non-deletion source change** → still live-test the fixed path end to end
  (deploy → the redeploy that reproduced it → destroy). A lane barred from
  real-AWS RUNS still WRITES the arm; the parent runs it. "No fixture can reach
  it" needs `grep -rl '<type's last segment>' tests/integration/*/lib` empty
  first (an L2 need not spell the full type; a resource it creates
  IMPLICITLY needs a synthed template grepped) — an existing fixture takes the new arm
  (#4369). A mode behind an env flag `verify.sh` does not set itself
  (`grep -n 'CDKD_INTEG_[A-Z_]*:-' <fixture>/verify.sh`, `RUN_ID` aside) is its
  own run: a PR on its path runs the flag and the ledger NOTE names the mode
  (#5577).
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

BEFORE the final integ, and only once the arm AS IT STANDS at the final sha has
PASSED (§8-b's early run; a red on an unproven fixture is unattributable),
revert the fix, rebuild, run, confirm the arm goes RED
**at YOUR assertion — read which one fired**. A red
ELSEWHERE proves nothing: at the CREATE, a refusal of the shape under test
means it is unreachable, so redo `triage.md`'s CFn premise (#5204), while a
feature hitting an UNRELATED pre-fix limitation is dropped or worked around in
the throwaway tree only, never the PR, and re-run (#5414), at most two such workarounds
(#5528) — a third stops the probe for the parent; at an older step, harden it and
re-run (#5218). A refusal at the arm's OWN deploy, emitted by the route the
fix replaces while the fixed route accepts the shape, IS the symptom (#5507);
one on either route is #5204's. A GREEN pre-fix run BLOCKS the merge: rework
the arm so the symptom reaches AWS (#4927). A NEEDLE (hint, retry regex,
fixture refusal grep) is copied from cdkd's red output on EACH route, never
reasoned nor the `aws` CLI's (#4336, #5592; #5680: masked account ids,
code-only SDK errors); a refusal the
log tail lacks is the failed resource's `error.message` / `awsErrorCode` in
`s3://<bucket>/<prefix>/<Stack>/<region>/deployments/*.jsonl`. **Revert in a
THROWAWAY detached tree at the PUSHED final sha, never the lane's** — the lane
tree then has nothing to restore (a SECOND probe in the throwaway tree restores
the first's edit with `CDKD_ALLOW_DIRTY_RESTORE=1`, never `git show >` around
the gate: #5657), and a restore in the lane tree is refused by
`dirty-path-restore-gate`, and `cp` by the classifier. Inside
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
of a multi-part fix separately (a pre-fix run stops at its first failing arm:
remove that phase to prove the next; where the kept half WAITS for the removed
call's effect, the RED is that wait's timeout, ~30 min per resource, before any
fixture assertion — predict and budget it, #5657), and add a NEGATIVE CONTROL. Where the fix
SKIPS
something, give the fixture a second, ORDINARY difference — a phase redeploying
a byte-identical template diffs as `NO_CHANGE` and never reads the flag under
test. More vacuity shapes:

- **Every assertion PREDATES your change → a regression net, not your
  proof.** `git diff origin/main -- <fixture>`, then add the one that
  could only pass AFTER it, guarded against vacuity — a `NOTE` naming your
  issue is that slot: make it a `FAIL` before the run (#4548).
- **When a fix REMOVES a behaviour, an assertion that it HAPPENS goes
  over-determined, not red.**
- **A self-compared baseline, or a 0 count with no prior 1, proves nothing**: change the value out of band first (#5648, #5649).

### 8-e. Watching runs and pollers

**Never leave a real-AWS run unwatched**: `/run-integ` step 5's watchdog. **ANCHOR the
predicate a poller waits on**: a line written only at the END
(`grep -q "^suite_rc="` — unanchored, `test_rc=` matches `typecheck_test_rc=`)
plus `kill -0 <YOUR run's PID>`, never `pgrep -f <name>`, which also matches
any poller or peer run whose command line carries it; over a state prefix, read
only `state.json` / `lock.json` (`deployments/` is always there). "Completed,
exit 0" is the rc of what you BACKGROUNDED, so run the long job as that call's
SOLE command.

### 8-f. Fixture environment prechecks

**Check a fixture's unstated PRECONDITIONS before spending a run**:

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
  a regression" is no decline in a file the PR holds (#3640;
  `filing.md`'s scope tripwire still applies); WITHDRAW an addition whose part
  keeps producing blockers. A right finding can carry a wrong FIX: check the
  PREMISE, and record a decline in the PR body.

### 8-i. Fresh deploys, and who verifies what

**A fresh deploy is a fresh FIXTURE**: `/new-integ` scaffolds one, `/run-integ`
deploys and tears it down. **UNIQUE stack names only**:
the account may hold the maintainer's production
stacks. After teardown, sweep for orphans it cannot reach (`/aws/lambda/*` log
groups, RETAIN resources, Secrets in recovery, KMS keys pending deletion), then
run AGENTS.md's leftover check, which the `deployments/` store survives.

**The independent review round is the ORCHESTRATOR's; a LANE's own reviewers
never substitute for it** (#2383) — they are its children and
inherit its premise. The parent runs its round once the lane reports
merge-ready, ONCE, on the final sha — brief each reviewer with the maintainer's
design answers and "what does this break that CFn or the CDK CLI accepts?" (a
redaction slice adds: "sweep every helper that returns or mutates the ORIGINAL
SDK error after the try — created-before-failure cleanup, orphan notes, retire
paths", #5161; a state machine adds the table to walk: path × previous side ×
desired side, #5611; a refusal or forward-only guard in `update()` adds "does
it fire on the rollback replay, whose diff runs BACKWARD?" —
`provider-replay-and-refusals.md`, missed by both lanes' reviewers in one run,
#5730, #5731; a HAND replacement rule on a newly wired schema-mutable property
adds "does a record LACKING the key replace?" — #5572's guard covers schema
create-only drops only, #5730), to read by explicit sha after
`git fetch origin +refs/pull/<N>/head:refs/review/pr-<N>`: `FETCH_HEAD` is
shared across worktrees, `fetch.prune` DELETES a ref fetched from the short
`pull/<N>/head`, and without `+` a force-push is rejected. A later fix round goes to the same reviewer with the delta. **The reviewer set is
`/review-pr`'s**, which sizes `src/**` only: count the FIXTURE into it too.
