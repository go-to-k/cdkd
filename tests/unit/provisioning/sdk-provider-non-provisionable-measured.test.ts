/**
 * `SDK_PROVIDER_NON_PROVISIONABLE_TYPES` closes the Cloud Control route of a
 * registered type per TYPE, and its membership is a measurement that goes
 * stale when AWS gives a type handlers: six entries sat there for months after
 * AWS made them `FULLY_MUTABLE`, refusing templates Cloud Control could have
 * served. The provider-coverage audit records the measured side
 * (`tier1NonProvisionable`, refreshed daily from `ListTypes`), so this binds
 * the hand-written set to it in both directions. A refresh that finds AWS
 * gave a type handlers now fails here instead of leaving its route closed.
 *
 * A type kept on the SDK route although Cloud Control has handlers belongs in
 * `KEPT_DESPITE_CC_HANDLERS` below, with the reason Cloud Control cannot
 * address cdkd's resource.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { loadProviderClasses, registerAllProviders } from '../../../src/provisioning/register-providers.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { SDK_PROVIDER_NON_PROVISIONABLE_TYPES } from '../../../src/provisioning/unsupported-types.js';

const KEPT_DESPITE_CC_HANDLERS: ReadonlyMap<string, string> = new Map([]);

/**
 * Providers whose `disableCcApiFallback` is NOT about missing handlers, by the
 * type they serve. Every other opt-out must serve only types AWS still reports
 * `NON_PROVISIONABLE`, or it closes a route Cloud Control could take.
 */
const OPT_OUT_FOR_ANOTHER_REASON: ReadonlyMap<string, string> = new Map([
  ['AWS::CloudFormation::Stack', "Cloud Control's handler would call CloudFormation CreateStack"],
]);

const report = JSON.parse(
  readFileSync(resolve(__dirname, '../../../docs/_generated/provider-coverage.json'), 'utf8')
) as { tier1?: string[]; tier1NonProvisionable?: string[] };

describe('SDK_PROVIDER_NON_PROVISIONABLE_TYPES matches the measured provider coverage', () => {
  const measured = new Set(report.tier1NonProvisionable ?? []);

  it('reads a measured list', () => {
    expect(report.tier1NonProvisionable).toBeDefined();
    expect(measured.size).toBeGreaterThan(5);
  });

  it('lists every registered type AWS reports NON_PROVISIONABLE', () => {
    const missing = [...measured].filter((t) => !SDK_PROVIDER_NON_PROVISIONABLE_TYPES.has(t));
    expect(missing).toEqual([]);
  });

  it('lists no type AWS has since given Cloud Control handlers, unless kept for a stated reason', () => {
    const stale = [...SDK_PROVIDER_NON_PROVISIONABLE_TYPES].filter(
      (t) => !measured.has(t) && !KEPT_DESPITE_CC_HANDLERS.has(t)
    );
    expect(stale).toEqual([]);
  });

  it('opts a provider out of Cloud Control only for a NON_PROVISIONABLE type or a stated reason', async () => {
    const registry = new ProviderRegistry();
    registerAllProviders(registry, await loadProviderClasses());
    const providers = (registry as unknown as { providers: Map<string, ResourceProvider> })
      .providers;
    let optedOut = 0;
    const stale: string[] = [];
    for (const [type, provider] of providers) {
      if (provider.disableCcApiFallback !== true) continue;
      optedOut++;
      if (!measured.has(type) && !OPT_OUT_FOR_ANOTHER_REASON.has(type)) stale.push(type);
    }
    expect(optedOut).toBeGreaterThanOrEqual(3);
    expect(stale).toEqual([]);
  });

  it('keeps an exception only for a type AWS really gave handlers', () => {
    for (const type of KEPT_DESPITE_CC_HANDLERS.keys()) {
      expect(SDK_PROVIDER_NON_PROVISIONABLE_TYPES.has(type)).toBe(true);
      expect(measured.has(type)).toBe(false);
      expect(report.tier1).toContain(type);
    }
  });
});
