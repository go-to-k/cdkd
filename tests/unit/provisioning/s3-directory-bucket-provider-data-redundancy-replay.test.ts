import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockS3Send, mockStsSend, mockEc2Send, childLogger } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockStsSend: vi.fn(),
  mockEc2Send: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockS3Send, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: mockEc2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';

const RESOURCE_TYPE = 'AWS::S3Express::DirectoryBucket';
const BUCKET_NAME = 'my-bucket--use1-az1--x-s3';

/**
 * `CreateContext.replayingState` downgrade for the create-path
 * `DataRedundancy` pre-flight refusal (issue #1544).
 *
 * Before this fix `create()` did not declare the optional `context`
 * parameter, so a state record carrying a malformed `DataRedundancy` hard-
 * threw on the rollback executor's reverse-replacement replay — leaving the
 * old directory bucket unrestorable. Modeled on the #1542 BillingMode suite.
 */
describe('S3DirectoryBucketProvider malformed DataRedundancy on a state replay (issue #1544)', () => {
  let provider: S3DirectoryBucketProvider;

  beforeEach(() => {
    mockS3Send.mockReset();
    mockStsSend.mockReset();
    mockEc2Send.mockReset();
    childLogger.warn.mockReset();
    provider = new S3DirectoryBucketProvider();

    mockEc2Send.mockResolvedValue({ AvailabilityZones: [{ ZoneId: 'use1-az1' }] });
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    mockS3Send.mockResolvedValue({});
  });

  const baseProps = { BucketName: BUCKET_NAME, LocationName: 'us-east-1a--x-s3' };

  const createCall = () =>
    mockS3Send.mock.calls.find((c) => c[0].constructor.name === 'CreateBucketCommand');

  // ─── replayingState: true → warn, proceed with the default ─────────────

  it('WARNS instead of throwing when the create is a state replay', async () => {
    const result = await provider.create(
      'MyBucket',
      RESOURCE_TYPE,
      { ...baseProps, DataRedundancy: null },
      { replayingState: true }
    );

    expect(result.physicalId).toBe(BUCKET_NAME);
    expect(createCall()?.[0].input.CreateBucketConfiguration.Bucket.DataRedundancy).toBe(
      'SingleAvailabilityZone'
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'AWS::S3Express::DirectoryBucket DataRedundancy must be a non-empty string'
      )
    );
  });

  it('leaves a VALID DataRedundancy untouched on a state replay', async () => {
    await provider.create(
      'MyBucket',
      RESOURCE_TYPE,
      { ...baseProps, DataRedundancy: 'SingleAvailabilityZone' },
      { replayingState: true }
    );

    expect(createCall()?.[0].input.CreateBucketConfiguration.Bucket.DataRedundancy).toBe(
      'SingleAvailabilityZone'
    );
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::S3Express::DirectoryBucket DataRedundancy')
    );
  });

  // ─── replayingState absent / false / empty context → refusal stands ────

  it('keeps the refusal on an ordinary template-path create (no context)', async () => {
    await expect(
      provider.create('MyBucket', RESOURCE_TYPE, { ...baseProps, DataRedundancy: null })
    ).rejects.toThrow(
      /AWS::S3Express::DirectoryBucket DataRedundancy must be a non-empty string \(got null\)/
    );

    // The refusal must land BEFORE CreateBucket — a pre-flight refusal.
    expect(createCall()).toBeUndefined();
  });

  it('keeps the refusal when the context carries replayingState: false', async () => {
    await expect(
      provider.create(
        'MyBucket',
        RESOURCE_TYPE,
        { ...baseProps, DataRedundancy: '' },
        { replayingState: false }
      )
    ).rejects.toThrow(/AWS::S3Express::DirectoryBucket DataRedundancy must be a non-empty string/);
    expect(createCall()).toBeUndefined();
  });

  it('keeps the refusal when the context is present but carries no replay flag', async () => {
    // `replayWarn` tests `=== true`; an empty context bag is an ordinary
    // create.
    await expect(
      provider.create(
        'MyBucket',
        RESOURCE_TYPE,
        { ...baseProps, DataRedundancy: { Ref: 'Unresolved' } },
        {}
      )
    ).rejects.toThrow(
      /AWS::S3Express::DirectoryBucket DataRedundancy must be a non-empty string \(got an object\)/
    );
  });

  it('still defaults an ABSENT DataRedundancy on a plain create', async () => {
    await provider.create('MyBucket', RESOURCE_TYPE, { ...baseProps });

    expect(createCall()?.[0].input.CreateBucketConfiguration.Bucket.DataRedundancy).toBe(
      'SingleAvailabilityZone'
    );
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AWS::S3Express::DirectoryBucket DataRedundancy')
    );
  });
});
