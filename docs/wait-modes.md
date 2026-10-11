---
title: Wait Modes
description: "Choose when cdkd deploy returns: as soon as AWS accepts each call (--no-wait), once the deploy's own dependencies are ready (default), or when everything CloudFormation waits for has settled (--full-wait)."
---

# `--no-wait` / `--full-wait`: choose what "done" means

Some resources keep provisioning for minutes after AWS accepts the create
call: a CloudFront distribution, an RDS instance, a NAT gateway, an ECS
service. A wait mode decides how much of that `cdkd deploy` sits through
before it returns.

```bash
cdkd deploy MyStack               # default: wait only where the deploy needs it
cdkd deploy MyStack --no-wait     # return as soon as AWS accepts each call
cdkd deploy MyStack --full-wait   # also wait wherever CloudFormation waits
```

## Where each mode returns

```text diagram=guide-wait-modes
  AWS accepts the create / update call
        │                              ◀── --no-wait returns here
        ▼
  Resources the deploy itself depends on are ready
    RDS, DocumentDB, Neptune, ElastiCache: available
    NAT gateway, EC2 instance, load balancer: up
    ACM certificate: issued
        │                              ◀── the default returns here
        ▼
  Everything CloudFormation waits for has settled
    ECS service: steady state
    CloudFront distribution: Deployed
                                       ◀── --full-wait returns here
```

The default waits where the wait does something for the deploy: a later step
needs the settled resource, or the wait can surface a failure. It skips the
two waits that do neither. An ECS service's steady state and a CloudFront
distribution's edge propagation (3 to 15 minutes) are not needed by anything
else in the deploy, so the default returns once the call is accepted.

## Which mode to use

| Mode | Use it when | What you give up |
| --- | --- | --- |
| `--no-wait` | Nothing runs right after the deploy: a preview environment, or a CI job where the billed minutes matter | Resources may still be coming up when the command exits |
| default | Ordinary use | The ECS service or CloudFront distribution may not be serving yet |
| `--full-wait` | A smoke test, a DNS cutover or a follow-on job starts as soon as the deploy returns | The extra minutes CloudFormation would also spend |

Pick by whether something downstream needs the resource to be serving. Where
the deploy runs (a laptop or CI) does not decide it.

The two flags are opposite ends of one setting. Passing both is rejected
before any AWS call:

```text
--no-wait and --full-wait cannot be combined: --no-wait skips stabilization waits, --full-wait adds them. Pick one.
```

## What `--no-wait` leaves unfinished

A resource created under `--no-wait` is fully functional once AWS finishes in
the background. Until then:

- A NAT gateway is still `pending`, so nothing in the deploy can rely on
  NAT-routed egress.
- An EC2 instance is still `pending`. cdkd cannot verify that its instance
  profile attached, and prints a warning naming the instance.
- An ACM certificate is left in `PENDING_VALIDATION`.
- A load balancer's DNS name returns 503 until it is `active`.

[Deploy: waits & concurrency](cli-deploy.md) lists what each mode does for
every affected resource type, next to what CloudFormation and Terraform do.

## Destroy always waits

The flags exist on `cdkd deploy` only. `cdkd destroy` waits in every case,
because a NAT gateway that is still `deleting` blocks the subnet, internet
gateway and VPC deletes that follow it with `DependencyViolation`.

## The mode does not change the stack lock

cdkd releases a stack's lock when the command finishes its work on that
stack. It does not hold the lock until the resources finish provisioning. In
every mode a second `cdkd deploy` on the same stack can therefore start while
resources from the first are still coming up. `--no-wait` widens that window
and `--full-wait` narrows it.

## Related

- [Deploy: waits & concurrency](cli-deploy.md): the per-type wait table, the
  concurrency flags, and what the stack lock covers
- [Deploy: tuning](cli-deploy-tuning.md): per-resource timeout overrides
- [Benchmarks](benchmarks.md): what each mode costs in wall clock
