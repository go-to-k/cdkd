import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';

const TYPE = 'AWS::Kinesis::StreamConsumer';
const STREAM_ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/mystream';
const CONSUMER_ARN = `${STREAM_ARN}/consumer/myconsumer:1700000000`;
const PROPS = { ConsumerName: 'myconsumer', StreamARN: STREAM_ARN };

async function createError(provider: KinesisStreamConsumerProvider, props = PROPS): Promise<unknown> {
  return provider.create('Consumer', TYPE, props).then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

describe('KinesisStreamConsumerProvider create marks a created-before-failure consumer (#4583)', () => {
  let provider: KinesisStreamConsumerProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new KinesisStreamConsumerProvider();
  });

  it('marks the consumer ARN when the ACTIVE wait fails after RegisterStreamConsumer returned', async () => {
    mockSend.mockResolvedValueOnce({
      Consumer: { ConsumerARN: CONSUMER_ARN, ConsumerName: 'myconsumer', ConsumerStatus: 'CREATING' },
    });
    mockSend.mockRejectedValueOnce(new Error('LimitExceededException: rate exceeded'));
    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'Consumer', TYPE)).toBe(CONSUMER_ARN);
  });

  it('leaves no mark when RegisterStreamConsumer itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('ResourceInUseException: already registered'));
    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'Consumer', TYPE)).toBeUndefined();
  });

  it('leaves no mark when RegisterStreamConsumer returns no ARN', async () => {
    mockSend.mockResolvedValueOnce({ Consumer: {} });
    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'Consumer', TYPE)).toBeUndefined();
  });

  it('leaves no mark on the pre-flight missing-StreamARN refusal', async () => {
    const error = await createError(provider, { ConsumerName: 'myconsumer' } as typeof PROPS);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Consumer', TYPE)).toBeUndefined();
  });

  it('reports the consumer ARN to the sink before the ACTIVE wait (#5511)', async () => {
    const sink = new CreatedResourceSink('Consumer', TYPE);
    let reportAtWait: unknown = 'not-called';
    mockSend.mockResolvedValueOnce({
      Consumer: { ConsumerARN: CONSUMER_ARN, ConsumerName: 'myconsumer', ConsumerStatus: 'CREATING' },
    });
    mockSend.mockImplementationOnce(() => {
      reportAtWait = sink.report;
      return Promise.reject(new Error('LimitExceededException: rate exceeded'));
    });
    await expect(
      collectCreatedResources(sink, () => provider.create('Consumer', TYPE, PROPS))
    ).rejects.toThrow();
    expect(reportAtWait).toEqual({ physicalId: CONSUMER_ARN });
    expect(sink.report).toEqual({ physicalId: CONSUMER_ARN });
  });

  it('reports nothing when RegisterStreamConsumer itself fails (#5511)', async () => {
    const sink = new CreatedResourceSink('Consumer', TYPE);
    mockSend.mockRejectedValueOnce(new Error('ResourceInUseException: already registered'));
    await expect(
      collectCreatedResources(sink, () => provider.create('Consumer', TYPE, PROPS))
    ).rejects.toThrow();
    expect(sink.report).toBeUndefined();
  });
});
