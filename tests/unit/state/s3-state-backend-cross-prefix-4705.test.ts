/**
 * go-to-k/cdkd#4705: the S3 calls behind the cross-prefix scan --
 * `listTopLevelPrefixes`, the strict `recordUnderPrefix`, `ownRecordExists` --
 * and the scan run against a real backend.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  type S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
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
    if (cmd instanceof HeadObjectCommand || cmd instanceof GetObjectCommand) {
      const key = cmd.input.Key!;
      const error = errors.get(key);
      if (error) throw error;
      const body = bodies.get(key);
      if (body === undefined) throw cmd instanceof HeadObjectCommand ? notFound() : noSuchKey();
      return cmd instanceof HeadObjectCommand
        ? {}
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
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: false })
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
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: false })
    ).resolves.toMatchObject({ kind: 'denied', stage: 'probe' });
  });

  it('throws a 503 on the legacy read (never swallowed), which the scan reads as failed', async () => {
    errors.set(LEGACY_B, serviceUnavailable());
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: false })
    ).resolves.toMatchObject({ kind: 'failed' });
  });

  it('a 403 on the legacy read makes the scan denied', async () => {
    errors.set(LEGACY_B, accessDenied());
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: false })
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
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: false })
    ).resolves.toMatchObject({ kind: 'denied', stage: 'probe' });
  });
});

describe('ownRecordExists', () => {
  it('is true for a state record', async () => {
    bodies.set('cdkd/App/us-east-1/state.json', record());
    await expect(backend.ownRecordExists('App', 'us-east-1')).resolves.toBe(true);
  });

  it('is true for a rollback journal alone (an interrupted first deploy)', async () => {
    bodies.set('cdkd/App/us-east-1/rollback-journal.json', '{}');
    await expect(backend.ownRecordExists('App', 'us-east-1')).resolves.toBe(true);
  });

  it('is true for a legacy-only own record of this region (its body is read)', async () => {
    bodies.set('cdkd/App/state.json', record());
    await expect(backend.ownRecordExists('App', 'us-east-1')).resolves.toBe(true);
    await expect(backend.ownRecordExists('App', 'eu-west-1')).resolves.toBe(false);
  });

  it('is false when neither exists', async () => {
    await expect(backend.ownRecordExists('App', 'us-east-1')).resolves.toBe(false);
  });

  it('sends its three probes at once, not one after another', async () => {
    const pending: Array<() => void> = [];
    const original = client.send.getMockImplementation() as (cmd: unknown) => Promise<unknown>;
    client.send.mockImplementation(
      (cmd: unknown) =>
        new Promise((resolve, reject) => {
          pending.push(() => {
            original(cmd).then(resolve, reject);
          });
        })
    );
    const answer = backend.ownRecordExists('App', 'us-east-1');
    for (let i = 0; i < 50 && pending.length < 3; i++) await new Promise((r) => setTimeout(r, 1));
    expect(pending).toHaveLength(3);
    const sent = client.send.mock.calls.map((c) => c[0] as { input: { Key?: string } });
    expect(sent.map((c) => c.input.Key).sort()).toEqual([
      'cdkd/App/state.json',
      'cdkd/App/us-east-1/rollback-journal.json',
      'cdkd/App/us-east-1/state.json',
    ]);
    pending.forEach((go) => go());
    await expect(answer).resolves.toBe(false);
  });

  it('answers as the serial order would: a failed state HEAD wins over a journal', async () => {
    errors.set('cdkd/App/us-east-1/state.json', accessDenied());
    bodies.set('cdkd/App/us-east-1/rollback-journal.json', '{}');
    await expect(backend.ownRecordExists('App', 'us-east-1')).rejects.toMatchObject({
      name: 'AccessDenied',
    });
  });

  it('answers as the serial order would: (state absent, legacy absent, journal REJECTS) rejects', async () => {
    errors.set('cdkd/App/us-east-1/rollback-journal.json', serviceUnavailable());
    await expect(backend.ownRecordExists('App', 'us-east-1')).rejects.toMatchObject({
      name: 'ServiceUnavailable',
    });
  });

  it('answers as the serial order would: a state record wins over a failed journal HEAD', async () => {
    bodies.set('cdkd/App/us-east-1/state.json', record());
    errors.set('cdkd/App/us-east-1/rollback-journal.json', accessDenied());
    await expect(backend.ownRecordExists('App', 'us-east-1')).resolves.toBe(true);
  });

  it('owner-pins its HEADs', async () => {
    await backend.ownRecordExists('App', 'us-east-1');
    for (const head of commandsOf(HeadObjectCommand)) {
      expect(head.input.ExpectedBucketOwner).toBe('999999999999');
    }
  });
});

describe('scanOtherPrefixesForStack against S3StateBackend', () => {
  it("a failed first deploy's leftover under another prefix does not block, and is named", async () => {
    bodies.set(KEY_B, record());
    bodies.set(JOURNAL_B, autoRollbackCleanJournal());
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'clear', stale: ['team-b'] });
  });

  it('a legacy-only own record stops at own-record and never lists the bucket', async () => {
    bodies.set('cdkd/App/state.json', record({ resources: RESOURCE }));
    bodies.set(KEY_B, record({ resources: RESOURCE }));
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'own-record' });
    expect(commandsOf(ListObjectsV2Command)).toHaveLength(0);
  });

  it('a stack this prefix already records never lists the bucket and reads only its own keys', async () => {
    bodies.set('cdkd/App/us-east-1/state.json', record());
    bodies.set(KEY_B, record({ resources: RESOURCE }));
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'own-record' });
    expect(commandsOf(ListObjectsV2Command)).toHaveLength(0);
    const keys = [...commandsOf(HeadObjectCommand), ...commandsOf(GetObjectCommand)].map(
      (c) => c.input.Key!
    );
    expect(keys.every((k) => k.startsWith('cdkd/'))).toBe(true);
  });

  it('a first deploy finds the record under another prefix', async () => {
    bodies.set(KEY_B, record({ resources: RESOURCE }));
    pages = [['cdkd/', 'team-b/', 'other/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'found', prefixes: ['team-b'] });
  });

  it("finds the issue's `--state-prefix team-a/` record (keyed `team-a//App/...`)", async () => {
    bodies.set('team-a//App/us-east-1/state.json', record({ resources: RESOURCE }));
    pages = [['cdkd/', 'team-a/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: true })
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
      scanOtherPrefixesForStack(own, 'App', 'us-east-1', { checkOwnRecord: false })
    ).resolves.toEqual({ kind: 'clear' });
  });

  it('does not see a prefix nested under a top-level segment (documented limit)', async () => {
    bodies.set('team/b/App/us-east-1/state.json', record({ resources: RESOURCE }));
    pages = [['cdkd/', 'team/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'clear' });
  });

  it('reports denied (stage list) when the listing is refused', async () => {
    const original = client.send.getMockImplementation() as (cmd: unknown) => Promise<unknown>;
    client.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command && cmd.input.Prefix === undefined) throw accessDenied();
      return original(cmd);
    });
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toMatchObject({ kind: 'denied', stage: 'list' });
  });
});
