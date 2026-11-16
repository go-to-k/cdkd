import { AssetPublisher } from '../../../assets/asset-publisher.js';
import { AssetModeResolver } from '../../../assets/asset-storage.js';
import {
  buildAssetRedirectMap,
  loadPublishableAssetManifest,
  rewriteTemplateAssetReferences,
  type AssetRedirectMap,
} from '../../../assets/asset-redirect.js';
import {
  legacyPlanAssetCount,
  predictedAutoCreatedAssetMode,
  prepareLegacyStackAssets,
} from '../../../assets/legacy-synthesizer-assets.js';
import { WorkGraph } from '../../../deployment/work-graph.js';
import { deployStackRegion } from '../cross-prefix-gate.js';
import type { DeployCommandOptions } from './types.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import type { ConsoleLogger } from '../../../utils/logger.js';

/**
 * Adds every target stack, with its asset-publish nodes and its inter-stack
 * edges, to the run's work graph, and records each cdkd-assets stack's
 * redirect map in `stackRedirects`.
 */
export async function addStacksToWorkGraph(args: {
  targetStacks: StackInfo[];
  graphKey: (s: StackInfo) => string;
  stackRegions: Map<StackInfo, string>;
  baseRegion: string;
  assetModeResolver: AssetModeResolver;
  rawNamedRegion: string | undefined;
  logger: ConsoleLogger;
  accountId: string;
  stackRedirects: Map<StackInfo, AssetRedirectMap>;
  options: DeployCommandOptions;
  assetPublisher: AssetPublisher;
  workGraph: WorkGraph;
  dependencyStacks: (
    stack: StackInfo,
    inferred: Map<StackInfo, Set<StackInfo>>,
    pool: readonly StackInfo[]
  ) => Set<StackInfo>;
  inferredCrossStackDeps: Map<StackInfo, Set<StackInfo>>;
  /**
   * `--dry-run` where the real deploy would auto-create a region's missing
   * asset storage (#1007): a legacy-synthesizer stack's parameters then show
   * the default cdkd bucket the real deploy binds (#6421).
   */
  dryRunPredictsAutoCreatedStorage?: boolean;
}): Promise<void> {
  const {
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
    dryRunPredictsAutoCreatedStorage = false,
  } = args;
  for (const stack of targetStacks) {
    const stackNodeId = `stack:${graphKey(stack)}`;
    const stackDeps = new Set<string>();

    // Asset-mode resolution + §6 mapping table + §7 template rewrite +
    // asset-publish nodes. `loadPublishableAssetManifest` returns null on
    // a missing manifest OR one with nothing cdkd would publish, so
    // asset-less deploys stay byte-identical (no marker read, no
    // legacy-mode info line). The mode resolution + rewrite run even
    // under --skip-assets: assets already published (e.g. via
    // `cdkd publish-assets`) live in cdkd storage once the region is
    // opted in, so skipping the rewrite would deploy split-brain
    // references that the audit then rejects.
    if (stack.assetManifestPath) {
      const assetRegion = stackRegions.get(stack) ?? deployStackRegion(stack, baseRegion);
      const manifest = loadPublishableAssetManifest(stack.assetManifestPath);
      if (manifest) {
        // The RAW spelling travels to the marker read (its second probe is what
        // finds a key an unfolded `cdkd bootstrap` wrote); the resolver folds
        // internally and every other consumer below uses `assetRegion`.
        const assetMode = await assetModeResolver.resolve(
          stack.region || rawNamedRegion || assetRegion
        );
        logger.debug(
          `Asset mode for region ${assetRegion}: ${assetMode.mode} (stack ${stack.stackName})`
        );
        let redirect: AssetRedirectMap | undefined;
        if (assetMode.mode === 'cdkd-assets') {
          redirect = buildAssetRedirectMap(manifest, assetMode.marker, accountId, assetRegion);
          if (redirect.entries.length > 0) {
            stackRedirects.set(stack, redirect);
            const rewritten = rewriteTemplateAssetReferences(stack.template, redirect);
            logger.debug(
              `Rewrote ${rewritten} asset reference(s) to cdkd asset storage ` +
                `(${assetMode.marker.assetBucket} / ${assetMode.marker.containerRepo}) ` +
                `in template of stack ${stack.stackName}`
            );
          } else {
            redirect = undefined;
          }
        }
        if (!options.skipAssets) {
          const nodeIds = assetPublisher.addAssetsToGraph(workGraph, stack.assetManifestPath, {
            accountId,
            region: assetRegion,
            ...(options.profile && { profile: options.profile }),
            nodePrefix: `${graphKey(stack)}:`,
            ...(redirect && { redirect }),
            // The app's outdir, NOT the manifest's directory: a Stage's
            // assets are staged into the app root and its `source.path` is
            // `../asset.<hash>` (go-to-k/cdkd#3489).
            ...(stack.assetOutdir !== undefined && { assetOutdir: stack.assetOutdir }),
          });
          for (const id of nodeIds) {
            stackDeps.add(id);
          }
        }
      }
    }

    // Issue #6421 — a LegacyStackSynthesizer stack has no asset manifest:
    // its assets are `aws:cdk:asset` metadata plus template parameters the
    // deploying tool supplies. Mode first, as above, so the bucket the bound
    // parameters name is the one the objects go to; bound even under
    // --skip-assets (the CDK CLI computes them regardless).
    if (stack.legacyAssets) {
      const assetRegion = stackRegions.get(stack) ?? deployStackRegion(stack, baseRegion);
      const plan = await prepareLegacyStackAssets(stack, {
        assetMode: async () => {
          const mode = await assetModeResolver.resolve(
            stack.region || rawNamedRegion || assetRegion
          );
          // A dry run never auto-creates storage (no marker reads as legacy),
          // but the real deploy would, and bind the cdkd bucket: show that.
          return mode.mode === 'legacy' && dryRunPredictsAutoCreatedStorage
            ? predictedAutoCreatedAssetMode(accountId, assetRegion)
            : mode;
        },
        accountId,
        region: assetRegion,
      });
      if (plan && !options.skipAssets && legacyPlanAssetCount(plan) > 0) {
        const nodeIds = assetPublisher.addManifestToGraph(workGraph, plan.manifest, {
          accountId,
          region: assetRegion,
          ...(options.profile && { profile: options.profile }),
          nodePrefix: `${graphKey(stack)}:`,
          cdkOutputDir: stack.legacyAssets.assemblyDir,
          ...(stack.assetOutdir !== undefined && { assetOutdir: stack.assetOutdir }),
          bucketsChosenByCdkd: true,
          recognizedRepositories: plan.recognizedRepositories,
          repositoriesToEnsure: plan.repositoriesToEnsure,
        });
        for (const id of nodeIds) {
          stackDeps.add(id);
        }
      }
    }

    // Add inter-stack dependencies: the UNION of CDK manifest deps
    // (`dependencyNames`) and inferred raw cross-stack references, so a
    // consumer waits for its producer even without an explicit
    // `addDependency`. Only edges between stacks in this deploy set are
    // added, each to the producer the dependent's Stage holds (#5176).
    for (const depStack of dependencyStacks(stack, inferredCrossStackDeps, targetStacks)) {
      stackDeps.add(`stack:${graphKey(depStack)}`);
    }

    workGraph.addNode({
      id: stackNodeId,
      type: 'stack',
      dependencies: stackDeps,
      state: 'pending',
      data: { stack },
    });
  }
}
