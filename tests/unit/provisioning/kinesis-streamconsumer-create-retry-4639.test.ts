import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: Kinesis `RegisterStreamConsumer` calls carry no idempotency token, so the AWS SDK's own
// retry of a 5xx whose request had succeeded replayed them inside ONE `send`
// and collided with what the first send made. That "already exists" surfaced
// from the engine's first attempt and read as a name somebody else holds.

vi.mock('@aws-sdk/client-kinesis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kinesis')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    KinesisClient: vi
      .fn()
      .mockImplementation((cfg?: Parameters<typeof sdkClientStandIn>[0]) => sdkClientStandIn(cfg)),
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

import { ResourceInUseException } from '@aws-sdk/client-kinesis';
import { KinesisStreamConsumerProvider } from '../../../src/provisioning/providers/kinesis-streamconsumer-provider.js';
import { topLevel, type NamedCreate } from './data-create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './data-create-retry-4639-suite.js';

const STREAM = 'arn:aws:kinesis:eu-west-3:123456789012:stream/orders';

const CREATES: Record<string, NamedCreate> = {
  RegisterStreamConsumerCommand: {
    nameOf: topLevel('ConsumerName'),
    collision: (n) =>
      new ResourceInUseException({
        message: `Consumer ${n} under stream orders already exists for account 123456789012.`,
        $metadata: { httpStatusCode: 400 },
      }),
    response: (n) => ({ Consumer: { ConsumerARN: `${STREAM}/consumer/${n}:1`, ConsumerName: n } }),
  },
};

const SITES: CreateSite[] = [
  {
    type: 'AWS::Kinesis::StreamConsumer',
    command: 'RegisterStreamConsumerCommand',
    name: 'orders-consumer',
    physicalId: `${STREAM}/consumer/orders-consumer:1700000000`,
    props: { StreamARN: STREAM, ConsumerName: 'orders-consumer' },
    provider: () => new KinesisStreamConsumerProvider(),
    prose: true,
    postCreateCalls: true,
    successResponses: {
      // `waitForConsumerActive` polls until ACTIVE.
      DescribeStreamConsumerCommand: {
        ConsumerDescription: {
          ConsumerName: 'orders-consumer',
          ConsumerARN: `${STREAM}/consumer/orders-consumer:1`,
          ConsumerStatus: 'ACTIVE',
          StreamARN: STREAM,
        },
      },
    },
  },
];

describeCreateRetrySafety(SITES, CREATES);
