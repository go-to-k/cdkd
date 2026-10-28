import { afterAll, beforeAll, describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the fifteenth batch reaches (`sdk-wire-cases-15.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`. Every provider of the batch builds
// its own clients (a create client among them), never one from
// `getAwsClients()`, so the packages are mocked. `NeptuneProvider` also builds
// an EC2 client for a removed cluster `VpcSecurityGroupIds`.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-fsx', (orig) => wrap(orig, 'FSxClient'));
vi.mock('@aws-sdk/client-neptune', (orig) => wrap(orig, 'NeptuneClient'));
vi.mock('@aws-sdk/client-ec2', (orig) => wrap(orig, 'EC2Client'));
vi.mock('@aws-sdk/client-docdb', (orig) => wrap(orig, 'DocDBClient'));

import { CASES_15, describeFsxExtras } from './sdk-wire-cases-15.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';

// The FSx `ClientRequestToken` is a stack-scoped token; no deploy puts a stack
// in scope here, and no create-token ledger is bound, so the token is the same
// hash on every call and the comparisons stay deterministic.
let unscopedBefore = false;
beforeAll(() => {
  unscopedBefore = allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(unscopedBefore);
});

describe('SDK wire coverage (batch 15)', () => {
  describeWireCases(CASES_15);
});

describeFsxExtras();
