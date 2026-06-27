# dynamodb-autoscaling

A provisioned DynamoDB table with read + write Application Auto Scaling — a very
common daily CDK pattern that had no integ coverage. CDK synthesizes:

- `AWS::DynamoDB::Table` (PROVISIONED, read/write capacity 5)
- `AWS::ApplicationAutoScaling::ScalableTarget` x2 (read + write, min 5)
- `AWS::ApplicationAutoScaling::ScalingPolicy` x2 (TargetTracking, 70%)

The Application Auto Scaling types have **no dedicated cdkd SDK provider**, so
they route through the Cloud Control API fallback. The `ScalingPolicy`
references the `ScalableTarget`, whose CFn `Ref` returns a compound id
(`service-namespace|resource-id|scalable-dimension`) — the compound-id Ref
hazard cdkd previously hit on ApiGateway / AppConfig. This fixture is the
regression guard for that path.

## What it verifies

1. **Phase 1 (deploy)** — both ScalableTargets (min 5 / max 10) and both
   TargetTracking ScalingPolicies (70%) are created in Application Auto Scaling.
2. **Phase 2 (UPDATE, `CDKD_TEST_UPDATE=true`)** — raising MaxCapacity 10 -> 20
   is an in-place Cloud Control patch on both dimensions; the table is **not**
   replaced (CreationDateTime unchanged).
3. **Phase 3 (destroy)** — all ScalableTargets are deregistered and the cdkd
   state file is removed.

## Run

```bash
/run-integ dynamodb-autoscaling
```
