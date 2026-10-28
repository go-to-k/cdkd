import { afterAll, beforeAll, describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the seventeenth batch reaches (`sdk-wire-cases-17.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`. `EFSProvider` and
// `Route53Provider` build their own clients (`getClient`, and EFS's
// 5xx-retry-free `CreateMountTarget` client) rather than taking
// `getAwsClients()`'s, so each package is mocked and every instance captured.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-efs', (orig) => wrap(orig, 'EFSClient'));
vi.mock('@aws-sdk/client-route-53', (orig) => wrap(orig, 'Route53Client'));

// A create token is retired when its create succeeds, so the next create of the
// same logical id mints another and no two creates would send the same request
// (the harness's determinism check). Each (scope, logical id) answers one fixed
// token here instead; CreateAccessPoint's `ClientToken` and CreateHostedZone's
// `CallerReference` are the ones that take it.
vi.mock('../../../src/provisioning/providers/idempotency-token.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  acquireIdempotencyToken: ({ scope, logicalId }: { scope: string; logicalId: string }) => ({
    value: `cdkd-${scope}-${logicalId}`,
    release: () => undefined,
  }),
}));

import { CASES_17 } from './sdk-wire-cases-17.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';

// The file system's CreationToken is a stack-scoped token; no deploy puts a
// stack in scope here, and with no ledger bound it is the deterministic
// nonce-free hash, which is what these probes compare.
let unscopedBefore = false;
beforeAll(() => {
  unscopedBefore = allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(unscopedBefore);
});

describe('SDK wire coverage (batch 17)', () => {
  describeWireCases(CASES_17);
});
