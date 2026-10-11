---
title: Exporting to CloudFormation
description: "Hand a cdkd-managed stack back to CloudFormation with cdkd export: what moves, what has to be true first, and which resources need an opt-in."
---

# Exporting to CloudFormation

`cdkd export` hands a stack cdkd deployed over to CloudFormation. You reach
for it when a stack you iterated on with cdkd should now be managed by `cdk
deploy`, for example before it goes to production. It is the opposite
direction of [`cdkd import`](import.md).

The AWS resources are not changed. cdkd asks CloudFormation to adopt them
with an import changeset (`ChangeSetType=IMPORT`), and on success deletes its
own state record for the stack. From then on you manage the stack with `cdk
deploy` or `aws cloudformation`.

## Export a stack

::: steps
1. Preview the plan

   ```bash
   cdkd export MyStack --dry-run
   ```

   This prints the import plan and what would block the export. It does not
   call CloudFormation.

2. Export

   ```bash
   cdkd export MyStack
   ```

   cdkd asks for confirmation, creates the CloudFormation stack `MyStack`
   and imports every resource into it. Pass `--cfn-stack-name MyStack-CFn`
   to give the CloudFormation stack a different name.

3. Check the result with the CDK CLI

   ```bash
   cdk diff MyStack
   ```

   cdkd prints the `cdk diff` and `cdk deploy` commands to run next.
:::

A blocked export changes nothing. cdkd builds the whole plan before it takes
the stack lock or submits a changeset, and names every blocking resource in
one message, so you can fix them in one pass.

## Check these before you export

| If the stack has | What happens | What to do |
| --- | --- | --- |
| Lambda-backed Custom Resources | The export stops; CloudFormation cannot import them | Pass `--include-non-importable` |
| A resource type CloudFormation cannot import | The export stops and names each one | Remove or destroy the resource first |
| Context passed with `-c key=value` | The export refuses | Move the values into `cdk.json`, or pass `--accept-transient-context` |
| Nested stacks | Each nested stack becomes its own CloudFormation stack | Nothing; name the root stack |
| Other stacks that read its outputs | They keep resolving through CloudFormation | Nothing, unless they deploy with `--no-cfn-fallback` |

### Custom Resources: `--include-non-importable`

```bash
cdkd export MyStack --include-non-importable
```

CloudFormation cannot import a Lambda-backed Custom Resource (`Custom::*` or
`AWS::CloudFormation::CustomResource`). With this flag the export runs in two
phases: it imports everything importable, then has CloudFormation create the
Custom Resources.

> [!IMPORTANT]
> The second phase invokes each Custom Resource's backing Lambda with a
> `Create` event again. The handler must be idempotent, and it must send its
> response to `event.ResponseURL`, as CloudFormation requires.

### Resource types CloudFormation cannot import

CloudFormation refuses to import some types, and cdkd checks for them from
each type's CloudFormation registry schema before it submits anything. These
are the ones seen so far:

| Resource type |
| --- |
| `AWS::Glue::Table` |
| `AWS::Route53::RecordSet` |
| `AWS::Route53::RecordSetGroup` |
| `AWS::AppSync::GraphQLApi` |
| `AWS::AppSync::GraphQLSchema` |
| `AWS::EC2::NetworkAclEntry` |
| `AWS::SQS::QueuePolicy` |
| `AWS::SNS::TopicPolicy` |

For any of them, either remove the resource from the stack before exporting
(it stays in AWS and can be declared in CloudFormation afterwards), or
destroy it and let CloudFormation create it again.

The check follows the registry, so it also catches types not listed here. If
AWS has since made a type importable and cdkd still refuses it, pass
`--skip-import-support-preflight` and let CloudFormation answer.

### Context passed with `-c`

CDK does not persist `-c key=value` overrides. A later `cdk deploy` without
the same flags would synthesize a different template, and CloudFormation
would treat the difference as a change to the stack. `cdkd export` therefore
refuses when `-c` overrides are present.

Move the values into the `"context"` field of `cdk.json` and run the export
without `-c`. If you cannot, `--accept-transient-context` proceeds with a
warning, and you must pass the same `-c` flags to every later `cdk deploy`.

### Nested stacks

```bash
cdkd export RootStack   # exports RootStack and every nested stack under it
```

cdkd imports the tree one stack at a time, leaves first, because
CloudFormation does not accept nested stacks in a single import changeset.
Each cdkd nested stack ends up as its own CloudFormation stack, nested under
its parent again.

### Stacks that consume this stack's outputs

A cdkd stack that reads the exported stack's outputs keeps working. Once the
outputs live in CloudFormation, the consumer's next deploy finds them there
through the [CloudFormation fallback](mixed-estates.md). Only a consumer
deployed with `--no-cfn-fallback` breaks; export from the leaves up in that
case.

## Related

- [`cdkd export`](cli-export.md): every flag, everything that blocks an
  export, identifier resolution, and the two-phase and nested-stack mechanics
- [`cdkd import`](import.md): the opposite direction, bringing
  CloudFormation-managed resources under cdkd
- [Mixed Estates](mixed-estates.md): running cdkd stacks next to
  CloudFormation stacks
