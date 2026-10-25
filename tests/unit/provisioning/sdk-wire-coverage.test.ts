import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vite-plus/test';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { STSClient } from '@aws-sdk/client-sts';
import { SSMClient } from '@aws-sdk/client-ssm';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import {
  ACCOUNT,
  armFor,
  paths,
  probe,
  record,
  setOutputOverrides,
  without,
  type Bag,
  type Path,
} from './sdk-wire-harness.js';

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
import type { ResourceProvider, UpdateContext } from '../../../src/types/resource.js';

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

/** Why a removal throws, and a needle its message must match. */
interface Throw {
  why: string;
  says: RegExp;
}

interface BagCase {
  name: string;
  bag: Bag;
  variants?: Record<string, unknown>;
  /** Overrides the type's `arm` for this bag, e.g. a live state no bag spells. */
  arm?: (physicalId: string, bag: Bag) => void;
  /** Probe label -> why it is silent. Exact: a fixed gap must leave the list. */
  expectedSilent?: Record<string, string>;
  /**
   * Probe label -> why removing that path throws. Exact, like `expectedSilent`,
   * and each throw's message must match its needle: a throw for another reason
   * is not the refusal the entry names.
   */
  expectedRemovalThrows?: Record<string, Throw>;
}

interface TypeCase {
  resourceType: string;
  provider: () => ResourceProvider;
  physicalId: string;
  createOnly: ReadonlySet<string>;
  /** Arms the fake reads for a bag (default: none), e.g. what a list answers. */
  arm?: (physicalId: string, bag: Bag) => void;
  /** What every `update()` receives as its context (the record's attributes). */
  updateContext?: UpdateContext;
  /**
   * Top-levels whose `update()` re-sends the WHOLE value from `next` and never
   * reads `prev`: every `update-remove` probe at or under such a key is silent
   * by design (`next` alone delivers it, as its `update-add` probe observes).
   */
  wholeFromNext?: { keys: (key: string) => boolean; reason: string };
  /** `handledProperties` entries no bag carries, each with the reason. */
  exempt: Record<string, string>;
  /**
   * `<Top>.<path>` -> why no bag carries that nested path (array indices
   * dropped) of a carried top-level the schema fixture's `nestedPropertyPaths`
   * lists.
   */
  nestedExempt?: Record<string, string>;
  /**
   * Removal probes that only see THAT the wire changed, not WHICH member it
   * names: removing one element of a two-element list (or one key of a map)
   * from `bags[0]` must send `command` exactly once, naming `names` and not
   * `notNames`. With `where`, only `command` requests whose body contains it
   * count (a clear among the same command's writes).
   */
  targets: { path: Path; command: string; names: string; notNames: string; where?: string }[];
  bags: BagCase[];
}

const ROLE = `arn:aws:iam::${ACCOUNT}:role/r`;
const QUEUE_ARN = (name: string) => `arn:aws:sqs:us-east-1:${ACCOUNT}:${name}`;

const TAGS_REFUSED: Throw = {
  why: 'a Tags entry without its Key or Value is refused before any call (go-to-k/cdkd#3994)',
  says: /is not a list of tags/,
};
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

interface SchemaFixture {
  createOnlyPropertyPaths: string[][];
  nestedPropertyPaths?: Record<string, string[]>;
}

/** A type's committed schema fixture. */
function fixtureOf(resourceType: string): SchemaFixture {
  const file = new URL(
    `../../fixtures/cfn-schemas/${resourceType.replaceAll('::', '-')}.json`,
    import.meta.url
  );
  return JSON.parse(readFileSync(file, 'utf8')) as SchemaFixture;
}

/** A type's create-only top-levels, from its committed schema fixture. */
function createOnlyOf(resourceType: string): ReadonlySet<string> {
  return new Set(fixtureOf(resourceType).createOnlyPropertyPaths.map((p) => p[0]!));
}

/** Top-level -> every dotted nested path beneath it (no array indices), from the fixture. */
function nestedPathsOf(resourceType: string): Record<string, string[]> {
  return fixtureOf(resourceType).nestedPropertyPaths ?? {};
}

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
// Not a gap: the value IS what the service holds when the member is unset (no
// filter, raw delivery off, type String, no pattern / description / key), so
// sending it and omitting it leave the same resource.
const DECLARED_DEFAULT = 'the declared value is what an unset member reads as';
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

const TAG_THROWS = (directions: string[], count: number): Record<string, Throw> =>
  Object.fromEntries(
    directions.flatMap((d) =>
      Array.from({ length: count }, (_, i) => [
        [`${d}:Tags.${i}.Key`, TAGS_REFUSED],
        [`${d}:Tags.${i}.Value`, TAGS_REFUSED],
      ]).flat()
    )
  );

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
 * Registered SDK provider classes no case above covers yet (#3723). It only
 * SHRINKS: a class leaves it in the PR that adds its case, and a NEW provider
 * class lands with a case, never a row here. `MAX_UNCOVERED` is its exact
 * size, lowered by hand with each removal.
 */
const NOT_YET_COVERED = new Set([
  'ACMCertificateProvider',
  'ASGProvider',
  'AgentCoreBrowserProvider',
  'AgentCoreCodeInterpreterProvider',
  'AgentCoreEvaluatorProvider',
  'AgentCoreRuntimeProvider',
  'ApiGatewayProvider',
  'ApiGatewayV2Provider',
  'AppSyncProvider',
  'BudgetsBudgetProvider',
  'CloudFrontDistributionProvider',
  'CloudFrontOACProvider',
  'CloudFrontOAIProvider',
  'CloudTrailProvider',
  'CloudWatchAnomalyDetectorProvider',
  'CodeBuildProvider',
  'CodeCommitRepositoryProvider',
  'CognitoUserPoolProvider',
  'DLMLifecyclePolicyProvider',
  'DocDBProvider',
  'DocDBSubnetGroupProvider',
  'DynamoDBGlobalTableProvider',
  'DynamoDBTableProvider',
  'EC2Provider',
  'ECRProvider',
  'ECSProvider',
  'EFSProvider',
  'ELBv2Provider',
  'EMRClusterProvider',
  'EMRInstanceFleetConfigProvider',
  'EMRInstanceGroupConfigProvider',
  'ElastiCacheProvider',
  'EventBridgeRuleProvider',
  'FSxFileSystemProvider',
  'FirehoseProvider',
  'GlueConnectionProvider',
  'GlueCrawlerProvider',
  'GlueJobProvider',
  'GlueProvider',
  'GlueSecurityConfigurationProvider',
  'GlueTriggerProvider',
  'GlueWorkflowProvider',
  'IAMAccessKeyProvider',
  'IAMInstanceProfileProvider',
  'IAMManagedPolicyProvider',
  'IAMPolicyProvider',
  'IAMRoleProvider',
  'IAMUserGroupProvider',
  'KMSProvider',
  'KinesisStreamConsumerProvider',
  'KinesisStreamProvider',
  'LambdaEventInvokeConfigProvider',
  'LambdaEventSourceMappingProvider',
  'LambdaFunctionProvider',
  'LambdaLayerVersionProvider',
  'LambdaMicrovmImageProvider',
  'LambdaNetworkConnectorProvider',
  'LambdaPermissionProvider',
  'LambdaUrlProvider',
  'LambdaWebFunctionEndpointProvider',
  'LambdaWebFunctionRevisionProvider',
  'LogsLogGroupProvider',
  'NeptuneProvider',
  'NestedStackProvider',
  'PipesPipeProvider',
  'RDSDBProxyEndpointProvider',
  'RDSDBProxyProvider',
  'RDSDBProxyTargetGroupProvider',
  'RDSProvider',
  'Route53Provider',
  'S3BucketPolicyProvider',
  'S3BucketProvider',
  'S3DirectoryBucketProvider',
  'S3TablesProvider',
  'S3VectorsProvider',
  'SchedulerScheduleProvider',
  'SecretsManagerSecretProvider',
  'ServiceDiscoveryProvider',
  'StepFunctionsProvider',
  'WAFv2WebACLProvider',
  'WaitConditionHandleProvider',
]);
const MAX_UNCOVERED = 81;

describe('SDK wire coverage ledger', () => {
  it('names every registered provider class exactly once: covered by a case, or not yet', async () => {
    // Every class `registerAllProviders` destructures comes from this module.
    const classes = Object.entries(
      await import('../../../src/provisioning/provider-classes.js')
    ).filter(([, value]) => typeof value === 'function');
    expect(classes.length).toBeGreaterThan(80);
    const covered = new Set(CASES.map((t) => t.provider().constructor.name));
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
    const cased = new Set(CASES.map((t) => t.resourceType));
    for (const t of CASES) {
      for (const type of t.provider().handledProperties?.keys() ?? []) {
        expect(cased.has(type), `${t.provider().constructor.name}: ${type}`).toBe(true);
      }
    }
  });
});

describe('SDK wire coverage', () => {
  describe.each(CASES)('$resourceType', (t) => {
    it('its bags carry every handledProperties entry not exempted', () => {
      const handled = [...(t.provider().handledProperties?.get(t.resourceType) ?? [])].sort();
      expect(handled.length).toBeGreaterThan(0);
      const carried = new Set(t.bags.flatMap((b) => Object.keys(b.bag)));
      for (const key of carried) expect(handled).toContain(key);
      for (const key of Object.keys(t.exempt)) expect(carried.has(key)).toBe(false);
      expect([...carried, ...Object.keys(t.exempt)].sort()).toEqual(handled);
    });

    it('its bags carry every nested path the schema lists under a carried top-level', () => {
      const nested = nestedPathsOf(t.resourceType);
      const exempt = t.nestedExempt ?? {};
      const missing: string[] = [];
      for (const [top, schemaPaths] of Object.entries(nested)) {
        const carriers = t.bags.filter((b) => top in b.bag).map((b) => b.bag[top]);
        if (carriers.length === 0) continue;
        // Path-scoped: a member counts only at the depth the schema puts it.
        const seen = new Set(
          carriers.flatMap((v) =>
            paths(v).map((p) => p.filter((seg) => typeof seg === 'string').join('.'))
          )
        );
        for (const path of schemaPaths) {
          const label = `${top}.${path}`;
          if (label in exempt) {
            // A stale exemption: a bag now carries it.
            expect(seen.has(path), label).toBe(false);
          } else if (!seen.has(path)) {
            missing.push(label);
          }
        }
      }
      expect(missing).toEqual([]);
      // An exemption naming no schema path is stale too.
      for (const label of Object.keys(exempt)) {
        const [top, ...rest] = label.split('.');
        expect(nested[top!] ?? [], label).toContain(rest.join('.'));
      }
    });

    it.each(t.bags)('delivers every path of the $name bag', async (b) => {
      const { silent, removalThrows, messages } = await probe({
        ...t,
        bag: b.bag,
        variants: b.variants,
        arm: b.arm ?? t.arm,
      });
      const byDesign = t.wholeFromNext;
      const wholeFromNext = byDesign
        ? paths(b.bag)
            .filter((p) => byDesign.keys(String(p[0])) && !t.createOnly.has(String(p[0])))
            .map((p) => `update-remove:${p.join('.')}`)
            // A removal that throws is a removal throw, not a silent probe.
            .filter((label) => !(label in (b.expectedRemovalThrows ?? {})))
        : [];
      const expectedSilent = [...new Set([...Object.keys(b.expectedSilent ?? {}), ...wholeFromNext])];
      // One assertion, so a failure shows both lists and each throw's message.
      expect(
        { silent: silent.sort(), removalThrows: removalThrows.sort() },
        JSON.stringify(messages, null, 2)
      ).toEqual({
        silent: expectedSilent.sort(),
        removalThrows: Object.keys(b.expectedRemovalThrows ?? {}).sort(),
      });
      for (const [label, expected] of Object.entries(b.expectedRemovalThrows ?? {})) {
        expect(messages[label], `${label}: ${expected.why}`).toMatch(expected.says);
      }
    });

    it.each(t.targets)('removing $path sends $command naming only $names', async (target) => {
      const full = t.bags[0]!.bag;
      armFor(t, full);
      const outcome = await record(() =>
        t
          .provider()
          .update(
            'L',
            t.physicalId,
            t.resourceType,
            without(full, target.path),
            structuredClone(full),
            t.updateContext
          )
      );
      expect(outcome).toMatchObject({ threw: false });
      const bodies = (outcome as { wire: string }).wire
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
        .filter((entry) => entry[0] === target.command)
        .map((entry) => entry[entry.length - 1]!)
        .filter((body) => target.where === undefined || body.includes(target.where));
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain(target.names);
      expect(bodies[0]).not.toContain(target.notNames);
    });
  });
});
