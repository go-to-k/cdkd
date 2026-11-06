import { getLogger } from '../../../utils/logger.js';
import { describeLocalAwsFailureForWarn } from '../../../utils/local-aws-failure.js';
import {
  createLocalStateProvider,
  rejectExplicitCfnStackWithMultipleStacks,
} from '../local-state-source.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import type { StackState } from '../../../types/state.js';
import type { PseudoParameters } from '../../../local/state-resolver.js';
import { derivePartitionAndUrlSuffix } from '../../../local/ecs-task-resolver.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import type { DiscoveredRoute } from '../../../local/route-discovery.js';
import type { RouteWithAuth } from '../../../local/authorizer-resolver.js';
import { awsClientDefaults } from '../../../utils/aws-client-defaults.js';
import type { LocalStartApiOptions } from './types.js';
import { reachedLambdas, lambdaOwners } from './served-lambdas.js';
import { getTemplateEnv } from './env.js';

/**
 * Per-stack `--from-state` substitution input consumed by
 * {@link buildContainerSpec}. Built once per `synthesizeAndBuild` pass
 * — initial boot AND every hot-reload firing — by
 * {@link loadStateForRoutedStacks}. Empty (no stack-level entry) when
 * the stack's state could not be loaded or the user did not pass
 * `--from-state`.
 */
export interface StackStateBundle {
  state: StackState;
  /**
   * The region the state was loaded from — the owning stack's region, used
   * first when resolving a `{{resolve:...}}` env value (issue #2056).
   */
  region?: string;
  /**
   * AWS pseudo parameters (account / region / partition / URL suffix).
   * `undefined` when none of the stack's reachable Lambdas has a
   * pseudo-parameter intrinsic in its env map (skips the STS hop) OR
   * the STS resolution failed (substitution still runs for non-`AWS::*`
   * refs).
   */
  pseudoParameters?: PseudoParameters;
}

/**
 * Returns true when any value in the function's template env map is a
 * CFn intrinsic (non-primitive). Used to gate the pseudo-parameter STS
 * hop inside the `--from-state` flow: literal-only env maps don't need
 * the pseudo-parameter bag and shouldn't pay for an STS call. Mirrors
 * the same gating in `local-invoke.ts` (`envHasIntrinsicValue`) and
 * `ecs-task-resolver.ts` (`containerHasIntrinsicEnvOrSecret`).
 */
export function envHasIntrinsicValue(templateEnv: Record<string, unknown> | undefined): boolean {
  if (!templateEnv) return false;
  for (const v of Object.values(templateEnv)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') continue;
    return true;
  }
  return false;
}

/**
 * Load deployed state for every stack that owns a routed Lambda. Once
 * per `synthesizeAndBuild` pass (initial boot + every reload), so a
 * Lambda's per-spec build does not pay one round-trip per Lambda. Per-
 * stack failures (no state, ambiguous region, bucket resolution error)
 * degrade to warn-and-fall-back via the active `LocalStateProvider` —
 * the affected stack's reachable Lambdas behave as if `--from-state` /
 * `--from-cfn-stack` were not set, while sibling stacks with loadable
 * state still substitute.
 *
 * Pseudo parameters are resolved per stack and only when at least one
 * reachable Lambda in that stack has an intrinsic-valued env entry
 * (gated via {@link envHasIntrinsicValue}). STS failures degrade to
 * warn and leave `pseudoParameters: undefined` — substitution still
 * runs for non-`AWS::*` refs.
 */
export async function loadStateForRoutedStacks(
  stacks: readonly StackInfo[],
  routes: readonly DiscoveredRoute[],
  routesWithAuth: readonly RouteWithAuth[],
  options: LocalStartApiOptions
): Promise<Map<string, StackStateBundle>> {
  const logger = getLogger();
  const out = new Map<string, StackStateBundle>();

  // Collect the set of (stackName, region) pairs that contain at least
  // one routed Lambda OR an attached authorizer Lambda. The stack
  // resolution is the spec build's (`lambdaOwners`: the route's own stack),
  // so we never load state for a stack whose Lambdas are not actually
  // reachable from the discovered API surface, and two stacks reusing a
  // construct id both load (#5181).
  const reachableStackNames = new Set<string>();
  // Per stack: does any reachable Lambda in it have an intrinsic-valued env
  // map — gates the per-stack STS hop.
  const intrinsicEnvStacks = new Set<string>();
  for (const ref of reachedLambdas(routes, routesWithAuth)) {
    for (const owner of lambdaOwners(ref, stacks)) {
      reachableStackNames.add(owner.stackName);
      const resource = owner.template.Resources?.[ref.logicalId];
      if (resource && envHasIntrinsicValue(getTemplateEnv(resource))) {
        intrinsicEnvStacks.add(owner.stackName);
      }
    }
  }
  const stackHasIntrinsicEnv = (stackName: string): boolean => intrinsicEnvStacks.has(stackName);

  // Issue #606: route through `createLocalStateProvider` so the same
  // code path drives both `--from-state` (S3) and `--from-cfn-stack`
  // (CFn). One provider PER reachable stack — bare `--from-cfn-stack`
  // uses the cdkd stack name per routed stack, so the dispatcher needs
  // each stack's name at construction time. Each provider is disposed
  // after its `load` call returns so the AWS client tied to that
  // provider doesn't outlive the boot pass.
  //
  // Reject explicit `--from-cfn-stack <name>` when multiple cdkd stacks
  // are routed: the explicit name would apply to every routed stack
  // and silently misresolve `Ref` lookups when logical IDs happen to
  // collide between siblings (see local-state-source.ts for the
  // rationale). Bare `--from-cfn-stack` is safe because each routed
  // stack uses its own cdkd stack name.
  rejectExplicitCfnStackWithMultipleStacks(options, reachableStackNames.size);
  for (const stackName of reachableStackNames) {
    const stack = stacks.find((s) => s.stackName === stackName);
    if (!stack) continue;
    const provider = createLocalStateProvider(options, stack.stackName, stack.region);
    if (!provider) continue;
    try {
      const loaded = await provider.load(stack.stackName, stack.region);
      if (!loaded) continue;

      // Synthesize a `StackState` shape from the provider's
      // `LocalStateRecord` so the downstream `buildContainerSpec` path
      // (which reads `stateBundle.state.resources`) keeps working
      // verbatim. Outputs is an unused field at this call site but
      // populated for completeness; the StackState `version` /
      // `lastModified` carry placeholder values — the
      // sync `substituteEnvVarsFromState` resolver only reads
      // `resources`.
      const syntheticState: StackState = {
        version: 1,
        stackName: stack.stackName,
        resources: loaded.resources,
        outputs: loaded.outputs,
        lastModified: 0,
      };
      const bundle: StackStateBundle = { state: syntheticState, region: loaded.region };
      if (stackHasIntrinsicEnv(stackName)) {
        const pseudo = await resolvePseudoParametersForStartApi(loaded.region, options);
        if (pseudo) bundle.pseudoParameters = pseudo;
      }
      out.set(stackName, bundle);
      logger.debug(`${provider.label}: loaded state for ${stackName} (${loaded.region})`);
    } finally {
      provider.dispose();
    }
  }
  return out;
}

/**
 * Build the AWS pseudo-parameter bag for `--from-state` env-var
 * substitution. Mirrors `resolvePseudoParametersForInvoke` in
 * `local-invoke.ts` byte-for-byte — kept inlined here rather than
 * extracted into a shared helper because the two call sites differ in
 * region precedence (this one is per-stack so the resolved state
 * region takes priority).
 *
 * Region precedence: `--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` >
 * the state record's region (returned by the active `LocalStateProvider`).
 *
 * The resolved region is CANONICALIZED (issue #1795) before anything consumes
 * it. That covers all four sources — `--region`, both env vars, and the state
 * record's region — and all three consumers: the STS client built for
 * `${AWS::AccountId}`, the `${AWS::URLSuffix}` / `${AWS::Partition}`
 * derivation, and the `${AWS::Region}` value itself.
 *
 * `${AWS::AccountId}` follows where the stack was read (issue
 * go-to-k/cdkd#5001): under `--from-state` it is the DEPLOY account (the
 * `--role-arn` role's when one is published); under `--from-cfn-stack`, which
 * reads as the caller and sees only the caller's account, it is the caller's.
 *
 * @internal exported for unit tests.
 */
export async function resolvePseudoParametersForStartApi(
  stateRegion: string,
  options: LocalStartApiOptions
): Promise<PseudoParameters | undefined> {
  const logger = getLogger();
  const region = canonicalizeRegion(
    options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? stateRegion
  );
  // Both state sources reach this resolver, so its warnings name the one in use.
  const sourceFlag = options.fromState ? '--from-state' : '--from-cfn-stack';
  let accountId: string | undefined;
  try {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    let sts: InstanceType<typeof STSClient>;
    if (!options.fromState) {
      // `ignoreAssumedRole` -- `${AWS::AccountId}` follows WHERE THE STACK WAS READ
      // (go-to-k/cdkd#5001): `--from-cfn-stack` reads it as the CALLER (#3240) and
      // CloudFormation sees only the caller's own account, so the account is the
      // caller's, never a `--role-arn` assumed for cdkd's own calls.
      sts = new STSClient({
        ...awsClientDefaults({ profile: options.profile, ignoreAssumedRole: true }),
        ...(region && { region }),
        ...(options.profile && { profile: options.profile }),
      });
    } else {
      // cdkd-local-role-identity: `--from-state` read the state record as the `--role-arn`
      // role when one is published (go-to-k/cdkd#3230), so `${AWS::AccountId}` is the DEPLOY
      // account, asked through `awsClientDefaults` as that role (go-to-k/cdkd#5001). Only the
      // account ID is taken; no credential reaches the emulated function.
      sts = new STSClient({
        ...awsClientDefaults({ profile: options.profile }),
        ...(region && { region }),
        // `--profile` is the identity both state sources read through when no
        // role is published, so the account must be asked as it too.
        ...(options.profile && { profile: options.profile }),
      });
    }
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      accountId = identity.Account;
    } finally {
      sts.destroy();
    }
  } catch (err) {
    // cdkd-raw-beside-safe: `sourceFlag` is one of two caller literals
    // ('--from-state' / '--from-cfn-stack'), so it cannot carry anything.
    logger.warn(
      `${sourceFlag}: resolver needs \${AWS::AccountId} but STS GetCallerIdentity failed: ${describeLocalAwsFailureForWarn(err, 'STS GetCallerIdentity')}. ` +
        'Substitution will be skipped for AWS::AccountId; affected env entries will be dropped with per-key warnings.'
    );
  }
  const partitionAndSuffix = region ? derivePartitionAndUrlSuffix(region) : undefined;
  const bag: PseudoParameters = {
    ...(accountId !== undefined && { accountId }),
    ...(region !== undefined && { region }),
    ...(partitionAndSuffix && {
      partition: partitionAndSuffix.partition,
      urlSuffix: partitionAndSuffix.urlSuffix,
    }),
  };
  return Object.keys(bag).length === 0 ? undefined : bag;
}
