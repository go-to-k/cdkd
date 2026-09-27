/**
 * Issue #3713: `ccRouteUnavailable` in the generated coverage table is what
 * stops an unrecognized property from routing a type Cloud Control cannot take
 * over. The generator derives it from SOURCE text — each provider's
 * `disableCcApiFallback`, the `'cc-broken'` members of
 * `STICKY_CC_MIGRATION_EXEMPT`, and `SDK_PROVIDER_NON_PROVISIONABLE_TYPES`
 * (#3871) — so this binds it to the RUNTIME values of all three, in both
 * directions. A getter or an inherited field the provider parser
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
import {
  NON_PROVISIONABLE_TYPES,
  SDK_PROVIDER_NON_PROVISIONABLE_TYPES,
} from '../../../src/provisioning/unsupported-types.js';

describe('coverage ccRouteUnavailable matches NON_PROVISIONABLE, disableCcApiFallback OR a cc-broken exemption', () => {
  const registry = new ProviderRegistry();
  registerAllProviders(registry);
  const providers = (registry as unknown as { providers: Map<string, ResourceProvider> })
    .providers;

  it('agrees for every registered type with a coverage record', () => {
    let compared = 0;
    let flaggedByProvider = 0;
    let flaggedByExemption = 0;
    let flaggedByType = 0;
    for (const [resourceType, provider] of providers) {
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(resourceType);
      if (coverage === undefined) continue;
      compared++;
      const optsOut = provider.disableCcApiFallback === true;
      const ccBroken = STICKY_CC_MIGRATION_EXEMPT.get(resourceType)?.mode === 'cc-broken';
      const noHandlers = SDK_PROVIDER_NON_PROVISIONABLE_TYPES.has(resourceType);
      if (optsOut) flaggedByProvider++;
      if (ccBroken) flaggedByExemption++;
      if (noHandlers) flaggedByType++;
      expect(coverage.ccRouteUnavailable, resourceType).toBe(optsOut || ccBroken || noHandlers);
    }
    // Floors: the table was actually walked, and EACH arm is populated — an
    // aggregate floor would stay green with one source silently dead.
    expect(compared).toBeGreaterThan(100);
    expect(flaggedByProvider).toBeGreaterThanOrEqual(1);
    expect(flaggedByExemption).toBeGreaterThanOrEqual(1);
    expect(flaggedByType).toBeGreaterThanOrEqual(1);
  });

  // Issue #3871. The generated Tier 3 set drops a type once its provider is
  // registered and the audit is regenerated, so a registered type still in it
  // is a provider added for a NON_PROVISIONABLE type — the one moment to list
  // it, before the regen takes the only other record away.
  it('every registered type AWS reports NON_PROVISIONABLE is in SDK_PROVIDER_NON_PROVISIONABLE_TYPES', () => {
    const missing = [...providers.keys()].filter(
      (type) => NON_PROVISIONABLE_TYPES.has(type) && !SDK_PROVIDER_NON_PROVISIONABLE_TYPES.has(type)
    );
    expect(missing).toEqual([]);
  });

  it('every SDK_PROVIDER_NON_PROVISIONABLE_TYPES member is registered and has a coverage record', () => {
    expect(SDK_PROVIDER_NON_PROVISIONABLE_TYPES.size).toBeGreaterThanOrEqual(19);
    for (const type of SDK_PROVIDER_NON_PROVISIONABLE_TYPES) {
      expect(providers.has(type), type).toBe(true);
      expect(PROPERTY_COVERAGE_BY_TYPE.get(type)?.ccRouteUnavailable, type).toBe(true);
    }
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
