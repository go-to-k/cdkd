import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeDeliveryStreamCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-firehose';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-firehose', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-firehose')>(
    '@aws-sdk/client-firehose'
  );
  return {
    ...actual,
    FirehoseClient: vi.fn().mockImplementation(() => ({
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

import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';

describe('FirehoseProvider.readCurrentState', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
  });

  it('returns CFn-shaped properties from DescribeDeliveryStream (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      DeliveryStreamDescription: {
        DeliveryStreamName: 'mystream',
        DeliveryStreamType: 'KinesisStreamAsSource',
        Source: {
          KinesisStreamSourceDescription: {
            KinesisStreamARN: 'arn:aws:kinesis:us-east-1:1:stream/src',
            RoleARN: 'arn:aws:iam::1:role/r',
          },
        },
      },
    });

    const result = await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::KinesisFirehose::DeliveryStream'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeDeliveryStreamCommand);
    expect(result).toEqual({
      DeliveryStreamName: 'mystream',
      DeliveryStreamType: 'KinesisStreamAsSource',
      KinesisStreamSourceConfiguration: {
        KinesisStreamARN: 'arn:aws:kinesis:us-east-1:1:stream/src',
        RoleARN: 'arn:aws:iam::1:role/r',
      },
    });
  });

  it('returns undefined when stream is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );
    const result = await provider.readCurrentState(
      'mystream',
      'L',
      'AWS::KinesisFirehose::DeliveryStream'
    );
    expect(result).toBeUndefined();
  });
});
