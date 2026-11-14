import type { SchedulerScheduleProvider } from '../scheduler-schedule-provider.js';
import {
  DeleteScheduleCommand,
  ListSchedulesCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-scheduler';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { markNotGone } from '../../not-gone.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import { markNonRetryable, markRedactedCause } from '../../../deployment/retryable-errors.js';
import { displaySafe, isPasteableIdent, safeMsg } from '../../../utils/display-safe.js';
import { withPasteableAwsProfile } from '../../../utils/pasteable-aws-profile.js';
import { shellQuote } from '../../../state/lock-contention-message.js';
import {
  cdkdRemedy,
  hasClauseBreak,
  isInertUnquoted,
  proseQuoted,
} from '../../../utils/pasteable-command.js';
import { isAwsCliLiteral } from '../../replacement-protection-advice.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import {
  AMBIGUOUS_SCHEDULE_SKIP_REASON,
  NO_REGION_FOR_SCHEDULE_SEARCH_SKIP_REASON,
  recordedCreationDate,
  recordedTarget,
  sameRecordedDate,
  sameRecordedIdentity,
  type ScheduleIdentity,
} from './shared.js';

/**
 * go-to-k/cdkd#4275: delete a schedule whose recorded GroupName is redacted
 * (a secret reference or its mask), which names no group. Every schedule
 * named `physicalId` is listed across all groups, and the one whose
 * `GetSchedule` {@link ScheduleIdentity} is the recorded one is deleted in its
 * group. The comparison reads `GetSchedule`, the API the date was recorded
 * from, never the listing's own copy.
 *
 * No schedule of the name carrying the recorded DATE, on a second complete
 * listing a moment later too, means the schedule is gone, so the record goes,
 * with a warning. One carrying the date whose target or role differs (edited
 * outside cdkd) is not proof of either, so the delete is skipped and the
 * record kept. Both listings read every page and are region-checked first,
 * since a client in another region would list nothing; a record with no
 * region to check against (one written before state recorded it) is skipped
 * instead and keeps its record. More than one match is refused. No AWS text
 * is quoted and no group is logged.
 */
export async function deleteByRecordedIdentity(
  this: SchedulerScheduleProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  recorded: ScheduleIdentity,
  context: DeleteContext | undefined
): Promise<void | ResourceDeleteResult> {
  if (!context?.expectedRegion) {
    this.logger.warn(
      safeMsg`Schedule ${logicalId} is recorded with a secret-derived GroupName and no stack region, so cdkd cannot scope the search for it; skipping deletion and keeping its state record. Delete the schedule by hand, then drop the record with ${proseQuoted(cdkdRemedy('cdkd orphan'))}.`
    );
    return { outcome: 'skipped', reason: NO_REGION_FOR_SCHEDULE_SEARCH_SKIP_REASON };
  }
  assertRegionMatch(
    await this.getClient().config.region(),
    context.expectedRegion,
    resourceType,
    logicalId,
    physicalId
  );
  const wrapDeleteError = (step: string, error: unknown): ProvisioningError => {
    const failureClass =
      error instanceof Error && error.name !== '' ? error.name : 'an unreadable failure';
    const wrapped = markRedactedCause(
      new ProvisioningError(
        `Failed to delete Schedule ${logicalId}: its recorded GroupName is secret-derived, ` +
          `and ${step} failed (${failureClass})`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      )
    );
    // The read and the delete return on `ResourceNotFoundException` before
    // reaching here, so the one `*NotFound` left is a failed LISTING, which
    // is not this method's proof of "gone" (two complete listings with no
    // match). The wrap carries the class, which satisfies the "already
    // deleted" classifiers' `ResourceNotFoundException` needle and would
    // drop the record unproven, so mark it not gone: they check the marker
    // first (go-to-k/cdkd#5222, #5228). A listing that failed on a racing
    // group delete keeps its retry, which re-lists.
    return error instanceof Error && error.name.includes('NotFound')
      ? markNotGone(wrapped)
      : wrapped;
  };
  const findMatches = async (): Promise<{ matches: string[]; datedOnly: number }> => {
    const groups: string[] = [];
    try {
      let nextToken: string | undefined;
      do {
        const page = await this.getClient().send(
          new ListSchedulesCommand({
            NamePrefix: physicalId,
            ...(nextToken !== undefined && { NextToken: nextToken }),
          })
        );
        for (const schedule of page.Schedules ?? []) {
          if (schedule.Name === physicalId && typeof schedule.GroupName === 'string') {
            groups.push(schedule.GroupName);
          }
        }
        nextToken = page.NextToken;
      } while (nextToken !== undefined && nextToken !== '');
    } catch (error) {
      throw wrapDeleteError('listing the schedules of its name', error);
    }
    const matches: string[] = [];
    let datedOnly = 0;
    for (const group of groups) {
      let live: ScheduleIdentity;
      try {
        live = await this.readIdentity(physicalId, group);
      } catch (error) {
        // Deleted between the listing and this read: not this schedule.
        if (error instanceof ResourceNotFoundException) continue;
        throw wrapDeleteError('reading a schedule of its name', error);
      }
      if (sameRecordedIdentity(live, recorded)) matches.push(group);
      else if (sameRecordedDate(live, recorded)) datedOnly++;
    }
    return { matches, datedOnly };
  };
  let found = await findMatches();
  // Once more, a moment later, before concluding "gone": a listing can lag a
  // recent write.
  if (found.matches.length === 0 && found.datedOnly === 0) {
    await this.sleep(this.readBackDelaysMs[0] ?? 0);
    found = await findMatches();
  }
  const { matches } = found;
  if (matches.length === 0 && found.datedOnly > 0) {
    this.logger.warn(
      safeMsg`Schedule ${logicalId}: a schedule of its name carries the recorded creation date but not the recorded target or role (edited outside cdkd?), so cdkd cannot tell whether it is this one; skipping deletion and keeping its state record. Delete it by hand if it is, then drop the record with ${proseQuoted(cdkdRemedy('cdkd orphan'))}.`
    );
    return { outcome: 'skipped', reason: AMBIGUOUS_SCHEDULE_SKIP_REASON };
  }
  if (matches.length === 0) {
    this.logger.warn(
      safeMsg`Schedule ${logicalId}: no schedule of its name carries the creation date cdkd recorded, so it is treated as already deleted and its state record is removed`
    );
    return;
  }
  if (matches.length > 1) {
    throw markNonRetryable(
      new ProvisioningError(
        `Failed to delete Schedule ${logicalId}: its recorded GroupName is secret-derived, and ` +
          `${matches.length} schedules of its name match the one cdkd recorded, so none is deleted`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  try {
    await this.getClient().send(
      new DeleteScheduleCommand({ Name: physicalId, GroupName: matches[0] })
    );
    this.logger.debug(safeMsg`Deleted Schedule ${logicalId} (found by its recorded creation date)`);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return;
    throw wrapDeleteError('the delete', error);
  }
}

export async function deleteImpl(
  this: SchedulerScheduleProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // go-to-k/cdkd#3952: the recorded GroupName addresses the schedule.
  const redactedFields = redactedDeleteAddressFields({ GroupName: properties?.['GroupName'] });
  // go-to-k/cdkd#4275: a redacted group is found by the recorded creation
  // date instead, when the record holds one.
  const recordedCreation = recordedCreationDate(context?.recordedAttributes);
  if (redactedFields.length > 0 && recordedCreation !== undefined) {
    return this.deleteByRecordedIdentity(
      logicalId,
      physicalId,
      resourceType,
      { creation: recordedCreation, ...recordedTarget(properties) },
      context
    );
  }
  const skip = redactedDeleteAddressSkip(this.logger, logicalId, 'Schedule', redactedFields);
  if (skip) return skip;
  const groupName = this.groupNameOf(properties);
  if (properties === undefined) {
    // A degraded state record without properties cannot recover the group.
    // The delete below targets the DEFAULT group; a custom-group schedule
    // would then hit the NotFound-idempotent branch and be left behind —
    // surface that instead of staying silent (the #961 orphan shape).
    // The manual-recovery hint names a DELETE, which makes it the
    // highest-consequence paste in this file, and `physicalId` is a
    // `state.json` value. Same treatment as the issue [#2610] replacement
    // advice: sanitize, shell-quote, and SUPPRESS the command when
    // sanitizing changes the id, because a delete naming a sanitized name
    // would remove a DIFFERENT schedule. It was previously interpolated
    // UNQUOTED, so a name carrying a space split the arguments.
    const safeId = displaySafe(physicalId, { asciiOnly: true });
    // A clause break in the name (`: `, `. `, ...) lets a pasted selection
    // start INSIDE the shell quotes, so such a name is never printed, in the
    // command or in the prose (go-to-k/cdkd#3950). Nor is one that is not
    // inert with its quotes stripped (go-to-k/cdkd#4205): an apostrophe in
    // whatever the operator pastes with the hint flips the quote parity.
    // Nor is one the aws CLI itself acts on, e.g. a `file://` prefix or a
    // leading `-` (go-to-k/cdkd#4199).
    const nameShowable =
      !!safeId &&
      safeId === physicalId &&
      !hasClauseBreak(safeId) &&
      isInertUnquoted(safeId) &&
      isAwsCliLiteral(safeId);
    const manualHint = nameShowable
      ? `If the schedule lives in a custom group, delete it manually: ` +
        `${withPasteableAwsProfile('aws scheduler delete-schedule')} --name ${shellQuote(safeId)} --group-name '<group>'`
      : `If the schedule lives in a custom group, delete it manually via the console: the ` +
        `name recorded for it cannot be reproduced safely on a command line.`;
    // Neither value goes inside a hand-written `'...'` unless it is a plain
    // identifier (go-to-k/cdkd#3950): `safeId` keeps `'`, `;` and `$( )`, so
    // a `'` in it closed cdkd's quote. A name the manual hint can print is
    // shown the way the hint prints it, through `shellQuote`, so the two
    // agree; anything else, including an empty or unrenderable name, is
    // described. The logical id is a `state.json` key, described likewise.
    const shownName = isPasteableIdent(physicalId)
      ? `'${physicalId}'`
      : nameShowable
        ? shellQuote(safeId)
        : 'a schedule whose recorded name is not a plain identifier';
    const subject = isPasteableIdent(logicalId)
      ? `State record for Schedule ${logicalId}`
      : 'The state record of a Schedule whose logical id is not a plain identifier';
    this.logger.warn(
      `${subject} carries no properties — deleting ${shownName} from the default group. ` +
        manualHint
    );
  }

  this.logger.debug(
    `Deleting Schedule ${logicalId}: ${physicalId}${groupName ? ` (group: ${groupName})` : ''}`
  );

  try {
    await this.getClient().send(
      new DeleteScheduleCommand({
        Name: physicalId,
        ...(groupName && { GroupName: groupName }),
      })
    );
    this.logger.debug(`Deleted Schedule ${logicalId}`);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Schedule ${logicalId} already deleted (not found), treating as success`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Schedule ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
