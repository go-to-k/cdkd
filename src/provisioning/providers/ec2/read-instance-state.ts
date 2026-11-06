import {
  DescribeInstancesCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  DescribeInstanceCreditSpecificationsCommand,
  DescribeVolumesCommand,
  DescribeInstanceAttributeCommand,
  type Volume,
} from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { instanceVolumeEntries, instanceVolumesRefusal } from './instance-support.js';
import type { EC2Provider } from '../ec2-provider.js';

export async function readInstanceCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const resp = await this.ec2Client.send(
    new DescribeInstancesCommand({ InstanceIds: [physicalId] })
  );
  const instance = resp.Reservations?.[0]?.Instances?.[0];
  // Treat terminated/shutting-down as "gone" for drift purposes.
  if (
    !instance ||
    instance.State?.Name === 'terminated' ||
    instance.State?.Name === 'shutting-down'
  ) {
    return RESOURCE_NOT_FOUND;
  }

  const result: Record<string, unknown> = {};
  if (instance.ImageId !== undefined) result['ImageId'] = instance.ImageId;
  if (instance.InstanceType !== undefined) result['InstanceType'] = instance.InstanceType;
  if (instance.KeyName !== undefined) result['KeyName'] = instance.KeyName;
  if (instance.SubnetId !== undefined) result['SubnetId'] = instance.SubnetId;

  // SecurityGroupIds: AWS returns SecurityGroups: [{GroupId, GroupName}].
  // CFn input is the flat id list — sorted for stable positional compare
  // (AWS does not preserve template order across DescribeInstances calls).
  result['SecurityGroupIds'] = (instance.SecurityGroups ?? [])
    .map((g) => g.GroupId)
    .filter((id): id is string => typeof id === 'string')
    .sort();

  // PrivateIpAddress: AWS-assigned for default subnets, user-assigned
  // when CFn templates the property. Always emit so the v3 baseline
  // catches console-side reassignment (rare but possible via Stop +
  // ModifyNetworkInterfaceAttribute).
  if (instance.PrivateIpAddress !== undefined) {
    result['PrivateIpAddress'] = instance.PrivateIpAddress;
  }

  // SourceDestCheck: boolean toggle, returned directly by DescribeInstances.
  if (instance.SourceDestCheck !== undefined) {
    result['SourceDestCheck'] = instance.SourceDestCheck;
  }

  // AvailabilityZone (#1276): the CFn property maps to RunInstances'
  // `Placement.AvailabilityZone`, so the reverse map has to come back out
  // of `Placement` too. Without it, every drift run on an L2-authored
  // instance would report a phantom diff (state has the property, the
  // AWS-current snapshot would not).
  if (instance.Placement?.AvailabilityZone !== undefined) {
    result['AvailabilityZone'] = instance.Placement.AvailabilityZone;
  }

  // Monitoring: AWS returns {State: 'enabled' | 'disabled' | 'pending' | 'disabling'}.
  // CFn input is a boolean. Map enabled-ish → true, disabled-ish → false.
  // Always emit so a console-side toggle is detectable.
  const monitoringState = instance.Monitoring?.State;
  result['Monitoring'] = monitoringState === 'enabled' || monitoringState === 'pending';

  // EbsOptimized (#609): boolean returned directly by DescribeInstances.
  // Emit-when-present so a console-side toggle is detectable without firing
  // spurious drift on instances where AWS omits the field.
  if (instance.EbsOptimized !== undefined) {
    result['EbsOptimized'] = instance.EbsOptimized;
  }

  // MetadataOptions (#609): DescribeInstances returns the resolved IMDS
  // config under instance.MetadataOptions. Reverse-map to the CFn input
  // shape (same field names). Only the four CFn-settable string keys plus
  // the numeric hop limit are surfaced — `State` (provisioning lifecycle)
  // is AWS-managed and not a CFn input, so it is excluded to avoid
  // false-positive drift. Emit-when-present.
  const md = instance.MetadataOptions;
  if (md !== undefined) {
    const out: Record<string, unknown> = {};
    if (md.HttpTokens !== undefined) out['HttpTokens'] = md.HttpTokens;
    if (md.HttpPutResponseHopLimit !== undefined) {
      out['HttpPutResponseHopLimit'] = md.HttpPutResponseHopLimit;
    }
    if (md.HttpEndpoint !== undefined) out['HttpEndpoint'] = md.HttpEndpoint;
    if (md.HttpProtocolIpv6 !== undefined) out['HttpProtocolIpv6'] = md.HttpProtocolIpv6;
    if (md.InstanceMetadataTags !== undefined) {
      out['InstanceMetadataTags'] = md.InstanceMetadataTags;
    }
    if (Object.keys(out).length > 0) result['MetadataOptions'] = out;
  }

  // go-to-k/cdkd#5630: the launch-time CPU and hibernation options, same
  // member names as CloudFormation's. DescribeInstances also reports
  // `CpuOptions.AmdSevSnp`, which CloudFormation has no member for.
  if (instance.CpuOptions !== undefined) {
    const cpu: Record<string, unknown> = {};
    if (instance.CpuOptions.CoreCount !== undefined)
      cpu['CoreCount'] = instance.CpuOptions.CoreCount;
    if (instance.CpuOptions.ThreadsPerCore !== undefined) {
      cpu['ThreadsPerCore'] = instance.CpuOptions.ThreadsPerCore;
    }
    if (Object.keys(cpu).length > 0) result['CpuOptions'] = cpu;
  }
  if (instance.HibernationOptions?.Configured !== undefined) {
    result['HibernationOptions'] = { Configured: instance.HibernationOptions.Configured };
  }
  // go-to-k/cdkd#5630: the hostname options, same member names as
  // CloudFormation's (DescribeInstances reports all three for every
  // instance, the subnet's defaults when the template set none).
  const dnsOptions = instance.PrivateDnsNameOptions;
  if (dnsOptions !== undefined) {
    const dns: Record<string, unknown> = {};
    if (dnsOptions.HostnameType !== undefined) dns['HostnameType'] = dnsOptions.HostnameType;
    if (dnsOptions.EnableResourceNameDnsARecord !== undefined) {
      dns['EnableResourceNameDnsARecord'] = dnsOptions.EnableResourceNameDnsARecord;
    }
    if (dnsOptions.EnableResourceNameDnsAAAARecord !== undefined) {
      dns['EnableResourceNameDnsAAAARecord'] = dnsOptions.EnableResourceNameDnsAAAARecord;
    }
    if (Object.keys(dns).length > 0) result['PrivateDnsNameOptions'] = dns;
  }

  // Tenancy: lives under Placement.Tenancy.
  if (instance.Placement?.Tenancy !== undefined) {
    result['Tenancy'] = instance.Placement.Tenancy;
  }
  // go-to-k/cdkd#5630: PlacementGroupName lives under Placement.GroupName
  // (AWS omits it, or reports it empty, for an instance in no group).
  if (typeof instance.Placement?.GroupName === 'string' && instance.Placement.GroupName !== '') {
    result['PlacementGroupName'] = instance.Placement.GroupName;
  }

  // IamInstanceProfile: CFn accepts either a name or an ARN. AWS returns
  // the ARN; we surface that. State that holds a name will fire one-time
  // drift on v2 fallback (resolve via cdkd state refresh-observed); v3
  // observedProperties matches exactly because deploy-time read is the
  // same wire shape.
  if (instance.IamInstanceProfile?.Arn !== undefined) {
    result['IamInstanceProfile'] = instance.IamInstanceProfile.Arn;
  } else if (process.env['CDKD_NO_WAIT'] === 'true' && instance.State?.Name === 'pending') {
    // --no-wait deploy-time observed-capture runs against a `pending`
    // instance whose launch-time profile association may still be
    // `associating`, in which case DescribeInstances does not surface it
    // yet. Recording the field as absent would leave a PERMANENT drift
    // blind spot: the comparator walks the baseline's keys only, so a key
    // missing from observedProperties is never compared again -- a later
    // console-side profile detach would go unreported forever (issue
    // #1291 item 3). One targeted association read closes it; the extra
    // call happens ONLY in this narrow window (--no-wait capture of a
    // still-pending instance), never on `cdkd drift` reads.
    // Best-effort: a transient throttle here must cost only THIS field,
    // not the whole snapshot -- an uncaught throw would make the deploy
    // engine discard the entire observed-properties capture.
    try {
      const assoc = await this.ec2Client.send(
        new DescribeIamInstanceProfileAssociationsCommand({
          Filters: [{ Name: 'instance-id', Values: [physicalId] }],
        })
      );
      const live = assoc.IamInstanceProfileAssociations?.find(
        (a) => a.State === 'associated' || a.State === 'associating'
      );
      if (live?.IamInstanceProfile?.Arn !== undefined) {
        result['IamInstanceProfile'] = live.IamInstanceProfile.Arn;
      }
    } catch (error) {
      const backfillHead = `Could not backfill IamInstanceProfile for ${physicalId} during the --no-wait capture: `;
      this.logger.warn(
        `${backfillHead}${this.warnFailureSentence(backfillHead, error, (t) => t)} The field is omitted from the observed snapshot.`
      );
    }
  }

  // BlockDeviceMappings: AWS DescribeInstances returns (DeviceName, Ebs.{VolumeId,
  // DeleteOnTermination, Status, AttachTime}). VolumeType / Size / Iops /
  // Throughput / Encrypted / KmsKeyId / SnapshotId live on the volume
  // itself — fetch via DescribeVolumes for the attached volumes only when
  // there are EBS-backed mappings.
  const ebsMappings = (instance.BlockDeviceMappings ?? []).filter(
    (m) => m.Ebs?.VolumeId !== undefined
  );
  const volumeIds = ebsMappings.map((m) => m.Ebs!.VolumeId!);
  let volumesById: Map<string, Volume> = new Map();
  if (volumeIds.length > 0) {
    try {
      const volResp = await this.ec2Client.send(
        new DescribeVolumesCommand({ VolumeIds: volumeIds })
      );
      for (const v of volResp.Volumes ?? []) {
        if (v.VolumeId !== undefined) volumesById.set(v.VolumeId, v);
      }
    } catch (err) {
      // Best-effort: if DescribeVolumes fails (rare — maybe a permissions
      // gap), fall back to the partial shape. The DeleteOnTermination
      // field is still surfaced from the DescribeInstances response.
      this.logger.debug(
        `DescribeVolumes(${volumeIds.join(',')}) failed: ${describeAwsFailure(err).detail}`
      );
      volumesById = new Map();
    }
  }

  const blockMappings: Array<Record<string, unknown>> = [];
  for (const m of instance.BlockDeviceMappings ?? []) {
    const out: Record<string, unknown> = {};
    if (m.DeviceName !== undefined) out['DeviceName'] = m.DeviceName;
    // VirtualName (ephemeral / instance-store) is not returned by
    // DescribeInstances — AWS only surfaces EBS-backed mappings here.
    // Templates that set VirtualName fall back to v2 baseline and may
    // fire one-time drift on the missing key, which `cdkd state
    // refresh-observed` clears.

    if (m.Ebs?.VolumeId !== undefined) {
      const ebs: Record<string, unknown> = {};
      if (m.Ebs.DeleteOnTermination !== undefined) {
        ebs['DeleteOnTermination'] = m.Ebs.DeleteOnTermination;
      }
      const vol = volumesById.get(m.Ebs.VolumeId);
      if (vol !== undefined) {
        if (vol.VolumeType !== undefined) ebs['VolumeType'] = vol.VolumeType;
        if (vol.Size !== undefined) ebs['VolumeSize'] = vol.Size;
        if (vol.Iops !== undefined) ebs['Iops'] = vol.Iops;
        if (vol.Throughput !== undefined) ebs['Throughput'] = vol.Throughput;
        if (vol.Encrypted !== undefined) ebs['Encrypted'] = vol.Encrypted;
        if (vol.KmsKeyId !== undefined) ebs['KmsKeyId'] = vol.KmsKeyId;
        if (vol.SnapshotId !== undefined) ebs['SnapshotId'] = vol.SnapshotId;
      }
      out['Ebs'] = ebs;
    }
    blockMappings.push(out);
  }
  result['BlockDeviceMappings'] = blockMappings;

  // Volumes (go-to-k/cdkd#5630): read for a bag that declares them, as the
  // live attachments of the declared volume ids, in the declared order. A
  // volume another construct attached (an `AWS::EC2::VolumeAttachment`) is
  // not this property's, so it is left out.
  if (
    Array.isArray(properties?.['Volumes']) &&
    instanceVolumesRefusal(properties['Volumes'], 'AWS::EC2::Instance') === undefined
  ) {
    const declaredIds = instanceVolumeEntries(properties['Volumes'])
      .map((v) => v.VolumeId)
      .filter((id) => typeof id === 'string');
    const attached = (instance.BlockDeviceMappings ?? []).filter(
      (m) =>
        m.Ebs?.VolumeId !== undefined &&
        m.DeviceName !== undefined &&
        declaredIds.includes(m.Ebs.VolumeId)
    );
    result['Volumes'] = attached
      .sort((a, b) => declaredIds.indexOf(a.Ebs!.VolumeId!) - declaredIds.indexOf(b.Ebs!.VolumeId!))
      .map((m) => ({ Device: m.DeviceName!, VolumeId: m.Ebs!.VolumeId! }));
  }

  // Tags: filter aws:* (CDK-internal metadata) and always emit (even as
  // []). Same pattern as every other tag-aware provider.
  result['Tags'] = normalizeAwsTagsToCfn(instance.Tags);

  // DisableApiTermination: not returned by DescribeInstances; needs a
  // separate DescribeInstanceAttribute call. Best-effort — a permissions
  // gap or other failure falls back to omitting the key (state-keys-only
  // walk skips silently). Always emit when AWS reports a value so the v3
  // baseline catches a console-side toggle.
  try {
    const attrResp = await this.ec2Client.send(
      new DescribeInstanceAttributeCommand({
        InstanceId: physicalId,
        Attribute: 'disableApiTermination',
      })
    );
    if (attrResp.DisableApiTermination?.Value !== undefined) {
      result['DisableApiTermination'] = attrResp.DisableApiTermination.Value;
    }
  } catch (err) {
    this.logger.debug(
      `DescribeInstanceAttribute(disableApiTermination, ${physicalId}) failed: ${
        describeAwsFailure(err).detail
      }`
    );
  }

  // InstanceInitiatedShutdownBehavior (go-to-k/cdkd#5630): another
  // DescribeInstanceAttribute call, made only for a bag that declares it, so
  // an instance without it pays no extra read. Best-effort as above.
  if (properties?.['InstanceInitiatedShutdownBehavior'] !== undefined) {
    try {
      const attrResp = await this.ec2Client.send(
        new DescribeInstanceAttributeCommand({
          InstanceId: physicalId,
          Attribute: 'instanceInitiatedShutdownBehavior',
        })
      );
      if (attrResp.InstanceInitiatedShutdownBehavior?.Value !== undefined) {
        result['InstanceInitiatedShutdownBehavior'] =
          attrResp.InstanceInitiatedShutdownBehavior.Value;
      }
    } catch (err) {
      this.logger.debug(
        safeMsg`DescribeInstanceAttribute(instanceInitiatedShutdownBehavior, ${physicalId}) failed: ${describeAwsFailure(err).detail}`
      );
    }
  }

  // CreditSpecification (#609): not returned by DescribeInstances; needs a
  // separate DescribeInstanceCreditSpecifications call. Best-effort — only
  // T-family burstable instances have a credit spec, and AWS errors for
  // non-burstable families, so a failure / absent value falls back to
  // omitting the key (the state-keys-only drift walk skips it silently).
  // Reverse-map to the CFn input shape ({ CPUCredits } — the canonical CDK
  // emission) so drift compares like-for-like against templated state.
  try {
    const creditResp = await this.ec2Client.send(
      new DescribeInstanceCreditSpecificationsCommand({ InstanceIds: [physicalId] })
    );
    const cpuCredits = creditResp.InstanceCreditSpecifications?.[0]?.CpuCredits;
    if (cpuCredits !== undefined) {
      result['CreditSpecification'] = { CPUCredits: cpuCredits };
    }
  } catch (err) {
    this.logger.debug(
      `DescribeInstanceCreditSpecifications(${physicalId}) failed: ${
        describeAwsFailure(err).detail
      }`
    );
  }

  return result;
}

/** The {@link EC2Provider} methods this module defines. */
export const readInstanceStateMethods = { readInstanceCurrentState };
