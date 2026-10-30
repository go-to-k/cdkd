import {
  ACCOUNT,
  TAG_THROWS,
  createOnlyOf,
  type BagCase,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { AgentCoreRuntimeProvider } from '../../../src/provisioning/providers/agentcore-runtime-provider.js';
import { AgentCoreEvaluatorProvider } from '../../../src/provisioning/providers/agentcore-evaluator-provider.js';

/**
 * The eleventh batch of wire cases (#3723): the CloudTrail trail
 * (`@aws-sdk/client-cloudtrail`, whose provider builds its own clients, a
 * create client among them), and the AgentCore runtime and evaluator
 * (`@aws-sdk/client-bedrock-agentcore-control`, through `getAwsClients()`).
 * `sdk-wire-coverage-11.test.ts` mocks both packages and that module.
 */

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];
const REQUIRED = (why: string, says: RegExp): Throw => ({ why, says });
const TAG_LIST = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];
const KMS = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k1`;

/**
 * A copy sharing no object with any other bag: the harness's `without` is a
 * `structuredClone`, which KEEPS shared references, so a block reused in two
 * places would lose a path in both at once.
 */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// --- AWS::CloudTrail::Trail -------------------------------------------------------

const TRAIL_ARN = `arn:aws:cloudtrail:us-east-1:${ACCOUNT}:trail/trail`;

const TRAIL_CASE: TypeCase = {
  resourceType: 'AWS::CloudTrail::Trail',
  provider: () => new CloudTrailProvider(),
  physicalId: TRAIL_ARN,
  createOnly: createOnlyOf('AWS::CloudTrail::Trail'),
  exempt: {},
  targets: [
    // RemoveTags takes whole {Key, Value} entries, the removed one only.
    { path: ['Tags', 0], command: 'RemoveTagsCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'RemoveTagsCommand', names: 'k2', notNames: 'k1' },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        TrailName: 'trail',
        S3BucketName: 'bucket',
        S3KeyPrefix: 'prefix',
        // Single-region, so a removed IncludeGlobalServiceEvents is reset
        // (cloudtrail-provider.ts, in update(): the IncludeGlobalServiceEvents reset).
        IsMultiRegionTrail: false,
        IncludeGlobalServiceEvents: true,
        EnableLogFileValidation: true,
        // `false`: an absent IsLogging starts logging on create
        // (cloudtrail-provider.ts, in create(): the StartLogging branch), so only a stopped trail differs.
        IsLogging: false,
        CloudWatchLogsLogGroupArn: `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:trail:*`,
        CloudWatchLogsRoleArn: `arn:aws:iam::${ACCOUNT}:role/trail-logs`,
        KMSKeyId: KMS,
        SnsTopicName: 'topic',
        IsOrganizationTrail: true,
        EventSelectors: [
          {
            ReadWriteType: 'WriteOnly',
            IncludeManagementEvents: true,
            DataResources: [
              { Type: 'AWS::S3::Object', Values: ['arn:aws:s3:::b1/', 'arn:aws:s3:::b2/'] },
              {
                Type: 'AWS::Lambda::Function',
                Values: [`arn:aws:lambda:us-east-1:${ACCOUNT}:function:f`],
              },
            ],
            ExcludeManagementEventSources: ['kms.amazonaws.com', 'rdsdata.amazonaws.com'],
          },
          { ReadWriteType: 'ReadOnly', IncludeManagementEvents: false },
        ],
        InsightSelectors: [
          { InsightType: 'ApiCallRateInsight', EventCategories: ['Management'] },
          { InsightType: 'ApiErrorRateInsight' },
        ],
        Tags: TAG_LIST,
      },
      variants: {
        // An enum: the alternative must be another member.
        'EventSelectors.0.ReadWriteType': 'All',
      },
      expectedSilent: {
        'update-remove:IsLogging':
          'an absent desired IsLogging leaves logging as it is: IsLogging is CFn-required, so only a state replay can lack it, and that must not start a stopped trail (cloudtrail-provider.ts, in update(): the IsLogging branch)',
        ...Object.fromEntries(
          ['CloudWatchLogsLogGroupArn', 'CloudWatchLogsRoleArn'].map((key) => [
            `update-remove:${key}`,
            'left in place on removal: UpdateTrail keeps an absent field, and CloudFormation kept the CloudWatch Logs pair too (CFn A/B, cloudtrail-provider.ts, in update(): the RETAINED removal note and resolveCloudWatchLogsPair)',
          ])
        ),
        'update-remove:IsOrganizationTrail':
          'left in place on removal: CloudFormation\'s reset of IsOrganizationTrail is unmeasurable without an Organizations management account, so it is passed through rather than guessed (cloudtrail-provider.ts, in update(): the IsOrganizationTrail removal note)',
        'update-remove:S3BucketName':
          'S3BucketName is required, so no deployable template removes it: create() refuses a trail without it (cloudtrail-provider.ts, in create(): the S3BucketName check)',
      },
      expectedRemovalThrows: {
        'create:S3BucketName': REQUIRED(
          'S3BucketName is required: create() refuses a trail without it before any call (cloudtrail-provider.ts, in create(): the S3BucketName check)',
          /S3BucketName is required/
        ),
        ...TAG_THROWS(ALL_DIRECTIONS, 2),
      },
    },
    {
      // Multi-region, where a removed IncludeGlobalServiceEvents is passed
      // through instead of reset (cloudtrail-provider.ts, in update(): the IncludeGlobalServiceEvents reset).
      name: 'multi-region',
      bag: {
        TrailName: 'trail',
        S3BucketName: 'bucket',
        IsMultiRegionTrail: true,
        IncludeGlobalServiceEvents: true,
      },
      expectedSilent: {
        'update-remove:IncludeGlobalServiceEvents':
          'passed through on removal while the trail stays multi-region: AWS refuses a multi-region trail that excludes global service events, so the reset applies only to a known single-region trail (cloudtrail-provider.ts, in update(): the IncludeGlobalServiceEvents reset)',
        'update-remove:S3BucketName':
          'S3BucketName is required, so no deployable template removes it: create() refuses a trail without it (cloudtrail-provider.ts, in create(): the S3BucketName check)',
      },
      expectedRemovalThrows: {
        'create:S3BucketName': REQUIRED(
          'S3BucketName is required: create() refuses a trail without it before any call (cloudtrail-provider.ts, in create(): the S3BucketName check)',
          /S3BucketName is required/
        ),
      },
    },
    {
      // Issue #2762. A bag of its own: AWS refuses EventSelectors beside
      // AdvancedEventSelectors, so "every property" carries the basic list.
      name: 'advanced selectors + aggregation',
      bag: {
        TrailName: 'trail',
        S3BucketName: 'bucket',
        AdvancedEventSelectors: [
          {
            Name: 's3-data',
            FieldSelectors: [
              { Field: 'eventCategory', Equals: ['Data'] },
              { Field: 'resources.type', Equals: ['AWS::S3::Object'] },
              {
                Field: 'resources.ARN',
                StartsWith: ['arn:aws:s3:::b1/', 'arn:aws:s3:::b2/'],
                NotStartsWith: ['arn:aws:s3:::b1/x', 'arn:aws:s3:::b2/x'],
                EndsWith: ['.json', '.csv'],
                NotEndsWith: ['.tmp', '.bak'],
                NotEquals: ['arn:aws:s3:::b1/a', 'arn:aws:s3:::b2/a'],
              },
            ],
          },
          {
            Name: 'management',
            FieldSelectors: [{ Field: 'eventCategory', Equals: ['Management'] }],
          },
        ],
        AggregationConfigurations: [
          { EventCategory: 'Data', Templates: ['API_ACTIVITY', 'RESOURCE_ACCESS'] },
        ],
      },
      expectedSilent: {
        'update-remove:S3BucketName':
          'S3BucketName is required, so no deployable template removes it: create() refuses a trail without it (cloudtrail-provider.ts, in create(): the S3BucketName check)',
      },
      expectedRemovalThrows: {
        'create:S3BucketName': REQUIRED(
          'S3BucketName is required: create() refuses a trail without it before any call (cloudtrail-provider.ts, in create(): the S3BucketName check)',
          /S3BucketName is required/
        ),
      },
    },
  ],
};

// --- AWS::BedrockAgentCore::Runtime -----------------------------------------------

const RUNTIME_ID = 'rt-1';

/**
 * `UpdateAgentRuntime` is a full replace built from the desired bag alone, and
 * a field it omits is CLEARED, which a CloudFormation A/B measured as parity
 * (agentcore-runtime-provider.ts, `update()`): it never reads the previous
 * side. `Tags` is the exception, diffed against the previous side by
 * TagResource / UntagResource (the `targets` below).
 */
const RUNTIME_FROM_NEXT = {
  keys: (key: string) => key !== 'Tags',
  reason:
    'UpdateAgentRuntime is a full replace from the desired bag, which clears an omitted field as CloudFormation does (CFn A/B, agentcore-runtime-provider.ts update())',
};

const MANAGED_VPC = {
  ManagedVpcResource: {
    VpcIdentifier: 'vpc-1',
    SubnetIds: ['subnet-1', 'subnet-2'],
    EndpointIpAddressType: 'IPV4',
    SecurityGroupIds: ['sg-1', 'sg-2'],
    Tags: { env: 'dev', team: 'a' },
    RoutingDomain: 'example.internal',
  },
};

const RUNTIME_TOP = {
  AgentRuntimeName: 'runtime',
  RoleArn: `arn:aws:iam::${ACCOUNT}:role/runtime`,
  Description: 'd',
  NetworkConfiguration: {
    NetworkMode: 'VPC',
    NetworkModeConfig: { SecurityGroups: ['sg-1', 'sg-2'], Subnets: ['subnet-1', 'subnet-2'] },
  },
  AuthorizerConfiguration: {
    CustomJWTAuthorizer: {
      DiscoveryUrl: 'https://idp.example/.well-known/openid-configuration',
      AllowedAudience: ['aud1', 'aud2'],
      AllowedClients: ['c1', 'c2'],
      AllowedScopes: ['s1', 's2'],
      CustomClaims: [
        {
          InboundTokenClaimName: 'role',
          InboundTokenClaimValueType: 'STRING',
          AuthorizingClaimMatchValue: {
            ClaimMatchOperator: 'EQUALS',
            ClaimMatchValue: { MatchValueString: 'admin' },
          },
        },
        {
          InboundTokenClaimName: 'groups',
          InboundTokenClaimValueType: 'STRING_ARRAY',
          AuthorizingClaimMatchValue: {
            ClaimMatchOperator: 'CONTAINS_ANY',
            ClaimMatchValue: { MatchValueStringList: ['g1', 'g2'] },
          },
        },
      ],
      AllowedWorkloadConfiguration: {
        HostingEnvironments: [{ Arn: `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/c` }],
        WorkloadIdentities: ['w1', 'w2'],
      },
      PrivateEndpoint: MANAGED_VPC,
      PrivateEndpointOverrides: [
        {
          Domain: 'idp.example',
          PrivateEndpoint: {
            SelfManagedLatticeResource: { ResourceConfigurationIdentifier: 'rcfg-1' },
          },
        },
      ],
    },
  },
  ProtocolConfiguration: 'HTTP',
  LifecycleConfiguration: { IdleRuntimeSessionTimeout: 900, MaxLifetime: 28800 },
  EnvironmentVariables: { A: '1', B: '2' },
  ClientToken: 'client-token-1',
  RequestHeaderConfiguration: {
    RequestHeaderAllowlist: [
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-A',
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-B',
    ],
  },
  FilesystemConfigurations: [
    { SessionStorage: { MountPath: '/mnt/session' } },
    {
      EfsAccessPoint: {
        AccessPointArn: `arn:aws:elasticfilesystem:us-east-1:${ACCOUNT}:access-point/fsap-1`,
        MountPath: '/mnt/efs',
      },
    },
  ],
  CapacityProviderConfiguration: {
    CapacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:capacity-provider/cp-1`,
  },
  PlatformVersion: '1.0',
  // A key -> value MAP in the CFn schema, as CDK synthesizes it.
  Tags: { k1: 'v1', k2: 'v2' },
};

const RUNTIME_REQUIRED: Record<string, Throw> = {
  'create:AgentRuntimeName': REQUIRED(
    'AgentRuntimeName is required: create() refuses a runtime without it before any call (agentcore-runtime-provider.ts:127-134)',
    /AgentRuntimeName is required/
  ),
  ...Object.fromEntries(
    ALL_DIRECTIONS.map((d) => [
      `${d}:RoleArn`,
      REQUIRED(
        'RoleArn is required: create() and update() refuse a runtime without it before any call (agentcore-runtime-provider.ts:136-139, 245-253)',
        /RoleArn is required/
      ),
    ])
  ),
};

const RUNTIME_CASE: TypeCase = {
  resourceType: 'AWS::BedrockAgentCore::Runtime',
  provider: () => new AgentCoreRuntimeProvider(),
  physicalId: RUNTIME_ID,
  createOnly: createOnlyOf('AWS::BedrockAgentCore::Runtime'),
  wholeFromNext: RUNTIME_FROM_NEXT,
  exempt: {},
  targets: [
    // UntagResource takes the removed keys only.
    { path: ['Tags', 'k1'], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 'k2'], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
  ],
  bags: [
    {
      name: 'container artifact, every other property',
      bag: {
        ...fresh(RUNTIME_TOP),
        AgentRuntimeArtifact: {
          ContainerConfiguration: {
            ContainerUri: `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/agent:latest`,
          },
        },
      },
      expectedRemovalThrows: RUNTIME_REQUIRED,
    },
    {
      name: 'code artifact',
      bag: {
        AgentRuntimeName: 'runtime',
        RoleArn: `arn:aws:iam::${ACCOUNT}:role/runtime`,
        AgentRuntimeArtifact: {
          CodeConfiguration: {
            Code: { S3: { Bucket: 'bucket', Prefix: 'agent.zip', VersionId: 'v1' } },
            Runtime: 'PYTHON_3_12',
            EntryPoint: ['main.py', 'handler'],
          },
        },
      },
      expectedRemovalThrows: RUNTIME_REQUIRED,
    },
    {
      // The PrivateEndpoint union's other member at each site.
      name: 'private endpoints swapped',
      bag: {
        AgentRuntimeName: 'runtime',
        RoleArn: `arn:aws:iam::${ACCOUNT}:role/runtime`,
        AuthorizerConfiguration: {
          CustomJWTAuthorizer: {
            DiscoveryUrl: 'https://idp.example/.well-known/openid-configuration',
            PrivateEndpoint: {
              SelfManagedLatticeResource: { ResourceConfigurationIdentifier: 'rcfg-1' },
            },
            PrivateEndpointOverrides: [{ Domain: 'idp.example', PrivateEndpoint: fresh(MANAGED_VPC) }],
          },
        },
        // The FilesystemConfiguration union's other two members.
        FilesystemConfigurations: [
          {
            S3FilesAccessPoint: {
              AccessPointArn: `arn:aws:s3:us-east-1:${ACCOUNT}:accesspoint/ap-1`,
              MountPath: '/mnt/s3',
            },
          },
          { CapacityProviderVolume: { VolumeName: 'vol-1', MountPath: '/mnt/vol' } },
        ],
      },
      expectedRemovalThrows: RUNTIME_REQUIRED,
    },
  ],
};

// --- AWS::BedrockAgentCore::Evaluator ---------------------------------------------

const EVALUATOR_ARN = `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:evaluator/ev-1`;
const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/**
 * `update()` sends the desired `EvaluatorConfig` whole, case-converted, and
 * never reads the previous side (agentcore-evaluator-provider.ts:303-308).
 */
const EVALUATOR_FROM_NEXT = {
  keys: (key: string) => key === 'EvaluatorConfig',
  reason:
    'update() sends the desired EvaluatorConfig whole and never reads the previous one (agentcore-evaluator-provider.ts:303-308)',
};

const BEDROCK_MODEL = {
  BedrockEvaluatorModelConfig: {
    ModelId: MODEL_ID,
    InferenceConfig: { MaxTokens: 512, Temperature: 0.5, TopP: 0.9, StopSequences: ['s1', 's2'] },
    // A free-form document: its keys go verbatim (agentcore-case-convert.ts).
    AdditionalModelRequestFields: { top_k: 5, thinking: 'off' },
  },
};
const RESPONSES_MODEL = {
  ResponsesEvaluatorModelConfig: {
    ModelId: 'gpt-x',
    MaxOutputTokens: 256,
    Temperature: 0.2,
    TopP: 0.8,
    Reasoning: { Effort: 'low' },
  },
};
const NUMERICAL = [
  { Value: 1, Label: 'poor', Definition: 'misses the point' },
  { Value: 5, Label: 'good', Definition: 'answers it' },
];
const CATEGORICAL = [
  { Label: 'pass', Definition: 'meets the bar' },
  { Label: 'fail', Definition: 'does not' },
];

const KEPT_ON_REMOVAL =
  'left in place on removal: UpdateEvaluator keeps an absent field, and CloudFormation kept a removed Description / KmsKeyArn too (issue #1160 A/B, agentcore-evaluator-provider.ts:298-314)';
const LEVEL_REQUIRED_UPDATE =
  'Level is required, so no deployable template removes it: create() refuses an evaluator without it (agentcore-evaluator-provider.ts:205-207)';

const EVALUATOR_REQUIRED: Record<string, Throw> = {
  'create:EvaluatorName': REQUIRED(
    'EvaluatorName is required: create() refuses an evaluator without it before any call (agentcore-evaluator-provider.ts:190-196)',
    /EvaluatorName is required/
  ),
  'create:EvaluatorConfig': REQUIRED(
    'EvaluatorConfig is required: create() refuses an evaluator without it before any call (agentcore-evaluator-provider.ts:198-204)',
    /EvaluatorConfig is required/
  ),
  'create:Level': REQUIRED(
    'Level is required: create() refuses an evaluator without it before any call (agentcore-evaluator-provider.ts:205-207)',
    /Level is required/
  ),
};

/** A bag of the type's required properties around one `EvaluatorConfig`. */
const evaluatorBag = (name: string, config: Record<string, unknown>): BagCase => ({
  name,
  bag: { EvaluatorName: 'evaluator', Level: 'TRACE', EvaluatorConfig: fresh(config) },
  variants: { Level: 'SESSION' },
  expectedSilent: { 'update-remove:Level': LEVEL_REQUIRED_UPDATE },
  expectedRemovalThrows: EVALUATOR_REQUIRED,
});

const EVALUATOR_CASE: TypeCase = {
  resourceType: 'AWS::BedrockAgentCore::Evaluator',
  provider: () => new AgentCoreEvaluatorProvider(),
  physicalId: EVALUATOR_ARN,
  createOnly: createOnlyOf('AWS::BedrockAgentCore::Evaluator'),
  wholeFromNext: EVALUATOR_FROM_NEXT,
  exempt: {},
  targets: [
    // UntagResource takes the removed keys only.
    { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
  ],
  bags: [
    {
      // go-to-k/cdkd#5432: the multi-dimensional rating scale, both
      // DimensionRatingScale members, with every top-level beside it.
      name: 'LLM-as-a-judge, multi-dimensional scale, every other property',
      bag: {
        EvaluatorName: 'evaluator',
        Description: 'd',
        Level: 'TRACE',
        KmsKeyArn: KMS,
        EvaluatorConfig: {
          LlmAsAJudge: {
            Instructions: 'judge it',
            RatingScale: {
              MultiDimensional: [
                {
                  DimensionName: 'accuracy',
                  DimensionInstruction: 'is it right',
                  DimensionRatingScale: { Numerical: fresh(NUMERICAL) },
                },
                {
                  DimensionName: 'tone',
                  DimensionInstruction: 'is it polite',
                  DimensionRatingScale: { Categorical: fresh(CATEGORICAL) },
                },
              ],
            },
            ModelConfig: fresh(BEDROCK_MODEL),
          },
        },
        Tags: TAG_LIST,
      },
      variants: { Level: 'SESSION' },
      expectedSilent: {
        'update-remove:Description': KEPT_ON_REMOVAL,
        'update-remove:KmsKeyArn': KEPT_ON_REMOVAL,
        'update-remove:Level': LEVEL_REQUIRED_UPDATE,
      },
      expectedRemovalThrows: { ...EVALUATOR_REQUIRED, ...TAG_THROWS(ALL_DIRECTIONS, 2) },
    },
    evaluatorBag('LLM-as-a-judge, numerical scale, responses model', {
      LlmAsAJudge: {
        Instructions: 'judge it',
        RatingScale: { Numerical: NUMERICAL },
        ModelConfig: RESPONSES_MODEL,
      },
    }),
    evaluatorBag('LLM-as-a-judge, categorical scale', {
      LlmAsAJudge: {
        Instructions: 'judge it',
        RatingScale: { Categorical: CATEGORICAL },
        ModelConfig: BEDROCK_MODEL,
      },
    }),
    evaluatorBag('code-based', {
      CodeBased: {
        LambdaConfig: {
          LambdaArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:judge`,
          LambdaTimeoutInSeconds: 60,
        },
      },
    }),
    evaluatorBag('derived, bedrock model', {
      Derived: { BaseEvaluatorId: 'Builtin.Helpfulness', ModelConfig: BEDROCK_MODEL },
    }),
    evaluatorBag('derived, responses model', {
      Derived: { BaseEvaluatorId: 'Builtin.Helpfulness', ModelConfig: RESPONSES_MODEL },
    }),
  ],
};

export const CASES_11: TypeCase[] = [TRAIL_CASE, RUNTIME_CASE, EVALUATOR_CASE];
