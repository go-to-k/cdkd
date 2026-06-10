# Remove-Protection E2E Test

Real-AWS end-to-end test for `cdkd destroy --remove-protection` (PR #205,
shipped in v0.59.0).

The unit-test matrix in `tests/unit/provisioning/remove-protection.test.ts`
is extensive but does not exercise the bypass path against AWS — and PR
#205 introduced **breaking semantics** for RDS / Cognito UserPool (silent
bypass converted to opt-in). This fixture verifies, on real AWS, that:

1. With protection enabled, a bare `cdkd destroy --force` is **rejected**
   (per-resource AWS errors → `PartialFailureError` exit 2).
2. State is preserved (the rejected destroy is not silently partial).
3. `cdkd destroy --remove-protection --force` flips the protection off
   and successfully deletes every resource.

## What it covers

One resource per supported protection mechanism (RDS deliberately out
of scope — see "Why no RDS" below):

| Resource | Protection field |
|---|---|
| `AWS::Logs::LogGroup` | `DeletionProtectionEnabled: true` |
| `AWS::DynamoDB::Table` | `DeletionProtectionEnabled: true` |
| `AWS::Cognito::UserPool` | `DeletionProtection: 'ACTIVE'` (BREAKING — was silently bypassed pre-#205) |
| `AWS::EC2::Instance` | `DisableApiTermination: true` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` (ALB) | `LoadBalancerAttributes.deletion_protection.enabled = true` |
| `AWS::AutoScaling::AutoScalingGroup` | `DeletionProtection: 'prevent-all-deletion'` (new SDK provider — never deployed via cdkd before #205). Launches one `t3.nano` whose launch template sets `DisableApiTermination: true`, so the bypass must also flip EC2-level termination protection off on the launched instance before `ForceDelete` (regression target for #796). verify.sh captures the instance id post-deploy and asserts it terminates post-destroy. |

Stack-level `terminationProtection` is intentionally **not** exercised
here — its bypass path is unit-tested end-to-end in
`tests/unit/cli/destroy.test.ts`, and adding it to this integ would
mix two semantically distinct bypasses under the same flag.

## Why no RDS

`AWS::RDS::DBInstance` and `AWS::RDS::DBCluster` create takes 10-15
min and delete another 10-15 min. A 30-min round trip per integ run
is too expensive for routine CI / repeat runs given the rest of the
test completes in ~5 min. RDS bypass relies on the same provider
plumbing as the other types (`DeleteContext.removeProtection` flag,
idempotent `Modify` flip-off in `delete()`, exit-2 partial failure on
the negative path) covered comprehensively at the unit-test level.

## Run

```bash
bash tests/integration/remove-protection/verify.sh
```

Resolves the AWS account ID via `aws sts get-caller-identity` and the
state bucket as `cdkd-state-${accountId}` (override via the
`STATE_BUCKET` env var).

On any assertion failure the cleanup trap re-attempts
`cdkd destroy --remove-protection --force` so a botched run does not
leak ALB / EC2 / ASG / Cognito UserPool resources.

## Resource count + timing

- Deploy: ~5 min (ALB ENI provisioning is the long pole; EC2 / ASG
  scale-down to 0 keep the rest fast)
- Negative destroy: ~30s (every per-resource delete fails fast with
  AWS's protection rejection)
- Positive destroy: ~5 min (ALB delete is the long pole again)
- Total: ~10-12 min per integ run
