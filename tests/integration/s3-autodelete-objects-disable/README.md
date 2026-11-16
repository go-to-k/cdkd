# s3-autodelete-objects-disable

Integration test for turning `autoDeleteObjects` **off** on an `s3.Bucket`
whose only tag is CDK's `aws-cdk:auto-delete-objects` (issue
[#6422](https://github.com/go-to-k/cdkd/issues/6422)).

That one deploy strips the tag, which leaves the bucket with no tag set, and
deletes the `Custom::S3AutoDeleteObjects` resource. CDK's handler reads the
bucket's tags on Delete, S3 answers `NoSuchTagSet`, and the handler reports
FAILED. cdkd used to keep the record as unaddressed and exit 2. CloudFormation
never meets this, because its buckets keep their `aws:cloudformation:*` tags.
cdkd now confirms the empty tag set with its own S3 read and counts the delete
as done.

## What it covers

- `AWS::S3::Bucket`
- `Custom::S3AutoDeleteObjects` (CDK's handler, its provider Lambda + role, `AWS::S3::BucketPolicy`)

## Phases

1. Deploy `autoDeleteObjects: true`, put two objects, and assert the auto-delete tag is the bucket's only tag.
2. Redeploy with `CDKD_TEST_UPDATE=true` (`autoDeleteObjects: false`, `RETAIN`), without `--allow-unaddressed`. Assert exit code 0, no tag set, both objects kept, and the custom resource's state record gone.
3. Destroy. The `RETAIN` bucket survives with its objects; `verify.sh` then deletes it by hand and asserts the state file is gone.

## Run

```bash
STATE_BUCKET=cdkd-state-<account> AWS_REGION=us-east-1 ./verify.sh
```
