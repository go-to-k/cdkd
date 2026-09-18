# Step 3 — reviewer triggers

Read at step 3, after the default set is known. Carries the trigger lists, the
security surface list, and the measured incidents behind each.

Orchestrator: [../SKILL.md](../SKILL.md).

3. **Triggers** from the `paths` list. The reviewer count is FLAT — one
   `pr-code-reviewer` by default, and **size selects nothing**. This step decides
   only what gets ADDED to that default.

   **Security add-on reviewer (additive).** Dispatch `pr-security-reviewer`
   alongside the default whenever any of these holds:

   - Any path matches **security / process-launch surface**:
     - `src/utils/role-arn.ts`
     - `src/utils/docker-cmd.ts`
     - `src/local/cognito-jwt.ts`
     - `src/local/authorizer-resolver.ts`
     - `src/local/authorizer-cache.ts`
     - `src/local/sigv4-verify.ts`
     - `src/local/agentcore-sigv4-sign.ts`
     - `src/local/docker-runner.ts`
     - `src/local/docker-image-builder.ts`
     - `src/local/ecr-puller.ts`
     - `src/local/ecs-secrets-resolver.ts`
     - `src/local/ecs-task-runner.ts`

     **What belongs here**: a file is listed when it (a) verifies or mints
     authn material or loads credentials, (b) resolves secret material, or
     (c) launches a process or derives the executable path one is launched
     from. Consumers of those primitives are NOT listed. Several entries are
     thin re-export shims over cdk-local — they stay listed on purpose: a
     shim edit changes WHICH implementation cdkd consumes. The list rots two
     silent ways (an entry stops existing; a live surface never gets added —
     both seen in issue #1972);
     `tests/unit/scripts/security-surface-list-sync.test.ts` fences the first
     and keeps this copy in step with `pr-security-reviewer.md`'s; the second
     needs the (a)/(b)/(c) test re-applied when this area changes.

   - Any path under `src/provisioning/providers/**` (deletion-sensitive —
     `integ-destroy` scope; real-AWS regressions cost cleanup time)
   - The PR is a **security fix** (secrets / credentials, redaction / masking /
     escaping, sensitive-value persistence, GHSA-tied), whatever it touches.

   The security reviewer is a DEPTH concern a tiny PR can carry — the
   GHSA-p5qg-v9gv-hc7w rollback blocker was surfaced by the generic reviewer
   only on a second, prompted round; a standing security lens catches that
   class in round one. **A security blocker stops the merge like any other.**

   **All three axes (`3-axis`: spec + code + test in parallel, plus the
   security reviewer when its trigger fired)** — exactly two cases, both
   contract-level rather than size-level:

   - a **state-schema bump** (`StackState.version`) — the S3 state schema is
     the real user contract and a bad migration is not recoverable from the
     user's side;
   - a **security fix**, per the definition above.

   Everything else gets the default one reviewer plus any add-on. There is no
   size ladder: LOC and file count do NOT move the count in either direction,
   and a docs-only or test-only diff does not reduce it below one.

   **Signals that justify going ABOVE what the rules above resolve.** The count
   is a FLOOR, not a cap (CLAUDE.md → "Cost is not a tiebreaker"); these are
   judgement calls, and when one fires, add the axis and say why:

   - **> 1 fix-back ROUND on the PR** ("multiple sub-agents wrote the diff").
     Count DISTINCT `fix:` SUBJECTS across the PR's commits AND every commit
     its timeline recorded as a former HEAD — `git log main..<branch>` alone is
     what a FLATTEN erases, and this repo flattens by policy
     (go-to-k/cdkd#2638). Subjects rather than shas, because an amend re-shas
     one round.
   - **The code this PR edits shipped a defect in a RECENT PR.** Read the tell
     off the history step 1 gathered — 2 or more `fix:` commits among a touched
     file's last 3 — rather than from what you remember about the area.
     Measured on go-to-k/cdkd#2593: the log on
     `src/deployment/recreate-targets.ts` showed the two preceding merges were
     both data-loss-guard fixes and the nearer one (go-to-k/cdkd#2565) had
     fixed a fail-open in the very function that PR edits again. Code +
     security ran and converged on the same two untested response shapes.
     Recency is evidence about the code, the way a security path is.

   **Agent-instruction files never get a discount.** `CLAUDE.md`,
   `.claude/rules/**`, `.claude/skills/**`, `.claude/agents/**`,
   `.claude/hooks/**`, `.claude/settings*.json` and `.markgate.yml` change how
   every future session behaves; a defect there has a wider blast radius than
   most code, and "it's only docs" is the arm a `.claude/**`-only diff gets
   wrong. The same goes for a "test-only" diff that changes what a checker
   ACCEPTS: the low-risk premise is false.
