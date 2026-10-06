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
`applyRoleArnIfSet`; nothing is restored for the four `start-*` commands, whose
overwrite is cdk-local's OWN `applyRoleArnIfSet` inside the emulator entry
point — it returns only after every container started.

**Reason from the RULE, not the list**: cdk-local builds its clients from the
region and `options.profile` alone (no `ignoreAssumedRole`), so with
`--role-arn` and no profile it resolves everything AS THE ROLE.

1. **The credential triple** copied into the container (`start-alb`,
   `start-cloudfront`, `start-agentcore`), gated on the `options.profile` FLAG
   (`AWS_PROFILE` does NOT mitigate it). `start-service` uses the
   metadata sidecar.
2. **ECS task SECRETS** (`start-service` / `start-alb`) via cdk-local's
   `resolveEcsSecrets`; cdkd's own opts out.
3. **`${AWS::AccountId}`**: cdk-local's `resolveCallerAccountId` takes
   `options.profile` only: the id in the env, `secrets` refs and ECR URIs.
4. **`--from-cfn-stack`** — `GetParameters` with `WithDecryption: true`.
   On the four cdkd-owned commands `bindCallerIdentityClients` shadows the
   provider's PRIVATE getters; `cfnProviderShapeDrift` refuses (under a role,
   no profile) any change to the reviewed member ALLOWLIST — shape, not use: a
   client built inline or cached at module level is undetectable.
5. **`--assume-role` / `--assume-task-role`** for the workload: the STS
   AssumeRole call is made as the role.
6. **A literal layer ARN** (`local invoke` / `start-api`): cdk-local's
   `materializeLayerFromArn` fetches it as the role, cdkd-owned commands too.
7. **A `{{resolve:...}}` lookup**: cdk-local's resolver takes `profile` only.
   cdkd-owned commands build its clients as the caller
   (`src/local/dynamic-reference.ts`, #2056).

Either profile spelling mitigates 2-7. The fix is upstream
(go-to-k/cdk-local#783); patching `CfnLocalStateProvider.prototype` would
reach only 4, so `warnEngineRoleExposure` warns at startup meanwhile.

cdkd's `--from-state` twin runs as the role **deliberately** (its
`cdkd-local-role-identity:` sites); do NOT "fix" them — the bucket name is
derived in the ROLE's account and the calls carry `ExpectedBucketOwner`, so
caller credentials 403. The four cdkd-owned commands' `${AWS::AccountId}`
follows the same reader under `--from-state` and stays the caller's under
`--from-cfn-stack` (go-to-k/cdkd#3230).
