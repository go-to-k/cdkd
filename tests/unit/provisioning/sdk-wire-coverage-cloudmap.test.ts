import { describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the Cloud Map cases reach (`sdk-wire-cases-cloudmap.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`: the provider builds its own Cloud
// Map and STS clients, and every instance is captured.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-servicediscovery', (orig) => wrap(orig, 'ServiceDiscoveryClient'));
vi.mock('@aws-sdk/client-sts', (orig) => wrap(orig, 'STSClient'));

import { CASES_CLOUDMAP } from './sdk-wire-cases-cloudmap.js';

describe('SDK wire coverage (Cloud Map)', () => {
  describeWireCases(CASES_CLOUDMAP);
});
