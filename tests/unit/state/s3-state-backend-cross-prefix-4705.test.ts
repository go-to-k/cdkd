/**
 * go-to-k/cdkd#4705: the S3 calls behind the stack registry and the
 * cross-prefix scan -- the registry marker's read, claim and release, the
 * other prefix's lock probe, `listTopLevelPrefixes`, the strict
 * `recordUnderPrefix` -- and the scan run against a real backend.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  type S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { S3StateBackend, registryMarkerPrefix } from '../../../src/state/s3-state-backend.js';
import { RetainedTimeUnconfirmedError } from '../../../src/state/retained-time.js';
import { CrossPrefixReadError } from '../../../src/state/cross-prefix-stack-scan.js';
import { scanOtherPrefixesForStack } from '../../../src/state/cross-prefix-stack-scan.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '999999999999' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/utils/aws-region-resolver.js')
  >('../../../src/utils/aws-region-resolver.js');
  return { ...actual, resolveBucketRegion: vi.fn() };
});

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...quiet, child: () => quiet }) };
});

/** Object bodies; a key here exists for HEAD and GET. */
let bodies: Map<string, string>;
/** An error a HEAD or GET of the key answers with instead. */
let errors: Map<string, Error>;
/** Top-level CommonPrefixes as S3 returns them (already url-encoded), per page. */
let pages: string[][];
/** How a conditional DeleteObject answers: as S3 does, a 412, or `NotImplemented`. */
let conditionalDelete: 'ok' | 'precondition' | 'not-implemented';
/** Earlier object versions: `{Key, VersionId, LastModified, body}`. */
let versions: Array<{ Key: string; VersionId: string; LastModified: Date; body: string }>;

const notFound = (): Error =>
  Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
const noSuchKey = (): Error =>
  Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
const accessDenied = (): Error =>
  Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
const serviceUnavailable = (): Error =>
  Object.assign(new Error('Service Unavailable'), {
    name: 'ServiceUnavailable',
    $metadata: { httpStatusCode: 503 },
  });

function makeClient(): {
  send: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  config: unknown;
} {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof ListObjectsV2Command && cmd.input.Prefix !== undefined) {
      // The per-candidate probe: `<prefix>/<stack>/`, MaxKeys 1.
      const prefix = cmd.input.Prefix;
      const error = errors.get(prefix);
      if (error) throw error;
      const keys = [...bodies.keys(), ...errors.keys()].filter((k) => k.startsWith(prefix));
      return { KeyCount: Math.min(keys.length, 1), Contents: keys.slice(0, 1).map((Key) => ({ Key })) };
    }
    if (cmd instanceof ListObjectsV2Command) {
      const token = cmd.input.ContinuationToken;
      const index = token === undefined ? 0 : Number(token);
      const page = pages[index] ?? [];
      return {
        CommonPrefixes: page.map((p) => ({ Prefix: p })),
        IsTruncated: index + 1 < pages.length,
        ...(index + 1 < pages.length && { NextContinuationToken: String(index + 1) }),
      };
    }
    if (cmd instanceof PutObjectCommand) {
      const key = cmd.input.Key!;
      const error = errors.get(key);
      if (error) throw error;
      const current = bodies.get(key);
      const preconditionFailed = (): Error =>
        Object.assign(new Error('PreconditionFailed'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      if (cmd.input.IfNoneMatch === '*' && current !== undefined) throw preconditionFailed();
      if (cmd.input.IfMatch !== undefined && (current === undefined || cmd.input.IfMatch !== '"e"'))
        throw preconditionFailed();
      bodies.set(key, String(cmd.input.Body));
      return { ETag: '"e2"' };
    }
    if (cmd instanceof DeleteObjectCommand) {
      if (cmd.input.IfMatch !== undefined && conditionalDelete !== 'ok') {
        throw conditionalDelete === 'precondition'
          ? Object.assign(new Error('PreconditionFailed'), {
              name: 'PreconditionFailed',
              $metadata: { httpStatusCode: 412 },
            })
          : Object.assign(new Error('Not Implemented'), {
              name: 'NotImplemented',
              $metadata: { httpStatusCode: 501 },
            });
      }
      bodies.delete(cmd.input.Key!);
      return {};
    }
    if (cmd instanceof ListObjectVersionsCommand) {
      const prefix = cmd.input.Prefix!;
      return {
        Versions: versions
          .filter((v) => v.Key.startsWith(prefix))
          .map(({ Key, VersionId, LastModified }) => ({ Key, VersionId, LastModified })),
      };
    }
    if (cmd instanceof GetObjectCommand && cmd.input.VersionId !== undefined) {
      const v = versions.find((x) => x.Key === cmd.input.Key && x.VersionId === cmd.input.VersionId);
      if (v === undefined) throw noSuchKey();
      return { Body: { transformToString: async () => v.body } };
    }
    if (cmd instanceof HeadObjectCommand || cmd instanceof GetObjectCommand) {
      const key = cmd.input.Key!;
      const error = errors.get(key);
      if (error) throw error;
      const body = bodies.get(key);
      if (body === undefined) throw cmd instanceof HeadObjectCommand ? notFound() : noSuchKey();
      return cmd instanceof HeadObjectCommand
        ? { LastModified: new Date(5_000) }
        : { Body: { transformToString: async () => body }, ETag: '"e"' };
    }
    throw new Error(`unexpected command ${String(cmd)}`);
  });
  return {
    send,
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve('us-east-1'),
      credentials: () => Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'x' }),
    },
  };
}

let client: ReturnType<typeof makeClient>;
let backend: S3StateBackend;

beforeEach(async () => {
  vi.clearAllMocks();
  clearBucketRegionCache();
  const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
  vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
  bodies = new Map();
  errors = new Map();
  pages = [[]];
  conditionalDelete = 'ok';
  versions = [];
  client = makeClient();
  backend = new S3StateBackend(
    client as unknown as S3Client,
    { bucket: 'b', prefix: 'cdkd' },
    { region: 'us-east-1' }
  );
});

function commandsOf<T>(ctor: new (...args: never[]) => T): T[] {
  return client.send.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
}

const record = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 10,
    stackName: 'App',
    region: 'us-east-1',
    resources: {},
    outputs: {},
    lastModified: 1,
    ...extra,
  });
/** The shape a failed FIRST deploy leaves (cdkd 0.294.2, observed in an integ bucket). */
const autoRollbackCleanJournal = (operations: unknown[] = []): string =>
  JSON.stringify({
    journalVersion: 1,
    stackName: 'App',
    region: 'us-east-1',
    segments: [
      {
        timestamp: 1,
        reason: 'auto-rollback-clean',
        initialDeploy: true,
        operations,
        failedOperations: [
          { logicalId: 'Fn', changeType: 'CREATE', resourceType: 'AWS::SSM::Parameter' },
        ],
      },
    ],
  });
const RESOURCE = {
  Q: {
    physicalId: 'q',
    resourceType: 'AWS::SQS::Queue',
    properties: {},
    attributes: {},
    dependencies: [],
  },
};
const KEY_B = 'team-b/App/us-east-1/state.json';
const LEGACY_B = 'team-b/App/state.json';
const JOURNAL_B = 'team-b/App/us-east-1/rollback-journal.json';

describe('listTopLevelPrefixes', () => {
  it('lists with Delimiter "/" across every page, decodes, and strips the trailing slash', async () => {
    pages = [['cdkd/', 'team-a/'], ['team+b/', '/']];
    await expect(backend.listTopLevelPrefixes()).resolves.toEqual(['cdkd', 'team-a', 'team b', '']);
    const lists = commandsOf(ListObjectsV2Command);
    expect(lists).toHaveLength(2);
    expect(lists[0]!.input).toMatchObject({
      Bucket: 'b',
      Delimiter: '/',
      EncodingType: 'url',
      ExpectedBucketOwner: '999999999999',
    });
    expect(lists[0]!.input.Prefix).toBeUndefined();
  });

  it('skips a prefix that is not valid URL encoding instead of failing the scan', async () => {
    pages = [['bad%zz/', 'team-b/']];
    await expect(backend.listTopLevelPrefixes()).resolves.toEqual(['team-b']);
  });
});

describe('recordUnderPrefix (strict)', () => {
  it('is absent at ONE owner-pinned listing when nothing sits under `<prefix>/<stack>/`', async () => {
    bodies.set('team-b/AppTwo/us-east-1/state.json', record({ resources: RESOURCE }));
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('absent');
    const lists = commandsOf(ListObjectsV2Command);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.input).toMatchObject({
      Prefix: 'team-b/App/',
      MaxKeys: 1,
      ExpectedBucketOwner: '999999999999',
    });
    expect(commandsOf(GetObjectCommand)).toHaveLength(0);
  });

  it('on a hit, reads the three keys together, owner-pinned', async () => {
    bodies.set('team-b/App/eu-west-1/state.json', record({ resources: RESOURCE }));
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('absent');
    const gets = commandsOf(GetObjectCommand);
    expect(gets.map((c) => c.input.Key).sort()).toEqual([LEGACY_B, JOURNAL_B, KEY_B].sort());
    for (const get of gets) expect(get.input.ExpectedBucketOwner).toBe('999999999999');
  });

  it('treats a zero-byte record (cdkd never writes one) as a failure that names the key', async () => {
    bodies.set(KEY_B, '');
    const err = await backend.recordUnderPrefix('team-b', 'App', 'us-east-1').catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'CrossPrefixReadError', key: KEY_B, cause: { name: 'EmptyObject' } });
    expect((err as Error).message).toContain(KEY_B);
  });

  it.each([
    ['missing', (() => {
      const { resources: _r, ...rest } = JSON.parse(record()) as Record<string, unknown>;
      return JSON.stringify(rest);
    })()],
    ['null', record({ resources: null })],
    ['a list', record({ resources: [] })],
  ])('a record whose `resources` is %s proves nothing: holder', async (_what, body) => {
    bodies.set(KEY_B, body);
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('holder');
  });

  it('a 503 on the probe listing reads as failed, naming the listed prefix', async () => {
    errors.set('team-b/App/', serviceUnavailable());
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).rejects.toMatchObject({
      name: 'CrossPrefixReadError',
      key: 'team-b/App/',
    });
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1')
    ).resolves.toMatchObject({ kind: 'failed' });
  });

  it("lists `<prefix>/App/` exactly: `App2`'s objects are not `App`'s", async () => {
    bodies.set('team-b/App2/us-east-1/state.json', record({ resources: RESOURCE }));
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('absent');
    expect(commandsOf(GetObjectCommand)).toHaveLength(0);
    await expect(backend.recordUnderPrefix('team-b', 'App2', 'us-east-1')).resolves.toBe('holder');
  });

  it('names the object a failed read was reading', async () => {
    bodies.set(KEY_B, '{not json');
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).rejects.toMatchObject({
      name: 'CrossPrefixReadError',
      key: KEY_B,
    });
  });

  it('is a holder for an empty record whose journal holds a proven failed-CREATE orphan', async () => {
    bodies.set(KEY_B, record());
    bodies.set(
      JOURNAL_B,
      JSON.stringify({
        journalVersion: 1,
        segments: [
          {
            operations: [],
            failedOperations: [
              { logicalId: 'X', physicalId: 'x', physicalIdRecoveredFromError: true },
            ],
          },
        ],
      })
    );
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('holder');
  });

  it('is a holder when the record has resources, and absent for another region', async () => {
    bodies.set(KEY_B, record({ resources: RESOURCE }));
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('holder');
    await expect(backend.recordUnderPrefix('team-b', 'App', 'eu-west-1')).resolves.toBe('absent');
  });

  it('is a holder when the record has orphans only', async () => {
    bodies.set(KEY_B, record({ orphans: [{ logicalId: 'Q', orphanedAt: 1, state: RESOURCE.Q }] }));
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('holder');
  });

  it('is empty for an empty record with no journal', async () => {
    bodies.set(KEY_B, record());
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('empty');
  });

  it('is empty for an empty record whose journal holds failedOperations only (a failed first deploy)', async () => {
    bodies.set(KEY_B, record());
    bodies.set(JOURNAL_B, autoRollbackCleanJournal());
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('empty');
  });

  it('is a holder for an empty record whose journal holds a completed operation', async () => {
    bodies.set(KEY_B, record());
    bodies.set(
      JOURNAL_B,
      autoRollbackCleanJournal([
        { logicalId: 'Q', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue', physicalId: 'q' },
      ])
    );
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('holder');
  });

  it('is a holder for a journal with a completed operation and NO record', async () => {
    bodies.set(
      JOURNAL_B,
      autoRollbackCleanJournal([{ logicalId: 'Q', changeType: 'CREATE', physicalId: 'q' }])
    );
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('holder');
  });

  it("reads another prefix's LEGACY record: its own region, and a region-less one, are holders", async () => {
    bodies.set(LEGACY_B, record({ resources: RESOURCE }));
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('holder');
    await expect(backend.recordUnderPrefix('team-b', 'App', 'eu-west-1')).resolves.toBe('absent');
    const { region: _r, ...noRegion } = JSON.parse(record({ resources: RESOURCE })) as Record<
      string,
      unknown
    >;
    bodies.set(LEGACY_B, JSON.stringify(noRegion));
    await expect(backend.recordUnderPrefix('team-b', 'App', 'eu-west-1')).resolves.toBe('holder');
  });

  it('a legacy record that is EMPTY is empty: the body is read, not merely requested', async () => {
    bodies.set(LEGACY_B, record());
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('empty');
  });

  it.each([
    ['the record', KEY_B],
    ['the legacy record', LEGACY_B],
    ['the journal', JOURNAL_B],
  ])('throws a 403 on %s, naming it, which the scan reads as denied', async (_what, key) => {
    errors.set(key, accessDenied());
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).rejects.toMatchObject({
      name: 'CrossPrefixReadError',
      key,
      cause: { name: 'AccessDenied' },
    });
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1')
    ).resolves.toMatchObject({ kind: 'denied', stage: 'probe' });
  });

  it('throws a 503 on the legacy read (never swallowed), which the scan reads as failed', async () => {
    errors.set(LEGACY_B, serviceUnavailable());
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1')
    ).resolves.toMatchObject({ kind: 'failed' });
  });

  it('a 403 on the legacy read makes the scan denied', async () => {
    errors.set(LEGACY_B, accessDenied());
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1')
    ).resolves.toMatchObject({ kind: 'denied', stage: 'probe' });
  });

  it('throws on a body that will not parse (failed, not absent)', async () => {
    bodies.set(KEY_B, '{not json');
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).rejects.toThrow();
  });

  it('a 403 on the probe listing reads as denied', async () => {
    errors.set('team-b/App/', accessDenied());
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1')
    ).resolves.toMatchObject({ kind: 'denied', stage: 'probe' });
  });
});

describe('scanOtherPrefixesForStack against S3StateBackend', () => {
  it("a failed first deploy's leftover under another prefix does not block, and is named", async () => {
    bodies.set(KEY_B, record());
    bodies.set(JOURNAL_B, autoRollbackCleanJournal());
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1')
    ).resolves.toEqual({ kind: 'clear', stale: ['team-b'] });
  });

  it('a first deploy finds the record under another prefix', async () => {
    bodies.set(KEY_B, record({ resources: RESOURCE }));
    pages = [['cdkd/', 'team-b/', 'other/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1')
    ).resolves.toEqual({ kind: 'found', prefixes: ['team-b'] });
  });

  it("finds the issue's `--state-prefix team-a/` record (keyed `team-a//App/...`)", async () => {
    bodies.set('team-a//App/us-east-1/state.json', record({ resources: RESOURCE }));
    pages = [['cdkd/', 'team-a/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1')
    ).resolves.toEqual({ kind: 'found', prefixes: ['team-a/'] });
  });

  it('a backend under `team-a/` does not find itself', async () => {
    const own = new S3StateBackend(
      client as unknown as S3Client,
      { bucket: 'b', prefix: 'team-a/' },
      { region: 'us-east-1' }
    );
    bodies.set('team-a//App/us-east-1/state.json', record({ resources: RESOURCE }));
    pages = [['team-a/']];
    await expect(
      scanOtherPrefixesForStack(own, 'App', 'us-east-1')
    ).resolves.toEqual({ kind: 'clear' });
  });

  it('does not see a prefix nested under a top-level segment (documented limit)', async () => {
    bodies.set('team/b/App/us-east-1/state.json', record({ resources: RESOURCE }));
    pages = [['cdkd/', 'team/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1')
    ).resolves.toEqual({ kind: 'clear' });
  });

  it('reports denied (stage list) when the listing is refused', async () => {
    const original = client.send.getMockImplementation() as (cmd: unknown) => Promise<unknown>;
    client.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command && cmd.input.Prefix === undefined) throw accessDenied();
      return original(cmd);
    });
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1')
    ).resolves.toMatchObject({ kind: 'denied', stage: 'list' });
  });
});

describe('the stack registry marker (go-to-k/cdkd#4705)', () => {
  const MARKER = '_cdkd-registry/us-east-1/App.json';

  it('lives at the bucket root, outside every prefix', () => {
    expect(backend.registryMarkerKey('App', 'us-east-1')).toBe(MARKER);
  });

  it('reads as null when absent, and as its prefix and ETag when present, owner-pinned', async () => {
    await expect(backend.getRegistryMarker('App', 'us-east-1')).resolves.toBeNull();
    bodies.set(MARKER, JSON.stringify({ prefix: 'team-b' }));
    await expect(backend.getRegistryMarker('App', 'us-east-1')).resolves.toEqual({
      prefix: 'team-b',
      etag: '"e"',
    });
    const gets = commandsOf(GetObjectCommand).filter((c) => c.input.Key === MARKER);
    expect(gets.every((c) => c.input.ExpectedBucketOwner === '999999999999')).toBe(true);
  });

  it('refuses to read a malformed marker as anything, naming the key', async () => {
    for (const body of ['', 'not json', '[]', '{}', '{"prefix":7}', '{"prefix":"a<b>"}', '{"prefix":"a\u0007"}']) {
      bodies.set(MARKER, body);
      const error = await backend.getRegistryMarker('App', 'us-east-1').catch((e: unknown) => e);
      expect(error, body).toBeInstanceOf(CrossPrefixReadError);
      expect((error as CrossPrefixReadError).key).toBe(MARKER);
    }
  });

  it('throws a 403 on the marker as a read error whose cause is the 403', async () => {
    errors.set(MARKER, accessDenied());
    const error = await backend.getRegistryMarker('App', 'us-east-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrossPrefixReadError);
    expect((error as CrossPrefixReadError).cause).toMatchObject({ name: 'AccessDenied' });
  });

  it('claims with If-None-Match: *, writing only this prefix', async () => {
    await expect(backend.claimRegistryMarker('App', 'us-east-1')).resolves.toBe('claimed');
    const put = commandsOf(PutObjectCommand).at(-1)!;
    expect(put.input).toMatchObject({ Key: MARKER, IfNoneMatch: '*', ExpectedBucketOwner: '999999999999' });
    expect(JSON.parse(String(put.input.Body))).toEqual({ prefix: 'cdkd' });
    // A second claim loses the race.
    await expect(backend.claimRegistryMarker('App', 'us-east-1')).resolves.toBe('conflict');
  });

  it('re-claims exactly the version read (If-Match), and loses to a changed one', async () => {
    bodies.set(MARKER, JSON.stringify({ prefix: 'team-b' }));
    await expect(backend.claimRegistryMarker('App', 'us-east-1', '"e"')).resolves.toBe('claimed');
    expect(commandsOf(PutObjectCommand).at(-1)!.input.IfMatch).toBe('"e"');
    await expect(backend.claimRegistryMarker('App', 'us-east-1', '"stale"')).resolves.toBe(
      'conflict'
    );
  });

  it('throws any other claim failure as a read error naming the key', async () => {
    errors.set(MARKER, serviceUnavailable());
    const error = await backend.claimRegistryMarker('App', 'us-east-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrossPrefixReadError);
  });

  it('releases only a marker naming this prefix, conditionally on the version read (If-Match)', async () => {
    await expect(backend.releaseRegistryMarker('App', 'us-east-1')).resolves.toBe('absent');
    bodies.set(MARKER, JSON.stringify({ prefix: 'team-b' }));
    await expect(backend.releaseRegistryMarker('App', 'us-east-1')).resolves.toBe('elsewhere');
    expect(commandsOf(DeleteObjectCommand)).toHaveLength(0);
    bodies.set(MARKER, JSON.stringify({ prefix: 'cdkd' }));
    await expect(backend.releaseRegistryMarker('App', 'us-east-1')).resolves.toBe('released');
    expect(commandsOf(DeleteObjectCommand).map((c) => c.input)).toEqual([
      expect.objectContaining({ Key: MARKER, IfMatch: '"e"', ExpectedBucketOwner: '999999999999' }),
    ]);
    expect(bodies.has(MARKER)).toBe(false);
  });

  it("CB-12: another prefix's re-claim between the read and the delete (412) is left alone", async () => {
    bodies.set(MARKER, JSON.stringify({ prefix: 'cdkd' }));
    conditionalDelete = 'precondition';
    await expect(backend.releaseRegistryMarker('App', 'us-east-1')).resolves.toBe('elsewhere');
    expect(bodies.has(MARKER)).toBe(true);
  });

  it('CB-12: an endpoint without conditional deletes re-reads right before an unconditional delete', async () => {
    bodies.set(MARKER, JSON.stringify({ prefix: 'cdkd' }));
    conditionalDelete = 'not-implemented';
    await expect(backend.releaseRegistryMarker('App', 'us-east-1')).resolves.toBe('released');
    expect(commandsOf(DeleteObjectCommand).map((c) => c.input.IfMatch)).toEqual(['"e"', undefined]);
    // The re-read sees another prefix's marker: left alone.
    bodies.set(MARKER, JSON.stringify({ prefix: 'cdkd' }));
    client.send.mockClear();
    let reads = 0;
    const realSend = client.send.getMockImplementation() as (cmd: unknown) => Promise<unknown>;
    client.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand && cmd.input.Key === MARKER && ++reads === 2) {
        bodies.set(MARKER, JSON.stringify({ prefix: 'team-b' }));
      }
      return realSend(cmd);
    });
    await expect(backend.releaseRegistryMarker('App', 'us-east-1')).resolves.toBe('elsewhere');
    expect(JSON.parse(bodies.get(MARKER)!)).toEqual({ prefix: 'team-b' });
  });

  it('P3: releasing the version this run already read is ONE conditional DELETE -- no GET', async () => {
    bodies.set(MARKER, JSON.stringify({ prefix: 'cdkd' }));
    client.send.mockClear();
    await expect(
      backend.releaseRegistryMarker('App', 'us-east-1', { prefix: 'cdkd', etag: '"e"' })
    ).resolves.toBe('released');
    expect(client.send.mock.calls.map((c) => (c[0] as object).constructor.name)).toEqual([
      'DeleteObjectCommand',
    ]);
    expect(commandsOf(DeleteObjectCommand)[0]!.input.IfMatch).toBe('"e"');
    // A known marker naming another prefix (or none) sends nothing at all.
    client.send.mockClear();
    await expect(
      backend.releaseRegistryMarker('App', 'us-east-1', { prefix: 'team-b', etag: '"e"' })
    ).resolves.toBe('elsewhere');
    await expect(backend.releaseRegistryMarker('App', 'us-east-1', null)).resolves.toBe('absent');
    expect(client.send).not.toHaveBeenCalled();
  });

  it("probes another prefix's lock in both layouts", async () => {
    await expect(backend.lockUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe(false);
    bodies.set('team-b/App/lock.json', '{}');
    await expect(backend.lockUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe(true);
    bodies.delete('team-b/App/lock.json');
    bodies.set('team-b/App/us-east-1/lock.json', '{}');
    await expect(backend.lockUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe(true);
    errors.set('team-b/App/lock.json', serviceUnavailable());
    await expect(backend.lockUnderPrefix('team-b', 'App', 'us-east-1')).rejects.toBeInstanceOf(
      CrossPrefixReadError
    );
  });

  it('is never listed as a state prefix', async () => {
    pages = [['cdkd/', '_cdkd-registry/', 'team-b/']];
    await expect(backend.listTopLevelPrefixes()).resolves.toEqual(['cdkd', 'team-b']);
  });

  it('registryMarkerPrefix accepts a prefix cdkd could have written, including empty and team-a/', () => {
    for (const prefix of ['cdkd', '', 'team-a/', 'team/a']) {
      expect(registryMarkerPrefix(JSON.stringify({ prefix }))).toBe(prefix);
    }
    expect(registryMarkerPrefix(JSON.stringify({ prefix: 'x'.repeat(1025) }))).toBeUndefined();
    expect(registryMarkerPrefix(undefined)).toBeUndefined();
  });
});

describe("a destroy's kept-resource record (retained.json, go-to-k/cdkd#4705)", () => {
  const KEY = 'cdkd/App/us-east-1/retained.json';
  const entry = { logicalId: 'B', resourceType: 'AWS::S3::Bucket', physicalId: 'app-b' };

  it('is a sibling of state.json, absent as []', async () => {
    await expect(backend.loadRetainedResources('App', 'us-east-1')).resolves.toEqual([]);
    await backend.saveRetainedResources('App', 'us-east-1', [entry]);
    expect(JSON.parse(bodies.get(KEY)!)).toEqual({ retainedVersion: 1, resources: [{ ...entry, keptAt: 5_000 }] });
    await expect(backend.loadRetainedResources('App', 'us-east-1')).resolves.toEqual([{ ...entry, keptAt: 5_000 }]);
  });

  it('P3: the tombstone is ONE conditional PUT (If-None-Match), no GET; an existing record is left as it is', async () => {
    client.send.mockClear();
    await backend.ensureRetainedTombstone('App', 'us-east-1');
    expect(client.send.mock.calls.map((c) => (c[0] as object).constructor.name)).toEqual([
      'PutObjectCommand',
    ]);
    expect(commandsOf(PutObjectCommand)[0]!.input.IfNoneMatch).toBe('*');
    expect(JSON.parse(bodies.get(KEY)!)).toEqual({ retainedVersion: 1, resources: [] });
    bodies.set(KEY, JSON.stringify({ retainedVersion: 1, resources: [entry] }));
    client.send.mockClear();
    await backend.ensureRetainedTombstone('App', 'us-east-1'); // 412: kept
    expect(JSON.parse(bodies.get(KEY)!).resources).toEqual([entry]);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('S-4: a 409 ConditionalRequestConflict on the tombstone is asked once more, not read as "exists"', async () => {
    const realSend = client.send.getMockImplementation() as (cmd: unknown) => Promise<unknown>;
    let conflicts = 1;
    client.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof PutObjectCommand && cmd.input.Key === KEY && conflicts-- > 0) {
        throw Object.assign(new Error('conflict'), {
          name: 'ConditionalRequestConflict',
          $metadata: { httpStatusCode: 409 },
        });
      }
      return realSend(cmd);
    });
    client.send.mockClear();
    await backend.ensureRetainedTombstone('App', 'us-east-1');
    expect(commandsOf(PutObjectCommand)).toHaveLength(2);
    expect(JSON.parse(bodies.get(KEY)!)).toEqual({ retainedVersion: 1, resources: [] });
    // A second 409 is not swallowed as "exists": it fails (the caller warns).
    bodies.delete(KEY);
    conflicts = 2;
    await expect(backend.ensureRetainedTombstone('App', 'us-east-1')).rejects.toThrow('conflict');
  });

  it("H-1: when this machine's clock agrees with S3's, a new entry costs ONE write and ONE HEAD", async () => {
    const realSend = client.send.getMockImplementation() as (cmd: unknown) => Promise<unknown>;
    client.send.mockImplementation(async (cmd: unknown) =>
      cmd instanceof HeadObjectCommand && cmd.input.Key === KEY
        ? { LastModified: new Date(Date.now()) }
        : realSend(cmd)
    );
    client.send.mockClear();
    await backend.saveRetainedResources('App', 'us-east-1', [{ ...entry, logicalId: 'New' }]);
    expect(client.send.mock.calls.map((c) => (c[0] as object).constructor.name)).toEqual([
      'PutObjectCommand',
      'HeadObjectCommand',
    ]);
  });

  it('D-1: saving none writes the empty tombstone, which reads as present (not absent)', async () => {
    await expect(backend.loadRetainedRecord('App', 'us-east-1')).resolves.toBeNull();
    bodies.set(KEY, JSON.stringify({ retainedVersion: 1, resources: [entry] }));
    await backend.saveRetainedResources('App', 'us-east-1', []);
    expect(JSON.parse(bodies.get(KEY)!)).toEqual({ retainedVersion: 1, resources: [] });
    await expect(backend.loadRetainedRecord('App', 'us-east-1')).resolves.toEqual([]);
  });

  it("E-8: a new entry is stamped with S3's clock (the object's LastModified), never this machine's", async () => {
    await backend.saveRetainedResources('App', 'us-east-1', [{ ...entry, keptAt: 1 }, { ...entry, logicalId: 'New' }]);
    expect(JSON.parse(bodies.get(KEY)!).resources).toEqual([
      { ...entry, keptAt: 1 },
      { ...entry, logicalId: 'New', keptAt: 5_000 },
    ]);
    // An all-stamped list (or the empty tombstone) is one write, no read-back.
    client.send.mockClear();
    await backend.saveRetainedResources('App', 'us-east-1', []);
    expect(commandsOf(HeadObjectCommand)).toHaveLength(0);
    expect(commandsOf(PutObjectCommand)).toHaveLength(1);
  });

  it("F-1: the first write already carries this machine's clock; a failed S3 read-back leaves that bound and says so", async () => {
    const before = Date.now();
    const realSend = client.send.getMockImplementation() as (cmd: unknown) => Promise<unknown>;
    client.send.mockImplementation(async (cmd: unknown) => {
      // Only the read-back's HEAD fails; the writes succeed.
      if (cmd instanceof HeadObjectCommand && cmd.input.Key === KEY) throw serviceUnavailable();
      return realSend(cmd);
    });
    const error = await backend
      .saveRetainedResources('App', 'us-east-1', [{ ...entry, logicalId: 'New' }])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetainedTimeUnconfirmedError);
    const written = JSON.parse(String(commandsOf(PutObjectCommand).at(-1)!.input.Body)) as {
      resources: Array<{ keptAt?: number }>;
    };
    expect(written.resources[0]!.keptAt).toBeGreaterThanOrEqual(before);
    expect(written.resources[0]!.keptAt).toBeLessThanOrEqual(Date.now());
  });

  it('D-2: keeps an entry\'s keptAt; drops a non-number one', async () => {
    bodies.set(
      KEY,
      JSON.stringify({
        retainedVersion: 1,
        resources: [
          { ...entry, keptAt: 1234 },
          { ...entry, logicalId: 'C', keptAt: 'soon' },
        ],
      })
    );
    await expect(backend.loadRetainedRecord('App', 'us-east-1')).resolves.toEqual([
      { ...entry, keptAt: 1234 },
      { ...entry, logicalId: 'C' },
    ]);
  });

  it('a body that is not such a record throws, naming the key; a malformed entry is dropped', async () => {
    bodies.set(KEY, '{"retainedVersion":2,"resources":[]}');
    const error = await backend.loadRetainedResources('App', 'us-east-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrossPrefixReadError);
    expect((error as CrossPrefixReadError).key).toBe(KEY);
    bodies.set(KEY, JSON.stringify({ retainedVersion: 1, resources: [entry, { logicalId: 'X' }] }));
    await expect(backend.loadRetainedResources('App', 'us-east-1')).resolves.toEqual([entry]);
  });

  it('survives deleteState, which removes the record and the ledger only', async () => {
    bodies.set('cdkd/App/us-east-1/state.json', '{}');
    bodies.set(KEY, JSON.stringify({ retainedVersion: 1, resources: [entry] }));
    await backend.deleteState('App', 'us-east-1').catch(() => undefined);
    expect(bodies.has(KEY)).toBe(true);
  });
});

describe("a stack's earlier records (noncurrent state.json versions, review CB-14b)", () => {
  const KEY = 'cdkd/App/us-east-1/state.json';

  it('reads the newest versions of exactly that key, newest first, owner-pinned and url-encoded', async () => {
    const body = (id: string) => JSON.stringify({ resources: { [id]: { physicalId: id } } });
    versions = [
      { Key: KEY, VersionId: 'v1', LastModified: new Date(1), body: body('old') },
      { Key: KEY, VersionId: 'v2', LastModified: new Date(2), body: body('new') },
      { Key: `${KEY}.bak`, VersionId: 'x', LastModified: new Date(3), body: body('other-key') },
      { Key: KEY, VersionId: 'v3', LastModified: new Date(0), body: 'not json' },
    ];
    await expect(backend.earlierStateResources('App', 'us-east-1')).resolves.toEqual([
      { resources: { new: { physicalId: 'new' } }, writtenAt: 2 },
      { resources: { old: { physicalId: 'old' } }, writtenAt: 1 },
    ]);
    const listing = commandsOf(ListObjectVersionsCommand)[0]!;
    expect(listing.input).toMatchObject({
      Prefix: KEY,
      EncodingType: 'url',
      ExpectedBucketOwner: '999999999999',
    });
  });
});
