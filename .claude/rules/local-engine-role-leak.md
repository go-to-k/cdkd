---
description: What cdk-local's own AWS clients resolve as the `--role-arn` role
paths:
  - 'src/cli/commands/local-state-source.ts'
  - 'src/cli/commands/local-start-*.ts'
  - 'src/cli/commands/local-run-task.ts'
---

# What the local engine resolves as role

Issue [#3130](https://github.com/go-to-k/cdkd/issues/3130)'s other half:
[local-caller-identity.md](local-caller-identity.md). Only `local-invoke`,
`local-start-api`, `local-run-task` and `local-invoke-agentcore` call
`applyRoleArnIfSet`, so nothing is restored for the four `start-*` commands. The
overwrite is cdk-local's OWN `applyRoleArnIfSet`, inside the emulator entry
point, so fixing `process.env` around the call cannot work: it returns only
after every container started.

**Reason from the RULE, not the list**: cdk-local builds its clients from the
region and `options.profile` alone, never seeing `ignoreAssumedRole`, so with
`--role-arn` set and no profile it resolves everything AS THE ROLE.

1. **The credential triple** copied into the container (`start-alb`,
   `start-cloudfront`, `start-agentcore`), gated on the `options.profile` FLAG —
   an exported `AWS_PROFILE` does NOT mitigate it. `start-service` uses the
   metadata sidecar.
2. **ECS task SECRETS** (`start-service` / `start-alb`) via cdk-local's
   `resolveEcsSecrets`; cdkd's own opts out.
3. **`${AWS::AccountId}`**: cdk-local's `resolveCallerAccountId` takes
   `options.profile` only, so the id in the container env, `secrets` refs and
   ECR URIs is the ROLE's.
4. **`--from-cfn-stack`** — `GetParameters` with `WithDecryption: true`.
   On the four cdkd-owned commands `bindCallerIdentityClients` shadows the
   provider's PRIVATE getters; `cfnProviderShapeDrift` refuses (under a role,
   no profile) any change to the reviewed member ALLOWLIST. It checks shape,
   not use: a client built inline in an existing method, or cached at module
   level, is undetectable.
5. **`--assume-role` / `--assume-task-role`** for the workload: the STS
   AssumeRole call itself is made as the role.
6. **A literal layer ARN** (`local invoke` / `start-api`): cdk-local's
   `materializeLayerFromArn` fetches the layer as the role — a residual on the
   cdkd-owned commands too.

Either profile spelling mitigates 2-6. The fix is upstream
(go-to-k/cdk-local#783); patching `CfnLocalStateProvider.prototype` would
reach only 4, so `warnEngineRoleExposure` warns at startup meanwhile.

cdkd's `--from-state` twin runs as the role **deliberately** (its
`cdkd-local-role-identity:` sites); do NOT "fix" them — the bucket name is
derived in the ROLE's account and the calls carry `ExpectedBucketOwner`, so
caller credentials 403. The four cdkd-owned commands' `${AWS::AccountId}`
follows the same reader under `--from-state` and stays the caller's under
`--from-cfn-stack` (go-to-k/cdkd#3230).
