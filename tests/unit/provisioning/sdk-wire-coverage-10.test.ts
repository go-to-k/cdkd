import { describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the tenth batch reaches (`sdk-wire-cases-10.ts`), wrapped
// as in `sdk-wire-coverage.test.ts`. The EMR and RDS proxy providers build
// their own clients (a create client among them), so the packages are mocked
// rather than `getAwsClients()`.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-emr', (orig) => wrap(orig, 'EMRClient'));
vi.mock('@aws-sdk/client-rds', (orig) => wrap(orig, 'RDSClient'));

import { CASES_10, describeEmrRdsExtras } from './sdk-wire-cases-10.js';

describe('SDK wire coverage (batch 10)', () => {
  describeWireCases(CASES_10);
});

describeEmrRdsExtras();
