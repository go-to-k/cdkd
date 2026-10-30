import { describe, vi } from 'vite-plus/test';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the eleventh batch reaches (`sdk-wire-cases-11.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`. CloudTrail builds its own clients
// (a create client among them), so its package is mocked; the AgentCore runtime
// takes `getAwsClients()`'s client.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-cloudtrail', (orig) => wrap(orig, 'CloudTrailClient'));
vi.mock('@aws-sdk/client-bedrock-agentcore-control', (orig) =>
  wrap(orig, 'BedrockAgentCoreControlClient')
);

const clients = {
  bedrockAgentCoreControl: new BedrockAgentCoreControlClient({}),
};

vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_11 } from './sdk-wire-cases-11.js';

describe('SDK wire coverage (batch 11)', () => {
  describeWireCases(CASES_11);
});
