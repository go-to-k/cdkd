import type { MissingContext } from '../../types/assembly.js';
import { getLogger } from '../../utils/logger.js';
import { displaySafe } from '../../utils/display-safe.js';
import { AZContextProvider } from './az-provider.js';
import { SSMContextProvider } from './ssm-provider.js';
import { HostedZoneContextProvider } from './hosted-zone-provider.js';
import { VpcContextProvider } from './vpc-provider.js';
import { CcApiContextProvider } from './cc-api-provider.js';
import { AmiContextProvider } from './ami-provider.js';
import { SecurityGroupContextProvider } from './security-group-provider.js';
import {
  LoadBalancerContextProvider,
  LoadBalancerListenerContextProvider,
} from './load-balancer-provider.js';
import { KeyContextProvider } from './key-provider.js';

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
    this.register('ami', new AmiContextProvider(awsConfig));
    this.register('security-group', new SecurityGroupContextProvider(awsConfig));
    this.register('load-balancer', new LoadBalancerContextProvider(awsConfig));
    this.register('load-balancer-listener', new LoadBalancerListenerContextProvider(awsConfig));
    this.register('key-provider', new KeyContextProvider(awsConfig));
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
      // `provider` and `key` are read straight out of the manifest's `missing`
      // list, so every RENDER of either goes through `displaySafe` — the `debug`
      // lines included ([#3479](https://github.com/go-to-k/cdkd/issues/3479)).
      // The LOOKUP above stays on the raw value: this pair identifies a provider
      // and a context key, and sanitizing what is used rather than shown would
      // change which provider answers.
      const shownProvider = displaySafe(entry.provider);
      const shownKey = displaySafe(entry.key);

      if (!provider) {
        this.logger.warn(`No context provider registered for: ${shownProvider}`);
        results[entry.key] = {
          // Sanitized here too, although this one is a context VALUE rather than
          // a rendered line: it is handed back to the CDK app, which is free to
          // put it in its own error, and `ContextStore.save` skips the whole
          // entry (it carries `TRANSIENT_CONTEXT_KEY`), so nothing downstream
          // needs the raw spelling.
          [PROVIDER_ERROR_KEY]: `Unknown context provider: ${shownProvider}`,
          [TRANSIENT_CONTEXT_KEY]: true,
        };
        continue;
      }

      try {
        this.logger.debug(`Resolving context: ${shownProvider} (key: ${shownKey})`);
        const value = await provider.resolve(entry.props);
        results[entry.key] = value;
        this.logger.debug(`Resolved context: ${shownKey}`);
      } catch (error) {
        // The provider's own failure text is sanitized as well. It is not
        // assembly-derived, but this is the RENDER SITE for every lookup argument
        // the `*-provider.ts` modules interpolate into a thrown message
        // (`parameterName`, `domainName`, a VPC filter), and those come from the
        // template's context queries. Leaving this half raw would defeat the
        // other half of the same sentence.
        const message = displaySafe(error instanceof Error ? error.message : String(error));
        this.logger.error(`Context provider '${shownProvider}' failed: ${message}`);
        results[entry.key] = {
          [PROVIDER_ERROR_KEY]: message,
          [TRANSIENT_CONTEXT_KEY]: true,
        };
      }
    }

    return results;
  }
}
