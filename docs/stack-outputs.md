---
title: Stack Outputs
description: How cdkd resolves CDK CfnOutput values, prints them after deploy, and stores them in the S3 state file — and how that differs from CloudFormation.
---

# Stack Outputs

CDK's `CfnOutput` constructs are resolved and stored in the state file:

```typescript
// In your CDK code
new cdk.CfnOutput(this, 'BucketArn', {
  value: bucket.bucketArn,  // Uses Fn::GetAtt internally
  description: 'ARN of the bucket',
});
```

After deployment, outputs are resolved and printed at the end of `cdkd deploy` (matching CDK CLI's format) and saved to the S3 state file:

```text
Deployment Summary:
  Stack: MyStack
  ...
  Duration: 21.25s

Outputs:
  MyStack.BucketArn = arn:aws:s3:::actual-bucket-name-xyz

✓ Deployment completed successfully
```

```json
{
  "outputs": {
    "BucketArn": "arn:aws:s3:::actual-bucket-name-xyz"
  }
}
```

**Key differences from CloudFormation**:

- CloudFormation: Outputs accessible via `aws cloudformation describe-stacks`
- cdkd: Outputs saved in S3 state file (e.g., `s3://bucket/cdkd/MyStack/us-east-1/state.json`)
- Both print outputs to stdout after a successful deploy
- Both resolve intrinsic functions (Ref, Fn::GetAtt, etc.) to actual values

## Related

- [Cross-Stack References](cross-stack-references.md) — consuming another stack's outputs
- [State Management](state-management.md) — where outputs are stored
