import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#6940: a provider that skips a readiness wait under `--no-wait`
// hands the same wait to the deploy (`deferReadiness`), which runs it only if
// it needs the resource. The default mode waits during the create / update and
// defers nothing. Covers RDS DBInstance + DBCluster, ECS Service (update),
// ElastiCache CacheCluster and ACM Certificate; the EC2 types live in
// ec2-deferred-readiness-6940.test.ts.

const { mockSend, waitUntilServicesStableMock } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  waitUntilServicesStableMock: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    acm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger: Record<string, unknown> = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  childLogger['child'] = () => childLogger;
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  };
});

vi.mock('@aws-sdk/client-rds', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  RDSClient: vi.fn(() => ({
    send: mockSend,
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));

vi.mock('@aws-sdk/client-elasticache', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  ElastiCacheClient: vi.fn(() => ({
    send: mockSend,
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  ECSClient: vi.fn(() => ({
    send: mockSend,
    config: { region: () => Promise.resolve('us-east-1') },
  })),
  waitUntilServicesStable: waitUntilServicesStableMock,
}));

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import {
  withDeferredReadinessScope,
  type DeferredReadinessScope,
} from '../../../src/provisioning/deferred-readiness.js';

function scopeFor(logicalId: string, resourceType: string): DeferredReadinessScope {
  return {
    logicalId,
    resourceType,
    deferred: new Map(),
    awaitUpstreamReadiness: async () => undefined,
    awaitUpstreamReadinessRaw: async () => undefined,
    awaitDeferredResource: () => undefined,
  } as DeferredReadinessScope;
}

/** Route each SDK command by class name; anything unlisted answers `{}`. */
function respond(table: Record<string, unknown>): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) =>
    Promise.resolve(table[command.constructor.name] ?? {})
  );
}

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
const CERT_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/abc6940';

interface Case {
  label: string;
  logicalId: string;
  type: string;
  id: string;
  /** Build the provider, with the instance wait (if any) replaced by a spy. */
  setup: () => { run: () => Promise<unknown>; wasWaited: () => boolean; waitCalls: () => unknown[][] };
}

const instanceWait = (provider: object, method: string) => {
  const target = provider as Record<string, (...args: unknown[]) => Promise<unknown>>;
  return vi.spyOn(target, method).mockResolvedValue(undefined);
};

const cases: Case[] = [
  {
    label: 'RDS DBInstance create',
    logicalId: 'Db',
    type: 'AWS::RDS::DBInstance',
    id: 'db-6940',
    setup: () => {
      respond({
        CreateDBInstanceCommand: { DBInstance: { DBInstanceIdentifier: 'db-6940' } },
        DescribeDBInstancesCommand: { DBInstances: [{ DBInstanceStatus: 'available' }] },
      });
      const provider = new RDSProvider();
      const spy = instanceWait(provider, 'waitForInstanceAvailable');
      return {
        run: () =>
          provider.create('Db', 'AWS::RDS::DBInstance', {
            DBInstanceIdentifier: 'db-6940',
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            MasterUsername: 'admin',
            MasterUserPassword: 'secret123',
            AllocatedStorage: '20',
          }),
        wasWaited: () => spy.mock.calls.length > 0,
        waitCalls: () => spy.mock.calls,
      };
    },
  },
  {
    label: 'RDS DBCluster create',
    logicalId: 'Cluster',
    type: 'AWS::RDS::DBCluster',
    id: 'cluster-6940',
    setup: () => {
      respond({
        CreateDBClusterCommand: { DBCluster: { DBClusterIdentifier: 'cluster-6940' } },
        DescribeDBClustersCommand: { DBClusters: [{ Status: 'available' }] },
      });
      const provider = new RDSProvider();
      const spy = instanceWait(provider, 'waitForClusterAvailable');
      return {
        run: () =>
          provider.create('Cluster', 'AWS::RDS::DBCluster', {
            DBClusterIdentifier: 'cluster-6940',
            Engine: 'aurora-postgresql',
            MasterUsername: 'admin',
            MasterUserPassword: 'secret123',
          }),
        wasWaited: () => spy.mock.calls.length > 0,
        waitCalls: () => spy.mock.calls,
      };
    },
  },
  {
    label: 'ElastiCache CacheCluster create',
    logicalId: 'Cache',
    type: 'AWS::ElastiCache::CacheCluster',
    id: 'cache-6940',
    setup: () => {
      respond({
        CreateCacheClusterCommand: { CacheCluster: { CacheClusterId: 'cache-6940' } },
        DescribeCacheClustersCommand: {
          CacheClusters: [{ CacheClusterId: 'cache-6940', CacheClusterStatus: 'available' }],
        },
      });
      const provider = new ElastiCacheProvider();
      const spy = instanceWait(provider, 'waitForClusterAvailable');
      return {
        run: () =>
          provider.create('Cache', 'AWS::ElastiCache::CacheCluster', {
            ClusterName: 'cache-6940',
            CacheNodeType: 'cache.t3.micro',
            Engine: 'redis',
            NumCacheNodes: 1,
          }),
        wasWaited: () => spy.mock.calls.length > 0,
        waitCalls: () => spy.mock.calls,
      };
    },
  },
  {
    label: 'ACM Certificate create',
    logicalId: 'Cert',
    type: 'AWS::CertificateManager::Certificate',
    id: CERT_ARN,
    setup: () => {
      respond({ RequestCertificateCommand: { CertificateArn: CERT_ARN } });
      const provider = new ACMCertificateProvider();
      const spy = instanceWait(provider, 'waitForCertificateIssued');
      return {
        run: () =>
          provider.create('Cert', 'AWS::CertificateManager::Certificate', {
            DomainName: 'example.com',
            ValidationMethod: 'DNS',
          }),
        wasWaited: () => spy.mock.calls.length > 0,
        waitCalls: () => spy.mock.calls,
      };
    },
  },
];

describe.each(cases)('$label readiness under --no-wait (#6940)', (c) => {
  beforeEach(() => {
    mockSend.mockReset();
    resetIdempotencyTokensForTests();
    delete process.env['CDKD_NO_WAIT'];
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
    vi.restoreAllMocks();
  });

  it('defers the skipped wait, unstarted, and the deferred wait is the same waiter', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    const { run, wasWaited, waitCalls } = c.setup();
    const scope = scopeFor(c.logicalId, c.type);
    await withDeferredReadinessScope(scope, run);
    expect(wasWaited()).toBe(false);
    expect([...scope.deferred.keys()]).toStrictEqual([c.id]);

    const signal = new AbortController().signal;
    await scope.deferred.get(c.id)!.wait(signal);
    expect(waitCalls()).toHaveLength(1);
    expect(waitCalls()[0]).toContain(signal);
  });

  it('the default mode waits during the create and defers nothing', async () => {
    const { run, wasWaited, waitCalls } = c.setup();
    const scope = scopeFor(c.logicalId, c.type);
    await withDeferredReadinessScope(scope, run);
    expect(wasWaited()).toBe(true);
    expect(waitCalls()).toHaveLength(1);
    expect(scope.deferred.size).toBe(0);
  });
});

describe('ECS Service update readiness under --no-wait (#6940)', () => {
  const props = {
    Cluster: 'my-cluster',
    ServiceName: 'my-service',
    TaskDefinition: 'my-task:1',
    DesiredCount: 1,
  };

  function update(): Promise<unknown> {
    return new ECSProvider().update(
      'Svc',
      SERVICE_ARN,
      'AWS::ECS::Service',
      { ...props, DesiredCount: 2 },
      props
    );
  }

  beforeEach(() => {
    mockSend.mockReset();
    waitUntilServicesStableMock.mockReset();
    waitUntilServicesStableMock.mockResolvedValue({ state: 'SUCCESS' });
    respond({
      UpdateServiceCommand: { service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' } },
    });
    delete process.env['CDKD_NO_WAIT'];
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  it('defers the steady-state wait, unstarted, and the deferred wait runs the same waiter', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    const scope = scopeFor('Svc', 'AWS::ECS::Service');
    await withDeferredReadinessScope(scope, update);
    expect(waitUntilServicesStableMock).not.toHaveBeenCalled();
    expect([...scope.deferred.keys()]).toHaveLength(1);

    const controller = new AbortController();
    await [...scope.deferred.values()][0]!.wait(controller.signal);
    expect(waitUntilServicesStableMock).toHaveBeenCalledTimes(1);
    // The waiter's abortSignal follows the deploy's signal.
    const [config] = waitUntilServicesStableMock.mock.calls[0]!;
    const waiterSignal = (config as { abortSignal: AbortSignal }).abortSignal;
    expect(waiterSignal.aborted).toBe(false);
    controller.abort();
    expect(waiterSignal.aborted).toBe(true);
  });

  it('the default mode waits during the update and defers nothing', async () => {
    const scope = scopeFor('Svc', 'AWS::ECS::Service');
    await withDeferredReadinessScope(scope, update);
    expect(waitUntilServicesStableMock).toHaveBeenCalledTimes(1);
    expect(scope.deferred.size).toBe(0);
  });
});
