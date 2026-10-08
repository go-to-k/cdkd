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

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-docdb')>();
  return {
    ...actual,
    DocDBClient: vi.fn().mockImplementation(() => ({
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
} from '@aws-sdk/client-docdb';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier DocDB cluster or instance (only
// `'different'` lets it delete), and the resource id a failed CREATE journals
// beside the orphan's identifier for the settle to compare. DocumentDB shares
// one identifier namespace (and one describe) with RDS and Neptune, so an
// answer naming another engine's resource is never this provider's.

const CTX = { expectedRegion: 'us-east-1' };

/**
 * One identifier's describe answer: a resource id (engine `docdb`), gone (the
 * not-found fault), an empty list, an error, an item naming another
 * identifier, an item with no resource id, or a resource of another engine
 * (`undefined` = the response names no engine).
 */
type Entry =
  | string
  | 'gone'
  | 'empty'
  | Error
  | 'no-id'
  | { answeredAs: string | undefined }
  | { engine: string | undefined; resourceId: string };

interface TypeCase {
  type: 'AWS::DocDB::DBCluster' | 'AWS::DocDB::DBInstance';
  notFoundFault: string;
  /** The identifier a describe of this type was sent, or `undefined` for another command. */
  askedFor: (cmd: unknown) => string | undefined;
  respond: (
    identifier: string | undefined,
    resourceId: string | undefined,
    engine: string | undefined
  ) => unknown;
  respondEmpty: () => unknown;
}

const CASES: TypeCase[] = [
  {
    type: 'AWS::DocDB::DBCluster',
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
    type: 'AWS::DocDB::DBInstance',
    notFoundFault: 'DBInstanceNotFoundFault',
    askedFor: (cmd) =>
      cmd instanceof DescribeDBInstancesCommand ? cmd.input.DBInstanceIdentifier : undefined,
    respond: (identifier, resourceId, engine) => ({
      DBInstances: [{ DBInstanceIdentifier: identifier, DbiResourceId: resourceId, Engine: engine }],
    }),
    respondEmpty: () => ({ DBInstances: [] }),
  },
];

/** The describe of `c.type` answers per lower-cased identifier, as the service does. */
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
    if (entry === 'no-id') return c.respond(asked.toLowerCase(), undefined, 'docdb');
    if (typeof entry === 'object' && 'answeredAs' in entry) {
      return c.respond(entry.answeredAs, 'db-OTHER', 'docdb');
    }
    if (typeof entry === 'object') return c.respond(asked.toLowerCase(), entry.resourceId, entry.engine);
    return c.respond(asked.toLowerCase(), entry, 'docdb');
  });
}

const askedIdentifiers = (c: TypeCase): Array<string | undefined> =>
  mockSend.mock.calls.map(([cmd]) => c.askedFor(cmd));

const denied = (): Error =>
  Object.assign(new Error('not authorized to perform: rds:Describe'), { name: 'AccessDenied' });

describe.each(CASES)('DocDBProvider.isSameResource for $type (go-to-k/cdkd#4606)', (c) => {
  let provider: DocDBProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new DocDBProvider();
  });

  it('another live resource under another resource id is different', async () => {
    live(c, { a: 'db-AAAA', b: 'db-BBBB' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('different');
    // Both were read: the record's first, then the journaled one.
    expect(askedIdentifiers(c)).toEqual(['b', 'a']);
  });

  it('identifiers carrying digits (a generated name, a user-set mydb1) are read and compared', async () => {
    live(c, { 'db1-a2': 'db-AAAA', 'db1-b2': 'db-BBBB', 'stack-orphan-1a2b3c4d': 'db-CCCC' });
    expect(await provider.isSameResource('db1-a2', { physicalId: 'db1-b2' }, c.type, CTX)).toBe(
      'different'
    );
    expect(
      await provider.isSameResource('stack-orphan-1a2b3c4d', { physicalId: 'db1-b2' }, c.type, CTX)
    ).toBe('different');
  });

  it('two identifiers reading back under one resource id are the same resource', async () => {
    live(c, { a: 'db-SAME', b: 'db-SAME' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('same');
  });

  it('a journaled identifier AWS reports gone is different once the record reads back', async () => {
    live(c, { a: 'gone', b: 'db-BBBB' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('different');
  });

  it('an empty describe list for the journaled identifier reads as gone', async () => {
    live(c, { a: 'empty', b: 'db-BBBB' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('different');
  });

  it('the record resource gone is unknown, not different, whatever the journaled one reads', async () => {
    live(c, { a: 'db-AAAA', b: 'gone' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('unknown');
    live(c, { a: 'gone', b: 'empty' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('unknown');
  });

  it('identifiers equal modulo case are the same without a read (identifiers are case-insensitive)', async () => {
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

  // The shared describe returns RDS and Neptune resources too: a journaled
  // identifier now held by another engine's resource must never read as a
  // DocDB resource this provider may delete, nor as gone.
  it.each(['aurora-postgresql', 'neptune', 'postgres', undefined])(
    'a journaled identifier answering with engine %s throws (the caller reads it as unknown)',
    async (engine) => {
      live(c, { a: { engine, resourceId: 'db-AAAA' }, b: 'db-BBBB' });
      await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
        'a resource of another engine'
      );
    }
  );

  it.each(['aurora-postgresql', 'neptune', undefined])(
    "the record's identifier answering with engine %s throws too",
    async (engine) => {
      live(c, { a: 'db-AAAA', b: { engine, resourceId: 'db-BBBB' } });
      await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
        'a resource of another engine'
      );
    }
  );

  it('engine docdb, spelled out, is compared (control for the engine check)', async () => {
    live(c, {
      a: { engine: 'docdb', resourceId: 'db-AAAA' },
      b: { engine: 'docdb', resourceId: 'db-BBBB' },
    });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).toBe('different');
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
    const arn = 'arn:aws:rds:us-east-1:123456789012:db:a';
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

describe('DocDBProvider.isSameResource / resourceIdentity for another type (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  it.each(['AWS::DocDB::DBSubnetGroup', 'AWS::RDS::DBCluster', 'AWS::RDS::DBInstance'])(
    '%s is unknown / undefined, with no read',
    async (type) => {
      const provider = new DocDBProvider();
      expect(await provider.isSameResource('a', { physicalId: 'b' }, type, CTX)).toBe('unknown');
      expect(await provider.resourceIdentity('a', type, CTX)).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    }
  );
});

describe.each(CASES)('DocDBProvider.resourceIdentity for $type (go-to-k/cdkd#4606)', (c) => {
  let provider: DocDBProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new DocDBProvider();
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

  it('throws on another engine\'s resource under the identifier, never naming its id', async () => {
    live(c, { a: { engine: 'aurora-mysql', resourceId: 'db-AURORA' } });
    await expect(provider.resourceIdentity('a', c.type, CTX)).rejects.toThrow(
      'a resource of another engine'
    );
    live(c, { a: { engine: 'docdb', resourceId: 'db-DOCDB' } });
    expect(await provider.resourceIdentity('a', c.type, CTX)).toBe('db-DOCDB');
  });

  it('is undefined, with no read, for a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    live(c, { a: 'db-AAAA' });
    expect(await provider.resourceIdentity('a', c.type, CTX)).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is undefined, with no read, for an id that is not a DB identifier', async () => {
    live(c, { a: 'db-AAAA' });
    for (const bad of ['arn:aws:rds:us-east-1:123456789012:cluster:a', '', '1a', 'a-', 'a--b']) {
      expect(await provider.resourceIdentity(bad, c.type, CTX)).toBeUndefined();
    }
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// The failed CREATE's own failure is often a describe that cannot run, which
// would fail a live identity read too: the create response's resource id
// rides on the failure's mark, and the deploy engine journals it unread.
describe("the created-before-failure mark carries the create response's resource id (go-to-k/cdkd#4606)", () => {
  const CLUSTER_PROPS = {
    DBClusterIdentifier: 'Orphan-Cluster',
    MasterUsername: 'u',
    MasterUserPassword: 'p',
  };
  const INSTANCE_PROPS = {
    DBInstanceIdentifier: 'Orphan-Db',
    DBInstanceClass: 'db.t3.medium',
    DBClusterIdentifier: 'host-cluster',
  };
  const CREATES = [
    ['AWS::DocDB::DBCluster', CLUSTER_PROPS, 'Orphan-Cluster', 'cluster-CREATED'],
    ['AWS::DocDB::DBInstance', INSTANCE_PROPS, 'Orphan-Db', 'db-CREATED'],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
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
                Engine: 'docdb',
              },
            }
          : {
              DBInstance: {
                DBInstanceIdentifier: cmd.input.DBInstanceIdentifier!.toLowerCase(),
                DbiResourceId: resourceId,
                Engine: 'docdb',
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

  // Both arms: the available-wait's describe (default) and, under
  // CDKD_NO_WAIT, the final describe.
  it.each(CREATES.flatMap((row) => [[...row, 'wait'] as const, [...row, 'no-wait'] as const]))(
    '%s: a create failing on a denied describe (%s) marks the identifier and the returned resource id',
    async (type, props, identifier, createdId, mode) => {
      if (mode === 'no-wait') vi.stubEnv('CDKD_NO_WAIT', 'true');
      aws(createdId);
      const error = await failureOf(new DocDBProvider().create('Orphan', type, props));
      expect(createdBeforeFailure(error, 'Orphan', type)).toBe(identifier);
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', type)).toBe(createdId);
    }
  );

  // The retry the describe's AccessDenied triggers replays the create, which
  // fails with AlreadyExists: the error finally thrown keeps the FIRST
  // attempt's mark, identity included.
  it.each(CREATES)(
    "%s: a replay failing with AlreadyExists keeps the first attempt's resource id",
    async (type, props, identifier, createdId) => {
      vi.stubEnv('CDKD_NO_WAIT', 'true');
      aws(createdId);
      const provider = new DocDBProvider();
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
      vi.stubEnv('CDKD_NO_WAIT', 'true');
      aws(undefined);
      const error = await failureOf(new DocDBProvider().create('Orphan', type, props));
      expect(createdBeforeFailure(error, 'Orphan', type)).toBe(identifier);
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', type)).toBeUndefined();
    }
  );

  it.each(CREATES)(
    '%s: a create AWS refused marks nothing, identity included',
    async (type, props) => {
      mockSend.mockImplementation(async () => {
        throw denied();
      });
      const error = await failureOf(new DocDBProvider().create('Orphan', type, props));
      expect(createdBeforeFailure(error, 'Orphan', type)).toBeUndefined();
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', type)).toBeUndefined();
    }
  );
});

describe.each([
  {
    type: 'AWS::DocDB::DBCluster',
    label: 'DocDB DB cluster',
    isDelete: (cmd: unknown) => cmd instanceof DeleteDBClusterCommand,
    fault: 'DBClusterNotFoundFault',
  },
  {
    type: 'AWS::DocDB::DBInstance',
    label: 'DocDB DB instance',
    isDelete: (cmd: unknown) => cmd instanceof DeleteDBInstanceCommand,
    fault: 'DBInstanceNotFoundFault',
  },
])('DocDBProvider.delete of a journaled $type already gone (go-to-k/cdkd#4606)', (c) => {
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
    const provider = new DocDBProvider();
    await provider.delete('Orphan', 'orphan-db', c.type, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain(c.label);
    expect(infos[0]).toContain('orphan-db');
    expect(infos[0]).toContain('already gone');

    // A record's own delete keeps the quiet debug line, the flag absent or false.
    const skipDebugLines = (): number =>
      providerLogger.debug.mock.calls.filter(([m]) =>
        String(m).includes('does not exist, skipping deletion')
      ).length;
    for (const context of [
      { expectedRegion: 'us-east-1' },
      { expectedRegion: 'us-east-1', failedCreateOrphan: false },
    ]) {
      providerLogger.info.mockClear();
      providerLogger.debug.mockClear();
      await provider.delete('Orphan', 'orphan-db', c.type, {}, context);
      expect(providerLogger.info).not.toHaveBeenCalled();
      expect(skipDebugLines()).toBe(1);
    }
  });
});

// DocDB identifiers are case-insensitive and shared with RDS and Neptune, so a
// resource another owner creates under the orphan's identifier (a case
// variant, or another engine) answers to it. The settle keeps it.
describe('the success settle with DocDBProvider: a reused identifier is not deleted (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  /**
   * `fixForward`: the fix-forward's record under the orphan's logical id holds
   * `mydb-b` (this deploy's CREATE), read live under `recordResourceId`.
   */
  async function settle(
    c: TypeCase,
    liveEntry: Entry,
    fixForward?: { recordResourceId: string }
  ) {
    const provider = new DocDBProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    live(c, {
      mydb: liveEntry,
      ...(fixForward !== undefined && { 'mydb-b': fixForward.recordResourceId }),
    });
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
              resourceType: c.type,
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
      stateResources: (fixForward === undefined
        ? {}
        : {
            Orphan: {
              physicalId: 'mydb-b',
              resourceType: c.type,
              provisionedBy: 'sdk',
              properties: {},
              attributes: {},
            },
          }) as never,
      rollbackOrphans: undefined,
      newerOperations: (fixForward === undefined
        ? []
        : [
            { logicalId: 'Orphan', changeType: 'CREATE', resourceType: c.type, physicalId: 'mydb-b' },
          ]) as never,
      foreignHolder: vi.fn(async () => undefined),
      ctx,
      logger: logger as never,
    });
    return { out, del, warned: logger.warn.mock.calls.map((m) => String(m[0])).join('\n') };
  }

  describe.each(CASES)('$type', (c) => {
    it('keeps `MyDb` when `mydb` now reads back under another resource id', async () => {
      const r = await settle(c, 'db-SOMEONE-ELSE');
      expect(r.del).not.toHaveBeenCalled();
      expect(r.warned).toContain('the resource now under its physical id is another one');
      expect(r.out.unaddressed).toBe(1);
    });

    it("keeps it when `mydb` is now another engine's resource, even under the journaled id", async () => {
      const r = await settle(c, { engine: 'aurora-postgresql', resourceId: 'db-ORPHAN' });
      expect(r.del).not.toHaveBeenCalled();
      expect(r.out.unaddressed).toBe(1);
    });

    it('deletes it when the identifier still reads back under the journaled id (control)', async () => {
      const r = await settle(c, 'db-ORPHAN');
      expect(r.del).toHaveBeenCalledTimes(1);
      expect(r.out.unaddressed).toBe(0);
    });

    // The fix-forward itself: the record under the same logical id holds the
    // new `mydb-b`, and DocDBProvider.isSameResource decides.
    it('the fix-forward: deletes `MyDb` when the record `mydb-b` reads back under another resource id', async () => {
      const r = await settle(c, 'db-ORPHAN', { recordResourceId: 'db-NEW' });
      expect(r.del).toHaveBeenCalledTimes(1);
      expect(r.del.mock.calls[0]?.[1]).toBe('MyDb');
      expect(r.out.unaddressed).toBe(0);
    });

    it('the fix-forward: keeps it when the record reads back under the same resource id', async () => {
      const r = await settle(c, 'db-ORPHAN', { recordResourceId: 'db-ORPHAN' });
      expect(r.del).not.toHaveBeenCalled();
      // Tracked silently, not demoted to the warn-and-skip an 'unknown' gets.
      expect(r.out.unaddressed).toBe(0);
    });

    it("the fix-forward: keeps it when the earlier identifier is now another engine's", async () => {
      const r = await settle(
        c,
        { engine: 'neptune', resourceId: 'db-ORPHAN' },
        { recordResourceId: 'db-NEW' }
      );
      expect(r.del).not.toHaveBeenCalled();
      expect(r.out.unaddressed).toBe(1);
    });
  });
});
