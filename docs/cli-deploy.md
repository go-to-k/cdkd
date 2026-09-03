---
title: Deploy: waits & concurrency
description: "Deploy-time wait and concurrency flags — the concurrency knobs, the per-resource-type wait-semantics table, and --no-wait / --full-wait."
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
[`--resource-timeout`](cli-deploy-tuning.md#per-resource-timeout)
(per-type or global), e.g.
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
explicit [`--resource-timeout`](cli-deploy-tuning.md#per-resource-timeout)
(per-type or global), e.g.
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
