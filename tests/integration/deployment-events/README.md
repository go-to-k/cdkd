# deployment-events

Integration test fixture for cdkd structured **deployment events** (issue
[#808](https://github.com/go-to-k/cdkd/issues/808)) — cdkd's local equivalent
of CloudFormation's `DescribeStackEvents`, plus the `cdkd events` command that
reads them back.

## Background

When a `cdkd deploy` / `cdkd destroy` run happens, cdkd appends one JSONL line
per lifecycle event (`RUN_STARTED` / `RUN_FINISHED`, per-resource
`RESOURCE_STARTED` / `RESOURCE_SUCCEEDED` / `RESOURCE_FAILED`, rollback steps)
to a **separate S3 key family from `state.json`**:

```
s3://{bucket}/cdkd/{stackName}/{region}/deployments/{runId}.jsonl   # one per run
s3://{bucket}/cdkd/{stackName}/{region}/deployments/index.json      # last N runs, newest first
```

Because the key family is separate, **event files survive `cdkd destroy`** —
a destroyed stack's run history (including the destroy run itself) stays
readable via `cdkd events`. There is **no state schema bump** (state stays at
its current version); the change is fully backward compatible.

Two #808 guarantees this fixture exercises end-to-end:

- **Events persist independently of state.** After `destroy`, `state.json` is
  gone but the `deployments/` sidecar is still there and now carries the
  destroy run's own `{runId}.jsonl`.
- **No resource properties / secrets in events.** Events carry error +
  metadata only — properties live in `state.json`, never in the events
  sidecar. The fixture's SSM parameter value is a marker
  (`events-integ-secret-value`) that `verify.sh` asserts NEVER appears in the
  `cdkd events --format json` output.

## Fixture

A tiny, fast-to-deploy/destroy stack (`CdkdDeploymentEventsExample`) with two
cheap resources (no VPC / NAT):

- `AWS::SNS::Topic` (`CdkdDeploymentEventsExample-topic`)
- `AWS::SSM::Parameter` (`CdkdDeploymentEventsExample-marker`), whose value is
  the secret-shaped marker used by the no-secrets assertion.

## Automated run (`verify.sh`)

Env: `AWS_REGION` (default `us-east-1`), `STATE_BUCKET` (required).

1. Install + build cdkd (root) + fixture deps (`pnpm install --ignore-workspace`).
2. `cdkd deploy CdkdDeploymentEventsExample`.
3. Assert deploy wrote the events sidecar: at least one
   `deployments/{runId}.jsonl` AND `deployments/index.json`.
4. `cdkd events CdkdDeploymentEventsExample --stack-region <region>` lists a
   `deploy` run as `SUCCEEDED`; `--format json` is valid JSON carrying
   `RUN_STARTED` / `RUN_FINISHED` + at least one `RESOURCE_*` event for the
   topic/parameter; the secret marker does NOT appear anywhere in the output.
5. `cdkd destroy CdkdDeploymentEventsExample --force`.
6. Assert `state.json` is gone but the events sidecar is still readable and now
   has `>= 2` `{runId}.jsonl` (deploy + destroy); `cdkd events ... --format
   json` lists BOTH a deploy and a destroy run.
7. Remove the events sidecar (`aws s3 rm s3://$STATE_BUCKET/cdkd/$STACK/
   --recursive`) so the integ leaves nothing behind (also on the failure path
   via an EXIT trap).

```bash
STATE_BUCKET=cdkd-state-<accountId> \
  bash tests/integration/deployment-events/verify.sh
```

Run it via `/run-integ deployment-events` like any other fixture.

## The `cdkd events` flags used

```bash
# Run listing (human + JSON)
cdkd events CdkdDeploymentEventsExample --state-bucket "$STATE_BUCKET" --stack-region "$REGION"
cdkd events CdkdDeploymentEventsExample --state-bucket "$STATE_BUCKET" --stack-region "$REGION" --format json

# One run's full ordered event stream as JSON
cdkd events CdkdDeploymentEventsExample --state-bucket "$STATE_BUCKET" --stack-region "$REGION" --run <runId> --format json
```

`--stack-region` is passed explicitly for determinism; with no `--stack-region`
the command auto-discovers the region from the `deployments/` key listing (so
it works even for destroyed stacks). `--format json` is equivalent to `--json`.

## What this fixture does NOT cover

- The **failure path** (`RESOURCE_FAILED` / `ROLLBACK_*` events). This fixture
  is the happy-path / no-secrets / survives-destroy coverage; a deliberately
  failing variant (e.g. `CDKD_TEST_FAIL`-style injection) is a possible
  follow-up.
- The index-fallback path (`UNKNOWN` result when `index.json` is missing /
  corrupt) — covered by unit tests, not here.
