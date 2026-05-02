import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS clients before importing the provider
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

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';

describe('S3BucketProvider.getAttribute', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketProvider();
  });

  it('returns Arn templated from bucket name (no AWS call)', async () => {
    const result = await provider.getAttribute('my-bucket', 'AWS::S3::Bucket', 'Arn');
    expect(result).toBe('arn:aws:s3:::my-bucket');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns DomainName from bucket name', async () => {
    const result = await provider.getAttribute('my-bucket', 'AWS::S3::Bucket', 'DomainName');
    expect(result).toBe('my-bucket.s3.amazonaws.com');
  });

  it('returns RegionalDomainName from bucket name + region', async () => {
    const result = await provider.getAttribute(
      'my-bucket',
      'AWS::S3::Bucket',
      'RegionalDomainName'
    );
    expect(result).toBe('my-bucket.s3.us-east-1.amazonaws.com');
  });

  it('returns DualStackDomainName from bucket name + region', async () => {
    const result = await provider.getAttribute(
      'my-bucket',
      'AWS::S3::Bucket',
      'DualStackDomainName'
    );
    expect(result).toBe('my-bucket.s3.dualstack.us-east-1.amazonaws.com');
  });

  it('returns WebsiteURL from bucket name + region', async () => {
    const result = await provider.getAttribute('my-bucket', 'AWS::S3::Bucket', 'WebsiteURL');
    expect(result).toBe('http://my-bucket.s3-website-us-east-1.amazonaws.com');
  });

  it('returns undefined for unknown attribute', async () => {
    const result = await provider.getAttribute('my-bucket', 'AWS::S3::Bucket', 'Unknown');
    expect(result).toBeUndefined();
  });
});
