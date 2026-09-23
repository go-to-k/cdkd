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
    // Both halves were wrong in the first draft: the hint was gated on "no
    // pattern given", so a wildcard matching three printed neither a template
    // nor a way to get one; and it listed the whole assembly rather than the
    // selection, which is the wrong set to narrow from.
    const { stdout, stderr } = await runSynth(['*Stack']);
    const all = stdout + stderr;
    expect(stdout).not.toContain('Resources:');
    expect(all).toContain(HINT);
    for (const n of THREE) expect(all).toContain(n);
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
    const { stdout } = await runSynth(['MyStage/Api']);
    expect(stdout).toContain('RMyStage-Api');
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
