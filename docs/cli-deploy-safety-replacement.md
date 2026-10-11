---
title: "cdkd deploy: replacements and name collisions"
description: "When cdkd deploy replaces a resource instead of updating it, what --replace adds, and what to do when the replacement or a create collides with a name that is already taken."
---

# cdkd deploy: replacements and name collisions

A replacement creates a new physical resource and deletes the old one. cdkd
replaces a resource when a change cannot be applied to the existing one. Some
replacements cdkd plans by itself, and some need `--replace`.

```bash
# plans replacements the template requires
cdkd deploy MyStack

# also replace where AWS has no update call
cdkd deploy MyStack --replace --yes

# same, and accept the data loss
cdkd deploy MyStack --replace --force-stateful-recreation
```

| What changed | What cdkd does |
| --- | --- |
| A create-only property, in the template | [Replaces without a flag](#replacements-cdkd-plans-without-a-flag) |
| Any property, on a type AWS has no update call for | Fails; [`--replace`](#replace-deploy) replaces |
| The resource's `Type`, under the same logical ID | [Replaces without a flag](#type-changes-on-an-existing-logical-id) |

When the resource being replaced holds data, the
[stateful-resource guard](cli-deploy-safety.md#stateful-resource-guard)
refuses the deploy until you pass `--force-stateful-recreation`. This page is
part of [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md).

## `--replace` (deploy)

Some resource types cannot be updated, because AWS has no update call for
them. A property change on such a type means a new physical resource. Examples
are `AWS::EFS::AccessPoint`, `AWS::ECS::TaskDefinition`,
`AWS::Glue::SecurityConfiguration` and several `AWS::ApiGatewayV2::*` identity
fields. Without the flag the provider rejects the update with
`ResourceUpdateNotSupportedError` and the deploy fails.

`--replace` turns that failure into a delete and a create, which is what
CloudFormation does for the same change.

```bash
# A Glue SecurityConfiguration's EncryptionConfiguration changed
cdkd deploy MyStack --replace --yes
```

The flag applies to the whole stack and names no resource. It acts only where
an update is rejected, so a resource whose update succeeds in place is
unaffected. To move one resource between provisioning routes, use
[`--recreate-via-cc-api` or `--recreate-via-sdk-provider`](cli-deploy-safety-recreate.md)
instead.

### What a replacement costs

- **A new physical ID.** Stacks that consume the resource need a redeploy.
  `--replace` neither prompts nor lists those stacks.
- **Data loss on a stateful type.** cdkd refuses unless you also pass
  `--force-stateful-recreation`, and that flag covers every replacement in the
  run. See
  [An update the route cannot apply in place](cli-deploy-safety.md#an-update-the-route-cannot-apply-in-place).
  A type that is not stateful, such as a layer version, a Glue security
  configuration or a task definition, is replaced with `--replace` alone.
- **A short outage when the name is kept.** See
  [Same-name replacement](#same-name-replacement-delete-first-ordering).

## Replacements cdkd plans without a flag

When you change a create-only property in the template, cdkd sees the
replacement in the diff and performs it on a plain `cdkd deploy`. A
create-only property is one AWS accepts only when the resource is created.
Examples are an `AWS::EFS::FileSystem` `PerformanceMode` change, an
`AWS::EC2::Volume` `AvailabilityZone` move, an S3 `BucketName` rename, and
new `AWS::Lambda::LayerVersion` content.

cdkd creates the new resource first and then deletes the old one, which is
CloudFormation's order.

A type that is not stateful is replaced with no further flag. A stateful
type is refused with `STATEFUL_REPLACE_BLOCKED`. See
[Property-driven replacement and `STATEFUL_REPLACE_BLOCKED`](cli-deploy-safety.md#property-driven-replacement-and-stateful-replace-blocked).

## Same-name replacement: delete-first ordering

Creating the new resource first cannot work when it needs a physical name the
old resource still holds. The deploy then fails with one of two codes, and
both messages name `--replace`:

| Code | What happened |
| --- | --- |
| `NAMED_REPLACEMENT_COLLISION` | The create collided with the existing resource's name |
| `NAMED_REPLACEMENT_IDEMPOTENT_CREATE` | The create returned the old resource's ID instead of a new one |

The second code comes from a create API that treats the name as a key. For
example, `CreateQueue` with an unchanged `QueueName` returns the existing
queue.

You have two ways through:

- **Rename the resource in your CDK code.** The new resource then has a free
  name, cdkd keeps the create-first order, and there is no outage.
- **Pass `--replace`.** cdkd deletes the old resource first and creates it
  again under the same name, so the resource is briefly unavailable.

`--replace` does not help in three cases, and in each of them nothing is
deleted:

- The old resource declares `UpdateReplacePolicy: Retain`. It keeps the name,
  so a same-name replacement can never proceed. See
  [Under `UpdateReplacePolicy: Retain`](cli-deploy-safety.md#under-updatereplacepolicy-retain).
- The template also changes the name, and another resource holds the new name.
  See [below](#when-the-new-name-belongs-to-another-resource).
- cdkd cannot show that the old resource is what holds the name. See
  [below](#when-cdkd-cannot-show-the-old-resource-holds-the-name).

`cdkd rollback` can raise `NAMED_REPLACEMENT_COLLISION` too, and `--replace`
is not a rollback flag. See
[Reversing a replacement](cli-rollback-limitations.md#reversing-a-replacement).

### When the new name belongs to another resource

A replacement that also changes the physical name can collide with a resource
other than the one being replaced. An example is a function renamed to a name
another stack already uses.

cdkd compares the name the template declares with the name the old resource
holds. When they differ, deleting the old resource would not free the new
name, so the deploy fails with `NAMED_REPLACEMENT_COLLISION` and says the name
is held by another resource. Pick a free name, or delete the resource that
holds it if it is yours.

Some replacements normally delete first: the fallback after a rejected update,
and the `--recreate-via-*` flags. When the names differ they create first
instead. A collision there also fails with nothing deleted. The same is true
when a create that treats the name as a key returns the resource already
holding the new name. Delete that resource by hand if it is yours.

### When cdkd cannot show the old resource holds the name

A collision tells cdkd that a name is taken. It does not say who holds it. A
resource left over from an earlier failed attempt, or one made outside the
stack, collides exactly as the old resource does.

So before `--replace` deletes anything, cdkd checks that the old resource
holds the name the create sent. It uses the name recorded in state and the
old resource's physical ID.

When the check fails or cannot decide, the deploy fails with
`NAMED_REPLACEMENT_COLLISION`, nothing is deleted, and the error does not
suggest `--replace`. Remove or rename whatever holds the name if it is yours.
If the holder is the resource being replaced, delete it by hand. Then re-run.

The rules for each case are in
[cdkd deploy safety internals](cli-deploy-safety-internals.md#how-replace-proves-the-old-resource-holds-the-name).

## A create under a name that is already taken

`NAMED_CREATE_COLLISION` means your template gives a resource an explicit
name, and a resource with that name already exists. Nothing was created.
Delete the existing resource, or adopt it into the stack with
[`cdkd import`](import.md), then re-run.

The error ends with the
`cdkd import <stack> --resource <logicalId>=<physicalId>` command for the
resource it found. Confirm the resource is yours before you run it.

cdkd makes this check because some create APIs do not fail on a taken name.
They return or overwrite the resource that already holds it. Without the
check, cdkd would record someone else's resource as the stack's own, and a
later `cdkd destroy` would delete it. The types are SQS queues, SNS topics,
Step Functions state machines, ECS clusters, ELBv2 load balancers and target
groups, EventBridge rules, CloudWatch alarms, log groups and S3 buckets.

For those types on cdkd's SDK providers, cdkd looks an explicit name up before
it creates anything. What it does when the name is taken, or when the lookup
cannot run, depends on the step:

| Deploy step | Result |
| --- | --- |
| A plain create | `NAMED_CREATE_COLLISION`; nothing is created |
| A replacement that changes the name | `NAMED_REPLACEMENT_COLLISION`; nothing is created or deleted |

A replacement that moves an EventBridge rule to another bus, or changes
`Type` onto one of these types, is treated like one that changes the name.

### Edge cases

- **The existing resource is this stack's own**, left by an interrupted deploy
  or kept under `DeletionPolicy: Retain`. The deploy still refuses, because
  nothing in AWS tells the two situations apart.
- **The holder is this stack's own resource under another logical ID**, as
  after a construct was moved or renamed. The error names that ID. Give the
  new resource another name, or deploy that ID's removal first.
- **An S3 bucket** gets no import command, because the lookup also finds
  buckets that other accounts own.
- **A log group that something else already created**, such as a Lambda
  function's `/aws/lambda/<name>` group, is refused the same way when you
  declare it.
- **A name cdkd generates** is not looked up.
- **A load balancer or target group** is looked up under the name the create
  sends. That name carries the stack-name prefix under
  `--prefix-user-supplied-names`.

## Type changes on an existing logical id

Changing a resource's `Type` while keeping its logical ID is always a
replacement. cdkd never applies it in place and never skips it as "no
changes", even when the two types declare identical properties.

The two halves go through different providers:

- cdkd deletes the existing resource through the provider of the type it
  recorded. The stateful guard and `UpdateReplacePolicy: Snapshot` judge that
  recorded type.
- cdkd creates the new resource through the provider of the type the template
  declares, and picks its route as for any new resource.

So leaving an `AWS::SSM::Parameter` for an `AWS::SNS::Topic` needs
`--force-stateful-recreation`, because a parameter is stateful. The reverse
does not.

### Name collisions across a type change

The [same-name rules](#same-name-replacement-delete-first-ordering) apply,
with two differences.

First, a change onto a type whose create
[adopts a taken name](#a-create-under-a-name-that-is-already-taken) looks the
name up even when it is unchanged. Any resource it finds fails the deploy.

Second, under `--replace` cdkd deletes the old resource first only between two
types that share one name space. Those are RDS, DocumentDB and Neptune
clusters, instances and subnet groups, and DynamoDB tables and global tables.
Any other pair fails with nothing deleted.

How cdkd tells apart two equal physical IDs of different types is in
[cdkd deploy safety internals](cli-deploy-safety-internals.md#equal-physical-ids-across-a-type-change).

### Rolling back a type change

`cdkd rollback` and the automatic rollback reverse a type change through both
types. Rollback works from the rollback journal, a file in the state bucket
that lists what the failed deploy did. When the journal cannot name the old
type, that one operation is refused with `ROLLBACK_REPLACEMENT_UNROUTABLE` and
the journal is kept. Fix forward with `cdkd deploy`, or pass
`--orphan <LogicalId>` to leave the resource as it is and let the rest of the
rollback proceed.

## Type changes into or out of a nested stack (`TYPE_CHANGE_NESTED_STACK`)

cdkd refuses a type change when either the old type or the new type is
`AWS::CloudFormation::Stack`. No flag overrides the refusal. Make it two
changes instead:

- give the new resource a different logical ID by renaming the construct, or
- remove the resource in one deploy and add its replacement in the next.

`cdkd deploy` and `cdkd deploy --dry-run` refuse before any resource is
touched:

```text
Refusing to deploy MyStack: a resource changes its Type into or out of AWS::CloudFormation::Stack, which cdkd does not replace in place (issue #2668).
  - Thing: Type changes from AWS::SNS::Topic to AWS::CloudFormation::Stack (the existing AWS::SNS::Topic is arn:aws:sns:us-east-1:111122223333:thing).
```

`cdkd diff` shows the same refusal under
`Blocking (cdkd deploy will refuse):` and exits `3`.

cdkd refuses this pair because a nested stack's resource owns a whole child
stack. If cleaning up the old half failed, that child stack would be stranded
under a deploy that reports success.

## Glue renames

Glue keeps a resource's name inside an input block such as `TableInput`. A
rename through that block follows CloudFormation:

| Change | Plan | Flags needed |
| --- | --- | --- |
| `TableInput.Name` (`AWS::Glue::Table`) | Replacement | `--force-stateful-recreation` |
| `ConnectionInput.Name` (`AWS::Glue::Connection`) | Replacement | None |
| `DatabaseInput.Name` (`AWS::Glue::Database`) | Update, which the provider refuses | `--replace --force-stateful-recreation` |

A table rename needs the data-loss flag because a Glue table is stateful.

Renaming a database through `DatabaseInput.Name` fails in CloudFormation too.
cdkd's provider refuses the update before any AWS call, because the update
would leave state naming the old database.

### Edge cases

- **A table name that differs only in letter case** is the same table, because
  Glue lowercases table names. It updates in place.
- **Another table holds the new name.** The replacement creates the renamed
  table first, so the create fails and nothing is deleted, with or without
  `--replace`. Pick a free name.
- **A table replacement that keeps its database, catalog and name** collides
  with the old table itself. `--replace` deletes the old table first and
  creates it again.
- **A `CatalogId` change on a database** is refused like a database rename.
  An absent `CatalogId` and your own account ID are the same catalog, so
  switching between those updates in place.
- **A `CatalogId` change on a table or a connection** is a replacement,
  because the property is create-only there.

## Related

- [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): the
  stateful-resource guard, `--force-stateful-recreation` and deletion
  protection
- [cdkd deploy: recreating a resource on the other route](cli-deploy-safety-recreate.md):
  replacing one named resource to change its route
- [`cdkd rollback`](cli-rollback.md): reversing a replacement after a failed
  deploy
- [`cdkd import`](import.md): adopting an existing resource into a stack
- [cdkd deploy safety internals](cli-deploy-safety-internals.md): the exact
  name-collision rules
