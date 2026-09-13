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

// The child double is HOISTED and stable rather than a fresh `vi.fn()` per
// `child()` call, so a debug-only side effect is assertable at all. It has to
// be: `listRawObjects` DROPS a malformed `Contents` entry, and the returned
// list is a shorter array with no other signal — the debug line is the only
// place a caller can ever observe the drop.
const { childLoggerMock } = vi.hoisted(() => ({
  childLoggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLoggerMock,
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

  // Issue #1283: the deploy preflight's HeadBucket duplicates the one the
  // default-state-bucket name resolution just issued. `existenceAlreadyProbed`
  // drops the duplicate — but ONLY the HEAD, never the region resolution, and
  // never for a bucket the resolution did not probe.
  describe('existenceAlreadyProbed (issue #1283)', () => {
    it('skips the HeadBucket when the caller already probed the bucket', async () => {
      await expect(
        backend.verifyBucketExists({ existenceAlreadyProbed: true })
      ).resolves.toBeUndefined();

      expect(s3Client.send).not.toHaveBeenCalled();
    });

    it('still resolves the bucket region + rebuilds the client when skipping the HeadBucket', async () => {
      const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
      // Bucket lives in us-west-2; the client was built for us-east-1. Every
      // later state operation depends on this rebuild, so it must happen even
      // though the HEAD is skipped.
      vi.mocked(resolveBucketRegion).mockResolvedValue('us-west-2');
      const initialClient = makeFakeClient('us-east-1');
      const crossRegionBackend = new S3StateBackend(
        initialClient as unknown as S3Client,
        { bucket: 'cross-region-bucket', prefix: 'stacks' },
        { region: 'us-east-1' }
      );

      await crossRegionBackend.verifyBucketExists({ existenceAlreadyProbed: true });

      expect(vi.mocked(resolveBucketRegion)).toHaveBeenCalled();
      expect(initialClient.destroy).toHaveBeenCalled();
      expect(vi.mocked(S3Client)).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'us-west-2' })
      );
      // …and no HeadBucket was issued on either client.
      expect(initialClient.send).not.toHaveBeenCalled();
    });

    it('keeps the HeadBucket when the flag is false or absent', async () => {
      s3Client.send.mockResolvedValue({});

      await backend.verifyBucketExists({ existenceAlreadyProbed: false });
      await backend.verifyBucketExists();

      expect(s3Client.send).toHaveBeenCalledTimes(2);
      expect(s3Client.send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    });
  });
});

/**
 * The exact composition `cdkd deploy`'s state preflight performs (issue
 * #1283): the resolved bucket's {@link StateBucketSource} decides whether the
 * duplicate HeadBucket is dropped. Exercised with BOTH real units — the real
 * `stateBucketExistenceConfirmed` mapping and a real `S3StateBackend` — so a
 * regression in either half fails here.
 */
describe('deploy preflight composition: source -> verifyBucketExists (issue #1283)', () => {
  const config: StateBackendConfig = { bucket: 'my-state-bucket', prefix: 'stacks' };

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
  });

  it.each([
    { source: 'cli-flag' as const, probe: undefined },
    { source: 'env' as const, probe: undefined },
    { source: 'cdk.json' as const, probe: undefined },
    // A default-name bucket the resolution could NOT head (403: IAM gap, or a
    // foreign-owned squatted name) keeps the fail-fast too — "exists" is not
    // "usable".
    { source: 'default' as const, probe: 'access-denied' as const },
    { source: 'default-legacy' as const, probe: 'access-denied' as const },
  ])(
    'a bucket this resolution never cleanly verified ($source/$probe) still fails fast',
    async ({ source, probe }) => {
      const { stateBucketExistenceConfirmed } = await import(
        '../../../src/cli/config-loader.js'
      );
      const client = makeFakeClient('us-east-1');
      client.send.mockRejectedValue(Object.assign(new Error('Not Found'), { name: 'NotFound' }));
      const backend = new S3StateBackend(client as unknown as S3Client, config, {
        region: 'us-east-1',
      });

      const caught = await backend
        .verifyBucketExists({
          existenceAlreadyProbed: stateBucketExistenceConfirmed({
            bucket: config.bucket,
            source,
            ...(probe && { probe }),
          }),
        })
        .catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(StateError);
      expect((caught as Error).message).toMatch(/does not exist/);
      // The HEAD really was issued — the fail-fast is not incidental.
      expect(client.send).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['default', 'default-legacy'] as const)(
    'a cleanly-probed default-resolved (%s) bucket skips the duplicate HeadBucket',
    async (source) => {
      const { stateBucketExistenceConfirmed } = await import(
        '../../../src/cli/config-loader.js'
      );
      const client = makeFakeClient('us-east-1');
      // Would reject if called — proving the HEAD is never issued.
      client.send.mockRejectedValue(new Error('HeadBucket should not have been issued'));
      const backend = new S3StateBackend(client as unknown as S3Client, config, {
        region: 'us-east-1',
      });

      await expect(
        backend.verifyBucketExists({
          existenceAlreadyProbed: stateBucketExistenceConfirmed({
            bucket: config.bucket,
            source,
            probe: 'ok',
          }),
        })
      ).resolves.toBeUndefined();
      expect(client.send).not.toHaveBeenCalled();
    }
  );
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

    it('refuses a NON-NUMERIC version, not only an unknown number', async () => {
      // `cdkd state show` interpolates `state.version` without a display guard,
      // unlike every other field it renders, and this refusal is the whole reason
      // that is safe: a string here would reach the row and could carry a newline.
      // The rejection has to be membership, not a version COMPARISON — a
      // `v > CURRENT` check would keep the case above green and admit this one.
      for (const version of ['2', '2\nStack: Fake', true, {}, []]) {
        const bad = { version, stackName: 'X', resources: {}, outputs: {}, lastModified: 0 };
        s3Client.send.mockResolvedValueOnce({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(bad)) },
          ETag: '"e"',
        });

        const caught = await backend.getState('X', 'us-east-1').catch((e: unknown) => e);
        expect(caught, `version ${JSON.stringify(version)}`).toBeInstanceOf(StateError);
        expect((caught as Error).message).toMatch(/Unsupported state schema version/);
      }
    });

    it('the version refusal cannot forge a row with the value it refuses (issue #3003)', async () => {
      // The case above proves the record is REFUSED. What it does not cover is
      // what the refusal SAYS: the message interpolated the raw value, so the
      // string that never reached the rendered row reached the diagnostic
      // instead — and cdkd's output is line-oriented.
      const bad = {
        version: '2\n  PhysicalID: arn\u200b:forged',
        stackName: 'X',
        resources: {},
        outputs: {},
        lastModified: 0,
      };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(bad)) },
        ETag: '"e"',
      });

      const caught = await backend.getState('X', 'us-east-1').catch((e: unknown) => e);
      const message = (caught as Error).message;
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      // Not vacuous: the refusal still NAMES the offending value, flattened.
      expect(message).toContain('PhysicalID: arn :forged');
      // The CLASS as well as the guard: a zero-width space survives the
      // denylist and only the allowlist removes it.
      expect(message).not.toMatch(/[\u200b-\u200f\ufeff]/);
    });

    it('sanitizes the REGION in getState\'s own refusals (issue #3003)', async () => {
      // The region here is a raw `listStacks` key segment, and this refusal is
      // the deterministically reachable one: a planted object whose storage
      // class makes GetObject fail with something other than NoSuchKey lands
      // the segment in the message. A first cut of issue #3003 guarded the two
      // `parseStateBody` refusals and left these three, in the same function.
      const denied = Object.assign(new Error('InvalidObjectState: storage class'), {
        name: 'InvalidObjectState',
      });
      s3Client.send.mockRejectedValueOnce(denied);

      const caught = await backend
        .getState('X', 'us-east-1\n  PhysicalID: arn:forged')
        .catch((e: unknown) => e);
      const message = (caught as Error).message;

      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(message).toContain('Failed to get state');
      expect(message).toContain('PhysicalID: arn:forged');
    });

    it('sanitizes the has-no-ETag refusal (issue #3003)', async () => {
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve('{}') },
      });

      const caught = await backend
        .getState('X', 'us-east-1\n  PhysicalID: arn:forged')
        .catch((e: unknown) => e);
      const message = (caught as Error).message;

      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(message).toContain('has no ETag');
      expect(message).toContain('PhysicalID: arn:forged');
    });

    it('sanitizes the REGION in every debug line of the success path (issue #3003)', async () => {
      // The region holes of `Getting state for stack` / `Retrieved state` were
      // guarded and fenced by nothing: the only case reaching them passed a
      // benign `us-east-1`. This drives the SUCCESS path, which is the one
      // that reaches `Retrieved state` at all.
      childLoggerMock.debug.mockClear();
      const good = { version: 2, stackName: 'S', region: 'us-east-1', resources: {}, outputs: {}, lastModified: 0 };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(good)) },
        ETag: '"e"',
      });

      const result = await backend.getState('S', 'us-east-1\n  PhysicalID: arn:forged');
      expect(result).not.toBeNull();

      const calls = childLoggerMock.debug.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls.some((c) => c.includes('Retrieved state'))).toBe(true);
      for (const call of calls) {
        expect(call, call).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      }
      // Bound to the line this case exists for, not to the joined blob: a
      // joined `toContain` is satisfied by `Getting state for stack` alone, so
      // dropping the region from `Retrieved state` would leave it green.
      expect(calls.find((c) => c.includes('Retrieved state'))).toContain('PhysicalID: arn:forged');
      expect(calls.find((c) => c.includes('Getting state for stack'))).toContain(
        'PhysicalID: arn:forged'
      );
    });

    it('sanitizes the REGION on the MISS path too (issue #3003)', async () => {
      // The success path returns before `No state at new key`, so the case
      // above cannot reach that line. This one takes the miss path. It does
      // NOT reach the legacy region-mismatch line -- both sends reject
      // `NoSuchKey`, so `tryGetLegacy` returns before the region gate -- and
      // an earlier revision of this comment said it did.
      childLoggerMock.debug.mockClear();
      const noSuchKey = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(noSuchKey);
      s3Client.send.mockRejectedValueOnce(noSuchKey);

      const result = await backend.getState('S', 'us-east-1\n  PhysicalID: arn:forged');
      expect(result).toBeNull();

      const calls = childLoggerMock.debug.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls.some((c) => c.includes('No state at new key'))).toBe(true);
      for (const call of calls) {
        expect(call, call).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      }
      expect(calls.find((c) => c.includes('No state at new key'))).toContain(
        'PhysicalID: arn:forged'
      );
    });

    it('uses the ASCII ALLOWLIST for the NAME and the REGION too (issue #3003)', async () => {
      // The class was pinned at one site per file, so `displayName` and the
      // region carried none: flipping `asciiOnly` off at either left every
      // case green. A zero-width space and a bidi mark are what discriminate.
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve('{}') },
      });

      const caught = await backend
        .getState('Gho\u200bst', 'us-\u200eeast-1')
        .catch((e: unknown) => e);
      const message = (caught as Error).message;

      expect(message).not.toMatch(/[\u200b-\u200f\ufeff]/);
      // Not vacuous: both values are still reported, with the invisible gone.
      expect(message).toContain('Gho st');
      expect(message).toContain('us- east-1');
    });

    it('uses the ASCII ALLOWLIST, not the denylist, for the error detail (issue #3003)', async () => {
      // The class itself, which nothing pinned: every hostile byte in the
      // cases around this one is in BOTH classes, so flipping `asciiOnly` off
      // left them all green. A zero-width space and a bidi MARK are in
      // neither denylist -- `display-safe.ts` names them as its residual --
      // and only the allowlist removes them. They matter here because both
      // can hide or reorder text inside a row a reader is trying to trust.
      s3Client.send.mockRejectedValueOnce(
        Object.assign(new Error('Denied\u200b\u200e at region'), { name: 'AccessDenied' })
      );

      const caught = await backend.getState('X', 'us-east-1').catch((e: unknown) => e);
      const message = (caught as Error).message;

      expect(message).not.toMatch(/[\u200b-\u200f\ufeff]/);
      // Not vacuous: the surrounding words are still reported.
      expect(message).toContain('Denied');
      expect(message).toContain('at region');
    });

    it('sanitizes the STACK NAME in every remaining refusal and warning (issue #3003)', async () => {
      // Six interpolations were guarded and fenced by nothing: the stack half
      // of `has no ETag`, `Retrieved state`, `Failed to get state` and the
      // legacy-loaded WARN, plus that warning's KEY and that refusal's DETAIL.
      // Every case reaching them passed the benign name 'X'.
      childLoggerMock.debug.mockClear();
      childLoggerMock.warn.mockClear();
      const hostile = 'Ghost\n  Stack\u200bForged: yes';

      // (a) `Failed to get state`, whose DETAIL is an AWS message here.
      s3Client.send.mockRejectedValueOnce(
        Object.assign(new Error('Denied\n  DetailForged: yes'), { name: 'AccessDenied' })
      );
      const failed = await backend.getState(hostile, 'us-east-1').catch((e: unknown) => e);
      expect((failed as Error).message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect((failed as Error).message).toContain('Stack Forged: yes');
      expect((failed as Error).message).toContain('DetailForged: yes');

      // (b) `has no ETag`.
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve('{}') },
      });
      const noEtag = await backend.getState(hostile, 'us-east-1').catch((e: unknown) => e);
      expect((noEtag as Error).message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect((noEtag as Error).message).toContain('Stack Forged: yes');

      // (c) `Retrieved state`, on the success path.
      const good = { version: 2, stackName: 'S', region: 'us-east-1', resources: {}, outputs: {}, lastModified: 0 };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(good)) },
        ETag: '"e"',
      });
      expect(await backend.getState(hostile, 'us-east-1')).not.toBeNull();
      const retrieved = childLoggerMock.debug.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .find((c) => c.includes('Retrieved state'));
      expect(retrieved).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(retrieved).toContain('Stack Forged: yes');

      // (d) the legacy-loaded WARN, whose NAME and KEY are both interpolated.
      const noSuchKey = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(noSuchKey);
      s3Client.send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ version: 1, stackName: 'S', resources: {}, outputs: {}, lastModified: 1 })
            ),
        },
        ETag: '"e"',
      });
      expect(await backend.getState(hostile, 'us-east-1')).not.toBeNull();
      const warned = childLoggerMock.warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(warned).toContain('Loaded legacy state');
      expect(warned).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      // The name appears twice: on its own and inside the printed KEY.
      expect(warned.match(/Stack Forged: yes/g)).toHaveLength(2);
      // The KEY takes the allowlist too, which nothing pinned: the name
      // reaches it through `getLegacyStateKey`.
      expect(warned).not.toMatch(/[\u200b-\u200f\ufeff]/);
    });

    it('sanitizes the legacy region-mismatch DEBUG line (issue #3003)', async () => {
      // A debug line, but debug is quieter than warn -- not a different
      // terminal -- and this one carries both a stack name and state-BODY
      // content. Its sibling in `probeLegacyState` has been sanitized since
      // issue #1926; this one had not.
      childLoggerMock.debug.mockClear();
      const noSuchKey = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(noSuchKey);
      s3Client.send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({
                version: 1,
                stackName: 'S',
                region: 'eu-west-1\n  PhysicalID: arn\u200b:forged',
                resources: {},
                outputs: {},
                lastModified: 1,
              })
            ),
        },
        ETag: '"e"',
      });

      // The CALLER's region is hostile too: that line interpolates three
      // values and a case driving only two left the third reddening nothing.
      const result = await backend.getState(
        'Ghost\n  StackForged: yes',
        'us-east-1\n  Caller\u200bForged: yes'
      );
      expect(result).toBeNull();

      // PER CALL, not over a joined blob: joining and then splitting on `\n`
      // is blind to the very newline under test, and a blob also drags in
      // sibling lines this case does not own. Each call's own string still
      // contains an injected newline if one survived.
      const debugCalls = childLoggerMock.debug.mock.calls.map((c: unknown[]) => String(c[0]));
      const debugText = debugCalls.join('\n');
      expect(debugText).toContain('skipping legacy fallback');
      // Every captured call, so a sibling line on this same read path that
      // stayed raw fails here too -- which is how this case found two.
      for (const call of debugCalls) {
        expect(call, call).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      }
      const mismatch = debugCalls.find((c) => c.includes('skipping legacy fallback'));
      expect(mismatch).toContain('PhysicalID: arn :forged');
      expect(mismatch).not.toMatch(/[\u200b-\u200f\ufeff]/);
      expect(mismatch).toContain('StackForged: yes');
      expect(mismatch).toContain('Caller Forged: yes');
    });

    it('sanitizes the LEGACY-key read failure, on getState\'s own fallback (issue #3003)', async () => {
      // `getState` falls back to the legacy key when the region-scoped one is
      // absent, so `tryGetLegacy`'s refusal is on the `state show` path too.
      const noSuchKey = new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      s3Client.send.mockRejectedValueOnce(noSuchKey);
      s3Client.send.mockRejectedValueOnce(
        Object.assign(new Error('InvalidObjectState\n  Detail\u200bForged: yes'), {
          name: 'InvalidObjectState',
        })
      );

      const caught = await backend
        .getState('Ghost\n  PhysicalID: arn:forged', 'us-east-1')
        .catch((e: unknown) => e);
      const message = (caught as Error).message;

      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(message).toContain('legacy state');
      expect(message).toContain('PhysicalID: arn:forged');
      // The DETAIL half, which was guarded and fenced by nothing: its twin in
      // `Failed to get state` is covered, this one was not.
      expect(message).toContain('Detail Forged: yes');
      expect(message).not.toMatch(/[\u200b-\u200f\ufeff]/);
    });

    it('sanitizes BOTH the stack name and the region in the has-no-body refusal (issue #3003)', async () => {
      // Both halves, in one case, because they come from the same S3 key and
      // a case that hardened only the region left the name unfenced --
      // neutering `this.displayName(stackName)` there reddened no injection
      // case anywhere in the suite.
      s3Client.send.mockResolvedValueOnce({ ETag: '"e"' });

      const caught = await backend
        .getState('Ghost\n  StackForged: yes', 'us-east-1\n  PhysicalID: arn:forged')
        .catch((e: unknown) => e);
      const message = (caught as Error).message;

      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(message).toContain('has no body');
      expect(message).toContain('PhysicalID: arn:forged');
      expect(message).toContain('StackForged: yes');
    });

    it('sanitizes the STACK NAME in the VERSION refusal too (issue #3003)', async () => {
      // The invalid-JSON case below covers the other arm. This one is separate
      // because the two refusals are separate templates: a first cut named one
      // case "in both refusals" and drove only the parse arm, so reverting
      // `this.displayName(stackName)` in the VERSION message left every case
      // green.
      const bad = { version: 99, stackName: 'X', resources: {}, outputs: {}, lastModified: 0 };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(bad)) },
        ETag: '"e"',
      });

      const caught = await backend
        .getState('Ghost\n  PhysicalID: arn:forged', 'us-east-1')
        .catch((e: unknown) => e);
      const message = (caught as Error).message;

      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(message).toContain('Unsupported state schema version 99');
      expect(message).toContain('Ghost');
    });

    it('reports a null VERSION as the word rather than the unrenderable stand-in (issue #3003)', async () => {
      // `displaySafe` maps `null` to the empty string, so passing the value
      // straight in would replace a precise, already-safe word with the
      // stand-in. Coercing first keeps it.
      const bad = { version: null, stackName: 'X', resources: {}, outputs: {}, lastModified: 0 };
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(bad)) },
        ETag: '"e"',
      });

      const caught = await backend.getState('X', 'us-east-1').catch((e: unknown) => e);
      expect((caught as Error).message).toContain('Unsupported state schema version null');
    });

    it('the invalid-JSON refusal cannot forge a row with the body it quotes (issue #3003)', async () => {
      // V8's `SyntaxError` quotes the offending INPUT, so this message carries
      // bytes of a file anyone with `s3:PutObject` on the bucket can write.
      // `probeLegacyState` has sanitized its own copy of this failure since
      // issue #1926; this arm was the sibling that did not.
      //
      // The body shape is load-bearing and was MEASURED rather than assumed.
      // V8 quotes the input only for its `Unexpected token 'X', "..." is not
      // valid JSON` message; the `Expected double-quoted property name ...` and
      // `Unexpected non-whitespace character ...` forms carry a POSITION and no
      // input at all. A first draft of this case used `{"version":1,<newline>`,
      // which takes the position-only form — so it passed with the guard
      // removed, proving nothing. An array opener reaches the quoting form.
      s3Client.send.mockResolvedValueOnce({
        Body: {
          transformToString: () => Promise.resolve('[1,2,\n  Phys\u200bicalID: arn:forged]'),
        },
        ETag: '"e"',
      });

      const caught = await backend.getState('X', 'us-east-1').catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(StateError);
      const message = (caught as Error).message;
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      // Not vacuous, and specifically about the QUOTING form: `is not valid
      // JSON` is in the production template whether or not V8 quoted the body,
      // so asserting only that would let a Node upgrade flip this fixture back
      // to the position-only message and silently restore the vacuity this
      // case was rewritten to escape. `PhysicalID` can only have come FROM the
      // body.
      expect(message).toContain('is not valid JSON');
      // The needle fits V8's quote window, which truncates mid-word.
      expect(message).toContain('Phys ical');
      expect(message).not.toMatch(/[\u200b-\u200f\ufeff]/);
    });

    it('sanitizes the STACK NAME in the invalid-JSON refusal (issue #3003)', async () => {
      // The name reaches here from a raw S3 key segment on the `state show`
      // path, so it is the same untrusted class as the body. `displayName`
      // already existed in this class for exactly this; the two refusals did
      // not use it.
      const hostile = 'Ghost\n  PhysicalID: arn:forged';
      s3Client.send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve('not json at all {') },
        ETag: '"e"',
      });

      const caught = await backend.getState(hostile, 'us-east-1').catch((e: unknown) => e);
      const message = (caught as Error).message;
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(message).toContain('Ghost');
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

    // Issue #2550 split the three answers that used to read as one
    // `undefined`. These pin which of them `stateExists` now says yes to.
    it('returns true for a legacy body that names NO region, from any region', async () => {
      // `getState` would return this record for any region — `tryGetLegacy`'s
      // gate only refuses a body naming a DIFFERENT one. `stateExists` has to
      // agree, or it reports "no state" for a record the next read returns.
      s3Client.send.mockRejectedValueOnce(Object.assign(new Error('NF'), { name: 'NotFound' }));
      s3Client.send.mockResolvedValueOnce({ Body: bodyOf(v1State('S')) });

      await expect(backend.stateExists('S', 'eu-west-1')).resolves.toBe(true);
    });

    it('returns false when the legacy key is absent', async () => {
      // The case that makes the one-line fix wrong: `readLegacyRegion`
      // returned `undefined` here too, so accepting `undefined` would report
      // state for a stack that has none — and `reconcileRegionWithLegacyDefault`
      // picks a region from this answer.
      s3Client.send.mockRejectedValueOnce(Object.assign(new Error('NF'), { name: 'NotFound' }));
      s3Client.send.mockRejectedValueOnce(
        Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
      );

      await expect(backend.stateExists('S', 'us-east-1')).resolves.toBe(false);
    });

    it('returns false when the legacy key cannot be read', async () => {
      // A denied or throttled read says nothing about who owns the record.
      s3Client.send.mockRejectedValueOnce(Object.assign(new Error('NF'), { name: 'NotFound' }));
      s3Client.send.mockRejectedValueOnce(
        Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' })
      );

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

    // Issue #2550. `tryGetLegacy` accepts a body naming NO region from any
    // region, so `cdkd destroy` reads such a record and deletes the AWS
    // resources. The sweep's old equality test answered
    // `undefined === 'us-east-1'` — false — so the record survived a
    // successful destroy and the next deploy of that name planned updates
    // against resources that no longer existed.
    it('sweeps a legacy key whose body names NO region', async () => {
      s3Client.send.mockResolvedValueOnce({}); // delete new key
      s3Client.send.mockResolvedValueOnce({ Body: bodyOf(v1State('S')) }); // probe: no region
      s3Client.send.mockResolvedValueOnce({}); // delete legacy key

      await backend.deleteState('S', 'us-east-1');

      const deletedKeys = s3Client.send.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((cmd: unknown) => cmd instanceof DeleteObjectCommand)
        .map((cmd: DeleteObjectCommand) => cmd.input.Key);
      expect(deletedKeys).toContain('cdkd/S/state.json');
    });

    it('does not sweep a legacy key it could not read', async () => {
      // The arm that keeps the fix from being "treat undefined as a match":
      // a 403 / 503 / malformed body says nothing about who owns the record,
      // and a read that failed must never authorise a delete.
      s3Client.send.mockResolvedValueOnce({}); // delete new key
      s3Client.send.mockRejectedValueOnce(
        Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' })
      );

      await backend.deleteState('S', 'us-east-1');

      const deletedKeys = s3Client.send.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((cmd: unknown) => cmd instanceof DeleteObjectCommand)
        .map((cmd: DeleteObjectCommand) => cmd.input.Key);
      expect(deletedKeys).not.toContain('cdkd/S/state.json');
    });

    it('does not sweep a legacy body whose region is a non-string', async () => {
      // `tryGetLegacy`'s gate is `state.region && state.region !== region`, so
      // a truthy NON-string (a mangled `"region": 123`) makes the READ refuse
      // from every region. Classifying it with the region-less bodies would
      // have the sweep delete a record `getState` will not even read — issue
      // #2550's asymmetry pointing the other way.
      s3Client.send.mockResolvedValueOnce({}); // delete new key
      s3Client.send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ version: 1, stackName: 'S', region: 123, resources: {}, outputs: {}, lastModified: 1 })
            ),
        },
      });

      await backend.deleteState('S', 'us-east-1');

      const deletedKeys = s3Client.send.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((cmd: unknown) => cmd instanceof DeleteObjectCommand)
        .map((cmd: DeleteObjectCommand) => cmd.input.Key);
      expect(deletedKeys).not.toContain('cdkd/S/state.json');
    });

    it('sweeps a legacy body whose region is the empty string', async () => {
      // The mirrored trap: a string, so a `typeof` test files it under
      // `region`, but falsy — so the read gate passes it from any region and
      // an equality test (`'' === 'us-east-1'`) would refuse to sweep it,
      // which is #2550 verbatim.
      s3Client.send.mockResolvedValueOnce({}); // delete new key
      s3Client.send.mockResolvedValueOnce({
        Body: {
          transformToString: () =>
            Promise.resolve(
              JSON.stringify({ version: 1, stackName: 'S', region: '', resources: {}, outputs: {}, lastModified: 1 })
            ),
        },
      });
      s3Client.send.mockResolvedValueOnce({}); // delete legacy key

      await backend.deleteState('S', 'us-east-1');

      const deletedKeys = s3Client.send.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((cmd: unknown) => cmd instanceof DeleteObjectCommand)
        .map((cmd: DeleteObjectCommand) => cmd.input.Key);
      expect(deletedKeys).toContain('cdkd/S/state.json');
    });

    it('does not sweep when the probe response carries no body', async () => {
      s3Client.send.mockResolvedValueOnce({}); // delete new key
      s3Client.send.mockResolvedValueOnce({}); // probe: no Body

      await backend.deleteState('S', 'us-east-1');

      const deletedKeys = s3Client.send.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((cmd: unknown) => cmd instanceof DeleteObjectCommand)
        .map((cmd: DeleteObjectCommand) => cmd.input.Key);
      expect(deletedKeys).not.toContain('cdkd/S/state.json');
    });

    describe('the unreadable-probe warning', () => {
      // Refusing to sweep on an unreadable probe is right — a read that
      // failed must not authorise a delete — but the OUTCOME is issue #2550's
      // symptom: a record surviving a destroy that reported success. The warn
      // is what stops that being silent, and the not-firing cases are the
      // real fence: `unreadable` is reachable on an ordinary destroy (a
      // principal without s3:ListBucket sees a MISSING object as
      // AccessDenied), so a warn on any other kind would be noise on every
      // destroy of every stack.
      // No local reset: the enclosing suite's beforeEach already runs
      // vi.clearAllMocks(), which clears this hoisted mock.
      // Only the warning under test: `deleteState`'s journal sweep emits its
      // own unrelated warning under these mocks, and asserting over the joined
      // text would let that one satisfy — or falsify — assertions about this
      // one.
      /** Every warning, unfiltered — for asserting that NONE was emitted. */
      const allWarnings = (): string =>
        childLoggerMock.warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

      const warned = (): string[] =>
        childLoggerMock.warn.mock.calls
          .map((c: unknown[]) => String(c[0]))
          .filter((m: string) => m.includes('Could not read the legacy state record'));

      /**
       * The line under test, and proof there IS one. Every case below asserts
       * absences, and an absence holds vacuously against the empty string —
       * so a reworded headline would silence the filter and pass them all
       * green while the defect was live.
       */
      const warnings = (): string => {
        const lines = warned();
        expect(lines).toHaveLength(1);
        return lines[0]!;
      };

      it('warns with the error CLASS when the probe cannot be read', async () => {
        s3Client.send.mockResolvedValueOnce({}); // delete new key
        s3Client.send.mockRejectedValueOnce(
          Object.assign(
            new Error(
              'User: arn:aws:sts::123456789012:assumed-role/deployer/session-42 is not authorized'
            ),
            { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }
          )
        );

        await backend.deleteState('S', 'us-east-1');

        const line = warnings();
        expect(line).toMatch(/Could not read the legacy state record for 'S'/);
        expect(line).toContain('AccessDenied');
        expect(line).toMatch(/left in place/);
      });

      it('keeps AWS\'s own wording out of the warning', async () => {
        // On this warning's headline population S3 words AccessDenied as
        // `User: arn:aws:sts::<account>:assumed-role/<role>/<session> ...`, so
        // printing its message writes the caller's account, role and session
        // into terminal and CI output on every destroy.
        s3Client.send.mockResolvedValueOnce({});
        s3Client.send.mockRejectedValueOnce(
          Object.assign(
            new Error(
              'User: arn:aws:sts::123456789012:assumed-role/deployer/session-42 is not authorized'
            ),
            { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }
          )
        );

        await backend.deleteState('S', 'us-east-1');

        const line = warnings();
        expect(line).not.toContain('123456789012');
        expect(line).not.toContain('assumed-role');
        expect(line).not.toContain('session-42');
      });

      it('suggests no command and prescribes no permission', async () => {
        // Three review rounds of defects came from trying: the S3 key embeds
        // the raw stack name, `displaySafe` keeps `'` so a quoted command can
        // be broken out of, it maps non-ASCII to a space so the name may not
        // be the stack's, and the remedy needs the very permission whose
        // absence produces the commonest instance of this warning.
        s3Client.send.mockResolvedValueOnce({});
        s3Client.send.mockRejectedValueOnce(
          Object.assign(new Error('denied'), { name: 'AccessDenied' })
        );

        await backend.deleteState('S', 'us-east-1');

        const line = warnings();
        expect(line).not.toContain('cdkd state orphan');
        expect(line).not.toContain('s3:ListBucket');
        expect(line).not.toContain('s3://');
        expect(line).not.toContain(`${'cdkd'}/S/state.json`);
      });

      it('carries no attacker-controlled bytes from a hostile body', async () => {
        // `JSON.parse`'s V8 SyntaxError embeds ~30 characters OF THE BODY in
        // its message. A principal able to write the state bucket could put
        // terminal escapes — or a neighbouring plaintext property value — into
        // a default-verbosity warn through it, which is why `reason` carries
        // an error CLASS and never a message.
        s3Client.send.mockResolvedValueOnce({});
        s3Client.send.mockResolvedValueOnce({
          Body: {
            // Measured against V8 on Node 24 rather than assumed: only the
            // `Unexpected token` form embeds a snippet, and it shows the
            // control run plus roughly the last ten characters of the value
            // before it. So the payload puts the escape in a VALUE position
            // right after a secret, which is the shape that leaks both.
            transformToString: () =>
              Promise.resolve('{"p":"s3cr3t","x":\u001b[2K\rok'),
          },
        });

        await backend.deleteState('S', 'us-east-1');

        const line = warnings();
        // No C0 / C1 control byte reaches the terminal.
        expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
        // The tail V8 actually shows — a longer needle would sit outside the
        // window and pass whether or not the value leaked.
        expect(line).not.toContain('cr3t');
        // The class still gets through, so the line is still diagnosable.
        expect(line).toContain('SyntaxError');
      });

      it('leaves a debug line for every unreadable shape, so --verbose is not a lie', async () => {
        const debugFor = (): string =>
          childLoggerMock.debug.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

        // (a) no body
        s3Client.send.mockResolvedValueOnce({});
        s3Client.send.mockResolvedValueOnce({});
        await backend.deleteState('S', 'us-east-1');
        expect(debugFor()).toMatch(/response carried no body/);

        childLoggerMock.debug.mockClear();

        // (b) region field of the wrong type
        s3Client.send.mockResolvedValueOnce({});
        s3Client.send.mockResolvedValueOnce({
          Body: {
            transformToString: () =>
              Promise.resolve(
                JSON.stringify({ version: 1, stackName: 'S', region: 123, resources: {}, outputs: {}, lastModified: 1 })
              ),
          },
        });
        await backend.deleteState('S', 'us-east-1');
        expect(debugFor()).toMatch(/'region' is number, not a string/);

        childLoggerMock.debug.mockClear();

        // (c) the throwing branch
        s3Client.send.mockResolvedValueOnce({});
        s3Client.send.mockRejectedValueOnce(
          Object.assign(new Error('denied'), { name: 'AccessDenied' })
        );
        await backend.deleteState('S', 'us-east-1');
        expect(debugFor()).toMatch(/Could not read legacy state region/);
      });

      it('warns for a body it could not classify, without the AWS advice', async () => {
        // `reason` also carries the two non-throwing unreadable shapes. They
        // are not permission problems, so nothing in the message may read as
        // one.
        s3Client.send.mockResolvedValueOnce({});
        s3Client.send.mockResolvedValueOnce({
          Body: {
            transformToString: () =>
              Promise.resolve(
                JSON.stringify({ version: 1, stackName: 'S', region: 123, resources: {}, outputs: {}, lastModified: 1 })
              ),
          },
        });

        await backend.deleteState('S', 'us-east-1');

        const line = warnings();
        expect(line).toMatch(/'region' field is number, not a string/);
        expect(line).not.toContain('s3:ListBucket');
      });

      it('stays silent when the legacy key is simply absent', async () => {
        s3Client.send.mockResolvedValueOnce({});
        s3Client.send.mockRejectedValueOnce(
          Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
        );

        await backend.deleteState('S', 'us-east-1');

        expect(allWarnings()).not.toMatch(/legacy state record/i);
      });

      it('stays silent when the legacy body names a region', async () => {
        s3Client.send.mockResolvedValueOnce({});
        s3Client.send.mockResolvedValueOnce({ Body: bodyOf(v1State('S', 'us-east-1')) });
        s3Client.send.mockResolvedValueOnce({}); // legacy delete

        await backend.deleteState('S', 'us-east-1');

        expect(allWarnings()).not.toMatch(/legacy state record/i);
      });

      it('stays silent when the legacy body names no region', async () => {
        s3Client.send.mockResolvedValueOnce({});
        s3Client.send.mockResolvedValueOnce({ Body: bodyOf(v1State('S')) });
        s3Client.send.mockResolvedValueOnce({}); // legacy delete

        await backend.deleteState('S', 'us-east-1');

        expect(allWarnings()).not.toMatch(/legacy state record/i);
      });
    });

    it('issues no legacy delete when the legacy key is absent', async () => {
      // The other reason the one-line fix was wrong: an absent key read as
      // the same `undefined`, so accepting it would have sent a pointless
      // DeleteObject on every ordinary destroy.
      s3Client.send.mockResolvedValueOnce({}); // delete new key
      s3Client.send.mockRejectedValueOnce(
        Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
      );

      await backend.deleteState('S', 'us-east-1');

      const deletedKeys = s3Client.send.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((cmd: unknown) => cmd instanceof DeleteObjectCommand)
        .map((cmd: DeleteObjectCommand) => cmd.input.Key);
      expect(deletedKeys).not.toContain('cdkd/S/state.json');
    });
  });

  describe('deleteLegacyState (issue #2537)', () => {
    // The CLI-level cases in `tests/unit/cli/state-orphan.test.ts` assert this
    // method is CALLED; only here can the key it builds be seen. A wrong key
    // would satisfy every assertion over there.
    it('deletes the region-less legacy key and nothing else', async () => {
      s3Client.send.mockResolvedValueOnce({});

      await backend.deleteLegacyState('S');

      const cmds = s3Client.send.mock.calls.map((c: unknown[]) => c[0]);
      expect(cmds).toHaveLength(1);
      expect(cmds[0]).toBeInstanceOf(DeleteObjectCommand);
      const input = (cmds[0] as DeleteObjectCommand).input;
      expect(input.Key).toBe('cdkd/S/state.json');
      // The squatting hardening every other write on this backend carries —
      // a new delete path is exactly where it goes missing unnoticed.
      expect(input.ExpectedBucketOwner).toBe('999999999999');
    });

    it('reads no body first — the delete is unconditional', async () => {
      // `deleteState` GetObjects the legacy key to compare its region before
      // sweeping it. This method must not: its caller has already resolved a
      // region-less ref, and a body read here would reintroduce the very gate
      // that made the region-less record undeletable.
      s3Client.send.mockResolvedValueOnce({});

      await backend.deleteLegacyState('S');

      const cmds = s3Client.send.mock.calls.map((c: unknown[]) => c[0]);
      expect(cmds.some((c: unknown) => c instanceof GetObjectCommand)).toBe(false);
    });

    it('sweeps no rollback journal', async () => {
      // Journal keys exist only in the region-scoped layout, so there is no
      // journal a region-less record could own. Pinning it keeps a later
      // copy-paste from `deleteState` from adding a delete for a key whose
      // region cannot be known here.
      s3Client.send.mockResolvedValueOnce({});

      await backend.deleteLegacyState('S');

      const deletedKeys = s3Client.send.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((cmd: unknown) => cmd instanceof DeleteObjectCommand)
        .map((cmd: DeleteObjectCommand) => cmd.input.Key);
      expect(deletedKeys).toEqual(['cdkd/S/state.json']);
    });

    it('wraps a failed delete in a StateError naming the stack', async () => {
      // The caller prints its success line only after this resolves, so the
      // throw is what stops a removal being reported that did not happen.
      s3Client.send.mockRejectedValueOnce(new Error('AccessDenied'));

      const caught = await backend.deleteLegacyState('S').catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(StateError);
      expect((caught as Error).message).toMatch(/Failed to delete legacy state for stack 'S'/);
    });
  });

  describe('listRawObjects (issue #2052)', () => {
    const D1 = new Date('2026-01-01T00:00:00.000Z');
    const D2 = new Date('2026-02-01T00:00:00.000Z');

    it('KEEPS an object whose Size is 0 — the empty placeholder is the common case', async () => {
      // The whole point of the sweep. `CustomResourceProvider` PUTs an EMPTY
      // object, so the natural-looking `if (!obj.Size) continue;` would discard
      // every one of the objects this feature exists to collect, while the
      // gc-side suites (which mock the backend wholesale) stayed green — a
      // review probe measured exactly that: 367/367 passing with the feature's
      // primary target silently dropped.
      s3Client.send.mockResolvedValueOnce({
        Contents: [{ Key: 'custom-resource-responses/a.json', LastModified: D1, Size: 0 }],
        IsTruncated: false,
      });

      await expect(backend.listRawObjects('custom-resource-responses/')).resolves.toEqual([
        { key: 'custom-resource-responses/a.json', lastModified: D1, size: 0 },
      ]);
    });

    it('DROPS an entry missing LastModified or Size rather than defaulting it', async () => {
      // Defaulting the date would either exempt an object from the age guard
      // forever or expose it immediately, and the caller cannot see which.
      s3Client.send.mockResolvedValueOnce({
        Contents: [
          { Key: 'custom-resource-responses/ok.json', LastModified: D1, Size: 5 },
          { Key: 'custom-resource-responses/no-date.json', Size: 5 },
          { Key: 'custom-resource-responses/no-size.json', LastModified: D1 },
          { LastModified: D1, Size: 5 },
        ],
        IsTruncated: false,
      });

      const objects = await backend.listRawObjects('custom-resource-responses/');

      expect(objects.map((o) => o.key)).toEqual(['custom-resource-responses/ok.json']);
    });

    it('LOGS each dropped entry, naming the field that was missing', async () => {
      // The drop decision is right, but under-collection is the invisible half
      // of a sweeper's failure: the caller receives a shorter array and cannot
      // tell a dropped entry from one S3 never returned. The debug line is the
      // only observable, so it is pinned rather than left to the comment that
      // describes it.
      s3Client.send.mockResolvedValueOnce({
        Contents: [
          { Key: 'custom-resource-responses/ok.json', LastModified: D1, Size: 5 },
          { Key: 'custom-resource-responses/no-date.json', Size: 5 },
          { Key: 'custom-resource-responses/no-size.json', LastModified: D1 },
        ],
        IsTruncated: false,
      });

      await backend.listRawObjects('custom-resource-responses/');

      const debugText = childLoggerMock.debug.mock.calls.map((c) => String(c[0])).join('\n');
      expect(debugText).toContain(
        "dropping an entry under 'custom-resource-responses/' " +
          '(key: custom-resource-responses/no-date.json) — ListObjectsV2 returned no LastModified'
      );
      expect(debugText).toContain(
        "dropping an entry under 'custom-resource-responses/' " +
          '(key: custom-resource-responses/no-size.json) — ListObjectsV2 returned no Size'
      );
      // ...and the KEPT entry is not reported as a drop, so the assertion above
      // cannot be satisfied by a line logged for every object.
      expect(debugText).not.toContain('custom-resource-responses/ok.json');
    });

    it('collects across multiple ListObjectsV2 pages via ContinuationToken', async () => {
      s3Client.send.mockResolvedValueOnce({
        Contents: [{ Key: 'custom-resource-responses/p1.json', LastModified: D1, Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: 'token-page-2',
      });
      s3Client.send.mockResolvedValueOnce({
        Contents: [{ Key: 'custom-resource-responses/p2.json', LastModified: D2, Size: 2 }],
        IsTruncated: false,
      });

      const objects = await backend.listRawObjects('custom-resource-responses/');

      expect(objects).toEqual([
        { key: 'custom-resource-responses/p1.json', lastModified: D1, size: 1 },
        { key: 'custom-resource-responses/p2.json', lastModified: D2, size: 2 },
      ]);
      const listCalls = s3Client.send.mock.calls.filter(
        (c: unknown[]) => c[0] instanceof ListObjectsV2Command
      );
      expect(listCalls).toHaveLength(2);
      expect((listCalls[0][0] as ListObjectsV2Command).input.ContinuationToken).toBeUndefined();
      expect((listCalls[1][0] as ListObjectsV2Command).input.ContinuationToken).toBe(
        'token-page-2'
      );
      // The owner pin is what makes a foreign state bucket 403 rather than be
      // listed; the asset-bucket arms carry it and this one must too.
      expect((listCalls[0][0] as ListObjectsV2Command).input.ExpectedBucketOwner).toBeDefined();
      // The one parameter that SCOPES the listing, and the one this case used
      // to leave unpinned: deleting `Prefix: keyPrefix` passed the whole suite.
      // Unscoped, the sweep lists the entire state bucket and the leaf-shape
      // regex becomes the only thing standing between it and live state — the
      // same class as the `--state-prefix` collision. Asserted on EVERY page,
      // since a continuation call that dropped it would widen the second page
      // alone.
      for (const call of listCalls) {
        expect((call[0] as ListObjectsV2Command).input.Prefix).toBe('custom-resource-responses/');
      }
    });

    it('returns an empty list when no objects match the prefix', async () => {
      s3Client.send.mockResolvedValueOnce({ IsTruncated: false });
      await expect(backend.listRawObjects('custom-resource-responses/')).resolves.toEqual([]);
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
