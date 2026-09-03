<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge (`/verify-pr` + `/run-integ`)

**When a fix round produces the NEXT round's blocker twice, stop reviewing the
patch and question its SHAPE.** One lane ran FIVE rounds (2026-08-20) in which
every blocker was created by the previous round's fix — each locally correct,
moving the failure one layer out — and every one was found by executing a
probe or tracing a window, never by re-reading the diff (twice a comment
confidently asserted the opposite).

- **After round two, ask what the rounds have in common.** There it was one
  structural absence (`destroy.ts` registers no command-level SIGINT handler
  while `deploy.ts` does — why only the destroy path kept generating
  instances). Naming it names what everyone is chasing.
- **Do NOT take the structural fix late in the cascade.** New code in a
  command entrypoint at round five is how round six happens. Take the narrow
  fix, file the structural one, and reference it from the narrow fix so the
  choice reads as made, not missed.
- **But filing the structural fix does not STOP the cascade.** In
  go-to-k/cdk-local#596 (2026-08-27) it was filed at round five and the rounds
  ran to TWELVE. What ended it was making the artifact **CLAIM LESS**: the tell
  is that each round's fix is more SOPHISTICATED than the last while the plain
  rc-only sweeps nearby were right all along (a `grep -q 'does not exist'` also
  matched botocore's own `source_profile ... does not exist`, raised before any
  network call, so a broken profile reported CLEAN having queried nothing). The
  sweep now prints raw output and names both outcomes instead of emitting a
  verdict — a command that claims nothing cannot claim something false. Expect
  it to feel like a retreat; it is one, and it converges.
  - **Fence the REMEDIATION, not just the detection.** The last instance was
    in the repair: `cdk destroy` on names built without the required suffix
    exits 0 SILENTLY, and every fence pinned the DETECTION, so restoring that
    line left the suite green. Where a procedure both detects and repairs,
    the repair is where the next instance goes.
  - **Do not pre-commit to a remedy for a finding you have not seen.** "If
    instance nine appears, delete the whole thing" was announced in advance;
    when it arrived, deleting would have left NO check at all. Say what the
    next finding would have to SHOW, not what you will do about it.
- **Ask whether the thing you keep patching is a CLASSIFIER, and if it is,
  stop and build the differential fence in §5 before the next fix.** Nobody
  asks the question inside a cascade. go-to-k/cdkd#2027 (2026-08-21) ran FIVE
  rounds, each finding a spelling the previous had not, rounds 3–4 adding
  five regressions to the functions under repair; the differential walk ended
  it in one round, by construction. The tell is not the round count: it is
  that every round's finding is a new INPUT CLASS the code got wrong rather
  than a new place the logic was wrong — when that is the shape, stop
  patching instances.
- **When the shape is "THE FENCE COVERS ONE ROW OF A MULTI-DIMENSIONAL
  GUARANTEE", widen it to the CROSS PRODUCT before the next fix.** Unlike the
  shapes around it this is a defect in what can OBSERVE the fix, so a fix can be
  wholly INERT with every signal green. The tell: the guarantee ranges over two
  independent things (position AND reader, mode AND platform) while the suite
  varies one at a time. Count the cells; if the fence has fewer assertions than
  cells, name the uncovered ones and probe one. **The uncovered cell is not
  random** — a hazard lives there BECAUSE that cell behaves differently, which
  is why a "representative case per dimension" skips it. Measured 2026-09-03,
  go-to-k/cdkd#2466: "every scalar round-trips" spans 4 positions x 2 YAML
  readers; the suite covered 4 under 1.2 plus ONE under 1.1, and `<<` (the 1.1
  merge key, special only as a KEY, only under 1.1) sat in the missing cell — so
  its fix shipped inert through a full 3-axis round, the library's merge tag
  discarding a correctly-set style. Widening the 1.1 arm to four positions reds
  it; nothing did before.
- **When the shape is "TWO SPELLINGS OF ONE QUESTION", the fix is to make both
  sites use ONE predicate verbatim — not to write a better second spelling.**
  A better spelling looks like a fix and passes its own test.
  go-to-k/cdkd#2134, three rounds: resolver-identity was wrong (a same-region
  producer yields the same resolver); `producerRegion !== undefined` was
  still a second spelling, disagreeing with the authority's own
  `if (!producerRegion)` on the empty string, fail-OPEN. Only copying the
  authority's test character for character ended it — name the SITE THAT OWNS
  the question and make every other site call or copy it exactly.
- **When the shape is "A PROXY FOR A QUESTION ONLY ANOTHER COMPONENT CAN
  ANSWER", the fix is to make that component REPORT — and the tell is that
  each proxy is wrong in BOTH directions at once.** Two spellings DISAGREE at
  an edge; a proxy has no access to the fact at all. When a round's fix lands
  on a new observable rather than a new spelling ("it threw", "the text
  survived"), ask whether the fact is derivable outside the component that
  decides it; if not, the rounds are unbounded. go-to-k/cdkd#2157 /
  go-to-k/cdkd#2166: "it THREW" missed `resolveSub`'s warn-and-KEEP path and
  over-reported an unrelated `Ref` failure sharing the bag; "the raw text
  SURVIVED" missed a rewritten leaf, broke on JSON escaping, and fired
  PERMANENTLY on prose that merely mentions the syntax.
- **WITHDRAWING the half that cannot be made right is a legitimate outcome,
  and the residual issue must carry the MEASUREMENTS, not just the
  diagnosis.** File each proxy tried, the input that broke it, and the number
  it produced — a diagnosis alone makes the next session re-run the probes.
  The go-to-k/cdkd#2166 filing carries all three rounds plus a live arm
  written, passed, mutation-probed and reverted, so none of it is rebuilt.

**When the fix WIDENS what a guard catches, the thing you removed may have been
load-bearing — and your instrument for measuring that can be structurally blind
to it.** Ask before believing a widening safe: *what was the thing I am
deleting actually doing?* go-to-k/cdkd#2333 (2026-08-27, WITHDRAWN after four
rounds): dequoting structural tokens closed a real bypass, but the only brake
on a widened `GATE_FLAGS` was that a QUOTED later token happened not to match,
so removing it BLOCKED `git show "commit"` and 15 more ordinary commands. The
bypass was real and the fix was worse — and the survey could not have told you,
returning `NEWLY CONSIDERED 0` because every text it probes lands in ARGUMENT
position, never the flag PREFIX where the change acted. A measurement taken in
the wrong position is not weak evidence, it is none, and it reads identically
to the real thing: name the POSITION your change acts in, confirm the
instrument probes it, and build the arm that does before quoting a zero.

- **Derive the reader population before patching readers.** Four rounds each
  found one more consumer deciding a gate outcome from the same text; one
  grep — `grep -n '\[\[ "\$segment" =~'` — returns all eight lib sites at
  once. Patching one per round is how a cascade reaches round four still
  claiming closure.
- **A benchmark must exercise the path the change is on.** The lane published
  "+20% latency" from a run whose command MATCHED, with the new code after an
  early `return` taken on a match — it measured noise (re-measured +0-3%; the
  real cost was quadratic on large input). Confirm the probe reaches the
  added code, as §5 requires of a mutation probe.

**A round's fix that CLOSES a member falsifies every sentence that COUNTS the
set — the direction nobody checks, because the fix itself is CORRECT.** Prose is
a reader too (bullet above) and the one whose staleness a diff cannot show: the
member LEAVES in the diff, while the counter that still includes it sits in a
file the diff never touches. Measured four times in ONE run (2026-09-02,
go-to-k/cdkd#2410 / go-to-k/cdkd#2275): closing `spawnStreaming` left six sites
saying "THREE mechanisms still reach stdout"; closing `spawnForeground` made the
corrected count wrong again; `logger.ts`'s caller registry said "four" once
`state list` became the fifth; and `docs/cli-reference.md` said "nothing is
locked on the refusing path" while four commands hold a lock there. A REVIEWER
caught every one and the author none. A fence's own comment is the same surface,
and its coverage claim is TESTABLE: one asserting it missed only PROSE missed
five CODE spellings, among them an aliased import that no needle on the name can
reach by construction.

```bash
# The counters sit OUTSIDE the diff, which is why re-reading the diff misses them.
grep -rn "<the set's noun, then its cardinal>" src/ docs/ .claude/
```

NAME the member you closed where the count lives; a silent renumber is what
makes the next reader re-file it.

**Run the integ LAST — after the final edit to any gate-scoped file, not after
the final edit you happened to think of.** Review nits landing in gate scope
stale the marker: 2026-08-25 cost two real-AWS re-runs (go-to-k/cdkd#2189, a
quoting fix in the same `verify.sh`, `integ-local` scope; go-to-k/cdkd#1978, a
clock threaded through both DynamoDB providers, `integ-destroy` scope) — both
correct, the gate doing its job. Sequencing: dispatch reviewers, apply EVERY
finding including the nits, THEN rebase, THEN run the integ, THEN set the
markers.

- **Before starting an integ, ask what is still outstanding.** A reviewer
  still running, an unapplied nit, a coming rebase each stale the marker.
  `git diff origin/main...HEAD --name-only` against the gate's include list
  answers it in one command.
- **A rebase can stale a `hash: diff` marker on its own** — the merge base
  moves, so an in-scope file changed by an incoming merge that this branch
  also touches invalidates it. That re-run is unavoidable: rebase BEFORE the
  integ, and expect `markgate verify` to be what tells you.
- **Under ITERATIVE review rounds, "last" does not hold still — so DECLARE
  the tree final, in words, to whoever is still editing it.** Every round
  touching a gate-scoped file buys another real-AWS run — even a comment-only
  delta, since `hash: diff` digests the delta, not the behaviour (2026-08-26:
  THREE `ecs-service-update-props` runs, the third for zero non-comment
  lines). Tell the implementing agent to **batch every remaining finding into
  a single commit and report when the tree is FINAL, with no second pass** —
  an agent handed findings will otherwise fix, verify, and hand back, right
  everywhere except before a real-AWS gate. For reviewers, the reverse:
  dispatch a round SCOPED to the delta and ask for the whole round's findings
  at once, not trickled — **and paste the delta's COMMIT MESSAGE into the
  brief.** All four reviewer agents read `gh pr diff` / `gh pr view --json
  files` (`.claude/agents/pr-{code,spec,test,security}-reviewer.md`) and none
  reads `git log`, so a false claim written into a commit message is invisible
  to the whole tier however many reviewers you dispatch. Measured 2026-08-29:
  a delta round's blocker was a commit message citing a function that has
  never existed in this repo, reachable only because the orchestrator re-read
  the message itself.
- **An EXEMPTION is the highest-risk edit a fence can receive, and every round
  that adds one should probe it in both directions before the round ends.** A
  carve-out is added to stop a false positive, which means it is written while
  agreeing that the fence was WRONG — the exact posture in which nobody asks
  what it now lets through. Measured across one change on 2026-09-02, where
  three consecutive delta rounds each found the round before it had traded a
  crude fence for a token-spendable escape: a line-wide `--no-guess` skip that a
  mention anywhere on the line could buy; a clause-wide negation marker that
  exempted ELEVEN prescriptive sentences the bare form had flagged, including
  the composite mutant's own command; and a sentence-scoped one that made an
  entire fenced code block inherit one exemption. Two questions close it, and
  both are cheap: does a PRESCRIPTIVE use of the same words spend the exemption
  (probe one), and is the exemption LOAD-BEARING at all — delete its wiring and
  the suite must go red, or it is indistinguishable from a fence that never had
  it. The second question is the one that gets skipped: a decorative carve-out
  reads as caution and is a gap.
- **Every fix a round applies is UNFENCED by default: the suite it passes is
  the suite that passed BEFORE it.** A finding's prose is not a test and a round
  adds no case unless you add one, so the round's green is the previous round's.
  Measured 2026-09-02: three of go-to-k/cdkd#2428's round-2 fixes each left the
  suite 27/27 GREEN when reverted, and go-to-k/cdkd#2450's escaping fix stayed
  green weakened to keys-only (its fixture had nothing to escape — the input
  shape, `references/implement.md`). Revert each fix in turn and require a red;
  one nothing reddens is a claim, not a change. The exemption bullet above is
  this rule's highest-risk instance, not a separate one.
- **Reviewer subagents spawned BY A LANE report to the MAIN session, not to
  the lane that spawned them.** Completion notifications go to the top-level
  session, so a lane that dispatches reviewers and then waits on their reports
  waits for something that cannot arrive, while the parent collects verdicts it
  did not ask for and may not connect to a lane. Measured 2026-09-02
  (go-to-k/cdkd#2417): a lane's two reviewers both delivered upward, the lane
  blocked, and the parent relayed both verdicts by hand. Pick one shape and say
  which in the dispatch: the lane runs its reviewers **synchronously** (so it
  holds its own turn until they return), or the **parent owns the review
  dispatch** and relays each verdict down — the latter under §9's
  queued-versus-`Resuming` rule, because a lane waiting on a review is stopped
  at exactly the moment the relay is sent.

Run `/verify-pr`. It layers CI status, docs consistency, AWS-resource cleanup,
code review, and a **live-test of the changed behavior** on top of `/check`.
Unit tests passing is necessary but NOT sufficient — the fix must be exercised
against real AWS:

- **Deletion / DAG-order / state-cleanup change** → unmergeable until an integ
  test's **destroy** step completes cleanly (the `integ-destroy` gate, +
  `integ-broad` for cross-cutting deploy/destroy files, is bound to a
  real-AWS destroy). Run it via the skill: **`/run-integ <name>`** — never
  invoke `cdkd deploy` / `cdkd destroy` from a raw shell; the skill encodes
  deploy + update + destroy + orphan-resource verification in one block and
  records the run into the committed ledger. Use `/pick-integ` to choose
  which fixture(s) cover the touched code.
- **Non-deletion source change** → still live-test the fixed path end-to-end
  (deploy → the redeploy-with-a-change that reproduced the bug → destroy)
  with a fresh fixture, or via `/run-integ` against an existing one.

**An integ ARM owes the same discrimination proof a unit test does, and it is
easier to write a vacuous one — so MUTATION-PROBE THE ARM against real AWS.**
An arm is the one place this flow routinely ships a fence nobody has watched
fail. The shapes (first, second and fourth measured 2026-08-21 on
go-to-k/cdkd#2108 / go-to-k/cdkd#2109; none visible by reading the script):

- **The host has the trigger but not the EVIDENCE, or the reverse.** A fix
  keying on recorded state needs the state AND the thing it describes in the
  SAME unit. `cdkd scrub` classifies only a literal `{{resolve:...}}` in the
  TEMPLATE, so the producer stack (literal, no cross-stack read on record)
  and the consumer (evidence, no literal) each had half — every fixture would
  have passed with the fix reverted. Adding one small resource to the stack
  already carrying the evidence made the arm real — cheaper than a new
  fixture, so check for it before calling a live arm `next`.
- **The arm is INERT because the command returns early.** When the fix SKIPS
  something, a fixture whose only difference is the skipped thing gives the
  command no work: a `drift --revert` arm tampered exactly the now-skipped
  property, so the revert reported "nothing to revert" — two live writes,
  zero signal. Give the fixture a second, ORDINARY difference alongside the
  one under test, and a phase proving the premise (really drifted, on the
  ordinary property) before the phase that depends on it.
- **The arm is INERT because its PREMISE is out of scope, and the tell is
  that BOTH counts come back zero.** `0 leaks AND 0 masks` is not a pass, it
  is an arm that did nothing. go-to-k/cdkd#2176 (2026-08-23): the arm used
  `{{resolve:ssm-secure:...}}`, a spelling cdkd deliberately does not resolve
  (`docs/scenario-coverage.md`), so nothing was ever plaintext and both greps
  returned `0`; `{{resolve:ssm:...}}` against a SecureString made it real. A
  second inert attempt: a deliberately malformed tag was dropped by CDK at
  synth, so the deploy simply succeeded. Prove the premise independently (the
  resolved value actually reached AWS) before reading the assertions.
- **The assertion is a negative, so it is a confluence point.** "The bad
  value was not written" is satisfied by a correct refusal AND by any
  unrelated failure that stopped short — measured: with the fix mutated back
  the arm stayed GREEN, because the revert had errored instead of writing.
  Assert the POSITIVE marker only the fixed path emits (a specific exit code,
  a string only the deep path prints, a `--json` field); demote the negative
  to a stated safety net, recording the measurement.
- **Every assertion in the arm PREDATES your change, so the run is somebody
  else's regression net.** If you changed no assertions, a green run says
  only that you broke nothing: a lane recorded `rollback-cross-region-secret`
  as live evidence (2026-08-21) while every drift assertion was
  byte-identical to `origin/main` and passed under the PRE-change shape — the
  one user-visible delta was asserted nowhere. Run
  `git diff origin/main -- <the fixture>` and ask which assertion could only
  pass AFTER your change; if none, add the discriminating one, guarded
  against vacuity (an ABSENCE-from-an-array assertion must first require the
  array to exist).
- **The inverse bites when a fix REMOVES a behaviour: an assertion that the
  behaviour HAPPENS does not go red, it goes over-determined.** Three integ
  fixtures asserted `lock.json` keeps noncurrent versions; after
  go-to-k/cdkd#2450 purged them the counts stayed non-zero on accumulated DELETE
  MARKERS, so all three kept PASSING while their comments became false. Sweep
  the test tree by the assertion's SHAPE, not the issue's wording — that is what
  turned up a THIRD copy the issue never named, already vacuous — and RE-POINT
  each hit rather than deleting it, since a deleted negative control leaves that
  direction unfenced.

The probe is one extra run of a fixture you are already running: revert the
fix, rebuild, run, confirm the arm goes RED, restore, rebuild. **Probe each
HALF of a multi-part fix separately, not just the whole.** A scrub lane's
probes (2026-08-21): reverting only the wiring red one assertion; reverting
only the pre-pass left that one PASSING while a different one went red —
proving the halves independently fenced, which a single all-or-nothing revert
cannot show. Also add a NEGATIVE CONTROL inside the arm — a sibling case that
must NOT trip the new behaviour — or a refusal that fires on everything
satisfies every positive assertion you just wrote.

**Never leave a real-AWS run unwatched, and do not reach for `timeout` to do
it.** A hung integ and a slow one look identical from outside (2026-08-20: a
fixture wedged inside `docker push` for 4h17m, noticed only manually).
`timeout` **does not exist on macOS** — the obvious guard exits 127 in 0s,
which reads as a run that completed instantly. Use a shell watchdog and make
the firing visible in the log:

```bash
LOG=$(mktemp)   # assign it HERE: a separate block is a separate shell, and
                # `> ""` is a loud failure that costs you the whole run
bash verify.sh > "$LOG" 2>&1 &
VPID=$!
( sleep 1500; kill -9 $VPID 2>/dev/null; echo "WATCHDOG_FIRED" >> "$LOG" ) &
WPID=$!
wait "$VPID"; RC=$?
kill "$WPID" 2>/dev/null
grep -c WATCHDOG_FIRED "$LOG" || echo "watchdog did not fire"
```

The `grep` is load-bearing: `kill -9` surfaces as rc=137, otherwise
indistinguishable from any other crash. Pair it with a `Monitor` that emits on
phase lines AND on log-growth stalling.

**ANCHOR the predicate the poller waits on, or it reports DONE while the job
runs.** A loose predicate fails in the direction that matters: a premature
DONE is acted on. Two shapes (2026-08-26): a non-empty test (`[ -s "$f" ]`)
on a file the job ECHOES INTO before starting — the first `PWD=...` line
satisfied it; and an unanchored substring — `grep -q "test_rc="` matches
`typecheck_test_rc=` from an EARLIER step. Wait on a line the job writes only
at the END, anchored (`grep -q "^suite_rc="`), and where the job has a
process, confirm it is gone (`pgrep -f`) rather than inferring from the file.

**The harness's "completed, exit 0" is the exit code of the command you
BACKGROUNDED, which is not always the job you care about.** With
`nohup <long job> > log 2>&1 & echo started` the wrapper returns immediately:
measured 2026-08-21, a suite reported "completed (exit code 0)" while still
executing 90 seconds later. Run the long job as the SOLE command of the
backgrounded call (no trailing `&`) and read the log's own terminal line, not
the notification. Two nearby traps: a `cd` inside the backgrounded compound
leaves the parent's `$VAR` unset, so a follow-up `grep "$LOG"` reads a path
that never existed; and `grep -c` exits 1 on a count of zero, so a
verification command ending in one reports FAILED for the very case it was
checking for.

**Check a fixture's unstated PRECONDITIONS before spending a run on it.**
Fixtures guard themselves and refuse rather than explain, so a wrong region
costs a full round-trip each time: `asset-bootstrap` took three attempts on
2026-08-20 — it needs a region that is **CDK-bootstrapped** (its legacy-mode
phase publishes to the CDK bootstrap bucket) AND has **no cdkd marker** (its
own guard refuses otherwise). Both conditions are two commands:

```bash
aws s3api head-bucket --bucket "cdk-hnb659fds-assets-<acct>-<region>"   # CDK-bootstrapped?
aws s3 ls "s3://cdkd-state-<acct>/cdkd-bootstrap/"                       # which regions cdkd owns
```

**A DOCKER-dependent fixture is an environment blocker, so prefer the one that
reaches the same code more directly without it.** `gc-custom-asset-names` was
abandoned (daemon down, then the push wedge) for `asset-bootstrap`, which
needs no docker AND exercises `AssetModeResolver` more directly — better on
the merits, not merely available. When docker is genuinely required
(`integ-local`), verify it can reach a registry FIRST — `docker pull hello-world`
under a 120s cap — because `docker version` answering says nothing about
registry networking, and that is the half that fails.

**Do NOT restart Docker to fix a hang — on Docker Desktop the restart IS the
likelier cause.** The daemon routes registry traffic through a proxy the
Docker Desktop **application** serves, so a quit-and-reopen can leave the
`com.docker.backend` watchdog up while the app never finishes launching: every
pull then waits on a proxy that is not there while `docker version` keeps
answering over the local socket (2026-08-20, four consecutive hung pulls; only
a manual app restart recovered). Diagnose in this order and STOP at the first
line that explains the symptom:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 https://registry-1.docker.io/v2/  # 401 = HOST networking is fine
docker info 2>/dev/null | grep -i proxy         # names the proxy the daemon depends on
pgrep -f 'Docker Desktop' >/dev/null && echo app-running || echo APP-NOT-RUNNING
```

Registry reachable + daemon proxy + no app process is the whole diagnosis: the
app must come up. Ask the maintainer rather than escalating — factory reset,
deleting Docker's data, or rewriting the proxy config destroy local images and
volumes, never yours to spend. Clean up your own probes too: `kill`ing the
wrapper of a `docker pull` leaves the `com.docker.cli` child running.

**A run blocked before its assertions is not a failing fix, and the ledger note
is where that distinction survives.** Record it as `FAIL` (the bar is
exit-code-based) with a note naming the blocker, saying the change was not at
fault, and listing any AWS resources the aborted run created and you removed
by hand — otherwise the next reader concludes the merged fix is broken.
- **Any diff with no `src/**` change** (docs, toolchain, CI, hooks, skills,
  tests, config) → EXEMPT from the deploy / destroy live-test tiers above,
  never from `/verify-pr` step 9, and never from `verify-pr` itself — that
  gate has no diff-shape carve-out. This is the easy tier to under-verify:
  with no integ that can fail, "the gates are green" reads as "nothing left
  to check". **And never conclude a CI job cannot fail on your diff from
  that job's NAME or its usual scope** — a job's name bounds where it READS
  from, not what it ASSERTS. The go-to-k/cdkd#2236 lane (2026-08-26) skipped
  the full suite on "a `src/**` / `tests/**` job cannot fail on a
  `.claude/**`-only diff" and went red:
  `tests/unit/scripts/rule-file-payload.test.ts` lives under `tests/` with
  jurisdiction over the WHOLE tree, and any repo-wide fence (a byte cap, a
  corpus scan, a `git ls-files` walk) sits inside some job whose name
  suggests a narrower reach. What SATISFIES step 9 depends on what the diff
  changes; a diff that does both takes BOTH arms.
  - **It changes what a command or gate DOES** (a build / lint config, a CI
    workflow, hook logic, a `vite.config.ts` task) → the verification IS
    that command; those runs ARE step 9's live test. Run *the command your
    own diff changes*: `.claude/hooks/run-tests.sh` (or the single
    `.claude/hooks/<name>.test.sh`) for a hook, the workflow step's own
    command for CI, the changed task for `vite.config.ts`, `vp run check`
    for the lint / typecheck config. `vp run check` is not the universal
    answer — it reads neither `ci.yml` nor any hook, and its lint is scoped
    to `src/**`, so for a hook diff it is a probe that cannot fail.
    - **Run it more than once, BEFORE and AFTER.** The `check` task carried a
      replayable cache until 2026-08-30, so a bare repeat replayed
      (`cache hit, replaying`) instead of re-running; it is `cache: false` now,
      as is every other task. The `--no-cache` form below is no longer needed
      for that reason, but the flag-order trap is recorded because it still
      applies to any `vp run` flag.
      **Flag order is the whole trap** (go-to-k/cdkd#2017):
      `vp run check --no-cache` forwards the flag to `vp check`, which
      rejects it — exit 1 from a command that never ran the check, exactly
      the rc that reads as a real failure. **Read that help through
      `mise exec`, not the bare binary** — the pinned vp documents the flag
      under `vp run --help`, the stale global does not, and a stale global
      CLI reads as a missing feature. The flag skips the cache without
      invalidating the entry (`vp cache clean` removes it). Do not
      substitute a bare `vp check` for `vp run check`: `/check` step 1
      records the two are NOT equivalent. A replay cannot surface what
      repeats are for — an rc that differs across identical runs:
      go-to-k/cdk-real-drift#1761 had `vp run check` abort rc=134 (a Vite+
      stdout EAGAIN panic) while reporting 0 errors, and cdkd runs the same
      bare command in `ci.yml` with no redirect workaround. For the BEFORE
      tree use a scratch copy or a re-applied sed-swap — never
      `git checkout -- <path>` / `git restore <path>`, which
      `dirty-path-restore-gate` blocks on a dirty path: undoing a probe
      that way once discarded ~200 lines of unrelated uncommitted work
      (go-to-k/cdkd#1700).
    - **Drive the FAILURE direction too**, since a config change that
      swallows an exit code also turns a red tree green. For the lint gate,
      append an unused variable to a `src/**` file and do not name it `_*`:
      `lint.ignorePatterns` is `['**/*', '!src', '!src/**']`, so a probe
      under `tests/**` is never linted, and `no-unused-vars` ignores `^_`.
      Verified 2026-08-19: that probe takes `vp run check` to rc=1. **Then
      revert the probe before committing** — left in, it makes this a
      `src/**` PR under a different §8 bullet and commit prefix. Re-apply
      the scratch copy (`check` is `hash: files`, so the marker verifies
      fresh once bytes match); re-run `/check` if the fix landed after you
      recorded it.
    - **Then guard the SHAPE of the fix with a test**, since nothing else
      re-reads a build-config or workflow line. `vite.config.ts` /
      `scripts/**` / `ci.yml` → `tests/unit/scripts/*.test.ts`, with
      `matrix-regen-coverage.test.ts` as the pattern (asserts both
      directions against `ci.yml`, with a parser floor so "found nothing"
      cannot pass as "everything matches"). `.claude/hooks/**` → a case in
      the hook's own `<name>.test.sh` (create one where none exists). Where
      no harness can read the artifact — a `.mise.toml` pin, an action SHA
      bump — say so in the PR body instead of inventing one.
  - **It changes PROSE only** (a skill, a rule, a doc — including this file)
    → the CLAIMS are the artifact. Resolve every gate, hook, skill, path,
    task and command the new text names against this repo's own files, and
    RUN each command the text will send the next agent to run, confirming
    its output matches what the text promises (§10-c's claim-by-claim pass,
    owed whether or not the text came from a sibling repo).

**A fixture that establishes its precondition on the HAPPY path cannot test the
arm where the FAILING path creates it — and it stays green while the fix is
inert.** Every signal says pass. The go-to-k/cdkd#2057 lane (2026-08-20)
shipped a refusal that could not fire: its evidence (`state.imports[]` /
`outputReads[]`) was persisted only by the SUCCESS path, so a deploy that both
INTRODUCES a cross-region read and fails recorded none of it — yet the fixture
passed, having established the read with a successful deploy first. Four
diff-reading reviewers passed it; a fifth found it by tracing the evidence.
When a fix keys on state some earlier step wrote, ask **which step wrote it in
the fixture, and which step writes it in the reachable case**. If the answer
is "an earlier, successful one", add the arm where one operation does both —
and prove it discriminates by mutating the fix and confirming the ORIGINAL arm
still passes while the new one fails; an arm that fails alongside the old one
has not shown it reaches anything new.

**An arm added to a SHARED fixture must not touch an identifier that fixture
REUSES.** A name left in a state AWS will not immediately re-issue blocks
every LATER phase — and the next run, for anyone. go-to-k/cdkd#2227
(2026-08-26): the arm planted the STACK'S OWN bucket name in a second region;
once an S3 bucket name has existed in one region, re-creating it in ANOTHER
answers `OperationAborted` for a long time (~58 minutes to free) while
`HeadBucket` already reports 404 — blocking every `s3-lifecycle` run for most
of an hour. Give the arm a PER-RUN UNIQUE identifier, created only when the
arm asks (one env var the fixture sets and the CDK app reads,
`CDKD_XR_ARM_BUCKET`), verified by `cdk synth` in both polarities. Also: a
bucket mid-delete surfaces as `OperationAborted`, which cdkd classifies as
transient and retries — NOT as `BucketAlreadyOwnedByYou`.

**Three fixture mechanics that each cost a real-AWS cycle on 2026-08-20.**
None visible by reading the script; all three caught by a stubbed dry run in
seconds:

- **A `cleanup` that ALSO runs pre-run must not destroy anything the run then
  needs.** AWS resources are safe because creating them IS a phase; a
  scratch directory computed at variable-definition time is not. A
  `WORKDIR="$(mktemp -d …)"` at load time plus `rm -rf "$WORKDIR"` in
  `cleanup` plus the usual explicit pre-run `cleanup` call means the
  directory is gone before its first write, 200 lines from the cause.
- **Before you wait for a resource to disappear, verify the probe reports
  "still present" DURING deletion.** `DescribeStateMachine` on a deleting
  machine returns success with `status: DELETING`, so the poll really waits;
  had it 404'd, the wait would have been vacuous. Measure the window (23s
  there) so the budget is a number, not a guess.
- **A fixture whose only `cdkd destroy` exits non-zero BY DESIGN cannot
  honestly flip `integ-destroy`.** A refusal arm is a destroy that reports
  failure, and out-of-band teardown is not a cdkd destroy, so the marker
  would attest to a clean teardown that never happened. Add a final phase
  that disables the injection, redeploys, and runs a genuinely clean destroy
  — that run is the one the gate reads.

**Run the integ AFTER the final rebase, and expect the marker to go stale if
you do it before.** `integ-destroy` uses `hash: diff`, so it invalidates when
main merges a change to a file YOUR branch also touches: the go-to-k/cdkd#2057
lane ran three integs, rebased onto a peer PR that had edited
`deploy-engine.ts` (which it also edited), and bought a second real-AWS run at
merge time. Push first so CI starts, then re-run the integ alongside it — the
two are independent, and serializing them wastes the CI wall-clock.

**Verify the CLAIMS your fix ships with, to the same bar as the fix.** Only
the code half of a diff has tests, a type checker and an integ behind it; the
prose (commit messages, changelog entries, PR bodies, rationale comments) has
none. On go-to-k/cdkd#1882 / go-to-k/cdkd#1887 (2026-08-25), four review
rounds found **zero defects in the code and five false statements in the
prose**, every one caught by a reviewer reading the SOURCE rather than the
sentence. Habits that each caught something:

- **Grep the SHAPE, never the phrase.** Two consecutive sweeps for a stale
  claim searched the exact wording of the known copies; each missed a
  differently worded one. Count the population BEFORE editing and assert the
  count after (§5's code rule, applied to prose).
- **A claim inherited from the ISSUE BODY is the least trustworthy of all**,
  and it arrives feeling authoritative. The lane repeated go-to-k/cdkd#1887's
  "the empty list propagates silently" into a commit message, changelog and
  source comment; go-to-k/cdkd#1957 had already made it false. Re-verify an
  issue's mechanism against current `main` before restating it — a fix's
  rationale outlives the issue.
- **A correction can be a new false claim.** Twice the replacement for a
  wrong sentence was wrong in the other direction. Re-read a correction
  against the code the same way you read the original.
- **In a FIX round, the fix is what invalidated your own prose — so every
  past-tense measurement in the commit is stale until re-derived, not just
  the sentence you set out to correct.** A fix commit's prose is the LEAST
  verified thing in it, written last under the momentum of having just fixed
  the thing. One run (2026-08-27, three lanes, four review rounds each)
  found **one** code defect and **ten** false claims, in shapes no list
  predicts:
  - **A claim the same commit falsified.** go-to-k/cdkd#2309's changelog
    cited a ledger row the very delta containing the sentence had REPLACED —
    the caveat was backwards, not merely stale.
  - **A fence claimed rather than probed.** The source said an ordering "is
    fenced by a unit case anyway"; moving the guard left the suite 27/27
    GREEN and the named case did not exist. The fix was to BUILD the fence
    (plus a guard-the-guard case so the ordering case cannot pass
    vacuously), not to retract the sentence.
  - **A tally patched instead of re-measured.** Published 20 / 21 / 18 / 2;
    re-measured on the shipping tree: 23 / 24 / 22 / 3. "Every case is
    reddened by at least one mutation" is now COMPUTED as a set difference,
    not asserted. A probe MATRIX rots identically — later rounds add cases on
    the same line, so two published "1 RED" rows measured 4 and 6 on the final
    tree (2026-08-26), nothing regressed. Say which tree a count came from.
  - **A blanket direction claim contradicted by its own list.**
    go-to-k/cdkd#2311's prose said three bounds "are fail-CLOSED" while its
    own bullet four lines above described one hiding a site.
  Before a fix round is FINAL, re-derive every number, every `file:line`,
  every ledger citation and every "measured" verb, and say which tree they
  were measured on — a `file:line` drifts on every rebase, and a probe count
  grows when later rounds add cases.

  **The remedy is to DELETE the unproved clause, not to rewrite it — and the
  recurring shape is a CONSEQUENCE bolted onto a verified claim.**
  Re-measured 2026-08-27: two of three lanes shipped a false claim inside a
  REPAIRED rationale paragraph. The go-to-k/cdkd#2321 lane was wrong in one
  paragraph THREE consecutive rounds, each time as "X is load-bearing:
  deleting it would hard-fail" — X probed, the consequence never (one probe
  settled it: a per-resource catch swallows the refusal, so `saveState` is
  still called). What converged both lanes was cutting the unproved clauses:
  **deleting a whole CLAIM cannot introduce a new false one, which is what
  makes such a round cheap to trust.** That does NOT extend to deleting a
  clause from inside a sentence — removing a qualifier can falsify the
  survivor — so after any deletion, re-read the sentence that remains. Say
  what was measured and stop; a consequence that matters belongs in a test.
  Narrower than "rewrite the fence out of existence": when the false claim
  was that something IS fenced, BUILD the fence (bullet above); delete the
  CLAIM when nothing supports it.

  **Write the rationale FIRST in a fix round, not last.** Ordering is the
  one lever against post-fix momentum: the go-to-k/cdkd#2321 lane's
  rationale-first final round was the only one of four that introduced no
  new prose defect.

**A reviewer's suggested FIX can be wrong even when its finding is right —
re-derive the fix from the source rather than pasting the patch.** The premise
check below asks whether the finding holds; this asks whether the remedy does,
and the two fail independently. On the go-to-k/cdkd#2052 lane (2026-08-26) a
security reviewer proved by probe that an age-only sweep would delete live
`state.json` — correct, a blocker — and offered `/^cdkd-\d+-[0-9a-z]+\.json$/`
as the key filter. The producer's suffix is
`Math.random().toString(36).substring(7)`, which can return the EMPTY string —
so `cdkd-<epoch>-.json` is a key cdkd really writes and the `+` would have
skipped exactly those, trading over-collection for INVISIBLE under-collection
(a sweep that collects nothing looks identical to a clean bucket). A reviewer
reasons from the diff, so a suggested REGEX, bound, or constant is the part it
is least able to verify: derive those from the code that produces the value,
and probe both directions.

**Check a reviewer's PREMISE before acting on the finding, and say so when you
decline.** A suggestion can be correct in form and rest on a false
reachability claim — and acting is not free when the edit touches a gated
file. On 2026-08-21 a reviewer asked a `deploy-engine.ts` comment to name a
second guarantor via `NestedStackProvider.update`; two greps settled it
(`rollback.ts` builds a DESTROY-mode context, so `requireDeployContext`
throws before a child engine exists; the only deploy-mode context is
`deploy.ts`'s own), so the comment was already complete. Record the trace in
the PR body and commit: a declined finding with evidence can be re-judged; a
silently dropped one looks like an oversight.

**A premise fails in the other direction too — a reviewer can assert that a
fence does NOT exist, and acting on that is how you turn CI red.** Measured
2026-08-27: a spec reviewer reported "no mechanical byte-budget gate exists"
and proposed a ~30-byte reword; `tests/unit/scripts/rule-file-payload.test.ts`
does exist, the edited line stood at **3,998 B against a 4,000 B cap**, and
the long-line ratchet at exactly **24/24** — the suggestion would have broken
a budget that only decreases. An absence claim is the one a reviewer is least
able to establish: verify it by running the thing said not to exist.

**Your own BRIEF to a lane agent is a published claim, and it inherits every
fact you relayed without checking.** The trigger for verification is
DESTINATION, not doubt, and a fix instruction is a destination: the agent
acts on it without the standing to re-derive it. Same run, twice: a
reviewer's claim that `scrub.ts` is a NON-`bestEffort` caller went into a
brief unverified and was false (`resources:` and `bestEffort: true` are
fields of ONE object literal, so scrub short-circuits before the predicate —
the coverage gap was real, its justification was not); and an arm shape
specified in another brief would have been VACUOUS. Grep the claim before it
goes into an instruction, and when an agent corrects your brief, say so in
the report rather than absorbing it silently.

**A REVIEWER brief is the same published claim, and it fails worse.** A lane
agent's false premise yields a wrong edit you will see in the diff; a
reviewer given one aims its WHOLE ROUND at the wrong subject and returns a
report that reads as authoritative. Measured 2026-08-27: "a membership filter
makes S3 create the bucket in `us-east-1`" was relayed into THREE reviewer
briefs unchecked; it was false (the provider's constructor takes an already
region-bound client, so the request never reaches the global endpoint), and
the security reviewer's entire data-residency framing rested on it until
corrected mid-flight. Grep every mechanism claim before it goes into a brief,
and correct one already sent in-flight rather than waiting for the report.

**When two reviewers CONTRADICT each other, settle it in the code yourself
before forwarding either.** On 2026-08-20 the spec reviewer explicitly
CLEARED the evidence-persistence issue the security reviewer called a
blocker; the code's own comment settled it in one read. Forwarding both hands
the implementing agent a contradiction to adjudicate with less context than
you have — and forwarding only the reassuring one is how a blocker ships. Say
which reviewer was right and why.

**That rule holds for a claim about THIS REPO. For a claim about what an
EXTERNAL system does, neither reviewer can settle it and neither can you —
the tie-break is a MEASUREMENT.** The cases come apart only in what would
resolve them. On the go-to-k/cdkd#2274 lane (2026-08-27) the spec reviewer
wrote that CloudFormation masks a `NoEcho` custom resource's `Data` on the
wire; the code reviewer called that unmeasured folklore; both had read the
same source. A live CFn A/B returned the plaintext to a dependent SSM
parameter AND a stack Output, with the handler's log proving `NoEcho: true`
reached the service — overturning the lane's design, which was discarded
rather than merged (`CLAUDE.md`'s "never file divergence on folklore" already
requires the A/B). The tell is grammatical: if the disputed sentence names a
service rather than a file, stop reading code and go measure.

**Fresh deploys: UNIQUE stack names only** (e.g. `Cdkd<Issue>Verify`), never a
shared fixed name and never a real prod stack — the account may hold the
maintainer's production stacks. Tear down with `cdkd destroy … --force`, then
SWEEP for orphans it can't reach (auto-created `/aws/lambda/*` log groups from
`autoDeleteObjects` custom-resource Lambdas, RETAIN stateful resources,
Secrets in recovery, KMS keys pending deletion). Confirm state is gone:
`aws s3 ls s3://cdkd-state-$(aws sts get-caller-identity --query Account --output text)/cdkd/`
should show no leftover stack (the `deployments/` events store legitimately
survives — it is not an orphan). If destroy failed or left orphans, delete
them by direct AWS API call before doing anything else.

`/verify-pr` sets the `check` + `docs` + `verify-pr` markers, and `/run-integ`
sets the `integ-*` markers — together they unblock `gh pr merge`.

**`pr-review` is not on that list, and a LANE must never set it.** `/review-pr`
writes it, run by the ORCHESTRATOR, after the reviewers it dispatched have
reported and every blocker is addressed — the marker records who reviewed what
at which sha, so a lane setting it is the "sub-agent self-review is not
independent review" failure of `CLAUDE.md` arriving through the marker instead
of through the review. Measured 2026-08-29: two of three lanes in one run
(go-to-k/cdkd#2383, go-to-k/cdk-local#631) set it themselves before any
independent review existed. §5's "a lane stops at merge-ready" was already
written and did not prevent it, because recording a marker reads as part of
finishing rather than as merging — so name this marker in the lane's brief.
And nothing mechanical catches it, so do not read the sha binding as a
backstop. `pr-review-gate.sh` compares the recorded `.markgate-pr-review-sha`
sentinel against the PR's current HEAD and refuses with
`bound to <sha> (mismatch)` — which catches a marker a later PUSH left behind,
not a marker set by the wrong AGENT. It cannot tell who set it; the sentinel is
per-worktree, and §9 merges from the lane's own worktree, so a lane that sets it
after its final push produces a matching sha and merges unreviewed. The rule is
the only thing standing there.

**And your own review round is not optional because the lane already ran one.**
A lane's reviewers are its children — same brief, same framing — so the thing
they are least able to doubt is the premise the lane handed them. Measured on
go-to-k/cdkd#2383 (2026-08-29): three rounds of the lane's own reviewers each
found the next spelling of one defect, and it took an independent
orchestrator-level round — round 4, A/B-ing the hand-rolled parser against the
`yaml` library over 15 spellings and then against markgate 0.4.1 itself — to
find the YAML merge key, **the spelling the lane's raw-text tripwire had been
added specifically to backstop and did not fire on**. The sibling
go-to-k/cdk-real-drift#1838 spent its own rounds on the same class. So take the
tier the heuristic gives for YOUR pass: a lane's clean round is evidence about
the lane's assumptions, not about the diff.

**A reviewer's scratch COPY of a worktree is not detached from git, so its
`git add -A` writes to the LIVE tree.** A linked worktree's `.git` is a FILE
holding `gitdir: <repo>/.git/worktrees/<name>`, and `cp -R` carries the
pointer, so every git command inside the copy reads and WRITES the real
worktree's index and HEAD. Measured 2026-08-29: a read-only reviewer copied a
lane's worktree, ran `git add -A`, and staged three tracked DELETIONS in the
live tree — surfaced only because the NEXT reviewer volunteered that the tree
had gone dirty mid-review. So two lines belong in every read-only reviewer's
brief, on top of §5's peer-probe rules: **run no WRITING git verb** (`add` /
`commit` / `restore` / `checkout` / `stash` / `clean`) anywhere, copy included —
and if you must copy, copy OUTSIDE every repository, since deleting the `.git`
file does not detach the copy, it only makes discovery walk UPWARD; and
**report the TARGET worktree's `git status --porcelain` before AND after the
round**, which is what makes damage attributable rather than a mystery. Every
reviewer given these two lines reported clean both ways.
