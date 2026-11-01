import {
  NeptuneClient,
  CreateDBClusterCommand,
  DeleteDBClusterCommand,
  ModifyDBClusterCommand,
  DescribeDBClustersCommand,
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  ModifyDBInstanceCommand,
  DescribeDBInstancesCommand,
  CreateDBSubnetGroupCommand,
  DeleteDBSubnetGroupCommand,
  DescribeDBSubnetGroupsCommand,
  ModifyDBSubnetGroupCommand,
  ListTagsForResourceCommand,
  AddTagsToResourceCommand,
  AddRoleToDBClusterCommand,
  RemoveRoleFromDBClusterCommand,
  RemoveTagsFromResourceCommand,
  type DBCluster,
  type DBClusterRole,
} from '@aws-sdk/client-neptune';
import { DescribeSecurityGroupsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { isDeepStrictEqual } from 'node:util';
import { getLogger } from '../../utils/logger.js';
import { markNotGone } from '../not-gone.js';
import { enclosingDeadlineRemainingMs } from '../../deployment/resource-deadline.js';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { reportCreatedResource } from '../created-resource-sink.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generatedNameFor } from '../resource-name.js';
import { clearOnUpdateRemoval, removedTemplateKeys } from '../update-removal.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import type {
  ResourceProvider,
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceIdentityVerdict,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { definedAttributes, stringifyIfAssigned } from '../attribute-map.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { safeMsg } from '../../utils/display-safe.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import {
  ProtectionFlipRegistry,
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  rdsFamilyProtectionSite,
  type ProtectionFlipRecord,
  deleteAfterProtectionFlipWithFinalSnapshot,
  isTerminalDbWaitStatus,
} from './deletion-protection-compensation.js';
import { modifyDbInstanceWhenAvailable } from './db-instance-modify-retry.js';
import { maskerOrIdentity } from '../masked-retry-logger.js';
import { coerceCfnBoolean, configBooleanRefusal } from '../config-shape.js';
import { isUsableAttemptedName } from '../../state/unsettled-properties.js';

/**
 * The attribute map a Neptune DB cluster records (issue #3650), under
 * CloudFormation's `Fn::GetAtt` names (`Endpoint`, `Port`, `ReadEndpoint`,
 * `ClusterResourceId`). The RDS-style dotted keys (`Endpoint.Address`, ...)
 * are kept for records and readers that already use them; no
 * `Fn::GetAtt` names them for this service, so on their own they left
 * `Fn::GetAtt [Cluster, Endpoint]` resolving to the cluster identifier.
 */
function clusterAttributes(
  cluster:
    | {
        Endpoint?: string | undefined;
        Port?: number | undefined;
        ReaderEndpoint?: string | undefined;
        DBClusterArn?: string | undefined;
        DbClusterResourceId?: string | undefined;
      }
    | undefined
): Record<string, unknown> {
  return definedAttributes({
    Endpoint: cluster?.Endpoint,
    Port: stringifyIfAssigned(cluster?.Port),
    ReadEndpoint: cluster?.ReaderEndpoint,
    'Endpoint.Address': cluster?.Endpoint,
    'Endpoint.Port': stringifyIfAssigned(cluster?.Port),
    'ReadEndpoint.Address': cluster?.ReaderEndpoint,
    ClusterResourceId: cluster?.DbClusterResourceId,
  });
}

/**
 * The attribute map a Neptune DB instance records (issue #3650): `Endpoint` /
 * `Port` are CloudFormation's `Fn::GetAtt` names, the dotted keys are kept.
 */
function instanceAttributes(
  instance:
    | {
        Endpoint?: { Address?: string | undefined; Port?: number | undefined } | undefined;
        DBInstanceArn?: string | undefined;
      }
    | undefined
): Record<string, unknown> {
  return definedAttributes({
    Endpoint: instance?.Endpoint?.Address,
    Port: stringifyIfAssigned(instance?.Endpoint?.Port),
    'Endpoint.Address': instance?.Endpoint?.Address,
    'Endpoint.Port': stringifyIfAssigned(instance?.Endpoint?.Port),
    Arn: instance?.DBInstanceArn,
  });
}

/**
 * A DB cluster or DB instance identifier: a letter, then letters, digits and
 * single hyphens, not ending in one, at most 63 characters. Either case, as a
 * template may spell it (Neptune lower-cases it).
 */
function isDbIdentifier(id: string): boolean {
  return id.length <= 63 && /^[A-Za-z](?:-?[A-Za-z0-9])*$/.test(id);
}

/**
 * DBCluster properties CloudFormation KEEPS at their live value when the
 * template drops them (ModifyDBCluster merges, and CloudFormation sends
 * nothing for them), so `update()` sends nothing either and names them in a
 * warning. Measured by real CloudFormation A/Bs in us-east-1:
 *
 * - #5004: `DeletionProtection`, `IamAuthEnabled`, `BackupRetentionPeriod`.
 * - #1160: `DBPort` (8183 stayed 8183, not the 8182 default); `Port` is its
 *   legacy spelling.
 * - #5544 (2026-10-30): engine 1.4.7.0 (default 1.4.8.0), backup window
 *   `03:00-03:30`, maintenance window `sun:05:00-sun:05:30` and a custom
 *   cluster parameter group, all dropped at once, alone and beside a
 *   `BackupRetentionPeriod` 7 -> 8 change: every one read back unchanged for
 *   nine minutes (the version not upgraded, the group not moved back to
 *   `default.neptune1.4`), while the companion change applied.
 * - #2762: `CopyTagsToSnapshot` (true stayed true, read at once and after four
 *   minutes).
 */
const CLUSTER_KEPT_ON_REMOVAL = [
  'EngineVersion',
  'PreferredBackupWindow',
  'PreferredMaintenanceWindow',
  'DBClusterParameterGroupName',
  'DeletionProtection',
  'IamAuthEnabled',
  'BackupRetentionPeriod',
  'DBPort',
  'Port',
  'CopyTagsToSnapshot',
] as const;

/**
 * DBInstance properties CloudFormation KEEPS on removal (see
 * {@link CLUSTER_KEPT_ON_REMOVAL}): `AutoMinorVersionUpgrade` (#5004), and
 * (#5544, the same A/B) a custom `DBParameterGroupName`, which stayed
 * attached and `in-sync`, and a maintenance window `mon:06:00-mon:06:30`,
 * beside an `AutoMinorVersionUpgrade` true -> false change that applied.
 */
const INSTANCE_KEPT_ON_REMOVAL = [
  'DBParameterGroupName',
  'PreferredMaintenanceWindow',
  'AutoMinorVersionUpgrade',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `DBClusterRole` entry of the template's `AssociatedRoles`. */
interface ClusterRole {
  RoleArn: string;
  FeatureName?: string;
}

/** One association's identity: AWS keys an association on the role AND the feature. */
function clusterRoleKey(role: {
  RoleArn?: string | undefined;
  FeatureName?: string | undefined;
}): string {
  return `${role.RoleArn ?? ''}\n${role.FeatureName ?? ''}`;
}

/**
 * `AssociatedRoles` as a list, or `undefined` when it is unusable: the gap
 * between the two sides is what gets DETACHED, so a malformed desired value
 * must never read as empty (`.claude/rules/provider-aws-response-reads.md`).
 * Absent or `null` is the empty list. A repeated entry collapses: AWS would
 * refuse the second attach as already there.
 */
function clusterRoleList(value: unknown): ClusterRole[] | undefined {
  if (value == null) return [];
  if (!Array.isArray(value)) return undefined;
  const roles = new Map<string, ClusterRole>();
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry)) return undefined;
    const { RoleArn: roleArn, FeatureName: featureName } = entry;
    if (typeof roleArn !== 'string' || roleArn === '') return undefined;
    if (featureName != null && typeof featureName !== 'string') return undefined;
    const role = { RoleArn: roleArn, ...(featureName ? { FeatureName: featureName } : {}) };
    roles.set(clusterRoleKey(role), role);
  }
  return [...roles.values()];
}

/** A list of strings, or `undefined` when unusable; absent or `null` is empty. */
function stringList(value: unknown): string[] | undefined {
  if (value == null) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}

/**
 * The ModifyDBCluster `CloudwatchLogsExportConfiguration` taking the cluster
 * from `previous` to `desired`, or `undefined` when they name the same types.
 * ModifyDBCluster takes a delta where CreateDBCluster takes the list.
 */
function logExportChange(
  desired: readonly string[],
  previous: readonly string[]
): { EnableLogTypes?: string[]; DisableLogTypes?: string[] } | undefined {
  const enable = desired.filter((type) => !previous.includes(type));
  const disable = previous.filter((type) => !desired.includes(type));
  if (enable.length === 0 && disable.length === 0) return undefined;
  return {
    ...(enable.length > 0 && { EnableLogTypes: enable }),
    ...(disable.length > 0 && { DisableLogTypes: disable }),
  };
}

/**
 * The SDK's `ServerlessV2ScalingConfiguration` for the template's
 * `ServerlessScalingConfiguration`: `undefined` when absent, `null` when the
 * block is unusable. The schema requires both capacities, and a CFn number may
 * arrive as a numeric string; anything else is no capacity (`Number` would read
 * `''` as 0 and `true` as 1, and send a value nobody declared).
 */
function serverlessScalingToSend(
  value: unknown
): { MinCapacity: number; MaxCapacity: number } | null | undefined {
  if (value == null) return undefined;
  if (!isPlainObject(value)) return null;
  const min = cfnCapacity(value['MinCapacity']);
  const max = cfnCapacity(value['MaxCapacity']);
  if (min === undefined || max === undefined) return null;
  return { MinCapacity: min, MaxCapacity: max };
}

function cfnCapacity(value: unknown): number | undefined {
  const usable = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  const capacity = usable ? Number(value) : Number.NaN;
  return Number.isFinite(capacity) ? capacity : undefined;
}

/**
 * Whether a change of `EngineVersion` crosses a Neptune major version (the
 * first two segments: 1.3 -> 1.4). Unknown when either side is not a string.
 */
function isMajorEngineChange(previous: unknown, desired: unknown): boolean {
  if (typeof previous !== 'string' || typeof desired !== 'string') return false;
  const major = (version: string): string => version.split('.').slice(0, 2).join('.');
  return major(previous) !== major(desired);
}

/** How long an accepted change (a role, a log type, ...) is waited on before a warning. */
const SETTLE_MAX_WAIT_MS = 300_000;

/** The longest role changes wait for the cluster to read `available`. */
const ROLE_AVAILABLE_MAX_WAIT_MS = 1_800_000;

/** Budget kept back from the enclosing resource deadline. */
const DEADLINE_MARGIN_MS = 30_000;

/**
 * The top-level properties a ModifyDBCluster / ModifyDBInstance carries: a
 * change to one is in flight once the call is accepted, whatever fails later.
 */
const CLUSTER_MODIFY_KEYS = [
  'EngineVersion',
  'DeletionProtection',
  'BackupRetentionPeriod',
  'PreferredBackupWindow',
  'PreferredMaintenanceWindow',
  'DBClusterParameterGroupName',
  'IamAuthEnabled',
  'VpcSecurityGroupIds',
  'DBPort',
  'Port',
  'CopyTagsToSnapshot',
  'NetworkType',
  'ServerlessScalingConfiguration',
  'EnableCloudwatchLogsExports',
] as const;
const INSTANCE_MODIFY_KEYS = [
  'DBInstanceClass',
  'DBParameterGroupName',
  'PreferredMaintenanceWindow',
  'AutoMinorVersionUpgrade',
  'DeletionProtection',
  'PubliclyAccessible',
] as const;

/** go-to-k/cdkd#5380: mark each of `keys` the update changes, just before the call. */
function markChangedUnsettled(
  keys: readonly string[],
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): void {
  for (const key of keys) {
    if (!isDeepStrictEqual(properties[key], previousProperties[key])) {
      context?.markUnsettled?.(key);
    }
  }
}

/**
 * Properties `update()` leaves at the live value when the template drops them
 * (ModifyDB* keeps a setting it is not sent) but whose CloudFormation
 * behaviour no A/B has measured yet (go-to-k/cdkd#2762), so the warning names
 * them without claiming parity.
 */
const CLUSTER_UNMEASURED_ON_REMOVAL = ['NetworkType', 'ServerlessScalingConfiguration'] as const;

/**
 * AWS Neptune Provider
 *
 * Implements resource provisioning for Neptune resources:
 * - AWS::Neptune::DBSubnetGroup
 * - AWS::Neptune::DBCluster
 * - AWS::Neptune::DBInstance
 *
 * WHY a dedicated SDK provider (instead of CC API fallback):
 *   1. Owns the `--remove-protection` flip-off for both
 *      `AWS::Neptune::DBCluster` and `AWS::Neptune::DBInstance` —
 *      Neptune's API exposes `DeletionProtection: boolean` on both
 *      shapes (unlike DocDB, where only the cluster has it). The
 *      bypass logic lives in per-type SDK providers, not in
 *      `cloud-control-provider.ts`.
 *   2. Direct SDK calls avoid CC API polling overhead. Cluster /
 *      instance creation still takes time, so we poll
 *      `DescribeDBClusters` / `DescribeDBInstances` until status flips
 *      to `available`.
 *
 * Neptune's API shapes mirror the RDS API exactly (the AWS team copied
 * them across); see `rds-provider.ts` for the structural template.
 */
export class NeptuneProvider implements ResourceProvider {
  private neptuneClient?: NeptuneClient;
  private createClient?: NeptuneClient;
  private ec2Client?: EC2Client;
  private readonly providerRegion: string | undefined;
  private logger = getLogger().child('NeptuneProvider');
  /**
   * What a `--remove-protection` flip did, per resource, across the outer
   * retry loop's re-entries (issue #2204; the mechanism is
   * `./deletion-protection-compensation.ts`).
   */
  private readonly protectionFlips = new ProtectionFlipRegistry();

  /**
   * `removalDefaults` is deliberately empty (issue #5004). A real
   * CloudFormation A/B showed that removing `DeletionProtection`,
   * `IamAuthEnabled` or `BackupRetentionPeriod` (DBCluster) or
   * `AutoMinorVersionUpgrade` (DBInstance) from the template KEEPS the live
   * value, so cdkd leaves them untouched too (Modify*: an absent field means
   * "no change"). Not measurable: `DBInstance.DeletionProtection` is not a
   * CloudFormation property (its pass-through below is kept as is), and
   * `DBSubnetGroupDescription` is required there, so it cannot be removed.
   */

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Neptune::DBSubnetGroup',
      new Set(['DBSubnetGroupName', 'DBSubnetGroupDescription', 'SubnetIds', 'Tags']),
    ],
    [
      'AWS::Neptune::DBCluster',
      new Set([
        'DBClusterIdentifier',
        'EngineVersion',
        'DBPort',
        'Port',
        'VpcSecurityGroupIds',
        'DBSubnetGroupName',
        'StorageEncrypted',
        'KmsKeyId',
        'BackupRetentionPeriod',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'DBClusterParameterGroupName',
        'IamAuthEnabled',
        'DeletionProtection',
        'Tags',
        'AssociatedRoles',
        'AvailabilityZones',
        'CopyTagsToSnapshot',
        'DBInstanceParameterGroupName',
        'EnableCloudwatchLogsExports',
        'NetworkType',
        'ServerlessScalingConfiguration',
      ]),
    ],
    [
      'AWS::Neptune::DBInstance',
      new Set([
        'DBInstanceIdentifier',
        'DBInstanceClass',
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'DBParameterGroupName',
        'AvailabilityZone',
        'PreferredMaintenanceWindow',
        'AutoMinorVersionUpgrade',
        'DeletionProtection',
        'Tags',
        'AllowMajorVersionUpgrade',
        'PubliclyAccessible',
      ]),
    ],
  ]);

  /**
   * Properties still routed to Cloud Control, each with its reason (the
   * cluster's restore group stays in `_todo-backfill.json`, go-to-k/cdkd#2762).
   */
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Neptune::DBCluster',
      new Map([
        [
          'GlobalClusterIdentifier',
          'Cloud Control owns a global-cluster member: NeptuneProvider has no detach, and a member cannot be deleted while attached (deletesThroughSdkProvider keeps its delete there too)',
        ],
      ]),
    ],
    [
      'AWS::Neptune::DBInstance',
      new Map([
        [
          'DBSnapshotIdentifier',
          'The CloudFormation schema documents it as not supported, and CreateDBInstance has no such member: a Neptune instance is not restored from a snapshot, its cluster is',
        ],
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): the handled
   * DBCluster / DBInstance properties whose removal `update()` handles, so
   * the shared caller warns about none of them. Create-only ones replace;
   * `VpcSecurityGroupIds` is reset (`dbClusterSecurityGroupsToSend`); `Tags`,
   * `AssociatedRoles` and `EnableCloudwatchLogsExports` are diffed;
   * `DBInstanceClass` is required; `DBInstanceParameterGroupName` and
   * `AllowMajorVersionUpgrade` are per-call flags with no live value. Every
   * property of the KEPT lists is LEFT in place, as CloudFormation leaves it
   * (measured, see {@link CLUSTER_KEPT_ON_REMOVAL}), and named in `update()`'s
   * own warning. The instance's `DeletionProtection` is not a CloudFormation
   * property, so no CloudFormation template removes it. The UNMEASURED list is
   * left in place and warned about too, without the parity claim.
   * `PubliclyAccessible` is left too (#2762 A/B: KEPT), under a warning of its
   * own ({@link warnPublicAccessKept}).
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Neptune::DBCluster',
      new Set([
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'StorageEncrypted',
        'KmsKeyId',
        'AvailabilityZones',
        'VpcSecurityGroupIds',
        'Tags',
        'AssociatedRoles',
        'EnableCloudwatchLogsExports',
        'DBInstanceParameterGroupName',
        ...CLUSTER_KEPT_ON_REMOVAL,
        ...CLUSTER_UNMEASURED_ON_REMOVAL,
      ]),
    ],
    [
      'AWS::Neptune::DBInstance',
      new Set([
        'DBInstanceIdentifier',
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'AvailabilityZone',
        'DBInstanceClass',
        'DeletionProtection',
        'Tags',
        'AllowMajorVersionUpgrade',
        'PubliclyAccessible',
        ...INSTANCE_KEPT_ON_REMOVAL,
      ]),
    ],
  ]);

  /**
   * `region` pins the client instead of the ambient region: the Cloud Control
   * delete delegation (issue #4029) passes its OWN client's region, which is
   * the one its recorded-region pre-flight vetted.
   */
  constructor(options?: { region?: string }) {
    this.providerRegion = options?.region ?? ambientRegion();
  }

  private getClient(): NeptuneClient {
    if (!this.neptuneClient) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.neptuneClient = new NeptuneClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new NeptuneClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.neptuneClient;
  }

  /** Only a removed DBCluster `VpcSecurityGroupIds` reaches EC2 (issue #1160). */
  private getEc2Client(): EC2Client {
    if (!this.ec2Client) {
      this.ec2Client = new EC2Client({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.ec2Client;
  }

  /**
   * The client `CreateDBSubnetGroup` / `CreateDBCluster` / `CreateDBInstance` go
   * through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * None of the three carries an idempotency token, and each name is unique
   * per account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): NeptuneClient {
    this.getClient();
    return this.createClient as NeptuneClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const mask = context?.maskSecrets;
    switch (resourceType) {
      case 'AWS::Neptune::DBSubnetGroup':
        return this.createDBSubnetGroup(logicalId, resourceType, properties, mask);
      case 'AWS::Neptune::DBCluster':
        return this.createDBCluster(
          logicalId,
          resourceType,
          properties,
          mask,
          context?.replayingState === true
        );
      case 'AWS::Neptune::DBInstance':
        return this.createDBInstance(
          logicalId,
          resourceType,
          properties,
          mask,
          context?.replayingState === true
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::Neptune::DBSubnetGroup':
        return this.updateDBSubnetGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context?.maskSecrets
        );
      case 'AWS::Neptune::DBCluster':
        return this.updateDBCluster(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context
        );
      case 'AWS::Neptune::DBInstance':
        return this.updateDBInstance(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          context
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::Neptune::DBSubnetGroup':
        return this.deleteDBSubnetGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::Neptune::DBCluster':
        return this.deleteDBCluster(logicalId, physicalId, resourceType, context);
      case 'AWS::Neptune::DBInstance':
        return this.deleteDBInstance(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── DBSubnetGroup ────────────────────────────────────────────────

  private async createDBSubnetGroup(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Neptune DBSubnetGroup ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const dbSubnetGroupName =
      (properties['DBSubnetGroupName'] as string | undefined) ||
      generatedNameFor('AWS::Neptune::DBSubnetGroup', logicalId);

    try {
      await this.getCreateClient().send(
        new CreateDBSubnetGroupCommand({
          DBSubnetGroupName: dbSubnetGroupName,
          DBSubnetGroupDescription:
            (properties['DBSubnetGroupDescription'] as string) || `Subnet group for ${logicalId}`,
          SubnetIds: properties['SubnetIds'] as string[],
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      this.logger.debug(
        `Successfully created Neptune DBSubnetGroup ${logicalId}: ${dbSubnetGroupName}`
      );

      return {
        physicalId: dbSubnetGroupName,
        attributes: {
          DBSubnetGroupName: dbSubnetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create Neptune DBSubnetGroup ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            dbSubnetGroupName,
            cause
          )
      );
    }
  }

  private async updateDBSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Neptune DBSubnetGroup ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    try {
      // Class 2 — `SubnetIds: []` would be rejected by AWS as a
      // structurally invalid input (DBSubnetGroup requires ≥ 2 subnets in
      // distinct AZs). Skip the field when empty so description-only
      // updates work.
      const subnetIds = properties['SubnetIds'] as string[] | undefined;
      const sendSubnetIds = subnetIds !== undefined && subnetIds.length > 0;
      const modifyInput = {
        DBSubnetGroupName: physicalId,
        // #1160 reset-on-removal (kept; not measurable in the #5004 A/B):
        // CFn declares DBSubnetGroupDescription
        // required, so a CFn-valid template can never remove it — but
        // cdkd's create() tolerates absence with the `Subnet group for
        // <logicalId>` fallback, so removal resets to the same fallback for
        // create/update parity instead of silently keeping the old value.
        DBSubnetGroupDescription: clearOnUpdateRemoval(
          properties['DBSubnetGroupDescription'] as string | undefined,
          previousProperties['DBSubnetGroupDescription'] as string | undefined,
          `Subnet group for ${logicalId}`
        ),
        ...(sendSubnetIds && { SubnetIds: subnetIds }),
      } as ConstructorParameters<typeof ModifyDBSubnetGroupCommand>[0];
      await this.getClient().send(new ModifyDBSubnetGroupCommand(modifyInput));

      const desc = await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
      );
      const arn = desc.DBSubnetGroups?.[0]?.DBSubnetGroupArn;
      if (arn) {
        await this.applyTagDiff(
          arn,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
        );
      }

      this.logger.debug(`Successfully updated Neptune DBSubnetGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          DBSubnetGroupName: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update Neptune DBSubnetGroup ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  private async deleteDBSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Neptune DBSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteDBSubnetGroupCommand({
          DBSubnetGroupName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted Neptune DBSubnetGroup ${logicalId}`);
    } catch (error) {
      if (this.isNotFoundError(error, 'DBSubnetGroupNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Neptune DBSubnetGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapDeleteError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete Neptune DBSubnetGroup ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  // ─── DBCluster ────────────────────────────────────────────────────

  private async createDBCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    replayingState: boolean
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Neptune DBCluster ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    const { roles, logTypes, scaling } = this.readClusterBlocks(
      properties,
      resourceType,
      logicalId,
      {
        creating: true,
        stateBorne: replayingState,
      }
    );

    const dbClusterIdentifier =
      (properties['DBClusterIdentifier'] as string | undefined) ||
      generatedNameFor('AWS::Neptune::DBCluster', logicalId);

    // go-to-k/cdkd#4583: set once CreateDBCluster returned (no self-cleanup).
    let clusterCreated = false;
    // go-to-k/cdkd#4606: the `DbClusterResourceId` CreateDBCluster returned,
    // carried on the failure's mark as the orphan's identity.
    let createdResourceId: string | undefined;
    try {
      const response = await this.getCreateClient().send(
        new CreateDBClusterCommand({
          DBClusterIdentifier: dbClusterIdentifier,
          // Neptune engine value is fixed: only `neptune` is accepted.
          Engine: 'neptune',
          EngineVersion: properties['EngineVersion'] as string | undefined,
          // CFn schema's writable port field is `DBPort`; `Port` is readOnly
          // in the schema but older CDK versions emit it. Prefer DBPort, fall
          // back to Port for backward compat.
          Port:
            properties['DBPort'] != null
              ? Number(properties['DBPort'])
              : properties['Port'] != null
                ? Number(properties['Port'])
                : undefined,
          VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
          StorageEncrypted: properties['StorageEncrypted'] as boolean | undefined,
          KmsKeyId: properties['KmsKeyId'] as string | undefined,
          BackupRetentionPeriod:
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
          PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as
            | string
            | undefined,
          EnableIAMDatabaseAuthentication: properties['IamAuthEnabled'] as boolean | undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          AvailabilityZones: properties['AvailabilityZones'] as string[] | undefined,
          CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean | undefined,
          NetworkType: properties['NetworkType'] as string | undefined,
          ...(logTypes.length > 0 && { EnableCloudwatchLogsExports: logTypes }),
          ...(scaling != null && { ServerlessV2ScalingConfiguration: scaling }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );
      clusterCreated = true;
      createdResourceId = response.DBCluster?.DbClusterResourceId;
      // go-to-k/cdkd#5511: reported before the available wait.
      reportCreatedResource(logicalId, resourceType, dbClusterIdentifier, createdResourceId);

      const cluster = response.DBCluster;
      if (!cluster) {
        throw new Error('CreateDBCluster did not return DBCluster');
      }

      this.logger.debug(
        `Successfully created Neptune DBCluster ${logicalId}: ${dbClusterIdentifier}`
      );

      // Wait for cluster to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForClusterAvailable(logicalId, dbClusterIdentifier);
      }
      try {
        await this.applyClusterRoles(
          logicalId,
          dbClusterIdentifier,
          roles,
          [],
          [],
          mask,
          undefined
        );
      } catch (error) {
        // The cluster itself was created: a role's "already exists" is not
        // this name's collision (#3826).
        markAuxiliaryFailure(error, logicalId);
        throw error;
      }

      const described = await this.describeDBCluster(dbClusterIdentifier);

      return {
        physicalId: dbClusterIdentifier,
        attributes: clusterAttributes(described),
      };
    } catch (error) {
      const thrown =
        error instanceof ProvisioningError
          ? error
          : this.wrapCaughtError(
              mask,
              error,
              (text) =>
                new ProvisioningError(
                  `Failed to create Neptune DBCluster ${logicalId}: ${text}`,
                  resourceType,
                  logicalId,
                  dbClusterIdentifier,
                  error instanceof Error ? error : undefined
                )
            );
      // go-to-k/cdkd#4583: the cluster exists and no state record will hold
      // it; never before CreateDBCluster returned (another owner's name).
      if (clusterCreated) {
        markCreatedBeforeFailure(
          thrown,
          logicalId,
          resourceType,
          dbClusterIdentifier,
          createdResourceId
        );
      }
      throw thrown;
    }
  }

  private async updateDBCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Neptune DBCluster ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    const { roles, logTypes, scaling } = this.readClusterBlocks(
      properties,
      resourceType,
      logicalId,
      {
        creating: false,
        stateBorne: context?.replayingState === true || context?.desiredFromAwsReadback === true,
        physicalId,
      }
    );
    const logExportConfig = logExportChange(
      logTypes,
      // A malformed record only misses disables; every enable is idempotent.
      stringList(previousProperties['EnableCloudwatchLogsExports']) ?? []
    );

    try {
      // AWS refuses a major EngineVersion without AllowMajorVersionUpgrade, and
      // the cluster schema has no such flag: as the RDS provider, the raised
      // version is the request. DBInstanceParameterGroupName is valid only
      // beside the flag. A version newly declared compares with the live one.
      // NetworkType compares the same way: the live value is what it changes.
      const unrecorded = (key: string): boolean =>
        properties[key] != null && previousProperties[key] == null;
      const live =
        unrecorded('EngineVersion') ||
        unrecorded('NetworkType') ||
        logExportConfig?.EnableLogTypes !== undefined
          ? await this.describeDBCluster(physicalId)
          : undefined;
      const majorUpgrade = isMajorEngineChange(
        previousProperties['EngineVersion'] ?? live?.EngineVersion,
        properties['EngineVersion']
      );
      const networkType = properties['NetworkType'] as string | undefined;
      const networkChange =
        networkType != null &&
        networkType !== (previousProperties['NetworkType'] ?? live?.NetworkType);
      markChangedUnsettled(CLUSTER_MODIFY_KEYS, properties, previousProperties, context);
      // Its own ProvisioningError names the cause; the catch passes it through.
      const vpcSgIds = await this.dbClusterSecurityGroupsToSend(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
      // #1160 reset-on-removal — ModifyDBCluster has merge semantics (an
      // absent input field means "no change"), so a property REMOVED from
      // the template is sent as an explicit reset only where CloudFormation
      // resets it. Every property in CLUSTER_KEPT_ON_REMOVAL was measured as
      // KEPT (#5004, #1160, #5544), so a removed one is passed through as
      // absent and named in the warning below. DocDB differs on the port:
      // there CloudFormation resets it to 27017. A removed
      // VpcSecurityGroupIds IS reset, to the VPC's default security group
      // (`dbClusterSecurityGroupsToSend`).
      await this.getClient().send(
        new ModifyDBClusterCommand({
          DBClusterIdentifier: physicalId,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          // #5004: CloudFormation KEEPS the live value of a removed
          // DeletionProtection / BackupRetentionPeriod, so an absent value
          // is passed through as absent (no reset).
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          BackupRetentionPeriod:
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
          PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as
            | string
            | undefined,
          // #5004: a removed IamAuthEnabled is KEPT by CloudFormation (no reset).
          // CFn property `IamAuthEnabled` maps to `EnableIAMDatabaseAuthentication`.
          EnableIAMDatabaseAuthentication: properties['IamAuthEnabled'] as boolean | undefined,
          ...(vpcSgIds !== undefined && { VpcSecurityGroupIds: vpcSgIds }),
          Port:
            properties['DBPort'] != null
              ? Number(properties['DBPort'])
              : properties['Port'] != null
                ? Number(properties['Port'])
                : undefined,
          CopyTagsToSnapshot: properties['CopyTagsToSnapshot'] as boolean | undefined,
          // Sent only on a change: re-sending one asks AWS for a network
          // change on every update.
          ...(networkChange && { NetworkType: networkType }),
          ...(scaling != null && { ServerlessV2ScalingConfiguration: scaling }),
          ...(logExportConfig !== undefined && {
            CloudwatchLogsExportConfiguration: logExportConfig,
          }),
          ...(majorUpgrade && { AllowMajorVersionUpgrade: true }),
          ...(majorUpgrade &&
            properties['DBInstanceParameterGroupName'] != null && {
              DBInstanceParameterGroupName: properties['DBInstanceParameterGroupName'] as string,
            }),
          ApplyImmediately: true,
        })
      );

      // go-to-k/cdkd#5498: what this call added, so a convergence after a
      // later failure disables it, and nothing an out-of-band change enabled.
      const addedLogTypes = (logExportConfig?.EnableLogTypes ?? []).filter(
        (type) => !live?.EnabledCloudwatchLogsExports?.includes(type)
      );
      if (addedLogTypes.length > 0) {
        context?.markAttempted?.('EnableCloudwatchLogsExports', addedLogTypes);
      }

      this.logger.debug(`Successfully updated Neptune DBCluster ${logicalId}`);
      const described = await this.describeDBCluster(physicalId);

      if (logExportConfig !== undefined && process.env['CDKD_NO_WAIT'] !== 'true') {
        // The delta, not the whole list: a type enabled out of band is not ours.
        const { EnableLogTypes: enabled = [], DisableLogTypes: disabled = [] } = logExportConfig;
        await this.waitForApplied(logicalId, 'EnableCloudwatchLogsExports', async () => {
          const live = (await this.describeDBCluster(physicalId))?.EnabledCloudwatchLogsExports;
          return (
            enabled.every((type) => live?.includes(type)) &&
            !disabled.some((type) => live?.includes(type))
          );
        });
      }

      if (networkChange && process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForApplied(
          logicalId,
          'NetworkType',
          async () => (await this.describeDBCluster(physicalId))?.NetworkType === networkType
        );
      }

      await this.applyClusterRoles(
        logicalId,
        physicalId,
        roles,
        // A malformed record only misses detaches: `applyClusterRoles` reads
        // what is live, so an attached role is not attached twice.
        clusterRoleList(previousProperties['AssociatedRoles']) ?? [],
        described?.AssociatedRoles ?? [],
        context?.maskSecrets,
        context
      );

      // A changed VpcSecurityGroupIds also moves every member instance to
      // `modifying` within about a second, and a member's own Modify* in the
      // same deploy is then refused ("Database instance is not in available
      // state"). CloudFormation reports the update only once it has settled, so
      // wait here, but ONLY when the sent list differs from the previous one:
      // an unchanged list (re-sent on every update) adds no time. `--no-wait`
      // skips it, exactly as create() skips waitForClusterAvailable.
      if (
        process.env['CDKD_NO_WAIT'] !== 'true' &&
        securityGroupListChanged(vpcSgIds, previousProperties['VpcSecurityGroupIds'])
      ) {
        await this.waitForSecurityGroupsApplied(physicalId, logicalId, vpcSgIds ?? []);
        for (const member of described?.DBClusterMembers ?? []) {
          if (member.DBInstanceIdentifier) {
            await this.waitForMemberAfterSecurityGroupChange(
              member.DBInstanceIdentifier,
              logicalId
            );
          }
        }
      }

      if (described?.DBClusterArn) {
        markChangedUnsettled(['Tags'], properties, previousProperties, context);
        await this.applyTagDiff(
          described.DBClusterArn,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
        );
      }

      this.warnKeptRemovals(
        logicalId,
        resourceType,
        properties,
        previousProperties,
        CLUSTER_KEPT_ON_REMOVAL,
        context
      );
      this.warnKeptRemovals(
        logicalId,
        resourceType,
        properties,
        previousProperties,
        CLUSTER_UNMEASURED_ON_REMOVAL,
        context,
        false
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: clusterAttributes(described),
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update Neptune DBCluster ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * The compensation boundary (issue #2204): a `--remove-protection` flip whose
   * delete then fails terminally is undone here, so a destroy that did not
   * happen does not leave a live cluster with its guard stripped.
   */
  private async deleteDBCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    await deleteWithProtectionCompensation({
      registry: this.protectionFlips,
      key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
      run: (flip) => this.deleteDBClusterOnce(logicalId, physicalId, resourceType, context, flip),
      compensation: {
        logicalId,
        physicalId,
        logger: this.logger,
        site: rdsFamilyProtectionSite({
          cliService: 'neptune',
          serviceLabel: 'Neptune',
          kind: 'cluster',
          physicalId,
          region: context?.expectedRegion,
          notFoundFault: 'DBClusterNotFoundFault',
          isNotFound: (error) => this.isNotFoundError(error, 'DBClusterNotFoundFault'),
        }),
        reEnable: async () => {
          await this.getClient().send(
            new ModifyDBClusterCommand({
              DBClusterIdentifier: physicalId,
              DeletionProtection: true,
              ApplyImmediately: true,
            })
          );
        },
      },
    });
  }

  private async deleteDBClusterOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    this.logger.debug(`Deleting Neptune DBCluster ${logicalId}`);

    try {
      // `--remove-protection`: flip DeletionProtection off in-place
      // before delete. Idempotent — Neptune accepts the call when
      // protection is already disabled. Non-fatal: log at debug if the
      // flip-off errors (e.g. NotFound) so the actual delete still
      // proceeds.
      // The pre-flip readback is what lets a terminal failure restore ONLY a
      // guard this run turned off (issue #2204).
      if (context?.removeProtection === true) {
        try {
          await observeThenDisableProtection({
            flip,
            logger: this.logger,
            physicalId,
            mask: context?.maskSecrets,
            guardName: 'DeletionProtection',
            observe: async () =>
              (await this.describeDBCluster(physicalId))?.DeletionProtection === true,
            disable: async () => {
              await this.getClient().send(
                new ModifyDBClusterCommand({
                  DBClusterIdentifier: physicalId,
                  DeletionProtection: false,
                  ApplyImmediately: true,
                })
              );
            },
          });
          this.logger.debug(
            `Disabled DeletionProtection on Neptune DBCluster ${logicalId} before delete`
          );
        } catch (disableError) {
          if (!this.isNotFoundError(disableError, 'DBClusterNotFoundFault')) {
            this.logger.debug(
              maskerOrIdentity(context?.maskSecrets)(
                `Could not disable deletion protection for Neptune DBCluster ${logicalId}: ${describeAwsFailure(disableError).detail}`
              )
            );
          }
        }
      }

      // `DeletionPolicy: Snapshot` (issue #1352): flip to the atomic
      // final-snapshot delete when the destroy call site passed an id.
      const finalSnapshotId = context?.finalSnapshotIdentifier;
      // Issue #5155: a final snapshot needs `available`, which the flip above
      // briefly takes away. Only a flip of this run AND a snapshot wait, and
      // never once AWS accepted the delete (a re-entry after a failed wait).
      const sendDelete = () =>
        this.getClient().send(
          new DeleteDBClusterCommand({
            DBClusterIdentifier: physicalId,
            ...(finalSnapshotId
              ? { SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: finalSnapshotId }
              : { SkipFinalSnapshot: true }),
          })
        );
      if (finalSnapshotId && flip.flippedOffByThisRun && !flip.deleteAccepted) {
        // Issue #5184: waits, then retries a delete AWS refuses as not `available`.
        await this.deleteAfterProtectionFlip(logicalId, physicalId, sendDelete);
      } else {
        await sendDelete();
      }
      // AWS took the delete: a later throw is the WAIT failing, and the guard
      // must not be put back on a cluster that is being deleted.
      flip.deleteAccepted = true;
      // Not the identifier: it embeds the physical id, which may be secret-derived
      // (#4111). It is `<sanitized physical id>-final-<UTC timestamp>` (docs/cli-destroy.md).
      if (finalSnapshotId) {
        this.logger.info(
          `Deleting Neptune DBCluster ${logicalId} with a final snapshot (DeletionPolicy: Snapshot)`
        );
      }

      this.logger.debug(`Successfully initiated deletion of Neptune DBCluster ${logicalId}`);

      // Wait for cluster to be fully deleted
      await this.waitForClusterDeleted(logicalId, physicalId);
    } catch (error) {
      if (this.isNotFoundError(error, 'DBClusterNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone settles with
          // exit 0, so say so once. Masked by the caller's printing bag.
          this.logger.info(
            safeMsg`  Neptune DB cluster ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`Neptune DBCluster ${logicalId} does not exist, skipping deletion`);
        }
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapDeleteError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete Neptune DBCluster ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  // ─── DBInstance ───────────────────────────────────────────────────

  private async createDBInstance(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined,
    replayingState: boolean
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Neptune DBInstance ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    const publiclyAccessible = this.readPublicAccess(
      properties,
      resourceType,
      logicalId,
      undefined,
      replayingState
    );

    const dbInstanceIdentifier =
      (properties['DBInstanceIdentifier'] as string | undefined) ||
      generatedNameFor('AWS::Neptune::DBInstance', logicalId);

    // go-to-k/cdkd#4583: set once CreateDBInstance returned (no self-cleanup).
    let instanceCreated = false;
    // go-to-k/cdkd#4606: the `DbiResourceId` CreateDBInstance returned,
    // carried on the failure's mark as the orphan's identity.
    let createdResourceId: string | undefined;
    try {
      const response = await this.getCreateClient().send(
        new CreateDBInstanceCommand({
          DBInstanceIdentifier: dbInstanceIdentifier,
          DBInstanceClass: properties['DBInstanceClass'] as string,
          // Neptune engine value is fixed: only `neptune` is accepted.
          Engine: 'neptune',
          DBClusterIdentifier: properties['DBClusterIdentifier'] as string,
          DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
          DBParameterGroupName: properties['DBParameterGroupName'] as string | undefined,
          AvailabilityZone: properties['AvailabilityZone'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          PubliclyAccessible: publiclyAccessible,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );
      instanceCreated = true;
      createdResourceId = response.DBInstance?.DbiResourceId;
      // go-to-k/cdkd#5511: reported before the available wait.
      reportCreatedResource(logicalId, resourceType, dbInstanceIdentifier, createdResourceId);

      const instance = response.DBInstance;
      if (!instance) {
        throw new Error('CreateDBInstance did not return DBInstance');
      }

      this.logger.debug(
        `Successfully created Neptune DBInstance ${logicalId}: ${dbInstanceIdentifier}`
      );

      // Wait for instance to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForInstanceAvailable(logicalId, dbInstanceIdentifier);
      }

      const described = await this.describeDBInstance(dbInstanceIdentifier);

      return {
        physicalId: dbInstanceIdentifier,
        attributes: instanceAttributes(described),
      };
    } catch (error) {
      const thrown =
        error instanceof ProvisioningError
          ? error
          : this.wrapCaughtError(
              mask,
              error,
              (text) =>
                new ProvisioningError(
                  `Failed to create Neptune DBInstance ${logicalId}: ${text}`,
                  resourceType,
                  logicalId,
                  dbInstanceIdentifier,
                  error instanceof Error ? error : undefined
                )
            );
      // go-to-k/cdkd#4583: the instance exists and no state record will hold
      // it; never before CreateDBInstance returned (another owner's name).
      if (instanceCreated) {
        markCreatedBeforeFailure(
          thrown,
          logicalId,
          resourceType,
          dbInstanceIdentifier,
          createdResourceId
        );
      }
      throw thrown;
    }
  }

  private async updateDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<ResourceUpdateResult> {
    const mask = context?.maskSecrets;
    this.logger.debug(`Updating Neptune DBInstance ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    const publiclyAccessible = this.readPublicAccess(
      properties,
      resourceType,
      logicalId,
      physicalId,
      context?.replayingState === true || context?.desiredFromAwsReadback === true
    );

    try {
      // #1160 reset-on-removal — ModifyDBInstance has merge semantics (an
      // absent input field means "no change"), so a property REMOVED from
      // the template is sent as an explicit reset only where CloudFormation
      // resets it. Every property in INSTANCE_KEPT_ON_REMOVAL was measured as
      // KEPT (#5004, #5544), so a removed one is passed through as absent and
      // named in the warning below. A removed `PubliclyAccessible` is KEPT
      // too (#2762 A/B), and warned about on its own.
      // #5194: a cluster change in the same deploy can leave this member not
      // `available` for a moment; only that refusal is waited out and resent.
      markChangedUnsettled(INSTANCE_MODIFY_KEYS, properties, previousProperties, context);
      await modifyDbInstanceWhenAvailable({
        send: () =>
          this.getClient().send(
            new ModifyDBInstanceCommand({
              DBInstanceIdentifier: physicalId,
              DBInstanceClass: properties['DBInstanceClass'] as string | undefined,
              DBParameterGroupName: properties['DBParameterGroupName'] as string | undefined,
              PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
                | string
                | undefined,
              // #5004: CloudFormation KEEPS the live value of a removed
              // AutoMinorVersionUpgrade (no reset).
              AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
              // Not a CloudFormation property (#5004): never reset on removal.
              DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
              PubliclyAccessible: publiclyAccessible,
              // CreateDBInstance has no such member: it only applies here.
              AllowMajorVersionUpgrade: properties['AllowMajorVersionUpgrade'] as
                | boolean
                | undefined,
              ApplyImmediately: true,
            })
          ),
        readStatus: async () => (await this.describeDBInstance(physicalId))?.DBInstanceStatus,
        sleep: (ms) => this.sleep(ms),
        logger: this.logger,
        label: 'Neptune DBInstance',
        logicalId,
        remainingMs: enclosingDeadlineRemainingMs(),
      });

      this.logger.debug(`Successfully updated Neptune DBInstance ${logicalId}`);
      if (
        publiclyAccessible !== undefined &&
        publiclyAccessible !== coerceCfnBoolean(previousProperties['PubliclyAccessible']) &&
        process.env['CDKD_NO_WAIT'] !== 'true'
      ) {
        await this.waitForApplied(
          logicalId,
          'PubliclyAccessible',
          async () =>
            (await this.describeDBInstance(physicalId))?.PubliclyAccessible === publiclyAccessible
        );
      }
      const described = await this.describeDBInstance(physicalId);

      if (described?.DBInstanceArn) {
        markChangedUnsettled(['Tags'], properties, previousProperties, context);
        await this.applyTagDiff(
          described.DBInstanceArn,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
        );
      }

      this.warnKeptRemovals(
        logicalId,
        resourceType,
        properties,
        previousProperties,
        INSTANCE_KEPT_ON_REMOVAL,
        context
      );
      this.warnPublicAccessKept(logicalId, resourceType, properties, previousProperties, context);

      return {
        physicalId,
        wasReplaced: false,
        attributes: instanceAttributes(described),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update Neptune DBInstance ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /** The compensation boundary for a DBInstance; see {@link deleteDBCluster}. */
  private async deleteDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    await deleteWithProtectionCompensation({
      registry: this.protectionFlips,
      key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
      run: (flip) => this.deleteDBInstanceOnce(logicalId, physicalId, resourceType, context, flip),
      compensation: {
        logicalId,
        physicalId,
        logger: this.logger,
        site: rdsFamilyProtectionSite({
          cliService: 'neptune',
          serviceLabel: 'Neptune',
          kind: 'instance',
          physicalId,
          region: context?.expectedRegion,
          notFoundFault: 'DBInstanceNotFoundFault',
          isNotFound: (error) => this.isNotFoundError(error, 'DBInstanceNotFoundFault'),
        }),
        reEnable: async () => {
          await this.getClient().send(
            new ModifyDBInstanceCommand({
              DBInstanceIdentifier: physicalId,
              DeletionProtection: true,
              ApplyImmediately: true,
            })
          );
        },
      },
    });
  }

  private async deleteDBInstanceOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    this.logger.debug(`Deleting Neptune DBInstance ${logicalId}: ${physicalId}`);

    try {
      // `--remove-protection`: flip DeletionProtection off in-place
      // before delete. Neptune (unlike DocDB) supports per-instance
      // DeletionProtection. Idempotent — accepts the call when already
      // disabled.
      // The pre-flip readback is what lets a terminal failure restore ONLY a
      // guard this run turned off (issue #2204).
      if (context?.removeProtection === true) {
        try {
          await observeThenDisableProtection({
            flip,
            logger: this.logger,
            physicalId,
            mask: context?.maskSecrets,
            guardName: 'DeletionProtection',
            observe: async () =>
              (await this.describeDBInstance(physicalId))?.DeletionProtection === true,
            disable: async () => {
              await this.getClient().send(
                new ModifyDBInstanceCommand({
                  DBInstanceIdentifier: physicalId,
                  DeletionProtection: false,
                  ApplyImmediately: true,
                })
              );
            },
          });
          this.logger.debug(
            `Disabled DeletionProtection on Neptune DBInstance ${logicalId} before delete`
          );
        } catch (disableError) {
          if (!this.isNotFoundError(disableError, 'DBInstanceNotFoundFault')) {
            this.logger.debug(
              maskerOrIdentity(context?.maskSecrets)(
                `Could not disable deletion protection for ${physicalId}: ${describeAwsFailure(disableError).detail}`
              )
            );
          }
        }
      }

      await this.getClient().send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
          SkipFinalSnapshot: true,
        })
      );
      // AWS took the delete: see `deleteDBClusterOnce`.
      flip.deleteAccepted = true;

      this.logger.debug(`Successfully initiated deletion of Neptune DBInstance ${logicalId}`);

      // Wait for instance to be fully deleted
      await this.waitForInstanceDeleted(physicalId);
    } catch (error) {
      if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        if (context?.failedCreateOrphan === true) {
          // go-to-k/cdkd#4606: a journaled orphan already gone settles with
          // exit 0, so say so once. Masked by the caller's printing bag.
          this.logger.info(
            safeMsg`  Neptune DB instance ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`Neptune DBInstance ${physicalId} does not exist, skipping deletion`);
        }
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapDeleteError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete Neptune DBInstance ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * The failure wrap the DBSubnetGroup / DBCluster / DBInstance create, update
   * and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through the operation's
   * masker, and the wrap is stamped `markRedactedCause`, so the retry
   * classifiers read the withheld text on the `cause` chain. An "already
   * exists" is restated ({@link relayedNameCollision}), so a create-first
   * replacement still recognises the collision. A cdkd-authored or transport
   * error keeps its text, masked, stamped only when the mask changed it
   * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
   * an AWS one, unstamped (it has no chain). The delete catches test not-found
   * before they wrap.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapCaughtError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const m = maskerOrIdentity(mask);
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
    this.logger.debug(m(build(m(failure.detail)).message));
    const wrapped = build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /**
   * {@link wrapCaughtError} for a delete catch. The wrap names an AWS failure
   * by its CLASS, and the delete classifiers read `NotFound` in a message as
   * "already deleted": a class naming ANOTHER object's not-found (this
   * resource's own not-found returned before the wrap) is marked
   * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
   */
  private wrapDeleteError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const thrown = this.wrapCaughtError(mask, error, build);
    return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via Neptune's
   * `AddTagsToResource` / `RemoveTagsFromResource` APIs (keyed by
   * `ResourceName=arn`).
   */
  private async applyTagDiff(
    arn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    // go-to-k/cdkd#3994: both sides are read through `planTagDiff`; an
    // unreadable record untags nothing.
    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
    const tagsToRemove = plan.remove;

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from Neptune resource ${arn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(
        new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on Neptune resource ${arn}`);
    }
  }

  private isNotFoundError(error: unknown, faultName: string): boolean {
    if (!(error instanceof Error)) return false;
    const name = (error as { name?: string }).name ?? '';
    const message = error.message.toLowerCase();
    return (
      name === faultName || message.includes('not found') || message.includes('does not exist')
    );
  }

  /**
   * go-to-k/cdkd#4606: whether the DB cluster or DB instance a failed CREATE
   * journaled is the one the record under the same logical id holds (a
   * fix-forward that created a new one there under another identifier).
   *
   * Reached on the SDK route only (Cloud Control's provider has no
   * `isSameResource`, so a Cloud Control-routed orphan is `'unknown'`). Both
   * ids must be DB identifiers; an ARN or anything else is `'unknown'`, as
   * is a DBSubnetGroup. An identifier names at most one cluster (or
   * instance) per account and region at a time, across Neptune, RDS and
   * DocumentDB, and is compared case-insensitively (stored lower-cased), so
   * two spellings equal modulo case are `'same'` without a read. After the
   * region check the record's resource must read back as a Neptune one (else
   * `'unknown'`); the journaled one is `'same'` when it reads back under the
   * record's `DbClusterResourceId` / `DbiResourceId` (immutable, unique,
   * unchanged by a rename), `'different'` under another, and `'different'`
   * when AWS reports its identifier gone: the record's resource answers to
   * its own, other, identifier, so the gone one cannot name it. A read
   * answering with another engine's resource throws (`'unknown'` to the
   * caller): the identifier is no longer a Neptune one.
   */
  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    if (resourceType !== 'AWS::Neptune::DBCluster' && resourceType !== 'AWS::Neptune::DBInstance') {
      return 'unknown';
    }
    if (!isDbIdentifier(journaledPhysicalId) || !isDbIdentifier(record.physicalId)) {
      return 'unknown';
    }
    if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'same';
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return 'unknown';
    const recordResourceId = await this.readDbResourceIdIfExists(resourceType, record.physicalId);
    if (recordResourceId === undefined) return 'unknown';
    const journaledResourceId = await this.readDbResourceIdIfExists(
      resourceType,
      journaledPhysicalId
    );
    if (journaledResourceId === undefined) return 'different';
    return journaledResourceId === recordResourceId ? 'same' : 'different';
  }

  /**
   * go-to-k/cdkd#4606: the cluster's `DbClusterResourceId` or the instance's
   * `DbiResourceId`, which AWS generates, never changes (a rename keeps it)
   * and never gives a later resource. A cluster or instance re-created under
   * the identifier, in any case spelling and by any of the engines sharing
   * the namespace, answers with another id (or, for another engine, throws),
   * so the settle keeps it rather than deleting it as the failed CREATE's
   * orphan. A failed CREATE's own token comes from its create response, on
   * the failure's mark (`markCreatedBeforeFailure`); this is the live read.
   *
   * `undefined` for another type, an id that is not a DB identifier, or a
   * client in another region than `expectedRegion`. `RESOURCE_NOT_FOUND`
   * only on the describe's not-found fault NAME (or an empty list); any
   * other failure throws.
   */
  async resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    if (resourceType !== 'AWS::Neptune::DBCluster' && resourceType !== 'AWS::Neptune::DBInstance') {
      return undefined;
    }
    if (!isDbIdentifier(physicalId)) return undefined;
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return undefined;
    const live = await this.readDbResourceIdIfExists(resourceType, physicalId);
    return live === undefined ? RESOURCE_NOT_FOUND : live;
  }

  /**
   * The Neptune cluster's `DbClusterResourceId` (or the instance's
   * `DbiResourceId`), or `undefined` when AWS reports the identifier gone
   * (its not-found fault NAME, or an empty describe list). Any other
   * failure, a response naming another identifier, one whose engine is not
   * `neptune` (the describe also answers for RDS and DocumentDB resources)
   * and one naming no resource id throw: "could not read" never reads as
   * "gone".
   */
  private async readDbResourceIdIfExists(
    resourceType: 'AWS::Neptune::DBCluster' | 'AWS::Neptune::DBInstance',
    identifier: string
  ): Promise<string | undefined> {
    const isCluster = resourceType === 'AWS::Neptune::DBCluster';
    let found:
      | {
          identifier: string | undefined;
          engine: string | undefined;
          resourceId: string | undefined;
        }
      | undefined;
    try {
      if (isCluster) {
        const cluster = await this.describeDBCluster(identifier);
        found = cluster && {
          identifier: cluster.DBClusterIdentifier,
          engine: cluster.Engine,
          resourceId: cluster.DbClusterResourceId,
        };
      } else {
        const instance = await this.describeDBInstance(identifier);
        found = instance && {
          identifier: instance.DBInstanceIdentifier,
          engine: instance.Engine,
          resourceId: instance.DbiResourceId,
        };
      }
    } catch (error) {
      const notFound = isCluster ? 'DBClusterNotFoundFault' : 'DBInstanceNotFoundFault';
      if ((error as { name?: unknown } | null)?.name === notFound) return undefined;
      throw error;
    }
    if (found === undefined) return undefined;
    const api = isCluster ? 'DescribeDBClusters' : 'DescribeDBInstances';
    if (found.identifier?.toLowerCase() !== identifier.toLowerCase()) {
      throw new Error(`${api} answered for another identifier`);
    }
    if (found.engine !== 'neptune') {
      throw new Error(`${api} answered for a resource of another engine`);
    }
    if (typeof found.resourceId !== 'string' || found.resourceId === '') {
      throw new Error(`${api} returned no resource id`);
    }
    return found.resourceId;
  }

  /**
   * The `AssociatedRoles`, `EnableCloudwatchLogsExports` and
   * `ServerlessScalingConfiguration` a create or update sends, malformed ones
   * refused before any call. A state-borne bag downgrades a refusal to a
   * warning and leaves the block out, with one exception stated at it: a
   * malformed list on an UPDATE stays refused, since both lists are read as a
   * diff, and reading one as empty would detach every role or disable every
   * log (`.claude/rules/provider-aws-response-reads.md`, the list rule).
   */
  private readClusterBlocks(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    origin: { creating: boolean; stateBorne: boolean; physicalId?: string }
  ): {
    roles: ClusterRole[];
    logTypes: string[];
    scaling: { MinCapacity: number; MaxCapacity: number } | null | undefined;
  } {
    const refuse = (key: string, expected: string): never => {
      throw markNonRetryable(
        new ProvisioningError(
          safeMsg`Neptune DBCluster ${logicalId}: ${key} must be ${expected}; nothing was changed.`,
          resourceType,
          logicalId,
          origin.physicalId
        )
      );
    };
    const leaveOut = (key: string): void => {
      this.logger.warn(
        safeMsg`${logicalId} (${resourceType}): the recorded ${key} is unusable, so it is not sent.`
      );
    };
    const unusableList = (key: string, expected: string): string[] & ClusterRole[] => {
      if (!(origin.creating && origin.stateBorne)) return refuse(key, expected);
      leaveOut(key);
      return [];
    };
    const roles =
      clusterRoleList(properties['AssociatedRoles']) ??
      unusableList('AssociatedRoles', 'a list of objects with a RoleArn');
    const logTypes =
      stringList(properties['EnableCloudwatchLogsExports']) ??
      unusableList('EnableCloudwatchLogsExports', 'a list of strings');
    const scaling = serverlessScalingToSend(properties['ServerlessScalingConfiguration']);
    if (scaling === null) {
      if (!origin.stateBorne) {
        return refuse(
          'ServerlessScalingConfiguration',
          'an object with both a numeric MinCapacity and a numeric MaxCapacity'
        );
      }
      leaveOut('ServerlessScalingConfiguration');
    }
    return { roles, logTypes, scaling };
  }

  /**
   * Attach the `desired` roles that are not `live` and detach the `previous`
   * ones `desired` dropped, planned against the live list so a retry after a
   * partial run neither re-attaches nor re-detaches (neither call is
   * idempotent). A role cdkd never recorded is left alone. Both calls need
   * the cluster `available`, whatever `--no-wait` says. A ModifyDBCluster just
   * before can start only after the wait read `available`, so each call also
   * waits out and resends that refusal (#5194's rule).
   */
  private async applyClusterRoles(
    logicalId: string,
    physicalId: string,
    desired: readonly ClusterRole[],
    previous: readonly ClusterRole[],
    live: readonly DBClusterRole[],
    mask: ((text: string) => string) | undefined,
    marks: Pick<UpdateContext, 'markUnsettled' | 'markAttempted'> | undefined
  ): Promise<void> {
    const liveKeys = new Set(live.map(clusterRoleKey));
    const desiredKeys = new Set(desired.map(clusterRoleKey));
    const toAdd = desired.filter((role) => !liveKeys.has(clusterRoleKey(role)));
    const toRemove = previous.filter((role) => {
      const key = clusterRoleKey(role);
      return !desiredKeys.has(key) && liveKeys.has(key);
    });
    if (toAdd.length === 0 && toRemove.length === 0) return;

    // Bounded by the resource deadline, which does not cancel this operation:
    // a wait that outlives it would attach after the engine gave up.
    const waitBudgetMs = Math.min(
      ROLE_AVAILABLE_MAX_WAIT_MS,
      enclosingDeadlineRemainingMs() - DEADLINE_MARGIN_MS
    );
    if (waitBudgetMs <= 0) {
      throw new Error(
        'the resource timeout leaves no more time to change the roles of the cluster; re-run the deploy, or with a longer --resource-timeout'
      );
    }
    await this.waitForClusterAvailable(logicalId, physicalId, 'changing its roles', waitBudgetMs);
    marks?.markUnsettled?.('AssociatedRoles');
    const whenAvailable = (send: () => Promise<unknown>): Promise<void> =>
      modifyDbInstanceWhenAvailable({
        send,
        readStatus: async () => (await this.describeDBCluster(physicalId))?.Status,
        sleep: (ms) => this.sleep(ms),
        logger: this.logger,
        label: 'Neptune DBCluster',
        subject: 'cluster',
        logicalId,
        remainingMs: enclosingDeadlineRemainingMs(),
      });
    for (const role of toRemove) {
      await whenAvailable(() =>
        this.getClient().send(
          new RemoveRoleFromDBClusterCommand({ DBClusterIdentifier: physicalId, ...role })
        )
      );
    }
    for (const role of toAdd) {
      await whenAvailable(() =>
        this.getClient().send(
          new AddRoleToDBClusterCommand({ DBClusterIdentifier: physicalId, ...role })
        )
      );
      marks?.markAttempted?.('AssociatedRoles', [clusterRoleKey(role)]);
    }
    if (process.env['CDKD_NO_WAIT'] !== 'true') {
      await this.waitForClusterRolesSettled(
        logicalId,
        physicalId,
        new Set(toAdd.map(clusterRoleKey)),
        new Set(toRemove.map(clusterRoleKey)),
        mask
      );
    }
  }

  /**
   * Poll until every attached role has left `PENDING` and every detached one
   * has gone. AWS accepted both calls, so a role still settling at the cap, or
   * one AWS reports `INVALID`, is a warning: the cluster itself is fine, and a
   * throw from create() would strand it.
   */
  private async waitForClusterRolesSettled(
    logicalId: string,
    physicalId: string,
    attached: ReadonlySet<string>,
    detached: ReadonlySet<string>,
    mask: ((text: string) => string) | undefined
  ): Promise<void> {
    const shown = (keys: readonly string[]): string =>
      maskerOrIdentity(mask)(keys.map((key) => key.split('\n')[0] ?? '').join(', '));
    let unsettled: string[] = [];
    const settled = await this.pollUntilSettled(async () => {
      const roles = (await this.describeDBCluster(physicalId))?.AssociatedRoles ?? [];
      const byKey = new Map(roles.map((role) => [clusterRoleKey(role), role]));
      unsettled = [
        ...[...attached].filter((key) => (byKey.get(key)?.Status ?? 'PENDING') === 'PENDING'),
        ...[...detached].filter((key) => byKey.has(key)),
      ];
      if (unsettled.length > 0) return false;
      const invalid = [...attached].filter((key) => byKey.get(key)?.Status === 'INVALID');
      if (invalid.length > 0) {
        this.logger.warn(
          safeMsg`${logicalId}: Neptune reports ${shown(invalid)} as INVALID: the role is attached, but the cluster cannot assume it. Check the role's trust policy.`
        );
      }
      return true;
    });
    if (!settled) {
      this.logger.warn(
        safeMsg`${logicalId}: the IAM roles of the Neptune cluster had not settled when cdkd stopped waiting (${shown(unsettled)}).`
      );
    }
  }

  /**
   * Poll until a change AWS accepted reads back, so the observed baseline the
   * engine captures after update() does not record the old value (phantom
   * drift). The change was accepted, so the cap is a warning, not a failure.
   */
  private async waitForApplied(
    logicalId: string,
    what: string,
    applied: () => Promise<boolean>
  ): Promise<void> {
    if (await this.pollUntilSettled(applied)) return;
    this.logger.warn(
      safeMsg`${logicalId}: the new ${what} did not read back when cdkd stopped waiting; AWS accepted it, so a drift check may report it until it applies.`
    );
  }

  /**
   * Read at least once, then poll until `settled` answers true or the cap, the
   * tighter of {@link SETTLE_MAX_WAIT_MS} and what the resource deadline
   * leaves, so a cap stays a warning instead of the deadline's failure.
   */
  private async pollUntilSettled(settled: () => Promise<boolean>): Promise<boolean> {
    const capMs = Math.min(SETTLE_MAX_WAIT_MS, enclosingDeadlineRemainingMs() - DEADLINE_MARGIN_MS);
    const startTime = Date.now();
    let delay = 2_000;
    for (;;) {
      if (await settled()) return true;
      if (Date.now() - startTime + delay >= capMs) return false;
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  }

  private async describeDBCluster(dbClusterIdentifier: string) {
    const response = await this.getClient().send(
      new DescribeDBClustersCommand({
        DBClusterIdentifier: dbClusterIdentifier,
      })
    );
    return response.DBClusters?.[0];
  }

  /**
   * Issue #5544: ONE warning naming each `kept` property this update dropped,
   * which `update()` leaves at its live value because CloudFormation does too
   * (the type is in `removalHandledInUpdate`, so the caller names none of
   * them). The removed set is the caller's `removedProperties` when set, else
   * the two bags compared (a direct call). A `drift --revert` baseline is a
   * readback, not a template, so nothing there was removed. `DBPort` and
   * `Port` are one setting: dropping one while the other stays is no removal.
   * `measured` is whether the parity with CloudFormation is measured, and so
   * whether the warning may claim it.
   */
  private warnKeptRemovals(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    kept: readonly string[],
    context: UpdateContext | undefined,
    measured = true
  ): void {
    if (context?.desiredFromAwsReadback === true) return;
    const removed =
      context?.removedProperties ?? new Set(removedTemplateKeys(previousProperties, properties));
    const portStays = properties['DBPort'] != null || properties['Port'] != null;
    const names = kept.filter(
      (key) => removed.has(key) && !((key === 'DBPort' || key === 'Port') && portStays)
    );
    if (names.length === 0) return;
    const one = names.length === 1;
    const modify =
      resourceType === 'AWS::Neptune::DBInstance' ? 'ModifyDBInstance' : 'ModifyDBCluster';
    this.logger.warn(
      context?.replayingState === true
        ? safeMsg`${logicalId} (${resourceType}): ${one ? 'property' : 'properties'} ${names.join(', ')} ${one ? 'is' : 'are'} absent from the state being restored; ${modify} keeps a setting it is not sent, so the rollback leaves any value the failed deploy applied in place.`
        : safeMsg`${logicalId} (${resourceType}): ${one ? 'property' : 'properties'} ${names.join(', ')} ${one ? 'was' : 'were'} removed from the template; cdkd leaves the current AWS ${one ? 'value' : 'values'} in place${measured ? ', as CloudFormation does' : ''}. Declare ${one ? 'it' : 'them'} to change ${one ? 'it' : 'them'}.`
    );
  }

  /**
   * `PubliclyAccessible` as the boolean it means. Coercion alone would drop
   * `'no'` silently and leave the instance as it is, so a value that is no
   * boolean is refused before any call, except from a state-borne bag, which
   * the template cannot fix: left out, with a warning.
   */
  private readPublicAccess(
    properties: Record<string, unknown>,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    stateBorne: boolean
  ): boolean | undefined {
    const refusal = configBooleanRefusal(properties, 'PubliclyAccessible', logicalId);
    if (refusal === undefined) return coerceCfnBoolean(properties['PubliclyAccessible']);
    if (!stateBorne) {
      throw markNonRetryable(
        new ProvisioningError(
          safeMsg`Neptune DBInstance ${refusal}; nothing was changed.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the recorded PubliclyAccessible is unusable, so it is not sent.`
    );
    return undefined;
  }

  /**
   * go-to-k/cdkd#2762: a removed `PubliclyAccessible: true` KEEPS the instance
   * public, so the warning says so outright. Real CloudFormation A/Bs measured
   * both arms: a template removal (IamAuthEnabled on), and a rollback, where
   * the record lacks the key because the failed update added it, and the
   * rollback's keyless template left it true. A `drift --revert` baseline is a
   * readback, so nothing there was removed.
   */
  private warnPublicAccessKept(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): void {
    if (context?.desiredFromAwsReadback === true) return;
    const removed =
      context?.removedProperties ?? new Set(removedTemplateKeys(previousProperties, properties));
    if (!removed.has('PubliclyAccessible')) return;
    if (coerceCfnBoolean(previousProperties['PubliclyAccessible']) !== true) return;
    this.logger.warn(
      context?.replayingState === true
        ? safeMsg`${logicalId} (${resourceType}): PubliclyAccessible is absent from the state being restored, and ModifyDBInstance keeps a setting it is not sent, so the instance stays publicly accessible after this rollback, as CloudFormation leaves it. Set PubliclyAccessible: false to close it.`
        : safeMsg`${logicalId} (${resourceType}): PubliclyAccessible was removed from the template; the instance stays publicly accessible, as CloudFormation leaves it. Set PubliclyAccessible: false to close it.`
    );
  }

  /**
   * The `VpcSecurityGroupIds` a DBCluster update sends, or `undefined` to omit
   * it (ModifyDBCluster keeps the live groups then):
   *
   * - A non-empty declared list is sent as declared.
   * - An EMPTY list is omitted: `[]` would detach every group, and
   *   `readCurrentState` emits `[]` for a cluster with none, which
   *   `drift --revert` hands back as the desired bag.
   * - A list the previous template declared and the desired one omits is a
   *   removal (issue #1160). A real CloudFormation A/B showed CloudFormation
   *   then attaches the VPC's `default` security group in place of the
   *   declared ones, so cdkd looks that group up and sends it. A previous
   *   EMPTY list attached nothing, and a `drift --revert` baseline is a
   *   readback rather than a template, so neither counts as a removal.
   */
  private async dbClusterSecurityGroupsToSend(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<string[] | undefined> {
    const desired = properties['VpcSecurityGroupIds'] as string[] | undefined;
    if (desired !== undefined) return desired.length > 0 ? desired : undefined;
    const previous = previousProperties['VpcSecurityGroupIds'];
    if (context?.desiredFromAwsReadback === true) return undefined;
    if (!Array.isArray(previous) || previous.length === 0) return undefined;

    // `missing` names what the lookup did not find (terminal); `awsError` is a
    // failed call (left retryable).
    let groupId: string | undefined;
    let missing: string | undefined;
    let awsError: unknown;
    try {
      const subnetGroupName = (await this.describeDBCluster(physicalId))?.DBSubnetGroup;
      const vpcId = subnetGroupName
        ? (
            await this.getClient().send(
              new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: subnetGroupName })
            )
          ).DBSubnetGroups?.[0]?.VpcId
        : undefined;
      if (!subnetGroupName) missing = 'the cluster reports no DB subnet group';
      else if (!vpcId) missing = `DB subnet group ${subnetGroupName} reports no VPC`;
      else {
        const groups = await this.getEc2Client().send(
          new DescribeSecurityGroupsCommand({
            Filters: [
              { Name: 'vpc-id', Values: [vpcId] },
              { Name: 'group-name', Values: ['default'] },
            ],
          })
        );
        groupId = groups.SecurityGroups?.[0]?.GroupId;
        if (!groupId) missing = `VPC ${vpcId} has no security group named default`;
      }
    } catch (error) {
      awsError = error;
    }
    if (groupId === undefined) {
      // go-to-k/cdkd#2319: the thrown message is persisted, so an AWS failure
      // contributes only its summary (an EC2 UnauthorizedOperation names the
      // caller's ARN). The full text goes to debug, masked, and the retry
      // classifier reads it on `cause`.
      const mask = context?.maskSecrets ?? ((text: string) => text);
      const failure = missing === undefined ? describeAwsFailure(awsError) : undefined;
      if (failure?.redacted === true) {
        this.logger.debug(
          safeMsg`${logicalId}: the VPC default security group lookup failed: ${mask(failure.detail)}`
        );
      }
      const shown = mask(failure?.summary ?? '');
      const refusal = new ProvisioningError(
        `Failed to update Neptune DBCluster ${logicalId}: VpcSecurityGroupIds was removed from the template, so the cluster moves to its VPC's default security group (as CloudFormation does), but cdkd could not find that group: ${missing ?? shown}. Declare VpcSecurityGroupIds in the template to choose the cluster's security groups.`,
        resourceType,
        logicalId,
        physicalId,
        awsError instanceof Error ? awsError : undefined
      );
      if (missing !== undefined) throw markNonRetryable(refusal);
      // Stamped whenever the message lost text the cause still holds: the
      // AWS-authored summary, or a masker edit (the classifier must not miss
      // retry wording a secret overlapped).
      const withheld =
        awsError instanceof Error &&
        (failure?.redacted === true || shown !== (failure?.summary ?? ''));
      throw withheld ? markRedactedCause(refusal) : refusal;
    }
    // A warning, not info: the default group may grant wider access.
    this.logger.warn(
      safeMsg`${logicalId}: VpcSecurityGroupIds was removed from the template; attaching the VPC's default security group ${groupId}, as CloudFormation does.`
    );
    return [groupId];
  }

  private async describeDBInstance(dbInstanceIdentifier: string) {
    const response = await this.getClient().send(
      new DescribeDBInstancesCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
      })
    );
    return response.DBInstances?.[0];
  }

  /**
   * Issue #1160: wait out a member instance's `modifying` after its cluster's
   * security groups changed. Only that transition is waited out: a member in
   * a lasting state (maintenance, upgrading, storage-optimization, ...) or
   * deleted out of band does not hold the update, as CloudFormation reports
   * the cluster updated in those cases too.
   */
  private async waitForMemberAfterSecurityGroupChange(
    dbInstanceIdentifier: string,
    clusterLogicalId: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;
    while (Date.now() - startTime < maxWaitMs) {
      let status: string | undefined;
      try {
        status = (await this.describeDBInstance(dbInstanceIdentifier))?.DBInstanceStatus;
      } catch (error) {
        if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) return;
        throw error;
      }
      if (status !== 'modifying') return;
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    // The member's identifier is the physical id of ANOTHER resource, which
    // this cluster's masking bag does not cover (it can be secret-derived), so
    // only the cluster's logical id is named.
    throw new Error(
      safeMsg`Timed out waiting for a member instance of Neptune DBCluster ${clusterLogicalId} to finish applying its new VPC security groups`
    );
  }

  /**
   * A cluster read inside the security-group wait (issue #5419). A vanished
   * cluster or a terminal status (`isTerminalDbWaitStatus`) never reaches the
   * awaited state, so fail now rather than after the 30-minute budget.
   */
  private requireClusterWhileWaiting(cluster: DBCluster | undefined, logicalId: string): DBCluster {
    // A deleted cluster usually throws DBClusterNotFoundFault from the describe
    // itself; this arm covers an empty `DBClusters` list.
    if (cluster === undefined) {
      throw new Error(
        safeMsg`DescribeDBClusters returned no cluster for Neptune DBCluster ${logicalId} while waiting for its new VPC security groups`
      );
    }
    if (isTerminalDbWaitStatus(cluster.Status)) {
      throw new Error(
        safeMsg`Neptune DBCluster ${logicalId} entered status ${cluster.Status ?? ''} while applying its new VPC security groups`
      );
    }
    return cluster;
  }

  /**
   * Wait until the cluster is out of `modifying` AND reports exactly `expected` as
   * its VPC security groups, all `active` (issue #1160). Being out of
   * `modifying` alone can still read before the group swap has started; the
   * group statuses cannot.
   */
  private async waitForSecurityGroupsApplied(
    dbClusterIdentifier: string,
    logicalId: string,
    expected: readonly string[],
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const want = [...new Set(expected)].sort().join(' ');
    const startTime = Date.now();
    let delay = 5_000;
    while (Date.now() - startTime < maxWaitMs) {
      const cluster = this.requireClusterWhileWaiting(
        await this.describeDBCluster(dbClusterIdentifier),
        logicalId
      );
      const groups = cluster.VpcSecurityGroups ?? [];
      const ids = groups
        .map((group) => group.VpcSecurityGroupId ?? '')
        .sort()
        .join(' ');
      // `modifying` is the swap's own transition; any lasting state (backing-up,
      // maintenance, ...) is not this change's to wait out.
      const settled =
        cluster.Status !== 'modifying' &&
        groups.every((group) => group.Status === 'active') &&
        ids === want;
      if (settled) return;
      this.logger.debug(
        safeMsg`Neptune DBCluster ${logicalId} security groups not settled yet (status ${cluster.Status ?? 'unknown'})`
      );
      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    throw new Error(
      `Timed out waiting for Neptune DBCluster ${logicalId} to apply its new VPC security groups`
    );
  }

  /**
   * Issues #5155 / #5184: the final-snapshot delete after a `--remove-protection`
   * flip (deleteAfterProtectionFlipWithFinalSnapshot owns the wait, the retry
   * and their bounds).
   */
  private async deleteAfterProtectionFlip(
    logicalId: string,
    physicalId: string,
    send: () => Promise<unknown>
  ): Promise<void> {
    await deleteAfterProtectionFlipWithFinalSnapshot({
      stateFault: 'InvalidDBClusterStateFault',
      send,
      noun: 'cluster',
      label: 'Neptune DBCluster',
      logicalId,
      read: async () => {
        const current = await this.describeDBCluster(physicalId);
        return current === undefined
          ? undefined
          : { deletionProtection: current.DeletionProtection, status: current.Status };
      },
      sleep: (ms) => this.sleep(ms),
      logger: this.logger,
      remainingMs: enclosingDeadlineRemainingMs(),
    });
  }

  /**
   * Wait for a Neptune DBCluster to become available. A terminal status
   * (`isTerminalDbWaitStatus`) fails at once rather than after the
   * 30-minute budget (issue #5426).
   */
  private async waitForClusterAvailable(
    logicalId: string,
    dbClusterIdentifier: string,
    during = 'being created',
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      const cluster = await this.describeDBCluster(dbClusterIdentifier);
      const status = cluster?.Status;

      this.logger.debug(`Neptune DBCluster ${dbClusterIdentifier} status: ${status}`);

      if (status === 'available') return;
      // Issue #5426: a terminal status never becomes 'available'.
      if (isTerminalDbWaitStatus(status)) {
        throw new Error(
          safeMsg`Neptune DBCluster ${logicalId} entered status ${status ?? ''} while ${during}, which it does not leave on its own`
        );
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(
      `Timed out waiting for Neptune DBCluster ${dbClusterIdentifier} to become available`
    );
  }

  /**
   * Wait for a DBCluster to be deleted (no SDK waiter — manual poll).
   */
  private async waitForClusterDeleted(
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const cluster = await this.describeDBCluster(dbClusterIdentifier);
        const status = cluster?.Status;

        this.logger.debug(`Neptune DBCluster ${logicalId} status: ${status}`);

        if (!cluster) return;
      } catch (error) {
        if (this.isNotFoundError(error, 'DBClusterNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for Neptune DBCluster ${logicalId} to be deleted`);
  }

  /**
   * Wait for a Neptune DBInstance to become available. A terminal status
   * (`isTerminalDbWaitStatus`) fails at once rather than after the
   * 30-minute budget (issue #5426).
   */
  private async waitForInstanceAvailable(
    logicalId: string,
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      const instance = await this.describeDBInstance(dbInstanceIdentifier);
      const status = instance?.DBInstanceStatus;

      this.logger.debug(`Neptune DBInstance ${dbInstanceIdentifier} status: ${status}`);

      if (status === 'available') return;
      // Issue #5426: a terminal status never becomes 'available'.
      if (isTerminalDbWaitStatus(status)) {
        throw new Error(
          safeMsg`Neptune DBInstance ${logicalId} entered status ${status ?? ''} while being created, which it does not leave on its own`
        );
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(
      `Timed out waiting for Neptune DBInstance ${dbInstanceIdentifier} to become available`
    );
  }

  private async waitForInstanceDeleted(
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const instance = await this.describeDBInstance(dbInstanceIdentifier);
        const status = instance?.DBInstanceStatus;

        this.logger.debug(`Neptune DBInstance ${dbInstanceIdentifier} status: ${status}`);

        if (!instance) return;
      } catch (error) {
        if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(
      `Timed out waiting for Neptune DBInstance ${dbInstanceIdentifier} to be deleted`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * What no read answers for drift. `DBInstanceParameterGroupName` and
   * `AllowMajorVersionUpgrade` are write-only per-call flags.
   * `AvailabilityZones` is create-only, and DescribeDBClusters reports the
   * zones AWS placed the cluster in, which need not be the declared list.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType === 'AWS::Neptune::DBCluster') {
      return ['AvailabilityZones', 'DBInstanceParameterGroupName'];
    }
    if (resourceType === 'AWS::Neptune::DBInstance') return ['AllowMajorVersionUpgrade'];
    return [];
  }

  /**
   * Sets to AWS, answered in its own order. Also what `unsettledAfterUpdate`
   * compares by, so a template ordering them differently still settles.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    return resourceType === 'AWS::Neptune::DBCluster'
      ? ['AssociatedRoles', 'EnableCloudwatchLogsExports', 'VpcSecurityGroupIds']
      : [];
  }

  /**
   * go-to-k/cdkd#5487: the live values of a record's unsettled names. The two
   * diffed lists keep only the entries the record, the template or an earlier
   * attempt (#5498) names: the convergence puts this on the previous side, so
   * a role or log type an out-of-band change added would otherwise read as
   * dropped by the template, and be detached.
   */
  async readUnsettled(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>,
    desiredProperties?: Record<string, unknown>,
    attemptedItems?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const live = await this.readCurrentState(physicalId, logicalId, resourceType);
    if (resourceType !== 'AWS::Neptune::DBCluster') return live;
    if (live === undefined || live === RESOURCE_NOT_FOUND) return live;
    const attempted = (key: string): string[] =>
      [...(attemptedItems?.get(key) ?? [])].filter(isUsableAttemptedName);
    const out = { ...live };
    if (names.has('AssociatedRoles')) {
      const named = new Set([
        ...(clusterRoleList(recordedProperties?.['AssociatedRoles']) ?? []).map(clusterRoleKey),
        ...(clusterRoleList(desiredProperties?.['AssociatedRoles']) ?? []).map(clusterRoleKey),
        ...attempted('AssociatedRoles'),
      ]);
      out['AssociatedRoles'] = ((live['AssociatedRoles'] ?? []) as ClusterRole[]).filter((role) =>
        named.has(clusterRoleKey(role))
      );
    }
    if (names.has('EnableCloudwatchLogsExports')) {
      const named = new Set([
        ...(stringList(recordedProperties?.['EnableCloudwatchLogsExports']) ?? []),
        ...(stringList(desiredProperties?.['EnableCloudwatchLogsExports']) ?? []),
        ...attempted('EnableCloudwatchLogsExports'),
      ]);
      out['EnableCloudwatchLogsExports'] = (
        (live['EnableCloudwatchLogsExports'] ?? []) as string[]
      ).filter((type) => named.has(type));
    }
    return out;
  }

  /**
   * go-to-k/cdkd#5380: every name while AWS is still changing the resource: a
   * status other than `available`, or a pending modification (a change waiting
   * for its window, or a log export on its way). ModifyDBCluster is refused
   * while `upgrading`, and a pending value is not yet the one a read reports.
   * A failed read keeps every name.
   */
  async unsettledInTransition(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    names: ReadonlySet<string>
  ): Promise<ReadonlySet<string>> {
    const hasPending = (pending: object | undefined): boolean =>
      Object.values(pending ?? {}).some((value) => value !== undefined);
    try {
      if (resourceType === 'AWS::Neptune::DBCluster') {
        const cluster = await this.describeDBCluster(physicalId);
        const settled =
          cluster?.Status === 'available' && !hasPending(cluster.PendingModifiedValues);
        return settled ? new Set() : names;
      }
      if (resourceType === 'AWS::Neptune::DBInstance') {
        const instance = await this.describeDBInstance(physicalId);
        const settled =
          instance?.DBInstanceStatus === 'available' && !hasPending(instance.PendingModifiedValues);
        return settled ? new Set() : names;
      }
      return new Set();
    } catch {
      return names;
    }
  }

  /**
   * Adopt an existing Neptune resource into cdkd state.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::Neptune::DBInstance':
        return this.importDBInstance(input);
      case 'AWS::Neptune::DBCluster':
        return this.importDBCluster(input);
      case 'AWS::Neptune::DBSubnetGroup':
        return this.importDBSubnetGroup(input);
      default:
        return null;
    }
  }

  /**
   * Read the AWS-current Neptune resource configuration in CFn-property
   * shape. Each branch surfaces only the keys cdkd's `create()` accepts.
   * Sensitive fields are NEVER surfaced. `Tags` are surfaced via a
   * follow-up `ListTagsForResource(ResourceName=arn)` call.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    switch (resourceType) {
      case 'AWS::Neptune::DBInstance':
        return this.readCurrentStateDBInstance(physicalId);
      case 'AWS::Neptune::DBCluster':
        return this.readCurrentStateDBCluster(physicalId);
      case 'AWS::Neptune::DBSubnetGroup':
        return this.readCurrentStateDBSubnetGroup(physicalId);
      default:
        return undefined;
    }
  }

  private async readCurrentStateDBInstance(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let inst;
    try {
      inst = await this.describeDBInstance(physicalId);
    } catch (err) {
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'DBInstanceNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err, 'DBInstanceNotFoundFault')) return undefined;
      throw err;
    }
    if (!inst) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (inst.DBInstanceIdentifier !== undefined) {
      result['DBInstanceIdentifier'] = inst.DBInstanceIdentifier;
    }
    if (inst.DBInstanceClass !== undefined) result['DBInstanceClass'] = inst.DBInstanceClass;
    if (inst.DBClusterIdentifier !== undefined) {
      result['DBClusterIdentifier'] = inst.DBClusterIdentifier;
    }
    if (inst.DBSubnetGroup?.DBSubnetGroupName !== undefined) {
      result['DBSubnetGroupName'] = inst.DBSubnetGroup.DBSubnetGroupName;
    }
    if (inst.AvailabilityZone !== undefined) result['AvailabilityZone'] = inst.AvailabilityZone;
    if (inst.PreferredMaintenanceWindow !== undefined) {
      result['PreferredMaintenanceWindow'] = inst.PreferredMaintenanceWindow;
    }
    if (inst.AutoMinorVersionUpgrade !== undefined) {
      result['AutoMinorVersionUpgrade'] = inst.AutoMinorVersionUpgrade;
    }
    if (inst.DeletionProtection !== undefined) {
      result['DeletionProtection'] = inst.DeletionProtection;
    }
    if (inst.PubliclyAccessible !== undefined) {
      result['PubliclyAccessible'] = inst.PubliclyAccessible;
    }
    // DBParameterGroupName: Neptune's DescribeDBInstances returns
    // DBParameterGroups[] — surface the first entry's name when present.
    const pg = inst.DBParameterGroups?.[0]?.DBParameterGroupName;
    if (pg !== undefined) result['DBParameterGroupName'] = pg;

    if (inst.DBInstanceArn) await this.attachTags(result, inst.DBInstanceArn);
    return result;
  }

  private async readCurrentStateDBCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let cluster;
    try {
      cluster = await this.describeDBCluster(physicalId);
    } catch (err) {
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'DBClusterNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err, 'DBClusterNotFoundFault')) return undefined;
      throw err;
    }
    if (!cluster) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (cluster.DBClusterIdentifier !== undefined) {
      result['DBClusterIdentifier'] = cluster.DBClusterIdentifier;
    }
    if (cluster.EngineVersion !== undefined) result['EngineVersion'] = cluster.EngineVersion;
    // CFn schema spells the writable port field `DBPort`; `Port` is the
    // (readOnly) output field. Emit BOTH so drift works for state files
    // written by either the new `DBPort` (post-#613 fix) or the legacy
    // `Port` template shape.
    if (cluster.Port !== undefined) {
      result['Port'] = cluster.Port;
      result['DBPort'] = cluster.Port;
    }
    result['VpcSecurityGroupIds'] = (cluster.VpcSecurityGroups ?? [])
      .map((sg) => sg.VpcSecurityGroupId)
      .filter((id): id is string => !!id);
    if (cluster.DBSubnetGroup !== undefined) result['DBSubnetGroupName'] = cluster.DBSubnetGroup;
    if (cluster.StorageEncrypted !== undefined) {
      result['StorageEncrypted'] = cluster.StorageEncrypted;
    }
    if (cluster.KmsKeyId !== undefined) result['KmsKeyId'] = cluster.KmsKeyId;
    if (cluster.BackupRetentionPeriod !== undefined) {
      result['BackupRetentionPeriod'] = cluster.BackupRetentionPeriod;
    }
    if (cluster.PreferredBackupWindow !== undefined) {
      result['PreferredBackupWindow'] = cluster.PreferredBackupWindow;
    }
    if (cluster.PreferredMaintenanceWindow !== undefined) {
      result['PreferredMaintenanceWindow'] = cluster.PreferredMaintenanceWindow;
    }
    if (cluster.DBClusterParameterGroup !== undefined) {
      result['DBClusterParameterGroupName'] = cluster.DBClusterParameterGroup;
    }
    if (cluster.IAMDatabaseAuthenticationEnabled !== undefined) {
      result['IamAuthEnabled'] = cluster.IAMDatabaseAuthenticationEnabled;
    }
    if (cluster.DeletionProtection !== undefined) {
      result['DeletionProtection'] = cluster.DeletionProtection;
    }
    if (cluster.CopyTagsToSnapshot !== undefined) {
      result['CopyTagsToSnapshot'] = cluster.CopyTagsToSnapshot;
    }
    if (cluster.NetworkType !== undefined) result['NetworkType'] = cluster.NetworkType;
    const { MinCapacity: min, MaxCapacity: max } = cluster.ServerlessV2ScalingConfiguration ?? {};
    if (min !== undefined || max !== undefined) {
      result['ServerlessScalingConfiguration'] = {
        ...(min !== undefined && { MinCapacity: min }),
        ...(max !== undefined && { MaxCapacity: max }),
      };
    }
    // Always a list, as VpcSecurityGroupIds: a role or log type lost out of
    // band must read as a change against the recorded list.
    result['EnableCloudwatchLogsExports'] = cluster.EnabledCloudwatchLogsExports ?? [];
    result['AssociatedRoles'] = (cluster.AssociatedRoles ?? []).map((role) => ({
      RoleArn: role.RoleArn,
      ...(role.FeatureName ? { FeatureName: role.FeatureName } : {}),
    }));
    if (cluster.DBClusterArn) await this.attachTags(result, cluster.DBClusterArn);
    return result;
  }

  private async readCurrentStateDBSubnetGroup(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let resp: {
      DBSubnetGroups?: Array<{
        DBSubnetGroupName?: string;
        DBSubnetGroupArn?: string;
        DBSubnetGroupDescription?: string;
        Subnets?: Array<{ SubnetIdentifier?: string }>;
      }>;
    };
    try {
      resp = (await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
      )) as unknown as typeof resp;
    } catch (err) {
      // go-to-k/cdkd#4283: only the fault NAME proves the resource is gone;
      // the looser message match keeps its old "cannot tell" answer.
      if ((err as { name?: unknown } | null)?.name === 'DBSubnetGroupNotFoundFault')
        return RESOURCE_NOT_FOUND;
      if (this.isNotFoundError(err, 'DBSubnetGroupNotFoundFault')) return undefined;
      throw err;
    }
    const sg = resp.DBSubnetGroups?.[0];
    if (!sg) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (sg.DBSubnetGroupName !== undefined) result['DBSubnetGroupName'] = sg.DBSubnetGroupName;
    if (sg.DBSubnetGroupDescription !== undefined) {
      result['DBSubnetGroupDescription'] = sg.DBSubnetGroupDescription;
    }
    result['SubnetIds'] = (sg.Subnets ?? [])
      .map((s) => s.SubnetIdentifier)
      .filter((id): id is string => !!id);
    if (sg.DBSubnetGroupArn) await this.attachTags(result, sg.DBSubnetGroupArn);
    return result;
  }

  /**
   * Fetch tags via `ListTagsForResource` and merge them into the result
   * under `Tags` (CFn shape). Best-effort.
   */
  private async attachTags(result: Record<string, unknown>, arn: string): Promise<void> {
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ ResourceName: arn })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.TagList);
      result['Tags'] = tags;
    } catch (err) {
      this.logger.debug(
        `Neptune ListTagsForResource(${arn}) failed: ${describeAwsFailure(err).detail}`
      );
    }
  }

  private async importDBInstance(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBInstanceIdentifier');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeDBInstancesCommand({ DBInstanceIdentifier: explicit })
        );
        // The map `create()` records, from the describe this verification
        // already issues (issue #1852). It is what heals a record written
        // under `--no-wait` while the instance was still `creating`
        // (go-to-k/cdkd#3077): the deploy engine re-reads through `import()`
        // when a `Fn::GetAtt` misses. `definedAttributes` keeps an unassigned
        // endpoint ABSENT, so a still-`creating` instance heals nothing.
        const described = resp.DBInstances?.[0];
        return {
          physicalId: explicit,
          attributes: instanceAttributes(described),
        };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBInstanceNotFoundFault') return null;
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // DB instance reaching here needs an explicit `--resource` override.
    return null;
  }

  private async importDBCluster(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBClusterIdentifier');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeDBClustersCommand({ DBClusterIdentifier: explicit })
        );
        // Issue #3627: the same map `create()` records.
        return { physicalId: explicit, attributes: clusterAttributes(resp.DBClusters?.[0]) };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBClusterNotFoundFault') return null;
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // DB cluster reaching here needs an explicit `--resource` override.
    return null;
  }

  private async importDBSubnetGroup(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBSubnetGroupName');
    if (explicit) {
      try {
        await this.getClient().send(
          new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: explicit })
        );
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if ((err as { name?: string }).name === 'DBSubnetGroupNotFoundFault') return null;
        throw err;
      }
    }
    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // DB subnet group reaching here needs an explicit `--resource` override.
    return null;
  }
}

/**
 * Whether the VpcSecurityGroupIds a cluster update SENDS differs from the
 * previous template's list (order-insensitive). `sent === undefined` sends
 * nothing, so nothing changes.
 */
function securityGroupListChanged(sent: readonly string[] | undefined, previous: unknown): boolean {
  if (sent === undefined) return false;
  const before = Array.isArray(previous)
    ? previous.filter((id): id is string => typeof id === 'string')
    : [];
  return [...sent].sort().join(' ') !== [...before].sort().join(' ');
}
