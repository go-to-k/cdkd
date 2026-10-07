import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
  DeleteDBClusterCommand,
  DeleteDBInstanceCommand,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier DB cluster or instance. Only `'different'`
// lets it delete.

const CTX = { expectedRegion: 'us-east-1' };

type Live = Record<
  string,
  string | 'gone' | 'empty' | Error | { answeredAs: string | undefined } | 'no-id'
>;

interface TypeCase {
  type: 'AWS::RDS::DBCluster' | 'AWS::RDS::DBInstance';
  notFoundFault: string;
  /** The identifier a describe of this type was sent, or `undefined` for another command. */
  askedFor: (cmd: unknown) => string | undefined;
  /** One describe response holding `item`. */
  respond: (identifier: string | undefined, resourceId: string | undefined) => unknown;
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

/**
 * The describe of `c.type` answers per identifier (looked up lower-cased, as
 * RDS does): a resource id, gone (the not-found fault), an empty list, an
 * error, an item naming another identifier, or an item with no resource id.
 * Any other command fails the test.
 */
function live(c: TypeCase, entries: Live): void {
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
    if (typeof entry === 'object') return c.respond(entry.answeredAs, 'db-OTHER');
    // RDS answers with the identifier lower-cased.
    return c.respond(asked.toLowerCase(), entry);
  });
}

const askedIdentifiers = (c: TypeCase): Array<string | undefined> =>
  mockSend.mock.calls.map(([cmd]) => c.askedFor(cmd));

describe.each(CASES)('RDSProvider.isSameResource for $type (go-to-k/cdkd#4606)', (c) => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new RDSProvider();
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

  it('identifiers equal modulo case are the same without a read (RDS identifiers are case-insensitive)', async () => {
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
    const denied = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    live(c, { a: denied, b: 'db-BBBB' });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
      'denied'
    );
    // The record's read too: a failure there is never "the record is gone".
    live(c, { a: 'db-AAAA', b: denied });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, c.type, CTX)).rejects.toThrow(
      'denied'
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

describe('RDSProvider.isSameResource for another RDS type (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  it('a DBSubnetGroup is unknown, with no read', async () => {
    const provider = new RDSProvider();
    expect(
      await provider.isSameResource('a', { physicalId: 'b' }, 'AWS::RDS::DBSubnetGroup', CTX)
    ).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe.each([
  {
    type: 'AWS::RDS::DBCluster',
    label: 'RDS DB cluster',
    isDelete: (cmd: unknown) => cmd instanceof DeleteDBClusterCommand,
    fault: 'DBClusterNotFoundFault',
  },
  {
    type: 'AWS::RDS::DBInstance',
    label: 'RDS DB instance',
    isDelete: (cmd: unknown) => cmd instanceof DeleteDBInstanceCommand,
    fault: 'DBInstanceNotFoundFault',
  },
])('RDSProvider.delete of a journaled $type already gone (go-to-k/cdkd#4606)', (c) => {
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
    const provider = new RDSProvider();
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
