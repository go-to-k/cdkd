import type {
  ResourceProvider,
  CreateContext,
  ResourceCreateResult,
  SecretMasker,
  UpdateContext,
  ResourceUpdateResult,
  ResourceNotFound,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';
import {
  CognitoIdentityProviderClient,
  type UserPoolType,
  type UserPoolPolicyType,
  type SetUserPoolMfaConfigCommandInput,
  type GetUserPoolMfaConfigCommandOutput,
  type SchemaAttributeType,
  type DeletionProtectionType,
} from '@aws-sdk/client-cognito-identity-provider';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { type ConsoleLogger, getLogger } from '../../utils/logger.js';
import {
  ProtectionFlipRegistry,
  type ProtectionFlipRecord,
} from './deletion-protection-compensation.js';
import { type MaskerFn, maskerOrIdentity, type MaskedLogSinks } from '../masked-retry-logger.js';
import type { ProvisioningError } from '../../utils/error-handler.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  wrapMaskedAwsError,
  relayedNameCollision,
  markRedactedCause,
} from '../../deployment/retryable-errors.js';
import { isAuxiliaryFailure } from '../auxiliary-failure.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries, type AmbiguousCreateWindow } from './ambiguous-create.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import type { DeclaredMfaConfigurationKind } from './cognito/mfa-request.js';
import type { DeleteContext } from '../region-check.js';
import {
  warnOnBlankMfaConfiguration,
  assertMfaCombinationApplicable,
  applyMfaConfig,
  reportMfaConfigurationOff,
  readLiveMfaConfiguration,
  readLiveAllowedFirstAuthFactors,
  readMfaFirstPrior,
  restoreMfaConfig,
  retryOnTransientControlPlane,
  turnOffRemovedMfa,
} from './cognito/mfa-apply.js';
import {
  canonicalizeDesiredProperties,
  readCurrentState,
  userPoolAttributes,
  importImpl,
} from './cognito/read-state.js';
import {
  toSdkUserPoolPolicies,
  create,
  regionArg,
  reportPossibleOrphanPools,
} from './cognito/create.js';
import {
  warnOnUnremovablePoliciesSubKeys,
  warnOnKeptRemovedMembers,
  update,
  untagRemovedUserPoolTags,
  reconcileSchemaCustomAttributes,
  replacementRemedy,
} from './cognito/update.js';
import {
  deleteImpl,
  reportSettingsResetByBareFlip,
  deleteOnce,
  sendEchoedDeletionProtection,
  disableUserPoolDeletionProtection,
  warnGuardLeftOn,
} from './cognito/delete.js';

export {
  USER_POOL_ECHO_MEMBERS,
  USER_POOL_KEPT_ON_OMISSION,
  userPoolDeletionProtectionUpdate,
  resetUserPoolCreateRetryStateForTests,
  echoesDeveloperEmail,
  REFUSED_ECHO_ERRORS,
  isTransientCognitoFailure,
  isRefusedEcho,
  createTimeOnlyChanges,
} from './cognito/shared.js';

/**
 * AWS Cognito User Pool Provider
 *
 * Implements resource provisioning for AWS::Cognito::UserPool using the Cognito SDK.
 * WHY: CreateUserPool is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class CognitoUserPoolProvider implements ResourceProvider {
  private cognitoClient?: CognitoIdentityProviderClient;
  private cognitoCreateClient?: CognitoIdentityProviderClient;
  private readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('CognitoUserPoolProvider');
  /** `--remove-protection` flips, keyed so a re-entered delete keeps them (#2204). */
  readonly protectionFlips = new ProtectionFlipRegistry();
  /**
   * The pre-flip read of a pool whose flip went out as the settings-resetting
   * bare write (#4066), keyed by the flip record so a re-entered attempt --
   * which reads the already-reset pool -- cannot overwrite it. The
   * compensation reads it to tell the user what the pool held.
   *
   * It is also the ONLY carrier of "the flip went out bare": `ambiguous: false`
   * means the bare write landed (the settings WERE reset, so a bare re-enable
   * loses nothing more); `ambiguous: true` means it got no clear answer.
   * `echoedSince` marks a definite record after which an ECHO flip landed: the
   * reset still happened and is still reported, but the pool may since hold
   * settings again, so it no longer licenses a bare re-enable.
   */
  readonly preFlipPools = new WeakMap<
    ProtectionFlipRecord,
    { readonly pool: UserPoolType; ambiguous: boolean; echoedSince?: boolean }
  >();

  /**
   * Flips whose flip-off went out WITHOUT the pool's `DEVELOPER` (SES)
   * `EmailConfiguration` and landed or may have landed, resetting it to
   * `COGNITO_DEFAULT` (#4149). If the delete then fails, the re-enable's
   * fresh read settles it and a pool left LIVE without its SES sender is
   * reported at ERROR, like a bare flip's reset. `definite`: the write
   * landed, so the sender is reset already and a re-enable re-sent without it
   * loses nothing more; `ambiguous`: it got no clear answer. A definite
   * record is never downgraded, and a later flip-off that lands WITH the SES
   * sender drops the record.
   */
  readonly emailOmittedFlips = new WeakMap<ProtectionFlipRecord, 'definite' | 'ambiguous'>();

  /**
   * The failure wrap the create / update / delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug` through the
   * operation's `maskSecrets` (`mask`), and the wrap is stamped
   * `markRedactedCause`, so the retry classifiers read the withheld text on the
   * `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}), except from an auxiliary call's failure
   * ({@link markAuxiliaryFailure}), where "it" would read as the pool. A
   * non-`Error` throw is withheld the same way, unstamped: it has no chain to
   * read. A cdkd-authored or transport error
   * keeps its text, masked and stamped when the mask changed it
   * (`wrapMaskedAwsError`), as the ASG wrap does. The delete checks
   * `ResourceNotFoundException` by type before it wraps, so no "already gone"
   * reading depends on AWS's wording.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: MaskerFn | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    const m = maskerOrIdentity(mask);
    if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
    this.logger.debug(m(build(m(failure.detail)).message));
    const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
    const wrapped = build(`${m(failure.summary)}${relay}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Cognito::UserPool',
      new Set([
        'UserPoolName',
        'AutoVerifiedAttributes',
        'UsernameAttributes',
        'AliasAttributes',
        'Policies',
        'Schema',
        'LambdaConfig',
        'MfaConfiguration',
        'UserPoolTags',
        'AdminCreateUserConfig',
        'AccountRecoverySetting',
        'UserAttributeUpdateSettings',
        'DeletionProtection',
        'EmailConfiguration',
        'SmsConfiguration',
        'VerificationMessageTemplate',
        'UsernameConfiguration',
        'DeviceConfiguration',
        'UserPoolAddOns',
        'EmailVerificationMessage',
        'EmailVerificationSubject',
        'SmsAuthenticationMessage',
        'SmsVerificationMessage',
        'UserPoolTier',
        'KeyConfiguration',
        'IssuerConfiguration',
        // Routed through the SetUserPoolMfaConfig control-plane API
        // (NOT CreateUserPool/UpdateUserPool) — see buildMfaConfigRequest.
        'EnabledMfas',
        'EmailAuthenticationMessage',
        'EmailAuthenticationSubject',
        'WebAuthnRelyingPartyID',
        'WebAuthnUserVerification',
        // Issue #2064: reachable since `WebAuthnConfigurationType` gained
        // `FactorConfiguration` (the SDK floor in package.json carries it).
        'WebAuthnFactorConfiguration',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>();

  warnOnBlankMfaConfiguration(raw: unknown): void {
    return warnOnBlankMfaConfiguration.call(this, raw);
  }

  assertMfaCombinationApplicable(
    logicalId: string,
    resourceType: string,
    target: string,
    properties: Record<string, unknown>,
    declaredMfaConfiguration: string,
    liveFirstAuthFactors?: readonly string[]
  ): void {
    return assertMfaCombinationApplicable.call(
      this,
      logicalId,
      resourceType,
      target,
      properties,
      declaredMfaConfiguration,
      liveFirstAuthFactors
    );
  }

  canonicalizeDesiredProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return canonicalizeDesiredProperties.call(this, resourceType, properties);
  }

  getClient(): CognitoIdentityProviderClient {
    if (!this.cognitoClient) {
      this.cognitoClient = new CognitoIdentityProviderClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.cognitoClient;
  }

  /**
   * The client `CreateUserPool` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #2080). Separate so every other call
   * keeps the full SDK retry.
   */
  getCreateClient(): CognitoIdentityProviderClient {
    if (!this.cognitoCreateClient) {
      this.cognitoCreateClient = withoutServerErrorRetries(
        new CognitoIdentityProviderClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.cognitoCreateClient;
  }

  toSdkUserPoolPolicies(policies: Record<string, unknown>): UserPoolPolicyType | undefined {
    return toSdkUserPoolPolicies.call(this, policies);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  regionArg(
    aws: ReturnType<typeof pasteableAwsCommand>
  ): Promise<ReturnType<ReturnType<typeof pasteableAwsCommand>>> {
    return regionArg.call(this, aws);
  }

  reportPossibleOrphanPools(
    logicalId: string,
    poolName: string,
    window: AmbiguousCreateWindow,
    log: MaskedLogSinks,
    returnedId?: string
  ): Promise<void> {
    return reportPossibleOrphanPools.call(this, logicalId, poolName, window, log, returnedId);
  }

  applyMfaConfig(
    physicalId: string,
    properties: Record<string, unknown>,
    declaredMfaConfiguration: string,
    options: {
      liveMfaConfiguration?: string;
      liveReadFailed?: boolean;
      declaredKind?: DeclaredMfaConfigurationKind;
      maskSecrets?: SecretMasker;
    } = {}
  ): Promise<void> {
    return applyMfaConfig.call(this, physicalId, properties, declaredMfaConfiguration, options);
  }

  reportMfaConfigurationOff(
    physicalId: string,
    request: SetUserPoolMfaConfigCommandInput,
    declaredMfaConfiguration: string,
    options: {
      liveMfaConfiguration?: string;
      liveReadFailed?: boolean;
      declaredKind?: DeclaredMfaConfigurationKind;
    }
  ): void {
    return reportMfaConfigurationOff.call(
      this,
      physicalId,
      request,
      declaredMfaConfiguration,
      options
    );
  }

  readLiveMfaConfiguration(physicalId: string): Promise<{ value?: string; failed: boolean }> {
    return readLiveMfaConfiguration.call(this, physicalId);
  }

  readLiveAllowedFirstAuthFactors(physicalId: string): Promise<readonly string[] | undefined> {
    return readLiveAllowedFirstAuthFactors.call(this, physicalId);
  }

  readMfaFirstPrior(physicalId: string): Promise<GetUserPoolMfaConfigCommandOutput | undefined> {
    return readMfaFirstPrior.call(this, physicalId);
  }

  restoreMfaConfig(physicalId: string, prior: GetUserPoolMfaConfigCommandOutput): Promise<void> {
    return restoreMfaConfig.call(this, physicalId, prior);
  }

  retryOnTransientControlPlane<T>(
    fn: () => Promise<T>,
    label: string,
    maxAttempts = 3
  ): Promise<T> {
    return (retryOnTransientControlPlane<T>).call(this, fn, label, maxAttempts);
  }

  warnOnUnremovablePoliciesSubKeys(
    physicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): void {
    return warnOnUnremovablePoliciesSubKeys.call(this, physicalId, properties, previousProperties);
  }

  warnOnKeptRemovedMembers(
    logicalId: string,
    physicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): void {
    return warnOnKeptRemovedMembers.call(
      this,
      logicalId,
      physicalId,
      properties,
      previousProperties
    );
  }

  turnOffRemovedMfa(
    logicalId: string,
    physicalId: string,
    previousMfaConfiguration: string
  ): Promise<void> {
    return turnOffRemovedMfa.call(this, logicalId, physicalId, previousMfaConfiguration);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  untagRemovedUserPoolTags(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    poolArn: string | undefined,
    desiredTags: unknown,
    previousTags: unknown
  ): Promise<void> {
    return untagRemovedUserPoolTags.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      poolArn,
      desiredTags,
      previousTags
    );
  }

  reconcileSchemaCustomAttributes(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    newSchema: SchemaAttributeType[] | undefined,
    oldSchema: SchemaAttributeType[] | undefined,
    deletionProtected = false
  ): Promise<void> {
    return reconcileSchemaCustomAttributes.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      newSchema,
      oldSchema,
      deletionProtected
    );
  }

  replacementRemedy(physicalId: string, deletionProtected: boolean): string {
    return replacementRemedy.call(this, physicalId, deletionProtected);
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  reportSettingsResetByBareFlip(
    physicalId: string,
    before: UserPoolType,
    kind: 'reset' | 'earlier' | 'unclear',
    mask: MaskerFn
  ): void {
    return reportSettingsResetByBareFlip.call(this, physicalId, before, kind, mask);
  }

  deleteOnce(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    flip: ProtectionFlipRecord
  ): Promise<void> {
    return deleteOnce.call(this, logicalId, physicalId, resourceType, context, flip);
  }

  sendEchoedDeletionProtection(
    physicalId: string,
    pool: UserPoolType,
    value: DeletionProtectionType,
    opts: { readonly emailFallback?: boolean; readonly mask?: MaskerFn } = {}
  ): Promise<'echoed' | 'without-email'> {
    return sendEchoedDeletionProtection.call(this, physicalId, pool, value, opts);
  }

  disableUserPoolDeletionProtection(
    physicalId: string,
    pool: UserPoolType,
    flip: ProtectionFlipRecord,
    mask: MaskerFn
  ): Promise<void> {
    return disableUserPoolDeletionProtection.call(this, physicalId, pool, flip, mask);
  }

  warnGuardLeftOn(
    physicalId: string,
    pool: UserPoolType,
    mask: MaskerFn,
    error: unknown,
    echoError?: unknown
  ): void {
    return warnGuardLeftOn.call(this, physicalId, pool, mask, error, echoError);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType);
  }

  userPoolAttributes(
    userPoolId: string,
    arn: string | undefined
  ): Promise<Record<string, unknown>> {
    return userPoolAttributes.call(this, userPoolId, arn);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
