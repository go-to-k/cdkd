import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: CloudTrail `CreateTrail` calls carry no idempotency token, so the AWS SDK's own
// retry of a 5xx whose request had succeeded replayed them inside ONE `send`
// and collided with what the first send made. That "already exists" surfaced
// from the engine's first attempt and read as a name somebody else holds.

vi.mock('@aws-sdk/client-cloudtrail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudtrail')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    CloudTrailClient: vi
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

import { TrailAlreadyExistsException } from '@aws-sdk/client-cloudtrail';
import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { topLevel, type NamedCreate } from './data-create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './data-create-retry-4639-suite.js';

const CREATES: Record<string, NamedCreate> = {
  CreateTrailCommand: {
    nameOf: topLevel('Name'),
    collision: (n) =>
      new TrailAlreadyExistsException({
        message: `Trail ${n} already exists for customer: 123456789012`,
        $metadata: { httpStatusCode: 400 },
      }),
  },
};

const SITES: CreateSite[] = [
  {
    type: 'AWS::CloudTrail::Trail',
    command: 'CreateTrailCommand',
    name: 'orders-trail',
    physicalId: 'arn:aws:cloudtrail:eu-west-3:123456789012:trail/orders-trail',
    props: { TrailName: 'orders-trail', S3BucketName: 'orders-logs', IsLogging: true },
    provider: () => new CloudTrailProvider(),
    prose: true,
    // `StartLogging` and the selector writes follow the create.
    postCreateCalls: true,
    successResponses: {},
  },
];

describeCreateRetrySafety(SITES, CREATES);
