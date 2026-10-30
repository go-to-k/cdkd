<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 5. One tree per lane, then implement

Stages 5–8 run in a lane agent per issue; real-AWS integ and merge (§9)
stay with the parent, so a lane stops at merge-ready.

### 5-a. The tree

Never edit in the main checkout — it is shared across parallel agents. Per
lane:

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
# The FIRST line is the anchor: every probe under it describes THIS shell's
# tree, so a silently reset cwd (gotchas.md) shows up IN THE OUTPUT.
git rev-parse --show-toplevel   # STOP unless you meant to adopt this tree
git status --porcelain          # non-empty: someone's uncommitted work
git branch --show-current
git log --oneline -3
cat "$(git rev-parse --git-dir)/session-owner" 2>/dev/null   # owner sentinel
```

Also read the issue thread for a claim naming this branch (the cross-clone
signal); a live lane's tree gets instructions, not edits.

**Take a fresh branch here — ALWAYS, and WITHOUT leaving the tree.** The branch
this tree arrived on is the OUTER TOOL's: committing onto it would DELETE that
branch, and §9 puts it back untouched (`references/launch-mode.md`).

```bash
git status --porcelain   # must be empty FIRST -- `git switch` carries
                         # uncommitted changes ACROSS onto your lane branch
git fetch origin && git switch -c <branch> origin/main   # unchained, a failed
                         # fetch still branches off a stale origin/main
```

**A STACKED lane** (needing an unmerged lane's branch) branches off that branch;
its claim names the base branch and sha. No PR until the base merges, then
`git rebase --onto origin/main <recorded base sha>`: the squash-merge rewrote
the base, and a plain rebase replays it.

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
  `verify.sh` greps pin wording the unit suite cannot see (go-to-k/cdkd#3706).
  A change that REFUSES what it used to accept (warn → refuse) also greps the
  property through `tests/integration/*/{lib,verify.sh}` before claiming "no
  fixture impact": fixtures deploy malformed values ON PURPOSE (go-to-k/cdkd#3780).
- **Count the population BEFORE the fix, assert it afterwards.** A fix REMOVING
  a behaviour owes a second count: the assertions that it happens, which stay green when it stops (§8-d).
  A masking fix's population is every SINK the value reaches, each `warn` that
  names the error CLASS included (a test puts the secret IN the class), and the
  lane prompt NAMES each one: "warn cases" alone missed it 4x (#5248, #5267,
  #5268, #5270).
- A defect this lane is NOT fixing gets FILED (`filing.md`, §5-f).

### 5-c. The fix itself

Fix in the lane's tree, matching the existing pattern; AGENTS.md owns the
mechanics. Make the unit test **fail without the fix and pass with it**. A
hook's harness is `.claude/hooks/<name>.test.sh`, run by `run-tests.sh` from
BESIDE its subject.

**Adding a HANDLER to a single slot REPLACES it** — a second `trap ... EXIT`
disarms the first, which in an integ fixture is the AWS teardown. Work inside
it, or re-install one calling the original
(`tests/unit/scripts/integ-single-exit-trap.test.ts`).

### 5-d. Measurement audits

**When the audit is a MEASUREMENT, the sample's shape is the finding** — run it
against a case you KNOW is dirty before trusting a zero. Watch for newest-N
instead of the RANGE, a global needle where each subject spells its own, and
`--query 'length(...)'`, which aggregates per PAGE.

### 5-e. Mutation probes

- **COMMIT the round's real fixes BEFORE any probe**: a probe restore reverts
  anything committed nowhere. Afterwards `git diff` is the separator, and the
  probe restores from a BYTE-EXACT COPY (`cp` out, `cp` back).
- **A probe proves discrimination only if it changes the value the test READS**:
  name the discriminator (which client, which region) and assert THAT.
  `.claude/rules/testing.md` → "Mutation probes" owns the rest.
- **NO discrimination is a claim about the FENCE — check three things first.**
  The edit landed in the PRODUCTION file (`grep -c` before, `git diff` after;
  `perl -0pi` without `/g` hits only the first match); a case REACHES the line
  by EVERY arm, degenerate ones too (empty map, shape divergence; #5049),
  licensing a case per arm, never a fence change nor DELETING a guard as
  "implied"; and the command ran where you think (gotchas.md). Read the TALLY.

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
  intended classes, with a floor per class (go-to-k/cdkd#2001).

### 5-g. Fan-out mechanics

You may fan out **one subagent per lane** (disjoint files): give each its
tree, allowed files, "do NOT touch other lanes' files; STOP and report
if the fix needs a forbidden one or meets a design branch (options plus what
CFn does, never a lenient pick of its own; #5107, #5109)", and **the REPORT
SHAPE — the FINAL report IS the deliverable**, since a lane's tool output
never reaches you. **Name the parent's `SendMessage` address, `main`** (a guessed one fails), and say a
mid-task report ends NOTHING: the lane goes on to its next step unless the
parent SAYS stop.
Never wait on a quiet lane: list the agents and resume any already `completed`
with "REPORT ONLY". A subagent's Bash bypasses the PreToolUse hooks.

**Guardrails every lane prompt must carry:**

- **Name the §5-8 stage files and `/check` minus step 4, never your own
  command list** — fix rounds too: one dropped `gen:all-matrices`, another
  `typecheck:test` (#4561). **Forbid step 4, the FULL SUITE; run it yourself,
  serially** — concurrent suites trip the 600s watchdog in untouched files.
  Each runs `vp test run <its own suite>`, its files spelled out or inside
  `bash -c`: zsh passes an unquoted `$files` as ONE argument.
- A lane is killed at 600s of silence inside a tool call: background long runs
  via `run_in_background` with a log redirect and wake on ITS exit — never a
  per-line watcher (`tail -F`, a line-emitting `Monitor`).
  A turn ended with nothing in the background is final; a MERGE-READY one
  leaves nothing there, CI watchers included: the parent's integ takes that
  tree next (#5109, #5114).
- Never force-push over a commit you did not author: `git fetch`, inspect, and
  STOP on work that is not yours.
- **A reviewer's mutation probe never touches the lane tree** — one overwrote a
  lane's uncommitted edits, another failed two full-suite runs (2026-10-30).
  Commit the lane before dispatching any and name the sha in each prompt: it
  probes an extract in its own scratch dir (`.claude/agents/pr-code-reviewer.md`
  holds the recipe). Leave the tree alone until the round ends: a dirty tree in
  a reviewer's END `git status --porcelain` line stops it.
- Give each agent a unique scratch dir IN ITS PROMPT, one per AGENT, the
  parent's reviewers too (`$SCRATCHPAD/lane<issue><slice>-<role>/`): same-named
  files overwrite (a reviewer's `git archive` clobbered a peer's probe tree, #5268).
  A lane's OWN files take the issue number too (`pr<issue>-body.md`,
  `lane<issue>-suite.log`): sibling lanes share one session scratchpad, and
  three lost a `pr-body.md` / `suite3.log` to it (2026-10-30).
