import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type {
  ResourceState,
  StackState,
  SupersededResourceRecord,
} from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#7073: `cdkd destroy` deletes a superseded old copy in
// dependency order with the stack's own resources -- an old security group
// before the VPC its record depends on -- instead of after all of them, where
// the VPC delete waited on it and failed DependencyViolation.

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
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

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { scheduleSupersededDeletes } from '../../../src/cli/commands/destroy-runner/superseded-schedule.js';

const REGION = 'us-east-1';
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:handler';

function record(physicalId: string, resourceType: string, dependencies: string[] = []): ResourceState {
  return {
    physicalId,
    resourceType,
    properties: resourceType.startsWith('Custom::') ? { ServiceToken: TOKEN, Name: physicalId } : {},
    attributes: {},
    dependencies,
  };
}

const superseded = (logicalId: string, state: ResourceState): SupersededResourceRecord => ({
  logicalId,
  supersededAt: 1,
  state,
});

const stackState = (
  resources: Record<string, ResourceState>,
  supersededResources: SupersededResourceRecord[]
): StackState => ({
  version: 15,
  stackName: 'TestStack',
  region: REGION,
  resources,
  outputs: {},
  lastModified: 1,
  supersededResources,
});

describe('runDestroyForStack deletes superseded rows in dependency order (#7073)', () => {
  const order: string[] = [];
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  /** Physical ids whose delete throws, each once per listing. */
  let failing: string[] = [];

  function run(state: StackState): ReturnType<typeof runDestroyForStack> {
    return runDestroyForStack('TestStack', state, {
      stateBackend: {
        saveState: mockSaveState,
        deleteState: mockDeleteState,
        getState: vi.fn(async () => ({ state, etag: 'e' })),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({
          provider: {
            delete: vi.fn(async (_logicalId: string, physicalId: string) => {
              order.push(physicalId);
              const at = failing.indexOf(physicalId);
              if (at >= 0) {
                failing.splice(at, 1);
                throw new Error(`${physicalId} is still in use`);
              }
              return undefined;
            }),
          },
        }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as never);
  }

  beforeEach(() => {
    order.length = 0;
    failing = [];
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
  });

  it('deletes an old security group before the VPC its record depends on', async () => {
    const result = await run(
      stackState(
        {
          Vpc: record('vpc-1', 'AWS::EC2::VPC'),
          Sg: record('sg-new', 'AWS::EC2::SecurityGroup', ['Vpc']),
        },
        [superseded('Sg', record('sg-old', 'AWS::EC2::SecurityGroup', ['Vpc']))]
      )
    );

    expect(order).toEqual(['sg-new', 'sg-old', 'vpc-1']);
    expect(result.errorCount).toBe(0);
    expect(result.deletedCount).toBe(3);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  it('goes before the first resource it depends on, after its current record\'s dependents', async () => {
    // Instance holds the current group; the old group's record names the
    // subnet, which the VPC outlives.
    await run(
      stackState(
        {
          Vpc: record('vpc-1', 'AWS::EC2::VPC'),
          Subnet: record('subnet-1', 'AWS::EC2::Subnet', ['Vpc']),
          Sg: record('sg-new', 'AWS::EC2::SecurityGroup', ['Vpc']),
          Instance: record('i-1', 'AWS::EC2::Instance', ['Sg', 'Subnet']),
        },
        [superseded('Sg', record('sg-old', 'AWS::EC2::SecurityGroup', ['Subnet']))]
      )
    );

    // After the instance (the current group's dependent), before the subnet
    // and the current group's level; the VPC last.
    expect(order).toEqual(['i-1', 'sg-old', 'subnet-1', 'sg-new', 'vpc-1']);
  });

  it('orders a row recording no dependency by its type, as the levels are', async () => {
    await run(
      stackState({ Vpc: record('vpc-1', 'AWS::EC2::VPC') }, [
        superseded('Sg', record('sg-old', 'AWS::EC2::SecurityGroup')),
      ])
    );

    expect(order).toEqual(['sg-old', 'vpc-1']);
  });

  it('keeps a row naming no remaining resource after the levels', async () => {
    await run(
      stackState({ Vpc: record('vpc-1', 'AWS::EC2::VPC') }, [
        superseded('Tg', record('old-tg', 'AWS::ElasticLoadBalancingV2::TargetGroup', ['Gone'])),
      ])
    );

    expect(order).toEqual(['vpc-1', 'old-tg']);
  });

  it('keeps a failed row and still sends the delete of what it depends on', async () => {
    failing = ['sg-old'];

    const result = await run(
      stackState(
        {
          Vpc: record('vpc-1', 'AWS::EC2::VPC'),
          Sg: record('sg-new', 'AWS::EC2::SecurityGroup', ['Vpc']),
        },
        [superseded('Sg', record('sg-old', 'AWS::EC2::SecurityGroup', ['Vpc']))]
      )
    );

    expect(order).toEqual(['sg-new', 'sg-old', 'vpc-1']);
    expect(result.errorCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
    const last = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(last.supersededResources?.map((row) => row.state.physicalId)).toEqual(['sg-old']);
  });

  it("retries a custom resource's failed early delete before its handler goes", async () => {
    failing = ['name-1'];

    const result = await run(
      stackState(
        {
          Handler: record('handler', 'AWS::Lambda::Function'),
          Res: record('name-2', 'Custom::Thing', ['Handler']),
        },
        [superseded('Res', record('name-1', 'Custom::Thing', ['Handler']))]
      )
    );

    expect(order).toEqual(['name-1', 'name-2', 'name-1', 'handler']);
    expect(result.errorCount).toBe(0);
  });
});

describe('scheduleSupersededDeletes (#7073)', () => {
  const slotsOf = (
    resources: Record<string, ResourceState>,
    rows: SupersededResourceRecord[],
    levels: string[][],
    retryLate: Set<SupersededResourceRecord> = new Set()
  ): string[][] =>
    scheduleSupersededDeletes({ resources, supersededResources: rows }, levels, retryLate).map(
      (slot) => slot.map((row) => row.state.physicalId)
    );

  it('never goes before the level of its own current record (bounds crossed: after the levels)', () => {
    // Policy depends on Role, so Policy goes first; the old Role row names
    // Policy, which would put it before the current Role's dependents.
    const resources = {
      Role: record('role-new', 'AWS::IAM::Role'),
      Policy: record('policy', 'AWS::IAM::Policy', ['Role']),
    };
    const rows = [superseded('Role', record('role-old', 'AWS::IAM::Role', ['Policy']))];

    expect(slotsOf(resources, rows, [['Role'], ['Policy']])).toEqual([[], [], ['role-old']]);
  });

  it('never goes before a resource of a type that must be deleted before its type', () => {
    // An internet gateway goes after every NAT gateway (the type rule), even
    // when its record names a resource on the same level as the NAT.
    const resources = {
      Vpc: record('vpc-1', 'AWS::EC2::VPC'),
      Subnet: record('subnet-1', 'AWS::EC2::Subnet', ['Vpc']),
      Nat: record('nat-1', 'AWS::EC2::NatGateway', ['Subnet']),
    };
    const rows = [superseded('Igw', record('igw-old', 'AWS::EC2::InternetGateway', ['Subnet']))];

    expect(slotsOf(resources, rows, [['Vpc'], ['Subnet', 'Nat']])).toEqual([[], [], ['igw-old']]);
  });

  it('moves a row no later than a row it depends on, the dependent first', () => {
    const resources = { Vpc: record('vpc-1', 'AWS::EC2::VPC') };
    const rows = [
      superseded('Eni', record('eni-old', 'AWS::EC2::NetworkInterface', ['Sg'])),
      superseded('Sg', record('sg-old', 'AWS::EC2::SecurityGroup', ['Vpc'])),
    ];

    expect(slotsOf(resources, rows, [['Vpc']])).toEqual([['eni-old', 'sg-old'], []]);
  });

  it('never moves a row past its own lower bound to follow a row it depends on (both go after the levels)', () => {
    // D depends on R and O on D. Old O names D (slot 1); old R names O, and
    // its own bounds cross (after the levels). Following O would delete old R
    // before D, which may still name it.
    const resources = {
      R: record('r-new', 'AWS::IAM::Role'),
      D: record('d', 'AWS::IAM::Policy', ['R']),
      O: record('o-new', 'AWS::IAM::Role', ['D']),
    };
    const rows = [
      superseded('O', record('o-old', 'AWS::IAM::Role', ['D'])),
      superseded('R', record('r-old', 'AWS::IAM::Role', ['O'])),
    ];

    expect(slotsOf(resources, rows, [['R'], ['D'], ['O']])).toEqual([[], [], [], ['r-old', 'o-old']]);
  });

  it('holds both rows after the levels when following would pass the lower bound', () => {
    // Old X (lower bound: its current record's step 1) names Y; old Y names
    // D (slot 0). Following Y would delete old X before D.
    const resources = {
      X: record('x-new', 'AWS::IAM::Role'),
      D: record('d', 'AWS::IAM::Policy', ['X']),
    };
    const rows = [
      superseded('X', record('x-old', 'AWS::IAM::Role', ['Y'])),
      superseded('Y', record('y-old', 'AWS::IAM::Role', ['D'])),
    ];

    expect(slotsOf(resources, rows, [['X'], ['D']])).toEqual([[], [], ['x-old', 'y-old']]);
  });

  it('never goes before a record that names its logical id, with no current record of it', () => {
    // D still names R (a failed deploy left it), which has no current record.
    const resources = {
      X: record('x', 'AWS::IAM::Role'),
      D: record('d', 'AWS::IAM::Policy', ['R']),
    };
    const rows = [superseded('R', record('r-old', 'AWS::IAM::Role', ['X']))];

    expect(slotsOf(resources, rows, [['X', 'D']])).toEqual([[], ['r-old']]);
  });

  it('keeps a row whose bounds cross after the levels, and the rows it depends on with it', () => {
    // Old R's bounds cross (X before, D after it); old Q, which it names,
    // could go before V, but R holds it: both after the levels.
    const resources = {
      V: record('v', 'AWS::IAM::Role'),
      X: record('x', 'AWS::IAM::Role', ['V']),
      D: record('d', 'AWS::IAM::Policy', ['R', 'V']),
    };
    const rows = [
      superseded('R', record('r-old', 'AWS::IAM::Role', ['X', 'Q'])),
      superseded('Q', record('q-old', 'AWS::IAM::Role', ['V'])),
    ];

    expect(slotsOf(resources, rows, [['V'], ['X', 'D']])).toEqual([[], [], ['r-old', 'q-old']]);
  });

  it("schedules a custom resource's row only when its early attempt asked for a retry", () => {
    const resources = { Handler: record('handler', 'AWS::Lambda::Function') };
    const settled = superseded('A', record('a-old', 'Custom::Thing', ['Handler']));
    const retried = superseded('B', record('b-old', 'Custom::Thing', ['Handler']));

    expect(slotsOf(resources, [settled, retried], [['Handler']], new Set([retried]))).toEqual([
      ['b-old'],
      [],
    ]);
  });

  it('skips a null record instead of throwing', () => {
    const resources = { Vpc: record('vpc-1', 'AWS::EC2::VPC'), Bad: null } as unknown as Record<
      string,
      ResourceState
    >;
    const rows = [superseded('Sg', record('sg-old', 'AWS::EC2::SecurityGroup', ['Vpc']))];

    expect(slotsOf(resources, rows, [['Vpc', 'Bad']])).toEqual([['sg-old'], []]);
  });

  it('reads the type table by own key only', () => {
    const resources = { Odd: record('odd-1', 'constructor') };
    const rows = [superseded('X', record('x-old', 'toString'))];

    expect(slotsOf(resources, rows, [['Odd']])).toEqual([[], ['x-old']]);
  });
});
