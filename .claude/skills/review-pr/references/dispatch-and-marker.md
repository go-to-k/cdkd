# Step 6 — dispatch the reviewers, synthesize, bind the marker

Read at step 6, once a tier of `1-reviewer` or `3-axis` is resolved. An `inline`
tier sets no marker and needs none of this.

Orchestrator: [../SKILL.md](../SKILL.md).

6. **Dispatch reviewers + set the marker** (only for `1-reviewer` / `3-axis`):
   the orchestrator dispatches the recommended reviewers via the Agent tool,
   waits for all, and synthesizes:

   FIRST the PRE-FILTERS, which discount findings and FALL THROUGH. THEN the
   two VERDICT arms, which are mutually exclusive and one of which always runs.

   That order, and that shape, are both forced. An earlier revision wrote all
   four as first-match-wins alternatives, and a run whose only finding was a
   discounted one then matched an arm stating what does NOT happen, got no
   instruction, and never reached the marker block — so `pr-review-gate.sh`
   blocked the merge with no stated remedy.

### Pre-filters

   A `spec (secondary)` finding is DISCOUNTED — struck from the
   set the verdict arms below see — when BOTH hold:

   1. a primary `pr-spec-reviewer` verdict exists on the SAME question, and
   2. the finding is not independently a code or security defect.

   Then continue to the verdict arms. The code and security reviewers carry a
   deliberately shallow spec pass and cannot tell whether the real spec axis
   was dispatched — nothing in their inputs names the tier — so without this a
   secondary finding blocks the marker on a question the primary axis already
   cleared. Where no primary verdict exists on that question, the finding is
   not discounted; judge it on its own merits.

   **Condition 2 is what makes this safe, and severity is NOT a substitute for
   it.** `pr-security-reviewer.md` tells that reviewer to cap its secondary
   findings at `minor` *unless the finding is independently a security defect*
   — so the label is explicitly allowed to carry a `blocker`. A label-keyed
   discount would dismiss exactly the findings that must never be dismissed:
   a PR closing a GHSA secret-leak issue draws a Clean from `pr-spec-reviewer`
   on the design doc, while the security reviewer notices off the same
   acceptance walk that the redaction is not inverted on the rollback replay
   path, labels it `spec (secondary)`, and raises it as a blocker under that
   escape clause. Discounting there sets the marker over a live exposure.

   A SEVERITY-keyed discount is no better, for the opposite reason: minor
   findings never blocked the marker anyway, so keying on `minor or below`
   makes the rule inert and drops go-to-k/cdkd#3170's actual case — a secondary
   BLOCKER that should defer to a primary axis that already ruled. Condition 2
   is what separates those two, and neither severity nor the label can.


   An axis reporting **`No spec declared`** (the spec axis found no design doc AND no `Closes`
     in the PR body) is an ANNOTATION, not a verdict: this is NOT a clean axis, and it does NOT
     block, so it neither sets nor withholds the marker on its own. Treat
     it as an unreviewed dimension: say so in the synthesis, and decide
     deliberately whether the PR should declare what it closes before merging.
     It is called out separately because it falls silently into the bucket
     otherwise — at the one place a verdict is consumed it is indistinguishable
     from Clean. That gap is what go-to-k/cdkd#3169 recorded and could not fix: the
     clause did not fit inside the 23,000 B cap, and six measured attempts were
     all over it. Fitting here is the point of the split.

### Verdict arms — exactly one runs

   - Any **blocker** surviving the pre-filters → the marker is NOT set; address
     the blockers and
     re-run `/review-pr <N>` **from step 0**, on the PR's CURRENT stats —
     step 0 and not step 1, because a fix-round re-review IS the case step 0
     exists for: go-to-k/cdkd#2753's crossing happened on exactly this
     re-entry, so starting at step 1 leaves the rule inert on its own
     motivating case. A fix round adds LOC and files AND a `fix:` commit, so
     the tier is not fixed for the life of a PR and neither is whether
     `pr-review-gate.sh` requires the marker: go-to-k/cdkd#2593 opened at 306 LOC / 4
     files (`inline`, no marker required) and its review-fix commit took it
     to 406 LOC / 6 files — `1-reviewer` by size, and `3-axis` once the
     hook's second-`fix:`-commit up-bias fires on the same push. Caught only
     by recomputing before the merge; re-read the stats after every fix
     round, in both directions.
   - Every finding minor / nit / clean → set the marker bound to the PR's
     current HEAD sha:

     ```bash
     mise trust   # unconditional; `markgate set` dies on an untrusted
                  # `.mise.toml` and loses the round (`/check` step 0).
     # The pr-review gate's scope is the sentinel file at repo root, so
     # writing the PR HEAD sha into it before `markgate set` binds the marker
     # to that sha — a later push invalidates it. Sentinel + markgate state
     # land in the CURRENT worktree; set markers from the worktree you intend
     # to merge from. Right after a push `gh pr view` can still answer the
     # PREVIOUS head (hit merging go-to-k/cdkd#879; twice on 2026-09-14): bind
     # only when it equals local HEAD, after `gh pr checks <N> --watch`, never
     # in the push's own call; on a mismatch re-run it. `:?` refuses an empty
     # answer, which would compare equal to an empty `rev-parse`.
     SHA=$(gh pr view <N> --json headRefOid -q .headRefOid)
     if [ "${SHA:?no PR head}" = "$(git rev-parse HEAD)" ]; then
       printf '%s\n' "$SHA" > .markgate-pr-review-sha && mise exec -- markgate set pr-review
     else echo "PR head ${SHA:0:7} != local HEAD: NOT bound" >&2; fi
     ```

   For `inline`, the marker is NOT set — the gate's heuristic also outputs
   `inline`, so no enforcement fires.

   **Security add-on dispatch**: when the trigger fired, dispatch
   `pr-security-reviewer` in the same parallel batch and fold its findings in
   — a security blocker blocks the marker like any other. This applies at
   every tier this file is reached at. The `inline` case is NOT here, because
   this file is only read at `1-reviewer` / `3-axis` — SKILL.md step 3 carries
   the ANY-tier rule, and `references/output-template.md` carries the block
   `inline` appends. A skill-level requirement, not yet a hard gate.

   **NEVER set the marker without dispatching the reviewers first** — the
   gate exists so an un-reviewed large PR cannot reach main.
