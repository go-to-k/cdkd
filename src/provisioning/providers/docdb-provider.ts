import {
  DocDBClient,
  CreateDBClusterCommand,
  DeleteDBClusterCommand,
  ModifyDBClusterCommand,
  DescribeDBClustersCommand,
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  ModifyDBInstanceCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-docdb';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { clearOnUpdateRemoval, withRemovalDefaults } from '../update-removal.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceIdentityVerdict,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { definedAttributes, stringifyIfAssigned } from '../attribute-map.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { refuseMalformedDesiredTags } from '../tag-list.js';
import { applyDocDBTagDiff, attachDocDBTags, isDocDBNotFoundError } from './docdb-shared.js';
import {
  ProtectionFlipRegistry,
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  rdsFamilyProtectionSite,
  type ProtectionFlipRecord,
} from './deletion-protection-compensation.js';

/**
 * The attribute map a DocumentDB DB cluster records (issue #3650), under
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
    Arn: cluster?.DBClusterArn,
    ClusterResourceId: cluster?.DbClusterResourceId,
  });
}

/**
 * The attribute map a DocumentDB DB instance records (issue #3650): `Endpoint` /
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
 * template may spell it (the service lower-cases it).
 */
function isDbIdentifier(id: string): boolean {
  return id.length <= 63 && /^[A-Za-z](?:-?[A-Za-z0-9])*$/.test(id);
}

/**
 * AWS DocumentDB Provider
 *
 * Implements resource provisioning for DocumentDB resources:
 * - AWS::DocDB::DBCluster
 * - AWS::DocDB::DBInstance
 *
 * `AWS::DocDB::DBSubnetGroup` has its own provider,
 * `DocDBSubnetGroupProvider`: see {@link DocDBProvider.disableCcApiFallback}.
 *
 * WHY a dedicated SDK provider (instead of CC API fallback):
 *   1. Owns the `--remove-protection` flip-off for `AWS::DocDB::DBCluster`.
 *      DocDB inherits the RDS-shaped `DeletionProtection` boolean on the
 *      cluster (NOT on the instance — DocDB DBInstance has no
 *      DeletionProtection field per the AWS SDK), and the bypass logic
 *      lives in per-type SDK providers, not in `cloud-control-provider.ts`.
 *   2. Direct SDK calls avoid CC API polling overhead. DocDB cluster /
 *      instance creation still takes time (1–5 min), so we poll
 *      `DescribeDBClusters` / `DescribeDBInstances` until status flips to
 *      `available`.
 *
 * DocDB's API shapes mirror the RDS API exactly (the AWS team copied them
 * across); see `rds-provider.ts` for the structural template.
 */
export class DocDBProvider implements ResourceProvider {
  private docdbClient?: DocDBClient;
  private createClient?: DocDBClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('DocDBProvider');
  /**
   * What a `--remove-protection` flip did, per resource, across the outer
   * retry loop's re-entries (issue #2204; the mechanism is
   * `./deletion-protection-compensation.ts`).
   */
  private readonly protectionFlips = new ProtectionFlipRegistry();

  /**
   * `AWS::DocDB::DBCluster` and `AWS::DocDB::DBInstance` are
   * `ProvisioningType: NON_PROVISIONABLE` — Cloud Control has no handlers for
   * them — so the #614 silent-drop auto-route must not send a template using
   * an unhandled property (`EnableCloudwatchLogsExports`, `StorageType`,
   * `CACertificateIdentifier`, ...) to CC, where it fails mid-deploy with an
   * opaque UnsupportedActionException. With this opt-out the registry refuses
   * such a template pre-flight (issue #3866).
   *
   * The flag is per PROVIDER, which is why `AWS::DocDB::DBSubnetGroup` — a
   * type Cloud Control CAN manage — lives in `DocDBSubnetGroupProvider`, keeping
   * its Cloud Control route. Do not register it on this class again.
   */
  readonly disableCcApiFallback = true;

  /**
   * Issue #1160: the CFn default a property REMOVED from the template is
   * reset to — the Modify/Update API keeps an absent field's live value.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    ['AWS::DocDB::DBCluster', new Map<string, unknown>([['DeletionProtection', false]])],
  ]);

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DocDB::DBCluster',
      new Set([
        'DBClusterIdentifier',
        'EngineVersion',
        'MasterUsername',
        'MasterUserPassword',
        'Port',
        'VpcSecurityGroupIds',
        'DBSubnetGroupName',
        'StorageEncrypted',
        'KmsKeyId',
        'BackupRetentionPeriod',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'DBClusterParameterGroupName',
        'DeletionProtection',
        'Tags',
      ]),
    ],
    [
      'AWS::DocDB::DBInstance',
      // DocDB DBInstance does NOT support DeletionProtection (verified
      // against the @aws-sdk/client-docdb CreateDBInstanceMessage type —
      // the field is absent). Cluster-level DeletionProtection covers the
      // common case anyway; instance deletes are gated by the cluster's
      // protection flag in normal use.
      new Set([
        'DBInstanceIdentifier',
        'DBInstanceClass',
        'DBClusterIdentifier',
        'AvailabilityZone',
        'PreferredMaintenanceWindow',
        'AutoMinorVersionUpgrade',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): DocDBClient {
    if (!this.docdbClient) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.docdbClient = new DocDBClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new DocDBClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.docdbClient;
  }

  /**
   * The client `CreateDBCluster` / `CreateDBInstance` go through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * Neither carries an idempotency token, and each identifier is unique per
   * account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/_contents/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): DocDBClient {
    this.getClient();
    return this.createClient as DocDBClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::DocDB::DBCluster':
        return this.createDBCluster(logicalId, resourceType, properties);
      case 'AWS::DocDB::DBInstance':
        return this.createDBInstance(logicalId, resourceType, properties);
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
    properties = withRemovalDefaults(
      this.removalDefaults,
      resourceType,
      properties,
      previousProperties,
      context
    );
    switch (resourceType) {
      case 'AWS::DocDB::DBCluster':
        return this.updateDBCluster(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::DocDB::DBInstance':
        return this.updateDBInstance(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
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
      case 'AWS::DocDB::DBCluster':
        return this.deleteDBCluster(logicalId, physicalId, resourceType, context);
      case 'AWS::DocDB::DBInstance':
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

  // ─── DBCluster ────────────────────────────────────────────────────

  private async createDBCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DocDB DBCluster ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const dbClusterIdentifier =
      (properties['DBClusterIdentifier'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 63, lowercase: true });

    // go-to-k/cdkd#4583: set once CreateDBCluster returned (no self-cleanup).
    let clusterCreated = false;
    // go-to-k/cdkd#4606: the `DbClusterResourceId` CreateDBCluster returned,
    // carried on the failure's mark as the orphan's identity.
    let createdResourceId: string | undefined;
    try {
      const response = await this.getCreateClient().send(
        new CreateDBClusterCommand({
          DBClusterIdentifier: dbClusterIdentifier,
          // DocDB engine value is fixed: only `docdb` is accepted.
          Engine: 'docdb',
          EngineVersion: properties['EngineVersion'] as string | undefined,
          MasterUsername: properties['MasterUsername'] as string | undefined,
          MasterUserPassword: properties['MasterUserPassword'] as string | undefined,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
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
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );
      clusterCreated = true;
      createdResourceId = response.DBCluster?.DbClusterResourceId;

      const cluster = response.DBCluster;
      if (!cluster) {
        throw new Error('CreateDBCluster did not return DBCluster');
      }

      this.logger.debug(
        `Successfully created DocDB DBCluster ${logicalId}: ${dbClusterIdentifier}`
      );

      // Wait for cluster to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForClusterAvailable(dbClusterIdentifier);
      }

      // Describe to get final attributes
      const described = await this.describeDBCluster(dbClusterIdentifier);

      return {
        physicalId: dbClusterIdentifier,
        attributes: clusterAttributes(described),
      };
    } catch (error) {
      const thrown =
        error instanceof ProvisioningError
          ? error
          : new ProvisioningError(
              `Failed to create DocDB DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
              resourceType,
              logicalId,
              dbClusterIdentifier,
              error instanceof Error ? error : undefined
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
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DocDB DBCluster ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    try {
      // Class 2 — `VpcSecurityGroupIds: []` would CLEAR all SGs on the
      // cluster. readCurrentState always-emits `[]` for clusters that
      // legitimately have no VPC SGs; the round-trip must NOT translate
      // that placeholder into a destructive SDK call.
      const vpcSgIds = properties['VpcSecurityGroupIds'] as string[] | undefined;
      const sendVpcSgIds = vpcSgIds !== undefined && vpcSgIds.length > 0;

      // #1160 reset-on-removal — ModifyDBCluster has merge semantics (an
      // absent input field means "no change"), so a property REMOVED from
      // the template must be sent as its explicit CFn-default reset value
      // via `removalDefaults` or a local `clearOnUpdateRemoval`. Deliberately
      // NOT reset here:
      //   * EngineVersion — removal would imply moving to the engine's
      //     default version, a risky (possibly major) version change cdkd
      //     must not synthesize; leave unchanged.
      //   * DBClusterParameterGroupName — the default is the
      //     engine-version-dependent `default.docdb5.0`-style family name;
      //     synthesizing it from a removal risks a wrong-family apply.
      //   * PreferredBackupWindow / PreferredMaintenanceWindow — AWS assigns
      //     a RANDOM window at create; there is no documented "reset to
      //     random" sentinel.
      //   * MasterUserPassword — a secret; removal cannot synthesize a
      //     reset value.
      //   * VpcSecurityGroupIds — deliberate empty-guard above
      //     (readCurrentState placeholder defense); classified UNCERTAIN in
      //     the #1160 audit, out of this batch's scope.
      //   * Port — DocDB documents a fixed default (27017), but resetting
      //     the port is connection-breaking for every client; leave unchanged.
      await this.getClient().send(
        new ModifyDBClusterCommand({
          DBClusterIdentifier: physicalId,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          // CFn default: deletion protection isn't enabled by default
          // (live-verified 2026-07-27: a cluster created without the field
          // reads DeletionProtection=false).
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          // CFn/API default: 1 day (ModifyDBClusterMessage doc).
          BackupRetentionPeriod: clearOnUpdateRemoval(
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
            previousProperties['BackupRetentionPeriod'] != null
              ? Number(previousProperties['BackupRetentionPeriod'])
              : undefined,
            1
          ),
          PreferredBackupWindow: properties['PreferredBackupWindow'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          DBClusterParameterGroupName: properties['DBClusterParameterGroupName'] as
            | string
            | undefined,
          ...(sendVpcSgIds && { VpcSecurityGroupIds: vpcSgIds }),
          MasterUserPassword: properties['MasterUserPassword'] as string | undefined,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated DocDB DBCluster ${logicalId}`);

      const described = await this.describeDBCluster(physicalId);

      if (described?.DBClusterArn) {
        await applyDocDBTagDiff(
          this.getClient(),
          this.logger,
          described.DBClusterArn,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: clusterAttributes(described),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DocDB DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * The compensation boundary (issue #2204): a `--remove-protection` flip whose
   * delete then fails terminally is undone here, so a destroy that did not
   * happen does not leave a live cluster with its guard stripped. DocDB
   * instances carry no guard of their own, so the cluster is the only site.
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
          cliService: 'docdb',
          serviceLabel: 'DocDB',
          kind: 'cluster',
          physicalId,
          region: context?.expectedRegion,
          notFoundFault: 'DBClusterNotFoundFault',
          isNotFound: (error) => isDocDBNotFoundError(error, 'DBClusterNotFoundFault'),
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
    this.logger.debug(`Deleting DocDB DBCluster ${logicalId}`);

    try {
      // `--remove-protection`: flip DeletionProtection off in-place
      // before delete. Idempotent — DocDB accepts the call when protection
      // is already disabled. Non-fatal: log at debug if the flip-off
      // errors (e.g. NotFound) so the actual delete still proceeds.
      // The pre-flip readback is what lets a terminal failure restore ONLY a
      // guard this run turned off (issue #2204).
      if (context?.removeProtection === true) {
        try {
          await observeThenDisableProtection({
            flip,
            logger: this.logger,
            physicalId,
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
            `Disabled DeletionProtection on DocDB DBCluster ${logicalId} before delete`
          );
        } catch (disableError) {
          if (!isDocDBNotFoundError(disableError, 'DBClusterNotFoundFault')) {
            this.logger.debug(
              `Could not disable deletion protection for DocDB DBCluster ${logicalId}: ${describeAwsFailure(disableError).detail}`
            );
          }
        }
      }

      // `DeletionPolicy: Snapshot` (issue #1352): flip to the atomic
      // final-snapshot delete when the destroy call site passed an id.
      const finalSnapshotId = context?.finalSnapshotIdentifier;
      await this.getClient().send(
        new DeleteDBClusterCommand({
          DBClusterIdentifier: physicalId,
          ...(finalSnapshotId
            ? { SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: finalSnapshotId }
            : { SkipFinalSnapshot: true }),
        })
      );
      // AWS took the delete: a later throw is the WAIT failing, and the guard
      // must not be put back on a cluster that is being deleted.
      flip.deleteAccepted = true;
      // Not the identifier: it embeds the physical id, which may be secret-derived
      // (#4111). It is `<sanitized physical id>-final-<UTC timestamp>` (docs/_contents/cli-destroy.md).
      if (finalSnapshotId) {
        this.logger.info(
          `Deleting DocDB DBCluster ${logicalId} with a final snapshot (DeletionPolicy: Snapshot)`
        );
      }

      this.logger.debug(`Successfully initiated deletion of DocDB DBCluster ${logicalId}`);

      // Wait for cluster to be fully deleted
      await this.waitForClusterDeleted(logicalId, physicalId);
    } catch (error) {
      if (isDocDBNotFoundError(error, 'DBClusterNotFoundFault')) {
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
            safeMsg`  DocDB DB cluster ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`DocDB DBCluster ${logicalId} does not exist, skipping deletion`);
        }
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DocDB DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── DBInstance ───────────────────────────────────────────────────

  private async createDBInstance(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DocDB DBInstance ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const dbInstanceIdentifier =
      (properties['DBInstanceIdentifier'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 63, lowercase: true });

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
          // DocDB engine value is fixed: only `docdb` is accepted.
          Engine: 'docdb',
          DBClusterIdentifier: properties['DBClusterIdentifier'] as string,
          AvailabilityZone: properties['AvailabilityZone'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          ...(tags.length > 0 && { Tags: tags }),
        })
      );
      instanceCreated = true;
      createdResourceId = response.DBInstance?.DbiResourceId;

      const instance = response.DBInstance;
      if (!instance) {
        throw new Error('CreateDBInstance did not return DBInstance');
      }

      this.logger.debug(
        `Successfully created DocDB DBInstance ${logicalId}: ${dbInstanceIdentifier}`
      );

      // Wait for instance to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForInstanceAvailable(dbInstanceIdentifier);
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
          : new ProvisioningError(
              `Failed to create DocDB DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
              resourceType,
              logicalId,
              dbInstanceIdentifier,
              error instanceof Error ? error : undefined
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
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DocDB DBInstance ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    try {
      // #1160 reset-on-removal — ModifyDBInstance has merge semantics, but
      // every optional DocDB instance field is deliberately NOT reset:
      //   * AutoMinorVersionUpgrade — inert on DocDB (ModifyDBInstanceMessage
      //     doc: "This parameter does not apply to Amazon DocumentDB.
      //     Amazon DocumentDB does not perform minor version upgrades
      //     regardless of the value set"); synthesizing a reset would close
      //     no behavioral divergence.
      //   * PreferredMaintenanceWindow — AWS assigns a RANDOM window at
      //     create; no documented "reset to random" sentinel.
      await this.getClient().send(
        new ModifyDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
          DBInstanceClass: properties['DBInstanceClass'] as string | undefined,
          PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
            | string
            | undefined,
          AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated DocDB DBInstance ${logicalId}`);

      const described = await this.describeDBInstance(physicalId);

      if (described?.DBInstanceArn) {
        await applyDocDBTagDiff(
          this.getClient(),
          this.logger,
          described.DBInstanceArn,
          resourceType,
          logicalId,
          previousProperties['Tags'],
          properties['Tags']
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: instanceAttributes(described),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DocDB DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DocDB DBInstance ${logicalId}: ${physicalId}`);

    // DocDB DBInstance does NOT have its own DeletionProtection field
    // (only the cluster does). `--remove-protection` is therefore a no-op
    // here — the existing delete logic runs unchanged. The cluster-level
    // bypass on DBCluster handles the "protect against accidental delete"
    // intent for instances inside a protected cluster.

    try {
      await this.getClient().send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
        })
      );

      this.logger.debug(`Successfully initiated deletion of DocDB DBInstance ${logicalId}`);

      // Wait for instance to be fully deleted
      await this.waitForInstanceDeleted(physicalId);
    } catch (error) {
      if (isDocDBNotFoundError(error, 'DBInstanceNotFoundFault')) {
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
            safeMsg`  DocDB DB instance ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
          );
        } else {
          this.logger.debug(`DocDB DBInstance ${physicalId} does not exist, skipping deletion`);
        }
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DocDB DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private async describeDBCluster(dbClusterIdentifier: string) {
    const response = await this.getClient().send(
      new DescribeDBClustersCommand({
        DBClusterIdentifier: dbClusterIdentifier,
      })
    );
    return response.DBClusters?.[0];
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
   * go-to-k/cdkd#4606: whether the DocDB DB cluster or DB instance a failed
   * CREATE journaled is the one the record under the same logical id holds (a
   * fix-forward that created a new one there under another identifier).
   *
   * Reached on the SDK route only (`disableCcApiFallback`: these types have no
   * Cloud Control route). Both ids must be DB identifiers; anything else is
   * `'unknown'`. An identifier names at most one cluster (or instance) per
   * account and region at a time, in a namespace DocumentDB shares with RDS
   * and Neptune, and identifiers compare case-insensitively (stored
   * lower-cased), so two spellings equal modulo case are `'same'` without a
   * read. After the region check the record's resource must read back (else
   * `'unknown'`); the journaled one is `'same'` when it reads back under the
   * record's `DbClusterResourceId` / `DbiResourceId` (immutable, unique),
   * `'different'` under another, and `'different'` when AWS reports its
   * identifier gone: the record's resource answers to its own, other,
   * identifier. A read answering with another engine's resource (the shared
   * describe returns RDS and Neptune resources too) throws, which the caller
   * reads as `'unknown'`: this provider's delete would remove that resource.
   */
  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    if (resourceType !== 'AWS::DocDB::DBCluster' && resourceType !== 'AWS::DocDB::DBInstance') {
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
   * `DbiResourceId`, which AWS generates, never changes and never gives a
   * later resource. A resource re-created under the identifier, by any engine
   * and in any case spelling, answers with another id (or, for another
   * engine, throws), so the settle keeps it rather than deleting it as the
   * failed CREATE's orphan. A failed CREATE's own token comes from its create
   * response, on the failure's mark (`markCreatedBeforeFailure`); this is the
   * live read.
   *
   * `undefined` for another type, an id that is not a DB identifier, or a
   * client in another region than `expectedRegion`. `RESOURCE_NOT_FOUND` only
   * on the describe's not-found fault NAME (or an empty list); any other
   * failure throws.
   */
  async resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    if (resourceType !== 'AWS::DocDB::DBCluster' && resourceType !== 'AWS::DocDB::DBInstance') {
      return undefined;
    }
    if (!isDbIdentifier(physicalId)) return undefined;
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return undefined;
    const live = await this.readDbResourceIdIfExists(resourceType, physicalId);
    return live === undefined ? RESOURCE_NOT_FOUND : live;
  }

  /**
   * The DocDB cluster's `DbClusterResourceId` (or the instance's
   * `DbiResourceId`), or `undefined` when AWS reports the identifier gone (its
   * not-found fault NAME, or an empty describe list). Any other failure, a
   * response naming another identifier, another engine than `docdb`, or no
   * resource id throws: "could not read" never reads as "gone", and an RDS or
   * Neptune resource under the identifier is never this provider's.
   */
  private async readDbResourceIdIfExists(
    resourceType: 'AWS::DocDB::DBCluster' | 'AWS::DocDB::DBInstance',
    identifier: string
  ): Promise<string | undefined> {
    const isCluster = resourceType === 'AWS::DocDB::DBCluster';
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
    if (found.engine !== 'docdb') {
      throw new Error(`${api} answered with a resource of another engine`);
    }
    if (typeof found.resourceId !== 'string' || found.resourceId === '') {
      throw new Error(`${api} returned no resource id`);
    }
    return found.resourceId;
  }

  /**
   * Wait for a DBCluster to become available. DocDB's SDK does not ship a
   * `waitUntilDBClusterAvailable` waiter (only DBInstance has waiters),
   * so we poll Status manually with exponential backoff.
   */
  private async waitForClusterAvailable(
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      const cluster = await this.describeDBCluster(dbClusterIdentifier);
      const status = cluster?.Status;

      this.logger.debug(`DocDB DBCluster ${dbClusterIdentifier} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(
      `Timed out waiting for DocDB DBCluster ${dbClusterIdentifier} to become available`
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

        this.logger.debug(`DocDB DBCluster ${logicalId} status: ${status}`);

        if (!cluster) return;
      } catch (error) {
        if (isDocDBNotFoundError(error, 'DBClusterNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for DocDB DBCluster ${logicalId} to be deleted`);
  }

  /**
   * Wait for a DBInstance to become available (manual poll — matches RDS).
   */
  private async waitForInstanceAvailable(
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 10_000;

    while (Date.now() - startTime < maxWaitMs) {
      const instance = await this.describeDBInstance(dbInstanceIdentifier);
      const status = instance?.DBInstanceStatus;

      this.logger.debug(`DocDB DBInstance ${dbInstanceIdentifier} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(
      `Timed out waiting for DocDB DBInstance ${dbInstanceIdentifier} to become available`
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

        this.logger.debug(`DocDB DBInstance ${dbInstanceIdentifier} status: ${status}`);

        if (!instance) return;
      } catch (error) {
        if (isDocDBNotFoundError(error, 'DBInstanceNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }

    throw new Error(`Timed out waiting for DocDB DBInstance ${dbInstanceIdentifier} to be deleted`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Adopt an existing DocDB resource into cdkd state.
   *
   * Supported types: `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`.
   * Identifier name properties (`DBInstanceIdentifier` /
   * `DBClusterIdentifier`) are usually
   * present in CDK templates and are resolved via the corresponding
   * `Describe*` existence check. There is no `aws:cdk:path` tag fallback:
   * AWS rejects `aws:`-prefixed tag writes, so that tag never exists on a
   * real resource and the walk could not match (issue #1134).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::DocDB::DBInstance':
        return this.importDBInstance(input);
      case 'AWS::DocDB::DBCluster':
        return this.importDBCluster(input);
      default:
        return null;
    }
  }

  /**
   * Read the AWS-current DocDB resource configuration in CFn-property shape.
   *
   * Each branch surfaces only the keys cdkd's `create()` accepts. Sensitive
   * fields like `MasterUserPassword` are NEVER surfaced (DocDB does not
   * return them in the Describe responses). `Tags` are surfaced via a
   * follow-up `ListTagsForResource(ResourceName=arn)` call.
   *
   * Returns `RESOURCE_NOT_FOUND` when the resource is gone (`*NotFoundFault`
   * or an empty describe list), `undefined` for a type with no read path.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    switch (resourceType) {
      case 'AWS::DocDB::DBInstance':
        return this.readCurrentStateDBInstance(physicalId);
      case 'AWS::DocDB::DBCluster':
        return this.readCurrentStateDBCluster(physicalId);
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
      if (isDocDBNotFoundError(err, 'DBInstanceNotFoundFault')) return undefined;
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
    if (inst.AvailabilityZone !== undefined) result['AvailabilityZone'] = inst.AvailabilityZone;
    if (inst.PreferredMaintenanceWindow !== undefined) {
      result['PreferredMaintenanceWindow'] = inst.PreferredMaintenanceWindow;
    }
    if (inst.AutoMinorVersionUpgrade !== undefined) {
      result['AutoMinorVersionUpgrade'] = inst.AutoMinorVersionUpgrade;
    }
    if (inst.DBInstanceArn)
      await attachDocDBTags(this.getClient(), this.logger, result, inst.DBInstanceArn);
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
      if (isDocDBNotFoundError(err, 'DBClusterNotFoundFault')) return undefined;
      throw err;
    }
    if (!cluster) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (cluster.DBClusterIdentifier !== undefined) {
      result['DBClusterIdentifier'] = cluster.DBClusterIdentifier;
    }
    if (cluster.EngineVersion !== undefined) result['EngineVersion'] = cluster.EngineVersion;
    if (cluster.MasterUsername !== undefined) result['MasterUsername'] = cluster.MasterUsername;
    if (cluster.Port !== undefined) result['Port'] = cluster.Port;
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
    if (cluster.DeletionProtection !== undefined) {
      result['DeletionProtection'] = cluster.DeletionProtection;
    }
    if (cluster.DBClusterArn)
      await attachDocDBTags(this.getClient(), this.logger, result, cluster.DBClusterArn);
    return result;
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
    // No `aws:cdk:path` tag walk: the tag never exists on a real resource
    // (issue #1134). A DBInstance reaching here needs an explicit `--resource`
    // override or a `DBInstanceIdentifier` in the template.
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
    // No `aws:cdk:path` tag walk: the tag never exists on a real resource
    // (issue #1134). A DBCluster reaching here needs an explicit `--resource`
    // override or a `DBClusterIdentifier` in the template.
    return null;
  }
}
