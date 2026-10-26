import { describe, expect, it, vi } from 'vite-plus/test';
import { LambdaCoreClient } from '@aws-sdk/client-lambda-core';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { S3Client } from '@aws-sdk/client-s3';
import { describeWireCases, record, setOutputOverrides } from './sdk-wire-harness.js';
import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';
import { CloudWatchAnomalyDetectorProvider } from '../../../src/provisioning/providers/cloudwatch-anomaly-detector-provider.js';

// The client classes the fifth batch reaches (`sdk-wire-cases-5.ts`), wrapped
// as in `sdk-wire-coverage.test.ts`: every instance, shared or provider-built
// (KMS, Step Functions and S3 Vectors build their own), is captured.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-kms', (orig) => wrap(orig, 'KMSClient'));
vi.mock('@aws-sdk/client-sfn', (orig) => wrap(orig, 'SFNClient'));
vi.mock('@aws-sdk/client-s3', (orig) => wrap(orig, 'S3Client'));
vi.mock('@aws-sdk/client-s3vectors', (orig) => wrap(orig, 'S3VectorsClient'));
vi.mock('@aws-sdk/client-lambda-core', (orig) => wrap(orig, 'LambdaCoreClient'));
vi.mock('@aws-sdk/client-lambda', (orig) => wrap(orig, 'LambdaClient'));
vi.mock('@aws-sdk/client-cloudwatch', (orig) => wrap(orig, 'CloudWatchClient'));
vi.mock('@aws-sdk/client-eventbridge', (orig) => wrap(orig, 'EventBridgeClient'));

const clients = {
  lambdaCore: new LambdaCoreClient({}),
  lambda: new LambdaClient({}),
  cloudWatch: new CloudWatchClient({}),
  eventBridge: new EventBridgeClient({}),
  s3: new S3Client({}),
  credentialConfig: {},
};

vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

// A create token is retired when its create succeeds, so the next create of the
// same logical id mints another and no two creates would send the same request
// (the harness's determinism check). Each (scope, logical id) answers one fixed
// token here instead; the network connector's create is the one that takes it.
vi.mock('../../../src/provisioning/providers/idempotency-token.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  acquireIdempotencyToken: ({ scope, logicalId }: { scope: string; logicalId: string }) => ({
    value: `cdkd-${scope}-${logicalId}`,
    release: () => undefined,
  }),
}));

import { CASES_5 } from './sdk-wire-cases-5.js';

describe('SDK wire coverage (batch 5)', () => {
  describeWireCases(CASES_5);
});

// The lockout bypass is a flag on PutKeyPolicy, which an update sends only with
// a policy change, so no bag probe observes it: removing or varying the flag
// alone sends nothing. Read here on the call itself (go-to-k/cdkd#5299).
describe('AWS::KMS::Key BypassPolicyLockoutSafetyCheck on an update that changes the policy', () => {
  const policy = (action: string) => ({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: '*' }, Action: action, Resource: '*' }],
  });

  it.each([
    [true, true],
    ['true', true],
    [false, false],
    [undefined, false],
  ])('declared %j: PutKeyPolicy carries the bypass: %s', async (bypass, sent) => {
    setOutputOverrides(undefined);
    const bag = (action: string) => ({
      KeyPolicy: policy(action),
      ...(bypass !== undefined && { BypassPolicyLockoutSafetyCheck: bypass }),
    });
    const outcome = await record(() =>
      new KMSProvider().update('L', 'k', 'AWS::KMS::Key', bag('kms:*'), bag('kms:Decrypt'))
    );
    expect(outcome).toMatchObject({ threw: false });
    const puts = (outcome as { wire: string }).wire
      .split('\n')
      .filter((line) => line.startsWith('["PutKeyPolicyCommand"'));
    expect(puts).toHaveLength(1);
    if (sent) expect(puts[0]).toContain('\\"BypassPolicyLockoutSafetyCheck\\":true');
    else expect(puts[0]).not.toContain('BypassPolicyLockoutSafetyCheck');
  });
});

// A bag probe varies a time, but cannot tell WHICH instant reaches the wire:
// an offset-less time read in the host's zone differs from the UTC reading by
// the offset alone. Read here under a non-UTC TZ: CloudFormation documents
// `yyyy-MM-dd'T'HH:mm:ss` with no offset and reads it as UTC
// (go-to-k/cdkd#5311).
describe('AWS::CloudWatch::AnomalyDetector ExcludedTimeRanges without an offset', () => {
  it.each([
    ['2026-01-01T00:00:00', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01T00:00:00+09:00', '2025-12-31T15:00:00.000Z'],
  ])('%s is sent as %s under TZ=Asia/Tokyo', async (time, instant) => {
    const original = process.env['TZ'];
    process.env['TZ'] = 'Asia/Tokyo';
    try {
      let sent: unknown;
      setOutputOverrides({
        PutAnomalyDetectorCommand: (input) => {
          sent = input['Configuration'];
          return {};
        },
      });
      const outcome = await record(() =>
        new CloudWatchAnomalyDetectorProvider().create('L', 'AWS::CloudWatch::AnomalyDetector', {
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Stat: 'Sum',
          Configuration: { ExcludedTimeRanges: [{ StartTime: time, EndTime: time }] },
        })
      );
      expect(outcome).toMatchObject({ threw: false });
      const range = (sent as { ExcludedTimeRanges: { StartTime: Date; EndTime: Date }[] })
        .ExcludedTimeRanges[0]!;
      expect(range.StartTime.toISOString()).toBe(instant);
      expect(range.EndTime.toISOString()).toBe(instant);
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
  });
});
