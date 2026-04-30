import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import type { StackState } from '../../../src/types/state.js';
import { StateError } from '../../../src/utils/error-handler.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';

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
  config: { region: () => Promise<string> };
} {
  return {
    send: vi.fn(),
    destroy: vi.fn(),
    config: { region: () => Promise.resolve(region) },
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
    expect(call.input).toEqual({ Bucket: 'my-state-bucket' });
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
  let s3Client: { send: ReturnType<typeof vi.fn> };
  let backend: S3StateBackend;
  const config: StateBackendConfig = {
    bucket: 'state-bucket',
    prefix: 'cdkd',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    s3Client = { send: vi.fn() };
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
      // An old cdkd binary (version 1/2) trying to read a `version: 3` blob
      // must fail with a clear "upgrade cdkd" error rather than silently
      // mishandling unknown fields.
      const future = { version: 3, stackName: 'X', resources: {}, outputs: {}, lastModified: 0 };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(future)) },
        ETag: '"e"',
      });

      const caught = await backend.getState('X', 'us-east-1').catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(StateError);
      expect((caught as Error).message).toMatch(/Unsupported state schema version 3/);
      expect((caught as Error).message).toMatch(/Upgrade cdkd/);
    });
  });

  describe('saveState', () => {
    it('writes to the new region-scoped key and forces version: 2 on disk', async () => {
      s3Client.send.mockResolvedValueOnce({ ETag: '"new"' });

      const etag = await backend.saveState('MyStack', 'us-west-2', v1State('MyStack', 'us-west-2'));

      expect(etag).toBe('"new"');
      const put = s3Client.send.mock.calls[0][0];
      expect(put).toBeInstanceOf(PutObjectCommand);
      expect(put.input.Key).toBe('cdkd/MyStack/us-west-2/state.json');
      const persisted = JSON.parse(put.input.Body) as StackState;
      // Schema version is bumped to 2 even when the caller passed a `version: 1`
      // body — the on-disk format is always current.
      expect(persisted.version).toBe(2);
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
    });

    it('leaves a legacy key alone when its region does not match', async () => {
      s3Client.send.mockResolvedValueOnce({}); // delete new key
      s3Client.send.mockResolvedValueOnce({ Body: bodyOf(v1State('S', 'us-west-2')) });

      await backend.deleteState('S', 'us-east-1');

      // No second DeleteObject for the legacy key.
      const deletes = s3Client.send.mock.calls.filter(
        (c: unknown[]) => c[0] instanceof DeleteObjectCommand
      );
      expect(deletes).toHaveLength(1);
    });
  });
});

// Reference unused imports to keep ESLint happy without changing behavior.
void ListObjectsV2Command;
