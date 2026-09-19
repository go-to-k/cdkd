# Step 8 — Code review

Read at step 8 of `/verify-pr`, after CI is green and before the live-test.

## Dispatch

- **Run `/review-pr <N>`** for the reviewer plan: ONE reviewer by default, the
  ADDITIVE `pr-security-reviewer` whenever a security / process-launch surface is
  touched or the PR is a security fix, and all three axes for a state-schema bump
  or a security fix. The trigger lists live in that skill's
  `references/bias-factors.md` and are not restated here. Override the
  recommendation only UPWARD, with the reason noted here.
- **RECOMPUTE the plan at the sha you are about to merge, not once at the first
  commit.** What the reviewers must cover is a function of the diff, and the diff
  GROWS across fix-back rounds: a fix round can newly touch a security surface or
  a schema field the opening diff did not.
- Synthesize the reports into a verdict; any blocker starts a fix-back loop.

## Re-review every fix round

**Re-review the FIX DELTA, not just the reviewer plan.** Fixes are code no
reviewer has seen, written under the momentum of agreeing with a finding, landing
exactly where a reviewer just proved the code is subtle. Scope the round to the
delta and say the original design is accepted.

**The rule RECURSES** — every fix round, not just the second. Keep going while
the round changed anything, PROSE INCLUDED (a fix's rationale is its least-probed
text), and a TEST rewrite counts. When a round REPLACES an assertion rather than
adding one, KEEP BOTH unless you can NAME, in the commit message, the mutation
the old one could not catch. "More precise" is not that name: precision is not a
superset of what it replaces, and if you cannot name the mutation, the
replacement is a deletion.

Corollary for mutation probes: **enumerate the branches the diff ADDS and probe
each one** — a new `if`, a new token in a rendered string, a new early return and
a new gate condition are four probes, not one.

## Walk the diff

- `git diff origin/main...HEAD` — confirm the diff is what you reviewed.
- For each change: correct? complete? necessary? Logic errors, dead code,
  inconsistencies between files; all callers of changed functions handle the new
  behavior; types consistent with the implementation.
- **Shared-utility regression check**: if `src/utils/**` (or another
  widely-imported module) changed, list every importer
  (`grep -rl "from '\.\./.*utils/<file>'" src tests`) and walk each one.
- **Internal-interface contract change check**: if the diff changes the SEMANTICS
  of arguments an interface receives — even with the type signature unchanged —
  list every implementer and walk each for load-bearing assumptions about the old
  shape (truthy gates, "absent = remove" semantics, `JSON.parse` on stringly
  input). Audit BEFORE writing tests against the new design: discovering the
  breaks afterwards forces a rework and invalidates the tests.

  ```bash
  grep -rln "implements ResourceProvider" src/provisioning/providers/
  ```
