# Step 8 — Code review

Read at step 8 of `/verify-pr`, after CI is green and before the live-test.

## Dispatch

- **First, run `/review-pr <N>`** for the size-appropriate plan, plus the
  ADDITIVE `pr-security-reviewer` at ANY tier when a security surface or fix is
  involved. Thresholds are NOT restated here — `pr-review-gate.sh` computes the
  tier that gates the merge; a copy can only drift from it. Trust the
  recommendation; override only with a concrete reason, noted here.
- Synthesize the reports into a verdict; any blocker → fix-back loop.

## Re-review every fix round

**Re-review the FIX DELTA, not just re-run the tier heuristic.** Fixes are code
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
