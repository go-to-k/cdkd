import type { NeptuneProvider } from '../neptune-provider.js';
import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  ModifyDBInstanceCommand,
} from '@aws-sdk/client-neptune';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { generatedNameFor } from '../../resource-name.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  deleteWithProtectionCompensation,
  observeThenDisableProtection,
  protectionFlipKey,
  rdsFamilyProtectionSite,
  type ProtectionFlipRecord,
} from '../deletion-protection-compensation.js';
import { modifyDbInstanceWhenAvailable } from '../db-instance-modify-retry.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { coerceCfnBoolean } from '../../config-shape.js';
import {
  INSTANCE_KEPT_ON_REMOVAL,
  INSTANCE_MODIFY_KEYS,
  instanceAttributes,
  markChangedUnsettled,
} from './shared.js';

// ─── DBInstance ───────────────────────────────────────────────────

export async function createDBInstance(
  this: NeptuneProvider,
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
        PreferredMaintenanceWindow: properties['PreferredMaintenanceWindow'] as string | undefined,
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

export async function updateDBInstance(
  this: NeptuneProvider,
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
            AllowMajorVersionUpgrade: properties['AllowMajorVersionUpgrade'] as boolean | undefined,
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
export async function deleteDBInstance(
  this: NeptuneProvider,
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

export async function deleteDBInstanceOnce(
  this: NeptuneProvider,
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
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
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
