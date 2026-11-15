# lambda-runtime-config

cdkd `AWS::Lambda::Function` `RuntimeConfig` integration test (issue #6352).

`RuntimeConfig` points a function at a customer-managed runtime and one of its
aliases. The SDK provider now sends it on `CreateFunction` and
`UpdateFunctionConfiguration` and reads it back from `GetFunction`, so the
function stays on the SDK route instead of auto-routing to Cloud Control.

## What it covers

- `AWS::Lambda::Function`

## Prerequisites built by verify.sh

The runtime has no CloudFormation type, so `verify.sh` creates it before the
first deploy and deletes it after the destroy:

- an ECR repository with a policy letting `lambda.amazonaws.com` pull from it,
- a one-file custom-runtime image (`runtime-image/`, arm64, needs Docker
  buildx),
- through `runtime.mjs`, a runtime with version `v1` and aliases `a` and `b`.
  The AWS CLI has no `lambda-core` service and its `get-function-configuration`
  drops `RuntimeConfig`, so these calls go through the fixture's own SDK
  clients.

## Phases

1. Deploy with `Runtime: custom` and alias `a`. Assert AWS holds the block,
   `provisionedBy=sdk`, the runtime's bootstrap serves an invoke, and
   `cdkd drift` is clean.
2. `CDKD_TEST_UPDATE=alias`: alias `b`, applied in place.
3. `CDKD_TEST_REMOVAL=true`: `Runtime: nodejs22.x` and no `RuntimeConfig`, the
   only removal AWS accepts. Assert AWS dropped the block and the Node.js
   handler answers.
4. Destroy, then delete the runtime and the repository.

## Run

```bash
/run-integ lambda-runtime-config
```
