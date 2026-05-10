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
(`public.ecr.aws/lambda/nodejs:<version>` or
`public.ecr.aws/lambda/python:<version>`, ~600MB); subsequent
invocations reuse the cached image. Pass `--no-pull` to skip the
`docker pull` round-trip altogether.

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
two-arg forms; `${LogicalId}` / `${LogicalId.attr}` placeholders are
substituted in place — the two-arg form's bindings map can also carry
intrinsic values, recursively resolved).

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
`Fn::GetStackOutput`, pseudo parameters (`AWS::Region`,
`AWS::AccountId`, etc.), other intrinsics (`Fn::Join`, `Fn::Select`,
`Fn::Split`, etc.). Anything beyond the three supported intrinsics is
treated as unresolved (warn + drop).

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
| Lambda Layers (`AWS::Lambda::LayerVersion`) | Future PR |
| Cross-account / cross-region ECR pull for container Lambdas | Future PR (same-account / same-region only in v1) |
| `EphemeralStorage` mapping for container Lambdas | Future PR (Docker `--tmpfs /tmp:size=Nm`) |
| `--no-build` flag (skip the local docker build, use a pre-built tag) | Future PR |
| Cross-stack `Fn::ImportValue` / `Fn::GetStackOutput` in `--from-state` | Future PR |
| Pseudo parameters / `Fn::Join` / `Fn::Select` etc. in `--from-state` | Future PR (warn + drop in v1) |
| API Gateway / SQS / S3 event source emulation (`cdkd local start-api`) | Future PR |
| VPC simulation | Never (local can't replicate VPC) |
| Custom Resources (`Custom::*`) | Never — these are invoked by the deploy framework, not by users. cdkd surfaces a clear error pointing at the underlying ServiceToken Lambda. |
