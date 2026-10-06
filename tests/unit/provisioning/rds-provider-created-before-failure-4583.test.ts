import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-rds')>('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Makes every `Date.now()` read a full day later than the last, so the REAL
 * available-waiter exits on its first deadline check and throws its own
 * timeout -- the realistic post-create failure, reached here with
 * `CDKD_NO_WAIT` unset. The waiter throws a plain `Error`, so it reaches the
 * mark through the wrap arm.
 */
function expireEveryDeadline(): void {
  let now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 86_400_000));
}

/** Route each SDK command by its class name to a handler. */
function route(handlers: Record<string, () => unknown>): void {
  mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    const handler = handlers[command.constructor.name];
    if (!handler) throw new Error(`unexpected ${command.constructor.name}`);
    return handler();
  });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const fail = (message: string) => () => {
  throw new Error(message);
};

// go-to-k/cdkd#4583: a failure after the create call returned names the
// resource still in AWS for `cdkd rollback --revert-failed`.
describe('RDSProvider create marks the resource it made before failing (#4583)', () => {
  let saved: string | undefined;

  beforeEach(() => {
    mockSend.mockReset();
    saved = process.env['CDKD_NO_WAIT'];
    process.env['CDKD_NO_WAIT'] = 'true';
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = saved;
  });

  describe('AWS::RDS::DBInstance', () => {
    const TYPE = 'AWS::RDS::DBInstance';
    const props = { DBInstanceIdentifier: 'my-db', DBInstanceClass: 'db.t3.micro', Engine: 'mysql' };

    it('marks the identifier when DescribeDBInstances fails after CreateDBInstance returned', async () => {
      route({
        CreateDBInstanceCommand: () => ({ DBInstance: { DBInstanceIdentifier: 'my-db' } }),
        DescribeDBInstancesCommand: fail('describe throttled'),
      });
      const error = await caught(new RDSProvider().create('Db', TYPE, props));
      expect(createdBeforeFailure(error, 'Db', TYPE)).toBe('my-db');
    });

    it('marks the id a successful create returns when the real available-wait times out', async () => {
      delete process.env['CDKD_NO_WAIT'];
      route({
        CreateDBInstanceCommand: () => ({ DBInstance: { DBInstanceIdentifier: 'my-db' } }),
        DescribeDBInstancesCommand: () => ({
          DBInstances: [{ DBInstanceIdentifier: 'my-db', DBInstanceStatus: 'available' }],
        }),
      });
      const { physicalId } = await new RDSProvider().create('Db', TYPE, props);

      mockSend.mockReset();
      route({
        CreateDBInstanceCommand: () => ({ DBInstance: { DBInstanceIdentifier: 'my-db' } }),
      });
      expireEveryDeadline();
      try {
        const error = await caught(new RDSProvider().create('Db', TYPE, props));
        expect(error).toBeInstanceOf(ProvisioningError);
        expect((error as Error).message).toContain(
          'Timed out waiting for DBInstance my-db to become available'
        );
        expect(createdBeforeFailure(error, 'Db', TYPE)).toBe(physicalId);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('does not mark when CreateDBInstance itself fails', async () => {
      route({ CreateDBInstanceCommand: fail('DBInstanceAlreadyExists') });
      const error = await caught(new RDSProvider().create('Db', TYPE, props));
      expect(createdBeforeFailure(error, 'Db', TYPE)).toBeUndefined();
    });

    it('does not mark a malformed-Tags pre-flight refusal', async () => {
      const error = await caught(
        new RDSProvider().create('Db', TYPE, { ...props, Tags: 'not-a-list' })
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'Db', TYPE)).toBeUndefined();
    });
  });

  describe('AWS::RDS::DBCluster', () => {
    const TYPE = 'AWS::RDS::DBCluster';
    const props = { DBClusterIdentifier: 'my-cluster', Engine: 'aurora-mysql' };

    it('marks the identifier when the self-cleanup DeleteDBCluster fails', async () => {
      route({
        CreateDBClusterCommand: () => ({ DBCluster: { DBClusterIdentifier: 'my-cluster' } }),
        DescribeDBClustersCommand: fail('describe throttled'),
        DeleteDBClusterCommand: fail('delete refused'),
      });
      const error = await caught(new RDSProvider().create('Cluster', TYPE, props));
      expect(createdBeforeFailure(error, 'Cluster', TYPE)).toBe('my-cluster');
    });

    it('marks the id a successful create returns when the real available-wait times out and the cleanup fails', async () => {
      delete process.env['CDKD_NO_WAIT'];
      route({
        CreateDBClusterCommand: () => ({ DBCluster: { DBClusterIdentifier: 'my-cluster' } }),
        DescribeDBClustersCommand: () => ({
          DBClusters: [{ DBClusterIdentifier: 'my-cluster', Status: 'available' }],
        }),
      });
      const { physicalId } = await new RDSProvider().create('Cluster', TYPE, props);

      mockSend.mockReset();
      route({
        CreateDBClusterCommand: () => ({ DBCluster: { DBClusterIdentifier: 'my-cluster' } }),
        DeleteDBClusterCommand: fail('delete refused'),
      });
      expireEveryDeadline();
      try {
        const error = await caught(new RDSProvider().create('Cluster', TYPE, props));
        expect(error).toBeInstanceOf(ProvisioningError);
        expect((error as Error).message).toContain(
          'Timed out waiting for DBCluster my-cluster to become available'
        );
        expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toContain(
          'DeleteDBClusterCommand'
        );
        expect(createdBeforeFailure(error, 'Cluster', TYPE)).toBe(physicalId);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('does not mark when the self-cleanup DeleteDBCluster succeeded', async () => {
      route({
        CreateDBClusterCommand: () => ({ DBCluster: { DBClusterIdentifier: 'my-cluster' } }),
        DescribeDBClustersCommand: fail('describe throttled'),
        DeleteDBClusterCommand: () => ({}),
      });
      const error = await caught(new RDSProvider().create('Cluster', TYPE, props));
      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toContain(
        'DeleteDBClusterCommand'
      );
      expect(createdBeforeFailure(error, 'Cluster', TYPE)).toBeUndefined();
    });

    it('does not mark when CreateDBCluster itself fails', async () => {
      route({ CreateDBClusterCommand: fail('DBClusterAlreadyExistsFault') });
      const error = await caught(new RDSProvider().create('Cluster', TYPE, props));
      expect(createdBeforeFailure(error, 'Cluster', TYPE)).toBeUndefined();
    });
  });
});
