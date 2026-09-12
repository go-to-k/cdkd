<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One tree per lane, then implement

This stage (and 6–8) normally runs INSIDE a lane subagent — one per claimed
issue, so its diffs, test output and review round-trips stay out of the parent
context. Every rule below holds unchanged there: hooks fire on the lane's tool
calls, markgate markers land in the lane's own tree. Two actions stay with the
parent's serialization turn: a real-AWS integ run and the merge (§9). A lane
stops at merge-ready.

### 5-a. The tree

Never edit in the main checkout (`main-tree-branch-gate` blocks branching
there). Per lane:

```bash
# MAIN-CHECKOUT only (CLAUDE.md holds it, and why IN-PLACE creates NO
# worktree; mode probe: references/launch-mode.md, its only copy).
# IN-PLACE skips these two and branches by the recipe below.
git worktree add .claude/worktrees/<branch> -b <branch> origin/main
cd .claude/worktrees/<branch>
mise trust && mise install   # untrusted .mise.toml: vp / markgate will not resolve
pnpm install                 # worktrees have no node_modules
vp run build                 # ...and no dist/ — see below
```

**IN-PLACE: confirm the tree is YOURS before adopting it** — a stray `cd` into
a peer's live lane looks like a workspace handed to you. Under §9's rule that
an ownership signal establishes LIFE and never absence, any probe below saying
"someone is here" means STOP and report — never nest a worktree in a peer's
lane to get out of it.

```bash
# The FIRST line is the anchor: every probe under it describes THIS shell's
# tree, so a silently reset cwd (appendix, "Bash cwd silent reset") shows up
# IN THE OUTPUT instead of being invisible.
git rev-parse --show-toplevel   # STOP unless this is the tree you meant to adopt
git status --porcelain          # non-empty: someone's uncommitted work
git branch --show-current       # the branch you would be committing to
git log --oneline -3            # whose commits these are
cat "$(git rev-parse --git-dir)/session-owner" 2>/dev/null   # owner sentinel
```

Then read the issue thread for a claim naming this branch — across clones it
is the only signal the probes above cannot see.

The rule is SYMMETRIC: **the orchestrator does not edit a live lane's tree
either.** An uncommitted parent edit there is wiped without a trace by the
lane's next amend + force-push — no conflict is reported (2026-09-05: a
parent-side `.claude/rules` trim vanished into go-to-k/cdkd#2620's fix round,
both parties trimming the same cumulative budget). Hand the edit to the lane as
an instruction; the lane owns the write.

**Take a fresh branch here — ALWAYS, and WITHOUT leaving the tree.** The
branch this tree arrived on is `LAUNCH_BRANCH`: the OUTER TOOL's, not this
run's, and §9 puts it back untouched at the end (`references/launch-mode.md`
carries the rule and why committing onto it would DELETE the outer tool's
branch, and why the ALWAYS is unconditional — go-to-k/cdkd#2417).

```bash
git status --porcelain   # must be empty FIRST -- `git switch` carries
                         # uncommitted changes ACROSS, moving someone else's
                         # work onto your lane branch
git fetch origin && git switch -c <branch> origin/main
```

The `&&` is deliberate: unchained, a failed `fetch` still branches off a stale
`origin/main`. `main-tree-branch-gate` covers this chained spelling
(`.claude/rules/hooks-main-tree-branch.md`) — settle which copy is DEPLOYED by
content, never by a commit subject.

**`mise trust` is not optional, and skipping it fails in the direction that
costs most**: an untrusted `.mise.toml` makes `mise exec -- markgate set`
error instead of writing, and a pipeline's rc hides it (2026-08-28: two `mise
ERROR` lines, every gate still `no marker`). Verify with `markgate status`,
never an exit code.

**Build BEFORE the first test run.** A new worktree has no `dist/`; a test
spawning the built CLI fails with an assertion about its SUBJECT, and the main
checkout passes only because it HAS one — a docs-only lane nearly reported "a
peer merge broke main" over 13 such failures. A fresh tree failing where the
main checkout passes is evidence about the TREE first.

### 5-b. Sweep the class, not the instance

**Before fixing, ask whether the defect has SIBLING SITES — and sweep them in
THIS lane rather than filing them.** Most are a CLASS: once the root cause is
named, grep the shape across the repo. Rules, each bought by a measured miss:

- **Query for the PRECONDITION minus the REMEDY, never the remedy alone.**
  A grep for a MISSING thing returns only the sites that already have it:

  ```bash
  # WRONG -- only the providers that already validate.
  grep -rln "validateDesiredProperties" src/provisioning/providers/
  # RIGHT -- eligibility minus remedy.
  for f in $(grep -rln "implements ResourceProvider" src/provisioning/providers/); do
    grep -q "validateDesiredProperties" "$f" || echo "NO VALIDATION: $f"
  done
  ```

  go-to-k/cdk-local (2026-08-27): the remedy-shaped grep saw 5 of 12 eligible
  sites — this repo's defects are often MISSING entries (an absent
  `handledProperties` row), invisible to a grep for what they lack.
- **A FIX ROUND owes the same sweep, and a sibling takes the same REMEDY only
  when it takes the same PREMISE — for a REFUSAL, what refusing COSTS there.**
  The sweep half is what gets skipped: the fix lands on one call site while a
  sibling keeps the defect, usually shipping a comment claiming completeness.
  Measured on two lanes in one day: the 2-arg
  `Fn::Sub` check missing the bare-string arm one line over; a redaction fixing
  update/delete but not create; one enumeration fixed while a second in the
  same file — and a third on the same LINE — kept the defect. All found by
  enumerating readers with grep, none by re-reading the diff. **So does a
  SWEEP, over its OWN output** — re-run the predicate on the diff the sweep
  produced (go-to-k/cdkd#2662: three of a run's ten false-guarantee comments
  were added or left by a sweep meant to end that class). After writing a fix:

  ```bash
  # Derive the population from the CODE, not the files your diff touched.
  grep -rn "<the field / helper / message you changed>" src/ | grep -v test
  ```

  Cheap tell: a diff touching ONE site whose message says "every", "all",
  "never" or "only" — derive the population or drop the quantifier. The PREMISE
  half is worse because it looks done: enumerate the DESTINATIONS a refusal
  reaches before round one and key on the destination, never on the EVIDENCE
  (an empty map — the near-miss that survived two rounds). It kept returning
  as a blocker across go-to-k/cdkd#2882 / go-to-k/cdkd#2912 in two residual
  flavours: a mask written where refusing is a REGRESSION (`export` blocks the
  record), and a pairing floor whose refusal WRITES a token over a live value
  in the arm that borrowed it while safely DROPPING THE RESOURCE in the arm it
  came from (`drift.ts`'s `acceptForcedSingleton` doc states it at the site
  that paid).
- **Grep for the SHAPE, not a NAME — then close the set from the READERS,
  because a literal shape is defeatable too.** A name finds only the copies you
  knew about (go-to-k/cdkd#2176: `maskDeep` found four and shipped "four";
  there were SIX, two spelled `maskLeaf*`), and a shape misses the same with
  an expression spliced in (go-to-k/cdkd#2874: a ternary in the argument hid a
  THIRD call site from the grep that built the issue's own work table). Grep a
  structural line every copy must share, confirm by name second, take the COUNT
  from an enumeration of the readers.
- **Count the population BEFORE you fix, assert it afterwards** — the post-fix
  tree cannot show a copy the sweep never saw, and a count taken from the
  instance you happened to hit is what a future session's `Effort` /
  `Estimate` is wrong by (one run sized a residue at one site; the class was
  seven). A fix REMOVING a behaviour owes
  a SECOND population: the assertions that it happens, which do not go red when
  it stops (`references/verify.md` §8-d).
- **A sweep's number is unearned until you paste the command that produced
  it, and re-run that command before you ship** — one claimed "88 hits across
  13 files"; the reviewer's grep returned 47. A count RELAYED from a subagent
  is the same failure without a command (FOUR published in one run, all wrong),
  and AGREEING with one is not corroboration: on go-to-k/cdkd#2719 a subagent
  and I both said "five sites" where `grep -c` said seven. The tell is
  grammatical — a number arriving as a WORD was counted by an agent, as OUTPUT
  by a machine. Give each one of `references/verify.md` §8-g's dispositions.
- **Grep the SYMPTOM before deriving a fix** — the same QUESTION may already
  be answered (a lane spent a real-AWS round trip rediscovering the SDK
  region-redirect mechanism sitting verbatim in `src/utils/aws-region-resolver.ts`).
- **Grep the ISSUE NUMBER — a third key.** Closing an issue falsifies every
  comment CITING it; the dangerous ones are deliberate NON-assertions carrying
  neither shape nor symptom
  (`git grep -n "<issue number>" -- src tests docs .claude`). Measured on
  go-to-k/cdkd#2466 closing go-to-k/cdkd#2421: four live citations, one a
  "deliberately NOT asserted" bullet in a fixture that already synthesized —
  adding the assertion cost nothing and found a SECOND failure mode, usually
  the cheapest high-value test in the change.

**A defect the sweep turns up that this lane is NOT fixing gets FILED** —
`references/filing.md` (§5-f) owns those rules.

### 5-c. The fix itself

Do the fix in the lane's tree, matching the existing pattern. CLAUDE.md owns
the mechanics — ESM `.js` imports, `vp run build` after every source change,
a unit test under `tests/unit/**` with the AWS SDK `vi.mock`ed; make that test
**fail without the fix and pass with it**. **Check whether the artifact
already has a test harness** — `.claude/hooks/` carries per-hook `*.test.sh`
suites run by `run-tests.sh`, not visible from `tests/unit/**`.

- **Run such a harness from BESIDE its subject, never from a scratch copy** —
  every suite resolves the hook under test from its own script path, so a
  copy fails everything with exit 127. For a before/after comparison, write
  the old copy beside the real one as `.claude/hooks/_old-<name>.test.sh` and
  delete it after. §8's scratch-copy idiom is right for a data file, wrong for
  a runnable harness and wrong for a WORKTREE (§8 carries both mechanisms).
- **When the issue reports a stale ENTRY in an enumerated list, audit the
  whole list in BOTH directions** — every entry still resolves AND everything
  that belongs is present; the second half is the one skipped
  (go-to-k/cdkd#1972: the issue named one dead path, the audit found a second
  plus four live surfaces never added). A list that must stay in sync with the
  repo is a test, not a sentence.
- **Adding a HANDLER to a slot that already has one REPLACES it.** Bash
  `trap` does not chain: a second `trap ... EXIT` silently disarms the first,
  which in an integ fixture is the AWS teardown (a reviewer-nit fix would
  have traded a leaked temp file for live AWS resources on every failure
  path). Put the work inside the EXISTING handler or re-install one that CALLS
  the original (fenced by `tests/unit/scripts/integ-single-exit-trap.test.ts`);
  before adding to ANY single-slot registration, count what is there.

### 5-d. Measurement audits

**When the audit is a MEASUREMENT, the shape of the sample is the finding — a
clean result from the wrong shape is indistinguishable from a clean subject.**
go-to-k/cdkd#2096's audit produced SIX confident wrong answers, each from a
plausible sampling shape, each hiding a real secret: newest-N (the newest
versions come from the run likeliest already fixed — sample the range); one
global needle (each fixture spells its own literal — derive it per subject, or
assert a needle-independent observable); a name from convention (read it from
the subject's own `STACK=` line); a silent parse failure in a pipe (a parse
that can fail must report failing, not fall through to a count); a per-page
aggregate (`--query 'length(...)'` applies PER PAGE — count rows of a
projection); and grepping a layer the subject does not use (a type registered
to NO provider takes the Cloud Control readback, invisible in
`src/provisioning/providers/**`). Every one FAILED CLEAN: run the shape against
a case you KNOW is dirty first; only then trust a zero.

### 5-e. Mutation probes

**COMMIT the round's real fixes BEFORE running any mutation probe** — a probe
deliberately breaks the tree, so an interruption leaves breakage and unfinished
fixes in one dirty tree (a lane died at the session limit with 9 dirty files;
go-to-k/cdkd#2416). With a pre-probe commit the separator is `git diff`.

**Restore a probe from a BYTE-EXACT COPY, never an inverse string replace**
(`cp` before, `cp` back, proved by `git diff -- <file>` printing nothing). An
inverse replace is a second edit: Python's `str.replace('', x)` matches between
every character and rewrote an 11 KB file to 838 KB, scoring the three probes
after it against a corrupted subject.

**Probe the CALLER too, and the WAY IN** — `.claude/rules/testing.md` →
"Mutation probes" owns both — wiring, and the vacuity a normalising entrypoint
causes — plus the one-mutation-per-probe rule.

**A mutation probe proves a test discriminates only if it changes the value
the test READS.** Four vacuous tests shipped in one day, all one shape: the
assertion targeted an observable the BROKEN code also produces — a confluence
point. Name the discriminator first and assert THAT (which client, which
region, what the second invocation saw); "the happy path still happens" is
almost never it. A test that still passes under the mutation that motivated
it is worse than no test. **And a case pinning "the tool does NOTHING here"
must record what the input DOES** — one asserted a padded token comes back
unchanged while that input really runs `git commit`, so a live bypass became
its own alibi (go-to-k/cdkd#2333).

**A probe that reports NO discrimination is a claim about the FENCE — three
other things produce identical output.** Ask in order before touching the
fence: (1) **did the edit land WHERE YOU AIMED IT?** — the probe's RECEIPT,
not a post-mortem (5-g's rule applies to a probe you run yourself):
`grep -c '<anchor>'` BEFORE, `git diff -- <file>` after, read the hunk.
**AIMED IT means the PRODUCTION file**: re-typing the subject's logic inside
the test mutates a COPY and reports RED for a fence that does not exist
(go-to-k/cdkd#2662: "27 probes, ALL RED", one of them green; reverting
production turned six more floors green). A
count above 1 decides the tool, in opposite directions: `sed` / `perl -pi`
are per-LINE, so a RED can belong to every copy at once, while `perl -0pi`
without `/g` mutates only the FIRST in the file — which on go-to-k/cdkd#2627
hit one of four identical lines, left the arm under test untouched, and
reported a false GREEN;
(2) **does the case's execution path REACH the edited line?** (the fix is a
case that must take that path, not a fence change); (3) **did the command run
where you think it did?** (appendix, "Bash cwd silent reset" — absolute paths,
and a property the wrong tree cannot fake). Plus one fixture shape: **an
expected value must be an INDEPENDENT variable from the one under test.** Only
after all four does "the fence is weak" remain.

**A RED probe is void as easily as a green one** — the multi-copy anchor
above is one way, and an edit that does not COMPILE is another: it fails the
suite at LOAD, indistinguishable from discrimination. Read the TALLY and
failure TEXT, never the rc — it lies in
both directions (§6's rc rule; a suite can `skipIf` itself when `dist/` is
absent). A load error or a short test count VOIDS the probe.

**When you REJECT part of a prescribed fix, make the rejection a PROBE by
APPLYING it.** The usual probe breaks the code to prove a test discriminates;
this one applies the alternative you turned down and proves a test REFUSES
it — the only artifact that keeps a deliberate rejection from reading as an
omission. go-to-k/cdkd#2578 asked for an absent S3 `Versions` /
`DeleteMarkers` to count as a non-answer, by analogy with its log-group twin;
applied literally that refuses every EMPTY bucket, so the third probe applied
the issue's own prescription and one test went red. Write that control before
writing the paragraph that explains why you did not do what was asked.

**A probe MATRIX that must recur is a SCRIPT, not a re-measured table** —
§8-g's "delete the number" disposition. Re-measuring on the merge tree was
already the rule and a table went stale TWICE in one lane anyway, a reviewer
catching each; a harness instead PRINTS the tallies and exits non-zero when a
mutant discriminates nothing, so an inert probe is reported, not assumed
absent (go-to-k/cdkd#2333, `.claude/hooks/lib/command-match-mutants.sh`).

**A VALUE import from a module other suites `vi.mock` reds those suites** —
the failure names the EXPORT, reading as a missing symbol rather than a
mocking problem. When two modules must agree on a constant and one is widely
mocked, spell it in both and fence the pair with a test importing both.

### 5-f'. Scanner/fence calibration (when the fix ships a repo-wide check)

**Calibrate against the PRE-FIX tree, not the issue's wording** — run the
candidate over the still-broken tree, read every hit, tighten until all are
genuine. Two markdown sub-traps: strip exemption regions on the WHOLE text,
not per line (a code span straddling a hard wrap inverts per-line parity),
and report the HIT's own line.

**Calibration is HALF the measurement — follow it with probes against the
real tree:**

- **Spell the injected defect the way its SOURCE would** — not the easiest to
  inject, nor one you have proved you can see. Four wrong choices: the line
  you just removed (a fence caught that while missing computed members,
  `Object.assign`, an object literal, a spread rebuild); the injectable
  spelling over the one a PERSON types (go-to-k/cdkd#2052); one spelling
  where the language allows several — probe each (`||` matched while four
  sites used `??`; widening it found a real unfiled bug, go-to-k/cdkd#2111);
  and, for GENERATED input, the UPSTREAM form not the generator's output
  (go-to-k/cdkd#2788 injected
  `/properties/X`, a prefix the generator strips, so the probe "proving" it
  discriminated used a shape no fixture holds). It governs any probe's VALUE
  input too — ask what property of it the defect depends on (a
  mask-before-stringify fix stayed green under its own mutation until the
  secret was a JSON document, not a scalar).
- **Delete the thing the fence REQUIRES and watch it fail.** An OR of
  whole-file substrings is satisfied by any one; a population derived from
  the DEFECT itself drops the subject out instead of failing (a gate-parity
  test selecting gates by their own condition stayed green with two gates
  disarmed). A population derived from an OPTIONAL language feature (a type
  annotation, an explicit return type, `implements`) is derivable-around for
  free — derive from a relation the write CANNOT omit, and ask: what would
  this look like if the author did not write the optional part?
- **Watch the FLOOR for the same collapse** — a floor naming only the file
  the defect lives in is satisfied BY the collapse; a floor computed from the
  pool it guards is unfalsifiable (emptying the pool left it green). Write
  the expected count as a LITERAL from a source the fence does not read. **A
  RELATION also needs a floor on the COMPARAND** — walk floors count what you
  ITERATED, and a set-vs-set claim is vacuously TRUE when the other operand
  parses empty (go-to-k/cdkd#2788: 134 fixtures compared nothing under two
  healthy walk floors; the invariant as stated was FALSE). **And a floor must
  count at the GRAIN it protects** — one incremented at PHASE boundaries
  survives deleting the individual assertion it was added for, so bump it per
  ASSERTION and probe by deleting SEVERAL: one deletion can still clear an
  aggregate, reading as a fence that discriminates (go-to-k/cdkd#2842's
  `tests/integration/import-secret-observed/verify.sh` — `ASSERTIONS_RUN`
  bumped at each of 14 assertions, all 14 deletion-probed).
- **Is anything RUNNING it?** (nine shell hook harnesses were invoked by no
  CI step and no task — exercised only by hand since written).

**When the change alters a CLASSIFIER, hand-picked cases cannot fence it —
measure the DELTA against the old implementation.** A classifier is any
function deciding which of several shapes an input is (a
region-vs-stack-name predicate, a route selector, an error categoriser); its
defects live in shapes nobody wrote down (go-to-k/cdkd#2001: three green
revisions, each fixing the named case and breaking a neighbour; the
differential walk ended it in one round). The fence: enumerate the input
space, run BOTH the new implementation and a transcription of the old one —
taken from `git show origin/main:<path>`, never from memory — and fail on any
difference outside an explicitly enumerated set of intended classes: a shape
nobody imagined is a failure by default. Confirm agreement on the cells where
they SHOULD agree before trusting the cells where they differ. Two ways it
goes inert, both measured: **classify by the resulting VALUE, not the input's
shape** (bucketing a differing cell by which key it was let a total
regression sit in the "intended repair" bucket, fence green); and **carry a
floor per class** (the walk reaches a class only if the input pool contains
it — a pool that quietly stops covering one passes as "no regressions").

**When a fence must read another tool's CONFIG — or a SOURCE file — parse it
with a real parser and fail CLOSED on anything unmodelled — never hand-roll a
scanner, never patch one per spelling.** Measured across three sibling fences
over `.markgate.yml` (go-to-k/cdkd#2383, go-to-k/cdk-real-drift#1838,
go-to-k/cdk-local#631): the unused key (`exclude` — read the tool's OWN
schema from the pinned binary, not its `init` template); then the spelling
treadmill — four spellings across four rounds, each patch moving the hole.
**Three spellings in three rounds is the signal to change instrument — count
them in the commit subjects**: go-to-k/cdkd#3029 reached SIX regex spellings
of one TS function's term list before the compiler API (`typescript-v6`)
ended it. Parse for real (`yaml`'s `parse(text, { merge: true })`),
allow-list the tool's own keys, fail closed outside them — or REFUSE the
construct rather than model it
(refusal is the stricter option: an unmodelled shape stops the fence instead
of passing through).

**The general shape: a fence is not evidence until you have watched it go red
on something you had not already counted.**

**No number of probes can falsify the FIXTURE — a mutation probe perturbs the
CODE and reads the TEST while both read the same mock.** Any premise SHARED by
code and mock is invariant under mutation (go-to-k/cdkd#2227: seven cases
passed, probed both ways, and the guard could not fire against real AWS — the
mocks encoded the AWS CLI's redirect-following behaviour, not the SDK's). A
fixture encoding an AWS response needs its own evidence: a recorded real
response, a live arm, or a probe against the SDK.

Two more fence questions (go-to-k/cdkd#2027): **does it watch the OTHER
direction?** ("refuses what it must" AND "leaves alone what it must" — only
the second catches an over-tightening fix); **is it hermetic, and on WHICH
axis?** (enumerate git history, environment, cwd, clock, locale, user; pin
each or record a measured negative — prefer PINNING over normalizing, since a
normalization layer sits exactly where a fence goes green-but-inert).
`realpath` a scratch ROOT — macOS `tmpdir()` says `/var/…`, git
`/private/var/…`, and three spawn cases under the raw root passed with stdout,
stderr and rc identical to a clean run, caught only by a vacuity probe
(go-to-k/cdkd#3029; second occurrence).

### 5-g. Fan-out mechanics

You may fan out **one subagent per lane** (disjoint files): give each its
worktree path, allowed files, "do NOT touch other lanes' files; STOP and
report if the fix needs a forbidden one", and **the REPORT SHAPE — the
report IS the deliverable**: a lane's tool output never reaches you, so a
one-line "done" loses the run (2 of 3 lanes, 2026-09-05) — as does a lane that
finishes with NO report reaching you (twice, 2026-09-10: only its nested
reviewers' notifications arrived, reading as progress). Never wait on a quiet
lane: list the agents, resume any already `completed` with "REPORT ONLY, do not
touch the tree" — a plain resume re-edits, and a lane whose TRANSCRIPT is gone
(`could not be resumed`, 3x in one run) restarts only from a prompt you kept
SELF-CONTAINED and still hold.

A subagent's Bash **bypasses the PreToolUse gate hooks** (it can `gh pr create` past `verify-pr-gate`) —
enforce quality yourself; the orchestrator still gates the MERGE.

- **Forbid lane agents the FULL SUITE; run it yourself, serially.** Five
  concurrent full suites drove load to 195 and all three lanes were killed by
  the 600s watchdog with timeouts in files no diff touched; serialized, the
  same trees were green. Each agent runs only `vp test run <its own suite>`.
- **A PEER SESSION's suite is invisible to every probe here** — a full suite
  exited 1 with all tests passing (`Worker exited unexpectedly`, load 54, the
  heaviest vitest in another session's worktree). Before reading a suite
  failure as a regression, check the rc, the error section, `uptime` and `ps`
  for a vitest whose path is not yours; re-run when the machine is quiet.
- Budget two fan-out costs: a lane waiting inside a tool call is killed at
  600s of silence (background long runs with a log redirect, poll with
  short `tail`s), and a fix round re-touching an `integ-*` scope invalidates
  that gate's marker — the gate working; budget the run.

**Guardrails every lane prompt must carry** (each learned the hard way):

- **Never force-push over a commit you did not author** — re-`git fetch` and
  inspect the branch first; STOP if it carries work you did not write.
- **A new fixture literal must not collide with an existing assertion needle,
  nor a new fixture RESOURCE with an existing resource's VALUE** (a hard-coded
  URL user equal to the swept needle produced a false LEAK report, worse than a
  missing assertion; an arm reusing a plaintext an existing assertion owned
  failed on an assertion the lane never wrote, go-to-k/cdkd#2270). When an arm
  makes two things equal, ask what ELSE holds that value; scope the sharing. **And check
  the arm's shape actually exercises the fix before spending a run** (two
  separate resources was vacuous — only one holding both leaves let the
  mechanism under test decide).
- **Execute every read expression you write** — jq / JMESPath / `--query`
  are untested code; run each against real output shape, in both directions
  where the expression carries a guard.
- **Do not dispatch reviewers against a worktree whose lane has uncommitted
  work** — reviewers probe by edit-and-restore-from-`HEAD`, which restores
  HEAD, not in-flight work (three `src/` edits wiped). Commit the lane first;
  when a lane resumes after a review round, it re-runs
  `git status --porcelain` and `git diff --stat` FIRST and reports both.
- **Reviewers collide with EACH OTHER — a 3-axis dispatch puts three in one
  worktree by construction.** Say IN THE PROMPT of every reviewer: peers are
  probing this same worktree; `git status --porcelain` must be EMPTY before
  you start a probe; if not, WAIT and re-check rather than restoring (a
  `git show HEAD:<path>` over a peer's edit reverts it); read any surprising
  probe result as possibly theirs first. §8 adds the AFTER half and the
  copied-worktree hazard; both also live in `.claude/agents/pr-*-reviewer.md`.
- **That is a DURATION constraint, and the ORCHESTRATOR breaks it most
  easily**: reviewers restore from a snapshot at THEIR t0, so an orchestrator
  edit landing inside the review window is reverted by a restore behaving
  correctly. Dispatch, then do not touch the files under review; if you must,
  re-verify with `git status --porcelain` plus a `grep -c` per edit.

**Two probe-harness failures that reported a false green:**

- **A scratch harness silently REPLACED by another agent's same-named file**
  (its `__main__` was `pass`; four probes "passed" applying nothing).
  **The ORCHESTRATOR assigns each dispatched agent a unique scratch directory
  IN ITS PROMPT** (`$SCRATCHPAD/lane<issue>-private/`,
  `$SCRATCHPAD/rev-<role>-<sha>/`) — the ask-agents-to-invent-a-name rule was
  broken three times in one run. Make every probe emit a positive receipt it
  cannot produce without having run (`bytes 41822 -> 41799; anchor now 0
  (was 1)`), and read the receipt, not the exit code.
- **A probe's FIXTURE, not its mutation, decided the outcome** — a region
  test set `AWS_REGION` where correct code and mutation bind identically.
  Suspect the fixture first when a probe comes back green, especially an
  expected value COINCIDING with the ambient default (`'us-east-1'` is at once
  the fixture region and the repo's fallback; 434 tests stayed green under
  substitution). Choose a value the default can never produce.
