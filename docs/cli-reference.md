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
RDS Cluster/Instance, ElastiCache, NAT Gateway, Lambda MicroVM Image)
to reach a ready state before completing — the same behavior as
CloudFormation.

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
| `AWS::DocDB::DBCluster` / `AWS::DocDB::DBInstance` | Wait for `available` status (5–10 min) | Return after Create call |
| `AWS::Neptune::DBCluster` / `AWS::Neptune::DBInstance` | Wait for `available` status (5–10 min) | Return after Create call |
| `AWS::ElastiCache::CacheCluster` etc. | Wait for `available` status | Return after Create call |
| `AWS::CertificateManager::Certificate` | Wait for `ISSUED` (DNS/EMAIL validation) | Return after `RequestCertificate` (cert is `PENDING_VALIDATION`; downstream CloudFront/ALB fail until it issues) |
| `AWS::EC2::NatGateway` | Wait for `available` state (1–2 min) | Return after `CreateNatGateway` (gateway is `pending`; AWS finishes async) |
| `AWS::Lambda::MicrovmImage` | Wait for `CREATED` (the Firecracker snapshot build; several minutes) | Return after `CreateMicrovmImage` (image is `CREATING`; the build finishes async). The image ARN is resolved before the wait, so outputs still work. Only the SDK provider honors this — the Cloud Control fallback always polls to a terminal state |

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
invokes the function — see PR #121 follow-up).

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

Implementation: [src/analyzer/cdk-defensive-deps.ts](../src/analyzer/cdk-defensive-deps.ts) +
[src/analyzer/dag-builder.ts](../src/analyzer/dag-builder.ts) (gated by the
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
default since **v0.94.0** ([#299](https://github.com/go-to-k/cdkd/issues/299)).

Pre-v0.94.0 cdkd prepended the stack name to user-declared physical
names on a subset of types only (Pattern B providers: IAM Role /
User / Group / InstanceProfile / ELBv2 LoadBalancer / TargetGroup),
while Pattern A providers (Lambda, S3, SNS, SQS, DynamoDB, etc.)
used the user's name as-is. The inconsistency was opaque to users;
`cdkd export` (PR #285) surfaced it because the CFn IMPORT identifier
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
that would migrate state to match AWS without REPLACEMENT is tracked
in [#300](https://github.com/go-to-k/cdkd/issues/300) and not yet
implemented.

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

## `--allow-unsupported-types` (deploy + destroy)

cdkd rejects genuinely-unsupported resource types at **pre-flight** —
before any resource is touched — instead of letting them fail mid-deploy
with an opaque Cloud Control error. A type is "unsupported" when AWS
reports it as `ProvisioningType: NON_PROVISIONABLE` (the provider-coverage
**Tier 3** set: Cloud Control API cannot create/update/delete it) AND cdkd
has no SDK provider for it. The Tier 3 set is generated from the audit
cache into the runtime at `src/provisioning/unsupported-types.generated.ts`
(`vp run gen:unsupported-types`; CI fails if it drifts).

When pre-flight hits one, the error names each type, the reason, a 1-click
pre-filled GitHub issue link to request support, and the exact re-run
command:

```text
The following resource types are not supported by cdkd:
  - AWS::AppMesh::Mesh
      AWS reports this type as NON_PROVISIONABLE (Cloud Control API cannot
      manage it) and cdkd has no SDK provider for it.
      Request support: https://github.com/go-to-k/cdkd/issues/new?title=...

To attempt deployment anyway (Cloud Control will likely fail for
NON_PROVISIONABLE types), re-run with: --allow-unsupported-types AWS::AppMesh::Mesh
```

`--allow-unsupported-types <types>` is the **escape hatch**: a
comma-separated (and repeatable) list of types to attempt via Cloud
Control anyway. It is per-type rather than a blanket override so you
explicitly acknowledge each type. Useful mainly for a type the cached
audit marks Tier 3 that AWS has since made provisionable (regenerate the
audit with `vp run audit:coverage:regenerate` for the permanent fix). It
is available on both `cdkd deploy` and `cdkd destroy` (and `cdkd state
destroy`) so a stack deployed with the flag can also be torn down.

```bash
cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget
cdkd destroy MyStack --allow-unsupported-types AWS::AppMesh::Mesh,AWS::Budgets::Budget
```

## `--allow-unsupported-properties` (deploy)

When a CDK template uses a **top-level CFn property** that cdkd's SDK
provider would silently drop on write (e.g. AWS adds `RecursiveLoop` to
`AWS::Lambda::Function`, CDK adds support, you write it in your CDK code,
but `LambdaFunctionProvider.create()` does not read it yet), cdkd **auto-routes
the resource through Cloud Control API** by default (issue #614). Cloud
Control forwards the full property map to AWS verbatim, so the silent
drop is closed without any user intervention — the field reaches AWS.

The routing decision is recorded on the resource's state record as
`provisionedBy: 'cc-api'` and stays sticky for the resource's lifetime
(`cdkd drift`, `cdkd destroy`, etc. route through the same layer that
created it — even if cdkd later adds first-class SDK provider support
for the property). `cdkd state show <stack>` displays the
`ProvisionedBy:` field so you can audit which layer owns each resource.

The set of handled vs silently-dropped properties is generated from the
CFn schema fixtures + each SDK provider's `handledProperties` /
`unhandledByDesign` declarations into the runtime at
`src/provisioning/property-coverage.generated.ts` (`vp run gen:property-coverage`;
CI fails if it drifts). Coverage is per Tier 1 (SDK provider) type only —
Tier 2 (Cloud Control fallback) types already forward the full property
map to AWS, so the auto-route is a no-op for them.

When the auto-route fires, cdkd logs an info line per affected resource:

```text
[info] MyLambda (AWS::Lambda::Function): routing via Cloud Control API
       (cdkd's SDK Provider does not yet wire RecursiveLoop — CC API will
        forward the full property map. Override via
        --allow-unsupported-properties AWS::Lambda::Function:RecursiveLoop.)
```

### `--allow-unsupported-properties <entries>` (override)

The flag is the **opt-out** from the default CC auto-route. Each entry
is a `<ResourceType>:<PropertyName>` token (comma-separated and
repeatable); the flag pins the resource to the SDK provider path and
**accepts the silent drop** for the named property. A warn line is
logged so the silent drop is auditable.

```bash
cdkd deploy MyStack --allow-unsupported-properties AWS::Lambda::Function:RecursiveLoop,AWS::Lambda::Function:RuntimeManagementConfig
```

Per type+property pair (not blanket) so you explicitly acknowledge each
silent drop. The flag is `deploy`-only — destroy uses the per-resource
physical ID and the state-recorded `provisionedBy` layer, not the
template properties.

Properties that do not appear in the CFn schema pass through silently —
these are usually `addPropertyOverride` escape hatches or typos, both of
which CFn itself tolerates. Read-only properties (AWS-managed Arns, Ids,
etc.) also pass through silently; you cannot set them from the template
side and they are no-ops if they appear there.

### When to use the override flag (auto-route opt-out guidance)

The auto-route is the default because silent drop is a real bug class
(the deployed resource is missing fields the user wrote). Cloud Control
closes the bug by forwarding the full property map. The flag is the
**opt-out** for situations where you specifically want the SDK provider
path even at the cost of the silent drop.

#### Use the flag when

- **You need the SDK provider's fast synchronous-AWS-call path** and the
  dropped property is non-essential for your use case (e.g. a structural
  CDK construct emits a property you do not care about).
- **A Cloud Control side-effect bothers you** — e.g. CC names a resource
  differently than cdkd's SDK provider would have, and you want the SDK
  naming convention to win.
- **You have an existing SDK-managed resource** (`provisionedBy: 'sdk'`)
  that you want to keep on the SDK path even after a new property
  appears in the template. Without the flag, the next deploy would
  auto-route it through CC (the routing decision re-evaluates per
  deploy — only a resource whose state already says `'cc-api'` is
  sticky to CC; a still-SDK resource with new silent-drop properties
  re-routes).

#### Do NOT use the flag when

- **The dropped property is security-meaningful** — e.g. `KmsKeyArn`,
  `MonitoringRoleArn`, `MasterUserSecret`, IAM policy attachments,
  resource-policy fields, encryption settings, TLS configuration.
  Silent drop here is a real-world incident. Without the flag, the
  auto-route closes the silent drop by sending the property to AWS via
  CC; with the flag, you opt back into the silent drop.
- **You are prototyping** and don't care about routing — the default
  auto-route already gets the property to AWS.

#### Decision summary

| Situation | Recommended action |
| --- | --- |
| Fresh deploy, template uses a silent-drop property | Default auto-route via Cloud Control (no flag needed) |
| Existing CC-managed resource, want to stay on CC | Default routing (sticky) — no flag needed |
| Existing SDK-managed resource, new silent-drop property appears | Default re-routes through CC. To stay on SDK, use `--allow-unsupported-properties` |
| You explicitly want SDK semantics + accept the silent drop | This flag |
| Property is security-meaningful | Do not use the flag — let the CC auto-route close the silent drop |

#### What the flag is NOT

- **NOT** a request to cdkd to start handling the property. The provider
  is unchanged; with the flag, the property is silently dropped at write
  time. (Without the flag, the resource takes the CC route and the
  property reaches AWS verbatim.)
- **NOT** persisted in cdkd state. Every deploy must pass the flag if
  the override is still desired; the resource's `provisionedBy` state
  field reflects the routing actually used at last deploy.

cdkd is currently a dev/test tool (see "Important Notes" in CLAUDE.md);
the CC auto-route closes a long-standing silent-drop bug class by
default. For production workloads, use the AWS CDK CLI until cdkd's
property coverage matches your needs.

## `--recreate-via-cc-api <LogicalId>` + `--force-stateful-recreation` (deploy)

`--recreate-via-cc-api <LogicalId>` (repeatable, one flag per resource)
destroys + recreates the named resource via Cloud Control API in this
deploy, so a previously-silent-dropped top-level CFn property reaches
AWS on the recreated copy. This is the mid-life counterpart to #614's
default-on auto-route for fresh deploys.

When to use it:

- An existing resource is `provisionedBy: 'sdk'` in cdkd state, and you
  want to start using a top-level CFn property cdkd's SDK provider does
  not yet wire (e.g. adding `RecursiveLoop` to an already-deployed
  Lambda). Adding the property on the next deploy alone won't reach AWS
  — the SDK update path drops it silently. The flag forces a destroy +
  recreate cycle so the new physical resource lands on CC and the
  property reaches AWS.

When NOT to use it:

- The resource is already `provisionedBy: 'cc-api'` (sticky). The
  update path already routes via CC; the recreate is a no-op. As of
  #665 cdkd refuses pre-flight with `blockedAlreadyCcApi` — the
  destroy + recreate cycle would produce identical end state at the
  cost of unnecessary downtime. Mirror of the `blockedAlreadySdk`
  refusal on the reverse direction (#651). Fix: drop the flag for that
  resource.
- Fresh deploy (the resource is not yet in cdkd state). #614's
  auto-route handles fresh silent-drop deploys automatically — no flag
  needed.

```bash
# Recreate a single Lambda (stateless, no extra flag needed)
cdkd deploy MyStack --recreate-via-cc-api MyLambda --yes

# Recreate two Lambdas in one deploy (repeat the flag — comma-split is intentionally unsupported)
cdkd deploy MyStack \
  --recreate-via-cc-api MyLambda \
  --recreate-via-cc-api OtherFn \
  --yes

# Recreate a stateful resource — TWO flags required + data loss is acknowledged
cdkd deploy MyStack \
  --recreate-via-cc-api MyTable \
  --force-stateful-recreation \
  --yes
```

### Stateful-resource guard

The flag refuses to operate on resource types that carry user data
without `--force-stateful-recreation`. Two-flag protection mirrors the
`--remove-protection` pattern.

Guard list (always stateful — destroy loses ALL data, no automatic
migration):

| Category | Types |
| --- | --- |
| Database / storage | `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`, `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`, `AWS::Neptune::DBInstance`, `AWS::Neptune::DBCluster`, `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` |
| Filesystem / blob | `AWS::EFS::FileSystem`, `AWS::ECR::Repository` |
| Streaming | `AWS::Kinesis::Stream` |
| Search | `AWS::Elasticsearch::Domain`, `AWS::OpenSearchService::Domain` |
| Identity / config | `AWS::Cognito::UserPool`, `AWS::SecretsManager::Secret`, `AWS::SSM::Parameter` |
| Metadata catalog | `AWS::Glue::Database`, `AWS::Glue::Table` |
| Edge | `AWS::CloudFront::Distribution` (URL changes break consumers; ~20-minute propagation) |

Conditionally stateful (guard fires only when the resource actually
contains data):

- `AWS::S3::Bucket` — guard fires when the bucket has at least one
  current version, prior version, or delete-marker. cdkd issues a
  single-page `s3:ListObjectVersions(MaxKeys=1)` against each S3 bucket
  target at plan time (issue #648); empty buckets pass through,
  non-empty buckets (including versioned buckets whose current keys are
  soft-deleted but whose history is still retained) are refused unless
  `--force-stateful-recreation` is supplied. cdkd uses
  `ListObjectVersions` rather than `ListObjectsV2` so the probe's
  view of "empty" matches what the destroy + recreate cycle would
  actually wipe. If the probe itself fails (permission denied,
  transient network error), cdkd logs a warn and falls through to the
  conservative "not stateful" sync result — pass
  `--force-stateful-recreation` to proceed when the bucket might hold
  data and the probe could not be verified.
- `AWS::Logs::LogGroup` — guard fires when `RetentionInDays > 0` on the
  recorded state. Log groups without retention configured are treated
  as ephemeral.

There is no per-resource granularity on `--force-stateful-recreation`
— when set, EVERY named recreate target bypasses the stateful guard.
The user is opting into a footgun; per-resource force would imply a
false sense of granularity.

### Interactive confirmation

`cdkd deploy --recreate-via-cc-api <id>` prints a per-target plan
(logical id + resource type + `stateful` reason where applicable) and
then asks `Continue? (y/N)` before any AWS call. Default is `N`
(destructive — the destroy + recreate cycle is irreversible per
resource). Combine with `--yes` / `-y` for non-interactive CI runs;
the plan is then warn-logged once and the deploy proceeds without
prompting. Non-TTY runs without `--yes` are rejected with an
actionable error rather than hanging on a closed stdin.

For stateful targets (those reaching pre-flight only because the user
opted in with `--force-stateful-recreation`), the prompt prefixes each
row with `**DATA LOSS**` and emits an explicit `DATA: all data in
<logical id> will be lost` caveat — the third "stop and think" moment
on top of the two-flag opt-in.

### Cross-stack reference propagation

The recreated resource gets a fresh physical id. Downstream stacks that
read this resource's outputs via `Fn::GetStackOutput` /
`Fn::ImportValue` must be re-deployed before they see the new id. A
warn line lists this caveat at recreate time; cdkd does NOT walk the
state bucket to enumerate downstream consumers in v1 (deferred to a
follow-up issue). Plan multi-stack recreates from leaf to root.

### Interaction with `--allow-unsupported-properties`

`--recreate-via-cc-api MyLambda` combined with
`--allow-unsupported-properties AWS::Lambda::Function:RecursiveLoop`
on a resource whose template carries `RecursiveLoop` is **ambiguous
intent**:

- Does the user want SDK + silent drop (override path)?
- Does the user want CC migration (recreate path)?

cdkd refuses with a pre-flight error naming the overlap. Pick one
strategy per resource.

### Reversibility (one-way at v1)

Once a resource is `provisionedBy: 'cc-api'`, going back to the SDK
Provider requires another flag (the inverse `--recreate-via-sdk`). NOT
in scope for v1 — file an issue if you need this direction.

When a backfill PR (issue #609) wires the property the user originally
needed, the migrated resource stays on CC unless the user explicitly
switches it back. Sticky-state semantics avoid SDK↔CC ping-pong on
every backfill release.

### What `--recreate-via-cc-api` is NOT

- **NOT** a per-stack shortcut. There is no
  `--recreate-via-cc-api-all-with-silent-drops` form — the user names
  each target explicitly to acknowledge the cost.
- **NOT** persisted in cdkd state. The next deploy WITHOUT the flag
  routes the recreated resource via CC (sticky); the flag is only
  needed to trigger the initial destroy + recreate.
- **NOT** compatible with cross-account / cross-region migration —
  the flag operates within the current deploy's environment only.
- **NOT** compatible with Tier 3 (`NON_PROVISIONABLE`) types — CC API
  can't handle them either; the existing Tier 3 reject fires first.
- **NOT** compatible with multi-region resources like
  `AWS::DynamoDB::GlobalTable` in v1 — the destroy + recreate cycle
  across replica regions is more involved; cdkd refuses with a clear
  error.

## `--replace` (deploy)

Replace (DELETE + CREATE) a resource whose **in-place update is rejected
because an immutable property changed and AWS exposes no update API for
it**. Some resource types are immutable on AWS — there is no
`Update<Thing>` call, so any property change must publish / register a
new physical resource. Examples: `AWS::Lambda::LayerVersion` content,
`AWS::EFS::AccessPoint`, `AWS::ECS::TaskDefinition`,
`AWS::Glue::SecurityConfiguration`, and several `AWS::ApiGatewayV2::*`
identity fields.

For a few of these cdkd already has a built-in replacement rule (e.g.
`AWS::Lambda::LayerVersion` auto-replaces with no flag). For the rest,
cdkd's diff classifies the change as an in-place UPDATE, the provider's
`update()` hard-rejects with `ResourceUpdateNotSupportedError`, and —
without this flag — the deploy fails. `--replace` opts into catching that
rejection and falling back to a DELETE + CREATE of the resource (the same
replacement path the Cloud Control `UnsupportedActionException`
auto-fallback already uses), matching what CloudFormation would do.

Unlike `--recreate-via-cc-api` / `--recreate-via-sdk-provider` (which
name a specific logical id and force a routing migration), `--replace` is
a stack-wide opt-in that fires only for resources whose update genuinely
hard-rejects — a resource whose update succeeds in place is unaffected.

```bash
# A Glue SecurityConfiguration's EncryptionConfiguration changed (immutable) —
# fails without the flag, replaces cleanly with it
cdkd deploy MyStack --replace --yes
```

### Stateful-resource guard (shared with `--recreate-via-cc-api`)

`--replace` shares the same stateful-resource guard as
`--recreate-via-cc-api`: when the replacement target is a stateful type
(see the guard list above — RDS / DynamoDB / EFS / S3-with-data /
Logs-with-retention / etc.), the DELETE + CREATE loses all data, so
cdkd refuses unless `--force-stateful-recreation` is ALSO passed. The
guard is evaluated at the moment the immutable-update rejection is
caught (mid-deploy), and the error names the resource + the data-loss
reason. Non-stateful immutable types (LayerVersion, Glue
SecurityConfiguration, ECS TaskDefinition, ApiGatewayV2 sub-resources,
etc.) replace with `--replace` alone.

The same stateful guard ALSO covers **property-driven replacement** — a
replacement cdkd detects directly from the diff (an immutable / createOnly
property changed in the template, e.g. `AWS::EFS::FileSystem.PerformanceMode`
or an S3 `BucketName` rename) rather than from a provider's mid-deploy update
rejection. A plain `cdkd deploy` (no `--replace` flag) that would DELETE+CREATE
a **stateful** resource because of such a change now requires
`--force-stateful-recreation` and throws `STATEFUL_REPLACE_BLOCKED` without it,
closing the prior footgun where a template immutable-property change silently
destroyed a stateful resource's data. Non-stateful types still replace freely
on `cdkd deploy` with no flag.

## `--recreate-via-sdk-provider <LogicalId>` (deploy)

`--recreate-via-sdk-provider <LogicalId>` (repeatable, one flag per
resource) is the reverse direction of `--recreate-via-cc-api`
(issue #651). It destroys + recreates the named resource via cdkd's
SDK Provider so a resource currently sticky on `provisionedBy: 'cc-api'`
flips back to `provisionedBy: 'sdk'`.

When to use it:

- A `provisionedBy: 'cc-api'`-sticky resource (landed on CC because
  the user originally needed a top-level CFn property cdkd's SDK
  Provider did not wire, e.g. Lambda `LoggingConfig`) is now eligible
  for SDK Provider routing because a #609 backfill release has added
  SDK coverage for that property. The flag forces a destroy + recreate
  cycle so the new physical resource lands on SDK and benefits from
  SDK Provider performance / diagnostic clarity / narrower IAM scope.
- A `provisionedBy: 'cc-api'` resource where the user no longer needs
  the CC route (e.g. removed the silent-drop property from the
  template) and wants to consolidate routing back to SDK for the
  reasons above.

When NOT to use it:

- The resource is already `provisionedBy: 'sdk'` (or pre-v7 legacy
  state, treated as SDK by the v7 binary) — the reverse migration is
  a no-op. cdkd refuses with a clear error.
- The resource type has no SDK provider registered (Tier 2 CC-only) —
  the destroy + recreate would route via CC again. cdkd refuses.
- The template still uses a silent-drop property NOT in
  `--allow-unsupported-properties` — the default-on CC auto-route
  would re-route the SDK-recreated resource back to CC on the very
  next routing decision. cdkd refuses (inverse ambiguous intent); fix
  by either removing the property from the template or accepting the
  silent drop via `--allow-unsupported-properties <Type>:<Prop>`.

Stateful-resource guard, multi-region refusal, and the interactive
`Continue? (y/N)` prompt are symmetric to `--recreate-via-cc-api`:
named stateful targets (RDS / DynamoDB / S3-with-data / etc.) refuse
unless `--force-stateful-recreation` is also passed, multi-region
resources (`AWS::DynamoDB::GlobalTable`) refuse outright in v1, and
the prompt fires per-stack with the same `**DATA LOSS**` prefix on
stateful entries. The two flags are mutually exclusive on a per-resource
basis — naming the same logical id in both is refused as ambiguous.

```bash
# Mid-life CC→SDK migration after a #609 backfill landed SDK coverage
# for Lambda's LoggingConfig:
cdkd deploy MyStack --recreate-via-sdk-provider MyLambda --yes

# Multiple targets:
cdkd deploy MyStack \
  --recreate-via-sdk-provider MyLambda \
  --recreate-via-sdk-provider OtherFn \
  --yes
```

### What `--recreate-via-sdk-provider` is NOT

- **NOT** a per-stack shortcut. Per-resource explicit naming only.
- **NOT** the only path to SDK routing — fresh CREATEs route via the
  routing-decision matrix in `ProviderRegistry.getProviderFor` and
  land on SDK whenever an SDK Provider is registered for the type AND
  the template has no silent-drop property. This flag is for the
  existing-state CC → SDK migration only.
- **NOT** compatible with `--recreate-via-cc-api` on the same logical
  id — pick ONE direction per resource.

## `--strict-getatt` (deploy)

Fail the deploy on ANY `Fn::GetAtt` that falls back to the resource's
physical ID because cdkd cannot construct the requested attribute, and on
any stack Output that cannot be resolved.

```bash
cdkd deploy MyStack --strict-getatt
```

### Default behavior (without the flag)

When a template requests an attribute that is neither captured in state
`attributes` nor constructible by the resolver's per-type mappings, cdkd
falls back to the resource's **physical ID**:

- **Knowably-wrong shapes hard-fail even without the flag** (issue #1106):
  an attribute name ending in `Arn` whose fallback value is not
  `arn:`-shaped, or ending in `Url` whose fallback is not an http(s) URL,
  cannot be what CloudFormation would return — the deploy fails with an
  actionable error naming the resource, attribute, and an issue link. This
  applies to the resolver's final unknown-type fallback AND to every
  per-type handler's unknown-attribute default branch (issue #1111).
- **Every other suffix warns and returns the physical ID** (`Unknown
  attribute X for resource type Y, returning physical ID`) — an alias or
  endpoint is shape-indistinguishable from a plain name, so a hard-fail
  there would risk failing correct deploys.
- When at least one such fallback happened, the deploy summary prints a
  one-line count so the warns don't scroll away on green deploys:

  ```text
  2 attribute resolution(s) fell back to the physical ID (potentially wrong values); re-run with --strict-getatt to fail on these
  ```

  Each distinct fallback site is counted once per run (diff-phase
  resolutions are not double-counted against provisioning-phase ones). The
  count is per stack: a nested-stack child's fallbacks are counted by the
  child's own deploy engine and are not aggregated into the parent's
  summary line.

- An **Output** whose value cannot be resolved is warned about and skipped
  (no value is persisted or exported); the deploy still exits 0.

### With `--strict-getatt`

- EVERY unknown-attribute physical-ID fallback — any suffix, including an
  ARN-shaped fallback for an `*Arn` attribute — is a hard error.
- An Output resolution failure fails the deploy instead of silently
  publishing nothing (which would otherwise break downstream
  `Fn::ImportValue` consumers with "export not found" long after this
  deploy exited 0). The failure fires AFTER all resource operations
  succeeded, so cdkd persists the provisioning result to state BEFORE
  failing: the created/updated resources are recorded (previously
  persisted outputs are kept), no rollback runs, and a follow-up
  `cdkd deploy` or `cdkd destroy` sees them — even on a first deploy,
  nothing becomes an invisible orphan.

Use it in CI to guarantee no potentially-wrong `Fn::GetAtt` value ever
ships quietly; drop it (default) when a known-benign fallback (e.g. a
physical ID that genuinely is the attribute value for a type cdkd has not
enriched yet) is acceptable. Nested-stack child deploys inherit the flag
from the parent deploy.

## `--role-arn`

Assume a different IAM role for cdkd's AWS API calls. Equivalent env
var: `CDKD_ROLE_ARN`. CLI flag takes precedence when both are set.

```bash
cdkd deploy --role-arn arn:aws:iam::123456789012:role/cdkd-deploy
# or
CDKD_ROLE_ARN=arn:aws:iam::123456789012:role/cdkd-deploy cdkd deploy
```

cdkd does an `STS AssumeRole` once at command start (1-hour session,
session name `cdkd-<unix-ms>`) and writes the resulting temporary
credentials into `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` so every later AWS SDK client picks them up via
the standard default credentials chain. No re-plumbing of credential
arguments through cdkd's ~13 `AwsClients` instantiation sites is
required.

### Why the assumed role MUST have admin-equivalent permissions

Unlike `cdk deploy`, **cdkd does not route through CloudFormation**.
There is no cfn-exec-role to delegate to. Every IAM / EC2 / Lambda /
CloudFront / DynamoDB / etc. API call is issued from cdkd directly,
using whatever identity the SDK default chain resolves to (which, when
`--role-arn` is set, is the assumed role).

That means **CDK CLI's `cdk-hnb659fds-deploy-role-*` is NOT enough**:

| Role | Trust policy | Permissions | Works for cdkd? |
| --- | --- | --- | --- |
| `cdk-hnb659fds-deploy-role-*` | IAM principals | CFn + asset-publish only (no raw EC2 / Lambda / IAM) | **No** — permission-denied during provisioning |
| `cdk-hnb659fds-cfn-exec-role-*` | `Service: cloudformation.amazonaws.com` | admin-equivalent | **No** — only assumable by CFn service, not by cdkd's IAM identity |
| Custom admin-equivalent role | IAM principals | admin-equivalent on the resources you deploy | **Yes** |

CDK CLI achieves "no local admin needed" through a two-step delegation
(IAM principal → deploy-role → CFn change set → cfn-exec-role's admin).
cdkd has no analogous chain — what you grant the assumed role is what
runs against AWS, end of story. The `--role-arn` flag exists so CI
runners with limited base credentials can still drive a cdkd deploy
against a separate-account or higher-privilege role; it does NOT
reduce the permissions the eventually-used identity needs.

### When the `--role-arn` session expires

Default session is 1 hour. For deploys that genuinely take longer
(rare; even `bench-cdk-sample` runs in ~3 min), the user re-runs the
cdkd command — in-flight credentials remain valid until expiry, but a
re-run is the simplest recovery path. cdkd does not currently auto-
refresh the session.

### `--profile` vs `--role-arn`

Independent. `--profile` selects which entry from `~/.aws/credentials`
or `~/.aws/config` provides the **base** credentials; `--role-arn`
then assumes a role from those base credentials. Use both together
when the IAM principal lives in profile A and the deploy role lives
in account B that profile A trusts.

## `cdkd bootstrap`

One-time per-account setup (plus once per additional region for asset
storage). Creates:

1. The S3 **state bucket** (`cdkd-state-{accountId}`, or `--state-bucket
   <name>`) — versioned, AES-256 encrypted, account-only bucket policy.
2. cdkd-owned **asset storage** for `--region` (issue
   [#1002](https://github.com/go-to-k/cdkd/issues/1002)): the asset bucket
   (default name `cdkd-assets-{accountId}-{region}`; AES-256, account-only
   policy, no versioning — assets are immutable content-addressed blobs) and
   the container-asset ECR repo (default name
   `cdkd-container-assets-{accountId}-{region}`; immutable tags), plus the
   per-region bootstrap **marker**
   `s3://{stateBucket}/cdkd-bootstrap/{region}.json` that opts the region
   into cdkd-assets mode. Why: `cdk gc` decides "in use" by scanning
   CloudFormation stack templates — cdkd-deployed stacks have no CFn stack,
   so assets published to the CDK bootstrap bucket/repo look isolated to gc
   and get deleted. cdkd-owned storage is structurally out of gc's reach.
   See [docs/design/1002-cdkd-asset-storage.md](design/1002-cdkd-asset-storage.md).

Flags:

- `--no-assets` — skip step 2 (no asset bucket / ECR repo / marker).
  Explicit opt-out for users who keep CDK bootstrap storage or use a custom
  synthesizer with their own asset destinations. Deploys in the region stay
  in legacy mode (publish to the `assets.json` destinations verbatim).
- `--asset-bucket <name>` / `--container-repo <name>` (issue
  [#1011](https://github.com/go-to-k/cdkd/issues/1011)) — custom names for
  the asset bucket / container-asset ECR repo instead of the defaults above.
  The escape hatch when the predictable default S3 name is squatted by
  another account (S3 names are global), and the compliance knob for
  org-wide naming policies (ECR repo names are account-scoped, so the ECR
  half is purely for naming policy). The names are validated before any AWS
  call (S3: 3-63 lowercase letters / digits / dots / hyphens, starting and
  ending with a letter or digit; ECR: 2-256 lowercase letters / digits with
  single `.` `_` `-` `/` separators), written into the bootstrap marker, and
  every consumer (deploy redirect / rewrite, publish, verification,
  `state info`, teardown) reads them from the marker from then on. A plain
  re-run of `cdkd bootstrap` keeps the marker's existing (custom) names.
  Re-bootstrapping a region with names that DIFFER from its marker is a hard
  error (`ASSET_STORAGE_NAME_CONFLICT`) — changing names would strand the
  existing storage and its published assets, so run
  `cdkd bootstrap --destroy --region <r>` first, then re-bootstrap with the
  new names. Rejected in combination with `--no-assets` (which skips the
  asset storage the flags name) and with `--destroy` (teardown reads the
  names from the marker). The deploy-time auto-create (issue #1007) always
  uses the default names — custom names require the explicit
  `cdkd bootstrap`. Custom bucket names get the same squatting defense as
  the defaults (owned-elsewhere hard refusal, `ExpectedBucketOwner` on every
  call).
- `--force` — reconfigure existing buckets/repo (re-apply encryption /
  policy / tag-immutability). Without it, existing resources are left
  untouched (re-running bootstrap is idempotent and is the supported way to
  opt an existing account's region into asset storage). Under `--destroy`,
  `--force` instead skips the deployed-stack reference scan (see below).
- `--state-bucket <name>` / `--region <region>` — as documented above;
  `--region` on bootstrap is a real (non-deprecated) option.
- `--destroy` — tear down the region's asset storage instead of creating it
  (see "Teardown" below).
- `--include-state-bucket` — with `--destroy` only: also delete the S3 state
  bucket.

Re-running `cdkd bootstrap` on an already-bootstrapped account does NOT
require `--force` to add the asset storage — the state bucket is simply
left as-is and the asset bucket / repo / marker are created. Accounts
bootstrapped by cdkd versions before 0.232.0 need no manual step at all:
the first `cdkd deploy` into each region auto-creates the storage (see
"Auto-create on first deploy" below); the explicit re-run is the
pre-provisioning alternative. Deploys that opt out stay in **legacy mode**
(publish to the CDK bootstrap destinations, byte-identical to older
versions, plus a one-line `cdk gc` notice naming the region) — nothing
breaks by upgrading the binary alone, and downgrading is safe in either
mode (old binaries ignore the marker; both storages hold the same
content-addressed objects).

Relationship with `cdk bootstrap`: cdkd never uses CDK's bootstrap roles
(it deploys with the caller's credentials) and does not resolve the
template's `BootstrapVersion` parameter, so a region never touched by
`cdk bootstrap` works fine. `cdkd export` hands a stack back to the
CloudFormation / CDK CLI world, where `cdk bootstrap` is the CDK CLI's own
prerequisite again.

Bucket-squatting defense: bootstrap refuses to adopt an asset bucket owned
by another account (predictable-name defense), and cdkd's asset-bucket S3
calls pass `ExpectedBucketOwner`. Deleting the asset bucket/repo while the
marker exists makes deploys fail with a re-bootstrap hint — cdkd never
silently falls back to CDK bootstrap storage once a region is opted in.

`cdkd state info` shows which regions are opted in (`Asset storage:` line /
`assetStorage` JSON field).

### Asset destinations after opt-in (cdkd-assets mode)

Once a region's bootstrap marker exists, every asset-consuming command
redirects **default-bootstrap-shaped** destinations
(`cdk-<qualifier>-assets-…` / `cdk-<qualifier>-container-assets-…` for this
account+region — exactly the population `cdk gc` can delete) to the
cdkd-owned storage, and rewrites the matching template references
(`Code.S3Bucket`, `Code.ImageUri`, `s3.Asset` URLs in env vars, nested-stack
`TemplateURL`, …) to the cdkd names. `objectKey` / `imageTag` (content
hashes) are unchanged. User-chosen storage (custom `fileAssetsBucketName` /
`imageAssetsRepositoryName`, `AppStagingSynthesizer` staging buckets) and
cross-region destinations are never touched — `cdk gc` cannot reach those.

Per-command behavior:

| Command | cdkd-assets mode |
| --- | --- |
| `deploy` | redirect publishes + rewrite templates (incl. nested children); a post-resolution audit fails any resource whose resolved properties still name the CDK bootstrap storage |
| `diff` (incl. `--recursive`) | rewrite, so the shown plan matches what deploy will do (incl. the one-time migration diff) |
| `import` | rewrite before writing state (no spurious first-deploy churn) |
| `publish-assets` | redirect via the same table (reads the marker from the state bucket; falls back to legacy with an info line when no state bucket resolves) |
| `synth` / `export` | **unrewritten** — synth prints the CDK app's template; export returns the stack to the CFn/cdk-assets world |
| `destroy` / `state *` / `drift` / `events` | state-driven, unchanged |

The first deploy after opting in shows a one-time "everything with assets
updates" diff — an ordinary in-place UPDATE repointing `Code` / `Image` at
cdkd storage (content identical, no replacement).

`--use-cdk-bootstrap-assets` (on `deploy` / `diff` / `import` /
`publish-assets`) pins legacy destinations for one invocation even after the
region is opted in; `cdk.json` `context.cdkd.useCdkBootstrapAssets: true`
pins it per app — for apps deployed via both CloudFormation and cdkd during
a migration window. The pin also suppresses the legacy-mode `cdk gc` notice.

### Auto-create on first deploy (issue #1007)

`cdkd deploy` into a region that has **no** bootstrap marker auto-creates
the per-region asset storage (asset bucket + container-asset ECR repo +
marker — the same `ensureAssetStorage` path `cdkd bootstrap` uses, including
the squatting defense and marker-written-last ordering) instead of falling
back to legacy mode, so `cdkd bootstrap` stays a true once-per-account step.

- Interactive runs are prompted once per region (`[Y/n]`, default yes);
  `--yes` / non-TTY runs create immediately with an info line.
- A declined prompt or a failed creation (e.g. S3/ECR create denied) falls
  back to legacy mode with an actionable warning — a deploy that worked
  before never starts hard-failing.
- Opt out per invocation with `--no-auto-asset-storage`, or per app with
  `cdk.json` `context.cdkd.autoAssetStorage: false`. The
  `--use-cdk-bootstrap-assets` pin also disables it (the marker is never
  read), as does `--dry-run` (a dry run creates nothing). Only `deploy`
  auto-creates — `diff` / `import` / `publish-assets` never create
  resources.

### Teardown (`cdkd bootstrap --destroy`, issue #1010)

`cdkd bootstrap --destroy --region <r>` is the reverse of bootstrap for ONE
region's asset storage — the cdkd equivalent of deleting the CDK CLI's
`CDKToolkit` stack, replacing the manual `aws s3 rb` / `aws ecr
delete-repository` / marker-delete sequence. It:

1. Empties (all versions + delete markers) and deletes the region's **asset
   bucket**, then force-deletes the **container-asset ECR repo**, then
   deletes the region's bootstrap **marker LAST** — the mirror of the
   create side's marker-written-last ordering, so a crash mid-teardown
   leaves the region consistently opted in (deploys hard-error with a
   re-bootstrap hint rather than silently falling back to legacy mode).
2. Reads the asset bucket / repo **names from the marker**, never from the
   naming convention — compatible with custom asset-storage names.
3. Refuses while any deployed stack's state still references the region's
   asset bucket / repo (running Lambdas keep working after deletion, but a
   future re-deploy / rollback of those stacks would break). The scan
   covers every state file in the bucket regardless of the
   `--state-prefix` it was deployed under. `--force` overrides the scan.
4. Prompts for confirmation with the full deletion plan (`y/N`, default
   No); `--yes` / `-y` skips the prompt. A non-TTY stdin without `--yes` is
   a hard error.
5. Is idempotent: already-missing pieces are skipped with info lines
   (mirror of `ensureAssetStorage`), and every S3 call passes
   `ExpectedBucketOwner` (a foreign bucket squatting the name is refused,
   never deleted).

The **state bucket is kept by default** — it is the account's source of
truth. `--include-state-bucket` opts it into the teardown, and even then
the deletion is refused while ANY stack state exists — under any
`--state-prefix`, the guard lists the whole bucket — (destroy every stack
first; there is no `--force` override) or while any OTHER region still has
a bootstrap marker in the bucket (tear those regions down first — deleting
their markers with the bucket would silently flip them back to legacy
mode).

A region with no bootstrap marker is a no-op (nothing to delete); note the
auto-create-on-first-deploy behavior above will re-create the storage on
the next `cdkd deploy` into the region unless you opt out
(`--no-auto-asset-storage` / `context.cdkd.autoAssetStorage: false`).

## `cdkd gc` (garbage-collect cdkd-owned asset storage)

`cdkd gc [--region <r>] [--older-than <dur>] [--dry-run] [-y]` deletes
unreferenced objects / images from ONE region's cdkd-owned asset storage
(the asset bucket + container-asset ECR repo created by `cdkd bootstrap`,
issue #1012). Assets are content-addressed and deliberately never deleted
on `cdkd destroy` (another stack or a future rollback may reference the
same hash), so the storage grows without bound — and `cdk gc` cannot reach
it by design. cdkd can gc it *precisely* because its state files record
exactly which assets are in use.

**Scope**: one region per invocation (`--region`, same resolution as
`bootstrap`: flag → `AWS_REGION` → `us-east-1`). The asset bucket / repo
names are read from the region's bootstrap marker, never recomputed from
the naming convention (custom-name compatible). A region with no marker is
a friendly no-op. **CDK bootstrap storage (`cdk-hnb659fds-*`) is never
touched** — that stays `cdk gc`'s job.

**Reference collection**: every state file in the state bucket is scanned
(the whole bucket, so stacks deployed under any `--state-prefix` are
covered — including nested-stack children). References are collected from
each resource's `properties` / `observedProperties` / `attributes` and the
stack `outputs`, matching `{S3Bucket, S3Key}` pairs (Lambda `Code` etc.),
`s3://` URIs, virtual-hosted and path-style `https://...amazonaws.com`
URLs (query strings stripped), and ECR image URIs by `:tag` and/or
`@sha256:digest`.

**Guards** (this command deletes data — every ambiguity is biased toward
NOT deleting):

- **Fail safe**: a state file that fails to JSON-parse aborts the whole
  run — deleting on partial knowledge is how a live asset gets deleted.
- **Lock guard**: any stack lock (`lock.json`) in the state bucket aborts
  with a listing of the locked stack(s) — a deploy in flight may have
  published assets whose state write has not landed yet.
- **Age guard**: `--older-than <dur>` (default `30d`, accepts `<n>d` /
  `<n>h`) — an object (`LastModified`) / image (`imagePushedAt`) newer
  than the cutoff is never deleted, even when unreferenced. Protects
  in-flight publishes and recent rollback targets. Missing timestamps are
  treated as "new" (kept).
- **Ownership**: every S3 call pins `ExpectedBucketOwner`; a 403 on the
  asset bucket is a foreign-bucket refusal (never deleted).

**Reporting + confirmation**: the reclaim plan (per-item key / tag+digest,
size, age) and byte totals are printed first. `--dry-run` prints the plan
and exits without prompting or deleting. Otherwise an interactive
`Continue? (y/N)` prompt (default No) gates the deletion; `--yes` / `-y`
skips it, and a non-TTY stdin without `--yes` is a hard error. Zero
candidates → info line, exit 0, no prompt. Deletion is chunked
(`DeleteObjects` 1,000 keys / `BatchDeleteImage` 100 images per call) and
any per-item failure is surfaced as a hard error.

Also accepts `--state-bucket`, `--profile`, `--role-arn`, `--verbose`.

**Reference shapes covered**: `{S3Bucket, S3Key}` / `{Bucket, Key}` (and any
other object shape carrying the asset bucket name as a value — every sibling
string is protected), `s3://` URIs, virtual-hosted and path-style `https`
URLs, ECR image URIs by tag and/or digest, content-addressed
`<sha256>.<ext>` tokens anywhere in a state string (protects keys embedded
in joined lists), and references inside base64-encoded values (one decode
level — covers `Fn::Base64`-resolved EC2 / ASG UserData fetching assets at
boot).

**Known limitation**: an UNTAGGED child manifest of a referenced multi-arch
/ attestation image index is not individually protected (references point at
the index). cdkd's own image publisher builds single-manifest images
(`BUILDX_NO_DEFAULT_ATTESTATIONS=1`), so this only affects images
hand-pushed into the cdkd repo — keep those out of gc'd repos or reference
them by digest in a deployed stack.

## `cdkd diff`

`cdkd diff [<stacks...>]` synthesizes the CDK app and reports the
per-resource CREATE / UPDATE / DELETE changes the next `cdkd deploy`
would apply, comparing the synth template against cdkd's S3 state.

- `--recursive` (issue [#555](https://github.com/go-to-k/cdkd/issues/555)
  A5) — recurse into every `AWS::CloudFormation::Stack` row and diff each
  nested-stack child against its **own** deployed state
  (`cdkd/<parent>~<childLogicalId>/<region>/state.json`), in DFS order.
  Default is non-recursive, matching `cdk diff` (which shows the parent's
  nested-stack row as a single `TemplateURL` / `Parameters` change with no
  descent). Each child's block is printed under a `Nested stack: <name>`
  header (the full `~`-joined state name, matching `cdkd state show
  --show-nested`). The walk previews the full next deploy: a nested child
  with no state file yet diffs as all-CREATE; a nested stack removed from
  the CDK code (present in state, absent from the template) diffs as
  all-DELETE recursively.
- `--fail` — exit `1` when any change is detected (parity with `cdk diff
  --fail`). With `--recursive`, considers the whole nested-stack tree, so
  CI can gate on tree-wide drift with a single `cdkd diff <parent>
  --recursive --fail`. Without `--fail`, `cdkd diff` always exits `0` even
  when changes are present (parity with `cdk diff`'s default).
- `--json` — emit the diff as JSON instead of human-readable text. A flat
  array of `{stack, region, changes: [...], children: [...]}` records (one
  per target stack); with `--recursive`, `children` is populated with the
  same nested shape recursively. `NO_CHANGE` resources are omitted;
  `children` is always present (empty on leaves) so the key set is stable.
  Each change entry additionally carries `ccApi?: string[]` when the
  resource would auto-route via Cloud Control API on the next deploy (the
  human renderer's `[via CC API: <props>]` annotation in machine form;
  absent when the resource routes via its SDK provider). Progress logging
  is suppressed so stdout carries only the JSON payload.

**Routing annotation**: every CREATE / UPDATE line whose template uses a
top-level CFn property cdkd's SDK provider does not yet wire is tagged
`[via CC API: <prop list>]` so the routing decision is auditable at plan
time — the same auto-fallback the deploy engine applies (#614). DELETE
lines are not annotated; deletes route via the recorded `provisionedBy`
on each resource's state, not via template inspection.

Like every non-bootstrap command, `--region` is deprecated (prefer
`AWS_REGION` / your AWS profile) but still honored if passed.
Stack selection (`<stacks...>` / `--all` / wildcards / display paths)
follows the same rules as `cdkd deploy` / `cdkd destroy`.

## `cdkd drift`

`cdkd drift [<stack>...]` detects drift between cdkd's S3 state
and the live AWS-side configuration of each managed resource. cdkd does
not go through CloudFormation, so CFn-style drift detection does not
apply — instead, the command asks each resource's provider for its
`readCurrentState` snapshot and compares it against the **deploy-time
AWS snapshot** stored in `ResourceState.observedProperties` (state
schema `version: 3`+). Resources written by an older binary or by a
provider without `readCurrentState` lack `observedProperties` — for
those, the comparator falls back to the user-templated `properties`
field (the pre-v3 behavior). The observed-baseline path is what makes
console-side changes to keys the user did not template surface as
drift; the fallback only catches changes to keys the user did template.
See [docs/state-management.md](state-management.md) for the schema
details.

Detection is the default behavior — pass `--accept` or `--revert` to
also resolve any drift the comparator finds (see "Resolving drift" below).

```bash
# Single stack — auto-selects when state has exactly one stack
cdkd drift

# Single stack by name
cdkd drift MyStack

# Every stack in the bucket
cdkd drift --all

# Disambiguate when the same stack name has state in multiple regions
cdkd drift MyStack --stack-region us-east-1

# Machine-readable output for CI gating
cdkd drift --all --json

# Resolve drift: state ← AWS (catch up cdkd state with manual console changes)
cdkd drift MyStack --accept --yes

# Resolve drift: AWS ← state (push cdkd state values back into AWS)
cdkd drift MyStack --revert --yes

# Preview either resolution without acquiring a lock or hitting AWS
cdkd drift MyStack --accept --dry-run
cdkd drift MyStack --revert --dry-run
```

Flags:

- `<stacks...>` — zero or more positional stack names (physical
  CloudFormation names). When omitted and `--all` is not set, the
  command auto-selects the single stack in state (mirrors `cdkd deploy`
  / `cdkd destroy`); fails with a listing if state has more than one
  stack.
- `--all` — drift-check every stack in the state bucket.
- `--stack-region <region>` — region to inspect when a stackName has
  state in multiple regions (mirrors `cdkd state show`).
- `--json` — emit a structured per-stack report (see below). Detection
  output only — the resolution paths print a plain-text plan + summary.
- `--accept` — write the AWS-current values back into cdkd state (state
  ← AWS) for every drifted property. By default this updates
  `observedProperties` (the deploy-time snapshot used as the drift
  baseline) so the next drift run reports clean, while leaving
  `properties` (the user's last-deployed template intent) untouched. For
  resources without `observedProperties` (older state, providers without
  `readCurrentState`) the mutation falls back to `properties`, matching
  the pre-v3 behavior. Requires a stack lock. Mutually exclusive with
  `--revert`. See "Resolving drift" below.
- `--revert` — call `provider.update` to push cdkd state values back
  into AWS (AWS ← state) for every drifted resource. The values passed
  to `provider.update` are constructed as the AWS-current snapshot with
  the drifted top-level subtrees overlaid from
  `observedProperties ?? properties` — same precedence as the
  comparator, so `--revert` undoes exactly the delta `cdkd drift`
  reported and leaves non-drifted attributes untouched. Requires a
  stack lock. Mutually exclusive with `--accept`. See "Resolving
  drift" below.
- `--dry-run` — for `--accept` / `--revert`: print the planned mutations
  and exit without acquiring a lock or hitting AWS / S3.
- `--concurrency <number>` — maximum concurrent `provider.update` calls
  during `--revert` (default `4`). No effect on `--accept` (writes are
  serialized per stack).
- `-y` / `--yes` — skip the confirmation prompt before writing state
  (`--accept`) or pushing changes back to AWS (`--revert`).
- `--state-bucket`, `--state-prefix`, `--profile`, `--verbose`,
  `--role-arn`, `--region` — same as on every other state-driven
  command. `--region` is deprecated (prefer `AWS_REGION` / your AWS
  profile) but still honored if passed (PR 5).

Exit codes:

| Exit | Meaning |
| --- | --- |
| `0` | Every inspected stack has zero drift, OR `--accept` / `--revert` resolved every drift cleanly. |
| `1` | Drift detected on at least one resource on at least one stack (detection-only mode), OR the command crashed (no state found, AWS error, bad arguments). Both go through the default error handler — drift detection emits the rich human report before throwing, so the report is the only output for the drift case. |
| `2` | `--revert` finished but one or more `provider.update` calls failed OR threw `ResourceUpdateNotSupportedError` (`PartialFailureError`). Successful resources are now in sync; re-run `cdkd drift <stack>` to see what's left, then either `cdkd drift <stack> --revert` (for the recoverable failures) or `cdkd deploy <stack> --replace` (for the update-not-supported ones). |

The command produces three terminal states per resource:

- **drifted** — at least one property differs between state and AWS.
  Reported as `~ <logicalId> (<type>)` with one `+/-` line per
  property path that diverged.
- **clean** — every state-recorded property matches AWS. Counted in
  the per-stack summary but not listed individually.
- **drift unknown** — the provider does not implement the optional
  `readCurrentState` method yet. Reported as `? <logicalId> (<type>)`
  in a separate block at the bottom of each stack's report.

Drift detection works automatically for every resource type that goes
through Cloud Control API (the majority of cdkd's surface). SDK
Providers add their own `readCurrentState` incrementally — providers
without an implementation surface as `drift unknown` rather than `clean`,
so you can see exactly which types are still uncovered.

The following SDK Providers ship with first-class `readCurrentState`
(no CC API round-trip):
- `AWS::Lambda::Function`, `AWS::S3::Bucket`, `AWS::DynamoDB::Table`,
  `AWS::IAM::Role`, `AWS::SQS::Queue`, `AWS::SNS::Topic`,
  `AWS::Logs::LogGroup` (PR D, batch 0)
- `AWS::CloudFront::CloudFrontOriginAccessIdentity`,
  `AWS::Events::EventBus`, `AWS::Events::Rule`,
  `AWS::SSM::Parameter`, `AWS::SecretsManager::Secret`,
  `AWS::ECR::Repository`, `AWS::StepFunctions::StateMachine`,
  `AWS::ECS::Cluster`, `AWS::ECS::Service`, `AWS::ECS::TaskDefinition`,
  `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`,
  `AWS::RDS::DBSubnetGroup`, `AWS::KMS::Key`, `AWS::KMS::Alias`,
  `AWS::ApiGateway::Account`, `AWS::ApiGateway::Method`,
  `AWS::ApiGatewayV2::Api`, `AWS::Cognito::UserPool` (batch 1)
- `AWS::AppSync::GraphQLApi`, `AWS::AppSync::DataSource`,
  `AWS::AppSync::Resolver`, `AWS::AppSync::ApiKey`,
  `AWS::EFS::FileSystem`, `AWS::EFS::AccessPoint`, `AWS::EFS::MountTarget`,
  `AWS::ElastiCache::CacheCluster`, `AWS::ElastiCache::SubnetGroup`,
  `AWS::ElasticLoadBalancingV2::LoadBalancer`,
  `AWS::ElasticLoadBalancingV2::TargetGroup`,
  `AWS::ElasticLoadBalancingV2::Listener`,
  `AWS::Route53::HostedZone`, `AWS::Route53::RecordSet`,
  `AWS::WAFv2::WebACL`,
  `AWS::KinesisFirehose::DeliveryStream`, `AWS::Kinesis::Stream`,
  `AWS::Glue::Database`, `AWS::Glue::Table`,
  `AWS::CloudTrail::Trail`, `AWS::CloudWatch::Alarm`,
  `AWS::CodeBuild::Project`,
  `AWS::ServiceDiscovery::PrivateDnsNamespace`,
  `AWS::ServiceDiscovery::Service`,
  `AWS::SNS::Subscription` (batch 2)
- `AWS::IAM::Policy`, `AWS::Lambda::Permission`,
  `AWS::ApiGateway::Authorizer`, `AWS::ApiGateway::Resource`,
  `AWS::ApiGateway::Deployment`, `AWS::ApiGateway::Stage`,
  `AWS::ApiGatewayV2::Stage`, `AWS::ApiGatewayV2::Integration`,
  `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Authorizer`
  (PR G — sub-resource batch; receives `properties` so the parent
  `RestApiId` / `ApiId` / `FunctionName` / `Roles[]` is available to
  issue the matching `Get*` call)
- `AWS::ServiceDiscovery::HttpNamespace`,
  `AWS::ServiceDiscovery::PublicDnsNamespace` (issue #1044)

Tag drift is supported across the SDK Providers listed above (and the CC
API fallback). cdkd filters out CDK / AWS-internal `aws:`-prefixed entries
(notably `aws:cdk:path` and `aws:cdk:metadata`) from the AWS-current
snapshot before comparing — those are injected by CDK as construct
metadata, not as user-managed `Tags` properties, so leaving them in would
fire false-positive drift on every CDK-deployed resource. The remaining
user tags are normalized to CFn's `[{Key, Value}]` shape (sorted by `Key`
for stable comparison) and the result key is omitted entirely when AWS
reports no user tags. IAM Role / User / Group inline-policy bodies are
covered (paginated `List*Policies` + parallel `Get*Policy` round-trips
with state-driven order reconciliation) since PR #175;
see [src/types/resource.ts](../src/types/resource.ts) for the per-provider
shape decisions.

Still reporting `drift unknown` (deferred):

- `AWS::CloudFront::Distribution` defers to the CC API fallback — its
  `DistributionConfig` schema uses the SDK's `Quantity + Items` shape vs
  CFn's flat array shape, and mirroring the conversion would balloon the
  diff for marginal gain over the CC API path.
- `AWS::AppSync::GraphQLSchema` body drift is deferred — AWS's
  `GetIntrospectionSchema` returns SDL bytes but normalizes the schema
  on the way out (canonical field ordering, comment / whitespace
  stripping), so a direct string comparison against the user-authored
  `Definition` in cdkd state would fire constantly on cosmetic diffs.
  A meaningful comparison needs an SDL parser to canonicalize both
  sides before diff, which is out of scope.
- `AWS::Kinesis::StreamConsumer` falls through to the CC API fallback;
  the SDK provider only handles `AWS::Kinesis::Stream`. A dedicated
  SDK impl would require building out create / update / delete first.

`--json` output shape:

```json
[
  {
    "stack": "MyStack",
    "region": "us-east-1",
    "drifted": [
      {
        "logicalId": "Bucket1",
        "type": "AWS::S3::Bucket",
        "changes": [
          {
            "path": "VersioningConfiguration.Status",
            "stateValue": "Enabled",
            "awsValue": "Suspended"
          }
        ]
      }
    ],
    "clean": [],
    "notSupported": [
      { "logicalId": "Function1", "type": "AWS::Lambda::Function" }
    ]
  }
]
```

The comparator only looks at keys present in cdkd state — AWS-managed
fields (timestamps, generated identifiers, account-wide defaults) that
cdkd never set are ignored, so they never surface as false-positive
drift.

### False-drift prevention for the CC API fallback

When an SDK Provider doesn't yet implement `readCurrentState`, drift
falls back to Cloud Control API's generic `GetResource`. cdkd state's
`properties` field is in CFn-template shape (what `provider.create()`
was passed); CC API's response is usually the same shape, but for some
resource types it diverges enough to fire false-positive drift on
every run. Two guards protect the fallback:

1. **Deny-list** (`src/analyzer/drift-cc-api-deny-list.ts`) — types
   with verified structural divergence (e.g. `AWS::ApiGateway::RestApi`'s
   write-only `Body` field, or `AWS::EC2::LaunchTemplate`'s
   version-bumped `LaunchTemplateData`) short-circuit to `drift unknown`
   before the CC API call ever fires. The fix path for any deny-listed
   type is a first-class SDK-provider `readCurrentState`, not a
   per-entry tweak — once the provider implements it, the deny-list
   entry is unreachable.
2. **Strip pass** (`src/analyzer/cc-api-strip.ts`) — known AWS-managed
   timestamp / owner / generated-id fields (`CreationDate`,
   `LastModifiedTime`, `OwnerId`, `RevisionId`, ...) are removed from
   CC API responses before the comparator sees them. The strip list is
   conservative: name-collision-prone fields that some CFn types use
   as legitimate inputs (`Status`, `State`, `VersionId`, `Arn`, ...)
   are NOT stripped, so a real `Status` change on
   `AWS::ECS::CapacityProvider.ManagedScaling` still surfaces as
   drift.

A breadth-of-coverage shape fixture suite
(`tests/unit/analyzer/drift-cc-api-shape-fixtures.test.ts`) verifies
~10 representative CC-API-fallback types produce zero drift on a
clean stack. When a new shape regression is reported, add the type
either to the fixture suite (if the strip list catches it) or to the
deny-list (if the divergence is structural).

### Resolving drift (`--accept` / `--revert`)

Once `cdkd drift` has detected drift, the same command can also resolve
it. The two flags are mutually exclusive — pick the direction that
matches the intent:

- **`--accept`** (state ← AWS) — write the AWS-current values back
  into cdkd's S3 state file. Use this when the AWS-side change is the
  intentional source of truth (typically a manual console edit you want
  cdkd to "catch up" to without re-deploying). The cdkd state ETag
  captured during the read is forwarded to `S3StateBackend.saveState`
  as `IfMatch` for optimistic locking, so a concurrent `cdkd deploy`
  cannot race the write. AWS resources are NOT modified.

- **`--revert`** (AWS ← state) — call each drifted resource's
  `provider.update` to push state values back into AWS for the
  drifted properties. `properties` is built as the AWS-current
  snapshot (captured during the drift read, no second AWS call) with
  the **drifted top-level subtrees overlaid from cdkd's
  `observedProperties`**, and `previousProperties` is the AWS-current
  snapshot itself. Net effect: every drifted property is pushed back
  to its state-recorded value; non-drifted properties carry their
  AWS-current values, so a diff-based `update()` (e.g. SNS, IAM Role)
  sees `newVal === oldVal` for them and does not touch the AWS
  resource for those keys. Use this to undo a manual AWS console
  change. Per-resource failures are collected and surface as
  `PartialFailureError` (exit 2) at the end of the run; one resource's
  failure does not abort the rest. cdkd state is NOT modified by
  `--revert` — once `provider.update` succeeds, AWS values match state
  by definition, so a subsequent `cdkd drift` reports `clean`.

  **Update-not-supported resources.** Some resource types are immutable
  in AWS (e.g. `AWS::Lambda::LayerVersion`, sub-resource attachments
  like `AWS::Lambda::Permission`, `AWS::ApiGateway::Deployment`) or do
  not yet have an in-place `update()` implementation in cdkd
  (`AWS::AppSync::*`, `AWS::EFS::*`, `AWS::KinesisFirehose::DeliveryStream`,
  `AWS::ApiGatewayV2::*`, `AWS::ApiGateway::Authorizer` /
  `Deployment` / `Method`, `AWS::Glue::Database`,
  `AWS::ServiceDiscovery::*`, `AWS::ElasticLoadBalancingV2::LoadBalancer`).
  For those, `--revert` surfaces a distinct `⊘ <stack>/<id> (<type>):
  could not revert — ...` line with a `ResourceUpdateNotSupportedError`
  and an explicit suggestion. The summary then names them separately
  ("`N reverted, M update-not-supported`") and the run exits `2`. The
  fix is to **re-deploy the stack with `cdkd deploy --replace`**, or
  destroy + redeploy — the same recovery path you would use for a
  CloudFormation immutable-property error. AWS update failures (a
  successful `provider.update()` call returning a runtime error) are
  reported separately with a `✗` glyph and counted as `failed`; the
  fix there is to inspect the AWS error and retry once the underlying
  cause is resolved.

Both flags acquire the per-stack lock (the same one `cdkd deploy` uses)
before mutating anything, and prompt for confirmation unless `-y` /
`--yes` is set. `--dry-run` prints the planned mutations and exits 0
without acquiring a lock or hitting AWS / S3.

`--accept` is a no-op on a clean stack (no drift, nothing to write).
`--revert` is likewise a no-op on a clean stack (no drift, nothing to
push). Resources surfaced as `unsupported` (provider has no
`readCurrentState` yet) are skipped by both flags — the comparator
never produced a `PropertyDrift` for them.

## `--remove-protection`: bypass deletion protection on destroy

`cdkd destroy --remove-protection` and `cdkd state destroy
--remove-protection` flip every protection flag off in-place
before each provider's delete API call so the destroy proceeds
without an intermediate edit / redeploy / console click. Covers
**stack-level** `terminationProtection` (the bypass logs a WARN
line naming the stack — `cdkd state destroy` already ignores
`terminationProtection` because the flag is a CDK property
surfaced via synth, so the flag is effectively a no-op there for
that part) AND **resource-level** protection on the following
types:

| Resource type | Protection field | Bypass call |
| --- | --- | --- |
| `AWS::Logs::LogGroup` | `DeletionProtectionEnabled` | `PutLogGroupDeletionProtection(deletionProtectionEnabled=false)` |
| `AWS::RDS::DBInstance` | `DeletionProtection` | `ModifyDBInstance(DeletionProtection=false, ApplyImmediately=true)` |
| `AWS::RDS::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` |
| `AWS::DocDB::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` (DocDB SDK) — DocDB DBInstance has no `DeletionProtection` field, so no per-instance bypass; cluster-level covers the common case |
| `AWS::Neptune::DBCluster` | `DeletionProtection` | `ModifyDBCluster(DeletionProtection=false, ApplyImmediately=true)` (Neptune SDK) |
| `AWS::Neptune::DBInstance` | `DeletionProtection` | `ModifyDBInstance(DeletionProtection=false, ApplyImmediately=true)` (Neptune SDK) |
| `AWS::DynamoDB::Table` | `DeletionProtectionEnabled` | `UpdateTable(DeletionProtectionEnabled=false)` then `DescribeTable` poll until `ACTIVE` |
| `AWS::EC2::Instance` | `DisableApiTermination` | `ModifyInstanceAttribute(DisableApiTermination={Value:false})` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | attribute `deletion_protection.enabled` | `ModifyLoadBalancerAttributes([{Key: 'deletion_protection.enabled', Value: 'false'}])` |
| `AWS::Cognito::UserPool` | `DeletionProtection` (`ACTIVE` / `INACTIVE`) | `UpdateUserPool(DeletionProtection='INACTIVE')` |
| `AWS::AutoScaling::AutoScalingGroup` | `DeletionProtection` (`none` / `prevent-force-deletion` / `prevent-all-deletion`) | `UpdateAutoScalingGroup(DeletionProtection='none')` followed by `DeleteAutoScalingGroup(ForceDelete=true)` so AWS terminates running instances as part of the delete |

Behavior:

- The flip-off call is **idempotent** — providers always issue it
  when the flag is set, regardless of whether the resource
  currently has protection on. AWS accepts the no-op (already-
  disabled) case without error.
- A failure of the flip-off itself (NotFound / similar) is logged
  at debug; the actual delete API call still runs and surfaces
  its own error message.
- This is **per-PR-level**: a single `--remove-protection` covers
  every protection-bearing type listed above. There is no per-
  type variant. If you need finer control, run a stack-only
  destroy and clean up the rest manually.
- The interactive confirmation prompt is updated when the flag is
  set: `About to destroy N resources from stack "X", REMOVING
  DELETION PROTECTION on K of them. Continue? (y/N)`. The
  default flips from `Y/n` to `y/N`. `--yes` / `-y` / `-f`
  skips the prompt.
- **RDS / Cognito gating change**: prior to this flag, the RDS
  DBInstance / DBCluster providers always issued
  `ModifyDB{Instance,Cluster}` with `DeletionProtection: false`
  before destroy, and the Cognito UserPool provider always issued
  `DescribeUserPool` + (if `ACTIVE`) `UpdateUserPool
  (DeletionProtection='INACTIVE')` before destroy. Both implicit
  behaviors are now gated on `--remove-protection` to match the
  other types — destroying an RDS or Cognito UserPool resource
  whose deletion protection was set externally (console / AWS CLI)
  without `--remove-protection` will surface AWS's
  `InvalidParameterCombination` / `InvalidParameterException`
  error rather than silently succeed.
- Protection types not in the table above (CloudFront
  Distributions, S3 bucket retention, etc.) are out of scope —
  the list is curated to the cases where AWS exposes a
  synchronous "flip protection off" API call.

```bash
# Stack with terminationProtection: true OR a protected DynamoDB / RDS / Logs / EC2 / LB
cdkd destroy MyStack --remove-protection
cdkd destroy --all --remove-protection -y

# CDK-app-free counterpart — the resource-level flip applies the same way;
# stack-level terminationProtection is already ignored by `state destroy`.
cdkd state destroy MyStack --remove-protection -y
```

## `--purge-events`: also delete deployment-event history on destroy

By default `cdkd destroy` removes `state.json` / `lock.json` but **keeps** the
stack's deployment-event history (the issue #808 `deployments/` store) as
post-mortem context — so the state bucket does not return fully empty after a
teardown. `cdkd destroy <stack> --purge-events` (issue
[#885](https://github.com/go-to-k/cdkd/issues/885)) opts into purging that
history too, so the bucket returns to empty:

```bash
cdkd destroy MyStack --purge-events -y
```

- The purge runs **only after a clean, non-interrupted destroy** of that
  stack. On a failed / interrupted destroy the events are kept — they are
  exactly the post-mortem you want when retrying.
- Best-effort: a purge failure logs a warning but never fails the
  already-successful destroy.
- `state destroy` does NOT take this flag; for an already-destroyed stack (or
  the CDK-app-free path) use the equivalent `cdkd events prune <stack> --all`.
- Per-stack: when destroying multiple stacks, each clean stack's history is
  purged independently.

## `cdkd rollback` (revert a failed deploy)

`cdkd rollback [STACK]` reverts a stack to its pre-deploy state after a
deploy that failed with `--no-rollback`, was interrupted with Ctrl+C, or
whose automatic rollback died partway. It is the cdkd equivalent of
`cdk rollback` / CloudFormation `RollbackStack`, and the third option (next
to fix-forward `cdkd deploy` and clean-up `cdkd destroy`) after such a
failure. Issue [#1183](https://github.com/go-to-k/cdkd/issues/1183).

**Synth-free.** Everything it needs lives in cdkd state plus a **rollback
journal** — the exact `CompletedOperation[]` of the failed deploy, persisted
to `s3://bucket/cdkd/{stack}/{region}/rollback-journal.json` (a sibling of
`state.json`) whenever a deploy ends without a completed rollback. The
command loads that journal and replays it in reverse (delete created
resources; restore updated ones to their previous properties) via the same
rollback executor the in-process automatic rollback uses. No CDK app is
needed — a broken app is a common reason to roll back.

```bash
cdkd rollback MyStack          # roll back one stack
cdkd rollback                  # no arg: the single journaled stack (else lists candidates, exits 1)
cdkd rollback MyStack --force  # skip the confirmation prompt
cdkd rollback MyStack --orphan MyBucket --orphan MyTable
cdkd rollback MyStack --stack-region us-west-2
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--force` | Skip the confirmation prompt (`-y` / `--yes` also works). |
| `--orphan <logicalId>` | Repeatable. Skip the resource during replay, like `cdk rollback --orphan`. An orphaned CREATE is left in AWS and removed from state; an orphaned UPDATE is left at its new properties with state kept as-is. |
| `--revert-failed` | Also attempt to revert the resource whose operation **FAILED** mid-deploy (issue [#1198](https://github.com/go-to-k/cdkd/issues/1198)). Off by default because the failed resource's remote state is unknown (the op died partway): a failed UPDATE is force-reverted to its pre-deploy properties (the journal records the *attempted* properties, so patch-based providers generate a real undo diff); a failed CREATE that recorded no physical id is skipped with a warning; a failed DELETE needs no revert (the resource is still in place). Each handled failed op is stripped from the journal segment immediately (per-op), so a later completed-op failure that keeps the segment for a re-run only re-attempts what is genuinely outstanding — never a revert that already succeeded. |
| `--stack-region <region>` | Disambiguate when the same stack name has state in multiple regions (same UX as the `state` subcommands). |
| `--role-arn <arn>` | Assume-role before touching AWS. If the journal recorded a role and the flag is not passed, an informational note is printed. |
| `--state-bucket <bucket>` | Same resolution as other commands. |
| `--verbose` | Standard debug logging. |

**Flow**: resolve the stack + region → acquire the stack lock (a concurrent
deploy holding it fails the command with the standard lock error;
`cdkd force-unlock` applies) → print a per-segment plan → confirm (skipped by
`--force`) → replay segments newest-first, saving state after each op and
popping each segment when it finishes cleanly → if the oldest replayed
segment was the stack's first-ever deploy and state is now empty, delete
`state.json` too. Replay is idempotent: re-running after a partial rollback
skips resources already reverted.

**Exit codes**: `0` = fully clean (journal deleted); `2` = partial (one or
more ops failed best-effort, or were skipped with a warning — the journal is
kept so you can re-run); `1` = hard error (no journal, lock held,
credentials, etc.).

**Known limitations** (surfaced in the plan, not silent):

- A resource that was **DELETED** during the deploy cannot be restored (same
  as CloudFormation). Deletes run after creates/updates, so a typical
  mid-deploy failure has not deleted anything yet.
- The resource whose operation **failed** is left as-is by default. The
  journal records the failed op (its pre-op state + the attempted
  properties), and `--revert-failed` opts in to reverting it (issue
  [#1198](https://github.com/go-to-k/cdkd/issues/1198)) — opt-in because the
  failed resource's remote state is genuinely unknown. A failed CREATE that
  recorded no physical id still cannot be acted on (skipped with a warning).
  Note: after a **clean automatic** rollback the journal is settled to a
  **failed-only** segment (`operations: []` plus the failed op records —
  issue [#1208](https://github.com/go-to-k/cdkd/issues/1208)): the completed
  ops are already reverted, but the failed resource's record is kept so
  `cdkd rollback --revert-failed` works in the DEFAULT deploy flow too. A
  plain `cdkd rollback` on such a journal is a no-op replay that clears it;
  the next successful deploy also deletes it.
- **Replacements** are reverted by **reversing the replacement** (issue
  [#1199](https://github.com/go-to-k/cdkd/issues/1199)): the old resource is
  re-CREATEd from its journaled pre-deploy state and the new resource is
  deleted (create-first; a user-supplied physical name still held by the new
  resource falls back to delete-new-first with a bounded name-release retry).
  Under `UpdateReplacePolicy: Retain` the orphaned old resource still exists,
  so it is simply re-adopted after the new one is deleted — a true clean
  revert. **Data caveat:** for a stateful type (DynamoDB / RDS / S3 / etc.)
  the old resource's data was destroyed by the replacement and cannot be
  recovered — the re-created resource starts empty (warned loudly in the
  replay; the plan labels these "reverse-replace").
- Reverts that reference old **asset objects** (e.g. Lambda `Code.S3Key`)
  need those objects to still exist — relevant to `cdkd gc` retention.

`cdkd export` refuses (with a confirmation gate) to hand a stack over to
CloudFormation while a rollback journal exists — the half-deployed state is
almost certainly not what you want exported; roll back or re-deploy first.

## Exit codes

cdkd commands distinguish three outcomes via the process exit code so
CI / bench scripts can react without grepping log output:

| Exit | Meaning | Emitted by |
| --- | --- | --- |
| `0` | Success — command completed and no resources are in an error state | All commands |
| `1` | Command-level failure — auth error, bad arguments, synth crash, unhandled exception. **`cdkd drift` also exits `1` when drift is detected**, and **`cdkd diff --fail` exits `1` when any change is detected** (the operative meaning is "non-zero outcome", not "command crashed") | All commands (default for any thrown error) |
| `2` | **Partial failure** — work completed but one or more resources failed; state.json is preserved and re-running typically resolves it | `cdkd destroy`, `cdkd state destroy` (per-resource delete failures), `cdkd publish-assets` (per-stack asset publish failures), `cdkd rollback` (per-op failures / skipped-with-warning ops; the journal is kept for re-run) |

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

## `cdkd export` (hand a stack over to CloudFormation)

`cdkd export <stack>` is the mirror of `cdkd import` (AWS → cdkd) in
the reverse direction (cdkd → CloudFormation). It builds a CFn
`ChangeSetType=IMPORT` changeset from cdkd state + the synthesized
template, executes it, and deletes cdkd state on success. AWS resources
are unchanged across the migration.

```bash
cdkd export MyStack                              # confirmation prompt; CFn stack name = cdkd stack name
cdkd export MyStack --cfn-stack-name MyStack-CFn
cdkd export MyStack --dry-run                    # print the import plan, no CFn calls
cdkd export MyStack --template path.json         # pre-rendered template (JSON or YAML — format auto-detected, skip synth)
cdkd export                                       # auto-detect single-stack apps
```

**Flow**:

1. Synthesize the CDK app (or read `--template <path>`) to get the
   CloudFormation template.
2. Load cdkd state for the target stack; build the
   `(logicalId, physicalId, resourceType)` map.
3. Refuse if a CFn stack with the destination name already exists, or
   if any template resource is in the **blocked** set (template
   resources without a cdkd state entry; or `AWS::CloudFormation::Stack`
   rows whose parent cdkd state has no matching nested-stack entry). Lambda-backed Custom Resources (`Custom::*` AND
   `AWS::CloudFormation::CustomResource` — the latter is what
   `new cdk.CustomResource(...)` synthesizes when no `resourceType` is
   passed) are NOT blocked but require `--include-non-importable` to
   run the 2-phase flow described below. `AWS::CloudFormation::Stack`
   rows whose parent state has a matching nested-stack entry are
   classified into a dedicated `nestedStackRows` list and exported via
   the **per-stack IMPORT loop** (issue
   [#464](https://github.com/go-to-k/cdkd/issues/464) PR B2): the
   orchestrator recursively walks the cdkd state tree via
   `buildCdkdStateStackTree` and submits IMPORT changesets per
   cdkd-managed stack in leaf-first order. Leaf stacks get a single
   CREATE-via-IMPORT changeset; non-leaf parents get two per parent
   (Phase 1A CREATE-via-IMPORT for the parent's leaf resources only,
   then Phase 1B UPDATE-via-IMPORT against the now-existing parent to
   adopt the already-IMPORTed children via the AWS-docs "Nest an
   existing stack" pattern). Phase 1B injects
   `DeletionPolicy: Retain` plus
   `ResourceIdentifier: { StackId: <child arn> }` plus a `TemplateURL`
   rewritten to point at the child's AWS-canonicalized template
   fetched via `GetTemplate(Processed)` post-IMPORT plus child Tags
   forwarded from `DescribeStacks` (AWS's "Nested stack import
   validation" rejects tag mismatches). Between phases each non-root
   stack is flipped from `IMPORT_COMPLETE` to `UPDATE_COMPLETE` via a
   no-op tag-only `UpdateStack` (AWS rejects `IMPORT_COMPLETE` as a
   non-importable status for nesting; the flip adds a transient
   `cdkd:nested-export-flip` tag that Phase 1B then forwards verbatim
   into the parent template). Each
   child cdkd stack `<parent>~<childLogicalId>` becomes its own CFn
   stack named `<parent>-<childLogicalId>` by default (`~` is illegal
   in CFn stack names); per-child overrides via
   `--cfn-child-stack-name '<cdkdName>=<cfnName>'` (repeatable).
   Per-child Parameters are forwarded from the parent template's
   `AWS::CloudFormation::Stack.Properties.Parameters` block — literal
   string / number / boolean values pass through, and intrinsic-valued
   Parameters (`{Ref: <ParentParam>}` / `{Fn::GetAtt: [ParentResource,
   Attr]}`) are resolved at IMPORT time against the parent's resolved
   Parameters + cdkd state (a root-first pre-pass, since a child's
   Parameters resolve against its parent's). A value cdkd cannot resolve
   degrades to a warning and the child template's Parameter `Default`
   must cover it. The original "one atomic `--include-nested-stacks` IMPORT
   changeset" design was found infeasible by the 2026-05-24 AWS spike —
   AWS rejects that flag combination with
   `ValidationError: IncludeNestedStacks is not supported for changeSet type: IMPORT`;
   see [docs/design/464-nested-stacks-export-import.md](design/464-nested-stacks-export-import.md)
   §4.0 / §4.3 for the per-stack-loop algorithm. `--dry-run` prints
   the per-stack plan summary without acquiring child locks or
   submitting any changeset.
4. Resolve each resource type's primary identifier property name(s) via
   `cloudformation:DescribeType` (with a hardcoded fallback table for
   ~30 single-key types). **Composite primary identifiers**
   (`primaryIdentifier.length > 1`) are supported for
   `AWS::ApiGateway::Method`, `AWS::ApiGateway::Resource`,
   `AWS::EC2::VPCGatewayAttachment`, `AWS::ApiGatewayV2::Integration`,
   `AWS::ApiGatewayV2::Route`, and `AWS::Lambda::Permission` via a
   per-type splitter that maps cdkd's `physicalId` (plus the resource's
   recorded `properties` for sub-resource types where the parent
   identifier — `ApiId` / `FunctionName` — lives in `properties`, not
   in `physicalId`) to the field map `ResourceIdentifier` expects.
   Sub-resource types whose primaryIdentifier includes an AWS-generated
   id (`IntegrationId` / `RouteId` / Lambda::Permission's `Id`) narrow
   the `Properties` overlay to the writable subset so CFn doesn't reject
   the changeset with "Encountered unsupported property". Other composite
   types abort with a clear error pointing at where to register a new
   splitter in `src/cli/commands/export.ts`. **IMPORT-unsupported
   types** (CFn schema lacks the handlers needed for IMPORT lookup —
   either `handlers: []` outright, or no `read` / `list` handler so CFn
   can't look the resource up by identifier) are auto-handled via a
   pre-delete + phase-2-CREATE dance: cdkd skips the resource from
   phase 1, deletes the AWS-side resource between phases via the
   appropriate SDK call, and lets CFn re-CREATE in phase 2.
   Currently registered:
   - `AWS::ApiGatewayV2::Stage` (`handlers: []`; auto-emitted by CDK's
     `HttpApi` construct as `$default`; pre-delete via
     `apigatewayv2:DeleteStage`). Brief unavailability window ~10s;
     HttpApi endpoint URL is unchanged because it embeds ApiId, not
     StageName.
   - `AWS::IAM::Policy` (`handlers: ['create', 'delete', 'update']` — no
     `read` / `list` because inline policy attachments have no
     first-class AWS resource id; auto-emitted by CDK L2 grants such as
     ECS Task Execution Role ECR pull policy and Lambda execution role
     inline policies; pre-delete via `iam:DeleteRolePolicy` /
     `DeleteUserPolicy` / `DeleteGroupPolicy` per attachment target).
     The inline policy attachment is dropped from each Role / User /
     Group between phases — any in-flight AWS API call that depends on
     the granted permission will fail with `AccessDenied` until CFn
     re-CREATEs in phase 2.

   Pass `--no-recreate-import-unsupported` to block instead of
   auto-handling. Per-type config lives in `IMPORT_UNSUPPORTED_RECREATABLE_TYPES`
   and `PRE_DELETE_HANDLERS` in `src/cli/commands/export.ts`.
5. Acquire the stack lock so concurrent `cdkd deploy` cannot race.
6. Confirm with the user (skipped with `-y` / `--yes`).
7. **Preprocess the phase-1 template** (automatic; required by CFn IMPORT
   contract):
   - **Strip Outputs entirely.** CFn rejects IMPORT changesets that
     declare ANY Outputs with "you cannot modify or add [Outputs]".
     Phase 2 UPDATE re-submits the full synth template and restores
     Outputs along with the non-importable resources.
   - **Inject `DeletionPolicy: Delete`** on resources that lack the
     attribute. CFn IMPORT requires `DeletionPolicy` on every imported
     resource, and CDK synth only emits it when `RemovalPolicy` is
     explicitly set. cdkd injects `Delete` (not `Retain`) so the
     post-export CFn template matches the CFn type-default — same as
     what plain CFn would have applied for a resource without explicit
     `RemovalPolicy`. The user sees no surprising `Retain` attribute
     and the post-export `cdk diff` has no DeletionPolicy noise.
     `UpdateReplacePolicy` is intentionally NOT injected (only
     `DeletionPolicy` is required for IMPORT).
   - **Conditional overlay of `ResourceIdentifier` onto `Properties`.**
     Mirrors upstream `cdk import` behavior: pass the synth template
     through and let CFn match resources via
     `ResourcesToImport[].ResourceIdentifier` (the changeset API
     parameter) alone, except when the synth template carries a
     *literal-string* value for the field that *differs* from
     `ResourceIdentifier`. Three cases:
     - **Absent** (auto-generated names — user did NOT declare a
       physical name in CDK code): `Properties[<NameField>]` stays
       absent. CFn accepts the IMPORT changeset using
       `ResourceIdentifier` alone (verified against AWS in upstream
       `cdk import`). Post-export `cdk diff` is clean because both
       CFn-managed template and CDK synth have the property absent.
     - **Intrinsic** (composite-id sub-resources whose synth references
       the parent via `{Ref: ...}` / `{Fn::GetAtt: ...}` — Integration /
       Route / Lambda::Permission / API Gateway Method etc.): the
       intrinsic is preserved. CFn resolves it during changeset
       processing against the parent's own `ResourceIdentifier` (the
       parent is imported in the same changeset), so the resolved value
       equals `ResourceIdentifier[<field>]` and CFn accepts. Post-export
       `cdk diff` stays clean (both sides keep the intrinsic shape).
     - **Literal-mismatch** (pre-v0.94.0 prefix-on-user-declared-name
       legacy: user wrote `roleName: 'foo'` in CDK code; cdkd's deploy
       prefixed it to `'CdkSampleStack-foo'` on AWS): override
       `Properties.RoleName` from the unprefixed CDK value to the
       prefixed AWS value. CFn's identifier-match check requires this
       — otherwise AWS rejects with `The Identifier [<Field>] for
       resource [...] does not match the identifier value for the
       resource in the template`. The overlay persists into the
       post-import CFn template; the next `cdk deploy` proposes
       REPLACE — same caveat as upstream `cdk import` with
       mismatched-name CDK code (see the "Replacement risk on next
       deploy" caveat below). The prefix-migration pre-flight (PR #300)
       is meant to surface this before export. v0.94.0+ stacks with the
       default `--no-prefix-user-supplied-names` flip are NOT in this
       case — `Properties.RoleName` matches the AWS name without
       override.

     Closes [issue #319]: pre-v0.95 cdkd unconditionally injected
     `ResourceIdentifier` values into `Properties` even when the synth
     had no value for that field, baking cdkd-prefixed auto-gen names
     AND composite-id literals into the post-export CFn template →
     post-export `cdk diff` proposed REPLACE on every auto-named
     resource and every composite-id sub-resource (defeating the
     migration's "AWS resources unchanged" promise). v0.95+ overlay is
     conditional; only the literal-mismatch legacy case still carries
     the documented post-export caveat.
8. `CreateChangeSet --change-set-type IMPORT` → wait → `ExecuteChangeSet`
   → `waitUntilStackImportComplete`. On failure cdkd fetches
   `DescribeStackEvents` and surfaces the per-resource failure reasons
   (the waiter alone only reports the high-level rollback state).
9. Delete cdkd state for the migrated stack.
10. Release lock.

**MVP scope** (intentional cuts; lift in follow-up PRs):

- **JSON and YAML templates supported.** Both formats round-trip through
  cdkd's CFn-aware codec (`src/cli/yaml-cfn.ts`), which preserves every
  CFn shorthand intrinsic (`!Ref`, `!Sub`, `!GetAtt`, `!Join`, …) across
  the parse → preprocess → re-serialize cycle. The phase-1 IMPORT and
  phase-2 UPDATE changesets emit in the same format as the source
  template — a YAML-authored CFn stack stays YAML on the wire.
- **Cross-stack consumer scan** runs at synth time when other stacks in
  the same CDK app reference the exporting stack via
  `Fn::GetStackOutput`. By default cdkd warns (the user is expected to
  migrate consumer stacks in a follow-up); `--strict-cross-stack`
  refuses. Without `Fn::GetStackOutput` (or with consumer stacks
  outside the CDK app), no scan can run and the user is responsible for
  the check.
- **Drift baseline pre-flight** surfaces a warning when cdkd state lacks
  `observedProperties` for one or more resources. Without that baseline
  `cdkd drift` cannot reliably compare against AWS, so the next
  `cdk deploy` post-migration may surface unexpected changes if AWS has
  drifted from the synth template. Resolve by running
  `cdkd state refresh-observed <stack>` (or any redeploy) before
  exporting, then `cdkd drift <stack>` to verify. Non-blocking by
  design — the user decides whether to proceed.
- **Template Parameters** in the synthesized template are forwarded to
  both phase-1 and phase-2 changesets. Each parameter is resolved in
  order: (1) `--parameter Key=Value` CLI override (repeatable), then
  (2) the template's `Default`. A parameter with neither override nor
  default aborts with a clear error listing which keys are missing.
  A `--parameter` override for a key the template does not declare is
  also rejected (catches typos). CDK-generated templates typically only
  carry `BootstrapVersion` with a default; `cdkd export` works without
  any `--parameter` for those.
- **Lambda-backed Custom Resources** (`Custom::*` AND
  `AWS::CloudFormation::CustomResource`) require `--include-non-importable`
  to opt into the 2-phase flow: phase 1 IMPORT changeset for the
  importable resources, then phase 2 UPDATE changeset for the full
  template — CFn CREATEs the Custom Resources, which re-invokes each
  backing Lambda's onCreate handler. The handler must be (1) idempotent
  (same `PhysicalResourceId` / `Data` on every event type) AND
  (2) correctly do the cfn-response protocol (PUT a Status/PhysicalResourceId
  payload to `event.ResponseURL`). cdkd's deploy path also accepts a
  return-value fast path for handler responses, but CFn-side phase-2
  UPDATE / future rollback / future `cdk deploy` against the imported
  stack all require the actual ResponseURL POST — a CR backed by a
  return-only Lambda will time out at the CFn 1-hour Custom Resource
  ceiling. Without the flag, the CR types in the template cause the
  command to abort. `AWS::CloudFormation::Stack` (nested stacks) is
  fully supported as of issue [#464](https://github.com/go-to-k/cdkd/issues/464)
  PR B2: the dedicated branch + `buildCdkdStateStackTree` walker
  recursively loads every child state file, validates the tree shape,
  and `runPerStackImportLoop` submits one IMPORT changeset per
  cdkd-managed stack in the tree in leaf-first order. Non-leaf parents
  adopt their just-imported children via the AWS-docs "Nest an
  existing stack" pattern (the original
  `--include-nested-stacks` design was found infeasible by the
  2026-05-24 AWS spike — see [design/464-nested-stacks-export-import.md](design/464-nested-stacks-export-import.md)
  §4.0 / §4.3 for the per-stack-loop algorithm). On per-stack failure,
  cdkd state for the failed stack and every yet-to-be-imported stack
  is preserved; the error message names which stacks moved and which
  remain so the user can re-run `cdkd export <parent>` after fixing
  the underlying cause (already-imported children will be re-adopted
  as nested references on retry). On phase-2 failure, cdkd state is
  preserved and the error message includes the recovery procedure
  (`aws cloudformation create-change-set --change-set-type UPDATE ...`
  followed by `cdkd state orphan`).
- **Inline `TemplateBody` only** (51,200-byte cap). Templates larger than
  that require S3 upload via `TemplateURL`; not yet implemented.
- **Synth template used verbatim**: cdkd does NOT substitute `observedProperties`
  into the template. If the CDK code has drifted from the AWS-current state,
  the next `cdk deploy` after migration will update the resource. Run
  `cdkd drift` before exporting if drift matters.

**Context preservation (CLI `-c` is refused by default)**:

CDK reads context from `cdk.json` and `cdk.context.json` on every
synth. CLI `-c key=value` overrides are NOT persisted to either file
— they apply only to the current invocation. If you run `cdkd export
-c env=prod` and later run `cdk deploy` without the same `-c env=prod`,
CDK synthesizes a different template, which CFn sees as drift / a
replacement on the first post-migration deploy.

`cdkd export` refuses by default when CLI `-c` overrides are present.
Two ways forward:

- **Recommended**: move the overrides into `cdk.json`'s `"context": { ... }`
  field, then re-run `cdkd export` without `-c`. Subsequent `cdk deploy`
  invocations read `cdk.json` automatically.
- **Escape**: pass `--accept-transient-context`. cdkd proceeds and emits
  a warn that names every override. You are then responsible for passing
  the SAME `-c` flags to every future `cdk deploy` for this stack (or
  moving them to `cdk.json` before then). On success, cdkd prints the
  exact `cdk diff` / `cdk deploy` command including the captured flags.

**Caveats**:

- **Replacement risk on next deploy** (post-v0.95, only one residual
  case — closes [issue #319]):
  - **Pre-v0.94.0 prefix legacy** (`--prefix-user-supplied-names` opt-in,
    or stacks deployed before v0.94.0 flipped the default): cdkd's deploy
    prefixed user-declared physical names with the stack name for
    cross-stack uniqueness (e.g. `roleName: 'my-role'` became
    `MyStack-my-role` on AWS). The phase-1 IMPORT preprocessing rewrites
    the template's name field to the prefixed value (otherwise CFn
    IMPORT rejects the identifier mismatch), and this prefixed value
    persists into the post-import CFn template. The next `cdk deploy`
    will see `MyStack-my-role` (CFn-recorded) vs `my-role` (CDK-declared)
    as a property change on an immutable name field → REPLACEMENT.
    Before the first post-export deploy, either change the CDK code to
    the prefixed value (`roleName: 'MyStack-my-role'`) or accept the
    replacement. The prefix-migration pre-flight (PR #300 /
    `prefix-migration-check.ts`) is meant to surface this before export.

  **No longer in this category as of v0.95** (closes [issue #319]):
  - Auto-generated names (user did NOT declare `bucketName: '...'` etc.):
    cdkd's overlay used to bake the cdkd-prefixed name into the
    post-export CFn template, causing every auto-named resource to be
    proposed for REPLACE on next `cdk deploy`. Post-v0.95 the overlay is
    conditional and skipped for this case → post-export `cdk diff` is
    clean for auto-gen names.
  - Composite-id sub-resources (`AWS::ApiGateway::Method` /
    `AWS::ApiGatewayV2::Integration` / `AWS::ApiGatewayV2::Route` /
    `AWS::Lambda::Permission` etc.): cdkd's overlay used to overwrite
    `Properties.ApiId` (intrinsic `{Ref: ...}`) with the resolved literal
    parent id, causing every composite sub-resource to be proposed for
    REPLACE on next `cdk deploy`. Post-v0.95 intrinsics are preserved →
    post-export `cdk diff` is clean for composite sub-resources.

  When the legacy prefix case applies, check the post-import changeset
  (`aws cloudformation create-change-set --change-set-type UPDATE`) for
  surprises before executing your first post-export `cdk deploy`.
- **Cross-stack `Fn::GetStackOutput` consumers** in other cdkd stacks
  cannot read the exported stack's outputs anymore (CFn outputs live in
  CloudFormation, cdkd's resolver reads cdkd state). Plan multi-stack
  migrations from the leaves up.

Exits `0` on success, `1` on any failure (changeset rejection, AWS
auth, lock contention, etc.). cdkd state is deleted only after the
import changeset completes successfully; a mid-flow failure leaves
cdkd state intact and the user can re-run the command.

## `publish-assets` (synth + build + publish, no deploy)

`cdkd publish-assets` runs the asset half of the deploy pipeline —
synthesize the CDK app, build any Docker images, upload file assets to
S3, push images to ECR — and then **stops**. No state writes, no
provisioning, no lock acquisition. This is the "CI builds and uploads
assets, a separate runner deploys" split that pipelines often want.

```bash
cdkd publish-assets                          # synth + publish all stacks (or auto-detect single stack)
cdkd publish-assets <stack> [<stack>...]     # synth + publish specific stack(s)
cdkd publish-assets --all                    # synth + publish every stack in the app
cdkd publish-assets 'My*'                    # wildcard
cdkd publish-assets -a cdk.out               # skip synth — read a pre-synthesized cloud assembly
```

Synthesizes the CDK app via the standard `--app` / `CDKD_APP` /
`cdk.json` chain, applies the same stack-name matching as
`deploy` / `diff` / `destroy` (positional arg routes by `/` to display
path or physical name; supports `*` wildcards), and feeds each selected
stack's asset manifest into the same `WorkGraph` pipeline that `deploy`
uses (with `stack: 0` concurrency so no stack-deploy nodes run).

`-a/--app` accepts either a shell command (`"node app.ts"`) or
a path to an already-synthesized cloud assembly directory (`cdk.out`);
when a directory is given, synthesis is skipped and the manifest is
read directly. Same dual semantics as `cdkd deploy`. Re-using a
pre-synthesized assembly is therefore covered by `-a <dir>` and
`publish-assets` does NOT have its own `--path <manifest>` flag.

Asset destinations follow the region's asset mode (issue
[#1002](https://github.com/go-to-k/cdkd/issues/1002)): the command reads the
per-region bootstrap marker from the state bucket (resolved via the standard
`--state-bucket` / `CDKD_STATE_BUCKET` / `cdk.json` / default chain — the
command never writes state) and, when the region is opted in, publishes to
the cdkd-owned storage so a subsequent `cdkd deploy` finds the assets where
its rewritten templates point. When no state bucket is resolvable at all,
the command falls back to the manifest destinations verbatim with an info
line. `--use-cdk-bootstrap-assets` pins the legacy destinations explicitly.

Concurrency knobs (same defaults as `deploy`):

| Option | Default | Description |
| --- | --- | --- |
| `--asset-publish-concurrency` | 8 | Maximum concurrent S3 uploads + ECR pushes |
| `--image-build-concurrency` | 4 | Maximum concurrent Docker image builds |

Exit codes:

- `0` — every selected stack's assets published cleanly.
- `1` — command-level failure (auth, synth crash, bad arguments).
- `2` — **partial failure**: one or more stacks failed but the rest
  published. Re-run to retry the failed stacks. Per-stack outcomes are
  listed in the run summary.

## `local *` (run AWS workloads locally)

The `cdkd local` command family runs AWS workloads on the developer's
machine — Lambda functions, API Gateway routes, ECS tasks, ECS
Services, ALB front-doors, CloudFront distributions, and Bedrock
AgentCore Runtimes — without an AWS deploy. Most commands run the
workload in Docker; `local start-cloudfront` serves a
CloudFront-Functions + S3-origin distribution in-process (no Docker),
falling back to Docker/RIE only for a Lambda Function URL origin. The
full reference for all `cdkd local *` subcommands (`local invoke` /
`local start-api` / `local run-task` / `local start-service` /
`local start-alb` / `local start-cloudfront` / `local invoke-agentcore` /
`local start-agentcore`) lives in
**[docs/local-emulation.md](local-emulation.md)**.

## `events` (read deployment-event history)

`cdkd events <stack>` reads back the structured deployment events cdkd
records for every `cdkd deploy` / `cdkd destroy` run — cdkd's local
equivalent of CloudFormation's `DescribeStackEvents`. Events are
persisted as JSONL under a `deployments/` key family separate from
`state.json` (no state schema bump), so a destroyed stack's failure
history stays readable. Event recording is best-effort and never blocks
the deploy / destroy; events carry error + metadata only (never resource
properties).

```bash
cdkd events MyStack                       # list runs, newest first
cdkd events MyStack --run <runId>         # one run's full event stream
cdkd events MyStack --format json         # machine-readable JSON (or --json)
cdkd events MyStack --stack-region <r>    # disambiguate multi-region history
```

### `events prune` (purge old event history)

The store self-bounds to the last 20 runs at write time, but `cdkd destroy`
deliberately keeps event history as post-mortem context, so it never returns
the bucket to empty on its own. `cdkd events prune <stack>` is the explicit
purge (issue [#885](https://github.com/go-to-k/cdkd/issues/885)):

```bash
cdkd events prune MyStack                 # keep the newest 20 (default)
cdkd events prune MyStack --keep 5        # keep the newest 5
cdkd events prune MyStack --older-than 24h# delete runs older than 24h
cdkd events prune MyStack --all           # purge everything (+ the index)
cdkd events prune MyStack --all --yes     # skip the confirmation (CI)
```

`--all` is mutually exclusive with `--keep` / `--older-than`. With both
`--keep` and `--older-than`, a run is deleted only when it is BOTH beyond the
newest-N window AND older than the cutoff. Prompts for confirmation unless
`-y` / `--yes`; `--stack-region` disambiguates a multi-region stack.

State-driven (no synth, no lock). See
**[docs/deployment-events.md](deployment-events.md)** for the full
reference: event types, S3 key layout, flush strategy, `index.json`
semantics, and the retention model.

