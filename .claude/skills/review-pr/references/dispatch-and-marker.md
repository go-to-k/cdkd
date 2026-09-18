# Step 6 — dispatch the reviewers and synthesize

Read at step 6, once the reviewer set is resolved. Every run reaches this file:
the default set is one reviewer, and there is no tier that dispatches nobody.

Orchestrator: [../SKILL.md](../SKILL.md).

6. **Dispatch reviewers**: the orchestrator dispatches the recommended
   reviewers via the Agent tool, waits for all, and synthesizes:

   FIRST the PRE-FILTERS, which discount findings and FALL THROUGH. THEN the
   two VERDICT arms, which are mutually exclusive and one of which always runs.

   That order, and that shape, are both forced. An earlier revision wrote all
   four as first-match-wins alternatives, and a run whose only finding was a
   discounted one then matched an arm stating what does NOT happen and got no
   instruction at all — leaving the merge decision unstated.

### Pre-filters

   An axis reporting **`No spec declared`** (the spec axis found no design doc AND no `Closes`
     in the PR body) is an ANNOTATION, not a verdict. It is NOT a clean axis, and it does NOT
     block — so it is struck from the set the verdict arms see, exactly like a
     discounted finding. A round whose ONLY finding is this therefore takes the
     minor / nit / clean arm and CLEARS the review, with the unreviewed
     dimension NAMED in the synthesis. Saying only what it does not do is what left this
     shape with no instruction at all. Treat
     it as an unreviewed dimension: say so in the synthesis, and decide
     deliberately whether the PR should declare what it closes before merging.
     It is called out separately because it falls silently into the bucket
     otherwise — at the one place a verdict is consumed it is indistinguishable
     from Clean. That gap is what go-to-k/cdkd#3169 recorded and could not fix: the
     clause did not fit inside the 23,000 B cap, and six measured attempts were
     all over it. Fitting here is the point of the split.


   A `spec (secondary)` finding is DISCOUNTED — struck from the
   set the verdict arms below see — when BOTH hold:

   1. a primary `pr-spec-reviewer` verdict exists on the SAME question, and
   2. the finding is not independently a code or security defect.

   Then continue to the verdict arms. The code and security reviewers carry a
   deliberately shallow spec pass and cannot tell whether the real spec axis
   was dispatched — nothing in their inputs says which reviewers ran — so
   without this a secondary finding blocks the PR on a question the primary
   axis already cleared. Where no primary verdict exists on that question, the
   finding is not discounted; judge it on its own merits.

   **Condition 2 is what makes this safe, and severity is NOT a substitute for
   it.** `pr-security-reviewer.md` tells that reviewer to cap its secondary
   findings at `minor` *unless the finding is independently a security defect*
   — so the label is explicitly allowed to carry a `blocker`. A label-keyed
   discount would dismiss exactly the findings that must never be dismissed:
   a PR closing a GHSA secret-leak issue draws a Clean from `pr-spec-reviewer`
   on the design doc, while the security reviewer notices off the same
   acceptance walk that the redaction is not inverted on the rollback replay
   path, labels it `spec (secondary)`, and raises it as a blocker under that
   escape clause. Discounting there clears the PR over a live exposure.

   A SEVERITY-keyed discount is no better, for the opposite reason: minor
   findings never blocked a merge anyway, so keying on `minor or below`
   makes the rule inert. Condition 2 is what separates those two failure modes,
   and neither severity nor the label can.

   **What this filter actually reaches, stated plainly.** For a COMPLIANT
   reviewer it is unreachable: `pr-code-reviewer.md` and
   `pr-security-reviewer.md` both cap a secondary finding at `minor` unless it
   is independently a code or security defect, so `spec (secondary)` + blocker
   already implies condition 2 is false, and a minor never blocked. It is a
   BACKSTOP against a reviewer definition that overshoots its own cap — which
   go-to-k/cdkd#3169 named as the standing risk, since the caps are agent-side
   and nothing makes the parent enforce them. If that ever stops being the
   right division of labour, the caps are what to revisit, not this filter.


### Verdict arms — exactly one runs

   - Any **blocker** surviving the pre-filters → **do not merge**; address the
     blockers and
     re-run `/review-pr <N>` **from step 0**, on the PR's CURRENT diff —
     step 0 and not step 1, because a fix-round re-review IS the case step 0
     exists for: go-to-k/cdkd#2753's crossing happened on exactly this
     re-entry, so starting at step 1 leaves the rule inert on its own
     motivating case. A fix round can also change WHICH reviewers the PR
     needs — it may newly touch a security surface, or a schema field — so
     re-read the `paths` after every round rather than reusing the first
     round's answer.
   - Every finding minor / nit / clean → the review round is CLOSED. Say so
     explicitly in the synthesis, naming the head sha you reviewed and which
     reviewers ran, so a later push is visibly un-reviewed. Nothing records
     this mechanically any more (`pr-review` was removed from `.markgate.yml`),
     which is exactly why the statement has to be explicit. Re-review before
     merging if the head has moved since.

   **Security add-on dispatch**: when the step-3 trigger fired, dispatch
   `pr-security-reviewer` in the same parallel batch and fold its findings in
   — a security blocker stops the merge like any other.

   **NEVER report a round closed without dispatching the reviewers first** —
   the whole point is that an un-reviewed PR does not reach main.
