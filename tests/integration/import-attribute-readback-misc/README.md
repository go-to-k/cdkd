# import-attribute-readback-misc

`cdkd import --migrate-from-cloudformation` recording the attribute maps
`create()` records (issue [#3627](https://github.com/go-to-k/cdkd/issues/3627)),
third batch.

| Resource | Attributes | Before the fix, after an import |
|---|---|---|
| `AWS::SSM::Parameter` (StringList) | `Type`, `Value` | the parameter name |
| `AWS::IAM::InstanceProfile` / `User` / `Group` (`Path: /cdkd-integ/`) | `Arn` | a path-less ARN, silently |
| `AWS::BedrockAgentCore::Evaluator` (code-based, Lambda-backed) | `Status`, `CreatedAt` | the evaluator ARN |

One SSM parameter per attribute carries the `Fn::GetAtt`.

- **SSM / IAM rows:** each must equal what CloudFormation itself resolved.
- **Evaluator rows:** these change over time, so each is checked for shape — a known status, and an ISO timestamp.

The run then does an unchanged `cdkd deploy` and a destroy with gone-probes.

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```
