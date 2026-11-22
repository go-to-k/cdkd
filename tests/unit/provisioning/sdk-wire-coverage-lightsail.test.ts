import { describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The client class the Lightsail alarm provider builds
// (`sdk-wire-cases-lightsail.ts`), wrapped as in `sdk-wire-coverage.test.ts`.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-lightsail', (orig) => wrap(orig, 'LightsailClient'));

import { CASES_LIGHTSAIL } from './sdk-wire-cases-lightsail.js';

describe('SDK wire coverage (Lightsail alarm)', () => {
  describeWireCases(CASES_LIGHTSAIL);
});
