import { describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The client class the Connect instance provider builds
// (`sdk-wire-cases-connect.ts`), wrapped as in `sdk-wire-coverage.test.ts`.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-connect', (orig) => wrap(orig, 'ConnectClient'));

// A create token is retired when its create succeeds, so the next create would
// send another and fail the harness's determinism check. Each (scope, logical
// id) answers one fixed token here; CreateInstance's `ClientToken` takes it.
vi.mock('../../../src/provisioning/providers/idempotency-token.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  acquireIdempotencyToken: ({ scope, logicalId }: { scope: string; logicalId: string }) => ({
    value: `cdkd-${scope}-${logicalId}`,
    release: () => undefined,
  }),
}));

import { CASES_CONNECT } from './sdk-wire-cases-connect.js';

describe('SDK wire coverage (Connect instance)', () => {
  describeWireCases(CASES_CONNECT);
});
