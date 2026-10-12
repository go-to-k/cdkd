---
title: "Use Another Stack's Outputs"
description: "How cdkd resolves Fn::ImportValue and Fn::GetStackOutput: values come from cdkd's state rather than CloudFormation, so a cross-account role needs S3 access, cdkd itself refuses a producer's destroy, and a CloudFormation-managed producer can still be read."
---

# Use Another Stack's Outputs

cdkd supports both cross-stack intrinsics CloudFormation has, with the same
meaning, so a CDK app's references within one account work unchanged:

- **`Fn::ImportValue`** is a strong reference. The producer cannot be
  destroyed while a consumer imports from it.
- **`Fn::GetStackOutput`** is a weak reference. Nothing protects the producer,
  and it can read from another region or another account.

```text diagram=guide-cross-stack
                      Producer stack
                     publishes outputs
               │                          │
        Fn::ImportValue           Fn::GetStackOutput
               ▼                          ▼
        Strong reference           Weak reference
        cdkd records the import    the producer can be destroyed
        destroying the producer    at any time; the consumer then
        is refused while this      fails the next time it resolves
        consumer exists            the value
```

AWS documents the two intrinsics in
[Fn::ImportValue](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/intrinsic-function-reference-importvalue.html)
and
[Fn::GetStackOutput](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/intrinsic-function-reference-getstackoutput.html).
This page covers what is different because cdkd, not CloudFormation, holds
the outputs.

## What is different in cdkd

| | CloudFormation | cdkd |
| --- | --- | --- |
| Where a value is read from | The stack's exports and outputs in CloudFormation | The producer's state record in cdkd's state bucket |
| What a cross-account `RoleArn` needs | `cloudformation:DescribeStacks` | Read access to the producer account's cdkd state bucket |
| A cross-account reference CDK generates for you | Read through the role CDK generates | Read through the producer account's CDK lookup role |
| Who refuses a producer's destroy | CloudFormation | cdkd, from the imports it recorded in each consumer's state |
| A producer the other engine manages | Not readable | Readable from CloudFormation, as a weak reference |

Each row is explained below.

## Which reference your CDK app gets

cdkd deploys the template your CDK app synthesizes, so the CDK app decides
which kind a reference is. When you pass one stack's attribute to another
stack in the same account and region, CDK generates a strong
`Fn::ImportValue`; that is CDK's default. Set the feature flag
`@aws-cdk/core:defaultCrossStackReferences` to `weak` in `cdk.json` and CDK
generates `Fn::GetStackOutput` instead. `cdk.Fn.getStackOutput()` writes a
weak reference explicitly, whatever the flag says.

## A refused destroy

When a consumer deploys, cdkd records each `Fn::ImportValue` in the
consumer's state. `cdkd destroy` of the producer reads those records and
refuses while any consumer still imports:

```text
Cannot destroy stack 'ProducerStack' (us-east-1): the following stacks still import its outputs via Fn::ImportValue:
  - ConsumerStack (us-east-1): imports export 'BucketArn'

This matches CloudFormation's strong-reference semantics — exports are
protected as long as a consumer references them.

To proceed:
  1. Destroy the consumer first: cdkd destroy <consumer-stack>
  2. Or remove the Fn::ImportValue from the consumer's template
     (e.g. inline the value, or refactor) and re-deploy the consumer,
     then retry this destroy.

Note: cdkd's Fn::GetStackOutput intrinsic is a weak alternative that
does NOT protect the producer — use it when you intentionally want
the producer to be deletable independently of consumers.
```

The command exits `2` and deletes nothing. There are two ways forward.

### Destroy the consumer first

```bash
cdkd destroy ConsumerStack
cdkd destroy ProducerStack    # now succeeds
```

### Remove the reference, then redeploy the consumer

```ts
// Before
new lambda.Function(this, 'Handler', {
  // ...
  environment: { BUCKET_ARN: cdk.Fn.importValue('BucketArn') },
});

// After: inline the value, or switch to Fn.getStackOutput
new lambda.Function(this, 'Handler', {
  // ...
  environment: { BUCKET_ARN: 'arn:aws:s3:::known-bucket' },
});
```

```bash
cdkd deploy ConsumerStack     # the consumer no longer records the import
cdkd destroy ProducerStack    # now succeeds
```

### Do not use `cdkd state orphan` for this

`cdkd state orphan ConsumerStack` would also clear the refusal, but at too
high a cost. It removes the consumer from cdkd's state entirely, so cdkd
stops tracking every resource in that stack, only to break one reference.
Use one of the two ways above.

## Reading from another account

> [!WARNING]
> For a producer in another account, CDK synthesizes `Fn::GetStackOutput`
> with a `RoleArn` naming a role it adds to the producer stack. That role
> trusts only the consumer account's CloudFormation execution role and allows
> only `cloudformation:DescribeStacks`, so cdkd cannot use it. cdkd recognizes
> the reference and reads the producer's state through the producer account's
> CDK lookup role instead, which needs two things:
>
> - The producer account bootstrapped with
>   `cdk bootstrap --trust-for-lookup <consumer-account>` (or `--trust`), so
>   the identity running cdkd can assume the lookup role.
> - The consumer account CDK-bootstrapped too: the generated role trusts the
>   consumer's CloudFormation execution role, and IAM refuses a trust policy
>   naming a role that does not exist (`MalformedPolicyDocument: Invalid
>   principal in policy`), so deploying the producer needs that role to exist.
>
> When the lookup role cannot be used, cdkd refuses the reference and names
> both remedies: bootstrap as above, or write the reference yourself with
> `cdk.Fn.getStackOutput()`, naming a role set up as below. cdkd never reads
> it with its own credentials.

`Fn::GetStackOutput` with a `RoleArn` reads the producer's output from cdkd's
state in the producer's account, not from CloudFormation. cdkd assumes the
role and reads the producer account's state bucket, `cdkd-state-<accountId>`:

```ts
const vpcId = cdk.Fn.getStackOutput(
  'PlatformVpc',
  'SharedVpcId',
  'us-east-1',
  'arn:aws:iam::111122223333:role/cdkd-state-reader',
);
```

Three rules apply:

- The role needs `s3:GetBucketLocation` on the producer's state bucket and
  `s3:GetObject` on the state files in it, and its trust policy must allow
  the identity that runs cdkd. A role made for CloudFormation's
  `cloudformation:DescribeStacks` is not enough. The policy to attach is
  under [IAM permissions](cross-stack-internals.md#iam-permissions).
- The `RoleArn` must be a literal string. cdkd rejects a `Ref` or `Fn::Sub`
  there, and accepts CDK's own `Fn::Join` form only for the reference CDK
  generates.
- cdkd refuses to read an output that holds a secret this way. Export the
  secret's ARN instead, and resolve the secret in the consumer.

A read from another region in the same account needs no role: cdkd reads the
producer's record for that region from the same state bucket.

## A producer managed by CloudFormation

Both kinds of reference can also read from a stack that CloudFormation
manages. When cdkd finds no matching value in its own state, it asks
CloudFormation: `ListExports` for `Fn::ImportValue`, and the stack's outputs
for `Fn::GetStackOutput`. This works within one account only. A read with a
`RoleArn` never asks CloudFormation.

A value found this way is always a weak reference, even when the consumer
uses `Fn::ImportValue`, because cdkd cannot protect a producer it does not
manage. `--no-cfn-fallback` on `cdkd deploy` and `cdkd diff` turns the
CloudFormation lookup off. [Run Beside CloudFormation](mixed-estates.md)
covers this case in full.

## Export names and output names share one namespace

In cdkd, the export names and the output names of one stack share one
namespace. If one output's export name equals another output's name in the
same stack, cdkd skips the export and keeps the output. It prints a warning
when the producer deploys.

## Related

- [Read Stack Outputs](stack-outputs.md): declaring the values a consumer reads
- [Run Beside CloudFormation](mixed-estates.md): consuming a CloudFormation-managed
  producer
- [Cross-stack reference internals](cross-stack-internals.md): how
  references are resolved and checked, for contributors
- [`cdkd destroy`](cli-destroy.md): the other things that stop a destroy
