import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { AppExecutor } from './app-executor.js';
import { AssemblyReader, type StackInfo } from './assembly-reader.js';
import { ContextStore } from './context-store.js';
import { ContextProviderRegistry } from './context-providers/index.js';
import { containsMacro, enumerateMacros } from './macro-detector.js';
import { expandMacros, type ExpandMacrosOptions } from './macro-expander.js';
import type { AssemblyManifest } from '../types/assembly.js';
import { loadCdkJson, loadUserCdkJson } from '../cli/config-loader.js';
import { getLogger } from '../utils/logger.js';
import { SynthesisError } from '../utils/error-handler.js';

/**
 * CDK CLI compatibility: a `--app` value pointing at an existing directory is
 * treated as a pre-synthesized cloud assembly — synthesis (the subprocess
 * execution) is skipped and the manifest is read directly. A `--app` value that
 * is a command (e.g. "node app.ts") or any path that is not an existing
 * directory is synthesized normally.
 *
 * Exported so callers can pick an accurate status message
 * ("Reading cloud assembly..." vs "Synthesizing CDK app...") BEFORE invoking
 * {@link Synthesizer.synthesize}, which is the single place that branches on it.
 */
export function isPreSynthesizedAssembly(app: string): boolean {
  const appPath = resolve(app);
  return existsSync(appPath) && statSync(appPath).isDirectory();
}

/**
 * Pick the user-facing status line a command prints right before it invokes
 * {@link Synthesizer.synthesize}. When `--app` is a pre-synthesized assembly
 * directory, synthesis is skipped, so "Reading cloud assembly..." is accurate;
 * otherwise the command's own `synthesizingMessage` (e.g. "Synthesizing CDK
 * app...") is used. `app` may be undefined (the synthesize() call will then
 * throw the usual "no app specified" error) — that case keeps the synthesizing
 * message.
 */
export function synthesisStatusMessage(
  app: string | undefined,
  synthesizingMessage: string
): string {
  return app !== undefined && isPreSynthesizedAssembly(app)
    ? 'Reading cloud assembly...'
    : synthesizingMessage;
}

/**
 * Synthesis options
 */
export interface SynthesisOptions {
  /** CDK app command (e.g., "node app.ts") */
  app: string;

  /** Output directory for synthesis (default: "cdk.out") */
  output?: string;

  /** AWS profile to use */
  profile?: string;

  /** AWS region */
  region?: string;

  /** Context key-value pairs (CLI -c/--context) */
  context?: Record<string, string>;

  /**
   * State bucket used as transient template storage when a macro-bearing
   * stack template is larger than the inline `TemplateBody` ceiling
   * (51,200 bytes). Required only when at least one stack declares a
   * CloudFormation transform AND its serialized template exceeds the
   * inline limit; small macro templates work without it.
   *
   * Threaded through to {@link expandMacros}; same bucket cdkd uses
   * for state persistence, so the calling identity already has write
   * access. See `docs/design/463-cfn-macros.md`.
   */
  stateBucket?: string;

  /**
   * AWS credentials (resolved at command startup, typically from STS
   * AssumeRole) forwarded to the macro-expansion S3 client. Only
   * consulted when the macro-expansion path uploads a transient
   * template upload (over the inline 51,200-byte limit).
   */
  macroExpandS3ClientOpts?: ExpandMacrosOptions['s3ClientOpts'];
}

/**
 * Synthesis result
 */
export interface SynthesisResult {
  /** Cloud assembly manifest */
  manifest: AssemblyManifest;

  /** Assembly directory (absolute path) */
  assemblyDir: string;

  /** All stacks in the assembly */
  stacks: StackInfo[];
}

/**
 * CDK app synthesizer
 *
 * Replaces @aws-cdk/toolkit-lib with self-implemented:
 * - Subprocess execution of CDK app
 * - Cloud assembly manifest parsing
 * - Context provider loop (missing context → SDK lookup → re-synthesize)
 */
export class Synthesizer {
  private logger = getLogger().child('Synthesizer');
  private appExecutor = new AppExecutor();
  private assemblyReader = new AssemblyReader();
  private contextStore = new ContextStore();

  /**
   * Synthesize CDK app to cloud assembly
   *
   * Implements the context provider loop:
   * 1. Merge context (cdk.json context + cdk.context.json + CLI -c)
   * 2. Execute CDK app subprocess
   * 3. Read manifest.json
   * 4. If missing context → resolve via providers → save to cdk.context.json → re-execute
   * 5. Return assembly with stacks
   */
  async synthesize(options: SynthesisOptions): Promise<SynthesisResult> {
    // CDK CLI compatibility: if --app points at an existing directory, treat it
    // as a pre-synthesized cloud assembly and skip subprocess execution.
    // See aws-cdk/lib/cxapp/exec.ts: "bypass 'synth' if app points to a cloud assembly".
    const appPath = resolve(options.app);
    if (isPreSynthesizedAssembly(options.app)) {
      this.logger.debug(`Using pre-synthesized cloud assembly at ${appPath}`);
      const manifest = this.assemblyReader.readManifest(appPath);
      const stacks = this.assemblyReader.getAllStacks(appPath, manifest);
      // Resolve region + accountId for the macro-expansion pass (parity
      // with the synth branch below). The pre-synth branch may still
      // hit the macro-expander when an assembly built elsewhere
      // contains a `Transform` block, so we need the same STS hop to
      // resolve the default state bucket.
      const presynthRegion =
        options.region || process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION'];
      let presynthAccountId: string | undefined;
      try {
        const stsClient = new STSClient({ ...(presynthRegion && { region: presynthRegion }) });
        const identity = await stsClient.send(new GetCallerIdentityCommand({}));
        presynthAccountId = identity.Account;
        stsClient.destroy();
      } catch {
        this.logger.debug('Could not resolve AWS account ID via STS (pre-synth branch)');
      }
      await this.expandMacrosForStacks(stacks, options, {
        region: presynthRegion,
        ...(presynthAccountId && { accountId: presynthAccountId }),
      });
      this.logger.debug(`Loaded ${stacks.length} stack(s) from pre-synthesized assembly`);
      return { manifest, assemblyDir: appPath, stacks };
    }

    const outputDir = resolve(options.output || 'cdk.out');

    // Ensure output directory exists
    mkdirSync(outputDir, { recursive: true });

    // Load static context (doesn't change during loop)
    // Priority: defaults < ~/.cdk.json < cdk.json < cdk.context.json < CLI -c
    const userCdkJson = loadUserCdkJson();
    const userContext = (userCdkJson?.context as Record<string, unknown>) ?? {};
    const cdkJson = loadCdkJson();
    const cdkJsonContext = (cdkJson?.context as Record<string, unknown>) ?? {};
    const cliContext = (options.context as Record<string, unknown>) ?? {};

    // CDK CLI injects these context values by default for framework compatibility
    const cdkDefaults: Record<string, unknown> = {
      'aws:cdk:enable-path-metadata': true,
      'aws:cdk:enable-asset-metadata': true,
      'aws:cdk:version-reporting': true,
      'aws:cdk:bundling-stacks': ['**'],
    };

    // Resolve AWS account/region for context passing
    const region = options.region || process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION'];
    let accountId: string | undefined;
    try {
      const stsClient = new STSClient({ ...(region && { region }) });
      const identity = await stsClient.send(new GetCallerIdentityCommand({}));
      accountId = identity.Account;
      stsClient.destroy();
    } catch {
      this.logger.debug('Could not resolve AWS account ID via STS');
    }

    // Context provider loop
    let previousMissingKeys: Set<string> | undefined;
    const contextProviderRegistry = new ContextProviderRegistry({
      ...(region && { region }),
      ...(options.profile && { profile: options.profile }),
    });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Load cdk.context.json (re-read each iteration — providers may have updated it)
      const cdkContextJson = this.contextStore.load();

      // Merge context: defaults < ~/.cdk.json < cdk.json < cdk.context.json < CLI -c (CLI wins)
      const mergedContext: Record<string, unknown> = {
        ...cdkDefaults,
        ...userContext,
        ...cdkJsonContext,
        ...cdkContextJson,
        ...cliContext,
      };

      // Execute CDK app
      this.logger.debug('Executing CDK app...');
      await this.appExecutor.execute({
        app: options.app,
        outputDir,
        context: mergedContext,
        ...(region && { region }),
        ...(accountId && { accountId }),
      });

      // Read manifest
      const manifest = this.assemblyReader.readManifest(outputDir);

      // Check for missing context
      if (!manifest.missing || manifest.missing.length === 0) {
        // Synthesis complete — but BEFORE returning, expand any
        // CloudFormation macros / Fn::Transform via a transient CFn
        // changeset round-trip so the analyzer / provisioner pipeline
        // never sees an unexpanded Transform node. See
        // docs/design/463-cfn-macros.md.
        const stacks = this.assemblyReader.getAllStacks(outputDir, manifest);
        await this.expandMacrosForStacks(stacks, options, {
          region,
          ...(accountId && { accountId }),
        });
        this.logger.debug(`Synthesis complete: ${stacks.length} stack(s)`);

        return { manifest, assemblyDir: outputDir, stacks };
      }

      // Missing context detected
      const missingKeys = new Set(manifest.missing.map((m) => m.key));
      this.logger.debug(`Missing context: ${manifest.missing.length} value(s)`);

      // Check for no progress (same missing keys as last iteration)
      if (previousMissingKeys && setsEqual(missingKeys, previousMissingKeys)) {
        throw new SynthesisError(
          'Context resolution made no progress. ' +
            `Missing context keys: ${[...missingKeys].join(', ')}. ` +
            'Ensure cdk.context.json is correctly configured or required AWS permissions are granted.'
        );
      }
      previousMissingKeys = missingKeys;

      // Resolve missing context via providers
      this.logger.info('Resolving missing context...');
      const resolved = await contextProviderRegistry.resolve(manifest.missing);

      // Save resolved values to cdk.context.json
      this.contextStore.save(resolved);

      // Loop: re-execute CDK app with updated context
      this.logger.debug('Re-synthesizing with resolved context...');
    }
  }

  /**
   * List stack names in CDK app
   */
  async listStacks(options: SynthesisOptions): Promise<string[]> {
    const result = await this.synthesize(options);
    return result.stacks.map((s) => s.stackName);
  }

  /**
   * Per-stack macro-expansion pass (Issue #463). Mutates each stack's
   * `template` in place when {@link containsMacro} flags it. Runs
   * AFTER the context-provider loop has settled and BEFORE the
   * analyzer / provisioner pipeline consumes the templates, so every
   * downstream stage sees the post-expansion shape.
   *
   * Skipped silently when no stack carries a macro — pure no-op cost.
   * When a macro IS detected and the caller did NOT thread a
   * region into the synthesizer, falls back to resolving region from
   * the synthesized stack's environment (set by `cdk.Stack.region`).
   * Throws `SynthesisError` when no region can be resolved (the
   * upstream caller treats it as a synth failure) and propagates
   * `MacroExpansionError` (from {@link expandMacros}) on any CFn-side
   * failure during the round-trip.
   */
  private async expandMacrosForStacks(
    stacks: StackInfo[],
    options: SynthesisOptions,
    resolved?: { region: string | undefined; accountId?: string | undefined }
  ): Promise<void> {
    const stacksWithMacros = stacks.filter((s) => containsMacro(s.template));
    if (stacksWithMacros.length === 0) return;

    // Resolve a region for the CFn client. Priority: explicit caller
    // resolve > options.region / env > the synthesized stack's own
    // env-resolved region (every stack we are about to expand SHARES
    // the same region in practice — multi-region apps would create
    // siblings in different regions, but those are independent stacks).
    const region =
      resolved?.region ||
      options.region ||
      process.env['AWS_REGION'] ||
      process.env['AWS_DEFAULT_REGION'] ||
      stacksWithMacros[0]?.region;
    if (!region) {
      throw new SynthesisError(
        `Stack(s) [${stacksWithMacros.map((s) => s.stackName).join(', ')}] use CloudFormation ` +
          `macros (Transform / Fn::Transform) but cdkd could not resolve an AWS region for the ` +
          `expansion round-trip. Set AWS_REGION, pass --region <r>, or set env: { region: '<r>' } ` +
          `in your CDK Stack constructor.`
      );
    }

    // State bucket — only consulted by the macro-expander when a stack's
    // serialized template exceeds 51,200 bytes (the inline TemplateBody
    // ceiling). For sub-51kB templates the inline TemplateBody path
    // skips the bucket entirely.
    //
    // Resolution chain: caller-threaded `options.stateBucket` (the
    // standard flow on `cdkd deploy` / `diff` / `destroy` / `export` /
    // `import` / `orphan` — those resolve via `resolveStateBucketWithDefault`
    // BEFORE calling `synthesize` and pass it down) → STS-resolved
    // `cdkd-state-{accountId}` default → undefined (and the expander's
    // upload branch hard-errors if the template is oversize).
    //
    // The hard-error case is structural: callers like `cdkd synth` /
    // `list` / `publish-assets` historically did not resolve a state
    // bucket because they don't need one for their own work, but a
    // macro-containing stack with a >51 KB template DOES need one for
    // the transient TemplateURL upload. The caller must thread one
    // through or the user must pass `--state-bucket <name>`. The
    // pre-flight check here surfaces a friendlier SynthesisError with
    // the offending stack name BEFORE expandMacros runs; the expander
    // itself will also reject (via MacroExpansionError) defense-in-depth.
    let stateBucket: string | undefined;
    if (options.stateBucket) {
      stateBucket = options.stateBucket;
    } else if (resolved?.accountId) {
      stateBucket = `cdkd-state-${resolved.accountId}`;
    } else {
      // Best-effort: every stack in `stacksWithMacros` has a small
      // template (≤ 51,200 bytes) → the bucket isn't consulted. Probe
      // sizes here and only hard-error when at least one stack would
      // actually need TemplateURL.
      const oversize = stacksWithMacros.find((s) => JSON.stringify(s.template).length > 51_200);
      if (oversize) {
        throw new SynthesisError(
          `Stack '${oversize.stackName}' uses CloudFormation macros AND its serialized ` +
            `template exceeds the 51,200-byte inline TemplateBody limit, so cdkd must ` +
            `upload the template to S3 for the transient expansion changeset. cdkd could ` +
            `not resolve a state bucket: STS GetCallerIdentity failed AND --state-bucket ` +
            `was not provided. Pass --state-bucket <name> (cdkd uses the same bucket as ` +
            `cdkd deploy state storage; typically 'cdkd-state-<accountId>').`
        );
      }
      // Sub-51 KB template: bucket isn't consulted. Pass `undefined`
      // to the expander rather than a sentinel string — any future
      // code path that consults the field on the inline branch will
      // see undefined explicitly (the expander's optional
      // `stateBucket?: string` signature documents this contract).
      stateBucket = undefined;
    }

    for (const stack of stacksWithMacros) {
      const macros = enumerateMacros(stack.template);
      this.logger.info(
        `[macros] Expanding CloudFormation macros for stack '${stack.stackName}' ` +
          `via CFn round-trip (transforms: ${macros.join(', ')}; may take 30-60s)...`
      );
      const before = Date.now();
      const expanded = await expandMacros(stack.template, {
        region,
        ...(stateBucket !== undefined && { stateBucket }),
        ...(options.macroExpandS3ClientOpts && {
          s3ClientOpts: options.macroExpandS3ClientOpts,
        }),
      });
      // Mutate the stack in place — downstream consumers iterate
      // `stacks[].template`.
      stack.template = expanded;
      const elapsedSec = Math.round((Date.now() - before) / 1000);
      this.logger.info(
        `[macros]   ... done in ${elapsedSec}s ` +
          `(${Object.keys(expanded.Resources ?? {}).length} resources after expansion).`
      );
    }
  }
}

/**
 * Check if two sets contain the same elements
 */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
