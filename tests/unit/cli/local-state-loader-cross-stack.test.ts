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
  // Allow the AwsClients mock to share a single destroy spy with the
  // assertion side. Each `new AwsClients(...)` returns an object whose
  // `destroy` is `destroyMock`.
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: mocks.resolveStateBucketWithDefaultMock,
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: mocks.verifyBucketExistsMock,
    listStacks: mocks.listStacksMock,
    getState: mocks.getStateMock,
  })),
}));

vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation(() => ({
    lookup: mocks.lookupMock,
  })),
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
    AwsClients: vi.fn().mockImplementation(() => ({
      s3: {},
      destroy: mocks.destroyMock,
    })),
  };
});

import { buildCrossStackResolver } from '../../../src/cli/commands/local-state-loader.js';

describe('buildCrossStackResolver', () => {
  beforeEach(() => {
    mocks.resolveStateBucketWithDefaultMock.mockReset();
    mocks.verifyBucketExistsMock.mockReset();
    mocks.listStacksMock.mockReset();
    mocks.getStateMock.mockReset();
    mocks.lookupMock.mockReset();
    mocks.destroyMock.mockReset();
  });

  afterEach(() => {
    mocks.resolveStateBucketWithDefaultMock.mockReset();
    mocks.verifyBucketExistsMock.mockReset();
    mocks.listStacksMock.mockReset();
    mocks.getStateMock.mockReset();
    mocks.lookupMock.mockReset();
    mocks.destroyMock.mockReset();
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
