import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: the RDS creates carry no idempotency token, so the AWS
// SDK's own retry of a 5xx whose request had succeeded replayed them inside
// ONE `send` and collided with what the first send made. That "already exists"
// surfaced from the engine's first attempt and read as a name somebody else
// holds.

vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-rds')>();
  const { sdkClientStandIn } = await import('./create-retry-4639-harness.js');
  return { ...actual, RDSClient: vi
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
  DBProxyAlreadyExistsFault,
  DBProxyEndpointAlreadyExistsFault,
  DBSubnetGroupAlreadyExistsFault,
} from '@aws-sdk/client-rds';
import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { RDSDBProxyProvider } from '../../../src/provisioning/providers/rds-dbproxy-provider.js';
import { RDSDBProxyEndpointProvider } from '../../../src/provisioning/providers/rds-dbproxy-endpoint-provider.js';
import type { NamedCreate } from './create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './create-retry-4639-suite.js';

const meta = { $metadata: { httpStatusCode: 400 } };

/**
 * RDS's wording for the three DB creates. For the proxy pair the SDK model's
 * description stands in: it carries no "already exists", so those cases
 * assert the replay stamp rather than the prose classifier.
 */
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
  CreateDBProxyCommand: {
    nameKey: 'DBProxyName',
    collision: () =>
      new DBProxyAlreadyExistsFault({
        message:
          'The specified proxy name must be unique for all proxies owned by your Amazon Web Services account in the specified Amazon Web Services Region.',
        ...meta,
      }),
  },
  CreateDBProxyEndpointCommand: {
    nameKey: 'DBProxyEndpointName',
    collision: () =>
      new DBProxyEndpointAlreadyExistsFault({
        message:
          'The specified DB proxy endpoint name must be unique for all DB proxy endpoints owned by your Amazon Web Services account in the specified Amazon Web Services Region.',
        ...meta,
      }),
  },
};

const SITES: CreateSite[] = [
  {
    type: 'AWS::RDS::DBSubnetGroup',
    command: 'CreateDBSubnetGroupCommand',
    name: 'orders-sng',
    props: { DBSubnetGroupName: 'orders-sng', DBSubnetGroupDescription: 'd', SubnetIds: ['s-1'] },
    provider: () => new RDSProvider(),
    prose: true,
  },
  {
    type: 'AWS::RDS::DBCluster',
    command: 'CreateDBClusterCommand',
    name: 'orders-cluster',
    props: {
      DBClusterIdentifier: 'orders-cluster',
      Engine: 'aurora-postgresql',
      MasterUsername: 'admin',
      MasterUserPassword: 'password-1234',
    },
    provider: () => new RDSProvider(),
    prose: true,
  },
  {
    type: 'AWS::RDS::DBInstance',
    command: 'CreateDBInstanceCommand',
    name: 'orders-db',
    props: {
      DBInstanceIdentifier: 'orders-db',
      DBInstanceClass: 'db.t3.micro',
      Engine: 'postgres',
      AllocatedStorage: '20',
      MasterUsername: 'admin',
      MasterUserPassword: 'password-1234',
    },
    provider: () => new RDSProvider(),
    prose: true,
  },
  {
    type: 'AWS::RDS::DBProxy',
    command: 'CreateDBProxyCommand',
    name: 'orders-proxy',
    props: {
      DBProxyName: 'orders-proxy',
      EngineFamily: 'POSTGRESQL',
      Auth: [
        {
          AuthScheme: 'SECRETS',
          SecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:s',
        },
      ],
      RoleArn: 'arn:aws:iam::123456789012:role/proxy',
      VpcSubnetIds: ['s-1', 's-2'],
    },
    provider: () => new RDSDBProxyProvider(),
    prose: false,
  },
  {
    type: 'AWS::RDS::DBProxyEndpoint',
    command: 'CreateDBProxyEndpointCommand',
    name: 'orders-endpoint',
    props: {
      DBProxyEndpointName: 'orders-endpoint',
      DBProxyName: 'orders-proxy',
      VpcSubnetIds: ['s-1', 's-2'],
    },
    provider: () => new RDSDBProxyEndpointProvider(),
    prose: false,
  },
];

describeCreateRetrySafety(SITES, CREATES);
