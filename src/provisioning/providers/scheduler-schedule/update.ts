import type { SchedulerScheduleProvider } from '../scheduler-schedule-provider.js';
import {
  UpdateScheduleCommand,
  ResourceNotFoundException,
  type UpdateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import type { UpdateContext, ResourceUpdateResult } from '../../../types/resource.js';
import { isSecretDerivedValue, maskerOrIdentity } from '../../masked-retry-logger.js';
import { redactForState, withoutPhysicalNameCopies } from '../../../deployment/secret-redaction.js';
import { markNonRetryable, markRedactedCause } from '../../../deployment/retryable-errors.js';
import { getCurrentResourceSecrets } from '../../../deployment/resource-secrets-scope.js';
import {
  RECORDED_CREATION_DATE_KEY,
  RECORDED_ONLY,
  groupShown,
  recordedCreationDate,
  recordedTarget,
  sameRecordedDate,
  sameRecordedIdentity,
  type ScheduleIdentity,
} from './shared.js';

/**
 * The refusal for a confirmation lookup that failed for a reason other than
 * NotFound: it names the failure's class only, and keeps the AWS text on the
 * stamped cause, so the retry classifiers still read a throttle.
 */
export function wrapUnconfirmedGroupError(
  this: SchedulerScheduleProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  error: unknown,
  mask: (text: string) => string
): ProvisioningError {
  const failureClass =
    error instanceof Error && error.name !== '' ? error.name : 'an unreadable failure';
  return markRedactedCause(
    new ProvisioningError(
      `Whether the group the GroupName of Schedule ${logicalId} resolves to still holds ` +
        `this schedule could not be confirmed (${mask(failureClass)}) — re-run once the lookup can succeed`,
      resourceType,
      logicalId,
      physicalId,
      error instanceof Error ? error : undefined
    )
  );
}

/**
 * A non-retryable refusal that is NOT `ResourceUpdateNotSupportedError`, so
 * `--replace` never acts on it. `secretDerived` picks the wording: a rotated
 * secret is the likely cause only when the group comes from one.
 */
export function refuseUnconfirmed(
  this: SchedulerScheduleProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  finding: string,
  secretDerived: boolean,
  remedy: string
): never {
  throw markNonRetryable(
    new ProvisioningError(
      `${
        secretDerived
          ? `GroupName of Schedule ${logicalId} is secret-derived, and the group its secret now resolves to`
          : `The group of Schedule ${logicalId}`
      } ${finding}${secretDerived ? ' (the secret may have been rotated)' : ''}, so nothing is ` +
        `written to it, with or without --replace: ${remedy}`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * go-to-k/cdkd#4275: does the group `groupName` hold, under `physicalId`, the
 * schedule cdkd recorded? Its identity is the recorded creation date AND,
 * unless the recorded value is itself redacted, the recorded target ARN: a
 * creation date alone can coincide for two same-named schedules created in
 * one instant (parallel environment deploys).
 *
 * - `'confirmed'`: it does.
 * - `'absent'` (NotFound) / `'undated'` (no recorded date, nothing read):
 *   the caller decides.
 * - Another creation date: a schedule this stack does not own holds the
 *   name there; the recorded date with another target or role: likely this
 *   one, edited outside cdkd. Each THROWS through {@link refuseUnconfirmed},
 *   with its own remedy.
 * - Any other lookup failure throws {@link wrapUnconfirmedGroupError}.
 *
 * No message prints a group: it may be secret-derived.
 */
export async function confirmRecordedSchedule(
  this: SchedulerScheduleProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  groupName: string | undefined,
  recorded: ScheduleIdentity,
  mask: (text: string) => string
): Promise<'confirmed' | 'absent' | 'undated'> {
  if (recorded.creation === undefined) return 'undated';
  let live: ScheduleIdentity;
  try {
    live = await this.readIdentity(physicalId, groupName);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return 'absent';
    throw this.wrapUnconfirmedGroupError(logicalId, physicalId, resourceType, error, mask);
  }
  if (sameRecordedDate(live, recorded) && !sameRecordedIdentity(live, recorded)) {
    // Likely this schedule with its target edited outside cdkd, not a
    // rotation: say so, without the secret remedy.
    this.refuseUnconfirmed(
      logicalId,
      physicalId,
      resourceType,
      'holds a schedule of this name that carries the recorded creation date but not the recorded target or role (edited outside cdkd?)',
      false,
      'restore them, or drop the record with `cdkd orphan <construct path>` and deploy again'
    );
  }
  if (!sameRecordedIdentity(live, recorded)) {
    this.refuseUnconfirmed(
      logicalId,
      physicalId,
      resourceType,
      'holds a different schedule of this name (its creation date is not the one cdkd recorded)',
      true,
      "restore the secret's value to the schedule's group"
    );
  }
  return 'confirmed';
}

/**
 * Did the template RE-POINT a secret-derived GroupName (a different
 * reference), rather than the secret rotate under the same one? Read from
 * the deploy's own resolved-secrets bag (value -> reference): re-redacting
 * the desired group the way the state record was written gives back the
 * recorded reference exactly only when the reference is unchanged. No bag (a
 * rollback, `drift --revert`) or a recorded mask cannot tell, and reads as
 * NOT re-pointed, so the caller keeps the refusal `--replace` cannot act on.
 */
export function referenceRepointed(
  this: SchedulerScheduleProvider,
  desiredGroup: string | undefined,
  recordedGroup: unknown
): boolean {
  const bag = getCurrentResourceSecrets();
  if (bag === undefined || typeof desiredGroup !== 'string') return false;
  if (typeof recordedGroup !== 'string' || !recordedGroup.includes('{{resolve:')) return false;
  // The way the record was WRITTEN for a reference: a read physical id's
  // copy is kept as plaintext since go-to-k/cdkd#4810, and re-redacting
  // with that rule would read every `Ref`'d group as re-pointed.
  return (
    withoutPhysicalNameCopies(bag, () =>
      redactForState(desiredGroup, { provenance: 'value-scan', secrets: bag })
    ) !== recordedGroup
  );
}

export async function update(
  this: SchedulerScheduleProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const groupName = this.groupNameOf(properties);
  const previousGroupName = this.groupNameOf(previousProperties);
  const mask = maskerOrIdentity(context?.maskSecrets);
  const recorded = {
    creation: recordedCreationDate(context?.recordedAttributes),
    ...recordedTarget(previousProperties),
  };
  const replaying = context?.replayingState === true;
  const desiredSecretDerived = isSecretDerivedValue(properties['GroupName'], mask);

  // go-to-k/cdkd#4275: a probe of the resolved group alone cannot tell a
  // rotated secret from an unchanged one (two environments whose groups both
  // hold a schedule of this name); the recorded identity tells them apart.
  // Two shapes reach here with a secret-derived group:
  // - a deploy: the record keeps the group as its `{{resolve:...}}`
  //   reference (or `***`) and this side is resolved, so the two never
  //   compare equal. Confirmed only while the DESIRED side is still
  //   secret-derived: a template that moved the group to a literal (or
  //   dropped it) is a real move, which keeps the typed refusal below.
  // - a rollback revert: both sides are resolved by the replay and compare
  //   equal. Confirmed when the group is secret-derived (the replay's masker
  //   matches a whole value whatever its length); a literal group cannot be
  //   redirected by a secret, so it is not probed, and an out-of-band
  //   recreate of it does not wedge every later revert.
  let confirmedMove = false;
  if (
    groupName !== previousGroupName &&
    isSecretDerivedValue(previousProperties['GroupName'], RECORDED_ONLY) &&
    desiredSecretDerived
  ) {
    const verdict = await this.confirmRecordedSchedule(
      logicalId,
      physicalId,
      resourceType,
      groupName,
      recorded,
      mask
    );
    if (verdict === 'undated') {
      // A record from before cdkd kept the date: nothing identifies the
      // schedule, and `--replace` cannot help (its delete skips a redacted
      // group, and a create under the same name collides).
      this.refuseUnconfirmed(
        logicalId,
        physicalId,
        resourceType,
        'cannot be confirmed to hold this schedule: its state record predates the creation date cdkd now records',
        true,
        'delete the schedule by hand (`aws scheduler delete-schedule`), drop its record with `cdkd orphan <construct path>`, and deploy again, which records the date'
      );
    }
    if (
      verdict === 'absent' &&
      !this.referenceRepointed(groupName, previousProperties['GroupName'])
    ) {
      // Same reference, a group without the schedule: the secret moved, not
      // the template. `--replace` would create this schedule in whatever group
      // the secret now names, possibly another environment's.
      this.refuseUnconfirmed(
        logicalId,
        physicalId,
        resourceType,
        'holds no schedule of this name',
        true,
        "restore the secret's value to the schedule's group; if the schedule was deleted outside cdkd, drop its record with `cdkd orphan <construct path>` and deploy again"
      );
    }
    // A re-pointed reference falls to the typed refusal: a template change.
    confirmedMove = verdict === 'confirmed';
  } else if (
    groupName === previousGroupName &&
    replaying &&
    recorded.creation !== undefined &&
    // A group composed with an embedded secret below the masker's
    // substring floor is not recognised and reverts without a probe; state
    // redaction shares that floor, so nothing recorded marks it either.
    desiredSecretDerived
  ) {
    const verdict = await this.confirmRecordedSchedule(
      logicalId,
      physicalId,
      resourceType,
      groupName,
      recorded,
      mask
    );
    if (verdict !== 'confirmed') {
      this.refuseUnconfirmed(
        logicalId,
        physicalId,
        resourceType,
        'holds no schedule of this name',
        true,
        "restore the secret's value to the schedule's group, then re-run the rollback"
      );
    }
  }
  if (groupName !== previousGroupName && !confirmedMove) {
    // GroupName is how the API ADDRESSES the schedule — there is no
    // in-place move between groups. The engine's --replace fallback
    // recreates the schedule in the new group.
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      // Issue [#2610] site 13, the twin of
      // `dlm-lifecycle-policy-provider.ts`'s: `--replace` is a BOOLEAN option
      // and `cdkd deploy` takes `[stacks...]`, so the appended logical id was
      // parsed as a STACK NAME. The head of
      // `ResourceUpdateNotSupportedError` already names the resource.
      // `from <a> to <b>`, not ` -> `: pasted, that is `-` plus a `>`
      // redirect onto the group name after it (go-to-k/cdkd#4239). Masked
      // where it is built, like the debug line below: a secret-derived group
      // reaches this refusal RESOLVED on the desired side (go-to-k/cdkd#4275).
      // `DeployEngine` also masks a thrown message; this does not rely on it.
      // Each group is then named only when plain and described otherwise:
      // it is template-chosen, unvalidated here, and printed on the line
      // that names `cdkd deploy --replace` (go-to-k/cdkd#4214's rule).
      `GroupName addresses the schedule (from ${groupShown(mask(previousGroupName ?? 'default'))} ` +
        `to ${groupShown(mask(groupName ?? 'default'))}); ` +
        `re-run with \`cdkd deploy --replace\` to recreate it in the new group ` +
        `(--replace is a boolean flag and takes no resource id; it applies to every ` +
        `resource in the run whose in-place update is refused)`
    );
  }

  // Masked: a rollback replay hands both sides RESOLVED, so a secret-derived
  // group reaches this line (go-to-k/cdkd#4275).
  this.logger.debug(
    mask(
      `Updating Schedule ${logicalId}: ${mask(physicalId)}${groupName ? ` (group: ${mask(groupName)})` : ''}`
    )
  );

  try {
    // UpdateSchedule is a full-replace API: unspecified fields reset to
    // their defaults, so always send the complete desired configuration.
    const input: UpdateScheduleCommandInput = {
      Name: physicalId,
      ...(groupName && { GroupName: groupName }),
      ...this.toSdkFields(properties),
    };
    const response = await this.getClient().send(new UpdateScheduleCommand(input));
    // Returned attributes REPLACE the record's, so the creation date is
    // always returned (go-to-k/cdkd#4275):
    // - a rollback revert carries the recorded one and reads nothing: its
    //   group was resolved again by the replay;
    // - a secret-derived group carries the recorded one it was confirmed by;
    // - a literal group reads it again from the schedule just written, so a
    //   record from before cdkd kept one is backfilled and an out-of-band
    //   recreate is picked up; a failed read carries the recorded one.
    const creationDate =
      replaying || desiredSecretDerived
        ? recorded.creation
        : ((await this.creationDateBestEffort(logicalId, physicalId, groupName)) ??
          recorded.creation);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        ...(response.ScheduleArn && { Arn: response.ScheduleArn }),
        ...(creationDate !== undefined && { [RECORDED_CREATION_DATE_KEY]: creationDate }),
      },
    };
  } catch (error) {
    if (error instanceof ResourceUpdateNotSupportedError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Schedule ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
