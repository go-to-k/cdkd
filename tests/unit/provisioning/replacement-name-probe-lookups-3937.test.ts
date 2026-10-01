/**
 * go-to-k/cdkd#3937: the replacement name probe asks a name-adopting type's
 * SDK provider `import()` with the CREATE bag (the name in `properties`, no
 * `knownPhysicalId`). A lookup that stopped reading the name there would
 * answer `null` — "free" — and the rename would take the holder over, so the
 * lookup each probe relies on is pinned here against the real providers.
 * SNS, EventBridge and Step Functions have their own `import()` tests; S3 is
 * pinned here too.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetQueueUrlCommand, QueueDoesNotExist } from '@aws-sdk/client-sqs';
import { DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';

const sqsSend = vi.fn();
const cloudWatchSend = vi.fn();
const s3Send = vi.fn();
const logsSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: sqsSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudWatch: { send: cloudWatchSend, config: { region: () => Promise.resolve('us-east-1') } },
    s3: { send: s3Send, config: { region: () => Promise.resolve('us-east-1') } },
    cloudWatchLogs: { send: logsSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { SQSQueueProvider } from '../../../src/provisioning/providers/sqs-queue-provider.js';
import { CloudWatchAlarmProvider } from '../../../src/provisioning/providers/cloudwatch-alarm-provider.js';
import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { replacementNameProbe } from '../../../src/deployment/replacement-name-holder.js';

const base = { logicalId: 'Fn', stackName: 'MyStack', region: 'us-east-1' };
const probeFor = (resourceType: string) =>
  replacementNameProbe({
    resourceType,
    createdVia: 'sdk',
    change: {
      property: 'X',
      desiredName: 'theirs',
      heldName: 'mine',
      heldProperty: 'X',
      physicalId: 'mine',
    },
  });

describe('the #3937 name probe against the real SQS and CloudWatch lookups', () => {
  beforeEach(() => {
    sqsSend.mockReset();
    logsSend.mockReset();
    cloudWatchSend.mockReset();
    s3Send.mockReset();
  });

  it('S3: looks the create bag BucketName up with HeadBucket', async () => {
    s3Send.mockResolvedValueOnce({});

    const found = await new S3BucketProvider().import({
      ...base,
      resourceType: 'AWS::S3::Bucket',
      properties: { BucketName: 'theirs' },
      ...probeFor('AWS::S3::Bucket'),
    });

    expect(found).toEqual({ physicalId: 'theirs', attributes: {} });
    const command = s3Send.mock.calls[0]![0] as HeadBucketCommand;
    expect(command).toBeInstanceOf(HeadBucketCommand);
    expect(command.input).toEqual({ Bucket: 'theirs' });
  });

  it('S3: a name nobody holds answers null; another account\'s bucket throws', async () => {
    s3Send.mockRejectedValueOnce(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
    const input = {
      ...base,
      resourceType: 'AWS::S3::Bucket',
      properties: { BucketName: 'theirs' },
      ...probeFor('AWS::S3::Bucket'),
    };
    await expect(new S3BucketProvider().import(input)).resolves.toBeNull();

    s3Send.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { name: 'Forbidden' }));
    await expect(new S3BucketProvider().import(input)).rejects.toThrow('Forbidden');
  });

  it('SQS: looks the create bag QueueName up with GetQueueUrl', async () => {
    const url = 'https://sqs.us-east-1.amazonaws.com/123456789012/theirs';
    sqsSend.mockResolvedValueOnce({ QueueUrl: url });

    const found = await new SQSQueueProvider().import({
      ...base,
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: 'theirs' },
      ...probeFor('AWS::SQS::Queue'),
    });

    expect(found).toEqual({ physicalId: url, attributes: {} });
    expect(sqsSend).toHaveBeenCalledTimes(1);
    const command = sqsSend.mock.calls[0]![0] as GetQueueUrlCommand;
    expect(command).toBeInstanceOf(GetQueueUrlCommand);
    expect(command.input).toEqual({ QueueName: 'theirs' });
  });

  it('SQS: a name nobody holds answers null', async () => {
    sqsSend.mockRejectedValueOnce(
      new QueueDoesNotExist({ message: 'The specified queue does not exist.', $metadata: {} })
    );

    const found = await new SQSQueueProvider().import({
      ...base,
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: 'theirs' },
      ...probeFor('AWS::SQS::Queue'),
    });

    expect(found).toBeNull();
  });

  it('SQS: any other lookup failure throws, so the probe refuses', async () => {
    sqsSend.mockRejectedValueOnce(new Error('AccessDenied'));

    await expect(
      new SQSQueueProvider().import({
        ...base,
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: 'theirs' },
        ...probeFor('AWS::SQS::Queue'),
      })
    ).rejects.toThrow('AccessDenied');
  });

  it('CloudWatch: looks the create bag AlarmName up with DescribeAlarms', async () => {
    cloudWatchSend.mockResolvedValueOnce({ MetricAlarms: [{ AlarmName: 'theirs' }] });

    const found = await new CloudWatchAlarmProvider().import({
      ...base,
      resourceType: 'AWS::CloudWatch::Alarm',
      properties: { AlarmName: 'theirs' },
      ...probeFor('AWS::CloudWatch::Alarm'),
    });

    expect(found).toEqual({ physicalId: 'theirs', attributes: {} });
    const command = cloudWatchSend.mock.calls[0]![0] as DescribeAlarmsCommand;
    expect(command).toBeInstanceOf(DescribeAlarmsCommand);
    expect(command.input.AlarmNames).toEqual(['theirs']);
    // Omitted, AlarmTypes means metric alarms only (go-to-k/cdkd#4180).
    expect(command.input.AlarmTypes).toEqual(['MetricAlarm', 'CompositeAlarm']);
  });

  it('CloudWatch: a COMPOSITE alarm holding the name is found (#4180)', async () => {
    cloudWatchSend.mockResolvedValueOnce({
      MetricAlarms: [],
      CompositeAlarms: [{ AlarmName: 'theirs' }],
    });

    const found = await new CloudWatchAlarmProvider().import({
      ...base,
      resourceType: 'AWS::CloudWatch::Alarm',
      properties: { AlarmName: 'theirs' },
      ...probeFor('AWS::CloudWatch::Alarm'),
    });

    expect(found).toEqual({ physicalId: 'theirs', attributes: {} });
  });

  it('Logs: looks the create bag LogGroupName up EXACTLY, not by prefix (#4180)', async () => {
    logsSend.mockResolvedValueOnce({ logGroups: [{ logGroupName: '/app/theirs' }] });
    const found = await new LogsLogGroupProvider().import({
      ...base,
      resourceType: 'AWS::Logs::LogGroup',
      properties: { LogGroupName: '/app/theirs' },
      ...probeFor('AWS::Logs::LogGroup'),
    });
    expect(found).toEqual({ physicalId: '/app/theirs', attributes: {} });
    const command = logsSend.mock.calls[0]![0] as DescribeLogGroupsCommand;
    expect(command).toBeInstanceOf(DescribeLogGroupsCommand);
    expect(command.input.logGroupNamePrefix).toBe('/app/theirs');

    logsSend.mockResolvedValueOnce({ logGroups: [{ logGroupName: '/app/theirs-2' }] });
    const longer = await new LogsLogGroupProvider().import({
      ...base,
      resourceType: 'AWS::Logs::LogGroup',
      properties: { LogGroupName: '/app/theirs' },
      ...probeFor('AWS::Logs::LogGroup'),
    });
    expect(longer).toBeNull();
  });

  it('CloudWatch: any other lookup failure throws, so the probe refuses', async () => {
    cloudWatchSend.mockRejectedValueOnce(new Error('AccessDenied'));

    await expect(
      new CloudWatchAlarmProvider().import({
        ...base,
        resourceType: 'AWS::CloudWatch::Alarm',
        properties: { AlarmName: 'theirs' },
        ...probeFor('AWS::CloudWatch::Alarm'),
      })
    ).rejects.toThrow('AccessDenied');
  });

  it('CloudWatch: a name nobody holds answers null', async () => {
    cloudWatchSend.mockResolvedValueOnce({ MetricAlarms: [], CompositeAlarms: [] });

    const found = await new CloudWatchAlarmProvider().import({
      ...base,
      resourceType: 'AWS::CloudWatch::Alarm',
      properties: { AlarmName: 'theirs' },
      ...probeFor('AWS::CloudWatch::Alarm'),
    });

    expect(found).toBeNull();
  });
});
