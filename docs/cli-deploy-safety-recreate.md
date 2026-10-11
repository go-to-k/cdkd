---
title: "cdkd deploy: recreating a resource on the other route"
description: "When cdkd deploy needs --recreate-via-cc-api or --recreate-via-sdk-provider to move one resource between routes, what the recreate costs, and what follows it."
---

# cdkd deploy: recreating a resource on the other route

`--recreate-via-cc-api` and `--recreate-via-sdk-provider` delete one resource
and create it again in the same deploy, on the other
[provisioning route](cli-deploy-safety-routing.md). The first moves a
resource from cdkd's SDK provider to Cloud Control API, and the second moves
it back. You rarely need either, because cdkd changes routes in place wherever
it can.

```bash
cdkd deploy MyStack --recreate-via-cc-api MyLambda --yes

# Two resources: repeat the flag (there is no comma-separated form)
cdkd deploy MyStack \
  --recreate-via-cc-api MyLambda \
  --recreate-via-cc-api OtherFn \
  --yes

# A stateful resource also needs the data-loss flag
cdkd deploy MyStack \
  --recreate-via-cc-api MyTable \
  --force-stateful-recreation \
  --yes

# The other direction
cdkd deploy MyStack --recreate-via-sdk-provider MyLambda --yes
```

> [!WARNING]
> A recreate is a delete followed by a create. The resource is unavailable in
> between, a physical ID that AWS assigns changes, and a stateful resource
> loses its data.

This page is part of
[cdkd deploy: safety & compatibility flags](cli-deploy-safety.md).

## Check whether you need a recreate

Usually you do not. cdkd decides the route of a resource on the SDK provider
again on every deploy. So when you add a property that the SDK provider does
not write, the next plain deploy moves the resource to Cloud Control in place
and keeps its physical ID.

| Situation | What to do |
| --- | --- |
| You added the property to a resource on the SDK provider | Deploy without the flag |
| The resource is not deployed yet | Deploy without the flag |
| You added a create-only property | Deploy without the flag |
| The resource is already on Cloud Control | Drop the flag |
| The deploy refused with `CREATE_ONLY_DROP_NEEDS_REPLACEMENT` | Use the flag, or `--replace` |
| The in-place move to Cloud Control failed | Use the flag |
| A create-only property fed by a `NoEcho` parameter needs a new value | Use the flag |

Four of those rows need a sentence more.

A **create-only property** is one AWS accepts only when the resource is
created. When you add one, cdkd plans the replacement itself, and asks for
`--force-stateful-recreation` if the resource is stateful. See
[Replacements cdkd plans without a flag](cli-deploy-safety-replacement.md#replacements-cdkd-plans-without-a-flag).

When the resource is already on Cloud Control, or its type has no SDK
provider, the recreate would change nothing. cdkd refuses the flag before it
touches anything.

The in-place move fails when Cloud Control cannot address the resource by the
ID the SDK provider stored. The deploy reports that failure, and the recreate
is the way through.

For a `NoEcho` parameter, state holds only `***` in place of the value
([State Management](state-management.md)). The deploy warns that it cannot
confirm the value, and the recreate applies the new one.

### How cdkd knows a property is create-only

Where cdkd has no rule of its own, it reads the answer from the type's
CloudFormation schema through `cloudformation:DescribeType`. Without that
permission cdkd warns and uses its bundled copy of the schema. For a type with
no bundled schema it treats the change as an update in place. Where nothing
rejects that update, the deploy can report success with the property
unapplied.

## `--recreate-via-cc-api` (deploy)

`--recreate-via-cc-api <LogicalId>` deletes the named resource and creates it
again through Cloud Control API. The new resource is recorded on Cloud Control
(`provisionedBy: 'cc-api'` in state) and stays there on later deploys.

```bash
cdkd deploy MyStack --recreate-via-cc-api MyLambda --yes
```

The template does not have to change. cdkd recreates a named resource even
when its diff is empty, and the deploy counts it as an update.

cdkd checks the argument when it parses the command line, and rejects one
that is not a valid CloudFormation logical ID. If the same deploy deletes the
named resource, for example because its `Condition` is now false, cdkd does
not recreate it and warns.

## `--recreate-via-sdk-provider` (deploy)

`--recreate-via-sdk-provider <LogicalId>` is the reverse direction. It deletes
the named resource and creates it again through cdkd's SDK provider, so a
resource recorded `provisionedBy: 'cc-api'` becomes `provisionedBy: 'sdk'`.

```bash
cdkd deploy MyStack --recreate-via-sdk-provider MyLambda --yes
```

Use it when a resource went to Cloud Control for a property the SDK provider
did not write, and either a later cdkd release added that property or you
removed it from the template. Without the flag such a resource stays on Cloud
Control.

Some types return to the SDK provider by themselves, in place and with no
recreate. Check
[`--pin-cc-api`](cli-deploy-safety-routing.md#pin-cc-api-deploy) for that case
first, because the recreate is destructive and the automatic return is not.

A new resource needs neither flag. It uses the SDK provider whenever its type
has one and the template sets no property that provider does not write.

Everything else on this page applies to both flags: one flag per resource, the
same cost, the same
[stateful-resource guard](cli-deploy-safety.md#stateful-resource-guard), one
shared prompt, and the same [nested-stack scope](#nested-stacks).

### When cdkd refuses `--recreate-via-sdk-provider`

- The resource is already recorded `provisionedBy: 'sdk'`, or its record
  predates that field. There is nothing to move.
- The type has no SDK provider. The recreate would land on Cloud Control
  again.
- The template still sets a property the SDK provider does not write, and
  `--prefer-sdk-route` does not name it. The next deploy would move the
  resource straight back. Remove the property, or name it in
  `--prefer-sdk-route`.
- The same logical ID is also in `--recreate-via-cc-api` or `--pin-cc-api`.
  Those ask for the opposite.
- The type is `AWS::DynamoDB::GlobalTable`. See [Limits](#limits).

## `CREATE_ONLY_DROP_NEEDS_REPLACEMENT`

This refusal means a property that an earlier deploy kept off AWS can now only
be applied by replacing the resource, and cdkd will not replace it without
being asked.

It comes about like this. An earlier deploy passed
[`--prefer-sdk-route`](cli-deploy-safety-routing.md#prefer-sdk-route-deploy)
for a create-only property, so AWS never held the value. A later deploy then
stops covering the resource with that flag. Two changes do that: removing the
flag, and adding another property the flag does not name, since one uncovered
property moves the whole resource to Cloud Control.

cdkd refuses when that property is the only thing asking for a replacement and
the template still sets it unchanged. The refused resource is not touched.
Other resources of the same deploy may already have changed, and they roll
back as they do after any failure.

The error names four remedies:

| Remedy | Effect |
| --- | --- |
| `--recreate-via-cc-api <LogicalId>` | Deletes the resource, then creates it through Cloud Control with the property |
| `--replace` | Replaces every such resource in the deploy, nested stacks included |
| `--force-stateful-recreation` | Also required when the resource is stateful |
| `--prefer-sdk-route <Type>:<Prop>,...` | Keeps the resource on its SDK provider, still without the property |

`--replace` creates the new resource before it deletes the old one. That
collides when the resource holds a unique value other than its name, such as a
subnet's CIDR block.

cdkd refuses `--recreate-via-cc-api` while `--prefer-sdk-route` still names
the same property, so drop that entry in the same run.

### Edge cases

- **Something else in the template already requires a replacement.** The
  replacement goes ahead and applies the property.
- **The template removes the property.** The resource is not replaced.
- **`cdkd diff`** shows the replacement and warns that the deploy refuses it.
  The warning does not change `cdkd diff`'s exit code.
- **An imported resource, or one an older cdkd created with the flag.** cdkd
  knows a property was kept off AWS only when the deploy that created the
  resource recorded it. For these resources cdkd assumes AWS has the value, so
  the deploy reports no change while the property may still be missing.
  `--recreate-via-cc-api` applies it.

## Confirmation prompt

Before cdkd destroys anything, it prints one row per target with the logical
ID, the type and a direction tag such as `[SDK → CC]`, then asks:

```text
Continue? (y/N):
```

One prompt covers the whole stack and both flags. With `--yes` (or `-y`) cdkd
logs the plan once as a warning and proceeds. Without a terminal and without
`--yes`, cdkd rejects the run with an error, because nobody can answer.

A stateful target's row is marked `**DATA LOSS**`. What the prompt shows for a
bucket or a log group is under
[What the recreate prompt shows](cli-deploy-safety.md#what-the-recreate-prompt-shows).

## What else the recreate changes

### Resources that reference the target

When AWS assigns the physical ID, as it does for a security group or a REST
API, the recreated resource gets a new one. Resources in the same stack that
read the ID through `Ref` or `Fn::GetAtt` follow it in the same deploy. What
happens to such a reader depends on the property that holds the reference:

- If the property can be updated in place, the reader is updated to the new
  ID.
- If the property is create-only, such as an `AWS::EC2::Volume`'s `KmsKeyId`,
  the reader is replaced, and so are its own create-only readers.
- If the property is create-only and the reader is stateful, cdkd refuses with
  `STATEFUL_REPLACE_BLOCKED` before it touches anything. Pass
  `--force-stateful-recreation`, or declare `UpdateReplacePolicy: Retain` on
  the reader.

The confirmation prompt lists these readers under "Replaced if the id
changes", with **DATA LOSS** on a stateful one.

A target whose physical ID is a name written as a literal in the template,
such as a function with an explicit `FunctionName`, keeps its ID. A reader
that only uses `Ref` is then left alone. A reader of one of the target's
attributes is still listed, because an attribute such as a table's `StreamArn`
can change.

The early refusal covers a direct chain of create-only references. A stateful
resource reached another way (through a custom resource, a nested stack's
`Parameters`, or a rejected in-place update) is refused mid-deploy instead,
after the target was recreated. `--force-stateful-recreation` covers that
case too.

### Resources that live inside the target

Some resources are deleted together with their parent: a Lambda function's
permissions, versions and aliases, an SNS topic's subscriptions, a queue's or
bucket's policy, a log group's filters, an IAM role's inline policies. When
cdkd recreates the parent under the same physical ID, it creates those
children in the same stack again too.

Managed policies and group memberships attached to a recreated IAM principal
are detached first and attached again. A Lambda function URL is not handled
this way.

[cdkd deploy safety internals](cli-deploy-safety-internals.md#resources-that-follow-a-recreated-resource)
has the exact rules for readers and children, including what state holds if
the deploy fails between the parent and a child.

### Other stacks that read the target

Another stack that reads the recreated resource's outputs, through
`Fn::GetStackOutput` or `Fn::ImportValue`, sees the new physical ID only after
that stack is deployed again. Recreate from leaf stacks to root.

When cdkd plans the recreate it looks through the state bucket for such
consumer stacks and names the ones it finds in a warning. If it cannot read
the bucket it prints a general caution instead, so an empty list does not
prove there are none.

## Nested stacks

Both flags take a logical ID of the stack you are deploying and act only in
that stack. A resource inside a nested stack cannot be recreated with them.

| Target | Result |
| --- | --- |
| An ID that exists only in a nested stack | Refused before anything is touched; the error names the parent's nested stacks |
| An ID the parent and a child both declare | Only the parent's resource is recreated |
| The nested stack's own `AWS::CloudFormation::Stack` resource | Refused, with no bypass: it would delete the whole child stack |

## Limits

- **There is no stack-wide form.** You name each target, so each recreate is
  acknowledged.
- **The same resource's property cannot also be in `--prefer-sdk-route`.** The
  two flags ask for opposite things, and cdkd refuses before it touches
  anything.
- **A type Cloud Control cannot create** (`AWS::CodeBuild::Project`,
  `AWS::IAM::Policy`), or one whose SDK provider opts out of Cloud Control, is
  refused before anything is touched, with no bypass.
- **A type whose Cloud Control handler cannot manage it**
  (`AWS::Scheduler::Schedule`, `AWS::RDS::DBProxyTargetGroup`,
  `AWS::Lambda::EventInvokeConfig`) stays on the SDK provider, so the recreate
  would land on the same route.
- **`AWS::DynamoDB::GlobalTable`** is refused by both flags, and
  `--force-stateful-recreation` does not change that. A destroy and recreate
  across replica regions involves backups and replication that cdkd does not
  attempt. There is no bypass.
- **Another account or region** is out of reach. The flags work within the
  deploy's own environment.

## Related

- [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): the
  stateful-resource guard and `--force-stateful-recreation`
- [cdkd deploy: provisioning route flags](cli-deploy-safety-routing.md): how cdkd
  picks a route, `--prefer-sdk-route` and `--pin-cc-api`
- [cdkd deploy: replacements and name collisions](cli-deploy-safety-replacement.md):
  `--replace`
- [cdkd deploy safety internals](cli-deploy-safety-internals.md): the exact rules
  behind a recreate
