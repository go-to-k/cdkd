import { describe, vi } from 'vite-plus/test';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describeWireCases } from './sdk-wire-harness.js';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

// The client classes the global table reaches (`sdk-wire-cases-18-globaltable.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`. `DynamoDBGlobalTableProvider`
// takes its shared client from `getAwsClients().dynamoDB` and builds its own
// CreateTable client, a DynamoDB client per replica region and the
// Application Auto Scaling clients.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-dynamodb', (orig) => wrap(orig, 'DynamoDBClient'));
vi.mock('@aws-sdk/client-application-auto-scaling', (orig) =>
  wrap(orig, 'ApplicationAutoScalingClient')
);

const clients = { dynamoDB: new DynamoDBClient({}) };
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_18_GLOBAL_TABLE } from './sdk-wire-cases-18-globaltable.js';

vi.setConfig({ testTimeout: CONTENDED_CASE_TIMEOUT_MS });

describe('SDK wire coverage (batch 18, global table)', () => {
  describeWireCases(CASES_18_GLOBAL_TABLE);
});
