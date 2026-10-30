import { describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the eighteenth batch reaches (`sdk-wire-cases-18.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`. Each provider here builds its own
// clients (a separate 5xx-retry-free create client among them) rather than
// taking `getAwsClients()`'s, so each package is mocked and every instance
// captured.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-kinesis', (orig) => wrap(orig, 'KinesisClient'));
vi.mock('@aws-sdk/client-codebuild', (orig) => wrap(orig, 'CodeBuildClient'));
vi.mock('@aws-sdk/client-elasticache', (orig) => wrap(orig, 'ElastiCacheClient'));

import { CASES_18 } from './sdk-wire-cases-18.js';

describe('SDK wire coverage (batch 18)', () => {
  describeWireCases(CASES_18);
});
