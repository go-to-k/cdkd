/**
 * Tests for `buildCrossStackResolver` in `src/cli/commands/local-state-loader.ts`.
 *
 * The resolver is the persistent / fallback lookup engine consumed by the
 * async `substituteAgainstStateAsync` path when env vars / ECS Secrets carry
 * `Fn::ImportValue` / `Fn::GetStackOutput` intrinsics. It owns its own
 * `AwsClients` instance for the duration of a `cdkd local invoke` /
 * `cdkd local run-task` call and exposes a `dispose()` so the caller can
 * shut the underlying S3 client down explicitly.
 *
 * Coverage axes (closes the HIGH-severity gap surfaced by the PR #487
 * test-adequacy review):
 *   - state-bucket resolution failure → warn-and-fallback (returns undefined)
 *   - verifyBucketExists() failure → dispose AWS clients + warn-and-fallback
 *   - `resolveImport`: index hit (string / number / boolean / object→JSON),
 *     index miss + per-stack scan, listStacks failure, getState failure
 *     mid-fallback, same-region filter, stack-not-found
 *   - `resolveGetStackOutput`: missing state, missing output key,
 *     string / number / boolean / object→JSON value, getState throws
 *   - `dispose()` calls `awsClients.destroy()` exactly once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Hoisted mocks per `feedback_vi_mock_hoisting.md`: vi.mock factories
// cannot reference top-level class declarations, so collect every fake
// function in a hoisted bag and shape the modules around them.
const mocks = vi.hoisted(() => ({
  resolveStateBucketWithDefaultMock: vi.fn(),
  verifyBucketExistsMock: vi.fn(),
  listStacksMock: vi.fn(),
  getStateMock: vi.fn(),
  lookupMock: vi.fn(),
  destroyMock: vi.fn(),
  /**
   * Records every `new ExportIndexStore(...)` argument list (issue #1836 round
   * 3). Nothing asserted these before, so the index KEY spelling — the fourth
   * constructor argument, which becomes
   * `cdkd/_index/{region}/exports.json` — was entirely unfenced while two
   * commands were passing different spellings for the same stack.
   */
  exportIndexCtorMock: vi.fn(),
  /**
   * Records every `new AwsClients(...)` config. This is where `--region` decides
   * an ENDPOINT; the `S3StateBackend` bag next to it carries only `profile` /
   * `credentials`, so asserting that one alone left the fold unfenced.
   */
  awsClientsCtorMock: vi.fn(),
  // Records every `new S3StateBackend(...)` argument list, so the client options
  // `--region` lands in are observable (issue #1836).
  backendCtorMock: vi.fn(),
  // Allow the AwsClients mock to share a single destroy spy with the
  // assertion side. Each `new AwsClients(...)` returns an object whose
  // `destroy` is `destroyMock`.
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: mocks.resolveStateBucketWithDefaultMock,
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation((...args: unknown[]) => {
    mocks.backendCtorMock(...args);
    return {
      verifyBucketExists: mocks.verifyBucketExistsMock,
      listStacks: mocks.listStacksMock,
      getState: mocks.getStateMock,
    };
  }),
}));

vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation((...args: unknown[]) => {
    mocks.exportIndexCtorMock(...args);
    return { lookup: mocks.lookupMock };
  }),
}));

// The resolver builds a fresh AwsClients instance per call and disposes
// of it via the returned `dispose()`. We intercept it so the test can
// assert `destroy()` was called and so the real SDK is never constructed.
vi.mock('../../../src/utils/aws-clients.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../src/utils/aws-clients.js'
  );
  return {
    ...actual,
    AwsClients: vi.fn().mockImplementation((config: unknown) => {
      mocks.awsClientsCtorMock(config);
      return { s3: {}, destroy: mocks.destroyMock };
    }),
  };
});

import { buildCrossStackResolver } from '../../../src/cli/commands/local-state-loader.js';

/** The config the S3 client was actually built with (issue #1836 round 3). */
const awsClientsConfig = (): Record<string, unknown> =>
  (mocks.awsClientsCtorMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;

describe('buildCrossStackResolver', () => {
  beforeEach(() => {
    mocks.resolveStateBucketWithDefaultMock.mockReset();
    mocks.verifyBucketExistsMock.mockReset();
    mocks.listStacksMock.mockReset();
    mocks.getStateMock.mockReset();
    mocks.lookupMock.mockReset();
    mocks.destroyMock.mockReset();
    mocks.backendCtorMock.mockReset();
    mocks.exportIndexCtorMock.mockReset();
    mocks.awsClientsCtorMock.mockReset();
  });

  afterEach(() => {
    mocks.resolveStateBucketWithDefaultMock.mockReset();
    mocks.verifyBucketExistsMock.mockReset();
    mocks.listStacksMock.mockReset();
    mocks.getStateMock.mockReset();
    mocks.lookupMock.mockReset();
    mocks.destroyMock.mockReset();
    mocks.backendCtorMock.mockReset();
    mocks.exportIndexCtorMock.mockReset();
    mocks.awsClientsCtorMock.mockReset();
  });

  describe('bucket resolution', () => {
    it('returns undefined and never constructs AwsClients when bucket resolution fails', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockRejectedValue(
        new Error('GetBucketLocation failed')
      );

      const built = await buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' });

      expect(built).toBeUndefined();
      // verifyBucketExists is reached only AFTER AwsClients is built; if
      // we got here, the early-return path was correctly taken.
      expect(mocks.verifyBucketExistsMock).not.toHaveBeenCalled();
      // No destroy() because no AwsClients was constructed on the
      // pre-bucket-resolution early-return path.
      expect(mocks.destroyMock).not.toHaveBeenCalled();
    });

    it('returns undefined AND destroys awsClients when verifyBucketExists fails', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockRejectedValue(new Error('Access Denied'));

      const built = await buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' });

      expect(built).toBeUndefined();
      // verifyBucketExists threw — the resolver must dispose the AwsClients
      // it constructed before returning undefined to avoid leaking the
      // S3 client across the CLI's lifetime.
      expect(mocks.destroyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveImport — exports index fast path', () => {
    async function makeResolver(): Promise<{
      resolver: NonNullable<Awaited<ReturnType<typeof buildCrossStackResolver>>>['resolver'];
      dispose: () => void;
    }> {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' });
      if (!built) throw new Error('expected resolver build to succeed');
      return built;
    }

    it('returns a string value verbatim on index hit', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.lookupMock.mockResolvedValue({
        value: 'my-bucket-name',
        producerStack: 'ProducerStack',
        producerRegion: 'us-east-1',
      });

      const got = await resolver.resolveImport('SomeExport');

      expect(got).toBe('my-bucket-name');
      expect(mocks.lookupMock).toHaveBeenCalledWith('SomeExport');
      // No fallback fired — listStacks should NEVER be called when the
      // index returns a hit.
      expect(mocks.listStacksMock).not.toHaveBeenCalled();
      dispose();
    });

    it('stringifies a numeric index hit', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.lookupMock.mockResolvedValue({
        value: 42,
        producerStack: 'P',
        producerRegion: 'us-east-1',
      });
      const got = await resolver.resolveImport('Port');
      expect(got).toBe('42');
      dispose();
    });

    it('stringifies a boolean index hit', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.lookupMock.mockResolvedValue({
        value: true,
        producerStack: 'P',
        producerRegion: 'us-east-1',
      });
      const got = await resolver.resolveImport('Flag');
      expect(got).toBe('true');
      dispose();
    });

    it('JSON-stringifies an object-valued index hit', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.lookupMock.mockResolvedValue({
        value: { Inner: 'value', N: 1 },
        producerStack: 'P',
        producerRegion: 'us-east-1',
      });
      const got = await resolver.resolveImport('Nested');
      expect(got).toBe(JSON.stringify({ Inner: 'value', N: 1 }));
      dispose();
    });
  });

  describe('resolveImport — index miss + per-stack fallback', () => {
    async function makeResolver(): Promise<{
      resolver: NonNullable<Awaited<ReturnType<typeof buildCrossStackResolver>>>['resolver'];
      dispose: () => void;
    }> {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      // Default the index to return undefined so we always exercise the
      // fallback. Individual tests can still override `lookupMock` to
      // throw before the fallback runs.
      mocks.lookupMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' });
      if (!built) throw new Error('expected resolver build to succeed');
      return built;
    }

    it('falls back to per-stack scan on index miss and returns the matching Output', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.listStacksMock.mockResolvedValue([
        { stackName: 'ProducerStack', region: 'us-east-1' },
      ]);
      mocks.getStateMock.mockResolvedValue({
        state: {
          stackName: 'ProducerStack',
          resources: {},
          outputs: { 'ProducerStack-BucketName': 'fallback-bucket' },
        },
        etag: 'e',
      });

      const got = await resolver.resolveImport('ProducerStack-BucketName');

      expect(got).toBe('fallback-bucket');
      expect(mocks.listStacksMock).toHaveBeenCalledTimes(1);
      dispose();
    });

    it('the fallback scan skips a same-named PLAIN output in an earlier stack and binds to the real exporter (#2193)', async () => {
      // The shadowing shape, on the local path: the decoy is listed FIRST and
      // holds a plain output NAMED like the export (`exportNames: []` says it
      // exports nothing); the producer's set names the alias. A scan over
      // every key returned the decoy's value before reaching the producer.
      const { resolver, dispose } = await makeResolver();
      mocks.listStacksMock.mockResolvedValue([
        { stackName: 'Decoy', region: 'us-east-1' },
        { stackName: 'Producer', region: 'us-east-1' },
      ]);
      mocks.getStateMock.mockImplementation(async (stackName: string) => ({
        state:
          stackName === 'Decoy'
            ? { stackName, resources: {}, outputs: { Shared: 'decoy-value' }, exportNames: [] }
            : {
                stackName,
                resources: {},
                outputs: { ProducerArn: 'producer-value', Shared: 'producer-value' },
                exportNames: ['Shared'],
              },
        etag: 'e',
      }));

      expect(await resolver.resolveImport('Shared')).toBe('producer-value');
      // A plain output name is not importable even though a stack holds it.
      expect(await resolver.resolveImport('ProducerArn')).toBeUndefined();
      dispose();
    });

    it('the fallback scan still serves every key of a pre-v9 record (legacy rule until it redeploys)', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.listStacksMock.mockResolvedValue([{ stackName: 'Legacy', region: 'us-east-1' }]);
      mocks.getStateMock.mockResolvedValue({
        // No `exportNames` on record: nothing says which key is the export.
        state: { stackName: 'Legacy', resources: {}, outputs: { Shared: 'legacy-value' } },
        etag: 'e',
      });

      expect(await resolver.resolveImport('Shared')).toBe('legacy-value');
      dispose();
    });

    it('falls back via per-stack scan on index lookup THROW (treated as miss)', async () => {
      const { resolver, dispose } = await makeResolver();
      // Override the default mock: simulate a corrupt-index throw, which
      // the resolver should catch and downgrade to the per-stack fallback.
      mocks.lookupMock.mockRejectedValueOnce(new Error('index corrupted'));
      mocks.listStacksMock.mockResolvedValue([
        { stackName: 'ProducerStack', region: 'us-east-1' },
      ]);
      mocks.getStateMock.mockResolvedValue({
        state: {
          stackName: 'ProducerStack',
          resources: {},
          outputs: { Recovered: 'after-throw' },
        },
        etag: 'e',
      });

      const got = await resolver.resolveImport('Recovered');

      expect(got).toBe('after-throw');
      // Both index lookup AND fallback list-stacks ran.
      expect(mocks.lookupMock).toHaveBeenCalledTimes(1);
      expect(mocks.listStacksMock).toHaveBeenCalledTimes(1);
      dispose();
    });

    it('returns undefined when listStacks() throws during the fallback', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.listStacksMock.mockRejectedValue(new Error('S3 ListObjectsV2 denied'));

      const got = await resolver.resolveImport('Missing');

      expect(got).toBeUndefined();
      // getState is never reached when listStacks itself fails.
      expect(mocks.getStateMock).not.toHaveBeenCalled();
      dispose();
    });

    it('skips a stack whose getState() throws and continues scanning siblings', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.listStacksMock.mockResolvedValue([
        { stackName: 'Broken', region: 'us-east-1' },
        { stackName: 'Good', region: 'us-east-1' },
      ]);
      // First stack getState throws; second stack returns the Output.
      mocks.getStateMock
        .mockRejectedValueOnce(new Error('corrupt state.json'))
        .mockResolvedValueOnce({
          state: { stackName: 'Good', resources: {}, outputs: { Target: 'good-value' } },
          etag: 'e',
        });

      const got = await resolver.resolveImport('Target');

      expect(got).toBe('good-value');
      expect(mocks.getStateMock).toHaveBeenCalledTimes(2);
      dispose();
    });

    it('skips stacks in non-consumer regions (same-region scope filter)', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.listStacksMock.mockResolvedValue([
        // Different region → must NOT be queried for outputs (the per-stack
        // scan is bounded to the consumer region in v1).
        { stackName: 'ProducerStack', region: 'us-west-2' },
        { stackName: 'LocalProducer', region: 'us-east-1' },
      ]);
      mocks.getStateMock.mockResolvedValue({
        state: {
          stackName: 'LocalProducer',
          resources: {},
          outputs: { LocalExport: 'local-only' },
        },
        etag: 'e',
      });

      const got = await resolver.resolveImport('LocalExport');

      expect(got).toBe('local-only');
      // Only the same-region stack should have been queried for state —
      // the cross-region one is filtered out before getState fires.
      expect(mocks.getStateMock).toHaveBeenCalledTimes(1);
      expect(mocks.getStateMock).toHaveBeenCalledWith('LocalProducer', 'us-east-1');
      dispose();
    });

    it('returns undefined when scan completes without finding the export', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.listStacksMock.mockResolvedValue([
        { stackName: 'P', region: 'us-east-1' },
      ]);
      mocks.getStateMock.mockResolvedValue({
        state: { stackName: 'P', resources: {}, outputs: { Other: 'irrelevant' } },
        etag: 'e',
      });

      const got = await resolver.resolveImport('NotPresent');

      expect(got).toBeUndefined();
      dispose();
    });

    it('returns undefined when a stack has no outputs at all', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.listStacksMock.mockResolvedValue([
        { stackName: 'NoOutputs', region: 'us-east-1' },
      ]);
      // Returning a state object with no outputs map should be treated as
      // "no match here, continue scanning"; with only one stack it
      // collapses to undefined.
      mocks.getStateMock.mockResolvedValue({
        state: { stackName: 'NoOutputs', resources: {}, outputs: undefined },
        etag: 'e',
      });

      const got = await resolver.resolveImport('AnyExport');

      expect(got).toBeUndefined();
      dispose();
    });

    it('stringifies number/boolean/object output values found via fallback', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.listStacksMock.mockResolvedValue([
        { stackName: 'P', region: 'us-east-1' },
      ]);
      mocks.getStateMock.mockResolvedValue({
        state: {
          stackName: 'P',
          resources: {},
          outputs: {
            Numeric: 7,
            Bool: false,
            Obj: { a: 1 },
          },
        },
        etag: 'e',
      });

      expect(await resolver.resolveImport('Numeric')).toBe('7');
      // Reset the mock between calls so the next getState returns the same shape.
      mocks.getStateMock.mockResolvedValue({
        state: {
          stackName: 'P',
          resources: {},
          outputs: { Numeric: 7, Bool: false, Obj: { a: 1 } },
        },
        etag: 'e',
      });
      expect(await resolver.resolveImport('Bool')).toBe('false');
      mocks.getStateMock.mockResolvedValue({
        state: {
          stackName: 'P',
          resources: {},
          outputs: { Numeric: 7, Bool: false, Obj: { a: 1 } },
        },
        etag: 'e',
      });
      expect(await resolver.resolveImport('Obj')).toBe(JSON.stringify({ a: 1 }));
      dispose();
    });
  });

  describe('resolveGetStackOutput', () => {
    async function makeResolver(): Promise<{
      resolver: NonNullable<Awaited<ReturnType<typeof buildCrossStackResolver>>>['resolver'];
      dispose: () => void;
    }> {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      // Issue #1836 round 4: a miss on the exact producer key now falls through to
      // a `listStacks()`-driven case recovery, so the rows below that model an
      // absent record need the scan to return something rather than an
      // un-primed `undefined` (which would iterate and throw into the catch,
      // making every one of those absence assertions pass for the wrong reason).
      mocks.listStacksMock.mockResolvedValue([]);
      const built = await buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' });
      if (!built) throw new Error('expected resolver build to succeed');
      return built;
    }

    it('returns a string Output value verbatim', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.getStateMock.mockResolvedValue({
        state: {
          stackName: 'Producer',
          resources: {},
          outputs: { OutputName: 'literal-value' },
        },
        etag: 'e',
      });

      const got = await resolver.resolveGetStackOutput('Producer', 'us-east-1', 'OutputName');

      expect(got).toBe('literal-value');
      expect(mocks.getStateMock).toHaveBeenCalledWith('Producer', 'us-east-1');
      dispose();
    });

    it('stringifies numeric / boolean Output values', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.getStateMock.mockResolvedValue({
        state: { stackName: 'P', resources: {}, outputs: { N: 99 } },
        etag: 'e',
      });
      expect(await resolver.resolveGetStackOutput('P', 'us-east-1', 'N')).toBe('99');

      mocks.getStateMock.mockResolvedValue({
        state: { stackName: 'P', resources: {}, outputs: { B: true } },
        etag: 'e',
      });
      expect(await resolver.resolveGetStackOutput('P', 'us-east-1', 'B')).toBe('true');
      dispose();
    });

    it('JSON-stringifies an object-valued Output', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.getStateMock.mockResolvedValue({
        state: { stackName: 'P', resources: {}, outputs: { Nested: { a: 1, b: 'x' } } },
        etag: 'e',
      });
      expect(await resolver.resolveGetStackOutput('P', 'us-east-1', 'Nested')).toBe(
        JSON.stringify({ a: 1, b: 'x' })
      );
      dispose();
    });

    it('returns undefined when the producer stack has no state', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.getStateMock.mockResolvedValue(null);
      expect(await resolver.resolveGetStackOutput('NoState', 'us-east-1', 'Out')).toBeUndefined();
      dispose();
    });

    it('returns undefined when the producer state lacks the requested output', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.getStateMock.mockResolvedValue({
        state: { stackName: 'P', resources: {}, outputs: { Other: 'x' } },
        etag: 'e',
      });
      expect(await resolver.resolveGetStackOutput('P', 'us-east-1', 'Missing')).toBeUndefined();
      dispose();
    });

    it('returns undefined when the producer state has no outputs map at all', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.getStateMock.mockResolvedValue({
        state: { stackName: 'P', resources: {}, outputs: undefined },
        etag: 'e',
      });
      expect(await resolver.resolveGetStackOutput('P', 'us-east-1', 'AnyOut')).toBeUndefined();
      dispose();
    });

    it('returns undefined when getState() throws (read error degrades to miss)', async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.getStateMock.mockRejectedValue(new Error('S3 unavailable'));
      expect(
        await resolver.resolveGetStackOutput('Producer', 'us-east-1', 'Out')
      ).toBeUndefined();
      dispose();
    });

    it('cross-region: explicit Region argument is forwarded to getState verbatim', async () => {
      // Closes the asymmetry called out by the test reviewer (Gap 2):
      // `Fn::GetStackOutput` with explicit `Region: <other>` MUST query
      // the producer stack in that other region (same-account
      // cross-region works out of the box because the state bucket name
      // is account-scoped, not region-scoped).
      const { resolver, dispose } = await makeResolver();
      mocks.getStateMock.mockResolvedValue({
        state: {
          stackName: 'WestProducer',
          resources: {},
          outputs: { WestOut: 'west-value' },
        },
        etag: 'e',
      });

      const got = await resolver.resolveGetStackOutput(
        'WestProducer',
        'us-west-2',
        'WestOut'
      );

      expect(got).toBe('west-value');
      // Must have been queried in us-west-2 (NOT the resolver's
      // consumerRegion of us-east-1).
      expect(mocks.getStateMock).toHaveBeenCalledWith('WestProducer', 'us-west-2');
      dispose();
    });
  });

  /**
   * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) review fix 6: the
   * index-miss fallback's same-region filter was a raw `!==`, and
   * `consumerRegion` is the state RECORD's own spelling (`local-invoke.ts` passes
   * `loaded.region`). `loadStateForStack`'s exact-then-folded match makes an
   * upper-cased record reachable, so an upper-cased consumer record made the
   * filter skip EVERY ref — the fallback resolved nothing and each affected env
   * var was dropped with only a per-key warning (a silent-by-design path).
   *
   * The `getState` key still uses the REF's own spelling, for the same reason
   * `loadStateForStack` keeps the record's: a folded key would 404.
   */
  describe('resolveImport — same-region filter region case (issue #1836)', () => {
    async function makeResolver(consumerRegion: string): Promise<{
      resolver: NonNullable<Awaited<ReturnType<typeof buildCrossStackResolver>>>['resolver'];
      dispose: () => void;
    }> {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      mocks.lookupMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver(consumerRegion, { statePrefix: 'cdkd' });
      if (!built) throw new Error('expected resolver build to succeed');
      return built;
    }

    const primeProducer = (region: string): void => {
      mocks.listStacksMock.mockResolvedValue([{ stackName: 'ProducerStack', region }]);
      mocks.getStateMock.mockResolvedValue({
        state: {
          stackName: 'ProducerStack',
          resources: {},
          outputs: { SharedExport: 'producer-value' },
        },
        etag: 'e',
      });
    };

    it('matches a canonical producer ref against an UPPER-CASED consumer region', async () => {
      const { resolver, dispose } = await makeResolver('US-EAST-1');
      primeProducer('us-east-1');

      // The regression: a raw `!==` skipped this ref and returned undefined, so
      // the env var was dropped although the producer's state was right there.
      expect(await resolver.resolveImport('SharedExport')).toBe('producer-value');
      expect(mocks.getStateMock).toHaveBeenCalledWith('ProducerStack', 'us-east-1');
      dispose();
    });

    it('matches an UPPER-CASED producer ref against a canonical consumer region', async () => {
      const { resolver, dispose } = await makeResolver('us-east-1');
      primeProducer('US-EAST-1');

      expect(await resolver.resolveImport('SharedExport')).toBe('producer-value');
      // Keyed by the REF's own spelling — a folded key names no S3 object.
      expect(mocks.getStateMock).toHaveBeenCalledWith('ProducerStack', 'US-EAST-1');
      expect(mocks.getStateMock).not.toHaveBeenCalledWith('ProducerStack', 'us-east-1');
      dispose();
    });

    it('leaves the already-canonical pairing byte-identical', async () => {
      const { resolver, dispose } = await makeResolver('us-east-1');
      primeProducer('us-east-1');

      expect(await resolver.resolveImport('SharedExport')).toBe('producer-value');
      expect(mocks.getStateMock).toHaveBeenCalledWith('ProducerStack', 'us-east-1');
      dispose();
    });

    it('still skips a genuinely different region (the fold is not a wildcard)', async () => {
      const { resolver, dispose } = await makeResolver('US-EAST-1');
      primeProducer('eu-west-1');

      expect(await resolver.resolveImport('SharedExport')).toBeUndefined();
      // The v1 same-region scope must survive the fold: no cross-region read.
      expect(mocks.getStateMock).not.toHaveBeenCalled();
      dispose();
    });

    it('builds the state backend with the FOLDED --region', async () => {
      // The client region is `opts.region`, not `consumerRegion` — folded here
      // for the same reason the two loaders fold theirs (issue #1836 fix 2).
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver('cn-north-1', {
        statePrefix: 'cdkd',
        region: 'CN-NORTH-1',
      });
      if (!built) throw new Error('expected resolver build to succeed');

      const ctorOpts = (mocks.backendCtorMock.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;
      expect(ctorOpts['region']).toBe('cn-north-1');
      expect(ctorOpts['region']).not.toBe('CN-NORTH-1');
      built.dispose();
    });

    it('omits the client region entirely when --region is absent', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' });
      if (!built) throw new Error('expected resolver build to succeed');

      const ctorOpts = (mocks.backendCtorMock.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;
      expect('region' in ctorOpts).toBe(false);
      expect('region' in awsClientsConfig()).toBe(false);
      built.dispose();
    });

    /**
     * Issue #1836 round 3, fix 3: the assertions above read the
     * `S3StateBackend` constructor's third argument — a bag that backend uses
     * only for `profile` / `credentials`. The client whose endpoint `--region`
     * actually resolves is `new AwsClients({ region })`, and NO test observed
     * its arguments, so reverting that one line left the whole suite green.
     */
    it('builds the S3 CLIENT with the FOLDED --region', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver('cn-north-1', {
        statePrefix: 'cdkd',
        region: 'CN-NORTH-1',
      });
      if (!built) throw new Error('expected resolver build to succeed');

      expect(awsClientsConfig()['region']).toBe('cn-north-1');
      expect(awsClientsConfig()['region']).not.toBe('CN-NORTH-1');
      built.dispose();
    });

    it('leaves an already-canonical --region byte-identical on the S3 client', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver('cn-north-1', {
        statePrefix: 'cdkd',
        region: 'cn-north-1',
      });
      if (!built) throw new Error('expected resolver build to succeed');

      expect(awsClientsConfig()['region']).toBe('cn-north-1');
      built.dispose();
    });

    it('treats a BLANK --region as absent on the S3 client', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver('us-east-1', {
        statePrefix: 'cdkd',
        region: '',
      });
      if (!built) throw new Error('expected resolver build to succeed');

      expect('region' in awsClientsConfig()).toBe(false);
      built.dispose();
    });
  });

  /**
   * Issue #1836 round 3, fix 2: the exports-index KEY.
   *
   * `consumerRegion` becomes `ExportIndexStore`'s `region`, hence the S3 key
   * `cdkd/_index/{region}/exports.json` AND the raw `ref.region === this.region`
   * filter its index-miss REBUILD uses. A `region` no state record spells makes
   * that rebuild yield zero refs and PUT an EMPTY index — after which every
   * `Fn::ImportValue` degrades to the O(N) scan permanently. Nothing asserted
   * the constructor's arguments at all before this suite, which is how
   * `local-run-task.ts` came to pass a FOLDED chain value while `local-invoke.ts`
   * passed the record's own spelling.
   */
  describe('exports-index key spelling (issue #1836)', () => {
    const indexRegionArg = (): unknown => mocks.exportIndexCtorMock.mock.calls[0]?.[3];

    const build = async (consumerRegion: string): Promise<{ dispose: () => void }> => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver(consumerRegion, { statePrefix: 'cdkd' });
      if (!built) throw new Error('expected resolver build to succeed');
      return built;
    };

    it('keys the index with the consumer region VERBATIM, not a folded copy', async () => {
      // The caller's contract is "pass the state record's own spelling". Folding
      // here would name an object no deploy ever wrote.
      const built = await build('US-EAST-1');

      expect(indexRegionArg()).toBe('US-EAST-1');
      expect(indexRegionArg()).not.toBe('us-east-1');
      built.dispose();
    });

    it('passes a canonical consumer region through byte-identically', async () => {
      const built = await build('cn-north-1');

      expect(indexRegionArg()).toBe('cn-north-1');
      built.dispose();
    });

    it('keys it with the CONSUMER region, never with the client --region', async () => {
      // The two are different values: `--region` builds the client, the consumer
      // region names the index. Crossing them would key the index off a flag.
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver('eu-west-1', {
        statePrefix: 'cdkd',
        region: 'us-east-1',
      });
      if (!built) throw new Error('expected resolver build to succeed');

      expect(indexRegionArg()).toBe('eu-west-1');
      built.dispose();
    });
  });

  /**
   * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) round 4, fix 1:
   * the state-bucket NAME resolution is the ONE consumer of `consumerRegion` that
   * needs the FOLDED spelling, and round 3 handed it the raw one.
   *
   * Verified failing input: a record at `cdkd/MyStack/US-EAST-1/state.json`,
   * `--stack-region US-EAST-1`, and no `--state-bucket` /
   * `CDKD_STATE_BUCKET` / cdk.json bucket. `getLegacyStateBucketName` then names
   * `cdkd-state-<acct>-US-EAST-1`; an upper-cased bucket is not virtual-hostable,
   * so the request goes path-style, S3 answers 400 `InvalidBucketName`,
   * `probeBucket` rethrows, and this resolver warns and returns `undefined` — so
   * EVERY `Fn::ImportValue` / `Fn::GetStackOutput` env entry is warn-and-dropped
   * while `loadStateForStack` read that same record fine. Legacy-bucket accounts
   * fail unconditionally.
   *
   * Both sibling loaders (`loadStateForStack`, `loadBootstrapContainerRepo`) fold
   * before their own `resolveStateBucketWithDefault` call, so this is what makes
   * all three agree.
   */
  describe('state-bucket resolution region (issue #1836 round 4)', () => {
    /** The SECOND argument of `resolveStateBucketWithDefault` — the bucket-naming region. */
    const bucketRegionArg = (): unknown =>
      mocks.resolveStateBucketWithDefaultMock.mock.calls[0]?.[1];
    const indexRegionArg = (): unknown => mocks.exportIndexCtorMock.mock.calls[0]?.[3];

    const build = async (
      consumerRegion: string,
      stateBucket?: string
    ): Promise<{ dispose: () => void }> => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver(consumerRegion, {
        statePrefix: 'cdkd',
        ...(stateBucket !== undefined && { stateBucket }),
      });
      if (!built) throw new Error('expected resolver build to succeed');
      return built;
    };

    it('resolves the bucket with the FOLDED consumer region', async () => {
      const built = await build('US-EAST-1');

      // Negative first, as the shape the regression emits: the raw spelling would
      // name `cdkd-state-<acct>-US-EAST-1`, which S3 rejects with 400.
      expect(bucketRegionArg()).not.toBe('US-EAST-1');
      expect(bucketRegionArg()).toBe('us-east-1');
      built.dispose();
    });

    it('folds a non-commercial spelling too, where the partition is at stake', async () => {
      const built = await build('CN-NORTH-1');

      expect(bucketRegionArg()).toBe('cn-north-1');
      built.dispose();
    });

    it('leaves an already-canonical consumer region byte-identical', async () => {
      const built = await build('cn-north-1');

      expect(bucketRegionArg()).toBe('cn-north-1');
      built.dispose();
    });

    it('folds the bucket region while keeping the index key RAW, in ONE build', async () => {
      // The whole point of the split: the two consumers of `consumerRegion` want
      // DIFFERENT spellings, so a fix that folded both would break the index key
      // (an object no deploy wrote) and a fix that folded neither leaves the
      // legacy bucket name unresolvable.
      const built = await build('US-EAST-1');

      expect(bucketRegionArg()).toBe('us-east-1');
      expect(indexRegionArg()).toBe('US-EAST-1');
      built.dispose();
    });

    it('still forwards an explicit --state-bucket unchanged', async () => {
      // The fold touches only the DEFAULT-name argument; an explicit bucket wins
      // inside `resolveStateBucketWithDefault` and must arrive verbatim.
      const built = await build('US-EAST-1', 'explicit-bucket');

      expect(mocks.resolveStateBucketWithDefaultMock).toHaveBeenCalledWith(
        'explicit-bucket',
        'us-east-1'
      );
      built.dispose();
    });
  });

  /**
   * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) round 4, fix 2:
   * `resolveGetStackOutput` had NO case recovery while its sibling
   * `resolveImport` scan folds both sides.
   *
   * The arm is reached with a `producerRegion` cdkd does not control: cdk-local's
   * `Fn::GetStackOutput` resolution defaults it to
   * `SubstitutionContext.consumerRegion` when the intrinsic carries no explicit
   * `Region`, and that value is a state RECORD's own spelling by this resolver's
   * contract. So a consumer record at `US-EAST-1` referencing a producer record at
   * `us-east-1` built the key `cdkd/Producer/US-EAST-1/state.json`, 404'd, and the
   * env var was dropped with only a per-key warning.
   */
  describe('resolveGetStackOutput — producer region case recovery (issue #1836 round 4)', () => {
    /** State keyed by `{stack}\0{region}`, so the mock answers per exact key like S3 does. */
    const seedState = (records: Record<string, Record<string, unknown>>): void => {
      mocks.getStateMock.mockImplementation(async (stackName: string, region: string) => {
        const outputs = records[`${stackName}\0${region}`];
        return outputs ? { state: { stackName, resources: {}, outputs }, etag: 'e' } : null;
      });
    };

    const makeResolver = async (
      consumerRegion: string
    ): Promise<{
      resolver: NonNullable<Awaited<ReturnType<typeof buildCrossStackResolver>>>['resolver'];
      dispose: () => void;
    }> => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver(consumerRegion, { statePrefix: 'cdkd' });
      if (!built) throw new Error('expected resolver build to succeed');
      return built;
    };

    it('recovers a CANONICAL producer record from an UPPER-CASED producer region', async () => {
      const { resolver, dispose } = await makeResolver('US-EAST-1');
      seedState({ 'Producer\0us-east-1': { Out: 'producer-value' } });
      mocks.listStacksMock.mockResolvedValue([
        { stackName: 'Producer', region: 'us-east-1' },
        { stackName: 'Unrelated', region: 'us-east-1' },
      ]);

      const got = await resolver.resolveGetStackOutput('Producer', 'US-EAST-1', 'Out');

      expect(got).toBe('producer-value');
      // The retry key is the RECORD's own spelling, not a folded copy — a folded
      // key would 404 on an upper-cased record.
      expect(mocks.getStateMock).toHaveBeenCalledWith('Producer', 'us-east-1');
      dispose();
    });

    it('recovers an UPPER-CASED producer record from a canonical producer region', async () => {
      // The mirror image: the fold must not assume which side is upper-cased.
      const { resolver, dispose } = await makeResolver('us-east-1');
      seedState({ 'Producer\0US-EAST-1': { Out: 'upper-record-value' } });
      mocks.listStacksMock.mockResolvedValue([{ stackName: 'Producer', region: 'US-EAST-1' }]);

      const got = await resolver.resolveGetStackOutput('Producer', 'us-east-1', 'Out');

      expect(got).toBe('upper-record-value');
      expect(mocks.getStateMock).toHaveBeenCalledWith('Producer', 'US-EAST-1');
      dispose();
    });

    it('lets the EXACT spelling win when both records exist, with no scan at all', async () => {
      // Same exact-first rule as `loadStateForStack`'s `findByRegion`: both
      // spellings can coexist as two DISTINCT records, so a fold must never
      // override a key that exists verbatim.
      const { resolver, dispose } = await makeResolver('US-EAST-1');
      seedState({
        'Producer\0US-EAST-1': { Out: 'exact' },
        'Producer\0us-east-1': { Out: 'folded' },
      });
      mocks.listStacksMock.mockResolvedValue([
        { stackName: 'Producer', region: 'US-EAST-1' },
        { stackName: 'Producer', region: 'us-east-1' },
      ]);

      expect(await resolver.resolveGetStackOutput('Producer', 'US-EAST-1', 'Out')).toBe('exact');
      expect(mocks.listStacksMock).not.toHaveBeenCalled();
      dispose();
    });

    it('leaves the already-canonical pairing byte-identical (one read, no scan)', async () => {
      const { resolver, dispose } = await makeResolver('us-east-1');
      seedState({ 'Producer\0us-east-1': { Out: 'plain' } });
      mocks.listStacksMock.mockResolvedValue([{ stackName: 'Producer', region: 'us-east-1' }]);

      expect(await resolver.resolveGetStackOutput('Producer', 'us-east-1', 'Out')).toBe('plain');
      expect(mocks.getStateMock).toHaveBeenCalledTimes(1);
      expect(mocks.listStacksMock).not.toHaveBeenCalled();
      dispose();
    });

    it('does NOT recover across a genuinely different region (the fold is not a wildcard)', async () => {
      const { resolver, dispose } = await makeResolver('us-east-1');
      seedState({ 'Producer\0us-west-2': { Out: 'west' } });
      mocks.listStacksMock.mockResolvedValue([{ stackName: 'Producer', region: 'us-west-2' }]);

      expect(await resolver.resolveGetStackOutput('Producer', 'us-east-1', 'Out')).toBeUndefined();
      dispose();
    });

    it('does NOT recover from a case-variant record of a DIFFERENT stack', async () => {
      const { resolver, dispose } = await makeResolver('US-EAST-1');
      seedState({ 'Other\0us-east-1': { Out: 'other-stack' } });
      mocks.listStacksMock.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

      expect(await resolver.resolveGetStackOutput('Producer', 'US-EAST-1', 'Out')).toBeUndefined();
      dispose();
    });

    it('keeps an exact-key HIT with a missing output a genuine miss, no recovery', async () => {
      // A record that EXISTS at the exact key IS the producer record, so reading a
      // case-variant one instead would answer from a record nobody named.
      const { resolver, dispose } = await makeResolver('US-EAST-1');
      seedState({
        'Producer\0US-EAST-1': { Other: 'x' },
        'Producer\0us-east-1': { Out: 'must-not-be-read' },
      });
      mocks.listStacksMock.mockResolvedValue([
        { stackName: 'Producer', region: 'US-EAST-1' },
        { stackName: 'Producer', region: 'us-east-1' },
      ]);

      expect(await resolver.resolveGetStackOutput('Producer', 'US-EAST-1', 'Out')).toBeUndefined();
      expect(mocks.listStacksMock).not.toHaveBeenCalled();
      dispose();
    });

    it('degrades to a miss when the recovery listStacks() throws', async () => {
      const { resolver, dispose } = await makeResolver('US-EAST-1');
      seedState({});
      mocks.listStacksMock.mockRejectedValue(new Error('S3 unavailable'));

      expect(await resolver.resolveGetStackOutput('Producer', 'US-EAST-1', 'Out')).toBeUndefined();
      dispose();
    });
  });

  describe('dispose()', () => {
    it('calls awsClients.destroy() exactly once', async () => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      const built = await buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' });
      if (!built) throw new Error('expected resolver build to succeed');

      expect(mocks.destroyMock).not.toHaveBeenCalled();
      built.dispose();
      expect(mocks.destroyMock).toHaveBeenCalledTimes(1);
    });
  });
});
