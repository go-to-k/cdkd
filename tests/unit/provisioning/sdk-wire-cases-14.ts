import { describe, expect, it } from 'vite-plus/test';
import {
  ACCOUNT,
  createOnlyOf,
  paths,
  record,
  setOutputOverrides,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * The fourteenth batch of wire cases (#3723): `AWS::Lambda::EventSourceMapping`,
 * the one type `LambdaEventSourceMappingProvider` handles, run by
 * `sdk-wire-coverage-14.test.ts`.
 */

/**
 * A copy sharing no object with any other bag: the harness's `without` is a
 * `structuredClone`, which KEEPS shared references, so a block reused in two
 * places would lose a path in both at once.
 */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const SRC = 'lambda-eventsource-provider.ts';
const UUID = '11111111-2222-3333-4444-555555555555';
const SQS_ARN = `arn:aws:sqs:us-east-1:${ACCOUNT}:queue`;
const DLQ_ARN = `arn:aws:sqs:us-east-1:${ACCOUNT}:dlq`;
const KINESIS_ARN = `arn:aws:kinesis:us-east-1:${ACCOUNT}:stream/s`;
const DDB_STREAM_ARN = `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/t/stream/2026-01-01T00:00:00.000`;
const MSK_ARN = `arn:aws:kafka:us-east-1:${ACCOUNT}:cluster/c/abcd-1234`;
const MQ_ARN = `arn:aws:mq:us-east-1:${ACCOUNT}:broker:b:b-1234`;
const DOCDB_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:docdb`;
const SECRET = (n: number): string =>
  `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s${n}-AbCdEf`;
const KMS_KEY = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k`;
const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

const SCHEMA_REGISTRY = {
  SchemaRegistryURI: 'https://registry.example.com',
  EventRecordFormat: 'JSON',
  AccessConfigs: [
    { Type: 'BASIC_AUTH', URI: SECRET(1) },
    { Type: 'SERVER_ROOT_CA_CERTIFICATE', URI: SECRET(2) },
  ],
  SchemaValidationConfigs: [{ Attribute: 'KEY' }, { Attribute: 'VALUE' }],
};

/**
 * Members whose change `update()` refuses before any call although the schema
 * does not mark them create-only (`ResourceUpdateNotSupportedError`, issue
 * #5356): `UpdateEventSourceMapping` takes neither, and CloudFormation refuses
 * the change too ("Parameter 'Topics' can not be updated", measured). Marked
 * create-only here so the update probes skip them, as the engine's
 * `--replace` would; `describeEventSourceMappingExtras` pins the refusal.
 */
const UPDATE_REFUSED = ['Queues', 'Topics'] as const;

const SQS_BAG: Bag = {
  FunctionName: 'fn',
  EventSourceArn: SQS_ARN,
  BatchSize: 5,
  Enabled: false,
  MaximumBatchingWindowInSeconds: 3,
  FilterCriteria: { Filters: [{ Pattern: '{"a":["1"]}' }, { Pattern: '{"b":["2"]}' }] },
  ScalingConfig: { MaximumConcurrency: 5 },
  FunctionResponseTypes: ['ReportBatchItemFailures'],
  MetricsConfig: { Metrics: ['EventCount'] },
  KmsKeyArn: KMS_KEY,
  ProvisionedPollerConfig: { MinimumPollers: 2, MaximumPollers: 5, PollerGroupName: 'group' },
  Tags: fresh(TAGS),
};

const KINESIS_BAG: Bag = {
  FunctionName: 'fn',
  EventSourceArn: KINESIS_ARN,
  StartingPosition: 'AT_TIMESTAMP',
  StartingPositionTimestamp: 1700000000,
  BatchSize: 50,
  MaximumRetryAttempts: 3,
  BisectBatchOnFunctionError: true,
  MaximumRecordAgeInSeconds: 120,
  ParallelizationFactor: 2,
  TumblingWindowInSeconds: 30,
  DestinationConfig: { OnFailure: { Destination: DLQ_ARN } },
  FunctionResponseTypes: ['ReportBatchItemFailures'],
};

const DYNAMODB_BAG: Bag = {
  FunctionName: 'fn',
  EventSourceArn: DDB_STREAM_ARN,
  StartingPosition: 'LATEST',
  BatchSize: 50,
  BisectBatchOnFunctionError: true,
};

const SELF_MANAGED_KAFKA_BAG: Bag = {
  FunctionName: 'fn',
  SelfManagedEventSource: { Endpoints: { KafkaBootstrapServers: ['b1:9092', 'b2:9092'] } },
  Topics: ['topic'],
  StartingPosition: 'TRIM_HORIZON',
  BatchSize: 50,
  MaximumBatchingWindowInSeconds: 3,
  MaximumRetryAttempts: 3,
  BisectBatchOnFunctionError: true,
  SelfManagedKafkaEventSourceConfig: {
    ConsumerGroupId: 'group',
    SchemaRegistryConfig: fresh(SCHEMA_REGISTRY),
  },
  SourceAccessConfigurations: [
    { Type: 'BASIC_AUTH', URI: SECRET(3) },
    { Type: 'VPC_SUBNET', URI: 'subnet:subnet-1' },
  ],
  LoggingConfig: { SystemLogLevel: 'INFO' },
  ProvisionedPollerConfig: { MinimumPollers: 1, MaximumPollers: 3 },
};

/** Bisect on a Kafka mapping that leaves provisioned mode (#1160, the kept-with-warning arm). */
const SELF_MANAGED_KAFKA_ON_DEMAND_BAG: Bag = {
  FunctionName: 'fn',
  SelfManagedEventSource: { Endpoints: { KafkaBootstrapServers: ['b1:9092'] } },
  Topics: ['topic'],
  StartingPosition: 'LATEST',
  BisectBatchOnFunctionError: true,
};

const MSK_BAG: Bag = {
  FunctionName: 'fn',
  EventSourceArn: MSK_ARN,
  Topics: ['topic'],
  StartingPosition: 'LATEST',
  AmazonManagedKafkaEventSourceConfig: {
    ConsumerGroupId: 'group',
    SchemaRegistryConfig: fresh(SCHEMA_REGISTRY),
  },
};

const MQ_BAG: Bag = {
  FunctionName: 'fn',
  EventSourceArn: MQ_ARN,
  Queues: ['queue'],
  BatchSize: 5,
  SourceAccessConfigurations: [{ Type: 'BASIC_AUTH', URI: SECRET(4) }],
};

const DOCUMENTDB_BAG: Bag = {
  FunctionName: 'fn',
  EventSourceArn: DOCDB_ARN,
  StartingPosition: 'LATEST',
  BatchSize: 50,
  DocumentDBEventSourceConfig: {
    DatabaseName: 'db',
    CollectionName: 'coll',
    FullDocument: 'UpdateLookup',
  },
  SourceAccessConfigurations: [{ Type: 'BASIC_AUTH', URI: SECRET(5) }],
};

/**
 * `update()` builds each of these blocks from the desired bag alone and sends
 * it whole (${SRC}:1104-1145, 1180-1193); the previous side is read only for
 * a removal of the WHOLE block (the reset arms, ${SRC}:1210-1234). So a
 * member dropped from inside a still-declared block reaches the wire through
 * `next` (its `update-add` probe observes it), and varying `prev` alone sends
 * the same request.
 */
const wholeFromNext = (top: string): string =>
  `${top} is sent whole from the desired bag (${SRC}:1104-1145, 1180-1193), so the removal reaches the wire through next, which update-add observes; prev is read only when the whole block is removed (${SRC}:1210-1234)`;

/** `update-remove:<path>` -> `wholeFromNext(top)` for every path under `top` in `bag`. */
const underWhole = (bag: Bag, top: string): Record<string, string> =>
  Object.fromEntries(paths(bag[top], [top]).map((p) => [`update-remove:${p.join('.')}`, wholeFromNext(top)]));

const FUNCTION_NAME_REQUIRED =
  `FunctionName is required by the CloudFormation schema, so no template drops it; update() names the function from the desired bag only (${SRC}:1100-1103)`;

const NO_FUNCTION_NAME: Record<string, Throw> = {
  'create:FunctionName': {
    why: `create() refuses a mapping with no FunctionName before any call (${SRC}:716-723)`,
    says: /FunctionName is required for event source mapping/,
  },
};

/** A Value-less tag is accepted (DBPROXY_TAG_OPTIONS); a Key-less one is refused (go-to-k/cdkd#3994). */
const TAG_KEY_REFUSED: Throw = {
  why: `a Tags entry without its Key is refused before any call (${SRC}:706-714, 1001-1009, go-to-k/cdkd#3994)`,
  says: /is not a list of tags with a non-empty string Key/,
};
const TAG_KEY_THROWS: Record<string, Throw> = Object.fromEntries(
  ['create', 'update-add', 'update-remove'].flatMap((d) =>
    [0, 1].map((i) => [`${d}:Tags.${i}.Key`, TAG_KEY_REFUSED])
  )
);

const CONSUMER_GROUP_KEPT =
  `ConsumerGroupId is sent on update only when declared and changed (${SRC}:356-358): UpdateEventSourceMapping refuses the member even unchanged (measured live, ${SRC}:327-332), so no request can carry its removal; CFn unmeasured for the removal`;

const DOCUMENTDB_UNCHANGEABLE = (member: string): string =>
  `UpdateEventSourceMapping refuses DocumentDBEventSourceConfig.${member} even unchanged, and CloudFormation sends FullDocument alone, leaving it as it is (CloudFormation A/B, #1160, ${SRC}:367-389); update() sends the same and warns (${SRC}:1146-1156)`;

const ESM_CASE: TypeCase = {
  resourceType: 'AWS::Lambda::EventSourceMapping',
  provider: () => new LambdaEventSourceMappingProvider(),
  physicalId: UUID,
  createOnly: new Set([...createOnlyOf('AWS::Lambda::EventSourceMapping'), ...UPDATE_REFUSED]),
  exempt: {},
  nestedExempt: {
    'SelfManagedKafkaEventSourceConfig.ConsumptionMode': `refused before any call: no @aws-sdk/client-lambda release models the member, so it could not reach the wire (${SRC}:276-318, issue #3848; pinned by lambda-eventsource-provider-consumption-mode.test.ts)`,
  },
  targets: [
    {
      path: ['Tags', 0],
      command: 'UntagResourceCommand',
      names: '"k1"',
      notNames: '"k2"',
    },
    {
      path: ['Tags', 1],
      command: 'UntagResourceCommand',
      names: '"k2"',
      notNames: '"k1"',
    },
  ],
  bags: [
    {
      name: 'SQS',
      bag: fresh(SQS_BAG),
      expectedSilent: {
        'update-remove:FunctionName': FUNCTION_NAME_REQUIRED,
        ...underWhole(SQS_BAG, 'FilterCriteria'),
        ...underWhole(SQS_BAG, 'FunctionResponseTypes'),
        ...underWhole(SQS_BAG, 'MetricsConfig'),
        ...underWhole(SQS_BAG, 'ScalingConfig'),
        ...underWhole(SQS_BAG, 'ProvisionedPollerConfig'),
        'update-remove:ProvisionedPollerConfig': `kept on an SQS mapping: CloudFormation sends nothing for the removal and the poller config stays (CloudFormation A/B, #1160, ${SRC}:1282-1283, 1354-1357)`,
      },
      expectedRemovalThrows: { ...NO_FUNCTION_NAME, ...TAG_KEY_THROWS },
    },
    {
      name: 'Kinesis',
      bag: fresh(KINESIS_BAG),
      expectedSilent: {
        'update-remove:FunctionName': FUNCTION_NAME_REQUIRED,
        ...underWhole(KINESIS_BAG, 'DestinationConfig'),
        ...underWhole(KINESIS_BAG, 'FunctionResponseTypes'),
      },
      expectedRemovalThrows: NO_FUNCTION_NAME,
    },
    {
      name: 'DynamoDB stream',
      bag: fresh(DYNAMODB_BAG),
      expectedSilent: { 'update-remove:FunctionName': FUNCTION_NAME_REQUIRED },
      expectedRemovalThrows: NO_FUNCTION_NAME,
    },
    {
      name: 'self-managed Kafka, provisioned mode',
      bag: fresh(SELF_MANAGED_KAFKA_BAG),
      expectedSilent: {
        'update-remove:FunctionName': FUNCTION_NAME_REQUIRED,
        ...underWhole(SELF_MANAGED_KAFKA_BAG, 'LoggingConfig'),
        ...underWhole(SELF_MANAGED_KAFKA_BAG, 'ProvisionedPollerConfig'),
        ...underWhole(SELF_MANAGED_KAFKA_BAG, 'SourceAccessConfigurations'),
        'update-remove:MaximumBatchingWindowInSeconds': `kept on a Kafka mapping: the 500 ms default cannot be restored through UpdateEventSourceMapping, and CloudFormation keeps the value (CloudFormation A/B, #1160, ${SRC}:1257-1269)`,
        'update-remove:MaximumRetryAttempts': `kept on a Kafka mapping with a warning naming it (${SRC}:1337-1346, 1359-1368): the stream-numeric resets are gated to Kinesis / DynamoDB (${SRC}:1250-1255); CFn unmeasured`,
        'update-remove:SelfManagedKafkaEventSourceConfig.ConsumerGroupId': CONSUMER_GROUP_KEPT,
      },
      expectedRemovalThrows: NO_FUNCTION_NAME,
    },
    {
      name: 'self-managed Kafka, on-demand mode',
      bag: fresh(SELF_MANAGED_KAFKA_ON_DEMAND_BAG),
      expectedSilent: {
        'update-remove:FunctionName': FUNCTION_NAME_REQUIRED,
        'update-remove:BisectBatchOnFunctionError': `kept with a warning while the Kafka mapping declares no ProvisionedPollerConfig: Kafka takes it in provisioned mode only, so a reset could make AWS refuse the whole update (${SRC}:1301-1315); CFn unmeasured`,
      },
      expectedRemovalThrows: NO_FUNCTION_NAME,
    },
    {
      name: 'MSK',
      bag: fresh(MSK_BAG),
      expectedSilent: {
        'update-remove:FunctionName': FUNCTION_NAME_REQUIRED,
        'update-remove:AmazonManagedKafkaEventSourceConfig.ConsumerGroupId': CONSUMER_GROUP_KEPT,
      },
      expectedRemovalThrows: NO_FUNCTION_NAME,
    },
    {
      name: 'Amazon MQ',
      bag: fresh(MQ_BAG),
      expectedSilent: {
        'update-remove:FunctionName': FUNCTION_NAME_REQUIRED,
        ...underWhole(MQ_BAG, 'SourceAccessConfigurations'),
      },
      expectedRemovalThrows: NO_FUNCTION_NAME,
    },
    {
      name: 'DocumentDB',
      bag: fresh(DOCUMENTDB_BAG),
      expectedSilent: {
        'update-remove:FunctionName': FUNCTION_NAME_REQUIRED,
        ...underWhole(DOCUMENTDB_BAG, 'SourceAccessConfigurations'),
        'update-add:DocumentDBEventSourceConfig.DatabaseName': DOCUMENTDB_UNCHANGEABLE('DatabaseName'),
        'update-remove:DocumentDBEventSourceConfig.DatabaseName':
          DOCUMENTDB_UNCHANGEABLE('DatabaseName'),
        'update-vary:DocumentDBEventSourceConfig.DatabaseName': DOCUMENTDB_UNCHANGEABLE('DatabaseName'),
        'update-add:DocumentDBEventSourceConfig.CollectionName':
          DOCUMENTDB_UNCHANGEABLE('CollectionName'),
        'update-remove:DocumentDBEventSourceConfig.CollectionName':
          DOCUMENTDB_UNCHANGEABLE('CollectionName'),
        'update-vary:DocumentDBEventSourceConfig.CollectionName':
          DOCUMENTDB_UNCHANGEABLE('CollectionName'),
        'update-remove:DocumentDBEventSourceConfig.FullDocument': `kept with a warning: a block that drops FullDocument sends none, and CloudFormation keeps the live value (CloudFormation A/B, #1160, ${SRC}:378-381, 1157-1160)`,
        'update-remove:DocumentDBEventSourceConfig': `kept with a warning: CloudFormation sends no DocumentDBEventSourceConfig when the block is removed, and the live block stays (CloudFormation A/B, #1160, ${SRC}:378-381, 1370-1377)`,
      },
      expectedRemovalThrows: NO_FUNCTION_NAME,
    },
  ],
};

export const CASES_14: TypeCase[] = [ESM_CASE];

/** Direct-call checks the bag probes cannot make. */
export function describeEventSourceMappingExtras(): void {
  describe('AWS::Lambda::EventSourceMapping members update() refuses to change', () => {
    const bagWith = (member: string): Bag => ESM_CASE.bags.map((b) => b.bag).find((b) => member in b)!;
    const refusal = async (member: string, next: Bag, prev: Bag): Promise<void> => {
      let thrown: unknown;
      setOutputOverrides(undefined);
      const outcome = await record(async () => {
        try {
          await new LambdaEventSourceMappingProvider().update(
            'L',
            UUID,
            'AWS::Lambda::EventSourceMapping',
            structuredClone(next),
            structuredClone(prev)
          );
        } catch (error) {
          thrown = error;
        }
      });
      expect(outcome).toEqual({ threw: false, wire: '' });
      expect(thrown).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((thrown as Error).message).toContain(
        `${member} cannot be changed on an existing event source mapping`
      );
    };
    it.each(UPDATE_REFUSED)('refuses a changed %s and sends nothing', async (member) => {
      const bag = bagWith(member);
      await refusal(member, { ...bag, [member]: ['other'] }, bag);
    });
    it.each(UPDATE_REFUSED)('refuses a removed %s and sends nothing', async (member) => {
      const bag = bagWith(member);
      const { [member]: _omit, ...next } = bag;
      await refusal(member, next, bag);
    });
    it.each(UPDATE_REFUSED)('refuses a newly declared %s and sends nothing', async (member) => {
      const bag = bagWith(member);
      const { [member]: _omit, ...prev } = bag;
      await refusal(member, bag, prev);
    });
  });
}
