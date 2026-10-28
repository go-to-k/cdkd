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

const SRC = 'rds-provider.ts';
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
const DEFAULT_SG = 'sg-default';

/** A Modify* call that only sends what `next` declares: a removal sends nothing. */
const KEPT = (key: string, where: string): string =>
  `left in place on removal: Modify* treats an absent member as "no change", and real CloudFormation A/Bs (#5004, #1160) measured a removed ${key} KEPT (${SRC}:${where})`;

/** A removed password is never sent: RDS keeps the live password when none is supplied. */
const PASSWORD_REMOVED = `a removed MasterUserPassword sends nothing, and any supplied one would reset the credentials (go-to-k/cdkd#5153; ${SRC}:125-140)`;

/**
 * Every `Engine` update probe here has one side without an `Engine`: the
 * reduced bag on update-add / update-remove, and the `base` (the bag without
 * the leaf) both update-vary sides share as `prev`. An `Engine` absent on
 * either side is never a replacement (go-to-k/cdkd#5467's deliberate
 * difference, `replacement-rules.ts` `enginePair`), so these probes reach
 * `update()`, which sends no `Engine` for them. A change with BOTH sides
 * declared is pinned in `describeRdsExtras`.
 */
const CLUSTER_ENGINE = `ModifyDBCluster has no Engine member; a change declared on both sides replaces unless it is aurora to aurora-mysql (go-to-k/cdkd#5467), and one with a side absent, as every update probe here has, is in place and sends nothing (${SRC}:1179-1225; describeRdsExtras pins both-sides changes)`;
const INSTANCE_ENGINE = `update() sends Engine only for a change CloudFormation's handler applies in place with BOTH sides declared (go-to-k/cdkd#5467, ${SRC}:1776-1787); a side absent, as every update probe here has, is never a replacement nor an Engine send, the deliberate difference replacement-rules.ts names (the handler would compare the LIVE engine, which a template diff cannot see; describeRdsExtras pins both-sides changes)`;

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
            `${key} is required by the registry schema (top-level \`required\`), so no deployable template removes it; update() sends only a declared value (${SRC}:744-753)`,
          ])
        ),
        ...Object.fromEntries(
          [0, 1].map((i) => [
            `update-remove:SubnetIds.${i}`,
            `ModifyDBSubnetGroup sends the WHOLE desired list from next, never reading prev, so an element removal is delivered by next alone (update-add observes it; ${SRC}:744-753)`,
          ])
        ),
      },
      expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
    },
  ],
};

// --- AWS::RDS::DBCluster -------------------------------------------------------

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
  setOutputOverrides({
    ModifyDBClusterCommand: (input) => {
      const sentGroups = input['VpcSecurityGroupIds'] as string[] | undefined;
      if (sentGroups !== undefined) groups = sentGroups;
      const sentPort = input['Port'] as number | undefined;
      if (sentPort !== undefined) port = sentPort;
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
        },
      ],
    }),
    DescribeDBSubnetGroupsCommand: () => ({
      DBSubnetGroups: [{ DBSubnetGroupArn: SUBNET_GROUP_ARN, VpcId: 'vpc-1' }],
    }),
    DescribeSecurityGroupsCommand: () => ({ SecurityGroups: [{ GroupId: DEFAULT_SG }] }),
  });
}

/** `MasterUserSecret.SecretArn` is the secret RDS creates, never a write input. */
const SECRET_ARN_READ_ONLY = `read-only in the registry schema (/properties/MasterUserSecret/SecretArn): the secret RDS creates. Create and modify take only MasterUserSecretKmsKeyId, so neither reads it (${SRC}:903-906, 1148-1150, 1565-1567, 1734-1736)`;

const CLUSTER_ENGINE_SILENT = Object.fromEntries(
  ['update-add', 'update-remove', 'update-vary'].map((d) => [`${d}:Engine`, CLUSTER_ENGINE])
);

/** Measured against CloudFormation (go-to-k/cdkd#5467): a changed MasterUsername stays in place. */
const CLUSTER_MASTER_USERNAME_SILENT = Object.fromEntries(
  ['update-add', 'update-remove', 'update-vary'].map((d) => [
    `${d}:MasterUsername`,
    `ModifyDBCluster has no MasterUsername member, and CloudFormation completes a changed one in place keeping the live user (measured us-east-1, 2026-10-28, go-to-k/cdkd#5467; ${SRC}:1174-1176)`,
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
        Tags: fresh(TAGS),
      },
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        ...CLUSTER_MASTER_USERNAME_SILENT,
        'update-remove:MasterUserPassword': PASSWORD_REMOVED,
        'update-remove:DeletionProtection': KEPT('DeletionProtection', '1183-1184'),
        'update-remove:EnableIAMDatabaseAuthentication': KEPT(
          'EnableIAMDatabaseAuthentication',
          '1217-1220'
        ),
        'update-remove:EngineVersion': KEPT('EngineVersion', '1166-1168, 1182'),
        'update-remove:MonitoringInterval': KEPT('MonitoringInterval', '1212-1216'),
        'update-remove:MonitoringRoleArn': KEPT('MonitoringRoleArn', '1166-1168, 1209-1211'),
        'update-remove:ServerlessV2ScalingConfiguration': KEPT(
          'ServerlessV2ScalingConfiguration',
          '1142-1146, 1166-1168'
        ),
        ...Object.fromEntries(
          ['MinCapacity', 'MaxCapacity', 'SecondsUntilAutoPause'].map((key) => [
            `update-remove:ServerlessV2ScalingConfiguration.${key}`,
            `ModifyDBCluster sends the WHOLE declared block from next, never reading prev (${SRC}:1221-1223, 230-241), so a member removal is delivered by next alone (update-add observes it); a block without SecondsUntilAutoPause resets the live delay to AWS's 300-second default, as CloudFormation measured (go-to-k/cdkd#5466)`,
          ])
        ),
        ...Object.fromEntries(
          [0, 1].map((i) => [
            `update-remove:VpcSecurityGroupIds.${i}`,
            `ModifyDBCluster sends the WHOLE desired list from next (${SRC}:2329-2330), so an element removal is delivered by next alone (update-add observes it); only a whole-list removal reads prev (the VPC default group, :2331-2399)`,
          ])
        ),
      },
      expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
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
      name: 'Multi-AZ DB cluster (mysql), a declared Port',
      bag: { Engine: 'mysql', Port: 3307 },
      expectedSilent: {
        ...CLUSTER_ENGINE_SILENT,
        'update-remove:Port': `a removed Port resets to the engine default on Aurora only, where CloudFormation was measured (#1160); a Multi-AZ DB cluster engine is unmeasured and sends nothing (${SRC}:199-208, 247-259)`,
      },
    },
  ],
};

// --- AWS::RDS::DBInstance ------------------------------------------------------

/** DescribeDBInstances answers the instance available with its ARN: the create wait settles at once. */
function armInstance(): void {
  setOutputOverrides({
    DescribeDBInstancesCommand: () => ({
      DBInstances: [
        {
          DBInstanceIdentifier: INSTANCE_ID,
          DBInstanceArn: INSTANCE_ARN,
          DBInstanceStatus: 'available',
        },
      ],
    }),
  });
}

const INSTANCE_ENGINE_SILENT = Object.fromEntries(
  ['update-add', 'update-remove', 'update-vary'].map((d) => [`${d}:Engine`, INSTANCE_ENGINE])
);

/**
 * The provider's note (rds-provider.ts:1754-1756) calls DBInstanceClass required by the
 * CloudFormation schema, but the registry schema (DescribeType, us-east-1,
 * 2026-10-29) has no top-level `required` for AWS::RDS::DBInstance. What
 * update() does is what is pinned: it sends only a declared class.
 */
const INSTANCE_CLASS_REMOVED = `update() sends only a declared DBInstanceClass (${SRC}:1765), and ModifyDBInstance keeps the live class when none is sent; a removal is unmeasured against CloudFormation`;

const INSTANCE_CASE: TypeCase = {
  resourceType: 'AWS::RDS::DBInstance',
  provider: () => new RDSProvider(),
  physicalId: INSTANCE_ID,
  createOnly: createOnlyOf('AWS::RDS::DBInstance'),
  arm: () => armInstance(),
  exempt: {},
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
  ],
  bags: [
    {
      name: 'standalone PostgreSQL, a template password',
      bag: {
        DBInstanceIdentifier: INSTANCE_ID,
        DBInstanceClass: 'db.t3.micro',
        Engine: 'postgres',
        EngineVersion: '16.4',
        AllocatedStorage: 20,
        MasterUsername: 'admin',
        MasterUserPassword: 'password-1',
        Port: 5433,
        VPCSecurityGroups: ['sg-1', 'sg-2'],
        DBSubnetGroupName: SUBNET_GROUP,
        PubliclyAccessible: false,
        StorageEncrypted: true,
        KmsKeyId: KMS,
        DeletionProtection: true,
        MonitoringRoleArn: MONITORING_ROLE,
        MonitoringInterval: 60,
        EnableIAMDatabaseAuthentication: true,
        Tags: fresh(TAGS),
      },
      expectedSilent: {
        ...INSTANCE_ENGINE_SILENT,
        'update-remove:DBInstanceClass': INSTANCE_CLASS_REMOVED,
        'update-remove:MasterUserPassword': PASSWORD_REMOVED,
        'update-remove:AllocatedStorage': KEPT('AllocatedStorage', '1748-1751, 1771-1773'),
        'update-remove:DeletionProtection': KEPT('DeletionProtection', '1774-1775'),
        'update-remove:EnableIAMDatabaseAuthentication': KEPT(
          'EnableIAMDatabaseAuthentication',
          '1821-1824'
        ),
        'update-remove:EngineVersion': KEPT('EngineVersion', '1748-1751, 1788-1791'),
        'update-remove:MonitoringInterval': KEPT('MonitoringInterval', '1817-1820'),
        'update-remove:MonitoringRoleArn': KEPT('MonitoringRoleArn', '1748-1751, 1814-1816'),
        'update-remove:Port': KEPT('Port', '1748-1751, 1792-1794'),
        'update-remove:PubliclyAccessible': KEPT('PubliclyAccessible', '1748-1751, 1766'),
        'update-remove:VPCSecurityGroups': `not reset on removal: classified UNCERTAIN in the #1160 audit, so update() sends nothing and ModifyDBInstance keeps the live groups (${SRC}:1752-1754, 1797-1799)`,
        ...Object.fromEntries(
          [0, 1].map((i) => [
            `update-remove:VPCSecurityGroups.${i}`,
            `ModifyDBInstance sends the WHOLE desired list from next, never reading prev (${SRC}:1797-1799), so an element removal is delivered by next alone (update-add observes it)`,
          ])
        ),
      },
      expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
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
