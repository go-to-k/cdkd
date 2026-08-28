<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 8. Verify before merge (`/verify-pr` + `/run-integ`)

**When a fix round produces the NEXT round's blocker twice, stop reviewing the
patch and question its SHAPE.** `/verify-pr` step 8 already says to re-review the
fix delta; this is what to do when that keeps paying out. On 2026-08-20 one lane
ran FIVE rounds, and every blocker was created by the previous round's fix: a
bare-`Error` interrupt took the ROLLBACK branch; re-throwing to avoid that
orphaned an untracked resource permanently; a never-removed listener then made a
multi-stack `destroy` keep deleting after Ctrl-C; keeping the handler armed to fix
THAT stranded the lock; and reordering to fix that swallowed the interrupt so
`--all` destroyed the next stack. Each fix was locally correct and moved the
failure one layer out rather than removing it. Every one was found by executing a
probe or tracing a window — never by re-reading the diff — including two where a
comment confidently asserted the opposite.

Two things follow, and the second is the one that is easy to get backwards:

- **After round two, ask what the rounds have in common.** Here it was one
  structural absence: `destroy.ts` registers no command-level SIGINT handler while
  `deploy.ts` does, which is why only the destroy path kept generating instances.
  Naming that earlier would not have skipped the rounds, but it would have told
  everyone what they were chasing.
- **Do NOT take the structural fix late in the cascade.** Round five's remedy was a
  one-line re-sync plus an issue for the handler, deliberately: adding new code to
  a command entrypoint at round five is how round six happens. Take the narrow fix,
  file the structural one, and reference it from the narrow fix so the next reader
  sees the choice was made rather than missed.
- **But filing the structural fix does not STOP the cascade, and the bullet above
  used to imply it would.** Measured in go-to-k/cdk-local#596 on 2026-08-27: the
  structural issue was filed at round five and the rounds ran to TWELVE, producing
  eleven instances of one defect class in one PR, five of them introduced by the
  fix for the previous one. What ended it was not a better check — it was making
  the artifact **CLAIM LESS**.

  The tell is that each round's fix is more SOPHISTICATED than the last. There a
  `/run-integ` orphan sweep went name scan -> scoped filter -> guarded filter ->
  stderr classification -> status filter, while the plain rc-only sweeps three
  lines away were correct the whole time, under the exact conditions that defeated
  the clever ones: `grep -q 'does not exist'` also matches botocore's
  `The source_profile ... does not exist`, raised before any network call, so a
  broken profile reported CLEAN having queried nothing. The sophistication WAS the
  defect. The sweep now prints raw command output and names both outcomes instead
  of emitting a verdict — a command that claims nothing cannot claim something
  false. Expect it to feel like a retreat; it is one, and it is what converges.

  Two corollaries, both paid for there:

  - **Fence the REMEDIATION, not just the detection.** Five of eleven instances
    arrived through a fix, and the last was in the remediation: `cdk destroy` on
    names built without the required suffix exits 0 SILENTLY, so the operator read
    success with the resources still deployed. Every fence to that point pinned
    the DETECTION, so restoring that line left the suite green. If a procedure
    both detects and repairs, the repair is where the next instance goes.
  - **Do not pre-commit to a remedy for a finding you have not seen.** Twice the
    stated plan was "if instance nine appears, delete the whole thing", announced
    before instance nine existed; when it arrived, deleting would have left the
    flow with NO check at all — instance one made permanent. A rule announced in
    advance is a way of not having to exercise judgement. Say what the next
    finding would have to SHOW, not what you will do about it.
- **Ask whether the thing you keep patching is a CLASSIFIER, and if it is, stop
  and build the differential fence in §5 before the next fix.** That section
  already says hand-picked cases cannot fence a classifier — the failure is not
  that the rule is missing, it is that nobody asks the question while inside a
  cascade, because each round has a named blocker in hand and patching it feels
  like progress. On 2026-08-21 go-to-k/cdkd#2027 ran FIVE rounds, each one
  finding a spelling the previous had not (`git -C "$W"`, then a quoted path
  containing a space plus `$( )`, then `gh -R`, then an apostrophe in a `--body`
  that made the segmenter emit ZERO segments and disarm every gate), and rounds
  3 and 4 each introduced regressions in the same two functions they were fixing
  — five across two rounds. The segmenter IS a classifier: command text in,
  "which gates consider this" out. The differential walk ended it in one round,
  and it found the last two blockers by construction rather than by anyone
  guessing a spelling. The tell is not the round count, it is that every round's
  finding is *a new input class the code got wrong* rather than a new place the
  logic was wrong.
- **When the shape is "TWO SPELLINGS OF ONE QUESTION", the fix is to make both
  sites use ONE predicate verbatim — not to write a better second spelling.**
  This is the sub-case that keeps regenerating, because a better spelling looks
  like a fix and passes its own test. Measured on issue go-to-k/cdkd#2134, three
  rounds: a per-STACK signal was being consulted where a reference's origin was
  already known. Round 1 stripped it by RESOLVER IDENTITY -- wrong, because a
  producer in the consumer's own region yields the same resolver. Round 2 fixed
  the predicate to `producerRegion !== undefined` -- still a second spelling, and
  round 3 found it disagreed with the authority's own `if (!producerRegion)` on
  the empty string, on the fail-OPEN side. Only copying the authority's test
  character for character ended it. So when you name the shape, also name the
  SITE THAT OWNS the question, and make every other site call or copy it exactly;
  a paraphrase is a fourth round waiting to happen.
- **When the shape is "A PROXY FOR A QUESTION ONLY ANOTHER COMPONENT CAN
  ANSWER", the fix is to make that component REPORT — and the tell is that each
  proxy is wrong in BOTH directions at once.** The sibling of the bullet above,
  and it is diagnosable one round earlier: two spellings DISAGREE at an edge,
  while a proxy has no access to the fact at all, so every candidate both misses
  real cases and fires on unreal ones. When a round's fix lands on a new
  observable rather than a new spelling — "it threw", "the text survived", "a
  needle exists" — ask whether the thing you want to know is even derivable from
  outside the component that decides it. If it is not, the rounds are unbounded.
  Measured on issues go-to-k/cdkd#2157 / go-to-k/cdkd#2166, three rounds asking
  "did this reference go unresolved?" from outside the resolver: keying on "the
  resolution THREW" missed the shape where `resolveSub` warn-and-KEEPS an
  unevaluable placeholder (nothing throws) and over-reported an unrelated `Ref`
  failure that merely shared the bag; keying on "the raw leaf text SURVIVED"
  missed a leaf a downstream intrinsic rewrote without resolving, broke on JSON
  escaping, and fired PERMANENTLY on prose that merely mentions the syntax —
  re-opening, one level out, an unactionable-refusal class the same file had
  already closed once.
- **WITHDRAWING the half that cannot be made right is a legitimate outcome, and
  the residual issue must carry the MEASUREMENTS, not just the diagnosis.**
  §8's "do NOT take the structural fix late in the cascade" says where the fix
  goes; this says what to do with the code already written for the wrong one.
  Cut it, ship the part the issues actually scoped, and file the rest — the
  filing is cheap only if it carries what the session PAID for: each proxy tried,
  the input that broke it, and the number it produced. A diagnosis alone makes
  the next session re-run the probes. The go-to-k/cdkd#2166 filing carries all
  three rounds plus a live arm that was written, passed, mutation-probed and then
  reverted, so none of it is rebuilt.

**When the fix WIDENS what a guard catches, the thing you removed may have been
load-bearing — and the instrument you own for measuring that can be structurally
blind to it.** A bypass fix reads as pure gain: the guard catches more, and
over-catching is the loud direction this repo already accepts. What that framing
misses is that the guard sat in an equilibrium, and the property being removed
may have been the only thing holding back an unrelated over-approximation
somewhere else. Ask, before believing a widening safe: *what was the thing I am
deleting actually doing?*

Measured 2026-08-27 on go-to-k/cdkd#2333, which was implemented, reviewed in
four rounds and WITHDRAWN. The trigger matched a verb as literal text, so
`git "commit"` evaded every gate; dequoting structural tokens closes that. But
go-to-k/cdkd#2156 had already widened `GATE_FLAGS` to "one flag token, then ANY
tokens", so after a `-C` any later token can occupy the verb slot — and the only
thing keeping ordinary commands out of the gates was that a QUOTED later token
happened not to match. Dequoting removed that brake, and `git -C <dir> log
--grep "commit"`, `git show "commit"`, `git grep -n "commit" -- src` and 13 more
began to BLOCK, `check-gate` on a feature worktree included, which is the normal
mid-lane state. The bypass was real and the fix was worse than it.

**The survey could not have told you.** `false-refusal-survey.sh` is this repo's
instrument for exactly this question and it returned a clean `NEWLY CONSIDERED
0` for that change, because — as its own header states — every text it probes
lands in ARGUMENT position, never in the flag PREFIX, which is precisely where
the change acted. A measurement taken in the wrong position is not weak
evidence, it is none, and it reads identically to the real thing. So name the
POSITION your change acts in, confirm your instrument probes that position, and
if it does not, build the arm that does before quoting a zero.

Two corollaries this lane paid for:

- **Derive the reader population before patching readers.** Four rounds each
  found one more consumer that decides a gate outcome from the same text
  (`gate_target_dir_strict`, then the `cd` clause of both resolver loops, then
  `gate_verb_rest_each`, then `gate_pr_selector`, then a hook-local `sed` in
  `main-tree-branch-gate.sh`). One grep — `grep -n '\[\[ "\$segment" =~'` —
  returns all eight lib sites at once. Patching them one per round is how a
  cascade reaches round four still claiming closure.
- **A benchmark must exercise the path the change is on.** The same lane
  published "+20% latency" from a run whose command MATCHED, and the new code
  sits after an early `return` taken on a match — so it measured noise. A
  reviewer re-measured +0-3%, while the real cost was elsewhere entirely
  (quadratic on large input). Before quoting a delta, confirm the probe reaches
  the added code, the same way section 5 requires of a mutation probe.

**Run the integ LAST — after the final edit to any gate-scoped file, not after
the final edit you happened to think of.** `/run-integ`'s own tail says "review
polish first, integ last", but the ordering is DECIDED here, and the rule is
easy to satisfy in spirit and miss in fact: you run the integ when the lane
feels done, and then a reviewer hands you three one-line nits that land in the
same scope. On 2026-08-25 that cost two full real-AWS re-runs in one run of this
skill. Lane go-to-k/cdkd#2189 ran `local-run-task-from-state` (~5 min), then
review fixed a shell quoting bug and a missing assertion in the SAME
`verify.sh`, which is in `integ-local`'s include — marker stale, run again. Lane
go-to-k/cdkd#1978 ran `remove-protection` (~25 min), then a review nit threaded
a clock through both DynamoDB providers, which are in `integ-destroy`'s include
— marker stale, run again. Both re-runs were correct: the gate is doing exactly
its job, and the second `local-run-task-from-state` run genuinely executed an
assertion the first never had.

So the sequencing is: dispatch reviewers, apply EVERY finding including the
nits, THEN rebase, THEN run the integ, THEN set the markers. Two corollaries
that are cheap to check and expensive to skip:

- **Before starting an integ, ask what is still outstanding.** A reviewer still
  running, a nit you have not applied yet, a rebase you know is coming — each
  one will stale the marker the run is about to set. `git diff origin/main...HEAD
  --name-only` against the gate's include list answers it in one command.
- **A rebase can stale a `hash: diff` marker on its own**, because the merge
  base moves: an in-scope file changed by an incoming merge that this branch
  also touches invalidates it. That is the one case where re-running is
  unavoidable rather than self-inflicted — so do the rebase BEFORE the integ,
  not after, and expect `markgate verify` to be the thing that tells you.
- **Under ITERATIVE review rounds, "last" does not hold still — so DECLARE the
  tree final, in words, to whoever is still editing it.** The rule above is
  written for one review pass. A lane that runs rounds 2 and 3 has a "final
  edit" that moves each time, and each round that touches a gate-scoped file
  buys another real-AWS run — including a round whose delta is comment-only,
  since `hash: diff` digests the delta, not the behaviour. Measured 2026-08-26:
  one lane paid THREE `ecs-service-update-props` runs, the third for a round
  whose `ecs-provider.ts` change was verified to have zero non-comment lines.
  What ended it was telling the implementing agent, before its last pass,
  to **batch every remaining finding into a single commit and report when the
  tree is FINAL, with no second pass** — after which the integ ran once. Say
  that explicitly rather than assuming it: an agent handed a list of findings
  will otherwise fix, verify, and hand back, which is the right instinct
  everywhere except in front of a real-AWS gate. The corollary for reviewers is
  the reverse — dispatch a round SCOPED to the delta and ask for the whole
  round's findings at once, rather than trickling them.

Run `/verify-pr`. It layers CI status, docs consistency, AWS-resource cleanup, code
review, and a **live-test of the changed behavior** on top of `/check`. Unit tests
passing is necessary but NOT sufficient — the fix must be exercised against real
AWS:

- **Deletion / DAG-order / state-cleanup change** → the change is unmergeable until
  an integ test's **destroy** step completes cleanly (the `integ-destroy` gate, +
  `integ-broad` for cross-cutting deploy/destroy files, is bound to a real-AWS
  destroy). Run it via the skill: **`/run-integ <name>`** — never invoke
  `cdkd deploy` / `cdkd destroy` from a raw shell, because the skill encodes
  deploy + update + destroy + orphan-resource verification in one block and records
  the run into the committed ledger. Use `/pick-integ` to choose which fixture(s)
  cover the touched code area.
- **Non-deletion source change** → still live-test the fixed path end-to-end
  (deploy → the redeploy-with-a-change that reproduced the bug → destroy) with a
  fresh fixture, or via `/run-integ` against an existing one that covers it.

**An integ ARM owes the same discrimination proof a unit test does, and it is
easier to write a vacuous one — so MUTATION-PROBE THE ARM against real AWS.**
The unit-test rules above stop at the suite; an arm is the one place this flow
routinely ships a fence nobody has watched fail. Three ways it goes wrong, all
measured on 2026-08-21 across go-to-k/cdkd#2108 / go-to-k/cdkd#2109, and none
visible by reading the script:

- **The host has the trigger but not the EVIDENCE, or the reverse.** A fix that
  keys on recorded state needs the state AND the thing that state describes in
  the SAME unit. `cdkd scrub` classifies only a literal `{{resolve:...}}` in the
  TEMPLATE, so the producer stack (literal, no cross-stack read on record) and
  the consumer (evidence, but an `Fn::GetStackOutput` leaf with no literal) each
  had exactly half, and a third fixture had the two-region seeding with no
  cross-stack machinery at all. All three would have passed with the fix
  reverted. Adding one small resource to the stack that already carried the
  evidence is what made the arm real — cheaper than a new fixture, so check for
  it before concluding a live arm is `next`.
- **The arm is INERT because the command returns early.** When the fix's
  behaviour is to SKIP something, a fixture whose only difference is in the
  skipped thing gives the command no work: it finds nothing to do and never
  reaches the new code. A `drift --revert` arm tampered the secret-bearing
  property, which is exactly the one now skipped, so the resource came back
  clean and the revert returned "nothing to revert" — two live writes, zero
  signal. Give the fixture a second, ORDINARY difference alongside the one under
  test, and add a phase that proves the premise (the resource really is drifted,
  on the ordinary property) before the phase that depends on it.
- **The arm is INERT because its PREMISE is out of scope, and the tell is that
  BOTH counts come back zero.** A masking arm asks two questions at once — did
  the plaintext leak, and did the mask fire — and the reassuring answer to the
  first (`0`) is produced just as readily by an arm that never reached the code
  as by one that passed. Read them as a PAIR: `0 leaks AND 0 masks` is not a
  pass, it is an arm that did nothing. Measured 2026-08-23 on
  go-to-k/cdkd#2176: the first live arm made an SSM parameter's NAME a
  `{{resolve:ssm-secure:...}}` reference, and cdkd deliberately does not resolve
  that spelling (`docs/scenario-coverage.md` says so) — so nothing was ever
  plaintext, nothing needed masking, and both greps returned `0`. Switching to
  `{{resolve:ssm:...}}` against a SecureString made the arm real. The same run
  had a SECOND inert attempt from a different cause: a deliberately malformed
  tag meant to force the failure path was dropped by CDK at synth, so the deploy
  simply succeeded. Before trusting an arm, prove its premise independently —
  here, that the resolved value actually reached AWS (the created resource was
  named with the secret) — and only then read its assertions.
- **The assertion is a negative, so it is a confluence point.** "The bad value
  was not written" is satisfied by a correct refusal AND by any unrelated
  failure that stopped short. Measured: with the fix mutated back to pre-fix
  behaviour the arm stayed GREEN, because the revert had errored instead of
  writing. Assert the POSITIVE marker only the fixed path emits — a specific
  exit code, a string only the deep path prints, a field in the `--json`
  payload — and demote the negative to a stated safety net, recording the
  measurement so nobody re-promotes it.
- **Every assertion in the arm PREDATES your change, so the run is somebody
  else's regression net.** The cheapest arm to reach for is a fixture that
  already asserts something near your subject — and if you changed none of those
  assertions, a green run says only that you broke nothing. On 2026-08-21 a lane
  ran `rollback-cross-region-secret` for a `cdkd drift` outcome-type change and
  recorded it as the live evidence; a review found every drift assertion in that
  `verify.sh` byte-identical to `origin/main` (the PR had touched three comment
  lines there) and all of them passing under the PRE-change shape, because an
  earlier issue already emitted the roll-up and the same exit code. The one
  user-visible delta — a refused resource leaving `clean[]` — was asserted
  nowhere: `grep '\.clean' verify.sh` returned zero hits. So before believing an
  inherited arm, run `git diff origin/main -- <the fixture>` and ask which
  assertion could only pass AFTER your change. If none, the arm is a regression
  net for a different issue; add the discriminating one. And guard it against
  vacuity in the same breath — the added assertion there was an ABSENCE from an
  array, which a run that died before writing that array would also satisfy, so
  it first requires the array to have been emitted at all.

The probe is one extra run of a fixture you are already running: revert the fix,
rebuild, run, confirm the arm goes RED, restore, rebuild. **Probe each HALF of a
multi-part fix separately, not just the whole.** On 2026-08-21 a scrub lane's
three probes were the whole argument: reverting everything reproduced the bug,
reverting only the wiring red one assertion, and reverting only the pre-pass left
that assertion PASSING while a different one red — which is what proved the two
halves were independently fenced rather than one arm covering both. A single
all-or-nothing revert cannot tell those apart. Also add a NEGATIVE CONTROL inside
the arm — a sibling case that must NOT trip the new behaviour — or a refusal
that fires on everything satisfies every positive assertion you just wrote.

**Never leave a real-AWS run unwatched, and do not reach for `timeout` to do
it.** A hung integ and a legitimately slow one look identical from outside, so
silence proves nothing: on 2026-08-20 a fixture wedged inside `docker push` and
ran **4h17m** with no container alive and no log line after the first minute,
noticed only on a manual check. `timeout` **does not exist on macOS**, and the
obvious guard is therefore worse than none — it exits 127 in 0s, which reads as
a run that completed instantly. Use a shell watchdog beside the job and make the
firing visible in the log:

```bash
bash verify.sh > "$LOG" 2>&1 &
VPID=$!
( sleep 1500; kill -9 $VPID 2>/dev/null; echo "WATCHDOG_FIRED" >> "$LOG" ) &
WPID=$!
wait "$VPID"; RC=$?
kill "$WPID" 2>/dev/null
grep -c WATCHDOG_FIRED "$LOG" || echo "watchdog did not fire"
```

The `grep` is load-bearing: `kill -9` surfaces as rc=137, which is otherwise
indistinguishable from any other crash. Pair it with a `Monitor` that emits on
phase lines AND on log-growth stalling, so a wedge announces itself instead of
being discovered hours later.

**ANCHOR the predicate the poller waits on, or it reports DONE while the job
runs.** This flow polls constantly — for a lane agent, a gate chain, a real-AWS
run — and a loose predicate fails in the one direction that matters, since a
premature DONE is acted on. Two shapes, both hit on 2026-08-26 in one run.
A non-empty test (`[ -s "$f" ]`) on an output file the job ECHOES INTO before
starting: the `PWD=...` line the chain prints first satisfies it, so the poller
returned at once and the integ looked finished seconds in. And an unanchored
substring: `grep -q "test_rc="` matches `typecheck_test_rc=` from an EARLIER
step in the same chain, so a poller waiting for the suite reported done at the
typecheck. Wait on a line the job writes only at the END, matched anchored
(`grep -q "^suite_rc="`), and where the job has a process, confirm it is gone
(`pgrep -f` on its command) rather than inferring it from the file. Neither bug
touched the work — both were caught by reading the output — but each cost a
round of re-checking, and the second one nearly had a merge sequence start
against an unfinished suite.

**The harness's "completed, exit 0" is the exit code of the command you
BACKGROUNDED, which is not always the job you care about.** Write
`nohup <long job> > log 2>&1 & echo started` into a backgrounded call and the
wrapper returns immediately: you get a completion notification with rc=0 while
the job runs on for minutes. Measured 2026-08-21 — a full suite reported
"completed (exit code 0)" and was still executing 90 seconds later, with the
summary lines absent from its log because it had not reached them. Run the long
job as the SOLE command of the backgrounded call (no trailing `&`), so the
notification tracks the thing you are waiting on, and read the log's own
terminal line rather than the notification. Two nearby traps in the same
family: a shell whose `cd` was inside the backgrounded compound leaves the
parent's `$VAR` unset, so a follow-up `grep "$LOG"` reads a path that never
existed; and `grep -c` exits 1 on a count of zero, so a verification command
ending in one reports FAILED for the very case it was checking for.

**Check a fixture's unstated PRECONDITIONS before spending a run on it.** Integ
fixtures guard themselves and refuse rather than explain, so a wrong region
costs a full round-trip each time. Choosing a region for `asset-bootstrap` on
2026-08-20 took three attempts: it needs a region that is **CDK-bootstrapped**
(its legacy-mode phase publishes to the CDK bootstrap bucket) AND has **no cdkd
marker** (its own guard refuses otherwise), and on that account only `eu-west-1`
satisfied both. Both conditions are two commands:

```bash
aws s3api head-bucket --bucket "cdk-hnb659fds-assets-<acct>-<region>"   # CDK-bootstrapped?
aws s3 ls "s3://cdkd-state-<acct>/cdkd-bootstrap/"                       # which regions cdkd owns
```

**A DOCKER-dependent fixture is an environment blocker, so prefer the one that
reaches the same code more directly without it.** `gc-custom-asset-names` was
abandoned after two blockers (daemon down, then the 4h push wedge) in favour of
`asset-bootstrap`, which needs no docker AND exercises `AssetModeResolver` more
directly — the better fixture on the merits, not merely the available one. When
docker is genuinely required by the gate (`integ-local`), verify it can reach a
registry FIRST — `docker pull hello-world` under a 120s cap — because
`docker version` answering says nothing about registry networking, and that is
the half that fails.

**Do NOT restart Docker to fix a hang — on Docker Desktop the restart IS the
likelier cause.** The daemon routes registry traffic through
`http.docker.internal:3128`, a proxy the Docker Desktop **application** serves.
`osascript -e 'quit app "Docker"'` followed by `open -a Docker` can leave the
self-respawning `com.docker.backend` watchdog up while the app itself never
finishes launching — and then every pull waits forever on a proxy that is not
there, while `docker version` keeps answering over the local socket. Measured
2026-08-20: after that sequence, four consecutive `docker pull hello-world`
attempts hung past a 90-120s cap, `pkill` could not clear the watchdog, and only
a maintainer restarting the app by hand restored it. Diagnose in this order and
STOP at the first one that explains the symptom, rather than restarting anything:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 https://registry-1.docker.io/v2/  # 401 = HOST networking is fine
docker info 2>/dev/null | grep -i proxy         # names the proxy the daemon depends on
pgrep -f 'Docker Desktop' >/dev/null && echo app-running || echo APP-NOT-RUNNING
```

A host that reaches the registry, a daemon configured with a proxy, and no app
process is the whole diagnosis: the app must come up, and nothing else will fix
it. Ask the maintainer rather than escalating — the remaining moves (factory
reset, deleting Docker's data, rewriting the daemon proxy config) destroy local
images and volumes, which is never yours to spend. Also clean up after your own
probes: `kill`ing the wrapper of a `docker pull` leaves the `com.docker.cli`
child running, and five of them had accumulated before anyone looked.

**A run blocked before its assertions is not a failing fix, and the ledger note
is where that distinction survives.** Record such a run as `FAIL` (the bar is
exit-code-based) with a note naming the blocker, saying the change was not at
fault, and listing any AWS resources the aborted run created and you removed by
hand. The next reader sees a FAIL row against a merged change and will otherwise
conclude the fix is broken.
- **Any diff with no `src/**` change** (docs, toolchain, CI, hooks, skills, tests,
  config) → EXEMPT from the deploy / destroy live-test tiers above, never from
  `/verify-pr` step 9, and never from `verify-pr` itself — that gate sits on top of
  `check` + `docs` with no diff-shape carve-out. This is the easy tier to
  under-verify: with no fixture and no integ that can fail, "the gates are green"
  reads as "nothing left to check". **And never conclude a CI job cannot fail on
  your diff from that job's NAME or its usual scope** — a job's name bounds where it
  READS from, not what it ASSERTS. On 2026-08-26 the go-to-k/cdkd#2236 lane wrote
  twice that `check-build-test` "cannot fail on a `.claude/**`-only diff because it
  is a `src/**` / `tests/**` job", and used that to skip the full suite after a
  final round of prose growth. It went red: `tests/unit/scripts/rule-file-payload.test.ts`
  lives under `tests/` and has jurisdiction over the WHOLE tree, `.claude/rules/**`
  included, so the one check the lane talked itself out of running is the one that
  would have caught it. Any repo-wide fence — a byte cap, a corpus scan, a
  `git ls-files` walk — sits inside some job whose name suggests a narrower reach. What SATISFIES step 9 depends on what the diff
  changes, and a diff that does both takes BOTH arms.
  - **It changes what a command or gate DOES** (a build / lint config, a CI
    workflow, hook logic, a `vite.config.ts` task) → the verification IS that
    command, and those runs ARE `/verify-pr` step 9's live test rather than an
    exemption from it. Run *the command your own diff changes*:
    `.claude/hooks/run-tests.sh` (or the single `.claude/hooks/<name>.test.sh`) for
    a hook, the workflow step's own command for CI, the changed task for
    `vite.config.ts`, `vp run check` for the lint / typecheck config. `vp run check`
    is not the universal answer — it reads neither `ci.yml` nor any hook, and its
    lint is scoped to `src/**`, so running it for a hook diff is a probe that cannot
    fail.
    - **Run it more than once, BEFORE and AFTER — as `vp run --no-cache check`,
      with the flag BEFORE the task name.** `run.cache.tasks` is true in
      `vite.config.ts` and the `check` task does not opt out of it (unlike
      `typecheck:test`, `build` and the codegen tasks, which each set
      `cache: false`), so a bare repeat replays instead of re-running: measured
      2026-08-19, a second `vp run check` printed
      `$ vp check ◉ cache hit, replaying` / `vp run: cache hit, 4.61s saved.`.
      **Flag order is the whole trap**, and it is why this instruction is worth
      spelling out (go-to-k/cdkd#2017): `vp run check --no-cache` puts the flag
      after the task, so `vp run` forwards it to `vp check`, which rejects it —
      exit **1**, `error: unexpected argument '--no-cache' found`, from a command
      that never ran the check at all. That rc is exactly the signal this
      paragraph primes you to read as a real failure. **Read that help through
      `mise exec`, not the bare binary**: the pinned vp documents both `--cache`
      and `--no-cache` under `vp run --help`, while the unpinned global `vp` on
      this machine is an older build whose help lists neither — measuring with it
      is how this very paragraph first shipped the claim that the flag is
      undocumented. A stale global CLI reads as a missing feature. Verified twice back to back the same
      day: `vp run --no-cache check` printed zero `cache hit` lines on both runs,
      rc=0 each, and the next plain `vp run check` was straight back to
      `vp run: cache hit, 1.54s saved.` — the flag skips the cache for that run
      without invalidating the stored entry, so use `vp cache clean` instead when
      you want the entry itself gone. Do not silently substitute a bare
      `vp check` for `vp run check` here: `/check` step 1 records that the two are
      NOT equivalent, so swapping them changes what is being attested. A replay
      cannot surface what repeats are for — an rc that differs across identical
      runs. That failure is not hypothetical:
      go-to-k/cdk-real-drift#1761 had `vp run check` abort with
      rc=134 (a Vite+ stdout EAGAIN panic while writing a long warning list) while
      reporting 0 errors, and cdkd runs the same bare `vp run check` in `ci.yml`
      with none of the redirect workaround that repo added, so the mode is reachable
      here once the warning list grows. For the BEFORE tree use a scratch copy or a
      sed-swap you re-apply — not `git checkout -- <path>` / `git restore <path>`,
      which `dirty-path-restore-gate` blocks on a dirty path because undoing a probe
      that way discarded ~200 lines of unrelated uncommitted work in the same file
      (go-to-k/cdkd#1700).
    - **Drive the FAILURE direction too**, since a config change that swallows an
      exit code also turns a red tree green, and only the failure arm tells a fix
      apart from that. For the lint gate, append an unused variable to a `src/**`
      file and do not name it `_*`: `lint.ignorePatterns` is
      `['**/*', '!src', '!src/**']`, so a probe under `tests/**` is never linted at
      all, and `no-unused-vars` ignores `^_` for vars and args alike. Verified
      2026-08-19 — that probe does take `vp run check` to rc=1
      (`eslint(no-unused-vars)`). **Then revert the probe before committing**: left in,
      it makes this a `src/**` PR under a different §8 bullet and a different commit
      prefix. Revert by re-applying your scratch copy, which restores the exact
      pre-probe content — `check` is `hash: files`, so a marker recorded before the
      probe verifies fresh again once the bytes match. Re-run `/check` anyway if the
      fix itself landed after you recorded it.
    - **Then guard the SHAPE of the fix with a test**, since nothing else re-reads a
      build-config or workflow line. `vite.config.ts` / `scripts/**` / `ci.yml` →
      `tests/unit/scripts/*.test.ts`, with `matrix-regen-coverage.test.ts` as the
      pattern to copy: it parses a task block out of `vite.config.ts`, asserts both
      directions against `ci.yml`, and carries a parser floor so "found nothing"
      cannot pass as "everything matches". `.claude/hooks/**` → add a case to the
      hook's own `<name>.test.sh`, which §5 already tells you to look for and
      `.claude/rules/hooks.md` documents; create one for the few hooks that still
      have none. When the artifact has no harness that can read it — a `.mise.toml`
      pin, an action SHA bump — say so in the PR body instead of inventing one.
  - **It changes PROSE only** (a skill, a rule, a doc — including this file) → there
    is no command to re-run, so the CLAIMS are the artifact. Resolve every gate,
    hook, skill, path, task and command the new text names against this repo's own
    files, and RUN each command the text will send the next agent to run, confirming
    its output matches what the text promises. That is §10-c's claim-by-claim pass,
    owed whether or not the text came from a sibling repo.

**A fixture that establishes its precondition on the HAPPY path cannot test the
arm where the FAILING path creates it — and it stays green while the fix is
inert.** This is the most expensive shape this flow produces, because every
signal says pass. On 2026-08-20 the go-to-k/cdkd#2057 lane shipped a refusal that
could not fire on the deploy that matters: the evidence it keys on
(`state.imports[]` / `outputReads[]`) was persisted only by the SUCCESS path, so
a deploy that both INTRODUCES a cross-region read and fails recorded none of it.
The fixture passed anyway, because its phases established the read with a
successful deploy first and only then failed one. Unit tests passed, the integ
passed, four reviewers had read the diff; a fifth found it by tracing the
evidence rather than the code.

So when a fix keys on state that some earlier step wrote, ask **which step wrote
it in the fixture, and which step writes it in the reachable case**. If the
fixture's answer is "an earlier, successful one", add the arm where one operation
does both — and prove the arm discriminates by mutating the fix and confirming
the ORIGINAL arm still passes while the new one fails. That asymmetry is the
whole point: an arm that fails alongside the old one has not shown it reaches
anything new.

**An arm added to a SHARED fixture must not touch an identifier that fixture
REUSES.** An arm usually needs a resource in a state the fixture does not
normally produce, and the cheap way to get one is to reach for a name the
fixture already has. That couples the arm's failures to the whole fixture: if
the arm leaves the name in a state AWS will not immediately re-issue, every
LATER phase that wants it is blocked -- and so is the next run, for anyone.

Measured 2026-08-26 on go-to-k/cdkd#2227. The arm planted the STACK'S OWN
bucket name in a second region to force a cross-region collision. Once an S3
bucket name has existed in one region, re-creating it in ANOTHER answers
`OperationAborted` ("a conflicting conditional operation is currently in
progress") for a long time -- 40 retries across 10 minutes never cleared it,
and the name took roughly 58 minutes to free -- while `HeadBucket` already
reports 404, so nothing looks wrong. That blocked the arm, then the base
fixture's own deploy phase, i.e. every `s3-lifecycle` run, for the better part
of an hour.

The fix generalizes past S3: give the arm a PER-RUN UNIQUE identifier, and let
the stack create it only when the arm asks. Here that is one env var the fixture
sets and the CDK app reads (`CDKD_XR_ARM_BUCKET`), so every other phase
synthesizes exactly the stack it always did -- verified by running `cdk synth`
in both polarities and grepping for the resource. After the change the arms cost
no wait at all and the whole fixture ran in 200 s.

Note the same error code is worth remembering on its own: a bucket that is
mid-delete surfaces as `OperationAborted`, which cdkd already classifies as
transient and retries -- NOT as `BucketAlreadyOwnedByYou`.

**Three fixture mechanics that each cost a real-AWS cycle on 2026-08-20.** None
is visible by reading the script, and all three are caught by a stubbed dry run
in seconds:

- **A `cleanup` that ALSO runs pre-run must not destroy anything the run then
  needs.** AWS resources are safe because creating them IS a phase; a scratch
  directory computed at variable-definition time is not. A `WORKDIR="$(mktemp -d
  …)"` at load time plus an `rm -rf "$WORKDIR"` in `cleanup` plus the usual
  explicit pre-run `cleanup` call means the directory is gone before its first
  write, 200 lines from the cause.
- **Before you wait for a resource to disappear, verify the probe reports
  "still present" DURING deletion.** `DescribeStateMachine` on a deleting Step
  Functions machine returns success with `status: DELETING`, so the poll really
  waits; had it 404'd, the wait would have been vacuous and the fixture would
  have raced exactly as before. Measure the window too — 23s there — so the
  budget is a number rather than a guess.
- **A fixture whose only `cdkd destroy` exits non-zero BY DESIGN cannot honestly
  flip `integ-destroy`.** A refusal arm is a destroy that reports failure, and
  out-of-band teardown is not a cdkd destroy at all, so the marker would attest
  to a clean teardown that never happened. Add a final phase that disables the
  injection, redeploys, and runs a genuinely clean destroy — that run is the one
  the gate reads.

**Run the integ AFTER the final rebase, and expect the marker to go stale if you
do it before.** `integ-destroy` uses markgate's `hash: diff` mode, so it
invalidates when main merges a change to a file YOUR branch also touches. On
2026-08-20 the go-to-k/cdkd#2057 lane ran three integs, then rebased onto a peer
PR that had edited `deploy-engine.ts` — which that lane also edited — and the
marker correctly went stale, buying a second real-AWS run at merge time. Push
first so CI starts, then re-run the integ alongside it; the two are independent
and serializing them wastes the CI wall-clock.

**Verify the CLAIMS your fix ships with, to the same bar as the fix.** A diff
carries two things a reviewer can be wrong about: the code, and the prose
asserting what the code does — commit messages, changelog entries, PR bodies,
rationale comments. Only the first has tests, a type checker and an integ behind
it. Measured on one lane, issues go-to-k/cdkd#1882 / go-to-k/cdkd#1887 on
2026-08-25: four review rounds and five reviewer dispatches (three code, three
test, one security) found **zero defects in the code and five false statements
in the prose** — a reachability story that was wrong, a mechanism ("dies at the
first AWS call") contradicted by the same PR's own JSDoc, a scope claim ("the
last unfolded read") that ~25 sites falsified, a coverage claim asserting two
issues were "closed with evidence" while both sat open with zero comments, and a
fifth surviving copy of a claim two earlier sweeps had already corrected. Every
one was caught by a reviewer reading the SOURCE rather than the sentence.

Three habits follow, each of which caught something on that lane:

- **Grep the SHAPE, never the phrase.** Two consecutive sweeps for a stale claim
  searched the exact wording the known copies used; each missed a differently
  worded one. Section 5 says this about CODE — it is just as true of prose, and
  the fix is the same: count the population BEFORE editing and assert the count
  after.
- **A claim inherited from the ISSUE BODY is the least trustworthy of all**, and
  it arrives feeling authoritative. That lane repeated issue go-to-k/cdkd#1887's
  "the empty list propagates silently" into a commit message, a changelog entry
  and a source comment; go-to-k/cdkd#1957 had already made it false. Re-verify
  an issue's mechanism against current `main` before restating it — section 3
  already says an older issue is likelier to be wrong, and this is where that
  bites hardest, because a fix's rationale outlives the issue.
- **A correction can be a new false claim.** Twice on that lane the replacement
  for a wrong sentence was wrong in the other direction. Re-read a correction
  against the code the same way you read the original.
- **In a FIX round, the fix is what invalidated your own prose — so every
  past-tense measurement in the commit is stale until re-derived, not just the
  sentence you set out to correct.** This is the sharpest form of the rule above
  and it kept firing after the rule was already written, so state it
  generatively: a fix commit's prose is the LEAST verified thing in it. Every
  other artifact has a checker — types, tests, lint, the integ — while the prose
  is written last, under the momentum of having just fixed the thing, which is
  exactly when a sentence describing the PRE-fix world gets carried forward as
  though it still holds. Measured across one run of this skill on 2026-08-27
  (three lanes, four review rounds each): the rounds found **one** code defect
  and **ten** false claims, and every blocker but one was prose. The instances,
  because each is a different shape and no list of them would have predicted the
  next:
  - **A claim the same commit falsified.** go-to-k/cdkd#2309's changelog cited a
    ledger row — `s3-lifecycle`, `18:06:24Z`, 231 s — that the very delta
    containing the sentence had REPLACED with the `19:01:39Z` run; its "that run
    predates two later edits" caveat was therefore backwards, not merely stale.
  - **A fence claimed rather than probed.** The same lane's source said the
    guard's ordering "is fenced by a unit case anyway"; moving the guard below
    all three protection blocks left the suite 27/27 GREEN, and the case name it
    cited did not exist. The fix was to BUILD the fence (inject the missing
    table entry test-side, plus a guard-the-guard case so the ordering case
    cannot pass vacuously) rather than to retract the sentence.
  - **A tally patched instead of re-measured.** Published 20 / 21 / 18 / 2 for
    four mutations; re-measured on the shipping tree they were 23 / 24 / 22 / 3,
    the word "Twenty" was unchanged while the list had grown to nineteen rows,
    and four rows had been dropped from the sentence entirely. "Every case is
    reddened by at least one mutation" is now COMPUTED as a set difference
    rather than asserted.
  - **A blanket direction claim contradicted by its own list.** go-to-k/cdkd#2311's
    new prose said three bounds "are fail-CLOSED (they can only make the counter
    fire, never hide a site)" while its own bullet 3, four lines above, said an
    aliased logger "counts zero" — i.e. hides a site. In the PR whose entire
    subject is a fence that over-claimed, the remedy over-claimed.
  So before a fix round is FINAL, re-derive every number, every `file:line`,
  every ledger citation and every "measured" verb in the diff, and say which
  tree they were measured on. Two of these go stale on their own: a `file:line`
  drifts on every rebase (this run: `destroy-runner.ts:1236` -> `:1284`,
  `drift.ts:2114` -> `:2122`, with the function names still correct), and a
  probe count grows whenever a later round adds cases.

  **The remedy is to DELETE the unproved clause, not to rewrite it — and the
  recurring shape is a CONSEQUENCE bolted onto a verified claim.** The bullet
  above says to re-derive; this says what to do when re-deriving keeps producing
  the next round's blocker. Re-measured 2026-08-27 across a later run: two of
  three lanes shipped a false claim inside a REPAIRED rationale paragraph, and
  in both the reviewers found zero code defects. The go-to-k/cdkd#2321 lane was
  wrong in that one paragraph in THREE consecutive rounds, each time in the same
  form — "X is present-tense load-bearing: deleting it would hard-fail" — where X
  was probed and the consequence never was. A reviewer settled the last one in a
  single probe: bypassing the clause leaves `saveState` still called, because a
  per-resource catch swallows the refusal and persists the raw intrinsic rather
  than aborting. (A count is deliberately not quoted here — the first draft of
  this very bullet relayed "reds exactly one case" from that reviewer's report
  without re-deriving it, and a review of THIS paragraph measured 2 on the
  narrowest reading and 10 on the literal one. The bullet above already says a
  count needs its tree; the fix was to drop the number, not to name it.)
  What converged both lanes was cutting the unproved clauses rather than
  replacing them with better ones: **deleting a whole CLAIM cannot introduce a
  new false one, which is what makes such a round cheap to trust.** That does
  NOT extend to deleting a clause from inside a sentence — removing a qualifier
  can falsify the survivor — so after any deletion, re-read the sentence that
  remains. Say what was measured and stop there; where the observable
  consequence matters, it belongs in a test rather than in a sentence.

  This is narrower than "rewrite the fence out of existence": when the false
  claim was that something IS fenced, the repair is to BUILD the fence (see the
  bullet above), not to retract the sentence. Delete the CLAIM when nothing
  supports it; build the thing when the claim is one you want to be true.

  **Write the rationale FIRST in a fix round, not last.** The bullet above
  diagnoses WHY the prose is worst — it is written under the momentum of having
  just fixed the thing — and the ordering is the one lever that changes it. Same
  run: the go-to-k/cdkd#2321 lane was asked to do its final round rationale-first
  and it was the only round of the four that introduced no new prose defect.

**A reviewer's suggested FIX can be wrong even when its finding is right —
re-derive the fix from the source rather than pasting the patch.** The premise
check below asks whether the finding holds; this asks whether the remedy does,
and the two fail independently. Measured 2026-08-26 on the issue
go-to-k/cdkd#2052 lane: a security reviewer proved by probe that an age-only
sweep would delete live `state.json` under a colliding `--state-prefix`, which
was correct and a blocker, and offered
`/^cdkd-\d+-[0-9a-z]+\.json$/` as the key-shape filter. Reading the producer
showed the suffix is `Math.random().toString(36).substring(7)`, which returns
the EMPTY string whenever the base-36 rendering is shorter than eight
characters -- so `cdkd-<epoch>-.json` is a key cdkd really writes and the `+`
would have skipped exactly those. Adopting it would have traded an
over-collection bug for an under-collection one that is INVISIBLE, since a
sweep that collects nothing looks identical to a clean bucket. The tell is
generic: a reviewer reasons from the diff, so a suggested REGEX, bound, or
constant is the part it is least able to verify. Derive those from the code
that produces the value, and probe both directions.

**Check a reviewer's PREMISE before acting on the finding, and say so when you
decline.** Reviewers are read-only and reason from what they can see, so a
suggestion can be correct in form and rest on a reachability claim that is
false — and acting is not free, since a "just add a sentence" edit to a gated
file buys a real-AWS cycle. On 2026-08-21 a reviewer asked that
`deploy-engine.ts`'s call-site comment name a second guarantor, because the
engine is also constructed from `NestedStackProvider.update`. Tracing it took two
greps: `rollback.ts` builds a DESTROY-mode nested-stack context, so
`requireDeployContext` throws before a child engine exists, and the only
deploy-mode context is `deploy.ts`'s own — the guarantor is identical on every
reachable path and the comment was already complete. Record the trace in the PR
body and the commit: a declined finding with evidence is a decision the next
reader can re-judge, while a silently dropped one looks like an oversight.

**A premise fails in the other direction too — a reviewer can assert that a
fence does NOT exist, and acting on that is how you turn CI red.** Measured
2026-08-27: a spec reviewer reported "no mechanical byte-budget gate exists in
the repo — the minimality was self-imposed" and, on that basis, proposed a
~30-byte doc reword. `tests/unit/scripts/rule-file-payload.test.ts` does exist,
the edited line was **3,998 B against a 4,000 B cap**, and the repo-wide
long-line ratchet stood at exactly **24/24** — so the suggested fix would have
made it 25 against a budget that only decreases. The implementing agent's
instinct to keep the edit minimal had been right and the reviewer called it
unnecessary. An absence claim is the one a reviewer is least able to establish,
so verify it by running the thing said not to exist.

**Your own BRIEF to a lane agent is a published claim, and it inherits every
fact you relayed without checking.** The trigger for verification is
DESTINATION, not doubt, and a fix instruction is a destination: the agent acts
on it without the standing to re-derive it. Same run, twice: a test reviewer's
claim that `scrub.ts` is a NON-`bestEffort` caller went into a brief unverified
and was false (`resources:` and `bestEffort: true` are fields of ONE object
literal, so scrub short-circuits before the predicate — the coverage gap was
real, its stated justification was not); and an arm shape specified in another
brief would have been VACUOUS for a reason the agent had to find and report
back. Grep the claim before you put it in an instruction, and when an agent
corrects your brief, say so in the report rather than absorbing it silently.

**A REVIEWER brief is the same published claim, and it fails worse.** The rule
above is written for a brief handed to a lane agent, where a false premise
produces a wrong edit you will see in the diff. A reviewer given a false premise
aims its WHOLE ROUND at the wrong subject and returns a report that reads as
authoritative, so nothing downstream flags it. Measured 2026-08-27: the
orchestrator relayed a lane's "a membership filter makes S3 create the bucket in
`us-east-1`" into THREE reviewer briefs without checking it. It was false — the
provider's constructor takes an already-region-bound client, so the request
never reaches the global endpoint that default belongs to — and the security reviewer's entire framing
(data residency) rested on it until it was corrected mid-flight. Grep every
mechanism claim before it goes into a brief, and when you find one already sent,
correct it in-flight rather than waiting for the report.

**When two reviewers CONTRADICT each other, settle it in the code yourself
before forwarding either.** On 2026-08-20 the spec reviewer explicitly CLEARED
the evidence-persistence issue the security reviewer called a blocker, both
having read the same lines. The code's own comment settled it in one read
("persisted only on the final success path"). Forwarding both verdicts to the
implementing agent would have handed it a contradiction to adjudicate with less
context than you have — and forwarding only the reassuring one is how a blocker
ships. Say in the fix message which reviewer was right and why, so the agent
does not re-derive it.

**That rule holds for a claim about THIS REPO. For a claim about what an
EXTERNAL system does, neither reviewer can settle it and neither can you —
the tie-break is a MEASUREMENT.** The two cases look identical in the reports
and come apart only in what would resolve them, which is why this is stated
rather than left to judgement. Measured 2026-08-27 on the go-to-k/cdkd#2274
lane: the spec reviewer wrote that CloudFormation masks a `NoEcho` custom
resource's `Data` on the wire, the code reviewer called that unmeasured
folklore, and both had read the same source. No amount of code reading could
decide it. A live CFn A/B — one stack, `us-east-1`, that date's CloudFormation —
returned the plaintext to a dependent SSM parameter AND to a stack Output, with
the handler's own log proving `NoEcho: true` really reached the service. The
answer overturned the lane's entire design, which was discarded rather than
merged. `CLAUDE.md`'s "never file divergence on folklore" already requires the
A/B; this is the pointer from the place the contradiction actually surfaces.
The tell is grammatical: if the disputed sentence names a service rather than a
file, stop reading code and go measure.

**Fresh deploys: UNIQUE stack names only** (e.g. `Cdkd<Issue>Verify`), never a
shared fixed name and never a real prod stack — the account may hold the
maintainer's production stacks. Tear down with `cdkd destroy … --force`, then SWEEP
for orphans it can't reach (auto-created `/aws/lambda/*` log groups from
`autoDeleteObjects` custom-resource Lambdas, RETAIN stateful resources, Secrets in
recovery, KMS keys pending deletion). Confirm state is gone:
`aws s3 ls s3://cdkd-state-$(aws sts get-caller-identity --query Account --output text)/cdkd/`
should show no leftover stack (the `deployments/` events store legitimately
survives — it is not an orphan). If destroy failed or left orphans, delete them by
direct AWS API call before doing anything else.

`/verify-pr` sets the `check` + `docs` + `verify-pr` markers, and `/run-integ` sets
the `integ-*` markers — together they unblock `gh pr merge`.

