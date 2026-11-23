import type { EMRClusterProvider } from '../emr-cluster-provider.js';
import { isPermissionDenial } from '../../identity-read-denied.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  DescribeClusterCommand,
  GetAutoTerminationPolicyCommand,
  GetManagedScalingPolicyCommand,
  ListInstanceGroupsCommand,
  ListInstanceFleetsCommand,
  InvalidRequestException,
  type Cluster,
  type InstanceGroup,
  type InstanceFleet,
} from '@aws-sdk/client-emr';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../../import-helpers.js';
import {
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
  type ResourceIdentityVerdict,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import { TERMINAL_STATES, CLUSTER_ID_PATTERN } from './shared.js';

export function buildAttributes(
  this: EMRClusterProvider,
  cluster: Cluster | undefined
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  if (cluster?.Id !== undefined) attributes['Id'] = cluster.Id;
  if (cluster?.MasterPublicDnsName !== undefined) {
    attributes['MasterPublicDNS'] = cluster.MasterPublicDnsName;
  }
  return attributes;
}

export async function getAttribute(
  this: EMRClusterProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'Id') return physicalId;

  const response = await this.getClient().send(
    new DescribeClusterCommand({ ClusterId: physicalId })
  );
  const cluster = response.Cluster;
  if (!cluster) return undefined;

  switch (attributeName) {
    case 'MasterPublicDNS':
      return cluster.MasterPublicDnsName;
    default:
      return undefined;
  }
}

/**
 * go-to-k/cdkd#4606: whether the cluster a failed CREATE journaled (one whose
 * own terminate failed) is the one the record under the same logical id holds
 * — a fix-forward that created a new cluster there.
 *
 * The identity is the `j-…` id `RunJobFlow` mints: unique per account and
 * region and never reassigned, so two distinct ids in the stack's region name
 * two distinct clusters. Any other id form is `'unknown'`; equal ids are
 * `'same'` without a read. After the region check, `DescribeCluster` must
 * read the record's cluster back under its own id, in any state: the same
 * client then proves it is in the stack's account and region, and a
 * transient cluster (no `KeepJobFlowAliveWhenNoSteps`, an idle
 * `AutoTerminationPolicy`) may already be terminating by the settle. A
 * record cluster EMR does not know, or one reading back as another id, is
 * `'unknown'`. The journaled cluster is then `'different'`, whether it reads back in any
 * state (a `TERMINATED_WITH_ERRORS` one included: the settle's delete names
 * it already terminated) or EMR answers `InvalidRequestException` for it;
 * only a read naming the record's cluster makes it `'same'`. Any other
 * failure throws, which the caller reads as `'unknown'`.
 */
export async function isSameResource(
  this: EMRClusterProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== 'AWS::EMR::Cluster') return 'unknown';
  if (
    !CLUSTER_ID_PATTERN.test(journaledPhysicalId) ||
    !CLUSTER_ID_PATTERN.test(record.physicalId)
  ) {
    return 'unknown';
  }
  if (journaledPhysicalId === record.physicalId) return 'same';
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recorded = await this.readClusterIdentity(record.physicalId);
  if (recorded?.id !== record.physicalId) return 'unknown';
  const journaled = await this.readClusterIdentity(journaledPhysicalId);
  return journaled?.id === recorded.id ? 'same' : 'different';
}

/**
 * The id `DescribeCluster` reports for `clusterId`, or `undefined`
 * on `InvalidRequestException` (EMR's answer for an id it does not know).
 * Any other failure, and a response naming no cluster, throws: "could not
 * read" never reads as "gone".
 */
export async function readClusterIdentity(
  this: EMRClusterProvider,
  clusterId: string
): Promise<{ id: string } | undefined> {
  let response;
  try {
    response = await this.getClient().send(new DescribeClusterCommand({ ClusterId: clusterId }));
  } catch (error) {
    if (error instanceof InvalidRequestException) return undefined;
    throw error;
  }
  const id = response.Cluster?.Id;
  if (typeof id !== 'string') {
    throw new Error('DescribeCluster did not return the cluster asked for');
  }
  return { id };
}

/**
 * Adopt an existing EMR cluster into cdkd state.
 *
 * Lookup order:
 *  1. `--resource <logicalId>=j-XXXX` override (`knownPhysicalId`) → verify
 *     via `DescribeCluster`. There is no template name property that equals
 *     the physical id — a cluster's id (`j-...`) is service-generated, while
 *     the template `Name` is only the display name — so no name fallback
 *     applies (`resolveExplicitPhysicalId(..., null)`).
 */
export async function importImpl(
  this: EMRClusterProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, null);
  if (explicit) {
    const cluster = await this.describeClusterOrUndefined(explicit);
    // A cluster that has aged out of DescribeCluster (returns null) or that
    // is already terminated is not adoptable — report not-found so the
    // import command marks it skipped rather than writing dead state.
    if (!cluster || (cluster.Status?.State && TERMINAL_STATES.has(cluster.Status.State))) {
      return null;
    }
    return { physicalId: explicit, attributes: this.buildAttributes(cluster) };
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
  // tag never exists on a real resource and the walk could not match (issue
  // #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a
  // cluster reaching here needs an explicit `--resource` override.
  return null;
}

/**
 * `DescribeCluster` that maps a not-found (`InvalidRequestException` — the
 * cluster id is unknown in this region / aged out of Describe) to
 * `undefined` instead of throwing, so `import()` can treat it as "no match"
 * rather than aborting the whole adoption run. Also consumed by
 * `readCurrentState` for the same gone-cluster tolerance.
 *
 * Note the mapping is BROAD — `InvalidRequestException` covers more than
 * not-found, so a genuine failure here degrades to "no match" and a
 * subsequent deploy would CREATE a duplicate cluster rather than adopt the
 * existing one. Narrowing the mapping needs a message/code-level
 * discriminator AWS does not currently document.
 */
export async function describeClusterOrUndefined(
  this: EMRClusterProvider,
  clusterId: string
): Promise<Cluster | undefined> {
  try {
    const resp = await this.getClient().send(new DescribeClusterCommand({ ClusterId: clusterId }));
    return resp.Cluster;
  } catch (err) {
    if (err instanceof InvalidRequestException) return undefined;
    throw err;
  }
}

/**
 * Read the currently-deployed properties for `cdkd drift` and to seed the
 * `observedProperties` baseline right after `cdkd import`.
 *
 * The bulk of the work is reversing the flatten that `create()` applies to
 * the CFn `Instances` block: `DescribeCluster` reports the cluster's
 * `InstanceCollectionType`, and the instance groups / fleets themselves come
 * from `ListInstanceGroups` / `ListInstanceFleets` as FLAT arrays with a
 * per-entry `InstanceGroupType` / `InstanceFleetType` discriminator — the
 * exact inverse of the role-keyed CFn `MasterInstanceGroup` /
 * `CoreInstanceGroup` / `TaskInstanceGroups` (+ `*InstanceFleet(s)`) shape.
 * `reverseInstancesToCfn` re-buckets them and folds in the flat
 * `Ec2InstanceAttributes` (subnet / key name / security groups).
 *
 * Scope: the reversible property set — the reverse-mapped `Instances` block,
 * `Tags` (via `normalizeAwsTagsToCfn`, `aws:*` stripped), and the top-level
 * scalar fields `DescribeCluster` returns directly. `AutoTerminationPolicy`
 * and `ManagedScalingPolicy` (go-to-k/cdkd#6854) are read with their own
 * `Get*` call, each only when the template declares it (the comparison skips
 * an undeclared one), alongside the instance list read. Create-only sub-config
 * that AWS does not read back faithfully (`BootstrapActions` / `Steps`
 * / `KerberosAttributes` / `Configurations` nesting / `AdditionalInfo` /
 * `PlacementGroupConfigs`; `Instances` EBS / auto-scaling sub-specs) is
 * declared in `getDriftUnknownPaths` so the drift comparator skips it on the
 * `properties`-fallback path instead of firing a guaranteed false positive.
 * On the normal path the baseline is `observedProperties` (captured via this
 * same method), so observed == current and there is no phantom drift.
 *
 * Returns `RESOURCE_NOT_FOUND` for a `TERMINATED*` cluster (the state
 * `delete` and `import` already read as gone). An `InvalidRequestException`
 * stays `undefined` (drift-unknown): EMR uses it for more than an unknown id,
 * so it is not evidence the cluster is gone.
 */
export async function readCurrentState(
  this: EMRClusterProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const cluster = await this.describeClusterOrUndefined(physicalId);
  if (!cluster) return undefined;
  if (cluster.Status?.State && TERMINAL_STATES.has(cluster.Status.State)) {
    return RESOURCE_NOT_FOUND;
  }

  let instanceGroups: InstanceGroup[] = [];
  let instanceFleets: InstanceFleet[] = [];
  const declares = (key: string): boolean => properties?.[key] != null;
  let policies: Record<string, unknown>;
  try {
    [, policies] = await Promise.all([
      cluster.InstanceCollectionType === 'INSTANCE_FLEET'
        ? this.listInstanceFleets(physicalId).then((fleets) => {
            instanceFleets = fleets;
          })
        : this.listInstanceGroups(physicalId).then((groups) => {
            instanceGroups = groups;
          }),
      readDeclaredPolicies.call(this, physicalId, {
        autoTermination: declares('AutoTerminationPolicy'),
        managedScaling: declares('ManagedScalingPolicy'),
      }),
    ]);
  } catch (err) {
    // The cluster left between the Describe and these reads: the same
    // drift-unknown answer `describeClusterOrUndefined` gives.
    if (err instanceof InvalidRequestException) return undefined;
    throw err;
  }

  const out: Record<string, unknown> = {
    Name: cluster.Name ?? '',
    ReleaseLabel: cluster.ReleaseLabel ?? '',
    ServiceRole: cluster.ServiceRole ?? '',
    LogUri: cluster.LogUri ?? '',
    LogEncryptionKmsKeyId: cluster.LogEncryptionKmsKeyId ?? '',
    AutoScalingRole: cluster.AutoScalingRole ?? '',
    ScaleDownBehavior: cluster.ScaleDownBehavior ?? '',
    CustomAmiId: cluster.CustomAmiId ?? '',
    OSReleaseLabel: cluster.OSReleaseLabel ?? '',
    SecurityConfiguration: cluster.SecurityConfiguration ?? '',
    EbsRootVolumeSize: cluster.EbsRootVolumeSize,
    EbsRootVolumeIops: cluster.EbsRootVolumeIops,
    EbsRootVolumeThroughput: cluster.EbsRootVolumeThroughput,
    StepConcurrencyLevel: cluster.StepConcurrencyLevel,
    VisibleToAllUsers: cluster.VisibleToAllUsers ?? false,
    JobFlowRole: cluster.Ec2InstanceAttributes?.IamInstanceProfile ?? '',
    Applications: cluster.Applications ?? [],
    Tags: normalizeAwsTagsToCfn(cluster.Tags),
    Instances: this.reverseInstancesToCfn(cluster, instanceGroups, instanceFleets),
    ...policies,
  };
  // go-to-k/cdkd#5824: emitted only when DescribeCluster reports them (a
  // declared response field is not a populated one), and skipped by the
  // comparator (`getDriftUnknownPaths`).
  if (typeof cluster.SessionEnabled === 'boolean') out['SessionEnabled'] = cluster.SessionEnabled;
  const cw = cluster.MonitoringConfiguration?.CloudWatchLogConfiguration;
  if (cw) {
    out['MonitoringConfiguration'] = {
      CloudWatchLogConfiguration: Object.fromEntries(
        Object.entries({
          Enabled: cw.Enabled,
          LogGroupName: cw.LogGroupName,
          LogStreamNamePrefix: cw.LogStreamNamePrefix,
          EncryptionKeyArn: cw.EncryptionKeyArn,
          LogTypes: cw.LogTypes,
        }).filter(([, v]) => v !== undefined)
      ),
    };
  }
  return out;
}

const POLICY_KEYS = ['AutoTerminationPolicy', 'ManagedScalingPolicy'] as const;

/**
 * The unsettled-update read (go-to-k/cdkd#6854): `readCurrentState` with each
 * unsettled policy read whether or not the record declares it, its removed
 * spelling (`{}`) reported as absent, and a FAILURE when an unsettled
 * policy's `Get*Policy` could not be read. The convergence would otherwise
 * take the missing key as "the cluster holds no policy", and a template that
 * also omits it would skip the Remove while the record calls it settled.
 */
export async function readUnsettled(
  this: EMRClusterProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>,
  recordedProperties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const wanted = POLICY_KEYS.filter((key) => names.has(key));
  const properties: Record<string, unknown> = { ...recordedProperties };
  for (const key of wanted) if (properties[key] == null) properties[key] = {};
  const live = await this.readCurrentState(physicalId, logicalId, resourceType, properties);
  if (live === undefined || live === RESOURCE_NOT_FOUND) return live;
  const out = { ...live };
  for (const key of wanted) {
    if (!Object.hasOwn(out, key)) {
      throw new Error(`the ${key} of EMR cluster ${logicalId} could not be read`);
    }
    const value = out[key];
    if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) {
      delete out[key];
    }
  }
  return out;
}

/**
 * go-to-k/cdkd#6854: the cluster's `AutoTerminationPolicy` /
 * `ManagedScalingPolicy`, each read only when asked for. EMR returns each as
 * it was put, with no member filled in, and an empty answer once removed
 * (measured us-east-1, 2026-11-23: `IdleTimeout`, and `ComputeLimits` with
 * and without the optional limits, `ScalingStrategy` and
 * `UtilizationPerformanceIndex`). An empty answer emits the key as `{}`, so a
 * declared policy removed out of band reads as removed (and a revert's
 * previous side holds no policy, so `update()` puts it back).
 *
 * A read that fails for any reason but a gone cluster (a denied
 * `elasticmapreduce:Get*Policy`, a throttle) leaves only that key out, with a
 * warning naming the error class: the rest of the readback stands, and
 * `canonicalizeDriftPair` leaves the key uncompared on that read.
 */
async function readDeclaredPolicies(
  this: EMRClusterProvider,
  clusterId: string,
  wanted: { autoTermination: boolean; managedScaling: boolean }
): Promise<Record<string, unknown>> {
  const readOne = <T extends object>(
    key: string,
    action: string,
    send: () => Promise<T | undefined>
  ): Promise<{ value: T | undefined } | undefined> =>
    send().then(
      (value) => ({ value }),
      (err: unknown) => {
        // The cluster left between the Describe and this read: fail the read.
        if (err instanceof InvalidRequestException) throw err;
        const name = (err as { name?: unknown } | null)?.name;
        const errorClass =
          typeof name === 'string' && /^[A-Za-z0-9]{1,64}$/.test(name) ? name : 'an error';
        const hint = isPermissionDenial(err) ? `; allow elasticmapreduce:${action}` : '';
        this.logger.warn(
          safeMsg`EMR cluster ${clusterId}: ${key} not read (${errorClass}${hint}).`
        );
        return undefined;
      }
    );
  const [autoTermination, managedScaling] = await Promise.all([
    wanted.autoTermination
      ? readOne('AutoTerminationPolicy', 'GetAutoTerminationPolicy', () =>
          this.getClient()
            .send(new GetAutoTerminationPolicyCommand({ ClusterId: clusterId }))
            .then((resp) => resp.AutoTerminationPolicy)
        )
      : Promise.resolve(undefined),
    wanted.managedScaling
      ? readOne('ManagedScalingPolicy', 'GetManagedScalingPolicy', () =>
          this.getClient()
            .send(new GetManagedScalingPolicyCommand({ ClusterId: clusterId }))
            .then((resp) => resp.ManagedScalingPolicy)
        )
      : Promise.resolve(undefined),
  ]);
  const out: Record<string, unknown> = {};
  if (autoTermination !== undefined) {
    out['AutoTerminationPolicy'] = structuredClone(autoTermination.value ?? {});
  }
  if (managedScaling !== undefined) {
    out['ManagedScalingPolicy'] = structuredClone(managedScaling.value ?? {});
  }
  return out;
}

export async function listInstanceGroups(
  this: EMRClusterProvider,
  clusterId: string
): Promise<InstanceGroup[]> {
  const groups: InstanceGroup[] = [];
  let marker: string | undefined;
  do {
    const resp = await this.getClient().send(
      new ListInstanceGroupsCommand({ ClusterId: clusterId, ...(marker && { Marker: marker }) })
    );
    groups.push(...(resp.InstanceGroups ?? []));
    marker = resp.Marker;
  } while (marker);
  return groups;
}

export async function listInstanceFleets(
  this: EMRClusterProvider,
  clusterId: string
): Promise<InstanceFleet[]> {
  const fleets: InstanceFleet[] = [];
  let marker: string | undefined;
  do {
    const resp = await this.getClient().send(
      new ListInstanceFleetsCommand({ ClusterId: clusterId, ...(marker && { Marker: marker }) })
    );
    fleets.push(...(resp.InstanceFleets ?? []));
    marker = resp.Marker;
  } while (marker);
  return fleets;
}

/**
 * Reverse of `toJobFlowInstancesConfig` — re-bucket the flat SDK
 * `InstanceGroup[]` / `InstanceFleet[]` (each carrying a role discriminator)
 * back into the role-keyed CFn `Instances` shape, and fold in the flat
 * `Ec2InstanceAttributes` (subnet / key name / security groups).
 *
 * Only the primary topology fields per group / fleet are reversed (role,
 * type, count / capacity, market, bid price, name, custom AMI). Lossy
 * sub-specs (EBS block-device / auto-scaling for groups; per-instance-type
 * specs for fleets) are intentionally NOT reconstructed — they are covered
 * by the drift baseline being `observedProperties` on the normal path.
 */
export function reverseInstancesToCfn(
  this: EMRClusterProvider,
  cluster: Cluster,
  instanceGroups: InstanceGroup[],
  instanceFleets: InstanceFleet[]
): Record<string, unknown> {
  const ec2 = cluster.Ec2InstanceAttributes;
  const instances: Record<string, unknown> = {};

  const taskGroups: Record<string, unknown>[] = [];
  for (const g of instanceGroups) {
    const cfn = this.reverseInstanceGroup(g);
    switch (g.InstanceGroupType) {
      case 'MASTER':
        instances['MasterInstanceGroup'] = cfn;
        break;
      case 'CORE':
        instances['CoreInstanceGroup'] = cfn;
        break;
      case 'TASK':
        taskGroups.push(cfn);
        break;
    }
  }
  if (taskGroups.length > 0) instances['TaskInstanceGroups'] = taskGroups;

  const taskFleets: Record<string, unknown>[] = [];
  for (const f of instanceFleets) {
    const cfn = this.reverseInstanceFleet(f);
    switch (f.InstanceFleetType) {
      case 'MASTER':
        instances['MasterInstanceFleet'] = cfn;
        break;
      case 'CORE':
        instances['CoreInstanceFleet'] = cfn;
        break;
      case 'TASK':
        taskFleets.push(cfn);
        break;
    }
  }
  if (taskFleets.length > 0) instances['TaskInstanceFleets'] = taskFleets;

  if (ec2?.Ec2KeyName !== undefined) instances['Ec2KeyName'] = ec2.Ec2KeyName;
  if (ec2?.Ec2SubnetId !== undefined) instances['Ec2SubnetId'] = ec2.Ec2SubnetId;
  if (ec2?.RequestedEc2SubnetIds !== undefined) {
    instances['Ec2SubnetIds'] = ec2.RequestedEc2SubnetIds;
  }
  if (ec2?.EmrManagedMasterSecurityGroup !== undefined) {
    instances['EmrManagedMasterSecurityGroup'] = ec2.EmrManagedMasterSecurityGroup;
  }
  if (ec2?.EmrManagedSlaveSecurityGroup !== undefined) {
    instances['EmrManagedSlaveSecurityGroup'] = ec2.EmrManagedSlaveSecurityGroup;
  }
  if (ec2?.ServiceAccessSecurityGroup !== undefined) {
    instances['ServiceAccessSecurityGroup'] = ec2.ServiceAccessSecurityGroup;
  }
  if (ec2?.AdditionalMasterSecurityGroups !== undefined) {
    instances['AdditionalMasterSecurityGroups'] = ec2.AdditionalMasterSecurityGroups;
  }
  if (ec2?.AdditionalSlaveSecurityGroups !== undefined) {
    instances['AdditionalSlaveSecurityGroups'] = ec2.AdditionalSlaveSecurityGroups;
  }
  if (cluster.TerminationProtected !== undefined) {
    instances['TerminationProtected'] = cluster.TerminationProtected;
  }
  if (cluster.UnhealthyNodeReplacement !== undefined) {
    instances['UnhealthyNodeReplacement'] = cluster.UnhealthyNodeReplacement;
  }

  return instances;
}

export function reverseInstanceGroup(
  this: EMRClusterProvider,
  g: InstanceGroup
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    InstanceType: g.InstanceType ?? '',
    // CFn's `InstanceCount` maps to the requested (not running) count so a
    // mid-resize read does not report transient drift.
    InstanceCount: g.RequestedInstanceCount ?? 0,
  };
  if (g.Name !== undefined) out['Name'] = g.Name;
  if (g.Market !== undefined) out['Market'] = g.Market;
  if (g.BidPrice !== undefined) out['BidPrice'] = g.BidPrice;
  if (g.CustomAmiId !== undefined) out['CustomAmiId'] = g.CustomAmiId;
  return out;
}

export function reverseInstanceFleet(
  this: EMRClusterProvider,
  f: InstanceFleet
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.Name !== undefined) out['Name'] = f.Name;
  if (f.TargetOnDemandCapacity !== undefined) {
    out['TargetOnDemandCapacity'] = f.TargetOnDemandCapacity;
  }
  if (f.TargetSpotCapacity !== undefined) out['TargetSpotCapacity'] = f.TargetSpotCapacity;
  return out;
}
