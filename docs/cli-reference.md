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
more Pattern B resources whose `physicalId` still starts with
`${stackName}-`, the command lists them and prompts for confirmation
before any provider call runs. The prompt defaults to **no** because
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
  command. `--region` is deprecated and ignored (PR 5).

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
   with verified structural divergence (e.g. `AWS::IAM::ManagedPolicy`'s
   URL-encoded `PolicyDocument`) short-circuit to `drift unknown`
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

## Exit codes

cdkd commands distinguish three outcomes via the process exit code so
CI / bench scripts can react without grepping log output:

| Exit | Meaning | Emitted by |
| --- | --- | --- |
| `0` | Success — command completed and no resources are in an error state | All commands |
| `1` | Command-level failure — auth error, bad arguments, synth crash, unhandled exception. **`cdkd drift` also exits `1` when drift is detected** (the operative meaning is "non-zero outcome", not "command crashed") | All commands (default for any thrown error) |
| `2` | **Partial failure** — work completed but one or more resources failed; state.json is preserved and re-running typically resolves it | `cdkd destroy`, `cdkd state destroy` (per-resource delete failures), `cdkd publish-assets` (per-stack asset publish failures) |

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
   if any template resource is in the **blocked** set (nested stacks
   `AWS::CloudFormation::Stack` or template resources without a cdkd
   state entry). Lambda-backed Custom Resources (`Custom::*` AND
   `AWS::CloudFormation::CustomResource` — the latter is what
   `new cdk.CustomResource(...)` synthesizes when no `resourceType` is
   passed) are NOT blocked but require `--include-non-importable` to
   run the 2-phase flow described below.
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
  command to abort. `AWS::CloudFormation::Stack` (nested stacks) always
  blocks (CFn cannot adopt nor recreate them without conflicting with
  the existing AWS resource). On phase-2 failure, cdkd state is
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

## `local *` (run AWS workloads locally via Docker)

The `cdkd local` command family runs AWS workloads on the developer's
machine via Docker — Lambda functions, API Gateway routes, ECS tasks,
and ECS Services — without an AWS deploy. The full reference for all
`cdkd local *` subcommands (`local invoke` / `local start-api` /
`local run-task` / `local start-service`) lives in
**[docs/local-emulation.md](local-emulation.md)**.

