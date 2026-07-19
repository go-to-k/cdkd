import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { EMRInstanceGroupConfigProvider } from '../../../../src/provisioning/providers/emr-instance-group-config-provider.js';
import {
  AddInstanceGroupsCommand,
  ModifyInstanceGroupsCommand,
  ListInstanceGroupsCommand,
  PutAutoScalingPolicyCommand,
  RemoveAutoScalingPolicyCommand,
  InvalidRequestException,
} from '@aws-sdk/client-emr';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::EMR::InstanceGroupConfig';
const CLUSTER_ID = 'j-1A2B3C4D5E6F7';
const GROUP_ID = 'ig-ABCDEF123456';

const BASE_PROPS = {
  JobFlowId: CLUSTER_ID,
  InstanceRole: 'TASK',
  InstanceType: 'm5.xlarge',
  InstanceCount: 2,
  Name: 'task-group',
  Market: 'ON_DEMAND',
};

const groupOf = (state: string, runningInstanceCount = 2) => ({
  InstanceGroups: [
    {
      Id: GROUP_ID,
      InstanceGroupType: 'TASK',
      RunningInstanceCount: runningInstanceCount,
      Status: { State: state, StateChangeReason: { Message: `state is ${state}` } },
    },
  ],
});

function callsOf(commandClass: abstract new (...args: never[]) => object): Array<{
  input: Record<string, unknown>;
}> {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((c) => c instanceof commandClass) as Array<{ input: Record<string, unknown> }>;
}

/**
 * Route mockSend by command class name. Array values are a QUEUE — each call
 * consumes the next entry, the last entry repeats. `Error` values reject.
 */
function routeSend(routes: Record<string, unknown>): void {
  const queues = new Map<string, unknown[]>();
  mockSend.mockImplementation((command: object) => {
    const name = command.constructor.name;
    if (!(name in routes)) {
      return Promise.reject(new Error(`Unexpected command: ${name}`));
    }
    let value = routes[name];
    if (Array.isArray(value)) {
      if (!queues.has(name)) queues.set(name, [...(value as unknown[])]);
      const queue = queues.get(name)!;
      value = queue.length > 1 ? queue.shift() : queue[0];
    }
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value);
  });
}

function invalidRequest(): InvalidRequestException {
  return new InvalidRequestException({
    message: `Instance group id '${GROUP_ID}' is not valid.`,
    $metadata: {},
  });
}

function newProvider(overrides: { maxWaitMs?: number } = {}): EMRInstanceGroupConfigProvider {
  return new EMRInstanceGroupConfigProvider({
    pollIntervalMs: 0,
    maxWaitMs: overrides.maxWaitMs ?? 5000,
  });
}

describe('EMRInstanceGroupConfigProvider create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds the group, polls PROVISIONING → RUNNING, returns physicalId + Id attribute', async () => {
    routeSend({
      AddInstanceGroupsCommand: { JobFlowId: CLUSTER_ID, InstanceGroupIds: [GROUP_ID] },
      ListInstanceGroupsCommand: [groupOf('PROVISIONING'), groupOf('BOOTSTRAPPING'), groupOf('RUNNING')],
    });

    const result = await newProvider().create('Grp', RESOURCE_TYPE, BASE_PROPS);

    expect(result.physicalId).toBe(GROUP_ID);
    expect(result.attributes).toEqual({ Id: GROUP_ID });

    const add = callsOf(AddInstanceGroupsCommand);
    expect(add).toHaveLength(1);
    expect(add[0]!.input.JobFlowId).toBe(CLUSTER_ID);
    const groups = add[0]!.input.InstanceGroups as Array<Record<string, unknown>>;
    expect(groups[0]).toMatchObject({
      InstanceRole: 'TASK',
      InstanceType: 'm5.xlarge',
      InstanceCount: 2,
      Name: 'task-group',
      Market: 'ON_DEMAND',
    });
  });

  it('rejects when JobFlowId is absent', async () => {
    routeSend({});
    const { JobFlowId: _drop, ...noParent } = BASE_PROPS;
    await expect(newProvider().create('Grp', RESOURCE_TYPE, noParent)).rejects.toThrow(
      ProvisioningError
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects when AddInstanceGroups returns no instance group id', async () => {
    routeSend({ AddInstanceGroupsCommand: { JobFlowId: CLUSTER_ID, InstanceGroupIds: [] } });
    await expect(newProvider().create('Grp', RESOURCE_TYPE, BASE_PROPS)).rejects.toThrow(
      /returned no instance group id/
    );
  });

  it('fails when the group enters a failed terminal state (ARRESTED)', async () => {
    routeSend({
      AddInstanceGroupsCommand: { InstanceGroupIds: [GROUP_ID] },
      ListInstanceGroupsCommand: groupOf('ARRESTED'),
    });
    await expect(newProvider().create('Grp', RESOURCE_TYPE, BASE_PROPS)).rejects.toThrow(
      /failed state ARRESTED/
    );
  });

  it('times out when the group never reaches RUNNING', async () => {
    routeSend({
      AddInstanceGroupsCommand: { InstanceGroupIds: [GROUP_ID] },
      ListInstanceGroupsCommand: groupOf('PROVISIONING'),
    });
    await expect(
      newProvider({ maxWaitMs: 1 }).create('Grp', RESOURCE_TYPE, BASE_PROPS)
    ).rejects.toThrow(/Timed out/);
  });

  it('rejects an unsupported resource type', async () => {
    routeSend({});
    await expect(newProvider().create('X', 'AWS::EMR::Cluster', BASE_PROPS)).rejects.toThrow(
      /Unsupported resource type/
    );
  });
});

describe('EMRInstanceGroupConfigProvider update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resizes via ModifyInstanceGroups and polls until the new count is RUNNING', async () => {
    routeSend({
      ModifyInstanceGroupsCommand: {},
      ListInstanceGroupsCommand: [groupOf('RESIZING', 2), groupOf('RUNNING', 5)],
    });

    const next = { ...BASE_PROPS, InstanceCount: 5 };
    const result = await newProvider().update('Grp', GROUP_ID, RESOURCE_TYPE, next, BASE_PROPS);

    expect(result.wasReplaced).toBe(false);
    expect(result.physicalId).toBe(GROUP_ID);
    const modify = callsOf(ModifyInstanceGroupsCommand);
    expect(modify).toHaveLength(1);
    expect(modify[0]!.input.ClusterId).toBe(CLUSTER_ID);
    const groups = modify[0]!.input.InstanceGroups as Array<Record<string, unknown>>;
    expect(groups[0]).toEqual({ InstanceGroupId: GROUP_ID, InstanceCount: 5 });
  });

  it('keeps waiting through the stale pre-resize RUNNING state until the new count is reached', async () => {
    // Regression: right after ModifyInstanceGroups the group is still in the
    // PRE-resize RUNNING state with the OLD count (2). A State-only wait would
    // return immediately; the count check must keep it polling until Running
    // reaches the new target (5).
    routeSend({
      ModifyInstanceGroupsCommand: {},
      ListInstanceGroupsCommand: [
        groupOf('RUNNING', 2), // stale pre-resize RUNNING — must NOT satisfy the wait
        groupOf('RESIZING', 2),
        groupOf('RUNNING', 5), // resize complete
      ],
    });

    const next = { ...BASE_PROPS, InstanceCount: 5 };
    await newProvider().update('Grp', GROUP_ID, RESOURCE_TYPE, next, BASE_PROPS);

    // 3 polls consumed (stale RUNNING, RESIZING, final RUNNING) proves the
    // stale RUNNING did not short-circuit the wait.
    expect(callsOf(ListInstanceGroupsCommand)).toHaveLength(3);
  });

  it('applies an added AutoScalingPolicy via PutAutoScalingPolicy', async () => {
    routeSend({ PutAutoScalingPolicyCommand: {} });
    const policy = { Constraints: { MinCapacity: 1, MaxCapacity: 4 }, Rules: [] };
    const next = { ...BASE_PROPS, AutoScalingPolicy: policy };
    await newProvider().update('Grp', GROUP_ID, RESOURCE_TYPE, next, BASE_PROPS);

    const put = callsOf(PutAutoScalingPolicyCommand);
    expect(put).toHaveLength(1);
    expect(put[0]!.input).toMatchObject({
      ClusterId: CLUSTER_ID,
      InstanceGroupId: GROUP_ID,
      AutoScalingPolicy: policy,
    });
    expect(callsOf(ModifyInstanceGroupsCommand)).toHaveLength(0);
  });

  it('removes a dropped AutoScalingPolicy via RemoveAutoScalingPolicy', async () => {
    routeSend({ RemoveAutoScalingPolicyCommand: {} });
    const prev = { ...BASE_PROPS, AutoScalingPolicy: { Constraints: {}, Rules: [] } };
    await newProvider().update('Grp', GROUP_ID, RESOURCE_TYPE, BASE_PROPS, prev);

    const remove = callsOf(RemoveAutoScalingPolicyCommand);
    expect(remove).toHaveLength(1);
    expect(remove[0]!.input).toEqual({ ClusterId: CLUSTER_ID, InstanceGroupId: GROUP_ID });
  });

  it('resizes without JobFlowId: the modify applies but the poll wait is skipped', async () => {
    routeSend({ ModifyInstanceGroupsCommand: {} });
    const { JobFlowId: _drop, ...noParent } = BASE_PROPS;
    const next = { ...noParent, InstanceCount: 5 };
    const result = await newProvider().update('Grp', GROUP_ID, RESOURCE_TYPE, next, noParent);

    expect(result.wasReplaced).toBe(false);
    const modify = callsOf(ModifyInstanceGroupsCommand);
    expect(modify).toHaveLength(1);
    expect(modify[0]!.input.ClusterId).toBeUndefined();
    // No ClusterId → cannot ListInstanceGroups → the settle wait is skipped.
    expect(callsOf(ListInstanceGroupsCommand)).toHaveLength(0);
  });

  it('throws when an AutoScalingPolicy change is made without a JobFlowId', async () => {
    routeSend({});
    const { JobFlowId: _drop, ...noParent } = BASE_PROPS;
    const next = { ...noParent, AutoScalingPolicy: { Constraints: {}, Rules: [] } };
    await expect(
      newProvider().update('Grp', GROUP_ID, RESOURCE_TYPE, next, noParent)
    ).rejects.toThrow(/needs JobFlowId/);
  });

  it('follows the ListInstanceGroups Marker pagination to find the group on a later page', async () => {
    let call = 0;
    mockSend.mockImplementation((command: object) => {
      const name = command.constructor.name;
      if (name === 'ModifyInstanceGroupsCommand') return Promise.resolve({});
      if (name === 'ListInstanceGroupsCommand') {
        call += 1;
        if (call === 1) {
          return Promise.resolve({ InstanceGroups: [{ Id: 'ig-OTHER' }], Marker: 'page2' });
        }
        return Promise.resolve(groupOf('RUNNING', 5));
      }
      return Promise.reject(new Error(`Unexpected command: ${name}`));
    });

    const next = { ...BASE_PROPS, InstanceCount: 5 };
    await newProvider().update('Grp', GROUP_ID, RESOURCE_TYPE, next, BASE_PROPS);
    expect(callsOf(ListInstanceGroupsCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('absorbs a transient ListInstanceGroups error while polling, then settles', async () => {
    routeSend({
      ModifyInstanceGroupsCommand: {},
      ListInstanceGroupsCommand: [
        Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
        groupOf('RUNNING', 5),
      ],
    });
    const next = { ...BASE_PROPS, InstanceCount: 5 };
    await expect(
      newProvider().update('Grp', GROUP_ID, RESOURCE_TYPE, next, BASE_PROPS)
    ).resolves.toBeDefined();
  });

  it('refuses an immutable (createOnly) property change with a --replace pointer', async () => {
    routeSend({});
    const next = { ...BASE_PROPS, InstanceType: 'm5.2xlarge' };
    await expect(
      newProvider().update('Grp', GROUP_ID, RESOURCE_TYPE, next, BASE_PROPS)
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing mutable changed', async () => {
    routeSend({});
    const result = await newProvider().update('Grp', GROUP_ID, RESOURCE_TYPE, BASE_PROPS, BASE_PROPS);
    expect(result).toEqual({ physicalId: GROUP_ID, wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EMRInstanceGroupConfigProvider delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scales a TASK group to 0 to release its instances', async () => {
    routeSend({ ModifyInstanceGroupsCommand: {} });
    await newProvider().delete('Grp', GROUP_ID, RESOURCE_TYPE, BASE_PROPS);

    const modify = callsOf(ModifyInstanceGroupsCommand);
    expect(modify).toHaveLength(1);
    const groups = modify[0]!.input.InstanceGroups as Array<Record<string, unknown>>;
    expect(groups[0]).toEqual({ InstanceGroupId: GROUP_ID, InstanceCount: 0 });
  });

  it('is a pure no-op for a CORE group (no standalone delete API)', async () => {
    routeSend({});
    await newProvider().delete('Grp', GROUP_ID, RESOURCE_TYPE, {
      ...BASE_PROPS,
      InstanceRole: 'CORE',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('treats an InvalidRequestException on scale-to-0 as already-gone when the region matches', async () => {
    routeSend({ ModifyInstanceGroupsCommand: invalidRequest() });
    await expect(
      newProvider().delete('Grp', GROUP_ID, RESOURCE_TYPE, BASE_PROPS, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('throws on an InvalidRequestException when the client region does not match state', async () => {
    routeSend({ ModifyInstanceGroupsCommand: invalidRequest() });
    await expect(
      newProvider().delete('Grp', GROUP_ID, RESOURCE_TYPE, BASE_PROPS, {
        expectedRegion: 'us-west-2',
      })
    ).rejects.toThrow(ProvisioningError);
  });

  it('warn-and-continues on a non-NotFound scale-to-0 error (never blocks destroy)', async () => {
    routeSend({ ModifyInstanceGroupsCommand: new Error('throttled') });
    await expect(
      newProvider().delete('Grp', GROUP_ID, RESOURCE_TYPE, BASE_PROPS)
    ).resolves.toBeUndefined();
  });

  it('is a no-op when properties are absent', async () => {
    routeSend({});
    await newProvider().delete('Grp', GROUP_ID, RESOURCE_TYPE);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EMRInstanceGroupConfigProvider getAttribute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the physical id for Id and undefined for anything else', async () => {
    const provider = newProvider();
    expect(await provider.getAttribute(GROUP_ID, RESOURCE_TYPE, 'Id')).toBe(GROUP_ID);
    expect(await provider.getAttribute(GROUP_ID, RESOURCE_TYPE, 'Other')).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
