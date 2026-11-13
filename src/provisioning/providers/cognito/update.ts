import {
  POLICIES_SUB_KEYS,
  sendsPoliciesSubKey,
  POLICIES_SUB_KEY_ANNOUNCEMENT,
  mfaPreflightNeedsLiveSignInPolicy,
  mfaMayNeedToPrecedeUpdateUserPool,
  narrowMfaConfiguration,
} from './mfa-preflight.js';
import {
  KEPT_ON_REMOVAL_MEMBERS,
  declaresMember,
  sendsKeptMember,
  createTimeOnlyChanges,
  previousMfaOn,
  isEmptyObjectPlaceholder,
  withPreviousCreateTimeOnly,
  STANDARD_USER_POOL_ATTRIBUTES,
} from './shared.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import type { UpdateContext, ResourceUpdateResult } from '../../../types/resource.js';
import {
  readDeclaredMfaConfiguration,
  hasMfaConfigProps,
  classifyDeclaredMfaConfiguration,
} from './mfa-request.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  type UpdateUserPoolCommandInput,
  type LambdaConfigType,
  type VerifiedAttributeType,
  type UserPoolMfaType,
  type AdminCreateUserConfigType,
  type AccountRecoverySettingType,
  type DeletionProtectionType,
  type UserAttributeUpdateSettingsType,
  type EmailConfigurationType,
  type SmsConfigurationType,
  type VerificationMessageTemplateType,
  type DeviceConfigurationType,
  type UserPoolAddOnsType,
  type UserPoolTierType,
  type KeyConfigurationType,
  type IssuerConfigurationType,
  UpdateUserPoolCommand,
  type SchemaAttributeType,
  DescribeUserPoolCommand,
  UntagResourceCommand,
  AddCustomAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import { tagMapAsList, readTagList, planTagDiff } from '../../tag-list.js';
import { protectedReplacementAdvice } from '../../replacement-protection-advice.js';
import type { CognitoUserPoolProvider } from '../cognito-provider.js';

/**
 * Announce a `Policies` sub-key removal the wire cannot express (issue
 * #1979). Fires once per removed sub-key when the previous side would have
 * put it on the wire and the desired side no longer does — the same
 * truthiness gates the forwarding itself uses (`sendsPoliciesSubKey`).
 *
 * WARN, not a reset, and not silence. `UpdateUserPool` preserves an omitted
 * sub-key (measured 2026-08-19, issue #1968) and CloudFormation performs the
 * SAME no-op on the identical template edit (measured 2026-09-02, issue
 * #1979; both transcripts at `toSdkUserPoolPolicies`) — so sending a reset
 * would diverge from cdkd's stated template compatibility, while silence
 * leaves an operator believing a TIGHTENING landed (the motivating shape:
 * deleting `SignInPolicy` to revoke a passwordless first-auth factor
 * deploys green while AWS keeps allowing it). The announcement names the
 * sub-key, states that the live value is unchanged, and gives the only
 * remedy that exists on the wire: declaring the sub-key explicitly with the
 * intended (e.g. default) configuration.
 *
 * Reached by four `update()` call sites, and each one needs its own reading
 * of what "previous" MEANS there:
 *
 * - **`cdkd deploy`** (previous = the last-deployed template's record) warns
 *   on the deploy that carries the removal. Later deploys compare template ==
 *   record and are honest NO_CHANGEs, matching CloudFormation's own converged
 *   stack (measured live, transcript at `toSdkUserPoolPolicies`).
 * - **`cdkd drift --revert`** (previous = the full live readback) is NARROWER
 *   than it looks, and the obvious reading of it is backwards. The revert's
 *   DESIRED side is not the drift baseline: `buildRevertNewProperties`
 *   (`drift.ts`) starts from `{ ...awsProperties }` and overwrites only the
 *   top-level keys that actually DRIFTED, so an undrifted `Policies` carries
 *   the LIVE blob and no removal is visible at all. And on a record with no
 *   `observedProperties` — the case that looks most reachable — the revert
 *   sets `preserveUntemplated`, whose `mergeUntemplatedValue` merges AWS's
 *   untemplated sub-keys straight back in, so the sub-key is present on the
 *   desired side and this warning does not fire -- unless the baseline's own
 *   `Policies` is not a plain record (a `null`, a string, an unresolved
 *   intrinsic), the one shape that merge declines: it returns the baseline
 *   whole and drops the live sub-keys with it. What else reaches it is the
 *   opposite shape: a record WITH `observedProperties`, plus a sub-key added
 *   out-of-band after that capture, so `Policies` drifts and the baseline
 *   written over it lacks the sub-key. The warning is then exactly right —
 *   the revert cannot take that sub-key back off the pool.
 * - **The rollback executor's `revert` arm** (previous = the newer state
 *   record) warns when rolling back to a record that lacked the sub-key; the
 *   rollback cannot restore that absence either.
 * - **The rollback executor's `revert-failed-update` arm** passes
 *   `attemptedProps` as the previous side, which is
 *   `op.attemptedProperties ?? current.properties` — so a journal segment
 *   that recorded no attempted properties degrades to the newer state record
 *   and behaves exactly as the `revert` arm above. With a real attempted bag
 *   it is the bag of an update that FAILED: if `UpdateUserPool` itself was
 *   rejected, the attempted sub-key may never have reached AWS, and the
 *   announcement then names a removal that had nothing to remove. Its literal
 *   claim (the pool keeps whatever policy it currently has) stays true, and
 *   the arm is not gated because a failure
 *   AFTER a successful `UpdateUserPool` is the same-shaped case where the
 *   sub-key DID land and the warning is fully earned; the two are not
 *   distinguishable from `attemptedProps` alone.
 *
 * The message interpolates NO property values (sub-key names and the
 * physical id only), so it needs no `maskSecrets` routing.
 */
export function warnOnUnremovablePoliciesSubKeys(
  this: CognitoUserPoolProvider,
  physicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): void {
  for (const subKey of POLICIES_SUB_KEYS) {
    if (!sendsPoliciesSubKey(previousProperties, subKey)) continue;
    if (sendsPoliciesSubKey(properties, subKey)) continue;
    const { label, reset } = POLICIES_SUB_KEY_ANNOUNCEMENT[subKey];
    this.logger.warn(
      `UserPool ${physicalId}: the desired configuration no longer declares ` +
        `Policies.${subKey}, and no UpdateUserPool input can express that removal — ` +
        `omitting the sub-key PRESERVES the live value, ` +
        `so the pool keeps its current ${label}. CloudFormation is the ` +
        `same no-op on the identical template edit, ` +
        `so cdkd deliberately sends no reset. To change the live value, ` +
        `declare Policies.${subKey} explicitly with the intended configuration (${reset}).`
    );
  }
}

/**
 * Announce a removed {@link KEPT_ON_REMOVAL_MEMBERS} property (issue #1160).
 * `UpdateUserPool` keeps each one when the call omits it (issue #4066's
 * ledger at `readLiveMfaConfiguration`), and CloudFormation keeps each one
 * on the same template edit: MEASURED us-east-1 2026-10-27 on a throwaway
 * stack (PLUS tier) whose update removed all four at once, beside a
 * removed `AutoVerifiedAttributes` that DID reset (the control). Every
 * value was unchanged right after `UPDATE_COMPLETE` and three minutes later.
 * `IssuerConfiguration` was measured the same way on its own stack
 * (us-east-1 2026-11-01, issue #2762: `UPDATED` stayed).
 * So cdkd sends no reset, as with `Policies`; only the silence was wrong.
 *
 * A previous value equal to what AWS reports for an unset member (the
 * `readCurrentState` placeholders: `{}`, `INACTIVE`, `ESSENTIALS`, and an
 * `ORIGINAL` issuer) is not announced, since keeping it changes nothing.
 */
export function warnOnKeptRemovedMembers(
  this: CognitoUserPoolProvider,
  logicalId: string,
  physicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): void {
  for (const [member, unset] of Object.entries(KEPT_ON_REMOVAL_MEMBERS)) {
    if (!declaresMember(previousProperties[member], unset)) continue;
    if (sendsKeptMember(member, properties[member])) continue;
    this.logger.warn(
      safeMsg`Cognito User Pool ${logicalId} (${physicalId}): the template no longer declares ` +
        safeMsg`${member}, and UpdateUserPool keeps a member it omits, so the pool keeps its ` +
        safeMsg`current ${member}. CloudFormation keeps it on the same edit too, so cdkd sends ` +
        safeMsg`no reset. To change it, declare ${member} with the value you want.`
    );
  }
}

/**
 * Update a Cognito User Pool
 *
 * `UserPoolName` is renamed in place: `UpdateUserPool` carries `PoolName`
 * and the pool keeps its id (issue #5358, measured against CloudFormation,
 * which renames the same way). `UsernameAttributes`, `AliasAttributes` and
 * `UsernameConfiguration` have no `UpdateUserPool` member, so a change to
 * one is refused before any call — see {@link createTimeOnlyChanges}.
 * The Schema (custom attributes) is partly mutable: AWS supports
 * ADDING new custom attributes in place via AddCustomAttributes, but cannot
 * modify or remove an existing attribute — those changes require replacement
 * and are rejected with ResourceUpdateNotSupportedError.
 *
 * The `context` parameter is read for two things: `maskSecrets` (issue
 * #1932 item 3), forwarded to `applyMfaConfig` so the MFA warnings mask a
 * resolved secret the same way they do on the create path; and the ORIGIN
 * of the desired bag (`replayingState` / `desiredFromAwsReadback`), which
 * decides whether the `MfaConfiguration` shape guard below refuses (a
 * template-path update) or warns (a rollback revert or `cdkd drift
 * --revert`) — issue #3728. It reads `desiredFromAwsReadback` for that
 * origin question ONLY: this provider has no empty-collection-means-delete
 * shape, so nothing here treats a readback value as a removal.
 */
export async function update(
  this: CognitoUserPoolProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating Cognito User Pool ${logicalId}: ${physicalId}`);

  // The update-path twin of `create()`'s guard (issue #1925 item 2), split
  // on the ORIGIN of the desired bag (issue #3728). The value is read off the
  // DESIRED side only, so on a template-path update it is template-borne and
  // the template is where it gets fixed: REFUSE, before any call, as
  // `create()` does. The two state-borne callers keep the warning — the
  // rollback executor's revert arms (`replayingState`, since issue #3141)
  // and `cdkd drift --revert` (`desiredFromAwsReadback`) — because a refusal
  // against a bag the user cannot edit from the template leaves the pool not
  // merely un-updatable but UN-ROLLBACKABLE. Gating on `desiredFromAwsReadback`
  // alone would re-introduce the refusal on exactly the rollback path, which
  // is why this arm was an unconditional warning until #3141 gave the revert
  // arms a flag of their own.
  //
  // NOT gated on the value having changed, unlike the DynamoDB / S3 splits:
  // `UpdateUserPool` re-sends the pool's configuration on every update, so
  // the value is always pending. The cost, stated rather than glossed: a
  // pool whose malformed value an earlier update deployed with a warning now
  // refuses its next template-path update, whatever it changes, until the
  // template value is fixed (an unchanged template diffs NO_CHANGE — the
  // value is canonicalized on both sides — and never reaches here).
  //
  // Wrapped the way `create()`'s read is: outside the try below, so the
  // refusal is not re-labelled as an AWS update failure.
  const stateBorneDesired =
    context?.replayingState === true || context?.desiredFromAwsReadback === true;
  let mfaConfiguration: string;
  try {
    mfaConfiguration = readDeclaredMfaConfiguration(
      properties['MfaConfiguration'],
      stateBorneDesired ? { onUnusable: (message) => this.logger.warn(message) } : {}
    );
  } catch (error) {
    throw new ProvisioningError(
      `${describeAwsFailure(error).detail}. Nothing was applied to user pool ${physicalId}`,
      resourceType,
      logicalId,
      physicalId,
      error instanceof Error ? error : undefined
    );
  }
  this.warnOnBlankMfaConfiguration(properties['MfaConfiguration']);

  // The create-time-only properties (issue #5358): `UpdateUserPool` has no
  // member for them, so leaving a change out of the request deployed it
  // "successfully" while AWS kept the create-time value. CloudFormation
  // refuses the same change ("Updates are not allowed for property"), so
  // cdkd refuses it too, before any call, with the typed error the deploy
  // engine's `--replace` fallback catches. Nothing has been applied yet, so
  // the pool AWS holds still carries the RECORDED `DeletionProtection`.
  //
  // The two state-borne callers WARN instead, for the same reason the MFA
  // guard above does: the rollback executor's revert arms and `cdkd drift
  // --revert` hand over a bag the template cannot fix, and a refusal there
  // leaves the pool un-rollbackable. Nothing is sent for these properties
  // either way, so the pool keeps the value the PREVIOUS side describes (on
  // `drift --revert` that side IS the live readback), and that value is what
  // `effectiveProperties` records below — recording the desired one would
  // make it the next deploy's previous side, a change AWS never applied.
  const createTimeOnly = createTimeOnlyChanges(properties, previousProperties);
  const keptCreateTimeOnly = stateBorneDesired ? createTimeOnly : [];
  if (createTimeOnly.length > 0) {
    const changed = createTimeOnly.join(', ');
    if (stateBorneDesired) {
      this.logger.warn(
        safeMsg`Cognito User Pool ${logicalId} (${physicalId}): ${changed} cannot be changed in place ` +
          safeMsg`(UpdateUserPool has no such member), so the pool keeps its current value and cdkd ` +
          safeMsg`records that value.`
      );
    } else {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `${changed} cannot be changed on an existing user pool — UpdateUserPool has no such ` +
          `member, and CloudFormation refuses the same change ("Updates are not allowed for ` +
          `property"). Nothing was applied to user pool ${physicalId}. ` +
          this.replacementRemedy(physicalId, previousProperties['DeletionProtection'] === 'ACTIVE')
      );
    }
  }

  // The pre-flight (issues #1975 / #1977), and THIS is the path it exists
  // for. Placed ahead of `readLiveMfaConfiguration` below -- a READ, not a
  // mutation, but the requirement is "before the first API call", and a
  // refused combination has no reason to spend a round trip. Everything
  // mutating (`UpdateUserPool`, `AddCustomAttributes`,
  // `SetUserPoolMfaConfig`) is further down still, inside the try.
  //
  // Without it the update PARTIAL-APPLIES: `UpdateUserPool` carries the new
  // `Policies.SignInPolicy` (and every other mutable field) and lands, then
  // `applyMfaConfig` -> `SetUserPoolMfaConfig` is refused by AWS and
  // `update()` throws with no provider-side unwind -- leaving the pool with
  // the new sign-in policy and the OLD MFA state, i.e. the loosening half
  // applied and the tightening half not.
  //
  // The live sign-in policy is read first ONLY when the pre-flight could
  // judge it (issue #2051): a template that omits `Policies.SignInPolicy`
  // leaves the live list in place, and that list is what
  // `SetUserPoolMfaConfig(ON)` then meets.
  const liveFirstAuthFactors = mfaPreflightNeedsLiveSignInPolicy(properties, mfaConfiguration)
    ? await this.readLiveAllowedFirstAuthFactors(physicalId)
    : undefined;
  this.assertMfaCombinationApplicable(
    logicalId,
    resourceType,
    physicalId,
    properties,
    mfaConfiguration,
    liveFirstAuthFactors
  );

  // Capture the live MFA configuration BEFORE `UpdateUserPool` can touch it
  // (issue #1925, third item) -- see `readLiveMfaConfiguration` for why the
  // ordering is load-bearing. Gated by a cheap SUPERSET of the announcement
  // condition, built only from predicates that already exist: a template that
  // DECLARED a value is never a defaulted downgrade, and one with no
  // MFA-routed property never reaches `SetUserPoolMfaConfig` at all. Whether
  // the resolved value is actually `OFF` is decided later, off the BUILT
  // request, so the OPTIONAL/OFF default rule is never restated here -- the
  // cost of the looser gate is one extra read on an update that declares a
  // factor without an MfaConfiguration, and the result is simply unused.
  const liveMfa =
    mfaConfiguration === '' && hasMfaConfigProps(properties)
      ? await this.readLiveMfaConfiguration(physicalId)
      : undefined;

  // A removed `Policies` sub-key cannot be put on the wire, and both AWS and
  // CloudFormation treat the omission as "keep the live value" — announce it
  // rather than deploying the removal silently (issue #1979; the A/B
  // transcript lives at `toSdkUserPoolPolicies`). Before the try so the
  // announcement cannot be lost to an unrelated update failure, and so it is
  // adjacent to the other pre-call announcements above.
  this.warnOnUnremovablePoliciesSubKeys(physicalId, properties, previousProperties);
  this.warnOnKeptRemovedMembers(logicalId, physicalId, properties, previousProperties);

  // A template that drops `MfaConfiguration` and every factor property sends
  // no MFA member, which leaves MFA on; CloudFormation turns it OFF (issue
  // #1160, measured at `turnOffRemovedMfa`).
  const removedMfa =
    classifyDeclaredMfaConfiguration(properties['MfaConfiguration']) === 'absent' &&
    !hasMfaConfigProps(properties)
      ? previousMfaOn(previousProperties)
      : '';

  // The call ORDER (issue #3562): `SetUserPoolMfaConfig` goes first only for
  // the one measured shape that needs it -- see
  // `mfaMayNeedToPrecedeUpdateUserPool`. Read before the try, like the other
  // pre-call reads; it never throws.
  const mfaFirstPrior = mfaMayNeedToPrecedeUpdateUserPool(properties, mfaConfiguration)
    ? await this.readMfaFirstPrior(physicalId)
    : undefined;

  try {
    const updateParams: UpdateUserPoolCommandInput = {
      UserPoolId: physicalId,
    };

    // Issue #5358: the rename was never sent, so a changed `UserPoolName`
    // deployed "successfully" while AWS kept the old name. A template that
    // DROPS the property sends nothing and the pool keeps its live name —
    // what CloudFormation does on the same edit (measured 2026-10-26: the
    // change set reads `Modify`, the update completes, the name stays).
    if (typeof properties['UserPoolName'] === 'string' && properties['UserPoolName'] !== '') {
      updateParams.PoolName = properties['UserPoolName'];
    }

    if (properties['Policies']) {
      const sdkPolicies = this.toSdkUserPoolPolicies(
        properties['Policies'] as Record<string, unknown>
      );
      if (sdkPolicies) {
        updateParams.Policies = sdkPolicies;
      }
    }
    if (properties['LambdaConfig']) {
      updateParams.LambdaConfig = properties['LambdaConfig'] as LambdaConfigType;
    }
    // The one field measured to RESET when omitted -- see the ledger in
    // `readLiveMfaConfiguration`. So a template that drops this property
    // really does clear it at AWS, unlike `Policies` above, whose sub-keys
    // survive their own omission.
    if (properties['AutoVerifiedAttributes']) {
      updateParams.AutoVerifiedAttributes = properties[
        'AutoVerifiedAttributes'
      ] as VerifiedAttributeType[];
    }
    // The same `!hasMfaConfigProps` gate the create path applies (issue
    // #1925 item 1). AWS rejects an `UpdateUserPool` carrying ON / OPTIONAL
    // unless a factor is ALREADY enabled on the pool, and the only call that
    // can enable one is the post-update `SetUserPoolMfaConfig` below — so an
    // update that FIRST turns MFA on (`MfaConfiguration: OPTIONAL` +
    // `EnabledMfas`) hit exactly the rejection the create path's comment
    // describes. The forward bought nothing either way: `applyMfaConfig`
    // always sets `MfaConfiguration` on the same update, overwriting it.
    if (mfaConfiguration && !hasMfaConfigProps(properties)) {
      updateParams.MfaConfiguration = mfaConfiguration as UserPoolMfaType;
    }
    if (properties['AdminCreateUserConfig']) {
      updateParams.AdminCreateUserConfig = properties[
        'AdminCreateUserConfig'
      ] as AdminCreateUserConfigType;
    }
    if (properties['AccountRecoverySetting']) {
      updateParams.AccountRecoverySetting = properties[
        'AccountRecoverySetting'
      ] as AccountRecoverySettingType;
    }
    // Omitting `UserPoolTags` KEEPS the pool's tags, so a removed key is
    // untagged after the call (`untagRemovedUserPoolTags`, issue #1160).
    if (properties['UserPoolTags']) {
      updateParams.UserPoolTags = properties['UserPoolTags'] as Record<string, string>;
    }
    if (properties['DeletionProtection']) {
      updateParams.DeletionProtection = properties['DeletionProtection'] as DeletionProtectionType;
    }
    if (properties['UserAttributeUpdateSettings']) {
      updateParams.UserAttributeUpdateSettings = properties[
        'UserAttributeUpdateSettings'
      ] as UserAttributeUpdateSettingsType;
    }
    if (properties['EmailConfiguration']) {
      updateParams.EmailConfiguration = properties['EmailConfiguration'] as EmailConfigurationType;
    }
    // Class 2 sanitize: `SmsConfiguration: {}` would be rejected by
    // UpdateUserPool because `SnsCallerArn` is a required sub-field.
    // Skip the empty-object placeholder so a no-drift round-trip
    // (state == AWS, both empty) is a logical no-op.
    if (
      properties['SmsConfiguration'] &&
      !isEmptyObjectPlaceholder(properties['SmsConfiguration'])
    ) {
      updateParams.SmsConfiguration = properties['SmsConfiguration'] as SmsConfigurationType;
    }
    if (properties['VerificationMessageTemplate']) {
      updateParams.VerificationMessageTemplate = properties[
        'VerificationMessageTemplate'
      ] as VerificationMessageTemplateType;
    }
    if (properties['DeviceConfiguration']) {
      updateParams.DeviceConfiguration = properties[
        'DeviceConfiguration'
      ] as DeviceConfigurationType;
    }
    // Class 2 sanitize: `UserPoolAddOns: {}` would be rejected because
    // `AdvancedSecurityMode` is a required sub-field.
    if (properties['UserPoolAddOns'] && !isEmptyObjectPlaceholder(properties['UserPoolAddOns'])) {
      updateParams.UserPoolAddOns = properties['UserPoolAddOns'] as UserPoolAddOnsType;
    }
    // `!== undefined` (not truthy) so empty-string placeholders that
    // `readCurrentState` emits for unset message fields reach AWS — a
    // truthy gate would silently drop `''` and `cdkd drift --revert`
    // (which round-trips observed → desired) would report `✓ reverted`
    // while leaving the AWS-side message untouched. The next drift run
    // re-detects the same drift — silent fail.
    if (properties['EmailVerificationMessage'] !== undefined) {
      updateParams.EmailVerificationMessage = properties['EmailVerificationMessage'] as string;
    }
    if (properties['EmailVerificationSubject'] !== undefined) {
      updateParams.EmailVerificationSubject = properties['EmailVerificationSubject'] as string;
    }
    if (properties['SmsAuthenticationMessage'] !== undefined) {
      updateParams.SmsAuthenticationMessage = properties['SmsAuthenticationMessage'] as string;
    }
    if (properties['SmsVerificationMessage'] !== undefined) {
      updateParams.SmsVerificationMessage = properties['SmsVerificationMessage'] as string;
    }
    if (properties['UserPoolTier']) {
      updateParams.UserPoolTier = properties['UserPoolTier'] as UserPoolTierType;
    }
    // Omitting `KeyConfiguration` RESETS a customer-managed key to the AWS
    // owned key, which is what CloudFormation does when a template drops it
    // too (measured, issue #2762), so a removal needs no call of its own.
    if (properties['KeyConfiguration']) {
      updateParams.KeyConfiguration = properties['KeyConfiguration'] as KeyConfigurationType;
    }
    // Omitting `IssuerConfiguration` KEEPS it (`warnOnKeptRemovedMembers`).
    if (properties['IssuerConfiguration']) {
      updateParams.IssuerConfiguration = properties[
        'IssuerConfiguration'
      ] as IssuerConfigurationType;
    }

    const mfaOptions = {
      ...(liveMfa?.value !== undefined ? { liveMfaConfiguration: liveMfa.value } : {}),
      ...(liveMfa?.failed === true ? { liveReadFailed: true } : {}),
      declaredKind: classifyDeclaredMfaConfiguration(properties['MfaConfiguration']),
      // The UPDATE twin of the masker `create()` passes (issue #1932 item 3).
      // The two paths reach the SAME `buildMfaConfigRequest` warnings with the
      // same resolved bag, so masking one and not the other would leave the
      // fix conditional on which path a given deploy happens to take.
      ...(context?.maskSecrets && { maskSecrets: context.maskSecrets }),
    };

    if (mfaFirstPrior) {
      // MFA first (issue #3562). If `UpdateUserPool` then fails, put the MFA
      // configuration back so the update stays all-or-nothing, and surface
      // the ORIGINAL error. A later failure (the Schema reconcile below) is
      // not unwound -- the usual order does not unwind `UpdateUserPool`
      // there either.
      await this.applyMfaConfig(physicalId, properties, mfaConfiguration, mfaOptions);
      try {
        await this.getClient().send(new UpdateUserPoolCommand(updateParams));
      } catch (updateError) {
        await this.restoreMfaConfig(physicalId, mfaFirstPrior);
        throw updateError;
      }
    } else {
      await this.getClient().send(new UpdateUserPoolCommand(updateParams));
    }

    // Schema (custom attributes): UpdateUserPool does NOT accept Schema, so a
    // template that adds a custom attribute on redeploy would otherwise be a
    // silent drop (the deploy reports success, AWS keeps the old schema, and
    // the next diff sees the change again with nothing applied). AWS lets you
    // ADD custom attributes in place via AddCustomAttributes, but it cannot
    // modify or remove an existing one. Reconcile the added attributes here;
    // reject a removal / modification of an existing attribute with a typed
    // error (replacement required).
    await this.reconcileSchemaCustomAttributes(
      logicalId,
      physicalId,
      resourceType,
      properties['Schema'] as SchemaAttributeType[] | undefined,
      previousProperties['Schema'] as SchemaAttributeType[] | undefined,
      // Issue [#2610] site 4. Which bag answers "is this pool protected right
      // now" is decided by ORDER, and this site is the one exception to the
      // read-the-recorded-bag rule in
      // `../replacement-protection-advice.ts`: the `UpdateUserPool` call a
      // few lines above has ALREADY applied a DECLARED `DeletionProtection`,
      // so by the time the schema refusal fires AWS holds the DESIRED value.
      // That half is measured — the gate up there is a TRUTHINESS test
      // (`if (properties['DeletionProtection'])`), so an absent / empty
      // desired value is never put on the wire, which is why this mirrors
      // that gate rather than using `??`, and
      // `tests/unit/provisioning/cognito-schema-replace-remedy.test.ts`
      // asserts the SENT input in all three arms.
      //
      // The FALLBACK's other half -- that AWS KEEPS the recorded value when
      // the desired bag omits it -- is now MEASURED too (issue #2675; the
      // entry is in `readLiveMfaConfiguration`'s ledger): omitting
      // `DeletionProtection` from `UpdateUserPool` does NOT reset it, so the
      // recorded `ACTIVE` is still what the pool holds when this fires.
      (properties['DeletionProtection']
        ? properties['DeletionProtection']
        : previousProperties['DeletionProtection']) === 'ACTIVE'
    );

    // EnabledMfas / email-OTP message+subject / WebAuthn config are NOT on
    // UpdateUserPool — apply them via SetUserPoolMfaConfig after the main
    // update (no-op when none are present), unless they already went first.
    if (!mfaFirstPrior) {
      await this.applyMfaConfig(physicalId, properties, mfaConfiguration, mfaOptions);
    }
    // Describe the user pool to get updated attributes
    const describeResponse = await this.getClient().send(
      new DescribeUserPoolCommand({ UserPoolId: physicalId })
    );

    const userPool = describeResponse.UserPool;
    await this.untagRemovedUserPoolTags(
      logicalId,
      physicalId,
      resourceType,
      userPool?.Arn,
      properties['UserPoolTags'],
      previousProperties['UserPoolTags']
    );
    // LAST, after the untag: a failed untag (a role without
    // cognito-idp:UntagResource) then fails the update with MFA still on,
    // rather than leaving a recorded MFA the pool no longer has.
    if (removedMfa !== '') {
      await this.turnOffRemovedMfa(logicalId, physicalId, removedMfa);
    }

    this.logger.debug(`Successfully updated Cognito User Pool ${logicalId}`);
    const region = await this.getClient().config.region();
    // Same derivation as the create path (issue #1745) — the two must agree or
    // an update would rewrite a correct suffix into a commercial-only one.
    const { urlSuffix } = derivePartitionAndUrlSuffix(region);
    const providerName = `cognito-idp.${region}.${urlSuffix}/${physicalId}`;
    const providerUrl = `https://cognito-idp.${region}.${urlSuffix}/${physicalId}`;

    // The update-path twin of the create-side record (see
    // `narrowMfaConfiguration`). This is the arm that mattered most: every
    // `update()` caller honours `effectiveProperties`, including
    // `cdkd drift --revert` and the rollback executor's revert arms, so
    // without it a `--revert` re-issued the same substitution forever while
    // the record kept describing a value AWS does not hold.
    const effectiveProperties = withPreviousCreateTimeOnly(
      narrowMfaConfiguration(properties),
      previousProperties,
      keptCreateTimeOnly
    );

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: userPool?.Arn,
        ProviderName: providerName,
        ProviderURL: providerUrl,
        UserPoolId: physicalId,
      },
      ...(effectiveProperties !== properties ? { effectiveProperties } : {}),
    };
  } catch (error) {
    // Let the typed immutable-update rejection propagate so the deploy
    // engine's --replace fallback can catch it; wrapping it as a generic
    // ProvisioningError would hide it from that branch. Already-wrapped
    // ProvisioningErrors (e.g. the malformed-Schema guard) pass through
    // unchanged so they are not double-wrapped.
    if (error instanceof ResourceUpdateNotSupportedError || error instanceof ProvisioningError) {
      throw error;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Cognito User Pool ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Untag the `UserPoolTags` keys the previous side names and the desired side
 * no longer does (go-to-k/cdkd#1160).
 *
 * `UpdateUserPool` KEEPS a pool's tags when the call omits `UserPoolTags`
 * (measured, issue #4066; see {@link USER_POOL_KEPT_ON_OMISSION}), so a
 * template that drops the property, or one key of it, left the tag on the
 * pool while the deploy reported success. CloudFormation removes it: the
 * type's schema marks `UserPoolTags` as its `tagUpdatable` tag property and
 * grants its update handler `cognito-idp:UntagResource`. The untag is sent
 * whether or not the update also carried `UserPoolTags`, since a key
 * `UntagResource` does not hold is no error, and that keeps the removal
 * independent of how `UpdateUserPool` treats a smaller map.
 *
 * `aws:` keys are never untagged (AWS reserves them, and the readback drops
 * them). A desired side that is not a readable key -> value map untags
 * nothing: `UpdateUserPool` above already sent it as declared. A previous
 * side cdkd cannot read untags nothing and says so, and so does a recorded key cdkd cannot name.
 */
export async function untagRemovedUserPoolTags(
  this: CognitoUserPoolProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  poolArn: string | undefined,
  desiredTags: unknown,
  previousTags: unknown
): Promise<void> {
  if (previousTags === undefined || previousTags === null) return;
  const desired = tagMapAsList(desiredTags ?? {});
  if (readTagList(desired, 'desired').kind !== 'tags') return;
  const plan = planTagDiff(tagMapAsList(previousTags), desired);
  if (plan.recordedUnreadable) {
    // Not the generic tag-list.ts text: UpdateUserPool applied the desired tags
    // above, and this path only removes.
    this.logger.warn(
      safeMsg`The recorded UserPoolTags of ${resourceType} ${logicalId} is not a map cdkd can ` +
        safeMsg`read, so cdkd removed no tag. Untag any key the template no longer names yourself.`
    );
    return;
  }
  if (plan.recordedHidden > 0) {
    this.logger.warn(
      safeMsg`The recorded UserPoolTags of ${resourceType} ${logicalId} holds ` +
        safeMsg`${plan.recordedHidden} key(s) derived from a dynamic reference or its mask, which ` +
        safeMsg`cdkd cannot name, so it removed none of them. Untag any such key the template no ` +
        safeMsg`longer names yourself.`
    );
  }
  const removed = plan.remove.filter((key) => !key.startsWith('aws:'));
  if (removed.length === 0) return;
  if (poolArn === undefined || poolArn === '') {
    this.logger.warn(
      safeMsg`Cognito User Pool ${logicalId} (${physicalId}): the template no longer declares ` +
        safeMsg`${removed.length} UserPoolTags key(s), but DescribeUserPool returned no ARN to ` +
        safeMsg`untag them with, so they stay on the pool. Remove them with ` +
        safeMsg`aws cognito-idp untag-resource.`
    );
    return;
  }
  await this.getClient().send(new UntagResourceCommand({ ResourceArn: poolArn, TagKeys: removed }));
}

/**
 * Reconcile a user pool's Schema custom attributes on update.
 *
 * AWS supports ADDING new custom attributes in place (AddCustomAttributes)
 * but cannot modify or remove an existing attribute. Standard attributes are
 * fully immutable. So:
 *  - attributes present only in the new Schema (and custom) are added;
 *  - removing or modifying an existing attribute, or adding a standard
 *    attribute, requires replacement -> ResourceUpdateNotSupportedError.
 * A byte-identical Schema is a no-op (no AddCustomAttributes call).
 */
export async function reconcileSchemaCustomAttributes(
  this: CognitoUserPoolProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  newSchema: SchemaAttributeType[] | undefined,
  oldSchema: SchemaAttributeType[] | undefined,
  /**
   * Whether `DeletionProtection` is `ACTIVE` on the pool AWS holds at the
   * moment the immutable-Schema refusal below fires. Defaults to `false` so
   * the short advice is the fallback for any future caller that cannot
   * answer — the same direction issue [#2579] took for protection enabled
   * out of band.
   */
  deletionProtected = false
): Promise<void> {
  const newAttrs = newSchema ?? [];
  const oldAttrs = oldSchema ?? [];

  // A Schema entry with no Name is a malformed template — `byName` below
  // would silently drop it from add/modify/remove detection, so the change
  // would be neither applied nor rejected. Fail loudly instead (CDK synth
  // always emits Name; this only fires on a hand-written L1 template).
  for (const attr of newAttrs) {
    if (attr.Name === undefined) {
      throw new ProvisioningError(
        `Cognito User Pool ${logicalId} has a Schema attribute with no Name — every Schema entry must have a Name`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  const byName = (attrs: SchemaAttributeType[]): Map<string, SchemaAttributeType> => {
    const map = new Map<string, SchemaAttributeType>();
    for (const attr of attrs) {
      if (attr.Name !== undefined) map.set(attr.Name, attr);
    }
    return map;
  };
  const oldByName = byName(oldAttrs);
  const newByName = byName(newAttrs);

  const added: SchemaAttributeType[] = [];
  const modified: string[] = [];
  for (const [name, attr] of newByName) {
    const prev = oldByName.get(name);
    if (!prev) {
      added.push(attr);
    } else if (JSON.stringify(prev) !== JSON.stringify(attr)) {
      modified.push(name);
    }
  }
  const removed = [...oldByName.keys()].filter((n) => !newByName.has(n));

  // Adding a STANDARD attribute (or any removal / modification of an existing
  // one) is not an in-place operation — AddCustomAttributes only adds custom
  // attributes.
  const addedStandard = added
    .filter((a) => a.Name !== undefined && STANDARD_USER_POOL_ATTRIBUTES.has(a.Name))
    .map((a) => a.Name as string);
  const immutableChanges = [
    ...removed.map((n) => `removed attribute '${n}'`),
    ...modified.map((n) => `modified attribute '${n}'`),
    ...addedStandard.map((n) => `added standard attribute '${n}'`),
  ];
  if (immutableChanges.length > 0) {
    throw new ResourceUpdateNotSupportedError(
      resourceType,
      logicalId,
      `the Schema change (${immutableChanges.join('; ')}) is immutable on AWS — AWS can only ADD ` +
        `custom attributes in place, so removing or modifying an attribute requires recreating the ` +
        `pool. ${this.replacementRemedy(physicalId, deletionProtected)}`
    );
  }

  const addedCustom = added.filter(
    (a) => a.Name !== undefined && !STANDARD_USER_POOL_ATTRIBUTES.has(a.Name)
  );
  if (addedCustom.length === 0) return;

  this.logger.debug(
    `Adding ${addedCustom.length} custom attribute(s) to ${physicalId}: ` +
      addedCustom.map((a) => a.Name).join(', ')
  );
  await this.getClient().send(
    new AddCustomAttributesCommand({
      UserPoolId: physicalId,
      CustomAttributes: addedCustom,
    })
  );
}

/**
 * The "recreate the pool" remedy a refused in-place change carries: the
 * replace flags, plus how to lift `DeletionProtection` first when the pool
 * holds it ACTIVE (`deletionProtected`, decided by the caller from whichever
 * bag describes the pool AWS holds at the moment of the refusal).
 */
export function replacementRemedy(
  this: CognitoUserPoolProvider,
  physicalId: string,
  deletionProtected: boolean
): string {
  // With the run's flags (go-to-k/cdkd#6245).
  const replaceFlags = deployReplaceCommand(true);
  return deletionProtected
    ? protectedReplacementAdvice({
        evidence: "cdkd's properties for this user pool carry DeletionProtection: ACTIVE",
        replaceFlags,
        disable: {
          before: 'aws cognito-idp update-user-pool --user-pool-id',
          identifier: physicalId,
          after: '--deletion-protection INACTIVE',
          // The one-liner above is not safe to paste unqualified, so the
          // qualification rides `caveat`, which the builder renders OUTSIDE
          // the backticks: prose inside a pasteable span is itself the
          // defect this issue is about.
          //
          // What `readLiveMfaConfiguration`'s ledger supports, and no more:
          // omission behaviour is per FIELD. `DeletionProtection` itself is
          // measured NOT to reset (issue [#2675]), but the command below
          // omits every other member, and `AutoVerifiedAttributes` is
          // measured to RESET on omission -- which is why the advice to
          // send the complete configuration stands.
          // ONE literal, not a concatenation: `'a' + 'b'` widens to
          // `string` in TypeScript, and `CdkdAuthoredLiteral` rejects the
          // widened type by design. That is the cost of moving this fence
          // from a grep to the compiler, and it is worth paying.
          caveat:
            'Note UpdateUserPool resets some members a call omits (self sign-up, Lambda triggers, advanced security, AutoVerifiedAttributes and a customer-managed KeyConfiguration among them), so send your complete pool configuration alongside that flag rather than the flag alone.',
        },
      })
    : `AWS::Cognito::UserPool is a stateful type, so re-run with ${replaceFlags} to recreate it (this deletes all users in the pool).`;
}
