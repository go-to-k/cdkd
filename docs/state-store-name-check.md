---
title: Name check before a create
description: "Why cdkd refuses to create a resource whose generated name an existing resource already holds, which resource types are checked, and how to adopt a resource that is yours."
---

# Name check before a create

Before cdkd creates certain resources under a name it generated, it asks AWS
whether a resource already holds that name. If one does, and nothing this
stack has recorded names it, the deploy refuses to create the resource and
stops with the error code `GENERATED_NAME_HELD`.

The check is one of the two that keep
[one stack name to one deployment](state-store.md#one-stack-name-per-account-and-region).
It works whatever state backend the other deployment uses: another
`--state-prefix`, another `--state-bucket`, or another account's bucket.

## Why a taken name is dangerous

For most resource types, a create call fails when the name is taken. For the
types below it does not fail. The call hands back the existing resource, or
overwrites it:

| Resource type | Looked up with |
| --- | --- |
| `AWS::SQS::Queue` | `sqs:GetQueueUrl` |
| `AWS::SNS::Topic` | `sns:GetTopicAttributes` |
| `AWS::Logs::LogGroup` | `logs:DescribeLogGroups` |
| `AWS::CloudWatch::Alarm` | `cloudwatch:DescribeAlarms` |
| `AWS::Events::Rule` | `events:DescribeRule` |
| `AWS::S3::Bucket` | `s3:ListBucket` on that bucket |
| `AWS::ECS::Cluster` | `ecs:DescribeClusters` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | `elasticloadbalancing:DescribeLoadBalancers` |
| `AWS::ElasticLoadBalancingV2::TargetGroup` | `elasticloadbalancing:DescribeTargetGroups` |
| `AWS::StepFunctions::StateMachine` | `states:DescribeStateMachine` |

Without the check, a deploy that met another deployment's queue under its own
generated name would record that queue as its own. A later destroy or rollback
would then delete it.

Only these types are checked. Every other type's create fails on a taken name,
and a create through Cloud Control refuses an existing name.

A name your template declares is not looked up. Declaring a name is choosing
it.

## When a taken name is allowed

The create goes ahead when this stack's own records show that the existing
resource belongs to it. cdkd looks in these places:

- **The state record.** The resource is in the stack's record, under any
  logical ID, or among the resources a rollback left in AWS.
- **The rollback journal.** A failed deploy of this stack created the
  resource and recorded its physical ID.
- **The create-token ledger** (`create-tokens.json`). The deploy writes the
  names it is about to create before it sends the creates. A re-run after a
  crash finds the name there and takes the resource back.
- **`retained.json`.** The stack let go of the resource but kept it in AWS
  (`RemovalPolicy.RETAIN`), in a destroy or in a deploy that removed it from
  the template. The next deploy under the same prefix that creates it again
  takes it back.
- **The stack's history**, only when the stack has no `retained.json` because
  an older cdkd destroyed it last. cdkd reads earlier versions of the record
  and the deployment events for a resource that was kept.

For a type that reports a creation time, the time must also fit. A resource
created after this stack let go of the name belongs to someone else.

[The internals page](state-store-internals.md#a-create-never-takes-over-a-resource-it-cannot-account-for)
states each of these rules in full.

## What a refusal looks like

The message names the resource that holds the name, the likely cause, and the
command that adopts the resource:

```text
MyQueue would be created with the cdkd-generated name ..., which an existing
resource (...) already holds, and nothing this stack records names that
resource ...
```

That one resource is not created. Resources the same deploy created earlier
are rolled back, as after any failure.

What to do depends on whose resource it is:

- **Another deployment owns it.** Deploy this stack under that deployment's
  state backend only, or give this stack another name.
- **It is this stack's own.** Adopt it with the command the message prints,
  then run the deploy again:

  ```bash
  cdkd import MyStack --resource MyQueue=<physicalId>
  ```

### After `cdkd state orphan`

`cdkd state orphan` removes the record and empties `retained.json`, so nothing
this stack records names its resources any more. A redeploy under the same
prefix that would create one of them again is refused, and `cdkd import`
adopts it.

This is deliberate. Orphaning is how you hand a record over, and cdkd does not
take the resources back on its own.

## Permissions

The lookups need the read action in the table above for each type the stack
creates.

A lookup that AWS refuses with 403 prints a warning, and the create goes
ahead as it did before the check existed. Any other lookup failure refuses
that create.

Two more actions on the state bucket are optional: `s3:ListBucketVersions` and
`s3:GetObjectVersion`. cdkd uses them to read earlier versions of a record
after an upgrade. Without them, that source allows nothing.

## What the check costs

A redeploy that creates nothing looks nothing up. Updates, no-change deploys
and destroys make no lookup either.

On a first deploy, cdkd starts every lookup at once as soon as the plan is
known, and each create waits only for its own answer. A first deploy pays
about one round trip, whatever its size.

Every lookup is an exact read by name. cdkd never uses a listing such as
`ListQueues`, because a listing can omit a resource created a minute earlier.

A queue or a bucket can still read as present for up to a minute after it was
deleted. When one holds the name, cdkd reads it again every 10 seconds for
about 65 seconds before it refuses the create.

## What the check does not see

- **Two first deploys of the same stack name at the same moment.** A resource
  created between the lookup and the create is missed. In one bucket the
  [stack registry](state-store-registry.md) serializes the two deploys. In
  two buckets the gap remains for as long as the deploy runs.
- **A kept resource that no record names any more.** For example, an older
  cdkd kept it and its history has since rotated away. Re-adding it is
  refused, and `cdkd import` adopts it.
- **A re-created resource of a type with no creation time.** An S3 bucket,
  SNS topic, CloudWatch alarm, EventBridge rule, ECS cluster or ELBv2 target
  group that this stack kept, that was then deleted outside cdkd and created
  again by another deployment, is allowed by its name alone.
- **A bucket of the same name in another region** counts as holding the name.

## Related

- [Manage Stacks Without the App](state-store.md#one-stack-name-per-account-and-region): why
  a stack name is one deployment
- [Stack registry](state-store-registry.md): the second check, on stacks in
  one bucket
- [Lock and state errors](troubleshooting-locks-state.md#x-would-be-created-with-the-cdkd-generated-name-n-which-an-existing-resource-already-holds):
  the troubleshooting entry for this refusal
- [Import Existing Resources](import.md): adopting a resource into a stack
