import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DescribeStreamCommand, ResourceNotFoundException } from '@aws-sdk/client-kinesis';

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

import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';

describe('KinesisStreamProvider.readCurrentState', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new KinesisStreamProvider();
  });

  it('returns CFn-shaped properties from DescribeStream (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      StreamDescription: {
        StreamName: 'mystream',
        StreamModeDetails: { StreamMode: 'PROVISIONED' },
        Shards: [{ ShardId: 's-1' }, { ShardId: 's-2' }],
        RetentionPeriodHours: 48,
        EncryptionType: 'KMS',
        KeyId: 'arn:aws:kms:us-east-1:1:key/abc',
      },
    });

    const result = await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeStreamCommand);
    expect(result).toEqual({
      Name: 'mystream',
      StreamModeDetails: { StreamMode: 'PROVISIONED' },
      ShardCount: 2,
      RetentionPeriodHours: 48,
      StreamEncryption: { EncryptionType: 'KMS', KeyId: 'arn:aws:kms:us-east-1:1:key/abc' },
    });
  });

  it('omits StreamEncryption when EncryptionType=NONE', async () => {
    mockSend.mockResolvedValueOnce({
      StreamDescription: {
        StreamName: 'mystream',
        StreamModeDetails: { StreamMode: 'ON_DEMAND' },
        Shards: [],
        RetentionPeriodHours: 24,
        EncryptionType: 'NONE',
      },
    });

    const result = await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream');

    expect(result).toEqual({
      Name: 'mystream',
      StreamModeDetails: { StreamMode: 'ON_DEMAND' },
      RetentionPeriodHours: 24,
    });
  });

  it('returns undefined when stream is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );
    const result = await provider.readCurrentState('mystream', 'L', 'AWS::Kinesis::Stream');
    expect(result).toBeUndefined();
  });
});
