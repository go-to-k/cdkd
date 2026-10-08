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

vi.mock('@aws-sdk/client-neptune', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-neptune')>();
  return {
    ...actual,
    NeptuneClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
    })),
  };
});

import {
  CreateDBClusterCommand,
  CreateDBInstanceCommand,
  DeleteDBClusterCommand,
  DeleteDBInstanceCommand,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-neptune';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';

// go-to-k/cdkd#4606: the live reads a successful deploy asks before deleting
// a fix-forward's earlier Neptune DB cluster or instance (`isSameResource`;
// only `'different'` lets it delete), and the identity a failed CREATE
// journals beside it (`resourceIdentity`, go-to-k/cdkd#4655). Neptune shares
// its identifier namespace with RDS and DocumentDB, and its describe answers
// for their resources too, so a resource of another engine never counts.

const CTX = { expectedRegion: 'us-east-1' };

type Entry =
  | string
  | 'gone'
  | 'empty'
  | Error
  | 'no-id'
  | { answeredAs: string | undefined }
  | { engine: string | undefined; resourceId: string };

interface TypeCase {
  type: 'AWS::Neptune::DBCluster' | 'AWS::Neptune::DBInstance';
  notFoundFault: string;
  /** The identifier a describe of this type was sent, or `undefined` for another command. */
  askedFor: (cmd: unknown) => string | undefined;
  /** One describe response holding the item. */
  respond: (
    identifier: string | undefined,
    resourceId: string | undefined,
    engine: string | undefined
  ) => unknown;
  respondEmpty: () => unknown;
}

const CASES: TypeCase[] = [
  {
    type: 'AWS::Neptune::DBCluster',
    notFoundFault: 'DBClusterNotFoundFault',
    askedFor: (cmd) =>
      cmd instanceof DescribeDBClustersCommand ? cmd.input.DBClusterIdentifier : undefined,
    respond: (identifier, resourceId, engine) => ({
      DBClusters: [
        { DBClusterIdentifier: identifier, DbClusterResourceId: resourceId, Engine: engine },
      ],
    }),
    respondEmpty: () => ({ DBClusters: [] }),
  },
  {
    type: 'AWS::Neptune::DBInstance',
    notFoundFault: 'DBInstanceNotFoundFault',
    askedFor: (cmd) =>
      cmd instanceof DescribeDBInstancesCommand ? cmd.input.DBInstanceIdentifier : undefined,
    respond: (identifier, resourceId, engine) => ({
      DBInstances: [{ DBInstanceIdentifier: identifier, DbiResourceId: resourceId, Engine: engine }],
    }),
    respondEmpty: () => ({ DBInstances: [] }),
  },
];

/**
 * The describe of `c.type` answers per identifier (looked up lower-cased, as
 * Neptune does): a resource id of a `neptune` resource, gone (the not-found
 * fault), an empty list, an error, an item naming another identifier, an item
 * with no resource id, or an item of another (or no) engine. Any other
 * command fails the test.
 */
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
    if (entry === 'no-id') return c.respond(asked.toLowerCase(), undefined, 'neptune');
    if (typeof entry === 'object' && 'answeredAs' in entry) {
      return c.respond(entry.answeredAs, 'db-OTHER', 'neptune');
    }
    if (typeof entry === 'object') {
      return c.respond(asked.toLowerCase(), entry.resourceId, entry.engine);
    }
    // Neptune answers with the identifier lower-cased.
    return c.respond(asked.toLowerCase(), entry, 'neptune');
  });
}

const askedIdentifiers = (c: TypeCase): Array<string | undefined> =>
  mockSend.mock.calls.map(([cmd]) => c.askedFor(cmd));

const denied = (): Error =>
  Object.assign(new Error('not authorized to perform: rds:Describe'), { name: 'AccessDenied' });

describe.each(CASES)('NeptuneProvider.isSameResource for $type (go-to-k/cdkd#4606)', (c) => {
  let provider: NeptuneProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new NeptuneProvider();
  });

  it('another live resource under another resource id is different', async () => {
    live(c, { a: 'db-AAAA', b: 'db-BBBB' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('different');
    // Both were read: the record's first, then the journaled one.
    expect(askedIdentifiers(c)).toEqual(['b', 'a']);
  });

  it('identifiers carrying digits (a generated name) are read and compared', async () => {
    live(c, { 'db1-a2': 'db-AAAA', 'stack-orphan-1a2b3c4d': 'db-CCCC' });
    expect(
      await provider.isSameResource('stack-orphan-1a2b3c4d', { physicalId: 'db1-a2' }, c.type, CTX)
    ).toBe('different');
  });

  it('two identifiers reading back under one resource id are the same resource', async () => {
    live(c, { a: 'db-SAME', b: 'db-SAME' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('same');
  });

  it('a journaled identifier AWS reports gone (fault or empty list) is different once the record reads back', async () => {
    live(c, { a: 'gone', b: 'db-BBBB' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('different');
    live(c, { a: 'empty', b: 'db-BBBB' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('different');
  });

  it('the record resource gone is unknown, not different, whatever the journaled one reads', async () => {
    live(c, { a: 'db-AAAA', b: 'gone' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('unknown');
    live(c, { a: 'gone', b: 'empty' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('unknown');
  });

  it('identifiers equal modulo case are the same without a read', async () => {
    live(c, {});
    expect(await provider.isSameResource('a', { physicalId: 'a' }, c.type, CTX)).toBe('same');
    expect(await provider.isSameResource('MyDb', { physicalId: 'mydb' }, c.type, CTX)).toBe(
      'same'
    );
    expect(await provider.isSameResource('mydb', { physicalId: 'MYDB' }, c.type, CTX)).toBe(
      'same'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a template-cased identifier is read as written and still compared by resource id', async () => {
    live(c, { 'orphan-a': 'db-AAAA', 'orphan-b': 'db-BBBB' });
    expect(
      await provider.isSameResource('Orphan-A', { physicalId: 'Orphan-B' }, c.type, CTX)
    ).toBe('different');
    expect(askedIdentifiers(c)).toEqual(['Orphan-B', 'Orphan-A']);
  });

  it('a read that fails other than with the not-found fault throws (the caller reads it as unknown)', async () => {
    live(c, { a: denied(), b: 'db-BBBB' });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
      'not authorized'
    );
    // The record's read too: a failure there is never "the record is gone".
    live(c, { a: 'db-AAAA', b: denied() });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
      'not authorized'
    );
  });

  it('"not found" in the message alone never reads as gone', async () => {
    const looksGone = Object.assign(new Error('a not found'), { name: 'InternalFailure' });
    live(c, { a: looksGone, b: 'db-BBBB' });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
      'a not found'
    );
  });

  it('a response naming another identifier, or none, throws rather than comparing it', async () => {
    live(c, { a: { answeredAs: 'someone-else' }, b: 'db-BBBB' });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
      'answered for another identifier'
    );
    live(c, { a: 'db-AAAA', b: { answeredAs: 'someone-else' } });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
      'answered for another identifier'
    );
    live(c, { a: { answeredAs: undefined }, b: 'db-BBBB' });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
      'answered for another identifier'
    );
  });

  // The identifier namespace is shared with RDS and DocumentDB, and the
  // describe answers for their resources: one of another engine is never a
  // Neptune resource, on either side.
  it.each(['aurora-postgresql', 'docdb', 'postgres', undefined])(
    'a resource of engine %s throws on either side rather than comparing it',
    async (engine) => {
      live(c, { a: { engine, resourceId: 'db-AAAA' }, b: 'db-BBBB' });
      await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
        'answered for a resource of another engine'
      );
      live(c, { a: 'db-AAAA', b: { engine, resourceId: 'db-BBBB' } });
      await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
        'answered for a resource of another engine'
      );
      // Even sharing the resource id, it is never 'same'.
      live(c, { a: { engine, resourceId: 'db-SAME' }, b: 'db-SAME' });
      await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
        'answered for a resource of another engine'
      );
    }
  );

  it('a neptune engine spelled explicitly is compared (control for the engine check)', async () => {
    live(c, {
      a: { engine: 'neptune', resourceId: 'db-AAAA' },
      b: { engine: 'neptune', resourceId: 'db-BBBB' },
    });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('different');
  });

  it('a response naming no resource id throws rather than reading as gone', async () => {
    live(c, { a: 'no-id', b: 'db-BBBB' });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
      'returned no resource id'
    );
    live(c, { a: 'db-AAAA', b: 'no-id' });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
      'returned no resource id'
    );
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    live(c, { a: 'gone', b: 'db-BBBB' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an id that is not a DB identifier is unknown, with no read', async () => {
    live(c, { a: 'gone', b: 'db-BBBB' });
    const arn = 'arn:aws:rds:us-east-1:123456789012:cluster:a';
    for (const bad of [arn, '', '1abc', 'abc-', 'ab--c', 'a_b', 'a'.repeat(64)]) {
      expect(await provider.isSameResource(bad, { physicalId: 'b' }, c.type, CTX)).toBe('unknown');
      expect(await provider.isSameResource('a', { physicalId: bad }, c.type, CTX)).toBe('unknown');
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the longest legal identifier is read, not refused', async () => {
    const longest = `a${'-b'.repeat(31)}`;
    expect(longest).toHaveLength(63);
    live(c, { [longest]: 'db-AAAA', b: 'db-BBBB' });
    expect(await provider.isSameResource(longest, { physicalId: 'b' }, c.type, CTX)).toBe(
      'different'
    );
  });
});

describe.each(CASES)('NeptuneProvider.resourceIdentity for $type (go-to-k/cdkd#4606)', (c) => {
  let provider: NeptuneProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new NeptuneProvider();
  });

  it('is the live resource id, read under the identifier as written', async () => {
    live(c, { 'mydb-1': 'db-AAAA' });
    expect(await provider.resourceIdentity('MyDb-1', c.type, CTX)).toBe('db-AAAA');
    expect(askedIdentifiers(c)).toEqual(['MyDb-1']);
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

  it('throws on a response naming no resource id, or another identifier', async () => {
    live(c, { a: 'no-id' });
    await expect(provider.resourceIdentity('a', c.type, CTX)).rejects.toThrow(
      'returned no resource id'
    );
    live(c, { a: { answeredAs: 'someone-else' } });
    await expect(provider.resourceIdentity('a', c.type, CTX)).rejects.toThrow(
      'answered for another identifier'
    );
  });

  it('throws on a resource of another engine now holding the identifier (an RDS or DocumentDB one)', async () => {
    live(c, { a: { engine: 'docdb', resourceId: 'db-AAAA' } });
    await expect(provider.resourceIdentity('a', c.type, CTX)).rejects.toThrow(
      'answered for a resource of another engine'
    );
    live(c, { a: { engine: 'neptune', resourceId: 'db-AAAA' } });
    expect(await provider.resourceIdentity('a', c.type, CTX)).toBe('db-AAAA');
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

describe('NeptuneProvider identity reads for another type (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  it.each(['AWS::Neptune::DBSubnetGroup', 'AWS::RDS::DBCluster', 'AWS::DocDB::DBInstance'])(
    '%s is unknown / undefined, with no read',
    async (type) => {
      const provider = new NeptuneProvider();
      expect(await provider.isSameResource('a', { physicalId: 'b' }, type, CTX)).toBe('unknown');
      expect(await provider.resourceIdentity('a', type, CTX)).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    }
  );
});

// The failed CREATE's own failure is often a describe that cannot run, which
// would fail a live identity read too: the create response's resource id
// rides on the failure's mark, and the deploy engine journals it unread.
describe('the created-before-failure mark carries the create response\'s resource id (go-to-k/cdkd#4606)', () => {
  const CLUSTER_PROPS = { DBClusterIdentifier: 'Orphan-Cluster' };
  const INSTANCE_PROPS = {
    DBInstanceIdentifier: 'Orphan-Db',
    DBInstanceClass: 'db.t3.medium',
    DBClusterIdentifier: 'base-cluster',
  };
  const CREATES = [
    ['AWS::Neptune::DBCluster', CLUSTER_PROPS, 'Orphan-Cluster', 'cluster-CREATED'],
    ['AWS::Neptune::DBInstance', INSTANCE_PROPS, 'Orphan-Db', 'db-CREATED'],
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
   * AlreadyExists); every describe is denied.
   */
  function aws(resourceId: string | undefined): void {
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
                Engine: 'neptune',
              },
            }
          : {
              DBInstance: {
                DBInstanceIdentifier: cmd.input.DBInstanceIdentifier!.toLowerCase(),
                DbiResourceId: resourceId,
                Engine: 'neptune',
              },
            };
      }
      if (cmd instanceof DescribeDBClustersCommand || cmd instanceof DescribeDBInstancesCommand) {
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
      const error = await failureOf(new NeptuneProvider().create('Orphan', type, props));
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
      const provider = new NeptuneProvider();
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

  it.each(CREATES)(
    '%s: a create response with no resource id marks the identifier alone',
    async (type, props, identifier) => {
      aws(undefined);
      const error = await failureOf(new NeptuneProvider().create('Orphan', type, props));
      expect(createdBeforeFailure(error, 'Orphan', type)).toBe(identifier);
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', type)).toBeUndefined();
    }
  );

  it('resourceIdentity is a live read only: a denied describe throws even right after the create', async () => {
    aws('db-CREATED');
    const provider = new NeptuneProvider();
    await failureOf(provider.create('Orphan', 'AWS::Neptune::DBInstance', INSTANCE_PROPS));
    await expect(
      provider.resourceIdentity('Orphan-Db', 'AWS::Neptune::DBInstance', CTX)
    ).rejects.toThrow('not authorized');
  });
});

describe.each([
  {
    type: 'AWS::Neptune::DBCluster',
    label: 'Neptune DB cluster',
    isDelete: (cmd: unknown) => cmd instanceof DeleteDBClusterCommand,
    fault: 'DBClusterNotFoundFault',
  },
  {
    type: 'AWS::Neptune::DBInstance',
    label: 'Neptune DB instance',
    isDelete: (cmd: unknown) => cmd instanceof DeleteDBInstanceCommand,
    fault: 'DBInstanceNotFoundFault',
  },
])('NeptuneProvider.delete of a journaled $type already gone (go-to-k/cdkd#4606)', (c) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  it('names it once at info, since the settle then exits 0 with nothing deleted', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (c.isDelete(cmd)) {
        throw Object.assign(new Error('not found'), { name: c.fault });
      }
      throw new Error('unexpected command');
    });
    const provider = new NeptuneProvider();
    await provider.delete('Orphan', 'orphan-db', c.type, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(c.label);
    expect(infos[0]).toContain('orphan-db');
    expect(infos[0]).toContain('already gone');

    // A record's own delete keeps the quiet debug line.
    providerLogger.info.mockClear();
    providerLogger.debug.mockClear();
    await provider.delete('Orphan', 'orphan-db', c.type, {}, { expectedRegion: 'us-east-1' });
    expect(providerLogger.info).not.toHaveBeenCalled();
    expect(
      providerLogger.debug.mock.calls.some(([m]) =>
        String(m).includes('does not exist, skipping deletion')
      )
    ).toBe(true);
  });
});

// The settle end to end with NeptuneProvider: the journaled identifier is
// deleted only while it still reads back under the journaled resource id and
// as a Neptune resource.
describe('the success settle with NeptuneProvider (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  async function settle(liveEntry: Entry, withRecord: boolean) {
    const provider = new NeptuneProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    live(CASES[1]!, { mydb: liveEntry, 'mydb-b': 'db-RECORD' });
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
              resourceType: 'AWS::Neptune::DBInstance',
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
    const stateResources = withRecord
      ? {
          // The fix-forward's record under the same logical id.
          Orphan: {
            physicalId: 'mydb-b',
            resourceType: 'AWS::Neptune::DBInstance',
            provisionedBy: 'sdk',
            properties: {},
          },
        }
      : {};
    const out = await settleJournaledOrphansOnSuccess({
      stateBackend: {
        loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      } as never,
      stackName: 'S',
      region: 'us-east-1',
      stateResources: stateResources as never,
      rollbackOrphans: undefined,
      newerOperations: [],
      foreignHolder: vi.fn(async () => undefined),
      ctx,
      logger: logger as never,
    });
    return { out, del, warned: logger.warn.mock.calls.map((m) => String(m[0])).join('\n') };
  }

  it('the fix-forward: deletes `MyDb` when it reads back under the journaled id and the record holds another', async () => {
    const r = await settle('db-ORPHAN', true);
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.del.mock.calls[0]?.[1]).toBe('MyDb');
    expect(r.out.unaddressed).toBe(0);
  });

  it('keeps `MyDb` when `mydb` now reads back under another DbiResourceId', async () => {
    const r = await settle('db-SOMEONE-ELSE', true);
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });

  it('keeps `MyDb` when `mydb` is now another engine\'s resource, even under the journaled id', async () => {
    const r = await settle({ engine: 'postgres', resourceId: 'db-ORPHAN' }, true);
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(1);
  });

  it('with no record under the logical id, deletes it when the identity matches (control)', async () => {
    const r = await settle('db-ORPHAN', false);
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.out.unaddressed).toBe(0);
  });
});
