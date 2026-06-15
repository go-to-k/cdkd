# stepfunctions-s3-definition

Integration fixture for the `AWS::StepFunctions::StateMachine.DefinitionS3Location`
backfill (issue #609).

## What it exercises

- The state-machine definition (Amazon States Language) is **not inline**. It
  lives in an `s3_assets.Asset` that cdkd uploads to the bootstrap asset bucket.
  The L1 `CfnStateMachine` references it via `definitionS3Location`. cdkd fetches
  the S3 object and inlines its contents as the `CreateStateMachine` definition
  (the SDK has no `DefinitionS3Location` field — CloudFormation does the same
  fetch-and-inline).
- The definition contains a `${Greeting}` token resolved via
  `definitionSubstitutions`. cdkd's intrinsic resolver cannot reach into S3
  content, so the provider applies the substitution to the fetched body itself
  (CloudFormation parity).

## Assertions (`verify.sh`, real AWS)

1. After deploy, `describe-state-machine`'s `definition` is the ASL from S3
   (a `Pass` state named `Greet`) — proving `DefinitionS3Location` reached AWS.
2. The `${Greeting}` token was substituted with `hello-from-cdkd` and the raw
   token is gone — proving `DefinitionSubstitutions` was applied to the S3 body.
3. `destroy` removes the state machine + the cdkd state file with 0 errors.

## Run

```bash
/run-integ stepfunctions-s3-definition
```

Requires `STATE_BUCKET` (and `AWS_REGION`, default `us-east-1`). L1
`CfnStateMachine` is used deliberately — an L2 `stepfunctions.StateMachine`
would inline the definition and never set `DefinitionS3Location`.
