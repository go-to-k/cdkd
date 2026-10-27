import { describe, vi } from 'vite-plus/test';
import { STSClient } from '@aws-sdk/client-sts';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the twelfth batch reaches (`sdk-wire-cases-12.ts`),
// wrapped as in `sdk-wire-coverage.test.ts`. Every provider here builds its own
// clients (a create client among them), so each package is mocked; the Auto
// Scaling provider also builds an EC2 client. `CreateApi` / `UpdateApi` build
// `ExecuteApiArn` through `getAccountInfo`, which reads STS through
// `getAwsClients()`.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-apigatewayv2', (orig) => wrap(orig, 'ApiGatewayV2Client'));
vi.mock('@aws-sdk/client-sts', (orig) => wrap(orig, 'STSClient'));
vi.mock('@aws-sdk/client-ecs', (orig) => wrap(orig, 'ECSClient'));
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', (orig) =>
  wrap(orig, 'ElasticLoadBalancingV2Client')
);
vi.mock('@aws-sdk/client-firehose', (orig) => wrap(orig, 'FirehoseClient'));
vi.mock('@aws-sdk/client-auto-scaling', (orig) => wrap(orig, 'AutoScalingClient'));
vi.mock('@aws-sdk/client-ec2', (orig) => wrap(orig, 'EC2Client'));

const clients = { sts: new STSClient({}), credentialConfig: {} };
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_12, describeEcsExtras } from './sdk-wire-cases-12.js';

describe('SDK wire coverage (batch 12)', () => {
  describeWireCases(CASES_12);
});

describeEcsExtras();
