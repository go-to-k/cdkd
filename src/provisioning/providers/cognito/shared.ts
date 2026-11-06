import type {
  UserPoolType,
  UpdateUserPoolCommandInput,
  DeletionProtectionType,
} from '@aws-sdk/client-cognito-identity-provider';
import { AmbiguousCreateLatch, RecentIdSet } from '../ambiguous-create.js';
import { isThrottlingError, isTransientServerError } from '../../../deployment/retryable-errors.js';
import { isAwsAuthoredFailure, safeStringify } from '../../../utils/aws-failure-text.js';
import { isDeepStrictEqual } from 'node:util';
import { readEnabledMfas } from './mfa-request.js';

/**
 * The `UpdateUserPool` members a `DeletionProtection`-only write ECHOES BACK
 * from the pool's own `DescribeUserPool`, so the `--remove-protection` flip
 * and its compensating re-enable change the guard and nothing else (issue
 * #4066).
 *
 * `UpdateUserPool` resets members a call omits -- but only SOME of them, and
 * every echoed member is one more thing AWS can refuse on write. So the echo
 * carries exactly the members MEASURED to reset, the ones not measured, and
 * `UserAttributeUpdateSettings` (AWS refuses a write whose
 * `AttributesRequireVerificationBeforeUpdate` names an attribute missing from
 * `AutoVerifiedAttributes`, so the two travel together). The measured-KEPT
 * members are {@link USER_POOL_KEPT_ON_OMISSION}.
 *
 * MEASURED us-east-1 2026-09-29 (issue #4066), on pools created with each
 * member set, by an `UpdateUserPool` omitting it:
 *
 * - RESET: `LambdaConfig` (a `PreAuthentication` trigger went to `{}`),
 *   `UserPoolAddOns` (advanced security `AUDIT` went to absent),
 *   `AdminCreateUserConfig.AllowAdminCreateUserOnly` (`true` -> `false`: self
 *   sign-up switched ON), `AutoVerifiedAttributes`,
 *   `VerificationMessageTemplate` (`CONFIRM_WITH_LINK` -> `CONFIRM_WITH_CODE`),
 *   `SmsAuthenticationMessage`, `DeviceConfiguration`.
 * - REFUSED outright on a pool whose `UserAttributeUpdateSettings` requires
 *   verification of `email`: "All attributes in
 *   AttributesRequireVerificationBeforeUpdate must exist in
 *   AutoVerifiedAttributes" -- the bare flip could not turn the guard off.
 * - RESET too, MEASURED us-east-1 2026-10-15 (issue #4149): a `DEVELOPER`
 *   (SES) `EmailConfiguration` went to `{ EmailSendingAccount:
 *   COGNITO_DEFAULT }`, its `SourceArn` and `ReplyToEmailAddress` dropped.
 *   Echoed back unchanged it was ACCEPTED and kept. It is echoed apart from
 *   this list, because a `COGNITO_DEFAULT` one is KEPT (see
 *   {@link USER_POOL_KEPT_ON_OMISSION}).
 * - Not measured, so echoed: `SmsVerificationMessage`,
 *   `EmailVerificationMessage`, `EmailVerificationSubject`, and
 *   `AcrConfiguration` (added by a later SDK; the API reference says a level
 *   the write does not name gets its DEFAULT name, so omission could reset a
 *   custom one). Only its custom levels are echoed: see `customAcrLevels`.
 * - RESET too, MEASURED us-east-1 2026-11-01 (issue #2762): a
 *   `CUSTOMER_MANAGED_KEY` `KeyConfiguration` went to `AWS_OWNED_KEY`, its
 *   `KmsKeyArn` dropped. Echoed apart from this list, like the SES
 *   `EmailConfiguration`, because an `AWS_OWNED_KEY` one is what omission
 *   leaves anyway (see {@link USER_POOL_KEPT_ON_OMISSION}).
 *
 * The echo was ACCEPTED on every pool measured, MFA `ON` with TOTP only and
 * no `SmsConfiguration` included, and left the pool byte-identical apart from
 * `DeletionProtection`. A `LambdaConfig` naming a function that does not exist
 * is accepted too, so a deleted trigger function cannot make the echo refuse.
 */
export const USER_POOL_ECHO_MEMBERS = [
  'LambdaConfig',
  'UserPoolAddOns',
  'AdminCreateUserConfig',
  'AutoVerifiedAttributes',
  'UserAttributeUpdateSettings',
  'VerificationMessageTemplate',
  'SmsAuthenticationMessage',
  'DeviceConfiguration',
  'SmsVerificationMessage',
  'EmailVerificationMessage',
  'EmailVerificationSubject',
  'AcrConfiguration',
] as const satisfies ReadonlyArray<keyof UserPoolType & keyof UpdateUserPoolCommandInput>;

/**
 * The `UpdateUserPool` members MEASURED to survive a call that omits them
 * (issue #4066, us-east-1 2026-09-29), and therefore NOT echoed: echoing them
 * buys nothing and adds refusal triggers -- `SmsConfiguration` re-validates
 * its IAM role and a `DEVELOPER` `EmailConfiguration` its SES identity on
 * write, and a refused echo is the path to the settings-resetting bare write.
 * `SmsConfiguration` (with an SNS role), `EmailConfiguration`
 * (`COGNITO_DEFAULT`) and `MfaConfiguration` (`OFF`, `OPTIONAL` and `ON`, the
 * factor configuration included) were each measured unchanged, and
 * `IssuerConfiguration` (`UPDATED`, us-east-1 2026-11-01, issue #2762). Two
 * exceptions are ECHOED, each measured to RESET on omission (see
 * {@link userPoolDeletionProtectionUpdate}): a `DEVELOPER` (SES)
 * `EmailConfiguration` goes to `COGNITO_DEFAULT` (issue #4149), and a
 * `CUSTOMER_MANAGED_KEY` `KeyConfiguration` goes to `AWS_OWNED_KEY` (issue
 * #2762).
 */
export const USER_POOL_KEPT_ON_OMISSION = [
  'Policies',
  'UserPoolTags',
  'AccountRecoverySetting',
  'EmailConfiguration',
  'SmsConfiguration',
  'MfaConfiguration',
  'UserPoolTier',
  'KeyConfiguration',
  'IssuerConfiguration',
] as const satisfies ReadonlyArray<keyof UserPoolType & keyof UpdateUserPoolCommandInput>;

/**
 * An `UpdateUserPool` that sets `DeletionProtection` to `value` and echoes
 * back every {@link USER_POOL_ECHO_MEMBERS} entry `pool` carries, so the write
 * leaves the rest of the pool as it was read. `UserPoolId` is the caller's
 * physical id, never `pool.Id`: the write addresses what cdkd means to act on.
 */
export function userPoolDeletionProtectionUpdate(
  physicalId: string,
  pool: UserPoolType,
  value: DeletionProtectionType,
  opts: { readonly withoutDeveloperEmail?: boolean } = {}
): UpdateUserPoolCommandInput {
  const input: UpdateUserPoolCommandInput = { UserPoolId: physicalId };
  for (const member of USER_POOL_ECHO_MEMBERS) {
    if (pool[member] !== undefined) Object.assign(input, { [member]: pool[member] });
  }
  const acr = customAcrLevels(pool.AcrConfiguration);
  if (acr === undefined) delete input.AcrConfiguration;
  else input.AcrConfiguration = acr;
  // A `DEVELOPER` EmailConfiguration (SES) RESETS to `COGNITO_DEFAULT` when
  // omitted (measured, #4149), so it is echoed. If AWS re-validates it and
  // refuses, `sendEchoedDeletionProtection` re-sends without it and says at
  // warn that the email configuration was reset.
  if (echoesDeveloperEmail(pool) && opts.withoutDeveloperEmail !== true) {
    input.EmailConfiguration = pool.EmailConfiguration;
  }
  // A customer-managed key RESETS to the AWS owned key when omitted (measured,
  // #2762). The AWS owned key is what omission leaves, so it stays off the wire.
  if (echoesCustomerManagedKey(pool)) input.KeyConfiguration = pool.KeyConfiguration;
  input.DeletionProtection = value;
  return input;
}

/**
 * The levels of a read-back `AcrConfiguration` whose name is CUSTOM, or
 * `undefined` when there are none. DescribeUserPool returns all four levels
 * with the defaults (`urn:cognito:loa:<n>` for `Level<n>`) merged in, even on
 * a Lite pool, where AWS gates custom names behind Essentials. A write that
 * omits a level applies its default, so dropping the default levels changes
 * nothing -- and keeps the tier-gated member out of every write that has no
 * custom name to preserve.
 */
function customAcrLevels(acr: UserPoolType['AcrConfiguration']): UserPoolType['AcrConfiguration'] {
  if (acr === undefined) return undefined;
  const custom = Object.fromEntries(
    Object.entries(acr).filter(([level, cfg]) => {
      const n = /^Level([1-4])$/.exec(level)?.[1];
      return n === undefined || cfg?.AcrValue !== `urn:cognito:loa:${n}`;
    })
  );
  return Object.keys(custom).length > 0 ? custom : undefined;
}

/**
 * What a write omitting a `DEVELOPER` `EmailConfiguration` did to it (measured,
 * #4149), and how to put it back without the restore resetting the rest. For
 * a LIVE pool: the re-enable, and the report after a failed delete.
 */
export const EMAIL_RESET_CLAUSE =
  "reset to Cognito's default sender (EmailSendingAccount COGNITO_DEFAULT), dropping its SES " +
  'SourceArn, and a redeploy will not restore it. Put the SES settings back with an ' +
  "UpdateUserPool that also carries the pool's other settings, since that call resets " +
  'what it omits.';

/**
 * {@link EMAIL_RESET_CLAUSE} for the flip-off, said BEFORE the delete: once
 * the pool is deleted there is nothing to restore, so it only says what stays.
 */
export const EMAIL_RESET_BEFORE_DELETE_CLAUSE =
  "reset to Cognito's default sender (EmailSendingAccount COGNITO_DEFAULT), dropping its SES " +
  'SourceArn, which stays that way if the delete fails.';

/** Failures of a write sent WITHOUT the pool's SES EmailConfiguration. */
export const sentWithoutEmail = new WeakSet<object>();

/**
 * Retry-safety state for `CreateUserPool`, which has no idempotency token and
 * whose pool name AWS does not require to be unique (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)); see
 * `CognitoUserPoolProvider.reportPossibleOrphanPools`. Module-scoped: a
 * provider instance is per registry, and one process can build several.
 */
export const createUserPoolLatch = new AmbiguousCreateLatch('CreateUserPool');

/** Pools this process created and recorded, never offered back by a lookup. */
export const userPoolsCreatedByThisProcess = new RecentIdSet();

/** Page ceiling for the `ListUserPools` lookup (60 pools a page). */
export const MAX_USER_POOL_LIST_PAGES = 50;

/** Most pool ids one orphan report names. */
export const MAX_REPORTED_ORPHAN_POOLS = 5;

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetUserPoolCreateRetryStateForTests(): void {
  createUserPoolLatch.resetForTests();
  userPoolsCreatedByThisProcess.resetForTests();
}

/** The report a `preFlipPools` record calls for (see `reportSettingsResetByBareFlip`). */
export function reportKind(record: {
  readonly ambiguous: boolean;
  readonly echoedSince?: boolean;
}): 'reset' | 'earlier' | 'unclear' {
  if (record.ambiguous) return 'unclear';
  return record.echoedSince === true ? 'earlier' : 'reset';
}

/** Whether {@link userPoolDeletionProtectionUpdate} echoes the pool's (SES) `EmailConfiguration`. */
export function echoesDeveloperEmail(pool: UserPoolType): boolean {
  return pool.EmailConfiguration?.EmailSendingAccount === 'DEVELOPER';
}

/** Whether {@link userPoolDeletionProtectionUpdate} echoes the pool's `KeyConfiguration`. */
export function echoesCustomerManagedKey(pool: UserPoolType): boolean {
  return pool.KeyConfiguration?.KeyType === 'CUSTOMER_MANAGED_KEY';
}

/** What a `DeletionProtection`-only write resets on `pool`, for the warn and the ERROR report. */
export function bareFlipResets(pool: UserPoolType): string {
  const reset = ['self sign-up', 'Lambda triggers', 'advanced security'];
  if (echoesDeveloperEmail(pool)) reset.push('SES email configuration');
  if (echoesCustomerManagedKey(pool)) reset.push('customer-managed key');
  return `${reset.slice(0, -1).join(', ')} and ${reset[reset.length - 1]}`;
}

/**
 * The `UpdateUserPool` failures that mean AWS VALIDATED the echoed
 * configuration and refused it -- the only case where the bare write is worth
 * falling back to (issue #4066). Anything else (a throttle, a timeout that may
 * even have applied, access denied, not-found) is not a stale member, and a
 * bare write there would reset self sign-up and the Lambda triggers for
 * nothing. Keyed on `name` so a second SDK class instance still matches.
 */
export const REFUSED_ECHO_ERRORS: ReadonlySet<string> = new Set([
  'InvalidParameterException',
  'InvalidSmsRoleAccessPolicyException',
  'InvalidSmsRoleTrustRelationshipException',
  'InvalidEmailRoleAccessPolicyException',
]);

/**
 * A throttle or a transient server error (5xx) from `DescribeUserPool` or the
 * flip's `UpdateUserPool`: the delete is abandoned BEFORE any
 * `DeleteUserPool` and re-thrown retryable, so the destroy loop re-enters and
 * the next attempt reads and flips properly (issue #4066). Deliberately NOT
 * `isRetryableTransientError`, whose message patterns include `not authorized
 * to perform` (for IAM propagation): a real permission refusal must reach the
 * warn that names the missing permission, not burn the retry budget.
 */
export function isTransientCognitoFailure(error: unknown): boolean {
  return isThrottlingError(error) || isTransientServerError(error);
}

/**
 * A write failure that does NOT prove the write was refused: a client-side
 * one (a timeout, a dropped connection -- no AWS answer at all) or a 5xx,
 * either of which may have been applied server-side.
 */
export function isAmbiguousWriteFailure(error: unknown): boolean {
  return !(error instanceof Error && isAwsAuthoredFailure(error)) || isTransientServerError(error);
}

export function isRefusedEcho(error: unknown): boolean {
  // `safeStringify`: a thrown value's `name` is as arbitrary as the value, and
  // this gates a catch's bare-write fallback (go-to-k/cdkd#3361).
  return (
    typeof error === 'object' &&
    error !== null &&
    REFUSED_ECHO_ERRORS.has(safeStringify((error as { name?: unknown }).name))
  );
}

/**
 * The standard (OIDC) Cognito User Pool attribute names. A Schema entry whose
 * Name is NOT in this set is a custom attribute (AWS stores it as
 * `custom:<name>`). Used by the update path to tell which added Schema entries
 * can be added in place via AddCustomAttributes (custom only) versus which
 * require replacement (standard attributes are immutable on update).
 *
 * This list is a snapshot of AWS's standard claim set and may lag AWS. If AWS
 * ever adds a new standard attribute, a user adding it would be misclassified
 * as custom and routed to AddCustomAttributes — which AWS rejects with a clear
 * error (surfaced as a ProvisioningError, never a silent drop), so the failure
 * is loud and the fix is to append the new name here.
 */
export const STANDARD_USER_POOL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'address',
  'birthdate',
  'email',
  'email_verified',
  'family_name',
  'gender',
  'given_name',
  'locale',
  'middle_name',
  'name',
  'nickname',
  'phone_number',
  'phone_number_verified',
  'picture',
  'preferred_username',
  'profile',
  'sub',
  'updated_at',
  'website',
  'zoneinfo',
]);

/**
 * Which of `UsernameAttributes`, `AliasAttributes` and `UsernameConfiguration`
 * the desired bag changes against the previous one (issue #5358).
 * `UpdateUserPool` has no member for any of them, so a change to one can never
 * be applied in place.
 *
 * The CloudFormation registry schema lists NO create-only paths for
 * `AWS::Cognito::UserPool`, so a change to one of these is not routed to
 * replacement; it reaches the update path. CloudFormation's own handler then
 * REFUSES it — measured 2026-10-26 on throwaway stacks, each a change set
 * `Modify` / `Replacement: False` ending in `UPDATE_FAILED` with
 * "Invalid request provided: Updates are not allowed for property - <name>."
 * for a changed `UsernameAttributes` (`[email]` -> `[phone_number]`), a
 * changed `UsernameConfiguration.CaseSensitive`, a changed `AliasAttributes`,
 * and the REMOVAL of `UsernameAttributes` or of `UsernameConfiguration`. cdkd
 * refuses the same changes rather than leaving them out of the request, which
 * deployed them "successfully" while AWS kept the create-time value.
 */
export function createTimeOnlyChanges(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): string[] {
  // Literal keys, one per property, in the order the refusal names them.
  const pairs: Array<[string, unknown, unknown, 'list' | 'object']> = [
    [
      'UsernameAttributes',
      properties['UsernameAttributes'],
      previousProperties['UsernameAttributes'],
      'list',
    ],
    [
      'AliasAttributes',
      properties['AliasAttributes'],
      previousProperties['AliasAttributes'],
      'list',
    ],
    [
      'UsernameConfiguration',
      properties['UsernameConfiguration'],
      previousProperties['UsernameConfiguration'],
      'object',
    ],
  ];
  return pairs
    .filter(
      ([, desired, previous, shape]) =>
        canonicalCreateTimeOnlyValue(shape, desired) !==
        canonicalCreateTimeOnlyValue(shape, previous)
    )
    .map(([name]) => name);
}

/**
 * `bag` with each of `kept` put back to its PREVIOUS value — absent when the
 * previous side has none — for the state-borne update arm that warns rather
 * than refuses (issue #5358): nothing was sent for those properties, so the
 * record must say what the pool still holds. Returns `bag` itself when
 * nothing is kept, so `update()`'s identity check still omits
 * `effectiveProperties` on an ordinary update.
 */
export function withPreviousCreateTimeOnly(
  bag: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  kept: readonly string[]
): Record<string, unknown> {
  if (kept.length === 0) return bag;
  const out: Record<string, unknown> = { ...bag };
  for (const key of kept) {
    if (previousProperties[key] === undefined) delete out[key];
    else out[key] = previousProperties[key];
  }
  return out;
}

/**
 * Comparable form of one {@link createTimeOnlyChanges} value.
 * Absent equals empty (`readCurrentState` emits `[]` / `{}` placeholders for
 * an unset value, and a removal of an empty value changes nothing at AWS), the
 * two attribute lists compare as sets, and `CaseSensitive` compares by its
 * string spelling so a template boolean and its `"true"` / `"false"` string
 * form are the same value.
 */
function canonicalCreateTimeOnlyValue(shape: 'list' | 'object', declared: unknown): string {
  const value = declared ?? (shape === 'object' ? {} : []);
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((v) => JSON.stringify(v)).sort());
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]): [string, unknown] => [k, typeof v === 'boolean' ? String(v) : v])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(entries);
  }
  return JSON.stringify(value);
}

/**
 * Class 2 sanitize: empty `{}` placeholders that `readCurrentState` emits
 * for sub-objects whose AWS schema requires a sub-field would be rejected
 * by `UpdateUserPool` if shipped as-is. The known-rejected shapes:
 *
 * - `SmsConfiguration: {}`         — `SnsCallerArn` is required
 * - `UserPoolAddOns: {}`           — `AdvancedSecurityMode` is required
 *
 * (`UsernameConfiguration` is not on this list because `UpdateUserPool` has
 * no such member at all: a change to it is refused before any call — see
 * {@link createTimeOnlyChanges}.)
 *
 * The other sub-objects emitted as `{}` placeholders (LambdaConfig,
 * AdminCreateUserConfig, AccountRecoverySetting, UserAttributeUpdateSettings,
 * EmailConfiguration, VerificationMessageTemplate, DeviceConfiguration)
 * have all-optional sub-fields per the SDK types and AWS accepts the empty
 * object as "no overrides / clear all".
 *
 * Returns `true` when the value is a non-null object with zero keys.
 */
export function isEmptyObjectPlaceholder(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

/**
 * The members whose REMOVAL both `UpdateUserPool` and CloudFormation leave as
 * a no-op (issue #1160; the measurement is at `warnOnKeptRemovedMembers`),
 * each mapped to the value AWS reports for it when unset (`undefined` when
 * that is an empty object, which {@link declaresMember} already skips).
 */
export const KEPT_ON_REMOVAL_MEMBERS: Readonly<Record<string, unknown>> = {
  AccountRecoverySetting: undefined,
  SmsConfiguration: undefined,
  UserPoolTier: 'ESSENTIALS',
  DeletionProtection: 'INACTIVE',
  IssuerConfiguration: { Type: 'ORIGINAL' },
};

/**
 * Does `value` declare something for a {@link KEPT_ON_REMOVAL_MEMBERS} entry?
 * Absent, `null`, `''`, `{}` and the member's `unset` value do not.
 */
export function declaresMember(value: unknown, unset: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (isEmptyObjectPlaceholder(value)) return false;
  return unset === undefined || !isDeepStrictEqual(value, unset);
}

/**
 * Does `update()` put this {@link KEPT_ON_REMOVAL_MEMBERS} entry on the wire?
 * The same truthiness gates the update builds `UpdateUserPool` with, so a
 * desired `{}` that IS sent (`AccountRecoverySetting`) is not called a removal,
 * while the `SmsConfiguration` placeholder that is skipped is.
 */
export function sendsKeptMember(member: string, value: unknown): boolean {
  if (!value) return false;
  return member !== 'SmsConfiguration' || !isEmptyObjectPlaceholder(value);
}

/**
 * The `MfaConfiguration` a previous property bag left the pool at, or `''`
 * when it was OFF or unknown. An `EnabledMfas` factor without a declared
 * value resolved to `OPTIONAL` (`buildMfaConfigRequest`).
 */
export function previousMfaOn(previous: Record<string, unknown>): string {
  const declared = previous['MfaConfiguration'];
  if (declared === 'ON' || declared === 'OPTIONAL') return declared;
  if (
    (declared === undefined || declared === null || declared === '') &&
    readEnabledMfas(previous).declaresFactor
  ) {
    return 'OPTIONAL';
  }
  return '';
}
