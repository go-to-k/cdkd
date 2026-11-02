import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { unsettledAfterUpdate } from '../../../src/deployment/unsettled-convergence.js';
import {
  CreateTableCommand,
  DeleteTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
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

const { mockSend, scalingSend, warnSpy, debugSpy, settleSpy, deadline, watchLabels } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  scalingSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
  settleSpy: vi.fn(),
  deadline: { remainingMs: Number.POSITIVE_INFINITY },
  watchLabels: [] as string[],
}));

vi.mock('../../../src/deployment/resource-deadline.js', async () => ({
  ...(await vi.importActual<typeof import('../../../src/deployment/resource-deadline.js')>(
    '../../../src/deployment/resource-deadline.js'
  )),
  enclosingDeadlineRemainingMs: () => deadline.remainingMs,
}));

vi.mock('../../../src/provisioning/interrupt-watch.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/interrupt-watch.js')
  >('../../../src/provisioning/interrupt-watch.js');
  return {
    ...actual,
    startInterruptWatch: (what: string) => {
      watchLabels.push(what);
      return actual.startInterruptWatch(what);
    },
  };
});

// The real settle wait, observed: its bounds are what a rollback re-arm decides.
vi.mock('../../../src/provisioning/dynamodb-index-busy-delete.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/dynamodb-index-busy-delete.js')
  >('../../../src/provisioning/dynamodb-index-busy-delete.js');
  return {
    ...actual,
    waitForIndexesSettled: (opts: Parameters<typeof actual.waitForIndexesSettled>[0]) => {
      settleSpy(opts);
      return actual.waitForIndexesSettled(opts);
    },
  };
});

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
      send: scalingSend,
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
  deleteTableRetryDelays,
  derivePerCallProvisionedThroughput,
  replicaSettingsRefusal,
  retainUnsendableCapacityMembers,
  stripProvisionedCapacityKeys,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

import {
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS,
} from '../../../src/provisioning/dynamodb-index-busy-delete.js';

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
  deadline.remainingMs = Number.POSITIVE_INFINITY;
  deleteTableRetryDelays.sleep = () => Promise.resolve();
  live = { TableName: TABLE, TableArn: TABLE_ARN, TableStatus: 'ACTIVE', TableId: 'tid' };
  scalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
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
    let reads = 0;
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      const name = command.constructor.name;
      if (name === 'CreateTableCommand') {
        return Promise.resolve({ TableDescription: { TableId: 'tid' } });
      }
      if (name === 'DescribeTableCommand') {
        reads += 1;
        const status = reads < 4 ? 'CREATING' : 'ACTIVE';
        order.push(status);
        return Promise.resolve({
          Table: {
            ...live,
            VectorIndexes: [{ IndexName: 'vec1', IndexStatus: status }],
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
    expect(order.indexOf('ACTIVE')).toBeGreaterThan(-1);
    expect(order.indexOf('ACTIVE')).toBeLessThan(order.indexOf('replica'));
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
    await expect(
      new DynamoDBGlobalTableProvider().create('T', RESOURCE_TYPE, {
        ...BASE,
        VectorIndexes: [VEC('vec1')],
        TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
      })
    ).rejects.toThrow(/ttl failed/);
    expect(deletes).toBe(2);
  });

  it('re-arms the rollback on the long vector bound, the short one for anything else', async () => {
    let deletes = 0;
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'CreateTableCommand') {
        return Promise.resolve({ TableDescription: { TableId: 'tid' } });
      }
      if (name === 'DescribeTableCommand') return Promise.resolve({ Table: live });
      if (name === 'UpdateTimeToLiveCommand') return Promise.reject(new Error('ttl failed'));
      if (name === 'DeleteTableCommand' && ++deletes === 1) {
        return Promise.reject(new Error('Cannot delete table while indexes are being created.'));
      }
      return Promise.resolve({});
    });
    await new DynamoDBGlobalTableProvider()
      .create('T', RESOURCE_TYPE, {
        ...BASE,
        VectorIndexes: [VEC('vec1')],
        TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
      })
      .catch(() => undefined);
    expect(settleSpy).toHaveBeenCalledTimes(1);
    const opts = settleSpy.mock.calls[0]?.[0] as Rec;
    expect(opts['shortCapUnlessVectorBusy']).toBe(DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS);
    expect(opts['maxAttempts']).toBeGreaterThan(DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS);
    expect(opts['maxAttempts']).toBeLessThanOrEqual(VECTOR_INDEX_BUSY_REARM_MAX_ATTEMPTS);
  });

  it('takes the first rollback refusal as terminal when the deadline leaves no room', async () => {
    deadline.remainingMs = 0;
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
        return Promise.reject(new Error('Cannot delete table while indexes are being created.'));
      }
      return Promise.resolve({});
    });
    await expect(
      new DynamoDBGlobalTableProvider().create('T', RESOURCE_TYPE, {
        ...BASE,
        VectorIndexes: [VEC('vec1')],
        TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
      })
    ).rejects.toThrow(/ttl failed/);
    expect(deletes).toBe(1);
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

  it('keeps the previous table-level block the kept billing mode cannot send', () => {
    expect(
      retainUnsendableCapacityMembers(
        { ...props, ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 9 } },
        { ...props, ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 5 } },
        'PROVISIONED'
      )['ReadOnDemandThroughputSettings']
    ).toEqual({ MaxReadRequestUnits: 5 });
    expect(
      retainUnsendableCapacityMembers(
        { ...props, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 9 } },
        { ...props, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 5 } },
        'PAY_PER_REQUEST'
      )['ReadProvisionedThroughputSettings']
    ).toEqual({ ReadCapacityUnits: 5 });
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

  it.each([
    ['TableType', { ...BASE, Replicas: two, TableType: 'Regional' }, { ...BASE, Replicas: two }],
    [
      'BillingMode',
      {
        ...BASE,
        BillingMode: 'PROVISIONED',
        Replicas: ENABLED_REPLICA,
        ReadOnDemandThroughputSettings: {},
      },
      { ...BASE, Replicas: ENABLED_REPLICA, ReadOnDemandThroughputSettings: {} },
    ],
    [
      'ReadOnDemandThroughputSettings',
      { ...BASE, ReadOnDemandThroughputSettings: {} },
      BASE,
    ],
    [
      'ReadProvisionedThroughputSettings',
      { ...BASE, ReadProvisionedThroughputSettings: {} },
      BASE,
    ],
  ])('refuses on an update that changes only %s', (_key, desired, previous) => {
    expect(replicaSettingsRefusal(desired, previous)).toBeDefined();
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

  it('warns the same way when the bag comes from a drift --revert read-back', async () => {
    live = { ...live, VectorIndexes: [{ ...VEC('vec1'), IndexStatus: 'ACTIVE' }] };
    await update(
      { ...BASE, VectorIndexes: [VEC('vec1', 8)] },
      { ...BASE, VectorIndexes: [VEC('vec1')] },
      { desiredFromAwsReadback: true }
    );
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('that change was not applied');
  });

  it('sends the next vector op only after the previous one has settled', async () => {
    const order: string[] = [];
    let building = 0;
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      const name = command.constructor.name;
      if (name === 'DescribeTableCommand') {
        const status = building > 0 ? 'CREATING' : 'ACTIVE';
        order.push(status);
        if (building > 0) building -= 1;
        return Promise.resolve({
          Table: { ...live, VectorIndexes: [{ IndexName: 'other', IndexStatus: status }] },
        });
      }
      if (name === 'UpdateTableCommand' && command.input['VectorIndexUpdates']) {
        order.push('op');
        building = 1;
      }
      return Promise.resolve({ Tags: [] });
    });
    await update(
      { ...BASE, VectorIndexes: [VEC('vec1'), VEC('vec2')] },
      BASE
    );
    const first = order.indexOf('op');
    const second = order.lastIndexOf('op');
    expect(second).toBeGreaterThan(first);
    expect(order.slice(first, second)).toContain('CREATING');
    expect(order[second - 1]).toBe('ACTIVE');
  });

  it('holds the wait after an UpdateTable while a vector index is in transition', async () => {
    const afterSend: string[] = [];
    let building = 0;
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      const name = command.constructor.name;
      if (name === 'DescribeTableCommand') {
        const status = building > 0 ? 'UPDATING' : 'ACTIVE';
        if (building > 0) building -= 1;
        afterSend.push(status);
        return Promise.resolve({
          Table: { ...live, VectorIndexes: [{ IndexName: 'other', IndexStatus: status }] },
        });
      }
      if (name === 'UpdateTableCommand') {
        afterSend.length = 0;
        building = 2;
      }
      return Promise.resolve({ Tags: [] });
    });
    await update({ ...BASE, WarmThroughput: { ReadUnitsPerSecond: 13000 } }, BASE);
    expect(afterSend).toEqual(['UPDATING', 'UPDATING', 'ACTIVE', 'ACTIVE']);
  });

  it('reports a changed unusable WarmThroughput once, and an unchanged one not at all', async () => {
    live = { ...live, WarmThroughput: { ReadUnitsPerSecond: 12000 } };
    const bad = { ...BASE, WarmThroughput: { ReadUnitsPerSecond: 'many' } };
    await update(bad, bad);
    expect(warnSpy.mock.calls.flat().join('\n')).not.toContain('WarmThroughput');
    await update(bad, BASE);
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('WarmThroughput');
    expect(updates()).toEqual([]);
  });

  it('masks a table name below the substring floor in the decrease warning', async () => {
    live = { ...live, TableName: 'abc', WarmThroughput: { ReadUnitsPerSecond: 13000 } };
    await new DynamoDBGlobalTableProvider().update(
      'T',
      'abc',
      RESOURCE_TYPE,
      { ...BASE, TableName: 'abc', WarmThroughput: { ReadUnitsPerSecond: 12500 } },
      { ...BASE, TableName: 'abc' },
      { maskSecrets: (text: string) => (text === 'abc' ? '***' : text) }
    );
    const line = warnSpy.mock.calls.flat().join('\n');
    expect(line).toContain('table ***: WarmThroughput was NOT sent');
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

  it('marks the read capacity unsettled before the call', async () => {
    live = { ...live, ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 } };
    const markUnsettled = vi.fn();
    await update(
      { ...provisioned, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 8 } },
      provisioned,
      { markUnsettled }
    );
    expect(markUnsettled).toHaveBeenCalledWith('ReadProvisionedThroughputSettings');
  });

  it('sends the capacity when the block moves from the table level to the local replica', async () => {
    live = { ...live, ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 } };
    await update(
      {
        ...BASE,
        BillingMode: 'PROVISIONED',
        Replicas: [
          { ...ENABLED_REPLICA[0], ReadProvisionedThroughputSettings: { ReadCapacityUnits: 8 } },
        ],
      },
      provisioned
    );
    expect(updates().filter((u) => u['ProvisionedThroughput'])).toEqual([
      {
        TableName: TABLE,
        ProvisionedThroughput: { ReadCapacityUnits: 8, WriteCapacityUnits: 3 },
      },
    ]);
  });

  it('sends no capacity to a table turned on-demand out of band', async () => {
    live = {
      ...live,
      BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
      ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
    };
    await update(
      { ...provisioned, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 8 } },
      provisioned
    );
    expect(updates().filter((u) => u['ProvisionedThroughput'])).toEqual([]);
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

  describe('go-to-k/cdkd#5604: a capacity change with no billing flip', () => {
    const scaling = (min: number): Rec => ({
      WriteCapacityAutoScalingSettings: { MinCapacity: min, MaxCapacity: 9 },
    });
    const localRead = (read: unknown): Rec[] => [
      { Region: 'us-east-1', ReadProvisionedThroughputSettings: read },
    ];
    const local = (read: unknown, write: Rec): Rec => ({
      ...BASE,
      BillingMode: 'PROVISIONED',
      Replicas: localRead(read),
      WriteProvisionedThroughputSettings: write,
    });
    const throughputs = (): Rec[] =>
      updates()
        .filter((u) => u['ProvisionedThroughput'])
        .map((u) => u['ProvisionedThroughput'] as Rec);

    beforeEach(() => {
      live = { ...live, ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 } };
    });

    it('takes a live list naming only the local region as single-region', async () => {
      const added = { Region: 'us-west-2' };
      live = { ...live, Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }] };
      const respond = mockSend.getMockImplementation() as (c: unknown) => unknown;
      mockSend.mockImplementation((command: { input: Rec }) => {
        if ((command.input['ReplicaUpdates'] as Rec[] | undefined)?.[0]?.['Create']) {
          live = {
            ...live,
            Replicas: [
              ...(live['Replicas'] as Rec[]),
              { RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' },
            ],
          };
        }
        return respond(command);
      });
      const next = local({ ReadCapacityUnits: 8 }, scaling(3));
      await update(
        { ...next, Replicas: [...(next['Replicas'] as Rec[]), added] },
        local({ ReadCapacityUnits: 7 }, scaling(3))
      );
      expect(throughputs()).toEqual([{ ReadCapacityUnits: 8, WriteCapacityUnits: 3 }]);
    });

    it('leaves adding a region to a literal write side to AWS on a replay', async () => {
      const one = local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 });
      const refused = new Error('Table write capacity should either be Pay-Per-Request or AutoScaled');
      const respond = mockSend.getMockImplementation() as (c: unknown) => unknown;
      mockSend.mockImplementation((command: { input: Rec }) =>
        (command.input['ReplicaUpdates'] as Rec[] | undefined)?.[0]?.['Create']
          ? Promise.reject(refused)
          : respond(command)
      );
      await expect(
        update(
          { ...one, Replicas: [...(one['Replicas'] as Rec[]), { Region: 'us-west-2' }] },
          one,
          { replayingState: true }
        )
      ).rejects.toThrow(/should either be Pay-Per-Request/);
      expect(warnSpy.mock.calls.flat().join('\n')).not.toContain('The capacity was not sent');
    });

    it('refuses adding a region to a literal write side, before the first write', async () => {
      const one = local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 });
      const two = {
        ...local({ ReadCapacityUnits: 8 }, { WriteCapacityUnits: 3 }),
        Replicas: [
          ...localRead({ ReadCapacityUnits: 8 }),
          { Region: 'us-west-2', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 2 } },
        ],
      };
      await expect(update(two, one)).rejects.toThrow(/auto-scaled write side/);
      expect(updates()).toEqual([]);
    });

    it('sends a flat read change on the local replica with the write side AWS holds', async () => {
      await update(
        local({ ReadCapacityUnits: 8 }, scaling(3)),
        local({ ReadCapacityUnits: 7 }, scaling(3))
      );
      expect(throughputs()).toEqual([{ ReadCapacityUnits: 8, WriteCapacityUnits: 3 }]);
    });

    it('marks a local read change unsettled on Replicas, the key it lives under', async () => {
      const markUnsettled = vi.fn();
      await update(
        local({ ReadCapacityUnits: 8 }, scaling(3)),
        local({ ReadCapacityUnits: 7 }, scaling(3)),
        { markUnsettled }
      );
      expect(markUnsettled).toHaveBeenCalledWith('Replicas');
    });

    it('sends a literal write change with the read side AWS holds', async () => {
      const markUnsettled = vi.fn();
      await update(
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: '4' }),
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 }),
        { markUnsettled }
      );
      expect(throughputs()).toEqual([{ ReadCapacityUnits: 7, WriteCapacityUnits: 4 }]);
      expect(markUnsettled).toHaveBeenCalledWith('WriteProvisionedThroughputSettings');
      expect(markUnsettled).not.toHaveBeenCalledWith('Replicas');
    });

    it('sends a read and a write change in ONE call', async () => {
      await update(
        local({ ReadCapacityUnits: 8 }, { WriteCapacityUnits: 4 }),
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 })
      );
      expect(throughputs()).toEqual([{ ReadCapacityUnits: 8, WriteCapacityUnits: 4 }]);
    });

    it('sends a table-level read and a write change in one call, too', async () => {
      await update(
        {
          ...provisioned,
          ReadProvisionedThroughputSettings: { ReadCapacityUnits: 8 },
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 4 },
        },
        { ...provisioned, WriteProvisionedThroughputSettings: { WriteCapacityUnits: 3 } }
      );
      expect(throughputs()).toEqual([{ ReadCapacityUnits: 8, WriteCapacityUnits: 4 }]);
    });

    it('waits for the table to settle before the next step', async () => {
      await update(
        local({ ReadCapacityUnits: 8 }, { WriteCapacityUnits: 4 }),
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 })
      );
      const names = mockSend.mock.calls.map(
        (call) => (call[0] as { constructor: { name: string } }).constructor.name
      );
      expect(names).toContain('UpdateTableCommand');
      expect(names[names.indexOf('UpdateTableCommand') + 1]).toBe('DescribeTableCommand');
    });

    it('sends no literal for an auto-scaled side, whichever way it changes', async () => {
      const read = { ReadCapacityUnits: 7 };
      await update(local(read, scaling(4)), local(read, scaling(3)));
      await update(local(read, scaling(3)), local(read, { WriteCapacityUnits: 3 }));
      const autoRead = { ReadCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 9 } };
      await update(local(autoRead, scaling(3)), local(read, scaling(3)));
      expect(throughputs()).toEqual([]);
    });

    it('takes a block declaring a literal beside auto-scaling as auto-scaled', async () => {
      await update(
        local(
          {
            ReadCapacityUnits: 8,
            ReadCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 9 },
          },
          scaling(3)
        ),
        local({ ReadCapacityUnits: 7 }, scaling(3))
      );
      expect(throughputs()).toEqual([]);
    });

    it('sends the literal a block moving off auto-scaling declares', async () => {
      const autoRead = { ReadCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 9 } };
      await update(
        local({ ReadCapacityUnits: 8 }, scaling(3)),
        local(autoRead, scaling(3))
      );
      expect(throughputs()).toEqual([{ ReadCapacityUnits: 8, WriteCapacityUnits: 3 }]);
    });

    it('sends nothing for a changed spelling of what AWS holds', async () => {
      await update(
        local({ ReadCapacityUnits: '7' }, { WriteCapacityUnits: '3' }),
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 })
      );
      expect(throughputs()).toEqual([]);
    });

    it('sends nothing on a billing flip beyond the flip, nor to an out-of-band on-demand table', async () => {
      live = {
        ...live,
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
      };
      await update(local({ ReadCapacityUnits: 8 }, { WriteCapacityUnits: 4 }), {
        ...local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 }),
        BillingMode: 'PAY_PER_REQUEST',
      });
      expect(updates().filter((u) => u['ProvisionedThroughput'])).toHaveLength(1);
      expect(updates().find((u) => u['ProvisionedThroughput'])?.['BillingMode']).toBe('PROVISIONED');
      mockSend.mockClear();
      await update(
        local({ ReadCapacityUnits: 8 }, { WriteCapacityUnits: 4 }),
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 })
      );
      expect(throughputs()).toEqual([]);
    });

    it('reports a changed literal it cannot read, and sends nothing for it', async () => {
      await update(
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: { Ref: 'X' } }),
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 })
      );
      expect(throughputs()).toEqual([]);
      expect(warnSpy.mock.calls.flat().join('\n')).toMatch(
        /WriteProvisionedThroughputSettings\.WriteCapacityUnits is declared but did not resolve.*the old value stays on AWS/
      );
    });

    it('masks the value the report names', async () => {
      await update(
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 'a"b' }),
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 }),
        { maskSecrets: (text: string) => text.replaceAll('a"b', '***') }
      );
      const warned = warnSpy.mock.calls.flat().join('\n');
      expect(warned).toContain('did not resolve');
      expect(warned).not.toContain('a\\"b');
    });

    it('does not report an unreadable block the update did not change', async () => {
      const bag = local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: { Ref: 'X' } });
      await update({ ...bag, Tags: [] }, bag);
      expect(warnSpy.mock.calls.flat().join('\n')).not.toContain('did not resolve');
    });

    describe('with a cross-region replica, whose override ProvisionedThroughput clears', () => {
      const replicated = (read: number, write: Rec): Rec => ({
        ...local({ ReadCapacityUnits: read }, write),
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        Replicas: [
          ...localRead({ ReadCapacityUnits: read }),
          { Region: 'us-west-2', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 2 } },
        ],
      });
      const override = { ReadCapacityUnits: 2 };
      let regionalRead: number;
      const regionalClient = () =>
        vi.spyOn(
          DynamoDBGlobalTableProvider.prototype as unknown as { getRegionalClient: () => unknown },
          'getRegionalClient'
        );
      afterEach(() => {
        regionalClient().mockRestore();
      });
      beforeEach(() => {
        regionalRead = 2;
        regionalClient().mockImplementation(() => ({
          send: (command: { constructor: { name: string } }) =>
            command.constructor.name === 'DescribeTableCommand'
              ? Promise.resolve({
                  Table: {
                    ...live,
                    ProvisionedThroughput: { ReadCapacityUnits: regionalRead, WriteCapacityUnits: 3 },
                  },
                })
              : mockSend(command),
        }));
        live = {
          ...live,
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
          Replicas: [
            { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
            {
              RegionName: 'us-west-2',
              ReplicaStatus: 'ACTIVE',
              ProvisionedThroughputOverride: override,
            },
          ],
        };
      });
      const replicaUpdates = (): unknown[] =>
        updates().flatMap((u) => (u['ReplicaUpdates'] as unknown[] | undefined) ?? []);

      it('sends a local read change as the local override', async () => {
        await update(replicated(8, scaling(3)), replicated(7, scaling(3)));
        expect(throughputs()).toEqual([]);
        expect(replicaUpdates()).toContainEqual({
          Update: {
            RegionName: 'us-east-1',
            ProvisionedThroughputOverride: { ReadCapacityUnits: 8 },
          },
        });
      });

      it('updates only the local region, and never with ProvisionedThroughput', async () => {
        await update(replicated(8, scaling(3)), replicated(7, scaling(3)));
        expect(throughputs()).toEqual([]);
        expect(replicaUpdates()).toEqual([
          {
            Update: {
              RegionName: 'us-east-1',
              ProvisionedThroughputOverride: { ReadCapacityUnits: 8 },
            },
          },
        ]);
      });

      const warned = (): string => warnSpy.mock.calls.flat().join('\n');
      const tagged = {
        ...replicated(7, { WriteCapacityUnits: 4 }),
        Replicas: [
          {
            Region: 'us-east-1',
            ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 },
            Tags: [{ Key: 'k', Value: 'v' }],
          },
          { Region: 'us-west-2', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 2 } },
        ],
      };

      it('refuses a literal write change before the first write', async () => {
        await expect(update(tagged, replicated(7, { WriteCapacityUnits: 3 }))).rejects.toThrow(
          /needs an auto-scaled write side.*Nothing was applied.*WriteCapacityAutoScalingSettings/s
        );
        const names = mockSend.mock.calls.map(
          (call) => (call[0] as { constructor: { name: string } }).constructor.name
        );
        expect(new Set(names)).toEqual(new Set(['DescribeTableCommand']));
      });

      it('refuses moving off auto-scaling, whichever the new side says', async () => {
        await expect(
          update(replicated(7, { WriteCapacityUnits: 3 }), replicated(7, scaling(3)))
        ).rejects.toThrow(/auto-scaled write side/);
        const { WriteProvisionedThroughputSettings: _w, ...absent } = replicated(7, {});
        await expect(update(absent, replicated(7, scaling(3)))).rejects.toThrow(
          /auto-scaled write side/
        );
        expect(updates()).toEqual([]);
      });

      it('refuses a read change on a literal table', async () => {
        await expect(
          update(replicated(8, { WriteCapacityUnits: 3 }), replicated(7, { WriteCapacityUnits: 3 }))
        ).rejects.toThrow(/auto-scaled write side/);
      });

      it('leaves a flip to on-demand alone', async () => {
        await expect(
          update(
            { ...replicated(7, { WriteCapacityUnits: 3 }), BillingMode: 'PAY_PER_REQUEST' },
            replicated(7, scaling(3))
          )
        ).resolves.toBeDefined();
      });

      it('refuses a flip from on-demand to a literal write side', async () => {
        live = { ...live, BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } };
        const literal = replicated(7, { WriteCapacityUnits: 3 });
        await expect(
          update(literal, { ...literal, BillingMode: 'PAY_PER_REQUEST' })
        ).rejects.toThrow(/auto-scaled write side/);
        expect(updates()).toEqual([]);
      });

      const leavesOneRegion = (write: Rec): Rec => ({
        ...replicated(7, write),
        Replicas: (replicated(7, write)['Replicas'] as Rec[]).slice(0, 1),
      });
      const dropReplicaOnDelete = (): void => {
        const respond = mockSend.getMockImplementation() as (c: unknown) => unknown;
        mockSend.mockImplementation((command: { input: Rec }) => {
          if ((command.input['ReplicaUpdates'] as Rec[] | undefined)?.[0]?.['Delete']) {
            live = { ...live, Replicas: (live['Replicas'] as Rec[]).slice(0, 1) };
          }
          return respond(command);
        });
      };

      it.each([
        ['forward', {}],
        ['replay', { replayingState: true }],
      ])(
        'takes a literal write on the table dropping its last other region (%s)',
        async (_label, context) => {
          dropReplicaOnDelete();
          await update(leavesOneRegion({ WriteCapacityUnits: 4 }), replicated(7, scaling(3)), context);
          expect(throughputs()).toEqual([{ ReadCapacityUnits: 7, WriteCapacityUnits: 4 }]);
          expect(replicaUpdates().filter((u) => (u as Rec)['Update'])).toEqual([]);
          expect(warned()).not.toContain('auto-scaled write side');
          expect(
            scalingSend.mock.calls.filter(
              (c) => (c[0] as object).constructor.name === 'DeregisterScalableTargetCommand'
            )
          ).toHaveLength(1);
        }
      );

      it('sends a read change as ProvisionedThroughput on the table leaving one region', async () => {
        dropReplicaOnDelete();
        const moved = leavesOneRegion(scaling(3));
        (moved['Replicas'] as Rec[])[0]!['ReadProvisionedThroughputSettings'] = {
          ReadCapacityUnits: 8,
        };
        await update(moved, replicated(7, scaling(3)));
        expect(throughputs()).toEqual([{ ReadCapacityUnits: 8, WriteCapacityUnits: 3 }]);
      });

      it('waits for the whole group before the next replica step', async () => {
        const statuses = ['UPDATING', 'ACTIVE'];
        let leftAtReplicaStep: number | undefined;
        const respond = mockSend.getMockImplementation() as (c: unknown) => unknown;
        mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
          const entry = (command.input['ReplicaUpdates'] as Rec[] | undefined)?.[0];
          const region = (entry?.['Update'] as Rec | undefined)?.['RegionName'];
          if (region === 'us-west-2') leftAtReplicaStep ??= statuses.length;
          const moved = updates().some((u) => u['ReplicaUpdates']);
          if (moved && command.constructor.name === 'DescribeTableCommand') {
            const ReplicaStatus = statuses.shift() ?? 'ACTIVE';
            const Replicas = (live['Replicas'] as Rec[]).map((r) => ({ ...r, ReplicaStatus }));
            return Promise.resolve({ Table: { ...live, Replicas } });
          }
          return respond(command);
        });
        const next = replicated(8, scaling(3));
        (next['Replicas'] as Rec[])[1]!['ReadProvisionedThroughputSettings'] = {
          ReadCapacityUnits: 6,
        };
        await update(next, replicated(7, scaling(3)));
        expect(leftAtReplicaStep).toBe(0);
      });

      it('masks the refusal and the warning', async () => {
        const maskSecrets = (text: string): string => text.replaceAll('auto-scaled write', '***');
        await expect(
          update(replicated(8, { WriteCapacityUnits: 4 }), replicated(7, scaling(3)), {
            maskSecrets,
          })
        ).rejects.toThrow(/needs an \*\*\* side/);
        await update(replicated(8, { WriteCapacityUnits: 4 }), replicated(7, scaling(3)), {
          maskSecrets,
          replayingState: true,
        });
        expect(warned()).toContain('needs an *** side');
      });

      it('lets a literal table through when no capacity moves', async () => {
        await update(
          replicated(7, { WriteCapacityUnits: '3' }),
          replicated(7, { WriteCapacityUnits: 3 })
        );
        expect(throughputs()).toEqual([]);
      });

      it.each([['replayingState'], ['desiredFromAwsReadback']])(
        'warns and skips the capacity on a %s bag, with no regional read',
        async (flag) => {
          regionalClient().mockImplementation(() => ({
            send: () => Promise.reject(new Error('regional read')),
          }));
          await update(replicated(8, { WriteCapacityUnits: 4 }), replicated(7, scaling(3)), {
            [flag]: true,
          });
          expect(throughputs()).toEqual([]);
          expect(replicaUpdates()).toEqual([]);
          expect(warned()).toContain('The capacity was not sent.');
          expect(
            scalingSend.mock.calls.filter(
              (c) => (c[0] as object).constructor.name === 'DeregisterScalableTargetCommand'
            )
          ).toEqual([]);
        }
      );

      it('registers a declared write target before a capacity send', async () => {
        const order: string[] = [];
        const respond = mockSend.getMockImplementation() as (c: unknown) => unknown;
        scalingSend.mockImplementation((command: { constructor: { name: string } }) => {
          order.push(command.constructor.name);
          return Promise.resolve({ ScalableTargets: [], ScalingPolicies: [] });
        });
        mockSend.mockImplementation((command: { input: Rec }) => {
          if (command.input['ReplicaUpdates']) order.push('ReplicaUpdates');
          return respond(command);
        });
        await update(replicated(8, scaling(3)), replicated(7, { WriteCapacityUnits: 3 }));
        expect(order.indexOf('RegisterScalableTargetCommand')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('RegisterScalableTargetCommand')).toBeLessThan(
          order.indexOf('ReplicaUpdates')
        );
      });

      it('settles Replicas across two runs: the read-back reads what was sent', async () => {
        const provider = new DynamoDBGlobalTableProvider();
        const previous = replicated(7, scaling(3));
        const desired = replicated(8, scaling(3));
        await provider.update('T', TABLE, RESOURCE_TYPE, desired, previous, {});
        live = { ...live, ProvisionedThroughput: { ReadCapacityUnits: 8, WriteCapacityUnits: 3 } };
        const prove = (): Promise<string[]> =>
          unsettledAfterUpdate({
            provider,
            physicalId: TABLE,
            logicalId: 'T',
            resourceType: RESOURCE_TYPE,
            recordedProperties: desired,
            names: new Set(['Replicas']),
            desired,
          });
        expect(await prove()).toEqual([]);
        regionalRead = 5;
        expect(await prove()).toEqual(['Replicas']);

        regionalRead = 2;
        mockSend.mockClear();
        const projected = await provider.readUnsettled(
          TABLE,
          'T',
          RESOURCE_TYPE,
          new Set(['Replicas']),
          desired,
          desired
        );
        await provider.update('T', TABLE, RESOURCE_TYPE, desired, {
          ...desired,
          Replicas: (projected as Rec)['Replicas'],
        }, { unsettledProperties: new Set(['Replicas']) });
        expect(replicaUpdates().filter((u) => (u as { Update?: Rec }).Update?.['ProvisionedThroughputOverride'])).toEqual([]);
      });

      it('leaves a plain read free of the flat replica read', async () => {
        const read = (await new DynamoDBGlobalTableProvider().readCurrentState(
          TABLE,
          'T',
          RESOURCE_TYPE
        )) as Rec;
        for (const replica of read['Replicas'] as Rec[]) {
          expect(replica).not.toHaveProperty('ReadProvisionedThroughputSettings');
        }
      });
    });

    it('re-sends an added replica override: DynamoDB drops the one on Create', async () => {
      const west = {
        Region: 'us-west-2',
        ReadProvisionedThroughputSettings: { ReadCapacityUnits: 2 },
      };
      const one = local({ ReadCapacityUnits: 7 }, scaling(3));
      const two = { ...one, Replicas: [...(one['Replicas'] as Rec[]), west] };
      let created = false;
      const respond = mockSend.getMockImplementation() as (c: unknown) => unknown;
      mockSend.mockImplementation((command: { input: Rec }) => {
        if ((command.input['ReplicaUpdates'] as Rec[] | undefined)?.[0]?.['Create']) {
          created = true;
          live = {
            ...live,
            Replicas: [{ RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' }],
          };
        }
        return respond(command);
      });
      await update(two, one);
      expect(created).toBe(true);
      const sentUpdates = updates().flatMap((u) => (u['ReplicaUpdates'] as Rec[] | undefined) ?? []);
      expect(sentUpdates).toContainEqual({
        Update: {
          RegionName: 'us-west-2',
          ProvisionedThroughputOverride: { ReadCapacityUnits: 2 },
        },
      });
      expect(sentUpdates.findIndex((u) => u['Create'])).toBeLessThan(
        sentUpdates.findIndex((u) => u['Update'])
      );
    });

    describe('the override a replica Create drops', () => {
      const one = local({ ReadCapacityUnits: 7 }, scaling(3));
      const gsiOverride = {
        IndexName: 'gsi1',
        ReadProvisionedThroughputSettings: { ReadCapacityUnits: 5 },
      };
      const sentUpdate = async (replica: Rec): Promise<Rec | undefined> => {
        const respond = mockSend.getMockImplementation() as (c: unknown) => unknown;
        mockSend.mockImplementation((command: { input: Rec }) => {
          if ((command.input['ReplicaUpdates'] as Rec[] | undefined)?.[0]?.['Create']) {
            live = { ...live, Replicas: [{ RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' }] };
          }
          return respond(command);
        });
        await update({ ...one, Replicas: [...(one['Replicas'] as Rec[]), replica] }, one);
        return updates()
          .flatMap((u) => (u['ReplicaUpdates'] as Rec[] | undefined) ?? [])
          .find((u) => u['Update'])?.['Update'] as Rec | undefined;
      };

      it('re-sends a per-index override alone', async () => {
        expect(
          await sentUpdate({ Region: 'us-west-2', GlobalSecondaryIndexes: [gsiOverride] })
        ).toEqual({
          RegionName: 'us-west-2',
          GlobalSecondaryIndexes: [
            { IndexName: 'gsi1', ProvisionedThroughputOverride: { ReadCapacityUnits: 5 } },
          ],
        });
      });

      it('re-sends both in one Update', async () => {
        expect(
          await sentUpdate({
            Region: 'us-west-2',
            ReadProvisionedThroughputSettings: { ReadCapacityUnits: 2 },
            GlobalSecondaryIndexes: [gsiOverride],
          })
        ).toEqual({
          RegionName: 'us-west-2',
          ProvisionedThroughputOverride: { ReadCapacityUnits: 2 },
          GlobalSecondaryIndexes: [
            { IndexName: 'gsi1', ProvisionedThroughputOverride: { ReadCapacityUnits: 5 } },
          ],
        });
      });

      it('sends no Update for a replica declaring no override', async () => {
        expect(await sentUpdate({ Region: 'us-west-2' })).toBeUndefined();
      });
    });

    it('settles after re-sending, before the next replica', async () => {
      const replica = (Region: string): Rec => ({
        Region,
        ReadProvisionedThroughputSettings: { ReadCapacityUnits: 2 },
      });
      const one = local({ ReadCapacityUnits: 7 }, scaling(3));
      const statuses = ['UPDATING', 'ACTIVE'];
      let sent = false;
      let leftAtSecondCreate: number | undefined;
      const respond = mockSend.getMockImplementation() as (c: unknown) => unknown;
      mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
        const entry = (command.input['ReplicaUpdates'] as Rec[] | undefined)?.[0];
        const created = entry?.['Create'] as Rec | undefined;
        if (created) {
          if (created['RegionName'] === 'eu-west-1') leftAtSecondCreate = statuses.length;
          live = {
            ...live,
            Replicas: [
              ...((live['Replicas'] as Rec[] | undefined) ?? []),
              { RegionName: created['RegionName'], ReplicaStatus: 'ACTIVE' },
            ],
          };
        }
        if (entry?.['Update']) sent = true;
        if (sent && leftAtSecondCreate === undefined && command.constructor.name === 'DescribeTableCommand') {
          return Promise.resolve({ Table: { ...live, TableStatus: statuses.shift() ?? 'ACTIVE' } });
        }
        return respond(command);
      });
      await update(
        { ...one, Replicas: [...(one['Replicas'] as Rec[]), replica('us-west-2'), replica('eu-west-1')] },
        one
      );
      expect(leftAtSecondCreate).toBe(0);
    });

    it('takes the local replica read over a table-level block', async () => {
      const both = (read: number): Rec => ({
        ...local({ ReadCapacityUnits: read }, scaling(3)),
        ReadProvisionedThroughputSettings: { ReadCapacityUnits: 9 },
      });
      // Both at once is refused on a template, so only a state-borne bag gets here.
      await update(both(8), both(7), { replayingState: true });
      expect(throughputs()).toEqual([{ ReadCapacityUnits: 8, WriteCapacityUnits: 3 }]);
    });

    it('names the block an unreadable read lives in', async () => {
      await update(
        local({ ReadCapacityUnits: { Ref: 'X' } }, scaling(3)),
        local({ ReadCapacityUnits: 7 }, scaling(3))
      );
      expect(warnSpy.mock.calls.flat().join('\n')).toContain(
        'Replicas[local].ReadProvisionedThroughputSettings.ReadCapacityUnits is declared'
      );
      warnSpy.mockClear();
      await update(
        {
          ...BASE,
          BillingMode: 'PROVISIONED',
          Replicas: ENABLED_REPLICA,
          ReadProvisionedThroughputSettings: { ReadCapacityUnits: { Ref: 'X' } },
        },
        {
          ...BASE,
          BillingMode: 'PROVISIONED',
          Replicas: ENABLED_REPLICA,
          ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 },
        }
      );
      expect(warnSpy.mock.calls.flat().join('\n')).toMatch(
        /(?<!\.)ReadProvisionedThroughputSettings\.ReadCapacityUnits is declared/
      );
    });

    it('marks only the side that moves', async () => {
      const markUnsettled = vi.fn();
      await update(
        local({ ReadCapacityUnits: 8 }, { WriteCapacityUnits: 3 }),
        local({ ReadCapacityUnits: 7 }, { WriteCapacityUnits: 3 }),
        { markUnsettled }
      );
      expect(markUnsettled.mock.calls.flat()).not.toContain('WriteProvisionedThroughputSettings');
    });

    it('settles the table before re-sending an added replica override', async () => {
      const west = {
        Region: 'us-west-2',
        ReadProvisionedThroughputSettings: { ReadCapacityUnits: 2 },
      };
      const one = local({ ReadCapacityUnits: 7 }, scaling(3));
      const statuses = ['UPDATING', 'ACTIVE'];
      let leftAtUpdate: number | undefined;
      let replicaActive = false;
      const respond = mockSend.getMockImplementation() as (c: unknown) => unknown;
      mockSend.mockImplementation(
        (command: { constructor: { name: string }; input: Rec }) => {
          const entry = (command.input['ReplicaUpdates'] as Rec[] | undefined)?.[0];
          if (entry?.['Create']) {
            live = { ...live, Replicas: [{ RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' }] };
          }
          if (entry?.['Update']) leftAtUpdate ??= statuses.length;
          if (command.constructor.name === 'DescribeTableCommand' && live['Replicas']) {
            if (!replicaActive) {
              replicaActive = true;
              return respond(command);
            }
            return Promise.resolve({
              Table: { ...live, TableStatus: statuses.shift() ?? 'ACTIVE' },
            });
          }
          return respond(command);
        }
      );
      await update({ ...one, Replicas: [...(one['Replicas'] as Rec[]), west] }, one);
      expect(leftAtUpdate).toBe(0);
    });

    it('sends a cross-region override with the replica, not ProvisionedThroughput', async () => {
      const two = (read: number): Rec => ({
        ...local({ ReadCapacityUnits: 7 }, scaling(3)),
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        Replicas: [
          ...localRead({ ReadCapacityUnits: 7 }),
          { Region: 'us-west-2', ReadProvisionedThroughputSettings: { ReadCapacityUnits: read } },
        ],
      });
      live = { ...live, Replicas: ['us-east-1', 'us-west-2'].map((RegionName) => ({
          RegionName,
          ReplicaStatus: 'ACTIVE',
        })) };
      await update(two(6), two(5));
      expect(throughputs()).toEqual([]);
      expect(JSON.stringify(updates())).toContain('"ProvisionedThroughputOverride":{"ReadCapacityUnits":6}');
    });
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

  it('reads a raised WarmThroughput as the declared value while AWS is still UPDATING', async () => {
    const declared = { ...BASE, WarmThroughput: { ReadUnitsPerSecond: 14000 } };
    live = { ...live, WarmThroughput: { ReadUnitsPerSecond: 13000, Status: 'UPDATING' } };
    expect(((await read(declared)) as Rec)['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 14000 });
    live = { ...live, WarmThroughput: { ReadUnitsPerSecond: 13000, Status: 'ACTIVE' } };
    expect(((await read(declared)) as Rec)['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 13000 });
    live = { ...live, WarmThroughput: { ReadUnitsPerSecond: 15000, Status: 'UPDATING' } };
    expect(((await read(declared)) as Rec)['WarmThroughput']).toEqual({ ReadUnitsPerSecond: 15000 });
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
  it('waits out a building vector index before the first DeleteTable', async () => {
    let reads = 0;
    let lastStatus = '';
    let statusAtDelete: string | undefined;
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'DescribeTableCommand') {
        if (statusAtDelete !== undefined) {
          return Promise.reject(
            new ResourceNotFoundException({ message: 'gone', $metadata: {} })
          );
        }
        reads += 1;
        lastStatus = reads < 3 ? 'CREATING' : 'ACTIVE';
        return Promise.resolve({
          Table: { ...live, VectorIndexes: [{ IndexName: 'vec1', IndexStatus: lastStatus }] },
        });
      }
      if (name === 'DeleteTableCommand') statusAtDelete = lastStatus;
      return Promise.resolve({ ScalableTargets: [], ScalingPolicies: [] });
    });
    await new DynamoDBGlobalTableProvider().delete('T', TABLE, RESOURCE_TYPE, BASE);
    expect(statusAtDelete).toBe('ACTIVE');
  });

  it('names the vector index on a refusal, and keeps the GSI wording without one', async () => {
    const refuseWith = (vectorIndexes: Rec[]): void => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        const name = command.constructor.name;
        if (name === 'DescribeTableCommand') {
          return Promise.resolve({ Table: { ...live, VectorIndexes: vectorIndexes } });
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
    };
    refuseWith([{ IndexName: 'vec1', IndexStatus: 'ACTIVE' }]);
    const named = await new DynamoDBGlobalTableProvider()
      .delete('T', TABLE, RESOURCE_TYPE, BASE)
      .catch((error: unknown) => error as Error);
    expect((named as Error).message).toContain('a global secondary index or vector index');
    refuseWith([]);
    const plain = await new DynamoDBGlobalTableProvider()
      .delete('T', TABLE, RESOURCE_TYPE, BASE)
      .catch((error: unknown) => error as Error);
    expect((plain as Error).message).toContain('a global secondary index is still');
  }, 30_000);
});


describe('the read-capacity and vector send paths', () => {
  const provisioned2: Rec = {
    ...BASE,
    BillingMode: 'PROVISIONED',
    Replicas: ENABLED_REPLICA,
    WriteProvisionedThroughputSettings: { WriteCapacityAutoScalingSettings: { MinCapacity: 1, MaxCapacity: 5, TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 } } },
    ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 },
  };
  const onDemand2: Rec = { ...BASE, Replicas: ENABLED_REPLICA };

  it('waits for an index already building before the first vector op', async () => {
    const order: string[] = [];
    let reads = 0;
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      const name = command.constructor.name;
      if (name === 'DescribeTableCommand') {
        reads += 1;
        const status = reads === 1 ? 'CREATING' : 'ACTIVE';
        order.push(status);
        return Promise.resolve({ Table: { ...live, VectorIndexes: [{ IndexName: 'other', IndexStatus: status }] } });
      }
      if (name === 'UpdateTableCommand') order.push('op');
      return Promise.resolve({});
    });
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
    try {
      await (new DynamoDBGlobalTableProvider() as unknown as { applyVectorIndexUpdates: (...a: unknown[]) => Promise<void> }).applyVectorIndexUpdates(
        TABLE, 'T', { ops: [{ Create: VEC('vec1') }], adopted: [], alreadyGone: [], changed: [] }, undefined, (s: string) => s);
    } finally { timers.mockRestore(); }
    expect(order.slice(0, 3)).toEqual(['CREATING', 'ACTIVE', 'op']);
  });

  it('holds the wait after a capacity send, ahead of the warm send', async () => {
    const order: string[] = [];
    let building = 0;
    mockSend.mockImplementation((command: { constructor: { name: string }; input: Rec }) => {
      const name = command.constructor.name;
      if (name === 'DescribeTableCommand') {
        const status = building > 0 ? 'UPDATING' : 'ACTIVE';
        if (building > 0) building -= 1;
        order.push(status);
        return Promise.resolve({ Table: { ...live, TableStatus: status, BillingModeSummary: { BillingMode: 'PROVISIONED' }, ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 } } });
      }
      if (name === 'UpdateTableCommand') { order.push(command.input['WarmThroughput'] ? 'warm' : 'cap'); building = 2; }
      return Promise.resolve({ Tags: [], ScalableTargets: [] });
    });
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
    try {
      await update({ ...provisioned2, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 8 }, WarmThroughput: { ReadUnitsPerSecond: 13000 } }, provisioned2);
    } finally { timers.mockRestore(); }
    expect(order[order.indexOf('cap') + 1]).toBe('UPDATING');
    expect(order.indexOf('warm')).toBeGreaterThan(0);
  });

  it('sends no capacity after a flip to on-demand that also changed the block', async () => {
    live = { ...live, BillingModeSummary: { BillingMode: 'PROVISIONED' }, ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 } };
    await update({ ...onDemand2, ReadProvisionedThroughputSettings: { ReadCapacityUnits: 9 } }, provisioned2);
    expect(updates().filter((u) => u['ProvisionedThroughput'] && !u['BillingMode'])).toEqual([]);
  });

  it('leaves the capacity to the flip when the record was on-demand', async () => {
    live = { ...live, BillingModeSummary: { BillingMode: 'PROVISIONED' }, ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 3 } };
    await update(provisioned2, onDemand2);
    expect(updates().filter((u) => u['ProvisionedThroughput'] && !u['BillingMode'])).toEqual([]);
  });

  it('marks the read capacity on a flip that carries it', async () => {
    live = { ...live, BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' } };
    const markUnsettled = vi.fn();
    await update(provisioned2, onDemand2, { markUnsettled });
    expect(markUnsettled.mock.calls.flat()).toContain('ReadProvisionedThroughputSettings');
  });

  it('marks the read ceiling on the deferred ceiling call', async () => {
    live = { ...live, BillingModeSummary: { BillingMode: 'PROVISIONED' }, ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 } };
    const markUnsettled = vi.fn();
    await update({ ...onDemand2, ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 } }, provisioned2, { markUnsettled });
    expect(updates().some((u) => u['OnDemandThroughput'] && !u['BillingMode'])).toBe(true);
    expect(markUnsettled.mock.calls.flat()).toContain('ReadOnDemandThroughputSettings');
  });
});

describe('the second review round', () => {
  const capacity = {
    ...BASE,
    BillingMode: 'PROVISIONED',
    Replicas: ENABLED_REPLICA,
    ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 },
  };
  const { ReadProvisionedThroughputSettings: _removed, ...noCapacity } = capacity;

  it('refuses removing the table-level capacity from a table that stays PROVISIONED', () => {
    expect(replicaSettingsRefusal(noCapacity, capacity)).toMatch(/cannot be removed/);
  });

  it('takes the removal when a replica declares the block, or the table goes on-demand', () => {
    expect(
      replicaSettingsRefusal(
        {
          ...noCapacity,
          Replicas: [
            { ...ENABLED_REPLICA[0], ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 } },
          ],
        },
        capacity
      )
    ).toBeUndefined();
    expect(
      replicaSettingsRefusal({ ...noCapacity, BillingMode: 'PAY_PER_REQUEST' }, capacity)
    ).toBeUndefined();
  });

  it('refuses an update adding the block to a replica beside the table-level one', () => {
    const before = {
      ...BASE,
      Replicas: ENABLED_REPLICA,
      ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 5 },
    };
    expect(
      replicaSettingsRefusal(
        {
          ...before,
          Replicas: [
            { ...ENABLED_REPLICA[0], ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 9 } },
          ],
        },
        before
      )
    ).toMatch(/at both the table level and a replica/);
  });

  it.each([
    ['a value that is no list', 'nonsense'],
    ['an entry with no IndexName', [{ Dimensions: 3 }]],
    ['a non-string IndexName', [{ IndexName: 7 }]],
  ])('refuses %s before any call rather than deleting what is recorded', async (_label, value) => {
    live = { ...live, VectorIndexes: [{ ...VEC('vec1'), IndexStatus: 'ACTIVE' }] };
    await expect(
      update({ ...BASE, VectorIndexes: value }, { ...BASE, VectorIndexes: [VEC('vec1')] })
    ).rejects.toThrow(/VectorIndexes/);
    expect(updates()).toEqual([]);
  });

  it('warns and deletes nothing for an unreadable list on a state replay', async () => {
    live = { ...live, VectorIndexes: [{ ...VEC('vec1'), IndexStatus: 'ACTIVE' }] };
    await update(
      { ...BASE, VectorIndexes: 'nonsense' },
      { ...BASE, VectorIndexes: [VEC('vec1')] },
      { replayingState: true }
    );
    expect(updates().filter((u) => u['VectorIndexUpdates'])).toEqual([]);
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('the VectorIndexes change was not applied');
  });

  it('does not warn about an unchanged unreadable list', async () => {
    const bag = { ...BASE, VectorIndexes: 'nonsense' };
    await update(bag, bag);
    expect(warnSpy.mock.calls.flat().join('\n')).not.toContain('VectorIndexes');
  });

  it('compares by default on an empty bag', () => {
    const provider = new DynamoDBGlobalTableProvider();
    expect(provider.getDriftUnknownPaths(RESOURCE_TYPE, {})).toEqual(['TableType']);
    expect(provider.getDriftUnknownPaths(RESOURCE_TYPE)).toEqual(['TableType']);
  });

  it('masks a short table name in the vector wait label and its timeout', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
    mockSend.mockResolvedValue({
      Table: { TableStatus: 'ACTIVE', VectorIndexes: [{ IndexStatus: 'CREATING' }] },
    });
    const wait = (
      new DynamoDBGlobalTableProvider() as unknown as {
        waitForVectorIndexesSettled: (
          name: string,
          id: string,
          mask: (text: string) => string
        ) => Promise<void>;
      }
    ).waitForVectorIndexesSettled.bind(new DynamoDBGlobalTableProvider());
    const mask = (text: string): string => (text === 'abc' ? '***' : text);
    let thrown: unknown;
    try {
      await wait('abc', 'T', mask);
    } catch (error) {
      thrown = error;
    } finally {
      timers.mockRestore();
    }
    expect(watchLabels.at(-1)).toContain('on ***');
    expect((thrown as Error).message).toContain('table *** and its vector');
  });
});
