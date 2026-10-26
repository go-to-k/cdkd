import { readFileSync } from 'node:fs';
import {
  ACCOUNT,
  TAG_THROWS,
  createOnlyOf,
  paths,
  setOutputOverrides,
  type Bag,
  type TypeCase,
} from './sdk-wire-harness.js';
import { PipesPipeProvider } from '../../../src/provisioning/providers/pipes-provider.js';
import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';

/**
 * The sixth batch of wire cases (#3723): the WAFv2 web ACL and the EventBridge
 * pipe. Run by `sdk-wire-coverage-6.test.ts`, which mocks the clients these
 * providers build themselves; the ledger in `sdk-wire-coverage.test.ts` counts
 * them as covered.
 */

// --- AWS::WAFv2::WebACL --------------------------------------------------------

export const WEB_ACL_ARN = `arn:aws:wafv2:us-east-1:${ACCOUNT}:global/webacl/acl/abc-123`;
export const LOCK_TOKEN = 'lock-1';

const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

/**
 * `UpdateWebACL` takes a `LockToken` only `GetWebACL` hands out; the
 * harness's generated output leaves every top-level `...Token` member out (a
 * pagination guard), so the read answers one here.
 */
export function armWebAcl(): void {
  setOutputOverrides({
    GetWebACLCommand: () => ({
      LockToken: LOCK_TOKEN,
      WebACL: { Name: 'acl', Id: 'abc-123', ARN: WEB_ACL_ARN, LabelNamespace: 'awswaf:ns' },
    }),
  });
}

// Not a gap: UpdateWebACL is a whole replacement, so update() sends every
// member from `next` on every call (wafv2-provider.ts:684-702) and reads
// `prev` only for the tag diff. A member removed from `prev` alone sends the
// same request; its update-add probe observes delivery, and its absence from
// `next` is what clears it on AWS, as CloudFormation's own update does.
const ACL_FROM_NEXT =
  'UpdateWebACL replaces the whole web ACL from next; prev is read only for the tag diff';

const TEXT_TRANSFORMATIONS = [
  { Priority: 0, Type: 'LOWERCASE' },
  { Priority: 1, Type: 'URL_DECODE' },
];
const PRE_PARSE = [{ Priority: 0, Type: 'BASE64_DECODE' }];
const RULE_VISIBILITY = (name: string) => ({
  CloudWatchMetricsEnabled: true,
  MetricName: name,
  SampledRequestsEnabled: false,
});
const INSERT_HEADERS = [
  { Name: 'x-a', Value: 'a' },
  { Name: 'x-b', Value: 'b' },
];
const IPSET_ARN = `arn:aws:wafv2:us-east-1:${ACCOUNT}:global/ipset/ips/i-1`;
const REGEX_SET_ARN = `arn:aws:wafv2:us-east-1:${ACCOUNT}:global/regexpatternset/rx/r-1`;
const RULE_GROUP_ARN = `arn:aws:wafv2:us-east-1:${ACCOUNT}:global/rulegroup/rg/g-1`;

/**
 * One rule per statement kind, each with a different rule action, so every
 * conversion `toSdkStatement` makes is carried: the `SearchStringBase64`
 * decode and the reference-statement `Arn` -> `ARN` rename at the top of a
 * statement AND under each recursion point (`NotStatement.Statement`,
 * `AndStatement` / `OrStatement` `Statements`, both `ScopeDownStatement`s).
 */
const RULES = [
  {
    Name: 'byte-plain',
    Priority: 0,
    Statement: {
      ByteMatchStatement: {
        SearchString: 'needle',
        FieldToMatch: { SingleHeader: { Name: 'user-agent' } },
        PositionalConstraint: 'CONTAINS',
        TextTransformations: TEXT_TRANSFORMATIONS,
        PreParseTextTransformations: PRE_PARSE,
      },
    },
    Action: {
      Block: {
        CustomResponse: {
          ResponseCode: 403,
          CustomResponseBodyKey: 'b1',
          ResponseHeaders: INSERT_HEADERS,
        },
      },
    },
    VisibilityConfig: RULE_VISIBILITY('r0'),
    RuleLabels: [{ Name: 'l:a' }, { Name: 'l:b' }],
    CaptchaConfig: { ImmunityTimeProperty: { ImmunityTime: 60 } },
    ChallengeConfig: { ImmunityTimeProperty: { ImmunityTime: 120 } },
  },
  {
    Name: 'byte-base64',
    Priority: 1,
    Statement: {
      ByteMatchStatement: {
        SearchStringBase64: 'bmVlZGxl',
        FieldToMatch: { Body: { OversizeHandling: 'MATCH' } },
        PositionalConstraint: 'EXACTLY',
        TextTransformations: [{ Priority: 0, Type: 'NONE' }],
      },
    },
    Action: { Allow: { CustomRequestHandling: { InsertHeaders: INSERT_HEADERS } } },
    VisibilityConfig: RULE_VISIBILITY('r1'),
  },
  {
    Name: 'and-not',
    Priority: 2,
    Statement: {
      AndStatement: {
        Statements: [
          {
            IPSetReferenceStatement: {
              Arn: IPSET_ARN,
              IPSetForwardedIPConfig: {
                HeaderName: 'X-Forwarded-For',
                FallbackBehavior: 'MATCH',
                Position: 'FIRST',
              },
            },
          },
          {
            NotStatement: {
              Statement: {
                RegexPatternSetReferenceStatement: {
                  Arn: REGEX_SET_ARN,
                  FieldToMatch: { UriPath: {} },
                  TextTransformations: [{ Priority: 0, Type: 'NONE' }],
                },
              },
            },
          },
        ],
      },
    },
    Action: { Count: { CustomRequestHandling: { InsertHeaders: [{ Name: 'x-c', Value: 'c' }] } } },
    VisibilityConfig: RULE_VISIBILITY('r2'),
  },
  {
    Name: 'or',
    Priority: 3,
    Statement: {
      OrStatement: {
        Statements: [
          {
            GeoMatchStatement: {
              CountryCodes: ['JP', 'US'],
              ForwardedIPConfig: { HeaderName: 'X-Forwarded-For', FallbackBehavior: 'NO_MATCH' },
            },
          },
          {
            ByteMatchStatement: {
              SearchStringBase64: 'b3ItbmVlZGxl',
              FieldToMatch: { QueryString: {} },
              PositionalConstraint: 'STARTS_WITH',
              TextTransformations: [{ Priority: 0, Type: 'NONE' }],
            },
          },
        ],
      },
    },
    Action: {
      Captcha: { CustomRequestHandling: { InsertHeaders: [{ Name: 'x-d', Value: 'd' }] } },
    },
    VisibilityConfig: RULE_VISIBILITY('r3'),
  },
  {
    Name: 'rate',
    Priority: 4,
    Statement: {
      RateBasedStatement: {
        Limit: 1000,
        AggregateKeyType: 'CUSTOM_KEYS',
        EvaluationWindowSec: 300,
        ForwardedIPConfig: { HeaderName: 'X-Forwarded-For', FallbackBehavior: 'MATCH' },
        CustomKeys: [
          { Header: { Name: 'x-key', TextTransformations: [{ Priority: 0, Type: 'NONE' }] } },
          { IP: {} },
        ],
        ScopeDownStatement: { IPSetReferenceStatement: { Arn: IPSET_ARN } },
      },
    },
    Action: {
      Challenge: { CustomRequestHandling: { InsertHeaders: [{ Name: 'x-e', Value: 'e' }] } },
    },
    VisibilityConfig: RULE_VISIBILITY('r4'),
  },
  {
    Name: 'managed',
    Priority: 5,
    Statement: {
      ManagedRuleGroupStatement: {
        VendorName: 'AWS',
        Name: 'AWSManagedRulesCommonRuleSet',
        Version: 'Version_1.0',
        ExcludedRules: [{ Name: 'SizeRestrictions_BODY' }, { Name: 'NoUserAgent_HEADER' }],
        RuleActionOverrides: [
          { Name: 'CrossSiteScripting_BODY', ActionToUse: { Count: {} } },
          { Name: 'GenericLFI_BODY', ActionToUse: { Block: {} } },
        ],
        ScopeDownStatement: {
          NotStatement: {
            Statement: { RuleGroupReferenceStatement: { Arn: RULE_GROUP_ARN } },
          },
        },
      },
    },
    OverrideAction: { None: {} },
    VisibilityConfig: RULE_VISIBILITY('r5'),
  },
  {
    Name: 'group',
    Priority: 6,
    Statement: {
      RuleGroupReferenceStatement: {
        Arn: RULE_GROUP_ARN,
        ExcludedRules: [{ Name: 'g-a' }],
        RuleActionOverrides: [{ Name: 'g-b', ActionToUse: { Monetize: { PriceMultiplier: 'x2' } } }],
      },
    },
    OverrideAction: { Count: {} },
    VisibilityConfig: RULE_VISIBILITY('r6'),
  },
  {
    Name: 'size',
    Priority: 7,
    Statement: {
      SizeConstraintStatement: {
        FieldToMatch: {
          Cookies: { MatchPattern: { All: {} }, MatchScope: 'ALL', OversizeHandling: 'CONTINUE' },
        },
        ComparisonOperator: 'GT',
        Size: 8192,
        TextTransformations: [{ Priority: 0, Type: 'NONE' }],
        PreParseTextTransformations: PRE_PARSE,
      },
    },
    Action: { Monetize: { PriceMultiplier: 'x1' } },
    VisibilityConfig: RULE_VISIBILITY('r7'),
  },
  {
    Name: 'sqli',
    Priority: 8,
    Statement: {
      SqliMatchStatement: {
        FieldToMatch: {
          JsonBody: {
            MatchPattern: { IncludedPaths: ['/a', '/b'] },
            MatchScope: 'VALUE',
            InvalidFallbackBehavior: 'EVALUATE_AS_STRING',
            OversizeHandling: 'NO_MATCH',
          },
        },
        SensitivityLevel: 'HIGH',
        TextTransformations: [{ Priority: 0, Type: 'URL_DECODE' }],
      },
    },
    Action: { Block: {} },
    VisibilityConfig: RULE_VISIBILITY('r8'),
  },
  {
    Name: 'xss',
    Priority: 9,
    Statement: {
      XssMatchStatement: {
        FieldToMatch: {
          Headers: {
            MatchPattern: { IncludedHeaders: ['h-a', 'h-b'] },
            MatchScope: 'KEY',
            OversizeHandling: 'MATCH',
          },
        },
        TextTransformations: [{ Priority: 0, Type: 'HTML_ENTITY_DECODE' }],
      },
    },
    Action: { Block: {} },
    VisibilityConfig: RULE_VISIBILITY('r9'),
  },
  {
    Name: 'regex',
    Priority: 10,
    Statement: {
      RegexMatchStatement: {
        RegexString: '^/admin',
        FieldToMatch: { SingleQueryArgument: { Name: 'q' } },
        TextTransformations: [{ Priority: 0, Type: 'NONE' }],
      },
    },
    Action: { Block: {} },
    VisibilityConfig: RULE_VISIBILITY('r10'),
  },
  {
    Name: 'label',
    Priority: 11,
    Statement: { LabelMatchStatement: { Scope: 'LABEL', Key: 'awswaf:managed:x' } },
    Action: { Count: {} },
    VisibilityConfig: RULE_VISIBILITY('r11'),
  },
  {
    Name: 'asn',
    Priority: 12,
    Statement: {
      AsnMatchStatement: {
        AsnList: [64496, 64497],
        ForwardedIPConfig: { HeaderName: 'X-Forwarded-For', FallbackBehavior: 'MATCH' },
      },
    },
    Action: { Block: {} },
    VisibilityConfig: RULE_VISIBILITY('r12'),
  },
];

const ACL_FULL: Bag = {
  Name: 'acl',
  Scope: 'CLOUDFRONT',
  Description: 'd',
  DefaultAction: { Allow: { CustomRequestHandling: { InsertHeaders: INSERT_HEADERS } } },
  Rules: RULES,
  VisibilityConfig: {
    CloudWatchMetricsEnabled: true,
    MetricName: 'acl',
    SampledRequestsEnabled: true,
  },
  CustomResponseBodies: {
    b1: { Content: 'denied', ContentType: 'TEXT_PLAIN' },
    b2: { Content: '{"e":1}', ContentType: 'APPLICATION_JSON' },
  },
  CaptchaConfig: { ImmunityTimeProperty: { ImmunityTime: 300 } },
  ChallengeConfig: { ImmunityTimeProperty: { ImmunityTime: 600 } },
  TokenDomains: ['a.example.com', 'b.example.com'],
  AssociationConfig: { RequestBody: { CLOUDFRONT: { DefaultSizeInspectionLimit: 'KB_16' } } },
  Tags: TAGS,
};

/** The other `DefaultAction` member: a block with a custom response. */
const BLOCK_DEFAULT: Bag = {
  Name: 'acl',
  Scope: 'CLOUDFRONT',
  DefaultAction: {
    Block: {
      CustomResponse: {
        ResponseCode: 429,
        CustomResponseBodyKey: 'b1',
        ResponseHeaders: INSERT_HEADERS,
      },
    },
  },
  VisibilityConfig: {
    CloudWatchMetricsEnabled: false,
    MetricName: 'acl',
    SampledRequestsEnabled: false,
  },
};

// Not a gap: `Rules` reaches the SDK as one document. `toSdkRules` /
// `toSdkStatement` (wafv2-provider.ts:178-245) spread each rule and statement
// and rewrite only `ByteMatchStatement.SearchStringBase64`, the three
// reference statements' `Arn` and the five recursion points, all carried in
// RULES above. Every other member rides through untouched, so its delivery is
// argued by a delivered sibling under the same parent. What no bag observes
// is its key SPELLING against the SDK model: the provider's own diff of the
// CFn keys (wafv2-provider.ts:139-148) is the only evidence there.
const RULES_VERBATIM =
  'passed through verbatim inside the Rules document, as its carried siblings are; its spelling against the SDK model is not observed by a bag';

// Not a gap: a map keyed by a user-chosen name (a body key, an association
// resource type), which the nested-path check spells as a segment of the path:
// the bag carries the member under its key (`CustomResponseBodies.b1.Content`),
// where every probe reaches it.
const MAP_KEYED = 'a member of a keyed map: carried under its key, where the probes reach it';

/** Every schema `Rules` path no bag carries, each with the reason. */
function rulesExemptions(): Record<string, string> {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../fixtures/cfn-schemas/AWS-WAFv2-WebACL.json', import.meta.url),
      'utf8'
    )
  ) as { nestedPropertyPaths: Record<string, string[]> };
  const carried = new Set(
    paths(RULES).map((p) => p.filter((seg) => typeof seg === 'string').join('.'))
  );
  return Object.fromEntries(
    fixture.nestedPropertyPaths['Rules']!.filter((p) => !carried.has(p)).map((p) => [
      `Rules.${p}`,
      RULES_VERBATIM,
    ])
  );
}

const WAFV2_CASES: TypeCase[] = [
  {
    resourceType: 'AWS::WAFv2::WebACL',
    provider: () => new WAFv2WebACLProvider(),
    physicalId: WEB_ACL_ARN,
    createOnly: createOnlyOf('AWS::WAFv2::WebACL'),
    arm: () => armWebAcl(),
    wholeFromNext: { keys: (key) => key !== 'Tags', reason: ACL_FROM_NEXT },
    exempt: {},
    nestedExempt: {
      ...rulesExemptions(),
      'CustomResponseBodies.Content': MAP_KEYED,
      'CustomResponseBodies.ContentType': MAP_KEYED,
      'AssociationConfig.RequestBody.DefaultSizeInspectionLimit': MAP_KEYED,
    },
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property, an Allow default',
        bag: ACL_FULL,
        expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
      },
      { name: 'a Block default', bag: BLOCK_DEFAULT },
    ],
  },
];

// --- AWS::Pipes::Pipe ----------------------------------------------------------

const PIPE = 'p';
const PIPE_ARN = `arn:aws:pipes:us-east-1:${ACCOUNT}:pipe/${PIPE}`;
const ROLE = `arn:aws:iam::${ACCOUNT}:role/pipe`;
const QUEUE = `arn:aws:sqs:us-east-1:${ACCOUNT}:q`;

/**
 * The live pipe: settled (`RUNNING`) on every read, so the create and update
 * settle waits return on their first `DescribePipe`, and carrying its ARN for
 * the tag calls. `LastModifiedTime` is the epoch, which `UpdatePipe`'s
 * generated answer also carries, so the update's read is not stale.
 */
function armPipe(): void {
  setOutputOverrides({
    DescribePipeCommand: () => ({
      Arn: PIPE_ARN,
      Name: PIPE,
      CurrentState: 'RUNNING',
      CreationTime: new Date(1_000_000),
      LastModifiedTime: new Date(0),
    }),
  });
}

/** Every target block, with every nested member the schema lists. */
const TARGET_PARAMETERS = {
  InputTemplate: '{"a":<$.a>}',
  BatchJobParameters: {
    JobDefinition: 'jd',
    JobName: 'jn',
    ArrayProperties: { Size: 2 },
    ContainerOverrides: {
      Command: ['c1', 'c2'],
      Environment: [
        { Name: 'E1', Value: 'v1' },
        { Name: 'E2', Value: 'v2' },
      ],
      InstanceType: 'm5.large',
      ResourceRequirements: [
        { Type: 'GPU', Value: '1' },
        { Type: 'MEMORY', Value: '512' },
      ],
    },
    DependsOn: [
      { JobId: 'j1', Type: 'N_TO_N' },
      { JobId: 'j2', Type: 'SEQUENTIAL' },
    ],
    Parameters: { p1: 'v1', p2: 'v2' },
    RetryStrategy: { Attempts: 3 },
  },
  CloudWatchLogsParameters: { LogStreamName: 'ls', Timestamp: '$.time' },
  EcsTaskParameters: {
    TaskDefinitionArn: `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/td:1`,
    CapacityProviderStrategy: [
      { CapacityProvider: 'cp1', Weight: 1, Base: 1 },
      { CapacityProvider: 'cp2', Weight: 2, Base: 0 },
    ],
    EnableECSManagedTags: true,
    EnableExecuteCommand: true,
    Group: 'g',
    LaunchType: 'FARGATE',
    NetworkConfiguration: {
      AwsvpcConfiguration: {
        AssignPublicIp: 'ENABLED',
        SecurityGroups: ['sg-1', 'sg-2'],
        Subnets: ['subnet-1', 'subnet-2'],
      },
    },
    Overrides: {
      ContainerOverrides: [
        {
          Name: 'c',
          Command: ['a', 'b'],
          Cpu: 256,
          Memory: 512,
          MemoryReservation: 256,
          Environment: [
            { Name: 'E1', Value: 'v1' },
            { Name: 'E2', Value: 'v2' },
          ],
          EnvironmentFiles: [
            { Type: 's3', Value: 'arn:aws:s3:::b/e1.env' },
            { Type: 's3', Value: 'arn:aws:s3:::b/e2.env' },
          ],
          ResourceRequirements: [
            { Type: 'GPU', Value: '1' },
            { Type: 'InferenceAccelerator', Value: 'dev1' },
          ],
        },
      ],
      Cpu: '512',
      EphemeralStorage: { SizeInGiB: 30 },
      ExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/exec`,
      InferenceAcceleratorOverrides: [
        { DeviceName: 'dev1', DeviceType: 'eia2.medium' },
        { DeviceName: 'dev2', DeviceType: 'eia2.large' },
      ],
      Memory: '1024',
      TaskRoleArn: `arn:aws:iam::${ACCOUNT}:role/task`,
    },
    PlacementConstraints: [
      { Type: 'memberOf', Expression: 'attribute:a == b' },
      { Type: 'distinctInstance', Expression: 'x' },
    ],
    PlacementStrategy: [
      { Type: 'spread', Field: 'attribute:ecs.availability-zone' },
      { Type: 'binpack', Field: 'cpu' },
    ],
    PlatformVersion: 'LATEST',
    PropagateTags: 'TASK_DEFINITION',
    ReferenceId: 'ref',
    Tags: [
      { Key: 'tk1', Value: 'tv1' },
      { Key: 'tk2', Value: 'tv2' },
    ],
    TaskCount: 2,
  },
  EventBridgeEventBusParameters: {
    DetailType: 'dt',
    EndpointId: 'ep.abc',
    Resources: ['r1', 'r2'],
    Source: 'src',
    Time: '$.time',
  },
  HttpParameters: {
    HeaderParameters: { h1: 'v1', h2: 'v2' },
    PathParameterValues: ['pp1', 'pp2'],
    QueryStringParameters: { q1: 'v1', q2: 'v2' },
  },
  KinesisStreamParameters: { PartitionKey: 'pk' },
  LambdaFunctionParameters: { InvocationType: 'FIRE_AND_FORGET' },
  RedshiftDataParameters: {
    Database: 'db',
    DbUser: 'u',
    SecretManagerArn: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s`,
    Sqls: ['select 1', 'select 2'],
    StatementName: 'st',
    WithEvent: true,
  },
  SageMakerPipelineParameters: {
    PipelineParameterList: [
      { Name: 'n1', Value: 'v1' },
      { Name: 'n2', Value: 'v2' },
    ],
  },
  SqsQueueParameters: { MessageDeduplicationId: 'dd', MessageGroupId: 'mg' },
  StepFunctionStateMachineParameters: { InvocationType: 'REQUEST_RESPONSE' },
  TimestreamParameters: {
    DimensionMappings: [
      { DimensionName: 'd1', DimensionValue: '$.d1', DimensionValueType: 'VARCHAR' },
      { DimensionName: 'd2', DimensionValue: '$.d2', DimensionValueType: 'VARCHAR' },
    ],
    EpochTimeUnit: 'SECONDS',
    MultiMeasureMappings: [
      {
        MultiMeasureName: 'mm',
        MultiMeasureAttributeMappings: [
          { MeasureValue: '$.a', MeasureValueType: 'DOUBLE', MultiMeasureAttributeName: 'a' },
          { MeasureValue: '$.b', MeasureValueType: 'BIGINT', MultiMeasureAttributeName: 'b' },
        ],
      },
    ],
    SingleMeasureMappings: [
      { MeasureName: 's1', MeasureValue: '$.s1', MeasureValueType: 'DOUBLE' },
      { MeasureName: 's2', MeasureValue: '$.s2', MeasureValueType: 'BIGINT' },
    ],
    TimeFieldType: 'TIMESTAMP_FORMAT',
    TimeValue: '$.t',
    TimestampFormat: 'yyyy-MM-dd',
    VersionValue: '$.v',
  },
};

/** Every top-level property, the source a Kinesis stream. */
const PIPE_FULL: Bag = {
  Name: PIPE,
  Description: 'd',
  // Not RUNNING: an update that removes it resets it to RUNNING
  // (`removalDefaults`), which would equal a RUNNING previous and send nothing.
  DesiredState: 'STOPPED',
  Source: `arn:aws:kinesis:us-east-1:${ACCOUNT}:stream/s`,
  SourceParameters: {
    FilterCriteria: { Filters: [{ Pattern: '{"a":["1"]}' }, { Pattern: '{"b":["2"]}' }] },
    KinesisStreamParameters: {
      BatchSize: 10,
      DeadLetterConfig: { Arn: QUEUE },
      MaximumBatchingWindowInSeconds: 5,
      MaximumRecordAgeInSeconds: 120,
      MaximumRetryAttempts: 3,
      OnPartialBatchItemFailure: 'AUTOMATIC_BISECT',
      ParallelizationFactor: 2,
      StartingPosition: 'AT_TIMESTAMP',
      StartingPositionTimestamp: '2026-01-01T00:00:00Z',
    },
  },
  Enrichment: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:enrich`,
  EnrichmentParameters: {
    InputTemplate: '{"e":<$.e>}',
    HttpParameters: {
      HeaderParameters: { h1: 'v1', h2: 'v2' },
      PathParameterValues: ['pp1', 'pp2'],
      QueryStringParameters: { q1: 'v1', q2: 'v2' },
    },
  },
  Target: `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/c`,
  TargetParameters: TARGET_PARAMETERS,
  RoleArn: ROLE,
  LogConfiguration: {
    Level: 'INFO',
    IncludeExecutionData: ['ALL'],
    CloudwatchLogsLogDestination: {
      LogGroupArn: `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:lg`,
    },
    FirehoseLogDestination: {
      DeliveryStreamArn: `arn:aws:firehose:us-east-1:${ACCOUNT}:deliverystream/ds`,
    },
    S3LogDestination: {
      BucketName: 'b',
      BucketOwner: ACCOUNT,
      OutputFormat: 'json',
      Prefix: 'pre/',
    },
  },
  KmsKeyIdentifier: 'alias/k',
  Tags: { k1: 'v1', k2: 'v2' },
};

/** The minimal pipe the other source blocks ride on. */
const PIPE_BASE: Bag = { Name: PIPE, Source: QUEUE, Target: QUEUE, RoleArn: ROLE };

const PIPES_CASES: TypeCase[] = [
  {
    resourceType: 'AWS::Pipes::Pipe',
    provider: () => new PipesPipeProvider({ sleep: async () => undefined }),
    physicalId: PIPE,
    createOnly: createOnlyOf('AWS::Pipes::Pipe'),
    arm: () => armPipe(),
    exempt: {},
    targets: [
      { path: ['Tags', 'k1'], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 'k2'], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
      // UpdatePipe re-sends the filter list from next: the removed filter must
      // not ride along.
      {
        path: ['SourceParameters', 'FilterCriteria', 'Filters', 0],
        command: 'UpdatePipeCommand',
        names: '{\\"b\\":[\\"2\\"]}',
        notNames: '{\\"a\\":[\\"1\\"]}',
      },
    ],
    bags: [
      {
        name: 'every top-level property, a Kinesis source',
        bag: PIPE_FULL,
        variants: {
          'SourceParameters.KinesisStreamParameters.StartingPositionTimestamp':
            '2026-01-02T00:00:00Z',
        },
      },
      {
        name: 'the DynamoDB, SQS, ActiveMQ and RabbitMQ source blocks',
        bag: {
          ...PIPE_BASE,
          SourceParameters: {
            DynamoDBStreamParameters: {
              BatchSize: 10,
              DeadLetterConfig: { Arn: QUEUE },
              MaximumBatchingWindowInSeconds: 5,
              MaximumRecordAgeInSeconds: 120,
              MaximumRetryAttempts: 3,
              OnPartialBatchItemFailure: 'AUTOMATIC_BISECT',
              ParallelizationFactor: 2,
              StartingPosition: 'LATEST',
            },
            SqsQueueParameters: { BatchSize: 10, MaximumBatchingWindowInSeconds: 5 },
            ActiveMQBrokerParameters: {
              BatchSize: 10,
              Credentials: { BasicAuth: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:a` },
              MaximumBatchingWindowInSeconds: 5,
              QueueName: 'aq',
            },
            RabbitMQBrokerParameters: {
              BatchSize: 10,
              Credentials: { BasicAuth: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:r` },
              MaximumBatchingWindowInSeconds: 5,
              QueueName: 'rq',
              VirtualHost: 'vh',
            },
          },
        },
      },
      {
        name: 'the Kafka source blocks, SASL/SCRAM-512 credentials',
        bag: {
          ...PIPE_BASE,
          SourceParameters: {
            ManagedStreamingKafkaParameters: {
              BatchSize: 10,
              ConsumerGroupID: 'cg',
              Credentials: {
                SaslScram512Auth: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:m512`,
              },
              MaximumBatchingWindowInSeconds: 5,
              StartingPosition: 'TRIM_HORIZON',
              TopicName: 't',
            },
            SelfManagedKafkaParameters: {
              AdditionalBootstrapServers: ['b1:9092', 'b2:9092'],
              BatchSize: 10,
              ConsumerGroupID: 'cg',
              Credentials: {
                SaslScram512Auth: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s512`,
              },
              MaximumBatchingWindowInSeconds: 5,
              ServerRootCaCertificate: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:ca`,
              StartingPosition: 'LATEST',
              TopicName: 't',
              Vpc: { SecurityGroup: ['sg-1', 'sg-2'], Subnets: ['subnet-1', 'subnet-2'] },
            },
          },
        },
      },
      {
        name: 'the Kafka source blocks, TLS client certificate credentials',
        bag: {
          ...PIPE_BASE,
          SourceParameters: {
            ManagedStreamingKafkaParameters: {
              TopicName: 't',
              Credentials: {
                ClientCertificateTlsAuth: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:mtls`,
              },
            },
            SelfManagedKafkaParameters: {
              TopicName: 't',
              Credentials: {
                ClientCertificateTlsAuth: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:stls`,
              },
            },
          },
        },
      },
      {
        name: 'a self-managed Kafka source, basic credentials',
        bag: {
          ...PIPE_BASE,
          SourceParameters: {
            SelfManagedKafkaParameters: {
              TopicName: 't',
              Credentials: { BasicAuth: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:b` },
            },
          },
        },
      },
      {
        name: 'a self-managed Kafka source, SASL/SCRAM-256 credentials',
        bag: {
          ...PIPE_BASE,
          SourceParameters: {
            SelfManagedKafkaParameters: {
              TopicName: 't',
              Credentials: {
                SaslScram256Auth: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s256`,
              },
            },
          },
        },
      },
    ],
  },
];

export const CASES_6: TypeCase[] = [...WAFV2_CASES, ...PIPES_CASES];
