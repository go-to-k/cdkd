---
title: "Deploy: tuning"
description: "Deploy-time tuning flags — VPC route DependsOn relaxation, observed-state capture, name prefixing, per-resource timeouts, and CDK annotation messages."
---

## VPC route DependsOn relaxation (default-on)

`cdkd deploy` drops the CDK-injected defensive `DependsOn` edges from
VPC Lambdas (and adjacent IAM Role / Policy / Lambda::Url /
EventSourceMapping resources) onto the private subnet's `DefaultRoute`
/ `RouteTableAssociation` so that downstream consumers — most notably
`CloudFront::Distribution` whose Origin is a Lambda Function URL — can
dispatch in parallel with NAT Gateway stabilization.

This is on by default. The relaxation is safe because all deploy-time
consumers of a VPC Lambda accept it in `Pending` state:
`CreateFunctionUrlConfig` / `AddPermission` / `CreateEventSourceMapping`
all succeed before ENI provisioning finishes, and cdkd's existing
post-`CreateFunction` `State=Active` wait is already moved to
`CustomResourceProvider.sendRequest` (the one consumer that synchronously
invokes the function).

To opt out:

```bash
cdkd deploy --no-aggressive-vpc-parallel
```

When you'd want to opt out: a stack with a Custom Resource that
synchronously invokes a VPC Lambda **outside** cdkd's
Lambda-ServiceToken Active wait (e.g. through SNS or via a Step
Functions task), where you want the strict CDK ordering to guarantee
the NAT route is up before the function is hit. Most stacks don't need
this — cdkd's Custom Resource provider already handles the standard
Lambda-ServiceToken case.

**Critical-path effect on a VPC + Lambda + CloudFront stack:**

| Mode | Critical path | Total |
| --- | --- | --- |
| `--no-aggressive-vpc-parallel` | NAT 2–3 min → Lambda → Lambda::Url → CF 3 min (serial) | ~6 min |
| **default** | max(NAT, CF) (parallel) | **~3 min** |

Measured −54.6% on `tests/integration/bench-cdk-sample`
(398.59s with `--no-aggressive-vpc-parallel` → 181.03s default).

Note: the "CF 3 min" leg above is the `Deployed` wait, which now
applies only under `--full-wait` — on the current default the
CloudFront leg returns in seconds and the critical path is NAT alone.
The measured numbers were taken with the then-default
`Deployed` wait; the relaxation still matters under `--full-wait` and
for the in-background propagation start time.

**Type-pair allowlist** (only DependsOn edges matching one of these
pairs are dropped — Ref / GetAtt edges and DependsOn outside the list
are untouched):

| Depender (`from`) | Dependee (`to`) |
| --- | --- |
| `AWS::IAM::Role` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::IAM::Policy` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::Lambda::Function` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::Lambda::Url` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |
| `AWS::Lambda::EventSourceMapping` | `AWS::EC2::Route` / `AWS::EC2::SubnetRouteTableAssociation` |

Implementation: [src/analyzer/cdk-defensive-deps.ts](https://github.com/go-to-k/cdkd/blob/main/src/analyzer/cdk-defensive-deps.ts) +
[src/analyzer/dag-builder.ts](https://github.com/go-to-k/cdkd/blob/main/src/analyzer/dag-builder.ts) (gated by the
`relaxCdkVpcDefensiveDeps` `DagBuilderOptions` flag, set on the deploy
code path only — destroy ordering is unaffected).

**Trade-off:** if a Lambda's async ENI provisioning fails *after* the
deploy has already started a CloudFront `CreateDistribution` against
its Function URL, the rollback has to delete both — and CloudFront
delete is also ~5 min. The opt-out exists for stacks where the user
wants to keep that worst case off the table.

The relaxation is **deploy-only**. `cdkd destroy` is unaffected — the
route DependsOn doesn't constrain delete-time correctness (Lambda
hyperplane ENI release is the actual destroy bottleneck and is
handled separately by `lambda-vpc-deps.ts`).

## `--no-capture-observed-state`

`cdkd deploy` records each resource's AWS-current properties into
`ResourceState.observedProperties` (state schema `version: 3`)
immediately after the create/update succeeds, by calling
`provider.readCurrentState()` fire-and-forget. The deploy critical path
does NOT block on these — the in-flight set is drained right before the
final state save, so the cost is roughly `max(per-resource readCurrentState
latency)`, around 200–300ms in practice. Without
this, `cdkd drift` can only compare against `properties` (= what the
user templated), and console-side changes to keys the user did not
template are silently ignored.

```bash
# Skip the observedProperties capture (default ON since v0.47.0)
cdkd deploy --no-capture-observed-state

# Pin in cdk.json so every deploy in the project skips the capture
# {
#   "context": {
#     "cdkd": { "captureObservedState": false }
#   }
# }
```

When the capture is off, drift detection falls back to the pre-`version:
3` behavior — only state-recorded properties are compared. Use the flag
when deploy speed is more important than rich drift detection. The
escape-hatch order is: `--no-capture-observed-state` (CLI) overrides
`cdk.json context.cdkd.captureObservedState` (project) overrides the
default `true`.

### v2 → v3 schema upgrade flow

When `cdkd deploy` loads state and finds resources without
`observedProperties` (typical the first time you deploy after upgrading
from cdkd <0.49 / state schema `version: 2`), it kicks off
`provider.readCurrentState` for each in parallel with the rest of the
deploy and drains the result into state at the final save. The deploy
critical path does NOT wait on these — cost is bounded by the longest
single `readCurrentState` (~200-300ms in practice), once. Subsequent
deploys are unaffected. Honors `--no-capture-observed-state` (skips
both regular capture and this upgrade refresh).

`cdkd state refresh-observed <stack>` remains the manual / non-deploy
path — useful when you want to refresh the baseline without redeploying
(e.g. for resources that won't change in any near-future deploy).

## `--prefix-user-supplied-names` (and deprecated `--no-prefix-user-supplied-names`)

cdkd creates AWS resources with the **exact name you declared** in
CDK code by default. `new iam.Role(this, 'CRRole', { roleName:
'my-role' })` in stack `MyStack` produces an AWS resource named
`my-role`, consistent across every resource type. This is the
default since **v0.94.0**.

Pre-v0.94.0 cdkd prepended the stack name to user-declared physical
names on a subset of types only (Pattern B providers: IAM Role /
User / Group / InstanceProfile / ELBv2 LoadBalancer / TargetGroup),
while Pattern A providers (Lambda, S3, SNS, SQS, DynamoDB, etc.)
used the user's name as-is. The inconsistency was opaque to users;
`cdkd export` surfaced it because the CFn IMPORT identifier
check would reject a synth template whose `RoleName: 'my-role'`
didn't match the AWS-deployed `MyStack-my-role`. Flipping the default
brings every resource type into line out of the box.

`--prefix-user-supplied-names` opts BACK in to legacy prefixing on
Pattern B providers (matching pre-v0.94.0 cdkd). Auto-generated names
(where the user did NOT declare a physical name) keep the prefix
regardless of the flag: those names rely on the prefix for cross-stack
uniqueness.

```bash
# Pass per-invocation (opt back in to legacy prefixing)
cdkd deploy --prefix-user-supplied-names

# Set per-shell
export CDKD_PREFIX_USER_SUPPLIED_NAMES=true
cdkd deploy

# Pin per-project in cdk.json
# {
#   "context": {
#     "cdkd": { "prefixUserSuppliedNames": true }
#   }
# }
```

Resolution chain (highest wins): `--prefix-user-supplied-names` CLI
flag → `CDKD_PREFIX_USER_SUPPLIED_NAMES=true` env var → `cdk.json`
`context.cdkd.prefixUserSuppliedNames: true` → default `false`
(= skip prefix, the v0.94.0 default).

### Deprecated: `--no-prefix-user-supplied-names`

The `--no-prefix-user-supplied-names` CLI flag (plus the
`CDKD_NO_PREFIX_USER_SUPPLIED_NAMES` env var and `cdk.json
context.cdkd.noPrefixUserSuppliedNames`) is still accepted but now
matches the default since v0.94.0. Setting any of them emits a
deprecation warning and has no effect on the resolved name. Pre-v0.94.0
this was how you opted in to skipping the prefix; that opt-in is now
the default.

Remove the flag / env var / cdk.json entry from your config. If you
need to RESTORE pre-v0.94.0 legacy prefixing (e.g. migrating an
existing stack without replacement), use the new
`--prefix-user-supplied-names` opposite-direction flag instead.

### Granularity, storage, mid-flight reversibility

- **Granularity**: per-deploy. The flag is consulted once at command
  start and applied to every per-resource name generation in that
  deploy via an `AsyncLocalStorage`-scoped value.
- **Storage**: the flag controls **what AWS resource cdkd asks AWS to
  create**, not what cdkd records in state — once the AWS resource is
  named, the same name is recorded as `physicalId` in state. Flipping
  the flag after the fact does NOT rename an already-deployed resource.
- **Mid-flight reversibility**: flipping the flag on an existing stack
  causes the next deploy to propose REPLACEMENT on every Pattern B
  resource (IAM Role / User / Group / InstanceProfile / ELBv2 LB / TG)
  that uses a user-declared name — the existing AWS resource has one
  name; the new template intent has the other. The v0.94.0 default
  flip is a one-time instance of this: upgrading from a pre-v0.94.0
  cdkd against an existing stack will propose replacement unless you
  pin `--prefix-user-supplied-names`.

### Affected resource types

The flag only changes behavior for resource types whose pre-v0.94.0
code path prefixed user-supplied names (Pattern B providers). Pattern A
providers were always unprefixed and are unchanged by the flag.

| Pattern | New default (v0.94.0+) | `--prefix-user-supplied-names` (legacy opt-in) |
| --- | --- | --- |
| **Pattern B**: IAM Role, IAM User, IAM Group, IAM InstanceProfile, ELBv2 LoadBalancer, ELBv2 TargetGroup | Unprefixed (`my-role`) | Prefixed (`MyStack-my-role`) |
| **Pattern A**: Lambda Function, S3 Bucket, SNS Topic, SQS Queue, DynamoDB Table, Logs LogGroup, Events Rule, etc. | Unprefixed (`my-bucket`) | No effect (already unprefixed) |
| Auto-generated names (any type, no user-supplied physical name) | Prefixed (`MyStack-LogicalId-<hash>`) | No effect — prefix kept for uniqueness |

### Migration from pre-v0.94.0

For a stack already deployed under the pre-v0.94.0 default (Pattern B
resources have stack-name-prefixed physical names in AWS), the first
`cdkd deploy` on v0.94.0+ proposes REPLACEMENT on every Pattern B
resource — the AWS-deployed name `MyStack-my-role` no longer matches
the new template intent `my-role`. Three options, listed by preference:

1. **Pin `--prefix-user-supplied-names`** to keep the legacy behavior
   for that stack. Most conservative — no AWS resources touched.
2. **Accept the one-time REPLACEMENT** — the deploy-time pre-flight
   prompt (see next subsection) lists every affected resource and
   defaults to *no*, so the side effect is explicit.
3. **Drop the explicit `roleName` / `userName` / ...** in CDK code,
   letting CDK auto-generate the name. Also a one-time REPLACEMENT,
   but the new name is then stable across future deploys.

A state-side rename helper (`cdkd state rename-strip-prefix <stack>`)
that would migrate state to match AWS without REPLACEMENT is planned
but not yet implemented.

### Migration: deploy-time warning when the flag flips an existing stack

Flipping `--no-prefix-user-supplied-names` on against a stack already
deployed under the legacy prefix convention causes cdkd's diff path to
silently propose REPLACEMENT on every affected Pattern B resource —
the AWS-deployed name is `MyStack-my-role` and the new template intent
is `my-role`, so the diff classifies the name as an immutable property
change and the resource is destroyed and re-created. To make this side
effect visible up front, `cdkd deploy` runs a pre-flight migration
check: when the flag is on AND the existing state contains one or
more Pattern B resources whose recorded `physicalId` is EXACTLY the
legacy auto-prefixed form of the user-supplied name
(`${stackName}-${userSuppliedName}`), the command lists them and prompts
for confirmation before any provider call runs. The exact-match test (not
a bare "starts with `${stackName}-`") is deliberate: a user-supplied name
that itself starts with the stack name — e.g. setting `roleName` to
`${this.stackName}-role`, a common convention — is taken verbatim, so its
`physicalId` already equals the user name. There is no rename and no
replacement, so it is NOT flagged (a bare prefix-strip would otherwise
mis-predict `MyStack-role` to `role` and block routine in-place updates).
The prompt defaults to **no** because
the side effect is destructive; pass `-y` / `--yes` (the global CDK
CLI parity flag) to skip the prompt in CI / non-interactive runs. If
the user declines, the deploy exits cleanly with `no resources
modified` — nothing has been touched yet.

The check runs on the state cdkd reads immediately after acquiring the
stack lock (it does not issue a second, pre-lock read of the same
object), so the stack lock is briefly held while the prompt is open and
is released as soon as it is answered either way. Reading under the lock
also means the check sees exactly the state the diff will consume — no
concurrent deploy can change it in between.

Example output:

```text
WARNING: --no-prefix-user-supplied-names will REPLACE 2 resource(s) whose
AWS physical name is still prefixed with the stack name:
  - MyRole (AWS::IAM::Role): MyStack-my-role -> my-role
  - MyLb (AWS::ElasticLoadBalancingV2::LoadBalancer): MyStack-my-lb -> my-lb
These resources will be REPLACED because the new naming convention drops
the stack-name prefix.

Continue? (y/N):
```

The check is a no-op on a first-time deploy (no state to migrate),
when no Pattern B resource is still prefixed (e.g. the stack was
originally deployed with the flag on), or when the flag is off.

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

When the user passes `--resource-timeout` (global or per-type) shorter
than the inherited 5m `--resource-warn-after` default and does NOT pass
a matching `--resource-warn-after`, cdkd auto-lowers the warn-after to
`min(5m, 0.5 * timeout)` and emits a `WARN` log line naming the lowered
value. This closes the UX gap where a `--resource-timeout 2m` invocation
would otherwise fail every resource at runtime with
`InvalidResourceDeadlineError: warnAfterMs must be less than timeoutMs`.
Passing both flags explicitly disables the auto-lowering — a reversed
explicit pair is a hard parse-time error.

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

Both DynamoDB types (`AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable`)
self-report 30 minutes for the same reason — their DELETE path stacks
several polling waits (replica removal, an index-settle gate, an
index-busy `DeleteTable` retry, a confirm-gone wait) that share ONE
allowance sized to fit inside it. At the default `--resource-timeout 30m`
this changes nothing. Note the self-report is per TYPE, not per
operation, so lowering the global default below 30m for fail-fast CI
(`--resource-timeout 5m`) does NOT shorten these types' CREATE or UPDATE
deadline either; the per-type override
(`--resource-timeout AWS::DynamoDB::Table=5m`) is the way to get the
shorter deadline back.

A handful of resource types are ALSO known to be slow to create or
delete regardless of provider — an `AWS::OpenSearchService::Domain`
deletion routinely runs 15-30 minutes, and Redshift / ElastiCache / RDS
clusters are the same class. cdkd carries a built-in 60-minute floor for
these (`src/provisioning/slow-cc-operation-timeouts.ts`), folded into the
same `max(...)` resolution above, so a default `cdkd destroy` waits long
enough for the delete to actually finish instead of aborting mid-delete.
The same floor lifts the Cloud Control provider's internal poll cap (a
flat 15 minutes otherwise), so a Cloud-Control-routed slow delete is not
cut off before the outer deadline. An explicit
`--resource-timeout <TYPE>=<DURATION>` override still wins.

The flag reaches SDK-provider inner waiters the same way: under
`--full-wait`, the ECS Service steady-state waiter's 600s cap is lifted
to `max(600s, resolved --resource-timeout)` and the CloudFront
Distribution `Deployed` wait budget to `max(20min, resolved
--resource-timeout)` (see [`--full-wait`](cli-deploy.md#full-wait)), so the inner
waiters can never abort before the outer per-resource deadline the same
flag raised.

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

## CDK annotation messages (synth + deploy)

`cdkd synth` and `cdkd deploy` surface CDK `Annotations` messages with the
same semantics as the CDK CLI:

- `Annotations.of(scope).addError(...)` — the command prints every error as
  `[Error at /Construct/Path] message`, appends `Found errors`, and exits
  non-zero **without deploying anything**. `deploy` checks the final
  selection (including auto-included dependency stacks) before any AWS
  mutation, and an error annotation on a stack **outside** the selection
  does not block the deploy — matching `cdk deploy` semantics.
- `addWarning(...)` / `addInfo(...)` — printed as
  `[Warning at /path] ...` / `[Info at /path] ...`; the run proceeds.

Two flags adjust the failure threshold (CDK CLI parity —
both accepted by `synth` and `deploy`):

- `--strict` — additionally fail when any warning annotation exists
  (`Found warnings (--strict mode)`, non-zero exit). Info messages never
  fail. Errors still fail with `Found errors` (the error check wins when
  both exist).
- `--ignore-errors` — display every message but never fail the run
  ("Ignores synthesis errors, which will likely produce an invalid
  deployment" — same caveat as the CDK CLI flag). When combined with
  `--strict`, strict wins and warnings/errors fail again (CDK CLI
  precedence).

`cdkd synth` checks every synthesized stack (it has no stack selection).
Other synth-driven commands (`diff`, `list`, `import`, ...) do not fail on
error annotations, matching the upstream CLI. Both cloud-assembly metadata
layouts are supported: the inline `manifest.json` `metadata` field written
by older aws-cdk-lib versions and the `<artifactId>.metadata.json` side
file (`additionalMetadataFile`) written by current versions.
