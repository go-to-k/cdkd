---
title: Slow deploys, throttling and retries
description: "Find why a cdkd deploy is slow, what cdkd retries and for how long, and what to do when the retries run out."
---

# Slow deploys, throttling and retries

cdkd deploys independent resources in parallel and retries the errors that
usually clear by themselves. This page explains what limits a deploy's speed,
what cdkd retries and for how long, and how to read the line it prints when
it stops retrying.

On this page:

- [Deployment is Slow](#deployment-is-slow)
- [Cloud Control API Rate Limit](#cloud-control-api-rate-limit)
- [A name is still held by the resource you just deleted](#a-name-is-still-held-by-the-resource-you-just-deleted)
- ["cdkd stopped waiting for it" — a network outage during a Cloud Control operation](#cdkd-stopped-waiting-for-it-a-network-outage-during-a-cloud-control-operation)

## Deployment is Slow

A deploy is slower than it should be when a handful of independent resources
takes well over a minute, or when adding resources that do not depend on each
other lengthens the deploy roughly in proportion.
[Benchmarks](benchmarks.md) has the figures to compare against.

There are four usual causes:

| Cause | How to check |
| --- | --- |
| A long dependency chain | [Inspect the dependency graph](#inspect-the-dependency-graph) |
| A resource on the slower Cloud Control route | [Resources on the Cloud Control route](#resources-on-the-cloud-control-route) |
| Cloud Control throttling | `Rate exceeded` under `--verbose`; see [Cloud Control API Rate Limit](#cloud-control-api-rate-limit) |
| Asset publishing | Slow asset steps before provisioning starts; see the asset flags under [Cloud Control API Rate Limit](#cloud-control-api-rate-limit) |

### Inspect the dependency graph

A dry-run deploy with `--verbose` builds the graph and stops before touching
AWS:

```bash
cdkd deploy MyStack --dry-run --verbose
```

```text
... DEBUG [DagBuilder] Dependency graph built: 4 nodes, 3 edges
... DEBUG [DagBuilder] Level 0: 2 resources - Bucket, Table
... DEBUG [DagBuilder] Level 1: 1 resources - Role
... DEBUG [DagBuilder] Level 2: 1 resources - Function
... DEBUG [DagBuilder] Execution levels computed: 3 levels
✓ Dry run completed - no actual changes made
```

A level is a group of resources that do not depend on each other. Resources
in a chain cannot run at the same time, so a graph with many levels and few
resources per level is what slows a deploy down. A real deploy prints the same
figure in one line:
`Deploying 4 resource(s) (DAG: 3 levels, max parallel: 10)`.

During a deploy each resource starts as soon as its own dependencies
complete, so cdkd does not wait for a whole level to finish. A destroy
deletes level by level, in reverse order.

### Remove dependencies the template does not need

cdkd works out the order from the `Ref` and `Fn::GetAtt` references in the
template. An explicit `addDependency` between resources that do not use each
other adds nothing except a wait:

```typescript
const bucket = new s3.Bucket(this, 'Bucket');
const role = new iam.Role(this, 'Role', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
});
// delete this line: the role does not use the bucket
role.node.addDependency(bucket);
```

### Resources on the Cloud Control route

```bash
cdkd state show MyStack
```

```text
MyTopic
  Type: AWS::SNS::Topic
  PhysicalID: arn:aws:sns:us-east-1:123456789012:MyTopic
  ProvisionedBy: cc-api
```

`ProvisionedBy: cc-api` means cdkd manages the resource through the Cloud
Control API, which is slower than one of cdkd's own SDK providers. cdkd sends
a resource there when its template carries a top-level property the SDK
provider does not send, and the resource stays there on later deploys.

Whether you need to act depends on the type:

- For some types cdkd moves the resource back by itself. Once cdkd covers
  every property the resource uses, the next deploy that changes the resource
  moves it back in place. See
  [`cdkd diff` shows `[returning to SDK provider]`](troubleshooting-mismatch.md#cdkd-diff-shows-returning-to-sdk-provider).
- For any other type, move it yourself with
  `--recreate-via-sdk-provider <LogicalId>`. This flag destroys and recreates
  the resource.

`--recreate-via-sdk-provider` refuses while the template still carries the
property that sent the resource to Cloud Control. Remove the property, or
pass `--prefer-sdk-route <Type>:<Prop>` to accept that the property is
dropped.
[Provisioning Layers](provisioning-layers.md) explains the two layers, and
[cdkd deploy: safety & compatibility flags](cli-deploy-safety.md) the flags.

## Cloud Control API Rate Limit

```
ProvisioningError: Failed to create resource MyTopic
Caused by: CREATE failed for MyTopic: Rate exceeded
```

The Cloud Control API throttled the request (`ThrottlingException`). AWS
publishes no rate quota for Cloud Control, but it throttles when requests
arrive too fast, and a stack with many independent resources issues many
calls at once.

cdkd retries a throttled request by itself, so you normally see this message
only under `--verbose` or after the retries are used up. If throttling fails
the deploy, lower the concurrency:

```bash
# default 10, concurrent resource operations
cdkd deploy MyStack --concurrency 4

# default 4, concurrent stacks
cdkd deploy --all --stack-concurrency 2
```

Asset publishing has its own limits: `--asset-publish-concurrency` (default 8)
and `--image-build-concurrency` (default 4).

### What cdkd retries

cdkd retries create, update and delete operations during `cdkd deploy`, and
the replays `cdkd rollback` and `cdkd drift --revert` perform. The schedule
depends on the kind of error:

| Kind of error | Examples | Retries | Total wait |
| --- | --- | --- | --- |
| Throttling and transient | Rate limits, a resource still leaving `Pending`, HTTP 500 / 502 / 503 / 504 | 8, backing off 1s to 8s | 47s |
| IAM propagation | `cannot be assumed`, `not authorized to perform`, `Invalid IAM Instance Profile`, `not authorized to access the Log Destination` | 26, every 0.25s to 2s | 47.75s |
| A name still held by a deleted resource | `QueueDeletedRecently`, Step Functions `StateMachineDeleting` | 8, backing off 2s to 10s | 64s |

An access denial that says the call was refused `with an explicit deny` (by a
service control policy, a permissions boundary, a bucket policy or any other
policy's `Deny` statement) is not retried on the schedules above, even though
its message contains `not authorized to perform`: waiting does not lift a
`Deny`. cdkd fails on the first answer, and an S3 bucket error names the policy
type. A few resources keep a small retry of their own outside these schedules,
such as the `AWS::ApiGateway::Account` CloudWatch-role update and a custom resource's re-invoke
described below.

Two kinds of resource are outside this retry: custom resources (`Custom::*`
and `AWS::CloudFormation::CustomResource`) and nested stacks
(`AWS::CloudFormation::Stack`).

A custom resource has its own retry. When your handler returns `FAILED` with a
reason that looks like a missing permission, cdkd invokes the handler again.
`CDKD_CR_AUTHZ_MAX_RETRIES` sets how many times (default 2, at most 10), and
`0` turns this off.

### Reading the "gave up after" line

When the retries run out, cdkd prints one line at the default log level:

```text
MyFunction: gave up after 26 IAM-propagation retries over 47.75s of propagation backoff (the full propagation budget) - The role defined for the function cannot be assumed by Lambda.
```

When cdkd can see how the AWS SDK parsed the failing response, the line ends
with a bracketed summary:

```text
MyQueuePolicy: gave up after 5 IAM-propagation retries over 5.75s of propagation backoff - Failed to create SQS queue policy MyQueuePolicy: InternalFailure. Re-run with --verbose for AWS's own message. [name=InternalFailure http=500 requestId=ebf581cc-6072-5ffc-943a-e33312488615]
```

What the line tells you:

- **It ends with `(the full propagation budget)`.** cdkd retried to the end of
  its schedule. Usually IAM took longer than 47.75s to propagate. Re-run the
  deploy. If it happens again, open an issue and include the line.
- **It ends the same way, but AWS also uses the message for permanent
  problems.** Then the cause is a real misconfiguration, such as the Step
  Functions
  [log-destination](troubleshooting-permissions.md#the-state-machine-iam-role-is-not-authorized-to-access-the-log-destination)
  error. Fix what the AWS message names. Re-running never succeeds.
- **It has no budget note and a low retry count.** Something ended the retries
  early: an explicit deny, or an error cdkd could not classify. Read the
  bracket. Report it if the status is a 5xx other than 500 / 502 / 503 / 504,
  or if the bracket shows `no-$metadata`.
- **It says `transient server-error retries (HTTP 5xx)`.** The retries were
  spent on transient server errors and not on IAM propagation. Re-run.
- **There is no such line at all.** The retry never started. Either cdkd did
  not recognise the error, or the resource is a custom resource or a nested
  stack. Report the unrecognised wording, unless the resource is one of those
  two types.

Details of the line:

- `Re-run with --verbose for AWS's own message.` means cdkd shows only the
  error's name, because AWS's text can name your account and role. `--verbose`
  prints the full text.
- `UnknownError` in place of a message is the AWS SDK's placeholder for a
  response with no message text.
- The bracket is often the whole diagnosis: `name` and `http` are what cdkd
  classifies on, and `requestId` is what AWS support needs.
- `no-$metadata` in place of `http=` means the failure never reached the SDK's
  error parsing: a network or protocol failure.
- The seconds count propagation backoff only. A throttle in between uses an
  attempt without counting, so the retry count on a full-budget line can be
  below 26.
- `--verbose` prints each attempt with its running total
  (`attempt 15/26, 25.75s backoff through this attempt`).
- The line can appear during `cdkd rollback` and an automatic rollback as well
  as during `cdkd deploy`.

[Troubleshooting internals](troubleshooting-internals.md) has the exact
schedules and the custom-resource retry rules.

## A name is still held by the resource you just deleted

A destroy followed straight away by a deploy fails on a name that looks free:

```
ProvisioningError: Failed to create resource MyQueue
Caused by: You must wait 60 seconds after deleting a queue before you can create another with the same name.
```

Some services keep a name reserved for a while after the delete returns. cdkd
retries the create for 64 seconds, so usually you never see this error.

| Type | Window |
| --- | --- |
| `AWS::SQS::Queue` | 60s, stated by the service |
| `AWS::StepFunctions::StateMachine` | About 23s of `status: DELETING` on an idle machine |
| `AWS::S3::Bucket` | Bucket names are global and released asynchronously |

Wait and re-run. When the retries run out, the line says so:

```
MyQueue: gave up after 8 name-cooldown retries over 64.00s waiting for the name to be released (the full name-cooldown budget) - <the AWS message>
```

You can hit the Step Functions case without having declared a state machine.
Any CDK app that uses `custom_resources.Provider` with an `isCompleteHandler`
contains one.

### Name errors that waiting does not fix

cdkd does not retry these, so do not wait for them:

- ELBv2 `DuplicateLoadBalancerName` and DynamoDB's create-side refusal, which
  mean the resource still exists.
- A Secrets Manager name scheduled for deletion, which can be held for 7 to 30
  days.

### During a `--replace`

During a `--replace` the retry runs once per replacement attempt, so a
custom-named SQS queue can appear to hang for up to about 11 minutes.

## "cdkd stopped waiting for it" — a network outage during a Cloud Control operation

```text
CREATE of Dbwriter9B286E50 was accepted by Cloud Control API, but cdkd stopped
waiting for it (cdkd could not reach Cloud Control API for 121s: connect
ECONNREFUSED 100.72.0.178:443). The operation may still be running in AWS, and
cdkd has NO state record for it, so any resource it creates is untracked by
rollback and by cdkd destroy. Check what it did with:
  aws cloudcontrol get-resource-request-status --request-token <token> --region ap-northeast-1
```

Your connection dropped while a Cloud Control operation was running. A VPN
that reconnects is the usual cause.

Cloud Control runs an operation inside AWS and gives cdkd a request token.
cdkd asks for the result with that token until the operation finishes, and
the operation continues whether or not cdkd can reach AWS. cdkd keeps trying
for about two minutes without a connection. After that it gives up, and it
does not know how the operation ended.

Run the command the error prints and read `OperationStatus`:

| `OperationStatus` | Meaning | Do |
| --- | --- | --- |
| `SUCCESS` | AWS did the operation; for a create, cdkd has no record of the resource | Adopt it with [`cdkd import`](import.md) using the response's `Identifier`, or delete it in AWS |
| `FAILED` | Nothing was created | Re-run `cdkd deploy` |
| `IN_PROGRESS` | Still running | Run the status command again until it settles |

A `RequestTokenNotFoundException` means the request has aged out of Cloud
Control's status history. Look for the resource in the console or through the
service's API, then import or delete it.

### After an update or a delete

Only a create can leave a resource without a state record. After an update or
a delete the resource still has its record, so re-running `cdkd deploy` or
`cdkd destroy` finishes the job once the network is back.

If the same deploy also reported `Failed to save partial state before
rollback` or `Failed to write rollback journal`, the outage took those too. See
[After a failed or interrupted deploy](troubleshooting.md#after-a-failed-or-interrupted-deploy).

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
