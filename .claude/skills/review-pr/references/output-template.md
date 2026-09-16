# Step 5 — the recommendation format, and the dry-run calibration set

Read at step 5, when rendering. The calibration table at the end is how you check
the heuristic still resolves the tiers it is supposed to.

Orchestrator: [../SKILL.md](../SKILL.md).

## Output template

```
Recommendation: <inline | 1-reviewer | 3-axis>

PR #<N>: <title>
Stats: +<additions> / -<deletions> = <loc> LOC, <fc> files
Branch: <branch>

Base tier (from stats): <base>
Bias factors:
  - <factor 1, or "none">
Applied bias: <up / down / none>
Final tier: <final>

Rationale: <one line>
```

Then, **if final tier is `1-reviewer`**, emit:

```
Dispatch this single reviewer (run via Agent tool in the main session):

  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> code review",
    prompt: |
      Read your role definition at `.claude/agents/pr-code-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
  }
```

**At `1-reviewer`, the ORCHESTRATOR still asks the `Closes` question itself**,
exactly as in the `inline` block below — the dispatched code reviewer is
explicitly told not to rule on it, so nothing else will.

**If final tier is `3-axis`**, emit the same block three times in ONE
parallel message, for `.claude/agents/pr-spec-reviewer.md` (add
`- Design doc: <path>` if `docs/design/` has one for the issue, else
`- Closes: #N` from the body — never downgrade for no doc),
`.claude/agents/pr-code-reviewer.md`, and
`.claude/agents/pr-test-reviewer.md`.

**If final tier is `inline`**, emit:

```
No reviewer dispatch — orchestrator should spot-check inline:

  - `gh pr diff <N>` — read the full diff in one pass
  - For each changed file, ask: is it correct, complete, necessary?
  - If the body declares `Closes #N`, read that issue and ask whether the
    `Closes` is EARNED — walk its acceptance items, INCLUDING any the thread
    added by comment. A partly-addressed issue takes `Refs` plus a comment
    recording what landed and what did not. Unless the security add-on fired
    no reviewer is dispatched at this tier, so nobody else asks this — and
    the security reviewer refuses to rule on "earned".

If the inline read surfaces a non-obvious bug class (cross-cutting state
machine, race, security-sensitive logic), STOP and dispatch a code reviewer.
```

**The `Closes` question is the ORCHESTRATOR's at every tier below `3-axis`, and
that is deliberate.** `inline` dispatches nobody. `1-reviewer` dispatches the
code reviewer, whose own definition says in as many words *do NOT rule on
whether a `Closes` is "earned"* — its spec pass is secondary and capped. So
leaving the question to the dispatched reviewer makes the ladder
NON-MONOTONIC: `inline+up→1-reviewer` would REMOVE a check, which no bias step
may ever do. Ask it yourself at both tiers; only `3-axis` hands it to
`pr-spec-reviewer`, which is the axis that can actually rule on it.

Until go-to-k/cdkd#3170 the spec axis had no owner at `inline` at all — the
block asked only "correct, complete, necessary?". That line is the one
BEHAVIOUR change the references/ split carries; everything else in it is
relocation.

**ADDITIONALLY, if the security add-on trigger fired**, append (at ANY tier,
same parallel batch):

```
  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> security review",
    prompt: |
      Read your role definition at `.claude/agents/pr-security-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
      - Security concern to focus on: <name the sensitive value(s) / surface this PR touches — e.g. "the redacted secret expression persisted to state + journal; trace every reader". With no named value, the reviewer defaults to enumerating all sensitive values in the diff.>
  }
```

## Dry-run reference (sanity check)

Calibration set — the skill run against these should produce:

| PR | Stats | Base tier | Bias | Final |
|----|-------|-----------|------|-------|
| #240 | 390 LOC, 4 files (`.claude/hooks/*`, `CLAUDE.md`, `.claude/settings.json`) | inline (fc < 5) | none (agent-instruction files are NOT in the docs bucket) | **inline** |
| #237 | 4515 LOC, 24 files (incl. `src/local/cognito-jwt.ts`) | 3-axis | up (security surface) → clamps | **3-axis** |
| #236 | 269 LOC, 9 files (incl. `src/local/docker-image-builder.ts`, `ecr-puller.ts`) | inline (loc < 300) | up (process-launch surface) | **1-reviewer** |
| #344 | 1488 LOC, 13 files (all `.md`, incl. `CLAUDE.md`) | 3-axis | none — `CLAUDE.md` fails the inert-docs premise | **3-axis** |
| #404 | 4286 raw → ~1100 LOC after auto-gen exclusion, 19 files | 3-axis (`fc >= 10`, file count not adjusted) | none (mixed paths) | **3-axis** |

Divergence from these rows means the heuristic or trigger lists drifted —
re-read SKILL.md step 2 and references/bias-factors.md before trusting the recommendation. **The rows are
RECALCULATED expectations, not history** (#240 / #344 were originally decided
under a wider docs bucket); do not "restore" the old bucket to make a row
match.
