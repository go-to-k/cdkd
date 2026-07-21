import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-firehose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-firehose')>();
  return {
    ...actual,
    FirehoseClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
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

import { FirehoseProvider } from '../../../../src/provisioning/providers/firehose-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../../src/utils/error-handler.js';

describe('FirehoseProvider', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
  });

  describe('create', () => {
    it('should create delivery stream with S3DestinationConfiguration (BucketArn→BucketARN, RoleArn→RoleARN mapping)', async () => {
      mockSend
        .mockResolvedValueOnce({
          DeliveryStreamARN: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/test-stream',
        })
        .mockResolvedValueOnce({
          DeliveryStreamDescription: { DeliveryStreamStatus: 'ACTIVE' },
        });

      const result = await provider.create(
        'MyDeliveryStream',
        'AWS::KinesisFirehose::DeliveryStream',
        {
          DeliveryStreamName: 'test-stream',
          S3DestinationConfiguration: {
            BucketArn: 'arn:aws:s3:::my-bucket',
            RoleArn: 'arn:aws:iam::123456789012:role/my-role',
            Prefix: 'logs/',
          },
        }
      );

      expect(result.physicalId).toBe('test-stream');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/test-stream',
      });
      expect(mockSend).toHaveBeenCalledTimes(2);

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.constructor.name).toBe('CreateDeliveryStreamCommand');
      expect(cmd.input.DeliveryStreamName).toBe('test-stream');
      expect(cmd.input.S3DestinationConfiguration.BucketARN).toBe('arn:aws:s3:::my-bucket');
      expect(cmd.input.S3DestinationConfiguration.RoleARN).toBe(
        'arn:aws:iam::123456789012:role/my-role'
      );
      expect(cmd.input.S3DestinationConfiguration.Prefix).toBe('logs/');
    });

    it('should create delivery stream with ExtendedS3DestinationConfiguration', async () => {
      mockSend
        .mockResolvedValueOnce({
          DeliveryStreamARN: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/ext-stream',
        })
        .mockResolvedValueOnce({
          DeliveryStreamDescription: { DeliveryStreamStatus: 'ACTIVE' },
        });

      const result = await provider.create(
        'MyExtStream',
        'AWS::KinesisFirehose::DeliveryStream',
        {
          DeliveryStreamName: 'ext-stream',
          ExtendedS3DestinationConfiguration: {
            BucketArn: 'arn:aws:s3:::my-ext-bucket',
            RoleArn: 'arn:aws:iam::123456789012:role/ext-role',
            Prefix: 'data/',
            CompressionFormat: 'GZIP',
            BufferingHints: {
              SizeInMBs: 64,
              IntervalInSeconds: 300,
            },
          },
        }
      );

      expect(result.physicalId).toBe('ext-stream');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/ext-stream',
      });

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.constructor.name).toBe('CreateDeliveryStreamCommand');
      expect(cmd.input.ExtendedS3DestinationConfiguration.BucketARN).toBe(
        'arn:aws:s3:::my-ext-bucket'
      );
      expect(cmd.input.ExtendedS3DestinationConfiguration.RoleARN).toBe(
        'arn:aws:iam::123456789012:role/ext-role'
      );
      expect(cmd.input.ExtendedS3DestinationConfiguration.Prefix).toBe('data/');
      expect(cmd.input.ExtendedS3DestinationConfiguration.CompressionFormat).toBe('GZIP');
      expect(cmd.input.ExtendedS3DestinationConfiguration.BufferingHints).toEqual({
        SizeInMBs: 64,
        IntervalInSeconds: 300,
      });
    });

    it('should create delivery stream with KinesisStreamSourceConfiguration', async () => {
      mockSend
        .mockResolvedValueOnce({
          DeliveryStreamARN:
            'arn:aws:firehose:us-east-1:123456789012:deliverystream/kinesis-stream',
        })
        .mockResolvedValueOnce({
          DeliveryStreamDescription: { DeliveryStreamStatus: 'ACTIVE' },
        });

      const result = await provider.create(
        'MyKinesisStream',
        'AWS::KinesisFirehose::DeliveryStream',
        {
          DeliveryStreamName: 'kinesis-stream',
          DeliveryStreamType: 'KinesisStreamAsSource',
          KinesisStreamSourceConfiguration: {
            KinesisStreamArn: 'arn:aws:kinesis:us-east-1:123456789012:stream/my-kinesis',
            RoleArn: 'arn:aws:iam::123456789012:role/kinesis-role',
          },
        }
      );

      expect(result.physicalId).toBe('kinesis-stream');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/kinesis-stream',
      });

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.DeliveryStreamType).toBe('KinesisStreamAsSource');
      expect(cmd.input.KinesisStreamSourceConfiguration.KinesisStreamARN).toBe(
        'arn:aws:kinesis:us-east-1:123456789012:stream/my-kinesis'
      );
      expect(cmd.input.KinesisStreamSourceConfiguration.RoleARN).toBe(
        'arn:aws:iam::123456789012:role/kinesis-role'
      );
    });
  });

  describe('update', () => {
    // After #549's bundle PR closes the 7 follow-ups, every modern
    // destination type has an in-place reverse-mapper. Only the legacy
    // `S3DestinationConfiguration` (deprecated by AWS in favor of
    // ExtendedS3) still hits the rejection path. Detailed roundtrip
    // coverage for every supported destination lives in
    // firehose-provider-roundtrip.test.ts; this test pins the residual
    // rejection.
    it('still rejects unsupported destination diffs with ResourceUpdateNotSupportedError', async () => {
      await expect(
        provider.update(
          'MyDeliveryStream',
          'test-stream',
          'AWS::KinesisFirehose::DeliveryStream',
          {
            DeliveryStreamName: 'test-stream',
            S3DestinationConfiguration: {
              BucketARN: 'arn:aws:s3:::bucket-v2',
              RoleARN: 'arn:aws:iam::111:role/firehose-role',
            },
          },
          {
            DeliveryStreamName: 'test-stream',
            S3DestinationConfiguration: {
              BucketARN: 'arn:aws:s3:::bucket-v1',
              RoleARN: 'arn:aws:iam::111:role/firehose-role',
            },
          }
        )
      ).rejects.toThrow(ResourceUpdateNotSupportedError);
    });
  });

  describe('delete', () => {
    it('should delete delivery stream', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete(
        'MyDeliveryStream',
        'test-stream',
        'AWS::KinesisFirehose::DeliveryStream'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.constructor.name).toBe('DeleteDeliveryStreamCommand');
      expect(cmd.input.DeliveryStreamName).toBe('test-stream');
    });

    it('should handle ResourceNotFoundException gracefully (idempotent)', async () => {
      const { ResourceNotFoundException } = await import('@aws-sdk/client-firehose');
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({
          $metadata: {},
          message: 'Delivery stream not found',
        })
      );

      // Should not throw
      await provider.delete(
        'MyDeliveryStream',
        'test-stream',
        'AWS::KinesisFirehose::DeliveryStream'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyDeliveryStream',
        resourceType: 'AWS::KinesisFirehose::DeliveryStream',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    it('explicit override: DescribeDeliveryStream verifies and returns the name', async () => {
      mockSend.mockResolvedValueOnce({
        DeliveryStreamDescription: { DeliveryStreamName: 'adopted' },
      });

      const result = await provider.import(makeInput({ knownPhysicalId: 'adopted' }));

      expect(result).toEqual({ physicalId: 'adopted', attributes: {} });
      const call = mockSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('DescribeDeliveryStreamCommand');
      expect(call.input).toEqual({ DeliveryStreamName: 'adopted' });
    });

    // The `aws:cdk:path` tag walk was removed (issue #1134): AWS rejects
    // `aws:`-prefixed tag writes, so the tag never exists on a real stream.
    // With no explicit id, import returns null without issuing any AWS call.
    it('returns null without any AWS call when only cdkPath is given', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
