import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: the Neptune creates carry no idempotency token, so the AWS
// SDK's own retry of a 5xx whose request had succeeded replayed them inside
// ONE `send` and collided with what the first send made. That "already exists"
// surfaced from the engine's first attempt and read as a name somebody else
// holds.

vi.mock('@aws-sdk/client-neptune', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-neptune')>();
  const { sdkClientStandIn } = await import('./create-retry-4639-harness.js');
  return { ...actual, NeptuneClient: vi
      .fn()
      .mockImplementation((cfg?: { region?: string; profile?: string }) =>
        sdkClientStandIn(cfg?.region ?? 'unset', cfg?.profile)
      ),
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

import {
  DBClusterAlreadyExistsFault,
  DBInstanceAlreadyExistsFault,
  DBSubnetGroupAlreadyExistsFault,
} from '@aws-sdk/client-neptune';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import type { NamedCreate } from './create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './create-retry-4639-suite.js';

const meta = { $metadata: { httpStatusCode: 400 } };

/** The RDS-family wording Neptune shares. */
const CREATES: Record<string, NamedCreate> = {
  CreateDBSubnetGroupCommand: {
    nameKey: 'DBSubnetGroupName',
    collision: (n) =>
      new DBSubnetGroupAlreadyExistsFault({
        message: `The DB subnet group '${n}' already exists.`,
        ...meta,
      }),
  },
  CreateDBClusterCommand: {
    nameKey: 'DBClusterIdentifier',
    collision: () => new DBClusterAlreadyExistsFault({ message: 'DB Cluster already exists', ...meta }),
  },
  CreateDBInstanceCommand: {
    nameKey: 'DBInstanceIdentifier',
    collision: () =>
      new DBInstanceAlreadyExistsFault({ message: 'DB instance already exists', ...meta }),
  },
};

const SITES: CreateSite[] = [
  {
    type: 'AWS::Neptune::DBSubnetGroup',
    command: 'CreateDBSubnetGroupCommand',
    name: 'orders-sng',
    props: { DBSubnetGroupName: 'orders-sng', DBSubnetGroupDescription: 'd', SubnetIds: ['s-1', 's-2'] },
    provider: () => new NeptuneProvider(),
    prose: true,
  },
  {
    type: 'AWS::Neptune::DBCluster',
    command: 'CreateDBClusterCommand',
    name: 'orders-neptune',
    props: { DBClusterIdentifier: 'orders-neptune' },
    provider: () => new NeptuneProvider(),
    prose: true,
  },
  {
    type: 'AWS::Neptune::DBInstance',
    command: 'CreateDBInstanceCommand',
    name: 'orders-neptune-1',
    props: {
      DBInstanceIdentifier: 'orders-neptune-1',
      DBClusterIdentifier: 'orders-neptune',
      DBInstanceClass: 'db.r5.large',
    },
    provider: () => new NeptuneProvider(),
    prose: true,
  },
];

describeCreateRetrySafety(SITES, CREATES);
