import { getLogger } from '../../../utils/logger.js';
import { setContainerRegion } from '../../../local/local-aws-wiring.js';
import { describeLocalAwsFailureForWarn } from '../../../utils/local-aws-failure.js';
import { displayIdent, ROLE_ARN_MAX_CODE_POINTS, safeMsg } from '../../../utils/display-safe.js';
import { quotedOrDescribed, shellBoundedDisplay } from '../../../utils/pasteable-command.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import {
  assertSendableRoleArn,
  explicitRoleArnOrThrow,
  isIamRoleArn,
  sendableAssumeRoleCommand,
} from '../../../utils/role-arn.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { readCdkPathOrUndefined } from '../../cdk-path.js';
import type { LocalStateProvider, LocalStateRecord } from 'cdk-local';
import { getEmbedConfig } from 'cdk-local';
import {
  type DynamicReferenceResolver,
  firstUsableRegion,
  keysNotFromTemplate,
  keysOverriddenBy,
  resolveDynamicReferencesInEnv,
  withoutKeys,
} from 'cdk-local/internal';
import { createCallerDynamicReferenceResolver } from '../../../local/dynamic-reference.js';
import { type ResolvedAgentCoreRuntime } from '../../../local/agentcore-resolver.js';
import { resolveEnvVars } from '../../../local/env-resolver.js';
import {
  substituteEnvVarsFromStateAsync,
  type SubstitutionContext,
} from '../../../local/state-resolver.js';
import {
  derivePseudoParametersFromRegion,
  type ImageResolutionContext,
} from '../../../local/intrinsic-image.js';
import {
  applyProfileCredentialsOverlay,
  resolveExecutionRoleArnFromState,
} from '../local-invoke.js';
import { type ProfileCredentialsFile } from '../local-profile-credentials-file.js';
import { awsClientDefaults } from '../../../utils/aws-client-defaults.js';
import {
  applyCallerIdentityCredentials,
  AWS_CREDENTIAL_ENV_KEYS,
} from '../../../utils/caller-credentials.js';
import { readEnvOverridesFile } from './event-input.js';
import type { LocalInvokeAgentCoreOptions } from './types.js';

/**
 * Build the container env + the set of env keys to keep off the `docker run`
 * argv. Substitutes `--from-cfn-stack` state into the template env (reusing the
 * shared state load + image-resolution context — Ref / Fn::Sub / Fn::Join +
 * SSM parameters, with decrypted SecureString values flagged sensitive),
 * applies `--env-vars` overrides, then injects AWS credentials (`--assume-role`
 * STS temp creds — resolving an intrinsic RoleArn from state for bare
 * `--assume-role` — else `--profile` / dev creds).
 *
 * The state provider + loaded record + image context are built once by the
 * caller and shared here, so this does not re-load state.
 *
 * CloudFormation dynamic references (`{{resolve:...}}`) are resolved locally
 * before the container starts (issue #2056, go-to-k/cdk-local#784): a
 * same-stack env value, and a cross-stack value whose producer output cdkd
 * persisted REDACTED back to its token. Mirrors cdk-local's own AgentCore
 * `buildContainerEnv`, with the same `cdk-local/internal` helpers.
 */
export async function buildContainerEnv(
  resolved: ResolvedAgentCoreRuntime,
  options: LocalInvokeAgentCoreOptions,
  profileCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined,
  profileCredsFile: ProfileCredentialsFile | undefined,
  stateProvider: LocalStateProvider | undefined,
  loaded: LocalStateRecord | undefined,
  imageContext: ImageResolutionContext | undefined
): Promise<{ env: Record<string, string>; sensitiveEnvKeys: Set<string> }> {
  // One resolver per container env, shared by the cross-stack boundary and
  // the final env pass, so each (reference, region) is fetched once.
  const dynamicRefs = createCallerDynamicReferenceResolver(options.profile);
  try {
    return await buildContainerEnvWith(
      resolved,
      options,
      profileCredentials,
      profileCredsFile,
      stateProvider,
      loaded,
      imageContext,
      dynamicRefs
    );
  } finally {
    dynamicRefs.dispose();
  }
}

async function buildContainerEnvWith(
  resolved: ResolvedAgentCoreRuntime,
  options: LocalInvokeAgentCoreOptions,
  profileCredentials:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    | undefined,
  profileCredsFile: ProfileCredentialsFile | undefined,
  stateProvider: LocalStateProvider | undefined,
  loaded: LocalStateRecord | undefined,
  imageContext: ImageResolutionContext | undefined,
  dynamicRefs: DynamicReferenceResolver
): Promise<{ env: Record<string, string>; sensitiveEnvKeys: Set<string> }> {
  const logger = getLogger();
  const overrides = readEnvOverridesFile(options.envVars);
  const cdkPath = readCdkPathOrUndefined(resolved.resource);
  // Keys an `--env-vars` override replaces never reach state substitution, so
  // an override also skips a cross-stack dynamic-reference lookup.
  const overriddenKeys = keysOverriddenBy(
    resolved.environmentVariables,
    (env) => resolveEnvVars(resolved.logicalId, cdkPath, env, overrides).resolved
  );
  let templateEnv: Record<string, unknown> = withoutKeys(
    resolved.environmentVariables,
    overriddenKeys
  );
  const sensitiveEnvKeys = new Set<string>();

  if (stateProvider && loaded) {
    const subContext: SubstitutionContext = {
      resources: imageContext?.stateResources ?? loaded.resources,
      consumerRegion: loaded.region,
      // A cross-stack value carrying a token is resolved at the boundary,
      // against the PRODUCER's region; the key then lands in `sensitiveKeys`.
      resolveDynamicReferences: (value, producerRegion) =>
        dynamicRefs.resolveString(value, {
          region: producerRegion,
          consumer: `AgentCore Runtime ${resolved.logicalId} cross-stack env value`,
        }),
    };
    const pseudo =
      imageContext?.pseudoParameters ?? derivePseudoParametersFromRegion(loaded.region);
    if (pseudo) subContext.pseudoParameters = pseudo;
    if (imageContext?.stateParameters) subContext.parameters = imageContext.stateParameters;
    if (imageContext?.stateSensitiveParameters?.length) {
      subContext.sensitiveParameters = new Set(imageContext.stateSensitiveParameters);
    }
    const resolver = await stateProvider.buildCrossStackResolver(loaded.region);
    if (resolver) subContext.crossStackResolver = resolver;
    const { env, audit } = await substituteEnvVarsFromStateAsync(templateEnv, subContext);
    templateEnv = env;
    for (const key of audit.resolvedKeys) {
      logger.debug(`${stateProvider.label}: substituted env var ${key}`);
    }
    // Decrypted SecureString SSM values and values resolved at the cross-stack
    // boundary: keep them off the `docker run` argv.
    for (const key of audit.sensitiveKeys) sensitiveEnvKeys.add(key);
    for (const { key, reason } of audit.unresolved) {
      logger.warn(
        `${stateProvider.label}: could not substitute env var ${key} (${reason}). ` +
          `Override it via --env-vars or it will be dropped.`
      );
    }
  }

  const envResult = resolveEnvVars(resolved.logicalId, cdkPath, templateEnv, overrides);
  for (const key of envResult.unresolved) {
    const overrideKeyExample = cdkPath?.replace(/\/Resource$/, '') ?? resolved.logicalId;
    logger.warn(
      `Environment variable ${key} contains a CloudFormation intrinsic and was dropped. ` +
        `Override it with --env-vars (e.g. {"${overrideKeyExample}":{"${key}":"<literal>"}}), ` +
        `or pass a state-source flag (e.g. --from-cfn-stack) to recover deployed values.`
    );
  }

  // Same-stack dynamic references, against the region of the stack owning
  // the runtime. Plaintext keys (the `sensitiveKeys` above) and `--env-vars`
  // overrides are left as they are; a failed lookup throws before boot.
  const skipKeys = keysNotFromTemplate(templateEnv, envResult.resolved);
  for (const key of sensitiveEnvKeys) skipKeys.add(key);
  const dynamic = await resolveDynamicReferencesInEnv(envResult.resolved, {
    region: firstUsableRegion(
      loaded?.region,
      options.stackRegion,
      resolved.stack.region,
      options.region
    ),
    label: `AgentCore Runtime ${resolved.logicalId}`,
    skipKeys,
    resolver: dynamicRefs,
  });
  for (const key of dynamic.resolvedKeys) sensitiveEnvKeys.add(key);

  const dockerEnv: Record<string, string> = { ...dynamic.env };
  const assumeRoleArn = resolveAssumeRoleArn(options, resolved, loaded);
  await applyAgentCoreCredentialEnv(dockerEnv, {
    ...(assumeRoleArn !== undefined && { assumeRoleArn }),
    ...(options.region !== undefined && { region: options.region }),
    ...(profileCredentials !== undefined && { profileCredentials }),
    ...(profileCredsFile !== undefined && {
      profileCredsFile: {
        containerPath: profileCredsFile.containerPath,
        profileName: profileCredsFile.profileName,
      },
    }),
  });
  return { env: dockerEnv, sensitiveEnvKeys };
}

/**
 * STS `GetCallerIdentity` for the `${AWS::AccountId}` pseudo parameter
 * (threads `--profile`). The account follows where the stack was read (issue
 * go-to-k/cdkd#5001): the caller's own under `--from-cfn-stack`, the DEPLOY
 * account (the `--role-arn` role's) under `--from-state` or with no state source.
 */
export async function resolveStackAccountId(
  region: string | undefined,
  profile: string | undefined,
  fromState: boolean,
  fromCfnStack: string | boolean | undefined
): Promise<string | undefined> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  let sts: InstanceType<typeof STSClient>;
  if (!fromState && fromCfnStack !== undefined && fromCfnStack !== false) {
    // `ignoreAssumedRole` -- under `--from-cfn-stack` the stack is read as the CALLER and
    // CloudFormation sees only the caller's own account, so `${AWS::AccountId}` is the
    // caller's, never a `--role-arn` assumed for cdkd's own calls (go-to-k/cdkd#5001).
    sts = new STSClient({
      ...awsClientDefaults({ profile, ignoreAssumedRole: true }),
      ...(region && { region }),
      ...(profile && { profile }),
    });
  } else {
    // cdkd-local-role-identity: `--from-state` read the state record as the `--role-arn` role
    // when one is published (go-to-k/cdkd#3230), and with no state source the stack is the one
    // deployed there, so `${AWS::AccountId}` is the DEPLOY account: asked through
    // `awsClientDefaults` as that role (go-to-k/cdkd#5001). Only the account ID is taken; no
    // credential reaches the emulated agent.
    sts = new STSClient({
      ...awsClientDefaults({ profile }),
      ...(region && { region }),
      ...(profile && { profile }),
    });
  }
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return identity.Account;
  } finally {
    sts.destroy();
  }
}

/**
 * Inject AWS credentials into the container env. Precedence:
 *   1. `--assume-role` → STS-issued temp creds for the resolved ARN (on
 *      STS failure, warn + fall through to dev creds).
 *   2. dev shell creds (`forwardAwsEnv`) + `--profile` overlay
 *      ({@link applyProfileCredentialsOverlay}) + the bind-mounted
 *      credentials-file env so handler `fromIni({ profile })` resolves.
 *
 * Exported so a unit test can lock the binding (mock STS) without driving
 * the full synth + docker pipeline.
 */
export async function applyAgentCoreCredentialEnv(
  dockerEnv: Record<string, string>,
  args: {
    assumeRoleArn?: string;
    region?: string;
    profileCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    profileCredsFile?: { containerPath: string; profileName: string };
  }
): Promise<void> {
  const logger = getLogger();
  let assumeSucceeded = false;
  if (args.assumeRoleArn) {
    // FOURTH chain, and the one that escapes the handler-entry fold entirely:
    // `args.region` is this helper's own parameter, so `--assume-role` with
    // `AWS_REGION=CN-NORTH-1` and no `--region` handed the raw value BOTH to
    // the AssumeRole STS client below and to the container's own `AWS_REGION`.
    const stsRegion = canonicalizeRegion(
      args.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION']
    );
    try {
      const creds = await assumeAgentCoreExecutionRole(args.assumeRoleArn, stsRegion);
      // cdkd-local-env-identity: `--assume-role`'s own STS hop — the flag whose
      // entire job is to choose the emulated agent's identity. Its STS client
      // opts out of the `--role-arn` role, so the hop is answered by the caller.
      dockerEnv['AWS_ACCESS_KEY_ID'] = creds.accessKeyId;
      dockerEnv['AWS_SECRET_ACCESS_KEY'] = creds.secretAccessKey;
      dockerEnv['AWS_SESSION_TOKEN'] = creds.sessionToken;
      setContainerRegion(dockerEnv, stsRegion);
      assumeSucceeded = true;
    } catch (err) {
      logger.warn(
        `--assume-role: STS AssumeRole(${displayIdent(args.assumeRoleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) failed: ${describeLocalAwsFailureForWarn(err, 'STS AssumeRole')}. ` +
          "Falling back to the developer's shell credentials."
      );
    }
  }
  if (!assumeSucceeded) {
    forwardAwsEnv(dockerEnv);
    // The same chain as the `--assume-role` arm: `--region` wins over the
    // forwarded host region, written to both region variables.
    setContainerRegion(
      dockerEnv,
      canonicalizeRegion(
        args.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION']
      )
    );
    applyProfileCredentialsOverlay(dockerEnv, args.profileCredentials, false);
    if (args.profileCredsFile) {
      dockerEnv['AWS_SHARED_CREDENTIALS_FILE'] = args.profileCredsFile.containerPath;
      dockerEnv['AWS_PROFILE'] = args.profileCredsFile.profileName;
    }
  }
}

/**
 * The `--assume-role: STS AssumeRole(...) failed` warning, for the two sites
 * that emit the FALLBACK form of it — the `--sigv4` signing path and the fromS3 bundle download.
 *
 * ONE builder rather than two near-identical template literals, and that is
 * go-to-k/cdkd#3390's test review rather than tidiness. The two were twins, and
 * a twin is where a sanitizing rule goes half-applied: dropping `displayIdent`
 * from the fromS3 copy alone reddened only the source-shape fence, because the
 * `--sigv4` copy was the one with a behavioural case. As one PURE function both
 * sites inherit whatever this is tested to do, and there is one subject to test
 * rather than a second one somebody has to remember exists.
 *
 * TWO untrusted values, and both take `displayIdent` (issue
 * [#3377](https://github.com/go-to-k/cdkd/issues/3377) for the first, this PR's
 * security review for the second):
 *
 * - `profile` is user-supplied argv, and `ConsoleLogger.formatMessage`
 *   sanitizes only a call's EXTRA ARGS, never the message itself — so the
 *   message text is the last place it can be made safe. A MESSAGE, not a
 *   command to paste, so `displayIdent` and not `isPasteableIdent`;
 *   `resolveProfileCredentials` in `local-start-api.ts` is the site that needs
 *   both spellings and shows the difference.
 * - `assumeRoleArn` is the WIDER boundary of the two, which is why it is here
 *   at all: nothing validates it before `assumeAgentCoreExecutionRole` (whose
 *   own throw lands in the very `catch` that calls this), and
 *   `resolveAssumeRoleArn` can source it from a DEPLOYED STATE RECORD rather
 *   than from argv. Every character of a legitimate ARN is in `PLAIN_IDENT`, so
 *   it renders bare exactly as before. cdk-local's twin of this line flattens
 *   the same value for the same reason; cdkd had nothing.
 *
 * `error` takes `describeLocalAwsFailureForWarn` (go-to-k/cdkd#2300): a
 * modeled STS exception keeps its message, flattened and capped, and any other
 * failure is withheld to its class with the text at `debug`. It ends in
 * `displaySafe` — the DENYLIST, since an SDK error message is free-form text
 * rather than an identifier, which is the line `display-safe.ts`'s header
 * draws. The first cut stringified it and sanitized
 * NOTHING, and go-to-k/cdkd#3390's round-2 security review showed that was the
 * hole the other two guards leave open: STS answers an unparseable RoleArn with
 * a `ValidationError` that ECHOES THE SUBMITTED VALUE VERBATIM, so the
 * attacker-controlled ARN comes back through the error string and lands on the
 * same line the `displayIdent` two expressions to its left was added to
 * protect. A C1 byte, `U+0085`, `U+2028` and the bidi overrides all survive an
 * XML 1.0 response body. `formatError` sanitizes a `cause` for exactly this
 * reason and cannot help here, because this is a logger MESSAGE and
 * `ConsoleLogger.formatMessage` sanitizes only a call's EXTRA ARGS.
 */
export function assumeRoleFallbackWarning(args: {
  assumeRoleArn: string;
  purpose: string;
  error: unknown;
  profile: string | undefined;
  fallbackWithoutProfile: string;
}): string {
  const fallback = args.profile
    ? `--profile ${displayIdent(args.profile)}`
    : args.fallbackWithoutProfile;
  return (
    // cdkd-raw-beside-safe: `args.purpose` is a CALLER LITERAL -- this
    // function has two call sites and each passes a fixed string
    // (`'--sigv4 signing'` / `'the fromS3 bundle download'`). No argv and no
    // remote value reaches it, so it is the one operand on this line that
    // cannot carry anything. The other two both take a helper.
    `--assume-role: STS AssumeRole(${displayIdent(args.assumeRoleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) failed for ` +
    `${args.purpose}: ${describeLocalAwsFailureForWarn(args.error, 'STS AssumeRole')}. ` +
    `Falling back to ${fallback}.`
  );
}

/**
 * Resolve the role ARN to assume, honoring the three `--assume-role` forms.
 * Bare `--assume-role` uses the runtime's literal `RoleArn`; when that is an
 * intrinsic (the common L2 case — `Fn::GetAtt` to an auto-created role) it
 * resolves the execution-role ARN from `--from-cfn-stack` state, and only
 * warns + falls back to dev creds when neither is available.
 */
export function resolveAssumeRoleArn(
  options: LocalInvokeAgentCoreOptions,
  resolved: ResolvedAgentCoreRuntime,
  loaded: LocalStateRecord | undefined
): string | undefined {
  // One run asks this up to three times (`--sigv4`, the fromS3 download, the
  // container env), and each ask used to re-emit its warnings. Memoized on the
  // run's own `resolved` object, and only for the same `options` / `loaded`.
  const hit = assumeRoleResolutionMemo.get(resolved);
  if (hit && hit.options === options && hit.loaded === loaded) return hit.value;
  const value = resolveAssumeRoleArnUncached(options, resolved, loaded);
  assumeRoleResolutionMemo.set(resolved, { options, loaded, value });
  return value;
}

const assumeRoleResolutionMemo = new WeakMap<
  ResolvedAgentCoreRuntime,
  {
    options: LocalInvokeAgentCoreOptions;
    loaded: LocalStateRecord | undefined;
    value: string | undefined;
  }
>();

function resolveAssumeRoleArnUncached(
  options: LocalInvokeAgentCoreOptions,
  resolved: ResolvedAgentCoreRuntime,
  loaded: LocalStateRecord | undefined
): string | undefined {
  // Issue #2348: a malformed explicit ARN is a HARD error rather than a send
  // that fails and quietly falls back to the developer's shell credentials;
  // a malformed template `RoleArn` is warned about and the state lookup runs.
  if (typeof options.assumeRole === 'string') {
    return explicitRoleArnOrThrow(
      '--assume-role',
      options.assumeRole,
      (message) => new CdkdError(message, 'LOCAL_INVOKE_AGENTCORE_ASSUME_ROLE_INVALID')
    );
  }
  if (options.assumeRole === true) {
    if (resolved.roleArn !== undefined && isIamRoleArn(resolved.roleArn)) return resolved.roleArn;
    if (resolved.roleArn?.startsWith('arn:')) {
      // The logical id is quoted only when it is a plain identifier: a `'` in
      // it would close a hand-written quote (go-to-k/cdkd#3950).
      getLogger().warn(
        safeMsg`--assume-role: the template RoleArn for ${quotedOrDescribed(resolved.logicalId, 'logical id')} is not a well-formed IAM role ARN: ` +
          safeMsg`${shellBoundedDisplay(displayIdent(resolved.roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS }))}. Ignoring it.`
      );
    }
    if (loaded) {
      const fromState = resolveExecutionRoleArnFromState(loaded, resolved.logicalId, 'RoleArn');
      if (fromState) {
        getLogger().debug(
          safeMsg`--assume-role: resolved RoleArn from state: ${shellBoundedDisplay(displayIdent(fromState, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS }))}`
        );
        return fromState;
      }
    }
    getLogger().warn(
      "--assume-role passed without an ARN, but the runtime's RoleArn is not a literal ARN in the template " +
        (loaded
          ? 'and could not be resolved from the deployed stack state. '
          : 'and no --from-cfn-stack state is available to resolve it. ') +
        "Pass the ARN explicitly: --assume-role '<arn>'. " +
        "Falling back to the developer's shell credentials."
    );
  }
  return undefined;
}

/**
 * Copy the developer's AWS credentials + region into the container env for the
 * DEFAULT (no `--assume-role`) path.
 *
 * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836): the two REGION
 * entries are folded through `canonicalizeRegion` on the way in; the credentials
 * are copied verbatim (an AKID / session token is case-SENSITIVE, so lower-casing
 * the whole pass-through list would corrupt every one of them). The value lands
 * in the container's own `AWS_REGION`, i.e. in every SDK client the agent builds,
 * and SDK endpoint resolution is case-SENSITIVE (`CN-NORTH-1` resolves the
 * COMMERCIAL partition).
 *
 * Folding only inside `applyAgentCoreCredentialEnv`'s assume-role arm — which is
 * where issue #1814 stopped, and what round 3 of the #1836 review found still
 * open here after the same gap was closed in `local-invoke.ts` — made ONE command
 * yield two different container regions for the same shell: `cn-north-1` with
 * `--assume-role`, `CN-NORTH-1` without.
 *
 * Exported for unit-test isolation (`local-container-caller-identity.test.ts`),
 * which drives the `--role-arn` cases without the image + docker pipeline.
 */
export function forwardAwsEnv(env: Record<string, string>): void {
  // The credential triple comes from `AWS_CREDENTIAL_ENV_KEYS` rather than a
  // local copy so this site and the fence that watches it cannot disagree about
  // the population (issue #3250 item 4 — the constant documented that guarantee
  // while nothing imported it). The two region keys are this command's own
  // concern and stay here.
  const passThrough = [...AWS_CREDENTIAL_ENV_KEYS, 'AWS_REGION', 'AWS_DEFAULT_REGION'] as const;
  const regionKeys = new Set<string>(['AWS_REGION', 'AWS_DEFAULT_REGION']);
  for (const key of passThrough) {
    const value = process.env[key];
    if (value === undefined) continue;
    env[key] = regionKeys.has(key) ? canonicalizeRegion(value) : value;
  }
  // Issue #3130: `applyRoleArnIfSet` OVERWRITES the three credential variables
  // above with a `--role-arn` assumed role's, so the copy that just ran would
  // hand the emulated agent cdkd's deploy role. Put the caller's own identity
  // back (or strip the triple when there was none to restore). A no-op when no
  // role was assumed.
  applyCallerIdentityCredentials(env);
}

export async function assumeAgentCoreExecutionRole(
  roleArn: string,
  region: string | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  // A `CdkdError`, so the STS-failure warn this lands in prints its remedy
  // rather than withholding it (go-to-k/cdkd#2300).
  assertSendableRoleArn(
    roleArn,
    (m) => new CdkdError(m, 'LOCAL_INVOKE_AGENTCORE_ASSUME_ROLE_INVALID')
  );
  const { STSClient } = await import('@aws-sdk/client-sts');
  // `ignoreAssumedRole` -- this resolves the execution role's credentials, injected into the container,
  // so it must be the caller's own identity, never a `--role-arn` assumed
  // for cdkd's own calls. See that option's JSDoc.
  const sts = new STSClient({
    ...awsClientDefaults({ ignoreAssumedRole: true }),
    ...(region && { region }),
  });
  try {
    const response = await sts.send(
      sendableAssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `${getEmbedConfig().resourceNamePrefix}-invoke-agentcore-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new CdkdError(
        `AssumeRole(${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}) returned no usable credentials.`,
        'LOCAL_INVOKE_AGENTCORE_ASSUMEROLE_NO_CREDS'
      );
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } finally {
    sts.destroy();
  }
}
