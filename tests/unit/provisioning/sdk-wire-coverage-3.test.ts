import { describe, vi } from 'vite-plus/test';
import { IAMClient } from '@aws-sdk/client-iam';
import { STSClient } from '@aws-sdk/client-sts';
import { describeWireCases } from './sdk-wire-harness.js';

// The client classes the third batch reaches (`sdk-wire-cases-3.ts`), wrapped
// as in `sdk-wire-coverage.test.ts`: every instance, shared or provider-built
// (the IAM create client, Budgets, CodeCommit and its S3 seed read, DLM and
// Scheduler build their own), is captured.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-iam', (orig) => wrap(orig, 'IAMClient'));
vi.mock('@aws-sdk/client-sts', (orig) => wrap(orig, 'STSClient'));
vi.mock('@aws-sdk/client-budgets', (orig) => wrap(orig, 'BudgetsClient'));
vi.mock('@aws-sdk/client-codecommit', (orig) => wrap(orig, 'CodeCommitClient'));
vi.mock('@aws-sdk/client-s3', (orig) => wrap(orig, 'S3Client'));
vi.mock('@aws-sdk/client-dlm', (orig) => wrap(orig, 'DLMClient'));
vi.mock('@aws-sdk/client-scheduler', (orig) => wrap(orig, 'SchedulerClient'));

const clients = {
  iam: new IAMClient({}),
  sts: new STSClient({}),
};

vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_3 } from './sdk-wire-cases-3.js';

describe('SDK wire coverage (batch 3)', () => {
  describeWireCases(CASES_3);
});
