---
title: Deploy: waits & tuning
description: "Deploy-time wait and tuning flags — concurrency, the per-resource-type wait-semantics table, --no-wait / --full-wait, observed-state capture, name prefixing, per-resource timeouts, and CDK annotation messages."
---

## Concurrency

cdkd parallelizes asset publishing, stack deployment, and per-stack
resource provisioning. Each level has its own concurrency knob.

| Option | Default | Description |
| --- | --- | --- |
| `--concurrency` | 10 | Maximum concurrent resource operations per stack |
| `--stack-concurrency` | 4 | Maximum concurrent stack deployments |
| `--asset-publish-concurrency` | 8 | Maximum concurrent asset publish operations (S3 + ECR push) |
| `--image-build-concurrency` | 4 | Maximum concurrent Docker image builds |

## Wait semantics

cdkd is **template-compatible** with CloudFormation. It is not
**wait-semantics-identical**, and does not claim to be. What counts as
"done" is decided per resource type and documented in the table below.

The decision procedure: where CloudFormation and Terraform agree on the
completion definition, cdkd matches them. Where they disagree, cdkd's
default takes the definition that suits dev/test iteration, and
`--full-wait` opts into the CloudFormation one. This is a rule for
choosing completion definitions, not a promise to mirror any one engine.

Even where both engines wait, cdkd's default may take the fast side —
but only when ALL of these hold:

1. **No in-deploy consumer**: nothing the same deploy creates or resolves
   (`Fn::GetAtt`, downstream Create calls, post-create verification)
   needs the waited-for state.
2. **No failure signal**: the wait cannot surface an error — a timeout
   means slow, not broken — so waiting buys certainty of *when*, never
   *whether*.
3. **Measurable in both modes**: the comparison tool offers both
   completion definitions, so the benchmark can report two like-for-like
   rows instead of redefining "done" to win one.

`AWS::CloudFront::Distribution` is currently the only type admitted
under this clause. The same test is why a blanket "`--no-wait` by
default" stays rejected: ACM fails (1) outright (an un-issued cert makes
a same-deploy CloudFront / ALB create fail), RDS fails (1) (`Endpoint`
attributes are not final until `available`), and EC2 fails (1) (the
instance-profile attach verification needs a `running` instance).

One documented exception in the other direction:
`AWS::CertificateManager::Certificate` is a "CloudFormation waits,
Terraform does not" case where cdkd's default nonetheless waits. An
un-issued certificate makes a downstream CloudFront / ALB create fail
outright rather than merely arrive early, so the fast side would trade a
wait for a broken deploy. Terraform users express the same wait as a
separate `aws_acm_certificate_validation` resource, which cdkd has no
equivalent of. When that wait runs out, cdkd DELETES the certificate it
requested rather than abandoning it, so a failed deploy leaves nothing behind
and repeated attempts do not accumulate certificates. That costs nothing: ACM
reuses a domain's validation CNAME across certificates, so records you add after
the failure validate the retry. `--no-wait` is the supported way to KEEP a
`PENDING_VALIDATION` certificate instead — see
[troubleshooting.md](troubleshooting.md).

Three wait modes, least to most waiting:

| Mode | Meaning |
| --- | --- |
| `--no-wait` | Skip the stabilization waits cdkd performs by default |
| (default) | Wait where the wait is load-bearing (in-deploy consumers / failure detection) |
| `--full-wait` | Also wait everywhere CloudFormation waits |

The two flags are opposite ends of one axis, so **`--no-wait` and
`--full-wait` cannot be combined** (cdkd rejects the pair before any AWS
call). Per-resource-type wait control is not expressible with these
whole-run flags.

Which mode is right depends on whether anything downstream needs the
resource to actually be serving, **not** on where the deploy runs:

- `--no-wait` when nothing runs next and nothing is waiting on completion
  (preview environments, and cutting billed CI minutes is a perfectly
  good reason to use it in CI)
- default for ordinary use
- `--full-wait` when a smoke test, a DNS cutover, or a follow-on job runs
  immediately after the deploy returns

## `--no-wait`

```bash
cdkd deploy --no-wait
```

This can significantly speed up deployments. The resource is fully
functional once AWS finishes the async deployment.

| Resource type | `--no-wait` | Default | `--full-wait` | CloudFormation | Terraform |
| --- | --- | --- | --- | --- | --- |
| `AWS::CloudFront::Distribution` | same as default | Return after `CreateDistribution` / `UpdateDistribution` (propagation finishes in the background). Only the SDK provider takes the fast side — a Cloud-Control-routed distribution still polls to the CFn handler's terminal state | Wait for `Deployed` (3–15 min) | Waits | Waits (`wait_for_deployment`, default `true`) |
| `AWS::RDS::DBCluster` / `AWS::RDS::DBInstance` | Return after Create call | Wait for `available` (5–10 min) | same as default | Waits | Waits |
| `AWS::DocDB::DBCluster` / `AWS::DocDB::DBInstance` | Return after Create call | Wait for `available` (5–10 min) | same as default | Waits | Waits |
| `AWS::Neptune::DBCluster` / `AWS::Neptune::DBInstance` | Return after Create call | Wait for `available` (5–10 min) | same as default | Waits | Waits |
| `AWS::ElastiCache::CacheCluster` etc. | Return after Create call | Wait for `available` | same as default | Waits | Waits |
| `AWS::CertificateManager::Certificate` | Return after `RequestCertificate` (cert is `PENDING_VALIDATION` and RECORDED IN STATE; downstream CloudFront/ALB fail until it issues) | Wait for `ISSUED` (DNS/EMAIL validation); if the wait fails, the certificate this deploy requested is DELETED so nothing is orphaned | same as default | Waits | Does not wait (`aws_acm_certificate` returns while `PENDING_VALIDATION`; waiting is a separate `aws_acm_certificate_validation` resource) |
| `AWS::EC2::NatGateway` | Return after `CreateNatGateway` (gateway is `pending`; AWS finishes async) | Wait for `available` (1–2 min) | same as default | Waits | Waits |
| `AWS::EC2::Instance` | Return after `RunInstances` (instance is `pending`; `PublicIp` / `PrivateIp` attributes may be empty, and the IAM instance profile association is not verified — see below) | Wait for `running` (30–60 s) | same as default | Waits for `running` | Waits for `running` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | Return after `CreateLoadBalancer` (LB is `provisioning`; `DNSName` 503s until active). Also skips the capacity-reservation stabilize poll below | Wait for `active` (90–180 s). When the template sets `MinimumLoadBalancerCapacity` with `EnableCapacityReservationProvisionStabilize: true`, additionally poll `DescribeCapacityReservation` until every zone is `provisioned` (bounded ~10 min; timeout warns and continues, a `failed` zone errors) | same as default | Waits for `active`; the stabilize flag is the CFn-native opt-in to the same reservation wait | Waits for `active` |
| `AWS::ECS::Service` | same as default | Return after `CreateService` / `UpdateService` | Wait for steady state | Waits for steady state | Does not wait (`wait_for_steady_state`, default `false`) |
| `AWS::Lambda::MicrovmImage` | Return after `CreateMicrovmImage` (image is `CREATING`; the build finishes async). The image ARN is resolved before the wait, so outputs still work. Only the SDK provider honors this — the Cloud Control fallback always polls to a terminal state | Wait for `CREATED` (the Firecracker snapshot build; several minutes) | same as default | Waits | n/a |

For NAT Gateway specifically: `CreateNatGateway` returns the
`NatGatewayId` immediately, so dependent Routes that only need the ID
proceed against a still-`pending` gateway. `--no-wait` is safe when
nothing in the deploy flow needs actual NAT-routed egress (no Lambda
invoked during deploy that hits the internet, etc.).

For EC2 Instance specifically: cdkd normally verifies after launch that the
requested `IamInstanceProfile` really did attach, because `RunInstances`
associates it asynchronously and can complete with NO profile attached when the
profile was created moments earlier (cdkd's fast path creates it ~1 s before
launch; CloudFormation never hits this because its own latency lets IAM settle).
That check needs a `running` or `stopped` instance — AWS rejects
`AssociateIamInstanceProfile` on a `pending` one — so under `--no-wait` it is
skipped and a warning naming the instance is printed instead. If the deploy
needs the profile to be attached, either drop `--no-wait` or verify afterwards:

```bash
aws ec2 describe-iam-instance-profile-associations \
  --filters Name=instance-id,Values=<instance-id>
```

The same hazard applies to an `AWS::EC2::EIP` whose `InstanceId` points at an
instance created in the same deploy: `AssociateAddress` rejects an instance
that is not yet `running`. Under `--no-wait`, creating such an EIP allocates
the address but skips the association; updating one attempts the association
and degrades to a warning only if AWS actually rejects it (so repointing an
EIP at an already-running instance still works). In both cases the warning
prints the exact `aws ec2 associate-address` command to run once the instance
is running.

`--no-wait` is **deploy-only**. `cdkd destroy` does not accept it,
because no destroy code path benefits — NAT Gateway destroy
unconditionally waits for `deleted` state to keep teardown ordered
(a still-`deleting` gateway blocks `DeleteSubnet` /
`DeleteInternetGateway` / `DeleteVpc` with `DependencyViolation`
until its ENI / EIP / route associations release), and the other
`--no-wait`-eligible resources (RDS / ElastiCache) are leaves on the
destroy DAG so their providers don't wait there to begin with.
(CloudFront's destroy-side disable-then-wait is an API requirement —
a distribution must be `Deployed` and disabled before
`DeleteDistribution` succeeds — and is unaffected by any wait flag.)

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

## `--full-wait`

```bash
cdkd deploy --full-wait
```

Two types are affected: `AWS::ECS::Service` (steady state) and
`AWS::CloudFront::Distribution` (`Deployed`).

### `AWS::ECS::Service` — steady state

cdkd's default returns once `CreateService` / `UpdateService` is
accepted, which matches Terraform's default and diverges from
CloudFormation on purpose: nothing downstream needs the service to be
steady (`Fn::GetAtt` yields `Name` / `ServiceArn`, both valid
immediately), and CloudFormation's steady-state wait is what makes a
crash-looping image hang a stack for many minutes.

Without `--full-wait`, cdkd prints the exact command to wait manually:

```text
aws ecs wait services-stable --cluster <cluster> --services <service>
```

cdkd deliberately does not probe the rollout on the default path. Right
after `CreateService` a healthy service and a doomed one look identical
(`ACTIVE`, `runningCount: 0`, `rolloutState: IN_PROGRESS`); a warning
there would fire on every deploy and would imply a guarantee ("nothing
was printed, so the rollout is fine") that a single check cannot back.

The steady-state wait is capped at 600 seconds by default (matching
Terraform's `aws_ecs_service` create timeout). A service that
legitimately takes longer — a large task count, a slow-pulling image, a
long health-check grace period — can lift the cap with
`--resource-timeout` (per-type or global), e.g.
`--resource-timeout AWS::ECS::Service=20m`. The flag only raises the
cap, never lowers it below the 600s floor, and the same value already
governs the outer per-resource deadline, so the two cannot undercut
each other.

The `--full-wait` doneness is "stable AND rolled out": after the
steady-state waiter (a single deployment whose running count matches the
desired count), cdkd briefly polls the PRIMARY deployment's
`rolloutState` to `COMPLETED` — ECS flips it a few seconds after the
stability condition is met, and returning inside that window would leave
`--full-wait` observably weaker than CloudFormation's handler. The poll
is bounded (about two minutes); a rollout still in progress past it
warns and continues rather than failing a service that is already
stable.

Under `--full-wait`, a service that never stabilizes fails the deploy. On
create, cdkd best-effort deletes the service it just created before
failing, so the next deploy does not collide on the service name. The
deletion is announced with a warning, and the failure message carries the
`aws ecs list-tasks --desired-status STOPPED` / `describe-tasks` commands
to inspect why the tasks stopped — stopped tasks outlive the service
deletion by about an hour, so the evidence is still there.

### `AWS::CloudFront::Distribution` — `Deployed`

cdkd's default returns once `CreateDistribution` / `UpdateDistribution`
is accepted. Both CloudFormation and Terraform
(`wait_for_deployment`, default `true`) wait for `Deployed` here, so
this is the fast-side clause of the wait-semantics rule in action:
`Fn::GetAtt` (Id / DomainName) is final in the Create/Update response so
nothing in-deploy consumes `Deployed`, and the wait has no failure
signal — a distribution deploy cannot fail, so waiting 3–15 minutes
only buys certainty of *when* the edge propagation finished.

Without `--full-wait`, cdkd prints the exact command to wait manually:

```text
aws cloudfront wait distribution-deployed --id <distribution-id>
```

Under `--full-wait`, the wait budget is ~20 minutes, lifted by an
explicit `--resource-timeout` (per-type or global), e.g.
`--resource-timeout AWS::CloudFront::Distribution=40m` — the flag only
raises the budget, never lowers it, and the same value already governs
the outer per-resource deadline, so the two cannot undercut each other.
Unlike the ECS steady-state timeout, a CloudFront wait timeout does
**not** fail the deploy: a distribution that is still `InProgress` at
the budget is slow, not broken (there is no failure state to detect),
and failing would hand the automatic rollback a healthy distribution to
disable-and-delete. cdkd warns with the manual wait command and
proceeds.

The destroy path is unaffected by all of this: deleting a distribution
requires disabling it and waiting for `Deployed` first (an API
requirement), which also means a distribution created fire-and-forget
and destroyed immediately still tears down cleanly.

A deliberate consequence of this axis: the dev/test-leaning defaults are
a per-run choice, not a capability limit. A pipeline that wants
CloudFormation-parity completion semantics — a smoke-test gate, a
production-leaning promotion step — can bake `--full-wait` into its
deploy invocation as a standing setting and get the strict "done"
everywhere CloudFormation waits.

`--full-wait` is **deploy-only**, like `--no-wait`, and cannot be
combined with it.

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
--resource-timeout)` (see the `--full-wait` section above), so the inner
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

