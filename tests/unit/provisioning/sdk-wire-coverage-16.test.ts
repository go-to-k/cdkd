import { describe, vi } from 'vite-plus/test';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describeWireCases } from './sdk-wire-harness.js';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

// The client classes the sixteenth batch reaches (`sdk-wire-cases-16.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`. `DynamoDBTableProvider` takes its
// shared client from `getAwsClients().dynamoDB` and builds its own
// `CreateTable` client in that client's region.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-dynamodb', (orig) => wrap(orig, 'DynamoDBClient'));

const clients = { dynamoDB: new DynamoDBClient({}) };
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_16 } from './sdk-wire-cases-16.js';

// Each table bag enumerates a few hundred provider runs, past Vitest's 5 s default.
vi.setConfig({ testTimeout: CONTENDED_CASE_TIMEOUT_MS });

describe('SDK wire coverage (batch 16)', () => {
  describeWireCases(CASES_16);
});
