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

import { EMRInstanceFleetConfigProvider } from '../../../../src/provisioning/providers/emr-instance-fleet-config-provider.js';
import {
  AddInstanceFleetCommand,
  ModifyInstanceFleetCommand,
  ListInstanceFleetsCommand,
  InvalidRequestException,
} from '@aws-sdk/client-emr';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::EMR::InstanceFleetConfig';
const CLUSTER_ID = 'j-1A2B3C4D5E6F7';
const FLEET_ID = 'if-ABCDEF123456';

const BASE_PROPS = {
  ClusterId: CLUSTER_ID,
  InstanceFleetType: 'TASK',
  Name: 'task-fleet',
  TargetOnDemandCapacity: 2,
  TargetSpotCapacity: 0,
  InstanceTypeConfigs: [{ InstanceType: 'm5.xlarge', WeightedCapacity: 1 }],
};

const fleetOf = (state: string, provisionedOnDemand = 2) => ({
  InstanceFleets: [
    {
      Id: FLEET_ID,
      InstanceFleetType: 'TASK',
      ProvisionedOnDemandCapacity: provisionedOnDemand,
      ProvisionedSpotCapacity: 0,
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
    message: `Instance fleet id '${FLEET_ID}' is not valid.`,
    $metadata: {},
  });
}

function newProvider(overrides: { maxWaitMs?: number } = {}): EMRInstanceFleetConfigProvider {
  return new EMRInstanceFleetConfigProvider({
    pollIntervalMs: 0,
    maxWaitMs: overrides.maxWaitMs ?? 5000,
  });
}

describe('EMRInstanceFleetConfigProvider create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds the fleet, polls PROVISIONING → RUNNING, returns physicalId + Id attribute', async () => {
    routeSend({
      AddInstanceFleetCommand: { ClusterId: CLUSTER_ID, InstanceFleetId: FLEET_ID },
      ListInstanceFleetsCommand: [fleetOf('PROVISIONING'), fleetOf('BOOTSTRAPPING'), fleetOf('RUNNING')],
    });

    const result = await newProvider().create('Fleet', RESOURCE_TYPE, BASE_PROPS);

    expect(result.physicalId).toBe(FLEET_ID);
    expect(result.attributes).toEqual({ Id: FLEET_ID });

    const add = callsOf(AddInstanceFleetCommand);
    expect(add).toHaveLength(1);
    expect(add[0]!.input.ClusterId).toBe(CLUSTER_ID);
    expect(add[0]!.input.InstanceFleet).toMatchObject({
      InstanceFleetType: 'TASK',
      Name: 'task-fleet',
      TargetOnDemandCapacity: 2,
      TargetSpotCapacity: 0,
    });
  });

  it('rejects when ClusterId is absent', async () => {
    routeSend({});
    const { ClusterId: _drop, ...noParent } = BASE_PROPS;
    await expect(newProvider().create('Fleet', RESOURCE_TYPE, noParent)).rejects.toThrow(
      ProvisioningError
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects when AddInstanceFleet returns no instance fleet id', async () => {
    routeSend({ AddInstanceFleetCommand: { ClusterId: CLUSTER_ID } });
    await expect(newProvider().create('Fleet', RESOURCE_TYPE, BASE_PROPS)).rejects.toThrow(
      /returned no instance fleet id/
    );
  });

  it('fails when the fleet enters a failed terminal state (TERMINATED)', async () => {
    routeSend({
      AddInstanceFleetCommand: { InstanceFleetId: FLEET_ID },
      ListInstanceFleetsCommand: fleetOf('TERMINATED'),
    });
    await expect(newProvider().create('Fleet', RESOURCE_TYPE, BASE_PROPS)).rejects.toThrow(
      /failed state TERMINATED/
    );
  });

  it('times out when the fleet never reaches RUNNING', async () => {
    routeSend({
      AddInstanceFleetCommand: { InstanceFleetId: FLEET_ID },
      ListInstanceFleetsCommand: fleetOf('PROVISIONING'),
    });
    await expect(
      newProvider({ maxWaitMs: 1 }).create('Fleet', RESOURCE_TYPE, BASE_PROPS)
    ).rejects.toThrow(/Timed out/);
  });

  it('rejects an unsupported resource type', async () => {
    routeSend({});
    await expect(newProvider().create('X', 'AWS::EMR::Cluster', BASE_PROPS)).rejects.toThrow(
      /Unsupported resource type/
    );
  });
});

describe('EMRInstanceFleetConfigProvider update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resizes target capacity via ModifyInstanceFleet and polls until provisioned meets target', async () => {
    routeSend({
      ModifyInstanceFleetCommand: {},
      ListInstanceFleetsCommand: [fleetOf('RESIZING', 2), fleetOf('RUNNING', 5)],
    });

    const next = { ...BASE_PROPS, TargetOnDemandCapacity: 5 };
    const result = await newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, next, BASE_PROPS);

    expect(result.wasReplaced).toBe(false);
    const modify = callsOf(ModifyInstanceFleetCommand);
    expect(modify).toHaveLength(1);
    expect(modify[0]!.input.ClusterId).toBe(CLUSTER_ID);
    expect(modify[0]!.input.InstanceFleet).toMatchObject({
      InstanceFleetId: FLEET_ID,
      TargetOnDemandCapacity: 5,
      TargetSpotCapacity: 0,
    });
  });

  it('keeps waiting through the stale pre-resize RUNNING state until provisioned meets the new target', async () => {
    // Regression: right after ModifyInstanceFleet the fleet is still in the
    // PRE-resize RUNNING state with the OLD provisioned capacity (2). A
    // State-only wait would return immediately; the capacity check must keep
    // it polling until provisioned reaches the new target (5).
    routeSend({
      ModifyInstanceFleetCommand: {},
      ListInstanceFleetsCommand: [
        fleetOf('RUNNING', 2), // stale pre-resize RUNNING — must NOT satisfy the wait
        fleetOf('RESIZING', 2),
        fleetOf('RUNNING', 5), // resize complete
      ],
    });

    const next = { ...BASE_PROPS, TargetOnDemandCapacity: 5 };
    await newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, next, BASE_PROPS);

    expect(callsOf(ListInstanceFleetsCommand)).toHaveLength(3);
  });

  it('on a scale-DOWN waits for provisioned to DRAIN to the new lower target', async () => {
    // Regression for the `>=`-only bug: scaling 5 -> 2, the fleet is still in
    // the PRE-resize RUNNING state with the OLD provisioned capacity (5). An
    // `>=` check would return instantly (5 >= 2); the direction-aware `<=`
    // check must keep polling until provisioned DRAINS to 2.
    routeSend({
      ModifyInstanceFleetCommand: {},
      ListInstanceFleetsCommand: [
        fleetOf('RUNNING', 5), // stale pre-resize RUNNING at the OLD capacity
        fleetOf('RESIZING', 3),
        fleetOf('RUNNING', 2), // drained to the new target
      ],
    });

    const prev = { ...BASE_PROPS, TargetOnDemandCapacity: 5 };
    const next = { ...BASE_PROPS, TargetOnDemandCapacity: 2 };
    await newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, next, prev);

    // 3 polls proves the stale RUNNING@5 did not short-circuit the scale-down.
    expect(callsOf(ListInstanceFleetsCommand)).toHaveLength(3);
  });

  it('throws when a mutable change is made without a ClusterId', async () => {
    routeSend({});
    const { ClusterId: _drop, ...noCluster } = BASE_PROPS;
    const next = { ...noCluster, TargetOnDemandCapacity: 5 };
    await expect(
      newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, next, noCluster)
    ).rejects.toThrow(/needs ClusterId/);
  });

  it('follows the ListInstanceFleets Marker pagination to find the fleet on a later page', async () => {
    let call = 0;
    mockSend.mockImplementation((command: object) => {
      const name = command.constructor.name;
      if (name === 'ModifyInstanceFleetCommand') return Promise.resolve({});
      if (name === 'ListInstanceFleetsCommand') {
        call += 1;
        // First page: a different fleet + a Marker. Second page: our fleet.
        if (call === 1) {
          return Promise.resolve({ InstanceFleets: [{ Id: 'if-OTHER' }], Marker: 'page2' });
        }
        return Promise.resolve(fleetOf('RUNNING', 5));
      }
      return Promise.reject(new Error(`Unexpected command: ${name}`));
    });

    const next = { ...BASE_PROPS, TargetOnDemandCapacity: 5 };
    await newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, next, BASE_PROPS);
    expect(callsOf(ListInstanceFleetsCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('absorbs a transient ListInstanceFleets error while polling, then settles', async () => {
    routeSend({
      ModifyInstanceFleetCommand: {},
      ListInstanceFleetsCommand: [
        Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
        fleetOf('RUNNING', 5),
      ],
    });
    const next = { ...BASE_PROPS, TargetOnDemandCapacity: 5 };
    await expect(
      newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, next, BASE_PROPS)
    ).resolves.toBeDefined();
  });

  it('refuses an immutable (createOnly) property change with a --replace pointer', async () => {
    routeSend({});
    const next = { ...BASE_PROPS, Name: 'renamed-fleet' };
    await expect(
      newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, next, BASE_PROPS)
    ).rejects.toThrow(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing mutable changed', async () => {
    routeSend({});
    const result = await newProvider().update(
      'Fleet',
      FLEET_ID,
      RESOURCE_TYPE,
      BASE_PROPS,
      BASE_PROPS
    );
    expect(result).toEqual({ physicalId: FLEET_ID, wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EMRInstanceFleetConfigProvider delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scales a TASK fleet to 0 target capacity to release its instances', async () => {
    routeSend({ ModifyInstanceFleetCommand: {} });
    await newProvider().delete('Fleet', FLEET_ID, RESOURCE_TYPE, BASE_PROPS);

    const modify = callsOf(ModifyInstanceFleetCommand);
    expect(modify).toHaveLength(1);
    expect(modify[0]!.input.ClusterId).toBe(CLUSTER_ID);
    expect(modify[0]!.input.InstanceFleet).toEqual({
      InstanceFleetId: FLEET_ID,
      TargetOnDemandCapacity: 0,
      TargetSpotCapacity: 0,
    });
  });

  it('is a pure no-op for a CORE fleet (no standalone delete API)', async () => {
    routeSend({});
    await newProvider().delete('Fleet', FLEET_ID, RESOURCE_TYPE, {
      ...BASE_PROPS,
      InstanceFleetType: 'CORE',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('treats an InvalidRequestException on scale-to-0 as already-gone when the region matches', async () => {
    routeSend({ ModifyInstanceFleetCommand: invalidRequest() });
    await expect(
      newProvider().delete('Fleet', FLEET_ID, RESOURCE_TYPE, BASE_PROPS, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('throws on an InvalidRequestException when the client region does not match state', async () => {
    routeSend({ ModifyInstanceFleetCommand: invalidRequest() });
    await expect(
      newProvider().delete('Fleet', FLEET_ID, RESOURCE_TYPE, BASE_PROPS, {
        expectedRegion: 'us-west-2',
      })
    ).rejects.toThrow(ProvisioningError);
  });

  it('warn-and-continues on a non-NotFound scale-to-0 error (never blocks destroy)', async () => {
    routeSend({ ModifyInstanceFleetCommand: new Error('throttled') });
    await expect(
      newProvider().delete('Fleet', FLEET_ID, RESOURCE_TYPE, BASE_PROPS)
    ).resolves.toBeUndefined();
  });

  it('is a no-op when properties are absent', async () => {
    routeSend({});
    await newProvider().delete('Fleet', FLEET_ID, RESOURCE_TYPE);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EMRInstanceFleetConfigProvider getAttribute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the physical id for Id and undefined for anything else', async () => {
    const provider = newProvider();
    expect(await provider.getAttribute(FLEET_ID, RESOURCE_TYPE, 'Id')).toBe(FLEET_ID);
    expect(await provider.getAttribute(FLEET_ID, RESOURCE_TYPE, 'Other')).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
