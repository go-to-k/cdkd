import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
  ResourceNotFoundException,
  type CreateScheduleCommandInput,
  type UpdateScheduleCommandInput,
  type Target,
  type FlexibleTimeWindow,
} from '@aws-sdk/client-scheduler';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { isSecretDerivedValue, maskerOrIdentity } from '../masked-retry-logger.js';
import { SECRET_MASK, redactSecretsForState } from '../../deployment/secret-redaction.js';
import {
  isThrottlingError,
  markNonRetryable,
  markRedactedCause,
} from '../../deployment/retryable-errors.js';
import { getCurrentResourceSecrets } from '../../deployment/resource-secrets-scope.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { displaySafe, isPasteableIdent, safeMsg } from '../../utils/display-safe.js';
import { withPasteableAwsProfile } from '../../utils/pasteable-aws-profile.js';
import { shellQuote } from '../../state/lock-contention-message.js';
import {
  hasClauseBreak,
  isInertUnquoted,
  plainOrDescribed,
} from '../../utils/pasteable-command.js';
import { isAwsCliLiteral } from '../replacement-protection-advice.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../redacted-delete-address.js';

/**
 * SDK Provider for AWS::Scheduler::Schedule.
 *
 * Why an SDK provider instead of the Cloud Control fallback (issue #961):
 * the type's registry `primaryIdentifier` is `/properties/Name` ONLY, but
 * the AWS read/update/delete handlers resolve a bare Name against the
 * DEFAULT schedule group. A schedule created with `GroupName` set to a
 * custom group is therefore unaddressable via Cloud Control — no identifier
 * form works (bare name -> NotFound in the default group; `grp|name` ->
 * ValidationException; the ARN fails the name-pattern check; the schema has
 * no additionalIdentifiers). Empirically: CC UPDATE failed NotFound, and CC
 * DELETE landed FAILED/NotFound which the delete path swallowed as
 * idempotent success — silently orphaning a LIVE schedule that keeps firing
 * its target. CloudFormation is unaffected because its handler invocations
 * carry the full previous resource model (including GroupName); the
 * Scheduler SDK APIs all accept an explicit `GroupName` parameter, which
 * this provider threads from the resource properties.
 *
 * physicalId is the schedule NAME (matches CFn: `Ref` returns the Name, and
 * pre-existing Cloud-Control-provisioned state also stored the bare name, so
 * the physicalId is stable across the migration). Because pre-existing
 * records say `provisionedBy: 'cc-api'`, the type is ALSO exempted from the
 * sticky cc-api routing rule (see STICKY_CC_MIGRATION_EXEMPT in
 * provider-registry.ts) — without the exemption the broken CC path would
 * keep serving existing schedules. GroupName is recovered from `properties`
 * on update/delete/readCurrentState — the state record carries the resolved
 * properties.
 *
 * A GroupName change is rejected with `ResourceUpdateNotSupportedError`:
 * `UpdateSchedule` uses GroupName to ADDRESS the schedule (a different
 * group means "a different schedule"), so an in-place move between groups
 * is impossible at the API level. The deploy engine's `--replace` fallback
 * recreates the schedule in the new group.
 *
 * A secret-derived GroupName is recorded as its `{{resolve:...}}` reference
 * and reaches `update()` resolved, so the two never compare equal
 * (go-to-k/cdkd#4275). The schedule's identity is then the creation date
 * cdkd recorded for it ({@link RECORDED_CREATION_DATE_KEY}): the update goes
 * ahead only when the schedule the resolved group holds under this name has
 * that creation date, so a rotated secret naming another environment's
 * group is never written to.
 */

/**
 * The attribute key under which cdkd records a schedule's AWS creation date
 * (`GetSchedule`'s `CreationDate`, ISO 8601): the only non-secret identity a
 * schedule has, since its ARN embeds the group, which may be secret-derived
 * (and is then recorded redacted). Not a CloudFormation attribute: no
 * template can `Fn::GetAtt` it, and no CloudFormation name contains `:`.
 */
export const RECORDED_CREATION_DATE_KEY = 'cdkd:CreationDate';

/** The recorded creation date, or `undefined` when the record holds none. */
function recordedCreationDate(
  attributes: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const value = attributes?.[RECORDED_CREATION_DATE_KEY];
  if (typeof value !== 'string' || value === '') return undefined;
  // Only a date this provider wrote: state redaction rewrites any attribute
  // substring equal to a secret, and a rewritten date would match no schedule,
  // so the delete would read every schedule of its name as "already gone".
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

/**
 * The identity masker, for a RECORDED value: it masks nothing, so
 * `isSecretDerivedValue` answers from its spelling alone, a `{{resolve:`
 * reference or the whole mask. The mask arm matches state's `***` because
 * `MASK_WALK_DEPTH_CAP_MARKER` (what that function compares with) IS
 * `SECRET_MASK` (pinned by a unit test).
 */
const RECORDED_ONLY = maskerOrIdentity(undefined);

/**
 * A schedule's identity as cdkd compares it: its AWS creation date (in the form
 * cdkd records, `toISOString()`) and its target's ARN and role ARN. The date
 * alone can coincide for two same-named schedules created in one instant
 * (parallel environment deploys), and a target ARN alone is shared by every
 * schedule calling one universal target, queue or function.
 */
interface ScheduleIdentity {
  creation: string | undefined;
  targetArn: string | undefined;
  roleArn: string | undefined;
}

/** A recorded identity field: `undefined` when absent or itself redacted. */
function usableRecorded(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && !isSecretDerivedValue(value, RECORDED_ONLY)
    ? value
    : undefined;
}

/**
 * The recorded target half of a schedule's identity. A field that cannot
 * serve (absent, not a string, or secret-derived and so recorded redacted,
 * matching nothing) is `undefined` and is not compared.
 */
function recordedTarget(
  properties: Record<string, unknown> | undefined
): Pick<ScheduleIdentity, 'targetArn' | 'roleArn'> {
  const target = properties?.['Target'];
  const fields =
    typeof target === 'object' && target !== null && !Array.isArray(target)
      ? (target as Record<string, unknown>)
      : {};
  return { targetArn: usableRecorded(fields['Arn']), roleArn: usableRecorded(fields['RoleArn']) };
}

/** Does a live schedule carry the recorded creation date? */
function sameRecordedDate(live: ScheduleIdentity, recorded: ScheduleIdentity): boolean {
  return live.creation !== undefined && live.creation === recorded.creation;
}

/** Does a live schedule's identity match the recorded one, field by field? */
function sameRecordedIdentity(live: ScheduleIdentity, recorded: ScheduleIdentity): boolean {
  return (
    sameRecordedDate(live, recorded) &&
    (recorded.targetArn === undefined || live.targetArn === recorded.targetArn) &&
    (recorded.roleArn === undefined || live.roleArn === recorded.roleArn)
  );
}

/**
 * The `ResourceDeleteResult.reason` for a secret-group schedule whose record
 * has no stack region to scope the search with. Fixed wording: a reason is
 * classified by SUBSTRING (`.claude/rules/provider-delete-path.md`).
 */
export const NO_REGION_FOR_SCHEDULE_SEARCH_SKIP_REASON =
  'secret-derived group and no recorded region — no delete issued';

/** The same, for a schedule carrying the recorded date but not the recorded target. */
export const AMBIGUOUS_SCHEDULE_SKIP_REASON =
  'schedule matches the recorded date but not its target — no delete issued';

/**
 * A schedule group as the GroupName refusal prints it (go-to-k/cdkd#4239):
 * named when plain, described otherwise. The mask marker passes through as
 * itself: it is a fixed cdkd literal (pasted, at most a glob that runs
 * nothing), and it says that the group came from a secret.
 */
function groupShown(group: string): string {
  return group === SECRET_MASK ? group : plainOrDescribed(group, 'group name');
}
export class SchedulerScheduleProvider implements ResourceProvider {
  private client: SchedulerClient | undefined;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('SchedulerScheduleProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Scheduler::Schedule',
      new Set([
        'Name',
        'GroupName',
        'Description',
        'ScheduleExpression',
        'ScheduleExpressionTimezone',
        'StartDate',
        'EndDate',
        'State',
        'KmsKeyArn',
        'FlexibleTimeWindow',
        'Target',
      ]),
    ],
  ]);

  private getClient(): SchedulerClient {
    if (!this.client) {
      this.client = new SchedulerClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  /**
   * Extract the GroupName a schedule lives in from its CFn properties.
   * Absent GroupName means the default group — the SDK accepts an omitted
   * GroupName with the same semantics, so `undefined` passes through.
   */
  private groupNameOf(properties: Record<string, unknown> | undefined): string | undefined {
    const group = properties?.['GroupName'];
    return typeof group === 'string' && group.length > 0 ? group : undefined;
  }

  /**
   * Map the CFn property shape to the Scheduler SDK input shape. The two
   * are PascalCase-identical except `StartDate` / `EndDate` (CFn carries
   * ISO strings, the SDK types `Date`) and the Target's ECS sub-shapes
   * (camelCase islands in the SDK model — see {@link toSdkTarget},
   * issue #1382).
   */
  private toSdkFields(
    properties: Record<string, unknown>
  ): Omit<CreateScheduleCommandInput, 'Name' | 'GroupName' | 'ClientToken'> {
    return {
      ScheduleExpression: properties['ScheduleExpression'] as string,
      FlexibleTimeWindow: properties['FlexibleTimeWindow'] as FlexibleTimeWindow,
      Target: this.toSdkTarget(properties['Target'] as Record<string, unknown>),
      ...(properties['Description'] !== undefined && {
        Description: properties['Description'] as string,
      }),
      ...(properties['ScheduleExpressionTimezone'] !== undefined && {
        ScheduleExpressionTimezone: properties['ScheduleExpressionTimezone'] as string,
      }),
      ...(properties['StartDate'] !== undefined && {
        StartDate: new Date(properties['StartDate'] as string),
      }),
      ...(properties['EndDate'] !== undefined && {
        EndDate: new Date(properties['EndDate'] as string),
      }),
      ...(properties['State'] !== undefined && {
        State: properties['State'] as CreateScheduleCommandInput['State'],
      }),
      ...(properties['KmsKeyArn'] !== undefined && {
        KmsKeyArn: properties['KmsKeyArn'] as string,
      }),
    };
  }

  /**
   * Convert the CFn-shaped `Target` blob's ECS sub-shapes to the SDK shape
   * (issue #1382). `@aws-sdk/client-scheduler` is PascalCase except a few
   * camelCase islands the CFn schema spells PascalCase; the SDK serializer
   * silently drops unknown keys, so a Fargate target's
   * `NetworkConfiguration.AwsvpcConfiguration` never reached AWS and
   * CreateSchedule rejected with "Parameter NetworkConfiguration must be
   * specified".
   */
  private toSdkTarget(target: Record<string, unknown>): Target {
    const ecs = target['EcsParameters'] as Record<string, unknown> | undefined;
    if (!ecs) return target as unknown as Target;
    const result: Record<string, unknown> = { ...ecs };
    const network = result['NetworkConfiguration'] as Record<string, unknown> | undefined;
    if (network && network['AwsvpcConfiguration'] !== undefined) {
      const { AwsvpcConfiguration, ...restNetwork } = network;
      result['NetworkConfiguration'] = {
        ...restNetwork,
        awsvpcConfiguration: AwsvpcConfiguration,
      };
    }
    if (Array.isArray(result['PlacementStrategy'])) {
      result['PlacementStrategy'] = (result['PlacementStrategy'] as Record<string, unknown>[]).map(
        (item) => this.renameItemKeys(item, ['Type', 'Field'], 'lower')
      );
    }
    if (Array.isArray(result['PlacementConstraints'])) {
      result['PlacementConstraints'] = (
        result['PlacementConstraints'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['Type', 'Expression'], 'lower'));
    }
    if (Array.isArray(result['CapacityProviderStrategy'])) {
      result['CapacityProviderStrategy'] = (
        result['CapacityProviderStrategy'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['CapacityProvider', 'Weight', 'Base'], 'lower'));
    }
    return { ...target, EcsParameters: result } as unknown as Target;
  }

  /**
   * Inverse of {@link toSdkTarget} for `readCurrentState`: GetSchedule
   * returns the SDK spellings, but drift compares against the state's CFn
   * spellings — without the re-map every ECS Fargate schedule would report
   * phantom drift on `AwsvpcConfiguration` after deploy.
   */
  private toCfnTarget(target: Target): Record<string, unknown> {
    const raw = target as unknown as Record<string, unknown>;
    const ecs = raw['EcsParameters'] as Record<string, unknown> | undefined;
    if (!ecs) return raw;
    const result: Record<string, unknown> = { ...ecs };
    const network = result['NetworkConfiguration'] as Record<string, unknown> | undefined;
    if (network && network['awsvpcConfiguration'] !== undefined) {
      const { awsvpcConfiguration, ...restNetwork } = network;
      result['NetworkConfiguration'] = {
        ...restNetwork,
        AwsvpcConfiguration: awsvpcConfiguration,
      };
    }
    if (Array.isArray(result['PlacementStrategy'])) {
      result['PlacementStrategy'] = (result['PlacementStrategy'] as Record<string, unknown>[]).map(
        (item) => this.renameItemKeys(item, ['type', 'field'], 'upper')
      );
    }
    if (Array.isArray(result['PlacementConstraints'])) {
      result['PlacementConstraints'] = (
        result['PlacementConstraints'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['type', 'expression'], 'upper'));
    }
    if (Array.isArray(result['CapacityProviderStrategy'])) {
      result['CapacityProviderStrategy'] = (
        result['CapacityProviderStrategy'] as Record<string, unknown>[]
      ).map((item) => this.renameItemKeys(item, ['capacityProvider', 'weight', 'base'], 'upper'));
    }
    return { ...raw, EcsParameters: result };
  }

  /**
   * Flip the first letter's case on the listed keys of one array item
   * (`Type` <-> `type`, `CapacityProvider` <-> `capacityProvider`); keys
   * not listed (or absent) pass through unchanged.
   */
  private renameItemKeys(
    item: Record<string, unknown>,
    keys: string[],
    direction: 'lower' | 'upper'
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...item };
    for (const key of keys) {
      if (result[key] !== undefined) {
        const flipped =
          direction === 'lower'
            ? key.charAt(0).toLowerCase() + key.slice(1)
            : key.charAt(0).toUpperCase() + key.slice(1);
        result[flipped] = result[key];
        delete result[key];
      }
    }
    return result;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    // Schedule names: <= 64 chars, ^[0-9a-zA-Z-_.]+$ — generateResourceName's
    // stack-prefixed output satisfies both.
    const name =
      (properties['Name'] as string | undefined) ??
      generateResourceName(logicalId, { maxLength: 64 });
    const groupName = this.groupNameOf(properties);

    this.logger.debug(
      `Creating Schedule ${logicalId}: ${name}${groupName ? ` (group: ${groupName})` : ''}`
    );

    try {
      const response = await this.getClient().send(
        new CreateScheduleCommand({
          Name: name,
          ...(groupName && { GroupName: groupName }),
          ...this.toSdkFields(properties),
        })
      );

      const creationDate = await this.creationDateBestEffort(logicalId, name, groupName);
      return {
        physicalId: name,
        // CFn's only GetAtt for the type. CreateSchedule always returns it in
        // practice; if it ever does not, omit the key rather than storing ''
        // (an empty string would satisfy the resolver's flat-attribute lookup
        // and shadow constructAttribute's fallback).
        attributes: {
          ...(response.ScheduleArn && { Arn: response.ScheduleArn }),
          ...(creationDate !== undefined && { [RECORDED_CREATION_DATE_KEY]: creationDate }),
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Schedule ${logicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /** A live schedule's {@link ScheduleIdentity}. Throws what `GetSchedule` throws. */
  private async readIdentity(
    name: string,
    groupName: string | undefined
  ): Promise<ScheduleIdentity> {
    const response = await this.getClient().send(
      new GetScheduleCommand({ Name: name, ...(groupName && { GroupName: groupName }) })
    );
    const date = response.CreationDate;
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value !== '' ? value : undefined;
    return {
      creation:
        date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined,
      targetArn: text(response.Target?.Arn),
      roleArn: text(response.Target?.RoleArn),
    };
  }

  /** The one wait this provider makes (a read-back retry, a re-list). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Waits before each re-read of {@link creationDateBestEffort}; tests shorten them. */
  readBackDelaysMs: readonly number[] = [500, 1_000];

  /**
   * The creation date read back after a write that already succeeded. A
   * NotFound (read-after-write lag) or a throttle is retried briefly: a date
   * left unrecorded strands a secret-group schedule, whose update and delete
   * then have no identity to go on. Any failure that remains records nothing
   * rather than failing the write. The AWS text is not logged: it can quote the
   * group, which may be secret-derived.
   */
  private async creationDateBestEffort(
    logicalId: string,
    name: string,
    groupName: string | undefined
  ): Promise<string | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.readIdentity(name, groupName)).creation;
      } catch (error) {
        const transient = error instanceof ResourceNotFoundException || isThrottlingError(error);
        const delay = this.readBackDelaysMs[attempt];
        if (transient && delay !== undefined) {
          await this.sleep(delay);
          continue;
        }
        const failureClass =
          error instanceof Error && error.name !== '' ? error.name : 'an unreadable failure';
        this.logger.debug(
          safeMsg`Could not read the creation date of Schedule ${logicalId} (${failureClass}); none is recorded`
        );
        return undefined;
      }
    }
  }

  /**
   * The refusal for a confirmation lookup that failed for a reason other than
   * NotFound: it names the failure's class only, and keeps the AWS text on the
   * stamped cause, so the retry classifiers still read a throttle.
   */
  private wrapUnconfirmedGroupError(
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
  private refuseUnconfirmed(
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
  private async confirmRecordedSchedule(
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
  private referenceRepointed(desiredGroup: string | undefined, recordedGroup: unknown): boolean {
    const bag = getCurrentResourceSecrets();
    if (bag === undefined || typeof desiredGroup !== 'string') return false;
    if (typeof recordedGroup !== 'string' || !recordedGroup.includes('{{resolve:')) return false;
    return redactSecretsForState(desiredGroup, bag) !== recordedGroup;
  }

  async update(
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
      throw new ProvisioningError(
        `Failed to update Schedule ${logicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

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
  private async deleteByRecordedIdentity(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    recorded: ScheduleIdentity,
    context: DeleteContext | undefined
  ): Promise<void | ResourceDeleteResult> {
    if (!context?.expectedRegion) {
      this.logger.warn(
        safeMsg`Schedule ${logicalId} is recorded with a secret-derived GroupName and no stack region, so cdkd cannot scope the search for it; skipping deletion and keeping its state record. Delete the schedule by hand, then drop the record with 'cdkd orphan'.`
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
      return markRedactedCause(
        new ProvisioningError(
          `Failed to delete Schedule ${logicalId}: its recorded GroupName is secret-derived, ` +
            `and ${step} failed (${failureClass})`,
          resourceType,
          logicalId,
          physicalId,
          error instanceof Error ? error : undefined
        )
      );
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
        safeMsg`Schedule ${logicalId}: a schedule of its name carries the recorded creation date but not the recorded target or role (edited outside cdkd?), so cdkd cannot tell whether it is this one; skipping deletion and keeping its state record. Delete it by hand if it is, then drop the record with 'cdkd orphan'.`
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
      this.logger.debug(
        safeMsg`Deleted Schedule ${logicalId} (found by its recorded creation date)`
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return;
      throw wrapDeleteError('the delete', error);
    }
  }

  async delete(
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
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Schedule ${logicalId} already deleted (not found), treating as success`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Schedule ${logicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Attribute fallback. `Arn` is cached in state at create/update time, so
   * this only fires for imported/degraded records. A bare schedule name
   * cannot be resolved to its group here (no properties in this signature),
   * so the lookup tries the default group and fails with an actionable
   * message for custom-group schedules.
   */
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string,
    logicalId: string
  ): Promise<unknown> {
    if (attributeName !== 'Arn') {
      throw new ProvisioningError(
        `Unknown attribute ${attributeName} for ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    try {
      const response = await this.getClient().send(new GetScheduleCommand({ Name: physicalId }));
      return response.Arn;
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      const customGroupHint =
        error instanceof ResourceNotFoundException
          ? ' Schedules in a custom group cannot be looked up by bare name; the Arn is normally served from cdkd state attributes.'
          : '';
      throw new ProvisioningError(
        `Failed to resolve Arn for Schedule ${physicalId}: ${cause?.message ?? String(error)}.${customGroupHint}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Drift read-back. `properties` carries the state-recorded GroupName, so
   * custom-group schedules are addressable here (unlike getAttribute).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const groupName = this.groupNameOf(properties);
    try {
      const response = await this.getClient().send(
        new GetScheduleCommand({
          Name: physicalId,
          ...(groupName && { GroupName: groupName }),
        })
      );
      // GroupName normalization: AWS reports 'default' for schedules in the
      // default group, but a template that OMITS GroupName must not drift
      // against it. When the state properties explicitly carry GroupName
      // (even 'default'), keep the read-back value so an explicit template
      // value keeps comparing.
      const stateHasGroupName = properties?.['GroupName'] !== undefined;
      return {
        Name: response.Name,
        ...(response.GroupName !== undefined &&
          (stateHasGroupName || response.GroupName !== 'default') && {
            GroupName: response.GroupName,
          }),
        ...(response.Description !== undefined && { Description: response.Description }),
        ...(response.ScheduleExpression !== undefined && {
          ScheduleExpression: response.ScheduleExpression,
        }),
        ...(response.ScheduleExpressionTimezone !== undefined && {
          ScheduleExpressionTimezone: response.ScheduleExpressionTimezone,
        }),
        ...(response.StartDate !== undefined && {
          StartDate: response.StartDate.toISOString(),
        }),
        ...(response.EndDate !== undefined && { EndDate: response.EndDate.toISOString() }),
        ...(response.State !== undefined && { State: response.State }),
        ...(response.KmsKeyArn !== undefined && { KmsKeyArn: response.KmsKeyArn }),
        ...(response.FlexibleTimeWindow !== undefined && {
          FlexibleTimeWindow: response.FlexibleTimeWindow,
        }),
        ...(response.Target !== undefined && { Target: this.toCfnTarget(response.Target) }),
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        return RESOURCE_NOT_FOUND;
      }
      throw error;
    }
  }

  /**
   * Import by explicit physical id (`--resource <logicalId>=<name>` or the
   * template's `Name` property). The schedule's group is read from the
   * template properties, so custom-group schedules import correctly.
   *
   * No tag-based auto-lookup: EventBridge Scheduler schedules do not
   * support resource tags, so there is no `aws:cdk:path` to match.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (!explicit) return null;

    const groupName = this.groupNameOf(input.properties);
    try {
      const response = await this.getClient().send(
        new GetScheduleCommand({
          Name: explicit,
          ...(groupName && { GroupName: groupName }),
        })
      );
      return {
        physicalId: explicit,
        // Omit Arn rather than persisting `''` when the read-back lacks it:
        // the intrinsic resolver treats any non-undefined flat attribute as
        // a hit, so an empty string would beat constructAttribute's fallback
        // and Fn::GetAtt would resolve to ''.
        // The creation date too, as create() records it (go-to-k/cdkd#4275): a
        // re-import replaces the recorded attributes.
        attributes: {
          ...(response.Arn && { Arn: response.Arn }),
          ...(response.CreationDate instanceof Date &&
            !Number.isNaN(response.CreationDate.getTime()) && {
              [RECORDED_CREATION_DATE_KEY]: response.CreationDate.toISOString(),
            }),
        },
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }
}
