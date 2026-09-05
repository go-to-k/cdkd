<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 5. One tree per lane, then implement

This stage (and 6–8) normally runs INSIDE a lane subagent — one per claimed
issue, so its diffs, test output and review round-trips stay out of the parent
context. Every rule below holds unchanged there: hooks fire on the lane's tool
calls, markgate markers land in the lane's own tree. Two actions stay with the
parent's serialization turn: a real-AWS integ run and the merge (§9). A lane
stops at merge-ready. (Placement live-proven 2026-08-28: two skill-split PRs
built end-to-end by lane subagents with every hook firing inside the lanes.)

### 5-a. The tree

Never edit in the main checkout (`main-tree-branch-gate` blocks branching
there). Per lane:

```bash
# MAIN-CHECKOUT mode only. IN-PLACE (launched inside a linked worktree) skips
# these two and creates NO WORKTREE -- nesting dies with the outer workspace
# (go-to-k/cdkd#2390). It DOES still take a branch, in place: see the branch
# recipe below, which is unconditional. (The probe lives in
# references/launch-mode.md, its only copy.)
git worktree add .claude/worktrees/<branch> -b <branch> origin/main
cd .claude/worktrees/<branch>
mise trust && mise install   # untrusted .mise.toml: vp / markgate will not resolve
pnpm install                 # worktrees have no node_modules
vp run build                 # ...and no dist/ — see below
```

**IN-PLACE: confirm the tree is YOURS before adopting it** — a stray `cd` into
a peer's live lane looks exactly like a workspace handed to you. Read every
probe below under §9's rule that every ownership signal establishes LIFE and
never absence: any one saying "someone is here" means STOP and report — never
nest a worktree inside a peer's lane to get out of it.

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
lane's next amend + force-push — the lane never sees it and no conflict is
reported (measured 2026-09-05: a parent-side `.claude/rules` trim vanished
into go-to-k/cdkd#2620's fix round, and both parties were trimming the same
cumulative budget). Hand the edit to the lane as an instruction and let the
lane own the write.

**Take a fresh branch here — ALWAYS, and WITHOUT leaving the tree.** The
branch this tree arrived on is `LAUNCH_BRANCH`: the OUTER TOOL's, not this
run's, and §9 puts it back untouched at the end (`references/launch-mode.md`
carries the rule and why committing onto it would DELETE the outer tool's
branch). The ALWAYS is deliberate: the rule was conditional until
go-to-k/cdkd#2417 and the condition was wrong in the common case.

```bash
git status --porcelain   # must be empty FIRST -- `git switch` carries
                         # uncommitted changes ACROSS, moving someone else's
                         # work onto your lane branch
git fetch origin && git switch -c <branch> origin/main
```

The `&&` is deliberate: unchained, a failed `fetch` still branches off a stale
`origin/main`. `main-tree-branch-gate` covers this chained spelling since
go-to-k/cdkd#2406 — settle which copy is DEPLOYED by content, never by a
commit subject (`git show origin/main:.claude/hooks/main-tree-branch-gate.sh |
grep -c gate_verb_rest_each` prints non-zero).

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
THIS lane rather than filing them.** Most defects here are a CLASS. Once the
root cause is named, grep the shape across the repo. Rules, each bought by a
measured miss:

- **Query for the PRECONDITION minus the REMEDY, never the remedy alone.**
  A grep for a MISSING thing returns only the sites that already have it:

  ```bash
  # WRONG -- finds only the providers that already validate.
  grep -rln "validateDesiredProperties" src/provisioning/providers/
  # RIGHT -- eligibility minus remedy.
  for f in $(grep -rln "implements ResourceProvider" src/provisioning/providers/); do
    grep -q "validateDesiredProperties" "$f" || echo "NO VALIDATION: $f"
  done
  ```

  Measured in go-to-k/cdk-local (2026-08-27): the remedy-shaped grep saw 5 of
  12 eligible sites. This repo's defects are often missing entries (an absent
  `handledProperties` row, a provider with no validation arm) — invisible to
  a grep for what they lack.
- **A count derived from the instance you happened to hit is not a count** —
  the same run sized a deferred residue "one site, ~30 min"; the class was
  seven. `Effort` / `Estimate` are what a future session budgets from.
- **A FIX ROUND owes the same sweep, and that is where it gets skipped**:
  the fix lands on one call site while a sibling keeps the defect, usually
  shipping a comment asserting completeness. Measured FIVE times on two lanes
  in one day (the 2-arg `Fn::Sub` check missing the bare-string arm one line
  over; a redaction fixing update/delete but not create; one enumeration
  completed while a second in the same file — and a third on the same LINE —
  kept the defect). Every one found by enumerating readers with grep, none by
  re-reading the diff. After writing a fix:

  ```bash
  # Derive the population from the CODE, not from the files your diff touched.
  grep -rn "<the field / helper / message you just changed>" src/ | grep -v test
  ```

  The cheap tell: a diff touching ONE site whose message says "every", "all",
  "never" or "only" — derive the population or drop the quantifier.
- **Grep for the SHAPE, not for a NAME** — a name finds only the copies you
  already knew about (go-to-k/cdkd#2176: grepping `maskDeep` found four
  copies and shipped "four" everywhere; there were SIX, two spelled
  `maskLeaf*`). Grep a structural line the copies must share; confirm by name
  second.
- **Count the population BEFORE you fix, assert the count afterwards** —
  re-deriving from the post-fix tree cannot detect a copy the sweep never saw.
  A fix that REMOVES a behaviour owes a SECOND population: the assertions
  that the behaviour happens, which do not go red when it stops
  (`references/verify.md` §8-d).
- **A sweep's number is unearned until you paste the command that produced
  it, and re-run that command before you ship** — one claimed "88 hits across
  13 files" and the reviewer's grep returned 47. A count RELAYED from a
  subagent is the same failure without even a command (FOUR published in one
  run, every one wrong — "nine sites", grep found 78), and the tell is
  grammatical: a number arriving as a WORD was counted by an agent, one
  arriving as OUTPUT by a machine. Run the query
  yourself, put its output in the text, and give the number one of
  `references/verify.md` §8-g's three dispositions before it ships.
- **Grep the repo for the SYMPTOM before deriving a fix** — something may
  already have solved the same QUESTION (the SDK region-redirect mechanism a
  lane spent a real-AWS round trip rediscovering already sat verbatim in
  `src/utils/aws-region-resolver.ts`).
- **Grep the ISSUE NUMBER — a third sweep with a different key.** Closing an
  issue falsifies every comment that CITES it, and the dangerous ones are
  deliberate NON-assertions carrying neither shape nor symptom
  (`git grep -n "<issue number>" -- src tests docs .claude`). Measured on
  go-to-k/cdkd#2466 closing go-to-k/cdkd#2421: four live citations, including
  a "deliberately NOT asserted" bullet in a fixture that already synthesized —
  adding the assertion cost nothing and found a SECOND failure mode. Such a
  non-assertion is usually the cheapest high-value test in the change.

**A defect the sweep turns up that this lane is NOT fixing gets FILED — rules
in `references/filing.md` (§5-f)**: N sites of one root cause is ONE issue,
the dup-check window, the `Severity` / `Effort` labels. Read it at the moment
the sweep produces something this lane will not close.

### 5-c. The fix itself

Do the fix in the lane's tree (match the existing pattern; ESM relative
imports need the `.js` extension even in TypeScript). Rebuild with
`vp run build` after every source change — the CLI runs from `dist/`. **Always
add a unit test that fails without the fix and passes with it** (under
`tests/unit/**`, AWS SDK mocked via `vi.mock()`). **Check whether the artifact
already has a test harness** — `.claude/hooks/` carries per-hook `*.test.sh`
suites run by `run-tests.sh`, not visible from `tests/unit/**`.

- **Run such a harness from BESIDE its subject, never from a scratch copy** —
  every suite resolves the hook under test from its own script path, so a
  copy fails everything with exit 127. For a before/after comparison, write
  the old copy beside the real one as `.claude/hooks/_old-<name>.test.sh` and
  delete it after. §8's scratch-copy idiom is right for a data file, wrong
  for a runnable harness, and wrong for a WORKTREE in a way that WRITES to
  the live tree (§8 carries the mechanism).
- **When the issue reports a stale ENTRY in an enumerated list, audit the
  whole list in BOTH directions** — every entry still resolves AND everything
  that belongs is present; the second half is the one skipped
  (go-to-k/cdkd#1972: the issue named one dead path; the audit found a second
  plus four live surfaces never added). Then make the recurrence mechanical:
  a list that must stay in sync with the repo is a test, not a sentence.
- **Adding a HANDLER to a slot that already has one REPLACES it.** Bash
  `trap` does not chain: a second `trap ... EXIT` silently disarms the first,
  which in an integ fixture is the AWS teardown (a reviewer-nit fix would
  have traded a leaked temp file for live AWS resources on every failure
  path). Put the work inside the EXISTING handler or re-install one that
  CALLS the original. Fenced by
  `tests/unit/scripts/integ-single-exit-trap.test.ts`. Generalize: before
  adding to any single-slot registration, count what is already there.

### 5-d. Measurement audits

**When the audit is a MEASUREMENT, the shape of the sample is the finding — a
clean result from the wrong shape is indistinguishable from a clean subject.**
Auditing go-to-k/cdkd#2096 produced SIX confident wrong answers, each from a
plausible sampling shape, each hiding a real secret: newest-N (the newest
versions come from the run most likely already fixed — sample across the
range); one global needle (each fixture spells its own literal — derive the
needle per subject or assert a needle-independent observable); a name derived
from convention (read the identifier from the subject's own `STACK=` line); a
silent parse failure inside a pipe (a parse that can fail must report
failing, not fall through to a count); a per-page aggregate (`--query
'length(...)'` applies PER PAGE — count rows of a projection); and grepping
the layer the subject does not use (a type registered to NO provider takes
the Cloud Control readback, invisible in `src/provisioning/providers/**`).
The through-line: every one FAILED CLEAN. Run the shape against a case you
KNOW is dirty first; only then trust a zero.

### 5-e. Mutation probes

**COMMIT the round's real fixes BEFORE running any mutation probe** — a probe
deliberately breaks the tree, and an interruption mid-probe leaves breakage
and unfinished fixes in one undifferentiated dirty tree (a lane died at the
session limit with 9 dirty files; go-to-k/cdkd#2416). With a pre-probe commit
the separator is just `git diff`.

**Restore a probe from a BYTE-EXACT COPY, never an inverse string replace**
(`cp` before, `cp` back after, proved by `git diff -- <file>` printing
nothing). An inverse replace is a second edit; Python's `str.replace('', x)`
matches between every character and rewrote an 11 KB file to 838 KB, scoring
the three probes AFTER it against a corrupted subject.

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
fence: (1) **did the edit land?** (`sed`/`perl` fail silently in ways that
read as "no match"; prove with `grep -c '<anchor>'` and require exactly 1);
(2) **does the case's execution path REACH the edited line?** (the fix is a
case that must take that path, not a fence change); (3) **did the command run
where you think it did?** (appendix, "Bash cwd silent reset" — absolute paths,
and a property the wrong tree cannot fake). Plus one fixture shape: **an
expected value must be an INDEPENDENT variable from the one under test.** Only
after all four does "the fence is weak" remain.

**A RED probe is void as easily as a green one** — an anchor matching TWICE
mutates every copy (the red belongs to a broader change), and an edit that
does not COMPILE fails the suite at LOAD, indistinguishable from
discrimination. Read the TALLY and failure TEXT, never the rc — it lies in
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

**Choose the probe's INPUT to discriminate too** — a mask-before-stringify
fix probed with a SCALAR secret came back green under its own motivating
mutation; only a JSON-document secret makes the needle stop occurring. Ask
what property of the INPUT the defect depends on.

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

- **Write the defect in the spelling a PERSON would write**, not the easiest
  to inject (a fence split on quote characters caught its own probe and
  missed the spelling anybody would type — go-to-k/cdkd#2052).
- **Write the defect in every spelling the language allows** (a scanner
  matched `||` only while the tree used `??` at four sites; widening it
  surfaced a real unfiled bug — go-to-k/cdkd#2111).
- **Delete the thing the fence REQUIRES and watch it fail.** An OR of
  whole-file substrings is satisfied by any one; a population derived from
  the DEFECT itself drops the subject out instead of failing (a gate-parity
  test selecting gates by their own condition stayed green with two gates
  disarmed). A population derived from an OPTIONAL language feature (a type
  annotation, an explicit return type, `implements`) is derivable-around for
  free — derive from a relation the write CANNOT omit, and ask: what would
  this look like if the author did not write the optional part?
- **Probe the fence with the evasions the DEFECT would use**, not the one you
  just fixed — the removed line is the one spelling you have proved you can
  see (a fence caught its own removed line and missed computed members,
  `Object.assign`, an object literal and a spread rebuild).
- **Watch the FLOOR for the same collapse** — a floor naming only the file
  the defect lives in is satisfied BY the collapse; a floor computed from the
  pool it guards is unfalsifiable (emptying the pool left it green). Write
  the expected count as a LITERAL from a source the fence does not read.
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

**When a fence must read another tool's CONFIG, parse it with a real parser
and fail CLOSED on anything unmodelled — never hand-roll a scanner, never
patch one per spelling.** Measured across three sibling fences over
`.markgate.yml` (go-to-k/cdkd#2383, go-to-k/cdk-real-drift#1838,
go-to-k/cdk-local#631): the unused key (`exclude` — read the tool's OWN
schema from the pinned binary, not its `init` template); then the spelling
treadmill — four spellings across four rounds (flow lists, quoted keys, a
two-space comment ending a block scan, the YAML merge key splicing an
`exclude` from a sibling gate), each patch moving the hole. **Three spellings
in three rounds is the signal to change instrument**: parse for real
(`yaml`'s `parse(text, { merge: true })`), allow-list the tool's own keys,
fail closed outside them — or REFUSE the construct rather than model it
(refusal is the stricter option: an unmodelled shape stops the fence instead
of passing through). And a probe establishing any of this must move ONE
variable (an early draft's published probe had re-`set` the marker in
between, making its headline sentence false).

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

### 5-g. Fan-out mechanics

You may fan out **one subagent per lane** (disjoint files): give each its
worktree path, allowed files, and "do NOT touch other lanes' files; STOP and
report if the fix needs a forbidden one". A subagent's Bash **bypasses the
PreToolUse gate hooks** (it can `gh pr create` past `verify-pr-gate`) —
enforce quality yourself; the orchestrator still gates the MERGE.

- **Forbid lane agents the FULL SUITE; run it yourself, serially.** Five
  concurrent full suites drove load to 195 and all three lanes were killed by
  the 600s watchdog with timeouts in files no diff touched; serialized, the
  same trees were green. Each agent runs only `vp test run <its own suite>`.
- **A PEER SESSION's suite is invisible to every probe here** — a full suite
  exited 1 with all tests passing (`Worker exited unexpectedly`, load 54, the
  heaviest vitest belonging to another session's worktree). Before treating a
  suite failure as a regression, read the rc AND the error section AND
  `uptime`, and check `ps` for a vitest whose path is not yours; re-run when
  the machine is quiet.
- Budget two fan-out costs: a lane agent waiting inside a tool call is killed
  at 600s of silence (background long runs with a log redirect, poll with
  short `tail`s), and a fix round re-touching an `integ-*` scope invalidates
  that gate's marker — that is the gate working; budget the run.

**Guardrails every lane prompt must carry** (each learned the hard way):

- **Never force-push over a commit you did not author** — re-`git fetch` and
  inspect the branch first; STOP if it carries work you did not write.
- **A new fixture literal must not collide with an existing assertion needle,
  nor a new fixture RESOURCE with an existing resource's VALUE** (a
  hard-coded URL user equal to the swept needle produced a false LEAK report
  — worse than a missing assertion; an arm reusing a plaintext an existing
  assertion owned failed on an assertion the lane never wrote,
  go-to-k/cdkd#2270). When an arm makes two things equal, ask what ELSE holds
  that value; scope the sharing. **And check the arm's shape actually
  exercises the fix before spending a run** (two separate resources was
  vacuous there — only one resource holding both leaves let the mechanism
  under test decide the answer).
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
  test set `AWS_REGION` to the value where correct code and mutation bind
  identically. When a probe comes back green, suspect the fixture first — and
  especially an expected value COINCIDING with the ambient default
  (assertions pinned to `'us-east-1'`, at once the fixture region and the
  repo's fallback, left 434 tests green under substitution). Choose a value
  the default can never produce.
