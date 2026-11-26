/**
 * go-to-k/cdkd#7044: the `AWS::RDS::DBInstance` / `AWS::RDS::DBCluster`
 * changes CloudFormation's RDS handler calls immutable (`ImmutabilityHelper.
 * isChangeMutable` / `isGlobalClusterMutable`, aws-cloudformation-resource-
 * providers-rds @ 5a410e8) are replacements, as CloudFormation makes them
 * (measured on #7038 for AvailabilityZone and PerformanceInsightsKMSKeyId).
 * `cdkd diff` shows them so, and the deploy reaches the stateful guard: the
 * replace needs `--force-stateful-recreation`, as for `Engine` (#5467).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory.
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(
    importOriginal
  )
);

vi.mock('../../../src/provisioning/create-only-properties.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    ...actual,
    getCreateOnlyPropertyPaths: async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? [],
  };
});

vi.mock('../../../src/provisioning/write-only-properties.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, tryGetTopLevelWriteOnlyProperties: async () => new Set<string>() };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn(() => 0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn(async () => ({})),
    evaluateConditions: vi.fn(async () => ({})),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

import {
  ReplacementRulesRegistry,
  dbClusterGlobalClusterChangeReplaces,
  dbInstanceAvailabilityZoneChangeReplaces,
  dbInstancePerformanceInsightsKmsKeyChangeReplaces,
  dbInstanceReplicaSourceChangeReplaces,
  dbInstanceRestoreInputChangeReplaces,
  dbInstanceUseLatestRestorableTimeChangeReplaces,
} from '../../../src/analyzer/replacement-rules.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const CLUSTER = 'AWS::RDS::DBCluster';
const INSTANCE = 'AWS::RDS::DBInstance';
const KEY_A = 'arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-1111-2222-3333-444444444444';
const KEY_B = 'arn:aws:kms:us-east-1:123456789012:key/bbbbbbbb-1111-2222-3333-444444444444';
const UNRESOLVED = { 'Fn::GetAtt': ['NewKey', 'Arn'] };

const bags = (
  oldProperties: Record<string, unknown>,
  newProperties: Record<string, unknown>
): { oldProperties: Record<string, unknown>; newProperties: Record<string, unknown> } => ({
  oldProperties,
  newProperties,
});

describe('RDS handler immutability predicates (go-to-k/cdkd#7044)', () => {
  it('isAvailabilityZoneChangeMutable: any change replaces, except an empty zone on MultiAZ: true', () => {
    const p = dbInstanceAvailabilityZoneChangeReplaces;
    expect(p('us-east-1a', 'us-east-1b', bags({}, {}))).toBe(true);
    expect(p('us-east-1a', 'us-east-1a', bags({}, {}))).toBe(false);
    // `Objects.equal` is exact: an added zone is a change.
    expect(p(undefined, 'us-east-1a', bags({}, {}))).toBe(true);
    // A removed zone replaces unless the desired instance is Multi-AZ.
    expect(p('us-east-1a', undefined, bags({}, {}))).toBe(true);
    expect(p('us-east-1a', undefined, bags({}, { MultiAZ: false }))).toBe(true);
    expect(p('us-east-1a', undefined, bags({}, { MultiAZ: true }))).toBe(false);
    expect(p('us-east-1a', undefined, bags({}, { MultiAZ: 'true' }))).toBe(false);
    expect(p('us-east-1a', '', bags({}, { MultiAZ: true }))).toBe(false);
    // `isTrue` reads the DESIRED MultiAZ only.
    expect(p('us-east-1a', undefined, bags({ MultiAZ: true }, {}))).toBe(true);
  });

  it('AvailabilityZone: what the bags cannot tell keeps the previous verdict (no replacement)', () => {
    const p = dbInstanceAvailabilityZoneChangeReplaces;
    expect(p('us-east-1a', UNRESOLVED, bags({}, {}))).toBe(false);
    expect(p(UNRESOLVED, 'us-east-1a', bags({}, {}))).toBe(false);
    expect(p('us-east-1a', undefined, bags({}, { MultiAZ: { Ref: 'P' } }))).toBe(false);
    expect(p('us-east-1a', undefined)).toBe(false);
    // The promoted-dependent probe: the handler sees equal models.
    expect(p(undefined, undefined, bags({}, {}))).toBe(false);
  });

  it('isPerformanceInsightsKMSKeyIdMutable: replaces only when a non-empty previous key differs', () => {
    const p = dbInstancePerformanceInsightsKmsKeyChangeReplaces;
    expect(p(KEY_A, KEY_B)).toBe(true);
    expect(p(KEY_A, undefined)).toBe(true);
    expect(p(KEY_A, '')).toBe(true);
    expect(p(KEY_A, KEY_A)).toBe(false);
    expect(p(undefined, KEY_B)).toBe(false);
    expect(p('', KEY_B)).toBe(false);
    expect(p(KEY_A, UNRESOLVED)).toBe(false);
    expect(p(undefined, undefined)).toBe(false);
  });

  it('isSourceDB{Instance,Cluster}IdentifierMutable: any change replaces except a promotion', () => {
    const p = dbInstanceReplicaSourceChangeReplaces;
    expect(p(undefined, 'source-db')).toBe(true);
    expect(p('source-db', 'other-db')).toBe(true);
    expect(p('source-db', 'source-db')).toBe(false);
    expect(p('source-db', undefined)).toBe(false);
    expect(p('source-db', '')).toBe(false);
    // Not a promotion (the previous source is empty), and not equal.
    expect(p('', undefined)).toBe(true);
    expect(p('source-db', { Ref: 'Source' })).toBe(false);
  });

  it('the restore inputs: adding or changing replaces, removing does not', () => {
    const p = dbInstanceRestoreInputChangeReplaces;
    expect(p(undefined, 'snap-a')).toBe(true);
    expect(p('snap-a', 'snap-b')).toBe(true);
    expect(p('snap-a', 'snap-a')).toBe(false);
    expect(p('snap-a', undefined)).toBe(false);
    expect(p('snap-a', '')).toBe(false);
    expect(p('snap-a', { Ref: 'Snap' })).toBe(false);
  });

  it('isUseLatestRestorableTimeMutable: replaces only a change to true', () => {
    const p = dbInstanceUseLatestRestorableTimeChangeReplaces;
    expect(p(undefined, true)).toBe(true);
    expect(p(false, true)).toBe(true);
    expect(p('false', 'true')).toBe(true);
    expect(p(true, true)).toBe(false);
    expect(p(true, false)).toBe(false);
    expect(p(true, undefined)).toBe(false);
    expect(p(undefined, false)).toBe(false);
    expect(p(undefined, { Ref: 'P' })).toBe(false);
  });

  it('isGlobalClusterMutable: adding or changing replaces, removing a non-empty one does not', () => {
    const p = dbClusterGlobalClusterChangeReplaces;
    expect(p(undefined, 'global-a')).toBe(true);
    expect(p('global-a', 'global-b')).toBe(true);
    expect(p('global-a', 'global-a')).toBe(false);
    expect(p('global-a', undefined)).toBe(false);
    expect(p('global-a', '')).toBe(false);
    expect(p('', undefined)).toBe(true);
    expect(p(undefined, { Ref: 'Global' })).toBe(false);
  });

  it('the registry wires each property', () => {
    const rules = new ReplacementRulesRegistry();
    const cases: ReadonlyArray<readonly [string, string, unknown, unknown]> = [
      [INSTANCE, 'AvailabilityZone', 'us-east-1a', 'us-east-1b'],
      [INSTANCE, 'PerformanceInsightsKMSKeyId', KEY_A, KEY_B],
      [INSTANCE, 'SourceDBInstanceIdentifier', 'a', 'b'],
      [INSTANCE, 'SourceDBClusterIdentifier', 'a', 'b'],
      [INSTANCE, 'DBSnapshotIdentifier', undefined, 'snap'],
      [INSTANCE, 'DBClusterSnapshotIdentifier', undefined, 'snap'],
      [INSTANCE, 'RestoreTime', undefined, '2026-01-01T00:00:00Z'],
      [INSTANCE, 'SourceDBInstanceAutomatedBackupsArn', undefined, 'arn'],
      [INSTANCE, 'SourceDbiResourceId', undefined, 'db-X'],
      [INSTANCE, 'UseLatestRestorableTime', undefined, true],
      [CLUSTER, 'GlobalClusterIdentifier', undefined, 'global-a'],
    ];
    for (const [type, key, before, after] of cases) {
      expect(rules.requiresReplacement(type, key, before, after, bags({}, {})), key).toBe(true);
    }
  });
});

function stateOf(type: string, props: Record<string, unknown>): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: 'us-east-1',
    stackName: 'MyStack',
    resources: {
      Db: { physicalId: 'my-db', resourceType: type, properties: props, attributes: {}, dependencies: [] },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

function templateOf(type: string, props: Record<string, unknown>): CloudFormationTemplate {
  return { Resources: { Db: { Type: type, Properties: props } } } as CloudFormationTemplate;
}

async function changeAt(
  type: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string
) {
  const changes = await new DiffCalculator().calculateDiff(
    stateOf(type, before),
    templateOf(type, after)
  );
  return changes.get('Db')?.propertyChanges?.find((p) => p.path === path);
}

const BASE = { Engine: 'mysql', DBInstanceClass: 'db.t4g.micro' };

describe('DiffCalculator classifies the RDS handler-immutable changes (go-to-k/cdkd#7044)', () => {
  it('a moved AvailabilityZone replaces', async () => {
    const pc = await changeAt(
      INSTANCE,
      { ...BASE, AvailabilityZone: 'us-east-1a' },
      { ...BASE, AvailabilityZone: 'us-east-1b' },
      'AvailabilityZone'
    );
    expect(pc?.requiresReplacement).toBe(true);
  });

  it('a zone dropped on a MultiAZ: true instance stays in place (the sibling is read)', async () => {
    const pc = await changeAt(
      INSTANCE,
      { ...BASE, AvailabilityZone: 'us-east-1a' },
      { ...BASE, MultiAZ: true },
      'AvailabilityZone'
    );
    expect(pc).toBeDefined();
    expect(pc?.requiresReplacement).toBe(false);
  });

  it('a PerformanceInsightsKMSKeyId key A -> key B replaces; a first key does not', async () => {
    const pi = { ...BASE, EnablePerformanceInsights: true };
    expect(
      (
        await changeAt(
          INSTANCE,
          { ...pi, PerformanceInsightsKMSKeyId: KEY_A },
          { ...pi, PerformanceInsightsKMSKeyId: KEY_B },
          'PerformanceInsightsKMSKeyId'
        )
      )?.requiresReplacement
    ).toBe(true);
    expect(
      (await changeAt(INSTANCE, pi, { ...pi, PerformanceInsightsKMSKeyId: KEY_B }, 'PerformanceInsightsKMSKeyId'))
        ?.requiresReplacement
    ).toBe(false);
  });

  it('a read replica promotion stays in place; an added source replaces', async () => {
    expect(
      (
        await changeAt(
          INSTANCE,
          { ...BASE, SourceDBInstanceIdentifier: 'source-db' },
          BASE,
          'SourceDBInstanceIdentifier'
        )
      )?.requiresReplacement
    ).toBe(false);
    expect(
      (
        await changeAt(
          INSTANCE,
          BASE,
          { ...BASE, SourceDBInstanceIdentifier: 'source-db' },
          'SourceDBInstanceIdentifier'
        )
      )?.requiresReplacement
    ).toBe(true);
  });

  it('a DBCluster joining a global cluster replaces; leaving one stays in place', async () => {
    const base = { Engine: 'aurora-mysql' };
    expect(
      (
        await changeAt(
          CLUSTER,
          base,
          { ...base, GlobalClusterIdentifier: 'global-a' },
          'GlobalClusterIdentifier'
        )
      )?.requiresReplacement
    ).toBe(true);
    expect(
      (
        await changeAt(
          CLUSTER,
          { ...base, GlobalClusterIdentifier: 'global-a' },
          base,
          'GlobalClusterIdentifier'
        )
      )?.requiresReplacement
    ).toBe(false);
  });
});

describe('an RDS handler-immutable replacement reaches the stateful guard (go-to-k/cdkd#7044)', () => {
  type ProviderDouble = Record<'create' | 'update' | 'delete' | 'getAttribute', ReturnType<typeof vi.fn>>;
  let provider: ProviderDouble;

  beforeEach(() => {
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new-db', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'my-db' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
  });

  async function deploy(
    type: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    options: Record<string, unknown> = {}
  ): Promise<unknown> {
    const engine = new DeployEngine(
      {
        getState: vi.fn().mockResolvedValue({ state: stateOf(type, before), etag: 'e' }),
        saveState: vi.fn().mockResolvedValue('etag-new'),
      } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      new DiffCalculator() as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun: false, noRollback: true, ...options } as never,
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
    return engine.deploy('MyStack', templateOf(type, after)).then(
      () => undefined,
      (e: unknown) => e
    );
  }

  function chainText(err: unknown): string {
    const parts: string[] = [];
    let cur: unknown = err;
    for (let depth = 0; cur instanceof Error && depth < 8; depth++) {
      parts.push(`${(cur as { code?: string }).code ?? ''} ${cur.message}`);
      cur = cur.cause;
    }
    return parts.join('\n');
  }

  const cases: ReadonlyArray<
    readonly [string, string, Record<string, unknown>, Record<string, unknown>]
  > = [
    [
      INSTANCE,
      'AvailabilityZone',
      { ...BASE, AvailabilityZone: 'us-east-1a' },
      { ...BASE, AvailabilityZone: 'us-east-1b' },
    ],
    [
      INSTANCE,
      'PerformanceInsightsKMSKeyId',
      { ...BASE, PerformanceInsightsKMSKeyId: KEY_A },
      { ...BASE, PerformanceInsightsKMSKeyId: KEY_B },
    ],
    [INSTANCE, 'DBSnapshotIdentifier', BASE, { ...BASE, DBSnapshotIdentifier: 'snap-a' }],
    [
      CLUSTER,
      'GlobalClusterIdentifier',
      { Engine: 'aurora-mysql' },
      { Engine: 'aurora-mysql', GlobalClusterIdentifier: 'global-a' },
    ],
  ];

  for (const [type, key, before, after] of cases) {
    it(`refuses a ${type} ${key} change without --force-stateful-recreation, before any provider call`, async () => {
      const err = await deploy(type, before, after);
      expect(err, 'the deploy did not throw').toBeDefined();
      expect(chainText(err)).toContain('STATEFUL_REPLACE_BLOCKED');
      expect(chainText(err)).toContain(`requires replacement (immutable property changed: ${key})`);
      expect(provider.update).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it(`replaces a ${type} on a ${key} change with --force-stateful-recreation`, async () => {
      expect(await deploy(type, before, after, { forceStatefulRecreation: true })).toBeUndefined();
      expect(provider.update).not.toHaveBeenCalled();
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.delete).toHaveBeenCalledTimes(1);
    });
  }

  it('CONTROL: a first PerformanceInsightsKMSKeyId updates the instance in place', async () => {
    expect(
      await deploy(INSTANCE, BASE, { ...BASE, PerformanceInsightsKMSKeyId: KEY_B })
    ).toBeUndefined();
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
  });
});
