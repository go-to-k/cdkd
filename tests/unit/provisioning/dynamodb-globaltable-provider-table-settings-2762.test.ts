import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DeleteTableCommand,
  ResourceInUseException,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

/**
 * go-to-k/cdkd#2762: the `AWS::DynamoDB::GlobalTable` table-level settings that
 * moved onto the SDK route, as a CloudFormation A/B measured them (us-east-1 +
 * us-east-2, 2026-11-01):
 *
 *  - `VectorIndexes`: `CreateTable`, then `VectorIndexUpdates` one per call; a
 *    replica inherits them.
 *  - `WarmThroughput`: `CreateTable` / `UpdateTable`; a decrease is not sent.
 *  - `ReadOnDemandThroughputSettings` / `ReadProvisionedThroughputSettings`: the
 *    table's read ceiling and capacity, valid only with settings replication
 *    ENABLED, and never beside the same block on a replica.
 *  - `TableType`: no API member; `Regional` on two replicas is refused.
 */

const { mockSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] }),
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  DynamoDBGlobalTableProvider,
  collectDesiredKeyAttributeNames,
  collectTableOnDemandCeilings,
  derivePerCallProvisionedThroughput,
  replicaSettingsRefusal,
  stripProvisionedCapacityKeys,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'gt-2762';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE}`;

type Rec = Record<string, unknown>;

const BASE: Rec = {
  TableName: TABLE,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  Replicas: [{ Region: 'us-east-1' }],
};
const ENABLED_REPLICA = [{ Region: 'us-east-1', GlobalTableSettingsReplicationMode: 'ENABLED' }];
const VEC = (name: string, dimensions: unknown = 3): Rec => ({
  IndexName: name,
  VectorAttribute: { AttributeName: 'embedding' },
  Dimensions: dimensions,
  DistanceFunction: 'COSINE',
  Projection: { ProjectionType: 'KEYS_ONLY' },
});

let live: Rec;
const sent = <T>(command: new (input: never) => T): Rec[] =>
  mockSend.mock.calls
    .map((call) => call[0] as { input: Rec })
    .filter((c) => c instanceof (command as unknown as abstract new () => unknown))
    .map((c) => c.input);
const updates = (): Rec[] => sent(UpdateTableCommand);

beforeEach(() => {
  vi.clearAllMocks();
  live = { TableName: TABLE, TableArn: TABLE_ARN, TableStatus: 'ACTIVE', TableId: 'tid' };
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'CreateTableCommand':
        return Promise.resolve({ TableDescription: { TableId: 'tid' } });
      case 'DescribeTableCommand':
        return Promise.resolve({ Table: live });
      case 'DescribeTimeToLiveCommand':
        return Promise.resolve({ TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } });
      case 'ListTagsOfResourceCommand':
        return Promise.resolve({ Tags: [] });
      default:
        return Promise.resolve({});
    }
  });
});

const update = (
  properties: Rec,
  previous: Rec,
  context?: Rec
): ReturnType<DynamoDBGlobalTableProvider['update']> =>
  new DynamoDBGlobalTableProvider().update('T', TABLE, RESOURCE_TYPE, properties, previous, context);

describe('create', () => {
  it('sends VectorIndexes and a coerced WarmThroughput on CreateTable, and no TableType', async () => {
    await new DynamoDBGlobalTableProvider().create('T', RESOURCE_TYPE, {
      ...BASE,
      VectorIndexes: [VEC('vec1', '3')],
      WarmThroughput: { ReadUnitsPerSecond: '13000', WriteUnitsPerSecond: 5000 },
      TableType: 'GlobalTableReplica',
    });
    const [input] = sent(CreateTableCommand);
    expect(input?.['VectorIndexes']).toEqual([VEC('vec1', 3)]);
    expect(input?.['WarmThroughput']).toEqual({
      ReadUnitsPerSecond: 13000,
      WriteUnitsPerSecond: 5000,
    });
    expect(input).not.toHaveProperty('TableType');
  });

  it('reports an unusable WarmThroughput and sends none', async () => {
    await new DynamoDBGlobalTableProvider().create('T', RESOURCE_TYPE, {
      ...BASE,
      WarmThroughput: { ReadUnitsPerSecond: 'many' },
    });
    expect(sent(CreateTableCommand)[0]).not.toHaveProperty('WarmThroughput');
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('WarmThroughput');
  });

  it('adds a replica only once a vector index created with the table has settled', async () => {
    const order: string[] = [];
    let polls = 0;
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      const name = command.constructor.name;
      if (name === 'CreateTableCommand') {
        return Promise.resolve({ TableDescription: { TableId: 'tid' } });
      }
      if (name === 'DescribeTableCommand') {
        polls += 1;
        order.push(polls < 3 ? 'building' : 'settled');
        return Promise.resolve({
          Table: {
            ...live,
            VectorIndexes: [{ IndexName: 'vec1', IndexStatus: polls < 3 ? 'CREATING' : 'ACTIVE' }],
            Replicas: [{ RegionName: 'us-east-2', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (name === 'UpdateTableCommand' && command.input['ReplicaUpdates']) order.push('replica');
      return Promise.resolve({});
    });
    await new DynamoDBGlobalTableProvider().create('T', RESOURCE_TYPE, {
      ...BASE,
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      Replicas: [{ Region: 'us-east-2' }, { Region: 'us-east-1' }],
      VectorIndexes: [VEC('vec1')],
    });
    expect(order.indexOf('replica')).toBeGreaterThan(order.indexOf('settled'));
    expect(order.lastIndexOf('building', order.indexOf('replica'))).toBeLessThan(
      order.indexOf('replica')
    );
  });

  it('retries the rollback DeleteTable a building vector index refuses', async () => {
    let deletes = 0;
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'CreateTableCommand') {
        return Promise.resolve({ TableDescription: { TableId: 'tid' } });
      }
      if (name === 'DescribeTableCommand') return Promise.resolve({ Table: live });
      if (name === 'UpdateTimeToLiveCommand') return Promise.reject(new Error('ttl failed'));
      if (name === 'DeleteTableCommand') {
        deletes += 1;
        if (deletes === 1) {
          return Promise.reject(
            new Error('Cannot delete table while indexes are being created, updated, or deleted.')
          );
        }
      }
      return Promise.resolve({});
    });
    const { deleteTableRetryDelays } = await import(
      '../../../src/provisioning/providers/dynamodb-globaltable-provider.js'
    );
    deleteTableRetryDelays.sleep = () => Promise.resolve();
    await expect(
      new DynamoDBGlobalTableProvider().create('T', RESOURCE_TYPE, {
        ...BASE,
        VectorIndexes: [VEC('vec1')],
        TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
      })
    ).rejects.toThrow(/ttl failed/);
    delete deleteTableRetryDelays.sleep;
    expect(deletes).toBe(2);
  });

  it('a table with no vector index keeps its single rollback DeleteTable', async () => {
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'CreateTableCommand') {
        return Promise.resolve({ TableDescription: { TableId: 'tid' } });
      }
      if (name === 'DescribeTableCommand') return Promise.resolve({ Table: live });
      if (name === 'UpdateTimeToLiveCommand') return Promise.reject(new Error('ttl failed'));
      if (name === 'DeleteTableCommand') {
        return Promise.reject(new Error('Cannot delete table while indexes are being created.'));
      }
      return Promise.resolve({});
    });
    await expect(
      new DynamoDBGlobalTableProvider().create('T', RESOURCE_TYPE, {
        ...BASE,
        TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
      })
    ).rejects.toThrow(/ttl failed/);
    expect(sent(DeleteTableCommand)).toHaveLength(1);
  });
});

describe('the table-level read settings', () => {
  const props = { ...BASE, Replicas: ENABLED_REPLICA };

  it('reads the on-demand ceiling from the table when the replica declares none', () => {
    const ceilings = collectTableOnDemandCeilings(
      { ...props, ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 } },
      'us-east-1'
    );
    expect(ceilings.read).toEqual({ declared: true, value: 50 });
  });

  it('reads the provisioned capacity from the table when the replica declares none', () => {
    expect(
      derivePerCallProvisionedThroughput(
        { ...props, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 } },
        'us-east-1'
      ).ReadCapacityUnits
    ).toBe(7);
  });

  it('sends the on-demand ceiling on CreateTable', async () => {
    await new DynamoDBGlobalTableProvider().create('T', RESOURCE_TYPE, {
      ...props,
      ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 },
    });
    expect(sent(CreateTableCommand)[0]?.['OnDemandThroughput']).toEqual({
      MaxReadRequestUnits: 50,
    });
  });

  it('strips the table-level provisioned block with the rest of the provisioned members', () => {
    expect(
      stripProvisionedCapacityKeys({
        ...props,
        ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 },
      })
    ).not.toHaveProperty('ReadProvisionedThroughputSettings');
  });
});

describe('replicaSettingsRefusal: what the CloudFormation handler refuses', () => {
  const two = [{ Region: 'us-east-1' }, { Region: 'us-east-2' }];

  it('refuses TableType Regional on two replicas, on a create', () => {
    expect(replicaSettingsRefusal({ ...BASE, Replicas: two, TableType: 'Regional' }, undefined)).toMatch(
      /TableType Regional cannot be declared with more than one replica/
    );
  });

  it('takes TableType GlobalTableReplica on two replicas and Regional on one', () => {
    expect(
      replicaSettingsRefusal({ ...BASE, Replicas: two, TableType: 'GlobalTableReplica' }, undefined)
    ).toBeUndefined();
    expect(replicaSettingsRefusal({ ...BASE, TableType: 'Regional' }, undefined)).toBeUndefined();
  });

  it('refuses TableType Regional when an update adds the second replica', () => {
    const before = { ...BASE, TableType: 'Regional' };
    expect(replicaSettingsRefusal({ ...before, Replicas: two }, before)).toMatch(/TableType/);
  });

  it.each(['ReadOnDemandThroughputSettings', 'ReadProvisionedThroughputSettings'])(
    'refuses a table-level %s without settings replication ENABLED',
    (key) => {
      expect(replicaSettingsRefusal({ ...BASE, [key]: {} }, undefined)).toMatch(
        /needs Replicas\[\]\.GlobalTableSettingsReplicationMode ENABLED/
      );
      expect(
        replicaSettingsRefusal(
          {
            ...BASE,
            Replicas: [{ Region: 'us-east-1', GlobalTableSettingsReplicationMode: 'DISABLED' }],
            [key]: {},
          },
          undefined
        )
      ).toMatch(/ENABLED/);
    }
  );

  it.each(['ReadOnDemandThroughputSettings', 'ReadProvisionedThroughputSettings'])(
    'refuses %s at both the table level and a replica',
    (key) => {
      expect(
        replicaSettingsRefusal(
          { ...BASE, Replicas: [{ ...ENABLED_REPLICA[0], [key]: {} }], [key]: {} },
          undefined
        )
      ).toMatch(/at both the table level and a replica/);
    }
  );

  it('refuses the on-demand block on a PROVISIONED table', () => {
    expect(
      replicaSettingsRefusal(
        {
          ...BASE,
          BillingMode: 'PROVISIONED',
          Replicas: ENABLED_REPLICA,
          ReadOnDemandThroughputSettings: {},
        },
        undefined
      )
    ).toMatch(/cannot be declared on a PROVISIONED table/);
  });

  it('takes the provisioned block on an on-demand table, which CloudFormation ignores', () => {
    expect(
      replicaSettingsRefusal(
        { ...BASE, Replicas: ENABLED_REPLICA, ReadProvisionedThroughputSettings: {} },
        undefined
      )
    ).toBeUndefined();
  });

  it('does not refuse an unchanged block on an update', () => {
    const recorded = { ...BASE, ReadOnDemandThroughputSettings: {} };
    expect(replicaSettingsRefusal(recorded, recorded)).toBeUndefined();
  });

  it('refuses a template that removes the mode the block needs', () => {
    const before = {
      ...BASE,
      Replicas: ENABLED_REPLICA,
      ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 5 },
    };
    expect(replicaSettingsRefusal({ ...before, Replicas: BASE['Replicas'] }, before)).toMatch(
      /ENABLED/
    );
  });
});

describe('update', () => {
  it('sends one Create per added vector index, with the desired AttributeDefinitions', async () => {
    live = { ...live, VectorIndexes: [] };
    await update({ ...BASE, VectorIndexes: [VEC('vec1'), VEC('vec2')] }, BASE);
    const ops = updates().filter((u) => u['VectorIndexUpdates']);
    expect(ops.map((u) => u['VectorIndexUpdates'])).toEqual([
      [{ Create: VEC('vec1') }],
      [{ Create: VEC('vec2') }],
    ]);
    expect(ops[0]?.['AttributeDefinitions']).toEqual(BASE['AttributeDefinitions']);
  });

  it('marks VectorIndexes unsettled before the call and records the accepted Create', async () => {
    live = { ...live, VectorIndexes: [] };
    const markUnsettled = vi.fn();
    const markAttempted = vi.fn();
    await update({ ...BASE, VectorIndexes: [VEC('vec1')] }, BASE, { markUnsettled, markAttempted });
    expect(markUnsettled).toHaveBeenCalledWith('VectorIndexes');
    expect(markAttempted).toHaveBeenCalledWith('VectorIndexes', ['vec1']);
  });

  it('sends a Delete for a removed vector index, and nothing when AWS has lost it', async () => {
    const before = { ...BASE, VectorIndexes: [VEC('vec1')] };
    live = { ...live, VectorIndexes: [{ ...VEC('vec1'), IndexStatus: 'ACTIVE' }] };
    await update(BASE, before);
    expect(updates().flatMap((u) => u['VectorIndexUpdates'] ?? [])).toEqual([
      { Delete: { IndexName: 'vec1' } },
    ]);
    mockSend.mockClear();
    live = { ...live, VectorIndexes: [] };
    await update(BASE, before);
    expect(updates().filter((u) => u['VectorIndexUpdates'])).toEqual([]);
  });

  it('refuses a changed vector index before any mutating call', async () => {
    live = { ...live, VectorIndexes: [{ ...VEC('vec1'), IndexStatus: 'ACTIVE' }] };
    await expect(
      update(
        {
          ...BASE,
          VectorIndexes: [VEC('vec1', 8)],
          WarmThroughput: { ReadUnitsPerSecond: 13000 },
        },
        { ...BASE, VectorIndexes: [VEC('vec1')] }
      )
    ).rejects.toThrow(/VectorIndexes vec1 changed definition, which DynamoDB cannot modify/);
    expect(updates()).toEqual([]);
  });

  it('warns and sends nothing for a changed vector index on a state replay', async () => {
    live = { ...live, VectorIndexes: [{ ...VEC('vec1'), IndexStatus: 'ACTIVE' }] };
    await update(
      { ...BASE, VectorIndexes: [VEC('vec1', 8)] },
      { ...BASE, VectorIndexes: [VEC('vec1')] },
      { replayingState: true }
    );
    expect(updates().filter((u) => u['VectorIndexUpdates'])).toEqual([]);
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('that change was not applied');
  });

  it('adopts a vector index AWS already holds, without a Create', async () => {
    live = { ...live, VectorIndexes: [{ ...VEC('vec1'), IndexStatus: 'ACTIVE' }] };
    await update({ ...BASE, VectorIndexes: [VEC('vec1')] }, BASE);
    expect(updates().filter((u) => u['VectorIndexUpdates'])).toEqual([]);
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('its Create is being skipped');
  });

  it('raises WarmThroughput in its own UpdateTable', async () => {
    live = { ...live, WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } };
    const markUnsettled = vi.fn();
    await update({ ...BASE, WarmThroughput: { ReadUnitsPerSecond: '13000' } }, BASE, {
      markUnsettled,
    });
    expect(updates()).toEqual([
      { TableName: TABLE, WarmThroughput: { ReadUnitsPerSecond: 13000 } },
    ]);
    expect(markUnsettled).toHaveBeenCalledWith('WarmThroughput');
  });

  it('does not send a WarmThroughput below or equal to what AWS reports, or a removal', async () => {
    live = { ...live, WarmThroughput: { ReadUnitsPerSecond: 13000, WriteUnitsPerSecond: 5000 } };
    await update({ ...BASE, WarmThroughput: { ReadUnitsPerSecond: 12500 } }, BASE);
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('WarmThroughput was NOT sent');
    await update({ ...BASE, WarmThroughput: { ReadUnitsPerSecond: 13000 } }, BASE);
    await update(BASE, { ...BASE, WarmThroughput: { ReadUnitsPerSecond: 13000 } });
    expect(updates()).toEqual([]);
  });

  const provisioned = {
    ...BASE,
    BillingMode: 'PROVISIONED',
    Replicas: ENABLED_REPLICA,
    ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 },
  };

  it('sends a changed table-level read capacity with the write side AWS holds', async () => {
    live = {
      ...live,
      GlobalTableSettingsReplicationMode: 'ENABLED',
      ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 },
    };
    await update(
      { ...provisioned, ReadProvisionedThroughputSettings: { ReadCapacityUnits: '8' } },
      provisioned
    );
    expect(updates().filter((u) => u['ProvisionedThroughput'])).toEqual([
      {
        TableName: TABLE,
        ProvisionedThroughput: { ReadCapacityUnits: 8, WriteCapacityUnits: 3 },
      },
    ]);
  });

  it('sends no read capacity AWS already holds', async () => {
    live = {
      ...live,
      GlobalTableSettingsReplicationMode: 'ENABLED',
      ProvisionedThroughput: { ReadCapacityUnits: 8, WriteCapacityUnits: 3 },
    };
    await update(
      { ...provisioned, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 8 } },
      provisioned
    );
    expect(updates().filter((u) => u['ProvisionedThroughput'])).toEqual([]);
  });

  const onDemand = {
    ...BASE,
    Replicas: ENABLED_REPLICA,
    ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 },
  };

  it('sends a changed table-level read ceiling and marks it unsettled', async () => {
    live = {
      ...live,
      GlobalTableSettingsReplicationMode: 'ENABLED',
      OnDemandThroughput: { MaxReadRequestUnits: 50 },
    };
    const markUnsettled = vi.fn();
    await update(
      { ...onDemand, ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 55 } },
      onDemand,
      { markUnsettled }
    );
    expect(updates().map((u) => u['OnDemandThroughput'])).toContainEqual({
      MaxReadRequestUnits: 55,
    });
    expect(markUnsettled).toHaveBeenCalledWith('ReadOnDemandThroughputSettings');
  });

  it('resets a removed table-level read ceiling', async () => {
    live = {
      ...live,
      GlobalTableSettingsReplicationMode: 'ENABLED',
      OnDemandThroughput: { MaxReadRequestUnits: 50 },
    };
    await update({ ...BASE, Replicas: ENABLED_REPLICA }, onDemand);
    expect(updates().map((u) => u['OnDemandThroughput'])).toContainEqual({
      MaxReadRequestUnits: -1,
    });
  });

  it('sends nothing for a TableType change alone', async () => {
    await update({ ...BASE, TableType: 'GlobalTableReplica' }, { ...BASE, TableType: 'Regional' });
    expect(updates()).toEqual([]);
  });
});

describe('readCurrentState', () => {
  const read = (properties: Rec): ReturnType<DynamoDBGlobalTableProvider['readCurrentState']> =>
    new DynamoDBGlobalTableProvider().readCurrentState(TABLE, 'T', RESOURCE_TYPE, properties);

  it('reads VectorIndexes back in their CFn shape, and none as absent', async () => {
    live = {
      ...live,
      VectorIndexes: [{ ...VEC('vec1'), IndexStatus: 'ACTIVE', IndexSizeBytes: 0 }],
    };
    expect(await read(BASE)).toMatchObject({ VectorIndexes: [VEC('vec1')] });
    live = { ...live, VectorIndexes: [] };
    expect(await read(BASE)).not.toHaveProperty('VectorIndexes');
  });

  it('reads back only the declared WarmThroughput members', async () => {
    live = {
      ...live,
      WarmThroughput: { ReadUnitsPerSecond: 13000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' },
    };
    const state = (await read({ ...BASE, WarmThroughput: { ReadUnitsPerSecond: 13000 } })) as Rec;
    expect(state['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 13000 });
    expect(await read(BASE)).not.toHaveProperty('WarmThroughput');
  });

  it('reads a table-level read block back only where the record keeps it', async () => {
    live = { ...live, OnDemandThroughput: { MaxReadRequestUnits: 50 } };
    expect(
      await read({ ...BASE, ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 1 } })
    ).toMatchObject({ ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 } });
    expect(await read(BASE)).not.toHaveProperty('ReadOnDemandThroughputSettings');
  });

  it('reads the table-level provisioned block on a table with no billing summary', async () => {
    live = { ...live, ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 1 } };
    expect(
      await read({ ...BASE, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 1 } })
    ).toMatchObject({ ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 } });
    live = { ...live, BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } };
    expect(
      await read({ ...BASE, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 1 } })
    ).not.toHaveProperty('ReadProvisionedThroughputSettings');
  });
});

describe('the drift hooks', () => {
  const provider = new DynamoDBGlobalTableProvider();

  it('declares what no AWS read answers', () => {
    expect(provider.getDriftUnknownPaths(RESOURCE_TYPE, BASE)).toEqual([
      'TableType',
      'ReadProvisionedThroughputSettings',
      'WarmThroughput',
    ]);
    expect(
      provider.getDriftUnknownPaths(RESOURCE_TYPE, {
        ...BASE,
        BillingMode: 'PROVISIONED',
        WarmThroughput: { ReadUnitsPerSecond: 13000 },
      })
    ).toEqual(['TableType']);
  });

  it('compares VectorIndexes as a set', () => {
    expect(provider.getDriftUnorderedPaths(RESOURCE_TYPE)).toContain('VectorIndexes');
  });

  it('names VectorIndexes and WarmThroughput while AWS is moving them', async () => {
    live = {
      ...live,
      VectorIndexes: [{ IndexName: 'vec1', IndexStatus: 'CREATING' }],
      WarmThroughput: { ReadUnitsPerSecond: 13000, Status: 'UPDATING' },
    };
    expect(
      await provider.unsettledInTransition(
        TABLE,
        'T',
        RESOURCE_TYPE,
        new Set(['VectorIndexes', 'WarmThroughput', 'Replicas'])
      )
    ).toEqual(new Set(['VectorIndexes', 'WarmThroughput']));
    live = { ...live, VectorIndexes: [{ IndexName: 'vec1', IndexStatus: 'ACTIVE' }] };
    live = { ...live, WarmThroughput: { Status: 'ACTIVE' } };
    expect(
      await provider.unsettledInTransition(
        TABLE,
        'T',
        RESOURCE_TYPE,
        new Set(['VectorIndexes', 'WarmThroughput'])
      )
    ).toEqual(new Set());
  });

  it('projects an unsettled VectorIndexes onto what the record or template names', async () => {
    live = {
      ...live,
      VectorIndexes: [
        { ...VEC('vec1'), IndexStatus: 'ACTIVE' },
        { ...VEC('other'), IndexStatus: 'ACTIVE' },
      ],
    };
    const out = (await provider.readUnsettled(
      TABLE,
      'T',
      RESOURCE_TYPE,
      new Set(['VectorIndexes']),
      { ...BASE, VectorIndexes: [VEC('vec1')] },
      { ...BASE, VectorIndexes: [VEC('vec1')] }
    )) as Rec;
    expect(out['VectorIndexes']).toEqual([VEC('vec1')]);
  });
});

describe('collectDesiredKeyAttributeNames', () => {
  it('keeps the attribute a vector index searches on', () => {
    const names = collectDesiredKeyAttributeNames(
      {
        KeySchema: BASE['KeySchema'],
        VectorIndexes: [
          {
            ...VEC('vec1'),
            SearchSchema: [{ AttributeName: 'tenant', SearchSchemaElementType: 'HASH' }],
          },
        ],
      },
      { indexListKeys: ['LocalSecondaryIndexes'] }
    );
    expect([...names].sort()).toEqual(['pk', 'tenant']);
  });
});

describe('delete with a vector index', () => {
  it('waits out a building vector index before DeleteTable and names it on a refusal', async () => {
    let polls = 0;
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'DescribeTableCommand') {
        polls += 1;
        return Promise.resolve({
          Table: {
            ...live,
            VectorIndexes: [{ IndexName: 'vec1', IndexStatus: polls < 3 ? 'CREATING' : 'ACTIVE' }],
          },
        });
      }
      if (name === 'DeleteTableCommand') {
        return Promise.reject(
          new ResourceInUseException({
            message:
              'Attempt to change a resource which is still in use: Cannot delete table while indexes are being created, updated, or deleted.',
            $metadata: {},
          })
        );
      }
      return Promise.resolve({ ScalableTargets: [], ScalingPolicies: [] });
    });
    const { deleteTableRetryDelays } = await import(
      '../../../src/provisioning/providers/dynamodb-globaltable-provider.js'
    );
    deleteTableRetryDelays.sleep = () => Promise.resolve();
    const thrown = await new DynamoDBGlobalTableProvider()
      .delete('T', TABLE, RESOURCE_TYPE, BASE)
      .catch((error: unknown) => error as Error);
    delete deleteTableRetryDelays.sleep;
    expect(polls).toBeGreaterThanOrEqual(3);
    expect((thrown as Error).message).toContain('a global secondary index or vector index');
  });
});
