<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 5. One tree per lane, then implement

Stages 5–8 run in a lane agent per issue; real-AWS integ and merge (§9)
stay with the parent, so a lane stops at its push.

### 5-a. The tree

Never edit in the main checkout (shared by parallel agents). Per lane:

```bash
# MAIN-CHECKOUT only; an IN-PLACE lane in the launch tree skips these two lines,
# a CONCURRENT one runs launch-mode.md row 1's absolute-path form instead.
git worktree add .claude/worktrees/<branch> -b <branch> origin/main
cd .claude/worktrees/<branch>
mise trust && mise install   # untrusted .mise.toml: vp will not resolve
vp install                   # worktrees have no node_modules
vp run build                 # ...and no dist/ for CLI-spawning tests
```

**IN-PLACE: confirm the tree is YOURS before adopting it** — a signal shows
LIFE, never absence: "someone is here" means STOP.

```bash
# The FIRST line anchors: a silently reset cwd (gotchas.md) shows IN THE OUTPUT.
git rev-parse --show-toplevel   # STOP unless you meant to adopt this tree
git status --porcelain          # non-empty: someone's uncommitted work
git branch --show-current
git log --oneline -3
cat "$(git rev-parse --git-dir)/session-owner" 2>/dev/null   # owner sentinel
```

Also read the issue thread for a claim naming this branch; a live lane's
tree gets instructions, not edits.

**Take a fresh branch here — ALWAYS, and WITHOUT leaving the tree.** The branch
this tree arrived on is the OUTER TOOL's: committing onto it would DELETE that
branch, and §9 puts it back untouched (`references/launch-mode.md`).

```bash
git status --porcelain   # empty FIRST: `git switch` carries changes over
git fetch origin && git switch -c <branch> origin/main   # unchained, a failed
                         # fetch still branches off a stale origin/main
```

**A STACKED lane** (needing an unmerged lane's branch) branches off that branch;
its claim names the base branch and sha. No PR until the base merges, then
`git rebase --onto origin/main <recorded base sha>`: the squash-merge rewrote
the base, and a plain rebase replays it. Take that sha from the claim (the
merged base branch is auto-deleted, so `origin/<base>` is gone) and assert it
first: `[ -n "$OLD" ] && git merge-base --is-ancestor "$OLD" HEAD` — an empty
`$OLD` drops every commit of the branch.

### 5-b. Sweep the class, not the instance

**Ask whether the defect has SIBLING SITES; sweep them in THIS lane.**

```bash
# Query the PRECONDITION minus the REMEDY: a grep for a MISSING thing returns
# only the sites that already have it.
grep -rln "validateDesiredProperties" src/provisioning/providers/   # WRONG
for f in $(grep -rln "implements ResourceProvider" src/provisioning/providers/); do
  grep -q "validateDesiredProperties" "$f" || echo "NO VALIDATION: $f"
done                                                               # RIGHT
```

- A fix round owes the same sweep, over the CODE not the diff's files:
  `grep -rn "<field / helper / message changed>" src/ tests/integration/` —
  `verify.sh` greps pin wording the unit suite cannot see (#3706).
  A change that REFUSES what it used to accept (warn → refuse) also greps the
  property through `tests/integration/*/{lib,verify.sh}` before claiming "no
  fixture impact": fixtures deploy malformed values ON PURPOSE (#3780).
- **Count the population BEFORE the fix, assert it afterwards** — a checker's
  UNGATED class (`unresolved`) included, asserted by the END STATE, not its
  verdict (#6928: helper-set mock defaults passed it, failed under
  `mockReset: true`). A fix REMOVING
  a behaviour owes a second count: the assertions that it happens, which stay green when it stops (§8-d).
  A masking fix's population is every SINK the value reaches, each `warn` that
  names the error CLASS included (a test puts the secret IN the class), and the
  lane prompt NAMES each one (#5248).
- **A RECURRENCE closes the CLASS, not a second instance** — the issue names
  `recurrence of #N`, or `gh issue list --state all --search '<root-cause
  concept>'` finds a closed one (`filing.md`). Both instances share a mechanism
  (e.g. a match by VALUE that ignores where the value came from), so a fix
  keyed on this instance's shape leaves the third open. The PR owes three
  things, named in its body:
  1. **The mechanism changed**, so the class cannot occur: decide on the
     property that separates the cases (provenance, not value), not on a
     list of known bad inputs.
  2. **Both comparison sides normalized** wherever an artifact of the
     mechanism could still surface (a diff, a drift compare, a preflight),
     through ONE shared helper.
  3. **A generated invariant test over the class's input space**, in its own
     file, never the two known instances alone: e.g. short secret values ×
     literal positions → scrub, then diff, assert `NO_CHANGE` and no
     plaintext. Break the mechanism and it must fail on cases neither
     instance covered.

  The parent's review brief asks "can a THIRD instance land?" (`verify.md`
  §8-i).
- A defect this lane is NOT fixing gets FILED (`filing.md`, §5-f) — a PR-body
  "residual" or "not acted on" note is not filing: once merged it is never
  read again (#6871).

### 5-c. The fix itself

Fix in the lane's tree, matching the existing pattern; AGENTS.md owns the
mechanics. Make the unit test **fail without the fix and pass with it**. A
hook's harness is `.claude/hooks/<name>.test.sh`, run by `run-tests.sh` from
BESIDE its subject. A src file near `src-file-size-cap.test.ts`'s 1000
lines gets a sibling module BEFORE you grow it (#6108, #6255).

**A fix to a value cdkd CAPTURES into state** (a drift baseline, a recorded
attribute) also heals, or compares around, the records written before it, in
the SAME issue: old state keeps the bad value, and a no-change deploy re-reads
nothing (#5737 needed #5749).

**A second `trap ... EXIT` REPLACES the first** (in a fixture, the AWS
teardown): work inside it, or re-install one calling the original
(`tests/unit/scripts/integ-single-exit-trap.test.ts`).

### 5-d. Measurement audits

**When the audit is a MEASUREMENT, the sample's shape is the finding** — run it
on a KNOWN-dirty case before trusting a zero; deploy each type CDK-DEFAULT, no
optional names (#6676: a named DataSync task hid `Name: ""`). Watch for newest-N
not the RANGE, one global needle where each subject spells its own, and
`--query 'length(...)'` (per PAGE).

### 5-e. Mutation probes

A lane LISTS sites as a TSV (file:line, the break, the test that must fail);
the probe lane or the parent breaks them.

- **COMMIT the round's real fixes BEFORE any probe**: a probe restore reverts
  anything committed nowhere. Afterwards `git diff` is the separator, and the
  probe restores from a BYTE-EXACT COPY (`cp` out, `cp` back).
- **A probe proves discrimination only if it changes the value the test READS**:
  name the discriminator (which client, which region) and assert THAT.
  `.claude/rules/testing.md` → "Mutation probes" owns the rest.
- **NO discrimination is a claim about the FENCE — check three things first.**
  The edit landed in the PRODUCTION file (`grep -c` before, `git diff` after —
  `cmp` against the byte copy for a file still UNTRACKED, where `git diff` is
  always empty (#6505); `perl -0pi` without `/g` hits only the first match); a
  case REACHES the line by EVERY arm, degenerate ones too (empty map, shape
  divergence; #5049), licensing a case per arm, never a fence change nor
  DELETING a guard as "implied"; and the command ran where you think
  (gotchas.md). Read the TALLY.

### 5-f'. Scanner/fence calibration (when the fix ships a repo-wide check)

**Calibrate against the PRE-FIX tree, not the issue's wording** — run the
candidate over the still-broken tree, read every hit, tighten until all are
genuine. Then probe the real tree, spelling the injected defect the way its
SOURCE would. A fence reading another tool's CONFIG parses it with a real
parser and fails CLOSED on anything unmodelled.

- **Delete what the fence REQUIRES and watch it fail.** A population or floor
  derived from the DEFECT itself, from an OPTIONAL language feature, or from
  the pool it guards drops the subject out instead of failing: derive from a
  relation the write CANNOT omit, and take a count as a LITERAL the fence does
  not read.
- **A CLASSIFIER change cannot be fenced by hand-picked cases** — walk an
  enumerated input space against a transcription of the old implementation
  (`git show origin/main:<path>`), failing on any difference outside the
  intended classes, with a floor per class (#2001).

### 5-g. Fan-out mechanics

You may fan out **one subagent per lane** (disjoint files): give each its
tree, allowed files, "do NOT touch other lanes' files; STOP and report
if the fix needs a forbidden one or meets a design branch (options plus what
CFn does, never a lenient pick of its own; #5109)", any premise you
did not measure as a hypothesis for it to measure, never as fact (#5664) — an
AWS precondition (call ORDER, a value AWS may refuse) too: probe it on ONE
throwaway resource before a mock or fixture arm encodes it, and SHIP the probed
literals verbatim — a probe proves only the values it SENT (#5830), so a pattern
ANCHORS on AWS's documented constraint or ≥2 samples, `+` where no length is
documented (#6512); and a fixture passing `--recreate-via-cc-api` a
`STATEFUL_TYPES` type adds `--force-stateful-recreation` (#6512), and **the REPORT
SHAPE — the FINAL report IS the deliverable**, since a lane's tool output
never reaches you. **Name the parent's `SendMessage` address, `main`**, and say a
mid-task report ends NOTHING: the lane goes on unless the parent SAYS stop.
Never wait on a quiet lane: list the agents; send "REPORT ONLY" to any
`completed`, or running with a frozen tool count and its PR green (#5593); ask
any lane silent past 30 min what is pending plus an ETA, saying "reply, then
continue — this is not a handback" (#6282), and relay that to the user
unasked. Read a completion when it arrives, and check the PR and tree before believing it —
a per-item table's counts and verdicts come from its ROWS, never its headline
(#6628); a
completion still waiting on a reply you already sent crossed it: resend the
reply (#6512).
A subagent's Bash bypasses the PreToolUse hooks.

**Guardrails every lane prompt must carry:**

- **Name the §5-8 stage files and `/check` minus step 4, never your own
  command list** — fix rounds too (#4561). **Forbid step 4, the FULL SUITE (a
  bare `tests` / `tests/unit` directory included), to the lane AND to every
  reviewer it dispatches — the lane copies the ban verbatim into each reviewer
  prompt; run it yourself, serially, and start ANY vitest of yours only while
  no lane's is running** — concurrent suites trip the 600s watchdog (#6871).
  Remote `rx --vitest` runs the FULL suite (capped) whatever files follow:
  named files go `rx -- vp test run <files>` (#6928). **ONE rx per lane at a
  time**: stop the previous sha's run before starting the next. rx FALLS BACK
  to this Mac when a VM sends no report, so grep its log for `running this
  shard locally`; on a hit, stop it, because it is the forbidden local suite.
  The #7006 lane's 3-4 overlapping runs fell back and ran 32 min locally.
  **Stop a hung test by its process GROUP**, then check
  `ps -eo pid,ppid,command | grep vitest` for PPID-1 workers in the lane's
  tree. #7006's hung `sdk-wire-coverage-19` left an orphan worker spinning
  at 75% CPU.
  Each runs `vp test run <its own suite>`, its files spelled out or inside
  `bash -c`: zsh passes an unquoted `$files` as ONE argument. In any shell an
  EMPTY list (a `$(ls <glob>)` matching nothing) runs the FULL suite: guard it.
- A lane is killed at 600s of silence inside a tool call: background long runs
  via `run_in_background` with a log redirect and wake on ITS exit — never a
  per-line watcher (`tail -F`, a line-emitting `Monitor`).
  A turn ended with nothing in the background is final, so a lane's last
  message is its push or a blocker, never "waiting", and leaves nothing
  there, CI watchers included: the parent's integ takes that tree (#5114).
- **Every ad hoc `aws` call, a throwaway probe included, carries
  `AWS_CLI_AUTO_PROMPT=off AWS_PAGER=`**: the profile's auto-prompt hangs on a
  rejected command, and `/run-integ` sets them on `verify.sh` alone. Make
  no account-level change, nor an out-of-stack one beyond the lane's own
  throwaway probe, not even as a CLEANUP workaround: if one seems needed, STOP
  and report (#6628: a lane registered a Notifications hub to unwedge a delete).
- Never force-push over a commit you did not author: `git fetch`, inspect, and
  STOP on work that is not yours.
- **A reviewer's mutation probe never touches the lane tree**.
  Commit the lane before dispatching any and name the sha in each prompt: it
  probes an extract in its own scratch dir (`.claude/agents/pr-code-reviewer.md`
  holds the recipe). Leave the tree alone until the round ends: a dirty tree in
  a reviewer's END `git status --porcelain` line stops it.
- Give each agent a unique scratch dir IN ITS PROMPT, one per AGENT, the
  parent's reviewers too (`$SCRATCHPAD/lane<issue><slice>-<role>/`): same-named
  files overwrite (#5268).
  A lane's OWN files take the issue number too (`pr<issue>-body.md`,
  `lane<issue>-suite.log`): sibling lanes share one session scratchpad.
