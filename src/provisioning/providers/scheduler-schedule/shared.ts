import type { SchedulerScheduleProvider } from '../scheduler-schedule-provider.js';
import {
  GetScheduleCommand,
  ResourceNotFoundException,
  type CreateScheduleCommandInput,
  type Target,
  type FlexibleTimeWindow,
} from '@aws-sdk/client-scheduler';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  isSecretDerivedValue,
  maskerOrIdentity,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import { SECRET_MASK } from '../../../deployment/secret-redaction.js';
import {
  isThrottlingError,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { plainOrDescribed } from '../../../utils/pasteable-command.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { parseCfnTimestamp } from '../../../utils/cfn-timestamp.js';

/**
 * The attribute key under which cdkd records a schedule's AWS creation date
 * (`GetSchedule`'s `CreationDate`, ISO 8601): the only non-secret identity a
 * schedule has, since its ARN embeds the group, which may be secret-derived
 * (and is then recorded redacted). Not a CloudFormation attribute: no
 * template can `Fn::GetAtt` it, and no CloudFormation name contains `:`.
 */
export const RECORDED_CREATION_DATE_KEY = 'cdkd:CreationDate';

/** The recorded creation date, or `undefined` when the record holds none. */
export function recordedCreationDate(
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
export const RECORDED_ONLY = maskerOrIdentity(undefined);

/**
 * A schedule's identity as cdkd compares it: its AWS creation date (in the form
 * cdkd records, `toISOString()`) and its target's ARN and role ARN. The date
 * alone can coincide for two same-named schedules created in one instant
 * (parallel environment deploys), and a target ARN alone is shared by every
 * schedule calling one universal target, queue or function.
 */
export interface ScheduleIdentity {
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
export function recordedTarget(
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
export function sameRecordedDate(live: ScheduleIdentity, recorded: ScheduleIdentity): boolean {
  return live.creation !== undefined && live.creation === recorded.creation;
}

/** Does a live schedule's identity match the recorded one, field by field? */
export function sameRecordedIdentity(live: ScheduleIdentity, recorded: ScheduleIdentity): boolean {
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
export function groupShown(group: string): string {
  return group === SECRET_MASK ? group : plainOrDescribed(group, 'group name');
}

/**
 * The failure wrap the create / update / delete / getAttribute catches throw.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug` through the
 * operation's `maskSecrets` (`mask`), and the wrap is stamped
 * `markRedactedCause`, so the retry classifiers read the withheld text on the
 * `cause` chain. An "already exists" is restated ({@link relayedNameCollision}).
 * A cdkd-authored or transport error keeps its text, masked, stamped only
 * when the mask changed it (`wrapMaskedAwsError`, issue #4244); a non-`Error`
 * throw is withheld like an AWS one, unstamped (it has no chain). The delete
 * checks `ResourceNotFoundException` by type before it wraps.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: SchedulerScheduleProvider,
  mask: MaskerFn | undefined,
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
 * Map the CFn property shape to the Scheduler SDK input shape. The two
 * are PascalCase-identical except `StartDate` / `EndDate` (CFn carries
 * ISO strings, read as UTC when offset-less as CFn does, issue #5311; the
 * SDK types `Date`) and the Target's ECS sub-shapes (camelCase islands in
 * the SDK model — see {@link toSdkTarget}, issue #1382).
 */
export function toSdkFields(
  this: SchedulerScheduleProvider,
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
      StartDate: parseCfnTimestamp(properties['StartDate'] as string),
    }),
    ...(properties['EndDate'] !== undefined && {
      EndDate: parseCfnTimestamp(properties['EndDate'] as string),
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
export function toSdkTarget(
  this: SchedulerScheduleProvider,
  target: Record<string, unknown>
): Target {
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
export function toCfnTarget(
  this: SchedulerScheduleProvider,
  target: Target
): Record<string, unknown> {
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
export function renameItemKeys(
  this: SchedulerScheduleProvider,
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

/** A live schedule's {@link ScheduleIdentity}. Throws what `GetSchedule` throws. */
export async function readIdentity(
  this: SchedulerScheduleProvider,
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

/**
 * The creation date read back after a write that already succeeded. A
 * NotFound (read-after-write lag) or a throttle is retried briefly: a date
 * left unrecorded strands a secret-group schedule, whose update and delete
 * then have no identity to go on. Any failure that remains records nothing
 * rather than failing the write. The AWS text is not logged: it can quote the
 * group, which may be secret-derived.
 */
export async function creationDateBestEffort(
  this: SchedulerScheduleProvider,
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
