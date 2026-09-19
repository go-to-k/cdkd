# Step 6 — dispatch the reviewers and synthesize

Read at step 6, once the reviewer set is resolved. Every run reaches this file:
the default set is one reviewer, and there is no tier that dispatches nobody.
Orchestrator: [../SKILL.md](../SKILL.md).

The orchestrator dispatches the recommended reviewers via the Agent tool, waits
for all of them, and synthesizes.

Apply the PRE-FILTERS first — they discount findings and FALL THROUGH — and only
then the two VERDICT arms, which are mutually exclusive and one of which always
runs. Written as first-match-wins alternatives instead, a run whose only finding
is a discounted one matches an arm stating what does NOT happen and gets no
instruction at all, leaving the merge decision unstated.

## Pre-filters

**`No spec declared`** (the spec axis found no design doc AND no `Closes` in the
PR body) is an ANNOTATION, not a verdict. It is NOT a clean axis and it does NOT
block, so it is struck from the set the verdict arms see. A round whose ONLY
finding is this takes the minor / nit / clean arm and CLEARS the review, with the
unreviewed dimension NAMED in the synthesis — decide deliberately whether the PR
should declare what it closes before merging. It is called out separately because
at the point a verdict is consumed it is otherwise indistinguishable from Clean.

A **`spec (secondary)` finding is DISCOUNTED** — struck from the set the verdict
arms see — when BOTH hold:

1. a primary `pr-spec-reviewer` verdict exists on the SAME question, and
2. the finding is not independently a code or security defect.

The code and security reviewers carry a deliberately shallow spec pass and cannot
tell whether the real spec axis was dispatched, so without this a secondary
finding blocks the PR on a question the primary axis already cleared. Where no
primary verdict exists on that question, judge the finding on its own merits.

**Condition 2 is what makes this safe, and severity is NOT a substitute for it.**
`pr-security-reviewer.md` caps its secondary findings at `minor` *unless the
finding is independently a security defect*, so the label is explicitly allowed
to carry a `blocker` — a label-keyed discount would dismiss exactly the findings
that must never be dismissed (a redaction not inverted on the rollback replay
path, noticed off a spec acceptance walk). A severity-keyed discount is no better
for the opposite reason: minor findings never blocked a merge, so keying on
"minor or below" makes the rule inert.

For a COMPLIANT reviewer this filter is unreachable; it is a BACKSTOP against a
reviewer definition that overshoots its own cap. If that stops being the right
division of labour, the caps are what to revisit, not this filter.

## Verdict arms — exactly one runs

- Any **blocker** surviving the pre-filters → **do not merge**; address the
  blockers and re-run `/review-pr <N>` **from step 0**, on the PR's CURRENT diff.
  Step 0 and not step 1, because a fix-round re-review is exactly the case step 0
  exists for. A fix round can also change WHICH reviewers the PR needs — it may
  newly touch a security surface, or a schema field — so re-read the `paths`
  after every round rather than reusing the first round's answer.
- Every finding minor / nit / clean → the review round is CLOSED. Say so
  explicitly in the synthesis, naming the head sha you reviewed and which
  reviewers ran, so a later push is visibly un-reviewed. Nothing records this
  mechanically, which is why the statement has to be explicit. Re-review before
  merging if the head has moved since.

**Security add-on dispatch**: when the step-3 trigger fired, dispatch
`pr-security-reviewer` in the same parallel batch and fold its findings in — a
security blocker stops the merge like any other.

**NEVER report a round closed without dispatching the reviewers first.**
