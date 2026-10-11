---
title: Cross-Stack References
description: "The two ways one cdkd stack reads another's outputs, strong Fn::ImportValue and weak Fn::GetStackOutput, and what to do when a destroy is refused because of one."
---

# Cross-Stack References

A cross-stack reference lets one stack (the **consumer**) use a value another
stack (the **producer**) published as an output. cdkd supports two kinds, and
they differ in what happens when you destroy the producer:

| Intrinsic | Strength | Destroying the producer | Use when |
| --- | --- | --- | --- |
| `Fn::ImportValue` | Strong | Refused with `StackHasActiveImportsError` while a consumer imports from it | The producer must stay as long as anything uses it. This is what CloudFormation does. |
| `Fn::GetStackOutput` | Weak | Proceeds; the consumer fails the next time it resolves the value | The producer must be deletable on its own, or lives in another region or account |

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

The producer exports a value under a name, and the consumer imports it by
that name:

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

When the consumer deploys, cdkd records the import in the consumer's state
record. From then on the producer is protected:

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

The command exits `2` and deletes nothing. There is no `--force` to override
it, as there is none in CloudFormation. If you want a producer that can be
destroyed independently, use a weak reference when you write the template.

## Weak reference: `Fn::GetStackOutput`

`Fn::GetStackOutput` reads an output by stack name and output name. The
output needs no `exportName`:

```ts
// ConsumerStack, reading from ProducerStack in us-west-2
const bucketArn = cdk.Fn.getStackOutput('ProducerStack', 'BucketArnOutput', 'us-west-2');
```

In the template this is:

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
consumer's next deploy fails when it cannot resolve the value.

### Read from another account

Pass a `RoleArn` to read an output from a stack in another AWS account. cdkd
assumes the role and reads the producer account's cdkd state:

```ts
const vpcId = cdk.Fn.getStackOutput(
  'PlatformVpc',
  'SharedVpcId',
  'us-east-1',
  'arn:aws:iam::111122223333:role/cdkd-state-reader',
);
```

- The `RoleArn` must be a literal string. A `Ref` or `Fn::Sub` is rejected.
- The role needs `s3:GetBucketLocation` on the producer's state bucket and
  `s3:GetObject` on its state records. Its trust policy must allow the
  identity your cdkd run uses.
- An output that holds a secret is refused on this path. Export the secret's
  ARN and resolve it in the consumer.

The policy to attach is under
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

When `cdkd destroy ProducerStack` refuses with `StackHasActiveImportsError`,
the message names every consumer. There are two ways forward.

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

### What about `cdkd state orphan`?

`cdkd state orphan ConsumerStack` would also clear the refusal, but it is the
wrong tool. It removes the consumer's whole state record, so cdkd stops
tracking every resource in that stack, in order to break one reference. Use
one of the two paths above.

## A producer managed by CloudFormation

Both intrinsics also resolve against a stack that CloudFormation manages.
When cdkd state has no match, cdkd asks CloudFormation: `ListExports` for
`Fn::ImportValue`, and the stack's outputs for `Fn::GetStackOutput` (same
account only; a `RoleArn` read never falls back).

A value found this way is always a weak reference, even through
`Fn::ImportValue`. cdkd cannot protect a producer it does not manage.
`--no-cfn-fallback` on `cdkd deploy` and `cdkd diff` turns the fallback off.
[Mixed Estates](mixed-estates.md) covers this case.

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

One difference in naming: cdkd keeps export names and output names of a stack
in one namespace. If an output's export name equals another output's name in
the same stack, cdkd skips the export, keeps the output, and warns on the
producer's deploy.

## Related

- [Cross-stack reference internals](cross-stack-internals.md): the exports
  index, the resolver flow, the destroy-time scan and what each path costs
- [Mixed Estates](mixed-estates.md): consuming a CloudFormation-managed
  producer
- [Stack Outputs](stack-outputs.md): declaring the values a consumer reads
- [Destroy flags & guards](cli-destroy.md): the other things that stop a
  destroy
