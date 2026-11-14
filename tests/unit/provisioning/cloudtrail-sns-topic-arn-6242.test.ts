import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-cloudtrail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-cloudtrail')>()),
  CloudTrailClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { trailAttributes } from '../../../src/provisioning/providers/cloudtrail/shared.js';

/**
 * go-to-k/cdkd#6242: a trail recorded only `Arn`, so `Fn::GetAtt [Trail,
 * SnsTopicArn]` (CDK's `trailSnsTopicArn`) fell back to the TRAIL's ARN.
 * Measured against CloudFormation: the value is the notified topic's ARN.
 */
describe('trailAttributes (#6242)', () => {
  it('records the topic ARN beside the trail ARN', () => {
    expect(
      trailAttributes(
        'arn:aws:cloudtrail:us-east-1:123456789012:trail/t',
        'arn:aws:sns:us-east-1:123456789012:topic'
      )
    ).toStrictEqual({
      Arn: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/t',
      SnsTopicArn: 'arn:aws:sns:us-east-1:123456789012:topic',
    });
  });

  it('records no SnsTopicArn for a trail with no topic, and never a non-answer as the Arn', () => {
    expect(trailAttributes('arn:aws:cloudtrail:us-east-1:123456789012:trail/t', undefined)).toStrictEqual({
      Arn: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/t',
    });
    expect(trailAttributes(undefined, '')).toStrictEqual({});
  });
});

describe('CloudTrailProvider.update records what UpdateTrail answered (#6242)', () => {
  const TRAIL = 'arn:aws:cloudtrail:us-east-1:123456789012:trail/t';
  beforeEach(() => mockSend.mockReset());
  const run = (desired: Record<string, unknown>, previous: Record<string, unknown>) =>
    new CloudTrailProvider().update('T', TRAIL, 'AWS::CloudTrail::Trail', desired, previous);

  it('records the NEW topic after a topic change', async () => {
    mockSend.mockResolvedValue({ TrailARN: TRAIL, SnsTopicARN: 'arn:aws:sns:us-east-1:123456789012:b' });
    const result = await run(
      { S3BucketName: 'bkt', SnsTopicName: 'b', IsLogging: true },
      { S3BucketName: 'bkt', SnsTopicName: 'a', IsLogging: true }
    );
    expect(result.attributes).toStrictEqual({
      Arn: TRAIL,
      SnsTopicArn: 'arn:aws:sns:us-east-1:123456789012:b',
    });
  });

  it('records no SnsTopicArn after the topic is removed', async () => {
    mockSend.mockResolvedValue({ TrailARN: TRAIL });
    const result = await run(
      { S3BucketName: 'bkt', IsLogging: true },
      { S3BucketName: 'bkt', SnsTopicName: 'a', IsLogging: true }
    );
    expect(result.attributes).toStrictEqual({ Arn: TRAIL });
  });

  it('keeps the record (no attributes) when UpdateTrail answers no TrailARN', async () => {
    mockSend.mockResolvedValue({});
    const result = await run({ S3BucketName: 'bkt', IsLogging: true }, { S3BucketName: 'bkt', IsLogging: true });
    expect(result.attributes).toBeUndefined();
  });
});
