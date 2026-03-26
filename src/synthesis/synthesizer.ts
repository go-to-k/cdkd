import { Toolkit, type ICloudAssemblySource } from '@aws-cdk/toolkit-lib';
import type { CloudAssembly } from '@aws-cdk/cloud-assembly-api';
import { getLogger } from '../utils/logger.js';
import { SynthesisError } from '../utils/error-handler.js';

/**
 * Synthesis options
 */
export interface SynthesisOptions {
  /** CDK app command (e.g., "npx ts-node app.ts") */
  app: string;

  /** Output directory for synthesis */
  output?: string;

  /** AWS profile to use */
  profile?: string;

  /** AWS region */
  region?: string;

  /** Validate stacks during synthesis */
  validateStacks?: boolean;
}

/**
 * CDK app synthesizer using toolkit-lib
 */
export class Synthesizer {
  private toolkit: Toolkit;
  private logger = getLogger().child('Synthesizer');

  constructor() {
    this.toolkit = new Toolkit({
      ioHost: {
        // Handle toolkit messages
        notify: (msg) => {
          this.logger.debug('Toolkit message:', msg);
          return Promise.resolve();
        },
        // Handle toolkit requests (use default responses)
        requestResponse: (msg) => {
          this.logger.debug('Toolkit request:', msg);
          return Promise.resolve(msg.defaultResponse);
        },
      },
    });
  }

  /**
   * Create a cloud assembly source from CDK app command
   *
   * Note: Using fromCdkApp() which:
   * - Automatically reads cdk.json from the project directory
   * - Handles context lookups and caching
   * - Mimics CDK CLI behavior closely
   */
  async createSource(options: SynthesisOptions): Promise<ICloudAssemblySource> {
    try {
      this.logger.debug('Creating cloud assembly source from app:', options.app);

      // fromCdkApp automatically handles:
      // 1. Reading cdk.json for configuration
      // 2. Context lookups (VPC IDs, AZ info, etc.)
      // 3. Saving context values to cdk.context.json
      // Note: The 'output' option seems to be ignored in some cases,
      // and it uses the current working directory's cdk.out
      const source = await this.toolkit.fromCdkApp(options.app);

      return source;
    } catch (error) {
      throw new SynthesisError(
        `Failed to create cloud assembly source: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Synthesize CDK app to CloudFormation template
   */
  async synthesize(
    options: SynthesisOptions
  ): Promise<{ cloudAssembly: CloudAssembly; dispose: () => Promise<void> }> {
    try {
      this.logger.debug('Synthesizing CDK app...');

      // Create cloud assembly source
      const source = await this.createSource(options);

      // Perform synthesis
      this.logger.debug('Running synth operation...');
      const assemblySource = await this.toolkit.synth(source, {
        validateStacks: options.validateStacks ?? true,
      });

      const cloudAssembly = assemblySource.cloudAssembly;

      this.logger.debug('Synthesis complete');
      this.logger.debug('Assembly directory:', cloudAssembly.directory);
      this.logger.debug('Assembly type:', typeof cloudAssembly);
      this.logger.debug('Assembly has stacks?', !!cloudAssembly.stacks);
      this.logger.debug('Assembly stacks length:', cloudAssembly.stacks?.length);
      if (cloudAssembly.artifacts) {
        this.logger.debug('Assembly artifacts:', Object.keys(cloudAssembly.artifacts));
      }

      // Log stack names
      const stackNames = cloudAssembly.stacks?.map((s) => s.stackName) ?? [];
      if (stackNames.length > 0) {
        this.logger.debug('Stacks in assembly:', stackNames);
      }

      return { cloudAssembly, dispose: () => assemblySource.dispose() };
    } catch (error) {
      throw new SynthesisError(
        `Synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * List stacks in CDK app
   */
  async listStacks(options: SynthesisOptions): Promise<string[]> {
    try {
      const source = await this.createSource(options);
      const details = await this.toolkit.list(source);

      // Validate that details is an array
      if (!Array.isArray(details)) {
        throw new SynthesisError('Unexpected response from toolkit.list: not an array');
      }

      // Map stack names with validation
      return details.map((stack) => {
        if (typeof stack === 'object' && stack !== null && 'name' in stack) {
          const name = (stack as { name: unknown }).name;
          if (typeof name === 'string') {
            return name;
          }
        }
        throw new SynthesisError('Invalid stack object in list response');
      });
    } catch (error) {
      throw new SynthesisError(
        `Failed to list stacks: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }
}
