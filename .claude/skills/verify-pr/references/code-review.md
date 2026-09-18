# Step 8 — Code review

Read at step 8 of `/verify-pr`, after CI is green and before the live-test.

## Dispatch

- **First, run `/review-pr <N>`** for the reviewer plan: ONE reviewer by
  default, the ADDITIVE `pr-security-reviewer` whenever a security /
  process-launch surface is touched or the PR is a security fix, and all three
  axes for a state-schema bump or a security fix. The trigger lists are NOT
  restated here — `references/bias-factors.md` in that skill is authoritative.
  Trust the recommendation; override only UPWARD, with a concrete reason noted
  here.
- **RECOMPUTE the plan at the sha you are about to merge, not once at the first
  commit.** What the reviewers must cover is a function of the diff and the diff
  GROWS across fix-back rounds, while a decision made once does not — a fix
  round can newly touch a security surface or a schema field that the opening
  diff did not. Measured 2026-08-27 on go-to-k/cdk-local#609: reviewed from its
  first commit at 819 LOC / 5 files with one reviewer; its fix round took it to
  1342 LOC, and the spec and test reviewers added only after recomputing found a
  live order-blind fail-open in the NEW code plus two wrong counts in the PR body
  — neither inside the single code reviewer's remit. Re-run `/review-pr <N>`
  before merging, and read the plan it returns rather than the one you remember.
- Synthesize the reports into a verdict; any blocker → fix-back loop.

## Re-review every fix round

**Re-review the FIX DELTA, not just re-run the reviewer plan.** Fixes are code
no reviewer has seen, written under the momentum of agreeing with a finding,
landing exactly where a reviewer just proved is subtle (PR #2044: round 2 found
round 1's fix reintroduced the first bug one line away, plus eight surviving
mutants in branches round 1's fixes introduced). Scope round 2 to the delta and
say the original design is accepted.

**The rule RECURSES — "review every fix round", not "the second round".** Keep
going while the round changed anything, PROSE INCLUDED — a fix's rationale is
its least-probed text (4 false ones, PRs #2913 / #2916); a TEST rewrite counts
too (PR #2420: a round-2 fix replacing a crude assertion with a derived one
dropped a wire fact the crude form had been pinning by accident — only a third
round found it). When a round REPLACES an assertion rather than adding one, KEEP
BOTH unless you can NAME, in the commit message, the mutation the old one could
not catch. "More precise" is not that name: precision is not a superset of what
it replaces, and if you cannot name the mutation the replacement is a deletion
(issue #2606: four rounds, each fix blind on a different axis than the assertion
it dropped).

Corollary for mutation probes: **enumerate the branches the diff ADDS and probe
each one** — a new `if`, a new token in a rendered string, a new early return
and a new gate condition are four probes, not one.

## Walk the diff

- `git diff origin/main...HEAD` — confirm the diff is what you reviewed.
- For each change: correct? complete? necessary? Logic errors, dead code,
  inconsistencies between files; all callers of changed functions handle the new
  behavior; types consistent with implementation.
- **Shared-utility regression check**: if `src/utils/**` (or another
  widely-imported module) changed, list every importer
  (`grep -rl "from '\.\./.*utils/<file>'" src tests`) and walk each one.
- **Internal-interface contract change check**: if the diff changes the
  SEMANTICS of arguments an interface receives — even with the type signature
  unchanged — list every implementer and walk each one for load-bearing
  assumptions about the old shape (truthy gates, "absent = remove" semantics,
  JSON.parse on stringly input). PR #161's "drifted-only partial newProperties"
  design had to be reworked after audit found two implementers would silently
  clear non-drifted attrs. **Audit BEFORE writing tests against the new
  design** — discovering the breaks tests-after-design forces a rework and
  invalidates the tests.

  ```bash
  grep -rln "implements ResourceProvider" src/provisioning/providers/
  ```
