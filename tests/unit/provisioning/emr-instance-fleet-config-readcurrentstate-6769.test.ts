import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  InvalidRequestException,
  ListInstanceFleetsCommand,
  type InstanceFleet,
} from '@aws-sdk/client-emr';

/**
 * go-to-k/cdkd#6769: `AWS::EMR::InstanceFleetConfig` reads back through
 * `ListInstanceFleets` on the recorded cluster (Cloud Control cannot address
 * the bare fleet id, #5179).
 */

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { EMRInstanceFleetConfigProvider } from '../../../src/provisioning/providers/emr-instance-fleet-config-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const TYPE = 'AWS::EMR::InstanceFleetConfig';
const FLEET_ID = 'if-ABC123';
const CLUSTER_ID = 'j-CLUSTER1';

/** What CDK's `CfnInstanceFleetConfig` emits for a TASK fleet. */
const RECORDED = {
  ClusterId: CLUSTER_ID,
  InstanceFleetType: 'TASK',
  Name: 'task',
  TargetOnDemandCapacity: 1,
  TargetSpotCapacity: 0,
  InstanceTypeConfigs: [
    {
      InstanceType: 'm5.xlarge',
      WeightedCapacity: 1,
      EbsConfiguration: {
        EbsBlockDeviceConfigs: [
          { VolumeSpecification: { VolumeType: 'gp3', SizeInGB: 32 }, VolumesPerInstance: 2 },
        ],
        EbsOptimized: true,
      },
      Configurations: [
        { Classification: 'spark', ConfigurationProperties: { 'spark.x': '1' } },
      ],
    },
    { InstanceType: 'm5.2xlarge', WeightedCapacity: 2 },
  ],
  LaunchSpecifications: { OnDemandSpecification: { AllocationStrategy: 'lowest-price' } },
  ResizeSpecifications: { OnDemandResizeSpecification: { TimeoutDurationMinutes: 20 } },
};

/** The same fleet as ListInstanceFleets answers it, configs listed in another order. */
function liveFleet(over: Partial<InstanceFleet> = {}): InstanceFleet {
  return {
    Id: FLEET_ID,
    Name: 'task',
    Status: { State: 'RUNNING' },
    InstanceFleetType: 'TASK',
    TargetOnDemandCapacity: 1,
    TargetSpotCapacity: 0,
    ProvisionedOnDemandCapacity: 1,
    ProvisionedSpotCapacity: 0,
    InstanceTypeSpecifications: [
      { InstanceType: 'm5.2xlarge', WeightedCapacity: 2 },
      {
        InstanceType: 'm5.xlarge',
        WeightedCapacity: 1,
        EbsOptimized: true,
        EbsBlockDevices: [
          { Device: '/dev/sdb', VolumeSpecification: { VolumeType: 'gp3', SizeInGB: 32 } },
          { Device: '/dev/sdc', VolumeSpecification: { VolumeType: 'gp3', SizeInGB: 32 } },
        ],
        Configurations: [{ Classification: 'spark', Properties: { 'spark.x': '1' } }],
      },
    ],
    LaunchSpecifications: {
      OnDemandSpecification: { AllocationStrategy: 'lowest-price', CapacityReservationOptions: undefined },
    },
    ResizeSpecifications: { OnDemandResizeSpecification: { TimeoutDurationMinutes: 20 } },
    ...over,
  };
}

describe('EMRInstanceFleetConfigProvider.readCurrentState (go-to-k/cdkd#6769)', () => {
  let provider: EMRInstanceFleetConfigProvider;
  const send = vi.fn();
  beforeEach(() => {
    send.mockReset();
    provider = new EMRInstanceFleetConfigProvider();
    vi.spyOn(provider, 'getClient').mockReturnValue({ send } as never);
  });
  const read = (properties: Record<string, unknown> | undefined = RECORDED) =>
    provider.readCurrentState(FLEET_ID, 'Fleet', TYPE, properties);
  const pages = (...p: InstanceFleet[][]) =>
    send.mockImplementation((cmd: unknown) => {
      if (!(cmd instanceof ListInstanceFleetsCommand)) return Promise.reject(new Error('unexpected'));
      expect(cmd.input.ClusterId).toBe(CLUSTER_ID);
      const i = cmd.input.Marker === undefined ? 0 : Number(cmd.input.Marker);
      return Promise.resolve({
        InstanceFleets: p[i] ?? [],
        ...(i + 1 < p.length && { Marker: String(i + 1) }),
      });
    });

  it('reads a clean fleet back as the record', async () => {
    pages([liveFleet()]);
    expect(await read()).toEqual(RECORDED);
  });

  it('reports an out-of-band capacity change', async () => {
    pages([liveFleet({ TargetOnDemandCapacity: 3 })]);
    expect(await read()).toMatchObject({ TargetOnDemandCapacity: 3 });
  });

  it('appends an instance type added out of band after the recorded ones', async () => {
    const live = liveFleet();
    live.InstanceTypeSpecifications = [{ InstanceType: 'm6g.xlarge', WeightedCapacity: 1 }, ...live.InstanceTypeSpecifications!];
    pages([live]);
    const types = ((await read()) as Record<string, unknown>)['InstanceTypeConfigs'] as Array<Record<string, unknown>>;
    expect(types.map((t) => t['InstanceType'])).toEqual(['m5.xlarge', 'm5.2xlarge', 'm6g.xlarge']);
  });

  it('folds only consecutive equal volumes, and maps nested Configurations', async () => {
    const gp3 = { VolumeType: 'gp3', SizeInGB: 32 };
    const io1 = { VolumeType: 'io1', SizeInGB: 64, Iops: 1000 };
    pages([
      liveFleet({
        InstanceTypeSpecifications: [
          {
            InstanceType: 'm5.xlarge',
            EbsBlockDevices: [gp3, gp3, io1, gp3].map((VolumeSpecification) => ({ VolumeSpecification })),
            Configurations: [
              { Classification: 'outer', Configurations: [{ Classification: 'inner', Properties: { k: 'v' } }] },
              { Classification: 'empty', Configurations: [] },
            ],
          },
        ],
      }),
    ]);
    const [config] = ((await read()) as Record<string, unknown>)['InstanceTypeConfigs'] as Array<Record<string, unknown>>;
    expect(config!['EbsConfiguration']).toEqual({
      EbsBlockDeviceConfigs: [
        { VolumeSpecification: gp3, VolumesPerInstance: 2 },
        { VolumeSpecification: io1, VolumesPerInstance: 1 },
        { VolumeSpecification: gp3, VolumesPerInstance: 1 },
      ],
    });
    expect(config!['Configurations']).toEqual([
      { Classification: 'outer', Configurations: [{ Classification: 'inner', ConfigurationProperties: { k: 'v' } }] },
      { Classification: 'empty' },
    ]);
  });

  it('follows the Marker to the fleet on a later page', async () => {
    pages([liveFleet({ Id: 'if-OTHER' })], [liveFleet()]);
    expect(await read()).toEqual(RECORDED);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('is RESOURCE_NOT_FOUND when the cluster lists no such fleet', async () => {
    pages([liveFleet({ Id: 'if-OTHER' })]);
    expect(await read()).toBe(RESOURCE_NOT_FOUND);
  });

  it('is RESOURCE_NOT_FOUND for a TERMINATED fleet', async () => {
    pages([liveFleet({ Status: { State: 'TERMINATED' } })]);
    expect(await read()).toBe(RESOURCE_NOT_FOUND);
  });

  it('is drift unknown on InvalidRequestException, which is no evidence the fleet is gone', async () => {
    send.mockRejectedValue(new InvalidRequestException({ message: 'Cluster id is not valid', $metadata: {} }));
    expect(await read()).toBeUndefined();
  });

  it('throws any other failure', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    send.mockRejectedValue(denied);
    await expect(read()).rejects.toBe(denied);
  });

  it.each([
    ['a redacted ClusterId', { ...RECORDED, ClusterId: '***' }],
    ['no ClusterId', { InstanceFleetType: 'TASK' }],
    ['no properties', undefined],
  ])('is drift unknown, with no call, for %s', async (_label, properties) => {
    pages([liveFleet()]);
    expect(await provider.readCurrentState(FLEET_ID, 'Fleet', TYPE, properties)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
