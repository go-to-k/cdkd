# cdkd CLI Reference

This document covers cdkd-specific CLI flags that need more detail than
fits in the README. For the basic command invocations (`deploy`, `diff`,
`destroy`, `synth`, `list`, `state`, etc.), see the
[Usage](../README.md#usage) section of the README.

## Concurrency

cdkd parallelizes asset publishing, stack deployment, and per-stack
resource provisioning. Each level has its own concurrency knob.

| Option | Default | Description |
| --- | --- | --- |
| `--concurrency` | 10 | Maximum concurrent resource operations per stack |
| `--stack-concurrency` | 4 | Maximum concurrent stack deployments |
| `--asset-publish-concurrency` | 8 | Maximum concurrent asset publish operations (S3 + ECR push) |
| `--image-build-concurrency` | 4 | Maximum concurrent Docker image builds |

## `--no-wait`

By default, cdkd waits for async resources (CloudFront Distribution,
RDS Cluster/Instance, ElastiCache, NAT Gateway) to reach a ready
state before completing — the same behavior as CloudFormation.

Use `--no-wait` to skip this and return immediately after resource
creation:

```bash
cdkd deploy --no-wait
```

This can significantly speed up deployments. The resource is fully
functional once AWS finishes the async deployment.

| Resource type | Default behavior | `--no-wait` behavior |
| --- | --- | --- |
| `AWS::CloudFront::Distribution` | Wait for `Deployed` status (3–15 min) | Return after `CreateDistribution` |
| `AWS::RDS::DBCluster` / `AWS::RDS::DBInstance` | Wait for `available` status (5–10 min) | Return after Create call |
| `AWS::ElastiCache::CacheCluster` etc. | Wait for `available` status | Return after Create call |
| `AWS::EC2::NatGateway` | Wait for `available` state (1–2 min) | Return after `CreateNatGateway` (gateway is `pending`; AWS finishes async) |

For NAT Gateway specifically: `CreateNatGateway` returns the
`NatGatewayId` immediately, so dependent Routes that only need the ID
proceed against a still-`pending` gateway. `--no-wait` is safe when
nothing in the deploy flow needs actual NAT-routed egress (no Lambda
invoked during deploy that hits the internet, etc.).

`--no-wait` is **deploy-only**. `cdkd destroy` does not accept it,
because no destroy code path benefits — NAT Gateway destroy
unconditionally waits for `deleted` state to keep teardown ordered
(a still-`deleting` gateway blocks `DeleteSubnet` /
`DeleteInternetGateway` / `DeleteVpc` with `DependencyViolation`
until its ENI / EIP / route associations release), and the other
`--no-wait`-eligible resources (CloudFront / RDS / ElastiCache) are
leaves on the destroy DAG so their providers don't wait there to
begin with.

`--no-wait` only skips *convenience* waits for resources that don't
block siblings within the same deploy. There is one exception that
runs unconditionally regardless of `--no-wait`: a Lambda-backed
`AWS::CloudFormation::CustomResource` waits for its **backing Lambda**
(the ServiceToken Lambda) to reach `Configuration.State === 'Active'`
and `LastUpdateStatus === 'Successful'` immediately before the
synchronous Invoke. Without that wait, an Invoke against a still-Pending
function fails with `The function is currently in the following state:
Pending` (CFn parity). The wait is scoped to the Custom Resource Invoke
itself; ordinary Lambda CREATE / UPDATE returns as soon as the SDK call
returns, so VPC Lambdas with no synchronous downstream consumer don't
block the deploy DAG on the 5–10 min ENI attach window.

## Per-resource timeout

Both `cdkd deploy` and `cdkd destroy` (including `cdkd state destroy`)
enforce a wall-clock deadline on every individual CREATE / UPDATE /
DELETE so a stuck Cloud Control polling loop, hung Custom Resource
handler, or slow ENI release cannot block the run forever.

| Option | Default | Description |
| --- | --- | --- |
| `--resource-warn-after <duration_or_type=duration>` | `5m` | Warn when a single resource operation has been running longer than this. The live progress line is suffixed with `[taking longer than expected, Nm+]` and a `WARN` log line is emitted (printed above the live area in TTY mode, plain stderr otherwise). Repeatable. |
| `--resource-timeout <duration_or_type=duration>` | `30m` | Abort a single resource operation that exceeds this. The deploy / destroy fails with `ResourceTimeoutError` (wrapped in `ProvisioningError`) and the existing rollback / state-preservation path runs. Repeatable. |

Durations are written as `<number>s`, `<number>m`, or `<number>h`
(e.g. `30s`, `90s`, `5m`, `1.5h`). Zero, negative, missing-unit, and
unknown-unit values are rejected at parse time.

Both flags accept either form on each invocation:

- **Bare duration** (`30m`) sets the global default. The last bare value wins.
- **`TYPE=DURATION`** (`AWS::CloudFront::Distribution=1h`) adds a per-resource-type override that supersedes the global default for that type only.

`TYPE` must look like `AWS::Service::Resource`; malformed types are
rejected at parse time. `warn < timeout` is enforced both globally and
per-type — so `--resource-warn-after AWS::X=10m --resource-timeout AWS::X=5m`
is a parse-time error.

```bash
# Surface "still running" warnings sooner on a fast-feedback dev loop
cdkd deploy --resource-warn-after 90s --resource-timeout 10m

# Keep the global default tight, raise it only for resources known to take longer
cdkd deploy \
  --resource-timeout 30m \
  --resource-timeout AWS::CloudFront::Distribution=1h \
  --resource-timeout AWS::RDS::DBCluster=1h30m

# Force Custom Resources to abort earlier than their 1h self-reported polling cap
cdkd deploy --resource-timeout AWS::CloudFormation::CustomResource=5m
```

### Why the default is 30m, not 1h

cdkd's Custom Resource provider polls async handlers
(`isCompleteHandler` pattern) for up to one hour before giving up.
Setting the per-resource timeout to 1h by default would make a single
hung non-CR resource hold the whole stack for an hour even though no
other resource type ever needs more than a few minutes. The 30m global
default catches stuck operations faster.

For Custom Resources specifically, the provider self-reports its 1h
polling cap to the engine via the `getMinResourceTimeoutMs()`
interface — the deploy engine resolves the per-resource budget as
`max(provider self-report, --resource-timeout global)`, so CR resources
get their full hour automatically without the user having to remember
`--resource-timeout 1h`. To force CR to abort earlier than its
self-reported cap, pass an explicit per-type override
(`--resource-timeout AWS::CloudFormation::CustomResource=5m`). Per-type
overrides always win over the provider's self-report — they're the
documented escape hatch.

The error message on timeout names the resource, type, region, elapsed
time, and operation, and reminds you that long-running resources
self-report their needed budget — when you see CR time out, the cause
is genuinely the handler, not too-tight a default:

```text
Resource MyBucket (AWS::S3::Bucket) in us-east-1 timed out after 30m during CREATE (elapsed 30m).
This may indicate a stuck Cloud Control polling loop, hung Custom Resource, or
slow ENI provisioning. Re-run with --resource-timeout AWS::S3::Bucket=<DURATION>
to bump the budget for this resource type only, or --verbose to see the
underlying provider activity.
```

Note: `--resource-warn-after` must be less than `--resource-timeout`.
Reversed values are rejected at parse time.

## Exit codes

cdkd commands distinguish three outcomes via the process exit code so
CI / bench scripts can react without grepping log output:

| Exit | Meaning | Emitted by |
| --- | --- | --- |
| `0` | Success — command completed and no resources are in an error state | All commands |
| `1` | Command-level failure — auth error, bad arguments, synth crash, unhandled exception | All commands (default for any thrown error) |
| `2` | **Partial failure** — work completed but one or more resources failed; state.json is preserved and re-running typically resolves it | `cdkd destroy`, `cdkd state destroy` (when one or more per-resource deletes fail) |

The implementation hangs off a `PartialFailureError` class in
`src/utils/error-handler.ts`. `handleError` reads the error's
`exitCode` property (defaults to 2 for `PartialFailureError`), so
callers cannot accidentally collapse the partial-failure case into the
general `1` bucket by re-throwing through `withErrorHandling`.

When exit `2` is emitted, the per-stack summary line in the run log
also switches glyphs:

```text
✓ Stack X destroyed (N deleted, 0 errors)                       # exit 0
⚠ Stack X partially destroyed (N deleted, M errors). State preserved — re-run 'cdkd destroy' / 'cdkd state destroy' to clean up.   # exit 2
```

If your bench / CI script previously treated any non-zero from `cdkd
destroy` as a hard failure (because it never had a non-zero outcome
before), you may now want to branch on `2` separately to schedule a
retry instead of paging.
