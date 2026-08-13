import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * REACHABILITY fence for the `--stack-region` exact-match rule
 * (issue [#1836](https://github.com/go-to-k/cdkd/issues/1836) round 3).
 *
 * `local-state-loader.test.ts` exercises the record match by calling
 * `loadStateForStack` directly. That is necessary but NOT sufficient, and the
 * second review round proved why: the helper's exact-match arm was correct in
 * isolation while being DEAD in production, because every path into it folds
 * `--stack-region` first (each command's handler entry, and this factory for the
 * engine commands whose handler cdk-local owns). So the loader could only ever
 * receive an already-canonical candidate, `--stack-region US-EAST-1` read the
 * `us-east-1` record, and the warning called that the exact spelling.
 *
 * This suite therefore starts where a CLI invocation starts — the
 * `--from-state` factory, with the RAW flag value cdk-local hands it — and
 * drives the REAL `S3LocalStateProvider` down to the `getState` key, mocking
 * only the AWS boundary (`S3StateBackend` + the state-bucket resolver). Nothing
 * between the flag and the S3 key is stubbed, which is exactly the span the
 * previous round could not see.
 */
const mocks = vi.hoisted(() => ({
  resolveStateBucketWithDefaultMock: vi.fn(),
  verifyBucketExistsMock: vi.fn(),
  listStacksMock: vi.fn(),
  getStateMock: vi.fn(),
  awsClientsCtorMock: vi.fn(),
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

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return {
    ...actual,
    AwsClients: vi.fn().mockImplementation((config: unknown) => {
      mocks.awsClientsCtorMock(config);
      return { s3: {}, destroy: (): void => {} };
    }),
  };
});

const { cdkdExtraStateProviders } = await import('../../../src/cli/commands/local-state-source.js');
const { getLogger } = await import('../../../src/utils/logger.js');
import type { LocalStateProvider } from '../../../src/local/local-state-provider.js';

const warnSpy = vi.spyOn(getLogger(), 'warn');

/**
 * Everything a command handler does to `--stack-region` before the factory sees
 * it, copied from `local-invoke.ts` rather than imported: the point of this
 * suite is that the handler's mutation and the factory's fold COMPOSE into a
 * reachable exact match, so re-deriving the handler half here is what makes a
 * change to either side visible.
 */
function optionsAsHandlerLeavesThem(rawStackRegion: string): Record<string, unknown> {
  const options: Record<string, unknown> = {
    fromState: true,
    statePrefix: 'cdkd',
    stackRegion: rawStackRegion,
  };
  if (options['stackRegion'] !== undefined) {
    options['rawStackRegion'] = options['stackRegion'];
    options['stackRegion'] = String(options['stackRegion']).toLowerCase();
  }
  return options;
}

/** The options bag an ENGINE command produces: cdk-local folds nothing. */
function optionsAsEngineCommandLeavesThem(rawStackRegion: string): Record<string, unknown> {
  return { fromState: true, statePrefix: 'cdkd', stackRegion: rawStackRegion };
}

const buildProvider = (options: Record<string, unknown>): LocalStateProvider => {
  const provider = cdkdExtraStateProviders.fromState!(options as never);
  if (!provider) throw new Error('expected the --from-state factory to build a provider');
  return provider as unknown as LocalStateProvider;
};

/** Both case spellings on record, in the ASCII order ListObjectsV2 returns. */
const AMBIGUOUS = [
  { stackName: 'MyStack', region: 'US-EAST-1' },
  { stackName: 'MyStack', region: 'us-east-1' },
];

describe('cdkd local --from-state: --stack-region exact match is reachable (issue #1836)', () => {
  beforeEach(() => {
    mocks.resolveStateBucketWithDefaultMock.mockReset();
    mocks.verifyBucketExistsMock.mockReset();
    mocks.listStacksMock.mockReset();
    mocks.getStateMock.mockReset();
    mocks.awsClientsCtorMock.mockReset();
    warnSpy.mockReset();
    warnSpy.mockImplementation(() => {});

    mocks.resolveStateBucketWithDefaultMock.mockResolvedValue('test-bucket');
    mocks.verifyBucketExistsMock.mockResolvedValue(undefined);
    mocks.listStacksMock.mockResolvedValue(AMBIGUOUS);
    mocks.getStateMock.mockResolvedValue({
      state: { stackName: 'MyStack', resources: {}, outputs: {} },
      etag: 'abc',
    });
  });

  afterEach(() => {
    warnSpy.mockReset();
  });

  it('reads the UPPER-CASED record for `--stack-region US-EAST-1` end to end', async () => {
    const provider = buildProvider(optionsAsHandlerLeavesThem('US-EAST-1'));

    const loaded = await provider.load('MyStack', undefined);

    expect(loaded?.region).toBe('US-EAST-1');
    expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'US-EAST-1');
    // The pre-round-3 production behavior, stated as the shape a regression
    // restores: the OTHER record, reported as the exact spelling.
    expect(mocks.getStateMock).not.toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('reads the canonical record for `--stack-region us-east-1` (the mirror image)', async () => {
    const provider = buildProvider(optionsAsHandlerLeavesThem('us-east-1'));

    const loaded = await provider.load('MyStack', undefined);

    expect(loaded?.region).toBe('us-east-1');
    expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mocks.getStateMock).not.toHaveBeenCalledWith('MyStack', 'US-EAST-1');
  });

  it('says the read matched exactly, and names the spelling the user typed', async () => {
    const provider = buildProvider(optionsAsHandlerLeavesThem('US-EAST-1'));

    await provider.load('MyStack', undefined);

    const line = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain("Reading 'US-EAST-1' — matches --stack-region 'US-EAST-1' exactly");
  });

  it('gives an ENGINE command the same exact match, with no handler capture at all', async () => {
    // `start-service` / `start-alb` / `start-cloudfront` / `start-agentcore`
    // never reach a cdkd handler, so `rawStackRegion` is absent and the factory
    // has to derive it from the still-raw flag it was handed.
    const provider = buildProvider(optionsAsEngineCommandLeavesThem('US-EAST-1'));

    const loaded = await provider.load('MyStack', undefined);

    expect(loaded?.region).toBe('US-EAST-1');
    expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'US-EAST-1');
  });

  it('still recovers a case MISMATCH — the exact rule is not a strict compare', async () => {
    // Only an upper-cased record exists; `--stack-region us-east-1` must still
    // resolve it (the original #1836 defect), keyed by the record's spelling.
    mocks.listStacksMock.mockResolvedValue([{ stackName: 'MyStack', region: 'US-EAST-1' }]);
    const provider = buildProvider(optionsAsHandlerLeavesThem('us-east-1'));

    const loaded = await provider.load('MyStack', undefined);

    expect(loaded?.region).toBe('US-EAST-1');
    expect(mocks.getStateMock).toHaveBeenCalledWith('MyStack', 'US-EAST-1');
  });

  it('still folds the value that reaches the S3 CLIENT, which must stay canonical', async () => {
    // The counter-pressure on the fix: threading the raw spelling must NOT leak
    // it into an endpoint. `--region` is the client's region and is folded.
    const options = optionsAsHandlerLeavesThem('US-EAST-1');
    options['region'] = 'cn-north-1';
    const provider = buildProvider(options);

    await provider.load('MyStack', undefined);

    const config = (mocks.awsClientsCtorMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(config['region']).toBe('cn-north-1');
  });

  it('falls back with the RAW spelling in the message when no record matches', async () => {
    mocks.listStacksMock.mockResolvedValue([{ stackName: 'MyStack', region: 'eu-west-1' }]);
    const provider = buildProvider(optionsAsHandlerLeavesThem('US-EAST-1'));

    const loaded = await provider.load('MyStack', undefined);

    expect(loaded).toBeUndefined();
    const line = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // The user gets back the spelling they typed, not a folded one they never
    // wrote — the region genuinely differs, so the fold is not a wildcard.
    expect(line).toContain("has no state in region 'US-EAST-1'");
    expect(mocks.getStateMock).not.toHaveBeenCalled();
  });
});
