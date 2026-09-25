/**
 * Issue #3713: `ccRouteUnavailable` in the generated coverage table is what
 * stops an unrecognized property from routing a type Cloud Control cannot take
 * over. The generator derives it from provider SOURCE, so this binds it to the
 * RUNTIME flag of every registered provider, in both directions — a getter or
 * an inherited field the parser cannot see would otherwise leave a type that
 * `getProviderFor` refuses routable by the predicate.
 */
import { describe, it, expect } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

describe('coverage ccRouteUnavailable matches each provider’s disableCcApiFallback', () => {
  const registry = new ProviderRegistry();
  registerAllProviders(registry);
  const providers = (registry as unknown as { providers: Map<string, ResourceProvider> })
    .providers;

  it('agrees for every registered type with a coverage record', () => {
    let compared = 0;
    let flagged = 0;
    for (const [resourceType, provider] of providers) {
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(resourceType);
      if (coverage === undefined) continue;
      compared++;
      const runtime = provider.disableCcApiFallback === true;
      if (runtime) flagged++;
      expect(coverage.ccRouteUnavailable, resourceType).toBe(runtime);
    }
    // Floors: the table was actually walked, and the flagged arm is populated.
    expect(compared).toBeGreaterThan(100);
    expect(flagged).toBeGreaterThanOrEqual(1);
  });
});
