import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeContributorInsightsCommand,
  ListTagsOfResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateContributorInsightsCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

/**
 * go-to-k/cdkd#5489: four `AWS::DynamoDB::GlobalTable` settings that the SDK
 * route silently dropped, each now handled the way a CloudFormation A/B
 * measured (us-east-1 + us-west-2, 2026-10-28):
 *
 *  - `Replicas[].GlobalSecondaryIndexes[].ContributorInsightsSpecification`:
 *    `UpdateContributorInsights` with the `IndexName`, in each replica's
 *    region; a removed block (or a removed list) DISABLES it.
 *  - `Replicas[].ReplicaStreamSpecification.Tags`: `TagResource` /
 *    `UntagResourceCommand` on each replica's STREAM arn, diffed.
 *  - `Replicas[].GlobalTableSettingsReplicationMode`: a `CreateTable` /
 *    `UpdateTable` member; refused unless the table has exactly one replica;
 *    a removal sends `DISABLED`.
 *  - `LocalSecondaryIndexes` added or removed as a whole list: refused before
 *    any call (CFn replaces on a removal and fails an addition).
 */

const { mockSend, regionalSend, mockAutoScalingSend, warnSpy, deadline } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  regionalSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warnSpy: vi.fn(),
  deadline: { remainingMs: Number.POSITIVE_INFINITY },
}));

vi.mock('../../../src/deployment/resource-deadline.js', async () => ({
  ...(await vi.importActual<typeof import('../../../src/deployment/resource-deadline.js')>(
    '../../../src/deployment/resource-deadline.js'
  )),
  enclosingDeadlineRemainingMs: () => deadline.remainingMs,
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Every client is the SOURCE double except the eu-west-1 one, so a call's
// REGION is what a test reads.
vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: cfg?.region === 'eu-west-1' ? regionalSend : mockSend,
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
      send: mockAutoScalingSend,
    })),
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
  readReplicationMode,
  replicaSettingsRefusal,
  replicationModeCorrection,
  replicationModeUpdate,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import {
  InterruptedWaitError,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';
import {
  declaredReplicaSettings,
  keepUnreadReplicaMembers,
  planReplicaIndexInsightsOps,
  planReplicaSettingCorrections,
  planReplicaSettingOps,
  replicaSettingRefusals,
} from '../../../src/provisioning/dynamodb-replica-settings.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'gt-5489';
const LOCAL_ARN = `arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE}`;
const REMOTE_ARN = `arn:aws:dynamodb:eu-west-1:123456789012:table/${TABLE}`;
const LOCAL_STREAM = `${LOCAL_ARN}/stream/2026-10-28T00:00:00.000`;
const REMOTE_STREAM = `${REMOTE_ARN}/stream/2026-10-28T00:00:00.000`;
const INDEXES = new Set(['gsi1']);
const keepAll = (): boolean => true;

const ci = (enabled: boolean, mode?: string): Record<string, unknown> => ({
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi1',
      ContributorInsightsSpecification: { Enabled: enabled, ...(mode !== undefined && { Mode: mode }) },
    },
  ],
});
const streamTags = (...pairs: Array<[string, string]>): Record<string, unknown> => ({
  ReplicaStreamSpecification: { Tags: pairs.map(([Key, Value]) => ({ Key, Value })) },
});

const base = (
  local: Record<string, unknown> = {},
  remote: Record<string, unknown> | null = {},
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  TableName: TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'gpk', AttributeType: 'S' },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi1',
      KeySchema: [{ AttributeName: 'gpk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'KEYS_ONLY' },
    },
  ],
  StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
  Replicas: [
    { Region: 'us-east-1', ...local },
    ...(remote !== null ? [{ Region: 'eu-west-1', ...remote }] : []),
  ],
  ...extra,
});

type Sent = { constructor: { name: string }; input: Record<string, any> };
const sent = (fn: ReturnType<typeof vi.fn>, ctor: { name: string }): Array<Record<string, any>> =>
  fn.mock.calls
    .map((c) => c[0] as Sent)
    .filter((c) => c.constructor.name === ctor.name)
    .map((c) => c.input);

const WRITES = [UpdateContributorInsightsCommand, TagResourceCommand, UntagResourceCommand].map(
  (c) => c.name
);
const writes = (fn: ReturnType<typeof vi.fn>): Array<[string, Record<string, any>]> =>
  fn.mock.calls
    .map((c) => c[0] as Sent)
    .filter((c) => WRITES.includes(c.constructor.name))
    .map((c) => [c.constructor.name, c.input]);

interface Live {
  /** Per-index Contributor Insights status. */
  indexCi?: Record<string, string>;
  streamTags?: Record<string, string>;
  /** Split ListTagsOfResource into pages of this size (NextToken paging). */
  tagPageSize?: number;
  /** The table reports no stream. */
  noStream?: boolean;
  /** What DescribeTable reports as GlobalTableSettingsReplicationMode. */
  mode?: string;
  /** Whether gsi1 exists yet (default true); a GSI Create adds it. */
  gsi?: boolean;
  /** An error to throw for a command, given its input. */
  refuse?: (name: string, input: Record<string, any>) => Error | undefined;
}

const regionDouble = (
  arn: string,
  stream: string,
  live: Live,
  replicas: string[] | undefined
) => {
  return async (command: Sent): Promise<unknown> => {
    const name = command.constructor.name;
    const refusal = live.refuse?.(name, command.input);
    if (refusal) throw refusal;
    switch (name) {
      case DescribeContributorInsightsCommand.name: {
        const index = command.input['IndexName'];
        return {
          ContributorInsightsStatus:
            index === undefined ? 'DISABLED' : (live.indexCi?.[index] ?? 'DISABLED'),
        };
      }
      case ListTagsOfResourceCommand.name: {
        const all =
          command.input['ResourceArn'] === stream
            ? Object.entries(live.streamTags ?? {}).map(([Key, Value]) => ({ Key, Value }))
            : [];
        const size = live.tagPageSize ?? (all.length || 1);
        const start = Number(command.input['NextToken'] ?? 0);
        const next = start + size;
        return {
          Tags: all.slice(start, next),
          ...(next < all.length && { NextToken: String(next) }),
        };
      }
      default:
        if (name === UpdateTableCommand.name) {
          const update = command.input['ReplicaUpdates']?.[0];
          if (update?.Delete !== undefined && replicas !== undefined) {
            replicas = replicas.filter((r) => r !== update.Delete.RegionName);
          }
          if (update?.Create !== undefined && replicas !== undefined) {
            replicas = [...replicas, update.Create.RegionName];
          }
          if (command.input['GlobalSecondaryIndexUpdates']?.[0]?.Create !== undefined) {
            live.gsi = true;
          }
          if (command.input['GlobalTableSettingsReplicationMode'] !== undefined) {
            const mode = command.input['GlobalTableSettingsReplicationMode'];
            live.mode = mode === 'DISABLED' ? undefined : mode;
          }
          return {};
        }
        if (WRITES.includes(name)) return {};
        return {
          Table: {
            TableName: TABLE,
            TableArn: arn,
            TableStatus: 'ACTIVE',
            ...(live.noStream !== true && {
              LatestStreamArn: stream,
              StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
            }),
            ...(live.mode !== undefined && { GlobalTableSettingsReplicationMode: live.mode }),
            AttributeDefinitions: [
              { AttributeName: 'pk', AttributeType: 'S' },
              { AttributeName: 'gpk', AttributeType: 'S' },
            ],
            ...(live.gsi !== false && {
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'gsi1',
                  IndexStatus: 'ACTIVE',
                  KeySchema: [{ AttributeName: 'gpk', KeyType: 'HASH' }],
                  Projection: { ProjectionType: 'KEYS_ONLY' },
                },
              ],
            }),
            ...(replicas !== undefined && {
              Replicas: replicas.map((r) => ({ RegionName: r, ReplicaStatus: 'ACTIVE' })),
            }),
          },
        };
    }
  };
};

const setLive = (local: Live = {}, remote: Live = {}, replicas: string[] = ['eu-west-1']): void => {
  mockSend.mockImplementation(regionDouble(LOCAL_ARN, LOCAL_STREAM, local, replicas));
  regionalSend.mockImplementation(regionDouble(REMOTE_ARN, REMOTE_STREAM, remote, undefined));
};

describe('per-index Contributor Insights and stream tags plans (go-to-k/cdkd#5489)', () => {
  it('enables, disables and resets a removed per-index block; skips an index the table dropped', () => {
    const plan = (
      desired: Record<string, unknown>,
      previous: Record<string, unknown> | undefined,
      opts: { fresh?: boolean; indexes?: Set<string>; keep?: boolean } = {}
    ) =>
      planReplicaIndexInsightsOps(
        desired,
        previous,
        {
          fresh: opts.fresh ?? false,
          tableIndexNames: opts.indexes ?? INDEXES,
          removes: opts.keep === true ? () => false : keepAll,
        },
        () => {}
      );
    expect(plan(ci(true, 'THROTTLED_KEYS'), undefined, { fresh: true })).toEqual([
      { kind: 'indexContributorInsights', indexName: 'gsi1', action: 'ENABLE', mode: 'THROTTLED_KEYS' },
    ]);
    expect(plan(ci(false), ci(true))).toEqual([
      { kind: 'indexContributorInsights', indexName: 'gsi1', action: 'DISABLE' },
    ]);
    // The whole replica index list removed: reset, as CloudFormation does.
    expect(plan({}, ci(true))).toEqual([
      { kind: 'indexContributorInsights', indexName: 'gsi1', action: 'DISABLE' },
    ]);
    expect(plan(ci(true), ci(true))).toEqual([]);
    // A fresh replica starts disabled.
    expect(plan(ci(false), undefined, { fresh: true })).toEqual([]);
    // An index the table no longer keeps takes its rules with it.
    expect(plan(ci(true), {}, { indexes: new Set() })).toEqual([]);
    // keepOnRemoval: an absence says nothing.
    expect(plan({}, ci(true), { keep: true })).toEqual([]);
  });

  it('wires the per-index plan into planReplicaSettingOps only when the table indexes are named', () => {
    expect(planReplicaSettingOps(ci(true), undefined, { fresh: true }, () => {})).toEqual([]);
    expect(
      planReplicaSettingOps(ci(true), undefined, { fresh: true, tableIndexNames: INDEXES }, () => {})
    ).toEqual([{ kind: 'indexContributorInsights', indexName: 'gsi1', action: 'ENABLE' }]);
  });

  it('diffs the stream tags: untags removed keys, tags new and changed ones', () => {
    const plan = (
      desired: Record<string, unknown>,
      previous: Record<string, unknown> | undefined,
      opts: { streamReplaced?: boolean; keep?: boolean } = {}
    ) =>
      planReplicaSettingOps(
        desired,
        previous,
        {
          fresh: previous === undefined,
          ...(opts.streamReplaced !== undefined && { streamReplaced: opts.streamReplaced }),
          ...(opts.keep === true && { keepOnRemoval: new Set(['streamTags'] as const) }),
        },
        () => {}
      );
    expect(plan(streamTags(['k1', 'v1']), undefined)).toEqual([
      { kind: 'tagStream', tags: [{ Key: 'k1', Value: 'v1' }] },
    ]);
    expect(plan(streamTags(['k2', 'v2'], ['k3', 'v3']), streamTags(['k1', 'v1'], ['k3', 'v3']))).toEqual([
      { kind: 'untagStream', keys: ['k1'] },
      { kind: 'tagStream', tags: [{ Key: 'k2', Value: 'v2' }] },
    ]);
    expect(plan({}, streamTags(['k1', 'v1']))).toEqual([{ kind: 'untagStream', keys: ['k1'] }]);
    expect(plan(streamTags(['k1', 'v1']), streamTags(['k1', 'v1']))).toEqual([]);
    // A replaced stream holds no tags yet.
    expect(plan(streamTags(['k1', 'v1']), streamTags(['k1', 'v1']), { streamReplaced: true })).toEqual([
      { kind: 'tagStream', tags: [{ Key: 'k1', Value: 'v1' }] },
    ]);
    expect(plan({}, streamTags(['k1', 'v1']), { keep: true })).toEqual([]);
  });

  it('refuses a malformed per-index block and malformed stream tags', () => {
    expect(
      replicaSettingRefusals({
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi1', ContributorInsightsSpecification: { Enabled: 'maybe' } },
        ],
      })
    ).toHaveLength(1);
    expect(
      replicaSettingRefusals({ ReplicaStreamSpecification: { Tags: [{ Key: '', Value: 'x' }] } })
    ).toEqual([expect.stringContaining('ReplicaStreamSpecification.Tags')]);
    expect(replicaSettingRefusals({ ...ci(true), ...streamTags(['k', 'v']) })).toEqual([]);
    // Refused only on a replica whose blocks changed.
    const bad = {
      GlobalSecondaryIndexes: [
        { IndexName: 'gsi1', ContributorInsightsSpecification: { Enabled: 'maybe' } },
      ],
    };
    expect(replicaSettingsRefusal(base({}, bad), base({}, {}))).toMatch(/eu-west-1/);
    expect(replicaSettingsRefusal(base({}, bad), base({}, bad))).toBeUndefined();
  });

  it('declares and corrects only the declared index rules and stream tags AWS reports differently', () => {
    const replica = { ...ci(true), ...streamTags(['k1', 'v1'], ['k2', 'v2']) };
    const declared = declaredReplicaSettings(replica);
    expect(declared.has('indexContributorInsights')).toBe(true);
    expect(declared.has('streamTags')).toBe(true);
    expect(declaredReplicaSettings({}).has('streamTags')).toBe(false);
    expect(
      planReplicaSettingCorrections(
        replica,
        {
          indexContributorInsightsEnabled: new Map([['gsi1', false]]),
          streamTags: new Map([['k1', 'v1']]),
        },
        declared
      )
    ).toEqual([
      { kind: 'indexContributorInsights', indexName: 'gsi1', action: 'ENABLE' },
      { kind: 'tagStream', tags: [{ Key: 'k2', Value: 'v2' }] },
    ]);
    expect(
      planReplicaSettingCorrections(
        replica,
        {
          indexContributorInsightsEnabled: new Map([['gsi1', true]]),
          streamTags: new Map([
            ['k1', 'v1'],
            ['k2', 'v2'],
          ]),
        },
        declared
      )
    ).toEqual([]);
  });
});

describe('GlobalTableSettingsReplicationMode reads (go-to-k/cdkd#5489)', () => {
  it('reads a mode only on a one-replica table', () => {
    expect(readReplicationMode(base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, null))).toEqual({
      kind: 'usable',
      mode: 'ENABLED',
    });
    expect(readReplicationMode(base({}, null)).kind).toBe('absent');
    const two = readReplicationMode(base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, {}));
    expect(two.kind).toBe('unusable');
    expect(readReplicationMode(base({ GlobalTableSettingsReplicationMode: 7 }, null)).kind).toBe(
      'unusable'
    );
  });

  it('sends a changed mode, DISABLED for a removed one, nothing when unchanged', () => {
    const one = (mode?: string) =>
      base(mode === undefined ? {} : { GlobalTableSettingsReplicationMode: mode }, null);
    expect(replicationModeUpdate(one('DISABLED'), one('ENABLED'))).toBe('DISABLED');
    expect(replicationModeUpdate(one('ENABLED'), one('DISABLED'))).toBe('ENABLED');
    expect(replicationModeUpdate(one(), one('ENABLED'))).toBe('DISABLED');
    expect(replicationModeUpdate(one('ENABLED'), one())).toBe('ENABLED');
    expect(replicationModeUpdate(one('ENABLED'), one('ENABLED'))).toBeUndefined();
    expect(replicationModeUpdate(one(), one())).toBeUndefined();
  });

  it('refuses a mode on a two-replica table only when the mode or the replica list changed', () => {
    const twoWithMode = base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, {});
    expect(replicaSettingsRefusal(twoWithMode, undefined)).toMatch(/exactly one replica/);
    expect(
      replicaSettingsRefusal(twoWithMode, base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, null))
    ).toMatch(/exactly one replica/);
    expect(replicaSettingsRefusal(twoWithMode, twoWithMode)).toBeUndefined();
    expect(
      replicaSettingsRefusal(base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, null), undefined)
    ).toBeUndefined();
  });

  it("keeps a recorded mode on a drift --revert's desired side, which never reads it", () => {
    const recorded = base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, null);
    const completed = keepUnreadReplicaMembers(base({}, null), recorded);
    expect(replicationModeUpdate(completed, recorded)).toBeUndefined();
  });
});

describe('DynamoDB GlobalTable writes (go-to-k/cdkd#5489)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    regionalSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    vi.restoreAllMocks();
    setLive();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    provider = new DynamoDBGlobalTableProvider();
  });

  it('create: enables each replica index rule and tags each stream in its own region', async () => {
    await provider.create(
      'T',
      RESOURCE_TYPE,
      base(
        { ...ci(true), ...streamTags(['k1', 'v1']) },
        { ...ci(true, 'THROTTLED_KEYS'), ...streamTags(['k1', 'w1']) }
      )
    );
    expect(writes(mockSend)).toEqual([
      [
        UpdateContributorInsightsCommand.name,
        { TableName: TABLE, IndexName: 'gsi1', ContributorInsightsAction: 'ENABLE' },
      ],
      [TagResourceCommand.name, { ResourceArn: LOCAL_STREAM, Tags: [{ Key: 'k1', Value: 'v1' }] }],
    ]);
    expect(writes(regionalSend)).toEqual([
      [
        UpdateContributorInsightsCommand.name,
        {
          TableName: TABLE,
          IndexName: 'gsi1',
          ContributorInsightsAction: 'ENABLE',
          ContributorInsightsMode: 'THROTTLED_KEYS',
        },
      ],
      [TagResourceCommand.name, { ResourceArn: REMOTE_STREAM, Tags: [{ Key: 'k1', Value: 'w1' }] }],
    ]);
  });

  it('create: sends nothing for neither when the template declares neither', async () => {
    await provider.create('T', RESOURCE_TYPE, base());
    expect(writes(mockSend)).toEqual([]);
    expect(writes(regionalSend)).toEqual([]);
  });

  it('update: disables a changed or removed index rule and re-tags the streams, per region', async () => {
    setLive(
      { indexCi: { gsi1: 'ENABLED' }, streamTags: { k1: 'v1' } },
      { indexCi: { gsi1: 'ENABLED' }, streamTags: { k1: 'w1' } }
    );
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      base({ ...ci(false), ...streamTags(['k2', 'v2']) }, {}),
      base({ ...ci(true), ...streamTags(['k1', 'v1']) }, { ...ci(true), ...streamTags(['k1', 'w1']) })
    );
    expect(writes(mockSend)).toEqual([
      [UntagResourceCommand.name, { ResourceArn: LOCAL_STREAM, TagKeys: ['k1'] }],
      [TagResourceCommand.name, { ResourceArn: LOCAL_STREAM, Tags: [{ Key: 'k2', Value: 'v2' }] }],
      [
        UpdateContributorInsightsCommand.name,
        { TableName: TABLE, IndexName: 'gsi1', ContributorInsightsAction: 'DISABLE' },
      ],
    ]);
    expect(writes(regionalSend)).toEqual([
      [UntagResourceCommand.name, { ResourceArn: REMOTE_STREAM, TagKeys: ['k1'] }],
      [
        UpdateContributorInsightsCommand.name,
        { TableName: TABLE, IndexName: 'gsi1', ContributorInsightsAction: 'DISABLE' },
      ],
    ]);
  });

  it('update: an unchanged declaration AWS does not hold (a pre-fix deploy) is corrected', async () => {
    setLive({ indexCi: { gsi1: 'DISABLED' }, streamTags: {} }, {});
    const props = base({ ...ci(true), ...streamTags(['k1', 'v1']) }, {});
    await provider.update('T', TABLE, RESOURCE_TYPE, props, props);
    expect(writes(mockSend)).toEqual([
      [TagResourceCommand.name, { ResourceArn: LOCAL_STREAM, Tags: [{ Key: 'k1', Value: 'v1' }] }],
      [
        UpdateContributorInsightsCommand.name,
        { TableName: TABLE, IndexName: 'gsi1', ContributorInsightsAction: 'ENABLE' },
      ],
    ]);
  });

  it('update: an unchanged declaration AWS holds sends nothing', async () => {
    setLive({ indexCi: { gsi1: 'ENABLED' }, streamTags: { k1: 'v1' } }, {});
    const props = base({ ...ci(true), ...streamTags(['k1', 'v1']) }, {});
    await provider.update('T', TABLE, RESOURCE_TYPE, props, props);
    expect(writes(mockSend)).toEqual([]);
  });

  it('drift --revert: a read-back without the index rule or stream tags removes neither', async () => {
    const recorded = base({ ...ci(true), ...streamTags(['k1', 'v1']) }, {});
    setLive({ indexCi: { gsi1: 'ENABLED' }, streamTags: { k1: 'v1' } }, {});
    await provider.update('T', TABLE, RESOURCE_TYPE, base({}, {}), recorded, {
      desiredFromAwsReadback: true,
    });
    expect(writes(mockSend).filter(([, input]) => input['ContributorInsightsAction'] === 'DISABLE')).toEqual(
      []
    );
    expect(sent(mockSend, UntagResourceCommand)).toEqual([]);
  });

  describe('GlobalTableSettingsReplicationMode', () => {
    beforeEach(() => setLive({}, {}, []));

    it('create: rides CreateTable on a one-replica table', async () => {
      await provider.create(
        'T',
        RESOURCE_TYPE,
        base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, null)
      );
      expect(sent(mockSend, CreateTableCommand)[0]?.['GlobalTableSettingsReplicationMode']).toBe(
        'ENABLED'
      );
    });

    it('create: is absent from CreateTable when undeclared', async () => {
      await provider.create('T', RESOURCE_TYPE, base({}, null));
      expect(sent(mockSend, CreateTableCommand)[0]).not.toHaveProperty(
        'GlobalTableSettingsReplicationMode'
      );
    });

    it('create: is refused on a two-replica table before CreateTable', async () => {
      setLive();
      await expect(
        provider.create('T', RESOURCE_TYPE, base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, {}))
      ).rejects.toThrow(/exactly one replica/);
      expect(sent(mockSend, CreateTableCommand)).toEqual([]);
      expect(regionalSend).not.toHaveBeenCalled();
    });

    it('update: a change and a removal go out in their own UpdateTable', async () => {
      const one = (mode?: string) =>
        base(mode === undefined ? {} : { GlobalTableSettingsReplicationMode: mode }, null);
      const modes = () =>
        sent(mockSend, UpdateTableCommand)
          .filter((input) => 'GlobalTableSettingsReplicationMode' in input)
          .map((input) => input['GlobalTableSettingsReplicationMode']);
      await provider.update('T', TABLE, RESOURCE_TYPE, one('DISABLED'), one('ENABLED'));
      expect(modes()).toEqual(['DISABLED']);
      mockSend.mockClear();
      await provider.update('T', TABLE, RESOURCE_TYPE, one(), one('ENABLED'));
      expect(modes()).toEqual(['DISABLED']);
      mockSend.mockClear();
      setLive({ mode: 'ENABLED' }, {}, []);
      await provider.update('T', TABLE, RESOURCE_TYPE, one('ENABLED'), one('ENABLED'));
      expect(modes()).toEqual([]);
    });

    it('update: a declared, unchanged mode AWS does not hold (a pre-fix deploy) is set', async () => {
      const one = (mode?: string) =>
        base(mode === undefined ? {} : { GlobalTableSettingsReplicationMode: mode }, null);
      const modes = () =>
        sent(mockSend, UpdateTableCommand)
          .filter((input) => 'GlobalTableSettingsReplicationMode' in input)
          .map((input) => input['GlobalTableSettingsReplicationMode']);
      // DynamoDB's same-account default, which a pre-fix create left.
      setLive({ mode: 'ENABLED_WITH_OVERRIDES' }, {}, []);
      await provider.update('T', TABLE, RESOURCE_TYPE, one('ENABLED'), one('ENABLED'));
      expect(modes()).toEqual(['ENABLED']);
      // A DISABLED table reports no mode (measured): nothing to correct.
      mockSend.mockClear();
      setLive({}, {}, []);
      await provider.update('T', TABLE, RESOURCE_TYPE, one('DISABLED'), one('DISABLED'));
      expect(modes()).toEqual([]);
      // Undeclared: nothing is read into a correction.
      mockSend.mockClear();
      setLive({ mode: 'ENABLED_WITH_OVERRIDES' }, {}, []);
      await provider.update('T', TABLE, RESOURCE_TYPE, one(), one());
      expect(modes()).toEqual([]);
    });

    it('update: a failed correction is reported, not thrown', async () => {
      const one = base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, null);
      setLive(
        {
          mode: 'ENABLED_WITH_OVERRIDES',
          refuse: (name, input) =>
            name === UpdateTableCommand.name && 'GlobalTableSettingsReplicationMode' in input
              ? Object.assign(new Error('nope'), { name: 'ValidationException' })
              : undefined,
        },
        {},
        []
      );
      await expect(provider.update('T', TABLE, RESOURCE_TYPE, one, one)).resolves.toBeDefined();
      expect(warnSpy.mock.calls.flat().join('\n')).toMatch(
        /does not hold its declared GlobalTableSettingsReplicationMode/
      );
    });

    it('update: adding a replica while a mode is declared is refused before any write', async () => {
      await expect(
        provider.update(
          'T',
          TABLE,
          RESOURCE_TYPE,
          base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, {}),
          base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, null)
        )
      ).rejects.toThrow(/exactly one replica/);
      expect(sent(mockSend, UpdateTableCommand)).toEqual([]);
      expect(writes(mockSend)).toEqual([]);
      expect(regionalSend).not.toHaveBeenCalled();
    });
  });

  describe('LocalSecondaryIndexes added or removed as a whole list', () => {
    const LSI = [
      {
        IndexName: 'lsi1',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'gpk', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      },
    ];

    it.each([
      ['added', base({}, {}, { LocalSecondaryIndexes: LSI }), base()],
      ['removed', base(), base({}, {}, { LocalSecondaryIndexes: LSI })],
    ])('refuses a list %s before any call', async (_label, desired, previous) => {
      await expect(provider.update('T', TABLE, RESOURCE_TYPE, desired, previous)).rejects.toThrow(
        /LocalSecondaryIndexes is immutable/
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(regionalSend).not.toHaveBeenCalled();
    });

    it('treats an absent list and an empty one alike, and an unchanged list as no change', async () => {
      await expect(
        provider.update('T', TABLE, RESOURCE_TYPE, base({}, {}, { LocalSecondaryIndexes: [] }), base())
      ).resolves.toBeDefined();
      await expect(
        provider.update('T', TABLE, RESOURCE_TYPE, base(), base({}, {}, { LocalSecondaryIndexes: [] }))
      ).resolves.toBeDefined();
      await expect(provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        base({}, {}, { LocalSecondaryIndexes: LSI }),
        base({}, {}, { LocalSecondaryIndexes: LSI })
      )).resolves.toBeDefined();
    });
  });
});

describe('GlobalTable #5489 ordering and failure paths', () => {
  let provider: DynamoDBGlobalTableProvider;
  const validation = (): Error => Object.assign(new Error('refused'), { name: 'ValidationException' });
  /** Every UpdateTable on the source client, as a short tag. */
  const updateTables = (): string[] =>
    sent(mockSend, UpdateTableCommand).flatMap((input) => {
      const replica = input['ReplicaUpdates']?.[0];
      if (replica?.Create) return [`replica-create:${replica.Create.RegionName}`];
      if (replica?.Delete) return [`replica-delete:${replica.Delete.RegionName}`];
      if (input['GlobalSecondaryIndexUpdates']?.[0]?.Create) return ['gsi-create'];
      if ('GlobalTableSettingsReplicationMode' in input) {
        return [`mode:${input['GlobalTableSettingsReplicationMode']}`];
      }
      return [];
    });

  beforeEach(() => {
    mockSend.mockReset();
    regionalSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    vi.restoreAllMocks();
    setLive();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    provider = new DynamoDBGlobalTableProvider();
  });

  it('a removed mode is reset BEFORE a replica the same update adds', async () => {
    setLive({ mode: 'ENABLED' }, {}, []);
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      base({}, {}),
      base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, null)
    );
    expect(updateTables()).toEqual(['mode:DISABLED', 'replica-create:eu-west-1']);
  });

  it('an added mode goes out AFTER the replica delete that leaves one replica', async () => {
    setLive({}, {}, ['eu-west-1']);
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      base({ GlobalTableSettingsReplicationMode: 'ENABLED' }, null),
      base({}, {})
    );
    expect(updateTables()).toEqual(['replica-delete:eu-west-1', 'mode:ENABLED']);
  });

  it('a GSI added with its replica insights is created before the insights are set', async () => {
    setLive({ gsi: false }, {});
    const desired = base(ci(true), {});
    const previous = { ...base({}, {}), GlobalSecondaryIndexes: undefined };
    await provider.update('T', TABLE, RESOURCE_TYPE, desired, previous);
    const order = mockSend.mock.calls
      .map((c) => c[0] as Sent)
      .flatMap((c) =>
        c.constructor.name === UpdateTableCommand.name &&
        c.input['GlobalSecondaryIndexUpdates']?.[0]?.Create
          ? ['gsi-create']
          : c.constructor.name === UpdateContributorInsightsCommand.name
            ? [`ci:${c.input['IndexName']}`]
            : []
      );
    expect(order).toEqual(['gsi-create', 'ci:gsi1']);
  });

  it('fails the update when one region refuses a template-driven index rule', async () => {
    setLive(
      {},
      {
        refuse: (name) => (name === UpdateContributorInsightsCommand.name ? validation() : undefined),
      }
    );
    await expect(
      provider.update('T', TABLE, RESOURCE_TYPE, base(ci(true), ci(true)), base({}, {}))
    ).rejects.toThrow(/refused/);
    // The deploy region's went out first.
    expect(sent(mockSend, UpdateContributorInsightsCommand)).toEqual([
      { TableName: TABLE, IndexName: 'gsi1', ContributorInsightsAction: 'ENABLE' },
    ]);
  });

  it('reports a refused correction and still corrects the next region', async () => {
    setLive(
      {
        refuse: (name) => (name === UpdateContributorInsightsCommand.name ? validation() : undefined),
      },
      {}
    );
    const props = base(ci(true), ci(true));
    await expect(provider.update('T', TABLE, RESOURCE_TYPE, props, props)).resolves.toBeDefined();
    expect(warnSpy.mock.calls.flat().join('\n')).toMatch(
      /does not hold the declared GlobalSecondaryIndexes\[\]\.ContributorInsightsSpecification/
    );
    expect(sent(regionalSend, UpdateContributorInsightsCommand)).toEqual([
      { TableName: TABLE, IndexName: 'gsi1', ContributorInsightsAction: 'ENABLE' },
    ]);
  });

  it('rethrows an interrupt raised during a correction', async () => {
    setLive(
      {
        refuse: (name) =>
          name === UpdateContributorInsightsCommand.name
            ? new InterruptedWaitError('the correction')
            : undefined,
      },
      {}
    );
    const props = base(ci(true), {});
    // Wrapped by update()'s own catch, but never swallowed into a warning.
    const error = await provider.update('T', TABLE, RESOURCE_TYPE, props, props).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isInterruptedWaitError(error)).toBe(true);
    expect(warnSpy.mock.calls.flat().join('\n')).not.toMatch(/does not hold the declared/);
  });

  it('reads ENABLING / DISABLING as no answer, so nothing is corrected', async () => {
    setLive({ indexCi: { gsi1: 'ENABLING' } }, { indexCi: { gsi1: 'DISABLING' } });
    const props = base(ci(false), ci(true));
    await provider.update('T', TABLE, RESOURCE_TYPE, props, props);
    expect(sent(mockSend, UpdateContributorInsightsCommand)).toEqual([]);
    expect(sent(regionalSend, UpdateContributorInsightsCommand)).toEqual([]);
  });

  it('pages ListTagsOfResource before deciding which declared tags are missing', async () => {
    setLive({ streamTags: { k1: 'v1', k2: 'v2', k3: 'old' }, tagPageSize: 1 }, {});
    const props = base(streamTags(['k1', 'v1'], ['k3', 'v3']), {});
    await provider.update('T', TABLE, RESOURCE_TYPE, props, props);
    expect(sent(mockSend, ListTagsOfResourceCommand).length).toBe(3);
    expect(sent(mockSend, TagResourceCommand)).toEqual([
      { ResourceArn: LOCAL_STREAM, Tags: [{ Key: 'k3', Value: 'v3' }] },
    ]);
  });

  it('skips the untag when the table has no stream left', async () => {
    setLive({ noStream: true }, {});
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      base({}, {}),
      base(streamTags(['k1', 'v1']), {})
    );
    expect(sent(mockSend, UntagResourceCommand)).toEqual([]);
  });

  it('a replica this update adds gets no DISABLE and no convergence read', async () => {
    setLive({}, {}, []);
    await provider.update(
      'T',
      TABLE,
      RESOURCE_TYPE,
      base({}, { ...ci(false), ...streamTags(['k1', 'v1']) }),
      base({}, null)
    );
    expect(sent(regionalSend, UpdateContributorInsightsCommand)).toEqual([]);
    expect(sent(regionalSend, DescribeContributorInsightsCommand)).toEqual([]);
    expect(sent(regionalSend, ListTagsOfResourceCommand)).toEqual([]);
    expect(sent(regionalSend, TagResourceCommand)).toEqual([
      { ResourceArn: REMOTE_STREAM, Tags: [{ Key: 'k1', Value: 'v1' }] },
    ]);
  });
});

describe('corrections: the DISABLE and mode-bearing ENABLE arms', () => {
  it('disables an index AWS reports on and enables with the declared mode', () => {
    const only = new Set(['indexContributorInsights'] as const);
    expect(
      planReplicaSettingCorrections(
        ci(false),
        { indexContributorInsightsEnabled: new Map([['gsi1', true]]) },
        only
      )
    ).toEqual([{ kind: 'indexContributorInsights', indexName: 'gsi1', action: 'DISABLE' }]);
    expect(
      planReplicaSettingCorrections(
        ci(true, 'THROTTLED_KEYS'),
        { indexContributorInsightsEnabled: new Map([['gsi1', false]]) },
        only
      )
    ).toEqual([
      {
        kind: 'indexContributorInsights',
        indexName: 'gsi1',
        action: 'ENABLE',
        mode: 'THROTTLED_KEYS',
      },
    ]);
  });

  it('corrects a declared mode only when AWS holds another one', () => {
    const one = (mode?: string) =>
      base(mode === undefined ? {} : { GlobalTableSettingsReplicationMode: mode }, null);
    expect(replicationModeCorrection(one('ENABLED'), one('ENABLED'), 'ENABLED_WITH_OVERRIDES')).toBe(
      'ENABLED'
    );
    expect(replicationModeCorrection(one('ENABLED'), one('ENABLED'), 'ENABLED')).toBeUndefined();
    expect(replicationModeCorrection(one('DISABLED'), one('DISABLED'), undefined)).toBeUndefined();
    expect(replicationModeCorrection(one('ENABLED'), one('DISABLED'), undefined)).toBeUndefined();
    expect(replicationModeCorrection(one(), one(), 'ENABLED')).toBeUndefined();
  });
});
