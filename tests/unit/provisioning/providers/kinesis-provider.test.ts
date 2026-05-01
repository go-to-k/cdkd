import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-kinesis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kinesis')>();
  return {
    ...actual,
    KinesisClient: vi.fn().mockImplementation(() => ({
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

vi.mock('../../../../src/provisioning/resource-name.js', () => ({
  generateResourceName: vi.fn().mockReturnValue('generated-stream-name'),
}));

import {
  CreateStreamCommand,
  DeleteStreamCommand,
  DescribeStreamCommand,
  AddTagsToStreamCommand,
  UpdateShardCountCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis';
import { KinesisStreamProvider } from '../../../../src/provisioning/providers/kinesis-provider.js';

describe('KinesisStreamProvider', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new KinesisStreamProvider();
  });

  describe('create', () => {
    it('should create stream with PROVISIONED mode', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateStreamCommand) return Promise.resolve({});
        if (cmd instanceof DescribeStreamCommand)
          return Promise.resolve({
            StreamDescription: {
              StreamStatus: 'ACTIVE',
              StreamARN: 'arn:aws:kinesis:us-east-1:123456789012:stream/test-stream',
            },
          });
        return Promise.resolve({});
      });

      const result = await provider.create('MyStream', 'AWS::Kinesis::Stream', {
        Name: 'test-stream',
        ShardCount: 2,
      });

      expect(result.physicalId).toBe('test-stream');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:kinesis:us-east-1:123456789012:stream/test-stream',
      });

      const createCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof CreateStreamCommand
      );
      expect(createCall).toBeDefined();
      expect(createCall![0].input).toEqual({
        StreamName: 'test-stream',
        ShardCount: 2,
        StreamModeDetails: { StreamMode: 'PROVISIONED' },
      });
    });

    it('should create stream with tags', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateStreamCommand) return Promise.resolve({});
        if (cmd instanceof DescribeStreamCommand)
          return Promise.resolve({
            StreamDescription: {
              StreamStatus: 'ACTIVE',
              StreamARN: 'arn:aws:kinesis:us-east-1:123456789012:stream/tagged-stream',
            },
          });
        if (cmd instanceof AddTagsToStreamCommand) return Promise.resolve({});
        return Promise.resolve({});
      });

      const result = await provider.create('MyStream', 'AWS::Kinesis::Stream', {
        Name: 'tagged-stream',
        ShardCount: 1,
        Tags: [
          { Key: 'Environment', Value: 'test' },
          { Key: 'Project', Value: 'cdkd' },
        ],
      });

      expect(result.physicalId).toBe('tagged-stream');

      const addTagsCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof AddTagsToStreamCommand
      );
      expect(addTagsCall).toBeDefined();
      expect(addTagsCall![0].input).toEqual({
        StreamName: 'tagged-stream',
        Tags: { Environment: 'test', Project: 'cdkd' },
      });
    });

    it('should create stream with ON_DEMAND mode without ShardCount', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateStreamCommand) return Promise.resolve({});
        if (cmd instanceof DescribeStreamCommand)
          return Promise.resolve({
            StreamDescription: {
              StreamStatus: 'ACTIVE',
              StreamARN: 'arn:aws:kinesis:us-east-1:123456789012:stream/ondemand-stream',
            },
          });
        return Promise.resolve({});
      });

      const result = await provider.create('MyStream', 'AWS::Kinesis::Stream', {
        Name: 'ondemand-stream',
        StreamModeDetails: { StreamMode: 'ON_DEMAND' },
      });

      expect(result.physicalId).toBe('ondemand-stream');

      const createCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof CreateStreamCommand
      );
      expect(createCall).toBeDefined();
      // ON_DEMAND mode should NOT include ShardCount
      expect(createCall![0].input).toEqual({
        StreamName: 'ondemand-stream',
        StreamModeDetails: { StreamMode: 'ON_DEMAND' },
      });
    });

    it('should generate stream name when Name not provided', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateStreamCommand) return Promise.resolve({});
        if (cmd instanceof DescribeStreamCommand)
          return Promise.resolve({
            StreamDescription: {
              StreamStatus: 'ACTIVE',
              StreamARN:
                'arn:aws:kinesis:us-east-1:123456789012:stream/generated-stream-name',
            },
          });
        return Promise.resolve({});
      });

      const result = await provider.create('MyStream', 'AWS::Kinesis::Stream', {
        ShardCount: 1,
      });

      expect(result.physicalId).toBe('generated-stream-name');

      const createCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof CreateStreamCommand
      );
      expect(createCall![0].input.StreamName).toBe('generated-stream-name');
    });
  });

  describe('delete', () => {
    it('should delete stream with EnforceConsumerDeletion', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyStream', 'test-stream', 'AWS::Kinesis::Stream');

      expect(mockSend).toHaveBeenCalledTimes(1);

      const deleteCall = mockSend.mock.calls[0];
      expect(deleteCall[0]).toBeInstanceOf(DeleteStreamCommand);
      expect(deleteCall[0].input).toEqual({
        StreamName: 'test-stream',
        EnforceConsumerDeletion: true,
      });
    });

    it('should not throw when stream does not exist', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({
          $metadata: {},
          message: 'Stream not found',
        })
      );

      await expect(
        provider.delete('MyStream', 'test-stream', 'AWS::Kinesis::Stream')
      ).resolves.not.toThrow();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('should update shard count when changed', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof UpdateShardCountCommand) return Promise.resolve({});
        if (cmd instanceof DescribeStreamCommand)
          return Promise.resolve({
            StreamDescription: {
              StreamStatus: 'ACTIVE',
              StreamARN: 'arn:aws:kinesis:us-east-1:123456789012:stream/test-stream',
            },
          });
        return Promise.resolve({});
      });

      const result = await provider.update(
        'MyStream',
        'test-stream',
        'AWS::Kinesis::Stream',
        { ShardCount: 4 },
        { ShardCount: 2 }
      );

      expect(result.physicalId).toBe('test-stream');
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:kinesis:us-east-1:123456789012:stream/test-stream',
      });

      const updateCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof UpdateShardCountCommand
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0].input).toEqual({
        StreamName: 'test-stream',
        TargetShardCount: 4,
        ScalingType: 'UNIFORM_SCALING',
      });
    });
  });
});
