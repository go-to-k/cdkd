# Step 6 — dispatch the reviewers, synthesize, bind the marker

Read at step 6, once a tier of `1-reviewer` or `3-axis` is resolved. An `inline`
tier sets no marker and needs none of this.

Orchestrator: [../SKILL.md](../SKILL.md).

6. **Dispatch reviewers + set the marker** (only for `1-reviewer` / `3-axis`):
   the orchestrator dispatches the recommended reviewers via the Agent tool,
   waits for all, and synthesizes:

   - Any **blocker** → the marker is NOT set; address the blockers and
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
   - **`No spec declared`** (the spec axis found no design doc AND no `Closes`
     in the PR body) → this is NOT a clean axis, and it does NOT block. Treat
     it as an unreviewed dimension: say so in the synthesis, and decide
     deliberately whether the PR should declare what it closes before merging.
     It has its own arm because it falls silently into the bucket below
     otherwise — at the one place a verdict is consumed it is indistinguishable
     from Clean, and the agent's report is the only thing that currently keeps
     it out. That gap is what go-to-k/cdkd#3169 recorded and could not fix: the
     clause did not fit inside the 23,000 B cap, and six measured attempts were
     all over it. Fitting here is the point of the split.
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
   EVERY tier, `inline` included (a skill-level requirement, not yet a hard
   gate).

   **NEVER set the marker without dispatching the reviewers first** — the
   gate exists so an un-reviewed large PR cannot reach main.
