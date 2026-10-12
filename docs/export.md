---
title: Hand a Stack to CloudFormation
description: "Hand a cdkd-managed stack back to CloudFormation with cdkd export: decide whether the stack is ready, then export it in three steps."
---

# Hand a Stack to CloudFormation

`cdkd export` hands a stack that cdkd deployed over to CloudFormation. Use it
when a stack you iterated on with cdkd should now be managed with
`cdk deploy`, for example before it goes to production. It is the opposite
direction of [`cdkd import`](import.md).

The AWS resources are not changed. CloudFormation adopts them into a new
CloudFormation stack, and cdkd then deletes its own state record for the
stack. From then on you manage the stack with `cdk deploy` or
`aws cloudformation`.

## Can I export this stack?

Run the preview to find out:

```bash
cdkd export MyStack --dry-run
```

The preview prints the import plan and everything that would block the export.
It changes nothing and does not ask for confirmation.

Five things are worth knowing before you export. Each entry links to its
full description.

- **Lambda-backed Custom Resources.** The export stops, because CloudFormation
  cannot import them. Pass `--include-non-importable`, and make sure each
  handler can receive a second `Create` event. See
  [Custom Resources and `--include-non-importable`](cli-export-two-phase.md#custom-resources-and-include-non-importable).
- **Inline IAM policies (`AWS::IAM::Policy`).** cdkd deletes each one and has
  CloudFormation create it again. The permission is missing in between. See
  [`AWS::IAM::Policy` is deleted and re-created](cli-export-two-phase.md#aws-iam-policy-is-deleted-and-re-created).
- **A resource type CloudFormation cannot import.** The export stops and names
  each resource. Remove or destroy the resource first. See
  [Resource types CloudFormation cannot import](cli-export-blocks.md#resource-types-cloudformation-cannot-import).
- **Context passed with `-c key=value`.** The export refuses. Move the values
  into `cdk.json` first. See
  [Context values passed with `-c`](cli-export-template.md#context-values-passed-with-c).
- **A failed or interrupted deploy.** cdkd asks before it exports such a
  stack. Finish the deploy or roll it back first.

Two things need no preparation:

- **Nested stacks.** Name the root stack. Each nested stack becomes its own
  CloudFormation stack, nested under its parent again. See
  [cdkd export: nested stacks](cli-export-nested-stacks.md).
- **Other stacks that read this stack's outputs.** They keep working. Their
  next deploy finds the outputs in CloudFormation through the
  [CloudFormation fallback](mixed-estates.md). The exception is a stack
  deployed with `--no-cfn-fallback`; see
  [Cross-stack consumers](cli-export.md#cross-stack-consumers).

## Export a stack

::: steps
1. Preview the plan

   ```bash
   cdkd export MyStack --dry-run
   ```

   Fix everything the preview reports as blocking. A blocked export changes
   nothing, and one message names every blocking resource, so you can fix
   them in one pass.

2. Export

   ```bash
   cdkd export MyStack
   ```

   cdkd asks for confirmation, creates the CloudFormation stack `MyStack` and
   imports the resources into it. To give the CloudFormation stack a different
   name, pass `--cfn-stack-name MyStack-CFn`.

3. Check the result with the CDK CLI

   ```bash
   cdk diff MyStack
   ```

   cdkd prints this command and the `cdk deploy` command to run next. An empty
   diff means CDK and CloudFormation agree about the stack.
:::

[`cdkd export`](cli-export.md#export-a-stack) shows the same three steps with
their output.

## After the export

The stack is now a CloudFormation stack, and cdkd has no record of it any
more. Deploy it with `cdk deploy`.

If `cdk diff` is not empty, read
[After the export](cli-export-template.md#after-the-export) before you deploy.
A stack whose resource names carry cdkd's stack-name prefix shows a
replacement there.

## Related

- [`cdkd export`](cli-export.md): the reference, with every flag and the
  order in which an export runs
- [`cdkd import`](import.md): the opposite direction, bringing
  CloudFormation-managed resources under cdkd
- [Run Beside CloudFormation](mixed-estates.md): running cdkd stacks next to
  CloudFormation stacks
