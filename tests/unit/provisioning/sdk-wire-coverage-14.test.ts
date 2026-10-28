import { describe, vi } from 'vite-plus/test';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { describeWireCases } from './sdk-wire-harness.js';

// The client class the fourteenth batch reaches (`sdk-wire-cases-14.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`. `LambdaEventSourceMappingProvider`
// takes its shared client from `getAwsClients().lambda` and builds its own
// `CreateEventSourceMapping` client in that client's region
// (`getCreateClient`), so the package is mocked and both are captured.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-lambda', (orig) => wrap(orig, 'LambdaClient'));

const clients = { lambda: new LambdaClient({}), credentialConfig: {} };
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_14, describeEventSourceMappingExtras } from './sdk-wire-cases-14.js';

describe('SDK wire coverage (batch 14)', () => {
  describeWireCases(CASES_14);
});

describeEventSourceMappingExtras();
