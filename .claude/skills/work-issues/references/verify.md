<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge (`/verify-pr` + `/run-integ`)

### 8-a. Fix cascades — when a round's fix produces the next round's blocker twice

Stop reviewing the patch and question its SHAPE. Every cascade below was ended
by a probe or a trace, never by re-reading the diff:

- **After round two, name what the rounds have in common** — usually one
  structural absence explains why one path keeps generating instances. Do NOT
  take the structural fix late in the cascade (new entrypoint code at round
  five is how round six happens): take the narrow fix, file the structural
  one, and reference it from the narrow fix so the choice reads as made.
- **Filing the structural fix does not STOP a cascade — making the artifact
  CLAIM LESS does** (go-to-k/cdk-local#596: twelve rounds, five instances
  introduced by fixes; it ended when the sweep printed raw output and named
  both outcomes instead of emitting a verdict). The tell: each fix is more
  SOPHISTICATED than the last while plain rc-only sweeps nearby were right all
  along. Expect the fix to feel like a retreat; it converges. Two riders:
  **fence the REMEDIATION, not just the detection** (the last instance lived
  in the repair path, which every fence had ignored), and **do not pre-commit
  to a remedy for a finding you have not seen** — say what the next finding
  would have to SHOW, not what you will do about it.
- **If the thing you keep patching is a CLASSIFIER, stop and build §5's
  differential fence before the next fix** (go-to-k/cdkd#2027: five rounds,
  each finding a new spelling, rounds 3–4 adding five regressions; the
  differential walk ended it in one round). The tell is not the round count:
  each finding is a new INPUT CLASS, not a new place the logic is wrong.
- **"The fence covers ONE ROW of a multi-dimensional guarantee" → widen to
  the CROSS PRODUCT before the next fix.** Count the cells; fewer assertions
  than cells means naming the uncovered ones and probing one. The uncovered
  cell is not random — a hazard lives there BECAUSE that cell behaves
  differently, which is why "a representative case per dimension" skips it
  (go-to-k/cdkd#2466: 4 positions × 2 YAML readers, the `<<` merge key in the
  missing cell, the fix inert through a full 3-axis round).
- **"TWO SPELLINGS of one question" → make both sites use ONE predicate
  verbatim** — a better second spelling looks like a fix and passes its own
  test (go-to-k/cdkd#2134: `producerRegion !== undefined` disagreed with the
  authority's own `if (!producerRegion)` on the empty string, fail-OPEN).
  Name the site that OWNS the question; every other site calls or copies it
  exactly.
- **"A PROXY for a question only another component can answer" → make that
  component REPORT.** The tell: each proxy is wrong in BOTH directions at
  once (go-to-k/cdkd#2157 / go-to-k/cdkd#2166: "it threw" and "the text
  survived" each both over- and under-reported). WITHDRAWING the half that
  cannot be made right is a legitimate outcome — and the residual issue must
  carry the MEASUREMENTS (each proxy tried, the input that broke it, the
  number it produced), not just the diagnosis, or the next session re-runs
  the probes.
- **When the fix WIDENS what a guard catches, ask what the thing you are
  deleting was actually DOING — and confirm the instrument you measure with
  probes the POSITION your change acts in** (go-to-k/cdkd#2333, WITHDRAWN
  after four rounds: the removed quote-behaviour was the only brake on an
  earlier widening, and the survey returned zero because every probe landed
  in argument position, never the flag prefix the change acted on). A zero
  measured in the wrong position is not weak evidence; it is none.
- **Derive the reader population before patching readers** — one grep returns
  every consumer at once; patching one per round IS the cascade.
- **A benchmark must exercise the path the change is on** (a lane published
  "+20% latency" from a run whose input took an early return before the new
  code; re-measured +0–3%). Confirm the probe reaches the added code, as §5
  requires of a mutation probe.

**A fix that CLOSES a member falsifies every sentence that COUNTS the set** —
the member leaves in the diff while the counter sits in a file the diff never
touches (four instances in ONE run, go-to-k/cdkd#2410 / go-to-k/cdkd#2275,
every one caught by a reviewer and none by the author):

```bash
# The counters sit OUTSIDE the diff, which is why re-reading the diff misses them.
grep -rn "<the set's noun, then its cardinal>" src/ docs/ .claude/
```

NAME the member you closed where the count lives; a silent renumber is what
makes the next reader re-file it.

### 8-b. Integ ordering vs review rounds and rebases

**Run the integ LAST — after the final edit to any gate-scoped file**, not
after the final edit you happened to think of. Review nits landing in gate
scope stale the marker (two real-AWS re-runs on 2026-08-25 alone). Sequence:
dispatch reviewers → apply EVERY finding including nits → rebase → integ →
markers.

- **Before starting an integ, ask what is still outstanding** — a reviewer
  still running, an unapplied nit, a coming rebase each stale the marker.
  `git diff origin/main...HEAD --name-only` against the gate's include list
  answers it in one command.
- **A rebase can stale a `hash: diff` marker on its own** — the merge base
  moves, so an incoming change to a file this branch also touches invalidates
  it. Rebase BEFORE the integ; push first so CI runs alongside the integ
  (they are independent — serializing them wastes wall-clock).
- **Under iterative review rounds, DECLARE the tree final, in words, to
  whoever is still editing it.** Every gate-scoped touch buys another
  real-AWS run — comment-only deltas included, since `hash: diff` digests the
  delta, not the behaviour (three `ecs-service-update-props` runs on
  2026-08-26, the third for zero non-comment lines). Tell the implementing
  agent to batch all remaining findings into ONE commit and report FINAL with
  no second pass. For reviewers, the reverse: dispatch a round scoped to the
  delta, ask for all findings at once — **and paste the delta's COMMIT
  MESSAGE into the brief**: all four reviewer agents read `gh pr diff`, none
  reads `git log`, so a false claim in a commit message is invisible to the
  whole tier (measured 2026-08-29: a blocker cited a function that never
  existed, caught only because the orchestrator re-read the message).
- **An EXEMPTION is the highest-risk edit a fence can receive — probe it in
  both directions before the round ends.** A carve-out is written while
  agreeing the fence was WRONG, the exact posture in which nobody asks what
  it now lets through (2026-09-02: three consecutive delta rounds each found
  the previous round's carve-out was token-spendable — a line-wide skip, a
  clause-wide negation exempting eleven prescriptive sentences, a
  sentence-scoped one a whole fenced block inherited). Two cheap questions:
  does a PRESCRIPTIVE use of the same words spend the exemption (probe one),
  and is the exemption LOAD-BEARING at all (delete its wiring; the suite must
  go red).
- **Every fix a round applies is UNFENCED by default: the suite it passes is
  the suite that passed BEFORE it.** Revert each fix in turn and require a
  red; one nothing reddens is a claim, not a change (2026-09-02: three of
  go-to-k/cdkd#2428's round-2 fixes reverted green; go-to-k/cdkd#2450's
  escaping fix stayed green weakened to keys-only because its fixture had
  nothing to escape).
- **Reviewer subagents spawned BY A LANE report to the MAIN session**, not to
  the lane that spawned them — a lane that dispatches reviewers and waits
  blocks forever while the parent collects verdicts it did not ask for
  (go-to-k/cdkd#2417). Pick one shape in the dispatch: the lane runs its
  reviewers synchronously, or the parent owns the review dispatch and relays
  verdicts down (under §9's queued-versus-`Resuming` rule).

### 8-c. The live-test tiers

Run `/verify-pr`. It layers CI status, docs consistency, AWS-resource cleanup,
code review, and a **live-test of the changed behavior** on top of `/check`.
Unit tests passing is necessary but NOT sufficient:

- **Deletion / DAG-order / state-cleanup change** → unmergeable until an
  integ's **destroy** step completes cleanly (`integ-destroy`, plus
  `integ-broad` for cross-cutting files). Run it via **`/run-integ <name>`**
  — never raw `cdkd deploy` / `cdkd destroy` from a shell; the skill encodes
  deploy + update + destroy + orphan verification and records the ledger row.
  `/pick-integ` chooses the fixture(s).
- **Non-deletion source change** → still live-test the fixed path end-to-end
  (deploy → the redeploy that reproduced the bug → destroy), fresh fixture or
  `/run-integ` against an existing one.
- **Any diff with no `src/**` change** (docs, toolchain, CI, hooks, skills,
  tests, config) → exempt from the deploy/destroy tiers above, never from
  `/verify-pr` step 9 and never from the `verify-pr` gate itself. This is the
  easy tier to under-verify. **Never conclude a CI job cannot fail on your
  diff from the job's NAME** — a name bounds where it reads, not what it
  asserts; repo-wide fences (byte caps, corpus scans) live inside jobs with
  narrow-sounding names (go-to-k/cdkd#2236 went red exactly this way). What
  satisfies step 9 depends on the diff; a diff that does both takes BOTH arms:
  - **It changes what a command or gate DOES** → the verification IS that
    command. Run the command your own diff changes (`.claude/hooks/run-tests.sh`
    for a hook, the workflow step's command for CI, the changed task for
    `vite.config.ts`, `vp run check` for lint/typecheck config — noting
    `vp run check` reads neither `ci.yml` nor any hook, and its lint is
    scoped to `src/**`). Run it BEFORE and AFTER; for the BEFORE tree use a
    scratch copy or re-applied sed-swap, never `git checkout -- <path>` /
    `git restore <path>` (`dirty-path-restore-gate` blocks it; one such undo
    discarded ~200 lines of unrelated work, go-to-k/cdkd#1700). Flag-order
    trap: a `vp run` flag after the task name is forwarded to the task and
    rejected — exit 1 from a command that never ran (go-to-k/cdkd#2017); read
    help through `mise exec`, not the bare binary. **Drive the FAILURE
    direction too** — a config change that swallows an exit code turns a red
    tree green. For the lint gate: append an unused variable (not `_*`-named)
    to a `src/**` file — `tests/**` is never linted — confirm rc=1, then
    revert the probe before committing. **Then guard the SHAPE of the fix
    with a test** (`vite.config.ts` / `scripts/**` / `ci.yml` →
    `tests/unit/scripts/*.test.ts` with a parser floor;
    `.claude/hooks/**` → a case in the hook's own `<name>.test.sh`). Where no
    harness can read the artifact (a `.mise.toml` pin, an action SHA), say so
    in the PR body.
  - **It changes PROSE only** (a skill, a rule, a doc — including this file)
    → the CLAIMS are the artifact. Resolve every gate, hook, skill, path,
    task and command the new text names against this repo's files, and RUN
    each command the text will send the next agent to run (§10-c's
    claim-by-claim pass).

### 8-d. Integ arms owe a discrimination proof — mutation-probe against real AWS

An arm is the one place this flow routinely ships a fence nobody has watched
fail. The probe is one extra run of a fixture you are already running: revert
the fix, rebuild, run, confirm the arm goes RED, restore, rebuild. **Probe
each HALF of a multi-part fix separately** (a scrub lane's probes proved the
halves independently fenced — a single all-or-nothing revert cannot). Add a
NEGATIVE CONTROL inside the arm — a sibling case that must NOT trip the new
behaviour — or a refusal that fires on everything satisfies every positive
assertion. The vacuity shapes (none visible by reading the script; first,
second and fourth measured on go-to-k/cdkd#2108 / go-to-k/cdkd#2109):

- **The host has the trigger but not the EVIDENCE, or the reverse** — a fix
  keying on recorded state needs the state AND the thing it describes in the
  SAME unit. Adding one small resource to the stack already carrying the
  evidence is cheaper than a new fixture: check before calling a live arm
  `next`.
- **The arm is INERT because the command returns early** — when the fix SKIPS
  something, a fixture whose ONLY difference is the skipped thing gives the
  command no work ("nothing to revert": two live writes, zero signal). Give
  the fixture a second, ORDINARY difference, and a phase proving the premise
  before the phase that depends on it.
- **The arm's PREMISE is out of scope, and the tell is both counts zero** —
  `0 leaks AND 0 masks` is an arm that did nothing (go-to-k/cdkd#2176: the
  spelling used was one cdkd deliberately does not resolve, so nothing was
  ever plaintext). Prove the premise independently before reading the
  assertions.
- **A negative assertion is a confluence point** — "the bad value was not
  written" is satisfied by a correct refusal AND by any unrelated failure
  that stopped short (measured: fix mutated back, arm stayed green because
  the revert had errored instead of writing). Assert the POSITIVE marker only
  the fixed path emits; demote the negative to a stated safety net.
- **Every assertion PREDATES your change → the run is somebody else's
  regression net.** `git diff origin/main -- <fixture>` and ask which
  assertion could only pass AFTER your change; if none, add the
  discriminating one, guarded against vacuity (an absence-from-an-array
  assertion must first require the array to exist).
- **The inverse, when a fix REMOVES a behaviour: an assertion that it HAPPENS
  goes over-determined, not red** (three fixtures kept passing on accumulated
  delete markers after go-to-k/cdkd#2450). Sweep the test tree by the
  assertion's SHAPE, not the issue's wording, and RE-POINT each hit rather
  than deleting it — a deleted negative control leaves that direction
  unfenced.
- **A fixture that establishes its precondition on the HAPPY path cannot test
  the arm where the FAILING path creates it** (go-to-k/cdkd#2057: the refusal
  could not fire — its evidence was persisted only by the success path — yet
  the fixture passed; four diff-reading reviewers missed it, a fifth traced
  the evidence). Ask which step wrote the state in the fixture, and which
  writes it in the reachable case; if they differ, add the arm where one
  operation does both, and prove it discriminates (mutate the fix: original
  arm still green, new arm red).
- **An arm added to a SHARED fixture must not touch an identifier the fixture
  REUSES** (go-to-k/cdkd#2227: the arm planted the stack's own bucket name in
  a second region; S3 answers `OperationAborted` for ~58 min, blocking every
  later run). Give the arm a PER-RUN UNIQUE identifier created only when the
  arm asks, verified by `cdk synth` in both polarities.

Three fixture mechanics, each worth a stubbed dry run (all cost a real-AWS
cycle on 2026-08-20): a `cleanup` that also runs pre-run must not destroy
anything the run then needs (a `mktemp -d` at variable-definition time + `rm
-rf` in cleanup deletes the workdir before its first write); before waiting
for a resource to disappear, verify the probe reports "still present" DURING
deletion (else the wait is vacuous — measure the window so the budget is a
number); and a fixture whose only `cdkd destroy` fails BY DESIGN cannot
honestly flip `integ-destroy` — add a final phase that disables the
injection, redeploys, and runs a genuinely clean destroy.

### 8-e. Watching runs and pollers

**Never leave a real-AWS run unwatched, and do not reach for `timeout`** — it
does not exist on macOS (exit 127 in 0s reads as an instant completion), and a
hung integ looks identical to a slow one from outside (one wedged in
`docker push` for 4h17m). Shell watchdog, firing made visible:

```bash
LOG=$(mktemp)   # assign HERE: a separate block is a separate shell, and
                # `> ""` is a loud failure that costs you the whole run
bash verify.sh > "$LOG" 2>&1 &
VPID=$!
( sleep 1500; kill -9 $VPID 2>/dev/null; echo "WATCHDOG_FIRED" >> "$LOG" ) &
WPID=$!
wait "$VPID"; RC=$?
kill "$WPID" 2>/dev/null
grep -c WATCHDOG_FIRED "$LOG" || echo "watchdog did not fire"
```

The `grep` is load-bearing (`kill -9` surfaces as rc=137, otherwise just a
crash). Pair with a `Monitor` on phase lines AND log-growth stalling.

- **ANCHOR the predicate a poller waits on** — a premature DONE is acted on.
  Wait on a line the job writes only at the END, anchored
  (`grep -q "^suite_rc="` — an unanchored `test_rc=` matched
  `typecheck_test_rc=` from an earlier step; `[ -s "$f" ]` was satisfied by
  the job's own first echo), and confirm the process is gone (`pgrep -f`).
- **The harness's "completed, exit 0" is the exit code of the command you
  BACKGROUNDED** — `nohup <job> ... & echo started` reports success while the
  job still runs. Run the long job as the SOLE command of the backgrounded
  call and read the log's own terminal line. Two nearby traps: a `cd` inside
  the backgrounded compound leaves the parent's `$VAR` unset, and `grep -c`
  exits 1 on a count of zero.
- **A run blocked before its assertions is not a failing fix** — record it as
  `FAIL` (the bar is exit-code-based) with a ledger note naming the blocker
  and any hand-removed AWS resources, or the next reader concludes the merged
  fix is broken.

### 8-f. Fixture environment prechecks

**Check a fixture's unstated PRECONDITIONS before spending a run** — fixtures
refuse rather than explain (`asset-bootstrap` took three attempts: it needs a
CDK-bootstrapped region with no cdkd marker). Both are two commands:

```bash
aws s3api head-bucket --bucket "cdk-hnb659fds-assets-<acct>-<region>"   # CDK-bootstrapped?
aws s3 ls "s3://cdkd-state-<acct>/cdkd-bootstrap/"                       # which regions cdkd owns
```

**A docker-dependent fixture is an environment blocker — prefer one reaching
the same code without it** (on the merits, not merely availability). When
docker is genuinely required (`integ-local`), verify registry reach FIRST
(`docker pull hello-world` under a 120s cap) — `docker version` answering says
nothing about registry networking. **Do NOT restart Docker to fix a hang — on
Docker Desktop the restart IS the likelier cause**: the daemon routes registry
traffic through a proxy the Desktop APP serves, and a quit-and-reopen can
leave the self-respawning backend up while the app never finishes launching
(four consecutive hung pulls; only a manual app restart recovered). Diagnose
in order, stop at the first line that explains the symptom:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 https://registry-1.docker.io/v2/  # 401 = HOST networking fine
docker info 2>/dev/null | grep -i proxy         # the proxy the daemon depends on
pgrep -f 'Docker Desktop' >/dev/null && echo app-running || echo APP-NOT-RUNNING
```

Ask the maintainer rather than escalating — factory reset / deleting Docker
data destroys local images and volumes, never yours to spend. Clean up your
own probes (`kill`ing a `docker pull` wrapper leaves the `com.docker.cli`
child running).

### 8-g. Prose claims are verified to the same bar as code

Only the code half of a diff has tests behind it; commit messages, changelog
entries, PR bodies and rationale comments have none — one pair of PRs
(go-to-k/cdkd#1882 / go-to-k/cdkd#1887) took four review rounds finding zero
code defects and FIVE false statements in prose. Habits that each caught one:

- **Grep the SHAPE, never the phrase** — two sweeps for a stale claim
  searched the known copies' exact wording and each missed a differently
  worded one. Count the population BEFORE editing; assert the count after.
- **A claim inherited from the ISSUE BODY is the least trustworthy of all** —
  re-verify an issue's mechanism against current `main` before restating it
  (a later PR may already have falsified it).
- **A correction can be a new false claim** — twice the replacement sentence
  was wrong in the other direction. Re-read a correction against the code.
- **In a FIX round, the fix invalidated your own prose** — every past-tense
  measurement is stale until re-derived (one run: one code defect, TEN false
  claims — a changelog citing a ledger row the same delta replaced, a fence
  "claimed rather than probed" whose named case did not exist, a tally
  patched instead of re-measured, a blanket claim contradicted by its own
  list). Before a fix round is final, re-derive every number, `file:line`,
  ledger citation and "measured" verb, and say which tree they came from.
- **The remedy is to DELETE the unproved clause, not rewrite it** — the
  recurring shape is a CONSEQUENCE bolted onto a verified claim ("X is
  load-bearing: deleting it would hard-fail" — X probed, the consequence
  never). Deleting a whole CLAIM cannot introduce a new false one; deleting a
  clause from INSIDE a sentence can falsify the survivor, so re-read what
  remains. When the false claim was that something IS fenced, BUILD the fence
  instead.
- **Write the rationale FIRST in a fix round** — the one rationale-first
  round of four was the only one that introduced no new prose defect.

### 8-h. Reviewer findings are inputs, not verdicts

- **A reviewer's suggested FIX can be wrong even when its finding is right**
  — derive regexes, bounds and constants from the code that produces the
  value, and probe both directions (go-to-k/cdkd#2052: the suggested key
  filter's `+` would have skipped keys cdkd really writes — the producer's
  random suffix can be empty — trading over-collection for invisible
  under-collection).
- **Check a reviewer's PREMISE before acting, and say so when you decline** —
  record the trace in the PR body; a declined finding with evidence can be
  re-judged, a silently dropped one looks like an oversight.
- **An ABSENCE claim ("no such fence exists") is the one a reviewer is least
  able to establish — verify it by RUNNING the thing said not to exist**
  (acting on one nearly broke a byte budget sitting 2 B under its cap).
- **Your own BRIEF to a lane agent is a published claim** — the trigger for
  verification is DESTINATION, not doubt. Grep every mechanism claim before
  it goes into an instruction; when an agent corrects your brief, say so.
- **A REVIEWER brief fails worse** — a false premise aims the whole round at
  the wrong subject and returns a report that reads as authoritative (a false
  region-residency mechanism reached three briefs before being caught).
  Correct one already sent in-flight rather than waiting for the report.
- **When two reviewers CONTRADICT each other, settle it in the code yourself
  before forwarding either** — say which was right and why. **For a claim
  about an EXTERNAL system, neither reviewer can settle it and neither can
  you: the tie-break is a MEASUREMENT** (a `NoEcho` masking dispute was
  settled by a live CFn A/B that overturned the lane's design —
  go-to-k/cdkd#2274; `CLAUDE.md`'s "never file divergence on folklore"). The
  tell is grammatical: if the disputed sentence names a service rather than a
  file, stop reading code and measure.

### 8-i. Fresh deploys, markers, and who sets what

**Fresh deploys: UNIQUE stack names only** (e.g. `Cdkd<Issue>Verify`), never a
shared fixed name — the account may hold the maintainer's production stacks.
Tear down with `cdkd destroy … --force`, then sweep for orphans it cannot
reach (auto-created `/aws/lambda/*` log groups, RETAIN resources, Secrets in
recovery, KMS keys pending deletion). Confirm state is gone:

```bash
aws s3 ls s3://cdkd-state-$(aws sts get-caller-identity --query Account --output text)/cdkd/
```

(the `deployments/` events store legitimately survives). If destroy failed or
left orphans, delete them by direct AWS API call before doing anything else.

`/verify-pr` sets `check` + `docs` + `verify-pr`; `/run-integ` sets the
`integ-*` markers — together they unblock `gh pr merge`.

**`pr-review` is not on that list, and a LANE must never set it.** `/review-pr`
writes it, run by the ORCHESTRATOR after its dispatched reviewers report and
every blocker is addressed — a lane setting it is the "sub-agent self-review
is not independent review" failure arriving through the marker (two of three
lanes did exactly this on 2026-08-29, go-to-k/cdkd#2383 /
go-to-k/cdk-local#631 — so name this marker in the lane's brief). Nothing
mechanical catches it: the sha-bound sentinel is per-worktree and §9 merges
from the lane's worktree, so a lane that sets it after its final push produces
a matching sha. The rule is the only thing standing there.

**And your own review round is not optional because the lane already ran one.**
A lane's reviewers are its children — same brief, same framing — so what they
cannot doubt is the premise the lane handed them (go-to-k/cdkd#2383: three
rounds of lane reviewers each found the next spelling of one defect; the
independent orchestrator round found the YAML merge key the lane's own
tripwire had been added to backstop and did not fire on). Take the tier the
heuristic gives for YOUR pass.

**A reviewer's scratch COPY of a worktree is not detached from git.** A linked
worktree's `.git` is a FILE pointing into the main repo, and `cp -R` carries
the pointer — a read-only reviewer's `git add -A` inside its copy staged three
deletions in the LIVE tree (2026-08-29). Two lines for every read-only
reviewer's brief: run NO writing git verb (`add` / `commit` / `restore` /
`checkout` / `stash` / `clean`) anywhere, copy included — copy OUTSIDE every
repository if you must copy — and report the target worktree's
`git status --porcelain` before AND after the round. If damage happens anyway,
the repair is `git restore --staged` (the INDEX only), the one carve-out.
