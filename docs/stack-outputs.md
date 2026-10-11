---
title: Stack Outputs
description: "How cdkd resolves CDK CfnOutput values, prints them after a deploy and stores them in the stack's state record, and where that differs from CloudFormation."
---

# Stack Outputs

A CDK `CfnOutput` works with cdkd as it does with CloudFormation: the value
is resolved during the deploy and printed at the end. The one difference is
where the value lives afterwards. CloudFormation keeps outputs on the stack;
cdkd keeps them in the stack's state record in S3.

## Declare, deploy, read

Declare the output in your CDK code as usual:

```ts
new cdk.CfnOutput(this, 'BucketArn', {
  value: bucket.bucketArn,
  description: 'ARN of the bucket',
});
```

`cdkd deploy` resolves the value and prints it after the deployment summary,
in the format the CDK CLI uses:

```text
Outputs:
  MyStack.BucketArn = arn:aws:s3:::actual-bucket-name-xyz

✓ Deployment completed successfully
```

The value is also saved under `outputs` in the state record:

```json
{
  "outputs": {
    "BucketArn": "arn:aws:s3:::actual-bucket-name-xyz"
  }
}
```

Read it back later without the CDK app:

```bash
cdkd state show MyStack          # outputs and resources, human-readable
cdkd state show MyStack --json   # the whole record, for a script
```

## Differences from CloudFormation

| | CloudFormation | cdkd |
| --- | --- | --- |
| Where outputs are stored | On the stack | In the state record, `s3://<bucket>/cdkd/MyStack/us-east-1/state.json` |
| How to read them | `aws cloudformation describe-stacks` | `cdkd state show MyStack` |
| Printed after a deploy | Yes | Yes |
| `Ref`, `Fn::GetAtt` and other intrinsics | Resolved to real values | Resolved to real values |
| An output fed by a `NoEcho` parameter | Printed in the clear | Stored and printed as `***` |

## Secrets in outputs are masked

cdkd stores and prints `***` for an output whose value comes from a `NoEcho`
parameter, from a resolved `{{resolve:...}}` secret reference, or from a
`NoEcho` custom-resource attribute.

A stack that reads such an output from another stack gets the real value only
when both stacks are deployed in the same `cdkd deploy` run. An output is
published data, so keep secrets out of outputs.

## Related

- [Cross-Stack References](cross-stack-references.md): consuming another
  stack's outputs
- [State Management](state-management.md): the state record that holds them
- [`cdkd state`](cli-state.md): `cdkd state show` and its flags
