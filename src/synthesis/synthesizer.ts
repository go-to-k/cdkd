import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { AppExecutor } from './app-executor.js';
import { AssemblyReader, type StackInfo } from './assembly-reader.js';
import { ContextStore } from './context-store.js';
import { ContextProviderRegistry } from './context-providers/index.js';
import type { AssemblyManifest } from '../types/assembly.js';
import { loadCdkJson } from '../cli/config-loader.js';
import { getLogger } from '../utils/logger.js';
import { SynthesisError } from '../utils/error-handler.js';

/**
 * Synthesis options
 */
export interface SynthesisOptions {
  /** CDK app command (e.g., "npx ts-node app.ts") */
  app: string;

  /** Output directory for synthesis (default: "cdk.out") */
  output?: string;

  /** AWS profile to use */
  profile?: string;

  /** AWS region */
  region?: string;

  /** Context key-value pairs (CLI -c/--context) */
  context?: Record<string, string>;
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
    const outputDir = resolve(options.output || 'cdk.out');

    // Ensure output directory exists
    mkdirSync(outputDir, { recursive: true });

    // Load static context (doesn't change during loop)
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

      // Merge context: defaults < cdk.json < cdk.context.json < CLI -c (CLI wins)
      const mergedContext: Record<string, unknown> = {
        ...cdkDefaults,
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
        // Synthesis complete
        const stacks = this.assemblyReader.getAllStacks(outputDir, manifest);
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
