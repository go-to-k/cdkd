# getatt-sdk-attr-shapes

Read-only `Fn::GetAtt` attributes of SDK-provider types resolve to
CloudFormation's value (go-to-k/cdkd#6238).

Before the fix, five attributes resolved to the resource's physical id with
only a warning, because the providers did not record them under the
CloudFormation name: `AWS::AutoScaling::AutoScalingGroup.AutoScalingGroupARN`
(the group name), `AWS::WAFv2::WebACL.Capacity` (the web ACL ARN),
`AWS::AppSync::ApiKey.ApiKeyId` and `AWS::S3Tables::Table.WarehouseLocation` /
`VersionToken` (the composite physical id).

`verify.sh` deploys the stack with `--strict-getatt` (any physical-id fallback
fails the deploy), checks each Output against the live resource, updates the
web ACL's rules and the ASG's `MaxSize` (`CDKD_TEST_UPDATE=true`) and asserts no
physical id changed and the recorded `Capacity` followed the live one, runs a
no-op `cdkd diff --fail`, then destroys the stack and asserts nothing is left.
The ASG keeps a desired capacity of 0, so no instance is launched.

```bash
STATE_BUCKET=<bucket> AWS_REGION=us-east-1 ./verify.sh
```
