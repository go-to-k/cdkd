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

import { EMRClusterProvider } from '../../../../src/provisioning/providers/emr-cluster-provider.js';
import { prepareRemovalForUpdate } from '../../../../src/provisioning/update-removal.js';
import { getLogger } from '../../../../src/utils/logger.js';
import {
  AddTagsCommand,
  ModifyClusterCommand,
  SetVisibleToAllUsersCommand,
} from '@aws-sdk/client-emr';
import { ResourceUpdateNotSupportedError } from '../../../../src/utils/error-handler.js';

/**
 * Issue #1160: removing `StepConcurrencyLevel` from the template used to send
 * a `ModifyCluster` carrying no update field, which AWS treats as "no change",
 * and say nothing. cdkd sends no reset (CloudFormation's behavior on the
 * removal is unmeasured) and warns once, without claiming a CloudFormation
 * reset.
 */

const RESOURCE_TYPE = 'AWS::EMR::Cluster';
const CLUSTER_ID = 'j-1A2B3C4D5E6F7';

const BASE_PROPS = {
  Name: 'my-emr-cluster',
  ReleaseLabel: 'emr-7.2.0',
  ServiceRole: 'EMR_DefaultRole',
  JobFlowRole: 'EMR_EC2_DefaultRole',
  Instances: { Ec2SubnetId: 'subnet-abc', KeepJobFlowAliveWhenNoSteps: true },
  Tags: [{ Key: 'env', Value: 'test' }],
};

const childLogger = getLogger().child('EMRClusterProvider') as unknown as {
  warn: ReturnType<typeof vi.fn>;
};
const warnings = (): string[] => childLogger.warn.mock.calls.map((c) => String(c[0]));

function callsOf(commandClass: abstract new (...args: never[]) => object): unknown[] {
  return mockSend.mock.calls.map((c) => c[0] as object).filter((c) => c instanceof commandClass);
}

function newProvider(): EMRClusterProvider {
  return new EMRClusterProvider({ pollIntervalMs: 0, maxWaitMs: 5000 });
}

const PREV = { ...BASE_PROPS, StepConcurrencyLevel: 5 };

describe('EMRClusterProvider update: StepConcurrencyLevel removal (#1160)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockImplementation((command: object) =>
      Promise.resolve(
        command.constructor.name === 'DescribeClusterCommand'
          ? { Cluster: { Id: CLUSTER_ID, Status: { State: 'WAITING' } } }
          : {}
      )
    );
  });

  it('sends nothing for a removal alone and warns once, naming the key without a CloudFormation-reset claim', async () => {
    const result = await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS },
      PREV
    );

    expect(result).toEqual({ physicalId: CLUSTER_ID, wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
    expect(warnings()).toHaveLength(1);
    const line = warnings()[0]!;
    expect(line).toContain('MyCluster (AWS::EMR::Cluster): property StepConcurrencyLevel was removed');
    expect(line).toContain('ModifyCluster keeps a setting it is not sent');
    expect(line).not.toContain('CloudFormation');
    // Key names only: the removed value never reaches the line.
    expect(line).not.toContain('5');
  });

  it('applies the other changes, sends no ModifyCluster, and warns after they succeed', async () => {
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, Tags: [{ Key: 'env', Value: 'prod' }] },
      PREV
    );

    expect(callsOf(ModifyClusterCommand)).toHaveLength(0);
    expect(callsOf(AddTagsCommand)).toHaveLength(1);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('StepConcurrencyLevel');
  });

  it('does not warn when the update fails', async () => {
    mockSend.mockRejectedValue(new Error('throttled'));

    await expect(
      newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        { ...BASE_PROPS, Tags: [{ Key: 'env', Value: 'prod' }] },
        PREV
      )
    ).rejects.toThrow(/throttled/);
    expect(warnings()).toHaveLength(0);
  });

  it('still sends a present StepConcurrencyLevel change', async () => {
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS, StepConcurrencyLevel: 2 },
      PREV
    );

    expect(callsOf(ModifyClusterCommand)).toEqual([
      expect.objectContaining({ input: { ClusterId: CLUSTER_ID, StepConcurrencyLevel: 2 } }),
    ]);
    expect(warnings()).toHaveLength(0);
  });

  it('never warns about a key that was never declared', async () => {
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS },
      { ...BASE_PROPS }
    );
    expect(warnings()).toHaveLength(0);
  });

  it("reads the caller's removed set: named there, it warns", async () => {
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS },
      PREV,
      { removedProperties: new Set(['StepConcurrencyLevel']) }
    );
    expect(warnings()).toHaveLength(1);
  });

  it("takes the caller's removed set over the bags: an empty one warns about nothing", async () => {
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS },
      PREV,
      { removedProperties: new Set() }
    );
    expect(warnings()).toHaveLength(0);
  });

  it('stays silent on drift --revert, whose previous side is a readback (empty removed set)', async () => {
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS },
      PREV,
      { desiredFromAwsReadback: true, removedProperties: new Set() }
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(warnings()).toHaveLength(0);
  });

  it('stays silent on desiredFromAwsReadback even without a removed set', async () => {
    await newProvider().update('MyCluster', CLUSTER_ID, RESOURCE_TYPE, { ...BASE_PROPS }, PREV, {
      desiredFromAwsReadback: true,
    });
    expect(warnings()).toHaveLength(0);
  });

  it('words a rollback revert as the failed deploy having added the property', async () => {
    await newProvider().update(
      'MyCluster',
      CLUSTER_ID,
      RESOURCE_TYPE,
      { ...BASE_PROPS },
      PREV,
      { replayingState: true, removedProperties: new Set(['StepConcurrencyLevel']) }
    );
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('absent from the state being restored');
    expect(warnings()[0]).not.toContain('removed from the template');
  });

  it('sends a removed VisibleToAllUsers as false, CloudFormation\'s documented default, without warning', async () => {
    const prev = { ...BASE_PROPS, VisibleToAllUsers: true };
    await newProvider().update('MyCluster', CLUSTER_ID, RESOURCE_TYPE, { ...BASE_PROPS }, prev);

    expect(callsOf(SetVisibleToAllUsersCommand)).toEqual([
      expect.objectContaining({
        input: { JobFlowIds: [CLUSTER_ID], VisibleToAllUsers: false },
      }),
    ]);
    expect(warnings()).toHaveLength(0);
    const prepared = prepareRemovalForUpdate(newProvider(), RESOURCE_TYPE, { ...BASE_PROPS }, prev);
    expect(prepared.context.removedProperties).toEqual(new Set(['VisibleToAllUsers']));
    expect(prepared.unhandled).toEqual([]);
  });

  it('still refuses the removal of a create-only property', async () => {
    await expect(
      newProvider().update(
        'MyCluster',
        CLUSTER_ID,
        RESOURCE_TYPE,
        { ...BASE_PROPS },
        { ...BASE_PROPS, LogUri: 's3://logs/' }
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('EMRClusterProvider removalHandledInUpdate (#1160)', () => {
  const provider = newProvider();

  it('covers every property the provider handles, so the shared caller warns about none', () => {
    const handled = [...provider.handledProperties.get(RESOURCE_TYPE)!];
    expect(handled.length).toBeGreaterThan(20);
    expect([...provider.removalHandledInUpdate.get(RESOURCE_TYPE)!].sort()).toEqual(
      [...handled].sort()
    );
  });

  it('leaves a StepConcurrencyLevel removal out of the shared warning, which claims a CloudFormation reset', () => {
    const prepared = prepareRemovalForUpdate(provider, RESOURCE_TYPE, { ...BASE_PROPS }, PREV);
    expect(prepared.context.removedProperties).toEqual(new Set(['StepConcurrencyLevel']));
    expect(prepared.unhandled).toEqual([]);
    expect(prepared.injected).toEqual([]);
    expect(prepared.properties).not.toHaveProperty('StepConcurrencyLevel');
  });
});
