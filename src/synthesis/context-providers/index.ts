import type { MissingContext } from '../../types/assembly.js';
import { getLogger } from '../../utils/logger.js';
import { AZContextProvider } from './az-provider.js';
import { SSMContextProvider } from './ssm-provider.js';
import { HostedZoneContextProvider } from './hosted-zone-provider.js';
import { VpcContextProvider } from './vpc-provider.js';
import { CcApiContextProvider } from './cc-api-provider.js';

const PROVIDER_ERROR_KEY = '$providerError';
const TRANSIENT_CONTEXT_KEY = '$dontSaveContext';

/**
 * Context provider interface
 */
export interface ContextProvider {
  /**
   * Resolve context value from AWS SDK
   * @param props Provider-specific query properties
   * @returns Resolved context value
   */
  resolve(props: Record<string, unknown>): Promise<unknown>;
}

/**
 * AWS client configuration for context providers
 */
export interface ContextProviderAwsConfig {
  region?: string;
  profile?: string;
}

/**
 * Context provider registry
 *
 * Maps provider type names to implementations.
 * Resolves missing context values by calling AWS SDK APIs.
 */
export class ContextProviderRegistry {
  private logger = getLogger().child('ContextProviderRegistry');
  private providers = new Map<string, ContextProvider>();

  constructor(awsConfig?: ContextProviderAwsConfig) {
    // Register built-in providers
    this.register('availability-zones', new AZContextProvider(awsConfig));
    this.register('ssm', new SSMContextProvider(awsConfig));
    this.register('hosted-zone', new HostedZoneContextProvider(awsConfig));
    this.register('vpc-provider', new VpcContextProvider(awsConfig));
    this.register('cc-api-provider', new CcApiContextProvider(awsConfig));
  }

  /**
   * Register a context provider
   */
  register(name: string, provider: ContextProvider): void {
    this.providers.set(name, provider);
  }

  /**
   * Resolve all missing context values
   *
   * @param missing Array of missing context entries from manifest
   * @returns Map of context key → resolved value
   */
  async resolve(missing: MissingContext[]): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};

    for (const entry of missing) {
      const provider = this.providers.get(entry.provider);

      if (!provider) {
        this.logger.warn(`No context provider registered for: ${entry.provider}`);
        results[entry.key] = {
          [PROVIDER_ERROR_KEY]: `Unknown context provider: ${entry.provider}`,
          [TRANSIENT_CONTEXT_KEY]: true,
        };
        continue;
      }

      try {
        this.logger.debug(`Resolving context: ${entry.provider} (key: ${entry.key})`);
        const value = await provider.resolve(entry.props);
        results[entry.key] = value;
        this.logger.debug(`Resolved context: ${entry.key}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Context provider '${entry.provider}' failed: ${message}`);
        results[entry.key] = {
          [PROVIDER_ERROR_KEY]: message,
          [TRANSIENT_CONTEXT_KEY]: true,
        };
      }
    }

    return results;
  }
}
