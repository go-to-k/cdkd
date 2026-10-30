/**
 * Issue #5467: a changed `AWS::RDS::DBCluster` / `AWS::RDS::DBInstance`
 * `Engine` replaces the resource, as CloudFormation does (measured, us-east-1:
 * aurora-mysql to aurora-postgresql and mysql to mariadb both created a new
 * physical resource). Only an Oracle non-CDB to CDB conversion of an instance
 * updates in place, with the new Engine sent on ModifyDBInstance. A changed
 * cluster `MasterUsername` stays in place: CloudFormation keeps the live user.
 *
 * The replacement must reach the stateful guard: both types lose their data on
 * a replace, so the deploy refuses without `--force-stateful-recreation`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

import {
  ReplacementRulesRegistry,
  dbClusterEngineChangeReplaces,
  dbInstanceEngineChangeReplaces,
  dbInstanceEngineChangeIsInPlace,
} from '../../../src/analyzer/replacement-rules.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { isStatefulRecreateTargetForReplace } from '../../../src/provisioning/stateful-types.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const CLUSTER = 'AWS::RDS::DBCluster';
const INSTANCE = 'AWS::RDS::DBInstance';

describe('RDS Engine replacement predicates (issue #5467)', () => {
  // Each row mirrors one arm of CloudFormation's ImmutabilityHelper
  // `isEngineMutable` (aws-cloudformation-resource-providers-rds @ 5a410e8).
  it('DBCluster: only an unchanged engine and aurora -> aurora-mysql are in place', () => {
    expect(dbClusterEngineChangeReplaces('aurora-mysql', 'aurora-mysql')).toBe(false);
    expect(dbClusterEngineChangeReplaces('aurora', 'aurora-mysql')).toBe(false);
    expect(dbClusterEngineChangeReplaces('aurora-mysql', 'aurora-postgresql')).toBe(true);
    expect(dbClusterEngineChangeReplaces('mysql', 'postgres')).toBe(true);
    expect(dbClusterEngineChangeReplaces('aurora-mysql', 'aurora')).toBe(true);
    // `Objects.equal` is exact, so a case change is an engine change there.
    expect(dbClusterEngineChangeReplaces('Aurora-MySQL', 'aurora-mysql')).toBe(true);
    expect(dbClusterEngineChangeReplaces('Aurora', 'aurora-mysql')).toBe(true);
  });

  it('DBInstance isUpgradeToAuroraMySQL: aurora -> aurora-mysql, exact case', () => {
    expect(dbInstanceEngineChangeReplaces('aurora', 'aurora-mysql')).toBe(false);
    expect(dbInstanceEngineChangeReplaces('Aurora', 'aurora-mysql')).toBe(true);
    expect(dbInstanceEngineChangeReplaces('aurora-mysql', 'aurora')).toBe(true);
  });

  it('DBInstance isUpgradeToOracleSE2: oracle-se / oracle-se1 -> oracle-se2, either case', () => {
    expect(dbInstanceEngineChangeReplaces('oracle-se', 'oracle-se2')).toBe(false);
    expect(dbInstanceEngineChangeReplaces('oracle-se1', 'oracle-se2')).toBe(false);
    expect(dbInstanceEngineChangeReplaces('ORACLE-SE1', 'Oracle-SE2')).toBe(false);
    expect(dbInstanceEngineChangeReplaces('oracle-se2', 'oracle-se')).toBe(true);
    expect(dbInstanceEngineChangeReplaces('oracle-se', 'oracle-se2-cdb')).toBe(true);
    expect(dbInstanceEngineChangeReplaces('oracle-se1', 'oracle-ee')).toBe(true);
  });

  it('DBInstance isOracleConvertToCDB: oracle-ee -> oracle-ee-cdb, oracle-se2 -> oracle-se2-cdb, either case', () => {
    expect(dbInstanceEngineChangeReplaces('oracle-ee', 'oracle-ee-cdb')).toBe(false);
    expect(dbInstanceEngineChangeReplaces('oracle-se2', 'oracle-se2-cdb')).toBe(false);
    expect(dbInstanceEngineChangeReplaces('ORACLE-EE', 'Oracle-EE-CDB')).toBe(false);
    expect(dbInstanceEngineChangeReplaces('oracle-ee-cdb', 'oracle-ee')).toBe(true);
    expect(dbInstanceEngineChangeReplaces('oracle-ee', 'oracle-se2-cdb')).toBe(true);
    expect(dbInstanceEngineChangeReplaces('oracle-se2', 'oracle-ee-cdb')).toBe(true);
    expect(dbInstanceEngineChangeReplaces('custom-oracle-ee', 'custom-oracle-ee-cdb')).toBe(true);
  });

  it('DBInstance isOracleCDBMutable: a CDB engine re-spelled in another case', () => {
    expect(dbInstanceEngineChangeReplaces('oracle-ee-cdb', 'ORACLE-EE-CDB')).toBe(false);
    expect(dbInstanceEngineChangeReplaces('Oracle-SE2-CDB', 'oracle-se2-cdb')).toBe(false);
    // Any other engine's case change is a change (`Objects.equal` is exact).
    expect(dbInstanceEngineChangeReplaces('MySQL', 'mysql')).toBe(true);
    expect(dbInstanceEngineChangeReplaces('Oracle-EE', 'oracle-ee')).toBe(true);
  });

  it('DBInstance: any other change replaces, an unchanged engine does not', () => {
    expect(dbInstanceEngineChangeReplaces('mysql', 'mysql')).toBe(false);
    expect(dbInstanceEngineChangeReplaces('mysql', 'mariadb')).toBe(true);
    expect(dbInstanceEngineChangeReplaces('aurora-mysql', 'aurora-postgresql')).toBe(true);
    expect(dbInstanceEngineChangeReplaces('postgres', 'aurora-postgresql')).toBe(true);
  });

  it('an Engine absent on either side replaces neither type (deliberate; a replace destroys data)', () => {
    for (const predicate of [dbClusterEngineChangeReplaces, dbInstanceEngineChangeReplaces]) {
      expect(predicate(undefined, 'mysql')).toBe(false);
      expect(predicate('mysql', undefined)).toBe(false);
      expect(predicate(undefined, undefined)).toBe(false);
    }
  });

  it('dbInstanceEngineChangeIsInPlace is false for an absent side', () => {
    expect(dbInstanceEngineChangeIsInPlace(undefined, 'oracle-ee-cdb')).toBe(false);
    expect(dbInstanceEngineChangeIsInPlace('oracle-ee', undefined)).toBe(false);
  });

  it('the registry wires both predicates to Engine', () => {
    const rules = new ReplacementRulesRegistry();
    expect(rules.requiresReplacement(CLUSTER, 'Engine', 'aurora-mysql', 'aurora-postgresql')).toBe(
      true
    );
    expect(rules.requiresReplacement(INSTANCE, 'Engine', 'mysql', 'mariadb')).toBe(true);
    expect(rules.requiresReplacement(INSTANCE, 'Engine', 'oracle-ee', 'oracle-ee-cdb')).toBe(false);
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

describe('DiffCalculator classifies the RDS Engine / MasterUsername changes (issue #5467)', () => {
  it('a DBCluster Engine change replaces', async () => {
    const pc = await changeAt(
      CLUSTER,
      { Engine: 'aurora-mysql', MasterUsername: 'admin' },
      { Engine: 'aurora-postgresql', MasterUsername: 'admin' },
      'Engine'
    );
    expect(pc?.requiresReplacement).toBe(true);
  });

  it('a DBInstance Engine change replaces, an Oracle CDB conversion does not', async () => {
    const base = { DBInstanceClass: 'db.t4g.micro', MasterUsername: 'admin' };
    expect(
      (await changeAt(INSTANCE, { ...base, Engine: 'mysql' }, { ...base, Engine: 'mariadb' }, 'Engine'))
        ?.requiresReplacement
    ).toBe(true);
    expect(
      (
        await changeAt(
          INSTANCE,
          { ...base, Engine: 'oracle-ee' },
          { ...base, Engine: 'oracle-ee-cdb' },
          'Engine'
        )
      )?.requiresReplacement
    ).toBe(false);
  });

  it('a DBCluster MasterUsername change stays in place, as CloudFormation keeps it', async () => {
    const pc = await changeAt(
      CLUSTER,
      { Engine: 'aurora-mysql', MasterUsername: 'admin' },
      { Engine: 'aurora-mysql', MasterUsername: 'admin2' },
      'MasterUsername'
    );
    expect(pc?.requiresReplacement).toBe(false);
  });

  it('a schema createOnly property still replaces next to the new rule', async () => {
    const pc = await changeAt(
      CLUSTER,
      { Engine: 'aurora-mysql', StorageEncrypted: false },
      { Engine: 'aurora-mysql', StorageEncrypted: true },
      'StorageEncrypted'
    );
    expect(pc?.requiresReplacement).toBe(true);
  });
});

describe('an RDS Engine replacement reaches the stateful guard (issue #5467)', () => {
  type ProviderDouble = Record<'create' | 'update' | 'delete' | 'getAttribute', ReturnType<typeof vi.fn>>;
  let provider: ProviderDouble;
  let saveState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'new-db', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'my-db' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
    saveState = vi.fn().mockResolvedValue('etag-new');
  });

  async function deploy(
    type: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    options: Record<string, unknown> = {}
  ): Promise<unknown> {
    const engine = new DeployEngine(
      { getState: vi.fn().mockResolvedValue({ state: stateOf(type, before), etag: 'e' }), saveState } as never,
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

  it('both types are always-stateful for a replace', () => {
    expect(isStatefulRecreateTargetForReplace(CLUSTER, {}, undefined)).toBe('always');
    expect(isStatefulRecreateTargetForReplace(INSTANCE, {}, undefined)).toBe('always');
  });

  for (const [type, before, after] of [
    [CLUSTER, { Engine: 'aurora-mysql', MasterUsername: 'admin' }, { Engine: 'aurora-postgresql', MasterUsername: 'admin' }],
    [INSTANCE, { Engine: 'mysql', DBInstanceClass: 'db.t4g.micro' }, { Engine: 'mariadb', DBInstanceClass: 'db.t4g.micro' }],
  ] as const) {
    it(`refuses a ${type} Engine change without --force-stateful-recreation, before any provider call`, async () => {
      const err = await deploy(type, before, after);
      expect(err, 'the deploy did not throw').toBeDefined();
      expect(chainText(err)).toContain('STATEFUL_REPLACE_BLOCKED');
      expect(chainText(err)).toContain('requires replacement (immutable property changed: Engine)');
      expect(provider.update).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it(`replaces a ${type} on an Engine change with --force-stateful-recreation`, async () => {
      expect(await deploy(type, before, after, { forceStatefulRecreation: true })).toBeUndefined();
      expect(provider.update).not.toHaveBeenCalled();
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.delete).toHaveBeenCalledTimes(1);
    });
  }

  it('CONTROL: an Oracle CDB conversion updates the instance in place', async () => {
    const base = { DBInstanceClass: 'db.t3.medium' };
    expect(
      await deploy(INSTANCE, { ...base, Engine: 'oracle-ee' }, { ...base, Engine: 'oracle-ee-cdb' })
    ).toBeUndefined();
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
  });
});

describe('RDSProvider sends Engine on ModifyDBInstance only for an Oracle CDB conversion (issue #5467)', () => {
  let rds: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockImplementation(async (command: object) => {
      if (command.constructor.name === 'DescribeDBInstancesCommand') {
        return {
          DBInstances: [
            {
              DBInstanceIdentifier: 'my-db',
              DBInstanceStatus: 'available',
              DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:my-db',
            },
          ],
        };
      }
      return {};
    });
    rds = new RDSProvider();
    (rds as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  });

  function modifyInput(): Record<string, unknown> {
    const call = mockSend.mock.calls.find(
      ([command]) => (command as object).constructor.name === 'ModifyDBInstanceCommand'
    );
    if (!call) throw new Error('ModifyDBInstance was not sent');
    return (call[0] as { input: Record<string, unknown> }).input;
  }

  it('sends the new Engine for oracle-se2 to oracle-se2-cdb', async () => {
    await rds.update(
      'Db',
      'my-db',
      INSTANCE,
      { Engine: 'oracle-se2-cdb', DBInstanceClass: 'db.t3.medium' },
      { Engine: 'oracle-se2', DBInstanceClass: 'db.t3.medium' }
    );
    expect(modifyInput()['Engine']).toBe('oracle-se2-cdb');
  });

  for (const [from, to] of [
    ['aurora', 'aurora-mysql'],
    ['oracle-se1', 'oracle-se2'],
    ['oracle-ee', 'oracle-ee-cdb'],
  ] as const) {
    it(`sends the new Engine for the in-place ${from} -> ${to}`, async () => {
      await rds.update(
        'Db',
        'my-db',
        INSTANCE,
        { Engine: to, DBInstanceClass: 'db.t3.medium' },
        { Engine: from, DBInstanceClass: 'db.t3.medium' }
      );
      expect(modifyInput()['Engine']).toBe(to);
    });
  }

  it('sends no Engine for an unchanged Engine, nor for one that is not in place', async () => {
    await rds.update(
      'Db',
      'my-db',
      INSTANCE,
      { Engine: 'mysql', DBInstanceClass: 'db.t4g.small' },
      { Engine: 'mysql', DBInstanceClass: 'db.t4g.micro' }
    );
    expect(Object.keys(modifyInput())).not.toContain('Engine');

    mockSend.mockClear();
    await rds.update(
      'Db',
      'my-db',
      INSTANCE,
      { Engine: 'MySQL', DBInstanceClass: 'db.t4g.small' },
      { Engine: 'mysql', DBInstanceClass: 'db.t4g.micro' }
    );
    expect(Object.keys(modifyInput())).not.toContain('Engine');
  });
});
