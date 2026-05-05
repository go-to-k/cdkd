import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetCloudFrontOriginAccessIdentityCommand,
  NoSuchCloudFrontOriginAccessIdentity,
} from '@aws-sdk/client-cloudfront';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFront: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { CloudFrontOAIProvider } from '../../../src/provisioning/providers/cloudfront-oai-provider.js';

describe('CloudFrontOAIProvider.readCurrentState', () => {
  let provider: CloudFrontOAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudFrontOAIProvider();
  });

  it('returns CFn-shaped CloudFrontOriginAccessIdentityConfig.Comment (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      CloudFrontOriginAccessIdentity: {
        Id: 'E1ABCDEF',
        S3CanonicalUserId: 'aaaa',
        CloudFrontOriginAccessIdentityConfig: {
          CallerReference: 'OAILogical',
          Comment: 'my OAI',
        },
      },
    });

    const result = await provider.readCurrentState(
      'E1ABCDEF',
      'OAILogical',
      'AWS::CloudFront::CloudFrontOriginAccessIdentity'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetCloudFrontOriginAccessIdentityCommand);
    expect(result).toEqual({
      CloudFrontOriginAccessIdentityConfig: { Comment: 'my OAI' },
    });
  });

  it('returns undefined when OAI is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new NoSuchCloudFrontOriginAccessIdentity({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      'E1MISSING',
      'OAILogical',
      'AWS::CloudFront::CloudFrontOriginAccessIdentity'
    );

    expect(result).toBeUndefined();
  });
});
