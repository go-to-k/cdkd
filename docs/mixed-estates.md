---
title: Run Beside CloudFormation
description: "A stack deployed with cdkd can read the outputs of a stack CloudFormation still manages, with no change to that stack, through a CloudFormation fallback for Fn::ImportValue and Fn::GetStackOutput."
---

# Run Beside CloudFormation

A mixed estate is an AWS account where some stacks are deployed with
`cdk deploy`, through CloudFormation, and others with cdkd. A common split
keeps shared infrastructure such as the VPC, domains and IAM on the AWS CDK
CLI, and uses cdkd for the dev and test application stacks you redeploy
often.

In such an account, a cdkd stack can read the outputs of a stack that
CloudFormation manages. You change nothing on the CloudFormation side, and
you write the same CDK code you would write between two CloudFormation
stacks.

## Example: use a shared VPC

`SharedStack` stays on CloudFormation and exports the VPC's ID. It is the
**producer**, the stack that publishes a value:

```ts
// SharedStack, deployed with `cdk deploy`
new cdk.CfnOutput(this, 'SharedVpcId', {
  value: vpc.vpcId,
  exportName: 'SharedVpcId',
});
```

`AppStack` imports the value and is deployed with cdkd. It is the
**consumer**:

```ts
// AppStack, deployed with `cdkd deploy`
const vpcId = cdk.Fn.importValue('SharedVpcId');
```

Deploy each stack with its own tool:

```bash
cdk deploy SharedStack
cdkd deploy AppStack
```

## How cdkd finds the value

cdkd looks for the value in its own state first, and asks CloudFormation only
when it is not there:

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

The CloudFormation lookup depends on how the consumer refers to the value.
For `Fn::ImportValue`, which is what `cdk.Fn.importValue` produces, cdkd
calls `ListExports`. For `Fn::GetStackOutput`, which reads an output by stack
name, cdkd reads the stack's outputs with `DescribeStacks`.
[Use Another Stack's Outputs](cross-stack-references.md) explains both.

cdkd resolves each reference separately. One stack can therefore read some
values from stacks cdkd deployed and others from CloudFormation stacks. If a
cdkd stack and a CloudFormation stack export the same name, cdkd uses the one
from the cdkd stack.

## Nothing protects the CloudFormation producer

> [!WARNING]
> You can delete a CloudFormation producer while cdkd stacks still read from
> it, and nothing stops you. The consumer then fails the next time it
> resolves the value. Check for cdkd consumers before you delete a producer.

Between two CloudFormation stacks, CloudFormation refuses to delete a stack
whose export is in use. That protection does not reach a cdkd consumer, for
two reasons. CloudFormation cannot see stacks that cdkd deployed. And cdkd
does not record a value it got from CloudFormation, so cdkd has no list of
consumers to check either. A reference that nothing protects like this is
called a weak reference.

## Edge cases

### The deploy role lacks CloudFormation permissions

The credentials that deploy the consumer need `cloudformation:ListExports`
and `cloudformation:DescribeStacks`. Without them, cdkd prints a warning and
then fails with the same not-found error it gives for a value that does not
exist.

### The producer is in another account

`Fn::GetStackOutput` with a `RoleArn` reads cdkd's state in the producer's
account. It never asks CloudFormation, so the producer in that account must
be a cdkd stack.

### A stack you moved to CloudFormation with `cdkd export`

After you export a cdkd stack to CloudFormation, the stacks that consume its
outputs keep working. They now find the values through the CloudFormation
lookup.

## Turn the CloudFormation lookup off: `--no-cfn-fallback`

```bash
cdkd deploy AppStack --no-cfn-fallback
cdkd diff AppStack --no-cfn-fallback
```

With `--no-cfn-fallback`, cdkd resolves cross-stack references from its own
state only. There are two reasons to use it:

- The deploy role can do without the two CloudFormation permissions.
- A mistyped export name fails immediately. Without the flag, the mistyped
  name could match an unrelated CloudFormation export.

Pass the flag to `cdkd diff` as well, so that the preview and the deploy
resolve references the same way.

## Related

- [Use Another Stack's Outputs](cross-stack-references.md): strong and weak
  references between stacks
- [Import Existing Resources](import.md): moving a CloudFormation stack
  into cdkd
- [Hand a Stack to CloudFormation](export.md): moving one back out
