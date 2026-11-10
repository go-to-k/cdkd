import {
  parseContextOptions,
  warnIfDeprecatedRegion,
  validateResourceTimeouts,
  applyWaitFlagEnv,
} from '../../options.js';
import { inRunStackKey } from '../../../deployment/export-change-guard.js';
import { getLogger } from '../../../utils/logger.js';
import { PhaseClock, renderPhaseTimings, timePhase } from '../../../utils/phase-timings.js';
import { forwardSigtermToSigint } from '../../../utils/interrupt-signals.js';
import { bold, cyan, gray } from '../../../utils/colors.js';
import { DeployCancelledError, PartialFailureError } from '../../../utils/error-handler.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { refuseMalformedNestedTemplateTrees } from '../nested-template-preflight.js';
import { promptYesNo } from '../confirm-prompt.js';
import { createApprovalPrompter, resolveRequireApproval } from '../require-approval.js';
import {
  resolveOutputsFile,
  writeStackOutputsFile,
  type StackOutputsByStack,
} from '../outputs-file.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../../synthesis/synthesizer.js';
import { refuseFailedLookups } from '../../../synthesis/failed-lookups.js';
import { processStackMessages } from '../../../synthesis/stack-messages.js';
import { AssetPublisher } from '../../../assets/asset-publisher.js';
import { AssetModeResolver } from '../../../assets/asset-storage.js';
import type { AssetRedirectMap } from '../../../assets/asset-redirect.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { DagBuilder } from '../../../analyzer/dag-builder.js';
import { DiffCalculator } from '../../../analyzer/diff-calculator.js';
import { inferCrossStackDepsByStack } from '../../../analyzer/cross-stack-deps.js';
import {
  type RoleArnReference,
  producerLookupOver,
  refuseUnreadableCdkCrossAccountRefs,
} from '../../../deployment/intrinsic-resolver/cdk-cross-account-ref.js';
import { loadProviderClasses } from '../../../provisioning/register-providers.js';
import { setResolvedResourceTimeouts } from '../../../provisioning/resource-timeout-registry.js';
import { WorkGraph } from '../../../deployment/work-graph.js';
import { setAwsClients, AwsClients, runWithStackAwsClients } from '../../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../../utils/role-arn.js';
import {
  exportInferredRegionForSdk,
  foldRegionOption,
  namedCliRegion,
  rawCliRegion,
  regionNeedsReconciliation,
  resolveEffectiveRegion,
  stackRegionResolver,
} from '../../region-options.js';
import { runStackBuffered } from '../../../utils/stack-context.js';
import { withSkipPrefix } from '../../../provisioning/resource-name.js';
import {
  resolveApp,
  resolveAutoAssetStorage,
  resolveSkipPrefix,
  resolveUseCdkBootstrapAssets,
  warnDeprecatedNoPrefixCliFlag,
} from '../../config-loader.js';
import {
  matchStacks,
  describeStack,
  partitionTopLevel,
  renderAllLeftOutStageStacks,
  renderStacksNoLongerSelected,
  stacksNoLongerSelected,
  renderAllNoTopLevelStacks,
  renderNoStackMatch,
  refuseStackNameRegionCollisions,
  stacksForDependency,
} from '../../stack-matcher.js';
import { deployStackRegion } from '../cross-prefix-gate.js';
import { CrossPrefixGuard } from '../../../state/stack-registry.js';
import type { DeployCommandOptions } from './types.js';
import { prepareStateInfra, fetchCallerIdentity } from './prep.js';
import { addStacksToWorkGraph } from './work-graph.js';
import { deployStackInScope, type DeployStackContext } from './stack-deploy.js';
import { checkPinCcApiOptions } from './pin-cc-api-checks.js';
import { forceQuitReleaseCommand } from './helpers.js';

/**
 * Deploy command implementation
 */
export async function deployCommand(
  stacks: string[],
  options: DeployCommandOptions
): Promise<void> {
  // go-to-k/cdkd#5200: inert unless CDKD_PHASE_TIMINGS=1. The first lap runs
  // from the process's start, so it holds Node's startup and the module load.
  const runClock = new PhaseClock('run', { fromProcessStart: true });
  runClock.lap('node startup + module load');
  // Awaited first, so provider construction below stays synchronous once the
  // stack client scope / globals are set (see `loadProviderClasses`).
  const providerClasses = await loadProviderClasses();
  runClock.lap('provider load');
  const logger = getLogger();

  if (options.verbose) {
    logger.setLevel('debug');
    // Disable the live progress renderer in verbose mode — debug logs would
    // interleave too aggressively with the live area's in-flight task lines.
    process.env['CDKD_NO_LIVE'] = '1';
  }

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

  // Reject mis-ordered --resource-warn-after / --resource-timeout pairs
  // up front so the user sees the error before synth / docker builds run.
  // Mutates `options.resourceWarnAfter` in place when auto-lowering the
  // inherited warn against a shortened --resource-timeout (so the
  // DeployEngine constructor below reads the lowered value).
  validateResourceTimeouts(options);
  // Seed the provisioning-layer registry so providers with an INNER waiter
  // cap (ECS settleService's default steady-state wait, CloudFront's
  // --full-wait Deployed wait) can lift it to the same
  // user-resolved budget the OUTER per-resource deadline uses (issue #1280).
  setResolvedResourceTimeouts(options.resourceTimeout);

  // Wait-mode flags. `--no-wait` / default / `--full-wait` are three
  // points on one axis; the two flags are opposite ends of it, so
  // combining them is rejected inside the helper. This sits BEFORE
  // applyRoleArnIfSet because that call issues a real `sts:AssumeRole`
  // when --role-arn is set, and the docs promise the pair is rejected
  // before any AWS call. The helper also projects the flags onto the
  // CDKD_NO_WAIT / CDKD_FULL_WAIT / CDKD_WAIT_FLAGS_AVAILABLE envs the
  // providers read (issue #1291 items 1 + 6).
  applyWaitFlagEnv(options);

  // Before synth, so an invalid cdk.json `requireApproval` fails fast. A dry
  // run never asks (the engine returns before the approval), so it needs no
  // prompter either.
  const requireApproval = resolveRequireApproval(options.requireApproval);
  const approveDeployment =
    requireApproval !== 'never' && !options.dryRun
      ? createApprovalPrompter({ yes: options.yes ?? false })
      : undefined;
  // Likewise before synth, so an invalid cdk.json `outputsFile` fails fast,
  // under a dry run too; a dry run only writes no file (go-to-k/cdkd#5819).
  const resolvedOutputsFile = resolveOutputsFile(options.outputsFile);
  const outputsFile = options.dryRun ? undefined : resolvedOutputsFile;

  // Issue #2065 - fold `--region` ONCE, here, so no raw spelling reaches an SDK
  // client, an ARN segment or a state key. This command is where the class was
  // measured: `--region US-EAST-1` is copied verbatim into `AWS_REGION` below
  // and into every `new AwsClients(...)` spread, and S3 rejects it outright
  // (`AuthorizationHeaderMalformed: the region 'US-EAST-1' is wrong`), so the
  // deploy died at the state-bucket preflight before doing anything. The fold
  // sits ABOVE `applyRoleArnIfSet` because that call issues a real
  // `sts:AssumeRole`, and STS rejects a non-canonical region too
  // (`SignatureDoesNotMatch: Credential should be scoped to a valid region`).
  //
  // The user's EXACT spelling is captured first, for the bootstrap marker's
  // SECOND probe only: `cdkd bootstrap` derives its own region verbatim
  // (issue #1820), so a marker may exist under a raw key, and folding
  // unconditionally would stop `AssetModeResolver` ever probing it. Same split
  // `gc.ts` / `bootstrap-destroy.ts` already keep, and the same shape as
  // `local-invoke/command.ts`'s `rawStackRegion`.
  const rawNamedRegion = rawCliRegion(options.region);
  foldRegionOption(options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call. The RULE to reason
  // from: what an SDK client here runs as is decided by the EXPLICIT
  // `credentials` value `awsClientDefaults()` publishes, not by the `AWS_*`
  // environment variables beside it — those exist for the consumers that
  // channel cannot reach, which is cdk-local's own in-process SDK clients as
  // well as the CDK app subprocess. The env channel alone is not merely weaker, it is silently
  // INERT whenever a profile is selected (`credential-provider-node` skips its
  // env link once `AWS_PROFILE` is set), which is the whole defect issue #3130
  // fixed. `applyRoleArnIfSet`'s header owns both channels, why `AWS_PROFILE`
  // is nonetheless left set, and the one consumer channel 2 must not reach; do
  // not restate any of it here — this comment carried the pre-#3130 mechanism
  // at the busiest call site of that function, teaching the exact belief that
  // produced the bug (issue #3225).
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // Resolve the prefix-user-supplied-names flag pair once at command
  // start. The resolved boolean is plumbed into a `withSkipPrefix(...)`
  // scope around each stack's deploy so every per-resource
  // `generateResourceName(...)` call inside picks up the flag via
  // AsyncLocalStorage — no need to thread it through the
  // DeployEngine / ProviderRegistry / per-provider call signatures.
  //
  // Since v0.94.0 the default is to SKIP the prefix on user-supplied
  // physical names. Pass `--prefix-user-supplied-names` (or set
  // CDKD_PREFIX_USER_SUPPLIED_NAMES=true / cdk.json
  // context.cdkd.prefixUserSuppliedNames=true) to opt back in to
  // legacy prefixing. The deprecated `--no-prefix-user-supplied-names`
  // flag is still accepted (matches the new default; emits a warning).
  // Detect the literal `--no-prefix-user-supplied-names` flag (Commander
  // collapses it onto `prefixUserSuppliedNames` via auto-negation, so the
  // deprecation warning needs a pre-parse argv walk).
  warnDeprecatedNoPrefixCliFlag();
  const skipPrefix = resolveSkipPrefix({
    prefixUserSuppliedNames: options.prefixUserSuppliedNames,
  });
  if (skipPrefix) {
    logger.debug(
      'Skipping stack-name prefix on user-supplied physical names (default since v0.94.0)'
    );
  } else {
    logger.debug(
      'Keeping legacy stack-name prefix on user-supplied physical names ' +
        '(--prefix-user-supplied-names / CDKD_PREFIX_USER_SUPPLIED_NAMES / ' +
        'cdk.json context.cdkd.prefixUserSuppliedNames)'
    );
  }

  // Resolve --app from CLI, env, or cdk.json
  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }
  options.app = app;

  // go-to-k/cdkd#2100: the region this run operates on when a stack pins none —
  // `--region`, `AWS_REGION`, `AWS_DEFAULT_REGION`, the profile's region, then
  // `us-east-1` — rather than a `us-east-1` literal that outranked the profile
  // while this command's own region-less clients followed it. An INFERRED
  // region yields, per stack, to state the old default wrote (`regionForStack`
  // below), so an upgrade never re-creates a stack that lives in us-east-1.
  const effectiveRegion = await resolveEffectiveRegion(options);
  exportInferredRegionForSdk(effectiveRegion);
  const region = effectiveRegion.region;

  logger.debug('Starting deployment...');
  logger.debug('Options:', options);

  // Initialize AWS clients with region/profile (synchronous — client
  // construction only, no network). Also set AWS_REGION env for providers
  // using local SDK clients.
  if (options.region) {
    process.env['AWS_REGION'] = options.region;
    process.env['AWS_DEFAULT_REGION'] = options.region;
  }
  // go-to-k/cdkd#2100: the resolved region, explicitly. A region-less bag
  // follows the SDK's chain, which never reads AWS_DEFAULT_REGION, so it would
  // disagree with a region inferred from it.
  const awsClients = new AwsClients({
    region: effectiveRegion.region,
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  // Overlap the slow state-infra I/O with CDK synth (both ~2s and independent).
  // Resolving the default state bucket (STS GetCallerIdentity + GetBucketLocation)
  // and the fail-fast bucket-exists preflight do NOT need the synthesized
  // template, and synth needs neither the state bucket (only the DEFERRED
  // macro-expander consumes it) nor these clients (context providers build
  // their own). Started here, awaited alongside synth in the Promise.all below.
  // Fail-fast on a missing bucket is preserved — the preflight rejects the
  // Promise.all; the only cost of overlap is a wasted ~2s synth on the rare
  // misconfigured-bucket path.
  const statePrepPromise = prepareStateInfra({
    options,
    region,
    effectiveRegion,
    awsClients,
    logger,
  });

  // The account id the asset destinations are named from. It needs only the
  // region and the credentials, so it is asked beside synthesis rather than
  // after it (go-to-k/cdkd#5200); awaited where it is used, so a failure is
  // reported at the same point as before.
  const callerIdentityPromise = fetchCallerIdentity(region);
  // Handled where it is awaited; a run that fails before then never reads it.
  callerIdentityPromise.catch(() => undefined);

  let deployInterrupted = false;
  const topLevelSigintHandler = () => {
    if (deployInterrupted) {
      // Force-exit bypasses every `finally`, so per-stack locks may be left
      // behind. Print the recovery command (parity with destroy's force-quit
      // path) — the lock TTL reclaims them automatically otherwise.
      process.stderr.write(
        '\nForce-quit: stack locks may not be released. ' +
          'If the next run reports a lock, run this for EACH stack it names, ' +
          'in the region-qualified form — see the message that run prints.' +
          // The holes are QUOTED, and on a labelled line of their own. A bare
          // `<stackName>` is two shell redirections: `<stackName` reads stdin
          // from a file and the `>` takes the next word as an output TARGET
          // and creates it (measured on go-to-k/cdkd#3436). `commandHole`
          // prints `'<stackName>'`, so this line is inert BY DESIGN and stays
          // inert if a flag is appended. An earlier version of this comment
          // described the unquoted text it replaced — "inert by where the
          // command happens to stop ... one appended flag from being silent" —
          // which is true of a BARE trailing hole and not of what this prints
          // (go-to-k/cdkd#3613's M8).
          // Built through the shared builder so it carries the run's typed
          // `--profile` / `--state-bucket` / `--state-prefix` (go-to-k/cdkd#4177).
          `\nRelease with: ${forceQuitReleaseCommand()}\n`
      );
      process.exit(130);
    }
    process.stderr.write('\nInterrupted — waiting for in-progress operations to complete...\n');
    deployInterrupted = true;
  };
  process.on('SIGINT', topLevelSigintHandler);
  // CI cancellation delivers SIGTERM, not Ctrl-C (issue #1342) — route it
  // through the same graceful path (incl. the engine's partial-state save
  // and the providers' poll-abort listeners).
  const unforwardSigterm = forwardSigtermToSigint();

  // go-to-k/cdkd#4705 (review R4-2): the preflight backend may REPLACE its S3
  // client with a bucket-region one (`ensureClientForBucket`), which
  // `awsClients.destroy()` does not reach; a cross-prefix scan still pending at
  // the end of the run must not keep the process alive on it.
  let preflightBackendForCleanup: S3StateBackend | undefined;
  try {
    // 1. Synthesize CDK app (or read a pre-synthesized assembly when --app
    // points at an existing directory — synthesis is skipped in that case).
    // Run synth CONCURRENTLY with the state-infra prep started above (bucket
    // resolution + preflight) — two independent ~2s I/O phases overlap.
    logger.info(cyan(synthesisStatusMessage(app, 'Synthesizing CDK app...')));
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const synthOptions: SynthesisOptions = {
      app: options.app,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
      // stateBucket is set below once statePrepPromise resolves — only the
      // DEFERRED macro-expander (post-synth, for the > 51,200-byte template
      // upload path, Issue #463) consumes it, so synthesize() does not need it.
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
      // Issue #1150: expand macros AFTER stack selection (below), so a
      // macro-carrying stack outside the deploy set can never block or
      // slow this deploy with a CFn round-trip.
      deferMacroExpansion: true,
      failedLookupsCheckedByCaller: true,
    };
    runClock.lap('config, region, credentials');
    const [result, statePrep] = await Promise.all([
      timePhase('run', 'synth (beside the state bucket prep)', () =>
        synthesizer.synthesize(synthOptions)
      ),
      timePhase('run', 'state bucket prep (beside synth)', () => statePrepPromise),
    ]);
    runClock.lap('synth + state bucket prep');
    const { stateBucket, preflightStateBackend, exportIndexStore } = statePrep;
    preflightBackendForCleanup = preflightStateBackend;
    // The deferred macro-expander (expandMacrosForStacks, below) needs the
    // resolved state bucket for its > 51,200-byte template upload path (#463).
    synthOptions.stateBucket = stateBucket;
    // The account flags every malformed-record refusal of this run prints on
    // its `cdkd state show` / `cdkd state list` pointers — the pre-lock
    // `--recreate-via-*` read below and the engine's own state load alike, so
    // the two render the same record identically (go-to-k/cdkd#4159).
    const refusalRecovery: LockRecoveryContext = {
      profile: options.profile,
      stateBucket,
      statePrefix: options.statePrefix,
    };

    const { stacks: allStacks } = result;

    logger.debug(`Found ${allStacks.length} stack(s) in assembly`);

    // Determine target stacks: positional args > --stack > --all > auto (single stack)
    const stackPatterns = stacks.length > 0 ? stacks : options.stack ? [options.stack] : [];
    let targetStacks;
    // Stage stacks `--all` left out, reported once dependency inclusion below
    // has run: a top-level stack's dependency inside a Stage is still deployed.
    let allLeftOutStageStacks: typeof allStacks = [];

    if (allStacks.length === 0) {
      // Reached before the branch chain below: with zero stacks and no
      // pattern, the `else` arm would answer `Multiple stacks found: .`.
      throw new Error(renderNoStackMatch(stackPatterns, allStacks));
    }

    if (options.all) {
      // Top-level stacks only, as the AWS CDK CLI's `--all` (#4474); a Stage's
      // stacks are named with a Stage-path pattern or a globstar (spelled out in
      // words: a slash-star in a line comment reads as a block comment to the
      // source scanners), and the run says it left them out.
      const { topLevel, inStages } = partitionTopLevel(allStacks);
      if (topLevel.length === 0) throw new Error(renderAllNoTopLevelStacks(inStages));
      allLeftOutStageStacks = inStages;
      targetStacks = topLevel;
    } else if (stackPatterns.length > 0) {
      // Every selected stack, two sharing a physical name included: one Stage
      // per region under a shared stackName is two stacks, and the AWS CDK
      // CLI deploys both (#5176). A shared name AND region is refused below.
      targetStacks = matchStacks(allStacks, stackPatterns, { dedupe: 'identity' });
    } else if (allStacks.length === 1) {
      // Single stack: auto-select
      targetStacks = allStacks;
    } else {
      throw new Error(
        `Multiple stacks found: ${allStacks.map(describeStack).join(', ')}. ` +
          `Specify stack name(s) or use --all (top-level stacks; '**' for every stack)`
      );
    }

    if (targetStacks.length === 0) {
      const gone = stacksNoLongerSelected(allStacks, stackPatterns, new Set());
      throw new Error(
        renderNoStackMatch(stackPatterns, allStacks) +
          (gone.stacks.length > 0
            ? `\n${renderStacksNoLongerSelected(gone.patterns, gone.stacks)}`
            : '')
      );
    }

    // Cross-stack ordering edges that CDK's manifest dependency graph
    // (`stack.dependencyNames`) does NOT capture: a raw
    // `cdk.Fn.importValue('<exportName>')` or `Fn::GetStackOutput` reference
    // without an explicit `addDependency` produces no manifest edge, so cdkd
    // would otherwise deploy the consumer concurrently with (often before)
    // the producer and fail with `export not found` / `stack not found`.
    // Inferred from the synthesized templates (the runtime S3 export index is
    // empty on a fresh multi-stack deploy). Both the auto-include walk below
    // and the inter-stack DAG-edge building further down use the UNION of
    // `dependencyNames` + these inferred producers. Computed over ALL stacks
    // so auto-include can reach a producer not yet in `targetStacks`.
    // The same walk collects every `Fn::GetStackOutput` carrying a `RoleArn`
    // (most apps: none), for the cross-account pre-flight below.
    const roleArnReferences: RoleArnReference[] = [];
    // Keyed by stack OBJECT, and an inferred producer is the stack that
    // EXPORTS the name (or the one `Fn::GetStackOutput` names, in its region),
    // never one merely found by name: two Stages share names (#5176).
    const inferredCrossStackDeps = inferCrossStackDepsByStack(allStacks, {
      onRoleArnReference: (consumer, args) => roleArnReferences.push({ consumer, args }),
    });
    // Consulted lazily, by a `RoleArn`-carrying reference only.
    const producerLookup = producerLookupOver(allStacks);
    type AppStack = (typeof allStacks)[number];
    // A stack's producers among `pool`: its manifest dependencies (by name,
    // resolved to the dependent's own Stage) plus the inferred producers.
    const dependencyStacks = (
      stack: AppStack,
      inferred: Map<AppStack, Set<AppStack>>,
      pool: readonly AppStack[]
    ): Set<AppStack> => {
      const deps = new Set<AppStack>();
      for (const depName of stack.dependencyNames) {
        for (const dep of stacksForDependency(depName, stack, pool)) deps.add(dep);
      }
      const inPool = new Set(pool);
      for (const producer of inferred.get(stack) ?? []) {
        if (producer !== stack && inPool.has(producer)) deps.add(producer);
      }
      return deps;
    };

    // STRONG-only edges (CDK manifest deps + `Fn::ImportValue`) for the
    // auto-include-dependency walk below. `Fn::GetStackOutput` is a WEAK
    // reference (it reads the producer's output opportunistically from cdkd
    // state) and must NOT pull an unselected producer into the deploy:
    // `cdkd deploy <consumer>` should deploy only the consumer, not silently
    // re-deploy a producer it merely reads from (issue #751 conflated the two,
    // which re-deployed — and so mutated the state of — the producer). The DAG
    // ordering further down still uses the full (strong + weak) set, so when a
    // producer IS in the deploy set it is correctly ordered before its
    // GetStackOutput consumer.
    const inferredStrongCrossStackDeps = inferCrossStackDepsByStack(allStacks, {
      kinds: ['ImportValue'],
    });

    // Auto-include dependency stacks (CDK CLI compatible behavior)
    // When deploying StackA that depends on StackB, also deploy StackB first.
    // Use -e / --exclusively to skip this and deploy only the requested stacks.
    if (!options.exclusively) {
      // By stack OBJECT, not name: a dependency name two Stages share resolves
      // to the producer in the dependent's own Stage (#5176).
      const included = new Set(targetStacks);

      const addDependencies = (stack: (typeof allStacks)[number]): void => {
        for (const depStack of dependencyStacks(stack, inferredStrongCrossStackDeps, allStacks)) {
          if (included.has(depStack)) continue;
          included.add(depStack);
          targetStacks.push(depStack);
          logger.debug(
            `Auto-including dependency stack: ${depStack.stackName} (required by ${stack.stackName})`
          );
          addDependencies(depStack); // Recursive
        }
      };

      for (const stack of [...targetStacks]) {
        addDependencies(stack);
      }
    }
    // A selected stack and another stack of the app with one physical name and
    // one region (and, for an unselected one, a possible shared account; two
    // selected stacks always share the run's) use one CloudFormation stack and state record:
    // deploying one overwrites the other. Checked against the unselected app
    // stacks of a selected name that pin a region too, so a selected stack
    // never lands on such a stack's record (#5176). An unselected env-agnostic
    // stack is not: where it lives depends on the run that deployed it. Refused
    // here, before any per-stack AWS call, for the regions the synthesized app
    // pins; a stack without `env.region` is checked again once its region is
    // resolved below.
    const selectedNames = new Set(targetStacks.map((s) => s.stackName));
    const selectedSet = new Set(targetStacks);
    const sameNamedAppStacks = allStacks.filter(
      (s) => selectedSet.has(s) || (selectedNames.has(s.stackName) && s.region !== undefined)
    );
    refuseStackNameRegionCollisions(sameNamedAppStacks, (s) => s.region, selectedSet);
    const deployedStacks = new Set(targetStacks);
    const deployedNames = new Set(targetStacks.map((s) => s.stackName));
    const leftOut = allLeftOutStageStacks.filter((s) => !deployedStacks.has(s));
    if (leftOut.length > 0) logger.warn(renderAllLeftOutStageStacks(leftOut));
    if (!options.all && stackPatterns.length > 0) {
      // A pattern that used to select a stack by a physical-name wildcard and
      // no longer does is named, not dropped silently (#4474).
      const gone = stacksNoLongerSelected(allStacks, stackPatterns, deployedNames);
      if (gone.stacks.length > 0) {
        logger.warn(renderStacksNoLongerSelected(gone.patterns, gone.stacks));
      }
    }

    // CDK CLI parity (issue #1228): surface Annotations messages for the
    // final deploy set — print warnings/infos, refuse to deploy when any
    // selected stack carries an error annotation (`cdk deploy` fails with
    // "Found errors" too). Selection-aware like the #1150 macro expansion
    // below: an error in a non-selected sibling stack does not block this
    // deploy. Runs before any AWS mutation (assets, locks, provisioning).
    // #1230: `--strict` also fails on warnings; `--ignore-errors` never fails.
    processStackMessages(targetStacks, logger, {
      strict: options.strict === true,
      ignoreErrors: options.ignoreErrors === true,
    });
    // A failed lookup no stack carries as an annotation (a construct reading the
    // context itself) is invisible to the check above: refuse it here, whatever
    // the selection (go-to-k/cdkd#5807).
    refuseFailedLookups([], allStacks, result.failedLookups);

    // Issue #3449: a cyclic / malformed nested-template tree is refused HERE,
    // for the final deploy set, before macro expansion, asset publishing, any
    // lock and any engine. The per-row guard in NestedStackProvider stays as
    // the backstop for a context this command did not build.
    refuseMalformedNestedTemplateTrees(targetStacks);

    // An aws-cdk-lib-generated cross-account `Fn::GetStackOutput` that cdkd can
    // already tell it cannot read is refused HERE, before any lock or engine,
    // rather than mid-provisioning. No-op unless the walk above found a
    // `RoleArn`. Top-level templates only: a nested child's reference is
    // refused when its row resolves it.
    if (roleArnReferences.length > 0) {
      // Keyed by stack NAME, like every other per-stack lookup in this command.
      const stackByName = new Map(allStacks.map((s) => [s.stackName, s]));
      refuseUnreadableCdkCrossAccountRefs(
        roleArnReferences,
        new Set(targetStacks.map((s) => s.stackName)),
        (name) => ({
          // A NAMED region only, as before #2100: an inferred one (including
          // an AWS_DEFAULT_REGION copied into AWS_REGION) is not this
          // producer's region when the producer is held on us-east-1.
          region:
            stackByName.get(name)?.region ??
            (regionNeedsReconciliation(effectiveRegion)
              ? undefined
              : namedCliRegion(options.region)),
          account: stackByName.get(name)?.account,
        }),
        producerLookup
      );
    }

    // go-to-k/cdkd#4705: the run's stack-registry checks, LAZY and memoized
    // per stack and region: a first deploy claims its marker once its state
    // load finds no record; a destructive plan, the settle and the automatic
    // rollback read it on demand. An ordinary redeploy makes no request. A dry
    // run writes no marker. `stackRegions` below is the ONE answer both the
    // checks and `runStackInner` (the engine's region) read.
    const baseRegion = region;
    // go-to-k/cdkd#2100: every target stack's region, resolved ONCE before
    // either loop below reads it. Two loops consume it — the work-graph loop
    // picks the ASSET region, the deploy loop the CLIENT / state-key region —
    // and reconciling separately in each could publish a held stack's assets
    // to the profile's region while its resources stay in us-east-1. A stack
    // with a synthesized `env.region` is pinned and never probed.
    const regionForStack = stackRegionResolver({
      effective: effectiveRegion,
      probe: preflightStateBackend,
      logger,
      siblings: allStacks.filter((s) => !s.region).map((s) => s.stackName),
    });
    // Keyed by stack OBJECT: two stacks sharing a name in different regions
    // each keep their own (#5176).
    const stackRegions = new Map(
      await Promise.all(
        targetStacks.map(async (s) => [s, await regionForStack(s.stackName, s.region)] as const)
      )
    );
    // The resolved regions: an env-agnostic stack may land in the region
    // another stack of its name pins, selected or not -- the #2100 hold puts it
    // on us-east-1 when a record of its name is there, which can be a sibling
    // Stage's.
    refuseStackNameRegionCollisions(
      sameNamedAppStacks,
      (s) => stackRegions.get(s) ?? s.region,
      selectedSet
    );
    const crossPrefixGuard = new CrossPrefixGuard(preflightStateBackend, {
      readOnly: options.dryRun === true,
    });

    // Issue #1150: macro expansion was deferred at synthesize() time —
    // expand now for exactly the final deploy set (incl. auto-included
    // dependency stacks), mutating each template in place before the
    // asset / analysis / provisioning pipeline consumes it. Known
    // limitation: the cross-stack inference above scans raw
    // (pre-expansion) templates, so author-written `Fn::ImportValue` /
    // `Fn::GetStackOutput` markers are seen as before, but a marker
    // that only EXISTS in a macro's expansion output (e.g. a custom
    // macro injecting an ImportValue) no longer contributes an
    // inferred edge — expansion requires selection, which requires the
    // inference, so the cycle is broken in favor of selection scoping.
    runClock.lap('stack selection, stack regions');
    await synthesizer.expandMacrosForStacks(targetStacks, synthOptions);
    runClock.lap('macro expansion');

    // 3. Build work graph: asset-publish → stack deploy (DAG)
    const accountId = (await callerIdentityPromise).Account!;
    runClock.lap('caller identity');

    const assetPublisher = new AssetPublisher();
    // Issue #1002 — per-region asset-mode detection (legacy vs cdkd-assets).
    // One marker read per unique region, cached for the invocation. In
    // `cdkd-assets` mode (marker present), PR 2 wires publish redirection +
    // template rewrite through the §6 mapping table built below; legacy
    // deploys stay byte-identical to before (plus one info line about the
    // `cdk gc` hazard). `--use-cdk-bootstrap-assets` (or cdk.json
    // context.cdkd.useCdkBootstrapAssets) pins legacy mode for the app.
    const useCdkBootstrapAssets = resolveUseCdkBootstrapAssets(options.useCdkBootstrapAssets);
    // Issue #1007 — first deploy into a region with no bootstrap marker
    // auto-creates the per-region asset storage (instead of legacy mode), so
    // `cdkd bootstrap` stays a true once-per-account step. Interactive runs
    // are prompted once per region; `--yes` / non-TTY runs create with an
    // info line. Opt out via --no-auto-asset-storage / cdk.json
    // context.cdkd.autoAssetStorage: false. Never under --dry-run (a
    // dry run must not create resources), and moot under the
    // --use-cdk-bootstrap-assets legacy pin (marker is never read).
    const autoAssetStorage = resolveAutoAssetStorage(options.autoAssetStorage);
    const confirmAutoAssetStorage = async (assetRegion: string): Promise<boolean> => {
      if (options.yes || !process.stdin.isTTY) {
        logger.info(
          `Creating cdkd asset storage for region '${assetRegion}' (first deploy into this ` +
            `region; opt out with --no-auto-asset-storage).`
        );
        return true;
      }
      return promptYesNo(
        `Region '${assetRegion}' has no cdkd asset storage yet. Create it now ` +
          `(S3 bucket cdkd-assets-${accountId}-${assetRegion} + container-asset ECR repo, ` +
          `out of 'cdk gc' reach)?`
      );
    };
    const assetModeResolver = new AssetModeResolver(preflightStateBackend, accountId, {
      ...(options.profile && { profile: options.profile }),
      ...(useCdkBootstrapAssets && { useCdkBootstrapAssets: true }),
      // Never under --skip-assets: assets already published to the legacy
      // destinations would be rewritten to a freshly created EMPTY
      // bucket/repo with nothing re-publishing them, so a deploy that
      // worked before would start failing at resource CREATE (reviewer
      // catch on PR 1008).
      ...(autoAssetStorage &&
        !options.dryRun &&
        !options.skipAssets && {
          autoCreate: { confirm: confirmAutoAssetStorage },
        }),
    });
    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    const dagBuilder = new DagBuilder({
      relaxCdkVpcDefensiveDeps: !!options.aggressiveVpcParallel,
    });
    const diffCalculator = new DiffCalculator();

    // Build work graph
    const workGraph = new WorkGraph();
    // A stack's work-graph key: its physical name, plus its region when
    // another stack in this deploy shares that name (#5176). The collision
    // refusal above makes (name, region) unique, and a deploy without a
    // shared name keeps the node ids it always had.
    const sharedNames = new Set(
      targetStacks.map((s) => s.stackName).filter((name, i, names) => names.indexOf(name) !== i)
    );
    const graphKey = (s: (typeof targetStacks)[number]): string =>
      sharedNames.has(s.stackName)
        ? `${s.stackName}@${stackRegions.get(s) ?? deployStackRegion(s, baseRegion)}`
        : s.stackName;
    // Issue #1002 PR 2 — per-stack §6 mapping table for stacks whose region
    // is in cdkd-assets mode. Consumed by the deploy engine's
    // post-resolution audit + the NestedStackProvider context below. Keyed
    // by stack object: two regions' asset storage differ (#5176).
    const stackRedirects = new Map<(typeof targetStacks)[number], AssetRedirectMap>();

    await addStacksToWorkGraph({
      targetStacks,
      graphKey,
      stackRegions,
      baseRegion,
      assetModeResolver,
      rawNamedRegion,
      logger,
      accountId,
      stackRedirects,
      options,
      assetPublisher,
      workGraph,
      dependencyStacks,
      inferredCrossStackDeps,
    });

    const summary = workGraph.summary();
    logger.debug(`Work graph: ${summary['asset-publish']} asset(s), ${summary['stack']} stack(s)`);

    // Buffer per-stack log output when more than one stack will deploy
    // concurrently. Without this, two stacks' `logger.info(...)` lines
    // interleave: stack A's "Changes: 4 to create" / "Deploying 4
    // resource(s)" lands between stack B's `[N/N] ✅ ...` rows, and
    // stack B's "Deployment completed" prints after stack A's late
    // progress. The buffer captures everything for the duration of one
    // stack and flushes it as one block — clean per-stack groups.
    const bufferStackOutput = targetStacks.length > 1;

    // Issue #1960: resources this deploy left unaddressed, summed across every
    // stack in the run — a DELETE the provider refused to issue (#1762) plus a
    // replacement whose predecessor survived (#1819). Accumulated here rather
    // than thrown per stack so a multi-stack deploy still runs its remaining
    // stacks: neither case is a resource FAILURE, and stopping the run would
    // be a bigger behavior change than the exit code this counter feeds.
    // Mirrors `totalSkipped` in src/cli/commands/destroy/command.ts, which has driven
    // destroy's exit 2 for the identical outcome since #1752.
    //
    // Nested stacks included (issue #1989): a top-level engine's
    // `deleteSkipped` / `updatePartial` already carry every nested-stack
    // descendant's own counts, so a resource left unaddressed at any depth
    // reaches this counter and the exit code.
    let totalUnaddressed = 0;
    // go-to-k/cdkd#4705: the part of it the cross-prefix check kept.
    let totalCrossPrefixKept = 0;
    // Stacks that never ran: the user declined the prefix-migration gate, or an
    // interrupt landed before the stack started. Both unwind through
    // `DeployCancelledError` with a bare `return`, so the work-graph node
    // COMPLETES and the run reaches the unaddressed check below. Counted so the
    // message cannot imply the deploy otherwise finished -- before #1960 the run
    // exited 0 and was equally silent about it, but a message that now says
    // "Deploy left N resource(s) unaddressed" and nothing else actively reads as
    // "everything else was applied".
    let cancelledStacks = 0;
    // `--outputs-file`: each deployed stack's Outputs, keyed by physical stack
    // name like the AWS CDK CLI. Stacks finish concurrently, but each writes
    // only its own key.
    const stackOutputs: StackOutputsByStack = {};

    const runStack = async (stackInfo: (typeof targetStacks)[0]): Promise<void> => {
      // Wrap the entire per-stack deploy body in withSkipPrefix so every
      // `generateResourceName(name, { userSupplied: true })` call inside
      // the provider chain sees the resolved flag via AsyncLocalStorage.
      // The inner `withStackScope(...)` lives in DeployEngine.deploy; the
      // two stores are independent so order does not matter, but
      // outer-skipPrefix / inner-stackName keeps the call-site readable.
      return withSkipPrefix(skipPrefix, () => runStackInner(stackInfo));
    };

    const runStackInner = async (stackInfo: (typeof targetStacks)[0]): Promise<void> => {
      // An interrupt (Ctrl-C, or SIGTERM forwarded per issue #1342) that
      // landed BEFORE this stack's engine registered its own SIGINT handler
      // only set the flag — without this gate the deploy would proceed to
      // acquire the lock and start provisioning after the user asked it to
      // stop (in SIGTERM-only CI the follow-up signal is SIGKILL, which
      // would then land mid-provisioning while the lock is held).
      if (deployInterrupted) {
        throw new DeployCancelledError(
          `Deploy interrupted before stack '${stackInfo.stackName}' started — not starting it.`
        );
      }
      const stackRegion = stackRegions.get(stackInfo) ?? deployStackRegion(stackInfo, baseRegion);

      logger.info(
        `\n${cyan('Deploying stack:')} ${bold(cyan(stackInfo.stackName))}${stackRegion !== baseRegion ? gray(` (region: ${stackRegion})`) : ''}`
      );

      // The stack's clients and region reach its providers through a stack AWS
      // scope (issue #1981), NOT by re-pointing the process-global
      // `setAwsClients` singleton and `process.env.AWS_REGION`: with
      // `--stack-concurrency` > 1 those globals belong to whichever stack
      // switched them last, so a provider call after any `await` could run
      // against a sibling stack's region. The scope follows this stack's own
      // async chain; see src/utils/stack-aws-scope.ts.
      const stackAwsClients = new AwsClients({
        region: stackRegion,
        ...(options.profile && { profile: options.profile }),
      });
      return runWithStackAwsClients(stackAwsClients, () =>
        deployStackInScope(stackDeployContext, stackInfo, stackRegion, stackAwsClients)
      );
    };

    const stackDeployContext: DeployStackContext = {
      providerClasses,
      logger,
      options,
      baseRegion,
      stateConfig,
      stateBucket,
      skipPrefix,
      refusalRecovery,
      crossPrefixGuard,
      preflightStateBackend,
      stackRedirects,
      producerLookup,
      approveDeployment,
      requireApproval,
      dagBuilder,
      diffCalculator,
      exportIndexStore,
      accountId,
      outputsFile,
      stackOutputs,
      addUnaddressed: (stackUnaddressed, crossPrefixKept) => {
        totalUnaddressed += stackUnaddressed;
        totalCrossPrefixKept += crossPrefixKept;
      },
      addCancelledStack: () => {
        cancelledStacks++;
      },
      inRunStacks: new Set(
        targetStacks.map((s) =>
          inRunStackKey(s.stackName, stackRegions.get(s) ?? deployStackRegion(s, baseRegion))
        )
      ),
    };

    checkPinCcApiOptions(options, targetStacks, logger);

    runClock.lap('work graph build, recreate checks');
    // Execute work graph
    let workGraphCompleted = false;
    try {
      await workGraph.execute(
        {
          'asset-build': options.imageBuildConcurrency,
          'asset-publish': options.assetPublishConcurrency,
          stack: options.stackConcurrency,
        },
        async (node) => {
          if (node.type === 'asset-build' || node.type === 'asset-publish') {
            await timePhase('run', node.type, () => assetPublisher.executeNode(node), node.id);
          } else {
            const { stack: stackInfo } = node.data as { stack: (typeof targetStacks)[0] };

            if (!bufferStackOutput) {
              await runStack(stackInfo);
              return;
            }

            // Multi-stack run: buffer this stack's log lines and flush
            // them as one atomic block when the deploy finishes.
            const outcome = await runStackBuffered(() => runStack(stackInfo));
            if (outcome.lines.length > 0) {
              process.stdout.write(outcome.lines.join('\n') + '\n');
            }
            if (!outcome.ok) throw outcome.error;
          }
        }
      );
      workGraphCompleted = true;
    } finally {
      // go-to-k/cdkd#5819: written on failure too, carrying the stacks that did
      // deploy (the AWS CDK CLI's stated intent; its toolkit-lib writes in a
      // `finally`). Before the unaddressed check below, so an exit-2 run still
      // writes it.
      if (outputsFile !== undefined) {
        writeStackOutputsFile(outputsFile, stackOutputs, { deployFailed: !workGraphCompleted });
      }
    }

    // Issue #1960: every stack deployed without a resource FAILING, but at
    // least one resource cdkd was responsible for went unaddressed. Exiting 0
    // here is the mis-report this issue was filed for — `cdkd destroy` has
    // exited 2 for the identical outcome since #1752, and a pipeline reading
    // only the exit code would be told the template was applied when it was
    // not. Placed AFTER `workGraph.execute` so a genuine deploy failure (which
    // rejects out of `execute` and exits 1) keeps precedence: the same order
    // destroy/command.ts uses, where `totalErrors` is checked before `totalSkipped`.
    if (totalUnaddressed > 0 && !options.allowUnaddressed) {
      throw new PartialFailureError(
        `Deploy left ${totalUnaddressed} resource(s) unaddressed, so they may still exist in ` +
          `AWS. The two cases differ in what happens next: a DELETE the provider could not ` +
          `issue KEEPS its state record, so the next 'cdkd deploy' re-attempts it, while a ` +
          `replacement's surviving predecessor is NOT tracked and will never be retried — ` +
          `delete it by hand. ` +
          // go-to-k/cdkd#4705: only when such a replacement was kept, so an
          // ordinary exit 2 reads as it always has.
          (totalCrossPrefixKept > 0
            ? `A replacement kept because another state prefix records the stack, or the ` +
              `check could not run, keeps its old resource and applies no new value — ` +
              `resolve the pair, or let the check run, and re-deploy. `
            : '') +
          `The per-stack summaries above give the breakdown, and each ` +
          `resource's own warning names its cause and remedy. ` +
          (cancelledStacks > 0
            ? `Note ${cancelledStacks} stack(s) were also cancelled and never deployed, so the ` +
              `template is not fully applied beyond the resources named above. `
            : '') +
          `Pass --allow-unaddressed to exit 0 instead.`
      );
    }
  } finally {
    runClock.lap('assets + stacks, summary');
    unforwardSigterm();
    process.removeListener('SIGINT', topLevelSigintHandler);
    awsClients.destroy();
    preflightBackendForCleanup?.destroyClient();
    // go-to-k/cdkd#5200: on every path, so a failed deploy reports too.
    for (const line of renderPhaseTimings()) logger.info(line);
  }
}
