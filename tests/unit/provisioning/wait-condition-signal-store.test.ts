import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { S3Client } from '@aws-sdk/client-s3';

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

const s3 = new S3Client({
  region: 'us-east-1',
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
});
const mockSend = vi.fn();
vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => ({ s3 }) }));
vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: vi.fn(async () => null),
}));
vi.mock('../../../src/utils/expected-bucket-owner.js', () => ({
  expectedOwnerParam: vi.fn(async () => ({ ExpectedBucketOwner: '123456789012' })),
}));
const mockPurge = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../../../src/state/s3-noncurrent-version-purge.js', () => ({
  purgeNoncurrentKeyVersions: (...args: unknown[]) => mockPurge(...args),
}));

import {
  classifyHandleUrl,
  evaluateSignals,
  parseSignalBody,
  signalKeyFor,
  WaitConditionSignalStore,
  SIGNAL_URL_EXPIRES_IN_SECONDS,
  type WaitConditionSignal,
} from '../../../src/provisioning/wait-condition-signal-store.js';

const BUCKET = 'cdkd-state-123456789012';
const KEY = 'wait-condition-signals/Handle-0f8fad5b-d9cb-469f-a165-70867728950e.json';

const success = (uniqueId: string, data = ''): WaitConditionSignal => ({
  status: 'SUCCESS',
  uniqueId,
  data,
  reason: '',
});

describe('classifyHandleUrl', () => {
  it('accepts a virtual-hosted URL into the state bucket', () => {
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/${KEY}?X-Amz-Signature=abc`;
    expect(classifyHandleUrl(url, BUCKET)).toEqual({ kind: 'ours', key: KEY });
  });

  it('accepts a path-style URL into the state bucket', () => {
    const url = `http://localhost:4566/${BUCKET}/${KEY}?X-Amz-Signature=abc`;
    expect(classifyHandleUrl(url, BUCKET)).toEqual({ kind: 'ours', key: KEY });
  });

  it('refuses the same key in another bucket', () => {
    const url = `https://other-bucket.s3.us-east-1.amazonaws.com/${KEY}?X-Amz-Signature=abc`;
    expect(classifyHandleUrl(url, BUCKET)).toEqual({ kind: 'foreign' });
    const pathStyle = `https://s3.us-east-1.amazonaws.com/other-bucket/${KEY}?x=1`;
    expect(classifyHandleUrl(pathStyle, BUCKET)).toEqual({ kind: 'foreign' });
  });

  it('refuses a bucket name that is only a prefix of the host label', () => {
    const url = `https://${BUCKET}x.s3.amazonaws.com/${KEY}`;
    expect(classifyHandleUrl(url, BUCKET)).toEqual({ kind: 'foreign' });
  });

  it("refuses CloudFormation's own handle URL", () => {
    const url =
      'https://cloudformation-waitcondition-us-east-1.s3.amazonaws.com/arn%3Aaws%3Acloudformation%3A';
    expect(classifyHandleUrl(url, BUCKET)).toEqual({ kind: 'foreign' });
  });

  it('refuses a key outside the minted shape', () => {
    const url = `https://${BUCKET}.s3.amazonaws.com/wait-condition-signals/../cdkd/state.json`;
    expect(classifyHandleUrl(url, BUCKET)).toEqual({ kind: 'foreign' });
    expect(classifyHandleUrl('not a url', BUCKET)).toEqual({ kind: 'foreign' });
  });

  it('recognizes a pre-#6694 placeholder id', () => {
    expect(
      classifyHandleUrl('cdkd-wait-condition-handle-Handle-0f8fad5b-d9cb-469f-a165-70867728950e', BUCKET)
    ).toEqual({ kind: 'legacy' });
  });

  it('round-trips every key signalKeyFor mints', () => {
    const key = signalKeyFor('MyHandle1');
    const url = `https://${BUCKET}.s3.amazonaws.com/${key}?X-Amz-Signature=abc`;
    expect(classifyHandleUrl(url, BUCKET)).toEqual({ kind: 'ours', key });
  });
});

describe('parseSignalBody', () => {
  it('reads the four documented fields', () => {
    expect(
      parseSignalBody('{"Status":"SUCCESS","Reason":"ok","UniqueId":"i-1","Data":"done"}')
    ).toEqual({ status: 'SUCCESS', reason: 'ok', uniqueId: 'i-1', data: 'done' });
  });

  it('accepts a lower-case status and absent optional fields', () => {
    expect(parseSignalBody('{"Status":"failure"}')).toEqual({
      status: 'FAILURE',
      reason: '',
      uniqueId: '',
      data: '',
    });
  });

  it('stringifies a non-string field', () => {
    expect(parseSignalBody('{"Status":"SUCCESS","UniqueId":1,"Data":{"a":1}}')).toMatchObject({
      uniqueId: '1',
      data: '{"a":1}',
    });
  });

  it('rejects anything that is not a signal document', () => {
    expect(parseSignalBody('')).toBeUndefined();
    expect(parseSignalBody('not json')).toBeUndefined();
    expect(parseSignalBody('[]')).toBeUndefined();
    expect(parseSignalBody('{"Status":"MAYBE"}')).toBeUndefined();
    expect(parseSignalBody('{"Reason":"no status"}')).toBeUndefined();
  });
});

describe('evaluateSignals', () => {
  it('is pending until Count distinct UniqueIds succeed', () => {
    expect(evaluateSignals([success('a')], 2)).toEqual({ state: 'pending', successes: 1 });
    expect(evaluateSignals([success('a'), success('a')], 2)).toEqual({
      state: 'pending',
      successes: 1,
    });
    expect(evaluateSignals([success('a', '1'), success('b', '2')], 2)).toEqual({
      state: 'succeeded',
      data: { a: '1', b: '2' },
    });
  });

  it('lets a repeat of one UniqueId replace its Data', () => {
    expect(
      evaluateSignals([success('a', 'old'), success('a', 'new'), success('b', 'x')], 2)
    ).toEqual({
      state: 'succeeded',
      data: { a: 'new', b: 'x' },
    });
  });

  it('ends at whichever comes first: the Count-th success or a FAILURE', () => {
    const failure: WaitConditionSignal = { status: 'FAILURE', uniqueId: 'b', data: '', reason: 'x' };
    expect(evaluateSignals([success('a'), failure, success('c')], 1)).toEqual({
      state: 'succeeded',
      data: { a: '' },
    });
    expect(evaluateSignals([failure, success('a')], 1)).toEqual({ state: 'failed', signal: failure });
  });

  it('succeeds with no signals for a zero count', () => {
    expect(evaluateSignals([], 0)).toEqual({ state: 'succeeded', data: {} });
  });
});

describe('WaitConditionSignalStore', () => {
  let store: WaitConditionSignalStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    (s3 as unknown as { send: typeof mockSend }).send = mockSend;
    store = new WaitConditionSignalStore();
  });

  it('refuses to issue a URL with no state bucket', async () => {
    await expect(store.issueSignalUrl('Handle')).rejects.toThrow(/No cdkd state bucket/);
  });

  it('issues a pre-signed PUT URL for a fresh key in the state bucket', async () => {
    store.setBucket(BUCKET);
    const before = Date.now();
    const issued = await store.issueSignalUrl('Handle');
    expect(issued.key).toMatch(/^wait-condition-signals\/Handle-[0-9a-f-]{36}\.json$/);
    const url = new URL(issued.url);
    // CloudFormation's own handle URL lifetime, 12 h (#6704).
    expect(url.searchParams.get('X-Amz-Expires')).toBe('43200');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // Neither the owner header nor a content type is signed: curl must be able to PUT.
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(classifyHandleUrl(issued.url, BUCKET)).toEqual({ kind: 'ours', key: issued.key });
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + SIGNAL_URL_EXPIRES_IN_SECONDS * 1000
    );
    // Long-lived credentials do not shorten it, so nothing should warn.
    expect(issued.limitedByCredentials).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reports a shorter lifetime when the signing credentials expire first', async () => {
    const expiration = new Date(Date.now() + 60 * 60 * 1000);
    const temporary = new S3Client({
      region: 'us-east-1',
      credentials: async () => ({
        accessKeyId: 'ASIAEXAMPLE',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        expiration,
      }),
    });
    const { rebuildClientForBucketRegion } = await import(
      '../../../src/utils/bucket-region-client.js'
    );
    vi.mocked(rebuildClientForBucketRegion).mockResolvedValueOnce(temporary);
    store.setBucket(BUCKET);
    const issued = await store.issueSignalUrl('Handle');
    expect(issued.expiresAt).toEqual(expiration);
    expect(issued.limitedByCredentials).toBe(true);
  });

  it('reads each version in arrival order, GETting only versions not yet seen', async () => {
    store.setBucket(BUCKET);
    const bodies: Record<string, string> = {
      v1: '{"Status":"SUCCESS","UniqueId":"a","Data":"first"}',
      v2: '{"Status":"SUCCESS","UniqueId":"b","Data":"second"}',
    };
    mockSend.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'ListObjectVersionsCommand') {
        expect(command.input).toMatchObject({ Bucket: BUCKET, Prefix: KEY, ExpectedBucketOwner: '123456789012' });
        return {
          // Newest first, as S3 lists them; a sibling key sharing the prefix is ignored.
          Versions: [
            { Key: KEY, VersionId: 'v2', Size: 50 },
            { Key: `${KEY}.extra`, VersionId: 'x', Size: 50 },
            { Key: KEY, VersionId: 'v1', Size: 50 },
          ],
        };
      }
      const versionId = command.input['VersionId'] as string;
      expect(command.input).toMatchObject({ Bucket: BUCKET, Key: KEY, ExpectedBucketOwner: '123456789012' });
      return { Body: { transformToString: async () => bodies[versionId] } };
    });

    const seen = new Map<string, WaitConditionSignal | null>();
    const signals = await store.readSignals(KEY, seen);
    expect(signals.map((s) => s.data)).toEqual(['first', 'second']);
    const gets = () =>
      mockSend.mock.calls.filter(([c]) => c.constructor.name === 'GetObjectCommand').length;
    expect(gets()).toBe(2);

    await store.readSignals(KEY, seen);
    expect(gets()).toBe(2);
  });

  it('skips an empty, oversized or malformed version without failing', async () => {
    store.setBucket(BUCKET);
    mockSend.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'ListObjectVersionsCommand') {
        return {
          Versions: [
            { Key: KEY, VersionId: 'ok', Size: 30 },
            { Key: KEY, VersionId: 'junk', Size: 8 },
            { Key: KEY, VersionId: 'huge', Size: 10 * 1024 * 1024 },
            { Key: KEY, VersionId: 'empty', Size: 0 },
          ],
        };
      }
      const body = command.input['VersionId'] === 'ok' ? '{"Status":"SUCCESS"}' : 'not json';
      return { Body: { transformToString: async () => body } };
    });
    const signals = await store.readSignals(KEY, new Map());
    expect(signals).toEqual([{ status: 'SUCCESS', uniqueId: '', data: '', reason: '' }]);
    const gotten = mockSend.mock.calls
      .filter(([c]) => c.constructor.name === 'GetObjectCommand')
      .map(([c]) => c.input.VersionId);
    expect(gotten.sort()).toEqual(['junk', 'ok']);
  });

  it('follows ListObjectVersions pagination', async () => {
    store.setBucket(BUCKET);
    mockSend.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'ListObjectVersionsCommand') {
        if (command.input['KeyMarker'] === undefined) {
          return {
            Versions: [{ Key: KEY, VersionId: 'v2', Size: 20 }],
            IsTruncated: true,
            NextKeyMarker: KEY,
            NextVersionIdMarker: 'v2',
          };
        }
        expect(command.input).toMatchObject({ KeyMarker: KEY, VersionIdMarker: 'v2' });
        return { Versions: [{ Key: KEY, VersionId: 'v1', Size: 20 }] };
      }
      const id = command.input['VersionId'];
      return {
        Body: { transformToString: async () => `{"Status":"SUCCESS","UniqueId":"${String(id)}"}` },
      };
    });
    const signals = await store.readSignals(KEY, new Map());
    expect(signals.map((s) => s.uniqueId)).toEqual(['v1', 'v2']);
  });

  it('deletes the key and purges its versions', async () => {
    store.setBucket(BUCKET);
    mockSend.mockResolvedValue({});
    await store.deleteSignals(KEY);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]![0].input).toEqual({
      Bucket: BUCKET,
      Key: KEY,
      ExpectedBucketOwner: '123456789012',
    });
    expect(mockPurge).toHaveBeenCalledWith(s3, BUCKET, [KEY], {
      requestFields: { ExpectedBucketOwner: '123456789012' },
    });
  });

  it('removes the delete marker the versioned bucket leaves, after the purge', async () => {
    store.setBucket(BUCKET);
    const order: string[] = [];
    mockSend.mockImplementation(async (command: { input: Record<string, unknown> }) => {
      order.push(`delete ${String(command.input['VersionId'] ?? 'current')}`);
      return command.input['VersionId'] === undefined ? { DeleteMarker: true, VersionId: 'm1' } : {};
    });
    mockPurge.mockImplementation(async () => {
      order.push('purge');
    });
    await store.deleteSignals(KEY);
    expect(order).toEqual(['delete current', 'purge', 'delete m1']);
    expect(mockSend.mock.calls[1]![0].input).toEqual({
      Bucket: BUCKET,
      Key: KEY,
      VersionId: 'm1',
      ExpectedBucketOwner: '123456789012',
    });
  });

  it('refuses a flood of versions instead of reading them', async () => {
    store.setBucket(BUCKET);
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      expect(command.constructor.name).toBe('ListObjectVersionsCommand');
      return {
        Versions: Array.from({ length: 4 }, (_, i) => ({ Key: KEY, VersionId: `v${i}`, Size: 9 })),
      };
    });
    await expect(store.readSignals(KEY, new Map(), 3)).rejects.toMatchObject({
      name: 'WaitConditionSignalFlood',
    });
    // Exactly the limit is still a set of signals (each version GETs a body).
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ListObjectVersionsCommand') {
        return {
          Versions: Array.from({ length: 3 }, (_, i) => ({ Key: KEY, VersionId: `v${i}`, Size: 9 })),
        };
      }
      return { Body: { transformToString: async () => '{"Status":"SUCCESS"}' } };
    });
    await expect(store.readSignals(KEY, new Map(), 3)).resolves.toHaveLength(3);
  });

  it('skips a listed version with no version id', async () => {
    store.setBucket(BUCKET);
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ListObjectVersionsCommand') {
        return { Versions: [{ Key: KEY, Size: 20 }] };
      }
      throw new Error('no GET expected');
    });
    await expect(store.readSignals(KEY, new Map())).resolves.toEqual([]);
  });

  it('resolves the region-corrected client once per base client, and retries a failed one', async () => {
    const { rebuildClientForBucketRegion } = await import(
      '../../../src/utils/bucket-region-client.js'
    );
    const rebuild = vi.mocked(rebuildClientForBucketRegion);
    rebuild.mockClear();
    rebuild.mockRejectedValueOnce(new Error('probe failed'));
    store.setBucket(BUCKET);
    await expect(store.issueSignalUrl('Handle')).rejects.toThrow(/probe failed/);
    await store.issueSignalUrl('Handle');
    await store.issueSignalUrl('Handle');
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('does not fail when the delete fails', async () => {
    store.setBucket(BUCKET);
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(store.deleteSignals(KEY)).resolves.toBeUndefined();
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('removeSignalObjects (cdkd gc, #6699) throws the failure deleteSignals swallows', async () => {
    store.setBucket(BUCKET);
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(store.removeSignalObjects(KEY)).rejects.toThrow('denied');
  });

  it('refuses to remove a key that is not a minted signal key, before any call', async () => {
    store.setBucket(BUCKET);
    mockSend.mockResolvedValue({});
    for (const key of ['cdkd/S/us-east-1/state.json', 'wait-condition-signals/', `x/${KEY}`]) {
      await expect(store.removeSignalObjects(key)).rejects.toThrow('not a wait condition signal key');
    }
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
  });
});
