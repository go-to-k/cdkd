import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: S3 Vectors `CreateVectorBucket` calls carry no idempotency token, so the AWS SDK's own
// retry of a 5xx whose request had succeeded replayed them inside ONE `send`
// and collided with what the first send made. That "already exists" surfaced
// from the engine's first attempt and read as a name somebody else holds.

vi.mock('@aws-sdk/client-s3vectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3vectors')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    S3VectorsClient: vi
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

import { ConflictException } from '@aws-sdk/client-s3vectors';
import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';
import { topLevel, type NamedCreate } from './data-create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './data-create-retry-4639-suite.js';

const CREATES: Record<string, NamedCreate> = {
  CreateVectorBucketCommand: {
    nameOf: topLevel('vectorBucketName'),
    collision: () =>
      new ConflictException({
        message: 'A vector bucket with the specified name already exists',
        $metadata: { httpStatusCode: 409 },
      }),
  },
};

const SITES: CreateSite[] = [
  {
    type: 'AWS::S3Vectors::VectorBucket',
    command: 'CreateVectorBucketCommand',
    name: 'orders-vectors',
    physicalId: 'arn:aws:s3vectors:eu-west-3:123456789012:bucket/orders-vectors',
    props: { VectorBucketName: 'orders-vectors' },
    provider: () => new S3VectorsProvider(),
    prose: true,
    successResponses: {},
  },
];

describeCreateRetrySafety(SITES, CREATES);
