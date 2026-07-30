import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockCloudFormationSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import {
  describeTypeWithThrottleRetry,
  describeTypeRetryDelays,
  hasNoRegistrySchema,
} from '../../../src/provisioning/describe-type.js';

function throttlingError(): Error {
  const error = new Error('Rate exceeded');
  error.name = 'Throttling';
  return error;
}

describe('describeTypeWithThrottleRetry (issue #1236)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    describeTypeRetryDelays.sleep = async () => {};
  });

  afterEach(() => {
    delete describeTypeRetryDelays.sleep;
  });

  it('returns the response on first success without retrying', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: '{}' });

    const response = await describeTypeWithThrottleRetry('AWS::ECS::Service');

    expect(response).toEqual({ Schema: '{}' });
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('retries through a transient throttle and returns the eventual response', async () => {
    mockCloudFormationSend
      .mockRejectedValueOnce(throttlingError())
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValueOnce({ Schema: '{"writeOnlyProperties":[]}' });

    const response = await describeTypeWithThrottleRetry('AWS::ECS::Service');

    expect(response).toEqual({ Schema: '{"writeOnlyProperties":[]}' });
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting the retry budget on a persistent throttle', async () => {
    mockCloudFormationSend.mockRejectedValue(throttlingError());

    await expect(describeTypeWithThrottleRetry('AWS::ECS::Service')).rejects.toThrow(
      'Rate exceeded'
    );
    // 1 initial attempt + 4 retries.
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(5);
  });

  it('does NOT retry a non-throttle failure (missing IAM permission)', async () => {
    const accessDenied = new Error(
      'User is not authorized to perform: cloudformation:DescribeType'
    );
    accessDenied.name = 'AccessDeniedException';
    mockCloudFormationSend.mockRejectedValue(accessDenied);

    await expect(describeTypeWithThrottleRetry('AWS::ECS::Service')).rejects.toThrow(
      'not authorized'
    );
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('uses an injected client (export path) and still retries through a throttle on it', async () => {
    const injectedSend = vi
      .fn()
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValueOnce({ Schema: '{"primaryIdentifier":["/properties/BucketName"]}' });
    const injectedClient = { send: injectedSend } as unknown as Parameters<
      typeof describeTypeWithThrottleRetry
    >[1];

    const response = await describeTypeWithThrottleRetry('AWS::S3::Bucket', injectedClient);

    expect(response).toEqual({ Schema: '{"primaryIdentifier":["/properties/BucketName"]}' });
    expect(injectedSend).toHaveBeenCalledTimes(2);
    // The shared client must NOT be touched when a client is injected.
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
  });
});

describe('hasNoRegistrySchema', () => {
  it.each([
    'AWS::CDK::Metadata',
    'AWS::CloudFormation::CustomResource',
    'Custom::MyThing',
    'Custom::',
  ])('is true for the schema-less type %s', (type) => {
    expect(hasNoRegistrySchema(type)).toBe(true);
  });

  it.each([
    'AWS::S3::Bucket',
    'AWS::ECS::Service',
    'AWS::CloudFormation::Stack',
    'AWS::CloudFormation::WaitConditionHandle',
    // Near-misses that DO have a registry schema and must keep looking up.
    'AWS::CDK::MetadataThing',
    'MyCustom::Thing',
  ])('is false for the registry-backed type %s', (type) => {
    expect(hasNoRegistrySchema(type)).toBe(false);
  });
});
