import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ExportIndexStore,
  EXPORT_INDEX_VERSION,
  type ExportIndexFile,
} from '../../../src/state/export-index-store.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

// Mock the S3Client constructor so the region-rebuild suite can assert that a
// replacement client is constructed for the bucket's actual region. The
// happy-path suites never construct an S3Client (they cast a plain object via
// `mockS3`), so this mock is inert for them.
// The stores' standard-shaped client doubles (config.region/credentials
// functions) pass resolveExpectedBucketOwner's structural guard, so STS
// must be mocked or every test would issue a LIVE GetCallerIdentity
// (PR 1015 reviewer catch: 22ms -> 15s + offline flakiness).
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '111111111111' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  };
});

// Mock the region resolver so tests don't issue real GetBucketLocation calls.
// Default: resolves to undefined, which the happy-path suites never observe
// because their `mockS3` clients lack the SDK `config.region()` shape and so
// short-circuit `ensureClientForBucket` before calling the resolver. The
// region-rebuild suite overrides the implementation per case.
vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/aws-region-resolver.js')>(
    '../../../src/utils/aws-region-resolver.js'
  );
  return {
    ...actual,
    resolveBucketRegion: vi.fn(),
  };
});

/**
 * Helper: construct a mock S3Client whose `send` returns/throws per the
 * provided handler keyed on the command's constructor name. Reusable
 * across tests for both happy-path and error-path orchestration.
 */
function mockS3(
  handler: (cmd: { constructor: { name: string }; input: unknown }) => Promise<unknown>
): S3Client {
  return {
    send: vi.fn((cmd: { constructor: { name: string }; input: unknown }) => handler(cmd)),
    destroy: vi.fn(),
  } as unknown as S3Client;
}

/**
 * Helper: produce a fake state-backend with `listStacks` / `getState`
 * returning canned values. The store delegates to these on rebuild.
 */
function mockBackend(stacks: Array<{ stackName: string; region: string; outputs?: Record<string, unknown> }>): S3StateBackend {
  return {
    listStacks: vi.fn(async () =>
      stacks.map((s) => ({ stackName: s.stackName, region: s.region }))
    ),
    getState: vi.fn(async (stackName: string, _region: string) => {
      const found = stacks.find((s) => s.stackName === stackName);
      if (!found) return null;
      return {
        state: {
          version: 4,
          stackName: found.stackName,
          region: found.region,
          resources: {},
          outputs: found.outputs ?? {},
          lastModified: 1234,
        },
        etag: 'fake-etag',
      };
    }),
  } as unknown as S3StateBackend;
}

function s3ErrorWith(name: string, status?: number): Error & {
  name: string;
  $metadata?: { httpStatusCode?: number };
} {
  const err = new Error(name) as Error & {
    name: string;
    $metadata?: { httpStatusCode?: number };
  };
  err.name = name;
  if (status !== undefined) err.$metadata = { httpStatusCode: status };
  return err;
}

describe('ExportIndexStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial load + auto-rebuild', () => {
    it('rebuilds from state.json when the index file is absent (404)', async () => {
      let savedBody = '';
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          throw s3ErrorWith('NoSuchKey', 404);
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          savedBody = String((cmd.input as { Body: string }).Body);
          return { ETag: '"new-etag"' };
        }
        throw new Error(`unexpected command ${cmd.constructor.name}`);
      });
      const backend = mockBackend([
        { stackName: 'Producer', region: 'us-east-1', outputs: { BucketArn: 'arn1' } },
        { stackName: 'Other', region: 'us-east-1', outputs: { Topic: 'topic1' } },
        // Different region — should be excluded from us-east-1 index.
        { stackName: 'WestStack', region: 'us-west-2', outputs: { Should: 'not-show' } },
      ]);
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', backend);

      const entry = await store.lookup('BucketArn');
      expect(entry).toEqual({
        value: 'arn1',
        producerStack: 'Producer',
        producerRegion: 'us-east-1',
      });

      // Rebuild persisted the index — verify the on-disk body shape.
      const parsed = JSON.parse(savedBody) as ExportIndexFile;
      expect(parsed.indexVersion).toBe(EXPORT_INDEX_VERSION);
      expect(parsed.region).toBe('us-east-1');
      expect(parsed.exports['BucketArn']).toEqual({
        value: 'arn1',
        producerStack: 'Producer',
        producerRegion: 'us-east-1',
      });
      expect(parsed.exports['Topic']).toBeDefined();
      // Different region excluded
      expect(parsed.exports['Should']).toBeUndefined();
    });

    it('rebuilds when index JSON is corrupt', async () => {
      let rebuildHappened = false;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => 'not-json' },
            ETag: '"e1"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          rebuildHappened = true;
          return { ETag: '"e2"' };
        }
        throw new Error('unexpected');
      });
      const backend = mockBackend([
        { stackName: 'A', region: 'us-east-1', outputs: { X: 'v' } },
      ]);
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', backend);

      const entry = await store.lookup('X');
      expect(entry?.value).toBe('v');
      expect(rebuildHappened).toBe(true);
    });

    it('reads the existing index file without rebuilding', async () => {
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          Hit: { value: 'cached-value', producerStack: 'P', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      let putCount = 0;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"existing"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          putCount++;
          return { ETag: '"new"' };
        }
        throw new Error('unexpected');
      });
      const backend = mockBackend([]);
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', backend);

      const entry = await store.lookup('Hit');
      expect(entry?.value).toBe('cached-value');
      expect(putCount).toBe(0); // no rebuild
    });

    it('throws on a future indexVersion (forward-compat guard)', async () => {
      const indexFile = {
        indexVersion: 99,
        region: 'us-east-1',
        exports: {},
        lastModified: 1,
      };
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        throw new Error('unexpected');
      });
      const backend = mockBackend([]);
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', backend);

      await expect(store.lookup('X')).rejects.toThrow(/newer than this cdkd binary/);
    });
  });

  describe('lookup', () => {
    it('returns undefined for unknown export names', async () => {
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          Foo: { value: 'v', producerStack: 'P', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]));
      expect(await store.lookup('Unknown')).toBeUndefined();
    });

    it('memoizes the load so concurrent first lookups trigger a single GET', async () => {
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          Foo: { value: 'v', producerStack: 'P', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      let getCount = 0;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          getCount++;
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]));
      const results = await Promise.all([store.lookup('Foo'), store.lookup('Foo'), store.lookup('Foo')]);
      expect(results.every((r) => r?.value === 'v')).toBe(true);
      expect(getCount).toBe(1);
    });
  });

  describe('updateForStack', () => {
    it('replaces a stack’s existing entries with the new outputs', async () => {
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          Old: { value: 'old-v', producerStack: 'S', producerRegion: 'us-east-1' },
          KeepOther: { value: 'k', producerStack: 'Other', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      let put: ExportIndexFile | undefined;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          put = JSON.parse(String((cmd.input as { Body: string }).Body)) as ExportIndexFile;
          return { ETag: '"e2"' };
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]));

      await store.updateForStack('S', 'us-east-1', { New1: 'n1', New2: 'n2' });

      expect(put).toBeDefined();
      // Old entries for stack S are dropped, new entries added.
      expect(put!.exports['Old']).toBeUndefined();
      expect(put!.exports['New1']).toEqual({
        value: 'n1',
        producerStack: 'S',
        producerRegion: 'us-east-1',
      });
      expect(put!.exports['New2']).toBeDefined();
      // Entries owned by other stacks survive.
      expect(put!.exports['KeepOther']).toEqual({
        value: 'k',
        producerStack: 'Other',
        producerRegion: 'us-east-1',
      });
    });

    it('drops all entries when outputs map is empty', async () => {
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          A: { value: 'a', producerStack: 'S', producerRegion: 'us-east-1' },
          B: { value: 'b', producerStack: 'S', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      let put: ExportIndexFile | undefined;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          put = JSON.parse(String((cmd.input as { Body: string }).Body)) as ExportIndexFile;
          return { ETag: '"e2"' };
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]));

      await store.updateForStack('S', 'us-east-1', {});

      expect(put!.exports['A']).toBeUndefined();
      expect(put!.exports['B']).toBeUndefined();
    });
  });

  describe('removeStack', () => {
    it('removes all entries owned by the stack', async () => {
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          Gone: { value: 'g', producerStack: 'S', producerRegion: 'us-east-1' },
          Keep: { value: 'k', producerStack: 'Other', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      let put: ExportIndexFile | undefined;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          put = JSON.parse(String((cmd.input as { Body: string }).Body)) as ExportIndexFile;
          return { ETag: '"e2"' };
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]));

      await store.removeStack('S', 'us-east-1');

      expect(put!.exports['Gone']).toBeUndefined();
      expect(put!.exports['Keep']).toBeDefined();
    });

    it('does not write when the stack has no entries (no-op)', async () => {
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          Keep: { value: 'k', producerStack: 'Other', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      let putCount = 0;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          putCount++;
          return { ETag: '"e2"' };
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]));

      await store.removeStack('NotInIndex', 'us-east-1');
      expect(putCount).toBe(0);
    });

    it('skips the PUT when the resulting map is identical to the loaded one', async () => {
      // The mapsEqual no-change skip: a deploy whose outputs are
      // byte-identical to what the index already has should NOT
      // trigger a PUT. Eliminates wasted writes on incremental
      // deploys where outputs didn't change (PR #349 perf opt).
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          Foo: { value: 'unchanged', producerStack: 'S', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      let putCount = 0;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          putCount++;
          return { ETag: '"e2"' };
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]));

      // First call: outputs identical to what's in the index → no PUT.
      await store.updateForStack('S', 'us-east-1', { Foo: 'unchanged' });
      expect(putCount).toBe(0);

      // Second call with the same value: also no PUT.
      await store.updateForStack('S', 'us-east-1', { Foo: 'unchanged' });
      expect(putCount).toBe(0);

      // Now a real change: writes once.
      await store.updateForStack('S', 'us-east-1', { Foo: 'changed' });
      expect(putCount).toBe(1);
    });

    it('only drops entries matching BOTH stackName and producerRegion', async () => {
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          // Same stackName, different region — must NOT be dropped.
          OtherRegion: { value: 'v', producerStack: 'S', producerRegion: 'us-west-2' },
          // Same name + same region — drop.
          MatchRegion: { value: 'v', producerStack: 'S', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      let put: ExportIndexFile | undefined;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          put = JSON.parse(String((cmd.input as { Body: string }).Body)) as ExportIndexFile;
          return { ETag: '"e2"' };
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]));

      await store.removeStack('S', 'us-east-1');

      expect(put!.exports['MatchRegion']).toBeUndefined();
      expect(put!.exports['OtherRegion']).toBeDefined();
    });
  });

  describe('patchEntry (drift recovery)', () => {
    it('inserts a single entry without touching others', async () => {
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          Existing: { value: 'e', producerStack: 'X', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      let put: ExportIndexFile | undefined;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          put = JSON.parse(String((cmd.input as { Body: string }).Body)) as ExportIndexFile;
          return { ETag: '"e2"' };
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]));

      await store.patchEntry('Drift', {
        value: 'd',
        producerStack: 'Y',
        producerRegion: 'us-east-1',
      });

      expect(put!.exports['Existing']).toBeDefined();
      expect(put!.exports['Drift']).toEqual({
        value: 'd',
        producerStack: 'Y',
        producerRegion: 'us-east-1',
      });
    });
  });

  describe('optimistic-lock retry', () => {
    it('retries on PreconditionFailed and reloads fresh state', async () => {
      const v1: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          A: { value: 'a1', producerStack: 'OtherA', producerRegion: 'us-east-1' },
        },
        lastModified: 1,
      };
      const v2: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {
          A: { value: 'a1', producerStack: 'OtherA', producerRegion: 'us-east-1' },
          B: { value: 'b1', producerStack: 'OtherB', producerRegion: 'us-east-1' },
        },
        lastModified: 2,
      };

      let getCount = 0;
      let putCount = 0;
      let finalPut: ExportIndexFile | undefined;
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          getCount++;
          const file = getCount === 1 ? v1 : v2;
          return {
            Body: { transformToString: async () => JSON.stringify(file) },
            ETag: getCount === 1 ? '"e1"' : '"e2"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          putCount++;
          if (putCount === 1) {
            // First put conflicts (etag stale)
            const err = new Error('Precondition failed') as Error & {
              name: string;
              $metadata?: { httpStatusCode?: number };
            };
            err.name = 'PreconditionFailed';
            throw err;
          }
          finalPut = JSON.parse(String((cmd.input as { Body: string }).Body)) as ExportIndexFile;
          return { ETag: '"e3"' };
        }
        throw new Error(`unexpected ${cmd.constructor.name}`);
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]), {
        initialBackoffMs: 1,
        maxBackoffMs: 1,
      });

      await store.updateForStack('Me', 'us-east-1', { MyExport: 'mine' });

      expect(getCount).toBeGreaterThanOrEqual(2);
      expect(finalPut).toBeDefined();
      // After retry, the final write reflects the LATEST remote state (v2 = A+B)
      // PLUS the new entry from our update.
      expect(finalPut!.exports['A']?.value).toBe('a1');
      expect(finalPut!.exports['B']?.value).toBe('b1');
      expect(finalPut!.exports['MyExport']?.value).toBe('mine');
    });

    it('serializes in-process concurrent writes (no etag pingpong within one cdkd)', async () => {
      // Reviewer G7: parallel `updateForStack` from --stack-concurrency
      // > 1 deploys must serialize via the in-process write chain.
      // Without the chain, both calls read the same loaded snapshot,
      // both write with the same etag, one fails 412, retries — the
      // chain collapses both writes into sequential ops with no 412.
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {},
        lastModified: 1,
      };
      let liveBody = JSON.stringify(indexFile);
      let liveEtag = '"e1"';
      let putCount = 0;
      const concurrentInflight: { count: number; max: number } = { count: 0, max: 0 };
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => liveBody },
            ETag: liveEtag,
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          concurrentInflight.count++;
          if (concurrentInflight.count > concurrentInflight.max) {
            concurrentInflight.max = concurrentInflight.count;
          }
          // Simulate a real S3 PUT taking ~10ms; if we're serialized,
          // only one PUT is ever in flight at once. If we weren't,
          // both putCount=0 reads would set up matching IfMatch =
          // '"e1"' and the second PUT would be a 412.
          await new Promise((r) => setTimeout(r, 10));
          const input = cmd.input as { Body: string; IfMatch?: string };
          if (input.IfMatch && input.IfMatch !== liveEtag) {
            concurrentInflight.count--;
            const err = new Error('Precondition failed') as Error & { name: string };
            err.name = 'PreconditionFailed';
            throw err;
          }
          putCount++;
          liveBody = input.Body;
          liveEtag = `"e${putCount + 1}"`;
          concurrentInflight.count--;
          return { ETag: liveEtag };
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]), {
        initialBackoffMs: 1,
        maxBackoffMs: 1,
      });

      // Fire 3 concurrent updates. If the chain works, max in-flight
      // == 1; otherwise > 1 and we'd see at least one 412 retry.
      await Promise.all([
        store.updateForStack('A', 'us-east-1', { ExportA: 'a' }),
        store.updateForStack('B', 'us-east-1', { ExportB: 'b' }),
        store.updateForStack('C', 'us-east-1', { ExportC: 'c' }),
      ]);

      expect(concurrentInflight.max).toBe(1);
      // 3 successful PUTs, no retries fired
      expect(putCount).toBe(3);
      // Final state has all three exports
      const finalFile = JSON.parse(liveBody) as ExportIndexFile;
      expect(finalFile.exports['ExportA']?.value).toBe('a');
      expect(finalFile.exports['ExportB']?.value).toBe('b');
      expect(finalFile.exports['ExportC']?.value).toBe('c');
    });

    it('logs warn and returns (no throw) on non-retryable error', async () => {
      // Reviewer G5: the non-PreconditionFailed branch of runWithRetry
      // is reachable via S3 AccessDenied / NetworkError / throttle. The
      // index is best-effort, so we MUST NOT propagate this failure to
      // the deploy (which would abort an otherwise-successful save).
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {},
        lastModified: 1,
      };
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          const err = new Error('Access denied') as Error & { name: string };
          err.name = 'AccessDenied';
          throw err;
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]), {
        maxWriteRetries: 5,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
      });

      // Must resolve (not throw) — best-effort semantics for the index.
      await expect(
        store.updateForStack('Me', 'us-east-1', { X: 'v' })
      ).resolves.toBeUndefined();
    });

    it('gives up after maxWriteRetries and logs warn (no throw)', async () => {
      const indexFile: ExportIndexFile = {
        indexVersion: 1,
        region: 'us-east-1',
        exports: {},
        lastModified: 1,
      };
      const s3 = mockS3(async (cmd) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToString: async () => JSON.stringify(indexFile) },
            ETag: '"e1"',
          };
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          const err = new Error('Precondition failed') as Error & {
            name: string;
            $metadata?: { httpStatusCode?: number };
          };
          err.name = 'PreconditionFailed';
          throw err;
        }
        throw new Error('unexpected');
      });
      const store = new ExportIndexStore(s3, 'b', 'cdkd', 'us-east-1', mockBackend([]), {
        maxWriteRetries: 3,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
      });

      // Should NOT throw — index update failures are best-effort by design.
      await expect(
        store.updateForStack('Me', 'us-east-1', { X: 'v' })
      ).resolves.toBeUndefined();
    });
  });
});

/**
 * Build a fake S3Client whose `.config.region()` / `.config.credentials()`
 * resolve canned values — the shape `ExportIndexStore.ensureClientForBucket`
 * reads. `send` is a separate `vi.fn` so a test can assert it was (not) used.
 */
function makeRegionAwareClient(region: string): {
  send: ReturnType<typeof vi.fn>;
  config: {
    region: () => Promise<string>;
    credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string }>;
  };
} {
  return {
    send: vi.fn(),
    config: {
      region: () => Promise.resolve(region),
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
}

describe('ExportIndexStore.ensureClientForBucket — region rebuild (issue #819)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the index through a region-corrected client when the bucket region differs (pre-fix: 301 PermanentRedirect on removeStack)', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    // Bucket lives in us-west-2; the supplied client was created for us-east-1.
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');

    const initialClient = makeRegionAwareClient('us-east-1');
    // Pre-fix behavior: any send against the wrong regional endpoint fails with
    // S3's 301 PermanentRedirect. If the store kept using the original client,
    // removeStack's GET/PUT would hit it and the index would silently not update.
    initialClient.send.mockRejectedValue(
      Object.assign(new Error('must be addressed using the specified endpoint'), {
        name: 'PermanentRedirect',
        $metadata: { httpStatusCode: 301 },
      })
    );

    // The rebuilt (us-west-2) client serves the index: a 404 GET (no index yet)
    // triggers a rebuild PUT, then removeStack's no-op short-circuits.
    const rebuiltSend = vi.fn(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        throw Object.assign(new Error('NoSuchKey'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        });
      }
      return { ETag: '"rebuilt-etag"' };
    });
    vi.mocked(S3Client).mockImplementation(() => ({ send: rebuiltSend }) as unknown as S3Client);

    const store = new ExportIndexStore(
      initialClient as unknown as S3Client,
      'cross-region-bucket',
      'cdkd',
      'us-west-2',
      mockBackend([{ stackName: 'Producer', region: 'us-west-2', outputs: { BucketArn: 'arn1' } }])
    );

    await store.removeStack('Producer', 'us-west-2');

    // A replacement client was constructed for the bucket's actual region.
    expect(vi.mocked(S3Client)).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-west-2' })
    );
    // Every S3 op went through the rebuilt client, never the original one.
    expect(rebuiltSend).toHaveBeenCalled();
    expect(initialClient.send).not.toHaveBeenCalled();
  });

  it('updateForStack succeeds through the region-corrected client (write path)', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');

    const initialClient = makeRegionAwareClient('us-east-1');
    initialClient.send.mockRejectedValue(
      Object.assign(new Error('must be addressed using the specified endpoint'), {
        name: 'PermanentRedirect',
        $metadata: { httpStatusCode: 301 },
      })
    );

    let savedBody = '';
    const rebuiltSend = vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        throw Object.assign(new Error('NoSuchKey'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        });
      }
      // PutObject (rebuild + update).
      savedBody = String((cmd.input as { Body: string }).Body);
      return { ETag: '"rebuilt-etag"' };
    });
    vi.mocked(S3Client).mockImplementation(() => ({ send: rebuiltSend }) as unknown as S3Client);

    const store = new ExportIndexStore(
      initialClient as unknown as S3Client,
      'cross-region-bucket',
      'cdkd',
      'us-west-2',
      mockBackend([])
    );

    await store.updateForStack('Producer', 'us-west-2', { BucketArn: 'arn1' });

    expect(vi.mocked(S3Client)).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-west-2' })
    );
    expect(initialClient.send).not.toHaveBeenCalled();
    const parsed = JSON.parse(savedBody) as ExportIndexFile;
    expect(parsed.exports['BucketArn']).toEqual({
      value: 'arn1',
      producerStack: 'Producer',
      producerRegion: 'us-west-2',
    });
  });

  it('does not rebuild the client when the resolved region matches', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');

    const initialClient = makeRegionAwareClient('us-east-1');
    initialClient.send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        throw Object.assign(new Error('NoSuchKey'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        });
      }
      return { ETag: '"e"' };
    });

    const store = new ExportIndexStore(
      initialClient as unknown as S3Client,
      'same-region-bucket',
      'cdkd',
      'us-east-1',
      mockBackend([{ stackName: 'A', region: 'us-east-1', outputs: { X: 'v' } }])
    );

    await store.lookup('X');

    // No replacement client was constructed; the original was used.
    expect(vi.mocked(S3Client)).not.toHaveBeenCalled();
    expect(initialClient.send).toHaveBeenCalled();
  });

  it('only resolves the bucket region once across multiple index operations (cached)', async () => {
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');

    const initialClient = makeRegionAwareClient('us-east-1');
    initialClient.send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        throw Object.assign(new Error('NoSuchKey'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        });
      }
      return { ETag: '"e"' };
    });

    const store = new ExportIndexStore(
      initialClient as unknown as S3Client,
      'same-region-bucket',
      'cdkd',
      'us-east-1',
      mockBackend([{ stackName: 'A', region: 'us-east-1', outputs: { X: 'v' } }])
    );

    await store.lookup('X');
    await store.updateForStack('A', 'us-east-1', { X: 'v2' });
    await store.removeStack('A', 'us-east-1');

    // resolveBucketRegion is called exactly once even though several index
    // operations ran (no repeated GetBucketLocation).
    expect(vi.mocked(resolveBucketRegion)).toHaveBeenCalledTimes(1);
  });
});
