import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS clients before importing the provider
const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

describe('CustomResourceProvider', () => {
  let provider: CustomResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CustomResourceProvider({
      responseBucket: 'test-bucket',
    });
  });

  describe('isSnsServiceToken', () => {
    it('should return true for SNS topic ARNs', () => {
      expect(
        provider.isSnsServiceToken('arn:aws:sns:us-east-1:123456789012:my-topic')
      ).toBe(true);
    });

    it('should return true for SNS ARNs in different regions', () => {
      expect(
        provider.isSnsServiceToken('arn:aws:sns:ap-northeast-1:123456789012:custom-resource-topic')
      ).toBe(true);
    });

    it('should return false for Lambda function ARNs', () => {
      expect(
        provider.isSnsServiceToken(
          'arn:aws:lambda:us-east-1:123456789012:function:my-function'
        )
      ).toBe(false);
    });

    it('should return false for Lambda function names', () => {
      expect(provider.isSnsServiceToken('my-function-name')).toBe(false);
    });

    it('should return false for partial Lambda ARNs', () => {
      expect(
        provider.isSnsServiceToken('arn:aws:lambda:us-east-1:123456789012:function:handler')
      ).toBe(false);
    });
  });

  describe('create with Lambda ServiceToken', () => {
    it('should invoke Lambda and return result from direct payload', async () => {
      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Lambda invoke returns direct response
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from(
          JSON.stringify({
            PhysicalResourceId: 'custom-phys-id-123',
            Data: { Attr1: 'value1' },
          })
        ),
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await provider.create('MyCustom', 'Custom::MyResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
      });

      expect(result.physicalId).toBe('custom-phys-id-123');
      expect(result.attributes).toEqual({ Attr1: 'value1' });
      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
      expect(mockSnsSend).not.toHaveBeenCalled();
    });
  });

  describe('create with SNS ServiceToken', () => {
    it('should publish to SNS topic and poll S3 for response', async () => {
      const snsTopicArn = 'arn:aws:sns:us-east-1:123456789012:my-custom-resource-topic';

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // SNS publish succeeds
      mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-123' });

      // S3 GetObject returns response on first poll
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'sns-custom-id-456',
                Data: { Output1: 'result' },
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await provider.create('MySnsCustom', 'Custom::SnsResource', {
        ServiceToken: snsTopicArn,
      });

      expect(result.physicalId).toBe('sns-custom-id-456');
      expect(result.attributes).toEqual({ Output1: 'result' });
      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });

    it('should throw ProvisioningError when SNS-backed custom resource fails', async () => {
      const snsTopicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // SNS publish succeeds
      mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-456' });

      // S3 GetObject returns FAILED response
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'FAILED',
                Reason: 'Something went wrong',
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      await expect(
        provider.create('MyFailingSns', 'Custom::SnsResource', {
          ServiceToken: snsTopicArn,
        })
      ).rejects.toThrow('Failed to create custom resource MyFailingSns');
    });
  });

  describe('delete with SNS ServiceToken', () => {
    it('should publish delete request to SNS topic', async () => {
      const snsTopicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // SNS publish succeeds
      mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-789' });

      // S3 GetObject returns success response
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'sns-custom-id-456',
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      await provider.delete('MySnsCustom', 'sns-custom-id-456', 'Custom::SnsResource', {
        ServiceToken: snsTopicArn,
      });

      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });
  });

  describe('update with SNS ServiceToken', () => {
    it('should publish update request to SNS topic', async () => {
      const snsTopicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // SNS publish succeeds
      mockSnsSend.mockResolvedValueOnce({ MessageId: 'msg-update' });

      // S3 GetObject returns success response with same physical ID
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'sns-custom-id-456',
                Data: { UpdatedAttr: 'new-value' },
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await provider.update(
        'MySnsCustom',
        'sns-custom-id-456',
        'Custom::SnsResource',
        { ServiceToken: snsTopicArn, Prop1: 'new' },
        { ServiceToken: snsTopicArn, Prop1: 'old' }
      );

      expect(result.physicalId).toBe('sns-custom-id-456');
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({ UpdatedAttr: 'new-value' });
      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(mockLambdaSend).not.toHaveBeenCalled();
    });
  });

  describe('async Provider framework (isCompleteHandler pattern)', () => {
    it('should detect async pattern when Lambda returns null payload and poll S3 with longer timeout', async () => {
      // Use a short async timeout for testing
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 10_000,
      });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Lambda invoke returns null (CDK Provider framework starts Step Functions and returns nothing)
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from('null'),
      });

      // S3 GetObject: first poll returns empty (Step Functions still running)
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () => Promise.resolve(''),
        },
      });

      // S3 GetObject: second poll returns the response (Step Functions completed)
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'async-resource-123',
                Data: { AsyncResult: 'completed' },
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await asyncProvider.create('MyAsyncCustom', 'Custom::AsyncResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
      });

      expect(result.physicalId).toBe('async-resource-123');
      expect(result.attributes).toEqual({ AsyncResult: 'completed' });
      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    });

    it('should detect async pattern when Lambda returns empty object', async () => {
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 10_000,
      });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Lambda invoke returns empty object (no PhysicalResourceId, no Status, no Data)
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from(JSON.stringify({})),
      });

      // S3 GetObject returns response immediately
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'async-resource-456',
                Data: { Output: 'done' },
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await asyncProvider.create('MyAsyncCustom2', 'Custom::AsyncResource', {
        ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
      });

      expect(result.physicalId).toBe('async-resource-456');
      expect(result.attributes).toEqual({ Output: 'done' });
    });

    it('should handle async FAILED response from Step Functions', async () => {
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 10_000,
      });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Lambda invoke returns null (async pattern)
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from('null'),
      });

      // S3 GetObject returns FAILED (Step Functions timed out or isComplete failed)
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'FAILED',
                Reason: 'Operation timed out',
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      await expect(
        asyncProvider.create('MyFailingAsync', 'Custom::AsyncResource', {
          ServiceToken:
            'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
        })
      ).rejects.toThrow('Custom resource handler returned FAILED: Operation timed out');
    });

    it('should use configurable async timeout', async () => {
      // Very short timeout to trigger timeout quickly
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 100,
      });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Lambda invoke returns null (async pattern)
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from('null'),
      });

      // S3 GetObject keeps returning empty (Step Functions never completes)
      mockS3Send.mockImplementation(() =>
        Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(''),
          },
        })
      );

      await expect(
        asyncProvider.create('MyTimedOutAsync', 'Custom::AsyncResource', {
          ServiceToken:
            'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
        })
      ).rejects.toThrow(
        /Timeout waiting for custom resource response.*Provider framework with isCompleteHandler/
      );
    });

    it('should handle update with async Provider framework', async () => {
      const asyncProvider = new CustomResourceProvider({
        responseBucket: 'test-bucket',
        asyncResponseTimeoutMs: 10_000,
      });

      // S3 PutObject for placeholder
      mockS3Send.mockResolvedValueOnce({});

      // Lambda invoke returns null (async pattern)
      mockLambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from('null'),
      });

      // S3 GetObject returns success response
      mockS3Send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                Status: 'SUCCESS',
                PhysicalResourceId: 'async-resource-123',
                Data: { UpdatedOutput: 'new-value' },
              })
            ),
        },
      });

      // S3 DeleteObject for cleanup
      mockS3Send.mockResolvedValueOnce({});

      const result = await asyncProvider.update(
        'MyAsyncCustom',
        'async-resource-123',
        'Custom::AsyncResource',
        {
          ServiceToken:
            'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
          Prop: 'new',
        },
        {
          ServiceToken:
            'arn:aws:lambda:us-east-1:123456789012:function:provider-framework-onEvent',
          Prop: 'old',
        }
      );

      expect(result.physicalId).toBe('async-resource-123');
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({ UpdatedOutput: 'new-value' });
    });
  });
});
