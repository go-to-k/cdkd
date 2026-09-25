# import-attribute-readback-final

`cdkd import --migrate-from-cloudformation` recording the attribute maps
`create()` records (issue [#3627](https://github.com/go-to-k/cdkd/issues/3627)),
last batch.

| Resource | Attributes | Before the fix, after an import |
|---|---|---|
| `AWS::StepFunctions::StateMachine` | `Name`, `StateMachineRevisionId` | the ARN |
| `AWS::WAFv2::WebACL` | `Id`, `LabelNamespace` | the ARN. The import THREW on CloudFormation's `name\|id\|scope` id |
| `AWS::Cognito::UserPool` | `ProviderName`, `ProviderURL` | the pool id |
| `AWS::RDS::DBCluster` (Aurora Serverless v2, no instances) | `Endpoint.Address`, `Endpoint.Port`, `ReadEndpoint.Address` | the cluster identifier |
| `AWS::S3Vectors::VectorBucket` | `VectorBucketArn` | refused. CloudFormation's id is the ARN, which was sent as a name |

One SSM parameter per attribute carries the `Fn::GetAtt`. Each imported
parameter record must equal the value CloudFormation itself resolved. The
cluster sits in an L1 VPC with no route tables, and its master password is
RDS-managed.

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```
