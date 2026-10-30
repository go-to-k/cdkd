import {
  ACCOUNT,
  TAG_THROWS,
  DECLARED_DEFAULT,
  createOnlyOf,
  paths,
  setOutputOverrides,
  type Bag,
  type TypeCase,
} from './sdk-wire-harness.js';
import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { CodeBuildProvider } from '../../../src/provisioning/providers/codebuild-provider.js';
import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

/**
 * The eighteenth batch of wire cases (#3723): the Kinesis stream
 * (`@aws-sdk/client-kinesis`) and the CodeBuild project
 * (`@aws-sdk/client-codebuild`), both of which build their own clients, run by
 * `sdk-wire-coverage-18.test.ts`. Their removal resets from go-to-k/cdkd#1160
 * (`MaxRecordSizeInKiB`; `EncryptionKey` / `Tags`) sit on the paths the bags
 * probe.
 */

/** A copy sharing no object with any other bag (see `sdk-wire-cases-14.ts`). */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const UPDATE = ['update-add', 'update-remove'];
const ALL = ['create', ...UPDATE];

/**
 * `update-remove:<key>.<path>` -> `why`, for every path strictly beneath each
 * top-level `key` of `bag`: what an update that sends the block whole from the
 * desired side makes of a member removed under a still-present block (its
 * `update-add` probe observes the delivery).
 */
const beneath = (bag: Bag, keys: string[], why: string): Record<string, string> =>
  Object.fromEntries(
    keys.flatMap((key) =>
      paths(bag[key], [key]).map((p) => [`update-remove:${p.join('.')}`, why])
    )
  );

// --- AWS::Kinesis::Stream ------------------------------------------------------

const KINESIS_SRC = 'kinesis-provider.ts';
const STREAM = 'stream';
const STREAM_ARN = `arn:aws:kinesis:us-east-1:${ACCOUNT}:stream/${STREAM}`;
const KMS_KEY = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k`;

/**
 * The live stream: ACTIVE on every poll (so each settle wait returns at once),
 * with its ARN, which UpdateStreamMode / UpdateMaxRecordSize /
 * UpdateStreamRecordDistributionStrategy address it by.
 */
function armStream(_physicalId: string, bag: Bag): void {
  const description = {
    StreamName: STREAM,
    StreamARN: STREAM_ARN,
    StreamStatus: 'ACTIVE',
    OpenShardCount: Number(bag['ShardCount'] ?? 1),
  };
  setOutputOverrides({
    DescribeStreamCommand: () => ({
      StreamDescription: { ...description, Shards: [], HasMoreShards: false },
    }),
    DescribeStreamSummaryCommand: () => ({ StreamDescriptionSummary: description }),
  });
}

const PROVISIONED_STREAM: Bag = {
  Name: STREAM,
  StreamModeDetails: { StreamMode: 'PROVISIONED' },
  ShardCount: 3,
  RetentionPeriodHours: 48,
  StreamEncryption: { EncryptionType: 'KMS', KeyId: KMS_KEY },
  DesiredShardLevelMetrics: ['IncomingBytes', 'OutgoingBytes'],
  MaxRecordSizeInKiB: 2048,
  Tags: [
    { Key: 'k1', Value: 'v1' },
    { Key: 'k2', Value: 'v2' },
  ],
};

const ON_DEMAND_STREAM: Bag = {
  Name: STREAM,
  StreamModeDetails: { StreamMode: 'ON_DEMAND' },
  RecordDistributionStrategy: 'AUTO',
};

const STREAM_CASE: TypeCase = {
  resourceType: 'AWS::Kinesis::Stream',
  provider: () => new KinesisStreamProvider(),
  physicalId: STREAM,
  createOnly: createOnlyOf('AWS::Kinesis::Stream'),
  arm: armStream,
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'RemoveTagsFromStreamCommand', names: '"k1"', notNames: '"k2"' },
    { path: ['Tags', 1], command: 'RemoveTagsFromStreamCommand', names: '"k2"', notNames: '"k1"' },
  ],
  bags: [
    {
      name: 'provisioned',
      bag: fresh(PROVISIONED_STREAM),
      // An absent StreamModeDetails (or StreamMode) reads as PROVISIONED on
      // create and on update (readConfigString's default), which is what
      // CloudFormation's schema documents for an unset mode.
      expectedSilent: Object.fromEntries(
        ALL.flatMap((d) => [
          [`${d}:StreamModeDetails`, DECLARED_DEFAULT],
          [`${d}:StreamModeDetails.StreamMode`, DECLARED_DEFAULT],
        ])
      ),
      expectedRemovalThrows: {
        ...TAG_THROWS(ALL, 2),
        'create:StreamEncryption.KeyId': {
          why: `a KMS StreamEncryption with no KeyId is refused before CreateStream (${KINESIS_SRC}, readEncryptionKeyId)`,
          says: /StreamEncryption selects KMS but KeyId is not a non-empty string/,
        },
      },
    },
    {
      name: 'on-demand',
      bag: fresh(ON_DEMAND_STREAM),
      expectedSilent: {},
      expectedRemovalThrows: {},
    },
  ],
};

// --- AWS::CodeBuild::Project ---------------------------------------------------

const CODEBUILD_SRC = 'codebuild-provider.ts';
const PROJECT = 'project';
const PROJECT_ARN = `arn:aws:codebuild:us-east-1:${ACCOUNT}:project/${PROJECT}`;
const ROLE = `arn:aws:iam::${ACCOUNT}:role/cb`;

/** CreateProject / UpdateProject answer the project's name and ARN, which create() returns. */
function armProject(): void {
  const project = () => ({ project: { name: PROJECT, arn: PROJECT_ARN } });
  setOutputOverrides({ CreateProjectCommand: project, UpdateProjectCommand: project });
}

const SOURCE = (id: string, location: string): Record<string, unknown> => ({
  Type: 'GITHUB',
  Location: location,
  BuildSpec: 'version: 0.2',
  GitCloneDepth: 1,
  InsecureSsl: true,
  ReportBuildStatus: true,
  SourceIdentifier: id,
  Auth: { Type: 'OAUTH', Resource: 'arn:aws:codeconnections:us-east-1:111111111111:connection/c' },
  GitSubmodulesConfig: { FetchSubmodules: true },
  BuildStatusConfig: { Context: 'ctx', TargetUrl: 'https://example.com/t' },
});
const ARTIFACTS = (id: string, location: string): Record<string, unknown> => ({
  Type: 'S3',
  Location: location,
  Path: 'p',
  Name: 'n',
  NamespaceType: 'BUILD_ID',
  Packaging: 'ZIP',
  OverrideArtifactName: true,
  EncryptionDisabled: true,
  ArtifactIdentifier: id,
});

const PROJECT_BAG: Bag = {
  Name: PROJECT,
  Description: 'd',
  Source: SOURCE('primary', 'https://github.com/o/r1'),
  SecondarySources: [SOURCE('second', 'https://github.com/o/r2')],
  SecondarySourceVersions: [{ SourceIdentifier: 'second', SourceVersion: 'main' }],
  SourceVersion: 'dev',
  Environment: {
    Type: 'LINUX_CONTAINER',
    ComputeType: 'BUILD_GENERAL1_MEDIUM',
    Image: 'aws/codebuild/standard:7.0',
    EnvironmentVariables: [
      { Name: 'A', Value: '1', Type: 'PARAMETER_STORE' },
      { Name: 'B', Value: '2' },
    ],
    PrivilegedMode: true,
    Certificate: 'b/cert.pem',
    ImagePullCredentialsType: 'SERVICE_ROLE',
    HostKernel: 'LINUX_KERNEL_6',
    Fleet: { FleetArn: `arn:aws:codebuild:us-east-1:${ACCOUNT}:fleet/f` },
    DockerServer: { ComputeType: 'BUILD_GENERAL1_LARGE', SecurityGroupIds: ['sg-d1', 'sg-d2'] },
    RegistryCredential: { Credential: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s`, CredentialProvider: 'SECRETS_MANAGER' },
  },
  ServiceRole: ROLE,
  Artifacts: ARTIFACTS('primary', 'b1'),
  SecondaryArtifacts: [ARTIFACTS('second', 'b2')],
  Tags: [
    { Key: 'k1', Value: 'v1' },
    { Key: 'k2', Value: 'v2' },
  ],
  TimeoutInMinutes: 30,
  QueuedTimeoutInMinutes: 60,
  EncryptionKey: KMS_KEY,
  Cache: { Type: 'S3', Location: 'b/cache', Modes: ['LOCAL_SOURCE_CACHE'], CacheNamespace: 'ns' },
  VpcConfig: { VpcId: 'vpc-1', Subnets: ['subnet-1', 'subnet-2'], SecurityGroupIds: ['sg-1', 'sg-2'] },
  LogsConfig: {
    CloudWatchLogs: { Status: 'ENABLED', GroupName: 'g', StreamName: 's' },
    S3Logs: { Status: 'ENABLED', Location: 'b/logs', EncryptionDisabled: true },
  },
  ConcurrentBuildLimit: 2,
  FileSystemLocations: [
    { Type: 'EFS', Location: 'fs-1.efs.us-east-1.amazonaws.com:/', MountPoint: '/mnt', Identifier: 'efs1', MountOptions: 'nfsvers=4.1' },
  ],
  BuildBatchConfig: {
    ServiceRole: ROLE,
    CombineArtifacts: true,
    TimeoutInMins: 90,
    BatchReportMode: 'REPORT_INDIVIDUAL_BUILDS',
    Restrictions: {
      MaximumBuildsAllowed: 5,
      ComputeTypesAllowed: ['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM'],
      FleetsAllowed: ['arn:aws:codebuild:us-east-1:123456789012:fleet/f1'],
    },
  },
  BadgeEnabled: true,
  AutoRetryLimit: 2,
  Visibility: 'PUBLIC_READ',
  ResourceAccessRole: ROLE,
};

const PROJECT_CASE: TypeCase = {
  resourceType: 'AWS::CodeBuild::Project',
  provider: () => new CodeBuildProvider(),
  physicalId: PROJECT,
  createOnly: createOnlyOf('AWS::CodeBuild::Project'),
  arm: armProject,
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'github',
      bag: fresh(PROJECT_BAG),
      expectedSilent: {
        // An absent Environment.Type is LINUX_CONTAINER (mapProperties'
        // readConfigString default), the type the declared value names.
        'create:Environment.Type': DECLARED_DEFAULT,
        'update-add:Environment.Type': DECLARED_DEFAULT,
        ...beneath(
          PROJECT_BAG,
          Object.keys(PROJECT_BAG).filter((k) => k !== 'Name'),
          `UpdateProject carries every block whole from the desired bag (${CODEBUILD_SRC}, mapProperties), so a member removed under a still-present block is absent from next alone; its update-add probe observes the delivery`
        ),
        ...Object.fromEntries(
          ['Source', 'Environment', 'Artifacts', 'ServiceRole'].map((k) => [
            `update-remove:${k}`,
            `${k} is required by the CloudFormation schema, so no deployable template removes it`,
          ])
        ),
        ...Object.fromEntries(
          [
            'Description',
            'TimeoutInMinutes',
            'QueuedTimeoutInMinutes',
            'ConcurrentBuildLimit',
            'AutoRetryLimit',
            'Cache',
            'LogsConfig',
            'SourceVersion',
          ].map((k) => [
            `update-remove:${k}`,
            `a removed ${k} sends nothing and UpdateProject merges, so the live value stays: what CloudFormation does (CFn A/B on go-to-k/cdkd#1160, ${CODEBUILD_SRC}:672-683, 710-720)`,
          ])
        ),
        ...Object.fromEntries(
          [
            'VpcConfig',
            'FileSystemLocations',
            'SecondarySources',
            'SecondaryArtifacts',
            'SecondarySourceVersions',
            'BadgeEnabled',
          ].map((k) => [
            `update-remove:${k}`,
            `a removed ${k} sends nothing and UpdateProject merges, so the live value stays: what CloudFormation does (CFn A/B on go-to-k/cdkd#5492, alone and beside a Description change: CFn's UpdateProject omitted it and the value was kept, ${CODEBUILD_SRC}:732-739)`,
          ])
        ),
      },
      expectedRemovalThrows: {},
    },
  ],
};

// --- AWS::ElastiCache::SubnetGroup / CacheCluster -------------------------------

const ELASTICACHE_SRC = 'elasticache-provider.ts';
const CLUSTER = 'cluster';
const CLUSTER_ARN = `arn:aws:elasticache:us-east-1:${ACCOUNT}:cluster:${CLUSTER}`;
const TOPIC_ARN = `arn:aws:sns:us-east-1:${ACCOUNT}:t`;

/** The provider with its poll sleep yielding a tick instead of ten seconds. */
const elastiCache = (): ResourceProvider =>
  Object.assign(new ElastiCacheProvider(), {
    sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
  }) as ResourceProvider;

/** The live subnet group's tags: what the previous deploy left there. */
function armSubnetGroup(_physicalId: string, bag: Bag): void {
  setOutputOverrides({
    ListTagsForResourceCommand: () => ({ TagList: (bag['Tags'] as unknown[] | undefined) ?? [] }),
  });
}

/**
 * The live cluster a bag describes, `available`, its nodes one per declared
 * node (in the declared zones). Stateful across the calls of one provider run:
 * a ModifyCacheCluster's CacheNodeType and CacheNodeIdsToRemove land on the
 * cluster at once, so the update's settle wait (which waits for the template
 * node type and for the removed nodes to leave, issues #5438 / #5441) reads
 * them on its first poll.
 */
function armCluster(_physicalId: string, bag: Bag): void {
  const zones = (bag['PreferredAvailabilityZones'] as string[] | undefined) ?? [];
  const count = bag['NumCacheNodes'] != null ? Number(bag['NumCacheNodes']) : 1;
  let nodeType = bag['CacheNodeType'] as string | undefined;
  let nodes = Array.from({ length: count }, (_, i) => ({
    CacheNodeId: String(i + 1).padStart(4, '0'),
    CustomerAvailabilityZone: zones[i] ?? 'us-east-1c',
    Endpoint: { Address: `n${i + 1}.cache.amazonaws.com`, Port: 6379 },
  }));
  setOutputOverrides({
    DescribeCacheClustersCommand: () => ({
      CacheClusters: [
        {
          CacheClusterId: CLUSTER,
          ARN: CLUSTER_ARN,
          CacheClusterStatus: 'available',
          CacheNodeType: nodeType,
          CacheNodes: nodes,
          PendingModifiedValues: {},
          ...(bag['TransitEncryptionEnabled'] !== undefined && {
            TransitEncryptionEnabled: bag['TransitEncryptionEnabled'],
          }),
        },
      ],
    }),
    ModifyCacheClusterCommand: (input) => {
      if (typeof input['CacheNodeType'] === 'string') nodeType = input['CacheNodeType'];
      const removed = (input['CacheNodeIdsToRemove'] as string[] | undefined) ?? [];
      nodes = nodes.filter((n) => !removed.includes(n.CacheNodeId));
      return {};
    },
  });
}

const SUBNET_IDS_REQUIRED =
  'SubnetIds is required by the CloudFormation schema, so no deployable template removes it';
const SUBNET_IDS_FROM_NEXT = `ModifyCacheSubnetGroup carries the desired SubnetIds whole and never reads the previous list (${ELASTICACHE_SRC}, updateSubnetGroup); its update-add probe observes the delivery`;

const SUBNET_GROUP_CASE: TypeCase = {
  resourceType: 'AWS::ElastiCache::SubnetGroup',
  provider: elastiCache,
  physicalId: 'sng',
  createOnly: createOnlyOf('AWS::ElastiCache::SubnetGroup'),
  arm: armSubnetGroup,
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'RemoveTagsFromResourceCommand', names: '=k1', notNames: '=k2' },
    { path: ['Tags', 1], command: 'RemoveTagsFromResourceCommand', names: '=k2', notNames: '=k1' },
  ],
  bags: [
    {
      name: 'cfn-description',
      bag: {
        CacheSubnetGroupName: 'sng',
        Description: 'd',
        SubnetIds: ['subnet-1', 'subnet-2'],
        Tags: [
          { Key: 'k1', Value: 'v1' },
          { Key: 'k2', Value: 'v2' },
        ],
      },
      expectedSilent: {
        'update-remove:SubnetIds': SUBNET_IDS_REQUIRED,
        'update-remove:SubnetIds.0': SUBNET_IDS_FROM_NEXT,
        'update-remove:SubnetIds.1': SUBNET_IDS_FROM_NEXT,
      },
      expectedRemovalThrows: {
        ...TAG_THROWS(ALL, 2),
      },
    },
    {
      name: 'api-description',
      bag: {
        CacheSubnetGroupName: 'sng',
        CacheSubnetGroupDescription: 'd',
        SubnetIds: ['subnet-1'],
      },
      expectedSilent: {
        'update-remove:SubnetIds': SUBNET_IDS_REQUIRED,
        'update-remove:SubnetIds.0': SUBNET_IDS_FROM_NEXT,
      },
      expectedRemovalThrows: {},
    },
  ],
};

const REDIS_CLUSTER: Bag = {
  ClusterName: CLUSTER,
  Engine: 'redis',
  CacheNodeType: 'cache.t4g.small',
  NumCacheNodes: 1,
  CacheSubnetGroupName: 'sng',
  VpcSecurityGroupIds: ['sg-1', 'sg-2'],
  Port: 6380,
  EngineVersion: '7.1',
  CacheParameterGroupName: 'pg',
  PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
  PreferredAvailabilityZone: 'us-east-1a',
  SnapshotRetentionLimit: 3,
  SnapshotWindow: '03:00-04:00',
  AutoMinorVersionUpgrade: true,
  NotificationTopicArn: TOPIC_ARN,
  SnapshotName: 'snap',
  LogDeliveryConfigurations: [
    {
      LogType: 'slow-log',
      DestinationType: 'cloudwatch-logs',
      DestinationDetails: { CloudWatchLogsDetails: { LogGroup: 'lg' } },
      LogFormat: 'json',
    },
    {
      LogType: 'engine-log',
      DestinationType: 'kinesis-firehose',
      DestinationDetails: { KinesisFirehoseDetails: { DeliveryStream: 'ds' } },
      LogFormat: 'text',
    },
  ],
  NetworkType: 'dual_stack',
  IpDiscovery: 'ipv6',
  TransitEncryptionEnabled: true,
  Tags: [
    { Key: 'k1', Value: 'v1' },
    { Key: 'k2', Value: 'v2' },
  ],
};

const MEMCACHED_CLUSTER: Bag = {
  ClusterName: CLUSTER,
  Engine: 'memcached',
  CacheNodeType: 'cache.t4g.micro',
  NumCacheNodes: 2,
  AZMode: 'cross-az',
  PreferredAvailabilityZones: ['us-east-1a', 'us-east-1b'],
};

/**
 * Every probe of a member ModifyCacheCluster has no field for: a change is
 * warned about and not applied, which is what CloudFormation's update does
 * (real runs, issue #5438; warnNotAppliedInPlace / warnTransitEncryptionNotApplied).
 */
const NOT_IN_MODIFY = (key: string): Record<string, string> =>
  Object.fromEntries(
    ['update-add', 'update-remove', 'update-vary'].map((d) => [
      `${d}:${key}`,
      `ModifyCacheCluster has no ${key} member (beside nodes to add, for AZMode): a change is warned about and not applied, as CloudFormation leaves the cluster unchanged too (measured, issue #5438; ${ELASTICACHE_SRC})`,
    ])
  );
const MODIFY_FROM_NEXT = (what: string): string =>
  `ModifyCacheCluster carries the desired ${what} whole from next (${ELASTICACHE_SRC}, updateCacheCluster); its update-add probe observes the delivery`;
const REQUIRED_KEPT: Record<string, string> = Object.fromEntries(
  ['CacheNodeType', 'NumCacheNodes'].map((k) => [
    `update-remove:${k}`,
    `${k} is required by the CloudFormation schema, so no deployable template removes it`,
  ])
);

const CLUSTER_CASE: TypeCase = {
  resourceType: 'AWS::ElastiCache::CacheCluster',
  provider: elastiCache,
  physicalId: CLUSTER,
  createOnly: createOnlyOf('AWS::ElastiCache::CacheCluster'),
  arm: armCluster,
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'RemoveTagsFromResourceCommand', names: '=k1', notNames: '=k2' },
    { path: ['Tags', 1], command: 'RemoveTagsFromResourceCommand', names: '=k2', notNames: '=k1' },
    // A dropped log type is sent as its disable entry (#5004's measured reset),
    // which the removal probes see only as a changed wire.
    {
      path: ['LogDeliveryConfigurations', 0],
      command: 'ModifyCacheClusterCommand',
      names: 'Enabled=false',
      notNames: 'Enabled=true',
    },
  ],
  bags: [
    {
      name: 'redis',
      bag: fresh(REDIS_CLUSTER),
      expectedSilent: {
        ...NOT_IN_MODIFY('PreferredAvailabilityZone'),
        ...NOT_IN_MODIFY('TransitEncryptionEnabled'),
        ...REQUIRED_KEPT,
        ...Object.fromEntries(
          ['SnapshotRetentionLimit', 'AutoMinorVersionUpgrade', 'NotificationTopicArn'].map((k) => [
            `update-remove:${k}`,
            `a removed ${k} sends nothing, so the live value stays: what CloudFormation does (CFn A/B on go-to-k/cdkd#5004, ${ELASTICACHE_SRC}, updateCacheCluster)`,
          ])
        ),
        ...Object.fromEntries(
          [
            'EngineVersion',
            'CacheParameterGroupName',
            'PreferredMaintenanceWindow',
            'SnapshotWindow',
            'IpDiscovery',
          ].map((k) => [
            `update-remove:${k}`,
            `a removed ${k} is deliberately not reset: its default is engine-, version- or AWS-assigned, with no reset value cdkd can name (${ELASTICACHE_SRC}, updateCacheCluster's #1160 note); CFn unmeasured`,
          ])
        ),
        'update-remove:VpcSecurityGroupIds': `a removed (or empty) VpcSecurityGroupIds sends no SecurityGroupIds, so the live groups stay: the same outcome CloudFormation reaches, the group is kept (CFn A/B on go-to-k/cdkd#5491: removal sent no securityGroupIds, [] sent securityGroupIds: [], and in both the cluster kept its group; ${ELASTICACHE_SRC}, updateCacheCluster)`,
        ...beneath(REDIS_CLUSTER, ['VpcSecurityGroupIds'], MODIFY_FROM_NEXT('SecurityGroupIds')),
        // Every member of a still-present entry but its LogType: the entry is
        // sent from next, and prev only names the log types to disable.
        ...Object.fromEntries(
          Object.keys(beneath(REDIS_CLUSTER, ['LogDeliveryConfigurations'], ''))
            .filter((l) => !/^update-remove:LogDeliveryConfigurations\.\d+(\.LogType)?$/.test(l))
            .map((l) => [l, MODIFY_FROM_NEXT('LogDeliveryConfigurations entry')])
        ),
      },
      expectedRemovalThrows: {
        ...TAG_THROWS(ALL, 2),
      },
    },
    {
      name: 'memcached',
      bag: fresh(MEMCACHED_CLUSTER),
      expectedSilent: {
        ...NOT_IN_MODIFY('AZMode'),
        ...REQUIRED_KEPT,
        ...Object.fromEntries(
          ['PreferredAvailabilityZones', 'PreferredAvailabilityZones.0', 'PreferredAvailabilityZones.1'].map(
            (l) => [
              `update-remove:${l}`,
              `a zone list that shrinks (or goes) with every node kept adds no node, so ModifyCacheCluster carries no NewAvailabilityZones: CloudFormation sent none for [1c, 1b] -> absent or [1a, 1b, 1c] -> [1a, 1c] (measured, issue #5438; ${ELASTICACHE_SRC}, planNodeChanges)`,
            ]
          )
        ),
      },
      expectedRemovalThrows: {},
    },
  ],
};

export const CASES_18: TypeCase[] = [
  STREAM_CASE,
  PROJECT_CASE,
  SUBNET_GROUP_CASE,
  CLUSTER_CASE,
];
