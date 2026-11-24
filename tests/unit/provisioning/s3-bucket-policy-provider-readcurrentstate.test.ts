import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetBucketPolicyCommand, NoSuchBucket } from '@aws-sdk/client-s3';

const mockSend = vi.fn();
const mockCloudFrontSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFront: { send: mockCloudFrontSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  S3BucketPolicyProvider,
  clearOaiCanonicalUserIdCacheForTest,
} from '../../../src/provisioning/providers/s3-bucket-policy-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

describe('S3BucketPolicyProvider.readCurrentState', () => {
  let provider: S3BucketPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // A persistent `mockResolvedValue` must not reach the next test.
    mockSend.mockReset();
    mockCloudFrontSend.mockReset();
    clearOaiCanonicalUserIdCacheForTest();
    provider = new S3BucketPolicyProvider();
  });

  it('returns Bucket + JSON-parsed PolicyDocument (happy path)', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:...' },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = await provider.readCurrentState(
      'my-bucket',
      'Logical',
      'AWS::S3::BucketPolicy'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetBucketPolicyCommand);
    expect(result).toEqual({
      Bucket: 'my-bucket',
      PolicyDocument: policy,
    });
  });

  it('returns RESOURCE_NOT_FOUND when bucket gone', async () => {
    mockSend.mockRejectedValueOnce(new NoSuchBucket({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState(
      'my-bucket',
      'Logical',
      'AWS::S3::BucketPolicy'
    );
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('returns RESOURCE_NOT_FOUND when bucket has no attached policy (NoSuchBucketPolicy)', async () => {
    const err = new Error('No policy');
    (err as { name?: string }).name = 'NoSuchBucketPolicy';
    mockSend.mockRejectedValueOnce(err);

    const result = await provider.readCurrentState(
      'my-bucket',
      'Logical',
      'AWS::S3::BucketPolicy'
    );
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('rethrows a non-not-found error instead of reporting the policy gone', async () => {
    const err = new Error('denied');
    (err as { name?: string }).name = 'AccessDenied';
    mockSend.mockRejectedValueOnce(err);

    await expect(
      provider.readCurrentState('my-bucket', 'Logical', 'AWS::S3::BucketPolicy')
    ).rejects.toThrow('denied');
  });

  // --- OAI principal canonicalization (issue #872) ----------------------
  const CANONICAL = '4ef329915fc94a782e00066d250553084f96cb485fe05cd0623a736956206c0c';
  const OAI_ARN =
    'arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity E1UREC9EUJDVG5';

  function oaiPolicy(principal: Record<string, unknown>): string {
    return JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: principal, Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
      ],
    });
  }

  const templateProps = {
    Bucket: 'my-bucket',
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { CanonicalUser: CANONICAL },
          Action: 's3:GetObject',
          Resource: 'arn:aws:s3:::b/*',
        },
      ],
    },
  };

  it('normalizes the settled OAI ARN principal via the sibling OAI state attribute (zero AWS call)', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: OAI_ARN }) });

    const context = {
      siblings: {
        TheOai: {
          resourceType: 'AWS::CloudFront::CloudFrontOriginAccessIdentity',
          physicalId: 'E1UREC9EUJDVG5',
          properties: {},
          attributes: { S3CanonicalUserId: CANONICAL },
        },
      },
    };

    const result = (await provider.readCurrentState(
      'my-bucket',
      'L',
      'AWS::S3::BucketPolicy',
      undefined,
      context
    )) as Record<string, unknown> | undefined;

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ CanonicalUser: CANONICAL });
    // Resolved from sibling state — no CloudFront call needed.
    expect(mockCloudFrontSend).not.toHaveBeenCalled();
  });

  it('STRICT RECONCILE: a different OAI resolves to a different canonical id, so real drift is NOT suppressed', async () => {
    // The AWS-side policy points at a DIFFERENT OAI than the template. The
    // normalization must surface the RESOLVED (AWS-side) canonical id, not the
    // template's — so the downstream comparator still reports the drift.
    const OTHER_OAI_ARN =
      'arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity EDIFFERENTOAI9';
    const OTHER_CANONICAL = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: OTHER_OAI_ARN }) });
    mockCloudFrontSend.mockResolvedValueOnce({
      CloudFrontOriginAccessIdentity: { Id: 'EDIFFERENTOAI9', S3CanonicalUserId: OTHER_CANONICAL },
    });

    const result = (await provider.readCurrentState(
      'my-bucket',
      'L',
      'AWS::S3::BucketPolicy',
      templateProps // template carries the ORIGINAL CANONICAL
    )) as Record<string, unknown> | undefined;

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    // Resolved to the OTHER OAI's canonical id (not the template's) -> drift stands.
    expect(stmt['Principal']).toEqual({ CanonicalUser: OTHER_CANONICAL });
    expect(stmt['Principal']).not.toEqual({ CanonicalUser: CANONICAL });
  });

  it('leaves an `AWS` ARRAY-of-principals statement untouched (single-OAI grant uses the string form)', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: [OAI_ARN, 'arn:aws:iam::123:role/R'] }) });

    const result = (await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy')) as Record<string, unknown> | undefined;

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ AWS: [OAI_ARN, 'arn:aws:iam::123:role/R'] });
    expect(mockCloudFrontSend).not.toHaveBeenCalled();
  });

  it('leaves a bare-unique-id principal unchanged when >1 template statement shares the same Effect/Action/Resource (ambiguous match)', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: 'AIDAIBJOSOJSBZ753XCAW' }) });
    const ambiguousTemplate = {
      Bucket: 'my-bucket',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { CanonicalUser: CANONICAL }, Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
          { Effect: 'Allow', Principal: { CanonicalUser: 'other' }, Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
        ],
      },
    };

    Object.assign(provider, { ownWriteRereadDelaysMs: [] });
    const result = (await provider.readCurrentState(
      'my-bucket',
      'L',
      'AWS::S3::BucketPolicy',
      ambiguousTemplate,
      { afterOwnWrite: true }
    )) as Record<string, unknown> | undefined;

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    // Ambiguous -> do not adopt either; left unchanged.
    expect(stmt['Principal']).toEqual({ AWS: 'AIDAIBJOSOJSBZ753XCAW' });
  });

  it('falls back to GetCloudFrontOriginAccessIdentity when the OAI is not a same-stack sibling', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: OAI_ARN }) });
    mockCloudFrontSend.mockResolvedValueOnce({
      CloudFrontOriginAccessIdentity: { Id: 'E1UREC9EUJDVG5', S3CanonicalUserId: CANONICAL },
    });

    const result = (await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy')) as Record<string, unknown> | undefined;

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ CanonicalUser: CANONICAL });
    // The OAI id from the ARN was the GetCloudFrontOriginAccessIdentity input.
    const cfInput = mockCloudFrontSend.mock.calls[0]?.[0] as { input: { Id: string } };
    expect(cfInput.input.Id).toBe('E1UREC9EUJDVG5');
  });

  it('normalizes the transient bare IAM-unique-id principal via the matching template statement, right after its own write', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: 'AIDAIBJOSOJSBZ753XCAW' }) });
    Object.assign(provider, { ownWriteRereadDelaysMs: [] });

    const result = (await provider.readCurrentState(
      'my-bucket',
      'L',
      'AWS::S3::BucketPolicy',
      templateProps,
      { afterOwnWrite: true }
    )) as Record<string, unknown> | undefined;

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ CanonicalUser: CANONICAL });
    // No CloudFront call needed for the template-match path.
    expect(mockCloudFrontSend).not.toHaveBeenCalled();
  });

  // go-to-k/cdkd#6854: S3 also renders a DELETED IAM user's grant as its bare
  // `AIDA...` id, permanently (measured). On a drift read that id must stay
  // as read, or a grant moved to a since-deleted user compares equal to the
  // template's OAI grant.
  it('leaves a bare IAM-unique-id principal as read on a drift read once the re-reads still show it', async () => {
    mockSend.mockResolvedValue({ Policy: oaiPolicy({ AWS: 'AIDAIBJOSOJSBZ753XCAW' }) });
    const sleeps: number[] = [];
    Object.assign(provider, {
      transientUniqueIdRereadDelaysMs: [1, 2],
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    for (const context of [undefined, {}, { afterOwnWrite: false }]) {
      mockSend.mockClear();
      sleeps.length = 0;
      const result = (await provider.readCurrentState(
        'my-bucket',
        'L',
        'AWS::S3::BucketPolicy',
        templateProps,
        context
      )) as Record<string, unknown> | undefined;

      const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] })
        .Statement[0]!;
      expect(stmt['Principal']).toEqual({ AWS: 'AIDAIBJOSOJSBZ753XCAW' });
      // One read plus one per delay: the transient OAI form would have settled.
      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(sleeps).toEqual([1, 2]);
    }
  });

  it('on a drift read, re-reads a bare unique id a template statement claims until S3 shows the OAI user ARN', async () => {
    mockSend
      .mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: 'AIDAIBJOSOJSBZ753XCAW' }) })
      .mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: OAI_ARN }) });
    mockCloudFrontSend.mockResolvedValueOnce({
      CloudFrontOriginAccessIdentity: { Id: 'E1UREC9EUJDVG5', S3CanonicalUserId: CANONICAL },
    });
    Object.assign(provider, { transientUniqueIdRereadDelaysMs: [0, 0, 0], sleep: async () => {} });

    const result = (await provider.readCurrentState(
      'my-bucket',
      'L',
      'AWS::S3::BucketPolicy',
      templateProps
    )) as Record<string, unknown> | undefined;

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ CanonicalUser: CANONICAL });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('on a drift read, keeps the answer before a re-read that fails', async () => {
    mockSend
      .mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: 'AIDAIBJOSOJSBZ753XCAW' }) })
      .mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'), { name: 'SlowDown' }));
    Object.assign(provider, { transientUniqueIdRereadDelaysMs: [0, 0, 0], sleep: async () => {} });

    const result = (await provider.readCurrentState(
      'my-bucket',
      'L',
      'AWS::S3::BucketPolicy',
      templateProps
    )) as Record<string, unknown> | undefined;

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ AWS: 'AIDAIBJOSOJSBZ753XCAW' });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('right after its own write, folds on the first read and never waits out the transient form', async () => {
    mockSend.mockResolvedValue({ Policy: oaiPolicy({ AWS: 'AIDAIBJOSOJSBZ753XCAW' }) });
    const sleep = vi.fn(async () => {});
    Object.assign(provider, { ownWriteRereadDelaysMs: [], sleep });

    await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy', templateProps, {
      afterOwnWrite: true,
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // go-to-k/cdkd#6854: the post-write capture settles on a bare account id
  // read back as the root ARN of the bucket's partition, never of another.
  it("right after its own write, settles a bare account id only on its partition's root ARN", async () => {
    const accountPolicy = (principal: string) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { AWS: principal }, Action: 's3:ListBucket', Resource: 'arn:aws:s3:::b' },
        ],
      });
    const declared = { Bucket: 'my-bucket', PolicyDocument: JSON.parse(accountPolicy('123456789012')) };
    Object.assign(provider, { ownWriteRereadDelaysMs: [0], sleep: async () => {} });

    mockSend.mockResolvedValue({ Policy: accountPolicy('arn:aws:iam::123456789012:root') });
    await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy', declared, { afterOwnWrite: true });
    expect(mockSend).toHaveBeenCalledTimes(1);

    mockSend.mockReset();
    mockSend.mockResolvedValue({ Policy: accountPolicy('arn:aws-cn:iam::123456789012:root') });
    await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy', declared, { afterOwnWrite: true });
    // Not the declared document: re-read on the schedule.
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('on a drift read, never re-reads a policy with no template-claimed bare unique id', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: 'AIDAIBJOSOJSBZ753XCAW' }) });
    const sleep = vi.fn(async () => {});
    Object.assign(provider, { sleep });

    await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('leaves the bare IAM-unique-id principal unchanged when no matching template statement exists', async () => {
    mockSend.mockResolvedValue({ Policy: oaiPolicy({ AWS: 'AIDAIBJOSOJSBZ753XCAW' }) });
    Object.assign(provider, { ownWriteRereadDelaysMs: [] });
    const otherAction = {
      Bucket: 'my-bucket',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { CanonicalUser: CANONICAL }, Action: 's3:ListBucket', Resource: 'arn:aws:s3:::b' },
        ],
      },
    };

    const result = (await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy', otherAction, {
      afterOwnWrite: true,
    })) as Record<string, unknown> | undefined;

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ AWS: 'AIDAIBJOSOJSBZ753XCAW' });
  });

  it('leaves the principal unchanged when the OAI ARN lookup fails (best-effort)', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: OAI_ARN }) });
    mockCloudFrontSend.mockRejectedValueOnce(new Error('NoSuchCloudFrontOriginAccessIdentity'));

    const result = (await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy')) as Record<string, unknown> | undefined;

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ AWS: OAI_ARN });
  });

  it('does not touch non-OAI principals (wildcard, service, normal role ARN)', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
        {
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: 's3:GetObject',
          Resource: 'arn:aws:s3:::b/*',
        },
        {
          Effect: 'Allow',
          Principal: { AWS: 'arn:aws:iam::123456789012:role/MyRole' },
          Action: 's3:GetObject',
          Resource: 'arn:aws:s3:::b/*',
        },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const result = (await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy')) as Record<string, unknown> | undefined;

    expect(result!['PolicyDocument']).toEqual(policy);
    expect(mockCloudFrontSend).not.toHaveBeenCalled();
  });

  it('caches the OAI canonical-user-id lookup across statements / reads', async () => {
    const twoStmt = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: { AWS: OAI_ARN }, Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
        { Effect: 'Allow', Principal: { AWS: OAI_ARN }, Action: 's3:ListBucket', Resource: 'arn:aws:s3:::b' },
      ],
    });
    mockSend.mockResolvedValueOnce({ Policy: twoStmt });
    mockCloudFrontSend.mockResolvedValueOnce({
      CloudFrontOriginAccessIdentity: { Id: 'E1UREC9EUJDVG5', S3CanonicalUserId: CANONICAL },
    });

    await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy');

    // Two statements, same OAI -> exactly one GetCloudFrontOriginAccessIdentity.
    expect(mockCloudFrontSend).toHaveBeenCalledTimes(1);
  });
});
