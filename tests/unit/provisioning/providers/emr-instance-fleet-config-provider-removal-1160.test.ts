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
import { prepareRemovalForUpdate } from '../../../../src/provisioning/update-removal.js';
import { getLogger } from '../../../../src/utils/logger.js';
import { ModifyInstanceFleetCommand } from '@aws-sdk/client-emr';
import { ResourceUpdateNotSupportedError } from '../../../../src/utils/error-handler.js';

/**
 * Issue #1160: removing `ResizeSpecifications` or `InstanceTypeConfigs` from
 * the template used to send a `ModifyInstanceFleet` without the field, which
 * AWS treats as "no change", and say nothing. cdkd sends no reset (neither has
 * a constant one, and CloudFormation's behavior is unmeasured) and warns once,
 * without claiming a CloudFormation reset. A removed capacity is sent as 0.
 */

const RESOURCE_TYPE = 'AWS::EMR::InstanceFleetConfig';
const CLUSTER_ID = 'j-1A2B3C4D5E6F7';
const FLEET_ID = 'if-ABCDEF123456';

const RESIZE = {
  OnDemandResizeSpecification: { TimeoutDurationMinutes: 20 },
  SpotResizeSpecification: { TimeoutDurationMinutes: 20 },
};

const BASE_PROPS = {
  ClusterId: CLUSTER_ID,
  InstanceFleetType: 'TASK',
  Name: 'task-fleet',
  TargetOnDemandCapacity: 2,
};
const ITC = [{ InstanceType: 'm5.xlarge', WeightedCapacity: 1 }];
const PREV = { ...BASE_PROPS, InstanceTypeConfigs: ITC, ResizeSpecifications: RESIZE };

const childLogger = getLogger().child('EMRInstanceFleetConfigProvider') as unknown as {
  warn: ReturnType<typeof vi.fn>;
};
const warnings = (): string[] => childLogger.warn.mock.calls.map((c) => String(c[0]));

function modifyCalls(): Array<{ input: { InstanceFleet: Record<string, unknown> } }> {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((c) => c instanceof ModifyInstanceFleetCommand) as unknown as Array<{
    input: { InstanceFleet: Record<string, unknown> };
  }>;
}

function newProvider(): EMRInstanceFleetConfigProvider {
  return new EMRInstanceFleetConfigProvider({ pollIntervalMs: 0, maxWaitMs: 5000 });
}

/** A fleet settled at `onDemand` provisioned On-Demand units. */
function settleAt(onDemand: number): void {
  mockSend.mockImplementation((command: object) =>
    Promise.resolve(
      command.constructor.name === 'ListInstanceFleetsCommand'
        ? {
            InstanceFleets: [
              {
                Id: FLEET_ID,
                InstanceFleetType: 'TASK',
                ProvisionedOnDemandCapacity: onDemand,
                ProvisionedSpotCapacity: 0,
                Status: { State: 'RUNNING' },
              },
            ],
          }
        : {}
    )
  );
}

describe('EMRInstanceFleetConfigProvider update: removal (#1160)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settleAt(2);
  });

  it.each([
    ['ResizeSpecifications', { ...BASE_PROPS, InstanceTypeConfigs: ITC }],
    ['InstanceTypeConfigs', { ...BASE_PROPS, ResizeSpecifications: RESIZE }],
  ] as const)(
    'sends nothing for a %s removal alone and warns once without a CloudFormation-reset claim',
    async (key, desired) => {
      const result = await newProvider().update(
        'Fleet',
        FLEET_ID,
        RESOURCE_TYPE,
        { ...desired },
        PREV
      );

      expect(result).toEqual({
        physicalId: FLEET_ID,
        wasReplaced: false,
        attributes: { Id: FLEET_ID, InstanceFleetId: FLEET_ID },
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(warnings()).toHaveLength(1);
      const line = warnings()[0]!;
      expect(line).toContain(
        `Fleet (AWS::EMR::InstanceFleetConfig): property ${key} was removed from the template`
      );
      expect(line).toContain('ModifyInstanceFleet keeps a setting it is not sent');
      expect(line).not.toContain('CloudFormation');
      // Key names only: no removed value reaches the line.
      expect(line).not.toContain('m5.xlarge');
      expect(line).not.toContain('20');
    }
  );

  it('names both in one line when both are removed', async () => {
    await newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, { ...BASE_PROPS }, PREV);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(
      'properties ResizeSpecifications, InstanceTypeConfigs were removed from the template'
    );
  });

  it('resizes for a capacity change alongside a removal, omits the removed field, and warns after success', async () => {
    settleAt(4);
    await newProvider().update(
      'Fleet',
      FLEET_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, TargetOnDemandCapacity: 4, InstanceTypeConfigs: ITC },
      PREV
    );

    const modify = modifyCalls();
    expect(modify).toHaveLength(1);
    expect(modify[0]!.input.InstanceFleet).toMatchObject({
      TargetOnDemandCapacity: 4,
      TargetSpotCapacity: 0,
    });
    expect(modify[0]!.input.InstanceFleet['ResizeSpecifications']).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('property ResizeSpecifications was removed');
  });

  it('still sends a lone change to a present ResizeSpecifications, with exactly that payload', async () => {
    const changed = {
      OnDemandResizeSpecification: { TimeoutDurationMinutes: 30 },
      SpotResizeSpecification: { TimeoutDurationMinutes: 20 },
    };
    await newProvider().update(
      'Fleet',
      FLEET_ID,
      RESOURCE_TYPE,
      { ...PREV, ResizeSpecifications: changed },
      PREV
    );

    const modify = modifyCalls();
    expect(modify).toHaveLength(1);
    expect(modify[0]!.input.InstanceFleet['ResizeSpecifications']).toEqual(changed);
    expect(modify[0]!.input.InstanceFleet).toMatchObject({
      InstanceFleetId: FLEET_ID,
      TargetOnDemandCapacity: 2,
      TargetSpotCapacity: 0,
    });
    expect(warnings()).toHaveLength(0);
  });

  it('omits a removed InstanceTypeConfigs from a resize sent beside it', async () => {
    settleAt(4);
    await newProvider().update(
      'Fleet',
      FLEET_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, TargetOnDemandCapacity: 4, ResizeSpecifications: RESIZE },
      PREV
    );

    const modify = modifyCalls();
    expect(modify).toHaveLength(1);
    expect(modify[0]!.input.InstanceFleet).toMatchObject({ TargetOnDemandCapacity: 4 });
    expect(modify[0]!.input.InstanceFleet['InstanceTypeConfigs']).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('property InstanceTypeConfigs was removed');
  });

  it('does not warn when the ModifyInstanceFleet succeeds but the resize wait fails', async () => {
    // Provisioned capacity stays at 2 while the target is 4, so the wait times out.
    const provider = new EMRInstanceFleetConfigProvider({ pollIntervalMs: 0, maxWaitMs: 20 });
    await expect(
      provider.update(
        'Fleet',
        FLEET_ID,
        RESOURCE_TYPE,
        { ...BASE_PROPS, TargetOnDemandCapacity: 4, InstanceTypeConfigs: ITC },
        PREV
      )
    ).rejects.toThrow();
    expect(modifyCalls()).toHaveLength(1);
    expect(warnings()).toHaveLength(0);
  });

  it('does not warn when the ModifyInstanceFleet fails', async () => {
    mockSend.mockRejectedValue(new Error('throttled'));
    await expect(
      newProvider().update(
        'Fleet',
        FLEET_ID,
        RESOURCE_TYPE,
        { ...BASE_PROPS, TargetOnDemandCapacity: 4, InstanceTypeConfigs: ITC },
        PREV
      )
    ).rejects.toThrow(/throttled/);
    expect(warnings()).toHaveLength(0);
  });

  it('sends a removed capacity as 0 and does not warn about it', async () => {
    const prev = { ...PREV, TargetSpotCapacity: 3 };
    await newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, { ...PREV }, prev);

    expect(modifyCalls()[0]!.input.InstanceFleet).toMatchObject({
      TargetOnDemandCapacity: 2,
      TargetSpotCapacity: 0,
    });
    expect(warnings()).toHaveLength(0);
  });

  it("reads the caller's removed set: named there, it warns", async () => {
    await newProvider().update(
      'Fleet',
      FLEET_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, InstanceTypeConfigs: ITC },
      PREV,
      { removedProperties: new Set(['ResizeSpecifications']) }
    );
    expect(warnings()).toHaveLength(1);
  });

  it('stays silent on drift --revert, whose previous side is a readback (empty removed set)', async () => {
    await newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, { ...BASE_PROPS }, PREV, {
      desiredFromAwsReadback: true,
      removedProperties: new Set(),
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(warnings()).toHaveLength(0);
  });

  it('stays silent on desiredFromAwsReadback even without a removed set', async () => {
    await newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, { ...BASE_PROPS }, PREV, {
      desiredFromAwsReadback: true,
    });
    expect(warnings()).toHaveLength(0);
  });

  it("takes the caller's removed set over the bags: an empty one warns about nothing", async () => {
    await newProvider().update('Fleet', FLEET_ID, RESOURCE_TYPE, { ...BASE_PROPS }, PREV, {
      removedProperties: new Set(),
    });
    expect(warnings()).toHaveLength(0);
  });

  it('words a rollback revert as the failed deploy having added the property', async () => {
    await newProvider().update(
      'Fleet',
      FLEET_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, InstanceTypeConfigs: ITC },
      PREV,
      { replayingState: true, removedProperties: new Set(['ResizeSpecifications']) }
    );
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('absent from the state being restored');
    expect(warnings()[0]).not.toContain('removed from the template');
  });

  it('still refuses the removal of a create-only property', async () => {
    await expect(
      newProvider().update(
        'Fleet',
        FLEET_ID,
        RESOURCE_TYPE,
        { ...PREV },
        { ...PREV, LaunchSpecifications: { OnDemandSpecification: {} } }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EMRInstanceFleetConfigProvider removalHandledInUpdate (#1160)', () => {
  const provider = newProvider();

  it('covers every property the provider handles, so the shared caller warns about none', () => {
    const handled = [...provider.handledProperties.get(RESOURCE_TYPE)!];
    expect(handled).toHaveLength(8);
    expect([...provider.removalHandledInUpdate.get(RESOURCE_TYPE)!].sort()).toEqual(
      [...handled].sort()
    );
  });

  it('leaves both removals out of the shared warning, which claims a CloudFormation reset', () => {
    const prepared = prepareRemovalForUpdate(provider, RESOURCE_TYPE, { ...BASE_PROPS }, PREV);
    expect(prepared.context.removedProperties).toEqual(
      new Set(['InstanceTypeConfigs', 'ResizeSpecifications'])
    );
    expect(prepared.unhandled).toEqual([]);
    expect(prepared.injected).toEqual([]);
    expect(prepared.properties).not.toHaveProperty('InstanceTypeConfigs');
    expect(prepared.properties).not.toHaveProperty('ResizeSpecifications');
  });
});
