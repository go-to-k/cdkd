import { describe, it, expect } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../src/provisioning/register-providers.js';

// go-to-k/cdkd#6694: the handle (which signs) and the wait condition (which
// polls) must share ONE store, and that store must get the state bucket every
// command configures through `setCustomResourceResponseBucket`. The provider
// tests stub the store, so only this test sees the real wiring.
describe('wait-condition providers share the registry signal store', () => {
  it('registers both types on the store setCustomResourceResponseBucket configures', async () => {
    const registry = new ProviderRegistry();
    registerAllProviders(registry, await loadProviderClasses());
    expect(() => registry.waitConditionSignals.requireBucket()).toThrow(/No cdkd state bucket/);
    registry.setCustomResourceResponseBucket('cdkd-state-123456789012');

    for (const type of [
      'AWS::CloudFormation::WaitConditionHandle',
      'AWS::CloudFormation::WaitCondition',
    ]) {
      const provider = registry.getProvider(type) as unknown as { signals: unknown };
      expect(provider.signals, type).toBe(registry.waitConditionSignals);
    }
    expect(registry.waitConditionSignals.requireBucket()).toBe('cdkd-state-123456789012');
  });
});
