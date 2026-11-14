# cc-nested-create-only-update

cdkd integration test for a Cloud Control update inside an object property
holding a NESTED create-only path ([#6294](https://github.com/go-to-k/cdkd/issues/6294)).

`AWS::Route53::HealthCheck` has no SDK provider, so it goes through Cloud
Control. `HealthCheckConfig.MeasureLatency` is create-only, and this fixture
leaves it undeclared, so AWS defaults it to `false`. Cloud Control applies a
patch to the model it READS. Before the fix, a change to any member of
`HealthCheckConfig` was sent as `replace /HealthCheckConfig` with the template's
object, which drops `MeasureLatency`. Cloud Control read that as a create-only
change and refused the whole update. CloudFormation applies the same template
change in place. The fix reads the live model once and carries each nested
create-only member the template omits into the op.

## What it covers

- `AWS::Route53::HealthCheck`

## Phases

1. **Deploy** Port 8443 / FailureThreshold 5. Assert both are live,
   `MeasureLatency` is `false`, and the record routed through Cloud Control
   (`provisionedBy: cc-api`).
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` (Port 443 / FailureThreshold 4).
   Assert the deploy succeeds **in place** (same health check id) and both
   values reached AWS. A pre-fix run fails this deploy.
3. **Destroy**. Assert the health check and the cdkd state file are gone.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```
