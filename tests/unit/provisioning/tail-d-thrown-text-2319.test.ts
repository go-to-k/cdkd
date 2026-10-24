import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2319, the tail-d slice: the RDS (DBProxy, DBProxyEndpoint,
 * DBProxyTargetGroup, DBSubnetGroup / DBCluster / DBInstance), Neptune, DocDB,
 * ElastiCache, EFS, Route 53 and DynamoDB GlobalTable wraps.
 *
 * A thrown wrap is persisted to `deployments/{runId}.jsonl`, so an AWS-authored
 * failure is named by its CLASS plus the --verbose pointer. AWS's text (the
 * caller's role ARN) goes to the masked debug line and stays on `cause`, so the
 * retry classifiers still read it. A delete wrap whose class names ANOTHER
 * object's not-found is marked not-gone, and the cleanup / adopt warns name the
 * class at warn with AWS's text at masked debug.
 */

const { mockSend, debug, warn, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  return {
    mockSend: send,
    debug: vi.fn(),
    warn: vi.fn(),
    fakeClient: () => ({
      send: (command: unknown) => send(command),
      config: {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: () => Promise.resolve(undefined),
      },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
    }),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => new Proxy({}, { get: () => fakeClient() }),
}));
for (const [mod, client] of [
  ['@aws-sdk/client-rds', 'RDSClient'],
  ['@aws-sdk/client-neptune', 'NeptuneClient'],
  ['@aws-sdk/client-docdb', 'DocDBClient'],
  ['@aws-sdk/client-elasticache', 'ElastiCacheClient'],
  ['@aws-sdk/client-efs', 'EFSClient'],
  ['@aws-sdk/client-route-53', 'Route53Client'],
  ['@aws-sdk/client-dynamodb', 'DynamoDBClient'],
  ['@aws-sdk/client-application-auto-scaling', 'ApplicationAutoScalingClient'],
] as const) {
  vi.doMock(mod, async () => {
    const actual = await vi.importActual<Record<string, unknown>>(mod);
    return { ...actual, [client]: vi.fn().mockImplementation(fakeClient) };
  });
}
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccountInfo: () =>
    Promise.resolve({ accountId: '111122223333', region: 'us-east-1', partition: 'aws' }),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

const { RDSDBProxyProvider } = await import(
  '../../../src/provisioning/providers/rds-dbproxy-provider.js'
);
const { RDSDBProxyEndpointProvider } = await import(
  '../../../src/provisioning/providers/rds-dbproxy-endpoint-provider.js'
);
const { RDSDBProxyTargetGroupProvider } = await import(
  '../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js'
);
const { RDSProvider } = await import('../../../src/provisioning/providers/rds-provider.js');
const { NeptuneProvider } = await import('../../../src/provisioning/providers/neptune-provider.js');
const { DocDBProvider } = await import('../../../src/provisioning/providers/docdb-provider.js');
const { ElastiCacheProvider } = await import(
  '../../../src/provisioning/providers/elasticache-provider.js'
);
const { EFSProvider } = await import('../../../src/provisioning/providers/efs-provider.js');
const { Route53Provider } = await import('../../../src/provisioning/providers/route53-provider.js');
const { DynamoDBGlobalTableProvider } = await import(
  '../../../src/provisioning/providers/dynamodb-globaltable-provider.js'
);
const {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} = await import('../../../src/deployment/retryable-errors.js');
const { VERBOSE_POINTER } = await import('../../../src/utils/aws-failure-text.js');
const { isMarkedNotGone } = await import('../../../src/provisioning/not-gone.js');
const { allowUnscopedCreateTokensForTests } = await import(
  '../../../src/provisioning/providers/idempotency-token.js'
);

beforeAll(() => allowUnscopedCreateTokensForTests(true));
afterAll(() => allowUnscopedCreateTokensForTests(false));

const ACCOUNT = '111122223333';
const DENIED = `User: arn:aws:sts::${ACCOUNT}:assumed-role/deployer/s3cr3t is not authorized to perform: x:Y`;
const awsError = (name: string, message: string): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
const denied = (): Error => awsError('AccessDenied', DENIED);
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const ctx = { maskSecrets: mask };
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));
const warnLines = (): string[] => warn.mock.calls.map((c) => String(c[0]));
const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

/**
 * One wrap. `command` fails only that call (the first `nth` one); every other
 * answers `answers[name]`, else `fallback`. `before` instead resolves that many
 * calls in order and fails the next. Neither: every call fails.
 */
type Site = {
  wrap: string;
  run: () => Promise<unknown>;
  command?: string;
  answers?: Record<string, unknown>;
  fallback?: unknown;
  before?: unknown[];
};

function reject(site: Site, rejection: unknown): void {
  if (site.before) {
    for (const r of site.before) mockSend.mockResolvedValueOnce(r);
    mockSend.mockRejectedValueOnce(rejection);
    mockSend.mockResolvedValue({});
    return;
  }
  if (site.command === undefined) {
    mockSend.mockRejectedValue(rejection);
    return;
  }
  let failed = false;
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (name === site.command && !failed) {
      failed = true;
      throw rejection;
    }
    return site.answers?.[name] ?? site.fallback ?? {};
  });
}

// ─── RDS DBProxy / DBProxyEndpoint ────────────────────────────────────

const PROXY = 'AWS::RDS::DBProxy';
const PROXY_PROPS = {
  DBProxyName: 'px-1',
  EngineFamily: 'MYSQL',
  Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:db' }],
  RoleArn: 'arn:aws:iam::1:role/r',
  VpcSubnetIds: ['subnet-a', 'subnet-b'],
};
const PROXY_DESCRIBED = { DBProxies: [{ DBProxyArn: 'arn:aws:rds:us-east-1:1:db-proxy:p' }] };
const EP = 'AWS::RDS::DBProxyEndpoint';
const EP_PROPS = {
  DBProxyEndpointName: 'ep-1',
  DBProxyName: 'px-1',
  VpcSubnetIds: ['subnet-a', 'subnet-b'],
};
const EP_DESCRIBED = {
  DBProxyEndpoints: [{ DBProxyEndpointArn: 'arn:aws:rds:us-east-1:1:db-proxy-endpoint:e' }],
};
const TAGS = [{ Key: 'k', Value: 'v' }];

const proxySites: Site[] = [
  {
    wrap: 'CREATE failed for Px',
    command: 'CreateDBProxyCommand',
    run: () => new RDSDBProxyProvider().create('Px', PROXY, PROXY_PROPS, ctx),
  },
  {
    wrap: 'CREATE (poll) failed for Px',
    command: 'DescribeDBProxiesCommand',
    run: () => new RDSDBProxyProvider().create('Px', PROXY, PROXY_PROPS, ctx),
  },
  {
    wrap: 'UPDATE failed for Px',
    command: 'ModifyDBProxyCommand',
    run: () =>
      new RDSDBProxyProvider().update(
        'Px',
        'px-1',
        PROXY,
        { ...PROXY_PROPS, RequireTLS: true },
        PROXY_PROPS,
        ctx
      ),
  },
  {
    wrap: 'UPDATE (remove tags) failed for Px',
    command: 'RemoveTagsFromResourceCommand',
    answers: { DescribeDBProxiesCommand: PROXY_DESCRIBED },
    run: () =>
      new RDSDBProxyProvider().update(
        'Px',
        'px-1',
        PROXY,
        PROXY_PROPS,
        { ...PROXY_PROPS, Tags: TAGS },
        ctx
      ),
  },
  {
    wrap: 'UPDATE (add tags) failed for Px',
    command: 'AddTagsToResourceCommand',
    answers: { DescribeDBProxiesCommand: PROXY_DESCRIBED },
    run: () =>
      new RDSDBProxyProvider().update(
        'Px',
        'px-1',
        PROXY,
        { ...PROXY_PROPS, Tags: TAGS },
        PROXY_PROPS,
        ctx
      ),
  },
  {
    wrap: 'DELETE failed for Px',
    command: 'DeleteDBProxyCommand',
    run: () => new RDSDBProxyProvider().delete('Px', 'px-1', PROXY, PROXY_PROPS, ctx),
  },
  {
    wrap: 'DELETE (poll) failed for Px',
    command: 'DescribeDBProxiesCommand',
    run: () => new RDSDBProxyProvider().delete('Px', 'px-1', PROXY, PROXY_PROPS, ctx),
  },
  {
    wrap: 'CREATE failed for Ep',
    command: 'CreateDBProxyEndpointCommand',
    run: () => new RDSDBProxyEndpointProvider().create('Ep', EP, EP_PROPS, ctx),
  },
  {
    wrap: 'CREATE (poll) failed for Ep',
    command: 'DescribeDBProxyEndpointsCommand',
    run: () => new RDSDBProxyEndpointProvider().create('Ep', EP, EP_PROPS, ctx),
  },
  {
    wrap: 'UPDATE failed for Ep',
    command: 'ModifyDBProxyEndpointCommand',
    run: () =>
      new RDSDBProxyEndpointProvider().update(
        'Ep',
        'ep-1',
        EP,
        { ...EP_PROPS, VpcSecurityGroupIds: ['sg-2'] },
        { ...EP_PROPS, VpcSecurityGroupIds: ['sg-1'] },
        ctx
      ),
  },
  {
    wrap: 'UPDATE (remove tags) failed for Ep',
    command: 'RemoveTagsFromResourceCommand',
    answers: { DescribeDBProxyEndpointsCommand: EP_DESCRIBED },
    run: () =>
      new RDSDBProxyEndpointProvider().update(
        'Ep',
        'ep-1',
        EP,
        EP_PROPS,
        { ...EP_PROPS, Tags: TAGS },
        ctx
      ),
  },
  {
    wrap: 'UPDATE (add tags) failed for Ep',
    command: 'AddTagsToResourceCommand',
    answers: { DescribeDBProxyEndpointsCommand: EP_DESCRIBED },
    run: () =>
      new RDSDBProxyEndpointProvider().update(
        'Ep',
        'ep-1',
        EP,
        { ...EP_PROPS, Tags: TAGS },
        EP_PROPS,
        ctx
      ),
  },
  {
    wrap: 'DELETE failed for Ep',
    command: 'DeleteDBProxyEndpointCommand',
    run: () => new RDSDBProxyEndpointProvider().delete('Ep', 'ep-1', EP, EP_PROPS, ctx),
  },
  {
    wrap: 'DELETE (poll) failed for Ep',
    command: 'DescribeDBProxyEndpointsCommand',
    run: () => new RDSDBProxyEndpointProvider().delete('Ep', 'ep-1', EP, EP_PROPS, ctx),
  },
];

// ─── RDS DBProxyTargetGroup ───────────────────────────────────────────

const TG = 'AWS::RDS::DBProxyTargetGroup';
const TG_ARN = 'arn:aws:rds:us-east-1:111122223333:target-group:prx-tg-abc';
const TG_DESCRIBED = { TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'default' }] };
const POOL = { MaxConnectionsPercent: 50 };
const tgCreate = (props: Record<string, unknown>) => () =>
  new RDSDBProxyTargetGroupProvider().create('Tg', TG, { DBProxyName: 'P', ...props }, ctx);
const tgUpdate = (props: Record<string, unknown>, prev: Record<string, unknown>) => () =>
  new RDSDBProxyTargetGroupProvider().update(
    'Tg',
    TG_ARN,
    TG,
    { DBProxyName: 'P', ...props },
    { DBProxyName: 'P', ...prev },
    ctx
  );

const targetGroupSites: Site[] = [
  {
    wrap: 'CREATE (pool config) failed for Tg',
    before: [],
    run: tgCreate({ ConnectionPoolConfigurationInfo: POOL }),
  },
  {
    wrap: 'CREATE (register targets) failed for Tg',
    before: [],
    run: tgCreate({ DBClusterIdentifiers: ['c'] }),
  },
  { wrap: 'CREATE (describe) failed for Tg', before: [], run: tgCreate({}) },
  { wrap: 'CREATE (add tags) failed for Tg', before: [TG_DESCRIBED], run: tgCreate({ Tags: TAGS }) },
  {
    wrap: 'UPDATE (pool config) failed for Tg',
    before: [],
    run: tgUpdate({ ConnectionPoolConfigurationInfo: POOL }, {}),
  },
  {
    wrap: 'UPDATE (deregister) failed for Tg',
    before: [],
    run: tgUpdate({ DBClusterIdentifiers: [] }, { DBClusterIdentifiers: ['c'] }),
  },
  {
    wrap: 'UPDATE (register) failed for Tg',
    before: [],
    run: tgUpdate({ DBClusterIdentifiers: ['c'] }, { DBClusterIdentifiers: [] }),
  },
  { wrap: 'UPDATE (remove tags) failed for Tg', before: [], run: tgUpdate({}, { Tags: TAGS }) },
  { wrap: 'UPDATE (add tags) failed for Tg', before: [], run: tgUpdate({ Tags: TAGS }, {}) },
  {
    wrap: 'DELETE failed for Tg',
    before: [],
    run: () =>
      new RDSDBProxyTargetGroupProvider().delete(
        'Tg',
        TG_ARN,
        TG,
        { DBProxyName: 'P', TargetGroupName: 'default', DBClusterIdentifiers: ['c'] },
        { expectedRegion: 'us-east-1', maskSecrets: mask }
      ),
  },
];

// ─── RDS / Neptune / DocDB / ElastiCache ──────────────────────────────

const SUBNETS = { DBSubnetGroupName: 'sg-1', DBSubnetGroupDescription: 'd', SubnetIds: ['a', 'b'] };
const RDS_CLUSTER = { DBClusterIdentifier: 'db-1', Engine: 'aurora-mysql', BackupRetentionPeriod: 7 };
const RDS_INSTANCE = { DBInstanceIdentifier: 'in-1', DBInstanceClass: 'db.t3.micro', Engine: 'mysql' };
const NEPTUNE_CLUSTER = { DBClusterIdentifier: 'db-1', BackupRetentionPeriod: 7 };
const NEPTUNE_INSTANCE = { DBInstanceIdentifier: 'in-1', DBInstanceClass: 'db.r5.large' };
const DOCDB_CLUSTER = {
  DBClusterIdentifier: 'db-1',
  MasterUsername: 'admin',
  MasterUserPassword: 'pw',
  BackupRetentionPeriod: 7,
};
const DOCDB_INSTANCE = {
  DBInstanceIdentifier: 'in-1',
  DBInstanceClass: 'db.r5.large',
  DBClusterIdentifier: 'db-1',
};
const CACHE_SUBNETS = { CacheSubnetGroupName: 'sg', Description: 'd', SubnetIds: ['subnet-1'] };
const CACHE_CLUSTER = {
  ClusterName: 'cc',
  CacheNodeType: 'cache.t3.micro',
  Engine: 'redis',
  NumCacheNodes: 1,
};

const rdsFamilySites: Site[] = [
  {
    wrap: 'Failed to create DBSubnetGroup Sg',
    run: () => new RDSProvider().create('Sg', 'AWS::RDS::DBSubnetGroup', SUBNETS, ctx),
  },
  {
    wrap: 'Failed to update DBSubnetGroup Sg',
    run: () =>
      new RDSProvider().update('Sg', 'sg-1', 'AWS::RDS::DBSubnetGroup', SUBNETS, SUBNETS, ctx),
  },
  {
    wrap: 'Failed to delete DBSubnetGroup Sg',
    run: () => new RDSProvider().delete('Sg', 'sg-1', 'AWS::RDS::DBSubnetGroup', undefined, ctx),
  },
  {
    wrap: 'Failed to create DBCluster Db',
    run: () => new RDSProvider().create('Db', 'AWS::RDS::DBCluster', RDS_CLUSTER, ctx),
  },
  {
    wrap: 'Failed to update DBCluster Db',
    run: () =>
      new RDSProvider().update(
        'Db',
        'db-1',
        'AWS::RDS::DBCluster',
        RDS_CLUSTER,
        { ...RDS_CLUSTER, BackupRetentionPeriod: 1 },
        ctx
      ),
  },
  {
    wrap: 'Failed to delete DBCluster Db',
    run: () => new RDSProvider().delete('Db', 'db-1', 'AWS::RDS::DBCluster', {}, ctx),
  },
  {
    wrap: 'Failed to create DBInstance In',
    run: () => new RDSProvider().create('In', 'AWS::RDS::DBInstance', RDS_INSTANCE, ctx),
  },
  {
    wrap: 'Failed to update DBInstance In',
    run: () =>
      new RDSProvider().update(
        'In',
        'in-1',
        'AWS::RDS::DBInstance',
        { ...RDS_INSTANCE, DBInstanceClass: 'db.t3.small' },
        RDS_INSTANCE,
        ctx
      ),
  },
  {
    wrap: 'Failed to delete DBInstance In',
    run: () => new RDSProvider().delete('In', 'in-1', 'AWS::RDS::DBInstance', {}, ctx),
  },
  {
    wrap: 'Failed to create Neptune DBSubnetGroup Sg',
    run: () => new NeptuneProvider().create('Sg', 'AWS::Neptune::DBSubnetGroup', SUBNETS, ctx),
  },
  {
    wrap: 'Failed to update Neptune DBSubnetGroup Sg',
    run: () =>
      new NeptuneProvider().update(
        'Sg',
        'sg-1',
        'AWS::Neptune::DBSubnetGroup',
        SUBNETS,
        SUBNETS,
        ctx
      ),
  },
  {
    wrap: 'Failed to delete Neptune DBSubnetGroup Sg',
    run: () =>
      new NeptuneProvider().delete('Sg', 'sg-1', 'AWS::Neptune::DBSubnetGroup', undefined, ctx),
  },
  {
    wrap: 'Failed to create Neptune DBCluster Db',
    run: () => new NeptuneProvider().create('Db', 'AWS::Neptune::DBCluster', NEPTUNE_CLUSTER, ctx),
  },
  {
    wrap: 'Failed to update Neptune DBCluster Db',
    run: () =>
      new NeptuneProvider().update(
        'Db',
        'db-1',
        'AWS::Neptune::DBCluster',
        NEPTUNE_CLUSTER,
        { ...NEPTUNE_CLUSTER, BackupRetentionPeriod: 1 },
        ctx
      ),
  },
  {
    wrap: 'Failed to delete Neptune DBCluster Db',
    run: () => new NeptuneProvider().delete('Db', 'db-1', 'AWS::Neptune::DBCluster', {}, ctx),
  },
  {
    wrap: 'Failed to create Neptune DBInstance In',
    run: () =>
      new NeptuneProvider().create('In', 'AWS::Neptune::DBInstance', NEPTUNE_INSTANCE, ctx),
  },
  {
    wrap: 'Failed to update Neptune DBInstance In',
    run: () =>
      new NeptuneProvider().update(
        'In',
        'in-1',
        'AWS::Neptune::DBInstance',
        NEPTUNE_INSTANCE,
        { ...NEPTUNE_INSTANCE, DBInstanceClass: 'db.r5.xlarge' },
        ctx
      ),
  },
  {
    wrap: 'Failed to delete Neptune DBInstance In',
    run: () => new NeptuneProvider().delete('In', 'in-1', 'AWS::Neptune::DBInstance', {}, ctx),
  },
  {
    wrap: 'Failed to create DocDB DBCluster Db',
    run: () => new DocDBProvider().create('Db', 'AWS::DocDB::DBCluster', DOCDB_CLUSTER, ctx),
  },
  {
    wrap: 'Failed to update DocDB DBCluster Db',
    run: () =>
      new DocDBProvider().update(
        'Db',
        'db-1',
        'AWS::DocDB::DBCluster',
        DOCDB_CLUSTER,
        { ...DOCDB_CLUSTER, BackupRetentionPeriod: 1 },
        ctx
      ),
  },
  {
    wrap: 'Failed to delete DocDB DBCluster Db',
    run: () => new DocDBProvider().delete('Db', 'db-1', 'AWS::DocDB::DBCluster', {}, ctx),
  },
  {
    wrap: 'Failed to create DocDB DBInstance In',
    run: () => new DocDBProvider().create('In', 'AWS::DocDB::DBInstance', DOCDB_INSTANCE, ctx),
  },
  {
    wrap: 'Failed to update DocDB DBInstance In',
    run: () =>
      new DocDBProvider().update(
        'In',
        'in-1',
        'AWS::DocDB::DBInstance',
        DOCDB_INSTANCE,
        { ...DOCDB_INSTANCE, DBInstanceClass: 'db.r5.xlarge' },
        ctx
      ),
  },
  {
    wrap: 'Failed to delete DocDB DBInstance In',
    run: () => new DocDBProvider().delete('In', 'in-1', 'AWS::DocDB::DBInstance', {}, ctx),
  },
  {
    wrap: 'Failed to create CacheSubnetGroup Sg',
    run: () =>
      new ElastiCacheProvider().create('Sg', 'AWS::ElastiCache::SubnetGroup', CACHE_SUBNETS, ctx),
  },
  {
    wrap: 'Failed to update CacheSubnetGroup Sg',
    run: () =>
      new ElastiCacheProvider().update(
        'Sg',
        'sg',
        'AWS::ElastiCache::SubnetGroup',
        { ...CACHE_SUBNETS, SubnetIds: ['subnet-2'] },
        CACHE_SUBNETS,
        ctx
      ),
  },
  {
    wrap: 'Failed to delete CacheSubnetGroup Sg',
    run: () =>
      new ElastiCacheProvider().delete(
        'Sg',
        'sg',
        'AWS::ElastiCache::SubnetGroup',
        CACHE_SUBNETS,
        ctx
      ),
  },
  {
    wrap: 'Failed to create CacheCluster Cc',
    run: () =>
      new ElastiCacheProvider().create('Cc', 'AWS::ElastiCache::CacheCluster', CACHE_CLUSTER, ctx),
  },
  {
    wrap: 'Failed to update CacheCluster Cc',
    run: () =>
      new ElastiCacheProvider().update(
        'Cc',
        'cc',
        'AWS::ElastiCache::CacheCluster',
        { ...CACHE_CLUSTER, CacheNodeType: 'cache.t3.small' },
        CACHE_CLUSTER,
        ctx
      ),
  },
  {
    wrap: 'Failed to delete CacheCluster Cc',
    run: () =>
      new ElastiCacheProvider().delete(
        'Cc',
        'cc',
        'AWS::ElastiCache::CacheCluster',
        CACHE_CLUSTER,
        ctx
      ),
  },
];

// ─── EFS ──────────────────────────────────────────────────────────────

const FS_ID = 'fs-0123456789abcdef0';
const efsSites: Site[] = [
  {
    wrap: 'Failed to create EFS FileSystem Fs',
    command: 'CreateFileSystemCommand',
    run: () => new EFSProvider().create('Fs', 'AWS::EFS::FileSystem', {}, ctx),
  },
  {
    wrap: 'Failed to update EFS FileSystem Fs',
    command: 'UpdateFileSystemCommand',
    run: () =>
      new EFSProvider().update(
        'Fs',
        FS_ID,
        'AWS::EFS::FileSystem',
        { ThroughputMode: 'elastic' },
        { ThroughputMode: 'bursting' },
        ctx
      ),
  },
  {
    wrap: 'Failed to delete EFS FileSystem Fs',
    command: 'DeleteFileSystemCommand',
    run: () => new EFSProvider().delete('Fs', FS_ID, 'AWS::EFS::FileSystem', undefined, ctx),
  },
  {
    wrap: 'Failed to create EFS MountTarget Mt',
    command: 'CreateMountTargetCommand',
    run: () =>
      new EFSProvider().create(
        'Mt',
        'AWS::EFS::MountTarget',
        { FileSystemId: FS_ID, SubnetId: 'subnet-0123456789abcdef0' },
        ctx
      ),
  },
  {
    wrap: 'Failed to update EFS MountTarget Mt',
    command: 'ModifyMountTargetSecurityGroupsCommand',
    run: () =>
      new EFSProvider().update(
        'Mt',
        'fsmt-0123456789abcdef0',
        'AWS::EFS::MountTarget',
        { SecurityGroups: ['sg-1'] },
        {},
        ctx
      ),
  },
  {
    wrap: 'Failed to delete EFS MountTarget Mt',
    command: 'DeleteMountTargetCommand',
    run: () =>
      new EFSProvider().delete(
        'Mt',
        'fsmt-0123456789abcdef0',
        'AWS::EFS::MountTarget',
        undefined,
        ctx
      ),
  },
  {
    wrap: 'Failed to create EFS AccessPoint Ap',
    command: 'CreateAccessPointCommand',
    run: () => new EFSProvider().create('Ap', 'AWS::EFS::AccessPoint', { FileSystemId: FS_ID }, ctx),
  },
  {
    wrap: 'Failed to delete EFS AccessPoint Ap',
    command: 'DeleteAccessPointCommand',
    run: () =>
      new EFSProvider().delete(
        'Ap',
        'fsap-0123456789abcdef0',
        'AWS::EFS::AccessPoint',
        undefined,
        ctx
      ),
  },
];

// ─── Route 53 ─────────────────────────────────────────────────────────

const ZONE = 'Z0123456789ABC';
const HZ = 'AWS::Route53::HostedZone';
const RS = 'AWS::Route53::RecordSet';
const RECORD = {
  HostedZoneId: ZONE,
  Name: 'www.example.com.',
  Type: 'A',
  TTL: '300',
  ResourceRecords: ['192.0.2.1'],
};
const route53Sites: Site[] = [
  {
    wrap: 'Failed to create hosted zone Hz',
    command: 'CreateHostedZoneCommand',
    run: () => new Route53Provider().create('Hz', HZ, { Name: 'example.com' }, ctx),
  },
  {
    wrap: 'Failed to update hosted zone Hz',
    command: 'GetHostedZoneCommand',
    run: () =>
      new Route53Provider().update(
        'Hz',
        ZONE,
        HZ,
        { Name: 'example.com' },
        { Name: 'example.com' },
        ctx
      ),
  },
  {
    wrap: 'Failed to remove tag(s) gone from hosted zone Hz',
    command: 'ChangeTagsForResourceCommand',
    run: () =>
      new Route53Provider().update(
        'Hz',
        ZONE,
        HZ,
        { Name: 'example.com', HostedZoneTags: [] },
        { Name: 'example.com', HostedZoneTags: [{ Key: 'gone', Value: 'v' }] },
        ctx
      ),
  },
  {
    wrap: 'Failed to delete hosted zone Hz',
    command: 'DeleteHostedZoneCommand',
    run: () => new Route53Provider().delete('Hz', ZONE, HZ, undefined, ctx),
  },
  {
    wrap: 'Failed to create record set Rs',
    command: 'ChangeResourceRecordSetsCommand',
    run: () => new Route53Provider().create('Rs', RS, RECORD, ctx),
  },
  {
    wrap: 'Failed to update record set Rs',
    command: 'ChangeResourceRecordSetsCommand',
    run: () =>
      new Route53Provider().update(
        'Rs',
        `${ZONE}|www.example.com.|A`,
        RS,
        { ...RECORD, TTL: '60' },
        RECORD,
        ctx
      ),
  },
  {
    wrap: 'Failed to delete record set Rs',
    command: 'ChangeResourceRecordSetsCommand',
    run: () => new Route53Provider().delete('Rs', `${ZONE}|www.example.com.|A`, RS, RECORD, ctx),
  },
];

// ─── DynamoDB GlobalTable ─────────────────────────────────────────────

const TABLE = 't1';
const ACTIVE_TABLE = {
  Table: {
    TableName: TABLE,
    TableArn: `arn:aws:dynamodb:us-east-1:111122223333:table/${TABLE}`,
    TableId: 'table-id-1',
    TableStatus: 'ACTIVE',
    Replicas: [],
  },
};
const GT = 'AWS::DynamoDB::GlobalTable';
const GT_PROPS = {
  TableName: TABLE,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  Replicas: [{ Region: 'us-east-1' }],
};
const globalTableSites: Site[] = [
  {
    wrap: 'Failed to create DynamoDB GlobalTable Gt',
    command: 'CreateTableCommand',
    fallback: ACTIVE_TABLE,
    run: () => new DynamoDBGlobalTableProvider().create('Gt', GT, GT_PROPS, ctx),
  },
  {
    wrap: 'Failed to update DynamoDB GlobalTable Gt',
    command: 'UpdateTableCommand',
    fallback: ACTIVE_TABLE,
    run: () =>
      new DynamoDBGlobalTableProvider().update(
        'Gt',
        TABLE,
        GT,
        { ...GT_PROPS, DeletionProtectionEnabled: true },
        GT_PROPS,
        ctx
      ),
  },
  {
    wrap: 'Failed to describe DynamoDB GlobalTable Gt before delete',
    command: 'DescribeTableCommand',
    fallback: ACTIVE_TABLE,
    run: () => new DynamoDBGlobalTableProvider().delete('Gt', TABLE, GT, {}, ctx),
  },
  {
    wrap: 'Failed to delete DynamoDB GlobalTable Gt',
    command: 'DeleteTableCommand',
    fallback: ACTIVE_TABLE,
    run: () => new DynamoDBGlobalTableProvider().delete('Gt', TABLE, GT, {}, ctx),
  },
];

const sites: Site[] = [
  ...proxySites,
  ...targetGroupSites,
  ...rdsFamilySites,
  ...efsSites,
  ...route53Sites,
  ...globalTableSites,
];
const deleteSites = sites.filter((s) => /delete|DELETE/.test(s.wrap));

describe('tail-d thrown wraps withhold AWS text (#2319)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  it('covers every wrap of the slice', () => {
    expect(sites).toHaveLength(73);
    expect(deleteSites).toHaveLength(22);
  });

  it.each(sites)('$wrap: an AWS-authored failure is named by its class', async (site) => {
    const original = denied();
    // Positive control: the fake failure carries what the wrap must withhold.
    expect(original.message).toContain(`${ACCOUNT}:assumed-role`);
    reject(site, original);

    const failure = await caught(site.run());

    expect(failure.message.startsWith(`${site.wrap}: AccessDenied. ${VERBOSE_POINTER}`)).toBe(true);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(failure.message).not.toContain('not authorized');
    expect(failure.cause).toBe(original);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines().some((l) => l.includes(`${site.wrap}: ${mask(DENIED)}`))).toBe(true);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  // The class itself is AWS-authored text: `mask(failure.summary)` is what keeps
  // a secret spelled inside it out of the thrown (persisted) message.
  it.each(sites)('$wrap: a secret spelled in the class is masked', async (site) => {
    reject(site, awsError('Denieds3cr3tException', 'denied'));

    const failure = await caught(site.run());

    expect(failure.message).toContain(`${site.wrap}: Denied***Exception. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it.each(sites)('$wrap: a cdkd-authored failure keeps its text, masked', async (site) => {
    reject(site, new Error('socket hang up near s3cr3t'));

    const failure = await caught(site.run());

    expect(failure.message).toContain(`${site.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('s3cr3t');
    expect(failure.message).not.toContain(VERBOSE_POINTER);
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it.each(sites)('$wrap: a non-Error throw is withheld, unstamped', async (site) => {
    reject(site, 'raw s3cr3t value');

    const failure = await caught(site.run());

    expect(failure.message).toContain(
      `${site.wrap}: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(false);
  });

  // A delete wrap naming a FOREIGN not-found by its class spells `NotFound`,
  // which the delete classifiers read as "already deleted"; the mark keeps the
  // record (only each provider's typed not-found means gone).
  it.each(deleteSites)('$wrap: a foreign NotFound is marked not gone', async (site) => {
    reject(
      site,
      awsError('KMSNotFoundException', `Key arn:aws:kms:us-east-1:${ACCOUNT}:key/k is pending deletion`)
    );

    const failure = await caught(site.run());

    expect(failure.message).toContain(`${site.wrap}: KMSNotFoundException. ${VERBOSE_POINTER}`);
    expect(isMarkedNotGone(failure)).toBe(true);
  });

  it.each(deleteSites)('$wrap: a failure that is not a NotFound is not marked', async (site) => {
    reject(site, denied());

    const failure = await caught(site.run());

    expect(isMarkedNotGone(failure)).toBe(false);
  });

  // A ConflictException matches no collision pattern by its class, so only the
  // restatement keeps a create-first replacement recognising a taken name.
  const collisionSites = sites.filter((s) => !s.wrap.startsWith('CREATE (pool config)'));
  it.each(collisionSites)('$wrap: restates an "already exists"', async (site) => {
    reject(site, awsError('ConflictException', `A resource named x already exists in ${ACCOUNT}.`));

    const failure = await caught(site.run());

    expect(failure.message).toContain(
      `${site.wrap}: ConflictException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain(ACCOUNT);
    const logicalId = /\b(Px|Ep|Tg|Sg|Db|In|Cc|Fs|Mt|Ap|Hz|Rs|Gt)\b/.exec(site.wrap)![1]!;
    expect(isNameCollisionErrorFrom(failure, logicalId)).toBe(true);
  });
});

describe('an auxiliary call\'s "already exists" is not restated (#2319, #3826)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  const conflict = (): Error =>
    awsError('ConflictException', `A resource named x already exists in ${ACCOUNT}.`);

  it.each([
    {
      wrap: 'CREATE (pool config) failed for Tg',
      logicalId: 'Tg',
      site: targetGroupSites[0]!,
    },
    {
      wrap: `Failed to enable Accelerated Recovery on hosted zone Hz (${ZONE})`,
      logicalId: 'Hz',
      site: {
        wrap: '',
        command: 'UpdateHostedZoneFeaturesCommand',
        answers: { CreateHostedZoneCommand: { HostedZone: { Id: `/hostedzone/${ZONE}` } } },
        run: () =>
          new Route53Provider().create(
            'Hz',
            HZ,
            { Name: 'example.com', HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' } },
            ctx
          ),
      } as Site,
    },
    {
      wrap: 'Failed to create DynamoDB GlobalTable Gt',
      logicalId: 'Gt',
      site: {
        wrap: '',
        command: 'DescribeTableCommand',
        answers: { CreateTableCommand: { TableDescription: { TableName: TABLE } } },
        fallback: ACTIVE_TABLE,
        run: () => new DynamoDBGlobalTableProvider().create('Gt', GT, GT_PROPS, ctx),
      } as Site,
    },
  ])('$wrap', async ({ wrap, logicalId, site }) => {
    reject(site, conflict());

    const failure = await caught(site.run());

    expect(failure.message).toContain(`${wrap}: ConflictException. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('already exists');
    expect(isNameCollisionErrorFrom(failure, logicalId)).toBe(false);
  });
});

describe('cleanup and adopt warns name the class (#2319)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  const expectClassAtWarn = (head: string): void => {
    const warned = warnLines().find((w) => w.includes(head));
    expect(warned).toBeDefined();
    expect(warned).toContain(`${head}AccessDenied. ${VERBOSE_POINTER}`);
    expect(warned).not.toContain(ACCOUNT);
    expect(debugLines().some((d) => d.includes(`${head}${mask(DENIED)}`))).toBe(true);
    expect([...warnLines(), ...debugLines()].join('\n')).not.toContain('s3cr3t');
  };

  it('RDS DBCluster partial-create cleanup', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (commandName(command) === 'CreateDBClusterCommand') {
        return { DBCluster: { DBClusterIdentifier: 'db-1' } };
      }
      throw denied();
    });

    await caught(new RDSProvider().create('Db', 'AWS::RDS::DBCluster', RDS_CLUSTER, ctx));

    expectClassAtWarn('Failed to delete partially-created DBCluster Db (db-1): ');
  });

  it('RDS DBCluster partial-create cleanup keeps a cdkd-authored text', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (commandName(command) === 'CreateDBClusterCommand') {
        return { DBCluster: { DBClusterIdentifier: 'db-1' } };
      }
      throw new Error('socket hang up near s3cr3t');
    });

    await caught(new RDSProvider().create('Db', 'AWS::RDS::DBCluster', RDS_CLUSTER, ctx));

    expect(warnLines().join('\n')).toContain(
      'Failed to delete partially-created DBCluster Db (db-1): socket hang up near ***. THE CLUSTER'
    );
  });

  it('Route 53 rollback DeleteHostedZone after a failed Accelerated Recovery', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateHostedZoneCommand') return { HostedZone: { Id: `/hostedzone/${ZONE}` } };
      if (name === 'UpdateHostedZoneFeaturesCommand' || name === 'DeleteHostedZoneCommand') {
        throw denied();
      }
      return {};
    });

    await caught(
      new Route53Provider().create(
        'Hz',
        HZ,
        { Name: 'example.com', HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' } },
        ctx
      )
    );

    expectClassAtWarn(`Best-effort rollback DeleteHostedZone for ${ZONE} also failed: `);
  });

  it('Route 53 adopt lookup after an "already exists" replay', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateHostedZoneCommand') {
        throw awsError('HostedZoneAlreadyExists', 'A hosted zone has already been created');
      }
      if (name === 'ListHostedZonesByNameCommand') throw denied();
      return {};
    });

    await caught(new Route53Provider().create('Hz', HZ, { Name: 'example.com' }, ctx));

    expectClassAtWarn(
      'CreateHostedZone for example.com was refused as already-existing, and the lookup that would have adopted the existing zone failed: '
    );
  });

  it('EFS FileSystem partial-create rollback', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateFileSystemCommand') {
        return { FileSystemId: FS_ID, CreationTime: new Date() };
      }
      if (name === 'DescribeFileSystemsCommand') {
        return { FileSystems: [{ LifeCycleState: 'available' }] };
      }
      if (name === 'PutLifecycleConfigurationCommand') throw awsError('BadRequest', 'bad');
      if (name === 'DeleteFileSystemCommand') throw denied();
      return {};
    });

    await caught(
      new EFSProvider().create(
        'Fs',
        'AWS::EFS::FileSystem',
        { LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }] },
        ctx
      )
    );

    expectClassAtWarn(`Failed to roll back partially-created EFS FileSystem ${FS_ID}: `);
  });

  it('DynamoDB GlobalTable partial-create cleanup', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateTableCommand') return { TableDescription: { TableName: TABLE } };
      if (name === 'DescribeTableCommand') return ACTIVE_TABLE;
      if (name === 'UpdateTimeToLiveCommand') throw awsError('ValidationException', 'bad');
      if (name === 'DeleteTableCommand') throw denied();
      return {};
    });

    await caught(
      new DynamoDBGlobalTableProvider().create(
        'Gt',
        GT,
        { ...GT_PROPS, TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' } },
        ctx
      )
    );

    expectClassAtWarn(`Partial-create cleanup failed for ${TABLE}: `);
  });

  it('Route 53 adopt read-back after an "already exists" replay', async () => {
    let reference = '';
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (name === 'CreateHostedZoneCommand') {
        // The caller reference the replayed create sent, which the adopt matches.
        reference = (command as { input: { CallerReference: string } }).input.CallerReference;
        throw awsError('HostedZoneAlreadyExists', 'A hosted zone has already been created');
      }
      if (name === 'ListHostedZonesByNameCommand') {
        return {
          HostedZones: [
            { Id: `/hostedzone/${ZONE}`, Name: 'example.com.', CallerReference: reference },
          ],
          IsTruncated: false,
        };
      }
      if (name === 'GetHostedZoneCommand') throw denied();
      return {};
    });

    await caught(new Route53Provider().create('Hz', HZ, { Name: 'example.com' }, ctx));

    expectClassAtWarn(`Adopted hosted zone /hostedzone/${ZONE} but could not read it back: `);
  });

  it('Route 53 import of a hosted zone whose NameServers cannot be read', async () => {
    mockSend.mockResolvedValueOnce({
      HostedZones: [
        { Id: `/hostedzone/${ZONE}`, Name: 'example.com.', Config: { PrivateZone: false } },
      ],
      IsTruncated: false,
    });
    mockSend.mockRejectedValueOnce(denied());

    await new Route53Provider().import({
      logicalId: 'Zone',
      resourceType: HZ,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { Name: 'example.com' },
    });

    const warned = warnLines().find((w) => w.includes('could not read its NameServers'));
    expect(warned).toContain(
      `Imported hosted zone ${ZONE} but could not read its NameServers: AccessDenied. ${VERBOSE_POINTER}`
    );
    expect(warned).not.toContain(ACCOUNT);
    expect(
      debugLines().some((d) =>
        d.includes(`Imported hosted zone ${ZONE} but could not read its NameServers: ${DENIED}`)
      )
    ).toBe(true);
  });

  it('DynamoDB GlobalTable partial-create replica drop', async () => {
    let replicaAdded = false;
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      const input = (command as { input: Record<string, unknown> }).input;
      if (name === 'CreateTableCommand') return { TableDescription: { TableName: TABLE } };
      if (name === 'UpdateTableCommand') {
        const updates = input['ReplicaUpdates'] as Array<Record<string, unknown>> | undefined;
        if (updates?.[0]?.['Delete']) throw denied();
        replicaAdded = true;
        return {};
      }
      if (name === 'DescribeTableCommand') {
        return {
          Table: {
            ...ACTIVE_TABLE.Table,
            Replicas: replicaAdded
              ? [
                  { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
                  { RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' },
                ]
              : [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        };
      }
      if (name === 'UpdateTimeToLiveCommand') throw awsError('ValidationException', 'bad');
      return {};
    });

    await caught(
      new DynamoDBGlobalTableProvider().create(
        'Gt',
        GT,
        {
          ...GT_PROPS,
          Replicas: [{ Region: 'us-east-1' }, { Region: 'us-west-2' }],
          TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
        },
        ctx
      )
    );

    expectClassAtWarn(`Partial-create cleanup: failed to drop replica us-west-2 on ${TABLE}: `);
  });

  it('RDS DBProxyTargetGroup create cleanup note is masked', async () => {
    mockSend
      .mockResolvedValueOnce({ DBProxyTargets: [] }) // Register
      .mockResolvedValueOnce(TG_DESCRIBED) // Describe
      .mockRejectedValueOnce(denied()) // AddTags
      .mockRejectedValueOnce(awsError('Denieds3cr3tException', 'denied')); // Deregister

    const failure = await caught(tgCreate({ DBClusterIdentifiers: ['c'], Tags: TAGS })());

    expect(failure.message).toContain('could not be deregistered (Denied***Exception. Re-run');
    expect(failure.message).not.toContain('s3cr3t');
  });
});

describe('the remaining class-only wraps (#2319)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  it('RDS global-cluster detach failure masks a secret spelled in the class', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      const name = commandName(command);
      if (name === 'DescribeDBClustersCommand') {
        return {
          DBClusters: [
            {
              DBClusterArn: 'arn:aws:rds:us-east-1:111122223333:cluster:db-1',
              Status: 'available',
              DeletionProtection: false,
            },
          ],
        };
      }
      if (name === 'RemoveFromGlobalClusterCommand') {
        throw awsError('Denieds3cr3tException', 'denied');
      }
      return {};
    });

    const failure = await caught(
      new RDSProvider().delete(
        'Db',
        'db-1',
        'AWS::RDS::DBCluster',
        { GlobalClusterIdentifier: 'my-global' },
        ctx
      )
    );

    expect(failure.message).toContain(
      `Failed to delete DBCluster Db: detaching db-1 from global cluster my-global failed (Denied***Exception. ${VERBOSE_POINTER})`
    );
    expect(failure.message).not.toContain('s3cr3t');
  });

  it('Route 53 HostedZoneName lookup withholds a non-Error throw', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (commandName(command) === 'ListHostedZonesByNameCommand') throw 'raw s3cr3t value';
      return {};
    });

    const failure = await caught(
      new Route53Provider().create(
        'Rs',
        RS,
        {
          HostedZoneName: 'example.com.',
          Name: 'www.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['192.0.2.1'],
        },
        ctx
      )
    );

    expect(failure.message).toBe(
      `Could not resolve HostedZoneName "example.com." for record set Rs: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(hasRedactedCause(failure)).toBe(false);
  });
});
