import { readFileSync } from 'node:fs';
import { parseContextOptions, warnIfDeprecatedRegion } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../../synthesis/synthesizer.js';
import { refuseFailedLookups } from '../../../synthesis/failed-lookups.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { LockManager } from '../../../state/lock-manager.js';
import {
  buildLockContentionMessage,
  type LockRecoveryContext,
} from '../../../state/lock-contention-message.js';
import { refuseMalformedState } from '../../../state/malformed-resources-bag.js';
import { DiffCalculator } from '../../../analyzer/diff-calculator.js';
import { parseMappingFile, type MappingEnvironment } from '../../../analyzer/refactor-pairing.js';
import {
  createAssetRedirectResolver,
  rewriteTemplateAssetReferences,
} from '../../../assets/asset-redirect.js';
import { setAwsClients, AwsClients } from '../../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../../utils/role-arn.js';
import {
  exportInferredRegionForSdk,
  foldRegionOption,
  legacyStateBucketFallbackRegion,
  resolveEffectiveRegion,
  stackRegionResolver,
} from '../../region-options.js';
import {
  resolveApp,
  resolveStateBucketWithDefault,
  resolveUseCdkBootstrapAssets,
} from '../../config-loader.js';
import {
  matchStacks,
  describeStack,
  partitionTopLevel,
  renderAllLeftOutStageStacks,
  renderAllNoTopLevelStacks,
  renderNoStackMatch,
} from '../../stack-matcher.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../provisioning/register-providers.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import { makeCanonicalizePropertiesFn } from '../../../provisioning/canonicalize-properties.js';
import { getAccountInfo } from '../../../deployment/intrinsic-resolver/account-drain.js';
import { producerLookupOver } from '../../../deployment/intrinsic-resolver/cdk-cross-account-ref.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import { confirmOrRefuse } from '../confirm-prompt.js';
import { computeStackDiff } from '../diff-recursive.js';
import { withDeferredInterrupts } from '../../../utils/deferred-interrupts.js';
import {
  applyMoveGroup,
  finishInterruptedMoves,
  planMoves,
  renderMovePlan,
  type AmbiguousMoveGroup,
} from '../refactor-move.js';
import { planStackRefactor, type RefactorDiffFn, type StackRefactorPlan } from './plan.js';
import {
  applyStackRefactor,
  rollbackJournalRefusal,
  renderRefactorPlan,
  sampleMappingFile,
  overridesForStack,
  moveOverridesOf,
  envKey,
} from './apply.js';

export interface RefactorOptions {
  app?: string;
  output: string;
  stateBucket?: string;
  statePrefix: string;
  stack?: string;
  all?: boolean;
  dryRun?: boolean;
  overrideFile?: string;
  revert?: boolean;
  force?: boolean;
  yes?: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
  context?: string[];
  useCdkBootstrapAssets?: boolean;
  cfnFallback?: boolean;
}

export async function refactorCommand(stacks: string[], options: RefactorOptions): Promise<void> {
  const providerClasses = await loadProviderClasses();
  const logger = getLogger();
  const holdNotice = (signal: NodeJS.Signals): void => {
    logger.warn(
      safeMsg`${signal} received: finishing the cdkd state writes already started (a few S3 ` +
        'writes), then stopping.'
    );
  };
  if (options.verbose) logger.setLevel('debug');
  if (options.revert === true && options.overrideFile === undefined) {
    throw new CdkdError('--revert requires --override-file', 'INCOMPATIBLE_OPTIONS');
  }

  warnIfDeprecatedRegion(options);
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }

  // Read before any AWS call, so a malformed file costs nothing.
  let environments: MappingEnvironment[] = [];
  if (options.overrideFile !== undefined) {
    let text: string;
    try {
      text = readFileSync(options.overrideFile, 'utf-8');
    } catch {
      throw new CdkdError(
        safeMsg`Cannot read the mapping file ${options.overrideFile}`,
        'REFACTOR_MAPPING_FILE'
      );
    }
    try {
      environments = parseMappingFile(text);
    } catch (error) {
      throw new CdkdError(
        safeMsg`Invalid mapping file ${options.overrideFile}: ${(error as Error).message}`,
        'REFACTOR_MAPPING_FILE'
      );
    }
  }

  const effectiveRegion = await resolveEffectiveRegion(options);
  exportInferredRegionForSdk(effectiveRegion);
  const region = effectiveRegion.region;
  const stateBucket = await resolveStateBucketWithDefault(
    options.stateBucket,
    region,
    legacyStateBucketFallbackRegion(effectiveRegion)
  );

  const awsClients = new AwsClients({
    region: effectiveRegion.region,
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    logger.info(synthesisStatusMessage(app, 'Synthesizing CDK app...'));
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const synthOptions: SynthesisOptions = {
      app,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
      stateBucket,
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
      deferMacroExpansion: true,
      failedLookupsCheckedByCaller: true,
    };
    const { stacks: allStacks, failedLookups } = await synthesizer.synthesize(synthOptions);
    const targetStacks = selectStacks(allStacks, stacks, options);
    // A failed context lookup blocks only the stacks it refactors (go-to-k/cdkd#5807).
    refuseFailedLookups(targetStacks, allStacks, failedLookups);
    await synthesizer.expandMacrosForStacks(targetStacks, synthOptions);

    const stateConfig = { bucket: stateBucket, prefix: options.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      region,
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);
    const recovery: LockRecoveryContext = {
      profile: options.profile,
      stateBucket,
      statePrefix: options.statePrefix,
    };
    const regionForStack = stackRegionResolver({
      effective: effectiveRegion,
      probe: stateBackend,
      logger,
      siblings: allStacks.filter((s) => !s.region).map((s) => s.stackName),
    });
    const diffCalculator = new DiffCalculator();
    const registry = new ProviderRegistry();
    registerAllProviders(registry, providerClasses);
    const canonicalizeProperties = makeCanonicalizePropertiesFn(registry);
    const producerLookup = producerLookupOver(allStacks);
    const resolveAssetRedirect = createAssetRedirectResolver({
      stateBackend,
      stsRegion: region,
      ...(options.profile && { profile: options.profile }),
      useCdkBootstrapAssets: resolveUseCdkBootstrapAssets(options.useCdkBootstrapAssets),
      suppressLegacyNotice: true,
    });
    let callerAccount: string | undefined;
    const accountOf = async (stackInfo: StackInfo): Promise<string> => {
      if (stackInfo.account) return stackInfo.account;
      callerAccount ??= (await getAccountInfo()).accountId;
      return callerAccount;
    };

    // An earlier `cdkd refactor` interrupted mid-move (go-to-k/cdkd#5212):
    // finish every one involving a selected stack before ANY stack is
    // planned, since finishing one writes its destination's record too.
    const selectedStacks: Array<{ stackName: string; region: string }> = [];
    for (const stackInfo of targetStacks) {
      selectedStacks.push({
        stackName: stackInfo.stackName,
        region: await regionForStack(stackInfo.stackName, stackInfo.region),
      });
    }
    const templateOf = (stackName: string, region: string): CloudFormationTemplate | undefined =>
      allStacks.find(
        (s) => s.stackName === stackName && (s.region === undefined || s.region === region)
      )?.template;
    const { finished: finishedMoves, pending: pendingMoves } = await withDeferredInterrupts(
      () =>
        finishInterruptedMoves({
          selected: selectedStacks,
          templateOf,
          dryRun: options.dryRun === true,
          stateBackend,
          lockManager,
          recovery,
          contentionMessage: (st) =>
            buildLockContentionMessage({
              lockManager,
              stackName: st.stackName,
              region: st.region,
              recovery,
            }),
        }),
      holdNotice
    );
    for (const f of finishedMoves) {
      logger.info(
        safeMsg`Finished an interrupted move: ${f.fromStack}.${f.from} -> ${f.toStack}.${f.to}`
      );
    }
    if (pendingMoves.length > 0) {
      for (const f of pendingMoves) {
        logger.info(
          safeMsg`An interrupted move would be finished: ${f.fromStack}.${f.from} -> ${f.toStack}.${f.to}`
        );
      }
      logger.info(
        '\n--dry-run: state was NOT written. Re-run without --dry-run to finish these moves; the ' +
          'refactor plan is computed after them.'
      );
      return;
    }

    const plans: StackRefactorPlan[] = [];
    const planStacks = new Map<StackRefactorPlan, StackInfo>();
    for (const stackInfo of targetStacks) {
      const stackRegion = await regionForStack(stackInfo.stackName, stackInfo.region);
      const stateData = await stateBackend.getState(stackInfo.stackName, stackRegion);
      if (!stateData) {
        logger.info(
          safeMsg`Stack ${stackInfo.stackName} (${stackRegion}) has no cdkd state: nothing to refactor.`
        );
        continue;
      }
      refuseMalformedState(stateData.state, stackInfo.stackName, stackRegion, recovery);
      if ((await stateBackend.loadRollbackJournal(stackInfo.stackName, stackRegion)) !== null) {
        throw rollbackJournalRefusal(stackInfo.stackName, stackRegion);
      }
      const assetRedirect = await resolveAssetRedirect(stackInfo.assetManifestPath, stackRegion);
      if (assetRedirect) rewriteTemplateAssetReferences(stackInfo.template, assetRedirect);

      const overrides =
        environments.length === 0
          ? []
          : overridesForStack(
              environments,
              stackInfo.stackName,
              await accountOf(stackInfo),
              stackRegion,
              options.revert === true
            );
      const diff: RefactorDiffFn = async (state) => {
        const result = await computeStackDiff(
          state,
          stackInfo.template,
          stackRegion,
          stackInfo.stackName,
          stateBackend,
          diffCalculator,
          {
            canonicalizeProperties,
            ...(options.cfnFallback === false && { cfnFallback: false }),
            producerLookup,
            ...(stackInfo.account && { consumerAccount: stackInfo.account }),
            refusalRecovery: recovery,
            inheritSecretBearingTemplate: false,
            previewMaskedInputs: true,
            ...(stackInfo.nestedTemplates && { nestedTemplates: stackInfo.nestedTemplates }),
          }
        );
        return { changes: result.changes, blocking: result.blocking };
      };
      const plan = await planStackRefactor({
        stackName: stackInfo.stackName,
        region: stackRegion,
        state: stateData.state,
        etag: stateData.etag,
        template: stackInfo.template,
        overrides,
        diff,
        recovery,
      });
      plans.push(plan);
      planStacks.set(plan, stackInfo);
    }

    // Moves between stacks (go-to-k/cdkd#5202), over the rows no in-stack
    // rename took. Only a run that selected two or more stacks can move.
    const accountByPlan = new Map<StackRefactorPlan, string>();
    if (plans.length > 1) {
      for (const plan of plans) accountByPlan.set(plan, await accountOf(planStacks.get(plan)!));
    }
    const movePlan =
      plans.length > 1
        ? await planMoves(
            plans,
            (plan) => envKey(accountByPlan.get(plan), plan.region),
            moveOverridesOf(environments, new Set(accountByPlan.values()), options.revert === true)
          )
        : { moves: [], differing: [], refused: [], ambiguous: [] as AmbiguousMoveGroup[] };
    if (plans.length <= 1 && environments.length > 0) {
      // A named move with fewer than two stacks selected can never apply.
      const lone = moveOverridesOf(
        environments,
        new Set(plans.length === 1 ? [await accountOf(planStacks.get(plans[0]!)!)] : []),
        options.revert === true
      );
      for (const o of lone) {
        movePlan.refused.push({
          fromStack: o.fromStack,
          from: o.from,
          toStack: o.toStack,
          to: o.to,
          reason: 'a move needs both stacks selected; name both, or pass --all',
        });
      }
    }

    for (const plan of plans) for (const line of renderRefactorPlan(plan)) logger.info(line);
    for (const line of renderMovePlan(movePlan)) logger.info(line);

    if (plans.some((p) => p.ambiguous.length > 0) || movePlan.ambiguous.length > 0) {
      const withAccounts = [];
      for (const plan of plans) {
        if (plan.ambiguous.length === 0) continue;
        withAccounts.push({ plan, account: await accountOf(planStacks.get(plan)!) });
      }
      const moveGroups = [];
      for (const group of movePlan.ambiguous) {
        moveGroups.push({ group, account: await accountOf(planStacks.get(group.plan)!) });
      }
      logger.info(
        '\nA mapping file naming each ambiguous pair (edit the pairs, then pass it with ' +
          '--override-file):'
      );
      for (const line of sampleMappingFile(withAccounts, moveGroups).split('\n')) {
        logger.info(displaySafe(line));
      }
      throw new CdkdError(
        'cdkd refactor found resources it cannot pair on its own; nothing was written. ' +
          'Name each ambiguous pair in a mapping file and re-run with --override-file.',
        'REFACTOR_AMBIGUOUS'
      );
    }
    const refused = [...plans.flatMap((p) => p.refusedOverrides), ...movePlan.refused];
    if (refused.length > 0) {
      throw new CdkdError(
        `cdkd refactor refused ${refused.length} pair(s) the mapping file names; nothing was ` +
          'written. Fix or remove each refused pair in the mapping file (the reasons are ' +
          'above), then re-run cdkd refactor.',
        'REFACTOR_REFUSED'
      );
    }
    const toApply = plans.filter(
      (p) => p.renames.length > 0 || p.movesOut.length > 0 || p.movesIn.length > 0
    );
    if (toApply.length === 0) {
      logger.info('\nNothing to refactor.');
      return;
    }
    if (options.dryRun) {
      logger.info('\n--dry-run: state was NOT written. Re-run without --dry-run to apply.');
      return;
    }
    const count = toApply.reduce((n, p) => n + p.renames.length, 0) + movePlan.moves.length;
    if (!options.yes && !options.force) {
      const ok = await confirmOrRefuse(
        `\nRename or move ${count} resource(s) in cdkd state as listed above? AWS resources ` +
          'are not touched.',
        {
          refusal:
            'The cdkd refactor confirmation prompt cannot run in a non-interactive ' +
            'environment. Pass -y / --yes (or -f / --force) to confirm, or run the command ' +
            'from a real terminal.',
        }
      );
      if (!ok) {
        logger.info('Refactor cancelled.');
        return;
      }
    }
    if (movePlan.moves.length > 0) {
      // Every stack of the run as one unit: a move writes two records.
      await withDeferredInterrupts(
        () =>
          applyMoveGroup({
            plans: toApply,
            stateBackend,
            lockManager,
            recovery,
            contentionMessage: (plan) =>
              buildLockContentionMessage({
                lockManager,
                stackName: plan.stackName,
                region: plan.region,
                recovery,
              }),
          }),
        holdNotice
      );
      logger.info(
        safeMsg`Refactored ${count} resource(s) across ${toApply.length} stack(s): ` +
          safeMsg`${toApply.map((p) => `${p.stackName} (${p.region})`).join(', ')}.`
      );
      logger.info(
        "\nAWS resources were not touched. Run 'cdkd diff' to confirm the refactored resources " +
          'show no change, and deploy the destination stacks before the stacks that import from them.'
      );
      return;
    }
    const done: string[] = [];
    for (const plan of toApply) {
      try {
        await withDeferredInterrupts(
          () =>
            applyStackRefactor({
              plan,
              stateBackend,
              lockManager,
              recovery,
              contentionMessage: () =>
                buildLockContentionMessage({
                  lockManager,
                  stackName: plan.stackName,
                  region: plan.region,
                  recovery,
                }),
            }),
          holdNotice
        );
      } catch (error) {
        if (done.length > 0) {
          logger.error(
            safeMsg`Already refactored before this failure, and kept: ${done.join(', ')}.`
          );
        }
        throw error;
      }
      done.push(`${plan.stackName} (${plan.region})`);
      logger.info(
        safeMsg`Refactored ${plan.renames.length} resource(s) in stack ${plan.stackName} (${plan.region}).`
      );
    }
    logger.info(
      "\nAWS resources were not touched. Run 'cdkd diff' to confirm the renamed resources show no change."
    );
  } finally {
    awsClients.destroy();
  }
}

/** Stack selection, as `cdkd diff` selects. */
function selectStacks(
  allStacks: StackInfo[],
  stacks: string[],
  options: Pick<RefactorOptions, 'all' | 'stack'>
): StackInfo[] {
  const logger = getLogger();
  const stackPatterns = stacks.length > 0 ? stacks : options.stack ? [options.stack] : [];
  if (allStacks.length === 0) throw new Error(renderNoStackMatch(stackPatterns, allStacks));
  let targetStacks: StackInfo[];
  if (options.all) {
    const { topLevel, inStages } = partitionTopLevel(allStacks);
    if (topLevel.length === 0) throw new Error(renderAllNoTopLevelStacks(inStages));
    if (inStages.length > 0) logger.info(renderAllLeftOutStageStacks(inStages));
    targetStacks = topLevel;
  } else if (stackPatterns.length > 0) {
    targetStacks = matchStacks(allStacks, stackPatterns, { dedupe: 'identity' });
  } else if (allStacks.length === 1) {
    targetStacks = allStacks;
  } else {
    throw new Error(
      `Multiple stacks found: ${allStacks.map(describeStack).join(', ')}. ` +
        `Specify stack name(s) or use --all (top-level stacks; '**' for every stack)`
    );
  }
  if (targetStacks.length === 0) throw new Error(renderNoStackMatch(stackPatterns, allStacks));
  return targetStacks;
}
