import type { EMRInstanceGroupConfigProvider } from '../emr-instance-group-config-provider.js';
import {
  InvalidRequestException,
  ListInstanceGroupsCommand,
  type Configuration,
  type EbsBlockDevice,
  type InstanceGroup,
} from '@aws-sdk/client-emr';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../types/resource.js';

/** EMR's cluster id form (`j-…`), as `RunJobFlow` mints it. */
const CLUSTER_ID = /^j-[A-Z0-9]+$/;

/**
 * Read an `AWS::EMR::InstanceGroupConfig` back for `cdkd drift` and the
 * deploy-time baseline (go-to-k/cdkd#6769). The physical id is the bare group
 * id (`ig-…`), and EMR reads a group only through its cluster, so the record's
 * `JobFlowId` addresses it: `ListInstanceGroups` (paginated) on that cluster,
 * and the group whose `Id` is the physical id.
 *
 * `RESOURCE_NOT_FOUND` when the cluster lists no such group, or lists it
 * `TERMINATED` (a group ends only with its cluster). An
 * `InvalidRequestException` is `undefined` (drift unknown), as for
 * `AWS::EMR::Cluster`'s own read: EMR answers it for more than an unknown
 * cluster id, so it is no evidence the group is gone. Any other failure
 * throws. A record with no cluster id of EMR's form is `undefined`, with no
 * call.
 *
 * Every property the provider handles is returned in CFn shape: `InstanceRole`
 * from `InstanceGroupType`, `InstanceCount` from the REQUESTED count (a
 * mid-resize read is not drift), `Configurations` with `Properties` re-keyed
 * to `ConfigurationProperties`, the per-volume `EbsBlockDevices` folded back
 * into `EbsConfiguration.EbsBlockDeviceConfigs` (consecutive equal
 * `VolumeSpecification`s counted as `VolumesPerInstance`), and
 * `AutoScalingPolicy` as its `Constraints` and `Rules` (the read-only `Status`
 * dropped; absent when none is attached).
 */
export async function readCurrentState(
  this: EMRInstanceGroupConfigProvider,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::EMR::InstanceGroupConfig') return undefined;
  const clusterId = properties?.['JobFlowId'];
  if (typeof clusterId !== 'string' || !CLUSTER_ID.test(clusterId)) return undefined;

  let group: InstanceGroup | undefined;
  try {
    let marker: string | undefined;
    do {
      const resp = await this.getClient().send(
        new ListInstanceGroupsCommand({ ClusterId: clusterId, ...(marker && { Marker: marker }) })
      );
      group = (resp.InstanceGroups ?? []).find((g) => g.Id === physicalId);
      marker = group === undefined ? resp.Marker : undefined;
    } while (marker);
  } catch (error) {
    if (error instanceof InvalidRequestException) return undefined;
    throw error;
  }
  if (group === undefined || group.Status?.State === 'TERMINATED') return RESOURCE_NOT_FOUND;

  const out: Record<string, unknown> = { JobFlowId: clusterId };
  if (group.InstanceGroupType !== undefined) out['InstanceRole'] = group.InstanceGroupType;
  if (group.InstanceType !== undefined) out['InstanceType'] = group.InstanceType;
  if (group.RequestedInstanceCount !== undefined) {
    out['InstanceCount'] = group.RequestedInstanceCount;
  }
  if (group.Name !== undefined) out['Name'] = group.Name;
  if (group.Market !== undefined) out['Market'] = group.Market;
  if (group.BidPrice !== undefined) out['BidPrice'] = group.BidPrice;
  if (group.CustomAmiId !== undefined) out['CustomAmiId'] = group.CustomAmiId;
  if (group.Configurations !== undefined && group.Configurations.length > 0) {
    out['Configurations'] = group.Configurations.map(configurationOf);
  }
  const ebs = ebsConfigurationOf(group.EbsBlockDevices, group.EbsOptimized);
  if (ebs !== undefined) out['EbsConfiguration'] = ebs;
  if (group.AutoScalingPolicy !== undefined) {
    out['AutoScalingPolicy'] = definedOnly({
      Constraints: group.AutoScalingPolicy.Constraints,
      Rules: group.AutoScalingPolicy.Rules,
    });
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
 * `EbsBlockDeviceConfigs` (consecutive equal `VolumeSpecification`s are one
 * entry, counted as `VolumesPerInstance`). `undefined` when EMR reports no
 * volume and no `EbsOptimized`. The same fold as the instance fleet's read.
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
