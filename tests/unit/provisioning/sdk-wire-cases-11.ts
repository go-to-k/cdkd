import {
  ACCOUNT,
  TAG_THROWS,
  createOnlyOf,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { AgentCoreRuntimeProvider } from '../../../src/provisioning/providers/agentcore-runtime-provider.js';

/**
 * The eleventh batch of wire cases (#3723): the CloudTrail trail
 * (`@aws-sdk/client-cloudtrail`, whose provider builds its own clients, a
 * create client among them) and the AgentCore runtime
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
  // AdvancedEventSelectors / AggregationConfigurations are not handled, so no
  // bag carries them; the nested-path check reads carried top-levels only.
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
        // (cloudtrail-provider.ts:575-597).
        IsMultiRegionTrail: false,
        IncludeGlobalServiceEvents: true,
        EnableLogFileValidation: true,
        // `false`: an absent IsLogging starts logging on create
        // (cloudtrail-provider.ts:431-440), so only a stopped trail differs.
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
          'an absent desired IsLogging leaves logging as it is: IsLogging is CFn-required, so only a state replay can lack it, and that must not start a stopped trail (cloudtrail-provider.ts:802-811)',
        ...Object.fromEntries(
          ['CloudWatchLogsLogGroupArn', 'CloudWatchLogsRoleArn'].map((key) => [
            `update-remove:${key}`,
            'left in place on removal: UpdateTrail keeps an absent field, and CloudFormation kept the CloudWatch Logs pair too (CFn A/B, cloudtrail-provider.ts:548-551, 600-627)',
          ])
        ),
        'update-remove:IsOrganizationTrail':
          'left in place on removal: CloudFormation\'s reset of IsOrganizationTrail is unmeasurable without an Organizations management account, so it is passed through rather than guessed (cloudtrail-provider.ts:551-558)',
        'update-remove:S3BucketName':
          'S3BucketName is required, so no deployable template removes it: create() refuses a trail without it (cloudtrail-provider.ts:342-349)',
      },
      expectedRemovalThrows: {
        'create:S3BucketName': REQUIRED(
          'S3BucketName is required: create() refuses a trail without it before any call (cloudtrail-provider.ts:342-349)',
          /S3BucketName is required/
        ),
        ...TAG_THROWS(ALL_DIRECTIONS, 2),
      },
    },
    {
      // Multi-region, where a removed IncludeGlobalServiceEvents is passed
      // through instead of reset (cloudtrail-provider.ts:575-597).
      name: 'multi-region',
      bag: {
        TrailName: 'trail',
        S3BucketName: 'bucket',
        IsMultiRegionTrail: true,
        IncludeGlobalServiceEvents: true,
      },
      expectedSilent: {
        'update-remove:IncludeGlobalServiceEvents':
          'passed through on removal while the trail stays multi-region: AWS refuses a multi-region trail that excludes global service events, so the reset applies only to a known single-region trail (cloudtrail-provider.ts:575-597)',
        'update-remove:S3BucketName':
          'S3BucketName is required, so no deployable template removes it: create() refuses a trail without it (cloudtrail-provider.ts:342-349)',
      },
      expectedRemovalThrows: {
        'create:S3BucketName': REQUIRED(
          'S3BucketName is required: create() refuses a trail without it before any call (cloudtrail-provider.ts:342-349)',
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
 * (agentcore-runtime-provider.ts:255-311): `update()` never reads the
 * previous side.
 */
const RUNTIME_FROM_NEXT = {
  keys: () => true,
  reason:
    'UpdateAgentRuntime is a full replace from the desired bag, which clears an omitted field as CloudFormation does (CFn A/B, agentcore-runtime-provider.ts:255-311)',
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
  targets: [],
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
      },
      expectedRemovalThrows: RUNTIME_REQUIRED,
    },
  ],
};

export const CASES_11: TypeCase[] = [TRAIL_CASE, RUNTIME_CASE];
