# apigw-cloudwatch-role-redeploy

Real-AWS net for issue [#5064](https://github.com/go-to-k/cdkd/issues/5064),
from a user report: `new apigateway.RestApi(..., { cloudWatchRole: true })`
declares an IAM role and an `AWS::ApiGateway::Account`, both
`DeletionPolicy: Retain` (CDK's default). `cdkd destroy` keeps them in AWS, as
CloudFormation does.

- **Premise** (released `@go-to-k/cdkd@0.301.12`): the role is named
  `{stack}-{logicalId}`, so deploy, destroy, redeploy fails: IAM refuses the
  name the kept role still holds.
- **This build**: a fresh stack names the role `{stack}-{logicalId}-{12 hex}`.
  After destroy keeps it, the redeploy creates a new role under a new name,
  points the account's `cloudwatchRoleArn` at it, and warns that it does not
  take the kept resource back, naming `cdkd import`.
- **Teardown**: every kept role is deleted by direct IAM calls, and the
  account's `cloudwatchRoleArn` is put back to its value before the run.

`verify.sh` lists the phases.

## Run it solo

The API Gateway account setting (`cloudwatchRoleArn`) is ONE per account and
region. Do not run this fixture beside another that sets it
(`apigateway`, `apigw-stage-props`, `apigw-stage-throttling`, `wafv2`, or a
second run of this one): each overwrites the other's setting, and this
teardown restores the value it read at its own start (or unsets it, when the
role that value names no longer exists: API Gateway refuses a missing role). Its IAM roles are listed by the stack names
`CdkdApigwCwRoleRel-` / `CdkdApigwCwRoleNew-`, so a peer run of this fixture
on the same account loses its roles too.

Run with `/run-integ apigw-cloudwatch-role-redeploy` (a few minutes).
