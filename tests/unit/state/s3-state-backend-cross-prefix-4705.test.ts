/**
 * go-to-k/cdkd#4705: the S3 calls behind the cross-prefix scan —
 * `listTopLevelPrefixes`, `recordUnderPrefix`, `ownRecordExists` — and
 * the scan run against a real backend.
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

/** Keys that exist in the fake bucket. */
let objects: Set<string>;
/** Top-level CommonPrefixes, per page. */
let pages: string[][];
let deniedKeys: Set<string>;
/** GetObject bodies; a key here also exists for HEAD. */
let bodies: Map<string, string>;
let deniedGets: Set<string>;

function notFound(): Error {
  return Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
}
function noSuchKey(): Error {
  return Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
}

function makeClient(): { send: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; config: unknown } {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof ListObjectsV2Command) {
      const token = cmd.input.ContinuationToken;
      const index = token === undefined ? 0 : Number(token);
      const page = pages[index] ?? [];
      return {
        CommonPrefixes: page.map((p) => ({ Prefix: encodeURIComponent(p).replace(/%2F/g, '/') })),
        IsTruncated: index + 1 < pages.length,
        ...(index + 1 < pages.length && { NextContinuationToken: String(index + 1) }),
      };
    }
    if (cmd instanceof HeadObjectCommand) {
      const key = cmd.input.Key!;
      if (deniedKeys.has(key)) {
        throw Object.assign(new Error('Forbidden'), { name: 'Forbidden', $metadata: { httpStatusCode: 403 } });
      }
      if (objects.has(key) || bodies.has(key)) return {};
      throw notFound();
    }
    if (cmd instanceof GetObjectCommand) {
      const key = cmd.input.Key!;
      if (deniedGets.has(key)) {
        throw Object.assign(new Error('Access Denied'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        });
      }
      const body = bodies.get(key);
      if (body === undefined) throw noSuchKey();
      return { Body: { transformToString: async () => body }, ETag: '"e"' };
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
  objects = new Set();
  pages = [[]];
  deniedKeys = new Set();
  bodies = new Map();
  deniedGets = new Set();
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

describe('listTopLevelPrefixes', () => {
  it('lists with Delimiter "/" across every page and strips the trailing slash', async () => {
    pages = [['cdkd/', 'team-a/'], ['team b/', '/']];
    await expect(backend.listTopLevelPrefixes()).resolves.toEqual(['cdkd', 'team-a', 'team b', '']);
    const lists = commandsOf(ListObjectsV2Command);
    expect(lists).toHaveLength(2);
    expect(lists[0]!.input).toMatchObject({ Bucket: 'b', Delimiter: '/', EncodingType: 'url' });
    expect(lists[0]!.input.Prefix).toBeUndefined();
  });
});

const KEY_B = 'team-b/App/us-east-1/state.json';
const JOURNAL_B = 'team-b/App/us-east-1/rollback-journal.json';
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
  Q: { physicalId: 'q', resourceType: 'AWS::SQS::Queue', properties: {}, attributes: {}, dependencies: [] },
};

describe('recordUnderPrefix', () => {
  it("is absent when the other prefix has no record (HEAD + the legacy key's GET only)", async () => {
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('absent');
    expect(commandsOf(HeadObjectCommand).map((c) => c.input.Key)).toContain(KEY_B);
    expect(commandsOf(GetObjectCommand).map((c) => c.input.Key)).toEqual(['team-b/App/state.json']);
  });

  it('is a holder when the record has resources', async () => {
    bodies.set(KEY_B, record({ resources: RESOURCE }));
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('holder');
    await expect(backend.recordUnderPrefix('team-b', 'App', 'eu-west-1')).resolves.toBe('absent');
  });

  it('is a holder when the record has orphans only', async () => {
    bodies.set(
      KEY_B,
      record({ orphans: [{ logicalId: 'Q', orphanedAt: 1, state: RESOURCE.Q }] })
    );
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('holder');
  });

  it('is empty for an empty record with no journal', async () => {
    bodies.set(KEY_B, record());
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe('empty');
  });

  it("is empty for an empty record whose journal holds failedOperations only (a failed first deploy)", async () => {
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

  it('propagates a 403 on the HEAD', async () => {
    deniedKeys.add(KEY_B);
    await expect(backend.recordUnderPrefix('team-b', 'App', 'us-east-1')).rejects.toMatchObject({
      name: 'Forbidden',
    });
  });

  it('a 403 on the GET of a hit still reads as access denied to the scan', async () => {
    objects.add(KEY_B);
    deniedGets.add(KEY_B);
    pages = [['cdkd/', 'team-b/']];
    const result = await scanOtherPrefixesForStack(backend, 'App', 'us-east-1', {
      checkOwnRecord: false,
    });
    expect(result.kind).toBe('denied');
  });
});

describe('ownRecordExists', () => {
  it('is true for a state record', async () => {
    objects.add('cdkd/App/us-east-1/state.json');
    await expect(backend.ownRecordExists('App', 'us-east-1')).resolves.toBe(true);
  });

  it('is true for a rollback journal alone (an interrupted first deploy)', async () => {
    objects.add('cdkd/App/us-east-1/rollback-journal.json');
    await expect(backend.ownRecordExists('App', 'us-east-1')).resolves.toBe(true);
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
    // Nothing has answered yet, and all three requests are already out.
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
    deniedKeys.add('cdkd/App/us-east-1/state.json');
    objects.add('cdkd/App/us-east-1/rollback-journal.json');
    await expect(backend.ownRecordExists('App', 'us-east-1')).rejects.toMatchObject({
      name: 'Forbidden',
    });
  });

  it('answers as the serial order would: a state record wins over a failed journal HEAD', async () => {
    objects.add('cdkd/App/us-east-1/state.json');
    deniedKeys.add('cdkd/App/us-east-1/rollback-journal.json');
    await expect(backend.ownRecordExists('App', 'us-east-1')).resolves.toBe(true);
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

  it('a stack this prefix already records never lists the bucket', async () => {
    objects.add('cdkd/App/us-east-1/state.json');
    bodies.set(KEY_B, record({ resources: RESOURCE }));
    pages = [['cdkd/', 'team-b/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'own-record' });
    expect(commandsOf(ListObjectsV2Command)).toHaveLength(0);
    // One parallel round of this prefix's own keys; nothing under another prefix.
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
    // Its own prefix is not probed as "another".
    const heads = commandsOf(HeadObjectCommand).map((c) => c.input.Key);
    expect(heads.filter((k) => k === 'cdkd/App/us-east-1/state.json')).toHaveLength(1);
  });

  it('does not see a prefix nested under a top-level segment (documented limit)', async () => {
    bodies.set('team/b/App/us-east-1/state.json', record({ resources: RESOURCE }));
    pages = [['cdkd/', 'team/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'clear' });
  });

  it('reports denied when the listing is refused', async () => {
    client.send.mockImplementationOnce(async () => {
      throw notFound();
    }); // own state HEAD
    client.send.mockImplementationOnce(async () => {
      throw noSuchKey();
    }); // own legacy GET
    client.send.mockImplementationOnce(async () => {
      throw notFound();
    }); // own journal HEAD
    client.send.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });
    }); // ListObjectsV2
    const result = await scanOtherPrefixesForStack(backend, 'App', 'us-east-1', {
      checkOwnRecord: true,
    });
    expect(result.kind).toBe('denied');
  });
});
