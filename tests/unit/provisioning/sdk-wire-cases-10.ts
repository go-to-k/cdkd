import { describe, expect, it } from 'vite-plus/test';
import {
  ACCOUNT,
  DECLARED_DEFAULT,
  TAG_THROWS,
  createOnlyOf,
  record,
  setOutputOverrides,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { EMRClusterProvider } from '../../../src/provisioning/providers/emr-cluster-provider.js';
import { EMRInstanceFleetConfigProvider } from '../../../src/provisioning/providers/emr-instance-fleet-config-provider.js';
import { EMRInstanceGroupConfigProvider } from '../../../src/provisioning/providers/emr-instance-group-config-provider.js';
import { RDSDBProxyProvider } from '../../../src/provisioning/providers/rds-dbproxy-provider.js';
import { RDSDBProxyEndpointProvider } from '../../../src/provisioning/providers/rds-dbproxy-endpoint-provider.js';
import { RDSDBProxyTargetGroupProvider } from '../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * The tenth batch of wire cases (#3723): the EMR cluster, instance fleet and
 * instance group (`@aws-sdk/client-emr`), and the RDS DB proxy, its endpoint
 * and its target group (`@aws-sdk/client-rds`). Every one builds its own
 * clients, so `sdk-wire-coverage-10.test.ts` mocks both packages.
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

// --- shared EMR blocks ------------------------------------------------------------

const EMR_CONFIGURATIONS = [
  {
    Classification: 'spark-defaults',
    ConfigurationProperties: { 'spark.a': '1', 'spark.b': '2' },
    Configurations: [{ Classification: 'inner', ConfigurationProperties: { c: '3' } }],
  },
];

const EBS_CONFIGURATION = {
  EbsOptimized: true,
  EbsBlockDeviceConfigs: [
    {
      VolumesPerInstance: 2,
      VolumeSpecification: { SizeInGB: 64, VolumeType: 'gp3', Iops: 3000, Throughput: 125 },
    },
  ],
};

const AUTO_SCALING_POLICY = {
  Constraints: { MinCapacity: 1, MaxCapacity: 4 },
  Rules: [
    {
      Name: 'scale-out',
      Description: 'd',
      Action: {
        Market: 'ON_DEMAND',
        SimpleScalingPolicyConfiguration: {
          AdjustmentType: 'CHANGE_IN_CAPACITY',
          ScalingAdjustment: 1,
          CoolDown: 300,
        },
      },
      Trigger: {
        CloudWatchAlarmDefinition: {
          ComparisonOperator: 'LESS_THAN',
          EvaluationPeriods: 1,
          MetricName: 'YARNMemoryAvailablePercentage',
          Namespace: 'AWS/ElasticMapReduce',
          Period: 300,
          Statistic: 'AVERAGE',
          Threshold: 15,
          Unit: 'PERCENT',
          Dimensions: [{ Key: 'JobFlowId', Value: '${emr.clusterId}' }],
        },
      },
    },
  ],
};

const INSTANCE_GROUP = (name: string): Bag =>
  fresh({
    Name: name,
    InstanceType: 'm5.xlarge',
    InstanceCount: 1,
    Market: 'SPOT',
    BidPrice: '0.1',
    CustomAmiId: 'ami-1',
    Configurations: EMR_CONFIGURATIONS,
    EbsConfiguration: EBS_CONFIGURATION,
    AutoScalingPolicy: AUTO_SCALING_POLICY,
  });

const CAPACITY_RESERVATION = {
  UsageStrategy: 'use-capacity-reservations-first',
  CapacityReservationPreference: 'open',
  CapacityReservationResourceGroupArn: `arn:aws:resource-groups:us-east-1:${ACCOUNT}:group/g`,
};

const INSTANCE_TYPE_CONFIGS = [
  {
    InstanceType: 'm5.xlarge',
    WeightedCapacity: 1,
    BidPrice: '0.1',
    BidPriceAsPercentageOfOnDemandPrice: 50,
    CustomAmiId: 'ami-1',
    Priority: 1,
    Configurations: EMR_CONFIGURATIONS,
    EbsConfiguration: EBS_CONFIGURATION,
  },
  { InstanceType: 'm5.2xlarge', WeightedCapacity: 2 },
];

const LAUNCH_SPECIFICATIONS = {
  OnDemandSpecification: {
    AllocationStrategy: 'lowest-price',
    CapacityReservationOptions: CAPACITY_RESERVATION,
  },
  SpotSpecification: {
    AllocationStrategy: 'capacity-optimized',
    BlockDurationMinutes: 60,
    TimeoutAction: 'SWITCH_TO_ON_DEMAND',
    TimeoutDurationMinutes: 10,
  },
};

const RESIZE_SPECIFICATIONS = {
  OnDemandResizeSpecification: {
    AllocationStrategy: 'lowest-price',
    TimeoutDurationMinutes: 20,
    CapacityReservationOptions: CAPACITY_RESERVATION,
  },
  SpotResizeSpecification: { AllocationStrategy: 'capacity-optimized', TimeoutDurationMinutes: 30 },
};

const INSTANCE_FLEET = (name: string): Bag =>
  fresh({
    Name: name,
    TargetOnDemandCapacity: 1,
    TargetSpotCapacity: 2,
    InstanceTypeConfigs: INSTANCE_TYPE_CONFIGS,
    LaunchSpecifications: LAUNCH_SPECIFICATIONS,
    ResizeSpecifications: RESIZE_SPECIFICATIONS,
  });

// --- AWS::EMR::Cluster ------------------------------------------------------------

const CLUSTER_ID = 'j-ABC123';

/** RunJobFlow answers the id, and the ready wait's first DescribeCluster reads WAITING. */
function armCluster(): void {
  setOutputOverrides({
    RunJobFlowCommand: () => ({ JobFlowId: CLUSTER_ID }),
    DescribeClusterCommand: () => ({ Cluster: { Id: CLUSTER_ID, Status: { State: 'WAITING' } } }),
  });
}

const INSTANCES_COMMON = {
  Ec2KeyName: 'key',
  Ec2SubnetId: 'subnet-1',
  HadoopVersion: '3.3',
  Placement: { AvailabilityZone: 'us-east-1a' },
  KeepJobFlowAliveWhenNoSteps: true,
  UnhealthyNodeReplacement: true,
  EmrManagedMasterSecurityGroup: 'sg-m',
  EmrManagedSlaveSecurityGroup: 'sg-s',
  ServiceAccessSecurityGroup: 'sg-sa',
  AdditionalMasterSecurityGroups: ['sg-am1', 'sg-am2'],
  AdditionalSlaveSecurityGroups: ['sg-as1', 'sg-as2'],
};

const CLUSTER_TOP: Bag = fresh({
  Name: 'cluster',
  ReleaseLabel: 'emr-7.0.0',
  ServiceRole: 'EMR_DefaultRole',
  JobFlowRole: 'EMR_EC2_DefaultRole',
  LogUri: 's3://bucket/logs/',
  LogEncryptionKmsKeyId: KMS,
  AdditionalInfo: '{"a":"b"}',
  AutoScalingRole: 'EMR_AutoScaling_DefaultRole',
  ScaleDownBehavior: 'TERMINATE_AT_TASK_COMPLETION',
  CustomAmiId: 'ami-1',
  OSReleaseLabel: '2.0.20240101.0',
  SecurityConfiguration: 'sc',
  EbsRootVolumeSize: 20,
  EbsRootVolumeIops: 3000,
  EbsRootVolumeThroughput: 125,
  StepConcurrencyLevel: 2,
  VisibleToAllUsers: true,
  Applications: [
    { Name: 'Spark', Version: '3.5', Args: ['a1'], AdditionalInfo: { k: 'v' } },
    { Name: 'Hive' },
  ],
  Configurations: EMR_CONFIGURATIONS,
  BootstrapActions: [
    { Name: 'boot', ScriptBootstrapAction: { Path: 's3://bucket/boot.sh', Args: ['x'] } },
  ],
  Steps: [
    {
      Name: 'step',
      ActionOnFailure: 'CONTINUE',
      HadoopJarStep: {
        Jar: 'command-runner.jar',
        MainClass: 'Main',
        Args: ['spark-submit'],
        StepProperties: [{ Key: 'sk', Value: 'sv' }],
      },
    },
  ],
  KerberosAttributes: {
    Realm: 'EC2.INTERNAL',
    KdcAdminPassword: 'kdc',
    CrossRealmTrustPrincipalPassword: 'cross',
    ADDomainJoinUser: 'joiner',
    ADDomainJoinPassword: 'join',
  },
  PlacementGroupConfigs: [{ InstanceRole: 'MASTER', PlacementStrategy: 'SPREAD' }],
  ManagedScalingPolicy: {
    ComputeLimits: {
      UnitType: 'Instances',
      MinimumCapacityUnits: 2,
      MaximumCapacityUnits: 10,
      MaximumOnDemandCapacityUnits: 5,
      MaximumCoreCapacityUnits: 3,
    },
    ScalingStrategy: 'ADVANCED',
    UtilizationPerformanceIndex: 50,
  },
  AutoTerminationPolicy: { IdleTimeout: 3600 },
  Tags: TAG_LIST,
});

/**
 * Every `Instances` member but `TerminationProtected` is refused in place by
 * `update()`: a running cluster's topology and networking cannot change
 * (emr-cluster-provider.ts:869-934). The schema lists no create-only path
 * under `Instances`, so the case marks each such member create-only itself,
 * leaving `TerminationProtected` the one updatable path; the refusal itself
 * is pinned in `describeEmrRdsExtras`.
 */
const INSTANCES_FIXED = [
  'AdditionalMasterSecurityGroups',
  'AdditionalSlaveSecurityGroups',
  'CoreInstanceFleet',
  'CoreInstanceGroup',
  'Ec2KeyName',
  'Ec2SubnetId',
  'Ec2SubnetIds',
  'EmrManagedMasterSecurityGroup',
  'EmrManagedSlaveSecurityGroup',
  'HadoopVersion',
  'KeepJobFlowAliveWhenNoSteps',
  'MasterInstanceFleet',
  'MasterInstanceGroup',
  'Placement',
  'ServiceAccessSecurityGroup',
  'TaskInstanceFleets',
  'TaskInstanceGroups',
  'UnhealthyNodeReplacement',
].map((member) => `Instances.${member}`);

const CLUSTER_CASE: TypeCase = {
  resourceType: 'AWS::EMR::Cluster',
  provider: () => new EMRClusterProvider({ pollIntervalMs: 0 }),
  physicalId: CLUSTER_ID,
  createOnly: new Set([...createOnlyOf('AWS::EMR::Cluster'), ...INSTANCES_FIXED]),
  arm: () => armCluster(),
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'RemoveTagsCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'RemoveTagsCommand', names: 'k2', notNames: 'k1' },
  ],
  bags: [
    {
      name: 'every top-level member, instance groups',
      bag: {
        ...CLUSTER_TOP,
        Instances: {
          ...INSTANCES_COMMON,
          MasterInstanceGroup: INSTANCE_GROUP('master'),
          CoreInstanceGroup: INSTANCE_GROUP('core'),
          TaskInstanceGroups: [INSTANCE_GROUP('task')],
        },
      },
      expectedSilent: {
        'update-remove:StepConcurrencyLevel':
          'left in place on removal: ModifyCluster keeps a setting it is not sent, and CloudFormation keeps it too (CFn A/B, emr-cluster-provider.ts:136-144)',
      },
      expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
    },
    {
      name: 'instance fleets',
      bag: {
        Name: 'cluster',
        Instances: {
          Ec2SubnetIds: ['subnet-1', 'subnet-2'],
          MasterInstanceFleet: INSTANCE_FLEET('master'),
          CoreInstanceFleet: INSTANCE_FLEET('core'),
          TaskInstanceFleets: [INSTANCE_FLEET('task')],
        },
      },
    },
    {
      // Alone in `Instances`: the update-vary probe's base drops the leaf's
      // parent, and beside any other member that is a refused topology
      // change, not the SetTerminationProtection under test.
      name: 'termination protection',
      bag: { Name: 'cluster', Instances: { TerminationProtected: true } },
    },
  ],
};

// --- AWS::EMR::InstanceFleetConfig ------------------------------------------------

const FLEET_ID = 'if-1';

/**
 * AddInstanceFleet answers the fleet id, and ListInstanceFleets answers that
 * fleet RUNNING with the capacities the last AddInstanceFleet /
 * ModifyInstanceFleet sent provisioned, so the capacity wait
 * (`waitForFleetReady`) settles on its first poll in either direction.
 */
function armFleet(): void {
  let provisioned = { onDemand: 0, spot: 0 };
  const sent = (fleet: unknown): Record<string, unknown> => {
    const f = (fleet ?? {}) as { TargetOnDemandCapacity?: number; TargetSpotCapacity?: number };
    provisioned = { onDemand: f.TargetOnDemandCapacity ?? 0, spot: f.TargetSpotCapacity ?? 0 };
    return {};
  };
  setOutputOverrides({
    AddInstanceFleetCommand: (input) => ({ ...sent(input['InstanceFleet']), InstanceFleetId: FLEET_ID }),
    ModifyInstanceFleetCommand: (input) => sent(input['InstanceFleet']),
    ListInstanceFleetsCommand: () => ({
      InstanceFleets: [
        {
          Id: FLEET_ID,
          Status: { State: 'RUNNING' },
          ProvisionedOnDemandCapacity: provisioned.onDemand,
          ProvisionedSpotCapacity: provisioned.spot,
        },
      ],
    }),
  });
}

const FLEET_CASE: TypeCase = {
  resourceType: 'AWS::EMR::InstanceFleetConfig',
  provider: () => new EMRInstanceFleetConfigProvider({ pollIntervalMs: 0 }),
  physicalId: FLEET_ID,
  createOnly: createOnlyOf('AWS::EMR::InstanceFleetConfig'),
  arm: () => armFleet(),
  exempt: {},
  targets: [
    // ModifyInstanceFleet re-sends the whole list: the removed type must not ride along.
    {
      path: ['InstanceTypeConfigs', 0],
      command: 'ModifyInstanceFleetCommand',
      names: '"m5.2xlarge"',
      notNames: '"m5.xlarge"',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: { ClusterId: CLUSTER_ID, InstanceFleetType: 'TASK', ...INSTANCE_FLEET('task') },
      expectedSilent: Object.fromEntries(
        ['InstanceTypeConfigs', 'ResizeSpecifications'].map((key) => [
          `update-remove:${key}`,
          'left in place on removal: ModifyInstanceFleet keeps a field it is not sent, and CloudFormation keeps it too (CFn A/B, emr-instance-fleet-config-provider.ts:93-106)',
        ])
      ),
      expectedRemovalThrows: {
        'create:ClusterId': REQUIRED(
          'ClusterId is required: create() refuses a fleet without its cluster before any call (emr-instance-fleet-config-provider.ts:373-380)',
          /is missing ClusterId/
        ),
      },
    },
  ],
};

// --- AWS::EMR::InstanceGroupConfig ------------------------------------------------

const GROUP_ID = 'ig-1';

/**
 * AddInstanceGroups answers the group id, and ListInstanceGroups answers that
 * group RUNNING with the count the last AddInstanceGroups /
 * ModifyInstanceGroups sent running, so the wait (`waitForGroupReady`)
 * settles on its first poll.
 */
function armGroup(): void {
  let running = 0;
  const sent = (groups: unknown): Record<string, unknown> => {
    running = ((groups as { InstanceCount?: number }[] | undefined)?.[0]?.InstanceCount ?? 0);
    return {};
  };
  setOutputOverrides({
    AddInstanceGroupsCommand: (input) => ({
      ...sent(input['InstanceGroups']),
      InstanceGroupIds: [GROUP_ID],
    }),
    ModifyInstanceGroupsCommand: (input) => sent(input['InstanceGroups']),
    ListInstanceGroupsCommand: () => ({
      InstanceGroups: [
        { Id: GROUP_ID, Status: { State: 'RUNNING' }, RunningInstanceCount: running },
      ],
    }),
  });
}

const GROUP_CASE: TypeCase = {
  resourceType: 'AWS::EMR::InstanceGroupConfig',
  provider: () => new EMRInstanceGroupConfigProvider({ pollIntervalMs: 0 }),
  physicalId: GROUP_ID,
  createOnly: createOnlyOf('AWS::EMR::InstanceGroupConfig'),
  arm: () => armGroup(),
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'every property',
      bag: { JobFlowId: CLUSTER_ID, InstanceRole: 'TASK', ...INSTANCE_GROUP('task') },
      expectedRemovalThrows: {
        'create:JobFlowId': REQUIRED(
          'JobFlowId is required: create() refuses a group without its cluster before any call (emr-instance-group-config-provider.ts:314-321)',
          /is missing JobFlowId/
        ),
      },
    },
  ],
};

// --- AWS::RDS::DBProxy ------------------------------------------------------------

const PROXY_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:db-proxy:prx-1`;

/** DescribeDBProxies answers the proxy available: the create wait returns on its first poll. */
function armProxy(): void {
  setOutputOverrides({
    DescribeDBProxiesCommand: () => ({
      DBProxies: [
        { Status: 'available', Endpoint: 'proxy.example', DBProxyArn: PROXY_ARN, VpcId: 'vpc-1' },
      ],
    }),
  });
}

const PROXY_REQUIRED = (key: string, line: number, says: RegExp): Throw =>
  REQUIRED(
    `${key} is required: create() refuses a proxy without it before any call (rds-dbproxy-provider.ts:${line})`,
    says
  );

/**
 * The RDS proxy family reads Tags with an optional Value
 * (`DBPROXY_TAG_OPTIONS`), so only a removed Key is refused before any call.
 */
const RDS_TAG_KEY_THROWS: Record<string, Throw> = Object.fromEntries(
  ALL_DIRECTIONS.flatMap((d) =>
    [0, 1].map((i) => [
      `${d}:Tags.${i}.Key`,
      REQUIRED(
        'a Tags entry without its Key is refused before any call (go-to-k/cdkd#3994; the Value is optional for the RDS proxy family)',
        /is not a list of tags with a non-empty string Key and an optional scalar Value/
      ),
    ])
  )
);

const PROXY_CASE: TypeCase = {
  resourceType: 'AWS::RDS::DBProxy',
  provider: () => new RDSDBProxyProvider(),
  physicalId: 'proxy',
  createOnly: createOnlyOf('AWS::RDS::DBProxy'),
  arm: () => armProxy(),
  exempt: {},
  targets: [
    {
      path: ['Tags', 0],
      command: 'RemoveTagsFromResourceCommand',
      names: 'k1',
      notNames: 'k2',
    },
    // ModifyDBProxy sends the whole desired Auth list (form-encoded: `:` is `%3A`).
    {
      path: ['Auth', 1],
      command: 'ModifyDBProxyCommand',
      names: 'secret%3As1',
      notNames: 'secret%3As2',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        DBProxyName: 'proxy',
        EngineFamily: 'POSTGRESQL',
        RoleArn: `arn:aws:iam::${ACCOUNT}:role/proxy`,
        VpcSubnetIds: ['subnet-1', 'subnet-2'],
        VpcSecurityGroupIds: ['sg-1', 'sg-2'],
        RequireTLS: true,
        IdleClientTimeout: 900,
        DebugLogging: true,
        Auth: [
          {
            AuthScheme: 'SECRETS',
            SecretArn: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s1`,
            IAMAuth: 'REQUIRED',
            ClientPasswordAuthType: 'POSTGRES_SCRAM_SHA_256',
            Description: 'd1',
          },
          {
            AuthScheme: 'SECRETS',
            SecretArn: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s2`,
          },
        ],
        Tags: TAG_LIST,
      },
      expectedSilent: {
        ...Object.fromEntries(
          ['DebugLogging', 'IdleClientTimeout', 'RequireTLS', 'VpcSecurityGroupIds'].map((key) => [
            `update-remove:${key}`,
            'left in place on removal: ModifyDBProxy keeps a setting it is not sent, and CloudFormation keeps it too (CFn A/B, rds-dbproxy-provider.ts:65-93)',
          ])
        ),
        'update-remove:RoleArn':
          'RoleArn is required, so no deployable template removes it: create() refuses a proxy without it (rds-dbproxy-provider.ts:249-256), and update() sends only a declared value (:451-461)',
      },
      expectedRemovalThrows: {
        'create:EngineFamily': PROXY_REQUIRED('EngineFamily', 233, /EngineFamily is required/),
        'create:Auth': PROXY_REQUIRED('Auth', 241, /Auth \(at least one entry\) is required/),
        'create:RoleArn': PROXY_REQUIRED('RoleArn', 249, /RoleArn is required/),
        'create:VpcSubnetIds': PROXY_REQUIRED(
          'VpcSubnetIds',
          257,
          /VpcSubnetIds \(at least one\) is required/
        ),
        'update-remove:Auth': REQUIRED(
          'an Auth removal is refused before any call: AWS requires Auth while DefaultAuthScheme is NONE or unset, and CloudFormation fails the same update (CFn A/B, rds-dbproxy-provider.ts:95-112, 380-399)',
          /Auth was removed from the template/
        ),
        ...RDS_TAG_KEY_THROWS,
      },
    },
  ],
};

// --- AWS::RDS::DBProxyEndpoint ----------------------------------------------------

/** DescribeDBProxyEndpoints answers the endpoint available: the create wait returns at once. */
function armEndpoint(): void {
  setOutputOverrides({
    DescribeDBProxyEndpointsCommand: () => ({
      DBProxyEndpoints: [
        {
          Status: 'available',
          Endpoint: 'ep.example',
          DBProxyEndpointArn: `arn:aws:rds:us-east-1:${ACCOUNT}:db-proxy-endpoint:prx-endpoint-1`,
          IsDefault: false,
          VpcId: 'vpc-1',
        },
      ],
    }),
  });
}

/**
 * The schema lists no create-only `TargetRole`, but `ModifyDBProxyEndpoint`
 * takes no such member, so `update()` refuses a change to it before any call
 * (rds-dbproxy-endpoint-provider.ts:336-357).
 */
const TARGET_ROLE_REFUSED = REQUIRED(
  'a TargetRole change is refused before any call: ModifyDBProxyEndpoint has no TargetRole member (rds-dbproxy-endpoint-provider.ts:336-357)',
  /TargetRole is immutable on AWS::RDS::DBProxyEndpoint/
);

const ENDPOINT_CASE: TypeCase = {
  resourceType: 'AWS::RDS::DBProxyEndpoint',
  provider: () => new RDSDBProxyEndpointProvider(),
  physicalId: 'ep',
  createOnly: createOnlyOf('AWS::RDS::DBProxyEndpoint'),
  arm: () => armEndpoint(),
  exempt: {},
  targets: [
    {
      path: ['Tags', 0],
      command: 'RemoveTagsFromResourceCommand',
      names: 'k1',
      notNames: 'k2',
    },
    {
      path: ['VpcSecurityGroupIds', 0],
      command: 'ModifyDBProxyEndpointCommand',
      names: '=sg-2',
      notNames: '=sg-1',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        DBProxyEndpointName: 'ep',
        DBProxyName: 'proxy',
        VpcSubnetIds: ['subnet-1', 'subnet-2'],
        VpcSecurityGroupIds: ['sg-1', 'sg-2'],
        TargetRole: 'READ_ONLY',
        Tags: TAG_LIST,
      },
      expectedSilent: {
        'update-vary:TargetRole': TARGET_ROLE_REFUSED.why,
      },
      expectedRemovalThrows: {
        'create:DBProxyName': REQUIRED(
          'DBProxyName is required: create() refuses an endpoint without its proxy before any call (rds-dbproxy-endpoint-provider.ts:173-180)',
          /DBProxyName is required/
        ),
        'create:VpcSubnetIds': REQUIRED(
          'VpcSubnetIds is required: create() refuses an endpoint without one before any call (rds-dbproxy-endpoint-provider.ts:184-191)',
          /VpcSubnetIds \(at least one\) is required/
        ),
        'update-add:TargetRole': TARGET_ROLE_REFUSED,
        'update-remove:TargetRole': TARGET_ROLE_REFUSED,
        ...RDS_TAG_KEY_THROWS,
      },
    },
  ],
};

// --- AWS::RDS::DBProxyTargetGroup -------------------------------------------------

const TARGET_GROUP_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:target-group:prx-tg-1`;

/** DescribeDBProxyTargetGroups answers the default group's ARN, which create records. */
function armTargetGroup(): void {
  setOutputOverrides({
    DescribeDBProxyTargetGroupsCommand: () => ({
      TargetGroups: [{ TargetGroupArn: TARGET_GROUP_ARN, TargetGroupName: 'default' }],
    }),
  });
}

const TARGET_GROUP_CASE: TypeCase = {
  resourceType: 'AWS::RDS::DBProxyTargetGroup',
  provider: () => new RDSDBProxyTargetGroupProvider(),
  physicalId: TARGET_GROUP_ARN,
  createOnly: createOnlyOf('AWS::RDS::DBProxyTargetGroup'),
  arm: () => armTargetGroup(),
  exempt: {},
  targets: [
    {
      path: ['Tags', 0],
      command: 'RemoveTagsFromResourceCommand',
      names: 'k1',
      notNames: 'k2',
    },
    {
      path: ['DBClusterIdentifiers', 0],
      command: 'DeregisterDBProxyTargetsCommand',
      names: 'cluster-a',
      notNames: 'cluster-b',
    },
    {
      path: ['DBInstanceIdentifiers', 1],
      command: 'DeregisterDBProxyTargetsCommand',
      names: 'inst-b',
      notNames: 'inst-a',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        DBProxyName: 'proxy',
        TargetGroupName: 'default',
        DBClusterIdentifiers: ['cluster-a', 'cluster-b'],
        DBInstanceIdentifiers: ['inst-a', 'inst-b'],
        ConnectionPoolConfigurationInfo: {
          ConnectionBorrowTimeout: 120,
          InitQuery: 'SET x=1',
          MaxConnectionsPercent: 90,
          MaxIdleConnectionsPercent: 50,
          SessionPinningFilters: ['EXCLUDE_VARIABLE_SETS'],
        },
        Tags: TAG_LIST,
      },
      expectedSilent: {
        // The declared value is the one cdkd sends for an absent name
        // (rds-dbproxy-targetgroup-provider.ts:256-261).
        'create:TargetGroupName': DECLARED_DEFAULT,
      },
      expectedRemovalThrows: {
        'create:DBProxyName': REQUIRED(
          'DBProxyName is required: create() refuses a target group without its proxy before any call (rds-dbproxy-targetgroup-provider.ts:248-255)',
          /DBProxyName is required/
        ),
        ...RDS_TAG_KEY_THROWS,
      },
    },
  ],
};

export const CASES_10: TypeCase[] = [
  CLUSTER_CASE,
  FLEET_CASE,
  GROUP_CASE,
  PROXY_CASE,
  ENDPOINT_CASE,
  TARGET_GROUP_CASE,
];

/** Direct-call checks the bag probes cannot make. */
export function describeEmrRdsExtras(): void {
  describe('AWS::EMR::Cluster update', () => {
    it('refuses an in-place Instances change and sends nothing', async () => {
      const bag = CLUSTER_CASE.bags[0]!.bag;
      const instances = bag['Instances'] as Bag;
      let thrown: unknown;
      armCluster();
      const outcome = await record(async () => {
        try {
          await new EMRClusterProvider({ pollIntervalMs: 0 }).update(
            'L',
            CLUSTER_ID,
            'AWS::EMR::Cluster',
            { ...bag, Instances: { ...instances, Ec2KeyName: 'other' } },
            bag
          );
        } catch (error) {
          thrown = error;
        }
      });
      expect(outcome).toEqual({ threw: false, wire: '' });
      expect(thrown).toBeInstanceOf(ResourceUpdateNotSupportedError);
    });
  });
}
