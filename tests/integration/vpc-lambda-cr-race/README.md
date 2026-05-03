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

## Pre-fix behavior

Deploy fails on the Custom Resource:

```text
Failed to create RaceProbe: ...
The function is currently in the following state: Pending
```

## Post-fix behavior

`LambdaFunctionProvider.create()` waits until
`Configuration.State === 'Active'` via the SDK's
`waitUntilFunctionActiveV2` waiter before returning. The Custom
Resource Invoke fires only after the Lambda is fully ready, so deploy
succeeds.

## Run

```bash
# Use /run-integ from a Claude Code session (preferred):
/run-integ vpc-lambda-cr-race

# Or manually:
cd tests/integration/vpc-lambda-cr-race
pnpm install
node ../../../dist/cli.js deploy -y
node ../../../dist/cli.js destroy -y
```
