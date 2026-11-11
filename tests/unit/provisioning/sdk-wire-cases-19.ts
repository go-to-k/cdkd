import { describe, expect, it } from 'vite-plus/test';
import {
  ACCOUNT,
  createOnlyOf,
  record,
  setOutputOverrides,
  type Outcome,
  TAG_THROWS,
  type Bag,
  type TypeCase,
} from './sdk-wire-harness.js';
import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

/**
 * The nineteenth batch of wire cases (#3723), run by
 * `sdk-wire-coverage-19.test.ts`: `RDSProvider`, every type it handles
 * (`AWS::RDS::DBSubnetGroup`, `AWS::RDS::DBCluster`, `AWS::RDS::DBInstance`).
 */

// The provider file and its companion directory (`rds/`), which holds the bodies.
const SRC = 'rds-provider.ts + rds/';
const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

/**
 * A copy sharing no object with any other bag: the harness's `without` is a
 * `structuredClone`, which KEEPS shared references, so a block reused in two
 * places would lose a path in both at once.
 */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];
const TAG_TARGETS = [0, 1].map((i) => ({
  path: ['Tags', i],
  command: 'RemoveTagsFromResourceCommand',
  names: `k${i + 1}`,
  notNames: `k${2 - i}`,
}));

const KMS = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k1`;
const SECRET_KMS = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k2`;
const MONITORING_ROLE = `arn:aws:iam::${ACCOUNT}:role/rds-monitoring`;
const SUBNET_GROUP = 'subnets';
const SUBNET_GROUP_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:subgrp:${SUBNET_GROUP}`;
const CLUSTER_ID = 'cluster-1';
const CLUSTER_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:${CLUSTER_ID}`;
const INSTANCE_ID = 'instance-1';
const INSTANCE_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:db:${INSTANCE_ID}`;
/** go-to-k/cdkd#5640: a read replica's source, as a CDK template names it (by ARN). */
const INSTANCE_ID_SOURCE = 'source-1';
const SOURCE_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:db:${INSTANCE_ID_SOURCE}`;
const DEFAULT_SG = 'sg-default';

/** Two associations, each its own role for its own feature (go-to-k/cdkd#5639 / #5640). */
const ROLES = [
  { RoleArn: `arn:aws:iam::${ACCOUNT}:role/role-a`, FeatureName: 's3Import' },
  { RoleArn: `arn:aws:iam::${ACCOUNT}:role/role-b`, FeatureName: 's3Export' },
];
const ROLE_TARGETS = (command: string) =>
  [0, 1].map((i) => ({
    path: ['AssociatedRoles', i],
    command,
    names: `role-${'ab'[i]}`,
    notNames: `role-${'ba'[i]}`,
  }));

/**
 * A malformed entry is refused before any call: the gap between the record and
 * the template is what gets DETACHED, so it never reads as empty. A DB
 * instance's entry also needs its FeatureName (schema-required, and
 * AddRoleToDBInstance takes none without it).
 */
const ROLES_REFUSED = (members: readonly string[], says: RegExp) =>
  Object.fromEntries(
    ALL_DIRECTIONS.flatMap((direction) =>
      [0, 1].flatMap((i) =>
        members.map((member) => [
          `${direction}:AssociatedRoles.${i}.${member}`,
          {
            says,
            why: `a malformed AssociatedRoles never reads as empty, or an update would detach every role (desiredAssociatedRoles in ${SRC})`,
          },
        ])
      )
    )
  );

/** The roles a bag declares, as the live cluster or instance starts out holding them. */
function liveRoles(bag: Bag): Bag[] {
  const declared = bag['AssociatedRoles'];
  return Array.isArray(declared)
    ? (declared as Bag[]).map((role) => ({ ...role, Status: 'ACTIVE' }))
    : [];
}

/** The live roles after an Add* / Remove* call, applied at once (the settle wait reads it). */
function roleCallOverrides(
  add: string,
  remove: string,
  roles: { current: Bag[] }
): Record<string, (input: Record<string, unknown>) => unknown> {
  return {
    [add]: (input) => {
      roles.current.push({ RoleArn: input['RoleArn'], FeatureName: input['FeatureName'], Status: 'ACTIVE' });
      return {};
    },
    [remove]: (input) => {
      roles.current = roles.current.filter(
        (role) => !(role['RoleArn'] === input['RoleArn'] && role['FeatureName'] === input['FeatureName'])
      );
      return {};
    },
  };
}

/** A Modify* call that only sends what `next` declares: a removal sends nothing. */
const KEPT = (key: string): string =>
  `left in place on removal: Modify* treats an absent member as "no change", and real CloudFormation A/Bs (#5004, #1160) measured a removed ${key} KEPT (${SRC})`;

/** A removed password is never sent: RDS keeps the live password when none is supplied. */
const PASSWORD_REMOVED = `a removed MasterUserPassword sends nothing, and any supplied one would reset the credentials (go-to-k/cdkd#5153; ${SRC})`;

/**
 * Every `Engine` update probe here has one side without an `Engine`: the
 * reduced bag on update-add / update-remove, and the `base` (the bag without
 * the leaf) both update-vary sides share as `prev`. An `Engine` absent on
 * either side is never a replacement (go-to-k/cdkd#5467's deliberate
 * difference, `replacement-rules.ts` `enginePair`), so these probes reach
 * `update()`, which sends no `Engine` for them. A change with BOTH sides
 * declared is pinned in `describeRdsExtras`.
 */
const CLUSTER_ENGINE = `ModifyDBCluster has no Engine member; a change declared on both sides replaces unless it is aurora to aurora-mysql (go-to-k/cdkd#5467), and one with a side absent, as every update probe here has, is in place and sends nothing (${SRC}; describeRdsExtras pins both-sides changes)`;
const INSTANCE_ENGINE = `update() sends Engine only for a change CloudFormation's handler applies in place with BOTH sides declared (go-to-k/cdkd#5467, ${SRC}); a side absent, as every update probe here has, is never a replacement nor an Engine send, the deliberate difference replacement-rules.ts names (the handler would compare the LIVE engine, which a template diff cannot see; describeRdsExtras pins both-sides changes)`;

// --- AWS::RDS::DBSubnetGroup ---------------------------------------------------

/** DescribeDBSubnetGroups answers the group's ARN (the tag diff's target) and its VPC. */
function armSubnetGroup(): void {
  setOutputOverrides({
    DescribeDBSubnetGroupsCommand: () => ({
      DBSubnetGroups: [{ DBSubnetGroupArn: SUBNET_GROUP_ARN, VpcId: 'vpc-1' }],
    }),
  });
}

const SUBNET_GROUP_CASE: TypeCase = {
  resourceType: 'AWS::RDS::DBSubnetGroup',
  provider: () => new RDSProvider(),
  physicalId: SUBNET_GROUP,
  createOnly: createOnlyOf('AWS::RDS::DBSubnetGroup'),
  arm: () => armSubnetGroup(),
  exempt: {},
  targets: [
    ...TAG_TARGETS,
    // ModifyDBSubnetGroup sends the whole desired list (form-encoded).
    {
      path: ['SubnetIds', 0],
      command: 'ModifyDBSubnetGroupCommand',
      names: '=subnet-2',
      notNames: '=subnet-1',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        DBSubnetGroupName: SUBNET_GROUP,
        DBSubnetGroupDescription: 'rds subnets',
        SubnetIds: ['subnet-1', 'subnet-2'],
        Tags: fresh(TAGS),
      },
      expectedSilent: {
        ...Object.fromEntries(
          ['DBSubnetGroupDescription', 'SubnetIds'].map((key) => [
            `update-remove:${key}`,
            `${key} is required by the registry schema (top-level \`required\`), so no deployable template removes it; update() sends only a declared value (${SRC})`,
          ])
        ),
        ...Object.fromEntries(
          [0, 1].map((i) => [
            `update-remove:SubnetIds.${i}`,
            `ModifyDBSubnetGroup sends the WHOLE desired list from next, never reading prev, so an element removal is delivered by next alone (update-add observes it; ${SRC})`,
          ])
        ),
      },
      expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
    },
  ],
};

// --- AWS::RDS::DBCluster -------------------------------------------------------

/** The log types a bag declares, as the live cluster or instance starts out exporting. */
function liveLogs(bag: Bag): string[] {
  const declared = bag['EnableCloudwatchLogsExports'];
  return Array.isArray(declared) ? (declared as string[]).slice() : [];
}

/**
 * The live log types after a Modify* applies its `CloudwatchLogsExportConfiguration`
 * at once, so the provider's wait for it settles on its first poll
 * (go-to-k/cdkd#5639 / #5640).
 */
function applyLogDelta(live: string[], input: Record<string, unknown>): string[] {
  const config = input['CloudwatchLogsExportConfiguration'] as
    | { EnableLogTypes?: string[]; DisableLogTypes?: string[] }
    | undefined;
  if (config === undefined) return live;
  const out = live.filter((type) => !(config.DisableLogTypes ?? []).includes(type));
  for (const type of config.EnableLogTypes ?? []) if (!out.includes(type)) out.push(type);
  return out;
}

/**
 * DescribeDBClusters answers the live cluster: `available`, with the port and
 * security groups the last ModifyDBCluster sent (the bag's own before any),
 * all groups `active`, its subnet group and ARN, and no member instances. So
 * the create wait, `waitForClusterPortApplied` and
 * `waitForSecurityGroupsApplied` all settle on their first poll, and the
 * member waits have nothing to poll. DescribeDBSubnetGroups / EC2's
 * DescribeSecurityGroups answer the VPC's default group a removed
 * `VpcSecurityGroupIds` falls back to.
 */
function armCluster(_physicalId: string, bag: Bag): void {
  let groups = (bag['VpcSecurityGroupIds'] as string[] | undefined) ?? [];
  let port = bag['Port'] as number | undefined;
  let logs = liveLogs(bag);
  let httpEndpoint = bag['EnableHttpEndpoint'] === true;
  let forwarding = bag['EnableLocalWriteForwarding'] === true;
  // go-to-k/cdkd#5639: a Multi-AZ DB cluster's class and storage, as the last
  // ModifyDBCluster sent them (applied at once), so the wait settles.
  let instanceClass = bag['DBClusterInstanceClass'] as string | undefined;
  let allocatedStorage = bag['AllocatedStorage'] as number | undefined;
  let iops = bag['Iops'] as number | undefined;
  const roles = { current: liveRoles(bag) };
  let detached = false;
  setOutputOverrides({
    ...roleCallOverrides('AddRoleToDBClusterCommand', 'RemoveRoleFromDBClusterCommand', roles),
    // The create wait reads back the write forwarding the create sent.
    CreateDBClusterCommand: (input) => {
      forwarding = input['EnableLocalWriteForwarding'] === true;
      return { DBCluster: { DBClusterIdentifier: CLUSTER_ID } };
    },
    // go-to-k/cdkd#5639: either restore answers like a create, after the read
    // of its snapshot or of its source's automated backups.
    RestoreDBClusterToPointInTimeCommand: () => ({ DBCluster: { DBClusterIdentifier: CLUSTER_ID } }),
    RestoreDBClusterFromSnapshotCommand: () => ({ DBCluster: { DBClusterIdentifier: CLUSTER_ID } }),
    DescribeDBClusterSnapshotsCommand: () => ({ DBClusterSnapshots: [{ EngineVersion: '16.4' }] }),
    DescribeDBClusterAutomatedBackupsCommand: () => ({
      DBClusterAutomatedBackups: [{ Status: 'active', StorageEncrypted: false }],
    }),
    EnableHttpEndpointCommand: () => {
      httpEndpoint = true;
      return {};
    },
    DisableHttpEndpointCommand: () => {
      httpEndpoint = false;
      return {};
    },
    ModifyDBClusterCommand: (input) => {
      const sentGroups = input['VpcSecurityGroupIds'] as string[] | undefined;
      if (sentGroups !== undefined) groups = sentGroups;
      const sentPort = input['Port'] as number | undefined;
      if (sentPort !== undefined) port = sentPort;
      logs = applyLogDelta(logs, input);
      const sentForwarding = input['EnableLocalWriteForwarding'] as boolean | undefined;
      if (sentForwarding !== undefined) forwarding = sentForwarding;
      instanceClass = (input['DBClusterInstanceClass'] as string | undefined) ?? instanceClass;
      allocatedStorage = (input['AllocatedStorage'] as number | undefined) ?? allocatedStorage;
      iops = (input['Iops'] as number | undefined) ?? iops;
      return {};
    },
    DescribeDBClustersCommand: () => ({
      DBClusters: [
        {
          DBClusterIdentifier: CLUSTER_ID,
          DBClusterArn: CLUSTER_ARN,
          Status: 'available',
          DBSubnetGroup: SUBNET_GROUP,
          DBClusterMembers: [],
          ...(port !== undefined && { Port: port }),
          VpcSecurityGroups: groups.map((id) => ({ VpcSecurityGroupId: id, Status: 'active' })),
          EnabledCloudwatchLogsExports: logs,
          HttpEndpointEnabled: httpEndpoint,
          LocalWriteForwardingStatus: forwarding ? 'enabled' : 'disabled',
          AssociatedRoles: roles.current,
          ...(instanceClass !== undefined && { DBClusterInstanceClass: instanceClass }),
          ...(allocatedStorage !== undefined && { AllocatedStorage: allocatedStorage }),
          ...(iops !== undefined && { Iops: iops }),
        },
      ],
    }),
    DescribeDBSubnetGroupsCommand: () => ({
      DBSubnetGroups: [{ DBSubnetGroupArn: SUBNET_GROUP_ARN, VpcId: 'vpc-1' }],
    }),
    DescribeSecurityGroupsCommand: () => ({ SecurityGroups: [{ GroupId: DEFAULT_SG }] }),
    // go-to-k/cdkd#5984: the writer RDS creates for an express cluster, which
    // the create waits on.
    DescribeDBInstancesCommand: () => ({
      DBInstances: [
        {
          DBInstanceIdentifier: `${CLUSTER_ID}-instance-1`,
          DBClusterIdentifier: CLUSTER_ID,
          DBInstanceStatus: 'available',
          DbiResourceId: 'db-WRITER1',
        },
      ],
    }),
    // go-to-k/cdkd#5639: a removal's detach takes it out of the global cluster.
    RemoveFromGlobalClusterCommand: () => {
      detached = true;
      return {};
    },
    // The bag's global cluster holds the cluster, as the last deploy left it.
    DescribeGlobalClustersCommand: () => ({
      GlobalClusters:
        typeof bag['GlobalClusterIdentifier'] === 'string' && !detached
          ? [
              {
                GlobalClusterIdentifier: bag['GlobalClusterIdentifier'],
                GlobalClusterMembers: [{ DBClusterArn: CLUSTER_ARN }],
              },
            ]
          : [],
    }),
  });
}

/**
 * go-to-k/cdkd#5639: joining another global cluster is refused before any
 * write; a removal detaches in place and reaches the wire.
 */
const GLOBAL_CLUSTER_REFUSED = {
  says: /GlobalClusterIdentifier cannot be added or changed on an existing DB cluster/,
  why: `ModifyDBCluster has no GlobalClusterIdentifier member, and CloudFormation's update handler fails an add or change as immutable (ImmutabilityHelper.isGlobalClusterMutable, read from the handler source), so one the live cluster does not show is refused before any write (${SRC} planGlobalClusterUpdate)`,
};

/** `MasterUserSecret.SecretArn` is the secret RDS creates, never a write input. */
const SECRET_ARN_READ_ONLY = `read-only in the registry schema (/properties/MasterUserSecret/SecretArn): the secret RDS creates. Create and modify take only MasterUserSecretKmsKeyId, so neither reads it (${SRC})`;

const CLUSTER_ENGINE_SILENT = Object.fromEntries(
  ['update-add', 'update-remove', 'update-vary'].map((d) => [`${d}:Engine`, CLUSTER_ENGINE])
);

/** Measured against CloudFormation (go-to-k/cdkd#5467): a changed MasterUsername stays in place. */
const CLUSTER_MASTER_USERNAME_SILENT = Object.fromEntries(
  ['update-add', 'update-remove', 'update-vary'].map((d) => [
    `${d}:MasterUsername`,
    `ModifyDBCluster has no MasterUsername member, and CloudFormation completes a changed one in place keeping the live user (measured us-east-1, 2026-10-28, go-to-k/cdkd#5467; ${SRC})`,
  ])
);

/**
 * go-to-k/cdkd#2762: a removed backfill member sends nothing, and CloudFormation
 * keeps each (measured us-east-1, 2026-11-01; its handler sends `null` for a
 * removed key and `ModelAdapter.setDefaults` fills none of these).
 */
const CLUSTER_BACKFILL_KEPT = Object.fromEntries(
  [
    'DBClusterParameterGroupName',
    'PreferredBackupWindow',
    'PreferredMaintenanceWindow',
    'CopyTagsToSnapshot',
    'StorageType',
  ].map((key) => [
    `update-remove:${key}`,
    `left in place on removal: ModifyDBCluster treats an absent member as "no change", and a real CloudFormation A/B (go-to-k/cdkd#2762) measured a removed ${key} KEPT (${SRC} clusterModifyBackfillMembers)`,
  ])
);

/**
 * go-to-k/cdkd#5639: a removed scalar sends nothing. CloudFormation's update
 * translation (`Translator.modifyDbClusterRequest`) sends the desired value,
 * `null` (unsent) for a removed key, and `ModelAdapter.setDefaults` fills none
 * of these, so the live value is kept (read from the handler source, not
 * measured). A removed Performance Insights member beside unchanged siblings
 * changes nothing the trio sends.
 */
const CLUSTER_SCALARS_KEPT = Object.fromEntries(
  [
    'AutoMinorVersionUpgrade',
    'NetworkType',
    'PerformanceInsightsEnabled',
    'PerformanceInsightsKmsKeyId',
    'PerformanceInsightsRetentionPeriod',
  ].map((key) => [
    `update-remove:${key}`,
    `left in place on removal: ModifyDBCluster treats an absent member as "no change", and CloudFormation's handler sends null for a removed ${key} with no default filled (${SRC} clusterModifyScalarMembers)`,
  ])
);

/**
 * go-to-k/cdkd#5639: a point-in-time restore takes its engine from the source:
 * RestoreDBClusterToPointInTime has no Engine member, and CloudFormation's
 * restore translation sends none (`Translator.restoreDbClusterToPointInTimeRequest`).
 */
const RESTORE_ENGINE_SILENT = Object.fromEntries(
  ['create', 'create-vary'].map((d) => [
    `${d}:Engine`,
    `RestoreDBClusterToPointInTime has no Engine member, and CloudFormation's restore sends none: the restored cluster takes its source's engine (${SRC} cluster-restore.ts)`,
  ])
);

const CLUSTER_CASE: TypeCase = {
  resourceType: 'AWS::RDS::DBCluster',
  provider: () => new RDSProvider(),
  physicalId: CLUSTER_ID,
  createOnly: createOnlyOf('AWS::RDS::DBCluster'),
  arm: armCluster,
  exempt: {},
  nestedExempt: {
    'MasterUserSecret.SecretArn': SECRET_ARN_READ_ONLY,
  },
  targets: [
    ...TAG_TARGETS,
    // ModifyDBCluster sends the whole desired list (form-encoded).
    {
      path: ['VpcSecurityGroupIds', 0],
      command: 'ModifyDBClusterCommand',
      names: '=sg-2',
      notNames: '=sg-1',
    },
    ...ROLE_TARGETS('RemoveRoleFromDBClusterCommand'),
  ],
  bags: [
    {
      name: 'Aurora PostgreSQL, a template password, Serverless v2 with auto-pause',
      bag: {
        DBClusterIdentifier: CLUSTER_ID,
        Engine: 'aurora-postgresql',
        EngineVersion: '16.4',
        MasterUsername: 'admin',
        MasterUserPassword: 'password-1',
        DatabaseName: 'app',
        Port: 5433,
        VpcSecurityGroupIds: ['sg-1', 'sg-2'],
        DBSubnetGroupName: SUBNET_GROUP,
        StorageEncrypted: true,
        KmsKeyId: KMS,
        BackupRetentionPeriod: 7,
        DeletionProtection: true,
        ServerlessV2ScalingConfiguration: {
          MinCapacity: 0,
          MaxCapacity: 4,
          SecondsUntilAutoPause: 600,
        },
        MonitoringRoleArn: MONITORING_ROLE,
        MonitoringInterval: 60,
        EnableIAMDatabaseAuthentication: true,
        PubliclyAccessible: false,
        DBClusterParameterGroupName: 'params-1',
        PreferredBackupWindow: '03:00-03:30',
        PreferredMaintenanceWindow: 'sun:05:00-sun:05:30',
        CopyTagsToSnapshot: true,
        StorageType: 'aurora-iopt1',
        EnableCloudwatchLogsExports: ['postgresql', 'iam-db-auth-error'],
        AutoMinorVersionUpgrade: false,
        NetworkType: 'DUAL',
        PerformanceInsightsEnabled: true,
        PerformanceInsightsKmsKeyId: KMS,
        PerformanceInsightsRetentionPeriod: 465,
        EnableHttpEndpoint: true,
        AssociatedRoles: fresh(ROLES),
        Tags: fresh(TAGS),
      },
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        ...CLUSTER_BACKFILL_KEPT,
        ...CLUSTER_SCALARS_KEPT,
        ...CLUSTER_MASTER_USERNAME_SILENT,
        'update-remove:MasterUserPassword': PASSWORD_REMOVED,
        'update-remove:DeletionProtection': KEPT('DeletionProtection'),
        'update-remove:EnableIAMDatabaseAuthentication': KEPT('EnableIAMDatabaseAuthentication'),
        'update-remove:EngineVersion': KEPT('EngineVersion'),
        'update-remove:MonitoringInterval': KEPT('MonitoringInterval'),
        'update-remove:MonitoringRoleArn': KEPT('MonitoringRoleArn'),
        'update-remove:ServerlessV2ScalingConfiguration': KEPT('ServerlessV2ScalingConfiguration'),
        ...Object.fromEntries(
          ['MinCapacity', 'MaxCapacity', 'SecondsUntilAutoPause'].map((key) => [
            `update-remove:ServerlessV2ScalingConfiguration.${key}`,
            `ModifyDBCluster sends the WHOLE declared block from next, never reading prev (${SRC}), so a member removal is delivered by next alone (update-add observes it); a block without SecondsUntilAutoPause resets the live delay to AWS's 300-second default, as CloudFormation measured (go-to-k/cdkd#5466)`,
          ])
        ),
        ...Object.fromEntries(
          [0, 1].map((i) => [
            `update-remove:VpcSecurityGroupIds.${i}`,
            `ModifyDBCluster sends the WHOLE desired list from next (${SRC}), so an element removal is delivered by next alone (update-add observes it); only a whole-list removal reads prev (the VPC default group)`,
          ])
        ),
      },
      expectedRemovalThrows: {
        ...TAG_THROWS(ALL_DIRECTIONS, 2),
        ...ROLES_REFUSED(['RoleArn'], /AssociatedRoles must be a list of objects with a RoleArn;/),
      },
    },
    {
      name: 'Aurora MySQL, a managed master password',
      bag: {
        Engine: 'aurora-mysql',
        MasterUsername: 'admin',
        ManageMasterUserPassword: true,
        MasterUserSecret: { KmsKeyId: SECRET_KMS },
      },
      expectedSilent: { ...CLUSTER_ENGINE_SILENT, ...CLUSTER_MASTER_USERNAME_SILENT },
    },
    {
      name: 'Database Insights, engine lifecycle and master user authentication (go-to-k/cdkd#5639)',
      bag: {
        Engine: 'aurora-postgresql',
        MasterUsername: 'admin',
        PerformanceInsightsEnabled: true,
        PerformanceInsightsRetentionPeriod: 465,
        DatabaseInsightsMode: 'advanced',
        EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
        MasterUserAuthenticationType: 'iam-db-auth',
      },
      expectedRemovalThrows: Object.fromEntries(
        ['update-add', 'update-remove'].map((d) => [
          `${d}:EngineLifecycleSupport`,
          {
            why: `CloudFormation refuses any change to EngineLifecycleSupport, an addition and a removal included ("EngineLifecycleSupport cannot be modified.", measured go-to-k/cdkd#5639), so update() refuses it before any call unless the live cluster already holds the declared value (engineLifecycleSupportAction in ${SRC})`,
            says: /EngineLifecycleSupport cannot change on an existing DB cluster/,
          },
        ])
      ),
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        ...CLUSTER_MASTER_USERNAME_SILENT,
        'update-vary:EngineLifecycleSupport': `refused like its add and removal: any changed value throws before a call (engineLifecycleSupportAction in ${SRC}, go-to-k/cdkd#5639)`,
        ...Object.fromEntries(
          ['PerformanceInsightsEnabled', 'PerformanceInsightsRetentionPeriod'].map((key) => [
            `update-remove:${key}`,
            CLUSTER_SCALARS_KEPT[`update-remove:${key}`]!,
          ])
        ),
        ...Object.fromEntries(
          ['DatabaseInsightsMode', 'MasterUserAuthenticationType'].map((key) => [
            `update-remove:${key}`,
            `left in place on removal: update() sends ${key} only when the template changed it, and CloudFormation sends none for a removed one (measured with CloudTrail, go-to-k/cdkd#5639; ${SRC})`,
          ])
        ),
      },
    },
    {
      name: 'Aurora MySQL backtracking, local write forwarding and scalability type (go-to-k/cdkd#5639)',
      bag: {
        Engine: 'aurora-mysql',
        MasterUsername: 'admin',
        BacktrackWindow: 3600,
        EnableLocalWriteForwarding: true,
        ClusterScalabilityType: 'standard',
      },
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        ...CLUSTER_MASTER_USERNAME_SILENT,
        'update-remove:BacktrackWindow': `left in place on removal: ModifyDBCluster treats an absent member as "no change", and CloudFormation's handler (Translator.modifyDbClusterRequest) sends null for a removed BacktrackWindow, read from the handler source, not measured (${SRC} clusterModifyScalarMembers)`,
      },
    },
    {
      name: 'engine mode and Availability Zones (go-to-k/cdkd#5639)',
      bag: {
        Engine: 'aurora-postgresql',
        MasterUsername: 'admin',
        EngineMode: 'provisioned',
        AvailabilityZones: ['us-east-1a', 'us-east-1b'],
      },
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        ...CLUSTER_MASTER_USERNAME_SILENT,
        ...Object.fromEntries(
          [
            'update-add:AvailabilityZones',
            'update-remove:AvailabilityZones',
            ...['update-add', 'update-remove', 'update-vary'].flatMap((d) =>
              [0, 1].map((i) => `${d}:AvailabilityZones.${i}`)
            ),
          ].map((key) => [
            key,
            `ModifyDBCluster has no AvailabilityZones member, and CloudFormation's update handler sends none (Translator.modifyDbClusterRequest; read from the handler source, not measured), so a change completes in place keeping the live zones (${SRC})`,
          ])
        ),
      },
    },
    {
      name: 'a member of a global cluster (go-to-k/cdkd#5639)',
      bag: {
        Engine: 'aurora-postgresql',
        MasterUsername: 'admin',
        GlobalClusterIdentifier: 'global-1',
      },
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        ...CLUSTER_MASTER_USERNAME_SILENT,
        'update-vary:GlobalClusterIdentifier': GLOBAL_CLUSTER_REFUSED.why,
      },
      expectedRemovalThrows: {
        'update-add:GlobalClusterIdentifier': GLOBAL_CLUSTER_REFUSED,
      },
    },
    {
      name: 'express configuration (go-to-k/cdkd#5984)',
      bag: {
        Engine: 'aurora-postgresql',
        WithExpressConfiguration: true,
      },
      expectedSilent: CLUSTER_ENGINE_SILENT,
    },
    {
      name: 'a point-in-time restore to the latest time (go-to-k/cdkd#5639)',
      bag: {
        Engine: 'aurora-postgresql',
        SourceDBClusterIdentifier: 'source-cluster',
        UseLatestRestorableTime: true,
        RestoreType: 'copy-on-write',
        BackupRetentionPeriod: 7,
        DeletionProtection: true,
      },
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        ...RESTORE_ENGINE_SILENT,
        'update-remove:DeletionProtection': KEPT('DeletionProtection'),
      },
    },
    {
      name: 'a point-in-time restore to a time (go-to-k/cdkd#5639)',
      bag: {
        Engine: 'aurora-postgresql',
        SourceDBClusterIdentifier: 'source-cluster',
        RestoreToTime: '2026-11-10T00:30:00Z',
      },
      variants: { RestoreToTime: '2026-11-09T12:00:00Z' },
      expectedSilent: { ...CLUSTER_ENGINE_SILENT, ...RESTORE_ENGINE_SILENT },
    },
    {
      name: 'a snapshot restore (go-to-k/cdkd#5639)',
      bag: {
        Engine: 'aurora-postgresql',
        SnapshotIdentifier: 'manual-snapshot-1',
        BackupRetentionPeriod: 7,
        DeletionProtection: true,
      },
      variants: { SnapshotIdentifier: 'manual-snapshot-2' },
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        'update-remove:DeletionProtection': KEPT('DeletionProtection'),
      },
    },
    {
      name: 'a point-in-time restore from a source resource id (go-to-k/cdkd#5639)',
      bag: {
        Engine: 'aurora-postgresql',
        SourceDbClusterResourceId: 'cluster-SOURCEID123',
        UseLatestRestorableTime: true,
      },
      variants: { SourceDbClusterResourceId: 'cluster-SOURCEID456' },
      expectedSilent: { ...CLUSTER_ENGINE_SILENT, ...RESTORE_ENGINE_SILENT },
    },
    {
      name: 'Multi-AZ DB cluster (mysql), a declared Port',
      bag: { Engine: 'mysql', Port: 3307 },
      // A removed Port sends 3306, as CloudFormation does; RDS refuses it on a
      // Multi-AZ DB cluster (go-to-k/cdkd#1160 A/B), so it is no longer silent.
      expectedSilent: CLUSTER_ENGINE_SILENT,
    },
    {
      name: 'Multi-AZ DB cluster (postgres) instance class and provisioned IOPS storage (go-to-k/cdkd#5639)',
      bag: {
        Engine: 'postgres',
        MasterUsername: 'admin',
        DBClusterInstanceClass: 'db.m6gd.large',
        StorageType: 'io1',
        AllocatedStorage: 100,
        Iops: 1000,
      },
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        ...CLUSTER_MASTER_USERNAME_SILENT,
        'update-remove:StorageType': CLUSTER_BACKFILL_KEPT['update-remove:StorageType']!,
        ...Object.fromEntries(
          ['DBClusterInstanceClass', 'AllocatedStorage', 'Iops'].map((key) => [
            `update-remove:${key}`,
            `left in place on removal: ModifyDBCluster treats an absent member as "no change", and CloudFormation's handler (Translator.modifyDbClusterRequest) sends null for a removed ${key} with no default filled, read from the handler source, not measured (${SRC} clusterModifyMultiAzMembers)`,
          ])
        ),
      },
    },
    {
      name: 'the instance parameter group an engine upgrade applies (go-to-k/cdkd#5639)',
      bag: {
        Engine: 'aurora-postgresql',
        MasterUsername: 'admin',
        DBInstanceParameterGroupName: 'instance-params-1',
      },
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        ...CLUSTER_MASTER_USERNAME_SILENT,
        ...Object.fromEntries(
          ['create', 'create-vary'].map((d) => [
            `${d}:DBInstanceParameterGroupName`,
            `CreateDBCluster has no DBInstanceParameterGroupName member, and CloudFormation's create translation sends none (Translator.createDbClusterRequest, read from the handler source), so a create never sends it (${SRC})`,
          ])
        ),
        ...Object.fromEntries(
          ['update-add', 'update-remove', 'update-vary'].map((d) => [
            `${d}:DBInstanceParameterGroupName`,
            `sent only beside a changed EngineVersion, as CloudFormation's handler sends it (Translator.modifyDbClusterRequest: inside the engine-version arm, outside a rollback); this bag's EngineVersion never changes, so rds-dbcluster-instance-param-group-5639.test.ts observes the delivery (${SRC} clusterInstanceParameterGroupToSend)`,
          ])
        ),
      },
    },
  ],
};

// --- AWS::RDS::DBInstance ------------------------------------------------------

/**
 * DescribeDBInstances answers the instance available with its ARN: the create
 * wait settles at once. Its subnet group's VPC and that VPC's `default` group
 * serve a removed VPCSecurityGroups (go-to-k/cdkd#5542). The live allocated
 * storage is the previous bag's, which a removed MaxAllocatedStorage sends
 * (go-to-k/cdkd#2762).
 */
function armInstance(_physicalId?: string, live: Bag = {}): void {
  let logs = liveLogs(live);
  const roles = { current: liveRoles(live) };
  // go-to-k/cdkd#5640: a bag declaring a source reads as a PostgreSQL read
  // replica (the engine it inherits) until PromoteReadReplica.
  const replica = live['SourceDBInstanceIdentifier'] != null;
  let replicaSource = replica ? INSTANCE_ID_SOURCE : undefined;
  // go-to-k/cdkd#5640: the features a modify sent apply at once, so the
  // update's processor wait settles.
  let processorFeatures = live['ProcessorFeatures'] as unknown;
  // go-to-k/cdkd#5640: the replication the bag declares is live until a stop;
  // a start lists one again (its region is the client's, which no input
  // carries, so the replication waits are skipped: INSTANCE_CASE.provider).
  const declaredReplication = live['AutomaticBackupReplicationRegion'];
  let replicationRegion = typeof declaredReplication === 'string' ? declaredReplication : undefined;
  setOutputOverrides({
    ...roleCallOverrides('AddRoleToDBInstanceCommand', 'RemoveRoleFromDBInstanceCommand', roles),
    ModifyDBInstanceCommand: (input) => {
      logs = applyLogDelta(logs, input);
      if (input['ProcessorFeatures'] !== undefined) processorFeatures = input['ProcessorFeatures'];
      return {};
    },
    StopDBInstanceAutomatedBackupsReplicationCommand: () => {
      replicationRegion = undefined;
      return {};
    },
    StartDBInstanceAutomatedBackupsReplicationCommand: () => {
      replicationRegion = 'us-west-2';
      return {};
    },
    PromoteReadReplicaCommand: () => {
      replicaSource = undefined;
      return {};
    },
    DescribeDBInstancesCommand: () => ({
      DBInstances: [
        {
          DBInstanceIdentifier: INSTANCE_ID,
          DBInstanceArn: INSTANCE_ARN,
          DBInstanceStatus: 'available',
          DBSubnetGroup: { DBSubnetGroupName: SUBNET_GROUP, VpcId: 'vpc-1' },
          ...(live['AllocatedStorage'] != null && {
            AllocatedStorage: Number(live['AllocatedStorage']),
          }),
          EnabledCloudwatchLogsExports: logs,
          AssociatedRoles: roles.current,
          ...(replica && { Engine: 'postgres' }),
          ...(replicaSource !== undefined && {
            ReadReplicaSourceDBInstanceIdentifier: replicaSource,
          }),
          ...(Array.isArray(processorFeatures) && { ProcessorFeatures: processorFeatures }),
          DBInstanceAutomatedBackupsReplications:
            replicationRegion === undefined
              ? []
              : [
                  {
                    DBInstanceAutomatedBackupsArn: `arn:aws:rds:${replicationRegion}:${ACCOUNT}:auto-backup:ab-1`,
                  },
                ],
        },
      ],
    }),
    DescribeSecurityGroupsCommand: () => ({ SecurityGroups: [{ GroupId: DEFAULT_SG }] }),
  });
}

const INSTANCE_ENGINE_SILENT = Object.fromEntries(
  ['update-add', 'update-remove', 'update-vary'].map((d) => [`${d}:Engine`, INSTANCE_ENGINE])
);

/**
 * Measured against CloudFormation (go-to-k/cdkd#1160 A/B, us-east-1,
 * 2026-10-29): a template that drops DBInstanceClass updates in place,
 * CloudFormation's ModifyDBInstance carries no class, and the live class stays.
 * The registry schema has no top-level `required` for AWS::RDS::DBInstance.
 */
const INSTANCE_CLASS_REMOVED = `update() sends only a declared DBInstanceClass (${SRC}), and ModifyDBInstance keeps the live class when none is sent, as CloudFormation does (A/B on go-to-k/cdkd#1160; ${SRC})`;

/**
 * go-to-k/cdkd#2762: CloudFormation's DBInstance handler sends each of these as
 * `diff(previous, desired)`, nothing for a removal, so RDS keeps the live value.
 */
const CFN_DIFF_KEPT = (key: string): string =>
  `left in place on removal: update() sends ${key} only when the template changed it (instanceModifyBackfillMembers in ${SRC}), as CloudFormation's handler sends diff(previous, desired), which is null for a removal (go-to-k/cdkd#2762)`;

const INSTANCE_CASE: TypeCase = {
  resourceType: 'AWS::RDS::DBInstance',
  // go-to-k/cdkd#5640: a flag-only processor change waits out a few quiet
  // reads (`processorFeaturesSettled`), with no real sleep here.
  provider: () => {
    const provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    // go-to-k/cdkd#5640: a replication wait reads the destination region off
    // the listed ARN, which the arm cannot name (the client region is no
    // input); rds-dbinstance-backup-replication-5640.test.ts pins those waits.
    const waitForInstanceState = provider.waitForInstanceState.bind(provider);
    provider.waitForInstanceState = async (logicalId, id, done, change) =>
      change.startsWith('automated backup replication')
        ? ((await provider.describeDBInstance(id)) ?? {})
        : waitForInstanceState(logicalId, id, done, change);
    return provider;
  },
  physicalId: INSTANCE_ID,
  createOnly: createOnlyOf('AWS::RDS::DBInstance'),
  arm: (physicalId, bag) => armInstance(physicalId, bag),
  exempt: {
    // go-to-k/cdkd#2762: not a CreateDBInstance member, and ModifyDBInstance
    // carries it only beside a changed CACertificateIdentifier, as CloudFormation's
    // handler sends it, a pair no single-key bag probe changes. Pinned by
    // rds-dbinstance-engine-version-backfill-2762.test.ts.
    CertificateRotationRestart: `sent only beside a changed CACertificateIdentifier (instanceModifyBackfillMembers in ${SRC}), which no single-key probe makes`,
    // go-to-k/cdkd#5640: never on the wire, under CloudFormation's Java SDK
    // too (it only picks the presigned URL's region, which the JS SDK derives
    // from the source ARN). Pinned by rds-dbinstance-read-replica-5640.test.ts.
    SourceRegion: `validated only (refuseUnknownSourceRegion in ${SRC}): no RDS request member carries it`,
  },
  nestedExempt: {
    'MasterUserSecret.SecretArn': SECRET_ARN_READ_ONLY,
  },
  targets: [
    ...TAG_TARGETS,
    // ModifyDBInstance sends the whole desired list (form-encoded).
    {
      path: ['VPCSecurityGroups', 0],
      command: 'ModifyDBInstanceCommand',
      names: '=sg-2',
      notNames: '=sg-1',
    },
    ...ROLE_TARGETS('RemoveRoleFromDBInstanceCommand'),
  ],
  bags: [
    {
      name: 'standalone PostgreSQL, a template password',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.t3.micro',
        Engine: 'postgres',
        EngineVersion: '16.4',
        AllocatedStorage: '20',
        MasterUsername: 'admin',
        MasterUserPassword: 'password-1',
        Port: '5433',
        VPCSecurityGroups: ['sg-1', 'sg-2'],
        DBSubnetGroupName: SUBNET_GROUP,
        PubliclyAccessible: false,
        StorageEncrypted: true,
        KmsKeyId: KMS,
        DeletionProtection: true,
        MonitoringRoleArn: MONITORING_ROLE,
        MonitoringInterval: 60,
        EnableIAMDatabaseAuthentication: true,
        AssociatedRoles: fresh(ROLES),
        Tags: fresh(TAGS),
      },
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        'update-remove:MasterUserPassword': PASSWORD_REMOVED,
        'update-remove:AllocatedStorage': KEPT('AllocatedStorage'),
        'update-remove:DeletionProtection': KEPT('DeletionProtection'),
        'update-remove:EnableIAMDatabaseAuthentication': KEPT('EnableIAMDatabaseAuthentication'),
        'update-remove:EngineVersion': KEPT('EngineVersion'),
        'update-remove:MonitoringInterval': KEPT('MonitoringInterval'),
        'update-remove:MonitoringRoleArn': KEPT('MonitoringRoleArn'),
        'update-remove:Port': KEPT('Port'),
        'update-remove:PubliclyAccessible': KEPT('PubliclyAccessible'),
        ...Object.fromEntries(
          [0, 1].map((i) => [
            `update-remove:VPCSecurityGroups.${i}`,
            `ModifyDBInstance sends the WHOLE desired list from next (${SRC}), so an element removal is delivered by next alone (update-add observes it); only a whole-list removal reads prev (the VPC default group, go-to-k/cdkd#5542)`,
          ])
        ),
      },
      expectedRemovalThrows: {
        ...TAG_THROWS(ALL_DIRECTIONS, 2),
        ...ROLES_REFUSED(
          ['RoleArn', 'FeatureName'],
          /AssociatedRoles must be a list of objects with a RoleArn and a FeatureName;/
        ),
      },
    },
    {
      name: 'a managed master password',
      bag: {
        DBInstanceClass: 'db.t3.micro',
        Engine: 'mysql',
        MasterUsername: 'admin',
        ManageMasterUserPassword: true,
        MasterUserSecret: { KmsKeyId: SECRET_KMS },
      },
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
      },
    },
    {
      name: 'an Aurora cluster member',
      bag: {
        DBInstanceClass: 'db.r6g.large',
        Engine: 'aurora-postgresql',
        DBClusterIdentifier: CLUSTER_ID,
      },
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
      },
    },
    {
      name: 'gp3 storage, backups, maintenance and Performance Insights (go-to-k/cdkd#2762)',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.m6g.large',
        Engine: 'postgres',
        AllocatedStorage: '400',
        MasterUsername: 'admin',
        StorageType: 'gp3',
        Iops: 12000,
        StorageThroughput: 500,
        MaxAllocatedStorage: 1000,
        BackupRetentionPeriod: 7,
        PreferredBackupWindow: '03:00-04:00',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        MultiAZ: true,
        AutoMinorVersionUpgrade: false,
        CopyTagsToSnapshot: true,
        EnablePerformanceInsights: true,
        PerformanceInsightsKMSKeyId: KMS,
        PerformanceInsightsRetentionPeriod: 7,
        OptionGroupName: 'og-1',
        CACertificateIdentifier: 'rds-ca-rsa2048-g1',
      },
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        ...Object.fromEntries(
          [
            'AllocatedStorage',
            'StorageType',
            'Iops',
            'StorageThroughput',
            'BackupRetentionPeriod',
            'PreferredBackupWindow',
            'PreferredMaintenanceWindow',
            'MultiAZ',
            'AutoMinorVersionUpgrade',
            'CopyTagsToSnapshot',
            'EnablePerformanceInsights',
            'PerformanceInsightsKMSKeyId',
            'PerformanceInsightsRetentionPeriod',
            'OptionGroupName',
            'CACertificateIdentifier',
          ].map((key) => [`update-remove:${key}`, CFN_DIFF_KEPT(key)])
        ),
      },
    },
    {
      name: 'network type, license, promotion tier, Database Insights, log volume, parameter group and the major-version flag (go-to-k/cdkd#2762)',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.m6g.large',
        Engine: 'postgres',
        NetworkType: 'DUAL',
        LicenseModel: 'postgresql-license',
        PromotionTier: 3,
        DatabaseInsightsMode: 'advanced',
        DedicatedLogVolume: true,
        AllowMajorVersionUpgrade: true,
        DBParameterGroupName: 'pg-1',
        EnableCloudwatchLogsExports: ['postgresql', 'upgrade'],
        // go-to-k/cdkd#5640: DBName is create-only (create probes only).
        DBName: 'appdb',
        AvailabilityZone: 'us-east-1a',
      },
      expectedRemovalThrows: Object.fromEntries(
        ['update-add', 'update-remove'].map((d) => [
          `${d}:AvailabilityZone`,
          {
            why: `ModifyDBInstance cannot move an instance, and CloudFormation refuses a changed zone ("Resource is immutable"), so update() refuses it before any call (instanceAvailabilityZoneKept in ${SRC}, go-to-k/cdkd#5640)`,
            says: /AvailabilityZone cannot change on an existing DB instance/,
          },
        ])
      ),
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-vary:AvailabilityZone': `refused like its add and removal: any changed zone throws before a call (instanceAvailabilityZoneKept in ${SRC}, go-to-k/cdkd#5640)`,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        'create:AllowMajorVersionUpgrade': `not a CreateDBInstance member; CloudFormation's create sends none either (${SRC} createDBInstance)`,
        'create-vary:AllowMajorVersionUpgrade': `not a CreateDBInstance member; CloudFormation's create sends none either (${SRC} createDBInstance)`,
        ...Object.fromEntries(
          [
            'NetworkType',
            'LicenseModel',
            'PromotionTier',
            'DatabaseInsightsMode',
            'DedicatedLogVolume',
            'AllowMajorVersionUpgrade',
            'DBParameterGroupName',
          ].map((key) => [`update-remove:${key}`, CFN_DIFF_KEPT(key)])
        ),
      },
    },
    {
      name: 'engine lifecycle and master user authentication (go-to-k/cdkd#5640)',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.t4g.micro',
        Engine: 'postgres',
        AllocatedStorage: '20',
        MasterUsername: 'admin',
        EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
        MasterUserAuthenticationType: 'iam-db-auth',
      },
      expectedRemovalThrows: Object.fromEntries(
        ['update-add', 'update-remove'].map((d) => [
          `${d}:EngineLifecycleSupport`,
          {
            why: `CloudFormation refuses any change to EngineLifecycleSupport, an addition and a removal included ("EngineLifecycleSupport cannot be modified.", measured go-to-k/cdkd#5640), so update() refuses it before any call unless the live instance already holds the declared value (engineLifecycleSupportAction in ${SRC})`,
            says: /EngineLifecycleSupport cannot change on an existing DB instance/,
          },
        ])
      ),
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-vary:EngineLifecycleSupport': `refused like its add and removal: any changed value throws before a call (engineLifecycleSupportAction in ${SRC}, go-to-k/cdkd#5640)`,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        'update-remove:AllocatedStorage': CFN_DIFF_KEPT('AllocatedStorage'),
        'update-remove:MasterUserAuthenticationType': CFN_DIFF_KEPT('MasterUserAuthenticationType'),
      },
    },
    {
      name: 'a read replica, with members its create cannot carry (go-to-k/cdkd#5640)',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.t3.micro',
        SourceDBInstanceIdentifier: SOURCE_ARN,
        AllocatedStorage: '100',
        StorageType: 'gp3',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        MaxAllocatedStorage: 1000,
      },
      expectedRemovalThrows: {
        'update-add:SourceDBInstanceIdentifier': {
          why: `an instance becomes a read replica only when it is created, and CloudFormation fails an added source as "Resource is immutable", so update() refuses it before any call (replicaSourceChange in ${SRC}, go-to-k/cdkd#5640)`,
          says: /SourceDBInstanceIdentifier cannot be added or changed on an existing DB instance/,
        },
      },
      expectedSilent: {
        'update-vary:SourceDBInstanceIdentifier': `refused like its addition: a changed source throws before a call (replicaSourceChange in ${SRC}, go-to-k/cdkd#5640)`,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        ...Object.fromEntries(
          ['AllocatedStorage', 'StorageType', 'PreferredMaintenanceWindow'].map((key) => [
            `update-remove:${key}`,
            CFN_DIFF_KEPT(key),
          ])
        ),
      },
    },
    {
      name: 'automated backup replication (go-to-k/cdkd#5640)',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.t4g.micro',
        Engine: 'postgres',
        AllocatedStorage: '20',
        MasterUsername: 'postgres',
        BackupRetentionPeriod: 7,
        AutomaticBackupReplicationRegion: 'us-west-2',
        AutomaticBackupReplicationKmsKeyId: `arn:aws:kms:us-west-2:${ACCOUNT}:key/replica-key`,
        AutomaticBackupReplicationRetentionPeriod: 3,
      },
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        'update-remove:AllocatedStorage': CFN_DIFF_KEPT('AllocatedStorage'),
        'update-remove:BackupRetentionPeriod': CFN_DIFF_KEPT('BackupRetentionPeriod'),
      },
      expectedRemovalThrows: Object.fromEntries(
        ['create', 'update-add', 'update-remove'].map((d) => [
          `${d}:AutomaticBackupReplicationRegion`,
          {
            why: `a KMS key or retention with no region is refused before any call, as CloudFormation's AutomaticBackupReplicationValidator refuses it (backupReplicationPlan in ${SRC})`,
            says: /must specify the AutomaticBackupReplicationRegion parameter/,
          },
        ])
      ),
    },
    {
      // go-to-k/cdkd#5640: the region alone, so its removal stops the
      // replication (StopDBInstanceAutomatedBackupsReplication).
      name: 'automated backup replication, region only (go-to-k/cdkd#5640)',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.t4g.micro',
        Engine: 'postgres',
        AllocatedStorage: '20',
        MasterUsername: 'postgres',
        AutomaticBackupReplicationRegion: 'us-west-2',
      },
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        'update-remove:AllocatedStorage': CFN_DIFF_KEPT('AllocatedStorage'),
      },
    },
    {
      name: 'processor features (go-to-k/cdkd#5640)',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.m7i.large',
        Engine: 'sqlserver-web',
        LicenseModel: 'license-included',
        AllocatedStorage: '20',
        MasterUsername: 'admin',
        ProcessorFeatures: [
          { Name: 'coreCount', Value: '1' },
          { Name: 'threadsPerCore', Value: '1' },
        ],
        UseDefaultProcessorFeatures: false,
      },
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        'update-remove:AllocatedStorage': CFN_DIFF_KEPT('AllocatedStorage'),
        'update-remove:LicenseModel': CFN_DIFF_KEPT('LicenseModel'),
        ...Object.fromEntries(
          ['create', 'create-vary'].map((d) => [
            `${d}:UseDefaultProcessorFeatures`,
            `not a CreateDBInstance member, so CloudFormation's create translation drops it too; a replica's create and ModifyDBInstance carry it (${SRC}, go-to-k/cdkd#5640)`,
          ])
        ),
      },
    },
    {
      // go-to-k/cdkd#5640: both create-only (create probes only).
      name: 'Oracle character sets (go-to-k/cdkd#5640)',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.t3.small',
        Engine: 'oracle-se2',
        LicenseModel: 'license-included',
        AllocatedStorage: '20',
        MasterUsername: 'admin',
        CharacterSetName: 'WE8ISO8859P1',
        NcharCharacterSetName: 'UTF8',
      },
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        'update-remove:AllocatedStorage': CFN_DIFF_KEPT('AllocatedStorage'),
        'update-remove:LicenseModel': CFN_DIFF_KEPT('LicenseModel'),
      },
    },
    {
      // go-to-k/cdkd#5640: create-only (create probes only).
      name: 'a SQL Server time zone (go-to-k/cdkd#5640)',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.t3.small',
        Engine: 'sqlserver-ex',
        LicenseModel: 'license-included',
        AllocatedStorage: '20',
        MasterUsername: 'admin',
        Timezone: 'Tokyo Standard Time',
      },
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        'update-remove:AllocatedStorage': CFN_DIFF_KEPT('AllocatedStorage'),
        'update-remove:LicenseModel': CFN_DIFF_KEPT('LicenseModel'),
      },
    },
  ],
};

export const CASES_19: TypeCase[] = [SUBNET_GROUP_CASE, CLUSTER_CASE, INSTANCE_CASE];

/** Direct-call checks the bag probes cannot make. */
export function describeRdsExtras(): void {
  const provider = (): RDSProvider => new RDSProvider();
  const rules = new ReplacementRulesRegistry();
  const clusterBag = (): Bag => fresh(CLUSTER_CASE.bags[0]!.bag);
  const instanceBag = (): Bag => fresh(INSTANCE_CASE.bags[0]!.bag);
  const lines = (outcome: Outcome): string[] => {
    expect(outcome).toMatchObject({ threw: false });
    return (outcome as { wire: string }).wire.split('\n').filter((line) => line !== '');
  };
  /** The body of the one `command` request the run sent. */
  const bodyOf = (outcome: Outcome, command: string): string => {
    const requests = lines(outcome)
      .map((line) => JSON.parse(line) as unknown[])
      .filter((entry) => entry[0] === command);
    expect(requests, command).toHaveLength(1);
    return requests[0]![requests[0]!.length - 1] as string;
  };
  const updateCluster = (next: Bag, prev: Bag): Promise<Outcome> => {
    armCluster(CLUSTER_ID, prev);
    return record(() =>
      provider().update('L', CLUSTER_ID, 'AWS::RDS::DBCluster', fresh(next), fresh(prev))
    );
  };
  const updateInstance = (next: Bag, prev: Bag): Promise<Outcome> => {
    armInstance();
    return record(() =>
      provider().update('L', INSTANCE_ID, 'AWS::RDS::DBInstance', fresh(next), fresh(prev))
    );
  };

  // go-to-k/cdkd#5467: a change declared on BOTH sides, which no bag probe makes
  // (see CLUSTER_ENGINE / INSTANCE_ENGINE). The registry decides whether the
  // engine replaces; an in-place one reaches update(), whose wire is pinned.
  describe('an RDS Engine change declared on both sides (go-to-k/cdkd#5467)', () => {
    it.each([
      ['aurora-mysql', 'aurora-postgresql'],
      ['aurora-postgresql', 'aurora-mysql'],
      ['mysql', 'aurora-mysql'],
    ])('DBCluster %s -> %s replaces', (from, to) => {
      expect(rules.requiresReplacement('AWS::RDS::DBCluster', 'Engine', from, to)).toBe(true);
    });

    it('DBCluster aurora -> aurora-mysql is in place, and ModifyDBCluster carries no Engine', async () => {
      expect(
        rules.requiresReplacement('AWS::RDS::DBCluster', 'Engine', 'aurora', 'aurora-mysql')
      ).toBe(false);
      const prev = { ...clusterBag(), Engine: 'aurora' };
      const next = { ...clusterBag(), Engine: 'aurora-mysql' };
      const body = bodyOf(await updateCluster(next, prev), 'ModifyDBClusterCommand');
      expect(body).toContain(`DBClusterIdentifier=${CLUSTER_ID}`);
      expect(body.split('&').filter((p) => p.startsWith('Engine='))).toEqual([]);
    });

    it.each([
      ['mysql', 'mariadb'],
      ['postgres', 'mysql'],
      ['oracle-ee', 'oracle-se2'],
    ])('DBInstance %s -> %s replaces', (from, to) => {
      expect(rules.requiresReplacement('AWS::RDS::DBInstance', 'Engine', from, to)).toBe(true);
    });

    it.each([
      ['aurora', 'aurora-mysql'],
      ['oracle-se', 'oracle-se2'],
      ['oracle-se1', 'oracle-se2'],
      ['oracle-ee', 'oracle-ee-cdb'],
      ['oracle-se2', 'oracle-se2-cdb'],
      // Either case, as the handler's equalsIgnoreCase arms take it; the
      // desired spelling is what is sent.
      ['ORACLE-SE1', 'Oracle-SE2'],
    ])('DBInstance %s -> %s is in place, and ModifyDBInstance carries the new Engine', async (from, to) => {
      expect(rules.requiresReplacement('AWS::RDS::DBInstance', 'Engine', from, to)).toBe(false);
      const body = bodyOf(
        await updateInstance({ ...instanceBag(), Engine: to }, { ...instanceBag(), Engine: from }),
        'ModifyDBInstanceCommand'
      );
      expect(body.split('&')).toContain(`Engine=${to}`);
    });

    it('DBInstance: an unchanged Engine sends none', async () => {
      const body = bodyOf(
        await updateInstance(instanceBag(), instanceBag()),
        'ModifyDBInstanceCommand'
      );
      expect(body.split('&').filter((p) => p.startsWith('Engine='))).toEqual([]);
    });
  });

  // The bag probes see a removed MasterUserSecret change the wire (so it reads
  // as delivered) without seeing WHAT goes out: the credential-change gate
  // re-sends the still-declared ManageMasterUserPassword, with no key.
  // Measured against CloudFormation (go-to-k/cdkd#1160 A/B): CloudFormation
  // sends the same on a DBCluster and nothing on a DBInstance, and in every
  // case the managed secret stays on its customer key; RDS takes this wire as
  // a no-op on both types.
  describe('a removed MasterUserSecret while ManageMasterUserPassword stays true (go-to-k/cdkd#1160)', () => {
    const managed = (type: 'cluster' | 'instance'): Bag =>
      fresh((type === 'cluster' ? CLUSTER_CASE : INSTANCE_CASE).bags[1]!.bag);
    it.each(['cluster', 'instance'] as const)(
      'the %s update re-sends ManageMasterUserPassword=true and no key',
      async (type) => {
        const prev = managed(type);
        const next = managed(type);
        delete next['MasterUserSecret'];
        const outcome =
          type === 'cluster' ? await updateCluster(next, prev) : await updateInstance(next, prev);
        const body = bodyOf(
          outcome,
          type === 'cluster' ? 'ModifyDBClusterCommand' : 'ModifyDBInstanceCommand'
        );
        expect(body.split('&')).toContain('ManageMasterUserPassword=true');
        expect(body).not.toContain('MasterUserSecretKmsKeyId');
      }
    );
  });

  // go-to-k/cdkd#5466: the bag probes see the member delivered (create and
  // update-add / update-vary); these name the wire member itself.
  describe('DBCluster ServerlessV2ScalingConfiguration.SecondsUntilAutoPause (go-to-k/cdkd#5466)', () => {
    const MEMBER = 'ServerlessV2ScalingConfiguration.SecondsUntilAutoPause=600';

    it('is sent on CreateDBCluster', async () => {
      armCluster(CLUSTER_ID, {});
      const outcome = await record(() =>
        provider().create('L', 'AWS::RDS::DBCluster', clusterBag())
      );
      expect(bodyOf(outcome, 'CreateDBClusterCommand')).toContain(MEMBER);
    });

    it('is sent on ModifyDBCluster, alone in the block too', async () => {
      const prev = clusterBag();
      delete prev['ServerlessV2ScalingConfiguration'];
      const next = { ...prev, ServerlessV2ScalingConfiguration: { SecondsUntilAutoPause: 600 } };
      const body = bodyOf(await updateCluster(next, prev), 'ModifyDBClusterCommand');
      expect(body).toContain(MEMBER);
      expect(body).not.toContain('MinCapacity');
      expect(body).not.toContain('MaxCapacity');
    });

    it('a block without it sends the block without it', async () => {
      const next = clusterBag();
      delete (next['ServerlessV2ScalingConfiguration'] as Bag)['SecondsUntilAutoPause'];
      const body = bodyOf(await updateCluster(next, clusterBag()), 'ModifyDBClusterCommand');
      expect(body).toContain('ServerlessV2ScalingConfiguration.MinCapacity=0');
      expect(body).not.toContain('SecondsUntilAutoPause');
    });
  });

  describe('RDS deletes', () => {
    const del = async (
      type: string,
      physicalId: string,
      properties: Bag,
      context?: { finalSnapshotIdentifier?: string }
    ): Promise<string[]> => {
      // An empty Describe* answer is "gone", so each delete wait returns at once.
      setOutputOverrides({
        DescribeDBClustersCommand: () => ({ DBClusters: [] }),
        DescribeDBInstancesCommand: () => ({ DBInstances: [] }),
      });
      return lines(await record(() => provider().delete('L', physicalId, type, properties, context)));
    };
    const only = (wire: string[], command: string): string => {
      expect(wire.map((line) => (JSON.parse(line) as unknown[])[0])).toEqual([command]);
      return (JSON.parse(wire[0]!) as unknown[]).at(-1) as string;
    };

    it('DBSubnetGroup: DeleteDBSubnetGroup names the group', async () => {
      const body = only(
        await del('AWS::RDS::DBSubnetGroup', SUBNET_GROUP, fresh(SUBNET_GROUP_CASE.bags[0]!.bag)),
        'DeleteDBSubnetGroupCommand'
      );
      expect(body).toContain(`DBSubnetGroupName=${SUBNET_GROUP}`);
    });

    it('DBCluster: skips the final snapshot by default', async () => {
      const body = only(
        await del('AWS::RDS::DBCluster', CLUSTER_ID, clusterBag()),
        'DeleteDBClusterCommand'
      );
      expect(body).toContain(`DBClusterIdentifier=${CLUSTER_ID}`);
      expect(body).toContain('SkipFinalSnapshot=true');
      expect(body).not.toContain('FinalDBSnapshotIdentifier');
      expect(body).not.toContain('DeleteAutomatedBackups');
    });

    it('DBCluster: DeletionPolicy Snapshot takes the final snapshot, and the recorded DeleteAutomatedBackups rides along', async () => {
      const body = only(
        await del(
          'AWS::RDS::DBCluster',
          CLUSTER_ID,
          { ...clusterBag(), DeleteAutomatedBackups: false },
          { finalSnapshotIdentifier: 'snap-1' }
        ),
        'DeleteDBClusterCommand'
      );
      expect(body).toContain('SkipFinalSnapshot=false');
      expect(body).toContain('FinalDBSnapshotIdentifier=snap-1');
      expect(body).toContain('DeleteAutomatedBackups=false');
    });

    it('DBInstance: skips the final snapshot by default', async () => {
      const body = only(
        await del('AWS::RDS::DBInstance', INSTANCE_ID, instanceBag()),
        'DeleteDBInstanceCommand'
      );
      expect(body).toContain(`DBInstanceIdentifier=${INSTANCE_ID}`);
      expect(body).toContain('SkipFinalSnapshot=true');
      expect(body).not.toContain('FinalDBSnapshotIdentifier');
    });

    it('DBInstance: DeletionPolicy Snapshot takes the final snapshot, and the recorded DeleteAutomatedBackups rides along', async () => {
      const body = only(
        await del(
          'AWS::RDS::DBInstance',
          INSTANCE_ID,
          { ...instanceBag(), DeleteAutomatedBackups: 'true' },
          { finalSnapshotIdentifier: 'snap-1' }
        ),
        'DeleteDBInstanceCommand'
      );
      expect(body).toContain('SkipFinalSnapshot=false');
      expect(body).toContain('FinalDBSnapshotIdentifier=snap-1');
      expect(body).toContain('DeleteAutomatedBackups=true');
    });

    it('DBInstance: a cluster member skips the final snapshot even under DeletionPolicy Snapshot', async () => {
      const body = only(
        await del('AWS::RDS::DBInstance', INSTANCE_ID, fresh(INSTANCE_CASE.bags[2]!.bag), {
          finalSnapshotIdentifier: 'snap-1',
        }),
        'DeleteDBInstanceCommand'
      );
      expect(body).toContain('SkipFinalSnapshot=true');
      expect(body).not.toContain('FinalDBSnapshotIdentifier');
    });
  });
}
