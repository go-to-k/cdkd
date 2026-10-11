---
title: "cdkd export: what blocks an export"
description: "Every reason cdkd export refuses a stack, with the remedy: types CloudFormation cannot import, identifiers cdkd cannot build, masked values and damaged state records."
---

# cdkd export: what blocks an export

[`cdkd export`](cli-export.md) refuses a stack when CloudFormation could not
adopt one of its resources. It checks before it locks the stack or submits
anything, and one message names every offending resource. A refused export
has changed nothing.

To see the blocks for a stack without exporting it, run:

```bash
cdkd export MyStack --dry-run
```

The [common blocks](cli-export.md#what-blocks-an-export) are on the
`cdkd export` page. This page covers the rest, grouped by cause.

## Resource types CloudFormation cannot import

CloudFormation cannot adopt every resource type. It rejects an IMPORT
changeset that contains one of the types below with
`ResourceTypes [<T>] are not supported for Import`. cdkd refuses the stack
first, so that you see all such resources at once.

| Resource type |
| --- |
| `AWS::Glue::Table` |
| `AWS::Route53::RecordSet` |
| `AWS::Route53::RecordSetGroup` |
| `AWS::AppSync::GraphQLSchema` |
| `AWS::AppSync::GraphQLApi` |
| `AWS::EC2::NetworkAclEntry` |
| `AWS::SQS::QueuePolicy` |
| `AWS::SNS::TopicPolicy` |

For each such resource, do one of these before you export:

- Remove the resource from the stack. It stays in AWS, and you can declare it
  in CloudFormation afterwards.
- Destroy it, and let CloudFormation create it fresh after the export.

Custom Resources and `AWS::IAM::Policy` cannot be imported either, but cdkd
migrates them in a second phase. See
[cdkd export: Custom Resources and IAM policies](cli-export-two-phase.md).

### The list is not what cdkd checks

cdkd does not check against the table above. It asks the CloudFormation
registry about each type, and refuses a type when the registry schema declares
no `read` handler and reports `ProvisioningType: NON_PROVISIONABLE`. The check
therefore also covers types that are not listed here, and it stops applying to
a type once AWS makes that type importable.

`AWS::AppSync::GraphQLApi` is the one exception. Its registry schema looks
importable, but CloudFormation refuses it, so cdkd blocks it by name.

### `--skip-import-support-preflight`

Neither check is AWS's published list of importable types. If AWS has made a
type importable and cdkd still refuses it, pass
`--skip-import-support-preflight`. cdkd then skips both checks and lets
CloudFormation answer.

## Resources cdkd cannot plan

These blocks mean cdkd lacks something it needs to tell CloudFormation which
AWS resource to adopt.

### A template resource with no state entry

The template declares a resource that cdkd's state record does not hold, so
cdkd does not know its physical id. Import the resource first with
[`cdkd import`](import.md), or remove it from the stack.

### A nested stack whose state record is missing

Without the nested stack's record, its resources cannot be imported. Repair
the nested stack's state, or import it again.

### A multi-field identifier cdkd has no mapping for

Some types have an identifier with more than one field, and cdkd needs a
mapping for each such type to build it. The export refuses a type it has no
mapping for. Remove the resource before exporting.
[Composite identifiers](cli-export.md#composite-identifiers) lists the types
cdkd can map.

### Two resources with the same import identifier

An import adopts one AWS resource into one logical id. Two template resources
that resolve to the same AWS resource cannot both be imported. This happens
with two `AWS::EC2::SecurityGroupIngress` resources that resolve to one rule:
they share one `sgr-…` id.

Keep one of them in the app and export. Then add the others back with a
CloudFormation stack update.

### An identifier property declared as a list

cdkd sometimes has to overwrite an identifier property in the template with
the recorded value. It cannot do that when the template declares the property
as a list that contains an intrinsic function or a nested list, or as an empty
list. The message names the scalar value to declare instead.

## Identifiers read from recorded attributes

For five types, CloudFormation's identifier is a single value that is not
cdkd's physical id. cdkd reads that value from the attributes it recorded for
the resource at deploy time.

| Resource type | CloudFormation identifier | cdkd physical id |
| --- | --- | --- |
| `AWS::S3Tables::Table` | `TableARN` | `<tableBucketARN>\|<namespace>\|<name>` |
| `AWS::AppSync::DataSource` | `DataSourceArn` | `<apiId>\|<name>` |
| `AWS::AppSync::Resolver` | `ResolverArn` | `<apiId>\|<typeName>\|<fieldName>` |
| `AWS::AppSync::GraphQLApi` | `Arn` | `<apiId>` |
| `AWS::EC2::SecurityGroupIngress` | `Id` (the `sgr-…` rule id) | `<groupId>\|<ipProtocol>\|<fromPort>\|<toPort>` |

`AWS::AppSync::GraphQLApi` reaches this table only when you pass
`--skip-import-support-preflight`, because it is blocked by default.
[State Management](state-management.md) describes the `|`-joined physical ids.

### When the record lacks the attribute

The export blocks the resource and the message says that the attribute is
missing.

For the four types identified by an ARN, deploy the stack once and export
again. An older record did not store the ARN, and a deploy adds it.

A deploy does not add a missing rule id for
`AWS::EC2::SecurityGroupIngress`. The next section covers that type.

### `AWS::EC2::SecurityGroupIngress` without a recorded rule id

When the record has no rule id, the export looks the rule up in AWS. It calls
`DescribeSecurityGroupRules`, which needs the
`ec2:DescribeSecurityGroupRules` permission, and searches the security group
for ingress rules with the same protocol and port range.

| Rules that match | Outcome |
| --- | --- |
| Exactly one | Adopted. |
| None | Refused, naming the resource and what cdkd searched for. |
| More than one | Refused, naming the resource and every candidate `sgr-…` id. |

More than one match has two causes:

- One ingress resource declares both `CidrIp` and `CidrIpv6`. AWS creates one
  rule per source. Split the resource into one resource per source.
- Two ingress resources differ only by source. Repair the resource's recorded
  `Id` attribute, or remove the resource before exporting.

A record that already has the rule id triggers no lookup. Every record a
current cdkd writes has it.

## When a recorded value is `***`

cdkd stores `***` in state where the real value is a secret. This mask keeps
the secret out of the state bucket.

Most masks do not block an export. A mask blocks only where the export has to
read the real value, because cdkd cannot recover it from `***`. Find the place
where your mask sits below.

### A property filled by a `NoEcho` template parameter

Nothing to do. The exported template still reads the parameter, and
CloudFormation receives the parameter's value.

### An identifier or an IAM policy's principals filled by a `NoEcho` parameter

This covers a resource's import identifier, and an `AWS::IAM::Policy`'s
principals or name. It also covers a longer identifier value that has `***`
embedded in it.

Export the stack without that resource. Then adopt the resource into
CloudFormation by hand, and pass the value yourself.

### A nested stack's Parameter

The export refuses with `EXPORT_MASKED_CHILD_PARAMETER` when a Parameter that
a parent passes to a nested stack resolves to `***` or embeds it.

Export without that nested stack, or adopt it by hand and pass the value
yourself.

### A recorded attribute that cdkd uses as the identifier

This applies to the types under
[Identifiers read from recorded attributes](#identifiers-read-from-recorded-attributes).
Import the resource again so that its record holds the real value:

```bash
cdkd import MyStack --resource '<logicalId>=<physicalId>' --force
```

The import needs the `cloudformation:DescribeType` permission to record the
attribute unmasked. Alternatively, export without the resource.

Masked attributes are otherwise harmless. A record that was imported through
the AWS Cloud Control API routinely carries `***` in its `attributes`, and it
exports normally. The export reads `attributes` only for the five types in
that table.

### Any other recorded property

The record does not say what wrote the mask, so identify the source yourself.
There are three:

- **A Custom Resource response that sets `NoEcho`.** Stop setting `NoEcho` on
  the response, deploy again, then export. Forcing the Custom Resource to
  update does not help, because cdkd masks the value again when it writes
  state.
- **A secret under `Fn::Base64`**, such as a `{{resolve:...}}` reference in
  EC2 `UserData`. Change the resource to read the secret at run time, deploy
  again, then export. Do not put the plaintext in the template: cdkd would
  record it in state.
- **A mask copied from another record.** `cdkd orphan --force` in older
  releases could copy one, and so can a `cdkd import` that resolves a `Ref` or
  `Fn::GetAtt`. Repair the record that holds the original mask with a
  selective `cdkd import --force`. Then run again the command that wrote this
  property.

In every case you can also export the stack without that resource and adopt it
into CloudFormation by hand.

## A damaged state record

The export reads two maps in the state record: the record's `resources`, and
each resource's `properties`. It refuses when either one is not a JSON object,
which a hand edit or a truncated write can cause. The export deletes the
record at the end, so it does not guess at a record it cannot read.

Repair the record by hand, or import the named resources again with a
selective `cdkd import --force`.

Removing the damaged record does not unblock the export. Without the root
stack's record there is nothing to migrate. Without a nested stack's record,
the export refuses the tree because that record is missing.

## Related

- [`cdkd export`](cli-export.md): the command, its common blocks and its options
- [cdkd export: Custom Resources and IAM policies](cli-export-two-phase.md): the types cdkd migrates in a second phase
- [`cdkd import`](import.md): the command most remedies on this page use
- [State Management](state-management.md): state records and composite physical ids
