import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// Hoisted mocks so vi.mock factories can reference them safely.
// (See feedback_vi_mock_hoisting.md.)
const mocks = vi.hoisted(() => ({
  resolveStateBucketWithDefaultMock: vi.fn(),
  verifyBucketExistsMock: vi.fn(),
  listStacksMock: vi.fn(),
  getStateMock: vi.fn(),
  // Records every `new S3StateBackend(...)` argument list.
  backendCtorMock: vi.fn(),
  /**
   * Records every `new AwsClients(...)` config (issue #1836 round 3).
   *
   * This — NOT the `S3StateBackend` constructor's third argument — is where
   * `--region` actually decides an ENDPOINT: `S3StateBackend` reads only
   * `profile` / `credentials` out of that bag (`src/state/s3-state-backend.ts`),
   * while the client the backend is handed comes from `new AwsClients({ region
   * })`. Asserting only the backend's bag left the fix unfenced — reverting the
   * `AwsClients` line alone kept the whole suite green.
   */
  awsClientsCtorMock: vi.fn(),
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

/**
 * The REAL `AwsClients` is kept (the lifecycle suite below asserts
 * `setAwsClients` / `resetAwsClients` behavior against a genuine instance, and
 * its constructor only stores the config — no clients are built until a getter
 * runs), wrapped in a subclass that records the config on the way through. A
 * wholesale module mock would make the lifecycle assertions vacuous.
 */
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return {
    ...actual,
    AwsClients: class RecordingAwsClients extends actual.AwsClients {
      constructor(config: ConstructorParameters<typeof actual.AwsClients>[0] = {}) {
        mocks.awsClientsCtorMock(config);
        super(config);
      }
    },
  };
});

import { loadStateForStack } from '../../../src/cli/commands/local-state-loader.js';
import { getAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * `getLogger()` returns a module-global singleton and the loader calls it per
 * invocation, so spying on the instance intercepts the loader's own writes
 * without mocking the whole logger module (which every transitive import shares).
 */
const warnSpy = vi.spyOn(getLogger(), 'warn');

/** Run `fn` with `AWS_REGION` / `AWS_DEFAULT_REGION` set to exact values. */
async function withEnvRegion(
  values: { AWS_REGION?: string; AWS_DEFAULT_REGION?: string },
  fn: () => Promise<void>
): Promise<void> {
  const saved = {
    AWS_REGION: process.env['AWS_REGION'],
    AWS_DEFAULT_REGION: process.env['AWS_DEFAULT_REGION'],
  };
  for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION'] as const) {
    const next = values[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    await fn();
  } finally {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION'] as const) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

describe('loadStateForStack — globalClients lifecycle', () => {
  beforeEach(() => {
    resetAwsClients();
    mocks.resolveStateBucketWithDefaultMock.mockReset();
    mocks.verifyBucketExistsMock.mockReset();
    mocks.listStacksMock.mockReset();
    mocks.getStateMock.mockReset();
    mocks.backendCtorMock.mockReset();
    mocks.awsClientsCtorMock.mockReset();
    warnSpy.mockReset();
    warnSpy.mockImplementation(() => {});
  });

  afterEach(() => {
    resetAwsClients();
  });

  it('resets globalClients after a successful load so no destroyed reference leaks', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
    mocks.listStacksMock.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mocks.getStateMock.mockResolvedValue({
      state: { stackName: 'MyStack', resources: {} },
      etag: 'abc',
    });

    const result = await loadStateForStack('MyStack', 'us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    expect(result?.region).toBe('us-east-1');
    // After loadStateForStack returns, globalClients must be null —
    // getAwsClients() should construct a fresh instance, not return the
    // destroyed one set inside the helper.
    const fresh = getAwsClients();
    const fresh2 = getAwsClients();
    expect(fresh).toBe(fresh2); // same fresh instance returned twice
    // Sanity-check the fresh instance is usable (no thrown "client destroyed").
    expect(() => fresh.s3).not.toThrow();
  });

  it('resets globalClients after a bucket-resolution failure (warn-and-fall-back path)', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockRejectedValue(new Error('bucket lookup failed'));

    const result = await loadStateForStack('MyStack', 'us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    });

    expect(result).toBeUndefined();
    // No AwsClients was constructed on the early-return path; the global
    // should still be null and a subsequent getAwsClients() call must
    // produce a fresh instance.
    const fresh = getAwsClients();
    expect(() => fresh.s3).not.toThrow();
  });

  /**
   * Issue [#1836](https://github.com/go-to-k/cdkd/issues/1836): the
   * `--stack-region` -> state-record region compare was a raw `===`, so
   * `--stack-region US-EAST-1` missed the `us-east-1` record and the miss is a
   * SILENT fall-back — the user sees a command that "works" against no state.
   *
   * The compare folds BOTH sides, and `targetRegion` (the
   * `cdkd/{stack}/{region}/state.json` KEY) keeps the RECORD's own spelling —
   * folding only the flag would have broken the mirror-image case, since a
   * region's case is not the flag's to decide (nothing folds `cdkd deploy
   * --region`, and an upper-cased COMMERCIAL deploy succeeds — DNS is
   * case-insensitive — and keys its state that way).
   */
  describe('--stack-region region case (issue #1836)', () => {
    const primeState = (refs: { stackName: string; region?: string }[]): void => {
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      mocks.listStacksMock.mockResolvedValue(refs);
      mocks.getStateMock.mockResolvedValue({
        state: { stackName: 'MyStack', resources: {} },
        etag: 'abc',
      });
    };

    /**
     * The option pair a REAL `--stack-region <raw>` produces, and the reason it
     * is a helper rather than two inline fields (issue #1836 round 3): every row
     * below used to pass a bare `stackRegion: 'US-EAST-1'`, a shape no CLI
     * invocation can produce — the four command handlers and the `--from-state`
     * factory all fold the flag before the loader sees it, so a raw candidate
     * could only ever arrive in a test. Building the pair the way
     * `local-invoke.ts` does (capture raw, then fold) keeps these rows on the
     * reachable path; the factory-to-record-read fence for the boundary itself
     * lives in `local-from-state-stack-region.test.ts`.
     */
    const cliStackRegion = (raw: string): { stackRegion: string; rawStackRegion: string } => ({
      stackRegion: raw.toLowerCase(),
      rawStackRegion: raw,
    });

    it('matches an upper-cased --stack-region against a canonical state record', async () => {
      primeState([{ stackName: 'MyStack', region: 'us-east-1' }]);

      const result = await loadStateForStack('MyStack', undefined, {
        statePrefix: 'cdkd',
        ...cliStackRegion('US-EAST-1'),
      });

      // The regression this pins: the raw `===` returned `undefined` here and
      // never issued a getState at all (silent fall-back, exit 0).
      expect(result?.region).toBe('us-east-1');
      expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    });

    it('leaves an already-canonical --stack-region byte-identical', async () => {
      primeState([{ stackName: 'MyStack', region: 'us-east-1' }]);

      const result = await loadStateForStack('MyStack', undefined, {
        statePrefix: 'cdkd',
        ...cliStackRegion('us-east-1'),
      });

      expect(result?.region).toBe('us-east-1');
      expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    });

    it('keys getState with the RECORD spelling when the record is the upper-cased side', async () => {
      // The mirror image, and the reason the fix is a both-sides fold rather
      // than a fold of the flag: an upper-cased record must stay reachable, and
      // its state key is its own spelling — a folded key would 404.
      primeState([{ stackName: 'MyStack', region: 'US-EAST-1' }]);

      const result = await loadStateForStack('MyStack', undefined, {
        statePrefix: 'cdkd',
        ...cliStackRegion('us-east-1'),
      });

      expect(result?.region).toBe('US-EAST-1');
      expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'US-EAST-1');
      // The feared shape of an over-eager fix: keying the read off the folded
      // FLAG, which names an object that does not exist.
      expect(mocks.getStateMock).not.toHaveBeenCalledWith('MyStack', 'us-east-1');
    });

    it('still falls back when the region genuinely differs (the fold is not a wildcard)', async () => {
      primeState([{ stackName: 'MyStack', region: 'us-east-1' }]);

      const result = await loadStateForStack('MyStack', undefined, {
        statePrefix: 'cdkd',
        ...cliStackRegion('eu-west-1'),
      });

      expect(result).toBeUndefined();
      expect(mocks.getStateMock).not.toHaveBeenCalled();
    });

    it('matches the synth region against an upper-cased record, keyed by the record', async () => {
      // The sibling comparison in the same chain. TWO refs, so the single-ref
      // branch cannot rescue it: before the fold this fell through to the
      // "state in multiple regions" warn and returned undefined.
      primeState([
        { stackName: 'MyStack', region: 'US-EAST-1' },
        { stackName: 'MyStack', region: 'eu-west-1' },
      ]);

      const result = await loadStateForStack('MyStack', 'us-east-1', {
        statePrefix: 'cdkd',
      });

      expect(result?.region).toBe('US-EAST-1');
      expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'US-EAST-1');
    });

    it('leaves the canonical synth-region match byte-identical', async () => {
      primeState([
        { stackName: 'MyStack', region: 'us-east-1' },
        { stackName: 'MyStack', region: 'eu-west-1' },
      ]);

      const result = await loadStateForStack('MyStack', 'us-east-1', {
        statePrefix: 'cdkd',
      });

      expect(result?.region).toBe('us-east-1');
      expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    });

    /**
     * Issue #1836 review fix 1: with BOTH case spellings present the fold must
     * not silently prefer the other record.
     *
     * `S3StateBackend.listStacks` dedupes on the EXACT `{stack}\0{region}` pair,
     * so `cdkd/MyStack/US-EAST-1/state.json` and
     * `cdkd/MyStack/us-east-1/state.json` are two DISTINCT refs, and
     * ListObjectsV2 returns them in ASCII order — the upper-cased one FIRST,
     * which is the order these primings reproduce. A fold-only `find` therefore
     * answered `--stack-region us-east-1` with the OTHER stack's state; the
     * pre-fold `===` got this case right, so the fold INTRODUCED it.
     */
    describe('case-ambiguous records: exact spelling wins (issue #1836)', () => {
      const AMBIGUOUS = [
        // ASCII order, as ListObjectsV2 returns it: uppercase first.
        { stackName: 'MyStack', region: 'US-EAST-1' },
        { stackName: 'MyStack', region: 'us-east-1' },
      ];

      it('reads the canonical record for a canonical --stack-region', async () => {
        primeState(AMBIGUOUS);

        const result = await loadStateForStack('MyStack', undefined, {
          statePrefix: 'cdkd',
          ...cliStackRegion('us-east-1'),
        });

        expect(result?.region).toBe('us-east-1');
        expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'us-east-1');
        // The shape a fold-only `find` emits: the FIRST canonical-equal ref,
        // i.e. a record the user did not name.
        expect(mocks.getStateMock).not.toHaveBeenCalledWith('MyStack', 'US-EAST-1');
      });

      it('reads the upper-cased record for an upper-cased --stack-region (mirror image)', async () => {
        primeState(AMBIGUOUS);

        const result = await loadStateForStack('MyStack', undefined, {
          statePrefix: 'cdkd',
          ...cliStackRegion('US-EAST-1'),
        });

        expect(result?.region).toBe('US-EAST-1');
        expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'US-EAST-1');
        expect(mocks.getStateMock).not.toHaveBeenCalledWith('MyStack', 'us-east-1');
      });

      it('warns that more than one ref is canonical-equal, naming the one it reads', async () => {
        primeState(AMBIGUOUS);

        await loadStateForStack('MyStack', undefined, {
          statePrefix: 'cdkd',
          ...cliStackRegion('us-east-1'),
        });

        const line = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(line).toContain('case-variant spellings');
        expect(line).toContain('--stack-region');
        // The wording must state which RULE decided the read — it used to say
        // "(the exact spelling)" on a path where the candidate was always the
        // folded value, i.e. it attributed the read to a match that could not
        // have happened.
        expect(line).toContain("Reading 'us-east-1' — matches --stack-region 'us-east-1' exactly");
      });

      it('says NO exact spelling matched when the read is a case recovery', async () => {
        // Only the upper-cased pair exists twice under different cases of the
        // SAME canonical region; neither is spelled `us-EAST-1`.
        primeState([
          { stackName: 'MyStack', region: 'US-EAST-1' },
          { stackName: 'MyStack', region: 'Us-East-1' },
        ]);

        const result = await loadStateForStack('MyStack', undefined, {
          statePrefix: 'cdkd',
          ...cliStackRegion('us-east-1'),
        });

        // First canonical-equal ref, since nothing matches verbatim.
        expect(result?.region).toBe('US-EAST-1');
        const line = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(line).toContain(
          "no record spells --stack-region 'us-east-1' exactly, so this is a case-insensitive recovery"
        );
        // ... and it must NOT claim the opposite. This is the exact sentence the
        // false-attribution regression emits on this input.
        expect(line).not.toContain("matches --stack-region 'us-east-1' exactly");
      });

      it('reads the canonical record for the SYNTH-region branch too', async () => {
        // Same defect one branch over. A third region keeps the single-ref
        // branch from rescuing it.
        primeState([...AMBIGUOUS, { stackName: 'MyStack', region: 'eu-west-1' }]);

        const result = await loadStateForStack('MyStack', 'us-east-1', {
          statePrefix: 'cdkd',
        });

        expect(result?.region).toBe('us-east-1');
        expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'us-east-1');
        expect(mocks.getStateMock).not.toHaveBeenCalledWith('MyStack', 'US-EAST-1');
      });

      it('warns on the synth-region branch as well', async () => {
        primeState([...AMBIGUOUS, { stackName: 'MyStack', region: 'eu-west-1' }]);

        await loadStateForStack('MyStack', 'us-east-1', { statePrefix: 'cdkd' });

        const line = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(line).toContain('case-variant spellings');
        expect(line).toContain('the synth-derived stack region');
      });

      it('does NOT warn about the synth region when --stack-region decides the read', async () => {
        // The synth-region match is not consulted on this path, so warning about
        // its case variants would be noise about a record nothing reads.
        primeState([...AMBIGUOUS, { stackName: 'MyStack', region: 'eu-west-1' }]);

        await loadStateForStack('MyStack', 'us-east-1', {
          statePrefix: 'cdkd',
          ...cliStackRegion('eu-west-1'),
        });

        // Asserted as "no warning at all" rather than as the ABSENCE of a
        // phrase: a wording-keyed negative goes vacuous the moment the message
        // is reworded, which this round's message-truthfulness fix did.
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('does not warn at all when exactly one ref is canonical-equal', async () => {
        primeState([
          { stackName: 'MyStack', region: 'us-east-1' },
          { stackName: 'MyStack', region: 'eu-west-1' },
        ]);

        await loadStateForStack('MyStack', undefined, {
          statePrefix: 'cdkd',
          ...cliStackRegion('US-EAST-1'),
        });

        // Same reason as above: no warning at all, not the absence of a phrase.
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    /**
     * Issue #1836 review fix 2 + the loader's own chain: `resolveStateBucketWithDefault`
     * receives the FOLDED chain region (it names the legacy default bucket
     * `cdkd-state-{acct}-{region}`), and the state backend receives the FOLDED
     * `opts.region` (it builds the S3 client, whose endpoint resolution is
     * case-SENSITIVE). The bootstrap-repo sibling suite has the chain assertion;
     * this one did not.
     */
    describe('region chain + client region folds (issue #1836)', () => {
      const backendClientOpts = (): Record<string, unknown> =>
        (mocks.backendCtorMock.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;
      /**
       * The bag that actually decides the S3 ENDPOINT (issue #1836 round 3).
       * `S3StateBackend` reads only `profile` / `credentials` out of its own
       * third argument, so `backendClientOpts()` alone left the fold unfenced —
       * reverting `new AwsClients({ region: clientRegion })` to the raw value
       * kept every assertion in this file green.
       */
      const awsClientsConfig = (): Record<string, unknown> =>
        (mocks.awsClientsCtorMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;

      it('hands resolveStateBucketWithDefault the FOLDED region from AWS_REGION', async () => {
        primeState([{ stackName: 'MyStack', region: 'cn-north-1' }]);

        await withEnvRegion({ AWS_REGION: 'CN-NORTH-1' }, async () => {
          await loadStateForStack('MyStack', undefined, { statePrefix: 'cdkd' });
        });

        expect(mocks.resolveStateBucketWithDefaultMock).toHaveBeenCalledWith(
          undefined,
          'cn-north-1'
        );
        // The feared shape: a legacy bucket name S3 could never have accepted,
        // probed against the wrong partition's default.
        expect(mocks.resolveStateBucketWithDefaultMock).not.toHaveBeenCalledWith(
          undefined,
          'CN-NORTH-1'
        );
      });

      it('folds AWS_DEFAULT_REGION too (the second env-var link)', async () => {
        primeState([{ stackName: 'MyStack', region: 'cn-north-1' }]);

        await withEnvRegion({ AWS_DEFAULT_REGION: 'CN-NORTH-1' }, async () => {
          await loadStateForStack('MyStack', undefined, { statePrefix: 'cdkd' });
        });

        expect(mocks.resolveStateBucketWithDefaultMock).toHaveBeenCalledWith(
          undefined,
          'cn-north-1'
        );
      });

      it('leaves an already-canonical AWS_REGION byte-identical', async () => {
        primeState([{ stackName: 'MyStack', region: 'cn-north-1' }]);

        await withEnvRegion({ AWS_REGION: 'cn-north-1' }, async () => {
          await loadStateForStack('MyStack', undefined, { statePrefix: 'cdkd' });
        });

        expect(mocks.resolveStateBucketWithDefaultMock).toHaveBeenCalledWith(
          undefined,
          'cn-north-1'
        );
      });

      it('builds the state backend with the FOLDED --region', async () => {
        primeState([{ stackName: 'MyStack', region: 'cn-north-1' }]);

        await loadStateForStack('MyStack', undefined, {
          statePrefix: 'cdkd',
          region: 'CN-NORTH-1',
        });

        expect(backendClientOpts()['region']).toBe('cn-north-1');
        expect(backendClientOpts()['region']).not.toBe('CN-NORTH-1');
      });

      it('leaves an already-canonical --region byte-identical on the client', async () => {
        primeState([{ stackName: 'MyStack', region: 'cn-north-1' }]);

        await loadStateForStack('MyStack', undefined, {
          statePrefix: 'cdkd',
          region: 'cn-north-1',
        });

        expect(backendClientOpts()['region']).toBe('cn-north-1');
      });

      it('omits the client region entirely when --region is absent', async () => {
        // Absent must stay ABSENT: omitting `region` is what lets the SDK's own
        // chain resolve the profile's region.
        primeState([{ stackName: 'MyStack', region: 'us-east-1' }]);

        await withEnvRegion({}, async () => {
          await loadStateForStack('MyStack', 'us-east-1', { statePrefix: 'cdkd' });
        });

        expect('region' in backendClientOpts()).toBe(false);
        expect('region' in awsClientsConfig()).toBe(false);
      });

      it('builds the S3 CLIENT with the FOLDED --region', async () => {
        // The assertion the previous round was missing entirely: this is the
        // constructor whose region resolves the endpoint.
        primeState([{ stackName: 'MyStack', region: 'cn-north-1' }]);

        await loadStateForStack('MyStack', undefined, {
          statePrefix: 'cdkd',
          region: 'CN-NORTH-1',
        });

        expect(awsClientsConfig()['region']).toBe('cn-north-1');
        // The feared shape stated on its own: an S3 client built with
        // `CN-NORTH-1` talks to the COMMERCIAL partition, and nothing rejects it.
        expect(awsClientsConfig()['region']).not.toBe('CN-NORTH-1');
      });

      it('leaves an already-canonical --region byte-identical on the S3 client', async () => {
        primeState([{ stackName: 'MyStack', region: 'cn-north-1' }]);

        await loadStateForStack('MyStack', undefined, {
          statePrefix: 'cdkd',
          region: 'cn-north-1',
        });

        expect(awsClientsConfig()['region']).toBe('cn-north-1');
      });

      it('treats a BLANK --region as absent rather than passing region: ""', async () => {
        // `--region ''` passed the old `!== undefined` gate and reached the
        // client as `region: ''`, which names no endpoint — while the comment
        // beside it claimed an absent value stays absent.
        primeState([{ stackName: 'MyStack', region: 'us-east-1' }]);

        await withEnvRegion({}, async () => {
          await loadStateForStack('MyStack', 'us-east-1', { statePrefix: 'cdkd', region: '' });
        });

        expect('region' in awsClientsConfig()).toBe(false);
        expect('region' in backendClientOpts()).toBe(false);
      });
    });
  });

  it('resets globalClients after a mid-flow error (e.g. verifyBucketExists rejects)', async () => {
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.verifyBucketExistsMock.mockRejectedValue(new Error('access denied'));

    await expect(
      loadStateForStack('MyStack', 'us-east-1', {
        statePrefix: 'cdkd',
        region: 'us-east-1',
      })
    ).rejects.toThrow('access denied');

    // Even on a thrown error, the finally must reset the global.
    const fresh = getAwsClients();
    expect(() => fresh.s3).not.toThrow();
  });
});
