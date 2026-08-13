import { describe, it, expect } from 'vite-plus/test';

import { buildDenyExternalAccessPolicy } from '../../../src/utils/deny-external-access-policy.js';

const BUCKET = 'cdkd-state-123456789012';
const ACCOUNT = '123456789012';

describe('buildDenyExternalAccessPolicy', () => {
  it('emits the pre-#1794 document byte-identically in the commercial partition', () => {
    // The literal below is the document the three call sites hardcoded before
    // issue #1794 routed them through this helper. Pinning it as a literal —
    // rather than rebuilding it from the same helper — is what makes this a
    // regression fence: every deployed cdkd state / asset bucket in the
    // commercial partition already carries exactly this policy, so a change
    // here silently rewrites live buckets' access control on the next
    // `cdkd bootstrap`.
    expect(buildDenyExternalAccessPolicy(BUCKET, ACCOUNT, 'us-east-1')).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyExternalAccess',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
          Condition: {
            StringNotEquals: {
              'aws:PrincipalAccount': ACCOUNT,
            },
          },
        },
      ],
    });
  });

  it('serializes byte-identically to the pre-#1794 literal', () => {
    // The call sites all `JSON.stringify` the document, so key ORDER is part
    // of what reaches AWS. `toEqual` above is order-insensitive; this is not.
    expect(JSON.stringify(buildDenyExternalAccessPolicy(BUCKET, ACCOUNT, 'us-west-2'))).toBe(
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'DenyExternalAccess',
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:*',
            Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
            Condition: { StringNotEquals: { 'aws:PrincipalAccount': ACCOUNT } },
          },
        ],
      })
    );
  });

  it.each([
    ['cn-north-1', 'aws-cn'],
    ['cn-northwest-1', 'aws-cn'],
    ['us-gov-west-1', 'aws-us-gov'],
    ['us-gov-east-1', 'aws-us-gov'],
  ])('derives the resource ARNs partition from %s -> %s', (region, partition) => {
    const policy = buildDenyExternalAccessPolicy(BUCKET, ACCOUNT, region);

    expect(policy.Statement[0]!.Resource).toEqual([
      `arn:${partition}:s3:::${BUCKET}`,
      `arn:${partition}:s3:::${BUCKET}/*`,
    ]);
  });

  it('names no arn:aws: resource outside the commercial partition', () => {
    // The defect issue #1794 fixed: a hardcoded `arn:aws:` matched NO resource
    // in `aws-cn`, so `PutBucketPolicy` succeeded and the deny protected
    // nothing. Assert the absence directly — the per-partition case above
    // would still pass if a stray commercial ARN were appended.
    const policy = buildDenyExternalAccessPolicy(BUCKET, ACCOUNT, 'cn-north-1');

    for (const resource of policy.Statement[0]!.Resource) {
      expect(resource.startsWith('arn:aws:')).toBe(false);
    }
  });

  it('changes the resource ARNs across partitions and nothing else', () => {
    const commercial = buildDenyExternalAccessPolicy(BUCKET, ACCOUNT, 'us-east-1');
    const china = buildDenyExternalAccessPolicy(BUCKET, ACCOUNT, 'cn-north-1');

    // Assert the DIFFERENCE first. Without this the rest of the test passes
    // even with the partition hardcoded back to `aws`, which is the vacuity
    // the PR review flagged: substituting the commercial Resource into the cn
    // statement leaves only fields the change cannot touch.
    expect(china.Statement[0]!.Resource).not.toEqual(commercial.Statement[0]!.Resource);
    // ...then that Resource is the ONLY field that moved.
    expect({ ...china.Statement[0]!, Resource: commercial.Statement[0]!.Resource }).toEqual(
      commercial.Statement[0]
    );
    expect(china.Version).toBe(commercial.Version);
  });

  it('falls back to the commercial partition for an unknown region', () => {
    // `derivePartitionAndUrlSuffix` defaults to `aws`, so a region cdkd's
    // partition table does not know yet keeps today's behavior rather than
    // producing a malformed ARN.
    expect(buildDenyExternalAccessPolicy(BUCKET, ACCOUNT, 'xx-somewhere-1').Statement[0]!.Resource)
      .toEqual([`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`]);
  });
});
