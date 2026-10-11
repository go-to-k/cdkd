---
title: "Deploy: wait mode details"
description: "What cdkd deploy --no-wait leaves unfinished for each resource type, what --full-wait adds for ECS and CloudFront, and the waits a destroy always performs."
---

# Deploy: wait mode details

`cdkd deploy` has three wait modes: the default, `--no-wait` and
`--full-wait`. This page describes, resource by resource, what a mode leaves
unfinished when the deploy returns, and what happens when a wait runs out.
[Deploy: waits & concurrency](cli-deploy.md#wait-modes) explains the modes and
has the table of affected resource types.

```bash
cdkd deploy MyStack --no-wait     # return as early as possible
cdkd deploy MyStack --full-wait   # wait as long as CloudFormation would
```

## What `--no-wait` leaves unfinished

Under `--no-wait`, cdkd returns as soon as AWS accepts the create call. AWS
finishes the resource in the background, and the resource is fully functional
once that work is done. Until then, the cases below need care.

### NAT gateway

Routes that need only the gateway's ID are created while the gateway is still
`pending`. That is safe when nothing in the deploy needs to reach the internet
through the gateway. A Lambda function that is invoked during the deploy and
calls an external service is an example of something that does.

### EC2 instance

cdkd normally checks that the instance's `IamInstanceProfile` was attached.
Under `--no-wait` it skips that check and prints a warning that names the
instance.

The check exists because `RunInstances` attaches an instance profile
asynchronously, and can finish with none attached when the profile was created
moments earlier. AWS rejects the association on a `pending` instance, so cdkd
cannot verify it without waiting. To verify it yourself afterwards:

```bash
aws ec2 describe-iam-instance-profile-associations \
  --filters Name=instance-id,Values=<instance-id>
```

A public address that AWS has not assigned yet is left out of state. cdkd
reads it from AWS again when something refers to it.

### Elastic IP attached to an instance of the same deploy

This case is an Elastic IP whose `InstanceId` is an instance that the same
deploy creates. Under `--no-wait`:

- On create, cdkd allocates the address and skips the association.
- On update, cdkd attempts the association and warns if AWS rejects it.

Both warnings print the exact `aws ec2 associate-address` command to run once
the instance is up. Repointing an Elastic IP at an instance that is already
running still works.

### Load balancer

cdkd returns while the load balancer is `provisioning`. Its `DNSName` answers
with HTTP 503 until the load balancer is `active`.

A load balancer with a capacity reservation has a second wait, and
`--no-wait` skips that one too. The reservation applies when the template sets
`MinimumLoadBalancerCapacity` with
`EnableCapacityReservationProvisionStabilize: true`. In the default mode cdkd
polls `DescribeCapacityReservation` until every zone reports `provisioned`,
for about ten minutes at most. If the poll times out, cdkd warns and
continues. A zone that reports `failed` is an error.

### ACM certificate

cdkd returns while the certificate is `PENDING_VALIDATION`. A certificate that
is not issued makes a CloudFront distribution or a load balancer that uses it
fail to create, which is why the default mode waits for `ISSUED`.

In the default mode, when that wait runs out, cdkd deletes the certificate it
requested, so that repeated attempts do not pile up certificates. ACM reuses a
domain's validation CNAME across certificates, so DNS records you add after
the failure still validate the next attempt. Use `--no-wait` to keep a
`PENDING_VALIDATION` certificate instead. See
[Troubleshooting](troubleshooting.md).

### `AWS::Lambda::MicrovmImage`

cdkd returns while the image is `CREATING`. The image's ARN is available
first, so stack outputs that use it still work.

### The wait `--no-wait` never skips

A Lambda-backed custom resource is one wait that every mode keeps. Just before
cdkd invokes the Lambda function behind an
`AWS::CloudFormation::CustomResource`, it waits for the function to be
`Active` with `LastUpdateStatus: Successful`. Without that wait the invoke
fails with `The function is currently in the following state: Pending`.

The wait belongs to that invoke only. An ordinary Lambda create or update
returns as soon as the API call returns. A Lambda function in a VPC that
nothing invokes therefore does not hold the deploy for the 5 to 10 minutes its
network interface takes to attach.

## What `--full-wait` adds

`--full-wait` adds two waits that CloudFormation performs and cdkd skips by
default: an ECS service reaching steady state, and a CloudFront distribution
reaching `Deployed`.

```bash
cdkd deploy MyStack --full-wait
```

### `AWS::ECS::Service`: steady state

By default cdkd returns once `CreateService` or `UpdateService` is accepted,
and prints the command to wait manually:

```text
aws ecs wait services-stable --cluster <cluster> --services <service>
```

The default does not wait because nothing later in the deploy needs a steady
service. `Fn::GetAtt` on a service yields `Name` and `ServiceArn`, and both
are valid at once. cdkd also does not check the rollout in the default mode,
because right after `CreateService` a healthy service and a failing one look
the same.

Under `--full-wait`, the service is done when it is stable and its rollout
has completed:

| Step | Limit | When it runs out |
| --- | --- | --- |
| Wait for steady state | 600 seconds | The deploy fails. |
| Poll the primary deployment's `rolloutState` until `COMPLETED` | About two minutes | cdkd warns and continues. |

A service can need longer than 600 seconds because of a large task count, a
slow image pull or a long health-check grace period. Raise the limit for that
type:

```bash
cdkd deploy MyStack --full-wait --resource-timeout AWS::ECS::Service=20m
```

[`--resource-timeout`](cli-deploy-tuning.md#per-resource-timeout) can only
raise this limit. It never lowers it.

When a new service never stabilizes, cdkd tries to delete the service before
it fails the deploy, so that the next deploy does not collide on the name. The
failure message carries the `aws ecs list-tasks --desired-status STOPPED` and
`describe-tasks` commands that show why the tasks stopped. Stopped tasks stay
visible for about an hour after the service is deleted.

### `AWS::CloudFront::Distribution`: `Deployed`

By default cdkd returns after the create or update call, and prints the
command to wait manually:

```text
aws cloudfront wait distribution-deployed --id <distribution-id>
```

The default does not wait because a distribution's `Fn::GetAtt` values (`Id`
and `DomainName`) are final in the create or update response, so nothing in
the deploy needs `Deployed`.

Under `--full-wait`, cdkd waits about 20 minutes. To wait longer, raise the
limit for the type:

```bash
cdkd deploy MyStack --full-wait \
  --resource-timeout AWS::CloudFront::Distribution=40m
```

As with ECS, the flag can only raise the limit.

A CloudFront wait that runs out does not fail the deploy. A distribution that
is still `InProgress` is slow and not broken, and failing would make the
automatic rollback disable and delete a healthy distribution. cdkd warns,
prints the manual wait command, and continues.

## Destroy always waits

`cdkd destroy` has no wait flags. These waits run on every destroy:

| Resource | Wait |
| --- | --- |
| NAT gateway | Until `deleted` |
| CloudFront distribution | Disable, then wait |
| Kinesis stream, Firehose delivery stream | Until the stream is gone |

Each wait is there for a reason:

- A NAT gateway that is still `deleting` blocks the deletes of its subnet,
  internet gateway and VPC with `DependencyViolation`.
- The CloudFront API requires a distribution to be disabled before it can be
  deleted.
- A Kinesis or Firehose stream keeps its name while it is `DELETING`, so a
  deploy right after the destroy would fail with `already exists`. If this
  wait runs out, cdkd warns and moves on.

RDS and ElastiCache deletes do not wait, because nothing in a destroy depends
on them.

## Related

- [Deploy: waits & concurrency](cli-deploy.md): the modes and the table of affected types
- [Wait Modes](wait-modes.md): the same choice, summarized for a first read
- [Deploy: tuning](cli-deploy-tuning.md#per-resource-timeout): `--resource-timeout` in full
- [Deploy: the stack lock](cli-deploy-lock.md): why a second deploy can start during these waits
