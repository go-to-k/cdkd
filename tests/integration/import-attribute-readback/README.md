# import-attribute-readback

`cdkd import --migrate-from-cloudformation` recording the attribute maps
`create()` records (issue [#3627](https://github.com/go-to-k/cdkd/issues/3627)),
for the types whose attributes the resolver cannot build from the physical id.

| Resource | Attribute | Before the fix, after an import |
|---|---|---|
| `AWS::SNS::Topic` | `TopicName` | the topic ARN, silently. The physical id is the ARN, which the resolver read as a name |
| `AWS::DynamoDB::Table` | `StreamArn` | `undefined` |
| `AWS::IAM::Role` (`Path: /cdkd-integ/`) | `RoleId` | `undefined` |
| `AWS::IAM::Role` (`Path: /cdkd-integ/`) | `Arn` | `role/<name>`, with the path lost |
| `AWS::Lambda::EventSourceMapping` | `EventSourceMappingArn` | refused: the physical id is a UUID |

One SSM parameter per row carries the `Fn::GetAtt`. The assertion reads the
imported parameter record against what AWS reports.

## Flow

1. `cdk deploy` (the CloudFormation stack to migrate).
2. `cdkd import --migrate-from-cloudformation --yes`. The run asserts no
   `Failed to resolve intrinsics` / `Unknown attribute` line.
3. Each parameter's recorded `Value` equals the live attribute.
4. `cdkd deploy` with an unchanged template. The run asserts no
   `Unknown attribute` line and no resource updated.
5. `cdkd destroy --force`, then gone-probes for every resource and the state
   file.

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```
