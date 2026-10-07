import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: Firehose `CreateDeliveryStream` calls carry no idempotency token, so the AWS SDK's own
// retry of a 5xx whose request had succeeded replayed them inside ONE `send`
// and collided with what the first send made. That "already exists" surfaced
// from the engine's first attempt and read as a name somebody else holds.

vi.mock('@aws-sdk/client-firehose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-firehose')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    FirehoseClient: vi
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

import { ResourceInUseException } from '@aws-sdk/client-firehose';
import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';
import { topLevel, type NamedCreate } from './data-create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './data-create-retry-4639-suite.js';

const CREATES: Record<string, NamedCreate> = {
  CreateDeliveryStreamCommand: {
    nameOf: topLevel('DeliveryStreamName'),
    collision: (n) =>
      new ResourceInUseException({
        message: `Firehose ${n} under accountId 123456789012 already exists`,
        $metadata: { httpStatusCode: 400 },
      }),
    response: (n) => ({
      DeliveryStreamARN: `arn:aws:firehose:eu-west-3:123456789012:deliverystream/${n}`,
    }),
  },
};

const SITES: CreateSite[] = [
  {
    type: 'AWS::KinesisFirehose::DeliveryStream',
    command: 'CreateDeliveryStreamCommand',
    name: 'orders-firehose',
    props: {
      DeliveryStreamName: 'orders-firehose',
      S3DestinationConfiguration: {
        BucketARN: 'arn:aws:s3:::orders-bucket',
        RoleARN: 'arn:aws:iam::123456789012:role/firehose',
      },
    },
    provider: () => new FirehoseProvider(),
    prose: true,
    postCreateCalls: true,
    successResponses: {
      // `waitForActive` polls until ACTIVE.
      DescribeDeliveryStreamCommand: {
        DeliveryStreamDescription: {
          DeliveryStreamName: 'orders-firehose',
          DeliveryStreamARN:
            'arn:aws:firehose:eu-west-3:123456789012:deliverystream/orders-firehose',
          DeliveryStreamStatus: 'ACTIVE',
        },
      },
    },
  },
];

describeCreateRetrySafety(SITES, CREATES);
