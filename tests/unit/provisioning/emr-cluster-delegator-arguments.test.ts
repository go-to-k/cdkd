/**
 * The `EMRClusterProvider` method bodies live in
 * `src/provisioning/providers/emr-cluster/*.ts`; the class keeps one
 * `return f.call(this, ...)` delegator per moved method, and each argument a
 * delegator hands on is a hand-off the split introduced.
 *
 * Every companion function is a pass-through spy on the real one. The first
 * block stubs each spy once and pins, for EVERY delegator, that it calls its
 * own function with the provider as `this`, every argument in declared order,
 * and returns that function's result. The second block runs real bodies end to
 * end and pins the SDK command each sends, by class and input.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-emr', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-emr')>('@aws-sdk/client-emr');
  return {
    ...actual,
    EMRClient: vi.fn().mockImplementation(() => ({
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

vi.mock('../../../src/provisioning/providers/emr-cluster/core.js', () =>
  spied('../../../src/provisioning/providers/emr-cluster/core.js')
);
vi.mock('../../../src/provisioning/providers/emr-cluster/create.js', () =>
  spied('../../../src/provisioning/providers/emr-cluster/create.js')
);
vi.mock('../../../src/provisioning/providers/emr-cluster/update.js', () =>
  spied('../../../src/provisioning/providers/emr-cluster/update.js')
);
vi.mock('../../../src/provisioning/providers/emr-cluster/delete.js', () =>
  spied('../../../src/provisioning/providers/emr-cluster/delete.js')
);
vi.mock('../../../src/provisioning/providers/emr-cluster/read-state.js', () =>
  spied('../../../src/provisioning/providers/emr-cluster/read-state.js')
);

import { DescribeClusterCommand, TerminateJobFlowsCommand } from '@aws-sdk/client-emr';
import { EMRClusterProvider } from '../../../src/provisioning/providers/emr-cluster-provider.js';
import * as core from '../../../src/provisioning/providers/emr-cluster/core.js';
import * as create from '../../../src/provisioning/providers/emr-cluster/create.js';
import * as update from '../../../src/provisioning/providers/emr-cluster/update.js';
import * as del from '../../../src/provisioning/providers/emr-cluster/delete.js';
import * as readState from '../../../src/provisioning/providers/emr-cluster/read-state.js';

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  create,
  update,
  delete: del,
  'read-state': readState,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['wrapStatusReasonError', 'core', 'wrapStatusReasonError', 4],
  ['wrapCaughtError', 'core', 'wrapCaughtError', 3],
  ['cleanupFailureText', 'core', 'cleanupFailureText', 3],
  ['getClient', 'core', 'getClient', 0],
  ['getCreateClient', 'core', 'getCreateClient', 0],
  ['create', 'create', 'create', 4],
  ['toJobFlowInstancesConfig', 'create', 'toJobFlowInstancesConfig', 1],
  ['toInstanceGroupConfig', 'create', 'toInstanceGroupConfig', 2],
  ['toInstanceFleetConfig', 'create', 'toInstanceFleetConfig', 2],
  ['toManagedScalingPolicy', 'create', 'toManagedScalingPolicy', 1],
  ['toAutoTerminationPolicy', 'create', 'toAutoTerminationPolicy', 1],
  ['resolveInstancesTargets', 'update', 'resolveInstancesTargets', 3],
  ['applyInstancesResizes', 'update', 'applyInstancesResizes', 5],
  ['update', 'update', 'update', 6],
  ['applyTagDiff', 'update', 'applyTagDiff', 5],
  ['delete', 'delete', 'deleteImpl', 5],
  ['deleteOnce', 'delete', 'deleteOnce', 5],
  ['describeForPoll', 'delete', 'describeForPoll', 3],
  ['waitForClusterReady', 'delete', 'waitForClusterReady', 4],
  ['waitForClusterTerminated', 'delete', 'waitForClusterTerminated', 4],
  ['buildAttributes', 'read-state', 'buildAttributes', 1],
  ['getAttribute', 'read-state', 'getAttribute', 3],
  ['isSameResource', 'read-state', 'isSameResource', 4],
  ['readClusterIdentity', 'read-state', 'readClusterIdentity', 1],
  ['import', 'read-state', 'importImpl', 1],
  ['describeClusterOrUndefined', 'read-state', 'describeClusterOrUndefined', 1],
  ['readCurrentState', 'read-state', 'readCurrentState', 3],
  ['listInstanceGroups', 'read-state', 'listInstanceGroups', 1],
  ['listInstanceFleets', 'read-state', 'listInstanceFleets', 1],
  ['reverseInstancesToCfn', 'read-state', 'reverseInstancesToCfn', 3],
  ['reverseInstanceGroup', 'read-state', 'reverseInstanceGroup', 1],
  ['reverseInstanceFleet', 'read-state', 'reverseInstanceFleet', 1],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set(['constructor', 'getMinResourceTimeoutMs', 'getDriftUnknownPaths']);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

const RESOURCE_TYPE = 'AWS::EMR::Cluster';

describe('EMRClusterProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(EMRClusterProvider.prototype).filter(
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
      const provider = new EMRClusterProvider();
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

describe('EMRClusterProvider moved bodies send the SDK command the delegator names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  it('getAttribute describes the cluster the physical id names', async () => {
    mockSend.mockResolvedValue({ Cluster: { MasterPublicDnsName: 'dns.example' } });
    const value = await new EMRClusterProvider().getAttribute(
      'j-ABC123',
      RESOURCE_TYPE,
      'MasterPublicDNS'
    );
    expect(value).toBe('dns.example');
    const command = mockSend.mock.calls[0]![0] as DescribeClusterCommand;
    expect(command).toBeInstanceOf(DescribeClusterCommand);
    expect(command.input).toEqual({ ClusterId: 'j-ABC123' });
  });

  it('delete terminates the cluster the physical id names', async () => {
    let describes = 0;
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeClusterCommand) {
        describes += 1;
        return {
          Cluster: {
            Id: 'j-ABC123',
            Status: { State: describes === 1 ? 'RUNNING' : 'TERMINATED' },
          },
        };
      }
      return {};
    });
    await new EMRClusterProvider({ pollIntervalMs: 1, maxWaitMs: 1000 }).delete(
      'MyCluster',
      'j-ABC123',
      RESOURCE_TYPE
    );
    const terminates = mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof TerminateJobFlowsCommand);
    expect(terminates.map((c) => c.input)).toEqual([{ JobFlowIds: ['j-ABC123'] }]);
    const describeInputs = mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof DescribeClusterCommand)
      .map((c) => c.input);
    expect(describeInputs.length).toBeGreaterThanOrEqual(2);
    for (const input of describeInputs) expect(input).toEqual({ ClusterId: 'j-ABC123' });
  });
});
