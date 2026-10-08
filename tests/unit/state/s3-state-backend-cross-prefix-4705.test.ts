/**
 * go-to-k/cdkd#4705: the S3 calls behind the cross-prefix scan —
 * `listTopLevelPrefixes`, `recordExistsUnderPrefix`, `ownRecordExists` — and
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
      if (objects.has(key)) return {};
      throw notFound();
    }
    if (cmd instanceof GetObjectCommand) {
      throw noSuchKey();
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

describe('recordExistsUnderPrefix', () => {
  it("HEADs the other prefix's region-scoped key", async () => {
    objects.add('team-b/App/us-east-1/state.json');
    await expect(backend.recordExistsUnderPrefix('team-b', 'App', 'us-east-1')).resolves.toBe(true);
    await expect(backend.recordExistsUnderPrefix('team-b', 'App', 'eu-west-1')).resolves.toBe(false);
    const keys = commandsOf(HeadObjectCommand).map((c) => c.input.Key);
    expect(keys).toContain('team-b/App/us-east-1/state.json');
    // The legacy region-less key is read too, as `stateExists` reads it.
    expect(commandsOf(GetObjectCommand).map((c) => c.input.Key)).toContain('team-b/App/state.json');
  });

  it('propagates a 403 on the HEAD', async () => {
    deniedKeys.add('team-b/App/us-east-1/state.json');
    await expect(backend.recordExistsUnderPrefix('team-b', 'App', 'us-east-1')).rejects.toMatchObject({
      name: 'Forbidden',
    });
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
  it('a stack this prefix already records never lists the bucket', async () => {
    objects.add('cdkd/App/us-east-1/state.json');
    objects.add('team-b/App/us-east-1/state.json');
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
    objects.add('team-b/App/us-east-1/state.json');
    pages = [['cdkd/', 'team-b/', 'other/']];
    await expect(
      scanOtherPrefixesForStack(backend, 'App', 'us-east-1', { checkOwnRecord: true })
    ).resolves.toEqual({ kind: 'found', prefixes: ['team-b'] });
    // Its own prefix is not probed as "another".
    const heads = commandsOf(HeadObjectCommand).map((c) => c.input.Key);
    expect(heads.filter((k) => k === 'cdkd/App/us-east-1/state.json')).toHaveLength(1);
  });

  it('does not see a prefix nested under a top-level segment (documented limit)', async () => {
    objects.add('team/b/App/us-east-1/state.json');
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
