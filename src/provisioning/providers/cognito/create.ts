import {
  type UserPoolPolicyType,
  type PasswordPolicyType,
  type SignInPolicyType,
  type CreateUserPoolCommandInput,
  type VerifiedAttributeType,
  type UsernameAttributeType,
  type SchemaAttributeType,
  type LambdaConfigType,
  type UserPoolMfaType,
  type AdminCreateUserConfigType,
  type AccountRecoverySettingType,
  type UserAttributeUpdateSettingsType,
  type DeletionProtectionType,
  type AliasAttributeType,
  type EmailConfigurationType,
  type SmsConfigurationType,
  type VerificationMessageTemplateType,
  type UsernameConfigurationType,
  type DeviceConfigurationType,
  type UserPoolAddOnsType,
  type UserPoolTierType,
  type KeyConfigurationType,
  type IssuerConfigurationType,
  type CreateUserPoolCommandOutput,
  CreateUserPoolCommand,
  type UserPoolType,
  DeleteUserPoolCommand,
  ListUserPoolsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { generatedNameFor } from '../../resource-name.js';
import { readDeclaredMfaConfiguration, hasMfaConfigProps } from './mfa-request.js';
import { replayWarn } from '../../config-shape.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  createUserPoolLatch,
  userPoolsCreatedByThisProcess,
  MAX_USER_POOL_LIST_PAGES,
  MAX_REPORTED_ORPHAN_POOLS,
} from './shared.js';
import {
  createMaskedLogSinks,
  maskerOrIdentity,
  type MaskedLogSinks,
} from '../../masked-retry-logger.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import {
  replayedSendWindow,
  type AmbiguousCreateWindow,
  ambiguousAttemptLead,
  isInsideWindow,
} from '../ambiguous-create.js';
import { derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import { narrowMfaConfiguration } from './mfa-preflight.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import type { CognitoUserPoolProvider } from '../cognito-provider.js';

/**
 * Build the SDK `Policies` input from the CFn `Policies` blob. Both
 * sub-keys must be forwarded: `SignInPolicy` (passwordless first-auth
 * factors) was silently dropped before issue #1380, so a template that
 * declared -- or later CHANGED -- the allowed first-auth factors never
 * reached AWS at all.
 *
 * **Forwarding is what APPLIES a declared value; it is NOT what keeps an
 * existing one alive.** The original rationale here was AWS's blanket "if
 * you don't provide a value for an attribute, Amazon Cognito sets it to its
 * default value", i.e. that omitting `SignInPolicy` would WIPE it. MEASURED
 * us-east-1 2026-08-19 (issue #1968), on a pool created with
 * `SignInPolicy.AllowedFirstAuthFactors = [PASSWORD, EMAIL_OTP]` on the
 * default `ESSENTIALS` tier -- no explicit `UserPoolTier` was needed for the
 * field to be settable:
 *
 * - `UpdateUserPool` sending `Policies` with ONLY `PasswordPolicy` left
 *   `SignInPolicy` at `[PASSWORD, EMAIL_OTP]`. Control: that same call's
 *   `--auto-verified-attributes email` applied, so the update really ran.
 * - `UpdateUserPool` omitting `Policies` entirely left BOTH sub-keys intact
 *   (a non-default `RequireSymbols: false` survived too), while
 *   `AutoVerifiedAttributes` reset from `[email]` to none in that very call
 *   -- the control proving the omission was processed, not ignored.
 * - An explicit `SignInPolicy` write landed in both directions
 *   (`[PASSWORD]`, then back to `[PASSWORD, EMAIL_OTP]`), so the field is
 *   reachable and writable here rather than silently dropped.
 * - The MIRROR image holds too, so the ledger entry is measured rather than
 *   generalised from one sub-key: a container carrying ONLY `SignInPolicy`
 *   updated it to `[PASSWORD, WEB_AUTHN]` while leaving a non-default
 *   `PasswordPolicy` (`MinimumLength: 12`, `RequireSymbols: false`) intact,
 *   with the same `--auto-verified-attributes` control.
 *
 * So the forwarding stays -- it is the only way a CHANGED sign-in policy is
 * applied -- but on the measured reason, not the blanket sentence. Do not
 * generalise that sentence to another field from this site: see
 * `readLiveMfaConfiguration`'s docstring, which carries the one ledger of
 * which fields were measured to reset and which were not.
 *
 * **Consequence of that measurement: there is no removal path, and that is
 * PARITY, not a gap to close with a reset** (issue #1979). This builder
 * forwards only what the template DECLARES, so deleting `SignInPolicy` from
 * a template sends nothing for it -- and nothing sent means nothing changed.
 * Whether that no-op should become an explicit reset was settled by a real
 * CloudFormation A/B rather than assumed. MEASURED us-east-1 2026-09-02
 * (issue #1979), on a CFn stack whose pool declared
 * `PasswordPolicy: {MinimumLength: 12, RequireSymbols: false}` +
 * `SignInPolicy: {AllowedFirstAuthFactors: [PASSWORD, EMAIL_OTP]}`
 * (ESSENTIALS tier), three template edits, each reaching UPDATE_COMPLETE:
 *
 * - removing the `SignInPolicy` sub-key alone left the live value at
 *   `[PASSWORD, EMAIL_OTP]`;
 * - removing the `PasswordPolicy` sub-key alone left the live value at
 *   `MinimumLength: 12` / `RequireSymbols: false` -- NOT reset to the
 *   documented defaults (8, every requirement on);
 * - removing the whole `Policies` container left BOTH sub-keys intact.
 *
 * So CloudFormation performs the SAME silent no-op, and a cdkd-side reset
 * would be a DIVERGENCE from its stated template compatibility, not parity.
 * What was wrong was only the SILENCE: `update()` announces the
 * inexpressible removal via `warnOnUnremovablePoliciesSubKeys`, naming the
 * sub-key, saying the live value is unchanged, and pointing at the
 * explicit-declaration remedy. It fires on `cdkd deploy`; the other three
 * `update()` call sites reach it only under conditions each of which is
 * spelled out at that method, because the obvious reading of two of them is
 * wrong.
 *
 * **The announcement is the ONLY signal, which is why silence was the whole
 * defect.** The issue predicted that the removal would also leave a
 * permanent `cdkd drift` difference; MEASURED us-east-1 2026-09-02 on a live
 * pool (stack `Cdkd1979LiveVerify`), it does not, and the prediction is
 * withdrawn here rather than repeated. `update()` refreshes
 * `observedProperties` from the POST-update `readCurrentState`, so the
 * retained sub-key lands in the drift BASELINE (`observedProperties ??
 * properties`, `drift.ts`) as well as on the pool: the announcing deploy
 * converges, the next identical deploy is an honest NO_CHANGE, and both
 * `cdkd drift` and `cdkd diff` report nothing. Nothing downstream of the
 * deploy tells the operator that the tightening did not land -- so the warn
 * is not a supplement to a visible drift, it is the only place the fact
 * appears at all.
 */
export function toSdkUserPoolPolicies(
  this: CognitoUserPoolProvider,
  policies: Record<string, unknown>
): UserPoolPolicyType | undefined {
  const result: UserPoolPolicyType = {};
  if (policies['PasswordPolicy']) {
    result.PasswordPolicy = policies['PasswordPolicy'] as PasswordPolicyType;
  }
  if (policies['SignInPolicy']) {
    result.SignInPolicy = policies['SignInPolicy'] as SignInPolicyType;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Create a Cognito User Pool
 */
export async function create(
  this: CognitoUserPoolProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating Cognito User Pool ${logicalId}`);

  const poolName =
    (properties['UserPoolName'] as string | undefined) ||
    generatedNameFor('AWS::Cognito::UserPool', logicalId);

  // The shape guard for `MfaConfiguration` (issue #1925 item 2). A declared
  // `null` / `[]` / `{Ref: ...}` used to slip past the `as UserPoolMfaType`
  // cast, fail the truthy gate below, and be forwarded nowhere — so the pool
  // came up with AWS's own default of MFA OFF, which is frequently the
  // OPPOSITE of what the template declared. The reverse-replacement rollback
  // creates from a STATE record, so the refusal downgrades to a warning
  // there (`replayWarn`) — the user has no template-side remedy for a value
  // an older binary recorded.
  //
  // The fallback is `''` rather than a real default so the guard reports
  // ONLY the malformed shapes: with a blank fallback `requireConfigString`
  // accepts any string (including `''`, which the truthy gates below then
  // treat as absent, unchanged from before) and refuses everything else.
  //
  // Wrapped the way `DynamoDBGlobalTableProvider`'s `BillingMode` guard is:
  // the read sits OUTSIDE `create()`'s try, so an unwrapped throw would
  // escape untyped into the deploy engine's retry loop. It stays outside so
  // the refusal cannot be mis-reported as an AWS creation failure, and so it
  // runs before `CreateUserPool` — nothing to roll back.
  let mfaConfiguration: string;
  try {
    mfaConfiguration = readDeclaredMfaConfiguration(
      properties['MfaConfiguration'],
      replayWarn(this.logger, context)
    );
    this.warnOnBlankMfaConfiguration(properties['MfaConfiguration']);
  } catch (error) {
    throw new ProvisioningError(
      describeAwsFailure(error).detail,
      resourceType,
      logicalId,
      poolName,
      error instanceof Error ? error : undefined
    );
  }

  // The pre-flight (issues #1975 / #1977). It sits OUTSIDE the try below so a
  // refusal cannot be re-wrapped as an AWS creation failure, and BEFORE
  // `CreateUserPool` -- the create path's first AWS call of any kind -- so
  // nothing is applied when it refuses. On CREATE the partial apply is
  // already caught by the `createdUserPoolId` rollback, so what this buys
  // here is the cdkd-worded message and the saved round trip; the UPDATE
  // twin below is where it is load-bearing.
  this.assertMfaCombinationApplicable(
    logicalId,
    resourceType,
    poolName,
    properties,
    mfaConfiguration
  );

  // Tracks whether CreateUserPool succeeded this call, so the catch can roll
  // back a pool whose post-create MFA-config step (SetUserPoolMfaConfig)
  // failed — otherwise create() throws before returning the physicalId, the
  // deploy engine never learns the pool exists, and it orphans (mirrors the
  // DynamoDBTableProvider PITR/TTL post-create atomicity pattern).
  let createdUserPoolId: string | undefined;

  try {
    const createParams: CreateUserPoolCommandInput = {
      PoolName: poolName,
    };

    if (properties['AutoVerifiedAttributes']) {
      createParams.AutoVerifiedAttributes = properties[
        'AutoVerifiedAttributes'
      ] as VerifiedAttributeType[];
    }
    if (properties['UsernameAttributes']) {
      createParams.UsernameAttributes = properties['UsernameAttributes'] as UsernameAttributeType[];
    }
    if (properties['Policies']) {
      const sdkPolicies = this.toSdkUserPoolPolicies(
        properties['Policies'] as Record<string, unknown>
      );
      if (sdkPolicies) {
        createParams.Policies = sdkPolicies;
      }
    }
    if (properties['Schema']) {
      createParams.Schema = properties['Schema'] as SchemaAttributeType[];
    }
    if (properties['LambdaConfig']) {
      createParams.LambdaConfig = properties['LambdaConfig'] as LambdaConfigType;
    }
    // Only forward MfaConfiguration to CreateUserPool when NO MFA factor is
    // applied post-create. When factors are present, SetUserPoolMfaConfig
    // owns MfaConfiguration (and enables the factor in the same call) —
    // setting ON/OPTIONAL on CreateUserPool here would be rejected by AWS
    // ("SMS configuration and Auto verification for phone_number are required
    // when MFA is required/optional") because the factor is not yet enabled.
    if (mfaConfiguration && !hasMfaConfigProps(properties)) {
      createParams.MfaConfiguration = mfaConfiguration as UserPoolMfaType;
    }
    if (properties['UserPoolTags']) {
      createParams.UserPoolTags = properties['UserPoolTags'] as Record<string, string>;
    }
    if (properties['AdminCreateUserConfig']) {
      createParams.AdminCreateUserConfig = properties[
        'AdminCreateUserConfig'
      ] as AdminCreateUserConfigType;
    }
    if (properties['AccountRecoverySetting']) {
      createParams.AccountRecoverySetting = properties[
        'AccountRecoverySetting'
      ] as AccountRecoverySettingType;
    }
    if (properties['UserAttributeUpdateSettings']) {
      createParams.UserAttributeUpdateSettings = properties[
        'UserAttributeUpdateSettings'
      ] as UserAttributeUpdateSettingsType;
    }
    if (properties['DeletionProtection']) {
      createParams.DeletionProtection = properties['DeletionProtection'] as DeletionProtectionType;
    }
    if (properties['AliasAttributes']) {
      createParams.AliasAttributes = properties['AliasAttributes'] as AliasAttributeType[];
    }
    if (properties['EmailConfiguration']) {
      createParams.EmailConfiguration = properties['EmailConfiguration'] as EmailConfigurationType;
    }
    if (properties['SmsConfiguration']) {
      createParams.SmsConfiguration = properties['SmsConfiguration'] as SmsConfigurationType;
    }
    if (properties['VerificationMessageTemplate']) {
      createParams.VerificationMessageTemplate = properties[
        'VerificationMessageTemplate'
      ] as VerificationMessageTemplateType;
    }
    if (properties['UsernameConfiguration']) {
      createParams.UsernameConfiguration = properties[
        'UsernameConfiguration'
      ] as UsernameConfigurationType;
    }
    if (properties['DeviceConfiguration']) {
      createParams.DeviceConfiguration = properties[
        'DeviceConfiguration'
      ] as DeviceConfigurationType;
    }
    if (properties['UserPoolAddOns']) {
      createParams.UserPoolAddOns = properties['UserPoolAddOns'] as UserPoolAddOnsType;
    }
    if (properties['EmailVerificationMessage']) {
      createParams.EmailVerificationMessage = properties['EmailVerificationMessage'] as string;
    }
    if (properties['EmailVerificationSubject']) {
      createParams.EmailVerificationSubject = properties['EmailVerificationSubject'] as string;
    }
    if (properties['SmsAuthenticationMessage']) {
      createParams.SmsAuthenticationMessage = properties['SmsAuthenticationMessage'] as string;
    }
    if (properties['SmsVerificationMessage']) {
      createParams.SmsVerificationMessage = properties['SmsVerificationMessage'] as string;
    }
    if (properties['UserPoolTier']) {
      createParams.UserPoolTier = properties['UserPoolTier'] as UserPoolTierType;
    }
    if (properties['KeyConfiguration']) {
      createParams.KeyConfiguration = properties['KeyConfiguration'] as KeyConfigurationType;
    }
    if (properties['IssuerConfiguration']) {
      createParams.IssuerConfiguration = properties[
        'IssuerConfiguration'
      ] as IssuerConfigurationType;
    }

    // Issue #2080: when an earlier attempt at this create ended ambiguous,
    // name the pool it may have made BEFORE a second CreateUserPool is sent.
    // Detection only -- see `reportPossibleOrphanPools`.
    const orphanWindow = createUserPoolLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await this.reportPossibleOrphanPools(
        logicalId,
        poolName,
        orphanWindow,
        createMaskedLogSinks(this.logger, context?.maskSecrets)
      );
    }

    let created: CreateUserPoolCommandOutput;
    const attemptStartMs = Date.now();
    try {
      created = await this.getCreateClient().send(new CreateUserPoolCommand(createParams));
    } catch (error) {
      createUserPoolLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }
    const userPool: Pick<UserPoolType, 'Id' | 'Arn'> | undefined = created.UserPool;
    if (!userPool?.Id) {
      throw new Error('CreateUserPool did not return UserPool.Id');
    }

    const userPoolId = userPool.Id;
    createdUserPoolId = userPoolId;
    // go-to-k/cdkd#5511: report before the replay lookup and MFA wiring.
    reportCreatedResource(logicalId, resourceType, userPoolId);
    // Issue #4687: the SDK replayed this CreateUserPool inside its `send`, so
    // an earlier attempt may have made a pool too. Detection only, and before
    // the follow-up calls below, so a failure in one of them cannot skip it;
    // the returned pool is excluded from its own lookup. Excluded by id, NOT
    // added to the process set yet: a follow-up failure whose rollback fails
    // leaves this pool behind, and a later lookup must still name it.
    const replayWindow = replayedSendWindow(created, attemptStartMs);
    if (replayWindow !== undefined) {
      await this.reportPossibleOrphanPools(
        logicalId,
        poolName,
        replayWindow,
        createMaskedLogSinks(this.logger, context?.maskSecrets),
        userPoolId
      );
    }
    const userPoolArn = userPool.Arn;
    const region = await this.getClient().config.region();
    // Suffix DERIVED from the region, not hardcoded (issue #1745): outside the
    // commercial partition `amazonaws.com` names a host that does not resolve,
    // and the value is structurally valid so nothing downstream can catch it.
    const { urlSuffix } = derivePartitionAndUrlSuffix(region);
    const providerName = `cognito-idp.${region}.${urlSuffix}/${userPoolId}`;
    const providerUrl = `https://cognito-idp.${region}.${urlSuffix}/${userPoolId}`;

    // EnabledMfas / Email-OTP message+subject / WebAuthn config do NOT ride
    // on CreateUserPool — they go through the SetUserPoolMfaConfig
    // post-create control-plane API. Skip the extra call when none of them
    // are present.
    await this.applyMfaConfig(userPoolId, properties, mfaConfiguration, {
      // Issue #1932 item 3. Conditional spread because
      // `exactOptionalPropertyTypes` rejects an explicit `undefined` here.
      ...(context?.maskSecrets && { maskSecrets: context.maskSecrets }),
    });

    this.logger.debug(`Successfully created Cognito User Pool ${logicalId}: ${userPoolId}`);
    userPoolsCreatedByThisProcess.add(userPoolId);

    // Record what was SENT, not what the template declared, whenever the
    // guard substituted (see `narrowMfaConfiguration`). Reachable on create
    // only via the reverse-replacement replay -- a template-path create with
    // a refused value throws above -- plus the blank-string arm, which is
    // reachable from a template.
    const effectiveProperties = narrowMfaConfiguration(properties);

    return {
      physicalId: userPoolId,
      attributes: {
        Arn: userPoolArn,
        ProviderName: providerName,
        ProviderURL: providerUrl,
        UserPoolId: userPoolId,
      },
      ...(effectiveProperties !== properties ? { effectiveProperties } : {}),
    };
  } catch (error) {
    // Atomicity: if CreateUserPool succeeded but the post-create
    // SetUserPoolMfaConfig step failed, the pool exists but create() is
    // about to throw without returning its physicalId — the deploy engine
    // can't roll it back, so best-effort delete it here to avoid an orphan
    // pool + a name-collision on the next deploy attempt.
    let poolLeftBehind = false;
    if (createdUserPoolId) {
      // The pool itself was created: an "already exists" from here is an
      // auxiliary call's, not this pool's name collision (#3826).
      markAuxiliaryFailure(error, logicalId);
      try {
        await this.getClient().send(new DeleteUserPoolCommand({ UserPoolId: createdUserPoolId }));
        retractCreatedResource(logicalId, resourceType, createdUserPoolId);
        this.logger.debug(`Rolled back partially-created Cognito User Pool ${createdUserPoolId}`);
      } catch (rollbackError) {
        poolLeftBehind = true;
        // The class at warn, AWS's text at debug (go-to-k/cdkd#2319): a
        // denied DeleteUserPool names the caller's assumed-role ARN.
        const rollbackFailure = describeAwsFailure(rollbackError);
        if (rollbackFailure.redacted) {
          this.logger.debug(
            maskerOrIdentity(context?.maskSecrets)(
              `Rollback of partially-created Cognito User Pool ${createdUserPoolId} failed: ${rollbackFailure.detail}`
            )
          );
        }
        this.logger.warn(
          maskerOrIdentity(context?.maskSecrets)(
            `Failed to roll back partially-created Cognito User Pool ${createdUserPoolId}: ${rollbackFailure.summary}`
          )
        );
      }
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Cognito User Pool ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          poolName,
          cause
        )
    );
    // go-to-k/cdkd#4583: the rollback delete failed, so this pool has no state
    // record; name it for the failed-CREATE journal.
    if (poolLeftBehind && createdUserPoolId) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdUserPoolId);
      // go-to-k/cdkd#4945: terminal. CreateUserPool sends no name and no token, so the
      // engine's retry would make another pool while the journal names one.
      markNonRetryable(thrown);
    }
    throw thrown;
  }
}

/**
 * The ` --region <r>` fragment for a pasteable command, from the client the
 * call or lookup went through (issue #4307): without it the command runs in
 * the user's shell-default region, where it answers NotFound. An unreadable
 * region renders no fragment rather than failing the warning. Built with the
 * caller's `aws` tag, since a fragment from another tag withholds the command.
 */
export async function regionArg(
  this: CognitoUserPoolProvider,
  aws: ReturnType<typeof pasteableAwsCommand>
): Promise<ReturnType<ReturnType<typeof pasteableAwsCommand>>> {
  let region: string | undefined;
  try {
    region = await this.getClient().config.region();
  } catch {
    region = undefined;
  }
  return region ? aws` --region ${region}` : aws``;
}

/**
 * After an attempt at this create ended AMBIGUOUS (a 5xx: Cognito may have
 * made the pool and lost the answer), name the pools that could be its
 * orphan before a second `CreateUserPool` is sent (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080)). Detection only:
 * this never adopts and never deletes.
 *
 * A candidate is a pool with this exact name, created INSIDE the window of
 * the ambiguous attempt(s) -- from the earliest start to the latest end, each
 * widened by a skew margin (`AmbiguousCreateWindow`) -- that this process has
 * not already recorded.
 *
 * Why not adopt, even a pool whose name cdkd generated: pool names are
 * scoped to the account and region, but cdkd's stack lock is scoped to the
 * STATE bucket and prefix (`src/state/lock-manager.ts`), so two runs of the
 * same stack name against different state locations (or after a
 * `force-unlock`) can each create a pool with that exact name, inside this
 * window, from the same settings. Nothing distinguishes the other run's
 * empty pool from this run's orphan, and adopting it would point this
 * stack's updates, its `cdkd destroy` -- and the post-create rollback above,
 * which DELETES the pool on a later failure -- at another deploy's user
 * store. A cdkd nonce tag on the create was rejected as the attribution
 * channel: `UserPoolTags` is a template property read back for drift, a
 * failed untag leaves it behind, and a tag-restricting SCP or
 * `aws:RequestTag` condition could deny every create. An orphan costs
 * nothing while it has no users.
 *
 * The report leads with a READ command per candidate: it may be another
 * deploy's pool, so a delete command up front would hand the user the
 * mistake cdkd declines to make itself. Cognito allows duplicate names, so
 * after this attempt's create two pools with the name exist; the line says
 * so.
 *
 * A lookup that fails -- transiently or not -- warns and lets the create
 * proceed: nothing here adopts, so the lookup has no stake worth failing a
 * create over, and a missing `cognito-idp:ListUserPools` must not break a
 * deploy that works today.
 * `ListUserPools` is eventually consistent, so an empty result says only
 * what was listed.
 */
export async function reportPossibleOrphanPools(
  this: CognitoUserPoolProvider,
  logicalId: string,
  poolName: string,
  window: AmbiguousCreateWindow,
  log: MaskedLogSinks,
  returnedId?: string
): Promise<void> {
  const { value: v } = log;
  const since = new Date(window.floorMs).toISOString();
  const until = new Date(window.ceilingMs).toISOString();
  const lead = ambiguousAttemptLead('CreateUserPool', logicalId, window);
  const replayed = window.replayedInSend === true;

  const candidates: string[] = [];
  let truncated = false;
  try {
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const page = await this.getClient().send(
        new ListUserPoolsCommand({ MaxResults: 60, ...(nextToken && { NextToken: nextToken }) })
      );
      for (const pool of page.UserPools ?? []) {
        if (
          pool.Id &&
          pool.Name === poolName &&
          isInsideWindow(pool.CreationDate, window) &&
          pool.Id !== returnedId &&
          !userPoolsCreatedByThisProcess.has(pool.Id)
        ) {
          candidates.push(pool.Id);
        }
      }
      nextToken = page.NextToken;
      pages++;
    } while (nextToken && pages < MAX_USER_POOL_LIST_PAGES);
    truncated = nextToken !== undefined;
  } catch (error) {
    const failure = describeAwsFailure(error);
    log.debug(`ListUserPools failed with: ${v(failure.detail)}`);
    log.warn(
      `${lead}, so Cognito may have created a user pool named ${v(poolName)} that no cdkd state records, and cdkd could not look for it (ListUserPools: ${failure.summary}). ${replayed ? 'Check' : 'Creating a new pool; check'} for a pool of that name created between ${since} and ${until}.`
    );
    return;
  }
  const incomplete = truncated
    ? ` The search was incomplete: the pool list was cut at ${MAX_USER_POOL_LIST_PAGES} pages.`
    : '';

  if (candidates.length === 0) {
    const line = `No listed user pool named ${v(poolName)} was created between ${since} and ${until}, where the ${replayed ? 'replayed' : 'earlier ambiguous'} CreateUserPool attempt for ${logicalId} ran.${incomplete}`;
    if (truncated) {
      log.warn(line);
    } else {
      log.debug(line);
    }
    return;
  }

  const shown = candidates.slice(0, MAX_REPORTED_ORPHAN_POOLS);
  const aws = pasteableAwsCommand(log.mask);
  const region = await this.regionArg(aws);
  const inspect = shown
    .map((id) => aws`aws cognito-idp describe-user-pool --user-pool-id ${id}${region}`.render())
    .join(' ; ');
  const deletion = shown
    .map((id) => aws`aws cognito-idp delete-user-pool --user-pool-id ${id}${region}`.render())
    .join(' ; ');
  log.warn(
    `${lead}, and Cognito may have created a pool then that no cdkd state records. ${candidates.length} user pool(s) named ${v(poolName)} were created between ${since} and ${until}: ${shown.join(', ')}${candidates.length > shown.length ? ', ...' : ''}. cdkd does not adopt or delete them: a pool name does not prove which deploy created it. ${replayed ? `The pool the create returned and the candidate(s) above are ALL named ${v(poolName)}` : `Creating a new pool now, so the new pool and the candidate(s) above will ALL be named ${v(poolName)}`} -- Cognito allows duplicate names. First inspect each candidate (its user count, creation date and tags): ${inspect}. Only after confirming a pool is this deploy's orphan and not another deploy's, delete it: ${deletion}.${incomplete}`
  );
}
