---
title: Choose a Wait Mode
description: "Choose when cdkd deploy returns: as soon as AWS accepts each call (--no-wait), once every outcome still open is decided (default), or when everything CloudFormation waits for has settled (--full-wait)."
---

# Choose a Wait Mode

Some resources keep provisioning for minutes after AWS accepts the call that
creates them: a CloudFront distribution, an RDS instance, a NAT gateway, an
ECS service. A wait mode decides how much of that time `cdkd deploy` waits
through before it returns. There are three modes, and you pick one per deploy:

```bash
# default: wait until every outcome still open is decided
cdkd deploy MyStack

# return as soon as AWS accepts each call
cdkd deploy MyStack --no-wait

# also wait wherever CloudFormation waits
cdkd deploy MyStack --full-wait
```

## Where each mode returns

A deploy passes three points in order, and each mode returns at one of them:

```text diagram=guide-wait-modes
  AWS accepts the create / update call
        │                              ◀── --no-wait returns here
        ▼
  Every outcome still open after the call is decided
    RDS, DocumentDB, Neptune, ElastiCache: available
    NAT gateway, EC2 instance, load balancer: up
    ACM certificate: issued
    ECS service: steady state
        │                              ◀── the default returns here
        ▼
  Everything CloudFormation waits for has settled
    CloudFront distribution: Deployed
                                       ◀── --full-wait returns here
```

Take a stack with a NAT gateway and a CloudFront distribution:

- With `--no-wait`, the deploy returns once AWS has accepted both create
  calls. Both resources are still coming up.
- With the default, the deploy waits until the NAT gateway is available. It
  does not wait for the distribution.
- With `--full-wait`, the deploy also waits until the distribution is
  `Deployed`, as CloudFormation does.

The default skips one wait: a CloudFront distribution propagating to the
edge, which takes 3 to 15 minutes. Every other wait stays in the default,
because a later step needs the finished resource or because the wait is how a
failure gets reported.

## Why the default waits for ECS but not CloudFront

The deciding question is whether the outcome is still open when the API call
returns.

| Resource | References usable before the wait ends | Outcome when the call returns | What the wait tells you | Default | To change it |
| --- | --- | --- | --- | --- | --- |
| ECS service | Yes: `Ref` (the service ARN), `Name`, `ServiceArn` | Open: the rollout can still fail | Whether the new tasks start and pass their health checks | Waits; a failed rollout fails the deploy | `--no-wait` skips the wait |
| CloudFront distribution | Yes: `Ref` (the ID), `Id`, `DomainName` | Settled: AWS refuses a bad configuration in the call itself | Only when the edge locations serve it, never whether | Does not wait | `--full-wait` adds the wait |

Nothing later in the deploy needs either wait, so references are not the
difference. An ECS rollout fails for reasons in your own app or configuration,
such as an image that cannot be pulled, a container that exits, a failing
health check, or missing permissions or capacity. Steady state is the only
place that failure shows up. With a deployment circuit breaker the wait ends
as soon as ECS gives a verdict, a rollback included; without one, a service
that never stabilizes fails at the wait limit.

A CloudFront distribution's propagation does not fail. Waiting for it would
add 3 to 15 minutes to every deploy and tell you nothing.

- Pass `--no-wait` to skip the ECS wait: a first deploy before the image is
  pushed, a fast iteration loop, or a pipeline with its own health check.
- Pass `--full-wait` when something right after the deploy needs the
  distribution serving, such as an end-to-end or smoke test.

## Which mode to use

Choose by what happens right after the deploy returns. Whether the deploy
runs on a laptop or in CI does not matter.

- **Use `--no-wait`** when nothing uses the stack immediately, such as a
  preview environment, or a CI job where you pay for every minute. Resources
  may still be coming up when the command exits.
- **Use the default** for ordinary work. Everything is ready except that a
  CloudFront distribution may not be serving yet.
- **Use `--full-wait`** when a smoke test, a DNS cutover or a follow-on job
  starts as soon as the deploy returns. The deploy takes the extra minutes
  CloudFormation would also take.

`--no-wait` and `--full-wait` are opposites, so cdkd rejects a command that
passes both, before it calls AWS:

```text
--no-wait and --full-wait cannot be combined: --no-wait skips stabilization waits, --full-wait adds them. Pick one.
```

## What `--no-wait` leaves unfinished

A resource created under `--no-wait` works normally once AWS finishes it in
the background. Until then, you may see these:

- A NAT gateway is still `pending`, so traffic that leaves the VPC through it
  does not flow yet.
- An EC2 instance is still `pending`. cdkd cannot check that the instance
  profile attached, so it prints a warning that names the instance.
- An ACM certificate is still in `PENDING_VALIDATION`.
- A load balancer's DNS name returns 503 until the load balancer is `active`.
- An ECS service's rollout is unchecked: a service whose tasks never start
  still deploys with exit `0`.

[cdkd deploy](cli-deploy.md) lists what each mode does for
every affected resource type, next to what CloudFormation and Terraform do.

## Destroy always waits

`--no-wait` and `--full-wait` exist on `cdkd deploy` only. `cdkd destroy`
always waits for each delete to finish, because deletes depend on each other.
For example, a NAT gateway that is still `deleting` makes the deletes of its
subnet, internet gateway and VPC fail with `DependencyViolation`.

## A second deploy can start before resources finish

cdkd locks a stack while a command works on it, and releases the lock when
the command finishes its own work. It does not hold the lock until AWS has
finished provisioning. So in every mode, a second `cdkd deploy` on the same
stack can start while resources from the first are still coming up.
`--no-wait` makes that window longer and `--full-wait` makes it shorter.

## Related

- [cdkd deploy](cli-deploy.md): the per-type wait table, the
  concurrency flags, and what the stack lock covers
- [cdkd deploy: tuning](cli-deploy-tuning.md): per-resource timeout overrides
- [Benchmarks](benchmarks.md): how much time each mode saves
