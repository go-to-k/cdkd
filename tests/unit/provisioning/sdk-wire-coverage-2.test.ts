import { afterAll, beforeAll, describe, vi } from 'vite-plus/test';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { S3Client } from '@aws-sdk/client-s3';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the second batch reaches (`sdk-wire-cases-2.ts`), wrapped
// as in `sdk-wire-coverage.test.ts`: every instance, shared or provider-built
// (ECR and Kinesis build their own), is captured.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-lambda', (orig) => wrap(orig, 'LambdaClient'));
vi.mock('@aws-sdk/client-cloudfront', (orig) => wrap(orig, 'CloudFrontClient'));
vi.mock('@aws-sdk/client-s3', (orig) => wrap(orig, 'S3Client'));
vi.mock('@aws-sdk/client-ecr', (orig) => wrap(orig, 'ECRClient'));
vi.mock('@aws-sdk/client-kinesis', (orig) => wrap(orig, 'KinesisClient'));

const clients = {
  lambda: new LambdaClient({}),
  cloudFront: new CloudFrontClient({}),
  s3: new S3Client({}),
};

vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_2 } from './sdk-wire-cases-2.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';

// The OAI's CallerReference is a stack-scoped token; no deploy puts a stack in
// scope here, and the token's value is not what these probes compare.
let unscopedBefore = false;
beforeAll(() => {
  unscopedBefore = allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(unscopedBefore);
});

describe('SDK wire coverage (batch 2)', () => {
  describeWireCases(CASES_2);
});
