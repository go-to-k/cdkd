/**
 * Issue #3713: `ccRouteUnavailable` in the generated coverage table is what
 * stops an unrecognized property from routing a type Cloud Control cannot take
 * over. The generator derives it from SOURCE text — each provider's
 * `disableCcApiFallback`, and the `'cc-broken'` members of
 * `STICKY_CC_MIGRATION_EXEMPT` — so this binds it to the RUNTIME values of
 * both, in both directions. A getter or an inherited field the provider parser
 * cannot see, or an exemption-table shape `parseCcBrokenTypes` misreads, would
 * otherwise leave a type routable by the predicate that `getProviderFor`
 * refuses, or that the sticky-escape hands straight back to its SDK provider.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  ProviderRegistry,
  STICKY_CC_MIGRATION_EXEMPT,
} from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

describe('coverage ccRouteUnavailable matches disableCcApiFallback OR a cc-broken exemption', () => {
  const registry = new ProviderRegistry();
  registerAllProviders(registry);
  const providers = (registry as unknown as { providers: Map<string, ResourceProvider> })
    .providers;

  it('agrees for every registered type with a coverage record', () => {
    let compared = 0;
    let flaggedByProvider = 0;
    let flaggedByExemption = 0;
    for (const [resourceType, provider] of providers) {
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(resourceType);
      if (coverage === undefined) continue;
      compared++;
      const optsOut = provider.disableCcApiFallback === true;
      const ccBroken = STICKY_CC_MIGRATION_EXEMPT.get(resourceType)?.mode === 'cc-broken';
      if (optsOut) flaggedByProvider++;
      if (ccBroken) flaggedByExemption++;
      expect(coverage.ccRouteUnavailable, resourceType).toBe(optsOut || ccBroken);
    }
    // Floors: the table was actually walked, and EACH arm is populated — an
    // aggregate floor would stay green with one source silently dead.
    expect(compared).toBeGreaterThan(100);
    expect(flaggedByProvider).toBeGreaterThanOrEqual(1);
    expect(flaggedByExemption).toBeGreaterThanOrEqual(1);
  });

  it('every cc-broken exemption has a coverage record, so the walk above reaches it', () => {
    const ccBroken = [...STICKY_CC_MIGRATION_EXEMPT]
      .filter(([, entry]) => entry.mode === 'cc-broken')
      .map(([type]) => type);
    expect(ccBroken.length).toBeGreaterThanOrEqual(1);
    for (const type of ccBroken) {
      expect(providers.has(type), type).toBe(true);
      expect(PROPERTY_COVERAGE_BY_TYPE.get(type)?.ccRouteUnavailable, type).toBe(true);
    }
  });
});
