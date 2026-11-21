import type { EMRInstanceFleetConfigProvider } from '../emr-instance-fleet-config-provider.js';
import {
  InvalidRequestException,
  ListInstanceFleetsCommand,
  type Configuration,
  type EbsBlockDevice,
  type InstanceFleet,
  type InstanceTypeSpecification,
} from '@aws-sdk/client-emr';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../types/resource.js';

/** EMR's cluster id form (`j-…`), as `RunJobFlow` mints it. */
const CLUSTER_ID = /^j-[A-Z0-9]+$/;

/**
 * Read an `AWS::EMR::InstanceFleetConfig` back for `cdkd drift` and the
 * deploy-time baseline (go-to-k/cdkd#6769). The physical id is the bare fleet
 * id (`if-…`), and EMR reads a fleet only through its cluster, so the
 * record's `ClusterId` addresses it: `ListInstanceFleets` (paginated) on that
 * cluster, and the fleet whose `Id` is the physical id.
 *
 * `RESOURCE_NOT_FOUND` when the cluster lists no such fleet, or lists it
 * `TERMINATED` (a fleet ends only with its cluster). An
 * `InvalidRequestException` is `undefined` (drift unknown), as for
 * `AWS::EMR::Cluster`'s own read: EMR answers it for more than an unknown
 * cluster id, so it is no evidence the fleet is gone. Any other failure
 * throws. A record with no cluster id of EMR's form is `undefined`, with no
 * call.
 *
 * Every property the provider handles is returned in CFn shape:
 * `InstanceTypeConfigs` from `InstanceTypeSpecifications`, in the record's
 * order by `InstanceType` (extras after), each `Configurations` entry's
 * `Properties` re-keyed to `ConfigurationProperties`, and the per-volume
 * `EbsBlockDevices` folded back into `EbsConfiguration.EbsBlockDeviceConfigs`
 * (consecutive equal `VolumeSpecification`s counted as `VolumesPerInstance`).
 * `LaunchSpecifications` / `ResizeSpecifications` share the CFn member names
 * and are returned as read.
 */
export async function readCurrentState(
  this: EMRInstanceFleetConfigProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::EMR::InstanceFleetConfig') return undefined;
  const clusterId = properties?.['ClusterId'];
  if (typeof clusterId !== 'string' || !CLUSTER_ID.test(clusterId)) return undefined;

  let fleet: InstanceFleet | undefined;
  try {
    let marker: string | undefined;
    do {
      const resp = await this.getClient().send(
        new ListInstanceFleetsCommand({ ClusterId: clusterId, ...(marker && { Marker: marker }) })
      );
      fleet = (resp.InstanceFleets ?? []).find((f) => f.Id === physicalId);
      marker = fleet === undefined ? resp.Marker : undefined;
    } while (marker);
  } catch (error) {
    if (error instanceof InvalidRequestException) return undefined;
    throw error;
  }
  if (fleet === undefined || fleet.Status?.State === 'TERMINATED') return RESOURCE_NOT_FOUND;

  const out: Record<string, unknown> = { ClusterId: clusterId };
  if (fleet.InstanceFleetType !== undefined) out['InstanceFleetType'] = fleet.InstanceFleetType;
  if (fleet.Name !== undefined) out['Name'] = fleet.Name;
  if (fleet.TargetOnDemandCapacity !== undefined) {
    out['TargetOnDemandCapacity'] = fleet.TargetOnDemandCapacity;
  }
  if (fleet.TargetSpotCapacity !== undefined) out['TargetSpotCapacity'] = fleet.TargetSpotCapacity;
  if (fleet.InstanceTypeSpecifications !== undefined) {
    out['InstanceTypeConfigs'] = inRecordedOrder(
      fleet.InstanceTypeSpecifications.map(instanceTypeConfigOf),
      properties?.['InstanceTypeConfigs']
    );
  }
  if (fleet.LaunchSpecifications !== undefined) {
    out['LaunchSpecifications'] = definedOnly(fleet.LaunchSpecifications);
  }
  if (fleet.ResizeSpecifications !== undefined) {
    out['ResizeSpecifications'] = definedOnly(fleet.ResizeSpecifications);
  }
  return out;
}

/** `value` with every `undefined` member dropped, recursively. */
function definedOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(definedOnly);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, definedOnly(v)])
  );
}

/** One `InstanceTypeSpecification` as the CFn `InstanceTypeConfig`. */
function instanceTypeConfigOf(spec: InstanceTypeSpecification): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (spec.InstanceType !== undefined) out['InstanceType'] = spec.InstanceType;
  if (spec.WeightedCapacity !== undefined) out['WeightedCapacity'] = spec.WeightedCapacity;
  if (spec.BidPrice !== undefined) out['BidPrice'] = spec.BidPrice;
  if (spec.BidPriceAsPercentageOfOnDemandPrice !== undefined) {
    out['BidPriceAsPercentageOfOnDemandPrice'] = spec.BidPriceAsPercentageOfOnDemandPrice;
  }
  if (spec.CustomAmiId !== undefined) out['CustomAmiId'] = spec.CustomAmiId;
  if (spec.Priority !== undefined) out['Priority'] = spec.Priority;
  if (spec.Configurations !== undefined && spec.Configurations.length > 0) {
    out['Configurations'] = spec.Configurations.map(configurationOf);
  }
  const ebs = ebsConfigurationOf(spec.EbsBlockDevices, spec.EbsOptimized);
  if (ebs !== undefined) out['EbsConfiguration'] = ebs;
  return out;
}

/** An EMR `Configuration` in CFn shape (`Properties` is `ConfigurationProperties` there). */
function configurationOf(c: Configuration): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.Classification !== undefined) out['Classification'] = c.Classification;
  if (c.Properties !== undefined) out['ConfigurationProperties'] = { ...c.Properties };
  if (c.Configurations !== undefined && c.Configurations.length > 0) {
    out['Configurations'] = c.Configurations.map(configurationOf);
  }
  return out;
}

/**
 * The per-volume `EbsBlockDevices` folded back into CFn's
 * `EbsBlockDeviceConfigs`: consecutive volumes with an equal
 * `VolumeSpecification` are one entry, counted as `VolumesPerInstance` (how
 * EMR expands a config). `undefined` when EMR reports no volume and no
 * `EbsOptimized`.
 */
function ebsConfigurationOf(
  devices: EbsBlockDevice[] | undefined,
  ebsOptimized: boolean | undefined
): Record<string, unknown> | undefined {
  const configs: Array<{
    VolumeSpecification: Record<string, unknown>;
    VolumesPerInstance: number;
  }> = [];
  for (const device of devices ?? []) {
    const spec = definedOnly({
      VolumeType: device.VolumeSpecification?.VolumeType,
      SizeInGB: device.VolumeSpecification?.SizeInGB,
      Iops: device.VolumeSpecification?.Iops,
      Throughput: device.VolumeSpecification?.Throughput,
    }) as Record<string, unknown>;
    const last = configs[configs.length - 1];
    if (last !== undefined && JSON.stringify(last.VolumeSpecification) === JSON.stringify(spec)) {
      last.VolumesPerInstance += 1;
    } else {
      configs.push({ VolumeSpecification: spec, VolumesPerInstance: 1 });
    }
  }
  if (configs.length === 0 && ebsOptimized === undefined) return undefined;
  const out: Record<string, unknown> = {};
  if (configs.length > 0) out['EbsBlockDeviceConfigs'] = configs;
  if (ebsOptimized !== undefined) out['EbsOptimized'] = ebsOptimized;
  return out;
}

/**
 * The read configs in the record's order, matched by `InstanceType` (unique
 * within a fleet), then any the record does not hold, in read order. EMR does
 * not document the order it lists them in.
 */
function inRecordedOrder(
  read: Array<Record<string, unknown>>,
  recorded: unknown
): Array<Record<string, unknown>> {
  if (!Array.isArray(recorded)) return read;
  const left = [...read];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of recorded as unknown[]) {
    const type = (entry as Record<string, unknown> | null)?.['InstanceType'];
    const i = left.findIndex((r) => r['InstanceType'] === type);
    if (i >= 0) out.push(...left.splice(i, 1));
  }
  return [...out, ...left];
}
