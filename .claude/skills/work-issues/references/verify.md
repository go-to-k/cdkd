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
  along. **WHICH part to shrink is a COUNT** — tally each round's blockers by
  PART of the diff: go-to-k/cdkd#2678 put 11 of 11 in its classifier over that
  classifier's three rounds and NONE in the guards it shipped. Then offer the next
  round DELETION as an option it may take and STOP on ("fix cleanly, or DELETE
  the added paths and scope the header's claim") — go-to-k/cdkd#2697 converged
  in one round that way. Two riders: **fence the REMEDIATION, not just the
  detection** (the last instance lived in the repair path every fence
  ignored), and **do not pre-commit to a remedy for a finding you have not
  seen** — say what the next finding would have to SHOW.
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
  missing cell, the fix inert through a full 3-axis round). **The POPULATION
  is one of those dimensions** — a fence that derives its subject list from
  one directory is blind to the same claim restated outside it, so ask where
  the claim is WRITTEN and not only where it is implemented
  (`tests/unit/cli/local-state-source.test.ts` walks `src/` alone, so
  `.claude/rules/layout-local.md` still named the DELETED fork's
  CloudFormation API — the exact defect go-to-k/cdkd#2527 was closing, caught
  only because a reviewer was pointed at the rules delta; same shape in
  `tests/unit/local/docker-argv-redaction-fence.test.ts`, whose
  `readdirSync('src/local')` cannot reach go-to-k/cdkd#2623's `src/assets/**`
  sites).
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
  probes the POSITION your change acts in** (go-to-k/cdkd#2333's FIRST
  attempt, withdrawn after four rounds: the removed quote-behaviour was the
  only brake on an earlier widening, and the survey returned zero because
  every probe landed in argument position, never the flag prefix the change
  acted on). A zero measured in the wrong position is not weak evidence; it is
  none.
- **A benchmark or COST FENCE must exercise the path the change is on** — a
  lane published "+20% latency" from a run that early-returned before the new
  code; go-to-k/cdkd#2333's latency case was vacuous twice, first bailing at a
  bound, then plateauing because cost is per SEGMENT and the payload had two.
  Build the payload that was actually EXPENSIVE, and measure the threshold
  with the fix AND with it deleted.

### 8-b. Integ ordering vs review rounds and rebases

**Run the integ LAST — after the final edit to any gate-scoped file**, not
after the final edit you happened to think of. Review nits landing in gate
scope stale the marker (two real-AWS re-runs on 2026-08-25 alone). Sequence:
dispatch reviewers → apply EVERY finding including nits → rebase → integ →
markers. `git diff origin/main...HEAD --name-only` against the gate's include
list says in one command whether anything is still outstanding.

- **A rebase can stale a `hash: diff` marker on its own** — the merge base
  moves, so an incoming change to a file this branch also touches invalidates
  it. Rebase BEFORE the integ; push first so CI runs alongside it — they are
  independent, so serializing them spends wall-clock and weakens neither.
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
  the previous round's carve-out token-spendable, at line, clause and sentence
  scope in turn). Two cheap questions:
  does a PRESCRIPTIVE use of the same words spend the exemption (probe one),
  and is the exemption LOAD-BEARING at all (delete its wiring; the suite must
  go red).
- **Every fix a round applies is UNFENCED by default: the suite it passes is
  the suite that passed BEFORE it.** Revert each fix in turn and require a
  red; one nothing reddens is a claim, not a change (2026-09-02: three of
  go-to-k/cdkd#2428's round-2 fixes reverted green; go-to-k/cdkd#2450's
  escaping fix stayed green weakened to keys-only because its fixture had
  nothing to escape).
- **Reviewer subagents spawned BY A LANE report to the MAIN session** — a lane
  that dispatches and waits blocks forever (go-to-k/cdkd#2417). Pick one shape:
  the lane runs them synchronously, or the parent dispatches and relays down
  (§9's queued-versus-`Resuming` rule); §5-g owns the rest of the plumbing,
  including the lane whose OWN report never arrives.

### 8-c. The live-test tiers

Run `/verify-pr`. It layers CI status, docs consistency, AWS-resource cleanup,
code review, and a **live-test of the changed behavior** on top of `/check`.
Unit tests passing is necessary but NOT sufficient:

- **Deletion / DAG-order / state-cleanup change** → unmergeable until an
  integ's **destroy** step completes cleanly (`integ-destroy`, plus
  `integ-broad` for cross-cutting files). Run it via **`/run-integ <name>`**
  — never raw `cdkd deploy` / `cdkd destroy` from a shell (CLAUDE.md carries
  that rule and why), and **the bypass is not those two command NAMES: it is
  any real-AWS work outside a fixture** — `node dist/cli.js <anything>` and
  hand-made test resources are the same act, EXIT traps and all
  (go-to-k/cdkd#2653). `/pick-integ` chooses the fixture(s) and marks which are
  maintainer-only — never name one it flagged.
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
    scratch copy or a re-applied sed-swap, never `git checkout -- <path>` /
    `git restore <path>` (`dirty-path-restore-gate` blocks that form on a
    DIRTY path — go-to-k/cdkd#1700 lost ~200 lines). Flag-order
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
assertion. The vacuity shapes, none visible by reading the script
(go-to-k/cdkd#2108 / go-to-k/cdkd#2109):

- **The host has the trigger but not the EVIDENCE, or the reverse** — a fix
  keying on recorded state needs the state AND the thing it describes in the
  SAME unit. Adding one small resource to the stack already carrying the
  evidence is cheaper than a new fixture: check before calling a live arm
  `next`.
- **The arm is INERT because the command returns early** — when the fix SKIPS
  something, a fixture whose ONLY difference is the skipped thing gives the
  command no work ("nothing to revert": two live writes, zero signal). Give
  the fixture a second, ORDINARY difference, and a phase proving the premise
  before the phase that depends on it. **A phase re-deploying a template
  byte-identical to an earlier phase's is that trap with no fix to blame** —
  the diff is `NO_CHANGE`, the flag under test is never read (the engine
  consults it only under `case 'UPDATE'`), the phase cannot pass, and `set -e`
  takes every later one with it (go-to-k/cdkd#2565: the fixture stopped at
  that phase and the three proving the regression never ran, past every
  author-side round). Make each phase assert its own change LANDED first.
- **The arm's PREMISE is out of scope, and the tell is both counts zero** —
  `0 leaks AND 0 masks` is an arm that did nothing (go-to-k/cdkd#2176: the
  spelling used was one cdkd deliberately does not resolve, so nothing was
  ever plaintext). Prove the premise independently before reading the
  assertions.
- **Any outcome REACHABLE BY TWO PATHS is a confluence point** — "the bad
  value was not written" is satisfied by a correct refusal AND by any
  unrelated failure that stopped short (measured: fix mutated back, arm
  stayed green because the revert had errored instead of writing); a REFUSAL
  is satisfied by the guard firing AND by the probe behind it failing
  (go-to-k/cdkd#2565: a missing `logs:DescribeLogStreams` grant promotes to
  the same refusal, so on a role that cannot probe, the phase passes
  exercising nothing). Assert the POSITIVE marker only the intended path
  emits; demote the other to a stated safety net.
- **Every assertion PREDATES your change → the run is somebody else's
  regression net.** `git diff origin/main -- <fixture>` and ask which
  assertion could only pass AFTER your change; if none, add the
  discriminating one, guarded against vacuity (an absence-from-an-array
  assertion must first require the array to exist).
- **The inverse, when a fix REMOVES a behaviour: an assertion that it HAPPENS
  goes over-determined, not red** (three fixtures kept passing on accumulated
  delete markers after go-to-k/cdkd#2450). Sweep by the assertion's SHAPE, not
  the issue's wording, and RE-POINT each hit rather than deleting it — a
  deleted negative control leaves that direction unfenced. **The sweep must
  reach `tests/integration/**/verify.sh`**: vitest's `include` is `*.test.ts`
  under `tests/` and `src/`, which no shell fixture matches, so a `verify.sh`
  pins a contract no suite EXECUTES (several read them as text) and no
  diff-reading reviewer sees — go-to-k/cdkd#2882 round 8: `secrets-array-nested`
  FAILED on a negative control still pinning the residual the PR retired, "the
  real-AWS integ round caught what six review rounds did not".
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
-rf` in cleanup deletes the workdir before its first write); before waiting for
a resource to disappear, verify the probe reports "still present" DURING
deletion, else the wait is vacuous; and a fixture whose only `cdkd destroy`
fails BY DESIGN cannot honestly flip `integ-destroy` — add a final phase that
disables the injection, redeploys, and destroys cleanly.

### 8-e. Watching runs and pollers

**Never leave a real-AWS run unwatched** — a hung integ is indistinguishable
from a slow one (one wedged in `docker push` for 4h17m). `/run-integ` step 5
carries the watchdog recipe and why `timeout` is not the answer; pair it with
a `Monitor` on phase lines AND on log-growth stalling.

- **ANCHOR the predicate a poller waits on** — a premature DONE is acted on.
  Wait on a line the job writes only at the END, anchored
  (`grep -q "^suite_rc="` — an unanchored `test_rc=` matched
  `typecheck_test_rc=` from an earlier step; `[ -s "$f" ]` was satisfied by
  the job's own first echo), and confirm the process is gone (`pgrep -f`).
- **The harness's "completed, exit 0" is the exit code of the command you
  BACKGROUNDED** — `nohup <job> ... & echo started` reports success while the
  job still runs. Run the long job as the SOLE command of the backgrounded
  call and read the log's own terminal line. Nearby trap: a `cd` inside the
  backgrounded compound leaves the parent's `$VAR` unset.

### 8-f. Fixture environment prechecks

**Check a fixture's unstated PRECONDITIONS before spending a run** — fixtures
refuse rather than explain (`asset-bootstrap` took three attempts: it needs a
CDK-bootstrapped region with no cdkd marker). Both are two commands:

```bash
aws s3api head-bucket --bucket "cdk-hnb659fds-assets-<acct>-<region>"   # CDK-bootstrapped?
aws s3 ls "s3://cdkd-state-<acct>/cdkd-bootstrap/"                       # which regions cdkd owns
```

**A docker-dependent fixture is an environment blocker — prefer one reaching
the same code without it** (on the merits, not availability). When docker is
required (`integ-local`), verify registry reach FIRST (`docker pull
hello-world` under a 120s cap) — `docker version` says nothing about registry
networking. `/run-integ`'s "Important" section owns the rest: hang diagnosis,
the do-NOT-restart-Docker rule, and that a run blocked before its assertions is
not a failing fix (with its ledger note).

### 8-g. Prose claims are verified to the same bar as code

Only the code half of a diff has tests behind it; commit messages, changelog
entries, PR bodies and rationale comments have none. Habits that each caught a
false claim a review round had read past:

- **A claim inherited from the ISSUE BODY is the least trustworthy of all** —
  re-verify an issue's mechanism against current `main` before restating it
  (a later PR may already have falsified it).
- **A correction can be a new false claim** — twice the replacement sentence
  was wrong in the other direction. Re-read a correction against the code.
- **A round finding the SAME CLASS twice, or TWO SPELLINGS of one question,
  means stop fixing instances** — name the site that OWNS the question and
  make every other site call or copy ONE
  predicate verbatim, because a better second spelling looks like a fix and
  passes its own test (go-to-k/cdkd#2134: `producerRegion !== undefined`
  disagreed with the authority's `if (!producerRegion)` on the empty string,
  fail-OPEN). Four rounds on go-to-k/cdkd#2719 each subtracted one input from a
  label meant to mirror a dispatch; every fix was correct and incomplete. The
  tell: a finding differing from the last only in which input it names.
- **In a FIX round, the fix invalidated your own prose** — every past-tense
  measurement is stale until re-derived (one run: one code defect, TEN false
  claims). Before a fix round is final, re-derive every
  `file:line`, ledger citation and "measured" verb, and say which tree they
  came from; for NUMBERS see the COUNT bullet below.
- **The remedy is to DELETE the unproved clause, not rewrite it — and write
  the survivor in the DANGER direction**: say what the code mechanically does
  and what can still go wrong. The falsified ones were REASSURANCES — a closure
  claim, a closed-set enumeration, a "reduces", "nothing makes that case worse"
  — asserting over inputs nobody enumerated. Every surviving
  affirmative NAMES its backing; one that cannot is DELETED rather than
  verified. The recurring form is a CONSEQUENCE bolted onto a verified claim
  ("X is load-bearing: deleting it would hard-fail" — X probed, the consequence
  never). Dated measurement (2026-09-09, go-to-k/cdkd#2842 / go-to-k/cdkd#2873):
  over ten rounds, nine reassurances falsified — re-READING caught none, running
  the claim caught all, two survived a security reviewer's endorsement. Deleting
  a whole CLAIM cannot introduce a new false one; deleting a clause from INSIDE
  a sentence can falsify the survivor.
- **A claim outlives the sweep that corrected it. Sweep by CLAIM, over
  NORMALISED text** — every TRACKED file, comment leaders stripped, whitespace
  collapsed, matched ACROSS line breaks — **subtracting only what you can name a
  reason to exclude**; never a list of the trees you expect it in, and never
  `git grep`, which does no normalising. Derive the spellings from the
  PROPOSITION, not the wording in front of you: a value *lands in* / *reaches* /
  *appears in* / *is written to*.
- **Then STOP hardening the sweep: a claim falsified ONCE becomes a FENCE.**
  Enumerating spellings has no termination proof. In go-to-k/cdkd#2878 one
  proposition beat five vocabularies in turn — two tree lists, a line-oriented
  grep (copies wrapped as `performs no\n# AWS mutation`), a normalised grep
  holding `lands in` but not `reaches`, and an independently derived synonym set
  that found three more — so **report what the METHOD returned, never that the
  claim is gone**, and register the proposition instead. A sweep audits once and
  nobody can prove it complete; a fence reds on the NEXT occurrence, including
  one worded in a vocabulary nobody thought of, because it tests the CODE's
  truth rather than the text's phrasing. cdkd's home is `FALSIFIED_CLAIMS` in
  `tests/unit/scripts/integ-s3-versions-harness.test.ts` — each entry carries
  why the claim is false and a `retired` sample the pattern MUST still match, so
  a rotted regex fails loudly.
- **A COUNT is never repaired by recounting** — give every number in published
  prose one of three DISPOSITIONS: delete it (preferred — an enumeration IS its
  own count), fence it with a
  floor AND a cap from a test that reads the code, or attribute it as a dated,
  explicitly non-derivable measurement. Recounting fails because a set that
  GAINS or LOSES a member — a fix closing one counts — falsifies counters in
  files the diff never touches (go-to-k/cdkd#2519: seven drifts, one inside the
  sentence announcing the previous three). Sweep them by the bullet above, then
  dispose of each — a silent renumber makes the next reader re-file it.
- **Write the rationale FIRST in a fix round** — the one rationale-first
  round of four was the only one that introduced no new prose defect.

### 8-h. Reviewer findings are inputs, not verdicts

- **A NIT is not a work item.** Fix what a reviewer DEMONSTRATES is wrong;
  leave the polish. Over four rounds on go-to-k/cdkd#2592 every blocker was
  fixed correctly and every NEW defect came from a low-severity suggestion —
  a "no escape hatch" nit produced a flag that could not reach green. The
  tell: the new code answers a hypothetical, not an observation. When three
  rounds have each found a defect inside the last one's fix, WITHDRAW the
  addition rather than bounding it — §8-a's blocker count names which one — and
  brief the next round to report only demonstrable defects.
- **After several rounds, ask whether the change is worth merging AT ALL, and
  say you are not looking for reassurance** — price the residue in what an
  adversary pays (go-to-k/cdkd#2333 buys one byte: an 18-byte residue against
  the 17-byte shape closed, so the incidental case is the purchase). The
  question returns a merge CONDITION; "any blockers?" cannot.
- **A reviewer's suggested FIX can be wrong even when its finding is right**
  — derive regexes, bounds and constants from the code that PRODUCES the value
  and probe both directions (go-to-k/cdkd#2052).
- **Check a reviewer's PREMISE before acting, and record a decline in the PR
  body** — with evidence it can be re-judged; silently dropped it reads as an
  oversight.
- **An ABSENCE claim ("that string is nowhere in the source") is the one a
  reviewer is least able to establish — verify it by RUNNING the thing said
  not to exist.** **A grep cannot see an INTERPOLATED string**:
  go-to-k/cdkd#2553's reviewer called a live integ sentinel dead over a needle
  built at runtime from `Failed to ${changeType} ${logicalId}`. Find the
  TEMPLATE.
- **Your own BRIEF is a published claim** — grep every mechanism claim before
  it ships in an instruction; the trigger is DESTINATION, not doubt. **A brief
  TRUE when sent goes false inside the RECIPIENT's own commit** — re-derive
  every briefed measurement against the tree you are about to push
  (go-to-k/cdkd#2697: a lane's same-commit alias pass left the briefed
  addition inert).
- **A REVIEWER brief fails worse** — a false premise aims the round at the
  wrong subject and the report still reads as authoritative (one false
  mechanism reached three briefs). Correct one in-flight.
- **When two reviewers CONTRADICT each other, settle it in the code yourself**
  — say which was right and why. **For a claim about an EXTERNAL system the
  tie-break is a MEASUREMENT** (go-to-k/cdkd#2274, a `NoEcho` dispute settled
  by a live CFn A/B): a disputed sentence naming a SERVICE, not a file, means
  stop reading and measure.

### 8-i. Fresh deploys, markers, and who sets what

**A fresh deploy is a fresh FIXTURE**: `/new-integ` scaffolds one, `/run-integ`
deploys and tears it down (§8-c). **UNIQUE stack names only**
(e.g. `Cdkd<Issue>Verify`), never a shared fixed name — the account may hold
the maintainer's production stacks. After teardown, sweep for orphans it cannot
reach (auto-created `/aws/lambda/*` log groups, RETAIN resources, Secrets in
recovery, KMS keys pending deletion), then run CLAUDE.md's post-integ
leftover check — the `deployments/` events store legitimately survives it.

`/verify-pr` sets `check` + `docs` + `verify-pr`; `/run-integ` sets the
`integ-*` markers — together they unblock `gh pr merge`.

**`pr-review` is not on that list, and a LANE must never set it.** `/review-pr`
writes it, run by the ORCHESTRATOR after its dispatched reviewers report and
every blocker is addressed — a lane setting it is the "sub-agent self-review
is not independent review" failure arriving through the marker (two of three
lanes on 2026-08-29, go-to-k/cdkd#2383; twice more on 2026-09-04 — only the
lane whose BRIEF named the prohibition obeyed, so put it there too). The merge
gate cannot catch it: the sentinel is per-worktree and §9
merges from the lane's worktree, so a lane setting it after its final push
matches. The PARENT can, and it is a named step of its own round — read the
marker BEFORE running `/review-pr`, since one already fresh there can only be
the lane's (`mise exec -- markgate verify pr-review`, then
`.markgate-pr-review-sha` against `git rev-parse HEAD`; a sha that is not HEAD
is the tell). On a hit, review from scratch.

**And your own review round is not optional because the lane already ran one.**
A lane's reviewers are its children — same brief, same framing — so what they
cannot doubt is the premise the lane handed them (go-to-k/cdkd#2383: three
rounds of lane reviewers each found the next spelling of one defect; the
independent orchestrator round found the YAML merge key the lane's own
tripwire had been added to backstop and did not fire on). Take the tier the
heuristic gives for YOUR pass, and keep the LATE rounds independent too —
author-side round COUNT does not converge on the author's blind spot
(go-to-k/cdkd#2519: its lane rounds reported no blockers; later independent
rounds kept finding deltas INSIDE the previous round's fix). Three rounds of
that shape means change the METHOD, not add a round — §5's "three spellings in
three rounds". Review the FIXTURE as part of that diff, not as scaffolding
around it — go-to-k/cdkd#2565's merge blocker was there (§8-d).

**A reviewer's scratch COPY of a worktree is not detached from git** — a linked
worktree's `.git` is a FILE pointing into the main repo, and `cp -R` carries
the pointer, so a read-only reviewer's `git add -A` inside its copy staged
three deletions in the LIVE tree (2026-08-29). `.claude/agents/pr-*-reviewer.md`
carries the two lines every read-only brief needs. If damage happens anyway,
the repair is `git restore --staged` (the INDEX only), the one carve-out.
