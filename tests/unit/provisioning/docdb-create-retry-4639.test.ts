import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: the DocumentDB creates carry no idempotency token, so the AWS
// SDK's own retry of a 5xx whose request had succeeded replayed them inside
// ONE `send` and collided with what the first send made. That "already exists"
// surfaced from the engine's first attempt and read as a name somebody else
// holds.

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-docdb')>();
  const { sdkClientStandIn } = await import('./create-retry-4639-harness.js');
  return { ...actual, DocDBClient: vi
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
} from '@aws-sdk/client-docdb';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { DocDBSubnetGroupProvider } from '../../../src/provisioning/providers/docdb-subnet-group-provider.js';
import type { NamedCreate } from './create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './create-retry-4639-suite.js';

const meta = { $metadata: { httpStatusCode: 400 } };

/** The RDS-family wording DocumentDB shares. */
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
    type: 'AWS::DocDB::DBSubnetGroup',
    command: 'CreateDBSubnetGroupCommand',
    name: 'orders-sng',
    props: { DBSubnetGroupName: 'orders-sng', DBSubnetGroupDescription: 'd', SubnetIds: ['s-1', 's-2'] },
    provider: () => new DocDBSubnetGroupProvider(),
    prose: true,
  },
  {
    type: 'AWS::DocDB::DBCluster',
    command: 'CreateDBClusterCommand',
    name: 'orders-docdb',
    props: {
      DBClusterIdentifier: 'orders-docdb',
      MasterUsername: 'admin',
      MasterUserPassword: 'password-1234',
    },
    provider: () => new DocDBProvider(),
    prose: true,
  },
  {
    type: 'AWS::DocDB::DBInstance',
    command: 'CreateDBInstanceCommand',
    name: 'orders-docdb-1',
    props: {
      DBInstanceIdentifier: 'orders-docdb-1',
      DBClusterIdentifier: 'orders-docdb',
      DBInstanceClass: 'db.r5.large',
    },
    provider: () => new DocDBProvider(),
    prose: true,
  },
];

describeCreateRetrySafety(SITES, CREATES);
