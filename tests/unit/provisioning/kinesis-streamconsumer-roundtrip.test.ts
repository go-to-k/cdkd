import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RegisterStreamConsumerCommand,
  DeregisterStreamConsumerCommand,
  DescribeStreamConsumerCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-kinesis';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-kinesis', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-kinesis')>(
    '@aws-sdk/client-kinesis'
  );
  return {
    ...actual,
    KinesisClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import { KinesisStreamConsumerProvider } from '../../../src/provisioning/providers/kinesis-streamconsumer-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const STREAM_ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/mystream';
const CONSUMER_NAME = 'myconsumer';
const CONSUMER_ARN = `${STREAM_ARN}/consumer/${CONSUMER_NAME}:1700000000`;

describe('KinesisStreamConsumerProvider', () => {
  let provider: KinesisStreamConsumerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new KinesisStreamConsumerProvider();
  });

  // ─── create ────────────────────────────────────────────────────────

  describe('create', () => {
    it('registers a consumer and waits for ACTIVE', async () => {
      mockSend
        .mockResolvedValueOnce({
          // RegisterStreamConsumer
          Consumer: {
            ConsumerName: CONSUMER_NAME,
            ConsumerARN: CONSUMER_ARN,
            ConsumerStatus: 'CREATING',
            ConsumerCreationTimestamp: new Date('2026-01-01T00:00:00Z'),
          },
        })
        .mockResolvedValueOnce({
          // DescribeStreamConsumer (waitForConsumerActive)
          ConsumerDescription: {
            ConsumerName: CONSUMER_NAME,
            ConsumerARN: CONSUMER_ARN,
            ConsumerStatus: 'ACTIVE',
            ConsumerCreationTimestamp: new Date('2026-01-01T00:00:00Z'),
            StreamARN: STREAM_ARN,
          },
        });

      const result = await provider.create('LogicalId', 'AWS::Kinesis::StreamConsumer', {
        ConsumerName: CONSUMER_NAME,
        StreamARN: STREAM_ARN,
      });

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(RegisterStreamConsumerCommand);
      const reg = mockSend.mock.calls[0]?.[0] as RegisterStreamConsumerCommand;
      expect(reg.input).toEqual({
        StreamARN: STREAM_ARN,
        ConsumerName: CONSUMER_NAME,
      });
      expect(result.physicalId).toBe(CONSUMER_ARN);
      expect(result.attributes?.ConsumerARN).toBe(CONSUMER_ARN);
      expect(result.attributes?.Id).toBe(CONSUMER_ARN);
      expect(result.attributes?.StreamARN).toBe(STREAM_ARN);
    });

    it('passes Tags to RegisterStreamConsumer when provided', async () => {
      mockSend
        .mockResolvedValueOnce({
          Consumer: {
            ConsumerName: CONSUMER_NAME,
            ConsumerARN: CONSUMER_ARN,
            ConsumerStatus: 'CREATING',
            ConsumerCreationTimestamp: new Date(),
          },
        })
        .mockResolvedValueOnce({
          ConsumerDescription: {
            ConsumerName: CONSUMER_NAME,
            ConsumerARN: CONSUMER_ARN,
            ConsumerStatus: 'ACTIVE',
            StreamARN: STREAM_ARN,
          },
        });

      await provider.create('LogicalId', 'AWS::Kinesis::StreamConsumer', {
        ConsumerName: CONSUMER_NAME,
        StreamARN: STREAM_ARN,
        Tags: [
          { Key: 'Env', Value: 'prod' },
          { Key: 'Owner', Value: 'team-x' },
        ],
      });

      const reg = mockSend.mock.calls[0]?.[0] as RegisterStreamConsumerCommand;
      expect(reg.input).toEqual({
        StreamARN: STREAM_ARN,
        ConsumerName: CONSUMER_NAME,
        Tags: { Env: 'prod', Owner: 'team-x' },
      });
    });

    it('rejects when ConsumerName is missing', async () => {
      await expect(
        provider.create('LogicalId', 'AWS::Kinesis::StreamConsumer', {
          StreamARN: STREAM_ARN,
        })
      ).rejects.toThrow(/requires ConsumerName/);
    });

    it('rejects when StreamARN is missing', async () => {
      await expect(
        provider.create('LogicalId', 'AWS::Kinesis::StreamConsumer', {
          ConsumerName: CONSUMER_NAME,
        })
      ).rejects.toThrow(/requires StreamARN/);
    });
  });

  // ─── update ────────────────────────────────────────────────────────

  describe('update', () => {
    it('rejects ConsumerName diff with ResourceUpdateNotSupportedError', async () => {
      await expect(
        provider.update('LogicalId', CONSUMER_ARN, 'AWS::Kinesis::StreamConsumer',
          { ConsumerName: 'new-name', StreamARN: STREAM_ARN },
          { ConsumerName: 'old-name', StreamARN: STREAM_ARN }
        )
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    });

    it('rejects StreamARN diff with ResourceUpdateNotSupportedError', async () => {
      await expect(
        provider.update('LogicalId', CONSUMER_ARN, 'AWS::Kinesis::StreamConsumer',
          { ConsumerName: CONSUMER_NAME, StreamARN: 'arn:aws:kinesis:us-east-1:1:stream/other' },
          { ConsumerName: CONSUMER_NAME, StreamARN: STREAM_ARN }
        )
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    });

    it('applies Tags add via TagResource and finishes successfully', async () => {
      mockSend
        // TagResource
        .mockResolvedValueOnce({})
        // DescribeStreamConsumer for attribute refresh
        .mockResolvedValueOnce({
          ConsumerDescription: {
            ConsumerName: CONSUMER_NAME,
            ConsumerARN: CONSUMER_ARN,
            ConsumerStatus: 'ACTIVE',
            StreamARN: STREAM_ARN,
          },
        });

      const result = await provider.update(
        'LogicalId',
        CONSUMER_ARN,
        'AWS::Kinesis::StreamConsumer',
        {
          ConsumerName: CONSUMER_NAME,
          StreamARN: STREAM_ARN,
          Tags: [{ Key: 'Env', Value: 'prod' }],
        },
        {
          ConsumerName: CONSUMER_NAME,
          StreamARN: STREAM_ARN,
          Tags: [],
        }
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(TagResourceCommand);
      const tag = mockSend.mock.calls[0]?.[0] as TagResourceCommand;
      expect(tag.input).toEqual({ ResourceARN: CONSUMER_ARN, Tags: { Env: 'prod' } });
      expect(result.wasReplaced).toBe(false);
      expect(result.physicalId).toBe(CONSUMER_ARN);
    });

    it('applies Tags remove via UntagResource', async () => {
      mockSend
        .mockResolvedValueOnce({}) // UntagResource
        .mockResolvedValueOnce({
          ConsumerDescription: {
            ConsumerName: CONSUMER_NAME,
            ConsumerARN: CONSUMER_ARN,
            ConsumerStatus: 'ACTIVE',
            StreamARN: STREAM_ARN,
          },
        });

      await provider.update(
        'LogicalId',
        CONSUMER_ARN,
        'AWS::Kinesis::StreamConsumer',
        {
          ConsumerName: CONSUMER_NAME,
          StreamARN: STREAM_ARN,
          Tags: [],
        },
        {
          ConsumerName: CONSUMER_NAME,
          StreamARN: STREAM_ARN,
          Tags: [{ Key: 'Env', Value: 'prod' }],
        }
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(UntagResourceCommand);
      const untag = mockSend.mock.calls[0]?.[0] as UntagResourceCommand;
      expect(untag.input).toEqual({ ResourceARN: CONSUMER_ARN, TagKeys: ['Env'] });
    });

    it('no-op (no Tags / no changes) makes no Tag/Untag SDK calls', async () => {
      // The only SDK call should be the trailing DescribeStreamConsumer.
      mockSend.mockResolvedValueOnce({
        ConsumerDescription: {
          ConsumerName: CONSUMER_NAME,
          ConsumerARN: CONSUMER_ARN,
          ConsumerStatus: 'ACTIVE',
          StreamARN: STREAM_ARN,
        },
      });

      await provider.update(
        'LogicalId',
        CONSUMER_ARN,
        'AWS::Kinesis::StreamConsumer',
        { ConsumerName: CONSUMER_NAME, StreamARN: STREAM_ARN, Tags: [] },
        { ConsumerName: CONSUMER_NAME, StreamARN: STREAM_ARN, Tags: [] }
      );

      expect(
        mockSend.mock.calls.find((c) => c[0] instanceof TagResourceCommand)
      ).toBeUndefined();
      expect(
        mockSend.mock.calls.find((c) => c[0] instanceof UntagResourceCommand)
      ).toBeUndefined();
    });
  });

  // ─── delete ────────────────────────────────────────────────────────

  describe('delete', () => {
    it('issues DeregisterStreamConsumer with ConsumerARN', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('LogicalId', CONSUMER_ARN, 'AWS::Kinesis::StreamConsumer');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DeregisterStreamConsumerCommand);
      const dereg = mockSend.mock.calls[0]?.[0] as DeregisterStreamConsumerCommand;
      expect(dereg.input).toEqual({ ConsumerARN: CONSUMER_ARN });
    });

    it('treats ResourceNotFoundException as idempotent success when region matches', async () => {
      const err = new ResourceNotFoundException({
        message: 'gone',
        $metadata: {},
      });
      mockSend.mockRejectedValueOnce(err);

      await expect(
        provider.delete(
          'LogicalId',
          CONSUMER_ARN,
          'AWS::Kinesis::StreamConsumer',
          {},
          { expectedRegion: 'us-east-1' }
        )
      ).resolves.toBeUndefined();
    });
  });

  // ─── readCurrentState ──────────────────────────────────────────────

  describe('readCurrentState', () => {
    it('returns CFn-shaped properties from DescribeStreamConsumer + ListTagsForResource', async () => {
      mockSend
        .mockResolvedValueOnce({
          ConsumerDescription: {
            ConsumerName: CONSUMER_NAME,
            ConsumerARN: CONSUMER_ARN,
            ConsumerStatus: 'ACTIVE',
            ConsumerCreationTimestamp: new Date(),
            StreamARN: STREAM_ARN,
          },
        })
        .mockResolvedValueOnce({
          Tags: [
            { Key: 'Env', Value: 'prod' },
            // aws:cdk:path should be filtered out by normalizeAwsTagsToCfn.
            { Key: 'aws:cdk:path', Value: 'MyStack/Consumer' },
          ],
        });

      const result = await provider.readCurrentState(
        CONSUMER_ARN,
        'LogicalId',
        'AWS::Kinesis::StreamConsumer'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeStreamConsumerCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
      expect(result).toEqual({
        ConsumerName: CONSUMER_NAME,
        StreamARN: STREAM_ARN,
        Tags: [{ Key: 'Env', Value: 'prod' }],
      });
    });

    it('always emits Tags: [] placeholder when AWS reports no user tags', async () => {
      mockSend
        .mockResolvedValueOnce({
          ConsumerDescription: {
            ConsumerName: CONSUMER_NAME,
            ConsumerARN: CONSUMER_ARN,
            ConsumerStatus: 'ACTIVE',
            ConsumerCreationTimestamp: new Date(),
            StreamARN: STREAM_ARN,
          },
        })
        .mockResolvedValueOnce({ Tags: [] });

      const result = await provider.readCurrentState(
        CONSUMER_ARN,
        'LogicalId',
        'AWS::Kinesis::StreamConsumer'
      );

      expect(result?.['Tags']).toEqual([]);
    });

    it('returns undefined on ResourceNotFoundException', async () => {
      const err = new ResourceNotFoundException({ message: 'gone', $metadata: {} });
      mockSend.mockRejectedValueOnce(err);

      const result = await provider.readCurrentState(
        CONSUMER_ARN,
        'LogicalId',
        'AWS::Kinesis::StreamConsumer'
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined for unrelated resource types', async () => {
      const result = await provider.readCurrentState(
        'something',
        'LogicalId',
        'AWS::Kinesis::Stream'
      );
      expect(result).toBeUndefined();
      // No SDK call should fire.
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
