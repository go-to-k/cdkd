/**
 * Issue go-to-k/cdkd#3207: `buildCrossStackResolver`'s `Fn::GetStackOutput` arm
 * tested membership with `outputName in got.state.outputs` against a PRODUCER
 * record it does not own.
 *
 * That is wrong in two directions at once. `in` throws a bare `TypeError` on a
 * string, a number, a boolean or a `null` bag — swallowed by the surrounding
 * `try` and reported as "state read failed", which names nothing about the
 * record — while it ANSWERS on a list (`0 in [1,2]` is `true`), so a list bag
 * resolved a fabricated element into a local environment variable.
 *
 * REPAIR-AND-WARN, not refuse: this reader writes no `state.json`, and the
 * module's stated policy is that every expected miss warns and returns
 * `undefined`. The bag is read as EMPTY and the damaged record is NAMED — the
 * half that stops "this producer has no such output" standing in for "this
 * producer's record is damaged".
 *
 * Its `Fn::ImportValue` sibling is deliberately NOT re-fenced here: that arm
 * goes through `importableOutputKeys`, which already fails closed, and one case
 * below pins that premise rather than leaving it assumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  resolveStateBucketWithDefaultMock: vi.fn(),
  verifyBucketExistsMock: vi.fn(),
  listStacksMock: vi.fn(),
  getStateMock: vi.fn(),
  lookupMock: vi.fn(),
  destroyMock: vi.fn(),
  warnMock: vi.fn(),
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
  ExportIndexStore: vi.fn().mockImplementation(() => ({ lookup: mocks.lookupMock })),
}));
vi.mock('../../../src/utils/aws-clients.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../src/utils/aws-clients.js'
  );
  return {
    ...actual,
    AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: mocks.destroyMock })),
  };
});
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
    warn: mocks.warnMock,
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});

import { buildCrossStackResolver } from '../../../src/cli/commands/local-state-loader.js';

type Resolver = NonNullable<Awaited<ReturnType<typeof buildCrossStackResolver>>>['resolver'];

async function makeResolver(): Promise<{ resolver: Resolver; dispose: () => void }> {
  mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
  mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
  // An exact-key miss falls through to a `listStacks()` case recovery; an
  // un-primed mock would iterate `undefined` and throw into the catch, making
  // every absence assertion below pass for the wrong reason.
  mocks.listStacksMock.mockResolvedValue([]);
  const built = await buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' });
  if (!built) throw new Error('expected resolver build to succeed');
  return built;
}

const warned = (): string => mocks.warnMock.mock.calls.map((c) => String(c[0])).join('\n');

describe('cdkd local Fn::GetStackOutput over a malformed producer bag (go-to-k/cdkd#3207)', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
  });
  afterEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
  });

  const MALFORMED: Array<[string, unknown]> = [
    ['a string bag', 'abcdef'],
    ['a list bag', ['first', 'second']],
    ['a null bag', null],
    ['a number bag', 5],
    ['a boolean bag', true],
  ];

  for (const [label, bag] of MALFORMED) {
    it(`reads ${label} as EMPTY and names the producer`, async () => {
      const { resolver, dispose } = await makeResolver();
      mocks.getStateMock.mockResolvedValue({
        state: { stackName: 'Producer', resources: {}, outputs: bag },
        etag: 'e',
      });
      // `'0'` is the DISCRIMINATOR: it is an INDEX of the string and of the
      // list, so it is exactly the input the pre-fix `in` answered — `'a'` and
      // `'first'`. A name the bag cannot index would have missed either way.
      expect(await resolver.resolveGetStackOutput('Producer', 'us-east-1', '0')).toBeUndefined();
      expect(
        warned(),
        'the damaged producer record was read as empty SILENTLY, so a miss reads as "exports none"'
      ).toContain('Producer');
      expect(warned()).toContain("no readable 'outputs' map");
      dispose();
    });
  }

  it('names the RECORD region on the case-variant recovery arm, not the caller spelling', async () => {
    // That arm reads a DIFFERENT key from the one the caller named, so a
    // warning carrying `producerRegion` would point at a record that does not
    // exist.
    const { resolver, dispose } = await makeResolver();
    mocks.listStacksMock.mockResolvedValue([{ stackName: 'Producer', region: 'us-east-1' }]);
    mocks.getStateMock.mockImplementation(async (_stack: string, region: string) =>
      region === 'us-east-1'
        ? { state: { stackName: 'Producer', resources: {}, outputs: 'abcdef' }, etag: 'e' }
        : null
    );
    expect(await resolver.resolveGetStackOutput('Producer', 'US-EAST-1', '0')).toBeUndefined();
    // Unquoted: `shellQuote` leaves an ordinary region spelling bare. What is
    // pinned is the CASE, which is the whole point of the arm.
    expect(warned()).toContain('(us-east-1)');
    expect(
      warned(),
      'the warning named the CALLER spelling, which is not the key the damaged record sits at'
    ).not.toContain('US-EAST-1');
    dispose();
  });

  it('refuses a PROTOTYPE key on a healthy bag — `in` walked the chain', async () => {
    // `outputName` is template-controlled, so on a plain object the old `in`
    // answered TRUE for `toString` and the arm returned a FUNCTION. Same
    // defence, and the same reason, as the deploy-side resolver (issue #2767).
    const { resolver, dispose } = await makeResolver();
    mocks.getStateMock.mockResolvedValue({
      state: { stackName: 'P', resources: {}, outputs: { Real: 'v' } },
      etag: 'e',
    });
    expect(
      await resolver.resolveGetStackOutput('P', 'us-east-1', 'toString'),
      'a prototype member resolved as a local output value'
    ).toBeUndefined();
    dispose();
  });

  // THE OTHER DIRECTION — a fence that warned on every record would make every
  // `cdkd local` run noisy and tell the operator nothing.
  it('resolves a healthy bag unchanged and warns about nothing', async () => {
    const { resolver, dispose } = await makeResolver();
    mocks.getStateMock.mockResolvedValue({
      state: { stackName: 'P', resources: {}, outputs: { Out: 'literal-value' } },
      etag: 'e',
    });
    expect(await resolver.resolveGetStackOutput('P', 'us-east-1', 'Out')).toBe('literal-value');
    expect(warned()).toBe('');
    dispose();
  });

  it('stays silent on an EMPTY bag and on an ABSENT one', async () => {
    const { resolver, dispose } = await makeResolver();
    mocks.getStateMock.mockResolvedValue({
      state: { stackName: 'P', resources: {}, outputs: {} },
      etag: 'e',
    });
    expect(await resolver.resolveGetStackOutput('P', 'us-east-1', 'Out')).toBeUndefined();
    mocks.getStateMock.mockResolvedValue({
      state: { stackName: 'P', resources: {}, outputs: undefined },
      etag: 'e',
    });
    expect(await resolver.resolveGetStackOutput('P', 'us-east-1', 'Out')).toBeUndefined();
    expect(
      warned(),
      'an empty or absent outputs bag is an ordinary record and must not be reported damaged'
    ).toBe('');
    dispose();
  });

  it('the Fn::ImportValue sibling was ALREADY closed — the premise, asserted', async () => {
    // This arm goes through `importableOutputKeys`, which fails closed on an
    // unreadable bag, so go-to-k/cdkd#3207 deliberately changed nothing here.
    // Without this case that exclusion is a claim rather than a measurement.
    const { resolver, dispose } = await makeResolver();
    mocks.lookupMock.mockResolvedValue(undefined);
    mocks.listStacksMock.mockResolvedValue([{ stackName: 'Producer', region: 'us-east-1' }]);
    mocks.getStateMock.mockResolvedValue({
      state: { stackName: 'Producer', resources: {}, outputs: 'abcdef' },
      etag: 'e',
    });
    expect(await resolver.resolveImport('0')).toBeUndefined();
    dispose();
  });

  // ONCE PER PRODUCER RECORD, not per reference — the shape `scrub.ts`'s
  // equivalent arm already deduped and this reader did not adopt until now.
  // Two-sided, because the cheap way to make the first case pass is to warn
  // once per RESOLVER, which would swallow a second genuinely damaged record.
  const warnLines = (): number =>
    mocks.warnMock.mock.calls.filter((c) => String(c[0]).includes("no readable 'outputs' map"))
      .length;

  it('names ONE damaged producer record once, however many references read it', async () => {
    const { resolver, dispose } = await makeResolver();
    mocks.getStateMock.mockResolvedValue({
      state: { stackName: 'Producer', resources: {}, outputs: 'abcdef' },
      etag: 'e',
    });
    // Three DISTINCT output names, so nothing is deduped by the key being equal
    // — one `cdkd local` env block routinely carries several reads of one
    // producer, which is the population this exists for.
    for (const name of ['0', '1', '2']) {
      expect(await resolver.resolveGetStackOutput('Producer', 'us-east-1', name)).toBeUndefined();
    }
    expect(warnLines(), 'the paragraph-length warning was repeated per reference').toBe(1);
    dispose();
  });

  it('still names a SECOND damaged record — the dedup is per record, not per run', async () => {
    const { resolver, dispose } = await makeResolver();
    // Same stack NAME in two regions: two DISTINCT state records, damaged
    // independently. Keying the set on the stack alone would silence the
    // second, which is the over-broad direction.
    mocks.getStateMock.mockImplementation(async (_stack: string, region: string) => ({
      state: { stackName: 'Producer', region, resources: {}, outputs: 'abcdef' },
      etag: 'e',
    }));
    expect(await resolver.resolveGetStackOutput('Producer', 'us-east-1', '0')).toBeUndefined();
    expect(await resolver.resolveGetStackOutput('Producer', 'us-west-2', '0')).toBeUndefined();
    expect(warnLines(), 'a second damaged record went unreported').toBe(2);
    expect(warned()).toContain('us-east-1');
    expect(warned()).toContain('us-west-2');
    dispose();
  });

  it('counts the exact arm and the case-folded recovery arm as ONE record', async () => {
    // `readOutput` is reached from two places, and each passes its own region
    // binding — `producerRegion` on the exact hit, the REF's region on the
    // recovery walk. They agree only because the recovery arm passes the
    // spelling it actually fetched; a key built from the caller's spelling
    // instead would warn twice about one record. Measured rather than reasoned:
    // the region TEXT is pinned by a case above, the KEY was not.
    const { resolver, dispose } = await makeResolver();
    mocks.listStacksMock.mockResolvedValue([{ stackName: 'Producer', region: 'us-east-1' }]);
    mocks.getStateMock.mockImplementation(async (_stack: string, region: string) =>
      region === 'us-east-1'
        ? { state: { stackName: 'Producer', resources: {}, outputs: 'abcdef' }, etag: 'e' }
        : null
    );
    // First read takes the RECOVERY arm (the caller's spelling misses), the
    // second takes the EXACT arm. Same underlying record both times.
    expect(await resolver.resolveGetStackOutput('Producer', 'US-EAST-1', '0')).toBeUndefined();
    expect(await resolver.resolveGetStackOutput('Producer', 'us-east-1', '1')).toBeUndefined();
    expect(warnLines(), 'one record warned twice — the two arms built different keys').toBe(1);
    dispose();
  });
});

describe('a caller-supplied warned-set spans several resolvers (go-to-k/cdkd#3293)', () => {
  const warnLines = (): number =>
    mocks.warnMock.mock.calls.filter((c) => String(c[0]).includes("no readable 'outputs' map"))
      .length;

  async function twoResolvers(shared?: Set<string>) {
    // Reset INSIDE the helper: the counter below is a per-case total, and the
    // file-level `beforeEach` runs before the case, not before this call.
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
    mocks.listStacksMock.mockResolvedValue([]);
    mocks.getStateMock.mockResolvedValue({
      state: { stackName: 'Producer', resources: {}, outputs: 'abcdef' },
      etag: 'e',
    });
    const opts = {
      statePrefix: 'cdkd',
      ...(shared !== undefined && { warnedMalformedProducers: shared }),
    };
    const a = await buildCrossStackResolver('us-east-1', opts);
    const b = await buildCrossStackResolver('us-east-1', opts);
    if (!a || !b) throw new Error('expected both resolver builds to succeed');
    await a.resolver.resolveGetStackOutput('Producer', 'us-east-1', '0');
    await b.resolver.resolveGetStackOutput('Producer', 'us-east-1', '0');
    a.dispose();
    b.dispose();
  }

  it('names one damaged record ONCE across two resolvers when the set is shared', async () => {
    // `local invoke-agentcore` is the boot that builds two — one for the
    // `fromS3` bucket intrinsic, one for the container env — so a producer read
    // by both was reported as two damaged records.
    await twoResolvers(new Set<string>());
    expect(warnLines(), 'the paragraph was repeated once per resolver').toBe(1);
  });

  it('still keeps its own set when the caller supplies none', async () => {
    // The other direction, and the reason the option is optional: `local
    // invoke` and `local run-task` each build exactly one, and must not start
    // sharing state through a module-global.
    await twoResolvers(undefined);
    expect(warnLines(), 'two independent resolvers silently shared a set').toBe(2);
  });
});

describe('two records a SEPARATOR would collide are both named (go-to-k/cdkd#3308)', () => {
  const warnLines = (): number =>
    mocks.warnMock.mock.calls.filter((c) => String(c[0]).includes("no readable 'outputs' map"))
      .length;

  it('warns twice, which is the behaviour the key encoding buys', () => {
    // The case issue go-to-k/cdkd#3308 actually asks for, and the one the unit
    // fence on `producerRecordKey` cannot give: it proves the HELPER is
    // injective, not that the reader USES it. Both a NUL and a printable
    // separator collide this pair, so this reds on either spelling.
    const NUL = String.fromCharCode(0);
    return (async (): Promise<void> => {
      for (const m of Object.values(mocks)) m.mockReset();
      mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
      mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
      mocks.listStacksMock.mockResolvedValue([]);
      mocks.getStateMock.mockImplementation(async (stack: string, region: string) => ({
        state: { stackName: stack, region, resources: {}, outputs: 'abcdef' },
        etag: 'e',
      }));
      const { resolver, dispose } = await makeResolver();
      // Same shared set, two DISTINCT records whose halves straddle the
      // separator in opposite places.
      expect(
        await resolver.resolveGetStackOutput(`Evil${NUL}us-east-1`, 'ap-northeast-1', '0')
      ).toBeUndefined();
      expect(
        await resolver.resolveGetStackOutput('Evil', `us-east-1${NUL}ap-northeast-1`, '0')
      ).toBeUndefined();
      expect(warnLines(), 'one of the two damaged records went unreported').toBe(2);
      dispose();
    })();
  });
});
