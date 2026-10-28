import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vite-plus/test';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { STSClient } from '@aws-sdk/client-sts';
import { SSMClient } from '@aws-sdk/client-ssm';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import {
  ACCOUNT,
  DECLARED_DEFAULT,
  TAG_THROWS,
  createOnlyOf,
  describeWireCases,
  paths,
  setOutputOverrides,
  touchesCreateOnly,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { CASES_2 } from './sdk-wire-cases-2.js';
import { CASES_IAM_SECRETS } from './sdk-wire-cases-iam-secrets.js';
import { CASES_3 } from './sdk-wire-cases-3.js';
import { CASES_4 } from './sdk-wire-cases-4.js';
import { CASES_5 } from './sdk-wire-cases-5.js';
import { CASES_6 } from './sdk-wire-cases-6.js';
import { CASES_7 } from './sdk-wire-cases-7.js';
import { LAMBDA_CASES } from './sdk-wire-cases-7-lambda.js';
import { CASES_8 } from './sdk-wire-cases-8.js';
import { ACM_CASES } from './sdk-wire-cases-8-acm.js';
import { CASES_9 } from './sdk-wire-cases-9.js';
import { CASES_10 } from './sdk-wire-cases-10.js';
import { CASES_11 } from './sdk-wire-cases-11.js';
import { CASES_12 } from './sdk-wire-cases-12.js';
import { CASES_13 } from './sdk-wire-cases-13.js';
import { CASES_14 } from './sdk-wire-cases-14.js';
import { CASES_15 } from './sdk-wire-cases-15.js';
import { CASES_16 } from './sdk-wire-cases-16.js';
import { CASES_16_EC2 } from './sdk-wire-cases-16-ec2.js';
import { CASES_17 } from './sdk-wire-cases-17.js';
import { CASES_18 } from './sdk-wire-cases-18.js';
import { CASES_18_GLOBAL_TABLE } from './sdk-wire-cases-18-globaltable.js';
import { CASES_CLOUDMAP } from './sdk-wire-cases-cloudmap.js';
import { CASES_NO_PROPERTIES } from './sdk-wire-cases-no-properties.js';

// Every client class a covered provider reaches, wrapped so each instance
// (shared or provider-built) is captured. A `vi.mock` factory is hoisted, so
// it imports the harness itself.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-sns', (orig) => wrap(orig, 'SNSClient'));
vi.mock('@aws-sdk/client-sqs', (orig) => wrap(orig, 'SQSClient'));
vi.mock('@aws-sdk/client-sts', (orig) => wrap(orig, 'STSClient'));
vi.mock('@aws-sdk/client-ssm', (orig) => wrap(orig, 'SSMClient'));
vi.mock('@aws-sdk/client-eventbridge', (orig) => wrap(orig, 'EventBridgeClient'));
vi.mock('@aws-sdk/client-cloudwatch', (orig) => wrap(orig, 'CloudWatchClient'));

const clients = {
  sns: new SNSClient({}),
  sqs: new SQSClient({}),
  sts: new STSClient({}),
  ssm: new SSMClient({}),
  eventBridge: new EventBridgeClient({}),
  cloudWatch: new CloudWatchClient({}),
};

vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { SQSQueueProvider } from '../../../src/provisioning/providers/sqs-queue-provider.js';
import { SNSSubscriptionProvider } from '../../../src/provisioning/providers/sns-subscription-provider.js';
import { SNSTopicPolicyProvider } from '../../../src/provisioning/providers/sns-topic-policy-provider.js';
import { SQSQueuePolicyProvider } from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';
import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { EventBridgeBusProvider } from '../../../src/provisioning/providers/eventbridge-bus-provider.js';
import { CloudWatchAlarmProvider } from '../../../src/provisioning/providers/cloudwatch-alarm-provider.js';

/**
 * `ListSubscriptionsByTopic` answers the subscriptions of the bag under probe,
 * the i-th as `<topic>:sub-<i>` with a confirmed ARN, so a removed inline
 * subscription resolves to an ARN and the update reaches `Unsubscribe`. A fake
 * that lists nothing leaves the removal path at the list call.
 */
function armTopicSubscriptions(physicalId: string, bag: Bag): void {
  const subs = Array.isArray(bag['Subscription']) ? (bag['Subscription'] as Bag[]) : [];
  const listed = subs.map((s, i) => ({
    Protocol: s['Protocol'],
    Endpoint: s['Endpoint'],
    SubscriptionArn: `${physicalId}:sub-${i}`,
    TopicArn: physicalId,
  }));
  setOutputOverrides({ ListSubscriptionsByTopicCommand: () => ({ Subscriptions: listed }) });
}

const ROLE = `arn:aws:iam::${ACCOUNT}:role/r`;
const QUEUE_ARN = (name: string) => `arn:aws:sqs:us-east-1:${ACCOUNT}:${name}`;

const SUBSCRIPTION_REFUSED: Throw = {
  why: 'an inline Subscription without a string Protocol and Endpoint is refused before Subscribe',
  says: /inline Subscription entry requires string Protocol and/,
};

// Not a gap: CloudFormation keeps the live value when these are removed
// (measured A/B, go-to-k/cdkd#5004), so update() deliberately sends nothing.
const CFN_KEEPS_ON_REMOVAL =
  'CloudFormation keeps the live value on removal (go-to-k/cdkd#5004); deliberately absent from SQS_ATTRIBUTE_REMOVAL_RESET';
// Not a gap: SetQueueAttributes / SetTopicAttributes re-send the whole policy
// from `next` and never read `prev`, so a member removed from a still-declared
// policy is delivered by `next` alone (the update-add probe of the same path
// observes that).
const WHOLE_POLICY_FROM_NEXT =
  'update() re-sends the whole policy from next; prev is not read for a declared policy';

const TOPIC_ARN = (name: string) => `arn:aws:sns:us-east-1:${ACCOUNT}:${name}`;
const QUEUE_URL = (name: string) => `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/${name}`;
const POLICY = (action: string, resource: string) => ({
  Version: '2012-10-17',
  Statement: [
    { Sid: 's1', Effect: 'Allow', Principal: { AWS: ROLE }, Action: action, Resource: resource },
  ],
});

/**
 * `GetSubscriptionAttributes` answers the live subscription `bag` describes,
 * confirmed, in the string form SNS holds: the update plans against it.
 */
function armSubscriptionAttributes(
  _physicalId: string,
  bag: Bag,
  live: Record<string, string> = {}
): void {
  // What SNS answers for an unset attribute too.
  const attributes: Record<string, string> = {
    PendingConfirmation: 'false',
    RawMessageDelivery: 'false',
    ...live,
  };
  for (const [key, value] of Object.entries(bag)) {
    attributes[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  setOutputOverrides({ GetSubscriptionAttributesCommand: () => ({ Attributes: { ...attributes, ...live } }) });
}

/**
 * The attribute read answers the previous bag's document as the live `Policy`
 * of every queue / topic, so the update sees the queues it wrote carry it.
 */
const armLivePolicy =
  (command: string) =>
  (_physicalId: string, bag: Bag): void => {
    const doc = bag['PolicyDocument'];
    const attributes = doc === undefined ? {} : { Policy: JSON.stringify(doc) };
    setOutputOverrides({ [command]: () => ({ Attributes: attributes }) });
  };

const SUBSCRIPTION_IDENTITY_REQUIRED: Throw = {
  why: 'create() refuses a subscription without its TopicArn, Protocol and Endpoint before Subscribe',
  says: /(TopicArn|Protocol|Endpoint) is required for SNS subscription/,
};
const POLICY_REQUIRED: Throw = {
  why: 'both required members are refused when absent, before any call',
  says: /(Topics|Queues|PolicyDocument) is required for (SNS topic|SQS queue) policy/,
};
// Not a gap: the update clears every target the RECORD wrote (the topic
// policy's comma-joined id, the queue policy's written-queues attribute),
// never only what previousProperties lists, so dropping a written target from
// `prev` changes nothing (go-to-k/cdkd#4594).
const WRITTEN_FROM_RECORD =
  "the record names every target it wrote, so a dropped one is cleared whatever prev lists (go-to-k/cdkd#4594)";

const ALARM_FULL_PUT =
  'PutMetricAlarm replaces the whole alarm definition from next; a member next omits is cleared by AWS';
// Not a refusal: an unguarded read fails before PutMetricAlarm. No CDK app
// omits the schema-required Metric, so it stays a PR-body note, not an issue.
const METRIC_STAT_WITHOUT_METRIC: Throw = {
  why: 'a MetricStat without its schema-required Metric fails before PutMetricAlarm (an unguarded read)',
  says: /reading 'MetricName'/,
};
const SSM_VALUE_REQUIRED: Throw = {
  why: 'Value is refused when absent, before PutParameter',
  says: /Value is required for SSM parameter/,
};
const SSM_TYPE_DEFAULT_FROM_NEXT =
  "a removed Type falls back to 'String' in next's PutParameter; prev is not read";
// Not a gap: measured by a CloudFormation A/B (see removalHandledInUpdate in
// ssm-parameter-provider.ts), CloudFormation keeps these on removal too.
const SSM_CFN_KEEPS_ON_REMOVAL =
  'CloudFormation keeps the stored value on removal (measured A/B); update() omits it from the overwrite';
const BUS_NAME_REQUIRED: Throw = {
  why: 'Name is refused when absent, before CreateEventBus',
  says: /Name is required for EventBus/,
};
const BUS_POLICY_KEPT_ON_REMOVAL =
  'a removed Policy is left live and warned about, as CloudFormation leaves it (go-to-k/cdkd#5044)';
// Not a gap: a partner bus's Name must equal its EventSourceName, and Name is
// create-only, so no valid template changes one without replacing the bus.
const EVENT_SOURCE_PINNED_BY_NAME =
  "a partner bus's Name must equal its EventSourceName, so a change to it replaces through Name";

const REPLACED_FROM_NEXT =
  'the replacement subscription is created from next alone; prev is not read';

const SUBSCRIPTION_FULL: Bag = {
  TopicArn: TOPIC_ARN('t'),
  Protocol: 'sqs',
  Endpoint: QUEUE_ARN('q1'),
  FilterPolicy: { store: ['a'] },
  FilterPolicyScope: 'MessageBody',
  RawMessageDelivery: true,
  RedrivePolicy: { deadLetterTargetArn: QUEUE_ARN('dlq') },
  DeliveryPolicy: { healthyRetryPolicy: { numRetries: 3 } },
  ReplayPolicy: { PointType: 'Timestamp', StartingPoint: '2026-01-01T00:00:00Z' },
  SubscriptionRoleArn: ROLE,
};

const CASES: TypeCase[] = [
  {
    resourceType: 'AWS::SNS::Topic',
    provider: () => new SNSTopicProvider(),
    physicalId: `arn:aws:sns:us-east-1:${ACCOUNT}:t.fifo`,
    createOnly: createOnlyOf('AWS::SNS::Topic'),
    arm: armTopicSubscriptions,
    exempt: {},
    targets: [
      { path: ['Subscription', 0], command: 'UnsubscribeCommand', names: 'sub-0', notNames: 'sub-1' },
      { path: ['Subscription', 1], command: 'UnsubscribeCommand', names: 'sub-1', notNames: 'sub-0' },
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          TopicName: 't.fifo',
          FifoTopic: true,
          ContentBasedDeduplication: true,
          DisplayName: 'd',
          KmsMasterKeyId: 'alias/k',
          TracingConfig: 'Active',
          SignatureVersion: '2',
          FifoThroughputScope: 'Topic',
          MaximumMessageSize: 2048,
          ArchivePolicy: { MessageRetentionPeriod: 7 },
          DataProtectionPolicy: { Name: 'p', Version: '2021-06-01', Statement: [] },
          DeliveryStatusLogging: [
            {
              Protocol: 'lambda',
              SuccessFeedbackRoleArn: ROLE,
              FailureFeedbackRoleArn: ROLE,
              SuccessFeedbackSampleRate: '50',
            },
          ],
          Subscription: [
            { Protocol: 'sqs', Endpoint: QUEUE_ARN('q1') },
            { Protocol: 'sqs', Endpoint: QUEUE_ARN('q2') },
          ],
          Tags: [
            { Key: 'k1', Value: 'v1' },
            { Key: 'k2', Value: 'v2' },
          ],
        },
        variants: { 'DeliveryStatusLogging.0.Protocol': 'sqs' },
        expectedRemovalThrows: {
          ...TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
          'create:DeliveryStatusLogging.0.Protocol': {
            why: 'create() refuses a DeliveryStatusLogging entry without a supported Protocol (update() warns and skips it)',
            says: /DeliveryStatusLogging/,
          },
          ...Object.fromEntries(
            [0, 1].flatMap((i) =>
              ['create', 'update-remove'].flatMap((d) => [
                [`${d}:Subscription.${i}.Protocol`, SUBSCRIPTION_REFUSED],
                [`${d}:Subscription.${i}.Endpoint`, SUBSCRIPTION_REFUSED],
              ])
            )
          ),
        },
      },
      {
        // A value-dependent drop is invisible to a bag of truthy values only.
        name: 'falsy values',
        bag: {
          TopicName: 'f.fifo',
          FifoTopic: true,
          ContentBasedDeduplication: false,
          DisplayName: '',
        },
        expectedSilent: {
          'create:ContentBasedDeduplication':
            'CreateTopic gates on truthiness; false is the service default, so omitting it is equivalent',
          'create:DisplayName':
            'CreateTopic gates on truthiness; an empty display name is the service default',
        },
      },
    ],
  },
  {
    resourceType: 'AWS::SQS::Queue',
    provider: () => new SQSQueueProvider(),
    physicalId: `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/q.fifo`,
    createOnly: createOnlyOf('AWS::SQS::Queue'),
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagQueueCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagQueueCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'KMS encryption',
        bag: {
          QueueName: 'q.fifo',
          FifoQueue: true,
          ContentBasedDeduplication: true,
          DeduplicationScope: 'messageGroup',
          FifoThroughputLimit: 'perMessageGroupId',
          VisibilityTimeout: 31,
          MaximumMessageSize: 2048,
          MessageRetentionPeriod: 3600,
          DelaySeconds: 3,
          ReceiveMessageWaitTimeSeconds: 4,
          KmsMasterKeyId: 'alias/k',
          KmsDataKeyReusePeriodSeconds: 600,
          RedrivePolicy: {
            deadLetterTargetArn: QUEUE_ARN('dlq.fifo'),
            maxReceiveCount: 5,
          },
          RedriveAllowPolicy: { redrivePermission: 'allowAll' },
          Tags: [
            { Key: 'k1', Value: 'v1' },
            { Key: 'k2', Value: 'v2' },
          ],
        },
        expectedSilent: {
          'update-remove:DeduplicationScope': CFN_KEEPS_ON_REMOVAL,
          'update-remove:FifoThroughputLimit': CFN_KEEPS_ON_REMOVAL,
          'update-remove:RedrivePolicy.deadLetterTargetArn': WHOLE_POLICY_FROM_NEXT,
          'update-remove:RedrivePolicy.maxReceiveCount': WHOLE_POLICY_FROM_NEXT,
          'update-remove:RedriveAllowPolicy.redrivePermission': WHOLE_POLICY_FROM_NEXT,
        },
        expectedRemovalThrows: TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
      },
      {
        // `SqsManagedSseEnabled` is mutually exclusive with `KmsMasterKeyId`.
        name: 'SQS-managed encryption',
        bag: { QueueName: 'q', SqsManagedSseEnabled: true },
        expectedSilent: { 'update-remove:SqsManagedSseEnabled': CFN_KEEPS_ON_REMOVAL },
      },
      {
        name: 'falsy values',
        bag: {
          QueueName: 'q',
          ContentBasedDeduplication: false,
          DelaySeconds: 0,
          ReceiveMessageWaitTimeSeconds: 0,
        },
      },
    ],
  },
  {
    resourceType: 'AWS::SNS::Subscription',
    provider: () => new SNSSubscriptionProvider(),
    physicalId: `${TOPIC_ARN('t')}:sub-0`,
    createOnly: createOnlyOf('AWS::SNS::Subscription'),
    arm: armSubscriptionAttributes,
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: SUBSCRIPTION_FULL,
        expectedRemovalThrows: {
          'create:TopicArn': SUBSCRIPTION_IDENTITY_REQUIRED,
          'create:Protocol': SUBSCRIPTION_IDENTITY_REQUIRED,
          'create:Endpoint': SUBSCRIPTION_IDENTITY_REQUIRED,
        },
      },
      {
        name: 'falsy values',
        bag: {
          TopicArn: TOPIC_ARN('t'),
          Protocol: 'sqs',
          Endpoint: QUEUE_ARN('q1'),
          FilterPolicy: '',
          RawMessageDelivery: false,
        },
        expectedSilent: Object.fromEntries(
          ['update-add', 'update-remove'].flatMap((d) => [
            [`${d}:FilterPolicy`, DECLARED_DEFAULT],
            [`${d}:RawMessageDelivery`, DECLARED_DEFAULT],
          ])
        ),
        expectedRemovalThrows: {
          'create:TopicArn': SUBSCRIPTION_IDENTITY_REQUIRED,
          'create:Protocol': SUBSCRIPTION_IDENTITY_REQUIRED,
          'create:Endpoint': SUBSCRIPTION_IDENTITY_REQUIRED,
        },
      },
      {
        // An unconfirmed subscription is re-created rather than updated in
        // place, so every update reaches create() through replace().
        name: 'every declared property, pending confirmation',
        bag: SUBSCRIPTION_FULL,
        arm: (id, bag) => armSubscriptionAttributes(id, bag, { PendingConfirmation: 'true' }),
        // Re-created from next, so prev is never read: a member dropped from
        // the template is simply not sent to the new subscription.
        expectedSilent: Object.fromEntries(
          paths(SUBSCRIPTION_FULL)
            .filter((p) => !['TopicArn', 'Protocol', 'Endpoint'].includes(String(p[0])))
            .map((p) => [`update-remove:${p.join('.')}`, REPLACED_FROM_NEXT])
        ),
        expectedRemovalThrows: {
          'create:TopicArn': SUBSCRIPTION_IDENTITY_REQUIRED,
          'create:Protocol': SUBSCRIPTION_IDENTITY_REQUIRED,
          'create:Endpoint': SUBSCRIPTION_IDENTITY_REQUIRED,
        },
      },
    ],
  },
  {
    resourceType: 'AWS::SNS::TopicPolicy',
    provider: () => new SNSTopicPolicyProvider(),
    // What create() records: the comma-joined topics it wrote.
    physicalId: `${TOPIC_ARN('t1')},${TOPIC_ARN('t2')}`,
    createOnly: createOnlyOf('AWS::SNS::TopicPolicy'),
    wholeFromNext: { keys: (k) => k === 'PolicyDocument', reason: WHOLE_POLICY_FROM_NEXT },
    arm: armLivePolicy('GetTopicAttributesCommand'),
    exempt: {},
    targets: [
      {
        path: ['Topics', 1],
        command: 'SetTopicAttributesCommand',
        where: '__default_policy_ID',
        names: 't2',
        notNames: 't1',
      },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          Topics: [TOPIC_ARN('t1'), TOPIC_ARN('t2')],
          PolicyDocument: POLICY('sns:Publish', TOPIC_ARN('t1')),
        },
        expectedSilent: {
          'update-remove:Topics.0': WRITTEN_FROM_RECORD,
          'update-remove:Topics.1': WRITTEN_FROM_RECORD,
        },
        expectedRemovalThrows: Object.fromEntries(
          ['create', 'update-add', 'update-remove'].flatMap((d) => [
            [`${d}:Topics`, POLICY_REQUIRED],
            [`${d}:PolicyDocument`, POLICY_REQUIRED],
          ])
        ),
      },
    ],
  },
  {
    resourceType: 'AWS::SQS::QueuePolicy',
    provider: () => new SQSQueuePolicyProvider(),
    physicalId: QUEUE_URL('q1'),
    // What create() records: the first queue as the id, every queue it wrote
    // in the written-queues attribute.
    updateContext: {
      recordedAttributes: { 'cdkd:WrittenQueues': `${QUEUE_URL('q1')},${QUEUE_URL('q2')}` },
    },
    createOnly: createOnlyOf('AWS::SQS::QueuePolicy'),
    wholeFromNext: { keys: (k) => k === 'PolicyDocument', reason: WHOLE_POLICY_FROM_NEXT },
    arm: armLivePolicy('GetQueueAttributesCommand'),
    exempt: {},
    targets: [
      {
        path: ['Queues', 1],
        command: 'SetQueueAttributesCommand',
        where: '"Policy":""',
        names: 'q2',
        notNames: 'q1',
      },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          Queues: [QUEUE_URL('q1'), QUEUE_URL('q2')],
          PolicyDocument: POLICY('sqs:SendMessage', QUEUE_ARN('q1')),
        },
        expectedSilent: {
          'update-remove:Queues.0': WRITTEN_FROM_RECORD,
          'update-remove:Queues.1': WRITTEN_FROM_RECORD,
        },
        expectedRemovalThrows: Object.fromEntries(
          ['create', 'update-add', 'update-remove'].flatMap((d) => [
            [`${d}:Queues`, POLICY_REQUIRED],
            [`${d}:PolicyDocument`, POLICY_REQUIRED],
          ])
        ),
      },
    ],
  },
  {
    resourceType: 'AWS::SSM::Parameter',
    provider: () => new SSMParameterProvider(),
    physicalId: 'p',
    createOnly: createOnlyOf('AWS::SSM::Parameter'),
    exempt: {},
    targets: [
      { path: ['Tags', 'k1'], command: 'RemoveTagsFromResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 'k2'], command: 'RemoveTagsFromResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          Name: 'p',
          Type: 'StringList',
          Value: 'v',
          Description: 'd',
          Tags: { k1: 'v1', k2: 'v2' },
          AllowedPattern: '^v.*',
          Tier: 'Advanced',
          Policies: JSON.stringify([
            { Type: 'Expiration', Version: '1.0', Attributes: { Timestamp: '2030-01-01T00:00:00Z' } },
          ]),
          DataType: 'text',
        },
        expectedSilent: {
          'update-remove:Type': SSM_TYPE_DEFAULT_FROM_NEXT,
          ...Object.fromEntries(
            ['AllowedPattern', 'DataType', 'Description', 'Policies', 'Tier'].map((k) => [
              `update-remove:${k}`,
              SSM_CFN_KEEPS_ON_REMOVAL,
            ])
          ),
        },
        expectedRemovalThrows: Object.fromEntries(
          ['create', 'update-add', 'update-remove'].map((d) => [`${d}:Value`, SSM_VALUE_REQUIRED])
        ),
      },
      {
        name: 'falsy values',
        bag: { Name: 'p', Type: 'String', Value: 'v', Description: '', AllowedPattern: '' },
        expectedSilent: {
          'create:Type': DECLARED_DEFAULT,
          'update-add:Type': DECLARED_DEFAULT,
          'update-remove:Type': SSM_TYPE_DEFAULT_FROM_NEXT,
          'create:AllowedPattern': DECLARED_DEFAULT,
          'update-remove:AllowedPattern': SSM_CFN_KEEPS_ON_REMOVAL,
          'update-remove:Description': SSM_CFN_KEEPS_ON_REMOVAL,
        },
        expectedRemovalThrows: Object.fromEntries(
          ['create', 'update-add', 'update-remove'].map((d) => [`${d}:Value`, SSM_VALUE_REQUIRED])
        ),
      },
    ],
  },
  {
    resourceType: 'AWS::Events::EventBus',
    provider: () => new EventBridgeBusProvider(),
    physicalId: 'b',
    createOnly: createOnlyOf('AWS::Events::EventBus'),
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          Name: 'b',
          Description: 'd',
          KmsKeyIdentifier: 'alias/k',
          Policy: POLICY('events:PutEvents', `arn:aws:events:us-east-1:${ACCOUNT}:event-bus/b`),
          DeadLetterConfig: { Arn: QUEUE_ARN('dlq') },
          LogConfig: { Level: 'INFO', IncludeDetail: 'FULL' },
          Tags: [
            { Key: 'k1', Value: 'v1' },
            { Key: 'k2', Value: 'v2' },
          ],
        },
        expectedSilent: { 'update-remove:Policy': BUS_POLICY_KEPT_ON_REMOVAL },
        expectedRemovalThrows: {
          'create:Name': BUS_NAME_REQUIRED,
          ...TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
        },
      },
      {
        name: 'partner event source',
        bag: { Name: 'aws.partner/acme/s', EventSourceName: 'aws.partner/acme/s' },
        expectedSilent: {
          'update-add:EventSourceName': EVENT_SOURCE_PINNED_BY_NAME,
          'update-remove:EventSourceName': EVENT_SOURCE_PINNED_BY_NAME,
          'update-vary:EventSourceName': EVENT_SOURCE_PINNED_BY_NAME,
        },
        expectedRemovalThrows: { 'create:Name': BUS_NAME_REQUIRED },
      },
      {
        name: 'falsy values',
        bag: { Name: 'b', Description: '', KmsKeyIdentifier: '' },
        expectedSilent: Object.fromEntries(
          ['create', 'update-remove'].flatMap((d) => [
            [`${d}:Description`, DECLARED_DEFAULT],
            [`${d}:KmsKeyIdentifier`, DECLARED_DEFAULT],
          ])
        ),
        expectedRemovalThrows: { 'create:Name': BUS_NAME_REQUIRED },
      },
    ],
  },
  {
    resourceType: 'AWS::CloudWatch::Alarm',
    provider: () => new CloudWatchAlarmProvider(),
    physicalId: 'a',
    createOnly: createOnlyOf('AWS::CloudWatch::Alarm'),
    wholeFromNext: { keys: (k) => k !== 'Tags', reason: ALARM_FULL_PUT },
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'single metric',
        bag: {
          AlarmName: 'a',
          ComparisonOperator: 'GreaterThanThreshold',
          EvaluationPeriods: 2,
          Threshold: 5,
          ActionsEnabled: true,
          AlarmActions: [TOPIC_ARN('alarm')],
          AlarmDescription: 'd',
          DatapointsToAlarm: 1,
          InsufficientDataActions: [TOPIC_ARN('insufficient')],
          OKActions: [TOPIC_ARN('ok')],
          TreatMissingData: 'breaching',
          Unit: 'Count',
          MetricName: 'm',
          Namespace: 'ns',
          Period: 60,
          Statistic: 'Sum',
          Dimensions: [
            { Name: 'n1', Value: 'v1' },
            { Name: 'n2', Value: 'v2' },
          ],
          Tags: [
            { Key: 'k1', Value: 'v1' },
            { Key: 'k2', Value: 'v2' },
          ],
        },
        expectedRemovalThrows: TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
      },
      {
        name: 'percentile',
        bag: {
          AlarmName: 'a',
          ComparisonOperator: 'GreaterThanThreshold',
          EvaluationPeriods: 2,
          Threshold: 5,
          MetricName: 'm',
          Namespace: 'ns',
          Period: 60,
          ExtendedStatistic: 'p99',
          EvaluateLowSampleCountPercentile: 'ignore',
        },
      },
      {
        name: 'falsy values',
        bag: {
          AlarmName: 'a',
          ComparisonOperator: 'GreaterThanThreshold',
          EvaluationPeriods: 1,
          Threshold: 0,
          ActionsEnabled: false,
          AlarmDescription: '',
          MetricName: 'm',
          Namespace: 'ns',
          Period: 60,
          Statistic: 'Sum',
        },
        expectedSilent: {
          'create:AlarmDescription': DECLARED_DEFAULT,
          'update-add:AlarmDescription': DECLARED_DEFAULT,
        },
      },
      {
        name: 'anomaly band',
        bag: {
          AlarmName: 'a',
          ComparisonOperator: 'LessThanLowerOrGreaterThanUpperThreshold',
          EvaluationPeriods: 2,
          ThresholdMetricId: 'ad1',
          Metrics: [
            {
              Id: 'm1',
              MetricStat: {
                Metric: { MetricName: 'm', Namespace: 'ns', Dimensions: [{ Name: 'n', Value: 'v' }] },
                Period: 60,
                Stat: 'Average',
                Unit: 'Count',
              },
              AccountId: '111111111111',
              ReturnData: true,
            },
            {
              Id: 'ad1',
              Expression: 'ANOMALY_DETECTION_BAND(m1, 2)',
              Label: 'band',
              Period: 60,
              ReturnData: true,
            },
          ],
        },
        expectedRemovalThrows: Object.fromEntries(
          ['create', 'update-add', 'update-remove'].map((d) => [
            `${d}:Metrics.0.MetricStat.Metric`,
            METRIC_STAT_WITHOUT_METRIC,
          ])
        ),
      },
    ],
  },
];

/**
 * Registered SDK provider classes no case covers yet (#3723), here or in
 * `sdk-wire-cases-<n>.ts` (each run by its `sdk-wire-coverage-<n>.test.ts`,
 * listed in `CASE_LISTS` below). It only SHRINKS: a class leaves it in the PR
 * that adds its case, and a NEW provider class lands with a case, never a row
 * here. `MAX_UNCOVERED` is its exact size, lowered by hand with each removal.
 */
const NOT_YET_COVERED = new Set(['RDSProvider']);
const MAX_UNCOVERED = 1;

/**
 * Every case list, with the test file that runs it and the list's name there.
 * A list counts as covered only while that file exists beside this one, is a
 * `*.test.ts` the suite collects, and still hands the list to
 * `describeWireCases`.
 */
const CASE_LISTS: { cases: TypeCase[]; name: string; file: string }[] = [
  { cases: CASES, name: 'CASES', file: 'sdk-wire-coverage.test.ts' },
  { cases: CASES_2, name: 'CASES_2', file: 'sdk-wire-coverage-2.test.ts' },
  {
    cases: CASES_IAM_SECRETS,
    name: 'CASES_IAM_SECRETS',
    file: 'sdk-wire-coverage-iam-secrets.test.ts',
  },
  { cases: CASES_3, name: 'CASES_3', file: 'sdk-wire-coverage-3.test.ts' },
  { cases: CASES_4, name: 'CASES_4', file: 'sdk-wire-coverage-4.test.ts' },
  { cases: CASES_5, name: 'CASES_5', file: 'sdk-wire-coverage-5.test.ts' },
  { cases: CASES_6, name: 'CASES_6', file: 'sdk-wire-coverage-6.test.ts' },
  { cases: CASES_7, name: 'CASES_7', file: 'sdk-wire-coverage-7.test.ts' },
  { cases: LAMBDA_CASES, name: 'LAMBDA_CASES', file: 'sdk-wire-coverage-7.test.ts' },
  { cases: CASES_8, name: 'CASES_8', file: 'sdk-wire-coverage-8.test.ts' },
  { cases: ACM_CASES, name: 'ACM_CASES', file: 'sdk-wire-coverage-8.test.ts' },
  { cases: CASES_9, name: 'CASES_9', file: 'sdk-wire-coverage-9.test.ts' },
  { cases: CASES_10, name: 'CASES_10', file: 'sdk-wire-coverage-10.test.ts' },
  { cases: CASES_11, name: 'CASES_11', file: 'sdk-wire-coverage-11.test.ts' },
  { cases: CASES_12, name: 'CASES_12', file: 'sdk-wire-coverage-12.test.ts' },
  { cases: CASES_13, name: 'CASES_13', file: 'sdk-wire-coverage-13.test.ts' },
  { cases: CASES_14, name: 'CASES_14', file: 'sdk-wire-coverage-14.test.ts' },
  { cases: CASES_15, name: 'CASES_15', file: 'sdk-wire-coverage-15.test.ts' },
  { cases: CASES_16, name: 'CASES_16', file: 'sdk-wire-coverage-16.test.ts' },
  { cases: CASES_16_EC2, name: 'CASES_16_EC2', file: 'sdk-wire-coverage-16-ec2.test.ts' },
  { cases: CASES_17, name: 'CASES_17', file: 'sdk-wire-coverage-17.test.ts' },
  { cases: CASES_18, name: 'CASES_18', file: 'sdk-wire-coverage-18.test.ts' },
  {
    cases: CASES_18_GLOBAL_TABLE,
    name: 'CASES_18_GLOBAL_TABLE',
    file: 'sdk-wire-coverage-18-globaltable.test.ts',
  },
  {
    cases: CASES_CLOUDMAP,
    name: 'CASES_CLOUDMAP',
    file: 'sdk-wire-coverage-cloudmap.test.ts',
  },
  {
    cases: CASES_NO_PROPERTIES,
    name: 'CASES_NO_PROPERTIES',
    file: 'sdk-wire-coverage-no-properties.test.ts',
  },
];
const ALL_CASES: TypeCase[] = CASE_LISTS.flatMap((l) => l.cases);

describe('SDK wire coverage ledger', () => {
  it.each(CASE_LISTS)('$name is run by $file', ({ name, file }) => {
    expect(file).toMatch(/\.test\.ts$/);
    const url = new URL(`./${file}`, import.meta.url);
    expect(existsSync(url), file).toBe(true);
    // Anchored to a line start, so a commented-out call does not count.
    expect(readFileSync(url, 'utf8')).toMatch(new RegExp(`^\\s*describeWireCases\\(${name}\\);`, 'm'));
  });

  it('names every registered provider class exactly once: covered by a case, or not yet', async () => {
    // Every class `registerAllProviders` destructures comes from this module.
    const classes = Object.entries(
      await import('../../../src/provisioning/provider-classes.js')
    ).filter(([, value]) => typeof value === 'function');
    expect(classes.length).toBeGreaterThan(80);
    const covered = new Set(ALL_CASES.map((t) => t.provider().constructor.name));
    for (const [name] of classes) {
      expect(covered.has(name) !== NOT_YET_COVERED.has(name), name).toBe(true);
    }
    // A stale row (a renamed or deleted class) fails too.
    const names = new Set(classes.map(([name]) => name));
    for (const name of NOT_YET_COVERED) expect(names.has(name), name).toBe(true);
    // Exact, so a covered class cannot leave headroom for an uncased new one.
    expect(NOT_YET_COVERED.size).toBe(MAX_UNCOVERED);
  });

  it('covers every resource type a covered class handles', () => {
    const cased = new Set(ALL_CASES.map((t) => t.resourceType));
    for (const t of ALL_CASES) {
      for (const type of t.provider().handledProperties?.keys() ?? []) {
        expect(cased.has(type), `${t.provider().constructor.name}: ${type}`).toBe(true);
      }
    }
  });
});

describe('SDK wire coverage', () => {
  describeWireCases(CASES);
});

// A case's expectations are derived through its create-only set (a skipped
// probe expects nothing), so a widened set leaves every case green while its
// update probes go unrun. The precision is pinned here instead.
describe('the wire harness create-only paths', () => {
  it('keeps a nested create-only path nested', () => {
    expect(createOnlyOf('AWS::Budgets::Budget')).toEqual(
      new Set(['Budget.BudgetName', 'NotificationsWithSubscribers'])
    );
  });

  it.each([
    [['Budget', 'BudgetName'], true],
    [['Budget'], true],
    [['NotificationsWithSubscribers', 0, 'Notification', 'Threshold'], true],
    [['Budget', 'BudgetType'], false],
    [['Budget', 'BudgetLimit', 'Amount'], false],
    [['Budget', 'BudgetNameSuffix'], false],
    [['ResourceTags', 0, 'Key'], false],
  ] as const)('%j touches one: %s', (path, touches) => {
    const bag = { Budget: { BudgetName: 'b' }, NotificationsWithSubscribers: [{}] };
    expect(touchesCreateOnly(createOnlyOf('AWS::Budgets::Budget'), [...path], bag)).toBe(touches);
  });

  // The engine cannot walk a nested path through a list or a `*`, so it
  // replaces on any change under that top-level; the harness skips the same.
  // A list on ANOTHER branch does not stop the walk.
  it.each([
    [['Foo', 0, 'Other'], true],
    [['Foo', 1], true],
    [['Bar', 'Other'], true],
    [['Baz', 'Other'], false],
    [['Qux', 'List', 0], false],
    [['Qux', 'List'], false],
    [['Qux', 'Inner', 'Name'], true],
    // An absent container walks (to `undefined`), as a Pipe's unused source
    // parameters do.
    [['Pipe', 'Other'], false],
    // Removing the parent of an ABSENT create-only member leaves it absent.
    [['Pipe'], false],
  ] as const)('through a list or a wildcard, %j touches one: %s', (path, touches) => {
    const createOnly = new Set([
      'Foo.Name',
      'Bar.*.Name',
      'Baz.Name',
      'Qux.Inner.Name',
      'Pipe.Source.Name',
    ]);
    const bag = {
      Foo: [{ Name: 'n' }, { Other: 'o' }],
      Bar: { Other: 'o' },
      Baz: { Name: 'n', Other: 'o' },
      Qux: { Inner: { Name: 'n' }, List: ['x'] },
      Pipe: { Other: 'o' },
    };
    expect(touchesCreateOnly(createOnly, [...path], bag)).toBe(touches);
  });
});
