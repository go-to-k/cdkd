import type { DocDBProvider } from '../docdb-provider.js';
import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  ModifyDBInstanceCommand,
  type DBInstance,
} from '@aws-sdk/client-docdb';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { generatedNameFor } from '../../resource-name.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../../types/resource.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { applyDocDBTagDiff, isDocDBNotFoundError } from '../docdb-shared.js';
import { modifyDbInstanceWhenAvailable } from '../db-instance-modify-retry.js';
import {
  declaredChange,
  DOCDB_INSTANCE_KEPT_ON_REMOVAL,
  INSTANCE_MODIFY_UNSETTLED_KEYS,
  keptOnRemovalWarning,
  instanceAttributes,
} from './shared.js';

// ─── DBInstance ───────────────────────────────────────────────────
export async function createDBInstance(
  this: DocDBProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined,
  replayingState: boolean
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating DocDB DBInstance ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const insights = this.readBooleanProperty(
    'EnablePerformanceInsights',
    properties,
    resourceType,
    logicalId,
    { stateBorne: replayingState }
  );

  const dbInstanceIdentifier =
    (properties['DBInstanceIdentifier'] as string | undefined) ||
    generatedNameFor('AWS::DocDB::DBInstance', logicalId);

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
        PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as string | undefined,
        AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
        CACertificateIdentifier: properties['CACertificateIdentifier'] as string | undefined,
        EnablePerformanceInsights: insights,
        ...(tags.length > 0 && { Tags: tags }),
      })
    );
    instanceCreated = true;
    createdResourceId = response.DBInstance?.DbiResourceId;
    // go-to-k/cdkd#5511: report before the availability wait.
    reportCreatedResource(logicalId, resourceType, dbInstanceIdentifier, createdResourceId);

    const instance = response.DBInstance;
    if (!instance) {
      throw new Error('CreateDBInstance did not return DBInstance');
    }

    this.logger.debug(
      `Successfully created DocDB DBInstance ${logicalId}: ${dbInstanceIdentifier}`
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
                `Failed to create DocDB DBInstance ${logicalId}: ${text}`,
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

export async function updateDBInstance(
  this: DocDBProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating DocDB DBInstance ${logicalId}: ${physicalId}`);
  const mask = context?.maskSecrets;
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const insights = this.readBooleanProperty(
    'EnablePerformanceInsights',
    properties,
    resourceType,
    logicalId,
    {
      stateBorne: context?.replayingState === true || context?.desiredFromAwsReadback === true,
      physicalId,
    }
  );

  try {
    // #1160 reset-on-removal — ModifyDBInstance has merge semantics, but
    // every optional DocDB instance field is deliberately NOT reset:
    //   * AutoMinorVersionUpgrade — inert on DocDB (ModifyDBInstanceMessage
    //     doc: "This parameter does not apply to Amazon DocumentDB.
    //     Amazon DocumentDB does not perform minor version upgrades
    //     regardless of the value set"); synthesizing a reset would close
    //     no behavioral divergence.
    //   * PreferredMaintenanceWindow — a real CloudFormation A/B (#5543)
    //     showed CloudFormation KEEPS a removed window (alone and beside
    //     another instance change), so a removal sends nothing.
    //   * CACertificateIdentifier, EnablePerformanceInsights — KEPT too
    //     (#2762 A/B). Each goes out on a change only: re-sending either asks
    //     AWS for a restart or a feature change on every update.
    //     CertificateRotationRestart rides a certificate change, the one
    //     call it applies to; CreateDBInstance has no such member.
    const certificate = properties['CACertificateIdentifier'] as string | undefined;
    const live =
      (certificate != null && previousProperties['CACertificateIdentifier'] == null) ||
      (insights !== undefined && previousProperties['EnablePerformanceInsights'] == null)
        ? await this.describeDBInstance(physicalId)
        : undefined;
    const certificateChange = declaredChange(
      certificate,
      previousProperties['CACertificateIdentifier'],
      live?.CACertificateIdentifier
    );
    const insightsChange = declaredChange(
      insights,
      previousProperties['EnablePerformanceInsights'],
      live?.PerformanceInsightsEnabled ?? false
    );
    this.markChangedUnsettled(
      INSTANCE_MODIFY_UNSETTLED_KEYS,
      properties,
      previousProperties,
      context
    );
    // #5194: a cluster change in the same deploy can leave this member not
    // `available` for a moment; only that refusal is waited out and resent.
    await modifyDbInstanceWhenAvailable({
      send: () =>
        this.getClient().send(
          new ModifyDBInstanceCommand({
            DBInstanceIdentifier: physicalId,
            DBInstanceClass: properties['DBInstanceClass'] as string | undefined,
            PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as
              | string
              | undefined,
            AutoMinorVersionUpgrade: properties['AutoMinorVersionUpgrade'] as boolean | undefined,
            ...(certificateChange && { CACertificateIdentifier: certificate }),
            ...(certificateChange &&
              properties['CertificateRotationRestart'] != null && {
                CertificateRotationRestart: properties['CertificateRotationRestart'] as boolean,
              }),
            ...(insightsChange && { EnablePerformanceInsights: insights }),
            ApplyImmediately: true,
          })
        ),
      readStatus: async () => (await this.describeDBInstance(physicalId))?.DBInstanceStatus,
      sleep: (ms) => this.sleep(ms),
      logger: this.logger,
      label: 'DocDB DBInstance',
      logicalId,
      remainingMs: enclosingDeadlineRemainingMs(),
    });

    this.logger.debug(`Successfully updated DocDB DBInstance ${logicalId}`);

    if (process.env['CDKD_NO_WAIT'] !== 'true') {
      const applied = new Map<string, (instance: DBInstance | undefined) => boolean>();
      if (certificateChange) {
        applied.set(
          'CACertificateIdentifier',
          (instance) => instance?.CACertificateIdentifier === certificate
        );
      }
      if (insightsChange) {
        applied.set(
          'EnablePerformanceInsights',
          (instance) => instance?.PerformanceInsightsEnabled === insights
        );
      }
      await this.waitForApplied(logicalId, applied, () => this.describeDBInstance(physicalId));
    }

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

    // #5543: after every call succeeded, so a failed or retried update
    // never prints it.
    const keptWarning = keptOnRemovalWarning(
      DOCDB_INSTANCE_KEPT_ON_REMOVAL,
      properties,
      previousProperties,
      context,
      logicalId,
      resourceType
    );
    if (keptWarning !== undefined) this.logger.warn(keptWarning);

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
          `Failed to update DocDB DBInstance ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteDBInstance(
  this: DocDBProvider,
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
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
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
    throw this.wrapDeleteError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete DocDB DBInstance ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
