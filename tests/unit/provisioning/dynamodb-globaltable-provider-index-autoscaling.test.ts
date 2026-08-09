import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeTableCommand, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import {
  RegisterScalableTargetCommand,
  PutScalingPolicyCommand,
  DeleteScalingPolicyCommand,
  DeregisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';

/**
 * Issue #1419 regression coverage: per-GSI application-autoscaling was never
 * registered, and `create()` registered NO autoscaling at all.
 *
 * Two independent gaps, both invisible to the pre-existing suite because the
 * #1387 integ asserted only the INITIAL capacity reaching AWS — which was
 * correct — while `MinCapacity` / `MaxCapacity` /
 * `TargetTrackingScalingPolicyConfiguration` were dropped:
 *
 *  1. No `dynamodb:index:*` scalable dimension was ever registered, so a
 *     per-GSI `*CapacityAutoScalingSettings` block produced an index pinned
 *     at its initial capacity forever.
 *  2. Only `update()` called `applyAutoScalingDiff`, so a freshly created
 *     PROVISIONED GlobalTable had no scaling policy until some later deploy
 *     happened to run an update. The LOCAL replica's read dimension was
 *     never registered by ANY path — `update()`'s replica loops all
 *     `continue` on the local region.
 *
 * The property bag is the same verbatim-`cdk synth` shape the #1387 tests
 * use, extended with the auto-scaling blocks CDK emits for
 * `Capacity.autoscaled(...)` on both the table and the index.
 */

const { mockSend, mockAutoScalingSend, autoScalingRegionSpy, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  autoScalingRegionSpy: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-application-auto-scaling')>(
      '@aws-sdk/client-application-auto-scaling'
    );
  return {
    ...actual,
    ApplicationAutoScalingClient: vi
      .fn()
      .mockImplementation((cfg: { region?: string } | undefined) => {
        autoScalingRegionSpy(cfg?.region);
        return { send: mockAutoScalingSend };
      }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
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
  collectAutoScalingTargets,
  autoScalingTargetKey,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'prov-table';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:123:table/${TABLE_NAME}`;

const TABLE_WRITE_AS = {
  MinCapacity: 1,
  MaxCapacity: 10,
  TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
};
const INDEX_WRITE_AS = {
  MinCapacity: 2,
  MaxCapacity: 20,
  SeedCapacity: 3,
  TargetTrackingScalingPolicyConfiguration: { TargetValue: 60 },
};
const TABLE_READ_AS = {
  MinCapacity: 4,
  MaxCapacity: 40,
  TargetTrackingScalingPolicyConfiguration: { TargetValue: 55, ScaleInCooldown: 61 },
};
const INDEX_READ_AS = {
  MinCapacity: 5,
  MaxCapacity: 50,
  TargetTrackingScalingPolicyConfiguration: { TargetValue: 65, DisableScaleIn: true },
};

/**
 * A PROVISIONED GlobalTable whose table AND index are auto-scaled on BOTH
 * dimensions — i.e. all four scalable dimensions are in play at once.
 */
const AUTOSCALED_PROPS: Record<string, unknown> = {
  TableName: TABLE_NAME,
  BillingMode: 'PROVISIONED',
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'g1pk', AttributeType: 'S' },
  ],
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi1',
      KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      WriteProvisionedThroughputSettings: { WriteCapacityAutoScalingSettings: INDEX_WRITE_AS },
    },
  ],
  Replicas: [
    {
      Region: 'us-east-1',
      ReadProvisionedThroughputSettings: { ReadCapacityAutoScalingSettings: TABLE_READ_AS },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          ReadProvisionedThroughputSettings: { ReadCapacityAutoScalingSettings: INDEX_READ_AS },
        },
      ],
    },
  ],
  WriteProvisionedThroughputSettings: { WriteCapacityAutoScalingSettings: TABLE_WRITE_AS },
};

function newRnf(): ResourceNotFoundException {
  return new ResourceNotFoundException({ message: 'not found', $metadata: {} });
}

/** Every `RegisterScalableTarget` input, in call order. */
function registerInputs(): Array<Record<string, unknown>> {
  return mockAutoScalingSend.mock.calls
    .map((c) => c[0])
    .filter((c): c is RegisterScalableTargetCommand => c instanceof RegisterScalableTargetCommand)
    .map((c) => c.input as unknown as Record<string, unknown>);
}

/** Every `PutScalingPolicy` input, in call order. */
function policyInputs(): Array<Record<string, unknown>> {
  return mockAutoScalingSend.mock.calls
    .map((c) => c[0])
    .filter((c): c is PutScalingPolicyCommand => c instanceof PutScalingPolicyCommand)
    .map((c) => c.input as unknown as Record<string, unknown>);
}

/** Every `(ResourceId, ScalableDimension)` pair that was DEREGISTERED. */
function deregistered(): Array<[string, string]> {
  return mockAutoScalingSend.mock.calls
    .map((c) => c[0])
    .filter(
      (c): c is DeregisterScalableTargetCommand => c instanceof DeregisterScalableTargetCommand
    )
    .map((c) => [String(c.input.ResourceId), String(c.input.ScalableDimension)]);
}

describe('DynamoDBGlobalTable per-index auto-scaling (issue #1419)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    autoScalingRegionSpy.mockReset();
    warnSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableId: 'tid-1',
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
        Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
      },
    });
    provider = new DynamoDBGlobalTableProvider();
  });

  describe('collectAutoScalingTargets', () => {
    it('finds all four dimensions, each attributed to the right region', () => {
      const specs = collectAutoScalingTargets(AUTOSCALED_PROPS, 'us-east-1');
      expect(
        specs.map((s) => ({ ...s, key: autoScalingTargetKey(s) })).map((s) => s.key).sort()
      ).toEqual(
        [
          'us-east-1|dynamodb:table:WriteCapacityUnits|',
          'us-east-1|dynamodb:index:WriteCapacityUnits|gsi1',
          'us-east-1|dynamodb:table:ReadCapacityUnits|',
          'us-east-1|dynamodb:index:ReadCapacityUnits|gsi1',
        ].sort()
      );
      expect(
        specs.find((s) => s.dimension === 'dynamodb:index:ReadCapacityUnits')?.settings
      ).toEqual(INDEX_READ_AS);
    });

    it('attributes a cross-region replica read target to the REPLICA region, not the local one', () => {
      const props = structuredClone(AUTOSCALED_PROPS) as Record<string, unknown>;
      (props['Replicas'] as unknown[]).push({
        Region: 'eu-west-1',
        ReadProvisionedThroughputSettings: { ReadCapacityAutoScalingSettings: TABLE_READ_AS },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            ReadProvisionedThroughputSettings: { ReadCapacityAutoScalingSettings: INDEX_READ_AS },
          },
        ],
      });
      const keys = collectAutoScalingTargets(props, 'us-east-1').map(autoScalingTargetKey);
      expect(keys).toContain('eu-west-1|dynamodb:table:ReadCapacityUnits|');
      expect(keys).toContain('eu-west-1|dynamodb:index:ReadCapacityUnits|gsi1');
      // WRITE capacity is owned by the source region only — a replica must
      // never contribute a write target, or the deploy would register one
      // against a region that cannot serve it.
      expect(keys.filter((k) => k.includes('WriteCapacityUnits')).every((k) => k.startsWith('us-east-1|'))).toBe(true);
    });

    it('skips a replica with no Region rather than defaulting it to the local region', () => {
      // A target registered against the wrong region's control plane is
      // invisible to every later diff and leaks on destroy.
      const props = {
        Replicas: [
          { ReadProvisionedThroughputSettings: { ReadCapacityAutoScalingSettings: TABLE_READ_AS } },
        ],
      };
      expect(collectAutoScalingTargets(props, 'us-east-1')).toEqual([]);
    });

    it('returns nothing for a template with no auto-scaling blocks', () => {
      expect(
        collectAutoScalingTargets(
          { GlobalSecondaryIndexes: [{ IndexName: 'g' }], Replicas: [{ Region: 'us-east-1' }] },
          'us-east-1'
        )
      ).toEqual([]);
    });
  });

  describe('create()', () => {
    it('registers all four scalable targets — pre-fix it registered NONE', async () => {
      await provider.create('Prov', RESOURCE_TYPE, AUTOSCALED_PROPS);

      const byDimension = new Map(
        registerInputs().map((i) => [`${String(i['ScalableDimension'])}|${String(i['ResourceId'])}`, i])
      );
      expect([...byDimension.keys()].sort()).toEqual(
        [
          `dynamodb:table:WriteCapacityUnits|table/${TABLE_NAME}`,
          `dynamodb:table:ReadCapacityUnits|table/${TABLE_NAME}`,
          `dynamodb:index:WriteCapacityUnits|table/${TABLE_NAME}/index/gsi1`,
          `dynamodb:index:ReadCapacityUnits|table/${TABLE_NAME}/index/gsi1`,
        ].sort()
      );
      // Min/Max come from the template, NOT from the initial capacity: that
      // is the whole point — an index pinned at its seed never scales.
      expect(byDimension.get(`dynamodb:index:WriteCapacityUnits|table/${TABLE_NAME}/index/gsi1`))
        .toMatchObject({ MinCapacity: 2, MaxCapacity: 20, ServiceNamespace: 'dynamodb' });
      expect(byDimension.get(`dynamodb:index:ReadCapacityUnits|table/${TABLE_NAME}/index/gsi1`))
        .toMatchObject({ MinCapacity: 5, MaxCapacity: 50 });
    });

    it('attaches a target-tracking policy per dimension, named the AWS way', async () => {
      await provider.create('Prov', RESOURCE_TYPE, AUTOSCALED_PROPS);

      const policies = policyInputs();
      expect(policies.map((p) => p['PolicyName']).sort()).toEqual(
        [
          `DynamoDBWriteCapacityUtilization:table/${TABLE_NAME}`,
          `DynamoDBReadCapacityUtilization:table/${TABLE_NAME}`,
          `DynamoDBWriteCapacityUtilization:table/${TABLE_NAME}/index/gsi1`,
          `DynamoDBReadCapacityUtilization:table/${TABLE_NAME}/index/gsi1`,
        ].sort()
      );
      // The table-level names must be byte-identical to the pre-#1419
      // spelling; a renamed policy would orphan the existing one on every
      // already-deployed table.
      const tableWrite = policies.find(
        (p) => p['PolicyName'] === `DynamoDBWriteCapacityUtilization:table/${TABLE_NAME}`
      );
      expect(tableWrite).toMatchObject({
        ResourceId: `table/${TABLE_NAME}`,
        ScalableDimension: 'dynamodb:table:WriteCapacityUnits',
        PolicyType: 'TargetTrackingScaling',
      });
      // Optional target-tracking members ride along when the template sets them.
      const indexRead = policies.find(
        (p) => p['PolicyName'] === `DynamoDBReadCapacityUtilization:table/${TABLE_NAME}/index/gsi1`
      );
      expect(indexRead?.['TargetTrackingScalingPolicyConfiguration']).toMatchObject({
        PredefinedMetricSpecification: { PredefinedMetricType: 'DynamoDBReadCapacityUtilization' },
        TargetValue: 65,
        DisableScaleIn: true,
      });
    });

    it('registers nothing on a PAY_PER_REQUEST table (AWS rejects targets there)', async () => {
      await provider.create('Prov', RESOURCE_TYPE, {
        ...AUTOSCALED_PROPS,
        BillingMode: 'PAY_PER_REQUEST',
      });
      expect(registerInputs()).toEqual([]);
    });

    it('routes a cross-region replica read target through that replica region client', async () => {
      // The replica must read back ACTIVE or `waitForReplicaActive` polls
      // forever — the create path registers the target only after the
      // replica exists.
      mockSend.mockResolvedValue({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableId: 'tid-1',
          TableStatus: 'ACTIVE',
          GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
          Replicas: [
            { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
            { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
          ],
        },
      });
      const props = structuredClone(AUTOSCALED_PROPS) as Record<string, unknown>;
      (props['Replicas'] as unknown[]).push({
        Region: 'eu-west-1',
        ReadProvisionedThroughputSettings: { ReadCapacityAutoScalingSettings: TABLE_READ_AS },
      });
      await provider.create('Prov', RESOURCE_TYPE, props);
      expect(autoScalingRegionSpy).toHaveBeenCalledWith('eu-west-1');
    });
  });

  describe('update()', () => {
    it('BACKFILLS index targets when the template is unchanged (a table created before the fix)', async () => {
      // The regression this guards: a diff-gated register would see
      // old === new and skip, leaving every pre-#1419 table permanently
      // unscaled at index level. RegisterScalableTarget is an idempotent
      // upsert, so re-asserting is safe and is what makes the fix
      // self-healing.
      await provider.update(
        'Prov',
        TABLE_NAME,
        RESOURCE_TYPE,
        AUTOSCALED_PROPS,
        structuredClone(AUTOSCALED_PROPS) as Record<string, unknown>
      );

      const ids = registerInputs().map(
        (i) => `${String(i['ScalableDimension'])}|${String(i['ResourceId'])}`
      );
      expect(ids).toContain(`dynamodb:index:WriteCapacityUnits|table/${TABLE_NAME}/index/gsi1`);
      expect(ids).toContain(`dynamodb:index:ReadCapacityUnits|table/${TABLE_NAME}/index/gsi1`);
      // The LOCAL replica's read dimension was never registered by any path
      // before this change — step 5's replica loops all skip the local region.
      expect(ids).toContain(`dynamodb:table:ReadCapacityUnits|table/${TABLE_NAME}`);
    });

    it('tears down the index targets of an index this deploy REMOVES', async () => {
      const next = structuredClone(AUTOSCALED_PROPS) as Record<string, unknown>;
      next['GlobalSecondaryIndexes'] = [];
      (next['Replicas'] as Array<Record<string, unknown>>)[0]!['GlobalSecondaryIndexes'] = [];

      await provider.update('Prov', TABLE_NAME, RESOURCE_TYPE, next, AUTOSCALED_PROPS);

      const gone = deregistered();
      expect(gone).toContainEqual([
        `table/${TABLE_NAME}/index/gsi1`,
        'dynamodb:index:WriteCapacityUnits',
      ]);
      expect(gone).toContainEqual([
        `table/${TABLE_NAME}/index/gsi1`,
        'dynamodb:index:ReadCapacityUnits',
      ]);
      // Policy must be deleted BEFORE the target — AWS rejects
      // DeregisterScalableTarget while a policy is still attached.
      const order = mockAutoScalingSend.mock.calls.map((c) => c[0]);
      const firstDelete = order.findIndex((c) => c instanceof DeleteScalingPolicyCommand);
      const firstDeregister = order.findIndex((c) => c instanceof DeregisterScalableTargetCommand);
      expect(firstDelete).toBeGreaterThanOrEqual(0);
      expect(firstDelete).toBeLessThan(firstDeregister);
    });

    it('tears down every index target on a flip to PAY_PER_REQUEST, even though the template still declares them', async () => {
      // Same forced-teardown contract as the table-level dimension: AWS
      // rejects scalable targets on an on-demand table, so what the
      // template still says is irrelevant.
      const next = { ...AUTOSCALED_PROPS, BillingMode: 'PAY_PER_REQUEST' };
      await provider.update('Prov', TABLE_NAME, RESOURCE_TYPE, next, AUTOSCALED_PROPS);

      const gone = deregistered();
      expect(gone).toContainEqual([
        `table/${TABLE_NAME}/index/gsi1`,
        'dynamodb:index:WriteCapacityUnits',
      ]);
      expect(gone).toContainEqual([`table/${TABLE_NAME}`, 'dynamodb:table:ReadCapacityUnits']);
      expect(registerInputs().filter((i) => String(i['ScalableDimension']).includes('index'))).toEqual(
        []
      );
    });

    it('registers nothing at index level when both sides are PAY_PER_REQUEST', async () => {
      const onDemand = { ...AUTOSCALED_PROPS, BillingMode: 'PAY_PER_REQUEST' };
      await provider.update('Prov', TABLE_NAME, RESOURCE_TYPE, onDemand, onDemand);
      expect(mockAutoScalingSend).not.toHaveBeenCalled();
    });
  });

  describe('delete()', () => {
    /**
     * `delete()` ends with `waitForTableGone`, which polls `DescribeTable`
     * until it raises `ResourceNotFoundException`. An always-ACTIVE mock
     * would poll forever, so serve the table once (the pre-delete describe
     * the teardown reads index names from) and RNF after that.
     */
    function describeOnceThenGone(table: Record<string, unknown>): void {
      let served = false;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeTableCommand) {
          if (served) return Promise.reject(newRnf());
          served = true;
          return Promise.resolve({ Table: table });
        }
        return Promise.resolve({});
      });
    }

    it('deregisters the per-index targets so they are not inherited by a future table of the same name', async () => {
      describeOnceThenGone({
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }],
        Replicas: [{ RegionName: 'us-east-1' }],
      });

      await provider.delete('Prov', TABLE_NAME, RESOURCE_TYPE, AUTOSCALED_PROPS);

      const gone = deregistered();
      expect(gone).toContainEqual([
        `table/${TABLE_NAME}/index/gsi1`,
        'dynamodb:index:WriteCapacityUnits',
      ]);
      expect(gone).toContainEqual([
        `table/${TABLE_NAME}/index/gsi1`,
        'dynamodb:index:ReadCapacityUnits',
      ]);
      // The pre-existing table-level teardown must still happen.
      expect(gone).toContainEqual([`table/${TABLE_NAME}`, 'dynamodb:table:WriteCapacityUnits']);
      expect(gone).toContainEqual([`table/${TABLE_NAME}`, 'dynamodb:table:ReadCapacityUnits']);
    });

    it('takes index names from the live DescribeTable, not from the (possibly stale) template', async () => {
      describeOnceThenGone({
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexName: 'live-only-index' }],
        Replicas: [{ RegionName: 'us-east-1' }],
      });

      await provider.delete('Prov', TABLE_NAME, RESOURCE_TYPE, AUTOSCALED_PROPS);

      const ids = deregistered().map(([resourceId]) => resourceId);
      expect(ids).toContain(`table/${TABLE_NAME}/index/live-only-index`);
      expect(ids).not.toContain(`table/${TABLE_NAME}/index/gsi1`);
    });
  });
});
