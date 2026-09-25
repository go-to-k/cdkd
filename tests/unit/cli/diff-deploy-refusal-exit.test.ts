/**
 * COMMAND level for issue
 * [go-to-k/cdkd#3335](https://github.com/go-to-k/cdkd/issues/3335): `cdkd diff`
 * exits 3 over a record whose repaired container `cdkd deploy` refuses, with
 * and without `--fail`.
 *
 * The sibling file pins the mechanism on the TREE
 * (`diff-recursive-deploy-refusal-blocking.test.ts`: which nodes carry a
 * reason, and what `countBlocking` sums). This one pins what a CI step
 * observes, which is the exit code — the layer the defect was reported at, a
 * gate on `cdkd diff --fail` passing with 0 over a record the deploy stops on.
 *
 * It also pins a precedence nothing else did: the refusal is ranked ABOVE
 * `--fail`, so a record that is both changed and refused reports the code that
 * says the deploy cannot start, not the one that says something changed.
 *
 * The harness is `diff-failed-stage-selection.test.ts`'s, which already drives
 * `createDiffCommand().parseAsync`. `{ from: 'user' }` is load-bearing there:
 * without it Commander reads the first two entries as argv0 and the script.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const mockLoggerError = vi.hoisted(() => vi.fn());
const stateForDiff = vi.hoisted(() => ({ value: null as StackState | null, reads: 0 }));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ destroy: vi.fn() })),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: vi.fn(async () => {
      stateForDiff.reads += 1;
      return stateForDiff.value ? { state: stateForDiff.value, etag: 'fake' } : null;
    }),
    listStacks: vi.fn(async () => []),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({ getProvider: vi.fn() })),
}));

import { createDiffCommand } from '../../../src/cli/commands/diff.js';

/**
 * Drive the real command and return what a CI step sees: the exit code, and
 * what the user was told. `undefined` means the command completed.
 *
 * The CLI CATCHES its own error and calls `process.exit`, so the thrown value
 * reaching a caller is the spy's, never `DeployRefusalPreviewError` — the code
 * has to come from the spy and the wording from the logger.
 */
async function runDiff(argv: string[]): Promise<{ code: number | undefined; said: string }> {
  let code: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('__process_exit__');
  }) as never);
  try {
    await createDiffCommand().parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
  } finally {
    exitSpy.mockRestore();
  }
  return { code, said: mockLoggerError.mock.calls.map((c) => String(c[0])).join('\n') };
}

/**
 * A FRESH record per call, deliberately. The read-only repairs MUTATE the
 * record in place, so a shared fixture is healthy from the second case on —
 * which is exactly how the first cut of this file passed its opening case and
 * failed the next one.
 */
function record(resources: StackState['resources'], outputs: unknown = {}): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    version: 10,
    resources,
    outputs: outputs as StackState['outputs'],
    lastModified: 0,
  };
}

const torn = (): StackState['resources'] => ({
  Q: {
    physicalId: 'q',
    resourceType: 'AWS::SQS::Queue',
    properties: 'abcdef' as unknown as Record<string, unknown>,
  },
});
const healthy = (): StackState['resources'] => ({
  Q: { physicalId: 'q', resourceType: 'AWS::SQS::Queue', properties: {} },
});

describe('cdkd diff exits 3 over a repaired container the deploy refuses (go-to-k/cdkd#3335)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The template declares the resource but NOTHING in the damaged container,
    // which is the shape that produced no delta and therefore no signal.
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'S',
          displayName: 'S',
          artifactId: 'S',
          template: { Resources: { Q: { Type: 'AWS::SQS::Queue' } } },
          dependencyNames: [],
          assets: [],
        },
      ],
    });
    stateForDiff.value = record(torn());
  });

  for (const [label, extra] of [
    ['without --fail', [] as string[]],
    ['with --fail', ['--fail']],
  ] as const) {
    it(`exits 3 ${label}`, async () => {
      const { code } = await runDiff(['diff', 'S', '--state-bucket', 'b', ...extra]);
      // The CODE is the assertion, not that it failed: `DiffDetectedError` is
      // 1 and an ordinary failure is 1 too, and before this change `--fail`
      // exited 0 here.
      expect(code, 'the command did not exit non-zero').toBe(3);
      // EXACT equality on ONE logged call, not a search over their `\n`-join.
      // Three looser forms were tried and each has a measured hole: a prefix
      // (`11 blocking condition(s)` contains the `1 ...` one); a `toContain` of
      // the whole sentence (a remedy clause APPENDED to it still passes — all
      // five green); and `/...\\.$/m` (anchors end-of-LINE, so a clause appended
      // on a NEW line still passes, and `formatError` renders the message
      // without flattening newlines, so that second line reaches the user).
      // This form reds both append shapes and pins the rendered class-name
      // prefix, without coupling to any other `logger.error` line.
      expect(mockLoggerError.mock.calls.map((c) => String(c[0]))).toContain(
        'DeployRefusalPreviewError: cdkd deploy would refuse to start: 1 blocking condition(s) reported above.'
      );
    }, 30_000);
  }

  it("exits 3 over a torn 'outputs' bag too, the other container", async () => {
    // The issue asks for command level on the `properties` shape only, so this
    // is scope rather than a defect it named — but every other case here
    // drives one container, and a wiring that carried only that one to the
    // exit code would pass all of them.
    //
    // The per-reason text is not asserted here: the `Blocking` section is
    // rendered on the report channel, while this harness captures the error
    // channel the exit carries. The sibling file pins the reason's wording;
    // what is new here is that this container reaches the exit code at all.
    stateForDiff.value = record(healthy(), 'abcdef');
    const { code } = await runDiff(['diff', 'S', '--state-bucket', 'b']);
    expect(code).toBe(3);
    expect(mockLoggerError.mock.calls.map((c) => String(c[0]))).toContain(
      'DeployRefusalPreviewError: cdkd deploy would refuse to start: 1 blocking condition(s) reported above.'
    );
  }, 30_000);

  it('renders the COUNT, not the literal 1, when two conditions fire', async () => {
    // Every other case here drives exactly one condition, so the command layer
    // could hard-code the sentence to `1` and stay green — measured. The
    // summation is pinned at the tree layer and the threading by the
    // `blockingCount = 0` probe; what was open is only how n > 1 renders, which
    // is also the only way anyone sees the `(s)` this sentence carries.
    stateForDiff.value = record(torn(), 'abcdef');
    const { code } = await runDiff(['diff', 'S', '--state-bucket', 'b']);
    expect(code).toBe(3);
    expect(mockLoggerError.mock.calls.map((c) => String(c[0]))).toContain(
      'DeployRefusalPreviewError: cdkd deploy would refuse to start: 2 blocking condition(s) reported above.'
    );
  }, 30_000);

  it('ranks the refusal ABOVE --fail when the record also changed', async () => {
    // A template that DOES declare the property, so `--fail` has a change of
    // its own to report. The user needs the code that says the deploy cannot
    // start, not the one that says something changed.
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'S',
          displayName: 'S',
          artifactId: 'S',
          template: { Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q' } } } },
          dependencyNames: [],
          assets: [],
        },
      ],
    });
    const { code } = await runDiff(['diff', 'S', '--state-bucket', 'b', '--fail']);
    expect(code, '1 here would be `--fail` winning over the refusal').toBe(3);
  }, 30_000);

  // go-to-k/cdkd#3512: the containers the diff DROPS. The template here declares
  // `Q`, so each dropped shape also previews a CREATE — `--fail` has a change of
  // its own, and 3 over 1 is the precedence being pinned.
  for (const [label, make] of [
    ["an unreadable 'resources' bag", () => record('abcdef' as unknown as StackState['resources'])],
    ['a null resources entry', () => record({ ...healthy(), R: null as never })],
    [
      'a typeless entry with a torn properties map',
      () => record({ ...healthy(), R: { properties: 'abc' } as never }),
    ],
    [
      "an 'orphans' field that is not a list",
      () => ({ ...record(healthy()), orphans: 'abc' as unknown as StackState['orphans'] }),
    ],
    [
      "an 'orphans' record the preview cannot read",
      () => ({
        ...record(healthy()),
        orphans: [{ logicalId: 'Gone', orphanedAt: 1 }] as unknown as StackState['orphans'],
      }),
    ],
  ] as const) {
    for (const extra of [[] as string[], ['--fail']]) {
      it(`exits 3 over ${label} ${extra.length ? 'with' : 'without'} --fail (go-to-k/cdkd#3512)`, async () => {
        stateForDiff.value = make();
        const { code } = await runDiff(['diff', 'S', '--state-bucket', 'b', ...extra]);
        expect(code, '1 here would be `--fail` winning, 0 the pre-fix gap').toBe(3);
        expect(mockLoggerError.mock.calls.map((c) => String(c[0]))).toContain(
          'DeployRefusalPreviewError: cdkd deploy would refuse to start: 1 blocking condition(s) reported above.'
        );
      }, 30_000);
    }
  }

  it('CONTROL: a genuinely empty {} bag exits 0, and --fail says 1 for its CREATE', async () => {
    // The healthy twin of the bag case above: `{}` is a stack holding nothing,
    // not an unreadable map, so the only signal is `--fail`'s change.
    for (const [extra, want] of [
      [[] as string[], undefined],
      [['--fail'], 1],
    ] as const) {
      stateForDiff.value = record({});
      stateForDiff.reads = 0;
      const { code } = await runDiff(['diff', 'S', '--state-bucket', 'b', ...extra]);
      expect(code, `extra=${extra.join(' ')}`).toBe(want);
      expect(stateForDiff.reads).toBeGreaterThan(0);
    }
  }, 30_000);

  it('exits 0 over a healthy record, with --fail and without', async () => {
    // The control: without it a throw that fired unconditionally would satisfy
    // every case above while making every ordinary `cdkd diff` exit 3.
    //
    // It also asserts the walk READ the record, which is what puts the repair
    // arms on the path. `code === undefined` alone is satisfied by a command
    // that short-circuited before them — the same vacuous shape as a green run
    // that never collected its file. Synthesis is not enough either: it runs
    // before the diff tree is built, so a short-circuit between the two would
    // still have called it.
    for (const extra of [[] as string[], ['--fail']]) {
      stateForDiff.value = record(healthy());
      stateForDiff.reads = 0;
      const { code } = await runDiff(['diff', 'S', '--state-bucket', 'b', ...extra]);
      expect(code, `extra=${extra.join(' ')}`).toBeUndefined();
      expect(stateForDiff.reads, 'the walk never read the state record').toBeGreaterThan(0);
    }
  }, 30_000);
});
