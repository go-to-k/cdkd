import { describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the ninth batch reaches (`sdk-wire-cases-9.ts`), wrapped
// as in `sdk-wire-coverage.test.ts`. Every Glue provider builds its own Glue
// clients (`newGlueClients`, a create client among them) and its own STS
// client for the caller account a tag ARN or a catalog check needs, so the
// packages are mocked rather than `getAwsClients()`.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-glue', (orig) => wrap(orig, 'GlueClient'));
vi.mock('@aws-sdk/client-sts', (orig) => wrap(orig, 'STSClient'));

import { CASES_9, describeGlueExtras } from './sdk-wire-cases-9.js';

describe('SDK wire coverage (batch 9)', () => {
  describeWireCases(CASES_9);
});

describeGlueExtras();
