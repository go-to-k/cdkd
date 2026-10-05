import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    DocDBClient: vi.fn().mockImplementation(() => ({
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

import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

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

/**
 * Runs the REAL available-waiter (CDKD_NO_WAIT unset) with every `Date.now()`
 * read a day later than the last, so the poll loop exits on its first deadline
 * check and the waiter throws its own timeout -- the realistic post-create
 * failure. Restores the env and the spy afterwards.
 */
async function withExpiredWaiter<T>(run: () => Promise<T>): Promise<T> {
  const savedNoWait = process.env['CDKD_NO_WAIT'];
  delete process.env['CDKD_NO_WAIT'];
  let now = 1_700_000_000_000;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => (now += 86_400_000));
  try {
    return await run();
  } finally {
    spy.mockRestore();
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  }
}

const fail = (message: string) => () => {
  throw new Error(message);
};

// go-to-k/cdkd#4583: a failure after the create call returned names the
// resource still in AWS for `cdkd rollback --revert-failed`.
describe('DocDBProvider create marks the resource it made before failing (#4583)', () => {
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

  describe('AWS::DocDB::DBCluster', () => {
    const TYPE = 'AWS::DocDB::DBCluster';
    const props = { DBClusterIdentifier: 'my-cluster' };

    it('marks the identifier when DescribeDBClusters fails after CreateDBCluster returned', async () => {
      route({
        CreateDBClusterCommand: () => ({ DBCluster: { DBClusterIdentifier: 'my-cluster' } }),
        DescribeDBClustersCommand: fail('describe throttled'),
      });
      const error = await caught(new DocDBProvider().create('Cluster', TYPE, props));
      expect(createdBeforeFailure(error, 'Cluster', TYPE)).toBe('my-cluster');
    });

    it('marks the identifier a successful create returns when the available-wait times out', async () => {
      route({
        CreateDBClusterCommand: () => ({ DBCluster: { DBClusterIdentifier: 'my-cluster' } }),
        DescribeDBClustersCommand: () => ({ DBClusters: [{ Status: 'available' }] }),
      });
      const { physicalId } = await new DocDBProvider().create('Cluster', TYPE, props);

      route({
        CreateDBClusterCommand: () => ({ DBCluster: { DBClusterIdentifier: 'my-cluster' } }),
        DescribeDBClustersCommand: () => ({ DBClusters: [{ Status: 'creating' }] }),
      });
      const error = await withExpiredWaiter(() =>
        caught(new DocDBProvider().create('Cluster', TYPE, props))
      );
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toContain(
        'Timed out waiting for DocDB DBCluster my-cluster to become available'
      );
      expect(createdBeforeFailure(error, 'Cluster', TYPE)).toBe(physicalId);
    });

    it('does not mark when CreateDBCluster itself fails', async () => {
      route({ CreateDBClusterCommand: fail('DBClusterAlreadyExistsFault') });
      const error = await caught(new DocDBProvider().create('Cluster', TYPE, props));
      expect(createdBeforeFailure(error, 'Cluster', TYPE)).toBeUndefined();
    });

    it('does not mark a malformed-Tags pre-flight refusal', async () => {
      const error = await caught(
        new DocDBProvider().create('Cluster', TYPE, { ...props, Tags: 'not-a-list' })
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'Cluster', TYPE)).toBeUndefined();
    });
  });

  describe('AWS::DocDB::DBInstance', () => {
    const TYPE = 'AWS::DocDB::DBInstance';
    const props = {
      DBInstanceIdentifier: 'my-db',
      DBInstanceClass: 'db.t3.medium',
      DBClusterIdentifier: 'my-cluster',
    };

    it('marks the identifier when DescribeDBInstances fails after CreateDBInstance returned', async () => {
      route({
        CreateDBInstanceCommand: () => ({ DBInstance: { DBInstanceIdentifier: 'my-db' } }),
        DescribeDBInstancesCommand: fail('describe throttled'),
      });
      const error = await caught(new DocDBProvider().create('Db', TYPE, props));
      expect(createdBeforeFailure(error, 'Db', TYPE)).toBe('my-db');
    });

    it('marks the identifier a successful create returns when the available-wait times out', async () => {
      route({
        CreateDBInstanceCommand: () => ({ DBInstance: { DBInstanceIdentifier: 'my-db' } }),
        DescribeDBInstancesCommand: () => ({ DBInstances: [{ DBInstanceStatus: 'available' }] }),
      });
      const { physicalId } = await new DocDBProvider().create('Db', TYPE, props);

      route({
        CreateDBInstanceCommand: () => ({ DBInstance: { DBInstanceIdentifier: 'my-db' } }),
        DescribeDBInstancesCommand: () => ({ DBInstances: [{ DBInstanceStatus: 'creating' }] }),
      });
      const error = await withExpiredWaiter(() => caught(new DocDBProvider().create('Db', TYPE, props)));
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toContain(
        'Timed out waiting for DocDB DBInstance my-db to become available'
      );
      expect(createdBeforeFailure(error, 'Db', TYPE)).toBe(physicalId);
    });

    it('does not mark when CreateDBInstance itself fails', async () => {
      route({ CreateDBInstanceCommand: fail('DBInstanceAlreadyExists') });
      const error = await caught(new DocDBProvider().create('Db', TYPE, props));
      expect(createdBeforeFailure(error, 'Db', TYPE)).toBeUndefined();
    });
  });
});
