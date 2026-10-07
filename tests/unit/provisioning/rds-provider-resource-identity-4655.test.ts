import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));
const providerLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-rds')>();
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
    })),
  };
});

import {
  CreateDBClusterCommand,
  CreateDBInstanceCommand,
  DeleteDBClusterCommand,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';

// go-to-k/cdkd#4655: the identity a failed CREATE journals beside an RDS
// orphan's identifier, and the settle's comparison against it. The token is
// the immutable resource id, so a cluster or instance re-created under the
// identifier (in any case spelling) never matches it.

const CTX = { expectedRegion: 'us-east-1' };

type Entry = string | 'gone' | 'empty' | Error | 'no-id';

interface TypeCase {
  type: 'AWS::RDS::DBCluster' | 'AWS::RDS::DBInstance';
  notFoundFault: string;
  askedFor: (cmd: unknown) => string | undefined;
  respond: (identifier: string, resourceId: string | undefined) => unknown;
  respondEmpty: () => unknown;
}

const CASES: TypeCase[] = [
  {
    type: 'AWS::RDS::DBCluster',
    notFoundFault: 'DBClusterNotFoundFault',
    askedFor: (cmd) =>
      cmd instanceof DescribeDBClustersCommand ? cmd.input.DBClusterIdentifier : undefined,
    respond: (identifier, resourceId) => ({
      DBClusters: [{ DBClusterIdentifier: identifier, DbClusterResourceId: resourceId }],
    }),
    respondEmpty: () => ({ DBClusters: [] }),
  },
  {
    type: 'AWS::RDS::DBInstance',
    notFoundFault: 'DBInstanceNotFoundFault',
    askedFor: (cmd) =>
      cmd instanceof DescribeDBInstancesCommand ? cmd.input.DBInstanceIdentifier : undefined,
    respond: (identifier, resourceId) => ({
      DBInstances: [{ DBInstanceIdentifier: identifier, DbiResourceId: resourceId }],
    }),
    respondEmpty: () => ({ DBInstances: [] }),
  },
];

/** The describe of `c.type` answers per lower-cased identifier, as RDS does. */
function live(c: TypeCase, entries: Record<string, Entry>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    const asked = c.askedFor(cmd);
    if (asked === undefined) throw new Error('unexpected command');
    const entry = entries[asked.toLowerCase()];
    if (entry === undefined || entry === 'gone') {
      throw Object.assign(new Error(`${asked} not found`), { name: c.notFoundFault });
    }
    if (entry === 'empty') return c.respondEmpty();
    if (entry instanceof Error) throw entry;
    if (entry === 'no-id') return c.respond(asked.toLowerCase(), undefined);
    return c.respond(asked.toLowerCase(), entry);
  });
}

const denied = (): Error =>
  Object.assign(new Error('not authorized to perform: rds:Describe'), { name: 'AccessDenied' });

describe.each(CASES)('RDSProvider.resourceIdentity for $type (go-to-k/cdkd#4655)', (c) => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new RDSProvider();
  });

  it('is the live resource id, read under the identifier as written', async () => {
    live(c, { 'mydb-1': 'db-AAAA' });
    expect(await provider.resourceIdentity('MyDb-1', c.type, CTX)).toBe('db-AAAA');
    expect(mockSend.mock.calls.map(([cmd]) => c.askedFor(cmd))).toEqual(['MyDb-1']);
  });

  it('is RESOURCE_NOT_FOUND on the not-found fault name or an empty list', async () => {
    live(c, { a: 'gone' });
    expect(await provider.resourceIdentity('a', c.type, CTX)).toBe(RESOURCE_NOT_FOUND);
    live(c, { a: 'empty' });
    expect(await provider.resourceIdentity('a', c.type, CTX)).toBe(RESOURCE_NOT_FOUND);
  });

  it('throws on any other failure, "not found" in the message included (never gone)', async () => {
    live(c, { a: denied() });
    await expect(provider.resourceIdentity('a', c.type, CTX)).rejects.toThrow('not authorized');
    const looksGone = Object.assign(new Error('a not found'), { name: 'InternalFailure' });
    live(c, { a: looksGone });
    await expect(provider.resourceIdentity('a', c.type, CTX)).rejects.toThrow('a not found');
  });

  it('throws on a response naming no resource id', async () => {
    live(c, { a: 'no-id' });
    await expect(provider.resourceIdentity('a', c.type, CTX)).rejects.toThrow(
      'returned no resource id'
    );
  });

  it('is undefined, with no read, for a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    live(c, { a: 'db-AAAA' });
    expect(await provider.resourceIdentity('a', c.type, CTX)).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is undefined, with no read, for an id that is not a DB identifier', async () => {
    live(c, { a: 'db-AAAA' });
    for (const bad of ['arn:aws:rds:us-east-1:123456789012:db:a', '', '1a', 'a-', 'a--b']) {
      expect(await provider.resourceIdentity(bad, c.type, CTX)).toBeUndefined();
    }
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('RDSProvider.resourceIdentity for another RDS type (go-to-k/cdkd#4655)', () => {
  it('is undefined for a DBSubnetGroup, with no read', async () => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    const provider = new RDSProvider();
    expect(
      await provider.resourceIdentity('a', 'AWS::RDS::DBSubnetGroup', CTX)
    ).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// The failed CREATE's own failure is often a describe that cannot run, which
// would fail a live identity read too: the create response's resource id
// rides on the failure's mark, and the deploy engine journals it unread.
describe('the created-before-failure mark carries the create response\'s resource id (go-to-k/cdkd#4655)', () => {
  const CLUSTER_PROPS = { DBClusterIdentifier: 'Orphan-Cluster', Engine: 'aurora-postgresql' };
  const INSTANCE_PROPS = {
    DBInstanceIdentifier: 'Orphan-Db',
    Engine: 'postgres',
    DBInstanceClass: 'db.t4g.micro',
  };
  const CREATES = [
    ['AWS::RDS::DBCluster', CLUSTER_PROPS, 'Orphan-Cluster', 'cluster-CREATED'],
    ['AWS::RDS::DBInstance', INSTANCE_PROPS, 'Orphan-Db', 'db-CREATED'],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    vi.stubEnv('CDKD_NO_WAIT', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * CreateDB* returns `resourceId` on the first call (a later one answers
   * AlreadyExists); every describe is denied; a cluster delete is refused
   * unless `deleteAllowed`.
   */
  function aws(resourceId: string | undefined, opts: { deleteAllowed?: boolean } = {}): void {
    let creates = 0;
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateDBClusterCommand || cmd instanceof CreateDBInstanceCommand) {
        if (creates++ > 0) {
          throw Object.assign(new Error('already exists'), {
            name:
              cmd instanceof CreateDBClusterCommand
                ? 'DBClusterAlreadyExistsFault'
                : 'DBInstanceAlreadyExists',
          });
        }
        return cmd instanceof CreateDBClusterCommand
          ? {
              DBCluster: {
                DBClusterIdentifier: cmd.input.DBClusterIdentifier!.toLowerCase(),
                DbClusterResourceId: resourceId,
              },
            }
          : {
              DBInstance: {
                DBInstanceIdentifier: cmd.input.DBInstanceIdentifier!.toLowerCase(),
                DbiResourceId: resourceId,
              },
            };
      }
      if (cmd instanceof DescribeDBClustersCommand || cmd instanceof DescribeDBInstancesCommand) {
        throw denied();
      }
      if (cmd instanceof DeleteDBClusterCommand) {
        if (opts.deleteAllowed === true) return {};
        throw denied();
      }
      throw new Error('unexpected command');
    });
  }

  const failureOf = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => {
        throw new Error('the create succeeded');
      },
      (e: unknown) => e
    );

  it.each(CREATES)(
    '%s: a create failing on a denied describe marks the identifier and the returned resource id',
    async (type, props, identifier, createdId) => {
      aws(createdId);
      const error = await failureOf(new RDSProvider().create('Orphan', type, props));
      expect(createdBeforeFailure(error, 'Orphan', type)).toBe(identifier);
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', type)).toBe(createdId);
    }
  );

  // The retry the describe's AccessDenied triggers replays the create, which
  // fails with AlreadyExists: the error finally thrown keeps the FIRST
  // attempt's mark, identity included.
  it.each(CREATES)(
    '%s: a replay failing with AlreadyExists keeps the first attempt\'s resource id',
    async (type, props, identifier, createdId) => {
      aws(createdId);
      const provider = new RDSProvider();
      let attempts = 0;
      const error = await failureOf(
        withRetry(
          () => {
            attempts++;
            return provider.create('Orphan', type, props);
          },
          'Orphan',
          { sleep: async () => {}, maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 }
        )
      );
      expect(attempts).toBeGreaterThan(1);
      expect(createdBeforeFailure(error, 'Orphan', type)).toBe(identifier);
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', type)).toBe(createdId);
    }
  );

  it('a create response with no resource id marks the identifier alone', async () => {
    aws(undefined);
    const error = await failureOf(
      new RDSProvider().create('Orphan', 'AWS::RDS::DBInstance', INSTANCE_PROPS)
    );
    expect(createdBeforeFailure(error, 'Orphan', 'AWS::RDS::DBInstance')).toBe('Orphan-Db');
    expect(
      createdResourceIdentityBeforeFailure(error, 'Orphan', 'AWS::RDS::DBInstance')
    ).toBeUndefined();
  });

  it('a cluster its own cleanup deleted is not marked at all', async () => {
    aws('cluster-CREATED', { deleteAllowed: true });
    const error = await failureOf(
      new RDSProvider().create('Orphan', 'AWS::RDS::DBCluster', CLUSTER_PROPS)
    );
    expect(createdBeforeFailure(error, 'Orphan', 'AWS::RDS::DBCluster')).toBeUndefined();
  });

  it('resourceIdentity is a live read only: a denied describe throws even right after the create', async () => {
    aws('db-CREATED');
    const provider = new RDSProvider();
    await failureOf(provider.create('Orphan', 'AWS::RDS::DBInstance', INSTANCE_PROPS));
    await expect(
      provider.resourceIdentity('Orphan-Db', 'AWS::RDS::DBInstance', CTX)
    ).rejects.toThrow('not authorized');
  });
});

// The parent review's B1 (go-to-k/cdkd#4653): RDS identifiers are
// case-insensitive, so a resource another owner creates under a case variant
// of the orphan's identifier answers to it. The identity read sees its other
// resource id, and the settle keeps it.
describe('the success settle with RDSProvider: a reused identifier is not deleted (go-to-k/cdkd#4655)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  async function settle(liveResourceId: string) {
    const provider = new RDSProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    live(CASES[1]!, { mydb: liveResourceId });
    const journal = {
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [
            {
              logicalId: 'Orphan',
              changeType: 'CREATE',
              resourceType: 'AWS::RDS::DBInstance',
              physicalId: 'MyDb',
              provisionedBy: 'sdk',
              physicalIdRecoveredFromError: true,
              deletionPolicy: 'Delete',
              createdResourceIdentity: 'db-ORPHAN',
              attemptedProperties: {},
            },
          ],
        },
      ],
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      providerRegistry: {
        getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
        getProvider: vi.fn(() => provider),
      },
      region: 'us-east-1',
      logger,
    } as unknown as RollbackExecutorContext;
    const out = await settleJournaledOrphansOnSuccess({
      stateBackend: {
        loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      } as never,
      stackName: 'S',
      region: 'us-east-1',
      // Another stack's (or another logical id's) record spelled in lower case.
      stateResources: {} as never,
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: vi.fn(async () => undefined),
      ctx,
      logger: logger as never,
    });
    return { out, del, warned: logger.warn.mock.calls.map((m) => String(m[0])).join('\n') };
  }

  it('keeps `MyDb` when `mydb` now reads back under another DbiResourceId', async () => {
    const r = await settle('db-SOMEONE-ELSE');
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });

  it('deletes it when the identifier still reads back under the journaled id (control)', async () => {
    const r = await settle('db-ORPHAN');
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.out.unaddressed).toBe(0);
  });
});
