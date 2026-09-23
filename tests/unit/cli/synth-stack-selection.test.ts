import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * `cdkd synth [stacks...]` (issue
 * [#3550](https://github.com/go-to-k/cdkd/issues/3550)).
 *
 * The defect was not that the argument was rejected — it was that the stdout
 * gate read the size of the WHOLE ASSEMBLY (`stacks.length === 1` over the
 * unfiltered synthesis result), so on a multi-stack app there was no way to
 * put one template on stdout AT ALL, and the selector that would have
 * narrowed it was refused as an excess argument. Both halves are fenced here;
 * the gate is the one that matters, since accepting the argument while still
 * gating on the assembly would look like a fix and change nothing.
 *
 * THE SELECTION MUST NOT NARROW SYNTHESIS. Measured in `aws-cdk@2.1142.0`:
 * `Toolkit.synth` runs `synthAndMeasure(...)` and only then
 * `assembly.selectStacks(...)`, and the context-resolution loop in
 * `cxapp/cloud-executable.ts` takes no selector — it reads
 * `assembly.manifest.missing` for the whole assembly. So a stack argument does
 * NOT narrow which `cdk.context.json` lookups run. A case asserts the
 * synthesizer is still called exactly once with no stack filter, because
 * "select by synthesizing less" is the plausible wrong implementation and it
 * would diverge from `cdk` in a way nothing else here would report.
 */

const mockSynthesize = vi.fn();
vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/synthesis/synthesizer.js')>();
  return {
    ...actual,
    Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  };
});

const mockResolveApp = vi.fn();
// `importOriginal` spread, not a full replacement: a factory that enumerates
// exports becomes a `TypeError` inside the command the day `synth.ts` imports
// one more of them, and it surfaces as empty stdout rather than as a missing
// symbol.
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/config-loader.js')>();
  return { ...actual, resolveApp: (cliApp?: string) => mockResolveApp(cliApp) };
});

import { createSynthCommand } from '../../../src/cli/commands/synth.js';
import { releaseStdoutForPayload } from '../../../src/utils/logger.js';

const templateFor = (name: string) =>
  ({ Resources: { [`R${name}`]: { Type: 'AWS::S3::Bucket' } } }) as const;

function makeStack(stackName: string, displayName?: string): StackInfo {
  return {
    artifactId: stackName,
    stackName,
    displayName: displayName ?? stackName,
    template: templateFor(stackName),
    dependencyNames: [],
    region: 'eu-west-3',
    account: '111111111111',
  } as unknown as StackInfo;
}

interface Streams {
  stdout: string;
  stderr: string;
  error: unknown;
}

async function runSynth(args: string[]): Promise<Streams> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  const toFd1 = (line: unknown): void => void out.push(`${String(line)}\n`);
  const toFd2 = (line: unknown): void => void err.push(`${String(line)}\n`);
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(toFd1),
    vi.spyOn(console, 'info').mockImplementation(toFd1),
    vi.spyOn(console, 'debug').mockImplementation(toFd1),
    vi.spyOn(console, 'warn').mockImplementation(toFd2),
    vi.spyOn(console, 'error').mockImplementation(toFd2),
  ];

  let error: unknown;
  try {
    const cmd = createSynthCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    for (const spy of spies) spy.mockRestore();
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

const THREE = ['NetworkStack', 'DataStack', 'AppStack'];
const HINT = 'Supply a stack id';

beforeEach(() => {
  mockResolveApp.mockReturnValue('node app.js');
  mockSynthesize.mockResolvedValue({
    stacks: THREE.map((n) => makeStack(n)),
    assemblyDir: '/tmp/cdk.out',
  });
});

afterEach(() => {
  releaseStdoutForPayload();
  vi.clearAllMocks();
});

describe('synth stack selection (issue #3550)', () => {
  it('puts ONE selected stack template on stdout of a MULTI-stack app', async () => {
    // The whole defect. Before go-to-k/cdkd#3550 this was unreachable: the
    // argument was an excess-operand error, and dropping it printed nothing
    // because the gate read the assembly's size.
    const { stdout, error } = await runSynth(['DataStack']);
    expect(error).toBeUndefined();
    expect(stdout).toContain('RDataStack');
    expect(stdout).not.toContain('RAppStack');
    expect(stdout).not.toContain(HINT);
  });

  it('prints NO template and names the SELECTED ids when the selection is not one', async () => {
    // A PROPER SUBSET, and the assertion reads the HINT LINE alone. The first
    // revision selected `'*Stack'` -- all three -- so selection === assembly
    // and the case could not tell "lists the selection" from "lists the
    // assembly", which is exactly the bug it is named for. It also asserted
    // over `stdout + stderr`, which the summary bullets satisfy on their own.
    const { stdout, stderr } = await runSynth(['Data*', 'App*']);
    expect(stdout).not.toContain('Resources:');
    const hintLine = (stdout + stderr).split('\n').find((l) => l.includes(HINT));
    expect(hintLine, 'no hint line emitted').toBeDefined();
    expect(hintLine!).toContain('DataStack');
    expect(hintLine!).toContain('AppStack');
    expect(hintLine!).not.toContain('NetworkStack');
  });

  it('checks annotations for the SELECTED stacks only', async () => {
    // A narrowing nothing else in this file sees, and it is a real behaviour
    // change: an error annotation used to fail the run wherever it sat.
    // Selecting first is `cdk` parity -- `throwIfValidationFailures` runs over
    // the selection -- but it must be fenced rather than inferred.
    const withError = makeStack('BadStack');
    // `{ level, path, message }` -- the shape `processStackMessages` reads.
    // The first revision invented a cx-api-looking `{ level, entry, id }`,
    // which produced `[Error at undefined] undefined` and a red that named the
    // fixture rather than the behaviour.
    (withError as unknown as { messages: unknown[] }).messages = [
      { level: 'error', path: '/BadStack/Thing', message: 'boom' },
    ];
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('GoodStack'), withError],
      assemblyDir: '/tmp/cdk.out',
    });

    const selected = await runSynth(['GoodStack']);
    expect(selected.stdout).toContain('RGoodStack');
    expect(selected.stderr).not.toContain('boom');

    // ...and the same assembly with no selection still fails on it.
    const unselected = await runSynth([]);
    expect(unselected.stderr + unselected.stdout).toContain('boom');
  });

  it('refuses a ZERO-stack assembly rather than reporting success', async () => {
    // Previously `Found 0 stack(s)` at exit 0. `list` and `diff` both refuse;
    // an app whose only stacks live in an unsynthesized Stage produces this.
    mockSynthesize.mockResolvedValue({ stacks: [], assemblyDir: '/tmp/cdk.out' });
    const { stdout, stderr } = await runSynth([]);
    expect(stdout).not.toContain('Resources:');
    expect(stderr).not.toBe('');
  });

  it('keeps the bare-command behaviour: no template, hint listing everything', async () => {
    const { stdout, stderr } = await runSynth([]);
    expect(stdout).not.toContain('Resources:');
    expect(stdout + stderr).toContain(HINT);
  });

  it('still prints the template for a single-stack app with no argument', async () => {
    // The pre-existing contract, which the gate change must not break.
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('OnlyStack')],
      assemblyDir: '/tmp/cdk.out',
    });
    const { stdout } = await runSynth([]);
    expect(stdout).toContain('ROnlyStack');
    expect(stdout).not.toContain(HINT);
  });

  it('reaches renderNoStackMatch with THIS synthesis result, not an empty one', async () => {
    // go-to-k/cdkd#3482's shape: a Stage that failed to load drops every stack
    // under it, and selection then answers "no stacks matching" -- a different
    // problem than the one that occurred. The argument being required fences
    // only the SHAPE; `{ failedStages: [] }` typechecks just as well. `diff`
    // has this case for the same reason (`diff-failed-stage-selection.test.ts`).
    mockSynthesize.mockResolvedValue({
      stacks: [],
      assemblyDir: '/tmp/cdk.out',
      // `{ stagePath, reason }` -- read off `src/synthesis/failed-stages.ts`.
      // Inventing plausible member names is how the annotation fixture above
      // failed too; both times the red named the fixture, not the behaviour.
      failedStages: [{ stagePath: 'MyStage', reason: 'stage blew up' }],
    });
    const { stderr } = await runSynth(['MyStage/Api']);
    // The REASON, not the stage path. Asserting on `'MyStage'` passed with
    // `{ failedStages: [] }` substituted at the call site -- `renderNoStackMatch`
    // echoes the user's own pattern back, so the assertion was satisfied by
    // the input rather than by the threading. Probed.
    expect(stderr).toContain('stage blew up');
  });

  it('refuses a pattern matching nothing, naming what IS available', async () => {
    // Asserted on STDERR, not on a thrown value: `withErrorHandling` routes
    // every command failure through `handleError` and does NOT re-throw, so a
    // case awaiting the rejection reads `undefined` and passes only because
    // `String(undefined)` is a string. That is how the first revision of this
    // case failed -- correctly.
    const { stdout, stderr } = await runSynth(['NoSuchStack']);
    expect(stderr).toContain('NoSuchStack');
    for (const n of THREE) expect(stderr).toContain(n);
    // And nothing reached the payload stream on the refusing path.
    expect(stdout).not.toContain('Resources:');
  });

  it('selects by CDK display path, not only by physical name', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('MyStage-Api', 'MyStage/Api'), makeStack('Other')],
      assemblyDir: '/tmp/cdk.out',
    });
    const { stdout, stderr } = await runSynth(['MyStage/Api']);
    expect(stderr).not.toContain('No stacks matching');
    expect(stdout).toContain('RMyStage-Api');
    // The negative matters: a matcher that fell through to "everything" would
    // satisfy the positive alone, and the selection would be two.
    expect(stdout).not.toContain('ROther');
  });

  it('SYNTHESIZES THE WHOLE APP regardless of the selection', async () => {
    // `cdk` selects after synthesis and resolves context for the whole
    // assembly. "Select by synthesizing less" is the plausible wrong
    // implementation: it would look identical in every case above and would
    // silently change which context lookups run.
    await runSynth(['DataStack']);
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    const passed = mockSynthesize.mock.calls[0]![0] as Record<string, unknown>;
    for (const key of Object.keys(passed)) {
      expect(key, `synthesis options carry a stack filter: ${key}`).not.toMatch(/stack/i);
    }
  });
});
