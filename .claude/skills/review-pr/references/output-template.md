# Step 5 — the recommendation format

Read at step 5, when rendering. Orchestrator: [../SKILL.md](../SKILL.md).

```
Recommendation: <one reviewer | 3-axis>[ + security]

PR #<N>: <title>
Stats: +<additions> / -<deletions> = <loc> LOC, <fc> files; src/**: <src-loc> LOC, <src-fc> files
       (3-axis when src/** exceeds 400 lines or 8 files)
Branch: <branch>

Triggers fired:
  - <trigger, or "none">
Reviewers to dispatch: <pr-code-reviewer[, pr-spec-reviewer, pr-test-reviewer][, pr-security-reviewer]>

Rationale: <one line>
```

Then, **unless the PR resolved to 3-axis**, emit the default single reviewer:

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

**With the default single reviewer, the ORCHESTRATOR asks the `Closes` question
itself** — the code reviewer's definition says in as many words not to rule on
whether a `Closes` is earned, and the security reviewer refuses the question
outright, so with the default set nobody else asks it. Only `3-axis` hands it to
`pr-spec-reviewer`. Dropping the question because a reviewer was dispatched would
REMOVE a check, which adding reviewers must never do. Emit it alongside the
dispatch block:

```
Orchestrator check (not delegated):

  - If the body declares `Closes #N`, read that issue and ask whether the
    `Closes` is EARNED — walk its acceptance items, INCLUDING any the thread
    added by comment. A partly-addressed issue takes `Refs` plus a comment
    recording what landed and what did not.
```

**If the PR resolved to `3-axis`**, emit the same block three times in ONE
parallel message, for `.claude/agents/pr-spec-reviewer.md` (add
`- Design doc: <path>` if `docs/design/` has one for the issue, else
`- Closes: #N` from the body — never downgrade for want of a doc),
`.claude/agents/pr-code-reviewer.md`, and `.claude/agents/pr-test-reviewer.md`.

**ADDITIONALLY, if the security add-on trigger fired**, append — whichever set
resolved, same parallel batch:

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
