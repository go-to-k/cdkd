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

If the inline read surfaces a non-obvious bug class (cross-cutting state
machine, race, security-sensitive logic), STOP and dispatch a code reviewer.
```

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
re-read this file before trusting the recommendation. **The rows are
RECALCULATED expectations, not history** (#240 / #344 were originally decided
under a wider docs bucket); do not "restore" the old bucket to make a row
match.
