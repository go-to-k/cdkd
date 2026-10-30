# vpc-lambda-cr-race

Regression test for the **Pending-Lambda race** fixed in
`LambdaFunctionProvider.create()` (`waitUntilFunctionActiveV2`).

## Setup

- VPC with one isolated subnet (no NAT / IGW; cheap and fast)
- S3 Gateway VPC endpoint (free) so the Lambda can PUT to the
  cfn-response pre-signed S3 URL without internet egress
- VPC-attached Lambda (`HandlerFn`) — VPC attachment makes the Active
  transition reliably slow (ENI attachment takes seconds, not
  milliseconds), so the Lambda is in `Pending` when cdkd dispatches the
  dependent Custom Resource Invoke
- `cdk.CustomResource` whose `serviceToken === HandlerFn.functionArn` —
  establishes the explicit dependency edge that pre-fix raced and
  post-fix correctly serializes
- Second arm: `NotifyFn`, a second VPC-attached Lambda, is the destination of
  an S3 event notification on `NotifyBucket`. CDK synthesizes that into a
  `Custom::S3BucketNotifications` custom resource whose handler calls
  `PutBucketNotificationConfiguration`; S3 rejects a `Pending` destination.
  The handler's own function is a plain Lambda that is already Active, so only
  a wait on the function the properties point at covers it

## Pre-fix behavior

Deploy fails on the Custom Resource:

```text
Failed to create RaceProbe: ...
The function is currently in the following state: Pending
```

The second arm fails the same way through a different consumer:

```text
Failed to create <...>NotifyBucketNotifications...: Custom resource handler returned FAILED:
InvalidArgument: Unable to validate the following destination configurations
```

## Post-fix behavior

`LambdaFunctionProvider.create()` waits until
`Configuration.State === 'Active'` via the SDK's
`waitUntilFunctionActiveV2` waiter before returning. The Custom
Resource Invoke fires only after the Lambda is fully ready, so deploy
succeeds. For the second arm,
`CustomResourceProvider.waitForReferencedLambdasActive` waits for the
`Pending` destination function before the notification handler runs.

## Region requirement

Run it in the region of the cdkd STATE bucket. The Custom Resource's
`ResponseURL` is a pre-signed URL on that bucket, and the fixture's VPC has no
NAT or internet gateway: its only route to S3 is the same-region S3 gateway
endpoint. With the bucket in another region the handler cannot PUT its response
and times out ("Task timed out after 30.00 seconds"), which is a fixture
mismatch, not a cdkd failure. For a bucket in `eu-west-1`, use
`AWS_REGION=eu-west-1`.

## Run

```bash
# Use /run-integ from a Claude Code session (preferred):
/run-integ vpc-lambda-cr-race

# Or manually:
cd tests/integration/vpc-lambda-cr-race
vp install
node ../../../dist/cli.js deploy -y
node ../../../dist/cli.js destroy -y
```
