import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: `CreateTable` carries no idempotency token, so the AWS
// SDK's own retry of a 5xx whose request had succeeded replayed it inside ONE
// `send` and collided with the table the first send made. That
// `ResourceInUseException` surfaced from the engine's first attempt and read as
// a table somebody else holds.

// The providers take the SHARED client from `getAwsClients()` and build only
// the create client themselves: both are stand-ins, each with its own config.
// `active` is what `getAwsClients()` answers NOW; a test swaps it to model a
// `setAwsClients` switch after the provider was built.
const { clients } = vi.hoisted(() => ({
  clients: { active: undefined as unknown },
}));

vi.mock('../../../src/utils/aws-clients.js', async () => {
  const { sdkClientStandIn } = await import('./create-retry-4639-harness.js');
  clients.active = {
    // Not the region any client defaults to, so a create client that took
    // its region from anywhere else is told apart.
    dynamoDB: sdkClientStandIn('ap-northeast-1'),
    credentialConfig: { profile: 'stack-profile' },
  };
  return { getAwsClients: () => clients.active };
});

vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  const { sdkClientStandIn } = await import('./create-retry-4639-harness.js');
  return {
    ...actual,
    DynamoDBClient: vi
      .fn()
      .mockImplementation((cfg: { region?: string } | undefined) =>
        sdkClientStandIn(cfg?.region ?? 'unset')
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

import { DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import {
  FakeNamedCreates,
  sentVia,
  useService,
  type NamedCreate,
  type StandInConfig,
} from './create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './create-retry-4639-suite.js';

const CREATES: Record<string, NamedCreate> = {
  CreateTableCommand: {
    nameKey: 'TableName',
    collision: (n) =>
      new ResourceInUseException({
        message: `Table already exists: ${n}`,
        $metadata: { httpStatusCode: 400 },
      }),
  },
};

const TABLE = {
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
};

const SITES: CreateSite[] = [
  {
    type: 'AWS::DynamoDB::Table',
    command: 'CreateTableCommand',
    name: 'orders',
    props: { TableName: 'orders', ...TABLE },
    provider: () => new DynamoDBTableProvider(),
    prose: true,
    region: 'ap-northeast-1',
  },
  {
    type: 'AWS::DynamoDB::GlobalTable',
    command: 'CreateTableCommand',
    name: 'orders-global',
    props: { TableName: 'orders-global', ...TABLE, Replicas: [{ Region: 'us-east-1' }] },
    provider: () => new DynamoDBGlobalTableProvider(),
    prose: true,
    region: 'ap-northeast-1',
  },
];

// The identity switch is pinned below against the mocked `getAwsClients()`.
describeCreateRetrySafety(SITES, CREATES, { identitySwitch: false });

describe('the DynamoDB create client (issue #4639)', () => {
  const stackClients = clients.active as {
    dynamoDB: { config: StandInConfig };
    credentialConfig: { profile: string };
  };

  afterEach(() => {
    clients.active = stackClients;
    vi.restoreAllMocks();
  });

  const built = (since: number) => vi.mocked(DynamoDBClient).mock.calls.slice(since);

  it.each(SITES)(
    '$type builds it once, in the shared client region, with that client identity',
    async (site) => {
      useService(new FakeNamedCreates(CREATES).send);
      const before = vi.mocked(DynamoDBClient).mock.calls.length;
      const provider = site.provider();
      // A `setAwsClients` switch after the provider was built: the create must
      // keep the identity of the clients its shared client came from.
      clients.active = { ...stackClients, credentialConfig: { profile: 'switched-profile' } };

      await provider.create('A', site.type, { ...site.props, TableName: 'a' }).catch(() => undefined);
      await provider.create('B', site.type, { ...site.props, TableName: 'b' }).catch(() => undefined);

      expect(built(before)).toHaveLength(1);
      expect(built(before)[0]![0]).toMatchObject({
        region: 'ap-northeast-1',
        profile: 'stack-profile',
      });
      expect(sentVia.filter(([n]) => n === 'CreateTableCommand')).toHaveLength(2);
    }
  );

  it.each(SITES)('$type builds one client for two creates started together', async (site) => {
    useService(new FakeNamedCreates(CREATES).send);
    const before = vi.mocked(DynamoDBClient).mock.calls.length;
    const provider = site.provider();

    // Both start before either awaits: only a cached PROMISE keeps the second
    // from building its own client while the first reads the region.
    await Promise.all([
      provider.create('A', site.type, { ...site.props, TableName: 'a' }).catch(() => undefined),
      provider.create('B', site.type, { ...site.props, TableName: 'b' }).catch(() => undefined),
    ]);

    expect(built(before)).toHaveLength(1);
    expect(sentVia.filter(([n]) => n === 'CreateTableCommand')).toHaveLength(2);
  });

  it.each(SITES)('$type does not cache a rejected region read', async (site) => {
    useService(new FakeNamedCreates(CREATES).send);
    const before = vi.mocked(DynamoDBClient).mock.calls.length;
    const provider = site.provider();
    vi.spyOn(stackClients.dynamoDB.config, 'region').mockRejectedValueOnce(new Error('no region'));

    await expect(provider.create('A', site.type, { ...site.props, TableName: 'a' })).rejects.toThrow(
      /no region/
    );
    expect(built(before)).toHaveLength(0);

    await provider.create('B', site.type, { ...site.props, TableName: 'b' }).catch(() => undefined);
    expect(built(before)).toHaveLength(1);
    expect(sentVia.filter(([n]) => n === 'CreateTableCommand')).toHaveLength(1);
  });
});
