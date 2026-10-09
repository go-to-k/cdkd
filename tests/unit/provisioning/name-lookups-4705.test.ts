/**
 * go-to-k/cdkd#4705 (C): the `lookupNames` of every name-adopting SDK
 * provider is an EXACT read by name -- a batch read by name where the service
 * has one (alarms, log groups, ECS clusters; their call counts pinned here),
 * otherwise one read per name -- never an eventually consistent listing,
 * which can omit a resource just created. One run-wide limiter per API. And
 * `generatedCreateName` is the name `create()` sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateQueueCommand, GetQueueUrlCommand, ListQueuesCommand, QueueDoesNotExist } from '@aws-sdk/client-sqs';
import { DescribeAlarmsCommand, PutMetricAlarmCommand } from '@aws-sdk/client-cloudwatch';
import { CreateLogGroupCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  DescribeRuleCommand,
  ListRulesCommand,
  ResourceNotFoundException as EventsNotFound,
} from '@aws-sdk/client-eventbridge';
import {
  GetTopicAttributesCommand,
  ListTopicsCommand,
  NotFoundException as SnsNotFound,
} from '@aws-sdk/client-sns';
import { DescribeClustersCommand } from '@aws-sdk/client-ecs';
import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

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

describe('SQS: one exact GetQueueUrl per name, never ListQueues', () => {
  // The real-AWS repro (cross-backend-same-stack, Phase 2b): ListQueues by
  // prefix omitted a queue another deployment had created about a minute
  // earlier, so the create adopted it and the rollback deleted it.
  it('finds a holder a listing would omit: ListQueues is never sent', async () => {
    sqsSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListQueuesCommand) return { QueueUrls: [] };
      if (cmd instanceof GetQueueUrlCommand) {
        if (cmd.input.QueueName === 'App-Queue1') return { QueueUrl: 'https://q/App-Queue1' };
        throw new QueueDoesNotExist({ message: 'no', $metadata: {} });
      }
      throw new Error('unexpected');
    });
    const found = await new SQSQueueProvider().lookupNames('AWS::SQS::Queue', ['App-Queue1', 'App-Queue2']);
    expect([...found]).toEqual([['App-Queue1', 'https://q/App-Queue1']]);
    expect(callsOf(sqsSend, ListQueuesCommand)).toHaveLength(0);
    expect(callsOf(sqsSend, GetQueueUrlCommand).map((c) => c.input['QueueName'])).toEqual([
      'App-Queue1',
      'App-Queue2',
    ]);
  });

  it('a read that fails otherwise (throttle, 403) throws: the guard refuses or warns, never reads it as free', async () => {
    sqsSend.mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    await expect(new SQSQueueProvider().lookupNames('AWS::SQS::Queue', ['App-Q1'])).rejects.toThrow(
      'slow down'
    );
    sqsSend.mockReset();
    sqsSend.mockRejectedValue(accessDenied());
    await expect(new SQSQueueProvider().lookupNames('AWS::SQS::Queue', ['App-Q1'])).rejects.toThrow(
      'denied'
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

describe('EventBridge rules: one exact DescribeRule per name, on its own bus', () => {
  it('finds a holder a listing would omit, on the default and a custom bus; ListRules is never sent', async () => {
    eventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListRulesCommand) return { Rules: [] };
      if (cmd instanceof DescribeRuleCommand) {
        const bus = cmd.input.EventBusName ?? 'default';
        if (cmd.input.Name === 'App-R1' && bus === 'default') return { Arn: 'arn:default/App-R1' };
        if (cmd.input.Name === 'App-R2' && bus === 'custom') return { Arn: 'arn:custom/App-R2' };
        throw new EventsNotFound({ message: 'no', $metadata: {} });
      }
      throw new Error('unexpected');
    });
    const found = await new EventBridgeRuleProvider().lookupNames(
      'AWS::Events::Rule',
      ['App-R1', 'App-R2', 'App-R3'],
      { propertiesByName: new Map([['App-R2', { EventBusName: 'custom' }]]) }
    );
    expect(Object.fromEntries(found)).toEqual({ 'App-R1': 'arn:default/App-R1', 'App-R2': 'arn:custom/App-R2' });
    expect(callsOf(eventBridgeSend, ListRulesCommand)).toHaveLength(0);
  });

  it('a read that fails otherwise throws', async () => {
    eventBridgeSend.mockRejectedValue(new Error('boom'));
    await expect(
      new EventBridgeRuleProvider().lookupNames('AWS::Events::Rule', ['App-R1'], { propertiesByName: new Map() })
    ).rejects.toThrow('boom');
  });
});

describe('SNS and Step Functions: no listing; the guard reads each ARN exactly through import()', () => {
  it('neither provider offers a listing-based lookupNames', () => {
    expect((new SNSTopicProvider() as { lookupNames?: unknown }).lookupNames).toBeUndefined();
    expect((new StepFunctionsProvider() as { lookupNames?: unknown }).lookupNames).toBeUndefined();
  });

  it('SNS import of a known ARN is one GetTopicAttributes; NotFound is free, anything else throws', async () => {
    snsSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListTopicsCommand) return { Topics: [] };
      if (cmd instanceof GetTopicAttributesCommand) return { Attributes: {} };
      throw new Error('unexpected');
    });
    const arn = 'arn:aws:sns:us-east-1:1:App-T1';
    const found = await new SNSTopicProvider().import({
      logicalId: 'T1',
      resourceType: 'AWS::SNS::Topic',
      stackName: 'App',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: arn,
    });
    expect(found?.physicalId).toBe(arn);
    expect(callsOf(snsSend, ListTopicsCommand)).toHaveLength(0);
    snsSend.mockReset();
    snsSend.mockRejectedValue(new SnsNotFound({ message: 'no', $metadata: {} }));
    await expect(
      new SNSTopicProvider().import({
        logicalId: 'T1',
        resourceType: 'AWS::SNS::Topic',
        stackName: 'App',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: arn,
      })
    ).resolves.toBeNull();
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

  it('ELBv2: one exact Describe by Names per name, never a region listing; a failure throws', async () => {
    const send = vi.fn(async (cmd: { input: { Names?: string[] } }) => {
      const asked = cmd.input.Names;
      if (asked === undefined) return { LoadBalancers: [] };
      if (asked[0] === 'App-LB1') return { LoadBalancers: [{ LoadBalancerName: 'App-LB1', LoadBalancerArn: 'arn:lb1' }] };
      throw Object.assign(new Error('nf'), { name: 'LoadBalancerNotFoundException' });
    });
    const provider = new ELBv2Provider();
    (provider as unknown as { elbv2Client: unknown }).elbv2Client = { send };
    const found = await provider.lookupNames('AWS::ElasticLoadBalancingV2::LoadBalancer', ['App-LB1', 'App-LB2']);
    expect([...found]).toEqual([['App-LB1', 'arn:lb1']]);
    const calls = send.mock.calls.map((c) => c[0]).filter((c) => c instanceof DescribeLoadBalancersCommand);
    expect(calls.map((c) => c.input.Names)).toEqual([['App-LB1'], ['App-LB2']]);
    send.mockRejectedValue(new Error('throttled'));
    await expect(provider.lookupNames('AWS::ElasticLoadBalancingV2::LoadBalancer', ['x'])).rejects.toThrow('throttled');
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

describe('review CB-13: an ELBv2 Name given as an intrinsic is a declared name, never a crash', () => {
  it.each(['AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancingV2::TargetGroup'])(
    '%s with Name {Ref} (and Fn::Join, Fn::Sub, Fn::ImportValue): no generated name',
    (type) => {
      const provider = new ELBv2Provider();
      for (const Name of [{ Ref: 'P' }, { 'Fn::Join': ['-', ['a', 'b']] }, { 'Fn::Sub': 'x-${AWS::Region}' }, { 'Fn::ImportValue': 'E' }]) {
        expect(withStackName('App', () => provider.generatedCreateName(type, 'Lb', { Name })), JSON.stringify(Name)).toBeUndefined();
      }
      expect(withStackName('App', () => provider.generatedCreateName(type, 'Lb', {}))).toMatch(/^App-Lb/);
    }
  );
});

describe('G6: the ELBv2 target group lookup', () => {
  it('one exact DescribeTargetGroups by Names per name; not found is free', async () => {
    const send = vi.fn(async (cmd: { input: { Names?: string[] } }) => {
      if (cmd.input.Names?.[0] === 'App-Tg1') {
        return { TargetGroups: [{ TargetGroupName: 'App-Tg1', TargetGroupArn: 'arn:tg1' }] };
      }
      throw Object.assign(new Error('nf'), { name: 'TargetGroupNotFoundException' });
    });
    const provider = new ELBv2Provider();
    (provider as unknown as { elbv2Client: unknown }).elbv2Client = { send };
    const found = await provider.lookupNames('AWS::ElasticLoadBalancingV2::TargetGroup', ['App-Tg1', 'App-Tg2']);
    expect([...found]).toEqual([['App-Tg1', 'arn:tg1']]);
    const calls = send.mock.calls.map((c) => c[0]).filter((c) => c instanceof DescribeTargetGroupsCommand);
    expect(calls.map((c) => (c as { input: { Names?: string[] } }).input.Names)).toEqual([['App-Tg1'], ['App-Tg2']]);
  });
});

describe('review CB-15: a resource being deleted reads as absent, so its create waits out the deletion itself', () => {
  it('Step Functions: a DELETING state machine is not a holder', async () => {
    const send = vi.fn(async () => ({ status: 'DELETING', name: 'App-S1' }));
    const provider = new StepFunctionsProvider();
    (provider as unknown as { sfnClient: unknown }).sfnClient = { send };
    await expect(
      provider.import({
        logicalId: 'S1',
        resourceType: 'AWS::StepFunctions::StateMachine',
        stackName: 'App',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: 'arn:aws:states:us-east-1:1:stateMachine:App-S1',
      })
    ).resolves.toBeNull();
    send.mockResolvedValue({ status: 'ACTIVE', name: 'App-S1' } as never);
    await expect(
      provider.import({
        logicalId: 'S1',
        resourceType: 'AWS::StepFunctions::StateMachine',
        stackName: 'App',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: 'arn:aws:states:us-east-1:1:stateMachine:App-S1',
      })
    ).resolves.toMatchObject({ physicalId: 'arn:aws:states:us-east-1:1:stateMachine:App-S1' });
  });

  it('SQS: a queue deleted within the minute answers GetQueueUrl with QueueDoesNotExist, which is free', async () => {
    sqsSend.mockRejectedValue(new QueueDoesNotExist({ message: 'gone', $metadata: {} }));
    await expect(new SQSQueueProvider().lookupNames('AWS::SQS::Queue', ['App-Q1'])).resolves.toEqual(new Map());
  });

  it('ECS: an INACTIVE (deleted) cluster frees its name (covered above); S3: a 404 HeadBucket is free', async () => {
    const { S3BucketProvider } = await import('../../../src/provisioning/providers/s3-bucket-provider.js');
    const provider = new S3BucketProvider();
    const send = vi.fn(async () => {
      throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    });
    (provider as unknown as { s3Client: unknown }).s3Client = { send };
    await expect(
      provider.import({
        logicalId: 'B',
        resourceType: 'AWS::S3::Bucket',
        stackName: 'App',
        region: 'us-east-1',
        properties: { BucketName: 'app-b' },
      })
    ).resolves.toBeNull();
  });
});

describe('review CB-18: an EventBridge rule on an intrinsic bus never reads the default bus', () => {
  it('asks the guard to wait for the resolved bus, and refuses to guess one if asked anyway', async () => {
    const provider = new EventBridgeRuleProvider();
    expect(provider.lookupNeedsResolvedProperties('AWS::Events::Rule', { EventBusName: { Ref: 'Bus' } })).toBe(true);
    expect(provider.lookupNeedsResolvedProperties('AWS::Events::Rule', { EventBusName: 'custom' })).toBe(false);
    expect(provider.lookupNeedsResolvedProperties('AWS::Events::Rule', {})).toBe(false);
    await expect(
      provider.lookupNames('AWS::Events::Rule', ['App-R1'], {
        propertiesByName: new Map([['App-R1', { EventBusName: { Ref: 'Bus' } }]]),
      })
    ).rejects.toThrow(/not resolved/);
    expect(eventBridgeSend).not.toHaveBeenCalled();
  });
});
