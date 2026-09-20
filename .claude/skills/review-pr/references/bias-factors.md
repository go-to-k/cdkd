# Step 3 — reviewer triggers

Read at step 3, after the default set is known. Orchestrator:
[../SKILL.md](../SKILL.md).

The reviewer count starts at one `pr-code-reviewer`. This step decides what gets
ADDED to that default: the size axes, the security add-on, or both.

## Size

The `src/**` part of the diff exceeds 400 lines OR 8 files → add
`pr-spec-reviewer` + `pr-test-reviewer` (all three axes). Measure `src/**` only:
tests, docs and `.claude/**` do not count toward the threshold.

## Security add-on reviewer (additive)

Dispatch `pr-security-reviewer` alongside the default whenever any of these
holds:

- Any path matches the **security / process-launch surface**:
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

  **What belongs on that list**: a file is listed when it (a) verifies or mints
  authn material or loads credentials, (b) resolves secret material, or (c)
  launches a process or derives the executable path one is launched from.
  Consumers of those primitives are NOT listed. Several entries are thin
  re-export shims over cdk-local; they stay listed on purpose, because a shim
  edit changes WHICH implementation cdkd consumes. Re-apply the (a)/(b)/(c) test
  when this area changes, and keep this copy in step with the one in
  `.claude/agents/pr-security-reviewer.md`.

- Any path under `src/provisioning/providers/**` (deletion-sensitive —
  `integ-destroy` scope).
- The PR is a **security fix** (secrets / credentials, redaction / masking /
  escaping, sensitive-value persistence, GHSA-tied), whatever it touches.

The security reviewer is a DEPTH concern a tiny PR can carry; a standing security
lens catches that class in round one rather than on a second, prompted round.

## All three axes

`3-axis` is spec + code + test in parallel. It is reached by the size trigger
above, or by either of two contract-level cases, which ALSO add the security
reviewer:

- a **state-schema bump** (`StackState.version`) — the S3 state schema is the
  real user contract and a bad migration is not recoverable from the user's side;
- a **security fix**, per the definition above.

Everything else gets the default one reviewer plus any add-on. A docs-only or
test-only diff does not reduce the count below one.

Reviewers run ONCE, on the FINAL sha. A fix round is re-checked by messaging the
SAME reviewer with the delta (`SendMessage`), never by a fresh dispatch.

## Signals that justify going ABOVE the resolved set

The count is a FLOOR, not a cap. These are judgement calls; when one fires, add
the axis and say why.

- **More than one fix-back ROUND on the PR** ("multiple sub-agents wrote the
  diff"). Count DISTINCT `fix:` SUBJECTS across the PR's commits AND every commit
  its timeline recorded as a former HEAD — `git log main..<branch>` alone is what
  a FLATTEN erases, and this repo flattens by policy. Subjects rather than shas,
  because an amend re-shas one round.
- **The code this PR edits shipped a defect in a RECENT PR.** Read the tell off
  the history probe step 1 gathered — 2 or more `fix:` commits among a touched
  file's last 3 — rather than from what you remember about the area. Recency is
  evidence about the code, the way a security path is.

**Agent-instruction files never get a discount.** `AGENTS.md`,
`.claude/rules/**`, `.claude/skills/**`, `.claude/agents/**`, `.claude/hooks/**`,
`.claude/settings*.json` and `.markgate.yml` change how every future session
behaves, so a defect there has a wider blast radius than most code. The same goes
for a "test-only" diff that changes what a checker ACCEPTS.
