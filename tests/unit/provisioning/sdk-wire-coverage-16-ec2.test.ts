import { afterAll, beforeAll, describe, vi } from 'vite-plus/test';
import { EC2Client } from '@aws-sdk/client-ec2';
import { describeWireCases } from './sdk-wire-harness.js';

// The client class the sixteenth batch's EC2 cases reach
// (`sdk-wire-cases-16-ec2.ts`), wrapped as in `sdk-wire-coverage.test.ts`.
// `EC2Provider` takes its main client from `getAwsClients()` and builds its
// own per-region clients, so the package is mocked and `getAwsClients()`
// answers a wrapped client.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-ec2', (orig) => wrap(orig, 'EC2Client'));

const clients = { ec2: new EC2Client({}), credentialConfig: {} };
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

// The NAT gateway, route table, network ACL and instance creates carry a
// cdkd-minted `ClientToken` (`acquireIdempotencyToken`, retired per successful
// create), which would differ on every create and fail the harness's
// determinism check. Each (scope, logical id) answers one fixed token here, as
// in batches 5 and 8.
vi.mock('../../../src/provisioning/providers/idempotency-token.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  acquireIdempotencyToken: ({ scope, logicalId }: { scope: string; logicalId: string }) => ({
    value: `cdkd-${scope}-${logicalId}`,
    release: () => undefined,
  }),
}));

import { CASES_16_EC2 } from './sdk-wire-cases-16-ec2.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';

// The tokenless creates' `ClientToken` is a stack-scoped token; no deploy puts
// a stack in scope here, so the token is the same hash on every call and the
// comparisons stay deterministic.
let unscopedBefore = false;
beforeAll(() => {
  unscopedBefore = allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(unscopedBefore);
});

describe('SDK wire coverage (batch 16, EC2)', () => {
  describeWireCases(CASES_16_EC2);
});
