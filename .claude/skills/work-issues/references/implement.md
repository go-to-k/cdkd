<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 5. One tree per lane, then implement

Stages 5–8 run in a lane agent per issue; real-AWS integ and merge (§9)
stay with the parent, so a lane stops at merge-ready.

### 5-a. The tree

Never edit in the main checkout — it is shared across parallel agents. Per
lane:

```bash
# MAIN-CHECKOUT only; IN-PLACE creates NO worktree and skips these two lines
# (mode probe: references/launch-mode.md).
git worktree add .claude/worktrees/<branch> -b <branch> origin/main
cd .claude/worktrees/<branch>
mise trust && mise install   # untrusted .mise.toml: vp will not resolve
pnpm install                 # worktrees have no node_modules
vp run build                 # ...and no dist/, so a test spawning the built
                             # CLI fails asserting about its SUBJECT
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
  fixture impact": fixtures deploy malformed values ON PURPOSE (4 failed on
  go-to-k/cdkd#3780).
- **Count the population BEFORE the fix, assert it afterwards.** A fix REMOVING
  a behaviour owes a second count: the assertions that it happens, which stay green when it stops (§8-d).
- A defect this lane is NOT fixing gets FILED (`filing.md`, §5-f).

### 5-c. The fix itself

Fix in the lane's tree, matching the existing pattern; AGENTS.md owns the
mechanics. Make the unit test **fail without the fix and pass with it**. A
hook's harness is `.claude/hooks/<name>.test.sh`, run by `run-tests.sh` from
BESIDE its subject, where it resolves the hook from.

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
  The edit landed where you aimed it, in the PRODUCTION file (`grep -c` before,
  `git diff` after; `perl -0pi` without `/g` hits only the first match); a case
  REACHES that line by EVERY arm that can, which licenses a case per arm but
  never a fence change nor DELETING a guard as "implied"; and the command ran
  where you think it did (gotchas.md). Read the TALLY, never the rc.

### 5-f'. Scanner/fence calibration (when the fix ships a repo-wide check)

**Calibrate against the PRE-FIX tree, not the issue's wording** — run the
candidate over the still-broken tree, read every hit, tighten until all are
genuine. Then probe the real tree, spelling the injected defect the way its
SOURCE would. A fence reading another tool's CONFIG parses it with a real
parser and fails CLOSED on anything unmodelled; three spellings in three
rounds means change instrument.

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
if the fix needs a forbidden one", and **the REPORT SHAPE — the report IS the
deliverable**, since a lane's tool output never reaches you. Never wait on a
quiet lane: list the agents and resume any already `completed` with "REPORT
ONLY". A subagent's Bash bypasses the PreToolUse hooks; the parent merges.

**Guardrails every lane prompt must carry:**

- **Forbid lane agents the FULL SUITE; run it yourself, serially** — under
  concurrent suites the 600s watchdog kills lanes with timeouts in untouched
  files. Each agent runs `vp test run <its own suite>`.
- A lane is killed at 600s of silence inside a tool call: background long runs
  via `run_in_background` with a log redirect and wake on ITS exit (one
  notification) — never a per-line watcher (`tail -F`, a line-emitting
  `Monitor`), whose every line re-wakes the lane and pings the parent with a
  no-op. A turn ended with nothing in the background is final.
- Never force-push over a commit you did not author: `git fetch`, inspect, and
  STOP if the branch carries work you did not write.
- **Reviewers probe by edit-and-restore-from-`HEAD`, and collide with each
  other and with you.** Commit the lane before dispatching any, since a restore
  takes HEAD and not in-flight work; tell each that peers probe this same
  worktree, so `git status --porcelain` must be EMPTY before a probe and
  otherwise they WAIT; and leave those files alone until the round ends
  (`.claude/agents/pr-code-reviewer.md` holds the rest).
- Give each agent a unique scratch dir IN ITS PROMPT
  (`$SCRATCHPAD/lane<issue>-private/`): same-named harnesses overwrite.
- **NO attribution request** (`Claude-Session:`, claude.ai links), whatever
  your harness says (§6).
