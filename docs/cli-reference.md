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
cdkd export MyStack --template path.json         # pre-rendered JSON template (skip synth)
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
   state entry). `Custom::*` resources are NOT blocked but require
   `--include-non-importable` to run the 2-phase flow described below.
4. Resolve each resource type's primary identifier property name(s) via
   `cloudformation:DescribeType` (with a hardcoded fallback table for
   ~30 single-key types). **Composite primary identifiers**
   (`primaryIdentifier.length > 1`) are supported for
   `AWS::ApiGateway::Method`, `AWS::ApiGateway::Resource`, and
   `AWS::EC2::VPCGatewayAttachment` via a per-type splitter that maps
   cdkd's `physicalId` to the field map `ResourceIdentifier` expects.
   Other composite types abort with a clear error pointing at where to
   register a new splitter.
5. Acquire the stack lock so concurrent `cdkd deploy` cannot race.
6. Confirm with the user (skipped with `-y` / `--yes`).
7. `CreateChangeSet --change-set-type IMPORT` → wait → `ExecuteChangeSet`
   → `waitUntilStackImportComplete`.
8. Delete cdkd state for the migrated stack.
9. Release lock.

**MVP scope** (intentional cuts; lift in follow-up PRs):

- **JSON templates only.** Mirrors `cdkd import --migrate-from-cloudformation`'s
  rationale: generic YAML libraries silently corrupt CFn shorthand intrinsics
  (`!Ref`, `!Sub`, `!GetAtt`) on round-trip. Hand-written YAML stacks must
  be converted manually.
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
- **`Custom::*` resources** require `--include-non-importable` to opt
  into the 2-phase flow: phase 1 IMPORT changeset for the importable
  resources, then phase 2 UPDATE changeset for the full template — CFn
  CREATEs the Custom Resources, which re-invokes each backing Lambda's
  onCreate handler. Make sure those handlers are idempotent before
  enabling. Without the flag, `Custom::*` resources cause the command
  to abort. `AWS::CloudFormation::Stack` (nested stacks) always blocks
  (CFn cannot adopt nor recreate them without conflicting with the
  existing AWS resource). On phase-2 failure, cdkd state is preserved
  and the error message includes the recovery procedure
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

- **Replacement risk on next deploy**: if the CDK code does NOT specify
  an explicit physical name (e.g. `bucketName: 'my-bucket-12345'`), the
  next `cdk deploy` will see "auto-generated name" vs "actual name" as a
  property change and may replace the resource. Mirror's `cdk import`'s
  long-standing UX. Update the CDK code with explicit names before
  exporting, or check the post-import changeset (`aws cloudformation
  create-change-set --change-set-type UPDATE`) for surprises before
  executing your first post-export `cdk deploy`.
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

`-a/--app` accepts either a shell command (`"npx ts-node app.ts"`) or
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

## `local invoke` (run Lambda functions locally)

`cdkd local invoke <target>` runs a Lambda function from a CDK app on
the developer's machine, inside a Docker container that bundles the
AWS Lambda Runtime Interface Emulator (RIE). Modeled on
`sam local invoke` but reusing cdkd's synthesis / asset / construct-path
plumbing.

**Requires Docker.** The first invocation pulls the Lambda base image
(`public.ecr.aws/lambda/nodejs:<version>`,
`public.ecr.aws/lambda/python:<version>`,
`public.ecr.aws/lambda/ruby:<version>`,
`public.ecr.aws/lambda/java:<version>`,
`public.ecr.aws/lambda/dotnet:<version>`, or
`public.ecr.aws/lambda/provided:<al2|al2023>` — ~600MB for the
language-specific images, ~50MB for the OS-only `provided.*`);
subsequent invocations reuse the cached image. Pass `--no-pull` to
skip the `docker pull` round-trip altogether. Supported runtimes:
`nodejs18.x` / `nodejs20.x` / `nodejs22.x` / `nodejs24.x` /
`python3.11` / `python3.12` / `python3.13` / `python3.14` /
`ruby3.2` / `ruby3.3` / `java8.al2` / `java11` / `java17` / `java21` /
`dotnet6` / `dotnet8` / `provided.al2` / `provided.al2023`. The
deprecated `go1.x` runtime is rejected with a migration pointer to
`provided.al2023`. Java, .NET, and `provided.*` are **asset-backed
only** — inline `Code.ZipFile` is rejected with a routing message
("use `lambda.Code.fromAsset(...)`") because the Handler shape names
a compiled artifact (`package.Class::method` for Java's JVM class;
`Assembly::Namespace.Class::Method` for .NET's CLR assembly; an
arbitrary `bootstrap` binary for `provided.*`).

**Container Lambdas (PR 5 of #224)** — `lambda.DockerImageFunction(...)` /
`Code.ImageUri` is supported in addition to ZIP Lambdas. cdkd reads the
function's local `Dockerfile` from `cdk.out` (via the asset manifest
keyed off the `:<hash>` suffix on `Code.ImageUri`) and runs `docker build`
locally, then `docker run` against the resulting image. When no asset
matches (typically: invoking a stack deployed elsewhere), cdkd falls back
to `docker pull` from ECR — **same-account / same-region only** in v1.
`Architectures: [x86_64]` (default) and `[arm64]` are honored via
`--platform linux/amd64` / `linux/arm64` on both the build and the run.

### Target resolution

The positional `<target>` accepts two forms:

- **CDK display path** — `MyStack/MyApi/Handler`. Matches the same
  prefix-rule cdkd uses for `cdkd orphan`: an L2 path resolves to the
  synthesized L1 child (`MyStack/MyApi/Handler/Resource`).
- **Stack-qualified logical ID** — `MyStack:MyApiHandler1234ABCD`. The
  colon is unambiguous because logical IDs cannot contain `/` or `:`.

Single-stack apps may omit the stack prefix entirely:
`cdkd local invoke MyHandler` is valid when the app contains exactly
one stack (mirrors `cdkd deploy` / `cdkd destroy` auto-detect).

When the target does not match anything, the error lists every Lambda
in the resolved stack so the user can copy/paste a valid one.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `-e, --event <file>` | `{}` | JSON event payload file. |
| `--event-stdin` | off | Read event JSON from stdin (mutually exclusive with `--event`). |
| `--env-vars <file>` | — | JSON env-var overrides, SAM-compatible shape: `{"LogicalId":{"KEY":"VALUE"}}` plus an optional top-level `"Parameters"` block applied to every invoke. `null` clears a key. |
| `--no-pull` | off | Skip `docker pull`. Semantics differ by code path: **ZIP Lambdas** — skip pulling the public Lambda base image. **Container Lambdas, local-build path** — no-op (docker build's default does not refresh the FROM cache). **Container Lambdas, ECR-pull fallback** — skip `docker pull` AND error if the image is not in the local cache (re-run without `--no-pull` or pre-pull manually). |
| `--no-build` | off | Skip `docker build` on the **Container Lambdas, local-build path** (`Code.ImageUri`). Requires the deterministic `cdkd-local-invoke-<hash>` tag to already be in the local docker registry from a prior `cdkd local invoke` (or manual `docker build`); errors clearly when missing. **No-op for ZIP Lambdas** (no docker build runs there) AND for the **Container Lambdas, ECR-pull fallback** (use `--no-pull` to control that path). Compatible with `--no-pull`. |
| `--debug-port <port>` | off | Set `NODE_OPTIONS=--inspect-brk=0.0.0.0:<port>` and publish the port; attach a Node debugger to step through the handler. |
| `--container-host <host>` | `127.0.0.1` | Host to bind the RIE port to. |
| `--assume-role <arn>` | off | STS-assume the deployed function's execution role and forward the resulting temp credentials to the container, so the handler runs under the deployed role's narrow permissions instead of the developer's typically-admin shell credentials. Off by default — when omitted, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` are passed through unchanged (SAM-compatible default). Takes an explicit ARN; PR 2's `--from-state` adds a hint pointing at the state-recorded role ARN but does NOT auto-assume. |
| `-a, --app <cmd-or-dir>` | — | CDK app command or pre-synthesized `cdk.out` directory. Default: synth every time (Q2 recommendation C). Pass `-a cdk.out` to skip synthesis when iterating. |
| `--output <dir>` | `cdk.out` | Output directory for synthesis. |
| `--from-state` | off | Read cdkd's S3 state for the target stack and substitute `Ref` / `Fn::GetAtt` / `Fn::Sub` placeholders in env vars with the deployed physical IDs / attributes. Off by default — keeps PR 1's literal-only / warn-and-drop behavior. See [State-driven env recovery (`--from-state`)](#state-driven-env-recovery---from-state) below. |
| `--state-bucket <bucket>` | auto | S3 bucket containing cdkd state. Falls back to `CDKD_STATE_BUCKET` env or `cdk.json context.cdkd.stateBucket`, then the default `cdkd-state-{accountId}`. Only used with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Only used with `--from-state`. |
| `--stack-region <region>` | auto | Region of the cdkd state record to read. Required when the same stack name has state in multiple regions. Only used with `--from-state`. |

### Environment variables

Template `Properties.Environment.Variables` entries:

- **Literal values** (string / number / boolean) are passed through as-is.
- **Intrinsic-valued entries** (`Ref` / `Fn::GetAtt` / `Fn::Sub`) need
  state to resolve. Without `--from-state` v1 emits a warning naming the
  variable and **drops** it (rather than silently substituting garbage);
  pass `--from-state` (PR 2 — see below) to recover deployed values from
  cdkd's S3 state, or override intrinsics via `--env-vars`.

Standard Lambda runtime env vars are always set: `AWS_LAMBDA_FUNCTION_NAME`,
`AWS_LAMBDA_FUNCTION_MEMORY_SIZE`, `AWS_LAMBDA_FUNCTION_TIMEOUT`,
`AWS_LAMBDA_FUNCTION_VERSION`, `AWS_LAMBDA_LOG_GROUP_NAME`,
`AWS_LAMBDA_LOG_STREAM_NAME`. The handler's `context.*` fields look real.

### State-driven env recovery (`--from-state`)

When the target stack has been deployed with `cdkd deploy`, the function's
intrinsic-valued env vars (`Ref` / `Fn::GetAtt` / `Fn::Sub`) reference
resources whose physical IDs only exist in AWS. PR 1's behavior is to
drop those entries with a warn — correct when there's no source of
truth, but unhelpful when cdkd already knows them. `--from-state` opts
in to reading cdkd's S3 state and substituting the deployed values
before the env block reaches the container.

**Resolution priority** (highest priority wins):

1. `--env-vars` file function-specific entry (`{LogicalId: {KEY: VALUE}}`).
2. `--env-vars` file global `Parameters` block.
3. `--from-state` substituted intrinsic (when the flag is set AND the
   template entry was a supported intrinsic AND substitution succeeded).
4. Template literal value.

**Supported intrinsics**: `Ref` (→ `state.resources[id].physicalId`),
`Fn::GetAtt` (→ `state.resources[id].attributes[attr]`, JSON-stringified
when the cached value is an object/array), `Fn::Sub` (single-string and
two-arg forms; `${LogicalId}` / `${LogicalId.attr}` / `${AWS::*}`
placeholders are substituted in place — the two-arg form's bindings map
can also carry intrinsic values, recursively resolved), `Fn::Join`
(every element recursively resolved, then joined), and `Ref: AWS::*`
pseudo parameters (`AccountId` / `Region` / `Partition` / `URLSuffix`)
resolved against STS `GetCallerIdentity` + the configured region.

**Failure mode**: per-key best-effort. When a substitution can't be
produced (state missing for the referenced resource, attribute not
captured at deploy time, unsupported intrinsic in `Fn::Sub`), the key
is reported via warn and dropped — same UX as PR 1. State-load
failures (no state record, multi-region ambiguity without
`--stack-region`, bucket-resolution error) degrade to warn-and-fall-back
rather than aborting the whole invoke.

**Q1 follow-up**: when `--from-state` is set without `--assume-role`,
cdkd peeks at the function's deployed `Role` in state and logs a
one-line hint surfacing the role's ARN. Auto-assumption is intentionally
not wired in — v1 keeps `--assume-role` as the single explicit path to
scoped credentials.

**Out of scope** (deferred): cross-stack `Fn::ImportValue` /
`Fn::GetStackOutput`, other intrinsics (`Fn::Select`, `Fn::Split`,
`Fn::If`, etc.). Anything beyond the listed supported intrinsics is
treated as unresolved (warn + drop). Note: `cdkd local invoke`'s
env-resolver loads state only — `${AWS::AccountId}` substitution still
requires the same STS `GetCallerIdentity` round-trip that `cdkd local
run-task` performs at startup; if the local-invoke CLI does not yet
populate the pseudo-parameter bag, those placeholders fall back to
warn + drop until the wiring lands.

```bash
# Single-region stack: --from-state alone is enough
cdkd deploy MyStack
cdkd local invoke MyStack/MyApi/Handler --from-state

# Multi-region: disambiguate the state record
cdkd local invoke MyStack/MyApi/Handler --from-state --stack-region us-west-2

# Combine with --env-vars to override a single key (override wins)
cdkd local invoke MyStack/MyApi/Handler --from-state \
  --env-vars '{"Parameters":{"DEBUG":"1"}}'
```

### Asset resolution

**ZIP Lambdas**: cdkd uses the CDK-blessed `Metadata['aws:asset:path']`
hint on each Lambda's CFn resource (the same source SAM uses) to find
the local unzipped asset directory under `cdk.out`, and bind-mounts it
at `/var/task` read-only. `Code.ZipFile` (inline) functions are
materialized to a tmpdir using the file path implied by the function's
`Handler` property (`index.handler` → `tmpdir/index.js`).

### Lambda Layers

Same-stack `AWS::Lambda::LayerVersion` references in
`Properties.Layers` are resolved automatically and bind-mounted at
`/opt` (read-only) inside the container. The flow:

1. `cdkd local invoke` walks `Properties.Layers` left-to-right.
2. Each entry must be `{Ref: '<LayerLogicalId>'}` or
   `{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}` pointing at an
   `AWS::Lambda::LayerVersion` resource in the same stack. The layer's
   `Metadata['aws:asset:path']` is read the same way Lambda code is
   located — the layer asset is unzipped under `cdk.out/asset.<hash>/`
   ready to bind-mount.
3. cdkd produces a single bind mount at `/opt`:
   - **Single layer**: the layer's asset dir is bind-mounted directly
     (no copy).
   - **Multiple layers**: each layer's contents are copied into a
     freshly-allocated tmpdir IN ORDER (later layers overwrite earlier
     files via `cpSync({force: true})`); the merged tmpdir is then
     bind-mounted at `/opt` and removed in the cleanup path.
   - The merge mirrors AWS Lambda's actual runtime behavior: AWS
     extracts every layer ZIP into `/opt` in template order so later
     layers shadow earlier files (**"last layer wins on file
     collision"**). cdkd cannot rely on multiple `-v ...:/opt:ro`
     entries — Docker rejects duplicate bind mounts at the same target
     path with `Error response from daemon: Duplicate mount point: /opt`.
4. The layer's directory layout (`/opt/python/...`,
   `/opt/nodejs/...`, `/opt/lib/...`, etc.) is the user's
   responsibility — cdkd does NOT inspect the contents.

**Out of scope (v1)** — hard-errors with a clear pointer at the
offending entry:

- Literal-ARN layer entries (`arn:aws:lambda:...`) — these are external
  / pre-existing layers including cross-account / cross-region. No
  asset on disk to mount; deferred to a follow-up PR.
- Same-stack refs that don't point at an `AWS::Lambda::LayerVersion`
  (typo'd logical ID).
- Same-stack refs to a `LayerVersion` whose `Metadata['aws:asset:path']`
  is missing.

**Container Lambdas** (`Code.ImageUri`): the `Layers` property is
silently ignored — matches AWS behavior, since container images bake
their layers at build time and AWS rejects `Layers` on container
Lambdas at deploy time.

**Container Lambdas** (`Code.ImageUri`): cdkd extracts the asset hash
from the `:<hash>` tail of the image URI (CDK synthesizes the URI as a
`Fn::Sub` whose body ends in the asset hash) and looks the matching
entry up in the stack's asset manifest (`cdk.out/<stack>.assets.json`,
`dockerImages[<hash>]`). When the lookup hits, `cdkd local invoke` calls
`docker build` against the recorded build context. When the lookup
misses AND the manifest contains exactly one Docker asset, that single
asset is used (single-asset fallback — covers digest-pinned URIs). When
both miss, cdkd falls back to **ECR pull** — same-account / same-region
only; cross-account / cross-region pulls hard-error with a pointer at
the deferred follow-up PR. `ImageConfig.Command` becomes the docker run
CMD; `ImageConfig.EntryPoint` (when set) becomes `--entrypoint <first>`
plus the rest as positional args; `ImageConfig.WorkingDirectory` becomes
`--workdir`. When `EntryPoint` is unset (the common case), the image's
default entrypoint stays in charge — for AWS Lambda base images that's
`/lambda-entrypoint.sh`, which routes to RIE on port 8080.

### `local invoke` exit codes

- `0` — RIE answered, regardless of whether the handler returned a
  success payload OR an error payload. Lambda-style: a thrown handler
  produces a 200 with an error structure on AWS, and we mirror that.
- `1` — cdkd-side errors before/after the handler ran: Docker not
  installed, image pull failed, target not found, RIE port unreachable
  after the readiness window, container exited before responding.

### v1 scope (out of scope, deferred)

| Out of scope | Deferred to |
| --- | --- |
| Java / Go / Ruby / .NET runtimes | Future PRs |
| Cross-account / cross-region / pre-existing-ARN Lambda Layers | Future PR (same-stack `AWS::Lambda::LayerVersion` refs are supported in v1; literal ARNs hard-error — see "Lambda Layers" section above) |
| Cross-account / cross-region ECR pull for container Lambdas | Future PR (same-account / same-region only in v1) |
| `EphemeralStorage` mapping for container Lambdas | Future PR (Docker `--tmpfs /tmp:size=Nm`) |
| Cross-stack `Fn::ImportValue` / `Fn::GetStackOutput` in `--from-state` | Future PR |
| `Fn::Select` / `Fn::Split` / `Fn::If` etc. in `--from-state` | Future PR (warn + drop today) |
| SQS / S3 event source emulation | Future PR |
| VPC simulation | Never (local can't replicate VPC) |
| Custom Resources (`Custom::*`) | Never — these are invoked by the deploy framework, not by users. cdkd surfaces a clear error pointing at the underlying ServiceToken Lambda. |

## `local start-api` (long-running local API server)

`cdkd local start-api` stands up a long-running HTTP server that maps
synthesized API Gateway routes (REST v1, HTTP API, Function URL) to
local Lambda invocations against the AWS Lambda Runtime Interface
Emulator. Modeled on `sam local start-api` but reusing cdkd's
synthesis, asset, and route-discovery plumbing — no `template.yaml`
round-trip.

**Requires Docker.** As with `cdkd local invoke`, the first run pulls
the Lambda base image (~600MB once per machine). Pass `--no-pull` on
subsequent runs to skip the layer check.

```bash
cdkd local start-api                       # auto-allocate one port PER discovered API
cdkd local start-api --port 3000           # first API → 3000, second API → 3001, ...
cdkd local start-api --api MyAdminApi      # serve only the named API
cdkd local start-api --warm                # pre-start one container per Lambda
```

### One server per API (v0.81+)

Every discovered API surface (`AWS::ApiGatewayV2::Api`,
`AWS::ApiGateway::RestApi`, `AWS::Lambda::Url`) gets its own HTTP
server on its own port. cdkd prints one `Server listening on
http://<host>:<port>  (<API> (<kind>))` line per server at startup,
and one route table per server underneath.

This is a deliberate departure from `sam local start-api`'s
single-server-per-template model: realistic CDK apps usually define
multiple APIs (admin + public, internal + external) with different
authorizer setups, different CORS configs, and overlapping paths.
Lumping them into one server forced an awkward "first-match-wins"
semantic that didn't mirror AWS Lambda's actual routing. Pre-v0.81
versions did this — see [issue #260](https://github.com/go-to-k/cdkd/issues/260)
for the background.

Port assignment:

| `--port` value | Per-API port allocation |
| --- | --- |
| `0` (default) | Every server auto-allocates its own port. |
| `3000` | First API → `3000`, second API → `3001`, third → `3002`, ... |

Pass `--api <id>` to launch exactly one server for the named API; the
identifier matches the HTTP API / REST API logical id, or (for
Function URLs) the backing Lambda's logical id.

### Discovered routes

| Source | CFn types |
| --- | --- |
| HTTP API | `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`), `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Integration` |
| REST v1 | `AWS::ApiGateway::RestApi`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Method`, `AWS::ApiGateway::Stage` |
| Function URL | `AWS::Lambda::Url` |

Only AWS_PROXY (Lambda Proxy) integrations are supported; any other
integration type — MOCK, AWS, HTTP, HTTP_PROXY, ApiGwV2 service
integrations (`IntegrationSubtype` set) — is hard-rejected at
discovery with the offending route's location named in the error.
WebSocket APIs (`AWS::ApiGatewayV2::Api.ProtocolType: WEBSOCKET`)
and Function URLs with `AuthType !== 'NONE'` or `InvokeMode ==
'RESPONSE_STREAM'` are also rejected — these need the deferred 8b /
8c follow-up PRs.

### Routing precedence

3 tiers per AWS docs: full match → greedy `{proxy+}` → `$default`.
Within "full match" tier, more literal segments win as a best-effort
tie-break (AWS does not formally specify multi-route precedence within
the same tier; cdkd uses literal-segment count as a heuristic).

### Flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--port <port>` | auto-allocate | First API server's port (subsequent APIs get `port+1`, `port+2`, ...). Pass `0` (default) to auto-allocate each. The actual port assignment is printed at startup. |
| `--host <host>` | `127.0.0.1` | Bind address. |
| `--api <id>` | unset | Restrict to a single API surface by its CDK logical id (HTTP API / REST API logical id; for Function URLs, the backing Lambda's logical id). When unset, every discovered API gets its own server. |
| `--stack <name>` | single-stack auto-detect | Required when the app has multiple stacks. |
| `--warm` | off | Pre-start one container per discovered Lambda at server boot. Trades RAM for first-request latency. |
| `--per-lambda-concurrency <n>` | `2` | Pool size cap per Lambda. Max 4 in v1; above-cap values are clamped with a warn. |
| `--no-pull` | off | Skip `docker pull`. |
| `--container-host <host>` | `127.0.0.1` | IP the host uses to bind/probe the RIE port. Must be a numeric IP — `docker run -p <ip>:<port>:8080` rejects hostnames like `host.docker.internal`. |
| `--debug-port-base <port>` | unset | Allocate a contiguous `--inspect-brk` port range across Lambdas (one per Lambda). |
| `--env-vars <file>` | unset | SAM-shape JSON: `{"LogicalId":{"KEY":"VALUE"}, "Parameters":{...}}`. Same format as `cdkd local invoke`. |
| `--assume-role <arn-or-pair>` | unset | Repeatable. Bare `<arn>` = global default; `<LogicalId>=<arn>` = per-Lambda override. Per-Lambda > global > unset (developer creds passed through). |
| `--watch` | off | Hot reload: re-synth + re-discover routes when `cdk.out/` or any routed Lambda's asset directory changes. 500ms debounce. Synth failures keep the previous version serving (warn-and-continue, never crashes the server). |
| `--stage <name>` | first attached | Select an API Gateway Stage by `StageName`. Drives `event.stageVariables` (REST v1 + HTTP API v2). When the override doesn't match any Stage on a given API, that API's routes get `stageVariables: null` and the CLI emits a warn line up front. |

### Hot reload (`--watch`)

When `--watch` is set, cdkd installs a [chokidar](https://github.com/paulmillr/chokidar)-backed
file watcher over `cdk.out/` plus every routed Lambda's asset
directory. A change in any watched path triggers a debounced (500ms
window) reload:

1. Re-run `cdk synth` (skipped when `-a <dir>` was passed at server
   boot — the directory is treated as already-synthesized).
2. Re-run route discovery, stage resolution, and CORS-config
   extraction.
3. Build per-Lambda specs + a fresh container pool.
4. Atomically swap the server state. Routes added / removed / changed
   take effect on the next request.
5. Dispose the previous pool in the background — in-flight requests
   complete against the old containers; new requests hit the new
   pool.

Synth failures during reload do NOT crash the server. The previous
version keeps serving and the CLI emits a `[warn]` line naming the
failure. Reloads serialize, so a burst of file changes coalesces to
one synth.

### CORS preflight

cdkd's HTTP server intercepts OPTIONS preflight requests for HTTP API
v2 routes whose `AWS::ApiGatewayV2::Api` has a `CorsConfiguration`:

- Match `Origin` against `AllowOrigins` (literal entries or `*`).
- Match `Access-Control-Request-Method` against `AllowMethods`.
- Match each `Access-Control-Request-Headers` entry against
  `AllowHeaders` (case-insensitive).
- Respond `204 No Content` with the canonical `Access-Control-Allow-*`
  headers, plus `Access-Control-Max-Age` / `Access-Control-Expose-Headers`
  / `Access-Control-Allow-Credentials` when configured.
- Always set `Vary: Origin` so downstream caches (browser / CDN) do
  not share the response across origins (load-bearing whenever
  `Access-Control-Allow-Origin` was derived from the request — the
  wildcard echo, literal-origin echo, and `AllowCredentials` echo
  paths all qualify).

When `AllowCredentials: true` AND the origin matched via `*`, the
response echoes the request's literal `Origin` (browser fetch spec
disallows `*` + credentials).

`Access-Control-Request-Headers` lists are validated strictly: a
malformed entry (e.g. `"Content-Type,,Authorization"` — a trailing /
embedded empty entry) rejects the preflight rather than silently
skipping the empty entry. This matches AWS's stricter HTTP API
behavior on preflight headers.

When the user has registered an explicit OPTIONS method on a path
(an `AWS::ApiGatewayV2::Route` whose `RouteKey` is `OPTIONS /...`)
**on the same API as the matched route**, preflight interception is
skipped — the user's Lambda owns the OPTIONS surface. The same-API
filter is load-bearing in multi-API stacks: an explicit OPTIONS
route on Stack B's REST v1 API at the same path no longer suppresses
preflight on Stack A's HTTP API v2.

REST v1 (`AWS::ApiGateway::*`) CORS via Mock OPTIONS methods is NOT
intercepted: cdkd's discovery layer rejects Mock integrations
(`Integration.Type === 'MOCK'`) at server boot, so REST v1 CORS
emulation is intentionally out of scope. Use the deployed API for
that case.

### Stage variables

`event.stageVariables` is populated from the selected Stage's
`Variables` (REST v1) / `StageVariables` (HTTP API v2) map.

- **Default**: the first Stage attached to each API in template
  order.
- **`--stage <name>`**: select a Stage by `StageName`. Applied per-API
  — a `--stage prod` override against an app with three APIs picks
  the matching Stage on each. APIs without a matching Stage get
  `stageVariables: null` and surface a warn line at startup. The
  resolved stage name is threaded into `event.requestContext.stage`
  for **both** REST v1 and HTTP API v2 routes. AWS supports named
  stages on HTTP API v2 (`CreateStage` accepts any name; `$default`
  is the auto-deploy default but not the only option), so a v2
  template that pins a named Stage gets that name surfaced through
  the integration event — matching what the deployed endpoint would
  emit. v2 APIs without a templated Stage continue to use
  `'$default'`.
- **Function URL** routes don't have a Stage — `stageVariables` stays
  `null` regardless of the flag.
- **Intrinsic-valued entries** (`Ref`, `Fn::GetAtt`, `Fn::Sub`) in
  the Stage's `Variables` map are dropped with a warn (mirrors
  PR 1's env-var policy — the local server has no deploy state to
  resolve them against).

### Container lifecycle

- One pool per Lambda. Each container's RIE port is bound to its own
  free host port (`pickFreePort`); the user-facing HTTP server stays on
  the single `--port`.
- `acquire()` returns the first idle container in the pool; lazy-grows
  up to `--per-lambda-concurrency` under a per-Lambda mutex. Above the
  cap, requests queue.
- `release()` returns the container to the pool and starts a 60s idle
  timer. Idle GC fires after 60s of inactivity per pool.
- Containers are named `cdkd-local-<logicalId>-<pid>-<rand>` so an
  external sweep can mop up orphans (`docker ps --filter
  name=cdkd-local-`).

### Lambda Layers in `local start-api`

`cdkd local start-api` resolves same-stack `AWS::Lambda::LayerVersion`
references the same way `cdkd local invoke` does — see the **Lambda
Layers** section under `local invoke` above for the full rules
(supported reference shapes, last-layer-wins on file collision, the
single merged `/opt` bind mount, hard-error cases). The merge happens
once per Lambda at server boot (not per request); the merged tmpdir
is removed by the graceful shutdown path. Single-layer Lambdas skip
the copy and bind-mount the layer's asset dir directly.

### Graceful shutdown

`SIGINT` / `SIGTERM` / `uncaughtException` / `unhandledRejection` all
run the same dispose path: drain in-flight requests, tear down every
container (tolerating per-container removal failures — logged at warn,
loop continues). The verify-time `docker ps --filter` sweep is the
defense-in-depth backstop.

Double-`^C` bypasses dispose and exits immediately so the user can
escape a hung Docker daemon. The skipped containers are reported with
the `docker ps` cleanup command in the warning.

### `local start-api` exit codes

- `0` — server started cleanly and shut down on SIGTERM.
- `1` — startup failure (Docker missing, port bind failed, route
  discovery rejected) OR uncaught exception during the run.
- `130` — exited via SIGINT.

### `local start-api` authorizers

cdkd supports four authorizer kinds in front of any discovered route:

- **Lambda TOKEN** (REST v1) — `AWS::ApiGateway::Authorizer.Type: 'TOKEN'`.
  The header named in `IdentitySource` (default
  `method.request.header.Authorization`) is forwarded to the authorizer
  Lambda as `event.authorizationToken`. The Lambda's response must carry
  a `policyDocument` with at least one `{ Effect: 'Allow', Resource:
  <methodArn> }` statement; cdkd matches `Resource` against the
  request's methodArn (literal or `*`/`?` wildcard) on every request —
  cached verdicts get re-evaluated against the new methodArn so a
  narrow-Resource Allow doesn't leak across routes. Allow → context
  flat under `event.requestContext.authorizer`. Policy-deny → HTTP 403,
  missing identity header → HTTP 401 without invoking the Lambda.
- **Lambda REQUEST** — REST v1 (`Type: 'REQUEST'`) and HTTP v2
  (`AuthorizerType: 'REQUEST'`). The full request snapshot (headers,
  query string, path parameters) is passed to the authorizer Lambda.
  HTTP v2 also accepts the simple `{ isAuthorized, context }` response
  shape in addition to the IAM-policy shape. REST v1 missing-identity →
  HTTP 401 without invoking the Lambda; HTTP v2 falls through.
- **Cognito User Pool** (REST v1) — `Type: 'COGNITO_USER_POOLS'`. The
  Bearer token from `Authorization: Bearer <token>` is verified locally
  against the user pool's published JWKS. Allow → claims under
  `event.requestContext.authorizer.claims`. Deny → HTTP 403.
- **JWT** (HTTP v2) — `AuthorizerType: 'JWT'`. Same JWKS-based
  verification, with `aud` / `client_id` matched against the
  `JwtConfiguration.Audience` allowlist. Allow → claims under
  `event.requestContext.authorizer.jwt.claims`. Deny → HTTP 401.

Authorizer results are cached per `(authorizer, identity)` for the TTL
declared by the authorizer (REST v1: `AuthorizerResultTtlInSeconds`,
default 300s, max 3600s; HTTP v2: 0 by default = no cache; JWT: cached
for `min(remaining-exp, 300s)`).

**JWKS-fetch failure → pass-through.** When the JWKS endpoint is
unreachable at startup, cdkd warns and falls back to a pass-through
mode where every Bearer token is accepted as if valid (including
malformed / non-JWT garbage — a real JWT still gets its claims
surfaced into `event.requestContext.authorizer`, a malformed token
gets a synthetic `unknown` principal and an empty claims map):

```text
[warn] [cognito-jwt] JWKS unreachable at https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xyz/.well-known/jwks.json: ...
        JWT validation will allow all tokens — local dev fallback. Configure
        network access to the JWKS URL to enable real signature verification.
```

The failure entry has a short TTL (~60s) so a transient blip doesn't
lock pass-through for the full 1hr success TTL — the next minute's
request retries the JWKS fetch. The pass-through warn line itself
fires at most once per JWKS URL per server lifecycle (the warn-set
is constructed once at server startup, not per request).

This is a deliberate dev-tool tradeoff: surprising deny is worse than
warn+allow when the developer is iterating on a function and the JWKS
URL is blocked by a corporate proxy. **Do NOT rely on this in any
shared environment** — the dev's machine accepts every token, including
forged ones.

Unsupported authorizer kinds (REST v1 `AWS_IAM`, mTLS, and any non-
TOKEN/REQUEST/COGNITO_USER_POOLS Type / non-REQUEST/JWT AuthorizerType)
hard-error at discovery with the offending route's location named.

### `local start-api` VPC-config Lambdas

Lambdas with `Properties.VpcConfig` set still run locally — cdkd does
NOT block these — but the local container does NOT get attached to the
deployed VPC's subnets. Calls from the handler to private RDS /
ElastiCache / VPC-only endpoints will fail. cdkd surfaces a one-line
warn at startup naming each affected Lambda:

```text
[warn] Lambda MyVpcLambda has VpcConfig — local container will reach external
        services via the host's network, NOT through the deployed VPC's
        NAT/private subnets. Calls to private RDS/ElastiCache will fail.
```

AWS SDK calls from the container still use the developer's shell
credentials (or `--assume-role`-issued temp creds) and reach the public
AWS endpoints; nothing about that path changes.

### `local start-api` v1 scope (out of scope, deferred)

| Out of scope | Deferred to |
| --- | --- |
| `--from-state`-style env-var substitution | Future PR |
| REST v1 IAM authorizer (`AuthorizationType: 'AWS_IAM'`) | Future PR |
| mTLS authorizers | Future PR |
| REST v1 CORS via Mock OPTIONS integration | Out of scope (use the deployed API) |
| Custom integration mapping templates | Never (not testable locally) |
| WebSocket APIs | Never (different protocol) |
| Throttling / quotas / usage plans / API keys | Never |
| Per-Lambda concurrency above 4 | Future PR if a real workload needs it |

## `local run-task` (run an ECS task definition locally)

`cdkd local run-task <Stack/TaskDefinitionPath>` is the ECS counterpart
of `cdkd local invoke`. It takes an `AWS::ECS::TaskDefinition` defined
in a CDK app and starts every container on the developer's Docker host
— no AWS deploy needed.

Implementation Phase 1: synchronous run of one task, stream every
container's stdout/stderr with a `[<name>]` prefix, propagate the
essential container's exit code. Phase 2 (`cdkd local start-service` —
ECS Service + ALB-emulated path/host-based routing) and Phase 3
(Service Connect / Cloud Map degraded mode) are tracked separately.

**Requires Docker.** The first run pulls the AWS-published
`amazon/amazon-ecs-local-container-endpoints:latest-amd64` sidecar (a
small Go binary maintained by awslabs) plus each container's image.

### `local run-task` target resolution

Same target-syntax rules as `cdkd local invoke`:

- CDK display path (`MyStack/MyService/TaskDef`) — preferred
- Stack-qualified logical id (`MyStack:MyServiceTaskDefXYZ1234`)
- Single-stack apps may omit the stack prefix (`MyTaskDef`)

Path matching is prefix-based: an L2 path like `MyStack/MyService/TaskDef`
resolves to the synthesized L1 child (`MyStack/MyService/TaskDef/Resource`).

### `local run-task` options

| Flag | Default | Behavior |
| --- | --- | --- |
| `--cluster <name>` | `cdkd-local` | Surfaced as `ECS_CONTAINER_METADATA_URI_V4`'s `Cluster` field and used as the docker network prefix (`<name>-task-<rand>`). |
| `--env-vars <file>` | unset | SAM-shape JSON overlay. Top-level keys are container names; `Parameters` is a global overlay. Same shape as `cdkd local invoke --env-vars`. |
| `--container-host <ip>` | `127.0.0.1` | Bind IP for `PortMappings` published ports. Must be a numeric IP — Docker rejects hostnames in `-p <ip>:<port>:<port>`. |
| `--assume-task-role [<arn>]` | unset (host creds pass through) | Bare flag uses the task definition's `TaskRoleArn`. Resolves a flat-string ARN directly; for `{Ref: <Role>}` / `{Fn::GetAtt: [<Role>, 'Arn']}` against a same-stack `AWS::IAM::Role`, cdkd substitutes the caller's account id (via STS `GetCallerIdentity`) into `arn:aws:iam::<account>:role/<RoleLogicalId>`. Pass an explicit ARN to override. Either way, `sts:AssumeRole` runs once at startup; the resulting creds are exposed via the local metadata sidecar at `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`. |
| `--from-state` | off | Load cdkd S3 state for the target stack and substitute deployed values into (a) `Fn::Sub` / `Fn::GetAtt` ECR image URIs that reference a same-stack `AWS::ECR::Repository`, AND (b) intrinsic-valued `ContainerDefinitions[].Environment[].Value` + `Secrets[].ValueFrom` entries (`Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join`). Without this flag, env / secret intrinsics are dropped with a per-key warning (matching `cdkd local invoke --from-state` semantics). See "ECR image resolution" and "Env / Secrets substitution" below. Off by default. The stack must have been deployed via `cdkd deploy` first. |
| `--stack-region <region>` | unset | Region of the cdkd state record to read (used with `--from-state` when the same stack name has state in multiple regions). |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--platform <platform>` | inferred from `RuntimePlatform.CpuArchitecture` | `linux/amd64` or `linux/arm64`. Threaded into every container's `docker run --platform`. |
| `--keep-running` | off | Don't `docker rm -f` user containers on task exit (network + sidecar are still torn down). Use when you want to `docker exec` into a stopped container for post-mortems. |
| `--detach` | off | Start the containers and return without streaming logs or auto-tearing them down. Useful in CI smoke tests; caller manages container lifecycle. |

Plus the standard shared options: `-a/--app`, `-c/--context`, `--profile`,
`--role-arn`, `--region`, `--verbose`, `--output`.

### Networking model

For every task invocation cdkd:

1. Creates a fresh docker network `cdkd-local-task-<random>` (or
   `--cluster <name>-task-<random>`) with subnet `169.254.170.0/24`.
2. Starts the AWS-published
   `amazon/amazon-ecs-local-container-endpoints:latest-amd64` sidecar
   on the network at the well-known IP `169.254.170.2`.
3. Starts every user container on the same network with
   `--network-alias <container-name>` so siblings resolve each other by
   their CFn `ContainerDefinitions[].Name`.
4. Injects per-container env vars: `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<container-name>`
   and (when `--assume-task-role` is set) `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/role/<task-role-arn>`.

`awsvpc` network mode is mapped to `bridge` locally with a warn line —
docker cannot emulate ENI-per-task. AWS SDK calls from inside the
container still reach public AWS endpoints via the developer network.

### ECR image resolution

`ContainerDefinitions[].Image` is parsed in three tiers:

1. **Public images** — `public.ecr.aws/...`, `docker.io/...`, `nginx:latest`, etc. → plain `docker pull` (subject to `--no-pull`).
2. **Direct ECR URIs** — `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>` (flat string, no intrinsics) → `pullEcrImage` (STS check + ECR auth + `docker pull`). Same-account / same-region only; cross-account / cross-region hard-errors with a `--role-arn` / `AWS_REGION` workaround pointer.
3. **CDK-asset images** (`ContainerImage.fromAsset` / `DockerImageAsset`) → `cdk.out/<stack>.assets.json` lookup → `docker build` via the shared `src/assets/docker-build.ts` helper, tagged `cdkd-local-run-task-<asset-hash>`.

For `Fn::Sub` / `Fn::GetAtt` shapes pointing at AWS pseudo parameters or a same-stack ECR repository (the typical `ContainerImage.fromEcrRepository(repo)` synthesis), two additional resolution tiers fire **before** the URI is fed to tier 2:

- **Tier 1 — AWS pseudo-parameter substitution (no state needed)**: `${AWS::AccountId}` → STS `GetCallerIdentity` (lazy, cached for the run); `${AWS::Region}` → `--region` / `AWS_REGION` / `AWS_DEFAULT_REGION`; `${AWS::Partition}` → derived from region (`cn-*` → `aws-cn`, `us-gov-*` → `aws-us-gov`, else `aws`); `${AWS::URLSuffix}` → matches partition. Substituted URI then routes through tier 2.
- **Tier 2 — same-stack ECR Repository reference (state needed)**: when the `Fn::Sub` body contains `${<LogicalId>}` against an `AWS::ECR::Repository`, or when the template uses `Fn::GetAtt: [<Repo>, 'RepositoryUri']`, cdkd needs the deployed physical repo name. Pass `--from-state` (the stack must have been deployed via `cdkd deploy`); cdkd loads state, substitutes the physical name, then routes through tier 2. Without `--from-state` the error message points back at this flag as the resolution path.

### Env / Secrets substitution (`--from-state`)

`ContainerDefinitions[].Environment[].Value` and `Secrets[].ValueFrom`
entries are commonly intrinsic-valued in real-world CDK ECS apps —
`table.tableName` synthesizes as `Ref`, `table.tableArn` as
`Fn::GetAtt`, `ecs.Secret.fromSecretsManager(secret)` as `Ref` against
the secret (returns the deployed ARN), `ecs.Secret.fromSsmParameter(p)`
as `Fn::Join` over pseudo parameters + a `Ref` to the parameter, etc.
Without `--from-state` these intrinsics are silently dropped (matching
`cdkd local invoke` v1 semantics) and the developer sees an empty env
var or a missing secret.

`cdkd local run-task --from-state` substitutes every intrinsic-valued
entry against cdkd's deployed S3 state plus AWS pseudo parameters:

| Intrinsic | Source |
| --- | --- |
| `Ref: <LogicalId>` | `state.resources[<LogicalId>].physicalId` |
| `Fn::GetAtt: [<LogicalId>, <Attr>]` | `state.resources[<LogicalId>].attributes[<Attr>]` |
| `Fn::Sub: '...${X}...${AWS::Region}...'` | recursive substitution against state + pseudo parameters |
| `Fn::Join: [<delim>, [<elements>]]` | recursive substitution of every element, then `Array.join` |
| `Ref: AWS::AccountId` / `AWS::Region` / `AWS::Partition` / `AWS::URLSuffix` | STS `GetCallerIdentity` (lazy, cached) + the resolved region + region-derived partition / URL suffix |

Per-key best-effort: when a substitution can't be produced (state
missing for a referenced logical ID, attribute not captured at deploy
time, unsupported intrinsic), the env / secret entry is dropped and a
per-key warning surfaces on the task's warnings line — the run-task
invocation never aborts. State-load failures (no record, multi-region
ambiguity without `--stack-region`, bucket resolution error) also
degrade to warn-and-fall-back rather than hard-fail.

Resolved `Secrets[].ValueFrom` strings then flow into the standard
SecretsManager / SSM resolver below.

### Secrets / SSM parameter resolution

`ContainerDefinitions[].Secrets[].ValueFrom` entries are resolved once at
startup via the AWS SDK (after any `--from-state` intrinsic substitution
above). Three accepted shapes:

| `valueFrom` | API |
| --- | --- |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>` | `SecretsManagerClient.GetSecretValue` |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>:<json-key>::` | `GetSecretValue`, then JSON.parse + extract `json-key` |
| `arn:aws:ssm:<region>:<account>:parameter/<name>` | `SSMClient.GetParameter({ WithDecryption: true })` |

Resolution failures (NotFound / AccessDenied / network error / invalid
ARN) hard-fail with the offending container + secret name. The user
fixes their AWS creds / IAM policy and re-runs. (Mirrors the
`cdkd local invoke --from-state` philosophy: explicit failure beats
silently-empty.)

### Container start ordering — `DependsOn`

| Condition | What cdkd waits for |
| --- | --- |
| `START` | Dependency's `docker run` has returned. |
| `COMPLETE` | Dependency's container has exited (any code). |
| `SUCCESS` | Dependency's container has exited with exit code 0. |
| `HEALTHY` | Dependency's `HEALTHCHECK` reports `healthy` (polled every 1s, capped at 5 min). |

Cyclic dependencies → hard-error at discovery with the offending cycle
named. Topological sort decides the start order; siblings with no
dependsOn relation start in template order.

### Volumes

| `Volumes[]` shape | Local realization |
| --- | --- |
| `Host: { SourcePath: '/some/path' }` | `docker run -v /some/path:<containerPath>` bind mount (caller's responsibility that the host path exists; a missing path emits a warn) |
| `Host` (no `SourcePath`) | Docker anonymous volume — empty per-task scratch |
| `DockerVolumeConfiguration: { Scope: 'task' \| 'shared', Driver, DriverOpts }` | `docker volume create --driver <driver> --opt ...` per task; per-task scope is torn down at exit |
| `EFSVolumeConfiguration` | **Hard-error**. Bind-mount a local directory at the same `containerPath` instead. |
| `FSxWindowsFileServerVolumeConfiguration` | **Hard-error**. |

### Lifecycle + teardown

1. The first `essential: true` container (defaults to `containers[0]`
   when no container declares `essential: false`) drives the task.
2. When the essential container exits, cdkd `docker stop`s every other
   container with a 10s grace then `docker rm -f`.
3. The metadata sidecar is `docker rm -f`'d and the docker network is
   removed.
4. cdkd exits with the essential container's exit code.

`^C` triggers the same teardown. Double-`^C` exits 130 immediately
(skipping container cleanup — same pattern as `cdkd local start-api`).

`--detach` skips steps 1, 2, and 4. The sidecar and user containers
stay running for the caller to manage. cdkd prints the network name on
exit so you can `docker ps --filter network=<name>` to inspect.

`--keep-running` skips step 2 only. The network + sidecar are still
torn down. Use to `docker exec` into a stopped container post-mortem.

### `local run-task` exit codes

- `0` — essential container exited 0.
- N (non-zero) — essential container exited N (cdkd propagates the code).
- Various cdkd-side error codes (Docker missing, target not found,
  network creation failed, secret resolution failed, ...) follow the
  global handler's defaults (typically 1).

### `local run-task` Phase 1 scope (out of scope, deferred)

| Out of scope | Why |
| --- | --- |
| `AWS::ECS::Service` / `DesiredCount` / `LaunchType` | Phase 2 (`cdkd local start-service`) |
| ALB / NLB target group registration / listener rules | Phase 2 — needs an HTTP proxy emulator |
| Service Connect / Cloud Map | Phase 3 — `docker network` alias gives 80% of the value |
| Auto Scaling / Deployment Strategy | Not meaningful locally |
| Fargate vs EC2 launch-type differences (PID namespace, `awsvpc`-only, ephemeral storage cap) | Local Docker can't enforce these |
| EFS / FSx volumes | Need real AWS NFS / SMB; hard-error with a routing hint |
| ECS Exec | Use `docker exec` directly |
| CloudWatch Logs auto-shipping (`logConfiguration.LogDriver: 'awslogs'`) | stdout/stderr already streamed; skip the driver |
| X-Ray sidecar's AWS-API mocking | Run the daemon explicitly if you need it |
| AWS App Mesh / Envoy fidelity | Not meaningful locally |
| awsvpc / ENI complete fidelity | Map to docker bridge with a warn |
