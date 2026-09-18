# Step 5 — the recommendation format

Read at step 5, when rendering.

Orchestrator: [../SKILL.md](../SKILL.md).

## Output template

```
Recommendation: <one reviewer | 3-axis>[ + security]

PR #<N>: <title>
Stats: +<additions> / -<deletions> = <loc> LOC, <fc> files   (context only —
       size selects nothing)
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

**With the default single reviewer, the ORCHESTRATOR still asks the `Closes`
question itself** — the dispatched code reviewer is explicitly told not to rule
on it, so nothing else will. Emit it alongside the dispatch block:

```
Orchestrator check (not delegated):

  - If the body declares `Closes #N`, read that issue and ask whether the
    `Closes` is EARNED — walk its acceptance items, INCLUDING any the thread
    added by comment. A partly-addressed issue takes `Refs` plus a comment
    recording what landed and what did not. The security reviewer refuses to
    rule on "earned", so dispatching it does not cover this either.
```

**If the PR resolved to `3-axis`**, emit the same block three times in ONE
parallel message, for `.claude/agents/pr-spec-reviewer.md` (add
`- Design doc: <path>` if `docs/design/` has one for the issue, else
`- Closes: #N` from the body — never downgrade for no doc),
`.claude/agents/pr-code-reviewer.md`, and
`.claude/agents/pr-test-reviewer.md`.

**The `Closes` question is the ORCHESTRATOR's whenever `pr-spec-reviewer` is
not dispatched, and that is deliberate.** The code reviewer's own definition
says in as many words *do NOT rule on whether a `Closes` is "earned"* — its
spec pass is secondary and capped — and the security reviewer refuses the
question outright. So with the default set nobody else asks it; only `3-axis`
hands it to `pr-spec-reviewer`, which is the axis that can actually rule on it.
Dropping the question because a reviewer was dispatched would REMOVE a check,
which adding reviewers must never do.

Until go-to-k/cdkd#3170 the question had no owner outside `3-axis` at all. That
ownership rule is the one BEHAVIOUR change the references/ split carried;
everything else in it was relocation.

**ADDITIONALLY, if the security add-on trigger fired** (a secret / credential /
redaction / masking / sensitive-value-persistence / process-launch surface, or
a security fix), append — whichever set resolved, same parallel batch:

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
