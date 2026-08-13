import { derivePartitionAndUrlSuffix } from './aws-partition.js';

/**
 * Build the `DenyExternalAccess` bucket policy cdkd applies to every bucket it
 * owns — the state bucket (`cdkd bootstrap`), the migration destination bucket
 * (`cdkd state-migrate`) and the asset bucket (`ensureAssetStorage`).
 *
 * The statement denies `s3:*` to every principal whose `aws:PrincipalAccount`
 * is not the bucket owner, so the resource ARNs it names are the whole
 * mechanism: a `Resource` that does not match the bucket makes the statement
 * apply to nothing, and the deny silently stops protecting anything.
 *
 * That is exactly what the hardcoded `arn:aws:` partition did outside the
 * commercial partition (issue
 * [#1794](https://github.com/go-to-k/cdkd/issues/1794), the residual of
 * [#1745](https://github.com/go-to-k/cdkd/issues/1745)). A bucket in `aws-cn`
 * is `arn:aws-cn:s3:::<bucket>`, so a statement naming `arn:aws:s3:::<bucket>`
 * matched no resource there. The policy was still structurally valid and
 * `PutBucketPolicy` still succeeded, which is what made the defect quiet —
 * cdkd reported "✓ Set bucket policy (deny external access)" over a bucket
 * that had no effective deny at all.
 *
 * The three call sites were byte-identical copies of this document before this
 * helper existed, and the partition literal drifted in all three at once. They
 * are centralized here so a fourth copy cannot re-introduce the same class:
 * the partition is derived from `region` in ONE place.
 *
 * @param bucketName - The bucket the policy is attached to.
 * @param accountId - The bucket owner; the only account the policy admits.
 * @param region - Any region in the BUCKET's partition; only the partition
 *   prefix is read, the region itself never appears in the output. Pass the
 *   region of the CLIENT that writes the bucket (`await
 *   client.config.region()`), NOT a CLI `--region` variable: those fall back to
 *   a hardcoded `us-east-1` when the flag is absent, while the client resolves
 *   the profile region through the SDK chain — so the two disagree exactly for
 *   the non-commercial user this helper exists to serve.
 * @returns The policy document, ready for `JSON.stringify`.
 */
export function buildDenyExternalAccessPolicy(
  bucketName: string,
  accountId: string,
  region: string
): {
  Version: '2012-10-17';
  Statement: Array<{
    Sid: 'DenyExternalAccess';
    Effect: 'Deny';
    Principal: '*';
    Action: 's3:*';
    Resource: string[];
    Condition: { StringNotEquals: { 'aws:PrincipalAccount': string } };
  }>;
} {
  const { partition } = derivePartitionAndUrlSuffix(region);
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyExternalAccess',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [`arn:${partition}:s3:::${bucketName}`, `arn:${partition}:s3:::${bucketName}/*`],
        Condition: {
          StringNotEquals: {
            'aws:PrincipalAccount': accountId,
          },
        },
      },
    ],
  };
}
