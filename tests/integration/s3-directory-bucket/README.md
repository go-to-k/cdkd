# s3-directory-bucket

Deploys TWO `AWS::S3Express::DirectoryBucket`s (plus, for the tagged one, a KMS key
and an inventory destination bucket) and verifies:

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
- **Bucket configurations on the SDK route** (issue
  [#2762](https://github.com/go-to-k/cdkd/issues/2762)): the tagged bucket
  also declares SSE-KMS `BucketEncryption` (a KMS key in the stack),
  `LifecycleConfiguration`, `MetricsConfigurations` and
  `InventoryConfigurations` (reports to a general purpose bucket in the
  stack). The fixture reads each back with the AWS CLI after the create,
  asserts the bucket's `provisionedBy` is `sdk`, and runs `cdkd drift` (whose
  baseline is the deploy's own readback, so a clean run shows the readback is
  stable, not that it equals the template). The `CDKD_TEST_UPDATE=true`
  redeploy changes one lifecycle rule and drops the other, swaps one metrics
  configuration for another and removes the inventory configuration; the
  fixture asserts each change and runs `cdkd drift` again. The tagged bucket's
  encryption is never changed: a directory bucket keeps one customer managed
  key for its lifetime. The guard bucket declares an SSE-S3 encryption and a
  lifecycle rule outside UPDATE mode only, so the redeploy removes both whole
  (`DeleteBucketLifecycle`, asserted gone, and `DeleteBucketEncryption`,
  which leaves the SSE-S3 default it already had).

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
