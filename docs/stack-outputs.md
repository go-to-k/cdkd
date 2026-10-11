---
title: Read Stack Outputs
description: "How cdkd resolves CDK CfnOutput values, prints them after a deploy and stores them in the stack's state record, and where that differs from CloudFormation."
---

# Read Stack Outputs

A stack output is a value a stack publishes after it is deployed, such as a
bucket's ARN or an API's URL. You declare one with a CDK `CfnOutput`. With
cdkd it works as it does with CloudFormation: the value is resolved during
the deploy and printed at the end.

The one difference is where the value is kept afterwards. CloudFormation
keeps outputs on the stack. cdkd keeps them in the stack's state, the JSON
file in S3 where it records what it deployed.

## Declare, deploy, read

Declare the output in your CDK code as usual:

```ts
new cdk.CfnOutput(this, 'BucketArn', {
  value: bucket.bucketArn,
  description: 'ARN of the bucket',
});
```

`cdkd deploy` resolves the value and prints it after the deployment summary,
in the format the AWS CDK CLI uses:

```text
Outputs:
  MyStack.BucketArn = arn:aws:s3:::actual-bucket-name-xyz

✓ Deployment completed successfully
```

cdkd also saves the value under `outputs` in the stack's state file:

```json
{
  "outputs": {
    "BucketArn": "arn:aws:s3:::actual-bucket-name-xyz"
  }
}
```

You can read it back later, from any directory and without the CDK app:

```bash
cdkd state show MyStack          # outputs and resources, human-readable
cdkd state show MyStack --json   # the whole record, for a script
```

## Differences from CloudFormation

| | CloudFormation | cdkd |
| --- | --- | --- |
| Where outputs are stored | On the stack | In the stack's state file in S3 |
| How to read them | `aws cloudformation describe-stacks` | `cdkd state show MyStack` |
| Printed after a deploy | Yes | Yes |
| `Ref`, `Fn::GetAtt` and other intrinsics | Resolved to real values | Resolved to real values |
| An output fed by a `NoEcho` parameter | Printed in the clear | Stored and printed as `***` |

The state file for `MyStack` in `us-east-1` is at
`s3://<bucket>/cdkd/MyStack/us-east-1/state.json`.

## Secrets in outputs are masked

cdkd does not write a secret into an output. It stores and prints `***` when
the output's value comes from one of these:

- a `NoEcho` parameter,
- a `{{resolve:...}}` reference to a secret,
- a `NoEcho` attribute of a custom resource.

This affects a stack that reads such an output from another stack. The
reading stack gets the real value only when both stacks are deployed in the
same `cdkd deploy` run. An output is published data, so keep secrets out of
outputs.

## Related

- [Use Another Stack's Outputs](cross-stack-references.md): using another stack's
  outputs
- [State Store](state-management.md): the state file that holds them
- [`cdkd state`](cli-state.md): `cdkd state show` and its flags
