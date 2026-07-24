import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StateBackendConfig } from '../../../src/types/config.js';
import { STATE_SCHEMA_VERSION_CURRENT, type StackState } from '../../../src/types/state.js';
import { StateError } from '../../../src/utils/error-handler.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';

// The backend's standard-shaped client double passes
// resolveExpectedBucketOwner's structural guard, so STS must be mocked —
// otherwise every test issues a LIVE GetCallerIdentity (PR 1015 reviewer
// catch). With the mock, every state-bucket command is asserted to carry
// ExpectedBucketOwner (the positive pin for the squatting hardening).
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '999999999999' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
      destroy: vi.fn(),
    })),
  };
});

// Mock the region resolver so tests don't issue real GetBucketLocation calls.
// Each test case overrides the implementation as needed.
vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/utils/aws-region-resolver.js')
  >('../../../src/utils/aws-region-resolver.js');
  return {
    ...actual,
    resolveBucketRegion: vi.fn(),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/**
 * Build a fake S3Client whose `.config.region()` returns the given region.
 * Mirrors the shape S3StateBackend reads in `ensureClientForBucket`.
 */
function makeFakeClient(region: string): {
  send: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  config: {
    region: () => Promise<string>;
    credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string }>;
  };
} {
  return {
    send: vi.fn(),
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve(region),
      // Standard-shaped credentials so resolveExpectedBucketOwner resolves
      // via the MOCKED STS above — every command then carries
      // ExpectedBucketOwner: '999999999999' (the positive hardening pin).
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
}

describe('S3StateBackend.verifyBucketExists', () => {
  let s3Client: ReturnType<typeof makeFakeClient>;
  let backend: S3StateBackend;
  const config: StateBackendConfig = {
    bucket: 'my-state-bucket',
    prefix: 'stacks',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    // Default: bucket is already in the same region as the client, so
    // ensureClientForBucket() does not rebuild the client.
    const { resolveBucketRegion } = await import(
      '../../../src/utils/aws-region-resolver.js'
    );
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    s3Client = makeFakeClient('us-east-1');
    backend = new S3StateBackend(s3Client as unknown as S3Client, config, {
      region: 'us-east-1',
    });
  });

  it('resolves when the bucket exists', async () => {
    s3Client.send.mockResolvedValueOnce({});

    await expect(backend.verifyBucketExists()).resolves.toBeUndefined();

    const call = s3Client.send.mock.calls[0][0];
    expect(call).toBeInstanceOf(HeadBucketCommand);
    // ExpectedBucketOwner is the squatting hardening (PR 1015): a foreign-
    // owned bucket 403s at S3 regardless of its policy.
    expect(call.input).toEqual({
      Bucket: 'my-state-bucket',
      ExpectedBucketOwner: '999999999999',
    });
  });

  it('throws a StateError with bootstrap hint when the bucket is missing (NotFound)', async () => {
    const err = Object.assign(new Error('Not Found'), { name: 'NotFound' });
    s3Client.send.mockRejectedValue(err);

    const caught = await backend.verifyBucketExists().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/does not exist/);
    expect((caught as Error).message).toMatch(/cdkd bootstrap/);
  });

  it('throws a StateError with bootstrap hint when the bucket is missing (NoSuchBucket)', async () => {
    const err = Object.assign(new Error('The specified bucket does not exist'), {
      name: 'NoSuchBucket',
    });
    s3Client.send.mockRejectedValue(err);

    const caught = await backend.verifyBucketExists().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/cdkd bootstrap/);
  });

  it('wraps other errors as StateError without the bootstrap hint', async () => {
    const err = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    s3Client.send.mockRejectedValue(err);

    const caught = await backend.verifyBucketExists().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/Failed to verify state bucket/);
    expect((caught as Error).message).not.toMatch(/cdkd bootstrap/);
  });

  it('routes the AWS SDK v3 UnknownError through normalizeAwsError (404 → bucket does not exist)', async () => {
    const unknown = Object.assign(new Error('UnknownError'), {
      name: 'Unknown',
      $metadata: { httpStatusCode: 404 },
    });
    s3Client.send.mockRejectedValue(unknown);

    const caught = await backend.verifyBucketExists().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    // The verifyBucketExists wrapper takes the normalized message and
    // re-wraps it; the inner-message text is what we care about here.
    expect((caught as Error).message).toMatch(/Bucket 'my-state-bucket' does not exist/);
    expect((caught as Error).message).not.toMatch(/UnknownError/);
  });
});

describe('S3StateBackend.ensureClientForBucket — region rebuild', () => {
  const config: StateBackendConfig = {
    bucket: 'cross-region-bucket',
    prefix: 'stacks',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearBucketRegionCache();
  });

  it('rebuilds the S3 client when the resolved bucket region differs', async () => {
    const { resolveBucketRegion } = await import(
      '../../../src/utils/aws-region-resolver.js'
    );
    // Bucket lives in us-west-2, client was created for us-east-1.
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');

    const initialClient = makeFakeClient('us-east-1');
    initialClient.send.mockResolvedValue({}); // HeadBucket returns ok

    const backend = new S3StateBackend(initialClient as unknown as S3Client, config, {
      region: 'us-east-1',
    });

    await backend.verifyBucketExists();

    // The original us-east-1 client should have been destroyed in favor of
    // a us-west-2 client.
    expect(initialClient.destroy).toHaveBeenCalled();
    // S3Client constructor invoked once to build the replacement.
    expect(vi.mocked(S3Client)).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-west-2' })
    );
  });

  it('does not rebuild the client when the resolved region matches', async () => {
    const { resolveBucketRegion } = await import(
      '../../../src/utils/aws-region-resolver.js'
    );
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');

    const initialClient = makeFakeClient('us-east-1');
    initialClient.send.mockResolvedValue({});

    // Reset the constructor call counter so we can assert on rebuilds only.
    vi.mocked(S3Client).mockClear();

    const backend = new S3StateBackend(initialClient as unknown as S3Client, config, {
      region: 'us-east-1',
    });

    await backend.verifyBucketExists();

    expect(initialClient.destroy).not.toHaveBeenCalled();
    // No replacement client was constructed.
    expect(vi.mocked(S3Client)).not.toHaveBeenCalled();
  });

  it('only resolves the bucket region once across multiple public calls', async () => {
    const { resolveBucketRegion } = await import(
      '../../../src/utils/aws-region-resolver.js'
    );
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');

    const initialClient = makeFakeClient('us-east-1');
    // Each public call issues one S3 send (HeadBucket / ListObjectsV2 / etc.).
    initialClient.send.mockResolvedValue({ CommonPrefixes: [] });

    const backend = new S3StateBackend(initialClient as unknown as S3Client, config, {
      region: 'us-east-1',
    });

    await backend.verifyBucketExists();
    await backend.listStacks();
    await backend.listStacks();

    // resolveBucketRegion should have been called exactly once even though
    // three public methods ran.
    expect(vi.mocked(resolveBucketRegion)).toHaveBeenCalledTimes(1);
  });
});

/**
 * Test helpers for the region-prefixed key tests below. Most calls go through
 * `s3Client.send(...)` and we want to keep the per-test setup readable.
 */
function v2State(stackName: string, region: string): StackState {
  return {
    version: 2,
    stackName,
    region,
    resources: {},
    outputs: {},
    lastModified: 1234567890,
  };
}

function v1State(stackName: string, region?: string): StackState {
  // `version: 1` legacy state (pre PR 1). `region` is optional in the body —
  // the very-old layout did not always persist it.
  return {
    version: 1,
    stackName,
    ...(region && { region }),
    resources: {},
    outputs: {},
    lastModified: 1234567890,
  };
}

function bodyOf(state: StackState) {
  return {
    transformToString: () => Promise.resolve(JSON.stringify(state)),
  };
}

describe('S3StateBackend region-prefixed key layout (PR 1)', () => {
  let s3Client: ReturnType<typeof makeFakeClient>;
  let backend: S3StateBackend;
  const config: StateBackendConfig = {
    bucket: 'state-bucket',
    prefix: 'cdkd',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    // Bucket is in the same region as the client; ensureClientForBucket() is a no-op.
    const { resolveBucketRegion } = await import(
      '../../../src/utils/aws-region-resolver.js'
    );
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    s3Client = makeFakeClient('us-east-1');
    backend = new S3StateBackend(s3Client as unknown as S3Client, config);
  });

  describe('getState', () => {
    it('reads from the new region-scoped key when present', async () => {
      const state = v2State('MyStack', 'us-west-2');
      s3Client.send.mockResolvedValueOnce({ Body: bodyOf(state), ETag: '"new-etag"' });

      const result = await backend.getState('MyStack', 'us-west-2');

      expect(result).not.toBeNull();
      expect(result!.state).toEqual(state);
      expect(result!.etag).toBe('"new-etag"');
      expect(result!.migrationPending).toBeUndefined();

      const cmd = s3Client.send.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      expect(cmd.input.Key).toBe('cdkd/MyStack/us-west-2/state.json');
    });

    it('falls back to the legacy key and surfaces migrationPending: true', async () => {
      const noSuchKey = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      // 1st: new key miss
      s3Client.send.mockRejectedValueOnce(noSuchKey);
      // 2nd: legacy key hit
      const legacy = v1State('MyStack', 'us-west-2');
      s3Client.send.mockResolvedValueOnce({ Body: bodyOf(legacy), ETag: '"legacy-etag"' });

      const result = await backend.getState('MyStack', 'us-west-2');

      expect(result).not.toBeNull();
      expect(result!.state).toEqual(legacy);
      expect(result!.migrationPending).toBe(true);

      const newKeyCmd = s3Client.send.mock.calls[0][0];
      expect(newKeyCmd.input.Key).toBe('cdkd/MyStack/us-west-2/state.json');
      const legacyCmd = s3Client.send.mock.calls[1][0];
      expect(legacyCmd.input.Key).toBe('cdkd/MyStack/state.json');
    });

    it('skips legacy fallback when its embedded region does not match', async () => {
      // PR 1 silent-failure root cause: a legacy state recorded in us-west-2
      // must NOT be loaded when the caller asks for us-east-1.
      const noSuchKey = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(noSuchKey);
      const legacy = v1State('MyStack', 'us-west-2');
      s3Client.send.mockResolvedValueOnce({ Body: bodyOf(legacy), ETag: '"legacy-etag"' });

      const result = await backend.getState('MyStack', 'us-east-1');
      expect(result).toBeNull();
    });

    it('returns null when both new and legacy keys are missing', async () => {
      const noSuchKey = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(noSuchKey);
      s3Client.send.mockRejectedValueOnce(noSuchKey);

      const result = await backend.getState('MissingStack', 'us-east-1');
      expect(result).toBeNull();
    });

    it('rejects an unsupported future schema version with a clear error', async () => {
      // An old cdkd binary trying to read a `version: 99` blob must fail
      // with a clear "upgrade cdkd" error rather than silently mishandling
      // unknown fields. Use a sentinel version far above what readers
      // currently recognise so the test stays accurate as the schema grows.
      const future = { version: 99, stackName: 'X', resources: {}, outputs: {}, lastModified: 0 };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(future)) },
        ETag: '"e"',
      });

      const caught = await backend.getState('X', 'us-east-1').catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(StateError);
      expect((caught as Error).message).toMatch(/Unsupported state schema version 99/);
      expect((caught as Error).message).toMatch(/Upgrade cdkd/);
    });
  });

  describe('saveState', () => {
    it('writes to the new region-scoped key and forces the current schema version on disk', async () => {
      s3Client.send.mockResolvedValueOnce({ ETag: '"new"' });

      const etag = await backend.saveState('MyStack', 'us-west-2', v1State('MyStack', 'us-west-2'));

      expect(etag).toBe('"new"');
      const put = s3Client.send.mock.calls[0][0];
      expect(put).toBeInstanceOf(PutObjectCommand);
      expect(put.input.Key).toBe('cdkd/MyStack/us-west-2/state.json');
      const persisted = JSON.parse(put.input.Body) as StackState;
      // Schema version is bumped to current even when the caller passed a
      // `version: 1` body — the on-disk format is always current. Compare
      // against the constant so this stays accurate when the schema grows.
      expect(persisted.version).toBe(STATE_SCHEMA_VERSION_CURRENT);
      expect(persisted.region).toBe('us-west-2');
      expect(persisted.stackName).toBe('MyStack');
    });

    it('forwards expectedEtag as IfMatch when not migrating', async () => {
      s3Client.send.mockResolvedValueOnce({ ETag: '"new"' });

      await backend.saveState('MyStack', 'us-west-2', v2State('MyStack', 'us-west-2'), {
        expectedEtag: '"prev"',
      });

      const put = s3Client.send.mock.calls[0][0];
      expect(put.input.IfMatch).toBe('"prev"');
    });

    it('migrates: writes new key then deletes the legacy key when migrateLegacy: true', async () => {
      s3Client.send.mockResolvedValueOnce({ ETag: '"new"' });
      s3Client.send.mockResolvedValueOnce({}); // legacy DELETE

      await backend.saveState('MyStack', 'us-west-2', v2State('MyStack', 'us-west-2'), {
        expectedEtag: '"legacy"',
        migrateLegacy: true,
      });

      const put = s3Client.send.mock.calls[0][0];
      expect(put).toBeInstanceOf(PutObjectCommand);
      expect(put.input.Key).toBe('cdkd/MyStack/us-west-2/state.json');
      // The legacy ETag is for a different key; we MUST NOT pass it as IfMatch
      // on the new write — the put would always fail PreconditionFailed.
      expect(put.input.IfMatch).toBeUndefined();

      const del = s3Client.send.mock.calls[1][0];
      expect(del).toBeInstanceOf(DeleteObjectCommand);
      expect(del.input.Key).toBe('cdkd/MyStack/state.json');
    });
  });

  describe('listStacks', () => {
    it('parses both new and legacy keys as {stackName, region} refs', async () => {
      s3Client.send.mockResolvedValueOnce({
        Contents: [
          { Key: 'cdkd/MyStack/us-east-1/state.json' },
          { Key: 'cdkd/MyStack/us-west-2/state.json' },
          { Key: 'cdkd/LegacyStack/state.json' }, // pure legacy
          { Key: 'cdkd/MyStack/us-east-1/lock.json' }, // ignored — not state.json
        ],
        IsTruncated: false,
      });
      // Legacy region lookup for LegacyStack
      s3Client.send.mockResolvedValueOnce({
        Body: bodyOf(v1State('LegacyStack', 'us-east-1')),
      });

      const refs = await backend.listStacks();

      // Sorted only by listing order; assert via set.
      expect(refs).toHaveLength(3);
      const set = new Set(refs.map((r) => `${r.stackName}|${r.region ?? ''}`));
      expect(set.has('MyStack|us-east-1')).toBe(true);
      expect(set.has('MyStack|us-west-2')).toBe(true);
      expect(set.has('LegacyStack|us-east-1')).toBe(true);
    });

    it('deduplicates (stackName, region) when the same pair appears twice', async () => {
      // Pathological: a legacy entry whose embedded region collides with a
      // new-key entry. The new-key entry wins and listStacks emits one row.
      s3Client.send.mockResolvedValueOnce({
        Contents: [
          { Key: 'cdkd/MyStack/us-east-1/state.json' },
          { Key: 'cdkd/MyStack/state.json' },
        ],
        IsTruncated: false,
      });
      s3Client.send.mockResolvedValueOnce({
        Body: bodyOf(v1State('MyStack', 'us-east-1')),
      });

      const refs = await backend.listStacks();
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({ stackName: 'MyStack', region: 'us-east-1' });
    });
  });

  describe('stateExists', () => {
    it('returns true when the new region-scoped key exists', async () => {
      s3Client.send.mockResolvedValueOnce({});
      await expect(backend.stateExists('S', 'us-east-1')).resolves.toBe(true);
      const head = s3Client.send.mock.calls[0][0];
      expect(head).toBeInstanceOf(HeadObjectCommand);
      expect(head.input.Key).toBe('cdkd/S/us-east-1/state.json');
    });

    it('returns true when only the legacy key exists AND its region matches', async () => {
      // 1st: HEAD new key → NotFound
      s3Client.send.mockRejectedValueOnce(Object.assign(new Error('NF'), { name: 'NotFound' }));
      // 2nd: GET legacy state to read its embedded region
      s3Client.send.mockResolvedValueOnce({ Body: bodyOf(v1State('S', 'us-east-1')) });

      await expect(backend.stateExists('S', 'us-east-1')).resolves.toBe(true);
    });

    it('returns false when only the legacy key exists but its region differs', async () => {
      s3Client.send.mockRejectedValueOnce(Object.assign(new Error('NF'), { name: 'NotFound' }));
      s3Client.send.mockResolvedValueOnce({ Body: bodyOf(v1State('S', 'us-west-2')) });

      await expect(backend.stateExists('S', 'us-east-1')).resolves.toBe(false);
    });
  });

  describe('deleteState', () => {
    it('deletes the region-scoped key and sweeps the matching legacy key', async () => {
      // 1st: DeleteObject (new key)
      s3Client.send.mockResolvedValueOnce({});
      // 2nd: GetObject for legacy region match
      s3Client.send.mockResolvedValueOnce({ Body: bodyOf(v1State('S', 'us-east-1')) });
      // 3rd: DeleteObject (legacy key)
      s3Client.send.mockResolvedValueOnce({});

      await backend.deleteState('S', 'us-east-1');

      const cmds = s3Client.send.mock.calls.map((c: unknown[]) => c[0]);
      expect(cmds[0]).toBeInstanceOf(DeleteObjectCommand);
      expect((cmds[0] as DeleteObjectCommand).input.Key).toBe('cdkd/S/us-east-1/state.json');
      expect(cmds[2]).toBeInstanceOf(DeleteObjectCommand);
      expect((cmds[2] as DeleteObjectCommand).input.Key).toBe('cdkd/S/state.json');
      // deleteState also sweeps the rollback journal (issue #1183).
      const deletedKeys = cmds
        .filter((c: unknown) => c instanceof DeleteObjectCommand)
        .map((c: DeleteObjectCommand) => c.input.Key);
      expect(deletedKeys).toContain('cdkd/S/us-east-1/rollback-journal.json');
    });

    it('leaves a legacy key alone when its region does not match', async () => {
      s3Client.send.mockResolvedValueOnce({}); // delete new key
      s3Client.send.mockResolvedValueOnce({ Body: bodyOf(v1State('S', 'us-west-2')) });

      await backend.deleteState('S', 'us-east-1');

      // No DeleteObject for the legacy key (region mismatch). A journal
      // sweep (issue #1183) also fires but targets a different key, so
      // assert on the legacy key specifically rather than the raw count.
      const deletedKeys = s3Client.send.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((cmd: unknown) => cmd instanceof DeleteObjectCommand)
        .map((cmd: DeleteObjectCommand) => cmd.input.Key);
      expect(deletedKeys).not.toContain('cdkd/S/state.json');
      expect(deletedKeys).toContain('cdkd/S/us-east-1/state.json');
    });
  });

  describe('listRawKeys', () => {
    it('collects keys across multiple ListObjectsV2 pages via ContinuationToken', async () => {
      // Page 1: truncated, hands back a continuation token.
      s3Client.send.mockResolvedValueOnce({
        Contents: [
          { Key: 'cdkd/S/us-east-1/deployments/run-1.jsonl' },
          { Key: 'cdkd/S/us-east-1/deployments/run-2.jsonl' },
        ],
        IsTruncated: true,
        NextContinuationToken: 'token-page-2',
      });
      // Page 2: terminal page, no further token.
      s3Client.send.mockResolvedValueOnce({
        Contents: [
          { Key: 'cdkd/S/us-east-1/deployments/run-3.jsonl' },
          { Key: 'cdkd/S/us-east-1/deployments/index.json' },
        ],
        IsTruncated: false,
      });

      const keys = await backend.listRawKeys('cdkd/S/us-east-1/deployments/');

      // All keys from BOTH pages are collected (pagination did not stop at page 1).
      expect(keys).toEqual([
        'cdkd/S/us-east-1/deployments/run-1.jsonl',
        'cdkd/S/us-east-1/deployments/run-2.jsonl',
        'cdkd/S/us-east-1/deployments/run-3.jsonl',
        'cdkd/S/us-east-1/deployments/index.json',
      ]);

      const listCalls = s3Client.send.mock.calls.filter(
        (c: unknown[]) => c[0] instanceof ListObjectsV2Command
      );
      expect(listCalls).toHaveLength(2);
      // First page has no ContinuationToken; second page carries page-1's token.
      expect((listCalls[0][0] as ListObjectsV2Command).input.ContinuationToken).toBeUndefined();
      expect((listCalls[1][0] as ListObjectsV2Command).input.ContinuationToken).toBe('token-page-2');
      expect((listCalls[0][0] as ListObjectsV2Command).input.Prefix).toBe(
        'cdkd/S/us-east-1/deployments/'
      );
    });

    it('returns an empty list when no objects match the prefix', async () => {
      s3Client.send.mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });
      const keys = await backend.listRawKeys('cdkd/Nope/');
      expect(keys).toEqual([]);
    });
  });
});

describe('S3StateBackend rollback journal (issue #1183)', () => {
  let s3Client: ReturnType<typeof makeFakeClient>;
  let backend: S3StateBackend;
  const config: StateBackendConfig = { bucket: 'state-bucket', prefix: 'cdkd' };

  const journalKey = 'cdkd/S/us-east-1/rollback-journal.json';
  function rawBody(obj: unknown) {
    return { transformToString: () => Promise.resolve(JSON.stringify(obj)) };
  }
  function segment(reason: string, ops: unknown[] = []) {
    return { timestamp: 1, reason, initialDeploy: false, operations: ops };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    s3Client = makeFakeClient('us-east-1');
    backend = new S3StateBackend(s3Client as unknown as S3Client, config);
  });

  it('loadRollbackJournal returns null when no journal exists', async () => {
    s3Client.send.mockRejectedValueOnce(new NoSuchKey({ message: 'nope', $metadata: {} }));
    const journal = await backend.loadRollbackJournal('S', 'us-east-1');
    expect(journal).toBeNull();
  });

  it('appendRollbackJournalSegment creates a new journal when absent', async () => {
    s3Client.send.mockRejectedValueOnce(new NoSuchKey({ message: 'nope', $metadata: {} })); // load
    s3Client.send.mockResolvedValueOnce({}); // put
    await backend.appendRollbackJournalSegment('S', 'us-east-1', segment('interrupted') as never);
    const put = s3Client.send.mock.calls
      .map((c: unknown[]) => c[0])
      .find((cmd: unknown) => cmd instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.Key).toBe(journalKey);
    const body = JSON.parse(put.input.Body as string);
    expect(body.journalVersion).toBe(1);
    expect(body.segments).toHaveLength(1);
  });

  it('appendRollbackJournalSegment preserves existing segments', async () => {
    const existing = { journalVersion: 1, stackName: 'S', region: 'us-east-1', segments: [segment('interrupted')] };
    s3Client.send.mockResolvedValueOnce({ Body: rawBody(existing) }); // load
    s3Client.send.mockResolvedValueOnce({}); // put
    await backend.appendRollbackJournalSegment('S', 'us-east-1', segment('no-rollback-failure') as never);
    const put = s3Client.send.mock.calls
      .map((c: unknown[]) => c[0])
      .find((cmd: unknown) => cmd instanceof PutObjectCommand) as PutObjectCommand;
    const body = JSON.parse(put.input.Body as string);
    expect(body.segments).toHaveLength(2);
    expect(body.segments[0].reason).toBe('interrupted');
    expect(body.segments[1].reason).toBe('no-rollback-failure');
  });

  it('popRollbackJournalSegment deletes the journal when the last segment is removed', async () => {
    const one = { journalVersion: 1, stackName: 'S', region: 'us-east-1', segments: [segment('interrupted')] };
    s3Client.send.mockResolvedValueOnce({ Body: rawBody(one) }); // load
    s3Client.send.mockResolvedValueOnce({}); // delete
    const remaining = await backend.popRollbackJournalSegment('S', 'us-east-1');
    expect(remaining).toBe(0);
    const del = s3Client.send.mock.calls
      .map((c: unknown[]) => c[0])
      .find((cmd: unknown) => cmd instanceof DeleteObjectCommand) as DeleteObjectCommand;
    expect(del.input.Key).toBe(journalKey);
  });

  it('popRollbackJournalSegment rewrites the journal when segments remain', async () => {
    const two = {
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [segment('interrupted'), segment('no-rollback-failure')],
    };
    s3Client.send.mockResolvedValueOnce({ Body: rawBody(two) }); // load
    s3Client.send.mockResolvedValueOnce({}); // put
    const remaining = await backend.popRollbackJournalSegment('S', 'us-east-1');
    expect(remaining).toBe(1);
    const put = s3Client.send.mock.calls
      .map((c: unknown[]) => c[0])
      .find((cmd: unknown) => cmd instanceof PutObjectCommand) as PutObjectCommand;
    const body = JSON.parse(put.input.Body as string);
    expect(body.segments).toHaveLength(1);
    expect(body.segments[0].reason).toBe('interrupted');
  });

  it('deleteRollbackJournal tolerates a missing journal', async () => {
    s3Client.send.mockRejectedValueOnce(new NoSuchKey({ message: 'nope', $metadata: {} }));
    await expect(backend.deleteRollbackJournal('S', 'us-east-1')).resolves.toBeUndefined();
  });

  it('setRollbackJournalFailedOperations([]) strips the field from the NEWEST segment only (#1198)', async () => {
    const failedOp = { logicalId: 'Q', changeType: 'UPDATE', resourceType: 'T' };
    const two = {
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        { ...segment('interrupted'), failedOperations: [failedOp] },
        { ...segment('no-rollback-failure'), failedOperations: [failedOp] },
      ],
    };
    s3Client.send.mockResolvedValueOnce({ Body: rawBody(two) }); // load
    s3Client.send.mockResolvedValueOnce({}); // put
    await backend.setRollbackJournalFailedOperations('S', 'us-east-1', []);
    const put = s3Client.send.mock.calls
      .map((c: unknown[]) => c[0])
      .find((cmd: unknown) => cmd instanceof PutObjectCommand) as PutObjectCommand;
    const body = JSON.parse(put.input.Body as string);
    expect(body.segments[1].failedOperations).toBeUndefined();
    // Older segment untouched — only the segment being replayed is stripped.
    expect(body.segments[0].failedOperations).toHaveLength(1);
  });

  it('setRollbackJournalFailedOperations persists a PARTIAL remaining list (per-op strip)', async () => {
    const opA = { logicalId: 'A', changeType: 'UPDATE', resourceType: 'T' };
    const opB = { logicalId: 'B', changeType: 'UPDATE', resourceType: 'T' };
    const one = {
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [{ ...segment('no-rollback-failure'), failedOperations: [opA, opB] }],
    };
    s3Client.send.mockResolvedValueOnce({ Body: rawBody(one) }); // load
    s3Client.send.mockResolvedValueOnce({}); // put
    await backend.setRollbackJournalFailedOperations('S', 'us-east-1', [opB] as never);
    const put = s3Client.send.mock.calls
      .map((c: unknown[]) => c[0])
      .find((cmd: unknown) => cmd instanceof PutObjectCommand) as PutObjectCommand;
    const body = JSON.parse(put.input.Body as string);
    expect(body.segments[0].failedOperations).toEqual([opB]);
  });

  it('setRollbackJournalFailedOperations is a no-op without a journal / field', async () => {
    s3Client.send.mockRejectedValueOnce(new NoSuchKey({ message: 'nope', $metadata: {} }));
    await expect(
      backend.setRollbackJournalFailedOperations('S', 'us-east-1', [])
    ).resolves.toBeUndefined();
    // No PutObject was issued.
    const put = s3Client.send.mock.calls
      .map((c: unknown[]) => c[0])
      .find((cmd: unknown) => cmd instanceof PutObjectCommand);
    expect(put).toBeUndefined();
    // Field absent on the newest segment → also a silent no-op.
    const noField = { journalVersion: 1, stackName: 'S', region: 'us-east-1', segments: [segment('interrupted')] };
    s3Client.send.mockResolvedValueOnce({ Body: rawBody(noField) });
    await backend.setRollbackJournalFailedOperations('S', 'us-east-1', []);
    const put2 = s3Client.send.mock.calls
      .map((c: unknown[]) => c[0])
      .find((cmd: unknown) => cmd instanceof PutObjectCommand);
    expect(put2).toBeUndefined();
  });
});
