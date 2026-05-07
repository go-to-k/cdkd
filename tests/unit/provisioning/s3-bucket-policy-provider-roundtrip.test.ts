import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PutBucketPolicyCommand } from '@aws-sdk/client-s3';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { S3BucketPolicyProvider } from '../../../src/provisioning/providers/s3-bucket-policy-provider.js';

const RESOURCE_TYPE = 'AWS::S3::BucketPolicy';
const BUCKET_NAME = 'my-bucket';

describe('S3BucketPolicyProvider read-update round-trip', () => {
  let provider: S3BucketPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketPolicyProvider();
  });

  it('round-trip: readCurrentState placeholders survive update() without AWS-invalid inputs', async () => {
    // 1. Mock GetBucketPolicy to return a typical policy document.
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: 's3:GetObject',
          Resource: `arn:aws:s3:::${BUCKET_NAME}/*`,
        },
      ],
    };
    mockSend.mockResolvedValueOnce({ Policy: JSON.stringify(policy) });

    const observed = await provider.readCurrentState(BUCKET_NAME, 'L', RESOURCE_TYPE);
    expect(observed).toEqual({
      Bucket: BUCKET_NAME,
      PolicyDocument: policy,
    });

    // 2. Reset mocks and round-trip the snapshot back through update().
    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({}); // PutBucketPolicy reply

    await provider.update('L', BUCKET_NAME, RESOURCE_TYPE, observed!, observed!);

    // 3. Assertions: every PutBucketPolicy must carry the required Bucket
    //    and a non-empty Policy string AWS will accept. There is no
    //    Class 1 / Class 2 placeholder for this resource type — both
    //    top-level keys are required and the PolicyDocument body comes
    //    straight from AWS, so no rejection-shape can sneak in.
    const putCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutBucketPolicyCommand
    );
    expect(putCalls).toHaveLength(1);
    const input = putCalls[0]![0].input as { Bucket?: string; Policy?: string };
    expect(input.Bucket).toBe(BUCKET_NAME);
    expect(typeof input.Policy).toBe('string');
    expect(input.Policy).not.toBe('');
    expect(input.Policy).not.toBe('{}');
    // Round-tripped Policy must be valid JSON the round-trip can read.
    expect(() => JSON.parse(input.Policy ?? '')).not.toThrow();
    // And the parsed body must be equal to the observed PolicyDocument
    // (i.e. update() did not corrupt the shape on the way to AWS).
    expect(JSON.parse(input.Policy ?? '')).toEqual(policy);
  });

  it('truthy-gate audit: PolicyDocument is required on update(), so empty values still hard-fail (not silently dropped)', async () => {
    // S3 BucketPolicy has only two top-level fields and both are
    // required. There is no optional field for a truthy-vs-undefined
    // gate to silently drop. Confirm the contract: empty / missing
    // PolicyDocument throws ProvisioningError instead of issuing a
    // PutBucketPolicy with a bogus body — the inverse of the IAM Role
    // truthy-gate failure mode where `Description: ''` was silently
    // dropped from UpdateRole.
    await expect(
      provider.update('L', BUCKET_NAME, RESOURCE_TYPE, { Bucket: BUCKET_NAME }, {})
    ).rejects.toThrow(/PolicyDocument is required/);

    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof PutBucketPolicyCommand)
    ).toHaveLength(0);
  });

  it('round-trip preserves a string-form PolicyDocument as well as object form', async () => {
    // CFn permits PolicyDocument in either object or pre-serialized
    // string form (the latter common when user inlines a JSON literal).
    // create() / update() handles both via the `typeof === 'string'`
    // branch; readCurrentState always JSON.parses to object form. The
    // round-trip from a string-form input must still produce a valid
    // PutBucketPolicy.
    const stringPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Principal: '*', Action: '*', Resource: '*' }],
    });

    mockSend.mockResolvedValueOnce({});
    await provider.update(
      'L',
      BUCKET_NAME,
      RESOURCE_TYPE,
      { Bucket: BUCKET_NAME, PolicyDocument: stringPolicy },
      { Bucket: BUCKET_NAME, PolicyDocument: stringPolicy }
    );

    const putCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutBucketPolicyCommand
    );
    expect(putCalls).toHaveLength(1);
    const input = putCalls[0]![0].input as { Policy?: string };
    expect(input.Policy).toBe(stringPolicy);
  });
});
