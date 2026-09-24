# import-lambda-url-attributes

`cdkd import --migrate-from-cloudformation` recording the `AWS::Lambda::Url`
attributes (issue [#3624](https://github.com/go-to-k/cdkd/issues/3624)).

`LambdaUrlProvider.import()` returned `attributes: {}`. Neither `FunctionUrl`
nor `FunctionArn` can be built from the physical id, so a sibling's
`Fn::GetAtt [<Url>, FunctionUrl]` (the reporter's CloudFront
`FunctionUrlOrigin`) was written to its imported record as the raw intrinsic,
and every later `cdkd diff` / `cdkd deploy` printed
`Unknown attribute FunctionArn for resource type AWS::Lambda::Url`.

## Configuration

- **Lambda Function** (inline Python) with a **Function URL** (`AWS_IAM`, logical id `Url`)
- **`UrlParam`**: SSM parameter whose value is `Fn::GetAtt [Url, FunctionUrl]`
- **`ArnParam`**: SSM parameter whose value is `Fn::GetAtt [Url, FunctionArn]`

The SSM parameters stand in for CloudFront: the resolver path is the same for
any consumer, and a distribution adds minutes to deploy and delete.

## Flow

1. `cdk deploy` (the CloudFormation stack to migrate).
2. `cdkd import --migrate-from-cloudformation --yes` — asserts no
   `Failed to resolve intrinsics` / `Unknown attribute` line.
3. The state record check: `Url.attributes.FunctionUrl` / `FunctionArn` and
   both parameters' `Value` equal what `GetFunctionUrlConfig` reports.
4. `cdkd deploy` with an unchanged template — asserts no `Unknown attribute`.
5. `cdkd destroy --force`, then gone-probes for the function, its role, both
   parameters and the state file.

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```
