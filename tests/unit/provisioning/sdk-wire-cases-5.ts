import {
  ACCOUNT,
  DECLARED_DEFAULT,
  TAG_THROWS,
  createOnlyOf,
  paths,
  setOutputOverrides,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { CloudWatchAnomalyDetectorProvider } from '../../../src/provisioning/providers/cloudwatch-anomaly-detector-provider.js';
import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';
import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';
import { LambdaNetworkConnectorProvider } from '../../../src/provisioning/providers/lambda-network-connector-provider.js';
import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';
import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';

/**
 * The fifth batch of wire cases (#3723): KMS, Step Functions, S3 Vectors,
 * Lambda network connector, CloudWatch anomaly detector and EventBridge rule.
 * Run by `sdk-wire-coverage-5.test.ts`, which mocks the clients
 * these providers reach; the ledger in `sdk-wire-coverage.test.ts` counts them
 * as covered.
 */

const KEY_ID = '1234abcd-12ab-34cd-56ef-1234567890ab';
const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

/** `<Property> is required for <type> L`: refused when absent, before any call. */
const REQUIRED = (property: string): Throw => ({
  why: `${property} is refused when absent, before any call`,
  says: new RegExp(`${property} is required for`),
});

/**
 * The live key is the previous bag: `DescribeKey` answers its spec, usage,
 * region scope and origin (each defaulted as KMS reports an unset one), which
 * the immutable-property refusal compares the desired values against.
 */
function armKey(physicalId: string, bag: Bag): void {
  setOutputOverrides({
    DescribeKeyCommand: () => ({
      KeyMetadata: {
        KeyId: physicalId,
        Arn: `arn:aws:kms:us-east-1:${ACCOUNT}:key/${physicalId}`,
        AWSAccountId: ACCOUNT,
        KeySpec: bag['KeySpec'] ?? 'SYMMETRIC_DEFAULT',
        KeyUsage: bag['KeyUsage'] ?? 'ENCRYPT_DECRYPT',
        MultiRegion: bag['MultiRegion'] === true,
        Origin: bag['Origin'] ?? 'AWS_KMS',
        Enabled: bag['Enabled'] !== false,
        KeyState: bag['Enabled'] === false ? 'Disabled' : 'Enabled',
      },
    }),
  });
}

const KEY_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` },
      Action: 'kms:*',
      Resource: '*',
    },
  ],
};

/** A change to a property KMS fixes when the key is created (#5299). */
const IMMUTABLE_KEY = (property: string): Throw => ({
  why: `${property} is fixed when the key is created; a change is refused (#5299)`,
  says: new RegExp(`cannot be updated in place: ${property} changed, and KMS fixes it`),
});

const FIXED_AT_CREATION =
  'fixed when the key is created: the varied update is a change both sides refuse (#5299)';

// Not a gap: the bypass is a flag on PutKeyPolicy, which an update sends only
// when the policy changes (`sdk-wire-coverage-5.test.ts` pins the flag on that
// call). KMS keeps no bypass setting, so the flag alone has nothing to change.
const BYPASS_ONLY_ON_A_POLICY_PUT = Object.fromEntries(
  ['update-add', 'update-remove', 'update-vary'].map((d) => [
    `${d}:BypassPolicyLockoutSafetyCheck`,
    'a PutKeyPolicy flag, sent only with a policy change; KMS holds no bypass setting',
  ])
);

const SM_ARN = `arn:aws:states:us-east-1:${ACCOUNT}:stateMachine:sm`;
const SM_COMMON = {
  StateMachineName: 'sm',
  RoleArn: `arn:aws:iam::${ACCOUNT}:role/sfn`,
  StateMachineType: 'STANDARD',
};
/** A body naming its state through a `${name}` placeholder. */
const SM_BODY = '{"StartAt":"${s}","States":{"${s}":{"Type":"Pass","End":true}}}';

/**
 * The S3 object a `DefinitionS3Location` names: the placeholder body, its
 * `Comment` naming the bucket, key and version read, so the location itself
 * reaches the wire through the definition sent.
 */
function armDefinitionObject(): void {
  setOutputOverrides({
    GetObjectCommand: (input) => ({
      Body: {
        transformToString: async () =>
          SM_BODY.replace(
            '{',
            `{"Comment":"${String(input['Bucket'])}/${String(input['Key'])}@${String(input['VersionId'])}",`
          ),
      },
    }),
  });
}

// Not a gap: UpdateStateMachine sends the definition, role and each config
// block whole from `next`, so a member removed from `prev` alone sends the
// same request (its update-add probe observes delivery). A removed block
// itself is reset from `prev`, which those probes observe.
const SM_WHOLE_FROM_NEXT =
  'UpdateStateMachine sends this whole from next; prev is read only for a removed block';
const smWholeFromNext = (labels: string[]): Record<string, string> =>
  Object.fromEntries(labels.map((l) => [`update-remove:${l}`, SM_WHOLE_FROM_NEXT]));
const SM_DEFINITION_FROM_NEXT = ['RoleArn', 'DefinitionSubstitutions', 'DefinitionSubstitutions.s'];
const SM_ROLE_REQUIRED = { 'create:RoleArn': REQUIRED('RoleArn') };

const CONNECTOR_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:network-connector:nc`;

/** The connector reads back settled, which create() and a changed update() poll for. */
function armActiveConnector(physicalId: string): void {
  setOutputOverrides({
    CreateNetworkConnectorCommand: () => ({ Arn: CONNECTOR_ARN }),
    GetNetworkConnectorCommand: () => ({
      Arn: physicalId,
      State: 'ACTIVE',
      LastUpdateStatus: 'Successful',
    }),
  });
}

const VPC_EGRESS_REQUIRED: Throw = {
  why: 'the VPC egress block is the whole connector; a missing one is refused before any call',
  says: /Configuration\.VpcEgressConfiguration must be an object/,
};

/** A Tags entry without its Key: refused before any call. */
const TAG_KEY_THROWS = (directions: string[], count: number): Record<string, Throw> =>
  Object.fromEntries(
    Object.entries(TAG_THROWS(directions, count)).filter(([label]) => label.endsWith('.Key'))
  );

/** A detector naming no metric: refused before any call. */
const NO_DESCRIPTOR: Throw = {
  why: 'a detector naming no metric is refused before any call',
  says: /needs a metric descriptor/,
};

const RULE_ARN = `arn:aws:events:us-east-1:${ACCOUNT}:rule/bus/r`;
const TARGET_ARN = `arn:aws:sqs:us-east-1:${ACCOUNT}:q`;

/** Every target member but the ECS block and the input transformer. */
const TARGET_FULL = {
  Id: 't1',
  Arn: TARGET_ARN,
  RoleArn: `arn:aws:iam::${ACCOUNT}:role/events`,
  Input: '{"a":1}',
  DeadLetterConfig: { Arn: `arn:aws:sqs:us-east-1:${ACCOUNT}:dlq` },
  RetryPolicy: { MaximumEventAgeInSeconds: 600, MaximumRetryAttempts: 3 },
  SqsParameters: { MessageGroupId: 'g' },
  KinesisParameters: { PartitionKeyPath: '$.id' },
  HttpParameters: {
    HeaderParameters: { h: 'v' },
    PathParameterValues: ['p1', 'p2'],
    QueryStringParameters: { q: 'v' },
  },
  AppSyncParameters: { GraphQLOperation: 'mutation M { m }' },
  BatchParameters: {
    JobDefinition: 'jd',
    JobName: 'jn',
    ArrayProperties: { Size: 2 },
    RetryStrategy: { Attempts: 2 },
  },
  RedshiftDataParameters: {
    Database: 'db',
    DbUser: 'u',
    SecretManagerArn: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s`,
    Sql: 'select 1',
    Sqls: ['select 2', 'select 3'],
    StatementName: 'st',
    WithEvent: true,
  },
  SageMakerPipelineParameters: {
    PipelineParameterList: [
      { Name: 'n1', Value: 'v1' },
      { Name: 'n2', Value: 'v2' },
    ],
  },
  RunCommandParameters: {
    RunCommandTargets: [
      { Key: 'tag:a', Values: ['x', 'y'] },
      { Key: 'tag:b', Values: ['z'] },
    ],
  },
};

/** An ECS task target, every ECS member in the CloudFormation spelling. */
const TARGET_ECS = {
  Id: 't2',
  Arn: `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/c`,
  InputTransformer: { InputPathsMap: { id: '$.id' }, InputTemplate: '{"id":<id>}' },
  EcsParameters: {
    TaskDefinitionArn: `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/td:1`,
    TaskCount: 2,
    LaunchType: 'FARGATE',
    PlatformVersion: 'LATEST',
    Group: 'grp',
    ReferenceId: 'ref',
    EnableECSManagedTags: true,
    EnableExecuteCommand: true,
    PropagateTags: 'TASK_DEFINITION',
    NetworkConfiguration: {
      AwsVpcConfiguration: {
        AssignPublicIp: 'ENABLED',
        SecurityGroups: ['sg-1', 'sg-2'],
        Subnets: ['subnet-1', 'subnet-2'],
      },
    },
    CapacityProviderStrategy: [
      { CapacityProvider: 'FARGATE', Weight: 1, Base: 1 },
      { CapacityProvider: 'FARGATE_SPOT', Weight: 2, Base: 0 },
    ],
    PlacementConstraints: [
      { Type: 'memberOf', Expression: 'attribute:x == y' },
      { Type: 'distinctInstance' },
    ],
    PlacementStrategies: [
      { Type: 'spread', Field: 'attribute:az' },
      { Type: 'binpack', Field: 'memory' },
    ],
    TagList: [
      { Key: 'tk1', Value: 'tv1' },
      { Key: 'tk2', Value: 'tv2' },
    ],
  },
};

const TARGET_INPUT_PATH = { Id: 't3', Arn: TARGET_ARN, InputPath: '$.detail' };

// Not a gap: PutRule replaces the rule's settings and PutTargets each listed
// target whole, both from `next`; `prev` is read only for the targets (by Id)
// and tags to remove, which the update-remove probes of those paths observe.
const RULE_FROM_NEXT = 'PutRule / PutTargets send this whole from next; prev is not read';

/** `update-remove:<label>` for every path under a target, its Id excepted. */
function targetMembersFromNext(targets: Bag[]): Record<string, string> {
  return Object.fromEntries(
    paths(targets)
      .filter((p) => p.length >= 2 && p[1] !== 'Id')
      .map((p) => [`update-remove:Targets.${p.join('.')}`, RULE_FROM_NEXT])
  );
}

export const CASES_5: TypeCase[] = [
  {
    resourceType: 'AWS::KMS::Key',
    provider: () => new KMSProvider(),
    physicalId: KEY_ID,
    createOnly: createOnlyOf('AWS::KMS::Key'),
    arm: armKey,
    exempt: {
      PendingWindowInDays:
        'read by delete() alone (ScheduleKeyDeletion); no create or update request carries it',
    },
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          Description: 'd',
          KeyPolicy: KEY_POLICY,
          KeySpec: 'SYMMETRIC_DEFAULT',
          KeyUsage: 'ENCRYPT_DECRYPT',
          EnableKeyRotation: true,
          RotationPeriodInDays: 90,
          Enabled: false,
          MultiRegion: true,
          Origin: 'AWS_KMS',
          BypassPolicyLockoutSafetyCheck: true,
          Tags: TAGS,
        },
        variants: {
          KeySpec: 'HMAC_256',
          KeyUsage: 'GENERATE_VERIFY_MAC',
          Origin: 'EXTERNAL',
        },
        expectedSilent: {
          // Each is KMS's own default, so removing it from either side
          // leaves the key as it is: no change, and nothing to send.
          'update-add:KeySpec': DECLARED_DEFAULT,
          'update-remove:KeySpec': DECLARED_DEFAULT,
          'update-add:KeyUsage': DECLARED_DEFAULT,
          'update-remove:KeyUsage': DECLARED_DEFAULT,
          'update-add:Origin': DECLARED_DEFAULT,
          'update-remove:Origin': DECLARED_DEFAULT,
          // Varied against a previous side holding the default, so the varied
          // update is a change KMS cannot make and refuses (#5299).
          'update-vary:KeySpec': FIXED_AT_CREATION,
          'update-vary:KeyUsage': FIXED_AT_CREATION,
          'update-vary:Origin': FIXED_AT_CREATION,
          'update-vary:MultiRegion': FIXED_AT_CREATION,
          ...BYPASS_ONLY_ON_A_POLICY_PUT,
        },
        expectedRemovalThrows: {
          'update-add:MultiRegion': IMMUTABLE_KEY('MultiRegion'),
          'update-remove:MultiRegion': IMMUTABLE_KEY('MultiRegion'),
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
        },
      },
      {
        // Each fixed-at-creation property off its default, so removing it is
        // a change, which KMS cannot make: refused, as CloudFormation fails
        // the update (#5299).
        name: 'a key fixed at creation off every default',
        bag: {
          KeySpec: 'HMAC_256',
          KeyUsage: 'GENERATE_VERIFY_MAC',
          Origin: 'EXTERNAL',
          MultiRegion: true,
        },
        variants: { KeySpec: 'HMAC_384', KeyUsage: 'ENCRYPT_DECRYPT', Origin: 'AWS_CLOUDHSM' },
        expectedSilent: {
          'update-vary:KeySpec': FIXED_AT_CREATION,
          'update-vary:KeyUsage': FIXED_AT_CREATION,
          'update-vary:Origin': FIXED_AT_CREATION,
          'update-vary:MultiRegion': FIXED_AT_CREATION,
        },
        expectedRemovalThrows: Object.fromEntries(
          ['KeySpec', 'KeyUsage', 'Origin', 'MultiRegion'].flatMap((p) => [
            [`update-add:${p}`, IMMUTABLE_KEY(p)],
            [`update-remove:${p}`, IMMUTABLE_KEY(p)],
          ])
        ),
      },
    ],
  },
  {
    resourceType: 'AWS::KMS::Alias',
    provider: () => new KMSProvider(),
    physicalId: 'alias/a',
    createOnly: createOnlyOf('AWS::KMS::Alias'),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: { AliasName: 'alias/a', TargetKeyId: KEY_ID },
        expectedRemovalThrows: {
          'create:AliasName': REQUIRED('AliasName'),
          // UpdateAlias re-points the alias at the desired key on every update.
          ...Object.fromEntries(
            ALL_DIRECTIONS.map((d) => [`${d}:TargetKeyId`, REQUIRED('TargetKeyId')])
          ),
        },
      },
    ],
  },
  {
    resourceType: 'AWS::StepFunctions::StateMachine',
    provider: () => new StepFunctionsProvider(),
    physicalId: SM_ARN,
    createOnly: createOnlyOf('AWS::StepFunctions::StateMachine'),
    arm: armDefinitionObject,
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property, the body inline as DefinitionString',
        bag: {
          ...SM_COMMON,
          DefinitionString: SM_BODY,
          DefinitionSubstitutions: { s: 'P' },
          LoggingConfiguration: {
            Destinations: [
              {
                CloudWatchLogsLogGroup: {
                  LogGroupArn: `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:lg:*`,
                },
              },
            ],
            IncludeExecutionData: true,
            Level: 'ALL',
          },
          TracingConfiguration: { Enabled: true },
          EncryptionConfiguration: {
            Type: 'CUSTOMER_MANAGED_KMS_KEY',
            KmsKeyId: KEY_ID,
            KmsDataKeyReusePeriodSeconds: 300,
          },
          Tags: TAGS,
        },
        variants: {
          StateMachineType: 'EXPRESS',
          'LoggingConfiguration.Level': 'ERROR',
          'EncryptionConfiguration.Type': 'AWS_OWNED_KEY',
        },
        expectedSilent: smWholeFromNext([
          ...SM_DEFINITION_FROM_NEXT,
          'DefinitionString',
          'EncryptionConfiguration.KmsDataKeyReusePeriodSeconds',
          'EncryptionConfiguration.KmsKeyId',
          'LoggingConfiguration.Destinations',
          'LoggingConfiguration.Destinations.0',
          'LoggingConfiguration.Destinations.0.CloudWatchLogsLogGroup',
          'LoggingConfiguration.Destinations.0.CloudWatchLogsLogGroup.LogGroupArn',
          'LoggingConfiguration.IncludeExecutionData',
        ]),
        expectedRemovalThrows: { ...SM_ROLE_REQUIRED, ...TAG_THROWS(ALL_DIRECTIONS, 2) },
      },
      {
        name: 'the body inline as a Definition object',
        bag: {
          ...SM_COMMON,
          Definition: JSON.parse(SM_BODY) as Bag,
          DefinitionSubstitutions: { s: 'P' },
        },
        expectedSilent: smWholeFromNext([
          ...SM_DEFINITION_FROM_NEXT,
          'Definition',
          'Definition.StartAt',
          'Definition.States',
          'Definition.States.${s}',
          'Definition.States.${s}.End',
          'Definition.States.${s}.Type',
        ]),
        expectedRemovalThrows: SM_ROLE_REQUIRED,
      },
      {
        name: 'the body in S3',
        bag: {
          ...SM_COMMON,
          DefinitionS3Location: { Bucket: 'b', Key: 'k', Version: 'v1' },
          DefinitionSubstitutions: { s: 'P' },
        },
        expectedSilent: smWholeFromNext([
          ...SM_DEFINITION_FROM_NEXT,
          'DefinitionS3Location',
          'DefinitionS3Location.Bucket',
          'DefinitionS3Location.Key',
          'DefinitionS3Location.Version',
        ]),
        expectedRemovalThrows: SM_ROLE_REQUIRED,
      },
    ],
  },
  {
    resourceType: 'AWS::S3Vectors::VectorBucket',
    provider: () => new S3VectorsProvider(),
    physicalId: 'vb',
    createOnly: createOnlyOf('AWS::S3Vectors::VectorBucket'),
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          VectorBucketName: 'vb',
          EncryptionConfiguration: {
            SseType: 'aws:kms',
            KmsKeyArn: `arn:aws:kms:us-east-1:${ACCOUNT}:key/${KEY_ID}`,
          },
          Tags: TAGS,
        },
        variants: { 'EncryptionConfiguration.SseType': 'AES256' },
        expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
      },
    ],
  },
  {
    resourceType: 'AWS::Lambda::NetworkConnector',
    provider: () => new LambdaNetworkConnectorProvider(),
    physicalId: CONNECTOR_ARN,
    createOnly: createOnlyOf('AWS::Lambda::NetworkConnector'),
    arm: armActiveConnector,
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          Name: 'nc',
          Configuration: {
            VpcEgressConfiguration: {
              SubnetIds: ['subnet-1', 'subnet-2'],
              SecurityGroupIds: ['sg-1', 'sg-2'],
              NetworkProtocol: 'IPv4',
              AssociatedComputeResourceTypes: ['MicroVm', 'WebFunction'],
            },
          },
          OperatorRole: `arn:aws:iam::${ACCOUNT}:role/operator`,
          Tags: TAGS,
        },
        variants: { 'Configuration.VpcEgressConfiguration.NetworkProtocol': 'DualStack' },
        expectedRemovalThrows: {
          ...Object.fromEntries(
            ALL_DIRECTIONS.flatMap((d) => [
              [`${d}:Configuration`, VPC_EGRESS_REQUIRED],
              [`${d}:Configuration.VpcEgressConfiguration`, VPC_EGRESS_REQUIRED],
            ])
          ),
          'update-remove:OperatorRole': {
            why: 'UpdateNetworkConnector cannot detach a role, so a removed OperatorRole is refused',
            says: /OperatorRole cannot be removed in place/,
          },
          // A tag's Value is optional, as in CloudFormation: one without it is
          // sent as '' (#5310), so only a missing Key is refused.
          ...TAG_KEY_THROWS(ALL_DIRECTIONS, 2),
        },
      },
    ],
  },
  {
    resourceType: 'AWS::CloudWatch::AnomalyDetector',
    provider: () => new CloudWatchAnomalyDetectorProvider(),
    physicalId: 'AWS/Lambda|Errors|Sum',
    createOnly: createOnlyOf('AWS::CloudWatch::AnomalyDetector'),
    // Every update puts the whole detector from `next`, `prev` unread.
    wholeFromNext: {
      keys: () => true,
      reason: 'PutAnomalyDetector puts the whole detector from next; prev is not read',
    },
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'the metric named at the top level',
        bag: {
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Stat: 'Sum',
          Dimensions: [
            { Name: 'FunctionName', Value: 'f' },
            { Name: 'Resource', Value: 'r' },
          ],
          MetricCharacteristics: { PeriodicSpikes: true },
          Configuration: {
            // Offset-less, as CloudFormation documents them: read as UTC.
            ExcludedTimeRanges: [
              { StartTime: '2026-01-01T00:00:00', EndTime: '2026-01-02T00:00:00' },
            ],
            MetricTimeZone: 'Asia/Tokyo',
          },
        },
        variants: {
          'Configuration.ExcludedTimeRanges.0.StartTime': '2026-01-01T01:00:00',
          'Configuration.ExcludedTimeRanges.0.EndTime': '2026-01-02T01:00:00',
        },
      },
      {
        name: 'a single metric detector',
        bag: {
          SingleMetricAnomalyDetector: {
            AccountId: ACCOUNT,
            Namespace: 'AWS/Lambda',
            MetricName: 'Errors',
            Stat: 'Sum',
            Dimensions: [
              { Name: 'FunctionName', Value: 'f' },
              { Name: 'Resource', Value: 'r' },
            ],
          },
        },
        expectedRemovalThrows: { 'create:SingleMetricAnomalyDetector': NO_DESCRIPTOR },
      },
      {
        name: 'a metric math detector',
        bag: {
          MetricMathAnomalyDetector: {
            MetricDataQueries: [
              {
                Id: 'm1',
                AccountId: ACCOUNT,
                Label: 'errors',
                Period: 60,
                ReturnData: false,
                MetricStat: {
                  Metric: {
                    Namespace: 'AWS/Lambda',
                    MetricName: 'Errors',
                    Dimensions: [
                      { Name: 'FunctionName', Value: 'f' },
                      { Name: 'Resource', Value: 'r' },
                    ],
                  },
                  Period: 60,
                  Stat: 'Sum',
                  Unit: 'Count',
                },
              },
              { Id: 'e1', Expression: 'm1 * 2', ReturnData: true },
            ],
          },
        },
        variants: { 'MetricMathAnomalyDetector.MetricDataQueries.0.MetricStat.Unit': 'Seconds' },
        expectedRemovalThrows: { 'create:MetricMathAnomalyDetector': NO_DESCRIPTOR },
      },
    ],
  },
  {
    resourceType: 'AWS::Events::Rule',
    provider: () => new EventBridgeRuleProvider(),
    physicalId: RULE_ARN,
    createOnly: createOnlyOf('AWS::Events::Rule'),
    wholeFromNext: {
      keys: (key) => key !== 'Targets' && key !== 'Tags',
      reason: RULE_FROM_NEXT,
    },
    exempt: {},
    targets: [
      { path: ['Targets', 0], command: 'RemoveTargetsCommand', names: 't1', notNames: 't2' },
      { path: ['Targets', 1], command: 'RemoveTargetsCommand', names: 't2', notNames: 't1' },
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          Name: 'r',
          Description: 'd',
          EventBusName: 'bus',
          EventPattern: { source: ['a', 'b'] },
          ScheduleExpression: 'rate(5 minutes)',
          State: 'DISABLED',
          RoleArn: `arn:aws:iam::${ACCOUNT}:role/rule`,
          Targets: [TARGET_FULL, TARGET_ECS, TARGET_INPUT_PATH],
          Tags: TAGS,
        },
        variants: {
          State: 'ENABLED',
          'Targets.1.EcsParameters.LaunchType': 'EC2',
          'Targets.1.EcsParameters.PropagateTags': 'NONE',
          'Targets.1.EcsParameters.NetworkConfiguration.AwsVpcConfiguration.AssignPublicIp':
            'DISABLED',
          'Targets.1.EcsParameters.PlacementConstraints.0.Type': 'distinctInstance',
          'Targets.1.EcsParameters.PlacementConstraints.1.Type': 'memberOf',
          'Targets.1.EcsParameters.PlacementStrategies.0.Type': 'random',
          'Targets.1.EcsParameters.PlacementStrategies.1.Type': 'random',
        },
        expectedSilent: targetMembersFromNext([TARGET_FULL, TARGET_ECS, TARGET_INPUT_PATH]),
        expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
      },
    ],
  },
];
