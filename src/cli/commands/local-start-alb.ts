import { Command, Option } from 'commander';
import { withErrorHandling } from '../../utils/error-handler.js';
import {
  addAlbSpecificOptions,
  addCommonEcsServiceOptions,
  albStrategy,
  runEcsServiceEmulator,
  type EcsServiceEmulatorOptions,
  type EmulatorStrategy,
  type FrontDoorPlan,
  type PlannedAction,
} from './ecs-service-emulator.js';
import { cdkdExtraStateProviders } from './local-state-source.js';
import { adoptDeprecatedRegionFlag } from '../region-options.js';

/**
 * Cdkd-specific extension of cdk-local's `EcsServiceEmulatorOptions` carrying
 * the `--from-state` / `--state-bucket` / `--state-prefix` fields (cdkd's
 * S3-backed state source). cdk-local's option type already declares
 * `[key: string]: unknown`, so these fields ride through the engine and reach
 * cdkd's `fromStateFactory` (registered via `cdkdExtraStateProviders`) when
 * the engine calls `createLocalStateProvider` internally. `--from-cfn-stack`
 * + `--stack-region` are inherited from `addCommonEcsServiceOptions`; the
 * ALB-specific flags (`--lb-port` / `--tls` / `--tls-cert` / `--tls-key` /
 * `--no-verify-auth` / `--bearer-token`) ride through via
 * `EcsServiceEmulatorOptions`'s upstream declarations + `addAlbSpecificOptions`.
 */
export interface LocalStartAlbOptions extends EcsServiceEmulatorOptions {
  /**
   * `--from-state` — read cdkd's S3 state for the target stack and substitute
   * `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::ImportValue` / `Fn::GetStackOutput`
   * intrinsics in the resolved ECS service container images, environment
   * variables, secrets, role ARNs, and volumes. Mutually exclusive with
   * `--from-cfn-stack`.
   *
   * Reaches the ECS service targets only — a `TargetType: lambda` target
   * group's container environment is resolved on a path that drops these
   * fields upstream. See {@link warnUnresolvedLambdaTargetEnv}
   * ([#2602](https://github.com/go-to-k/cdkd/issues/2602)).
   */
  fromState: boolean;
  /** S3 bucket for `--from-state`. Falls back to CDKD_STATE_BUCKET / cdk.json. */
  stateBucket?: string;
  /** S3 key prefix for `--from-state` (commander always supplies the default). */
  statePrefix: string;
}

/**
 * Every distinct Lambda logical id a resolved front-door plan forwards to,
 * sorted so the warning text is deterministic.
 *
 * Walks BOTH action slots — a listener's `defaultAction` and each of its
 * rules' `action` — because either one can carry a `TargetType: lambda`
 * target group and an ALB that reaches a Lambda only through a
 * `path-pattern` rule is the common shape (`/api/*` to a Lambda, everything
 * else to the ECS service). Mirrors cdk-local's own `collectAlbLambdaTargets`
 * walk, one layer later: this reads the QUALIFIED plan the strategy returns,
 * where a Lambda target already carries its resolved `lambda.logicalId`.
 */
function collectLambdaTargetLogicalIds(frontDoor: FrontDoorPlan | undefined): string[] {
  if (!frontDoor) return [];
  const ids = new Set<string>();
  const fromAction = (action: PlannedAction | undefined): void => {
    if (action?.kind !== 'forward') return;
    for (const target of action.targets) {
      if (target.kind === 'lambda') ids.add(target.lambda.logicalId);
    }
  };
  for (const listener of frontDoor.listeners) {
    fromAction(listener.defaultAction);
    for (const rule of listener.rules) fromAction(rule.action);
  }
  return [...ids].sort();
}

/**
 * Wrap an ALB {@link EmulatorStrategy} so that, under `--from-state`, a plan
 * carrying a `TargetType: lambda` target group emits a WARNING naming the
 * affected Lambdas — because the flag does not reach their container
 * environment.
 *
 * ## Why a warning and not a refusal
 *
 * `cdkd local start-cloudfront` REFUSES cdkd's state flags outright
 * ([#2528](https://github.com/go-to-k/cdkd/issues/2528)) because NO consumer on
 * that command's path reads a host-registered state source. `start-alb` is
 * partial, not total, so the same remedy would delete a working capability:
 *
 * - **ECS service targets DO honor `--from-state`.** `bootOneTarget` /
 *   `rollOneTarget` (`cdk-local@0.147.7`, `dist/local-studio-BBtUAVNy.js`
 *   `:26474` / `:26422`) hand `createLocalStateProvider` the FULL options bag,
 *   so cdkd's `fromState` factory is selected and the task containers'
 *   images / env / secrets / volumes resolve against S3 state.
 * - **Lambda target groups do NOT.** `resolveAlbLambdaTargetEnv` (`:26614`)
 *   rebuilds the bag it hands the shared `resolveLambdaContainerEnv` as a
 *   SIX-KEY allow-list — `fromCfnStack` / `assumeRole` / `region` / `profile` /
 *   `stackRegion` / `envVars` (`:26619-26626`) — dropping `fromState` /
 *   `stateBucket` / `statePrefix`. It forwards `extraStateProviders` faithfully,
 *   but the dispatcher activates an extra provider only when `options[key]` is
 *   truthy (`:4894`), and the key it looks for is exactly the one the bag no
 *   longer carries. So cdkd's factory is registered and never selected, and the
 *   Lambda boots with its intrinsics dropped — one WARN per variable, none of
 *   which says the flag was the problem.
 *
 * The fix is upstream (two arguments in `resolveAlbLambdaTargetEnv`); until it
 * lands, this makes the partiality LOUD at boot instead of leaving the user to
 * read "Environment variable X contains a CloudFormation intrinsic and was
 * dropped" as a state problem. `--from-cfn-stack` survives the allow-list and
 * therefore reaches both target kinds, which is what the message points at.
 *
 * ## Mechanics
 *
 * `runEcsServiceEmulator` logs every string in the `warnings` array
 * `strategy.resolveBoots` returns, so appending to it is the whole wiring — no
 * second synth, since the front-door plan is already resolved. Returns the
 * strategy UNCHANGED when `--from-state` is absent, so the non-state path
 * carries no wrapper at all.
 *
 * The warning REPEATS on every `--watch` reload, because `resolveBoots` is
 * re-run per reload (`:26264`) and its warnings re-logged. That matches how
 * cdk-local's own ALB resolution warnings behave on the same path, which is
 * the whole reason: repeating is what the surrounding output already does.
 * It is NOT because a reload could introduce a new Lambda target — the reload
 * discards `frontDoor` and `buildFrontDoor` runs only at boot (`:26110`), so
 * a Lambda added mid-`--watch` is never stood up at all. An earlier revision
 * of this comment argued the second, false thing.
 */
export function warnUnresolvedLambdaTargetEnv(
  strategy: EmulatorStrategy,
  options: Pick<LocalStartAlbOptions, 'fromState'>
): EmulatorStrategy {
  if (options.fromState !== true) return strategy;
  return {
    ...strategy,
    resolveBoots: (stacks, chosenTargets) => {
      const resolved = strategy.resolveBoots(stacks, chosenTargets);
      const lambdaIds = collectLambdaTargetLogicalIds(resolved.frontDoor);
      if (lambdaIds.length === 0) return resolved;
      // An ALB whose every target is a Lambda resolves to ZERO boots and is a
      // legitimate topology (the engine only refuses when there are neither
      // boots NOR listeners). Claiming "the ECS targets DO honor it" there
      // would be vacuously true of an empty set and read as a contradiction,
      // so the sentence is carried only when there is an ECS half to speak
      // about. The remedy line likewise STATES which source the Lambda path
      // reads rather than telling the user to add a flag they may already have
      // set. `--from-cfn-stack` CAN be present while this warning prints, and
      // the reason is not that the dispatcher goes uncalled — the Lambda path
      // does call it, from `resolveLambdaContainerEnv` (`:17892`). It calls it
      // with the stripped six-key bag, so `activeExtras` is empty and the
      // mutual-exclusion throw at `:4896` cannot fire. (An earlier revision of
      // this comment said "nothing calls the dispatcher", which was false; the
      // conclusion was right for the wrong reason.)
      const ecsNote =
        resolved.boots.length > 0
          ? 'The ECS service targets behind this ALB DO honor --from-state. '
          : '';
      return {
        ...resolved,
        warnings: [
          ...resolved.warnings,
          `--from-state does not reach the container environment of this ALB's Lambda ` +
            `target group(s): ${lambdaIds.join(', ')}. Their Environment.Variables keep any ` +
            'Ref / Fn::GetAtt / Fn::Sub / Fn::ImportValue intrinsics unresolved, and each is ' +
            'then dropped with its own warning. ' +
            ecsNote +
            'The only state source the Lambda path reads is --from-cfn-stack <name>, which ' +
            'reaches ' +
            'both target kinds on a CloudFormation-deployed stack; otherwise override the ' +
            'affected variables with --env-vars. Tracked as go-to-k/cdkd#2602 (upstream ' +
            'go-to-k/cdk-local#707).',
        ],
      };
    },
  };
}

/**
 * The `EmulatorStrategy` `cdkd local start-alb` runs with: cdk-local's ALB
 * strategy, decorated by {@link warnUnresolvedLambdaTargetEnv}.
 *
 * Extracted from the command's action for ONE reason, and it is the finding
 * that produced it: with the composition written inline in the `.action(...)`
 * closure, deleting the decorator at its only wiring point left the entire
 * unit suite green (measured in review — 29/29). The decorator's own cases
 * exercise it directly, so they cannot see a call site that stopped calling
 * it. A named export gives that seam a subject a test can hold.
 *
 * The seam is fenced BEHAVIOURALLY, in
 * `tests/unit/cli/local-start-alb-wiring.test.ts`, which runs the real command
 * and drives whatever object the action hands the engine. A source-shape
 * assertion was tried first and defeated in review round 3 by hoisting
 * `albStrategy(options)` into a local one statement up: its positive half was
 * satisfied by the mutation's own COMMENT and its negative half could not
 * cross the `)` the hoist introduced. That case is deleted rather than
 * tightened — the behavioural one catches strictly more, and a fence a comment
 * can satisfy reads as coverage while providing none.
 */
export function buildAlbEmulatorStrategy(options: LocalStartAlbOptions): EmulatorStrategy {
  return warnUnresolvedLambdaTargetEnv(albStrategy(options), options);
}

/**
 * `cdkl start-alb <Stack/Alb>` — Issue #86 v1. Names an
 * `AWS::ElasticLoadBalancingV2::LoadBalancer`, discovers the ECS service(s)
 * behind its HTTP `forward` listeners, boots their replicas, and stands up a
 * local front-door on each listener port that round-robins across the replicas.
 * The symmetric ALB counterpart of `start-api`.
 */
export function createLocalStartAlbCommand(): Command {
  // cdkd's `createLocalCommand` (in local-invoke.ts) sets `CDKD_EMBED_CONFIG`
  // once for the whole `cdkd local` command tree, so this factory must NOT
  // call `setEmbedConfig` itself — doing so would clobber cdkd's branding
  // back to cdk-local's `cdkl` defaults.
  const cmd = new Command('start-alb')
    .description(
      'Run an Application Load Balancer locally: name the ALB, and cdk-local boots the ECS ' +
        'service(s) behind its listeners and stands up a local front-door on each listener port ' +
        'that round-robins across the running replicas and routes its listener rules across the ' +
        'backing services — a stable host endpoint, like behind a real load balancer. The ' +
        'symmetric ALB counterpart of `start-api`. Each <target> accepts a CDK display path ' +
        '(MyStack/MyAlb) or stack-qualified logical ID; single-stack apps may omit the stack ' +
        'prefix. Supports HTTP and HTTPS listeners — by default a cloud-HTTPS listener is ' +
        'served over plain HTTP locally (with X-Forwarded-Proto: https preserved). Pass --tls ' +
        '(or --tls-cert / --tls-key) to terminate TLS locally with a self-signed or ' +
        'user-supplied cert. All six ALB rule-condition fields are honored ' +
        '(path-pattern / host-header / http-header / http-request-method / query-string / ' +
        'source-ip); forward (single and weighted), redirect, and fixed-response actions; and ' +
        'ECS or Lambda targets (a Lambda target group is invoked locally via the Lambda RIE). ' +
        'authenticate-cognito / authenticate-oidc actions enforce a local Bearer-JWT check ' +
        '(or AWSELBAuthSessionCookie pass-through) against the same JWKS / OIDC discovery URL ' +
        'the deployed ALB would; use --bearer-token <jwt> to inject a default token or ' +
        '--no-verify-auth to disable the guard. Omit <targets> in an interactive terminal to ' +
        'multi-select the load balancers from a list.'
    )
    .argument(
      '[targets...]',
      'One or more CDK display paths or stack-qualified logical IDs of the AWS::ElasticLoadBalancingV2::LoadBalancer resources to run (omit to multi-select interactively in a TTY)'
    )
    .addOption(
      new Option(
        '--from-state',
        "Read cdkd's S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub / " +
          'Fn::ImportValue / Fn::GetStackOutput intrinsics in container images, environment ' +
          'variables, secrets, role ARNs, and volumes of the ECS services behind the ALB. ' +
          "Does NOT reach a Lambda target group's container environment (upstream " +
          'go-to-k/cdk-local#707; a boot warning names the affected functions) — use ' +
          '--from-cfn-stack for those. Mutually exclusive with --from-cfn-stack.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--state-bucket <bucket>',
        'S3 bucket for --from-state. Falls back to CDKD_STATE_BUCKET env or cdk.json context.cdkd.stateBucket.'
      )
    )
    .addOption(
      new Option('--state-prefix <prefix>', 'S3 key prefix for --from-state state files.').default(
        'cdkd'
      )
    )
    .action(
      withErrorHandling(async (targets: string[], options: LocalStartAlbOptions) => {
        await runEcsServiceEmulator(
          targets,
          options,
          buildAlbEmulatorStrategy(options),
          cdkdExtraStateProviders
        );
      })
    );

  addAlbSpecificOptions(cmd);
  // Last, so cdk-local's own `--region` has already been added and can be
  // replaced by cdkd's deprecated twin + the entry fold (issue #2522).
  return adoptDeprecatedRegionFlag(addCommonEcsServiceOptions(cmd));
}
