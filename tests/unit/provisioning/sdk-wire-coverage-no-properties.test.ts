import { describe, vi } from 'vite-plus/test';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the no-property cases reach (`sdk-wire-cases-no-properties.ts`),
// wrapped as in `sdk-wire-coverage.test.ts` so every instance is captured. The
// wait condition handle reaches none: an unmocked client would trip the
// network fence.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-bedrock-agentcore-control', (orig) =>
  wrap(orig, 'BedrockAgentCoreControlClient')
);

const clients = {
  bedrockAgentCoreControl: new BedrockAgentCoreControlClient({}),
};

vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_NO_PROPERTIES } from './sdk-wire-cases-no-properties.js';

describe('SDK wire coverage (no properties)', () => {
  describeWireCases(CASES_NO_PROPERTIES);
});
