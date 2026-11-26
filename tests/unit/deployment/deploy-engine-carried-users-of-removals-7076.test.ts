/**
 * go-to-k/cdkd#7076: an old copy an EARLIER deploy kept in
 * `supersededResources` (its delete failed then) that uses a resource this
 * deploy removes -- an old security group of a removed VPC -- is deleted
 * BEFORE the removal deletes, as CloudFormation's cleanup orders both. Before,
 * the kept row was retried only at the cleanup, after the VPC delete had
 * already failed on it.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { executeDeployment } from '../../../src/deployment/deploy-engine/execute.js';
import { carriedUsersOfRemovals } from '../../../src/deployment/deploy-engine/carried-users-of-removals.js';
import { supersededResourcesOf } from '../../../src/deployment/superseded-resources.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type {
  ResourceChange,
  ResourceState,
  StackState,
  SupersededResourceRecord,
} from '../../../src/types/state.js';

const printed = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', async () => {
  const sink = (level: 'info' | 'warn') =>
    vi.fn((message: unknown) => {
      printed[level].push(String(message));
    });
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: sink('info'),
    warn: sink('warn'),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

const VPC = 'AWS::EC2::VPC';
const SG = 'AWS::EC2::SecurityGroup';

function awsError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const record = (
  physicalId: string,
  resourceType: string,
  dependencies: string[] = []
): ResourceState =>
  ({
    physicalId,
    resourceType,
    properties: {},
    attributes: {},
    dependencies,
    provisionedBy: 'sdk',
  }) as ResourceState;

const kept = (
  logicalId: string,
  state: ResourceState,
  extra: Partial<SupersededResourceRecord> = {}
): SupersededResourceRecord => ({ logicalId, supersededAt: 1, state, ...extra });

const deleteChange = (logicalId: string, resourceType: string): ResourceChange =>
  ({
    logicalId,
    changeType: 'DELETE',
    resourceType,
    currentProperties: {},
  }) as unknown as ResourceChange;

describe('a deploy deletes a kept old copy before the removed resource it uses (go-to-k/cdkd#7076)', () => {
  let provider: ResourceProvider;
  let live: Set<string>;
  /** physical id -> the ids whose liveness makes AWS refuse its delete. */
  let usedBy: Map<string, string[]>;
  let order: string[];
  /** How many more times the old group's delete is refused out of band. */
  let oldGroupRefusals: number;

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    live = new Set();
    usedBy = new Map();
    order = [];
    oldGroupRefusals = 0;
    provider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(async (_logicalId: string, physicalId: string) => {
        order.push(`delete ${physicalId}`);
        if (physicalId === 'sg-old' && oldGroupRefusals > 0) {
          oldGroupRefusals--;
          throw awsError('DependencyViolation', 'sg-old has a dependent object');
        }
        const user = (usedBy.get(physicalId) ?? []).find((id) => live.has(id));
        if (user !== undefined) {
          throw awsError('DependencyViolation', `${physicalId} has dependencies: ${user}`);
        }
        live.delete(physicalId);
        return undefined;
      }),
      readCurrentState: vi.fn(async (physicalId: string) =>
        live.has(physicalId) ? {} : RESOURCE_NOT_FOUND
      ),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(): DeployEngine {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    return new DeployEngine(
      {
        getState: vi.fn(),
        saveState: vi.fn(async () => 'etag'),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
        deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      { getDirectDependencies: () => [] } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4, noRollback: true } as never,
      'us-east-1'
    );
  }

  /** The VPC and the current group are removed; `rows` were kept earlier. */
  async function deploy(
    rows: SupersededResourceRecord[]
  ): Promise<{ state: StackState; actualCounts: Record<string, number> }> {
    const resources: Record<string, ResourceState> = {
      Vpc: record('vpc-1', VPC),
      Group: record('sg-new', SG, ['Vpc']),
    };
    for (const r of Object.values(resources)) live.add(r.physicalId);
    for (const row of rows) live.add(row.state.physicalId);
    const template = { Resources: {} } as unknown as CloudFormationTemplate;
    const currentState = {
      version: 12,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources,
      supersededResources: rows,
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      ['Vpc', deleteChange('Vpc', VPC)],
      ['Group', deleteChange('Group', SG)],
    ]);
    return (await executeDeployment(
      makeEngine(),
      template,
      currentState,
      changes,
      {} as never,
      [],
      'MyStack',
      template,
      undefined,
      undefined,
      'etag-0'
    )) as unknown as { state: StackState; actualCounts: Record<string, number> };
  }

  const at = (entry: string): number => {
    const index = order.indexOf(entry);
    expect(index, `${entry} in ${order.join(', ')}`).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('deletes the kept old group before the VPC it uses, and the deploy completes', async () => {
    usedBy.set('vpc-1', ['sg-new', 'sg-old']);

    const result = await deploy([kept('Group', record('sg-old', SG, ['Vpc']))]);

    expect(at('delete sg-old')).toBeLessThan(at('delete vpc-1'));
    expect(order.filter((entry) => entry === 'delete sg-old')).toHaveLength(1);
    expect(live.size).toBe(0);
    expect(result.state.resources).toEqual({});
    expect(supersededResourcesOf(result.state)).toEqual([]);
    expect(printed.warn).toEqual([]);
    expect(printed.info.join('\n')).toContain(
      'Deleting 1 old resource(s) an earlier deploy kept first: they use a resource removed from the template'
    );
  });

  it('keeps a kept old group whose early delete fails, and sends it again at the cleanup', async () => {
    usedBy.set('vpc-1', ['sg-new', 'sg-old']);
    oldGroupRefusals = 1;

    const result = await deploy([kept('Group', record('sg-old', SG, ['Vpc']))]);

    expect(order.filter((entry) => entry === 'delete sg-old')).toHaveLength(2);
    expect(at('delete sg-old')).toBeLessThan(at('delete vpc-1'));
    expect(supersededResourcesOf(result.state)).toEqual([]);
    // The VPC could not go while the old group lived: kept, as before.
    expect(result.state.resources['Vpc']?.physicalId).toBe('vpc-1');
  });

  it('leaves a kept old copy that uses no removed resource to the cleanup', async () => {
    const result = await deploy([kept('Other', record('old-other', 'AWS::IAM::Role'))]);

    expect(at('delete vpc-1')).toBeLessThan(at('delete old-other'));
    expect(supersededResourcesOf(result.state)).toEqual([]);
    expect(printed.info.join('\n')).not.toContain('an earlier deploy kept first');
  });
});

describe('carriedUsersOfRemovals (go-to-k/cdkd#7076)', () => {
  const resources = {
    Vpc: record('vpc-1', VPC),
    Group: record('sg-new', SG, ['Vpc']),
    Role: record('role', 'AWS::IAM::Role'),
  };
  const ids = (rows: SupersededResourceRecord[]): string[] => rows.map((r) => r.state.physicalId);

  it('takes a row whose record names a removed resource', () => {
    const rows = [
      kept('Role', record('r-old', 'AWS::IAM::Role', ['Vpc'])),
      kept('Other', record('o-old', 'AWS::IAM::Role')),
    ];
    expect(ids(carriedUsersOfRemovals(rows, resources, new Set(['Vpc'])))).toEqual(['r-old']);
  });

  it('takes a row by type when its record names nothing (a group before a removed VPC)', () => {
    const rows = [kept('Group', record('sg-old', SG))];
    expect(ids(carriedUsersOfRemovals(rows, resources, new Set(['Vpc'])))).toEqual(['sg-old']);
  });

  it('takes the kept rows using a taken one', () => {
    const rows = [
      kept('Eni', record('eni-old', 'AWS::EC2::NetworkInterface', ['Role'])),
      kept('Role', record('r-old', 'AWS::IAM::Role', ['Vpc'])),
    ];
    expect(ids(carriedUsersOfRemovals(rows, resources, new Set(['Vpc'])))).toEqual([
      'eni-old',
      'r-old',
    ]);
  });

  it('takes nothing when a removed resource names a taken row no current record holds', () => {
    const withUser = { ...resources, User: record('user', 'AWS::EC2::Instance', ['Gone']) };
    const rows = [kept('Gone', record('gone-old', SG, ['Vpc']))];
    expect(carriedUsersOfRemovals(rows, withUser, new Set(['Vpc', 'User']))).toEqual([]);
  });

  it('still takes a row whose logical id a removed resource names through its current record', () => {
    const withUser = {
      ...resources,
      Instance: record('i-1', 'AWS::EC2::Instance', ['Group']),
    };
    const rows = [kept('Group', record('sg-old', SG, ['Vpc']))];
    expect(
      ids(carriedUsersOfRemovals(rows, withUser, new Set(['Vpc', 'Group', 'Instance'])))
    ).toEqual(['sg-old']);
  });

  it('leaves a row a removed resource must precede, and the taken rows it uses, to the cleanup', () => {
    // A removed Lambda goes before any group (the type rule): the old group
    // stays for the cleanup, and so does the old role it names.
    const withLambda = { ...resources, Fn: record('fn', 'AWS::Lambda::Function') };
    const rows = [
      kept('Group', record('sg-old', SG, ['Vpc', 'Role'])),
      kept('Role', record('r-old', 'AWS::IAM::Role', ['Vpc'])),
      kept('Other', record('o-old', 'AWS::IAM::Role', ['Vpc'])),
    ];
    expect(ids(carriedUsersOfRemovals(rows, withLambda, new Set(['Vpc', 'Fn'])))).toEqual([
      'o-old',
    ]);
  });

  it('takes no row by type when its record names other dependencies', () => {
    const rows = [kept('Group', record('sg-old', SG, ['OtherVpc']))];
    expect(carriedUsersOfRemovals(rows, resources, new Set(['Vpc']))).toEqual([]);
  });

  it('reads a removed record by own key, so an inherited name is no current record', () => {
    const withUser = { ...resources, User: record('user', 'AWS::EC2::Instance', ['constructor']) };
    const rows = [kept('constructor', record('c-old', SG, ['Vpc']))];
    expect(carriedUsersOfRemovals(rows, withUser, new Set(['Vpc', 'User']))).toEqual([]);
  });

  it('leaves a row held for consumers to the cleanup', () => {
    const rows = [kept('Group', record('sg-old', SG, ['Vpc']), { heldForConsumers: true })];
    expect(carriedUsersOfRemovals(rows, resources, new Set(['Vpc']))).toEqual([]);
  });

  it('ignores a malformed dependencies list and reads types by own key', () => {
    const odd = { ...resources, Odd: record('odd', 'constructor') };
    const rows = [
      kept('A', { ...record('a-old', 'toString'), dependencies: [5, null] as unknown as string[] }),
      kept('B', {
        ...record('b-old', 'AWS::IAM::Role'),
        dependencies: 'Vpc' as unknown as string[],
      }),
    ];
    expect(carriedUsersOfRemovals(rows, odd, new Set(['Odd', 'Vpc']))).toEqual([]);
  });
});
