---
title: "Deploy: waits & concurrency"
description: "Deploy-time wait and concurrency flags — the concurrency knobs, the per-resource-type wait-semantics table, and --no-wait / --full-wait."
---

# Deploy: waits & concurrency

`cdkd deploy` decides two things you can tune from the command line: how many
operations it runs at once, and how long it waits before calling a resource
done. This page covers both. The rest of the deploy flags live under
[Deploy: tuning](cli-deploy-tuning.md) and
[Deploy: safety & compatibility flags](cli-deploy-safety.md).

```bash
cdkd deploy                            # default waits, default concurrency
cdkd deploy --no-wait                  # skip the stabilization waits
cdkd deploy --full-wait                # also wait everywhere CloudFormation waits
cdkd deploy --concurrency 20           # more parallel resource operations
cdkd deploy --stack-concurrency 8      # more parallel stacks
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--concurrency <n>` | `10` | Maximum concurrent resource operations per stack. |
| `--stack-concurrency <n>` | `4` | Maximum concurrent stack deployments. |
| `--asset-publish-concurrency <n>` | `8` | Maximum concurrent asset publishes (S3 upload + ECR push). |
| `--image-build-concurrency <n>` | `4` | Maximum concurrent Docker image builds. |
| `--no-wait` | off | Skip the stabilization waits cdkd performs by default. Deploy-only. |
| `--full-wait` | off | Also wait everywhere CloudFormation waits. Deploy-only. |

`--no-wait` and `--full-wait` are opposite ends of one axis and cannot be
combined; cdkd rejects the pair before any AWS call. Neither is accepted by
`cdkd destroy`, and neither can be scoped to a single resource type — they
apply to the whole run.

## Wait modes

cdkd is **template-compatible** with CloudFormation. It is not
**wait-semantics-identical**, and does not claim to be. What counts as "done"
is decided per resource type, and the three modes are:

| Mode | What it waits for |
| --- | --- |
| `--no-wait` | Nothing beyond the AWS API call returning. |
| (default) | Only where the wait is load-bearing — an in-deploy consumer needs the result, or the wait can surface a real failure. |
| `--full-wait` | Everywhere CloudFormation waits. |

Which mode is right depends on whether anything downstream needs the resource
to actually be serving, **not** on where the deploy runs:

- `--no-wait` when nothing runs next and nothing is waiting on completion —
  preview environments, and cutting billed CI minutes is a perfectly good
  reason to use it in CI.
- The default for ordinary use.
- `--full-wait` when a smoke test, a DNS cutover, or a follow-on job runs
  immediately after the deploy returns.

## Wait behaviour by resource type

These are the types whose behaviour differs across the three modes. Other
types are unaffected by the flags — which does not mean they never wait: a
DynamoDB table, an EFS file system, an EMR cluster and a dozen more wait for
their own readiness on create in every mode, because their provider needs the
result.

| Resource type | `--no-wait` | Default | `--full-wait` | CloudFormation | Terraform |
| --- | --- | --- | --- | --- | --- |
| `AWS::CloudFront::Distribution` | same as default | Return after the create / update call | Wait for `Deployed` (3-15 min) | Waits | Waits (`wait_for_deployment`, default true) |
| `AWS::ECS::Service` | same as default | Return after `CreateService` / `UpdateService` | Wait for steady state | Waits for steady state | Does not wait (`wait_for_steady_state`, default false) |
| `AWS::CertificateManager::Certificate` | Return while `PENDING_VALIDATION` | Wait for `ISSUED` | same as default | Waits | Does not wait (waiting is a separate `aws_acm_certificate_validation` resource) |
| `AWS::RDS::DBCluster` / `DBInstance` | Return after the create call | Wait for `available` (5-10 min) | same as default | Waits | Waits |
| `AWS::DocDB::DBCluster` / `DBInstance` | Return after the create call | Wait for `available` (5-10 min) | same as default | Waits | Waits |
| `AWS::Neptune::DBCluster` / `DBInstance` | Return after the create call | Wait for `available` (5-10 min) | same as default | Waits | Waits |
| `AWS::ElastiCache::CacheCluster` etc. | Return after the create call | Wait for `available` | same as default | Waits | Waits |
| `AWS::EC2::NatGateway` | Return while `pending` | Wait for `available` (1-2 min) | same as default | Waits | Waits |
| `AWS::EC2::Instance` | Return while `pending`; `PublicIp` / `PrivateIp` may be empty | Wait for `running` (30-60 s) | same as default | Waits | Waits |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | Return while `provisioning`; `DNSName` 503s until active | Wait for `active` (90-180 s) | same as default | Waits | Waits |
| `AWS::Lambda::MicrovmImage` | Return while `CREATING`; the image ARN resolves first, so outputs still work | Wait for `CREATED` | same as default | Waits | n/a |

Two of these have a routing caveat: for CloudFront and
`AWS::Lambda::MicrovmImage`, only the SDK provider takes the fast side. A
resource of either type routed through the Cloud Control API fallback polls to
the CloudFormation handler's terminal state regardless of the flag.

### CloudFront and ACM, in more detail

A CloudFront distribution's `Fn::GetAtt` values (`Id`, `DomainName`) are final
in the create / update response, so nothing in the deploy needs `Deployed`.

An ACM certificate is the opposite case, and the one place cdkd's default
waits where Terraform does not: an un-issued certificate makes a downstream
CloudFront or ALB create fail outright rather than merely arrive early. When
that wait runs out, cdkd **deletes** the certificate it requested, so a failed
deploy leaves nothing behind and repeated attempts do not accumulate
certificates. That costs nothing — ACM reuses a domain's validation CNAME
across certificates, so records you add after the failure validate the retry.
Use `--no-wait` if you want to keep a `PENDING_VALIDATION` certificate
instead; see [Troubleshooting](troubleshooting.md).

## What `--no-wait` skips, and what it does not

Under `--no-wait` the resource is still fully functional once AWS finishes the
deployment in the background. Three cases need care.

**NAT Gateway.** `CreateNatGateway` returns the `NatGatewayId` immediately, so
dependent routes that only need the ID proceed against a still-`pending`
gateway. This is safe when nothing in the deploy needs actual NAT-routed
egress — no Lambda invoked during the deploy that reaches the internet, for
instance.

**EC2 Instance.** cdkd normally verifies after launch that the requested
`IamInstanceProfile` really did attach: `RunInstances` associates it
asynchronously and can complete with no profile attached when the profile was
created moments earlier. That check needs a `running` or `stopped` instance —
AWS rejects `AssociateIamInstanceProfile` on a `pending` one — so under
`--no-wait` it is skipped and a warning naming the instance is printed
instead. If the deploy needs the profile attached, either drop `--no-wait` or
verify afterwards:

```bash
aws ec2 describe-iam-instance-profile-associations \
  --filters Name=instance-id,Values=<instance-id>
```

**Load balancer capacity reservation.** When an ELBv2 load balancer's template
sets `MinimumLoadBalancerCapacity` with
`EnableCapacityReservationProvisionStabilize: true`, the default mode
additionally polls `DescribeCapacityReservation` until every zone reports
`provisioned` — bounded at about ten minutes, where a timeout warns and
continues and a `failed` zone errors. `--no-wait` skips that poll along with
the `active` wait.

**Elastic IP.** The same hazard applies to an `AWS::EC2::EIP` whose
`InstanceId` points at an instance created in the same deploy:
`AssociateAddress` rejects an instance that is not yet `running`. Creating
such an EIP allocates the address but skips the association; updating one
attempts the association and degrades to a warning only if AWS actually
rejects it, so repointing an EIP at an already-running instance still works.
Both warnings print the exact `aws ec2 associate-address` command to run once
the instance is up.

**One wait runs regardless of `--no-wait`**: a Lambda-backed
`AWS::CloudFormation::CustomResource` waits for its backing ServiceToken
Lambda to reach `Configuration.State === 'Active'` and
`LastUpdateStatus === 'Successful'` immediately before the synchronous invoke.
Without it, the invoke fails with `The function is currently in the following
state: Pending`. The wait is scoped to that invoke — an ordinary Lambda create
or update returns as soon as the SDK call returns, so a VPC Lambda with no
synchronous consumer does not block the deploy on the 5-10 minute ENI attach
window.

`--no-wait` is deploy-only because no destroy path benefits. NAT Gateway
destroy unconditionally waits for `deleted` to keep teardown ordered — a
still-`deleting` gateway blocks `DeleteSubnet`, `DeleteInternetGateway` and
`DeleteVpc` with `DependencyViolation` — and the other eligible types (RDS,
ElastiCache) are leaves on the destroy DAG, so their providers do not wait
there anyway. CloudFront's destroy-side disable-then-wait is an API
requirement and is unaffected by any wait flag.

## What `--full-wait` adds

Two types are affected.

### `AWS::ECS::Service` — steady state

The default returns once `CreateService` / `UpdateService` is accepted, which
matches Terraform and diverges from CloudFormation on purpose: nothing
downstream needs the service to be steady (`Fn::GetAtt` yields `Name` and
`ServiceArn`, both valid immediately), and CloudFormation's steady-state wait
is what makes a crash-looping image hang a stack for many minutes.

Without `--full-wait`, cdkd prints the command to wait manually:

```text
aws ecs wait services-stable --cluster <cluster> --services <service>
```

cdkd deliberately does not probe the rollout on the default path. Right after
`CreateService` a healthy service and a doomed one look identical (`ACTIVE`,
`runningCount: 0`, `rolloutState: IN_PROGRESS`); a warning there would fire on
every deploy and would imply a guarantee a single check cannot back.

Under `--full-wait`, "done" means stable **and** rolled out: after the
steady-state waiter, cdkd briefly polls the primary deployment's
`rolloutState` to `COMPLETED`, because ECS flips it a few seconds after
stability and returning inside that window would be observably weaker than
CloudFormation. That poll is bounded at about two minutes; a rollout still in
progress past it warns and continues.

The steady-state wait itself is capped at 600 seconds, matching Terraform's
`aws_ecs_service` create timeout. A service that legitimately takes longer — a
large task count, a slow-pulling image, a long health-check grace period — can
lift the cap with
[`--resource-timeout`](cli-deploy-tuning.md#per-resource-timeout), e.g.
`--resource-timeout AWS::ECS::Service=20m`. The flag only raises the cap, never
lowers it, and the same value governs the outer per-resource deadline, so the
two cannot undercut each other.

A service that never stabilizes fails the deploy. On create, cdkd best-effort
deletes the service it just created before failing, so the next deploy does
not collide on the name. The failure message carries the
`aws ecs list-tasks --desired-status STOPPED` and `describe-tasks` commands to
inspect why the tasks stopped — stopped tasks outlive the service deletion by
about an hour, so the evidence is still there.

### `AWS::CloudFront::Distribution` — `Deployed`

Without `--full-wait`, cdkd prints the command to wait manually:

```text
aws cloudfront wait distribution-deployed --id <distribution-id>
```

Under `--full-wait` the wait budget is about 20 minutes, lifted by an explicit
[`--resource-timeout`](cli-deploy-tuning.md#per-resource-timeout), e.g.
`--resource-timeout AWS::CloudFront::Distribution=40m` — again raise-only, and
sharing the outer per-resource deadline.

Unlike the ECS timeout, a CloudFront wait timeout does **not** fail the
deploy. A distribution still `InProgress` at the budget is slow, not broken —
there is no failure state to detect — and failing would hand the automatic
rollback a healthy distribution to disable and delete. cdkd warns with the
manual wait command and proceeds.

## Why the defaults are where they are

Where CloudFormation and Terraform agree on the completion definition, cdkd
matches them. Where they disagree, the default takes the definition that suits
dev/test iteration and `--full-wait` opts into the CloudFormation one.

Even where both engines wait, cdkd's default may take the fast side — but only
when all three of these hold:

1. **No in-deploy consumer.** Nothing the same deploy creates or resolves
   (`Fn::GetAtt`, downstream create calls, post-create verification) needs the
   waited-for state.
2. **No failure signal.** The wait cannot surface an error — a timeout means
   slow, not broken — so waiting buys certainty of *when*, never *whether*.
3. **Measurable in both modes.** The comparison tool offers both completion
   definitions, so a benchmark can report two like-for-like rows instead of
   redefining "done" to win one.

`AWS::CloudFront::Distribution` is the only type admitted under that clause,
and the same test is why a blanket "`--no-wait` by default" stays rejected:
ACM fails (1) outright, RDS fails (1) because `Endpoint` attributes are not
final until `available`, and EC2 fails (1) because the instance-profile
verification needs a `running` instance.

These are per-run choices, not capability limits. A pipeline that wants
CloudFormation-parity completion semantics — a smoke-test gate, a
production-leaning promotion step — can bake `--full-wait` into its deploy
invocation as a standing setting.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every resource was deployed. |
| `1` | Hard error — bad arguments (including `--no-wait` together with `--full-wait`), auth failure, a synth crash, or a resource failure that the automatic rollback then handled. |
| `2` | Resources were left unaddressed: a skipped DELETE, or a replacement whose predecessor survives. State is preserved; re-running usually clears it. `--allow-unaddressed` restores `0`. |

An ECS service that never stabilizes under `--full-wait` fails the deploy, so it
exits non-zero rather than `2`. A CloudFront wait that runs out does not fail
the deploy at all. The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

## Related

- [Wait Modes](wait-modes.md) — the same axis, summarised for a first read
- [Deploy: tuning](cli-deploy-tuning.md) — timeouts, name prefixing, observed-state capture
- [Deploy: safety & compatibility flags](cli-deploy-safety.md) — the guards and their escape hatches
- [Benchmarks](benchmarks.md) — what the wait modes cost in wall-clock time
