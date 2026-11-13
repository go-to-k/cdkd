# stack-id-uuid

`AWS::StackId` ends in a per-stack UUID (go-to-k/cdkd#6170).

Two stacks name an SSM parameter and an SNS topic from `AWS::StackId` with the
common CDK unique-suffix idiom: `Fn.select(2, Fn.split('/', Aws.STACK_ID))`,
then its first or last `-` group. Before the fix cdkd ended the stack id in the
constant `cdkd`, so the last-group form failed every create with an
`{{Fn::Select:4:OutOfBounds}}` name, and the first-group form gave every stack
the same suffix.

`verify.sh` deploys both stacks, checks each record is schema v16 with
`stackIdFromInstance` and each stack id ends in its own UUID, checks the names
on AWS, updates the parameter's value (`CDKD_TEST_UPDATE=true`) and asserts no
physical id or stack id changed, runs a no-op `cdkd diff --fail`, then destroys
both and asserts nothing is left.

```bash
STATE_BUCKET=<bucket> AWS_REGION=us-east-1 ./verify.sh
```
