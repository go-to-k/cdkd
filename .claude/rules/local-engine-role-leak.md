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
  `workloadIdentity: 'caller'`. On the five ENGINE commands (`start-service` /
  `start-alb` / `start-cloudfront` / `start-agentcore` / `start-web-function`) cdk-local runs its own
  `applyRoleArnIfSet`, records the assume (`recordAssumedRole`, write-once per
  process) and builds every workload client as the caller. `--profile` picks
  which caller.
- **cdkd's four commands publish via `applyRoleArnForLocal`**
  (`src/local/local-role-arn.ts`): cdkd's `applyRoleArnIfSet`, then
  `recordAssumedRole` with the pre-assume snapshot and the role triple. A call site using the bare
  `applyRoleArnIfSet` assumes the role without telling cdk-local, so its
  `--from-cfn-stack` provider and `--layer-role-arn` hop resolve the ROLE
  (cdkd's own `--assume-role` hop opts out itself). Fenced by `tests/unit/local/local-role-arn.test.ts`.
- **`createCallerDynamicReferenceResolver`** (`src/local/dynamic-reference.ts`)
  stays for the cdkd-owned commands' own `{{resolve:...}}` clients.

## What stays on the role, deliberately

Synthesis, the ECR pull, a `fromS3` bundle download, and cdkd's `--from-state`
reads (`cdkd-local-role-identity:` sites). Do NOT "fix" the last: the state
bucket name is derived in the ROLE's account and the calls carry
`ExpectedBucketOwner`, so caller credentials 403.

**`${AWS::AccountId}` follows WHERE THE STACK WAS READ** (go-to-k/cdkd#5001):
under `--from-state` and with no state source (run-task image `Fn::Sub`, bare
`--assume-task-role`) it is the DEPLOY account, the `--role-arn` role's; under
`--from-cfn-stack` the stack is read as the caller (#3240) and CloudFormation
sees only the caller's account, so it is the caller's. With no `--role-arn`
all are your own. It is an identifier, not a permission. The cdkd-owned
commands branch at each lookup (`ignoreAssumedRole` only on the
`--from-cfn-stack` arm), and `applyRoleArnForLocal` passes cdk-local the role
triple (`recordAssumedRole(caller, role)`) so its account lookups follow. The
assume-role hops and every workload input stay the caller's.

The `--assume-role` / `--ecr-role-arn` / `--layer-role-arn` hops are SIGNED by
the caller (cdkd's `ecr-puller.ts` hop opts out with `ignoreAssumedRole`); the
credentials a hop returns still do the pull or fetch.

## Remaining bounds

- On `start-cloudfront --from-state`, the engine's deployed S3-origin and KVS
  reads run as the caller; a cross-account deploy may need the caller's access.
- cdk-local studio's children are not embedded, so they do not carry the config.
- A `[default]` profile that sources the environment resolves whatever the
  `AWS_*` variables hold.
