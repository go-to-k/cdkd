import {
  DescribeInstancesCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  DescribeInstanceCreditSpecificationsCommand,
  DescribeVolumesCommand,
  DescribeInstanceAttributeCommand,
  type Instance,
  type Volume,
} from '@aws-sdk/client-ec2';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import {
  instanceSsmAssociationEntries,
  instanceSsmAssociationsRefusal,
  instanceVolumeEntries,
  instanceVolumesRefusal,
} from './instance-support.js';
import type { EC2Provider } from '../ec2-provider.js';
import { isNamedError } from './common.js';
import { inDeclaredOrder } from '../../declared-order.js';
import {
  recordedSecrecyOf,
  type RecordedProvenanceFields,
} from '../../../deployment/secret-redaction/recorded-secrecy.js';

/** The instance's own not-found code on a per-attribute read. */
const INVALID_INSTANCE_NOT_FOUND: ReadonlySet<string> = new Set(['InvalidInstanceID.NotFound']);
/** A volume gone between `DescribeInstances` and `DescribeVolumes`. */
const INVALID_VOLUME_NOT_FOUND: ReadonlySet<string> = new Set(['InvalidVolume.NotFound']);
/** The answers that mean an instance has no credit specification to read. */
const CREDIT_SPECIFICATION_NOT_APPLICABLE: ReadonlySet<string> = new Set([
  'InvalidInstanceID.NotFound',
  'UnsupportedOperation',
]);

export async function readInstanceCurrentState(
  this: EC2Provider,
  physicalId: string,
  properties?: Record<string, unknown>,
  provenance?: RecordedProvenanceFields
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
  try {
    return await readInstanceDetails.call(this, physicalId, instance, properties, provenance);
  } catch (err) {
    // The instance's own not-found (gone between the calls) keeps mapping to
    // RESOURCE_NOT_FOUND there.
    if (!isNamedError(err, INVALID_INSTANCE_NOT_FOUND)) markInstanceSubReadFailure(err);
    throw err;
  }
}

/**
 * Errors of an instance's per-property reads (go-to-k/cdkd#6759), which
 * `readCurrentStateOnce`'s catch rethrows as they are: its not-found tests
 * (EC2's `*.NotFound` code, and the message text "not found" / "does not
 * exist") are about the INSTANCE, and a per-property read that failed (an SSM
 * error saying a document does not exist, a volume's not-found the read did
 * not tolerate) must fail the read, not report the instance gone or unknown.
 */
const instanceSubReadFailures = new WeakSet<object>();

function markInstanceSubReadFailure(err: unknown): void {
  if (typeof err === 'object' && err !== null) instanceSubReadFailures.add(err);
}

/** Whether `err` came from an instance's per-property read (see above). */
export function isInstanceSubReadFailure(err: unknown): boolean {
  return typeof err === 'object' && err !== null && instanceSubReadFailures.has(err);
}

/** The bag of a live instance, `DescribeInstances` already answered. */
async function readInstanceDetails(
  this: EC2Provider,
  physicalId: string,
  instance: Instance,
  properties: Record<string, unknown> | undefined,
  provenance: RecordedProvenanceFields | undefined
): Promise<Record<string, unknown>> {
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
  // SecurityGroups (go-to-k/cdkd#6754): the same groups by NAME, the
  // CloudFormation spelling for a default-VPC instance. Read only for a bag
  // that declares it, in the declared order: an instance declaring
  // `SecurityGroupIds` (every CDK instance) would otherwise record names the
  // template never set.
  if (properties?.['SecurityGroups'] != null) {
    result['SecurityGroups'] = inDeclaredOrder(
      (instance.SecurityGroups ?? []).flatMap((g) =>
        typeof g.GroupName === 'string' ? [g.GroupName] : []
      ),
      (name) => name,
      Array.isArray(properties['SecurityGroups']) ? properties['SecurityGroups'] : undefined
    );
  }

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
  // go-to-k/cdkd#5630: the Dedicated Host members live under Placement too,
  // the kernel / RAM disk at the top level, all with CloudFormation's names
  // (AWS omits each one an instance does not have).
  const placementReads = [
    ['Affinity', instance.Placement?.Affinity],
    ['HostId', instance.Placement?.HostId],
    ['HostResourceGroupArn', instance.Placement?.HostResourceGroupArn],
    ['KernelId', instance.KernelId],
    ['RamdiskId', instance.RamdiskId],
  ] as const;
  for (const [key, value] of placementReads) {
    if (typeof value === 'string' && value !== '') result[key] = value;
  }
  if (instance.EnclaveOptions?.Enabled !== undefined) {
    result['EnclaveOptions'] = { Enabled: instance.EnclaveOptions.Enabled };
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
    // A failed read throws (issue #6759): omitting the field would be the
    // same permanent blind spot. The deploy engine then records no
    // observed-properties capture for this instance (the deploy itself does
    // not fail), so drift falls back to its template properties until the
    // next successful deploy.
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
      // A volume detached and deleted between the two calls
      // (`InvalidVolume.NotFound`) falls back to the partial shape: the
      // DeleteOnTermination field is still surfaced from the DescribeInstances
      // response. Any other failure (AccessDenied, a throttle) throws (issue
      // #6759) rather than record mappings without their volume details.
      if (!isNamedError(err, INVALID_VOLUME_NOT_FOUND)) throw err;
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
  // go-to-k/cdkd#6384: for a bag that declares BlockDeviceMappings, only the
  // declared devices are this property's. A volume another construct attached
  // after launch (an `AWS::EC2::VolumeAttachment`, the `Volumes` property) is
  // left out, as `Volumes` below leaves out the attachment's volumes. A bag
  // that does not declare the key is not compared at all (drift's
  // `UNDECLARED_UNCOMPARED_KEYS`). When no declared name matches a live
  // device (a spelling AWS reports differently, every declared device gone),
  // nothing is narrowed, so the list is still compared rather than emptied.
  const declaredDevices = declaredBlockDeviceNames(properties);
  const isDeclared = (m: Record<string, unknown>): boolean =>
    declaredDevices !== undefined &&
    typeof m['DeviceName'] === 'string' &&
    declaredDevices.has(m['DeviceName']);
  result['BlockDeviceMappings'] = blockMappings.some(isDeclared)
    ? blockMappings.filter(isDeclared)
    : blockMappings;

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

  // SsmAssociations (go-to-k/cdkd#5630): read for a bag that declares them,
  // as CloudFormation reads them (ListAssociations + DescribeAssociation),
  // in the template's shape and parameter order. An unreadable Systems
  // Manager throws (issue #6759) rather than omit the key.
  if (
    Array.isArray(properties?.['SsmAssociations']) &&
    instanceSsmAssociationsRefusal(properties['SsmAssociations'], 'AWS::EC2::Instance') ===
      undefined
  ) {
    result['SsmAssociations'] = await this.readInstanceSsmAssociations(
      physicalId,
      instanceSsmAssociationEntries(properties['SsmAssociations'])
    );
  }

  // Tags: filter aws:* (CDK-internal metadata) and always emit (even as
  // []). Same pattern as every other tag-aware provider.
  result['Tags'] = normalizeAwsTagsToCfn(instance.Tags);

  // DisableApiTermination: not returned by DescribeInstances; needs a
  // separate DescribeInstanceAttribute call. The instance's not-found (gone
  // between the calls) omits the key; any other failure throws (issue
  // #6759), since an omitted key is never compared. Always emit when AWS
  // reports a value so the v3 baseline catches a console-side toggle.
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
    if (!isNamedError(err, INVALID_INSTANCE_NOT_FOUND)) throw err;
  }

  // UserData (go-to-k/cdkd#6754): the base64 text CloudFormation declares, as
  // `DescribeInstanceAttribute userData` returns it. Another call, made only
  // for a bag that declares UserData. An instance with none reads back without
  // the key, so a declared value removed out of band differs from it. A failed
  // read throws rather than omitting the key, which would read as that
  // removal. A record holding the mask in its place (a secret under
  // `Fn::Base64` is persisted as `***`) is not read: the value cannot be
  // compared, and `getDriftUnknownPaths` declares it unknown. So is one the
  // record's provenance names (go-to-k/cdkd#7061): a masked-property
  // fingerprint or a `NoEcho` coordinate under it.
  if (properties?.['UserData'] != null && !userDataUnreadable(properties, provenance)) {
    const attrResp = await this.ec2Client.send(
      new DescribeInstanceAttributeCommand({ InstanceId: physicalId, Attribute: 'userData' })
    );
    if (attrResp.UserData?.Value !== undefined) result['UserData'] = attrResp.UserData.Value;
  }

  // InstanceInitiatedShutdownBehavior (go-to-k/cdkd#5630): another
  // DescribeInstanceAttribute call, made only for a bag that declares it, so
  // an instance without it pays no extra read. A failure other than the
  // instance's not-found throws, as above.
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
      if (!isNamedError(err, INVALID_INSTANCE_NOT_FOUND)) throw err;
    }
  }

  // CreditSpecification (#609): not returned by DescribeInstances; needs a
  // separate DescribeInstanceCreditSpecifications call. An absent value
  // omits the key. The SDK documents `standard` as the answer for a
  // non-burstable instance; `UnsupportedOperation` (EC2's "not available for
  // this instance") and the instance's not-found also omit the key, and any
  // other failure (AccessDenied, a throttle) throws (issue #6759).
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
    if (!isNamedError(err, CREDIT_SPECIFICATION_NOT_APPLICABLE)) throw err;
  }

  return result;
}

/**
 * The device names a bag's `BlockDeviceMappings` declares (go-to-k/cdkd#6384),
 * or `undefined` when the bag does not declare a readable list: absent, not an
 * array, or an entry whose `DeviceName` is not a string (an unresolved
 * intrinsic). `undefined` means "do not narrow", so an unreadable declaration
 * keeps comparing every live mapping rather than hiding one.
 */
export function declaredBlockDeviceNames(
  properties: Record<string, unknown> | undefined
): ReadonlySet<string> | undefined {
  const declared = properties?.['BlockDeviceMappings'];
  if (!Array.isArray(declared)) return undefined;
  const names = new Set<string>();
  for (const entry of declared) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const name = (entry as Record<string, unknown>)['DeviceName'];
    if (typeof name !== 'string') return undefined;
    names.add(name);
  }
  return names;
}

/** The {@link EC2Provider} methods this module defines. */
export const readInstanceStateMethods = { readInstanceCurrentState };

/**
 * Whether the record's `UserData` has no value to compare a readback with
 * (go-to-k/cdkd#6754): the record holds a secret there, by its text (the mask,
 * or, since go-to-k/cdkd#7061, a dynamic reference) or by its provenance (a masked-property fingerprint, a `NoEcho`
 * coordinate under it; go-to-k/cdkd#7061), or the record cannot tell. Read by
 * the readback, which then makes no `userData` call, and by
 * `getDriftUnknownPaths`, which declares the path unknown. A read with no
 * record context (the deploy capture, the unsettled re-check) has no provenance
 * and decides on the text alone.
 */
export function userDataUnreadable(
  properties: Record<string, unknown> | undefined,
  provenance: RecordedProvenanceFields | undefined
): boolean {
  return (
    recordedSecrecyOf({ ...provenance, properties }, { field: 'properties', key: 'UserData' }) !==
    'clear'
  );
}
