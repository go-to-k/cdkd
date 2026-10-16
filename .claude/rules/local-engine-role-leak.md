---
description: Which identity a `cdkd local` workload resolves as under `--role-arn`
paths:
  - 'src/cli/commands/local-state-source.ts'
  - 'src/cli/commands/local-start-*.ts'
  - 'src/cli/commands/local-run-task.ts'
  - 'src/local/local-role-arn.ts'
---

# What a `cdkd local` workload resolves as

Issue [#3240](https://github.com/go-to-k/cdkd/issues/3240); the env-channel
half is [local-caller-identity.md](local-caller-identity.md).

`--role-arn` is a DEPLOY identity. The emulated workload's inputs (the container
credentials, ECS task secrets, `{{resolve:...}}` lookups, `${AWS::AccountId}`,
`--from-cfn-stack` reads, a literal layer ARN, the `--assume-role` hop) resolve
as the CALLER, never the role.

- **cdk-local does it.** `CDKD_EMBED_CONFIG` (`local-invoke.ts`) sets
  `workloadIdentity: 'caller'`. On the four ENGINE commands (`start-service` /
  `start-alb` / `start-cloudfront` / `start-agentcore`) cdk-local runs its own
  `applyRoleArnIfSet`, records the assume (`recordAssumedRole`, write-once per
  process) and builds every workload client as the caller. `--profile` picks
  which caller.
- **cdkd's four commands publish via `applyRoleArnForLocal`**
  (`src/local/local-role-arn.ts`): cdkd's `applyRoleArnIfSet`, then
  `recordAssumedRole` with the pre-assume snapshot. A call site using the bare
  `applyRoleArnIfSet` assumes the role without telling cdk-local, so its
  `--from-cfn-stack` provider, literal layer fetch and assume-role hop resolve
  the ROLE. Fenced by `tests/unit/local/local-role-arn.test.ts`.
- **`createCallerDynamicReferenceResolver`** (`src/local/dynamic-reference.ts`)
  stays for the cdkd-owned commands' own `{{resolve:...}}` clients.

## What stays on the role, deliberately

Synthesis, the ECR pull, a `fromS3` bundle download, and cdkd's `--from-state`
reads (`cdkd-local-role-identity:` sites). Do NOT "fix" the last: the state
bucket name is derived in the ROLE's account and the calls carry
`ExpectedBucketOwner`, so caller credentials 403. The cdkd-owned commands'
`${AWS::AccountId}` follows that reader under `--from-state` and stays the
caller's under `--from-cfn-stack` (go-to-k/cdkd#3230).

## Remaining bounds

- cdk-local studio's children are not embedded, so they do not carry the config.
- A `[default]` profile that sources the environment resolves whatever the
  `AWS_*` variables hold.
- Cross-account: `${AWS::AccountId}` is the caller's account.
