import { afterAll, beforeAll, describe, vi } from 'vite-plus/test';
import { EC2Client } from '@aws-sdk/client-ec2';
import { describeWireCases } from './sdk-wire-harness.js';

// The client class the VPC endpoint case reaches
// (`sdk-wire-cases-vpc-endpoint.ts`), wrapped as in `sdk-wire-coverage.test.ts`.
// `EC2VPCEndpointProvider` takes its client from `getAwsClients()`, so the
// package is mocked and `getAwsClients()` answers a wrapped client.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-ec2', (orig) => wrap(orig, 'EC2Client'));

const clients = { ec2: new EC2Client({}), credentialConfig: {} };
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

// `CreateVpcEndpoint` carries a cdkd-minted `ClientToken`
// (`acquireIdempotencyToken`, retired per successful create), which would
// differ on every create and fail the harness's determinism check. Each
// (scope, logical id) answers one fixed token here, as in batch 16.
vi.mock('../../../src/provisioning/providers/idempotency-token.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  acquireIdempotencyToken: ({ scope, logicalId }: { scope: string; logicalId: string }) => ({
    value: `cdkd-${scope}-${logicalId}`,
    release: () => undefined,
  }),
}));

import { CASES_VPC_ENDPOINT } from './sdk-wire-cases-vpc-endpoint.js';
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

describe('SDK wire coverage (VPC endpoint)', () => {
  describeWireCases(CASES_VPC_ENDPOINT);
});

