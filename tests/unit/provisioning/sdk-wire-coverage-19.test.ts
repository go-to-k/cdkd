import { describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the nineteenth batch reaches (`sdk-wire-cases-19.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`. `RDSProvider` builds its own
// clients (a 5xx-retry-free create client among them) rather than taking
// `getAwsClients()`'s, plus an EC2 client for a removed DBCluster
// `VpcSecurityGroupIds`, so both packages are mocked and every instance
// captured.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-rds', (orig) => wrap(orig, 'RDSClient'));
vi.mock('@aws-sdk/client-ec2', (orig) => wrap(orig, 'EC2Client'));

import { CASES_19, describeRdsExtras } from './sdk-wire-cases-19.js';

describe('SDK wire coverage (batch 19)', () => {
  describeWireCases(CASES_19);
});

describeRdsExtras();
