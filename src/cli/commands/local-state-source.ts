/**
 * Single-source-of-truth helper that picks a {@link LocalStateProvider}
 * for the `cdkd local *` family from CLI flags (issue #606).
 *
 * The four `cdkd local *` commands all support two mutually-exclusive
 * state-source flags:
 *
 *   - `--from-state` (S3-backed; reads cdkd's state for a stack
 *     deployed via `cdkd deploy`). cdkd-specific.
 *   - `--from-cfn-stack [<cfn-stack-name>]` (CFn-backed; reads a
 *     deployed CloudFormation stack via `ListStackResources`).
 *     Inherited from `cdk-local`.
 *
 * This module is a thin shim around `cdk-local`'s state-source
 * dispatcher: it re-exports the shared helpers verbatim and adds a
 * cdkd-specific `createLocalStateProvider` that injects the
 * S3-backed `--from-state` factory via `cdk-local`'s
 * `extraStateProviders` hook.
 *
 * It also owns the `--role-arn` identity of what the engine reads for a
 * workload (issue [#3240](https://github.com/go-to-k/cdkd/issues/3240)):
 * {@link bindCallerIdentityClients} keeps `--from-cfn-stack` on the caller for
 * the four commands that call {@link createLocalStateProvider}, and
 * {@link warnEngineRoleExposure} warns on the four engine commands that cannot
 * be fixed from here.
 */

import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SSMClient } from '@aws-sdk/client-ssm';
import type { Command } from 'commander';
import {
  CfnLocalStateProvider as CfnLocalStateProviderBase,
  createLocalStateProvider as createLocalStateProviderBase,
  isCfnFlagPresent as isCfnFlagPresentBase,
  type ExtraStateProviders,
  type LocalStateProvider,
  type LocalStateProviderFactory,
  type LocalStateSourceOptions as LocalStateSourceOptionsBase,
} from 'cdk-local';
import { S3LocalStateProvider } from '../../local/s3-local-state-provider.js';
import { awsClientDefaults, getAssumedRoleCredentials } from '../../utils/aws-client-defaults.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { getLogger } from '../../utils/logger.js';
import { isIamRoleArn } from '../../utils/role-arn.js';

export {
  CfnLocalStateProvider,
  type CfnLocalStateProviderOptions,
  type ExtraStateProviders,
  isCfnFlagPresent,
  LocalStateSourceError,
  type LocalStateProvider,
  type LocalStateProviderFactory,
  type LocalStateRecord,
  rejectExplicitCfnStackWithMultipleStacks,
  resolveCfnFallbackRegion,
  resolveCfnRegion,
  resolveCfnStackName,
} from 'cdk-local';

/**
 * Options the four `cdkd local *` commands gather from their flag set.
 *
 * Declared as a closed shape (no `[key: string]: unknown` index
 * signature inherited from cdk-local) so the existing command-option
 * interfaces (`LocalInvokeOptions` / `LocalStartApiOptions` / etc.)
 * stay assignable without each one needing to open up its own index
 * signature. The cdk-local boundary requires the index signature for
 * host extensibility; the shim's `createLocalStateProvider` performs
 * the (semantically safe) cast at the boundary.
 */
export interface LocalStateSourceOptions {
  /** True when `--from-state` was passed. */
  fromState: boolean;
  /** S3 bucket for `--from-state`. */
  stateBucket?: string;
  /** S3 key prefix for `--from-state`; commander always supplies the default. */
  statePrefix: string;
  /**
   * `--from-cfn-stack` flag value. Commander maps:
   *   - flag absent → `undefined`
   *   - `--from-cfn-stack` (bare) → `true`
   *   - `--from-cfn-stack <name>` → `'<name>'`
   */
  fromCfnStack?: string | boolean;
  /** Inherited `--region`. */
  region?: string;
  /** Inherited `--profile`. */
  profile?: string;
  /**
   * Inherited `--stack-region`. Used by `--from-state` (multi-region
   * disambiguation) AND by `--from-cfn-stack` (the CFn client's
   * region). When unset for `--from-cfn-stack`, the helper falls back
   * to `--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` > the
   * synth-derived stack region.
   */
  stackRegion?: string;
  /**
   * The user's UNFOLDED `--stack-region` spelling, captured by each command's
   * handler BEFORE it folds the flag (issue #1836 round 3). Consumed only by
   * the state-record match in `local-state-loader.ts` — see
   * `LoadStateForStackOptions.rawStackRegion` for the full rationale.
   *
   * Since issue [#2522](https://github.com/go-to-k/cdkd/issues/2522) the four
   * ECS / CloudFront / AgentCore ENGINE commands capture it too, from the
   * `preAction` hook `adoptDeprecatedRegionFlag` installs — cdk-local owns
   * their handler, so the hook is their only cdkd-owned point BEFORE the fold.
   * The factory's fallback to the raw `stackRegion` below therefore no longer
   * has a caller in this repo, and is kept as the correct answer for a bag that
   * reached the factory without passing a capture point at all (a direct
   * `createLocalStateProvider` call from a test or a future embedder).
   */
  rawStackRegion?: string;
}

/**
 * cdkd's `--from-state` factory. Reads cdkd-specific fields off the
 * options bag (carried through cdk-local's `LocalStateSourceOptions`
 * index signature) to construct an `S3LocalStateProvider`. Bound into
 * cdk-local's dispatcher via `extraStateProviders: { fromState }` so
 * cdk-local can treat it identically to its built-in `--from-cfn-stack`.
 */
const fromStateFactory: LocalStateProviderFactory = (options) => {
  // Narrow back to the cdkd-augmented shape. Safe because cdk-local
  // only ever invokes this factory with the options bag the shim
  // wrapper passed in, which carries every cdkd field.
  const opts = options as unknown as LocalStateSourceOptions;
  const clientRegion = canonicalizeRegion(opts.region) || undefined;
  // Issue #1836 round 4: the FOLDED half is gated on blank-is-absent too, so the
  // `rawStackRegion` line below can honestly claim to match it. Round 3's gate
  // was `opts.stackRegion !== undefined`, so `--stack-region ''` still forwarded
  // `stackRegion: ''` while the comment beside it claimed parity with the raw
  // half. That was harmless downstream (`loadStateForStack` gates on
  // TRUTHINESS), but a false parity claim is exactly what the round-3 review
  // found twice, and this branch already adopted blank-is-absent at the four
  // client boundaries — a blank names no region at any of them.
  const stackRegion = canonicalizeRegion(opts.stackRegion) || undefined;
  // The RAW `--stack-region` spelling for the state-record match (issue #1836
  // round 3). Every cdkd `local *` command now captures it before its own fold —
  // the four that own their handler do it there, the four ENGINE commands from
  // the `preAction` hook `adoptDeprecatedRegionFlag` installs (issue #2522). The
  // fallback to the still-raw `stackRegion` remains for a bag that reached this
  // factory without passing either capture point. Blank counts as absent,
  // matching the `stackRegion` gate above.
  const rawStackRegion = opts.rawStackRegion || opts.stackRegion || undefined;
  return new S3LocalStateProvider({
    statePrefix: opts.statePrefix,
    ...(opts.stateBucket !== undefined && { stateBucket: opts.stateBucket }),
    // Issue #1836: `--region` needs the SAME boundary fold as `--stack-region`
    // below, and for a consequence one step worse than a missed compare: it
    // builds the `AwsClients` + `S3StateBackend` in `local-state-loader.ts`, and
    // SDK endpoint resolution is case-SENSITIVE — so `cdkd local start-service
    // --from-state --region CN-NORTH-1` reached a COMMERCIAL endpoint. The four
    // commands with their own handler fold `--region` on entry (#1795) and the
    // ENGINE commands fold it in their `preAction` hook (#2522), so this is
    // idempotent for all eight — and still the last stop for a direct call.
    // A blank `--region ''` is treated as ABSENT rather than forwarded: it names
    // no endpoint, and omitting it is what lets the SDK's own chain resolve the
    // profile's region.
    ...(clientRegion !== undefined && { region: clientRegion }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
    // Issue #1836: fold `--stack-region` at THIS boundary as well as at each
    // command's handler entry. The four `cdkd local` commands that declare the
    // flag themselves (`invoke` / `start-api` / `run-task` / `invoke-agentcore`)
    // fold it on entry, and since issue #2522 the ECS / CloudFront / AgentCore
    // ENGINE commands (`start-service` / `start-alb` / `start-cloudfront` /
    // `start-agentcore`) fold it in the `preAction` hook cdkd installs on top of
    // cdk-local's handler — so this boundary is now a second, idempotent fold
    // rather than the only cdkd-owned point. Downstream it is compared
    // against a state record's region and used to build the state key, both
    // case-SENSITIVE. A blank `--stack-region ''` is ABSENT here — see the
    // `stackRegion` binding above.
    ...(stackRegion !== undefined && { stackRegion }),
    // ... and carry the RAW spelling beside it, because the folded value is the
    // one an endpoint needs and the raw one is the only thing that can make
    // "an exactly-spelled region wins over a case-variant record" true.
    ...(rawStackRegion !== undefined && { rawStackRegion }),
  });
};

/**
 * Cdkd's `extraStateProviders` map for cdk-local's engine entry points
 * (e.g. `runEcsServiceEmulator`) that accept a state-source factory
 * registry directly instead of going through `createLocalStateProvider`.
 * The engine calls `createLocalStateProvider` internally with this map,
 * so cdkd's `--from-state` flow is wired in transparently.
 */
export const cdkdExtraStateProviders: ExtraStateProviders = {
  fromState: fromStateFactory,
};

/**
 * Pick and construct the right `LocalStateProvider` for the supplied
 * flag set. Delegates to cdk-local's dispatcher with cdkd's
 * `--from-state` factory wired in. Returns `undefined` when neither
 * flag is set (caller skips the substitution pass). Throws
 * `LocalStateSourceError` when both flags are set (mutually exclusive)
 * or when `--from-cfn-stack` is given an explicit empty string.
 *
 * `cdkdStackName` is the cdkd-side stack name the local command
 * resolved to its target — used for the bare-`--from-cfn-stack`
 * default. `synthRegion` is the synth-derived stack region
 * (`env.region` on the CDK stack) — fallback for the CFn client when
 * no explicit region override is set.
 *
 * For multi-stack callers (`local start-api` / `local start-service`)
 * also invoke `rejectExplicitCfnStackWithMultipleStacks` BEFORE the
 * per-stack loop — see that helper's docstring for the rationale.
 */
export function createLocalStateProvider(
  options: LocalStateSourceOptions,
  cdkdStackName: string,
  synthRegion: string | undefined
): LocalStateProvider | undefined {
  // Cast at the cdk-local boundary: cdk-local's LocalStateSourceOptions
  // declares `[key: string]: unknown` so hosts can stash extra
  // option fields, but cdkd's options interfaces are intentionally
  // closed-shape (so unknown property accesses are TS errors, not
  // `unknown` reads). The cast is semantically safe — cdkd's interface
  // has every base field cdk-local reads.
  const provider = createLocalStateProviderBase(
    options as unknown as LocalStateSourceOptionsBase,
    cdkdStackName,
    synthRegion,
    cdkdExtraStateProviders
  );
  if (provider instanceof CfnLocalStateProviderBase) {
    bindCallerIdentityClients(provider, options.profile);
  } else if (isCfnFlagPresentBase(options) && cannotLeaveUnbound(options.profile)) {
    // `--from-cfn-stack` was asked for but the dispatcher returned something
    // that is not the class cdkd knows how to rebind: whatever it is builds its
    // own clients, which resolve the role.
    throw new Error(
      cfnProviderRefusal(['a --from-cfn-stack provider that is not CfnLocalStateProvider'])
    );
  }
  return provider;
}

/**
 * True when an unbound `--from-cfn-stack` provider would resolve the ROLE: a
 * role is published and no profile (flag or exported `AWS_PROFILE`) steers the
 * provider's own clients to the caller.
 */
function cannotLeaveUnbound(profile: string | undefined): boolean {
  if (getAssumedRoleCredentials() === undefined) return false;
  return !(profile || process.env['AWS_PROFILE']);
}

function cfnProviderRefusal(drift: readonly string[]): string {
  return (
    `--from-cfn-stack cannot run under --role-arn with this cdk-local version: it has ` +
    `${drift.join(', ')}, so cdkd cannot make it read the stack with your own credentials ` +
    `instead of the role's. Pass --profile <name> (your own profile), or use the cdk-local ` +
    `version this cdkd release ships with (go-to-k/cdkd#3240).`
  );
}

/**
 * The lazily-built client slots of cdk-local's `CfnLocalStateProvider`, as the
 * compiled class actually carries them. TypeScript marks every one `private`;
 * at runtime they are ordinary members, which is what makes the rebinding in
 * {@link bindCallerIdentityClients} possible at all.
 */
interface CfnProviderClientSlots {
  disposed: boolean;
  region: string;
  client?: CloudFormationClient;
  lambdaClient?: LambdaClient;
  ssmClient?: SSMClient;
  agentCoreControlClient?: BedrockAgentCoreControlClient;
  getClient: () => CloudFormationClient;
  getLambdaClient: () => LambdaClient;
  getSsmClient: () => SSMClient;
  getAgentCoreControlClient: () => BedrockAgentCoreControlClient;
}

/** The four getters every `CfnLocalStateProvider` read goes through. */
export const CFN_PROVIDER_CLIENT_GETTERS = [
  'getClient',
  'getLambdaClient',
  'getSsmClient',
  'getAgentCoreControlClient',
] as const;

/** The instance slots those getters fill, which the provider's `dispose()` destroys. */
export const CFN_PROVIDER_CLIENT_SLOTS = [
  'client',
  'lambdaClient',
  'ssmClient',
  'agentCoreControlClient',
] as const;

/**
 * Every member the reviewed `CfnLocalStateProvider` prototype chain carries
 * (cdk-local 0.149.8). An ALLOWLIST, so any method a release adds — a new
 * reader that might build a client of its own — is drift.
 */
export const CFN_PROVIDER_PROTOTYPE_MEMBERS = [
  'constructor',
  ...CFN_PROVIDER_CLIENT_GETTERS,
  'resolveTemplateSsmParameters',
  'resolveDeployedFunctionEnv',
  'resolveLambdaExecutionRoleArn',
  'resolveAgentCoreRuntimeRoleArn',
  'load',
  'getLastLoadError',
  'buildCrossStackResolver',
  'dispose',
] as const;

/**
 * Every way the installed `CfnLocalStateProvider` has drifted from the shape
 * {@link bindCallerIdentityClients} reviewed and rebinds, or `[]` when it matches.
 *
 * - a known getter MISSING (renamed or removed: the provider builds its own
 *   client again);
 * - any prototype member, anywhere on the chain below `Object.prototype`, that
 *   is not on {@link CFN_PROVIDER_PROTOTYPE_MEMBERS} (a new method, possibly a
 *   new reader with a client of its own);
 * - a client slot or the `region` field that is not an own member (renamed:
 *   `dispose()` would not destroy the clients built here, or the region the
 *   rebound clients use is gone);
 * - an own instance property ending in `Client` that is not a known slot (a
 *   client cached somewhere this module does not rebind).
 *
 * WHAT IT CANNOT SEE: it checks the SHAPE, not what a method does. A client
 * built inline inside an EXISTING method, or cached at module level in the
 * bundle, keeps every name the same and is undetectable here.
 */
export function cfnProviderShapeDrift(provider: object): string[] {
  const proto = Object.getPrototypeOf(provider) as Record<string, unknown> | null;
  const allowed: readonly string[] = CFN_PROVIDER_PROTOTYPE_MEMBERS;
  const slots: readonly string[] = CFN_PROVIDER_CLIENT_SLOTS;
  const drift: string[] = [];
  for (const name of CFN_PROVIDER_CLIENT_GETTERS) {
    if (typeof proto?.[name] !== 'function') drift.push(`no ${name}()`);
  }
  for (
    let p: object | null = proto;
    p !== null && p !== Object.prototype;
    p = Object.getPrototypeOf(p)
  ) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (!allowed.includes(name)) drift.push(`an unknown ${name}()`);
    }
  }
  for (const slot of CFN_PROVIDER_CLIENT_SLOTS) {
    if (!Object.hasOwn(provider, slot)) drift.push(`no ${slot} slot`);
  }
  if (
    typeof (provider as { region?: unknown }).region !== 'string' ||
    !Object.hasOwn(provider, 'region')
  ) {
    drift.push('no region field');
  }
  for (const name of Object.getOwnPropertyNames(provider)) {
    if (/Client$/.test(name) && !slots.includes(name)) drift.push(`an unknown ${name} slot`);
  }
  return drift;
}

/**
 * Make `--from-cfn-stack` read the deployed stack as the CALLER, never as a
 * `--role-arn` role (issue [#3240](https://github.com/go-to-k/cdkd/issues/3240),
 * channel 4).
 *
 * cdk-local builds the provider's CloudFormation / Lambda / SSM /
 * BedrockAgentCoreControl clients from the region and `--profile` alone, so
 * after `applyRoleArnIfSet` overwrote the `AWS_*` triple they resolve the ROLE.
 * What they read lands in the emulated workload: the SSM client calls
 * `GetParameters` with `WithDecryption: true` and the plaintext of a
 * SecureString is baked into the container's environment, and the Lambda client
 * reads the deployed function's environment. A SecureString the caller cannot
 * read was handed to the local code through the deploy role.
 *
 * cdk-local's options carry no credentials key, so the seam is the provider's
 * own lazy getters: each is shadowed by an own property that builds the same
 * client, in the provider's own `region`, through
 * `awsClientDefaults({ ignoreAssumedRole: true })` and stores it in the SAME
 * slot, so the provider's `dispose()` still destroys it. The result is exactly
 * what passing the caller's `--profile` already gave.
 *
 * ON UPSTREAM DRIFT. `cdk-local` is a caret dependency and these members are
 * private upstream. When {@link cfnProviderShapeDrift} reports anything, this
 * throws if an unbound provider would resolve the role (a role published, no
 * profile flag or exported `AWS_PROFILE`), and otherwise leaves the provider
 * unbound, since its own clients then resolve the caller. That is a shape
 * check, not a proof: see the limit recorded on {@link cfnProviderShapeDrift}.
 */
export function bindCallerIdentityClients(
  provider: CfnLocalStateProviderBase,
  profile: string | undefined
): void {
  const drift = cfnProviderShapeDrift(provider);
  if (drift.length > 0) {
    if (!cannotLeaveUnbound(profile)) return;
    throw new Error(cfnProviderRefusal(drift));
  }
  const slots = provider as unknown as CfnProviderClientSlots;
  const live = (): void => {
    if (slots.disposed) throw new Error('CfnLocalStateProvider used after dispose()');
  };
  const config = (): { region: string; profile?: string } => ({
    region: slots.region,
    ...(profile && { profile }),
  });
  // `ignoreAssumedRole` on all four -- each reads a value the emulated workload
  // receives (decrypted SecureStrings, the deployed function's environment, the
  // physical ids its intrinsics resolve to, the role `--assume-role` assumes for
  // it), so it must resolve the caller's identity, never `--role-arn`'s. The
  // profile goes to the helper AND the client, so a profile wins on both paths.
  slots.getClient = () => {
    live();
    return (slots.client ??= new CloudFormationClient({
      ...awsClientDefaults({ profile, ignoreAssumedRole: true }),
      ...config(),
    }));
  };
  slots.getLambdaClient = () => {
    live();
    return (slots.lambdaClient ??= new LambdaClient({
      ...awsClientDefaults({ profile, ignoreAssumedRole: true }),
      ...config(),
    }));
  };
  slots.getSsmClient = () => {
    live();
    return (slots.ssmClient ??= new SSMClient({
      ...awsClientDefaults({ profile, ignoreAssumedRole: true }),
      ...config(),
    }));
  };
  slots.getAgentCoreControlClient = () => {
    live();
    return (slots.agentCoreControlClient ??= new BedrockAgentCoreControlClient({
      ...awsClientDefaults({ profile, ignoreAssumedRole: true }),
      ...config(),
    }));
  };
}

/**
 * One way a `cdkd local` ENGINE command (`start-service` / `start-alb` /
 * `start-cloudfront` / `start-agentcore`) hands the workload something resolved
 * as `--role-arn`'s role.
 *
 * `flagOnly` marks the channel an exported `AWS_PROFILE` does NOT close: the
 * engine gates it on its own `--profile` option value, not on the SDK chain.
 */
export interface EngineRoleChannel {
  readonly what: string;
  readonly flagOnly: boolean;
}

/** The role's credential triple copied into the named containers. */
export function engineCredentialTripleChannel(containers: string): EngineRoleChannel {
  return {
    what: `the role's AWS credentials are copied into ${containers}, so that code runs as the role`,
    flagOnly: true,
  };
}

/** ECS task `secrets` fetched with the role and injected as plaintext. */
export const ENGINE_ECS_SECRETS_CHANNEL: EngineRoleChannel = {
  what: "ECS task secrets are fetched with the role and injected as plaintext into the container's environment",
  flagOnly: false,
};

/**
 * CloudFormation dynamic references in a container's env: cdk-local's resolver
 * builds its Secrets Manager / SSM clients from `profile` alone (go-to-k/cdkd#2056;
 * the cdkd-owned commands inject caller-identity clients instead).
 */
export const ENGINE_DYNAMIC_REFERENCE_CHANNEL: EngineRoleChannel = {
  what: "CloudFormation dynamic references ({{resolve:...}}) are fetched with the role and injected as plaintext into the container's environment",
  flagOnly: false,
};

/**
 * `--assume-role` / `--assume-task-role` for the workload: cdk-local's STS client
 * is built from `{region, profile}`, so the role makes the AssumeRole call and
 * the container can receive a role the caller could not assume.
 */
export const ENGINE_ASSUME_ROLE_CHANNEL: EngineRoleChannel = {
  what: 'the role --assume-role / --assume-task-role assumes for the container is assumed BY the --role-arn role, so the container can receive a role you could not assume yourself',
  flagOnly: false,
};

/**
 * `--from-cfn-stack`: the engine builds its own provider from `{region, profile}`.
 * `alsoReads` names what THIS command's engine reads through it beyond the
 * stack itself (start-cloudfront's S3 origins and KeyValueStore entries).
 */
export function engineFromCfnStackChannel(alsoReads?: string): EngineRoleChannel {
  return {
    what:
      "--from-cfn-stack reads the deployed stack, including SecureString parameters decrypted into the container's environment" +
      (alsoReads ? `, and ${alsoReads}` : ''),
    flagOnly: false,
  };
}

/** `${AWS::AccountId}` resolved through an STS hop answered by the role. */
export const ENGINE_ACCOUNT_ID_CHANNEL: EngineRoleChannel = {
  what: "${AWS::AccountId} resolves to the role's account in the container's environment, secret references and image URIs",
  flagOnly: false,
};

/**
 * Warn at startup when an engine command runs under `--role-arn` /
 * `CDKD_ROLE_ARN` with no profile selected (issue
 * [#3240](https://github.com/go-to-k/cdkd/issues/3240)).
 *
 * cdk-local's `runEcsServiceEmulator` and the CloudFront / AgentCore serve
 * engines assume the role themselves and build every client from the region and
 * `--profile` alone, and their options carry no credentials key, so the fix is
 * upstream (go-to-k/cdk-local#783). The one lever cdkd has — patching
 * `CfnLocalStateProvider.prototype` so the engine's own providers rebind too —
 * is rejected: it reaches only `--from-cfn-stack`, rewrites a class cdkd does
 * not own for every provider in the process, and would need the caller's
 * identity captured before the engine's assume, outside cdkd's own role
 * bookkeeping. Until upstream lands, this makes the escalation visible instead
 * of silent. `--from-cfn-stack` and `--assume-role` are channels only when their
 * flag is set, so they are appended here rather than listed by each command.
 *
 * Installed as a `preAction` hook, after the root program's own hook has
 * mirrored `--profile` into `AWS_PROFILE` — so the FLAG is read from the parsed
 * options and the environment separately.
 */
export function warnEngineRoleExposure(
  cmd: Command,
  commandName: string,
  channels: readonly EngineRoleChannel[],
  fromCfnStackChannel: EngineRoleChannel = engineFromCfnStackChannel()
): Command {
  cmd.hook('preAction', (_thisCommand, actionCommand) => {
    const options = actionCommand.optsWithGlobals<{
      roleArn?: string;
      profile?: string;
      fromCfnStack?: string | boolean;
      assumeRole?: unknown;
      assumeTaskRole?: unknown;
    }>();
    const message = engineRoleExposureWarning(commandName, channels, fromCfnStackChannel, {
      roleArn: options.roleArn || process.env['CDKD_ROLE_ARN'],
      profileFlag: options.profile,
      envProfile: process.env['AWS_PROFILE'],
      fromCfnStack: isCfnFlagPresentBase(options),
      // `--assume-role` / `--assume-task-role` in any form but `--no-assume-role`
      // (false): explicit ARN, bare `true`, or a per-Lambda map.
      assumesForWorkload:
        isAssumeRequested(options.assumeRole) || isAssumeRequested(options.assumeTaskRole),
    });
    if (message !== undefined) getLogger().warn(message);
  });
  return cmd;
}

/** True for any `--assume-role` / `--assume-task-role` value except absent or `--no-assume-role`. */
export function isAssumeRequested(value: unknown): boolean {
  // Absent (`undefined`) and `--no-assume-role` (`false`) both fall to the last line.
  if (typeof value === 'string') return value !== '';
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return value === true;
}

/**
 * The warning text {@link warnEngineRoleExposure} prints, or `undefined` when
 * nothing reaches the role. Pure so every arm is testable without a parse.
 */
export function engineRoleExposureWarning(
  commandName: string,
  channels: readonly EngineRoleChannel[],
  fromCfnStackChannel: EngineRoleChannel,
  input: {
    roleArn: string | undefined;
    profileFlag: string | undefined;
    envProfile: string | undefined;
    fromCfnStack: boolean;
    assumesForWorkload: boolean;
  }
): string | undefined {
  // A malformed ARN is refused by the engine before anything is assumed, so
  // nothing reaches the role and a warning would only precede that refusal.
  if (!input.roleArn || !isIamRoleArn(input.roleArn) || input.profileFlag) return undefined;
  const all: EngineRoleChannel[] = [
    ...channels,
    ...(input.assumesForWorkload ? [ENGINE_ASSUME_ROLE_CHANNEL] : []),
    ...(input.fromCfnStack ? [fromCfnStackChannel] : []),
  ];
  const envProfileSet = !!input.envProfile;
  const open = envProfileSet ? all.filter((c) => c.flagOnly) : all;
  if (open.length === 0) return undefined;
  const why = envProfileSet
    ? 'is set, and the exported AWS_PROFILE does not cover what follows (only the --profile flag does)'
    : 'is set and no profile is selected';
  return (
    `cdkd local ${commandName}: --role-arn ${why}, so the local emulation engine resolves ` +
    `these AS THE ROLE and hands them to your local code: ${open.map((c) => c.what).join('; ')}. ` +
    'Pass --profile <name> with your own profile to keep them on your identity, or do not pass ' +
    'a role whose permissions you would not give the code in the container. Tracked as ' +
    'go-to-k/cdkd#3240 (upstream go-to-k/cdk-local#783).'
  );
}
