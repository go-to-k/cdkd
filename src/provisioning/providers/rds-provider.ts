import {
  RDSClient,
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
  RemoveTagsFromResourceCommand,
} from '@aws-sdk/client-rds';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS RDS Provider
 *
 * Implements resource provisioning for RDS resources:
 * - AWS::RDS::DBSubnetGroup
 * - AWS::RDS::DBCluster
 * - AWS::RDS::DBInstance
 *
 * WHY: RDS SDK calls are direct and avoid CC API polling overhead.
 * However, DBCluster and DBInstance creation can take time, so we
 * poll with DescribeDB* until available.
 */
export class RDSProvider implements ResourceProvider {
  private rdsClient?: RDSClient;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('RDSProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBSubnetGroup',
      new Set(['DBSubnetGroupName', 'DBSubnetGroupDescription', 'SubnetIds', 'Tags']),
    ],
    [
      'AWS::RDS::DBCluster',
      new Set([
        'DBClusterIdentifier',
        'Engine',
        'EngineVersion',
        'MasterUsername',
        'MasterUserPassword',
        'DatabaseName',
        'Port',
        'VpcSecurityGroupIds',
        'DBSubnetGroupName',
        'StorageEncrypted',
        'KmsKeyId',
        'BackupRetentionPeriod',
        'DeletionProtection',
        'ServerlessV2ScalingConfiguration',
        'Tags',
        // #609 security-cluster backfill (managed master-password secret +
        // Enhanced Monitoring + IAM database auth + publicly-accessible).
        // 5 of the 6 ride CreateDBCluster AND ModifyDBCluster (mutable). Wire-
        // format flips: CFn `MasterUserSecret` (an object whose only create-
        // relevant member is `{ KmsKeyId }`) → SDK scalar
        // `MasterUserSecretKmsKeyId` (the create/modify shapes take the key id
        // directly — the SDK `MasterUserSecret` *type* is the read-side Describe
        // shape). `MonitoringInterval` arrives as a numeric STRING ("60"); coerce
        // via Number() at the wire boundary. `ManageMasterUserPassword` is
        // mutually exclusive with `MasterUserPassword` (AWS validates).
        // `PubliclyAccessible` IS a valid CreateDBClusterMessage field (Multi-AZ
        // DB clusters) but is ABSENT from ModifyDBClusterMessage — wired create-
        // only here (a template change replaces the cluster), distinct from
        // DBInstance's same-named mutable prop.
        'ManageMasterUserPassword',
        'MasterUserSecret',
        'MonitoringRoleArn',
        'MonitoringInterval',
        'EnableIAMDatabaseAuthentication',
        'PubliclyAccessible',
      ]),
    ],
    [
      'AWS::RDS::DBInstance',
      new Set([
        'DBInstanceIdentifier',
        'DBInstanceClass',
        'Engine',
        'DBClusterIdentifier',
        'DBSubnetGroupName',
        'PubliclyAccessible',
        'Tags',
        // #609 backfill — 8 sibling props already handled on DBCluster.
        // 6 mutable (DeletionProtection / EngineVersion / Port / MasterUserPassword /
        // VPCSecurityGroups / AllocatedStorage ride both CreateDBInstance + ModifyDBInstance) +
        // 2 create-only (StorageEncrypted is set at instance creation and immutable
        // post-create per AWS RDS docs — absent from ModifyDBInstanceMessage;
        // MasterUsername is also immutable post-create — AWS rejects changes via
        // ModifyDBInstance). Two wire-format name flips: CFn `Port` → SDK `DBPortNumber`
        // (different field name entirely on the DB instance), CFn `VPCSecurityGroups`
        // → SDK `VpcSecurityGroupIds` (casing + suffix). `MasterUsername` +
        // `AllocatedStorage` are AWS-required for standalone (non-cluster) DBInstance
        // create — wired here so a standalone instance can SDK-route end-to-end.
        'AllocatedStorage',
        'DeletionProtection',
        'EngineVersion',
        'MasterUsername',
        'MasterUserPassword',
        'Port',
        'StorageEncrypted',
        'VPCSecurityGroups',
        // #609 security-cluster backfill (sibling of the DBCluster set).
        // `KmsKeyId` is the storage-encryption key (pairs with the already-
        // handled StorageEncrypted) — create-only + immutable, so it is NOT
        // forwarded on update. The other 5 mirror DBCluster: `MasterUserSecret`
        // → SDK `MasterUserSecretKmsKeyId`, `ManageMasterUserPassword` (bool),
        // `MonitoringRoleArn` / `MonitoringInterval` (Number-coerced),
        // `EnableIAMDatabaseAuthentication` (bool) — all ride CreateDBInstance
        // AND ModifyDBInstance (mutable).
        'KmsKeyId',
        'MasterUserSecret',
        'ManageMasterUserPassword',
        'MonitoringRoleArn',
        'MonitoringInterval',
        'EnableIAMDatabaseAuthentication',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::RDS::DBCluster',
      new Map<string, string>([
        [
          'DeleteAutomatedBackups',
          'cdkd hardcodes SkipFinalSnapshot=true on destroy; this CFn lifecycle flag has no equivalent on the runtime path',
        ],
      ]),
    ],
    [
      'AWS::RDS::DBInstance',
      new Map<string, string>([
        [
          'DBSecurityGroups',
          'EC2-Classic-only feature retired by AWS (2022-08-15); new accounts cannot use this — use VPCSecurityGroups instead',
        ],
        [
          'ApplyImmediately',
          'cdkd always applies modifications immediately (rds:ModifyDBInstance.ApplyImmediately=true is hardcoded); users wanting maintenance-window deferral should run aws rds modify-db-instance directly',
        ],
        [
          'DeleteAutomatedBackups',
          'cdkd hardcodes SkipFinalSnapshot=true on destroy; this CFn lifecycle flag has no equivalent on the runtime path',
        ],
      ]),
    ],
  ]);

  private getClient(): RDSClient {
    if (!this.rdsClient) {
      this.rdsClient = new RDSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.rdsClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::RDS::DBSubnetGroup':
        return this.createDBSubnetGroup(logicalId, resourceType, properties);
      case 'AWS::RDS::DBCluster':
        return this.createDBCluster(logicalId, resourceType, properties);
      case 'AWS::RDS::DBInstance':
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
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::RDS::DBSubnetGroup':
        return this.updateDBSubnetGroup(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::RDS::DBCluster':
        return this.updateDBCluster(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::RDS::DBInstance':
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
      case 'AWS::RDS::DBSubnetGroup':
        return this.deleteDBSubnetGroup(logicalId, physicalId, resourceType, context);
      case 'AWS::RDS::DBCluster':
        return this.deleteDBCluster(logicalId, physicalId, resourceType, context);
      case 'AWS::RDS::DBInstance':
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
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DBSubnetGroup ${logicalId}`);

    const dbSubnetGroupName =
      (properties['DBSubnetGroupName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 255, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      await this.getClient().send(
        new CreateDBSubnetGroupCommand({
          DBSubnetGroupName: dbSubnetGroupName,
          DBSubnetGroupDescription:
            (properties['DBSubnetGroupDescription'] as string) || `Subnet group for ${logicalId}`,
          SubnetIds: properties['SubnetIds'] as string[],
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      this.logger.debug(`Successfully created DBSubnetGroup ${logicalId}: ${dbSubnetGroupName}`);

      return {
        physicalId: dbSubnetGroupName,
        attributes: {
          DBSubnetGroupName: dbSubnetGroupName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        dbSubnetGroupName,
        cause
      );
    }
  }

  private async updateDBSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DBSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      // Class 2 — `SubnetIds: []` would be rejected by AWS as a structurally
      // invalid input (DBSubnetGroup requires ≥ 2 subnets in distinct AZs).
      // readCurrentState emits `SubnetIds: []` as a placeholder when AWS
      // happens to return no subnets; the round-trip must NOT translate
      // that into a malformed SDK call. Skip the field when empty so the
      // ModifyDBSubnetGroup call is a no-op for the subnet list.
      const subnetIds = properties['SubnetIds'] as string[] | undefined;
      const sendSubnetIds = subnetIds !== undefined && subnetIds.length > 0;
      // The SDK input type marks `SubnetIds` as required; a description-
      // only update is a legitimate use case that omits the field on the
      // wire (AWS supports it). Cast the input shape to bypass the
      // type-level requirement.
      const modifyInput = {
        DBSubnetGroupName: physicalId,
        DBSubnetGroupDescription: properties['DBSubnetGroupDescription'] as string | undefined,
        ...(sendSubnetIds && { SubnetIds: subnetIds }),
      } as ConstructorParameters<typeof ModifyDBSubnetGroupCommand>[0];
      await this.getClient().send(new ModifyDBSubnetGroupCommand(modifyInput));

      // Apply tag diff. RDS uses ARN-keyed AddTagsToResource /
      // RemoveTagsFromResource. DescribeDBSubnetGroups returns the ARN.
      const desc = await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: physicalId })
      );
      const arn = desc.DBSubnetGroups?.[0]?.DBSubnetGroupArn;
      if (arn) {
        await this.applyTagDiff(
          arn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      this.logger.debug(`Successfully updated DBSubnetGroup ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          DBSubnetGroupName: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteDBSubnetGroup(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DBSubnetGroup ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteDBSubnetGroupCommand({
          DBSubnetGroupName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted DBSubnetGroup ${logicalId}`);
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
        this.logger.debug(`DBSubnetGroup ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DBSubnetGroup ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── DBCluster ────────────────────────────────────────────────────

  private async createDBCluster(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DBCluster ${logicalId}`);

    const dbClusterIdentifier =
      (properties['DBClusterIdentifier'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 63, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      const serverlessV2Config = properties['ServerlessV2ScalingConfiguration'] as
        | { MinCapacity?: number; MaxCapacity?: number }
        | undefined;

      // #609 — CFn `MasterUserSecret` is `{ KmsKeyId }`; only the key id is a
      // create input (`MasterUserSecretKmsKeyId`). The object may also carry
      // read-only `SecretArn` / `SecretStatus` (ignored on the write side).
      const masterUserSecret = properties['MasterUserSecret'] as { KmsKeyId?: string } | undefined;

      const response = await this.getClient().send(
        new CreateDBClusterCommand({
          DBClusterIdentifier: dbClusterIdentifier,
          Engine: properties['Engine'] as string,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          MasterUsername: properties['MasterUsername'] as string | undefined,
          MasterUserPassword: properties['MasterUserPassword'] as string | undefined,
          DatabaseName: properties['DatabaseName'] as string | undefined,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
          VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
          StorageEncrypted: properties['StorageEncrypted'] as boolean | undefined,
          KmsKeyId: properties['KmsKeyId'] as string | undefined,
          BackupRetentionPeriod:
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          // #609 security-cluster backfill. `!== undefined` for the booleans so
          // an explicit `false` opt-out reaches AWS rather than being dropped by
          // a truthy gate. `MonitoringInterval` is CFn-string-typed → Number().
          ...(properties['ManageMasterUserPassword'] !== undefined && {
            ManageMasterUserPassword: properties['ManageMasterUserPassword'] as boolean,
          }),
          ...(masterUserSecret?.KmsKeyId !== undefined && {
            MasterUserSecretKmsKeyId: masterUserSecret.KmsKeyId,
          }),
          ...(properties['MonitoringRoleArn'] !== undefined && {
            MonitoringRoleArn: properties['MonitoringRoleArn'] as string,
          }),
          ...(properties['MonitoringInterval'] !== undefined && {
            MonitoringInterval: Number(properties['MonitoringInterval']),
          }),
          ...(properties['EnableIAMDatabaseAuthentication'] !== undefined && {
            EnableIAMDatabaseAuthentication: properties[
              'EnableIAMDatabaseAuthentication'
            ] as boolean,
          }),
          ...(properties['PubliclyAccessible'] !== undefined && {
            PubliclyAccessible: properties['PubliclyAccessible'] as boolean,
          }),
          ...(serverlessV2Config && {
            ServerlessV2ScalingConfiguration: {
              MinCapacity: serverlessV2Config.MinCapacity,
              MaxCapacity: serverlessV2Config.MaxCapacity,
            },
          }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const cluster = response.DBCluster;
      if (!cluster) {
        // Theoretical AWS SDK contract violation: CreateDBCluster returned
        // success but with no DBCluster. Cannot clean up — we have no
        // identifier to delete. Has never been observed in practice.
        throw new Error('CreateDBCluster did not return DBCluster');
      }

      this.logger.debug(`Successfully created DBCluster ${logicalId}: ${dbClusterIdentifier}`);

      // CreateDBClusterCommand has succeeded — AWS has now committed the
      // cluster and BILLING HAS STARTED (Aurora minimum ~$0.07/hour idle).
      // This is the **cost-leak class** (poll-failure case mentioned in
      // Issue #376): if `waitForClusterAvailable` times out or AWS
      // reports CREATE_FAILED via the waiter, the cluster keeps running
      // until manual cleanup. Wrap the post-create wiring in an inner
      // try/catch that issues a best-effort
      // `ModifyDBCluster(DeletionProtection: false)` (if template asked
      // for protection) + `DeleteDBCluster(SkipFinalSnapshot: true)`
      // before re-throwing the original error. We do NOT wait for the
      // cluster to fully delete (the deploy is already failing — making
      // the user wait another 5-30 min on RDS's eventual termination is
      // bad UX; the same UX choice we made for EC2 Instance in PR #379).
      // When cleanup itself fails, the WARN escalates to `THE CLUSTER
      // IS STILL RUNNING AND BILLING` with the exact recovery commands.
      const wantsDeletionProtection = properties['DeletionProtection'] === true;
      try {
        // Wait for cluster to become available (skip with --no-wait)
        if (process.env['CDKD_NO_WAIT'] !== 'true') {
          await this.waitForClusterAvailable(dbClusterIdentifier);
        }

        // Describe to get final attributes
        const described = await this.describeDBCluster(dbClusterIdentifier);

        return {
          physicalId: dbClusterIdentifier,
          attributes: {
            'Endpoint.Address': described?.Endpoint ?? '',
            'Endpoint.Port': String(described?.Port ?? ''),
            'ReadEndpoint.Address': described?.ReaderEndpoint ?? '',
            Arn: described?.DBClusterArn ?? '',
            DBClusterResourceId: described?.DbClusterResourceId ?? '',
          },
        };
      } catch (innerError) {
        try {
          // Flip DeletionProtection off first when template requested it
          // — otherwise DeleteDBCluster rejects with `InvalidParameter
          // Combination: Cannot delete protected DB cluster`.
          if (wantsDeletionProtection) {
            try {
              await this.getClient().send(
                new ModifyDBClusterCommand({
                  DBClusterIdentifier: dbClusterIdentifier,
                  DeletionProtection: false,
                  ApplyImmediately: true,
                })
              );
            } catch (disableError) {
              this.logger.debug(
                `Could not disable DeletionProtection on partially-created DBCluster ${dbClusterIdentifier}: ${disableError instanceof Error ? disableError.message : String(disableError)} (proceeding with DeleteDBCluster anyway)`
              );
            }
          }
          await this.getClient().send(
            new DeleteDBClusterCommand({
              DBClusterIdentifier: dbClusterIdentifier,
              SkipFinalSnapshot: true,
            })
          );
          this.logger.debug(
            `Delete requested for partially-created DBCluster ${logicalId} (${dbClusterIdentifier}) after wiring failure (not waiting for deleted state)`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to delete partially-created DBCluster ${logicalId} (${dbClusterIdentifier}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. THE CLUSTER IS STILL RUNNING AND BILLING. Manual cleanup required: ${wantsDeletionProtection ? `aws rds modify-db-cluster --db-cluster-identifier ${dbClusterIdentifier} --no-deletion-protection --apply-immediately; ` : ''}aws rds delete-db-cluster --db-cluster-identifier ${dbClusterIdentifier} --skip-final-snapshot`
          );
        }
        throw innerError;
      }
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        dbClusterIdentifier,
        cause
      );
    }
  }

  private async updateDBCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DBCluster ${logicalId}: ${physicalId}`);

    try {
      const serverlessV2Config = properties['ServerlessV2ScalingConfiguration'] as
        | { MinCapacity?: number; MaxCapacity?: number }
        | undefined;
      // Class 2 — defence-in-depth on top of the readCurrentState gate.
      // `{}` (or `{ MinCapacity: undefined, MaxCapacity: undefined }`)
      // is structurally invalid as ModifyDBCluster input on
      // non-serverless-v2 clusters; only ship the field when at least
      // one capacity value is present.
      const hasServerlessV2 =
        serverlessV2Config !== undefined &&
        (serverlessV2Config.MinCapacity !== undefined ||
          serverlessV2Config.MaxCapacity !== undefined);

      // Class 2 — `VpcSecurityGroupIds: []` would CLEAR all SGs on the
      // cluster. readCurrentState always-emits `[]` for clusters that
      // legitimately have no VPC SGs (Aurora-on-default-VPC etc.); the
      // round-trip must NOT translate that placeholder into a destructive
      // SDK call. Skip the field when the resolved value is empty.
      const vpcSgIds = properties['VpcSecurityGroupIds'] as string[] | undefined;
      const sendVpcSgIds = vpcSgIds !== undefined && vpcSgIds.length > 0;

      // #609 — `MasterUserSecret` `{ KmsKeyId }` maps to the scalar modify
      // field `MasterUserSecretKmsKeyId` (same flip as create()).
      const masterUserSecret = properties['MasterUserSecret'] as { KmsKeyId?: string } | undefined;

      await this.getClient().send(
        new ModifyDBClusterCommand({
          DBClusterIdentifier: physicalId,
          EngineVersion: properties['EngineVersion'] as string | undefined,
          DeletionProtection: properties['DeletionProtection'] as boolean | undefined,
          BackupRetentionPeriod:
            properties['BackupRetentionPeriod'] != null
              ? Number(properties['BackupRetentionPeriod'])
              : undefined,
          ...(sendVpcSgIds && { VpcSecurityGroupIds: vpcSgIds }),
          MasterUserPassword: properties['MasterUserPassword'] as string | undefined,
          Port: properties['Port'] != null ? Number(properties['Port']) : undefined,
          // #609 security-cluster backfill — all mutable via ModifyDBCluster.
          ...(properties['ManageMasterUserPassword'] !== undefined && {
            ManageMasterUserPassword: properties['ManageMasterUserPassword'] as boolean,
          }),
          ...(masterUserSecret?.KmsKeyId !== undefined && {
            MasterUserSecretKmsKeyId: masterUserSecret.KmsKeyId,
          }),
          ...(properties['MonitoringRoleArn'] !== undefined && {
            MonitoringRoleArn: properties['MonitoringRoleArn'] as string,
          }),
          ...(properties['MonitoringInterval'] !== undefined && {
            MonitoringInterval: Number(properties['MonitoringInterval']),
          }),
          ...(properties['EnableIAMDatabaseAuthentication'] !== undefined && {
            EnableIAMDatabaseAuthentication: properties[
              'EnableIAMDatabaseAuthentication'
            ] as boolean,
          }),
          ...(hasServerlessV2 && {
            ServerlessV2ScalingConfiguration: {
              MinCapacity: serverlessV2Config.MinCapacity,
              MaxCapacity: serverlessV2Config.MaxCapacity,
            },
          }),
          ApplyImmediately: true,
        })
      );

      this.logger.debug(`Successfully updated DBCluster ${logicalId}`);

      // Describe to get updated attributes
      const described = await this.describeDBCluster(physicalId);

      // Apply tag diff using the cluster ARN.
      if (described?.DBClusterArn) {
        await this.applyTagDiff(
          described.DBClusterArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          'Endpoint.Address': described?.Endpoint ?? '',
          'Endpoint.Port': String(described?.Port ?? ''),
          'ReadEndpoint.Address': described?.ReaderEndpoint ?? '',
          Arn: described?.DBClusterArn ?? '',
          DBClusterResourceId: described?.DbClusterResourceId ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteDBCluster(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DBCluster ${logicalId}: ${physicalId}`);

    try {
      // `--remove-protection`: flip DeletionProtection off in-place
      // before delete. Idempotent — RDS accepts the call when protection
      // is already disabled. Non-fatal: log at debug if the flip-off
      // errors (e.g. NotFound) so the actual delete still proceeds.
      if (context?.removeProtection === true) {
        try {
          await this.getClient().send(
            new ModifyDBClusterCommand({
              DBClusterIdentifier: physicalId,
              DeletionProtection: false,
              ApplyImmediately: true,
            })
          );
          this.logger.debug(`Disabled DeletionProtection on DBCluster ${logicalId} before delete`);
        } catch (disableError) {
          if (!this.isNotFoundError(disableError, 'DBClusterNotFoundFault')) {
            this.logger.debug(
              `Could not disable deletion protection for ${physicalId}: ${disableError instanceof Error ? disableError.message : String(disableError)}`
            );
          }
        }
      }

      await this.getClient().send(
        new DeleteDBClusterCommand({
          DBClusterIdentifier: physicalId,
          SkipFinalSnapshot: true,
        })
      );

      this.logger.debug(`Successfully initiated deletion of DBCluster ${logicalId}`);

      // Wait for cluster to be fully deleted
      await this.waitForClusterDeleted(physicalId);
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
        this.logger.debug(`DBCluster ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DBCluster ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Creating DBInstance ${logicalId}`);

    const dbInstanceIdentifier =
      (properties['DBInstanceIdentifier'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 63, lowercase: true });

    try {
      const tags = this.buildTags(properties);

      // #609 — `MasterUserSecret` `{ KmsKeyId }` → scalar
      // `MasterUserSecretKmsKeyId` (same flip as the DBCluster path).
      const masterUserSecret = properties['MasterUserSecret'] as { KmsKeyId?: string } | undefined;

      const response = await this.getClient().send(
        new CreateDBInstanceCommand({
          DBInstanceIdentifier: dbInstanceIdentifier,
          DBInstanceClass: properties['DBInstanceClass'] as string,
          Engine: properties['Engine'] as string,
          DBClusterIdentifier: properties['DBClusterIdentifier'] as string | undefined,
          DBSubnetGroupName: properties['DBSubnetGroupName'] as string | undefined,
          PubliclyAccessible: properties['PubliclyAccessible'] as boolean | undefined,
          // #609 backfill — 8 sibling props matching DBCluster.
          // Use `!== undefined` for booleans (DeletionProtection,
          // StorageEncrypted) so an explicit `false` is forwarded as the
          // user-set opt-out rather than silently dropped by a truthy gate.
          // AllocatedStorage / MasterUsername are AWS-required for standalone
          // (non-cluster-member) DBInstance. CFn accepts AllocatedStorage as
          // a numeric STRING (CDK emits `"20"`); coerce through Number().
          ...(properties['AllocatedStorage'] !== undefined && {
            AllocatedStorage: Number(properties['AllocatedStorage']),
          }),
          ...(properties['MasterUsername'] !== undefined && {
            MasterUsername: properties['MasterUsername'] as string,
          }),
          ...(properties['DeletionProtection'] !== undefined && {
            DeletionProtection: properties['DeletionProtection'] as boolean,
          }),
          ...(properties['EngineVersion'] !== undefined && {
            EngineVersion: properties['EngineVersion'] as string,
          }),
          // CFn `Port` → SDK `Port` on CreateDBInstance (not DBPortNumber —
          // that's the MODIFY-side name; AWS uses different field names for
          // the same logical setting across the create vs modify shapes).
          // CFn types Port as a STRING in the template ("5432"); the SDK
          // requires a number, so coerce here.
          ...(properties['Port'] !== undefined && {
            Port: Number(properties['Port']),
          }),
          ...(properties['MasterUserPassword'] !== undefined && {
            MasterUserPassword: properties['MasterUserPassword'] as string,
          }),
          // StorageEncrypted is create-only per AWS RDS docs — set here, not
          // forwarded on update. `!== undefined` so explicit `false` reaches
          // AWS (vs. the AWS-side default, which depends on engine + storage class).
          ...(properties['StorageEncrypted'] !== undefined && {
            StorageEncrypted: properties['StorageEncrypted'] as boolean,
          }),
          // CFn `VPCSecurityGroups` → SDK `VpcSecurityGroupIds` (casing + name flip).
          ...(properties['VPCSecurityGroups'] !== undefined && {
            VpcSecurityGroupIds: properties['VPCSecurityGroups'] as string[],
          }),
          // #609 security-cluster backfill. `KmsKeyId` is the storage-encryption
          // key (pairs with the already-handled StorageEncrypted) — create-only
          // + immutable, so NOT forwarded on update. `MonitoringInterval` is
          // CFn-string-typed → Number(). `!== undefined` on the booleans so an
          // explicit `false` reaches AWS.
          ...(properties['KmsKeyId'] !== undefined && {
            KmsKeyId: properties['KmsKeyId'] as string,
          }),
          ...(masterUserSecret?.KmsKeyId !== undefined && {
            MasterUserSecretKmsKeyId: masterUserSecret.KmsKeyId,
          }),
          ...(properties['ManageMasterUserPassword'] !== undefined && {
            ManageMasterUserPassword: properties['ManageMasterUserPassword'] as boolean,
          }),
          ...(properties['MonitoringRoleArn'] !== undefined && {
            MonitoringRoleArn: properties['MonitoringRoleArn'] as string,
          }),
          ...(properties['MonitoringInterval'] !== undefined && {
            MonitoringInterval: Number(properties['MonitoringInterval']),
          }),
          ...(properties['EnableIAMDatabaseAuthentication'] !== undefined && {
            EnableIAMDatabaseAuthentication: properties[
              'EnableIAMDatabaseAuthentication'
            ] as boolean,
          }),
          ...(tags.length > 0 && { Tags: tags }),
        })
      );

      const instance = response.DBInstance;
      if (!instance) {
        throw new Error('CreateDBInstance did not return DBInstance');
      }

      this.logger.debug(`Successfully created DBInstance ${logicalId}: ${dbInstanceIdentifier}`);

      // Wait for instance to become available (skip with --no-wait)
      if (process.env['CDKD_NO_WAIT'] !== 'true') {
        await this.waitForInstanceAvailable(dbInstanceIdentifier);
      }

      // Describe to get final attributes
      const described = await this.describeDBInstance(dbInstanceIdentifier);

      return {
        physicalId: dbInstanceIdentifier,
        attributes: {
          'Endpoint.Address': described?.Endpoint?.Address ?? '',
          'Endpoint.Port': String(described?.Endpoint?.Port ?? ''),
          Arn: described?.DBInstanceArn ?? '',
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        dbInstanceIdentifier,
        cause
      );
    }
  }

  private async updateDBInstance(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating DBInstance ${logicalId}: ${physicalId}`);

    try {
      // #609 backfill — 6 mutable sibling props matching DBCluster.
      // StorageEncrypted + MasterUsername are create-only per AWS RDS docs
      // and intentionally NOT forwarded here; a template change to either
      // would CFn-replace the instance, which cdkd's diff layer schedules
      // independently. Wire-format flips: CFn `Port` → SDK `DBPortNumber`
      // (different field name on the Modify shape — AWS uses `Port` on
      // Create and `DBPortNumber` on Modify), CFn `VPCSecurityGroups` →
      // SDK `VpcSecurityGroupIds`. `EngineVersion` is paired with
      // `AllowMajorVersionUpgrade: true` so a major-version bump is
      // permitted without a separate template toggle (matches CFn's
      // documented behavior when the user has raised EngineVersion across
      // a major boundary).
      const newEngineVersion = properties['EngineVersion'] as string | undefined;
      const prevEngineVersion = previousProperties['EngineVersion'] as string | undefined;
      const allowMajorVersionUpgrade =
        newEngineVersion !== undefined &&
        newEngineVersion !== prevEngineVersion &&
        prevEngineVersion !== undefined &&
        newEngineVersion.split('.')[0] !== prevEngineVersion.split('.')[0];
      // #609 — `MasterUserSecret` `{ KmsKeyId }` → scalar
      // `MasterUserSecretKmsKeyId` (same flip as create()).
      const masterUserSecret = properties['MasterUserSecret'] as { KmsKeyId?: string } | undefined;
      await this.getClient().send(
        new ModifyDBInstanceCommand({
          DBInstanceIdentifier: physicalId,
          DBInstanceClass: properties['DBInstanceClass'] as string | undefined,
          PubliclyAccessible: properties['PubliclyAccessible'] as boolean | undefined,
          ApplyImmediately: true,
          // AllocatedStorage is mutable on ModifyDBInstance (scale-up).
          // AWS rejects scale-down except in narrow cases; cdkd forwards the
          // user's value and lets AWS surface the rejection if any.
          ...(properties['AllocatedStorage'] !== undefined && {
            AllocatedStorage: Number(properties['AllocatedStorage']),
          }),
          ...(properties['DeletionProtection'] !== undefined && {
            DeletionProtection: properties['DeletionProtection'] as boolean,
          }),
          ...(newEngineVersion !== undefined && {
            EngineVersion: newEngineVersion,
            ...(allowMajorVersionUpgrade && { AllowMajorVersionUpgrade: true }),
          }),
          ...(properties['Port'] !== undefined && {
            DBPortNumber: Number(properties['Port']),
          }),
          ...(properties['MasterUserPassword'] !== undefined && {
            MasterUserPassword: properties['MasterUserPassword'] as string,
          }),
          ...(properties['VPCSecurityGroups'] !== undefined && {
            VpcSecurityGroupIds: properties['VPCSecurityGroups'] as string[],
          }),
          // #609 security-cluster backfill — 5 mutable via ModifyDBInstance.
          // `KmsKeyId` is intentionally NOT forwarded here (storage-encryption
          // key is immutable post-create; a template change replaces the
          // instance, which cdkd's diff layer schedules independently — same
          // treatment as StorageEncrypted / MasterUsername above).
          ...(masterUserSecret?.KmsKeyId !== undefined && {
            MasterUserSecretKmsKeyId: masterUserSecret.KmsKeyId,
          }),
          ...(properties['ManageMasterUserPassword'] !== undefined && {
            ManageMasterUserPassword: properties['ManageMasterUserPassword'] as boolean,
          }),
          ...(properties['MonitoringRoleArn'] !== undefined && {
            MonitoringRoleArn: properties['MonitoringRoleArn'] as string,
          }),
          ...(properties['MonitoringInterval'] !== undefined && {
            MonitoringInterval: Number(properties['MonitoringInterval']),
          }),
          ...(properties['EnableIAMDatabaseAuthentication'] !== undefined && {
            EnableIAMDatabaseAuthentication: properties[
              'EnableIAMDatabaseAuthentication'
            ] as boolean,
          }),
        })
      );

      this.logger.debug(`Successfully updated DBInstance ${logicalId}`);

      // Describe to get updated attributes
      const described = await this.describeDBInstance(physicalId);

      // Apply tag diff using the instance ARN.
      if (described?.DBInstanceArn) {
        await this.applyTagDiff(
          described.DBInstanceArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          'Endpoint.Address': described?.Endpoint?.Address ?? '',
          'Endpoint.Port': String(described?.Endpoint?.Port ?? ''),
          Arn: described?.DBInstanceArn ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
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
    this.logger.debug(`Deleting DBInstance ${logicalId}: ${physicalId}`);

    try {
      // `--remove-protection`: flip DeletionProtection off in-place
      // before delete. Idempotent — RDS accepts the call when protection
      // is already disabled. Non-fatal: log at debug if the flip-off
      // errors (e.g. NotFound) so the actual delete still proceeds.
      if (context?.removeProtection === true) {
        try {
          await this.getClient().send(
            new ModifyDBInstanceCommand({
              DBInstanceIdentifier: physicalId,
              DeletionProtection: false,
              ApplyImmediately: true,
            })
          );
          this.logger.debug(`Disabled DeletionProtection on DBInstance ${logicalId} before delete`);
        } catch (disableError) {
          if (!this.isNotFoundError(disableError, 'DBInstanceNotFoundFault')) {
            this.logger.debug(
              `Could not disable deletion protection for ${physicalId}: ${disableError instanceof Error ? disableError.message : String(disableError)}`
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

      this.logger.debug(`Successfully initiated deletion of DBInstance ${logicalId}`);

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
        this.logger.debug(`DBInstance ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DBInstance ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via RDS's
   * `AddTagsToResource` / `RemoveTagsFromResource` APIs (keyed by
   * `ResourceName=arn`).
   */
  private async applyTagDiff(
    arn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Array<{ Key: string; Value: string }> = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from RDS resource ${arn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(
        new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on RDS resource ${arn}`);
    }
  }

  private buildTags(properties: Record<string, unknown>): Array<{ Key: string; Value: string }> {
    if (!properties['Tags']) return [];
    return properties['Tags'] as Array<{ Key: string; Value: string }>;
  }

  private isNotFoundError(error: unknown, faultName: string): boolean {
    if (!(error instanceof Error)) return false;
    const name = (error as { name?: string }).name ?? '';
    const message = error.message.toLowerCase();
    return (
      name === faultName || message.includes('not found') || message.includes('does not exist')
    );
  }

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
   * Wait for a DBCluster to become available
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

      this.logger.debug(`DBCluster ${dbClusterIdentifier} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(`Timed out waiting for DBCluster ${dbClusterIdentifier} to become available`);
  }

  /**
   * Wait for a DBCluster to be deleted
   */
  private async waitForClusterDeleted(
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    const startTime = Date.now();
    let delay = 5_000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const cluster = await this.describeDBCluster(dbClusterIdentifier);
        const status = cluster?.Status;

        this.logger.debug(`DBCluster ${dbClusterIdentifier} status: ${status}`);

        if (!cluster) return;
      } catch (error) {
        if (this.isNotFoundError(error, 'DBClusterNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(`Timed out waiting for DBCluster ${dbClusterIdentifier} to be deleted`);
  }

  /**
   * Wait for a DBInstance to become available
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

      this.logger.debug(`DBInstance ${dbInstanceIdentifier} status: ${status}`);

      if (status === 'available') return;

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(`Timed out waiting for DBInstance ${dbInstanceIdentifier} to become available`);
  }

  /**
   * Wait for a DBInstance to be deleted
   */
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

        this.logger.debug(`DBInstance ${dbInstanceIdentifier} status: ${status}`);

        if (!instance) return;
      } catch (error) {
        if (this.isNotFoundError(error, 'DBInstanceNotFoundFault')) {
          return;
        }
        throw error;
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }

    throw new Error(`Timed out waiting for DBInstance ${dbInstanceIdentifier} to be deleted`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Adopt an existing RDS resource into cdkd state.
   *
   * Supported types: `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`,
   * `AWS::RDS::DBSubnetGroup`. Resolution is by identifier name property
   * (`DBInstanceIdentifier` / `DBClusterIdentifier` / `DBSubnetGroupName`),
   * which is usually present in CDK templates, verified against the
   * corresponding `Describe*` call. A resource without one needs an
   * explicit `--resource` override (issue #1134).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::RDS::DBInstance':
        return this.importDBInstance(input);
      case 'AWS::RDS::DBCluster':
        return this.importDBCluster(input);
      case 'AWS::RDS::DBSubnetGroup':
        return this.importDBSubnetGroup(input);
      default:
        return null;
    }
  }

  /**
   * Read the AWS-current RDS resource configuration in CFn-property shape.
   *
   * Dispatches by resource type:
   *   - `AWS::RDS::DBInstance` → `DescribeDBInstances`
   *   - `AWS::RDS::DBCluster` → `DescribeDBClusters`
   *   - `AWS::RDS::DBSubnetGroup` → `DescribeDBSubnetGroups`
   *
   * Each branch surfaces only the keys cdkd's `create()` accepts. Sensitive
   * fields like `MasterUserPassword` are NEVER surfaced (RDS does not return
   * them in the Describe responses). `Tags` are surfaced via a follow-up
   * `ListTagsForResource(ResourceName=arn)` call (RDS uses `[{Key, Value}]`
   * shape). CDK's `aws:*` auto-tags are filtered out; the result key is
   * omitted entirely when AWS reports no user tags.
   *
   * Returns `undefined` when the resource is gone (`*NotFoundFault`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    switch (resourceType) {
      case 'AWS::RDS::DBInstance':
        return this.readCurrentStateDBInstance(physicalId);
      case 'AWS::RDS::DBCluster':
        return this.readCurrentStateDBCluster(physicalId);
      case 'AWS::RDS::DBSubnetGroup':
        return this.readCurrentStateDBSubnetGroup(physicalId);
      default:
        return undefined;
    }
  }

  private async readCurrentStateDBInstance(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    let inst;
    try {
      inst = await this.describeDBInstance(physicalId);
    } catch (err) {
      if (this.isNotFoundError(err, 'DBInstanceNotFoundFault')) return undefined;
      throw err;
    }
    if (!inst) return undefined;

    const result: Record<string, unknown> = {};
    if (inst.DBInstanceIdentifier !== undefined) {
      result['DBInstanceIdentifier'] = inst.DBInstanceIdentifier;
    }
    if (inst.DBInstanceClass !== undefined) result['DBInstanceClass'] = inst.DBInstanceClass;
    if (inst.Engine !== undefined) result['Engine'] = inst.Engine;
    if (inst.DBClusterIdentifier !== undefined) {
      result['DBClusterIdentifier'] = inst.DBClusterIdentifier;
    }
    if (inst.DBSubnetGroup?.DBSubnetGroupName !== undefined) {
      result['DBSubnetGroupName'] = inst.DBSubnetGroup.DBSubnetGroupName;
    }
    if (inst.PubliclyAccessible !== undefined) {
      result['PubliclyAccessible'] = inst.PubliclyAccessible;
    }
    // #609 backfill — AllocatedStorage + MasterUsername readbacks
    // (AWS-required sibling props, paired with the 5 below). MasterUsername
    // IS surfaced (unlike MasterUserPassword which AWS never returns).
    if (inst.AllocatedStorage !== undefined) {
      result['AllocatedStorage'] = inst.AllocatedStorage;
    }
    if (inst.MasterUsername !== undefined) result['MasterUsername'] = inst.MasterUsername;
    // #609 backfill — 5 readable sibling props matching DBCluster.
    // `MasterUserPassword` is intentionally NOT surfaced here: RDS never
    // returns the password in the Describe response (security), so any
    // value would be a phantom drift on every read.
    if (inst.DeletionProtection !== undefined) {
      result['DeletionProtection'] = inst.DeletionProtection;
    }
    if (inst.EngineVersion !== undefined) result['EngineVersion'] = inst.EngineVersion;
    // CFn `Port` → AWS Describe surface is `Endpoint.Port` (the active
    // listener port). The DBInstance shape has no top-level `Port` field
    // and no `DBPortNumber` either; the Modify-side `DBPortNumber` is a
    // request-shape oddity. Emit only when the endpoint is present
    // (briefly absent during create/modify transitions).
    if (inst.Endpoint?.Port !== undefined) result['Port'] = inst.Endpoint.Port;
    if (inst.StorageEncrypted !== undefined) {
      result['StorageEncrypted'] = inst.StorageEncrypted;
    }
    // CFn `VPCSecurityGroups` (string[]) ↔ AWS `VpcSecurityGroups[].VpcSecurityGroupId`.
    // Emit only when AWS returned a non-empty list — matches DBInstance's
    // overall "emit-when-present" pattern (vs DBCluster's "emit-always"
    // shape, which is a minor inconsistency in the cluster readback). The
    // drift calculator only descends into keys present in state, so an
    // omit-when-empty here still surfaces "state has SGs → AWS has none"
    // drift correctly via the state-side branch.
    const sgIds = (inst.VpcSecurityGroups ?? [])
      .map((sg) => sg.VpcSecurityGroupId)
      .filter((id): id is string => !!id);
    if (sgIds.length > 0) result['VPCSecurityGroups'] = sgIds;
    // #609 security-cluster backfill readbacks.
    if (inst.KmsKeyId !== undefined) result['KmsKeyId'] = inst.KmsKeyId;
    if (inst.MonitoringRoleArn !== undefined) {
      result['MonitoringRoleArn'] = inst.MonitoringRoleArn;
    }
    if (inst.MonitoringInterval !== undefined) {
      result['MonitoringInterval'] = inst.MonitoringInterval;
    }
    // AWS Describe surfaces this as `IAMDatabaseAuthenticationEnabled`; CFn /
    // cdkd state names it `EnableIAMDatabaseAuthentication`.
    if (inst.IAMDatabaseAuthenticationEnabled !== undefined) {
      result['EnableIAMDatabaseAuthentication'] = inst.IAMDatabaseAuthenticationEnabled;
    }
    // `MasterUserSecret` round-trips as `{ KmsKeyId }` (the only create-shape
    // member). Emit only when AWS reports a KmsKeyId so a non-managed-secret
    // instance (state has no such key) does not get a false-positive drift.
    // `ManageMasterUserPassword` itself is NOT a Describe field — its
    // create-time value is reflected only by the presence of MasterUserSecret,
    // so it is intentionally not read back (would be a phantom drift on every
    // read, like MasterUserPassword).
    if (inst.MasterUserSecret?.KmsKeyId !== undefined) {
      result['MasterUserSecret'] = { KmsKeyId: inst.MasterUserSecret.KmsKeyId };
    }
    if (inst.DBInstanceArn) await this.attachTags(result, inst.DBInstanceArn);
    return result;
  }

  private async readCurrentStateDBCluster(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    let cluster;
    try {
      cluster = await this.describeDBCluster(physicalId);
    } catch (err) {
      if (this.isNotFoundError(err, 'DBClusterNotFoundFault')) return undefined;
      throw err;
    }
    if (!cluster) return undefined;

    const result: Record<string, unknown> = {};
    if (cluster.DBClusterIdentifier !== undefined) {
      result['DBClusterIdentifier'] = cluster.DBClusterIdentifier;
    }
    if (cluster.Engine !== undefined) result['Engine'] = cluster.Engine;
    if (cluster.EngineVersion !== undefined) result['EngineVersion'] = cluster.EngineVersion;
    if (cluster.MasterUsername !== undefined) result['MasterUsername'] = cluster.MasterUsername;
    if (cluster.DatabaseName !== undefined) result['DatabaseName'] = cluster.DatabaseName;
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
    if (cluster.DeletionProtection !== undefined) {
      result['DeletionProtection'] = cluster.DeletionProtection;
    }
    // #609 security-cluster backfill readbacks.
    if (cluster.MonitoringRoleArn !== undefined) {
      result['MonitoringRoleArn'] = cluster.MonitoringRoleArn;
    }
    if (cluster.MonitoringInterval !== undefined) {
      result['MonitoringInterval'] = cluster.MonitoringInterval;
    }
    // AWS Describe surfaces this as `IAMDatabaseAuthenticationEnabled`; CFn /
    // cdkd state names it `EnableIAMDatabaseAuthentication`.
    if (cluster.IAMDatabaseAuthenticationEnabled !== undefined) {
      result['EnableIAMDatabaseAuthentication'] = cluster.IAMDatabaseAuthenticationEnabled;
    }
    if (cluster.PubliclyAccessible !== undefined) {
      result['PubliclyAccessible'] = cluster.PubliclyAccessible;
    }
    // `MasterUserSecret` round-trips as `{ KmsKeyId }`. Emit only when AWS
    // reports a KmsKeyId. `ManageMasterUserPassword` is not a Describe field
    // (its create-time value is reflected only by MasterUserSecret presence),
    // so it is intentionally not read back — like MasterUserPassword.
    if (cluster.MasterUserSecret?.KmsKeyId !== undefined) {
      result['MasterUserSecret'] = { KmsKeyId: cluster.MasterUserSecret.KmsKeyId };
    }
    // Class 1 — ServerlessV2ScalingConfiguration is only valid for Aurora
    // Serverless v2 clusters. Emit only when AWS actually returns one or
    // more of the discriminator fields (MinCapacity / MaxCapacity); on a
    // provisioned-mode cluster AWS leaves the entire field undefined and
    // emitting `{}` here would (a) round-trip through update() into
    // `ModifyDBCluster` with `ServerlessV2ScalingConfiguration: { Min: u, Max: u }`
    // which AWS rejects with "ServerlessV2ScalingConfiguration is only
    // supported on Aurora Serverless v2 clusters", and (b) fire a
    // false-positive drift on every non-serverless cluster (state has no
    // such key). See docs/provider-development.md § 3b.
    if (
      cluster.ServerlessV2ScalingConfiguration?.MinCapacity !== undefined ||
      cluster.ServerlessV2ScalingConfiguration?.MaxCapacity !== undefined
    ) {
      const sc: Record<string, unknown> = {};
      if (cluster.ServerlessV2ScalingConfiguration?.MinCapacity !== undefined) {
        sc['MinCapacity'] = cluster.ServerlessV2ScalingConfiguration.MinCapacity;
      }
      if (cluster.ServerlessV2ScalingConfiguration?.MaxCapacity !== undefined) {
        sc['MaxCapacity'] = cluster.ServerlessV2ScalingConfiguration.MaxCapacity;
      }
      result['ServerlessV2ScalingConfiguration'] = sc;
    }
    if (cluster.DBClusterArn) await this.attachTags(result, cluster.DBClusterArn);
    return result;
  }

  private async readCurrentStateDBSubnetGroup(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
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
      if (this.isNotFoundError(err, 'DBSubnetGroupNotFoundFault')) return undefined;
      throw err;
    }
    const sg = resp.DBSubnetGroups?.[0];
    if (!sg) return undefined;

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
   * Fetch tags via `ListTagsForResource(ResourceName=arn)` and merge them
   * into the result under `Tags` (CFn shape, `aws:*` filtered out, omitted
   * when empty). Best-effort: tag-fetch failures are logged at debug and
   * the key is simply left out — drift detection on configuration is more
   * important than fail-closing on a missing tag permission.
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
        `RDS ListTagsForResource(${arn}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async importDBInstance(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBInstanceIdentifier');
    if (explicit) {
      try {
        await this.getClient().send(
          new DescribeDBInstancesCommand({ DBInstanceIdentifier: explicit })
        );
        return { physicalId: explicit, attributes: {} };
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
        await this.getClient().send(
          new DescribeDBClustersCommand({ DBClusterIdentifier: explicit })
        );
        return { physicalId: explicit, attributes: {} };
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
