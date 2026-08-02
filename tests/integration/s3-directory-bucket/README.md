# s3-directory-bucket

Deploys an `AWS::S3Express::DirectoryBucket` and verifies the destroy data
guard (issue [#1344](https://github.com/go-to-k/cdkd/issues/1344), sibling of
[#1340](https://github.com/go-to-k/cdkd/issues/1340)): a non-empty directory
bucket FAILS the destroy with the object intact (CloudFormation `DELETE_FAILED`
parity, live-A/B-verified), and succeeds after the object is deleted via the
plain AWS CLI.

Directory buckets have no template opt-in for auto-emptying today (CDK has no
`autoDeleteObjects` sugar for them and cdkd does not yet handle the type's
`Tags` property), so manual emptying is the documented remediation.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
