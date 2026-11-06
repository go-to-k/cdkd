import type { EFSProvider } from '../efs-provider.js';
import {
  DescribeMountTargetsCommand,
  DescribeFileSystemsCommand,
  DescribeAccessPointsCommand,
  DescribeLifecycleConfigurationCommand,
  DescribeBackupPolicyCommand,
  DescribeMountTargetSecurityGroupsCommand,
  DescribeFileSystemPolicyCommand,
  FileSystemNotFound,
  MountTargetNotFound,
  AccessPointNotFound,
} from '@aws-sdk/client-efs';
import { definedAttributes } from '../../attribute-map.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../types/resource.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';

export async function readFileSystem(
  this: EFSProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let fs;
  let listed: readonly unknown[] | undefined;
  try {
    const resp = await this.getClient().send(
      new DescribeFileSystemsCommand({ FileSystemId: physicalId })
    );
    listed = resp.FileSystems;
    fs = resp.FileSystems?.[0];
  } catch (err) {
    if (err instanceof FileSystemNotFound) return RESOURCE_NOT_FOUND;
    throw err;
  }
  // An empty list for the requested id is AWS saying it is gone; an absent
  // list (empty body) keeps `undefined`.
  if (!fs) return listed?.length === 0 ? RESOURCE_NOT_FOUND : undefined;

  const result: Record<string, unknown> = {};
  if (fs.PerformanceMode !== undefined) result['PerformanceMode'] = fs.PerformanceMode;
  if (fs.ThroughputMode !== undefined) result['ThroughputMode'] = fs.ThroughputMode;
  if (fs.Encrypted !== undefined) result['Encrypted'] = fs.Encrypted;
  if (fs.KmsKeyId !== undefined) result['KmsKeyId'] = fs.KmsKeyId;
  if (fs.ProvisionedThroughputInMibps !== undefined) {
    result['ProvisionedThroughputInMibps'] = fs.ProvisionedThroughputInMibps;
  }
  // AvailabilityZoneName (One Zone EFS) and FileSystemProtection ride on the
  // same DescribeFileSystems response.
  if (fs.AvailabilityZoneName !== undefined) {
    result['AvailabilityZoneName'] = fs.AvailabilityZoneName;
  }
  if (fs.FileSystemProtection?.ReplicationOverwriteProtection !== undefined) {
    result['FileSystemProtection'] = {
      ReplicationOverwriteProtection: fs.FileSystemProtection.ReplicationOverwriteProtection,
    };
  }

  // LifecyclePolicies — separate call, "not configured" omits the key.
  try {
    const resp = await this.getClient().send(
      new DescribeLifecycleConfigurationCommand({ FileSystemId: physicalId })
    );
    const policies = resp.LifecyclePolicies ?? [];
    // Emit-when-present: only surface the key when AWS actually reports
    // lifecycle policies. An always-emitted `[]` placeholder would diverge
    // from every other backfilled prop's emit-when-present invariant and is
    // a latent footgun for a future drift --revert that diffs the other
    // direction (AWS snapshot -> template).
    if (policies.length > 0) {
      result['LifecyclePolicies'] = policies.map((p) => {
        const out: Record<string, unknown> = {};
        if (p.TransitionToIA !== undefined) out['TransitionToIA'] = p.TransitionToIA;
        if (p.TransitionToPrimaryStorageClass !== undefined) {
          out['TransitionToPrimaryStorageClass'] = p.TransitionToPrimaryStorageClass;
        }
        if (p.TransitionToArchive !== undefined) {
          out['TransitionToArchive'] = p.TransitionToArchive;
        }
        return out;
      });
    }
  } catch (err) {
    // "Not configured" is service-specific; FileSystemNotFound on this call
    // means the FS itself is gone between the two calls.
    if (err instanceof FileSystemNotFound) return RESOURCE_NOT_FOUND;
    // Other errors (e.g. PolicyNotFound, AccessDenied) — omit the key,
    // don't fail the whole snapshot.
    const e = err as { name?: string };
    if (e.name !== 'PolicyNotFound') {
      // Best-effort: log and continue. Drift comparator only descends into
      // keys present in state, so an absent key cannot fire false drift.
    }
  }

  // BackupPolicy — separate call, "not configured" omits the key.
  try {
    const resp = await this.getClient().send(
      new DescribeBackupPolicyCommand({ FileSystemId: physicalId })
    );
    if (resp.BackupPolicy?.Status !== undefined) {
      result['BackupPolicy'] = { Status: resp.BackupPolicy.Status };
    }
  } catch (err) {
    if (err instanceof FileSystemNotFound) return RESOURCE_NOT_FOUND;
    // PolicyNotFound or similar — omit the key.
  }

  // FileSystemPolicy — separate DescribeFileSystemPolicy call. AWS returns
  // the policy as a JSON string; the CFn property is a policy object, so
  // parse it back so the drift comparator compares object-to-object.
  // "PolicyNotFound" (no policy attached) omits the key.
  try {
    const resp = await this.getClient().send(
      new DescribeFileSystemPolicyCommand({ FileSystemId: physicalId })
    );
    if (resp.Policy !== undefined) {
      try {
        result['FileSystemPolicy'] = JSON.parse(resp.Policy);
      } catch {
        // Non-JSON policy string (should not happen) — surface verbatim.
        result['FileSystemPolicy'] = resp.Policy;
      }
    }
  } catch (err) {
    if (err instanceof FileSystemNotFound) return RESOURCE_NOT_FOUND;
    // PolicyNotFound or similar — omit the key.
  }

  // FileSystemTags from the same DescribeFileSystems response.
  const tags = normalizeAwsTagsToCfn(fs.Tags);
  result['FileSystemTags'] = tags;

  return result;
}

export async function readAccessPoint(
  this: EFSProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let ap;
  let listed: readonly unknown[] | undefined;
  try {
    const resp = await this.getClient().send(
      new DescribeAccessPointsCommand({ AccessPointId: physicalId })
    );
    listed = resp.AccessPoints;
    ap = resp.AccessPoints?.[0];
  } catch (err) {
    if (err instanceof AccessPointNotFound) return RESOURCE_NOT_FOUND;
    throw err;
  }
  // An empty list for the requested id is AWS saying it is gone; an absent
  // list (empty body) keeps `undefined`.
  if (!ap) return listed?.length === 0 ? RESOURCE_NOT_FOUND : undefined;

  const result: Record<string, unknown> = {};
  if (ap.FileSystemId !== undefined) result['FileSystemId'] = ap.FileSystemId;
  if (ap.PosixUser) {
    const posix: Record<string, unknown> = {};
    if (ap.PosixUser.Uid !== undefined) posix['Uid'] = ap.PosixUser.Uid;
    if (ap.PosixUser.Gid !== undefined) posix['Gid'] = ap.PosixUser.Gid;
    if (ap.PosixUser.SecondaryGids && ap.PosixUser.SecondaryGids.length > 0) {
      posix['SecondaryGids'] = [...ap.PosixUser.SecondaryGids];
    }
    if (Object.keys(posix).length > 0) result['PosixUser'] = posix;
  }
  if (ap.RootDirectory) {
    const root: Record<string, unknown> = {};
    if (ap.RootDirectory.Path !== undefined) root['Path'] = ap.RootDirectory.Path;
    if (ap.RootDirectory.CreationInfo) {
      const ci: Record<string, unknown> = {};
      if (ap.RootDirectory.CreationInfo.OwnerUid !== undefined) {
        ci['OwnerUid'] = ap.RootDirectory.CreationInfo.OwnerUid;
      }
      if (ap.RootDirectory.CreationInfo.OwnerGid !== undefined) {
        ci['OwnerGid'] = ap.RootDirectory.CreationInfo.OwnerGid;
      }
      if (ap.RootDirectory.CreationInfo.Permissions !== undefined) {
        ci['Permissions'] = ap.RootDirectory.CreationInfo.Permissions;
      }
      if (Object.keys(ci).length > 0) root['CreationInfo'] = ci;
    }
    if (Object.keys(root).length > 0) result['RootDirectory'] = root;
  }
  return result;
}

export async function readMountTarget(
  this: EFSProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let mt;
  let listed: readonly unknown[] | undefined;
  try {
    const resp = await this.getClient().send(
      new DescribeMountTargetsCommand({ MountTargetId: physicalId })
    );
    listed = resp.MountTargets;
    mt = resp.MountTargets?.[0];
  } catch (err) {
    if (err instanceof MountTargetNotFound) return RESOURCE_NOT_FOUND;
    throw err;
  }
  // An empty list for the requested id is AWS saying it is gone; an absent
  // list (empty body) keeps `undefined`.
  if (!mt) return listed?.length === 0 ? RESOURCE_NOT_FOUND : undefined;

  const result: Record<string, unknown> = {};
  if (mt.FileSystemId !== undefined) result['FileSystemId'] = mt.FileSystemId;
  if (mt.SubnetId !== undefined) result['SubnetId'] = mt.SubnetId;
  // go-to-k/cdkd#2762: the create-only addressing, emitted only when AWS
  // reports it (immutable on create, so no placeholder). DescribeMountTargets
  // carries no IpAddressType; it follows from which addresses the mount
  // target holds (measured us-east-1, 2026-10-27: IPV4_ONLY in a dual-stack
  // subnet holds only an IPv4 address, IPV6_ONLY only an IPv6 one, and
  // DUAL_STACK both). The addresses come back as declared, not canonicalised:
  // `Ipv6Address: 2600:1F18:...:0:0:0:50` reads back in that spelling (the
  // ENI itself reports `...::50`), and a leading-zero IPv4 is refused at
  // create (`invalid value for parameter address`), so neither needs a
  // spelling normaliser (measured us-east-1, 2026-10-27).
  if (mt.IpAddress !== undefined) result['IpAddress'] = mt.IpAddress;
  if (mt.Ipv6Address !== undefined) result['Ipv6Address'] = mt.Ipv6Address;
  if (mt.IpAddress !== undefined || mt.Ipv6Address !== undefined) {
    result['IpAddressType'] =
      mt.IpAddress === undefined
        ? 'IPV6_ONLY'
        : mt.Ipv6Address === undefined
          ? 'IPV4_ONLY'
          : 'DUAL_STACK';
  }

  // SecurityGroups via DescribeMountTargetSecurityGroups. Always-emit
  // `[]` placeholder when AWS reports none so a console-side ADD on a
  // previously-unconfigured mount target is detectable on the v3
  // observedProperties baseline.
  let securityGroups: string[] = [];
  try {
    const sgResp = await this.getClient().send(
      new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: physicalId })
    );
    securityGroups = (sgResp.SecurityGroups ?? []).filter(
      (s): s is string => typeof s === 'string'
    );
  } catch {
    // Best-effort.
  }
  result['SecurityGroups'] = securityGroups;

  return result;
}

export async function importFileSystem(
  this: EFSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      const resp = await this.getClient().send(
        new DescribeFileSystemsCommand({ FileSystemId: input.knownPhysicalId })
      );
      const fs = resp.FileSystems?.[0];
      return fs?.FileSystemId ? { physicalId: fs.FileSystemId, attributes: {} } : null;
    } catch (err) {
      if (err instanceof FileSystemNotFound) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources; a file system reaching here needs an explicit
  // `--resource` override.
  return null;
}

/**
 * Override-only. Reads the mount target so `Fn::GetAtt [MountTarget,
 * IpAddress]` resolves on an imported record and on one `create()` wrote
 * before it recorded the attribute (the stale-attribute heal reads through
 * here; go-to-k/cdkd#2762).
 */
export async function importMountTarget(
  this: EFSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (!input.knownPhysicalId) return null;
  let resp;
  try {
    resp = await this.getClient().send(
      new DescribeMountTargetsCommand({ MountTargetId: input.knownPhysicalId })
    );
  } catch (err) {
    if (err instanceof MountTargetNotFound) return null;
    throw err;
  }
  const mt = resp.MountTargets?.[0];
  return mt?.MountTargetId
    ? {
        physicalId: mt.MountTargetId,
        attributes: definedAttributes({ IpAddress: mt.IpAddress }),
      }
    : null;
}

export async function importAccessPoint(
  this: EFSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      const resp = await this.getClient().send(
        new DescribeAccessPointsCommand({ AccessPointId: input.knownPhysicalId })
      );
      const ap = resp.AccessPoints?.[0];
      // Issue #3627: the same map `create()` records; the physical id is
      // `fsap-...`, so without `Arn` the resolver's shape guard refused
      // `Fn::GetAtt [AccessPoint, Arn]`.
      return ap?.AccessPointId
        ? {
            physicalId: ap.AccessPointId,
            attributes: definedAttributes({
              Arn: ap.AccessPointArn,
              AccessPointId: ap.AccessPointId,
            }),
          }
        : null;
    } catch (err) {
      if (err instanceof AccessPointNotFound) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk (issue #1134): the tag can never exist on a
  // real resource, so the walk could not match. An access point reaching
  // here needs an explicit `--resource` override.
  return null;
}
