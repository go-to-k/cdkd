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
    child: vi.fn().mockReturnThis(),
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

describe('S3BucketPolicyProvider.readCurrentState', () => {
  let provider: S3BucketPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('returns undefined when bucket gone', async () => {
    mockSend.mockRejectedValueOnce(new NoSuchBucket({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState(
      'my-bucket',
      'Logical',
      'AWS::S3::BucketPolicy'
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when bucket has no attached policy', async () => {
    const err = new Error('No policy');
    (err as { name?: string }).name = 'NoSuchBucketPolicy';
    mockSend.mockRejectedValueOnce(err);

    const result = await provider.readCurrentState(
      'my-bucket',
      'Logical',
      'AWS::S3::BucketPolicy'
    );
    expect(result).toBeUndefined();
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

    const result = await provider.readCurrentState(
      'my-bucket',
      'L',
      'AWS::S3::BucketPolicy',
      undefined,
      context
    );

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

    const result = await provider.readCurrentState(
      'my-bucket',
      'L',
      'AWS::S3::BucketPolicy',
      templateProps // template carries the ORIGINAL CANONICAL
    );

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    // Resolved to the OTHER OAI's canonical id (not the template's) -> drift stands.
    expect(stmt['Principal']).toEqual({ CanonicalUser: OTHER_CANONICAL });
    expect(stmt['Principal']).not.toEqual({ CanonicalUser: CANONICAL });
  });

  it('leaves an `AWS` ARRAY-of-principals statement untouched (single-OAI grant uses the string form)', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: [OAI_ARN, 'arn:aws:iam::123:role/R'] }) });

    const result = await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy');

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

    const result = await provider.readCurrentState(
      'my-bucket',
      'L',
      'AWS::S3::BucketPolicy',
      ambiguousTemplate
    );

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    // Ambiguous -> do not adopt either; left unchanged.
    expect(stmt['Principal']).toEqual({ AWS: 'AIDAIBJOSOJSBZ753XCAW' });
  });

  it('falls back to GetCloudFrontOriginAccessIdentity when the OAI is not a same-stack sibling', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: OAI_ARN }) });
    mockCloudFrontSend.mockResolvedValueOnce({
      CloudFrontOriginAccessIdentity: { Id: 'E1UREC9EUJDVG5', S3CanonicalUserId: CANONICAL },
    });

    const result = await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy');

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ CanonicalUser: CANONICAL });
    // The OAI id from the ARN was the GetCloudFrontOriginAccessIdentity input.
    const cfInput = mockCloudFrontSend.mock.calls[0]?.[0] as { input: { Id: string } };
    expect(cfInput.input.Id).toBe('E1UREC9EUJDVG5');
  });

  it('normalizes the transient bare IAM-unique-id principal via the matching template statement', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: 'AIDAIBJOSOJSBZ753XCAW' }) });

    const result = await provider.readCurrentState(
      'my-bucket',
      'L',
      'AWS::S3::BucketPolicy',
      templateProps
    );

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ CanonicalUser: CANONICAL });
    // No CloudFront call needed for the template-match path.
    expect(mockCloudFrontSend).not.toHaveBeenCalled();
  });

  it('leaves the bare IAM-unique-id principal unchanged when no matching template statement exists', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: 'AIDAIBJOSOJSBZ753XCAW' }) });

    const result = await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy');

    const stmt = (result!['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement[0]!;
    expect(stmt['Principal']).toEqual({ AWS: 'AIDAIBJOSOJSBZ753XCAW' });
  });

  it('leaves the principal unchanged when the OAI ARN lookup fails (best-effort)', async () => {
    mockSend.mockResolvedValueOnce({ Policy: oaiPolicy({ AWS: OAI_ARN }) });
    mockCloudFrontSend.mockRejectedValueOnce(new Error('NoSuchCloudFrontOriginAccessIdentity'));

    const result = await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy');

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

    const result = await provider.readCurrentState('my-bucket', 'L', 'AWS::S3::BucketPolicy');

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
