import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoSuchCloudFrontOriginAccessIdentity } from '@aws-sdk/client-cloudfront';

// Mock AWS clients before importing the provider
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

describe('CloudFrontOAIProvider', () => {
  let provider: CloudFrontOAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudFrontOAIProvider();
  });

  describe('create', () => {
    it('should create an OAI with Comment from config', async () => {
      mockSend.mockResolvedValueOnce({
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
          S3CanonicalUserId: 'abc123canonical',
        },
      });

      const result = await provider.create(
        'MyOAI',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: 'My OAI comment',
          },
        }
      );

      expect(result.physicalId).toBe('E1ABCDEF123456');
      expect(result.attributes).toEqual({
        Id: 'E1ABCDEF123456',
        S3CanonicalUserId: 'abc123canonical',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateCloudFrontOriginAccessIdentityCommand');
      expect(createCall.input.CloudFrontOriginAccessIdentityConfig.CallerReference).toBe('MyOAI');
      expect(createCall.input.CloudFrontOriginAccessIdentityConfig.Comment).toBe(
        'My OAI comment'
      );
    });

    it('should create an OAI with empty Comment when config is missing', async () => {
      mockSend.mockResolvedValueOnce({
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
          S3CanonicalUserId: 'abc123canonical',
        },
      });

      const result = await provider.create(
        'MyOAI',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        {}
      );

      expect(result.physicalId).toBe('E1ABCDEF123456');
      expect(mockSend).toHaveBeenCalledTimes(1);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.CloudFrontOriginAccessIdentityConfig.Comment).toBe('');
    });

    it('should use logicalId as CallerReference', async () => {
      mockSend.mockResolvedValueOnce({
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
          S3CanonicalUserId: 'abc123canonical',
        },
      });

      await provider.create('MyUniqueOAI', 'AWS::CloudFront::CloudFrontOriginAccessIdentity', {
        CloudFrontOriginAccessIdentityConfig: {
          Comment: 'test',
        },
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.CloudFrontOriginAccessIdentityConfig.CallerReference).toBe(
        'MyUniqueOAI'
      );
    });

    it('should throw ProvisioningError on failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.create('MyOAI', 'AWS::CloudFront::CloudFrontOriginAccessIdentity', {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: 'test',
          },
        })
      ).rejects.toThrow('Failed to create CloudFront OAI MyOAI');
    });
  });

  describe('update', () => {
    it('should return wasReplaced: false (no-op)', async () => {
      const result = await provider.update(
        'MyOAI',
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: 'new comment',
          },
        },
        {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: 'old comment',
          },
        }
      );

      expect(result.physicalId).toBe('E1ABCDEF123456');
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should get ETag and delete OAI', async () => {
      // GetCloudFrontOriginAccessIdentity
      mockSend.mockResolvedValueOnce({
        ETag: 'E2QWRUHAPOMQZL',
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
          S3CanonicalUserId: 'abc123canonical',
        },
      });
      // DeleteCloudFrontOriginAccessIdentity
      mockSend.mockResolvedValueOnce({});

      await provider.delete(
        'MyOAI',
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity'
      );

      expect(mockSend).toHaveBeenCalledTimes(2);

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetCloudFrontOriginAccessIdentityCommand');
      expect(getCall.input.Id).toBe('E1ABCDEF123456');

      const deleteCall = mockSend.mock.calls[1][0];
      expect(deleteCall.constructor.name).toBe('DeleteCloudFrontOriginAccessIdentityCommand');
      expect(deleteCall.input.Id).toBe('E1ABCDEF123456');
      expect(deleteCall.input.IfMatch).toBe('E2QWRUHAPOMQZL');
    });

    it('should skip deletion when OAI does not exist (on Get)', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchCloudFrontOriginAccessIdentity({
          $metadata: {},
          message: 'not found',
        })
      );

      await provider.delete(
        'MyOAI',
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should handle NoSuchCloudFrontOriginAccessIdentity during Delete gracefully', async () => {
      // GetCloudFrontOriginAccessIdentity
      mockSend.mockResolvedValueOnce({
        ETag: 'E2QWRUHAPOMQZL',
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
        },
      });
      // DeleteCloudFrontOriginAccessIdentity - already gone
      mockSend.mockRejectedValueOnce(
        new NoSuchCloudFrontOriginAccessIdentity({
          $metadata: {},
          message: 'not found',
        })
      );

      await provider.delete(
        'MyOAI',
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity'
      );

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should throw ProvisioningError on unexpected failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.delete(
          'MyOAI',
          'E1ABCDEF123456',
          'AWS::CloudFront::CloudFrontOriginAccessIdentity'
        )
      ).rejects.toThrow('Failed to delete CloudFront OAI MyOAI');
    });
  });

  describe('getAttribute', () => {
    it('should return physicalId for Id attribute', async () => {
      const id = await provider.getAttribute(
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        'Id'
      );

      expect(id).toBe('E1ABCDEF123456');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should fetch S3CanonicalUserId from API', async () => {
      mockSend.mockResolvedValueOnce({
        CloudFrontOriginAccessIdentity: {
          Id: 'E1ABCDEF123456',
          S3CanonicalUserId: 'abc123canonical',
        },
      });

      const userId = await provider.getAttribute(
        'E1ABCDEF123456',
        'AWS::CloudFront::CloudFrontOriginAccessIdentity',
        'S3CanonicalUserId'
      );

      expect(userId).toBe('abc123canonical');
      expect(mockSend).toHaveBeenCalledTimes(1);

      const getCall = mockSend.mock.calls[0][0];
      expect(getCall.constructor.name).toBe('GetCloudFrontOriginAccessIdentityCommand');
    });

    it('should throw for unsupported attribute', async () => {
      await expect(
        provider.getAttribute(
          'E1ABCDEF123456',
          'AWS::CloudFront::CloudFrontOriginAccessIdentity',
          'UnsupportedAttr'
        )
      ).rejects.toThrow('Unsupported attribute: UnsupportedAttr');
    });
  });
});
