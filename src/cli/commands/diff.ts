import { Command, InvalidArgumentError, Option } from 'commander';
import { withPrintingSecrets } from '../../deployment/resource-secrets-scope.js';
import { orphanRecordsPrintingBag } from '../../deployment/secret-name-needles.js';
import {
  appOptions,
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  stackOptions,
  contextOptions,
  parseContextOptions,
  useCdkBootstrapAssetsOption,
  noCfnFallbackOption,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { withErrorHandling, CdkdError } from '../../utils/error-handler.js';
import { nullPrototypeRecord } from '../../utils/own-keys.js';
import { safeMsg, stringifyJsonPayload } from '../../utils/display-safe.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { DiffCalculator } from '../../analyzer/diff-calculator.js';
import {
  createAssetRedirectResolver,
  rewriteTemplateAssetReferences,
} from '../../assets/asset-redirect.js';
import { setAwsClients, AwsClients, runWithStackAwsClients } from '../../utils/aws-clients.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { foldRegionOption, namedCliRegion } from '../region-options.js';
import {
  resolveApp,
  resolveStateBucketWithDefault,
  resolveUseCdkBootstrapAssets,
} from '../config-loader.js';
import {
  matchStacks,
  describeStack,
  partitionTopLevel,
  renderAllLeftOutStageStacks,
  renderAllNoTopLevelStacks,
  renderNoStackMatch,
} from '../stack-matcher.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../provisioning/register-providers.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { makeCanonicalizePropertiesFn } from '../../provisioning/canonicalize-properties.js';
import { planOrphanAdoption, makeSiblingClaimReader } from '../../deployment/orphan-adoption.js';
import { explicitNamePropertyFor } from '../../provisioning/resource-name.js';
import { createReadOnlyAttributeHealerFactory } from '../../deployment/read-only-attribute-healer.js';
import type { ResourceState, StackState } from '../../types/state.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  buildDiffTree,
  diffTreeToJson,
  renderDiffTree,
  treeHasChanges,
  countBlocking,
  treeDestructiveChanges,
  treeIsWorthRendering,
  type DiffTreeNode,
} from './diff-recursive.js';
import { formatDestructiveChange } from '../../analyzer/destructive-changes.js';

/**
 * The `--fail-on` values: which kind of change makes `cdkd diff` exit 1. The
 * AWS CDK CLI's `cdk diff --fail-on` (aws/aws-cdk-cli#2020, #2011) also takes
 * `broadening`, which cdkd does not offer: it has no security diff to decide it.
 */
export const DIFF_FAIL_ON_VALUES = ['never', 'any-change', 'destructive'] as const;
export type DiffFailOn = (typeof DIFF_FAIL_ON_VALUES)[number];

/**
 * Parse one `--fail-on` value. A REPEATED `--fail-on` is refused rather than
 * letting the last one win, as upstream refuses it: a CI gate written as
 * `--fail-on=destructive --fail-on=never` would otherwise be silently disabled.
 */
export function parseFailOn(value: string, previous: DiffFailOn | undefined): DiffFailOn {
  if (previous !== undefined) {
    throw new InvalidArgumentError(`--fail-on can only be given once, got: ${previous}, ${value}`);
  }
  if (!(DIFF_FAIL_ON_VALUES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Allowed choices are ${DIFF_FAIL_ON_VALUES.join(', ')}.`);
  }
  return value as DiffFailOn;
}

/**
 * Fold `--fail` / `--no-fail` / `--fail-on` into one value. `--fail` is an
 * alias for `any-change` and `--no-fail` for `never`; combining either with
 * `--fail-on` is refused, naming the equivalent `--fail-on` value, as upstream
 * does. Neither given: `never`, the default `cdkd diff` has always had.
 */
export function resolveFailOn(options: { fail?: boolean; failOn?: DiffFailOn }): DiffFailOn {
  if (options.failOn !== undefined && options.fail !== undefined) {
    throw new CdkdError(
      options.fail
        ? '--fail cannot be used with --fail-on, use --fail-on=any-change instead of --fail'
        : '--no-fail cannot be used with --fail-on, use --fail-on=never instead of --no-fail',
      'INCOMPATIBLE_OPTIONS'
    );
  }
  if (options.failOn !== undefined) return options.failOn;
  return options.fail === true ? 'any-change' : 'never';
}

/**
 * Signals that `cdkd diff --fail-on` detected a change of the kind it fails on.
 * Carries no message — the diff report was already printed before throwing, so
 * the handler only needs the exit code. Mirrors `cdkd drift`'s
 * `DriftDetectedError` (exit 1 = "non-zero outcome", not "command crashed").
 */
class DiffDetectedError extends CdkdError {
  readonly silent: boolean = true;

  constructor() {
    super('diff detected', 'DIFF_DETECTED');
    this.name = 'DiffDetectedError';
    Object.setPrototypeOf(this, DiffDetectedError.prototype);
  }
}

/**
 * Signals that the preview completed and `cdkd deploy` would REFUSE to start.
 * Two conditions reach it, and the message must fit BOTH:
 *
 *  - a rollback-orphan record whose physical id another cdkd stack already
 *    manages (issue go-to-k/cdkd#2943), where the remedy is resolving the
 *    ownership conflict between two stacks;
 *  - a container this preview REPAIRED and the deploy refuses — a resource's
 *    unreadable `properties` map or an unreadable `outputs` bag (issue
 *    go-to-k/cdkd#3335), where there is no second stack at all and the remedy
 *    is repairing the one record.
 *
 * So the message names no remedy at all and closes on the count.
 *
 * Exit **3**, and neither 1 nor 2, for reasons that are about what a caller
 * can conclude:
 *
 *  - **1** is `--fail`'s "a change was detected". A refusal is not a change,
 *    and merging them would make a CI job that gates on drift report the same
 *    code for "there is work to do" and "the work cannot begin".
 *  - **2** is this CLI's partial-failure family, documented as "work
 *    completed, re-running typically resolves it" (`docs/cli-reference.md`).
 *    A refusal is the opposite: re-running changes nothing until a human acts
 *    — repairing the record, or resolving the ownership conflict, depending on
 *    which condition fired.
 *
 * It is NOT silent: unlike `--fail`, this is not a flag the user opted into,
 * so the reason has to be visible even when the diff report scrolled away.
 * The `Blocking` section already printed the per-condition detail; this adds
 * the one line that says the run cannot proceed.
 */
class DeployRefusalPreviewError extends CdkdError {
  readonly exitCode: number = 3;

  constructor(count: number) {
    super(
      `cdkd deploy would refuse to start: ${count} blocking condition(s) reported above.`,
      'DEPLOY_REFUSAL_PREVIEW'
    );
    this.name = 'DeployRefusalPreviewError';
    Object.setPrototypeOf(this, DeployRefusalPreviewError.prototype);
  }
}

/**
 * Diff command implementation
 */
async function diffCommand(
  stacks: string[],
  options: {
    app?: string;
    output: string;
    stateBucket?: string;
    statePrefix: string;
    stack?: string;
    all?: boolean;
    recursive?: boolean;
    fail?: boolean;
    failOn?: DiffFailOn;
    json?: boolean;
    region?: string;
    profile?: string;
    roleArn?: string;
    verbose: boolean;
    context?: string[];
    useCdkBootstrapAssets?: boolean;
    cfnFallback?: boolean;
  }
): Promise<void> {
  // Awaited first, so provider construction below stays synchronous once the
  // stack client scope / globals are set (see `loadProviderClasses`).
  // Before any work: an incompatible flag pair is a usage error.
  const failOn = resolveFailOn(options);
  const providerClasses = await loadProviderClasses();
  const logger = getLogger();

  if (options.json) {
    // Keep stdout clean for machine consumers: suppress info/debug progress
    // chatter so only the JSON payload lands on stdout. Warnings / errors
    // still surface (stderr). --json wins even when --verbose is ALSO set —
    // clean JSON on stdout is the point of --json; if the user wants debug
    // output too, they should drop --json and run twice (or pipe stderr
    // separately). The previous precedence (verbose wins) interleaved debug
    // chatter into stdout via console.info / console.debug and corrupted
    // the JSON payload for any tooling that parsed it.
    logger.setLevel('warn');
  } else if (options.verbose) {
    logger.setLevel('debug');
  }

  // PR 5: --region is deprecated on non-bootstrap commands. Warn but keep
  // the rest of the pipeline working as before.
  warnIfDeprecatedRegion(options);

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  // Resolve --app from CLI, env, or cdk.json
  const app = resolveApp(options.app);
  if (!app) {
    throw new Error(
      'No app command specified. Use --app, set CDKD_APP env var, or add "app" to cdk.json'
    );
  }
  options.app = app;

  // Resolve --state-bucket from CLI, env, cdk.json, or default
  const region = namedCliRegion(options.region) ?? 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  logger.info('Calculating diff...');
  logger.debug('Options:', options);

  // Initialize AWS clients with region/profile
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);
  // Per-region clients for the preview's provider reads, built on first use
  // and destroyed with the command's own (see `stackRegionScope` below).
  const stackRegionScopes = new Map<string, { clients: AwsClients; registry: ProviderRegistry }>();

  try {
    // 1. Synthesize CDK app
    logger.info(synthesisStatusMessage(app, 'Synthesizing CDK app...'));
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const synthOptions: SynthesisOptions = {
      app: options.app,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
      // Threaded so the macro-expander has a real state bucket for
      // the > 51,200-byte template upload path (Issue #463).
      stateBucket,
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
      // Issue #1150: expand macros AFTER stack selection (below), so a
      // macro-carrying stack outside the diff set can never block or
      // slow this diff with a CFn round-trip.
      deferMacroExpansion: true,
    };
    const result = await synthesizer.synthesize(synthOptions);

    const { stacks: allStacks } = result;
    logger.info(`Found ${allStacks.length} stack(s) in assembly`);

    // Determine target stacks: positional args > --stack > --all > auto (single stack)
    const stackPatterns = stacks.length > 0 ? stacks : options.stack ? [options.stack] : [];
    let targetStacks;

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
      if (inStages.length > 0) logger.info(renderAllLeftOutStageStacks(inStages));
      targetStacks = topLevel;
    } else if (stackPatterns.length > 0) {
      targetStacks = matchStacks(allStacks, stackPatterns);
    } else if (allStacks.length === 1) {
      targetStacks = allStacks;
    } else {
      throw new Error(
        `Multiple stacks found: ${allStacks.map(describeStack).join(', ')}. ` +
          `Specify stack name(s) or use --all (top-level stacks; '**' for every stack)`
      );
    }

    if (targetStacks.length === 0) {
      throw new Error(renderNoStackMatch(stackPatterns, allStacks));
    }

    // Issue #1150: macro expansion was deferred at synthesize() time —
    // expand now for exactly the stacks being diffed, mutating each
    // template in place before the diff calculator consumes it.
    await synthesizer.expandMacrosForStacks(targetStacks, synthOptions);

    // 3. Initialize components
    const stateConfig = {
      bucket: stateBucket,
      prefix: options.statePrefix,
    };
    // Pass region/profile so the backend can rebuild its S3 client if the
    // bucket lives in a region different from the CLI's profile region.
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      region,
      ...(options.profile && { profile: options.profile }),
    });
    const diffCalculator = new DiffCalculator();
    // Providers are registered here so the diff can consult the SAME per-type
    // property normalization the deploy engine applies (issue #1591). The
    // provider READS this preview makes — the rollback-orphan pre-pass
    // (go-to-k/cdkd#2943) and the stale-attribute heal (go-to-k/cdkd#3456) — go
    // through `stackRegionScope`'s per-region registries instead. Each runs
    // only when needed: the pre-pass for a stack whose state holds orphan
    // records, the heal for a reference that reaches a missing attribute.
    const diffProviderRegistry = new ProviderRegistry();
    registerAllProviders(diffProviderRegistry, providerClasses);
    const canonicalizeProperties = makeCanonicalizePropertiesFn(diffProviderRegistry);

    // Per-STACK-region clients and providers, for every provider read this
    // preview makes: the rollback-orphan adoption check below and the
    // stale-attribute heal (go-to-k/cdkd#3456). `cdkd deploy` binds each
    // stack's providers to clients for its own region, and a provider takes
    // its clients at construction (some build their SDK client lazily from the
    // ambient scope, so the calls run inside it too). A read through
    // `diffProviderRegistry` would ask the command's region about a physical id
    // that names a resource in another one — and a same-named resource there
    // would answer for it.
    //
    // Deliberately WITHOUT the deploy registry's per-run settings
    // (`setCustomResourceResponseBucket`, `allowUnsupportedTypes`, the SDK-route
    // preferences): custom resources are never read here, a read routes by the
    // record's own `provisionedBy`, and `cdkd diff` takes none of those flags.
    const stackRegionScope = (
      scopeRegion: string
    ): { clients: AwsClients; registry: ProviderRegistry } => {
      let scope = stackRegionScopes.get(scopeRegion);
      if (scope === undefined) {
        const clients = new AwsClients({
          region: scopeRegion,
          ...(options.profile && { profile: options.profile }),
        });
        const registry = runWithStackAwsClients(clients, () => {
          const scoped = new ProviderRegistry();
          registerAllProviders(scoped, providerClasses);
          return scoped;
        });
        scope = { clients, registry };
        stackRegionScopes.set(scopeRegion, scope);
      }
      return scope;
    };

    // The SAME pre-pass `DeployEngine.executeDeployment` runs, wired from the
    // diff's own registry and state backend (issue go-to-k/cdkd#2943). It is
    // shared code, not a reimplementation: the two must agree on which records
    // they adopt and which they refuse, or the preview stops predicting the
    // deploy — which is the defect this closes.
    //
    // The deploy SPLICES and then THROWS on a refusal; here the caller keeps
    // both halves and renders them. `planOrphanAdoption` itself performs
    // neither, so no behaviour is duplicated to keep in step.
    const previewOrphanAdoption = async (
      state: StackState,
      effectiveTemplate: CloudFormationTemplate,
      orphanStackName: string,
      orphanRegion: string
    ): Promise<{ adopted: Record<string, ResourceState>; refusals: string[] }> => {
      // In the STACK's region (see `stackRegionScope`), as the deploy's own
      // pre-pass runs inside that stack's AWS scope.
      const { clients, registry } = stackRegionScope(orphanRegion);
      // go-to-k/cdkd#3869: the planner's own lines (a vanished record's debug
      // line, a provider `import()`'s existence check) print a kept record's
      // id, so they run under a printing bag judged from every record.
      const outcome = await runWithStackAwsClients(clients, () =>
        withPrintingSecrets(orphanRecordsPrintingBag(state.orphans ?? []), () =>
          planOrphanAdoption({
            records: state.orphans ?? [],
            managedLogicalIds: new Set(Object.keys(state.resources ?? {})),
            template: effectiveTemplate,
            stackName: orphanStackName,
            region: orphanRegion,
            getProvider: (resourceType, provisionedBy) =>
              registry.getProviderFor({ resourceType, provisionedBy }).provider,
            nameProperties: (resourceType) => {
              const property = explicitNamePropertyFor(resourceType);
              return property ? [property] : [];
            },
            readSiblingClaims: makeSiblingClaimReader({
              stateBackend,
              selfStackName: orphanStackName,
              selfRegion: orphanRegion,
              logger,
            }),
            logger,
          })
        )
      );
      // NOTICES are deliberately dropped here. On the deploy path they explain
      // why a record was kept rather than acted on, at the moment the user is
      // changing AWS; in a preview the same lines would print on EVERY diff of
      // a stack holding a permanently-unadoptable record, which is noise
      // attached to a command people run repeatedly.
      return { adopted: outcome.adopted, refusals: outcome.refusals };
    };
    // The READ-ONLY stale-attribute heal (issue go-to-k/cdkd#3456): the SAME
    // provider `import()` read `cdkd deploy` takes when a `Fn::GetAtt` over a
    // stale attribute map is about to fall back to the physical id, so the
    // preview resolves the reference to the value its own read returns.
    // Served for this run only; nothing is written to state. In the stack's
    // region, like the adoption check.
    const attributeHealerFor = createReadOnlyAttributeHealerFactory({
      getProvider: (resource, healRegion) =>
        stackRegionScope(healRegion).registry.getProviderFor({
          resourceType: resource.resourceType,
          properties: resource.properties,
          provisionedBy: resource.provisionedBy,
          // As `DeployEngine.readStaleAttributes` routes it (issue #3713): the
          // record is its own baseline, so the read stays on the layer that
          // wrote the record.
          previousProperties: resource.properties,
        }).provider,
      inRegion: (healRegion, fn) =>
        runWithStackAwsClients(stackRegionScope(healRegion).clients, fn),
    });
    // `--fail-on=destructive` walks nested stacks whether or not `--recursive`
    // was given: it is a gate on losing a resource, and `cdk diff` checks
    // nested stacks too, so a destructive change inside a child must not pass.
    const recursive = (options.recursive ?? false) || failOn === 'destructive';

    // Issue #1002 PR 2 — when a stack's region is in cdkd-assets mode, the
    // §7 asset-reference rewrite is applied to the template before diffing
    // so the shown plan matches what deploy will do (incl. the one-time
    // migration diff after `cdkd bootstrap`). Lazy: no extra AWS calls for
    // asset-less apps / legacy regions beyond the marker read.
    const resolveAssetRedirect = createAssetRedirectResolver({
      stateBackend,
      stsRegion: region,
      ...(options.profile && { profile: options.profile }),
      useCdkBootstrapAssets: resolveUseCdkBootstrapAssets(options.useCdkBootstrapAssets),
      suppressLegacyNotice: true,
    });

    // 4. Build a diff tree per target stack (nested children only when --recursive).
    const trees: DiffTreeNode[] = [];
    for (const stackInfo of targetStacks) {
      logger.info(`\nCalculating diff for stack: ${stackInfo.stackName}`);
      // Stack region drives the state key. Falls back to the CLI region only
      // when synth couldn't determine a region (e.g. env-agnostic stacks).
      const stackRegion = stackInfo.region || region;
      const assetRedirect = await resolveAssetRedirect(stackInfo.assetManifestPath, stackRegion);
      if (assetRedirect) {
        const rewritten = rewriteTemplateAssetReferences(stackInfo.template, assetRedirect);
        logger.debug(
          `Rewrote ${rewritten} asset reference(s) to cdkd asset storage in template of ` +
            `stack ${stackInfo.stackName}`
        );
      }
      trees.push(
        await buildDiffTree({
          stackName: stackInfo.stackName,
          displayName: stackInfo.stackName,
          region: stackRegion,
          template: stackInfo.template,
          // Null-prototype on the ABSENT arm too (issue go-to-k/cdkd#3480): the
          // index is omitted when no row carried a usable asset path, and on a
          // `{}` fallback the `if (!nestedTemplates[id])` readers answer an
          // inherited member for a row named `toString` / `valueOf`.
          nestedTemplates: stackInfo.nestedTemplates ?? nullPrototypeRecord<string>(),
          recursive,
          stateBackend,
          diffCalculator,
          // Issue #1591: the preview must narrow exactly like the apply, or
          // `cdkd diff` forecasts a change `cdkd deploy` will never make.
          canonicalizeProperties,
          ...(assetRedirect && { assetRedirect }),
          // Issue #1697: the diff's best-effort resolvers honor the same
          // CloudFormation fallback opt-out as deploy, so preview and apply
          // resolve cross-stack references identically.
          ...(options.cfnFallback === false && { cfnFallback: false }),
          previewOrphanAdoption,
          attributeHealerFor,
          // This IS the stack the user named, so it is the one node that
          // carries the repaired-container refusals (go-to-k/cdkd#3335).
          isNestedChild: false,
        })
      );
    }

    // 5. Emit results — JSON payload (nested when --recursive) or human blocks.
    // Escaped, not sanitised (go-to-k/cdkd#4045): a state value carrying DEL,
    // C1, a line separator or a bidi control is written as `\uXXXX`, so the
    // payload parses back unchanged and cannot drive the terminal.
    if (options.json) {
      process.stdout.write(`${stringifyJsonPayload(trees.map(diffTreeToJson))}\n`);
    } else {
      for (const tree of trees) {
        // `countBlocking` too, not `treeHasChanges` alone. The renderer is
        // deliberately written to print a `Blocking` section for a node with
        // no changes; gating the CALL on changes alone put that coincidence
        // back one level up, where a changeless refusal would print
        // "No changes detected" and then exit 3 citing reasons "reported
        // above" that were never printed.
        if (!treeIsWorthRendering(tree)) {
          logger.info(`\n✓ No changes detected for stack ${tree.stackName}`);
          continue;
        }
        renderDiffTree(tree, true, (msg) => logger.info(msg));
      }
    }

    // 6. --fail-on (CDK parity with `cdk diff --fail-on`): exit 1 on any change
    // (`any-change`, alias `--fail`) or only on one that replaces, deletes or
    // orphans a resource (`destructive`). With --recursive this covers the
    // whole nested-stack tree, so CI can gate on tree-wide changes.
    // The refusal check runs BEFORE it, mirroring how `cdkd scrub` ranks a
    // refusal above its own `--fail`: when both are true the user needs the
    // one that says the deploy cannot start, not the one that says something
    // changed.
    const blockingCount = trees.reduce((n, tree) => n + countBlocking(tree), 0);
    if (blockingCount > 0) {
      throw new DeployRefusalPreviewError(blockingCount);
    }
    if (failOn === 'any-change' && trees.some(treeHasChanges)) {
      throw new DiffDetectedError();
    }
    if (failOn === 'destructive') {
      const destructive = trees.flatMap(treeDestructiveChanges);
      if (destructive.length > 0) {
        // `error`, so it reaches stderr under `--json` too, where stdout is
        // the payload (which carries the same list per node).
        // Each line is rendered through the display helpers already.
        const lines = destructive.map((change) => '  ' + formatDestructiveChange(change));
        logger.error(
          [
            safeMsg`\n❌  Found ${destructive.length} destructive change(s) (--fail-on=destructive):`,
            ...lines,
          ].join('\n')
        );
        throw new DiffDetectedError();
      }
    }
  } finally {
    for (const { clients } of stackRegionScopes.values()) clients.destroy();
    awsClients.destroy();
  }
}

/**
 * Create diff command
 */
export function createDiffCommand(): Command {
  const cmd = new Command('diff')
    .description('Show difference between current state and desired state')
    .argument(
      '[stacks...]',
      "Stack name(s) to diff. Accepts CDK display paths (e.g. 'MyStage/Api') with wildcards ('MyStage/*', '**'), or exact physical CloudFormation names (e.g. 'MyStage-Api')."
    )
    .option('--all', "Diff every top-level stack (top-level only; Stage stacks: '**')", false)
    .option(
      '--recursive',
      'Recurse into each AWS::CloudFormation::Stack row and diff every nested-stack child against its own deployed state (DFS order). Default is non-recursive, matching cdk diff.',
      false
    )
    // No default on `--fail`: `resolveFailOn` must tell "not given" from
    // `--no-fail` to refuse either beside `--fail-on`.
    .option(
      '--fail',
      'Exit with code 1 when any change is detected (matches cdk diff --fail). Alias for --fail-on=any-change.'
    )
    .option('--no-fail', 'Never exit with code 1 for a change. Alias for --fail-on=never.')
    .addOption(
      new Option(
        '--fail-on <kind>',
        'Exit with code 1 when the diff contains the given kind of change: "any-change" fails on any difference, "destructive" only on changes that replace, delete or orphan a resource, "never" does not fail (default). "destructive" always checks nested stacks (as --recursive); the others do with --recursive. Cannot be used with --fail / --no-fail.'
      )
        // `choices` for the help text; the `argParser` after it replaces the
        // parser `choices` installs, so it also refuses a repeated flag.
        .choices(DIFF_FAIL_ON_VALUES)
        .argParser(parseFailOn)
    )
    .option(
      '--json',
      'Output the diff as JSON (nested tree shape when combined with --recursive)',
      false
    )
    .addOption(useCdkBootstrapAssetsOption)
    .addOption(noCfnFallbackOption)
    .action(withErrorHandling(diffCommand));

  // Add options
  [...commonOptions, ...appOptions, ...stateOptions, ...stackOptions, ...contextOptions].forEach(
    (opt) => cmd.addOption(opt)
  );

  // --region is deprecated for diff (PR 5). Accepted for backward
  // compatibility; warning emitted at runtime via warnIfDeprecatedRegion.
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
