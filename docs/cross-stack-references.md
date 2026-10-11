---
title: Cross-Stack References
description: "The two ways one cdkd stack reads another's outputs, strong Fn::ImportValue and weak Fn::GetStackOutput, and what to do when a destroy is refused because of one."
---

# Cross-Stack References

A cross-stack reference lets one stack use a value that another stack
published as an output. The stack that publishes the value is the
**producer**, and the stack that reads it is the **consumer**.

cdkd supports two kinds of reference. They differ in what happens when you
try to destroy the producer while a consumer still exists:

- A **strong reference**, `Fn::ImportValue`, protects the producer. cdkd
  refuses to destroy it while any consumer imports from it. This is how
  CloudFormation behaves.
- A **weak reference**, `Fn::GetStackOutput`, protects nothing. You can
  destroy the producer at any time, and the consumer fails the next time it
  resolves the value. A weak reference can also read from another region or
  another account.

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

## Strong reference: `Fn::ImportValue`

With a strong reference, the producer exports a value under a name, and the
consumer imports it by that name:

```ts
// ProducerStack
new cdk.CfnOutput(this, 'BucketArnOutput', {
  value: bucket.bucketArn,
  exportName: 'BucketArn',
});

// ConsumerStack
const bucketArn = cdk.Fn.importValue('BucketArn');
```

CDK also generates this pair for you when you pass a construct from one stack
to another in the same region.

When the consumer deploys, cdkd records the import in the consumer's state,
its record of what it deployed. From then on the producer is protected, and a
destroy is refused:

```bash
cdkd destroy ProducerStack
```

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

The command exits `2` and deletes nothing. No `--force` flag overrides the
refusal, and CloudFormation has none either.
[Resolving a refused destroy](#resolving-a-refused-destroy) shows the two
ways forward. If you want a producer that can be destroyed on its own, use a
weak reference when you write the template.

## Weak reference: `Fn::GetStackOutput`

With a weak reference, the consumer reads an output by the producer's stack
name and the output's name. The output needs no `exportName`:

```ts
// ConsumerStack, reading from ProducerStack in us-west-2
const bucketArn = cdk.Fn.getStackOutput(
  'ProducerStack',
  'BucketArnOutput',
  'us-west-2'
);
```

In the synthesized template this becomes:

```json
{
  "Fn::GetStackOutput": {
    "StackName": "ProducerStack",
    "OutputName": "BucketArnOutput",
    "Region": "us-west-2"
  }
}
```

| Argument | Required | Meaning |
| --- | --- | --- |
| `StackName` | Yes | The producer stack |
| `OutputName` | Yes | The output to read |
| `Region` | No | The producer's region; defaults to the consumer's |
| `RoleArn` | No | A role in the producer's account to assume for the read |

Nothing protects the producer. `cdkd destroy ProducerStack` succeeds, and the
consumer's next deploy fails because it cannot resolve the value.

### Read from another account

To read an output from a stack in another AWS account, pass a `RoleArn` as
the fourth argument. cdkd assumes that role and reads the output from cdkd's
state in the producer's account:

```ts
const vpcId = cdk.Fn.getStackOutput(
  'PlatformVpc',
  'SharedVpcId',
  'us-east-1',
  'arn:aws:iam::111122223333:role/cdkd-state-reader',
);
```

Three rules apply:

- The `RoleArn` must be a literal string. cdkd rejects a `Ref` or `Fn::Sub`
  there.
- The role needs `s3:GetBucketLocation` on the producer's state bucket and
  `s3:GetObject` on the state files in it. The role's trust policy must allow
  the identity that runs cdkd.
- cdkd refuses to read an output that holds a secret this way. Export the
  secret's ARN instead, and resolve the secret in the consumer.

The policy to attach to the role is under
[IAM permissions](cross-stack-internals.md#iam-permissions).

## Which one to use

| Situation | Use |
| --- | --- |
| Same region, same account, and the producer should be protected | `Fn::ImportValue` |
| The producer is in another region | `Fn::GetStackOutput` with `Region` |
| The producer is in another account | `Fn::GetStackOutput` with `RoleArn` |
| The producer must be destroyable while consumers exist | `Fn::GetStackOutput` |
| The producer is managed by CloudFormation | Either; see [Mixed Estates](mixed-estates.md) |

## Resolving a refused destroy

When `cdkd destroy ProducerStack` is refused with
`StackHasActiveImportsError`, the message names every consumer that still
imports from the producer. There are two ways forward.

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

## A producer managed by CloudFormation

Both kinds of reference can also read from a stack that CloudFormation
manages. When cdkd finds no matching value in its own state, it asks
CloudFormation: `ListExports` for `Fn::ImportValue`, and the stack's outputs
for `Fn::GetStackOutput`. This works within one account only. A read with a
`RoleArn` never asks CloudFormation.

A value found this way is always a weak reference, even when the consumer
uses `Fn::ImportValue`, because cdkd cannot protect a producer it does not
manage. `--no-cfn-fallback` on `cdkd deploy` and `cdkd diff` turns the
CloudFormation lookup off. [Mixed Estates](mixed-estates.md) covers this
case in full.

## Compared with CloudFormation

| | CloudFormation | cdkd |
| --- | --- | --- |
| `Fn::ImportValue` resolves to the producer's output | Yes | Yes |
| Producer destroy refused while a consumer imports | Yes | Yes (`StackHasActiveImportsError`) |
| A force flag to override that | No | No |
| A weak reference | No | Yes (`Fn::GetStackOutput`) |
| Cross-region references | No | Yes (`Fn::GetStackOutput`) |
| Cross-account references | Via shared bootstrap | Yes (`Fn::GetStackOutput` with `RoleArn`) |
| A producer managed by the other engine | No | Yes (CloudFormation fallback, weak) |

### Export names and output names share one namespace

In cdkd, the export names and the output names of one stack share one
namespace. If one output's export name equals another output's name in the
same stack, cdkd skips the export and keeps the output. It prints a warning
when the producer deploys.

## Related

- [Cross-stack reference internals](cross-stack-internals.md): how
  references are resolved and checked, for contributors
- [Mixed Estates](mixed-estates.md): consuming a CloudFormation-managed
  producer
- [Stack Outputs](stack-outputs.md): declaring the values a consumer reads
- [cdkd destroy](cli-destroy.md): the other things that stop a
  destroy
