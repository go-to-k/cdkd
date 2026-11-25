# removal-delete-failure-kept

Integration test for a resource removed from the template whose delete AWS
refuses (issue [#6969](https://github.com/go-to-k/cdkd/issues/6969)).

CloudFormation deletes a removed resource in its cleanup phase. A refused
delete there is `DELETE_FAILED`, the update stays applied, and the stack ends
`UPDATE_COMPLETE`. cdkd used to fail the deploy and roll the update back. It
now keeps the resource's record and exits `2`, keeps everything the failed
resource depends on, and the next deploy retries the delete.

## What it covers

- `AWS::SQS::Queue` (an update in the same deploy, and a dependency of the removed bucket)
- `AWS::S3::Bucket` (removed while it holds an object)

## Phases

1. Deploy `Main` (`VisibilityTimeout` 30) and a `Data` bucket that `DependsOn` an `Anchor` queue. Put one object in the bucket.
2. Redeploy with `CDKD_TEST_UPDATE=true`: `Main` at 60, `Data` and `Anchor` removed. Assert exit code 2, `Main` at 60, the bucket and `Anchor` still live, and both records kept.
3. Empty the bucket and redeploy the same template. Assert exit code 0, the bucket and `Anchor` deleted, and their records dropped.
4. Destroy. Assert `Main` and the state file are gone.

## Run

```bash
STATE_BUCKET=cdkd-state-<account> AWS_REGION=us-east-1 ./verify.sh
```
