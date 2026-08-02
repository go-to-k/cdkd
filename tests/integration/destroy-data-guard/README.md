# destroy-data-guard

End-to-end verification of cdkd's destroy data guards (issue
[#1340](https://github.com/go-to-k/cdkd/issues/1340)): `cdkd destroy` matches
CloudFormation's fail-and-protect behavior for a non-empty S3 bucket and an
image-carrying ECR repository, force-cleaning ONLY when the resource opted in.

## Resources

| Logical ID | Type | Opt-in | Expected on destroy with data |
| --- | --- | --- | --- |
| `GuardedBucket` | `AWS::S3::Bucket` | none | FAIL (`is not empty`), object intact |
| `OptInBucket` | `AWS::S3::Bucket` (versioned) | `aws-cdk:auto-delete-objects` tag | auto-emptied (versions + delete markers) and deleted |
| `GuardedRepo` | `AWS::ECR::Repository` | none | FAIL (`still contains images`), image intact |
| `OptInRepo` | `AWS::ECR::Repository` | `emptyOnDelete: true` | force-deleted with the image |

`OptInBucket` applies the tag directly instead of `autoDeleteObjects: true` so
the fixture exercises cdkd's gate in isolation (the CDK custom resource would
empty the bucket itself before cdkd's provider ever saw the data); the full
custom-resource flow is covered by the `bucket-deployment` fixture.

## Flow

1. Deploy the 4 resources.
2. Load data into all four out of band (objects — for the versioned bucket 2
   versions + a delete marker; a docker-pushed busybox image into each repo).
3. First `cdkd destroy`: must exit non-zero with both guard errors; the
   guarded pair's data must be intact; the opted-in pair must be gone; the
   state file must survive (partial destroy).
4. Delete the guarded data via plain AWS CLI, destroy again: must succeed
   with zero orphans (state file gone).

## Requirements

- `STATE_BUCKET` env var, AWS credentials (`us-east-1` by default)
- docker (pushes a seed image into the repos)

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
