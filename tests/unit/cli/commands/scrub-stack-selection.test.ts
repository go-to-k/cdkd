/**
 * `cdkd scrub`'s stack SELECTION reports a CDK Stage that failed to load
 * (issue [#3507](https://github.com/go-to-k/cdkd/issues/3507)), through the
 * same `renderNoStackMatch` that `deploy` / `diff` / `list` / `publish-assets`
 * use.
 *
 * A Stage whose manifest could not be read drops every stack under it from the
 * synthesized app, so a pattern naming one of those stacks came back empty and
 * scrub answered `No stacks matched.` -- naming neither the pattern, the
 * available stacks, nor the Stage. An app whose ONLY stacks sit under such a
 * Stage synthesizes zero stacks, which the auto-pick chain answered with
 * `Multiple stacks found: .` (no pattern) or `No stacks matched.` (`--all`).
 *
 * Every case here stops at selection, before any state read: the synthesizer's
 * `expandMacrosForStacks` -- the first step AFTER selection -- raises a
 * sentinel, so reaching it is the positive control and never reaching it is
 * what "selection refused" means.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

const synthResult = vi.hoisted(() => ({
  stacks: [] as Array<{ stackName: string; displayName?: string; template: object }>,
  failedStages: [] as Array<{ stagePath: string; reason: string }>,
}));
const expandMacros = vi.hoisted(() => ({ calls: [] as string[][] }));
const REACHED_EXPANSION = 'reached-macro-expansion';

vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(() =>
      Promise.resolve({
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
        stacks: synthResult.stacks,
        failedStages: synthResult.failedStages,
      })
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

const FAILED = [{ stagePath: 'MyStage', reason: 'ENOENT reading assembly-MyStage' }];
const NOTE =
  'Stage MyStage failed to load, so stacks under it are missing from this list ' +
  'rather than missing from the app: ENOENT reading assembly-MyStage';

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

describe('cdkd scrub: empty selection names a Stage that failed to load (go-to-k/cdkd#3507)', () => {
  beforeEach(() => {
    synthResult.stacks = [];
    synthResult.failedStages = [];
    expandMacros.calls = [];
  });

  it('names the Stage a display-path pattern targets, with the pattern and the available stacks', async () => {
    synthResult.stacks = [stack('Other')];
    synthResult.failedStages = FAILED;

    const message = await scrubError(['MyStage/MyStack']);

    expect(message).toBe(
      `No stacks matching MyStage/MyStack found in assembly. Available: Other. ${NOTE}`
    );
    expect(expandMacros.calls).toEqual([]);
  });

  it('names the Stage for a --stack pattern too', async () => {
    synthResult.stacks = [stack('Other')];
    synthResult.failedStages = FAILED;

    const message = await scrubError([], { stack: 'MyStage/*' });

    expect(message).toBe(`No stacks matching MyStage/* found in assembly. Available: Other. ${NOTE}`);
  });

  it('hedges the Stage when the pattern is a physical name, which carries no Stage path', async () => {
    synthResult.stacks = [stack('Other')];
    synthResult.failedStages = FAILED;

    const message = await scrubError(['MyStage-MyStack']);

    expect(message).toBe(
      `No stacks matching MyStage-MyStack found in assembly. Available: Other. ` +
        `Possibly unrelated: ${NOTE}`
    );
  });

  it('names the pattern and the available stacks when no Stage failed', async () => {
    synthResult.stacks = [stack('Other'), stack('MyStage-Api', 'MyStage/Api')];

    const message = await scrubError(['Nope']);

    expect(message).toBe(
      'No stacks matching Nope found in assembly. Available: Other, MyStage-Api (MyStage/Api)'
    );
  });

  it('refuses a zero-stack app with the Stage named, for no pattern and for --all alike', async () => {
    // The auto-pick chain answered these `Multiple stacks found: .` and
    // `No stacks matched.` respectively.
    synthResult.failedStages = FAILED;

    expect(await scrubError([])).toBe(`No stacks found in assembly. ${NOTE}`);
    expect(await scrubError([], { all: true })).toBe(`No stacks found in assembly. ${NOTE}`);
    expect(await scrubError(['MyStage/MyStack'])).toBe(
      `No stacks matching MyStage/MyStack found in assembly. The assembly has no stacks. ${NOTE}`
    );
    expect(expandMacros.calls).toEqual([]);
  });

  it('refuses --all over a zero-stack app as a refusal (exit 2) when a Stage failed, and a bare run too', async () => {
    // Every stack sat under the failed Stage, so `--all` or a bare run would
    // examine none of them: exit 2 ("declined to look"), not 1, which `--fail`
    // reserves for "plaintext found". A pattern stays a plain selection error.
    synthResult.failedStages = FAILED;

    const caught = (stacks: string[], overrides: Partial<ScrubOptions>) =>
      scrubCommand(stacks, options(overrides)).then(
        () => undefined,
        (e: unknown) => e
      );

    expect(await caught([], { all: true })).toMatchObject({
      code: 'SCRUB_ALL_PARTIAL_APP',
      exitCode: 2,
      message: `No stacks found in assembly. ${NOTE}`,
    });
    expect(await caught([], { dryRun: true, fail: true })).toMatchObject({
      code: 'SCRUB_AUTO_PICK_PARTIAL_APP',
      exitCode: 2,
      message: `No stacks found in assembly. ${NOTE}`,
    });
    expect(await caught(['MyStage/MyStack'], {})).not.toHaveProperty('exitCode');
  });

  it('refuses a zero-stack app without a Stage note when no Stage failed', async () => {
    expect(await scrubError([])).toBe('No stacks found in assembly');
    expect(await scrubError([], { all: true })).toBe('No stacks found in assembly');
    // Nothing failed to load, so nothing went unexamined: not the refusal.
    const err = await scrubCommand([], options({ all: true })).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).not.toHaveProperty('exitCode');
  });

  it('control: a pattern that matches proceeds past selection, even beside a failed Stage', async () => {
    synthResult.stacks = [stack('Other'), stack('MyStage-Api', 'MyStage/Api')];
    synthResult.failedStages = FAILED;

    expect(await scrubError(['MyStage/Api'])).toBe(REACHED_EXPANSION);
    expect(expandMacros.calls).toEqual([['MyStage-Api']]);
  });
});

describe('cdkd scrub --all refuses a partial app when a Stage failed to load (go-to-k/cdkd#3507)', () => {
  beforeEach(() => {
    synthResult.stacks = [];
    synthResult.failedStages = [];
    expandMacros.calls = [];
  });

  it('refuses --all with surviving stacks, naming the survivors and the Stage', async () => {
    // Before the refusal, --all scrubbed `Other` and `MyStage-Api` and reported
    // the state clean, while the failed Stage's stacks were never examined.
    synthResult.stacks = [stack('Other'), stack('MyStage-Api', 'MyStage/Api')];
    synthResult.failedStages = FAILED;

    const err = await scrubCommand([], options({ all: true })).then(
      () => undefined,
      (e: unknown) => e
    );
    // Exit 2, scrub's "declined to look": exit 1 is `--fail`'s "plaintext
    // found", and a CI gate reading the code alone must not take this for a leak.
    expect(err).toMatchObject({ code: 'SCRUB_ALL_PARTIAL_APP', exitCode: 2 });
    const message = (err as Error).message;

    expect(message).toBe(
      '--all would scrub only part of this app; refusing. ' +
        `Synthesized: Other, MyStage-Api (MyStage/Api). ${NOTE}. ` +
        'Fix each Stage that failed to load so it synthesizes, or name the stacks to scrub explicitly.'
    );
    expect(expandMacros.calls).toEqual([]);
  });

  it('refuses --all even when positional patterns are also given', async () => {
    // `--all` wins over patterns in the branch chain, so it must be refused
    // there rather than falling through to the pattern arm.
    synthResult.stacks = [stack('Other')];
    synthResult.failedStages = FAILED;

    const err = await scrubCommand(['Other'], options({ all: true })).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toMatchObject({ code: 'SCRUB_ALL_PARTIAL_APP', exitCode: 2 });
    expect((err as Error).message).toContain('--all would scrub only part of this app; refusing.');
    expect(expandMacros.calls).toEqual([]);
  });

  // A bare `cdkd scrub --dry-run --fail` auto-selected the one survivor and
  // reported it clean, as if the app held only that stack.
  it('refuses the single-stack auto-pick when a Stage failed to load, as a refusal (exit 2)', async () => {
    synthResult.stacks = [stack('Other')];
    synthResult.failedStages = FAILED;

    const err = await scrubCommand([], options({ dryRun: true, fail: true })).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toMatchObject({ code: 'SCRUB_AUTO_PICK_PARTIAL_APP', exitCode: 2 });
    expect((err as Error).message).toBe(
      'With no stack named, cdkd would scrub only part of this app; refusing. ' +
        `Synthesized: Other. ${NOTE}. ` +
        'Fix each Stage that failed to load so it synthesizes, or name the stacks to scrub explicitly.'
    );
    expect(expandMacros.calls).toEqual([]);
  });

  it('still scrubs a NAMED survivor beside a failed Stage', async () => {
    synthResult.stacks = [stack('Other')];
    synthResult.failedStages = FAILED;

    expect(await scrubError(['Other'])).toBe(REACHED_EXPANSION);
    expect(expandMacros.calls).toEqual([['Other']]);
  });

  it('still auto-picks the single stack when every Stage loaded', async () => {
    synthResult.stacks = [stack('Other')];

    expect(await scrubError([])).toBe(REACHED_EXPANSION);
    expect(expandMacros.calls).toEqual([['Other']]);
  });

  it('still selects every stack with --all when every Stage loaded', async () => {
    synthResult.stacks = [stack('Other'), stack('MyStage-Api', 'MyStage/Api')];

    expect(await scrubError([], { all: true })).toBe(REACHED_EXPANSION);
    expect(expandMacros.calls).toEqual([['Other', 'MyStage-Api']]);
  });
});
