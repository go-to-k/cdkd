import type { LogsLogGroupProvider } from '../logs-loggroup-provider.js';
import {
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
  PutLogGroupDeletionProtectionCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import {
  deleteWithProtectionCompensation,
  logGroupProtectionSite,
  observeThenDisableProtection,
  protectionFlipKey,
  type ProtectionFlipRecord,
} from '../deletion-protection-compensation.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  assertRecordedIdentity,
  recordedIdentityId,
  RecordedIdentityError,
} from '../../recorded-identity.js';
import { logGroupIdentityToken, type LogGroupIdentityRead } from './shared.js';
import { deniedIdentityReadRefusal } from '../../identity-read-denied.js';

/**
 * Delete a CloudWatch Logs log group.
 *
 * The compensation boundary (issue #2204): a `--remove-protection` flip whose
 * delete then fails terminally is undone here, so a destroy that did not
 * happen does not leave a live log group with its guard stripped.
 */
export async function deleteImpl(
  this: LogsLogGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  await deleteWithProtectionCompensation({
    registry: this.protectionFlips,
    key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
    run: (flip) => this.deleteOnce(logicalId, physicalId, resourceType, context, flip),
    compensation: {
      logicalId,
      physicalId,
      logger: this.logger,
      site: logGroupProtectionSite(physicalId, context?.expectedRegion),
      reEnable: async () => {
        await this.logsClient.send(
          new PutLogGroupDeletionProtectionCommand({
            logGroupIdentifier: physicalId,
            deletionProtectionEnabled: true,
          })
        );
      },
    },
  });
}

export async function deleteOnce(
  this: LogsLogGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord
): Promise<void> {
  this.logger.debug(`Deleting log group ${logicalId}: ${physicalId}`);

  // go-to-k/cdkd#6665: a record holding a `LogGroupIdentity` refuses a holder
  // of the name created at another time, before any write (the protection
  // flip included). One `DescribeLogGroups`, made only for such a record,
  // whose listing the `--remove-protection` observe below reuses. Not listed:
  // no holder to compare at read time, so the by-name delete goes on and only
  // its typed not-found says gone (a listing that lags must not drop the
  // record of a live group). A denied read refuses, non-retryably. No identity
  // recorded (a record written before cdkd recorded one): no read, the by-name
  // delete.
  let identityRead: LogGroupIdentityRead | undefined;
  if (recordedIdentityId(resourceType, context) !== undefined) {
    const read = async () => {
      identityRead = await this.readIdentityIfExists(physicalId);
      return identityRead;
    };
    try {
      const first = await read();
      if (first !== undefined) {
        await assertRecordedIdentity({
          label: 'log group',
          resourceType,
          logicalId,
          physicalId,
          liveId: logGroupIdentityToken(first),
          // A re-read that no longer lists it answers no id: refused, re-run.
          reread: async () => {
            const again = await read();
            return again === undefined ? undefined : logGroupIdentityToken(again);
          },
          context,
          // The common benign holder: AWS services (Lambda, API Gateway, ECS,
          // ...) create the group again under its fixed name when they write
          // to it after it was deleted.
          recreatedBy: 'for example Lambda writing to its /aws/lambda/<function> group',
        });
      }
    } catch (error) {
      // The identity refusals: already worded (no AWS text) and marked.
      if (error instanceof RecordedIdentityError) throw error;
      throw (
        deniedIdentityReadRefusal(error, {
          label: 'log group',
          permission: 'logs:DescribeLogGroups',
          resourceType,
          logicalId,
          physicalId,
          context,
        }) ?? this.wrapDeleteError(logicalId, physicalId, resourceType, context, error)
      );
    }
  }

  // `--remove-protection`: flip DeletionProtectionEnabled off before
  // delete. Idempotent — AWS accepts the call when protection is
  // already disabled. Non-fatal: log at debug if the flip-off itself
  // errors (NotFound / similar) so the actual delete attempt still
  // runs and surfaces its own error message. The pre-flip readback is what
  // lets a terminal failure restore ONLY a guard this run turned off.
  if (context?.removeProtection === true) {
    try {
      await observeThenDisableProtection({
        flip,
        logger: this.logger,
        physicalId,
        mask: context?.maskSecrets,
        guardName: 'DeletionProtectionEnabled',
        observe: async () => {
          if (identityRead !== undefined) return identityRead.deletionProtectionEnabled;
          const resp = await this.logsClient.send(
            new DescribeLogGroupsCommand({ logGroupNamePrefix: physicalId })
          );
          // A prefix match: only the EXACT name is this log group.
          const found = resp.logGroups?.find((g) => g.logGroupName === physicalId);
          return found?.deletionProtectionEnabled === true;
        },
        disable: async () => {
          await this.logsClient.send(
            new PutLogGroupDeletionProtectionCommand({
              logGroupIdentifier: physicalId,
              deletionProtectionEnabled: false,
            })
          );
        },
      });
      this.logger.debug(
        `Disabled DeletionProtectionEnabled on log group ${logicalId} before delete`
      );
    } catch (flipError) {
      this.logger.debug(
        maskerOrIdentity(context?.maskSecrets)(
          `Could not disable DeletionProtectionEnabled on ${physicalId}: ${describeAwsFailure(flipError).detail}`
        )
      );
    }
  }

  try {
    await this.logsClient.send(new DeleteLogGroupCommand({ logGroupName: physicalId }));
    // AWS took the delete. `DeleteLogGroup` has no wait after it today, but
    // the latch is what keeps a future one from re-enabling the guard on a
    // log group that is already going.
    flip.deleteAccepted = true;
    this.logger.debug(`Successfully deleted log group ${logicalId}`);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.logsClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logGoneOnDelete(logicalId, physicalId, context);
      return;
    }
    throw this.wrapDeleteError(logicalId, physicalId, resourceType, context, error);
  }
}

/**
 * The delete's failure wrap, for `DeleteLogGroup` and (go-to-k/cdkd#6665) the
 * identity read before it. The wrap names an AWS failure by its CLASS, which
 * the delete classifiers read as "already deleted" on a `NotFound` needle:
 * only the typed not-found means this one is gone (go-to-k/cdkd#2319).
 */
export function wrapDeleteError(
  this: LogsLogGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  error: unknown
): ProvisioningError {
  const cause = error instanceof Error ? error : undefined;
  const thrown = this.wrapCaughtError(
    maskerOrIdentity(context?.maskSecrets),
    error,
    (text) =>
      new ProvisioningError(
        `Failed to delete log group ${logicalId}: ${text}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      )
  );
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
}

/**
 * The not-found arm of `delete`. A journaled failed-CREATE orphan already
 * gone settles with exit 0 (go-to-k/cdkd#4606), so it is said once at info;
 * the name is interpolated verbatim for the caller's printing bag to mask.
 */
export function logGoneOnDelete(
  this: LogsLogGroupProvider,
  logicalId: string,
  physicalId: string,
  context: DeleteContext | undefined
): void {
  if (context?.failedCreateOrphan === true) {
    this.logger.info(
      safeMsg`  Log group ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
    );
  } else {
    this.logger.debug(`Log group ${physicalId} does not exist, skipping deletion`);
  }
}
