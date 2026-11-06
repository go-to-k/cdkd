/**
 * The `ASGProvider` method bodies live in `src/provisioning/providers/asg/*.ts`;
 * the class keeps one `return f.call(this, ...)` delegator per moved method,
 * and each argument a delegator hands on is a hand-off the split introduced.
 *
 * Every companion function is a pass-through spy on the real one. The first
 * block stubs each spy once and pins, for EVERY delegator, that it calls its
 * own function with the provider as `this`, every argument in declared order,
 * and returns that function's result. The second block runs real bodies end to
 * end and pins the SDK command each sends, by class and input.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-auto-scaling', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-auto-scaling')>(
    '@aws-sdk/client-auto-scaling'
  );
  return {
    ...actual,
    AutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

/** Replace every function a module exports with a pass-through spy. */
async function spied(path: string): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<Record<string, unknown>>(path);
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(v as (...a: unknown[]) => unknown) : v,
    ])
  );
}

vi.mock('../../../src/provisioning/providers/asg/core.js', () =>
  spied('../../../src/provisioning/providers/asg/core.js')
);
vi.mock('../../../src/provisioning/providers/asg/create.js', () =>
  spied('../../../src/provisioning/providers/asg/create.js')
);
vi.mock('../../../src/provisioning/providers/asg/update.js', () =>
  spied('../../../src/provisioning/providers/asg/update.js')
);
vi.mock('../../../src/provisioning/providers/asg/delete.js', () =>
  spied('../../../src/provisioning/providers/asg/delete.js')
);
vi.mock('../../../src/provisioning/providers/asg/read-state.js', () =>
  spied('../../../src/provisioning/providers/asg/read-state.js')
);
vi.mock('../../../src/provisioning/providers/asg/update-lists.js', () =>
  spied('../../../src/provisioning/providers/asg/update-lists.js')
);

import {
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import * as core from '../../../src/provisioning/providers/asg/core.js';
import * as create from '../../../src/provisioning/providers/asg/create.js';
import * as update from '../../../src/provisioning/providers/asg/update.js';
import * as del from '../../../src/provisioning/providers/asg/delete.js';
import * as readState from '../../../src/provisioning/providers/asg/read-state.js';
import * as updateLists from '../../../src/provisioning/providers/asg/update-lists.js';

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  create,
  update,
  delete: del,
  'read-state': readState,
  'update-lists': updateLists,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['canonicalizeDriftProperties', 'read-state', 'canonicalizeDriftProperties', 2],
  ['canonicalizeDriftPair', 'read-state', 'canonicalizeDriftPair', 3],
  ['getClient', 'core', 'getClient', 0],
  ['getCreateClient', 'core', 'getCreateClient', 0],
  ['getEc2Client', 'core', 'getEc2Client', 0],
  ['create', 'create', 'create', 4],
  ['retireFailedCreate', 'create', 'retireFailedCreate', 4],
  ['update', 'update', 'update', 6],
  ['wrapCaughtError', 'core', 'wrapCaughtError', 3],
  ['wrapUpdateError', 'core', 'wrapUpdateError', 5],
  ['delete', 'delete', 'deleteImpl', 5],
  ['settleInstanceFlips', 'delete', 'settleInstanceFlips', 5],
  ['reEnableLaunchedInstance', 'delete', 'reEnableLaunchedInstance', 1],
  ['releaseInstanceFlips', 'delete', 'releaseInstanceFlips', 2],
  ['deleteGroupUnderCompensation', 'delete', 'deleteGroupUnderCompensation', 6],
  ['deleteOnce', 'delete', 'deleteOnce', 5],
  ['getAttribute', 'read-state', 'getAttribute', 4],
  ['readCurrentState', 'read-state', 'readCurrentState', 3],
  ['buildLaunchTemplate', 'core', 'buildLaunchTemplate', 1],
  ['buildTags', 'core', 'buildTags', 2],
  ['joinVpcZoneIdentifier', 'core', 'joinVpcZoneIdentifier', 1],
  ['describeGroup', 'core', 'describeGroup', 1],
  ['removeInstanceTerminationProtection', 'delete', 'removeInstanceTerminationProtection', 4],
  [
    'removeInstanceTerminationProtectionForDelete',
    'delete',
    'removeInstanceTerminationProtectionForDelete',
    4,
  ],
  ['listGroupInstanceIds', 'delete', 'listGroupInstanceIds', 3],
  ['fetchArn', 'core', 'fetchArn', 2],
  ['isNotFoundError', 'core', 'isNotFoundError', 1],
  ['waitForGroupDeleted', 'delete', 'waitForGroupDeleted', 2],
  ['sleep', 'core', 'sleep', 1],
  ['readUpdateLists', 'update-lists', 'readUpdateLists', 5],
  ['recordedListRepair', 'update-lists', 'recordedListRepair', 2],
  ['applyTagsDiff', 'update-lists', 'applyTagsDiff', 3],
  ['applyLoadBalancerNamesDiff', 'update-lists', 'applyLoadBalancerNamesDiff', 3],
  ['applyTargetGroupArnsDiff', 'update-lists', 'applyTargetGroupArnsDiff', 5],
  ['applyMetricsCollectionDiff', 'update-lists', 'applyMetricsCollectionDiff', 3],
  ['applyLifecycleHooksDiff', 'update-lists', 'applyLifecycleHooksDiff', 3],
  ['applyTrafficSourcesDiff', 'update-lists', 'applyTrafficSourcesDiff', 3],
  ['applyNotificationConfigurationsDiff', 'update-lists', 'applyNotificationConfigurationsDiff', 3],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set(['constructor', 'waitForTargetGroupArnsConvergence']);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

const RESOURCE_TYPE = 'AWS::AutoScaling::AutoScalingGroup';

describe('ASGProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(ASGProvider.prototype).filter(
      (m) => !KEPT_ON_CLASS.has(m)
    );
    expect(methods.sort()).toEqual(DELEGATORS.map(([m]) => m).sort());
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} calls ${mod}.${fn} with this, ${arity} argument(s) in order, and returns its result`, () => {
      const spy = MODULES[mod]![fn] as Spy;
      expect(vi.isMockFunction(spy), `${mod}.${fn} is not spied`).toBe(true);
      const result = { result: method };
      spy.mockImplementationOnce(() => result);
      const provider = new ASGProvider();
      const args = Array.from({ length: arity }, (_, i) => ({ arg: i }));
      const returned = (provider as unknown as Record<string, Callable>)[method]!(...args);
      expect(returned).toBe(result);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(args);
      spy.mock.calls[0]!.forEach((a, i) => expect(a).toBe(args[i]));
      expect(spy.mock.contexts[0]).toBe(provider);
    });
  }
});

describe('ASGProvider moved bodies send the SDK command the delegator names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  it('readCurrentState describes the group the physical id names', async () => {
    mockSend.mockResolvedValue({ AutoScalingGroups: [] });
    await new ASGProvider().readCurrentState('my-asg', 'MyAsg', RESOURCE_TYPE);
    const command = mockSend.mock.calls[0]![0] as DescribeAutoScalingGroupsCommand;
    expect(command).toBeInstanceOf(DescribeAutoScalingGroupsCommand);
    expect(command.input).toEqual({ AutoScalingGroupNames: ['my-asg'] });
  });

  it('delete deletes the group the physical id names', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeAutoScalingGroupsCommand) return { AutoScalingGroups: [] };
      return {};
    });
    await new ASGProvider().delete('MyAsg', 'my-asg', RESOURCE_TYPE);
    const deletes = mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof DeleteAutoScalingGroupCommand);
    expect(deletes.map((c) => c.input)).toEqual([
      { AutoScalingGroupName: 'my-asg', ForceDelete: false },
    ]);
    expect(
      mockSend.mock.calls.some(([c]) => c instanceof UpdateAutoScalingGroupCommand),
      'no DeletionProtection flip without --remove-protection'
    ).toBe(false);
  });
});
