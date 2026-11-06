import {
  type Tenancy,
  type VolumeType,
  type BlockDeviceMapping,
  type EnaSrdSpecificationRequest,
  type InstanceMetadataOptionsRequest,
  type CreditSpecificationRequest,
  type InstanceNetworkInterfaceSpecification,
  type HttpTokensState,
  type InstanceMetadataEndpointState,
  type InstanceMetadataProtocolState,
  type InstanceMetadataTagsState,
  type CpuOptionsRequest,
  type HibernationOptionsRequest,
  type ShutdownBehavior,
  type PrivateDnsNameOptionsRequest,
  type LaunchTemplateSpecification,
} from '@aws-sdk/client-ec2';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  coerceCfnBoolean,
  coerceCfnInteger,
  configBooleanRefusal,
  configIntegerRefusal,
  configStringRefusal,
} from '../../config-shape.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import {
  instanceIpv6AddressesRefusal,
  instanceLaunchTemplateRefusal,
  instanceLicenseSpecificationsRefusal,
  instanceSsmAssociationsRefusal,
  instanceVolumesRefusal,
  launchTemplateRequest,
  licenseSpecificationsRequest,
  ssmAssociationsAwsRefusal,
  privateDnsNameOptionsRefusal,
  privateDnsNameOptionsRequest,
} from './instance-support.js';
import type { EC2Provider } from '../ec2-provider.js';

/**
 * Map the CFn `AWS::EC2::Instance.BlockDeviceMappings` list onto
 * RunInstances' `BlockDeviceMappings` input. Every member CFn's schema
 * declares is mapped (issue #5445: only DeviceName and
 * Ebs.{VolumeSize,VolumeType,DeleteOnTermination} used to reach AWS, so a
 * volume declared `Encrypted` / with a `KmsKeyId` was created unencrypted
 * unless the account default said otherwise):
 *
 * - `Ebs.{DeleteOnTermination,Encrypted,Iops,KmsKeyId,SnapshotId,
 *   VolumeSize,VolumeType}` -- CFn's `Ebs` definition is closed
 *   (`additionalProperties: false`) and has no `Throughput`; CDK's L2
 *   warns `throughputNotSupported` and `CfnInstance` never emits it.
 * - `VirtualName` -- instance-store mappings (`ephemeralN`).
 * - `NoDevice` -- an empty object `{}` in CFn; the SDK member is a string
 *   whose presence suppresses the AMI's mapping, so any present value maps
 *   to `""`.
 *
 * Booleans and integers may arrive stringly typed from an
 * intrinsic-resolved value, so they are coerced at the wire boundary.
 * `DeleteOnTermination` keeps its pre-#5445 default of `true` when absent.
 * An `Encrypted` that is present but reads as neither boolean (`"True"`,
 * `"1"`, a masked value) is refused rather than omitted: omitting it would
 * launch the volume under the account default, the very drop #5445 fixed.
 *
 * `Iops` is sent whatever the `VolumeType`, as CloudFormation does: a
 * CloudFormation create with `gp2` + `Iops` fails with EC2's "The parameter
 * iops is not supported for gp2 volumes" (measured for #5445), so cdkd
 * surfaces the same rejection rather than dropping the value.
 */
export function buildBlockDeviceMappings(
  this: EC2Provider,
  properties: Record<string, unknown>,
  logicalId: string
): BlockDeviceMapping[] | undefined {
  const mappings = properties['BlockDeviceMappings'] as Array<Record<string, unknown>> | undefined;
  if (!mappings || !Array.isArray(mappings)) return undefined;

  return mappings.map((entry, index) => {
    const m = (entry ?? {}) as Record<string, unknown>;
    const ebs = m['Ebs'] as Record<string, unknown> | undefined;
    const result: BlockDeviceMapping = {
      DeviceName: m['DeviceName'] as string,
    };
    if (typeof m['VirtualName'] === 'string') {
      result.VirtualName = m['VirtualName'];
    }
    if (m['NoDevice'] !== undefined && m['NoDevice'] !== null) {
      result.NoDevice = '';
    }
    if (ebs) {
      result.Ebs = {
        VolumeSize: this.coerceNumber(ebs['VolumeSize']),
        VolumeType: ebs['VolumeType'] as VolumeType | undefined,
        DeleteOnTermination: this.coerceBool(ebs['DeleteOnTermination']) ?? true,
      };
      const rawEncrypted = ebs['Encrypted'];
      const encrypted = this.coerceBool(rawEncrypted);
      if (encrypted === undefined && rawEncrypted !== undefined && rawEncrypted !== null) {
        // The value is not echoed: it is unreadable by construction and may
        // be a masked or resolved value the user did not mean to print.
        throw new ProvisioningError(
          `EC2 Instance ${logicalId}: BlockDeviceMappings[${index}].Ebs.Encrypted is a ${typeof rawEncrypted} that is neither true nor false. ` +
            `Set it to true or false (or the strings "true" / "false"); cdkd refuses to create the volume without the declared encryption setting.`,
          'AWS::EC2::Instance',
          logicalId
        );
      }
      if (encrypted !== undefined) result.Ebs.Encrypted = encrypted;
      const iops = this.coerceNumber(ebs['Iops']);
      if (iops !== undefined) result.Ebs.Iops = iops;
      if (typeof ebs['KmsKeyId'] === 'string') result.Ebs.KmsKeyId = ebs['KmsKeyId'];
      if (typeof ebs['SnapshotId'] === 'string') result.Ebs.SnapshotId = ebs['SnapshotId'];
    }
    return result;
  });
}

/**
 * Coerce a CFn boolean-ish value (`true` | `false` | `"true"` | `"false"`)
 * into a real boolean, or `undefined` when the property is absent. CFn
 * templates can carry either the JSON boolean or its string form depending
 * on how the value was produced (a literal vs an intrinsic-resolved value),
 * so the wire boundary must normalize both. Returns `undefined` for absent
 * props so the field is omitted from the SDK input (AWS keeps its default)
 * rather than being forced to `false`.
 */
export function coerceBool(this: EC2Provider, value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * Build the RunInstances `Monitoring` shape from the CFn `Monitoring`
 * boolean. AWS expects `{ Enabled: boolean }`; CFn carries a flat boolean.
 * Returns `undefined` when the prop is absent so the field is omitted.
 */
export function buildRunInstancesMonitoring(
  this: EC2Provider,
  properties: Record<string, unknown>
): { Enabled: boolean } | undefined {
  const enabled = this.coerceBool(properties['Monitoring']);
  if (enabled === undefined) return undefined;
  return { Enabled: enabled };
}

/**
 * Build the RunInstances `MetadataOptions` shape from the CFn
 * `MetadataOptions` object. CFn and the SDK share field names
 * (HttpTokens / HttpEndpoint / HttpPutResponseHopLimit / HttpProtocolIpv6 /
 * InstanceMetadataTags). `HttpPutResponseHopLimit` is numeric — CFn may
 * carry it as a string, so coerce at the wire boundary. Only emits keys the
 * template actually set so AWS keeps its defaults for the rest.
 */
export function buildMetadataOptions(
  this: EC2Provider,
  properties: Record<string, unknown>
): InstanceMetadataOptionsRequest | undefined {
  const opts = properties['MetadataOptions'] as Record<string, unknown> | undefined;
  if (!opts || typeof opts !== 'object') return undefined;

  const result: InstanceMetadataOptionsRequest = {};
  if (opts['HttpTokens'] !== undefined) {
    result.HttpTokens = opts['HttpTokens'] as HttpTokensState;
  }
  if (opts['HttpEndpoint'] !== undefined) {
    result.HttpEndpoint = opts['HttpEndpoint'] as InstanceMetadataEndpointState;
  }
  if (opts['HttpProtocolIpv6'] !== undefined) {
    result.HttpProtocolIpv6 = opts['HttpProtocolIpv6'] as InstanceMetadataProtocolState;
  }
  if (opts['InstanceMetadataTags'] !== undefined) {
    result.InstanceMetadataTags = opts['InstanceMetadataTags'] as InstanceMetadataTagsState;
  }
  const hopLimit = opts['HttpPutResponseHopLimit'];
  if (hopLimit !== undefined && hopLimit !== null) {
    result.HttpPutResponseHopLimit = Number(hopLimit);
  }
  // Omit the whole block if the template set MetadataOptions: {} with no
  // recognized keys — there is nothing to send to AWS.
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Map the CFn `AWS::EC2::Instance.AvailabilityZone` property onto the
 * RunInstances `Placement.AvailabilityZone` input (issue #1276).
 *
 * Returns undefined when the property is absent so the input key is
 * omitted entirely -- an empty `Placement: {}` would be a pointless
 * shape change on every instance that does not set the property.
 *
 * go-to-k/cdkd#5630 adds the top-level CFn `Tenancy` and
 * `PlacementGroupName` (`Placement.Tenancy` / `.GroupName`); a malformed
 * one is refused by `buildLaunchOnlyInstanceOptions` before this runs.
 * HostId and Affinity (Dedicated Host) stay unhandled; adding one means
 * adding it to `handledProperties` too, or the #614 routing rule will keep
 * sending the resource to Cloud Control.
 */
export function buildPlacement(
  this: EC2Provider,
  properties: Record<string, unknown>
): { AvailabilityZone?: string; Tenancy?: Tenancy; GroupName?: string } | undefined {
  const out: { AvailabilityZone?: string; Tenancy?: Tenancy; GroupName?: string } = {};
  const az = properties['AvailabilityZone'];
  if (typeof az === 'string' && az !== '') out.AvailabilityZone = az;
  const tenancy = properties['Tenancy'];
  if (typeof tenancy === 'string' && tenancy !== '') out.Tenancy = tenancy as Tenancy;
  const group = properties['PlacementGroupName'];
  if (typeof group === 'string' && group !== '') out.GroupName = group;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Map the CFn `AWS::EC2::Instance.NetworkInterfaces` list onto
 * RunInstances' `NetworkInterfaces` input (issue #1281). Every CFn
 * sub-field is mapped (dropping a sub-field silently would be the #1225
 * bug class one level down): the two casing/shape divergences are
 * `GroupSet` -> `Groups` and CFn's stringly-typed numerics
 * (`DeviceIndex`, `Ipv6AddressCount`, `SecondaryPrivateIpAddressCount`
 * arrive as strings from CDK) -> numbers.
 */
export function buildNetworkInterfaces(
  this: EC2Provider,
  properties: Record<string, unknown>
): InstanceNetworkInterfaceSpecification[] | undefined {
  const raw = properties['NetworkInterfaces'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((entry) => {
    const ni = (entry ?? {}) as Record<string, unknown>;
    const spec: InstanceNetworkInterfaceSpecification = {
      DeviceIndex: this.coerceNumber(ni['DeviceIndex']),
      SubnetId: (ni['SubnetId'] as string) ?? undefined,
      Groups: (ni['GroupSet'] as string[]) ?? undefined,
      AssociatePublicIpAddress: this.coerceBool(ni['AssociatePublicIpAddress']),
      AssociateCarrierIpAddress: this.coerceBool(ni['AssociateCarrierIpAddress']),
      DeleteOnTermination: this.coerceBool(ni['DeleteOnTermination']),
      Description: (ni['Description'] as string) ?? undefined,
      NetworkInterfaceId: (ni['NetworkInterfaceId'] as string) ?? undefined,
      PrivateIpAddress: (ni['PrivateIpAddress'] as string) ?? undefined,
      Ipv6AddressCount: this.coerceNumber(ni['Ipv6AddressCount']),
      Ipv6Addresses: Array.isArray(ni['Ipv6Addresses'])
        ? (ni['Ipv6Addresses'] as Array<Record<string, unknown>>).map((a) => ({
            Ipv6Address: (a?.['Ipv6Address'] as string) ?? undefined,
          }))
        : undefined,
      PrivateIpAddresses: Array.isArray(ni['PrivateIpAddresses'])
        ? (ni['PrivateIpAddresses'] as Array<Record<string, unknown>>).map((a) => ({
            Primary: this.coerceBool(a?.['Primary']),
            PrivateIpAddress: (a?.['PrivateIpAddress'] as string) ?? undefined,
          }))
        : undefined,
      SecondaryPrivateIpAddressCount: this.coerceNumber(ni['SecondaryPrivateIpAddressCount']),
    };
    const enaSrd = this.buildEnaSrdSpecification(ni['EnaSrdSpecification']);
    if (enaSrd !== undefined) spec.EnaSrdSpecification = enaSrd;
    return spec;
  });
}

/**
 * Map a CFn `NetworkInterfaces[].EnaSrdSpecification` (ENA Express) onto
 * the RunInstances `EnaSrdSpecificationRequest` (issue #5445: it used to be
 * dropped on create). Field names match; the booleans are coerced. Returns
 * undefined when the block is absent or sets nothing.
 */
export function buildEnaSrdSpecification(
  this: EC2Provider,
  raw: unknown
): EnaSrdSpecificationRequest | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const spec = raw as Record<string, unknown>;
  const result: EnaSrdSpecificationRequest = {};
  const enabled = this.coerceBool(spec['EnaSrdEnabled']);
  if (enabled !== undefined) result.EnaSrdEnabled = enabled;
  const udp = spec['EnaSrdUdpSpecification'];
  if (udp !== null && typeof udp === 'object') {
    const udpEnabled = this.coerceBool((udp as Record<string, unknown>)['EnaSrdUdpEnabled']);
    if (udpEnabled !== undefined) result.EnaSrdUdpSpecification = { EnaSrdUdpEnabled: udpEnabled };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * CFn numerics are stringly typed on the wire ("0", not 0); RunInstances
 * wants numbers. Tolerate both, return undefined for anything else.
 */
export function coerceNumber(this: EC2Provider, value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * Build the RunInstances `CreditSpecification` shape from the CFn
 * `CreditSpecification` object. CFn uses `CPUCredits` (capital CPU, the
 * canonical CDK `CfnInstance` emission); accept the SDK-style `CpuCredits`
 * too for hand-authored templates. Returns `undefined` when absent / empty.
 */
export function buildCreditSpecification(
  this: EC2Provider,
  properties: Record<string, unknown>
): CreditSpecificationRequest | undefined {
  const cpuCredits = this.readCpuCredits(properties['CreditSpecification']);
  if (cpuCredits === undefined) return undefined;
  return { CpuCredits: cpuCredits };
}

/**
 * Extract the CpuCredits string from a CFn `CreditSpecification` object,
 * tolerating both the canonical `CPUCredits` key and the SDK-style
 * `CpuCredits` key. Shared by create() and update().
 */
export function readCpuCredits(this: EC2Provider, spec: unknown): string | undefined {
  if (!spec || typeof spec !== 'object') return undefined;
  const obj = spec as Record<string, unknown>;
  const raw = obj['CPUCredits'] ?? obj['CpuCredits'];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * go-to-k/cdkd#5630: the launch-only RunInstances inputs. `CpuOptions` and
 * `HibernationOptions` are create-only (a change replaces the instance via
 * the schema's `createOnlyProperties`); `InstanceInitiatedShutdownBehavior`
 * also changes in place (`planInstanceMemberUpdates`); `PrivateIpAddress`
 * is create-only too. The same refusal also covers `Tenancy` /
 * `PlacementGroupName` (sent by `buildPlacement`), `SourceDestCheck` (set
 * after the launch) and `PropagateTagsToVolumeOnCreation`. `Ipv6AddressCount`
 * / `Ipv6Addresses` are create-only; `PrivateDnsNameOptions` also changes in
 * place; `AdditionalInfo` is reserved by EC2, which refuses the launch
 * (`InvalidParameterValue: Bad property set`, measured), as it fails a
 * CloudFormation stack. `LaunchTemplate` is create-only; a malformed
 * `Volumes` (attached after the launch) is refused here too. Member names
 * match on both sides. A malformed value is refused before RunInstances, on a
 * rollback replay too: RunInstances rejects it every time, so the replay
 * could not succeed, and dropping it would launch an instance with CPU,
 * hibernation or shutdown settings the record never declared.
 */
export function buildLaunchOnlyInstanceOptions(
  this: EC2Provider,
  properties: Record<string, unknown>,
  resourceType: string,
  logicalId: string
): {
  CpuOptions?: CpuOptionsRequest;
  HibernationOptions?: HibernationOptionsRequest;
  InstanceInitiatedShutdownBehavior?: ShutdownBehavior;
  PrivateIpAddress?: string;
  AdditionalInfo?: string;
  Ipv6AddressCount?: number;
  Ipv6Addresses?: Array<{ Ipv6Address: string }>;
  PrivateDnsNameOptions?: PrivateDnsNameOptionsRequest;
  LaunchTemplate?: LaunchTemplateSpecification;
  LicenseSpecifications?: Array<{ LicenseConfigurationArn: string }>;
} {
  const cpu = properties['CpuOptions'];
  const hibernation = properties['HibernationOptions'];
  const refusal =
    configIntegerRefusal(cpu, 'CoreCount', `${resourceType} CpuOptions`, 1) ??
    configIntegerRefusal(cpu, 'ThreadsPerCore', `${resourceType} CpuOptions`, 1) ??
    configBooleanRefusal(hibernation, 'Configured', `${resourceType} HibernationOptions`) ??
    configStringRefusal(properties, 'InstanceInitiatedShutdownBehavior', '', resourceType) ??
    // go-to-k/cdkd#5630: dropping one of these would launch an instance
    // with a tenancy, placement group, address, source/destination check or
    // volume tags the template never declared.
    configStringRefusal(properties, 'Tenancy', '', resourceType) ??
    configStringRefusal(properties, 'PlacementGroupName', '', resourceType) ??
    configStringRefusal(properties, 'PrivateIpAddress', '', resourceType) ??
    configBooleanRefusal(properties, 'SourceDestCheck', resourceType) ??
    configBooleanRefusal(properties, 'PropagateTagsToVolumeOnCreation', resourceType) ??
    // go-to-k/cdkd#5630: an address count, addresses, hostname options or
    // the reserved AdditionalInfo the launch would otherwise silently lose.
    configStringRefusal(properties, 'AdditionalInfo', '', resourceType) ??
    configIntegerRefusal(properties, 'Ipv6AddressCount', resourceType, 0) ??
    instanceIpv6AddressesRefusal(properties['Ipv6Addresses'], resourceType) ??
    privateDnsNameOptionsRefusal(properties['PrivateDnsNameOptions'], resourceType) ??
    // go-to-k/cdkd#5630: a launch template the launch would otherwise drop,
    // and volumes the create would otherwise not attach.
    instanceLaunchTemplateRefusal(properties['LaunchTemplate'], resourceType) ??
    instanceVolumesRefusal(properties['Volumes'], resourceType) ??
    // go-to-k/cdkd#5630: a license configuration the launch would otherwise
    // drop, an association the create would otherwise not make, and the two
    // association shapes AWS refuses every time (CloudFormation fails them
    // before RunInstances, measured).
    instanceLicenseSpecificationsRefusal(properties['LicenseSpecifications'], resourceType) ??
    instanceSsmAssociationsRefusal(properties['SsmAssociations'], resourceType) ??
    ssmAssociationsAwsRefusal(properties, resourceType);
  if (refusal !== undefined) {
    throw markNonRetryable(
      new ProvisioningError(
        `${refusal}. The instance ${logicalId} was not launched.`,
        resourceType,
        logicalId
      )
    );
  }
  const out: ReturnType<EC2Provider['buildLaunchOnlyInstanceOptions']> = {};
  if (cpu !== undefined && cpu !== null) {
    const block = cpu as Record<string, unknown>;
    const coreCount = coerceCfnInteger(block['CoreCount']);
    const threadsPerCore = coerceCfnInteger(block['ThreadsPerCore']);
    out.CpuOptions = {
      ...(coreCount !== undefined && { CoreCount: coreCount }),
      ...(threadsPerCore !== undefined && { ThreadsPerCore: threadsPerCore }),
    };
  }
  if (hibernation !== undefined && hibernation !== null) {
    const configured = coerceCfnBoolean((hibernation as Record<string, unknown>)['Configured']);
    out.HibernationOptions = configured === undefined ? {} : { Configured: configured };
  }
  const shutdown = properties['InstanceInitiatedShutdownBehavior'];
  if (typeof shutdown === 'string' && shutdown !== '') {
    out.InstanceInitiatedShutdownBehavior = shutdown as ShutdownBehavior;
  }
  const privateIp = properties['PrivateIpAddress'];
  if (typeof privateIp === 'string' && privateIp !== '') out.PrivateIpAddress = privateIp;
  const additionalInfo = properties['AdditionalInfo'];
  if (typeof additionalInfo === 'string' && additionalInfo !== '') {
    out.AdditionalInfo = additionalInfo;
  }
  const ipv6Count = coerceCfnInteger(properties['Ipv6AddressCount']);
  if (ipv6Count !== undefined) out.Ipv6AddressCount = ipv6Count;
  const ipv6Addresses = properties['Ipv6Addresses'];
  if (Array.isArray(ipv6Addresses)) {
    out.Ipv6Addresses = ipv6Addresses.map((a) => ({
      Ipv6Address: (a as Record<string, unknown>)['Ipv6Address'] as string,
    }));
  }
  const dnsOptions = privateDnsNameOptionsRequest(properties['PrivateDnsNameOptions']);
  if (dnsOptions !== undefined) out.PrivateDnsNameOptions = dnsOptions;
  const launchTemplate = launchTemplateRequest(properties['LaunchTemplate']);
  if (launchTemplate !== undefined) out.LaunchTemplate = launchTemplate;
  const licenses = licenseSpecificationsRequest(properties['LicenseSpecifications']);
  if (licenses !== undefined) out.LicenseSpecifications = licenses;
  return out;
}

/** The {@link EC2Provider} methods this module defines. */
export const instanceBuildMethods = {
  buildBlockDeviceMappings,
  coerceBool,
  buildRunInstancesMonitoring,
  buildMetadataOptions,
  buildPlacement,
  buildNetworkInterfaces,
  buildEnaSrdSpecification,
  coerceNumber,
  buildCreditSpecification,
  readCpuCredits,
  buildLaunchOnlyInstanceOptions,
};
