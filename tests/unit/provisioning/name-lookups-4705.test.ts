/**
 * go-to-k/cdkd#4705 (C): the batched `lookupNames` of every name-adopting
 * SDK provider -- the call counts (batched per type, never one call per
 * resource where the service has a batch), whole-name matching
 * (`App-Queue1` never matches `App-Queue10`), bounded pagination with a
 * per-name fallback, and one run-wide limiter per API -- and that
 * `generatedCreateName` is the name `create()` sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateQueueCommand, GetQueueUrlCommand, ListQueuesCommand, QueueDoesNotExist } from '@aws-sdk/client-sqs';
import { DescribeAlarmsCommand, PutMetricAlarmCommand } from '@aws-sdk/client-cloudwatch';
import { CreateLogGroupCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ListRulesCommand } from '@aws-sdk/client-eventbridge';
import { ListTopicsCommand } from '@aws-sdk/client-sns';
import { DescribeClustersCommand } from '@aws-sdk/client-ecs';
import { DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ListStateMachinesCommand } from '@aws-sdk/client-sfn';

const sqsSend = vi.fn();
const cloudWatchSend = vi.fn();
const logsSend = vi.fn();
const eventBridgeSend = vi.fn();
const snsSend = vi.fn();
const client = (send: ReturnType<typeof vi.fn>) => ({
  send,
  config: { region: () => Promise.resolve('us-east-1') },
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: client(sqsSend),
    cloudWatch: client(cloudWatchSend),
    cloudWatchLogs: client(logsSend),
    eventBridge: client(eventBridgeSend),
    sns: client(snsSend),
    sts: client(vi.fn()),
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  quiet.child.mockReturnValue(quiet);
  return { getLogger: () => quiet };
});

import { SQSQueueProvider } from '../../../src/provisioning/providers/sqs-queue-provider.js';
import { CloudWatchAlarmProvider } from '../../../src/provisioning/providers/cloudwatch-alarm-provider.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';
import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';
import { LookupEachNameInstead } from '../../../src/provisioning/name-lookup.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';

const ctx = { region: 'us-east-1', stackName: 'App', propertiesByName: new Map() };
const names = (n: number, stem = 'App-R') => Array.from({ length: n }, (_, i) => `${stem}${i}`);
const accessDenied = (): Error =>
  Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
const callsOf = (send: ReturnType<typeof vi.fn>, ctor: new (...a: never[]) => unknown) =>
  send.mock.calls.map((c) => c[0]).filter((c) => c instanceof ctor) as Array<{ input: Record<string, unknown> }>;

beforeEach(() => {
  for (const s of [sqsSend, cloudWatchSend, logsSend, eventBridgeSend, snsSend]) s.mockReset();
});

describe('SQS: one ListQueues by the common prefix', () => {
  it('matches whole names only and makes one call', async () => {
    sqsSend.mockResolvedValue({
      QueueUrls: [
        'https://sqs.us-east-1.amazonaws.com/1/App-Queue1',
        'https://sqs.us-east-1.amazonaws.com/1/App-Queue10',
      ],
    });
    const found = await new SQSQueueProvider().lookupNames('AWS::SQS::Queue', ['App-Queue1', 'App-Queue2']);
    expect([...found]).toEqual([['App-Queue1', 'https://sqs.us-east-1.amazonaws.com/1/App-Queue1']]);
    const lists = callsOf(sqsSend, ListQueuesCommand);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.input).toMatchObject({ QueueNamePrefix: 'App-Queue', MaxResults: 1000 });
  });

  it('a listing that does not end within 3 pages, or is not granted, falls back to GetQueueUrl per name', async () => {
    sqsSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListQueuesCommand) return { QueueUrls: [], NextToken: 'more' };
      if (cmd instanceof GetQueueUrlCommand) {
        if (cmd.input.QueueName === 'App-Q1') return { QueueUrl: 'u1' };
        throw new QueueDoesNotExist({ message: 'no', $metadata: {} });
      }
      throw new Error('unexpected');
    });
    const found = await new SQSQueueProvider().lookupNames('AWS::SQS::Queue', ['App-Q1', 'App-Q2']);
    expect([...found]).toEqual([['App-Q1', 'u1']]);
    expect(callsOf(sqsSend, ListQueuesCommand)).toHaveLength(3);
    sqsSend.mockReset();
    sqsSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListQueuesCommand) throw accessDenied();
      return { QueueUrl: 'u' };
    });
    await expect(new SQSQueueProvider().lookupNames('AWS::SQS::Queue', ['App-Q1'])).resolves.toEqual(
      new Map([['App-Q1', 'u']])
    );
  });
});

describe('CloudWatch alarms: DescribeAlarms by AlarmNames, 100 per call, in parallel', () => {
  it.each([
    [1, 1],
    [100, 1],
    [101, 2],
    [300, 3],
  ])('%i alarms cost %i call(s)', async (n, calls) => {
    cloudWatchSend.mockResolvedValue({ MetricAlarms: [], CompositeAlarms: [] });
    await new CloudWatchAlarmProvider().lookupNames('AWS::CloudWatch::Alarm', names(n));
    const sent = callsOf(cloudWatchSend, DescribeAlarmsCommand);
    expect(sent).toHaveLength(calls);
    for (const c of sent) {
      expect((c.input['AlarmNames'] as string[]).length).toBeLessThanOrEqual(100);
      expect(c.input['AlarmTypes']).toEqual(['MetricAlarm', 'CompositeAlarm']);
    }
  });

  it('matches whole names, metric and composite alike', async () => {
    cloudWatchSend.mockResolvedValue({
      MetricAlarms: [{ AlarmName: 'App-A1' }, { AlarmName: 'App-A10' }],
      CompositeAlarms: [{ AlarmName: 'App-C' }],
    });
    const found = await new CloudWatchAlarmProvider().lookupNames('AWS::CloudWatch::Alarm', [
      'App-A1',
      'App-C',
    ]);
    expect([...found.keys()].sort()).toEqual(['App-A1', 'App-C']);
  });

  it('one run-wide limiter: two stacks of 300 alarms never have more than 3 calls in flight', async () => {
    let inFlight = 0;
    let max = 0;
    cloudWatchSend.mockImplementation(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return {};
    });
    await Promise.all([
      new CloudWatchAlarmProvider().lookupNames('AWS::CloudWatch::Alarm', names(300, 'A-')),
      new CloudWatchAlarmProvider().lookupNames('AWS::CloudWatch::Alarm', names(300, 'B-')),
    ]);
    expect(callsOf(cloudWatchSend, DescribeAlarmsCommand)).toHaveLength(6);
    expect(max).toBeLessThanOrEqual(3);
  });
});

describe('log groups: DescribeLogGroups by logGroupIdentifiers, 50 per call, in parallel', () => {
  it.each([
    [50, 1],
    [51, 2],
    [120, 3],
  ])('%i log groups cost %i call(s)', async (n, calls) => {
    logsSend.mockResolvedValue({ logGroups: [] });
    await new LogsLogGroupProvider().lookupNames('AWS::Logs::LogGroup', names(n, '/cdkd/App-L'));
    const sent = callsOf(logsSend, DescribeLogGroupsCommand);
    expect(sent).toHaveLength(calls);
    for (const c of sent) expect((c.input['logGroupIdentifiers'] as string[]).length).toBeLessThanOrEqual(50);
  });

  it('matches whole names; refused identifiers fall back to one prefix lookup per name', async () => {
    logsSend.mockImplementation(async (cmd: { input: Record<string, unknown> }) => {
      if (cmd.input['logGroupIdentifiers']) {
        throw Object.assign(new Error('bad'), { name: 'InvalidParameterException' });
      }
      return { logGroups: [{ logGroupName: '/cdkd/App-L1' }, { logGroupName: '/cdkd/App-L10' }] };
    });
    const found = await new LogsLogGroupProvider().lookupNames('AWS::Logs::LogGroup', [
      '/cdkd/App-L1',
      '/cdkd/App-L2',
    ]);
    expect([...found.keys()]).toEqual(['/cdkd/App-L1']);
  });
});

describe('EventBridge rules: one ListRules per bus, by the common prefix', () => {
  it('lists each bus once and matches whole names, mapping to the rule ARN', async () => {
    eventBridgeSend.mockImplementation(async (cmd: { input: Record<string, unknown> }) => ({
      Rules:
        cmd.input['EventBusName'] === 'custom'
          ? [{ Name: 'App-R2', Arn: 'arn:custom/App-R2' }]
          : [
              { Name: 'App-R1', Arn: 'arn:default/App-R1' },
              { Name: 'App-R10', Arn: 'arn:default/App-R10' },
            ],
    }));
    const found = await new EventBridgeRuleProvider().lookupNames('AWS::Events::Rule', ['App-R1', 'App-R2'], {
      propertiesByName: new Map([['App-R2', { EventBusName: 'custom' }]]),
    });
    expect(Object.fromEntries(found)).toEqual({ 'App-R1': 'arn:default/App-R1', 'App-R2': 'arn:custom/App-R2' });
    expect(callsOf(eventBridgeSend, ListRulesCommand)).toHaveLength(2);
  });
});

describe('SNS and Step Functions: one listing, or name by name', () => {
  it('SNS matches the whole last ARN segment; too many pages or a 403 asks for per-name lookups', async () => {
    snsSend.mockResolvedValue({
      Topics: [{ TopicArn: 'arn:aws:sns:us-east-1:1:App-T1' }, { TopicArn: 'arn:aws:sns:us-east-1:1:App-T10' }],
    });
    const found = await new SNSTopicProvider().lookupNames('AWS::SNS::Topic', ['App-T1']);
    expect([...found.keys()]).toEqual(['App-T1']);
    expect(callsOf(snsSend, ListTopicsCommand)).toHaveLength(1);
    snsSend.mockReset();
    snsSend.mockResolvedValue({ Topics: [], NextToken: 'more' });
    await expect(new SNSTopicProvider().lookupNames('AWS::SNS::Topic', ['x'])).rejects.toBeInstanceOf(
      LookupEachNameInstead
    );
    snsSend.mockReset();
    snsSend.mockRejectedValue(accessDenied());
    await expect(new SNSTopicProvider().lookupNames('AWS::SNS::Topic', ['x'])).rejects.toBeInstanceOf(
      LookupEachNameInstead
    );
  });

  it('Step Functions matches whole names to ARNs in one listing', async () => {
    const send = vi.fn().mockResolvedValue({
      stateMachines: [
        { name: 'App-S1', stateMachineArn: 'arn:s1' },
        { name: 'App-S10', stateMachineArn: 'arn:s10' },
      ],
    });
    const provider = new StepFunctionsProvider();
    (provider as unknown as { sfnClient: unknown }).sfnClient = { send };
    const found = await provider.lookupNames('AWS::StepFunctions::StateMachine', ['App-S1']);
    expect([...found]).toEqual([['App-S1', 'arn:s1']]);
    expect(send.mock.calls.filter((c) => c[0] instanceof ListStateMachinesCommand)).toHaveLength(1);
  });
});

describe('ECS clusters and ELBv2', () => {
  it('ECS: DescribeClusters 100 per call; an INACTIVE (deleted) cluster frees its name', async () => {
    const send = vi.fn(async (cmd: { input: { clusters?: string[] } }) => ({
      clusters: (cmd.input.clusters ?? [])
        .filter((n) => n === 'App-R1' || n === 'App-R2')
        .map((n) => ({ clusterName: n, status: n === 'App-R2' ? 'INACTIVE' : 'ACTIVE' })),
      failures: [],
    }));
    const provider = new ECSProvider();
    (provider as unknown as { ecsClient: unknown }).ecsClient = { send };
    const found = await provider.lookupNames('AWS::ECS::Cluster', names(150));
    expect([...found.keys()]).toEqual(['App-R1']);
    expect(send.mock.calls.filter((c) => c[0] instanceof DescribeClustersCommand)).toHaveLength(2);
  });

  it('ECS: a failure other than MISSING did not answer (throws)', async () => {
    const send = vi.fn(async () => ({ clusters: [], failures: [{ reason: 'THROTTLED' }] }));
    const provider = new ECSProvider();
    (provider as unknown as { ecsClient: unknown }).ecsClient = { send };
    await expect(provider.lookupNames('AWS::ECS::Cluster', ['x'])).rejects.toThrow(/did not answer/);
  });

  it('ELBv2: one listing of the region, matched on the whole name, case-insensitively', async () => {
    const send = vi.fn(async () => ({
      LoadBalancers: [
        { LoadBalancerName: 'app-lb1', LoadBalancerArn: 'arn:lb1' },
        { LoadBalancerName: 'App-LB10', LoadBalancerArn: 'arn:lb10' },
      ],
    }));
    const provider = new ELBv2Provider();
    (provider as unknown as { elbv2Client: unknown }).elbv2Client = { send };
    const found = await provider.lookupNames('AWS::ElasticLoadBalancingV2::LoadBalancer', ['App-LB1']);
    expect([...found]).toEqual([['App-LB1', 'arn:lb1']]);
    expect(send.mock.calls.filter((c) => c[0] instanceof DescribeLoadBalancersCommand)).toHaveLength(1);
  });
});

describe('generatedCreateName is the name create() sends', () => {
  it('SQS, CloudWatch alarm and log group', async () => {
    sqsSend.mockResolvedValue({ QueueUrl: 'u', Attributes: { QueueArn: 'arn' } });
    cloudWatchSend.mockResolvedValue({ MetricAlarms: [{ AlarmArn: 'arn' }] });
    logsSend.mockResolvedValue({ logGroups: [{ logGroupName: 'x', arn: 'arn' }] });
    await withStackName('App', async () => {
      const sqs = new SQSQueueProvider();
      await sqs.create('MyQueue', 'AWS::SQS::Queue', {}).catch(() => undefined);
      expect(callsOf(sqsSend, CreateQueueCommand)[0]!.input['QueueName']).toBe(
        sqs.generatedCreateName('AWS::SQS::Queue', 'MyQueue', {})
      );
      const alarm = new CloudWatchAlarmProvider();
      await alarm
        .create('MyAlarm', 'AWS::CloudWatch::Alarm', { MetricName: 'm', Namespace: 'n', ComparisonOperator: 'GreaterThanThreshold', EvaluationPeriods: 1, Threshold: 1 })
        .catch(() => undefined);
      expect(callsOf(cloudWatchSend, PutMetricAlarmCommand)[0]!.input['AlarmName']).toBe(
        alarm.generatedCreateName('AWS::CloudWatch::Alarm', 'MyAlarm', {})
      );
      const logs = new LogsLogGroupProvider();
      await logs.create('MyLogs', 'AWS::Logs::LogGroup', {}).catch(() => undefined);
      expect(callsOf(logsSend, CreateLogGroupCommand)[0]!.input['logGroupName']).toBe(
        logs.generatedCreateName('AWS::Logs::LogGroup', 'MyLogs', {})
      );
    });
  });

  it('is undefined when the template names the resource', () => {
    expect(new SQSQueueProvider().generatedCreateName('AWS::SQS::Queue', 'Q', { QueueName: 'mine' })).toBeUndefined();
    expect(new ECSProvider().generatedCreateName('AWS::ECS::Service', 'S', {})).toBeUndefined();
  });
});
