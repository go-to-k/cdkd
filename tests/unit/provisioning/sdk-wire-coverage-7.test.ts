import { afterAll, beforeAll, describe, vi } from 'vite-plus/test';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { STSClient } from '@aws-sdk/client-sts';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the seventh batch reaches (`sdk-wire-cases-7.ts` and
// `sdk-wire-cases-7-lambda.ts`), wrapped as in `sdk-wire-coverage.test.ts`, so
// every instance (shared or provider-built) is captured. The AppSync child
// types rebuild their ARN through `getAccountInfo` (STS), and the Lambda
// providers take their client from `getAwsClients().lambda`.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-appsync', (orig) => wrap(orig, 'AppSyncClient'));
vi.mock('@aws-sdk/client-s3', (orig) => wrap(orig, 'S3Client'));
vi.mock('@aws-sdk/client-sts', (orig) => wrap(orig, 'STSClient'));
vi.mock('@aws-sdk/client-lambda', (orig) => wrap(orig, 'LambdaClient'));
vi.mock('@aws-sdk/client-s3tables', (orig) => wrap(orig, 'S3TablesClient'));

const clients = { sts: new STSClient({}), lambda: new LambdaClient({}), credentialConfig: {} };
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_7 } from './sdk-wire-cases-7.js';
import { describeAppsyncExtras } from './sdk-wire-cases-7-appsync.js';
import { LAMBDA_CASES, describeLambdaExtras } from './sdk-wire-cases-7-lambda.js';
import { describeS3tablesExtras } from './sdk-wire-cases-7-s3tables.js';

describe('SDK wire coverage (batch 7)', () => {
  describeWireCases(CASES_7);
});

describe('SDK wire coverage (batch 7, Lambda)', () => {
  // `Code.ZipFile` is zipped with the wall-clock time in its header, so two
  // creates straddling a 2-second boundary would differ: the clock is pinned
  // for these cases only.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  describeWireCases(LAMBDA_CASES);
});

describeAppsyncExtras();
describeLambdaExtras();
describeS3tablesExtras();
