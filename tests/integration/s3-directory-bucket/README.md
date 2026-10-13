# s3-directory-bucket

Deploys TWO `AWS::S3Express::DirectoryBucket`s and verifies:

- **Destroy data guard** (issue
  [#1344](https://github.com/go-to-k/cdkd/issues/1344), sibling of
  [#1340](https://github.com/go-to-k/cdkd/issues/1340)): the UNTAGGED,
  non-empty bucket FAILS the destroy with the object intact (CloudFormation
  `DELETE_FAILED` parity, live-A/B-verified), and succeeds after the object is
  deleted via the plain AWS CLI.
- **Tags as a handled property** (issue
  [#609](https://github.com/go-to-k/cdkd/issues/609) batch): the sibling
  bucket carries template `Tags` including the `aws-cdk:auto-delete-objects`
  opt-in. The fixture asserts the create-time tags landed (S3 Control
  `list-tags-for-resource`), a `CDKD_TEST_UPDATE=true` redeploy mutates the
  set (TagResource value change + UntagResource removal), and the SAME
  destroy that the guard refuses on the untagged bucket auto-empties and
  deletes the DATA-CARRYING tagged bucket (the bounded empty-retry loop
  ported from the standard-bucket provider).

- **A secret-named bucket's not-empty refusal** (issue
  [#2007](https://github.com/go-to-k/cdkd/issues/2007)): a third bucket, the
  only resource under `S3DIR_SECRET_NAME`, is named from a Secrets Manager
  secret and given an object, then deleted by `cdkd destroy`, by `cdkd
  rollback` of a failed `--no-rollback` deploy, and by a deploy that drops it.
  Each refusal must say the name is secret-derived and print no `aws s3 rm`
  command. The fixture empties the bucket after each, removes the secret, and
  sweeps every object version under the stack's state prefix.

CDK has no `autoDeleteObjects` sugar for directory buckets — the opt-in tag
is declared explicitly on the L1 via `addPropertyOverride`.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
