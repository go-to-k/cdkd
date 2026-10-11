---
title: Mixed Estates
description: "A stack deployed with cdkd can read the outputs of a stack CloudFormation still manages, with no change to that stack, through a CloudFormation fallback for Fn::ImportValue and Fn::GetStackOutput."
---

# Reference CloudFormation-managed stacks (mixed estates)

A mixed estate is an account where some stacks are deployed with `cdk deploy`
(CloudFormation) and others with cdkd. The usual split keeps shared
infrastructure such as the VPC, domains and IAM on the CDK CLI, and iterates
on dev and test application stacks with cdkd.

A cdkd stack can read the outputs of a CloudFormation-managed stack directly.
You change nothing on the CloudFormation side and use the same CDK code you
would use between two CloudFormation stacks.

## Example: consume a shared VPC

The producer stays on CloudFormation and exports a value:

```ts
// SharedStack, deployed with `cdk deploy`
new cdk.CfnOutput(this, 'SharedVpcId', {
  value: vpc.vpcId,
  exportName: 'SharedVpcId',
});
```

The consumer imports it and is deployed with cdkd:

```ts
// AppStack, deployed with `cdkd deploy`
const vpcId = cdk.Fn.importValue('SharedVpcId');
```

```bash
cdk deploy SharedStack
cdkd deploy AppStack
```

## How the value is found

```text diagram=guide-mixed-estates
  Fn::ImportValue / Fn::GetStackOutput in a stack cdkd deploys
        │
        ▼
  cdkd state                  found: the value is used
        │ not found
        ▼
  CloudFormation              found: the value is used, as a weak
    ListExports               reference that nothing records
    DescribeStacks
        │ not found
        ▼
  The deploy fails: not found
```

cdkd looks in its own state first. Only on a miss does it ask CloudFormation:
`ListExports` for `Fn::ImportValue`, and the stack's outputs through
`DescribeStacks` for `Fn::GetStackOutput`. Each reference is resolved on its
own, so one stack can read some values from cdkd producers and others from
CloudFormation producers.

If a cdkd stack and a CloudFormation stack export the same name, the cdkd one
is used.

## What to watch for

> [!WARNING]
> Nothing stops you from deleting a CloudFormation producer that cdkd stacks
> still read. cdkd does not record a value it got from CloudFormation, and
> CloudFormation's own export-in-use protection cannot see cdkd consumers.
> The consumer fails the next time it resolves the value. Check for cdkd
> consumers before you delete a producer.

| Topic | Behavior |
| --- | --- |
| IAM | The deploying credentials need `cloudformation:ListExports` and `cloudformation:DescribeStacks`. Without them cdkd warns and fails with the ordinary not-found error. |
| Cross-account | `Fn::GetStackOutput` with a `RoleArn` reads the producer account's cdkd state only and never falls back. |
| After `cdkd export` | Consumers of a stack you exported to CloudFormation keep resolving its outputs through the fallback. |

## Turn the fallback off: `--no-cfn-fallback`

```bash
cdkd deploy AppStack --no-cfn-fallback
cdkd diff AppStack --no-cfn-fallback
```

With the flag, cdkd resolves cross-stack references from cdkd state only. Use
it to keep the deploy role's IAM permissions minimal, or to make a mistyped
export name fail immediately when it might otherwise match an unrelated
CloudFormation export. Pass it to `cdkd diff` as well, so the preview and the
deploy resolve the same way.

## Related

- [Cross-Stack References](cross-stack-references.md): strong and weak
  references between stacks
- [Importing Existing Resources](import.md): moving a CloudFormation stack
  into cdkd
- [Exporting to CloudFormation](export.md): moving one back out
