/**
 * `cdkd scrub`'s stack SELECTION, and a CDK Stage that failed to load (issue
 * [#3507](https://github.com/go-to-k/cdkd/issues/3507)).
 *
 * A Stage whose manifest cannot be read fails synthesis, as in the AWS CDK
 * CLI, so no selection -- `--all`, none, a wildcard, an exact name -- scrubs
 * the stacks that did load and reports them clean. scrub turns it into a
 * refusal (exit 2), not `--fail`'s exit 1. A selection that matches nothing names the patterns
 * and the stacks the app has, through the same `renderNoStackMatch` as every
 * other command.
 *
 * Every case here stops at selection, before any state read: the synthesizer's
 * `expandMacrosForStacks` -- the first step AFTER selection -- raises a
 * sentinel, so reaching it is the positive control and never reaching it is
 * what "selection refused" means.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const infoSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: infoSpy, warn: vi.fn(), error: vi.fn(), setLevel: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

const synthResult = vi.hoisted(() => ({
  stacks: [] as Array<{
    stackName: string;
    displayName?: string;
    stagePath?: string;
    template: object;
  }>,
  error: undefined as Error | undefined,
}));
const expandMacros = vi.hoisted(() => ({ calls: [] as string[][] }));
const REACHED_EXPANSION = 'reached-macro-expansion';

vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(() =>
      synthResult.error
        ? Promise.reject(synthResult.error)
        : Promise.resolve({ manifest: {}, assemblyDir: '/tmp/cdk.out', stacks: synthResult.stacks })
    ),
    expandMacrosForStacks: vi.fn().mockImplementation((stacks: Array<{ stackName: string }>) => {
      expandMacros.calls.push(stacks.map((s) => s.stackName));
      return Promise.reject(new Error(REACHED_EXPANSION));
    }),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
}));
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {} })),
  setAwsClients: vi.fn(),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));

import { scrubCommand, type ScrubOptions } from '../../../../src/cli/commands/scrub.js';
import { stageLoadError } from '../../../../src/synthesis/failed-stages.js';

function options(overrides: Partial<ScrubOptions> = {}): ScrubOptions {
  return { output: 'cdk.out', statePrefix: 'cdkd', verbose: false, all: false, ...overrides };
}

function stack(stackName: string, displayName?: string): (typeof synthResult.stacks)[number] {
  return { stackName, ...(displayName && { displayName }), template: { Resources: {} } };
}

async function scrubError(stacks: string[], overrides: Partial<ScrubOptions> = {}): Promise<string> {
  const err = await scrubCommand(stacks, options(overrides)).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err, 'scrub must not succeed at selection').toBeInstanceOf(Error);
  return (err as Error).message;
}

describe('cdkd scrub: a Stage that failed to load fails synthesis (go-to-k/cdkd#3507)', () => {
  beforeEach(() => {
    synthResult.stacks = [stack('Other')];
    synthResult.error = undefined;
    expandMacros.calls = [];
  });

  it('fails every selection with the synthesis error, before any state read', async () => {
    // `--all`, none, a wildcard and an exact name all scrubbed the stacks that
    // loaded and could report them clean while the Stage's were never read.
    for (const [stacks, overrides] of [
      [[], { all: true }],
      [[], {}],
      [['*'], {}],
      [['Other'], {}],
      [[], { stack: 'Oth*' }],
    ] as Array<[string[], Partial<ScrubOptions>]>) {
      synthResult.error = stageLoadError(
        'MyStage',
        'ENOENT reading assembly-MyStage/manifest.json'
      );

      const err = await scrubCommand(stacks, options({ dryRun: true, fail: true, ...overrides })).then(
        () => undefined,
        (e: unknown) => e
      );

      // A REFUSAL (exit 2, "declined to look"), never exit 1, which `--fail`
      // reserves for "plaintext found -- rotate the secret".
      expect(err, JSON.stringify([stacks, overrides])).toMatchObject({
        code: 'SCRUB_STAGE_LOAD_FAILED',
        exitCode: 2,
      });
      expect((err as Error).message).toMatch(
        /^Stage MyStage failed to load: ENOENT reading assembly-MyStage\/manifest.json\. /
      );
    }
    expect(expandMacros.calls).toEqual([]);
  });

  it('names the pattern and the available stacks when nothing matched', async () => {
    synthResult.stacks = [stack('Other'), stack('MyStage-Api', 'MyStage/Api')];

    expect(await scrubError(['Nope'])).toBe(
      'No stacks matching Nope found in assembly. Available: Other, MyStage-Api (MyStage/Api)'
    );
    expect(await scrubError([], { stack: 'MyStage/MyStack' })).toBe(
      'No stacks matching MyStage/MyStack found in assembly. ' +
        'Available: Other, MyStage-Api (MyStage/Api)'
    );
  });

  it('refuses a zero-stack app before the branch chain, for no pattern and for --all alike', async () => {
    synthResult.stacks = [];

    expect(await scrubError([])).toBe('No stacks found in assembly');
    expect(await scrubError([], { all: true })).toBe('No stacks found in assembly');
    expect(await scrubError(['MyStage/MyStack'])).toBe(
      'No stacks matching MyStage/MyStack found in assembly. The assembly has no stacks'
    );
    expect(expandMacros.calls).toEqual([]);
  });

  it('control: --all, a wildcard, an exact name and the auto-pick proceed past selection', async () => {
    synthResult.stacks = [stack('Other'), stack('MyStage-Api', 'MyStage/Api')];
    expect(await scrubError([], { all: true })).toBe(REACHED_EXPANSION);
    expect(await scrubError(['MyStage/*'])).toBe(REACHED_EXPANSION);
    expect(await scrubError(['Other'])).toBe(REACHED_EXPANSION);

    synthResult.stacks = [stack('Other')];
    expect(await scrubError([])).toBe(REACHED_EXPANSION);

    expect(expandMacros.calls).toEqual([
      ['Other', 'MyStage-Api'],
      ['MyStage-Api'],
      ['Other'],
      ['Other'],
    ]);
  });
});

// go-to-k/cdkd#4474: scrub's `--all` keeps every stack, Stage stacks included.
// It is a secret-hygiene gate with no AWS CDK CLI counterpart, so narrowing it
// to top-level stacks would let `--all --dry-run --fail` report clean over
// state it never read. Patterns follow the CDK-compatible matcher.
describe('cdkd scrub --all keeps every stack (go-to-k/cdkd#4474)', () => {
  beforeEach(() => {
    synthResult.stacks = [];
    synthResult.error = undefined;
    expandMacros.calls = [];
    infoSpy.mockClear();
  });

  const prod = { ...stack('Prod-Api', 'Prod/Api'), stagePath: 'Prod' };

  it('scrubs Stage stacks under --all, with no top-level hint', async () => {
    synthResult.stacks = [stack('Other'), prod];

    expect(await scrubError([], { all: true })).toBe(REACHED_EXPANSION);
    expect(expandMacros.calls).toEqual([['Other', 'Prod-Api']]);
    expect(infoSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      '--all selects top-level stacks only'
    );
  });

  it("selects only the top-level stacks with `'*'` and every stack with `'**'`", async () => {
    synthResult.stacks = [stack('Other'), prod];

    expect(await scrubError(['*'])).toBe(REACHED_EXPANSION);
    expect(await scrubError(['**'])).toBe(REACHED_EXPANSION);
    expect(expandMacros.calls).toEqual([['Other'], ['Other', 'Prod-Api']]);
  });
});
