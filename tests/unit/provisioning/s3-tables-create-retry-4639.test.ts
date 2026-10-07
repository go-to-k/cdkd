import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: the S3 Tables creates carry no idempotency token, so the AWS SDK's own
// retry of a 5xx whose request had succeeded replayed them inside ONE `send`
// and collided with what the first send made. That "already exists" surfaced
// from the engine's first attempt and read as a name somebody else holds.

vi.mock('@aws-sdk/client-s3tables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3tables')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    S3TablesClient: vi
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

import { ConflictException } from '@aws-sdk/client-s3tables';
import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { topLevel, type NamedCreate } from './data-create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './data-create-retry-4639-suite.js';

const conflict = (message: string) => () =>
  new ConflictException({ message, $metadata: { httpStatusCode: 409 } });

const CREATES: Record<string, NamedCreate> = {
  CreateTableBucketCommand: {
    nameOf: topLevel('name'),
    collision: conflict('The bucket that you tried to create already exists, and you own it.'),
  },
  CreateNamespaceCommand: {
    nameOf: (input) => (input['namespace'] as string[])[0]!,
    collision: conflict('A namespace with an identical name already exists in the bucket.'),
  },
  CreateTableCommand: {
    nameOf: topLevel('name'),
    collision: conflict('A table with an identical name already exists in the namespace.'),
    response: () => ({ tableARN: `${BUCKET}/table/00000000-0000-0000-0000-000000000000` }),
  },
};

const BUCKET = 'arn:aws:s3tables:eu-west-3:123456789012:bucket/orders-tables';

const SITES: CreateSite[] = [
  {
    type: 'AWS::S3Tables::TableBucket',
    command: 'CreateTableBucketCommand',
    name: 'orders-tables',
    physicalId: BUCKET,
    props: { TableBucketName: 'orders-tables' },
    provider: () => new S3TablesProvider(),
    prose: true,
    successResponses: {},
  },
  {
    type: 'AWS::S3Tables::Namespace',
    command: 'CreateNamespaceCommand',
    name: 'orders_ns',
    physicalId: `${BUCKET}|orders_ns`,
    props: { TableBucketARN: BUCKET, Namespace: 'orders_ns' },
    provider: () => new S3TablesProvider(),
    prose: true,
    successResponses: {},
  },
  {
    type: 'AWS::S3Tables::Table',
    command: 'CreateTableCommand',
    name: 'orders',
    physicalId: `${BUCKET}|orders_ns|orders`,
    props: {
      TableBucketARN: BUCKET,
      Namespace: 'orders_ns',
      TableName: 'orders',
      OpenTableFormat: 'ICEBERG',
    },
    provider: () => new S3TablesProvider(),
    prose: true,
    successResponses: {},
  },
];

describeCreateRetrySafety(SITES, CREATES);
